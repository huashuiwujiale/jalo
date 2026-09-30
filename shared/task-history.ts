import type { EventPage, Run, Task } from './types';
export const historyPageSize = 100;

/** IDs are cursors: timestamps can coincide and live events only append. */
export function pageTaskEvents(task: Task, before?: string): EventPage {
  const end = before === undefined ? task.events.length : task.events.findIndex(e => e.id === before);
  if (end < 0) throw new Error('历史记录游标不存在，请重新打开任务');
  const start = Math.max(0, end - historyPageSize);
  return { events: task.events.slice(start, end), start, hasMore: start > 0, total: task.events.length };
}

/** Keep older requests searchable even after a legacy task gains new runs. */
export function taskHistorySnapshot(task: Task): Task {
  const runInputs = new Set(task.runs?.map(run => run.input));
  const userRequests = task.events
    .filter(event => event.kind === 'message' && event.role === 'user' && !runInputs.has(event.text))
    .map(event => event.text);
  return { ...task, events: pageTaskEvents(task).events, eventCount: task.events.length, userRequests };
}

/** Backfill only a final reply followed by the runner's completion notice. */
export function recoverPlanText(task: Task, run: Run): string | undefined {
  const events = task.events.filter(e => e.runId === run.id);
  const reply = events.findLastIndex(e => e.kind === 'message' && e.role === 'assistant');
  if (reply < 0 || !events[reply].text.trim()) return undefined;
  const after = events.slice(reply + 1);
  if (after.some(e => e.kind === 'tool' || e.kind === 'error')) return undefined;
  return after.some(e => e.kind === 'notice' && e.text === '本轮回复已结束，文件工具未产生实际修改。') ? events[reply].text : undefined;
}

export function linkedPlanContext(plan: Run, files: string[]): string {
  if (plan.mode !== 'plan' || plan.status !== 'completed' || !plan.planText?.trim()) throw new Error('该计划缺少完整保存的正文，请重新生成计划后执行');
  return '\n用户已确认进入新的执行轮次。之前计划模式的只读限制和拒绝结果不适用于本轮；当前允许项目内文件写入。原始目标要求：' + plan.input + '\n以下为关联计划，重新读取相关文件，不沿用旧行号：\n' + plan.planText + '\n已重新确认的引用文件：' + files.join('、');
}
export function filterTasks<T extends Pick<Task, 'projectId' | 'archivedAt' | 'title' | 'userRequests'> & Partial<Pick<Task, 'runs' | 'events'>>>(tasks: T[], projectId: string, archived: boolean, query: string) {
  const term = query.trim().toLocaleLowerCase();
  return tasks.filter(t => t.projectId === projectId && !!t.archivedAt === archived && (!term ||
    t.title.toLocaleLowerCase().includes(term) ||
    t.userRequests?.some(text => text.toLocaleLowerCase().includes(term)) ||
    t.runs?.some(r => r.input.toLocaleLowerCase().includes(term)) ||
    t.events?.some(e => e.role === 'user' && e.text.toLocaleLowerCase().includes(term))));
}
