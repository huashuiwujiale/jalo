/** Measured row heights and binary viewport lookup, independent of the DOM. */
export class TimelineWindow {
  private measured = new Map<string, number>();
  offsets: number[] = [0];
  setRows(rows: { id: string; estimate: number }[]) {
    const ids = new Set(rows.map(row => row.id));
    for (const id of this.measured.keys()) if (!ids.has(id)) this.measured.delete(id);
    this.offsets = [0];
    for (const row of rows) this.offsets.push(this.offsets.at(-1)! + (this.measured.get(row.id) ?? row.estimate));
  }
  measure(id: string, height: number) {
    if (!Number.isFinite(height) || height <= 0 || Math.abs((this.measured.get(id) ?? 0) - height) < 0.5) return false;
    this.measured.set(id, height); return true;
  }
  reset() { this.measured.clear(); }
  get total() { return this.offsets.at(-1)!; }
  private index(top: number) {
    let low = 0, high = this.offsets.length - 1;
    while (low < high) { const middle = Math.floor((low + high) / 2); if (this.offsets[middle + 1] <= top) low = middle + 1; else high = middle; }
    return Math.min(low, Math.max(0, this.offsets.length - 2));
  }
  range(top: number, height: number, overscan = 500) {
    const count = this.offsets.length - 1;
    if (!count) return { start: 0, end: 0, before: 0, after: 0 };
    const start = this.index(Math.max(0, top - overscan)), end = Math.min(count, this.index(Math.max(0, top + height + overscan)) + 1);
    return { start, end, before: this.offsets[start], after: this.total - this.offsets[end] };
  }
}
