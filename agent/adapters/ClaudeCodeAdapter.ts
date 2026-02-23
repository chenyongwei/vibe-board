import { Adapter } from './Adapter';
import { AdapterInfo, Task } from '../types';
import { fileExistsSync, isAnyProcessRunning, runCommand } from '../utils';
import { closeSync, openSync, readSync, readdirSync, statSync } from 'fs';
import os from 'os';
import path from 'path';

interface ClaudeSessionRecord {
  id: string;
  title: string;
  cwd?: string;
  startedAt: string;
  lastActivityAt: string;
  archived: boolean;
  sourceFile: string;
}

interface CollectOptions {
  sessionsRoot: string;
  maxSessions: number;
}

const READ_HEAD_BYTES = 512 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ClaudeCodeAdapter implements Adapter {
  name = 'ClaudeCode';
  version?: string;
  path = process.env.CLAUDE_CODE_CLI_PATH || '/usr/local/bin/claude-code';
  private sessionsRoot = process.env.CLAUDE_CODE_SESSIONS_DIR || path.join(os.homedir(), '.claude', 'projects');
  private activeWindowMinutes = parsePositiveInt(process.env.CLAUDE_CODE_ACTIVE_WINDOW_MINUTES, 30);
  private maxSessions = parsePositiveInt(process.env.CLAUDE_CODE_MAX_SESSIONS, 50);
  private requireProcessRunning = String(process.env.CLAUDE_CODE_REQUIRE_RUNNING || '1') !== '0';

  async discover(): Promise<AdapterInfo> {
    let version: string | undefined;

    try {
      await this.resolveCliPath();
      if (fileExistsSync(this.path)) {
        const ver = await runCommand(`"${this.path}" --version`);
        version = String(ver.stdout || '').trim() || undefined;
      }
    } catch {
      // ignore, local session files may still provide availability
    }

    const hasSessions = fileExistsSync(this.sessionsRoot) && walkJsonlFiles(this.sessionsRoot).length > 0;
    const runtimeRunning = this.requireProcessRunning
      ? await this.isRuntimeRunning()
      : !!version || hasSessions;

    return {
      id: 'claude-code',
      name: 'Claude Code',
      version,
      path: this.path,
      status: runtimeRunning ? 'online' : 'offline',
      adapter: 'ClaudeCodeAdapter',
      last_discovered: new Date().toISOString(),
      capabilities: ['local-session-jsonl', 'activity-monitoring']
    } as AdapterInfo;
  }

  async getTasks(): Promise<Task[]> {
    if (this.requireProcessRunning) {
      const runtimeActive = await this.isRuntimeRunning();
      if (!runtimeActive) return [];
    }

    const records = collectClaudeSessionRecords({
      sessionsRoot: this.sessionsRoot,
      maxSessions: this.maxSessions,
    });

    return records.map((item) => this.normalizeTask(item));
  }

  normalizeTask(raw: ClaudeSessionRecord): Task {
    return {
      id: `claude-session-${raw.id || 'unknown'}`,
      title: raw.title || 'Claude Session',
      status: inferStatus(raw, this.activeWindowMinutes),
      updated_at: raw.lastActivityAt,
      created_at: raw.startedAt,
      source: 'ClaudeCode',
      metadata: {
        session_id: raw.id,
        cwd: raw.cwd,
        archived: raw.archived,
        source_file: raw.sourceFile,
      }
    };
  }

  private async resolveCliPath(): Promise<void> {
    if (fileExistsSync(this.path)) return;

    const candidates = ['claude-code', 'claude'];
    for (const bin of candidates) {
      try {
        const whichOut = await runCommand(`which ${bin}`);
        const resolved = String(whichOut.stdout || '').trim();
        if (resolved) {
          this.path = resolved;
          return;
        }
      } catch {
        // try next candidate
      }
    }
  }

  private async isRuntimeRunning(): Promise<boolean> {
    const processTokens = ['claude-code', 'claude', path.basename(this.path || 'claude-code')];
    return isAnyProcessRunning(processTokens);
  }
}

function mapStatus(status: string): string {
  const value = String(status || '').trim();
  const map: Record<string, string> = {
    running: 'in_progress',
    active: 'in_progress',
    done: 'verified',
    completed: 'verified',
    verified: 'verified',
    archived: 'verified',
    completed_pending_verification: 'awaiting_verification',
    awaiting_verification: 'awaiting_verification',
  };
  return map[value] || value;
}

function inferStatus(record: ClaudeSessionRecord, activeWindowMinutes: number): string {
  if (record.archived) return 'verified';
  const updatedMs = Date.parse(record.lastActivityAt || '');
  if (!Number.isNaN(updatedMs)) {
    const diffMs = Date.now() - updatedMs;
    if (diffMs <= activeWindowMinutes * 60 * 1000) return 'in_progress';
  }
  return 'awaiting_verification';
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = parseInt(String(value || ''), 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return fallback;
}

function collectClaudeSessionRecords(options: CollectOptions): ClaudeSessionRecord[] {
  const files = walkJsonlFiles(options.sessionsRoot)
    .map((filePath) => ({
      filePath,
      mtimeMs: safeMtimeMs(filePath),
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, Math.max(options.maxSessions * 3, options.maxSessions));

  const parsed = files
    .map((item) => parseClaudeSessionFile(item.filePath))
    .filter((row): row is ClaudeSessionRecord => !!row)
    .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));

  return dedupeById(parsed).slice(0, options.maxSessions);
}

function walkJsonlFiles(root: string): string[] {
  if (!fileExistsSync(root)) return [];
  const out: string[] = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: { name: string; isDirectory: () => boolean; isFile: () => boolean }[] = [];
    try {
      entries = readdirSync(current, { withFileTypes: true }) as any[];
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (shouldSkipClaudeSessionDir(entry.name)) continue;
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        if (shouldSkipClaudeSessionFile(full, entry.name)) continue;
        out.push(full);
      }
    }
  }

  return out;
}

function shouldSkipClaudeSessionDir(name: string): boolean {
  const value = String(name || '').trim().toLowerCase();
  if (!value) return false;
  // Claude subagents are internal worker logs, not user-visible top-level sessions.
  return value === 'subagents';
}

function shouldSkipClaudeSessionFile(filePath: string, fileName: string): boolean {
  const normalizedPath = String(filePath || '').replace(/\\/g, '/').toLowerCase();
  if (normalizedPath.includes('/subagents/')) return true;

  const base = path.basename(String(fileName || ''), '.jsonl');
  if (/^agent-[a-z0-9]+$/i.test(base)) return true;
  return false;
}

function safeMtimeMs(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function parseClaudeSessionFile(filePath: string): ClaudeSessionRecord | null {
  let st;
  try {
    st = statSync(filePath);
  } catch {
    return null;
  }

  const head = readFileHead(filePath, READ_HEAD_BYTES);
  const lines = head.split('\n');

  const sessionIdFromFilename = extractSessionIdFromFilename(filePath);
  let sessionId = isUuid(sessionIdFromFilename) ? sessionIdFromFilename : '';
  let cwd = '';
  let startedAt = '';
  let title = '';
  let queueFallbackTitle = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry: any;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const sid = String(entry?.sessionId || '').trim();
    if (sid && (!sessionId || !isUuid(sessionId))) {
      sessionId = sid;
    }

    if (!cwd) {
      const value = String(entry?.cwd || '').trim();
      if (value) cwd = value;
    }

    const timestamp = normalizeTimestamp(entry?.timestamp);
    if (timestamp && (!startedAt || Date.parse(timestamp) < Date.parse(startedAt))) {
      startedAt = timestamp;
    }

    if (!title) {
      const prompt = extractUserPrompt(entry);
      if (prompt) title = prompt;
    }

    if (!queueFallbackTitle) {
      const queuePrompt = extractQueuePrompt(entry);
      if (queuePrompt) queueFallbackTitle = queuePrompt;
    }

    if (sessionId && cwd && startedAt && title) break;
  }

  if (!sessionId) {
    sessionId = sessionIdFromFilename;
  }
  if (!sessionId) return null;

  const fallbackStartedAt = startedAt || st.birthtime.toISOString();
  const lastActivityAt = st.mtime.toISOString();
  const archived = /(?:^|\/)archive(?:d)?(?:\/|$)/i.test(filePath);

  return {
    id: sessionId,
    title: title || queueFallbackTitle || `Claude Session ${sessionId.slice(0, 8)}`,
    cwd: cwd || undefined,
    startedAt: fallbackStartedAt,
    lastActivityAt,
    archived,
    sourceFile: filePath,
  };
}

function readFileHead(filePath: string, maxBytes: number): string {
  let fd = -1;
  try {
    fd = openSync(filePath, 'r');
    const buf = Buffer.alloc(maxBytes);
    const size = readSync(fd, buf, 0, maxBytes, 0);
    return buf.toString('utf8', 0, size);
  } catch {
    return '';
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function extractUserPrompt(entry: any): string {
  if (!entry || typeof entry !== 'object') return '';

  // Claude Code user message line
  if (entry.type === 'user' && entry.message?.role === 'user') {
    const candidates = extractUserContentCandidates(entry.message.content);
    for (const candidate of candidates) {
      const normalized = normalizeTitle(candidate);
      if (normalized) return normalized;
    }
    return '';
  }
  return '';
}

function extractQueuePrompt(entry: any): string {
  if (!entry || typeof entry !== 'object') return '';
  if (entry.type !== 'queue-operation' || entry.operation !== 'enqueue') return '';
  const content = String(entry.content || '').trim();
  if (!content || content.startsWith('{')) return '';
  return normalizeTitle(content);
}

function extractUserContentCandidates(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];

  const out: string[] = [];
  for (const item of content) {
    if (typeof item === 'string') {
      out.push(item);
      continue;
    }
    if (item && typeof item === 'object' && typeof (item as any).text === 'string') {
      out.push((item as any).text);
    }
  }

  const merged = out.join('\n').trim();
  if (merged) out.push(merged);
  return out;
}

function normalizeTitle(input: unknown): string {
  const text = String(input || '')
    .replace(/<\s*\/?\s*image\s*>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) return '';
  if (text.includes('AGENTS.md instructions')) return '';
  if (text.includes('<environment_context>')) return '';
  if (text.includes('<INSTRUCTIONS>')) return '';
  if (text.includes('<turn_aborted>')) return '';
  if (text.includes('The user interrupted the previous turn on purpose')) return '';
  return text.slice(0, 120);
}

function normalizeTimestamp(value: unknown): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return '';
  return new Date(ms).toISOString();
}

function extractSessionIdFromFilename(filePath: string): string {
  const base = path.basename(filePath, '.jsonl');
  const uuid = base.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  if (uuid) return uuid[0];
  return base;
}

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(String(value || '').trim());
}

function dedupeById(records: ClaudeSessionRecord[]): ClaudeSessionRecord[] {
  const keyed = new Map<string, ClaudeSessionRecord>();
  for (const record of records) {
    const existing = keyed.get(record.id);
    if (!existing) {
      keyed.set(record.id, record);
      continue;
    }

    const existingTs = Date.parse(existing.lastActivityAt || '');
    const currentTs = Date.parse(record.lastActivityAt || '');
    if (Number.isNaN(existingTs) || (!Number.isNaN(currentTs) && currentTs > existingTs)) {
      keyed.set(record.id, record);
    }
  }
  return Array.from(keyed.values());
}
