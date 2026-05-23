/**
 * Managed Chromium (Approach B / Phase B-1) — local types.
 *
 * Two strictly-isolated Chromium instance families share the same
 * binary but never the same `--user-data-dir`:
 *   - Instance S ("sync context") — holds the Google OAuth refresh
 *     token, receives Chrome Sync. CDP disabled (`--remote-debugging-
 *     port=0`). Never touched by Playwright. THIS PHASE ONLY SHIPS
 *     INSTANCE S.
 *   - Instance A ("automation context") — Playwright-driven, on-demand,
 *     per-workflow profile. Lands in Phase B-2.
 *
 * Reference: MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §5.1–§5.4 +
 * §7.1–§7.9.
 */

import type { SandboxPrimitive } from "../types.js";

/**
 * High-level managed-chromium state machine surfaced to the dashboard
 * and the API status route.
 *
 * Transitions (with the writer that owns each):
 *   off            ← initial; enable=false (the API route writer)
 *   needs_setup    ← enable=true with empty profile dir
 *                    (`maybeRegisterManagedChromium` writer)
 *   missing_binary ← enable=true but `HostProfile.browserBinaryFor` is
 *                    null (bootstrap module writer)
 *   missing_sandbox ← enable=true but the resolved sandbox primitive is
 *                    `none` and the user has not explicitly opted in to
 *                    unsandboxed mode (bootstrap module writer)
 *   ready          ← bootstrap finalize confirmed signed-in
 *                    (setup-bootstrap finalize writer)
 *   needs_reauth   ← reauth-detector observed `sync_silent` /
 *                    `account_changed` / `corrupt_local_state`
 *                    (managed-chromium-supervisor writer)
 *   disconnected   ← user-initiated disconnect via API
 *                    (disconnect route writer)
 *
 * The supervisor reads but never authors transitions from `needs_setup`
 * → `ready`; that transition belongs to the bootstrap finalize step.
 */
export type ManagedChromiumStateValue =
  | "off"
  | "needs_setup"
  | "missing_binary"
  | "missing_sandbox"
  | "ready"
  | "needs_reauth"
  | "disconnected";

/**
 * Persisted under runtime_state key `managed_chromium.state` as a single
 * JSON blob. Atomic read/write keeps the dashboard's status panel and
 * the supervisor's launch decision consistent (the alternative — one
 * key per field — created tear windows where the dashboard could read
 * an enabled flag while the email had not yet been written).
 */
export interface ManagedChromiumState {
  /** Schema version for forward-compat. Bumped on shape changes. */
  schemaVersion: 1;
  /** Master toggle. Persisted independently of `state` so a user who
   *  toggles off mid-bootstrap doesn't lose their state machine. */
  enabled: boolean;
  /** High-level state for the dashboard + supervisor. */
  state: ManagedChromiumStateValue;
  /** Set after bootstrap finalize; null until then. */
  signedInUser: string | null;
  /** Epoch ms of the most recent successful supervisor check. */
  lastCheckAt: number | null;
  /** Epoch ms of the History file mtime as observed at last check. */
  lastSyncAt: number | null;
  /** Number of supervisor rows in the History file at the last check
   *  (when known). Used by the dashboard's "recent rows" badge. */
  recentRowCount: number | null;
  /** Pre-finalize bootstrap state — UI Chromium running interactively. */
  bootstrap: ManagedChromiumBootstrapState | null;
  /** Per-failure-kind DM rate-limit timestamps (epoch ms). */
  lastDmAt: Partial<Record<ManagedChromiumReauthKind, number>>;
  /** Consecutive failure counter for failure-escalation. */
  consecutiveFailures: number;
  /** Paused-until epoch ms after consecutive failures pass threshold. */
  pausedUntil: number | null;
  /** Operator opt-in to unsandboxed mode when no primitive is available
   *  (Linux without bwrap/systemd). Defaults to false. */
  unsandboxedOptIn: boolean;
}

export interface ManagedChromiumBootstrapState {
  /** PID of the UI Chromium spawned for sign-in. */
  pid: number;
  /** Epoch ms past which the supervisor SIGKILLs the orphan PID. */
  deadlineAt: number;
  /** Whether this bootstrap is a reauth (reuse profile dir) or initial. */
  reauth: boolean;
}

/**
 * Reasons the reauth-detector may emit. The supervisor maps each to a
 * distinct DM template + rate-limit bucket so the user gets one DM per
 * kind per day rather than 1/24h regardless of root cause.
 */
export type ManagedChromiumReauthKind =
  | "healthy"
  | "sync_silent"
  | "account_changed"
  | "corrupt_local_state"
  | "signed_out";

export interface ManagedChromiumReauthState {
  kind: ManagedChromiumReauthKind;
  /** When `kind === "account_changed"`, the new signed-in user. */
  to?: string | null;
  /** Diagnostic detail surfaced in DM + audit row. */
  detail?: string;
}

/**
 * Instance S launch config. The supervisor reads this on every tick.
 * `sandbox` is resolved per-OS by `HostProfile.sandboxPrimitive` (with
 * the macOS `.sb` profile path filled in by `sandbox-install.ts`).
 */
export interface ManagedChromiumLaunchConfig {
  binaryPath: string;
  userDataDir: string;
  extraArgs: readonly string[];
  syncFlushWaitSeconds: number;
  checkIntervalMinutes: number;
  sandbox: SandboxPrimitive;
}

/**
 * Default empty state — read by `managed-chromium-state.ts` when the
 * row is absent. Centralised so the supervisor, bootstrap module, and
 * dashboard all see the same defaults.
 */
export const DEFAULT_MANAGED_CHROMIUM_STATE: ManagedChromiumState = {
  schemaVersion: 1,
  enabled: false,
  state: "off",
  signedInUser: null,
  lastCheckAt: null,
  lastSyncAt: null,
  recentRowCount: null,
  bootstrap: null,
  lastDmAt: {},
  consecutiveFailures: 0,
  pausedUntil: null,
  unsandboxedOptIn: false,
};

/** Runtime-state key for the managed-chromium blob (singleton). */
export const MANAGED_CHROMIUM_STATE_KEY = "managed_chromium.state";

/** Profile directory name under PA_DATA_DIR for Instance S. */
export const INSTANCE_S_DIRNAME = "chromium-sync";

/** Profile directory name reserved for Instance A (B-2). */
export const INSTANCE_A_ANON_DIRNAME = "chromium-automation-anon";

/** Profile directory name root for Instance A's per-site authenticated
 *  variant (B-2.5). Each `<siteKey>` lives at
 *  `<PA_DATA_DIR>/chromium-automation-auth/<siteKey>/`. */
export const INSTANCE_A_AUTH_DIRNAME = "chromium-automation-auth";

/** Profile directory name root for Instance A's per-site purchase
 *  variant (B-4, MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §17.5). Each
 *  `<siteKey>` lives at `<PA_DATA_DIR>/chromium-automation-purchase/<siteKey>/`.
 *  Strictly isolated from the auth variant so cookies / localStorage
 *  planted under sign-in do not cross-contaminate the purchase profile,
 *  and so the absolute-block layer's `chromium-automation-purchase/**`
 *  Read/Write deny patterns scope exactly to this tree.
 *
 *  Why a separate dir even though "B-4 is checkout-only" (§17.5):
 *    - keeps the purchase Chromium's cookies isolated from B-2.5 reads
 *      so a leaked A-auth cookie cannot be replayed under the purchase
 *      context (defence-in-depth against the "compromised LLM uses an
 *      auth workflow's session cookie to navigate to a checkout"
 *      attack);
 *    - mirrors the §17.7 absolute-block / classifyChromiumTokenAccess
 *      contract, which already enumerates this directory name. */
export const INSTANCE_A_PURCHASE_DIRNAME = "chromium-automation-purchase";

/** Runtime-state key for the B-4 master toggle. Stored as a `runtime_state`
 *  row whose `value` is `"true"` when enabled. Off by default; the
 *  dashboard's "Enable purchase workflows" modal (§17.8) flips it to
 *  `"true"` after the danger-acknowledgement step. */
export const MANAGED_CHROMIUM_B4_ENABLED_KEY = "managed_chromium.b4_enabled";

/** Per-site per-day token-count default cap. Defensive ceiling against
 *  a buggy or partially-compromised agent issuing many small
 *  confirmation requests in a row. User-overridable per `site_key` in
 *  the B-4 dashboard. Plan §17.3 specifies "Max 5 tokens issued per day
 *  per site_key" verbatim. */
export const B4_DEFAULT_DAILY_TOKEN_CAP = 5;

/** Per-site per-day cumulative-spend default cap, minor units. Stored
 *  per `site_key` alongside a currency code; defaults to ¥30,000 /
 *  $300 / €300 (the absolute number depends on the site's currency).
 *  User-overridable in the B-4 dashboard. Plan §17.3 specifies "Max
 *  cumulative confirmed_amount_minor per day per site_key: ¥30,000
 *  (or user-configured)" verbatim. */
export const B4_DEFAULT_DAILY_SPEND_CAP_MINOR = 30_000;

/** Hard ceiling on the user-reply wait window. Plan §17.2 specifies
 *  "5-minute TTL" verbatim. The workflow's `perWorkflowTimeoutMs` is
 *  set to 6 minutes (5 min DM wait + 1 min navigation budget) so the
 *  pause primitive cannot deadlock past the runner's own watchdog. */
export const B4_TOKEN_TTL_MS = 5 * 60 * 1000;

/** Token shape — the literal prefix the daemon emits in DMs and the
 *  user types back verbatim. Plan §17.2: `!~<8 base32 characters>`. */
export const B4_TOKEN_PREFIX = "!~";

/** Base32 alphabet for the random tail (RFC 4648 — A-Z, 2-7). 8 chars
 *  = 40 bits of entropy; brute-force enumeration under the 5-min TTL
 *  and per-channel rate-limit is infeasible. */
export const B4_TOKEN_BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Length of the base32 tail. Lock these as constants so the regex
 *  `^!~[A-Z2-7]{8}$` used at the messaging adapter boundary stays in
 *  lockstep with the issuer. */
export const B4_TOKEN_TAIL_LENGTH = 8;

/** Full canonical token regex — `^!~[A-Z2-7]{8}$`. Trim before matching;
 *  the messaging adapter applies this against the inbound message body
 *  to detect token-shaped replies before routing to the DM agent. */
export const B4_TOKEN_REGEX = /^!~[A-Z2-7]{8}$/;

/** Default bootstrap deadline (15 min) — generous for human sign-in
 *  including 2FA. Overridable via runtime_state for testing. */
export const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 15 * 60 * 1000;

/** Failure escalation: after this many consecutive failures the
 *  supervisor pauses Instance S for 24h. */
export const PAUSE_AFTER_FAILURES = 3;

/** Pause duration once the failure threshold is hit. */
export const PAUSE_DURATION_MS = 24 * 60 * 60 * 1000;

/** Per-kind DM rate-limit window: one DM per kind per 24h. */
export const DM_RATE_LIMIT_MS = 24 * 60 * 60 * 1000;

/** Reauth-detector mtime stall threshold (6h). */
export const SYNC_SILENT_THRESHOLD_MS = 6 * 60 * 60 * 1000;

/** Supervisor cycle: 5 min. Instance S is the dedicated path; tight
 *  enough that a re-auth DM lands within an hour of the breakage. */
export const DEFAULT_CHECK_INTERVAL_MINUTES = 5;

/** Supervisor's per-cycle health probe wait window after a launch. */
export const DEFAULT_SYNC_FLUSH_WAIT_SECONDS = 30;
