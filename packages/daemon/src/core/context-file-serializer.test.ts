import { beforeEach, describe, expect, it } from "vitest";
import {
  _pendingPathCountForTesting,
  _resetContextFileSerializerForTesting,
  serializeContextFileWrite,
} from "./context-file-serializer.js";

describe("serializeContextFileWrite", () => {
  beforeEach(() => {
    _resetContextFileSerializerForTesting();
  });

  it("runs the fn and returns its value", async () => {
    const result = await serializeContextFileWrite("/a", () => 42);
    expect(result).toBe(42);
  });

  it("awaits async fns and returns the resolved value", async () => {
    const result = await serializeContextFileWrite("/a", async () => {
      await new Promise((r) => setTimeout(r, 1));
      return "done";
    });
    expect(result).toBe("done");
  });

  it("serializes concurrent calls to the same path — second waits for first", async () => {
    const events: string[] = [];
    const first = serializeContextFileWrite("/a", async () => {
      events.push("first:start");
      await new Promise((r) => setTimeout(r, 10));
      events.push("first:end");
    });
    const second = serializeContextFileWrite("/a", () => {
      events.push("second:run");
    });

    await Promise.all([first, second]);
    // The fence: first MUST fully finish (end) before second starts.
    expect(events).toEqual(["first:start", "first:end", "second:run"]);
  });

  it("does NOT serialize calls to different paths", async () => {
    const events: string[] = [];
    const a = serializeContextFileWrite("/a", async () => {
      events.push("a:start");
      await new Promise((r) => setTimeout(r, 10));
      events.push("a:end");
    });
    const b = serializeContextFileWrite("/b", async () => {
      events.push("b:start");
      await new Promise((r) => setTimeout(r, 1));
      events.push("b:end");
    });

    await Promise.all([a, b]);
    // /b is much faster, so it should finish before /a — the two paths
    // do not block each other.
    const bEndIdx = events.indexOf("b:end");
    const aEndIdx = events.indexOf("a:end");
    expect(bEndIdx).toBeLessThan(aEndIdx);
  });

  it("propagates a sync fn throw to the caller without blocking successors", async () => {
    const events: string[] = [];
    const first = serializeContextFileWrite("/a", () => {
      events.push("first");
      throw new Error("boom");
    });
    const second = serializeContextFileWrite("/a", () => {
      events.push("second");
      return "ok";
    });

    await expect(first).rejects.toThrow("boom");
    await expect(second).resolves.toBe("ok");
    expect(events).toEqual(["first", "second"]);
  });

  it("propagates an async fn rejection without blocking successors", async () => {
    const first = serializeContextFileWrite("/a", async () => {
      throw new Error("async-boom");
    });
    const second = serializeContextFileWrite("/a", () => "ok");

    await expect(first).rejects.toThrow("async-boom");
    await expect(second).resolves.toBe("ok");
  });

  it("clears the map entry once the chain drains (no leak)", async () => {
    await serializeContextFileWrite("/a", () => 1);
    await serializeContextFileWrite("/a", () => 2);
    await serializeContextFileWrite("/b", () => 3);
    expect(_pendingPathCountForTesting()).toBe(0);
  });

  it("retains the map entry while a successor is still queued", async () => {
    // Hold first open via a pre-created gate so `releaseFirst` is
    // assigned synchronously before serializeContextFileWrite runs.
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = serializeContextFileWrite("/a", () => firstGate);
    const second = serializeContextFileWrite("/a", () => "second");

    // While both are pending, the map MUST hold the entry — clearing
    // it would let a third caller start unblocked, defeating the queue.
    expect(_pendingPathCountForTesting()).toBe(1);
    releaseFirst();
    await Promise.all([first, second]);
    expect(_pendingPathCountForTesting()).toBe(0);
  });
});
