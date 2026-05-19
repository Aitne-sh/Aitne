import { describe, it, expect } from "vitest";
import { evaluateProxyGate, type ProxyGateInput } from "./proxy-gate";

/**
 * Unit tests for the dashboard proxy CSRF gate.
 *
 * The gate is the only thing standing between an attacker-controlled
 * page and the daemon's Bearer token (which the proxy injects on every
 * forwarded request). Every branch is exercised here, plus the two
 * regression scenarios that motivated the gate's design:
 *
 *   - C2 (DNS rebinding) → covered by the "host_not_loopback" branch
 *   - C2 prerequisite (cross-origin no-cors POST) → covered by the
 *     "sec_fetch_site_cross-site" and "origin_mismatch" branches
 */

const BASE: ProxyGateInput = {
  method: "GET",
  expectedOrigin: "http://localhost:3000",
  origin: null,
  secFetchSite: null,
  host: "localhost:3000",
};

function with_(overrides: Partial<ProxyGateInput>): ProxyGateInput {
  return { ...BASE, ...overrides };
}

describe("evaluateProxyGate — Host header allowlist", () => {
  it("allows literal localhost", () => {
    expect(evaluateProxyGate(with_({ host: "localhost:3000" })).allowed).toBe(true);
  });

  it("allows 127.0.0.1", () => {
    expect(evaluateProxyGate(with_({ host: "127.0.0.1:3000" })).allowed).toBe(true);
  });

  it("allows IPv6 loopback in bracketed form", () => {
    expect(evaluateProxyGate(with_({ host: "[::1]:3000" })).allowed).toBe(true);
  });

  it("REJECTS DNS-rebound attacker domain (C2 regression)", () => {
    // The browser thinks it's same-origin (because the domain currently
    // resolves to 127.0.0.1), but the Host header still carries the
    // attacker's hostname. This is the canonical DNS rebinding scenario.
    const decision = evaluateProxyGate(with_({
      method: "POST",
      host: "pairing.evil.example:3000",
      origin: "http://pairing.evil.example:3000",
      expectedOrigin: "http://pairing.evil.example:3000",
      secFetchSite: "same-origin",
    }));
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe("host_not_loopback");
    }
  });

  it("REJECTS a Host header pointing to a non-loopback IP", () => {
    expect(
      evaluateProxyGate(with_({ host: "192.168.1.5:3000" })).allowed,
    ).toBe(false);
    expect(
      evaluateProxyGate(with_({ host: "8.8.8.8:3000" })).allowed,
    ).toBe(false);
  });

  it("REJECTS missing Host header", () => {
    expect(evaluateProxyGate(with_({ host: null })).allowed).toBe(false);
  });

  it("REJECTS malformed Host header that the URL parser can't handle", () => {
    expect(evaluateProxyGate(with_({ host: "this is not a host" })).allowed).toBe(false);
  });

  it("hostname comparison is case-insensitive", () => {
    expect(evaluateProxyGate(with_({ host: "LOCALHOST:3000" })).allowed).toBe(true);
  });
});

describe("evaluateProxyGate — Sec-Fetch-Site precedence", () => {
  it("allows same-origin POST with SFS=same-origin", () => {
    expect(
      evaluateProxyGate(with_({
        method: "POST",
        secFetchSite: "same-origin",
      })).allowed,
    ).toBe(true);
  });

  it("REJECTS POST with SFS=cross-site even if Origin would match (C2 regression)", () => {
    const decision = evaluateProxyGate(with_({
      method: "POST",
      secFetchSite: "cross-site",
      origin: "http://localhost:3000",
    }));
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe("sec_fetch_site_cross-site");
    }
  });

  it("REJECTS POST with SFS=same-site (subdomain attack)", () => {
    expect(
      evaluateProxyGate(with_({
        method: "POST",
        secFetchSite: "same-site",
      })).allowed,
    ).toBe(false);
  });

  it("allows GET with SFS=none (typed URL / bookmark)", () => {
    expect(
      evaluateProxyGate(with_({
        method: "GET",
        secFetchSite: "none",
      })).allowed,
    ).toBe(true);
  });

  it("REJECTS POST with SFS=none (no user-initiated POST in browsers)", () => {
    const decision = evaluateProxyGate(with_({
      method: "POST",
      secFetchSite: "none",
    }));
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe("unsafe_method_on_user_initiated_navigation");
    }
  });

  it("treats HEAD and OPTIONS as safe methods alongside GET", () => {
    expect(
      evaluateProxyGate(with_({ method: "HEAD", secFetchSite: "none" })).allowed,
    ).toBe(true);
    expect(
      evaluateProxyGate(with_({ method: "OPTIONS", secFetchSite: "none" })).allowed,
    ).toBe(true);
  });
});

describe("evaluateProxyGate — Origin header fallback", () => {
  // For older clients without Sec-Fetch-Site (Safari < 16, some webviews)
  // we still want to allow legitimate same-origin requests.

  it("allows POST with matching Origin and no SFS", () => {
    expect(
      evaluateProxyGate(with_({
        method: "POST",
        origin: "http://localhost:3000",
      })).allowed,
    ).toBe(true);
  });

  it("REJECTS POST with mismatched Origin (CSRF regression)", () => {
    const decision = evaluateProxyGate(with_({
      method: "POST",
      origin: "http://evil.example:3000",
    }));
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe("origin_mismatch");
    }
  });

  it("REJECTS POST with no Origin and no SFS (defensive)", () => {
    const decision = evaluateProxyGate(with_({
      method: "POST",
      origin: null,
      secFetchSite: null,
    }));
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe("unsafe_method_no_metadata");
    }
  });

  it("allows GET with no Origin and no SFS (curl-style direct hit)", () => {
    expect(
      evaluateProxyGate(with_({
        method: "GET",
        origin: null,
        secFetchSite: null,
      })).allowed,
    ).toBe(true);
  });
});

describe("evaluateProxyGate — Host check precedence", () => {
  // The Host check runs FIRST. Even if the Origin/SFS would otherwise
  // pass, a non-loopback Host short-circuits to reject. This is the
  // defining property that defeats DNS rebinding.
  it("Host check beats a passing Sec-Fetch-Site=same-origin", () => {
    expect(
      evaluateProxyGate(with_({
        method: "POST",
        host: "pairing.evil.example:3000",
        secFetchSite: "same-origin",
      })).allowed,
    ).toBe(false);
  });

  it("Host check beats a matching Origin header", () => {
    expect(
      evaluateProxyGate(with_({
        method: "POST",
        host: "pairing.evil.example:3000",
        origin: "http://pairing.evil.example:3000",
        expectedOrigin: "http://pairing.evil.example:3000",
      })).allowed,
    ).toBe(false);
  });
});
