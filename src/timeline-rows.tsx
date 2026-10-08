import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Code2, Terminal } from 'lucide-react';
import type { Event } from '../shared/types';
import { groupToolEvents, type ToolGroup } from './tool-events';
import { ToolCard } from './tool-card';
import { Markdown } from './markdown';
import { TimelineWindow } from './timeline-window';
import { capturePosition, eventIds, restorePosition } from './session-scroll';
import type { SessionView } from '../shared/session';
const EventRow = React.memo(function EventRow({ event: e }: { event: Event }) {
  return e.kind === 'message' ? <article data-event-id={e.id} className={`message ${e.role}`}><div className="message-author">{e.role === 'user' ? <span className="avatar user-avatar">你</span> : <span className="avatar assistant-avatar"><Code2 size={15}/></span>}<strong>{e.role === 'user' ? '你' : 'Jalo'}</strong></div><div className="message-text">{e.role === 'assistant' ? <Markdown text={e.text}/> : e.text}</div></article>
    : e.kind === 'output' ? null : e.kind === 'notice' ? <div data-event-id={e.id} className="progress-line"><span/>{e.text}</div>
    : <details data-event-id={e.id} className={`tool-event ${e.kind}`}><summary><Terminal size={13}/><span>{e.text.split('\n')[0].slice(0, 150)}</span><ChevronDown size={13}/></summary><pre>{e.text}</pre></details>;
});
type Row = Event | ToolGroup;
type Props = { events: Event[]; busy: boolean; runId?: string; waiting: boolean; viewport?: React.RefObject<HTMLDivElement | null>;
  position?: SessionView['scroll']; expanded?: React.RefObject<Set<string>>; following?: () => boolean; corrected?: (top: number) => void };
function rowIds(row: Row) { return (row.kind === 'tool-group' ? [row.id, row.result?.id, ...row.errors.map(e => e.id)] : [row.id]).filter((id): id is string => id !== undefined); }
function renderRow(row: Row, props: Pick<Props, 'busy' | 'runId' | 'waiting'>) {
  return row.kind === 'tool-group' ? <ToolCard group={row} active={props.busy && (!row.call.runId || row.call.runId === props.runId)} waiting={props.waiting}/> : <EventRow event={row}/>;
}
function VirtualRows({ rows, ...props }: Omit<Props, 'events'> & { rows: Row[] }) {
  const element = useRef<HTMLDivElement>(null), window = useRef(new TimelineWindow());
  const [view, setView] = useState({ top: 0, height: 600 }), [revision, redraw] = useState(0);
  const measureCurrent = useRef<(() => void) | undefined>(undefined);
  const readingPosition = useRef<SessionView['scroll'] | undefined>(undefined);
  const before = useRef<HTMLDivElement>(null), after = useRef<HTMLDivElement>(null);
  const callbacks = useRef(props); callbacks.current = props;
  window.current.setRows(rows.map(row => ({ id: row.id, estimate: row.kind === 'message' ? 140 : row.kind === 'notice' ? 30 : 70 })));
  let top = view.top;
  const position = props.position;
  if (position) {
    const index = position.anchor ? rows.findIndex(row => rowIds(row).includes(position.anchor!)) : -1;
    top = position.follow ? window.current.total : index >= 0 ? window.current.offsets[index] : position.top;
  }
  const range = window.current.range(top, view.height);
  useLayoutEffect(() => {
    const root = element.current, pane = props.viewport?.current;
    if (!root || !pane) return;
    let frame: number | undefined;
    let width = pane.clientWidth;
    const read = (record = true) => {
      // Resize can dispatch a scroll before ResizeObserver measures the new
      // wrapping. Retain the anchor from the previous layout during that frame.
      if (record && width === pane.clientWidth) readingPosition.current = capturePosition(pane, callbacks.current.following?.() ?? false, [...(callbacks.current.expanded?.current || [])]);
      const top = pane.getBoundingClientRect().top - root.getBoundingClientRect().top;
      setView(old => Math.abs(old.top - top) < 0.5 && old.height === pane.clientHeight ? old : { top, height: pane.clientHeight });
    };
    const scroll = () => { frame ??= requestAnimationFrame(() => { frame = undefined; read(); }); };
    // Keep offscreen heights as estimates when wrapping changes. Clearing the
    // prefix would move the viewport to a different row before it can be measured.
    const sizes = new ResizeObserver(() => {
      if (width !== pane.clientWidth) {
        width = pane.clientWidth; measureCurrent.current?.();
      }
      read(false);
    });
    sizes.observe(pane); pane.addEventListener('scroll', scroll); read();
    return () => { sizes.disconnect(); pane.removeEventListener('scroll', scroll); if (frame !== undefined) cancelAnimationFrame(frame); };
  }, [props.viewport]);
  useLayoutEffect(() => {
    const root = element.current, pane = props.viewport?.current;
    if (!root || !pane) return;
    for (const node of root.querySelectorAll<HTMLDetailsElement>('details[data-event-id]')) {
      node.open = eventIds(node).some(id => props.expanded?.current.has(id) || props.position?.expanded.includes(id));
    }
    const measure = () => {
      let changed = false;
      // Newly mounted rows can already have shifted the old anchor. Keep the
      // position captured before changing the window, rather than that shift.
      const current = capturePosition(pane, callbacks.current.following?.() ?? false, [...(callbacks.current.expanded?.current || [])]);
      const saved = callbacks.current.position || { ...(readingPosition.current?.anchor ? readingPosition.current : current), follow: current.follow, expanded: current.expanded };
      if (callbacks.current.expanded) callbacks.current.expanded.current = new Set(saved.expanded);
      for (const node of root.querySelectorAll<HTMLElement>('[data-row-id]')) changed = window.current.measure(node.dataset.rowId!, node.getBoundingClientRect().height) || changed;
      // A large scroll can land outside the previously mounted rows. Record its
      // new anchor even when every newly mounted height is already in the cache.
      if (!changed) { readingPosition.current = current; return; }
      window.current.setRows(rows.map(row => ({ id: row.id, estimate: row.kind === 'message' ? 140 : row.kind === 'notice' ? 30 : 70 })));
      // Correct spacers and the anchor together, before a paint or another scroll.
      // Deferring the correction to the next render can override a newer gesture.
      if (before.current) before.current.style.height = `${window.current.offsets[range.start]}px`;
      if (after.current) after.current.style.height = `${window.current.total - window.current.offsets[range.end]}px`;
      const top = restorePosition(pane, saved); callbacks.current.corrected?.(top);
      readingPosition.current = capturePosition(pane, saved.follow, [...(callbacks.current.expanded?.current || [])]);
      setView({ top: pane.getBoundingClientRect().top - root.getBoundingClientRect().top, height: pane.clientHeight });
      redraw(n => n + 1);
    };
    measureCurrent.current = measure;
    const observer = new ResizeObserver(() => measure());
    for (const node of root.querySelectorAll('[data-row-id]')) observer.observe(node);
    measure(); return () => { observer.disconnect(); measureCurrent.current = undefined; };
  }, [rows, range.start, range.end, revision, props.position, props.viewport]);
  return <div ref={element} className="virtual-timeline" data-loaded-rows={rows.length}>
    <div ref={before} aria-hidden="true" style={{ height: range.before }}/>
    {rows.slice(range.start, range.end).map(row => <div key={row.id} data-row-id={row.id} className="timeline-row">{renderRow(row, props)}</div>)}
    <div ref={after} aria-hidden="true" style={{ height: range.after }}/>
  </div>;
}
export const TimelineRows = React.memo(function TimelineRows(props: Props) {
  const { events } = props;
  const rows = useMemo(() => groupToolEvents(events), [events]);
  return props.viewport ? <VirtualRows rows={rows} {...props}/> : <>{rows.map(row => <React.Fragment key={row.id}>{renderRow(row, props)}</React.Fragment>)}</>;
});
