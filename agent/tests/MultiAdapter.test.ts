import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'fs';
import { OpenCodeAdapter } from '../adapters/OpenCodeAdapter';
import { ClaudeCodeAdapter } from '../adapters/ClaudeCodeAdapter';

function toMs(iso: string): number {
  return Date.parse(iso);
}

test('OpenCodeAdapter reads local storage sessions without CLI and maps vibe statuses', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'vibe-opencode-adapter-'));
  const storageRoot = path.join(tmp, 'storage');
  const sessionRoot = path.join(storageRoot, 'session', 'global');
  mkdirSync(sessionRoot, { recursive: true });

  const recentCreated = '2026-02-22T14:30:00.000Z';
  const recentUpdated = '2026-02-22T14:50:00.000Z';
  const staleCreated = '2026-02-21T18:00:00.000Z';
  const staleUpdated = '2026-02-22T12:00:00.000Z';

  writeFileSync(
    path.join(sessionRoot, 'ses_recent.json'),
    JSON.stringify(
      {
        id: 'ses_recent',
        projectID: 'global',
        directory: '/Users/alex/Code/vibe-board',
        title: 'OpenCode 本地任务追踪',
        time: {
          created: toMs(recentCreated),
          updated: toMs(recentUpdated),
        },
      },
      null,
      2
    ),
    'utf8'
  );

  writeFileSync(
    path.join(sessionRoot, 'ses_stale.json'),
    JSON.stringify(
      {
        id: 'ses_stale',
        projectID: 'global',
        directory: '/Users/alex/Code/nest-core',
        title: 'OpenCode 历史任务',
        time: {
          created: toMs(staleCreated),
          updated: toMs(staleUpdated),
        },
      },
      null,
      2
    ),
    'utf8'
  );

  const restore = {
    OPENCODE_CLI_PATH: process.env.OPENCODE_CLI_PATH,
    OPENCODE_STORAGE_DIR: process.env.OPENCODE_STORAGE_DIR,
    OPENCODE_ACTIVE_WINDOW_MINUTES: process.env.OPENCODE_ACTIVE_WINDOW_MINUTES,
    OPENCODE_MAX_SESSIONS: process.env.OPENCODE_MAX_SESSIONS,
    PATH: process.env.PATH,
  };

  process.env.OPENCODE_CLI_PATH = path.join(tmp, 'missing-opencode-bin');
  process.env.OPENCODE_STORAGE_DIR = storageRoot;
  process.env.OPENCODE_ACTIVE_WINDOW_MINUTES = '30';
  process.env.OPENCODE_MAX_SESSIONS = '10';
  process.env.PATH = '/usr/bin:/bin';

  const now = new Date('2026-02-22T15:00:00.000Z');
  const realNow = Date.now;
  Date.now = () => now.getTime();

  try {
    const adapter = new OpenCodeAdapter();
    const discovery = await adapter.discover();
    assert.equal(discovery.status, 'online');

    const tasks = await adapter.getTasks();
    assert.equal(tasks.length, 2);

    const byId = new Map(tasks.map((t) => [t.id, t]));
    const recent = byId.get('opencode-session-ses_recent');
    const stale = byId.get('opencode-session-ses_stale');

    assert.ok(recent);
    assert.ok(stale);

    assert.equal(recent?.status, 'in_progress');
    assert.equal(recent?.title, 'OpenCode 本地任务追踪');
    assert.equal(recent?.created_at, recentCreated);
    assert.equal(recent?.updated_at, recentUpdated);
    assert.equal(recent?.metadata?.project_id, 'global');
    assert.equal(recent?.metadata?.directory, '/Users/alex/Code/vibe-board');

    assert.equal(stale?.status, 'awaiting_verification');
    assert.equal(stale?.title, 'OpenCode 历史任务');
    assert.equal(stale?.created_at, staleCreated);
    assert.equal(stale?.updated_at, staleUpdated);
  } finally {
    Date.now = realNow;
    process.env.OPENCODE_CLI_PATH = restore.OPENCODE_CLI_PATH;
    process.env.OPENCODE_STORAGE_DIR = restore.OPENCODE_STORAGE_DIR;
    process.env.OPENCODE_ACTIVE_WINDOW_MINUTES = restore.OPENCODE_ACTIVE_WINDOW_MINUTES;
    process.env.OPENCODE_MAX_SESSIONS = restore.OPENCODE_MAX_SESSIONS;
    process.env.PATH = restore.PATH;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('ClaudeCodeAdapter reads local jsonl sessions without CLI and maps vibe statuses', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'vibe-claude-adapter-'));
  const sessionsRoot = path.join(tmp, 'projects');
  const projectDir = path.join(sessionsRoot, '-Users-alex-Code-vibe-board');

  const recentSessionId = '11111111-2222-3333-4444-555555555555';
  const staleSessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  mkdirSync(projectDir, { recursive: true });
  const subagentsDir = path.join(projectDir, recentSessionId, 'subagents');
  mkdirSync(subagentsDir, { recursive: true });
  const recentFile = path.join(projectDir, `${recentSessionId}.jsonl`);
  const staleFile = path.join(projectDir, `${staleSessionId}.jsonl`);
  const subagentFile = path.join(subagentsDir, 'agent-a1b2c3d.jsonl');

  writeFileSync(
    recentFile,
    [
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        timestamp: '2026-02-22T14:40:00.000Z',
        sessionId: recentSessionId,
        content: 'ignored queue text',
      }),
      JSON.stringify({
        type: 'user',
        timestamp: '2026-02-22T14:41:00.000Z',
        sessionId: recentSessionId,
        cwd: '/Users/alex/Code/vibe-board',
        message: {
          role: 'user',
          content: '支持 Claude Code 本地任务上报',
        },
      }),
      '',
    ].join('\n'),
    'utf8'
  );

  writeFileSync(
    staleFile,
    [
      JSON.stringify({
        type: 'user',
        timestamp: '2026-02-22T11:00:00.000Z',
        sessionId: staleSessionId,
        cwd: '/Users/alex/Code/nest-core',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '<environment_context>\n  <cwd>/Users/alex/Code/nest-core</cwd>\n</environment_context>' },
            { type: 'text', text: '支持 Claude Code 会话监控' },
          ],
        },
      }),
      '',
    ].join('\n'),
    'utf8'
  );

  writeFileSync(
    subagentFile,
    [
      JSON.stringify({
        type: 'user',
        timestamp: '2026-02-22T14:59:00.000Z',
        sessionId: recentSessionId,
        cwd: '/Users/alex/Code/vibe-board/subagent',
        message: {
          role: 'user',
          content: '这是一条 subagent 日志，不应作为独立 session 展示',
        },
      }),
      '',
    ].join('\n'),
    'utf8'
  );

  const recentMtime = new Date('2026-02-22T14:55:00.000Z');
  const staleMtime = new Date('2026-02-22T12:00:00.000Z');
  const subagentMtime = new Date('2026-02-22T14:59:00.000Z');
  utimesSync(recentFile, recentMtime, recentMtime);
  utimesSync(staleFile, staleMtime, staleMtime);
  utimesSync(subagentFile, subagentMtime, subagentMtime);

  const restore = {
    CLAUDE_CODE_CLI_PATH: process.env.CLAUDE_CODE_CLI_PATH,
    CLAUDE_CODE_SESSIONS_DIR: process.env.CLAUDE_CODE_SESSIONS_DIR,
    CLAUDE_CODE_ACTIVE_WINDOW_MINUTES: process.env.CLAUDE_CODE_ACTIVE_WINDOW_MINUTES,
    CLAUDE_CODE_MAX_SESSIONS: process.env.CLAUDE_CODE_MAX_SESSIONS,
  };

  process.env.CLAUDE_CODE_CLI_PATH = path.join(tmp, 'missing-claude-code-bin');
  process.env.CLAUDE_CODE_SESSIONS_DIR = sessionsRoot;
  process.env.CLAUDE_CODE_ACTIVE_WINDOW_MINUTES = '30';
  process.env.CLAUDE_CODE_MAX_SESSIONS = '10';

  const now = new Date('2026-02-22T15:00:00.000Z');
  const realNow = Date.now;
  Date.now = () => now.getTime();

  try {
    const adapter = new ClaudeCodeAdapter();
    const discovery = await adapter.discover();
    assert.equal(discovery.status, 'online');

    const tasks = await adapter.getTasks();
    assert.equal(tasks.length, 2);

    const byId = new Map(tasks.map((t) => [t.id, t]));
    const recent = byId.get(`claude-session-${recentSessionId}`);
    const stale = byId.get(`claude-session-${staleSessionId}`);

    assert.ok(recent);
    assert.ok(stale);

    assert.equal(recent?.status, 'in_progress');
    assert.equal(recent?.title, '支持 Claude Code 本地任务上报');
    assert.equal(recent?.metadata?.cwd, '/Users/alex/Code/vibe-board');

    assert.equal(stale?.status, 'awaiting_verification');
    assert.equal(stale?.title, '支持 Claude Code 会话监控');
    assert.equal(stale?.metadata?.cwd, '/Users/alex/Code/nest-core');
  } finally {
    Date.now = realNow;
    process.env.CLAUDE_CODE_CLI_PATH = restore.CLAUDE_CODE_CLI_PATH;
    process.env.CLAUDE_CODE_SESSIONS_DIR = restore.CLAUDE_CODE_SESSIONS_DIR;
    process.env.CLAUDE_CODE_ACTIVE_WINDOW_MINUTES = restore.CLAUDE_CODE_ACTIVE_WINDOW_MINUTES;
    process.env.CLAUDE_CODE_MAX_SESSIONS = restore.CLAUDE_CODE_MAX_SESSIONS;
    rmSync(tmp, { recursive: true, force: true });
  }
});
