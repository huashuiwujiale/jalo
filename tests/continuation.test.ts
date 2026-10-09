import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parse } from '@babel/parser';
import { defaults, type Task, type RunChange } from '../shared/types';
import { captureContinuation, continuationRequests, prepareContinuation, validateContinuationBudget, validateContinuationFiles } from '../engine/continuation';
import { version } from '../engine/syntax';
import { workerInput, MessagePatchReceiver, MessagePatchSender } from '../shared/worker-wire';
import { Store } from '../electron/store';
import { taskDetail } from '../shared/task-wire';

const task = (): Task => ({ id: 'task', projectId: 'project', title: 'long task', model: 'mock', status: 'failed', createdAt: 1, currentRunId: 'run', changes: [],
  messages: [{ role: 'user', content: '保留导出；不要编译' }], events: [{ id: 'u', kind: 'message', role: 'user', text: '保留导出；不要编译', at: 1, runId: 'run' }],
  runs: [{ id: 'run', taskId: 'task', mode: 'execute', input: '保留导出；不要编译', status: 'failed', stopReason: 'steps', createdAt: 1, endedAt: 2, references: [], changes: [], checks: [], progress: { phase: 'tool', since: 1, step: 30, maxSteps: 30 } }] });
test('continuation snapshots preserve constraints and uncertain writes, detect external edits and require explicit reduction of oversized goals', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jalo-continuation-'));
  try {
    const t = task(), run = t.runs![0]; await fs.writeFile(path.join(root, 'a.txt'), 'new');
    run.changes.push({ path: 'a.txt', state: 'uncertain', afterVersion: version('new') } as RunChange);
    t.events.push({ id: 'deny', kind: 'tool', toolPhase: 'result', text: 'run_command 结果\n用户拒绝了该命令：npm test', at: 2, runId: 'run' }, { id: 'note', role: 'assistant', kind: 'message', text: '剩余事项：检查导出按钮', at: 3, runId: 'run' });
    const a = await prepareContinuation(t, root, defaults), again = await prepareContinuation(t, root, defaults);
    assert.equal(a.version, again.version); assert.equal(a.goal, run.input); assert.equal(a.checkpoint.reason, 'steps'); assert.equal(a.checkpoint.files[0].state, 'uncertain');
    assert.equal(a.files[0].matchesCheckpoint, true); assert.match(a.checkpoint.issues[0], /拒绝/); assert.match(a.checkpoint.notes[0], /导出/);
    await validateContinuationBudget(root, a, a.goal, defaults); await validateContinuationFiles(root, a.files);
    await fs.writeFile(path.join(root, 'a.txt'), 'external'); const b = await prepareContinuation(t, root, defaults);
    assert.notEqual(b.version, a.version); assert.equal(b.files[0].matchesCheckpoint, false); await assert.rejects(validateContinuationFiles(root, a.files), /文件发生变化/);
    t.events.push({ id: 'large', kind: 'message', role: 'user', text: '不可丢失的约束'.repeat(5000), runId: 'run', at: 4 });
    const large = await prepareContinuation(t, root, defaults); assert.equal(large.requiresGoal, true); assert.equal(large.goal, ''); assert.equal(large.requestCount, 2);
    await assert.rejects(validateContinuationBudget(root, large, '目标'.repeat(20000), defaults), /上下文/);
    await fs.rm(path.join(root, 'a.txt')); const missing = await prepareContinuation(t, root, defaults); assert.equal(missing.files[0].state, 'missing');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('resuming and later compaction retain archived context while worker receives only the new active segment', () => {
  const t = task(), archive = [{ role: 'assistant' as const, content: 'old '.repeat(100000), tool_calls: [{ id: 'unfinished', type: 'function' as const, function: { name: 'run_command', arguments: '{"command":"must not replay"}' } }] }];
  t.messages = [...archive, { role: 'user', content: '明确的续接目标和核对记录' }]; t.contextStart = archive.length;
  t.runs![0].continuation = { runId: 'older', version: 'a'.repeat(64), files: [] };
  const wire = workerInput(t); assert.equal(wire.archiveLength, 1); assert.equal(wire.input.messages.length, 1); assert.ok(!JSON.stringify(wire.input).includes('must not replay'));
  const receiver = new MessagePatchReceiver(wire.archiveLength), sender = new MessagePatchSender(wire.input.messages);
  receiver.apply(t, sender.update([{ role: 'system', content: 'fresh rules' }, ...wire.input.messages, { role: 'assistant', content: 'new progress' }])!);
  assert.deepEqual(t.messages.slice(0, 1), archive);
  t.runs![0].continuation = undefined; assert.equal(workerInput(t).archiveLength, 1, 'ordinary follow-up keeps the new boundary');
  t.contextStart = 999; assert.throws(() => workerInput(t), /边界无效/);
});
test('confirmed plan requirements survive first resume and explicit renewed goals replace the earlier request set', () => {
  const t = task(), plan = { ...t.runs![0], id: 'plan', mode: 'plan' as const, input: '保留用户数据', planText: '先备份再迁移', status: 'completed' as const };
  t.runs!.unshift(plan); t.runs![1].planRunId = 'plan';
  assert.match(continuationRequests(t, t.runs![1]).join('\n'), /保留用户数据.*\n.*先备份再迁移/s);
  const resumed = { ...t.runs![1], id: 'resumed', input: '只检查数据，禁止写入', planRunId: undefined, continuation: { runId: 'run', version: 'a'.repeat(64), files: [] } };
  t.runs!.push(resumed); t.events.push({ id: 'renewed', role: 'user', kind: 'message', text: resumed.input, at: 4, runId: resumed.id });
  assert.deepEqual(continuationRequests(t, resumed), [resumed.input]);
});
test('restart persists a handoff without automatic continuation and keeps large handoff bodies out of task IPC', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jalo-continuation-')), file = path.join(root, 'state.sqlite'); let store = await Store.open(file);
  try {
    const t = task(); t.status = t.runs![0].status = 'running'; t.runs![0].endedAt = undefined; t.contextStart = 1;
    store.putTask(t); store.close(); store = await Store.open(file);
    const restored = store.task(t.id); assert.equal(restored.status, 'interrupted'); assert.equal(restored.contextStart, 1); assert.equal(restored.runs![0].handoff?.reason, 'interrupted');
    assert.equal(restored.runs!.length, 1); const detail = taskDetail(restored, 1); assert.equal(detail.runs[0].hasHandoff, true); assert.ok(!('handoff' in detail.runs[0])); assert.ok(!('contextStart' in detail)); assert.ok(!('contextStart' in store.view(t.id)));
    const bounded = captureContinuation({ ...restored, events: Array.from({ length: 50 }, (_, i) => ({ id: String(i), kind: 'error' as const, text: 'x'.repeat(2000), at: i })) }, restored.runs![0], 'error');
    assert.equal(bounded.issues.length, 8); assert.equal(bounded.omitted.issues, 42);
    for (const source of ['src/main.tsx', 'src/continuation-dialog.tsx']) parse(await fs.readFile(source, 'utf8'), { sourceType: 'module', plugins: ['typescript', 'jsx'] });
  } finally { store.close(); await fs.rm(root, { recursive: true, force: true }); }
});
