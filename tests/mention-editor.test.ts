import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editorText } from '../src/mention-editor';

// DOM-shaped fixtures exercise serialization without adding a browser dependency to npm test.
const text=(textContent:string)=>({nodeType:3,textContent,childNodes:[]} as unknown as Node);
const element=(tagName:string,childNodes:Node[]=[],dataset:Record<string,string>={})=>({nodeType:1,tagName,childNodes,lastChild:childNodes.at(-1),dataset} as unknown as Node);
const br=()=>element('BR');

test('inline reference labels serialize as exact paths, with ordinary text unchanged', () => {
  const root=element('DIV',[text('请修改 '),element('SPAN',[text('index.vue')],{referencePath:'src/sale/index.vue'}),text('，参考 '),element('SPAN',[text('index.vue')],{referencePath:'src/member/index.vue'}),text('。')]);
  assert.equal(editorText(root),'请修改 src/sale/index.vue，参考 src/member/index.vue。');
  assert.equal(editorText(element('DIV',[text('<img src=x>')])),'<img src=x>');
});

test('Chromium empty-line placeholders do not add extra newlines or remove intentional blank lines', () => {
  assert.equal(editorText(element('DIV',[br()])),'');
  assert.equal(editorText(element('DIV',[text('第一行'),element('DIV',[br()])])),'第一行\n');
  assert.equal(editorText(element('DIV',[text('第一行\n'),element('DIV',[br()])])),'第一行\n\n');
  assert.equal(editorText(element('DIV',[text('第一行'),br(),br()])),'第一行\n');
  assert.equal(editorText(element('DIV',[element('DIV',[br()]),element('DIV',[br()]),element('DIV',[text('第三行')])])),'\n\n第三行');
  assert.equal(editorText(element('DIV',[text('第一行\n\n第三行\n'),element('BR',[],{editorTail:''})])),'第一行\n\n第三行\n');
  const selectedFragment={nodeType:11,childNodes:[text('选中的换行'),br()]} as unknown as Node;
  assert.equal(editorText(selectedFragment),'选中的换行\n');
});
