import { describe, it, expect } from "vitest";
import { classifyMeaningful, isMeaningful } from "./meaningful-filter.js";
import type { MeaningfulCandidate } from "./meaningful-filter.js";

function build(
  partial: Partial<MeaningfulCandidate> = {},
): MeaningfulCandidate {
  return {
    scheme: "https:",
    host: "en.wikipedia.org",
    path: "/wiki/Quantum_mechanics",
    category: "research",
    foregroundSeconds: 180,
    ...partial,
  };
}

describe("classifyMeaningful — §5.F1.meaningful pinned cases", () => {
  it("classifies long Wikipedia article reads as meaningful", () => {
    expect(isMeaningful(build())).toBe(true);
  });

  it("classifies arxiv as meaningful", () => {
    expect(
      isMeaningful(
        build({ host: "arxiv.org", path: "/abs/2402.06196", category: "research" }),
      ),
    ).toBe(true);
  });

  it("classifies github.com repo paths as meaningful (dev category)", () => {
    expect(
      isMeaningful(
        build({
          host: "github.com",
          path: "/anthropics/anthropic-cookbook",
          category: "dev",
        }),
      ),
    ).toBe(true);
  });

  it("rejects claude.ai/settings as non-meaningful (path denylist)", () => {
    const verdict = classifyMeaningful(
      build({
        host: "claude.ai",
        path: "/settings/usage",
        category: "app-config",
      }),
    );
    expect(verdict.meaningful).toBe(false);
  });

  it("rejects chrome:// scheme", () => {
    const verdict = classifyMeaningful(
      build({
        scheme: "chrome:",
        host: "settings",
        path: "/passwords",
        category: "app-config",
      }),
    );
    expect(verdict.meaningful).toBe(false);
    expect(verdict.reason).toBe("scheme_blocked");
  });

  it("rejects github.com/settings as non-meaningful (domain-noise rule)", () => {
    const verdict = classifyMeaningful(
      build({
        host: "github.com",
        path: "/settings/profile",
        category: "app-config",
      }),
    );
    expect(verdict.meaningful).toBe(false);
  });

  it("rejects short visits under 30s foreground", () => {
    const verdict = classifyMeaningful(
      build({ foregroundSeconds: 5 }),
    );
    expect(verdict.meaningful).toBe(false);
    expect(verdict.reason).toBe("below_dwell_threshold");
  });

  it("rejects shopping category (handled by F3 separately)", () => {
    expect(
      classifyMeaningful(
        build({
          host: "amazon.com",
          path: "/dp/B08XYZ",
          category: "shopping",
          foregroundSeconds: 300,
        }),
      ).meaningful,
    ).toBe(false);
  });

  it("rejects plain HTTP scheme (https-only allowlist)", () => {
    expect(
      classifyMeaningful(
        build({ scheme: "http:", category: "research" }),
      ).meaningful,
    ).toBe(false);
  });

  it("rejects null foreground", () => {
    expect(
      classifyMeaningful(build({ foregroundSeconds: null })).meaningful,
    ).toBe(false);
  });

  it("rejects /api path prefix", () => {
    expect(
      classifyMeaningful(
        build({
          host: "example.com",
          path: "/api/v1/users",
          category: "dev",
        }),
      ).meaningful,
    ).toBe(false);
  });

  it("accepts /research/api-keys-paper (segment match, not substring)", () => {
    expect(
      classifyMeaningful(
        build({
          host: "example.com",
          path: "/research/api-keys-paper",
          category: "research",
        }),
      ).meaningful,
    ).toBe(true);
  });

  it("classifies claude.ai/chat/* as meaningful when category is dev", () => {
    expect(
      classifyMeaningful(
        build({
          host: "claude.ai",
          path: "/chat/abc123",
          category: "dev",
        }),
      ).meaningful,
    ).toBe(true);
  });
});
