import type { LocalModel } from './types';

export function findLocalModel(models: LocalModel[], id: string) {
  return models.find(model => model.key === id || model.instances.some(instance => instance.id === id));
}

/** Only a successful catalog can establish that a selection is unavailable. */
export function modelSelectionError(models: LocalModel[], id: string): string {
  if (!id) return '';
  const model = findLocalModel(models, id);
  if (!model) return '所选模型已不可用，请刷新列表或重新选择模型。';
  return model.toolUse === false ? '所选模型未针对工具调用训练，请选择其他模型。' : '';
}
