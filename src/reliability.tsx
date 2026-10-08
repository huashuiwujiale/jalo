import React, { useEffect, useRef, useState } from 'react';
import type { Api, FilePage, FileReference, Project, TaskDetail, Run, RunView, RollbackPreview } from '../shared/types';
import { busyStatuses } from '../shared/types';
import { hasChange } from '../shared/progress';
import { useRemoteResource } from './remote-resource';
import { FileTree } from './file-tree';
const api: Api = window.localCode;
export const modeLabels = { execute: '执行', plan: '计划', review: '审查' };
export function FilePicker({ project, initialPath, initialReference, close, choose }: { project: Project; initialPath?: string; initialReference?: FileReference; close: () => void; choose: (r: FileReference) => void }) {
  const [page, setPage] = useState<FilePage>(), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const [whole,setWhole]=useState<FileReference>(), [scope,setScope]=useState<'file'|'lines'>(initialReference ? initialReference.scope || 'lines' : 'file');
  const [start, setStart] = useState(1), [end, setEnd] = useState(1);
  const request = useRef(0);
  async function preview(path: string, startLine = 1, select = true) {
    const id = ++request.current; setLoading(true); setError('');setWhole(undefined);setPage(undefined);
    try {
      const ref=await api.referenceFile({projectId:project.id,path});if(id!==request.current)return;setWhole(ref);
      if(select)setScope(initialReference?.path===path ? initialReference.scope || 'lines' : 'file');
      const p = await api.previewFile({ projectId: project.id, path, startLine }); if (id !== request.current) return;
      if(p.version!==ref.version){setWhole(undefined);throw new Error('预览期间文件发生变化，请重新选择');}
      setPage(p); if (select) { setStart(initialReference?.path===path ? initialReference.startLine : p.startLine); setEnd(initialReference?.path===path ? initialReference.endLine : p.endLine); }
    }
    catch (e: any) { if (id === request.current) { setPage(undefined); setError(e.message); } }
    finally { if (id === request.current) setLoading(false); }
  }
  useEffect(() => { if (initialPath) void preview(initialPath,initialReference?.scope !== 'file' ? initialReference?.startLine || 1 : 1); return () => { request.current++; }; }, []);
  return <div className="modal-backdrop"><section className="reference-modal" role="dialog" aria-modal="true" aria-label="文件引用与预览">
    <header><div><strong>引用项目文件</strong><small title={project.path}>{project.name} · {project.path}</small></div><button onClick={close}>关闭</button></header>
    <div className="reference-content"><FileTree key={project.id} project={project} selected={whole?.path} initialPath={initialPath} preview={preview}/>
    <div className="file-preview">{page ? <><strong title={project.path}>{page.path}</strong><small>预览第 {page.startLine}–{page.endLine} 行 / 共 {page.totalLines} 行 · {scope==='file'?'引用范围：整个文件':'引用范围：所选行'}</small><pre>{page.content.split('\n').map((line, i) => <button key={page.startLine + i} className={scope==='lines' && page.startLine + i >= start && page.startLine + i <= end ? 'selected' : ''} onClick={e => { setScope('lines');const n = page.startLine + i; if (e.shiftKey) { setStart(Math.min(start, n)); setEnd(Math.max(start, n)); } else { setStart(n); setEnd(n); } }}><span>{page.startLine + i}</span>{line || ' '}</button>)}</pre><div className="preview-pages"><button disabled={loading || page.startLine === 1} onClick={() => preview(page.path, Math.max(1, page.startLine - 100), false)}>上一页</button><span>{page.hasMore ? '分页仅影响预览，不限制整文件引用' : '已到文件末尾'}</span><button disabled={loading || !page.hasMore} onClick={() => preview(page.path, page.endLine + 1, false)}>下一页</button></div></> : <p>{loading ? '读取中…' : whole ? `已选择 ${whole.path}，可引用整个文件。` : '选择左侧文件查看真实内容'}</p>}</div></div>
    {error && <p role="alert" className="reference-error">{error}</p>}
    <footer className="reference-selection"><label>引用范围<select aria-label="引用范围" value={scope} onChange={e=>setScope(e.target.value as 'file'|'lines')}><option value="file">整个文件</option><option value="lines">所选行</option></select></label>
      {scope==='file' ? <span>整文件作为任务目标，模型按需分段读取。{whole && `共 ${whole.endLine} 行。`}</span> : <><span>点击行号或 Shift 点击选择，最多 400 行。</span><label>起始行<input aria-label="引用起始行" type="number" min={1} value={start} onChange={e => setStart(Number(e.target.value))}/></label><label>结束行<input aria-label="引用结束行" type="number" min={start} value={end} onChange={e => setEnd(Number(e.target.value))}/></label></>}
      <button className="primary" disabled={loading || !whole || (scope==='lines' && (!page || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > page.totalLines || end - start >= 400))} onClick={() => { if(whole)choose(scope==='file' ? whole : {...whole,scope:'lines',startLine:start,endLine:end}); }}>{scope==='file'?'引用整个文件':'引用所选行'}</button>
    </footer>
  </section></div>;
}
export function RunResult({ run }: { run: Run | RunView }) {
  const written = run.changes.filter(c => c.state === 'written' && hasChange(c));
  const restored = run.changes.filter(c => c.state === 'reverted');
  const uncertain = run.changes.filter(c => c.state === 'prepared' || c.state === 'uncertain');
  const checks = run.checks.reduce((r, c) => ({ ...r, [c.status]: r[c.status] + 1 }), { passed: 0, failed: 0, skipped: 0 });
  return <section className="run-result"><strong>{written.length ? '修改已写入，待验收' : restored.length ? '本轮修改已回退' : run.mode === 'execute' ? '本轮未产生已核验的文件修改' : `${modeLabels[run.mode]}轮次 · 只读`}</strong>
    <p className="run-model">本轮模型：{run.model || '未记录'}</p>
    <p>当前保留修改 {written.length} 个文件 · 已回退 {restored.length} 个文件 · 检查通过 {checks.passed} 次 / 失败 {checks.failed} 次 / 未完整检查 {checks.skipped} 次</p>
    {!!uncertain.length && <p className="reference-error">{uncertain.length} 个检查点未完成写入核验，需检查磁盘内容，暂不能回退：{uncertain.map(c => c.path).join('、')}</p>}
    {written.map(c => <p key={c.id}>{c.path}：{c.check.status === 'passed' ? '语法通过' : '未完整检查'}<br/><small>{c.check.message}</small></p>)}
    {!!written.length && <small>待人工确认：差异是否符合要求、页面行为及项目测试。语法检查不代表业务验收；未运行编译或打包。</small>}
  </section>;
}
export function RunPanel({ task, runId, selectRun, locked, fail, preview }: { task?: TaskDetail; runId: string; selectRun: (id: string) => void; locked: boolean; fail: (e: unknown) => void; preview: (path: string) => void }) {
  const [scope, setScope] = useState<'run' | 'task'>('run'), [file, setFile] = useState('');
  const [rollback, setRollback] = useState<RollbackPreview>(), [working, setWorking] = useState(false);
  const run = task?.runs?.find(r => r.id === runId) || task?.runs?.at(-1);
  const changes = scope === 'run' ? run?.changes.filter(c => c.state === 'written' && c.changed) || [] : task?.changes || [];
  const change = changes.find(c => c.path === file) || changes[0];
  const patchKey = task && change ? `${task.id}:${scope}:${scope === 'run' ? run?.id : ''}:${change.path}:${change.patchVersion}` : '';
  const patch = useRemoteResource(patchKey, async () => {
    const value = await api.changePatch({ taskId: task!.id, ...(scope === 'run' ? { runId: run!.id } : {}), path: change!.path });
    if (value.version !== change!.patchVersion) throw new Error('差异已更新，请重新选择文件');
    return value.patch;
  });
  useEffect(() => { setFile(''); setScope('run'); setRollback(undefined); }, [task?.id]);
  return <><div className="run-controls"><select aria-label="差异范围" value={scope} onChange={e => setScope(e.target.value as 'run' | 'task')}><option value="run">本轮修改</option><option value="task">整个任务修改</option></select><select aria-label="选择轮次" value={run?.id || ''} onChange={e => { selectRun(e.target.value); setFile(''); }} disabled={!task?.runs?.length}><option value="" disabled>无轮次记录</option>{task?.runs?.map((r, i) => <option key={r.id} value={r.id}>第 {i + 1} 轮 · {modeLabels[r.mode]} · {r.input.slice(0, 20)}</option>)}</select></div>
    {task?.legacy && <p className="inspector-note">历史数据，缺少轮次核验；旧改动不提供回退。</p>}
    {change ? <><div className="file-list">{changes.map(c => <button key={c.path} className={change.path === c.path ? 'active' : ''} onClick={() => setFile(c.path)}>{c.path}</button>)}</div><div className="diff-title">{change.path}<button onClick={() => preview(change.path)}>查看当前原文</button></div><pre className="diff">{(patch.value ?? patch.error ?? '正在加载差异…').split('\n').map((line, i) => <div key={i} className={line.startsWith('+') ? 'addition' : line.startsWith('-') ? 'deletion' : line.startsWith('@@') ? 'hunk' : ''}>{line || ' '}</div>)}</pre>
      {patch.error && <button onClick={patch.retry}>重新加载差异</button>}
      {scope === 'run' && run && <button className="rollback-button" disabled={locked || working || !('state' in change) || change.state !== 'written'} onClick={async () => { setWorking(true); try { setRollback(await api.previewRollback(task!.id, run.id, change.path)); } catch (e) { fail(e); } finally { setWorking(false); } }}>预览回退此文件</button>}
    </> : <div className="inspector-empty"><h3>{run?.changes.some(c => c.state === 'reverted') ? '本轮修改已回退' : '暂无实际修改'}</h3><p>只有文件工具的真实写入会显示在这里。</p></div>}
    {run && <RunResult run={run}/>}
    {rollback && <div className="modal-backdrop"><section className="reference-modal rollback-modal" role="dialog" aria-modal="true" aria-label="确认文件回退"><header><strong>回退预览 · {rollback.path}</strong></header><p>确认前会再次检查版本；如有外部或后续修改，将拒绝覆盖。{rollback.createsRecoveryCopy && '这是新建文件，将先保存可恢复副本再移除。'}</p><pre className="diff">{rollback.patch}</pre><footer><button disabled={working} onClick={() => setRollback(undefined)}>取消</button><button className="primary" disabled={working || locked} onClick={async () => { setWorking(true); try { await api.confirmRollback(rollback.token); setRollback(undefined); } catch (e) { fail(e); setRollback(undefined); } finally { setWorking(false); } }}>确认回退</button></footer></section></div>}
  </>;
}
