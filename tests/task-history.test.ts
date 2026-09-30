import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../electron/store';
import { filterTasks, taskHistorySnapshot } from '../shared/task-history';
import type { Task } from '../shared/types';

const task = (id: string, extra: Partial<Task> = {}): Task => ({ id, projectId: 'p', title: 'Voucher 页面', status: 'completed', model: 'mock', createdAt: 1, messages: [], events: [], changes: [], ...extra });
test('task search isolates projects and archive tabs and searches user requests without tool output', () => {
  const tasks = [task('title'), task('archived',{archivedAt:1}), task('other',{projectId:'other'}),
    task('request',{title:'重命名过的任务',events:[{id:'e',at:1,kind:'message',role:'user',text:'删除新增按钮'}]}),
    task('tool',{title:'另一个任务',events:[{id:'t',at:1,kind:'tool',text:'删除新增按钮'}]}),
    task('run',{title:'计划',runs:[{id:'r',taskId:'run',mode:'plan',input:'检查导出按钮',status:'completed',createdAt:1,references:[],changes:[],checks:[]} ]}),
    task('paged-legacy',{title:'分页旧任务',userRequests:['原始发票要求'],events:[]})];
  assert.deepEqual(filterTasks(tasks,'p',false,'  VOUCHER  ').map(t=>t.id),['title']);
  assert.deepEqual(filterTasks(tasks,'p',true,'voucher').map(t=>t.id),['archived']);
  assert.deepEqual(filterTasks(tasks,'p',false,'新增').map(t=>t.id),['request']);
  assert.deepEqual(filterTasks(tasks,'p',false,'导出').map(t=>t.id),['run']);
  assert.equal(filterTasks(tasks,'p',false,'missing').length,0);
  assert.equal(filterTasks(tasks,'p',false,' ').length,5);
  assert.deepEqual(filterTasks(tasks,'p',false,'发票').map(t=>t.id),['paged-legacy']);
});
test('legacy requests remain searchable after continuation, pagination and reopening', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'jalo-legacy-search-'));
  let store: Store | undefined;
  try {
    const file = path.join(home, 'state.sqlite'); store = await Store.open(file);
    const legacy = task('legacy', { title: '已重命名', legacy: true, events: [
      { id: 'old-user', at: 1, kind: 'message', role: 'user', text: '旧版支付流程' },
      { id: 'old-tool', at: 1, kind: 'tool', text: '工具独有关键词' },
      ...Array.from({ length: 120 }, (_, i) => ({ id: 'log-' + i, at: 1, kind: 'notice' as const, text: 'log' })),
    ] });
    const check = (value: Task) => {
      const snapshot = taskHistorySnapshot(value);
      assert.equal(snapshot.events.length, 100);
      assert.ok(!snapshot.events.some(event => event.id === 'old-user'));
      assert.deepEqual(filterTasks([snapshot], 'p', false, '旧版支付').map(task => task.id), ['legacy']);
      assert.equal(filterTasks([snapshot], 'p', false, '工具独有').length, 0);
      assert.deepEqual(snapshot.userRequests, ['旧版支付流程']);
    };
    store.putTask(legacy); check(legacy);
    legacy.runs = [{ id: 'new-run', taskId: legacy.id, mode: 'execute', input: '继续处理导出', status: 'completed', createdAt: 2, references: [], changes: [], checks: [] }];
    legacy.currentRunId = 'new-run';
    legacy.events.push({ id: 'new-user', at: 2, kind: 'message', role: 'user', runId: 'new-run', text: '继续处理导出' });
    check(legacy);
    assert.equal(filterTasks([taskHistorySnapshot(legacy)], 'p', false, '导出').length, 1);
    store.putTask(legacy); store.close(); store = undefined;
    store = await Store.open(file); check(store.tasks()[0]);
  } finally { store?.close(); await fs.rm(home, { recursive: true, force: true }); }
});

test('renames, archives and removed projects survive reopening without dropping history', async () => {
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'jalo-history-'));
  let store: Store | undefined;
  try {
    const file=path.join(home,'state.sqlite');store=await Store.open(file);
    store.putProject({id:'p',name:'项目',path:home,removedAt:123});
    store.putTask(task('t',{title:'重命名后',archivedAt:456}));store.close();store=undefined;
    store=await Store.open(file);
    assert.equal(store.projects().length,0);assert.equal(store.projects(true)[0].removedAt,123);
    assert.equal(store.tasks()[0].title,'重命名后');assert.equal(store.tasks()[0].archivedAt,456);
    const project=store.projects(true)[0];delete project.removedAt;store.putProject(project);
    const restored=store.tasks()[0];delete restored.archivedAt;store.putTask(restored);store.close();store=undefined;
    store=await Store.open(file);assert.equal(store.projects()[0].id,'p');assert.equal(store.tasks()[0].archivedAt,undefined);
    assert.equal(store.tasks()[0].title,'重命名后');
  } finally { store?.close();await fs.rm(home,{recursive:true,force:true}); }
});
