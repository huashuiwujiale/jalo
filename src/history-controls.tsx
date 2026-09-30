import React from 'react';
import type { Run } from '../shared/types';

export function HistoryControls({ hasMore, loading, incomplete, load }: { hasMore: boolean; loading: boolean; incomplete?: boolean; load: () => void }) {
  return <div className="history-pagination">
    {hasMore && <button className="outline" disabled={loading} onClick={load}>{loading ? '正在加载更早记录…' : '加载更早记录'}</button>}
    {incomplete && <p>旧版本可能已丢失更早记录，当前显示仍保存的历史。</p>}
  </div>;
}

export function PlanActions({ run, disabled, execute }: { run: Run; disabled: boolean; execute: () => void }) {
  if (run.mode !== 'plan' || run.status !== 'completed') return null;
  if (!run.planText?.trim()) return <p className="inspector-note">该计划缺少完整保存的正文，请重新生成计划后执行。</p>;
  return <div className="saved-plan"><details><summary>查看保存的计划</summary><pre>{run.planText}</pre></details>
    <button className="primary" disabled={disabled} onClick={execute}>按计划执行</button>
  </div>;
}
