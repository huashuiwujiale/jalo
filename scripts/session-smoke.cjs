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
const { taskSummary, taskDetail } = load('./shared/task-wire.ts');
const { filterTasks, pageTaskEvents } = load('./shared/task-history.ts');
const projectFiles = load('./engine/project-files.ts');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jalo-session-ui-'));
app.setPath('userData', path.join(home, 'profile'));
const session = new SessionStore(path.join(home, 'ui-session.json'));
const p=randomUUID(),q=randomUUID(),t=randomUUID(),u=randomUUID();
const makeTask=(id,projectId)=>({id,projectId,title:id===t?'任务 A':'任务 B',model:'mock',status:'completed',createdAt:1,messages:[],changes:[],events:Array.from({length:80},(_,i)=>({id:`event-${i}`,at:i,kind:'message',role:i%2?'assistant':'user',text:`样例记录 ${i}\n仅用于界面验证。`}))});
const state={projects:[{id:p,name:'A',path:'/fixture/a'},{id:q,name:'B',path:'/fixture/b'}],tasks:[makeTask(t,p),makeTask(u,q)],settings:{...defaults,model:'mock'}};
const markdownCode='  const text = "<tag> & data";\n'+'  // '+ 'long-code '.repeat(90)+'\n';
const markdownText='# Markdown 验收\n\n**重点说明**和 `行内代码`。\n\n1. 读取\n2. 修改\n\n> 验收后再确认。\n\n```ts\n'+markdownCode+'```\n\n| 项目 | 状态 |\n| --- | --- |\n| 测试 | 通过 |\n\n- [x] 已完成\n\n[网页](https://example.com/docs) [禁止的链接](file:///etc/passwd)\n\n![图片](https://example.com/pixel)';
state.tasks[0].events.find(event=>event.id==='event-46').text='# 用户原文\n**保持原样**';
state.tasks[0].events.find(event=>event.id==='event-47').text=markdownText;
for(const fixture of state.projects){fixture.path=path.join(home,fixture.name);fs.mkdirSync(fixture.path,{recursive:true});fs.writeFileSync(path.join(fixture.path,'a.txt'),'sample');}
const fileContent=Array.from({length:739},(_,i)=>`line ${i+1}`).join('\n');
for(const folder of ['first','second']){const dir=path.join(state.projects[0].path,'src',folder);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'index.vue'),fileContent);}
fs.writeFileSync(path.join(state.projects[0].path,'binary.dat'),Buffer.from([0,1]));
state.tasks[0].events.splice(5,0,{id:'tool-a',at:5,kind:'tool',toolCallId:'c',toolPhase:'call',text:'read_file {"path":"a.txt"}'});
state.tasks[0].runs=[{id:randomUUID(),taskId:t,mode:'plan',input:'样例',createdAt:1,status:'completed',planText:markdownText,references:[],changes:[],checks:[],contextUsage:{inputTokens:5000,toolTokens:1000,outputReserve:1024,safetyReserve:3277,contextLength:16384,beforeTokens:14000,compactions:2}}];
state.tasks[0].currentRunId=state.tasks[0].runs[0].id;
const a={...emptyView(p,t),prompt:'草稿 A',references:[{projectId:p,path:'a.txt',startLine:1,endLine:2,version:'a'.repeat(64)}],scroll:{top:0,follow:false,anchor:'event-20',offset:0,expanded:['tool-a']}};
session.update({...emptyView(q,u),prompt:'草稿 B'});session.update(a);session.flush();
let win, server, failSubmit=true, finished=false, sequence=0;
const revisions=new Map();
const catalog=()=>({...state,sequence,tasks:state.tasks.map(task=>taskSummary(task,revisions.get(task.id)||0))});
function sender(event){assert.equal(event.sender,win.webContents);assert.equal(event.senderFrame,win.webContents.mainFrame);}
const fixture=id=>state.projects.find(p=>p.id===id);
let delayReference=false, viewSaves=0;
let failCopy=false, failLink=false;const copies=[],links=[];
ipcMain.handle('app:copy-text',(event,text)=>{sender(event);if(failCopy)throw new Error('模拟复制失败');copies.push(text);});
ipcMain.handle('app:open-link',(event,url)=>{sender(event);if(failLink)throw new Error('模拟打开失败');links.push(url);});
ipcMain.handle('runs:plan',(event,input)=>{sender(event);return state.tasks.find(task=>task.id===input.taskId).runs.find(run=>run.id===input.runId).planText;});
ipcMain.handle('files:search',(event,input)=>{sender(event);return projectFiles.searchFiles(fixture(input.projectId).path,input.query);});
ipcMain.handle('files:list',(event,input)=>{sender(event);return projectFiles.listDirectory(fixture(input.projectId).path,input.path);});
ipcMain.handle('files:preview',(event,input)=>{sender(event);return projectFiles.previewFile(fixture(input.projectId).path,input.path,input.startLine);});
ipcMain.handle('files:reference',async(event,input)=>{sender(event);if(delayReference)await new Promise(r=>setTimeout(r,400));return projectFiles.referenceFile(fixture(input.projectId),input.path);});
ipcMain.handle('app:snapshot',event=>{sender(event);return catalog();});
ipcMain.handle('task:detail',(event,id)=>{sender(event);return taskDetail(state.tasks.find(task=>task.id===id),revisions.get(id)||0);});
const eventRequests=[];
ipcMain.handle('task:events',(event,input)=>{sender(event);eventRequests.push(input);const {taskId,...cursor}=input;return pageTaskEvents(state.tasks.find(task=>task.id===taskId),cursor);});
ipcMain.handle('tasks:search',(event,input)=>{sender(event);return filterTasks(state.tasks,input.projectId,input.archived,input.query).map(task=>task.id);});
ipcMain.handle('session:load',event=>{sender(event);return session.read();});
ipcMain.handle('session:save',(event,view)=>{sender(event);viewSaves++;return session.save(viewSchema.parse(view));});
ipcMain.on('session:flush',(event,view)=>{try{sender(event);session.update(viewSchema.parse(view));session.flush();event.returnValue={ok:true};}catch(error){event.returnValue={ok:false,error:error.message};}});
ipcMain.handle('task:submit',(event,input)=>{
  sender(event);if(failSubmit)throw new Error('模拟提交失败');
  const id=input.taskId||randomUUID();if(!input.taskId)state.tasks.unshift({...makeTask(id,input.projectId),title:'新任务'});
  revisions.set(id,(revisions.get(id)||0)+1);sequence++;
  win.webContents.send('app:update',{sequence,tasks:[taskSummary(state.tasks.find(task=>task.id===id),revisions.get(id))]});return id;
});
function fixtureUpdate(task){revisions.set(task.id,(revisions.get(task.id)||0)+1);sequence++;win.webContents.send('app:update',{sequence,tasks:[taskSummary(task,revisions.get(task.id))]});}
ipcMain.handle('task:rename',(event,input)=>{sender(event);const task=state.tasks.find(task=>task.id===input.taskId);task.title=input.title;fixtureUpdate(task);});
ipcMain.handle('task:archive',(event,input)=>{sender(event);const task=state.tasks.find(task=>task.id===input.taskId);if(input.archived)task.archivedAt=Date.now();else delete task.archivedAt;fixtureUpdate(task);});
const js=async code=>{try{return await win.webContents.executeJavaScript(code);}catch(error){console.error('Failed UI expression:',code);throw error;}};
async function waitFor(condition){await js(`(async()=>{for(let i=0;i<400;i++){if(${condition})return;await new Promise(r=>setTimeout(r,25));}throw Error('界面条件未满足：'+${JSON.stringify(condition)});})()`);}
const input=text=>js(`(()=>{const e=document.querySelector('textarea');e.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.setSelectionRange(e.value.length,e.value.length);e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
const key=name=>js(`document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(name)},bubbles:true}))`);
const anchorOffset=()=>js(`(()=>{const pane=document.querySelector('.conversation'),node=pane.querySelector('[data-event-id="event-20"]');return node.getBoundingClientRect().top-pane.getBoundingClientRect().top;})()`);
async function revealEvent(id){
  await js(`document.querySelector('.conversation').scrollTop=0`);
  for(let i=0;i<200;i++){
    if(await js(`(()=>{const pane=document.querySelector('.conversation'),node=pane.querySelector('[data-event-id="${id}"]');if(!node)return false;pane.scrollTop+=node.getBoundingClientRect().top-pane.getBoundingClientRect().top;return true;})()`)){
      await new Promise(r=>setTimeout(r,80));
      if(await js(`!!document.querySelector('[data-event-id="${id}"]')`))return;
      continue;
    }
    await js(`document.querySelector('.conversation').scrollTop+=Math.max(100,document.querySelector('.conversation').clientHeight/2)`);
    await new Promise(r=>setTimeout(r,25));
  }
  throw Error('Cannot reveal event '+id);
}
async function openWindow(url, anchor='event-20'){
  win=new BrowserWindow({show:false,width:1440,height:940,webPreferences:{preload:path.join(project,'electron/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
  await win.loadURL(url);
  try{await waitFor(`document.querySelector('textarea') && document.querySelector('[data-event-id="${anchor}"]')`);}
  catch(error){console.error(await js("JSON.stringify({text:document.body.innerText.slice(0,800),rows:Array.from(document.querySelectorAll('[data-event-id]')).map(n=>n.dataset.eventId),top:document.querySelector('.conversation')?.scrollTop,height:document.querySelector('.conversation')?.scrollHeight})"));throw error;}
}
const timeout=setTimeout(()=>finish(new Error('Session UI smoke timed out')),45000);
async function finish(error){
  if(finished)return;finished=true;clearTimeout(timeout);
  if(error && win && !win.isDestroyed()){
    try{console.error('UI failure state',await js("JSON.stringify({top:document.querySelector('.conversation')?.scrollTop,height:document.querySelector('.conversation')?.scrollHeight,rows:Array.from(document.querySelectorAll('[data-event-id]')).map(n=>[n.dataset.eventId,n.getBoundingClientRect().top-document.querySelector('.conversation').getBoundingClientRect().top]),spacers:Array.from(document.querySelector('.virtual-timeline')?.children||[]).filter(n=>!n.dataset.rowId).map(n=>n.style.height)})"));console.error('Saved selection',session.read().state.selected,session.read().state.views[Object.keys(session.read().state.views).find(k=>k===`${p}:${t}`)]?.scroll);}catch{}}
  win?.destroy();session.flush();await server?.close();fs.rmSync(home,{recursive:true,force:true});
  if(error)console.error(error);else console.log('Session UI smoke passed: Markdown, streaming, drafts, window restart, 10000-event anchor jump, bounded cache/DOM, resize, expanded cards, live follow and 2000-task navigation/search/rename/archive');
  app.exit(error?1:0);
}
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
  const {createServer}=await import(pathToFileURL(load.resolve('vite')).href);
  server=await createServer({root:project,cacheDir:path.join(home,'vite-cache'),server:{host:'127.0.0.1',port:0}});await server.listen();
  const url=`http://127.0.0.1:${server.httpServer.address().port}`;await openWindow(url);
  await waitFor("document.querySelector('textarea').value==='草稿 A'");
  await new Promise(r=>setTimeout(r,450));
  const beforeTyping=viewSaves;
  await js(`(()=>{window.positionScans=0;const pane=document.querySelector('.conversation'),original=pane.querySelectorAll.bind(pane);pane.querySelectorAll=(selector)=>{if(selector==='[data-event-id]')window.positionScans++;return original(selector);};})()`);
  for(let i=0;i<12;i++)await input('连续输入 '+i);
  await new Promise(r=>setTimeout(r,500));
  assert.ok(viewSaves-beforeTyping<=2, 'typing should coalesce save IPC');
  assert.equal(await js('window.positionScans'),0,'typing should not scan conversation nodes');
  await input('草稿 A');
  await revealEvent('event-47');
  const markdown="document.querySelector('[data-event-id=\"event-47\"]')";
  assert.equal(await js(`${markdown}.querySelector('h1').textContent`),'Markdown 验收');
  assert.equal(await js(`${markdown}.querySelector('pre code').textContent`),markdownCode);
  assert.equal(await js(`${markdown}.querySelectorAll('table').length`),1);
  assert.equal(await js(`${markdown}.querySelectorAll('img').length`),0);
  assert.equal(await js(`${markdown}.querySelectorAll('a').length`),1);
  assert.equal(await js("document.querySelector('[data-event-id=\"event-46\"] .message-text').textContent"),'# 用户原文\n**保持原样**');
  assert.ok(await js(`${markdown}.querySelector('pre').scrollWidth > ${markdown}.querySelector('pre').clientWidth`));
  assert.ok(await js(`${markdown}.getBoundingClientRect().right <= document.querySelector('.timeline').getBoundingClientRect().right`));
  await js(`${markdown}.querySelector('button[aria-label=复制代码]').click()`);await waitFor(`${markdown}.textContent.includes('已复制')`);
  assert.deepEqual(copies,[markdownCode]);
  failCopy=true;await js(`${markdown}.querySelector('button[aria-label=复制代码]').click()`);await waitFor(`${markdown}.querySelector('[role=alert]')?.textContent.includes('复制失败')`);
  failCopy=false;await js(`${markdown}.querySelector('button[aria-label=复制代码]').click()`);await waitFor(`!${markdown}.querySelector('[role=alert]')`);
  await js(`${markdown}.querySelector('a').click()`);await waitFor(`${markdown}.querySelector('a')!==null`);await new Promise(r=>setTimeout(r,40));
  assert.deepEqual(links,['https://example.com/docs']);assert.equal(await js('location.href'),url+'/');
  failLink=true;await js(`${markdown}.querySelector('a').click()`);await waitFor(`${markdown}.querySelector('[role=alert]')?.textContent.includes('无法打开链接')`);failLink=false;
  await js(`${markdown}.querySelector('a').click()`);await waitFor(`!${markdown}.querySelector('[role=alert]')`);
  await js("document.querySelector('.saved-plan summary').click()");await waitFor("document.querySelector('.saved-plan h1')?.textContent==='Markdown 验收'");
  assert.equal(await js("document.querySelector('.saved-plan pre code').textContent"),markdownCode);
  await js("document.querySelector('.saved-plan summary').click()");
  const runId=state.tasks[0].currentRunId, streaming='## 流式回复\n\n```ts\nconst text = "正在生成";';
  win.webContents.send('task:delta',{kind:'reset',taskId:t,runId,version:1,text:''});
  win.webContents.send('task:delta',{kind:'append',taskId:t,runId,version:2,offset:0,text:streaming});
  await waitFor("document.querySelector('.streaming-reply h2')?.textContent==='流式回复'");
  assert.match(await js("document.querySelector('.streaming-reply code').textContent"),/正在生成/);
  win.webContents.send('task:delta',{kind:'append',taskId:t,runId,version:3,offset:streaming.length,text:'\n```\n\n**生成完成**'});
  await waitFor("document.querySelector('.streaming-reply .markdown-body strong')?.textContent==='生成完成'");
  win.webContents.send('task:delta',{kind:'end',taskId:t,runId,version:4,text:''});await waitFor("!document.querySelector('.streaming-reply')");
  const longReply='# 长回复\n\n'+'较长的流式正文。'.repeat(3000);
  win.webContents.send('task:delta',{kind:'reset',taskId:t,runId,version:5,text:''});
  win.webContents.send('task:delta',{kind:'append',taskId:t,runId,version:6,offset:0,text:longReply});
  await waitFor("document.querySelector('.streaming-reply h1')?.textContent==='长回复'");
  await js("window.streamRenders=0;window.streamObserver=new MutationObserver(()=>window.streamRenders++);window.streamObserver.observe(document.querySelector('.streaming-reply .markdown-body'),{subtree:true,childList:true,characterData:true});");
  let streamOffset=longReply.length;
  for(let i=0;i<12;i++){
    const text=` 增量${i}`;win.webContents.send('task:delta',{kind:'append',taskId:t,runId,version:7+i,offset:streamOffset,text});streamOffset+=text.length;
    await new Promise(r=>setTimeout(r,40));
  }
  await waitFor("document.querySelector('.streaming-reply').textContent.includes('增量11')");
  assert.ok(await js('window.streamRenders')<=4,'long stream should bound Markdown reparses');
  await js('window.streamObserver.disconnect()');
  win.webContents.send('task:delta',{kind:'end',taskId:t,runId,version:19,text:''});await waitFor("!document.querySelector('.streaming-reply')");
  if(process.env.JALO_MARKDOWN_SCREENSHOT){await js(`${markdown}.scrollIntoView({block:'center'})`);await new Promise(r=>setTimeout(r,80));fs.writeFileSync(process.env.JALO_MARKDOWN_SCREENSHOT,(await win.webContents.capturePage()).toPNG());}
  await revealEvent('tool-a');assert.equal(await js("document.querySelector('[data-event-id=\"tool-a\"]').open"),true);
  await revealEvent('event-20');
  await new Promise(r=>setTimeout(r,80));
  assert.match(await js("document.querySelector('.context-usage').textContent"),/本轮压缩 2 次/);
  await js("document.querySelector('.context-usage summary').click()");
  assert.equal(await js("document.querySelector('.context-usage progress').max"),16384);
  assert.ok(await js("document.querySelector('.context-usage').getBoundingClientRect().height<=160"));
  await js("document.querySelector('.context-usage summary').click()");
  await waitFor("Math.abs(document.querySelector('[data-event-id=\"event-20\"]').getBoundingClientRect().top-document.querySelector('.conversation').getBoundingClientRect().top)<3");
  await input('看看 @index');await waitFor("document.querySelectorAll('.mention-menu [role=option]').length===2");
  assert.equal(await js("!!document.querySelector('.reference-modal')"),false);
  assert.equal(await js("document.elementFromPoint(document.querySelector('.mention-menu').getBoundingClientRect().left+20,document.querySelector('.mention-menu').getBoundingClientRect().top+20)?.closest('.mention-menu')!==null"),true);
  await key('ArrowDown');await key('Enter');
  await waitFor("document.querySelector('.reference-chips').textContent.includes('src/second/index.vue · 整个文件')");
  assert.equal(await js("document.querySelector('textarea').value"),'看看 src/second/index.vue ');
  await js("Array.from(document.querySelectorAll('.reference-chips button')).find(e=>e.textContent.includes('src/second/index.vue')).click()");
  await waitFor("document.querySelector('.file-preview')?.textContent.includes('共 739 行')");
  assert.equal(await js("document.querySelector('select[aria-label=引用范围]').value"),'file');
  assert.equal(await js("document.querySelectorAll('.file-preview pre button').length"),100);
  await js("document.querySelector('.file-preview pre button').click()");
  assert.equal(await js("document.querySelector('select[aria-label=引用范围]').value"),'lines');
  await js("(()=>{const e=document.querySelector('select[aria-label=引用范围]');e.value='file';e.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await js("Array.from(document.querySelectorAll('.reference-modal button')).find(e=>e.textContent==='引用整个文件').click()");
  await input('联系 mail@example.com');assert.equal(await js("!!document.querySelector('.mention-menu')"),false);
  await input('看看 @index');await waitFor("document.querySelectorAll('.mention-menu [role=option]').length===2");await key('Escape');
  assert.equal(await js("!!document.querySelector('.mention-menu')"),false);assert.equal(await js("document.querySelector('textarea').value"),'看看 @index');
  await input('@binary');await waitFor("document.querySelectorAll('.mention-menu [role=option]').length===1");await key('Enter');
  await waitFor("document.querySelector('.mention-menu [role=alert]')?.textContent.includes('二进制')");
  assert.equal(await js("document.querySelector('textarea').value"),'@binary');
  await input('修改后的草稿 A');await js("document.querySelectorAll('.project-item')[1].click()");
  await waitFor("document.querySelector('textarea').value==='草稿 B'");await input('修改后的草稿 B');
  assert.equal(await js("!!document.querySelector('.context-usage')"),false);
  await js("document.querySelectorAll('.project-item')[0].click()");await waitFor("document.querySelector('textarea').value==='修改后的草稿 A'");
  assert.match(await js("document.querySelector('.reference-chips').textContent"),/a.txt/);
  await waitFor("document.querySelector('[data-event-id=\"event-20\"]') && Math.abs(document.querySelector('[data-event-id=\"event-20\"]').getBoundingClientRect().top-document.querySelector('.conversation').getBoundingClientRect().top)<3");
  await js("document.querySelector('.new-task').click()");await waitFor("document.querySelector('textarea').value===''");
  await input('新任务草稿');await js("document.querySelector('button[aria-label=\"发送任务\"]').click()");
  await waitFor("document.querySelector('[role=alert]')?.textContent.includes('模拟提交失败')");assert.equal(await js("document.querySelector('textarea').value"),'新任务草稿');
  failSubmit=false;await js("document.querySelector('button[aria-label=\"发送任务\"]').click()");await waitFor("document.querySelector('textarea').value===''");
  await js("document.querySelector('.new-task').click()");assert.equal(await js("document.querySelector('textarea').value"),'');
  await js("Array.from(document.querySelectorAll('.task-item')).find(e=>e.title==='任务 A').click()");
  await waitFor("document.querySelector('textarea').value==='修改后的草稿 A'");
  await waitFor("document.querySelector('[data-event-id=\"event-20\"]') && Math.abs(document.querySelector('[data-event-id=\"event-20\"]').getBoundingClientRect().top-document.querySelector('.conversation').getBoundingClientRect().top)<3");
  await input('关闭前最后草稿');await new Promise(resolve=>{win.once('closed',resolve);win.close();});
  await openWindow(url);await waitFor("document.querySelector('textarea').value==='关闭前最后草稿'");
  assert.match(await js("document.querySelector('.reference-chips').textContent"),/src\/second\/index.vue · 整个文件/);
  await input('@index');await waitFor("document.querySelectorAll('.mention-menu [role=option]').length===2");
  delayReference=true;await key('Enter');await waitFor("document.querySelector('textarea').readOnly");
  await waitFor("document.querySelector('[data-event-id=\"event-20\"]') && Math.abs(document.querySelector('[data-event-id=\"event-20\"]').getBoundingClientRect().top-document.querySelector('.conversation').getBoundingClientRect().top)<3");
  await js("document.querySelectorAll('.project-item')[1].click()");await waitFor("document.querySelector('textarea').value==='修改后的草稿 B'");
  await new Promise(r=>setTimeout(r,500));assert.equal(await js("!!document.querySelector('.reference-chips')"),false);
  await new Promise(resolve=>{win.once('closed',resolve);win.close();});
  const longId=randomUUID(), longTask=makeTask(longId,p);
  longTask.title='长历史任务';
  longTask.events=Array.from({length:10000},(_,i)=>({id:`long-${i}`,at:i,kind:i%3===0?'message':'notice',role:'assistant',text:i%3===0?'## 回复 '+i+'\n\n'+('不同高度的正文。'.repeat(i%9+1)): '进度 '+i}));
  longTask.events[990]={id:'long-call',at:990,kind:'tool',toolCallId:'long-tool',toolPhase:'call',text:'read_file {"path":"a.txt"}'};
  longTask.events[991]={id:'long-result',at:991,kind:'tool',toolCallId:'long-tool',toolPhase:'result',text:'read_file 结果\n'+('展开正文\n'.repeat(50))};
  state.tasks.unshift(longTask,...Array.from({length:2000},(_,i)=>({...makeTask(randomUUID(),p),title:'列表任务 '+i,events:[]})));
  session.update({...emptyView(p,longId),scroll:{top:0,follow:false,anchor:'long-1000',offset:-12,expanded:['long-call','long-result']}});session.flush();
  const beforeJump=eventRequests.length;await openWindow(url,'long-1000');
  await waitFor("Math.abs(document.querySelector('[data-event-id=\"long-1000\"]').getBoundingClientRect().top-document.querySelector('.conversation').getBoundingClientRect().top+12)<3");
  assert.equal(eventRequests.length-beforeJump,1);assert.equal(eventRequests.at(-1).around,'long-1000');
  assert.ok(await js("document.querySelectorAll('.timeline-row').length<60"));
  assert.ok(await js("document.querySelectorAll('.task-history-row').length<40"));
  await revealEvent('long-call');assert.equal(await js("document.querySelector('[data-event-id=\"long-call\"]').open"),true);
  await js("document.querySelector('[data-event-id=\"long-call\"] summary').click()");await new Promise(r=>setTimeout(r,120));
  assert.equal(await js("document.querySelector('[data-event-id=\"long-call\"]').open"),false);
  await js("document.querySelector('[data-event-id=\"long-call\"] summary').click()");await new Promise(r=>setTimeout(r,120));
  assert.equal(await js("document.querySelector('[data-event-id=\"long-call\"]').open"),true);
  await revealEvent('long-1035');await waitFor("!document.querySelector('[data-event-id=\"long-call\"]')");
  await revealEvent('long-call');assert.equal(await js("document.querySelector('[data-event-id=\"long-call\"]').open"),true);
  await revealEvent('long-1000');
  const beforeResize=await js("document.querySelector('[data-event-id=\"long-1000\"]').getBoundingClientRect().top-document.querySelector('.conversation').getBoundingClientRect().top");
  win.setSize(1180,940);
  await waitFor(`document.querySelector('[data-event-id="long-1000"]') && Math.abs(document.querySelector('[data-event-id="long-1000"]').getBoundingClientRect().top-document.querySelector('.conversation').getBoundingClientRect().top-(${beforeResize}))<3`);
  fs.writeFileSync(path.join(os.tmpdir(),'jalo-history-ui.png'),(await win.webContents.capturePage()).toPNG());
  for(let i=0;i<8;i++){
    await js("document.querySelector('.conversation').scrollTop=0");await new Promise(r=>setTimeout(r,60));
    const previousRequests=eventRequests.length;
    await js("Array.from(document.querySelectorAll('.history-pagination button')).find(b=>b.textContent==='加载更早记录').click()");
    await waitFor("!Array.from(document.querySelectorAll('.history-pagination button')).some(b=>b.disabled && b.textContent.includes('正在加载'))");
    assert.ok(eventRequests.length>previousRequests);
  }
  assert.ok(await js("Number(document.querySelector('.virtual-timeline').dataset.loadedRows)<=600"));
  assert.ok(await js("document.querySelectorAll('.timeline-row').length<60"));
  await js("document.querySelector('.latest-button').click()");
  await waitFor("!Array.from(document.querySelectorAll('.history-pagination button')).some(b=>b.textContent==='加载较新记录')");
  await waitFor("document.querySelector('.conversation').scrollHeight-document.querySelector('.conversation').clientHeight-document.querySelector('.conversation').scrollTop<=4");
  for(let i=0;i<3;i++){
    longTask.events.push({id:`live-${i}`,at:10000+i,kind:'message',role:'assistant',text:'## 实时追加 '+i+'\n\n'+('较长内容。\n\n'.repeat(10+i))});fixtureUpdate(longTask);
    await waitFor(`document.querySelector('[data-event-id="live-${i}"]')`);
    await waitFor("document.querySelector('.conversation').scrollHeight-document.querySelector('.conversation').clientHeight-document.querySelector('.conversation').scrollTop<=4");
  }
  await js("document.querySelector('.task-item').focus();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));");
  await waitFor("document.activeElement.dataset.taskSelect==='2002'");
  await js("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))");
  await waitFor("document.activeElement.dataset.taskSelect==='0'");
  const setField=(label,value)=>js(`(()=>{const field=document.querySelector('input[aria-label="${label}"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,${JSON.stringify(value)});field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await setField('搜索历史任务','列表任务 1999');await waitFor("document.querySelectorAll('.task-item').length===1 && document.querySelector('.task-item').title==='列表任务 1999'");
  await js("document.querySelector('button[aria-label=\"重命名任务：列表任务 1999\"]').click()");
  await waitFor("document.querySelector('input[aria-label=任务名称]')");await setField('任务名称','列表任务 1999 已重命名');
  await js("document.querySelector('form[aria-label=重命名任务]').requestSubmit()");
  await waitFor("!document.querySelector('form[aria-label=重命名任务]') && document.querySelector('.task-item')?.title==='列表任务 1999 已重命名'");
  await js("document.querySelector('button[aria-label=\"归档任务：列表任务 1999 已重命名\"]').click()");
  await waitFor("!document.querySelector('.task-item')");
  await js("document.querySelectorAll('.history-tabs button')[1].click()");
  await waitFor("document.querySelector('.task-item')?.title==='列表任务 1999 已重命名'");
  await js("document.querySelector('button[aria-label=\"恢复任务：列表任务 1999 已重命名\"]').click()");await waitFor("!document.querySelector('.task-item')");
  await js("document.querySelectorAll('.history-tabs button')[0].click()");await waitFor("document.querySelector('.task-item')?.title==='列表任务 1999 已重命名'");
}).then(()=>finish()).catch(finish);
