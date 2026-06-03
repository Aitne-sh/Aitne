import { z } from "zod";
import { config as loadDotenv } from "dotenv";
import { basename, dirname, isAbsolute, normalize, parse, resolve } from "node:path";
import { homedir } from "node:os";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  DEFAULT_AGENT_DISPLAY_NAME,
  DEFAULT_API_PORT,
  normalizeAgentDisplayName,
} from "@aitne/shared";
import {
  RUNTIME_SETTING_KEYS,
  runtimeSettingsSchema,
  type RuntimeSettings,
} from "./settings/runtime-settings.js";
import {
  clearDegradedMode,
  getDegradedMode,
  isDegraded,
  isSetupCompleted,
  markSetupCompleted,
  setDegradedMode,
} from "./db/runtime-state.js";
import type Database from "better-sqlite3";
import { CONTEXT_RELATIVE_PATHS } from "./core/context-paths.js";
import { inferPathFlavor, isPathInsideOrEqual, slashPath } from "./core/path-compat.js";

loadDotenv();

function env(key: string): string | undefined {
  return process.env[`PA_${key}`];
}

function envOrDefault(key: string, defaultValue: string): string {
  return env(key) ?? defaultValue;
}


const bootstrapConfigSchema = z.object({
  dataDir: z.string().default("~/.personal-agent"),
  workspaceDir: z.string().default("."),
  apiPort: z.number().int().positive().default(DEFAULT_API_PORT),
});

export type BootstrapConfig = z.infer<typeof bootstrapConfigSchema>;
export type AgentConfig = BootstrapConfig & RuntimeSettings;

function expandHome(p: string): string {
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return resolve(homedir(), p.slice(2));
  }
  return resolve(p);
}

function expandHomePreservingRelative(p: string): string {
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return resolve(homedir(), p.slice(2));
  }
  return p;
}

function parseJsonOrDefault<T>(value: string | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function parseNumberOrDefault(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  return Number.isNaN(n) ? fallback : n;
}

function parseBooleanOrDefault(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  return fallback;
}

function parseNullableStringEnv(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "null") return null;
  return trimmed;
}

function normalizeRuntimeSettings(settings: RuntimeSettings): RuntimeSettings {
  const normalized: RuntimeSettings = {
    ...settings,
    agentDisplayName: normalizeAgentDisplayName(settings.agentDisplayName),
    primaryVaultPath: settings.primaryVaultPath
      ? expandHomePreservingRelative(settings.primaryVaultPath)
      : null,
    externalObsidianVaultPath: settings.externalObsidianVaultPath
      ? expandHomePreservingRelative(settings.externalObsidianVaultPath)
      : null,
    whatsappAuthDir: settings.whatsappAuthDir ? expandHome(settings.whatsappAuthDir) : null,
  };
  return normalized;
}

export function loadBootstrapConfig(): BootstrapConfig {
  const config = bootstrapConfigSchema.parse({
    dataDir: envOrDefault("DATA_DIR", "~/.personal-agent"),
    workspaceDir: envOrDefault("WORKSPACE_DIR", "."),
    apiPort: parseNumberOrDefault(env("API_PORT"), DEFAULT_API_PORT),
  });

  return {
    ...config,
    dataDir: expandHome(config.dataDir),
    workspaceDir: expandHome(config.workspaceDir),
  };
}

export function loadDefaultRuntimeSettings(): RuntimeSettings {
  // HOURLY_CHECK_GATE_REDESIGN_PLAN.md Phase 4 — the `gateMode` enum
  // (`off`/`shadow`/`live`) collapsed into a single execution path.
  // Warn-once when an operator still has the legacy env var set so
  // they know the value is now a no-op instead of silently dropping
  // their override. The runtime-settings Zod schema would otherwise
  // ignore the unknown key without any signal.
  if (env("HOURLY_CHECK_GATE_MODE") !== undefined) {
    console.warn(
      "[config] PA_HOURLY_CHECK_GATE_MODE is set but no longer honoured — the hourly_check gate now has a single execution path (see HOURLY_CHECK_GATE_REDESIGN_PLAN.md Phase 4). Remove the env var to silence this warning.",
    );
  }
  const parsed = runtimeSettingsSchema.parse({
    slackOwnerUserId: env("SLACK_OWNER_USER_ID") ?? null,
    telegramOwnerChatId: env("TELEGRAM_OWNER_CHAT_ID") ?? null,
    discordOwnerUserId: env("DISCORD_OWNER_USER_ID") ?? null,
    whatsappEnabled: parseBooleanOrDefault(env("WHATSAPP_ENABLED"), false),
    whatsappOwnerPhone: env("WHATSAPP_OWNER_PHONE") ?? null,
    whatsappAuthDir: env("WHATSAPP_AUTH_DIR") ?? null,
    googleCalendarId: envOrDefault("GOOGLE_CALENDAR_ID", "primary"),
    notionDatabaseIds: parseJsonOrDefault(env("NOTION_DATABASE_IDS"), {}),
    primaryVaultPath: env("PRIMARY_VAULT_PATH") ?? null,
    primaryVaultName: env("PRIMARY_VAULT_NAME") ?? null,
    externalObsidianVaultPath: env("EXTERNAL_OBSIDIAN_VAULT_PATH") ?? null,
    externalObsidianVaultName: env("EXTERNAL_OBSIDIAN_VAULT_NAME") ?? null,
    externalObsidianWatch: parseBooleanOrDefault(
      env("EXTERNAL_OBSIDIAN_WATCH"),
      true,
    ),
    gitAccounts: parseJsonOrDefault(env("GIT_ACCOUNTS"), {}),
    advisorEnabled: parseBooleanOrDefault(env("ADVISOR_ENABLED"), false),
    advisorModel: env("ADVISOR_MODEL") ?? null,
    enforceReadToken: parseBooleanOrDefault(env("ENFORCE_READ_TOKEN"), true),
    maxConcurrentSessions: parseNumberOrDefault(env("MAX_CONCURRENT_SESSIONS"), 3),
    maxReactiveSessions: parseNumberOrDefault(env("MAX_REACTIVE_SESSIONS"), 2),
    executeTimeoutMinutes: parseNumberOrDefault(env("EXECUTE_TIMEOUT_MINUTES"), 60),
    sessionTimeoutDmMinutes: parseNumberOrDefault(env("SESSION_TIMEOUT_DM_MINUTES"), 60),
    sessionTimeoutChannelMinutes: parseNumberOrDefault(env("SESSION_TIMEOUT_CHANNEL_MINUTES"), 30),
    sessionTimeoutDashboardMinutes: parseNumberOrDefault(env("SESSION_TIMEOUT_DASHBOARD_MINUTES"), 120),
    historyInjectionMaxMessages: parseNumberOrDefault(env("HISTORY_INJECTION_MAX_MESSAGES"), 20),
    historyInjectionMaxTokens: parseNumberOrDefault(env("HISTORY_INJECTION_MAX_TOKENS"), 4000),
    historyOtherSurfaceWindowMinutes: parseNumberOrDefault(env("HISTORY_OTHER_SURFACE_WINDOW_MINUTES"), 1440),
    dmStalenessStrict: parseBooleanOrDefault(env("DM_STALENESS_STRICT"), false),
    proactiveForwardChannelTimelineEnabled: parseBooleanOrDefault(env("PROACTIVE_FORWARD_CHANNEL_TIMELINE_ENABLED"), true),
    proactiveForwardForceFreshSession: parseBooleanOrDefault(env("PROACTIVE_FORWARD_FORCE_FRESH_SESSION"), false),
    agentDisplayName: envOrDefault("AGENT_DISPLAY_NAME", DEFAULT_AGENT_DISPLAY_NAME),
    character: envOrDefault("PA_CHARACTER", ""),
    timezone: envOrDefault("TIMEZONE", ""),
    dayBoundaryHour: parseNumberOrDefault(env("DAY_BOUNDARY_HOUR"), 4),
    // See `runtime-settings.ts:monthlyReviewEnabled` for why this defaults
    // off pre-release. Flip via PA_MONTHLY_REVIEW_ENABLED=true or PATCH
    // /api/config; scheduler.ts reads `this.config.monthlyReviewEnabled`
    // at fire time so the flag takes effect on the next month-end without
    // restart.
    monthlyReviewEnabled: parseBooleanOrDefault(env("MONTHLY_REVIEW_ENABLED"), false),
    hourlyCheckEnabled: parseBooleanOrDefault(env("HOURLY_CHECK_ENABLED"), true),
    hourlyCheckIntervalMinutes: parseNumberOrDefault(env("HOURLY_CHECK_INTERVAL_MINUTES"), 60),
    hourlyCheckActiveStartHour: parseNumberOrDefault(env("HOURLY_CHECK_ACTIVE_START_HOUR"), 4),
    hourlyCheckActiveEndHour: parseNumberOrDefault(env("HOURLY_CHECK_ACTIVE_END_HOUR"), 24),
    hourlyCheckMinObservations: parseNumberOrDefault(env("HOURLY_CHECK_MIN_OBSERVATIONS"), 1),
    hourlyCheckStage2Enabled: parseBooleanOrDefault(
      env("HOURLY_CHECK_STAGE2_ENABLED"),
      false,
    ),
    hourlyCheckHeartbeatHours: parseNumberOrDefault(
      env("HOURLY_CHECK_HEARTBEAT_HOURS"),
      4,
    ),
    hourlyCheckLowSignalPendingCeiling: parseNumberOrDefault(
      env("HOURLY_CHECK_LOW_SIGNAL_PENDING_CEILING"),
      0,
    ),
    hourlyCheckPrePassFreshnessMinutes: parseNumberOrDefault(
      env("HOURLY_CHECK_PRE_PASS_FRESHNESS_MINUTES"),
      30,
    ),
    authProbeDisabled: parseBooleanOrDefault(env("AUTH_PROBE_DISABLED"), false),
    authPreflightFreshnessMs: parseNumberOrDefault(env("AUTH_PREFLIGHT_FRESHNESS_MS"), 600000),
    schedulePollIntervalSeconds: parseNumberOrDefault(env("SCHEDULE_POLL_INTERVAL_SECONDS"), 5),
    maxBriefingDelayMinutes: parseNumberOrDefault(env("MAX_BRIEFING_DELAY_MINUTES"), 30),
    maxNotificationsPerHour: parseNumberOrDefault(env("MAX_NOTIFICATIONS_PER_HOUR"), 3),
    maxNotificationsPerDay: parseNumberOrDefault(env("MAX_NOTIFICATIONS_PER_DAY"), 12),
    quietHoursStart: envOrDefault("QUIET_HOURS_START", "22:00"),
    quietHoursEnd: envOrDefault("QUIET_HOURS_END", "08:00"),
    batchIntervalMinutes: parseNumberOrDefault(env("BATCH_INTERVAL_MINUTES"), 15),
    primaryPlatform: envOrDefault("PRIMARY_PLATFORM", "slack"),
    defaultNotificationPlatforms: parseJsonOrDefault(
      env("DEFAULT_NOTIFICATION_PLATFORMS"),
      [],
    ),
    disallowedTools: env("DISALLOWED_TOOLS") !== undefined
      ? parseJsonOrDefault<string[]>(env("DISALLOWED_TOOLS"), [])
      : undefined,
    allowedToolsOverride: parseJsonOrDefault(env("ALLOWED_TOOLS_OVERRIDE"), null),
    claudeExecutionPermissionMode:
      (env("CLAUDE_EXECUTION_PERMISSION_MODE") as
        | "strict"
        | "allow"
        | undefined) ?? "strict",
    codexExecutionPermissionMode:
      (env("CODEX_EXECUTION_PERMISSION_MODE") as
        | "strict"
        | "allow"
        | undefined) ?? "strict",
    geminiExecutionPermissionMode:
      (env("GEMINI_EXECUTION_PERMISSION_MODE") as
        | "strict"
        | "allow"
        | undefined) ?? "strict",
    opencodeExecutionPermissionMode:
      (env("OPENCODE_EXECUTION_PERMISSION_MODE") as
        | "strict"
        | "allow"
        | undefined) ?? "strict",
    opencodeBaseUrl: envOrDefault("OPENCODE_BASE_URL", "http://127.0.0.1:4096"),
    opencodeServerUsername: envOrDefault("OPENCODE_SERVER_USERNAME", "opencode"),
    obsidianDebounceSeconds: parseNumberOrDefault(env("OBSIDIAN_DEBOUNCE_SECONDS"), 5.0),
    gitPollIntervalSeconds: parseNumberOrDefault(env("GIT_POLL_INTERVAL_SECONDS"), 3600),
    gitPushOverdueMinutes: parseNumberOrDefault(env("GIT_PUSH_OVERDUE_MINUTES"), 60),
    gitProjectUpdateDebounceMinutes: parseNumberOrDefault(
      env("GIT_PROJECT_UPDATE_DEBOUNCE_MINUTES"),
      15,
    ),
    githubPollIntervalSeconds: parseNumberOrDefault(env("GITHUB_POLL_INTERVAL_SECONDS"), 1800),
    // Matches calendar/git poller cadence. Previously 60s, but 3 databases
    // × 1440 polls/day ≈ 4320 API calls/day was excessive when the only
    // downstream consumer is hourly_check. Override with
    // PA_NOTION_POLL_INTERVAL_SECONDS if you need closer to real-time
    // Notion sync (at the cost of API quota). If you raise this beyond
    // ~10 min, also raise `NOTION_WRITE_TTL_MS` in `api/routes/notion.ts`
    // so agent writes are still attributed before the poll mark expires.
    notionPollIntervalSeconds: parseNumberOrDefault(env("NOTION_POLL_INTERVAL_SECONDS"), 300),
    calendarPollIntervalSeconds: parseNumberOrDefault(env("CALENDAR_POLL_INTERVAL_SECONDS"), 300),
    gmailPollIntervalSeconds: parseNumberOrDefault(env("GMAIL_POLL_INTERVAL_SECONDS"), 600),
    mcpAutoProbeIntervalMinutes: parseNumberOrDefault(env("MCP_AUTO_PROBE_INTERVAL_MINUTES"), 720),
    delegatedProbeIntervalMinutes: parseNumberOrDefault(env("DELEGATED_PROBE_INTERVAL_MINUTES"), 60),
    enabledMailProviders: parseJsonOrDefault<
      ("gmail" | "outlook" | "yahoo" | "icloud")[]
    >(env("ENABLED_MAIL_PROVIDERS"), ["gmail"]),
    mailPollIntervalSeconds: parseNumberOrDefault(env("MAIL_POLL_INTERVAL_SECONDS"), 180),
    mailIdleEnabled: parseBooleanOrDefault(env("MAIL_IDLE_ENABLED"), true),
    mailIdleInstabilityThreshold: parseNumberOrDefault(env("MAIL_IDLE_INSTABILITY_THRESHOLD"), 3),
    mailIdleFallbackRecoveryMinutes: parseNumberOrDefault(env("MAIL_IDLE_FALLBACK_RECOVERY_MINUTES"), 60),
    mailMaxMessagesPerPoll: parseNumberOrDefault(env("MAIL_MAX_MESSAGES_PER_POLL"), 20),
    mailAuthFailureRetryHours: parseNumberOrDefault(env("MAIL_AUTH_FAILURE_RETRY_HOURS"), 6),
    hourlyObservationCharBudget: parseNumberOrDefault(env("HOURLY_OBSERVATION_CHAR_BUDGET"), 8000),
    prePassMaxAttemptsPerIntegration: parseNumberOrDefault(env("PRE_PASS_MAX_ATTEMPTS_PER_INTEGRATION"), 3),
    prePassBackoffMs: parseJsonOrDefault<number[]>(
      env("PRE_PASS_BACKOFF_MS"),
      [1000, 2000, 4000],
    ),
    prePassRetryEscalationTier: parseNullableStringEnv(env("PRE_PASS_RETRY_ESCALATION_TIER")),
    // docs/design/appendices/pre-pass-fan-out.md §6 — null = unlimited concurrency. Fall back
    // to null (not 0) on an unparseable env value so a typo never kills boot
    // via the downstream Zod `min(1)` check; the Zod parser then validates
    // any genuine numeric override against the [1, 5] range and rejects
    // out-of-range values with a normal config error.
    prePassFanOutConcurrency: (() => {
      const raw = env("PRE_PASS_FAN_OUT_CONCURRENCY");
      if (!raw) return null;
      const n = Number(raw);
      return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : null;
    })(),
    prePassMaxBudgetUsdPerIntegration: parseNumberOrDefault(env("PRE_PASS_MAX_BUDGET_USD_PER_INTEGRATION"), 0.6),
    prePassMaxBudgetUsdPerRoutine: parseNumberOrDefault(env("PRE_PASS_MAX_BUDGET_USD_PER_ROUTINE"), 1.5),
    prePassRetryOnPartial: parseBooleanOrDefault(env("PRE_PASS_RETRY_ON_PARTIAL"), true),
    // cost-reduction-structural §A — observation summarizer.
    observationSummarizerEnabled: parseBooleanOrDefault(
      env("OBSERVATION_SUMMARIZER_ENABLED"),
      true,
    ),
    observationSummarizerConcurrency: parseNumberOrDefault(
      env("OBSERVATION_SUMMARIZER_CONCURRENCY"),
      2,
    ),
    observationSummarizerMaxCallsPerMinute: parseNumberOrDefault(
      env("OBSERVATION_SUMMARIZER_MAX_CALLS_PER_MINUTE"),
      60,
    ),
    observationSummarizerQueueLimit: parseNumberOrDefault(
      env("OBSERVATION_SUMMARIZER_QUEUE_LIMIT"),
      100,
    ),
    observationSummarizerTimeoutMs: parseNumberOrDefault(
      env("OBSERVATION_SUMMARIZER_TIMEOUT_MS"),
      15_000,
    ),
    vipMailSenders: parseJsonOrDefault<string[]>(env("VIP_MAIL_SENDERS"), []),
    outlookDeltaPageSize: parseNumberOrDefault(env("OUTLOOK_DELTA_PAGE_SIZE"), 50),
    outlookGraphConcurrency: parseNumberOrDefault(env("OUTLOOK_GRAPH_CONCURRENCY"), 3),
    imapReconnectBaseMs: parseNumberOrDefault(env("IMAP_RECONNECT_BASE_MS"), 2000),
    imapReconnectMaxMs: parseNumberOrDefault(env("IMAP_RECONNECT_MAX_MS"), 300_000),
    autonomousDailyCostCapUsd: env("AUTONOMOUS_DAILY_COST_CAP_USD")
      ? parseNumberOrDefault(env("AUTONOMOUS_DAILY_COST_CAP_USD"), 5.0)
      : null,
    autonomousMonthlyCostCapUsd: env("AUTONOMOUS_MONTHLY_COST_CAP_USD")
      ? parseNumberOrDefault(env("AUTONOMOUS_MONTHLY_COST_CAP_USD"), 100.0)
      : null,
    // B-007 — overridable at first boot via env. Normally set by the setup
    // wizard after the user answers the two questions; env lets CI / headless
    // installs pre-seed them.
    primaryLanguage: envOrDefault("PRIMARY_LANGUAGE", "en"),
    vaultMode: (env("VAULT_MODE") as "obsidian" | "plain" | undefined) ?? "plain",
  });

  return normalizeRuntimeSettings(parsed);
}

export function loadConfig(): AgentConfig {
  return {
    ...loadBootstrapConfig(),
    ...loadDefaultRuntimeSettings(),
  };
}

export function pickRuntimeSettings(config: AgentConfig): RuntimeSettings {
  const runtimeSlice: Partial<RuntimeSettings> = {};
  for (const key of RUNTIME_SETTING_KEYS) {
    (runtimeSlice as Record<string, unknown>)[key] = config[key];
  }
  return runtimeSettingsSchema.parse(runtimeSlice);
}

export function mergeRuntimeSettingsFromDb(
  config: AgentConfig,
  persistedSettings: Partial<RuntimeSettings>,
): AgentConfig {
  const merged = normalizeRuntimeSettings(
    runtimeSettingsSchema.parse({
      ...pickRuntimeSettings(config),
      ...persistedSettings,
    }),
  );
  Object.assign(config, merged);
  return config;
}

/**
 * Resolve the primary vault location on disk (plan §5.3).
 *
 * - `vaultMode === "obsidian"` + `primaryVaultPath` set + daemon NOT in
 *   degraded mode → returns the user-chosen path.
 * - Otherwise → returns `<dataDir>/context`.
 *
 * Degraded-mode awareness is opt-in via the second argument: pass `db`
 * to get the safe fallback behavior, omit it to get the mode-only
 * resolution. Callers that read files for the agent (context-builder,
 * health monitor, retention sweeps) should pass `db` — reading a stale
 * primary vault during degraded mode is worse than reading the fallback
 * because the primary may be an unmounted network share that throws
 * ENOENT at every access. Callers that only need the configured target
 * (e.g. the dashboard banner surfacing "your vault lives at…") pass
 * nothing.
 *
 * Accepts either a full `AgentConfig` or a minimal `{ dataDir }` shape.
 * The `Partial<...>` on the runtime slice keeps existing narrow callers
 * (e.g. `system-reset.ts`) working while letting new code pass the full
 * config to pick up the obsidian branch.
 */
export function getContextDir(
  config: Pick<BootstrapConfig, "dataDir"> &
    Partial<Pick<RuntimeSettings, "vaultMode" | "primaryVaultPath">>,
  db?: Database.Database,
): string {
  if (config.vaultMode === "obsidian" && config.primaryVaultPath) {
    if (db && isDegraded(db)) {
      return resolve(config.dataDir, "context");
    }
    return config.primaryVaultPath;
  }
  return resolve(config.dataDir, "context");
}

export type VaultValidationError =
  | "not_absolute"
  | "path_traversal"
  | "overlaps_data_dir"
  | "overlaps_external_vault"
  | "system_path"
  | "parent_missing"
  | "not_directory"
  | "not_writable"
  | "overlaps_primary_vault";

export interface VaultValidationResult {
  ok: boolean;
  error?: VaultValidationError;
  message?: string;
  fsInfo?: FsInfo;
}

export interface FsInfo {
  caseSensitive: boolean;
  network: boolean;
  readonly: boolean;
  isCloudSync: "icloud" | "dropbox" | "onedrive" | "gdrive" | null;
}

const POSIX_SYSTEM_PATH_PREFIXES = [
  "/System",
  "/Library/System",
  "/private/var",
  "/usr",
];

const WINDOWS_SYSTEM_PATH_PREFIXES = [
  process.env.SystemRoot,
  "C:\\Windows",
  "C:\\Program Files",
  "C:\\Program Files (x86)",
].filter((value): value is string => !!value);

/**
 * Paths that would otherwise hit SYSTEM_PATH_PREFIXES via realpath but are
 * legitimately user-owned and commonly used for scratch / test vaults.
 *
 * macOS's `mkdtemp(3)` resolves `$TMPDIR` (typically `/var/folders/T/…`)
 * to `/private/var/folders/…` via realpath. The plan deny-lists
 * `/private/var` to keep users out of system data, but `/private/var/folders`
 * is exactly where user processes are supposed to put transient files.
 * Exempt the `folders` subtree specifically rather than weakening the
 * whole `/private/var` rule.
 */
const SYSTEM_PATH_EXEMPTIONS = [
  "/private/var/folders/",
];

function containsOrEquals(outer: string, inner: string): boolean {
  return isPathInsideOrEqual(outer, inner);
}

function overlaps(a: string, b: string): boolean {
  return containsOrEquals(a, b) || containsOrEquals(b, a);
}

function resolveRealPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    // Path doesn't exist yet (e.g., a candidate vault path we'll mkdir).
    // Walk up to the nearest existing ancestor, realpath that, then rejoin
    // the missing tail. Without this, overlap checks see mixed prefixes
    // (one side realpath'd, the other not) and miss genuine overlaps.
    let current = p;
    const missingTail: string[] = [];
    while (current !== "." && current !== "") {
      try {
        const real = realpathSync(current);
        return missingTail.length === 0 ? real : resolve(real, ...missingTail.reverse());
      } catch {
        const root = parse(current).root;
        if (current === root) break;
        missingTail.push(basename(current));
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }
    return p;
  }
}

function detectCloudSync(p: string): FsInfo["isCloudSync"] {
  const normalized = slashPath(p);
  const lower = normalized.toLowerCase();
  if (lower.includes("/mobile documents/icloud~") || lower.includes("/library/mobile documents/")) return "icloud";
  if (/(^|\/)dropbox(\/|$)/i.test(normalized)) return "dropbox";
  if (/(^|\/)onedrive(?:[ -][^/]*)?(\/|$)/i.test(normalized)) return "onedrive";
  if (/(^|\/)(google drive|googledrive|my drive)(\/|$)/i.test(normalized)) return "gdrive";
  return null;
}

function systemPathPrefixes(): string[] {
  return process.platform === "win32"
    ? WINDOWS_SYSTEM_PATH_PREFIXES
    : POSIX_SYSTEM_PATH_PREFIXES;
}

function stripTrailingPathSeparators(p: string): string {
  const root = parse(p).root;
  let next = p;
  while (next.length > root.length && /[\\/]+$/.test(next)) {
    next = next.slice(0, -1);
  }
  return next;
}

/**
 * Inspect filesystem characteristics for a given path.
 * All detections are best-effort and non-blocking; callers use this to
 * surface an informational banner to the user (plan §4.3).
 */
export function getFsInfo(p: string): FsInfo {
  const isCloudSync = detectCloudSync(p);
  const inferredFlavor = inferPathFlavor(p);
  const isForeignPathStyle =
    (process.platform === "win32" && inferredFlavor !== "win32") ||
    (process.platform !== "win32" && inferredFlavor === "win32");
  if (isForeignPathStyle) {
    return {
      caseSensitive: true,
      network: slashPath(p).startsWith("//") && !isCloudSync,
      readonly: false,
      isCloudSync,
    };
  }

  // Writability + network: probe the parent dir so we don't require the
  // vault leaf to exist and we don't leave any trace inside the vault.
  let network = false;
  let readonly = false;
  try {
    const probeDir = dirname(p);
    try {
      accessSync(probeDir, fsConstants.W_OK);
    } catch {
      readonly = true;
    }
    // macOS: `statfs` via node is unavailable without a native module.
    // Heuristic: /Volumes entries that are NOT cloud-sync roots usually
    // imply a network/external mount. Keep conservative; false negatives
    // here are acceptable because this is informational only.
    const normalizedProbeDir = slashPath(probeDir);
    if (
      ((process.platform === "win32" && normalizedProbeDir.startsWith("//"))
        || normalizedProbeDir.startsWith("/Volumes/"))
      && !isCloudSync
    ) {
      network = true;
    }
  } catch {
    // Ignore; defaults stand.
  }

  // Case-sensitivity probe: deliberately write the test file in the PARENT
  // directory, never inside the vault itself. Case-sensitivity is a
  // property of the filesystem, so the parent's answer applies. This keeps
  // the vault directory pristine — no `.pa-case-*` residue even if the
  // unlink below fails.
  let caseSensitive = true;
  try {
    const probeDir = dirname(p);
    const lowerName = `.pa-case-${process.pid}-${Date.now()}`;
    const upperName = lowerName.toUpperCase();
    const lowerPath = resolve(probeDir, lowerName);
    const upperPath = resolve(probeDir, upperName);
    try {
      writeFileSync(lowerPath, "", { flag: "wx" });
      try {
        statSync(upperPath);
        caseSensitive = false;
      } catch {
        caseSensitive = true;
      }
    } finally {
      try {
        unlinkSync(lowerPath);
      } catch {
        // Best effort.
      }
    }
  } catch {
    // If we can't probe, assume case-sensitive (safer default).
  }

  return { caseSensitive, network, readonly, isCloudSync };
}

function probeWritable(p: string): boolean {
  try {
    const marker = resolve(p, `.pa-write-test-${process.pid}-${Date.now()}`);
    writeFileSync(marker, "", { flag: "wx" });
    try {
      unlinkSync(marker);
    } catch {
      // Best effort.
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a candidate primary-vault path per plan §4.1.
 *
 * Accepts a raw user-facing path string:
 * - absolute paths (`/Users/me/Vault`)
 * - `~/...` home-relative paths
 *
 * Relative paths are rejected before normalization so callers cannot
 * accidentally turn `vault` into `<cwd>/vault` and persist it as if the
 * user had chosen an absolute path.
 */
export interface ValidatePrimaryVaultPathOptions {
  /**
   * When true (default), the validator auto-creates the leaf directory if
   * the parent exists. This matches the env-writer / startup semantics —
   * the user is declaring this path IS the vault and the daemon should
   * treat it as writable.
   *
   * When false, the validator is read-only: it checks reachability and
   * writability but does NOT mkdir. This is what the 30-second health
   * probe uses; without the flag the probe would silently re-create a
   * vault directory the user just deleted.
   */
  autoCreate?: boolean;
  /**
   * When true, a missing leaf directory is treated as a valid candidate
   * as long as its parent exists and is writable. Used by the Management
   * Mode settings dialog, where the user may point at a brand-new target
   * directory that should not be created until the migration actually
   * runs. The health probe intentionally leaves this false so a deleted
   * configured vault still degrades.
   */
  allowMissingLeaf?: boolean;
  /**
   * Whether to probe the filesystem for case sensitivity, network mount,
   * cloud sync, etc. Default false because the probe writes a test file
   * into the vault directory (minor pollution) and the result is rarely
   * needed. Opt in at PATCH / setup time when the dashboard wants to
   * surface an "iCloud sync detected" banner.
   */
  collectFsInfo?: boolean;
}

export function validatePrimaryVaultPath(
  rawPath: string,
  config: Pick<BootstrapConfig, "dataDir"> &
    Partial<Pick<RuntimeSettings, "externalObsidianVaultPath">>,
  options: ValidatePrimaryVaultPathOptions = {},
): VaultValidationResult {
  const {
    autoCreate = true,
    allowMissingLeaf = false,
    collectFsInfo = false,
  } = options;
  // Reject literal `..` segments in the raw input BEFORE resolve() silently
  // normalizes them away. A user typing `/Users/me/../other` is ambiguous
  // enough that we make them spell out the canonical path.
  const rawSegments = rawPath.split(/[\\/]/);
  if (rawSegments.includes("..")) {
    return { ok: false, error: "not_absolute", message: "Path must not contain `..` segments." };
  }

  const expanded = expandHomePreservingRelative(rawPath);
  if (!isAbsolute(expanded)) {
    return { ok: false, error: "not_absolute", message: "Path must be absolute." };
  }
  const resolved = resolve(expanded);
  const normalizedInput = stripTrailingPathSeparators(normalize(expanded));
  if (resolved !== normalizedInput) {
    return { ok: false, error: "path_traversal", message: "Path must already be normalized." };
  }

  const real = resolveRealPath(resolved);

  // System-path deny (plan §4.1 item 7): check BOTH the pre-realpath and
  // post-realpath form so a symlink `/opt/mine → /usr/lib/whatever` is
  // caught. Then allow exemptions for known user-writable trees that
  // happen to sit under a system prefix (macOS tmpdir).
  const isExempt = (p: string): boolean =>
    SYSTEM_PATH_EXEMPTIONS.some((allow) => p.startsWith(allow));
  for (const prefix of systemPathPrefixes()) {
    for (const candidate of [resolved, real]) {
      if (containsOrEquals(prefix, candidate) && !isExempt(candidate)) {
        return {
          ok: false,
          error: "system_path",
          message: `Primary vault path must not live under ${prefix}.`,
        };
      }
    }
  }

  const dataReal = resolveRealPath(config.dataDir);

  if (overlaps(dataReal, real)) {
    return {
      ok: false,
      error: "overlaps_data_dir",
      message: `Primary vault path must not overlap dataDir (${dataReal}).`,
    };
  }

  if (config.externalObsidianVaultPath) {
    const externalReal = resolveRealPath(config.externalObsidianVaultPath);
    if (overlaps(externalReal, real)) {
      return {
        ok: false,
        error: "overlaps_external_vault",
        message: "Primary vault path must not overlap the external Obsidian vault.",
      };
    }
  }

  const parent = dirname(real);
  if (!existsSync(parent)) {
    return { ok: false, error: "parent_missing", message: `Parent directory ${parent} does not exist.` };
  }

  if (existsSync(real)) {
    const st = statSync(real);
    if (!st.isDirectory()) {
      return { ok: false, error: "not_directory", message: `${real} exists but is not a directory.` };
    }
    if (!probeWritable(real)) {
      return { ok: false, error: "not_writable", message: `${real} is not writable.` };
    }
  } else if (autoCreate) {
    try {
      mkdirSync(real, { recursive: true });
    } catch {
      return { ok: false, error: "not_writable", message: `Cannot create directory ${real}.` };
    }
    if (!probeWritable(real)) {
      return { ok: false, error: "not_writable", message: `${real} is not writable.` };
    }
  } else if (allowMissingLeaf) {
    if (!probeWritable(parent)) {
      return { ok: false, error: "not_writable", message: `Parent directory ${parent} is not writable.` };
    }
    return collectFsInfo ? { ok: true, fsInfo: getFsInfo(parent) } : { ok: true };
  } else {
    // Read-only probe: the vault leaf doesn't exist and we're not allowed
    // to create it. Report unreachable so the caller (health probe) flips
    // to degraded mode instead of silently re-creating the directory.
    return { ok: false, error: "not_directory", message: `${real} does not exist.` };
  }

  return collectFsInfo ? { ok: true, fsInfo: getFsInfo(real) } : { ok: true };
}

/**
 * Validate a candidate external Obsidian vault path per plan §4.2.
 *
 * Applies all primary-vault checks plus overlap with the primary vault
 * itself — the external watcher must never observe agent writes.
 */
export function validateExternalObsidianVaultPath(
  rawPath: string,
  config: Pick<BootstrapConfig, "dataDir"> & Pick<RuntimeSettings, "primaryVaultPath">,
  options: ValidatePrimaryVaultPathOptions = {},
): VaultValidationResult {
  const base = validatePrimaryVaultPath(rawPath, config, options);
  if (!base.ok) return base;

  if (config.primaryVaultPath) {
    const externalReal = resolveRealPath(resolve(expandHomePreservingRelative(rawPath)));
    const primaryReal = resolveRealPath(config.primaryVaultPath);
    if (overlaps(externalReal, primaryReal)) {
      return {
        ok: false,
        error: "overlaps_primary_vault",
        message: "External Obsidian vault must not overlap the primary vault.",
      };
    }
  }
  return base;
}

const PRIMARY_VAULT_SCHEMA_MARKERS = [
  CONTEXT_RELATIVE_PATHS.today,
  CONTEXT_RELATIVE_PATHS.user.profile,
  CONTEXT_RELATIVE_PATHS.rules.management,
] as const;

function hasPrimaryVaultSchemaMarkers(primaryVaultPath: string): boolean {
  return PRIMARY_VAULT_SCHEMA_MARKERS.some((relativePath) => {
    const fullPath = resolve(primaryVaultPath, relativePath);
    try {
      return existsSync(fullPath) && statSync(fullPath).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * Run one tick of the Management Mode health probe.
 *
 * Exposed as a testable named function so integration tests can simulate
 * the 30-second timer without spinning up `setInterval`. Read-only by
 * design: `autoCreate: false` means if the user deletes the vault
 * directory, the probe flips to degraded rather than silently re-creating
 * it. The degraded-mode banner then tells them what happened. Lifting
 * degraded mode is intentionally stricter than "directory exists": the
 * vault must also contain at least one canonical context marker so the
 * daemon does not resume writes into an empty or wrong directory.
 *
 * Bootstrapping bypass: if `policies/management.md` doesn't exist yet, setup
 * hasn't run; honoring a null primaryVaultPath would break the initial-DM
 * setup flow (which writes via `/api/context/*`, gated by the 503
 * middleware). Skip degraded-mode entirely until setup completes. This
 * matches the CLAUDE.md intuition that `isAutonomousAllowed()` already
 * treats pre-setup as a special state.
 */
export function runVaultHealthProbe(
  config: Pick<BootstrapConfig, "dataDir"> &
    Pick<RuntimeSettings, "vaultMode" | "primaryVaultPath">,
  db: Database.Database,
): { action: "noop" | "entered" | "lifted"; reason?: string } {
  if (config.vaultMode !== "obsidian") {
    if (isDegraded(db)) {
      clearDegradedMode(db);
      return { action: "lifted" };
    }
    return { action: "noop" };
  }

  // Setup-incomplete bootstrapping bypass (latched via runtime_state).
  //
  // First priority: if the `management_mode.setup_completed` marker is
  // already set, setup is done — always run the full degraded check.
  // This protects against transient states where the vault is
  // temporarily unreachable (USB drive unplugged mid-work); a raw
  // filesystem probe would falsely decide "setup incomplete" and
  // disable degraded mode when the user most needs the banner.
  //
  // Second priority: if setup has never been marked complete, probe the
  // filesystem. Setup is considered complete once `policies/management.md`
  // lands anywhere the user could plausibly have pointed their vault at:
  //   - the fallback (`<dataDir>/context`): fresh-install setup with
  //     null primaryVaultPath writes here
  //   - the primary (if set): post-Phase-2 migrated setups live here
  // Either existing is enough to latch the marker. If neither exists,
  // the user has never completed setup and we stay out of their way —
  // forcing degraded on them would 503 the DM-driven setup flow before
  // they can configure anything.
  if (!isSetupCompleted(db)) {
    // CONTEXT_VAULT_REDESIGN: management.md lives under policies/.
    const fallbackRulesPath = resolve(
      config.dataDir,
      "context",
      "policies",
      "management.md",
    );
    const primaryRulesPath = config.primaryVaultPath
      ? resolve(config.primaryVaultPath, "policies", "management.md")
      : null;
    const setupIncomplete =
      !existsSync(fallbackRulesPath) &&
      (primaryRulesPath === null || !existsSync(primaryRulesPath));
    if (setupIncomplete) {
      if (isDegraded(db)) {
        clearDegradedMode(db);
        return { action: "lifted" };
      }
      return { action: "noop" };
    }
    // policies/management.md exists now — latch the marker so
    // subsequent probes skip the filesystem check and treat any
    // unreachability as genuine degradation.
    markSetupCompleted(db);
  }

  const currentState = getDegradedMode(db);
  const nextIssue = (() => {
    if (!config.primaryVaultPath) {
      return {
        reason: "primary_vault_not_configured",
        path: null as string | null,
      };
    }

    const check = validatePrimaryVaultPath(config.primaryVaultPath, config, {
      autoCreate: false,
      collectFsInfo: false,
    });
    if (!check.ok) {
      return {
        reason: "primary_vault_unreachable",
        path: config.primaryVaultPath,
      };
    }

    if (!hasPrimaryVaultSchemaMarkers(config.primaryVaultPath)) {
      return {
        reason: "primary_vault_missing_content",
        path: config.primaryVaultPath,
      };
    }

    return null;
  })();

  if (nextIssue === null) {
    if (currentState) {
      clearDegradedMode(db);
      return { action: "lifted" };
    }
    return { action: "noop" };
  }

  if (!currentState) {
    setDegradedMode(db, {
      ...nextIssue,
      since: new Date().toISOString(),
    });
    return { action: "entered", reason: nextIssue.reason };
  }

  if (currentState.reason !== nextIssue.reason || currentState.path !== nextIssue.path) {
    setDegradedMode(db, {
      ...nextIssue,
      since: new Date().toISOString(),
    });
  }
  return { action: "noop" };
}

export function isRoadmapStale(contextDir: string, maxAgeDays = 15): boolean {
  const roadmapPath = resolve(contextDir, "plans", "roadmap.md");
  if (!existsSync(roadmapPath)) return true;
  const content = readFileSync(roadmapPath, "utf-8");
  if (content.includes("(Not yet configured)")) return true;
  const stat = statSync(roadmapPath);
  const ageDays = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
  return ageDays >= maxAgeDays;
}

export function getDbPath(config: Pick<BootstrapConfig, "dataDir">): string {
  return resolve(config.dataDir, "data", "personal_agent.db");
}

export function getLogsDir(config: Pick<BootstrapConfig, "dataDir">): string {
  return resolve(config.dataDir, "logs");
}

export function getTmpDir(config: Pick<BootstrapConfig, "dataDir">): string {
  return resolve(config.dataDir, "tmp");
}
