import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LMStudioProvider } from '../engine/provider';
import { defaults } from '../shared/types';
const frame = (delta: unknown, finish_reason: string | null = null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`;
function fakeStream(text: string, split = 7) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += split) controller.enqueue(bytes.slice(i, i + split)); controller.close(); } }));
}
test('stream parser preserves fragmented UTF-8 text and tool arguments', async () => {
  let sent: any;
  const stream = frame({ content: '你好' }) + frame({ tool_calls: [{ index: 0, id: 'call-a', function: { name: 'read_file', arguments: '{"pa' } }] }) + frame({ tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] }) + frame({}, 'tool_calls') + 'data: [DONE]\n\n';
  const provider = new LMStudioProvider({ ...defaults, model: 'local' }, (async (_url, options) => { sent = JSON.parse(String(options?.body)); return fakeStream(stream); }) as typeof fetch);
  let text = ''; const result = await provider.generate([], [], new AbortController().signal, d => text += d);
  assert.equal(text, '你好'); assert.equal(result.message.tool_calls?.[0].function.arguments, '{"path":"a.ts"}'); assert.equal(sent.stream, true);
});
test('truncated streams cannot turn into executable tools', async () => {
  const p = new LMStudioProvider(defaults, (async () => fakeStream(frame({ tool_calls: [{ index: 0, id: 'x', function: { name: 'run_command', arguments: '{}' } }] }))) as typeof fetch);
  await assert.rejects(p.generate([], [], new AbortController().signal, () => {}), /中断/);
});
test('reasoning-only streams are diagnosed without exposing reasoning as text or tool calls', async () => {
  const stream = frame({ reasoning_content: '考虑调用工具' }) + frame({ reasoning: '更多思考' }) + frame({ content: '\n' }) + frame({}, 'stop') + 'data: [DONE]\n\n';
  const p = new LMStudioProvider(defaults, (async () => fakeStream(stream, 1)) as typeof fetch);
  let visible = '';
  const result = await p.generate([], [], new AbortController().signal, d => visible += d);
  assert.equal(result.reasoningCharacters, '考虑调用工具更多思考'.length);
  assert.equal(visible, '\n'); assert.equal(result.message.content, '\n');
  assert.equal(result.message.tool_calls, undefined); assert.equal(result.finishReason, 'stop');
});
test('capability probe uses the LM Studio compatible required tool choice', async () => {
  let choice: unknown;
  const p = new LMStudioProvider(defaults, (async (_url, options) => { choice = JSON.parse(String(options?.body)).tool_choice; return fakeStream(frame({}, 'stop')); }) as typeof fetch);
  await p.generate([], [], new AbortController().signal, () => {}, 'capability_check');
  assert.equal(choice, 'required');
});
test('v1 model management uses instance IDs and filters embedding models', async () => {
  const requests: { url: string; body?: any }[] = [];
  const p = new LMStudioProvider(defaults, (async (url, options) => {
    requests.push({ url: String(url), body: options?.body && JSON.parse(String(options.body)) });
    if (String(url).endsWith('/models/load')) return Response.json({ instance_id: 'instance-a' });
    if (String(url).endsWith('/models/unload')) return Response.json({ instance_id: 'instance-a' });
    return Response.json({ models: [{ key: 'model-a', type: 'llm', loaded_instances: [{ id: 'instance-a', config: { context_length: 8192 } }] }, { key: 'embedding', type: 'embedding' }] });
  }) as typeof fetch);
  assert.equal((await p.list()).length, 1); assert.equal(await p.load('model-a', 8192), 'instance-a'); await p.unload('instance-a');
  assert.deepEqual(requests[2].body, { instance_id: 'instance-a' });
});
test('connection, auth and loading errors are actionable', async () => {
  const offline = new LMStudioProvider(defaults, (async () => { throw new TypeError('fetch failed'); }) as typeof fetch);
  await assert.rejects(offline.list(), /启动本地服务器/);
  const auth = new LMStudioProvider({ ...defaults, token: 'secret-token' }, (async () => new Response('secret-token', { status: 401 })) as typeof fetch);
  await assert.rejects(auth.list(), error => { assert.match((error as Error).message, /访问令牌/); assert.doesNotMatch((error as Error).message, /secret-token/); return true; });
  const load = new LMStudioProvider(defaults, (async () => new Response('out of memory', { status: 500 })) as typeof fetch);
  await assert.rejects(load.load('m', 4096), /out of memory/);
});
