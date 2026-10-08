import type { SessionView } from '../shared/session';
type Position = SessionView['scroll'];
export function capturePosition(element: HTMLElement | null, follow: boolean, retained: string[] = [], groups?: Map<string, string[]>): Position {
  if(!element)return {top:0,follow,expanded:[]};
  const top=element.getBoundingClientRect().top;
  const entries=Array.from(element.querySelectorAll<HTMLElement>('[data-event-id]'));
  const anchor=entries.find(node=>node.getBoundingClientRect().bottom>top);
  const expanded = new Set(retained);
  for (const node of entries) if (node instanceof HTMLDetailsElement) rememberExpanded(node, expanded, groups);
  return {top:Math.max(0,element.scrollTop),follow,anchor:anchor?.dataset.eventId,offset:anchor ? anchor.getBoundingClientRect().top-top : undefined,
    expanded:[...expanded].slice(-600)};
}
export function eventIds(node: HTMLElement): string[] {
  try { const aliases = JSON.parse(node.dataset.eventAliases || '[]'); return [node.dataset.eventId!, ...(Array.isArray(aliases) ? aliases.filter(id => typeof id === 'string') : [])]; }
  catch { return [node.dataset.eventId!]; }
}
export function rememberExpanded(node: HTMLDetailsElement, expanded: Set<string>, groups?: Map<string, string[]>) {
  if (!node.dataset.eventId) return;
  const ids = eventIds(node), related = [...new Set([...ids, ...(groups?.get(node.dataset.eventId) || [])])];
  if (groups && ids.length > 1) for (const id of ids) groups.set(id, ids);
  if (groups) while (groups.size > 1200) groups.delete(groups.keys().next().value!);
  for (const id of related) expanded.delete(id);
  if (node.open) for (const id of related) expanded.add(id);
}
export function restorePosition(element: HTMLElement, saved: Position) {
  const entries=Array.from(element.querySelectorAll<HTMLElement>('[data-event-id]'));
  // Loading the preceding page can turn a standalone result into its tool card.
  for(const node of entries)if(node instanceof HTMLDetailsElement)node.open=eventIds(node).some(id => saved.expanded.includes(id));
  const bottom=Math.max(0,element.scrollHeight-element.clientHeight);
  const anchor=entries.find(node=>eventIds(node).includes(saved.anchor || ''));
  const target=saved.follow ? bottom : anchor && saved.offset!==undefined ? element.scrollTop+anchor.getBoundingClientRect().top-element.getBoundingClientRect().top-saved.offset : saved.top;
  element.scrollTop=Math.max(0,Math.min(bottom,target));
  return element.scrollTop;
}
