import type { StreamState } from '../shared/types';

/** Keep every token in the accumulator; limit expensive Markdown renders. */
export class StreamPublisher {
  private pending?: StreamState;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private publish: (state: StreamState) => void) {}
  update(state: StreamState) {
    this.pending = state;
    if (state.ended || !state.text) { this.flush(); return; }
    // Longer replies cost more to parse. A bounded window never waits for silence.
    this.timer ??= setTimeout(() => this.flush(), state.text.length >= 20000 ? 240 : 120);
  }
  private flush() {
    clearTimeout(this.timer); this.timer = undefined;
    const state = this.pending; this.pending = undefined;
    if (state) this.publish(state);
  }
  dispose() { clearTimeout(this.timer); this.timer = undefined; this.pending = undefined; }
}
