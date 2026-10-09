import { randomUUID } from 'node:crypto';
import { modelMessages } from '../shared/context';
import type { LocalModel, Message, ToolCall } from '../shared/types';
import { HttpModelProvider, type Completion, type ModelProvider, type ToolDefinition } from './provider';

const positive = (value: unknown): value is number => Number.isInteger(value) && Number(value) > 0;

/** Ollama's native API keeps num_ctx explicit and returns complete tool arguments as objects. */
export class OllamaProvider extends HttpModelProvider implements ModelProvider {
  protected get serviceName() { return 'Ollama'; }
  async list(signal?: AbortSignal): Promise<LocalModel[]> {
    const [tags, running] = await Promise.all([
      this.request('/api/tags', undefined, signal).then(r => r.json()),
      this.request('/api/ps', undefined, signal).then(r => r.json()),
    ]);
    if (!Array.isArray(tags.models) || !Array.isArray(running.models)) throw new Error('Ollama 模型列表格式不兼容，请更新 Ollama');
    const available = tags.models.filter((m: any) => !m.remote_host && !m.remote_model && !/(?:-cloud|:cloud)$/.test(String(m.name || m.model)));
    const models: (LocalModel | undefined)[] = new Array(available.length);
    let next = 0;
    // Bound metadata requests so opening a long catalog does not flood the server.
    await Promise.all(Array.from({ length: Math.min(4, available.length) }, async () => {
      while (next < available.length) {
        const index = next++, entry = available[index], key = entry.name || entry.model;
        if (typeof key !== 'string' || !key || key.length > 300) throw new Error('Ollama 返回了无效的模型名称');
        const info = await (await this.request('/api/show', { model: key }, signal)).json();
        if (info.remote_host || info.remote_model) continue;
        const capabilities = info.capabilities;
        if (Array.isArray(capabilities) && !capabilities.includes('completion')) continue;
        const context = Object.entries(info.model_info || {}).find(([name, value]) => /^[^.]+\.context_length$/.test(name) && positive(value))?.[1];
        models[index] = {
          key, name: key, size: positive(entry.size) ? entry.size : 0,
          maxContext: positive(context) ? context : 4096,
          toolUse: Array.isArray(capabilities) ? capabilities.includes('tools') : undefined,
          instances: running.models.filter((m: any) => (m.name || m.model) === key).map((m: any) => ({ id: key, contextLength: positive(m.context_length) ? m.context_length : 4096 })),
        };
      }
    }));
    return models.filter((m): m is LocalModel => !!m);
  }
  async load(key: string, contextLength: number, signal?: AbortSignal) {
    const result = await (await this.request('/api/generate', { model: key, stream: false, keep_alive: '5m', options: { num_ctx: contextLength } }, signal, 300000)).json();
    if (result.error || result.done !== true) throw new Error(`Ollama 模型加载失败：${String(result.error || '未返回完成标记').slice(0, 500)}`);
    const running = await (await this.request('/api/ps', undefined, signal)).json();
    const instance = running.models?.find((m: any) => (m.name || m.model) === key);
    if (!instance || !positive(instance.context_length) || instance.context_length < contextLength) throw new Error('Ollama 模型加载未达到请求的上下文长度，请检查服务版本和可用内存');
    return key;
  }
  async unload(instance: string, signal?: AbortSignal) {
    const result = await (await this.request('/api/generate', { model: instance, stream: false, keep_alive: 0 }, signal, 300000)).json();
    if (result.error || result.done !== true) throw new Error(`Ollama 模型卸载失败：${String(result.error || '未返回完成标记').slice(0, 500)}`);
  }
  async generate(messages: Message[], tools: ToolDefinition[], signal: AbortSignal, delta: (text: string) => void, forceTool?: string, activity?: () => void): Promise<Completion> {
    const names = new Map(messages.flatMap(m => (m.tool_calls || []).map(c => [c.id, c.function.name] as const)));
    const history = modelMessages(messages).map(m => ({
      role: m.role, content: m.content || '',
      ...(m.role === 'tool' ? { tool_name: names.get(m.tool_call_id!) } : {}),
      ...(m.tool_calls ? { tool_calls: m.tool_calls.map(c => ({ type: 'function', function: { name: c.function.name, arguments: JSON.parse(c.function.arguments) } })) } : {}),
    }));
    const response = await this.request('/api/chat', {
      model: this.settings.model, messages: history,
      tools: forceTool ? tools.filter(t => t.function.name === forceTool) : tools,
      stream: true, keep_alive: '5m',
      options: { num_ctx: this.settings.contextLength, num_predict: this.settings.maxTokens, temperature: this.settings.temperature },
    }, signal, 300000);
    if (!response.body) throw new Error('模型没有返回响应流');
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '', content = '', received = 0, done = false, finishReason = '', reasoningCharacters = 0, reportedActivity = false;
    const calls: ToolCall[] = [];
    const consume = (line: string) => {
      if (!line.trim()) return;
      let chunk: any;
      try { chunk = JSON.parse(line); } catch { throw new Error('Ollama 返回了无效的流式 JSON'); }
      if (chunk.error) throw new Error(`Ollama 推理失败：${String(chunk.error).slice(0, 500)}`);
      const message = chunk.message || {};
      if (!reportedActivity && (message.content || message.thinking || message.tool_calls?.length)) { reportedActivity = true; activity?.(); }
      if (typeof message.thinking === 'string') reasoningCharacters += message.thinking.length;
      if (typeof message.content === 'string') { content += message.content; delta(message.content); }
      if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) throw new Error('Ollama 工具调用格式无效');
      for (const part of message.tool_calls || []) {
        const fn = part.function;
        if (calls.length >= 16 || typeof fn?.name !== 'string' || !fn.name || !fn.arguments || typeof fn.arguments !== 'object' || Array.isArray(fn.arguments)) throw new Error('Ollama 工具调用名称或参数无效');
        const args = JSON.stringify(fn.arguments);
        if (args.length > 100000) throw new Error('工具参数过大');
        calls.push({ id: randomUUID(), type: 'function', function: { name: fn.name, arguments: args } });
      }
      if (chunk.done === true) {
        done = true;
        finishReason = chunk.done_reason || 'stop';
      }
    };
    try {
      while (!done) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) { buffer += decoder.decode(); break; }
        received += chunk.value.length;
        if (received > 2_000_000) throw new Error('模型响应超过大小限制');
        buffer += decoder.decode(chunk.value, { stream: true });
        let boundary: number;
        while (!done && (boundary = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 1); }
      }
      if (!done && buffer.trim()) consume(buffer);
      if (!done) throw new Error('Ollama 模型响应中断，未执行本轮工具调用');
      return { message: { role: 'assistant', content: content || null, ...(calls.length ? { tool_calls: calls } : {}) }, finishReason: calls.length && finishReason === 'stop' ? 'tool_calls' : finishReason, reasoningCharacters };
    } catch (error) {
      if (signal.aborted) throw new Error('任务已停止');
      if (error instanceof TypeError || error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) throw new Error('Ollama 响应流超时或中断，本轮未完成的工具调用没有执行。请检查服务状态后继续。');
      throw error;
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}
