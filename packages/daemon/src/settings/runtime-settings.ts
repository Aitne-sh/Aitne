import { z } from "zod";
import {
  ADVISOR_ALLOWED_MODELS,
  DEFAULT_AGENT_DISPLAY_NAME,
  EXECUTION_PERMISSION_MODES,
  INTEGRATION_KEYS,
  isAdvisorModel,
  isSupportedVoiceLanguage,
  validateAgentDisplayName,
  type EditableRuntimeKey,
} from "@aitne/shared";
import {
  NOTIFICATION_DESTINATION_PLATFORMS,
  isNotificationDestinationPlatform,
} from "../messaging/constants.js";
import { ALWAYS_DISALLOWED_TOOLS } from "../safety/always-disallowed.js";

/**
 * The secret-exfiltration / credential-tampering subset of the absolute-block
 * layer now lives in `safety/always-disallowed.ts` (EXECUTION-MODE-DESIGN.md
 * §6). Import `ALWAYS_DISALLOWED_TOOLS` from there; the old
 * `SENSITIVE_PATH_DISALLOWED_TOOLS` export has been removed as part of
 * consolidating the two previously-parallel lists.
 */

/**
 * Strict-mode seed for `config.disallowedTools`. Composed from the absolute
 * block list (single source at `safety/always-disallowed.ts`) plus the
 * strict-only extras that live OUTSIDE the "enforced in both modes"
 * contract — `chmod`, `chown`, destructive `git` flags. Allow mode skips
 * these per design, Safe mode keeps them.
 */
export const DEFAULT_DISALLOWED_TOOLS = [
  ...ALWAYS_DISALLOWED_TOOLS,
  // Strict-mode extras (not in the absolute-block layer)
  "Bash(chmod *)", "Bash(chown *)",
  "Bash(git push --force *)", "Bash(git push -f *)",
  "Bash(git reset --hard *)", "Bash(git clean *)",
] as const;

/**
 * Shape of a "watched git repository" — projected from the unified
 * `repositories` table by `selectGitWatchedRepos` for legacy consumers
 * (git-watcher, git-delegated-cron, project-doc helpers). Held here as a
 * type-only export so callers don't import from db/repositories-store.ts
 * directly.
 *
 * The unified table is the source of truth — see
 * `docs/design/appendices/unified-repositories.md`. The legacy
 * `gitRepos` / `gitWatchedRepos` / `githubRepos` config keys were removed
 * at cutover.
 */
export const gitWatchedRepoSchema = z.object({
  path: z.string().min(1),
  slug: z.string().min(1).max(80).optional(),
  classification: z.enum(["project", "repo-only"]).default("repo-only"),
  category: z
    .enum(["work", "personal", "research", "client", "other"])
    .default("other"),
  org: z.string().optional(),
  accountAlias: z.string().optional(),
  pollPriority: z.enum(["high", "normal"]).default("normal"),
  /**
   * Per-row poll cadence override (seconds). When null, observers fall back
   * to the global `gitPollIntervalSeconds`. Surfaced from the unified
   * `repositories.poll_interval_sec` column.
   */
  pollIntervalSec: z.number().int().positive().nullable().default(null),
  /**
   * Current GitHub side of the unified repository row, when paired. Optional
   * for legacy test fixtures that still exercise the pre-cutover shape.
   */
  githubRepo: z.string().min(1).nullable().optional(),
  /**
   * Stable id from the `repositories` table — opaque to legacy consumers
   * but required so observers can resolve emitted observations back to a
   * row for downstream trigger evaluation and management lookups.
   */
  repositoryId: z.string().min(1),
});

export type GitWatchedRepoSetting = z.infer<typeof gitWatchedRepoSchema>;
export type GitWatchedRepoSettingInput =
  Omit<z.input<typeof gitWatchedRepoSchema>, "repositoryId">
  & { repositoryId?: string };

/**
 * `gitAccounts` registry — per-alias credential metadata for multi-account
 * Git/GitHub setups (P5 §"Multi-account remotes"). The PAT itself never
 * appears here; when `authMode === "pat-keychain"` the value lives in the
 * OS keychain at `git.account.<alias>` and is fetched via
 * `SecretBroker.getScoped(...)`. The alias matches `^[a-z0-9._-]+$` so the
 * keychain entry name and Hono route segment stay bounded.
 *
 * `host` defaults to `github.com`; set to a self-hosted GHES hostname for
 * a non-public account. `gh-cli-profile` resolves the token via
 * `gh auth token --user <ghProfile> --hostname <host>` at call time, so
 * `gh` remains the credential source of truth and rotation is automatic.
 */
export const GIT_ACCOUNT_ALIAS_PATTERN = /^[a-z0-9._-]+$/;

export const gitAccountSchema = z.object({
  type: z.enum(["github", "gitlab", "generic"]).default("github"),
  authMode: z.enum(["gh-cli-profile", "pat-keychain"]),
  ghProfile: z.string().min(1).max(80).optional(),
  host: z.string().min(1).max(120).default("github.com"),
}).superRefine((value, ctx) => {
  if (value.authMode === "gh-cli-profile" && !value.ghProfile) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["ghProfile"],
      message: "ghProfile is required when authMode is 'gh-cli-profile'",
    });
  }
});

export type GitAccountSetting = z.infer<typeof gitAccountSchema>;

export const runtimeSettingsSchema = z.object({
  slackOwnerUserId: z.string().nullable().default(null),
  telegramOwnerChatId: z.string().nullable().default(null),
  discordOwnerUserId: z.string().nullable().default(null),
  whatsappEnabled: z.boolean().default(false),
  whatsappOwnerPhone: z
    .string()
    .nullable()
    .default(null)
    .refine((v) => v === null || /^\+\d{8,15}$/.test(v), {
      message: "PA_WHATSAPP_OWNER_PHONE must be E.164 (e.g., +818012345678)",
    }),
  whatsappAuthDir: z.string().nullable().default(null),
  googleCalendarId: z.string().default("primary"),
  notionDatabaseIds: z.record(z.string(), z.string()).default({}),

  /**
   * Management Mode — path to a user-chosen directory for the agent's own
   * personal data when `vaultMode === "obsidian"`. Null means "not configured".
   * In plain mode this stays null and `getContextDir` resolves to
   * `<dataDir>/context`. In obsidian mode with a null value, the daemon
   * enters degraded mode at startup until the user picks a path via the
   * Management Mode settings dialog (Phase 2+3).
   */
  primaryVaultPath: z.string().nullable().default(null),
  primaryVaultName: z.string().nullable().default(null),

  /**
   * Path to a SEPARATE Obsidian vault the user maintains for their own
   * note-taking. Unrelated to the agent's primary vault. Reached via the
   * Obsidian CLI skill and watched by `ObsidianWatcher`. Must not overlap
   * the primary vault or `dataDir`.
   */
  externalObsidianVaultPath: z.string().nullable().default(null),
  externalObsidianVaultName: z.string().nullable().default(null),
  /**
   * SETUP-FLOW-REDESIGN-PLAN §6.3 — kill switch for the external-vault
   * branch of `ObsidianWatcher`. When false, the watcher is not registered
   * even if `externalObsidianVaultPath` is set. Default true preserves the
   * pre-redesign behaviour for existing rows. Sized as a runtime setting
   * (mutable via `PATCH /api/config`) so power users with very large
   * vaults can disable churn without dropping the path.
   */
  externalObsidianWatch: z.boolean().default(true),
  /**
   * Legacy `gitRepos`, `gitWatchedRepos`, `githubRepos` were removed at the
   * unified-repositories cutover (docs/design/appendices/unified-repositories.md).
   * Their data now lives in the `repositories` table. `gitAccounts` stays
   * because it is 1:N over rows (one account fans out to many repos) and
   * lives closer to the secret store than to per-repo metadata.
   */
  gitAccounts: z
    .record(
      z.string().regex(GIT_ACCOUNT_ALIAS_PATTERN).max(40),
      gitAccountSchema,
    )
    .default({}),

  /**
   * Server-side advisor tool (Claude Code SDK). When enabled + a model is
   * picked, the agent can call advisor() during a session to get a
   * second-opinion review from advisorModel with the full conversation log.
   * Consumes quota of the selected model. Default off — opt-in via
   * /settings/models or the Pro plan preset.
   */
  advisorEnabled: z.boolean().default(false),
  advisorModel: z
    .string()
    .nullable()
    .default(null)
    .refine((v) => v === null || isAdvisorModel(v), {
      // SDK 0.2.98's `zR6`/`w88` substring check accepts only the IDs in
      // ADVISOR_ALLOWED_MODELS. Bump that constant in shared/ when the
      // SDK extends its allowlist; this refine + the API schema + the
      // dashboard dropdown all derive from there.
      message: `advisorModel must be one of: ${ADVISOR_ALLOWED_MODELS.map((m) => `'${m}'`).join(", ")} (SDK 0.2.98 constraint)`,
    }),

  /**
   * When true (default), ReadSensitive API endpoints reject requests
   * without a valid X-Read-Token or Bearer token with 401.
   * Set to false to log-only (Phase C soft enforcement) during rollout.
   */
  enforceReadToken: z.boolean().default(true),

  maxConcurrentSessions: z.number().int().positive().default(3),
  maxReactiveSessions: z.number().int().positive().default(2),
  /**
   * Delegated-proxy invoker concurrency cap (DELEGATED-PROXY-API-DESIGN.md
   * §4.6 / §12 decision 7). Excess invocations FIFO-queue and 503 with
   * `delegated_proxy_busy` after the queue-wait timeout. Phase A wires the
   * field; Phase C5 surfaces the numeric input on the /settings page.
   */
  delegatedProxyMaxConcurrent: z.number().int().min(1).max(64).default(4),
  /**
   * DELEGATED-TASK-MODE-DESIGN.md §17 — global kill switch for the
   * `/api/integrations/:key/exec` (and Phase 2 `/api/delegated/run`)
   * task-mode endpoints. Default `false` until Phase 1 acceptance is
   * met in production. Mutable at runtime so an emergency disable does
   * not require a daemon restart.
   */
  delegatedTaskModeEnabled: z.boolean().default(false),
  /**
   * §17 — per-agent-day quota for combined `/exec` + `/run` calls.
   * Mirrors the Gemini per-day request counter; resets at the agent-day
   * boundary (`dayBoundaryHour`).
   */
  delegatedTaskMaxPerDay: z.number().int().min(0).max(10000).default(50),
  /**
   * §17 — defaults filled when the request body omits the field. The
   * hard caps in `DELEGATED_TASK_HARD_CAPS` (process-key.ts) bound
   * what the request body may pass; these defaults sit at or below
   * those bounds.
   */
  delegatedTaskDefaultMaxToolCalls: z.number().int().min(1).max(15).default(8),
  delegatedTaskDefaultMaxBudgetUsd: z.number().min(0).max(0.5).default(0.05),
  delegatedTaskDefaultTimeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(300000)
    .default(60000),
  /**
   * §17 — Approve-tier opt-in for `delegated_task_heavy`. When false
   * (default), the heavy ProcessKey falls back to light at routing time
   * so a misconfigured caller can't escalate cost. When true, the
   * dashboard can wire heavy-tier task mode for specific integrations.
   */
  delegatedTaskHeavyEnabled: z.boolean().default(false),
  /**
   * DELEGATED-TASK-MODE-DESIGN.md §13 Phase 3.1 — kill switch for the
   * Claude SDK structured-output path (`outputFormat: { type: 'json_schema',
   * schema }` + `structured_output` consumption). **Defaults `false` until
   * a canary Claude task confirms the API accepts the user's schema
   * shape**: while local Ajv compilation succeeds, the Anthropic
   * structured-output validator is stricter and an unverified rejection
   * would fail every Claude task with a 400. Once verified, flip to
   * `true` from the dashboard / `PATCH /api/config` (mutable at runtime,
   * no restart). When `true`, falls back to text extraction + Ajv on
   * `error_max_structured_output_retries`. No effect on Gemini (CLI
   * lacks the knob) or Codex (Phase 1.5 deferred).
   */
  delegatedTaskStructuredOutputEnabled: z.boolean().default(false),
  /**
   * §13 Phase 3.2 — session-dir warm cache. When true, idle session
   * directories survive past task completion for
   * `delegatedTaskSubprocessPoolTtlSeconds` and are reused on the next
   * task with the same `(backendId, integrationKey | "run", modelId)`
   * pool key. Default `false` — opportunistic optimization, off by
   * default while the pool is observed in production.
   */
  delegatedTaskSubprocessPoolEnabled: z.boolean().default(false),
  delegatedTaskSubprocessPoolTtlSeconds: z
    .number()
    .int()
    .min(1)
    .max(300)
    .default(30),
  /**
   * §13 Phase 3.3 — result cache kill switch. When true AND the request
   * body sets `cacheable: true`, successful read-only task outcomes are
   * cached in-memory with TTL `delegatedTaskCacheTtlSeconds`. Cache hits
   * still write a `delegated_task.exec` audit row with cost 0 and
   * `detail.cacheHit=true` so dashboard accounting stays correct. Default
   * `false`.
   */
  delegatedTaskCacheEnabled: z.boolean().default(false),
  delegatedTaskCacheTtlSeconds: z.number().int().min(1).max(300).default(60),
  delegatedTaskCacheMaxEntries: z.number().int().min(1).max(10000).default(256),
  executeTimeoutMinutes: z.number().int().positive().default(60),
  sessionTimeoutDmMinutes: z.number().int().positive().default(60),
  sessionTimeoutChannelMinutes: z.number().int().positive().default(30),
  sessionTimeoutDashboardMinutes: z.number().int().positive().default(120),
  historyInjectionMaxMessages: z.number().int().positive().default(20),
  historyInjectionMaxTokens: z.number().int().positive().default(4000),
  historyOtherSurfaceWindowMinutes: z.number().int().nonnegative().default(1440),
  /**
   * Structural cost-reduction Stage C kill switch. Default false lets
   * append-only and derived context writes stay quiet so active DM sessions
   * can resume. When true, every prompt-context write is treated as loud,
   * preserving the pre-Stage-C invalidation behavior for strict operators.
   */
  dmStalenessStrict: z.boolean().default(false),
  proactiveForwardChannelTimelineEnabled: z.boolean().default(true),
  proactiveForwardForceFreshSession: z.boolean().default(false),
  agentDisplayName: z.string().default(DEFAULT_AGENT_DISPLAY_NAME).refine(
    (value) => validateAgentDisplayName(value) === null,
    { message: "PA_AGENT_DISPLAY_NAME must be a single line, 40 characters or fewer" },
  ),
  /**
   * User-defined communication style / persona. See docs/design/15-character.md.
   *
   * Cap is 1000 characters — enforced here as the single source of truth
   * (§15.3.1). The two refines reject:
   *   - values containing the `<!-- character:` substring, which would clash
   *     with the block markers SkillsCompiler emits into CLAUDE.md / AGENTS.md
   *     / GEMINI.md in Phase 2;
   *   - values that are non-empty but whitespace-only, which the editor should
   *     treat as "unset" and which would otherwise inject a blank block.
   *
   * Phase 1 still routes this through the Claude SDK `append` path; Phase 2
   * moves the injection into the rendered instruction files.
   */
  character: z
    .string()
    .max(1000)
    .default("")
    .refine(
      (v) => !v.includes("<!-- character:"),
      "character must not contain the block marker substring",
    )
    .refine(
      (v) => !v || v.trim().length > 0,
      "character must be non-blank or empty",
    ),

  timezone: z.string().default("").refine(
    (tz) => {
      if (!tz) return true;
      try {
        Intl.DateTimeFormat(undefined, { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    },
    { message: "Invalid IANA timezone (e.g., 'America/New_York', 'UTC')" },
  ),
  dayBoundaryHour: z.number().int().min(0).max(9).default(4),
  // Monthly Review kill switch — default OFF pre-release. The current
  // task-flow synthesises 30 days of daily files + 4-5 weekly files into
  // a user-facing snapshot whose downstream leverage is unimplemented
  // (`<previous_month>` injection is documented as "未実装" in
  // docs/design/06-memory.md §6.2.8). Cost-to-value ratio is therefore
  // poor in the current shape; the routine stays in-tree as a concept
  // pending the Mirror+Prune redesign (one trend observation + aged
  // carry-over kill/keep decisions, scoped to feed day-1-of-month
  // morning_routine). Re-enable by setting `PA_MONTHLY_REVIEW_ENABLED=true`
  // or PATCH /api/config — the scheduler reads the live flag at fire time
  // so the flip takes effect on the next month-end without restart.
  monthlyReviewEnabled: z.boolean().default(false),
  hourlyCheckEnabled: z.boolean().default(true),
  // Any positive integer in [1, 1440] minutes (1 minute up to 24 hours).
  // Despite the "hourly" name, the operator can dial this anywhere in that
  // range to balance observation latency against quota burn. The cadence
  // is anchored to `hourlyCheckActiveStartHour` (see
  // shouldFireHourlyTickAt in scheduler.ts), so the first fire of each
  // agent-day lands at the start of the active window. The upper bound
  // is 1440 because the modulo gate runs against minutes-since-midnight,
  // which cannot represent multi-day cadence — operators wanting weekly
  // or monthly cadence should use the dedicated review routines.
  hourlyCheckIntervalMinutes: z
    .number()
    .int()
    .min(1, { message: "PA_HOURLY_CHECK_INTERVAL_MINUTES must be >= 1" })
    .max(1440, { message: "PA_HOURLY_CHECK_INTERVAL_MINUTES must be <= 1440 (one day)" })
    .default(60),
  hourlyCheckActiveStartHour: z.number().int().min(0).max(23).default(4),
  hourlyCheckActiveEndHour: z.number().int().min(1).max(24).default(24),
  hourlyCheckMinObservations: z.number().int().nonnegative().default(1),
  /**
   * cost-reduction-structural §B — flag for the optional Stage 2 lite-tier
   * triage. Default `false` so cost remains bounded to Stage 0/1 + Stage 3
   * until shadow telemetry justifies the lite triage budget.
   */
  hourlyCheckStage2Enabled: z.boolean().default(false),
  /**
   * cost-reduction-structural §B — heartbeat window for the gate. Even on
   * a string of quiet ticks, the gate force-runs Stage 2 (or Stage 3 if
   * novelty is non-trivial) every N hours so the signal-compute path is
   * exercised end-to-end and a signal misclassification can't trap the
   * routine in `stage0_silent` indefinitely.
   */
  hourlyCheckHeartbeatHours: z.number().int().min(1).max(48).default(4),
  /**
   * cost-reduction-structural §B — pending-observation ceiling under
   * which low-signal cases still route to Stage 0 silent. The default 0
   * preserves the cautious posture (any pending observation routes to
   * Stage 2 / Stage 3); operators who notice the gate over-escalating on
   * journal noise can dial this up.
   */
  hourlyCheckLowSignalPendingCeiling: z
    .number()
    .int()
    .nonnegative()
    .max(20)
    .default(0),
  /**
   * HOURLY_CHECK_GATE_REDESIGN_PLAN.md §3.4 — minimum minutes between
   * pre-pass spawns for the same integration. The `harvestForGate`
   * step in `HourlyCheckCoordinator.trigger` reads
   * `runtime_state.pre_pass_last_run:<integrationKey>` and skips
   * pre-pass when the prior successful run is more recent than this
   * window. Default 30 — the cron interval is 60 min, so a 30-min
   * window guarantees at most one pre-pass per integration per tick
   * while still firing every tick under normal load.
   *
   * Bounded [0, 240]. `0` disables the freshness gate (pre-pass fires
   * on every tick); 240 (4h) approximates "only fire when the
   * heartbeat would have anyway" for cost-minimal deployments.
   *
   * `forced` runs (`POST /api/agent/run-now`) bypass the gate
   * unconditionally — manual triggers explicitly want a fresh fetch.
   */
  hourlyCheckPrePassFreshnessMinutes: z
    .number()
    .int()
    .min(0)
    .max(240)
    .default(30),
  /**
   * Phase 4 auth health probe kill switch — corresponds to
   * `PA_AUTH_PROBE_DISABLED` per `docs/design/09-safety-cost.md` §9.5.11
   * §7.5. When `true`, `AuthHealthMonitor.checkAll()` is short-circuited at
   * the hourly cron tick so only the reactive path and keepalive reminder
   * remain active. Intended as an emergency switch (e.g. Anthropic /roles
   * endpoint change) and a minimal-v1 operational mode before Phase 4 is
   * fully trusted in production.
   */
  authProbeDisabled: z.boolean().default(false),
  /**
   * Freshness window (ms) for the pre-flight auth cache check in
   * BackendRouter.execute(). A cached `expired`/`missing` status younger
   * than this causes the router to skip main and route to fallback.
   * Default 600000 (10 min). Set to 0 to disable pre-flight entirely.
   */
  authPreflightFreshnessMs: z.number().int().min(0).default(600000),
  schedulePollIntervalSeconds: z.number().int().positive().default(5),

  /**
   * SCHEDULED-DM-IMPLEMENTATION-PLAN §3.6.1 — wall-clock cap for the
   * scheduled.dm session-gate wait. If `now - scheduled_for` exceeds this
   * by the time the dispatcher acquires the owner-DM gates, the briefing
   * is dropped (agent_schedule row marked `skipped`) so a 09:00 briefing
   * never delivers as a 09:45 noise note. Configurable via PATCH
   * /api/config; tunable per user's tolerance for chatty mornings.
   */
  maxBriefingDelayMinutes: z.number().int().nonnegative().default(30),

  maxNotificationsPerHour: z.number().int().positive().default(3),
  maxNotificationsPerDay: z.number().int().positive().default(12),
  quietHoursStart: z.string().default("22:00"),
  quietHoursEnd: z.string().default("08:00"),
  batchIntervalMinutes: z.number().int().positive().default(15),
  primaryPlatform: z.string().default("slack"),
  defaultNotificationPlatforms: z
    .array(z.string())
    .default([])
    .refine(
      (platforms) => platforms.every(isNotificationDestinationPlatform),
      {
        message: `PA_DEFAULT_NOTIFICATION_PLATFORMS must contain only ${NOTIFICATION_DESTINATION_PLATFORMS.join(", ")}`,
      },
    ),

  disallowedTools: z.array(z.string()).default([...DEFAULT_DISALLOWED_TOOLS]),
  allowedToolsOverride: z.array(z.string()).nullable().default(null),

  /**
   * Per-backend tool/sandbox posture. Each backend has an independent
   * strict/allow switch so the user can, for example, keep Claude strict
   * but flip Codex to allow for a one-off exploratory session.
   *
   * - `"strict"` (default): the shipped defense-in-depth behavior for the
   *   given backend — Claude under `permissionMode: "dontAsk"` with
   *   allowlist + curl/jq/file-write hooks; Codex under `--sandbox
   *   workspace-write` with localhost network opt-in; Gemini under
   *   `--approval-mode yolo` with the full whitelist admin policy.
   * - `"allow"`: strong permission mode. For Claude + Gemini the shell-level
   *   context-directory chokepoint and sensitive-path blocks stay enforced
   *   (memory-layer and exfil-surface invariants). Codex in allow mode
   *   runs under `--dangerously-bypass-approvals-and-sandbox`, which
   *   cannot enforce those invariants — the user has explicitly opted into
   *   full sandbox escape on that backend.
   */
  claudeExecutionPermissionMode: z
    .enum(EXECUTION_PERMISSION_MODES)
    .default("strict"),
  codexExecutionPermissionMode: z
    .enum(EXECUTION_PERMISSION_MODES)
    .default("strict"),
  geminiExecutionPermissionMode: z
    .enum(EXECUTION_PERMISSION_MODES)
    .default("strict"),
  opencodeExecutionPermissionMode: z
    .enum(EXECUTION_PERMISSION_MODES)
    .default("strict"),
  opencodeBaseUrl: z
    .string()
    .url()
    .default("http://127.0.0.1:4096"),
  opencodeServerUsername: z.string().min(1).default("opencode"),

  obsidianDebounceSeconds: z.number().positive().default(5.0),

  gitPollIntervalSeconds: z.number().int().positive().default(3600),
  /**
   * `git.local_ahead.stale` threshold (minutes). The watcher fires once
   * the OLDEST unpushed commit on a tracked branch's upstream-ahead range
   * is older than this. Default 60 — short enough to surface forgotten
   * work, long enough that a normal commit-fix-commit-push cycle never
   * trips it. See `docs/design/backlog/git-lifecycle-and-triggers.md`
   * §"Push overdue" and Decision 1 (no hook injection).
   */
  gitPushOverdueMinutes: z.number().int().positive().default(60),
  gitProjectUpdateDebounceMinutes: z.number().int().positive().default(15),
  notionPollIntervalSeconds: z.number().int().positive().default(300),
  calendarPollIntervalSeconds: z.number().int().positive().default(300),
  gmailPollIntervalSeconds: z.number().int().positive().default(600),
  /**
   * GitHub poller cadence. Polls user notifications (ETag-cached, 304s are
   * free) and per-watched-repo failed workflow_runs. With 5 watched repos
   * the worst case is 6 reqs/tick — at 1800s ticks that's 12/hour, well
   * within the 5000/hour authenticated quota. Lower this only if you need
   * faster review-request alerts.
   */
  githubPollIntervalSeconds: z.number().int().min(60).default(1800),

  /**
   * B-003 Phase 4.3 — auto-probe cadence for enabled MCP servers.
   *
   * Every `mcpAutoProbeIntervalMinutes` the observer walks every enabled row
   * in `mcp_servers` and re-issues the same `initialize + tools/list` probe
   * the user would fire manually from the dashboard. Result persists to
   * `last_probe_at` / `last_probe_status`, which feeds the card's status
   * dot, the stale-probe staleness UI, and the rendered tool list.
   *
   * Set to 0 to disable auto-probe entirely. Default 720 min (12 h) — MCP
   * servers rarely change their tool surface between deploys, so once-a-day
   * -ish cadence keeps freshness up without hitting remote endpoints every
   * hour. A recently-probed server (within half the interval) is skipped,
   * so a manual probe doesn't immediately trigger a duplicate.
   *
   * This observer does NOT auto-disable persistently-failing servers.
   * Enable/disable is still a user-approved action (approve-tier mutation).
   * A failing probe just persists the error; the card surfaces it so the
   * user can decide whether to fix credentials, edit config, or disable.
   */
  mcpAutoProbeIntervalMinutes: z.number().int().nonnegative().default(720),

  /**
   * DELEGATED-MODE-V2 §7.1 — periodic re-probe cadence for delegated
   * integrations whose `delegatedBackend` is set. Drives
   * `DelegatedProbeObserver`, which keeps the `integration_probes` cache
   * fresh so `consultDelegatedConnectorHealth` can DM the owner once when
   * the connector signs out (§4.5 / §10 risk row).
   *
   * Default 60 min. Deliberately tighter than `mcpAutoProbeIntervalMinutes`
   * (default 720 / 12 h) — connector OAuth state changes whenever the user
   * signs out of claude.ai or expires a token, which can reasonably happen
   * mid-day, while MCP server tool surfaces rarely change between deploys.
   *
   * Set to 0 to disable the observer entirely (its `start()` short-circuits
   * after logging "disabled"). A recently-probed integration (within half
   * the interval) is skipped so the wizard's manual probe doesn't trigger
   * a duplicate next tick.
   */
  delegatedProbeIntervalMinutes: z.number().int().nonnegative().default(60),

  /**
   * Multi-mail-provider scope gate (see docs/design/appendices/multi-mail-provider.md §6.0).
   * Gates the unified mail-poller. Unselected providers do no polling,
   * consume no tokens, and are invisible to the agent.
   * Default ["gmail"] preserves single-Gmail upgrade behavior.
   */
  enabledMailProviders: z
    .array(z.enum(["gmail", "outlook", "yahoo", "icloud"]))
    .default(["gmail"]),
  // Max bound pairs with the §C6 agent-write-attribution TTL: the route
  // derives TTL from `pollInterval * 2` so a send followed by the very next
  // poll is still within the window. Cap at 1h to keep the derived TTL
  // reasonable and to match §3.8's intent (provider-side quotas still apply
  // at the minute scale, not the hour scale).
  mailPollIntervalSeconds: z.number().int().min(30).max(3600).default(180),
  mailIdleEnabled: z.boolean().default(true),
  mailIdleInstabilityThreshold: z.number().int().positive().default(3),
  mailIdleFallbackRecoveryMinutes: z.number().int().positive().default(60),
  mailMaxMessagesPerPoll: z.number().int().min(1).max(100).default(20),
  mailAuthFailureRetryHours: z.number().int().positive().default(6),
  hourlyObservationCharBudget: z.number().int().positive().default(8000),

  /**
   * docs/design/appendices/pre-pass-fan-out.md §6 — retry and budget controls for the
   * `routine.fetch_window` fan-out coordinator. Fan-out is now the only
   * pre-pass path (Phase 4 cleanup); the runner-level kill switch and
   * per-routine opt-outs that gated the staged rollout are gone.
   *
   * `prePassBackoffMs` length is enforced relative to
   * `prePassMaxAttemptsPerIntegration` via the cross-field `superRefine`
   * below — `length >= maxAttempts - 1` so the loop has a configured
   * backoff for every inter-attempt wait. Extra trailing entries are
   * harmless (the loop never reads past index `attempt - 1`); a too-short
   * array would silently fall back to the last element via
   * `RoutineFetchWindowRunner.backoffForAttempt`, surprising operators
   * who set distinct values intentionally.
   */
  prePassMaxAttemptsPerIntegration: z.number().int().min(1).max(5).default(3),
  prePassBackoffMs: z.array(z.number().int().min(0).max(60_000)).default([
    1000,
    2000,
    4000,
  ]),
  prePassRetryEscalationTier: z
    .enum(["lite", "medium", "high"])
    .nullable()
    .default(null),
  // Cap matches `INTEGRATION_KEYS.length` — the runner spawns at most one
  // sub-session per integration, so a higher value is meaningless and would
  // diverge from `RoutineFetchWindowRunner.fanOutConcurrency`'s clamp.
  prePassFanOutConcurrency: z.number().int().min(1).max(INTEGRATION_KEYS.length).nullable().default(null),
  prePassMaxBudgetUsdPerIntegration: z.number().min(0).default(0.6),
  prePassMaxBudgetUsdPerRoutine: z.number().min(0).default(1.5),
  prePassRetryOnPartial: z.boolean().default(true),

  /**
   * cost-reduction-structural §A — observation summarizer kill switch +
   * tunables. The summarizer runs out-of-band: when disabled, observation
   * rows stay `summary_status='pending'` and hourly_check falls back to
   * the legacy fetch-on-doubt pattern (no regression in correctness; only
   * loss of cost savings).
   */
  observationSummarizerEnabled: z.boolean().default(true),
  observationSummarizerConcurrency: z.number().int().min(1).max(8).default(2),
  observationSummarizerMaxCallsPerMinute: z.number().int().min(1).max(600).default(60),
  observationSummarizerQueueLimit: z.number().int().min(10).max(10_000).default(100),
  observationSummarizerTimeoutMs: z.number().int().min(1_000).max(60_000).default(15_000),

  /**
   * cost-reduction-structural §A — VIP mail senders. Inbound mail from
   * any of these addresses is boosted to a `novelty_score >= 3` floor by
   * the summarizer's pre-filter so a short-shape note from a key contact
   * still routes to today.md. Case-insensitive, exact-match. Empty by
   * default.
   */
  vipMailSenders: z.array(z.string().email()).default([]),
  outlookDeltaPageSize: z.number().int().min(10).max(999).default(50),
  outlookGraphConcurrency: z.number().int().min(1).max(4).default(3),
  imapReconnectBaseMs: z.number().int().positive().default(2000),
  imapReconnectMaxMs: z.number().int().positive().default(300_000),

  /**
   * Safety net for autonomous session cost. When set, the dispatcher skips
   * autonomous sessions whose cumulative daily cost exceeds this cap.
   * Reactive sessions (DMs, mentions) always pass through.
   * Degradation priority: hourly_check → roadmap_refresh → evening_review →
   * morning_routine (last to be cut).
   * Distinct from the removed Phase 9 `maxDailyCostUsd` which blanket-blocked
   * all sessions including reactive DMs — see p9-polling-pivot.md.
   */
  autonomousDailyCostCapUsd: z.number().positive().nullable().default(null),

  /**
   * Notifications-only soft cap on aggregate cost across the current
   * agent month (rolling 30 days from today's agent-day boundary). No
   * dispatcher enforcement — purely an alerting threshold surfaced via
   * `cost-cap-monthly` in the Notifications Center. See
   * docs/design/20-notifications-center.md.
   */
  autonomousMonthlyCostCapUsd: z.number().positive().nullable().default(null),

  /**
   * B-007 §3 P6 — primary language for user-editable prose files
   * (today.md, roadmap.md, user/*.md, daily/*.md, weekly/*.md, monthly/*.md,
   * projects/*.md, rules/management|mcp|journal-format|journal-export.md,
   * routines/*.md, inbox/*.md, _index.md). System prose files
   * (context-index.md, dossiers/*.md, agent/journal.md, agent/scratch/*.md,
   * rules/redaction.md) stay English regardless.
   *
   * Value is an IETF BCP-47 language tag in its shortest meaningful form:
   *   - 2–3 letter primary subtag (`en`, `es`, `de`, `fil`)
   *   - optional region subtag (`en-US`, `en-GB`, `zh-Hans`, `pt-BR`)
   * The regex rejects garbage like `xyz123`, `en_US` (underscore), or the
   * empty string while staying permissive enough for the common cases we
   * actually need to render templates in.
   */
  primaryLanguage: z
    .string()
    .default("en")
    .refine((v) => /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(v), {
      message:
        "primaryLanguage must be a BCP-47 tag (e.g. 'en', 'ja', 'zh-Hans', 'pt-BR')",
    }),

  /**
   * B-007 §2.6 Q8 / §5.9 — vault mode selected during setup.
   *  - "obsidian": user plans to manage context/ with Obsidian. Daily journals
   *    and projects use `[[wikilinks]]`; the `.obsidian/` config directory
   *    is preserved (daemon does not read or delete it).
   *  - "plain": app-only. All links are plain text and `.obsidian/` is
   *    denied by the context API.
   */
  vaultMode: z.enum(["obsidian", "plain"]).default("plain"),

  /**
   * B-004 Phase 1 — dossier injection for routine ProcessKeys. When true
   * (default), `dossiers/<flow>.md` is appended to routine prompts as a
   * carry-forward state block. Flag exists to allow a fast disable if the
   * injection misbehaves in production; the design treats Phase 1 as
   * always-on once B-007 Phase 1 is shipped.
   */
  useReviewDossiers: z.boolean().default(true),

  /**
   * B-004 Phase 2 — `context-index.md`-driven file loading. When true, the
   * routine prompt assembler parses the index and appends files whose
   * `review_flows` tag matches the current flow. Default `false` because the
   * Phase 2 gate ("at least one routine run demonstrates the dossier
   * carrying a useful open item forward" + nightly reconciler) is not yet
   * satisfied — without the reconciler the index drifts from the filesystem.
   */
  useContextIndex: z.boolean().default(false),

  /**
   * Voice transcription opt-in (see docs/design/appendices/voice-transcription.md).
   * Default `false`: inbound audio attachments pass through as file paths
   * without local Whisper inference, and no model weights are downloaded.
   * Flipping to `true` from `/settings/advanced` triggers a one-time model
   * download via `POST /api/voice/install`; the daemon auto-restarts on
   * success so the transcriber initializes with the flag observed.
   */
  voiceTranscriptionEnabled: z.boolean().default(false),

  /**
   * Operator's primary spoken language as a Whisper language code (e.g.
   * `"ja"`, `"en"`). When auto-detection fails — surfacing as the
   * `(speaking in foreign language)` placeholder Whisper emits when its
   * language ID step rolls over to English-default decoding — the
   * transcriber retries with this language forced. Set at install time
   * via `POST /api/voice/install` (the dashboard picker pre-selects from
   * the OS locale). `null` disables the fallback (single-pass auto-detect
   * only — same behaviour the feature shipped with).
   *
   * Distinct from `PA_VOICE_TRANSCRIPTION_LANGUAGE` (env-only, advanced):
   * that one *forces* a single language for every clip and skips
   * auto-detect entirely; this one only kicks in *after* auto-detect
   * fails. If both are set, the env-forced language wins and this field
   * is unused.
   */
  voiceTranscriptionPrimaryLanguage: z
    .string()
    .nullable()
    .default(null)
    .refine(
      (value) => value === null || isSupportedVoiceLanguage(value),
      "voiceTranscriptionPrimaryLanguage must be a Whisper-supported language code (see VOICE_LANGUAGE_FULL).",
    ),
}).superRefine((value, ctx) => {
  // ── Management Mode structural consistency (plan §Phase 1 + §4.1) ──
  //
  // Split-layer validation strategy:
  //
  //   Zod superRefine (here) — STRUCTURAL checks only.
  //     Why: this schema parses on every settings load, including very
  //     early in the boot sequence when env-seeded values may arrive
  //     before vaultMode is reconciled with the DB. Doing sync I/O here
  //     (existsSync / statSync / realpath / write-probe) would couple
  //     every config load to the filesystem and surface ENOENT errors in
  //     unit tests that never touched the paths. Zod is the wrong home
  //     for "is this path reachable right now".
  //
  //   `validatePrimaryVaultPath(...)` in config.ts — FILESYSTEM checks.
  //     Called from env-writer on PATCH /api/config and from
  //     `runVaultHealthProbe` at startup and every 30 s. These are the
  //     moments when the semantic "the path IS the vault" matters.
  //
  // So this block only rejects combinations that cannot be interpreted at
  // all, irrespective of the filesystem:
  //   - `primaryVaultName` set while `primaryVaultPath` is null — an
  //     orphan display name with no path to display.
  //
  // Notably NOT checked here:
  //   - plain mode with a set primaryVaultPath is harmless — getContextDir
  //     ignores the field until vaultMode flips, and the env-seeded test
  //     scenario needs to tolerate this interleaving.
  //   - obsidian mode with null primaryVaultPath — explicitly allowed
  //     (plan §5.4 "degraded mode triggered") and handled by the health
  //     probe, not by Zod.
  if (value.primaryVaultName !== null && value.primaryVaultPath === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["primaryVaultName"],
      message: "primaryVaultName may only be set alongside primaryVaultPath.",
    });
  }

  // docs/design/appendices/pre-pass-fan-out.md §6 — `prePassBackoffMs` must carry at least
  // one entry per inter-attempt wait (`maxAttempts - 1`). A shorter array
  // is a misconfiguration: `RoutineFetchWindowRunner.backoffForAttempt`
  // would silently fall back to the last element for the missing slots,
  // producing identical waits where the operator typed distinct values.
  // Equality-or-greater is allowed — extra trailing entries are harmless
  // (the loop never reads past index `attempt - 1`), and the documented
  // default `[1000, 2000, 4000]` already exceeds the rule for the
  // documented `maxAttempts=3` default. Rejecting overshoot would force
  // operators to keep two fields in lockstep across every PATCH.
  const requiredBackoffs = Math.max(0, value.prePassMaxAttemptsPerIntegration - 1);
  if (value.prePassBackoffMs.length < requiredBackoffs) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["prePassBackoffMs"],
      message:
        `prePassBackoffMs must have at least prePassMaxAttemptsPerIntegration - 1 = `
        + `${requiredBackoffs} entries (got ${value.prePassBackoffMs.length}).`,
    });
  }
});

export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;

export const RUNTIME_SETTING_KEYS = [
  "slackOwnerUserId",
  "telegramOwnerChatId",
  "discordOwnerUserId",
  "whatsappEnabled",
  "whatsappOwnerPhone",
  "whatsappAuthDir",
  "googleCalendarId",
  "notionDatabaseIds",
  "primaryVaultPath",
  "primaryVaultName",
  "externalObsidianVaultPath",
  "externalObsidianVaultName",
  "externalObsidianWatch",
  "gitAccounts",
  "advisorEnabled",
  "advisorModel",
  "enforceReadToken",
  "maxConcurrentSessions",
  "maxReactiveSessions",
  "delegatedProxyMaxConcurrent",
  "delegatedTaskModeEnabled",
  "delegatedTaskMaxPerDay",
  "delegatedTaskDefaultMaxToolCalls",
  "delegatedTaskDefaultMaxBudgetUsd",
  "delegatedTaskDefaultTimeoutMs",
  "delegatedTaskHeavyEnabled",
  "delegatedTaskStructuredOutputEnabled",
  "delegatedTaskSubprocessPoolEnabled",
  "delegatedTaskSubprocessPoolTtlSeconds",
  "delegatedTaskCacheEnabled",
  "delegatedTaskCacheTtlSeconds",
  "delegatedTaskCacheMaxEntries",
  "executeTimeoutMinutes",
  "sessionTimeoutDmMinutes",
  "sessionTimeoutChannelMinutes",
  "sessionTimeoutDashboardMinutes",
  "historyInjectionMaxMessages",
  "historyInjectionMaxTokens",
  "historyOtherSurfaceWindowMinutes",
  "dmStalenessStrict",
  "proactiveForwardChannelTimelineEnabled",
  "proactiveForwardForceFreshSession",
  "agentDisplayName",
  "character",
  "timezone",
  "dayBoundaryHour",
  "monthlyReviewEnabled",
  "hourlyCheckEnabled",
  "hourlyCheckIntervalMinutes",
  "hourlyCheckActiveStartHour",
  "hourlyCheckActiveEndHour",
  "hourlyCheckMinObservations",
  "hourlyCheckStage2Enabled",
  "hourlyCheckHeartbeatHours",
  "hourlyCheckLowSignalPendingCeiling",
  "hourlyCheckPrePassFreshnessMinutes",
  "authProbeDisabled",
  "authPreflightFreshnessMs",
  "schedulePollIntervalSeconds",
  "maxBriefingDelayMinutes",
  "maxNotificationsPerHour",
  "maxNotificationsPerDay",
  "quietHoursStart",
  "quietHoursEnd",
  "batchIntervalMinutes",
  "primaryPlatform",
  "defaultNotificationPlatforms",
  "disallowedTools",
  "allowedToolsOverride",
  "claudeExecutionPermissionMode",
  "codexExecutionPermissionMode",
  "geminiExecutionPermissionMode",
  "opencodeExecutionPermissionMode",
  "opencodeBaseUrl",
  "opencodeServerUsername",
  "obsidianDebounceSeconds",
  "gitPollIntervalSeconds",
  "gitPushOverdueMinutes",
  "gitProjectUpdateDebounceMinutes",
  "notionPollIntervalSeconds",
  "calendarPollIntervalSeconds",
  "gmailPollIntervalSeconds",
  "githubPollIntervalSeconds",
  "mcpAutoProbeIntervalMinutes",
  "delegatedProbeIntervalMinutes",
  "enabledMailProviders",
  "mailPollIntervalSeconds",
  "mailIdleEnabled",
  "mailIdleInstabilityThreshold",
  "mailIdleFallbackRecoveryMinutes",
  "mailMaxMessagesPerPoll",
  "mailAuthFailureRetryHours",
  "hourlyObservationCharBudget",
  "prePassMaxAttemptsPerIntegration",
  "prePassBackoffMs",
  "prePassRetryEscalationTier",
  "prePassFanOutConcurrency",
  "prePassMaxBudgetUsdPerIntegration",
  "prePassMaxBudgetUsdPerRoutine",
  "prePassRetryOnPartial",
  "observationSummarizerEnabled",
  "observationSummarizerConcurrency",
  "observationSummarizerMaxCallsPerMinute",
  "observationSummarizerQueueLimit",
  "observationSummarizerTimeoutMs",
  "vipMailSenders",
  "outlookDeltaPageSize",
  "outlookGraphConcurrency",
  "imapReconnectBaseMs",
  "imapReconnectMaxMs",
  "autonomousDailyCostCapUsd",
  "autonomousMonthlyCostCapUsd",
  "primaryLanguage",
  "vaultMode",
  "useReviewDossiers",
  "useContextIndex",
  "voiceTranscriptionEnabled",
  "voiceTranscriptionPrimaryLanguage",
] as const satisfies readonly (keyof RuntimeSettings)[];

export type RuntimeSettingKey = (typeof RUNTIME_SETTING_KEYS)[number];
export const INTERNAL_RUNTIME_SETTING_KEYS = [
  "enforceReadToken",
  "useReviewDossiers",
  "useContextIndex",
] as const satisfies readonly RuntimeSettingKey[];
export type InternalRuntimeSettingKey = (typeof INTERNAL_RUNTIME_SETTING_KEYS)[number];

const runtimeSettingKeySet = new Set<string>(RUNTIME_SETTING_KEYS);

type MissingEditableRuntimeKeys = Exclude<
  RuntimeSettingKey,
  EditableRuntimeKey | InternalRuntimeSettingKey
>;
const _assertRuntimeSettingCoverage: MissingEditableRuntimeKeys extends never ? true : never = true;

export function isRuntimeSettingKey(value: string): value is RuntimeSettingKey {
  return runtimeSettingKeySet.has(value);
}
