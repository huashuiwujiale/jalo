import React, { useEffect, useState } from 'react';
import { FlaskConical, Square } from 'lucide-react';
import type { Api } from '../shared/types';
import type { EvaluationReport } from '../shared/evaluation';
import { phaseLabels } from '../shared/progress';
const labels = { pending:'待测试', running:'测试中', passed:'通过', failed:'未通过', cancelled:'已停止', skipped:'未执行', completed:'测试结束', interrupted:'已中断' };
export function ModelEvaluation({ reports, api, disabled, model, start, fail }: { reports: EvaluationReport[]; api: Api; disabled: boolean; model: string; start: () => Promise<void>; fail: (error: unknown) => void }) {
  const [selected, setSelected] = useState(''), [working, setWorking] = useState(false), [now, setNow] = useState(Date.now());
  const active = reports.find(r => r.status === 'running');
  const report = reports.find(r => r.id === selected) || reports[0];
  useEffect(() => { if (active) setSelected(active.id); }, [active?.id]);
  useEffect(() => { if (!active) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [active?.id]);
  async function perform(action: () => Promise<void>) { setWorking(true); try { await action(); } catch (error) { fail(error); } finally { setWorking(false); } }
  const passed = report?.cases.filter(c => c.status === 'passed').length || 0;
  return <section className="model-evaluation" aria-label="模型能力实测">
    <div className="settings-section-heading"><span>模型能力实测</span><small>临时样例 · 不执行命令</small></div>
    <p className="settings-hint">测试所选且已加载的模型：读取校验码、修改文本、删除 Vue 新增按钮。每项最多 8 步、3 分钟；不会自动加载或切换模型。</p>
    <div className="evaluation-actions">{active ? <button className="outline" disabled={working} onClick={() => perform(() => api.stopEvaluation(active.id))}><Square size={13}/>停止实测</button> : <button className="outline" disabled={disabled || working || !model} onClick={() => perform(start)}><FlaskConical size={14}/>{working ? '正在启动…' : '保存配置并实测'}</button>}<small>实测期间暂停提交任务及调整模型</small></div>
    {!!reports.length && <label>实测记录（最近 10 次）<select aria-label="选择实测记录" value={report?.id || ''} onChange={e => setSelected(e.target.value)}>{reports.map(r => <option key={r.id} value={r.id}>{new Date(r.createdAt).toLocaleString('zh-CN')} · {r.model} · {labels[r.status]}</option>)}</select></label>}
    {report && <div className="evaluation-report" aria-live="polite"><strong>{labels[report.status]} · {passed}/{report.cases.length} 项通过{report.status === 'completed' ? `（本次样例通过率 ${Math.round(passed / report.cases.length * 100)}%）` : ''}</strong>
      <p>{report.model}{report.instance && ` · 实例 ${report.instance}`}<br/>Jalo {report.appVersion} · 测试集 v{report.suiteVersion} · 上下文 {report.parameters.contextLength} · 输出 {report.parameters.maxTokens} · 温度 {report.parameters.temperature} · 步数上限 {report.parameters.maxSteps}<br/>总耗时 {Math.max(0, Math.round(((report.endedAt || now) - report.createdAt) / 1000))} 秒</p>
      {report.cases.map(item => <details key={item.id} className={`evaluation-case ${item.status}`}><summary><span>{item.title}</span><span>{labels[item.status]}{item.durationMs !== undefined ? ` · ${(item.durationMs / 1000).toFixed(1)} 秒` : item.startedAt ? ` · ${Math.max(0, Math.round((now - item.startedAt) / 1000))} 秒` : ''}</span></summary>
        {item.status === 'running' && <p>{item.phase ? phaseLabels[item.phase] : '准备临时样例'}{item.step ? ` · 第 ${item.step} 步` : ''}</p>}
        {item.checks.map(check => <div className="evaluation-check" key={check.title}>{check.passed ? '✓' : '✗'} {check.title}</div>)}{item.error && <p className="maintenance-error">{item.error}</p>}
      </details>)}
      {report.error && <p className="maintenance-error" role="alert">{report.error}</p>}
    </div>}
    <p className="settings-hint">通过率只代表这 3 个样例，不代表所有编程任务。报告按磁盘内容和真实工具记录核验，不采用模型自报结果。</p>
  </section>;
}
