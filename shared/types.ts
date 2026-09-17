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
export interface Project { id: string; name: string; path: string }
export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null;
  tool_calls?: ToolCall[]; tool_call_id?: string;
}
export type Mode = 'execute' | 'plan' | 'review';
export interface FileReference { projectId: string; path: string; startLine: number; endLine: number; version: string }
export interface CapturedReference extends FileReference { content: string }
export interface FilePage { path: string; version: string; totalLines: number; startLine: number; endLine: number; content: string; hasMore: boolean }
export interface CheckResult { path: string; status: 'passed' | 'failed' | 'skipped'; parser: string; message: string; at: number; version: string }
export interface RunChange extends Change { id: string; runId: string; beforeVersion: string | null; afterVersion: string; check: CheckResult; state: 'prepared' | 'written' | 'reverted' | 'uncertain'; revertedAt?: number }
export interface Run { id: string; taskId: string; mode: Mode; input: string; createdAt: number; endedAt?: number; status: Status; references: CapturedReference[]; changes: RunChange[]; checks: CheckResult[]; planRunId?: string; reviewRunId?: string; error?: string }
export interface SubmitInput { projectId: string; prompt: string; taskId?: string; mode?: Mode; references?: FileReference[]; planRunId?: string; reviewRunId?: string }
export interface RollbackPreview { token: string; patch: string; path: string; createsRecoveryCopy: boolean }
export interface Change { path: string; before: string | null; after: string; patch: string }
export interface Approval { id: string; command: string; cwd: string; timeout: number }
export interface Event { id: string; at: number; kind: 'message' | 'tool' | 'output' | 'notice' | 'error'; text: string; role?: string; runId?: string }
export interface RunEvidence { successfulTools: string[]; changedFiles: string[] }
export interface Task {
  id: string; projectId: string; title: string; model: string; status: Status; createdAt: number; queuedAt?: number;
  messages: Message[]; events: Event[]; changes: Change[]; approval?: Approval; error?: string; lastRun?: RunEvidence; mode?: Mode; runs?: Run[]; currentRunId?: string; legacy?: boolean;
}
export interface Snapshot { projects: Project[]; tasks: Task[]; settings: Settings; activeId?: string }
export type EngineEvent = (
  | { type: 'process'; pid: number; running: boolean }
  | { type: 'delta'; text: string }
  | { type: 'event'; event: Event }
  | { type: 'messages'; messages: Message[] }
  | { type: 'check'; check: CheckResult }
  | { type: 'checkpoint'; checkpoint: RunChange }
  | { type: 'change'; change: Change; checkpoint?: RunChange }
  | { type: 'approval'; approval: Approval }
  | { type: 'approval-resolved' }
  | { type: 'done'; status: Status; error?: string; evidence?: RunEvidence }) & { runId?: string };
export interface Api {
  snapshot(): Promise<Snapshot>;
  addProject(): Promise<Project | null>;
  saveSettings(settings: Settings): Promise<void>;
  models(): Promise<LocalModel[]>;
  loadModel(key: string): Promise<void>;
  unloadModel(instance: string): Promise<void>;
  submit(input: SubmitInput): Promise<string>;
  searchFiles(input: { projectId: string; query: string }): Promise<{ paths: string[]; truncated: boolean }>;
  listDirectory(input: { projectId: string; path: string }): Promise<{ entries: { path: string; name: string; directory: boolean }[]; truncated: boolean }>;
  previewFile(input: { projectId: string; path: string; startLine?: number }): Promise<FilePage>;
  runChanges(taskId: string, runId: string): Promise<RunChange[]>;
  previewRollback(taskId: string, runId: string, path: string): Promise<RollbackPreview>;
  confirmRollback(token: string): Promise<void>;
  stop(taskId: string): Promise<void>;
  approve(taskId: string, approvalId: string, allow: boolean): Promise<void>;
  onUpdate(fn: (state: Snapshot) => void): () => void;
  onDelta(fn: (data: { taskId: string; text: string }) => void): () => void;
}
