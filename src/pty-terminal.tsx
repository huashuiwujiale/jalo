import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { Api } from '../shared/types';

/** Output-only emulator. All input goes through the explicit confirmation below. */
export function PtyTerminal({ api, taskId, runId, commandId, running }: { api: Api; taskId: string; runId: string; commandId: string; running: boolean }) {
  const host = useRef<HTMLDivElement>(null), live = useRef(running);
  live.current = running;
  const [error, setError] = useState(''), [text, setText] = useState(''), [confirmed, setConfirmed] = useState<string>(), [sending, setSending] = useState(false);
  useEffect(() => {
    const terminal = new Terminal({ disableStdin: true, scrollback: 2000, fontSize: 12, theme: { background: '#15181d', foreground: '#d8dde5' } });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host.current!);
    let disposed = false, cursor = 0, timer: ReturnType<typeof setTimeout>;
    const target = { taskId, runId, commandId };
    const resize = () => { if (disposed) return; fit.fit(); if (live.current) void api.commandResize({ ...target, cols: Math.max(2, Math.min(500, terminal.cols)), rows: Math.max(2, Math.min(500, terminal.rows)) }).catch(() => {}); };
    const observer = new ResizeObserver(resize); observer.observe(host.current!); resize();
    const poll = async () => {
      try {
        const page = await api.commandOutput({ ...target, offset: cursor });
        if (disposed) return;
        cursor = page.next;
        if (page.text) await new Promise<void>(resolve => terminal.write(page.text, resolve));
        if (disposed) return;
        setError('');
        // Keep polling at the log cap while running; the separate tail remains available.
        if (page.hasMore || live.current) timer = setTimeout(poll, page.hasMore ? 0 : 700);
      } catch (error) { if (!disposed) { setError(String(error)); if (live.current) timer = setTimeout(poll, 2000); } }
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); observer.disconnect(); terminal.dispose(); };
  }, [api, taskId, runId, commandId]);
  const send = async () => {
    if (confirmed === undefined || sending) return;
    setSending(true);
    try { await api.commandInput({ taskId, runId, commandId, text: confirmed }); setConfirmed(undefined); setText(''); setError(''); }
    catch (error) { setError(String(error)); }
    finally { setSending(false); }
  };
  return <div className="pty-session"><div className="pty-screen" ref={host}/>{error && <p role="alert">{error}</p>}
    {running && <><form onSubmit={event => { event.preventDefault(); if (text && !/[\x00-\x1f\x7f]/.test(text)) setConfirmed(text); }}><label>发送到终端的单行输入<input aria-label="终端输入" value={text} maxLength={8000} disabled={sending} autoComplete="off" onChange={event => { setText(event.target.value); setConfirmed(undefined); }}/></label><button disabled={!text || sending}>预览输入</button><button type="button" disabled={sending} onClick={() => api.commandStop({ taskId, runId, commandId }).catch(error => setError(String(error)))}>停止进程</button></form>
      {confirmed !== undefined && <div className="approval"><strong>确认发送以下输入并回车</strong><pre>{confirmed}</pre><p>输入可能触发命令或修改文件。</p><button disabled={sending} onClick={() => setConfirmed(undefined)}>取消</button><button disabled={sending} onClick={() => void send()}>确认发送</button></div>}</>}
  </div>;
}
