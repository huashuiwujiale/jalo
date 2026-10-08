import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../electron/store';
import type { Task } from '../shared/types';

function task(): Task {
  return { id: 'task', projectId: 'project', title: '耐久性样例', model: 'mock', status: 'completed', createdAt: 1,
    events: [], messages: [], changes: [], currentRunId: 'run',
    runs: [{ id: 'run', taskId: 'task', mode: 'execute', input: '保存样例', createdAt: 1, status: 'completed', references: [], changes: [], checks: [] }] };
}

function data(db: DatabaseSync, table: 'tasks' | 'runs' | 'checkpoints', id: string) {
  return JSON.parse(String(db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id)!.data));
}

async function stopped(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close'); child.kill('SIGKILL'); await closed;
}

test('acknowledged history and checkpoints survive process exit and SIGKILL without a close or automatic execution', { timeout: 20000 }, async () => {
  for (const ending of ['exit', 'SIGKILL'] as const) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'jalo-durable-'));
    const file = path.join(home, 'data', 'state.sqlite'), source = path.join(home, 'a.txt'), marker = path.join(home, 'executed');
    let child: ChildProcess | undefined, store: Store | undefined;
    try {
      await fs.writeFile(source, 'before');
      const value = task(); value.status = 'waiting'; value.runs![0].status = 'running';
      value.approval = { id: 'approval', command: `touch ${marker}`, cwd: home, timeout: 1 };
      value.runs![0].progress = { phase: 'approval', since: 1 };
      value.runs![0].changes.push({ id: 'checkpoint', runId: 'run', path: 'a.txt', before: 'before', after: 'after', beforeVersion: 'old', afterVersion: 'new', state: 'prepared', patch: '-before\n+after', check: { path: 'a.txt', status: 'skipped', parser: 'text', message: '文本', at: 1, version: 'new' } });
      const script = path.join(home, 'writer.cjs');
      await fs.writeFile(script, `
const { Store } = require(${JSON.stringify(require.resolve('../electron/store'))});
(async () => {
  const store = await Store.open(${JSON.stringify(file)});
  const task = ${JSON.stringify(value)};
  store.putTask(task, task.currentRunId);
  task.events.push({ id: 'last-event', kind: 'notice', text: '已确认的最后记录', at: 2 });
  store.deferTask(task, task.currentRunId);
  store.putTask(task, task.currentRunId);
  process.send('committed');
  process.on('message', message => { if (message === 'exit') process.exit(0); });
})().catch(error => { console.error(error); process.exit(1); });
`);
      child = spawn(process.execPath, ['--require', require.resolve('tsx/cjs'), script], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      let output = ''; child.stderr!.on('data', chunk => { output += chunk; });
      const exit = once(child, 'exit');
      const committed = await Promise.race([
        once(child, 'message', { signal: AbortSignal.timeout(10000) }).then(([message]) => message),
        exit.then(([code, signal]) => { throw new Error(`writer exited before commit (${code ?? signal}): ${output}`); }),
      ]);
      assert.equal(committed, 'committed');
      assert.ok((await fs.stat(file + '-wal')).size > 0, 'committed data must still be in the WAL before abrupt exit');
      const reader = new DatabaseSync(file, { readOnly: true });
      try {
        assert.equal(data(reader, 'tasks', 'task').historyLength, 1);
        assert.equal(data(reader, 'checkpoints', 'checkpoint').state, 'prepared');
        assert.equal(reader.prepare('SELECT id FROM task_events WHERE task_id=?').get('task')!.id, 'last-event');
      } finally { reader.close(); }
      if (ending === 'exit') child.send('exit'); else child.kill('SIGKILL');
      const [code, signal] = await exit;
      assert.equal(ending === 'exit' ? code : signal, ending === 'exit' ? 0 : 'SIGKILL');
      const disk = new DatabaseSync(file, { readOnly: true });
      try {
        assert.equal(data(disk, 'tasks', 'task').historyLength, 1);
        assert.equal(data(disk, 'checkpoints', 'checkpoint').before, 'before');
        assert.equal(data(disk, 'checkpoints', 'checkpoint').after, 'after');
        assert.equal(data(disk, 'runs', 'run').status, 'running');
      } finally { disk.close(); }
      store = await Store.open(file);
      const recovered = store.task('task');
      assert.equal(recovered.status, 'interrupted'); assert.equal(recovered.approval, undefined);
      assert.equal(recovered.runs![0].status, 'interrupted'); assert.ok(recovered.runs![0].progress!.endedAt);
      assert.equal(recovered.runs![0].changes[0].state, 'uncertain');
      assert.deepEqual(recovered.events.map(event => event.id), ['last-event']);
      assert.equal(await fs.readFile(source, 'utf8'), 'before');
      await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
    } finally { if (child) await stopped(child); store?.close(); await fs.rm(home, { recursive: true, force: true }); }
  }
});

test('a small append to a large history writes bounded WAL pages without replacing or exporting the main file', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'jalo-wal-growth-')), file = path.join(home, 'data', 'state.sqlite');
  let store: Store | undefined;
  try {
    store = await Store.open(file);
    const value = task();
    value.events = Array.from({ length: 3000 }, (_, i) => ({ id: `history-${i}`, kind: 'notice' as const, text: `${i}:` + 'historical-text-'.repeat(150), at: i }));
    store.putTask(value);
    const checkpoint = new DatabaseSync(file);
    try { assert.equal(checkpoint.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()!.busy, 0); }
    finally { checkpoint.close(); }
    const before = await fs.stat(file); assert.ok(before.size > 5_000_000);
    assert.equal((await fs.stat(file + '-wal')).size, 0);
    value.events.push({ id: 'small-append', kind: 'notice', text: '新记录', at: 3001 });
    store.putTask(value, value.currentRunId);
    const after = await fs.stat(file), wal = await fs.stat(file + '-wal');
    assert.equal(after.ino, before.ino); assert.equal(after.size, before.size);
    assert.ok(wal.size > 0 && wal.size < before.size / 10, `small append wrote ${wal.size} bytes for a ${before.size}-byte database`);
    assert.ok(!(await fs.readdir(path.dirname(file))).some(name => name.endsWith('.tmp')));
    const reader = new DatabaseSync(file, { readOnly: true });
    try { assert.equal(reader.prepare('SELECT id FROM task_events WHERE task_id=? ORDER BY seq DESC LIMIT 1').get(value.id)!.id, 'small-append'); }
    finally { reader.close(); }
  } finally { store?.close(); await fs.rm(home, { recursive: true, force: true }); }
});

test('the store enables durable WAL commits and private permissions for its database and sidecars', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'jalo-wal-mode-')), file = path.join(home, 'data', 'state.sqlite');
  let store: Store | undefined;
  try {
    store = await Store.open(file); store.putTask(task());
    const db = (store as any).db;
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 2);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 7);
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
      for (const filename of [file, file + '-wal', file + '-shm']) assert.equal((await fs.stat(filename)).mode & 0o777, 0o600, filename);
    }
  } finally { store?.close(); await fs.rm(home, { recursive: true, force: true }); }
});

test('v6 upgrades preserve the original file and avoid hydrating completed task history', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'jalo-native-upgrade-')), file = path.join(home, 'state.sqlite');
  let store: Store | undefined; const readTask = Store.prototype.task;
  try {
    store = await Store.open(file); const value = task();
    value.events = Array.from({ length: 1200 }, (_, i) => ({ id: String(i), at: i, kind: 'notice', text: '历史内容' }));
    store.putTask(value); store.close(); store = undefined;
    const old = new DatabaseSync(file); old.exec('PRAGMA journal_mode=DELETE; PRAGMA user_version=6'); old.close();
    const bytes = await fs.readFile(file);
    Store.prototype.task = () => { throw new Error('v6 upgrade must not hydrate completed tasks'); };
    store = await Store.open(file);
    assert.equal(store.summary(value.id).eventCount, 1200); assert.equal(store.events(value.id, { around: '350' }).start, 300);
    const backups = (await fs.readdir(home)).filter(name => name.includes('before-v7'));
    assert.equal(backups.length, 1); assert.deepEqual(await fs.readFile(path.join(home, backups[0])), bytes);
    store.close(); store = undefined; store = await Store.open(file);
    assert.equal((await fs.readdir(home)).filter(name => name.includes('before-v7')).length, 1);
  } finally { Store.prototype.task = readTask; store?.close(); await fs.rm(home, { recursive: true, force: true }); }
});

test('migration backup includes committed WAL pages that have not reached the main database', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'jalo-wal-backup-')), file = path.join(home, 'state.sqlite');
  let store: Store | undefined, writer: DatabaseSync | undefined;
  try {
    store = await Store.open(file); store.putTask(task()); store.close(); store = undefined;
    writer = new DatabaseSync(file);
    writer.exec('PRAGMA wal_autocheckpoint=0; PRAGMA user_version=6');
    writer.prepare('INSERT INTO projects (id,data) VALUES (?,?)').run('last-project', JSON.stringify({ id: 'last-project', name: '仅在 WAL 中的新项目', path: home }));
    assert.ok((await fs.stat(file + '-wal')).size > 0);
    store = await Store.open(file);
    const backup = (await fs.readdir(home)).find(name => name.includes('before-v7'))!;
    const reader = new DatabaseSync(path.join(home, backup), { readOnly: true });
    try {
      assert.equal(reader.prepare('PRAGMA user_version').get()!.user_version, 6);
      assert.equal(JSON.parse(String(reader.prepare('SELECT data FROM projects WHERE id=?').get('last-project')!.data)).name, '仅在 WAL 中的新项目');
      assert.equal(reader.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    } finally { reader.close(); }
    assert.equal(store.projects()[0].id, 'last-project');
  } finally { store?.close(); writer?.close(); await fs.rm(home, { recursive: true, force: true }); }
});
