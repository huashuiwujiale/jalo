import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { SessionStore } from '../electron/session';
import { emptySession, emptyView, rememberView, restoreView, viewKey } from '../shared/session';
import type { Snapshot, Task } from '../shared/types';

test('task and project drafts restore independently including references, mode, run and scroll',()=>{
  const p=randomUUID(),q=randomUUID(),t=randomUUID(),u=randomUUID(),run=randomUUID();
  const state=emptySession(), a={...emptyView(p,t),prompt:'A 的未提交要求',mode:'review' as const,runId:run,references:[{projectId:p,path:'a.vue',startLine:2,endLine:5,version:'a'.repeat(64)}],scroll:{top:350,follow:false,anchor:'event-a',offset:-12,expanded:['event-a']}};
  rememberView(state,a);rememberView(state,{...emptyView(p,u),prompt:'同项目另一任务'});
  rememberView(state,{...emptyView(p),prompt:'新任务草稿'});rememberView(state,{...emptyView(q),prompt:'另一个项目'});
  const snapshot={projects:[{id:p,name:'same',path:'/a'},{id:q,name:'same',path:'/b'}],tasks:[{id:t,projectId:p,runs:[{id:run}]},{id:u,projectId:p,runs:[]}]} as Pick<Snapshot,'projects'|'tasks'>;
  assert.deepEqual(restoreView(state,snapshot,{projectId:p,taskId:t}),a);
  assert.equal(restoreView(state,snapshot,{projectId:p,taskId:''}).prompt,'新任务草稿');
  assert.equal(restoreView(state,snapshot).prompt,'另一个项目');
  const restored=restoreView(state,snapshot,{projectId:p,taskId:t});restored.references.length=0;
  assert.equal(state.views[viewKey(p,t)].references.length,1);
  rememberView(state,{...a,prompt:'',references:[]});assert.equal(state.views[viewKey(p,u)].prompt,'同项目另一任务');
});
test('missing projects, mismatched tasks and obsolete run selection fall back without leaking drafts',()=>{
  const p=randomUUID(),q=randomUUID(),t=randomUUID();const state=emptySession();
  rememberView(state,{...emptyView(q,t),prompt:'已移除项目草稿'});
  rememberView(state,{...emptyView(p),prompt:'可用项目草稿'});
  const snapshot={projects:[{id:p,name:'p',path:'/p'}],tasks:[{id:t,projectId:q}]} as Pick<Snapshot,'projects'|'tasks'>;
  assert.equal(restoreView(state,snapshot,{projectId:q,taskId:t}).prompt,'可用项目草稿');
  assert.equal(restoreView(state,snapshot,{projectId:p,taskId:t}).taskId,'');
  const task: Task={id:t,projectId:p,title:'archived',status:'completed',model:'mock',createdAt:1,events:[],messages:[],changes:[],archivedAt:1};
  rememberView(state,{...emptyView(p,t),runId:randomUUID(),prompt:'已归档草稿'});
  const view=restoreView(state,{...snapshot,tasks:[task]});assert.equal(view.taskId,t);assert.equal(view.runId,'');assert.equal(view.prompt,'已归档草稿');
  assert.equal(state.views[viewKey(q,t)].prompt,'已移除项目草稿');
});
test('batched session saves and synchronous close flush survive reopening with private file permissions',async()=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'jalo-session-test-'));
  try{
    const file=path.join(home,'ui-session.json'), store=new SessionStore(file),view=emptyView(randomUUID(),randomUUID());
    const one=store.save({...view,prompt:'第一版'}),two=store.save({...view,prompt:'最新版本'});
    store.update({...view,prompt:'退出前最后输入'});store.flush();await Promise.all([one,two]);
    const saved=new SessionStore(file).read().state;
    assert.equal(saved.views[viewKey(view.projectId,view.taskId)].prompt,'退出前最后输入');assert.deepEqual(saved.selected,{projectId:view.projectId,taskId:view.taskId});
    assert.equal((await fs.stat(file)).mode&0o777,0o600);assert.deepEqual(await fs.readdir(home),['ui-session.json']);
  }finally{await fs.rm(home,{recursive:true,force:true});}
});
test('corrupt sessions preserve originals, and failed disk saves keep the in-memory draft',async()=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'jalo-session-test-'));
  try{
    const file=path.join(home,'ui-session.json');await fs.writeFile(file,'{broken');
    const store=new SessionStore(file);assert.ok(store.read().warning);
    const backup=(await fs.readdir(home)).find(n=>n.includes('.unreadable-'))!;assert.equal(await fs.readFile(path.join(home,backup),'utf8'),'{broken');
    const blocked=path.join(home,'blocked');await fs.writeFile(blocked,'ordinary file');
    const failing=new SessionStore(path.join(blocked,'session.json')),view={...emptyView(randomUUID()),prompt:'保留草稿'};
    await assert.rejects(failing.save(view),/草稿保存失败/);
    assert.equal(failing.read().state.views[viewKey(view.projectId,'')].prompt,'保留草稿');
  }finally{await fs.rm(home,{recursive:true,force:true});}
});
