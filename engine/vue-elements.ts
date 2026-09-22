import { parse as parseSFC } from '@vue/compiler-sfc';
import { parse as parseTemplate } from '@vue/compiler-dom';
export type VueSelector = { tag: string; attributes?: Record<string, string>; text?: string };
export function findVueElements(source: string, selector: VueSelector) {
  const { descriptor, errors } = parseSFC(source);
  if (errors.length) throw new Error('Vue 文件无法解析：' + String(errors[0]));
  const template = descriptor.template;
  if (!template || template.src || (template.lang && template.lang !== 'html')) throw new Error('仅支持文件内的 HTML Vue template，不支持外部模板或预处理模板');
  const ast = parseTemplate(template.content, { comments: true });
  const results: { start: number; end: number; startLine: number; endLine: number; source: string }[] = [];
  function visit(node: any) {
    if (node.type === 1 && node.tag === selector.tag) {
      // Match literal attribute spelling and values, never evaluate expressions.
      const attributes = new Map<string, string>();
      for (const prop of node.props) {
        const raw = prop.loc.source;
        const match = raw.match(/^([^\s=]+)(?:\s*=\s*(?:"([\s\S]*)"|'([\s\S]*)'|([^\s]+)))?$/);
        if (match) attributes.set(match[1], match[2] ?? match[3] ?? match[4] ?? '');
      }
      const text = node.children.filter((n: any) => n.type === 2).map((n: any) => n.content).join('').trim();
      if (Object.entries(selector.attributes || {}).every(([key, value]) => attributes.get(key) === value) && (selector.text === undefined || selector.text === text)) {
        const start = template.loc.start.offset + node.loc.start.offset;
        const end = template.loc.start.offset + node.loc.end.offset;
        results.push({ start, end, startLine: template.loc.start.line + node.loc.start.line - 1, endLine: template.loc.start.line + node.loc.end.line - 1, source: source.slice(start, end) });
      }
    }
    for (const child of node.children || []) visit(child);
  }
  visit(ast); return results;
}
