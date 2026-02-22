import { Adapter } from './Adapter';
import { AdapterInfo, Task } from '../types';
import { runCommand, fileExistsSync } from '../utils';
import { readFileSync, readdirSync, statSync } from 'fs';
import os from 'os';
import path from 'path';

interface OpenCodeSessionRecord {
  id: string;
  title: string;
  startedAt: string;
  lastActivityAt: string;
  projectId?: string;
  directory?: string;
  archived: boolean;
  source: 'cli' | 'storage';
}

interface CollectOptions {
  storageRoot: string;
  maxSessions: number;
}

export class OpenCodeAdapter implements Adapter {
  name = 'OpenCode';
  version?: string;
  path = process.env.OPENCODE_CLI_PATH || path.join(os.homedir(), '.opencode', 'bin', 'opencode');
  private storageRoot = process.env.OPENCODE_STORAGE_DIR || path.join(os.homedir(), '.local', 'share', 'opencode', 'storage');
  private activeWindowMinutes = parsePositiveInt(process.env.OPENCODE_ACTIVE_WINDOW_MINUTES, 30);
  private maxSessions = parsePositiveInt(process.env.OPENCODE_MAX_SESSIONS, 50);

  async discover(): Promise<AdapterInfo> {
    let online = false;
    let version: string | undefined;

    try {
      await this.resolveCliPath();
      if (fileExistsSync(this.path)) {
        const verOut = await runCommand(`"${this.path}" --version`);
        version = String(verOut.stdout || '').trim() || undefined;
      }
    } catch {
      // ignore cli errors and fallback to local storage probing
    }

    const hasSessions = hasOpenCodeSessionStorage(this.storageRoot);
    online = !!version || hasSessions;

    return {
      id: 'opencode',
      name: 'OpenCode',
      version,
      path: this.path,
      status: online ? 'online' : 'offline',
      adapter: 'OpenCodeAdapter',
      last_discovered: new Date().toISOString(),
      capabilities: ['local-session-json', 'activity-monitoring']
    } as AdapterInfo;
  }

  async getTasks(): Promise<Task[]> {
    const records = await this.collectSessions();
    return records.map((item) => this.normalizeTask(item));
  }

  normalizeTask(raw: OpenCodeSessionRecord): Task {
    return {
      id: `opencode-session-${raw.id || 'unknown'}`,
      title: raw.title || 'OpenCode Session',
      status: inferStatus(raw, this.activeWindowMinutes),
      updated_at: raw.lastActivityAt,
      created_at: raw.startedAt,
      source: 'OpenCode',
      metadata: {
        session_id: raw.id,
        project_id: raw.projectId,
        directory: raw.directory,
        archived: raw.archived,
        source: raw.source,
      }
    };
  }

  private async collectSessions(): Promise<OpenCodeSessionRecord[]> {
    await this.resolveCliPath();

    if (fileExistsSync(this.path)) {
      try {
        const out = await runCommand(`"${this.path}" session list --format json -n ${this.maxSessions}`);
        const parsed = JSON.parse(out.stdout || '[]');
        const fromCli = collectFromSessionListJson(parsed);
        if (fromCli.length > 0) {
          return dedupeById(
            fromCli.sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt))
          ).slice(0, this.maxSessions);
        }
      } catch {
        // fallback to reading local storage files
      }
    }

    const fromStorage = collectFromStorage({
      storageRoot: this.storageRoot,
      maxSessions: this.maxSessions,
    });
    return fromStorage;
  }

  private async resolveCliPath(): Promise<void> {
    if (fileExistsSync(this.path)) return;
    try {
      const whichOut = await runCommand('which opencode');
      const resolved = String(whichOut.stdout || '').trim();
      if (resolved) this.path = resolved;
    } catch {
      // leave path untouched
    }
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

function inferStatus(record: OpenCodeSessionRecord, activeWindowMinutes: number): string {
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

function toIsoFromUnixMs(value: unknown): string {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return '';
  return new Date(num).toISOString();
}

function normalizeTitle(input: unknown): string {
  const text = String(input || '')
    .replace(/<\s*\/?\s*image\s*>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.slice(0, 120);
}

function collectFromSessionListJson(input: unknown): OpenCodeSessionRecord[] {
  if (!Array.isArray(input)) return [];
  const out: OpenCodeSessionRecord[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as any;
    const id = String(raw.id || '').trim();
    if (!id) continue;

    const title = normalizeTitle(raw.title) || `OpenCode Session ${id.slice(0, 12)}`;
    const startedAt = toIsoFromUnixMs(raw.created) || new Date().toISOString();
    const lastActivityAt = toIsoFromUnixMs(raw.updated) || startedAt;
    const status = mapStatus(String(raw.status || ''));

    out.push({
      id,
      title,
      startedAt,
      lastActivityAt,
      projectId: String(raw.projectId || '').trim() || undefined,
      directory: String(raw.directory || '').trim() || undefined,
      archived: status === 'verified',
      source: 'cli',
    });
  }
  return out;
}

function hasOpenCodeSessionStorage(storageRoot: string): boolean {
  try {
    const sessionRoot = path.join(storageRoot, 'session');
    if (!fileExistsSync(sessionRoot)) return false;
    const firstLevel = readdirSync(sessionRoot, { withFileTypes: true });
    for (const entry of firstLevel) {
      if (!entry.isDirectory()) continue;
      const full = path.join(sessionRoot, entry.name);
      const children = readdirSync(full, { withFileTypes: true });
      if (children.some((child) => child.isFile() && child.name.endsWith('.json'))) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function collectFromStorage(options: CollectOptions): OpenCodeSessionRecord[] {
  const sessionFiles = walkOpenCodeSessionFiles(options.storageRoot);
  const parsed = sessionFiles
    .map((filePath) => parseOpenCodeSessionFile(filePath))
    .filter((row): row is OpenCodeSessionRecord => !!row)
    .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));

  return dedupeById(parsed).slice(0, options.maxSessions);
}

function walkOpenCodeSessionFiles(storageRoot: string): string[] {
  const root = path.join(storageRoot, 'session');
  if (!fileExistsSync(root)) return [];

  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: { name: string; isFile: () => boolean; isDirectory: () => boolean }[] = [];
    try {
      entries = readdirSync(current, { withFileTypes: true }) as any[];
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        out.push(full);
      }
    }
  }
  return out;
}

function parseOpenCodeSessionFile(filePath: string): OpenCodeSessionRecord | null {
  let text = '';
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  const id = String(parsed?.id || '').trim();
  if (!id) return null;

  const createdAt = toIsoFromUnixMs(parsed?.time?.created);
  const updatedAt = toIsoFromUnixMs(parsed?.time?.updated);
  let startedAt = createdAt;
  let lastActivityAt = updatedAt;

  try {
    const st = statSync(filePath);
    if (!startedAt) startedAt = st.birthtime.toISOString();
    if (!lastActivityAt) lastActivityAt = st.mtime.toISOString();
  } catch {
    const now = new Date().toISOString();
    if (!startedAt) startedAt = now;
    if (!lastActivityAt) lastActivityAt = now;
  }

  const title = normalizeTitle(parsed?.title) || `OpenCode Session ${id.slice(0, 12)}`;
  const archived = /(?:^|\/)archive(?:d)?(?:\/|$)/i.test(filePath);

  return {
    id,
    title,
    startedAt,
    lastActivityAt,
    projectId: String(parsed?.projectID || '').trim() || undefined,
    directory: String(parsed?.directory || '').trim() || undefined,
    archived,
    source: 'storage',
  };
}

function dedupeById(records: OpenCodeSessionRecord[]): OpenCodeSessionRecord[] {
  const keyed = new Map<string, OpenCodeSessionRecord>();
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
