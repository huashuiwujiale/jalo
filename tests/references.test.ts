import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { referenceFile, captureReferences, previewFile, referenceContext } from '../engine/project-files';
import { referenceSchema } from '../shared/validation';
import { emptyView, viewSchema } from '../shared/session';
import { mentionAt, insertMention } from '../src/mentions';

test('whole references capture every line beyond preview and range limits, retaining CRLF and version', async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'jalo-whole-'));
  try {
    const project={id:randomUUID(),name:'demo',path:root};
    const text=Array.from({length:739},(_,i)=>`第 ${i+1} 行`).join('\r\n');
    await fs.writeFile(path.join(root,'index.vue'),text);
    const ref=await referenceFile(project,'index.vue'), page=await previewFile(root,'index.vue');
    assert.equal(page.endLine,100);assert.equal(page.hasMore,true);
    assert.equal(ref.scope,'file');assert.equal(ref.endLine,739);assert.equal(referenceSchema.safeParse(ref).success,true);
    const [captured]=await captureReferences(project,[ref]);assert.equal(captured.content,text);
    assert.match(referenceContext([captured]),/整文件引用.*index.vue/);assert.match(referenceContext([captured]),/共 739 行/);
    assert.doesNotMatch(referenceContext([captured]),/第 739 行/);assert.match(referenceContext([captured]),/正文尚未放入上下文/);
    const saved=viewSchema.parse({...emptyView(project.id),references:[ref]});assert.equal(saved.references[0].scope,'file');
    const range={...ref,scope:'lines' as const,startLine:701,endLine:739};
    const [lines]=await captureReferences(project,[range]);assert.match(lines.content,/第 739 行/);assert.doesNotMatch(lines.content,/第 1 行/);
    assert.match(referenceContext([lines]),/第 739 行/);
    await assert.rejects(captureReferences(project,[{...ref,endLine:100}]),/整文件引用范围/);
    await assert.rejects(captureReferences(project,[{...ref,projectId:randomUUID()}]),/其他项目/);
    await fs.appendFile(path.join(root,'index.vue'),'changed');await assert.rejects(captureReferences(project,[ref]),/外部修改/);
    await fs.unlink(path.join(root,'index.vue'));await assert.rejects(captureReferences(project,[ref]),/不存在/);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
test('whole references support long lines and empty files, reject unsafe paths and size overflows',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'jalo-ref-limits-'));
  try {
    const project={id:randomUUID(),name:'demo',path:root};
    await fs.writeFile(path.join(root,'long.txt'),'x'.repeat(18000));
    await assert.rejects(previewFile(root,'long.txt'),/单行/);
    const ref=await referenceFile(project,'long.txt');assert.equal((await captureReferences(project,[ref]))[0].content.length,18000);
    await fs.writeFile(path.join(root,'empty.txt'),'');const empty=await referenceFile(project,'empty.txt');
    assert.equal((await captureReferences(project,[empty]))[0].content,'');
    await fs.symlink('long.txt',path.join(root,'link'));await assert.rejects(referenceFile(project,'link'),/符号链接/);
    await assert.rejects(referenceFile(project,'../escape'),/越出/);
    await fs.writeFile(path.join(root,'binary'),Buffer.from([0,1]));await assert.rejects(referenceFile(project,'binary'),/二进制/);
    await fs.writeFile(path.join(root,'large'),'x'.repeat(262145));await assert.rejects(referenceFile(project,'large'),/256 KB/);
    const refs=[];for(let i=0;i<3;i++){await fs.writeFile(path.join(root,`big-${i}`),'x'.repeat(180000));refs.push(await referenceFile(project,`big-${i}`));}
    await assert.rejects(captureReferences(project,refs),/512 KB/);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
test('legacy range references stay ranges and malformed whole references are rejected',()=>{
  const ref={projectId:randomUUID(),path:'a',startLine:1,endLine:100,version:'a'.repeat(64)};
  assert.equal(referenceSchema.parse(ref).scope,undefined);
  assert.equal(referenceSchema.safeParse({...ref,endLine:739}).success,false);
  assert.equal(referenceSchema.safeParse({...ref,scope:'file',endLine:739}).success,true);
  assert.equal(referenceSchema.safeParse({...ref,scope:'file',startLine:2,endLine:739}).success,false);
});
test('mentions use the caret and preserve surrounding text, without treating emails as references',()=>{
  assert.deepEqual(mentionAt('@',1),{start:0,end:1,query:''});
  assert.equal(mentionAt('mail@example.com',16),undefined);
  assert.equal(mentionAt('请修改 @src/ind 后保留说明',12,13),undefined);
  const text='请修改 @src/ind 后保留说明',mention=mentionAt(text,12)!;
  assert.equal(mention.query,'src/ind');
  const result=insertMention(text,mention,'src/member/index.vue');
  assert.equal(result.text,'请修改 src/member/index.vue  后保留说明');
  assert.equal(result.text.slice(0,result.caret),'请修改 src/member/index.vue ');
});
