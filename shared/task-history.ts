import type { Task } from './types';
export function filterTasks(tasks: Task[], projectId: string, archived: boolean, query: string) {
  const term = query.trim().toLocaleLowerCase();
  return tasks.filter(t => t.projectId === projectId && !!t.archivedAt === archived && (!term ||
    t.title.toLocaleLowerCase().includes(term) ||
    t.runs?.some(r => r.input.toLocaleLowerCase().includes(term)) ||
    t.events.some(e => e.role === 'user' && e.text.toLocaleLowerCase().includes(term))));
}
