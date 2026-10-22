import type { Settings } from './types';

/** Explain which limit needs attention without unloading models or changing output settings. */
export function contextLimitMessage(input: {
  configured: number; maximum: number; loaded?: number; effective: number; output: number; provider?: Settings['provider'];
}) {
  const service = input.provider === 'ollama' ? 'Ollama' : 'LM Studio';
  const facts = [`Jalo 设置 ${input.configured}`, `模型上限 ${input.maximum}`,
    ...(input.loaded !== undefined ? [`已加载实例 ${input.loaded}`] : [])].join('，');
  let action: string;
  if (input.maximum <= input.output * 2) {
    action = '模型支持的上下文限制了可用空间，请降低最大输出或选择支持更大上下文的模型。';
  } else {
    const steps: string[] = [];
    if (input.configured <= input.output * 2) steps.push('在 Jalo 的“模型与设置”中提高上下文长度');
    if (input.loaded !== undefined && input.loaded <= input.output * 2) steps.push(`在 ${service} 中卸载当前模型，按更大的上下文重新加载`);
    action = `请${steps.join('，并')}，或降低 Jalo 的最大输出。`;
    if (input.loaded !== undefined && input.loaded <= input.output * 2) action += '只修改 Jalo 的上下文设置不会改变已经加载的实例。';
  }
  return `上下文不足：实际可用 ${input.effective} Token，最大输出 ${input.output} Token（必须小于实际可用上下文的一半）。${facts} Token。${action}`;
}
