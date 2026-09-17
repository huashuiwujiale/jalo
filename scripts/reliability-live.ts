/** Uses only temporary fixtures and the explicitly selected, already-loaded local model. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { LMStudioProvider } from '../engine/provider';
import { TaskRunner } from '../engine/runner';
import { ToolRegistry } from '../engine/tools';
import { checkSyntax } from '../engine/syntax';
import { defaults, type EngineEvent } from '../shared/types';
async function main() {
  const modelId = process.env.JALO_MODEL;
  if (!modelId) throw new Error('请通过 JALO_MODEL 明确指定已加载的本地模型；不会自动切换或加载模型');
  const settings = { ...defaults, model: modelId, maxTokens: 4096, maxSteps: 8, temperature: 0 };
  const provider = new LMStudioProvider(settings);
  const model = (await provider.list()).find(m => m.key === modelId || m.instances.some(i => i.id === modelId));
  const instance = model?.instances.find(i => i.id === modelId) || model?.instances[0];
  if (!instance) throw new Error('指定模型尚未加载，本脚本不自动加载或切换模型');
  settings.model = instance.id; settings.contextLength = Math.min(16384, instance.contextLength);
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'jalo-reliability-live-'));
  const report: any = { model: settings.model, contextLength: settings.contextLength, at: new Date().toISOString(), home, cases: [] };
  console.log('fixture:', home);
  for (const test of ['text', 'vue'] as const) {
    const root = path.join(home, test); await fs.mkdir(root);
    const source = test === 'text' ? 'hello\n' : `<template>
  <div>
    <el-button
      type="primary"
      @click="handleAdd"
    >新增</el-button>
    <el-button @click="handleExport">导出</el-button>
  </div>
</template>
<script>
export default { methods: { handleAdd() {}, handleExport() {} } }
</script>
`;
    const file = test === 'text' ? 'sample.txt' : 'index.vue';
    await fs.writeFile(path.join(root, file), source);
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { vue: '^2.6.12' } }));
    const events: EngineEvent[] = [], controller = new AbortController(), runId = randomUUID();
    const timer = setTimeout(() => controller.abort(), 180000);
    const emit = (event: EngineEvent) => { events.push(event); if (event.type === 'check') console.log(test, 'syntax', event.check.status); if (event.type === 'done') console.log(test, event.status, event.error || '', event.evidence); };
    const tools = new ToolRegistry({ root, backupDir: path.join(home, 'backups', test), runId, mode:'execute', signal: controller.signal, timeout: 5, emit, approve: async () => false, checkpoint: async c => { await fs.writeFile(path.join(home, test + '-checkpoint.json'), JSON.stringify(c)); } });
    const prompt = test === 'text' ? '读取 sample.txt，然后把 hello 改成 hello Jalo。必须调用真实文件工具。不要执行命令。' : '读取 index.vue，完整删除新增按钮，保留导出按钮及其他代码。必须用真实文件工具，修改后重新读取检查。不要执行命令，不运行编译。';
    try { await new TaskRunner(provider, tools, settings, emit, controller.signal).run({ messages: [{ role: 'user', content: prompt }] }); }
    finally { clearTimeout(timer); }
    const after = await fs.readFile(path.join(root, file), 'utf8');
    const passed = test === 'text' ? after.trim() === 'hello Jalo' : !after.includes('>新增') && after.includes('>导出') && checkSyntax(file, after, 2).status === 'passed';
    report.cases.push({ test, passed, changed: after !== source, done: events.findLast(e => e.type === 'done'), checks: events.filter(e => e.type === 'check') });
    await fs.writeFile(path.join(home, test + '-events.json'), JSON.stringify(events, null, 2));
    await fs.writeFile(path.join(home, 'report.json'), JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify(report, null, 2));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
