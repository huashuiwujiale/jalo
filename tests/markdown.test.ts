import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from '../src/markdown';
import { TimelineRows } from '../src/timeline-rows';
import { StreamingReply } from '../src/streaming-reply';
import { PlanActions } from '../src/history-controls';
import { webLink } from '../shared/markdown';
import type { Event, Run } from '../shared/types';

const render = (text: string) => renderToStaticMarkup(React.createElement(Markdown, { text }));
test('Markdown renders headings, nested lists, quotes, inline code, emphasis and GFM tables/tasks', () => {
  const html = render('# 保存计划\n\n**重点**和 *说明*、~~旧内容~~、`npm test`。\n\n1. 步骤一\n   - 子步骤\n2. 步骤二\n\n> 引用说明\n\n- [x] 已完成\n- [ ] 待验收\n\n| 项目 | 状态 |\n| --- | ---: |\n| 测试 | 通过 |');
  for (const pattern of [/<h1>保存计划<\/h1>/, /<strong>重点<\/strong>/, /<em>说明<\/em>/, /<del>旧内容<\/del>/, /<code>npm test<\/code>/, /<ol>/, /<ul>/, /<blockquote>/, /type="checkbox" disabled="" checked=""/, /class="markdown-table"/, /<table>/, /text-align:right/]) assert.match(html, pattern);
});

test('code fences and indented code preserve text and whitespace without interpreting markup', () => {
  const html = render('```vue\n<div title="&">\n  <script>alert("no")</script>\n</div>\n```\n\n    plain code\n      indented');
  assert.match(html, /markdown-code-header/); assert.match(html, />vue<\/span>/); assert.match(html, /aria-label="复制代码"/);
  assert.match(html, /<pre><code class="language-vue">&lt;div title=&quot;&amp;&quot;&gt;\n  &lt;script&gt;alert\(&quot;no&quot;\)&lt;\/script&gt;\n&lt;\/div&gt;\n<\/code><\/pre>/);
  assert.match(html, /<pre><code>plain code\n  indented\n<\/code><\/pre>/);
  assert.doesNotMatch(html, /<script|onclick=/i);
});

test('partial Markdown from streaming remains renderable until fences, tables and links complete', () => {
  const text = '# 回复\n\n```ts\nconst msg = "<script>";\nconsole.log(msg)\n```\n\n| 字段 | 值 |\n| --- | --- |\n| 状态 | 正常 |\n\n[说明](https://example.com/docs)';
  for (let length = 1; length <= text.length; length++) assert.doesNotThrow(() => render(text.slice(0, length)));
  assert.match(render('```ts\n  unfinished <tag>'), /  unfinished &lt;tag&gt;\n<\/code>/);
  assert.match(render(text), /<table>/); assert.match(render(text), /href="https:\/\/example.com\/docs"/);
});

test('rendering does not execute raw HTML, load images or create unsafe/relative links', () => {
  const html = render('<script>alert(1)</script>\n\n<iframe src="https://example.com"></iframe>\n\n<img src=x onerror=alert(1)>\n\n![远程图片](https://example.com/pixel)\n\n![本地图片](file:///private/secret.png)\n\n[脚本](javascript:alert%281%29) [文件](file:///etc/passwd) [应用](vscode://open) [数据](data:text/html,bad) [相对](src/main.tsx) [凭据](https://user:secret@example.com)');
  assert.doesNotMatch(html, /<script|<iframe|<img|<a\b|javascript:|file:\/\/|vscode:|data:text|onerror|pixel|secret/i);
  assert.match(html, /\[图片：远程图片\]/); assert.match(html, /\[图片：本地图片\]/);
  for (const label of ['脚本', '文件', '应用', '数据', '相对', '凭据']) assert.match(html, new RegExp(`<span>${label}</span>`));
  const safe = render('[文档](https://example.com/docs "查看文档") 和 https://example.com');
  assert.match(safe, /href="https:\/\/example.com\/docs" title="查看文档" rel="noopener noreferrer"/);
  assert.match(safe, /href="https:\/\/example.com\/"/);
});

test('web URL validation is shared by the renderer and main process', () => {
  assert.equal(webLink('https://example.com/path?q=hello#part'), 'https://example.com/path?q=hello#part');
  assert.equal(webLink('HTTP://localhost:1234'), 'http://localhost:1234/');
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,bad', 'mailto:a@example.com', 'vscode://open', '//example.com', '/relative', '#section', 'https://', 'https://user:password@example.com', 'https://example.com\n', 'https://exam\tple.com', ' https://example.com', 'https://example.com/a b']) assert.equal(webLink(url), undefined, url);
});

test('timeline renders only assistant messages as Markdown; user input and tool output remain literal', () => {
  const events: Event[] = [
    { id: 'user', at: 1, kind: 'message', role: 'user', text: '# 用户原文\n<script>data</script>' },
    { id: 'assistant', at: 2, kind: 'message', role: 'assistant', text: '# 助手回复\n\n**完成**' },
    { id: 'tool', at: 3, kind: 'error', text: '# 错误原文\n**细节**' },
  ];
  const html = renderToStaticMarkup(React.createElement(TimelineRows, { events, busy: false, waiting: false }));
  assert.match(html, /# 用户原文\n&lt;script&gt;data&lt;\/script&gt;/);
  assert.match(html, /<h1>助手回复<\/h1>/); assert.match(html, /<strong>完成<\/strong>/);
  assert.match(html, /<pre># 错误原文\n\*\*细节\*\*<\/pre>/);
  assert.doesNotMatch(html, /<h1>用户原文|<h1>错误原文/);
});

test('active restored streams and saved plans use the same Markdown renderer', () => {
  const initial = { taskId: 'task', runId: 'run', version: 1, text: '## 当前回复\n\n```ts\nconst x = 1;', ended: false };
  const stream = renderToStaticMarkup(React.createElement(StreamingReply, { api: {} as any, taskId: 'task', runId: 'run', initial, onContent: () => {} }));
  assert.match(stream, /<h2>当前回复<\/h2>/); assert.match(stream, /class="language-ts"/); assert.match(stream, /class="cursor"/);
  const run: Run = { id: 'run', taskId: 'task', mode: 'plan', input: '计划', createdAt: 1, status: 'completed', references: [], changes: [], checks: [], planText: '# 完整计划\n\n1. 读取\n2. 修改\n3. 验收' };
  const plan = renderToStaticMarkup(React.createElement(PlanActions, { run, disabled: false, execute: () => {} }));
  assert.match(plan, /<h1>完整计划<\/h1>/); assert.match(plan, /<li>验收<\/li>/); assert.match(plan, /按计划执行/);
  assert.equal(run.planText, '# 完整计划\n\n1. 读取\n2. 修改\n3. 验收');
});
