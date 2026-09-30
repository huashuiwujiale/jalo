import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { taskSummary, taskDetail, runView, changeView, searchTaskIds } from '../shared/task-wire';
import { applyUpdate } from '../shared/app-state';
import { defaults, type Task, type TaskDetail, type TaskSummary, type AppUpdate, type Snapshot, type StreamFrame } from '../shared/types';
import { ReplyStream, UpdateBatch, streamDelay, updateDelay } from '../electron/ipc-updates';
import { DetailLoader } from '../src/task-detail';
import { StreamAccumulator } from '../src/streaming-reply';
import { EventHistory } from '../src/event-history';
import { emptySession, emptyView, rememberView, restoreView } from '../shared/session';

const task = (id = 'task'): Task => ({ id, projectId: 'project', title: 'renamed', status: 'running', model: 'mock', createdAt: 1, currentRunId: 'run-' + id,
  messages: [], events: [], changes: [], runs: [{ id: 'run-' + id, taskId: id, mode: 'plan', input: 'latest request', status: 'running', createdAt: 1, references: [], changes: [], checks: [] }] });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('catalog and detail payloads omit model context, source snapshots, checkpoint bodies and saved plan fields', () => {
  const full = task(), body = 'PRIVATE-SOURCE-'.repeat(30000), run = full.runs![0];
  full.messages.push({ role: 'user', content: body }); run.planText = body;
  run.references.push({ projectId: 'project', path: 'a.txt', startLine: 1, endLine: 1, version: 'v', content: body });
  const change = { id: 'checkpoint', runId: run.id, path: 'a.txt', before: body, after: body + 'new', patch: body,
    beforeVersion: 'v', afterVersion: 'next', state: 'written' as const, check: { path: 'a.txt', status: 'passed' as const, parser: 'text', message: 'ok', at: 1, version: 'next' } };
  run.changes.push(change); full.changes.push(change);
  full.events.push({ id: 'legacy', kind: 'message', role: 'user', text: 'old legacy request', at: 1 });
  const summary = taskSummary(full, 1), detail = taskDetail(full, 1);
  for (const field of ['events', 'runs', 'changes', 'messages', 'userRequests']) assert.ok(!(field in summary));
  assert.equal(summary.requestCount, 2); assert.equal(summary.eventCount, 1); assert.equal(summary.changeCount, 1);
  assert.ok(!JSON.stringify(summary).includes('PRIVATE-SOURCE')); assert.ok(!JSON.stringify(detail).includes('PRIVATE-SOURCE'));
  assert.ok(JSON.stringify(summary).length < JSON.stringify(full).length / 1000);
  assert.equal(detail.runs[0].hasPlan, true); assert.equal(detail.runs[0].changes[0].changed, true);
  assert.equal(changeView(change).patchVersion, detail.runs[0].changes[0].patchVersion);
  const previousVersion = changeView(change).patchVersion; change.patch = 'new patch';
  assert.notEqual(changeView(change).patchVersion, previousVersion);
  full.events.push({ id: 'another', kind: 'message', role: 'user', text: 'another request', at: 2 });
  assert.equal(taskSummary(full, 2).requestCount, 3);
  assert.equal(runView(run).references[0].path, 'a.txt'); assert.equal(full.messages[0].content, body);
});

test('ordinary broadcasts coalesce changed tasks; critical transitions drain the batch immediately', async () => {
  const sent: AppUpdate[] = [];
  const batch = new UpdateBatch((ids, global, sequence) => ({ sequence, tasks: ids.map(id => taskSummary(task(id), sequence)), ...(global ? { settings: defaults } : {}) }), update => sent.push(update));
  try {
    for (let i = 0; i < 1000; i++) batch.queue(i % 2 ? 'a' : 'b', false);
    assert.equal(sent.length, 0); batch.queue('a');
    assert.equal(sent.length, 1); assert.equal(sent[0].sequence, 1001);
    assert.deepEqual(sent[0].tasks.map(task => task.id).sort(), ['a', 'b']); assert.ok(!('settings' in sent[0]));
    await new Promise(resolve => setTimeout(resolve, updateDelay + 10)); assert.equal(sent.length, 1);
    batch.queue(undefined, false); batch.queue('b', false);
    await new Promise(resolve => setTimeout(resolve, updateDelay + 10));
    assert.equal(sent.length, 2); assert.deepEqual(sent[1].tasks.map(task => task.id), ['b']); assert.equal(sent[1].settings, defaults);
    batch.queue('a', false); batch.dispose();
    await new Promise(resolve => setTimeout(resolve, updateDelay + 10)); assert.equal(sent.length, 2);
  } finally { batch.dispose(); }
});

test('on-demand search retains legacy requests after continuation without scanning old tool output again', () => {
  const full = task(); full.runs = [];
  full.events.push({ id: 'old', kind: 'message', role: 'user', text: 'legacy goal', at: 1 });
  full.events.push({ id: 'output', kind: 'output', text: 'only output', at: 1 });
  assert.deepEqual(searchTaskIds([full], 'project', false, 'legacy goal'), ['task']);
  full.runs.push(task().runs![0]); full.events.push({ id: 'new', kind: 'message', role: 'user', text: 'new goal', at: 2 });
  assert.deepEqual(searchTaskIds([full], 'project', false, 'legacy goal'), ['task']);
  assert.deepEqual(searchTaskIds([full], 'project', false, 'new goal'), ['task']);
  Object.defineProperty(full.events[1], 'kind', { get: () => { throw new Error('old tool event rescanned'); } });
  assert.deepEqual(searchTaskIds([full], 'project', false, 'latest request'), ['task']);
  assert.deepEqual(searchTaskIds([full], 'project', false, 'only output'), []);
  assert.deepEqual(searchTaskIds([full], 'other project', false, 'legacy'), []);
  full.archivedAt = 1;
  assert.deepEqual(searchTaskIds([full], 'project', false, 'legacy'), []);
  assert.deepEqual(searchTaskIds([full], 'project', true, 'legacy'), ['task']);
});

test('incremental updates preserve untouched task identities and reject late catalog data', () => {
  const first = taskSummary(task('a'), 1), second = taskSummary(task('b'), 1);
  const initial: Snapshot = { sequence: 2, projects: [], tasks: [first, second], settings: defaults, activeId: 'a' };
  const next = applyUpdate(initial, { sequence: 3, tasks: [{ ...second, revision: 2, status: 'completed' }], activeId: undefined });
  assert.equal(next.tasks[0], first); assert.equal(next.tasks[1].status, 'completed'); assert.equal(next.activeId, undefined);
  assert.equal(applyUpdate(next, { sequence: 2, tasks: [second], activeId: 'b' }), next);
  const same = applyUpdate(next, { sequence: 4, tasks: [second] }); assert.equal(same.tasks[1], next.tasks[1]);
  const added = applyUpdate(same, { sequence: 5, tasks: [taskSummary({ ...task('c'), createdAt: 2 }, 1)] });
  assert.equal(added.tasks[0].id, 'c'); assert.equal(added.tasks.length, 3);
});

test('stream batches send new text only, recover mid-response and reject late or duplicate frames', async () => {
  const frames: StreamFrame[] = [], stream = new ReplyStream(frame => frames.push(frame));
  try {
    stream.start('task', 'run');
    for (let i = 0; i < 1000; i++) stream.append('task', 'run', String(i % 10));
    assert.equal(frames.length, 1);
    const restored = new StreamAccumulator('task', 'run'); restored.seed(stream.snapshot('task'));
    stream.flush(); assert.equal(frames.length, 2); assert.equal(frames[1].text.length, 1000);
    assert.equal(restored.apply(frames[1]), 'ignored');
    stream.append('task', 'run', 'suffix'); stream.flush();
    assert.equal(frames[2].text, 'suffix'); assert.equal(frames[2].offset, 1000);
    assert.equal(restored.apply(frames[2]), 'changed'); assert.equal(restored.state.text, '0123456789'.repeat(100) + 'suffix');
    assert.equal(restored.apply(frames[2]), 'ignored');
    const lost = new StreamAccumulator('task', 'run'); lost.apply(frames[0]); assert.equal(lost.apply(frames[2]), 'gap');
    assert.ok(lost.seed(stream.snapshot('task'))); assert.equal(lost.state.text, restored.state.text);
    stream.append('task', 'run', 'pending final text'); stream.end('task');
    assert.equal(restored.apply(frames.at(-1)!), 'changed'); assert.equal(restored.state.ended, true);
    const count = frames.length; await new Promise(resolve => setTimeout(resolve, streamDelay + 10)); assert.equal(frames.length, count);
    stream.start('task', 'run'); restored.apply(frames.at(-1)!); assert.equal(restored.state.text, '');
    assert.equal(restored.apply(frames[2]), 'ignored');
    assert.equal(restored.apply({ ...frames[2], runId: 'other-run', version: 9999 }), 'ignored');
  } finally { stream.dispose(); }
});

test('task details coalesce requests, refresh the newest revision and ignore switched-task responses', async () => {
  const requests: { id: string; resolve: (task: TaskDetail) => void }[] = [];
  const api = { taskDetail: (id: string) => new Promise<TaskDetail>(resolve => requests.push({ id, resolve })) };
  const loader = new DetailLoader(() => {}), summary = (id: string, revision: number) => taskSummary(task(id), revision);
  loader.update(summary('a', 1), api); loader.update(summary('a', 2), api); loader.update(summary('a', 3), api);
  assert.equal(requests.length, 1);
  requests[0].resolve(taskDetail(task('a'), 1)); await tick(); assert.equal(requests.length, 2);
  requests[1].resolve(taskDetail(task('a'), 3)); await tick(); assert.equal(loader.value?.revision, 3); assert.equal(loader.loading, false);
  loader.update(summary('a', 3), api); assert.equal(requests.length, 2);
  loader.update(summary('a', 4), api); loader.update(summary('b', 1), api);
  requests[3].resolve(taskDetail(task('b'), 1)); await tick(); requests[2].resolve(taskDetail(task('a'), 4)); await tick();
  assert.equal(loader.value?.id, 'b'); assert.equal(loader.loading, false);
  loader.update(summary('b', 2), api); loader.dispose(); requests[4].resolve(taskDetail(task('b'), 2)); await tick();
  assert.equal(loader.value, undefined);
});

test('detail failures preserve loaded content and support a manual retry', async () => {
  const loader = new DetailLoader(() => {}), summary = taskSummary(task(), 1);
  loader.update(summary, { taskDetail: async () => { throw new Error('failed detail'); } }); await tick();
  assert.equal(loader.error, 'failed detail'); assert.equal(loader.loading, false);
  loader.retry({ taskDetail: async () => taskDetail(task(), 1) }); await tick();
  assert.equal(loader.value?.id, 'task'); assert.equal(loader.error, undefined);
  loader.update({ ...summary, revision: 2 }, { taskDetail: async () => { throw new Error('later failure'); } }); await tick();
  assert.equal(loader.value?.revision, 1); assert.equal(loader.error, 'later failure');
});

test('unchanged history keeps array and event identities across progress-only detail refreshes', () => {
  const full = task(); full.events = Array.from({ length: 250 }, (_, i) => ({ id: String(i), kind: 'notice' as const, at: i, text: 'history' }));
  const history = new EventHistory(); history.update(taskDetail(full, 1));
  const loaded = history.events;
  history.update(structuredClone(taskDetail(full, 2))); assert.equal(history.events, loaded); assert.equal(history.events[0], loaded[0]);
  full.events.push({ id: 'new', kind: 'notice', at: 251, text: 'new' }); history.update(taskDetail(full, 3));
  assert.notEqual(history.events, loaded); assert.equal(history.events[0], loaded[0]); assert.equal(history.events.at(-1)?.id, 'new');
});

test('session run selection survives restoration from lightweight task summaries', () => {
  const full = task(), session = emptySession(), view = { ...emptyView('project', full.id), runId: full.currentRunId! };
  rememberView(session, view);
  const snapshot = { projects: [{ id: 'project', path: '/sample', name: 'sample' }], tasks: [taskSummary(full, 1)] };
  assert.equal(restoreView(session, snapshot).runId, full.currentRunId);
  snapshot.tasks[0].runIds = []; assert.equal(restoreView(session, snapshot).runId, '');
});

test('preload exposes on-demand requests and removes streaming listeners without exposing IPC events', async () => {
  let api: any; const invoked: unknown[][] = [], listeners = new Map<string, Function>();
  const renderer = { invoke: (...args: unknown[]) => { invoked.push(args); return Promise.resolve(); }, on: (channel: string, fn: Function) => listeners.set(channel, fn), removeListener: (channel: string, fn: Function) => { assert.equal(listeners.get(channel), fn); listeners.delete(channel); } };
  vm.runInNewContext(fs.readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8'), { require: () => ({ contextBridge: { exposeInMainWorld: (_name: string, value: any) => api = value }, ipcRenderer: renderer }) });
  await api.taskDetail('task'); await api.planText('task', 'run'); await api.changePatch({ taskId: 'task', path: 'a.txt' }); await api.searchTasks({ projectId: 'project', archived: false, query: 'old' });
  assert.deepEqual(invoked.map(args => args[0]), ['task:detail', 'runs:plan', 'changes:patch', 'tasks:search']);
  let received: unknown; const off = api.onDelta((value: unknown) => received = value), value = { taskId: 'task', text: 'chunk' };
  listeners.get('task:delta')!({ privileged: true }, value); assert.equal(received, value); off(); assert.ok(!listeners.has('task:delta'));
});
