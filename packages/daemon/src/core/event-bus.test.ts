import { describe, it, expect } from "vitest";
import { EventBus } from "./event-bus.js";
import { createEvent, EventPriority } from "@aitne/shared";

function makeEvent(priority: EventPriority, type = "test.event") {
  return createEvent({ type, source: "test", priority });
}

describe("EventBus", () => {
  it("returns events in priority order", async () => {
    const bus = new EventBus();

    await bus.put(makeEvent(EventPriority.LOW));
    await bus.put(makeEvent(EventPriority.CRITICAL));
    await bus.put(makeEvent(EventPriority.NORMAL));

    const first = await bus.get();
    const second = await bus.get();
    const third = await bus.get();

    expect(first?.priority).toBe(EventPriority.CRITICAL);
    expect(second?.priority).toBe(EventPriority.NORMAL);
    expect(third?.priority).toBe(EventPriority.LOW);
  });

  it("maintains FIFO within same priority", async () => {
    const bus = new EventBus();

    await bus.put(makeEvent(EventPriority.NORMAL, "first"));
    await bus.put(makeEvent(EventPriority.NORMAL, "second"));
    await bus.put(makeEvent(EventPriority.NORMAL, "third"));

    const first = await bus.get();
    const second = await bus.get();
    const third = await bus.get();

    expect(first?.type).toBe("first");
    expect(second?.type).toBe("second");
    expect(third?.type).toBe("third");
  });

  it("evicts lowest priority when maxSize reached", async () => {
    const bus = new EventBus(2);

    await bus.put(makeEvent(EventPriority.NORMAL, "a"));
    await bus.put(makeEvent(EventPriority.LOW, "b"));
    expect(bus.size).toBe(2);

    // HIGH event should evict LOW
    await bus.put(makeEvent(EventPriority.HIGH, "c"));
    expect(bus.size).toBe(2);

    const first = await bus.get();
    const second = await bus.get();

    expect(first?.priority).toBe(EventPriority.HIGH);
    expect(second?.priority).toBe(EventPriority.NORMAL);
  });

  it("drops new event only if strictly lower priority than all existing", async () => {
    const bus = new EventBus(2);

    await bus.put(makeEvent(EventPriority.HIGH, "a"));
    await bus.put(makeEvent(EventPriority.HIGH, "b"));

    // LOW event should be dropped since all existing are strictly higher
    await bus.put(makeEvent(EventPriority.LOW, "dropped"));
    expect(bus.size).toBe(2);

    const first = await bus.get();
    const second = await bus.get();
    expect(first!.type).toBe("a");
    expect(second!.type).toBe("b");
  });

  it("same-priority new event evicts oldest same-priority event", async () => {
    const bus = new EventBus(2);

    await bus.put(makeEvent(EventPriority.NORMAL, "old1"));
    await bus.put(makeEvent(EventPriority.NORMAL, "old2"));

    // Same priority → should evict one and accept the new event
    await bus.put(makeEvent(EventPriority.NORMAL, "new"));
    expect(bus.size).toBe(2);
  });

  it("awaits on empty queue", async () => {
    const bus = new EventBus();
    let resolved = false;

    const promise = bus.get().then((event) => {
      resolved = true;
      return event;
    });

    // Should not resolve immediately
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false);

    // Now put an event
    await bus.put(makeEvent(EventPriority.NORMAL, "delayed"));
    const event = await promise;

    expect(resolved).toBe(true);
    expect(event!.type).toBe("delayed");
  });

  it("close() unblocks waiting get() with null", async () => {
    const bus = new EventBus();

    const promise = bus.get();
    bus.close();

    const result = await promise;
    expect(result).toBeNull();
  });

  it("get() returns null immediately on a bus that was already closed", async () => {
    const bus = new EventBus();
    bus.close();
    // Empty heap + closed → loop entry hits the `if (this.closed)` branch.
    expect(await bus.get()).toBeNull();
  });

  it("reports correct size", async () => {
    const bus = new EventBus();
    expect(bus.size).toBe(0);

    await bus.put(makeEvent(EventPriority.NORMAL));
    expect(bus.size).toBe(1);

    await bus.put(makeEvent(EventPriority.HIGH));
    expect(bus.size).toBe(2);

    await bus.get();
    expect(bus.size).toBe(1);
  });

  describe("pauseDispatch / resumeDispatch (Management Mode Phase 2)", () => {
    it("isDispatchPaused() reports the current state", () => {
      const bus = new EventBus();
      expect(bus.isDispatchPaused()).toBe(false);
      bus.pauseDispatch();
      expect(bus.isDispatchPaused()).toBe(true);
      bus.resumeDispatch();
      expect(bus.isDispatchPaused()).toBe(false);
    });

    it("get() blocks while paused even if events are queued", async () => {
      const bus = new EventBus();
      await bus.put(makeEvent(EventPriority.NORMAL, "ready"));
      bus.pauseDispatch();

      let resolved = false;
      const promise = bus.get().then((event) => {
        resolved = true;
        return event;
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(resolved).toBe(false);

      bus.resumeDispatch();
      const event = await promise;
      expect(event?.type).toBe("ready");
    });

    it("resumeDispatch() is a no-op when not paused", () => {
      const bus = new EventBus();
      // Not paused — early return path.
      bus.resumeDispatch();
      expect(bus.isDispatchPaused()).toBe(false);
    });

    it("resumeDispatch() wakes up to `backlog` waiters even when more are parked", async () => {
      const bus = new EventBus();
      // Park three consumers.
      const promises = [bus.get(), bus.get(), bus.get()];
      bus.pauseDispatch();
      // Single queued event — only one waiter should be woken on resume.
      await bus.put(makeEvent(EventPriority.NORMAL, "single"));
      bus.resumeDispatch();

      const first = await Promise.race([
        promises[0].then((e) => ["0", e] as const),
        promises[1].then((e) => ["1", e] as const),
        promises[2].then((e) => ["2", e] as const),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("no waiter woke")), 100),
        ),
      ]);
      expect(first[1]?.type).toBe("single");

      // Cleanup: close to unblock the remaining two consumers.
      bus.close();
      await Promise.all(promises);
    });

    it("resumeDispatch() with backlog>waiters falls through the loop break", async () => {
      const bus = new EventBus();
      bus.pauseDispatch();
      await bus.put(makeEvent(EventPriority.NORMAL, "a"));
      await bus.put(makeEvent(EventPriority.NORMAL, "b"));
      // backlog=2, waiters=0 → loop hits the `break` on the first miss.
      bus.resumeDispatch();
      expect(bus.size).toBe(2);
      expect(bus.isDispatchPaused()).toBe(false);

      // Drain the queue normally.
      const first = await bus.get();
      const second = await bus.get();
      expect(first?.type).toBe("a");
      expect(second?.type).toBe("b");
    });
  });
});
