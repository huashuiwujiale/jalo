import { createHash } from 'node:crypto';
import { filterTasks, pageTaskEvents } from './task-history';
import type { Change, ChangeView, Run, RunView, StreamState, Task, TaskDetail, TaskSummary } from './types';

const patches = new WeakMap<Change, { patch: string; version: string }>();
const requests = new WeakMap<Task, { events: Task['events']; eventCount: number; runCount: number; texts: Set<string> }>();
export function changeView(change: Change): ChangeView {
  let cached = patches.get(change);
  if (!cached || cached.patch !== change.patch) {
    cached = { patch: change.patch, version: createHash('sha256').update(change.patch).digest('hex') };
    patches.set(change, cached);
  }
  return { path: change.path, changed: change.before !== change.after, patchVersion: cached.version };
}
export function runView(run: Run): RunView {
  const { references, changes, planText, ...data } = run;
  return { ...data, references: references.map(({ content, ...reference }) => reference),
    changes: changes.map(change => ({ ...changeView(change), id: change.id, runId: change.runId, state: change.state, check: change.check, revertedAt: change.revertedAt })),
    hasPlan: !!planText?.trim() };
}
export function requestTexts(task: Task) {
  let indexed = requests.get(task);
  if (!indexed || indexed.events !== task.events || indexed.eventCount > task.events.length) {
    indexed = { events: task.events, eventCount: 0, runCount: 0, texts: new Set() }; requests.set(task, indexed);
  }
  for (let i = indexed.eventCount; i < task.events.length; i++) { const event = task.events[i]; if (event.kind === 'message' && event.role === 'user') indexed.texts.add(event.text); }
  for (let i = indexed.runCount; i < (task.runs?.length || 0); i++) indexed.texts.add(task.runs![i].input);
  indexed.eventCount = task.events.length; indexed.runCount = task.runs?.length || 0;
  return indexed.texts;
}
export function searchTaskIds(tasks: Task[], projectId: string, archived: boolean, query: string) {
  return filterTasks(tasks.map(task => ({ id: task.id, projectId: task.projectId, title: task.title, archivedAt: task.archivedAt, userRequests: [...requestTexts(task)] })), projectId, archived, query).map(task => task.id);
}
export function taskSummary(task: Task, revision: number): TaskSummary {
  const { id, projectId, title, model, status, createdAt, queuedAt, archivedAt, currentRunId, mode, error, legacy, historyIncomplete } = task;
  return { id, projectId, title, model, status, createdAt, queuedAt, archivedAt, currentRunId, mode, error, legacy, historyIncomplete,
    revision, eventCount: task.events.length, changeCount: task.changes.length, runIds: task.runs?.map(run => run.id) || [], requestCount: requestTexts(task).size };
}
export function taskDetail(task: Task, revision: number, stream?: StreamState): TaskDetail {
  const { messages, events, runs, changes, ...data } = task;
  return { ...data, revision, events: pageTaskEvents(task).events, eventCount: events.length, runs: (runs || []).map(runView), changes: changes.map(changeView), stream };
}
