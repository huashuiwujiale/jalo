import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { recoveryHint, recoverySummary, recoveryPrompt } from '../shared/progress';
import { RecoveryPanel, TaskProgress } from '../src/task-progress';
import { Store } from '../electron/store';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Task } from '../shared/types';
const task = (): Task => ({ id:'t',projectId:'p',title:'删除新增按钮',model:'m',status:'failed',createdAt:1,messages:[],events:[],changes:[],currentRunId:'r2',error:'模型响应超时',runs:[
  {id:'r1',taskId:'t',mode:'execute',input:'旧要求',createdAt:1,status:'completed',references:[],checks:[],changes:[{path:'old.vue',before:'a',after:'b',state:'written'} as any]},
  {id:'r2',taskId:'t',mode:'plan',input:'新要求',createdAt:2,status:'failed',references:[],checks:[],changes:[{path:'kept.vue',before:'a',after:'b',state:'written'} as any,{path:'reverted.vue',before:'a',after:'b',state:'reverted'} as any,{path:'uncertain.vue',state:'prepared'} as any],progress:{phase:'waiting_model',since:2,endedAt:3002}},
] });
test('recovery shows current run evidence only and preserves original mode and request', () => {
  const t = task(), summary = recoverySummary(t);
  assert.deepEqual(summary.written,['kept.vue']);assert.deepEqual(summary.uncertain,['uncertain.vue']);
  assert.equal(summary.run?.mode,'plan');assert.match(recoveryPrompt(t),/新要求/);assert.match(recoveryPrompt(t),/不要直接重放/);
  const html = renderToStaticMarkup(React.createElement(RecoveryPanel,{task:t,disabled:false,resume:()=>{},inspect:()=>{},settings:()=>{}}));
  assert.match(html,/kept.vue/);assert.match(html,/uncertain.vue/);assert.doesNotMatch(html,/old.vue|reverted.vue/);assert.match(html,/补充要求并继续/);
  assert.match(recoveryHint('无法连接 LM Studio'),/服务是否启动/);
  assert.match(recoveryHint('候选语法检查失败'),/当前原文/);
});
test('progress renders waiting separately and hides live counters after completion', () => {
  const t = task();t.status='running';
  assert.match(renderToStaticMarkup(React.createElement(TaskProgress,{task:t})),/等待模型响应/);
  t.status='failed';assert.equal(renderToStaticMarkup(React.createElement(TaskProgress,{task:t})), '');
});
test('restart freezes progress and marks uncertain checkpoints instead of resuming', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(),'jalo-progress-'));
  try {
    const file=path.join(home,'state.sqlite');let store=await Store.open(file);
    const t=task();t.status='running';t.runs![1].status='running';delete t.runs![1].progress!.endedAt;
    t.runs![1].contextUsage={inputTokens:5000,toolTokens:1200,outputReserve:1024,safetyReserve:3277,contextLength:16384,beforeTokens:9000,compactions:1};
    t.messages=[{role:'assistant',content:'摘要',contextMemory:{version:1,facts:[{tool:'run_command',target:'npm test',status:'denied',detail:'用户拒绝'}],notes:['剩余：人工验收'],instructions:[]}}];
    for (const run of t.runs!) for (const change of run.changes) { change.id = `${run.id}-${change.path}`; change.runId = run.id; }
    store.putTask(t);store.close();store=await Store.open(file);
    const restored=store.tasks()[0];assert.equal(restored.status,'interrupted');assert.ok(restored.runs![1].progress!.endedAt);
    assert.deepEqual(restored.runs![1].contextUsage,t.runs![1].contextUsage);
    assert.deepEqual(restored.messages,t.messages);
    assert.equal(restored.runs![1].changes[2].state,'uncertain');store.close();
  } finally { await fs.rm(home,{recursive:true,force:true}); }
});
