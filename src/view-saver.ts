import type { SessionView } from '../shared/session';

/** One bounded window: continuous typing still saves periodically. */
export class ViewSaver {
  private pending?: SessionView;
  private timer?: ReturnType<typeof setTimeout>;
  private sent = '';
  constructor(private save: (view: SessionView) => Promise<void>, private remember: (view: SessionView) => void,
    private fail: (error: unknown) => void, private delay = 250) {}
  schedule(view: SessionView) {
    this.pending = view;
    this.timer ??= setTimeout(() => this.flush(), this.delay);
  }
  flush() {
    clearTimeout(this.timer); this.timer = undefined;
    const view = this.pending; this.pending = undefined;
    if (!view) return;
    const signature = JSON.stringify(view);
    if (signature === this.sent) return;
    this.sent = signature; this.remember(view);
    void this.save(view).catch(error => { if (this.sent === signature) this.sent = ''; this.fail(error); });
  }
  close(view: SessionView, flush: (view: SessionView) => void) {
    clearTimeout(this.timer); this.timer = undefined; this.pending = undefined;
    this.remember(view); flush(view);
  }
}
