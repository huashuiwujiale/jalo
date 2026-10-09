import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CommandOutputWriter, commandOutput } from '../engine/command-output';
import { ToolRegistry } from '../engine/tools';
import { Store } from '../electron/store';
import type { EngineEvent, Task } from '../shared/types';

test('command log pages preserve UTF-8 and caps retain a separate error tail', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'jalo-command-')), directory = path.join(home, 'commands', 'task', 'run');
  try {
    const id = randomUUID(), writer = new CommandOutputWriter(directory, id), content = '你🙂'.repeat(30000);
    writer.append(content); writer.close(); writer.close();
    let offset = 0, result = '';
    do { const page = await commandOutput(directory, id, offset); result += page.text; assert.ok(page.next > offset); offset = page.next; if (!page.hasMore) break; } while (true);
    assert.equal(result, content); assert.equal(offset, Buffer.byteLength(content));
    const cappedId = randomUUID(), capped = new CommandOutputWriter(directory, cappedId, 10);
    capped.append('你'.repeat(20)); capped.append('ERROR: last failure'); capped.close();
    assert.ok(capped.bytes <= 10); assert.equal(capped.truncated, true); assert.match(capped.tail, /last failure$/);
    assert.ok(!(await commandOutput(directory, cappedId)).text.includes('�'));
    await assert.rejects(commandOutput(directory, id, offset + 1), /失效/);
    await assert.rejects(commandOutput(directory, '../escape'), /标识/);
    const linkId = randomUUID(); await fs.symlink(path.join(directory, id + '.log'), path.join(directory, linkId + '.log'));
    await assert.rejects(commandOutput(directory, linkId));
    const linked = path.join(home, 'commands', 'linked'); await fs.symlink(path.dirname(directory), linked);
    await assert.rejects(commandOutput(path.join(linked, 'run'), id), /目录/);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('approved long commands save middle output, bound streamed output and return final failures', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'jalo-command-')), root = path.join(home, 'project'), directory = path.join(home, 'commands', 'task', 'run');
  await fs.mkdir(root); const events: EngineEvent[] = []; let approvals = 0;
  const tools = new ToolRegistry({ root, backupDir: path.join(home, 'backups'), commandDirectory: directory, signal: new AbortController().signal, timeout: 10, emit: e => events.push(e), approve: async () => { approvals++; return true; } });
  await tools.init();
  try {
    const result = await tools.execute('run_command', { command: "for i in {1..6000}; do printf 'line %s 你好\\n' $i; done; printf 'FINAL ERROR\\n' >&2; exit 7" });
    assert.match(result, /退出码：7/); assert.match(result, /FINAL ERROR/); assert.match(result, /中段省略/);
    const record = events.filter(e => e.type === 'command').at(-1); assert.ok(record?.type === 'command');
    assert.equal(record.command.exitCode, 7); assert.equal(record.command.status, 'completed'); assert.equal(approvals, 1);
    const content = await fs.readFile(path.join(directory, record.command.id + '.log'), 'utf8'); assert.match(content, /line 3000 你好/); assert.match(content, /FINAL ERROR/);
    const streamed = events.filter(e => e.type === 'event' && e.event.kind === 'output').map(e => e.type === 'event' ? e.event.text : '').join('');
    assert.ok(streamed.length <= 32000); assert.ok(!content.includes('�'));
    const medium = await tools.execute('run_command', { command: "printf BEGIN; for i in {1..2000}; do printf 'abcdefghij'; done; printf END" });
    assert.match(medium, /BEGIN/); assert.match(medium, /END$/); assert.ok(!medium.includes('中段省略'));
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('restart marks command sessions interrupted without replaying them', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'jalo-command-')), file = path.join(home, 'state.sqlite'); let store = await Store.open(file);
  try {
    const task: Task = { id: 'task', projectId: 'project', title: 'command', status: 'completed', model: 'mock', createdAt: 1, messages: [], events: [], changes: [], currentRunId: 'run', runs: [{ id: 'run', taskId: 'task', mode: 'execute', input: 'test', status: 'completed', createdAt: 1, references: [], changes: [], checks: [], commands: [{ id: randomUUID(), command: 'never replay', cwd: home, startedAt: 1, status: 'running' }] }] };
    store.putTask(task); store.close(); store = await Store.open(file);
    assert.equal(store.view(task.id).runs[0].commands![0].status, 'interrupted'); assert.ok(store.view(task.id).runs[0].commands![0].endedAt);
  } finally { store.close(); await fs.rm(home, { recursive: true, force: true }); }
});
