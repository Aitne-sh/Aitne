import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { applySchema } from "../db/schema.js";
import {
  checkConditionalNotifyLoad,
  checkCronAuditFreshness,
  checkEveningReviewTokenEnvelope,
  checkNotifyInvocations30d,
  expectedDaySet,
  inspectRulebook,
  readInstallAgeDays,
  resolveContextDirFromDb,
  runEveningReviewSlimdownChecks,
} from "./evening-review-verify.js";
import { homedir } from "node:os";

// ─────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────

let db: Database.Database;
let workspace: string;
let contextDir: string;

beforeEach(() => {
  db = new Database(":memory:");
  applySchema(db);
  workspace = mkdtempSync(join(tmpdir(), "evening-review-verify-"));
  contextDir = join(workspace, "context");
  mkdirSync(join(contextDir, "policies", "routines"), { recursive: true });
});

afterEach(() => {
  db.close();
  rmSync(workspace, { recursive: true, force: true });
});

function insertAction(
  overrides: {
    actionType?: string;
    result?: string;
    startedAt?: string;
    completedAt?: string | null;
    costUsd?: number;
    tokensInput?: number;
    tokensOutput?: number;
    cacheReadTokens?: number;
    numTurns?: number;
    error?: string | null;
  } = {},
): number {
  const r = db
    .prepare(
      `INSERT INTO agent_actions
        (event_id, action_type, trigger, model_used, cost_usd,
         tokens_input, tokens_output, cache_read_tokens, num_turns,
         result, started_at, completed_at, error)
       VALUES ('e', ?, 'autonomous', 'claude-test', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      overrides.actionType ?? "routine.evening_review",
      overrides.costUsd ?? 0.1,
      overrides.tokensInput ?? 5000,
      overrides.tokensOutput ?? 500,
      overrides.cacheReadTokens ?? 0,
      overrides.numTurns ?? 8,
      overrides.result ?? "success",
      overrides.startedAt ?? "2026-05-14 17:45:00",
      overrides.completedAt === undefined
        ? "2026-05-14 17:45:30"
        : overrides.completedAt,
      overrides.error ?? null,
    );
  return Number(r.lastInsertRowid);
}

function insertNotification(createdAt: string): void {
  db.prepare(
    `INSERT INTO notification_log (dispatch_id, notification_type, priority, platform, content_summary, created_at)
     VALUES (?, 'agent', 'normal', 'slack', 'msg', ?)`,
  ).run(`d-${createdAt}`, createdAt);
}

function writeRulebook(body: string): string {
  const p = join(contextDir, "policies/routines/evening.md");
  writeFileSync(p, body, "utf-8");
  return p;
}

// ─────────────────────────────────────────────────────────────────────────
// inspectRulebook
// ─────────────────────────────────────────────────────────────────────────

describe("inspectRulebook", () => {
  it("returns absent when file does not exist", () => {
    const result = inspectRulebook(contextDir);
    expect(result.state).toBe("absent");
    expect(result.predicateActive).toBe(false);
    expect(result.headingCount).toBe(0);
  });

  it("returns empty for whitespace-only file", () => {
    writeRulebook("   \n\n   ");
    expect(inspectRulebook(contextDir)).toEqual({
      state: "empty",
      predicateActive: false,
      headingCount: 0,
    });
  });

  it("returns no_headings when no `### ` lines exist", () => {
    writeRulebook("# Top\nSome prose without rule headings.\n## H2 only");
    const result = inspectRulebook(contextDir);
    expect(result.state).toBe("no_headings");
    expect(result.predicateActive).toBe(false);
    expect(result.headingCount).toBe(0);
  });

  it("returns active and counts headings when one or more `### ` lines exist", () => {
    writeRulebook("# Top\n### Rule one\nbody\n### Rule two\n more\n");
    const result = inspectRulebook(contextDir);
    expect(result.state).toBe("active");
    expect(result.predicateActive).toBe(true);
    expect(result.headingCount).toBe(2);
  });

  it("returns unreadable with predicateActive null when chmod 000 blocks read", () => {
    if (process.platform === "win32") return; // chmod a no-op on Windows
    const p = writeRulebook("### rule\nbody");
    chmodSync(p, 0o000);
    try {
      const result = inspectRulebook(contextDir);
      expect(result.state).toBe("unreadable");
      expect(result.predicateActive).toBeNull();
    } finally {
      chmodSync(p, 0o644);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// expectedDaySet
// ─────────────────────────────────────────────────────────────────────────

describe("expectedDaySet", () => {
  it("returns N consecutive YYYY-MM-DD strings ending at `now`", () => {
    const days = expectedDaySet(new Date(2026, 4, 14), 3);
    expect(days).toEqual(["2026-05-12", "2026-05-13", "2026-05-14"]);
  });

  it("returns just today when windowDays = 1", () => {
    const days = expectedDaySet(new Date(2026, 0, 1), 1);
    expect(days).toEqual(["2026-01-01"]);
  });

  it("zero-pads single-digit month / day correctly", () => {
    const days = expectedDaySet(new Date(2026, 0, 5), 2);
    expect(days).toEqual(["2026-01-04", "2026-01-05"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// readInstallAgeDays
// ─────────────────────────────────────────────────────────────────────────

describe("readInstallAgeDays", () => {
  it("returns 1 when agent_actions is empty", () => {
    expect(readInstallAgeDays(db)).toBe(1);
  });

  it("returns floor(age) + 1 capped at 365 when rows exist", () => {
    insertAction({ startedAt: "2024-01-01 00:00:00" });
    const age = readInstallAgeDays(db);
    expect(age).toBe(365);
  });

  it("returns 1 when oldest row is less than a day ago", () => {
    insertAction({ startedAt: new Date(Date.now() - 5 * 60_000).toISOString().slice(0, 19).replace("T", " ") });
    expect(readInstallAgeDays(db)).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// checkCronAuditFreshness
// ─────────────────────────────────────────────────────────────────────────

describe("checkCronAuditFreshness", () => {
  const now = new Date("2026-05-14T20:00:00Z");

  it("warns on a fresh install (≤1d) when no rows exist", () => {
    const result = checkCronAuditFreshness(db, {
      windowDays: 7,
      installAgeDays: 1,
      now,
    });
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("fresh install");
    expect(result.data.daysWithRow).toBe(0);
  });

  it("fails on an established install (>1d) when no rows exist", () => {
    const result = checkCronAuditFreshness(db, {
      windowDays: 7,
      installAgeDays: 30,
      now,
    });
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("No 'roadmap_mechanical_maintenance'");
  });

  it("fails when any rows ended with result='failed'", () => {
    // Use a recent timestamp so the row falls inside the SQL window
    // (`started_at >= datetime('now', '-1 days')`). The test's `now`
    // override only affects expectedDaySet's host-clock arithmetic;
    // the WHERE clause uses SQLite's own `now`.
    insertAction({
      actionType: "roadmap_mechanical_maintenance",
      result: "failed",
      startedAt: nowAgoSqlDt(2 * 3600),
      error: "boom",
    });
    const result = checkCronAuditFreshness(db, {
      windowDays: 1,
      installAgeDays: 30,
      now: new Date(),
    });
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("ended with result='failed'");
    expect(result.data.failedRows).toBe(1);
  });

  it("warns when some days are missing", () => {
    // `nowAgoSqlDt(0)` emits a UTC-component string; SQLite's
    // `date(., 'localtime')` then resolves to today's local date in
    // every TZ. The pre-fix test built the timestamp from
    // `today.getDate()` + "17:45:00" — interpreted by SQLite as UTC,
    // that flipped to "tomorrow" once converted to local time in any
    // TZ with offset ≥ +07:00 (Asia/Tokyo et al.), so the test only
    // passed in negative-offset TZs.
    const today = new Date();
    insertAction({
      actionType: "roadmap_mechanical_maintenance",
      startedAt: nowAgoSqlDt(0),
    });
    const result = checkCronAuditFreshness(db, {
      windowDays: 3,
      installAgeDays: 30,
      now: today,
    });
    expect(result.status).toBe("warn");
    expect(result.data.daysMissing.length).toBeGreaterThan(0);
    expect(result.data.daysWithRow).toBe(1);
  });

  it("passes when every day in the window is covered", () => {
    // See sibling test above — `nowAgoSqlDt(0)` for TZ-stable today.
    const today = new Date();
    insertAction({
      actionType: "roadmap_mechanical_maintenance",
      startedAt: nowAgoSqlDt(0),
    });
    const result = checkCronAuditFreshness(db, {
      windowDays: 1,
      installAgeDays: 30,
      now: today,
    });
    expect(result.status).toBe("pass");
    expect(result.data.daysWithRow).toBe(1);
    expect(result.data.daysMissing).toEqual([]);
  });

  it("clamps expectedDays to install age", () => {
    const result = checkCronAuditFreshness(db, {
      windowDays: 30,
      installAgeDays: 2,
      now,
    });
    expect(result.data.windowDays).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// checkEveningReviewTokenEnvelope
// ─────────────────────────────────────────────────────────────────────────

describe("checkEveningReviewTokenEnvelope", () => {
  it("warns when no successful runs exist in the window", () => {
    const result = checkEveningReviewTokenEnvelope(db, { windowDays: 7 });
    expect(result.status).toBe("warn");
    expect(result.data.sessions).toBe(0);
  });

  it("passes when sessions are inside the envelope (cost + turns < 50% of cap)", () => {
    insertAction({ costUsd: 0.05, numTurns: 6, startedAt: nowAgoSqlDt(2 * 3600) });
    insertAction({ costUsd: 0.06, numTurns: 8, startedAt: nowAgoSqlDt(1 * 3600) });
    const result = checkEveningReviewTokenEnvelope(db, { windowDays: 7 });
    expect(result.status).toBe("pass");
    expect(result.data.sessions).toBe(2);
    expect(result.detail).toContain("Within envelope");
  });

  it("warns when avg cost ≥ 50% of envelope budget", () => {
    insertAction({ costUsd: 1.5, numTurns: 8, startedAt: nowAgoSqlDt(3600) });
    const result = checkEveningReviewTokenEnvelope(db, { windowDays: 7 });
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("avg cost");
  });

  it("warns when avg turns ≥ 50% of turn cap", () => {
    insertAction({ costUsd: 0.05, numTurns: 30, startedAt: nowAgoSqlDt(3600) });
    const result = checkEveningReviewTokenEnvelope(db, { windowDays: 7 });
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("avg turns");
  });

  it("includes input/output token formatting in the detail line", () => {
    insertAction({
      tokensInput: 12_000,
      tokensOutput: 800,
      costUsd: 0.05,
      numTurns: 6,
      startedAt: nowAgoSqlDt(3600),
    });
    const result = checkEveningReviewTokenEnvelope(db, { windowDays: 7 });
    expect(result.detail).toContain("12.0k");
    expect(result.detail).toContain("800");
  });

  it("renders '—' when token / turn columns are NULL across all rows in the window", () => {
    db.prepare(
      `INSERT INTO agent_actions
        (event_id, action_type, trigger, model_used, cost_usd,
         tokens_input, tokens_output, num_turns, result, started_at, completed_at)
       VALUES ('e', 'routine.evening_review', 'autonomous', 'm', 0.05,
               NULL, NULL, NULL, 'success', ?, ?)`,
    ).run(nowAgoSqlDt(3600), nowAgoSqlDt(3600 - 30));
    const result = checkEveningReviewTokenEnvelope(db, { windowDays: 7 });
    expect(result.status).toBe("pass");
    // formatTokens(null) → "—" + avgNumTurns ?? "—" both exercised here
    expect(result.detail).toContain("avg input —");
    expect(result.detail).toContain("output —");
    expect(result.detail).toContain("/ — turn(s)");
    expect(result.data.avgInputTokens).toBeNull();
    expect(result.data.avgOutputTokens).toBeNull();
    expect(result.data.avgNumTurns).toBeNull();
  });

  it("renders sub-1k tokens as a plain integer (no 'k' suffix)", () => {
    insertAction({
      tokensInput: 850,
      tokensOutput: 42,
      costUsd: 0.05,
      numTurns: 6,
      startedAt: nowAgoSqlDt(3600),
    });
    const result = checkEveningReviewTokenEnvelope(db, { windowDays: 7 });
    expect(result.detail).toContain("avg input 850");
    expect(result.detail).toContain("output 42");
    expect(result.detail).not.toContain("k /");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// checkConditionalNotifyLoad
// ─────────────────────────────────────────────────────────────────────────

describe("checkConditionalNotifyLoad", () => {
  it("passes with 5-skill manifest when rulebook is absent", () => {
    const result = checkConditionalNotifyLoad({
      contextDir,
      rulebook: { state: "absent", predicateActive: false, headingCount: 0 },
    });
    expect(result.status).toBe("pass");
    expect(result.data.expectedSkillCount).toBe(5);
    expect(result.data.resolvedManifest).not.toContain("notify");
  });

  it("passes with 6-skill manifest when rulebook is active", () => {
    const result = checkConditionalNotifyLoad({
      contextDir,
      rulebook: { state: "active", predicateActive: true, headingCount: 3 },
    });
    expect(result.status).toBe("pass");
    expect(result.data.expectedSkillCount).toBe(6);
    expect(result.data.resolvedManifest).toContain("notify");
  });

  it("warns with iCloud-specific hint when path looks like an iCloud Obsidian vault", () => {
    const icloudCtx = "/Users/test/Library/Mobile Documents/iCloud~md~obsidian/Documents/vault";
    const result = checkConditionalNotifyLoad({
      contextDir: icloudCtx,
      rulebook: { state: "unreadable", predicateActive: null, headingCount: 0 },
    });
    expect(result.status).toBe("warn");
    expect(result.hint).toContain("iCloud");
    expect(result.hint).toContain("Full Disk Access");
  });

  it("warns with generic permission hint for non-iCloud unreadable paths", () => {
    const result = checkConditionalNotifyLoad({
      contextDir,
      rulebook: { state: "unreadable", predicateActive: null, headingCount: 0 },
    });
    expect(result.status).toBe("warn");
    expect(result.hint).toContain("permissions");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// checkNotifyInvocations30d
// ─────────────────────────────────────────────────────────────────────────

describe("checkNotifyInvocations30d", () => {
  it("warns when no evening_review sessions exist in the window", () => {
    const result = checkNotifyInvocations30d(db, {
      installAgeDays: 30,
      rulebookActive: false,
    });
    expect(result.status).toBe("warn");
    expect(result.data.sessions).toBe(0);
  });

  it("passes with rulebook-inactive note when 0 notify calls", () => {
    insertAction({ startedAt: nowAgoSqlDt(2 * 3600), completedAt: nowAgoSqlDt(2 * 3600 - 60) });
    const result = checkNotifyInvocations30d(db, {
      installAgeDays: 30,
      rulebookActive: false,
    });
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("silent-by-default");
  });

  it("passes with rulebook-active note when 0 notify calls", () => {
    insertAction({ startedAt: nowAgoSqlDt(3600), completedAt: nowAgoSqlDt(3600 - 60) });
    const result = checkNotifyInvocations30d(db, {
      installAgeDays: 30,
      rulebookActive: true,
    });
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("lower bound");
  });

  it("passes with indeterminate note when rulebook state is null and 0 notify calls", () => {
    insertAction({ startedAt: nowAgoSqlDt(3600), completedAt: nowAgoSqlDt(3600 - 60) });
    const result = checkNotifyInvocations30d(db, {
      installAgeDays: 30,
      rulebookActive: null,
    });
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("indeterminate");
  });

  it("warns when rulebook inactive AND notify calls fall inside session window", () => {
    const startedAt = nowAgoSqlDt(2 * 3600);
    const completedAt = nowAgoSqlDt(2 * 3600 - 60);
    insertAction({ startedAt, completedAt });
    insertNotification(nowAgoSqlDt(2 * 3600 - 30));
    const result = checkNotifyInvocations30d(db, {
      installAgeDays: 30,
      rulebookActive: false,
    });
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("rulebook is inactive");
    expect(result.data.totalNotifies).toBe(1);
  });

  it("passes when rulebook active AND notify calls exist (legitimate intent)", () => {
    const startedAt = nowAgoSqlDt(2 * 3600);
    const completedAt = nowAgoSqlDt(2 * 3600 - 60);
    insertAction({ startedAt, completedAt });
    insertNotification(nowAgoSqlDt(2 * 3600 - 30));
    const result = checkNotifyInvocations30d(db, {
      installAgeDays: 30,
      rulebookActive: true,
    });
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("explicit notify intent");
  });

  it("warns inconclusively when rulebook indeterminate AND notify calls exist", () => {
    const startedAt = nowAgoSqlDt(2 * 3600);
    const completedAt = nowAgoSqlDt(2 * 3600 - 60);
    insertAction({ startedAt, completedAt });
    insertNotification(nowAgoSqlDt(2 * 3600 - 30));
    const result = checkNotifyInvocations30d(db, {
      installAgeDays: 30,
      rulebookActive: null,
    });
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("indeterminate");
  });

  it("treats a NULL completed_at as 'started_at + 30 minutes' window", () => {
    const startedAt = nowAgoSqlDt(2 * 3600);
    insertAction({ startedAt, completedAt: null });
    insertNotification(nowAgoSqlDt(2 * 3600 - 60)); // 1 min later → in window
    const result = checkNotifyInvocations30d(db, {
      installAgeDays: 30,
      rulebookActive: false,
    });
    expect(result.status).toBe("warn");
    expect(result.data.totalNotifies).toBe(1);
  });

  it("clamps the window to install age when install age < 30", () => {
    insertAction({ startedAt: nowAgoSqlDt(3600), completedAt: nowAgoSqlDt(3600 - 60) });
    const result = checkNotifyInvocations30d(db, {
      installAgeDays: 5,
      rulebookActive: false,
    });
    expect(result.data.windowDays).toBe(5);
  });

  it("returns up to 5 sample sessions in the data payload", () => {
    for (let i = 1; i <= 7; i++) {
      const started = nowAgoSqlDt(i * 60);
      const completed = nowAgoSqlDt(i * 60 - 1);
      insertAction({ startedAt: started, completedAt: completed });
      insertNotification(nowAgoSqlDt(i * 60 - 1)); // notify inside each window
    }
    const result = checkNotifyInvocations30d(db, {
      installAgeDays: 30,
      rulebookActive: false,
    });
    expect(result.data.samples.length).toBe(5);
    expect(result.data.sessionsWithNotify).toBe(7);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// runEveningReviewSlimdownChecks (integration)
// ─────────────────────────────────────────────────────────────────────────

describe("runEveningReviewSlimdownChecks", () => {
  it("returns four checks and a populated summary", () => {
    const report = runEveningReviewSlimdownChecks({
      db,
      contextDir,
      now: () => new Date("2026-05-14T20:00:00Z"),
    });
    expect(report.checks).toHaveLength(4);
    expect(report.summary.total).toBe(4);
    expect(report.summary.passed + report.summary.warned + report.summary.failed).toBe(4);
    expect(report.summary.windowDays).toBe(7);
    expect(report.summary.installAgeDays).toBe(1);
    expect(report.summary.generatedAt).toBe("2026-05-14T20:00:00.000Z");
  });

  it("uses the live eveningRulebookIsActive predicate (no drift) when rulebook is readable", () => {
    writeRulebook("### Rule one\nbody");
    const report = runEveningReviewSlimdownChecks({
      db,
      contextDir,
      now: () => new Date(),
    });
    const notifyLoad = report.checks.find((c) => c.id === "conditional_notify_load");
    expect(notifyLoad?.data).toMatchObject({
      predicateActive: true,
      expectedSkillCount: 6,
    });
  });

  it("respects the windowDays argument", () => {
    const report = runEveningReviewSlimdownChecks({
      db,
      contextDir,
      windowDays: 14,
    });
    expect(report.summary.windowDays).toBe(14);
  });

  it("uses the default `now` when not injected (hits the production code path)", () => {
    const before = Date.now();
    const report = runEveningReviewSlimdownChecks({ db, contextDir });
    const after = Date.now();
    const generated = new Date(report.summary.generatedAt).getTime();
    expect(generated).toBeGreaterThanOrEqual(before);
    expect(generated).toBeLessThanOrEqual(after);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// resolveContextDirFromDb
// ─────────────────────────────────────────────────────────────────────────

describe("resolveContextDirFromDb", () => {
  const DATA_DIR = "/var/data/aitne";
  const VAULT_PATH = "/Users/op/Documents/MyVault";

  function setSetting(key: string, value: unknown): void {
    db.prepare(
      `INSERT INTO settings (key, value_json) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
    ).run(key, JSON.stringify(value));
  }

  function setDegraded(): void {
    db.prepare(
      `INSERT INTO runtime_state (key, value_json) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
    ).run(
      "management_mode.degraded",
      JSON.stringify({ reason: "unreachable", path: VAULT_PATH, since: "2026-05-15T10:00:00Z" }),
    );
  }

  it("returns <dataDir>/context when vaultMode is plain (default)", () => {
    expect(resolveContextDirFromDb(db, DATA_DIR)).toBe("/var/data/aitne/context");
  });

  it("returns <dataDir>/context when no settings rows exist", () => {
    expect(resolveContextDirFromDb(db, DATA_DIR)).toBe("/var/data/aitne/context");
  });

  it("returns primaryVaultPath in obsidian mode with configured absolute path", () => {
    setSetting("vaultMode", "obsidian");
    setSetting("primaryVaultPath", VAULT_PATH);
    expect(resolveContextDirFromDb(db, DATA_DIR)).toBe(VAULT_PATH);
  });

  it("falls back to <dataDir>/context in obsidian mode when primaryVaultPath is null", () => {
    setSetting("vaultMode", "obsidian");
    setSetting("primaryVaultPath", null);
    expect(resolveContextDirFromDb(db, DATA_DIR)).toBe("/var/data/aitne/context");
  });

  it("falls back to <dataDir>/context in obsidian mode when primaryVaultPath is empty string", () => {
    setSetting("vaultMode", "obsidian");
    setSetting("primaryVaultPath", "");
    expect(resolveContextDirFromDb(db, DATA_DIR)).toBe("/var/data/aitne/context");
  });

  it("falls back to <dataDir>/context when daemon is in degraded mode (mirrors getContextDir's third branch)", () => {
    setSetting("vaultMode", "obsidian");
    setSetting("primaryVaultPath", VAULT_PATH);
    setDegraded();
    expect(resolveContextDirFromDb(db, DATA_DIR)).toBe("/var/data/aitne/context");
  });

  it("ignores degraded marker stored as JSON null (matches isDegraded's `!== null` semantics)", () => {
    setSetting("vaultMode", "obsidian");
    setSetting("primaryVaultPath", VAULT_PATH);
    db.prepare(
      `INSERT INTO runtime_state (key, value_json) VALUES (?, ?)`,
    ).run("management_mode.degraded", "null");
    expect(resolveContextDirFromDb(db, DATA_DIR)).toBe(VAULT_PATH);
  });

  it("ignores degraded marker stored as corrupt JSON (defensive fallback to non-degraded)", () => {
    setSetting("vaultMode", "obsidian");
    setSetting("primaryVaultPath", VAULT_PATH);
    db.prepare(
      `INSERT INTO runtime_state (key, value_json) VALUES (?, ?)`,
    ).run("management_mode.degraded", "{not valid json");
    expect(resolveContextDirFromDb(db, DATA_DIR)).toBe(VAULT_PATH);
  });

  it("expands ~/ in primaryVaultPath the same way normalizeRuntimeSettings does", () => {
    setSetting("vaultMode", "obsidian");
    setSetting("primaryVaultPath", "~/MyVault");
    expect(resolveContextDirFromDb(db, DATA_DIR)).toBe(`${homedir()}/MyVault`);
  });

  it("treats corrupt vaultMode JSON as 'not configured' (falls back to dataDir)", () => {
    db.prepare(
      `INSERT INTO settings (key, value_json) VALUES (?, ?)`,
    ).run("vaultMode", "{not valid");
    setSetting("primaryVaultPath", VAULT_PATH);
    expect(resolveContextDirFromDb(db, DATA_DIR)).toBe("/var/data/aitne/context");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────

/** SQLite-format datetime N seconds before now. */
function nowAgoSqlDt(secondsAgo: number): string {
  const d = new Date(Date.now() - secondsAgo * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
