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
