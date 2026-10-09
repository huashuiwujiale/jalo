import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaults, type Message } from '../shared/types';
import { settingsSchema } from '../shared/validation';
import { modelServiceKey, changeModelService } from '../shared/model-service';
import { createProvider } from '../engine/providers';
import { OllamaProvider } from '../engine/ollama';
import { LMStudioProvider } from '../engine/provider';
import { Store } from '../electron/store';
import { TaskRunner } from '../engine/runner';
import { ToolRegistry } from '../engine/tools';

const config = { ...defaults, provider: 'ollama' as const, baseUrl: 'http://127.0.0.1:11434', model: 'coder:latest' };
function stream(chunks: unknown[], endNewline = true) {
  const bytes = new TextEncoder().encode(chunks.map(c => JSON.stringify(c)).join('\n') + (endNewline ? '\n' : ''));
  return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3)); controller.close(); } }));
}
const call = (name: string, args: unknown) => ({ function: { name, arguments: args } });
const done = (message: unknown = {}) => ({ message, done: true, done_reason: 'stop' });

test('service settings preserve legacy LM Studio configuration and isolate catalog identities', () => {
  const { provider: _, ...legacy } = defaults;
  assert.equal(settingsSchema.parse(legacy).provider, 'lmstudio');
  assert.ok(createProvider(legacy) instanceof LMStudioProvider);
  assert.ok(createProvider(config) instanceof OllamaProvider);
  assert.equal(settingsSchema.safeParse({ ...config, provider: 'unknown' }).success, false);
  const changed = changeModelService({ ...defaults, token: 'secret', model: 'old' }, 'ollama');
  assert.equal(changed.baseUrl, config.baseUrl); assert.equal(changed.token, ''); assert.equal(changed.model, '');
  assert.equal(changeModelService(changed, 'lmstudio').baseUrl, defaults.baseUrl);
  assert.notEqual(modelServiceKey(config), modelServiceKey({ ...config, provider: 'lmstudio' }));
});

test('Ollama settings survive reopening and old stored settings remain readable', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'jalo-ollama-store-')), file = path.join(home, 'state.sqlite');
  let store = await Store.open(file);
  try {
    const { provider: _, ...legacy } = defaults;
    store.putSettings(legacy); store.close(); store = await Store.open(file);
    assert.equal(store.settings().provider, 'lmstudio');
    store.putSettings(config); store.close(); store = await Store.open(file);
    assert.deepEqual(store.settings(), config);
  } finally { store.close(); await fs.rm(home, { recursive: true, force: true }); }
});

test('Ollama catalog reads capabilities and actual context without loading models, filtering embeddings and cloud', async () => {
  const requests: string[] = [];
  const p = createProvider(config, (async (url, options) => {
    const route = new URL(String(url)).pathname; requests.push(route);
    if (route === '/api/tags') return Response.json({ models: ['coder:latest', 'plain:latest', 'embed:latest', 'remote:latest', 'coder:480b-cloud', 'glm:cloud'].map(name => ({ name, size: 100 })) });
    if (route === '/api/ps') return Response.json({ models: [{ name: 'coder:latest', context_length: 8192 }] });
    const key = JSON.parse(String(options?.body)).model;
    return Response.json({ capabilities: key.startsWith('embed') ? ['embedding'] : key.startsWith('coder') ? ['completion', 'tools'] : ['completion'],
      model_info: { 'qwen3moe.context_length': 262144 }, ...(key.startsWith('remote') ? { remote_host: 'https://ollama.com' } : {}) });
  }) as typeof fetch);
  const models = await p.list(); assert.deepEqual(models.map(m => m.key), ['coder:latest', 'plain:latest']);
  assert.equal(models[0].toolUse, true); assert.equal(models[1].toolUse, false);
  assert.equal(models[0].maxContext, 262144); assert.deepEqual(models[0].instances, [{ id: 'coder:latest', contextLength: 8192 }]);
  assert.deepEqual(models[1].instances, []); assert.ok(!requests.includes('/api/generate'));
});

test('Ollama load and unload use native lifecycle and verify allocated context', async () => {
  const bodies: any[] = [];
  const p = new OllamaProvider(config, (async (url, options) => {
    if (String(url).endsWith('/api/ps')) return Response.json({ models: [{ name: config.model, context_length: 16384 }] });
    bodies.push(JSON.parse(String(options?.body))); return Response.json({ done: true });
  }) as typeof fetch);
  assert.equal(await p.load(config.model, 16384), config.model); await p.unload(config.model);
  assert.deepEqual(bodies, [{ model: config.model, stream: false, keep_alive: '5m', options: { num_ctx: 16384 } }, { model: config.model, stream: false, keep_alive: 0 }]);
  const small = new OllamaProvider(config, (async url => String(url).endsWith('/api/ps') ? Response.json({ models: [{ name: config.model, context_length: 4096 }] }) : Response.json({ done: true })) as typeof fetch);
  await assert.rejects(small.load(config.model, 16384), /上下文长度/);
});

test('Ollama streams UTF-8, maps complete calls to unique IDs and roundtrips history and tool names', async () => {
  const bodies: any[] = []; let activity = 0;
  const p = new OllamaProvider(config, (async (_url, options) => {
    bodies.push(JSON.parse(String(options?.body)));
    return stream([{ message: { thinking: '思考' } }, { message: { content: '你好', tool_calls: [call('read_file', { path: 'a.txt' }), call('read_file', { path: 'b.txt' })] } }, done()], false);
  }) as typeof fetch);
  let text = ''; const first = await p.generate([], [], new AbortController().signal, d => text += d, undefined, () => activity++);
  assert.equal(text, '你好'); assert.equal(activity, 1); assert.equal(first.reasoningCharacters, 2); assert.equal(first.finishReason, 'tool_calls');
  const calls = first.message.tool_calls!; assert.equal(calls.length, 2); assert.notEqual(calls[0].id, calls[1].id);
  const history: Message[] = [first.message, ...calls.map(c => ({ role: 'tool' as const, content: '原文', tool_call_id: c.id }))];
  await p.generate(history, [], new AbortController().signal, () => {});
  assert.deepEqual(bodies[1].messages[0].tool_calls[0].function, { name: 'read_file', arguments: { path: 'a.txt' } });
  assert.deepEqual(bodies[1].messages[1], { role: 'tool', content: '原文', tool_name: 'read_file' });
  assert.deepEqual(bodies[0].options, { num_ctx: config.contextLength, num_predict: config.maxTokens, temperature: config.temperature });
  assert.ok(!JSON.stringify(bodies[1].messages).includes('思考'));
});

test('Ollama partial, malformed and failed streams never return tools; length endings remain visible to runner', async () => {
  for (const chunks of [
    [{ message: { tool_calls: [call('run_command', { command: 'echo dangerous' })] } }],
    [{ error: 'out of memory' }],
    [done({ tool_calls: [call('run_command', 'echo dangerous')] })],
  ]) {
    const p = new OllamaProvider(config, (async () => stream(chunks)) as typeof fetch);
    await assert.rejects(p.generate([], [], new AbortController().signal, () => {}));
  }
  const length = new OllamaProvider(config, (async () => stream([{ message: { tool_calls: [call('read_file', {})] }, done: true, done_reason: 'length' }])) as typeof fetch);
  assert.equal((await length.generate([], [], new AbortController().signal, () => {})).finishReason, 'length');
  const broken = new OllamaProvider(config, (async () => new Response('not json\n')) as typeof fetch);
  await assert.rejects(broken.generate([], [], new AbortController().signal, () => {}), /流式 JSON/);
});

test('Ollama connection, auth, cancellation and stream timeout errors identify the service', async () => {
  const offline = new OllamaProvider(config, (async () => { throw new TypeError('fetch failed'); }) as typeof fetch);
  await assert.rejects(offline.list(), /无法连接 Ollama/);
  const auth = new OllamaProvider({ ...config, token: 'secret' }, (async () => new Response('secret', { status: 401 })) as typeof fetch);
  await assert.rejects(auth.list(), e => { assert.match((e as Error).message, /Ollama HTTP 401/); assert.doesNotMatch((e as Error).message, /secret/); return true; });
  const broken = new OllamaProvider(config, (async () => new Response(new ReadableStream({ start(c) { c.error(new DOMException('timeout', 'TimeoutError')); } }))) as typeof fetch);
  const controller = new AbortController();
  await assert.rejects(broken.generate([], [], controller.signal, () => {}), /Ollama 响应流超时/);
  controller.abort(); await assert.rejects(broken.generate([], [], controller.signal, () => {}), /任务已停止/);
});

test('Ollama provider integrates with real tool probe and file reads in a temporary project', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jalo-ollama-runner-')), controller = new AbortController();
  const events: any[] = [], bodies: any[] = [];
  try {
    await fs.writeFile(path.join(root, 'a.txt'), '随机样例内容');
    const responses = [done({ tool_calls: [call('capability_check', { ok: true })] }), done({ tool_calls: [call('read_file', { path: 'a.txt' })] }), done({ content: '已读取样例。' })];
    const p = createProvider(config, (async (_url, options) => { bodies.push(JSON.parse(String(options?.body))); return stream([responses.shift()]); }) as typeof fetch);
    const registry = new ToolRegistry({ root, backupDir: path.join(root, 'backups'), mode: 'plan', signal: controller.signal, timeout: 1, emit: e => events.push(e), approve: async () => { throw new Error('只读任务不应申请命令'); } });
    await new TaskRunner(p, registry, config, e => events.push(e), controller.signal).run({ messages: [{ role: 'user', content: '读取 a.txt' }] });
    assert.equal(events.at(-1).status, 'completed');
    assert.deepEqual(bodies[0].tools.map((t: any) => t.function.name), ['capability_check']);
    assert.ok(bodies[2].messages.some((m: any) => m.role === 'tool' && m.tool_name === 'read_file' && m.content.includes('随机样例内容')));
    assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), '随机样例内容');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Ollama tool calls retain individual command approval and denied commands never start', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jalo-ollama-approval-')), controller = new AbortController();
  const events: any[] = [], bodies: any[] = []; let approvals = 0;
  try {
    const responses = [done({ tool_calls: [call('capability_check', { ok: true })] }), done({ tool_calls: [call('run_command', { command: 'printf should-not-run' })] }), done({ content: '命令已拒绝。' })];
    const p = createProvider(config, (async (_url, options) => { bodies.push(JSON.parse(String(options?.body))); return stream([responses.shift()]); }) as typeof fetch);
    const registry = new ToolRegistry({ root, backupDir: path.join(root, 'backups'), signal: controller.signal, timeout: 1, emit: e => events.push(e), approve: async approval => { approvals++; assert.equal(approval.command, 'printf should-not-run'); return false; } });
    await new TaskRunner(p, registry, config, e => events.push(e), controller.signal).run({ messages: [{ role: 'user', content: '申请一条验证命令' }] });
    assert.equal(events.at(-1).status, 'completed'); assert.equal(approvals, 1);
    assert.ok(!events.some(e => e.type === 'process' || e.type === 'event' && e.event.kind === 'output'));
    assert.ok(bodies[2].messages.some((m: any) => m.role === 'tool' && m.tool_name === 'run_command' && m.content.includes('用户拒绝')));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
