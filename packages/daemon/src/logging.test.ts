import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger, sanitizeLogArg, toSafeErrorMessage } from "./logging.js";

describe("logging redaction", () => {
  // ── Key-based redaction ──

  it("sanitizes structured log objects by key", () => {
    expect(
      sanitizeLogArg({
        token: "abcdef0123456789abcdef0123456789",
        nested: { authorization: "Bearer abcdefghijklmnopqrstuvwxyz123456" },
      }),
    ).toEqual({
      token: "[REDACTED]",
      nested: { authorization: "[REDACTED]" },
    });
  });

  it("redacts keys matching substring (e.g. apiToken, refreshToken)", () => {
    const result = sanitizeLogArg({
      apiToken: "some-value",
      mySecret: 42,
      safe: "ok",
    }) as Record<string, unknown>;
    expect(result.apiToken).toBe("[REDACTED]");
    expect(result.mySecret).toBe("[REDACTED]");
    expect(result.safe).toBe("ok");
  });

  // ── Error serialization ──

  it("serializes Error objects with type, message, and stack", () => {
    const err = new Error("something failed");
    const result = sanitizeLogArg(err) as Record<string, unknown>;
    expect(result.type).toBe("Error");
    expect(result.message).toBe("something failed");
    expect(result.stack).toContain("Error: something failed");
  });

  it("preserves custom Error properties (code, statusCode)", () => {
    const err = new Error("ENOENT") as Error & { code: string; statusCode: number };
    err.code = "ENOENT";
    err.statusCode = 404;
    const result = sanitizeLogArg(err) as Record<string, unknown>;
    expect(result.code).toBe("ENOENT");
    expect(result.statusCode).toBe(404);
  });

  it("serializes nested Error objects (Pino { err } convention)", () => {
    const error = new Error("db connection failed");
    const result = sanitizeLogArg({ err: error, context: "test" }) as Record<string, unknown>;
    const serializedErr = result.err as Record<string, unknown>;
    expect(serializedErr.type).toBe("Error");
    expect(serializedErr.message).toBe("db connection failed");
    expect(serializedErr.stack).toContain("Error: db connection failed");
    expect(result.context).toBe("test");
  });

  it("redacts secret patterns in Error messages", () => {
    const err = new Error("Bearer abcdefghijklmnopqrstuvwxyz123456 failed");
    const result = sanitizeLogArg(err) as Record<string, unknown>;
    expect(result.message).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(result.message).toContain("[REDACTED]");
  });

  it("redacts sensitive-named custom properties on Error", () => {
    const err = new Error("oops") as Error & { token: string };
    err.token = "should-be-redacted";
    const result = sanitizeLogArg(err) as Record<string, unknown>;
    expect(result.token).toBe("[REDACTED]");
  });

  it("handles Error.cause chain", () => {
    const cause = new Error("root cause");
    const err = new Error("wrapper", { cause });
    const result = sanitizeLogArg(err) as Record<string, unknown>;
    const causeResult = result.cause as Record<string, unknown>;
    expect(causeResult.type).toBe("Error");
    expect(causeResult.message).toBe("root cause");
  });

  it("handles Error subclasses (TypeError, custom)", () => {
    const err = new TypeError("not a function");
    const result = sanitizeLogArg(err) as Record<string, unknown>;
    expect(result.type).toBe("TypeError");
    expect(result.message).toBe("not a function");
  });

  // ── Circular reference protection ──

  it("handles circular references in objects", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    const result = sanitizeLogArg(obj) as Record<string, unknown>;
    expect(result.a).toBe(1);
    expect(result.self).toBe("[Circular]");
  });

  it("handles circular references in Error.cause", () => {
    const err = new Error("loop");
    (err as any).cause = err;
    const result = sanitizeLogArg(err) as Record<string, unknown>;
    expect(result.type).toBe("Error");
    expect(result.cause).toBe("[Circular]");
  });

  // ── Special object types ──

  it("serializes Date to ISO string", () => {
    const date = new Date("2026-04-09T12:00:00Z");
    expect(sanitizeLogArg(date)).toBe("2026-04-09T12:00:00.000Z");
  });

  it("serializes Date nested in object", () => {
    const result = sanitizeLogArg({
      startTime: new Date("2026-04-09T09:00:00Z"),
    }) as Record<string, unknown>;
    expect(result.startTime).toBe("2026-04-09T09:00:00.000Z");
  });

  it("serializes Map to object with redaction", () => {
    const map = new Map<string, unknown>([
      ["user", "alice"],
      ["token", "secret-value"],
    ]);
    const result = sanitizeLogArg(map) as Record<string, unknown>;
    expect(result.user).toBe("alice");
    expect(result.token).toBe("[REDACTED]");
  });

  it("serializes Set to array", () => {
    const set = new Set([1, "hello", 3]);
    const result = sanitizeLogArg(set) as unknown[];
    expect(result).toEqual([1, "hello", 3]);
  });

  it("serializes RegExp to string", () => {
    expect(sanitizeLogArg(/foo.*bar/gi)).toBe("/foo.*bar/gi");
  });

  it("serializes Buffer to placeholder", () => {
    const buf = Buffer.from("hello");
    expect(sanitizeLogArg(buf)).toBe("<Buffer length=5>");
  });

  // ── Primitives and edge cases ──

  it("passes through null and undefined", () => {
    expect(sanitizeLogArg(null)).toBeNull();
    expect(sanitizeLogArg(undefined)).toBeUndefined();
  });

  it("passes through numbers and booleans", () => {
    expect(sanitizeLogArg(42)).toBe(42);
    expect(sanitizeLogArg(true)).toBe(true);
  });

  it("handles non-Error values in { err } key", () => {
    const result = sanitizeLogArg({ err: "string error" }) as Record<string, unknown>;
    expect(result.err).toBe("string error");
  });

  it("handles null/undefined values in objects", () => {
    const result = sanitizeLogArg({
      a: null,
      b: undefined,
      c: "ok",
    }) as Record<string, unknown>;
    expect(result.a).toBeNull();
    expect(result.b).toBeUndefined();
    expect(result.c).toBe("ok");
  });

  // ── Pino integration ──

  it("redacts tokens before writing to pino output", async () => {
    const stream = new PassThrough();
    let output = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      output += chunk;
    });

    const logger = createLogger("test", { timestamp: false }, stream as unknown as never);
    logger.error(
      {
        token: "abcdef0123456789abcdef0123456789",
        authorization: "Bearer abcdefghijklmnopqrstuvwxyz123456",
      },
      "xoxb-secret-token failed",
    );

    await new Promise((resolve) => setImmediate(resolve));

    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(output).not.toContain("xoxb-secret-token");
  });

  it("logs Error via { err } with type/message/stack in pino output", async () => {
    const stream = new PassThrough();
    let output = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      output += chunk;
    });

    const logger = createLogger("test", { timestamp: false }, stream as unknown as never);
    const error = new Error("connection refused") as Error & { code: string };
    error.code = "ECONNREFUSED";
    logger.error({ err: error }, "request failed");

    await new Promise((resolve) => setImmediate(resolve));

    const parsed = JSON.parse(output);
    expect(parsed.err.type).toBe("Error");
    expect(parsed.err.message).toBe("connection refused");
    expect(parsed.err.code).toBe("ECONNREFUSED");
    expect(parsed.err.stack).toContain("Error: connection refused");
    expect(parsed.msg).toBe("request failed");
  });

  // ── toSafeErrorMessage ──

  it("redacts safe client-facing error messages", () => {
    expect(
      toSafeErrorMessage(new Error("Bearer abcdefghijklmnopqrstuvwxyz123456 failed")),
    ).toBe("[REDACTED] failed");
  });

  it("returns fallback for non-Error non-string", () => {
    expect(toSafeErrorMessage(42)).toBe("Internal error");
    expect(toSafeErrorMessage(null)).toBe("Internal error");
  });

  // ── PA_LOG_LEVEL resolution ──

  it("createLogger defaults to info when PA_LOG_LEVEL is unset", () => {
    const prev = process.env.PA_LOG_LEVEL;
    delete process.env.PA_LOG_LEVEL;
    try {
      const l = createLogger("test-level-default");
      expect(l.level).toBe("info");
    } finally {
      if (prev !== undefined) process.env.PA_LOG_LEVEL = prev;
      else delete process.env.PA_LOG_LEVEL;
    }
  });

  it("createLogger respects PA_LOG_LEVEL=debug", () => {
    const prev = process.env.PA_LOG_LEVEL;
    process.env.PA_LOG_LEVEL = "debug";
    try {
      const l = createLogger("test-level-debug");
      expect(l.level).toBe("debug");
    } finally {
      if (prev !== undefined) process.env.PA_LOG_LEVEL = prev;
      else delete process.env.PA_LOG_LEVEL;
    }
  });

  it("createLogger normalizes uppercase PA_LOG_LEVEL", () => {
    const prev = process.env.PA_LOG_LEVEL;
    process.env.PA_LOG_LEVEL = "WARN";
    try {
      const l = createLogger("test-level-upper");
      expect(l.level).toBe("warn");
    } finally {
      if (prev !== undefined) process.env.PA_LOG_LEVEL = prev;
      else delete process.env.PA_LOG_LEVEL;
    }
  });

  it("createLogger falls back to info for invalid PA_LOG_LEVEL", () => {
    const prev = process.env.PA_LOG_LEVEL;
    process.env.PA_LOG_LEVEL = "verbose";
    try {
      const l = createLogger("test-level-invalid");
      expect(l.level).toBe("info");
    } finally {
      if (prev !== undefined) process.env.PA_LOG_LEVEL = prev;
      else delete process.env.PA_LOG_LEVEL;
    }
  });

  it("caller-supplied level option overrides PA_LOG_LEVEL", () => {
    const prev = process.env.PA_LOG_LEVEL;
    process.env.PA_LOG_LEVEL = "error";
    try {
      const l = createLogger("test-level-override", { level: "trace" });
      expect(l.level).toBe("trace");
    } finally {
      if (prev !== undefined) process.env.PA_LOG_LEVEL = prev;
      else delete process.env.PA_LOG_LEVEL;
    }
  });
});
