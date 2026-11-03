import type { Availability } from "./types.ts";
import type { RequestOptions } from "./socket-transport.ts";

export interface UiEntry { name: string; status: Availability }
export interface UiSource { list(options: RequestOptions): Promise<UiEntry[]> }
export interface UiClock {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(timer: unknown): void;
}
const clock: UiClock = {
  setInterval: (callback, ms) => { const timer = setInterval(callback, ms); timer.unref(); return timer; },
  clearInterval: timer => clearInterval(timer as ReturnType<typeof setInterval>),
};

/** One session, one polling owner. Consumers never initiate their own refresh. */
export class UiRefresh {
  snapshot: readonly UiEntry[] = [];
  error: string | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly lifetime = new AbortController();
  private timer: unknown;
  private running: Promise<void> | undefined;
  constructor(privateSource: UiSource, privateClock: UiClock = clock) {
    this.source = privateSource;
    this.clock = privateClock;
  }
  private readonly source: UiSource;
  private readonly clock: UiClock;
  start(): void {
    if (this.timer !== undefined || this.lifetime.signal.aborted) return;
    this.timer = this.clock.setInterval(() => { void this.refresh(); }, 1000);
    void this.refresh();
  }
  settled(): Promise<void> { return this.running ?? Promise.resolve(); }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  refresh(): Promise<void> {
    if (this.lifetime.signal.aborted) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.poll().finally(() => { this.running = undefined; });
    return this.running;
  }
  private async poll(): Promise<void> {
    try {
      // Manager's deadline covers connect + identity + inspect, per entry. Its
      // parallel list isolates unavailable peers; no wait=true or UI-owned socket.
      const entries = await this.source.list({ timeoutMs: 600, signal: this.lifetime.signal });
      if (this.lifetime.signal.aborted) return;
      this.snapshot = entries;
      this.error = undefined;
    } catch (error) {
      if (this.lifetime.signal.aborted) return;
      this.error = error instanceof Error ? error.message : String(error);
      this.snapshot = this.snapshot.map(entry => ({ name: entry.name,
        status: { available: false, reason: "connection-error", error: { message: this.error! } } }));
    }
    for (const listener of this.listeners) listener();
  }
  stop(): void {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort();
    if (this.timer !== undefined) this.clock.clearInterval(this.timer);
    this.timer = undefined;
    this.listeners.clear();
    this.snapshot = [];
  }
}
