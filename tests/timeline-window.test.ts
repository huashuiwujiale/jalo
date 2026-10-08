import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TimelineWindow } from '../src/timeline-window';
import { rememberExpanded } from '../src/session-scroll';

test('variable row heights bound mounted rows and support distant viewport lookup', () => {
  const model = new TimelineWindow(), rows = Array.from({ length: 10000 }, (_, i) => ({ id: String(i), estimate: 100 }));
  model.setRows(rows);
  let range = model.range(500000, 600); assert.ok(range.end - range.start <= 18); assert.ok(range.start <= 5000 && range.end > 5000);
  assert.equal(model.measure('1', 3000), true); model.setRows(rows);
  assert.equal(model.offsets[2], 3100); assert.equal(model.measure('1', 3000.1), false);
  range = model.range(100, 600); assert.equal(range.start, 0); assert.equal(range.end, 2);
  assert.equal(range.before + (model.offsets[range.end] - model.offsets[range.start]) + range.after, model.total);
  model.setRows(rows.slice(100)); assert.equal(model.total, 990000);
  model.reset(); model.setRows([]); assert.deepEqual(model.range(0, 600), { start: 0, end: 0, before: 0, after: 0 });
});
test('expanded tool aliases survive unmounting and close together after a split page', () => {
  const expanded = new Set<string>(), groups = new Map<string, string[]>();
  rememberExpanded({ dataset: { eventId: 'call', eventAliases: '["result","error"]' }, open: true } as any, expanded, groups);
  assert.deepEqual([...expanded], ['call', 'result', 'error']);
  rememberExpanded({ dataset: { eventId: 'result' }, open: false } as any, expanded, groups);
  assert.equal(expanded.size, 0);
});
