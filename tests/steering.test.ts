import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskRunner } from '../engine/runner';
import { ToolRegistry } from '../engine/tools';
import { SteeringInbox } from '../engine/steering';
import { defaults, type Followup, type EngineEvent, type Message } from '../shared/types';

test('steering skips unstarted old writes and commands while preserving complete tool groups and applying each request once', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'jalo-steering-')), inbox = new SteeringInbox(), events: EngineEvent[] = [], requests: Message[][] = [];
  const followup: Followup = { id: 'request', prompt: '改为只解释，不写文件', kind: 'steer', model: 'mock', mode: 'execute', createdAt: 1 };
  let approvals = 0, round = 0;
  const provider: any = { async generate(messages: Message[]) {
    requests.push(structuredClone(messages));
    if (!round++) {
      inbox.add(followup); inbox.add(followup);
      return { finishReason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: ['write_file', 'run_command'].map((name, i) => ({ id: String(i), type: 'function', function: { name, arguments: JSON.stringify(name === 'write_file' ? { path: 'a.txt', content: 'must not write' } : { command: 'touch executed' }) } })) } };
    }
    return { finishReason: 'stop', message: { role: 'assistant', content: '只解释，没有执行修改。' } };
  } };
  const signal = new AbortController();
  const emit = (event: EngineEvent) => events.push(structuredClone(event));
  const tools = new ToolRegistry({ root: home, backupDir: path.join(home, 'backups'), signal: signal.signal, timeout: 1, emit, approve: async () => { approvals++; return true; } });
  try {
    await new TaskRunner(provider, tools, defaults, emit, signal.signal, () => inbox.take()).run({ messages: [{ role: 'user', content: '修改文件' }] }, false);
    assert.equal(approvals, 0); await assert.rejects(fs.stat(path.join(home, 'a.txt')), { code: 'ENOENT' }); await assert.rejects(fs.stat(path.join(home, 'executed')), { code: 'ENOENT' });
    assert.equal(events.filter(e => e.type === 'followup-applied').length, 1);
    const messages = requests[1], call = messages.findIndex(m => !!m.tool_calls);
    assert.equal(messages[call + 1].role, 'tool'); assert.equal(messages[call + 2].role, 'tool'); assert.equal(messages[call + 3].content, followup.prompt);
    assert.equal((events.at(-1) as any).status, 'completed');
    inbox.add(followup); assert.deepEqual(inbox.take(), []);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
