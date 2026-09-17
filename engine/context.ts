import type { Message } from '../shared/types';
import type { ToolDefinition } from './provider';
// Conservative estimate: UTF-8 bytes / 2 plus message overhead. Exact tokenization is model-specific.
export const estimate = (value: unknown) => Math.ceil(Buffer.byteLength(JSON.stringify(value), 'utf8') / 2);
export function compactContext(messages: Message[], tools: ToolDefinition[], contextLength: number, maxTokens: number): { messages: Message[]; compacted: boolean } {
  const budget = Math.floor(contextLength * 0.8) - maxTokens - estimate(tools);
  if (budget <= 0) throw new Error('上下文不足以容纳工具定义，请提高上下文长度或降低最大输出');
  if (estimate(messages) <= budget) return { messages, compacted: false };
  const system = messages.filter(m => m.role === 'system');
  // Group in chronological order. A user turn is a boundary, never move it
  // ahead of old assistant/tool records when selecting the retained history.
  const units: Message[][] = [];
  for (const m of messages.filter(m => m.role !== 'system')) {
    if (m.role === 'tool' && units.at(-1)?.[0].role === 'assistant') units.at(-1)!.push(m);
    else units.push([m]);
  }
  const groups = units.filter(unit => unit[0].role !== 'user');
  let keep = Math.min(3, groups.length);
  while (keep >= 0) {
    const old = groups.slice(0, groups.length - keep).flat();
    const notes = old.slice(-16).map(m => `${m.role}: ${(m.content || '').slice(0, 320)}${m.tool_calls ? ' 工具: ' + m.tool_calls.map(c => c.function.name).join(', ') : ''}`).join('\n');
    const retained = new Set(groups.slice(groups.length - keep));
    const candidate: Message[] = [...system];
    let summarized = false;
    for (const unit of units) {
      if (unit[0].role === 'user' || retained.has(unit)) candidate.push(...unit);
      else if (!summarized) {
        candidate.push({ role: 'assistant', content: `较早执行记录已压缩。以下为历史摘要，结果可能已过时，修改文件前须重新读取：\n${notes || '无'} ` });
        summarized = true;
      }
    }
    if (estimate(candidate) <= budget) return { messages: candidate, compacted: true };
    keep--;
  }
  throw new Error('用户要求和项目指令超过上下文容量，请提高上下文长度或新建更小的任务');
}
