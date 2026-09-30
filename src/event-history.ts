import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Api, Event, Task } from '../shared/types';
type HistoryTask = Pick<Task, 'id' | 'events' | 'eventCount'>;

/** Retain loaded pages while recent snapshots advance, and ignore stale requests. */
export class EventHistory {
  taskId = '';
  private cached = new Map<number, Event>();
  total = 0;
  loading = false;
  private generation = 0;
  private rendered?: Event[];
  private ordered?: [number, Event][];
  private get entries() { return this.ordered ??= [...this.cached.entries()].sort(([a], [b]) => a - b); }
  get events() { return this.rendered ??= this.entries.map(([, event]) => event); }
  get hasMore() { return this.cached.size < this.total; }
  get hasGap() { const entries = this.entries; return entries.some(([index], i) => i > 0 && index !== entries[i - 1][0] + 1); }
  private insert(index: number, event: Event) {
    if (this.cached.get(index)?.id === event.id) return;
    this.cached.set(index, event); this.rendered = undefined; this.ordered = undefined;
  }
  update(task?: HistoryTask) {
    if (this.taskId !== (task?.id || '')) {
      this.generation++; this.taskId = task?.id || ''; this.cached.clear(); this.rendered = undefined; this.ordered = undefined; this.loading = false;
    }
    this.total = task?.eventCount ?? task?.events.length ?? 0;
    const recent = task?.events || [], start = this.total - recent.length;
    recent.forEach((event, i) => this.insert(start + i, event));
  }
  async loadEarlier(api: Pick<Api, 'taskEvents'>, beforeApply: () => void = () => {}) {
    if (this.loading || !this.hasMore || !this.cached.size) return false;
    const generation = this.generation;
    const entries = this.entries;
    // Fill gaps from skipped/batched live snapshots before loading the older prefix.
    const boundary = entries.find(([index], i) => i > 0 && index !== entries[i - 1][0] + 1) || entries[0];
    this.loading = true;
    try {
      const page = await api.taskEvents({ taskId: this.taskId, before: boundary[1].id });
      if (generation !== this.generation) return false;
      if (!page.events.length || !Number.isInteger(page.start) || page.start < 0) throw new Error('历史记录分页未返回有效内容，请重新打开任务');
      beforeApply();
      page.events.forEach((event, i) => this.insert(page.start + i, event));
      this.total = Math.max(this.total, page.total);
      return true;
    } catch (error) {
      if (generation !== this.generation) return false;
      throw error;
    } finally { if (generation === this.generation) this.loading = false; }
  }
}

export function useEventHistory(task: HistoryTask | undefined, api: Api, anchor: string | undefined, beforeApply: () => void, fail: (error: unknown) => void) {
  const history = useRef(new EventHistory());
  const [, refresh] = useState(0);
  const [failedTask, setFailedTask] = useState('');
  const callbacks = useRef({ beforeApply, fail }); callbacks.current = { beforeApply, fail };
  useLayoutEffect(() => { history.current.update(task); refresh(n => n + 1); }, [task]);
  useEffect(() => () => history.current.update(), []);
  const current = history.current;
  const selected = current.taskId === (task?.id || '');
  const events = selected ? current.events : task?.events || [];
  const hasMore = selected ? current.hasMore : events.length < (task?.eventCount || events.length);
  const loading = selected && current.loading;
  const restoring = !!anchor && !events.some(e => e.id === anchor) && hasMore;
  const hasGap = selected && current.hasGap;
  const loadEarlier = async () => {
    const id = current.taskId;
    setFailedTask('');
    const pending = current.loadEarlier(api, () => callbacks.current.beforeApply());
    refresh(n => n + 1);
    try { await pending; }
    catch (error) { if (current.taskId === id) { setFailedTask(id); callbacks.current.fail(error); } }
    finally { refresh(n => n + 1); }
  };
  useEffect(() => {
    if ((restoring || hasGap) && !loading && failedTask !== task?.id) void loadEarlier();
  }, [task?.id, anchor, events.length, hasMore, hasGap, loading, failedTask]);
  return { events, hasMore, loading, restoring: restoring && failedTask !== task?.id, loadEarlier };
}
