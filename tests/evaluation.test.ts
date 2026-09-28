import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ModelEvaluation } from '../src/model-evaluation';
import { runEvaluation } from '../engine/evaluation';
import { EvaluationController } from '../electron/evaluation';
import { newEvaluation, type EvaluationReport } from '../shared/evaluation';
import { Store } from '../electron/store';
import { defaults, type Message } from '../shared/types';
import type { ModelProvider, Completion, ToolDefinition } from '../engine/provider';
import initSqlJs from 'sql.js';

const config = { ...defaults, model:'mock', token:'secret-token' };
const call = (name: string, args: unknown): Completion => ({ finishReason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}]} });
const reply = (content: string): Completion => ({finishReason:'stop',message:{role:'assistant',content}});
class FixtureModel implements ModelProvider {
  step = 0;
  constructor(private behavior: 'success' | 'wrong-vue' | 'fake' | 'command' | 'wait' = 'success') {}
  async list() { return [{key:'mock',name:'Mock',size:1,maxContext:16384,instances:[{id:'mock-instance',contextLength:16384}]}]; }
  async load(): Promise<string> { throw new Error('must not load'); } async unload() { throw new Error('must not unload'); }
  async generate(messages: Message[], tools: ToolDefinition[], signal: AbortSignal, _delta: (text:string)=>void, force?:string): Promise<Completion> {
    signal.throwIfAborted();
    if (this.behavior === 'wait') return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
    if (force) { this.step = 0; return call('capability_check',{ok:true}); }
    assert.ok(!tools.some(t=>t.function.name==='run_command'));
    const prompt = messages.find(m=>m.role==='user')!.content!, step = this.step++;
    if (this.behavior === 'fake') return reply('已经修改好了');
    if (this.behavior === 'command') return step===0 ? call('run_command',{command:'touch forbidden-marker'}) : reply('未执行');
    if (prompt.includes('config.json')) {
      if (step===0) return call('read_file',{path:'./config.json'});
      const result=messages.filter(m=>m.role==='tool').at(-1)!.content!;
      return reply(result.match(/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/)![0]);
    }
    if (prompt.includes('greeting.txt')) {
      if (step===0 || step===2) return call('read_file',{path:'greeting.txt'});
      if (step===1) return call('edit_file',{path:'greeting.txt',oldText:'hello',newText:'hello Jalo'});
      return reply('已完成修改并读取检查');
    }
    const selector={tag:'el-button',attributes:{'@click':this.behavior==='wrong-vue'?'handleExport':'handleAdd'}};
    if(step===0)return call('find_vue_elements',{path:'index.vue',selector});
    if(step===1)return call('edit_vue_element',{path:'index.vue',selector,expectedVersion:JSON.parse(messages.filter(m=>m.role==='tool').at(-1)!.content!).version,newText:''});
    if(step===2)return call('read_file',{path:'index.vue'});
    return reply('已完成修改并读取检查');
  }
}
async function evaluate(provider: ModelProvider, options: { signal?: AbortSignal; timeout?:number } = {}) {
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'jalo-eval-test-'));
  const report=newEvaluation(randomUUID(),config,'test-version');if(options.timeout)report.caseTimeoutMs=options.timeout;
  await runEvaluation(report,config,home,options.signal||new AbortController().signal,()=>{},()=>provider);
  await assert.rejects(fs.access(home));return report;
}
test('real tool loop passes all fixtures, uses structured Vue edit and stores effective settings without token',async()=>{
  const report=await evaluate(new FixtureModel());
  assert.deepEqual(report.cases.map(c=>[c.id,c.status]),[['read','passed'],['text','passed'],['vue','passed']]);
  assert.equal(report.instance,'mock-instance');assert.equal(report.parameters.maxSteps,8);assert.equal(report.status,'completed');
  assert.ok(report.cases.every(c=>c.durationMs!==undefined && c.checks.every(check=>check.passed)));
  assert.doesNotMatch(JSON.stringify(report),/secret-token/);
});
test('model claims, wrong element deletion and terminal attempts cannot pass disk verification',async()=>{
  const fake=await evaluate(new FixtureModel('fake'));assert.ok(fake.cases.every(c=>c.status==='failed'));
  const wrong=await evaluate(new FixtureModel('wrong-vue'));assert.equal(wrong.cases[1].status,'passed');assert.equal(wrong.cases[2].status,'failed');
  assert.ok(wrong.cases[2].checks.some(c=>c.title.includes('完整保留')&&!c.passed));
  const commands=await evaluate(new FixtureModel('command'));assert.ok(commands.cases.every(c=>c.status==='failed'));
  assert.ok(commands.cases.every(c=>c.checks.some(check=>check.title==='遵守禁止命令要求'&&!check.passed)));
});
test('cancellation skips remaining cases; per-case timeouts fail without hanging',async()=>{
  const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),40);
  try { const stopped=await evaluate(new FixtureModel('wait'),{signal:controller.signal});assert.equal(stopped.status,'cancelled');assert.equal(stopped.cases[0].status,'cancelled');assert.equal(stopped.cases[1].status,'skipped'); }
  finally {clearTimeout(timer);}
  const timed=await evaluate(new FixtureModel('wait'),{timeout:20});assert.equal(timed.status,'completed');assert.ok(timed.cases.every(c=>c.status==='failed' && c.error?.includes('上限')));
});
test('missing service, unloaded model and small contexts yield clear failures without loading models',async()=>{
  const service=new FixtureModel();service.list=async()=>{throw new Error('连接失败 secret-token');};
  const failed=await evaluate(service);assert.equal(failed.status,'failed');assert.match(failed.error!,/连接失败/);assert.doesNotMatch(JSON.stringify(failed),/secret-token/);
  const unloaded=new FixtureModel();unloaded.list=async()=>[];assert.match((await evaluate(unloaded)).error!,/尚未加载/);
  const small=new FixtureModel();small.list=async()=>[{key:'mock',name:'Mock',size:1,maxContext:4096,instances:[{id:'mock-instance',contextLength:4096}]}];
  assert.match((await evaluate(small)).error!,/上下文不足/);
});
test('evaluation controller handles cancellation races, stale events and unexpected worker exit', async()=>{
  const records=new Map<string,EvaluationReport>(), workers:any[]=[];
  const storage={putEvaluation:(r:EvaluationReport)=>records.set(r.id,structuredClone(r)),evaluations:()=>[...records.values()].reverse()};
  const manager=new EvaluationController(storage,()=>{const worker=new EventEmitter() as any;worker.sent=[];worker.postMessage=(m:any)=>worker.sent.push(m);worker.kill=()=>worker.emit('exit',0);workers.push(worker);return worker;},()=>{},'test');
  try {
    const id=manager.start(config), first=workers[0];first.emit('spawn');assert.equal(first.sent[0].type,'evaluate');assert.ok(manager.busy);
    assert.throws(()=>manager.start(config),/正在运行/);assert.throws(()=>manager.stop(randomUUID()),/已结束/);
    manager.stop(id);assert.equal(first.sent.at(-1).type,'cancel');
    first.emit('message',{type:'evaluation-update',report:{...manager.reports()[0],status:'completed'}});
    assert.equal(manager.reports()[0].status,'cancelled');assert.equal(manager.busy,false);await assert.rejects(fs.access(first.sent[0].home));
    const second=manager.start(config);workers[1].emit('spawn');
    first.emit('message',{type:'evaluation-update',report:{...manager.reports()[0],id,status:'completed'}});assert.equal(manager.reports()[0].id,second);
    workers[1].emit('exit',1);assert.equal(manager.reports()[0].status,'interrupted');assert.equal(manager.busy,false);
  } finally {manager.shutdown();}
});
test('evaluation reports survive restart, interrupt unfinished runs and retain only ten records',async()=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'jalo-eval-store-'));let store:Store|undefined;
  try {
    const file=path.join(home,'state.sqlite');store=await Store.open(file);
    for(let i=0;i<12;i++){const r=newEvaluation(randomUUID(),config,'test');r.createdAt=i;r.cases[0].status='running';store.putEvaluation(r);}
    assert.equal(store.evaluations().length,10);store.close();store=await Store.open(file);
    assert.equal(store.evaluations().length,10);assert.ok(store.evaluations().every(r=>r.status==='interrupted'&&r.cases[1].status==='skipped'));
    const html=renderToStaticMarkup(React.createElement(ModelEvaluation,{reports:store.evaluations(),api:{} as any,disabled:false,model:'mock',start:async()=>{},fail:()=>{}}));
    assert.match(html,/已中断/);assert.doesNotMatch(html,/样例通过率/);
  } finally {store?.close();await fs.rm(home,{recursive:true,force:true});}
});
test('v2 migration backs up the original database before adding reports and preserves projects',async()=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'jalo-eval-migration-'));let store:Store|undefined;
  try {
    const file=path.join(home,'state.sqlite'), SQL=await initSqlJs(), db=new SQL.Database();
    db.run('CREATE TABLE projects (id TEXT PRIMARY KEY, data TEXT NOT NULL); PRAGMA user_version = 2');
    db.run('INSERT INTO projects VALUES (?,?)',['p',JSON.stringify({id:'p',name:'existing',path:'/sample'})]);
    const bytes=Buffer.from(db.export());db.close();await fs.writeFile(file,bytes);
    store=await Store.open(file);assert.equal(store.projects()[0].name,'existing');assert.deepEqual(store.evaluations(),[]);
    const backup=(await fs.readdir(home)).find(n=>n.includes('before-v3'));assert.ok(backup);
    assert.deepEqual(await fs.readFile(path.join(home,backup)),bytes);
  } finally {store?.close();await fs.rm(home,{recursive:true,force:true});}
});
