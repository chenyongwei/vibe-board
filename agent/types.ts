export type AdapterStatus = 'online' | 'offline' | 'unknown';

export interface AdapterInfo {
  id: string; // tool id, e.g. 'opencode'
  name: string; // human readable name
  version?: string;
  path?: string; // executable path
  status: AdapterStatus;
  adapter: string; // implementation name, e.g. 'OpenCodeAdapter'
  last_discovered: string; // ISO timestamp
  capabilities: string[]; // e.g. ['export-json']
}

export interface Task {
  id: string;
  title: string;
  status: string; // central status: in_progress / awaiting_verification / verified / etc
  updated_at: string;
  created_at?: string;
  source: string; // tool name, e.g. 'OpenCode'
  metadata?: any;
}

export interface Adapter {
  name: string;
  version?: string;
  discover(): Promise<AdapterInfo>;
  getTasks(): Promise<Task[]>;
  normalizeTask(raw: any): Task;
}
