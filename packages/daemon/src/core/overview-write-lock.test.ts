import { afterEach, describe, expect, it } from "vitest";
import {
  _resetOverviewWriteLocksForTests,
  withOverviewWriteLock,
} from "./overview-write-lock.js";

describe("withOverviewWriteLock", () => {
  afterEach(() => {
    _resetOverviewWriteLocksForTests();
  });

  it("serializes concurrent operations on the same path", async () => {
    const order: string[] = [];
    const slowFirst = withOverviewWriteLock("/tmp/a", async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push("first-end");
      return "first";
    });
    const fastSecond = withOverviewWriteLock("/tmp/a", () => {
      order.push("second");
      return "second";
    });

    const [a, b] = await Promise.all([slowFirst, fastSecond]);
    expect(a).toBe("first");
    expect(b).toBe("second");
    expect(order).toEqual(["first-end", "second"]);
  });

  it("does not serialize across different paths", async () => {
    const order: string[] = [];
    const slowA = withOverviewWriteLock("/tmp/a", async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push("a");
    });
    const fastB = withOverviewWriteLock("/tmp/b", () => {
      order.push("b");
    });

    await Promise.all([slowA, fastB]);
    // B finishes first because it doesn't wait on A.
    expect(order).toEqual(["b", "a"]);
  });

  it("a rejection in one critical section does not block later callers", async () => {
    const order: string[] = [];
    const failing = withOverviewWriteLock("/tmp/a", () => {
      order.push("fail");
      throw new Error("boom");
    });
    const next = withOverviewWriteLock("/tmp/a", () => {
      order.push("after");
      return "ok";
    });

    await expect(failing).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ok");
    expect(order).toEqual(["fail", "after"]);
  });
});
