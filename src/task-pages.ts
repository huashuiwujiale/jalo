import { useEffect, useRef, useState } from 'react';
import type { Api, TaskPage, TaskQuery, TaskSummary } from '../shared/types';

export function mergeTaskSummaries(saved: TaskSummary[], live: TaskSummary[]) {
  const updates = new Map(live.map(task => [task.id, task]));
  return saved.map(task => { const next = updates.get(task.id); return next && next.revision >= task.revision ? next : task; });
}
export function useTaskPages(api: Api, input: TaskQuery, version: string) {
  const key = JSON.stringify([input.projectId, input.archived, input.query, version]);
  const generation = useRef(0), busy = useRef(false);
  const [state, setState] = useState<{ key: string; page?: TaskPage; loading: boolean; error?: string }>({ key, loading: true });
  const [attempt, retry] = useState(0);
  useEffect(() => {
    const id = ++generation.current; busy.current = true; setState({ key, loading: true });
    if (!input.projectId) { busy.current = false; setState({ key, page: { tasks: [], counts: [0, 0] }, loading: false }); return; }
    api.taskPage(input).then(page => { if (id === generation.current) setState({ key, page, loading: false }); }, error => {
      if (id === generation.current) setState({ key, loading: false, error: error.message });
    }).finally(() => { if (id === generation.current) busy.current = false; });
    return () => { generation.current++; };
  }, [key, attempt]);
  const current = state.key === key ? state : { key, loading: true, page: undefined, error: undefined };
  async function more() {
    if (busy.current || !current.page?.next) return;
    const id = generation.current, page = current.page; busy.current = true; setState({ ...current, loading: true, error: undefined });
    try {
      const next = await api.taskPage({ ...input, cursor: page.next });
      if (id !== generation.current) return;
      const seen = new Set(page.tasks.map(t => t.id));
      setState({ key, loading: false, page: { ...next, tasks: [...page.tasks, ...next.tasks.filter(t => !seen.has(t.id))] } });
    } catch (error) { if (id === generation.current) setState({ key, page, loading: false, error: (error as Error).message }); }
    finally { if (id === generation.current) busy.current = false; }
  }
  return { ...current, more, retry: () => current.page ? void more() : retry(n => n + 1) };
}
