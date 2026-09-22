import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupToolEvents } from '../src/tool-events';
import type { Event } from '../shared/types';
const event = (id: string, kind: Event['kind'], text: string, extra: Partial<Event> = {}): Event => ({ id, at: 1, kind, text, ...extra });
test('legacy call, error and result become one stable card', () => {
  const events = [event('1','tool','edit_file {"path":"a"}'),event('2','error','工具未成功：找不到'),event('3','tool','edit_file 结果\n工具未成功：找不到')];
  const rows = groupToolEvents(events); assert.equal(rows.length,1);
  const row = rows[0]; assert.equal(row.id,'1');
  if(row.kind !== 'tool-group') throw new Error('missing card');
  assert.equal(row.errors.length,1);assert.equal(row.result?.id,'3');
  assert.equal(groupToolEvents(events.slice(0,1))[0].id,row.id);
});
test('explicit IDs match interleaved calls and keep separate runs isolated', () => {
  const rows = groupToolEvents([
    event('1','tool','read_file {}',{runId:'r1',toolCallId:'a',toolPhase:'call'}),
    event('2','tool','read_file {}',{runId:'r1',toolCallId:'b',toolPhase:'call'}),
    event('3','tool','read_file 结果\nA',{runId:'r1',toolCallId:'a',toolPhase:'result'}),
    event('4','tool','read_file 结果\nB',{runId:'r2',toolCallId:'b',toolPhase:'result'}),
  ]);
  assert.equal(rows.length,3);
  assert.equal(rows[0].kind === 'tool-group' && rows[0].result?.id,'3');
  assert.equal(rows[1].kind === 'tool-group' && rows[1].result,undefined);
});
test('legacy grouping never crosses messages or runs, terminal output stays separate', () => {
  const rows = groupToolEvents([event('1','tool','read_file {}'),event('o','output','output'),event('m','message','hello'),event('2','tool','read_file 结果\ntext'),event('3','tool','edit_file {}',{runId:'a'}),event('4','error','工具未成功：error',{runId:'b'})]);
  assert.equal(rows.length,5);assert.equal(rows[2].kind,'tool');assert.equal(rows[4].kind,'error');
});
