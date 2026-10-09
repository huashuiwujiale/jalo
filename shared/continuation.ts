import type { Mode, RunChange } from './types';

export type StopReason = 'steps' | 'context' | 'output' | 'cancelled' | 'interrupted' | 'error' | 'completed';
export const stopLabels: Record<StopReason, string> = { steps: '达到步骤上限', context: '上下文预算不足', output: '模型输出达到上限', cancelled: '用户停止', interrupted: '进程或应用中断', error: '执行失败', completed: '本轮结束' };
export interface ContinuationCheckpoint {
  version: 1; runId: string; mode: Mode; at: number; reason: StopReason; step?: number;
  files: { path: string; state: RunChange['state'] | 'referenced'; version?: string | null }[];
  commands: { command: string; status: string; exitCode?: number; timedOut?: boolean }[];
  issues: string[]; notes: string[];
  omitted: { files: number; commands: number; issues: number; notes: number };
}
export interface ContinuationFile {
  path: string; state: 'read' | 'missing' | 'unavailable'; version?: string; matchesCheckpoint?: boolean;
}
export interface ContinuationLink { runId: string; version: string; files: ContinuationFile[] }
export interface ContinuationPreview {
  taskId: string; runId: string; version: string; goal: string; requiresGoal: boolean; requestCount: number;
  checkpoint: ContinuationCheckpoint; files: ContinuationFile[]; pendingFollowups: number;
  estimatedTokens: number; contextLength: number;
}
