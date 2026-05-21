import type Database from "better-sqlite3";
import type { BackendId } from "@aitne/shared";
import { getBackendIds, isBackendId, redactSensitiveString } from "@aitne/shared";
import type {
  AuthCheckResult,
  AuthStatus,
  IAgentCore,
} from "../agent-core.js";
import type { AuthTelemetry } from "./auth-telemetry.js";
import { createLogger } from "../../logging.js";

const logger = createLogger("auth-health-monitor");

/**
 * NotificationManager category for probe-failure DMs. Must be a member
 * of NotificationManager's `SAFETY_CATEGORIES` array so that the DM
 * bypasses quiet-hours + rate-limit gates at the NotificationManager
 * layer (AuthHealthMonitor.shouldNotify owns the application-level
 * policy). Exported so the index.ts wiring and the constant definition
 * stay in sync — a rename that breaks the invariant will surface as a
 * compile error rather than a silent runtime regression. See B2 fix.
 */
export const AUTH_PROBE_NOTIFICATION_CATEGORY = "error" as const;

/**
 * AuthHealthMonitor — detection, DB-cache persistence, and proactive
 * notification for the auth health design (Phase 1–4 scope). See
 * `docs/design/09-safety-cost.md` §9.5.
 *
 * **Phase 1–3 (minimal v1, 2026-04-10)**:
 *   - DB-cache read / persist of AuthCheckResult
 *   - `/auth status` rendering
 *   - reactive-path DB update helpers (free functions, used by BackendRouter)
 *   - 60-day keepalive reminder sweep
 *   - startup reconcile of lost `recovering` sessions
 *
 * **Phase 4 (2026-04-11)**:
 *   - `checkAll()` hourly probe — iterates enabled backends, runs
 *     `checkAuthDetailed()`, persists each result, and decides whether to
 *     send a proactive DM.
 *   - Grace period + escalation (§3.2 / §3.3 of the design spec).
 *     Notifications hold for PROACTIVE_GRACE_PERIOD_MIN after first
 *     detection, then fire once, then escalate on ESCALATION_STEPS_MIN
 *     with quiet-hours suppression. A 3-day escalation sharpens the tone.
 *   - Reactive / proactive separation (§3.4, §5.3) — this class never
 *     notifies on reactive failures. `recordReactiveAuthFailure` stamps
 *     `auth_first_expired_at`, which seeds the next proactive tick's
 *     grace period.
 *   - Per-invocation dedupe (§3.5 / §5.3.1) — a single `checkAll()` tick
 *     sends at most one DM that aggregates all failing backends.
 *
 * **Phase 3.3 (2026-04-11)**:
 *   - `readCachedAuthStatus()` pre-flight check in BackendRouter.execute().
 *     Strategy A: the `auth_last_verified_at` column tracks the last time
 *     we had authoritative info about a backend's auth state.
 *     When the cached status is `expired`/`missing` and the verification is
 *     fresh (within 10 min), the router skips main and routes directly to
 *     fallback — saving a doomed subprocess. Stale cache falls through to
 *     main to allow self-heal after manual re-auth.
 *
 * Still out of scope (later phases):
 *   - Phase 5/6: `startRecovery()` for Codex/Gemini (interactive CLI
 *     subprocesses) — `reconcilePendingRecoveries` is wired up in
 *     anticipation of this.
 */

export interface AuthHealthState {
  status: AuthStatus | "recovering" | "unknown";
  detail: string | null;
  checkedAt: Date | null;
  firstExpiredAt: Date | null;
  notifiedAt: Date | null;
  notificationCount: number;
  lastSuccessAt: Date | null;
  lastVerifiedAt: Date | null;
  keepaliveNotifiedAt: Date | null;
}

/**
 * Notification sink used by both the keepalive sweep and the Phase 4
 * proactive probe. The `kind` tag lets the daemon wiring map each
 * message to a distinct `notification_type` (e.g.
 * `auth.keepalive_reminder` vs `auth.probe_failure`) so dashboards can
 * filter / rate-limit them separately. Undefined → treated as
 * `keepalive` for backwards-compat with existing callers.
 */
export interface AuthHealthNotifier {
  send(
    message: string,
    options?: { kind?: "keepalive" | "probe_failure" | "recovery" },
  ): Promise<void>;
}

export interface AuthHealthMonitorOptions {
  /** Optional DM sink used for keepalive reminders AND the Phase 4 probe. */
  notifier?: AuthHealthNotifier;
  /** Days of inactivity before a keepalive reminder is emitted (default 60). */
  keepaliveThresholdDays?: number;
  /** Dedupe window for keepalive reminders (default 30 days). */
  keepaliveDedupeDays?: number;
  /** Clock override for deterministic tests. */
  now?: () => Date;
  /**
   * Injected morning-routine gate — returning `true` causes `checkAll()`
   * to short-circuit without probing. Mirrors the existing hourly-check
   * gate (§3.2 of the design doc) so probe DMs never collide with the
   * morning routine. In production, index.ts wires this to
   * `dispatcher.isMorningRoutineActive()`. Tests may pass a fake.
   */
  isMorningRoutineActive?: () => boolean;
  /**
   * Injected quiet-hours predicate — returning `true` causes `checkAll()`
   * to persist probe results to the DB cache but suppress the
   * notification tail (§3.2 / §3.3). Initial grace-period notifications
   * respect quiet hours; reactive failures do not (they never flow
   * through this class). In production, wired to
   * `notificationManager.isQuietHours()`.
   */
  isQuietHours?: () => boolean;
  /**
   * Phase 4 kill switch — when `true`, `checkAll()` is a no-op. Mirrors
   * the `authProbeDisabled` config field so callers can disable the
   * probe without touching the scheduler wiring. In production, wired
   * via the runtime config so a dashboard PATCH can toggle it live.
   */
  probeDisabled?: () => boolean;
}

interface BackendAuthRow {
  id: BackendId;
  // `auth_status` and `auth_notification_count` are NOT NULL per
  // schema.ts (status defaults to 'unknown', notification_count to 0).
  auth_status: string;
  auth_detail: string | null;
  auth_checked_at: string | null;
  auth_first_expired_at: string | null;
  auth_notified_at: string | null;
  auth_notification_count: number;
  auth_last_success_at: string | null;
  auth_last_verified_at: string | null;
  auth_keepalive_notified_at: string | null;
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function rowToState(row: BackendAuthRow | undefined): AuthHealthState | null {
  if (!row) return null;
  return {
    status: row.auth_status as AuthHealthState["status"],
    detail: row.auth_detail,
    checkedAt: parseDate(row.auth_checked_at),
    firstExpiredAt: parseDate(row.auth_first_expired_at),
    notifiedAt: parseDate(row.auth_notified_at),
    notificationCount: row.auth_notification_count,
    lastSuccessAt: parseDate(row.auth_last_success_at),
    lastVerifiedAt: parseDate(row.auth_last_verified_at),
    keepaliveNotifiedAt: parseDate(row.auth_keepalive_notified_at),
  };
}

// SQL fragment — the "clear failure bookkeeping" columns shared between
// `persistCheckResult` (ok branch) and `recordReactiveAuthSuccess`
// (non-ok → ok branch). Centralising this ensures that when a new
// failure-tracking column is added (e.g. Phase 4 escalation counters),
// both code paths pick it up by editing a single constant. See
// roadmap §2.1.
//
// `last_error` is NOT included here — it is owned by the writeAuth*Detail
// helpers so that a future column renaming or a second writer can't
// drift from the redaction invariant (roadmap §2.5 / §9.2).
const CLEAR_FAILURE_BOOKKEEPING_SQL = `
  auth_last_success_at = @now,
  auth_first_expired_at = NULL,
  auth_notified_at = NULL,
  auth_notification_count = 0
`;

// SQL fragment — unified `auth_first_expired_at` update for any
// transition into a failing state. Uses a CASE on the pre-update
// `auth_status` column so that:
//
//   ok        → expired : stamp NOW (even if a stale first_expired_at
//                         somehow leaked through)
//   expired   → expired : keep the original timestamp
//   unknown   → expired : stamp NOW (first observation of failure)
//   missing   → expired : preserve (carries the original detection time)
//
// SQLite evaluates all SET expressions against the pre-update row, so
// `auth_status = 'ok'` in the CASE refers to the OLD value. Replaces
// both the TS-side `wasOk ? now : prev.firstExpiredAt ?? now` branching
// in `persistCheckResult` and the plain `COALESCE(auth_first_expired_at,
// ?)` in `recordReactiveAuthFailure`. See roadmap §2.2.
// Exported for `auth-recovery.ts` — the recovery failure path must
// apply the same first_expired_at semantics as the reactive path
// (recovering → expired is handled by the ELSE branch: COALESCE
// preserves the pre-recovery timestamp or stamps @now if NULL).
export const FIRST_EXPIRED_CASE_SQL = `
  auth_first_expired_at = CASE
    WHEN auth_status = 'ok' THEN @now
    ELSE COALESCE(auth_first_expired_at, @now)
  END
`;

/**
 * Write the detail text for a FAILED auth check. Both `auth_detail`
 * and `last_error` receive the same redacted value so that dashboards
 * reading either column see a consistent failure message. `null`
 * detail clears both columns.
 *
 * This is the ONLY supported way for production code to mutate
 * `auth_detail` / `last_error`. The companion CI check
 * `scripts/check-redaction-coverage.sh` (roadmap §9.2) fails if any
 * other non-test file contains a raw `auth_detail = ?` /
 * `last_error = ?` assignment, so a future contributor adding a new
 * write site can't accidentally bypass redaction.
 */
export function writeAuthFailureDetail(
  db: Database.Database,
  backendId: BackendId,
  detail: string | null,
): void {
  if (detail == null) {
    db.prepare(
      `UPDATE backends SET auth_detail = NULL, last_error = NULL WHERE id = ?`,
    ).run(backendId);
    return;
  }
  const safe = redactSensitiveString(detail);
  db.prepare(
    `UPDATE backends SET auth_detail = ?, last_error = ? WHERE id = ?`,
  ).run(safe, safe, backendId);
}

/**
 * Write the detail text for a SUCCESSFUL auth check. Only `auth_detail`
 * receives the text — informational ok-state strings like
 * "Server-verified at HH:MM UTC" or "refresh_token within grace period"
 * are preserved so the dashboard continues to show them. `last_error` is
 * ALWAYS cleared because a passing check has no error, regardless of the
 * informational detail.
 *
 * Like `writeAuthFailureDetail`, this is the only supported production
 * write path for these columns (roadmap §9.2).
 */
export function writeAuthOkDetail(
  db: Database.Database,
  backendId: BackendId,
  detail: string | null,
): void {
  const safe = detail != null ? redactSensitiveString(detail) : null;
  db.prepare(
    `UPDATE backends SET auth_detail = ?, last_error = NULL WHERE id = ?`,
  ).run(safe, backendId);
}

// Default freshness window for pre-flight auth cache checks (10 minutes).
// Short enough that a stale cached `expired` doesn't block self-heal for
// long after a user re-auths, but long enough that a freshly confirmed
// failure skips the doomed main subprocess. Tunable via config.
const DEFAULT_PREFLIGHT_FRESHNESS_MS = 10 * 60 * 1000;

/**
 * Pre-flight result returned by `readCachedAuthStatus`. `shouldSkip` is
 * `true` when the router should bypass the main backend and fall directly
 * to the fallback.
 */
export interface CachedAuthResult {
  status: AuthHealthState["status"];
  shouldSkip: boolean;
}

/**
 * Pre-flight auth cache read — Phase 3.3 (Strategy A). Reads the
 * backend's `auth_status` and `auth_last_verified_at` from the DB cache
 * and decides whether the router should skip main.
 *
 * Decision matrix:
 *   - `recovering`                          → always skip (subprocess owns the row)
 *   - `expired`/`missing` + fresh cache     → skip (save a doomed subprocess)
 *   - `expired`/`missing` + stale cache     → don't skip (user may have re-authed)
 *   - `ok` / `unknown` / any other          → don't skip
 *   - DB error                              → don't skip (fail-open)
 *
 * "Fresh" means `auth_last_verified_at` is within `freshnessMs` of now.
 *
 * Free function so BackendRouter can import it without holding an
 * AuthHealthMonitor instance (same pattern as `recordReactiveAuth*`).
 */
export function readCachedAuthStatus(
  db: Database.Database,
  backendId: BackendId,
  freshnessMs: number = DEFAULT_PREFLIGHT_FRESHNESS_MS,
  now: Date = new Date(),
): CachedAuthResult {
  try {
    const row = db
      .prepare(
        "SELECT auth_status, auth_last_verified_at FROM backends WHERE id = ?",
      )
      .get(backendId) as
      | { auth_status: string; auth_last_verified_at: string | null }
      | undefined;

    if (!row) return { status: "unknown", shouldSkip: false };

    const status = row.auth_status as AuthHealthState["status"];

    // Recovering: the recovery subprocess owns the row — always skip.
    if (status === "recovering") {
      return { status, shouldSkip: true };
    }

    // Only expired / missing are candidates for pre-flight skip.
    if (status !== "expired" && status !== "missing") {
      return { status, shouldSkip: false };
    }

    // Expired or missing — is the cache fresh enough to trust?
    const verifiedAt = parseDate(row.auth_last_verified_at);
    if (!verifiedAt) {
      // No verification timestamp → cache staleness is unknown → don't
      // trust. Fall through to main so reactive self-heal can work.
      return { status, shouldSkip: false };
    }

    const ageMs = now.getTime() - verifiedAt.getTime();
    const isFresh = ageMs <= freshnessMs;
    return { status, shouldSkip: isFresh };
  } catch {
    // Fail-open: DB errors must never block backend execution.
    return { status: "unknown", shouldSkip: false };
  }
}

/**
 * Reactive-path helper: called from BackendRouter when an execute()
 * surfaces a BackendDecisiveFailure("auth"). Writes the failure into
 * the DB cache so `/auth status` reflects the real-time state. Kept as
 * a free function so BackendRouter doesn't need to construct an
 * AuthHealthMonitor.
 *
 * Never clobbers a `recovering` row — an in-progress recovery session
 * takes precedence over a concurrent runtime failure. The subprocess
 * handling the recovery owns the row until it transitions back to
 * `ok` or `expired` on completion.
 *
 * Redaction of the detail string is handled by `writeAuthFailureDetail`,
 * not inline here, so that upstream 4xx bodies echoing `Bearer
 * sk-ant-...` fragments cannot leak into the DB through any future
 * caller that forgets to redact manually (roadmap §9.2).
 *
 * Structured as a transaction so the main status UPDATE and the
 * subsequent `writeAuthFailureDetail` commit atomically — a crash
 * between the two must not leave a row with `auth_status = 'expired'`
 * and a stale `auth_detail` from a prior unrelated failure.
 */
export function recordReactiveAuthFailure(
  db: Database.Database,
  backendId: BackendId,
  detail: string,
  telemetry?: AuthTelemetry,
  now: Date = new Date(),
): void {
  try {
    const nowIso = now.toISOString();
    let changes = 0;
    db.transaction(() => {
      // Main UPDATE — carries status, first_expired_at (unified CASE),
      // checked_at and updated_at. Explicitly does NOT touch
      // `auth_detail` / `last_error`; those are the exclusive province
      // of `writeAuthFailureDetail` below. The `recovering` guard
      // matches the existing reactive-path contract.
      const info = db
        .prepare(
          `UPDATE backends
              SET auth_status = 'expired',
                  auth_checked_at = @now,
                  auth_last_verified_at = @now,
                  ${FIRST_EXPIRED_CASE_SQL},
                  updated_at = @now
            WHERE id = @id
              AND auth_status IS NOT 'recovering'`,
        )
        .run({ now: nowIso, id: backendId });
      changes = Number(info.changes);
      if (changes > 0) {
        writeAuthFailureDetail(db, backendId, detail);
      }
    })();
    // Only increment telemetry if the row was actually updated (i.e. not
    // blocked by the `recovering` guard).
    if (changes > 0) {
      telemetry?.recordReactiveExpired(backendId);
    }
  } catch (err) {
    // DB write is best-effort — never block backend execution fallback.
    // But we MUST leave a log trail so a locked DB / schema drift doesn't
    // silently drop auth telemetry while the dashboard stays green.
    logger.warn(
      { err, backendId },
      "recordReactiveAuthFailure: DB write failed (auth status will stay stale until next probe)",
    );
  }
}

// States that the reactive success path treats as "needs transition to ok".
// `unknown` is included so first-ever successful use clears the initial
// state, but it is NOT counted as a self-heal (see persistCheckResult for
// the matching invariant — the counter tracks recoveries from an
// OBSERVED failure, not first-time use).
const NON_OK_STATES = new Set(["expired", "missing", "unknown"]);
const SELF_HEAL_PREV_STATES = new Set(["expired", "missing"]);

// Phase 4 — proactive notification schedule.
//
// Source of truth: `docs/design/09-safety-cost.md` §9.5.4.
// DO NOT change these values without updating the design doc first.
//
// Grace period: the delay between first observed failure and the 1st
// proactive DM. Lets the CLI self-heal on its next successful call
// (observed empirically on Codex / Gemini) without triggering a noisy
// notification that the user has to ignore.
const PROACTIVE_GRACE_PERIOD_MIN = 30;

// Escalation steps (minutes) from the 1st notification onward. Index i
// holds the delay from notification #(i+1) to notification #(i+2). After
// the array is exhausted, the last step repeats (so step 2 and onward
// all fire every 24h).
//
// Note: the 1st notification is gated by PROACTIVE_GRACE_PERIOD_MIN,
// not by this array. ESCALATION_STEPS_MIN[0] is the *delay from the 1st
// DM to the 2nd*.
const ESCALATION_STEPS_MIN: readonly number[] = [6 * 60, 24 * 60];

// Days elapsed since `auth_first_expired_at` after which the DM tone
// sharpens ("3 days elapsed, please act"). Tuned to match the design
// doc §3.3 row "+3 days | sharpen reminder tone".
const URGENT_TONE_DAYS = 3;

/**
 * Reactive-path self-heal helper: called from BackendRouter when an
 * execute() succeeds. Bumps `auth_last_success_at` (so the 60-day
 * keepalive sweep tracks real usage, not just manual dashboard clicks)
 * and transitions expired/missing rows back to ok (so the DB cache
 * reflects the reality of a working backend without waiting for a
 * manual dashboard "Check auth" button press).
 *
 * A successful execute is authoritative — it proves the CLI held
 * working credentials at some point in the last few seconds. Never
 * clobbers a `recovering` row for the same reason as
 * recordReactiveAuthFailure: the recovering subprocess owns the row.
 */
export function recordReactiveAuthSuccess(
  db: Database.Database,
  backendId: BackendId,
  telemetry?: AuthTelemetry,
  now: Date = new Date(),
): void {
  try {
    const nowIso = now.toISOString();
    const prev = db
      .prepare("SELECT auth_status FROM backends WHERE id = ?")
      .get(backendId) as { auth_status: string } | undefined;
    if (!prev) return;
    if (prev.auth_status === "recovering") return;

    if (NON_OK_STATES.has(prev.auth_status)) {
      // Non-ok → ok transition: clear all failure bookkeeping and
      // count it as a self-heal ONLY when the prior state represented
      // an OBSERVED failure (mirrors persistCheckResult semantics —
      // `unknown` is a fresh install, not a recovery).
      //
      // The main UPDATE and the subsequent detail-clear run inside a
      // transaction so the row never momentarily holds `auth_status =
      // 'ok'` alongside a stale failure detail (roadmap §2.5).
      db.transaction(() => {
        db.prepare(
          `UPDATE backends
              SET auth_status = 'ok',
                  ${CLEAR_FAILURE_BOOKKEEPING_SQL},
                  auth_last_verified_at = @now,
                  updated_at = @now
            WHERE id = @id`,
        ).run({ now: nowIso, id: backendId });
        writeAuthOkDetail(db, backendId, null);
      })();
      if (SELF_HEAL_PREV_STATES.has(prev.auth_status)) {
        // Reactive path: a real execute() succeeded after a previously
        // observed failure. Tagged `reactive` so Phase 4 dashboards can
        // contrast this against probe-observed heals.
        telemetry?.recordSelfHealObserved(backendId, "reactive");
      }
      return;
    }

    // ok → ok: just bump last_success_at + last_verified_at so keepalive
    // tracks real usage and the pre-flight freshness check stays current.
    db.prepare(
      `UPDATE backends
          SET auth_last_success_at = ?,
              auth_last_verified_at = ?,
              updated_at = ?
        WHERE id = ?`,
    ).run(nowIso, nowIso, nowIso, backendId);
  } catch (err) {
    // Best-effort — a DB failure here must NOT break backend execution.
    logger.warn(
      { err, backendId },
      "recordReactiveAuthSuccess: DB write failed (auth_last_success_at will stay stale)",
    );
  }
}

export class AuthHealthMonitor {
  private readonly keepaliveThresholdDays: number;
  private readonly keepaliveDedupeDays: number;
  private readonly notifier: AuthHealthNotifier | undefined;
  private readonly now: () => Date;
  private readonly isMorningRoutineActiveFn: (() => boolean) | undefined;
  private readonly isQuietHoursFn: (() => boolean) | undefined;
  private readonly probeDisabledFn: (() => boolean) | undefined;
  /**
   * Promise returned from the currently in-flight `checkAll()` call, or
   * `null` when no tick is running. Used as a single-owner guard so
   * overlapping cron ticks (e.g. a slow probe still running when the
   * next hour fires) serialize without queueing stacks of probes. The
   * field is set atomically before any `await` to avoid the
   * microtask-scheduling race that bit `Dispatcher.hourlyCheckInProgress`
   * pre-C1 fix (see `dispatcher.ts`).
   */
  private checkAllInFlight: Promise<void> | null = null;

  constructor(
    private readonly db: Database.Database,
    private readonly cores: Partial<Record<BackendId, IAgentCore>>,
    private readonly telemetry: AuthTelemetry,
    options: AuthHealthMonitorOptions = {},
  ) {
    this.keepaliveThresholdDays = options.keepaliveThresholdDays
      ?? parseEnvDays(process.env.PA_AUTH_KEEPALIVE_DAYS, 60);
    this.keepaliveDedupeDays = options.keepaliveDedupeDays ?? 30;
    this.notifier = options.notifier;
    this.now = options.now ?? (() => new Date());
    this.isMorningRoutineActiveFn = options.isMorningRoutineActive;
    this.isQuietHoursFn = options.isQuietHours;
    this.probeDisabledFn = options.probeDisabled;
  }

  /** Read current DB state for a backend, or null when no row exists. */
  loadState(backendId: BackendId): AuthHealthState | null {
    const row = this.db
      .prepare(
        `SELECT id,
                auth_status,
                auth_detail,
                auth_checked_at,
                auth_first_expired_at,
                auth_notified_at,
                auth_notification_count,
                auth_last_success_at,
                auth_last_verified_at,
                auth_keepalive_notified_at
           FROM backends
          WHERE id = ?`,
      )
      .get(backendId) as BackendAuthRow | undefined;
    return rowToState(row);
  }

  /**
   * Persist the result of an AuthCheckResult (from `checkAuthDetailed()`) to
   * the DB. Handles the transitions described in the design doc:
   *
   *   ok → ok           : update `auth_last_success_at`
   *   non-ok → ok       : clear first_expired/notified/notification_count + record self-heal
   *   ok → non-ok       : set first_expired_at (once)
   *   non-ok → non-ok   : keep first_expired_at, update detail
   *
   * `first_expired_at` management uses `FIRST_EXPIRED_CASE_SQL` — the
   * same fragment reused by `recordReactiveAuthFailure` — so both paths
   * share a single source of truth (roadmap §2.2). `auth_detail` /
   * `last_error` writes go through the `writeAuth*Detail` helpers
   * (roadmap §9.2), and main UPDATE + detail UPDATE run in a
   * transaction to keep the two in lockstep.
   */
  persistCheckResult(
    backendId: BackendId,
    result: AuthCheckResult,
  ): void {
    const prev = this.loadState(backendId);
    const nowIso = this.now().toISOString();
    const status: AuthStatus = result.status;

    if (status === "ok") {
      // Only count a self-heal when we explicitly observed a prior failure.
      // `unknown` (the initial state before any probe has run) is NOT a
      // self-heal — the very first successful check shouldn't bump the counter.
      const observedSelfHeal =
        prev !== null && SELF_HEAL_PREV_STATES.has(prev.status);
      this.db.transaction(() => {
        this.db
          .prepare(
            `UPDATE backends
                SET auth_status = @status,
                    auth_checked_at = @now,
                    auth_last_verified_at = @now,
                    auth_method = @method,
                    ${CLEAR_FAILURE_BOOKKEEPING_SQL},
                    updated_at = @now
              WHERE id = @id`,
          )
          .run({
            status,
            now: nowIso,
            method: result.method,
            id: backendId,
          });
        // ok-path helper preserves informational detail (e.g.
        // "Server-verified at HH:MM UTC", "refresh_token within grace
        // period") and always clears `last_error`.
        writeAuthOkDetail(this.db, backendId, result.detail ?? null);
      })();
      if (observedSelfHeal) {
        // Probe path: `persistCheckResult` is the entry point for the
        // Phase 4 hourly probe (and, today, the dashboard's manual
        // "Check auth" button — still semantically a side-channel
        // check, not a user-triggered execute). Tagged `probe` so the
        // Analytics tab can attribute recoveries correctly.
        this.telemetry.recordSelfHealObserved(backendId, "probe");
      }
      return;
    }

    // Non-ok path: expired / missing. `auth_method` is intentionally
    // NOT updated here — matches pre-refactor behaviour (the ok branch
    // is the only place that refreshes the method).
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE backends
              SET auth_status = @status,
                  auth_checked_at = @now,
                  auth_last_verified_at = @now,
                  ${FIRST_EXPIRED_CASE_SQL},
                  updated_at = @now
            WHERE id = @id`,
        )
        .run({ status, now: nowIso, id: backendId });
      writeAuthFailureDetail(this.db, backendId, result.detail ?? null);
    })();
  }

  /**
   * **Phase 4 hourly probe** — design doc §3.1–§3.5.
   *
   * Probe every enabled backend with a registered core, persist each
   * result to the DB cache, and decide whether to send a **single**
   * aggregated proactive DM listing all failing backends.
   *
   * Invariants (see the class-level comment for the full list):
   * 1. Reactive and proactive notification paths are strictly separated.
   *    `recordReactiveAuthFailure` stamps `auth_first_expired_at`, which
   *    seeds the grace period; the next proactive tick reads that
   *    timestamp, waits PROACTIVE_GRACE_PERIOD_MIN, then (optionally)
   *    sends one DM through this method.
   * 2. Probe results are persisted through `persistCheckResult` even
   *    when notifications are suppressed (quiet hours, missing
   *    notifier, disabled kill switch). This keeps the `/auth status`
   *    endpoint and the keepalive sweep consistent with reality.
   * 3. `checkAll()` never starts a recovery subprocess. Recovery is
   *    strictly user-initiated (§3 design principle). A backend row
   *    currently in `auth_status = 'recovering'` is skipped entirely —
   *    the recovering subprocess owns the row until it writes back.
   * 4. One DM per tick. Even if three backends are expired and past
   *    their escalation threshold, a single batched message is sent.
   *    This is enforced structurally (buildNotificationMessage returns
   *    one string for a list) rather than via dedupe state.
   *
   * Gates applied in order:
   *   - probeDisabled? → no-op
   *   - in-flight dedupe (single-owner promise) → return the existing tick
   *   - isMorningRoutineActive? → skip entire probe
   *   - per-backend `recovering` skip
   *
   * Quiet hours only suppress the **notification tail** — the DB is
   * still updated. This is deliberate: a user checking the dashboard
   * during quiet hours should see the real state, not stale ok.
   */
  async checkAll(): Promise<void> {
    if (this.probeDisabledFn?.() === true) {
      logger.debug("AuthHealthMonitor.checkAll — skipped (probeDisabled)");
      return;
    }
    if (this.checkAllInFlight) {
      logger.debug(
        "AuthHealthMonitor.checkAll — previous tick still in flight, awaiting",
      );
      return this.checkAllInFlight;
    }
    if (this.isMorningRoutineActiveFn?.() === true) {
      logger.info(
        "AuthHealthMonitor.checkAll — skipped (morning routine active)",
      );
      return;
    }

    const task = this.runCheckAll().finally(() => {
      this.checkAllInFlight = null;
    });
    this.checkAllInFlight = task;
    return task;
  }

  private async runCheckAll(): Promise<void> {
    // Resolve the enabled-backend set ONCE per tick. Disabled backends
    // are skipped at iteration (matching `runKeepaliveSweep`) so we
    // don't burn CLI subprocess cost on rows the router never consults.
    // Stale cache for a re-enabled backend is reseeded via the reactive
    // path on first use, or via the dashboard's "Check auth" button —
    // no need to probe continuously.
    const enabledIds = new Set(
      this.readEnabledBackendIds(),
    );

    // Step 1: snapshot every enabled backend's prev state BEFORE any
    // probe runs, so `shouldNotify` sees the pre-update view
    // (firstExpiredAt / notifiedAt / notificationCount) and not the row
    // we're about to overwrite via `persistCheckResult`. Per-backend
    // try/catch so a locked DB or schema drift on one row doesn't
    // abort the entire sweep — same defensive contract as
    // `recordReactiveAuth*`.
    const snapshots = new Map<BackendId, AuthHealthState | null>();
    for (const backendId of getBackendIds()) {
      if (!this.cores[backendId]) continue;
      if (!enabledIds.has(backendId)) continue;
      try {
        snapshots.set(backendId, this.loadState(backendId));
      } catch (err) {
        logger.warn(
          { err, backendId },
          "AuthHealthMonitor.checkAll — loadState failed during snapshot, treating as unknown",
        );
        snapshots.set(backendId, null);
      }
    }

    // Step 2: probe each non-recovering backend. Two layered try/catch
    // blocks so DB failures during `persistCheckResult` are NOT
    // mislabeled as `network_error` (roadmap critique M1):
    //   (a) probe exception → `network_error` telemetry, DB untouched
    //   (b) persist exception → logged, DB possibly stale but tick
    //       continues for other backends (no telemetry mislabel)
    const results: Array<{
      backendId: BackendId;
      prev: AuthHealthState | null;
      result: AuthCheckResult;
    }> = [];

    for (const [backendId, prev] of snapshots) {
      if (prev?.status === "recovering") {
        logger.debug(
          { backendId },
          "AuthHealthMonitor.checkAll — skipping recovering backend",
        );
        continue;
      }
      const core = this.cores[backendId];
      // Defensive: the snapshot loop above already filtered backends
      // without a registered core, so this branch is unreachable in
      // steady state. Kept as a load-bearing guard if the cores map
      // ever mutates mid-tick.
      /* c8 ignore next */
      if (!core) continue;

      let result: AuthCheckResult;
      try {
        result = await core.checkAuthDetailed();
      } catch (err) {
        // Network / subprocess failure — do NOT flip the cached status.
        // The design spec is explicit: network errors must be
        // distinguishable from revocations so we don't page the user
        // every time their Wi-Fi hiccups.
        this.telemetry.recordProbeResult(backendId, "network_error");
        logger.warn(
          { err, backendId },
          "AuthHealthMonitor.checkAll — probe raised, leaving DB cache untouched",
        );
        continue;
      }

      // Telemetry is recorded BEFORE persist intentionally: the counter
      // tracks "probe observations" (what the CLI reported), not "DB
      // cache updates" (what we successfully wrote). A persist failure
      // leaves telemetry and DB cache temporarily inconsistent, but the
      // alternative (recording after persist) would silently drop the
      // observation — making it invisible to the Analytics dashboard
      // while the operator debugs why the DB cache is stale.
      this.telemetry.recordProbeResult(
        backendId,
        result.status === "ok" ? "ok" : "unauthorized",
      );

      try {
        this.persistCheckResult(backendId, result);
      } catch (err) {
        // DB write failed (locked, schema drift, disk full, etc.).
        // Telemetry has already been recorded above so the observation
        // is not lost. Log + continue so other backends still get
        // their DB updates this tick.
        logger.warn(
          { err, backendId },
          "AuthHealthMonitor.checkAll — persistCheckResult failed, DB cache may be stale for this tick",
        );
        continue;
      }

      results.push({ backendId, prev, result });
    }

    // Step 3: collect the subset that needs a proactive DM.
    const quietHours = this.isQuietHoursFn?.() === true;
    const toNotify: Array<{
      backendId: BackendId;
      result: AuthCheckResult;
      prev: AuthHealthState | null;
    }> = [];

    for (const { backendId, prev, result } of results) {
      if (result.status === "ok") continue;
      if (!this.shouldNotify(result, prev, quietHours)) continue;
      toNotify.push({ backendId, prev, result });
    }

    if (toNotify.length === 0 || !this.notifier) return;

    // Step 4: re-check morning-routine gate (B3). The initial gate in
    // `checkAll()` fires BEFORE the probe loop, so a morning routine
    // that starts mid-probe would sneak past it. Re-verifying here
    // REDUCES the race window from minutes (probe loop) to seconds
    // (DM transmission latency). It is not a hard guarantee —
    // eliminating it entirely would require the routine startup to
    // drain a notification queue, which is out of Phase 4 scope. If
    // the routine is now active, we defer the DM to the next tick —
    // probe results are already persisted, so the dashboard still
    // reflects reality; only the DM is delayed.
    if (this.isMorningRoutineActiveFn?.() === true) {
      logger.info(
        { backends: toNotify.map((t) => t.backendId) },
        "AuthHealthMonitor.checkAll — morning routine became active mid-tick, deferring DM to next probe",
      );
      return;
    }

    // Step 5: send one aggregated DM, then stamp notified_at /
    // notification_count for each backend we notified about. The stamp
    // runs AFTER a successful `notifier.send` so a DM failure leaves
    // the escalation state untouched (we'll retry on the next tick).
    const message = this.buildNotificationMessage(toNotify);
    try {
      await this.notifier.send(message, { kind: "probe_failure" });
    } catch (err) {
      logger.warn(
        { err, backends: toNotify.map((t) => t.backendId) },
        "AuthHealthMonitor.checkAll — notifier.send failed, deferring escalation stamp to next tick",
      );
      return;
    }
    const nowIso = this.now().toISOString();
    for (const { backendId } of toNotify) {
      try {
        this.db
          .prepare(
            `UPDATE backends
                SET auth_notified_at = ?,
                    auth_notification_count = auth_notification_count + 1,
                    updated_at = ?
              WHERE id = ?`,
          )
          .run(nowIso, nowIso, backendId);
      } catch (err) {
        logger.warn(
          { err, backendId },
          "AuthHealthMonitor.checkAll — failed to stamp notified_at (may re-notify next tick)",
        );
      }
    }
  }

  /**
   * Read the set of `enabled = 1` backend ids. Wrapped for defensive
   * DB error handling (consistent with the rest of checkAll — a
   * locked / broken DB should degrade gracefully, not crash the
   * hourly cron handler). On read failure we return an empty set,
   * effectively skipping the tick entirely.
   */
  private readEnabledBackendIds(): BackendId[] {
    try {
      return (
        this.db
          .prepare("SELECT id FROM backends WHERE enabled = 1")
          .all() as Array<{ id: string }>
      )
        .map((r) => r.id)
        .filter((id): id is BackendId => isBackendId(id));
    } catch (err) {
      logger.warn(
        { err },
        "AuthHealthMonitor.checkAll — readEnabledBackendIds failed, skipping tick",
      );
      return [];
    }
  }

  /**
   * Notification decision per design spec §3.3 `shouldNotify`. Pure
   * function of `(current result, prev state, now, quietHours)` so it
   * is trivially unit-testable.
   *
   * Rules:
   *   - ok result → never notify (caller already filtered, but kept
   *     defensive so `shouldNotify` can be called in isolation).
   *   - prev.status is "ok" or "unknown" or null → first observation,
   *     defer to the next tick. `persistCheckResult` has already
   *     stamped `auth_first_expired_at` at this point, so the next
   *     tick will see it and start the grace period countdown.
   *   - prev.firstExpiredAt is null (defensive) → defer.
   *   - no prior notification (notifiedAt == null) → notify iff the
   *     grace period has elapsed. This is the "1st DM" path. **Quiet
   *     hours DO NOT suppress this initial DM** — design spec §3.3
   *     intentionally bypasses quiet hours for the first notification
   *     so that an auth failure is surfaced to the user as close to
   *     real time as possible. The user would rather get a late-night
   *     DM about broken auth than discover it the next morning mid-
   *     workflow.
   *   - prior notification exists → check escalation step. **Escalation
   *     DMs DO respect quiet hours** (the design spec calls these
   *     "quiet reminder"); a 6h / 24h reminder can safely wait until
   *     quiet hours end because the user has already been told once.
   *
   * Note: because NotificationManager has its own quiet-hours gate,
   * the wiring in `index.ts` passes `category: "error"` for probe
   * failure DMs so that the lower layer does NOT silently drop the
   * 1st DM. Without that bypass, shouldNotify returning true during
   * quiet hours would send the DM to a sink that silently discards
   * it AND incorrectly advances our escalation bookkeeping.
   */
  private shouldNotify(
    current: AuthCheckResult,
    prev: AuthHealthState | null,
    quietHours: boolean,
  ): boolean {
    // Defensive: caller (runCheckAll) filters ok before invoking. Kept
    // so a future caller that skips the filter still gets a safe answer.
    /* c8 ignore next */
    if (current.status === "ok") return false;
    // First observation in this failure session — wait for next tick so
    // the grace period has a non-zero duration to measure against. Also
    // covers `prev === null` (brand-new row, no history at all).
    if (!prev || prev.status === "ok" || prev.status === "unknown") {
      return false;
    }
    // Defensive: persistCheckResult stamps firstExpiredAt on every
    // ok→non-ok transition, so any row whose status is non-ok past the
    // guard above also has firstExpiredAt set. Kept so a hand-edited
    // row still produces a safe answer rather than NaN math downstream.
    /* c8 ignore next */
    if (!prev.firstExpiredAt) return false;

    const nowMs = this.now().getTime();
    if (!prev.notifiedAt) {
      // 1st DM — gated only by the grace period. Quiet hours are
      // intentionally NOT checked here (design spec §3.3).
      const graceMin = (nowMs - prev.firstExpiredAt.getTime()) / 60_000;
      return graceMin >= PROACTIVE_GRACE_PERIOD_MIN;
    }
    // Escalation DMs (2nd+) respect quiet hours.
    if (quietHours) return false;
    return this.hasEscalationElapsed(prev, nowMs);
  }

  private hasEscalationElapsed(
    prev: AuthHealthState,
    nowMs: number,
  ): boolean {
    // Defensive: only caller `shouldNotify` invokes this AFTER its own
    // `!prev.notifiedAt` early return, so notifiedAt is always set when
    // we get here. Kept as a typesafe assertion.
    /* c8 ignore next */
    if (!prev.notifiedAt) return false;
    const minutesSince = (nowMs - prev.notifiedAt.getTime()) / 60_000;
    // notificationCount starts at 1 after the first DM. Step index
    // `count - 1` gives the delay from DM #count to DM #(count+1).
    const count = Math.max(1, prev.notificationCount);
    const idx = Math.min(count - 1, ESCALATION_STEPS_MIN.length - 1);
    const threshold = ESCALATION_STEPS_MIN[idx];
    return minutesSince >= threshold;
  }

  /**
   * Build the proactive DM text per design spec §3.4. A single message
   * lists every failing backend with its detail and an actionable
   * recovery command. Tone sharpens once any failing backend has been
   * expired for `URGENT_TONE_DAYS` days — matching the design's
   * "3 days elapsed" escalation row.
   *
   * The `/auth fix <backend>` flows referenced in the design spec
   * arrive in Phase 5 + 6; for Phase 4 the message surfaces the
   * direct CLI command (`codex login` / `gemini`) so the user can
   * recover without waiting for dispatcher support.
   */
  private buildNotificationMessage(
    items: Array<{
      backendId: BackendId;
      prev: AuthHealthState | null;
      result: AuthCheckResult;
    }>,
  ): string {
    const nowMs = this.now().getTime();
    const sharpTone = items.some((item) => {
      const first = item.prev?.firstExpiredAt;
      // Defensive: shouldNotify upstream guarantees every item in
      // `toNotify` has prev.firstExpiredAt set.
      /* c8 ignore next */
      if (!first) return false;
      return (nowMs - first.getTime()) / 86_400_000 >= URGENT_TONE_DAYS;
    });

    const header = sharpTone
      ? `🔑 ⚠️ Authentication has not been recovered for ${URGENT_TONE_DAYS}+ days`
      : "🔑 Backend authentication issue detected";

    const lines: string[] = [header, ""];
    for (const { backendId, result, prev } of items) {
      const detail = result.detail ?? result.status;
      // Defensive: see sharpTone block above; shouldNotify guarantees
      // firstExpiredAt is set on every item that reaches this loop.
      /* c8 ignore next 3 */
      const since = prev?.firstExpiredAt
        ? ` (${formatElapsed(nowMs - prev.firstExpiredAt.getTime())} elapsed)`
        : "";
      lines.push(`• ${backendId}: ❌ ${result.status} — ${detail}${since}`);
    }
    lines.push("");
    lines.push("To recover, run the following in your terminal:");
    for (const { backendId, result } of items) {
      const cmd = result.recoveryCommand ?? defaultRecoveryCommand(backendId);
      lines.push(`  ${cmd}`);
    }
    lines.push("");
    lines.push("(The daemon will auto-detect when recovery is complete.)");
    return lines.join("\n");
  }

  /**
   * Daemon startup hook: if a backend row is stuck in `recovering` (e.g.
   * from a previous crash), reset it to `expired` so the user is re-notified
   * instead of waiting up to an hour for the next probe.
   *
   * **Forward-compat note (roadmap §2.3)**: in v1 no production code path
   * writes `auth_status = 'recovering'`, so this function matches zero
   * rows in practice. It is kept wired up at daemon startup because
   * Phase 5 (Codex device auth) and Phase 6 (Gemini code relay) will
   * introduce `AuthRecovery.initiate*Auth` calls that DO set
   * `recovering`, at which point a daemon crash mid-recovery leaves a
   * stuck row that this function must clean up. Deleting the function
   * in v1 and re-adding it for Phase 5/6 would generate churn without
   * benefit — treat it as a hook that is intentionally dormant until
   * the recovery subprocesses land.
   */
  reconcilePendingRecoveries(): number {
    const info = this.db
      .prepare(
        `UPDATE backends
            SET auth_status = 'expired',
                auth_detail = 'Recovery process lost (daemon restart)',
                updated_at = ?
          WHERE auth_status = 'recovering'`,
      )
      .run(this.now().toISOString());
    return Number(info.changes);
  }

  /** Return the list of backend ids whose cached state is expired or missing. */
  listExpiredBackends(): BackendId[] {
    const rows = this.db
      .prepare(
        "SELECT id FROM backends WHERE auth_status IN ('expired', 'missing') ORDER BY id",
      )
      .all() as Array<{ id: string }>;
    return rows
      .map((r) => r.id)
      .filter((id): id is BackendId => isBackendId(id));
  }

  /** Render a user-facing `/auth status` summary. */
  renderStatusSummary(): string {
    const lines: string[] = ["🔑 Auth Status", ""];
    for (const backendId of getBackendIds()) {
      const state = this.loadState(backendId);
      const status = state?.status ?? "unknown";
      const icon = statusIcon(status);
      const detail = formatStatusDetail(status, state);
      lines.push(`${icon} ${pad(backendId, 12)}— ${detail}`);
    }
    return lines.join("\n");
  }

  /**
   * Keepalive sweep: for every ENABLED backend whose `auth_last_success_at`
   * is older than `keepaliveThresholdDays`, send a reminder DM — unless a
   * reminder was already sent within `keepaliveDedupeDays`.
   *
   * Each backend is processed in its own try/catch so a single notifier
   * failure does not abort the sweep for the remaining backends and leave
   * them without their `auth_keepalive_notified_at` stamp (which would
   * cause next sweep to re-send the same reminder to everyone).
   */
  async runKeepaliveSweep(): Promise<BackendId[]> {
    const reminded: BackendId[] = [];
    if (!this.notifier) return reminded;

    const now = this.now();
    const thresholdMs = this.keepaliveThresholdDays * 86_400_000;
    const dedupeMs = this.keepaliveDedupeDays * 86_400_000;

    // Iterate the canonical backend list (not `Object.keys(this.cores)`)
    // so the sweep is deterministic and we can filter by `enabled = 1`.
    const enabledIds = new Set(
      (
        this.db
          .prepare("SELECT id FROM backends WHERE enabled = 1")
          .all() as Array<{ id: string }>
      )
        .map((r) => r.id)
        .filter((id): id is BackendId => isBackendId(id)),
    );

    for (const backendId of getBackendIds()) {
      if (!this.cores[backendId]) continue;
      if (!enabledIds.has(backendId)) continue;

      const state = this.loadState(backendId);
      if (!state || state.status !== "ok" || !state.lastSuccessAt) continue;

      const idleMs = now.getTime() - state.lastSuccessAt.getTime();
      if (idleMs < thresholdMs) continue;

      if (
        state.keepaliveNotifiedAt
        && now.getTime() - state.keepaliveNotifiedAt.getTime() < dedupeMs
      ) {
        continue;
      }

      const days = Math.floor(idleMs / 86_400_000);
      try {
        await this.notifier.send(
          `💤 ${backendId}: No active use for ${days} days.\n`
            + "Consider running it soon to prevent credential expiration.",
          { kind: "keepalive" },
        );
      } catch (err) {
        logger.warn(
          { err, backendId },
          "runKeepaliveSweep: notifier.send failed — skipping DB stamp so next sweep retries",
        );
        continue;
      }
      try {
        this.db
          .prepare(
            `UPDATE backends
                SET auth_keepalive_notified_at = ?,
                    updated_at = ?
              WHERE id = ?`,
          )
          .run(now.toISOString(), now.toISOString(), backendId);
        this.telemetry.recordKeepaliveReminder(backendId);
        reminded.push(backendId);
        // DB stamp failure after successful notify; SQLite virtually
        // never throws after a write completes, but we leave the catch
        // in place so a hard disk error or schema-locked race surfaces
        // a warning instead of bubbling up to the caller.
        /* c8 ignore start */
      } catch (err) {
        logger.warn(
          { err, backendId },
          "runKeepaliveSweep: DB stamp failed after notify (may re-send next sweep)",
        );
      }
      /* c8 ignore stop */
    }
    return reminded;
  }
}

function parseEnvDays(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function statusIcon(
  status: AuthStatus | "recovering" | "unknown",
): string {
  switch (status) {
    case "ok":
      return "✅";
    case "expiring_soon":
      return "🟡";
    case "expired":
      return "🔴";
    case "missing":
      return "⚫";
    case "recovering":
      return "🔄";
    default:
      return "❓";
  }
}

function formatStatusDetail(
  status: AuthStatus | "recovering" | "unknown",
  state: AuthHealthState | null,
): string {
  if (status === "ok") return "ok";
  if (status === "recovering") return "recovering (re-auth in progress)";
  if (status === "unknown") return "unknown";
  const since = state?.firstExpiredAt
    ? ` (since ${state.firstExpiredAt.toISOString().slice(0, 16).replace("T", " ")})`
    : "";
  return `${status}${since}${state?.detail ? ` — ${state.detail}` : ""}`;
}

function pad(s: string, width: number): string {
  const gap = Math.max(1, width - s.length);
  return s + " ".repeat(gap);
}

/**
 * Render a duration as `{N}d {M}h` / `{M}h {S}m` / `{S}m` depending
 * on magnitude. Only used by the proactive DM builder; never parses
 * back into a number.
 */
function formatElapsed(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hoursAfterDays = Math.floor((totalMinutes - days * 24 * 60) / 60);
  if (days > 0) {
    return hoursAfterDays > 0
      ? `${days}d ${hoursAfterDays}h`
      : `${days}d`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutesAfterHours = totalMinutes - hours * 60;
  if (hours > 0) {
    return minutesAfterHours > 0
      ? `${hours}h ${minutesAfterHours}m`
      : `${hours}h`;
  }
  return `${totalMinutes}m`;
}

/**
 * Default CLI command for recovering a backend's credentials. Used
 * when the probe result doesn't carry a `recoveryCommand` hint. The
 * Gemini command is bare `gemini` because the CLI prompts for
 * re-auth on its next invocation — there's no dedicated subcommand.
 */
function defaultRecoveryCommand(backendId: BackendId): string {
  switch (backendId) {
    case "claude":
      return "claude auth login";
    case "codex":
      return "codex login";
    case "gemini":
      return "gemini";
    case "opencode":
      return "opencode auth login";
  }
}
