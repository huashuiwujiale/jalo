import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowUp, ArrowRight, Check, ChevronDown, ChevronRight, Code2, Cpu, FileCode2, Folder, FolderPlus, GitBranch, HardDrive, LoaderCircle, MessageSquare, Plus, RefreshCw, Settings2, ShieldCheck, Square, Terminal, X, Zap } from 'lucide-react';
import { FilePicker, RunPanel, RunResult, modeLabels } from './reliability';
import type { Mode, FileReference, Api, LocalModel, Settings, Snapshot, Task } from '../shared/types';
import { busyStatuses, defaults } from '../shared/types';
import './style.css';
declare global { interface Window { localCode: Api } }
const statusText: Record<Task['status'], string> = { queued: '排队中', running: '执行中', waiting: '等待确认', completed: '本轮结束', failed: '执行失败', cancelled: '已停止', interrupted: '已中断' };
const api = window.localCode;

function App() {
  const [state, setState] = useState<Snapshot>({ projects: [], tasks: [], settings: defaults });
  const [projectId, setProjectId] = useState('');
  const [taskId, setTaskId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<Mode>('execute');
  const [references, setReferences] = useState<FileReference[]>([]);
  const [picker, setPicker] = useState<{ path?: string }>();
  const [runId, setRunId] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tab, setTab] = useState<'changes' | 'terminal'>('changes');
  const [selectedFile, setSelectedFile] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [streams, setStreams] = useState<Record<string, string>>({});
  const conversation = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const previousScrollTop = useRef(0);
  const [showLatest, setShowLatest] = useState(false);
  const scrollToLatest = () => {
    const element = conversation.current;
    if (!element) return;
    followLatest.current = true;
    // Scroll this panel only. Smooth scrolling on every token fights user gestures.
    const bottom = Math.max(0, element.scrollHeight - element.clientHeight);
    if (Math.abs(element.scrollTop - bottom) > 1) element.scrollTop = bottom;
    previousScrollTop.current = element.scrollTop;
    setShowLatest(false);
  };
  const pauseFollowing = () => {
    followLatest.current = false;
    setShowLatest(true);
  };
  const handleConversationScroll = () => {
    const element = conversation.current;
    if (!element) return;
    const bottom = Math.max(0, element.scrollHeight - element.clientHeight);
    const scrollTop = Math.max(0, Math.min(element.scrollTop, bottom));
    const movedUp = scrollTop < previousScrollTop.current - 1;
    const atBottom = bottom - scrollTop <= 4;
    // Resizing or collapsing content can lower scrollTop while still at the bottom.
    if (atBottom) followLatest.current = true;
    else if (movedUp) followLatest.current = false;
    previousScrollTop.current = scrollTop;
    setShowLatest(!followLatest.current);
  };
  const project = state.projects.find(p => p.id === projectId);
  const task = state.tasks.find(t => t.id === taskId);
  const isBusy = !!task && busyStatuses.includes(task.status);
  const run = task?.runs?.find(r => r.id === runId) || task?.runs?.at(-1);
  const invalidReferences = references.some(r => r.projectId !== projectId);
  const projectBusy = state.tasks.some(t => t.projectId === projectId && busyStatuses.includes(t.status));
  const fail = (e: unknown) => setError((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': Error: /, ''));
  useEffect(() => {
    if (!api) { setError('请通过 npm run dev 打开桌面应用；普通浏览器无法访问本地工具。'); return; }
    api.snapshot().then(s => { setState(s); setProjectId(s.projects[0]?.id || ''); }).catch(fail);
    const offState = api.onUpdate(s => {
      setState(s);
      setStreams(previous => { const next = { ...previous }; for (const t of s.tasks) { if (!busyStatuses.includes(t.status) || t.events.at(-1)?.role === 'assistant') delete next[t.id]; } return next; });
    });
    const offDelta = api.onDelta(({ taskId, text }) => setStreams(old => ({ ...old, [taskId]: (old[taskId] || '') + text })));
    return () => { offState(); offDelta(); };
  }, []);
  // Opening a task starts at its latest entry; subsequent updates respect reading position.
  useLayoutEffect(() => { scrollToLatest(); }, [taskId]);
  useLayoutEffect(() => {
    if (followLatest.current) scrollToLatest();
  }, [task?.events.length, task?.events.at(-1)?.id, streams[taskId], task?.approval?.id, task?.status]);
  useEffect(() => {
    const element = conversation.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      if (followLatest.current) scrollToLatest();
    });
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [taskId]);
  const chooseProject = (id: string) => {
    if (sending || id === projectId || !state.projects.some(p => p.id === id)) return;
    // A task stays bound to its original project; keep only the unsent draft.
    setProjectId(id); setPicker(undefined); setRunId(''); setTaskId(''); setSelectedFile(''); setTab('changes'); setError('');
  };
  const addProject = async () => { try { const p = await api.addProject(); if (p) { setProjectId(p.id); setTaskId(''); setPrompt(''); } } catch (e) { fail(e); } };
  const submit = async (planRunId?: string) => {
    if ((!prompt.trim() && !planRunId) || sending || isBusy) return;
    if (invalidReferences && !planRunId) { setError('存在其他项目的失效引用，请移除或重新选择'); return; }
    if (!projectId) { setError('请先添加并选择一个项目文件夹'); return; }
    setSending(true); setError('');
    try { const id = await api.submit({ projectId, prompt: planRunId ? '按关联计划执行，先重新读取文件，再完成修改和核验。' : prompt, mode: planRunId ? 'execute' : mode, references: planRunId ? [] : references, ...(planRunId ? { planRunId } : {}), ...(mode === 'review' && !planRunId && run ? { reviewRunId: run.id } : {}), ...(taskId ? { taskId } : {}) }); setTaskId(id); setRunId(''); if (planRunId) setMode('execute'); setPrompt(''); setReferences([]); scrollToLatest(); } catch (e) { fail(e); }
    finally { setSending(false); }
  };
  const chooseTask = (t: Task) => { setRunId(''); setReferences([]); setPicker(undefined); setTaskId(t.id); setProjectId(t.projectId); setPrompt(''); setSelectedFile(''); };
  const newTask = () => { setRunId(''); setReferences([]); setPicker(undefined); setTaskId(''); setPrompt(''); setSelectedFile(''); };
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="traffic-space"/><div className="brand"><span className="brand-mark"><Code2 size={19}/></span><span>Jalo<span className="brand-label">本地编程助手</span></span></div>
      <button className="new-task" onClick={newTask}><Plus size={17}/>新建任务<span className="keycap">N</span></button>
      <div className="section-label">工作空间<button title="添加项目" onClick={addProject}><FolderPlus size={15}/></button></div>
      <div className="projects">{state.projects.map(p => <button key={p.id} className={`project-item ${p.id === projectId ? 'selected' : ''}`} title={p.path} disabled={sending} onClick={() => chooseProject(p.id)}><Folder size={16}/><span>{p.name}</span>{p.id === projectId && <span className="selected-dot"/>}</button>)}{!state.projects.length && <button className="empty-project" onClick={addProject}><FolderPlus size={17}/>添加第一个项目</button>}</div>
      <div className="section-label history-label">任务记录<span>{state.tasks.filter(t => t.projectId === projectId).length}</span></div>
      <nav className="task-list">{state.tasks.filter(t => t.projectId === projectId).map(t => <button key={t.id} onClick={() => chooseTask(t)} className={`task-item ${taskId === t.id ? 'selected' : ''}`}><MessageSquare size={14}/><span><strong>{t.title}</strong><small><i className={`status-dot ${t.status}`}/>{statusText[t.status]}</small></span></button>)}{!state.tasks.some(t => t.projectId === projectId) && <p className="sidebar-hint">从一个想法开始。<br/>你的任务会保存在这里。</p>}</nav>
      <div className="sidebar-bottom"><div className="local-badge"><span className="green-dot"/>本地模型 · 本地记录</div><button onClick={() => setSettingsOpen(true)}><Settings2 size={16}/>模型与设置<ChevronRight size={15}/></button></div>
    </aside>
    <main className="workspace">
      <header className="topbar"><div className="breadcrumb"><Folder size={15}/><span>{project?.name || '选择工作空间'}</span><span className="slash">/</span><strong>{task ? '任务详情' : '新建任务'}</strong></div><button className="model-pill" onClick={() => setSettingsOpen(true)}><span className={state.settings.model ? 'green-dot' : 'gray-dot'}/><span>{state.settings.model || '连接本地模型'}</span><ChevronDown size={13}/></button></header>
      <div className="conversation-pane">
      <div className="conversation" ref={conversation} onScroll={handleConversationScroll}
        onWheel={event => { if (event.deltaY < 0) pauseFollowing(); }}
        onKeyDown={event => { if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) pauseFollowing(); }}
        onClickCapture={event => { if ((event.target as HTMLElement).closest('summary')) pauseFollowing(); }}
        tabIndex={0} role="region" aria-label="任务对话记录">
        {!task ? <section className="welcome"><div className="welcome-icon"><Code2 size={31}/><span/></div><div className="eyebrow">YOUR LOCAL WORKSPACE</div><h1>把想法，变成代码。</h1><p>连接你自己的模型，在熟悉的项目里开始工作。<br/>从理解代码到完成修改，每一步都清晰可见。</p><div className="suggestions">
          {[{ icon: Folder, title: '了解这个项目', text: '阅读项目结构和 AGENTS.md，介绍技术栈、主要模块与启动方式。暂不修改文件。' }, { icon: Code2, title: '检查一段实现', text: '检查项目的主要入口与核心逻辑，找出一个有明确证据的问题，先说明原因和修改建议。' }, { icon: GitBranch, title: '开始一个改动', text: '我想在这个项目中实现一个功能：' }].map(item => <button key={item.title} onClick={() => setPrompt(item.text)}><item.icon size={18}/><span>{item.title}</span><ArrowRight size={15}/></button>)}
          </div><div className="welcome-foot"><ShieldCheck size={14}/>项目内自动编辑 · 终端命令逐次确认</div></section> : <div className="timeline"><div className="task-heading"><span className={`status-tag ${task.status}`}>{statusText[task.status]}</span><span>{new Date(task.createdAt).toLocaleString('zh-CN')}</span></div>
          {task.events.map(e => e.kind === 'message' ? <article key={e.id} className={`message ${e.role}`}><div className="message-author">{e.role === 'user' ? <span className="avatar user-avatar">你</span> : <span className="avatar assistant-avatar"><Code2 size={15}/></span>}<strong>{e.role === 'user' ? '你' : 'Jalo'}</strong></div><div className="message-text">{e.text}</div></article> : e.kind === 'output' ? null : e.kind === 'notice' ? <div key={e.id} className="progress-line"><span/>{e.text}</div> : <details key={e.id} className={`tool-event ${e.kind}`}><summary><Terminal size={13}/><span>{e.text.split('\n')[0].slice(0, 150)}</span><ChevronDown size={12}/></summary><pre>{e.text}</pre></details>)}
          {streams[taskId] && <article className="message assistant"><div className="message-author"><span className="avatar assistant-avatar"><Code2 size={15}/></span><strong>Jalo</strong><LoaderCircle className="spin" size={13}/></div><div className="message-text">{streams[taskId]}<span className="cursor"/></div></article>}
          {task.error && <div className="task-error"><strong>{statusText[task.status]}</strong><p>{task.error}</p></div>}
          {task.legacy && <p className="inspector-note">历史数据，缺少轮次核验。</p>}
          {run && !busyStatuses.includes(run.status) && <><RunResult run={run}/>{run.mode === 'plan' && run.status === 'completed' && <button className="primary" disabled={sending || projectBusy} onClick={() => submit(run.id)}>按计划执行</button>}</>}

          </div>}
      </div>
        {task && showLatest && <div className="latest-row"><button className="latest-button" onClick={scrollToLatest}><ChevronDown size={14}/>回到最新</button></div>}
      </div>
      <div className="composer-area">
        {task?.approval && <div className="approval"><div><ShieldCheck size={17}/><strong>需要确认终端命令</strong><span>{task.approval.timeout}s 超时</span></div><pre>{task.approval.command}</pre><small>工作目录：{task.approval.cwd}<br/>命令以你的系统用户权限运行。</small><footer><button onClick={() => api.approve(task.id, task.approval!.id, false).catch(fail)}>拒绝</button><button className="primary" onClick={() => api.approve(task.id, task.approval!.id, true).catch(fail)}>允许执行<ArrowRight size={14}/></button></footer></div>}
        <div className="mode-controls"><label>任务模式 <select aria-label="任务模式" value={mode} disabled={sending || isBusy} onChange={e => setMode(e.target.value as Mode)}>{Object.entries(modeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><button disabled={!project || isBusy || references.length >= 8} onClick={() => setPicker({})}>@ 引用文件</button><small>{mode === 'execute' ? '项目内自动写入，支持安全回退' : mode === 'plan' ? '只读分析，确认计划后执行' : '只审查右侧选定轮次，禁止自动修复'}</small></div>
        {!!references.length && <div className="reference-chips">{references.map((r, i) => <span className={r.projectId !== projectId ? 'invalid' : ''} key={i} title={state.projects.find(p => p.id === r.projectId)?.path}><button disabled={r.projectId !== projectId} onClick={() => setPicker({ path: r.path })}>{r.path}:{r.startLine}–{r.endLine}{r.projectId !== projectId ? '（项目已切换，引用失效）' : ''}</button><button aria-label="移除引用" onClick={() => setReferences(references.filter((_, j) => j !== i))}>×</button></span>)}</div>}
        <div className={`composer ${isBusy ? 'busy' : ''}`}><textarea aria-label="任务要求" placeholder={isBusy ? '任务正在执行，可停止后继续补充要求…' : task ? '继续描述你的要求…' : '描述你想完成的任务…'} value={prompt} disabled={isBusy} onChange={e => { const text = e.target.value; if (text.endsWith('@') && project && references.length < 8) { setPicker({}); setPrompt(text.slice(0, -1)); } else setPrompt(text); }} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } }}/><div className="composer-toolbar"><label className="composer-project" title={project?.path || '选择任务所在项目'}><Folder size={13}/><select aria-label="切换任务项目" value={projectId} disabled={sending || !state.projects.length} onChange={e => chooseProject(e.target.value)}>
          {!projectId && <option value="" disabled>未选择项目</option>}
          {state.projects.map(p => <option key={p.id} value={p.id}>{state.projects.filter(other => other.name === p.name).length > 1 ? `${p.name} — ${p.path}` : p.name}</option>)}
        </select><ChevronDown size={12}/></label><div>{isBusy ? <><span className="working-label"><LoaderCircle size={12} className="spin"/>{statusText[task!.status]}</span><button className="send stop" aria-label="停止任务" onClick={() => api.stop(task!.id).catch(fail)}><Square size={14}/></button></> : <><span className="shortcut">⌘ ↵ 发送</span><button className="send" aria-label="发送任务" disabled={!prompt.trim() || sending || invalidReferences} onClick={() => submit()}>{sending ? <LoaderCircle size={18} className="spin"/> : <ArrowUp size={19}/>}</button></>}</div></div></div>
        <div className="composer-caption"><ShieldCheck size={12}/>推理由你配置的 LM Studio 提供<span>Jalo / 开发版</span></div>
      </div>
    </main>
    <aside className="inspector"><header><span>任务工作区</span><span className="inspector-counter">{task?.changes.length || 0} 个文件</span></header><div className="inspector-tabs"><button className={tab === 'changes' ? 'active' : ''} onClick={() => setTab('changes')}><GitBranch size={14}/>修改</button><button className={tab === 'terminal' ? 'active' : ''} onClick={() => setTab('terminal')}><Terminal size={14}/>终端</button></div>
      {tab === 'changes' ? <RunPanel task={task} runId={runId} selectRun={setRunId} locked={projectBusy} fail={fail} preview={path => setPicker({ path })}/> : <div className="terminal-panel"><div className="terminal-heading"><span className="green-dot"/>zsh <span>只显示本任务输出</span></div><pre>{task?.events.filter(e => e.kind === 'output').map(e => e.text).join('') || '等待执行命令…\n\n每条命令将在确认后运行。'}</pre><p>终端修改不计入文件工具差异。</p></div>}
      <div className="runtime-card"><div><Cpu size={15}/><strong>本地运行环境</strong></div><dl><dt>推理服务</dt><dd>LM Studio</dd><dt>执行引擎</dt><dd>独立进程</dd><dt>任务调度</dt><dd>{state.activeId ? '1 个运行中' : '空闲'}{state.tasks.some(t => t.status === 'queued') ? ` · ${state.tasks.filter(t => t.status === 'queued').length} 个排队` : ''}</dd></dl></div>
    </aside>
    {error && <div className="toast" role="alert"><span>{error}</span><button aria-label="关闭提示" onClick={() => setError('')}><X size={16}/></button></div>}
    {picker && project && <FilePicker key={project.id} project={project} initialPath={picker.path} close={() => setPicker(undefined)} choose={ref => { setReferences(old => [...old.filter(r => !(r.projectId === ref.projectId && r.path === ref.path)), ref].slice(0, 8)); setPicker(undefined); }}/>}
    {settingsOpen && <SettingsDialog state={state} close={() => setSettingsOpen(false)} fail={fail}/>}
  </div>;
}

function SettingsDialog({ state, close, fail }: { state: Snapshot; close: () => void; fail: (e: unknown) => void }) {
  const [draft, setDraft] = useState<Settings>(state.settings);
  const [models, setModels] = useState<LocalModel[]>([]);
  const [working, setWorking] = useState(false);
  const [connected, setConnected] = useState(false);
  const [feedback, setFeedback] = useState('');
  const locked = state.tasks.some(t => busyStatuses.includes(t.status));
  const field = (key: keyof Settings, value: string | number) => setDraft(s => ({ ...s, [key]: value }));
  const perform = async (fn: () => Promise<void>) => { setWorking(true); setFeedback(''); try { await fn(); } catch (e) { setConnected(false); fail(e); } finally { setWorking(false); } };
  useEffect(() => { api.models().then(m => { setModels(m); setConnected(true); }).catch(() => {}); }, []);
  return <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget && !working) close(); }}><section className="settings-modal" role="dialog" aria-modal="true" aria-label="模型与设置"><header><div><span className="settings-icon"><Cpu size={22}/></span><div><h2>模型与设置</h2><p>你的模型，你的工作环境。</p></div></div><button aria-label="关闭设置" disabled={working} onClick={close}><X size={19}/></button></header>
    {locked && <div className="locked-note">任务执行或排队期间，模型与配置已锁定。请先完成或停止任务。</div>}
    <div className="settings-body"><div className="settings-section-heading"><span>连接 LM Studio</span><small className={connected ? 'connected' : ''}><i className={connected ? 'green-dot' : 'gray-dot'}/>{connected ? '服务可达' : '尚未连接'}</small></div>
      <fieldset disabled={locked || working}><label>服务地址<input value={draft.baseUrl} placeholder="http://127.0.0.1:1234" onChange={e => { field('baseUrl', e.target.value); setConnected(false); }}/></label><label>访问令牌 <small>可选，使用系统加密存储</small><input type="password" autoComplete="off" value={draft.token} placeholder="未启用认证时留空" onChange={e => field('token', e.target.value)}/></label><button className="outline connect-button" onClick={() => perform(async () => { await api.saveSettings(draft); const m = await api.models(); setModels(m); setConnected(true); setFeedback(`连接成功，发现 ${m.length} 个语言模型`); })}><RefreshCw size={14} className={working ? 'spin' : ''}/>保存并检测连接</button></fieldset>
      <div className="settings-section-heading"><span>本地模型</span><small>{models.length} 个可用</small></div>
      <fieldset disabled={locked || working}><label>默认模型<select value={draft.model} onChange={e => field('model', e.target.value)}><option value="">选择一个模型</option>{draft.model && !models.some(m => m.key === draft.model) && <option value={draft.model}>{draft.model}</option>}{models.map(m => <option key={m.key} value={m.key}>{m.name}</option>)}</select></label></fieldset>
      <div className="models-list">{models.map(m => <div key={m.key} className="model-row"><span className="model-icon"><HardDrive size={17}/></span><div><strong>{m.name}</strong><small>{(m.size / 1024 ** 3).toFixed(1)} GB · {m.toolUse === false ? '未针对工具调用训练' : m.toolUse ? '支持工具调用' : '工具能力待检测'} · {m.instances.length ? '已加载' : '未加载'}</small></div><div className="model-actions">{m.instances.length ? m.instances.map(i => <button key={i.id} disabled={locked || working} title={i.id} onClick={() => perform(async () => { await api.unloadModel(i.id); setModels(await api.models()); })}>卸载</button>) : <button disabled={locked || working} onClick={() => perform(async () => { await api.saveSettings(draft); await api.loadModel(m.key); setModels(await api.models()); })}>加载</button>}</div></div>)}{!models.length && <p className="models-empty">在 LM Studio 中下载模型并启动服务器，<br/>然后点击“保存并检测连接”。</p>}</div>
      <div className="settings-section-heading"><span>运行参数</span><small>模型任务开始后固定</small></div><fieldset className="parameter-grid" disabled={locked || working}>
        {([{ key: 'contextLength', label: '上下文长度', min: 4096, max: 262144, step: 1024 }, { key: 'maxTokens', label: '最大输出 Token', min: 128, max: 16384, step: 128 }, { key: 'temperature', label: '温度', min: 0, max: 2, step: 0.1 }, { key: 'maxSteps', label: '最大执行步数', min: 1, max: 100, step: 1 }, { key: 'commandTimeout', label: '命令超时（秒）', min: 1, max: 600, step: 1 }] as const).map(p => <label key={p.key}>{p.label}<input type="number" min={p.min} max={p.max} step={p.step} value={draft[p.key]} onChange={e => field(p.key, Number(e.target.value))}/></label>)}
      </fieldset><p className="settings-hint">上下文设置用于加载新实例；已加载模型沿用其实际容量。变更后可卸载再加载。</p>
    </div><footer><span>{feedback || '配置和任务记录保存在这台 Mac 上'}</span><button className="primary" disabled={locked || working} onClick={() => perform(async () => { await api.saveSettings(draft); close(); })}>{working ? <LoaderCircle size={15} className="spin"/> : <Check size={15}/>}保存设置</button></footer>
  </section></div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
