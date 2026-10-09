import { performance } from 'node:perf_hooks';

export type Metric = 'startup' | 'snapshot' | 'task_detail' | 'file_search' | 'task_search' | 'database_commit' | 'model_first_activity';
const names: Metric[] = ['startup', 'snapshot', 'task_detail', 'file_search', 'task_search', 'database_commit', 'model_first_activity'];
/** Bounded anonymous measurements; never retain file names, prompts or task IDs. */
export class PerformanceMetrics {
  private values = new Map<Metric, { count: number; failures: number; samples: number[] }>();
  constructor(private clock = () => performance.now()) {}
  record(name: Metric, duration: number, failed = false) {
    if (!names.includes(name) || !Number.isFinite(duration) || duration < 0) return;
    const value = this.values.get(name) || { count: 0, failures: 0, samples: [] };
    value.count++; value.failures += Number(failed); value.samples.push(duration);
    if (value.samples.length > 128) value.samples.shift();
    this.values.set(name, value);
  }
  start(name: Metric) {
    const began = this.clock(); let ended = false;
    return (failed = false) => { if (!ended) { ended = true; this.record(name, this.clock() - began, failed); } };
  }
  sync<T>(name: Metric, action: () => T): T {
    const end = this.start(name);
    try { const result = action(); end(); return result; } catch (error) { end(true); throw error; }
  }
  async measure<T>(name: Metric, action: () => T | Promise<T>): Promise<T> {
    const end = this.start(name);
    try { const result = await action(); end(); return result; } catch (error) { end(true); throw error; }
  }
  snapshot() {
    return [...this.values].map(([name, value]) => {
      const sorted = [...value.samples].sort((a, b) => a - b);
      const round = (n: number) => Math.round(n * 100) / 100;
      return { name, count: value.count, failures: value.failures, sampleCount: sorted.length,
        p50Ms: round(sorted[Math.ceil(sorted.length * .5) - 1]), p95Ms: round(sorted[Math.ceil(sorted.length * .95) - 1]),
        maxMs: round(sorted.at(-1)!), meanMs: round(sorted.reduce((a, b) => a + b, 0) / sorted.length) };
    });
  }
}
export const metrics = new PerformanceMetrics();
