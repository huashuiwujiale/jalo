import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ToolRegistry } from '../engine/tools';
import type { EngineEvent } from '../shared/types';

test('delete an indented Vue button by read line numbers, keeping its neighbour and backup', async () => {
  const x = await setup();
  const button = ['          <el-button', `            v-hasPermi="['sale:voucher:add']"`, '            type="primary"', '            plain', '            icon="el-icon-plus"', '            size="mini"', '            @click="handleAdd"', '            >新增</el-button', '          >'];
  const prefix = '<template>\n', suffix = '          <el-button>导出</el-button>\n</template>\n';
  const original = prefix + button.join('\n') + '\n' + suffix;
  try {
    await fs.writeFile(path.join(x.root, 'voucher.vue'), original);
    await x.tools.execute('read_file', { path: 'voucher.vue', startLine: 2, lines: 9 });
    await assert.rejects(x.tools.execute('edit_file', { path: 'voucher.vue', oldText: button.map(l => l.trimStart()).join('\n'), newText: '' }), /没有匹配/);
    await x.tools.execute('replace_lines', { path: 'voucher.vue', startLine: 2, endLine: 10, newText: '' });
    assert.equal(await fs.readFile(path.join(x.root, 'voucher.vue'), 'utf8'), prefix + suffix);
    const change = x.events.find(e => e.type === 'change'); assert.ok(change?.type === 'change');
    assert.equal(change.change.before, original); assert.match(change.change.patch, /-.*新增/);
    const backups = await fs.readdir(path.join(x.home, 'backups'));
    assert.equal(JSON.parse(await fs.readFile(path.join(x.home, 'backups', backups[0]), 'utf8')).before, original);
  } finally { await x.cleanup(); }
});
test('line edits reject unread ranges, external changes, stale line numbers and invalid ranges', async () => {
  const x = await setup(); const target = path.join(x.root, 'a.txt');
  const edit = (startLine = 2, endLine = 2) => x.tools.execute('replace_lines', { path: 'a.txt', startLine, endLine, newText: '' });
  try {
    await fs.writeFile(target, 'a\nb\nc\n');
    await assert.rejects(edit(), /读取/);
    await x.tools.execute('read_file', { path: 'a.txt', startLine: 1, lines: 1 });
    await assert.rejects(edit(), /完整显示/);
    await x.tools.execute('read_file', { path: 'a.txt' });
    await assert.rejects(edit(3, 2)); await assert.rejects(edit(1, 10), /越界/);
    await fs.writeFile(target, 'external\nb\nc\n');
    await assert.rejects(edit(), /外部修改/);
    await x.tools.execute('read_file', { path: 'a.txt' }); await edit();
    await assert.rejects(edit(), /重新读取/);
    assert.equal(await fs.readFile(target, 'utf8'), 'external\nc\n');
  } finally { await x.cleanup(); }
});
test('line replacements preserve CRLF, line boundaries and EOF without a newline', async () => {
  const x = await setup();
  try {
    await fs.writeFile(path.join(x.root, 'a.txt'), 'first\r\nold\r\nlast');
    await x.tools.execute('read_file', { path: 'a.txt' });
    await x.tools.execute('replace_lines', { path: 'a.txt', startLine: 2, endLine: 2, newText: '  new\n  second' });
    assert.equal(await fs.readFile(path.join(x.root, 'a.txt'), 'utf8'), 'first\r\n  new\r\n  second\r\nlast');
    await x.tools.execute('read_file', { path: 'a.txt' });
    await x.tools.execute('replace_lines', { path: 'a.txt', startLine: 4, endLine: 4, newText: 'end' });
    assert.equal(await fs.readFile(path.join(x.root, 'a.txt'), 'utf8'), 'first\r\n  new\r\n  second\r\nend');
  } finally { await x.cleanup(); }
});
test('truncated read output does not authorize editing hidden lines', async () => {
  const x = await setup();
  try {
    await fs.writeFile(path.join(x.root, 'a.txt'), 'x'.repeat(15000) + '\n' + 'y'.repeat(15000) + '\nlast');
    const output = await x.tools.execute('read_file', { path: 'a.txt' });
    assert.match(output, /截断/); assert.ok(!output.includes('2: y'));
    await assert.rejects(x.tools.execute('replace_lines', { path: 'a.txt', startLine: 2, endLine: 2, newText: '' }), /完整显示/);
  } finally { await x.cleanup(); }
});

async function setup(approve = true, timeout = 1) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'local-code-test-'));
  const root = path.join(home, 'project'); await fs.mkdir(root);
  const controller = new AbortController(), events: EngineEvent[] = [];
  let approvals = 0;
  const tools = new ToolRegistry({ root, backupDir: path.join(home, 'backups'), signal: controller.signal, timeout, emit: e => events.push(e), approve: async () => { approvals++; return approve; } });
  await tools.init();
  return { home, root, tools, controller, events, approvals: () => approvals, cleanup: () => fs.rm(home, { recursive: true, force: true }) };
}
test('execution evidence excludes no-op writes, old task changes and reverted edits', async () => {
  const x = await setup();
  try {
    await fs.writeFile(path.join(x.root, 'a.txt'), 'original');
    await x.tools.execute('read_file', { path: 'a.txt' });
    assert.match(await x.tools.execute('write_file', { path: 'a.txt', content: 'original' }), /未改变/);
    assert.deepEqual(x.tools.evidence().changedFiles, []);
    assert.ok(!x.events.some(e => e.type === 'change'));
    await x.tools.execute('write_file', { path: 'a.txt', content: 'new' });
    assert.deepEqual(x.tools.evidence().changedFiles, ['a.txt']);
    await x.tools.execute('write_file', { path: 'a.txt', content: 'original' });
    assert.deepEqual(x.tools.evidence().changedFiles, []);
    const previous = new ToolRegistry({ root: x.root, backupDir: path.join(x.home, 'backups'), signal: x.controller.signal, timeout: 1, emit: () => {}, approve: async () => false, changes: [{ path: 'a.txt', before: 'old', after: 'original', patch: 'old diff' }] });
    await previous.init();
    assert.deepEqual(previous.evidence().changedFiles, []);
  } finally { await x.cleanup(); }
});
test('reject traversal, symlink parents, hardlinks and binary files', async () => {
  const x = await setup();
  try {
    await assert.rejects(x.tools.execute('read_file', { path: '../secret' }), /范围/);
    await assert.rejects(x.tools.execute('write_file', { path: '/tmp/escape', content: 'bad' }), /相对路径/);
    await fs.symlink(x.home, path.join(x.root, 'escape'));
    await assert.rejects(x.tools.execute('write_file', { path: 'escape/out.txt', content: 'bad' }), /范围|符号链接/);
    await fs.writeFile(path.join(x.root, 'binary'), Buffer.from([0, 1, 2]));
    await assert.rejects(x.tools.execute('read_file', { path: 'binary' }), /二进制/);
    await fs.writeFile(path.join(x.home, 'original'), 'shared'); await fs.link(path.join(x.home, 'original'), path.join(x.root, 'linked'));
    await x.tools.execute('read_file', { path: 'linked' });
    await assert.rejects(x.tools.execute('write_file', { path: 'linked', content: 'no' }), /硬链接/);
  } finally { await x.cleanup(); }
});
test('read-before-edit, external conflict, isolated baseline and durable originals', async () => {
  const x = await setup();
  try {
    const target = path.join(x.root, 'file.txt'); await fs.writeFile(target, 'user existing changes\nold\n');
    await assert.rejects(x.tools.execute('edit_file', { path: 'file.txt', oldText: 'old', newText: 'new' }), /读取/);
    await x.tools.execute('read_file', { path: 'file.txt' }); await fs.writeFile(target, 'external\nold\n');
    await assert.rejects(x.tools.execute('edit_file', { path: 'file.txt', oldText: 'old', newText: 'new' }), /外部修改/);
    await x.tools.execute('read_file', { path: 'file.txt' });
    await x.tools.execute('edit_file', { path: 'file.txt', oldText: 'old', newText: 'new' });
    const event = x.events.find(e => e.type === 'change'); assert.ok(event?.type === 'change');
    assert.equal(event.change.before, 'external\nold\n'); assert.match(event.change.patch, /\+new/);
    const backups = await fs.readdir(path.join(x.home, 'backups')); assert.equal(backups.length, 1);
    assert.equal(JSON.parse(await fs.readFile(path.join(x.home, 'backups', backups[0]), 'utf8')).before, 'external\nold\n');
    await fs.writeFile(target, 'another person\n'); await x.tools.execute('read_file', { path: 'file.txt' });
    await assert.rejects(x.tools.execute('write_file', { path: 'file.txt', content: 'other' }), /新任务/);
  } finally { await x.cleanup(); }
});
test('nested AGENTS instructions gate edits before they happen', async () => {
  const x = await setup();
  try {
    await fs.mkdir(path.join(x.root, 'src')); await fs.writeFile(path.join(x.root, 'src/AGENTS.md'), '所有文本使用中文。');
    const output = await x.tools.execute('write_file', { path: 'src/a.txt', content: '你好' }); assert.match(output, /尚未执行/);
    await assert.rejects(fs.access(path.join(x.root, 'src/a.txt')));
    await x.tools.execute('write_file', { path: 'src/a.txt', content: '你好' });
    assert.equal(await fs.readFile(path.join(x.root, 'src/a.txt'), 'utf8'), '你好');
  } finally { await x.cleanup(); }
});
test('invalid and unknown tool calls have no side effects', async () => {
  const x = await setup(); try {
    await assert.rejects(x.tools.execute('write_file', { path: 'x', content: 3 }));
    await assert.rejects(x.tools.execute('delete_everything', {}), /未知工具/);
    assert.deepEqual(await fs.readdir(x.root), []);
  } finally { await x.cleanup(); }
});
test('denied commands never run', async () => {
  const x = await setup(false); try {
    assert.match(await x.tools.execute('run_command', { command: 'touch denied' }), /拒绝/);
    assert.equal(x.approvals(), 1); await assert.rejects(fs.access(path.join(x.root, 'denied')));
  } finally { await x.cleanup(); }
});
test('approved commands produce bounded output and terminate on timeout', async () => {
  const x = await setup(true, 1); try {
    assert.match(await x.tools.execute('run_command', { command: 'printf approved' }), /approved/);
    const start = Date.now(); assert.match(await x.tools.execute('run_command', { command: 'sleep 15' }), /超时/);
    assert.ok(Date.now() - start < 5000); assert.equal(x.approvals(), 2);
  } finally { await x.cleanup(); }
});
test('cancelling a running command terminates its process group', async () => {
  const x = await setup(true, 30); try {
    const running = x.tools.execute('run_command', { command: 'sleep 20' });
    const timer = setTimeout(() => x.controller.abort(), 120);
    await assert.rejects(running, /停止/); clearTimeout(timer);
    const event = x.events.find(e => e.type === 'process' && e.running); assert.ok(event?.type === 'process');
    assert.throws(() => process.kill(event.pid, 0));
  } finally { await x.cleanup(); }
});
test('duplicate Vue labels can be edited only in the selected line range, preserving CRLF', async () => {
  const x = await setup();
  const oldText = ':label="item.awardName"';
  const newText = ':label="item.awardName + (item.remark ? `（${item.remark}）` : \'\')"';
  const lines = ['<template>', `  <a ${oldText} />`, '  <select>', `    <b ${oldText} />`, '  </select>', `  <c ${oldText} />`, '</template>'];
  try {
    await fs.writeFile(path.join(x.root, 'sample.vue'), lines.join('\r\n'));
    await x.tools.execute('read_file', { path: 'sample.vue', startLine: 3, lines: 3 });
    await assert.rejects(x.tools.execute('edit_file', { path: 'sample.vue', oldText, newText }), /匹配了 3 次.*候选行：2、4、6/s);
    await x.tools.execute('edit_file', { path: 'sample.vue', oldText, newText, startLine: 3, endLine: 5 });
    lines[3] = lines[3].replace(oldText, newText);
    assert.equal(await fs.readFile(path.join(x.root, 'sample.vue'), 'utf8'), lines.join('\r\n'));
  } finally { await x.cleanup(); }
});
test('regex-like oldText fails with actual source feedback and does not write', async () => {
  const x = await setup(); const text = '  :label="item.awardName"\n  :value="item.awardId"\n';
  try {
    await fs.writeFile(path.join(x.root, 'sample.vue'), text);
    await x.tools.execute('read_file', { path: 'sample.vue' });
    await assert.rejects(x.tools.execute('edit_file', { path: 'sample.vue', oldText: ':label="item\\.awardName"\\s+(:value="item\\.awardId")', newText: 'bad' }), error => {
      assert.match((error as Error).message, /不支持正则/);
      assert.ok((error as Error).message.includes(JSON.stringify(text))); return true;
    });
    assert.equal(await fs.readFile(path.join(x.root, 'sample.vue'), 'utf8'), text);
    assert.ok(!x.events.some(e => e.type === 'change'));
  } finally { await x.cleanup(); }
});
test('invalid ranges and overlapping matches never guess a replacement', async () => {
  const x = await setup(); try {
    await fs.writeFile(path.join(x.root, 'a.txt'), 'aaa\n'); await x.tools.execute('read_file', { path: 'a.txt' });
    await assert.rejects(x.tools.execute('edit_file', { path: 'a.txt', oldText: 'aa', newText: 'z' }), /匹配了 2 次/);
    await assert.rejects(x.tools.execute('edit_file', { path: 'a.txt', oldText: 'aaa', newText: 'z', startLine: 1 }));
    await assert.rejects(x.tools.execute('edit_file', { path: 'a.txt', oldText: 'aaa', newText: 'z', startLine: 2, endLine: 1 }));
    await assert.rejects(x.tools.execute('edit_file', { path: 'a.txt', oldText: 'aaa', newText: 'z', startLine: 10, endLine: 11 }), /越界/);
    assert.equal(await fs.readFile(path.join(x.root, 'a.txt'), 'utf8'), 'aaa\n');
  } finally { await x.cleanup(); }
});
test('real regex source is still editable as literal text', async () => {
  const x = await setup(); try {
    await fs.writeFile(path.join(x.root, 'a.js'), 'const r = /\\s+/;\n');
    await x.tools.execute('read_file', { path: 'a.js' });
    await x.tools.execute('edit_file', { path: 'a.js', oldText: '\\s+', newText: '\\s*' });
    assert.equal(await fs.readFile(path.join(x.root, 'a.js'), 'utf8'), 'const r = /\\s*/;\n');
  } finally { await x.cleanup(); }
});
