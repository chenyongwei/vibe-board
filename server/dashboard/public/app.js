const STATUS_LABELS = {
  in_progress: '进行中',
  awaiting_verification: '待验收',
  verified: '已验证',
};
const MACHINE_SOURCE_SEPARATORS = [' · ', ' / ', ' - '];

let currentMachines = [];
let machineIndex = new Map();
let selectedView = null;
const MAX_TASK_PREVIEW_IMAGES = 3;
const POLL_INTERVAL_MS = 15000;
const CARD_ALERT_DURATION_MS = 60 * 1000;
const ALERT_SOUND_COOLDOWN_MS = 2000;
const ALERT_SOUND_FILE_URL = '/assets/sounds/alert-soft.mp3';
const ALERT_SOUND_VOLUME = 0.62;
const ALERT_SOUND_PLAYBACK_RATE = 0.9;
let dashboardEventStream = null;
let liveRefreshTimer = null;
let pollIntervalId = null;
let loadInFlight = null;
let lastAlertSoundAt = 0;
let alertAudioContext = null;
let alertAudioElement = null;
let hasUnlockedAudio = false;
let previousMachineCounts = new Map();
const machineAlertUntil = new Map();
const machineAlertTimers = new Map();

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll('`', '&#96;');
}

function normalizeStatus(status) {
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

function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}

function getAgentStatus(machine) {
  const value = String(machine?.agent_status || '').trim();
  return value === 'offline' ? 'offline' : 'online';
}

function getStatusSince(machine) {
  if (getAgentStatus(machine) === 'offline') {
    return machine?.offline_since || machine?.last_seen || '';
  }
  return machine?.online_since || machine?.last_seen || '';
}

function statusBadgeLabel(machine) {
  return getAgentStatus(machine) === 'offline' ? '离线' : '在线';
}

function statusTimeLabel(machine) {
  const ts = getStatusSince(machine);
  if (getAgentStatus(machine) === 'offline') {
    return `离线时间：${formatDate(ts)}`;
  }
  return `上线时间：${formatDate(ts)}`;
}

function getAgentName(machine) {
  const value = String(machine?.agent_name || machine?.name || '').trim();
  return value || '未命名 Agent';
}

function toSafeCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return n >= 0 ? n : 0;
}

function collectMachineCounts(machines) {
  const next = new Map();
  for (const machine of machines || []) {
    if (!machine || !machine.id) continue;
    next.set(machine.id, {
      inProgress: toSafeCount(machine?.counts?.in_progress),
      awaiting: toSafeCount(machine?.counts?.awaiting_verification),
    });
  }
  return next;
}

function findPromotedMachines(machines) {
  const promotedMachineIds = [];
  const nextCounts = collectMachineCounts(machines);
  for (const machine of machines || []) {
    if (!machine || !machine.id) continue;
    const previous = previousMachineCounts.get(machine.id);
    if (!previous) continue;
    const current = nextCounts.get(machine.id);
    if (!current) continue;
    const deltaInProgress = current.inProgress - previous.inProgress;
    const deltaAwaiting = current.awaiting - previous.awaiting;
    const movedCount = Math.min(-deltaInProgress, deltaAwaiting);
    if (movedCount > 0) {
      promotedMachineIds.push(machine.id);
    }
  }
  previousMachineCounts = nextCounts;
  return promotedMachineIds;
}

function isMachineAlerting(machineId, nowMs = Date.now()) {
  const until = machineAlertUntil.get(machineId);
  return Number.isFinite(until) && until > nowMs;
}

function clearMachineAlert(machineId) {
  const timerId = machineAlertTimers.get(machineId);
  if (timerId) {
    window.clearTimeout(timerId);
    machineAlertTimers.delete(machineId);
  }
  machineAlertUntil.delete(machineId);
}

function scheduleMachineAlertExpiry(machineId, durationMs) {
  const existingTimerId = machineAlertTimers.get(machineId);
  if (existingTimerId) {
    window.clearTimeout(existingTimerId);
  }
  const timerId = window.setTimeout(() => {
    machineAlertTimers.delete(machineId);
    machineAlertUntil.delete(machineId);
    renderDashboard(currentMachines);
  }, Math.max(durationMs, 1));
  machineAlertTimers.set(machineId, timerId);
}

function activateMachineAlert(machineId) {
  if (!machineId) return false;
  const nowMs = Date.now();
  const until = nowMs + CARD_ALERT_DURATION_MS;
  const wasAlerting = isMachineAlerting(machineId, nowMs);
  machineAlertUntil.set(machineId, until);
  scheduleMachineAlertExpiry(machineId, CARD_ALERT_DURATION_MS + 40);
  return !wasAlerting;
}

function cleanupExpiredMachineAlerts(nowMs = Date.now()) {
  let changed = false;
  const ids = Array.from(machineAlertUntil.keys());
  for (const machineId of ids) {
    const until = machineAlertUntil.get(machineId);
    if (Number.isFinite(until) && until > nowMs) continue;
    clearMachineAlert(machineId);
    changed = true;
  }
  return changed;
}

function unlockAlertAudio() {
  if (hasUnlockedAudio) return;

  const fileAudio = ensureAlertAudioElement();
  if (fileAudio) {
    try {
      const previousVolume = fileAudio.volume;
      fileAudio.volume = 0;
      const primeResult = fileAudio.play();
      if (primeResult && typeof primeResult.then === 'function') {
        primeResult
          .then(() => {
            fileAudio.pause();
            fileAudio.currentTime = 0;
            fileAudio.volume = previousVolume;
          })
          .catch(() => {
            fileAudio.volume = previousVolume;
          });
      } else {
        fileAudio.pause();
        fileAudio.currentTime = 0;
        fileAudio.volume = previousVolume;
      }
    } catch {}
  }

  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) {
    hasUnlockedAudio = true;
    return;
  }
  if (!alertAudioContext) {
    alertAudioContext = new AudioContextCtor();
  }
  const resumeResult = alertAudioContext.resume();
  if (resumeResult && typeof resumeResult.then === 'function') {
    resumeResult
      .then(() => {
        hasUnlockedAudio = true;
      })
      .catch(() => {});
    return;
  }
  hasUnlockedAudio = true;
}

function ensureAlertAudioElement() {
  if (alertAudioElement) return alertAudioElement;
  try {
    const audio = new Audio(ALERT_SOUND_FILE_URL);
    audio.preload = 'auto';
    audio.volume = ALERT_SOUND_VOLUME;
    audio.playbackRate = ALERT_SOUND_PLAYBACK_RATE;
    alertAudioElement = audio;
    return audio;
  } catch {
    return null;
  }
}

function playCardAlertSoundWithSynth() {
  try {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return;
    if (!alertAudioContext) {
      alertAudioContext = new AudioContextCtor();
    }
    const context = alertAudioContext;
    if (context.state === 'suspended') {
      context.resume().catch(() => {});
    }

    const start = context.currentTime + 0.02;
    const notes = [
      { freq: 740, offset: 0.0, duration: 0.28 },
      { freq: 880, offset: 0.42, duration: 0.28 },
      { freq: 988, offset: 0.84, duration: 0.28 },
      { freq: 880, offset: 1.26, duration: 0.32 },
      { freq: 740, offset: 1.64, duration: 0.3 },
    ];

    for (const note of notes) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(note.freq, start + note.offset);
      gain.gain.setValueAtTime(0.0001, start + note.offset);
      gain.gain.exponentialRampToValueAtTime(0.2, start + note.offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + note.offset + note.duration);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start + note.offset);
      oscillator.stop(start + note.offset + note.duration + 0.03);
    }
  } catch {}
}

function playCardAlertSound() {
  const nowMs = Date.now();
  if (nowMs - lastAlertSoundAt < ALERT_SOUND_COOLDOWN_MS) return;
  lastAlertSoundAt = nowMs;

  const fileAudio = ensureAlertAudioElement();
  if (fileAudio) {
    try {
      fileAudio.currentTime = 0;
      const playResult = fileAudio.play();
      if (playResult && typeof playResult.catch === 'function') {
        playResult.catch(() => {
          playCardAlertSoundWithSynth();
        });
      }
      return;
    } catch {}
  }

  playCardAlertSoundWithSynth();
}

function handlePromotedMachines(promotedMachineIds) {
  if (!promotedMachineIds.length) return;
  const uniqueIds = Array.from(new Set(promotedMachineIds.filter(Boolean)));
  if (!uniqueIds.length) return;

  let hasNewAlert = false;
  for (const machineId of uniqueIds) {
    if (activateMachineAlert(machineId)) {
      hasNewAlert = true;
    }
  }
  if (hasNewAlert) {
    playCardAlertSound();
  }
}

function getMachineDisplayTitle(machine) {
  const direct = String(machine?.display_title || '').trim();
  if (direct) return direct;

  const displayName = String(machine?.display_name || '').trim();
  if (displayName) return displayName;
  return getAgentName(machine);
}

function splitAgentNameWithSource(agentName) {
  const raw = String(agentName || '').trim();
  if (!raw) return { base: '', source: '' };

  for (const separator of MACHINE_SOURCE_SEPARATORS) {
    const idx = raw.indexOf(separator);
    if (idx <= 0) continue;
    const base = raw.slice(0, idx).trim();
    const source = raw.slice(idx + separator.length).trim();
    if (base && source) {
      return { base, source };
    }
  }

  return { base: raw, source: '' };
}

function getMachineCardTitleParts(machine) {
  const agentName = getAgentName(machine);
  const parsed = splitAgentNameWithSource(agentName);
  const displayName = String(machine?.display_name || '').trim();
  const title = displayName || parsed.base || getMachineDisplayTitle(machine);
  return { title, source: parsed.source };
}

function formatDate(ts) {
  try {
    if (!ts) return '-';
    return new Date(ts).toLocaleString('zh-CN');
  } catch {
    return ts || '-';
  }
}

async function fetchDashboard() {
  const resp = await fetch('/api/dashboard');
  if (!resp.ok) return null;
  return resp.json();
}

function scheduleLiveRefresh(delayMs = 80) {
  if (liveRefreshTimer) return;
  liveRefreshTimer = window.setTimeout(async () => {
    liveRefreshTimer = null;
    await loadAndRender();
  }, delayMs);
}

function connectDashboardStream() {
  if (typeof window.EventSource !== 'function') return;
  if (dashboardEventStream) {
    dashboardEventStream.close();
  }

  const stream = new EventSource('/api/dashboard/stream');
  dashboardEventStream = stream;
  stream.addEventListener('connected', () => {
    scheduleLiveRefresh(0);
  });
  stream.addEventListener('dashboard_updated', () => {
    scheduleLiveRefresh(80);
  });
  stream.onmessage = () => {
    scheduleLiveRefresh(80);
  };
}

function teardownLiveUpdates() {
  if (dashboardEventStream) {
    dashboardEventStream.close();
    dashboardEventStream = null;
  }
  if (liveRefreshTimer) {
    window.clearTimeout(liveRefreshTimer);
    liveRefreshTimer = null;
  }
  if (pollIntervalId) {
    window.clearInterval(pollIntervalId);
    pollIntervalId = null;
  }
  for (const timerId of machineAlertTimers.values()) {
    window.clearTimeout(timerId);
  }
  machineAlertTimers.clear();
  machineAlertUntil.clear();
  previousMachineCounts = new Map();
  lastAlertSoundAt = 0;
  hasUnlockedAudio = false;
  if (alertAudioElement) {
    try {
      alertAudioElement.pause();
      alertAudioElement.currentTime = 0;
    } catch {}
    alertAudioElement = null;
  }
  if (alertAudioContext) {
    try {
      const closeResult = alertAudioContext.close();
      if (closeResult && typeof closeResult.catch === 'function') {
        closeResult.catch(() => {});
      }
    } catch {}
    alertAudioContext = null;
  }
}

async function fetchMachineDetails(machineId) {
  const resp = await fetch(`/api/dashboard/machine/${encodeURIComponent(machineId)}`);
  if (!resp.ok) return null;
  return resp.json();
}

async function updateMachineDisplayName(machineId, displayName) {
  const resp = await fetch(`/api/dashboard/machine/${encodeURIComponent(machineId)}/display-name`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ display_name: displayName }),
  });
  if (!resp.ok) return null;
  return resp.json();
}

function countClass(status) {
  if (status === 'in_progress') return 'count-in-progress';
  if (status === 'awaiting_verification') return 'count-awaiting';
  if (status === 'verified') return 'count-verified';
  return '';
}

function isSelected(machineId, status) {
  return !!selectedView && selectedView.machineId === machineId && selectedView.status === status;
}

function compareTimestampDesc(aValue, bValue) {
  const aMs = Date.parse(aValue || '');
  const bMs = Date.parse(bValue || '');
  const aValid = !Number.isNaN(aMs);
  const bValid = !Number.isNaN(bMs);

  if (aValid && bValid && aMs !== bMs) {
    return bMs - aMs;
  }
  if (aValid !== bValid) {
    return aValid ? -1 : 1;
  }
  return 0;
}

function sortMachines(machines) {
  return [...(machines || [])].sort((a, b) => {
    const aOffline = getAgentStatus(a) === 'offline';
    const bOffline = getAgentStatus(b) === 'offline';
    if (aOffline !== bOffline) {
      return aOffline ? 1 : -1;
    }

    if (!aOffline) {
      const aInProgress = toSafeCount(a?.counts?.in_progress);
      const bInProgress = toSafeCount(b?.counts?.in_progress);
      if (aInProgress !== bInProgress) {
        return bInProgress - aInProgress;
      }

      const statusSinceDiff = compareTimestampDesc(getStatusSince(a), getStatusSince(b));
      if (statusSinceDiff !== 0) {
        return statusSinceDiff;
      }
    } else {
      const offlineSinceDiff = compareTimestampDesc(
        a?.offline_since || a?.last_seen || '',
        b?.offline_since || b?.last_seen || ''
      );
      if (offlineSinceDiff !== 0) {
        return offlineSinceDiff;
      }
    }

    const lastSeenDiff = compareTimestampDesc(a?.last_seen || '', b?.last_seen || '');
    if (lastSeenDiff !== 0) {
      return lastSeenDiff;
    }
    return String(getMachineDisplayTitle(a)).localeCompare(String(getMachineDisplayTitle(b)), 'zh-CN');
  });
}

function isPreviewImageUrl(value) {
  if (!value) return false;
  if (/^data:image\/[a-zA-Z0-9.+-]+;base64,/i.test(value)) return true;
  if (/^https?:\/\//i.test(value)) return true;
  return false;
}

function normalizeTaskTitle(value) {
  const cleaned = String(value || '')
    .replace(/<\s*\/?\s*image\s*>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || '未命名任务';
}

function normalizeTaskPreviewImages(task) {
  const input = Array.isArray(task?.preview_images)
    ? task.preview_images
    : Array.isArray(task?.metadata?.preview_images)
      ? task.metadata.preview_images
      : [];
  const out = [];
  const seen = new Set();
  for (const item of input) {
    const value = String(item || '').trim();
    if (!value) continue;
    if (!isPreviewImageUrl(value)) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= MAX_TASK_PREVIEW_IMAGES) break;
  }
  return out;
}

function renderTaskTitleCell(task) {
  const titleText = normalizeTaskTitle(task.title);
  const previewImages = normalizeTaskPreviewImages(task);
  const imagesHtml = previewImages
    .map(
      (src, index) => `
        <button type="button" class="task-image-thumb js-image-thumb" aria-label="查看大图">
          <img src="${escapeAttr(src)}" alt="${escapeAttr(`${titleText}（图片 ${index + 1}）`)}" loading="lazy" />
        </button>
      `
    )
    .join('');

  return `
    <div class="task-title-wrap">
      <div class="task-title-text">${escapeHtml(titleText)}</div>
      ${imagesHtml ? `<div class="task-images">${imagesHtml}</div>` : ''}
    </div>
  `;
}

function openImageViewer(src, alt) {
  if (!src) return;
  const viewer = document.getElementById('image-viewer');
  const image = document.getElementById('image-viewer-image');
  if (!viewer || !image) return;
  image.src = src;
  image.alt = alt || '图片预览';
  viewer.hidden = false;
  document.body.classList.add('viewer-open');
}

function closeImageViewer() {
  const viewer = document.getElementById('image-viewer');
  const image = document.getElementById('image-viewer-image');
  if (!viewer || viewer.hidden) return;
  viewer.hidden = true;
  if (image) image.src = '';
  document.body.classList.remove('viewer-open');
}

function renderDashboard(machines) {
  const root = document.getElementById('dashboard');
  cleanupExpiredMachineAlerts();
  root.innerHTML = '';
  machineIndex = new Map((machines || []).map((m) => [m.id, m]));

  if (!machines || machines.length === 0) {
    root.innerHTML = '<div class="empty">暂无数据，机器可能离线或尚未上报。</div>';
    return;
  }

  machines.forEach((m) => {
    const card = document.createElement('div');
    const status = getAgentStatus(m);
    const alertClass = isMachineAlerting(m.id) ? ' card-alerting' : '';
    card.className = `card ${status === 'offline' ? 'card-offline' : 'card-online'}${alertClass}`;
    const titleParts = getMachineCardTitleParts(m);
    const machineTitle = titleParts.title;
    const machineSource = titleParts.source;
    const presenceClass = status === 'offline' ? 'is-offline' : 'is-online';

    const renderCount = (status, value) => {
      const selectedClass = isSelected(m.id, status) ? ' count-selected' : '';
      const statusClass = countClass(status);
      return `
        <button type="button" class="count ${statusClass}${selectedClass} js-status-btn"
          data-machine-id="${escapeAttr(m.id)}" data-status="${status}">
          <span class="label">${statusLabel(status)}</span>
          <span class="value">${value}</span>
        </button>
      `;
    };

    card.innerHTML = `
      <div class="card-header">
        <div class="card-title-wrap">
          <span class="card-title">${escapeHtml(machineTitle)}</span>
          ${machineSource ? `<span class="card-source">${escapeHtml(machineSource)}</span>` : ''}
          <div class="card-presence-row">
            <span class="card-presence ${presenceClass}">${statusBadgeLabel(m)}</span>
            <span class="card-presence-time">${escapeHtml(statusTimeLabel(m))}</span>
          </div>
        </div>
        <button type="button" class="rename-btn js-rename-btn" data-machine-id="${escapeAttr(m.id)}">配置名称</button>
      </div>
      <div class="card-body">
        <div class="counts">
          ${renderCount('in_progress', m.counts.in_progress)}
          ${renderCount('awaiting_verification', m.counts.awaiting_verification)}
          ${renderCount('verified', m.counts.verified)}
        </div>
        <div class="totals">总计：${m.total_tasks}</div>
      </div>
    `;

    root.appendChild(card);
  });
}

function renderDetailsHint() {
  const root = document.getElementById('task-details');
  closeImageViewer();
  root.innerHTML = '<div class="empty">点击上方状态块查看对应任务明细。</div>';
}

function renderDetailsError(message) {
  const root = document.getElementById('task-details');
  closeImageViewer();
  root.innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
}

function renderTaskDetails(machineName, status, tasks) {
  const root = document.getElementById('task-details');
  const title = `${machineName} · ${statusLabel(status)}（${tasks.length}）`;
  const header = `
    <div class="detail-header">
      <div>${escapeHtml(title)}</div>
    </div>
  `;
  if (!tasks.length) {
    root.innerHTML = `
      <div class="detail-card">
        ${header}
        <div class="empty">该状态下暂无任务。</div>
      </div>
    `;
    return;
  }

  const rows = tasks
    .map(
      (task) => `
      <tr>
        <td>${renderTaskTitleCell(task)}</td>
        <td>${escapeHtml(formatDate(task.created_at || task.updated_at))}</td>
        <td>${escapeHtml(formatDate(task.updated_at))}</td>
      </tr>
    `
    )
    .join('');

  root.innerHTML = `
    <div class="detail-card">
      ${header}
      <div class="detail-table-wrap">
        <table class="detail-table">
          <thead>
            <tr>
              <th>任务标题</th>
              <th>开始时间</th>
              <th>最后活跃时间</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;
}

async function renderSelectedDetails() {
  if (!selectedView) {
    renderDetailsHint();
    return;
  }

  const machine = machineIndex.get(selectedView.machineId);
  if (!machine) {
    selectedView = null;
    renderDetailsHint();
    return;
  }

  const details = await fetchMachineDetails(machine.id);
  if (!details) {
    renderDetailsError('加载任务明细失败，请稍后重试。');
    return;
  }

  const status = selectedView.status;
  const tasks = (details.tasks || [])
    .filter((task) => normalizeStatus(task.status) === status)
    .sort((a, b) => Date.parse(b.updated_at || '') - Date.parse(a.updated_at || ''));

  renderTaskDetails(getMachineDisplayTitle(details), status, tasks);
}

async function loadAndRender() {
  if (loadInFlight) return loadInFlight;
  loadInFlight = (async () => {
    const data = await fetchDashboard();
    if (!data) {
      return;
    }

    const sortedMachines = sortMachines(data.machines || []);
    const promotedMachineIds = findPromotedMachines(sortedMachines);
    handlePromotedMachines(promotedMachineIds);
    currentMachines = sortedMachines;
    renderDashboard(currentMachines);

    if (!selectedView) {
      renderDetailsHint();
      return;
    }
    await renderSelectedDetails();
  })();
  try {
    await loadInFlight;
  } finally {
    loadInFlight = null;
  }
}

async function handleStatusClick(target) {
  const machineId = target.dataset.machineId;
  const status = target.dataset.status;
  if (!machineId || !status) return;

  selectedView = { machineId, status };
  renderDashboard(currentMachines);
  await renderSelectedDetails();
}

async function handleRenameClick(target) {
  const machineId = target.dataset.machineId;
  if (!machineId) return;
  const machine = machineIndex.get(machineId);
  if (!machine) return;

  const currentDisplayName = String(machine.display_name || '').trim();
  const nextName = window.prompt('请输入显示名称（留空则恢复为 Agent 名称）', currentDisplayName);
  if (nextName === null) return;

  const updated = await updateMachineDisplayName(machineId, nextName.trim());
  if (!updated) {
    window.alert('保存名称失败，请稍后重试。');
    return;
  }
  await loadAndRender();
}

function bootstrap() {
  const root = document.getElementById('dashboard');
  const detailsRoot = document.getElementById('task-details');
  const imageViewer = document.getElementById('image-viewer');

  if (!root || !detailsRoot || !imageViewer) return;

  const unlockOnGesture = () => {
    unlockAlertAudio();
  };
  document.addEventListener('pointerdown', unlockOnGesture, { once: true, passive: true });
  document.addEventListener('keydown', unlockOnGesture, { once: true });

  root.addEventListener('click', async (event) => {
    if (!(event.target instanceof Element)) return;
    const renameTarget = event.target.closest('.js-rename-btn');
    if (renameTarget) {
      await handleRenameClick(renameTarget);
      return;
    }
    const target = event.target.closest('.js-status-btn');
    if (!target) return;
    await handleStatusClick(target);
  });

  detailsRoot.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const thumb = event.target.closest('.js-image-thumb');
    if (!thumb) return;
    const image = thumb.querySelector('img');
    if (!image) return;
    openImageViewer(image.getAttribute('src') || '', image.getAttribute('alt') || '图片预览');
  });

  imageViewer.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const closeTarget = event.target.closest('.js-image-viewer-close');
    if (!closeTarget) return;
    closeImageViewer();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeImageViewer();
    }
  });

  renderDetailsHint();
  loadAndRender();
  connectDashboardStream();
  pollIntervalId = window.setInterval(loadAndRender, POLL_INTERVAL_MS);
  window.addEventListener('beforeunload', teardownLiveUpdates);
}

window.addEventListener('DOMContentLoaded', bootstrap);
