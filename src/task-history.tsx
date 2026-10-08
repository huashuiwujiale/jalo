import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Archive, ArchiveRestore, Pencil, MessageSquare, Search } from 'lucide-react';
import { busyStatuses, type Api, type Project, type TaskSummary } from '../shared/types';
import { useRemoteResource } from './remote-resource';
import { taskListWindow, taskRowHeight, taskRowScrollTop } from './task-list-window';
import './task-history.css';
const api: Api = window.localCode;
const statuses: Record<TaskSummary['status'], string> = { queued:'排队中',running:'执行中',waiting:'等待确认',completed:'本轮结束',failed:'执行失败',cancelled:'已停止',interrupted:'已中断' };
export function TaskHistory({ tasks, projectId, taskId, choose, disabled, fail }: { tasks: TaskSummary[]; projectId: string; taskId: string; choose: (task: TaskSummary) => void; disabled: boolean; fail: (error: unknown) => void }) {
  const [query, setQuery] = useState(''), [archived, setArchived] = useState(false);
  const [rename, setRename] = useState<TaskSummary>(), [title, setTitle] = useState(''), [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const list = useRef<HTMLElement>(null), scrollFrame = useRef<number | undefined>(undefined), focusRequest = useRef<string | undefined>(undefined);
  const [viewport, setViewport] = useState({ top: 0, height: 480 }), [focusedId, setFocusedId] = useState('');
  useEffect(() => { const timer = setTimeout(() => setSearch(query.trim()), 150); return () => clearTimeout(timer); }, [query]);
  const { selectedTask, projectTasks, counts } = useMemo(() => {
    const projectTasks: TaskSummary[] = [], counts = [0, 0];
    let selectedTask: TaskSummary | undefined;
    for (const task of tasks) {
      if (task.id === taskId) selectedTask = task;
      if (task.projectId !== projectId) continue;
      projectTasks.push(task); counts[task.archivedAt ? 1 : 0]++;
    }
    return { selectedTask, projectTasks, counts };
  }, [tasks, projectId, taskId]);
  useEffect(()=>{setArchived(!!selectedTask?.archivedAt);},[taskId,selectedTask?.archivedAt]);
  const candidates = useMemo(() => projectTasks.filter(task => !!task.archivedAt === archived), [projectTasks, archived]);
  const searchKey = useMemo(() => search ? JSON.stringify([projectId, archived, search, candidates.map(task => [task.id, task.title, task.requestCount])]) : '', [projectId, archived, search, candidates]);
  const matches = useRemoteResource(searchKey, () => api.searchTasks({ projectId, archived, query: search }));
  const visible = useMemo(() => {
    if (!search) return candidates;
    const ids = new Set(matches.value);
    return candidates.filter(task => ids.has(task.id));
  }, [candidates, search, matches.value]);
  const indices = useMemo(() => new Map(visible.map((task, index) => [task.id, index])), [visible]);
  const selectedIndex = indices.get(taskId) ?? -1;
  const rows = taskListWindow(visible.length, viewport.top, viewport.height);
  const focusedIndex = indices.get(focusedId) ?? -1;
  const tabbableIndex = focusedIndex >= rows.start && focusedIndex < rows.end ? focusedIndex : selectedIndex >= rows.start && selectedIndex < rows.end ? selectedIndex : rows.start;
  function sampleViewport() {
    const element = list.current;
    if (!element) return;
    const top = element.scrollTop, height = element.clientHeight || 480;
    setViewport(previous => previous.top === top && previous.height === height ? previous : { top, height });
  }
  function reveal(index: number) {
    const element = list.current;
    if (!element) return;
    element.scrollTop = taskRowScrollTop(index, element.scrollTop, element.clientHeight || 480);
    sampleViewport();
  }
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    sampleViewport();
    const observer = new ResizeObserver(sampleViewport);
    observer.observe(element);
    return () => { observer.disconnect(); if (scrollFrame.current !== undefined) cancelAnimationFrame(scrollFrame.current); };
  }, []);
  useLayoutEffect(() => {
    if (list.current) list.current.scrollTop = 0;
    focusRequest.current = undefined; setFocusedId(''); sampleViewport();
  }, [projectId, archived, search]);
  useLayoutEffect(() => { if (selectedIndex >= 0) reveal(selectedIndex); }, [taskId, selectedIndex, archived, search]);
  useLayoutEffect(() => {
    if (!focusRequest.current) return;
    const index = indices.get(focusRequest.current);
    if (index === undefined) { focusRequest.current = undefined; return; }
    const button = list.current?.querySelector<HTMLButtonElement>(`[data-task-select="${index}"]`);
    if (button) { focusRequest.current = undefined; button.focus({ preventScroll: true }); }
  }, [indices, rows.start, rows.end, focusedId]);
  function navigate(event: React.KeyboardEvent<HTMLElement>) {
    if (disabled) return;
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-task-index]');
    if (!target) return;
    const index = Number(target.dataset.taskIndex), page = Math.max(1, Math.floor(viewport.height / taskRowHeight));
    const next = event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowUp' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1 : event.key === 'PageDown' ? index + page : event.key === 'PageUp' ? index - page : undefined;
    if (next === undefined) return;
    event.preventDefault();
    const destination = Math.max(0, Math.min(visible.length - 1, next)), task = visible[destination];
    if (!task) return;
    focusRequest.current = task.id; setFocusedId(task.id); reveal(destination);
  }
  async function archive(task: TaskSummary) { setSaving(true); try { await api.archiveTask(task.id,!task.archivedAt); } catch(e) { fail(e); } finally { setSaving(false); } }
  return <><div className="section-label history-label">任务记录<span>{visible.length}</span></div>
    <div className="history-controls"><div className="history-tabs"><button aria-pressed={!archived} onClick={() => setArchived(false)}>当前 {counts[0]}</button><button aria-pressed={archived} onClick={() => setArchived(true)}>已归档 {counts[1]}</button></div>
      <label className="history-search"><Search size={13}/><input aria-label="搜索历史任务" placeholder="搜索标题或任务要求…" value={query} onChange={e => setQuery(e.target.value)}/></label></div>
    <nav ref={list} className="task-list" aria-label="历史任务" onKeyDown={navigate} onScroll={() => {
      if (scrollFrame.current !== undefined) return;
      scrollFrame.current = requestAnimationFrame(() => { scrollFrame.current = undefined; sampleViewport(); });
    }}><div className="task-history-window" role="list" style={{ height: rows.totalHeight }}><div className="task-history-rows" style={{ transform: `translateY(${rows.offset}px)` }}>{visible.slice(rows.start, rows.end).map((t, offset) => {
      const index = rows.start + offset, active = index === tabbableIndex;
      return <div className="history-item task-history-row" role="listitem" aria-posinset={index + 1} aria-setsize={visible.length} data-task-index={index} onFocusCapture={() => setFocusedId(t.id)} key={t.id}>
        <button data-task-select={index} tabIndex={active ? 0 : -1} aria-current={taskId === t.id ? 'page' : undefined} disabled={disabled} onClick={() => choose(t)} className={`task-item ${taskId === t.id ? 'selected' : ''}`} title={t.title}><MessageSquare size={14}/><span><strong>{t.title}</strong><small><i className={`status-dot ${t.status}`}/>{statuses[t.status]}</small></span></button>
        <div className="history-actions"><button tabIndex={active ? 0 : -1} aria-label={`重命名任务：${t.title}`} title="重命名" disabled={disabled || saving} onClick={() => { setRename(t); setTitle(t.title); }}><Pencil size={12}/></button><button tabIndex={active ? 0 : -1} aria-label={`${t.archivedAt ? '恢复' : '归档'}任务：${t.title}`} title={busyStatuses.includes(t.status) ? '请先停止或完成任务' : t.archivedAt ? '恢复任务' : '归档任务'} disabled={disabled || saving || busyStatuses.includes(t.status)} onClick={() => archive(t)}>{t.archivedAt ? <ArchiveRestore size={12}/> : <Archive size={12}/>}</button></div>
      </div>;
    })}</div></div>{matches.error && <p className="sidebar-hint" role="alert">{matches.error}<button onClick={matches.retry}>重试搜索</button></p>}{!visible.length && !matches.error && <p className="sidebar-hint">{search ? matches.value ? '没有匹配的任务。' : '正在搜索…' : archived ? '暂无已归档任务。' : '从一个想法开始。你的任务会保存在这里。'}</p>}</nav>
    {rename && <div className="modal-backdrop"><form className="management-modal" role="dialog" aria-modal="true" aria-label="重命名任务" onSubmit={async e => { e.preventDefault(); if (!title.trim() || saving) return; setSaving(true); try { await api.renameTask(rename.id,title); setRename(undefined); } catch(error) { fail(error); } finally { setSaving(false); } }}>
      <h3>重命名任务</h3><label>任务名称<input autoFocus aria-label="任务名称" maxLength={100} value={title} onChange={e => setTitle(e.target.value)}/></label><footer><button type="button" disabled={saving} onClick={() => setRename(undefined)}>取消</button><button className="primary" disabled={saving || !title.trim()}>保存</button></footer>
    </form></div>}
  </>;
}
export function RemoveProjectDialog({ project, close, removed, fail }: { project: Project; close: () => void; removed: () => void; fail: (error: unknown) => void }) {
  const [saving, setSaving] = useState(false);
  return <div className="modal-backdrop"><section className="management-modal" role="dialog" aria-modal="true" aria-label="移除项目"><h3>移除项目“{project.name}”</h3><p className="project-path">{project.path}</p><p>项目将从工作空间列表隐藏，磁盘文件和历史任务都会保留。重新添加同一目录后，可以找回原来的任务记录。</p><footer><button disabled={saving} onClick={close}>取消</button><button className="primary" disabled={saving} onClick={async () => { setSaving(true); try { await api.removeProject(project.id); removed(); close(); } catch(e) { fail(e); } finally { setSaving(false); } }}>移除项目</button></footer></section></div>;
}
