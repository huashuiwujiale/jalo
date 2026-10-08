import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import initSqlJs from 'sql.js';
import { Store, taskSaveDelay } from '../electron/store';
import type { Task, Run, RunChange } from '../shared/types';
import { defaults } from '../shared/types';

const run = (id: string, taskId = 'task'): Run => ({ id, taskId, mode: 'execute', input: id, createdAt: 1, status: 'completed', references: [], changes: [], checks: [] });
const task = (id = 'task'): Task => ({ id, projectId: 'project', title: '任务', status: 'completed', model: 'mock', createdAt: 1, events: [], messages: [], changes: [], runs: [run('run-' + id, id)], currentRunId: 'run-' + id });
const event = (id: string) => ({ id, kind: 'notice' as const, text: id, at: 1 });
const checkpoint = (runId: string): RunChange => ({ id: 'checkpoint-' + runId, runId, path: 'a.txt', before: 'old', after: 'new', beforeVersion: 'old-version', afterVersion: 'new-version', state: 'prepared', patch: '-old\n+new', check: { path: 'a.txt', status: 'skipped', parser: 'text', message: '文本', at: 1, version: 'new-version' } });
async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'jalo-store-')), file = path.join(home, 'state.sqlite');
  const store = await Store.open(file);
  return { home, file, store, cleanup: async () => { store.close(); await fs.rm(home, { recursive: true, force: true }); } };
}
function observe(store: Store) {
  const db = (store as any).db, originalExec = db.exec, originalPrepare = db.prepare;
  const counts = { commits: 0, tasks: 0, runs: 0, checkpoints: 0 };
  let before = 0;
  const changes = () => Number(originalPrepare.call(db, 'SELECT total_changes() AS count').get().count);
  db.exec = function (sql: string) {
    if (/^BEGIN\b/.test(sql)) before = changes();
    const result = originalExec.call(this, sql);
    if (/^COMMIT\b/.test(sql) && changes() > before) counts.commits++;
    return result;
  };
  db.prepare = function (sql: string) {
    const statement = originalPrepare.call(this, sql), table = sql.match(/^INSERT INTO (tasks|runs|checkpoints) /)?.[1];
    if (table) {
      const run = statement.run;
      statement.run = function (...args: any[]) {
        const result = run.apply(this, args);
        if (result.changes) counts[table as 'tasks' | 'runs' | 'checkpoints']++;
        return result;
      };
    }
    return statement;
  };
  return counts;
}
function diskRecord(file: string, table: string, id: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { const row = db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id); return row && JSON.parse(String(row.data)); }
  finally { db.close(); }
}
const diskTask = (file: string, id = 'task') => diskRecord(file, 'tasks', id);
function rejectCommit(store: Store) {
  const db = (store as any).db, exec = db.exec;
  db.exec = function (sql: string) { if (/^COMMIT\b/.test(sql)) throw new Error('模拟提交失败'); return exec.call(this, sql); };
  return () => { db.exec = exec; };
}

test('100 ordinary updates coalesce into one durable save with the newest progress and all events', async () => {
  const x = await fixture();
  try {
    const t = task(); x.store.putTask(t); const counts = observe(x.store);
    for (let i = 0; i < 100; i++) {
      t.events.push(event('event-' + i)); t.runs![0].progress = { phase: 'generating', since: i };
      x.store.deferTask(t, t.currentRunId);
    }
    assert.equal(counts.commits, 0); assert.equal(diskTask(x.file).historyLength, 0);
    await new Promise(r => setTimeout(r, taskSaveDelay + 30));
    assert.equal(counts.commits, 1); assert.equal(counts.tasks, 1); assert.equal(counts.runs, 1);
    assert.equal((await diskTask(x.file)).historyLength, 100);
    assert.equal(x.store.tasks()[0].runs![0].progress!.since, 99);
    const walSize = (await fs.stat(x.file + '-wal')).size;
    x.store.flush(); x.store.putTask(t, t.currentRunId); assert.equal(counts.commits, 1);
    assert.equal((await fs.stat(x.file + '-wal')).size, walSize, 'unchanged saves must not append WAL frames');
  } finally { await x.cleanup(); }
});

test('critical checkpoint saves drain all pending tasks and reach disk before returning', async () => {
  const x = await fixture();
  try {
    const t = task(), other = task('other'); x.store.putTask(t); x.store.putTask(other);
    const counts = observe(x.store);
    other.events.push(event('pending-other')); x.store.deferTask(other, other.currentRunId);
    t.events.push(event('pending-tool')); x.store.deferTask(t, t.currentRunId);
    t.runs![0].changes.push(checkpoint(t.currentRunId!)); x.store.putTask(t, t.currentRunId);
    assert.equal(counts.commits, 1); assert.equal(diskTask(x.file, 'other').historyLength, 1);
    const db = new DatabaseSync(x.file, { readOnly: true });
    try { assert.equal(JSON.parse(String(db.prepare('SELECT data FROM checkpoints').get()!.data)).state, 'prepared'); }
    finally { db.close(); }
    await new Promise(r => setTimeout(r, taskSaveDelay + 30)); assert.equal(counts.commits, 1);
    const reopened = await Store.open(x.file);
    try { assert.equal(reopened.tasks().find(t => t.id === 'task')!.runs![0].changes[0].state, 'uncertain'); }
    finally { reopened.close(); }
  } finally { await x.cleanup(); }
});

test('active-run saves append events without serializing old history or rewriting old runs/checkpoints', async () => {
  const x = await fixture();
  try {
    const t = task(), old = run('old'); old.changes.push({ ...checkpoint(old.id), state: 'written' }); old.planText = '历史正文'.repeat(2000);
    t.runs!.unshift(old); t.events.push(event('old-event')); x.store.putTask(t);
    const counts = observe(x.store);
    (old as any).toJSON = () => { throw new Error('old run serialized'); };
    (t.events[0] as any).toJSON = () => { throw new Error('old event serialized'); };
    t.events.push(event('new-event')); t.runs![1].progress = { phase: 'generating', since: 2 };
    x.store.putTask(t, t.currentRunId);
    assert.deepEqual(counts, { commits: 1, tasks: 1, runs: 1, checkpoints: 0 });
    const raw = await diskTask(x.file); assert.equal(raw.events, undefined); assert.equal(raw.runs, undefined); assert.deepEqual(raw.runIds, ['old', t.currentRunId]);
    const restored = x.store.tasks()[0]; assert.equal(restored.runs![0].planText, old.planText); assert.equal(restored.events.length, 2);
    delete (old as any).toJSON; old.changes[0].state = 'reverted';
    x.store.putTask(t, old.id); assert.equal(x.store.tasks()[0].runs![0].changes[0].state, 'reverted');
    assert.equal(counts.checkpoints, 1);
  } finally { await x.cleanup(); }
});

test('close drains pending writes; opening an unchanged completed database does not replace its file', async () => {
  const x = await fixture(); let closed = false;
  try {
    const t = task(); x.store.putTask(t); const counts = observe(x.store);
    t.events.push(event('last-event')); x.store.deferTask(t, t.currentRunId); x.store.close(); closed = true;
    assert.equal(counts.commits, 1);
    const before = await fs.stat(x.file), reopened = await Store.open(x.file);
    assert.equal(reopened.tasks()[0].events.at(-1)?.id, 'last-event'); reopened.close();
    assert.equal((await fs.stat(x.file)).ino, before.ino);
  } finally { if (!closed) x.store.close(); await fs.rm(x.home, { recursive: true, force: true }); }
});

test('deferred disk failure reports once, keeps the previous database intact and retries without duplicate events', async () => {
  const x = await fixture();
  try {
    const t = task(); x.store.putTask(t); const before = diskTask(x.file), db = (x.store as any).db;
    db.exec('PRAGMA query_only=ON'); let errors = 0;
    t.events.push(event('retained')); x.store.deferTask(t, t.currentRunId, () => errors++);
    await new Promise(r => setTimeout(r, taskSaveDelay + 30));
    assert.equal(errors, 1); assert.deepEqual(diskTask(x.file), before);
    assert.equal(x.store.hasPending(t.id), true);
    db.exec('PRAGMA query_only=OFF');
    t.events.push(event('after-recovery')); x.store.putTask(t, t.currentRunId);
    assert.deepEqual(x.store.tasks()[0].events.map(e => e.id), ['retained', 'after-recovery']);
    assert.equal((await diskTask(x.file)).historyLength, 2);
  } finally { (x.store as any).db.exec('PRAGMA query_only=OFF'); await x.cleanup(); }
});

test('synchronous flush failures notify every pending task once and retain updates for retry', async () => {
  for (const trigger of ['task', 'metadata', 'project', 'settings', 'close'] as const) {
    const x = await fixture();
    try {
      const first = task(), second = task('second'), errors = [0, 0];
      x.store.putTask(first); x.store.putTask(second);
      x.store.putProject({ id: 'project', name: 'original', path: x.home });
      x.store.putSettings(defaults);
      const before = [diskTask(x.file), diskTask(x.file, 'second')];
      for (const [i, value] of [first, second].entries()) {
        value.events.push(event('pending-' + value.id));
        x.store.deferTask(value, value.currentRunId, error => { assert.match(error.message, /模拟提交失败/); errors[i]++; });
      }
      const restore = rejectCommit(x.store);
      try {
        assert.throws(() => {
          if (trigger === 'task') { first.title = 'renamed'; x.store.putTask(first); }
          else if (trigger === 'metadata') x.store.updateMetadata(first.id, { title: 'renamed' });
          else if (trigger === 'project') x.store.putProject({ id: 'project', name: 'renamed', path: x.home });
          else if (trigger === 'settings') x.store.putSettings({ ...defaults, model: 'changed-model' });
          else x.store.close();
        }, /模拟提交失败/);
        assert.deepEqual(errors, [1, 1], trigger);
        await new Promise(r => setTimeout(r, taskSaveDelay + 30));
        assert.deepEqual(errors, [1, 1], 'cancelled timer must not notify twice');
        assert.deepEqual([diskTask(x.file), diskTask(x.file, 'second')], before);
        assert.equal(diskRecord(x.file, 'projects', 'project').name, 'original', 'project writes must roll back with pending tasks');
        assert.equal(diskRecord(x.file, 'settings', 'default').model, defaults.model, 'settings writes must roll back with pending tasks');
      } finally { restore(); }
      x.store.flush();
      if (trigger === 'task' || trigger === 'metadata') assert.equal(diskTask(x.file).title, 'renamed');
      if (trigger === 'project') assert.equal(diskRecord(x.file, 'projects', 'project').name, 'renamed');
      if (trigger === 'settings') assert.equal(diskRecord(x.file, 'settings', 'default').model, 'changed-model');
      const reopened = await Store.open(x.file);
      try {
        for (const value of reopened.tasks()) assert.deepEqual(value.events.map(e => e.id), ['pending-' + value.id]);
      } finally { reopened.close(); }
    } finally { await x.cleanup(); }
  }
});

test('transaction failure rolls back metadata and event append; retry preserves original history', async () => {
  const x = await fixture();
  try {
    const t = task(); t.events.push(event('original')); x.store.putTask(t); const before = diskTask(x.file);
    t.title = 'new-title'; t.events.push(event('original'));
    assert.throws(() => x.store.putTask(t), /UNIQUE/);
    assert.equal(x.store.tasks()[0].title, '任务'); assert.deepEqual(diskTask(x.file), before);
    t.events[1] = event('fixed'); x.store.putTask(t);
    assert.equal(x.store.tasks()[0].title, 'new-title'); assert.equal(x.store.tasks()[0].events.length, 2);
    const full = t.events; t.events = t.events.slice(1);
    assert.throws(() => x.store.putTask(t), /历史不能截短/);
    t.events = full; x.store.putTask(t);
    const other = task('other'); other.runs = [run(t.currentRunId!, 'other')];
    assert.throws(() => x.store.putTask(other), /拒绝覆盖历史/);
    other.runs = [run('other-run', 'other')]; x.store.putTask(other);
    assert.equal(x.store.tasks().find(t => t.id === 'task')!.runs![0].taskId, 'task');
  } finally { await x.cleanup(); }
});

test('v4 migration preserves full history, plans, references and rollback data with an original-byte backup', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'jalo-store-v5-')); let store: Store | undefined;
  try {
    const file = path.join(home, 'state.sqlite'), SQL = await initSqlJs(), db = new SQL.Database();
    db.run('CREATE TABLE tasks (id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE runs (id TEXT PRIMARY KEY,data TEXT NOT NULL); PRAGMA user_version=4');
    const t = task(); t.events = Array.from({ length: 1200 }, (_, i) => event(String(i)));
    t.runs![0].planText = '完整计划'.repeat(3000); t.runs![0].changes.push({ ...checkpoint(t.currentRunId!), state: 'written' });
    t.runs![0].references.push({ projectId: 'project', path: 'a.txt', startLine: 1, endLine: 1, version: 'version', content: 'old', scope: 'file' });
    db.run('INSERT INTO tasks VALUES (?,?)', [t.id, JSON.stringify(t)]); const bytes = Buffer.from(db.export()); db.close(); await fs.writeFile(file, bytes);
    store = await Store.open(file); assert.deepEqual(store.tasks()[0], t);
    const backup = (await fs.readdir(home)).find(n => n.includes('before-v5')); assert.ok(backup); assert.deepEqual(await fs.readFile(path.join(home, backup)), bytes);
    const raw = await diskTask(file); assert.equal(raw.events, undefined); assert.equal(raw.runs, undefined);
    store.close(); store = await Store.open(file); assert.deepEqual(store.tasks()[0], t);
    assert.equal((await fs.readdir(home)).filter(n => n.includes('before-v5')).length, 1);
  } finally { store?.close(); await fs.rm(home, { recursive: true, force: true }); }
});
