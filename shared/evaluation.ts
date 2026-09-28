import type { Progress, Settings } from './types';
export interface EvaluationCase {
  id: 'read' | 'text' | 'vue'; title: string;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'cancelled' | 'skipped';
  startedAt?: number; durationMs?: number; phase?: Progress['phase']; step?: number;
  checks: { title: string; passed: boolean }[]; error?: string;
}
export interface EvaluationReport {
  id: string; suiteVersion: 1; appVersion: string; model: string; instance?: string;
  createdAt: number; endedAt?: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  parameters: Pick<Settings, 'contextLength' | 'maxTokens' | 'temperature' | 'maxSteps'>;
  caseTimeoutMs: number; cases: EvaluationCase[]; error?: string;
}
export function newEvaluation(id: string, settings: Settings, appVersion: string): EvaluationReport {
  return { id, suiteVersion: 1, appVersion, model: settings.model, createdAt: Date.now(), status: 'running',
    parameters: { contextLength: settings.contextLength, maxTokens: settings.maxTokens, temperature: settings.temperature, maxSteps: Math.min(settings.maxSteps, 8) },
    caseTimeoutMs: 180000, cases: [
      { id: 'read', title: '读取真实文件', status: 'pending', checks: [] },
      { id: 'text', title: '修改文本，保留其他文件', status: 'pending', checks: [] },
      { id: 'vue', title: '删除新增按钮，保留导出', status: 'pending', checks: [] },
    ] };
}
export function endEvaluation(report: EvaluationReport, status: EvaluationReport['status'], error?: string) {
  report.status = status; report.error = error; report.endedAt = Date.now();
  for (const item of report.cases) {
    if (item.status === 'running') { item.status = status === 'cancelled' ? 'cancelled' : 'failed'; item.durationMs = report.endedAt - (item.startedAt || report.createdAt); item.error = error; }
    else if (item.status === 'pending') item.status = 'skipped';
  }
  return report;
}
