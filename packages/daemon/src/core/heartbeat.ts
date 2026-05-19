/**
 * Daemon heartbeat — feeds `lastTickAt` into `/api/health` so the
 * dashboard's NotificationsPanel can detect a frozen event loop.
 *
 * See docs/design/20-notifications-center.md.
 *
 * The detection model: a `setInterval` callback can only fire when the
 * Node event loop is making progress, so a stale `lastTickAt` (>90s old
 * from the dashboard's perspective) is a positive signal that the loop
 * is blocked or the daemon has crashed without releasing the port.
 *
 * The heartbeat is intentionally trivial — no business logic, no DB
 * writes — so a stuck poller, scheduler, or queue does not bleed into
 * the freshness check. It is *not* persisted across restarts: after a
 * boot, the dashboard receives a fresh value immediately and any
 * frozen-state alert clears on its own.
 */

const HEARTBEAT_INTERVAL_MS = 30_000;

export class Heartbeat {
  private lastTickAt: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.lastTickAt = Date.now();
  }

  start(): void {
    if (this.timer !== null) return;
    this.lastTickAt = Date.now();
    this.timer = setInterval(() => {
      this.lastTickAt = Date.now();
    }, HEARTBEAT_INTERVAL_MS);
    // Don't keep the process alive solely for the heartbeat — daemon
    // shutdown should win even if stop() is missed.
    if (typeof this.timer === "object" && this.timer !== null) {
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getLastTickAt(): number {
    return this.lastTickAt;
  }
}
