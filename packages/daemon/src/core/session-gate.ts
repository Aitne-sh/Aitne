/**
 * Per-key serialization registry. Each key gets a chain of pending
 * promises; `runWithSessionGate` queues a new task to the tail of
 * the chain and resolves once it has the gate. Multi-gate variant
 * acquires keys in sorted order so independent callers requesting
 * overlapping sets never deadlock.
 *
 * Extracted from `EventDispatcher` so the deadlock-prevention
 * contract (sort-then-acquire) can be tested without spinning up a
 * full dispatcher.
 *
 * SCHEDULED-DM-IMPLEMENTATION-PLAN §3.6.
 */
export class SessionGateRegistry {
  private readonly chains = new Map<string, Promise<void>>();

  async runWithSessionGate<T>(
    key: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.then(() => current);
    this.chains.set(key, chain);

    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.chains.get(key) === chain) {
        this.chains.delete(key);
      }
    }
  }

  /**
   * Acquire multiple session gates sequentially in lexicographic
   * order before invoking `fn`, then release in reverse order via
   * the natural unwind of `runWithSessionGate`'s try/finally.
   *
   * Sort order is the deadlock-prevention contract — every
   * multi-gate acquisition uses the same lexicographic order, so
   * independent callers requesting overlapping key sets always
   * acquire common keys in the same order.
   */
  async runWithSessionGates<T>(
    keys: string[],
    fn: () => Promise<T>,
  ): Promise<T> {
    const sorted = [...keys].sort();
    const acquire = async (i: number): Promise<T> => {
      if (i >= sorted.length) return fn();
      return this.runWithSessionGate(sorted[i], () => acquire(i + 1));
    };
    return acquire(0);
  }

  /** Test seam — number of currently-tracked keys. */
  get size(): number {
    return this.chains.size;
  }

  /** Test seam — predicate for whether a key currently has a chain. */
  has(key: string): boolean {
    return this.chains.has(key);
  }

  /** Iterate every key that currently has a pending chain. Used by
   *  `EventDispatcher.getInFlightExecutions()` to surface in-flight
   *  serialized work to the migration-context endpoint. */
  activeKeys(): IterableIterator<string> {
    return this.chains.keys();
  }
}
