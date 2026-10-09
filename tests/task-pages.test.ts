import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../electron/store';
import { mergeTaskSummaries } from '../src/task-pages';
import type { Task } from '../shared/types';

test('catalog cursor pages bound results, handle timestamp ties and find old Chinese requests without loading bodies', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'jalo-task-pages-')); const store = await Store.open(path.join(home, 'state.sqlite'));
  try {
    for (let i = 0; i < 240; i++) {
      const value: Task = { id: String(i).padStart(3, '0'), projectId: 'project', title: '历史', model: 'mock', status: 'completed', createdAt: Math.floor(i / 3), legacy: true, changes: [], messages: [],
        events: [{ id: 'request', kind: 'message', role: 'user', text: i === 3 ? '修复中文分页问题' : '其他要求', at: 1 }] };
      store.putTask(value);
    }
    (store as any).task = () => { throw new Error('unexpected hydration'); };
    const ids: string[] = []; let cursor;
    do { const page = store.taskPage({ projectId: 'project', archived: false, cursor }); assert.ok(page.tasks.length <= 100); ids.push(...page.tasks.map(t => t.id)); cursor = page.next; } while (cursor);
    assert.equal(ids.length, 240); assert.equal(new Set(ids).size, 240); assert.equal(ids[0], '239'); assert.equal(ids.at(-1), '000');
    assert.deepEqual(store.taskPage({ projectId: 'project', query: '中文分页' }).tasks.map(t => t.id), ['003']);
    const page = store.taskPage({ projectId: 'project', limit: 1 });
    assert.deepEqual(page.counts, [240, 0]); assert.equal(store.taskCount(), 240); assert.deepEqual(store.busySummaries(), []);
    const newer = { ...page.tasks[0], revision: 2, title: '新标题' };
    assert.equal(mergeTaskSummaries(page.tasks, [newer])[0].title, '新标题');
    assert.equal(mergeTaskSummaries([newer], page.tasks)[0].title, '新标题');
  } finally { store.close(); await fs.rm(home, { recursive: true, force: true }); }
});
