import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventHistory, historyCacheLimit } from '../src/event-history';
import { pageTaskEvents } from '../shared/task-history';
import type { Api, Event, EventPage, Task } from '../shared/types';

const event = (id: string): Event => ({ id, at: 1, kind: 'notice', text: id });
const task = (count: number, id = 'task'): Task => ({
  id, projectId: 'project', title: '历史', model: 'mock', status: 'completed', createdAt: 1,
  messages: [], changes: [], events: Array.from({ length: count }, (_, i) => event(`${id}-${i}`)),
});
const recent = (full: Task) => ({ id: full.id, events: full.events.slice(-100), eventCount: full.events.length });
const pages = (full: Task): Pick<Api, 'taskEvents'> => ({ taskEvents: async input => pageTaskEvents(full, input) });
const ids = (history: EventHistory) => history.events.map(item => item.id);

test('a saved anchor in 10000 events loads directly with one request', async () => {
  const full = task(10000), history = new EventHistory();
  history.update(recent(full));
  const calls: Parameters<Api['taskEvents']>[0][] = [];
  assert.equal(await history.loadWindow({ taskEvents: async input => {
    calls.push(input); return pageTaskEvents(full, input);
  } }, { around: 'task-3000' }), true);
  assert.deepEqual(calls, [{ taskId: 'task', around: 'task-3000' }]);
  assert.deepEqual(ids(history), full.events.slice(2950, 3050).map(item => item.id));
  assert.equal(history.hasGap, false); assert.equal(history.hasMore, true); assert.equal(history.hasLater, true);
});

test('history pages stay within the cache bound while older and newer events remain reachable', async () => {
  const full = task(10000), history = new EventHistory(), api = pages(full);
  history.update(recent(full));
  const visited = new Set(ids(history));
  const inspect = () => {
    assert.ok(history.events.length <= historyCacheLimit);
    assert.equal(history.hasGap, false);
    for (const id of ids(history)) visited.add(id);
  };
  let loads = 0;
  while (history.hasMore) {
    assert.ok(loads++ < 110, 'older paging must make progress');
    assert.equal(await history.loadEarlier(api), true); inspect();
  }
  assert.equal(history.events[0].id, 'task-0'); assert.equal(history.hasLater, true);
  assert.deepEqual(visited, new Set(full.events.map(item => item.id)));
  loads = 0;
  while (history.hasLater) {
    assert.ok(loads++ < 110, 'newer paging must make progress');
    assert.equal(await history.loadLater(api), true); inspect();
  }
  assert.equal(history.events.at(-1)!.id, 'task-9999'); assert.equal(history.hasMore, true);
  assert.equal(await history.loadLater(api), false);
  loads = 0;
  while (history.hasMore) {
    assert.ok(loads++ < 110, 'returning to older pages must make progress');
    await history.loadEarlier(api); inspect();
  }
  assert.equal(history.events[0].id, 'task-0');
  assert.equal(await history.loadEarlier(api), false);
  await history.loadWindow(api, {}); inspect();
  assert.deepEqual(ids(history), full.events.slice(-100).map(item => item.id));
  assert.equal(history.hasLater, false);
});

test('live snapshots advance totals without mixing a distant recent tail into an older reading window', async () => {
  const full = task(10000), history = new EventHistory(), api = pages(full);
  history.update(recent(full)); await history.loadWindow(api, { around: 'task-1000' });
  const older = ids(history); let changed = 0;
  for (let i = 0; i < 300; i++) full.events.push(event(`live-${i}`));
  history.update(recent(full), () => changed++);
  assert.deepEqual(ids(history), older); assert.equal(changed, 0);
  assert.equal(history.total, 10300); assert.equal(history.hasGap, false); assert.equal(history.hasLater, true);
  await history.loadLater(api);
  assert.deepEqual(ids(history), full.events.slice(950, 1150).map(item => item.id));
  await history.loadWindow(api, {});
  assert.equal(history.events.at(-1)!.id, 'live-299'); assert.equal(history.hasLater, false);
  full.events.push(event('next-live')); history.update(recent(full));
  assert.equal(history.events.at(-1)!.id, 'next-live'); assert.equal(history.hasGap, false);
});

test('repairing a skipped live gap at the cache limit retains the newest tail', async () => {
  const full = task(600), history = new EventHistory(), api = pages(full);
  history.update(recent(full));
  while (history.hasMore) await history.loadEarlier(api);
  assert.equal(history.events.length, historyCacheLimit); assert.equal(history.hasLater, false);
  full.events.push(...Array.from({ length: 500 }, (_, i) => event(`task-${600 + i}`)));
  history.update(recent(full));
  assert.equal(history.hasGap, true); assert.equal(history.events.at(-1)!.id, 'task-1099');
  let requests = 0;
  while (history.hasGap) {
    assert.ok(requests++ < 10, 'gap repair must make progress');
    assert.equal(await history.loadEarlier(api), true);
    assert.ok(history.events.length <= historyCacheLimit);
    assert.equal(history.events.at(-1)!.id, 'task-1099'); assert.equal(history.hasLater, false);
  }
  assert.deepEqual(ids(history), full.events.slice(-historyCacheLimit).map(item => item.id));
  // Once the gap is repaired, explicit backward paging still retains older rows.
  await history.loadEarlier(api);
  assert.deepEqual(ids(history), full.events.slice(400, 1000).map(item => item.id));
  assert.equal(history.hasLater, true);
});

test('task switches ignore late around and after pages and failures without clearing a new request', async () => {
  const full = task(10000), other = task(400, 'other');
  for (const direction of ['around', 'after'] as const) {
    for (const rejects of [false, true]) {
      const history = new EventHistory(); history.update(recent(full));
      await history.loadWindow(pages(full), { around: 'task-1000' });
      let resolve!: (value: EventPage) => void, reject!: (error: Error) => void;
      const cursor = direction === 'around' ? { around: 'task-3000' } : { after: 'task-1049' };
      const pending = history.loadWindow({ taskEvents: () => new Promise((ok, fail) => { resolve = ok; reject = fail; }) }, cursor);
      assert.equal(history.loading, true);
      assert.equal(await history.loadWindow({ taskEvents: async () => { throw new Error('duplicate'); } }, {}), false);
      history.update(recent(other));
      let finishNew!: (value: EventPage) => void;
      const newRequest = history.loadWindow({ taskEvents: () => new Promise(ok => { finishNew = ok; }) }, { around: 'other-100' });
      if (rejects) reject(new Error('stale read failure'));
      else resolve(pageTaskEvents(full, cursor));
      assert.equal(await pending, false);
      assert.equal(history.loading, true);
      assert.equal(history.taskId, 'other'); assert.deepEqual(ids(history), other.events.slice(-100).map(item => item.id));
      finishNew(pageTaskEvents(other, { around: 'other-100' }));
      assert.equal(await newRequest, true); assert.equal(history.loading, false);
      assert.deepEqual(ids(history), other.events.slice(50, 150).map(item => item.id));
    }
  }
  const history = new EventHistory(); history.update(recent(full));
  await assert.rejects(history.loadWindow({ taskEvents: async () => { throw new Error('current read failure'); } }, { around: 'task-1000' }), /current read failure/);
  assert.equal(history.loading, false);
  await history.loadWindow(pages(full), { around: 'task-1000' });
  assert.equal(history.events[50].id, 'task-1000');
});
