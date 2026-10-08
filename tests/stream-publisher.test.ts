import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamPublisher } from '../src/stream-publisher';
import type { StreamState } from '../shared/types';
const state = (text: string, version = 1, ended = false): StreamState => ({ taskId: 't', runId: 'r', text, version, ended });

test('continuous tokens render periodically, retain all text and never postpone the window', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const seen: StreamState[] = [], publisher = new StreamPublisher(value => seen.push(value));
  let text = '';
  for (let i = 1; i <= 30; i++) { text += String(i); publisher.update(state(text, i)); t.mock.timers.tick(40); }
  assert.equal(seen.length, 10); assert.equal(seen.at(-1)?.text, text); assert.equal(seen.at(-1)?.version, 30);
});
test('long Markdown limits parse frequency while reset, end and disposal cancel stale text', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const seen: StreamState[] = [], publisher = new StreamPublisher(value => seen.push(value));
  publisher.update(state('x'.repeat(20000))); t.mock.timers.tick(120); assert.equal(seen.length, 0);
  publisher.update(state('x'.repeat(20000) + 'tail', 2)); t.mock.timers.tick(120);
  assert.equal(seen.at(-1)?.text.length, 20004);
  publisher.update(state('pending', 3)); publisher.update(state('', 4, true));
  assert.equal(seen.at(-1)?.ended, true); t.mock.timers.tick(500); assert.equal(seen.length, 2);
  publisher.update(state('old', 5)); publisher.update(state('', 6));
  assert.equal(seen.at(-1)?.version, 6); t.mock.timers.tick(500); assert.equal(seen.length, 3);
  publisher.update(state('disposed', 7)); publisher.dispose(); t.mock.timers.tick(500); assert.equal(seen.length, 3);
});
