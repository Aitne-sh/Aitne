import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { Context } from "hono";
import { readJsonBody } from "./json-body.js";

describe("readJsonBody", () => {
  it("returns ok with parsed body on valid JSON", async () => {
    const app = new Hono();
    app.post("/echo", async (c) => {
      const r = await readJsonBody(c);
      if (!r.ok) return r.response;
      return c.json({ body: r.body });
    });
    const res = await app.request("/echo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { body: { hello: string } };
    expect(data.body).toEqual({ hello: "world" });
  });

  it("returns 400 invalid_json_body with SyntaxError message on malformed JSON", async () => {
    const app = new Hono();
    app.post("/echo", async (c) => {
      const r = await readJsonBody(c);
      if (!r.ok) return r.response;
      return c.json({ body: r.body });
    });
    const res = await app.request("/echo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "@-",
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string; message: string };
    expect(data.error).toBe("invalid_json_body");
    expect(data.message).toMatch(/@-/);
  });

  it("stringifies non-Error rejections defensively (opt-out path)", async () => {
    // JSON.parse always throws a SyntaxError in practice, but the helper
    // catches `unknown`; prove the non-Error branch also produces a 400
    // with a string detail (not `[object Object]` or a crash). The
    // opt-out (maxBytes: null) path delegates to c.req.json() directly.
    const fake = {
      req: {
        json: () => Promise.reject("bare string rejection"),
        path: "/fake",
        method: "POST",
      },
      json: (body: unknown, status: number) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
    } as unknown as Context;

    const result = await readJsonBody(fake, { maxBytes: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(400);
    const data = (await result.response.json()) as { error: string; message: string };
    expect(data.error).toBe("invalid_json_body");
    expect(data.message).toBe("bare string rejection");
  });

  describe("default cap applies when maxBytes is unspecified", () => {
    it("rejects a body exceeding the default 1 MiB cap", async () => {
      const app = new Hono();
      app.post("/echo", async (c) => {
        const r = await readJsonBody(c);
        if (!r.ok) return r.response;
        return c.json({ body: r.body });
      });
      // Stringify a value larger than 1 MiB. JSON.stringify of a single
      // 1.5 MiB string is 1.5 MiB + 2 (quotes), comfortably over the cap.
      const res = await app.request("/echo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify("x".repeat(1_500_000)),
      });
      expect(res.status).toBe(413);
      const data = (await res.json()) as {
        error: string;
        maxBytes: number;
      };
      expect(data.error).toBe("body_too_large");
      expect(data.maxBytes).toBe(1_048_576);
    });

    it("admits a body under the default cap", async () => {
      const app = new Hono();
      app.post("/echo", async (c) => {
        const r = await readJsonBody(c);
        if (!r.ok) return r.response;
        return c.json({ body: r.body });
      });
      const res = await app.request("/echo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ small: "payload" }),
      });
      expect(res.status).toBe(200);
    });

    it("opt-out via maxBytes: null skips the cap entirely", async () => {
      const app = new Hono();
      app.post("/echo", async (c) => {
        const r = await readJsonBody(c, { maxBytes: null });
        if (!r.ok) return r.response;
        return c.json({ size: JSON.stringify(r.body).length });
      });
      const res = await app.request("/echo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify("x".repeat(1_500_000)),
      });
      expect(res.status).toBe(200);
    });

    it("opt-out path surfaces SyntaxError from invalid JSON", async () => {
      // Exercises the `err instanceof Error` branch of the opt-out catch
      // (c.req.json() rejects with a SyntaxError on malformed input).
      const app = new Hono();
      app.post("/echo", async (c) => {
        const r = await readJsonBody(c, { maxBytes: null });
        if (!r.ok) return r.response;
        return c.json({ body: r.body });
      });
      const res = await app.request("/echo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "definitely-not-json",
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string; message: string };
      expect(data.error).toBe("invalid_json_body");
      expect(data.message.length).toBeGreaterThan(0);
    });
  });

  describe("with maxBytes cap", () => {
    it("accepts a body within the cap", async () => {
      const app = new Hono();
      app.post("/echo", async (c) => {
        const r = await readJsonBody(c, { maxBytes: 1024 });
        if (!r.ok) return r.response;
        return c.json({ body: r.body });
      });
      const res = await app.request("/echo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hello: "world" }),
      });
      expect(res.status).toBe(200);
    });

    it("rejects a body exceeding the cap with 413 body_too_large", async () => {
      const app = new Hono();
      app.post("/echo", async (c) => {
        const r = await readJsonBody(c, { maxBytes: 32 });
        if (!r.ok) return r.response;
        return c.json({ body: r.body });
      });
      const res = await app.request("/echo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload: "x".repeat(200) }),
      });
      expect(res.status).toBe(413);
      const data = (await res.json()) as {
        error: string;
        maxBytes: number;
        actualBytes: number;
      };
      expect(data.error).toBe("body_too_large");
      expect(data.maxBytes).toBe(32);
      expect(data.actualBytes).toBeGreaterThan(32);
    });

    it("counts UTF-8 byte length, not character length", async () => {
      // Three BMP chars from the math-symbol block = 9 UTF-8 bytes
      // (3 bytes each), 3 JS chars. A 5-byte cap must reject the body
      // even though the string is only 3 characters long.
      const app = new Hono();
      app.post("/echo", async (c) => {
        const r = await readJsonBody(c, { maxBytes: 5 });
        if (!r.ok) return r.response;
        return c.json({ body: r.body });
      });
      const res = await app.request("/echo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '"∀∃∇"',
      });
      expect(res.status).toBe(413);
    });

    it("rejects upfront when Content-Length exceeds the cap (no body read)", async () => {
      let textCalls = 0;
      const fake = {
        req: {
          header: (name: string) =>
            name.toLowerCase() === "content-length" ? "10000" : undefined,
          text: async () => {
            textCalls += 1;
            return "{}";
          },
          path: "/big",
          method: "POST",
        },
        json: (body: unknown, status: number) =>
          new Response(JSON.stringify(body), {
            status,
            headers: { "Content-Type": "application/json" },
          }),
      } as unknown as Context;

      const result = await readJsonBody(fake, { maxBytes: 100 });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.response.status).toBe(413);
      const data = (await result.response.json()) as {
        error: string;
        maxBytes: number;
        actualBytes: number;
      };
      expect(data.error).toBe("body_too_large");
      expect(data.maxBytes).toBe(100);
      expect(data.actualBytes).toBe(10000);
      // No body read should have happened.
      expect(textCalls).toBe(0);
    });

    it("ignores a non-numeric Content-Length and falls through to read", async () => {
      const fake = {
        req: {
          header: (name: string) =>
            name.toLowerCase() === "content-length" ? "not-a-number" : undefined,
          text: async () => '{"hello":"world"}',
          path: "/x",
          method: "POST",
        },
        json: (body: unknown, status: number) =>
          new Response(JSON.stringify(body), {
            status,
            headers: { "Content-Type": "application/json" },
          }),
      } as unknown as Context;

      const result = await readJsonBody(fake, { maxBytes: 1024 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.body).toEqual({ hello: "world" });
    });

    it("returns 400 invalid_json_body when c.req.text() throws", async () => {
      const fake = {
        req: {
          header: () => undefined,
          text: () => Promise.reject(new Error("stream aborted")),
          path: "/x",
          method: "POST",
        },
        json: (body: unknown, status: number) =>
          new Response(JSON.stringify(body), {
            status,
            headers: { "Content-Type": "application/json" },
          }),
      } as unknown as Context;

      const result = await readJsonBody(fake, { maxBytes: 1024 });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.response.status).toBe(400);
      const data = (await result.response.json()) as {
        error: string;
        message: string;
      };
      expect(data.error).toBe("invalid_json_body");
      expect(data.message).toBe("stream aborted");
    });

    it("stringifies non-Error rejections from c.req.text()", async () => {
      const fake = {
        req: {
          header: () => undefined,
          text: () => Promise.reject("bare-string-text-error"),
          path: "/x",
          method: "POST",
        },
        json: (body: unknown, status: number) =>
          new Response(JSON.stringify(body), {
            status,
            headers: { "Content-Type": "application/json" },
          }),
      } as unknown as Context;

      const result = await readJsonBody(fake, { maxBytes: 1024 });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const data = (await result.response.json()) as { message: string };
      expect(data.message).toBe("bare-string-text-error");
    });

    it("returns 400 invalid_json_body for malformed JSON inside the cap", async () => {
      const app = new Hono();
      app.post("/echo", async (c) => {
        const r = await readJsonBody(c, { maxBytes: 1024 });
        if (!r.ok) return r.response;
        return c.json({ body: r.body });
      });
      const res = await app.request("/echo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("invalid_json_body");
    });

    it("stringifies non-Error rejections from JSON.parse path", async () => {
      // JSON.parse always throws SyntaxError so we cannot reach the
      // non-Error branch via real input — override JSON.parse for the
      // single call inside readJsonBody.
      const spy = vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
        throw "bare-parse-rejection";
      });
      const fake = {
        req: {
          header: () => undefined,
          text: async () => '{"valid":"json"}',
          path: "/x",
          method: "POST",
        },
        json: (body: unknown, status: number) =>
          new Response(JSON.stringify(body), {
            status,
            headers: { "Content-Type": "application/json" },
          }),
      } as unknown as Context;

      const result = await readJsonBody(fake, { maxBytes: 1024 });
      spy.mockRestore();
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const data = (await result.response.json()) as { message: string };
      expect(data.message).toBe("bare-parse-rejection");
    });
  });
});
