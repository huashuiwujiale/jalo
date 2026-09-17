import initSqlJs, { type Database } from 'sql.js';
import fs from 'node:fs';
import path from 'node:path';
import type { Project, Task, Settings } from '../shared/types';
import { defaults, busyStatuses } from '../shared/types';

export class Store {
  private constructor(private db: Database, private file: string) {}
  static async open(file: string) {
    const SQL = await initSqlJs({ locateFile: name => path.join(path.dirname(require.resolve('sql.js')), name) });
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const db = new SQL.Database(fs.existsSync(file) ? fs.readFileSync(file) : undefined);
    const revision = Number(db.exec('PRAGMA user_version')[0]?.values[0]?.[0] || 0);
    if (revision < 2 && fs.existsSync(file)) fs.copyFileSync(file, file + '.before-v2-' + Date.now() + '.bak', fs.constants.COPYFILE_EXCL);
    db.run('CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    db.run('CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY, data TEXT NOT NULL); PRAGMA user_version = 2');
    const store = new Store(db, file);
    for (const task of store.tasks()) {
      if (!task.runs?.length) { task.legacy = true; store.putTask(task); }
      for (const run of task.runs || []) { if (busyStatuses.includes(run.status)) { run.status = 'interrupted'; run.endedAt = Date.now(); } for (const change of run.changes) if (change.state === 'prepared') change.state = 'uncertain'; }
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
  projects() { return this.all<Project>('projects'); }
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
  flush() {
    const temp = this.file + '.tmp';
    const fd = fs.openSync(temp, 'w', 0o600);
    try { fs.writeFileSync(fd, this.db.export()); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, this.file);
  }
  close() { this.flush(); this.db.close(); }
}
