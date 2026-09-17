import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { TaskRunner } from '../engine/runner';
import { ToolRegistry } from '../engine/tools';
import { compactContext, estimate } from '../engine/context';
import { Store } from '../electron/store';
import { defaults, type EngineEvent, type Message, type Task } from '../shared/types';
import type { Completion, ModelProvider } from '../engine/provider';

const call = (name: string, args: unknown): Completion => ({ message: { role: 'assistant', content: null, tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finishReason: 'tool_calls' });
class MockProvider implements ModelProvider {
  constructor(private responses: Completion[]) {}
  async list() { return []; } async load() { return 'model'; } async unload() {}
  async generate(_messages: Message[], _tools: unknown, signal: AbortSignal) { signal.throwIfAborted(); const response = this.responses.shift(); if (!response) throw new Error('mock exhausted'); return response; }
}
async function run(responses: Completion[], options: { approve?: boolean; cancelOnApproval?: boolean; steps?: number } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-code-runner-'));
  const signal = new AbortController(), events: EngineEvent[] = [];
  const emit = (e: EngineEvent) => events.push(e);
  const tools = new ToolRegistry({ root, backupDir: path.join(root, '.backups'), signal: signal.signal, timeout: 1, emit, approve: async () => { if (options.cancelOnApproval) signal.abort(); return options.approve === true; } });
  const runner = new TaskRunner(new MockProvider(responses), tools, { ...defaults, maxSteps: options.steps ?? 10 }, emit, signal.signal);
  await runner.run({ messages: [{ role: 'user', content: '创建 a.txt' }] });
  return { root, events, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}
const probe = () => call('capability_check', { ok: true });
const stop = (): Completion => ({ message: { role: 'assistant', content: '已完成' }, finishReason: 'stop' });
const empty = (): Completion => ({ message: { role: 'assistant', content: '\n\n' }, finishReason: 'stop' });
const textReply = (content: string): Completion => ({ message: { role: 'assistant', content }, finishReason: 'stop' });
test('fabricated tool transcripts fail verification and never edit files or enter model history', async () => {
  const fake = () => textReply('工具: read\\_file tool: 读取 a.txt\n工具: replace\\_lines tool: 替换整行 startLine=1 endLine=2 newText=""\n实际验证：文件内容已更新，新增按钮被移除');
  const x = await run([probe(), fake(), fake(), call('write_file', { path: 'a.txt', content: 'never' })]);
  try {
    assert.equal((x.events.at(-1) as any).status, 'failed');
    assert.match((x.events.at(-1) as any).error, /未完成实际执行/);
    assert.deepEqual((x.events.at(-1) as any).evidence.changedFiles, []);
    await assert.rejects(fs.access(path.join(x.root, 'a.txt')));
    assert.ok(!x.events.some(e => e.type === 'event' && e.event.kind === 'tool'));
    assert.ok(!x.events.some(e => e.type === 'messages' && e.messages.some(m => m.content?.includes('startLine=1'))));
    assert.ok(!x.events.some(e => e.type === 'event' && e.event.kind === 'message' && e.event.text.includes('实际验证：')));
  } finally { await x.cleanup(); }
});
test('plain-language modification claims without writes are rejected', async () => {
  const x = await run([probe(), textReply('已删除新增按钮，文件内容已更新。'), textReply('已修改 a.txt')]);
  try { assert.equal((x.events.at(-1) as any).status, 'failed'); assert.match((x.events.at(-1) as any).error, /没有产生实际文件差异/); }
  finally { await x.cleanup(); }
});
test('model can recover using real structured tools after a fabricated claim', async () => {
  const x = await run([probe(), textReply('已创建 a.txt'), call('write_file', { path: 'a.txt', content: 'actual content' }), textReply('已创建 a.txt')]);
  try {
    assert.equal((x.events.at(-1) as any).status, 'completed');
    assert.deepEqual((x.events.at(-1) as any).evidence.changedFiles, ['a.txt']);
    assert.equal(await fs.readFile(path.join(x.root, 'a.txt'), 'utf8'), 'actual content');
    assert.equal(x.events.filter(e => e.type === 'change').length, 1);
  } finally { await x.cleanup(); }
});
test('explaining tools without claiming execution remains a normal response with no changes', async () => {
  const x = await run([probe(), textReply('read_file 用于读取文件，replace_lines 用于按行替换。这里只解释用法，没有执行操作。')]);
  try {
    assert.equal((x.events.at(-1) as any).status, 'completed');
    assert.deepEqual((x.events.at(-1) as any).evidence.changedFiles, []);
    assert.ok(x.events.some(e => e.type === 'event' && e.event.kind === 'notice' && e.event.text.includes('未产生实际修改')));
  } finally { await x.cleanup(); }
});
test('rejected writes and denied commands cannot support a successful execution claim', async () => {
  const x = await run([probe(), call('write_file', { path: 'a.txt', content: 3 }), call('run_command', { command: 'touch a.txt' }), textReply('已创建 a.txt'), textReply('工具: run_command tool: 已执行命令')]);
  try {
    assert.equal((x.events.at(-1) as any).status, 'failed');
    assert.deepEqual((x.events.at(-1) as any).evidence.changedFiles, []);
    assert.ok(!(x.events.at(-1) as any).evidence.successfulTools.includes('run_command'));
    await assert.rejects(fs.access(path.join(x.root, 'a.txt')));
  } finally { await x.cleanup(); }
});
test('empty response is retried once without replaying an approved command', async () => {
  const x = await run([probe(), call('run_command', { command: 'printf ok' }), empty(), stop()], { approve: true });
  try {
    assert.equal((x.events.at(-1) as any).status, 'completed');
    assert.equal(x.events.filter(e => e.type === 'event' && e.event.kind === 'tool' && e.event.text.startsWith('run_command {')).length, 1);
    assert.equal(x.events.filter(e => e.type === 'event' && e.event.kind === 'notice' && e.event.text.includes('重试一次')).length, 1);
    const history = x.events.filter(e => e.type === 'messages').at(-1); assert.ok(history?.type === 'messages');
    assert.ok(!history.messages.some(m => m.role === 'assistant' && !m.content?.trim() && !m.tool_calls?.length));
  } finally { await x.cleanup(); }
});
test('two empty responses fail with a clear reason and never execute queued tools', async () => {
  const reasoningOnly = { ...empty(), reasoningCharacters: 42 };
  const x = await run([probe(), empty(), reasoningOnly, call('write_file', { path: 'unexpected', content: 'bad' })]);
  try {
    assert.match((x.events.at(-1) as any).error, /只返回了思考内容.*一次空回复重试/);
    assert.equal((x.events.at(-1) as any).status, 'failed');
    await assert.rejects(fs.access(path.join(x.root, 'unexpected')));
  } finally { await x.cleanup(); }
});
test('empty retry allowance is per task run, not replenished after every successful step', async () => {
  const x = await run([probe(), empty(), call('list_directory', {}), empty(), stop()]);
  try {
    assert.equal((x.events.at(-1) as any).status, 'failed');
    assert.equal(x.events.filter(e => e.type === 'event' && e.event.kind === 'notice' && e.event.text.includes('重试一次')).length, 1);
  } finally { await x.cleanup(); }
});
test('compaction preserves latest user position and chronological tool results across continuations', () => {
  const messages: Message[] = [{ role: 'system', content: 'rules' }, { role: 'user', content: 'original request' }];
  for (let i = 0; i < 14; i++) {
    const c = call('read_file', { path: 'a.txt' });
    messages.push(c.message, { role: 'tool', tool_call_id: c.message.tool_calls![0].id, content: `result ${i}: ` + 'x'.repeat(4000) });
    if (i === 7) messages.push({ role: 'user', content: 'middle request' });
  }
  messages.push({ role: 'assistant', content: '上一轮未正常完成，请先检查当前状态，不要自动重放历史工具调用。' }, { role: 'user', content: 'latest request' });
  const compact = compactContext(messages, [], 9000, 1024);
  assert.equal(compact.compacted, true);
  assert.deepEqual(compact.messages.at(-1), messages.at(-1));
  assert.deepEqual(compact.messages.filter(m => m.role === 'user').map(m => m.content), ['original request', 'middle request', 'latest request']);
  const originalIndices = compact.messages.filter(m => messages.includes(m)).map(m => messages.indexOf(m));
  assert.deepEqual(originalIndices, [...originalIndices].sort((a, b) => a - b));
  for (let i = 0; i < compact.messages.length; i++) {
    const m = compact.messages[i];
    if (m.role === 'tool') assert.ok(compact.messages[i - 1]?.tool_calls?.some(c => c.id === m.tool_call_id));
  }
  const again = compactContext([...compact.messages, { role: 'assistant', content: 'x'.repeat(15000) }, { role: 'user', content: 'next request' }], [], 9000, 1024);
  assert.equal(again.messages.at(-1)?.content, 'next request');
});
test('agent recovers from whitespace mismatch through a read then line edit', async () => {
  const bad = () => call('edit_file', { path: 'a.txt', oldText: '<button>\n新增\n</button>', newText: '' });
  const x = await run([probe(), call('write_file', { path: 'a.txt', content: 'keep\n  <button>\n    新增\n  </button>\nend\n' }), bad(), bad(), call('read_file', { path: 'a.txt' }), call('replace_lines', { path: 'a.txt', startLine: 2, endLine: 4, newText: '' }), bad(), bad(), stop()]);
  try {
    assert.equal(await fs.readFile(path.join(x.root, 'a.txt'), 'utf8'), 'keep\nend\n');
    assert.equal((x.events.at(-1) as any).status, 'completed');
  } finally { await x.cleanup(); }
});
test('complete agent loop probes, edits, observes tool output and finishes', async () => {
  const x = await run([probe(), call('write_file', { path: 'a.txt', content: 'hello' }), call('read_file', { path: 'a.txt' }), call('edit_file', { path: 'a.txt', oldText: 'hello', newText: '你好' }), stop()]);
  try {
    assert.equal(await fs.readFile(path.join(x.root, 'a.txt'), 'utf8'), '你好');
    assert.equal((x.events.at(-1) as any).status, 'completed');
    const history = x.events.filter(e => e.type === 'messages').at(-1); assert.ok(history?.type === 'messages');
    assert.ok(history.messages.some(m => m.role === 'tool' && m.content?.includes('hello')));
  } finally { await x.cleanup(); }
});
test('no tools execute when capability probe fails or generation truncates', async () => {
  const x = await run([stop(), call('write_file', { path: 'a.txt', content: 'bad' })]);
  try { assert.equal((x.events.at(-1) as any).status, 'failed'); await assert.rejects(fs.access(path.join(x.root, 'a.txt'))); } finally { await x.cleanup(); }
  const truncated = call('write_file', { path: 'a.txt', content: 'bad' }); truncated.finishReason = 'length';
  const y = await run([probe(), truncated]);
  try { assert.match((y.events.at(-1) as any).error, /上限/); await assert.rejects(fs.access(path.join(y.root, 'a.txt'))); } finally { await y.cleanup(); }
});
test('bad arguments become tool errors; denied commands remain unexecuted', async () => {
  const x = await run([probe(), call('write_file', { path: 'x', content: 123 }), call('run_command', { command: 'touch denied' }), stop()]);
  try { assert.equal((x.events.at(-1) as any).status, 'completed'); assert.ok(x.events.some(e => e.type === 'event' && e.event.kind === 'error')); await assert.rejects(fs.access(path.join(x.root, 'denied'))); } finally { await x.cleanup(); }
});
test('cancel while waiting for command approval never executes it', async () => {
  const x = await run([probe(), call('run_command', { command: 'touch nope' }), stop()], { approve: true, cancelOnApproval: true });
  try { assert.equal((x.events.at(-1) as any).status, 'cancelled'); await assert.rejects(fs.access(path.join(x.root, 'nope'))); } finally { await x.cleanup(); }
});
test('step limit prevents endless model/tool loops', async () => {
  const x = await run([probe(), call('list_directory', {})], { steps: 1 });
  try { assert.match((x.events.at(-1) as any).error, /步骤上限/); } finally { await x.cleanup(); }
});
test('context compaction preserves user requirements and complete tool groups', () => {
  const messages: Message[] = [{ role: 'system', content: 'system' }, { role: 'user', content: '不要运行编译' }];
  for (let i = 0; i < 12; i++) { const c = call('read_file', {}); messages.push(c.message, { role: 'tool', tool_call_id: c.message.tool_calls![0].id, content: 'abcdef'.repeat(1000) }); }
  const compact = compactContext(messages, [], 12000, 1024);
  assert.equal(compact.compacted, true); assert.ok(estimate(compact.messages) < estimate(messages));
  assert.ok(compact.messages.some(m => m.role === 'user' && m.content === '不要运行编译'));
  const ids = new Set(compact.messages.flatMap(m => m.tool_calls?.map(c => c.id) || []));
  for (const m of compact.messages.filter(m => m.role === 'tool')) assert.ok(ids.has(m.tool_call_id!));
  assert.throws(() => compactContext([{ role: 'user', content: '中文'.repeat(20000) }], [], 4096, 1024), /上下文/);
});
test('SQLite persists tasks and marks queued, running, waiting tasks interrupted after restart', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'local-code-store-'));
  const file = path.join(home, 'test.sqlite');
  try {
    const db = await Store.open(file);
    db.putProject({ id: 'p', name: 'demo', path: home });
    for (const status of ['queued', 'running', 'waiting', 'completed'] as const) {
      db.putTask({ id: status, projectId: 'p', title: status, status, model: 'm', createdAt: 1, messages: [], events: [], changes: [], approval: { id: 'a', command: 'never replay', cwd: home, timeout: 30 } });
    }
    db.close();
    const reopened = await Store.open(file);
    const tasks = reopened.tasks(); assert.equal(reopened.projects()[0].name, 'demo');
    for (const t of tasks.filter(t => t.id !== 'completed')) { assert.equal(t.status, 'interrupted'); assert.equal(t.approval, undefined); }
    assert.equal(tasks.find(t => t.id === 'completed')?.status, 'completed'); reopened.close();
    assert.equal((await fs.readFile(file)).subarray(0, 15).toString(), 'SQLite format 3');
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
test('three failed edits stop the loop even when the model rereads between failures', async () => {
  const bad = () => call('edit_file', { path: 'a.txt', oldText: 'x\\s+', newText: 'bad' });
  const last = bad();
  last.message.tool_calls!.push(call('write_file', { path: 'should-not-exist', content: 'no' }).message.tool_calls![0]);
  const x = await run([probe(), call('write_file', { path: 'a.txt', content: 'x\nx\n' }), bad(), call('read_file', { path: 'a.txt' }), bad(), call('read_file', { path: 'a.txt' }), last, stop()]);
  try {
    assert.equal((x.events.at(-1) as any).status, 'failed'); assert.match((x.events.at(-1) as any).error, /连续 3 次/);
    assert.equal(await fs.readFile(path.join(x.root, 'a.txt'), 'utf8'), 'x\nx\n');
    await assert.rejects(fs.access(path.join(x.root, 'should-not-exist')));
    const persisted = x.events.filter(e => e.type === 'messages').at(-1); assert.ok(persisted?.type === 'messages');
    assert.match(persisted.messages.at(-1)?.content || '', /未执行/);
    const toolResults = new Set(persisted.messages.filter(m => m.role === 'tool').map(m => m.tool_call_id));
    for (const m of persisted.messages) for (const c of m.tool_calls || []) assert.ok(toolResults.has(c.id));
  } finally { await x.cleanup(); }
});
test('a corrected ranged edit recovers and resets the failure counter', async () => {
  const bad = () => call('edit_file', { path: 'a.txt', oldText: 'missing', newText: 'bad' });
  const x = await run([probe(), call('write_file', { path: 'a.txt', content: 'x\nx\n' }), bad(), bad(), call('read_file', { path: 'a.txt' }), call('edit_file', { path: 'a.txt', oldText: 'x', newText: 'y', startLine: 2, endLine: 2 }), bad(), bad(), stop()]);
  try {
    assert.equal((x.events.at(-1) as any).status, 'completed');
    assert.equal(await fs.readFile(path.join(x.root, 'a.txt'), 'utf8'), 'x\ny\n');
  } finally { await x.cleanup(); }
});
