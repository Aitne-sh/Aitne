import { describe, expect, it } from "vitest";
import { aggregateAlerts, type AlertInputs } from "./alerts.js";

const NOW = new Date("2026-05-01T12:00:00Z");

function baseInputs(overrides: Partial<AlertInputs> = {}): AlertInputs {
  return {
    now: NOW,
    degradedMode: null,
    missingContextFiles: [],
    mailAccounts: [],
    gmailDelegated: false,
    templatesPending: [],
    skillConflicts: [],
    builtInCommandNames: [],
    userCommands: [],
    backends: [],
    todayCostUsd: 0,
    monthCostUsd: 0,
    dailyCapUsd: null,
    monthlyCapUsd: null,
    googleConfigured: false,
    googleConnected: false,
    delegationUpgradeAvailable: false,
    ...overrides,
  };
}

describe("aggregateAlerts", () => {
  it("returns empty array when nothing is wrong", () => {
    expect(aggregateAlerts(baseInputs())).toEqual([]);
  });

  it("emits a non-dismissable error for degraded mode", () => {
    const alerts = aggregateAlerts(
      baseInputs({
        degradedMode: {
          reason: "primary_vault_unreachable",
          path: "/Users/test/vault",
          since: "2026-04-30T08:00:00Z",
        },
      }),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      id: "system.degraded",
      severity: "error",
      dismissable: false,
      source: "system",
      detectedAt: "2026-04-30T08:00:00Z",
      // Vault path config lives on the top-level settings page.
      // /health is body-health, not system diagnostics.
      href: "/settings",
    });
    expect(alerts[0].fingerprint).toContain("primary_vault_unreachable");
  });

  it("emits a single context-files error listing the missing paths", () => {
    const alerts = aggregateAlerts(
      baseInputs({
        missingContextFiles: ["today.md", "roadmap.md", "user.md", "rules.md"],
      }),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      id: "system.context.missing",
      severity: "error",
      dismissable: false,
      // Recovery action is "Reinstall context" under /settings/danger-zone.
      href: "/settings/danger-zone",
    });
    expect(alerts[0].title).toContain("4 context files");
    expect(alerts[0].description).toContain("and 1 more");
    // Sorted fingerprint so re-orderings don't re-fire dismissal.
    expect(alerts[0].fingerprint).toBe("roadmap.md|rules.md|today.md|user.md");
  });

  it("emits one alert per non-healthy mail account", () => {
    const alerts = aggregateAlerts(
      baseInputs({
        mailAccounts: [
          {
            id: "a1",
            kind: "outlook",
            email: "x@example.com",
            authStatus: "requires_consent",
            active: true,
          },
          {
            id: "a2",
            kind: "icloud",
            email: "y@example.com",
            authStatus: "degraded",
            active: true,
          },
          {
            id: "a3",
            kind: "gmail",
            email: "ok@example.com",
            authStatus: "healthy",
            active: true,
          },
          {
            id: "a4",
            kind: "yahoo",
            email: "off@example.com",
            authStatus: "requires_consent",
            active: false,
          },
        ],
      }),
    );
    expect(alerts).toHaveLength(2);
    const reconsent = alerts.find((a) => a.id.includes("a1"));
    const degraded = alerts.find((a) => a.id.includes("a2"));
    expect(reconsent).toMatchObject({ severity: "error", dismissable: false });
    expect(degraded).toMatchObject({ severity: "warning", dismissable: true });
  });

  it("filters Gmail attention rows when Gmail is delegated", () => {
    const alerts = aggregateAlerts(
      baseInputs({
        gmailDelegated: true,
        mailAccounts: [
          {
            id: "g1",
            kind: "gmail",
            email: "g@example.com",
            authStatus: "requires_consent",
            active: true,
          },
          {
            id: "o1",
            kind: "outlook",
            email: "o@example.com",
            authStatus: "requires_consent",
            active: true,
          },
        ],
      }),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].id).toContain("o1");
  });

  it("flags command conflicts as warnings with a stable fingerprint", () => {
    const alerts = aggregateAlerts(
      baseInputs({
        builtInCommandNames: ["!stop", "!start", "!deploy"],
        userCommands: [
          { id: 7, name: "deploy", command: "!deploy" },
          { id: 9, name: "review", command: "!review" },
        ],
      }),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      id: "config.command.conflicts",
      severity: "warning",
      dismissable: true,
      source: "config",
    });
    expect(alerts[0].title).toContain("1 custom command");
    expect(alerts[0].fingerprint).toBe("7:!deploy");
  });

  it("flags user skills shadowed by newly shipped built-ins", () => {
    const alerts = aggregateAlerts(
      baseInputs({
        skillConflicts: ["research", "travel"],
      }),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      id: "config.skills.conflicts",
      severity: "warning",
      href: "/knowledge?tab=skills",
      dismissable: true,
    });
    expect(alerts[0].description).toContain("Built-in skills take precedence");
  });

  it("collapses long skill conflict lists into a `, and N more` tail", () => {
    // Pin the `count > 3` truncation branch in detectSkillConflicts.
    const alerts = aggregateAlerts(
      baseInputs({
        skillConflicts: ["alpha", "beta", "gamma", "delta", "epsilon"],
      }),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].title).toContain("5 user skills conflict");
    expect(alerts[0].description).toContain("and 2 more");
    // Sample is alphabetically sorted to keep the description stable
    // across re-orders of skillConflicts.
    expect(alerts[0].description).toContain("alpha, beta, delta");
  });

  it("collapses long command conflict lists into a `, and N more` tail", () => {
    // Pin the `count > 3` truncation branch in detectCommandConflicts.
    const alerts = aggregateAlerts(
      baseInputs({
        builtInCommandNames: ["!a", "!b", "!c", "!d", "!e"],
        userCommands: [
          { id: 1, name: "a", command: "!a" },
          { id: 2, name: "b", command: "!b" },
          { id: 3, name: "c", command: "!c" },
          { id: 4, name: "d", command: "!d" },
          { id: 5, name: "e", command: "!e" },
        ],
      }),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].title).toContain("5 custom commands");
    expect(alerts[0].description).toContain("and 2 more");
  });

  it("emits backend auth errors only for enabled backends with broken status", () => {
    const alerts = aggregateAlerts(
      baseInputs({
        backends: [
          { id: "claude", enabled: true, authStatus: "ok", lastError: null, cliInstalled: true },
          { id: "codex", enabled: true, authStatus: "expired", lastError: "token revoked", cliInstalled: true },
          { id: "gemini", enabled: false, authStatus: "missing", lastError: null, cliInstalled: true },
          { id: "claude2", enabled: true, authStatus: "ok", lastError: null, cliInstalled: false },
        ],
      }),
    );
    const ids = alerts.map((a) => a.id).sort();
    expect(ids).toEqual(["auth.claude2.cli_missing", "auth.codex.expired"]);
    for (const a of alerts) {
      expect(a.severity).toBe("error");
      expect(a.dismissable).toBe(false);
    }
  });

  it("falls back to a re-authenticate prompt when a broken backend has no lastError detail", () => {
    // Distinct from the prior test: when authStatus is broken (missing /
    // expired / error) but the probe never captured a `lastError` string,
    // the alert description switches from "Last error: ..." to the generic
    // re-authenticate prompt. Pinning this branch keeps the description
    // copy in sync with the dashboard's expectations and prevents a
    // future "undefined" leak via `${lastError}` interpolation.
    const alerts = aggregateAlerts(
      baseInputs({
        backends: [
          { id: "codex", enabled: true, authStatus: "missing", lastError: null, cliInstalled: true },
        ],
      }),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      id: "auth.codex.missing",
      severity: "error",
      description: "Re-authenticate to resume sessions on this backend.",
      dismissable: false,
    });
  });

  it("escalates the daily cost cap from warning at 80% to error at 100%", () => {
    const warn = aggregateAlerts(
      baseInputs({ todayCostUsd: 4, dailyCapUsd: 5 }),
    );
    expect(warn).toHaveLength(1);
    expect(warn[0]).toMatchObject({
      id: "cost.daily_cap",
      severity: "warning",
      dismissable: true,
    });

    const err = aggregateAlerts(baseInputs({ todayCostUsd: 5.5, dailyCapUsd: 5 }));
    expect(err).toHaveLength(1);
    expect(err[0]).toMatchObject({
      id: "cost.daily_cap",
      severity: "error",
      dismissable: false,
    });
    expect(err[0].fingerprint).toBe("daily:exceeded");
  });

  it("ignores the cost detector when no cap is set", () => {
    const alerts = aggregateAlerts(baseInputs({ todayCostUsd: 100 }));
    expect(alerts).toEqual([]);
  });

  it("emits monthly cap independently of the daily cap", () => {
    const alerts = aggregateAlerts(
      baseInputs({
        monthCostUsd: 95,
        monthlyCapUsd: 100,
      }),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].id).toBe("cost.monthly_cap");
    expect(alerts[0].severity).toBe("warning");
  });

  it("emits a Monthly-titled error alert when the monthly cap is reached", () => {
    // Pin the `scope === "daily" ? "Daily" : "Monthly"` ternary in
    // detectCostCap. The monthly-error path requires ratio >= 1
    // against monthlyCapUsd, separate from the daily error path
    // already covered above.
    const alerts = aggregateAlerts(
      baseInputs({ monthCostUsd: 200, monthlyCapUsd: 100 }),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      id: "cost.monthly_cap",
      severity: "error",
      dismissable: false,
    });
    expect(alerts[0].title).toBe("Monthly cost cap reached");
    // Monthly-error description must NOT carry the "autonomous sessions"
    // sentence — that messaging belongs to the daily branch only.
    expect(alerts[0].description).not.toContain("Autonomous sessions");
  });

  it("returns no cost-cap alert when the spend value is NaN (defensive)", () => {
    // Pin the `Number.isNaN(spend)` early-return in detectCostCap.
    // Cost aggregation upstream can briefly surface NaN if a cost
    // row is malformed; the alert layer must not propagate that as
    // an Infinity ratio.
    const alerts = aggregateAlerts(
      baseInputs({ todayCostUsd: Number.NaN, dailyCapUsd: 5 }),
    );
    expect(alerts.find((a) => a.id === "cost.daily_cap")).toBeUndefined();
  });

  it("buckets cost-cap fingerprints by 5% so small spend bumps don't re-fire dismissal", () => {
    const a = aggregateAlerts(baseInputs({ todayCostUsd: 4.05, dailyCapUsd: 5 }));
    const b = aggregateAlerts(baseInputs({ todayCostUsd: 4.1, dailyCapUsd: 5 }));
    expect(a[0].fingerprint).toBe(b[0].fingerprint);
  });

  it("only emits the gcal info nudge when configured but not connected", () => {
    expect(
      aggregateAlerts(
        baseInputs({ googleConfigured: false, googleConnected: false }),
      ),
    ).toEqual([]);
    expect(
      aggregateAlerts(
        baseInputs({ googleConfigured: true, googleConnected: true }),
      ),
    ).toEqual([]);
    const alerts = aggregateAlerts(
      baseInputs({ googleConfigured: true, googleConnected: false }),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].id).toBe("setup.gcal");
  });

  it("emits the delegation-upgrade info nudge when at least one Google integration is direct", () => {
    const alerts = aggregateAlerts(
      baseInputs({ delegationUpgradeAvailable: true }),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      id: "setup.delegation_upgrade",
      severity: "info",
      dismissable: true,
    });
  });

  it("orders alerts error → warning → info, then by detectedAt desc", () => {
    const alerts = aggregateAlerts(
      baseInputs({
        degradedMode: {
          reason: "primary_vault_unreachable",
          path: null,
          since: "2026-04-29T00:00:00Z",
        },
        missingContextFiles: ["today.md"],
        templatesPending: [{ path: "today.md", from: 1, to: 2 }],
        delegationUpgradeAvailable: true,
      }),
    );
    const severities = alerts.map((a) => a.severity);
    expect(severities).toEqual(["error", "error", "warning", "info"]);
  });

  it("uses singular 'skill' when exactly one skill conflict is present", () => {
    // Pins the `count === 1 ? "" : "s"` true branch in detectSkillConflicts.
    const alerts = aggregateAlerts(
      baseInputs({ skillConflicts: ["research"] }),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].title).toBe("1 user skill conflict with built-ins");
  });

  it("emits no cost-cap alert when spend is below the 80% warning threshold", () => {
    // Pins the `ratio < COST_WARN_THRESHOLD` true branch in detectCostCap.
    // Spend at 50% of cap is below the 0.8 threshold and must produce no alert.
    const alerts = aggregateAlerts(
      baseInputs({ todayCostUsd: 2, dailyCapUsd: 5 }),
    );
    expect(alerts.find((a) => a.id === "cost.daily_cap")).toBeUndefined();
  });

  it("emits one alert per pending template upgrade summary", () => {
    const alerts = aggregateAlerts(
      baseInputs({
        templatesPending: [
          { path: "policies/journal-format.md", from: 1, to: 2 },
          { path: "policies/journal-export.md", from: 1, to: 3 },
        ],
      }),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      id: "config.templates.pending",
      severity: "warning",
      dismissable: true,
      // Acceptance path: "Reinstall context" under /settings/danger-zone.
      href: "/settings/danger-zone",
    });
    expect(alerts[0].title).toContain("2 template upgrades");
  });
});
