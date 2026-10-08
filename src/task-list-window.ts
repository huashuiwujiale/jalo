export const taskRowHeight = 60;

/** Keep a small buffer on both sides so scrolls do not mount the whole history. */
export function taskListWindow(count: number, scrollTop: number, viewportHeight: number, overscan = 6) {
  const totalHeight = count * taskRowHeight;
  const height = Math.max(taskRowHeight, viewportHeight);
  const top = Math.max(0, Math.min(scrollTop, Math.max(0, totalHeight - height)));
  const start = Math.max(0, Math.floor(top / taskRowHeight) - overscan);
  const end = Math.min(count, Math.ceil((top + height) / taskRowHeight) + overscan);
  return { start, end, offset: start * taskRowHeight, totalHeight };
}

export function taskRowScrollTop(index: number, scrollTop: number, viewportHeight: number) {
  const top = index * taskRowHeight, bottom = top + taskRowHeight;
  if (top < scrollTop) return top;
  if (bottom > scrollTop + viewportHeight) return Math.max(0, bottom - viewportHeight);
  return scrollTop;
}
