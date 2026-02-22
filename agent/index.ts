import path from 'path';
import { existsSync } from 'fs';
import { Registry } from './registry';
import { OpenCodeAdapter } from './adapters/OpenCodeAdapter';
import { CodexAdapter } from './adapters/CodexAdapter';
import { ClaudeCodeAdapter } from './adapters/ClaudeCodeAdapter';
import { Discovery } from './discovery';
import { flushQueuedReports, reportBatch } from './core/reportClient';
import { resolveMachineIdentity } from './core/machineIdentity';
import { loadRuntimeConfig } from './core/runtimeConfig';
import type { Task } from './types';

async function main() {
  const runtimeConfig = loadRuntimeConfig(process.argv.slice(2));
  if (runtimeConfig.configPath) {
    console.log(`Loaded config: ${runtimeConfig.configPath}`);
  }

  const baseDir = resolveAgentBaseDir();
  const registryPath = path.join(baseDir, 'data', 'registry.json');
  const retryQueuePath = path.join(baseDir, 'data', 'report-queue.json');
  const registry = new Registry(registryPath);
  registry.load();

  const adapters = [
    new OpenCodeAdapter(),
    new CodexAdapter(),
    new ClaudeCodeAdapter(),
  ];
  const identity = await resolveMachineIdentity({
    machineId: runtimeConfig.machineId,
    machineName: runtimeConfig.machineName,
    machineFingerprint: runtimeConfig.machineFingerprint,
  });
  const endpoint = runtimeConfig.reportEndpoint;
  const machineId = identity.machineId;
  const machineName = identity.machineName || machineId;
  const machineFingerprint = identity.machineFingerprint;
  const reportIntervalSeconds = runtimeConfig.reportIntervalSeconds;
  const reportIntervalMs = Number.isFinite(reportIntervalSeconds) && reportIntervalSeconds > 0
    ? reportIntervalSeconds * 1000
    : 0;

  const runCycle = async () => {
    const disc = new Discovery(registry, adapters);
    await disc.runOnce();

    const flushResult = await flushQueuedReports({
      endpoint,
      queuePath: retryQueuePath,
      maxItems: 20,
    });
    if (flushResult.sent > 0) {
      console.log(`Flushed queued reports: ${flushResult.sent}, remaining: ${flushResult.remaining}`);
    }

    const allTasks: Task[] = [];
    for (const adapter of adapters) {
      try {
        const tasks = await adapter.getTasks();
        allTasks.push(...(tasks || []));
      } catch (e) {
        console.error(`Failed to fetch tasks from ${adapter.name}:`, e);
      }
    }
    await reportBatch({
      tasks: allTasks,
      endpoint,
      machineId,
      machineName,
      machineFingerprint,
      queuePath: retryQueuePath,
      maxQueueSize: 500,
    });
  };

  if (reportIntervalMs <= 0) {
    await runCycle();
    return;
  }

  let stopping = false;
  process.on('SIGINT', () => { stopping = true; });
  process.on('SIGTERM', () => { stopping = true; });

  while (!stopping) {
    const startedAt = Date.now();
    await runCycle();
    const elapsed = Date.now() - startedAt;
    const waitMs = Math.max(reportIntervalMs - elapsed, 0);
    if (waitMs > 0) {
      await sleep(waitMs);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveAgentBaseDir(): string {
  if ((process as any).pkg) {
    return path.dirname(process.execPath);
  }
  const dataDirInDist = path.resolve(__dirname, 'data');
  return existsSync(dataDirInDist) ? __dirname : path.resolve(__dirname, '..');
}

main().catch(console.error);
