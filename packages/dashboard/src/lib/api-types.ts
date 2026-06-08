import type {
  Alert,
  BackendId,
  BackendModel,
  BrowserHistoryBrowserOverride,
  BrowserHistoryCategory,
  BrowserHistoryLifecycleConfig,
  ExecutionPermissionMode,
  IntegrationKey,
  IntegrationMode,
  ProcessModelTier,
} from "@aitne/shared";

export type { Alert, AlertSeverity, AlertSource } from "@aitne/shared";

// ── Health ──
export interface IntegrationStatus {
  configured: boolean;
  connected: boolean;
  error: string | null;
}

export interface GoogleIntegrationStatus extends IntegrationStatus {
  services: {
    calendar: { connected: boolean; error: string | null };
    gmail: { connected: boolean; error: string | null };
  };
}

export interface WhatsAppIntegrationStatus extends IntegrationStatus {
  state:
    | "ok"
    | "connecting"
    | "awaiting_qr"
    | "disconnected"
    | "logged_out"
    | "disabled"
    | "not_configured";
}

export interface WhatsAppQrResponse {
  /** Scannable PNG data URL ready for `<img src=...>`. */
  dataUrl: string | null;
  /** Raw payload Baileys produced — only useful for debugging. */
  payload: string | null;
  /** ms since epoch when the snapshot was generated. */
  generatedAt: number | null;
  /** ms since epoch when the QR snapshot will be discarded. */
  expiresAt: number | null;
  state:
    | "ok"
    | "connecting"
    | "awaiting_qr"
    | "disconnected"
    | "logged_out"
    | "disabled"
    | "not_initialized";
  error: string | null;
}

// ── Telegram pairing ──
export interface TelegramBotInfoResponse {
  ok: true;
  id: number;
  username: string | null;
  firstName: string | null;
}
export interface TelegramPairingStartResponse {
  pairToken: string;
  deepLink: string;
  qrDataUrl: string;
  expiresAt: number;
  botUsername: string;
}
export interface TelegramPairingStatusResponse {
  paired: boolean;
  ownerChatId: string | null;
  pairingActive: boolean;
}

// ── Slack pairing ──
export interface SlackBotInfoResponse {
  ok: true;
  botUserId: string | null;
  botName: string | null;
  team: string | null;
  url: string | null;
}
export interface SlackPairingStatusResponse {
  paired: boolean;
  ownerUserId: string | null;
  pairingActive: boolean;
}
export interface PhrasePairingStartResponse {
  /** The phrase the user must include in their next DM to the bot. */
  phrase: string;
  /** ms since epoch when this challenge expires. */
  expiresAt: number;
}
export interface SlackManifestResponse {
  manifest: Record<string, unknown>;
  manifestJson: string;
  createAppUrl: string;
  instructions: string[];
}

// ── Discord pairing ──
export interface DiscordBotInfoResponse {
  ok: true;
  id: string;
  username: string;
  discriminator: string | null;
  avatarUrl: string | null;
}
export interface DiscordPairingStatusResponse {
  paired: boolean;
  ownerUserId: string | null;
  pairingActive: boolean;
}

export interface IntegrationStatuses {
  google: GoogleIntegrationStatus;
  appleCalendar?: IntegrationStatus;
  obsidian: IntegrationStatus;
  notion: IntegrationStatus;
  whatsapp: WhatsAppIntegrationStatus;
}

export interface MessagingHealthStatus {
  configured: boolean;
  runtimeState: "ok" | "error" | "not_configured" | "connecting";
  ownerConfigured: boolean;
  ownerChannelKnown: boolean;
  notificationEligible: boolean;
  lastInboundAt: string | null;
  error: string | null;
}

export interface DegradedModeStatus {
  /** Stable machine key, e.g. "primary_vault_unreachable". */
  reason: string;
  /** The configured path that triggered the mode. `null` when not path-related. */
  path: string | null;
  /** ISO timestamp when the daemon first entered this degraded state. */
  since: string;
}

export interface ReleaseAssetConflict {
  path: string;
  reason: "user_modified" | "unknown_base" | "write_failed";
  detail?: string;
  from?: number;
  to?: number;
}

export interface ReleaseAssetsStatus {
  checkedAt: string;
  templates?: {
    checkedAt: string;
    sourceRoot: string | null;
    targetRoot: string;
    added: number;
    autoUpdated: number;
    unchanged: number;
    pending: Array<{ path: string; from: number; to: number }>;
    conflicts: ReleaseAssetConflict[];
    errors: ReleaseAssetConflict[];
    backupRoot: string | null;
  };
  docs?: {
    checkedAt: string;
    sourceRoot: string;
    targetRoot: string;
    added: number;
    autoUpdated: number;
    unchanged: number;
    conflicts: ReleaseAssetConflict[];
    removedFromSource: string[];
    errors: ReleaseAssetConflict[];
    backupRoot: string | null;
  };
  instructionAssets?: {
    checkedAt: string;
    fingerprint: string;
    files: number;
    bytes: number;
  };
  skills?: {
    checkedAt: string;
    builtinShadowedUserSkills: string[];
  };
}

export interface HealthResponse {
  status: string;
  /** Populated when the daemon is in degraded mode; `null` otherwise. Management Mode §5.4. */
  degraded: DegradedModeStatus | null;
  uptime: number;
  /**
   * Notifications Center heartbeat (epoch ms). The dashboard treats
   * `Date.now() - lastTickAt > 90s` as the daemon being frozen.
   * Optional for backward compat with older daemon builds.
   */
  lastTickAt?: number;
  eventBusSize: number;
  activeSessions: number;
  todaySessions: number;
  todayCostUsd: number;
  /** Aggregate cost over the rolling last 30 agent-days. */
  monthCostUsd?: number;
  dbConnected: boolean;
  contextFilesOk: boolean;
  missingContextFiles: string[];
  connectedPlatforms: string[];
  messaging: Record<string, MessagingHealthStatus>;
  notificationDestinations: {
    defaultPlatforms: string[];
    effectiveFallbackPlatforms: string[];
  };
  registeredObservers: string[];
  integrations: IntegrationStatuses;
  /**
   * Integration Delegation Framework — registry-keyed mode + delegated-feature
   * matrix (§4.11). Sibling to the legacy `integrations` field; both coexist
   * until the dashboard cards finish their cutover.
   */
  integrationModes: IntegrationModesMap;
  agentJournal?: {
    exists: boolean;
    weeklySections: number;
    monthlySections: number;
    oversizedSections: string[];
  };
  /**
   * Notifications Center alerts — severity-sorted. Optional for
   * backward compat; older daemon builds don't emit this field.
   */
  alerts?: Alert[];
  /**
   * Release asset reconcile status. Startup uses this to add missing bundled
   * files, refresh unedited generated docs/templates, and preserve edited
   * user files for manual review.
   */
  releaseAssets?: ReleaseAssetsStatus | null;
}

export interface BackendStatusRow {
  id: BackendId;
  enabled: boolean;
  authMethod: string | null;
  authStatus: string;
  authCheckedAt: string | null;
  /** Human-readable detail string from the last checkAuthDetailed() result. */
  authDetail: string | null;
  lastError: string | null;
  webSearchEnabled: boolean;
  webSearchSupported: boolean;
  /** ISO timestamp when auth first transitioned to expired/missing. */
  authFirstExpiredAt: string | null;
  /** ISO timestamp of the last successful execute or auth check. */
  authLastSuccessAt: string | null;
  /** Number of proactive DM notifications sent for this failure episode. */
  authNotificationCount: number;
  /** Whether the CLI binary is currently found on PATH. */
  cliInstalled: boolean;
  /** The CLI binary name (e.g. "claude", "codex", "gemini"). */
  cliCommand: string;
  models: BackendModel[];
}

// ── CLI Install ──
export interface CliInstallMethod {
  id: string;
  label: string;
  command: string;
  executable: string;
  available: boolean;
  recommended: boolean;
  docsUrl: string;
  /** When true, the command cannot be auto-run by the daemon and should
   *  be displayed as a copyable command for the user to run manually. */
  manualOnly: boolean;
}

export interface BackendInstallInfo {
  cliCommand: string;
  installed: boolean;
  methods: CliInstallMethod[];
  docsUrl: string;
}

export interface InstallMethodsResponse {
  platform: string;
  backends: Record<BackendId, BackendInstallInfo>;
}

export interface CliInstallResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cliInstalled: boolean;
}

export interface PricingDataSourceStatus {
  source: "litellm" | "hardcoded";
  fetchedAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  stale: boolean;
  sourceUrl: string;
}

export interface BackendsResponse {
  defaultBackend: BackendId;
  defaultLiteModel: string;
  defaultMediumModel: string;
  defaultHighModel: string;
  pricingDataSource: PricingDataSourceStatus;
  backends: BackendStatusRow[];
}

/**
 * INTEGRATION_NATIVE_MODE_DESIGN.md §11.4 — one entry per integration row
 * cascaded from `native` to `disabled` because its prior `nativeBackend`
 * no longer matches the new main backend. Returned by
 * `PUT /api/backends/main` so the caller can render the "Re-configure"
 * banner inline without round-tripping `/integrations`.
 */
export interface NativeUnboundEntry {
  key: IntegrationKey;
  priorNativeBackend: BackendId;
  newMainBackend: BackendId;
}

/**
 * Shape of the `PUT /api/backends/main` response body, in the only
 * fields the dashboard reads. Carries any native-binding cascade
 * entries (§11.4) alongside the embedded `serializeBackends()` /
 * `serializeProcessConfigs()` payloads (typed loosely here because the
 * caller only needs `nativeUnbound` to surface the banner; the rest is
 * picked up by the next `useBackends()` refetch).
 */
export interface SetMainBackendResponse {
  status: "applied";
  nativeUnbound: NativeUnboundEntry[];
  defaultBackend?: BackendId;
}

// ── Messaging bang commands ──
export interface BuiltInBangCommand {
  command: string;
  name: string;
  title: string;
  description: string;
  details: string[];
  kind: "built_in";
  enabled: boolean;
  runsBackend: boolean;
  availableWhilePaused: boolean;
}

export interface UserBangCommand {
  id: number;
  command: string;
  name: string;
  description: string;
  prompt: string;
  backendId: BackendId;
  modelId: string;
  enabled: boolean;
  enabledSkills: string[] | null;
  instructionMd: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommandsResponse {
  builtInCommands: BuiltInBangCommand[];
  userCommands: UserBangCommand[];
  constraints: {
    namePattern: string;
    maxPromptLength: number;
    maxInstructionMdLength: number;
    reservedCommands: string[];
    availableSkills: string[];
    defaultSkills: string[];
  };
}

export interface UserBangCommandUpsert {
  name: string;
  description?: string;
  prompt: string;
  backendId: BackendId;
  modelId: string;
  enabled?: boolean;
  enabledSkills?: string[] | null;
  instructionMd?: string | null;
}

export interface ProcessBackendConfigRow {
  processKey: string;
  defaultTier: ProcessModelTier;
  mainBackend: BackendId;
  mainModel: string;
  fallbackBackend: BackendId | null;
  fallbackModel: string | null;
  maxTurns: number;
  maxBudgetUsd: number;
  updatedAt: string | null;
  /** 'user' (manual edit, protected from preset re-apply), 'preset'
   *  (written by applyPlanPreset), or null (inherited default row). */
  updatedBy?: string | null;
}

export interface GitWatchedRepoConfig {
  path: string;
  slug?: string;
  classification: "project" | "repo-only";
  category: "work" | "personal" | "research" | "client" | "other";
  org?: string;
  accountAlias?: string;
  pollPriority: "high" | "normal";
}

/**
 * P5 multi-account remote (`gitAccounts[<alias>]`). Mirrors
 * `gitAccountSchema` in `packages/daemon/src/settings/runtime-settings.ts`.
 * Token values never appear here — the dashboard reads `tokenStored`
 * from the `/api/git-accounts` listing instead.
 */
export interface GitAccountConfig {
  type: "github" | "gitlab" | "generic";
  authMode: "gh-cli-profile" | "pat-keychain";
  ghProfile?: string;
  host: string;
}

export interface GitAccountsListEntry {
  alias: string;
  type: GitAccountConfig["type"];
  authMode: GitAccountConfig["authMode"];
  ghProfile: string | null;
  host: string;
  /** True for `pat-keychain` aliases with a stored token; null for `gh-cli-profile`. */
  tokenStored: boolean | null;
}

export interface TaskFlowListEntry {
  key: string;
  hasBundled: boolean;
  hasOverride: boolean;
}

export interface ProcessConfigResponse {
  configs: ProcessBackendConfigRow[];
}

export interface WikiWorkspaceStats {
  rawCount: number;
  wikiCount: number;
  outputCount: number;
  lastIngestAt: string | null;
  lastCompileAt: string | null;
}

export interface WikiRecentCost {
  processKey: string;
  count: number;
  totalCostUsd: number;
  avgCostUsd: number | null;
  lastCostUsd: number | null;
}

export interface WikiBridgeStats {
  candidates: number;
  written: number;
  deduplicated: number;
  lastDetectedAt: string | null;
}

export interface WikiWorkspace {
  id: number;
  name: string;
  kind: "internal" | "external";
  rootPath: string;
  language: string;
  dispatchMode: "parallel" | "serial";
  concurrencyCap: number;
  dmAgentWriteEnabled: boolean;
  bridgeEnabled: boolean;
  // WIKI_BUILDER_DESIGN.md Phase 5 — measurement gate + confidence
  // threshold. Surfaced so the dashboard can render the observation-
  // mode badge during the 2-week pre-write evaluation window.
  bridgeMeasurementOnly: boolean;
  bridgeMinConfidence: number;
  fullCompileApprovalThresholdUsd: number;
  writeStrategy: "fs" | "cli" | "auto";
  gitPreCompileEnabled: boolean;
  isGitRepo?: boolean;
  schemaVersion: number;
  active: boolean;
  lastIngestAt: string | null;
  lastCompileAt: string | null;
  stats: WikiWorkspaceStats;
  bridgeStats: WikiBridgeStats;
  recentCosts: WikiRecentCost[];
}

export interface WikiWorkspacesResponse {
  defaultWorkspace: string;
  defaultInternalRoot: string;
  workspaces: WikiWorkspace[];
}

// WIKI_BUILDER_DESIGN.md Phase 3 — surfaces consumed by `/settings/wiki`
// and `/settings/wiki/timeline`. Shapes match the Hono handlers in
// `packages/daemon/src/api/routes/wiki.ts`.
export interface WikiFileResponse {
  path: string;
  content: string;
  mtime: string;
  sizeBytes: number;
}

export interface WikiIndexResponseEntry {
  path: string;
  sizeBytes: number;
  mtime: string;
}

export interface WikiIndexResponse {
  workspace: string;
  rootPath: string;
  /**
   * The cached `20_wiki/_index.md` snapshot. Internal-mode reads go
   * straight from disk; external-mode reads use the chokidar-backed
   * cache (`WikiIndexCache`).
   */
  indexFile: { exists: boolean; content: string | null };
  files: WikiIndexResponseEntry[];
}

export interface BackendWarning {
  code: string;
  backendId: BackendId;
  message: string;
}

export interface ChatCurrentBindingResponse {
  processKey: string;
  mainBackend: BackendId;
  mainModel: string;
  fallbackBackend: BackendId | null;
  fallbackModel: string | null;
  activeBackend: BackendId;
  activeModel: string;
  activeModelLabel?: string;
  fallbackActive: boolean;
}

// ── Metrics ──
export interface MetricsResponse {
  collectedAt: string;
  notificationConfirmRate: number | null;
  notificationCounts: {
    delivered: number;
    reacted: number;
    suppressed: number;
  };
  advisorCallRate: number | null;
  proactiveForwardResume: {
    injected: number;
    disavowed: number;
    ratio: number | null;
    threshold: number;
  };
  modelCounts: {
    sonnetSessions: number;
    opusSessions: number;
  };
  responseTime: {
    p50: number | null;
    p90: number | null;
    p95: number | null;
    p99: number | null;
    avg: number | null;
  };
  cost: {
    todayUsd: number;
    last7dUsd: number;
    last30dUsd: number;
  };
  sessions: {
    todayTotal: number;
    todayAutonomous: number;
    todayReactive: number;
  };
}

// ── Metrics Timeseries ──
export interface MetricsDailyBucket {
  date: string;
  executions: number;
  executionsReactive: number;
  executionsAutonomous: number;
  failures: number;
  contextUpdatesAutonomous: number;
  contextUpdatesReactive: number;
  avgDurationMs: number | null;
  notificationsDelivered: number;
  notificationsReacted: number;
}

export interface MetricsErrorGroup {
  category: string;
  count: number;
  lastSeen: string;
  backend: string | null;
  sampleMessage: string;
}

export interface MetricsHeatmapDay {
  date: string;
  count: number;
}

export interface MetricsTimeseriesResponse {
  days: number;
  daily: MetricsDailyBucket[];
  recentErrors: MetricsErrorGroup[];
  heatmap: MetricsHeatmapDay[];
}

// ── Events ──
export interface EventRow {
  id: number;
  event_id: string;
  action_type: string;
  trigger: string;
  model_used: string | null;
  /**
   * JSON payload of `Record<modelId, { inputTokens, outputTokens, costUsd }>`
   * — what the SDK actually billed, broken down per model. May differ from
   * `model_used` (the requested model) when the SDK silently routes to a
   * sibling model (e.g. opus-4-7 → opus-4-6[1m]). Null for non-LLM rows.
   */
  model_usage_json: string | null;
  cost_usd: number;
  tokens_input: number;
  tokens_output: number;
  cache_creation_tokens: number | null;
  cache_read_tokens: number | null;
  duration_ms: number;
  num_turns: number;
  result: string;
  detail: string | null;
  started_at: string;
  completed_at: string | null;
  error: string | null;
}

export interface EventsResponse {
  events: EventRow[];
  pagination: Pagination;
}

// ── Conversations ──
export interface ConversationRow {
  id: number;
  platform: string;
  channel_id: string;
  thread_id: string | null;
  model: string;
  status: string;
  message_count: number;
  started_at: string;
  last_message_at: string;
  summary: string | null;
  source_platforms: string[];
  read_only_from_dashboard: boolean;
  continue_available: boolean;
}

export interface ConversationsResponse {
  conversations: ConversationRow[];
  pagination: Pagination;
}

export interface MessageAttachmentRow {
  id: string;
  direction: "inbound" | "outbound";
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  caption: string | null;
}

export interface MessageRow {
  id: number;
  role: string;
  content: string;
  platform: string;
  sender_id: string | null;
  timestamp: string;
  attachments?: MessageAttachmentRow[];
}

export interface ConversationMessagesResponse {
  messages: MessageRow[];
  hasMore: boolean;
}

// ── Cost ──
export interface CostResponse {
  period: string;
  today: { costUsd: number; sessions: number };
  byPeriod: { period: string; total_cost: number; session_count: number; total_input_tokens: number; total_output_tokens: number }[];
  byModel: { model: string; total_cost: number; session_count: number }[];
  byEventType: { event_type: string; total_cost: number; session_count: number }[];
  byBackend: { backend: BackendId; total_cost: number; session_count: number }[];
  byBackendPeriod: { period: string; backend: BackendId; total_cost: number; session_count: number }[];
}

// ── Config ──
export interface ConfigResponse {
  maxConcurrentSessions: number;
  maxReactiveSessions: number;
  delegatedProxyMaxConcurrent: number;
  executeTimeoutMinutes: number;
  agentDisplayName: string;
  sessionTimeoutDmMinutes: number;
  sessionTimeoutChannelMinutes: number;
  sessionTimeoutDashboardMinutes: number;
  timezone: string;
  dayBoundaryHour: number;
  monthlyReviewEnabled: boolean;
  hourlyCheckEnabled: boolean;
  hourlyCheckIntervalMinutes: number;
  hourlyCheckActiveStartHour: number;
  hourlyCheckActiveEndHour: number;
  hourlyCheckMinObservations: number;
  authPreflightFreshnessMs: number;
  maxNotificationsPerHour: number;
  maxNotificationsPerDay: number;
  quietHoursStart: string;
  quietHoursEnd: string;
  batchIntervalMinutes: number;
  primaryPlatform: string;
  defaultNotificationPlatforms: string[];
  slackConfigured: boolean;
  slackOwnerUserConfigured: boolean;
  telegramConfigured: boolean;
  telegramOwnerChatConfigured: boolean;
  discordConfigured: boolean;
  discordOwnerUserConfigured: boolean;
  notionConfigured: boolean;
  githubConfigured: boolean;
  githubWebhookSecretConfigured: boolean;
  apiTokenConfigured: boolean;
  whatsappEnabled: boolean;
  whatsappOwnerPhoneConfigured: boolean;
  whatsappAuthDir: string;
  disallowedTools: string[];
  allowedTools: string[];
  claudeExecutionPermissionMode: ExecutionPermissionMode;
  codexExecutionPermissionMode: ExecutionPermissionMode;
  geminiExecutionPermissionMode: ExecutionPermissionMode;
  opencodeExecutionPermissionMode: ExecutionPermissionMode;
  opencodeBaseUrl: string;
  opencodeServerUsername: string;
  primaryVaultPath: string;
  primaryVaultName: string;
  externalObsidianVaultPath: string;
  externalObsidianVaultName: string;
  /**
   * SETUP-FLOW-REDESIGN-PLAN §6.3 — kill switch for the external-vault
   * branch of `ObsidianWatcher`. Default true preserves pre-redesign
   * behaviour; the Note step exposes a checkbox that toggles this flag.
   */
  externalObsidianWatch: boolean;
  /**
   * SETUP-FLOW-REDESIGN-PLAN §6.1 — true when the BYOA Outlook client
   * config (`mail:outlook:client-config` blob) is present. The dashboard
   * uses this to decide whether direct-mode Outlook integrations are
   * resumable without a one-shot setup form.
   */
  outlookClientConfigConfigured: boolean;
  gitRepos: string[];
  gitWatchedRepos: GitWatchedRepoConfig[];
  gitAccounts: Record<string, GitAccountConfig>;
  githubRepos: string[];
  apiPort: number;
  googleCalendarId: string;
  notionDatabaseIds: Record<string, string>;
  googleCalendarCredentialsConfigured: boolean;
  googleCalendarTokenConfigured: boolean;
  googleCredentialType: "oauth2" | "service_account" | null;
  character: string;
  historyInjectionMaxMessages: number;
  historyInjectionMaxTokens: number;
  dmStalenessStrict: boolean;
  obsidianDebounceSeconds: number;
  schedulePollIntervalSeconds: number;
  gitPollIntervalSeconds: number;
  githubPollIntervalSeconds: number;
  gitPushOverdueMinutes: number;
  gitProjectUpdateDebounceMinutes: number;
  notionPollIntervalSeconds: number;
  calendarPollIntervalSeconds: number;
  gmailPollIntervalSeconds: number;
  browserHistoryConsentAccepted: boolean;
  browserHistoryBrowserOverrides: Record<string, BrowserHistoryBrowserOverride>;
  browserHistoryCategories: BrowserHistoryCategory[];
  browserHistoryRetentionDays: number;
  browserHistorySearchQueryRetentionDays: number;
  browserHistoryLifecycle: BrowserHistoryLifecycleConfig;
  browserHistoryResearchDomainAllowlist: string[];
  browserHistoryResearchDomainDenylist: string[];
  mcpAutoProbeIntervalMinutes: number;
  authProbeDisabled: boolean;
  autonomousDailyCostCapUsd: number | null;
  autonomousMonthlyCostCapUsd: number | null;
  // Feedback Learning Loop (FEEDBACK_LEARNING_LOOP_DESIGN.md §9 Phase 5) —
  // tuned from the Lessons settings page.
  feedbackLearningEnabled: boolean;
  feedbackPromotionThreshold: number;
  feedbackLessonMaxBytesGlobal: number;
  feedbackLessonMaxBytesPerAgent: number;
  feedbackLessonStaleDays: number;
  feedbackSignalRetentionDays: number;
  primaryLanguage: string;
  vaultMode: "obsidian" | "plain";
  /**
   * Absolute path the daemon will write primary context files to, given
   * the current `vaultMode` + `primaryVaultPath`. Does not reflect
   * degraded-mode fallback — this is the *configured* target.
   */
  contextDir: string;
}

// ── Feedback Learning Loop — lesson stores (GET /api/feedback/lessons) ──
// FEEDBACK_LEARNING_LOOP_DESIGN.md §9 Phase 5. Read-only cap-utilisation
// overview rendered by the Lessons settings page; the file bodies are
// read/edited through GET/PUT /api/context/<path>.
export interface LessonStore {
  /** Canonical scope label (`agent` / `agent:<slug>`). */
  scope: string;
  /** Writable-vault relative path (without leading slash). */
  path: string;
  /** False when no consolidation pass has created the store yet. */
  exists: boolean;
  lastModified: string | null;
  bytes: number;
  capBytes: number;
  entries: number;
  maxEntries: number;
  active: number;
  provisional: number;
  overCap: boolean;
}

export interface FeedbackLessonsResponse {
  enabled: boolean;
  promotionThreshold: number;
  pendingSignals: number;
  stores: LessonStore[];
}

// ── Management Mode (migration endpoint) ──
export type MigrationConflictPolicy = "abort" | "merge" | "overwrite_agent_files";

export interface ValidateVaultPathResponse {
  ok: true;
  targetDir: string;
  fsInfo: {
    caseSensitive: boolean;
    network: boolean;
    readonly: boolean;
    isCloudSync: "icloud" | "dropbox" | "onedrive" | "gdrive" | null;
  } | null;
  conflict: {
    kind: "target_has_unrelated_files" | "target_has_agent_file_conflicts";
    entries: string[];
    allowedPolicies: MigrationConflictPolicy[];
  } | null;
}

export interface DirectoryPickerResponse {
  status: "selected" | "cancelled" | "unavailable";
  path?: string;
  message?: string;
  method?: "osascript" | "powershell" | "zenity" | "kdialog" | "yad";
}

export interface ContextMigrationProgressEvent {
  type: "context_migration_progress";
  phase:
    | "preflight"
    | "backup"
    | "move"
    | "verify"
    | "db_rewrite"
    | "settings_update"
    | "resume"
    | "completed"
    | "failed";
  status: "running" | "completed" | "failed";
  message: string;
  target: string;
  progress: number;
  timestamp: string;
}

export interface MigrationSuccessResponse {
  status: "migrated";
  from: string;
  to: string;
  filesMoved: number;
  bytes: number;
  durationMs: number;
  backupPath: string | null;
  backupExpiresAt: string | null;
  fsInfo: {
    caseSensitive: boolean;
    network: boolean;
    readonly: boolean;
    isCloudSync: "icloud" | "dropbox" | "onedrive" | "gdrive" | null;
  } | null;
  resumeStatus: "resumed" | "manual_required";
  manualActionRequired?: boolean;
  message?: string;
  resumeFailures?: string[];
}

export interface MigrationNoopResponse {
  status: "noop";
  from: string;
  to: string;
}

/** Discriminator for the successful 200-range responses. */
export type MigrationOkResponse = MigrationSuccessResponse | MigrationNoopResponse;

/** Thrown as ApiError.body when the migration endpoint returns non-2xx. */
export interface MigrationErrorBody {
  error:
    | "invalid_request"
    | "target_invalid"
    | "sessions_active"
    | "executions_active"
    | "migration_in_progress"
    | "target_has_unrelated_files"
    | "target_has_agent_file_conflicts"
    | "backup_failed"
    | "move_failed"
    | "move_verification_failed"
    | "db_rewrite_failed"
    | "settings_update_failed"
    | "cross_fs_partial_failure"
    | "icloud_file_evicted"
    | "internal_error";
  message: string;
  detail?: string;
  entries?: string[];
  sessions?: Array<{ id: number; scope: string; scope_key: string }>;
  executions?: Array<Record<string, unknown>>;
  rollbackStatus?: "completed" | "partial" | "manual_required";
  backupPath?: string | null;
}

/** Zod schema defaults for all editable keys — from GET /config/defaults.
 *  Shape differs from ConfigResponse: uses raw editable keys (e.g.
 *  `allowedToolsOverride` is returned as `allowedTools`), does not include
 *  derivative boolean flags like `slackConfigured`.  Fields that exist in
 *  ConfigResponse will have matching types; fields that don't exist in
 *  ConfigResponse will be ignored by the `df()` helper on each page. */
export type ConfigDefaultsResponse = {
  [K in keyof ConfigResponse]?: ConfigResponse[K];
};

// ── Config Update ──
export interface ConfigUpdateResponse {
  status: string;
  updated: string[];
  requiresRestart: string[];
  errors: Record<string, string>;
}

export interface FileUploadResponse {
  status: string;
  path: string;
  requiresRestart: boolean;
  message: string;
}

// ── Approvals ──
export interface ApprovalRow {
  id: number;
  scheduled_for: string;
  task_type: string;
  task_description: string;
  task_context: string | null;
  model: string;
  status: string;
  created_at: string;
}

export interface ApprovalsResponse {
  approvals: ApprovalRow[];
}

// ── Context ──
export interface ContextFileResponse {
  content: string;
  lastModified: string;
  /** True iff the daemon's write whitelist allows PUT on this path. */
  editable: boolean;
}

export interface ContextListResponse {
  files: { name: string; lastModified: string }[];
}

export type ContextHealthStatus = "ok" | "warning" | "error";
export type ContextHealthSeverity = "warning" | "error";

export interface MissingContextFileIssue {
  path: string;
  severity: ContextHealthSeverity;
  repairable: boolean;
  message: string;
}

export interface ContextFrontmatterIssue {
  path: string;
  code: string;
  message: string;
  severity: ContextHealthSeverity;
}

export interface ContextSizeIssue {
  path: string;
  bytes: number;
  capBytes: number;
  severity: ContextHealthSeverity;
  message: string;
}

export interface ContextIndexLinkIssue {
  source: string;
  target: string;
  severity: ContextHealthSeverity;
  message: string;
}

export interface ContextHealthReport {
  status: ContextHealthStatus;
  checkedAt: string;
  contextDir: string;
  summary: {
    missingFiles: number;
    frontmatterErrors: number;
    sizeWarnings: number;
    indexLinkIssues: number;
    userAreaGaps: number;
    repairableIssues: number;
  };
  missingFiles: MissingContextFileIssue[];
  userAreaGaps: MissingContextFileIssue[];
  frontmatterErrors: ContextFrontmatterIssue[];
  sizeWarnings: ContextSizeIssue[];
  indexLinkIssues: ContextIndexLinkIssue[];
}

export interface ContextRepairStubResponse {
  status: "created" | "exists";
  path: string;
  lastModified: string;
}

// ── Calendar ──
export interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  allDay?: boolean;
}

export interface CalendarResponse {
  events: CalendarEvent[];
}

// ── Schedule Next ──
export interface ScheduleNextResponse {
  next: {
    id: number;
    scheduled_for: string;
    task_type: string;
    task_description: string;
  } | null;
}

export interface NextCheckResponse {
  active: boolean;
  nextRunAt: string | null;
}

// ── Schedule List ──
export interface ScheduleRow {
  id: number;
  scheduled_for: string;
  task_type: string;
  task_description: string;
  /** The agent instruction. For one-off rows this is the required body and
   *  `task_description` is just an optional label. null only on legacy /
   *  system rows that still rely on the description→body dispatch fallback. */
  task_prompt: string | null;
  model: string | null;
  status: string;
  task_context: string | null;
  created_at: string;
}

export interface ScheduleListResponse {
  schedules: ScheduleRow[];
  pagination: Pagination;
}

// ── Recurring Schedules ──
//
// Wire shape of `recurrenceRuleSchema` in `packages/shared/src/schemas.ts`.
// Per SCHEDULE_API_REDESIGN_PLAN.md §4.1, `hourly` joins the original
// daily/weekly/monthly trio with two extra fields (`intervalHours`,
// `minuteOfHour`) and `monthly` gains an `onMissingDay` policy controlling
// what happens when `daysOfMonth` contains 29/30/31. `time` is forbidden
// for hourly rules and required everywhere else.
export interface RecurrenceRule {
  frequency: "hourly" | "daily" | "weekly" | "monthly";
  /** HH:MM, local time. Required for daily/weekly/monthly; forbidden for hourly. */
  time?: string;
  /** IANA tz; daemon auto-fills from config when omitted. */
  timezone?: string;
  /** hourly only — 1..23 (defaults to 1). Anchors at 00:`minuteOfHour` local. */
  intervalHours?: number;
  /** hourly only — 0..59 (defaults to 0). Which minute the fire lands on. */
  minuteOfHour?: number;
  /** 0=Sun..6=Sat. Required for weekly, forbidden otherwise. */
  daysOfWeek?: number[];
  /** 1..31. Required for monthly, forbidden otherwise. */
  daysOfMonth?: number[];
  /**
   * monthly only — policy for `daysOfMonth` entries that don't exist in a
   * given month (Feb 30, Apr 31). Defaults to `"lastDayOfMonth"` server-side
   * to preserve bit-identical behavior with the pre-redesign clamp.
   */
  onMissingDay?: "skip" | "lastDayOfMonth";
}

export interface RecurringScheduleDTO {
  id: number;
  taskType: string;
  description: string;
  /** null = no prompt override; description doubles as the agent body. */
  prompt: string | null;
  recurrenceRule: RecurrenceRule;
  /** null = no model pin → process_backend_config defaults apply. */
  model: string | null;
  enabled: boolean;
  nextRunAt: string | null;
  recurrenceLabel: string;
  taskContext: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface RecurringSchedulesListResponse {
  items: RecurringScheduleDTO[];
}

/**
 * Subset of `AgentErrorIssue` that the dashboard reads off success
 * response envelopes' `warnings[]` channel — SCHEDULE_API_REDESIGN_PLAN.md
 * §5.0.5. The daemon emits these as 2xx-companion advisories the agent
 * should surface (deprecated model, no-op `onMissingDay`, etc.); the
 * sheet keeps itself open and renders them inline so the operator
 * sees the same hint the LLM would.
 */
export interface ScheduleWarningIssue {
  code: string;
  field: string;
  received: unknown;
  expected?: string;
  hint: string;
  validValues?: unknown;
  docsUrl?: string;
}

/**
 * Wire shape of `GET /api/schedule/options` (§4.4). Read-only
 * discovery endpoint surfacing every value the dashboard / LLM needs
 * to compose a valid POST: tiers, legacy aliases, registered models
 * grouped by backend (with deprecated flags), recurrence enums + bounds,
 * and the daemon-configured default timezone.
 */
export interface ScheduleOptionsModelEntry {
  id: string;
  tier: ProcessModelTier;
  deprecated: boolean;
}

export interface ScheduleOptionsResponse {
  tiers: ProcessModelTier[];
  modelAliases: { sonnet: ProcessModelTier; opus: ProcessModelTier };
  models: Record<BackendId, ScheduleOptionsModelEntry[]>;
  frequencies: Array<"hourly" | "daily" | "weekly" | "monthly">;
  daysOfWeek: Record<string, string>;
  recurrence: {
    intervalHours: { min: number; max: number };
    minuteOfHour: { min: number; max: number };
    daysOfMonth: { min: number; max: number };
    onMissingDay: { values: Array<"skip" | "lastDayOfMonth">; default: "skip" | "lastDayOfMonth" };
  };
  timeFormat: string;
  timezoneExample: string;
  defaults: { timezone: string };
}

// ── Notifications ──
export interface NotificationRow {
  id: number;
  message: string;
  platform: string;
  priority: string;
  status: string;
  user_reaction: string | null;
  reacted_at: string | null;
  created_at: string;
}

export interface NotificationsResponse {
  notifications: NotificationRow[];
  pagination: Pagination;
}

// ── Search ──
export interface SearchResponse {
  actions: { id: number; action_type: string; started_at: string; snippet: string }[];
  messages: { id: number; role: string; timestamp: string; session_id: number; snippet: string }[];
}

// ── Snapshots ──
export interface SnapshotRow {
  id: number;
  file_path: string;
  trigger: string;
  session_id: string | null;
  created_at: string;
}

export interface SnapshotsResponse {
  snapshots: SnapshotRow[];
}

export interface SnapshotContentResponse {
  id: number;
  file_path: string;
  content: string;
  trigger: string;
  created_at: string;
}

export interface SnapshotRestoreResponse {
  status: "restored";
  path: string;
  restoredFromSnapshotId: number;
  backupSnapshotId: number | null;
  lastModified: string;
}

export interface ReinstallContextPlanResponse {
  contextDir: string;
  fileCount: number;
  totalBytes: number;
  snapshotRowCount: number;
  backupPath: string;
  ancillaryDirs: string[];
}

// ── Skills (SkillSummary, SkillDetail re-exported from shared) ──
export type { SkillSummary, SkillDetail } from "@aitne/shared";
import type { SkillSummary } from "@aitne/shared";

export interface SkillListResponse {
  skills: SkillSummary[];
}

export interface SkillWriteResponse {
  status: "created" | "updated" | "deleted";
  name: string;
}

// ── Auth Telemetry ──
export type AuthCounterKey =
  | "probe_ok"
  | "probe_unauthorized"
  | "probe_network_error"
  | "self_heal_observed"
  | "schema_parse_failed"
  | "keychain_read_failed"
  | "credentials_file_read_failed"
  | "keepalive_reminder_sent"
  | "reactive_expired"
  | "preflight_skipped_main"
  | "recovery_started"
  | "recovery_success"
  | "recovery_timeout"
  | "recovery_failed";

export type AuthCounterSource = "reactive" | "probe" | "keepalive";

export interface AuthTelemetryResponse {
  hours: number;
  /** Counters aggregated per backend (summed across sources). */
  counters: Record<string, Partial<Record<AuthCounterKey, number>>>;
  /** Source-grouped breakdown: backend → source → counter. */
  bySource: Record<string, Partial<Record<AuthCounterSource, Partial<Record<AuthCounterKey, number>>>>>;
}

// ── Recovery Status ──
export interface RecoveryStatusResponse {
  status: "idle" | "recovering";
  backendId: BackendId;
  authUrl?: string;
  userCode?: string;
  expiresMinutes?: number;
  startedAt?: string;
}

// ── Books & Reading (F-10) ──
export interface BookRow {
  id: number;
  title: string;
  author: string | null;
  source: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  rating: number | null;
  notes: string | null;
  highlightCount: number;
  createdAt: string;
}

export interface BooksResponse {
  books: BookRow[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface ReadingHighlightRow {
  id: number;
  bookId: number;
  content: string;
  location: string | null;
  note: string | null;
  highlightedAt: string | null;
  createdAt: string;
}

export interface BookHighlightsResponse {
  highlights: ReadingHighlightRow[];
}

export interface BooksSummaryResponse {
  byStatus: Array<{ status: string; count: number }>;
  monthlyCompleted: Array<{ month: string; count: number }>;
  totalHighlights: number;
}

// ── Integration Delegation Framework ──

/**
 * Sub-tier label from `/health.integrationModes.<key>.subTier`. `"draft-only"`
 * covers the Claude Code Gmail connector (no send/forward/delete/attachment).
 * `"full-auto"` is the Codex Gmail connector. `null` for calendar (no
 * equivalent split).
 */
export type IntegrationSubTier = "draft-only" | "full-auto" | null;

export interface IntegrationHealthEntry {
  mode: IntegrationMode;
  delegatedBackend: BackendId | null;
  /**
   * INTEGRATION_NATIVE_MODE_DESIGN.md §9.3 — populated only when
   * `mode === "native"`; null otherwise. Mirrors `delegatedBackend` and is
   * keyed separately so consumers can match on field presence as well as
   * `mode` (the dashboard "Re-configure" banner reads this to detect a row
   * whose binding no longer matches the live main backend).
   */
  nativeBackend: BackendId | null;
  subTier: IntegrationSubTier;
  toolNamespace: string | null;
  /**
   * Per-capability boolean map. Populated from the latest cached probe row
   * when present, otherwise from the descriptor's `optionalCapabilities` POC
   * defaults, otherwise `null` (no backend wired up). Direct mode always
   * returns `null` — the feature matrix is only meaningful under delegation.
   */
  features: Record<string, boolean> | null;
  /** ISO timestamp of the latest cached probe row, or null when features came from defaults. */
  lastProbeAt: string | null;
  /**
   * Absolute paths of skill / task-flow variant files the active delegated
   * backend needs but cannot find on disk. Empty array = clean; `null` when
   * mode is not delegated. §4.7 missing-variant surfacing.
   */
  variantsMissing: string[] | null;
}

export type IntegrationModesMap = Record<IntegrationKey, IntegrationHealthEntry>;

export interface IntegrationBackendConnectorDto {
  toolNamespace: string;
  requiredCapabilities: string[];
  optionalCapabilities: string[];
  capabilityTools: Record<string, string[]>;
}

export interface IntegrationStateDto {
  mode: IntegrationMode;
  delegatedBackend?: BackendId | null;
  /**
   * INTEGRATION_NATIVE_MODE_DESIGN.md §5.2 — backend the main agent uses to
   * reach this integration when `mode === "native"`. Schema's `superRefine`
   * makes this and `delegatedBackend` mutually exclusive: `nativeBackend`
   * is set iff `mode === "native"`, `delegatedBackend` iff
   * `mode === "delegated"`. Kept as separate fields so a flip between the
   * two modes is a two-field atomic change rather than a free-text
   * "what does `boundBackend` mean now?".
   */
  nativeBackend?: BackendId | null;
  /**
   * DELEGATED-PROXY-API-DESIGN.md §4.2 — user-pinned model for proxy
   * invocations. Null / undefined means "use the canonical light-tier
   * model for `delegatedBackend`", resolved at call time. Stale pins
   * (model not registered for the current backend after a swap) are
   * silently dropped at call time and surfaced as "Reset to default" in
   * the dashboard.
   */
  delegatedModel?: string | null;
  /**
   * DELEGATED-PROXY-API-DESIGN.md §4.2 — forward-compat per-call max-turns
   * override. v0.1 ships no UI; the field rides along the JSON blob for
   * a future release.
   */
  delegatedMaxTurns?: number | null;
  /**
   * §7.7 — per-tool deny list. Each entry is the unsuffixed connector
   * tool name (e.g. `notion-create-database` for Claude, or
   * `notion_create_database` for Codex). Tools listed here are stripped
   * from the materialized skill body.
   */
  deniedTools?: string[];
  lastChangedAt: string;
}

export interface IntegrationListItem {
  key: IntegrationKey;
  displayName: string;
  supportedModes: IntegrationMode[];
  directSetup: { credentialKeys: string[]; helpUrl: string } | null;
  backendConnectors: Partial<Record<BackendId, IntegrationBackendConnectorDto>>;
  skillsTouched: string[];
  taskFlowsTouched: string[];
  observersTouched: string[];
  apiRoutesTouched: string[];
  /**
   * True when delegated mode relies on an MCP server / connector that the
   * user installs on the agent backend (Claude Code / Codex / Gemini CLI)
   * themselves. The dashboard uses this to:
   *   - allow the Delegated radio even when `backendConnectors` is empty,
   *   - render a user-managed notice instead of the descriptor-driven
   *     feature matrix,
   *   - skip the "tool namespace" / probe affordances that assume the
   *     daemon knows the connector's tool inventory.
   * Today: Outlook Mail and Outlook Calendar.
   */
  userManagedConnector?: boolean;
  state: IntegrationStateDto;
}

export interface IntegrationListResponse {
  integrations: IntegrationListItem[];
}

export interface IntegrationPatchRequest {
  mode: IntegrationMode;
  delegatedBackend?: BackendId | null;
  /**
   * INTEGRATION_NATIVE_MODE_DESIGN.md §11.2 — backend the main agent uses
   * to reach this integration when `mode === "native"`. Required when
   * flipping to native; rejected with `validation_error` when present
   * under any other mode. The daemon additionally rejects
   * `native_backend_mismatches_main` when the value differs from the
   * current main backend (PUT /api/backends/main is the only way to move
   * the main binding) and `backend_not_supported_native` when the chosen
   * backend has no registry connector for this integration.
   */
  nativeBackend?: BackendId | null;
  /**
   * DELEGATED-PROXY-API-DESIGN.md §6.1 — user-pinned proxy model. Empty
   * string is rejected (use `null` to clear). Validation against the
   * model registry runs server-side and returns `unknown_model` on
   * failure.
   */
  delegatedModel?: string | null;
  /**
   * DELEGATED-PROXY-API-DESIGN.md §4.2 — forward-compat max-turns
   * override. v0.1 surfaces no UI; included so the wire shape is stable
   * if the daemon starts persisting the value.
   */
  delegatedMaxTurns?: number | null;
  /**
   * §7.7 — optional tool-deny list. Omit to preserve the previously
   * stored value. Validation against `descriptor.capabilityTools` and
   * required-capability coverage runs server-side.
   */
  deniedTools?: string[];
}

/**
 * §7.7 — error shapes returned by `PATCH /api/integrations/:key` when
 * the proposed `deniedTools` list fails validation. Surfaced inline by
 * the Tool Permissions card so the user can react without round-tripping.
 */
export interface IntegrationPatchUnknownToolError {
  error: "unknown_tool";
  key: IntegrationKey;
  backend: BackendId;
  tool: string;
  knownTools: string[];
  message: string;
}

export interface IntegrationPatchDenialBreaksRequiredError {
  error: "denial_breaks_required_capability";
  key: IntegrationKey;
  backend: BackendId;
  capability: string;
  remainingTools: string[];
  message: string;
}

/**
 * INTEGRATION_NATIVE_MODE_DESIGN.md §11.2 — returned by
 * `PATCH /api/integrations/:key` when a native flip names a backend that
 * has no registry connector for this integration (e.g. setting
 * `nativeBackend: "gemini"` for an integration whose `backendConnectors`
 * lacks a Gemini entry). The dashboard never reaches this state through
 * the wizard (the Native option is hidden when the main backend is not
 * in `supportedNativeBackends`); the error exists for out-of-band PATCH
 * callers (CLI, curl) and as a defense-in-depth surface.
 */
export interface IntegrationPatchBackendNotSupportedNativeError {
  error: "backend_not_supported_native";
  key: IntegrationKey;
  backend: BackendId;
  supportedNativeBackends: BackendId[];
  message: string;
}

/**
 * INTEGRATION_NATIVE_MODE_DESIGN.md §3.3 invariant — `nativeBackend` must
 * equal the current main backend. The daemon refuses a flip that violates
 * this, pointing the user at `PUT /api/backends/main`. The dashboard's
 * mode-flip dialog catches this and renders the suggested remediation.
 */
export interface IntegrationPatchNativeBackendMismatchesMainError {
  error: "native_backend_mismatches_main";
  key: IntegrationKey;
  nativeBackend: BackendId;
  mainBackend: BackendId;
  message: string;
}

/**
 * DELEGATED-PROXY-API-DESIGN.md §6.1 — surfaced when a `delegatedModel`
 * value is rejected because no model with that id is registered for the
 * effective backend. The dashboard renders `knownModels` as a hint.
 */
export interface IntegrationPatchUnknownModelError {
  error: "unknown_model";
  key: IntegrationKey;
  backend: BackendId;
  model: string;
  knownModels: string[];
  message: string;
}

/**
 * Single entry in `GET /api/integrations/proxy-models/:backend.options`.
 * Mirrors `ProxyModelOption` on the daemon side; kept structurally minimal
 * because the dashboard only needs id + display + tier + pricing for the
 * "estimated cost / call" chip in the IntegrationCard.
 */
export interface ProxyModelOptionDto {
  modelId: string;
  displayName: string;
  tier: "lite" | "medium" | "high";
  deprecated: boolean;
  /** Lower-tier USD / 1k input tokens. `null` when the registry has no pricing for this model. */
  usdPer1kIn: number | null;
  /** Lower-tier USD / 1k output tokens. */
  usdPer1kOut: number | null;
}

export interface ProxyModelsResponse {
  backend: BackendId;
  /** Canonical light-tier model id; `null` when the registry has no light entry for the backend. */
  canonical: string | null;
  options: ProxyModelOptionDto[];
}

export interface IntegrationPatchResponse {
  ok: true;
  integration: IntegrationStateDto;
}

/**
 * Shape of the `missing_variants` 400 from `PATCH /api/integrations/:key`
 * when a delegated or native flip's required skill/task-flow variants are
 * absent. The dashboard renders the file list so the authoring step is
 * mechanical. INTEGRATION_NATIVE_MODE_DESIGN.md §7.4 / §8.5 — the same
 * shape is returned for both modes; `mode` lets the UI use the correct
 * file-name hint (`SKILL.native.<backend>.md` vs
 * `SKILL.delegated.<backend>.md`).
 */
export interface IntegrationPatchMissingVariantsError {
  error: "missing_variants";
  key: IntegrationKey;
  backend: BackendId;
  /**
   * Present on native-flip responses (`mode === "native"`). Omitted from
   * older delegated-only responses for wire-compat; treat absent as
   * `"delegated"` to keep the file-name hint correct.
   */
  mode?: "delegated" | "native";
  missingSkills: string[];
  missingTaskFlows: string[];
  message: string;
}

export interface IntegrationProbeCapabilityResult {
  capability: string;
  present: boolean;
  matchedTools: string[];
  required: boolean;
}

export interface IntegrationProbeResult {
  integration: IntegrationKey;
  backend: BackendId;
  presentTools: string[];
  capabilities: IntegrationProbeCapabilityResult[];
  missingRequired: string[];
  present: boolean;
  probedAt: string;
}

export interface IntegrationProbeResponse {
  ok: true;
  cached: boolean;
  /** Present on live-probe responses so the dashboard can distinguish the path. */
  liveProbe?: boolean;
  result: IntegrationProbeResult | null;
}

/**
 * Shape returned by `GET /api/integrations/:key/recent-proxy-calls`
 * (DELEGATED-PROXY-API-DESIGN.md §7). One entry per `delegated_proxy.invoke`
 * row, newest first. Drives the IntegrationCard's "Recent calls" collapsible
 * table — small fixed shape so the dashboard does not have to know about the
 * agent_actions schema or the detail JSON structure.
 */
export interface RecentProxyCall {
  id: number;
  startedAt: string | null;
  completedAt: string | null;
  modelId: string | null;
  backend: string | null;
  costUsd: number | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  durationMs: number | null;
  numTurns: number | null;
  result: "success" | "failed" | "partial" | "skipped" | null;
  /** Structured DelegatedErrorClass on failure rows; `null` on success. */
  errorClass: string | null;
  toolName: string | null;
  errorMessage: string | null;
}

export interface RecentProxyCallsResponse {
  key: IntegrationKey;
  limit: number;
  calls: RecentProxyCall[];
}

// ── Common ──
export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// ── Docs & QA (DOCS_QA_DESIGN.md §10.4 — read endpoints only) ──

export interface DocsTreeItem {
  slug: string;
  title: string;
  category: string;
  section: string | null;
  status: string | null;
  summary: string;
}

export interface DocsTreeResponse {
  schema_version: 1;
  docs: DocsTreeItem[];
  total: number;
}

/**
 * Subset of frontmatter fields surfaced by GET /api/docs/by-slug/:slug.
 * Mirrors the projection the daemon route makes from `fts_docs`. Authored
 * fields that the indexer does not project (created/updated, etc.) are
 * intentionally absent — surface them through dedicated endpoints if the
 * dashboard needs them later.
 *
 * `related` carries doc slugs that the author flagged as cross-links;
 * `<DocsQASuggested>` uses it to pull a 1-from-related question into the
 * suggested cards (DOCS_QA_DASHBOARD_DESIGN.md §7.5).
 */
export interface DocsDetailFrontmatter {
  slug: string;
  title: string;
  category: string;
  section?: string;
  status?: string;
  summary: string;
  tags: string[];
  process_keys: string[];
  config_keys: string[];
  ask_examples: string[];
  related: string[];
}

export interface DocDetailResponse {
  slug: string;
  frontmatter: DocsDetailFrontmatter;
  body: string;
  /** Anchor ids extracted from H1/H2/H3 headings at index time. */
  anchors: string[];
}

export interface DocsSearchResult {
  slug: string;
  title: string;
  category: string;
  section: string;
  summary: string;
  tags: string[];
  /** All anchors for the doc (not just matched anchors). */
  anchors: string[];
  /** BM25 rank — lower is better. */
  rank: number;
}

export interface DocsSearchResponse {
  schema_version: 1;
  query: string;
  filters: { category: string | null; tag: string | null };
  limit: number;
  total: number;
  results: DocsSearchResult[];
}

export interface DocsHealthResponse {
  schema_version: 1;
  status: "ok" | "empty" | "degraded";
  fileCount: number;
  errorCount: number;
  lastIndexedAt: string | null;
  errors: Array<{ slug?: string; path?: string; message: string }>;
}

// ── Delegated-sync opt-in (docs/design/appendices/delegated-sync-opt-in.md) ──

/** Per-cadence row returned by GET /api/delegated-sync. */
export interface DelegatedSyncCadenceRow {
  integration: string;
  windowKey: string;
  enabled: boolean;
  /**
   * Integration's current mode at status-read time. `null` when the
   * integration is in `direct` / `disabled`; the row is still surfaced
   * so the dashboard can render the cadence with an inert chip. `native`
   * is surfaced too, but the worker does not invoke for native rows —
   * see `backend`.
   */
  mode: "delegated" | "native" | null;
  /**
   * Backend the next tick will invoke (`delegatedBackend` for delegated
   * rows). `null` for any other mode, including `native` — native
   * observations come from the in-turn `routine.fetch_window` pre-pass
   * rather than this cadence worker (see
   * `docs/design/appendices/native-integration-mode.md`).
   */
  backend: string | null;
  displayName: string;
  description: string;
  defaultIntervalSeconds: number;
  softFloorSeconds: number;
  intervalSeconds: number;
  effectiveIntervalSeconds: number;
  circuitState: "ok" | "tripped";
  failureCount: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastCompletedAt: string | null;
  lastError: string | null;
  nextRunAt: string | null;
}

export interface DelegatedSyncStatusResponse {
  workerRunning: boolean;
  lastSuccessAt: string | null;
  circuitState: "ok" | "tripped";
  activeHours: { startHour: number; endHour: number };
  withinActiveHours: boolean;
  cadences: Record<string, DelegatedSyncCadenceRow>;
  unrecognizedIntervalKeys: string[];
  ttlContractViolations: Array<{
    cadenceId: string;
    intervalSeconds: number;
    ttlSeconds: number;
  }>;
}

export interface DelegatedSyncCadencePatch {
  enabled?: boolean;
  intervalSeconds?: number;
}

export interface DelegatedSyncActiveHoursPatch {
  startHour: number;
  endHour: number;
}
