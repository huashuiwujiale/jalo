import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { defaults, type Message, type Task } from '../shared/types';
import { workerInput, MessagePatchReceiver, type WorkerEvent } from '../shared/worker-wire';
import { version } from '../engine/syntax';
const require = createRequire(import.meta.url);
const call = (id: string, name: string, args: unknown) => ({ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });

test('worker sends incremental complete groups, waits for checkpoints and retains individual command approval', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'jalo-worker-test-'));
  const port = new EventEmitter() as any, outputs: WorkerEvent[] = [], requests: Message[][] = [];
  const task: Task = { id: 't', projectId: 'p', title: 'fixture', model: 'mock', status: 'running', createdAt: 1, currentRunId: 'r',
    messages: [{ role: 'user', content: '修改 a.txt' }], events: [], changes: [{ path: 'a.txt', before: 'original', after: 'old', patch: '-original\n+old' }],
    runs: [{ id: 'r', taskId: 't', mode: 'execute', input: '修改 a.txt', createdAt: 1, status: 'running', references: [
      { projectId: 'p', path: 'a.txt', startLine: 1, endLine: 1, version: version('old'), content: 'old' },
    ], changes: [], checks: [] }] };
  const payload = workerInput(task), receiver = new MessagePatchReceiver(payload.archiveLength);
  const responses = [
    { message: { role: 'assistant', content: null, tool_calls: [call('probe', 'capability_check', { ok: true })] }, finishReason: 'tool_calls' },
    { message: { role: 'assistant', content: null, tool_calls: [call('read', 'read_file', { path: 'a.txt' }), call('write', 'write_file', { path: 'a.txt', content: 'new' }), call('command', 'run_command', { command: 'printf should-not-run' })] }, finishReason: 'tool_calls' },
    { message: { role: 'assistant', content: '文件已修改，命令被拒绝。' }, finishReason: 'stop' },
  ];
  class Provider {
    async list() { return [{ key: 'mock', toolUse: true, maxContext: 16384, instances: [{ id: 'mock', contextLength: 16384 }] }]; }
    async generate(messages: Message[]) { requests.push(structuredClone(messages)); return responses.shift(); }
  }
  const Module = require('node:module'), originalLoad = Module._load, originalPort = (process as any).parentPort;
  let resolveDone: (event: any) => void, rejectDone: (error: unknown) => void;
  const done = new Promise<any>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  const timer = setTimeout(() => rejectDone(new Error('worker timeout')), 5000);
  let checkpoints = 0, approvals = 0;
  port.postMessage = (raw: WorkerEvent) => {
    try {
      const event = structuredClone(raw); outputs.push(event); assert.equal(event.runId, 'r');
      if (event.type === 'message-patch') receiver.apply(task, event);
      if (event.type === 'checkpoint') {
        checkpoints++;
        assert.equal(task.messages.some(m => m.tool_calls?.some(c => c.id === 'write')), false, 'unfinished calls cannot enter resumable context');
        assert.equal(event.checkpoint.before, 'old');
        queueMicrotask(() => port.emit('message', { data: { type: 'checkpoint-ack', id: event.checkpoint.id } }));
      }
      if (event.type === 'approval') {
        approvals++;
        queueMicrotask(() => {
          port.emit('message', { data: { type: 'approve', id: 'wrong', allow: true } });
          port.emit('message', { data: { type: 'approve', id: event.approval.id, allow: false } });
        });
      }
      if (event.type === 'done') resolveDone(event);
    } catch (error) { rejectDone(error); }
  };
  Module._load = function(id: string, ...args: any[]) { if (id === './provider') return { LMStudioProvider: Provider }; return originalLoad.call(this, id, ...args); };
  (process as any).parentPort = port;
  try {
    await fs.writeFile(path.join(home, 'a.txt'), 'old');
    require('../engine/worker.ts');
    port.emit('message', { data: { type: 'start', input: payload.input, root: home, backupDir: path.join(home, 'backups'), settings: { ...defaults, model: 'mock' } } });
    const result = await done;
    assert.equal(result.status, 'completed'); assert.equal(checkpoints, 1); assert.equal(approvals, 1);
    assert.equal(await fs.readFile(path.join(home, 'a.txt'), 'utf8'), 'new');
    const change = outputs.find(e => e.type === 'change'); assert.ok(change?.type === 'change'); assert.equal(change.change.before, 'original');
    assert.ok(task.messages.some(m => m.role === 'tool' && m.content?.includes('用户拒绝了该命令')));
    assert.deepEqual(task.messages, [...requests.at(-1)!, { role: 'assistant', content: '文件已修改，命令被拒绝。' }]);
    const patches = outputs.filter(e => e.type === 'message-patch'); assert.equal(patches.length, 3);
    assert.equal(patches[0].messages.length, 1); assert.equal(patches[1].messages.length, 4); assert.equal(patches[2].messages.length, 1);
    assert.ok(!outputs.some(e => e.type === 'process'), 'denied command must never spawn');
  } finally {
    clearTimeout(timer); Module._load = originalLoad; (process as any).parentPort = originalPort;
    port.removeAllListeners(); delete require.cache[require.resolve('../engine/worker.ts')];
    await fs.rm(home, { recursive: true, force: true });
  }
});
