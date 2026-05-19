/**
 * docs/design/appendices/opencode-backend.md §6.6.1 — Basic-Auth fetch wrapper.
 *
 * Phase 2 ships the wrapper so Phase 5 (Remote mode) can plug it into
 * `createOpencodeClient({ fetch })` without a second design pass. The
 * tests here cover both the no-op (no credentials) and the auth-header
 * injection path.
 */

import { describe, expect, it, vi } from "vitest";
import { createBasicAuthFetch } from "./opencode-basic-auth-fetch.js";

describe("createBasicAuthFetch", () => {
  it("returns the underlying fetch unchanged when credentials are null", async () => {
    const inner = vi.fn(async () => new Response("ok"));
    const wrapped = createBasicAuthFetch(null, inner as unknown as typeof fetch);
    await wrapped("http://example.test/x");
    const [, init] = inner.mock.calls[0] ?? [];
    expect((init?.headers as Headers | undefined)?.get?.("authorization")).toBeFalsy();
  });

  it("returns the underlying fetch unchanged when username is empty", async () => {
    const inner = vi.fn(async () => new Response("ok"));
    const wrapped = createBasicAuthFetch(
      { username: "", password: "secret" },
      inner as unknown as typeof fetch,
    );
    await wrapped("http://example.test/x");
    const [, init] = inner.mock.calls[0] ?? [];
    expect((init?.headers as Headers | undefined)?.get?.("authorization")).toBeFalsy();
  });

  it("injects the Authorization header on every call", async () => {
    const inner = vi.fn(async () => new Response("ok"));
    const wrapped = createBasicAuthFetch(
      { username: "opencode", password: "topsecret" },
      inner as unknown as typeof fetch,
    );
    await wrapped("http://example.test/x");
    await wrapped("http://example.test/y", { method: "POST" });
    expect(inner).toHaveBeenCalledTimes(2);
    const expectedToken = Buffer.from("opencode:topsecret", "utf8").toString(
      "base64",
    );
    for (const call of inner.mock.calls) {
      const headers = call[1]?.headers as Headers | undefined;
      expect(headers?.get?.("authorization")).toBe(`Basic ${expectedToken}`);
    }
  });

  it("does NOT overwrite an authorization header that the caller already set", async () => {
    const inner = vi.fn(async () => new Response("ok"));
    const wrapped = createBasicAuthFetch(
      { username: "opencode", password: "topsecret" },
      inner as unknown as typeof fetch,
    );
    await wrapped("http://example.test/x", {
      headers: { authorization: "Bearer caller-provided" },
    });
    const headers = inner.mock.calls[0]?.[1]?.headers as Headers | undefined;
    expect(headers?.get?.("authorization")).toBe("Bearer caller-provided");
  });
});
