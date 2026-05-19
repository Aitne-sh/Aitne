import { describe, expect, it, vi } from "vitest";
import {
  ConcurrencyLimiter,
  GraphClient,
  GraphError,
  extractGraphError,
  parseRetryAfter,
  resolveGraphUrl,
  type GraphTokenProvider,
} from "./graph-client.js";

describe("resolveGraphUrl", () => {
  it("passes absolute URLs through unchanged", () => {
    expect(resolveGraphUrl("https://graph.microsoft.com/foo")).toBe(
      "https://graph.microsoft.com/foo",
    );
    expect(resolveGraphUrl("http://localhost/bar")).toBe("http://localhost/bar");
  });

  it("joins leading-slash paths to the base URL", () => {
    expect(resolveGraphUrl("/me/messages")).toBe(
      "https://graph.microsoft.com/v1.0/me/messages",
    );
  });

  it("joins bare paths with a slash separator", () => {
    expect(resolveGraphUrl("me/messages")).toBe(
      "https://graph.microsoft.com/v1.0/me/messages",
    );
  });

  it("respects an alternate base URL", () => {
    expect(resolveGraphUrl("/x", "http://test/v")).toBe("http://test/v/x");
  });
});

describe("parseRetryAfter", () => {
  const now = () => new Date("2026-04-16T12:00:00Z");

  it("parses integer seconds", () => {
    expect(parseRetryAfter("42", now)).toEqual({ seconds: 42 });
  });

  it("parses HTTP-date relative to now", () => {
    expect(parseRetryAfter("Thu, 16 Apr 2026 12:00:30 GMT", now)).toEqual({ seconds: 30 });
  });

  it("clamps past dates to 0", () => {
    expect(parseRetryAfter("Thu, 16 Apr 2026 11:59:00 GMT", now)).toEqual({ seconds: 0 });
  });

  it("returns null seconds for unparseable values", () => {
    expect(parseRetryAfter("nonsense", now)).toEqual({ seconds: null });
  });

  it("returns null for null input", () => {
    expect(parseRetryAfter(null, now)).toEqual({ seconds: null });
  });

  it("uses system clock when now is not provided (past HTTP-date clamps to 0)", () => {
    const result = parseRetryAfter("Thu, 01 Jan 1970 00:00:00 GMT");
    expect(result.seconds).toBe(0);
  });
});

describe("extractGraphError", () => {
  it("returns the code and message from a Graph error envelope", () => {
    expect(
      extractGraphError({
        error: { code: "InvalidAuthenticationToken", message: "Token expired" },
      }),
    ).toEqual({ code: "InvalidAuthenticationToken", message: "Token expired" });
  });

  it("returns nulls for non-Graph bodies", () => {
    expect(extractGraphError({})).toEqual({ code: null, message: null });
    expect(extractGraphError({ error: "not-an-object" })).toEqual({ code: null, message: null });
    expect(extractGraphError(null)).toEqual({ code: null, message: null });
    expect(extractGraphError("string")).toEqual({ code: null, message: null });
  });

  it("ignores non-string code/message fields defensively", () => {
    expect(extractGraphError({ error: { code: 42, message: false } })).toEqual({
      code: null,
      message: null,
    });
  });
});

describe("ConcurrencyLimiter", () => {
  it("rejects construction with maxConcurrent < 1", () => {
    expect(() => new ConcurrencyLimiter(0)).toThrow();
  });

  it("respects max concurrent in-flight tasks", async () => {
    const limiter = new ConcurrencyLimiter(2);
    const inFlight: number[] = [];
    let active = 0;
    const tasks = Array.from({ length: 5 }, () =>
      limiter.run(async () => {
        active++;
        inFlight.push(active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return active;
      }),
    );
    await Promise.all(tasks);
    expect(Math.max(...inFlight)).toBeLessThanOrEqual(2);
  });

  it("propagates task errors through run()", async () => {
    const limiter = new ConcurrencyLimiter(1);
    await expect(
      limiter.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("continues processing the queue after a rejection", async () => {
    const limiter = new ConcurrencyLimiter(1);
    const failed = limiter.run(async () => {
      throw new Error("first");
    });
    const ok = limiter.run(async () => 7);
    await expect(failed).rejects.toThrow("first");
    await expect(ok).resolves.toBe(7);
  });
});

function makeTokenProvider(token = "tk"): GraphTokenProvider & { invalidations: number } {
  const provider = {
    invalidations: 0,
    async getAccessToken() {
      return token;
    },
    invalidateToken() {
      provider.invalidations++;
    },
  };
  return provider;
}

describe("GraphClient defaults", () => {
  it("falls back to globalThis.fetch and default retry/now when options omitted", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    const fetchSpy = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        // Force the default `now` arrow to evaluate by triggering Retry-After parsing.
        return new Response("", {
          status: 429,
          headers: { "retry-after": "Thu, 01 Jan 1970 00:00:00 GMT" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = fetchSpy;
    try {
      const client = new GraphClient({ tokenProvider: makeTokenProvider() });
      await expect(client.requestJson({ url: "/me" })).resolves.toEqual({ ok: true });
      expect(calls).toBe(2);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).fetch = originalFetch;
    }
  });
});

describe("GraphClient", () => {
  it("issues a GET with the bearer token and parses JSON", async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://graph.microsoft.com/v1.0/me/messages/123");
      expect(init?.method).toBe("GET");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer tk");
      expect(headers.Accept).toBe("application/json");
      return new Response(JSON.stringify({ id: "123" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = new GraphClient({
      tokenProvider: makeTokenProvider(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await client.requestJson<{ id: string }>({ url: "/me/messages/123" });
    expect(result).toEqual({ id: "123" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("retries once on 401 after invalidating the token", async () => {
    const provider = makeTokenProvider();
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return new Response("", { status: 401 });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = new GraphClient({
      tokenProvider: provider,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await client.requestJson<{ ok: boolean }>({ url: "/me" });
    expect(result).toEqual({ ok: true });
    expect(provider.invalidations).toBe(1);
    expect(calls).toBe(2);
  });

  it("does not retry 401 when skipAuthRetry is set", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 401 }));
    const client = new GraphClient({
      tokenProvider: makeTokenProvider(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      client.requestJson({ url: "/me", skipAuthRetry: true }),
    ).rejects.toBeInstanceOf(GraphError);
  });

  it("honors Retry-After on 429 once and then succeeds", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return new Response("", {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = new GraphClient({
      tokenProvider: makeTokenProvider(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.requestJson({ url: "/me" })).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it("surfaces 429 with no Retry-After as a GraphError", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 429 }));
    const client = new GraphClient({
      tokenProvider: makeTokenProvider(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.requestJson({ url: "/me" })).rejects.toBeInstanceOf(GraphError);
  });

  it("throws GraphError with parsed code/message on 4xx", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: { code: "InvalidRequest", message: "bad query" } }),
        { status: 400 },
      ),
    );
    const client = new GraphClient({
      tokenProvider: makeTokenProvider(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.requestJson({ url: "/me" }))
      .rejects.toMatchObject({ httpStatus: 400, graphCode: "InvalidRequest", message: "bad query" });
  });

  it("returns undefined on 204", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const client = new GraphClient({
      tokenProvider: makeTokenProvider(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await client.requestJson({ url: "/me/messages/1", method: "DELETE" });
    expect(result).toBeUndefined();
  });

  it("serializes object bodies as JSON and sets Content-Type", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
      expect(init?.body).toBe(JSON.stringify({ subject: "hi" }));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = new GraphClient({
      tokenProvider: makeTokenProvider(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.requestJson({ url: "/me/messages", method: "POST", body: { subject: "hi" } });
  });

  it("falls back to bare error when response body cannot be read", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, {
          status: 400,
          headers: { "content-type": "text/plain" },
        }),
    );
    const client = new GraphClient({
      tokenProvider: makeTokenProvider(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.requestJson({ url: "/me" })).rejects.toMatchObject({
      httpStatus: 400,
      graphCode: null,
      message: expect.stringMatching(/Graph 400/),
    });
  });

  it("falls back gracefully when error response body is non-JSON text", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("upstream proxy error", { status: 502 }),
    );
    const client = new GraphClient({
      tokenProvider: makeTokenProvider(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.requestJson({ url: "/me" })).rejects.toMatchObject({
      httpStatus: 502,
      graphCode: null,
      responseBody: "upstream proxy error",
    });
  });

  it("returns undefined when a 200 response has an empty body", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 }));
    const client = new GraphClient({
      tokenProvider: makeTokenProvider(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.requestJson({ url: "/me" })).resolves.toBeUndefined();
  });

  it("passes string bodies through unchanged (no JSON wrap)", async () => {
    let capturedBody: unknown;
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      capturedBody = init?.body;
      return new Response("", { status: 200 });
    });
    const client = new GraphClient({
      tokenProvider: makeTokenProvider(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.requestVoid({ url: "/me", method: "POST", body: "raw text" });
    expect(capturedBody).toBe("raw text");
  });

  it("treats response.text() throwing as null body (defensive)", async () => {
    const failingResponse = {
      status: 400,
      statusText: "Bad Request",
      ok: false,
      headers: { get: () => null },
      text: async () => {
        throw new Error("body stream broke");
      },
    } as unknown as Response;
    const fetchImpl = vi.fn(async () => failingResponse);
    const client = new GraphClient({
      tokenProvider: makeTokenProvider(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.requestJson({ url: "/me" })).rejects.toMatchObject({
      httpStatus: 400,
      responseBody: null,
    });
  });

  it("requestVoid resolves cleanly for 200 responses with no JSON parse", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 }));
    const client = new GraphClient({
      tokenProvider: makeTokenProvider(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.requestVoid({ url: "/me", method: "POST" })).resolves.toBeUndefined();
  });

  it("passes defaultSignal into fetch when no per-call signal is supplied", async () => {
    let capturedSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return new Response("{}", { status: 200 });
    });
    const controller = new AbortController();
    const client = new GraphClient({
      tokenProvider: makeTokenProvider(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      defaultSignal: controller.signal,
    });
    await client.requestJson({ url: "/me" });
    expect(capturedSignal).toBe(controller.signal);
  });

  it("per-call init.signal wins over defaultSignal", async () => {
    let capturedSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return new Response("{}", { status: 200 });
    });
    const overrideController = new AbortController();
    const defaultController = new AbortController();
    const client = new GraphClient({
      tokenProvider: makeTokenProvider(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      defaultSignal: defaultController.signal,
    });
    await client.requestJson({ url: "/me", signal: overrideController.signal });
    expect(capturedSignal).toBe(overrideController.signal);
  });
});
