import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listDirectory } from '../engine/project-files';

test('directory browsing loads one level, includes empty folders and refuses unsafe paths', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'jalo-tree-'));
  const root = path.join(home, 'project');
  try {
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.mkdir(path.join(root, 'empty'));
    await fs.mkdir(path.join(root, '.git'));
    await fs.mkdir(path.join(root, 'node_modules'));
    await fs.writeFile(path.join(root, 'src', 'main.ts'), 'export {}');
    await fs.writeFile(path.join(root, 'README.md'), '# Hello');
    await fs.symlink(home, path.join(root, 'outside'));
    const result = await listDirectory(root);
    assert.deepEqual(result.entries.map(e => e.name), ['empty', 'node_modules', 'src', 'README.md']);
    assert.equal(result.truncated, false);
    assert.deepEqual((await listDirectory(root, 'src')).entries, [{ name: 'main.ts', path: 'src/main.ts', directory: false }]);
    assert.deepEqual((await listDirectory(root, 'empty')).entries, []);
    await assert.rejects(listDirectory(root, '../'));
    await assert.rejects(listDirectory(root, 'outside'));
    await assert.rejects(listDirectory(root, '.git'));
    await assert.rejects(listDirectory(root, 'missing'));
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('large directory listings signal truncation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jalo-tree-limit-'));
  try {
    await Promise.all(Array.from({ length: 1001 }, (_, i) => fs.writeFile(path.join(root, `${i}.txt`), '')));
    const result = await listDirectory(root);
    assert.equal(result.entries.length, 1000);
    assert.equal(result.truncated, true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
