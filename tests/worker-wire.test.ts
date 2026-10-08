import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workerInput, MessagePatchSender, MessagePatchReceiver } from '../shared/worker-wire';
import type { Message, Task, RunChange } from '../shared/types';

const user = (content: string): Message => ({ role: 'user', content });
const task = (): Task => ({ id: 't', projectId: 'p', title: 'task', model: 'mock', status: 'running', createdAt: 1,
  currentRunId: 'r', messages: [user('old context'), user('latest')], events: [], changes: [],
  runs: [{ id: 'r', taskId: 't', mode: 'execute', input: 'latest', createdAt: 1, status: 'running', references: [], checks: [], changes: [] }] });

test('worker starts with necessary context, references and edit baselines only', () => {
  const full = task(), run = full.runs![0], body = 'history '.repeat(100000);
  full.events.push({ id: 'e', at: 1, kind: 'notice', text: body }); run.planText = body;
  run.references.push({ projectId: 'p', path: 'a.txt', scope: 'file', startLine: 1, endLine: 2, version: 'a'.repeat(64), content: body });
  const baseline = { path: 'a.txt', before: 'original', after: 'current', patch: '-original\n+current' }; full.changes.push(baseline);
  const normal = workerInput(full);
  assert.equal(normal.archiveLength, 0); assert.deepEqual(normal.input.messages, full.messages); assert.deepEqual(normal.input.changes, [baseline]);
  assert.equal(normal.input.run.references[0].path, 'a.txt'); assert.ok(!('content' in normal.input.run.references[0]));
  assert.ok(JSON.stringify(normal.input).length < 1000); assert.ok(!('events' in normal.input)); assert.ok(!('runs' in normal.input));
  run.planRunId = 'plan'; full.messages[0] = user(body);
  const linked = workerInput(full); assert.equal(linked.archiveLength, 1); assert.deepEqual(linked.input.messages, [user('latest')]);
  assert.ok(JSON.stringify(linked.input).length < 1000);
  run.mode = 'review'; run.reviewRunId = 'prior';
  full.runs!.unshift({ ...run, id: 'prior', changes: [
    { ...baseline, state: 'written', after: body } as RunChange,
    { ...baseline, path: 'reverted.txt', state: 'reverted' } as RunChange,
  ] });
  const review = workerInput(full); assert.deepEqual(review.input.changes, []);
  assert.deepEqual(review.input.reviewChanges, [{ path: 'a.txt', patch: baseline.patch }]);
  assert.ok(JSON.stringify(review.input).length < 1000);
  full.currentRunId = 'missing'; assert.throws(() => workerInput(full), /缺少本轮/);
});

test('message transport appends complete groups without resending large context', () => {
  const input = [user('large context '.repeat(100000))], full = { messages: structuredClone(input) };
  const sender = new MessagePatchSender(input), receiver = new MessagePatchReceiver(0);
  const messages = [{ role: 'system' as const, content: 'rules' }, ...input];
  const initial = sender.update(messages)!; assert.equal(initial.messages.length, 1); assert.equal(initial.remove, 0);
  receiver.apply(full, structuredClone(initial));
  let bytes = JSON.stringify(initial).length;
  for (let i = 0; i < 100; i++) {
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: String(i), type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', content: 'result', tool_call_id: String(i) });
    const patch = sender.update(messages)!; assert.equal(patch.remove, 0); assert.equal(patch.messages.length, 2);
    bytes += JSON.stringify(patch).length; assert.equal(receiver.apply(full, structuredClone(patch)), true);
    assert.equal(receiver.apply(full, structuredClone(patch)), false);
  }
  assert.ok(bytes < 50000); assert.deepEqual(full.messages, messages); assert.equal(sender.update(messages), undefined);
});

test('compaction and recovery replace the active context while archived rounds survive', () => {
  const archive = [user('archived plan'), { role: 'assistant' as const, content: 'old plan answer' }];
  let active: Message[] = [user('execute linked plan')];
  const full = { messages: [...archive, ...active] }, sender = new MessagePatchSender(active), receiver = new MessagePatchReceiver(archive.length);
  active = [{ role: 'system', content: 'rules' }, ...active, { role: 'assistant', content: 'done' }];
  receiver.apply(full, sender.update(active)!);
  active = [active[0], user('execute linked plan'), { role: 'assistant', content: 'summary', contextMemory: { version: 1, facts: [], notes: ['remaining'], instructions: [] } }];
  const compacted = sender.update(active)!; assert.ok(compacted.remove > 0); receiver.apply(full, structuredClone(compacted));
  assert.deepEqual(full.messages, [...archive, ...active]); assert.deepEqual(full.messages.slice(0, 2), archive);
  const next = sender.update([{ ...active[0], content: 'rules with recovery hint' }, ...active.slice(1)])!;
  assert.equal(next.messages.length, 1); assert.equal(next.remove, 1); receiver.apply(full, next);
  assert.equal(full.messages[2].content, 'rules with recovery hint'); assert.deepEqual(full.messages.slice(0, 2), archive);
});

test('missing, reordered and invalid message patches cannot silently corrupt context', () => {
  const full = { messages: [user('request')] }, receiver = new MessagePatchReceiver(0);
  const patch = { type: 'message-patch' as const, baseVersion: 0, version: 1, offset: 1, remove: 0, messages: [{ role: 'assistant' as const, content: 'answer' }] };
  for (const invalid of [{ ...patch, version: 2 }, { ...patch, offset: 2 }, { ...patch, remove: 1 }, { ...patch, offset: -1 }, { ...patch, remove: 0.5 }]) {
    assert.throws(() => receiver.apply(full, invalid), /同步/); assert.deepEqual(full.messages, [user('request')]);
  }
  assert.equal(receiver.apply(full, patch), true);
  assert.throws(() => receiver.apply(full, { ...patch, version: 3, baseVersion: 2 }), /顺序/);
});
