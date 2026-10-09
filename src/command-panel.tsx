import React, { useState } from 'react';
import type { Api, TaskDetail } from '../shared/types';
import { PtyTerminal } from './pty-terminal';
import { useRemoteResource } from './remote-resource';

export function CommandPanel({ api, task, runId }: { api: Api; task?: TaskDetail; runId: string }) {
  const entries = task?.runs.flatMap(run => (run.commands || []).map(command => ({ run, command }))) || [];
  const preferred = task?.runs.find(r => r.id === runId) || task?.runs.at(-1);
  const [chosen, choose] = useState(''), [page, setPage] = useState({ commandId: '', offset: 0 }), [attempt, refresh] = useState(0);
  const entry = entries.find(e => e.command.id === chosen) || [...entries].reverse().find(e => e.command.status === 'running') || [...entries].reverse().find(e => e.run.id === preferred?.id) || entries.at(-1);
  const run = entry?.run, command = entry?.command;
  const offset = page.commandId === command?.id ? page.offset : 0;
  const setOffset = (offset: number) => setPage({ commandId: command?.id || '', offset });
  const key = task && run && command && !command.tty ? JSON.stringify([task.id, run.id, command.id, command.status, offset, attempt]) : '';
  const output = useRemoteResource(key, () => api.commandOutput({ taskId: task!.id, runId: run!.id, commandId: command!.id, offset }));
  if (!command) return <p>本任务暂无命令记录。</p>;
  return <section className="command-panel"><label>本任务命令<select aria-label="选择命令输出" value={command?.id || ''} onChange={e => { choose(e.target.value); setOffset(0); }}>{entries.map(({ command: c }) => <option key={c.id} value={c.id}>{c.background ? '[后台] ' : ''}{c.command.slice(0, 80)} · {c.status === 'running' ? '运行中' : c.status === 'interrupted' ? '已中断' : `退出码 ${c.exitCode ?? '未知'}`}</option>)}</select></label>
    {command && <><pre>{command.command}</pre><small>工作目录：{command.cwd} · {command.totalBytes || 0} 字节输出{command.timedOut ? ' · 已超时' : ''}{command.outputTruncated ? ' · 日志达到 16 MiB，后续输出只保留末尾摘要' : ''}</small>
      {command.tty ? <PtyTerminal key={command.id} api={api} taskId={task!.id} runId={run!.id} commandId={command.id} running={command.status === 'running'}/> : <><div className="command-controls"><button onClick={() => { setOffset(0); refresh(n => n + 1); }}>查看开头</button><button onClick={() => refresh(n => n + 1)}>刷新本页</button><button disabled={!output.value?.hasMore} onClick={() => setOffset(output.value!.next)}>下一页</button></div>
      {output.error ? <p role="alert">{output.error}<button onClick={output.retry}>重试</button></p> : <pre className="command-output">{output.value?.text || '等待输出…'}</pre>}</>}
      {command.tail && (command.status !== 'running' || command.outputTruncated) && <details open><summary>末尾输出摘要</summary><pre className="command-output">{command.tail}</pre></details>}</>}
  </section>;
}
