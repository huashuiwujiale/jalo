import type { Followup } from '../shared/types';

/** Only complete groups enter model history; the runner drains this at tool boundaries. */
export class SteeringInbox {
  private pending = new Map<string, Followup>();
  private seen = new Set<string>();
  add(value: Followup) {
    if (!value || value.kind !== 'steer' || typeof value.id !== 'string' || typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 16000) return;
    if (this.seen.has(value.id) || this.pending.size >= 20) return;
    this.seen.add(value.id); this.pending.set(value.id, value);
  }
  take() { const values = [...this.pending.values()]; this.pending.clear(); return values; }
}
