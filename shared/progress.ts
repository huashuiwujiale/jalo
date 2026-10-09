import type { Progress, Task, TaskDetail, RunChange, RunChangeView } from './types';
export const hasChange = (change: RunChange | RunChangeView) => 'changed' in change ? change.changed : change.before !== change.after;
export const phaseLabels: Record<Progress['phase'], string> = {
  queued: '等待其他任务完成', preparing: '整理上下文', connecting: '连接模型服务', loading: '加载模型',
  probing: '验证工具调用能力', waiting_model: '等待模型响应', generating: '模型正在生成',
  tool: '执行工具', approval: '等待命令确认', command: '执行终端命令', stopping: '正在停止',
};
export function recoveryHint(error = '') {
  if (/连接|HTTP 401|令牌/.test(error)) return '检查模型服务地址、服务是否启动及访问令牌，然后继续。';
  if (/上下文|输出达到上限|空回复|没有最终回复|没有返回正文/.test(error)) return '检查上下文和最大输出设置；历史过长时查看续接摘要，整理目标与约束后从新上下文继续。';
  if (/模型加载|加载模型|out of memory/i.test(error)) return '在模型服务中检查模型加载状态和可用内存，再继续任务。';
  if (/超时|timeout/i.test(error)) return '检查模型服务是否仍在响应，必要时缩短上下文。命令超时时先核对输出和磁盘状态。';
  if (/语法|定位|匹配|外部|冲突|读取|失效/.test(error)) return '先查看当前原文和差异，补充目标位置；继续时重新读取文件，再修正修改。';
  if (/工具调用|执行依据|实际执行/.test(error)) return '检查当前模型的工具调用能力，必要时手动更换模型，再继续。';
  return '先核对本轮修改和终端输出，补充要求后继续；不确定的操作请先检查实际状态。';
}
export function recoverySummary(task: Task | TaskDetail) {
  const run = task.runs?.find(r => r.id === task.currentRunId) || task.runs?.at(-1);
  return {
    run,
    written: run?.changes.filter(c => c.state === 'written' && hasChange(c)).map(c => c.path) || [],
    uncertain: run?.changes.filter(c => c.state === 'prepared' || c.state === 'uncertain').map(c => c.path) || [],
    hint: recoveryHint(task.error),
  };
}
export function recoveryPrompt(task: Task | TaskDetail) {
  const { run } = recoverySummary(task);
  return `继续上一轮要求：${run?.input || task.title}\n请先重新读取相关文件并检查现有差异，确认哪些步骤已经完成，再继续未完成部分。不要直接重放历史工具或命令；所有新命令仍需逐条确认。`;
}
