import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowUp, ArrowRight, Check, ChevronDown, ChevronRight, Code2, Cpu, FileCode2, Folder, FolderPlus, GitBranch, HardDrive, LoaderCircle, MessageSquare, Plus, RefreshCw, Settings2, ShieldCheck, Square, Terminal, X, Zap } from 'lucide-react';
import { FilePicker, RunPanel, RunResult, modeLabels } from './reliability';
import type { Mode, FileReference, Api, LocalModel, Settings, Snapshot, TaskSummary, Project } from '../shared/types';
import { busyStatuses, defaults } from '../shared/types';
import './style.css';
import { TimelineRows } from './timeline-rows';
import { StreamingReply } from './streaming-reply';
import { useTaskDetail } from './task-detail';
import { applyUpdate } from '../shared/app-state';
import { TaskProgress, RecoveryPanel } from './task-progress';
import { ContextMeter } from './context-usage';
import { MentionInput } from './mention-input';
import { referenceName } from './mentions';
import { recoveryPrompt } from '../shared/progress';
import { TaskHistory, RemoveProjectDialog } from './task-history';
import { AppMaintenance } from './app-maintenance';
import { ModelEvaluation } from './model-evaluation';
import { emptySession, emptyView, rememberView, restoreView, viewKey, type SessionView } from '../shared/session';
import { capturePosition, restorePosition, rememberExpanded } from './session-scroll';
import { useEventHistory } from './event-history';
import { HistoryControls, PlanActions } from './history-controls';
import { ViewSaver } from './view-saver';
import { ModelSelector, type ModelValidation } from './model-selector';
declare global { interface Window { localCode: Api } }
const statusText: Record<TaskSummary['status'], string> = { queued: '排队中', running: '执行中', waiting: '等待确认', completed: '本轮结束', failed: '执行失败', cancelled: '已停止', interrupted: '已中断' };
const api = window.localCode;

function App() {
  const [state, setState] = useState<Snapshot>({ sequence: -1, projects: [], tasks: [], settings: defaults });
  const [projectId, setProjectId] = useState('');
  const [taskId, setTaskId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<Mode>('execute');
  const [model, setModel] = useState('');
  const [modelValidation, setModelValidation] = useState<ModelValidation>();
  const [references, setReferences] = useState<FileReference[]>([]);
  const [picker, setPicker] = useState<{ path?: string }>();
  const [runId, setRunId] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [removingProject, setRemovingProject] = useState<Project>();
  const [tab, setTab] = useState<'changes' | 'terminal'>('changes');
  const [selectedFile, setSelectedFile] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [referencePending, setReferencePending] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [viewRevision, setViewRevision] = useState(0);
  const sessions = useRef(emptySession());
  const projectSwitch = useRef(0);
  const currentView = useRef<SessionView>(emptyView(''));
  const pendingPosition = useRef<SessionView['scroll'] | undefined>(undefined);
  const restoredTop = useRef<number | undefined>(undefined);
  const conversation = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const previousScrollTop = useRef(0);
  const expanded = useRef(new Set<string>());
  const expandedGroups = useRef(new Map<string, string[]>());
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saver = useRef<ViewSaver | undefined>(undefined);
  saver.current ??= new ViewSaver(view => api.saveView(view), view => rememberView(sessions.current, view), e => fail(e));
  const [showLatest, setShowLatest] = useState(false);
  const scrollToLatest = (save = true) => {
    const element = conversation.current;
    if (!element) return;
    followLatest.current = true;
    // Scroll this panel only. Smooth scrolling on every token fights user gestures.
    const bottom = Math.max(0, element.scrollHeight - element.clientHeight);
    if (Math.abs(element.scrollTop - bottom) > 1) { element.scrollTop = bottom; restoredTop.current = element.scrollTop; }
    previousScrollTop.current = element.scrollTop;
    setShowLatest(false);
    if (save) rememberCurrent();
  };
  const pauseFollowing = () => {
    followLatest.current = false;
    setShowLatest(true);
    schedulePosition();
  };
  const handleConversationScroll = () => {
    const element = conversation.current;
    if (!element) return;
    const bottom = Math.max(0, element.scrollHeight - element.clientHeight);
    const scrollTop = Math.max(0, Math.min(element.scrollTop, bottom));
    if (restoredTop.current !== undefined) { const ignored = Math.abs(scrollTop - restoredTop.current) < 1; restoredTop.current = undefined; if (ignored) return; }
    const movedUp = scrollTop < previousScrollTop.current - 1;
    const atBottom = bottom - scrollTop <= 4;
    // Resizing or collapsing content can lower scrollTop while still at the bottom.
    if (atBottom) followLatest.current = true;
    else if (movedUp) followLatest.current = false;
    previousScrollTop.current = scrollTop;
    setShowLatest(!followLatest.current);
    schedulePosition();
  };
  const project = state.projects.find(p => p.id === projectId);
  const selected = state.tasks.find(t => t.id === taskId);
  const detail = useTaskDetail(selected, api);
  const task = detail.task;
  const fail = (e: unknown) => setError((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': Error: /, ''));
  const history = useEventHistory(task, api, pendingPosition.current?.follow === false ? pendingPosition.current.anchor : undefined, () => {
    if (!pendingPosition.current) { pendingPosition.current = captureCurrent(); setViewRevision(n => n + 1); }
  }, e => fail(e));
  const isBusy = !!selected && busyStatuses.includes(selected.status);
  const evaluating = state.evaluations?.some(r => r.status === 'running');
  const composerLocked = isBusy || !!selected?.archivedAt || (!!selected && (!task || detail.loading || !!detail.error));
  const modelService = JSON.stringify([state.settings.baseUrl, state.settings.token]);
  const effectiveModel = model || state.settings.model;
  const modelError = modelValidation?.service === modelService && modelValidation.model === effectiveModel ? modelValidation.error : '';
  const run = task?.runs?.find(r => r.id === runId) || task?.runs?.at(-1);
  const invalidReferences = references.some(r => r.projectId !== projectId);
  const projectBusy = state.tasks.some(t => t.projectId === projectId && busyStatuses.includes(t.status));
  function captureCurrent() {
    const scroll = capturePosition(conversation.current, followLatest.current, [...expanded.current], expandedGroups.current);
    expanded.current = new Set(scroll.expanded); return scroll;
  }
  async function returnToLatest() {
    if (!history.hasLater) { scrollToLatest(); return; }
    pendingPosition.current = { ...captureCurrent(), top: 0, follow: true, anchor: undefined, offset: undefined };
    setViewRevision(n => n + 1); await history.loadLatest();
  }
  function persistView(view: SessionView) {
    saver.current!.schedule(view);
  }
  function schedulePosition() {
    if (!sessionReady || pendingPosition.current) return;
    scrollTimer.current ??= setTimeout(() => { scrollTimer.current = undefined; rememberCurrent(); }, 150);
  }
  function rememberCurrent() {
    clearTimeout(scrollTimer.current); scrollTimer.current = undefined;
    if (!sessionReady || pendingPosition.current) return;
    const view = { ...currentView.current, scroll: captureCurrent() };
    currentView.current = view; persistView(view);
  }
  function openView(view: SessionView, saveCurrent = true) {
    projectSwitch.current++;
    if (saveCurrent) { rememberCurrent(); saver.current!.flush(); }
    currentView.current = view; pendingPosition.current = view.scroll;
    expanded.current = new Set(view.scroll.expanded);
    expandedGroups.current.clear();
    setProjectId(view.projectId); setTaskId(view.taskId); setPrompt(view.prompt); setMode(view.mode); setModel(view.model ?? ''); setModelValidation(undefined); setReferences(view.references);
    setRunId(view.runId); setTab(view.tab); setPicker(undefined); setSelectedFile(''); setError('');
    setViewRevision(value => value + 1);
  }
  useEffect(() => {
    if (!api) { setError('请通过 npm run dev 打开桌面应用；普通浏览器无法访问本地工具。'); return; }
    let initialized = false, disposed = false;
    const buffered: Parameters<typeof applyUpdate>[1][] = [];
    const offState = api.onUpdate(update => {
      if (!initialized) buffered.push(update);
      else setState(previous => applyUpdate(previous, update));
    });
    Promise.all([api.snapshot(), api.loadSession()]).then(([snapshot, saved]) => {
      if (disposed) return;
      const hydrated = buffered.reduce(applyUpdate, snapshot);
      initialized = true; buffered.length = 0;
      sessions.current = saved.state; setState(hydrated); openView(restoreView(saved.state, hydrated), false); setSessionReady(true);
      if (saved.warning) setError(saved.warning);
    }).catch(fail);
    return () => { disposed = true; offState(); };
  }, []);
  useLayoutEffect(() => {
    const element=conversation.current, saved=pendingPosition.current;
    if (!sessionReady || !element || !saved || (taskId && !task) || history.restoring || history.loading) return;
    pendingPosition.current=undefined; followLatest.current=saved.follow;
    previousScrollTop.current=restorePosition(element,saved);restoredTop.current=element.scrollTop;
    setShowLatest(!saved.follow);
    setViewRevision(n => n + 1);
  }, [sessionReady, viewRevision, history.restoring, history.loading, history.events, task?.id]);
  useLayoutEffect(() => {
    if (!sessionReady) return;
    currentView.current = { projectId,taskId,prompt,mode,model,references,runId,tab,scroll:pendingPosition.current || currentView.current.scroll };
    persistView(currentView.current);
  }, [sessionReady,viewRevision,projectId,taskId,prompt,mode,model,references,runId,tab]);
  useEffect(() => {
    if (!sessionReady) return;
    const flush = () => {
      clearTimeout(scrollTimer.current); scrollTimer.current = undefined;
      saver.current!.close({ ...currentView.current, scroll:pendingPosition.current || captureCurrent() }, view => api.flushView(view));
    };
    window.addEventListener('beforeunload',flush);
    return () => { window.removeEventListener('beforeunload',flush); flush(); };
  },[sessionReady]);
  useLayoutEffect(() => {
    if (followLatest.current && !pendingPosition.current) scrollToLatest(false);
  }, [task?.events.length, task?.events.at(-1)?.id, task?.approval?.id, task?.status]);
  useEffect(() => {
    const element = conversation.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      if (followLatest.current && !pendingPosition.current) scrollToLatest(false);
    });
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [sessionReady, projectId, taskId, task?.id]);
  const chooseProject = async (id: string) => {
    if (sending || id === projectId || !state.projects.some(p => p.id === id)) return;
    rememberCurrent(); saver.current!.flush();
    const sequence = ++projectSwitch.current;
    const remembered = sessions.current.projectTasks[id]; let next = state;
    if (remembered && !next.tasks.some(t => t.id === remembered)) {
      try { const task = await api.taskSummary(remembered); if (sequence !== projectSwitch.current) return; next = { ...state, tasks: [task, ...state.tasks] }; setState(current => ({ ...current, tasks: [task, ...current.tasks.filter(t => t.id !== task.id)] })); } catch {}
    }
    if (sequence !== projectSwitch.current) return;
    openView(restoreView(sessions.current,next,{projectId:id,taskId:remembered || ''}), false);
  };
  const addProject = async () => { if(sending)return;setSending(true);try { const p = await api.addProject(); if (p) { const snapshot=await api.snapshot();setState(current => current.sequence > snapshot.sequence ? current : snapshot);openView(restoreView(sessions.current,snapshot,{projectId:p.id,taskId:sessions.current.projectTasks[p.id] || ''})); } } catch (e) { fail(e); } finally {setSending(false);} };
  const submit = async (planRunId?: string) => {
    if ((!prompt.trim() && !planRunId) || sending || referencePending || isBusy) return;
    if (task?.archivedAt) { setError('请先恢复已归档任务，再继续对话'); return; }
    if (evaluating) { setError('模型能力实测正在运行，请先停止或完成实测'); return; }
    if (invalidReferences && !planRunId) { setError('存在其他项目的失效引用，请移除或重新选择'); return; }
    if (!projectId) { setError('请先添加并选择一个项目文件夹'); return; }
    if (!effectiveModel) { setError('请先在聊天框或模型设置中选择模型'); return; }
    if (modelError) { setError(modelError); return; }
    setSending(true); setError('');
    const submitted = { ...currentView.current };
    try {
      const id = await api.submit({ projectId, model: effectiveModel, prompt: planRunId ? '按关联计划执行，先重新读取文件，再完成修改和核验。' : prompt, mode: planRunId ? 'execute' : mode, references: planRunId ? [] : references, ...(planRunId ? { planRunId } : {}), ...(mode === 'review' && !planRunId && run ? { reviewRunId: run.id } : {}), ...(taskId ? { taskId } : {}) });
      const next: SessionView = { ...submitted, taskId:id, runId:'', mode:planRunId ? 'execute' : mode, prompt:planRunId ? submitted.prompt : '', references:planRunId ? submitted.references : [], scroll:emptyView(projectId).scroll };
      if(!submitted.taskId)persistView({...next,taskId:'',model:''});
      saver.current!.flush(); openView(next,false);
    } catch (e) { fail(e); }
    finally { setSending(false); }
  };
  const chooseTask = (t: TaskSummary) => { if(sending || t.id===taskId)return; const next = { ...state, tasks: [t, ...state.tasks.filter(old => old.id !== t.id)] }; setState(next); openView(restoreView(sessions.current,next,{projectId:t.projectId,taskId:t.id})); };
  const newTask = () => { if(sending || !taskId)return;openView(restoreView(sessions.current,state,{projectId,taskId:''})); };
  if(!sessionReady)return <div className="session-loading" role="status">{error || '正在恢复本地会话…'}{error && <button onClick={()=>window.location.reload()}>重试</button>}</div>;
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="traffic-space"/><div className="brand"><span className="brand-mark"><Code2 size={19}/></span><span>Jalo<span className="brand-label">本地编程助手</span></span></div>
      <button className="new-task" disabled={sending} onClick={newTask}><Plus size={17}/>新建任务<span className="keycap">N</span></button>
      <div className="section-label">工作空间<button title="添加项目" onClick={addProject}><FolderPlus size={15}/></button></div>
      <div className="projects">{state.projects.map(p => <div className="project-row" key={p.id}><button className={`project-item ${p.id === projectId ? 'selected' : ''}`} title={p.path} disabled={sending} onClick={() => chooseProject(p.id)}><Folder size={16}/><span>{p.name}</span>{p.id === projectId && <span className="selected-dot"/>}</button><button className="remove-project" title="移除项目（保留文件和历史）" aria-label={`移除项目：${p.name}`} disabled={sending || state.tasks.some(t => t.projectId === p.id && busyStatuses.includes(t.status))} onClick={() => setRemovingProject(p)}><X size={13}/></button></div>)}{!state.projects.length && <button className="empty-project" onClick={addProject}><FolderPlus size={17}/>添加第一个项目</button>}</div>
      <TaskHistory key={projectId} catalogVersion={state.catalogVersion} tasks={state.tasks} projectId={projectId} taskId={taskId} choose={chooseTask} disabled={sending} fail={fail}/>
      <div className="sidebar-bottom"><div className="local-badge"><span className="green-dot"/>本地模型 · 本地记录</div><button onClick={() => setSettingsOpen(true)}><Settings2 size={16}/>模型与设置<ChevronRight size={15}/></button></div>
    </aside>
    <main className="workspace">
      <header className="topbar"><div className="breadcrumb"><Folder size={15}/><span>{project?.name || '选择工作空间'}</span><span className="slash">/</span><strong>{task ? '任务详情' : '新建任务'}</strong></div><button className="model-pill" title="全局默认模型 · 打开模型与设置" onClick={() => setSettingsOpen(true)}><span className={state.settings.model ? 'green-dot' : 'gray-dot'}/><span>{state.settings.model || '连接本地模型'}</span><ChevronDown size={13}/></button></header>
      <div className="conversation-pane">
      <div className="conversation" key={viewKey(projectId,taskId)} ref={conversation} onScroll={handleConversationScroll} onToggleCapture={event => { if (event.target instanceof HTMLDetailsElement) rememberExpanded(event.target, expanded.current, expandedGroups.current); schedulePosition(); }}
        onWheel={event => { if (event.deltaY < 0) pauseFollowing(); }}
        onKeyDown={event => { if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) pauseFollowing(); }}
        onClickCapture={event => { if ((event.target as HTMLElement).closest('summary')) pauseFollowing(); }}
        tabIndex={0} role="region" aria-label="任务对话记录">
        {selected && !task ? <div className="session-loading" role="status">{detail.error || '正在加载任务记录…'}{detail.error && <button onClick={detail.retry}>重试</button>}</div> : !task ? <section className="welcome"><div className="welcome-icon"><Code2 size={31}/><span/></div><div className="eyebrow">YOUR LOCAL WORKSPACE</div><h1>把想法，变成代码。</h1><p>连接你自己的模型，在熟悉的项目里开始工作。<br/>从理解代码到完成修改，每一步都清晰可见。</p><div className="suggestions">
          {[{ icon: Folder, title: '了解这个项目', text: '阅读项目结构和 AGENTS.md，介绍技术栈、主要模块与启动方式。暂不修改文件。' }, { icon: Code2, title: '检查一段实现', text: '检查项目的主要入口与核心逻辑，找出一个有明确证据的问题，先说明原因和修改建议。' }, { icon: GitBranch, title: '开始一个改动', text: '我想在这个项目中实现一个功能：' }].map(item => <button key={item.title} onClick={() => setPrompt(item.text)}><item.icon size={18}/><span>{item.title}</span><ArrowRight size={15}/></button>)}
          </div><div className="welcome-foot"><ShieldCheck size={14}/>项目内自动编辑 · 终端命令逐次确认</div></section> : <div className="timeline"><div className="task-heading"><span className={`status-tag ${task.status}`}>{statusText[task.status]}</span><span>{new Date(task.createdAt).toLocaleString('zh-CN')}</span></div>
          <HistoryControls hasMore={history.hasMore} loading={history.loading} incomplete={task.historyIncomplete} load={() => { pauseFollowing(); void history.loadEarlier(); }}/>
          {detail.error && <div className="task-error" role="alert">任务记录加载失败：{detail.error}<button onClick={detail.retry}>重试</button></div>}
          <TimelineRows events={history.events} busy={isBusy} runId={task.currentRunId} waiting={task.status === 'waiting'} viewport={conversation} position={pendingPosition.current} expanded={expanded} following={() => followLatest.current} corrected={top => { restoredTop.current = top; previousScrollTop.current = top; }}/>
          {history.hasLater && <div className="history-pagination"><button className="outline" disabled={history.loading} onClick={() => { pauseFollowing(); void history.loadLater(); }}>加载较新记录</button><button className="outline" disabled={history.loading} onClick={() => void returnToLatest()}>回到最新</button></div>}
          {!history.hasLater && task.currentRunId && <StreamingReply key={`${task.id}:${task.currentRunId}`} api={api} taskId={task.id} runId={task.currentRunId} initial={task.stream} onContent={() => { if (followLatest.current && !pendingPosition.current) scrollToLatest(false); }}/>}
          <RecoveryPanel task={task} disabled={sending || composerLocked} resume={() => {
            const latest = task.runs?.find(r => r.id === task.currentRunId) || task.runs?.at(-1);
            setMode(latest?.mode || task.mode || 'execute');
            setRunId(latest?.reviewRunId || latest?.id || '');
            setPrompt(old => old.trim() ? old : recoveryPrompt(task));
            document.querySelector<HTMLTextAreaElement>('textarea[aria-label="任务要求"]')?.focus();
          }} inspect={() => { setTab('changes'); setRunId(task.currentRunId || ''); }} settings={() => setSettingsOpen(true)}/>
          {task.legacy && <p className="inspector-note">历史数据，缺少轮次核验。</p>}
          {run && !busyStatuses.includes(run.status) && <><RunResult run={run}/><PlanActions key={run.id} run={run} load={() => api.planText(task.id, run.id)} disabled={sending || projectBusy || detail.loading || !!task.archivedAt} execute={() => void submit(run.id)}/></>}

          </div>}
      </div>
        {task && (showLatest || history.hasLater) && <div className="latest-row"><button className="latest-button" disabled={history.loading} onClick={() => void returnToLatest()}><ChevronDown size={14}/>回到最新</button></div>}
      </div>
      <div className="composer-area">
        {evaluating && <div className="archived-banner"><span>模型能力实测中，完成或停止后可提交任务。</span><button onClick={() => setSettingsOpen(true)}>查看实测</button></div>}
        {task?.archivedAt && <div className="archived-banner"><span>此任务已归档，恢复后可继续对话。</span><button onClick={() => api.archiveTask(task.id, false).catch(fail)}>恢复任务</button></div>}
        {task && <TaskProgress task={task}/>}
        <ContextMeter usage={run?.contextUsage}/>
        {task?.approval && <div className="approval"><div><ShieldCheck size={17}/><strong>需要确认终端命令</strong><span>{task.approval.timeout}s 超时</span></div><pre>{task.approval.command}</pre><small>工作目录：{task.approval.cwd}<br/>命令以你的系统用户权限运行。</small><footer><button onClick={() => api.approve(task.id, task.approval!.id, false).catch(fail)}>拒绝</button><button className="primary" onClick={() => api.approve(task.id, task.approval!.id, true).catch(fail)}>允许执行<ArrowRight size={14}/></button></footer></div>}
        <div className="mode-controls"><label>任务模式 <select aria-label="任务模式" value={mode} disabled={sending || composerLocked} onChange={e => setMode(e.target.value as Mode)}>{Object.entries(modeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><button disabled={!project || sending || referencePending || composerLocked || references.length >= 8} onClick={() => setPicker({})}>@ 引用文件</button><small>{mode === 'execute' ? '项目内自动写入，支持安全回退' : mode === 'plan' ? '只读分析，确认计划后执行' : '只审查右侧选定轮次，禁止自动修复'}</small></div>
        {!!references.length && <div className="reference-chips">{references.map((r, i) => <span className={r.projectId !== projectId ? 'invalid' : ''} key={i} title={`${state.projects.find(p => p.id === r.projectId)?.path}/${r.path}`}><button disabled={r.projectId !== projectId || sending} onClick={() => setPicker({ path: r.path })}><FileCode2 size={13}/><span className="reference-name">{referenceName(r.path)}</span>{r.scope === 'file' ? ' · 整个文件' : `:${r.startLine}–${r.endLine}`}{r.projectId !== projectId ? '（项目已切换，引用失效）' : ''}</button><button disabled={sending} aria-label="移除引用" onClick={() => setReferences(references.filter((_, j) => j !== i))}>×</button></span>)}</div>}
        <div className={`composer ${composerLocked ? 'busy' : ''}`}><MentionInput key={`${projectId}:${taskId}`} api={api} project={project} placeholder={task?.archivedAt ? '恢复任务后可继续对话' : isBusy ? '任务正在执行，可停止后继续补充要求…' : '描述任务，输入 @ 引用文件…'} value={prompt} references={references} disabled={composerLocked || sending} canAdd={references.length < 8} onChange={setPrompt} onChoose={ref=>setReferences(old=>[...old.filter(r=>!(r.projectId===ref.projectId && r.path===ref.path)),ref].slice(0,8))} onPending={setReferencePending} submit={()=>void submit()}/><div className="composer-toolbar"><label className="composer-project" title={project?.path || '选择任务所在项目'}><Folder size={13}/><select aria-label="切换任务项目" value={projectId} disabled={sending || !state.projects.length} onChange={e => chooseProject(e.target.value)}>
          {!projectId && <option value="" disabled>未选择项目</option>}
          {state.projects.map(p => <option key={p.id} value={p.id}>{state.projects.filter(other => other.name === p.name).length > 1 ? `${p.name} — ${p.path}` : p.name}</option>)}
        </select><ChevronDown size={12}/></label><div className="composer-actions"><ModelSelector key={`${projectId}:${taskId}`} api={api} value={model} defaultModel={state.settings.model} service={modelService} disabled={sending || composerLocked || !!evaluating} onChange={setModel} onValidation={setModelValidation} settings={() => setSettingsOpen(true)}/>{isBusy ? <><span className="working-label"><LoaderCircle size={12} className="spin"/>{statusText[selected!.status]}</span><button className="send stop" aria-label="停止任务" onClick={() => api.stop(selected!.id).catch(fail)}><Square size={14}/></button></> : <><span className="shortcut">⌘ ↵ 发送</span><button className="send" aria-label="发送任务" disabled={!prompt.trim() || sending || referencePending || invalidReferences || composerLocked} onClick={() => submit()}>{sending ? <LoaderCircle size={18} className="spin"/> : <ArrowUp size={19}/>}</button></>}</div></div></div>
        <div className="composer-caption"><ShieldCheck size={12}/>推理由你配置的 LM Studio 提供<span>Jalo / 开发版</span></div>
      </div>
    </main>
    <aside className="inspector"><header><span>任务工作区</span><span className="inspector-counter">{task?.changes.length || 0} 个文件</span></header><div className="inspector-tabs"><button className={tab === 'changes' ? 'active' : ''} onClick={() => setTab('changes')}><GitBranch size={14}/>修改</button><button className={tab === 'terminal' ? 'active' : ''} onClick={() => setTab('terminal')}><Terminal size={14}/>终端</button></div>
      {tab === 'changes' ? <RunPanel task={task} runId={runId} selectRun={setRunId} locked={projectBusy} fail={fail} preview={path => setPicker({ path })}/> : <div className="terminal-panel"><div className="terminal-heading"><span className="green-dot"/>zsh <span>只显示本任务输出</span></div>{task && <HistoryControls hasMore={history.hasMore} loading={history.loading} incomplete={task.historyIncomplete} load={() => void history.loadEarlier()}/>}<pre>{history.events.filter(e => e.kind === 'output').map(e => e.text).join('') || '已加载记录中暂无命令输出。\n\n每条命令将在确认后运行。'}</pre><p>终端修改不计入文件工具差异。</p></div>}
      <div className="runtime-card"><div><Cpu size={15}/><strong>本地运行环境</strong></div><dl><dt>推理服务</dt><dd>LM Studio</dd><dt>执行引擎</dt><dd>独立进程</dd><dt>任务调度</dt><dd>{state.activeId ? '1 个运行中' : '空闲'}{state.tasks.some(t => t.status === 'queued') ? ` · ${state.tasks.filter(t => t.status === 'queued').length} 个排队` : ''}</dd></dl></div>
    </aside>
    {error && <div className="toast" role="alert"><span>{error}</span><button aria-label="关闭提示" onClick={() => setError('')}><X size={16}/></button></div>}
    {picker && project && <FilePicker key={project.id} project={project} initialPath={picker.path} initialReference={references.find(r=>r.projectId===project.id && r.path===picker.path)} close={() => setPicker(undefined)} choose={ref => { setReferences(old => [...old.filter(r => !(r.projectId === ref.projectId && r.path === ref.path)), ref].slice(0, 8)); setPicker(undefined); }}/>}
    {settingsOpen && <SettingsDialog state={state} close={() => setSettingsOpen(false)} fail={fail}/>}
    {removingProject && <RemoveProjectDialog project={removingProject} close={() => setRemovingProject(undefined)} fail={fail} removed={() => {
      if (removingProject.id === projectId) { const remaining={...state,projects:state.projects.filter(p=>p.id!==projectId)};openView(restoreView(sessions.current,remaining,{projectId:'',taskId:''})); }
    }}/>}
  </div>;
}

function SettingsDialog({ state, close, fail }: { state: Snapshot; close: () => void; fail: (e: unknown) => void }) {
  const [draft, setDraft] = useState<Settings>(state.settings);
  const [models, setModels] = useState<LocalModel[]>([]);
  const [working, setWorking] = useState(false);
  const [connected, setConnected] = useState(false);
  const [feedback, setFeedback] = useState('');
  const tasksBusy = state.tasks.some(t => busyStatuses.includes(t.status));
  const locked = tasksBusy || !!state.evaluations?.some(r => r.status === 'running');
  const field = (key: keyof Settings, value: string | number) => setDraft(s => ({ ...s, [key]: value }));
  const perform = async (fn: () => Promise<void>) => { setWorking(true); setFeedback(''); try { await fn(); } catch (e) { setConnected(false); fail(e); } finally { setWorking(false); } };
  useEffect(() => { api.models().then(m => { setModels(m); setConnected(true); }).catch(() => {}); }, []);
  return <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget && !working) close(); }}><section className="settings-modal" role="dialog" aria-modal="true" aria-label="模型与设置"><header><div><span className="settings-icon"><Cpu size={22}/></span><div><h2>模型与设置</h2><p>你的模型，你的工作环境。</p></div></div><button aria-label="关闭设置" disabled={working} onClick={close}><X size={19}/></button></header>
    {locked && <div className="locked-note">任务或模型实测期间，模型与配置已锁定。请先完成或停止运行。</div>}
    <div className="settings-body"><AppMaintenance api={api}/><div className="settings-section-heading"><span>连接 LM Studio</span><small className={connected ? 'connected' : ''}><i className={connected ? 'green-dot' : 'gray-dot'}/>{connected ? '服务可达' : '尚未连接'}</small></div>
      <fieldset disabled={locked || working}><label>服务地址<input value={draft.baseUrl} placeholder="http://127.0.0.1:1234" onChange={e => { field('baseUrl', e.target.value); setConnected(false); }}/></label><label>访问令牌 <small>可选，使用系统加密存储</small><input type="password" autoComplete="off" value={draft.token} placeholder="未启用认证时留空" onChange={e => field('token', e.target.value)}/></label><button className="outline connect-button" onClick={() => perform(async () => { await api.saveSettings(draft); const m = await api.models(); setModels(m); setConnected(true); setFeedback(`连接成功，发现 ${m.length} 个语言模型`); })}><RefreshCw size={14} className={working ? 'spin' : ''}/>保存并检测连接</button></fieldset>
      <div className="settings-section-heading"><span>本地模型</span><small>{models.length} 个可用</small></div>
      <fieldset disabled={locked || working}><label>默认模型<select value={draft.model} onChange={e => field('model', e.target.value)}><option value="">选择一个模型</option>{draft.model && !models.some(m => m.key === draft.model) && <option value={draft.model}>{draft.model}</option>}{models.map(m => <option key={m.key} value={m.key}>{m.name}</option>)}</select></label></fieldset>
      <div className="models-list">{models.map(m => <div key={m.key} className="model-row"><span className="model-icon"><HardDrive size={17}/></span><div><strong>{m.name}</strong><small>{(m.size / 1024 ** 3).toFixed(1)} GB · {m.toolUse === false ? '未针对工具调用训练' : m.toolUse ? '支持工具调用' : '工具能力待检测'} · {m.instances.length ? '已加载' : '未加载'}</small></div><div className="model-actions">{m.instances.length ? m.instances.map(i => <button key={i.id} disabled={locked || working} title={i.id} onClick={() => perform(async () => { await api.unloadModel(i.id); setModels(await api.models()); })}>卸载</button>) : <button disabled={locked || working} onClick={() => perform(async () => { await api.saveSettings(draft); await api.loadModel(m.key); setModels(await api.models()); })}>加载</button>}</div></div>)}{!models.length && <p className="models-empty">在 LM Studio 中下载模型并启动服务器，<br/>然后点击“保存并检测连接”。</p>}</div>
      <div className="settings-section-heading"><span>运行参数</span><small>模型任务开始后固定</small></div><fieldset className="parameter-grid" disabled={locked || working}>
        {([{ key: 'contextLength', label: '上下文长度', min: 4096, max: 262144, step: 1024 }, { key: 'maxTokens', label: '最大输出 Token', min: 128, max: 16384, step: 128 }, { key: 'temperature', label: '温度', min: 0, max: 2, step: 0.1 }, { key: 'maxSteps', label: '最大执行步数', min: 1, max: 100, step: 1 }, { key: 'commandTimeout', label: '命令超时（秒）', min: 1, max: 600, step: 1 }] as const).map(p => <label key={p.key}>{p.label}<input type="number" min={p.min} max={p.max} step={p.step} value={draft[p.key]} onChange={e => field(p.key, Number(e.target.value))}/></label>)}
      </fieldset><p className="settings-hint">上下文设置用于加载新实例；已加载模型沿用其实际容量。变更后可卸载再加载。</p>
      <ModelEvaluation reports={state.evaluations || []} api={api} disabled={tasksBusy || working} model={draft.model} start={async () => { await api.saveSettings(draft); await api.startEvaluation(); }} fail={fail}/>
    </div><footer><span>{feedback || '配置和任务记录保存在这台 Mac 上'}</span><button className="primary" disabled={locked || working} onClick={() => perform(async () => { await api.saveSettings(draft); close(); })}>{working ? <LoaderCircle size={15} className="spin"/> : <Check size={15}/>}保存设置</button></footer>
  </section></div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
