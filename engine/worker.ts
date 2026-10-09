import type { Approval, EngineEvent, Settings } from '../shared/types';
import { MessagePatchSender, type WorkerInput } from '../shared/worker-wire';
import { LMStudioProvider } from './provider';
import { ToolRegistry } from './tools';
import { validateContinuationFiles } from './continuation';
import { gitPatch } from './git-review';
import { captureReferences } from './project-files';
import { TaskRunner } from './runner';
import { SteeringInbox } from './steering';
const steering = new SteeringInbox();
import { runEvaluation } from './evaluation';
const port = (process as any).parentPort;
if (!port) throw new Error('任务引擎必须由 Electron utilityProcess 启动');
const controller = new AbortController();
let pending: { id: string; resolve: (allow: boolean) => void } | undefined;
let started = false;
let runId: string | undefined;
let messages: MessagePatchSender;
const checkpoints = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
const emit = (event: EngineEvent) => {
  if (event.type === 'messages') {
    const patch = messages.update(event.messages);
    if (patch) port.postMessage({ ...patch, runId });
  } else port.postMessage({ ...event, runId, ...(event.type === 'event' ? { event: { ...event.event, runId } } : {}) });
};
const approve = (approval: Approval) => new Promise<boolean>(resolve => {
  pending = { id: approval.id, resolve }; emit({ type: 'approval', approval });
});
port.on('message', async ({ data }: any) => {
  if (data.type === 'steer') { if (!controller.signal.aborted && runId && data.runId === runId) steering.add(data.followup); return; }
  if (data.type === 'checkpoint-ack') { const waiting = checkpoints.get(data.id); checkpoints.delete(data.id); if (data.error) waiting?.reject(new Error(data.error)); else waiting?.resolve(); return; }
  if (data.type === 'cancel') { controller.abort(); for (const c of checkpoints.values()) c.reject(new Error('任务已停止')); checkpoints.clear(); pending?.resolve(false); pending = undefined; return; }
  if (data.type === 'evaluate' && !started) {
    started = true;
    await runEvaluation(data.report, data.settings, data.home, controller.signal, report => port.postMessage({ type: 'evaluation-update', report }));
    return;
  }
  if (data.type === 'approve') {
    if (pending?.id === data.id) { pending.resolve(data.allow === true); pending = undefined; emit({ type: 'approval-resolved' }); }
    return;
  }
  if (data.type !== 'start' || started) return;
  started = true;
  const { input, root, backupDir, commandDirectory } = data as { input: WorkerInput; root: string; backupDir: string; commandDirectory?: string };
  runId = input?.run?.id;
  for (const followup of input.followups || []) steering.add(followup);
  const settings: Settings = { ...data.settings };
  try {
    const run = input?.run;
    if (!run?.id) throw new Error('缺少本轮执行记录，禁止执行');
    messages = new MessagePatchSender(input.messages);
    emit({ type: 'progress', progress: { phase: 'preparing', since: Date.now() } });
    await captureReferences({ id: input.projectId, name: '', path: root }, run.references);
    if (run.gitReview) await gitPatch(root, run.gitReview.path, run.gitReview.version);
    if (run.continuationFiles) await validateContinuationFiles(root, run.continuationFiles);
    const provider = new LMStudioProvider(settings);
    emit({ type: 'progress', progress: { phase: 'connecting', since: Date.now() } });
    const models = await provider.list(controller.signal);
    const model = models.find(m => m.key === input.model || m.instances.some(i => i.id === input.model));
    if (!model) throw new Error('选择的模型不存在，请刷新模型列表');
    if (model.toolUse === false) throw new Error('LM Studio 标记此模型未针对工具调用训练，请选择其他模型');
    settings.contextLength = Math.min(settings.contextLength, model.maxContext);
    const instance = model.instances.find(i => i.id === input.model) || model.instances[0];
    if (instance) {
      settings.model = instance.id;
      settings.contextLength = Math.min(settings.contextLength, instance.contextLength);
    } else {
      emit({ type: 'progress', progress: { phase: 'loading', since: Date.now() } });
      settings.model = await provider.load(model.key, settings.contextLength, controller.signal);
    }
    if (settings.maxTokens >= settings.contextLength / 2) throw new Error('已加载模型的上下文过小，请卸载后使用更大上下文重新加载，或降低最大输出');
    const registry = new ToolRegistry({ root, backupDir, commandDirectory, signal: controller.signal, timeout: settings.commandTimeout, emit, approve, changes: input.changes, mode: run.mode, runId, reviewChanges: input.reviewChanges, checkpoint: change => new Promise<void>((resolve, reject) => { checkpoints.set(change.id, { resolve, reject }); emit({ type: 'checkpoint', checkpoint: change }); }) });
    await new TaskRunner(provider, registry, settings, emit, controller.signal, () => steering.take()).run({ messages: input.messages });
  } catch (error) {
    emit({ type: 'done', status: controller.signal.aborted ? 'cancelled' : 'failed', error: controller.signal.aborted ? undefined : (error as Error).message });
  }
});
