import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Store } from '../electron/store';
import { metrics } from '../electron/performance';
import type { Task } from '../shared/types';

// Reproducible local fixture only. Report timings; do not impose hardware-specific limits.
async function main() {
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'jalo-performance-'));
let store: Store | undefined;
try {
  const file = path.join(home, 'state.sqlite'); store = await Store.open(file);
  const task: Task = { id: 'task', projectId: 'project', title: '性能样例', model: 'mock', status: 'completed', createdAt: 1, messages: [], changes: [], legacy: true,
    events: Array.from({ length: 10000 }, (_, i) => ({ id: String(i), at: i, kind: 'notice', text: '历史文本'.repeat(30) })) };
  store.putTask(task);
  for (let i = 0; i < 100; i++) { task.events.push({ id: `append-${i}`, at: i, kind: 'notice', text: '新增' }); store.putTask(task); }
  const detailStart = performance.now(); for (let i = 0; i < 100; i++) store.detail(task.id);
  const detailMs = (performance.now() - detailStart) / 100;
  store.close(); store = undefined;
  const startup = performance.now(); store = await Store.open(file); const startupMs = performance.now() - startup;
  console.log(JSON.stringify({ fixture: { events: 10100, detailPageSize: 100 }, runtime: process.version, startupMs, detailMeanMs: detailMs, metrics: metrics.snapshot() }, null, 2));
} finally { store?.close(); await fs.rm(home, { recursive: true, force: true }); }

}
main().catch(error => { console.error(error); process.exitCode = 1; });
