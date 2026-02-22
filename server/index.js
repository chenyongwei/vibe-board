const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const { createStore } = require('./storage');

const app = express();
const PORT = process.env.PORT || 6101;
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || '6mb';
const store = createStore();

const HISTORY_LIMIT = Number(process.env.HISTORY_LIMIT || 5000);
const PREVIEW_IMAGE_LIMIT = Number(process.env.PREVIEW_IMAGE_LIMIT || 3);
const PREVIEW_IMAGE_MAX_LENGTH = Number(process.env.PREVIEW_IMAGE_MAX_LENGTH || (2 * 1024 * 1024));
const DASHBOARD_STREAM_HEARTBEAT_MS = Number(process.env.DASHBOARD_STREAM_HEARTBEAT_MS || 25000);
const AGENT_OFFLINE_TIMEOUT_SECONDS = Number(process.env.AGENT_OFFLINE_TIMEOUT_SECONDS || 45);
const AGENT_OFFLINE_TIMEOUT_MS =
  (Number.isFinite(AGENT_OFFLINE_TIMEOUT_SECONDS) && AGENT_OFFLINE_TIMEOUT_SECONDS > 0
    ? AGENT_OFFLINE_TIMEOUT_SECONDS
    : 45) * 1000;
const dashboardStreamClients = new Set();
let dashboardStreamEventId = 0;

async function loadDB() {
  const data = await store.loadDB();
  return ensureDBShape(data);
}

async function saveDB(db) {
  await store.saveDB(ensureDBShape(db));
}

function ensureDBShape(db) {
  const safe = db || {};
  const machines = dedupeMachines(Array.isArray(safe.machines) ? safe.machines : []);
  const tasks = dedupeStoredTasks(Array.isArray(safe.tasks) ? safe.tasks : []);
  const history = Array.isArray(safe.history) ? safe.history : [];
  return { machines, tasks, history };
}

function taskKey(machineId, taskId) {
  return `${machineId}::${taskId}`;
}

function normalizeMachineFingerprint(value, fallbackMachineId) {
  const raw = String(value || '').trim();
  if (raw) return raw;
  return String(fallbackMachineId || '').trim();
}

function normalizeDisplayName(value) {
  const raw = String(value || '').trim();
  return raw || '';
}

function normalizeAgentName(value, fallbackMachineId) {
  const raw = String(value || '').trim();
  if (raw) return raw;
  const fallback = String(fallbackMachineId || '').trim();
  return fallback || 'Unknown';
}

function machineIdentityKey(fingerprint, agentName) {
  return `${fingerprint}::${agentName}`;
}

function composeMachineTitle(displayName, agentName) {
  const custom = normalizeDisplayName(displayName);
  const agent = normalizeAgentName(agentName);
  if (!custom) return agent;
  if (!agent || custom === agent) return custom;

  const separators = [' · ', ' / ', ' - '];
  for (const sep of separators) {
    const prefix = `${custom}${sep}`;
    if (!agent.startsWith(prefix)) continue;
    const suffix = agent.slice(prefix.length).trim();
    if (suffix) return `${custom} (${suffix})`;
  }
  return `${custom} (${agent})`;
}

function dedupeMachines(machines) {
  const keyed = new Map();
  for (const machine of machines) {
    if (!machine || !machine.id) continue;
    const fingerprint = normalizeMachineFingerprint(machine.fingerprint, machine.id);
    const agentName = normalizeAgentName(machine.name, machine.id);
    const key = machineIdentityKey(fingerprint, agentName);
    const existing = keyed.get(key);
    const aliases = dedupeAliases([...(existing?.aliases || []), ...(machine.aliases || []), machine.id]);
    const mergedDisplayName = normalizeDisplayName(existing?.display_name) || normalizeDisplayName(machine.display_name);
    const mergedOnlineSince =
      normalizeTimestamp(existing?.online_since) ||
      normalizeTimestamp(machine.online_since) ||
      normalizeTimestamp(existing?.last_seen) ||
      normalizeTimestamp(machine.last_seen) ||
      new Date().toISOString();
    if (!existing) {
      keyed.set(key, {
        id: machine.id,
        name: agentName,
        last_seen: machine.last_seen || new Date().toISOString(),
        online_since: normalizeTimestamp(machine.online_since) || normalizeTimestamp(machine.last_seen) || new Date().toISOString(),
        fingerprint,
        aliases,
        display_name: normalizeDisplayName(machine.display_name) || undefined,
      });
      continue;
    }
    const existingSeen = Date.parse(existing.last_seen || '');
    const currentSeen = Date.parse(machine.last_seen || '');
    const useCurrent = Number.isNaN(existingSeen) || (!Number.isNaN(currentSeen) && currentSeen > existingSeen);
    if (useCurrent) {
      keyed.set(key, {
        id: existing.id,
        name: agentName || existing.name || machine.id,
        last_seen: machine.last_seen || existing.last_seen,
        online_since: mergedOnlineSince,
        fingerprint,
        aliases,
        display_name: mergedDisplayName || undefined,
      });
    } else {
      existing.aliases = aliases;
      existing.display_name = mergedDisplayName || undefined;
      existing.online_since = mergedOnlineSince;
      keyed.set(key, existing);
    }
  }
  return Array.from(keyed.values());
}

function dedupeAliases(aliases) {
  const out = [];
  const seen = new Set();
  for (const alias of aliases || []) {
    const value = String(alias || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function pickMachineRecordId(db, machineId, machineFingerprint, machineName) {
  const baseId = String(machineId || '').trim();
  if (!baseId) return '';
  const conflict = (db.machines || []).find((item) => item && item.id === baseId);
  if (!conflict) return baseId;

  const conflictFingerprint = normalizeMachineFingerprint(conflict.fingerprint, conflict.id);
  const conflictAgentName = normalizeAgentName(conflict.name, conflict.id);
  const sameIdentity =
    conflictFingerprint === normalizeMachineFingerprint(machineFingerprint, machineId) &&
    conflictAgentName === normalizeAgentName(machineName, machineId);
  if (sameIdentity) return baseId;

  const agentToken = normalizeAgentName(machineName, machineId).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32) || 'agent';
  let counter = 1;
  while (counter < 1000) {
    const candidate = `${baseId}::${agentToken}-${counter}`;
    const exists = (db.machines || []).some((item) => item && item.id === candidate);
    if (!exists) return candidate;
    counter += 1;
  }
  return `${baseId}::${Date.now()}`;
}

function normalizeTaskStatus(status) {
  const value = String(status || '').trim();
  const map = {
    running: 'in_progress',
    active: 'in_progress',
    done: 'verified',
    completed: 'verified',
    completed_pending_verification: 'awaiting_verification',
    awaiting_verification: 'awaiting_verification',
  };
  return map[value] || value || 'in_progress';
}

function normalizeTaskSource(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const compact = raw.toLowerCase().replace(/[\s_-]+/g, '');
  if (compact === 'codex' || compact === 'codexadapter' || compact === 'codexlocal') return 'Codex';
  if (compact === 'claudecode' || compact === 'claude') return 'Claude Code';
  if (compact === 'opencode') return 'OpenCode';
  return raw;
}

function normalizeSourceToken(value) {
  const source = normalizeTaskSource(value);
  if (!source) return '';
  return source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function composeMachineAgentName(machineName, source) {
  const base = normalizeAgentName(machineName);
  const normalizedSource = normalizeTaskSource(source);
  if (!normalizedSource) return base;
  if (base.toLowerCase() === normalizedSource.toLowerCase()) return base;
  return `${base} · ${normalizedSource}`;
}

function splitTasksBySource(tasks) {
  const groups = new Map();
  for (const task of tasks || []) {
    if (!task || !task.id) continue;
    const source = normalizeTaskSource(task.source || task?.metadata?.source);
    const key = source ? source.toLowerCase() : '__default__';
    if (!groups.has(key)) {
      groups.set(key, { source, tasks: [] });
    }
    const normalizedTask = { ...task };
    if (source) {
      normalizedTask.source = source;
    } else {
      delete normalizedTask.source;
    }
    groups.get(key).tasks.push(normalizedTask);
  }
  return Array.from(groups.values());
}

function normalizeTimestamp(value) {
  if (!value) return '';
  const ms = Date.parse(String(value));
  if (Number.isNaN(ms)) return '';
  return new Date(ms).toISOString();
}

function isMachineOnline(machine, nowMs = Date.now()) {
  const lastSeenMs = Date.parse(machine?.last_seen || '');
  if (Number.isNaN(lastSeenMs)) return false;
  return nowMs - lastSeenMs <= AGENT_OFFLINE_TIMEOUT_MS;
}

function resolveMachinePresence(machine, nowMs = Date.now()) {
  const fallbackNow = Number.isFinite(nowMs) ? nowMs : Date.now();
  const lastSeenMs = Date.parse(machine?.last_seen || '');
  const online = !Number.isNaN(lastSeenMs) && fallbackNow - lastSeenMs <= AGENT_OFFLINE_TIMEOUT_MS;
  const normalizedOnlineSince = normalizeTimestamp(machine?.online_since) || '';

  if (online) {
    const onlineSinceMs = Date.parse(normalizedOnlineSince);
    const statusSinceMs = Number.isNaN(onlineSinceMs)
      ? (Number.isNaN(lastSeenMs) ? fallbackNow : lastSeenMs)
      : onlineSinceMs;
    const statusSinceIso = new Date(statusSinceMs).toISOString();
    return {
      agent_status: 'online',
      status_since: statusSinceIso,
      online_since: statusSinceIso,
      offline_since: null,
    };
  }

  const rawOfflineSinceMs = Number.isNaN(lastSeenMs) ? fallbackNow : lastSeenMs + AGENT_OFFLINE_TIMEOUT_MS;
  const offlineSinceMs = Math.min(Math.max(rawOfflineSinceMs, 0), fallbackNow);
  const offlineSinceIso = new Date(offlineSinceMs).toISOString();
  return {
    agent_status: 'offline',
    status_since: offlineSinceIso,
    online_since: normalizedOnlineSince || null,
    offline_since: offlineSinceIso,
  };
}

function compareDashboardMachines(a, b) {
  const statusRank = (item) => (item.agent_status === 'online' ? 0 : 1);
  const aRank = statusRank(a);
  const bRank = statusRank(b);
  if (aRank !== bRank) return aRank - bRank;

  const aSinceMs = Date.parse(a.status_since || '');
  const bSinceMs = Date.parse(b.status_since || '');
  if (!Number.isNaN(aSinceMs) && !Number.isNaN(bSinceMs) && aSinceMs !== bSinceMs) {
    return bSinceMs - aSinceMs;
  }

  const aSeenMs = Date.parse(a.last_seen || '');
  const bSeenMs = Date.parse(b.last_seen || '');
  if (!Number.isNaN(aSeenMs) && !Number.isNaN(bSeenMs) && aSeenMs !== bSeenMs) {
    return bSeenMs - aSeenMs;
  }

  return String(a.display_title || '').localeCompare(String(b.display_title || ''), 'zh-CN');
}

function isSupportedImageUrl(value) {
  if (!value) return false;
  if (/^data:image\/[a-zA-Z0-9.+-]+;base64,/i.test(value)) return true;
  if (/^https?:\/\//i.test(value)) return true;
  return false;
}

function normalizePreviewImages(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const item of input) {
    const value = String(item || '').trim();
    if (!value) continue;
    if (!isSupportedImageUrl(value)) continue;
    if (value.length > PREVIEW_IMAGE_MAX_LENGTH) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= PREVIEW_IMAGE_LIMIT) break;
  }
  return out;
}

function resolveCreatedAt(existing, incomingCreatedAt, incomingUpdatedAt, now) {
  const existingCreated = normalizeTimestamp(existing?.created_at);
  const existingUpdated = normalizeTimestamp(existing?.updated_at);

  if (existingCreated) {
    // Repair legacy rows where created_at was previously overwritten to equal updated_at.
    if (incomingCreatedAt && existingUpdated && existingCreated === existingUpdated && incomingCreatedAt !== existingCreated) {
      return incomingCreatedAt;
    }
    return existingCreated;
  }

  return incomingCreatedAt || incomingUpdatedAt || now;
}

function resolveUpdatedAt(existing, incomingUpdatedAt, createdAt, now) {
  const existingUpdated = normalizeTimestamp(existing?.updated_at);
  return incomingUpdatedAt || existingUpdated || createdAt || now;
}

function dedupeStoredTasks(tasks) {
  const keyed = new Map();
  for (const task of tasks) {
    if (!task || !task.id || !task.machine_id) continue;
    const normalized = { ...task };
    const source = normalizeTaskSource(task.source || task?.metadata?.source);
    if (source) normalized.source = source;
    else delete normalized.source;
    const previewImages = normalizePreviewImages(task.preview_images);
    if (previewImages.length > 0) normalized.preview_images = previewImages;
    else delete normalized.preview_images;
    keyed.set(taskKey(task.machine_id, task.id), normalized);
  }
  return Array.from(keyed.values());
}

function dedupeIncomingTasks(tasks) {
  const keyed = new Map();
  for (const task of tasks) {
    if (!task || !task.id) continue;
    const source = normalizeTaskSource(task.source || task?.metadata?.source);
    const key = source ? `${task.id}::${source.toLowerCase()}` : String(task.id);
    const normalizedTask = { ...task };
    if (source) {
      normalizedTask.source = source;
    } else {
      delete normalizedTask.source;
    }
    keyed.set(key, normalizedTask);
  }
  return Array.from(keyed.values());
}

function appendHistory(db, event) {
  db.history.push(event);
  if (db.history.length > HISTORY_LIMIT) {
    db.history.splice(0, db.history.length - HISTORY_LIMIT);
  }
}

function findMachine(db, machineId, machineFingerprint, machineName) {
  const fingerprint = normalizeMachineFingerprint(machineFingerprint, machineId);
  const agentName = normalizeAgentName(machineName, machineId);
  return db.machines.find((m) => {
    if (!m || !m.id) return false;
    const fp = normalizeMachineFingerprint(m.fingerprint, m.id);
    const existingAgentName = normalizeAgentName(m.name, m.id);
    const sameIdentity = fp === fingerprint && existingAgentName === agentName;
    if (sameIdentity) return true;

    const sameAlias = m.id === machineId || (Array.isArray(m.aliases) && m.aliases.includes(machineId));
    if (sameAlias && existingAgentName === agentName) return true;
    return false;
  });
}

function mergeMachineRecords(db, canonicalMachine) {
  const canonicalFingerprint = normalizeMachineFingerprint(canonicalMachine.fingerprint, canonicalMachine.id);
  const canonicalAgentName = normalizeAgentName(canonicalMachine.name, canonicalMachine.id);
  const duplicates = db.machines.filter((m) => {
    if (!m || !m.id) return false;
    if (m.id === canonicalMachine.id) return false;
    return (
      normalizeMachineFingerprint(m.fingerprint, m.id) === canonicalFingerprint &&
      normalizeAgentName(m.name, m.id) === canonicalAgentName
    );
  });
  if (duplicates.length === 0) return;

  const aliasSet = new Set(canonicalMachine.aliases || []);
  aliasSet.add(canonicalMachine.id);

  for (const duplicate of duplicates) {
    aliasSet.add(duplicate.id);
    for (const alias of duplicate.aliases || []) aliasSet.add(alias);
    if (!normalizeDisplayName(canonicalMachine.display_name) && normalizeDisplayName(duplicate.display_name)) {
      canonicalMachine.display_name = normalizeDisplayName(duplicate.display_name);
    }
    if (!normalizeTimestamp(canonicalMachine.online_since) && normalizeTimestamp(duplicate.online_since)) {
      canonicalMachine.online_since = normalizeTimestamp(duplicate.online_since);
    }
    const duplicateSeen = Date.parse(duplicate.last_seen || '');
    const canonicalSeen = Date.parse(canonicalMachine.last_seen || '');
    if (!Number.isNaN(duplicateSeen) && (Number.isNaN(canonicalSeen) || duplicateSeen > canonicalSeen)) {
      canonicalMachine.last_seen = duplicate.last_seen;
      canonicalMachine.name = duplicate.name || canonicalMachine.name;
      if (normalizeTimestamp(duplicate.online_since)) {
        canonicalMachine.online_since = normalizeTimestamp(duplicate.online_since);
      }
    }
    for (const task of db.tasks) {
      if (task.machine_id === duplicate.id) {
        task.machine_id = canonicalMachine.id;
      }
    }
    for (const event of db.history) {
      if (event.machine_id === duplicate.id) {
        event.machine_id = canonicalMachine.id;
      }
    }
  }

  canonicalMachine.aliases = dedupeAliases(Array.from(aliasSet));
  db.machines = db.machines.filter((m) => !duplicates.some((d) => d.id === m.id));
  db.tasks = dedupeStoredTasks(db.tasks || []);
}

function buildCounts(tasks) {
  return tasks.reduce(
    (acc, task) => {
      const status = normalizeTaskStatus(task.status);
      if (status === 'in_progress') acc.in_progress += 1;
      if (status === 'awaiting_verification') acc.awaiting_verification += 1;
      if (status === 'verified') acc.verified += 1;
      return acc;
    },
    { in_progress: 0, awaiting_verification: 0, verified: 0 }
  );
}

function writeDashboardStreamEvent(res, eventName, payload) {
  const eventId = ++dashboardStreamEventId;
  const safePayload = payload && typeof payload === 'object' ? payload : {};
  res.write(`id: ${eventId}\n`);
  if (eventName) {
    res.write(`event: ${eventName}\n`);
  }
  res.write(`data: ${JSON.stringify(safePayload)}\n\n`);
}

function removeDashboardStreamClient(res) {
  dashboardStreamClients.delete(res);
}

function broadcastDashboardUpdate(payload) {
  if (dashboardStreamClients.size === 0) return;
  const clients = Array.from(dashboardStreamClients);
  for (const client of clients) {
    try {
      writeDashboardStreamEvent(client, 'dashboard_updated', payload);
    } catch {
      removeDashboardStreamClient(client);
      try {
        client.end();
      } catch {}
    }
  }
}

function broadcastDashboardHeartbeat() {
  if (dashboardStreamClients.size === 0) return;
  const clients = Array.from(dashboardStreamClients);
  for (const client of clients) {
    try {
      client.write(': ping\n\n');
    } catch {
      removeDashboardStreamClient(client);
      try {
        client.end();
      } catch {}
    }
  }
}

setInterval(broadcastDashboardHeartbeat, DASHBOARD_STREAM_HEARTBEAT_MS).unref();

// Middleware
app.use(bodyParser.json({ limit: JSON_BODY_LIMIT }));
app.use('/api', (req, res, next) => { next(); });

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

app.get('/api/dashboard/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  res.write('retry: 3000\n\n');
  dashboardStreamClients.add(res);
  writeDashboardStreamEvent(res, 'connected', { updated_at: new Date().toISOString() });

  req.on('close', () => {
    removeDashboardStreamClient(res);
  });
  req.on('aborted', () => {
    removeDashboardStreamClient(res);
  });
});

// API: Report task updates from machines
app.post('/api/report', asyncRoute(async (req, res) => {
  const payload = req.body || {};
  const machineId = payload.machine_id;
  const machineName = normalizeAgentName(payload.machine_name, machineId);
  const machineFingerprint = normalizeMachineFingerprint(payload.machine_fingerprint, machineId);
  const tasks = dedupeIncomingTasks(Array.isArray(payload.tasks) ? payload.tasks : []);

  if (!machineId) {
    return res.status(400).json({ ok: false, error: 'machine_id required' });
  }

  const taskGroups = splitTasksBySource(tasks);
  if (taskGroups.length === 0) {
    taskGroups.push({ source: '', tasks: [] });
  }

  const db = await loadDB();
  const now = new Date().toISOString();
  const nowMs = Date.parse(now);
  let lastCanonicalMachineId = machineId;

  for (const group of taskGroups) {
    const groupSource = normalizeTaskSource(group.source);
    const sourceToken = normalizeSourceToken(groupSource);
    const sourceMachineId = sourceToken ? `${machineId}::${sourceToken}` : machineId;
    const sourceMachineName = composeMachineAgentName(machineName, groupSource);

    // Upsert machine card scoped by source.
    let machine = findMachine(db, sourceMachineId, machineFingerprint, sourceMachineName);
    if (!machine) {
      const recordId = pickMachineRecordId(db, sourceMachineId, machineFingerprint, sourceMachineName);
      machine = {
        id: recordId || sourceMachineId,
        name: sourceMachineName,
        last_seen: now,
        online_since: now,
        fingerprint: machineFingerprint,
        aliases: dedupeAliases([sourceMachineId, machineId, recordId]),
      };
      db.machines.push(machine);
    } else {
      const wasOnline = isMachineOnline(machine, nowMs);
      machine.name = sourceMachineName;
      machine.last_seen = now;
      if (!wasOnline || !normalizeTimestamp(machine.online_since)) {
        machine.online_since = now;
      }
      machine.fingerprint = machineFingerprint;
      machine.aliases = dedupeAliases([...(machine.aliases || []), machine.id, sourceMachineId, machineId]);
    }
    mergeMachineRecords(db, machine);
    const canonicalMachineId = machine.id;
    lastCanonicalMachineId = canonicalMachineId;

    // Upsert tasks for this source card.
    (group.tasks || []).forEach(t => {
      if (!t || !t.id) return;
      const existing = db.tasks.find(tt => tt.id === t.id && tt.machine_id === canonicalMachineId);
      const nextStatus = normalizeTaskStatus(t.status);
      const nextSource = normalizeTaskSource(t.source || t?.metadata?.source || groupSource || existing?.source);
      const previousStatus = existing ? normalizeTaskStatus(existing.status) : null;
      const incomingCreatedAt = normalizeTimestamp(t.created_at);
      const incomingUpdatedAt = normalizeTimestamp(t.updated_at);
      const createdAt = resolveCreatedAt(existing, incomingCreatedAt, incomingUpdatedAt, now);
      const updatedAt = resolveUpdatedAt(existing, incomingUpdatedAt, createdAt, now);
      const incomingPreviewImages = normalizePreviewImages(
        Array.isArray(t.preview_images) ? t.preview_images : t?.metadata?.preview_images
      );
      const storedPreviewImages = normalizePreviewImages(existing?.preview_images);
      const previewImages = incomingPreviewImages.length > 0 ? incomingPreviewImages : storedPreviewImages;
      const updated = {
        id: t.id,
        machine_id: canonicalMachineId,
        title: t.title || 'Untitled Task',
        status: nextStatus,
        created_at: createdAt,
        updated_at: updatedAt
      };
      if (nextSource) {
        updated.source = nextSource;
      }
      if (previewImages.length > 0) {
        updated.preview_images = previewImages;
      }
      if (existing) {
        if (previousStatus !== nextStatus) {
          appendHistory(db, {
            id: `${canonicalMachineId}:${t.id}:${Date.now()}`,
            event: 'status_changed',
            machine_id: canonicalMachineId,
            task_id: t.id,
            title: updated.title,
            from_status: previousStatus,
            to_status: nextStatus,
            changed_at: now
          });
        }
        Object.assign(existing, updated);
      } else {
        updated.created_at = updated.created_at || now;
        db.tasks.push(updated);
        appendHistory(db, {
          id: `${canonicalMachineId}:${t.id}:${Date.now()}`,
          event: 'created',
          machine_id: canonicalMachineId,
          task_id: t.id,
          title: updated.title,
          from_status: null,
          to_status: nextStatus,
          changed_at: now
        });
      }
    });
  }

  await saveDB(db);
  broadcastDashboardUpdate({
    reason: 'report',
    machine_id: lastCanonicalMachineId,
    updated_at: now,
  });
  return res.json({ ok: true, machine: lastCanonicalMachineId, machine_fingerprint: machineFingerprint, tasks_updated: tasks.length });
}));

// API: Update UI configured machine display name.
app.put('/api/dashboard/machine/:id/display-name', asyncRoute(async (req, res) => {
  const machineId = req.params.id;
  const displayName = normalizeDisplayName(req.body?.display_name);
  const db = await loadDB();
  const machine = db.machines.find((m) => m.id === machineId);
  if (!machine) {
    return res.status(404).json({ ok: false, error: 'machine not found' });
  }

  const fingerprint = normalizeMachineFingerprint(machine.fingerprint, machine.id);
  const relatedMachines = db.machines.filter(
    (item) => normalizeMachineFingerprint(item.fingerprint, item.id) === fingerprint
  );
  for (const item of relatedMachines) {
    if (displayName) {
      item.display_name = displayName;
    } else {
      delete item.display_name;
    }
  }

  await saveDB(db);
  broadcastDashboardUpdate({
    reason: 'display_name',
    machine_id: machine.id,
    updated_at: new Date().toISOString(),
  });
  return res.json({
    ok: true,
    id: machine.id,
    agent_name: machine.name,
    display_name: machine.display_name || null,
    display_title: composeMachineTitle(machine.display_name, machine.name),
  });
}));

// API: Dashboard summary for all machines
app.get('/api/dashboard', asyncRoute(async (req, res) => {
  const db = await loadDB();
  const machines = db.machines || [];
  const tasks = db.tasks || [];
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();

  const data = machines.map(m => {
    const ms = m.id;
    const mTasks = tasks.filter(t => t.machine_id === ms);
    const counts = buildCounts(mTasks);
    const presence = resolveMachinePresence(m, nowMs);
    return {
      id: m.id,
      name: m.name,
      agent_name: m.name,
      display_name: normalizeDisplayName(m.display_name) || null,
      display_title: composeMachineTitle(m.display_name, m.name),
      last_seen: m.last_seen,
      ...presence,
      counts,
      total_tasks: mTasks.length
    };
  });
  data.sort(compareDashboardMachines);

  res.json({ updated_at: now, machines: data });
}));

// API: Details for a single machine
app.get('/api/dashboard/machine/:id', asyncRoute(async (req, res) => {
  const machineId = req.params.id;
  const db = await loadDB();
  const machine = db.machines.find(m => m.id === machineId);
  if (!machine) return res.status(404).json({ ok: false, error: 'machine not found' });
  const tasks = (db.tasks || []).filter(t => t.machine_id === machineId);
  const counts = buildCounts(tasks);
  const presence = resolveMachinePresence(machine, Date.now());
  const recent_history = (db.history || [])
    .filter(h => h.machine_id === machineId)
    .slice(-20)
    .reverse();
  res.json({
    id: machine.id,
    name: machine.name,
    agent_name: machine.name,
    display_name: normalizeDisplayName(machine.display_name) || null,
    display_title: composeMachineTitle(machine.display_name, machine.name),
    last_seen: machine.last_seen,
    ...presence,
    counts,
    tasks,
    recent_history,
  });
}));

// API: Recent status transition history
app.get('/api/dashboard/history', asyncRoute(async (req, res) => {
  const db = await loadDB();
  const machineId = typeof req.query.machine_id === 'string' ? req.query.machine_id : '';
  const taskId = typeof req.query.task_id === 'string' ? req.query.task_id : '';
  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 500) : 50;

  let items = db.history || [];
  if (machineId) items = items.filter(item => item.machine_id === machineId);
  if (taskId) items = items.filter(item => item.task_id === taskId);
  const total = items.length;
  items = items.slice(-limit).reverse();
  res.json({ total, items });
}));

// Serve frontend dashboard (static)
app.use('/', express.static(path.join(__dirname, 'dashboard/public')));

// Seed route (optional)
app.get('/seed', asyncRoute(async (req, res) => {
  const db = {
    machines: [
      { id: 'pc1', name: 'PC-Dev-1', last_seen: new Date().toISOString() },
      { id: 'pc2', name: 'PC-Dev-2', last_seen: new Date().toISOString() }
    ],
    tasks: [
      { id: 't1', machine_id: 'pc1', title: 'Build MVP dashboard', status: 'in_progress', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { id: 't2', machine_id: 'pc1', title: 'Write API docs', status: 'completed_pending_verification', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
    ],
    history: []
  };
  await saveDB(db);
  broadcastDashboardUpdate({
    reason: 'seed',
    updated_at: new Date().toISOString(),
  });
  res.json({ ok: true, seeds: db });
}));

app.use((err, req, res, _next) => {
  console.error('Request failed:', err);
  res.status(500).json({ ok: false, error: 'internal server error' });
});

async function startServer() {
  await store.init();
  app.listen(PORT, () => {
    console.log(`Vibe dashboard server listening on port ${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to initialize server:', err);
  process.exit(1);
});
