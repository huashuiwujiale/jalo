import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PerformanceMetrics } from '../electron/performance';

test('performance samples are bounded, anonymous and count failed operations without replacing errors', async () => {
  let clock = 0; const metrics = new PerformanceMetrics(() => clock);
  for (let i = 0; i < 200; i++) metrics.record('database_commit', i);
  assert.deepEqual(metrics.snapshot()[0], { name: 'database_commit', count: 200, failures: 0, sampleCount: 128, p50Ms: 135, p95Ms: 193, maxMs: 199, meanMs: 135.5 });
  const original = new Error('private path and prompt');
  await assert.rejects(metrics.measure('task_detail', async () => { clock += 12; throw original; }), error => error === original);
  assert.throws(() => metrics.sync('file_search', () => { clock += 5; throw original; }), error => error === original);
  assert.equal(metrics.snapshot()[1].failures, 1);
  assert.equal(metrics.snapshot()[1].meanMs, 12);
  assert.ok(!JSON.stringify(metrics.snapshot()).includes('private'));
  const end = metrics.start('snapshot'); clock += 7; end(); end(true);
  assert.equal(metrics.snapshot().at(-1)!.count, 1);
  metrics.record('startup', NaN); metrics.record('startup', -1);
  assert.ok(!metrics.snapshot().some(m => m.name === 'startup'));
});
