import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Api, Event, EventCursor, Task } from '../shared/types';
type HistoryTask = Pick<Task, 'id' | 'events' | 'eventCount'>;
export const historyCacheLimit = 600;

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
  get hasMore() { return (this.entries[0]?.[0] ?? 0) > 0 || this.hasGap; }
  get hasLater() { return !!this.cached.size && this.entries.at(-1)![0] + 1 < this.total; }
  get hasGap() { const entries = this.entries; return entries.some(([index], i) => i > 0 && index !== entries[i - 1][0] + 1); }
  private insert(index: number, event: Event) {
    if (this.cached.get(index)?.id === event.id) return;
    this.cached.set(index, event); this.rendered = undefined; this.ordered = undefined;
  }
  private trim(older: boolean) {
    const entries = this.entries;
    const discard = older ? entries.slice(historyCacheLimit) : entries.slice(0, Math.max(0, entries.length - historyCacheLimit));
    if (!discard.length) return;
    for (const [index] of discard) this.cached.delete(index);
    this.rendered = undefined; this.ordered = undefined;
  }
  update(task?: HistoryTask, beforeApply: () => void = () => {}) {
    const detached = this.hasLater;
    if (this.taskId !== (task?.id || '')) {
      this.generation++; this.taskId = task?.id || ''; this.cached.clear(); this.rendered = undefined; this.ordered = undefined; this.loading = false;
    }
    this.total = task?.eventCount ?? task?.events.length ?? 0;
    const recent = task?.events || [], start = this.total - recent.length;
    if (detached && this.cached.size && start > this.entries.at(-1)![0] + 1) return;
    if (recent.some((event, i) => this.cached.get(start + i)?.id !== event.id)) beforeApply();
    if (this.cached.size && start - this.entries.at(-1)![0] > historyCacheLimit) this.cached.clear();
    recent.forEach((event, i) => this.insert(start + i, event));
    this.trim(false);
  }
  async loadEarlier(api: Pick<Api, 'taskEvents'>, beforeApply: () => void = () => {}) {
    if (this.loading || !this.hasMore || !this.cached.size) return false;
    const generation = this.generation;
    const entries = this.entries;
    // Fill gaps from skipped/batched live snapshots before loading the older prefix.
    const gapBoundary = entries.find(([index], i) => i > 0 && index !== entries[i - 1][0] + 1);
    const boundary = gapBoundary || entries[0];
    this.loading = true;
    try {
      const page = await api.taskEvents({ taskId: this.taskId, before: boundary[1].id });
      if (generation !== this.generation) return false;
      if (!page.events.length || !Number.isInteger(page.start) || page.start < 0) throw new Error('历史记录分页未返回有效内容，请重新打开任务');
      beforeApply();
      page.events.forEach((event, i) => this.insert(page.start + i, event));
      this.total = Math.max(this.total, page.total);
      // Filling a live gap must retain the latest tail. An older-prefix request
      // instead retains the page the user explicitly moved back to read.
      this.trim(!gapBoundary);
      return true;
    } catch (error) {
      if (generation !== this.generation) return false;
      throw error;
    } finally { if (generation === this.generation) this.loading = false; }
  }
  async loadWindow(api: Pick<Api, 'taskEvents'>, cursor: EventCursor, beforeApply: () => void = () => {}) {
    if (this.loading || !this.taskId) return false;
    const generation = this.generation;
    this.loading = true;
    try {
      const page = await api.taskEvents({ taskId: this.taskId, ...cursor });
      if (generation !== this.generation) return false;
      if (!Number.isInteger(page.start) || page.start < 0 || (!page.events.length && page.total)) throw new Error('历史记录分页未返回有效内容，请重新打开任务');
      beforeApply();
      if (!cursor.after) { this.cached.clear(); this.rendered = undefined; this.ordered = undefined; }
      page.events.forEach((event, i) => this.insert(page.start + i, event));
      this.total = Math.max(this.total, page.total); this.trim(false);
      return true;
    } catch (error) { if (generation !== this.generation) return false; throw error; }
    finally { if (generation === this.generation) this.loading = false; }
  }
  loadLater(api: Pick<Api, 'taskEvents'>, beforeApply: () => void = () => {}) {
    if (!this.hasLater) return Promise.resolve(false);
    return this.loadWindow(api, { after: this.entries.at(-1)![1].id }, beforeApply);
  }
}

export function useEventHistory(task: HistoryTask | undefined, api: Api, anchor: string | undefined, beforeApply: () => void, fail: (error: unknown) => void) {
  const history = useRef(new EventHistory());
  const [, refresh] = useState(0);
  const [failedTask, setFailedTask] = useState('');
  const callbacks = useRef({ beforeApply, fail }); callbacks.current = { beforeApply, fail };
  useLayoutEffect(() => { history.current.update(task, () => callbacks.current.beforeApply()); refresh(n => n + 1); }, [task]);
  useEffect(() => () => history.current.update(), []);
  const current = history.current;
  const selected = current.taskId === (task?.id || '');
  const events = selected ? current.events : task?.events || [];
  const hasMore = selected ? current.hasMore : events.length < (task?.eventCount || events.length);
  const loading = selected && current.loading;
  const restoring = !!task && !!anchor && !events.some(e => e.id === anchor) && failedTask !== task.id;
  const hasGap = selected && current.hasGap;
  const load = async (operation: () => Promise<boolean>) => {
    const id = current.taskId;
    setFailedTask('');
    const pending = operation();
    refresh(n => n + 1);
    try { await pending; }
    catch (error) { if (current.taskId === id) { setFailedTask(id); callbacks.current.fail(error); } }
    finally { refresh(n => n + 1); }
  };
  const before = () => callbacks.current.beforeApply();
  const loadEarlier = () => load(() => current.loadEarlier(api, before));
  const loadLater = () => load(() => current.loadLater(api, before));
  const loadLatest = () => load(() => current.loadWindow(api, {}, before));
  useEffect(() => {
    if (!loading && failedTask !== task?.id) {
      if (restoring) void load(() => current.loadWindow(api, { around: anchor! }, before));
      else if (hasGap) void loadEarlier();
    }
  }, [task?.id, anchor, events.length, hasMore, hasGap, loading, failedTask]);
  return { events, hasMore, hasLater: selected && current.hasLater, loading, restoring, loadEarlier, loadLater, loadLatest };
}
