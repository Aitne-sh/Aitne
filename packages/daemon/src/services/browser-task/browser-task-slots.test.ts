/**
 * browser-task-slots — pure §5.1 Plan A test coverage.
 *
 * Targets every row of §13's "Slot manager" coverage table:
 *   - acquire-when-free promotes pending → running
 *   - acquire-when-siteKey-held queues with `blockedBy` populated
 *   - acquire-when-global-cap-full queues with `globalPos` populated
 *   - release-pops-siteKey-head + consults global FIFO
 *   - browserTaskMaxConcurrent range clamp (1..5)
 *   - cancel-while-pending removes from BOTH FIFOs without firing
 *     a release cascade
 *   - pending-queue-timeout transition emits the expired list
 *   - queueState shape on GET /:id (sitePos / globalPos / blockedBy /
 *     blockedByPhase)
 *   - re-entrancy guard (release that triggers promotion that triggers
 *     release does not recurse — exercised via cascading releases)
 */

import { describe, expect, it } from "vitest";

import {
  clampMaxConcurrent,
  clampPendingQueueTimeoutMinutes,
  createInitialSlotState,
  decideAcquire,
  decideCancel,
  decidePark,
  decideRelease,
  decideUnpark,
  readQueueState,
  snapshotSlotState,
  sweepPendingTimeouts,
  withMaxConcurrent,
} from "./browser-task-slots.js";

function entry(taskId: string, siteKey: string, enqueuedAt = 1000) {
  return { taskId, siteKey, enqueuedAt };
}

describe("clampMaxConcurrent", () => {
  it("clamps below 1 to 1", () => {
    expect(clampMaxConcurrent(0)).toBe(1);
    expect(clampMaxConcurrent(-7)).toBe(1);
  });

  it("clamps above 5 to 5", () => {
    expect(clampMaxConcurrent(10)).toBe(5);
  });

  it("returns 3 for non-finite", () => {
    expect(clampMaxConcurrent(Number.NaN)).toBe(3);
    expect(clampMaxConcurrent(Number.POSITIVE_INFINITY)).toBe(3);
  });

  it("rounds non-integer down", () => {
    expect(clampMaxConcurrent(3.7)).toBe(3);
  });
});

describe("clampPendingQueueTimeoutMinutes", () => {
  it("clamps below 5 to 5", () => {
    expect(clampPendingQueueTimeoutMinutes(0)).toBe(5);
    expect(clampPendingQueueTimeoutMinutes(4)).toBe(5);
  });

  it("clamps above 180 to 180", () => {
    expect(clampPendingQueueTimeoutMinutes(500)).toBe(180);
  });

  it("returns 30 for non-finite", () => {
    expect(clampPendingQueueTimeoutMinutes(Number.NaN)).toBe(30);
  });

  it("rounds down", () => {
    expect(clampPendingQueueTimeoutMinutes(7.9)).toBe(7);
  });
});

describe("decideAcquire — siteKey & global free", () => {
  it("promotes immediately when both are free", () => {
    const state = createInitialSlotState(3);
    const result = decideAcquire(state, entry("a", "amazon_jp", 100), 200);
    expect(result.effect.kind).toBe("promoted");
    if (result.effect.kind !== "promoted") throw new Error("kind");
    expect(result.effect.taskId).toBe("a");
    expect(result.effect.siteKey).toBe("amazon_jp");
    expect(result.effect.acquiredAt).toBe(200);
    expect(result.effect.waitedMs).toBe(0);
    expect(result.state.active.size).toBe(1);
    expect(result.state.globalQueue).toHaveLength(0);
  });

  it("throws on duplicate id (active occupant)", () => {
    let state = createInitialSlotState(3);
    state = decideAcquire(state, entry("a", "amazon_jp"), 100).state;
    expect(() =>
      decideAcquire(state, entry("a", "x_com"), 200),
    ).toThrow(/already tracked/);
  });

  it("throws on duplicate id (queued)", () => {
    let state = createInitialSlotState(1);
    state = decideAcquire(state, entry("a", "amazon_jp"), 100).state;
    state = decideAcquire(state, entry("b", "amazon_jp"), 200).state;
    expect(() =>
      decideAcquire(state, entry("b", "x_com"), 300),
    ).toThrow(/already tracked/);
  });
});

describe("decideAcquire — siteKey blocked", () => {
  it("queues behind the active occupant with blockedBy populated", () => {
    let state = createInitialSlotState(3);
    state = decideAcquire(state, entry("a", "amazon_jp", 100), 100).state;
    const result = decideAcquire(state, entry("b", "amazon_jp", 200), 200);
    expect(result.effect.kind).toBe("queued");
    if (result.effect.kind !== "queued") throw new Error("kind");
    expect(result.effect.sitePos).toBe(0);
    expect(result.effect.globalPos).toBe(0);
    expect(result.effect.blockedBy).toBe("a");
    expect(result.effect.blockedByPhase).toBe("running");
  });

  it("reports parked phase when occupant is parked", () => {
    let state = createInitialSlotState(3);
    state = decideAcquire(state, entry("a", "amazon_jp", 100), 100).state;
    state = decidePark(state, "a");
    const result = decideAcquire(state, entry("b", "amazon_jp", 200), 200);
    if (result.effect.kind !== "queued") throw new Error("kind");
    expect(result.effect.blockedByPhase).toBe("parked");
  });
});

describe("decideAcquire — global cap full", () => {
  it("queues with no blockedBy when only global pressure", () => {
    let state = createInitialSlotState(1);
    state = decideAcquire(state, entry("a", "amazon_jp", 100), 100).state;
    const result = decideAcquire(state, entry("b", "x_com", 200), 200);
    if (result.effect.kind !== "queued") throw new Error("kind");
    expect(result.effect.sitePos).toBe(0);
    expect(result.effect.globalPos).toBe(0);
    expect(result.effect.blockedBy).toBeNull();
    expect(result.effect.blockedByPhase).toBeNull();
  });

  it("multiple entries enqueue at the tail of both FIFOs", () => {
    let state = createInitialSlotState(1);
    state = decideAcquire(state, entry("a", "amazon_jp", 100), 100).state;
    state = decideAcquire(state, entry("b", "x_com", 200), 200).state;
    const result = decideAcquire(state, entry("c", "amazon_jp", 300), 300);
    if (result.effect.kind !== "queued") throw new Error("kind");
    expect(result.effect.sitePos).toBe(0); // c is head of amazon_jp queue (b is in x_com)
    expect(result.effect.globalPos).toBe(1); // [b, c]
  });
});

describe("decidePark / decideUnpark", () => {
  it("park marks the active slot as parked", () => {
    let state = createInitialSlotState(3);
    state = decideAcquire(state, entry("a", "amazon_jp"), 100).state;
    state = decidePark(state, "a");
    const snap = snapshotSlotState(state);
    expect(snap.active[0]?.phase).toBe("parked");
  });

  it("park is idempotent", () => {
    let state = createInitialSlotState(3);
    state = decideAcquire(state, entry("a", "amazon_jp"), 100).state;
    state = decidePark(state, "a");
    expect(() => decidePark(state, "a")).not.toThrow();
  });

  it("unpark restores running phase", () => {
    let state = createInitialSlotState(3);
    state = decideAcquire(state, entry("a", "amazon_jp"), 100).state;
    state = decidePark(state, "a");
    state = decideUnpark(state, "a");
    expect(snapshotSlotState(state).active[0]?.phase).toBe("running");
  });

  it("unpark on already-running is a no-op", () => {
    let state = createInitialSlotState(3);
    state = decideAcquire(state, entry("a", "amazon_jp"), 100).state;
    expect(() => decideUnpark(state, "a")).not.toThrow();
  });

  it("park / unpark throws when the task is not active", () => {
    const state = createInitialSlotState(3);
    expect(() => decidePark(state, "x")).toThrow(/not active/);
    expect(() => decideUnpark(state, "x")).toThrow(/not active/);
  });
});

describe("decideRelease — siteKey FIFO head promotion", () => {
  it("releases + promotes the next pending on the same siteKey", () => {
    let state = createInitialSlotState(3);
    state = decideAcquire(state, entry("a", "amazon_jp", 100), 100).state;
    state = decideAcquire(state, entry("b", "amazon_jp", 200), 200).state;
    const result = decideRelease(state, "a", 1000);
    const kinds = result.effects.map((e) => e.kind);
    expect(kinds).toContain("released");
    expect(kinds).toContain("promoted");
    const promoted = result.effects.find((e) => e.kind === "promoted");
    if (!promoted || promoted.kind !== "promoted") throw new Error("missing");
    expect(promoted.taskId).toBe("b");
    expect(promoted.waitedMs).toBe(800);
    expect(result.state.active.has("amazon_jp")).toBe(true);
    expect(result.state.globalQueue).toHaveLength(0);
  });

  it("preserves remaining siteKey queue entries after promotion (3+ tasks on one siteKey)", () => {
    // Three tasks on amazon_jp + one on x_com. After releasing `a`,
    // `b` promotes; the siteQueue for amazon_jp still has `c` (and
    // x_com's `d` stays). This exercises the
    // `trimmedSiteQueue.length > 0` arm of applyPromotion that
    // single- + two-task-per-siteKey tests don't cover.
    let state = createInitialSlotState(1);
    state = decideAcquire(state, entry("a", "amazon_jp", 100), 100).state;
    state = decideAcquire(state, entry("b", "amazon_jp", 200), 200).state;
    state = decideAcquire(state, entry("c", "amazon_jp", 300), 300).state;
    state = decideAcquire(state, entry("d", "x_com", 400), 400).state;
    const result = decideRelease(state, "a", 1000);
    expect(result.state.active.has("amazon_jp")).toBe(true);
    expect(result.state.active.get("amazon_jp")?.taskId).toBe("b");
    // amazon_jp's siteQueue still holds c; x_com's holds d.
    expect(result.state.siteQueues.get("amazon_jp")?.map((q) => q.taskId)).toEqual(["c"]);
    expect(result.state.siteQueues.get("x_com")?.map((q) => q.taskId)).toEqual(["d"]);
  });

  it("on release with no candidate emits released alone (no queue_state_changed)", () => {
    let state = createInitialSlotState(3);
    state = decideAcquire(state, entry("a", "amazon_jp"), 100).state;
    const result = decideRelease(state, "a", 1000);
    expect(result.effects.map((e) => e.kind)).toEqual(["released"]);
  });

  it("emits queue_state_changed listing remaining pending tasks", () => {
    let state = createInitialSlotState(1);
    state = decideAcquire(state, entry("a", "amazon_jp"), 100).state;
    state = decideAcquire(state, entry("b", "x_com"), 200).state;
    state = decideAcquire(state, entry("c", "linkedin"), 300).state;
    const result = decideRelease(state, "a", 1000);
    const qs = result.effects.find((e) => e.kind === "queue_state_changed");
    if (!qs || qs.kind !== "queue_state_changed") {
      throw new Error("queue_state_changed missing");
    }
    // b promoted (it was global head), c still pending → c is the
    // only remaining pending id.
    expect(qs.affectedTaskIds).toEqual(["c"]);
  });
});

describe("decideRelease — global FIFO honored across siteKeys", () => {
  it("does not let a same-siteKey siteQueue head cut the global line", () => {
    // global cap = 2. a:amazon_jp runs; b:amazon_jp queues; c:x_com
    // queues. When a releases, the siteKey amazon_jp's queue head is
    // b, but b can promote (siteKey free + global slot free).
    // c:x_com is at global head but does not promote because b is
    // ahead in the global queue.
    let state = createInitialSlotState(2);
    state = decideAcquire(state, entry("a", "amazon_jp", 100), 100).state;
    state = decideAcquire(state, entry("d", "x_com", 150), 150).state; // also takes a slot
    state = decideAcquire(state, entry("b", "amazon_jp", 200), 200).state; // queued (siteKey full + global full)
    state = decideAcquire(state, entry("c", "linkedin", 300), 300).state; // queued (global full)
    const result = decideRelease(state, "a", 1000);
    const promoted = result.effects.find((e) => e.kind === "promoted");
    if (!promoted || promoted.kind !== "promoted") throw new Error("missing");
    expect(promoted.taskId).toBe("b");
    // c still pending.
    expect(result.state.globalQueue.map((q) => q.taskId)).toEqual(["c"]);
  });

  it("promotes the global-head when its siteKey is now free even if siteKey-head ordering would suggest the released siteKey first", () => {
    // global cap = 1. a:amazon_jp runs; b:x_com first into queue;
    // c:amazon_jp later into queue. Release a → only b can promote
    // (global head + its siteKey x_com is free); c stays queued.
    let state = createInitialSlotState(1);
    state = decideAcquire(state, entry("a", "amazon_jp", 100), 100).state;
    state = decideAcquire(state, entry("b", "x_com", 200), 200).state;
    state = decideAcquire(state, entry("c", "amazon_jp", 300), 300).state;
    const result = decideRelease(state, "a", 1000);
    const promoted = result.effects.find((e) => e.kind === "promoted");
    if (!promoted || promoted.kind !== "promoted") throw new Error("missing");
    expect(promoted.taskId).toBe("b");
  });
});

describe("decideRelease — idempotency", () => {
  it("releasing an unknown task is a no-op", () => {
    const state = createInitialSlotState(3);
    const result = decideRelease(state, "ghost", 1000);
    expect(result.effects).toEqual([]);
    expect(result.state).toBe(state);
  });
});

describe("decideCancel", () => {
  it("removes a pending task from both FIFOs", () => {
    let state = createInitialSlotState(1);
    state = decideAcquire(state, entry("a", "amazon_jp"), 100).state;
    state = decideAcquire(state, entry("b", "x_com"), 200).state;
    const result = decideCancel(state, "b");
    expect(result.state.globalQueue.map((q) => q.taskId)).toEqual([]);
    expect(result.state.siteQueues.has("x_com")).toBe(false);
  });

  it("no effects when task is unknown", () => {
    const state = createInitialSlotState(3);
    const result = decideCancel(state, "ghost");
    expect(result.effects).toEqual([]);
    expect(result.state).toBe(state);
  });

  it("throws when target is currently active (caller must use decideRelease)", () => {
    let state = createInitialSlotState(3);
    state = decideAcquire(state, entry("a", "amazon_jp"), 100).state;
    expect(() => decideCancel(state, "a")).toThrow(/active/);
  });

  it("does NOT promote a candidate (no slot was released)", () => {
    let state = createInitialSlotState(1);
    state = decideAcquire(state, entry("a", "amazon_jp"), 100).state;
    state = decideAcquire(state, entry("b", "x_com"), 200).state;
    state = decideAcquire(state, entry("c", "linkedin"), 300).state;
    const result = decideCancel(state, "b");
    // a is still active; c stays queued.
    expect(result.state.active.size).toBe(1);
    expect(result.state.globalQueue.map((q) => q.taskId)).toEqual(["c"]);
    const promoted = result.effects.find((e) => e.kind === "promoted");
    expect(promoted).toBeUndefined();
  });

  it("emits queue_state_changed with the remaining pending ids", () => {
    let state = createInitialSlotState(1);
    state = decideAcquire(state, entry("a", "amazon_jp"), 100).state;
    state = decideAcquire(state, entry("b", "x_com"), 200).state;
    state = decideAcquire(state, entry("c", "linkedin"), 300).state;
    const result = decideCancel(state, "b");
    const qs = result.effects.find((e) => e.kind === "queue_state_changed");
    if (!qs || qs.kind !== "queue_state_changed") throw new Error("missing");
    expect(qs.affectedTaskIds).toEqual(["c"]);
  });

  it("emits nothing when cancelling the only pending row", () => {
    let state = createInitialSlotState(1);
    state = decideAcquire(state, entry("a", "amazon_jp"), 100).state;
    state = decideAcquire(state, entry("b", "x_com"), 200).state;
    const result = decideCancel(state, "b");
    expect(result.effects).toEqual([]);
  });
});

describe("sweepPendingTimeouts", () => {
  it("returns expired pending tasks past the timeout", () => {
    let state = createInitialSlotState(1);
    state = decideAcquire(state, entry("a", "amazon_jp"), 0).state; // active
    state = decideAcquire(state, entry("b", "x_com", 0), 0).state; // queued at t=0
    state = decideAcquire(state, entry("c", "linkedin", 100), 100).state;
    // 30 min timeout. now=30*60*1000 + 1 → b expires (waited 30:00:01),
    // c does not (waited 29:50).
    const nowMs = 30 * 60 * 1000 + 1;
    const result = sweepPendingTimeouts(state, nowMs, 30);
    expect(result.expired.map((e) => e.taskId)).toEqual(["b"]);
    expect(result.state.globalQueue.map((q) => q.taskId)).toEqual(["c"]);
  });

  it("returns empty when no entries are expired", () => {
    let state = createInitialSlotState(1);
    state = decideAcquire(state, entry("a", "amazon_jp"), 0).state;
    state = decideAcquire(state, entry("b", "x_com", 100), 100).state;
    const result = sweepPendingTimeouts(state, 200, 30);
    expect(result.expired).toEqual([]);
    expect(result.state).toBe(state);
  });

  it("clamps the timeout knob", () => {
    let state = createInitialSlotState(1);
    state = decideAcquire(state, entry("a", "amazon_jp"), 0).state;
    state = decideAcquire(state, entry("b", "x_com", 0), 0).state;
    // 0 → clamped to 5 min. now=4:59 → not expired; now=5:01 → expired.
    expect(
      sweepPendingTimeouts(state, 4 * 60 * 1000, 0).expired,
    ).toEqual([]);
    expect(
      sweepPendingTimeouts(state, 5 * 60 * 1000 + 1, 0).expired.map(
        (e) => e.taskId,
      ),
    ).toEqual(["b"]);
  });
});

describe("readQueueState", () => {
  it("returns null for unknown tasks", () => {
    const state = createInitialSlotState(3);
    expect(readQueueState(state, "ghost")).toBeNull();
  });

  it("returns waitingForSlot=false for active tasks", () => {
    let state = createInitialSlotState(3);
    state = decideAcquire(state, entry("a", "amazon_jp"), 100).state;
    const view = readQueueState(state, "a");
    expect(view?.waitingForSlot).toBe(false);
    expect(view?.sitePos).toBe(-1);
    expect(view?.globalPos).toBe(-1);
  });

  it("returns waitingForSlot=true with positions for pending tasks", () => {
    let state = createInitialSlotState(1);
    state = decideAcquire(state, entry("a", "amazon_jp", 100), 100).state;
    state = decideAcquire(state, entry("b", "amazon_jp", 200), 200).state;
    state = decideAcquire(state, entry("c", "x_com", 300), 300).state;
    state = decidePark(state, "a");
    const bView = readQueueState(state, "b");
    expect(bView?.waitingForSlot).toBe(true);
    expect(bView?.sitePos).toBe(0);
    expect(bView?.globalPos).toBe(0);
    expect(bView?.blockedBy).toBe("a");
    expect(bView?.blockedByPhase).toBe("parked");
    const cView = readQueueState(state, "c");
    expect(cView?.globalPos).toBe(1);
    expect(cView?.blockedBy).toBeNull(); // x_com siteKey is free; global cap blocks
  });
});

describe("withMaxConcurrent", () => {
  it("re-clamps the value", () => {
    const state = createInitialSlotState(3);
    expect(withMaxConcurrent(state, 0).maxConcurrent).toBe(1);
    expect(withMaxConcurrent(state, 99).maxConcurrent).toBe(5);
  });

  it("does NOT preemptively yank already-acquired slots", () => {
    let state = createInitialSlotState(5);
    state = decideAcquire(state, entry("a", "amazon_jp"), 100).state;
    state = decideAcquire(state, entry("b", "x_com"), 200).state;
    state = decideAcquire(state, entry("c", "linkedin"), 300).state;
    state = withMaxConcurrent(state, 1);
    expect(state.active.size).toBe(3); // still all three
    expect(state.maxConcurrent).toBe(1);
    // But a NEW acquire is rejected because active.size > maxConcurrent.
    const result = decideAcquire(state, entry("d", "facebook"), 400);
    expect(result.effect.kind).toBe("queued");
  });
});

describe("re-entrancy / cascading releases", () => {
  it("multiple sequential releases do not interfere", () => {
    let state = createInitialSlotState(2);
    state = decideAcquire(state, entry("a", "amazon_jp", 100), 100).state;
    state = decideAcquire(state, entry("b", "x_com", 200), 200).state;
    state = decideAcquire(state, entry("c", "amazon_jp", 300), 300).state;
    state = decideAcquire(state, entry("d", "linkedin", 400), 400).state;
    state = decideAcquire(state, entry("e", "facebook", 500), 500).state;
    // Release a → c (amazon_jp) promotes (was head of amazon_jp + global cap room when a leaves).
    state = decideRelease(state, "a", 1000).state;
    // Release b → first global-head that's free: d (linkedin, free slot).
    const r2 = decideRelease(state, "b", 1100);
    const promoted = r2.effects.find((e) => e.kind === "promoted");
    if (!promoted || promoted.kind !== "promoted") throw new Error("missing");
    expect(promoted.taskId).toBe("d");
    // e is still queued because global is at cap again (c + d).
    expect(r2.state.globalQueue.map((q) => q.taskId)).toEqual(["e"]);
  });
});

describe("snapshotSlotState", () => {
  it("captures active count + pending count + cap", () => {
    let state = createInitialSlotState(2);
    state = decideAcquire(state, entry("a", "amazon_jp", 100), 100).state;
    state = decideAcquire(state, entry("b", "x_com", 200), 200).state;
    state = decideAcquire(state, entry("c", "linkedin", 300), 300).state;
    const snap = snapshotSlotState(state);
    expect(snap.maxConcurrent).toBe(2);
    expect(snap.active).toHaveLength(2);
    expect(snap.pendingCount).toBe(1);
  });
});
