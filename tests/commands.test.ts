import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse } from '@babel/parser';
import { CommandManager } from '../electron/commands';
import { commandOutput } from '../engine/command-output';
import { ToolRegistry } from '../engine/tools';
import type { CommandSession, Approval } from '../shared/types';

async function until(check: () => boolean) { for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(r => setTimeout(r, 10)); } assert.ok(check(), 'terminal did not reach expected state'); }
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jalo-pty-'));
  const owner = { taskId: randomUUID(), runId: randomUUID(), projectId: randomUUID() }, records = new Map<string, CommandSession>();
  const directory = path.join(root, 'commands', owner.taskId, owner.runId);
  const manager = new CommandManager((_owner, record) => records.set(record.id, record));
  const approval = (command: string, background = true, timeout = 60): Approval => ({ id: randomUUID(), command, cwd: root, tty: true, background, timeout });
  return { root, owner, directory, manager, records, approval, cleanup: async () => { manager.shutdown(); await fs.rm(root, { recursive: true, force: true }); } };
}
test('real PTY supports interactive input, resizing and independently owned background output', async () => {
  const x = await fixture();
  try {
    const result = await x.manager.start(x.owner, x.approval('test -t 0 && print TTY_OK; read line; stty size; print "REPLY:$line"'), x.directory);
    assert.match(result, /尚未完成/); const id = [...x.records.keys()][0];
    assert.ok(x.manager.hasTask(x.owner.taskId)); assert.ok(x.manager.hasProject(x.owner.projectId));
    await until(() => x.manager.snapshot(x.owner, id).tail!.includes('TTY_OK'));
    assert.throws(() => x.manager.input({ ...x.owner, taskId: randomUUID() }, id, 'unsafe'), /不属于/);
    assert.throws(() => x.manager.input(x.owner, id, 'first\nsecond'), /单行/);
    assert.throws(() => x.manager.resize(x.owner, id, 0, 20), /尺寸/);
    x.manager.resize(x.owner, id, 120, 42);
    x.manager.stopTask(x.owner.taskId, false); assert.ok(x.manager.owns(id), 'model completion keeps explicitly background commands alive');
    x.manager.input(x.owner, id, '你好');
    await until(() => x.records.get(id)!.status === 'completed');
    const record = x.records.get(id)!; assert.equal(record.exitCode, 0); assert.match(record.tail!, /42\s+120/); assert.match(record.tail!, /REPLY:你好/);
    assert.match((await commandOutput(x.directory, id)).text, /TTY_OK/); assert.ok(!x.manager.hasTask(x.owner.taskId));
    assert.throws(() => x.manager.input(x.owner, id, 'again'), /已结束/);
  } finally { await x.cleanup(); }
});
test('stopping a PTY kills the process group; foreground timeouts and shutdown persist terminal status', async () => {
  const x = await fixture();
  try {
    await x.manager.start(x.owner, x.approval('sleep 60 & print CHILD:$!; wait'), x.directory);
    const id = [...x.records.keys()][0]; await until(() => /CHILD:\d+/.test(x.manager.snapshot(x.owner, id).tail!));
    const pid = Number(x.records.get(id)!.tail!.match(/CHILD:(\d+)/)![1]);
    x.manager.stop(x.owner, id); assert.equal(x.records.get(id)!.status, 'interrupted');
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
    const result = await x.manager.start(x.owner, x.approval('sleep 60', false, 0.1), x.directory);
    assert.match(result, /超时/); assert.equal([...x.records.values()].at(-1)!.timedOut, true);
    await x.manager.start(x.owner, x.approval('sleep 60'), x.directory); x.manager.shutdown();
    assert.ok([...x.records.values()].every(c => c.status === 'interrupted')); assert.ok(!x.manager.hasProject(x.owner.projectId));
  } finally { await x.cleanup(); }
});
test('PTY launch fails closed when the command checkpoint cannot be persisted', async () => {
  const x = await fixture();
  try {
    const manager = new CommandManager(() => { throw new Error('disk failed'); });
    assert.throws(() => manager.start(x.owner, x.approval('touch should-not-exist'), x.directory), /disk failed/);
    await assert.rejects(fs.stat(path.join(x.root, 'should-not-exist')), /ENOENT/);
  } finally { await x.cleanup(); }
});
test('PTY and background tools still require each approval and never reuse file read authorization', async () => {
  const x = await fixture(); let allowed = false, launches = 0; const approvals: Approval[] = [];
  try {
    await fs.writeFile(path.join(x.root, 'a.txt'), 'old');
    const registry = new ToolRegistry({ root: x.root, backupDir: path.join(x.root, 'backup'), signal: new AbortController().signal, timeout: 12, emit: () => {}, approve: async approval => { approvals.push(approval); return allowed; }, managedCommand: async () => { launches++; return 'started'; }, commandStatus: async () => 'running' });
    await registry.init();
    assert.match(await registry.execute('run_command', { command: 'echo denied', background: true }), /拒绝/); assert.equal(launches, 0);
    allowed = true; await registry.execute('read_file', { path: 'a.txt' });
    await registry.execute('run_command', { command: 'echo approved', background: true });
    assert.equal(approvals.length, 2); assert.equal(launches, 1); assert.equal(approvals[1].timeout, 86400); assert.equal(approvals[1].tty, true);
    await assert.rejects(registry.execute('write_file', { path: 'a.txt', content: 'new' }), /尚未读取/);
    assert.equal(await registry.execute('command_status', { commandId: randomUUID() }), 'running');
    for (const file of ['src/pty-terminal.tsx', 'src/command-panel.tsx', 'src/main.tsx']) parse(await fs.readFile(file, 'utf8'), { sourceType: 'module', plugins: ['typescript', 'jsx'] });
  } finally { await x.cleanup(); }
});
