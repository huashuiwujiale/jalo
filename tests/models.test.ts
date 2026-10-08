import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findLocalModel, modelSelectionError } from '../shared/models';
import { submitSchema } from '../shared/validation';
import type { LocalModel } from '../shared/types';

const models: LocalModel[] = [
  { key:'a', name:'A', size:1, maxContext:16384, toolUse:true, instances:[{id:'a-instance',contextLength:16384}] },
  { key:'b', name:'B', size:1, maxContext:16384, instances:[] },
  { key:'c', name:'C', size:1, maxContext:16384, toolUse:false, instances:[] },
];
test('model selection recognizes loaded instances and unloaded models, rejects missing or incompatible models', () => {
  assert.equal(findLocalModel(models,'a-instance')?.key,'a');
  for (const key of ['', 'a','a-instance','b']) assert.equal(modelSelectionError(models,key),'');
  assert.match(modelSelectionError(models,'c'),/工具调用/);
  assert.match(modelSelectionError(models,'removed'),/不可用/);
});
test('task submission accepts an optional model override but rejects invalid identifiers', () => {
  const input={projectId:'2f6166b5-1c41-4f72-84d2-c956240ea0a5',prompt:'hello'};
  assert.equal(submitSchema.parse(input).model,undefined);
  assert.equal(submitSchema.parse({...input,model:'b'}).model,'b');
  for (const model of ['', 'x'.repeat(301), 123, null]) assert.equal(submitSchema.safeParse({...input,model}).success,false);
});
