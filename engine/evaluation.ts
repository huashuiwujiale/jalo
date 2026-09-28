import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ToolRegistry } from './tools';
import { TaskRunner } from './runner';
import { checkSyntax } from './syntax';
import { LMStudioProvider, type ModelProvider } from './provider';
import { endEvaluation, type EvaluationReport } from '../shared/evaluation';
import type { EngineEvent, Settings } from '../shared/types';

class EvaluationTools extends ToolRegistry {
  reads = new Set<string>(); rereads = new Set<string>(); wrote = false; commandsDenied = 0;
  toolDefinitions() { return super.toolDefinitions().filter(t => t.function.name !== 'run_command'); }
  async execute(name: string, args: any) {
    if (name === 'run_command') { this.commandsDenied++; throw new Error('能力实测禁止所有终端命令'); }
    const result = await super.execute(name, args);
    if (['read_file', 'find_vue_elements'].includes(name)) { this.reads.add(path.normalize(args.path)); if (this.wrote) this.rereads.add(path.normalize(args.path)); }
    if (['write_file', 'edit_file', 'replace_lines', 'edit_vue_element'].includes(name) && result.startsWith('已修改 ')) { this.wrote = true; this.rereads.clear(); }
    return result;
  }
}
async function inventory(root: string, relative = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) Object.assign(result, await inventory(root, name));
    else if (entry.isFile()) result[name] = await fs.readFile(path.join(root, name), 'utf8');
    else throw new Error('样例中出现非普通文件');
  }
  return result;
}
const normalizeBlankLines = (text: string) => text.replace(/\r\n/g, '\n').replace(/^[ \t]*\n/gm, '').trim();

/** home is a newly-created private temporary directory, never a user's project. */
export async function runEvaluation(report: EvaluationReport, saved: Settings, home: string, signal: AbortSignal, update: (report: EvaluationReport) => void, providerFactory: (settings: Settings) => ModelProvider = s => new LMStudioProvider(s)) {
  const config = { ...saved, ...report.parameters };
  const safeError = (error: unknown) => {
    let text = error instanceof Error ? error.message : String(error);
    for (const secret of [saved.token, saved.baseUrl, home]) if (secret) text = text.split(secret).join('[已隐藏]');
    return text.slice(0, 1200);
  };
  try {
    const provider = providerFactory(config);
    const models = await provider.list(signal); signal.throwIfAborted();
    const model = models.find(m => m.key === config.model || m.instances.some(i => i.id === config.model));
    const instance = model?.instances.find(i => i.id === config.model) || model?.instances[0];
    if (!instance) throw new Error('当前模型尚未加载。请先加载选定模型，再开始实测；不会自动加载或切换模型。');
    if (model?.toolUse === false) throw new Error('LM Studio 标记此模型不支持工具调用');
    config.model = instance.id;
    config.contextLength = Math.min(config.contextLength, instance.contextLength, model!.maxContext);
    report.instance = instance.id; report.parameters.contextLength = config.contextLength; update(report);
    if (config.maxTokens >= config.contextLength / 2) throw new Error('已加载模型上下文不足，请降低最大输出或使用更大的上下文重新加载');
    for (const item of report.cases) {
      signal.throwIfAborted();
      item.status = 'running'; item.startedAt = Date.now(); update(report);
      const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(), report.caseTimeoutMs);
      const caseSignal = AbortSignal.any([signal, timeout.signal]);
      try {
        const root = path.join(home, item.id); await fs.mkdir(root);
        const nonce = randomUUID();
        const add = '    <el-button\n      type="primary"\n      @click="handleAdd"\n    >新增</el-button>\n';
        const source = `<template>\n  <div>\n${add}    <el-button @click="handleExport">导出</el-button>\n  </div>\n</template>\n<script>\nexport default { methods: { handleAdd() {}, handleExport() {} } }\n</script>\n`;
        const file = item.id === 'read' ? 'config.json' : item.id === 'text' ? 'greeting.txt' : 'index.vue';
        await fs.writeFile(path.join(root, file), item.id === 'read' ? JSON.stringify({ verificationCode: nonce }) : item.id === 'text' ? 'hello\n' : source);
        await fs.writeFile(path.join(root, 'keep.txt'), `请保留：${nonce}\n`);
        await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { vue: '^2.6.12' } }));
        const before = await inventory(root);
        let done: Extract<EngineEvent, { type: 'done' }> | undefined, answer = '';
        const emit = (event: EngineEvent) => {
          if (event.type === 'done') done = event;
          if (event.type === 'event' && event.event.role === 'assistant') answer = event.event.text;
          if (event.type === 'progress') { item.phase = event.progress.phase; item.step = event.progress.step; update(report); }
        };
        const tools = new EvaluationTools({ root, backupDir: path.join(home, 'backups', item.id), mode: item.id === 'read' ? 'plan' : 'execute',
          runId: randomUUID(), signal: caseSignal, timeout: 1, emit, approve: async () => false,
          checkpoint: async checkpoint => { await fs.writeFile(path.join(home, `${item.id}-checkpoint.json`), JSON.stringify(checkpoint), { mode: 0o600 }); } });
        const prompt = item.id === 'read' ? '只读任务：用 read_file 读取 config.json，在最终回复中逐字给出 verificationCode 的值，不要修改文件或执行命令。' : item.id === 'text' ? '读取 greeting.txt，把 hello 改为 hello Jalo，保留末尾换行及所有其他文件。修改后重新读取核对，再总结。不要执行命令。' : '读取 index.vue，完整删除 @click="handleAdd" 的新增按钮，保留导出按钮、脚本和其他代码，保持原缩进。修改后重新读取核对，再总结。不要执行命令，不运行编译。';
        await new TaskRunner(provider, tools, config, emit, caseSignal).run({ messages: [{ role: 'user', content: prompt }] });
        if (signal.aborted) { item.status = 'cancelled'; item.error = '已停止实测'; }
        else if (timeout.signal.aborted) { item.status = 'failed'; item.error = '单项测试达到 3 分钟上限'; }
        else {
          const after = await inventory(root), changed = tools.evidence().changedFiles;
          const unchanged = Object.keys(before).length === Object.keys(after).length && Object.keys(before).every(name => name === file && item.id !== 'read' || before[name] === after[name]);
          item.checks = [
            { title: '引擎正常结束', passed: done?.status === 'completed' },
            { title: '真实读取目标文件', passed: tools.reads.has(file) },
            { title: '保留其他文件', passed: unchanged },
            { title: '遵守禁止命令要求', passed: tools.commandsDenied === 0 },
          ];
          if (item.id === 'read') item.checks.push({ title: '正确返回随机校验码且未写入', passed: answer.includes(nonce) && changed.length === 0 });
          else {
            item.checks.push({ title: '有真实写入记录', passed: changed.includes(file) && before[file] !== after[file] }, { title: '修改后重新读取', passed: tools.rereads.has(file) });
            if (item.id === 'text') item.checks.push({ title: '文本与预期完全一致', passed: after[file] === 'hello Jalo\n' });
            else item.checks.push({ title: '仅删除新增，完整保留导出与脚本', passed: typeof after[file] === 'string' && normalizeBlankLines(after[file]) === normalizeBlankLines(source.replace(add, '')) }, { title: 'Vue 语法检查通过', passed: typeof after[file] === 'string' && checkSyntax(file, after[file], 2).status === 'passed' });
          }
          item.status = item.checks.every(c => c.passed) ? 'passed' : 'failed';
          if (item.status === 'failed') item.error = done?.error ? safeError(done.error) : item.checks.filter(c => !c.passed).map(c => c.title).join('；');
        }
      } catch (error) { item.status = signal.aborted ? 'cancelled' : 'failed'; item.error = safeError(error); }
      finally { clearTimeout(timer); item.durationMs = Date.now() - item.startedAt!; update(report); }
    }
    endEvaluation(report, signal.aborted ? 'cancelled' : 'completed', signal.aborted ? '已停止实测' : undefined);
  } catch (error) { endEvaluation(report, signal.aborted ? 'cancelled' : 'failed', signal.aborted ? '已停止实测' : safeError(error)); }
  finally {
    try { await fs.rm(home, { recursive: true, force: true }); } catch { report.error = (report.error ? report.error + '；' : '') + '临时样例清理失败'; }
    update(report);
  }
}
