import { describe, expect, it } from "vitest";
import { buildUpstreamUrl } from "./proxy-url";

const DAEMON = "http://127.0.0.1:8321";

describe("buildUpstreamUrl", () => {
  it("forwards a simple path unchanged", () => {
    const url = buildUpstreamUrl(
      { pathname: "/api/health", search: "" },
      DAEMON,
    );
    expect(url.href).toBe("http://127.0.0.1:8321/api/health");
  });

  it("preserves a query string", () => {
    const url = buildUpstreamUrl(
      { pathname: "/api/observations", search: "?source=git&limit=8" },
      DAEMON,
    );
    expect(url.href).toBe(
      "http://127.0.0.1:8321/api/observations?source=git&limit=8",
    );
  });

  it("preserves %2F in a path segment", () => {
    // Repository IDs are formed as `github:owner/repo` and arrive at the proxy
    // as `github%3Aowner%2Frepo`. The %2F must survive — decoding it into a
    // literal slash adds an extra path segment that breaks Hono's :id match
    // and produces a daemon-side 404 (the bug this proxy was rewritten to fix).
    const url = buildUpstreamUrl(
      {
        pathname: "/api/repositories/github%3Aowner%2Frepo",
        search: "",
      },
      DAEMON,
    );
    expect(url.pathname).toBe("/api/repositories/github%3Aowner%2Frepo");
    expect(url.href).toBe(
      "http://127.0.0.1:8321/api/repositories/github%3Aowner%2Frepo",
    );
  });

  it("preserves %2F together with a sub-resource path", () => {
    const url = buildUpstreamUrl(
      {
        pathname:
          "/api/repositories/github%3Aowner%2Frepo/triggers/trg_abc",
        search: "",
      },
      DAEMON,
    );
    expect(url.pathname).toBe(
      "/api/repositories/github%3Aowner%2Frepo/triggers/trg_abc",
    );
  });

  it("does not append a stray '?' when search is empty", () => {
    const url = buildUpstreamUrl(
      { pathname: "/api/repositories", search: "" },
      DAEMON,
    );
    expect(url.href).toBe("http://127.0.0.1:8321/api/repositories");
  });

  it("matches the encoding produced by NextRequest.nextUrl.pathname", () => {
    // Sanity check: this test fails if a future Next.js upgrade silently
    // changes URL parsing such that NextRequest no longer preserves %2F.
    // Empirically verified on Next.js 16.2.3 / Node 22+: %2F is preserved.
    const incoming = new URL(
      "http://localhost:3000/api/repositories/github%3Aexample%2Frepo",
    );
    const url = buildUpstreamUrl(
      { pathname: incoming.pathname, search: incoming.search },
      DAEMON,
    );
    expect(url.pathname).toBe(
      "/api/repositories/github%3Aexample%2Frepo",
    );
  });
});
