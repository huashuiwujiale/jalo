import { DatabaseSync } from 'node:sqlite';
import { metrics } from './performance';
import fs from 'node:fs';
import path from 'node:path';
import type { Project, Task, Settings, Event, Run, RunChange, TaskSummary, TaskDetail, EventCursor, EventPage, RunView } from '../shared/types';
import { defaults, busyStatuses } from '../shared/types';
import { endEvaluation, type EvaluationReport } from '../shared/evaluation';
import { historyPageSize, recoverPlanText } from '../shared/task-history';
import { changeView, requestTexts, runView, taskSummary } from '../shared/task-wire';

type StoredTask = Omit<Task, 'events' | 'runs'> & { historyLength: number; runIds?: string[] };
type StoredRun = Omit<Run, 'changes'> & { changeIds: string[] };
type PendingTask = { task: Task; runIds?: Set<string>; onError?: (error: Error) => void };
type HistoryHead = { length: number; lastId?: string };
export const taskSaveDelay = 200;

export class Store {
  private pending = new Map<string, PendingTask>();
  private records = new Map<string, { table: string; id: string; value: unknown }>();
  private metadata = new Map<string, { title?: string; archivedAt?: number }>();
  private timer?: ReturnType<typeof setTimeout>;
  private heads = new Map<string, HistoryHead>();
  private knownRuns = new Map<string, string>();
  private runViews = new WeakMap<Run, RunView>();
  private constructor(private db: DatabaseSync) {}
  static async open(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const existing = fs.existsSync(file);
    if (!existing) fs.closeSync(fs.openSync(file, 'wx', 0o600));
    fs.chmodSync(file, 0o600);
    const db = new DatabaseSync(file), store = new Store(db);
    let transaction = false;
    try {
      db.exec('PRAGMA busy_timeout=1000');
      const revision = Number(db.prepare('PRAGMA user_version').get()!.user_version);
      if (revision > 7) throw new Error('数据库版本高于当前应用，请使用较新版本打开');
      if (revision < 7 && existing) {
        const backup = file + `.before-v${revision < 2 ? 2 : revision < 3 ? 3 : revision < 4 ? 4 : revision < 5 ? 5 : revision < 6 ? 6 : 7}-` + Date.now() + '.bak';
        // A raw copy preserves legacy bytes. An existing WAL needs a consistent
        // SQLite snapshot so committed pages outside the main file are included.
        if (fs.existsSync(file + '-wal') && fs.statSync(file + '-wal').size) db.prepare('VACUUM INTO ?').run(backup);
        else fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(backup, 0o600);
        const saved = fs.openSync(backup, 'r'); try { fs.fsyncSync(saved); } finally { fs.closeSync(saved); }
        const directory = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      }
      const mode = db.prepare('PRAGMA journal_mode=WAL').get()!.journal_mode;
      if (mode !== 'wal') throw new Error('数据库无法启用 WAL，请检查数据目录');
      db.exec('PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=1000; PRAGMA journal_size_limit=16777216; PRAGMA cache_size=-8192');
      db.exec('BEGIN IMMEDIATE'); transaction = true;
      db.exec('CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
      db.exec('CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS evaluations (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
      db.exec('CREATE TABLE IF NOT EXISTS task_events (task_id TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (task_id,seq), UNIQUE (task_id,id))');
      db.exec('CREATE TABLE IF NOT EXISTS task_catalog (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, archived INTEGER NOT NULL, title TEXT NOT NULL, data TEXT NOT NULL, view TEXT NOT NULL, requests TEXT NOT NULL, recovery INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS task_catalog_project ON task_catalog(project_id,archived)');
      for (const report of store.evaluations()) if (report.status === 'running') store.saveEvaluation(endEvaluation(report, 'interrupted', '应用退出时实测未完成，请手动重新测试'));
      // A migration reads one task at a time. Normal startup only hydrates tasks
      // with unfinished runs/checkpoints, never all completed history.
      const ids = db.prepare(revision < 6 ? 'SELECT id FROM tasks' : 'SELECT id FROM task_catalog WHERE recovery=1').all();
      for (const { id } of ids) {
        const task = store.task(String(id));
        let changed = revision < 6;
        if (revision < 4) {
          if (task.events.length === 600) task.historyIncomplete = true;
          for (const run of task.runs || []) if (run.mode === 'plan' && run.status === 'completed' && run.planText === undefined) run.planText = recoverPlanText(task, run);
        }
        if (!task.runs?.length && !task.legacy) { task.legacy = true; changed = true; }
        for (const run of task.runs || []) {
          if (busyStatuses.includes(run.status)) { run.status = 'interrupted'; run.endedAt = Date.now(); changed = true; }
          if (run.progress && !busyStatuses.includes(run.status) && !run.progress.endedAt) { run.progress.endedAt = run.endedAt || Date.now(); changed = true; }
          for (const change of run.changes) if (change.state === 'prepared') { change.state = 'uncertain'; changed = true; }
        }
        if (busyStatuses.includes(task.status)) {
          task.status = 'interrupted'; task.approval = undefined; task.error = '应用退出时任务未完成。请查看已产生的修改，补充指令后手动继续。'; changed = true;
        }
        if (changed) { store.enqueue(task); store.writeTasks(); store.pending.clear(); }
      }
      if (revision < 7) db.exec('PRAGMA user_version = 7');
      db.exec('COMMIT'); transaction = false;
      if (revision < 5) db.exec('VACUUM'); // Reclaim nested history copies removed by migration.
      return store;
    } catch (error) {
      if (transaction) try { db.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ }
      db.close(); throw error;
    }
  }
  private all<T>(table: string): T[] {
    const result: T[] = [];
    for (const { data } of this.db.prepare(`SELECT data FROM ${table}`).iterate()) result.push(JSON.parse(String(data)));
    return result;
  }
  private write(table: string, id: string, value: unknown) {
    this.db.prepare(`INSERT INTO ${table} (id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE data<>excluded.data`).run(id, JSON.stringify(value));
  }
  private put(table: string, id: string, value: unknown) { this.records.set(`${table}:${id}`, { table, id, value }); this.flush(); }
  projects(includeRemoved = false) { return this.all<Project>('projects').filter(p => includeRemoved || !p.removedAt); }
  private get<T>(table: string, id: string): T | undefined {
    const data = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id)?.data;
    return data === undefined ? undefined : JSON.parse(String(data));
  }
  /** Explicit full reads are reserved for execution, rollback and migration. */
  task(id: string): Task {
    const row = this.get<Task | StoredTask>('tasks', id);
    if (!row) throw new Error('任务不存在');
    if (!('historyLength' in row)) return row;
    const { historyLength, runIds, ...data } = row;
    const events = this.readEvents(id, 0, historyLength);
    return { ...data, events, ...(runIds ? { runs: runIds.map(runId => this.run(id, runId)) } : {}) };
  }
  tasks(): Task[] { return this.db.prepare('SELECT id FROM tasks').all().map(({ id }) => this.task(String(id))).sort((a, b) => b.createdAt - a.createdAt); }
  summaries(): TaskSummary[] { return this.all<TaskSummary>('task_catalog').sort((a, b) => b.createdAt - a.createdAt); }
  summary(id: string): TaskSummary {
    const summary = this.get<TaskSummary>('task_catalog', id);
    if (!summary) throw new Error('任务不存在');
    return summary;
  }
  run(taskId: string, runId: string): Run {
    const row = this.get<Run | StoredRun>('runs', runId);
    if (!row || row.taskId !== taskId) throw new Error('任务轮次记录不完整，请保留数据库并检查备份');
    this.knownRuns.set(runId, row.taskId);
    if (!('changeIds' in row)) return row;
    const { changeIds, ...data } = row;
    return { ...data, changes: changeIds.map(id => {
      const change = this.get<RunChange>('checkpoints', id);
      if (!change || change.runId !== runId) throw new Error('文件检查点记录不完整，请保留数据库并检查备份');
      return change;
    }) };
  }
  private readEvents(id: string, start: number, end: number): Event[] {
    const statement = this.db.prepare('SELECT seq,data FROM task_events WHERE task_id=? AND seq>=? AND seq<? ORDER BY seq');
    const events: Event[] = [];
    for (const { seq, data } of statement.iterate(id, start, end)) {
      if (Number(seq) !== start + events.length) throw new Error('任务历史记录不完整，请保留数据库并检查备份');
      events.push(JSON.parse(String(data)));
    }
    if (events.length !== end - start) throw new Error('任务历史记录不完整，请保留数据库并检查备份');
    return events;
  }
  events(id: string, cursor: EventCursor = {}): EventPage {
    const total = this.summary(id).eventCount;
    if ([cursor.before, cursor.after, cursor.around].filter(id => id !== undefined).length > 1) throw new Error('历史记录游标只能指定一个方向');
    const anchor = cursor.before ?? cursor.after ?? cursor.around;
    const seq = anchor === undefined ? undefined : this.db.prepare('SELECT seq FROM task_events WHERE task_id=? AND id=?').get(id, anchor)?.seq;
    if (anchor !== undefined && seq === undefined) throw new Error('历史记录游标不存在，请重新打开任务');
    let start: number, end: number;
    if (cursor.after !== undefined) { start = Number(seq) + 1; end = Math.min(total, start + historyPageSize); }
    else if (cursor.around !== undefined) { end = Math.min(total, Math.max(0, Number(seq) - Math.floor(historyPageSize / 2)) + historyPageSize); start = Math.max(0, end - historyPageSize); }
    else { end = seq === undefined ? total : Number(seq); start = Math.max(0, end - historyPageSize); }
    return { events: this.readEvents(id, start, end), start, total, hasMore: start > 0 };
  }
  view(id: string): Omit<TaskDetail, 'revision' | 'events' | 'eventCount'> {
    const value = this.db.prepare('SELECT view FROM task_catalog WHERE id=?').get(id)?.view;
    if (value === undefined) throw new Error('任务不存在');
    return JSON.parse(String(value));
  }
  detail(id: string, revision = 0): TaskDetail {
    const view = this.view(id);
    const page = this.events(id);
    return { ...view, revision, events: page.events, eventCount: page.total };
  }
  search(projectId: string, archived: boolean, query: string): string[] {
    const term = query.trim().toLocaleLowerCase();
    return this.db.prepare('SELECT id FROM task_catalog WHERE project_id=? AND archived=? AND (?=\'\' OR instr(title,?)>0 OR EXISTS (SELECT 1 FROM json_each(task_catalog.requests) WHERE instr(value,?)>0))').all(projectId, Number(archived), term, term, term).map(({ id }) => String(id));
  }
  changes(id: string) { const row = this.get<StoredTask>('tasks', id); if (!row) throw new Error('任务不存在'); return row.changes; }
  hasPending(id: string) { return this.pending.has(id); }
  updateMetadata(id: string, patch: { title?: string; archivedAt?: number }) {
    if (!this.pending.has(id)) this.summary(id);
    this.metadata.set(id, { ...this.metadata.get(id), ...patch }); this.flush();
  }
  private writeMetadata(id: string, patch: { title?: string; archivedAt?: number }) {
    const task = this.get<StoredTask>('tasks', id), summary = this.summary(id);
    if (!task) throw new Error('任务不存在');
    const view = this.view(id);
    const summaryJSON = JSON.stringify({ ...summary, ...patch }), viewJSON = JSON.stringify({ ...view, ...patch });
    this.write('tasks', id, { ...task, ...patch });
    this.db.prepare('UPDATE task_catalog SET data=?,view=?,title=?,archived=? WHERE id=? AND (data<>? OR view<>?)').run(
      summaryJSON, viewJSON, (patch.title ?? task.title).toLocaleLowerCase(), Number(!!('archivedAt' in patch ? patch.archivedAt : task.archivedAt)), id, summaryJSON, viewJSON);
  }
  settings(): Settings { return { ...defaults, ...this.all<Settings>('settings')[0] }; }
  putProject(project: Project) { this.put('projects', project.id, project); }
  private enqueue(task: Task, runId?: string, onError?: PendingTask['onError']) {
    const previous = this.pending.get(task.id);
    const runIds = runId && (!previous || previous.runIds) ? new Set([...(previous?.runIds || []), runId]) : undefined;
    this.pending.set(task.id, { task, runIds, onError: onError || previous?.onError });
  }
  /** Coalesce ordinary updates; retain the latest task until disk save succeeds. */
  deferTask(task: Task, runId?: string, onError?: PendingTask['onError']) {
    this.enqueue(task, runId, onError);
    if (!this.timer) this.timer = setTimeout(() => {
      try { this.flush(); }
      catch { /* flush already notified pending tasks; keep them for a manual retry. */ }
    }, taskSaveDelay);
  }
  /** Critical saves drain pending updates before acknowledging a checkpoint. */
  putTask(task: Task, runId?: string) { this.enqueue(task, runId); this.flush(); }
  private writeTasks() {
    const heads = new Map<string, HistoryHead>(), savedRuns = new Map<string, string>();
    for (const { task, runIds } of this.pending.values()) {
      let head = this.heads.get(task.id);
      if (!head) {
        const row = this.db.prepare('SELECT seq,id FROM task_events WHERE task_id=? ORDER BY seq DESC LIMIT 1').get(task.id);
        head = { length: row ? Number(row.seq) + 1 : 0, lastId: row ? String(row.id) : undefined };
      }
      if (task.events.length < head.length || (head.length && task.events[head.length - 1].id !== head.lastId)) throw new Error('任务历史不能截短或重排，请重新读取完整任务');
      const statement = this.db.prepare('INSERT INTO task_events (task_id,seq,id,data) VALUES (?,?,?,?)');
      for (let i = head.length; i < task.events.length; i++) statement.run(task.id, i, task.events[i].id, JSON.stringify(task.events[i]));
      heads.set(task.id, { length: task.events.length, lastId: task.events.at(-1)?.id });
      const { events, runs, eventCount, userRequests, ...data } = task;
      if (runIds && [...runIds].some(id => !runs?.some(run => run.id === id))) throw new Error('待保存的轮次不存在，拒绝丢失修改');
      this.write('tasks', task.id, { ...data, historyLength: events.length, ...(runs ? { runIds: runs.map(run => run.id) } : {}) });
      for (const run of runs || []) {
        const owner = savedRuns.get(run.id) || this.knownRuns.get(run.id) || this.get<Run | StoredRun>('runs', run.id)?.taskId;
        if (run.taskId !== task.id || (owner && owner !== task.id)) throw new Error('轮次记录不属于当前任务，拒绝覆盖历史');
        if (runIds && !runIds.has(run.id) && owner) continue;
        const { changes, ...data } = run;
        this.write('runs', run.id, { ...data, changeIds: changes.map(change => change.id) });
        for (const change of changes) { if (change.runId !== run.id) throw new Error('检查点不属于当前轮次，拒绝覆盖历史'); this.write('checkpoints', change.id, change); }
        savedRuns.set(run.id, task.id);
      }
      this.writeCatalog(task, runIds);
    }
    return { heads, savedRuns };
  }
  private writeCatalog(task: Task, changedRuns?: Set<string>) {
    const { messages, events, runs, changes, eventCount, userRequests, ...data } = task;
    const views = (runs || []).map(run => {
      let view = this.runViews.get(run);
      if (!view || !changedRuns || changedRuns.has(run.id)) { view = runView(run); this.runViews.set(run, view); }
      return view;
    });
    const view = { ...data, runs: views, changes: changes.map(changeView) };
    const recovery = (!runs?.length && !task.legacy) || busyStatuses.includes(task.status) || views.some(run => busyStatuses.includes(run.status) || (run.progress && !run.progress.endedAt) || run.changes.some(change => change.state === 'prepared'));
    this.db.prepare('INSERT INTO task_catalog (id,project_id,archived,title,data,view,requests,recovery) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,archived=excluded.archived,title=excluded.title,data=excluded.data,view=excluded.view,requests=excluded.requests,recovery=excluded.recovery WHERE data<>excluded.data OR view<>excluded.view OR requests<>excluded.requests OR recovery<>excluded.recovery').run(
      task.id, task.projectId, Number(!!task.archivedAt), task.title.toLocaleLowerCase(), JSON.stringify(taskSummary(task, 0)), JSON.stringify(view), JSON.stringify([...requestTexts(task)].map(text => text.toLocaleLowerCase())), Number(recovery));
  }
  putSettings(settings: Settings) { this.put('settings', 'default', settings); }
  evaluations() { return this.all<EvaluationReport>('evaluations').sort((a, b) => b.createdAt - a.createdAt).slice(0, 10); }
  private saveEvaluation(report: EvaluationReport) {
    this.write('evaluations', report.id, report);
    const keep = new Set(this.evaluations().map(r => r.id));
    for (const old of this.all<EvaluationReport>('evaluations')) if (!keep.has(old.id)) this.db.prepare('DELETE FROM evaluations WHERE id = ?').run(old.id);
  }
  putEvaluation(report: EvaluationReport) { this.put('evaluations', report.id, report); }
  flush() {
    clearTimeout(this.timer); this.timer = undefined;
    if (!this.pending.size && !this.records.size && !this.metadata.size) return;
    let transaction = false;
    const measured = metrics.start('database_commit');
    try {
      this.db.exec('BEGIN IMMEDIATE'); transaction = true;
      const { heads, savedRuns } = this.writeTasks();
      for (const { table, id, value } of this.records.values()) {
        if (table === 'evaluations') this.saveEvaluation(value as EvaluationReport);
        else this.write(table, id, value);
      }
      for (const [id, patch] of this.metadata) this.writeMetadata(id, patch);
      // FULL WAL commits are the durability boundary for checkpoint/approval
      // acknowledgements. No full-database export or per-save checkpoint needed.
      this.db.exec('COMMIT'); transaction = false;
      for (const [id, head] of heads) this.heads.set(id, head);
      for (const [id, owner] of savedRuns) this.knownRuns.set(id, owner);
      for (const [id, patch] of this.metadata) { const pending = this.pending.get(id); if (pending) Object.assign(pending.task, patch); }
      this.pending.clear(); this.records.clear(); this.metadata.clear(); measured();
    } catch (error) {
      if (transaction) try { this.db.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ }
      measured(true);
      // Synchronous saves also drain deferred tasks, so notify them on every failure path.
      const failure = error instanceof Error ? error : new Error(String(error));
      const callbacks = new Set([...this.pending.values()].map(entry => entry.onError));
      for (const callback of callbacks) {
        try { callback?.(failure); }
        catch { /* One observer must not prevent other tasks from stopping. */ }
      }
      throw error;
    }
  }
  close() { this.flush(); this.db.close(); }
}
