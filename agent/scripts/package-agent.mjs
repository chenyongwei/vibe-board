#!/usr/bin/env node
import { spawnSync } from 'child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const scriptsDir = path.dirname(__filename);
const agentDir = path.resolve(scriptsDir, '..');
const distEntry = path.join(agentDir, 'dist', 'index.js');
const releaseRoot = path.join(agentDir, 'release');
const configTemplatePath = path.join(agentDir, 'agent.config.example.json');

const TARGETS = [
  { id: 'windows-x64', pkgTarget: 'node18-win-x64', binaryName: 'vibe-agent.exe', launcherName: 'run-agent.bat' },
  { id: 'macos-x64', pkgTarget: 'node18-macos-x64', binaryName: 'vibe-agent', launcherName: 'run-agent.command' },
  { id: 'macos-arm64', pkgTarget: 'node18-macos-arm64', binaryName: 'vibe-agent', launcherName: 'run-agent.command' },
  { id: 'linux-x64', pkgTarget: 'node18-linux-x64', binaryName: 'vibe-agent', launcherName: 'run-agent.sh' },
  { id: 'linux-arm64', pkgTarget: 'node18-linux-arm64', binaryName: 'vibe-agent', launcherName: 'run-agent.sh' },
];

function main() {
  if (!existsSync(distEntry)) {
    throw new Error(`Build artifacts not found: ${distEntry}. Run "npm run build" first.`);
  }
  if (!existsSync(configTemplatePath)) {
    throw new Error(`Config template not found: ${configTemplatePath}`);
  }

  rmSync(releaseRoot, { recursive: true, force: true });
  mkdirSync(releaseRoot, { recursive: true });

  for (const target of TARGETS) {
    packageForTarget(target);
  }

  writeTopLevelReadme();
  console.log(`\nDone. Packages generated under: ${releaseRoot}`);
}

function packageForTarget(target) {
  const targetDir = path.join(releaseRoot, target.id);
  mkdirSync(targetDir, { recursive: true });
  const outputBinary = path.join(targetDir, target.binaryName);

  runCommand(resolveNpxCommand(), [
    'pkg',
    'dist/index.js',
    '--targets',
    target.pkgTarget,
    '--output',
    outputBinary,
  ]);

  copyFileSync(configTemplatePath, path.join(targetDir, 'agent.config.json'));
  writeFileSync(path.join(targetDir, target.launcherName), launcherScript(target.binaryName, target.launcherName), 'utf8');
  writeFileSync(path.join(targetDir, 'README.txt'), packageReadme(target), 'utf8');

  if (target.launcherName !== 'run-agent.bat') {
    chmodSync(outputBinary, 0o755);
    chmodSync(path.join(targetDir, target.launcherName), 0o755);
  }

  console.log(`Built ${target.id}: ${outputBinary}`);
}

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    cwd: agentDir,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`);
  }
}

function resolveNpxCommand() {
  return process.platform === 'win32' ? 'npx.cmd' : 'npx';
}

function launcherScript(binaryName, launcherName) {
  if (launcherName === 'run-agent.bat') {
    return [
      '@echo off',
      'setlocal',
      'cd /d "%~dp0"',
      'if not exist "agent.config.json" (',
      '  echo [error] agent.config.json not found in this directory.',
      '  pause',
      '  exit /b 1',
      ')',
      `"${binaryName}" --config "agent.config.json"`,
      '',
    ].join('\r\n');
  }

  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"',
    'CONFIG="$SCRIPT_DIR/agent.config.json"',
    'if [ ! -f "$CONFIG" ]; then',
    '  echo "[error] agent.config.json not found in $SCRIPT_DIR"',
    '  exit 1',
    'fi',
    `"${`$SCRIPT_DIR/${binaryName}`}" --config "$CONFIG"`,
    '',
  ].join('\n');
}

function packageReadme(target) {
  const runHint = target.launcherName === 'run-agent.bat'
    ? 'Double-click run-agent.bat'
    : target.launcherName === 'run-agent.command'
      ? 'Double-click run-agent.command (or run ./run-agent.command)'
      : 'Run ./run-agent.sh';

  return [
    `Vibe Agent Package (${target.id})`,
    '',
    '1. Edit agent.config.json',
    '2. Start Agent:',
    `   ${runHint}`,
    '',
    'The launcher passes --config agent.config.json to the binary.',
    '',
  ].join('\n');
}

function writeTopLevelReadme() {
  writeFileSync(
    path.join(releaseRoot, 'README.txt'),
    [
      'Vibe Agent cross-platform packages',
      '',
      'Each subdirectory contains:',
      '- executable binary',
      '- agent.config.json (editable config)',
      '- one-click launcher script',
      '',
      'Supported targets:',
      '- windows-x64',
      '- macos-x64',
      '- macos-arm64',
      '- linux-x64',
      '- linux-arm64',
      '',
    ].join('\n'),
    'utf8'
  );
}

main();
