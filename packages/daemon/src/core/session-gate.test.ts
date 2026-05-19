import { describe, it, expect } from "vitest";
import { SessionGateRegistry } from "./session-gate.js";

/**
 * Defer factory — returns a Promise plus an external resolver so a
 * test can choreograph "task A holds the gate; we hand off to task B
 * only when A's promise resolves."
 */
function defer<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("SessionGateRegistry.runWithSessionGate", () => {
  it("serializes calls on the same key (FIFO)", async () => {
    const reg = new SessionGateRegistry();
    const order: string[] = [];
    const aDone = defer();

    const first = reg.runWithSessionGate("k", async () => {
      await aDone.promise;
      order.push("a");
    });
    const second = reg.runWithSessionGate("k", async () => {
      order.push("b");
    });

    expect(order).toEqual([]);
    aDone.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["a", "b"]);
  });

  it("does not serialize calls on different keys", async () => {
    const reg = new SessionGateRegistry();
    const aDone = defer();
    const order: string[] = [];

    const first = reg.runWithSessionGate("ka", async () => {
      await aDone.promise;
      order.push("a");
    });
    // Independent key — completes immediately even though `ka`
    // is still holding its gate.
    await reg.runWithSessionGate("kb", async () => {
      order.push("b");
    });
    expect(order).toEqual(["b"]);
    aDone.resolve();
    await first;
    expect(order).toEqual(["b", "a"]);
  });

  it("releases the chain on exception so a later acquire still proceeds", async () => {
    const reg = new SessionGateRegistry();
    await expect(
      reg.runWithSessionGate("k", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const result = await reg.runWithSessionGate("k", async () => "ok");
    expect(result).toBe("ok");
  });
});

describe("SessionGateRegistry.runWithSessionGates — deadlock-free contract", () => {
  it("two callers requesting overlapping keys in opposite orders both complete", async () => {
    // SCHEDULED-DM-IMPLEMENTATION-PLAN §3.6 — the sort-then-acquire
    // contract MUST hold so independent callers requesting [A, B] and
    // [B, A] never deadlock by acquiring locks in opposite orders.
    const reg = new SessionGateRegistry();
    const order: string[] = [];

    const callerOne = reg.runWithSessionGates(["A", "B"], async () => {
      order.push("one");
    });
    const callerTwo = reg.runWithSessionGates(["B", "A"], async () => {
      order.push("two");
    });

    await Promise.all([callerOne, callerTwo]);
    // Both callers finished. Order is FIFO of acquisition (caller one
    // arrived first); the contract is "no deadlock", not "specific
    // interleaving". Asserting both completed is the load-bearing claim.
    expect(order).toHaveLength(2);
    expect(new Set(order)).toEqual(new Set(["one", "two"]));
  });

  it("acquires the smallest key first regardless of input order (sort contract)", async () => {
    const reg = new SessionGateRegistry();

    // Hold key "A" with an unresolved gate so the multi-gate caller
    // can only proceed after we release. With the sort contract,
    // runWithSessionGates(["B", "A"], ...) MUST attempt to acquire
    // "A" (lex-smallest) first, so it queues behind our holder. If
    // the contract were broken, it might acquire "B" first and
    // succeed without waiting on "A".
    const holderRelease = defer();
    const holder = reg.runWithSessionGate("A", async () => {
      await holderRelease.promise;
    });

    let multiCompleted = false;
    const multi = reg
      .runWithSessionGates(["B", "A"], async () => {
        multiCompleted = true;
      })
      .then(() => {
        // capture marker
      });

    // Yield once so any synchronous promise reactions settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(multiCompleted).toBe(false);

    holderRelease.resolve();
    await holder;
    await multi;
    expect(multiCompleted).toBe(true);
  });

  it("invokes fn even with an empty key list", async () => {
    const reg = new SessionGateRegistry();
    const result = await reg.runWithSessionGates([], async () => 42);
    expect(result).toBe(42);
  });
});

describe("SessionGateRegistry — test seams", () => {
  it("activeKeys() reflects in-flight gates and clears when they finish", async () => {
    const reg = new SessionGateRegistry();
    const release = defer();
    const inFlight = reg.runWithSessionGate("k", async () => {
      await release.promise;
    });
    expect([...reg.activeKeys()]).toContain("k");
    expect(reg.has("k")).toBe(true);
    release.resolve();
    await inFlight;
    expect([...reg.activeKeys()]).toEqual([]);
    expect(reg.has("k")).toBe(false);
    expect(reg.size).toBe(0);
  });
});
