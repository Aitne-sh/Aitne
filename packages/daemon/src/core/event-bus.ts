import { Heap } from "heap-js";
import type { Event } from "@aitne/shared";
import { createLogger } from "../logging.js";

const logger = createLogger("event-bus");

type HeapEntry = [priority: number, seq: number, event: Event];

/**
 * Priority queue for events backed by a binary min-heap (heap-js).
 *
 * - O(log n) insert via `put()`
 * - O(log n) extract-min via `get()`
 * - Eviction of lowest-priority (highest numeric value) items when full
 */
export class EventBus {
  private readonly heap: Heap<HeapEntry>;
  private counter = 0;
  private readonly maxSize: number;
  private waitQueue: Array<(closed?: boolean) => void> = [];
  private closed = false;
  /**
   * Management Mode Phase 2 migration hook — when true, `get()` blocks
   * consumers instead of returning events. `put()` keeps enqueuing so
   * adapters can continue accepting inbound messages during a migration;
   * they just don't fire until `resumeDispatch()`. Not persisted —
   * resumed on daemon restart.
   */
  private dispatchPaused = false;

  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
    this.heap = new Heap<HeapEntry>(
      (a, b) => a[0] - b[0] || a[1] - b[1],
    );
  }

  async put(event: Event): Promise<void> {
    if (this.heap.size() >= this.maxSize) {
      // Find the worst (highest priority number = lowest priority) entry
      const worst = this.findWorst();
      if (worst && event.priority <= worst[0]) {
        // New event is at least as important — evict the worst
        const evicted = worst[2];
        this.heap.remove(worst, (a, b) => a[1] === b[1]); // match by seq
        logger.warn(
          { evictedType: evicted.type, evictedPriority: evicted.priority, newType: event.type, queueSize: this.maxSize },
          "Event evicted from full queue",
        );
      } else {
        // New event is strictly lower priority than all existing — drop it
        logger.warn(
          { droppedType: event.type, droppedPriority: event.priority, queueSize: this.maxSize },
          "Event dropped — queue full and lower priority than all existing",
        );
        return;
      }
    }

    this.heap.push([event.priority, this.counter++, event]);

    // Wake one waiting consumer
    const waiter = this.waitQueue.shift();
    waiter?.();
  }

  async get(): Promise<Event | null> {
    while (this.heap.size() === 0 || this.dispatchPaused) {
      if (this.closed) return null;
      const wasClosed = await new Promise<boolean | undefined>((resolve) => {
        this.waitQueue.push((closed) => resolve(closed));
      });
      if (wasClosed) return null;
    }
    const entry = this.heap.pop();
    // Loop exit guarantees heap.size() > 0 → pop() returns a value; the
    // `: null` branch below is defensive only.
    /* c8 ignore next */
    return entry ? entry[2] : null;
  }

  /** Unblock all waiting get() calls, causing them to return null. */
  close(): void {
    this.closed = true;
    for (const waiter of this.waitQueue) {
      waiter(true);
    }
    this.waitQueue = [];
  }

  /**
   * Block dispatch of new events without dropping the queue. Used by the
   * Management Mode migration endpoint so in-flight events (cron ticks,
   * delivery retries) don't fire against a half-moved vault. Pairs with
   * `resumeDispatch()` in a try/finally.
   *
   * Waiting `get()` consumers are NOT woken up — they sleep until a
   * real event or `close()` arrives. This means a paused bus holds
   * whichever consumer happened to be polling; see `resumeDispatch()`
   * for the release semantics.
   */
  pauseDispatch(): void {
    this.dispatchPaused = true;
    logger.info("EventBus dispatch paused");
  }

  /**
   * Re-enable dispatch. If consumers were sleeping on `get()` while
   * paused, wake them proportionally to queued events so they can
   * resume pulling. A single notify per queued entry is enough: each
   * woken consumer either pops its event or loops and re-parks.
   */
  resumeDispatch(): void {
    if (!this.dispatchPaused) return;
    this.dispatchPaused = false;
    const backlog = this.heap.size();
    for (let i = 0; i < backlog; i++) {
      const waiter = this.waitQueue.shift();
      if (!waiter) break;
      waiter();
    }
    logger.info({ backlog }, "EventBus dispatch resumed");
  }

  isDispatchPaused(): boolean {
    return this.dispatchPaused;
  }

  get size(): number {
    return this.heap.size();
  }

  /**
   * Find the entry with the worst (highest numeric) priority.
   * Scans heap leaves — O(n/2) in the worst case, but only runs
   * when the queue is full (maxSize reached), which is rare.
   */
  private findWorst(): HeapEntry | null {
    const arr = this.heap.toArray();
    // Only called when heap.size() >= maxSize; the empty array branch is
    // defensive against future callers.
    /* c8 ignore next */
    if (arr.length === 0) return null;
    let worst = arr[0];
    for (let i = 1; i < arr.length; i++) {
      if (arr[i][0] > worst[0] || (arr[i][0] === worst[0] && arr[i][1] < worst[1])) {
        worst = arr[i];
      }
    }
    return worst;
  }
}
