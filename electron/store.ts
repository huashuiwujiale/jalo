import initSqlJs, { type Database } from 'sql.js';
import fs from 'node:fs';
import path from 'node:path';
import type { Project, Task, Settings, Event, Run, RunChange } from '../shared/types';
import { defaults, busyStatuses } from '../shared/types';
import { endEvaluation, type EvaluationReport } from '../shared/evaluation';
import { recoverPlanText } from '../shared/task-history';

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
  private constructor(private db: Database, private file: string) {}
  static async open(file: string) {
    const SQL = await initSqlJs({ locateFile: name => path.join(path.dirname(require.resolve('sql.js')), name) });
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const db = new SQL.Database(fs.existsSync(file) ? fs.readFileSync(file) : undefined);
    const store = new Store(db, file);
    try {
      const revision = Number(db.exec('PRAGMA user_version')[0]?.values[0]?.[0] || 0);
      if (revision < 5 && fs.existsSync(file)) fs.copyFileSync(file, file + `.before-v${revision < 2 ? 2 : revision < 3 ? 3 : revision < 4 ? 4 : 5}-` + Date.now() + '.bak', fs.constants.COPYFILE_EXCL);
      db.run('CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
      db.run('CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS evaluations (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
      db.run('CREATE TABLE IF NOT EXISTS task_events (task_id TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (task_id,seq), UNIQUE (task_id,id))');
      if (revision < 5) db.run('PRAGMA user_version = 5');
      store.dirty = revision < 5;
      for (const row of db.exec('SELECT id,data FROM runs')[0]?.values || []) store.knownRuns.set(String(row[0]), JSON.parse(String(row[1])).taskId);
      for (const report of store.evaluations()) if (report.status === 'running') store.saveEvaluation(endEvaluation(report, 'interrupted', '应用退出时实测未完成，请手动重新测试'));
      for (const task of store.tasks()) {
        let changed = revision < 5;
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
        if (changed) store.enqueue(task);
      }
      if (revision < 5) {
        store.writeTasks(); store.pending.clear();
        db.run('VACUUM'); // Reclaim the nested history copies removed by migration.
        store.dirty = true;
      }
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
  tasks(): Task[] {
    const tasks = this.all<Task | StoredTask>('tasks');
    if (!tasks.some(t => 'historyLength' in t)) return (tasks as Task[]).sort((a, b) => b.createdAt - a.createdAt);
    const runs = new Map(this.all<Run | StoredRun>('runs').map(run => [run.id, run]));
    const checkpoints = new Map(this.all<RunChange>('checkpoints').map(change => [change.id, change]));
    const history = new Map<string, Event[]>();
    const statement = this.db.prepare('SELECT task_id,data FROM task_events ORDER BY task_id,seq');
    try { while (statement.step()) { const [id, data] = statement.get(); const events = history.get(String(id)) || []; events.push(JSON.parse(String(data))); history.set(String(id), events); } }
    finally { statement.free(); }
    return tasks.map(row => {
      if (!('historyLength' in row)) return row;
      const { historyLength, runIds, ...task } = row, events = history.get(row.id) || [];
      if (events.length !== historyLength) throw new Error('任务历史记录不完整，请保留数据库并检查备份');
      const hydrated = runIds?.map(id => {
        const run = runs.get(id); if (!run || run.taskId !== row.id) throw new Error('任务轮次记录不完整，请保留数据库并检查备份');
        if (!('changeIds' in run)) return run;
        const { changeIds, ...data } = run;
        const changes = changeIds.map(key => { const change = checkpoints.get(key); if (!change || change.runId !== run.id) throw new Error('文件检查点记录不完整，请保留数据库并检查备份'); return change; });
        return { ...data, changes };
      });
      return { ...task, events, ...(hydrated ? { runs: hydrated } : {}) };
    }).sort((a, b) => b.createdAt - a.createdAt);
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
          const owner = savedRuns.get(run.id) || this.knownRuns.get(run.id);
          if (run.taskId !== task.id || (owner && owner !== task.id)) throw new Error('轮次记录不属于当前任务，拒绝覆盖历史');
          if (runIds && !runIds.has(run.id) && this.knownRuns.has(run.id)) continue;
          const { changes, ...data } = run;
          this.write('runs', run.id, { ...data, changeIds: changes.map(change => change.id) });
          for (const change of changes) { if (change.runId !== run.id) throw new Error('检查点不属于当前轮次，拒绝覆盖历史'); this.write('checkpoints', change.id, change); }
          savedRuns.set(run.id, task.id);
        }
      }
      this.db.run('COMMIT');
      for (const [id, head] of heads) this.heads.set(id, head);
      for (const [id, owner] of savedRuns) this.knownRuns.set(id, owner);
    } catch (error) { this.db.run('ROLLBACK'); this.dirty = dirty; throw error; }
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
