import type { Settings } from '../shared/types';
import { LMStudioProvider, type ModelProvider } from './provider';
import { OllamaProvider } from './ollama';

export function createProvider(settings: Settings, fetcher: typeof fetch = fetch): ModelProvider {
  if (settings.provider === 'ollama') return new OllamaProvider(settings, fetcher);
  if (settings.provider === undefined || settings.provider === 'lmstudio') return new LMStudioProvider(settings, fetcher);
  throw new Error('不支持的模型服务类型');
}
