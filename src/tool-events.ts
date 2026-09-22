import type { Event } from '../shared/types';
export type ToolGroup = { kind: 'tool-group'; id: string; call: Event; name: string; result?: Event; errors: Event[] };
export function groupToolEvents(events: Event[]): (Event | ToolGroup)[] {
  const rows: (Event | ToolGroup)[] = [];
  const identified = new Map<string, ToolGroup>();
  let pending: ToolGroup | undefined;
  for (const event of events) {
    if (event.kind === 'output') continue;
    const key = event.toolCallId ? `${event.runId || ''}:${event.toolCallId}` : undefined;
    const start = event.kind === 'tool' && (event.toolPhase === 'call' || (!event.toolPhase && /^\w+\s+\{/.test(event.text)));
    if (start) {
      const group: ToolGroup = { kind: 'tool-group', id: event.id, call: event, name: event.text.split(/\s/)[0], errors: [] };
      rows.push(group); pending = group; if (key) identified.set(key, group);
      continue;
    }
    const resultName = event.kind === 'tool' ? event.text.match(/^(\w+) 结果(?:\n|$)/)?.[1] : undefined;
    const group = key ? identified.get(key) : pending?.call.runId === event.runId ? pending : undefined;
    if (group && event.kind === 'error' && (key || event.text.startsWith('工具未成功：'))) { group.errors.push(event); continue; }
    if (group && (event.toolPhase === 'result' || resultName === group.name)) {
      group.result = event; if (pending === group) pending = undefined; continue;
    }
    rows.push(event);
    // Legacy logs may only be combined inside an uninterrupted tool sequence.
    pending = undefined;
  }
  return rows;
}
