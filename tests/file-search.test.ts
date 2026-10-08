import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileNameIndex, walkSearchFiles } from '../engine/file-search';
import { projectFiles, searchFiles } from '../engine/project-files';
import { ToolRegistry } from '../engine/tools';

async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'jalo-search-')), root = path.join(home, 'project');
  await fs.mkdir(root);
  const controller = new AbortController();
  const tools = new ToolRegistry({ root, backupDir: path.join(home, 'backups'), signal: controller.signal, timeout: 1, mode: 'review', emit: () => {}, approve: async () => false });
  await tools.init();
  return { home, root, tools, controller, cleanup: () => fs.rm(home, { recursive: true, force: true }) };
}

test('filename queries share one scan, reuse names without reading contents, and validate only directories', async t => {
  const x = await fixture();
  try {
    await fs.mkdir(path.join(x.root, 'src'));
    await Promise.all(Array.from({ length: 400 }, (_, i) => fs.writeFile(path.join(x.root, 'src', `File${i}.ts`), 'body')));
    const open = fs.opendir, lstat = fs.lstat; let opens = 0, stats = 0;
    t.mock.method(fs, 'opendir', async (full: string) => { opens++; return open(full); });
    t.mock.method(fs, 'lstat', async (full: string) => { stats++; return lstat(full); });
    t.mock.method(fs, 'readFile', () => { throw new Error('Filename search must not read bodies'); });
    const index = new FileNameIndex();
    const [a, b] = await Promise.all([index.search(x.root, 'file12', x.tools), index.search(x.root, 'file23', x.tools)]);
    assert.equal(opens, 2); assert.ok(a.paths.includes('src/File12.ts')); assert.ok(b.paths.includes('src/File23.ts'));
    const before = stats;
    assert.deepEqual(await index.search(x.root, 'SRC/FILE12.TS', x.tools), { paths: ['src/File12.ts'], truncated: false });
    assert.equal(opens, 2); assert.equal(stats - before, 2);
  } finally { t.mock.restoreAll(); await x.cleanup(); }
});

test('cached names reflect creates, renames, deletes and file or parent link replacements', async () => {
  const x = await fixture();
  try {
    await fs.mkdir(path.join(x.root, 'src')); await fs.writeFile(path.join(x.root, 'src', 'one.ts'), 'one');
    const index = new FileNameIndex();
    const search = () => index.search(x.root, '.ts', x.tools);
    assert.deepEqual((await search()).paths, ['src/one.ts']);
    await fs.writeFile(path.join(x.root, 'src', 'two.ts'), 'two');
    assert.deepEqual((await search()).paths, ['src/one.ts', 'src/two.ts']);
    await fs.rename(path.join(x.root, 'src', 'two.ts'), path.join(x.root, 'src', 'three.ts'));
    assert.deepEqual((await search()).paths, ['src/one.ts', 'src/three.ts']);
    await fs.unlink(path.join(x.root, 'src', 'one.ts'));
    await fs.symlink('three.ts', path.join(x.root, 'src', 'one.ts'));
    assert.deepEqual((await search()).paths, ['src/three.ts']);
    await fs.rename(path.join(x.root, 'src'), path.join(x.home, 'moved'));
    await fs.symlink(path.join(x.home, 'moved'), path.join(x.root, 'src'));
    assert.deepEqual((await search()).paths, []);
    await fs.rm(path.join(x.root, 'src')); await fs.mkdir(path.join(x.root, 'src'));
    await fs.writeFile(path.join(x.root, 'src', 'new.ts'), 'new');
    assert.deepEqual((await search()).paths, ['src/new.ts']);
  } finally { await x.cleanup(); }
});

test('result cap does not prevent a later narrow query from finding other indexed files', async () => {
  const x = await fixture();
  try {
    await Promise.all(Array.from({ length: 100 }, (_, i) => fs.writeFile(path.join(x.root, `f${String(i).padStart(3, '0')}.ts`), '')));
    const broad = await searchFiles(x.root, '');
    assert.equal(broad.paths.length, 80); assert.equal(broad.truncated, true);
    assert.deepEqual(await searchFiles(x.root, 'f099.ts'), { paths: ['f099.ts'], truncated: false });
    assert.deepEqual(await searchFiles(x.root, 'missing'), { paths: [], truncated: false });
    await Promise.all(Array.from({ length: 20 }, (_, i) => fs.unlink(path.join(x.root, `f${String(i).padStart(3, '0')}.ts`))));
    const exact = await searchFiles(x.root, '.ts'); assert.equal(exact.paths.length, 80); assert.equal(exact.truncated, false);
  } finally { await x.cleanup(); }
});

test('index ignores dependency trees, links and special files; roots remain isolated and safe', async () => {
  const x = await fixture();
  try {
    for (const directory of ['.git', 'node_modules', 'dist', 'build', '.next', '.venv', 'coverage']) {
      await fs.mkdir(path.join(x.root, directory)); await fs.writeFile(path.join(x.root, directory, 'secret.ts'), 'secret');
    }
    await fs.mkdir(path.join(x.root, 'empty')); await fs.writeFile(path.join(x.root, 'visible.ts'), '');
    await fs.writeFile(path.join(x.home, 'outside.ts'), '');
    await fs.symlink(x.home, path.join(x.root, 'linked')); await fs.symlink('visible.ts', path.join(x.root, 'link.ts'));
    assert.deepEqual(await searchFiles(x.root, '.ts'), { paths: ['visible.ts'], truncated: false });
    const other = path.join(x.home, 'other'); await fs.mkdir(other); await fs.writeFile(path.join(other, 'other.ts'), '');
    assert.deepEqual((await searchFiles(other, '.ts')).paths, ['other.ts']);
    await assert.rejects(x.tools.execute('search_files', { query: '.ts', mode: 'name', path: '../' }), /范围/);
    await assert.rejects(x.tools.execute('search_files', { query: '.ts', mode: 'name', path: 'linked' }), /范围|符号链接/);
    await assert.rejects(x.tools.execute('search_files', { query: '.ts', mode: 'name', path: '.git' }), /\.git/);
  } finally { await x.cleanup(); }
});

test('entry budget bounds enumeration, reports incomplete results, and closes handles', async t => {
  const x = await fixture();
  try {
    await Promise.all(Array.from({ length: 120 }, (_, i) => fs.writeFile(path.join(x.root, `${i}.txt`), '')));
    const open = fs.opendir, handles: Awaited<ReturnType<typeof fs.opendir>>[] = [];
    t.mock.method(fs, 'opendir', async (full: string) => { const handle = await open(full); handles.push(handle); return handle; });
    const budget = { maxEntries: 20, visited: 0, truncated: false }, files: string[] = [];
    for await (const file of walkSearchFiles(x.tools, '.', budget)) files.push(file);
    assert.equal(files.length, 20); assert.equal(budget.visited, 21); assert.equal(budget.truncated, true);
    assert.equal(handles.length, 1); await assert.rejects(async () => handles[0].read(), { code: 'ERR_DIR_CLOSED' });
    assert.equal((await new FileNameIndex({ maxEntries: 20 }).search(x.root, 'absent', x.tools)).truncated, true);
  } finally { t.mock.restoreAll(); await x.cleanup(); }
});

test('cache expiry, explicit invalidation and LRU eviction bound index lifetime', async t => {
  const x = await fixture();
  try {
    const other = path.join(x.home, 'other'); await fs.mkdir(other); const otherTools = await projectFiles(other);
    const open = fs.opendir; let opens = 0, now = 0;
    t.mock.method(fs, 'opendir', async (full: string) => { opens++; return open(full); });
    const index = new FileNameIndex({ maxProjects: 1, maxAgeMs: 100, now: () => now });
    await index.search(x.root, '', x.tools); await index.search(x.root, '', x.tools); assert.equal(opens, 1);
    now = 101; await index.search(x.root, '', x.tools); assert.equal(opens, 2);
    index.clear(x.root); await index.search(x.root, '', x.tools); assert.equal(opens, 3);
    await index.search(other, '', otherTools); await index.search(x.root, '', x.tools); assert.equal(opens, 5);
    index.clear(); await index.search(x.root, '', x.tools); assert.equal(opens, 6);
  } finally { t.mock.restoreAll(); await x.cleanup(); }
});

test('an incomplete index expires even when unvisited directories change', async t => {
  const x = await fixture();
  try {
    await fs.mkdir(path.join(x.root, 'nested'));
    await fs.writeFile(path.join(x.root, 'nested', 'old.ts'), '');
    const open = fs.opendir; let opens = 0, now = 0;
    t.mock.method(fs, 'opendir', async (full: string) => { opens++; return open(full); });
    const index = new FileNameIndex({ maxEntries: 1, now: () => now });
    assert.equal((await index.search(x.root, '', x.tools)).truncated, true); assert.equal(opens, 1);
    await fs.writeFile(path.join(x.root, 'nested', 'new.ts'), '');
    await index.search(x.root, '', x.tools); assert.equal(opens, 1);
    now = 1001; await index.search(x.root, '', x.tools); assert.equal(opens, 2);
  } finally { t.mock.restoreAll(); await x.cleanup(); }
});

test('failed scans are not cached and retry after the directory becomes available', async t => {
  const x = await fixture();
  try {
    await fs.writeFile(path.join(x.root, 'a.ts'), '');
    const open = fs.opendir; let fail = true;
    t.mock.method(fs, 'opendir', async (full: string) => { if (fail) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return open(full); });
    const index = new FileNameIndex();
    await assert.rejects(index.search(x.root, '', x.tools), /denied/); fail = false;
    assert.deepEqual((await index.search(x.root, '', x.tools)).paths, ['a.ts']);
  } finally { t.mock.restoreAll(); await x.cleanup(); }
});

test('model filename search avoids per-file resolution and stops before queued subtrees', async t => {
  const x = await fixture();
  try {
    await fs.mkdir(path.join(x.root, 'nested')); await fs.writeFile(path.join(x.root, 'nested', 'hit.ts'), '');
    await Promise.all(Array.from({ length: 120 }, (_, i) => fs.writeFile(path.join(x.root, `hit${i}.ts`), '')));
    const open = fs.opendir, resolve = x.tools.resolve.bind(x.tools); let opens = 0, resolves = 0;
    const handles: Awaited<ReturnType<typeof fs.opendir>>[] = [];
    t.mock.method(fs, 'opendir', async (full: string) => { opens++; const handle = await open(full); handles.push(handle); return handle; });
    t.mock.method(x.tools, 'resolve', async (relative: string) => { resolves++; return resolve(relative); });
    const result = await x.tools.execute('search_files', { query: 'HIT', mode: 'name' });
    assert.equal(result.split('\n').filter(line => line.endsWith('.ts')).length, 50);
    assert.match(result, /上限/); assert.equal(opens, 1); assert.ok(resolves < 10);
    await assert.rejects(async () => handles[0].read(), { code: 'ERR_DIR_CLOSED' });
  } finally { t.mock.restoreAll(); await x.cleanup(); }
});

test('model content search preserves literal matches and line numbers, skips non-text files, and reads fresh content', async () => {
  const x = await fixture();
  try {
    await fs.mkdir(path.join(x.root, 'src'));
    await fs.writeFile(path.join(x.root, 'src', 'a.txt'), 'First\r\nneedle.* 字面量\r\nneedle.* again\n');
    await fs.writeFile(path.join(x.root, 'src', 'binary.txt'), Buffer.from([0, 1, 2]));
    await fs.writeFile(path.join(x.root, 'src', 'invalid.txt'), Buffer.from([0xff]));
    await fs.writeFile(path.join(x.root, 'src', 'large.txt'), 'needle.*'.repeat(40000));
    await fs.writeFile(path.join(x.root, 'outside.txt'), 'needle.* outside');
    const query = { query: 'needle.*', mode: 'content', path: 'src' };
    const result = await x.tools.execute('search_files', query);
    assert.equal(result, 'src/a.txt:2: needle.* 字面量\r\nsrc/a.txt:3: needle.* again');
    await fs.writeFile(path.join(x.root, 'src', 'a.txt'), 'changed\nneedle.* new');
    assert.equal(await x.tools.execute('search_files', query), 'src/a.txt:2: needle.* new');
    assert.equal(await x.tools.execute('search_files', { ...query, query: 'NEEDLE.*' }), '没有匹配结果');
  } finally { await x.cleanup(); }
});

test('content match cap stops subsequent file reads and cancellation propagates', async t => {
  const x = await fixture();
  try {
    await fs.writeFile(path.join(x.root, 'many.txt'), 'hit\n'.repeat(100));
    await fs.writeFile(path.join(x.root, 'also.txt'), 'hit\n'.repeat(100));
    const read = x.tools.read.bind(x.tools); let contentReads = 0, cancel = false;
    t.mock.method(x.tools, 'read', async (full: string) => {
      if (!full.endsWith('AGENTS.md')) { contentReads++; if (cancel) x.controller.abort(new Error('stop search')); }
      return read(full);
    });
    const result = await x.tools.execute('search_files', { query: 'hit', mode: 'content' });
    assert.equal(result.split('\n').filter(line => line.includes(': hit')).length, 50); assert.equal(contentReads, 1);
    cancel = true;
    await assert.rejects(x.tools.execute('search_files', { query: 'hit', mode: 'content' }), /stop search/);
  } finally { t.mock.restoreAll(); await x.cleanup(); }
});
