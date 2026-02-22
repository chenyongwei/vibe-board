import { existsSync, readFileSync } from 'fs';
import path from 'path';

const DEFAULT_REPORT_ENDPOINT = 'http://localhost:61100/api/report';

export interface RuntimeConfig {
  configPath?: string;
  reportEndpoint: string;
  reportIntervalSeconds: number;
  machineId?: string;
  machineName?: string;
  machineFingerprint?: string;
}

interface ConfigFileShape {
  report_endpoint?: unknown;
  reportEndpoint?: unknown;
  report_interval_seconds?: unknown;
  reportIntervalSeconds?: unknown;
  machine_id?: unknown;
  machineId?: unknown;
  machine_name?: unknown;
  machineName?: unknown;
  machine_fingerprint?: unknown;
  machineFingerprint?: unknown;
  env?: Record<string, unknown>;
}

interface ParsedArgs {
  configPath?: string;
}

export function loadRuntimeConfig(argv: string[] = process.argv.slice(2)): RuntimeConfig {
  const parsedArgs = parseArgs(argv);
  const loaded = loadConfigFile(parsedArgs.configPath);
  if (loaded.values?.env && typeof loaded.values.env === 'object') {
    applyConfigEnv(loaded.values.env);
  }

  const reportEndpoint =
    normalizeString(process.env.REPORT_ENDPOINT) ||
    normalizeString(loaded.values?.report_endpoint) ||
    normalizeString(loaded.values?.reportEndpoint) ||
    DEFAULT_REPORT_ENDPOINT;

  const reportIntervalSeconds =
    parseIntegerLike(process.env.REPORT_INTERVAL_SECONDS) ??
    parseIntegerLike(loaded.values?.report_interval_seconds) ??
    parseIntegerLike(loaded.values?.reportIntervalSeconds) ??
    0;

  const machineId =
    normalizeString(process.env.MACHINE_ID) ||
    normalizeString(loaded.values?.machine_id) ||
    normalizeString(loaded.values?.machineId) ||
    undefined;

  const machineName =
    normalizeString(process.env.MACHINE_NAME) ||
    normalizeString(loaded.values?.machine_name) ||
    normalizeString(loaded.values?.machineName) ||
    undefined;

  const machineFingerprint =
    normalizeString(process.env.MACHINE_FINGERPRINT) ||
    normalizeString(loaded.values?.machine_fingerprint) ||
    normalizeString(loaded.values?.machineFingerprint) ||
    undefined;

  return {
    configPath: loaded.path,
    reportEndpoint,
    reportIntervalSeconds: reportIntervalSeconds > 0 ? reportIntervalSeconds : 0,
    machineId,
    machineName,
    machineFingerprint,
  };
}

function parseArgs(argv: string[]): ParsedArgs {
  let configPath = '';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || '').trim();
    if (!arg) continue;
    if (arg === '--config' || arg === '-c') {
      const next = String(argv[i + 1] || '').trim();
      if (next) {
        configPath = next;
        i += 1;
      }
      continue;
    }
    if (arg.startsWith('--config=')) {
      configPath = arg.slice('--config='.length).trim();
      continue;
    }
    if (arg.startsWith('-c=')) {
      configPath = arg.slice('-c='.length).trim();
      continue;
    }
  }
  return {
    configPath: configPath || undefined,
  };
}

function loadConfigFile(cliConfigPath?: string): { path?: string; values?: ConfigFileShape } {
  const explicitCliPath = normalizeString(cliConfigPath);
  if (explicitCliPath) {
    const resolved = resolveConfigPath(explicitCliPath);
    if (!existsSync(resolved)) {
      throw new Error(`Config file not found: ${resolved}`);
    }
    return {
      path: resolved,
      values: readConfigFile(resolved),
    };
  }

  const envConfigPath = normalizeString(process.env.AGENT_CONFIG);
  if (envConfigPath) {
    const resolved = resolveConfigPath(envConfigPath);
    if (!existsSync(resolved)) {
      throw new Error(`Config file not found: ${resolved}`);
    }
    return {
      path: resolved,
      values: readConfigFile(resolved),
    };
  }

  const candidates = [
    path.join(process.cwd(), 'agent.config.json'),
    path.join(path.dirname(process.execPath), 'agent.config.json'),
  ];

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    if (!existsSync(resolved)) continue;
    return {
      path: resolved,
      values: readConfigFile(resolved),
    };
  }

  return {};
}

function readConfigFile(filePath: string): ConfigFileShape {
  let text = '';
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Failed to read config file: ${filePath}. ${errorMessage(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON in config file: ${filePath}. ${errorMessage(err)}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Config file must contain a JSON object: ${filePath}`);
  }
  return parsed as ConfigFileShape;
}

function applyConfigEnv(envMap: Record<string, unknown>): void {
  for (const [rawKey, rawValue] of Object.entries(envMap)) {
    const key = String(rawKey || '').trim();
    if (!key) continue;
    if (typeof process.env[key] === 'string' && String(process.env[key] || '').trim()) {
      continue;
    }
    const value = normalizeEnvValue(rawValue);
    if (!value) continue;
    process.env[key] = value;
  }
}

function normalizeEnvValue(input: unknown): string {
  if (input === null || typeof input === 'undefined') return '';
  if (typeof input === 'string') return input.trim();
  if (typeof input === 'number' || typeof input === 'boolean') return String(input);
  return '';
}

function parseIntegerLike(input: unknown): number | undefined {
  if (typeof input === 'undefined' || input === null) return undefined;
  const raw = String(input).trim();
  if (!raw) return undefined;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
}

function normalizeString(input: unknown): string {
  return String(input || '').trim();
}

function resolveConfigPath(value: string): string {
  if (path.isAbsolute(value)) return value;
  return path.resolve(process.cwd(), value);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
