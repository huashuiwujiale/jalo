import initSqlJs, { type Database } from 'sql.js';
import fs from 'node:fs';
import path from 'node:path';
import type { Project, Task, Settings } from '../shared/types';
import { defaults, busyStatuses } from '../shared/types';
import { endEvaluation, type EvaluationReport } from '../shared/evaluation';

export class Store {
  private constructor(private db: Database, private file: string) {}
  static async open(file: string) {
    const SQL = await initSqlJs({ locateFile: name => path.join(path.dirname(require.resolve('sql.js')), name) });
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const db = new SQL.Database(fs.existsSync(file) ? fs.readFileSync(file) : undefined);
    const revision = Number(db.exec('PRAGMA user_version')[0]?.values[0]?.[0] || 0);
    if (revision < 3 && fs.existsSync(file)) fs.copyFileSync(file, file + `.before-v${revision < 2 ? 2 : 3}-` + Date.now() + '.bak', fs.constants.COPYFILE_EXCL);
    db.run('CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    db.run('CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    const store = new Store(db, file);
    db.run('CREATE TABLE IF NOT EXISTS evaluations (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    if (revision < 3) db.run('PRAGMA user_version = 3');
    for (const report of store.evaluations()) if (report.status === 'running') store.putEvaluation(endEvaluation(report, 'interrupted', '应用退出时实测未完成，请手动重新测试'));
    for (const task of store.tasks()) {
      if (!task.runs?.length) { task.legacy = true; store.putTask(task); }
      for (const run of task.runs || []) { if (busyStatuses.includes(run.status)) { run.status = 'interrupted'; run.endedAt = Date.now(); } if (run.progress && !busyStatuses.includes(run.status)) run.progress.endedAt ??= run.endedAt || Date.now(); for (const change of run.changes) if (change.state === 'prepared') change.state = 'uncertain'; }
      if (busyStatuses.includes(task.status)) {
        task.status = 'interrupted'; task.approval = undefined; task.error = '应用退出时任务未完成。请查看已产生的修改，补充指令后手动继续。';
        store.putTask(task);
      } else store.putTask(task);
    }
    store.flush(); return store;
  }
  private all<T>(table: string): T[] {
    const statement = this.db.prepare(`SELECT data FROM ${table}`), result: T[] = [];
    try { while (statement.step()) result.push(JSON.parse(String(statement.get()[0]))); } finally { statement.free(); }
    return result;
  }
  private put(table: string, id: string, value: unknown) { this.db.run(`INSERT OR REPLACE INTO ${table} (id,data) VALUES (?,?)`, [id, JSON.stringify(value)]); this.flush(); }
  projects(includeRemoved = false) { return this.all<Project>('projects').filter(p => includeRemoved || !p.removedAt); }
  tasks() { return this.all<Task>('tasks').sort((a, b) => b.createdAt - a.createdAt); }
  settings(): Settings { return { ...defaults, ...this.all<Settings>('settings')[0] }; }
  putProject(project: Project) { this.put('projects', project.id, project); }
  putTask(task: Task) {
    this.db.run('BEGIN');
    try {
      this.db.run('INSERT OR REPLACE INTO tasks (id,data) VALUES (?,?)', [task.id, JSON.stringify(task)]);
      for (const run of task.runs || []) {
        this.db.run('INSERT OR REPLACE INTO runs (id,data) VALUES (?,?)', [run.id, JSON.stringify(run)]);
        for (const change of run.changes) this.db.run('INSERT OR REPLACE INTO checkpoints (id,data) VALUES (?,?)', [change.id, JSON.stringify(change)]);
      }
      this.db.run('COMMIT');
    } catch (e) { this.db.run('ROLLBACK'); throw e; }
    this.flush();
  }
  putSettings(settings: Settings) { this.put('settings', 'default', settings); }
  evaluations() { return this.all<EvaluationReport>('evaluations').sort((a, b) => b.createdAt - a.createdAt).slice(0, 10); }
  putEvaluation(report: EvaluationReport) {
    this.db.run('INSERT OR REPLACE INTO evaluations (id,data) VALUES (?,?)', [report.id, JSON.stringify(report)]);
    const keep = new Set(this.evaluations().map(r => r.id));
    for (const old of this.all<EvaluationReport>('evaluations')) if (!keep.has(old.id)) this.db.run('DELETE FROM evaluations WHERE id = ?', [old.id]);
    this.flush();
  }
  flush() {
    const temp = this.file + '.tmp';
    const fd = fs.openSync(temp, 'w', 0o600);
    try { fs.writeFileSync(fd, this.db.export()); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, this.file);
  }
  close() { this.flush(); this.db.close(); }
}
