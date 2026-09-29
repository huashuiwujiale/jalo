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
  for(const node of entries)if(node instanceof HTMLDetailsElement)node.open=saved.expanded.includes(node.dataset.eventId!);
  const bottom=Math.max(0,element.scrollHeight-element.clientHeight);
  const anchor=entries.find(node=>node.dataset.eventId===saved.anchor);
  const target=saved.follow ? bottom : anchor && saved.offset!==undefined ? element.scrollTop+anchor.getBoundingClientRect().top-element.getBoundingClientRect().top-saved.offset : saved.top;
  element.scrollTop=Math.max(0,Math.min(bottom,target));
  return element.scrollTop;
}
