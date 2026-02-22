import { AdapterInfo, Task } from '../types'

export interface Adapter {
  name: string;
  version?: string;
  discover(): Promise<AdapterInfo>;
  getTasks(): Promise<Task[]>;
  normalizeTask(raw: any): Task;
}
