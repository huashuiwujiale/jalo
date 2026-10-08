import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyView } from '../shared/session';
import { ViewSaver } from '../src/view-saver';

test('rapid draft and scroll updates share one bounded save and identical views are skipped', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const saved: string[] = [], remembered: string[] = [];
  const saver = new ViewSaver(async view => { saved.push(view.prompt); }, view => remembered.push(view.prompt), assert.fail);
  for (let i = 0; i < 100; i++) saver.schedule({ ...emptyView('p'), prompt: String(i) });
  assert.equal(remembered.length, 0); t.mock.timers.tick(250);
  assert.deepEqual(saved, ['99']); assert.deepEqual(remembered, ['99']);
  saver.schedule({ ...emptyView('p'), prompt: '99' }); t.mock.timers.tick(250);
  assert.equal(saved.length, 1);
  saver.schedule({ ...emptyView('p'), prompt: 'continuous' }); t.mock.timers.tick(200);
  saver.schedule({ ...emptyView('p'), prompt: 'latest' }); t.mock.timers.tick(50);
  assert.deepEqual(saved, ['99', 'latest']);
});
test('switch flush and synchronous close retain latest input without delayed saves', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const saved: string[] = [], closed: string[] = [];
  const saver = new ViewSaver(async v => { saved.push(v.prompt); }, () => {}, assert.fail);
  saver.schedule({ ...emptyView('p', 'a'), prompt: 'A' }); saver.flush();
  saver.schedule({ ...emptyView('p', 'b'), prompt: 'B' });
  saver.close({ ...emptyView('p', 'b'), prompt: 'last B' }, v => closed.push(v.prompt));
  t.mock.timers.tick(1000);
  assert.deepEqual(saved, ['A']); assert.deepEqual(closed, ['last B']);
});
test('failed saves report an error and an identical draft can be retried', async () => {
  let attempts = 0; const errors: unknown[] = [];
  const saver = new ViewSaver(async () => { if (++attempts === 1) throw new Error('disk'); }, () => {}, e => errors.push(e));
  const view = emptyView('p'); saver.schedule(view); saver.flush(); await Promise.resolve();
  saver.schedule(view); saver.flush(); await Promise.resolve();
  assert.equal(attempts, 2); assert.equal(errors.length, 1);
});
