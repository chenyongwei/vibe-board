const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

function runCleanupScript({ dbPath, args = [], env = {} }) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['scripts/cleanup-offline-cards.js', ...args],
      {
        cwd: path.resolve(__dirname, '..'),
        env: {
          ...process.env,
          STORAGE_BACKEND: 'file',
          DB_PATH: dbPath,
          ...env,
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

function writeDb(dbPath, payload) {
  fs.writeFileSync(dbPath, JSON.stringify(payload, null, 2), 'utf8');
}

function readDb(dbPath) {
  return JSON.parse(fs.readFileSync(dbPath, 'utf8'));
}

test('cleanup script removes offline machine cards and related data', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-cleanup-offline-test-'));
  const dbPath = path.join(tempDir, 'db.json');
  const now = Date.now();

  const db = {
    machines: [
      { id: 'm-online', name: 'Online Card', last_seen: new Date(now - 2_000).toISOString() },
      { id: 'm-offline', name: 'Offline Card', last_seen: new Date(now - 120_000).toISOString() },
    ],
    tasks: [
      { machine_id: 'm-online', id: 't1', title: 'Online task', status: 'in_progress' },
      { machine_id: 'm-offline', id: 't2', title: 'Offline task', status: 'awaiting_verification' },
    ],
    history: [
      { id: 'h1', machine_id: 'm-online', task_id: 't1', event: 'created', changed_at: new Date(now - 2_000).toISOString() },
      { id: 'h2', machine_id: 'm-offline', task_id: 't2', event: 'created', changed_at: new Date(now - 120_000).toISOString() },
    ],
  };

  writeDb(dbPath, db);

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const result = await runCleanupScript({
    dbPath,
    env: { AGENT_OFFLINE_TIMEOUT_SECONDS: '30' },
  });

  assert.match(result.stdout, /Found 1 offline card/);
  assert.match(result.stdout, /Offline card data cleaned/);

  const nextDb = readDb(dbPath);
  assert.deepEqual(nextDb.machines.map((item) => item.id), ['m-online']);
  assert.deepEqual(nextDb.tasks.map((item) => item.machine_id), ['m-online']);
  assert.deepEqual(nextDb.history.map((item) => item.machine_id), ['m-online']);
});

test('cleanup script supports --dry-run and keeps data unchanged', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-cleanup-offline-dry-run-test-'));
  const dbPath = path.join(tempDir, 'db.json');
  const now = Date.now();

  const db = {
    machines: [{ id: 'm-offline', name: 'Offline Card', last_seen: new Date(now - 120_000).toISOString() }],
    tasks: [{ machine_id: 'm-offline', id: 't1', title: 'Task', status: 'in_progress' }],
    history: [{ id: 'h1', machine_id: 'm-offline', task_id: 't1', event: 'created', changed_at: new Date(now - 120_000).toISOString() }],
  };
  writeDb(dbPath, db);

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const before = readDb(dbPath);
  const result = await runCleanupScript({
    dbPath,
    args: ['--dry-run'],
    env: { AGENT_OFFLINE_TIMEOUT_SECONDS: '30' },
  });

  assert.match(result.stdout, /Dry run mode/);
  const after = readDb(dbPath);
  assert.deepEqual(after, before);
});
