import { createHash, randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { runCommand } from '../utils';

export interface MachineIdentity {
  machineId: string;
  machineName: string;
  machineFingerprint: string;
}

export interface MachineIdentityOverrides {
  machineId?: string;
  machineName?: string;
  machineFingerprint?: string;
}

export async function resolveMachineIdentity(overrides: MachineIdentityOverrides = {}): Promise<MachineIdentity> {
  const machineId = (process.env.MACHINE_ID || overrides.machineId || os.hostname()).trim() || os.hostname();
  const machineName = (process.env.MACHINE_NAME || overrides.machineName || machineId).trim() || machineId;
  const machineFingerprint = await resolveMachineFingerprint(overrides.machineFingerprint);
  return { machineId, machineName, machineFingerprint };
}

async function resolveMachineFingerprint(override?: string): Promise<string> {
  const fromEnv = (process.env.MACHINE_FINGERPRINT || '').trim();
  if (fromEnv) return hashStable(fromEnv);
  const fromOverride = String(override || '').trim();
  if (fromOverride) return hashStable(fromOverride);

  const fileCandidates = ['/etc/machine-id', '/var/lib/dbus/machine-id'];
  for (const filePath of fileCandidates) {
    const value = readSingleLine(filePath);
    if (value) return hashStable(`mid:${value}`);
  }

  if (process.platform === 'darwin') {
    try {
      const out = await runCommand(
        'ioreg -rd1 -c IOPlatformExpertDevice | awk -F\\" \'/IOPlatformUUID/ { print $(NF-1) }\''
      );
      const value = String(out.stdout || '').trim();
      if (value) return hashStable(`mac:${value}`);
    } catch {
      // continue to fallback
    }
  }

  if (process.platform === 'win32') {
    try {
      const out = await runCommand('wmic csproduct get UUID');
      const lines = String(out.stdout || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => line.toUpperCase() !== 'UUID');
      if (lines[0]) return hashStable(`win:${lines[0]}`);
    } catch {
      // continue to fallback
    }
  }

  return loadOrCreateFallbackFingerprint();
}

function readSingleLine(filePath: string): string {
  try {
    if (!existsSync(filePath)) return '';
    const raw = readFileSync(filePath, 'utf8');
    return raw.split('\n')[0].trim();
  } catch {
    return '';
  }
}

function loadOrCreateFallbackFingerprint(): string {
  const fallbackPath = path.join(os.homedir(), '.vibe-board', 'machine-fingerprint');
  try {
    if (existsSync(fallbackPath)) {
      const existing = readSingleLine(fallbackPath);
      if (existing) return hashStable(`fallback:${existing}`);
    }
    const dir = path.dirname(fallbackPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const generated = randomUUID();
    writeFileSync(fallbackPath, `${generated}\n`, 'utf8');
    return hashStable(`fallback:${generated}`);
  } catch {
    return hashStable(`volatile:${os.hostname()}:${process.pid}`);
  }
}

function hashStable(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}
