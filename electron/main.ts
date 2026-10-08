import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, safeStorage, shell, utilityProcess, type UtilityProcess } from 'electron';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { captureReferences, previewFile, referenceFile, referenceContext, searchFiles, listDirectory, rollbackPreview, restoreFile } from '../engine/project-files';
import { createTwoFilesPatch } from 'diff';
import { Store } from './store';
import { SessionStore } from './session';
import { viewSchema } from '../shared/session';
import { EvaluationController } from './evaluation';
import { DiagnosticLog, diagnosticReport, errorCategory, saveDiagnosticReport } from './diagnostics';
import { LMStudioProvider } from '../engine/provider';
import { settingsSchema, submitSchema } from '../shared/validation';
import { linkedPlanContext, pageTaskEvents } from '../shared/task-history';
import { changeView, searchTaskIds, taskDetail, taskSummary } from '../shared/task-wire';
import { ReplyStream, UpdateBatch } from './ipc-updates';
import { fileNameIndex } from '../engine/file-search';
import { webLink } from '../shared/markdown';
import { workerInput, MessagePatchReceiver, type WorkerEvent } from '../shared/worker-wire';
import { busyStatuses, type AppInfo, type Settings, type Snapshot, type Task, type Run, type Progress, type TaskSummary } from '../shared/types';

// Keep legacy identity when upgrading: macOS safeStorage keys also depend on the app name.
const legacyDataPath = path.join(app.getPath('appData'), 'Local Code');
const upgradingLegacy = existsSync(path.join(legacyDataPath, 'local-code.sqlite'));
app.setName(upgradingLegacy ? 'Local Code' : 'Jalo');
app.setPath('userData', upgradingLegacy ? legacyDataPath : path.join(app.getPath('appData'), 'Jalo'));
app.setAboutPanelOptions({ applicationName: 'Jalo', applicationVersion: app.getVersion(), authors: ['佳乐 (Jiale)'] });
const diagnostics = new DiagnosticLog(app.getPath('userData'));
let exportingDiagnostics = false;
function appInfo(): AppInfo {
  return { version: app.getVersion(), packaged: app.isPackaged, platform: process.platform, arch: process.arch,
    electron: process.versions.electron || '', chrome: process.versions.chrome || '', node: process.versions.node, osRelease: os.release(),
    dataDirectory: app.getPath('userData'), logDirectory: diagnostics.directory, logsAvailable: diagnostics.available };
}
const developmentUrl = app.isPackaged ? undefined : process.env.LOCAL_CODE_DEV_URL;
let win: BrowserWindow | undefined, store: Store;
let tasks: TaskSummary[] = [];
// Full objects live only while executing, queued, saving or held by an operation.
const residentTasks = new Map<string, Task>();
function readTask(id: string) {
  let task = residentTasks.get(id);
  if (!task) { task = store.task(id); residentTasks.set(id, task); }
  return task;
}
function releaseTasks() {
  for (const [id, task] of residentTasks) if (!busyStatuses.includes(task.status) && !projectLocks.has(task.projectId) && !store.hasPending(id)) residentTasks.delete(id);
}
let active: { task: Task; worker: UtilityProcess; timer?: ReturnType<typeof setTimeout>; pids: Set<number> } | undefined;
let modelOperation = false, quitting = false, storageFailed = false;
let session: SessionStore;
let closingProjectIds: string[] = [];
let evaluation: EvaluationController;
const configs = new Map<string, Settings>();
const projectLocks = new Set<string>();
const rollbackTokens = new Map<string, { taskId: string; runId: string; path: string; afterVersion: string; expires: number }>();
const currentRun = (task: Task) => task.runs?.find(r => r.id === task.currentRunId);
function syncRun(task: Task) { const run = currentRun(task); if (run) { run.status = task.status; run.error = task.error; if (!busyStatuses.includes(task.status)) { run.endedAt ??= Date.now(); if (run.progress) run.progress.endedAt ??= run.endedAt; } } }
function progress(task: Task, phase: Progress['phase']) { const run = currentRun(task); if (run) { run.progress = { ...run.progress, phase, since: Date.now(), endedAt: undefined }; diagnostics.record({ event: 'task_phase', taskId: task.id, runId: run.id, phase }); } }
const uuid = z.string().uuid();
function settings(): Settings {
  const saved = store.settings();
  if (saved.token.startsWith('encrypted:')) {
    try { saved.token = safeStorage.decryptString(Buffer.from(saved.token.slice(10), 'base64')); }
    catch { saved.token = ''; }
  }
  return saved;
}
const taskRevisions = new Map<string, number>();
const liveSummaries = new WeakMap<Task, TaskSummary>();
function summary(saved: TaskSummary) {
  const task = residentTasks.get(saved.id), revision = taskRevisions.get(saved.id) || 0;
  if (!task || saved.revision === revision) return saved;
  const cached = liveSummaries.get(task);
  if (cached?.revision === revision) return cached;
  const value = taskSummary(task, revision); liveSummaries.set(task, value); return value;
}
function replaceSummary(value: TaskSummary) {
  const index = tasks.findIndex(task => task.id === value.id);
  if (index >= 0) tasks[index] = value; else tasks.unshift(value);
}
const updates = new UpdateBatch((ids, global, sequence) => ({ sequence, tasks: tasks.filter(task => ids.includes(task.id)).map(summary), activeId: active?.task.id,
  ...(global ? { projects: store.projects(), settings: settings(), evaluations: evaluation?.reports() || [] } : {}) }),
  update => { if (win && !win.isDestroyed()) win.webContents.send('app:update', update); });
const replies = new ReplyStream(frame => { if (win && !win.isDestroyed()) win.webContents.send('task:delta', frame); });
function snapshot(): Snapshot { return { sequence: updates.sequence, projects: store.projects(), tasks: tasks.map(summary), settings: settings(), activeId: active?.task.id, evaluations: evaluation?.reports() || [] }; }
function broadcast(task?: Task, immediate = true) {
  if (task) {
    const revision = (taskRevisions.get(task.id) || 0) + 1; taskRevisions.set(task.id, revision);
    if (immediate) replaceSummary(taskSummary(task, revision));
  }
  updates.queue(task?.id, immediate);
}
function broadcastMetadata(id: string) {
  const revision = (taskRevisions.get(id) || 0) + 1; taskRevisions.set(id, revision);
  replaceSummary({ ...store.summary(id), revision }); updates.queue(id, true);
}
function storageFailure(task: Task, error: unknown) {
  storageFailed = true;
  diagnostics.record({ event: 'ipc_error', errorCategory: errorCategory(error) });
  if (active?.task.id === task.id) {
    const previous = active; active = undefined;
    clearTimeout(previous.timer); killProcesses(previous.pids); previous.worker.kill();
  }
  configs.delete(task.id); task.approval = undefined; task.status = 'failed';
  task.error = '任务记录保存失败，已停止执行。请检查磁盘空间和数据目录权限后重试。';
  replies.end(task.id); syncRun(task); broadcast(task);
}
function persist(task: Task, durability: 'immediate' | 'deferred' = 'immediate', runId = task.currentRunId, notify = true) {
  residentTasks.set(task.id, task);
  syncRun(task);
  if (durability === 'deferred') store.deferTask(task, runId, error => storageFailure(task, error));
  else {
    try { store.putTask(task, runId); storageFailed = false; }
    catch (error) { storageFailure(task, error); throw error; }
  }
  if (notify) broadcast(task, durability === 'immediate');
  releaseTasks();
}
function idleRequired() { if (evaluation?.busy) throw new Error('模型能力实测正在运行，请先停止或完成实测'); if (modelOperation || tasks.some(t => busyStatuses.includes(t.status))) throw new Error('请先停止或完成运行中和排队中的任务，再调整模型或设置'); }
function killProcesses(pids: Set<number>) { for (const pid of pids) { try { process.kill(-pid, 'SIGKILL'); } catch {} } }
function finish(task: Task, status: Task['status'], error?: string) {
  if (!active || active.task.id !== task.id) return;
  const previous = active;
  replies.end(task.id);
  clearTimeout(previous.timer); killProcesses(previous.pids);
  task.status = status; task.error = error; task.approval = undefined;
  diagnostics.record({ event: 'task_finished', taskId: task.id, runId: task.currentRunId, status, ...(error ? { errorCategory: errorCategory(error) } : {}) });
  active = undefined; configs.delete(task.id); previous.worker.kill();
  try { persist(task); } catch { return; }
  setImmediate(pump);
}
function pump() {
  if (active || modelOperation || evaluation?.busy || quitting || storageFailed) return;
  const queued = tasks.filter(t => t.status === 'queued').sort((a, b) => (a.queuedAt || a.createdAt) - (b.queuedAt || b.createdAt))[0];
  if (!queued) return;
  const task = readTask(queued.id);
  const project = store.projects().find(p => p.id === task.projectId);
  if (!project) { task.status = 'failed'; task.error = '项目不存在'; try { persist(task); } catch { return; } setImmediate(pump); return; }
  try {
    task.status = 'running'; task.error = undefined;
    progress(task, 'preparing');
    const payload = workerInput(task), messageUpdates = new MessagePatchReceiver(payload.archiveLength);
    const worker = utilityProcess.fork(path.join(__dirname, 'worker.cjs'), [], { serviceName: 'Jalo Task', stdio: 'pipe' });
    active = { task, worker, pids: new Set() };
    diagnostics.record({ event: 'task_started', taskId: task.id, runId: task.currentRunId });
    worker.on('message', (event: WorkerEvent) => {
      if (active?.worker !== worker || quitting || event.runId !== task.currentRunId) return;
      try {
        const run = currentRun(task);
        if (event.type === 'context') { if (run) { run.contextUsage = event.usage; persist(task, 'deferred'); } return; }
        if (event.type === 'progress') {
          if (run && run.progress?.phase !== 'stopping' && !task.approval) {
            if (event.progress.phase === 'waiting_model') replies.start(task.id, run.id);
            run.progress = event.progress; persist(task, 'deferred');
            diagnostics.record({ event: 'task_phase', taskId: task.id, runId: run.id, phase: event.progress.phase, step: event.progress.step, tool: event.progress.tool });
          }
          return;
        }
        if (event.type === 'checkpoint') {
          if (!run || run.mode !== 'execute' || event.checkpoint.runId !== run.id) return;
          const index = run.changes.findIndex(c => c.path === event.checkpoint.path);
          if (index < 0) run.changes.push(event.checkpoint); else run.changes[index] = event.checkpoint;
          try { persist(task); worker.postMessage({ type: 'checkpoint-ack', id: event.checkpoint.id }); }
          catch (e) { diagnostics.record({ event: 'checkpoint_error', taskId: task.id, runId: run.id, errorCategory: errorCategory(e) }); worker.postMessage({ type: 'checkpoint-ack', id: event.checkpoint.id, error: '检查点保存失败，禁止写入' }); }
          return;
        }
        if (event.type === 'check' && run) run.checks.push(event.check);
        if (event.type === 'process') { if (event.running) { active.pids.add(event.pid); if (run?.progress?.phase !== 'stopping') { progress(task, 'command'); persist(task, 'deferred'); } } else { active.pids.delete(event.pid); fileNameIndex.clear(project.path); } return; }
        if (event.type === 'delta') { replies.append(task.id, task.currentRunId!, event.text); return; }
        if (event.type === 'message-patch') {
          let changed: boolean;
          try { changed = messageUpdates.apply(task, event); }
          catch (error) { finish(task, 'failed', (error as Error).message); return; }
          if (changed) persist(task, 'deferred', task.currentRunId, false);
          return;
        }
        if (event.type === 'event') { task.events.push(event.event); if (event.event.role === 'assistant') replies.end(task.id); if (event.event.kind === 'error') diagnostics.record({ event: 'tool_error', taskId: task.id, runId: task.currentRunId, errorCategory: errorCategory(event.event.text) }); }
        if (event.type === 'change') { fileNameIndex.clear(project.path); if (run && event.checkpoint) { const i = run.changes.findIndex(c => c.path === event.checkpoint!.path); if (i < 0) run.changes.push(event.checkpoint); else run.changes[i] = event.checkpoint; } const index = task.changes.findIndex(c => c.path === event.change.path); if (index < 0) task.changes.push(event.change); else task.changes[index] = event.change; }
        if (event.type === 'approval') { if (run?.progress?.phase === 'stopping') return; task.approval = event.approval; task.status = 'waiting'; progress(task, 'approval'); }
        if (event.type === 'approval-resolved') { task.approval = undefined; task.status = 'running'; if (run?.progress?.phase !== 'stopping') progress(task, 'tool'); }
        if (event.type === 'done') { if (run?.mode === 'plan' && event.status === 'completed' && event.result?.trim()) run.planText = event.result; task.lastRun = event.evidence; finish(task, event.status, event.error); return; }
        persist(task, ['change', 'approval', 'approval-resolved'].includes(event.type) ? 'immediate' : 'deferred');
      } catch (error) { storageFailure(task, error); }
    });
    let stderr = '';
    worker.stderr?.on('data', data => { stderr = (stderr + data.toString()).slice(-3000); });
    worker.on('exit', code => { if (active?.worker === worker) { diagnostics.record({ event: 'worker_exit', taskId: task.id, runId: task.currentRunId, exitCode: code }); finish(task, 'interrupted', `任务进程意外退出（${code}）。${stderr.slice(-500)} 请检查修改后手动继续。`); } });
    worker.on('spawn', () => {
      if (active?.worker !== worker || quitting) return;
      try { worker.postMessage({ type: 'start', input: payload.input, root: project.path, backupDir: path.join(app.getPath('userData'), 'backups', task.id), settings: configs.get(task.id) || settings() }); }
      catch (error) { finish(task, 'failed', (error as Error).message); }
    });
    persist(task);
  } catch (error) {
    if (storageFailed) return;
    if (active?.task.id === task.id) finish(task, 'failed', (error as Error).message);
    else { task.status = 'failed'; task.error = (error as Error).message; try { persist(task); } catch { return; } setImmediate(pump); }
  }
}
function register(channel: string, handler: (...args: any[]) => unknown) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('无效的调用来源');
    try { return await handler(...args); }
    catch (error) {
      diagnostics.record({ event: 'ipc_error', channel, errorCategory: errorCategory(error) });
      if (error instanceof z.ZodError) {
        const labels: Record<string, string> = { maxTokens: '最大输出 Token（128–16384）', contextLength: '上下文长度（4096–262144）', temperature: '温度（0–2）', maxSteps: '最大执行步数（1–100）', commandTimeout: '命令超时（1–600 秒）', baseUrl: '服务地址', prompt: '任务要求' };
        const issue = error.issues[0], key = String(issue.path[0] || '');
        throw new Error(issue.code === 'custom' ? issue.message : `请检查${labels[key] || key || '输入参数'}，当前值不符合要求`);
      }
      throw error;
    }
  });
}
function registerApi() {
  const validateView = (raw: unknown) => {
    const view = viewSchema.parse(raw);
    const ids = quitting ? closingProjectIds : store.projects(true).map(p=>p.id);
    if (view.projectId && !ids.includes(view.projectId)) throw new Error('草稿所属项目不存在');
    if (view.taskId && !tasks.some(t=>t.id===view.taskId && t.projectId===view.projectId)) throw new Error('草稿所属任务与项目不匹配');
    return view;
  };
  register('session:load', () => session.read());
  register('session:save', (raw: unknown) => session.save(validateView(raw)));
  ipcMain.on('session:flush', (event, raw: unknown) => {
    try {
      if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('无效的调用来源');
      session.update(validateView(raw)); session.flush(); event.returnValue = { ok:true };
    } catch { event.returnValue = { ok:false, error:'会话状态保存失败，请检查数据目录权限和磁盘空间' }; }
  });
  register('evaluation:start', () => { idleRequired(); if (projectLocks.size) throw new Error('项目正在提交或回退，请稍后实测'); return evaluation.start(settings()); });
  register('evaluation:stop', (id: unknown) => evaluation.stop(uuid.parse(id)));
  register('app:snapshot', snapshot);
  register('app:info', appInfo);
  register('app:open-link', async (raw: unknown) => {
    const url = webLink(z.string().max(8192).parse(raw));
    if (!url) throw new Error('仅支持不含账号密码的 HTTP/HTTPS 网页链接');
    await shell.openExternal(url);
  });
  register('app:copy-text', (raw: unknown) => clipboard.writeText(z.string().max(1000000).parse(raw)));
  register('app:open-data', async () => {
    const error = await shell.openPath(app.getPath('userData'));
    if (error) throw new Error('无法打开数据目录，请复制设置中显示的路径，在 Finder 中前往该文件夹');
  });
  register('app:export-diagnostics', async () => {
    if (exportingDiagnostics) throw new Error('诊断日志正在导出，请稍候');
    exportingDiagnostics = true;
    try {
      const selection = await dialog.showSaveDialog(win!, { title: '导出诊断日志', defaultPath: `Jalo-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, filters: [{ name: '诊断日志 JSON', extensions: ['json'] }] });
      if (selection.canceled || !selection.filePath) return null;
      const recent = tasks.slice(0, 50).map(task => residentTasks.get(task.id) || store.view(task.id));
      await saveDiagnosticReport(selection.filePath, diagnosticReport(appInfo(), recent, diagnostics, tasks.length), app.getPath('userData'));
      diagnostics.record({ event: 'diagnostics_exported' });
      return selection.filePath;
    } finally { exportingDiagnostics = false; }
  });
  register('project:add', async () => {
    const result = await dialog.showOpenDialog(win!, { title: '选择项目文件夹', properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    const root = await fs.realpath(result.filePaths[0]);
    const existing = store.projects(true).find(p => p.path === root);
    if (existing) { if (existing.removedAt) { delete existing.removedAt; store.putProject(existing); broadcast(); } return existing; }
    const project = { id: randomUUID(), name: path.basename(root), path: root };
    store.putProject(project); broadcast(); return project;
  });
  register('project:remove', (raw: unknown) => {
    const id = uuid.parse(raw), project = store.projects().find(p => p.id === id);
    if (!project) throw new Error('项目不存在或已移除');
    if (projectLocks.has(id) || tasks.some(t => t.projectId === id && busyStatuses.includes(t.status))) throw new Error('项目存在运行中、等待确认或排队任务，请先停止任务再移除');
    store.putProject({ ...project, removedAt: Date.now() }); broadcast();
    fileNameIndex.clear(project.path);
  });
  register('task:rename', (raw: unknown) => {
    const input = z.object({ taskId: uuid, title: z.string().trim().min(1).max(100) }).strict().parse(raw);
    const task = tasks.find(t => t.id === input.taskId); if (!task) throw new Error('任务不存在');
    const resident = residentTasks.get(task.id);
    if (resident) { resident.title = input.title; persist(resident); }
    else { store.updateMetadata(task.id, { title: input.title }); broadcastMetadata(task.id); }
  });
  register('task:archive', (raw: unknown) => {
    const input = z.object({ taskId: uuid, archived: z.boolean() }).strict().parse(raw);
    const task = tasks.find(t => t.id === input.taskId); if (!task) throw new Error('任务不存在');
    if (projectLocks.has(task.projectId) || busyStatuses.includes(task.status)) throw new Error('请先停止或完成任务，再归档或恢复');
    const archivedAt = input.archived ? task.archivedAt ?? Date.now() : undefined;
    const resident = residentTasks.get(task.id);
    if (resident) { resident.archivedAt = archivedAt; persist(resident); }
    else { store.updateMetadata(task.id, { archivedAt }); broadcastMetadata(task.id); }
  });
  register('task:detail', (raw: unknown) => {
    const id = uuid.parse(raw), task = residentTasks.get(id), revision = taskRevisions.get(id) || 0;
    return task ? taskDetail(task, revision, replies.snapshot(id)) : { ...store.detail(id, revision), stream: replies.snapshot(id) };
  });
  register('tasks:search', (raw: unknown) => {
    const input = z.object({ projectId: uuid, archived: z.boolean(), query: z.string().max(100000) }).strict().parse(raw);
    const resident = [...residentTasks.values()], ids = new Set(store.search(input.projectId, input.archived, input.query));
    for (const task of resident) ids.delete(task.id);
    for (const id of searchTaskIds(resident, input.projectId, input.archived, input.query)) ids.add(id);
    return tasks.filter(task => ids.has(task.id)).map(task => task.id);
  });
  register('task:events', (raw: unknown) => {
    const cursor = z.string().min(1).max(200).optional();
    const input = z.object({ taskId: uuid, before: cursor, after: cursor, around: cursor }).strict()
      .refine(value => [value.before, value.after, value.around].filter(id => id !== undefined).length <= 1, '历史记录游标只能指定一个方向').parse(raw);
    const task = residentTasks.get(input.taskId);
    const direction = input.around !== undefined ? { around: input.around } : input.after !== undefined ? { after: input.after } : { before: input.before };
    return task ? pageTaskEvents(task, direction) : store.events(input.taskId, direction);
  });
  register('settings:save', (raw: unknown) => {
    idleRequired(); const value = settingsSchema.parse(raw);
    if (value.token) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥存储不可用，无法保存访问令牌');
      value.token = 'encrypted:' + safeStorage.encryptString(value.token).toString('base64');
    }
    store.putSettings(value); broadcast();
  });
  register('models:list', () => new LMStudioProvider(settings()).list());
  register('models:load', async (key: unknown) => {
    idleRequired(); const modelKey = z.string().min(1).max(300).parse(key); modelOperation = true;
    try { const config = settings(), provider = new LMStudioProvider(config); const model = (await provider.list()).find(m => m.key === modelKey);
      if (!model) throw new Error('模型不存在');
      if (!model.instances.length) await provider.load(modelKey, Math.min(config.contextLength, model.maxContext));
    } finally { modelOperation = false; broadcast(); pump(); }
  });
  register('models:unload', async (id: unknown) => {
    idleRequired(); const instanceId = z.string().min(1).max(300).parse(id); modelOperation = true;
    try { await new LMStudioProvider(settings()).unload(instanceId); } finally { modelOperation = false; broadcast(); pump(); }
  });
  const projectById = (id: string) => { const p = store.projects().find(p => p.id === id); if (!p) throw new Error('项目不存在'); return p; };
  register('files:search', async (raw: unknown) => { const v = z.object({ projectId: uuid, query: z.string().max(200) }).strict().parse(raw); return searchFiles(projectById(v.projectId).path, v.query); });
  register('files:list', async (raw: unknown) => { const v = z.object({ projectId: uuid, path: z.string().min(1).max(1024) }).strict().parse(raw); return listDirectory(projectById(v.projectId).path, v.path); });
  register('files:preview', async (raw: unknown) => { const v = z.object({ projectId: uuid, path: z.string().min(1).max(1024), startLine: z.number().int().min(1).optional() }).strict().parse(raw); return previewFile(projectById(v.projectId).path, v.path, v.startLine); });
  register('files:reference', async (raw: unknown) => { const v = z.object({ projectId: uuid, path: z.string().min(1).max(1024) }).strict().parse(raw); return referenceFile(projectById(v.projectId),v.path); });
  const locateRun = (taskId: string, runId: string) => {
    const task = tasks.find(t => t.id === taskId);
    if (!task || !task.runIds.includes(runId)) throw new Error('历史数据缺少轮次核验，无法进行此操作');
    const resident = residentTasks.get(taskId);
    const run = resident ? resident.runs?.find(run => run.id === runId) : store.run(taskId, runId);
    if (!run) throw new Error('历史数据缺少轮次核验，无法进行此操作');
    return { task, run };
  };
  register('runs:plan', (raw: unknown) => {
    const v = z.object({ taskId: uuid, runId: uuid }).strict().parse(raw), { run } = locateRun(v.taskId, v.runId);
    if (run.mode !== 'plan' || run.status !== 'completed' || !run.planText?.trim()) throw new Error('该计划缺少完整保存的正文，请重新生成计划后执行');
    return run.planText;
  });
  register('changes:patch', (raw: unknown) => {
    const v = z.object({ taskId: uuid, runId: uuid.optional(), path: z.string().min(1).max(1024) }).strict().parse(raw);
    const task = tasks.find(task => task.id === v.taskId); if (!task) throw new Error('任务不存在');
    const changes = v.runId ? locateRun(v.taskId, v.runId).run.changes : residentTasks.get(task.id)?.changes || store.changes(task.id);
    const change = changes.find(change => change.path === v.path); if (!change) throw new Error('修改记录不存在');
    return { patch: change.patch, version: changeView(change).patchVersion };
  });
  register('runs:changes', (raw: unknown) => { const v = z.object({ taskId: uuid, runId: uuid }).strict().parse(raw); return locateRun(v.taskId, v.runId).run.changes; });
  register('rollback:preview', async (raw: unknown) => {
    const v = z.object({ taskId: uuid, runId: uuid, path: z.string().min(1).max(1024) }).strict().parse(raw);
    const { task, run } = locateRun(v.taskId, v.runId);
    if (projectLocks.has(task.projectId) || tasks.some(t => t.projectId === task.projectId && busyStatuses.includes(t.status))) throw new Error('项目有运行中或排队任务，暂不能回退');
    const change = run.changes.find(c => c.path === v.path); if (!change) throw new Error('修改记录不存在');
    const patch = await rollbackPreview(projectById(task.projectId).path, change);
    const token = randomUUID(); for (const [k, entry] of rollbackTokens) if (entry.expires < Date.now()) rollbackTokens.delete(k);
    if (rollbackTokens.size > 100) rollbackTokens.clear();
    rollbackTokens.set(token, { ...v, afterVersion: change.afterVersion, expires: Date.now() + 300000 });
    return { token, patch, path: change.path, createsRecoveryCopy: change.before === null };
  });
  register('rollback:confirm', async (raw: unknown) => {
    const token = uuid.parse(raw), pending = rollbackTokens.get(token); rollbackTokens.delete(token);
    if (!pending || pending.expires < Date.now()) throw new Error('回退预览已过期，请重新预览');
    const located = locateRun(pending.taskId, pending.runId);
    if (projectLocks.has(located.task.projectId) || tasks.some(t => t.projectId === located.task.projectId && busyStatuses.includes(t.status))) throw new Error('项目有运行中或排队任务，暂不能回退');
    const task = readTask(pending.taskId), run = task.runs!.find(run => run.id === pending.runId)!;
    projectLocks.add(task.projectId);
    try {
      const change = run.changes.find(c => c.path === pending.path); if (!change || change.afterVersion !== pending.afterVersion) throw new Error('修改记录已变化，请重新预览');
      await restoreFile(projectById(task.projectId).path, change, path.join(app.getPath('userData'), 'recovery', run.id));
      fileNameIndex.clear(projectById(task.projectId).path);
      change.state = 'reverted'; change.revertedAt = Date.now();
      const total = task.changes.find(c => c.path === change.path);
      if (total && total.after === change.after) {
        if (change.before === null || total.before === change.before) task.changes = task.changes.filter(c => c !== total);
        else { total.after = change.before; total.patch = createTwoFilesPatch(`a/${total.path}`, `b/${total.path}`, total.before || '', total.after); }
      }
      const text = `已安全回退轮次 ${run.id} 的 ${change.path}，后续操作必须重新读取；旧行号和旧工具结果已过期。`;
      task.events.push({ id: randomUUID(), at: Date.now(), kind: 'notice', text, runId: run.id });
      task.messages.push({ role: 'user', content: text });
      if (task.lastRun && task.currentRunId === run.id) task.lastRun.changedFiles = run.changes.filter(c => c.state === 'written' && c.before !== c.after).map(c => c.path);
      persist(task, 'immediate', run.id);
    } finally { projectLocks.delete(task.projectId); releaseTasks(); }
  });
  register('task:submit', async (raw: unknown) => {
    if (evaluation.busy) throw new Error('模型能力实测正在运行，请结束实测后提交任务');
    const input = submitSchema.parse(raw);
    if (projectLocks.has(input.projectId)) throw new Error('项目正在保存或回退，请稍后提交');
    projectLocks.add(input.projectId);
    try {
    if (modelOperation) throw new Error('模型正在加载或卸载，请稍后创建任务');
    const config = settings(); if (!config.model) throw new Error('请先在模型设置中选择默认模型');
    const project = store.projects().find(p => p.id === input.projectId); if (!project) throw new Error('请先选择项目');
    await fs.access(project.path);
    let task = input.taskId ? readTask(input.taskId) : undefined;
    if (input.taskId && !task) throw new Error('任务不存在');
    if (task?.archivedAt) throw new Error('请先恢复已归档任务，再继续对话');
    if (task && (busyStatuses.includes(task.status) || task.projectId !== input.projectId)) throw new Error('该任务尚未结束或不属于当前项目');
    const references = await captureReferences(project, input.references);
    const plan = input.planRunId ? task?.runs?.find(r => r.id === input.planRunId && r.mode === 'plan' && r.status === 'completed') : undefined;
    if (input.planRunId && (!plan || input.mode !== 'execute')) throw new Error('只能执行已完成且属于当前任务的计划');
    const review = input.reviewRunId ? task?.runs?.find(r => r.id === input.reviewRunId) : undefined;
    if (input.mode === 'review' && (!review || busyStatuses.includes(review.status))) throw new Error('请先选择已有核验记录且已结束的轮次进行审查');
    if (input.reviewRunId && input.mode !== 'review') throw new Error('审查轮次只用于审查模式');
    // Re-read planned file paths now. Never reuse a plan's old line ranges.
    const plannedFiles = plan ? [...new Set(plan.references.map(r => r.path))] : [];
    const planContext = plan ? linkedPlanContext(plan, plannedFiles) : '';
    for (const file of plannedFiles) await referenceFile(project, file);
    if (!task) {
      task = { id: randomUUID(), projectId: project.id, title: input.prompt.slice(0, 50), model: config.model, status: 'queued', createdAt: Date.now(), messages: [], events: [], changes: [] };
    }
    if (['interrupted', 'cancelled', 'failed'].includes(task.status)) task.messages.push({ role: 'assistant', content: '上一轮未正常完成，可能已有部分文件修改或命令执行。请先检查当前状态，不要自动重放历史工具调用。' });
    const run: Run = { id: randomUUID(), taskId: task.id, mode: input.mode, input: input.prompt, createdAt: Date.now(), status: 'queued', references, changes: [], checks: [], planRunId: input.planRunId, reviewRunId: input.reviewRunId };
    task.runs ??= []; task.runs.push(run); task.currentRunId = run.id; task.mode = input.mode;
    progress(task, 'queued');
    let context = referenceContext(references);
    context += planContext;
    if (review) { const patches = review.changes.filter(c => c.state === 'written').map(c => c.patch).join('\n'); context += `\n审查目标轮次：${review.id}，原始要求：${review.input}。show_changes 只返回该轮实际差异。已回退和未核验检查点不视为现有改动。\n${patches.slice(0, 24000)}${patches.length > 24000 ? '\n差异已截断，请读取相关文件继续检查。' : ''}`; }
    task.messages.push({ role: 'user', content: input.prompt + (context ? '\n\n' + context : '') });
    task.events.push({ id: randomUUID(), at: Date.now(), kind: 'message', role: 'user', text: input.prompt, runId: run.id });
    task.model = config.model; task.status = 'queued'; task.queuedAt = Date.now(); task.error = undefined; task.approval = undefined; task.lastRun = undefined;
    configs.set(task.id, config); persist(task); diagnostics.record({ event: 'task_queued', taskId: task.id, runId: run.id }); pump(); return task.id;
    } finally { projectLocks.delete(input.projectId); releaseTasks(); }
  });
  register('task:stop', (id: unknown) => {
    const task = readTask(uuid.parse(id));
    if (active?.task.id === task.id) {
      if (currentRun(task)?.progress?.phase !== 'stopping') progress(task, 'stopping');
      task.approval = undefined; task.status = 'running'; persist(task);
      active.worker.postMessage({ type: 'cancel' });
      if (!active.timer) active.timer = setTimeout(() => finish(task, 'cancelled'), 4000);
    } else if (task.status === 'queued') { task.status = 'cancelled'; configs.delete(task.id); persist(task); }
    releaseTasks();
  });
  register('task:approve', (raw: unknown) => {
    const value = z.object({ taskId: uuid, approvalId: uuid, allow: z.boolean() }).strict().parse(raw);
    if (!active || active.task.id !== value.taskId || active.task.approval?.id !== value.approvalId) throw new Error('命令确认已过期');
    active.task.approval = undefined; active.task.status = 'running';
    if (currentRun(active.task)?.progress?.phase !== 'stopping') progress(active.task, 'tool');
    const worker = active.worker;
    persist(active.task);
    worker.postMessage({ type: 'approve', id: value.approvalId, allow: value.allow });
  });
}
async function createWindow() {
  win = new BrowserWindow({ width: 1440, height: 940, minWidth: 1080, minHeight: 720, title: 'Jalo', titleBarStyle: 'hiddenInset', backgroundColor: '#f8f9fb',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  win.webContents.on('render-process-gone', (_event, details) => diagnostics.record({ event: 'renderer_gone', exitCode: details.exitCode }));
  win.webContents.on('did-fail-load', (_event, code) => diagnostics.record({ event: 'renderer_load_failed', exitCode: code }));
  win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  if (app.isPackaged) await win.loadFile(path.join(__dirname, '../renderer/index.html'));
  else {
    if (!developmentUrl || new URL(developmentUrl).hostname !== '127.0.0.1') throw new Error('请使用 npm run dev 启动开发版');
    await win.loadURL(developmentUrl);
  }
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { win?.show(); win?.focus(); });
  app.whenReady().then(async () => {
    diagnostics.record({ event: 'app_start' });
    store = await Store.open(path.join(app.getPath('userData'), 'local-code.sqlite'));
    session = new SessionStore(path.join(app.getPath('userData'), 'ui-session.json'));
    evaluation = new EvaluationController(store, () => utilityProcess.fork(path.join(__dirname, 'worker.cjs'), [], { serviceName: 'Jalo Model Evaluation', stdio: 'pipe' }), broadcast, app.getVersion());
    tasks = store.summaries(); registerApi();
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Jalo', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit', label: '退出' }] }, { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] }, { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }] }]));
    await createWindow();
    diagnostics.record({ event: 'app_ready' });
  }).catch(error => { diagnostics.record({ event: 'startup_error', errorCategory: errorCategory(error) }); dialog.showErrorBox('启动失败', error.message); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    if (quitting) return; quitting = true;
    updates.dispose(); replies.dispose();
    fileNameIndex.clear();
    if(store)closingProjectIds = store.projects(true).map(p=>p.id);
    try{session?.flush();}catch{diagnostics.record({event:'ipc_error',errorCategory:'permission'});}
    diagnostics.record({ event: 'app_quit' });
    evaluation?.shutdown();
    if (active) { clearTimeout(active.timer); killProcesses(active.pids); active.worker.kill(); }
    if (store) {
      try { for (const summary of tasks.filter(t => busyStatuses.includes(t.status))) { const task = readTask(summary.id); task.status = 'interrupted'; task.approval = undefined; task.error = '应用已退出，请检查修改后手动继续。'; syncRun(task); store.deferTask(task, task.currentRunId); } store.close(); }
      catch (error) { diagnostics.record({ event: 'ipc_error', errorCategory: errorCategory(error) }); dialog.showErrorBox('任务记录保存失败', '退出前未能保存最后的任务记录，请检查磁盘空间和数据目录权限。'); }
    }
  });
}
