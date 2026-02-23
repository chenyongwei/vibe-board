import { exec } from 'child_process';
import { promisify } from 'util';
const execP = promisify(exec);

export async function runCommand(cmd: string): Promise<{ stdout: string; stderr: string }> {
  const res: any = await execP(cmd, { windowsHide: true, maxBuffer: 1024 * 1024 });
  return { stdout: res.stdout, stderr: res.stderr };
}

export function fileExistsSync(path: string): boolean {
  try {
    const fs = require('fs');
    return fs.existsSync(path);
  } catch {
    return false;
  }
}

function normalizeToken(value: string): string {
  return String(value || '').trim().toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasTokenInCommand(command: string, token: string): boolean {
  const safeToken = normalizeToken(token);
  if (!safeToken) return false;
  const pattern = new RegExp(`(^|[\\s/\\\\])${escapeRegExp(safeToken)}(\\.exe)?([\\s]|$)`, 'i');
  return pattern.test(command);
}

export async function isAnyProcessRunning(candidates: string[]): Promise<boolean> {
  const tokens = Array.from(
    new Set(
      (candidates || [])
        .map((item) => normalizeToken(item))
        .filter(Boolean)
        .flatMap((item) => (item.endsWith('.exe') ? [item, item.slice(0, -4)] : [item, `${item}.exe`]))
    )
  );
  if (tokens.length === 0) return false;

  try {
    if (process.platform === 'win32') {
      const { stdout } = await runCommand('tasklist');
      const lines = String(stdout || '')
        .split('\n')
        .map((line) => normalizeToken(line));
      return lines.some((line) => tokens.some((token) => line.startsWith(token)));
    }

    const { stdout } = await runCommand('ps -ax -o command=');
    const lines = String(stdout || '')
      .split('\n')
      .map((line) => normalizeToken(line))
      .filter(Boolean);
    return lines.some((line) => tokens.some((token) => hasTokenInCommand(line, token)));
  } catch {
    return false;
  }
}
