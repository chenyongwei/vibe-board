const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr !== 'object') {
        server.close(() => reject(new Error('Failed to get free port')));
        return;
      }
      const port = addr.port;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

async function waitForServer(baseUrl, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/dashboard`);
      if (res.ok) return;
      lastError = new Error(`Unexpected status: ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await sleep(100);
  }
  throw lastError || new Error('Server did not become ready');
}

function drainSseEvents(state) {
  const normalized = state.buffer.replaceAll('\r\n', '\n');
  const chunks = normalized.split('\n\n');
  state.buffer = chunks.pop() || '';
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const lines = chunk.split('\n');
    let event = 'message';
    const dataLines = [];
    for (const rawLine of lines) {
      const line = String(rawLine || '');
      if (!line) continue;
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) {
        event = line.slice('event:'.length).trim() || 'message';
        continue;
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trimStart());
      }
    }
    let data = null;
    if (dataLines.length > 0) {
      const payload = dataLines.join('\n');
      try {
        data = JSON.parse(payload);
      } catch {
        data = payload;
      }
    }
    state.queue.push({ event, data });
  }
}

async function readNextSseEvent(state, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    drainSseEvents(state);
    if (state.queue.length > 0) {
      return state.queue.shift();
    }

    const remainingMs = Math.max(deadline - Date.now(), 1);
    const result = await Promise.race([
      state.reader.read(),
      sleep(remainingMs).then(() => ({ timeout: true })),
    ]);

    if (result && result.timeout) {
      continue;
    }
    if (result.done) {
      throw new Error('SSE stream closed unexpectedly');
    }
    state.buffer += state.decoder.decode(result.value, { stream: true });
  }
  throw new Error(`Timed out waiting for SSE event after ${timeoutMs}ms`);
}

test('dashboard stream pushes update when report is received', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-dashboard-stream-test-'));
  const dbPath = path.join(tempDir, 'db.json');
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  let logs = '';
  const server = spawn(process.execPath, ['index.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: dbPath,
      STORAGE_BACKEND: 'file',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => { logs += chunk.toString(); });
  server.stderr.on('data', (chunk) => { logs += chunk.toString(); });

  let streamController;
  let streamState;
  t.after(async () => {
    if (streamController) {
      streamController.abort();
    }
    if (streamState?.reader) {
      try {
        await streamState.reader.cancel();
      } catch {}
    }
    if (!server.killed) {
      server.kill('SIGTERM');
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await waitForServer(baseUrl);

  streamController = new AbortController();
  const streamResp = await fetch(`${baseUrl}/api/dashboard/stream`, {
    headers: { Accept: 'text/event-stream' },
    signal: streamController.signal,
  });
  assert.equal(streamResp.status, 200, logs);
  assert.match(String(streamResp.headers.get('content-type') || ''), /^text\/event-stream/);
  assert.ok(streamResp.body);

  streamState = {
    reader: streamResp.body.getReader(),
    decoder: new TextDecoder(),
    buffer: '',
    queue: [],
  };

  let connectedEvent = null;
  const connectedDeadline = Date.now() + 3000;
  while (Date.now() < connectedDeadline) {
    const event = await readNextSseEvent(streamState, 1000);
    if (event.event !== 'connected') continue;
    connectedEvent = event;
    break;
  }
  assert.ok(connectedEvent, 'expected connected SSE event');

  const reportResp = await fetch(`${baseUrl}/api/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      machine_id: 'm-stream',
      machine_name: 'Stream-Machine',
      tasks: [{ id: 's1', title: 'Stream Task', status: 'in_progress' }],
    }),
  });
  assert.equal(reportResp.status, 200, logs);

  let updateEvent = null;
  const endAt = Date.now() + 5000;
  while (Date.now() < endAt) {
    const event = await readNextSseEvent(streamState, 1500);
    if (event.event !== 'dashboard_updated') continue;
    updateEvent = event;
    break;
  }

  assert.ok(updateEvent, 'expected dashboard_updated SSE event');
  assert.equal(updateEvent.data?.reason, 'report');
  assert.equal(updateEvent.data?.machine_id, 'm-stream');
});

test('report to dashboard pipeline dedupes tasks and records status transitions', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-dashboard-test-'));
  const dbPath = path.join(tempDir, 'db.json');
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  let logs = '';
  const server = spawn(process.execPath, ['index.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: dbPath,
      STORAGE_BACKEND: 'file',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => { logs += chunk.toString(); });
  server.stderr.on('data', (chunk) => { logs += chunk.toString(); });

  t.after(() => {
    if (!server.killed) {
      server.kill('SIGTERM');
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await waitForServer(baseUrl);

  const firstReportResp = await fetch(`${baseUrl}/api/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      machine_id: 'm1',
      machine_name: 'Machine-1',
      tasks: [
        { id: 't1', title: 'Task 1', status: 'in_progress', source: 'Codex' },
        { id: 't1', title: 'Task 1', status: 'completed_pending_verification', source: 'Codex' },
        { id: 't2', title: 'Task 2', status: 'verified', source: 'OpenCode', preview_images: ['data:image/png;base64,AAAA'] },
      ],
    }),
  });
  assert.equal(firstReportResp.status, 200, logs);
  const firstReport = await firstReportResp.json();
  assert.equal(firstReport.tasks_updated, 2);

  const summaryResp = await fetch(`${baseUrl}/api/dashboard`);
  assert.equal(summaryResp.status, 200, logs);
  const summary = await summaryResp.json();
  assert.equal(summary.machines.length, 2);
  const codexCard = summary.machines.find((item) => item.agent_name === 'Machine-1 · Codex');
  const openCodeCard = summary.machines.find((item) => item.agent_name === 'Machine-1 · OpenCode');
  assert.ok(codexCard);
  assert.ok(openCodeCard);

  const codexDetailResp = await fetch(`${baseUrl}/api/dashboard/machine/${encodeURIComponent(codexCard.id)}`);
  assert.equal(codexDetailResp.status, 200, logs);
  const codexMachine = await codexDetailResp.json();
  assert.equal(codexMachine.tasks.length, 1);
  assert.deepEqual(codexMachine.counts, {
    in_progress: 0,
    awaiting_verification: 1,
    verified: 0,
  });
  assert.equal(codexMachine.tasks.find((task) => task.id === 't1')?.source, 'Codex');

  const openCodeDetailResp = await fetch(`${baseUrl}/api/dashboard/machine/${encodeURIComponent(openCodeCard.id)}`);
  assert.equal(openCodeDetailResp.status, 200, logs);
  const openCodeMachine = await openCodeDetailResp.json();
  assert.equal(openCodeMachine.tasks.length, 1);
  assert.deepEqual(openCodeMachine.counts, {
    in_progress: 0,
    awaiting_verification: 0,
    verified: 1,
  });
  assert.deepEqual(
    openCodeMachine.tasks.find((task) => task.id === 't2')?.preview_images,
    ['data:image/png;base64,AAAA']
  );
  assert.equal(openCodeMachine.tasks.find((task) => task.id === 't2')?.source, 'OpenCode');

  const secondReportResp = await fetch(`${baseUrl}/api/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      machine_id: 'm1',
      machine_name: 'Machine-1',
      tasks: [{ id: 't1', title: 'Task 1', status: 'verified', source: 'Codex' }],
    }),
  });
  assert.equal(secondReportResp.status, 200, logs);

  const secondDashboardResp = await fetch(`${baseUrl}/api/dashboard/machine/${encodeURIComponent(codexCard.id)}`);
  assert.equal(secondDashboardResp.status, 200, logs);
  const secondMachine = await secondDashboardResp.json();
  assert.equal(secondMachine.tasks.find((task) => task.id === 't1')?.source, 'Codex');

  const historyResp = await fetch(
    `${baseUrl}/api/dashboard/history?machine_id=${encodeURIComponent(codexCard.id)}&task_id=t1&limit=10`
  );
  assert.equal(historyResp.status, 200, logs);
  const history = await historyResp.json();
  assert.ok(
    history.items.some(
      (item) =>
        item.event === 'status_changed' &&
        item.from_status === 'awaiting_verification' &&
        item.to_status === 'verified'
    ),
    `Expected transition not found. History: ${JSON.stringify(history)}`
  );

  const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  assert.equal(db.tasks.length, 2);
});

test('same machine fingerprint keeps a single machine record across machine_id changes', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-dashboard-fingerprint-test-'));
  const dbPath = path.join(tempDir, 'db.json');
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  let logs = '';
  const server = spawn(process.execPath, ['index.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: dbPath,
      STORAGE_BACKEND: 'file',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => { logs += chunk.toString(); });
  server.stderr.on('data', (chunk) => { logs += chunk.toString(); });

  t.after(() => {
    if (!server.killed) {
      server.kill('SIGTERM');
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await waitForServer(baseUrl);

  const fingerprint = 'fp-local-machine-001';
  const firstResp = await fetch(`${baseUrl}/api/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      machine_id: 'mac-boot-1',
      machine_name: 'Mac Local',
      machine_fingerprint: fingerprint,
      tasks: [{ id: 'a', title: 'A', status: 'in_progress' }],
    }),
  });
  assert.equal(firstResp.status, 200, logs);
  const firstData = await firstResp.json();
  assert.equal(firstData.machine, 'mac-boot-1');

  const secondResp = await fetch(`${baseUrl}/api/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      machine_id: 'mac-boot-2',
      machine_name: 'Mac Local',
      machine_fingerprint: fingerprint,
      tasks: [{ id: 'b', title: 'B', status: 'verified' }],
    }),
  });
  assert.equal(secondResp.status, 200, logs);
  const secondData = await secondResp.json();
  assert.equal(secondData.machine, 'mac-boot-1');

  const dashboardResp = await fetch(`${baseUrl}/api/dashboard`);
  assert.equal(dashboardResp.status, 200, logs);
  const dashboard = await dashboardResp.json();
  assert.equal(dashboard.machines.length, 1);
  assert.equal(dashboard.machines[0].id, 'mac-boot-1');
  assert.equal(dashboard.machines[0].total_tasks, 2);

  const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  assert.equal(db.machines.length, 1);
  assert.equal(db.tasks.length, 2);
  assert.equal(db.tasks.filter((task) => task.machine_id === 'mac-boot-1').length, 2);
});

test('task created_at and updated_at should preserve reported task timestamps', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-dashboard-task-time-test-'));
  const dbPath = path.join(tempDir, 'db.json');
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  let logs = '';
  const server = spawn(process.execPath, ['index.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: dbPath,
      STORAGE_BACKEND: 'file',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => { logs += chunk.toString(); });
  server.stderr.on('data', (chunk) => { logs += chunk.toString(); });

  t.after(() => {
    if (!server.killed) {
      server.kill('SIGTERM');
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await waitForServer(baseUrl);

  const createdAt = '2026-02-22T13:00:00.000Z';
  const firstUpdatedAt = '2026-02-22T13:30:00.000Z';
  const secondUpdatedAt = '2026-02-22T14:10:00.000Z';

  const firstResp = await fetch(`${baseUrl}/api/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      machine_id: 'm-time',
      machine_name: 'Machine-Time',
      tasks: [
        {
          id: 'time-task',
          title: 'Timestamp Task',
          status: 'in_progress',
          created_at: createdAt,
          updated_at: firstUpdatedAt,
        },
      ],
    }),
  });
  assert.equal(firstResp.status, 200, logs);

  const firstDetailResp = await fetch(`${baseUrl}/api/dashboard/machine/m-time`);
  assert.equal(firstDetailResp.status, 200, logs);
  const firstDetail = await firstDetailResp.json();
  const firstTask = firstDetail.tasks.find((task) => task.id === 'time-task');
  assert.ok(firstTask);
  assert.equal(firstTask.created_at, createdAt);
  assert.equal(firstTask.updated_at, firstUpdatedAt);

  const secondResp = await fetch(`${baseUrl}/api/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      machine_id: 'm-time',
      machine_name: 'Machine-Time',
      tasks: [
        {
          id: 'time-task',
          title: 'Timestamp Task',
          status: 'verified',
          updated_at: secondUpdatedAt,
        },
      ],
    }),
  });
  assert.equal(secondResp.status, 200, logs);

  const secondDetailResp = await fetch(`${baseUrl}/api/dashboard/machine/m-time`);
  assert.equal(secondDetailResp.status, 200, logs);
  const secondDetail = await secondDetailResp.json();
  const secondTask = secondDetail.tasks.find((task) => task.id === 'time-task');
  assert.ok(secondTask);
  assert.equal(secondTask.created_at, createdAt);
  assert.equal(secondTask.updated_at, secondUpdatedAt);
});

test('dashboard should prefer UI configured display name and fallback to agent name', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-dashboard-display-name-test-'));
  const dbPath = path.join(tempDir, 'db.json');
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  let logs = '';
  const server = spawn(process.execPath, ['index.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: dbPath,
      STORAGE_BACKEND: 'file',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => { logs += chunk.toString(); });
  server.stderr.on('data', (chunk) => { logs += chunk.toString(); });

  t.after(() => {
    if (!server.killed) {
      server.kill('SIGTERM');
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await waitForServer(baseUrl);

  const reportResp = await fetch(`${baseUrl}/api/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      machine_id: 'm-display',
      machine_name: 'AgentName',
      tasks: [{ id: 'x', title: 'X', status: 'in_progress' }],
    }),
  });
  assert.equal(reportResp.status, 200, logs);

  const beforeSet = await fetch(`${baseUrl}/api/dashboard`);
  assert.equal(beforeSet.status, 200, logs);
  const beforeData = await beforeSet.json();
  assert.equal(beforeData.machines[0].display_title, 'AgentName');

  const setResp = await fetch(`${baseUrl}/api/dashboard/machine/m-display/display-name`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ display_name: '办公室主机' }),
  });
  assert.equal(setResp.status, 200, logs);
  const setData = await setResp.json();
  assert.equal(setData.display_title, '办公室主机 (AgentName)');

  const afterSet = await fetch(`${baseUrl}/api/dashboard`);
  assert.equal(afterSet.status, 200, logs);
  const afterData = await afterSet.json();
  assert.equal(afterData.machines[0].display_title, '办公室主机 (AgentName)');

  const clearResp = await fetch(`${baseUrl}/api/dashboard/machine/m-display/display-name`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ display_name: '' }),
  });
  assert.equal(clearResp.status, 200, logs);

  const afterClear = await fetch(`${baseUrl}/api/dashboard`);
  assert.equal(afterClear.status, 200, logs);
  const afterClearData = await afterClear.json();
  assert.equal(afterClearData.machines[0].display_title, 'AgentName');
});

test('same machine fingerprint supports multiple agents as separate cards', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-dashboard-multi-agent-test-'));
  const dbPath = path.join(tempDir, 'db.json');
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  let logs = '';
  const server = spawn(process.execPath, ['index.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: dbPath,
      STORAGE_BACKEND: 'file',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => { logs += chunk.toString(); });
  server.stderr.on('data', (chunk) => { logs += chunk.toString(); });

  t.after(() => {
    if (!server.killed) {
      server.kill('SIGTERM');
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await waitForServer(baseUrl);

  const fingerprint = 'fp-local-machine-009';
  const firstResp = await fetch(`${baseUrl}/api/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      machine_id: 'mac-host',
      machine_name: 'Codex Agent',
      machine_fingerprint: fingerprint,
      tasks: [{ id: 'a', title: 'A', status: 'in_progress' }],
    }),
  });
  assert.equal(firstResp.status, 200, logs);
  const firstData = await firstResp.json();
  assert.equal(firstData.machine, 'mac-host');

  const secondResp = await fetch(`${baseUrl}/api/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      machine_id: 'mac-host',
      machine_name: 'Claude Agent',
      machine_fingerprint: fingerprint,
      tasks: [{ id: 'b', title: 'B', status: 'verified' }],
    }),
  });
  assert.equal(secondResp.status, 200, logs);
  const secondData = await secondResp.json();
  assert.ok(secondData.machine.startsWith('mac-host::claude-agent-'));

  const dashboardResp = await fetch(`${baseUrl}/api/dashboard`);
  assert.equal(dashboardResp.status, 200, logs);
  const dashboard = await dashboardResp.json();
  assert.equal(dashboard.machines.length, 2);

  const codexCard = dashboard.machines.find((item) => item.agent_name === 'Codex Agent');
  const claudeCard = dashboard.machines.find((item) => item.agent_name === 'Claude Agent');
  assert.ok(codexCard);
  assert.ok(claudeCard);
  assert.equal(codexCard.total_tasks, 1);
  assert.equal(claudeCard.total_tasks, 1);

  const renameResp = await fetch(`${baseUrl}/api/dashboard/machine/${encodeURIComponent(codexCard.id)}/display-name`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ display_name: 'Mac Mini M4' }),
  });
  assert.equal(renameResp.status, 200, logs);

  const renamedDashboardResp = await fetch(`${baseUrl}/api/dashboard`);
  assert.equal(renamedDashboardResp.status, 200, logs);
  const renamedDashboard = await renamedDashboardResp.json();
  assert.ok(
    renamedDashboard.machines.every((item) => item.display_title.startsWith('Mac Mini M4 ('))
  );
  assert.ok(renamedDashboard.machines.every((item) => item.display_name === 'Mac Mini M4'));
});

test('same machine should split cards by task source', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-dashboard-source-cards-test-'));
  const dbPath = path.join(tempDir, 'db.json');
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  let logs = '';
  const server = spawn(process.execPath, ['index.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: dbPath,
      STORAGE_BACKEND: 'file',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => { logs += chunk.toString(); });
  server.stderr.on('data', (chunk) => { logs += chunk.toString(); });

  t.after(() => {
    if (!server.killed) {
      server.kill('SIGTERM');
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await waitForServer(baseUrl);

  const resp = await fetch(`${baseUrl}/api/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      machine_id: 'm-source',
      machine_name: 'Mac Mini M4',
      machine_fingerprint: 'fp-source-split-01',
      tasks: [
        { id: 'c1', title: 'Codex Task', status: 'in_progress', source: 'Codex' },
        { id: 'o1', title: 'OpenCode Task', status: 'verified', source: 'OpenCode' },
        { id: 'a1', title: 'Claude Task', status: 'awaiting_verification', source: 'Claude Code' },
      ],
    }),
  });
  assert.equal(resp.status, 200, logs);

  const dashboardResp = await fetch(`${baseUrl}/api/dashboard`);
  assert.equal(dashboardResp.status, 200, logs);
  const dashboard = await dashboardResp.json();
  assert.equal(dashboard.machines.length, 3);

  const titles = new Set(dashboard.machines.map((item) => item.display_title));
  assert.ok(titles.has('Mac Mini M4 · Codex'));
  assert.ok(titles.has('Mac Mini M4 · OpenCode'));
  assert.ok(titles.has('Mac Mini M4 · Claude Code'));
  assert.ok(dashboard.machines.every((item) => item.total_tasks === 1));
});

test('same fingerprint/source keeps a single card when machine_name casing changes', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-dashboard-source-identity-test-'));
  const dbPath = path.join(tempDir, 'db.json');
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  let logs = '';
  const server = spawn(process.execPath, ['index.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: dbPath,
      STORAGE_BACKEND: 'file',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => { logs += chunk.toString(); });
  server.stderr.on('data', (chunk) => { logs += chunk.toString(); });

  t.after(() => {
    if (!server.killed) {
      server.kill('SIGTERM');
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await waitForServer(baseUrl);

  const reportMachine = async (payload) => {
    const resp = await fetch(`${baseUrl}/api/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(resp.status, 200, logs);
  };

  await reportMachine({
    machine_id: 'm-case',
    machine_name: 'Macbook Air M4',
    machine_fingerprint: 'fp-source-identity-01',
    tasks: [{ id: 'c1', title: 'Codex Task', status: 'in_progress', source: 'Codex' }],
  });

  await reportMachine({
    machine_id: 'm-case',
    machine_name: 'MacBook Air M4',
    machine_fingerprint: 'fp-source-identity-01',
    tasks: [{ id: 'c1', title: 'Codex Task', status: 'awaiting_verification', source: 'Codex' }],
  });

  const dashboardResp = await fetch(`${baseUrl}/api/dashboard`);
  assert.equal(dashboardResp.status, 200, logs);
  const dashboard = await dashboardResp.json();
  const codexCards = dashboard.machines.filter((item) => item.agent_name.toLowerCase().includes('codex'));
  assert.equal(codexCards.length, 1);
  assert.equal(codexCards[0]?.id, 'm-case::codex');
  assert.deepEqual(codexCards[0]?.counts, {
    in_progress: 0,
    awaiting_verification: 1,
    verified: 0,
  });
  assert.equal(codexCards[0]?.total_tasks, 1);

  const detailResp = await fetch(`${baseUrl}/api/dashboard/machine/${encodeURIComponent(codexCards[0].id)}`);
  assert.equal(detailResp.status, 200, logs);
  const detail = await detailResp.json();
  assert.equal(detail.tasks.length, 1);
  assert.equal(detail.tasks[0]?.id, 'c1');
  assert.equal(detail.tasks[0]?.status, 'awaiting_verification');
});

test('dashboard sorts by in-progress count, keeps offline cards last, and orders offline by offline_since', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-dashboard-agent-status-test-'));
  const dbPath = path.join(tempDir, 'db.json');
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  let logs = '';
  const server = spawn(process.execPath, ['index.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: dbPath,
      STORAGE_BACKEND: 'file',
      AGENT_OFFLINE_TIMEOUT_SECONDS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => { logs += chunk.toString(); });
  server.stderr.on('data', (chunk) => { logs += chunk.toString(); });

  t.after(() => {
    if (!server.killed) {
      server.kill('SIGTERM');
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await waitForServer(baseUrl);

  const reportMachine = async (payload) => {
    const resp = await fetch(`${baseUrl}/api/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(resp.status, 200, logs);
    return resp.json();
  };

  await reportMachine({
    machine_id: 'm-offline-old',
    machine_name: 'Offline Old',
    machine_fingerprint: 'fp-agent-status-old',
    tasks: [{ id: 'old-task', title: 'Old Task', status: 'in_progress' }],
  });

  await sleep(1200);

  await reportMachine({
    machine_id: 'm-offline-new',
    machine_name: 'Offline New',
    machine_fingerprint: 'fp-agent-status-new',
    tasks: [{ id: 'new-task', title: 'New Task', status: 'in_progress' }],
  });

  await sleep(1200);

  await reportMachine({
    machine_id: 'm-online-high',
    machine_name: 'Online High',
    machine_fingerprint: 'fp-agent-status-online-high',
    tasks: [
      { id: 'high-1', title: 'High 1', status: 'in_progress' },
      { id: 'high-2', title: 'High 2', status: 'in_progress' },
      { id: 'high-3', title: 'High 3', status: 'in_progress' },
    ],
  });

  await sleep(80);

  await reportMachine({
    machine_id: 'm-online-low',
    machine_name: 'Online Low',
    machine_fingerprint: 'fp-agent-status-online-low',
    tasks: [{ id: 'low-1', title: 'Low 1', status: 'in_progress' }],
  });

  const dashboardResp = await fetch(`${baseUrl}/api/dashboard`);
  assert.equal(dashboardResp.status, 200, logs);
  const dashboard = await dashboardResp.json();
  assert.equal(dashboard.machines.length, 4);
  assert.deepEqual(
    dashboard.machines.map((item) => item.id),
    ['m-online-high', 'm-online-low', 'm-offline-new', 'm-offline-old']
  );

  const onlineHighCard = dashboard.machines[0];
  const onlineLowCard = dashboard.machines[1];
  const offlineNewCard = dashboard.machines[2];
  const offlineOldCard = dashboard.machines[3];

  assert.equal(onlineHighCard.agent_status, 'online');
  assert.equal(onlineHighCard.counts.in_progress, 3);
  assert.ok(onlineHighCard.online_since);
  assert.equal(onlineHighCard.offline_since, null);

  assert.equal(onlineLowCard.agent_status, 'online');
  assert.equal(onlineLowCard.counts.in_progress, 1);

  assert.equal(offlineNewCard.agent_status, 'offline');
  assert.ok(offlineNewCard.offline_since);
  assert.ok(Date.parse(offlineNewCard.offline_since) >= Date.parse(offlineNewCard.last_seen));

  assert.equal(offlineOldCard.agent_status, 'offline');
  assert.ok(offlineOldCard.offline_since);
  assert.ok(Date.parse(offlineOldCard.offline_since) >= Date.parse(offlineOldCard.last_seen));
  assert.ok(Date.parse(offlineNewCard.offline_since) > Date.parse(offlineOldCard.offline_since));
  assert.deepEqual(offlineOldCard.counts, {
    in_progress: 0,
    awaiting_verification: 1,
    verified: 0,
  });

  const detailResp = await fetch(`${baseUrl}/api/dashboard/machine/m-offline-old`);
  assert.equal(detailResp.status, 200, logs);
  const detail = await detailResp.json();
  assert.equal(detail.agent_status, 'offline');
  assert.ok(detail.offline_since);
  assert.ok(detail.online_since);
  assert.deepEqual(detail.counts, {
    in_progress: 0,
    awaiting_verification: 1,
    verified: 0,
  });
  assert.equal(detail.tasks[0]?.status, 'awaiting_verification');
  assert.equal(detail.tasks[0]?.raw_status, 'in_progress');
});
