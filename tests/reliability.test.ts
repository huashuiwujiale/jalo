import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { ToolRegistry, toolsForMode } from '../engine/tools';
import { TaskRunner } from '../engine/runner';
import { checkSyntax, version } from '../engine/syntax';
import { captureReferences, previewFile, searchFiles, rollbackPreview, restoreFile } from '../engine/project-files';
import { Store } from '../electron/store';
import { defaults, type EngineEvent, type Mode, type Run, type RunChange, type Task } from '../shared/types';
import initSqlJs from 'sql.js';
const vue = `<template>
  <div>
    <el-button
      v-hasPermi="['sale:voucher:add']"
      type="primary"
      plain
      icon="el-icon-plus"
      size="mini"
      @click="handleAdd"
      >新增</el-button
    >
    <el-button @click="handleExport">导出</el-button>
  </div>
</template>
<script>export default { methods: { handleAdd() {}, handleExport() {} } }</script>
`;
async function fixture(mode: Mode = 'execute') {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'jalo-reliable-')), root = path.join(home, 'project');
  await fs.mkdir(root); await fs.writeFile(path.join(root, 'package.json'), '{"dependencies":{"vue":"^2.6.12"}}'); await fs.writeFile(path.join(root, 'index.vue'), vue);
  const events: EngineEvent[] = [], checkpoints: RunChange[] = []; const signal = new AbortController();
  const tools = new ToolRegistry({ root, backupDir: path.join(home, 'backup'), signal: signal.signal, timeout: 1, mode, runId: randomUUID(), emit: e => events.push(e), approve: async () => { throw new Error('read-only mode must never ask for approval'); }, checkpoint: async c => { checkpoints.push(structuredClone(c)); } });
  await tools.init(); return { root, home, tools, events, checkpoints, signal, cleanup: () => fs.rm(home, { recursive: true, force: true }) };
}
test('Vue 2 multi-line Add removal preserves Export; partial tag deletion never writes', async () => {
  const x = await fixture();
  try {
    await x.tools.execute('read_file', { path: 'index.vue' });
    await assert.rejects(x.tools.execute('replace_lines', { path: 'index.vue', startLine: 3, endLine: 3, newText: '' }), /语法检查失败/);
    assert.equal(await fs.readFile(path.join(x.root, 'index.vue'), 'utf8'), vue); assert.equal(x.checkpoints.length, 0);
    await x.tools.execute('replace_lines', { path: 'index.vue', startLine: 3, endLine: 11, newText: '' });
    const after = await fs.readFile(path.join(x.root, 'index.vue'), 'utf8'); assert.ok(!after.includes('>新增')); assert.ok(after.includes('>导出'));
    assert.equal(x.checkpoints[0].state, 'prepared');
    const change = x.events.find(e => e.type === 'change'); assert.ok(change?.type === 'change'); assert.equal(change.checkpoint?.state, 'written'); assert.equal(change.checkpoint?.afterVersion, version(after));
    assert.equal(change.checkpoint?.check.status, 'passed');
  } finally { await x.cleanup(); }
});
test('plan and review hide mutation definitions and block direct malicious calls', async () => {
  for (const mode of ['plan','review'] as const) {
    const x = await fixture(mode);
    try {
      const mutation = ['write_file','edit_file','replace_lines','run_command'];
      assert.ok(toolsForMode(mode).every(d => !mutation.includes(d.function.name)));
      for (const name of mutation) await assert.rejects(x.tools.execute(name, { path: 'index.vue', command: 'touch BAD' }), /只读模式/);
      assert.equal(await fs.readFile(path.join(x.root, 'index.vue'), 'utf8'), vue); await assert.rejects(fs.access(path.join(x.root, 'BAD')));
      const responses: any[] = [{ message: { role: 'assistant', content: null, tool_calls: [{ id:'bad', type:'function', function:{name:'write_file',arguments:JSON.stringify({path:'bad',content:'bad'})} }] },finishReason:'tool_calls' }, {message:{role:'assistant',content:'只读检查结束，没有执行修改。'},finishReason:'stop'}];
      const provider: any = { generate: async (_m: any, defs: any[]) => { assert.ok(defs.every(d => !mutation.includes(d.function.name))); return responses.shift(); } };
      await new TaskRunner(provider, x.tools, defaults, e => x.events.push(e), x.signal.signal).run({messages:[{role:'user',content:'检查页面'}]}, false);
      await assert.rejects(fs.access(path.join(x.root,'bad')));
    } finally { await x.cleanup(); }
  }
});
test('JS TS JSON syntax errors are blocked; existing invalid source pauses edits', async () => {
  for (const [file, good, bad] of [['x.ts','const x: number = 1','const x: ='],['x.js','const x = 1','const ='],['x.json','{"a":1}','{"a":}'],['x.vue',vue,vue.replace('</div>','</span>')]]) {
    assert.equal(checkSyntax(file,good,2).status,'passed'); assert.equal(checkSyntax(file,bad,2).status,'failed');
  }
  assert.equal(checkSyntax('x.vue', '<template><div>{{ a + }}</div></template>', 3).status, 'failed');
  assert.equal(checkSyntax('x.vue', '<template><el-input :value="item.name"/></template>', 2).status, 'passed');
  assert.equal(checkSyntax('x.py','bad python').status,'skipped');
  const x = await fixture();
  try { await fs.writeFile(path.join(x.root,'x.ts'),'const x: ='); await x.tools.execute('read_file',{path:'x.ts'}); await assert.rejects(x.tools.execute('write_file',{path:'x.ts',content:'const x = 1'}),/原文件已有语法错误/); assert.equal(await fs.readFile(path.join(x.root,'x.ts'),'utf8'),'const x: ='); }
  finally { await x.cleanup(); }
});
test('three syntax failures halt runner and do not write any candidate', async () => {
  const x = await fixture();
  try {
    const tool = (name: string, args: any) => ({ message:{ role:'assistant',content:null,tool_calls:[{id:randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}]},finishReason:'tool_calls'});
    const replies = [tool('read_file',{path:'index.vue'}),...Array.from({length:3},()=>tool('replace_lines',{path:'index.vue',startLine:3,endLine:3,newText:''}))];
    await new TaskRunner({generate:async()=>replies.shift()} as any,x.tools,defaults,e=>x.events.push(e),x.signal.signal).run({messages:[{role:'user',content:'去掉新增按钮'}]},false);
    const done = x.events.at(-1) as any; assert.equal(done.status,'failed'); assert.match(done.error,/连续 3 次/); assert.deepEqual(done.evidence.changedFiles,[]); assert.equal(await fs.readFile(path.join(x.root,'index.vue'),'utf8'),vue);
  } finally { await x.cleanup(); }
});
test('references re-read disk and reject wrong project, missing files, links, traversal, stale versions and bad ranges', async () => {
  const x = await fixture();
  try {
    const project = {id:randomUUID(),name:'fixture',path:x.root}, page = await previewFile(x.root,'index.vue');
    const ref = {projectId:project.id,path:page.path,startLine:3,endLine:11,version:page.version};
    const [capture] = await captureReferences(project,[ref]); assert.match(capture.content,/新增/); assert.ok(!capture.content.includes('导出'));
    await assert.rejects(captureReferences(project,[{...ref,projectId:randomUUID()}]),/其他项目/);
    await assert.rejects(captureReferences(project,[{...ref,path:'missing'}]),/不存在/);
    await assert.rejects(captureReferences(project,[{...ref,path:'../elsewhere'}]),/越出/);
    await fs.symlink('index.vue',path.join(x.root,'link.vue')); await assert.rejects(captureReferences(project,[{...ref,path:'link.vue'}]),/符号链接/);
    await assert.rejects(captureReferences(project,[{...ref,endLine:500}]),/范围越界/);
    await fs.writeFile(path.join(x.root,'index.vue'),vue+'\n'); await assert.rejects(captureReferences(project,[ref]),/外部修改/);
    assert.ok(!(await searchFiles(x.root,'.vue')).paths.includes('link.vue'));
    await fs.mkdir(path.join(x.root,'other')); await fs.writeFile(path.join(x.root,'other/index.vue'),vue);
    assert.deepEqual((await searchFiles(x.root,'index.vue')).paths.sort(),['index.vue','other/index.vue']);
    await fs.writeFile(path.join(x.root,'long.txt'),Array.from({length:250},(_,i)=>`line ${i}`).join('\n')); const first=await previewFile(x.root,'long.txt'); const second=await previewFile(x.root,'long.txt',first.endLine+1); assert.equal(first.hasMore,true); assert.equal(second.startLine,first.endLine+1);
  } finally { await x.cleanup(); }
});
test('independent runs, safe rollback, new-file recovery, and conflict preservation', async () => {
  const x = await fixture();
  try {
    await x.tools.execute('write_file',{path:'a.txt',content:'one'}); const one = (x.events.find(e=>e.type==='change') as any).checkpoint as RunChange;
    const events: EngineEvent[]=[]; const second=new ToolRegistry({root:x.root,backupDir:path.join(x.home,'second'),signal:x.signal.signal,timeout:1,runId:randomUUID(),emit:e=>events.push(e),approve:async()=>false,changes:[]}); await second.init();
    await second.execute('read_file',{path:'a.txt'}); await second.execute('edit_file',{path:'a.txt',oldText:'one',newText:'two'}); const two=(events.find(e=>e.type==='change') as any).checkpoint as RunChange;
    assert.equal(two.before,'one'); assert.equal(one.before,null); assert.notEqual(one.runId,two.runId);
    await assert.rejects(rollbackPreview(x.root,one),/冲突/); assert.match(await rollbackPreview(x.root,two),/-two/);
    await fs.writeFile(path.join(x.root,'a.txt'),'manual'); await assert.rejects(restoreFile(x.root,two,path.join(x.home,'recovery')),/冲突/); assert.equal(await fs.readFile(path.join(x.root,'a.txt'),'utf8'),'manual');
    await fs.writeFile(path.join(x.root,'a.txt'),'two'); await restoreFile(x.root,two,path.join(x.home,'recovery')); assert.equal(await fs.readFile(path.join(x.root,'a.txt'),'utf8'),'one');
    const log=await restoreFile(x.root,one,path.join(x.home,'recovery')); await assert.rejects(fs.access(path.join(x.root,'a.txt'))); assert.equal(JSON.parse(await fs.readFile(log,'utf8')).after,'one');
    await assert.rejects(rollbackPreview(x.root,{...one,state:'uncertain'}),/核验/);
  } finally { await x.cleanup(); }
});
test('database upgrade backs up original bytes, preserves history and persists runs/checkpoints', async () => {
  const x=await fixture();
  try {
    const file=path.join(x.home,'old.sqlite'); const SQL=await initSqlJs(); const raw=new SQL.Database(); raw.run('CREATE TABLE tasks (id TEXT PRIMARY KEY,data TEXT NOT NULL)');
    const old:Task={id:'old',projectId:'p',title:'history',model:'m',status:'completed',createdAt:1,messages:[],events:[],changes:[]};raw.run('INSERT INTO tasks VALUES (?,?)',[old.id,JSON.stringify(old)]); const bytes=Buffer.from(raw.export());await fs.writeFile(file,bytes);raw.close();
    const store=await Store.open(file); assert.equal(store.tasks()[0].legacy,true); const backup=(await fs.readdir(x.home)).find(n=>n.includes('before-v2')); assert.ok(backup); assert.deepEqual(await fs.readFile(path.join(x.home,backup)),bytes);
    await x.tools.execute('write_file',{path:'a.txt',content:'persisted'}); const checkpoint=(x.events.find(e=>e.type==='change') as any).checkpoint as RunChange;
    const run:Run={id:checkpoint.runId,taskId:'new',mode:'execute',input:'create',status:'running',createdAt:1,references:[],changes:[checkpoint],checks:[checkpoint.check]};store.putTask({...old,id:'new',status:'running',currentRunId:run.id,runs:[run]});store.close();
    const reopened=await Store.open(file);const restored=reopened.tasks().find(t=>t.id==='new')!;assert.equal(restored.runs![0].status,'interrupted');assert.equal(restored.runs![0].changes[0].after,'persisted');assert.match(await rollbackPreview(x.root,restored.runs![0].changes[0]),/-persisted/);reopened.close();
  } finally { await x.cleanup(); }
});
test('checkpoint persistence failure and external edits during preparation both prevent commit', async () => {
  const x = await fixture();
  try {
    for (const tamper of [false,true]) {
      await fs.writeFile(path.join(x.root,'a.txt'),'before');
      const tools = new ToolRegistry({root:x.root,backupDir:path.join(x.home,'backup'),signal:x.signal.signal,timeout:1,runId:randomUUID(),emit:()=>{},approve:async()=>false,checkpoint:async()=>{if(tamper) await fs.writeFile(path.join(x.root,'a.txt'),'external');else throw new Error('persist failed');}});
      await tools.init();await tools.execute('read_file',{path:'a.txt'});
      await assert.rejects(tools.execute('write_file',{path:'a.txt',content:'candidate'}),tamper?/外部修改/:/persist failed/);
      assert.equal(await fs.readFile(path.join(x.root,'a.txt'),'utf8'),tamper?'external':'before');assert.deepEqual(tools.evidence().changedFiles,[]);
    }
  } finally {await x.cleanup();}
});
test('Vue version rules and syntax diagnostics report source lines', () => {
  const multi='<template><div/><div/></template>';
  assert.equal(checkSyntax('index.vue',multi,2).status,'failed');assert.equal(checkSyntax('index.vue',multi,3).status,'passed');
  const result=checkSyntax('index.vue','<template>\n<div>\n<span></div>\n</template>',3);assert.equal(result.status,'failed');assert.match(result.message,/第 \d+ 行/);
});
