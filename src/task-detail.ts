import { useEffect, useRef, useState } from 'react';
import type { Api, TaskDetail, TaskSummary } from '../shared/types';

/** One in-flight request, no background-task payloads, and no stale task responses. */
export class DetailLoader {
  value?: TaskDetail;
  error?: string;
  loading = false;
  private selected?: TaskSummary;
  private generation = 0;
  get taskId() { return this.selected?.id; }
  constructor(private changed: () => void) {}
  update(selected: TaskSummary | undefined, api: Pick<Api, 'taskDetail'>) {
    if (selected?.id !== this.selected?.id) { this.generation++; this.value = undefined; this.error = undefined; this.loading = false; }
    this.selected = selected;
    if (selected && !this.loading && !this.error && (!this.value || this.value.revision < selected.revision)) void this.load(api);
  }
  retry(api: Pick<Api, 'taskDetail'>) { this.error = undefined; if (!this.loading && this.selected) void this.load(api); }
  private async load(api: Pick<Api, 'taskDetail'>) {
    const generation = this.generation, id = this.selected!.id;
    this.loading = true; this.changed();
    try {
      do {
        const value = await api.taskDetail(id);
        if (generation !== this.generation) return;
        if (value.id !== id) throw new Error('任务详情与所选任务不匹配');
        if (!this.value || value.revision >= this.value.revision) { this.value = value; this.changed(); }
      } while (this.selected && this.value!.revision < this.selected.revision);
    } catch (error) {
      if (generation === this.generation) this.error = error instanceof Error ? error.message : String(error);
    } finally { if (generation === this.generation) { this.loading = false; this.changed(); } }
  }
  dispose() { this.generation++; this.selected = undefined; this.loading = false; this.value = undefined; }
}
export function useTaskDetail(summary: TaskSummary | undefined, api: Api) {
  const [, refresh] = useState(0), loader = useRef<DetailLoader | null>(null);
  loader.current ??= new DetailLoader(() => refresh(n => n + 1));
  useEffect(() => { loader.current!.update(summary, api); }, [summary?.id, summary?.revision]);
  useEffect(() => () => loader.current!.dispose(), []);
  const current = loader.current, value = current.value?.id === summary?.id ? current.value : undefined;
  const error = current.taskId === summary?.id ? current.error : undefined;
  return { task: value, loading: (current.taskId === summary?.id && current.loading) || (!!summary && !value && !error), error, retry: () => current.retry(api) };
}
