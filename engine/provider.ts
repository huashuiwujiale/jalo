import type { LocalModel, Message, Settings, ToolCall } from '../shared/types';
export interface ToolDefinition { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }
export interface Completion { message: Message; finishReason: string; reasoningCharacters?: number }
export interface ModelProvider {
  list(signal?: AbortSignal): Promise<LocalModel[]>;
  load(key: string, contextLength: number, signal?: AbortSignal): Promise<string>;
  unload(instance: string, signal?: AbortSignal): Promise<void>;
  generate(messages: Message[], tools: ToolDefinition[], signal: AbortSignal, delta: (text: string) => void, forceTool?: string): Promise<Completion>;
}
export class LMStudioProvider implements ModelProvider {
  constructor(public settings: Settings, private fetcher: typeof fetch = fetch) {}
  private async request(path: string, body?: unknown, signal?: AbortSignal, timeout = 30000) {
    const timed = AbortSignal.timeout(timeout);
    const combined = signal ? AbortSignal.any([signal, timed]) : timed;
    try {
      const response = await this.fetcher(`${this.settings.baseUrl.replace(/\/$/, '')}${path}`, {
        method: body === undefined ? 'GET' : 'POST', signal: combined, redirect: 'error',
        headers: { 'Content-Type': 'application/json', ...(this.settings.token ? { Authorization: `Bearer ${this.settings.token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        let detail = (await response.text()).slice(0, 1500);
        if (this.settings.token) detail = detail.split(this.settings.token).join('[令牌已隐藏]');
        const hint = response.status === 401 ? '访问令牌不正确。' : response.status === 404 ? '请使用提供 /api/v1/models 的 LM Studio 版本。' : '';
        throw new Error(`LM Studio HTTP ${response.status}：${hint}${detail}`);
      }
      return response;
    } catch (error) {
      if (signal?.aborted) throw new Error('任务已停止');
      if (timed.aborted) throw new Error('LM Studio 请求超时，请检查模型或降低上下文长度');
      if (error instanceof TypeError) throw new Error('无法连接 LM Studio，请启动本地服务器并检查服务地址');
      throw error;
    }
  }
  async list(signal?: AbortSignal): Promise<LocalModel[]> {
    const data = await (await this.request('/api/v1/models', undefined, signal)).json();
    if (!Array.isArray(data.models)) throw new Error('模型列表格式不兼容，需要 LM Studio v1 REST API');
    return data.models.filter((m: any) => m.type === 'llm').map((m: any) => ({
      key: m.key, name: m.display_name || m.key, size: m.size_bytes || 0,
      maxContext: m.max_context_length || 4096, toolUse: m.capabilities?.trained_for_tool_use,
      instances: (m.loaded_instances || []).map((i: any) => ({ id: i.id, contextLength: i.config?.context_length || 4096 })),
    }));
  }
  async load(key: string, contextLength: number, signal?: AbortSignal) {
    const result = await (await this.request('/api/v1/models/load', { model: key, context_length: contextLength }, signal, 300000)).json();
    if (typeof result.instance_id !== 'string') throw new Error('模型加载未返回有效实例 ID');
    return result.instance_id;
  }
  async unload(instance: string, signal?: AbortSignal) { await this.request('/api/v1/models/unload', { instance_id: instance }, signal); }
  async generate(messages: Message[], tools: ToolDefinition[], signal: AbortSignal, delta: (text: string) => void, forceTool?: string): Promise<Completion> {
    const response = await this.request('/v1/chat/completions', {
      model: this.settings.model, messages, tools, stream: true,
      temperature: this.settings.temperature, max_tokens: this.settings.maxTokens,
      // LM Studio accepts string tool_choice values; the probe exposes only its one allowed tool.
      tool_choice: forceTool ? 'required' : 'auto',
      parallel_tool_calls: false,
    }, signal, 300000);
    if (!response.body) throw new Error('模型没有返回响应流');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', content = '', finishReason = '', received = 0, doneMarker = false;
    let reasoningCharacters = 0;
    const calls = new Map<number, ToolCall>();
    const consume = (event: string) => {
      const payload = event.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
      if (!payload) return;
      if (payload === '[DONE]') { doneMarker = true; return; }
      let json: any;
      try { json = JSON.parse(payload); } catch { throw new Error('模型返回了无效的流式 JSON'); }
      if (json.error) throw new Error(`模型推理失败：${String(json.error.message || json.error).slice(0, 500)}`);
      const choice = json.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const d = choice.delta || {};
      // Diagnose reasoning-only responses, never treat reasoning as executable output.
      const reasoning = d.reasoning_content ?? d.reasoning;
      if (typeof reasoning === 'string') reasoningCharacters += reasoning.length;
      if (typeof d.content === 'string') { content += d.content; delta(d.content); }
      for (const part of d.tool_calls || []) {
        if (!Number.isInteger(part.index) || part.index < 0 || part.index > 15) throw new Error('工具调用索引无效');
        const call = calls.get(part.index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (part.id) call.id = part.id;
        if (part.function?.name) call.function.name += part.function.name;
        if (part.function?.arguments) call.function.arguments += part.function.arguments;
        if (call.function.arguments.length > 100000) throw new Error('工具参数过大');
        calls.set(part.index, call);
      }
    };
    try {
      while (!doneMarker) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) { buffer += decoder.decode(); break; }
        received += value.length;
        if (received > 2_000_000) throw new Error('模型响应超过大小限制');
        buffer += decoder.decode(value, { stream: true });
        buffer = buffer.replace(/\r\n/g, '\n');
        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) { consume(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2); }
      }
      if (buffer.trim() && !doneMarker) consume(buffer);
      if (!finishReason) throw new Error('模型响应中断，未执行本轮工具调用');
      const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c);
      if (toolCalls.some(c => !c.id || !c.function.name)) throw new Error('工具调用缺少 ID 或名称');
      if (new Set(toolCalls.map(c => c.id)).size !== toolCalls.length) throw new Error('模型返回重复工具调用 ID');
      return { message: { role: 'assistant', content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finishReason, reasoningCharacters };
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}
