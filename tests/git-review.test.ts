import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse } from '@babel/parser';
import { gitStatus, gitPatch, parseGitStatus } from '../engine/git-review';
import { diffLines } from '../shared/diff-lines';
import { runView } from '../shared/task-wire';
import { workerInput } from '../shared/worker-wire';
import { emptyView, viewSchema } from '../shared/session';
import type { Task } from '../shared/types';
const exec = promisify(execFile);
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jalo-git-'));
  const git = (...args: string[]) => exec('/usr/bin/git', ['-C', root, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Jalo Test', '-c', 'user.email=test@jalo.invalid', ...args]);
  await git('init', '-q');
  return { root, git, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}
test('Git review captures staged, unstaged, new, deleted and renamed files without running diff drivers', async () => {
  const x = await fixture();
  try {
    for (const file of ['a.txt', 'deleted.txt', 'renamed.txt', ':(glob)*']) await fs.writeFile(path.join(x.root, file), 'old\n');
    await fs.writeFile(path.join(x.root, '.gitattributes'), '*.txt diff=evil\n');
    await x.git('add', '.'); await x.git('commit', '-qm', 'baseline');
    const marker = path.join(x.root, 'driver-ran');
    await x.git('config', 'diff.evil.command', `touch '${marker}'`); await x.git('config', 'diff.evil.textconv', `touch '${marker}'`);
    await fs.writeFile(path.join(x.root, 'a.txt'), 'staged\n'); await x.git('add', 'a.txt'); await fs.writeFile(path.join(x.root, 'a.txt'), 'working\n');
    await fs.rm(path.join(x.root, 'deleted.txt')); await x.git('mv', 'renamed.txt', 'renamed new.txt');
    await fs.writeFile(path.join(x.root, ':(glob)*'), 'literal\n'); await fs.writeFile(path.join(x.root, 'new 你好.txt'), 'new\n');
    const status = await gitStatus(x.root); assert.equal(status.available, true); assert.equal(status.truncated, false);
    assert.deepEqual(status.files.find(f => f.path === 'a.txt'), { path: 'a.txt', index: 'M', workingTree: 'M' });
    const patch = await gitPatch(x.root, 'a.txt'); assert.match(patch.patch, /-old\n\+working/); assert.ok(!patch.patch.includes('+staged'));
    assert.match((await gitPatch(x.root, 'new 你好.txt')).patch, /\+new/);
    const deleted = await gitPatch(x.root, 'deleted.txt'); assert.equal(deleted.deleted, true); assert.match(deleted.patch, /-old/);
    const renamed = status.files.find(f => f.path === 'renamed new.txt'); assert.equal(renamed?.originalPath, 'renamed.txt');
    assert.match((await gitPatch(x.root, 'renamed new.txt')).patch, /renamed new.txt/);
    assert.match((await gitPatch(x.root, ':(glob)*')).patch, /\+literal/);
    await assert.rejects(fs.access(marker));
    const index = (await x.git('ls-files', '--stage')).stdout;
    assert.equal((await gitPatch(x.root, 'a.txt', patch.version)).version, patch.version);
    assert.equal((await x.git('ls-files', '--stage')).stdout, index);
    await fs.writeFile(path.join(x.root, 'a.txt'), 'external\n'); await assert.rejects(gitPatch(x.root, 'a.txt', patch.version), /差异已变化/);
    await assert.rejects(gitPatch(x.root, '../escape'), /项目范围/);
    await fs.mkdir(path.join(x.root, 'nested')); await assert.rejects(gitStatus(path.join(x.root, 'nested')), /根目录/);
  } finally { await x.cleanup(); }
});
test('Git review handles unborn repositories, bounds results and rejects unsafe or oversized files', async () => {
  const x = await fixture();
  try {
    await fs.writeFile(path.join(x.root, 'new.txt'), 'new\n'); assert.match((await gitPatch(x.root, 'new.txt')).patch, /\/dev\/null/);
    await fs.writeFile(path.join(x.root, 'binary.bin'), Buffer.from([0, 255])); await assert.rejects(gitPatch(x.root, 'binary.bin'), /二进制/);
    await fs.writeFile(path.join(x.root, 'large.txt'), 'x'.repeat(262145)); await assert.rejects(gitPatch(x.root, 'large.txt'), /256 KB/);
    await fs.symlink(path.join(x.root, 'new.txt'), path.join(x.root, 'link.txt')); await assert.rejects(gitPatch(x.root, 'link.txt'), /符号链接/);
    await fs.writeFile(path.join(x.root, 'huge-diff.txt'), 'large line\n'.repeat(7000)); assert.equal((await gitPatch(x.root, 'huge-diff.txt')).truncated, true);
    for (let i = 0; i < 210; i++) await fs.writeFile(path.join(x.root, `z-${i}.txt`), 'new');
    const status = await gitStatus(x.root); assert.equal(status.files.length, 200); assert.equal(status.truncated, true);
    const plain = path.join(os.tmpdir(), 'jalo-plain-' + Date.now()); await fs.mkdir(plain);
    try { assert.equal((await gitStatus(plain)).available, false); } finally { await fs.rm(plain, { recursive: true }); }
  } finally { await x.cleanup(); }
});
test('NUL status and unified diff row numbers preserve filenames and line navigation', () => {
  assert.deepEqual(parseGitStatus('R  new name\0old\nname\0?? :(glob)*\0'), [{ path: 'new name', originalPath: 'old\nname', index: 'R', workingTree: ' ' }, { path: ':(glob)*', index: '?', workingTree: '?' }]);
  const rows = diffLines('--- a/file\n+++ b/file\n@@ -10,3 +20,3 @@\n keep\n-old\n+new\n keep\n\\ No newline at end of file');
  assert.equal(rows[0].oldLine, undefined); assert.equal(rows[1].newLine, undefined);
  assert.deepEqual(rows.slice(3, 7).map(r => [r.kind, r.oldLine, r.newLine]), [['context', 10, 20], ['deletion', 11, undefined], ['addition', undefined, 21], ['context', 12, 22]]);
  assert.equal(rows.at(-1)!.kind, 'metadata');
});
test('Git review drafts persist metadata, task views omit patches and workers get the captured target', async () => {
  const gitReview = { path: 'file.txt', version: 'a'.repeat(64), patch: '-old\n+new' };
  const task: Task = { id: 'task', projectId: 'project', title: 'review', status: 'queued', model: 'mock', createdAt: 1, messages: [{ role: 'user', content: 'old' }, { role: 'user', content: 'review captured diff' }], events: [], changes: [], currentRunId: 'run', runs: [{ id: 'run', taskId: 'task', mode: 'review', input: 'review', createdAt: 1, status: 'queued', references: [], changes: [], checks: [], gitReview }] };
  const view = runView(task.runs![0]); assert.ok(!('patch' in view.gitReview!)); assert.equal(view.gitReview?.version, gitReview.version);
  const wire = workerInput(task); assert.equal(wire.archiveLength, 1); assert.deepEqual(wire.input.reviewChanges, [{ path: 'file.txt', patch: gitReview.patch }]); assert.ok(!('patch' in wire.input.run.gitReview!));
  assert.deepEqual(viewSchema.parse({ ...emptyView(''), gitReview: view.gitReview }).gitReview, view.gitReview);
  for (const file of ['src/main.tsx', 'src/git-panel.tsx', 'src/reliability.tsx']) parse(await fs.readFile(file, 'utf8'), { sourceType: 'module', plugins: ['typescript', 'jsx'] });
});
