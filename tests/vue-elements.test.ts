import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ToolRegistry, toolsForMode } from '../engine/tools';
import { findVueElements } from '../engine/vue-elements';
const source = `<template>\r\n  <div>\r\n    <el-button\r\n      v-hasPermi="['sale:voucher:add']"\r\n      @click="handleAdd"\r\n      >新增</el-button\r\n    >\r\n    <el-button @click="handleExport">导出</el-button>\r\n  </div>\r\n</template>\r\n<script>export default {}</script>\r\n`;
const selector = { tag: 'el-button', attributes: { '@click': 'handleAdd' } };
async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'jalo-elements-'));
  const root = path.join(home, 'project'); await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'package.json'), '{"dependencies":{"vue":"^2.6.0"}}');
  await fs.writeFile(path.join(root, 'page.vue'), source);
  const tools = new ToolRegistry({ root, backupDir: path.join(home, 'backups'), signal: new AbortController().signal, timeout: 1, emit: () => {}, approve: async () => false });
  await tools.init();
  return { tools, root, cleanup: () => fs.rm(home, { recursive: true, force: true }) };
}
test('Vue complete-element deletion preserves adjacent export, CRLF, script and records actual change', async () => {
  const f = await fixture();
  try {
    const located = JSON.parse(await f.tools.execute('find_vue_elements', { path: 'page.vue', selector }));
    assert.equal(located.count, 1); assert.equal(located.editable, true);
    assert.equal(located.candidates[0].startLine, 3);
    await f.tools.execute('edit_vue_element', { path: 'page.vue', selector, expectedVersion: located.version, newText: '' });
    assert.equal(await fs.readFile(path.join(f.root, 'page.vue'), 'utf8'), source.replace(located.candidates[0].source, ''));
    assert.deepEqual(f.tools.evidence().changedFiles, ['page.vue']);
    await assert.rejects(f.tools.execute('edit_vue_element', { path: 'page.vue', selector, expectedVersion: located.version, newText: '' }), /失效/);
  } finally { await f.cleanup(); }
});
test('ambiguous matches, stale snapshots and invalid replacements cannot write', async () => {
  const f = await fixture();
  try {
    const broad = { tag: 'el-button' };
    const many = JSON.parse(await f.tools.execute('find_vue_elements', { path: 'page.vue', selector: broad }));
    assert.equal(many.count, 2); assert.equal(many.editable, false);
    await assert.rejects(f.tools.execute('edit_vue_element', { path: 'page.vue', selector: broad, expectedVersion: many.version, newText: '' }));
    const unique = JSON.parse(await f.tools.execute('find_vue_elements', { path: 'page.vue', selector }));
    await assert.rejects(f.tools.execute('edit_vue_element', { path: 'page.vue', selector, expectedVersion: unique.version, newText: '<el-button>' }), /语法/);
    assert.equal(await fs.readFile(path.join(f.root, 'page.vue'), 'utf8'), source);
    await fs.writeFile(path.join(f.root, 'page.vue'), source + '<!-- external -->');
    await assert.rejects(f.tools.execute('edit_vue_element', { path: 'page.vue', selector, expectedVersion: unique.version, newText: '' }), /更改/);
  } finally { await f.cleanup(); }
});
test('Vue selectors match literal directives and nested elements; reject unsupported templates', () => {
  assert.equal(findVueElements(source, { tag: 'el-button', attributes: { 'v-hasPermi': "['sale:voucher:add']" }, text: '新增' }).length, 1);
  assert.equal(findVueElements(source, { tag: 'el-button', text: '不存在' }).length, 0);
  assert.equal(findVueElements('<template><div><div>x</div></div></template>', { tag: 'div' }).length, 2);
  assert.throws(() => findVueElements('<template lang="pug">div hello</template>', { tag: 'div' }), /预处理/);
  assert.throws(() => findVueElements('<template><div></template>', { tag: 'div' }));
});
test('readonly modes never advertise or execute Vue writes', async () => {
  for (const mode of ['plan', 'review'] as const) {
    assert.ok(!toolsForMode(mode).some(t => t.function.name === 'edit_vue_element'));
    const tool = new ToolRegistry({ root: '.', mode, backupDir: '', signal: new AbortController().signal, timeout: 1, emit: () => {}, approve: async () => false });
    await assert.rejects(tool.execute('edit_vue_element', {}), /只读/);
  }
});
