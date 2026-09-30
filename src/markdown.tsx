import React, { useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';
import { webLink } from '../shared/markdown';

const plugins = [remarkGfm];
const failure = (error: unknown) => error instanceof Error ? error.message : String(error);

const CodeBlock: Components['pre'] = ({ node, children }) => {
  const code = node?.children.find(child => child.type === 'element' && child.tagName === 'code');
  const text = code?.type === 'element' ? code.children.filter(child => child.type === 'text').map(child => child.value).join('') : '';
  const classes = code?.type === 'element' ? code.properties.className : undefined;
  const language = (Array.isArray(classes) ? classes.join(' ') : String(classes || '')).match(/(?:^|\s)language-(\S+)/)?.[1];
  const [result, setResult] = useState<{ text: string; status: 'pending' | 'copied' | 'error'; error?: string }>();
  const current = result?.text === text ? result : undefined;
  async function copy() {
    setResult({ text, status: 'pending' });
    try { await window.localCode.copyText(text); setResult({ text, status: 'copied' }); }
    catch (error) { setResult({ text, status: 'error', error: failure(error) }); }
  }
  return <div className="markdown-code-block">
    <div className="markdown-code-header"><span>{language || '代码'}</span><button type="button" disabled={current?.status === 'pending'} aria-label="复制代码" onClick={() => void copy()}>
      {current?.status === 'copied' ? <Check size={13}/> : <Copy size={13}/>}{current?.status === 'copied' ? '已复制' : current?.status === 'pending' ? '复制中…' : '复制'}
    </button></div>
    <pre>{children}</pre>
    {current?.status === 'error' && <p className="markdown-action-error" role="alert">复制失败：{current.error}</p>}
  </div>;
};

const MarkdownLink: Components['a'] = ({ href, children, title }) => {
  const url = href ? webLink(href) : undefined;
  const [error, setError] = useState<{ url: string; message: string }>();
  if (!url) return <span title={title}>{children}</span>;
  async function open() {
    setError(undefined);
    try { await window.localCode.openLink(url!); }
    catch (value) { setError({ url: url!, message: failure(value) }); }
  }
  return <><a href={url} title={title || url} rel="noopener noreferrer" onClick={event => { event.preventDefault(); void open(); }}>{children}</a>
    {error?.url === url && <span className="markdown-action-error" role="alert">（无法打开链接：{error.message}）</span>}</>;
};

const components: Components = {
  pre: CodeBlock,
  a: MarkdownLink,
  // Model text must not trigger automatic network requests or local image reads.
  img: ({ alt }) => <span className="markdown-image">[图片{alt ? `：${alt}` : ''}]</span>,
  table: ({ children }) => <div className="markdown-table" role="region" aria-label="Markdown 表格" tabIndex={0}><table>{children}</table></div>,
};

/** Historical replies retain their rendered tree while other task state updates. */
export const Markdown = React.memo(function Markdown({ text }: { text: string }) {
  return <div className="markdown-body"><ReactMarkdown remarkPlugins={plugins} components={components} skipHtml
    urlTransform={(url, key) => key === 'href' ? webLink(url) || '' : ''}>{text}</ReactMarkdown></div>;
});
