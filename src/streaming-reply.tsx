import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Code2, LoaderCircle } from 'lucide-react';
import type { Api, StreamFrame, StreamState } from '../shared/types';

export class StreamAccumulator {
  state: StreamState;
  constructor(taskId: string, runId: string) { this.state = { taskId, runId, version: 0, text: '', ended: true }; }
  seed(state?: StreamState) {
    if (!state || state.taskId !== this.state.taskId || state.runId !== this.state.runId || state.version < this.state.version) return false;
    this.state = state; return true;
  }
  apply(frame: StreamFrame): 'changed' | 'ignored' | 'gap' {
    if (frame.taskId !== this.state.taskId || frame.runId !== this.state.runId || frame.version <= this.state.version) return 'ignored';
    if (frame.kind === 'append' && (this.state.ended || frame.offset !== this.state.text.length)) return 'gap';
    this.state = { taskId: frame.taskId, runId: frame.runId, version: frame.version, ended: frame.kind === 'end',
      text: frame.kind === 'append' ? this.state.text + frame.text : '' };
    return 'changed';
  }
}

/** Tokens update this component only, at most once per animation frame. */
export const StreamingReply = React.memo(function StreamingReply({ api, taskId, runId, initial, onContent }: { api: Api; taskId: string; runId: string; initial?: StreamState; onContent: () => void }) {
  const accumulator = useRef(new StreamAccumulator(taskId, runId));
  const [state, setState] = useState(() => { accumulator.current.seed(initial); return accumulator.current.state; });
  const onChange = useRef(onContent); onChange.current = onContent;
  useEffect(() => {
    let frame: number | undefined, disposed = false, recovering = false;
    const publish = () => { frame = undefined; if (!disposed) setState(accumulator.current.state); };
    const schedule = () => { frame ??= requestAnimationFrame(publish); };
    const off = api.onDelta(value => {
      const result = accumulator.current.apply(value);
      if (result === 'changed') schedule();
      if (result === 'gap' && !recovering) {
        recovering = true;
        void api.taskDetail(taskId).then(detail => { if (!disposed && accumulator.current.seed(detail.stream)) schedule(); }).catch(() => {}).finally(() => { recovering = false; });
      }
    });
    return () => { disposed = true; off(); if (frame !== undefined) cancelAnimationFrame(frame); };
  }, [api, taskId, runId]);
  useEffect(() => { if (accumulator.current.seed(initial)) setState(accumulator.current.state); }, [initial]);
  useLayoutEffect(() => { onChange.current(); }, [state.text, state.ended]);
  if (state.ended || !state.text) return null;
  return <article className="message assistant streaming-reply"><div className="message-author"><span className="avatar assistant-avatar"><Code2 size={15}/></span><strong>Jalo</strong><LoaderCircle className="spin" size={13}/></div><div className="message-text">{state.text}<span className="cursor"/></div></article>;
});
