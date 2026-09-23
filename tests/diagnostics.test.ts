import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { DiagnosticLog, diagnosticReport, errorCategory, LOG_LIMIT, saveDiagnosticReport } from '../electron/diagnostics';
import type { AppInfo, Task } from '../shared/types';

const info: AppInfo = { version:'0.2.0',packaged:true,platform:'darwin',arch:'arm64',electron:'38',chrome:'140',node:'22',osRelease:'25',dataDirectory:'/private/secret-data',logDirectory:'/private/secret-data/logs',logsAvailable:true };
async function fixture(fn: (home: string) => Promise<void>) { const home=await fs.mkdtemp(path.join(os.tmpdir(),'jalo-diagnostics-'));try { await fn(home); } finally { await fs.rm(home,{recursive:true,force:true}); } }
test('diagnostics persist only allowlisted metadata and omit task contents and raw errors', async () => fixture(async home => {
  const log=new DiagnosticLog(home), id=randomUUID();
  log.record({event:'task_phase',taskId:id,phase:'tool',tool:'read_file',step:2,token:'secret-token',text:'source-code'} as any);
  log.record({event:'ipc_error',channel:'secret-channel',errorCategory:errorCategory('HTTP 401 secret-token')});
  const raw=await fs.readFile(path.join(log.directory,'diagnostics.jsonl'),'utf8');
  assert.doesNotMatch(raw,/secret-token|source-code|secret-channel/);assert.match(raw,/read_file/);
  const task: Task = { id,projectId:'project-secret',title:'private-title',status:'failed',model:'private-model',createdAt:1,
    messages:[{role:'user',content:'private-prompt'}],events:[{id:'e',at:1,kind:'output',text:'private-command'}],changes:[{path:'private.vue',before:'private-source',after:'private-result',patch:'private-patch'}],error:'HTTP 401 secret-token' };
  const report=diagnosticReport(info,[task],log), json=JSON.stringify(report);
  for(const secret of ['secret-token','private-title','private-model','private-prompt','private-command','private.vue','private-source','private-result','private-patch','secret-data','project-secret']) assert.ok(!json.includes(secret),secret);
  assert.equal(report.tasks[0].errorCategory,'authentication');assert.equal(report.logs.entries.length,2);
  assert.equal((await fs.stat(path.join(log.directory,'diagnostics.jsonl'))).mode&0o777,0o600);
  assert.equal(new DiagnosticLog(home).read().entries[0].taskId,id);
}));
test('diagnostic logs rotate at a bounded size and exports bound and validate stored entries', async () => fixture(async home => {
  const log=new DiagnosticLog(home);log.record({event:'app_start'});
  const file=path.join(log.directory,'diagnostics.jsonl');
  await fs.writeFile(file,' '.repeat(LOG_LIMIT));log.record({event:'app_ready'});
  assert.equal((await fs.stat(path.join(log.directory,'diagnostics.1.jsonl'))).size,LOG_LIMIT);
  assert.ok((await fs.stat(file)).size<LOG_LIMIT);assert.equal(log.read().incomplete,true);
  const line=JSON.stringify({at:1,event:'app_start',text:'secret-from-old-log'})+'\n';
  await fs.writeFile(path.join(log.directory,'diagnostics.1.jsonl'),line.repeat(1001));
  const read=log.read();assert.equal(read.entries.length,1000);assert.equal(read.truncated,true);assert.doesNotMatch(JSON.stringify(read),/secret-from-old-log/);
  await fs.writeFile(file,' '.repeat(LOG_LIMIT));log.record({event:'app_quit'});
  assert.equal((await fs.readdir(log.directory)).length,2);
}));
test('logging IO failures remain nonfatal and unreadable logs are reported', async () => fixture(async home => {
  const blocked=path.join(home,'blocked');await fs.writeFile(blocked,'not a directory');
  const log=new DiagnosticLog(blocked);assert.doesNotThrow(()=>log.record({event:'app_start'}));
  assert.equal(log.available,false);assert.equal(log.read().incomplete,true);
  assert.equal(errorCategory('LM Studio 请求超时 secret'),'timeout');assert.equal(errorCategory('ENOENT private-file'),'file_missing');
  assert.equal(errorCategory('arbitrary secret'),'unknown');
}));
test('exports save privately and reject data directories, symlinks and hardlinks', async () => fixture(async home => {
  const data=path.join(home,'data'), output=path.join(home,'output');await fs.mkdir(data);await fs.mkdir(output);
  const log=new DiagnosticLog(data);log.record({event:'app_start'});const report=diagnosticReport(info,[],log);
  const file=path.join(output,'report.json');await saveDiagnosticReport(file,report,data);
  assert.equal(JSON.parse(await fs.readFile(file,'utf8')).app.version,'0.2.0');assert.equal((await fs.stat(file)).mode&0o777,0o600);
  await saveDiagnosticReport(file,report,data); // Native dialog already authorizes replacing this ordinary file.
  await assert.rejects(saveDiagnosticReport(path.join(data,'local-code.sqlite'),report,data),/数据目录之外/);
  const alias=path.join(home,'alias');await fs.symlink(data,alias);
  await assert.rejects(saveDiagnosticReport(path.join(alias,'report.json'),report,data),/数据目录之外/);
  const link=path.join(output,'link.json');await fs.symlink(file,link);await assert.rejects(saveDiagnosticReport(link,report,data),/链接/);
  const hard=path.join(output,'hard.json');await fs.link(file,hard);await assert.rejects(saveDiagnosticReport(hard,report,data),/链接/);
  assert.deepEqual((await fs.readdir(output)).sort(),['hard.json','link.json','report.json']);
}));
