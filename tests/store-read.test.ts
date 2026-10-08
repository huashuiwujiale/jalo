import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../electron/store';
import { pageTaskEvents } from '../shared/task-history';
import { taskDetail, taskSummary } from '../shared/task-wire';
import type { Task } from '../shared/types';

function task(id: string, count = 200): Task {
  const runId = `run-${id}`;
  return { id, projectId: 'project', title: `标题 ${id}`, model: 'mock', status: 'completed', createdAt: 1,
    currentRunId: runId, messages: [{ role: 'user', content: 'PRIVATE-CONTEXT'.repeat(1000) }], changes: [],
    events: Array.from({ length: count }, (_, i) => ({ id: `${id}-${i}`, at: i, kind: 'message', role: i === 0 ? 'user' : 'assistant', text: i === 0 ? '旧要求：保留 Export\n"按钮"' : `正文 ${i}` })),
    runs: [{ id: runId, taskId: id, mode: 'plan', input: '新要求：显示计划', createdAt: 1, status: 'completed', checks: [],
      references: [{ projectId: 'project', path: 'a.txt', startLine: 1, endLine: 1, version: 'old', content: 'PRIVATE-REFERENCE' }], planText: 'PRIVATE-PLAN'.repeat(1000),
      changes: [{ id: `change-${id}`, runId, path: 'a.txt', state: 'written', before: 'PRIVATE-BEFORE', after: 'PRIVATE-AFTER', patch: 'PRIVATE-PATCH', beforeVersion: 'old', afterVersion: 'new', check: { path: 'a.txt', status: 'skipped', parser: 'text', message: '文本', at: 1, version: 'new' } }] }],
  };
}

test('startup reads summaries only; details and cursor pages read at most 100 events without hydrating task bodies', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'jalo-lazy-')), file = path.join(home, 'state.sqlite');
  let store: Store | undefined;
  const fullRead = Store.prototype.task, runRead = Store.prototype.run;
  try {
    store = await Store.open(file);
    const long = task('long', 10000), others = Array.from({ length: 30 }, (_, i) => task(`other-${i}`));
    for (const value of [long, ...others]) store.deferTask(value);
    store.flush(); store.close(); store = undefined;
    const before = await fs.stat(file);
    Store.prototype.task = () => { throw new Error('unexpected full task read'); };
    Store.prototype.run = () => { throw new Error('unexpected checkpoint/plan read'); };
    store = await Store.open(file);
    assert.equal(store.summaries().length, 31);
    assert.deepEqual(store.summary(long.id), JSON.parse(JSON.stringify(taskSummary(long, 0))));
    const db = (store as any).db, prepare = db.prepare;
    let eventsRead = 0;
    db.prepare = function (sql: string, ...args: unknown[]) {
      const statement = prepare.call(this, sql, ...args);
      if (/^SELECT seq,data FROM task_events/.test(sql)) {
        const iterate = statement.iterate;
        statement.iterate = function* (...parameters: unknown[]) { for (const row of iterate.call(this, ...parameters)) { eventsRead++; yield row; } };
      }
      if (/SELECT data FROM (tasks|runs|checkpoints)(?:\s|$)/.test(sql)) throw new Error(`unexpected body read: ${sql}`);
      return statement;
    };
    const detail = store.detail(long.id, 7);
    assert.deepEqual(detail, JSON.parse(JSON.stringify(taskDetail(long, 7)))); assert.equal(eventsRead, 100);
    assert.ok(!JSON.stringify(detail).includes('PRIVATE-'));
    for (const cursor of [{ around: 'long-1234' }, { before: 'long-50' }, { after: 'long-9950' }, { around: 'long-9999' }, { before: 'long-0' }, { after: 'long-9999' }]) {
      const beforeRead = eventsRead;
      assert.deepEqual(store.events(long.id, cursor), pageTaskEvents(long, cursor));
      assert.ok(eventsRead - beforeRead <= 100);
    }
    assert.throws(() => store!.events(long.id, { around: 'other-0-100' }), /游标不存在/);
    assert.throws(() => store!.events(long.id, { after: 'long-1', before: 'long-2' } as any), /一个方向/);
    assert.throws(() => store!.detail('missing'), /任务不存在/);
    const beforeSearch = eventsRead;
    assert.equal(store.search('project', false, 'export\n"按钮"').length, 31);
    assert.equal(store.search('project', false, '新要求').length, 31);
    assert.deepEqual(store.search('project', false, '正文'), []);
    assert.deepEqual(store.search('other-project', false, '旧要求'), []);
    assert.equal(eventsRead, beforeSearch);
    db.prepare = prepare;
    store.close(); store = undefined;
    assert.equal((await fs.stat(file)).ino, before.ino, 'unchanged startup must not export the database');
  } finally { Store.prototype.task = fullRead; Store.prototype.run = runRead; store?.close(); await fs.rm(home, { recursive: true, force: true }); }
});

test('metadata edits preserve full history and plans; append saves keep catalog and search current', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'jalo-catalog-')); let store: Store | undefined;
  try {
    store = await Store.open(path.join(home, 'state.sqlite'));
    assert.throws(() => store!.updateMetadata('missing', { title: 'invalid' }), /任务不存在/);
    const value = task('task', 1200); store.putTask(value);
    const db = (store as any).db, prepare = db.prepare;
    db.prepare = function (sql: string, ...args: unknown[]) {
      if (/^SELECT .* FROM (task_events|runs|checkpoints)\b/.test(sql)) throw new Error('metadata edit loaded history');
      return prepare.call(this, sql, ...args);
    };
    store.updateMetadata(value.id, { title: '改名后', archivedAt: 123 });
    assert.deepEqual(store.search('project', false, '旧要求'), []);
    assert.deepEqual(store.search('project', true, '改名后'), [value.id]);
    assert.deepEqual(store.search('project', true, '旧要求'), [value.id]);
    store.updateMetadata(value.id, { archivedAt: undefined });
    db.prepare = prepare;
    const restored = store.task(value.id);
    assert.deepEqual(restored, { ...value, title: '改名后' });
    assert.equal(store.run(value.id, value.currentRunId!).planText, value.runs![0].planText);
    assert.throws(() => store!.run('other-task', value.currentRunId!), /不完整/);
    restored.events.push({ id: 'new-request', at: 9999, kind: 'message', role: 'user', text: '追加要求' });
    store.putTask(restored, restored.currentRunId);
    assert.equal(store.summary(value.id).eventCount, 1201); assert.equal(store.summary(value.id).requestCount, 3);
    assert.deepEqual(store.search('project', false, '追加要求'), [value.id]);
    assert.equal(store.detail(value.id).events.at(-1)!.id, 'new-request');
    const previous = store.summary(value.id);
    restored.title = 'failed'; restored.events.push(restored.events[0]);
    assert.throws(() => store!.putTask(restored), /UNIQUE/);
    assert.deepEqual(store.summary(value.id), previous, 'catalog rolls back with event and task writes');
    restored.events.pop(); restored.title = '改名后'; store.putTask(restored);
    db.prepare('DELETE FROM task_events WHERE task_id=? AND seq=1100').run(value.id);
    assert.throws(() => store!.events(value.id, { around: 'task-1101' }), /历史记录不完整/);
    assert.throws(() => store!.task(value.id), /历史记录不完整/);
  } finally { store?.close(); await fs.rm(home, { recursive: true, force: true }); }
});

test('v5 migration backs up original bytes and only unfinished tasks hydrate on subsequent startup', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'jalo-v6-')), file = path.join(home, 'state.sqlite');
  let store: Store | undefined; const fullRead = Store.prototype.task;
  try {
    store = await Store.open(file);
    const completed = task('completed'), interrupted = task('interrupted');
    interrupted.status = 'waiting'; interrupted.approval = { id: 'approval', command: 'node --version', cwd: home, timeout: 1 };
    interrupted.runs![0].status = 'running'; interrupted.runs![0].changes[0].state = 'prepared';
    interrupted.runs![0].progress = { phase: 'approval', since: 1 };
    store.putTask(completed); store.putTask(interrupted); store.close(); store = undefined;
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode=DELETE; DROP TABLE task_catalog; PRAGMA user_version=5');
    db.close(); const bytes = await fs.readFile(file);
    const reads: string[] = [];
    Store.prototype.task = function (id) { reads.push(id); return fullRead.call(this, id); };
    store = await Store.open(file);
    assert.deepEqual(new Set(reads), new Set([completed.id, interrupted.id]));
    const backup = (await fs.readdir(home)).find(name => name.includes('before-v6'))!;
    assert.deepEqual(await fs.readFile(path.join(home, backup)), bytes);
    assert.deepEqual(store.task(completed.id), completed);
    const recovered = store.task(interrupted.id);
    assert.equal(recovered.status, 'interrupted'); assert.equal(recovered.approval, undefined);
    assert.equal(recovered.runs![0].status, 'interrupted'); assert.ok(recovered.runs![0].progress!.endedAt);
    assert.equal(recovered.runs![0].changes[0].state, 'uncertain');
    store.putTask(interrupted); store.close(); store = undefined; reads.length = 0;
    store = await Store.open(file); assert.deepEqual(reads, [interrupted.id]);
    assert.equal(store.detail(interrupted.id).runs[0].changes[0].state, 'uncertain');
    store.close(); store = undefined; reads.length = 0;
    store = await Store.open(file); assert.deepEqual(reads, []);
    assert.equal((await fs.readdir(home)).filter(name => name.includes('before-v6')).length, 1);
  } finally { Store.prototype.task = fullRead; store?.close(); await fs.rm(home, { recursive: true, force: true }); }
});
