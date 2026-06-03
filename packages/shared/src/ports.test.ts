import { describe, it, expect, afterEach } from "vitest";
import {
  DEFAULT_API_PORT,
  DEFAULT_DASHBOARD_PORT,
  resolveApiPort,
  resolveDashboardPort,
  loopbackOrigins,
} from "./ports.js";
// The launcher mirror (plain ESM, cannot import @aitne/shared). This import is
// the drift guard: if the two definitions diverge, the assertions below fail.
import * as launcher from "../../../scripts/lib/ports.mjs";

describe("port defaults", () => {
  it("uses non-conflicting defaults (dashboard is not 3000)", () => {
    expect(DEFAULT_API_PORT).toBe(8321);
    expect(DEFAULT_DASHBOARD_PORT).toBe(8322);
    expect(DEFAULT_DASHBOARD_PORT).not.toBe(3000);
  });
});

describe("scripts/lib/ports.mjs stays in lockstep with @aitne/shared", () => {
  it("defines identical default constants", () => {
    expect(launcher.DEFAULT_API_PORT).toBe(DEFAULT_API_PORT);
    expect(launcher.DEFAULT_DASHBOARD_PORT).toBe(DEFAULT_DASHBOARD_PORT);
  });

  it("resolves identically across both implementations", () => {
    const cases: Array<Record<string, string | undefined>> = [
      {},
      { PA_API_PORT: "9100", PA_DASHBOARD_PORT: "9200" },
      { PA_API_PORT: "", PA_DASHBOARD_PORT: "" },
      { PA_API_PORT: "not-a-port", PA_DASHBOARD_PORT: "-5" },
    ];
    for (const env of cases) {
      expect(launcher.resolveApiPort(env)).toBe(resolveApiPort(env));
      expect(launcher.resolveDashboardPort(env)).toBe(resolveDashboardPort(env));
    }
  });
});

describe("resolveApiPort / resolveDashboardPort", () => {
  const originalApi = process.env.PA_API_PORT;
  const originalDash = process.env.PA_DASHBOARD_PORT;
  afterEach(() => {
    if (originalApi === undefined) delete process.env.PA_API_PORT;
    else process.env.PA_API_PORT = originalApi;
    if (originalDash === undefined) delete process.env.PA_DASHBOARD_PORT;
    else process.env.PA_DASHBOARD_PORT = originalDash;
  });

  it("falls back to the default when env is unset, empty, or invalid", () => {
    expect(resolveApiPort({})).toBe(DEFAULT_API_PORT);
    expect(resolveApiPort({ PA_API_PORT: "" })).toBe(DEFAULT_API_PORT);
    expect(resolveApiPort({ PA_API_PORT: "abc" })).toBe(DEFAULT_API_PORT);
    expect(resolveApiPort({ PA_API_PORT: "0" })).toBe(DEFAULT_API_PORT);
    expect(resolveApiPort({ PA_API_PORT: "-3" })).toBe(DEFAULT_API_PORT);
    expect(resolveDashboardPort({})).toBe(DEFAULT_DASHBOARD_PORT);
    expect(resolveDashboardPort({ PA_DASHBOARD_PORT: "" })).toBe(
      DEFAULT_DASHBOARD_PORT,
    );
  });

  it("parses a valid override", () => {
    expect(resolveApiPort({ PA_API_PORT: "9999" })).toBe(9999);
    expect(resolveDashboardPort({ PA_DASHBOARD_PORT: "4321" })).toBe(4321);
  });

  it("reads process.env via the default parameter", () => {
    process.env.PA_API_PORT = "7777";
    process.env.PA_DASHBOARD_PORT = "7778";
    expect(resolveApiPort()).toBe(7777);
    expect(resolveDashboardPort()).toBe(7778);
    delete process.env.PA_API_PORT;
    delete process.env.PA_DASHBOARD_PORT;
    expect(resolveApiPort()).toBe(DEFAULT_API_PORT);
    expect(resolveDashboardPort()).toBe(DEFAULT_DASHBOARD_PORT);
  });
});

describe("loopbackOrigins", () => {
  it("returns the localhost / 127.0.0.1 / [::1] triple for a port", () => {
    expect(loopbackOrigins(8322)).toEqual([
      "http://localhost:8322",
      "http://127.0.0.1:8322",
      "http://[::1]:8322",
    ]);
  });
});
