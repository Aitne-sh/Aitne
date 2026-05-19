import { describe, it, expect, beforeEach, vi } from "vitest";
import { LogBuffer, extractLogParts, pushToLogBuffer, getLogBuffer, resetLogBuffer } from "./log-buffer.js";

describe("LogBuffer", () => {
  let buffer: LogBuffer;

  beforeEach(() => {
    buffer = new LogBuffer(5);
  });

  it("stores and retrieves entries in order", () => {
    buffer.push({ timestamp: "t1", level: "info", logger: "a", message: "one" });
    buffer.push({ timestamp: "t2", level: "info", logger: "a", message: "two" });

    const entries = buffer.getRecent(10);
    expect(entries).toHaveLength(2);
    expect(entries[0].message).toBe("one");
    expect(entries[1].message).toBe("two");
  });

  it("assigns monotonically increasing ids", () => {
    buffer.push({ timestamp: "t1", level: "info", logger: "a", message: "one" });
    buffer.push({ timestamp: "t2", level: "info", logger: "a", message: "two" });

    const entries = buffer.getRecent(10);
    // IDs are seeded from wall-clock so dashboard `afterId` polling stays
    // monotone across daemon restarts. We only assert ordering, not the
    // absolute starting value.
    expect(entries[0].id).toBeGreaterThan(0);
    expect(entries[1].id).toBe(entries[0].id + 1);
  });

  describe("circular eviction", () => {
    it("evicts oldest entries when full", () => {
      for (let i = 1; i <= 7; i++) {
        buffer.push({ timestamp: `t${i}`, level: "info", logger: "a", message: `msg-${i}` });
      }

      expect(buffer.size).toBe(5);

      const entries = buffer.getRecent(10);
      expect(entries).toHaveLength(5);
      // Oldest two (msg-1, msg-2) should be evicted
      expect(entries[0].message).toBe("msg-3");
      expect(entries[4].message).toBe("msg-7");
    });

    it("maintains correct order after wrapping around multiple times", () => {
      for (let i = 1; i <= 12; i++) {
        buffer.push({ timestamp: `t${i}`, level: "info", logger: "a", message: `msg-${i}` });
      }

      const entries = buffer.getRecent(10);
      expect(entries).toHaveLength(5);
      expect(entries.map((e) => e.message)).toEqual([
        "msg-8", "msg-9", "msg-10", "msg-11", "msg-12",
      ]);
    });
  });

  describe("getRecent with filters", () => {
    beforeEach(() => {
      buffer.push({ timestamp: "t1", level: "info", logger: "http", message: "req" });
      buffer.push({ timestamp: "t2", level: "warn", logger: "db", message: "slow" });
      buffer.push({ timestamp: "t3", level: "error", logger: "http", message: "500" });
      buffer.push({ timestamp: "t4", level: "info", logger: "db", message: "ok" });
    });

    it("filters by level", () => {
      const entries = buffer.getRecent(10, { level: "info" });
      expect(entries).toHaveLength(2);
      expect(entries.every((e) => e.level === "info")).toBe(true);
    });

    it("filters by logger", () => {
      const entries = buffer.getRecent(10, { logger: "http" });
      expect(entries).toHaveLength(2);
      expect(entries.every((e) => e.logger === "http")).toBe(true);
    });

    it("filters by both level and logger", () => {
      const entries = buffer.getRecent(10, { level: "info", logger: "db" });
      expect(entries).toHaveLength(1);
      expect(entries[0].message).toBe("ok");
    });

    it("respects limit after filtering", () => {
      const entries = buffer.getRecent(1, { level: "info" });
      expect(entries).toHaveLength(1);
      expect(entries[0].message).toBe("ok"); // the newest info entry
    });

    it("filters by afterId for reconnect catch-up", () => {
      // `nextId` is seeded from `Date.now()` so we can't hard-code an
      // afterId — derive it from the second entry's actual id and assert
      // the catch-up window keeps everything strictly newer.
      const all = buffer.getRecent(10);
      const afterId = all[1].id;
      const entries = buffer.getRecent(10, { afterId });
      expect(entries).toHaveLength(2);
      expect(entries.map((entry) => entry.message)).toEqual(["500", "ok"]);
    });
  });

  describe("getLoggerNames", () => {
    it("returns sorted unique logger names", () => {
      buffer.push({ timestamp: "t1", level: "info", logger: "zz", message: "" });
      buffer.push({ timestamp: "t2", level: "info", logger: "aa", message: "" });
      buffer.push({ timestamp: "t3", level: "info", logger: "zz", message: "" });

      expect(buffer.getLoggerNames()).toEqual(["aa", "zz"]);
    });

    it("retains logger names even after their entries are evicted", () => {
      // Fill buffer (size 5) so the first entry is evicted
      buffer.push({ timestamp: "t1", level: "info", logger: "evicted-logger", message: "" });
      for (let i = 0; i < 5; i++) {
        buffer.push({ timestamp: `t${i + 2}`, level: "info", logger: "other", message: "" });
      }

      // The entry is gone but the name remains
      expect(buffer.getLoggerNames()).toContain("evicted-logger");
    });
  });

  describe("subscribers", () => {
    it("notifies subscribers on push", () => {
      const received: string[] = [];
      buffer.subscribe((entry) => received.push(entry.message));

      buffer.push({ timestamp: "t1", level: "info", logger: "a", message: "hello" });

      expect(received).toEqual(["hello"]);
    });

    it("unsubscribes correctly", () => {
      const received: string[] = [];
      const unsub = buffer.subscribe((entry) => received.push(entry.message));

      buffer.push({ timestamp: "t1", level: "info", logger: "a", message: "one" });
      unsub();
      buffer.push({ timestamp: "t2", level: "info", logger: "a", message: "two" });

      expect(received).toEqual(["one"]);
      expect(buffer.subscriberCount).toBe(0);
    });

    it("does not crash when a subscriber throws", () => {
      buffer.subscribe(() => { throw new Error("boom"); });
      const received: string[] = [];
      buffer.subscribe((entry) => received.push(entry.message));

      // Should not throw, and the second subscriber should still fire
      buffer.push({ timestamp: "t1", level: "info", logger: "a", message: "ok" });
      expect(received).toEqual(["ok"]);
    });

    it("prevents re-entrancy — nested push skips broadcasting", () => {
      const outerReceived: string[] = [];
      const innerReceived: string[] = [];

      buffer.subscribe((entry) => {
        outerReceived.push(entry.message);
        // This nested push should buffer but NOT broadcast
        if (entry.message === "outer") {
          buffer.push({ timestamp: "t2", level: "info", logger: "a", message: "inner" });
        }
      });
      buffer.subscribe((entry) => innerReceived.push(entry.message));

      buffer.push({ timestamp: "t1", level: "info", logger: "a", message: "outer" });

      // The outer subscriber sees "outer", and the nested push is buffered
      expect(outerReceived).toEqual(["outer"]);
      // The second subscriber also only sees "outer" (inner was suppressed)
      expect(innerReceived).toEqual(["outer"]);
      // But the inner entry IS in the buffer
      expect(buffer.size).toBe(2);
      expect(buffer.getRecent(10).map((e) => e.message)).toEqual(["outer", "inner"]);
    });
  });
});

describe("extractLogParts", () => {
  it("handles empty args", () => {
    expect(extractLogParts([])).toEqual({ message: "", data: {} });
  });

  it("handles single string arg", () => {
    expect(extractLogParts(["hello"])).toEqual({ message: "hello", data: {} });
  });

  it("handles single object arg with msg", () => {
    expect(extractLogParts([{ msg: "hi", count: 5 }])).toEqual({
      message: "hi",
      data: { msg: "hi", count: 5 },
    });
  });

  it("handles single object arg without a msg field — message defaults to empty", () => {
    // Covers the `typeof obj.msg === "string" ? obj.msg : ""` false branch.
    const result = extractLogParts([{ count: 5, name: "x" }]);
    expect(result).toEqual({
      message: "",
      data: { count: 5, name: "x" },
    });
  });

  it("handles single null arg — falls through to the primitive String() path", () => {
    // Covers the `typeof args[0] === "object" && args[0] !== null` false branch.
    expect(extractLogParts([null])).toEqual({ message: "null", data: {} });
  });

  it("handles object + string (standard pino pattern)", () => {
    const result = extractLogParts([{ userId: 42 }, "user logged in"]);
    expect(result.message).toBe("user logged in");
    expect(result.data).toEqual({ userId: 42 });
  });

  it("skips msg key in data to avoid redundancy", () => {
    const result = extractLogParts([{ msg: "redundant", extra: true }, "the message"]);
    expect(result.data).toEqual({ extra: true });
    expect(result.data).not.toHaveProperty("msg");
  });

  it("handles format string pattern", () => {
    const result = extractLogParts(["hello %s, count=%d", "world", "3"]);
    expect(result.message).toBe("hello %s, count=%d world 3");
    expect(result.data).toEqual({});
  });

  it("handles serialized error objects (post-sanitization)", () => {
    // After sanitizeLogArg, Errors become plain objects
    const serializedError = { type: "TypeError", message: "oops", stack: "..." };
    const result = extractLogParts([serializedError, "something failed"]);
    expect(result.message).toBe("something failed");
    expect(result.data).toEqual({ type: "TypeError", message: "oops", stack: "..." });
  });

  it("handles single non-string primitive", () => {
    expect(extractLogParts([42])).toEqual({ message: "42", data: {} });
  });

  it("handles object without trailing string", () => {
    const result = extractLogParts([{ a: 1 }, { b: 2 }]);
    expect(result.message).toBe("");
    expect(result.data).toEqual({ a: 1 });
  });
});

describe("pushToLogBuffer / global singleton", () => {
  beforeEach(() => {
    resetLogBuffer();
  });

  it("ignores levels below info (30)", () => {
    pushToLogBuffer(20, "test", ["debug msg"]); // debug = 20
    expect(getLogBuffer().size).toBe(0);
  });

  it("buffers info level (30)", () => {
    pushToLogBuffer(30, "test", ["info msg"]);
    const entries = getLogBuffer().getRecent(10);
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe("info");
    expect(entries[0].logger).toBe("test");
    expect(entries[0].message).toBe("info msg");
  });

  it("buffers warn (40), error (50), fatal (60)", () => {
    pushToLogBuffer(40, "a", ["warn"]);
    pushToLogBuffer(50, "b", ["error"]);
    pushToLogBuffer(60, "c", ["fatal"]);

    const entries = getLogBuffer().getRecent(10);
    expect(entries.map((e) => e.level)).toEqual(["warn", "error", "fatal"]);
  });

  it("extracts data from object+message args", () => {
    pushToLogBuffer(30, "test", [{ count: 3 }, "processed"]);
    const entry = getLogBuffer().getRecent(1)[0];
    expect(entry.message).toBe("processed");
    expect(entry.data).toEqual({ count: 3 });
  });

  it("omits data when only a string message is provided", () => {
    pushToLogBuffer(30, "test", ["simple message"]);
    const entry = getLogBuffer().getRecent(1)[0];
    expect(entry.data).toBeUndefined();
  });

  it("resetLogBuffer creates a fresh buffer", () => {
    pushToLogBuffer(30, "test", ["one"]);
    expect(getLogBuffer().size).toBe(1);

    resetLogBuffer();
    expect(getLogBuffer().size).toBe(0);
  });
});
