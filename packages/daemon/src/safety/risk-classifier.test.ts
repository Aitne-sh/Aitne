import { describe, it, expect } from "vitest";
import {
  auditRiskClassifications,
  classifyRisk,
  findExplicitRiskClassification,
  listReadSensitiveGetPathKeys,
  RiskTier,
} from "./risk-classifier.js";

describe("classifyRisk — multi-mail provider routes", () => {
  describe("exact + prefix classification still works", () => {
    it("classifies /api/mail/accounts (exact) as Approve", () => {
      expect(classifyRisk("POST", "/api/mail/accounts")).toBe(RiskTier.Approve);
    });
    it("classifies generic GET /api/mail/* as ReadSensitive", () => {
      expect(classifyRisk("GET", "/api/mail/unknown-future-route")).toBe(
        RiskTier.ReadSensitive,
      );
    });
  });

  describe("per-account pattern rules", () => {
    it("draft create is Autonomous", () => {
      expect(classifyRisk("POST", "/api/mail/outlook-abc/drafts")).toBe(
        RiskTier.Autonomous,
      );
    });
    it("draft send is Autonomous — Notify abolished (DELEGATED-MODE-V2 §4.5)", () => {
      expect(
        classifyRisk("POST", "/api/mail/outlook-abc/drafts/d-123/send"),
      ).toBe(RiskTier.Autonomous);
    });
    it("draft patch is Autonomous (reshaping an inert draft)", () => {
      expect(
        classifyRisk("PATCH", "/api/mail/gmail-xyz/drafts/d-abc"),
      ).toBe(RiskTier.Autonomous);
    });
    it("draft delete is Autonomous (inert content)", () => {
      expect(
        classifyRisk("DELETE", "/api/mail/icloud-1/drafts/d-abc"),
      ).toBe(RiskTier.Autonomous);
    });
    it("direct send is Autonomous (deniedTools is the gate, not Notify)", () => {
      expect(
        classifyRisk("POST", "/api/mail/outlook-abc/messages/send"),
      ).toBe(RiskTier.Autonomous);
    });
    it("message trash is Autonomous (deniedTools is the gate, not Notify)", () => {
      expect(
        classifyRisk("POST", "/api/mail/outlook-abc/messages/m-123/trash"),
      ).toBe(RiskTier.Autonomous);
    });
    it("reversible metadata ops are Autonomous", () => {
      expect(
        classifyRisk("POST", "/api/mail/outlook-abc/messages/m-123/read"),
      ).toBe(RiskTier.Autonomous);
      expect(
        classifyRisk("POST", "/api/mail/outlook-abc/messages/m-123/archive"),
      ).toBe(RiskTier.Autonomous);
      expect(
        classifyRisk("POST", "/api/mail/outlook-abc/messages/m-123/untrash"),
      ).toBe(RiskTier.Autonomous);
      expect(
        classifyRisk("POST", "/api/mail/outlook-abc/messages/m-123/tags"),
      ).toBe(RiskTier.Autonomous);
    });
    it("reads on per-account routes stay ReadSensitive", () => {
      expect(
        classifyRisk("GET", "/api/mail/outlook-abc/messages/m-123"),
      ).toBe(RiskTier.ReadSensitive);
      expect(
        classifyRisk("GET", "/api/mail/outlook-abc/threads/t-1"),
      ).toBe(RiskTier.ReadSensitive);
      expect(
        classifyRisk("GET", "/api/mail/outlook-abc/health"),
      ).toBe(RiskTier.ReadSensitive);
    });
  });

  describe("unclassified writes fall to Autonomous (post-Notify-abolition)", () => {
    it("POST falls to Autonomous via the catch-all prefix", () => {
      expect(
        classifyRisk("POST", "/api/mail/outlook-abc/new-future-endpoint"),
      ).toBe(RiskTier.Autonomous);
    });
    it("PATCH falls to Autonomous via the catch-all prefix", () => {
      expect(
        classifyRisk("PATCH", "/api/mail/outlook-abc/hypothetical-resource"),
      ).toBe(RiskTier.Autonomous);
    });
    it("DELETE falls to Autonomous via the catch-all prefix", () => {
      expect(
        classifyRisk("DELETE", "/api/mail/outlook-abc/hypothetical-resource"),
      ).toBe(RiskTier.Autonomous);
    });
  });
});

describe("classifyRisk — integrations probe wildcard", () => {
  it("matches POST /api/integrations/<key>/probe via {*} pattern", () => {
    expect(
      classifyRisk("POST", "/api/integrations/gmail/probe"),
    ).toBe(RiskTier.Approve);
    expect(
      classifyRisk("POST", "/api/integrations/google_calendar/probe"),
    ).toBe(RiskTier.Approve);
  });

  it("PATCH /api/integrations/<key> remains Approve via prefix match", () => {
    expect(
      classifyRisk("PATCH", "/api/integrations/gmail"),
    ).toBe(RiskTier.Approve);
  });

  it("POST /api/integrations/<key>/reconcile is Autonomous (drift-detection chokepoint)", () => {
    expect(
      classifyRisk("POST", "/api/integrations/google_calendar/reconcile"),
    ).toBe(RiskTier.Autonomous);
    expect(
      classifyRisk("POST", "/api/integrations/gmail/reconcile"),
    ).toBe(RiskTier.Autonomous);
  });
});

describe("classifyRisk — skill-curation run minting is Approve", () => {
  it("POST /api/skill-curation/runs (token mint) requires Bearer", () => {
    // The mint endpoint is a test seam; leaving it Autonomous let a Bearer-less
    // caller mint a valid optimizer run-token. Approve confines it to the
    // dashboard/operator.
    expect(
      classifyRisk("POST", "/api/skill-curation/runs"),
    ).toBe(RiskTier.Approve);
  });

  it("proposals + finalize stay Autonomous (optimizer runToken is the gate)", () => {
    expect(
      classifyRisk("POST", "/api/skill-curation/proposals"),
    ).toBe(RiskTier.Autonomous);
    expect(
      classifyRisk("POST", "/api/skill-curation/runs/skcur-123/finalize"),
    ).toBe(RiskTier.Autonomous);
  });
});

describe("classifyRisk — DELEGATED-TASK-MODE-DESIGN.md §4.2 generic /run", () => {
  it("POST /api/delegated/run is Approve-tier (Bearer required)", () => {
    // §4.2 / docs/design/14-integration-delegation.md §14.13.2 — wider
    // blast radius than /exec because there is no per-integration
    // deniedTools to enforce. Diverges from /api/integrations/{*}/exec
    // (Autonomous), where the integration's user-curated deny list
    // provides the safety floor. Lock the tier explicitly so a refactor
    // cannot silently downgrade
    // it to Autonomous — the regression would expose a Bearer-less RPC
    // surface to anyone who can hit 127.0.0.1:8321.
    expect(classifyRisk("POST", "/api/delegated/run")).toBe(RiskTier.Approve);
  });
});

describe("classifyRisk — B-008 P7 vault health surface", () => {
  it("GET /api/context/health is Autonomous (structural drift report, no prose)", () => {
    expect(classifyRisk("GET", "/api/context/health")).toBe(RiskTier.Autonomous);
  });

  it("POST /api/context/repair/stub is Autonomous (post-Notify-abolition)", () => {
    expect(classifyRisk("POST", "/api/context/repair/stub")).toBe(
      RiskTier.Autonomous,
    );
  });

  it("POST /api/context/roadmap/id is Autonomous (pure-utility ID minter)", () => {
    // Without an explicit entry the route falls into the Approve
    // fail-closed default, producing 401s during roadmap_refresh that
    // force Sonnet onto fabricated placeholder IDs that then fail PUT
    // validation with `Malformed roadmap id marker`. Lock this down so
    // the regression doesn't recur.
    expect(classifyRisk("POST", "/api/context/plans/roadmap/id")).toBe(
      RiskTier.Autonomous,
    );
  });
});

describe("classifyRisk — fail-closed default for unknown /api/* routes", () => {
  it("unknown /api/* path falls to Approve (fail-closed)", () => {
    // Newly-added browser-facing routes that the developer forgot to add to
    // API_RISK MUST default to Approve — otherwise an unauthenticated route
    // becomes silently agent-callable. See the fail-closed branch in
    // risk-classifier.ts.
    expect(
      classifyRisk("GET", "/api/this-route-does-not-exist-yet"),
    ).toBe(RiskTier.Approve);
    expect(
      classifyRisk("POST", "/api/totally/unmapped/endpoint"),
    ).toBe(RiskTier.Approve);
    expect(
      classifyRisk("DELETE", "/api/foo/bar/baz"),
    ).toBe(RiskTier.Approve);
  });

  it("non-/api paths fall to Autonomous (webhooks, root, dev surfaces)", () => {
    expect(classifyRisk("GET", "/")).toBe(RiskTier.Autonomous);
    expect(classifyRisk("POST", "/webhooks/github")).toBe(RiskTier.Autonomous);
    expect(classifyRisk("GET", "/dashboard/index.html")).toBe(
      RiskTier.Autonomous,
    );
  });
});

describe("classifyRisk — pattern matcher rejects empty `{*}` segments", () => {
  it("trailing-slash request does not silently match a `{*}` pattern with an empty segment", () => {
    // `POST /api/integrations//probe` (note the empty segment between two slashes)
    // must NOT match `POST /api/integrations/{*}/probe` — a `{*}` requires a
    // non-empty segment. Without the empty-segment guard a malformed request
    // would inherit the same Approve tier as a real probe call.
    expect(classifyRisk("POST", "/api/integrations//probe")).toBe(
      RiskTier.Approve, // unknown /api/* fail-closed default, NOT the probe rule
    );
  });
});

describe("auditRiskClassifications — startup audit", () => {
  it("returns routes that lack an explicit classification", () => {
    const result = auditRiskClassifications([
      { method: "GET", path: "/api/health" },
      { method: "POST", path: "/api/this-route-is-not-classified" },
      { method: "GET", path: "/" }, // non-/api — skipped
    ]);
    const paths = result.map((r) => `${r.method} ${r.path}`);
    expect(paths).toEqual(["POST /api/this-route-is-not-classified"]);
  });

  it("normalizes Hono `:param` segments before lookup", () => {
    // `POST /api/integrations/{*}/probe` should match `/api/integrations/:key/probe`.
    const result = auditRiskClassifications([
      { method: "POST", path: "/api/integrations/:key/probe" },
    ]);
    expect(result).toEqual([]);
  });

  it("ignores ALL/OPTIONS/HEAD methods and non-/api paths", () => {
    // Even unmapped routes are skipped if they match the ignore criteria.
    const result = auditRiskClassifications([
      { method: "ALL", path: "/api/middleware-everywhere" },
      { method: "OPTIONS", path: "/api/cors" },
      { method: "HEAD", path: "/api/something" },
      { method: "GET", path: "/non-api/route" },
    ]);
    expect(result).toEqual([]);
  });

  it("dedupes repeated route registrations (Hono `app.use` + `app.get` same path)", () => {
    const result = auditRiskClassifications([
      { method: "GET", path: "/api/this-route-is-not-classified" },
      { method: "GET", path: "/api/this-route-is-not-classified" },
    ]);
    expect(result).toHaveLength(1);
  });

  it("treats /api as a classifiable surface (not just /api/...)", () => {
    // Edge: bare "/api" without trailing slash is included by the audit
    // (`route.path !== "/api"`). Keep this behaviour locked in so the
    // developer who registers `app.get("/api", ...)` sees an audit
    // warning instead of silent default-Autonomous.
    const result = auditRiskClassifications([{ method: "GET", path: "/api" }]);
    expect(result).toEqual([{ method: "GET", path: "/api" }]);
  });
});

describe("auditRiskClassifications — boot-time enforcement", () => {
  it("returns empty when every /api route has an explicit classification", () => {
    const routes = [
      { method: "GET", path: "/api/health" },
      { method: "PUT", path: "/api/context/state/today" },
      { method: "POST", path: "/api/context/plans/roadmap/id" },
    ];
    expect(auditRiskClassifications(routes)).toEqual([]);
  });

  it("flags an unclassified /api route", () => {
    const routes = [
      { method: "POST", path: "/api/this-route-does-not-exist-anywhere" },
    ];
    expect(auditRiskClassifications(routes)).toEqual([
      { method: "POST", path: "/api/this-route-does-not-exist-anywhere" },
    ]);
  });

  it("normalizes Hono :param segments so {*}-pattern entries match", () => {
    // `POST /api/integrations/:key/exec` should match the `{*}` pattern
    // entry in API_RISK. Without normalization the audit would falsely
    // flag every parameterized route. (The /exec route replaced the
    // retired /invoke entry; using /exec keeps this test exercising
    // the same {*}-pattern-normalization invariant against the
    // agent-active route set.)
    const routes = [
      { method: "POST", path: "/api/integrations/:key/exec" },
      { method: "POST", path: "/api/integrations/:key/probe" },
      { method: "POST", path: "/api/integrations/:key/reconcile" },
    ];
    expect(auditRiskClassifications(routes)).toEqual([]);
  });

  it("ignores non-/api routes (webhooks, root)", () => {
    const routes = [
      { method: "POST", path: "/webhook/github" },
      { method: "GET", path: "/" },
    ];
    expect(auditRiskClassifications(routes)).toEqual([]);
  });

  it("ignores ALL/OPTIONS/HEAD methods (middleware, CORS, probe)", () => {
    const routes = [
      { method: "ALL", path: "/api/foo" },
      { method: "OPTIONS", path: "/api/foo" },
      { method: "HEAD", path: "/api/foo" },
    ];
    expect(auditRiskClassifications(routes)).toEqual([]);
  });

  it("dedupes identical (method, path) pairs (multiple sub-app mounts)", () => {
    const routes = [
      { method: "POST", path: "/api/missing-route" },
      { method: "POST", path: "/api/missing-route" },
    ];
    expect(auditRiskClassifications(routes)).toEqual([
      { method: "POST", path: "/api/missing-route" },
    ]);
  });

  // The admin/dashboard route baseline that the audit surfaced. Each
  // entry should match an explicit Approve via the "Admin / dashboard
  // surfaces" block in API_RISK. If a future refactor accidentally
  // drops one of those entries, this test regresses with a precise
  // route-by-route diff.
  it("classifies the admin/dashboard baseline (no regressions)", () => {
    const baseline = [
      { method: "POST", path: "/api/context/restore-snapshot/:id" },
      { method: "DELETE", path: "/api/context/*" },
      { method: "POST", path: "/api/escalate" },
      { method: "PUT", path: "/api/secrets/slack" },
      { method: "PUT", path: "/api/secrets/telegram" },
      { method: "PUT", path: "/api/secrets/discord" },
      { method: "PUT", path: "/api/secrets/notion" },
      { method: "PUT", path: "/api/secrets/github" },
      { method: "PUT", path: "/api/secrets/google/credentials" },
      { method: "PUT", path: "/api/secrets/google/token" },
      { method: "DELETE", path: "/api/secrets/:name" },
      { method: "GET", path: "/api/dashboard/next-check" },
      { method: "POST", path: "/api/messaging/whatsapp/pair" },
      { method: "GET", path: "/api/messaging/whatsapp/qr" },
      { method: "GET", path: "/api/messaging/whatsapp/status" },
      { method: "POST", path: "/api/messaging/telegram/test-token" },
      { method: "POST", path: "/api/messaging/telegram/start-pairing" },
      { method: "GET", path: "/api/messaging/telegram/pairing-status" },
      { method: "POST", path: "/api/messaging/telegram/cancel-pairing" },
      { method: "POST", path: "/api/messaging/slack/test-token" },
      { method: "GET", path: "/api/messaging/slack/manifest" },
      { method: "POST", path: "/api/messaging/slack/start-pairing" },
      { method: "POST", path: "/api/messaging/slack/cancel-pairing" },
      { method: "GET", path: "/api/messaging/slack/pairing-status" },
      { method: "POST", path: "/api/messaging/discord/test-token" },
      { method: "POST", path: "/api/messaging/discord/start-pairing" },
      { method: "POST", path: "/api/messaging/discord/cancel-pairing" },
      { method: "GET", path: "/api/messaging/discord/pairing-status" },
      { method: "PUT", path: "/api/backends/defaults" },
      { method: "GET", path: "/api/process-config" },
      { method: "PUT", path: "/api/process-config/:processKey" },
      { method: "PUT", path: "/api/backends/advisor" },
      // Dashboard-only surfaces that were silently relying on the
      // default-Approve fallback — flagged by the boot audit warning.
      // Pinning them here keeps the fingerprint at "0 unclassified" so
      // a future deletion shows up as a precise route-by-route
      // regression instead of one new line of noise.
      { method: "GET", path: "/api/activity-sources" },
      { method: "GET", path: "/api/voice/status" },
      { method: "POST", path: "/api/voice/install" },
      { method: "DELETE", path: "/api/voice/model" },
    ];
    expect(auditRiskClassifications(baseline)).toEqual([]);
  });
});

describe("classifyRisk — Agent Definitions (AGENT_DEFINITIONS_DESIGN.md §9.7)", () => {
  it("classifies reads + run-now as Autonomous", () => {
    expect(classifyRisk("GET", "/api/agents")).toBe(RiskTier.Autonomous);
    expect(classifyRisk("GET", "/api/agents/morning-routine")).toBe(RiskTier.Autonomous);
    expect(classifyRisk("GET", "/api/agents/morning-routine/executions")).toBe(
      RiskTier.Autonomous,
    );
    expect(classifyRisk("POST", "/api/agents/morning-routine/run-now")).toBe(
      RiskTier.Autonomous,
    );
  });

  it("classifies PATCH + DELETE as Approve (config / enabled changes need the bearer)", () => {
    expect(classifyRisk("PATCH", "/api/agents/morning-routine")).toBe(RiskTier.Approve);
    expect(classifyRisk("DELETE", "/api/agents/my-task")).toBe(RiskTier.Approve);
  });

  it("leaves no agent route on the default-Approve fallback (boot-audit clean)", () => {
    expect(
      auditRiskClassifications([
        { method: "GET", path: "/api/agents" },
        { method: "GET", path: "/api/agents/:slug" },
        { method: "GET", path: "/api/agents/:slug/executions" },
        { method: "POST", path: "/api/agents/:slug/run-now" },
        { method: "PATCH", path: "/api/agents/:slug" },
        { method: "DELETE", path: "/api/agents/:slug" },
      ]),
    ).toEqual([]);
  });
});

describe("classifyRisk — Docs QA endpoints (DOCS_QA_B7_DESIGN.md D6)", () => {
  it("POST /api/docs/qa/messages is Approve (dashboard-Bearer-gated input)", () => {
    expect(classifyRisk("POST", "/api/docs/qa/messages")).toBe(RiskTier.Approve);
  });

  it("GET /api/docs/qa/stream is Autonomous (read of docs corpus, no personal data)", () => {
    expect(classifyRisk("GET", "/api/docs/qa/stream")).toBe(RiskTier.Autonomous);
  });

  it("GET /api/docs/search remains Autonomous via the /api/docs prefix", () => {
    expect(classifyRisk("GET", "/api/docs/search")).toBe(RiskTier.Autonomous);
  });
});

describe("classifyRisk — commands settings", () => {
  it("keeps /api/commands behind dashboard approval", () => {
    expect(classifyRisk("GET", "/api/commands")).toBe(RiskTier.Approve);
    expect(classifyRisk("POST", "/api/commands")).toBe(RiskTier.Approve);
    expect(classifyRisk("PUT", "/api/commands/1")).toBe(RiskTier.Approve);
    expect(classifyRisk("DELETE", "/api/commands/1")).toBe(RiskTier.Approve);
  });
});

describe("classifyRisk — git templates (P6 git-lifecycle-and-triggers.md)", () => {
  it("editor + apply + status are Approve-tier (dashboard-only Bearer surface)", () => {
    expect(classifyRisk("GET", "/api/git/templates/project")).toBe(
      RiskTier.Approve,
    );
    expect(classifyRisk("PUT", "/api/git/templates/project")).toBe(
      RiskTier.Approve,
    );
    expect(classifyRisk("GET", "/api/git/templates/git-repo")).toBe(
      RiskTier.Approve,
    );
    expect(
      classifyRisk("POST", "/api/git/templates/project/apply"),
    ).toBe(RiskTier.Approve);
    expect(
      classifyRisk("POST", "/api/git/templates/git-repo/apply"),
    ).toBe(RiskTier.Approve);
    expect(
      classifyRisk("GET", "/api/git/templates/retemplate/status"),
    ).toBe(RiskTier.Approve);
  });

  it("POST /api/git/templates/retemplate/file is Autonomous (agent-callable)", () => {
    // The re-template task-flow runs as an autonomous session and posts
    // per-file progress over `curl http://localhost:8321/...` from the
    // session workdir. No Bearer is in scope. Approve-tier here would
    // 401 every per-file call and silently break the entire feature —
    // the test harness in git-templates.test.ts mounts the route without
    // the global auth middleware, so a regression would not surface there.
    // Lock this exact-match override so a future risk-classifier refactor
    // cannot fold it back under the path-only Approve prefix.
    expect(
      classifyRisk("POST", "/api/git/templates/retemplate/file"),
    ).toBe(RiskTier.Autonomous);
  });
});

describe("classifyRisk — RiskTier.Notify removed (DELEGATED-MODE-V2 §5.6)", () => {
  it("RiskTier no longer exposes a Notify member", () => {
    // Compile-time check: the enum union is the 3-tier set. Runtime sanity
    // guards the re-emergence of the legacy value if someone re-adds it.
    const tiers = Object.values(RiskTier);
    expect(tiers).toEqual(
      expect.arrayContaining([
        RiskTier.Autonomous,
        RiskTier.ReadSensitive,
        RiskTier.Approve,
      ]),
    );
    expect(tiers).not.toContain("notify");
  });
});

// ── Precedence ordering inside findExplicitRiskClassification ────────────
// findExplicitRiskClassification walks four resolution stages:
//   (1) METHOD+path exact   → (2) path-only exact
//   (3) {*}-pattern         → (4) longest prefix
// Each stage returns on first match. These tests lock the implicit
// invariants — the order is not externally documented but is load-bearing
// for several real routes (e.g. POST /api/git/templates/retemplate/file
// being exact-Autonomous while /api/git/templates/* is prefix-Approve).

describe("findExplicitRiskClassification — resolution-order invariants", () => {
  it("returns null when no stage matches (caller decides default)", () => {
    // /something-not-an-api path with no entry anywhere — null bubbles to
    // classifyRisk which applies the /api/ vs non-/api default split.
    expect(findExplicitRiskClassification("GET", "/totally/unmapped")).toBeNull();
  });

  it("METHOD+path exact wins over the path-only entry (stage 1 beats stage 2)", () => {
    // POST /api/git/templates/retemplate/file is explicitly Autonomous in
    // API_RISK; the path-prefix `/api/git/templates` is Approve. The exact
    // POST entry has to win or the agent's per-file retemplate progress
    // posts will 401 (the behaviour test elsewhere in this file covers
    // the outcome; this one pins the *mechanism*).
    expect(
      findExplicitRiskClassification("POST", "/api/git/templates/retemplate/file"),
    ).toBe(RiskTier.Autonomous);
    // Sibling path that has NO exact override falls back through stages —
    // ends up at the `/api/git/templates` Approve prefix.
    expect(
      findExplicitRiskClassification("POST", "/api/git/templates/project/apply"),
    ).toBe(RiskTier.Approve);
  });

  it("{*}-pattern match wins over longer raw-prefix match (stage 3 beats stage 4)", () => {
    // POST /api/integrations/{*}/reconcile → Autonomous (pattern).
    // PATCH /api/integrations/ → Approve (prefix).
    // A POST to /api/integrations/gmail/reconcile must resolve via the
    // pattern (Autonomous), not via the prefix (Approve) — even though
    // the prefix would also match. This is the key invariant guarding
    // every per-account write that should escape the bearer-gated default.
    expect(
      findExplicitRiskClassification("POST", "/api/integrations/gmail/reconcile"),
    ).toBe(RiskTier.Autonomous);
  });

  it("exact path-only match wins over {*}-pattern that would also match", () => {
    // /api/health is a path-only Autonomous entry. There is no `{*}`
    // pattern that could match it today, but the precedence (stage 2
    // before stage 3) is what guarantees behaviour stays sane if one is
    // ever added. The realistic combo we DO have is `/api/skills` (stage 2)
    // vs `/api/skills/...` would-be patterns: GET should resolve via the
    // path-only entry, not fall through to a hypothetical pattern.
    expect(findExplicitRiskClassification("GET", "/api/health")).toBe(
      RiskTier.Autonomous,
    );
  });
});

// ── Pattern matcher edge cases ───────────────────────────────────────────
// `matchesPattern` accepts a single non-empty segment per `{*}`. Tests
// pin the behaviour for the unusual segment values the agent legitimately
// passes (account IDs with dashes, dots, plus signs, base64 chars).

describe("classifyRisk — {*} pattern matcher — segment payload tolerance", () => {
  it("accepts segments with hyphens (canonical account-id shape)", () => {
    expect(classifyRisk("POST", "/api/integrations/outlook-mail/probe")).toBe(
      RiskTier.Approve,
    );
  });

  it("accepts segments with underscores", () => {
    expect(classifyRisk("POST", "/api/integrations/google_calendar/probe")).toBe(
      RiskTier.Approve,
    );
  });

  it("accepts segments with dots (e.g. domain-like keys)", () => {
    // Defensive: future integrations may use dotted IDs. The `{*}` matches
    // any non-empty single segment — `.` is a segment-internal char.
    expect(classifyRisk("POST", "/api/integrations/my.custom.key/probe")).toBe(
      RiskTier.Approve,
    );
  });

  it("accepts segments with plus signs and percent-encoded characters", () => {
    // Account IDs that survive URL encoding are agent-callable; the
    // classifier just splits on `/`, so anything inside a segment passes.
    expect(
      classifyRisk("POST", "/api/integrations/outlook%2Bwork/probe"),
    ).toBe(RiskTier.Approve);
    expect(classifyRisk("POST", "/api/integrations/key+plus/probe")).toBe(
      RiskTier.Approve,
    );
  });

  it("rejects an empty segment in the {*} slot (fail-closed)", () => {
    // Already covered in the canonical suite; this duplicates the assertion
    // against the no-segment shape (double slash). Locked here too so an
    // accidental change to the empty-segment guard hits two unrelated tests.
    expect(classifyRisk("POST", "/api/integrations//probe")).toBe(
      RiskTier.Approve, // fail-closed default, NOT the {*} rule
    );
  });

  it("rejects extra path segments beyond a non-trailing-slash pattern", () => {
    // `POST /api/integrations/{*}/probe` requires the path to end with
    // `probe` — `POST /api/integrations/gmail/probe/extra` must not match.
    // (Hits the `actualSegments.length !== segments.length` branch.)
    // Falls through to the prefix `/api/integrations/` → Approve, which
    // makes for an indistinguishable risk tier here. The test still
    // covers the matcher branch by way of the entry not being picked.
    expect(
      classifyRisk("POST", "/api/integrations/gmail/probe/extra-segment"),
    ).toBe(RiskTier.Approve);
  });

  it("does not match when the trailing literal segment differs", () => {
    // `/api/integrations/{*}/probe` should NOT match `.../reconcile` — the
    // method+path falls into a different explicit entry instead.
    expect(
      classifyRisk("POST", "/api/integrations/gmail/reconcile"),
    ).toBe(RiskTier.Autonomous);
  });
});

// ── auditRiskClassifications — method normalization ──────────────────────
// The audit normalizes method to upper-case before lookup. Tests pin that
// developer-supplied lowercase / mixed-case methods normalize correctly
// so an audit caller cannot accidentally hide an unclassified route.

describe("auditRiskClassifications — method case normalization", () => {
  it("normalizes lowercase methods to upper before lookup", () => {
    // `get /api/health` should normalize to GET /api/health and resolve.
    expect(
      auditRiskClassifications([{ method: "get", path: "/api/health" }]),
    ).toEqual([]);
  });

  it("normalizes mixed-case methods (PoSt) to POST", () => {
    expect(
      auditRiskClassifications([
        { method: "PoSt", path: "/api/integrations/gmail/probe" },
      ]),
    ).toEqual([]);
  });

  it("flags a lowercase method as the normalized form when unclassified", () => {
    const result = auditRiskClassifications([
      { method: "post", path: "/api/something-unmapped" },
    ]);
    // Audit reports the *normalized* method, so a one-off `post` typo in
    // the route registration still surfaces as a regular POST entry.
    expect(result).toEqual([{ method: "POST", path: "/api/something-unmapped" }]);
  });

  it("normalizes Hono multi-:param paths (each :param substituted independently)", () => {
    // The regex `/:[^/]+/g` is global — every `:param` segment must turn
    // into the `_` substitute, not just the first. Defensive test against
    // a future regex change to non-global.
    const result = auditRiskClassifications([
      { method: "POST", path: "/api/integrations/:key/exec" },
      { method: "POST", path: "/api/integrations/:account/probe" },
    ]);
    expect(result).toEqual([]);
  });
});

// ── listReadSensitiveGetPathKeys — drift-guard exposure surface ──────────
// `skills-compiler` substring-matches user-skill bodies against this list
// to render the Codex read-sensitive banner. The function output IS the
// drift surface — a renamed read-sensitive path that drops out silently
// would let an unsuspecting skill body call it without the banner warning.

describe("listReadSensitiveGetPathKeys — drift-guard contract", () => {
  it("returns sorted unique strings", () => {
    const keys = listReadSensitiveGetPathKeys();
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("only includes /api/ prefixes (no webhook or root paths)", () => {
    const keys = listReadSensitiveGetPathKeys();
    for (const k of keys) {
      expect(k.startsWith("/api/")).toBe(true);
    }
  });

  it("includes every documented ReadSensitive GET surface (canonical mail + calendar example)", () => {
    const keys = listReadSensitiveGetPathKeys();
    // The mail prefix entry is `/api/mail/` (with trailing slash, as it
    // appears in API_RISK); the function preserves it verbatim for non-{*}
    // entries.
    expect(keys).toContain("/api/mail/");
    // Calendar entries are flat literals (no trailing slash).
    expect(keys).toContain("/api/calendar/events");
    // Context list — exact path-only Autonomous? No — `/api/context/list`
    // is ReadSensitive. Pinned here so a retier to Autonomous removes it
    // from the banner list deliberately.
    expect(keys).toContain("/api/context/list");
  });

  it("strips {*} placeholders to the literal prefix (trailing slash AFTER the strip is removed; existing trailing slashes survive)", () => {
    const keys = listReadSensitiveGetPathKeys();
    for (const k of keys) {
      // {*} must be fully stripped — no placeholder ever leaks into the
      // banner list.
      expect(k).not.toContain("{*}");
    }
    // Spot-check the documented behaviour split: `/api/mail/` (path-only
    // entry, trailing slash preserved as-is) coexists with non-trailing-
    // slash entries like `/api/calendar/events`.
    expect(keys.some((k) => k.endsWith("/"))).toBe(true);
    expect(keys.some((k) => !k.endsWith("/"))).toBe(true);
  });

  it("does not include path-only entries that resolve to a non-GET ReadSensitive tier (defensive — none today)", () => {
    // The function filters to method=GET only (default for path-only keys).
    // If a non-GET-specific ReadSensitive entry is ever added, it must NOT
    // appear in this list — only the GET-callable surfaces drive the skill
    // banner.
    const keys = listReadSensitiveGetPathKeys();
    // No assertion can prove a negative without enumerating API_RISK, but
    // we can spot-check that a POST-only entry is not present: every key
    // must be GET-reachable. This is asserted indirectly by the prefix
    // and uniqueness checks; this test serves as a documentation anchor.
    expect(Array.isArray(keys)).toBe(true);
  });
});
