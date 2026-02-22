import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { loadRuntimeConfig } from '../core/runtimeConfig';

test('loadRuntimeConfig reads agent.config.json from cwd', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'vibe-runtime-config-cwd-'));
  const previousCwd = process.cwd();
  const restore = {
    REPORT_ENDPOINT: process.env.REPORT_ENDPOINT,
    MACHINE_ID: process.env.MACHINE_ID,
    MACHINE_NAME: process.env.MACHINE_NAME,
    MACHINE_FINGERPRINT: process.env.MACHINE_FINGERPRINT,
    REPORT_INTERVAL_SECONDS: process.env.REPORT_INTERVAL_SECONDS,
    AGENT_CONFIG: process.env.AGENT_CONFIG,
    CODEX_HOME: process.env.CODEX_HOME,
  };

  delete process.env.REPORT_ENDPOINT;
  delete process.env.MACHINE_ID;
  delete process.env.MACHINE_NAME;
  delete process.env.MACHINE_FINGERPRINT;
  delete process.env.REPORT_INTERVAL_SECONDS;
  delete process.env.AGENT_CONFIG;
  delete process.env.CODEX_HOME;

  writeFileSync(
    path.join(tmp, 'agent.config.json'),
    JSON.stringify(
      {
        report_endpoint: 'https://example.com/api/report',
        machine_id: 'machine-from-config',
        machine_name: 'display-from-config',
        machine_fingerprint: 'fingerprint-from-config',
        report_interval_seconds: 33,
        env: {
          CODEX_HOME: '/tmp/codex-home',
        },
      },
      null,
      2
    ),
    'utf8'
  );

  try {
    process.chdir(tmp);
    const loaded = loadRuntimeConfig([]);
    assert.equal(loaded.reportEndpoint, 'https://example.com/api/report');
    assert.equal(loaded.reportIntervalSeconds, 33);
    assert.equal(loaded.machineId, 'machine-from-config');
    assert.equal(loaded.machineName, 'display-from-config');
    assert.equal(loaded.machineFingerprint, 'fingerprint-from-config');
    assert.equal(realpathSync(String(loaded.configPath || '')), realpathSync(path.join(tmp, 'agent.config.json')));
    assert.equal(process.env.CODEX_HOME, '/tmp/codex-home');
  } finally {
    process.chdir(previousCwd);
    process.env.REPORT_ENDPOINT = restore.REPORT_ENDPOINT;
    process.env.MACHINE_ID = restore.MACHINE_ID;
    process.env.MACHINE_NAME = restore.MACHINE_NAME;
    process.env.MACHINE_FINGERPRINT = restore.MACHINE_FINGERPRINT;
    process.env.REPORT_INTERVAL_SECONDS = restore.REPORT_INTERVAL_SECONDS;
    process.env.AGENT_CONFIG = restore.AGENT_CONFIG;
    process.env.CODEX_HOME = restore.CODEX_HOME;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadRuntimeConfig allows environment variables to override config file', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'vibe-runtime-config-env-'));
  const previousCwd = process.cwd();
  const restore = {
    REPORT_ENDPOINT: process.env.REPORT_ENDPOINT,
    MACHINE_NAME: process.env.MACHINE_NAME,
    AGENT_CONFIG: process.env.AGENT_CONFIG,
  };

  writeFileSync(
    path.join(tmp, 'agent.config.json'),
    JSON.stringify(
      {
        report_endpoint: 'https://config-endpoint/api/report',
        machine_name: 'config-name',
      },
      null,
      2
    ),
    'utf8'
  );

  process.env.REPORT_ENDPOINT = 'https://env-endpoint/api/report';
  process.env.MACHINE_NAME = 'env-name';
  delete process.env.AGENT_CONFIG;

  try {
    process.chdir(tmp);
    const loaded = loadRuntimeConfig([]);
    assert.equal(loaded.reportEndpoint, 'https://env-endpoint/api/report');
    assert.equal(loaded.machineName, 'env-name');
    assert.equal(realpathSync(String(loaded.configPath || '')), realpathSync(path.join(tmp, 'agent.config.json')));
  } finally {
    process.chdir(previousCwd);
    process.env.REPORT_ENDPOINT = restore.REPORT_ENDPOINT;
    process.env.MACHINE_NAME = restore.MACHINE_NAME;
    process.env.AGENT_CONFIG = restore.AGENT_CONFIG;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadRuntimeConfig supports --config explicit path', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'vibe-runtime-config-arg-'));
  const restore = {
    AGENT_CONFIG: process.env.AGENT_CONFIG,
    REPORT_ENDPOINT: process.env.REPORT_ENDPOINT,
  };

  delete process.env.AGENT_CONFIG;
  delete process.env.REPORT_ENDPOINT;

  const configPath = path.join(tmp, 'custom.json');
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        report_endpoint: 'https://custom-endpoint/api/report',
      },
      null,
      2
    ),
    'utf8'
  );

  try {
    const loaded = loadRuntimeConfig(['--config', configPath]);
    assert.equal(loaded.reportEndpoint, 'https://custom-endpoint/api/report');
    assert.equal(realpathSync(String(loaded.configPath || '')), realpathSync(configPath));
  } finally {
    process.env.AGENT_CONFIG = restore.AGENT_CONFIG;
    process.env.REPORT_ENDPOINT = restore.REPORT_ENDPOINT;
    rmSync(tmp, { recursive: true, force: true });
  }
});
