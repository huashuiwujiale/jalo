import React, { useEffect, useRef, useState } from 'react';
import type { Api, FilePage, FileReference, Project, Task, Run, RollbackPreview } from '../shared/types';
import { busyStatuses } from '../shared/types';
const api: Api = window.localCode;
export const modeLabels = { execute: '执行', plan: '计划', review: '审查' };
export function FilePicker({ project, initialPath, close, choose }: { project: Project; initialPath?: string; close: () => void; choose: (r: FileReference) => void }) {
  const [query, setQuery] = useState(''), [paths, setPaths] = useState<string[]>([]), [truncated, setTruncated] = useState(false);
  const [page, setPage] = useState<FilePage>(), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const [start, setStart] = useState(1), [end, setEnd] = useState(1);
  const request = useRef(0);
  useEffect(() => {
    let valid = true;
    const timer = setTimeout(() => api.searchFiles({ projectId: project.id, query }).then(r => { if (valid) { setPaths(r.paths); setTruncated(r.truncated); } }).catch(e => { if (valid) setError(e.message); }), 180);
    return () => { valid = false; clearTimeout(timer); };
  }, [project.id, query]);
  async function preview(path: string, startLine = 1, select = true) {
    const id = ++request.current; setLoading(true); setError('');
    try { const p = await api.previewFile({ projectId: project.id, path, startLine }); if (id !== request.current) return; setPage(p); if (select) { setStart(p.startLine); setEnd(p.endLine); } }
    catch (e: any) { if (id === request.current) { setPage(undefined); setError(e.message); } }
    finally { if (id === request.current) setLoading(false); }
  }
  useEffect(() => { if (initialPath) void preview(initialPath); return () => { request.current++; }; }, []);
  return <div className="modal-backdrop"><section className="reference-modal" role="dialog" aria-modal="true" aria-label="文件引用与预览">
    <header><div><strong>引用项目文件</strong><small title={project.path}>{project.name} · {project.path}</small></div><button onClick={close}>关闭</button></header>
    <div className="reference-content"><div className="reference-search"><input autoFocus aria-label="搜索项目文件" placeholder="搜索文件名或相对路径" value={query} onChange={e => setQuery(e.target.value)}/><div>{paths.map(p => <button className={page?.path === p ? 'selected' : ''} key={p} title={project.path + '/' + p} onClick={() => preview(p)}>{p}</button>)}{truncated && <p>搜索结果达到上限，请缩小查询范围。</p>}</div></div>
    <div className="file-preview">{page ? <><strong title={project.path}>{page.path}</strong><small>第 {page.startLine}–{page.endLine} 行 / 共 {page.totalLines} 行 · 只读预览</small><pre>{page.content.split('\n').map((line, i) => <button key={page.startLine + i} className={page.startLine + i >= start && page.startLine + i <= end ? 'selected' : ''} onClick={e => { const n = page.startLine + i; if (e.shiftKey) { setStart(Math.min(start, n)); setEnd(Math.max(start, n)); } else { setStart(n); setEnd(n); } }}><span>{page.startLine + i}</span>{line || ' '}</button>)}</pre><div className="preview-pages"><button disabled={loading || page.startLine === 1} onClick={() => preview(page.path, Math.max(1, page.startLine - 100), false)}>上一页</button><span>{page.hasMore ? '后面还有内容，未全部显示' : '已到文件末尾'}</span><button disabled={loading || !page.hasMore} onClick={() => preview(page.path, page.endLine + 1, false)}>下一页</button></div></> : <p>{loading ? '读取中…' : '选择左侧文件查看真实内容'}</p>}</div></div>
    {error && <p role="alert" className="reference-error">{error}</p>}<footer><span>点击行号选择，Shift 点击扩展范围。</span><label>起始行<input aria-label="引用起始行" type="number" min={1} value={start} onChange={e => setStart(Number(e.target.value))}/></label><label>结束行<input aria-label="引用结束行" type="number" min={start} value={end} onChange={e => setEnd(Number(e.target.value))}/></label><button className="primary" disabled={loading || !page || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > page.totalLines || end - start >= 400} onClick={() => { if (page) choose({ projectId: project.id, path: page.path, startLine: start, endLine: end, version: page.version }); }}>添加引用</button></footer>
  </section></div>;
}
export function RunResult({ run }: { run: Run }) {
  const written = run.changes.filter(c => c.state === 'written' && c.before !== c.after);
  const restored = run.changes.filter(c => c.state === 'reverted');
  const uncertain = run.changes.filter(c => c.state === 'prepared' || c.state === 'uncertain');
  const checks = run.checks.reduce((r, c) => ({ ...r, [c.status]: r[c.status] + 1 }), { passed: 0, failed: 0, skipped: 0 });
  return <section className="run-result"><strong>{written.length ? '修改已写入，待验收' : restored.length ? '本轮修改已回退' : run.mode === 'execute' ? '本轮未产生已核验的文件修改' : `${modeLabels[run.mode]}轮次 · 只读`}</strong>
    <p>当前保留修改 {written.length} 个文件 · 已回退 {restored.length} 个文件 · 检查通过 {checks.passed} 次 / 失败 {checks.failed} 次 / 未完整检查 {checks.skipped} 次</p>
    {!!uncertain.length && <p className="reference-error">{uncertain.length} 个检查点未完成写入核验，需检查磁盘内容，暂不能回退：{uncertain.map(c => c.path).join('、')}</p>}
    {written.map(c => <p key={c.id}>{c.path}：{c.check.status === 'passed' ? '语法通过' : '未完整检查'}<br/><small>{c.check.message}</small></p>)}
    {!!written.length && <small>待人工确认：差异是否符合要求、页面行为及项目测试。语法检查不代表业务验收；未运行编译或打包。</small>}
  </section>;
}
export function RunPanel({ task, runId, selectRun, locked, fail, preview }: { task?: Task; runId: string; selectRun: (id: string) => void; locked: boolean; fail: (e: unknown) => void; preview: (path: string) => void }) {
  const [scope, setScope] = useState<'run' | 'task'>('run'), [file, setFile] = useState('');
  const [rollback, setRollback] = useState<RollbackPreview>(), [working, setWorking] = useState(false);
  const run = task?.runs?.find(r => r.id === runId) || task?.runs?.at(-1);
  const changes = scope === 'run' ? run?.changes.filter(c => c.state === 'written' && c.before !== c.after) || [] : task?.changes || [];
  const change = changes.find(c => c.path === file) || changes[0];
  useEffect(() => { setFile(''); setScope('run'); setRollback(undefined); }, [task?.id]);
  return <><div className="run-controls"><select aria-label="差异范围" value={scope} onChange={e => setScope(e.target.value as 'run' | 'task')}><option value="run">本轮修改</option><option value="task">整个任务修改</option></select><select aria-label="选择轮次" value={run?.id || ''} onChange={e => { selectRun(e.target.value); setFile(''); }} disabled={!task?.runs?.length}><option value="" disabled>无轮次记录</option>{task?.runs?.map((r, i) => <option key={r.id} value={r.id}>第 {i + 1} 轮 · {modeLabels[r.mode]} · {r.input.slice(0, 20)}</option>)}</select></div>
    {task?.legacy && <p className="inspector-note">历史数据，缺少轮次核验；旧改动不提供回退。</p>}
    {change ? <><div className="file-list">{changes.map(c => <button key={c.path} className={change.path === c.path ? 'active' : ''} onClick={() => setFile(c.path)}>{c.path}</button>)}</div><div className="diff-title">{change.path}<button onClick={() => preview(change.path)}>查看当前原文</button></div><pre className="diff">{change.patch.split('\n').map((line, i) => <div key={i} className={line.startsWith('+') ? 'addition' : line.startsWith('-') ? 'deletion' : line.startsWith('@@') ? 'hunk' : ''}>{line || ' '}</div>)}</pre>
      {scope === 'run' && run && <button className="rollback-button" disabled={locked || working || !('state' in change) || change.state !== 'written'} onClick={async () => { setWorking(true); try { setRollback(await api.previewRollback(task!.id, run.id, change.path)); } catch (e) { fail(e); } finally { setWorking(false); } }}>预览回退此文件</button>}
    </> : <div className="inspector-empty"><h3>{run?.changes.some(c => c.state === 'reverted') ? '本轮修改已回退' : '暂无实际修改'}</h3><p>只有文件工具的真实写入会显示在这里。</p></div>}
    {run && <RunResult run={run}/>}
    {rollback && <div className="modal-backdrop"><section className="reference-modal rollback-modal" role="dialog" aria-modal="true" aria-label="确认文件回退"><header><strong>回退预览 · {rollback.path}</strong></header><p>确认前会再次检查版本；如有外部或后续修改，将拒绝覆盖。{rollback.createsRecoveryCopy && '这是新建文件，将先保存可恢复副本再移除。'}</p><pre className="diff">{rollback.patch}</pre><footer><button disabled={working} onClick={() => setRollback(undefined)}>取消</button><button className="primary" disabled={working || locked} onClick={async () => { setWorking(true); try { await api.confirmRollback(rollback.token); setRollback(undefined); } catch (e) { fail(e); setRollback(undefined); } finally { setWorking(false); } }}>确认回退</button></footer></section></div>}
  </>;
}
