import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { CodexAdapter } from '../adapters/CodexAdapter';

interface SessionInput {
  filePath: string;
  id: string;
  cwd: string;
  startedAt: string;
  lastAt: string;
  prompts: string[];
}

function writeSession(input: SessionInput): void {
  mkdirSync(path.dirname(input.filePath), { recursive: true });
  const lines: string[] = [];
  lines.push(
    JSON.stringify({
      timestamp: input.startedAt,
      type: 'session_meta',
      payload: {
        id: input.id,
        timestamp: input.startedAt,
        cwd: input.cwd,
      },
    })
  );
  for (const prompt of input.prompts) {
    lines.push(
      JSON.stringify({
        timestamp: input.lastAt,
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'output_text', text: prompt }],
        },
      })
    );
  }
  lines.push(
    JSON.stringify({
      timestamp: input.lastAt,
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'ok' },
    })
  );
  writeFileSync(input.filePath, `${lines.join('\n')}\n`, 'utf8');
}

test('CodexAdapter reads local sessions and maps vibe statuses', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'vibe-codex-adapter-'));
  const sessionsRoot = path.join(tmp, 'sessions');
  const archivedRoot = path.join(tmp, 'archived_sessions');

  const now = new Date('2026-02-22T14:30:00.000Z');
  const recentAt = '2026-02-22T14:25:00.000Z';
  const staleAt = '2026-02-22T12:00:00.000Z';
  const archivedAt = '2026-02-21T08:00:00.000Z';

  writeSession({
    filePath: path.join(sessionsRoot, '2026/02/22/rollout-2026-02-22T14-20-00-11111111-1111-1111-1111-111111111111.jsonl'),
    id: '11111111-1111-1111-1111-111111111111',
    cwd: '/Users/alex/Code/vibe-board',
    startedAt: '2026-02-22T14:20:00.000Z',
    lastAt: recentAt,
    prompts: [
      '# AGENTS.md instructions for /Users/alex/Code/vibe-board\n<INSTRUCTIONS>...',
      '实现本地 Codex 任务监控',
    ],
  });

  writeSession({
    filePath: path.join(sessionsRoot, '2026/02/22/rollout-2026-02-22T11-30-00-22222222-2222-2222-2222-222222222222.jsonl'),
    id: '22222222-2222-2222-2222-222222222222',
    cwd: '/Users/alex/Code/other-repo',
    startedAt: '2026-02-22T11:30:00.000Z',
    lastAt: staleAt,
    prompts: ['修复状态机问题'],
  });

  writeSession({
    filePath: path.join(archivedRoot, 'rollout-2026-02-21T08-00-00-33333333-3333-3333-3333-333333333333.jsonl'),
    id: '33333333-3333-3333-3333-333333333333',
    cwd: '/Users/alex/Code/nest-core',
    startedAt: '2026-02-21T07:30:00.000Z',
    lastAt: archivedAt,
    prompts: ['历史任务'],
  });

  const restore = {
    CODEX_HOME: process.env.CODEX_HOME,
    CODEX_SESSIONS_DIR: process.env.CODEX_SESSIONS_DIR,
    CODEX_ARCHIVED_SESSIONS_DIR: process.env.CODEX_ARCHIVED_SESSIONS_DIR,
    CODEX_ACTIVE_WINDOW_MINUTES: process.env.CODEX_ACTIVE_WINDOW_MINUTES,
    CODEX_MAX_SESSIONS: process.env.CODEX_MAX_SESSIONS,
    CODEX_REQUIRE_RUNNING: process.env.CODEX_REQUIRE_RUNNING,
  };

  process.env.CODEX_HOME = tmp;
  process.env.CODEX_SESSIONS_DIR = sessionsRoot;
  process.env.CODEX_ARCHIVED_SESSIONS_DIR = archivedRoot;
  process.env.CODEX_ACTIVE_WINDOW_MINUTES = '30';
  process.env.CODEX_MAX_SESSIONS = '10';
  process.env.CODEX_REQUIRE_RUNNING = '0';

  const realNow = Date.now;
  Date.now = () => now.getTime();

  try {
    const adapter = new CodexAdapter();
    const tasks = await adapter.getTasks();
    assert.equal(tasks.length, 3);

    const byId = new Map(tasks.map((t) => [t.id, t]));
    const recent = byId.get('codex-session-11111111-1111-1111-1111-111111111111');
    const stale = byId.get('codex-session-22222222-2222-2222-2222-222222222222');
    const archived = byId.get('codex-session-33333333-3333-3333-3333-333333333333');

    assert.ok(recent);
    assert.ok(stale);
    assert.ok(archived);

    assert.equal(recent?.status, 'in_progress');
    assert.equal(recent?.title, '实现本地 Codex 任务监控');
    assert.equal(recent?.metadata?.archived, false);
    assert.deepEqual(recent?.metadata?.preview_images, []);

    assert.equal(stale?.status, 'awaiting_verification');
    assert.equal(stale?.metadata?.archived, false);
    assert.deepEqual(stale?.metadata?.preview_images, []);

    assert.equal(archived?.status, 'verified');
    assert.equal(archived?.metadata?.archived, true);
    assert.deepEqual(archived?.metadata?.preview_images, []);
  } finally {
    Date.now = realNow;
    process.env.CODEX_HOME = restore.CODEX_HOME;
    process.env.CODEX_SESSIONS_DIR = restore.CODEX_SESSIONS_DIR;
    process.env.CODEX_ARCHIVED_SESSIONS_DIR = restore.CODEX_ARCHIVED_SESSIONS_DIR;
    process.env.CODEX_ACTIVE_WINDOW_MINUTES = restore.CODEX_ACTIVE_WINDOW_MINUTES;
    process.env.CODEX_MAX_SESSIONS = restore.CODEX_MAX_SESSIONS;
    process.env.CODEX_REQUIRE_RUNNING = restore.CODEX_REQUIRE_RUNNING;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('CodexAdapter infers running and awaiting status from task lifecycle events', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'vibe-codex-adapter-task-events-'));
  const sessionsRoot = path.join(tmp, 'sessions');
  const archivedRoot = path.join(tmp, 'archived_sessions');
  const runningId = '44444444-4444-4444-4444-444444444444';
  const awaitingId = '55555555-5555-5555-5555-555555555555';

  const runningFile = path.join(
    sessionsRoot,
    '2026/02/22/rollout-2026-02-22T10-00-00-44444444-4444-4444-4444-444444444444.jsonl'
  );
  const awaitingFile = path.join(
    sessionsRoot,
    '2026/02/22/rollout-2026-02-22T11-00-00-55555555-5555-5555-5555-555555555555.jsonl'
  );

  mkdirSync(path.dirname(runningFile), { recursive: true });
  mkdirSync(path.dirname(awaitingFile), { recursive: true });

  writeFileSync(
    runningFile,
    [
      JSON.stringify({
        timestamp: '2026-02-22T10:00:00.000Z',
        type: 'session_meta',
        payload: { id: runningId, timestamp: '2026-02-22T10:00:00.000Z', cwd: '/Users/alex/Code/vibe-board' },
      }),
      JSON.stringify({ timestamp: '2026-02-22T10:05:00.000Z', type: 'event_msg', payload: { type: 'task_complete' } }),
      JSON.stringify({ timestamp: '2026-02-22T10:10:00.000Z', type: 'event_msg', payload: { type: 'task_started' } }),
      JSON.stringify({
        timestamp: '2026-02-22T10:11:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'output_text', text: '继续处理这个任务' }],
        },
      }),
      JSON.stringify({ timestamp: '2026-02-22T10:11:01.000Z', type: 'event_msg', payload: { type: 'token_count' } }),
    ].join('\n') + '\n',
    'utf8'
  );

  writeFileSync(
    awaitingFile,
    [
      JSON.stringify({
        timestamp: '2026-02-22T11:00:00.000Z',
        type: 'session_meta',
        payload: { id: awaitingId, timestamp: '2026-02-22T11:00:00.000Z', cwd: '/Users/alex/Code/vibe-board' },
      }),
      JSON.stringify({ timestamp: '2026-02-22T11:01:00.000Z', type: 'event_msg', payload: { type: 'task_started' } }),
      JSON.stringify({ timestamp: '2026-02-22T11:02:00.000Z', type: 'event_msg', payload: { type: 'task_complete' } }),
      JSON.stringify({
        timestamp: '2026-02-22T11:02:10.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'done' }],
        },
      }),
    ].join('\n') + '\n',
    'utf8'
  );

  const restore = {
    CODEX_HOME: process.env.CODEX_HOME,
    CODEX_SESSIONS_DIR: process.env.CODEX_SESSIONS_DIR,
    CODEX_ARCHIVED_SESSIONS_DIR: process.env.CODEX_ARCHIVED_SESSIONS_DIR,
    CODEX_ACTIVE_WINDOW_MINUTES: process.env.CODEX_ACTIVE_WINDOW_MINUTES,
    CODEX_MAX_SESSIONS: process.env.CODEX_MAX_SESSIONS,
    CODEX_REQUIRE_RUNNING: process.env.CODEX_REQUIRE_RUNNING,
  };

  process.env.CODEX_HOME = tmp;
  process.env.CODEX_SESSIONS_DIR = sessionsRoot;
  process.env.CODEX_ARCHIVED_SESSIONS_DIR = archivedRoot;
  process.env.CODEX_ACTIVE_WINDOW_MINUTES = '1';
  process.env.CODEX_MAX_SESSIONS = '10';
  process.env.CODEX_REQUIRE_RUNNING = '0';

  try {
    const adapter = new CodexAdapter();
    const tasks = await adapter.getTasks();
    const byId = new Map(tasks.map((t) => [t.id, t]));
    assert.equal(byId.get(`codex-session-${runningId}`)?.status, 'in_progress');
    assert.equal(byId.get(`codex-session-${awaitingId}`)?.status, 'awaiting_verification');
  } finally {
    process.env.CODEX_HOME = restore.CODEX_HOME;
    process.env.CODEX_SESSIONS_DIR = restore.CODEX_SESSIONS_DIR;
    process.env.CODEX_ARCHIVED_SESSIONS_DIR = restore.CODEX_ARCHIVED_SESSIONS_DIR;
    process.env.CODEX_ACTIVE_WINDOW_MINUTES = restore.CODEX_ACTIVE_WINDOW_MINUTES;
    process.env.CODEX_MAX_SESSIONS = restore.CODEX_MAX_SESSIONS;
    process.env.CODEX_REQUIRE_RUNNING = restore.CODEX_REQUIRE_RUNNING;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('CodexAdapter strips <image> placeholders and exposes preview images', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'vibe-codex-adapter-images-'));
  const sessionsRoot = path.join(tmp, 'sessions');
  const archivedRoot = path.join(tmp, 'archived_sessions');
  const sessionId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const sampleImage = 'data:image/png;base64,AAAA';
  const filePath = path.join(
    sessionsRoot,
    '2026/02/22/rollout-2026-02-22T15-20-00-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl'
  );

  mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = [
    JSON.stringify({
      timestamp: '2026-02-22T15:20:00.000Z',
      type: 'session_meta',
      payload: {
        id: sessionId,
        timestamp: '2026-02-22T15:20:00.000Z',
        cwd: '/Users/alex/Code/vibe-board',
      },
    }),
    JSON.stringify({
      timestamp: '2026-02-22T15:21:00.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: '如果有图片，最好能显示图片缩略图，并且能点击放大 ' },
          { type: 'input_text', text: '<image>' },
          { type: 'input_image', image_url: sampleImage },
          { type: 'input_text', text: '</image>' },
        ],
      },
    }),
  ];
  writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');

  const restore = {
    CODEX_HOME: process.env.CODEX_HOME,
    CODEX_SESSIONS_DIR: process.env.CODEX_SESSIONS_DIR,
    CODEX_ARCHIVED_SESSIONS_DIR: process.env.CODEX_ARCHIVED_SESSIONS_DIR,
    CODEX_ACTIVE_WINDOW_MINUTES: process.env.CODEX_ACTIVE_WINDOW_MINUTES,
    CODEX_MAX_SESSIONS: process.env.CODEX_MAX_SESSIONS,
    CODEX_REQUIRE_RUNNING: process.env.CODEX_REQUIRE_RUNNING,
  };

  process.env.CODEX_HOME = tmp;
  process.env.CODEX_SESSIONS_DIR = sessionsRoot;
  process.env.CODEX_ARCHIVED_SESSIONS_DIR = archivedRoot;
  process.env.CODEX_ACTIVE_WINDOW_MINUTES = '30';
  process.env.CODEX_MAX_SESSIONS = '10';
  process.env.CODEX_REQUIRE_RUNNING = '0';

  try {
    const adapter = new CodexAdapter();
    const tasks = await adapter.getTasks();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.title, '如果有图片，最好能显示图片缩略图，并且能点击放大');
    assert.deepEqual(tasks[0]?.metadata?.preview_images, [sampleImage]);
  } finally {
    process.env.CODEX_HOME = restore.CODEX_HOME;
    process.env.CODEX_SESSIONS_DIR = restore.CODEX_SESSIONS_DIR;
    process.env.CODEX_ARCHIVED_SESSIONS_DIR = restore.CODEX_ARCHIVED_SESSIONS_DIR;
    process.env.CODEX_ACTIVE_WINDOW_MINUTES = restore.CODEX_ACTIVE_WINDOW_MINUTES;
    process.env.CODEX_MAX_SESSIONS = restore.CODEX_MAX_SESSIONS;
    process.env.CODEX_REQUIRE_RUNNING = restore.CODEX_REQUIRE_RUNNING;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('CodexAdapter prefers Codex desktop thread title mapping and falls back to first meaningful prompt', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'vibe-codex-title-map-'));
  const sessionsRoot = path.join(tmp, 'sessions');
  const archivedRoot = path.join(tmp, 'archived_sessions');
  const mappedId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const fallbackId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

  writeSession({
    filePath: path.join(
      sessionsRoot,
      '2026/02/22/rollout-2026-02-22T09-00-00-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl'
    ),
    id: mappedId,
    cwd: '/Users/alex/Code/vibe-board',
    startedAt: '2026-02-22T09:00:00.000Z',
    lastAt: '2026-02-22T09:05:00.000Z',
    prompts: [
      '# AGENTS.md instructions for /Users/alex/Code/vibe-board\n<INSTRUCTIONS>...',
      '<environment_context>\n  <cwd>/Users/alex/Code/vibe-board</cwd>\n  <shell>zsh</shell>\n</environment_context>',
      '你了解下这个仓库，然后继续',
      '后续补充',
    ],
  });

  writeSession({
    filePath: path.join(
      sessionsRoot,
      '2026/02/22/rollout-2026-02-22T10-00-00-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl'
    ),
    id: fallbackId,
    cwd: '/Users/alex/Code/nest-core',
    startedAt: '2026-02-22T10:00:00.000Z',
    lastAt: '2026-02-22T10:05:00.000Z',
    prompts: [
      '<environment_context>\n  <cwd>/Users/alex/Code/nest-core</cwd>\n  <shell>zsh</shell>\n</environment_context>',
      '第一条有效需求',
      '第二条补充',
    ],
  });

  writeFileSync(
    path.join(tmp, '.codex-global-state.json'),
    JSON.stringify({
      'thread-titles': {
        titles: {
          [mappedId]: 'Explore repo then continue',
        },
      },
    }),
    'utf8'
  );

  const restore = {
    CODEX_HOME: process.env.CODEX_HOME,
    CODEX_SESSIONS_DIR: process.env.CODEX_SESSIONS_DIR,
    CODEX_ARCHIVED_SESSIONS_DIR: process.env.CODEX_ARCHIVED_SESSIONS_DIR,
    CODEX_MAX_SESSIONS: process.env.CODEX_MAX_SESSIONS,
    CODEX_REQUIRE_RUNNING: process.env.CODEX_REQUIRE_RUNNING,
  };

  process.env.CODEX_HOME = tmp;
  process.env.CODEX_SESSIONS_DIR = sessionsRoot;
  process.env.CODEX_ARCHIVED_SESSIONS_DIR = archivedRoot;
  process.env.CODEX_MAX_SESSIONS = '10';
  process.env.CODEX_REQUIRE_RUNNING = '0';

  try {
    const adapter = new CodexAdapter();
    const tasks = await adapter.getTasks();

    const mapped = tasks.find((t) => t.id === `codex-session-${mappedId}`);
    const fallback = tasks.find((t) => t.id === `codex-session-${fallbackId}`);

    assert.equal(mapped?.title, 'Explore repo then continue');
    assert.equal(fallback?.title, '第一条有效需求');
  } finally {
    process.env.CODEX_HOME = restore.CODEX_HOME;
    process.env.CODEX_SESSIONS_DIR = restore.CODEX_SESSIONS_DIR;
    process.env.CODEX_ARCHIVED_SESSIONS_DIR = restore.CODEX_ARCHIVED_SESSIONS_DIR;
    process.env.CODEX_MAX_SESSIONS = restore.CODEX_MAX_SESSIONS;
    process.env.CODEX_REQUIRE_RUNNING = restore.CODEX_REQUIRE_RUNNING;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('CodexAdapter scopes sessions to active workspace roots when available', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'vibe-codex-workspace-filter-'));
  const sessionsRoot = path.join(tmp, 'sessions');
  const archivedRoot = path.join(tmp, 'archived_sessions');
  const inRootId = '66666666-6666-6666-6666-666666666666';
  const outRootId = '77777777-7777-7777-7777-777777777777';

  writeSession({
    filePath: path.join(
      sessionsRoot,
      '2026/02/22/rollout-2026-02-22T09-00-00-66666666-6666-6666-6666-666666666666.jsonl'
    ),
    id: inRootId,
    cwd: '/Users/alex/Code/vibe-board',
    startedAt: '2026-02-22T09:00:00.000Z',
    lastAt: '2026-02-22T09:05:00.000Z',
    prompts: ['vibe board task'],
  });

  writeSession({
    filePath: path.join(
      sessionsRoot,
      '2026/02/22/rollout-2026-02-22T10-00-00-77777777-7777-7777-7777-777777777777.jsonl'
    ),
    id: outRootId,
    cwd: '/Users/alex/Code/nest-core',
    startedAt: '2026-02-22T10:00:00.000Z',
    lastAt: '2026-02-22T10:05:00.000Z',
    prompts: ['other repo task'],
  });

  writeFileSync(
    path.join(tmp, '.codex-global-state.json'),
    JSON.stringify({
      'active-workspace-roots': ['/Users/alex/Code/vibe-board'],
    }),
    'utf8'
  );

  const restore = {
    CODEX_HOME: process.env.CODEX_HOME,
    CODEX_SESSIONS_DIR: process.env.CODEX_SESSIONS_DIR,
    CODEX_ARCHIVED_SESSIONS_DIR: process.env.CODEX_ARCHIVED_SESSIONS_DIR,
    CODEX_MAX_SESSIONS: process.env.CODEX_MAX_SESSIONS,
    CODEX_REQUIRE_RUNNING: process.env.CODEX_REQUIRE_RUNNING,
  };

  process.env.CODEX_HOME = tmp;
  process.env.CODEX_SESSIONS_DIR = sessionsRoot;
  process.env.CODEX_ARCHIVED_SESSIONS_DIR = archivedRoot;
  process.env.CODEX_MAX_SESSIONS = '10';
  process.env.CODEX_REQUIRE_RUNNING = '0';

  try {
    const adapter = new CodexAdapter();
    const tasks = await adapter.getTasks();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.id, `codex-session-${inRootId}`);
  } finally {
    process.env.CODEX_HOME = restore.CODEX_HOME;
    process.env.CODEX_SESSIONS_DIR = restore.CODEX_SESSIONS_DIR;
    process.env.CODEX_ARCHIVED_SESSIONS_DIR = restore.CODEX_ARCHIVED_SESSIONS_DIR;
    process.env.CODEX_MAX_SESSIONS = restore.CODEX_MAX_SESSIONS;
    process.env.CODEX_REQUIRE_RUNNING = restore.CODEX_REQUIRE_RUNNING;
    rmSync(tmp, { recursive: true, force: true });
  }
});
