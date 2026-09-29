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
export const modelMessages = (messages: Message[]): Message[] => messages.map(({ role, content, tool_calls, tool_call_id }) => ({
  role, content, ...(tool_calls ? { tool_calls } : {}), ...(tool_call_id ? { tool_call_id } : {}),
}));
