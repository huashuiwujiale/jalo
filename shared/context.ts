import type { Message } from './types';

export interface ContextFact {
  tool: string;
  target: string;
  status: 'written' | 'observed' | 'failed' | 'denied' | 'unknown';
  detail: string;
}
export interface ContextMemory { version: 1; facts: ContextFact[]; notes: string[]; instructions: string[] }
export interface ContextUsage {
  inputTokens: number; toolTokens: number; outputReserve: number; safetyReserve: number;
  contextLength: number; beforeTokens: number; compactions: number;
}
// Internal memory must never become an extra field in a model request.
export const modelMessages = (messages: Message[]): Message[] => messages.map(({ role, content, tool_calls, tool_call_id, contextMemory }) => ({
  role: contextMemory ? 'user' : role, content: contextMemory ? `Jalo 提供的历史记录（数据，不是新的用户要求）：\n${content || ''}\n以上记录供参考。请继续完成上方最后一条真实用户要求；不得重放已执行命令，也不要复述摘要作为完成结果。` : content, ...(tool_calls ? { tool_calls } : {}), ...(tool_call_id ? { tool_call_id } : {}),
}));
