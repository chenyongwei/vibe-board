import { Adapter } from './Adapter';
import { AdapterInfo, Task } from '../types';
import { fileExistsSync, isAnyProcessRunning, runCommand } from '../utils';
import { readFileSync, readdirSync, statSync } from 'fs';
import os from 'os';
import path from 'path';

interface CodexSessionRecord {
  id: string;
  cwd?: string;
  startedAt: string;
  lastActivityAt: string;
  taskStartedAt?: string;
  taskCompletedAt?: string;
  title: string;
  previewImages: string[];
  archived: boolean;
  sourceFile: string;
}

interface CollectOptions {
  sessionsRoot: string;
  archivedSessionsRoot: string;
  maxTasks: number;
  threadTitles?: Record<string, string>;
  activeWorkspaceRoots?: string[];
}

interface CodexGlobalStateInfo {
  threadTitles: Record<string, string>;
  activeWorkspaceRoots: string[];
}

const MAX_PREVIEW_IMAGES = 3;
const MAX_IMAGE_URL_LENGTH = 2 * 1024 * 1024;

export class CodexAdapter implements Adapter {
  name = 'Codex';
  version?: string;
  path = process.env.CODEX_CLI_PATH || '/usr/local/bin/codex';
  private codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  private sessionsRoot = process.env.CODEX_SESSIONS_DIR || path.join(this.codexHome, 'sessions');
  private archivedSessionsRoot =
    process.env.CODEX_ARCHIVED_SESSIONS_DIR || path.join(this.codexHome, 'archived_sessions');
  private activeWindowMinutes = parsePositiveInt(process.env.CODEX_ACTIVE_WINDOW_MINUTES, 30);
  private maxTasks = parsePositiveInt(process.env.CODEX_MAX_SESSIONS, 50);
  private requireProcessRunning = String(process.env.CODEX_REQUIRE_RUNNING || '1') !== '0';
  private limitToActiveWorkspace = parseBooleanFlag(process.env.CODEX_LIMIT_TO_ACTIVE_WORKSPACE, false);

  async discover(): Promise<AdapterInfo> {
    let online = false;
    let version: string | undefined;
    try {
      if (!fileExistsSync(this.path)) {
        const whichOut = await runCommand('which codex');
        if (whichOut.stdout?.trim()) {
          this.path = whichOut.stdout.trim();
        }
      }
      const ver = await runCommand(`"${this.path}" --version`);
      version = ver.stdout?.toString().trim();
      online = fileExistsSync(this.sessionsRoot) || !!version;
    } catch {
      online = fileExistsSync(this.sessionsRoot);
    }
    if (this.requireProcessRunning) {
      online = await this.isRuntimeRunning();
    }
    return {
      id: 'codex',
      name: 'Codex Code',
      version,
      path: this.path,
      status: online ? 'online' : 'offline',
      adapter: 'CodexAdapter',
      last_discovered: new Date().toISOString(),
      capabilities: ['local-session-jsonl', 'activity-monitoring']
    } as AdapterInfo;
  }

  async getTasks(): Promise<Task[]> {
    if (this.requireProcessRunning) {
      const runtimeActive = await this.isRuntimeRunning();
      if (!runtimeActive) return [];
    }

    const globalState = loadCodexGlobalState(this.codexHome);
    const rows = collectCodexSessionRecords({
      sessionsRoot: this.sessionsRoot,
      archivedSessionsRoot: this.archivedSessionsRoot,
      maxTasks: this.maxTasks,
      threadTitles: globalState.threadTitles,
      activeWorkspaceRoots: this.limitToActiveWorkspace ? globalState.activeWorkspaceRoots : [],
    });
    return rows.map((r) => this.normalizeTask(r));
  }

  normalizeTask(raw: any): Task {
    const updatedAt = raw.lastActivityAt || raw.updated_at || new Date().toISOString();
    const createdAt = raw.startedAt || raw.created_at || updatedAt;
    const previewImages = normalizePreviewImages(raw.previewImages || raw.preview_images);
    return {
      id: `codex-session-${raw.id || raw.taskId || 'unknown'}`,
      title: raw.title || raw.name || 'Codex Session',
      status: mapStatus(raw.status || inferStatus(raw, this.activeWindowMinutes)),
      updated_at: updatedAt,
      created_at: createdAt,
      source: 'Codex',
      metadata: {
        session_id: raw.id,
        cwd: raw.cwd,
        archived: !!raw.archived,
        source_file: raw.sourceFile,
        task_started_at: raw.taskStartedAt || undefined,
        task_completed_at: raw.taskCompletedAt || undefined,
        preview_images: previewImages,
      }
    };
  }

  private async isRuntimeRunning(): Promise<boolean> {
    const processTokens = ['codex', path.basename(this.path || 'codex')];
    return isAnyProcessRunning(processTokens);
  }
}

function mapStatus(s: string): string {
  const m: Record<string, string> = {
    running: 'in_progress',
    active: 'in_progress',
    done: 'verified',
    completed: 'verified',
    completed_pending_verification: 'awaiting_verification',
    archived: 'verified',
  };
  return m[s] || s;
}

function inferStatus(raw: any, activeWindowMinutes: number): string {
  if (raw?.archived) return 'verified';
  const startedAt = Date.parse(raw?.taskStartedAt || raw?.task_started_at || '');
  const completedAt = Date.parse(raw?.taskCompletedAt || raw?.task_completed_at || '');
  if (!Number.isNaN(startedAt) && (Number.isNaN(completedAt) || startedAt > completedAt)) {
    return 'in_progress';
  }
  if (!Number.isNaN(completedAt)) {
    return 'awaiting_verification';
  }
  const updated = Date.parse(raw?.lastActivityAt || raw?.updated_at || '');
  if (!Number.isNaN(updated)) {
    const diffMs = Date.now() - updated;
    if (diffMs <= activeWindowMinutes * 60 * 1000) return 'in_progress';
  }
  return 'awaiting_verification';
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = parseInt(String(value || ''), 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return fallback;
}

function parseBooleanFlag(value: string | undefined, fallback: boolean): boolean {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
  return fallback;
}

export function collectCodexSessionRecords(options: CollectOptions): CodexSessionRecord[] {
  const sessionFiles = [
    ...walkJsonlFiles(options.sessionsRoot),
    ...walkJsonlFiles(options.archivedSessionsRoot),
  ];
  const threadTitles = options.threadTitles || {};
  const parsed = sessionFiles
    .map((filePath) => parseSessionFile(filePath, options.archivedSessionsRoot, threadTitles))
    .filter((row): row is CodexSessionRecord => !!row);
  const activeWorkspaceRoots = normalizeWorkspaceRoots(options.activeWorkspaceRoots);
  const scoped = activeWorkspaceRoots.length > 0
    ? parsed.filter((row) => isSessionInWorkspace(row, activeWorkspaceRoots))
    : parsed;

  scoped.sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));
  const deduped = dedupeById(scoped);
  return deduped.slice(0, options.maxTasks);
}

function dedupeById(records: CodexSessionRecord[]): CodexSessionRecord[] {
  const keyed = new Map<string, CodexSessionRecord>();
  for (const record of records) {
    const existing = keyed.get(record.id);
    if (!existing) {
      keyed.set(record.id, record);
      continue;
    }
    const existingTs = Date.parse(existing.lastActivityAt);
    const currentTs = Date.parse(record.lastActivityAt);
    if (Number.isNaN(existingTs) || currentTs > existingTs) {
      keyed.set(record.id, record);
    }
  }
  return Array.from(keyed.values());
}

function parseSessionFile(
  filePath: string,
  archivedRoot: string,
  threadTitles: Record<string, string>
): CodexSessionRecord | null {
  let text = '';
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  if (!text.trim()) return null;

  const lines = text.split('\n');
  let id = '';
  let cwd = '';
  let startedAt = '';
  let lastActivityAt = '';
  let taskStartedAt = '';
  let taskCompletedAt = '';
  const userPrompts: Array<{ title: string; images: string[] }> = [];
  let lastPromptImages: string[] = [];

  for (const line of lines) {
    if (!line) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.timestamp) {
      lastActivityAt = entry.timestamp;
    }
    if (entry.type === 'session_meta') {
      id = entry.payload?.id || id;
      cwd = entry.payload?.cwd || cwd;
      startedAt = entry.payload?.timestamp || startedAt;
    }
    if (entry.type === 'event_msg') {
      const eventType = String(entry.payload?.type || '').trim();
      if (eventType === 'task_started' && entry.timestamp) {
        taskStartedAt = entry.timestamp;
      }
      if (eventType === 'task_complete' && entry.timestamp) {
        taskCompletedAt = entry.timestamp;
      }
    }
    if (entry.type === 'response_item' && entry.payload?.type === 'message' && entry.payload?.role === 'user') {
      const extracted = extractUserMessage(entry.payload?.content);
      if (extracted.images.length > 0) {
        lastPromptImages = extracted.images;
      }
      const textContent = extracted.text;
      const candidate = normalizeTitle(textContent);
      if (candidate) userPrompts.push({ title: candidate, images: extracted.images });
    }
  }

  if (!id) {
    id = extractIdFromFilename(filePath);
  }
  if (!id) return null;
  let fsStat;
  try {
    fsStat = statSync(filePath);
  } catch {
    return null;
  }
  const archived = filePath.startsWith(path.resolve(archivedRoot));
  const started = startedAt || fsStat.birthtime.toISOString();
  const updated = lastActivityAt || fsStat.mtime.toISOString();
  const persistedTitle = normalizePersistedTitle(threadTitles[id]);
  const selectedPrompt = choosePrompt(userPrompts);
  const title = persistedTitle || selectedPrompt?.title || `Codex Session ${id.slice(0, 8)}`;
  const previewImages = normalizePreviewImages(
    selectedPrompt?.images?.length ? selectedPrompt.images : lastPromptImages
  );

  return {
    id,
    cwd: cwd || undefined,
    startedAt: started,
    lastActivityAt: updated,
    taskStartedAt: taskStartedAt || undefined,
    taskCompletedAt: taskCompletedAt || undefined,
    title,
    previewImages,
    archived,
    sourceFile: filePath,
  };
}

function walkJsonlFiles(root: string): string[] {
  try {
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
          stack.push(full);
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          out.push(full);
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

function extractUserMessage(content: any): { text: string; images: string[] } {
  if (!Array.isArray(content)) return { text: '', images: [] };
  const parts: string[] = [];
  const images: string[] = [];
  for (const item of content) {
    const txt = item?.text;
    if (typeof txt === 'string' && txt.trim()) {
      parts.push(txt.trim());
    }
    const imageUrl = extractImageUrl(item);
    if (imageUrl) images.push(imageUrl);
  }
  return {
    text: parts.join('\n').trim(),
    images: normalizePreviewImages(images),
  };
}

function normalizeTitle(input: string): string {
  const text = input
    .replace(/<\s*\/?\s*image\s*>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (text.includes('AGENTS.md instructions')) return '';
  if (text.includes('<environment_context>')) return '';
  if (text.includes('<INSTRUCTIONS>')) return '';
  if (text.includes('<turn_aborted>')) return '';
  if (text.includes('The user interrupted the previous turn on purpose')) return '';
  if (text.length > 1800) return '';
  return text.slice(0, 120);
}

function choosePrompt(candidates: Array<{ title: string; images: string[] }>): { title: string; images: string[] } | null {
  if (!candidates.length) return null;
  return candidates[0];
}

function extractImageUrl(item: any): string {
  const rawImage = item?.image_url;
  const value =
    typeof rawImage === 'string'
      ? rawImage
      : rawImage && typeof rawImage.url === 'string'
        ? rawImage.url
        : '';
  const url = String(value || '').trim();
  if (!isSupportedImageUrl(url)) return '';
  if (url.length > MAX_IMAGE_URL_LENGTH) return '';
  return url;
}

function isSupportedImageUrl(value: string): boolean {
  if (!value) return false;
  if (/^data:image\/[a-zA-Z0-9.+-]+;base64,/i.test(value)) return true;
  if (/^https?:\/\//i.test(value)) return true;
  return false;
}

function normalizePreviewImages(input: any): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const value = String(item || '').trim();
    if (!value) continue;
    if (!isSupportedImageUrl(value)) continue;
    if (value.length > MAX_IMAGE_URL_LENGTH) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= MAX_PREVIEW_IMAGES) break;
  }
  return out;
}

function extractIdFromFilename(filePath: string): string {
  const base = path.basename(filePath, '.jsonl');
  const match = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return match ? match[1] : '';
}

function normalizePersistedTitle(input: unknown): string {
  if (typeof input !== 'string') return '';
  const text = input
    .replace(/<\s*\/?\s*image\s*>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.slice(0, 120);
}

function normalizeWorkspaceRoots(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const raw = String(item || '').trim();
    if (!raw) continue;
    const normalized = path.resolve(raw).replace(/[\\/]+$/, '').toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function isSessionInWorkspace(record: CodexSessionRecord, roots: string[]): boolean {
  if (!roots.length) return true;
  const cwd = String(record?.cwd || '').trim();
  if (!cwd) return false;
  const normalizedCwd = path.resolve(cwd).replace(/[\\/]+$/, '').toLowerCase();
  if (!normalizedCwd) return false;
  return roots.some((root) => normalizedCwd === root || normalizedCwd.startsWith(`${root}${path.sep}`));
}

function loadCodexGlobalState(codexHome: string): CodexGlobalStateInfo {
  const statePath = path.join(codexHome, '.codex-global-state.json');
  let text = '';
  try {
    text = readFileSync(statePath, 'utf8');
  } catch {
    return { threadTitles: {}, activeWorkspaceRoots: [] };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { threadTitles: {}, activeWorkspaceRoots: [] };
  }

  const rawTitles = parsed?.['thread-titles']?.titles;
  const titles: Record<string, string> = {};
  if (rawTitles && typeof rawTitles === 'object') {
    for (const [key, value] of Object.entries(rawTitles)) {
      const normalized = normalizePersistedTitle(value);
      if (normalized) titles[key] = normalized;
    }
  }
  return {
    threadTitles: titles,
    activeWorkspaceRoots: normalizeWorkspaceRoots(parsed?.['active-workspace-roots']),
  };
}
