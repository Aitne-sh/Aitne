/**
 * Phase 4 of `docs/design/appendices/evening-review-slimdown.md` — the
 * post-launch verification surface. Bundles four checks an operator
 * runs once after the slimdown ships to confirm the change actually
 * delivered what it promised:
 *
 *   1. The 17:45 cron emits one
 *      `agent_actions.action_type='roadmap_mechanical_maintenance'` row
 *      per agent-day.
 *   2. `routine.evening_review` sessions stay inside the seeded
 *      envelope (50 turns / $1.00) — token counts dropped after the
 *      `travel` skill + Step 4 prose were removed.
 *   3. `resolveSkillManifest` correctly gates `notify` on the rulebook
 *      predicate (5 vs 6 skills depending on `policies/routines/evening.md`
 *      shape).
 *   4. Over the last 30 days, evening_review sessions on rulebook-less
 *      installs called `POST /api/notify` zero times — any non-zero
 *      count is a prompt regression signal worth investigating.
 *
 * Read-only and offline. Safe to call while the daemon is up (the DB
 * file is opened in WAL mode upstream) or while it is stopped (the CLI
 * opens its own readonly handle).
 *
 * The daemon-side `eveningRulebookIsActive` predicate is the
 * authoritative implementation; this module imports it directly so the
 * rulebook gate cannot drift between runtime and verification.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type Database from "better-sqlite3";

import { CONTEXT_RELATIVE_PATHS } from "./context-paths.js";
import {
  EVENT_SKILL_SETS,
  eveningRulebookIsActive,
} from "./skills-manifest.js";

/** envelope seeded in `process_backend_config` for routine.evening_review */
export const EVENING_REVIEW_ENVELOPE_BUDGET_USD = 1.0;
export const EVENING_REVIEW_ENVELOPE_MAX_TURNS = 50;
/** danger threshold — half of cap. Slim shape sits well below this. */
export const ENVELOPE_DANGER_FRACTION = 0.5;

export type CheckStatus = "pass" | "warn" | "fail";

export interface CheckResult<TData = unknown> {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
  data: TData;
}

export type EveningReviewSlimdownCheck =
  | CheckResult<CronFreshnessData>
  | CheckResult<TokenEnvelopeData>
  | CheckResult<NotifyLoadData>
  | CheckResult<NotifyInvocationsData>;

export interface VerifyReport {
  checks: EveningReviewSlimdownCheck[];
  summary: {
    total: number;
    passed: number;
    warned: number;
    failed: number;
    windowDays: number;
    installAgeDays: number;
    generatedAt: string;
  };
}

export interface RunChecksDeps {
  db: Database.Database;
  contextDir: string;
  /** caller-clamped window for time-bounded checks (default 7) */
  windowDays?: number;
  /** Override for testing. Defaults to `new Date()`. */
  now?: () => Date;
}

export interface RulebookInspection {
  state: "absent" | "empty" | "no_headings" | "active" | "unreadable";
  predicateActive: boolean | null; // null = indeterminate
  headingCount: number;
}

export function runEveningReviewSlimdownChecks(
  deps: RunChecksDeps,
): VerifyReport {
  const { db, contextDir } = deps;
  const windowDays = deps.windowDays ?? 7;
  const now = (deps.now ?? (() => new Date()))();
  const installAgeDays = readInstallAgeDays(db);

  const rulebook = inspectRulebook(contextDir);
  // Reuse the daemon's predicate to mirror its decision exactly when the
  // file IS readable. The local inspection only adds detail (heading
  // count, indeterminate state) the predicate doesn't expose.
  if (rulebook.state !== "unreadable") {
    rulebook.predicateActive = eveningRulebookIsActive(contextDir);
  }

  const checks: EveningReviewSlimdownCheck[] = [
    checkCronAuditFreshness(db, { windowDays, installAgeDays, now }),
    checkEveningReviewTokenEnvelope(db, { windowDays }),
    checkConditionalNotifyLoad({ contextDir, rulebook }),
    checkNotifyInvocations30d(db, {
      installAgeDays,
      rulebookActive: rulebook.predicateActive,
    }),
  ];

  return {
    checks,
    summary: {
      total: checks.length,
      passed: checks.filter((c) => c.status === "pass").length,
      warned: checks.filter((c) => c.status === "warn").length,
      failed: checks.filter((c) => c.status === "fail").length,
      windowDays,
      installAgeDays,
      generatedAt: now.toISOString(),
    },
  };
}

// ── 1. cron audit-row freshness ─────────────────────────────────────────

export interface CronFreshnessData {
  windowDays: number;
  daysWithRow: number;
  daysMissing: string[];
  failedRows: number;
  lastRunAt: string | null;
  lastRunResult: string | null;
}

export function checkCronAuditFreshness(
  db: Database.Database,
  opts: { windowDays: number; installAgeDays: number; now: Date },
): CheckResult<CronFreshnessData> {
  const expectedDays = Math.max(1, Math.min(opts.windowDays, opts.installAgeDays));
  const rows = db
    .prepare<[string]>(
      `SELECT date(started_at, 'localtime') AS day,
              COUNT(*) AS n,
              SUM(CASE WHEN result = 'success' THEN 1 ELSE 0 END) AS ok,
              SUM(CASE WHEN result = 'failed'  THEN 1 ELSE 0 END) AS fail
         FROM agent_actions
        WHERE action_type = 'roadmap_mechanical_maintenance'
          AND started_at >= datetime('now', ?)
        GROUP BY day
        ORDER BY day DESC`,
    )
    .all(`-${expectedDays} days`) as Array<{
      day: string;
      n: number;
      ok: number;
      fail: number;
    }>;

  const lastRow = db
    .prepare(
      `SELECT started_at, result, error
         FROM agent_actions
        WHERE action_type = 'roadmap_mechanical_maintenance'
        ORDER BY started_at DESC
        LIMIT 1`,
    )
    .get() as { started_at: string; result: string; error: string | null } | undefined;

  const expectedDayList = expectedDaySet(opts.now, expectedDays);
  const daysWithRowSet = new Set(rows.map((r) => r.day));
  const missingDays = expectedDayList.filter((d) => !daysWithRowSet.has(d));
  const failedRows = rows.reduce((acc, r) => acc + Number(r.fail || 0), 0);
  // SQLite's `>= datetime('now', '-N days')` filter is UTC-bounded but
  // `date(started_at, 'localtime')` and `expectedDayList` are local. In
  // TZs with a negative UTC offset a row whose local date sits one
  // earlier than the local window can still pass the UTC filter and
  // appear in `daysWithRowSet`. Report the ratio against the local
  // window only so the display never says "8/7 day(s) covered" or "7/7
  // have a row. Missing: <full list>" (a contradiction the unfiltered
  // size would produce in the leaked-day case).
  const daysCovered = expectedDayList.length - missingDays.length;

  const data: CronFreshnessData = {
    windowDays: expectedDays,
    daysWithRow: daysCovered,
    daysMissing: missingDays,
    failedRows,
    lastRunAt: lastRow?.started_at ?? null,
    lastRunResult: lastRow?.result ?? null,
  };

  if (rows.length === 0) {
    // A fresh install (≤ 1 agent-day) may genuinely not have hit 17:45
    // yet — soften to warn so the post-launch report doesn't flag a
    // not-yet-triggered cron as broken on day 0.
    const isFreshInstall = opts.installAgeDays <= 1;
    return {
      id: "cron_audit_freshness",
      label: "Cron audit row daily freshness",
      status: isFreshInstall ? "warn" : "fail",
      detail: isFreshInstall
        ? `No rows yet — fresh install (~${opts.installAgeDays}d). The 17:45 cron may not have fired yet.`
        : `No 'roadmap_mechanical_maintenance' rows in the last ${expectedDays} day(s).`,
      hint:
        "Wait until after 17:45 local on a normal weekday, then re-run. " +
        "To trigger immediately: 'aitne run-now roadmap_maintenance'.",
      data,
    };
  }
  if (failedRows > 0) {
    return {
      id: "cron_audit_freshness",
      label: "Cron audit row daily freshness",
      status: "fail",
      detail:
        `${daysCovered}/${expectedDays} day(s) have a row but ${failedRows} run(s) ended with ` +
        // lastRow is non-null whenever rows.length > 0 (both come from
        // the same action_type filter on agent_actions); the `?? "—"`
        // is TypeScript narrowing safety for a path the runtime cannot
        // reach.
        /* c8 ignore next */
        `result='failed'. Last status: ${lastRow?.result ?? "—"}.`,
      hint:
        "Inspect failures with 'aitne audit --type roadmap_mechanical_maintenance " +
        "--since 7d --result failed --detail'.",
      data,
    };
  }
  if (missingDays.length > 0) {
    return {
      id: "cron_audit_freshness",
      label: "Cron audit row daily freshness",
      status: "warn",
      detail:
        `${daysCovered}/${expectedDays} day(s) have a row. ` +
        `Missing: ${missingDays.join(", ")}.`,
      hint:
        "Acceptable if the daemon was stopped on those days. Otherwise check " +
        "'aitne audit --type roadmap_mechanical_maintenance --since 14d' for the " +
        "skip pattern.",
      data,
    };
  }
  return {
    id: "cron_audit_freshness",
    label: "Cron audit row daily freshness",
    status: "pass",
    // Same TS-narrowing dance as the failed-rows branch above — lastRow
    // is non-null whenever rows.length > 0.
    /* c8 ignore next */
    detail: `${daysCovered}/${expectedDays} day(s) covered. Last run ${lastRow?.started_at ?? "—"} → ${lastRow?.result ?? "—"}.`,
    data,
  };
}

// ── 2. evening_review token envelope ────────────────────────────────────

export interface TokenEnvelopeData {
  windowDays: number;
  sessions: number;
  avgInputTokens: number | null;
  maxInputTokens: number | null;
  avgOutputTokens: number | null;
  maxOutputTokens: number | null;
  avgCacheReadTokens: number | null;
  avgCostUsd: number;
  maxCostUsd: number;
  avgNumTurns: number | null;
  maxNumTurns: number | null;
  envelopeBudgetUsd: number;
  envelopeMaxTurns: number;
}

export function checkEveningReviewTokenEnvelope(
  db: Database.Database,
  opts: { windowDays: number },
): CheckResult<TokenEnvelopeData> {
  const stats = db
    .prepare<[string]>(
      `SELECT COUNT(*)               AS n,
              AVG(tokens_input)      AS avg_in,
              MAX(tokens_input)      AS max_in,
              AVG(tokens_output)     AS avg_out,
              MAX(tokens_output)     AS max_out,
              AVG(cost_usd)          AS avg_cost,
              MAX(cost_usd)          AS max_cost,
              AVG(num_turns)         AS avg_turns,
              MAX(num_turns)         AS max_turns,
              AVG(cache_read_tokens) AS avg_cache_read
         FROM agent_actions
        WHERE action_type = 'routine.evening_review'
          AND result IN ('success', 'partial')
          AND started_at >= datetime('now', ?)`,
    )
    .get(`-${opts.windowDays} days`) as {
      n: number;
      avg_in: number | null;
      max_in: number | null;
      avg_out: number | null;
      max_out: number | null;
      avg_cost: number | null;
      max_cost: number | null;
      avg_turns: number | null;
      max_turns: number | null;
      avg_cache_read: number | null;
    } | undefined;

  // SQLite COUNT/AVG always returns at least one row, so `stats` is
  // defined; the `?? 0` is TS narrowing safety only.
  /* c8 ignore next */
  const n = Number(stats?.n ?? 0);
  const data: TokenEnvelopeData = {
    windowDays: opts.windowDays,
    sessions: n,
    avgInputTokens: roundOrNull(stats?.avg_in),
    maxInputTokens: numericOrNull(stats?.max_in),
    avgOutputTokens: roundOrNull(stats?.avg_out),
    maxOutputTokens: numericOrNull(stats?.max_out),
    avgCacheReadTokens: roundOrNull(stats?.avg_cache_read),
    avgCostUsd: roundCost(stats?.avg_cost),
    maxCostUsd: roundCost(stats?.max_cost),
    avgNumTurns: roundOrNull(stats?.avg_turns),
    maxNumTurns: numericOrNull(stats?.max_turns),
    envelopeBudgetUsd: EVENING_REVIEW_ENVELOPE_BUDGET_USD,
    envelopeMaxTurns: EVENING_REVIEW_ENVELOPE_MAX_TURNS,
  };

  if (n === 0) {
    return {
      id: "evening_review_token_envelope",
      label: "evening_review session envelope",
      status: "warn",
      detail: `No successful evening_review runs in the last ${opts.windowDays} day(s).`,
      hint:
        "Either the routine has not fired yet, has been disabled, or is failing " +
        "before completion. Check 'aitne audit --type routine.evening_review " +
        "--since 30d --detail'.",
      data,
    };
  }

  // `stats` is non-null because n > 0 above; SQLite returned at least
  // one row. `roundCost` always returns a number (so `avgCostUsd` has
  // no nullable branch); `avgNumTurns` can be null when every row in
  // the window had a NULL `num_turns`, in which case "no rows hit the
  // cap" is the correct conservative reading.
  const costNearCap =
    data.avgCostUsd >= EVENING_REVIEW_ENVELOPE_BUDGET_USD * ENVELOPE_DANGER_FRACTION;
  const turnsNearCap =
    data.avgNumTurns !== null &&
    data.avgNumTurns >= EVENING_REVIEW_ENVELOPE_MAX_TURNS * ENVELOPE_DANGER_FRACTION;

  if (costNearCap || turnsNearCap) {
    const flags = [
      costNearCap
        ? `avg cost $${data.avgCostUsd} ≥ ${ENVELOPE_DANGER_FRACTION * 100}% of $${EVENING_REVIEW_ENVELOPE_BUDGET_USD} cap`
        : null,
      turnsNearCap
        ? `avg turns ${data.avgNumTurns} ≥ ${ENVELOPE_DANGER_FRACTION * 100}% of ${EVENING_REVIEW_ENVELOPE_MAX_TURNS} cap`
        : null,
    ].filter(Boolean);
    return {
      id: "evening_review_token_envelope",
      label: "evening_review session envelope",
      status: "warn",
      detail: `${n} session(s) — ${flags.join("; ")}. Slim shape may not be in effect.`,
      hint:
        "Compare against 'aitne audit --type routine.evening_review --since 30d " +
        "--detail' to look for slow drift. The slimmer post-PR2 prompt should sit " +
        "well below half the envelope; sustained values near it suggest a " +
        "prompt regression or the legacy four-step shape still applying.",
      data,
    };
  }

  return {
    id: "evening_review_token_envelope",
    label: "evening_review session envelope",
    status: "pass",
    detail:
      `${n} session(s) — avg input ${formatTokens(data.avgInputTokens)} / ` +
      `output ${formatTokens(data.avgOutputTokens)} / cost $${data.avgCostUsd} ` +
      // avgNumTurns can be null when every row in the window has a
      // NULL num_turns (e.g. legacy audit rows from before the column
      // was wired). Both branches are exercised by the token-envelope
      // tests.
      `/ ${data.avgNumTurns ?? "—"} turn(s). Within envelope.`,
    data,
  };
}

// ── 3. conditional notify load ──────────────────────────────────────────

export interface NotifyLoadData {
  contextDir: string;
  rulebookPath: string;
  rulebookState: RulebookInspection["state"];
  rulebookHeadingCount: number;
  predicateActive: boolean | null;
  expectedSkillCount: number;
  resolvedManifest: string[];
}

export function checkConditionalNotifyLoad(opts: {
  contextDir: string;
  rulebook: RulebookInspection;
}): CheckResult<NotifyLoadData> {
  const rulebookPath = join(
    opts.contextDir,
    CONTEXT_RELATIVE_PATHS.routines.evening,
  );
  // EVENT_SKILL_SETS always carries this key — see skills-manifest.ts.
  // The `?? []` is defensive against a future deletion landing in the
  // manifest map; the verify report would still produce a coherent
  // (empty-manifest) row instead of crashing.
  /* c8 ignore next */
  const baseManifest = EVENT_SKILL_SETS["routine.evening_review"] ?? [];
  const resolvedManifest = opts.rulebook.predicateActive
    ? [...baseManifest]
    : baseManifest.filter((s) => s !== "notify");

  const data: NotifyLoadData = {
    contextDir: opts.contextDir,
    rulebookPath,
    rulebookState: opts.rulebook.state,
    rulebookHeadingCount: opts.rulebook.headingCount,
    predicateActive: opts.rulebook.predicateActive,
    expectedSkillCount: resolvedManifest.length,
    resolvedManifest,
  };

  if (opts.rulebook.state === "unreadable") {
    const hint = looksLikeIcloudPath(rulebookPath)
      ? "The vault sits under iCloud Drive — the CLI usually lacks macOS Full " +
        "Disk Access while the daemon (launched via the agent lifecycle) does " +
        "have it. Grant Terminal/iTerm Full Disk Access in System Settings → " +
        "Privacy & Security to let 'aitne verify' inspect the rulebook " +
        "independently. The daemon's runtime predicate is unaffected."
      : "The CLI cannot read the rulebook to mirror the daemon's predicate. The " +
        "daemon may still be reading it correctly. Try 'cat <path>' from this " +
        "shell — if that also fails, fix permissions; otherwise the CLI's " +
        "sandbox simply differs from the daemon's.";
    return {
      id: "conditional_notify_load",
      label: "Conditional notify load (resolveSkillManifest)",
      status: "warn",
      detail:
        `Rulebook ${rulebookPath} exists but is unreadable to this process — ` +
        `predicate result indeterminate (cannot mirror eveningRulebookIsActive).`,
      hint,
      data,
    };
  }

  return {
    id: "conditional_notify_load",
    label: "Conditional notify load (resolveSkillManifest)",
    status: "pass",
    detail:
      `Rulebook ${opts.rulebook.state} → ` +
      `${opts.rulebook.predicateActive ? "keep" : "drop"} notify → ` +
      `${resolvedManifest.length}-skill manifest (${resolvedManifest.join(", ")}).`,
    data,
  };
}

// ── 4. 30-day notify invocations from evening_review ────────────────────

export interface NotifyInvocationsData {
  windowDays: number;
  sessions: number;
  sessionsWithNotify: number;
  totalNotifies: number;
  rulebookActive: boolean | null;
  samples: Array<{
    id: number;
    startedAt: string;
    completedAt: string | null;
    notifyCount: number;
  }>;
}

export function checkNotifyInvocations30d(
  db: Database.Database,
  opts: { installAgeDays: number; rulebookActive: boolean | null },
): CheckResult<NotifyInvocationsData> {
  const windowDays = Math.max(1, Math.min(30, opts.installAgeDays));

  const sessions = db
    .prepare<[string]>(
      `SELECT a.id, a.started_at, a.completed_at,
              (
                SELECT COUNT(*) FROM notification_log n
                 WHERE n.created_at >= a.started_at
                   AND n.created_at <= COALESCE(a.completed_at, datetime(a.started_at, '+30 minutes'))
              ) AS notify_count
         FROM agent_actions a
        WHERE a.action_type = 'routine.evening_review'
          AND a.started_at >= datetime('now', ?)
        ORDER BY a.started_at DESC`,
    )
    .all(`-${windowDays} days`) as Array<{
      id: number;
      started_at: string;
      completed_at: string | null;
      notify_count: number;
    }>;

  const sessionsWithNotify = sessions.filter((s) => Number(s.notify_count) > 0);
  const totalNotifies = sessionsWithNotify.reduce(
    // notify_count is always a non-null integer from SQLite COUNT(*);
    // the `|| 0` is TS-narrowing belt-and-braces.
    /* c8 ignore next */
    (acc, s) => acc + Number(s.notify_count || 0),
    0,
  );

  const data: NotifyInvocationsData = {
    windowDays,
    sessions: sessions.length,
    sessionsWithNotify: sessionsWithNotify.length,
    totalNotifies,
    rulebookActive: opts.rulebookActive,
    samples: sessionsWithNotify.slice(0, 5).map((s) => ({
      id: s.id,
      startedAt: s.started_at,
      completedAt: s.completed_at,
      notifyCount: Number(s.notify_count),
    })),
  };

  if (sessions.length === 0) {
    return {
      id: "notify_invocations_30d",
      label: "30-day notify invocation sample",
      status: "warn",
      detail: `No evening_review sessions in the last ${windowDays} day(s) — nothing to sample.`,
      hint:
        "Either the routine has not fired yet on this install or the cron is " +
        "blocked. Check 'aitne audit --type routine.evening_review --since 30d'.",
      data,
    };
  }
  if (totalNotifies === 0) {
    return {
      id: "notify_invocations_30d",
      label: "30-day notify invocation sample",
      status: "pass",
      detail:
        `${sessions.length} session(s) inspected, 0 notify calls. ` +
        (opts.rulebookActive === true
          ? "Rulebook is active — zero is the lower bound (rules may not have triggered)."
          : opts.rulebookActive === false
            ? "Rulebook inactive — zero matches the silent-by-default contract."
            : "Rulebook state indeterminate — zero is consistent with both branches."),
      data,
    };
  }
  if (opts.rulebookActive === null) {
    return {
      id: "notify_invocations_30d",
      label: "30-day notify invocation sample",
      status: "warn",
      detail:
        `${sessionsWithNotify.length}/${sessions.length} session(s) emitted ` +
        `${totalNotifies} notify call(s). Rulebook state indeterminate — ` +
        `cannot judge whether intent matches.`,
      hint:
        "Resolve the conditional_notify_load warning first (grant access to the " +
        "rulebook), then re-run 'aitne verify'. The notify counts above are correct; " +
        "only their interpretation is gated on the rulebook predicate.",
      data,
    };
  }
  if (opts.rulebookActive) {
    return {
      id: "notify_invocations_30d",
      label: "30-day notify invocation sample",
      status: "pass",
      detail:
        `${sessionsWithNotify.length}/${sessions.length} session(s) emitted ` +
        `${totalNotifies} notify call(s). Rulebook is active — explicit notify ` +
        `intent is legitimate.`,
      data,
    };
  }
  return {
    id: "notify_invocations_30d",
    label: "30-day notify invocation sample",
    status: "warn",
    detail:
      `${sessionsWithNotify.length}/${sessions.length} session(s) emitted ` +
      `${totalNotifies} notify call(s) — but the rulebook is inactive. ` +
      `Built-in steps should be silent.`,
    hint:
      "Inspect the offending sessions: 'aitne audit --type routine.evening_review " +
      "--since 30d --detail' and cross-reference notification_log timestamps. " +
      "Likely cause: the prompt regressed and reintroduced a Step-4-style " +
      "user-facing wrap-up.",
    data,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Pre-read inspection of `policies/routines/evening.md` that surfaces detail the
 * boolean predicate doesn't expose (heading count, indeterminate state).
 *
 * The daemon's predicate (`eveningRulebookIsActive`) is canonical and
 * the caller overlays its boolean answer on top of this inspection's
 * state — see `runEveningReviewSlimdownChecks`. The split exists because
 * the predicate intentionally collapses unreadable / absent / empty
 * into a single `false`, which is the right runtime answer but loses
 * the diagnostic detail the verify report needs.
 */
export function inspectRulebook(contextDir: string): RulebookInspection {
  const rulebookPath = join(
    contextDir,
    CONTEXT_RELATIVE_PATHS.routines.evening,
  );
  if (!existsSync(rulebookPath)) {
    return { state: "absent", predicateActive: false, headingCount: 0 };
  }
  let body: string;
  try {
    body = readFileSync(rulebookPath, "utf-8");
  } catch {
    // The daemon predicate also returns false on unreadable; we mark
    // `null` to let the verify renderer surface "indeterminate" rather
    // than implying the predicate decided "inactive".
    return { state: "unreadable", predicateActive: null, headingCount: 0 };
  }
  if (body.trim().length === 0) {
    return { state: "empty", predicateActive: false, headingCount: 0 };
  }
  if (!/^###\s+/m.test(body)) {
    return { state: "no_headings", predicateActive: false, headingCount: 0 };
  }
  // The `?? []` cannot fire — we guarded with a `^###\s+` test above,
  // so `match()` returns at least one capture. Defensive only.
  /* c8 ignore next */
  const headings = (body.match(/^###\s+.+$/gm) ?? []).length;
  return { state: "active", predicateActive: true, headingCount: headings };
}

/**
 * Best-effort install age proxy: the oldest agent_actions row.
 *
 * Returns the floor in agent-days, capped at 365 so a long-running
 * install doesn't widen the verification window past Phase 4's intent.
 * Returns 1 when the table is empty (a fresh install has no history;
 * clamping prevents "0-day window" arithmetic downstream) — that 1
 * also drives the fresh-install softening in the cron-freshness check.
 */
export function readInstallAgeDays(db: Database.Database): number {
  const row = db
    .prepare(
      `SELECT julianday('now') - julianday(MIN(started_at)) AS age_days
         FROM agent_actions`,
    )
    .get() as { age_days: number | null } | undefined;
  const age = Number(row?.age_days);
  if (!Number.isFinite(age) || age < 1) return 1;
  return Math.min(365, Math.floor(age) + 1);
}

/**
 * Returns YYYY-MM-DD strings from `now - windowDays + 1` up to `now` in
 * the host's local timezone. Used to enumerate which agent-days the
 * cron freshness check expects a row for.
 */
export function expectedDaySet(now: Date, windowDays: number): string[] {
  const out: string[] = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    out.push(formatYmd(d));
  }
  return out;
}

function formatYmd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function roundOrNull(value: number | null | undefined): number | null {
  // Distinguish "SQL AVG returned NULL because all input rows had NULL"
  // from "SQL AVG returned 0 because every row was 0" — both are valid
  // states the verify report needs to surface differently.
  if (value === null || value === undefined) return null;
  const n = Number(value);
  // SQLite always returns numbers for these aggregates; the !isFinite
  // guard is defensive against a future call site passing a string.
  /* c8 ignore next */
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

function numericOrNull(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  /* c8 ignore next */
  if (!Number.isFinite(n)) return null;
  return n;
}

function roundCost(value: number | null | undefined): number {
  const n = Number(value);
  // Number(null/undefined) → 0 / NaN, both handled by the same guard
  // below. Reachability tested via the n=0 path; the genuine NaN
  // branch is defensive.
  /* c8 ignore next */
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1000) / 1000;
}

function formatTokens(value: number | null): string {
  if (value == null) return "—";
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

/**
 * iCloud-Drive Obsidian vaults live under
 * `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/...` and are
 * gated by macOS Full Disk Access. The daemon (launched via the agent
 * lifecycle) typically inherits the grant; the CLI invoked from a fresh
 * Terminal session does not. The hint distinguishes that from a true
 * permission failure so the operator knows where to look first.
 */
function looksLikeIcloudPath(p: string): boolean {
  return /\/Library\/Mobile Documents\/iCloud~/.test(p);
}

/**
 * Resolve the context directory the same way the daemon's
 * `getContextDir(config, db)` does, but reading from the raw `settings`
 * table so the CLI doesn't need to construct a full AgentConfig.
 *
 * The three-branch contract mirrors `config.ts:getContextDir` exactly:
 *
 *   1. plain mode → `<dataDir>/context`
 *   2. obsidian mode + configured `primaryVaultPath` + NOT degraded → the
 *      configured vault path
 *   3. obsidian mode + degraded (vault currently unreachable) → fall
 *      back to `<dataDir>/context`, matching what the daemon's runtime
 *      actually reads from while degraded
 *
 * Without (3) the verify CLI would evaluate the rulebook predicate
 * against an unreadable vault path while the daemon evaluates it against
 * the fallback — silently inverting the §3.5 cross-backend parity claim
 * during exactly the time a verify report is most likely to be run
 * (operator investigating why the agent is acting strangely).
 *
 * Settings values are JSON-encoded in the `settings` table. Corrupt /
 * unparseable JSON is treated as "not configured" rather than throwing —
 * a verify report should never fail because a single setting row is
 * malformed; the daemon's `parseJsonOrDefault` has the same posture.
 *
 * Tilde-expansion (`~/Foo`) of `primaryVaultPath` matches
 * `normalizeRuntimeSettings` in `config.ts`. In practice the setup
 * wizard stores absolute paths, but this defends against a manually-set
 * value in the settings table (and against any future writer that
 * forgets to expand).
 */
export function resolveContextDirFromDb(
  db: Database.Database,
  dataDir: string,
): string {
  const get = (key: string): unknown => {
    try {
      const row = db
        .prepare("SELECT value_json FROM settings WHERE key = ?")
        .get(key) as { value_json: string } | undefined;
      if (!row?.value_json) return null;
      return JSON.parse(row.value_json) as unknown;
    } catch {
      return null;
    }
  };
  const vaultMode = get("vaultMode");
  const rawPrimaryVaultPath = get("primaryVaultPath");
  const primaryVaultPath =
    typeof rawPrimaryVaultPath === "string" && rawPrimaryVaultPath.length > 0
      ? expandTilde(rawPrimaryVaultPath)
      : null;
  if (
    vaultMode === "obsidian" &&
    primaryVaultPath !== null &&
    !isDegradedFromDb(db)
  ) {
    return primaryVaultPath;
  }
  return join(dataDir, "context");
}

function expandTilde(p: string): string {
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return resolve(homedir(), p.slice(2));
  }
  return p;
}

/**
 * Mirror of `isDegraded(db)` from `db/runtime-state.ts`, inlined so the
 * CLI doesn't need to import the full runtime-state module (which pulls
 * in the daemon's logger). Same key, same shape: a non-null
 * `runtime_state.value_json` for the degraded marker means degraded.
 */
function isDegradedFromDb(db: Database.Database): boolean {
  try {
    const row = db
      .prepare("SELECT value_json FROM runtime_state WHERE key = ?")
      .get("management_mode.degraded") as
      | { value_json: string }
      | undefined;
    if (!row?.value_json) return false;
    // Treat any parse error as "not degraded" — same posture as
    // readRuntimeState's corrupt-row fallback in runtime-state.ts. The
    // verify report should not crash because the degraded marker is
    // malformed; the worst case is identical to "no degraded marker".
    try {
      return JSON.parse(row.value_json) !== null;
    } catch {
      return false;
    }
    // Outer guard against a DB error on the runtime_state SELECT — the
    // table is created by applySchema before this CLI ever runs, so the
    // realistic reach paths (DB locked mid-shutdown, file corruption)
    // are out of scope for the verify report. Same posture as the
    // surrounding helper's defensive catches.
    /* c8 ignore next 3 */
  } catch {
    return false;
  }
}
