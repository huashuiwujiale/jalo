import React, { useEffect, useState } from 'react';
import type { Task } from '../shared/types';
import { busyStatuses } from '../shared/types';
import { phaseLabels, recoverySummary } from '../shared/progress';
const duration = (ms: number) => { const seconds = Math.max(0, Math.floor(ms / 1000)); return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`; };
export function TaskProgress({ task }: { task: Task }) {
  const [now, setNow] = useState(Date.now());
  const run = task.runs?.find(r => r.id === task.currentRunId) || task.runs?.at(-1);
  const busy = busyStatuses.includes(task.status);
  useEffect(() => { if (!busy) return; setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [busy, task.id]);
  if (!busy) return null;
  const p = run?.progress;
  const label = p ? phaseLabels[p.phase] : task.status === 'queued' ? '排队中' : task.status === 'waiting' ? '等待命令确认' : '执行中';
  return <div className="task-progress"><div><strong role="status">{label}{p?.tool && ['tool','command'].includes(p.phase) ? ` · ${p.tool}` : ''}</strong><span>{p?.step ? `步骤 ${p.step} / ${p.maxSteps} · ` : ''}{p ? `当前阶段 ${duration(now - p.since)}` : ''}{run ? ` · 本轮 ${duration(now - run.createdAt)}` : ''}</span></div>
    <small>{p?.phase === 'approval' ? '等待你的选择；确认后才会启动命令。' : p?.phase === 'waiting_model' ? '请求已发出，尚未收到生成内容；单次推理请求最多等待 5 分钟。' : p?.phase === 'generating' ? '已收到模型生成内容；工具参数完整返回并通过校验后才执行。' : p?.phase === 'stopping' ? '正在取消请求并终止本任务启动的命令。' : p?.phase === 'loading' ? '模型正在加载，耗时取决于模型大小和本机资源。' : '已完成的修改会保留，可在右侧查看实际差异。'}</small>
  </div>;
}
export function RecoveryPanel({ task, disabled, resume, inspect, settings }: { task: Task; disabled: boolean; resume: () => void; inspect: () => void; settings: () => void }) {
  if (!['failed','cancelled','interrupted'].includes(task.status)) return null;
  const { run, written, uncertain, hint } = recoverySummary(task);
  return <section className="task-error recovery-panel"><strong>{task.status === 'failed' ? '本轮执行失败' : task.status === 'cancelled' ? '本轮已停止' : '本轮已中断'}</strong>
    {task.error && <p>{task.error}</p>}
    {run?.progress && <p>最后阶段：{phaseLabels[run.progress.phase]} · 持续 {duration((run.progress.endedAt || run.endedAt || run.progress.since) - run.progress.since)}</p>}
    <p>{run ? written.length ? `本轮已写入并保留：${written.join('、')}` : '本轮没有已核验且仍保留的文件工具修改。' : '历史记录缺少轮次核验，请检查当前文件状态。'}</p>
    {!!uncertain.length && <p>写入状态待核对：{uncertain.join('、')}。请先查看磁盘原文。</p>}
    <p>{hint}</p><small>终端命令可能产生额外影响，请一并检查输出。继续会创建新轮次，先核对当前文件；不会自动重放历史命令。</small>
    <footer><button disabled={disabled} onClick={resume}>补充要求并继续</button><button onClick={inspect}>查看本轮差异</button><button onClick={settings}>模型与设置</button></footer>
  </section>;
}
