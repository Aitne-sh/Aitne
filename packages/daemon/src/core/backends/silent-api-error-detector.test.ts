import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import {
  extractSilentApiErrors,
  logSilentApiErrors,
  type SilentApiError,
} from "./silent-api-error-detector.js";

describe("extractSilentApiErrors", () => {
  it("returns empty array for empty / null / missing-marker text", () => {
    expect(extractSilentApiErrors(null)).toEqual([]);
    expect(extractSilentApiErrors(undefined)).toEqual([]);
    expect(extractSilentApiErrors("")).toEqual([]);
    expect(extractSilentApiErrors("just normal output\nno marker here")).toEqual([]);
  });

  it("extracts a single marker line", () => {
    const text = `some body output
PA_API_ERROR {"method":"GET","path":"/api/calendar/events","status":404,"bodyPreview":"{\\"error\\":\\"not_found\\"}"}
trailing stdout line`;
    expect(extractSilentApiErrors(text)).toEqual([
      {
        method: "GET",
        path: "/api/calendar/events",
        status: 404,
        bodyPreview: '{"error":"not_found"}',
      },
    ]);
  });

  it("extracts multiple markers in the same text blob", () => {
    const text = `PA_API_ERROR {"method":"POST","path":"/api/a","status":500,"bodyPreview":"boom"}
PA_API_ERROR {"method":"GET","path":"/api/b","status":503,"bodyPreview":"down"}`;
    const errors = extractSilentApiErrors(text);
    expect(errors).toHaveLength(2);
    expect(errors[0].path).toBe("/api/a");
    expect(errors[1].path).toBe("/api/b");
  });

  it("tolerates the marker appearing mid-line after a prefix", () => {
    const text = `[stderr] PA_API_ERROR {"method":"PUT","path":"/api/x","status":400,"bodyPreview":"bad"}`;
    expect(extractSilentApiErrors(text)).toEqual([
      { method: "PUT", path: "/api/x", status: 400, bodyPreview: "bad" },
    ]);
  });

  it("skips malformed marker payloads without throwing", () => {
    const text = `PA_API_ERROR not-json-at-all
PA_API_ERROR {truncated
PA_API_ERROR {"method":"GET","path":"/api/ok","status":404,"bodyPreview":"fine"}`;
    expect(extractSilentApiErrors(text)).toEqual([
      { method: "GET", path: "/api/ok", status: 404, bodyPreview: "fine" },
    ]);
  });

  it("rejects marker payloads missing required fields", () => {
    const text = `PA_API_ERROR {"method":"GET","path":"/api/x"}
PA_API_ERROR {"method":"GET","path":"/api/y","status":"500","bodyPreview":"x"}
PA_API_ERROR {"method":"GET","path":"/api/z","status":500,"bodyPreview":"ok"}`;
    expect(extractSilentApiErrors(text)).toEqual([
      { method: "GET", path: "/api/z", status: 500, bodyPreview: "ok" },
    ]);
  });

  it("handles CRLF line endings", () => {
    const text = `line one\r\nPA_API_ERROR {"method":"GET","path":"/api/x","status":502,"bodyPreview":"p"}\r\nline three`;
    expect(extractSilentApiErrors(text)).toEqual([
      { method: "GET", path: "/api/x", status: 502, bodyPreview: "p" },
    ]);
  });
});

describe("logSilentApiErrors", () => {
  function stubLogger(): Logger {
    return {
      warn: vi.fn(),
    } as unknown as Logger;
  }

  it("is a no-op for an empty error list", () => {
    const log = stubLogger();
    logSilentApiErrors(log, [], { backendId: "claude-code" });
    expect((log.warn as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("emits one structured warn per error with full context", () => {
    const log = stubLogger();
    const errors: SilentApiError[] = [
      { method: "GET", path: "/api/a", status: 404, bodyPreview: "a" },
      { method: "POST", path: "/api/b", status: 500, bodyPreview: "b" },
    ];
    logSilentApiErrors(log, errors, {
      backendId: "codex",
      sessionId: "sess-1",
      eventType: "message.received",
    });
    const warn = log.warn as ReturnType<typeof vi.fn>;
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toMatchObject({
      backendId: "codex",
      sessionId: "sess-1",
      eventType: "message.received",
      method: "GET",
      path: "/api/a",
      status: 404,
      bodyPreview: "a",
    });
    expect(warn.mock.calls[1][0]).toMatchObject({
      method: "POST",
      path: "/api/b",
      status: 500,
    });
  });

  it("defaults sessionId to null when omitted", () => {
    const log = stubLogger();
    logSilentApiErrors(
      log,
      [{ method: "GET", path: "/api/x", status: 503, bodyPreview: "x" }],
      { backendId: "gemini" },
    );
    const warn = log.warn as ReturnType<typeof vi.fn>;
    expect(warn.mock.calls[0][0]).toMatchObject({ sessionId: null });
  });
});
