import { describe, it, expect } from "vitest";
import {
  buildResearchDomainLists,
  classifyMeaningful,
  isMeaningful,
  normalizeResearchDomain,
} from "./meaningful-filter.js";
import type {
  MeaningfulCandidate,
  ResearchDomainLists,
} from "./meaningful-filter.js";

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

  it("rejects claude.ai/usage as domain_noise (rule fires after global denylist)", () => {
    // `usage` is in claude.ai's noiseSegments but NOT in the global
    // PATH_DENYLIST_SEGMENTS, so the verdict is gated by the
    // domain-noise rule rather than path_denied. Exercises the L146
    // `if (noise)` true branch.
    const verdict = classifyMeaningful(
      build({
        host: "claude.ai",
        path: "/usage",
        category: "dev",
      }),
    );
    expect(verdict.meaningful).toBe(false);
    expect(verdict.reason).toBe("domain_noise");
  });

  it("rejects example.com/research/login/page on path-denylist segment match (not prefix)", () => {
    // Covers the L141 branch: pathContainsSegment hit when neither L138
    // (pathStartsWithSegment) nor L135 (category) gate the visit first.
    const verdict = classifyMeaningful(
      build({
        host: "example.com",
        path: "/research/login/page",
        category: "research",
      }),
    );
    expect(verdict.meaningful).toBe(false);
    expect(verdict.reason).toBe("path_denied");
  });

  it("treats an empty path as 'no segments' across both pathStartsWith and pathContains checks", () => {
    // Covers L94 (segments.length === 0 branch in pathStartsWithSegment)
    // and the empty-segments early return in pathContainsSegment.
    const verdict = classifyMeaningful(
      build({ path: "", host: "arxiv.org", category: "research" }),
    );
    expect(verdict.meaningful).toBe(true);
  });

  it("falls through domain-noise rule when path is empty on a noise host (first ?? '' branch)", () => {
    // Covers L112 `first ?? ""` — claude.ai with empty path means
    // `segments[0]` is undefined; the rule should not flag domain_noise.
    const verdict = classifyMeaningful(
      build({
        host: "claude.ai",
        path: "",
        category: "research",
        foregroundSeconds: 120,
      }),
    );
    // Empty path + non-noise category + sufficient dwell → meaningful.
    expect(verdict.meaningful).toBe(true);
  });

  it("rejects a missing scheme as scheme_blocked (|| '' fallback)", () => {
    // Covers L124 `input.scheme || ""` falsy branch.
    const verdict = classifyMeaningful(
      build({ scheme: undefined as unknown as string, category: "research" }),
    );
    expect(verdict.meaningful).toBe(false);
    expect(verdict.reason).toBe("scheme_blocked");
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

// BROWSER_HISTORY_INTEGRATION_PLAN §5.F1.meaningful rule 6 — user-curated
// allowlist / denylist. Both default to empty; the classifier short-circuits
// before rules 1-5 when a domain hits the denylist, and switches to
// allowlist-only mode when the allowlist is non-empty. Denylist wins over
// allowlist on the same domain.
describe("classifyMeaningful — rule 6 (user-curated domain lists)", () => {
  it("denies a visit whose eTLD+1 is in the denylist, regardless of category", () => {
    // The denylist matches eTLD+1, so a user entry "news.ycombinator.com"
    // is normalized to "ycombinator.com" and catches every subdomain of
    // the registered domain. Use the builder to get the normalization
    // free; constructing a Set with the raw subdomain would silently
    // mismatch (a regression we'd want to keep noisy).
    const lists = buildResearchDomainLists([], ["news.ycombinator.com"]);
    const verdict = classifyMeaningful(
      build({
        host: "news.ycombinator.com",
        path: "/item?id=1",
        category: "news",
        foregroundSeconds: 300,
      }),
      lists,
    );
    expect(verdict.meaningful).toBe(false);
    expect(verdict.reason).toBe("domain_denylisted");
  });

  it("treats www.<domain> the same as <domain> for denylist match", () => {
    const lists = buildResearchDomainLists([], ["arxiv.org"]);
    const verdict = classifyMeaningful(
      build({ host: "www.arxiv.org", path: "/abs/2402.06196" }),
      lists,
    );
    expect(verdict.meaningful).toBe(false);
    expect(verdict.reason).toBe("domain_denylisted");
  });

  it("switches to allowlist-only mode when allowlist is non-empty", () => {
    const lists: ResearchDomainLists = {
      allowlist: new Set(["arxiv.org"]),
      denylist: new Set(),
    };
    // arxiv.org is in the list → meaningful.
    expect(
      classifyMeaningful(
        build({ host: "arxiv.org", path: "/abs/x", category: "research" }),
        lists,
      ).meaningful,
    ).toBe(true);
    // Wikipedia is not in the list → not meaningful, even though it
    // would otherwise be eligible.
    const wiki = classifyMeaningful(
      build({
        host: "en.wikipedia.org",
        path: "/wiki/Quantum_mechanics",
        category: "research",
      }),
      lists,
    );
    expect(wiki.meaningful).toBe(false);
    expect(wiki.reason).toBe("domain_outside_allowlist");
  });

  it("denylist wins over allowlist on the same domain (defensive)", () => {
    const lists: ResearchDomainLists = {
      allowlist: new Set(["arxiv.org"]),
      denylist: new Set(["arxiv.org"]),
    };
    const verdict = classifyMeaningful(
      build({ host: "arxiv.org", path: "/abs/x", category: "research" }),
      lists,
    );
    expect(verdict.meaningful).toBe(false);
    expect(verdict.reason).toBe("domain_denylisted");
  });

  it("empty lists = emergent mode (default behavior unchanged)", () => {
    // Identical to the basic Wikipedia case at the top of the file —
    // confirming that passing empty lists explicitly is a no-op.
    const lists = buildResearchDomainLists([], []);
    expect(isMeaningful(build(), lists)).toBe(true);
  });
});

describe("normalizeResearchDomain", () => {
  it("normalizes bare hosts", () => {
    expect(normalizeResearchDomain("arxiv.org")).toBe("arxiv.org");
  });
  it("strips www., scheme, path, query, and fragment", () => {
    expect(normalizeResearchDomain("https://www.arxiv.org/abs/2402.06196?q=1#x"))
      .toBe("arxiv.org");
  });
  it("preserves two-level public suffixes (co.jp)", () => {
    expect(normalizeResearchDomain("example.co.jp")).toBe("example.co.jp");
    expect(normalizeResearchDomain("https://blog.example.co.jp/x")).toBe(
      "example.co.jp",
    );
  });
  it("handles user@ and :port in URL-shaped input", () => {
    expect(normalizeResearchDomain("https://user@example.com:8080/path")).toBe(
      "example.com",
    );
  });
  it("returns empty string for empty / whitespace input", () => {
    expect(normalizeResearchDomain("")).toBe("");
    expect(normalizeResearchDomain("   ")).toBe("");
  });
  it("returns empty string when stripping yields no host (degenerate URL-shaped input)", () => {
    // The branch coverage we want: `registeredDomain("")` (after the
    // URL-strip walk leaves nothing) and the all-dots case where every
    // split segment is empty.
    expect(normalizeResearchDomain("https://")).toBe("");
    expect(normalizeResearchDomain("...")).toBe("");
  });
});

describe("buildResearchDomainLists", () => {
  it("normalizes and dedupes input entries", () => {
    const lists = buildResearchDomainLists(
      ["arxiv.org", "https://arxiv.org/abs/x", "www.ArXiv.org", " "],
      [],
    );
    expect(lists.allowlist.size).toBe(1);
    expect(lists.allowlist.has("arxiv.org")).toBe(true);
  });
  it("handles undefined inputs without throwing", () => {
    const lists = buildResearchDomainLists(undefined, undefined);
    expect(lists.allowlist.size).toBe(0);
    expect(lists.denylist.size).toBe(0);
  });
});
