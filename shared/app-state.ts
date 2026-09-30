import type { AppUpdate, Snapshot } from './types';
export function applyUpdate(state: Snapshot, update: AppUpdate): Snapshot {
  if (update.sequence <= state.sequence) return state;
  const changed = new Map(update.tasks.map(task => [task.id, task]));
  const tasks = state.tasks.map(task => { const next = changed.get(task.id); changed.delete(task.id); return next && next.revision > task.revision ? next : task; });
  tasks.unshift(...changed.values()); tasks.sort((a, b) => b.createdAt - a.createdAt);
  return { ...state, ...update, tasks };
}
