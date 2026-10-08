import initSqlJs, { type Database } from 'sql.js';
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
  private timer?: ReturnType<typeof setTimeout>;
  private dirty = true;
  private heads = new Map<string, HistoryHead>();
  private knownRuns = new Map<string, string>();
  private runViews = new WeakMap<Run, RunView>();
  private constructor(private db: Database, private file: string) {}
  static async open(file: string) {
    const SQL = await initSqlJs({ locateFile: name => path.join(path.dirname(require.resolve('sql.js')), name) });
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const db = new SQL.Database(fs.existsSync(file) ? fs.readFileSync(file) : undefined);
    const store = new Store(db, file);
    try {
      const revision = Number(db.exec('PRAGMA user_version')[0]?.values[0]?.[0] || 0);
      if (revision < 6 && fs.existsSync(file)) fs.copyFileSync(file, file + `.before-v${revision < 2 ? 2 : revision < 3 ? 3 : revision < 4 ? 4 : revision < 5 ? 5 : 6}-` + Date.now() + '.bak', fs.constants.COPYFILE_EXCL);
      db.run('CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
      db.run('CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS evaluations (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
      db.run('CREATE TABLE IF NOT EXISTS task_events (task_id TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (task_id,seq), UNIQUE (task_id,id))');
      db.run('CREATE TABLE IF NOT EXISTS task_catalog (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, archived INTEGER NOT NULL, title TEXT NOT NULL, data TEXT NOT NULL, view TEXT NOT NULL, requests TEXT NOT NULL, recovery INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS task_catalog_project ON task_catalog(project_id,archived)');
      store.dirty = revision < 6;
      for (const report of store.evaluations()) if (report.status === 'running') store.saveEvaluation(endEvaluation(report, 'interrupted', '应用退出时实测未完成，请手动重新测试'));
      // A migration reads one task at a time. Normal startup only hydrates tasks
      // with unfinished runs/checkpoints, never all completed history.
      const ids = db.exec(revision < 6 ? 'SELECT id FROM tasks' : 'SELECT id FROM task_catalog WHERE recovery=1')[0]?.values || [];
      for (const [id] of ids) {
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
      if (revision < 5) {
        db.run('VACUUM'); // Reclaim the nested history copies removed by migration.
        store.dirty = true;
      }
      if (revision < 6) db.run('PRAGMA user_version = 6');
      store.flush(); return store;
    } catch (error) { db.close(); throw error; }
  }
  private all<T>(table: string): T[] {
    const statement = this.db.prepare(`SELECT data FROM ${table}`), result: T[] = [];
    try { while (statement.step()) result.push(JSON.parse(String(statement.get()[0]))); } finally { statement.free(); }
    return result;
  }
  private write(table: string, id: string, value: unknown) {
    this.db.run(`INSERT INTO ${table} (id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE data<>excluded.data`, [id, JSON.stringify(value)]);
    if (this.db.getRowsModified()) this.dirty = true;
  }
  private put(table: string, id: string, value: unknown) { this.write(table, id, value); this.flush(); }
  projects(includeRemoved = false) { return this.all<Project>('projects').filter(p => includeRemoved || !p.removedAt); }
  private get<T>(table: string, id: string): T | undefined {
    const data = this.db.exec(`SELECT data FROM ${table} WHERE id=?`, [id])[0]?.values[0]?.[0];
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
  tasks(): Task[] { return (this.db.exec('SELECT id FROM tasks')[0]?.values || []).map(([id]) => this.task(String(id))).sort((a, b) => b.createdAt - a.createdAt); }
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
    try {
      statement.bind([id, start, end]);
      while (statement.step()) {
        const [seq, data] = statement.get();
        if (Number(seq) !== start + events.length) throw new Error('任务历史记录不完整，请保留数据库并检查备份');
        events.push(JSON.parse(String(data)));
      }
    } finally { statement.free(); }
    if (events.length !== end - start) throw new Error('任务历史记录不完整，请保留数据库并检查备份');
    return events;
  }
  events(id: string, cursor: EventCursor = {}): EventPage {
    const total = this.summary(id).eventCount;
    if ([cursor.before, cursor.after, cursor.around].filter(id => id !== undefined).length > 1) throw new Error('历史记录游标只能指定一个方向');
    const anchor = cursor.before ?? cursor.after ?? cursor.around;
    const seq = anchor === undefined ? undefined : this.db.exec('SELECT seq FROM task_events WHERE task_id=? AND id=?', [id, anchor])[0]?.values[0]?.[0];
    if (anchor !== undefined && seq === undefined) throw new Error('历史记录游标不存在，请重新打开任务');
    let start: number, end: number;
    if (cursor.after !== undefined) { start = Number(seq) + 1; end = Math.min(total, start + historyPageSize); }
    else if (cursor.around !== undefined) { end = Math.min(total, Math.max(0, Number(seq) - Math.floor(historyPageSize / 2)) + historyPageSize); start = Math.max(0, end - historyPageSize); }
    else { end = seq === undefined ? total : Number(seq); start = Math.max(0, end - historyPageSize); }
    return { events: this.readEvents(id, start, end), start, total, hasMore: start > 0 };
  }
  view(id: string): Omit<TaskDetail, 'revision' | 'events' | 'eventCount'> {
    const value = this.db.exec('SELECT view FROM task_catalog WHERE id=?', [id])[0]?.values[0]?.[0];
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
    return (this.db.exec('SELECT id FROM task_catalog WHERE project_id=? AND archived=? AND (?=\'\' OR instr(title,?)>0 OR EXISTS (SELECT 1 FROM json_each(task_catalog.requests) WHERE instr(value,?)>0))', [projectId, Number(archived), term, term, term])[0]?.values || []).map(([id]) => String(id));
  }
  changes(id: string) { const row = this.get<StoredTask>('tasks', id); if (!row) throw new Error('任务不存在'); return row.changes; }
  hasPending(id: string) { return this.pending.has(id); }
  updateMetadata(id: string, patch: { title?: string; archivedAt?: number }) {
    this.flush();
    const task = this.get<StoredTask>('tasks', id), summary = this.summary(id);
    if (!task) throw new Error('任务不存在');
    const view = JSON.parse(String(this.db.exec('SELECT view FROM task_catalog WHERE id=?', [id])[0].values[0][0]));
    const dirty = this.dirty;
    this.db.run('BEGIN');
    try {
      this.write('tasks', id, { ...task, ...patch });
      this.db.run('UPDATE task_catalog SET data=?,view=?,title=?,archived=? WHERE id=?', [JSON.stringify({ ...summary, ...patch }), JSON.stringify({ ...view, ...patch }), (patch.title ?? task.title).toLocaleLowerCase(), Number(!!('archivedAt' in patch ? patch.archivedAt : task.archivedAt)), id]);
      this.dirty = true; this.db.run('COMMIT');
    } catch (error) { this.db.run('ROLLBACK'); this.dirty = dirty; throw error; }
    this.flush();
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
    if (!this.pending.size) return;
    const dirty = this.dirty, heads = new Map<string, HistoryHead>(), savedRuns = new Map<string, string>();
    this.db.run('BEGIN');
    try {
      for (const { task, runIds } of this.pending.values()) {
        let head = this.heads.get(task.id);
        if (!head) {
          const row = this.db.exec('SELECT seq,id FROM task_events WHERE task_id=? ORDER BY seq DESC LIMIT 1', [task.id])[0]?.values[0];
          head = { length: row ? Number(row[0]) + 1 : 0, lastId: row ? String(row[1]) : undefined };
        }
        if (task.events.length < head.length || (head.length && task.events[head.length - 1].id !== head.lastId)) throw new Error('任务历史不能截短或重排，请重新读取完整任务');
        const statement = this.db.prepare('INSERT INTO task_events (task_id,seq,id,data) VALUES (?,?,?,?)');
        try { for (let i = head.length; i < task.events.length; i++) statement.run([task.id, i, task.events[i].id, JSON.stringify(task.events[i])]); }
        finally { statement.free(); }
        if (task.events.length > head.length) this.dirty = true;
        heads.set(task.id, { length: task.events.length, lastId: task.events.at(-1)?.id });
        const { events, runs, eventCount, userRequests, ...data } = task;
        if (runIds && [...runIds].some(id => !runs?.some(run => run.id === id))) throw new Error('待保存的轮次不存在，拒绝丢失修改');
        this.write('tasks', task.id, { ...data, historyLength: events.length, ...(runs ? { runIds: runs.map(run => run.id) } : {}) });
        for (const run of runs || []) {
          const owner = savedRuns.get(run.id) || this.knownRuns.get(run.id) || this.get<Run | StoredRun>('runs', run.id)?.taskId;
          if (run.taskId !== task.id || (owner && owner !== task.id)) throw new Error('轮次记录不属于当前任务，拒绝覆盖历史');
          if (owner) this.knownRuns.set(run.id, owner);
          if (runIds && !runIds.has(run.id) && owner) continue;
          const { changes, ...data } = run;
          this.write('runs', run.id, { ...data, changeIds: changes.map(change => change.id) });
          for (const change of changes) { if (change.runId !== run.id) throw new Error('检查点不属于当前轮次，拒绝覆盖历史'); this.write('checkpoints', change.id, change); }
          savedRuns.set(run.id, task.id);
        }
        this.writeCatalog(task, runIds);
      }
      this.db.run('COMMIT');
      for (const [id, head] of heads) this.heads.set(id, head);
      for (const [id, owner] of savedRuns) this.knownRuns.set(id, owner);
    } catch (error) { this.db.run('ROLLBACK'); this.dirty = dirty; throw error; }
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
    this.db.run('INSERT INTO task_catalog (id,project_id,archived,title,data,view,requests,recovery) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,archived=excluded.archived,title=excluded.title,data=excluded.data,view=excluded.view,requests=excluded.requests,recovery=excluded.recovery WHERE data<>excluded.data OR view<>excluded.view OR requests<>excluded.requests OR recovery<>excluded.recovery',
      [task.id, task.projectId, Number(!!task.archivedAt), task.title.toLocaleLowerCase(), JSON.stringify(taskSummary(task, 0)), JSON.stringify(view), JSON.stringify([...requestTexts(task)].map(text => text.toLocaleLowerCase())), Number(recovery)]);
    if (this.db.getRowsModified()) this.dirty = true;
  }
  putSettings(settings: Settings) { this.put('settings', 'default', settings); }
  evaluations() { return this.all<EvaluationReport>('evaluations').sort((a, b) => b.createdAt - a.createdAt).slice(0, 10); }
  private saveEvaluation(report: EvaluationReport) {
    this.write('evaluations', report.id, report);
    const keep = new Set(this.evaluations().map(r => r.id));
    for (const old of this.all<EvaluationReport>('evaluations')) if (!keep.has(old.id)) { this.db.run('DELETE FROM evaluations WHERE id = ?', [old.id]); this.dirty = true; }
  }
  putEvaluation(report: EvaluationReport) { this.saveEvaluation(report); this.flush(); }
  flush() {
    clearTimeout(this.timer); this.timer = undefined;
    try {
      this.writeTasks();
      if (this.dirty) {
        const temp = this.file + '.tmp';
        const fd = fs.openSync(temp, 'w', 0o600);
        try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, this.db.export()); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(temp, this.file);
        const directory = fs.openSync(path.dirname(this.file), fs.constants.O_RDONLY);
        try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
        this.dirty = false;
      }
      this.pending.clear();
    } catch (error) {
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
