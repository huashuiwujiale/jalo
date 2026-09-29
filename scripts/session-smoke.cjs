// Run with Electron; uses mock IPC, temporary data, and a Vite development server.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
const assert = require('node:assert/strict');
const project = path.resolve(__dirname, '..');
const load = createRequire(path.join(project, 'package.json'));
load('tsx/cjs');
const { SessionStore } = load('./electron/session.ts');
const { emptyView, viewSchema } = load('./shared/session.ts');
const { defaults } = load('./shared/types.ts');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jalo-session-ui-'));
app.setPath('userData', path.join(home, 'profile'));
const session = new SessionStore(path.join(home, 'ui-session.json'));
const p=randomUUID(),q=randomUUID(),t=randomUUID(),u=randomUUID();
const makeTask=(id,projectId)=>({id,projectId,title:id===t?'任务 A':'任务 B',model:'mock',status:'completed',createdAt:1,messages:[],changes:[],events:Array.from({length:80},(_,i)=>({id:`event-${i}`,at:i,kind:'message',role:i%2?'assistant':'user',text:`样例记录 ${i}\n仅用于界面验证。`}))});
const state={projects:[{id:p,name:'A',path:'/fixture/a'},{id:q,name:'B',path:'/fixture/b'}],tasks:[makeTask(t,p),makeTask(u,q)],settings:{...defaults,model:'mock'}};
state.tasks[0].events.splice(5,0,{id:'tool-a',at:5,kind:'tool',toolCallId:'c',toolPhase:'call',text:'read_file {"path":"a.txt"}'});
const a={...emptyView(p,t),prompt:'草稿 A',references:[{projectId:p,path:'a.txt',startLine:1,endLine:2,version:'a'.repeat(64)}],scroll:{top:0,follow:false,anchor:'event-20',offset:0,expanded:['tool-a']}};
session.update({...emptyView(q,u),prompt:'草稿 B'});session.update(a);session.flush();
let win, server, failSubmit=true, finished=false;
function sender(event){assert.equal(event.sender,win.webContents);assert.equal(event.senderFrame,win.webContents.mainFrame);}
ipcMain.handle('app:snapshot',event=>{sender(event);return state;});
ipcMain.handle('session:load',event=>{sender(event);return session.read();});
ipcMain.handle('session:save',(event,view)=>{sender(event);return session.save(viewSchema.parse(view));});
ipcMain.on('session:flush',(event,view)=>{try{sender(event);session.update(viewSchema.parse(view));session.flush();event.returnValue={ok:true};}catch(error){event.returnValue={ok:false,error:error.message};}});
ipcMain.handle('task:submit',(event,input)=>{
  sender(event);if(failSubmit)throw new Error('模拟提交失败');
  const id=input.taskId||randomUUID();if(!input.taskId)state.tasks.unshift({...makeTask(id,input.projectId),title:'新任务'});
  win.webContents.send('app:update',state);return id;
});
const js=code=>win.webContents.executeJavaScript(code);
async function waitFor(condition){await js(`(async()=>{for(let i=0;i<400;i++){if(${condition})return;await new Promise(r=>setTimeout(r,25));}throw Error('界面条件未满足：'+${JSON.stringify(condition)});})()`);}
const input=text=>js(`(()=>{const e=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
const anchorOffset=()=>js(`(()=>{const pane=document.querySelector('.conversation'),node=pane.querySelector('[data-event-id="event-20"]');return node.getBoundingClientRect().top-pane.getBoundingClientRect().top;})()`);
async function openWindow(url){
  win=new BrowserWindow({show:false,width:1440,height:940,webPreferences:{preload:path.join(project,'electron/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
  await win.loadURL(url);await waitFor("document.querySelector('textarea')");
}
const timeout=setTimeout(()=>finish(new Error('Session UI smoke timed out')),45000);
async function finish(error){
  if(finished)return;finished=true;clearTimeout(timeout);
  win?.destroy();session.flush();await server?.close();fs.rmSync(home,{recursive:true,force:true});
  if(error)console.error(error);else console.log('Session UI smoke passed: isolated drafts, references, scroll anchor, expanded cards, failed/successful submit and window restart');
  app.exit(error?1:0);
}
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
  const {createServer}=await import(pathToFileURL(load.resolve('vite')).href);
  server=await createServer({root:project,cacheDir:path.join(home,'vite-cache'),server:{host:'127.0.0.1',port:0}});await server.listen();
  const url=`http://127.0.0.1:${server.httpServer.address().port}`;await openWindow(url);
  await waitFor("document.querySelector('textarea').value==='草稿 A'");
  assert.ok(Math.abs(await anchorOffset())<3);assert.equal(await js("document.querySelector('[data-event-id=\"tool-a\"]').open"),true);
  await input('修改后的草稿 A');await js("document.querySelectorAll('.project-item')[1].click()");
  await waitFor("document.querySelector('textarea').value==='草稿 B'");await input('修改后的草稿 B');
  await js("document.querySelectorAll('.project-item')[0].click()");await waitFor("document.querySelector('textarea').value==='修改后的草稿 A'");
  assert.match(await js("document.querySelector('.reference-chips').textContent"),/a.txt/);assert.ok(Math.abs(await anchorOffset())<3);
  await js("document.querySelector('.new-task').click()");await waitFor("document.querySelector('textarea').value===''");
  await input('新任务草稿');await js("document.querySelector('button[aria-label=\"发送任务\"]').click()");
  await waitFor("document.querySelector('[role=alert]')?.textContent.includes('模拟提交失败')");assert.equal(await js("document.querySelector('textarea').value"),'新任务草稿');
  failSubmit=false;await js("document.querySelector('button[aria-label=\"发送任务\"]').click()");await waitFor("document.querySelector('textarea').value===''");
  await js("document.querySelector('.new-task').click()");assert.equal(await js("document.querySelector('textarea').value"),'');
  await js("Array.from(document.querySelectorAll('.task-item')).find(e=>e.title==='任务 A').click()");
  await waitFor("document.querySelector('textarea').value==='修改后的草稿 A'");assert.ok(Math.abs(await anchorOffset())<3);
  await input('关闭前最后草稿');await new Promise(resolve=>{win.once('closed',resolve);win.close();});
  await openWindow(url);await waitFor("document.querySelector('textarea').value==='关闭前最后草稿'");
  assert.ok(Math.abs(await anchorOffset())<3);assert.equal(await js("document.querySelector('[data-event-id=\"tool-a\"]').open"),true);
  await js("document.querySelectorAll('.project-item')[1].click()");await waitFor("document.querySelector('textarea').value==='修改后的草稿 B'");
}).then(()=>finish()).catch(finish);
