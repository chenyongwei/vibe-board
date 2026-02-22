import { Task } from '../types';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';

export interface ReportBatchInput {
  tasks: Task[];
  endpoint: string;
  machineId: string;
  machineName?: string;
  machineFingerprint?: string;
  queuePath?: string;
  maxQueueSize?: number;
}

interface ReportPayload {
  machine_id: string;
  machine_name: string;
  machine_fingerprint?: string;
  timestamp: string;
  tasks: Task[];
}

interface QueuedReport {
  payload: ReportPayload;
  attempts: number;
  next_attempt_at: string;
  created_at: string;
  last_error?: string;
}

export interface FlushQueueInput {
  endpoint: string;
  queuePath: string;
  maxItems?: number;
}

export interface FlushQueueResult {
  sent: number;
  remaining: number;
}

export async function reportBatch(input: ReportBatchInput): Promise<void> {
  const { tasks, endpoint, machineId, machineName, machineFingerprint, queuePath, maxQueueSize } = input;
  const payload = {
    machine_id: machineId,
    machine_name: machineName || machineId,
    machine_fingerprint: machineFingerprint || machineId,
    timestamp: new Date().toISOString(),
    tasks: tasks || [],
  };
  try {
    await sendPayload(endpoint, payload);
  } catch (e) {
    console.error('Batch report failed:', e);
    if (!queuePath) return;
    enqueueReport(queuePath, payload, e, maxQueueSize);
  }
}

export async function flushQueuedReports(input: FlushQueueInput): Promise<FlushQueueResult> {
  const maxItems = input.maxItems && input.maxItems > 0 ? input.maxItems : 20;
  const queue = loadQueue(input.queuePath);
  if (queue.length === 0) return { sent: 0, remaining: 0 };

  const nowMs = Date.now();
  let sent = 0;
  const nextQueue: QueuedReport[] = [];

  for (const item of queue) {
    const dueMs = Date.parse(item.next_attempt_at);
    const isDue = !Number.isNaN(dueMs) && dueMs <= nowMs;
    if (!isDue || sent >= maxItems) {
      nextQueue.push(item);
      continue;
    }

    try {
      await sendPayload(input.endpoint, item.payload);
      sent += 1;
    } catch (e) {
      const attempts = (item.attempts || 0) + 1;
      nextQueue.push({
        ...item,
        attempts,
        next_attempt_at: new Date(Date.now() + computeBackoffMs(attempts)).toISOString(),
        last_error: errorToMessage(e),
      });
    }
  }

  saveQueue(input.queuePath, nextQueue);
  return { sent, remaining: nextQueue.length };
}

async function sendPayload(endpoint: string, payload: ReportPayload): Promise<void> {
  const fetchFn: any = (globalThis as any).fetch;
  if (typeof fetchFn !== 'function') {
    throw new Error('Fetch API is not available in this environment.');
  }
  const res = await fetchFn(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Report failed with status ${res.status}`);
  }
}

function enqueueReport(
  queuePath: string,
  payload: ReportPayload,
  err: unknown,
  maxQueueSize?: number
): void {
  const queue = loadQueue(queuePath);
  const attempts = 1;
  queue.push({
    payload,
    attempts,
    next_attempt_at: new Date(Date.now() + computeBackoffMs(attempts)).toISOString(),
    created_at: new Date().toISOString(),
    last_error: errorToMessage(err),
  });
  const limit = maxQueueSize && maxQueueSize > 0 ? maxQueueSize : 500;
  if (queue.length > limit) {
    queue.splice(0, queue.length - limit);
  }
  saveQueue(queuePath, queue);
}

function ensureParentDir(filePath: string): void {
  const parent = dirname(filePath);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
}

function loadQueue(queuePath: string): QueuedReport[] {
  ensureParentDir(queuePath);
  if (!existsSync(queuePath)) return [];
  try {
    const raw = readFileSync(queuePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as QueuedReport[];
  } catch {
    return [];
  }
}

function saveQueue(queuePath: string, queue: QueuedReport[]): void {
  ensureParentDir(queuePath);
  writeFileSync(queuePath, JSON.stringify(queue, null, 2), 'utf8');
}

function computeBackoffMs(attempts: number): number {
  const safeAttempts = attempts > 0 ? attempts : 1;
  const ms = 5000 * Math.pow(2, safeAttempts - 1);
  return Math.min(ms, 5 * 60 * 1000);
}

function errorToMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
