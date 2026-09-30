import React, { useMemo } from 'react';
import { ChevronDown, Code2, Terminal } from 'lucide-react';
import type { Event } from '../shared/types';
import { groupToolEvents } from './tool-events';
import { ToolCard } from './tool-card';
import { Markdown } from './markdown';
const EventRow = React.memo(function EventRow({ event: e }: { event: Event }) {
  return e.kind === 'message' ? <article data-event-id={e.id} className={`message ${e.role}`}><div className="message-author">{e.role === 'user' ? <span className="avatar user-avatar">你</span> : <span className="avatar assistant-avatar"><Code2 size={15}/></span>}<strong>{e.role === 'user' ? '你' : 'Jalo'}</strong></div><div className="message-text">{e.role === 'assistant' ? <Markdown text={e.text}/> : e.text}</div></article>
    : e.kind === 'output' ? null : e.kind === 'notice' ? <div data-event-id={e.id} className="progress-line"><span/>{e.text}</div>
    : <details data-event-id={e.id} className={`tool-event ${e.kind}`}><summary><Terminal size={13}/><span>{e.text.split('\n')[0].slice(0, 150)}</span><ChevronDown size={13}/></summary><pre>{e.text}</pre></details>;
});
export const TimelineRows = React.memo(function TimelineRows({ events, busy, runId, waiting }: { events: Event[]; busy: boolean; runId?: string; waiting: boolean }) {
  const rows = useMemo(() => groupToolEvents(events), [events]);
  return <>{rows.map(e => e.kind === 'tool-group' ? <ToolCard key={e.id} group={e} active={busy && (!e.call.runId || e.call.runId === runId)} waiting={waiting}/> : <EventRow key={e.id} event={e}/>)}</>;
});
