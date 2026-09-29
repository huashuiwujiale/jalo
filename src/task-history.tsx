import React, { useEffect, useState } from 'react';
import { Archive, ArchiveRestore, Pencil, MessageSquare, Search } from 'lucide-react';
import { busyStatuses, type Api, type Project, type Task } from '../shared/types';
import { filterTasks } from '../shared/task-history';
const api: Api = window.localCode;
const statuses: Record<Task['status'], string> = { queued:'排队中',running:'执行中',waiting:'等待确认',completed:'本轮结束',failed:'执行失败',cancelled:'已停止',interrupted:'已中断' };
export function TaskHistory({ tasks, projectId, taskId, choose, disabled, fail }: { tasks: Task[]; projectId: string; taskId: string; choose: (task: Task) => void; disabled: boolean; fail: (error: unknown) => void }) {
  const [query, setQuery] = useState(''), [archived, setArchived] = useState(false);
  const [rename, setRename] = useState<Task>(), [title, setTitle] = useState(''), [saving, setSaving] = useState(false);
  const selectedTask = tasks.find(t=>t.id===taskId);
  useEffect(()=>{setArchived(!!selectedTask?.archivedAt);},[taskId,selectedTask?.archivedAt]);
  const visible = filterTasks(tasks, projectId, archived, query);
  const counts = [false,true].map(value => tasks.filter(t => t.projectId === projectId && !!t.archivedAt === value).length);
  async function archive(task: Task) { setSaving(true); try { await api.archiveTask(task.id,!task.archivedAt); } catch(e) { fail(e); } finally { setSaving(false); } }
  return <><div className="section-label history-label">任务记录<span>{visible.length}</span></div>
    <div className="history-controls"><div className="history-tabs"><button aria-pressed={!archived} onClick={() => setArchived(false)}>当前 {counts[0]}</button><button aria-pressed={archived} onClick={() => setArchived(true)}>已归档 {counts[1]}</button></div>
      <label className="history-search"><Search size={13}/><input aria-label="搜索历史任务" placeholder="搜索标题或任务要求…" value={query} onChange={e => setQuery(e.target.value)}/></label></div>
    <nav className="task-list" aria-label="历史任务">{visible.map(t => <div className="history-item" key={t.id}>
      <button disabled={disabled} onClick={() => choose(t)} className={`task-item ${taskId === t.id ? 'selected' : ''}`} title={t.title}><MessageSquare size={14}/><span><strong>{t.title}</strong><small><i className={`status-dot ${t.status}`}/>{statuses[t.status]}</small></span></button>
      <div className="history-actions"><button aria-label={`重命名任务：${t.title}`} title="重命名" disabled={disabled || saving} onClick={() => { setRename(t); setTitle(t.title); }}><Pencil size={12}/></button><button aria-label={`${t.archivedAt ? '恢复' : '归档'}任务：${t.title}`} title={busyStatuses.includes(t.status) ? '请先停止或完成任务' : t.archivedAt ? '恢复任务' : '归档任务'} disabled={disabled || saving || busyStatuses.includes(t.status)} onClick={() => archive(t)}>{t.archivedAt ? <ArchiveRestore size={12}/> : <Archive size={12}/>}</button></div>
    </div>)}{!visible.length && <p className="sidebar-hint">{query.trim() ? '没有匹配的任务。' : archived ? '暂无已归档任务。' : '从一个想法开始。你的任务会保存在这里。'}</p>}</nav>
    {rename && <div className="modal-backdrop"><form className="management-modal" role="dialog" aria-modal="true" aria-label="重命名任务" onSubmit={async e => { e.preventDefault(); if (!title.trim() || saving) return; setSaving(true); try { await api.renameTask(rename.id,title); setRename(undefined); } catch(error) { fail(error); } finally { setSaving(false); } }}>
      <h3>重命名任务</h3><label>任务名称<input autoFocus aria-label="任务名称" maxLength={100} value={title} onChange={e => setTitle(e.target.value)}/></label><footer><button type="button" disabled={saving} onClick={() => setRename(undefined)}>取消</button><button className="primary" disabled={saving || !title.trim()}>保存</button></footer>
    </form></div>}
  </>;
}
export function RemoveProjectDialog({ project, close, removed, fail }: { project: Project; close: () => void; removed: () => void; fail: (error: unknown) => void }) {
  const [saving, setSaving] = useState(false);
  return <div className="modal-backdrop"><section className="management-modal" role="dialog" aria-modal="true" aria-label="移除项目"><h3>移除项目“{project.name}”</h3><p className="project-path">{project.path}</p><p>项目将从工作空间列表隐藏，磁盘文件和历史任务都会保留。重新添加同一目录后，可以找回原来的任务记录。</p><footer><button disabled={saving} onClick={close}>取消</button><button className="primary" disabled={saving} onClick={async () => { setSaving(true); try { await api.removeProject(project.id); removed(); close(); } catch(e) { fail(e); } finally { setSaving(false); } }}>移除项目</button></footer></section></div>;
}
