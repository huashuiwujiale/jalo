import type { Approval, EngineEvent, Settings, Task, Message } from '../shared/types';
import { LMStudioProvider } from './provider';
import { ToolRegistry } from './tools';
import { captureReferences } from './project-files';
import { TaskRunner } from './runner';
const port = (process as any).parentPort;
if (!port) throw new Error('任务引擎必须由 Electron utilityProcess 启动');
const controller = new AbortController();
let pending: { id: string; resolve: (allow: boolean) => void } | undefined;
let started = false;
let runId: string | undefined;
let archivedMessages: Message[] = [];
const checkpoints = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
const emit = (event: EngineEvent) => port.postMessage({ ...event, runId, ...(event.type === 'messages' ? { messages: [...archivedMessages, ...event.messages] } : {}), ...(event.type === 'event' ? { event: { ...event.event, runId } } : {}) });
const approve = (approval: Approval) => new Promise<boolean>(resolve => {
  pending = { id: approval.id, resolve }; emit({ type: 'approval', approval });
});
port.on('message', async ({ data }: any) => {
  if (data.type === 'checkpoint-ack') { const waiting = checkpoints.get(data.id); checkpoints.delete(data.id); if (data.error) waiting?.reject(new Error(data.error)); else waiting?.resolve(); return; }
  if (data.type === 'cancel') { controller.abort(); for (const c of checkpoints.values()) c.reject(new Error('任务已停止')); checkpoints.clear(); pending?.resolve(false); pending = undefined; return; }
  if (data.type === 'approve') {
    if (pending?.id === data.id) { pending.resolve(data.allow === true); pending = undefined; emit({ type: 'approval-resolved' }); }
    return;
  }
  if (data.type !== 'start' || started) return;
  started = true;
  const { task, root, backupDir } = data as { task: Task; root: string; backupDir: string };
  runId = task.currentRunId;
  const run = task.runs?.find(r => r.id === runId);
  const settings: Settings = { ...data.settings };
  try {
    if (!run) throw new Error('缺少本轮执行记录，禁止执行');
    await captureReferences({ id: task.projectId, name: '', path: root }, run.references);
    const provider = new LMStudioProvider(settings);
    const models = await provider.list(controller.signal);
    const model = models.find(m => m.key === task.model || m.instances.some(i => i.id === task.model));
    if (!model) throw new Error('选择的模型不存在，请刷新模型列表');
    if (model.toolUse === false) throw new Error('LM Studio 标记此模型未针对工具调用训练，请选择其他模型');
    settings.contextLength = Math.min(settings.contextLength, model.maxContext);
    const instance = model.instances.find(i => i.id === task.model) || model.instances[0];
    if (instance) {
      settings.model = instance.id;
      settings.contextLength = Math.min(settings.contextLength, instance.contextLength);
    } else settings.model = await provider.load(model.key, settings.contextLength, controller.signal);
    if (settings.maxTokens >= settings.contextLength / 2) throw new Error('已加载模型的上下文过小，请卸载后使用更大上下文重新加载，或降低最大输出');
    const registry = new ToolRegistry({ root, backupDir, signal: controller.signal, timeout: settings.commandTimeout, emit, approve, changes: task.changes, mode: run.mode, runId, reviewChanges: run.mode === 'review' ? task.runs?.find(r => r.id === run.reviewRunId)?.changes.filter(c => c.state === 'written') || [] : undefined, checkpoint: change => new Promise<void>((resolve, reject) => { checkpoints.set(change.id, { resolve, reject }); emit({ type: 'checkpoint', checkpoint: change }); }) });
    // A linked execution/review starts with fresh file evidence, while retaining history in storage.
    const fresh = !!run.planRunId || run.mode === 'review';
    if (fresh) archivedMessages = task.messages.slice(0, -1);
    await new TaskRunner(provider, registry, settings, emit, controller.signal).run({ messages: fresh ? task.messages.slice(-1) : task.messages });
  } catch (error) {
    emit({ type: 'done', status: controller.signal.aborted ? 'cancelled' : 'failed', error: controller.signal.aborted ? undefined : (error as Error).message });
  }
});
