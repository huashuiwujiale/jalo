import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createInterface } from 'node:readline/promises';
import { LMStudioProvider } from '../engine/provider';
import { TaskRunner } from '../engine/runner';
import { ToolRegistry } from '../engine/tools';
import { defaults, type EngineEvent } from '../shared/types';

async function main() {
  const settings = { ...defaults, baseUrl: process.env.LM_STUDIO_URL || defaults.baseUrl, token: process.env.LM_STUDIO_TOKEN || '', maxSteps: 12, maxTokens: 4096 };
  const provider = new LMStudioProvider(settings);
  const models = await provider.list();
  const model = models.find(m => m.key === process.env.LM_STUDIO_MODEL) || models.find(m => m.instances.length && m.toolUse !== false) || models.find(m => m.key === 'qwen/qwen3-8b') || models.filter(m => m.toolUse).sort((a,b) => a.size - b.size)[0];
  if (!model) throw new Error('没有可用的工具调用模型，请在 LM Studio 中下载一个');
  const instance = model.instances[0];
  settings.model = instance?.id || await provider.load(model.key, 16384);
  settings.contextLength = instance ? instance.contextLength : 16384;
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'local-code-live-')));
  console.log(`模型：${model.name}\n样例目录：${root}`);
  await fs.writeFile(path.join(root, 'sum.js'), 'export function sum(a, b) { return a - b; }\n');
  await fs.writeFile(path.join(root, 'AGENTS.md'), '修改前读取文件。不要编译或打包。唯一允许的验证命令是 node --version。');
  const controller = new AbortController(), events: EngineEvent[] = [];
  let commandApproved = false;
  const emit = (e: EngineEvent) => {
    events.push(e);
    if (e.type === 'event' && ['notice', 'error'].includes(e.event.kind)) console.log(e.event.text);
    if (e.type === 'event' && e.event.kind === 'message') console.log(e.event.text);
    if (e.type === 'change') console.log(e.change.patch);
    if (e.type === 'done') console.log('任务结果：', e.status, e.error || '');
  };
  const tools = new ToolRegistry({ root, backupDir: path.join(root, '.backups'), signal: controller.signal, timeout: 10, emit, approve: async approval => {
    console.log(`申请命令：${approval.command}\n目录：${approval.cwd}`);
    if (approval.command.trim() !== 'node --version' || approval.cwd !== root) return false;
    if (process.argv.includes('--approve-fixture-command')) { commandApproved = true; return true; }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { commandApproved = (await rl.question('允许执行该只读验证命令？输入 yes：')).trim() === 'yes'; return commandApproved; } finally { rl.close(); }
  } });
  const timeout = setTimeout(() => controller.abort(), 600000);
  try {
    await new TaskRunner(provider, tools, settings, emit, controller.signal).run({ messages: [{ role: 'user', content: '请读取 sum.js 和项目说明，修正 sum(a,b) 的加法错误，保留导出形式。修改完成后申请执行 node --version 这一条只读命令，然后总结。不运行其他命令，不编译，不创建其他文件。' }] });
    assert.equal((events.at(-1) as any).status, 'completed', JSON.stringify(events.at(-1)));
    assert.match(await fs.readFile(path.join(root, 'sum.js'), 'utf8'), /a\s*\+\s*b/);
    assert.ok(events.some(e => e.type === 'change'), '未产生差异');
    assert.ok(commandApproved, '模型没有完成命令确认流程');
    assert.ok(events.some(e => e.type === 'event' && e.event.kind === 'output'), '未产生命令输出');
    console.log('LIVE ACCEPTANCE PASSED');
  } finally {
    clearTimeout(timeout); await fs.writeFile(path.join(root, 'events.json'), JSON.stringify(events, null, 2));
    if (!instance) await provider.unload(settings.model).catch(() => {});
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
