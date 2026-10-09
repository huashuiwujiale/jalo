import React, { useState } from 'react';
import type { Api, Project, GitReview } from '../shared/types';
import { diffLines } from '../shared/diff-lines';
import { useRemoteResource } from './remote-resource';

export function GitPanel({ api, project, refreshToken, locked, preview, review }: { api: Api; project?: Project; refreshToken: string; locked: boolean; preview: (path: string, line?: number) => void; review: (target: GitReview, prompt: string) => void }) {
  const [refresh, setRefresh] = useState(0), [chosen, choose] = useState('');
  const [selection, select] = useState({ version: '', anchor: 0, start: 0, end: 0 });
  const key = project ? `${project.id}:${refresh}:${refreshToken}` : '';
  const status = useRemoteResource(key, () => api.gitStatus(project!.id));
  const file = status.value?.files.find(f => f.path === chosen) || status.value?.files[0];
  const patch = useRemoteResource(file ? `${key}:${file.path}` : '', () => api.gitPatch({ projectId: project!.id, path: file!.path }));
  const lines = diffLines(patch.value?.patch || ''), selected = selection.version === patch.value?.version;
  const ask = () => {
    if (!patch.value || !file) return;
    const excerpt = selected ? lines.slice(selection.start, selection.end + 1).map(l => `${l.oldLine ?? '—'} → ${l.newLine ?? '—'} ${l.text}`).join('\n') : '';
    review({ path: file.path, version: patch.value.version }, `审查 ${JSON.stringify(file.path)} 的 Git 工作区改动，指出具体问题和行号。${excerpt ? `重点检查所选差异（旧行 → 新行）：\n${excerpt.slice(0, 3200)}${excerpt.length > 3200 ? '\n所选片段较长，其余内容见捕获的完整差异。' : ''}` : ''}`);
  };
  return <section className="git-panel"><div className="git-controls"><strong>Git 工作区</strong><button onClick={() => setRefresh(n => n + 1)}>刷新改动</button></div>
    {!project ? <p>先选择项目。</p> : status.error ? <p role="alert">{status.error}<button onClick={status.retry}>重试</button></p> : !status.value ? <p>读取 Git 状态…</p> : !status.value.available ? <p>此项目尚未初始化 Git。</p> : <>
      <p className="inspector-note">对比 HEAD 与当前文件，包含外部和命令改动。左侧状态依次表示已暂存 / 未暂存；点击差异行，Shift 点击选择范围。</p>
      {status.value.truncated && <p role="status">改动超过 200 个文件，仅显示前 200 个。</p>}
      <div className="file-list">{status.value.files.map(f => <button key={f.path} className={file?.path === f.path ? 'active' : ''} onClick={() => choose(f.path)}><code>{f.index}{f.workingTree}</code>{f.originalPath ? `${f.originalPath} → ` : ''}{f.path}</button>)}</div>
      {!file ? <p>工作区没有 Git 改动。</p> : <><div className="diff-title">{file.path}<button disabled={!patch.value || patch.value.deleted} onClick={() => preview(file.path)}>查看当前原文</button></div>
        {patch.error ? <p role="alert">{patch.error}<button onClick={patch.retry}>重试</button></p> : !patch.value ? <p>加载差异…</p> : <>
          <pre className="diff git-diff">{lines.map((line, i) => <div key={i} className={`${line.kind} ${selected && i >= selection.start && i <= selection.end ? 'selected' : ''}`}>
            <button className="diff-line-number" aria-label={`查看当前文件第 ${line.newLine ?? '无'} 行`} disabled={!line.newLine || patch.value!.deleted} onClick={() => preview(file.path, line.newLine)}>{line.oldLine ?? ''}<span>{line.newLine ?? ''}</span></button>
            <button className="diff-line-text" disabled={line.kind === 'metadata' || line.kind === 'hunk'} onClick={e => { const anchor = e.shiftKey && selected ? selection.anchor : i; select({ version: patch.value!.version, anchor, start: Math.min(anchor, i), end: Math.max(anchor, i) }); }}>{line.text || ' '}</button>
          </div>)}</pre>
          {patch.value.truncated && <p role="status">差异超过 48000 字符，已截断；请查看原文，当前差异不能直接发起完整审查。</p>}
          <div className="git-controls"><button disabled={locked || patch.value.truncated} onClick={ask}>{selected ? '审查所选差异' : '审查这个文件'}</button>{selected && <button onClick={() => select({ version: '', anchor: 0, start: 0, end: 0 })}>清除选择</button>}</div>
        </>}
      </>}
    </>}
  </section>;
}
