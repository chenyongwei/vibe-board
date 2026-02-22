import { AdapterInfo } from './types';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export class Registry {
  private adapters: AdapterInfo[] = [];
  constructor(private storagePath: string) {
    const dir = dirname(this.storagePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  load(): void {
    try {
      if (existsSync(this.storagePath)) {
        const raw = readFileSync(this.storagePath, 'utf8');
        this.adapters = JSON.parse(raw) as AdapterInfo[];
      } else {
        this.adapters = [];
      }
    } catch {
      this.adapters = [];
    }
  }

  save(): void {
    writeFileSync(this.storagePath, JSON.stringify(this.adapters, null, 2), 'utf8');
  }

  list(): AdapterInfo[] {
    return this.adapters;
  }

  upsert(entry: AdapterInfo): void {
    const idx = this.adapters.findIndex(a => a.id === entry.id);
    if (idx >= 0) this.adapters[idx] = entry;
    else this.adapters.push(entry);
  }

  get(id: string): AdapterInfo | undefined {
    return this.adapters.find(a => a.id === id);
  }
}
