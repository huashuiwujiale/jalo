import React, { useState } from 'react';
import type { Run, RunView } from '../shared/types';
import { useRemoteResource } from './remote-resource';
import { Markdown } from './markdown';

export function HistoryControls({ hasMore, loading, incomplete, load }: { hasMore: boolean; loading: boolean; incomplete?: boolean; load: () => void }) {
  return <div className="history-pagination">
    {hasMore && <button className="outline" disabled={loading} onClick={load}>{loading ? '正在加载更早记录…' : '加载更早记录'}</button>}
    {incomplete && <p>旧版本可能已丢失更早记录，当前显示仍保存的历史。</p>}
  </div>;
}

export function PlanActions({ run, disabled, execute, load }: { run: Run | RunView; disabled: boolean; execute: () => void; load?: () => Promise<string> }) {
  const [open, setOpen] = useState(false);
  const saved = 'planText' in run ? run.planText : undefined;
  const resource = useRemoteResource(open && !saved && load ? run.id : '', () => load!());
  if (run.mode !== 'plan' || run.status !== 'completed') return null;
  if (!('hasPlan' in run ? run.hasPlan : saved?.trim())) return <p className="inspector-note">该计划缺少完整保存的正文，请重新生成计划后执行。</p>;
  const text = saved || resource.value;
  return <div className="saved-plan"><details onToggle={event => setOpen(event.currentTarget.open)}><summary>查看保存的计划</summary>{text ? <div className="saved-plan-body"><Markdown text={text}/></div> : <p role={resource.error ? 'alert' : 'status'}>{resource.error || '正在加载保存的计划…'}</p>}{resource.error && <button onClick={resource.retry}>重试</button>}</details>
    <button className="primary" disabled={disabled} onClick={execute}>按计划执行</button>
  </div>;
}
