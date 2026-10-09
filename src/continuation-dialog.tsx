import React, { useEffect, useState } from 'react';
import type { Api } from '../shared/types';
import type { ContinuationPreview } from '../shared/continuation';
import { stopLabels } from '../shared/continuation';

export function ContinuationDialog({ api, taskId, extraGoal, model, close, resumed }: { api: Api; taskId: string; extraGoal: string; model: string; close: () => void; resumed: () => void }) {
  const [preview, setPreview] = useState<ContinuationPreview>(), [goal, setGoal] = useState<string>(), [error, setError] = useState(''), [loading, setLoading] = useState(false), [sending, setSending] = useState(false), [attempt, retry] = useState(0);
  useEffect(() => {
    let active = true; setLoading(true); setError(''); setPreview(undefined);
    api.continuationPreview(taskId).then(value => { if (active) { setPreview(value); setGoal(old => old ?? [value.goal, extraGoal.trim() && `补充要求：${extraGoal}`].filter(Boolean).join('\n\n')); } }, e => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [taskId, attempt]);
  const start = async () => {
    if (!preview || !goal?.trim()) return;
    setSending(true); setError('');
    try { await api.resumeTask({ taskId, runId: preview.runId, version: preview.version, goal, model }); resumed(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSending(false); }
  };
  return <div className="modal-backdrop"><section className="continuation-modal" role="dialog" aria-modal="true" aria-label="整理上下文并续接"><header><strong>整理上下文并续接</strong><button disabled={sending} onClick={close}>关闭</button></header>
    {loading && <p>读取任务记录并核对当前文件…</p>}
    {preview && <><p>{stopLabels[preview.checkpoint.reason]}{preview.checkpoint.step ? ` · 第 ${preview.checkpoint.step} 步` : ''}。新轮次使用下面的目标和核对记录，完整聊天历史仍保留。</p>
      <label>续接目标、约束与验收条件<textarea aria-label="续接目标与约束" value={goal || ''} onChange={e => setGoal(e.target.value)} disabled={sending}/></label>
      <small>{(goal || '').length} / 16000 字符 · 请保留仍适用的限制和未完成事项。使用模型：{model || '未选择'}</small>
      {preview.requiresGoal && <p role="alert">历史要求过长或记录不完整，不能自动带入全部目标。请对照聊天历史，在上方明确整理本轮目标与约束后续接。</p>}
      <details open><summary>已核验记录与当前文件</summary>{preview.files.length ? <ul>{preview.files.map((f, i) => <li key={f.path}>{f.path} · 历史状态 {preview.checkpoint.files[i].state} · {f.state === 'unavailable' ? '当前无法读取' : f.state === 'missing' ? '当前不存在' : f.matchesCheckpoint ? '版本与记录一致' : '版本已变化，需重新读取'}</li>)}</ul> : <p>没有已记录的目标文件，继续时仍需先读取项目。</p>}</details>
      <details><summary>命令、失败和待办线索</summary><pre>{JSON.stringify({ commands: preview.checkpoint.commands, issues: preview.checkpoint.issues, unverifiedNotes: preview.checkpoint.notes }, null, 2)}</pre></details>
      {Object.values(preview.checkpoint.omitted).some(n => n > 0) && <p>摘要仅包含近期记录，省略数量：文件 {preview.checkpoint.omitted.files}、命令 {preview.checkpoint.omitted.commands}、失败/拒绝 {preview.checkpoint.omitted.issues}、待办线索 {preview.checkpoint.omitted.notes}。完整记录仍在历史中，请据此收窄续接目标。</p>}
      <p>按原目标估算占用 {preview.estimatedTokens.toLocaleString()} / 配置容量 {preview.contextLength.toLocaleString()} tokens（含工具和预留；实际容量以加载模型为准）。发送时会重新检查编辑后的目标。</p>
      {!!preview.pendingFollowups && <p>另有 {preview.pendingFollowups} 条追加要求，仍保留在原队列。</p>}
      <small>先重新核对文件，不重放历史工具和命令，不沿用旧的命令批准。</small>
    </>}
    {error && <p role="alert">{error}</p>}
    <footer><button disabled={loading || sending} onClick={() => retry(n => n + 1)}>重新核对摘要</button><button className="primary" disabled={loading || sending || !preview || !goal?.trim() || goal.length > 16000 || !model} onClick={() => void start()}>{sending ? '准备续接…' : '按此目标创建续接轮次'}</button></footer>
  </section></div>;
}
