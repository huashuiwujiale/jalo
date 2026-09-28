import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { UtilityProcess } from 'electron';
import { endEvaluation, newEvaluation, type EvaluationReport } from '../shared/evaluation';
import type { Settings } from '../shared/types';
import type { Store } from './store';

export class EvaluationController {
  private latest?: EvaluationReport;
  private active?: { report: EvaluationReport; worker?: UtilityProcess; home: string; timer?: ReturnType<typeof setTimeout>; stopTimer?: ReturnType<typeof setTimeout>; stopping: boolean; savedState?: string };
  constructor(private store: Pick<Store, 'putEvaluation' | 'evaluations'>, private fork: () => UtilityProcess, private changed: () => void, private appVersion: string) {}
  get busy() { return !!this.active; }
  reports() { const saved = this.store.evaluations(), latest = this.active?.report || this.latest; return latest ? [latest, ...saved.filter(r => r.id !== latest.id)].slice(0, 10) : saved; }
  start(settings: Settings) {
    if (this.active) throw new Error('已有模型实测正在运行');
    if (!settings.model) throw new Error('请先选择、保存并加载默认模型');
    const report = newEvaluation(randomUUID(), settings, this.appVersion);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jalo-model-evaluation-'));
    const entry: NonNullable<EvaluationController['active']> = { report, home, stopping: false };
    try {
      this.store.putEvaluation(report); this.active = entry;
      const worker = this.fork(); entry.worker = worker;
      worker.on('spawn', () => { if (this.active === entry) { worker.postMessage({ type: 'evaluate', report, settings, home }); if (entry.stopping) worker.postMessage({ type: 'cancel' }); } });
      worker.on('message', (message: { type: string; report?: EvaluationReport }) => {
        if (this.active !== entry || message.type !== 'evaluation-update' || message.report?.id !== report.id) return;
        entry.report = message.report;
        if (entry.report.status !== 'running') { this.finish(entry.stopping ? 'cancelled' : entry.report.status, entry.stopping ? '已停止实测' : entry.report.error); return; }
        // Persist case transitions; token/progress updates remain in memory.
        const state = JSON.stringify([entry.report.instance, entry.report.cases.map(c => c.status)]);
        if (state !== entry.savedState) {
          try { this.store.putEvaluation(entry.report); entry.savedState = state; }
          catch { this.finish('failed', '实测记录保存失败，请检查磁盘空间和数据目录权限'); return; }
        }
        this.changed();
      });
      worker.on('exit', () => {
        try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
        if (this.active === entry) this.finish(entry.stopping ? 'cancelled' : 'interrupted', entry.stopping ? '已停止实测' : '实测进程意外退出，请重新测试');
      });
      entry.timer = setTimeout(() => this.finish('failed', '实测达到总时间上限，已停止'), 11 * 60 * 1000);
      this.changed(); return report.id;
    } catch (error) {
      if (this.active === entry) this.finish('failed', '无法启动实测进程');
      else fs.rmSync(home, { recursive: true, force: true });
      throw error;
    }
  }
  stop(id: string) {
    const entry = this.active;
    if (!entry || entry.report.id !== id) throw new Error('实测已结束或记录已变化');
    if (entry.stopping) return;
    entry.stopping = true; entry.worker?.postMessage({ type: 'cancel' });
    entry.stopTimer = setTimeout(() => this.finish('cancelled', '已停止实测'), 4000);
  }
  shutdown() { if (this.active) this.finish('interrupted', '应用已退出，实测不会自动恢复'); }
  private finish(status: EvaluationReport['status'], error?: string) {
    const entry = this.active; if (!entry) return;
    clearTimeout(entry.timer); clearTimeout(entry.stopTimer);
    endEvaluation(entry.report, status, error); this.active = undefined;
    this.latest = entry.report;
    entry.worker?.kill();
    if (!entry.worker) { try { fs.rmSync(entry.home, { recursive: true, force: true }); } catch {} }
    try { this.store.putEvaluation(entry.report); }
    catch { entry.report.error = '实测结束，但报告保存失败，请检查磁盘空间和数据目录权限'; }
    this.changed();
  }
}
