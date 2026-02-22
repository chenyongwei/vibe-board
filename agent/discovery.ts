import { Registry } from './registry';
import { Adapter } from './adapters/Adapter';
import { AdapterInfo } from './types';

export class Discovery {
  constructor(private registry: Registry, private adapters: Adapter[]) {}

  async runOnce(): Promise<void> {
    for (const adapter of this.adapters) {
      try {
        const info: AdapterInfo = await adapter.discover();
        this.registry.upsert(info);
      } catch (e) {
        console.error(`Discovery failed for ${adapter.name}:`, e);
        this.registry.upsert({
          id: adapter.name,
          name: adapter.name,
          status: 'offline',
          adapter: adapter.constructor.name,
          last_discovered: new Date().toISOString(),
          capabilities: [],
        } as any);
      }
    }
    this.registry.save();
  }
}
