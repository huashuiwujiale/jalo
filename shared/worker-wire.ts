import type { Change, EngineEvent, FileReference, Message, Mode, Task, Followup, GitReview } from './types';

export interface WorkerInput {
  projectId: string; model: string;
  run: { id: string; mode: Mode; references: FileReference[]; gitReview?: GitReview; continuationFiles?: import('./continuation').ContinuationFile[] };
  followups?: Followup[];
  messages: Message[]; changes: Change[]; reviewChanges?: Pick<Change, 'path' | 'patch'>[];
}
export interface MessagePatch {
  type: 'message-patch'; baseVersion: number; version: number;
  offset: number; remove: number; messages: Message[];
}
export type WorkerEvent = Exclude<EngineEvent, { type: 'messages' }> | (MessagePatch & { runId?: string });

export function workerInput(task: Task): { input: WorkerInput; archiveLength: number } {
  const run = task.runs?.find(r => r.id === task.currentRunId);
  if (!run) throw new Error('缺少本轮执行记录，禁止执行');
  const start = task.contextStart ?? 0;
  if (!Number.isSafeInteger(start) || start < 0 || start > task.messages.length) throw new Error('续接上下文边界无效，禁止执行');
  const archiveLength = run.continuation ? start : run.planRunId || run.mode === 'review' ? Math.max(start, task.messages.length - 1) : start;
  return { archiveLength, input: {
    projectId: task.projectId, model: task.model, followups: task.followups?.filter(f => f.kind === 'steer'),
    run: { id: run.id, mode: run.mode, ...(run.continuation ? { continuationFiles: run.continuation.files } : {}), references: run.references.map(({ content: _content, ...reference }) => reference), ...(run.gitReview ? { gitReview: { path: run.gitReview.path, version: run.gitReview.version } } : {}) },
    messages: task.messages.slice(archiveLength), changes: run.mode === 'review' ? [] : task.changes,
    ...(run.mode === 'review' ? { reviewChanges: run.gitReview ? [{ path: run.gitReview.path, patch: run.gitReview.patch }] : task.runs?.find(r => r.id === run.reviewRunId)?.changes
      .filter(c => c.state === 'written').map(({ path, patch }) => ({ path, patch })) || [] } : {}),
  } };
}

/** Runner messages are immutable objects; only their containing array is appended. */
export class MessagePatchSender {
  private previous: Message[];
  private version = 0;
  constructor(messages: Message[]) { this.previous = messages.slice(); }
  update(messages: Message[]): MessagePatch | undefined {
    let offset = 0, suffix = 0;
    while (offset < this.previous.length && offset < messages.length && this.previous[offset] === messages[offset]) offset++;
    while (suffix < this.previous.length - offset && suffix < messages.length - offset &&
      this.previous[this.previous.length - suffix - 1] === messages[messages.length - suffix - 1]) suffix++;
    const remove = this.previous.length - offset - suffix, added = messages.slice(offset, messages.length - suffix);
    if (!remove && !added.length) return;
    const patch: MessagePatch = { type: 'message-patch', baseVersion: this.version, version: ++this.version, offset, remove, messages: added };
    this.previous = messages.slice(); return patch;
  }
}

/** Offsets refer to the active context only; archived rounds stay in the main process. */
export class MessagePatchReceiver {
  private version = 0;
  constructor(private archiveLength: number) {}
  apply(task: Pick<Task, 'messages'>, patch: MessagePatch): boolean {
    if (![patch.version, patch.baseVersion, patch.offset, patch.remove].every(Number.isSafeInteger) ||
      patch.version < 1 || patch.baseVersion < 0 || patch.offset < 0 || patch.remove < 0 || !Array.isArray(patch.messages)) throw new Error('任务消息同步参数无效，已停止执行');
    if (patch.version <= this.version) return false;
    if (patch.baseVersion !== this.version || patch.version !== this.version + 1 ||
      patch.offset + patch.remove > task.messages.length - this.archiveLength) throw new Error('任务消息同步顺序不一致，已停止执行');
    const at = this.archiveLength + patch.offset;
    task.messages = [...task.messages.slice(0, at), ...patch.messages, ...task.messages.slice(at + patch.remove)];
    this.version = patch.version; return true;
  }
}
