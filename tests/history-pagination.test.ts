import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import initSqlJs from 'sql.js';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Store } from '../electron/store';
import { pageTaskEvents, linkedPlanContext, recoverPlanText } from '../shared/task-history';
import { EventHistory } from '../src/event-history';
import { HistoryControls, PlanActions } from '../src/history-controls';
import { groupToolEvents } from '../src/tool-events';
import { capturePosition, restorePosition } from '../src/session-scroll';
import { TaskRunner } from '../engine/runner';
import { ToolRegistry } from '../engine/tools';
import { defaults, type EngineEvent, type Event, type Run, type Task } from '../shared/types';

const plan = (extra: Partial<Run> = {}): Run => ({ id: 'plan', taskId: 'task', mode: 'plan', input: '保留导出按钮', status: 'completed', createdAt: 1, references: [], changes: [], checks: [], ...extra });
const event = (id: string, extra: Partial<Event> = {}): Event => ({ id, at: 1, kind: 'notice', text: id, ...extra });
const task = (events: Event[], extra: Partial<Task> = {}): Task => ({ id: 'task', projectId: 'project', title: '历史', model: 'mock', status: 'completed', createdAt: 1, messages: [], events, changes: [], ...extra });
const events = (count: number) => Array.from({ length: count }, (_, i) => event(`event-${i}`));
const recent = (full: Task): Task => ({ ...full, events: pageTaskEvents(full).events, eventCount: full.events.length });

test('stable ID pages retain every event exactly once while newer events append', () => {
  const full = task(events(751));
  const last = pageTaskEvents(full);
  assert.equal(last.events.length, 100); assert.equal(last.start, 651);
  assert.equal(last.events[0].id, 'event-651'); assert.equal(last.hasMore, true);
  full.events.push(event('new'));
  let page = pageTaskEvents(full, last.events[0].id), loaded = last.events;
  while (true) {
    loaded = [...page.events, ...loaded];
    if (!page.hasMore) break;
    page = pageTaskEvents(full, page.events[0].id);
  }
  assert.deepEqual(loaded, full.events.slice(0, -1));
  assert.equal(new Set(loaded.map(e => e.id)).size, 751);
  assert.throws(() => pageTaskEvents(full, 'other-task-event'), /游标不存在/);
  assert.deepEqual(pageTaskEvents(task([])), { events: [], start: 0, hasMore: false, total: 0 });
});

test('event ID pages jump directly around distant anchors and page forward without overlap', () => {
  const full = task(events(1001));
  const middle = pageTaskEvents(full, { around: 'event-450' });
  assert.equal(middle.start, 400); assert.equal(middle.events.length, 100);
  assert.equal(middle.events[50].id, 'event-450'); assert.equal(middle.hasMore, true);
  const next = pageTaskEvents(full, { after: middle.events.at(-1)!.id });
  assert.deepEqual(next.events, full.events.slice(500, 600)); assert.equal(next.start, 500);
  const earlier = pageTaskEvents(full, { before: middle.events[0].id });
  assert.deepEqual(earlier.events, full.events.slice(300, 400));
  assert.equal(pageTaskEvents(full, { around: 'event-0' }).start, 0);
  assert.equal(pageTaskEvents(full, { around: 'event-1000' }).start, 901);
  assert.deepEqual(pageTaskEvents(full, { after: 'event-1000' }), { events: [], start: 1001, hasMore: true, total: 1001 });
  assert.deepEqual(pageTaskEvents(full, { before: 'event-0' }), { events: [], start: 0, hasMore: false, total: 1001 });
  for (const cursor of [{ around: 'missing' }, { after: 'missing' }]) assert.throws(() => pageTaskEvents(full, cursor), /游标不存在/);
  assert.throws(() => pageTaskEvents(full, { before: 'event-0', after: 'event-1' } as any), /一个方向/);
  assert.throws(() => pageTaskEvents(task([]), { around: 'missing' }), /游标不存在/);
  assert.deepEqual(pageTaskEvents(task(events(12)), { around: 'event-8' }).events, events(12));
});

test('event ID index reuses cursor lookups, indexes only appended events, and handles history resets', () => {
  let reads = 0;
  const tracked = (id: string): Event => ({ ...event(id), get id() { reads++; return id; } });
  const full = task(Array.from({ length: 10000 }, (_, i) => tracked(`event-${i}`)));
  assert.equal(pageTaskEvents(full, { around: 'event-5000' }).start, 4950);
  reads = 0;
  for (let i = 0; i < 20; i++) pageTaskEvents(full, { around: `event-${4000 + i}` });
  assert.ok(reads < 200, `cached lookups read ${reads} IDs`);
  full.events.push(tracked('new-1'), tracked('new-2')); reads = 0;
  assert.equal(pageTaskEvents(full, { after: 'event-9999' }).events.length, 2);
  assert.equal(pageTaskEvents(full, { around: 'new-2' }).events.at(-1)!.id, 'new-2');
  assert.ok(reads < 30, `append lookup read ${reads} IDs`);
  full.events = events(12);
  assert.equal(pageTaskEvents(full, { around: 'event-8' }).start, 0);
  assert.throws(() => pageTaskEvents(full, { around: 'new-2' }), /游标不存在/);
  full.events.length = 4;
  assert.equal(pageTaskEvents(full, { around: 'event-3' }).events.length, 4);
  full.events[1] = event('replacement');
  assert.equal(pageTaskEvents(full, { around: 'replacement' }).events[1].id, 'replacement');
  assert.throws(() => pageTaskEvents(full, { around: 'event-1' }), /游标不存在/);
  full.events = [];
  assert.deepEqual(pageTaskEvents(full), { events: [], start: 0, hasMore: false, total: 0 });
  assert.throws(() => pageTaskEvents(full, { after: 'event-0' }), /游标不存在/);
});

test('loaded history survives live updates, fills skipped snapshot gaps, and rebuilds tool cards', async () => {
  const full = task(events(250));
  full.events[149] = event('call', { kind: 'tool', text: 'read_file {}', toolCallId: 'tool', toolPhase: 'call', runId: 'r' });
  full.events[150] = event('result', { kind: 'tool', text: 'read_file 结果\n正文', toolCallId: 'tool', toolPhase: 'result', runId: 'r' });
  const history = new EventHistory(); history.update(recent(full));
  const api = { taskEvents: async ({ before }: { before?: string }) => pageTaskEvents(full, before) };
  await history.loadEarlier(api);
  const card = groupToolEvents(history.events).find(e => e.id === 'call');
  assert.equal(card?.kind === 'tool-group' && card.result?.id, 'result');
  full.events.push(...Array.from({ length: 230 }, (_, i) => event(`new-${i}`)));
  history.update(recent(full)); assert.equal(history.hasGap, true);
  while (history.hasMore) await history.loadEarlier(api);
  assert.deepEqual(history.events, full.events); assert.equal(history.hasGap, false);
  history.update(recent(full)); assert.deepEqual(history.events, full.events);
});

test('switching tasks ignores late history pages and errors; duplicate load requests are blocked', async () => {
  const history = new EventHistory(), full = task(events(250)); history.update(recent(full));
  let resolve!: (page: ReturnType<typeof pageTaskEvents>) => void;
  const pending = history.loadEarlier({ taskEvents: () => new Promise(r => { resolve = r; }) });
  assert.equal(await history.loadEarlier({ taskEvents: async () => { throw new Error('duplicate'); } }), false);
  history.update(task([event('other')], { id: 'other' }));
  resolve(pageTaskEvents(full, 'event-150')); assert.equal(await pending, false);
  assert.deepEqual(history.events.map(e => e.id), ['other']); assert.equal(history.loading, false);
  history.update(recent(full));
  let reject!: (error: Error) => void;
  const stale = history.loadEarlier({ taskEvents: () => new Promise((_r, fail) => { reject = fail; }) });
  history.update(); reject(new Error('stale')); assert.equal(await stale, false);
  assert.deepEqual(history.events, []);
  history.update(recent(full));
  await assert.rejects(history.loadEarlier({ taskEvents: async () => { throw new Error('read failed'); } }), /read failed/);
  assert.equal(history.loading, false);
  await history.loadEarlier({ taskEvents: async ({ before }) => pageTaskEvents(full, before) });
  assert.equal(history.events[0].id, 'event-50');
});

test('full history and independent plan text survive reopening beyond the old 600-event limit', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'jalo-plan-history-')); let store: Store | undefined;
  try {
    const file = path.join(home, 'state.sqlite'), text = '开头的约束\n' + '完整计划。'.repeat(3000) + '\n最后的验收条件';
    store = await Store.open(file); store.putTask(task(events(901), { runs: [plan({ planText: text })] }));
    store.close(); store = await Store.open(file);
    const restored = store.tasks()[0]; assert.equal(restored.events.length, 901);
    const saved = restored.runs![0]; assert.equal(saved.planText, text);
    const context = linkedPlanContext(saved, ['a.txt']); assert.ok(context.includes(text)); assert.ok(context.includes(saved.input));
    assert.equal(restored.historyIncomplete, undefined);
    assert.throws(() => linkedPlanContext(plan(), []), /重新生成计划/);
    assert.throws(() => linkedPlanContext(plan({ status: 'failed', planText: text }), []), /重新生成计划/);
  } finally { store?.close(); await fs.rm(home, { recursive: true, force: true }); }
});

test('v3 migration backs up original bytes, recovers confirmed final plans, and refuses partial plans', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'jalo-v4-history-')); let store: Store | undefined;
  try {
    const file = path.join(home, 'state.sqlite'), SQL = await initSqlJs(), db = new SQL.Database();
    db.run('CREATE TABLE tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL); PRAGMA user_version = 3');
    const reply = event('final', { runId: 'plan', kind: 'message', role: 'assistant', text: '完整最终计划' });
    const completion = event('complete', { runId: 'plan', text: '本轮回复已结束，文件工具未产生实际修改。' });
    const good = task([event('interim', { runId: 'plan', kind: 'message', role: 'assistant', text: '临时思路' }), reply, completion], { runs: [plan()] });
    const partial = task([...events(598), { ...reply, runId: 'partial-plan' }, event('tool', { runId: 'partial-plan', kind: 'tool' })], { id: 'partial', runs: [plan({ id: 'partial-plan', taskId: 'partial' })] });
    const missing = task(events(600), { id: 'missing', runs: [plan({ id: 'missing-plan', taskId: 'missing' })] });
    for (const value of [good, partial, missing]) db.run('INSERT INTO tasks VALUES (?,?)', [value.id, JSON.stringify(value)]);
    const bytes = Buffer.from(db.export()); db.close(); await fs.writeFile(file, bytes);
    store = await Store.open(file);
    const restored = store.tasks(); assert.equal(restored.find(t => t.id === 'task')!.runs![0].planText, reply.text);
    for (const id of ['partial', 'missing']) {
      const old = restored.find(t => t.id === id)!;
      assert.equal(old.historyIncomplete, true); assert.equal(old.runs![0].planText, undefined);
      assert.throws(() => linkedPlanContext(old.runs![0], []), /重新生成计划/);
    }
    const backup = (await fs.readdir(home)).find(n => n.includes('before-v4')); assert.ok(backup);
    assert.deepEqual(await fs.readFile(path.join(home, backup)), bytes);
    store.close(); store = await Store.open(file);
    assert.equal(store.tasks().find(t => t.id === 'task')!.runs![0].planText, reply.text);
    assert.equal((await fs.readdir(home)).filter(n => n.includes('before-v4')).length, 1);
    assert.equal(recoverPlanText(task([reply]), plan()), undefined);
  } finally { store?.close(); await fs.rm(home, { recursive: true, force: true }); }
});

test('plan UI exposes the saved text and gates missing plans; pagination explains legacy gaps', () => {
  const html = renderToStaticMarkup(React.createElement(PlanActions, { run: plan({ planText: '<完整计划>' }), disabled: true, execute: () => {} }));
  assert.match(html, /&lt;完整计划&gt;/); assert.match(html, /按计划执行/); assert.match(html, /disabled/);
  const missing = renderToStaticMarkup(React.createElement(PlanActions, { run: plan(), disabled: false, execute: () => {} }));
  assert.match(missing, /重新生成计划/); assert.doesNotMatch(missing, /<button/);
  const controls = renderToStaticMarkup(React.createElement(HistoryControls, { hasMore: true, loading: true, incomplete: true, load: () => {} }));
  assert.match(controls, /正在加载/); assert.match(controls, /旧版本/); assert.match(controls, /disabled/);
});

test('runner returns only the final completed plan, never an interim reply or failed round', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'jalo-final-plan-'));
  try {
    await fs.writeFile(path.join(home, 'a.txt'), 'sample');
    for (const maxSteps of [1, 2]) {
      const emitted: EngineEvent[] = [], controller = new AbortController();
      const tools = new ToolRegistry({ root: home, backupDir: '', signal: controller.signal, timeout: 1, mode: 'plan', emit: e => emitted.push(e), approve: async () => false });
      const final = '最终完整计划\n' + '步骤和验收。'.repeat(2500);
      const replies = [
        { message: { role: 'assistant', content: '先读取文件的临时思路', tool_calls: [{ id: 'read', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] }, finishReason: 'tool_calls' },
        { message: { role: 'assistant', content: final }, finishReason: 'stop' },
      ];
      await new TaskRunner({ generate: async () => replies.shift() } as any, tools, { ...defaults, maxSteps }, e => emitted.push(e), controller.signal).run({ messages: [{ role: 'user', content: '只分析并给出计划' }] }, false);
      const done = emitted.at(-1); assert.ok(done?.type === 'done');
      assert.equal(done.status, maxSteps === 2 ? 'completed' : 'failed');
      assert.equal(done.result, maxSteps === 2 ? final : undefined);
    }
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('prepending history restores the reading anchor and expanded card even after result grouping', () => {
  const original = (globalThis as any).HTMLDetailsElement;
  const panel = { scrollTop: 200, scrollHeight: 2000, clientHeight: 400, getBoundingClientRect: () => ({ top: 100 }), querySelectorAll: () => rows };
  class Details {
    open = false;
    dataset = { eventId: 'call', eventAliases: '["result","error"]' };
    getBoundingClientRect() { return { top: 100 + 600 - panel.scrollTop, bottom: 100 + 640 - panel.scrollTop }; }
  }
  const rows = [new Details()];
  (globalThis as any).HTMLDetailsElement = Details;
  try {
    const saved = { top: 200, follow: false, anchor: 'result', offset: -12, expanded: ['result'] };
    assert.equal(restorePosition(panel as any, saved), 612); assert.equal(rows[0].open, true);
    const captured = capturePosition(panel as any, false);
    assert.equal(captured.anchor, 'call'); assert.equal(captured.offset, -12); assert.deepEqual(captured.expanded, ['call', 'result', 'error']);
    assert.equal(restorePosition(panel as any, { ...saved, follow: true }), 1600);
  } finally {
    if (original === undefined) delete (globalThis as any).HTMLDetailsElement;
    else (globalThis as any).HTMLDetailsElement = original;
  }
});
