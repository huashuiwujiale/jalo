import type { SessionView } from '../shared/session';
type Position = SessionView['scroll'];
export function capturePosition(element: HTMLElement | null, follow: boolean): Position {
  if(!element)return {top:0,follow,expanded:[]};
  const top=element.getBoundingClientRect().top;
  const entries=Array.from(element.querySelectorAll<HTMLElement>('[data-event-id]'));
  const anchor=entries.find(node=>node.getBoundingClientRect().bottom>top);
  return {top:Math.max(0,element.scrollTop),follow,anchor:anchor?.dataset.eventId,offset:anchor ? anchor.getBoundingClientRect().top-top : undefined,
    expanded:entries.filter(node=>node instanceof HTMLDetailsElement && node.open).map(node=>node.dataset.eventId!).slice(0,600)};
}
export function restorePosition(element: HTMLElement, saved: Position) {
  const entries=Array.from(element.querySelectorAll<HTMLElement>('[data-event-id]'));
  // Loading the preceding page can turn a standalone result into its tool card.
  const ids = (node: HTMLElement): string[] => {
    try { const aliases = JSON.parse(node.dataset.eventAliases || '[]'); return [node.dataset.eventId!, ...(Array.isArray(aliases) ? aliases.filter(id => typeof id === 'string') : [])]; }
    catch { return [node.dataset.eventId!]; }
  };
  for(const node of entries)if(node instanceof HTMLDetailsElement)node.open=ids(node).some(id => saved.expanded.includes(id));
  const bottom=Math.max(0,element.scrollHeight-element.clientHeight);
  const anchor=entries.find(node=>ids(node).includes(saved.anchor || ''));
  const target=saved.follow ? bottom : anchor && saved.offset!==undefined ? element.scrollTop+anchor.getBoundingClientRect().top-element.getBoundingClientRect().top-saved.offset : saved.top;
  element.scrollTop=Math.max(0,Math.min(bottom,target));
  return element.scrollTop;
}
