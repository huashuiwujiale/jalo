import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { defaults } from '../shared/types';
import { version, checkSyntax } from '../engine/syntax';
const require = createRequire(import.meta.url);
test('main IPC creates linked runs, persists checkpoints before acknowledgement, validates references and gates rollback', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(),'jalo-ipc-'));
  const root=path.join(home,'sample');await fs.mkdir(root);await fs.writeFile(path.join(root,'a.txt'),'old');
  const handlers = new Map<string,Function>(), workers:any[]=[]; let window:any, userData='', fatal:any;
  const app=new EventEmitter() as any;
  Object.assign(app,{getPath:(key:string)=>key==='userData'?userData:home,setPath:(_k:string,v:string)=>userData=v,setName:()=>{},setAboutPanelOptions:()=>{},requestSingleInstanceLock:()=>true,whenReady:()=>Promise.resolve(),quit:()=>{}});
  class Window extends EventEmitter {
    webContents:any; constructor(){super();window=this;this.webContents={mainFrame:{},send:()=>{},setWindowOpenHandler:()=>{},on:()=>{},session:{setPermissionRequestHandler:()=>{}}};} isDestroyed(){return false} async loadURL(){} }
  const fake = {app,BrowserWindow:Window,dialog:{showOpenDialog:async()=>({canceled:false,filePaths:[root]}),showErrorBox:(_t:string,m:string)=>fatal=m},ipcMain:{handle:(n:string,h:Function)=>handlers.set(n,h)},Menu:{setApplicationMenu:()=>{},buildFromTemplate:()=>[]},safeStorage:{isEncryptionAvailable:()=>true},utilityProcess:{fork:()=>{const w=new EventEmitter() as any;w.sent=[];w.postMessage=(m:any)=>w.sent.push(m);w.kill=()=>{};workers.push(w);setImmediate(()=>w.emit('spawn'));return w;}}};
  const Module=require('node:module'), original=Module._load;
  Module._load=function(id:string,...args:any[]){if(id==='electron')return fake;return original.call(this,id,...args)};
  process.env.LOCAL_CODE_DEV_URL='http://127.0.0.1:5173';
  try {
    require('../electron/main.ts');
    for(let i=0;i<300 && !window && !fatal;i++)await new Promise(r=>setTimeout(r,5));
    assert.equal(fatal,undefined);assert.ok(window);
    const invoke=(name:string,...args:any[])=>handlers.get(name)!({sender:window.webContents,senderFrame:window.webContents.mainFrame},...args);
    await assert.rejects(handlers.get('app:snapshot')!({sender:{},senderFrame:{}}),/无效的调用来源/);
    const project=await invoke('project:add');await invoke('settings:save',{...defaults,model:'mock'});
    const page=await invoke('files:preview',{projectId:project.id,path:'a.txt'});
    const ref={projectId:project.id,path:'a.txt',startLine:1,endLine:1,version:page.version};
    await assert.rejects(invoke('task:submit',{projectId:project.id,prompt:'x',references:[{...ref,projectId:randomUUID()}]}),/其他项目/);
    const taskId=await invoke('task:submit',{projectId:project.id,prompt:'先计划',mode:'plan',references:[ref]});
    const snapshot=()=>invoke('app:snapshot');
    let task=(await snapshot()).tasks.find((t:any)=>t.id===taskId), run=task.runs[0];assert.equal(run.mode,'plan');assert.equal(run.references[0].content,'old');
    const worker=workers.at(-1);worker.emit('message',{type:'done',runId:'other-run',status:'completed'});assert.equal((await snapshot()).tasks[0].status,'running');
    worker.emit('message',{type:'event',runId:run.id,event:{id:randomUUID(),runId:run.id,at:Date.now(),kind:'message',role:'assistant',text:'读取 a.txt，再将 old 改为 new，重新读取验收。'}});
    worker.emit('message',{type:'done',runId:run.id,status:'completed',evidence:{successfulTools:['read_file'],changedFiles:[]}});
    await invoke('task:submit',{projectId:project.id,taskId,prompt:'执行计划',mode:'execute',planRunId:run.id});
    task=(await snapshot()).tasks[0];const second=task.runs.at(-1);assert.notEqual(second.id,run.id);assert.equal(second.planRunId,run.id);
    const w=workers.at(-1), change={id:randomUUID(),runId:second.id,path:'a.txt',before:'old',after:'new',beforeVersion:version('old'),afterVersion:version('new'),check:checkSyntax('a.txt','new'),state:'prepared',patch:'-old\n+new'};
    w.emit('message',{type:'checkpoint',runId:second.id,checkpoint:change});
    assert.ok(w.sent.some((m:any)=>m.type==='checkpoint-ack'&&m.id===change.id));
    const SQL=await require('sql.js')();const db=new SQL.Database(await fs.readFile(path.join(userData,'local-code.sqlite')));assert.equal(db.exec('SELECT count(*) FROM checkpoints')[0].values[0][0],1);db.close();
    await fs.writeFile(path.join(root,'a.txt'),'new');w.emit('message',{type:'change',runId:second.id,change:{path:'a.txt',before:'old',after:'new',patch:change.patch},checkpoint:{...change,state:'written'}});
    await assert.rejects(invoke('rollback:preview',{taskId,runId:second.id,path:'a.txt'}),/运行中或排队/);
    w.emit('message',{type:'done',runId:second.id,status:'completed',evidence:{successfulTools:['write_file'],changedFiles:['a.txt']}});
    const preview=await invoke('rollback:preview',{taskId,runId:second.id,path:'a.txt'});assert.match(preview.patch,/-new/);
    await fs.writeFile(path.join(root,'a.txt'),'manual');await assert.rejects(invoke('rollback:confirm',preview.token),/冲突/);assert.equal(await fs.readFile(path.join(root,'a.txt'),'utf8'),'manual');
    await fs.writeFile(path.join(root,'a.txt'),'new');const preview2=await invoke('rollback:preview',{taskId,runId:second.id,path:'a.txt'});await invoke('rollback:confirm',preview2.token);
    assert.equal(await fs.readFile(path.join(root,'a.txt'),'utf8'),'old');task=(await snapshot()).tasks[0];assert.equal(task.runs.at(-1).changes[0].state,'reverted');assert.equal(task.changes.length,0);assert.ok(task.messages.at(-1).content.includes('重新读取'));
    await assert.rejects(invoke('task:submit',{projectId:project.id,taskId,prompt:'review',mode:'review'}),/选择已有核验记录/);
    await invoke('task:submit',{projectId:project.id,taskId,prompt:'review',mode:'review',reviewRunId:second.id});assert.equal((await snapshot()).tasks[0].runs.at(-1).reviewRunId,second.id);
  } finally { Module._load=original;app.emit('before-quit');await fs.rm(home,{recursive:true,force:true}); }
});
