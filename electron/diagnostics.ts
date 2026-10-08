import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AppInfo, Task } from '../shared/types';

const status = z.enum(['queued','running','waiting','completed','failed','cancelled','interrupted']);
const category = z.enum(['timeout','connection','authentication','context','empty_response','model_loading','tool_call','syntax','file_conflict','file_missing','permission','validation','unknown']);
export function errorCategory(error: unknown): z.infer<typeof category> {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (/超时|timeout/i.test(text)) return 'timeout';
  if (/HTTP 401|HTTP 403|令牌|unauthorized/i.test(text)) return 'authentication';
  if (/无法连接|ECONNREFUSED|fetch failed/i.test(text)) return 'connection';
  if (/上下文|context length|输出达到上限/i.test(text)) return 'context';
  if (/空回复|没有最终回复|没有返回正文/.test(text)) return 'empty_response';
  if (/模型加载|加载模型|out of memory/i.test(text)) return 'model_loading';
  if (/语法/.test(text)) return 'syntax';
  if (/外部修改|冲突|原文|匹配|定位/.test(text)) return 'file_conflict';
  if (/ENOENT|文件不存在/.test(text)) return 'file_missing';
  if (/EACCES|EPERM|权限|越出|越界/.test(text)) return 'permission';
  if (/工具调用|执行依据|实际执行/.test(text)) return 'tool_call';
  if (error instanceof z.ZodError) return 'validation';
  return 'unknown';
}
// Only structured, allowlisted fields reach disk; never store error messages or tool payloads.
const entrySchema = z.object({
  at: z.number().int().nonnegative(),
  event: z.enum(['app_start','app_ready','app_quit','startup_error','ipc_error','renderer_gone','renderer_load_failed','task_queued','task_started','task_phase','task_finished','tool_error','worker_exit','checkpoint_error','diagnostics_exported']),
  taskId: z.string().uuid().optional(), runId: z.string().uuid().optional(),
  status: status.optional(), errorCategory: category.optional(),
  phase: z.enum(['queued','preparing','connecting','loading','probing','waiting_model','generating','tool','approval','command','stopping']).optional(),
  tool: z.enum(['find_vue_elements','edit_vue_element','list_directory','search_files','read_file','write_file','edit_file','replace_lines','run_command','show_changes']).optional().catch(undefined),
  step: z.number().int().min(0).max(100).optional(), exitCode: z.number().int().optional(),
  channel: z.enum(['settings:save','models:list','models:load','models:unload','task:submit','task:stop','task:approve','task:rename','task:archive','files:search','files:list','files:preview','rollback:preview','rollback:confirm','project:add','project:remove','app:open-data','app:export-diagnostics']).optional().catch(undefined),
});
type Entry = z.infer<typeof entrySchema>;
export const LOG_LIMIT = 512 * 1024;
export class DiagnosticLog {
  readonly directory: string;
  available = true;
  constructor(dataDirectory: string) { this.directory = path.join(dataDirectory, 'logs'); }
  record(data: Omit<Entry, 'at' | 'tool' | 'channel'> & { tool?: string; channel?: string }) {
    try {
      const entry = entrySchema.parse({ ...data, at: Date.now() });
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const file = path.join(this.directory, 'diagnostics.jsonl');
      const line = JSON.stringify(entry) + '\n';
      if (fs.existsSync(file)) {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.nlink !== 1) throw new Error('Invalid log file');
        if (stat.size + Buffer.byteLength(line) > LOG_LIMIT) fs.renameSync(file, path.join(this.directory, 'diagnostics.1.jsonl'));
      }
      const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.fchmodSync(fd, 0o600); fs.writeSync(fd, line); } finally { fs.closeSync(fd); }
      this.available = true;
    } catch { this.available = false; } // Logging failures must not interrupt a task or a file checkpoint.
  }
  read() {
    const entries: Entry[] = []; let incomplete = !this.available;
    for (const name of ['diagnostics.1.jsonl', 'diagnostics.jsonl']) {
      try {
        const file = path.join(this.directory, name), stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > LOG_LIMIT) { incomplete = true; continue; }
        for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
          try { const parsed = entrySchema.safeParse(JSON.parse(line)); if (parsed.success) entries.push(parsed.data); else incomplete = true; }
          catch { incomplete = true; }
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') incomplete = true; }
    }
    return { entries: entries.slice(-1000), incomplete, truncated: entries.length > 1000 };
  }
}
type DiagnosticTask = Pick<Task, 'id' | 'status' | 'archivedAt' | 'currentRunId' | 'error'> & { runs?: (import('../shared/types').Run | import('../shared/types').RunView)[] };
export function diagnosticReport(info: AppInfo, tasks: DiagnosticTask[], log: DiagnosticLog, taskCount = tasks.length) {
  return {
    formatVersion: 1, exportedAt: new Date().toISOString(),
    privacy: '仅含运行环境、匿名任务统计与结构化事件；不含令牌、服务地址、项目路径、聊天、源码、命令或原始错误正文。',
    app: { version: info.version, packaged: info.packaged, platform: info.platform, arch: info.arch, electron: info.electron, chrome: info.chrome, node: info.node, osRelease: info.osRelease },
    logs: log.read(), taskCount, taskLimit: 50,
    tasks: tasks.slice(0, 50).map(task => {
      const run = task.runs?.find(r => r.id === task.currentRunId) || task.runs?.at(-1);
      return {
        id: z.string().uuid().safeParse(task.id).success ? task.id : undefined,
        status: status.safeParse(task.status).success ? task.status : undefined,
        archived: !!task.archivedAt, runCount: task.runs?.length || 0,
        writtenFiles: run?.changes.filter(c => c.state === 'written' && ('changed' in c ? c.changed : c.before !== c.after)).length || 0,
        failedChecks: run?.checks.filter(c => c.status === 'failed').length || 0,
        errorCategory: task.error ? errorCategory(task.error) : undefined,
      };
    }),
  };
}
// Destination comes only from Electron's native save dialog, never renderer arguments.
export async function saveDiagnosticReport(destination: string, report: ReturnType<typeof diagnosticReport>, dataDirectory: string) {
  const parent = await fsp.realpath(path.dirname(destination));
  const root = await fsp.realpath(dataDirectory);
  const rel = path.relative(root, parent);
  if (!rel || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))) throw new Error('请保存到数据目录之外，避免覆盖任务记录或备份');
  const file = path.join(parent, path.basename(destination));
  try { const stat = await fsp.lstat(file); if (!stat.isFile() || stat.nlink !== 1) throw new Error('导出目标必须是普通文件，不能是链接或目录'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temp = path.join(parent, `.jalo-diagnostics-${randomUUID()}.tmp`);
  try { await fsp.writeFile(temp, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await fsp.rename(temp, file); }
  finally { await fsp.rm(temp, { force: true }); }
}
