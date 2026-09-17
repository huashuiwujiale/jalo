import { parseForESLint } from 'vue-eslint-parser';
import { parse as parseJS } from '@babel/parser';
import { parse as parseSFC } from '@vue/compiler-sfc';
import { parse as parseTemplate } from '@vue/compiler-dom';
import path from 'node:path';
import type { CheckResult } from '../shared/types';
import { createHash } from 'node:crypto';
export const version = (text: string) => createHash('sha256').update(text).digest('hex');
const js = (text: string, lang: string) => parseJS(text, { sourceType: 'unambiguous', plugins: [...(lang.includes('ts') ? ['typescript' as const] : []), ...(lang.includes('x') || lang === 'js' ? ['jsx' as const] : []), 'decorators-legacy'], errorRecovery: false });
// Only bundled parsers run here; project configuration and scripts are never loaded.
export function checkSyntax(file: string, text: string, vueMajor?: 2 | 3): CheckResult {
  const ext = path.extname(file).toLowerCase().slice(1);
  const check: CheckResult = { path: file, status: 'passed', parser: ext, message: '语法解析通过；业务行为仍需验收', at: Date.now(), version: version(text) };
  try {
    if (ext === 'json') JSON.parse(text);
    else if (['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts'].includes(ext)) js(text, ext);
    else if (ext === 'vue') {
      check.parser = `Vue ${vueMajor || '未知版本'} / SFC、模板与脚本解析`;
      const { descriptor, errors } = parseSFC(text, { filename: file });
      if (errors.length) throw errors[0];
      let incomplete = !vueMajor;
      if (descriptor.template) {
        const t = descriptor.template;
        if (t.src || (t.lang && t.lang !== 'html')) incomplete = true;
        else {
          try {
            const ast = parseTemplate(t.content, { comments: true });
            const expressions = parseForESLint('<template>' + t.content + '</template>', { parser: false, sourceType: 'module', ecmaVersion: 'latest', vueFeatures: { filter: vueMajor === 2, interpolationAsNonHTML: vueMajor !== 2, styleCSSVariableInjection: false } });
            const expressionError = expressions.ast.templateBody?.errors?.find(e => e.code !== 'non-void-html-element-start-tag-with-trailing-solidus');
            if (expressionError) throw new Error(`第 ${t.loc.start.line + expressionError.lineNumber - 1} 行：${expressionError.message}`);
            if (vueMajor === 2) {
              const roots = ast.children.filter((n: any) => n.type !== 3 && !(n.type === 2 && !n.content.trim()));
              // v-if / v-else branches are multiple AST nodes but one Vue 2 root.
              if (roots.length > 1 && !roots.slice(1).every((n: any) => n.type === 1 && n.props.some((p: any) => p.type === 7 && ['else','else-if'].includes(p.name)))) throw new Error('Vue 2 模板只能有一个根元素');
            }
          } catch (e: any) { if (e.loc?.start) e.loc.start.line += t.loc.start.line - 1; throw e; }
        }
      }
      for (const block of [descriptor.script, descriptor.scriptSetup]) {
        if (!block) continue;
        if (block.src || !['js','jsx','ts','tsx'].includes(block.lang || 'js')) { incomplete = true; continue; }
        try { js(block.content, block.lang || 'js'); }
        catch (e: any) { if (e.loc?.line) e.loc.line += block.loc.start.line - 1; throw e; }
      }
      if (incomplete) { check.status = 'skipped'; check.message = '已检查可解析块；Vue 版本未知、外部块或预处理语言未完整检查。未进行完整语法检查'; }
      else check.message = 'Vue 模板结构与 JS/TS 脚本语法通过；未检查样式、类型及业务行为';
    } else { check.status = 'skipped'; check.message = '未进行语法检查：暂不支持该语言'; }
  } catch (e: any) { check.status = 'failed'; const line = e.loc?.start?.line ?? e.loc?.line; const column = e.loc?.start?.column ?? (e.loc?.column === undefined ? undefined : e.loc.column + 1); check.message = `${line ? `第 ${line} 行${column ? `，第 ${column} 列` : ''}：` : ''}${e.message || e}`; }
  return check;
}
