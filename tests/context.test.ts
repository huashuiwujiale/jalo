import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { compactContext, contextUsage } from '../engine/context';
import { modelMessages } from '../shared/context';
import { ContextMeter } from '../src/context-usage';
import type { Message } from '../shared/types';

let id = 0;
function group(name: string, args: unknown, result: string): Message[] {
  const callId = String(++id);
  return [{role:'assistant',content:null,tool_calls:[{id:callId,type:'function',function:{name,arguments:JSON.stringify(args)}}]}, {role:'tool',tool_call_id:callId,content:result}];
}
const longRead = () => group('read_file',{path:'large.ts'},'共 200 行；版本 abcdef123456\n' + 'source\n'.repeat(5000));
const facts = (messages: Message[]) => messages.flatMap(m => m.contextMemory?.facts || []);

test('compaction keeps evidence, refusal, failure and middle-of-reply pending work across repeated passes', () => {
  const original: Message[] = [
    {role:'system',content:'每条命令逐次确认'}, {role:'user',content:'删除新增，保留导出；不要编译'},
    ...group('edit_file',{path:'a.vue'},'工具未成功：oldText 不匹配，未写入'),
    ...group('replace_lines',{path:'a.vue',startLine:3,endLine:8},'已修改 a.vue（语法检查通过）\n-diff'),
    ...group('run_command',{command:'npm test'},'用户拒绝了该命令。未执行，不得尝试通过其他工具绕过。'),
    {role:'assistant',content:'说明\n'.repeat(800) + '剩余事项：需人工确认导出按钮仍可用\n' + '结语\n'.repeat(800)},
    ...longRead(),
  ];
  const first = compactContext(original,[],12000,1024);
  assert.equal(first.compacted,true);
  assert.deepEqual(first.messages.filter(m=>m.role==='user'),original.filter(m=>m.role==='user'));
  const before = facts(first.messages);
  assert.ok(before.some(f=>f.status==='written' && f.target.includes('a.vue')));
  assert.ok(before.some(f=>f.status==='denied' && f.target.includes('npm test')));
  assert.ok(before.some(f=>f.status==='failed' && f.detail.includes('oldText')));
  assert.ok(first.messages.some(m=>m.contextMemory?.notes.includes('剩余事项：需人工确认导出按钮仍可用')));
  const second = compactContext([...first.messages,...longRead(),{role:'user',content:'改为只检查，不要继续修改'}],[],12000,1024);
  assert.equal(second.compacted,true);
  for (const fact of before) assert.ok(facts(second.messages).some(f=>JSON.stringify(f)===JSON.stringify(fact)));
  assert.equal(second.messages.at(-1)?.content,'改为只检查，不要继续修改');
  assert.ok(second.usage.inputTokens + second.usage.outputReserve + second.usage.safetyReserve <= second.usage.contextLength);
  assert.ok(second.usage.beforeTokens > second.usage.inputTokens);
});

test('plain text, no-op writes and failed commands cannot become successful write evidence', () => {
  const result = compactContext([
    {role:'user',content:'修改 a.txt'}, {role:'assistant',content:'我已修改 imaginary.txt'},
    ...group('write_file',{path:'a.txt'},'内容没有变化，未写入'),
    ...group('run_command',{command:'test-command'},'退出码：1\n实际检查失败'),
    ...group('run_command',{command:'slow-command'},'退出码：0；命令超时，已终止\npartial'),
    ...longRead(),
  ],[],14000,1024);
  assert.equal(result.compacted,true);
  assert.equal(facts(result.messages).filter(f=>f.status==='written').length,0);
  assert.equal(facts(result.messages).filter(f=>f.tool==='run_command' && f.status==='failed').length,2);
  assert.ok(result.messages.some(m=>m.contextMemory?.notes.includes('我已修改 imaginary.txt')));
});

test('all user boundaries and complete multi-call groups retain chronological order', () => {
  const calls = ['one','two'].map(id=>({id,type:'function' as const,function:{name:'read_file',arguments:'{"path":"a.ts"}'}}));
  const recent: Message[] = [{role:'assistant',content:null,tool_calls:calls},...calls.map(c=>({role:'tool' as const,tool_call_id:c.id,content:'ok'}))];
  const result = compactContext([{role:'user',content:'old'},...longRead(),{role:'user',content:'new'},...recent],[],9000,1024);
  assert.deepEqual(result.messages.slice(-3),recent);
  assert.equal(result.messages[result.messages.length-4].content,'new');
  for (const message of result.messages.filter(m=>m.role==='tool')) assert.ok(result.messages.some(m=>m.tool_calls?.some(c=>c.id===message.tool_call_id)));
});

test('directory instructions survive compression and oversized requirements fail explicitly', () => {
  const instructions='尚未执行操作。请先遵守以下新发现的项目指令，然后重新调用工具：\n项目指令 src/AGENTS.md（适用于该目录及子目录）：\n不要修改导出按钮';
  const result = compactContext([{role:'user',content:'改页面'},...group('edit_file',{path:'src/a.vue'},instructions),...longRead()],[],9000,1024);
  assert.ok(result.messages.some(m=>m.contextMemory?.instructions.includes(instructions)));
  assert.equal(facts(result.messages).filter(f=>f.status==='written').length,0);
  assert.throws(()=>compactContext([{role:'user',content:'必须保留'.repeat(9000)}],[],4096,1024),/未静默丢弃/);
});

test('internal memory persists through JSON but is excluded from model payload and token estimate', () => {
  const messages: Message[]=[{role:'assistant',content:'摘要',contextMemory:{version:1,facts:[],notes:['private'.repeat(1000)],instructions:[]}}];
  assert.deepEqual(JSON.parse(JSON.stringify(messages)),messages);
  assert.equal('contextMemory' in modelMessages(messages)[0],false);
  assert.equal(contextUsage(messages,[],8192,1024).inputTokens,contextUsage(modelMessages(messages),[],8192,1024).inputTokens);
  const usage=contextUsage(messages,[{type:'function',function:{name:'test',description:'说明',parameters:{}}}],8192,1024);
  assert.ok(usage.toolTokens>0);assert.equal(usage.safetyReserve,1639);
  const html=renderToStaticMarkup(React.createElement(ContextMeter,{usage:{...usage,compactions:2,beforeTokens:9000}}));
  assert.match(html,/估算/);assert.match(html,/压缩 2 次/);assert.match(html,/输出预留/);assert.match(html,/9,000/);
  assert.equal(renderToStaticMarkup(React.createElement(ContextMeter,{})),'');
});
