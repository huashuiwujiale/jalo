export type Status = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export const busyStatuses: Status[] = ['queued', 'running', 'waiting'];
export interface Settings {
  baseUrl: string; token: string; model: string; temperature: number;
  contextLength: number; maxTokens: number; maxSteps: number; commandTimeout: number;
}
export const defaults: Settings = {
  baseUrl: 'http://127.0.0.1:1234', token: '', model: '', temperature: 0.2,
  contextLength: 16384, maxTokens: 2048, maxSteps: 30, commandTimeout: 60,
};
export interface LocalModel {
  key: string; name: string; size: number; maxContext: number;
  toolUse?: boolean; instances: { id: string; contextLength: number }[];
}
export interface Project { id: string; name: string; path: string; removedAt?: number }
export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null;
  tool_calls?: ToolCall[]; tool_call_id?: string;
  contextMemory?: import('./context').ContextMemory;
}
export type Mode = 'execute' | 'plan' | 'review';
export interface Progress { phase: 'queued' | 'preparing' | 'connecting' | 'loading' | 'probing' | 'waiting_model' | 'generating' | 'tool' | 'approval' | 'command' | 'stopping'; since: number; endedAt?: number; step?: number; maxSteps?: number; tool?: string }
export interface FileReference { projectId: string; path: string; startLine: number; endLine: number; version: string; scope?: 'file' | 'lines' }
export interface CapturedReference extends FileReference { content: string }
export interface FilePage { path: string; version: string; totalLines: number; startLine: number; endLine: number; content: string; hasMore: boolean }
export interface CheckResult { path: string; status: 'passed' | 'failed' | 'skipped'; parser: string; message: string; at: number; version: string }
export interface RunChange extends Change { id: string; runId: string; beforeVersion: string | null; afterVersion: string; check: CheckResult; state: 'prepared' | 'written' | 'reverted' | 'uncertain'; revertedAt?: number }
export interface Run { id: string; taskId: string; mode: Mode; model?: string; input: string; createdAt: number; endedAt?: number; status: Status; references: CapturedReference[]; changes: RunChange[]; checks: CheckResult[]; planText?: string; planRunId?: string; reviewRunId?: string; error?: string; progress?: Progress; contextUsage?: import('./context').ContextUsage }
export interface SubmitInput { projectId: string; prompt: string; taskId?: string; model?: string; mode?: Mode; references?: FileReference[]; planRunId?: string; reviewRunId?: string }
export interface RollbackPreview { token: string; patch: string; path: string; createsRecoveryCopy: boolean }
export interface Change { path: string; before: string | null; after: string; patch: string }
export interface Approval { id: string; command: string; cwd: string; timeout: number }
export interface Event { id: string; at: number; kind: 'message' | 'tool' | 'output' | 'notice' | 'error'; text: string; role?: string; runId?: string; toolCallId?: string; toolPhase?: 'call' | 'result' | 'error' }
export interface EventPage { events: Event[]; start: number; hasMore: boolean; total: number }
export type EventCursor =
  | { before?: string; after?: never; around?: never }
  | { before?: never; after: string; around?: never }
  | { before?: never; after?: never; around: string };
export interface RunEvidence { successfulTools: string[]; changedFiles: string[] }
export interface Task {
  archivedAt?: number;
  eventCount?: number; historyIncomplete?: boolean; userRequests?: string[];
  id: string; projectId: string; title: string; model: string; status: Status; createdAt: number; queuedAt?: number;
  messages: Message[]; events: Event[]; changes: Change[]; approval?: Approval; error?: string; lastRun?: RunEvidence; mode?: Mode; runs?: Run[]; currentRunId?: string; legacy?: boolean;
}
export interface TaskSummary extends Pick<Task, 'id' | 'projectId' | 'title' | 'model' | 'status' | 'createdAt' | 'queuedAt' | 'archivedAt' | 'currentRunId' | 'mode' | 'error' | 'legacy' | 'historyIncomplete'> {
  revision: number; eventCount: number; changeCount: number; runIds: string[]; requestCount: number;
}
export interface TaskQuery { projectId?: string; archived?: boolean; query?: string; limit?: number; cursor?: { createdAt: number; id: string } }
export interface TaskPage { tasks: TaskSummary[]; next?: { createdAt: number; id: string }; counts: [number, number] }
export interface ChangeView { path: string; changed: boolean; patchVersion: string }
export interface RunChangeView extends ChangeView, Pick<RunChange, 'id' | 'runId' | 'state' | 'check' | 'revertedAt'> {}
export interface RunView extends Omit<Run, 'references' | 'changes' | 'planText'> { references: FileReference[]; changes: RunChangeView[]; hasPlan: boolean }
export interface StreamState { taskId: string; runId: string; version: number; text: string; ended: boolean }
export interface StreamFrame extends Omit<StreamState, 'ended'> { kind: 'reset' | 'append' | 'end'; offset: number }
export interface TaskDetail extends Omit<Task, 'messages' | 'runs' | 'changes'> { revision: number; runs: RunView[]; changes: ChangeView[]; stream?: StreamState }
export interface Snapshot { sequence: number; catalogVersion?: number; projects: Project[]; tasks: TaskSummary[]; settings: Settings; activeId?: string; evaluations?: import('./evaluation').EvaluationReport[] }
export interface AppUpdate extends Partial<Pick<Snapshot, 'projects' | 'settings' | 'evaluations' | 'catalogVersion'>> { sequence: number; tasks: TaskSummary[]; activeId?: string }
export interface AppInfo {
  version: string; packaged: boolean; platform: string; arch: string;
  electron: string; chrome: string; node: string; osRelease: string;
  dataDirectory: string; logDirectory: string; logsAvailable: boolean;
}
export type EngineEvent = (
  | { type: 'context'; usage: import('./context').ContextUsage }
  | { type: 'progress'; progress: Progress }
  | { type: 'process'; pid: number; running: boolean }
  | { type: 'delta'; text: string }
  | { type: 'event'; event: Event }
  | { type: 'messages'; messages: Message[] }
  | { type: 'check'; check: CheckResult }
  | { type: 'checkpoint'; checkpoint: RunChange }
  | { type: 'change'; change: Change; checkpoint?: RunChange }
  | { type: 'approval'; approval: Approval }
  | { type: 'approval-resolved' }
  | { type: 'done'; status: Status; error?: string; evidence?: RunEvidence; result?: string }) & { runId?: string };
export interface Api {
  loadSession(): Promise<{ state: import('./session').SessionState; warning?: string }>;
  saveView(view: import('./session').SessionView): Promise<void>;
  flushView(view: import('./session').SessionView): { ok: boolean; error?: string };
  startEvaluation(): Promise<string>;
  stopEvaluation(id: string): Promise<void>;
  appInfo(): Promise<AppInfo>;
  openDataDirectory(): Promise<void>;
  exportDiagnostics(): Promise<string | null>;
  openLink(url: string): Promise<void>;
  copyText(text: string): Promise<void>;
  snapshot(): Promise<Snapshot>;
  addProject(): Promise<Project | null>;
  removeProject(projectId: string): Promise<void>;
  renameTask(taskId: string, title: string): Promise<void>;
  archiveTask(taskId: string, archived: boolean): Promise<void>;
  taskEvents(input: { taskId: string } & EventCursor): Promise<EventPage>;
  taskDetail(taskId: string): Promise<TaskDetail>;
  taskSummary(taskId: string): Promise<TaskSummary>;
  taskPage(input: TaskQuery): Promise<TaskPage>;
  searchTasks(input: { projectId: string; archived: boolean; query: string }): Promise<string[]>;
  planText(taskId: string, runId: string): Promise<string>;
  changePatch(input: { taskId: string; runId?: string; path: string }): Promise<{ patch: string; version: string }>;
  saveSettings(settings: Settings): Promise<void>;
  models(): Promise<LocalModel[]>;
  loadModel(key: string): Promise<void>;
  unloadModel(instance: string): Promise<void>;
  submit(input: SubmitInput): Promise<string>;
  searchFiles(input: { projectId: string; query: string }): Promise<{ paths: string[]; truncated: boolean }>;
  listDirectory(input: { projectId: string; path: string }): Promise<{ entries: { path: string; name: string; directory: boolean }[]; truncated: boolean }>;
  previewFile(input: { projectId: string; path: string; startLine?: number }): Promise<FilePage>;
  referenceFile(input: { projectId: string; path: string }): Promise<FileReference>;
  runChanges(taskId: string, runId: string): Promise<RunChange[]>;
  previewRollback(taskId: string, runId: string, path: string): Promise<RollbackPreview>;
  confirmRollback(token: string): Promise<void>;
  stop(taskId: string): Promise<void>;
  approve(taskId: string, approvalId: string, allow: boolean): Promise<void>;
  onUpdate(fn: (state: AppUpdate) => void): () => void;
  onDelta(fn: (data: StreamFrame) => void): () => void;
}
