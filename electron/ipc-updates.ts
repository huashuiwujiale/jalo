import type { AppUpdate, StreamFrame, StreamState } from '../shared/types';
export const updateDelay = 50;
export const streamDelay = 40;

/** Critical transitions flush immediately; ordinary events coalesce into one patch. */
export class UpdateBatch {
  sequence = 0;
  private ids = new Set<string>();
  private global = false;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private read: (ids: string[], global: boolean, sequence: number) => AppUpdate, private send: (update: AppUpdate) => void) {}
  queue(taskId?: string, immediate = true) {
    this.sequence++;
    if (taskId) this.ids.add(taskId); else this.global = true;
    if (immediate) this.flush();
    else this.timer ??= setTimeout(() => this.flush(), updateDelay);
  }
  flush() {
    clearTimeout(this.timer); this.timer = undefined;
    if (!this.ids.size && !this.global) return;
    const ids = [...this.ids], global = this.global;
    this.ids.clear(); this.global = false;
    this.send(this.read(ids, global, this.sequence));
  }
  dispose() { clearTimeout(this.timer); this.timer = undefined; this.ids.clear(); this.global = false; }
}

/** Stream offsets allow a renderer restored mid-response to ignore already received text. */
export class ReplyStream {
  private state?: StreamState;
  private pending: string[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private send: (frame: StreamFrame) => void) {}
  start(taskId: string, runId: string) {
    this.cancel();
    const version = this.state?.taskId === taskId && this.state.runId === runId ? this.state.version + 1 : 1;
    this.state = { taskId, runId, version, text: '', ended: false };
    this.send({ ...this.state, kind: 'reset', offset: 0 });
  }
  append(taskId: string, runId: string, text: string) {
    if (!text) return;
    if (!this.state || this.state.taskId !== taskId || this.state.runId !== runId || this.state.ended) this.start(taskId, runId);
    this.state!.version++; this.pending.push(text);
    this.timer ??= setTimeout(() => this.flush(), streamDelay);
  }
  snapshot(taskId: string) {
    return this.state?.taskId === taskId ? { ...this.state, text: this.state.text + this.pending.join('') } : undefined;
  }
  flush() {
    clearTimeout(this.timer); this.timer = undefined;
    if (!this.state || !this.pending.length) return;
    const text = this.pending.join(''), offset = this.state.text.length;
    this.pending = []; this.state.text += text;
    this.send({ ...this.state, text, kind: 'append', offset });
  }
  end(taskId: string) {
    if (this.state?.taskId !== taskId) return;
    this.cancel(); this.state = { ...this.state, version: this.state.version + 1, text: '', ended: true };
    this.send({ ...this.state, kind: 'end', offset: 0 });
  }
  private cancel() { clearTimeout(this.timer); this.timer = undefined; this.pending = []; }
  dispose() { this.cancel(); this.state = undefined; }
}
