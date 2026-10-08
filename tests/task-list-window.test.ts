import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskListWindow, taskRowHeight, taskRowScrollTop } from '../src/task-list-window';

test('large task histories mount only the viewport and a bounded scroll buffer', () => {
  const first = taskListWindow(10_000, 0, 600);
  assert.deepEqual(first, { start: 0, end: 16, offset: 0, totalHeight: 600_000 });
  const middle = taskListWindow(10_000, 300_000, 600);
  assert.deepEqual(middle, { start: 4_994, end: 5_016, offset: 299_640, totalHeight: 600_000 });
  const last = taskListWindow(10_000, 900_000, 600);
  assert.deepEqual(last, { start: 9_984, end: 10_000, offset: 599_040, totalHeight: 600_000 });
});

test('task windows handle filtering, short lists, fractional scrolling and an empty history', () => {
  assert.deepEqual(taskListWindow(0, 5_000, 600), { start: 0, end: 0, offset: 0, totalHeight: 0 });
  assert.deepEqual(taskListWindow(3, 5_000, 600), { start: 0, end: 3, offset: 0, totalHeight: 180 });
  const partial = taskListWindow(100, taskRowHeight * 20 + 1, taskRowHeight * 3);
  assert.equal(partial.start, 14); assert.equal(partial.end, 30);
  assert.equal(taskListWindow(100, -100, 0).start, 0);
});

test('selection and keyboard navigation reveal a task without shifting rows already in view', () => {
  assert.equal(taskRowScrollTop(5, 240, 180), 240);
  assert.equal(taskRowScrollTop(2, 240, 180), 120);
  assert.equal(taskRowScrollTop(20, 240, 180), 1080);
  assert.equal(taskRowScrollTop(0, 240, 20), 0);
});
