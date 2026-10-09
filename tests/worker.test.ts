import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { defaults, type Message, type Task, type Settings } from '../shared/types';
import { workerInput, MessagePatchReceiver, type WorkerEvent } from '../shared/worker-wire';
import { version } from '../engine/syntax';
const require = createRequire(import.meta.url);
const call = (id: string, name: string, args: unknown) => ({ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });

test('worker resolves the chosen model at send time, loads only when needed and never silently falls back', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'jalo-model-worker-'));
  const Module = require('node:module'), originalLoad = Module._load, originalPort = (process as any).parentPort;
  try {
    for (const scenario of ['loaded', 'unloaded', 'removed', 'incompatible'] as const) {
      const port = new EventEmitter() as any, loads: string[] = [], generated: string[] = [];
      let unloads = 0, result: any;
      class Provider {
        constructor(private settings: Settings) {}
        async list() { return scenario === 'removed' ? [] : [{ key:'chosen', toolUse:scenario !== 'incompatible', maxContext:16384, instances:scenario === 'loaded' ? [{id:'chosen-instance',contextLength:16384}] : [] }]; }
        async load(key: string) { loads.push(key); return 'chosen-instance'; }
        async unload() { unloads++; }
        async generate(_messages: Message[], _tools: unknown, _signal: AbortSignal, _delta: unknown, forceTool?: string) {
          generated.push(this.settings.model);
          return forceTool ? { message:{role:'assistant',content:null,tool_calls:[call('probe','capability_check',{ok:true})]}, finishReason:'tool_calls' }
            : { message:{role:'assistant',content:'保留历史，按新模型给出计划。'}, finishReason:'stop' };
        }
      }
      let resolveDone: () => void;
      const done = new Promise<void>(resolve => { resolveDone = resolve; });
      port.postMessage = (event: any) => { if(event.type === 'done') { result=event; resolveDone(); } };
      Module._load = function(id: string, ...args: any[]) { return id === './providers' ? { createProvider:(settings: Settings) => new Provider(settings) } : originalLoad.call(this,id,...args); };
      (process as any).parentPort=port;
      delete require.cache[require.resolve('../engine/worker.ts')]; require('../engine/worker.ts');
      const timer=setTimeout(()=>resolveDone(),5000);
      try {
        port.emit('message',{data:{type:'start',root:home,backupDir:path.join(home,'backups'),settings:{...defaults,model:'chosen'},input:{projectId:'p',model:'chosen',messages:[{role:'user',content:'继续上一轮对话'}],changes:[],run:{id:'r',mode:'plan',references:[]}}}});
        await done; assert.ok(result,`worker timed out: ${scenario}`);
        assert.equal(unloads,0);
        assert.deepEqual(loads,scenario === 'unloaded' ? ['chosen'] : []);
        if(scenario === 'removed' || scenario === 'incompatible') {
          assert.equal(result.status,'failed'); assert.deepEqual(generated,[]);
          assert.match(result.error,scenario === 'removed' ? /不存在/ : /工具调用/);
        } else { assert.equal(result.status,'completed'); assert.deepEqual(generated,['chosen-instance','chosen-instance']); }
      } finally { clearTimeout(timer); port.removeAllListeners(); }
    }
  } finally {
    Module._load=originalLoad; (process as any).parentPort=originalPort; delete require.cache[require.resolve('../engine/worker.ts')];
    await fs.rm(home,{recursive:true,force:true});
  }
});

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
  Module._load = function(id: string, ...args: any[]) { if (id === './providers') return { createProvider:() => new Provider() }; return originalLoad.call(this, id, ...args); };
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

test('worker bridges approved PTY launches and command status replies without spawning locally', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'jalo-managed-worker-'));
  const Module = require('node:module'), originalLoad = Module._load, originalPort = (process as any).parentPort;
  const port = new EventEmitter() as any, events: any[] = [];
  const commandId = 'cb5091bf-a040-44df-9192-99579ebc3b15';
  const replies = [
    { message: { role: 'assistant', content: null, tool_calls: [call('probe', 'capability_check', { ok: true })] }, finishReason: 'tool_calls' },
    { message: { role: 'assistant', content: null, tool_calls: [call('start', 'run_command', { command: 'fixture-only', background: true })] }, finishReason: 'tool_calls' },
    { message: { role: 'assistant', content: null, tool_calls: [call('status', 'command_status', { commandId })] }, finishReason: 'tool_calls' },
    { message: { role: 'assistant', content: '后台命令仍在运行。' }, finishReason: 'stop' },
  ];
  class Provider {
    async list() { return [{ key: 'mock', toolUse: true, maxContext: 16384, instances: [{ id: 'mock', contextLength: 16384 }] }]; }
    async generate() { return replies.shift(); }
  }
  let finish: (value: any) => void;
  const done = new Promise<any>(resolve => { finish = resolve; }), timeout = setTimeout(() => finish(undefined), 5000);
  port.postMessage = (event: any) => {
    events.push(event);
    if (event.type === 'approval') queueMicrotask(() => port.emit('message', { data: { type: 'approve', id: event.approval.id, allow: true } }));
    if (event.type === 'managed-command' || event.type === 'command-status') queueMicrotask(() => port.emit('message', { data: { type: 'command-result', id: event.approval?.id || event.id, result: event.type === 'managed-command' ? `后台启动 ${commandId}` : 'running' } }));
    if (event.type === 'done') finish(event);
  };
  Module._load = function(id: string, ...args: any[]) {
    if (id === './providers') return { createProvider: () => new Provider() };
    if (id === './provider') return { ...originalLoad.call(this, id, ...args), LMStudioProvider: Provider };
    return originalLoad.call(this, id, ...args);
  };
  (process as any).parentPort = port;
  try {
    require('../engine/worker.ts');
    port.emit('message', { data: { type: 'start', root: home, backupDir: path.join(home, 'backup'), settings: { ...defaults, model: 'mock' }, input: { projectId: 'p', model: 'mock', messages: [{ role: 'user', content: '启动后台命令并核对状态' }], changes: [], run: { id: 'r', mode: 'execute', references: [] } } } });
    const result = await done; assert.equal(result?.status, 'completed');
    assert.equal(events.filter(e => e.type === 'approval').length, 1);
    assert.equal(events.filter(e => e.type === 'managed-command').length, 1);
    assert.equal(events.filter(e => e.type === 'command-status').length, 1);
    assert.ok(!events.some(e => e.type === 'process'));
  } finally {
    clearTimeout(timeout); Module._load = originalLoad; (process as any).parentPort = originalPort;
    port.removeAllListeners(); delete require.cache[require.resolve('../engine/worker.ts')];
    await fs.rm(home, { recursive: true, force: true });
  }
});
