import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, File, FileCode2, FileJson, FileText, Folder, FolderOpen, Search } from 'lucide-react';
import type { Api, Project } from '../shared/types';
const api: Api = window.localCode;
type Entry = { path: string; name: string; directory: boolean };
type Result = Awaited<ReturnType<Api['listDirectory']>>;

function FileIcon({ name }: { name: string }) {
  const extension = name.split('.').at(-1)?.toLowerCase();
  if (extension === 'json') return <FileJson className="file-icon json" size={16}/>;
  if (['ts', 'tsx', 'js', 'jsx', 'vue', 'css', 'html'].includes(extension || '')) return <FileCode2 className={`file-icon ${extension}`} size={16}/>;
  if (['md', 'txt'].includes(extension || '')) return <FileText className="file-icon text" size={16}/>;
  return <File className="file-icon" size={16}/>;
}

export function FileTree({ project, selected, initialPath, preview }: { project: Project; selected?: string; initialPath?: string; preview: (path: string) => void }) {
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<string[]>([]), [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(''), [truncated, setTruncated] = useState(false);
  useEffect(() => {
    if (!query.trim()) { setSearching(false); setSearchError(''); return; }
    let valid = true; setSearching(true); setSearchError(''); setMatches([]);
    const timer = setTimeout(() => api.searchFiles({ projectId: project.id, query: query.trim() }).then(r => {
      if (valid) { setMatches(r.paths); setTruncated(r.truncated); }
    }).catch(e => { if (valid) setSearchError(e.message); }).finally(() => { if (valid) setSearching(false); }), 180);
    return () => { valid = false; clearTimeout(timer); };
  }, [project.id, query]);
  const filtering = !!query.trim();
  return <div className="reference-search">
    <label className="tree-filter"><Search size={16}/><input autoFocus aria-label="搜索项目文件" placeholder="筛选文件…" value={query} onChange={e => setQuery(e.target.value)}/></label>
    <div className="file-tree" aria-label="项目文件">
      {filtering ? searching ? <p role="status">搜索中…</p> : searchError ? <p role="alert">{searchError}</p> : <>
        {!matches.length ? <p>没有匹配的文件</p> : <Directory key={`search:${query}`} directory="." depth={0} project={project} selected={selected} preview={preview} matches={matches}/>}
        {truncated && <p>搜索结果达到上限，请缩小查询范围。</p>}
      </> : <Directory key={project.id} directory="." depth={0} project={project} selected={selected} initialPath={initialPath} preview={preview}/>}
    </div>
    <small className="tree-note">点击文件预览 · 不显示 .git 和符号链接</small>
  </div>;
}

function Directory({ directory, depth, project, selected, initialPath, preview, matches }: { directory: string; depth: number; project: Project; selected?: string; initialPath?: string; preview: (path: string) => void; matches?: string[] }) {
  const [result, setResult] = useState<Result>(), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (matches) return;
    let valid = true; setError(''); setResult(undefined);
    api.listDirectory({ projectId: project.id, path: directory }).then(r => { if (valid) setResult(r); }).catch(e => { if (valid) setError(e.message); });
    return () => { valid = false; };
  }, [project.id, directory, retry, matches]);
  let entries = result?.entries;
  if (matches) {
    const prefix = directory === '.' ? '' : directory + '/';
    const children = new Map<string, Entry>();
    for (const path of matches) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length), name = rest.split('/')[0];
      children.set(name, { name, path: prefix + name, directory: rest.includes('/') });
    }
    entries = [...children.values()].sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
  }
  if (error) return <div className="tree-feedback" role="alert">{error}<button onClick={() => setRetry(n => n + 1)}>重试读取</button></div>;
  if (!entries) return <p className="tree-feedback" role="status">读取目录中…</p>;
  if (!entries.length) return <p className="tree-feedback">空文件夹</p>;
  return <ul className="tree-branch">{entries.map(entry => {
    const open = !collapsed.has(entry.path) && (expanded.has(entry.path) || !!matches || !!initialPath?.startsWith(entry.path + '/'));
    return <li key={entry.path}>
      <button className={`tree-row ${selected === entry.path ? 'selected' : ''}`} style={{ paddingLeft: 8 + depth * 16 }} title={project.path + '/' + entry.path} aria-expanded={entry.directory ? open : undefined} aria-current={!entry.directory && selected === entry.path ? 'true' : undefined} onClick={() => {
        if (!entry.directory) { preview(entry.path); return; }
        setExpanded(s => { const next = new Set(s); if (!open) next.add(entry.path); else next.delete(entry.path); return next; });
        setCollapsed(s => { const next = new Set(s); if (open) next.add(entry.path); else next.delete(entry.path); return next; });
      }}>
        {entry.directory ? <>{open ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}{open ? <FolderOpen size={16}/> : <Folder size={16}/>}</> : <><span className="tree-indent"/><FileIcon name={entry.name}/></>}
        <span className="tree-name">{entry.name}</span>
      </button>
      {entry.directory && open && <Directory directory={entry.path} depth={depth + 1} project={project} selected={selected} initialPath={initialPath} preview={preview} matches={matches}/>}
    </li>;
  })}{result?.truncated && <li className="tree-feedback">此目录仅显示前 1000 项，请通过筛选查找文件。</li>}</ul>;
}
