#!/usr/bin/env node

const { createStore } = require('../storage');

const DEFAULT_OFFLINE_SECONDS = 20;

function printUsage() {
  console.log(`Usage:
  node scripts/cleanup-offline-cards.js [--dry-run] [--offline-seconds <seconds>]

Options:
  --dry-run                    Preview only, do not modify data.
  --offline-seconds <seconds>  Override offline threshold in seconds.
  -h, --help                   Show this help message.

Env fallback:
  CLEANUP_OFFLINE_SECONDS -> AGENT_OFFLINE_TIMEOUT_SECONDS -> ${DEFAULT_OFFLINE_SECONDS}`);
}

function parsePositiveSeconds(raw, from) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${from} must be a positive number, got: ${raw}`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    help: false,
    offlineSeconds: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      options.help = true;
      continue;
    }
    if (arg === '--offline-seconds') {
      const next = argv[i + 1];
      if (!next) throw new Error('--offline-seconds requires a value');
      options.offlineSeconds = parsePositiveSeconds(next, '--offline-seconds');
      i += 1;
      continue;
    }
    if (arg.startsWith('--offline-seconds=')) {
      const value = arg.split('=', 2)[1];
      options.offlineSeconds = parsePositiveSeconds(value, '--offline-seconds');
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function resolveOfflineSeconds(cliValue) {
  if (cliValue != null) return cliValue;

  if (process.env.CLEANUP_OFFLINE_SECONDS) {
    return parsePositiveSeconds(process.env.CLEANUP_OFFLINE_SECONDS, 'CLEANUP_OFFLINE_SECONDS');
  }

  if (process.env.AGENT_OFFLINE_TIMEOUT_SECONDS) {
    return parsePositiveSeconds(process.env.AGENT_OFFLINE_TIMEOUT_SECONDS, 'AGENT_OFFLINE_TIMEOUT_SECONDS');
  }

  return DEFAULT_OFFLINE_SECONDS;
}

function isMachineOffline(machine, nowMs, thresholdMs) {
  const lastSeenMs = Date.parse(machine?.last_seen || '');
  if (Number.isNaN(lastSeenMs)) return true;
  return nowMs - lastSeenMs > thresholdMs;
}

function formatMachineLine(machine, nowMs) {
  const id = String(machine?.id || '').trim() || '(no-id)';
  const name = String(machine?.name || '').trim() || 'Unknown';
  const lastSeen = String(machine?.last_seen || '').trim();
  const lastSeenMs = Date.parse(lastSeen);
  if (Number.isNaN(lastSeenMs)) {
    return `${id} (${name}) last_seen=invalid`;
  }
  const offlineSeconds = Math.max(Math.round((nowMs - lastSeenMs) / 1000), 0);
  return `${id} (${name}) offline=${offlineSeconds}s last_seen=${new Date(lastSeenMs).toISOString()}`;
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const offlineSeconds = resolveOfflineSeconds(options.offlineSeconds);
  const thresholdMs = offlineSeconds * 1000;
  const nowMs = Date.now();

  const store = createStore();
  await store.init();
  const db = await store.loadDB();

  const machines = Array.isArray(db?.machines) ? db.machines : [];
  const tasks = Array.isArray(db?.tasks) ? db.tasks : [];
  const history = Array.isArray(db?.history) ? db.history : [];

  const offlineMachines = machines.filter((machine) => isMachineOffline(machine, nowMs, thresholdMs));
  const offlineMachineIds = new Set(offlineMachines.map((machine) => machine.id).filter(Boolean));

  if (offlineMachineIds.size === 0) {
    console.log(`[done] No offline cards found (threshold=${offlineSeconds}s).`);
    return;
  }

  const removedTasks = tasks.filter((task) => offlineMachineIds.has(task?.machine_id)).length;
  const removedHistory = history.filter((item) => offlineMachineIds.has(item?.machine_id)).length;

  console.log(`[info] Found ${offlineMachineIds.size} offline card(s), ${removedTasks} task(s), ${removedHistory} history item(s).`);
  console.log('[info] Targets:');
  offlineMachines.forEach((machine) => {
    console.log(`  - ${formatMachineLine(machine, nowMs)}`);
  });

  if (options.dryRun) {
    console.log('[done] Dry run mode, nothing was deleted.');
    return;
  }

  const nextDb = {
    machines: machines.filter((machine) => !offlineMachineIds.has(machine?.id)),
    tasks: tasks.filter((task) => !offlineMachineIds.has(task?.machine_id)),
    history: history.filter((item) => !offlineMachineIds.has(item?.machine_id)),
  };

  await store.saveDB(nextDb);
  console.log('[done] Offline card data cleaned.');
}

run().catch((err) => {
  console.error(`[error] ${err?.message || err}`);
  process.exitCode = 1;
});
