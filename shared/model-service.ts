import type { Settings } from './types';

export const modelServiceName = (settings: Settings) => settings.provider === 'ollama' ? 'Ollama' : 'LM Studio';
export const modelServiceKey = (settings: Settings) => JSON.stringify([settings.provider || 'lmstudio', settings.baseUrl, settings.token]);
export function changeModelService(settings: Settings, provider: NonNullable<Settings['provider']>): Settings {
  if ((settings.provider || 'lmstudio') === provider) return settings;
  return { ...settings, provider, baseUrl: provider === 'ollama' ? 'http://127.0.0.1:11434' : 'http://127.0.0.1:1234', token: '', model: '' };
}
