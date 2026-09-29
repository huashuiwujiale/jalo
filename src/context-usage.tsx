import React from 'react';
import type { ContextUsage } from '../shared/context';

export function ContextMeter({ usage }: { usage?: ContextUsage }) {
  if (!usage) return null;
  const reserved = usage.inputTokens + usage.outputReserve + usage.safetyReserve;
  const percent = Math.ceil(reserved / usage.contextLength * 100);
  const number = (n: number) => n.toLocaleString('zh-CN');
  return <details className="context-usage">
    <summary>上下文估算 · {percent}%（含预留）{usage.compactions > 0 ? ` · 本轮压缩 ${usage.compactions} 次` : ''}</summary>
    <progress aria-label="上下文估算占用（含输出和安全预留）" max={usage.contextLength} value={Math.min(reserved,usage.contextLength)}/>
    <p>最近整理的输入约 {number(usage.inputTokens)} tokens（含工具定义 {number(usage.toolTokens)}）；输出预留 {number(usage.outputReserve)}，安全预留 {number(usage.safetyReserve)}，模型可用上限 {number(usage.contextLength)}。</p>
    {usage.beforeTokens > usage.inputTokens && <p>此次压缩：输入约 {number(usage.beforeTokens)} → {number(usage.inputTokens)} tokens。</p>}
    {reserved > usage.contextLength && <p>超出预留预算，当前上下文无法安全发送；请缩小任务或调整上下文设置。</p>}
    <small>按文本字节估算，并非模型实际 token 计数。记录保留至本轮结束；语法通过和模型总结均不代表任务已验收。</small>
  </details>;
}
