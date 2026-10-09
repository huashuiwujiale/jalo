import { randomUUID } from 'node:crypto';
import { spawn, type IPty } from 'node-pty';
import { CommandOutputWriter } from '../engine/command-output';
import type { Approval, CommandSession } from '../shared/types';

export interface CommandOwner { taskId: string; runId: string; projectId: string }
interface LiveCommand { owner: CommandOwner; record: CommandSession; pty: IPty; stop: () => void; publish: () => void }
/** Main-process ownership lets approved background commands outlive a model worker. */
export class CommandManager {
  private live = new Map<string, LiveCommand>();
  constructor(private update: (owner: CommandOwner, command: CommandSession) => void) {}
  hasTask(taskId: string) { return [...this.live.values()].some(c => c.owner.taskId === taskId); }
  hasProject(projectId: string) { return [...this.live.values()].some(c => c.owner.projectId === projectId); }
  owns(id: string) { return this.live.has(id); }
  private get(owner: Pick<CommandOwner, 'taskId' | 'runId'>, id: string) {
    const session = this.live.get(id);
    if (!session || session.owner.taskId !== owner.taskId || session.owner.runId !== owner.runId) throw new Error('终端会话已结束或不属于当前轮次');
    return session;
  }
  input(owner: CommandOwner, id: string, text: string) {
    if (!text || text.length > 8000 || /[\x00-\x1f\x7f]/.test(text)) throw new Error('终端输入必须是 1–8000 字符的单行文本');
    this.get(owner, id).pty.write(text + '\r');
  }
  resize(owner: CommandOwner, id: string, cols: number, rows: number) {
    if (![cols, rows].every(n => Number.isInteger(n) && n >= 2 && n <= 500)) throw new Error('终端尺寸无效');
    this.get(owner, id).pty.resize(cols, rows);
  }
  stop(owner: CommandOwner, id: string) { this.get(owner, id).stop(); }
  stopTask(taskId: string, includeBackground = true) {
    for (const item of this.live.values()) if (item.owner.taskId === taskId && (includeBackground || !item.record.background)) item.stop();
  }
  shutdown() { for (const item of [...this.live.values()]) item.stop(); }
  snapshot(owner: CommandOwner, id: string) {
    const live = this.get(owner, id); live.publish(); return { ...live.record };
  }
  start(owner: CommandOwner, approval: Approval, directory: string): Promise<string> {
    if (this.live.size >= 8) throw new Error('最多同时运行 8 个终端会话，请先停止不用的进程');
    const record: CommandSession = { id: randomUUID(), command: approval.command, cwd: approval.cwd, startedAt: Date.now(), status: 'running', tty: true, background: !!approval.background };
    const log = new CommandOutputWriter(directory, record.id);
    let pty: IPty;
    try {
      // Persist ownership before launching any process; failures must not execute.
      this.update(owner, { ...record });
      const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'USER'].filter(k => process.env[k]).map(k => [k, process.env[k]!]));
      pty = spawn('/bin/zsh', ['-f', '-c', approval.command], { cwd: approval.cwd, env, name: 'xterm-256color', cols: 100, rows: 30 });
    } catch (error) {
      log.close(); this.update(owner, { ...record, status: 'interrupted', endedAt: Date.now(), tail: String(error) }); throw error;
    }
    return new Promise<string>((resolve, reject) => {
      let ended = false, failure: unknown, stopped = false, publishedBytes = 0;
      const kill = () => { try { process.kill(-pty.pid, 'SIGKILL'); } catch {} pty.kill('SIGKILL'); };
      const publish = () => {
        Object.assign(record, { totalBytes: log.totalBytes, outputBytes: log.bytes, outputTruncated: log.truncated, tail: log.tail });
        this.update(owner, { ...record }); publishedBytes = log.totalBytes;
      };
      const end = (exitCode?: number, signal = 0) => {
        if (ended) return; ended = true; clearTimeout(timeout); clearInterval(flush);
        kill(); this.live.delete(record.id);
        try { log.close(); } catch (error) { failure ??= error; }
        record.status = stopped || signal || failure ? 'interrupted' : 'completed'; record.endedAt = Date.now(); record.exitCode = exitCode;
        try { publish(); } catch (error) { failure ??= error; }
        if (failure) reject(failure);
        else resolve(`命令会话：${record.id}；退出码：${exitCode ?? '未知'}${record.timedOut ? '；已超时终止' : ''}${record.status === 'interrupted' ? '；已中断' : ''}\n${log.tail}`);
      };
      const stop = () => { stopped = true; kill(); end(); };
      const flush = setInterval(() => { if (publishedBytes === log.totalBytes) return; try { publish(); } catch (error) { failure = error; stop(); } }, 1000);
      const timeout = setTimeout(() => { record.timedOut = true; stop(); }, approval.timeout * 1000);
      this.live.set(record.id, { owner, record, pty, stop, publish });
      pty.onData(text => { if (!ended) try { log.append(text); } catch (error) { failure = error; stop(); } });
      pty.onExit(({ exitCode, signal }) => end(exitCode, signal));
      if (approval.background) resolve(`后台命令已启动，尚未完成。会话 ID：${record.id}。使用 command_status 查看状态和末尾输出；可在终端面板确认输入或停止。最长运行 ${approval.timeout} 秒；应用退出时终止。`);
    });
  }
}
