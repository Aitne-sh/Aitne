/**
 * Canonical list of config keys editable via the dashboard PATCH /config endpoint.
 *
 * Both the daemon (env-writer.ts) and the dashboard (useSaveConfig) import from here
 * so the set of accepted keys is enforced at compile time in both packages.
 */

export const EDITABLE_RUNTIME_KEY_TUPLE = [
  "advisorEnabled", "advisorModel",
  "maxConcurrentSessions", "maxReactiveSessions", "delegatedProxyMaxConcurrent", "executeTimeoutMinutes",
  // DELEGATED-TASK-MODE-DESIGN.md §17 — task-mode kill switch / quotas /
  // defaults. The heavy enable flag is Approve-tier semantically, but is
  // editable here too so the user can flip it from the dashboard once
  // they confirm the cost class.
  "delegatedTaskModeEnabled", "delegatedTaskMaxPerDay",
  "delegatedTaskDefaultMaxToolCalls", "delegatedTaskDefaultMaxBudgetUsd",
  "delegatedTaskDefaultTimeoutMs", "delegatedTaskHeavyEnabled",
  // DELEGATED-TASK-MODE-DESIGN.md §13 Phase 3 — three independent
  // optimization kill switches. Each defaults off (cache, pool) or on
  // (structured output) per the design doc; flipping any one does not
  // affect the others. See runtime-settings.ts for the per-field rationale.
  "delegatedTaskStructuredOutputEnabled",
  "delegatedTaskSubprocessPoolEnabled", "delegatedTaskSubprocessPoolTtlSeconds",
  "delegatedTaskCacheEnabled", "delegatedTaskCacheTtlSeconds",
  "delegatedTaskCacheMaxEntries",
  "agentDisplayName",
  "character",
  "sessionTimeoutDmMinutes", "sessionTimeoutChannelMinutes", "sessionTimeoutDashboardMinutes",
  "historyInjectionMaxMessages", "historyInjectionMaxTokens",
  "historyOtherSurfaceWindowMinutes",
  "dmStalenessStrict",
  "proactiveForwardChannelTimelineEnabled",
  "proactiveForwardForceFreshSession",
  "timezone", "dayBoundaryHour",
  // Monthly Review kill switch — defaults off pre-release; see
  // packages/daemon/src/settings/runtime-settings.ts for the rationale.
  "monthlyReviewEnabled",
  "hourlyCheckEnabled", "hourlyCheckIntervalMinutes",
  "hourlyCheckActiveStartHour", "hourlyCheckActiveEndHour", "hourlyCheckMinObservations",
  // cost-reduction-structural §B — three-stage gate knobs.
  // (`hourlyCheckGateMode` was removed in
  // HOURLY_CHECK_GATE_REDESIGN_PLAN.md Phase 4 — the gate now has a
  // single execution path.)
  "hourlyCheckStage2Enabled", "hourlyCheckHeartbeatHours",
  "hourlyCheckLowSignalPendingCeiling",
  // HOURLY_CHECK_GATE_REDESIGN_PLAN.md §3.4 — minutes between pre-pass
  // spawns for the same integration. `harvestForGate` skips pre-pass
  // when `runtime_state.pre_pass_last_run:<key>` is within this window.
  "hourlyCheckPrePassFreshnessMinutes",
  "authProbeDisabled", "authPreflightFreshnessMs",
  "maxNotificationsPerHour", "maxNotificationsPerDay",
  "quietHoursStart", "quietHoursEnd", "batchIntervalMinutes", "primaryPlatform",
  "defaultNotificationPlatforms",
  "slackOwnerUserId", "telegramOwnerChatId", "discordOwnerUserId",
  "whatsappEnabled", "whatsappOwnerPhone", "whatsappAuthDir",
  "disallowedTools", "allowedToolsOverride",
  "claudeExecutionPermissionMode",
  "codexExecutionPermissionMode",
  "geminiExecutionPermissionMode",
  "opencodeExecutionPermissionMode",
  "opencodeBaseUrl",
  "opencodeServerUsername",
  "externalObsidianVaultPath", "externalObsidianVaultName",
  // SETUP-FLOW-REDESIGN-PLAN §6.3 — kill switch for the external-vault
  // branch of `ObsidianWatcher`. Editable so the Notes step's "Watch for
  // changes" checkbox round-trips through `PATCH /api/config`.
  "externalObsidianWatch",
  "obsidianDebounceSeconds",
  // Management Mode — primary-vault fields introduced by the management-mode
  // redesign. Editable via the settings dialog once Phase 2's migration API
  // lands; Phase 1 persists values if set but enters degraded mode if unset
  // while vaultMode === "obsidian".
  "primaryVaultPath", "primaryVaultName",
  // gitRepos / gitWatchedRepos / githubRepos removed at the unified-
  // repositories cutover (docs/design/appendices/unified-repositories.md);
  // their data lives in the `repositories` DB table now. `gitAccounts`
  // stays — it is 1:N over rows.
  "gitAccounts",
  "googleCalendarId", "notionDatabaseIds",
  "schedulePollIntervalSeconds",
  // SCHEDULED-DM-IMPLEMENTATION-PLAN §3.6.1 / §6.6.1 — max delay budget
  // for scheduled.dm gate-acquisition before the briefing is dropped.
  "maxBriefingDelayMinutes",
  "gitPollIntervalSeconds", "gitPushOverdueMinutes", "gitProjectUpdateDebounceMinutes",
  "notionPollIntervalSeconds", "calendarPollIntervalSeconds",
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
  // docs/design/appendices/pre-pass-fan-out.md §6 — retry, concurrency, and budget knobs.
  "prePassMaxAttemptsPerIntegration",
  "prePassBackoffMs",
  "prePassRetryEscalationTier",
  "prePassFanOutConcurrency",
  "prePassMaxBudgetUsdPerIntegration",
  "prePassMaxBudgetUsdPerRoutine",
  "prePassRetryOnPartial",
  // cost-reduction-structural §A — observation summarizer knobs.
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
  // B-007 — primary language + vault mode selected at setup, editable later
  "primaryLanguage",
  "vaultMode",
  // Voice transcription opt-in (docs/design/appendices/voice-transcription.md).
  // The dashboard's recommended path is POST /api/voice/install — that flow
  // downloads the Whisper weights with progress UI, persists the flag, and
  // triggers a daemon self-restart so the next inbound voice attachment
  // observes the model on disk. A direct PATCH here is technically accepted
  // (the env-writer plumbing needs to round-trip the key on read-back, and
  // the transcriber's getter picks up the new value live) but the model
  // weights would only download lazily on the FIRST audio attachment, with
  // no UI feedback. The RESTART_REQUIRED_KEY_TUPLE entry surfaces a badge
  // so an operator who PATCHes around the install flow is nudged to use it.
  "voiceTranscriptionEnabled",
  // Operator's primary spoken language for the post-auto-detect fallback.
  // The transcriber reads this through a getter (see VoiceTranscriber's
  // `primaryLanguage` option), so a runtime PATCH takes effect on the next
  // inbound audio attachment without a daemon restart — that's why this
  // key is editable at runtime AND deliberately absent from
  // RESTART_REQUIRED_KEY_TUPLE.
  "voiceTranscriptionPrimaryLanguage",
] as const;

export const EDITABLE_BOOTSTRAP_KEY_TUPLE = [
  "apiPort",
] as const;

export const RESTART_REQUIRED_KEY_TUPLE = [
  "apiPort",
  "externalObsidianVaultName", "externalObsidianVaultPath",
  // SETUP-FLOW-REDESIGN-PLAN §6.3 — the kill switch is read once at boot in
  // index.ts when ObsidianWatcher is registered; flipping it at runtime
  // updates the integrations.md Note Sources line (via applyConfigUpdates
  // chokepoint) but does NOT start/stop the live chokidar watcher. Surface
  // that honestly via the dashboard's restart-required badge — same posture
  // as `externalObsidianVaultPath` above, which has the same constraint.
  "externalObsidianWatch",
  "primaryVaultPath", "primaryVaultName",
  "slackOwnerUserId",
  "telegramOwnerChatId",
  "discordOwnerUserId",
  "whatsappEnabled", "whatsappOwnerPhone", "whatsappAuthDir",
  "notionDatabaseIds",
  "gmailPollIntervalSeconds",
  // DelegatedProbeObserver (DELEGATED-MODE-V2 §7.1) captures `intervalMs`
  // at construction time and registers a single setInterval — a hot PATCH
  // updates `config.delegatedProbeIntervalMinutes` but the timer keeps
  // firing on the old cadence until restart. Surface that honestly via
  // the dashboard's restart-required badge rather than silently ignoring
  // the change.
  "delegatedProbeIntervalMinutes",
  // GitWatcher / delegated Git cron / GitHubPoller capture their cadence in
  // constructors and bind it to timers. Runtime PATCH updates config storage,
  // but the live timers keep the old cadence until restart; flag honestly.
  "gitPollIntervalSeconds",
  "githubPollIntervalSeconds",
  // The transcriber itself reads `enabled` through a live getter when no
  // env override is set, so the flag flips immediately for inference
  // routing — no restart needed for that piece. The badge here exists
  // for a different reason: a bare PATCH from false → true does NOT
  // pre-download the Whisper weights, so the next inbound voice
  // attachment silently lazy-fetches them at inference time and the
  // first transcript is delayed by the full download (often tens of
  // seconds) with no UI feedback. The /api/voice/install path downloads
  // with progress + auto-restart; the badge nudges operators who bypass
  // it. (When `PA_VOICE_TRANSCRIPTION_ENABLED` IS set, the transcriber
  // binds at construction and the flag really does need a restart.)
  "voiceTranscriptionEnabled",
  // ObservationSummarizerWorker reads these constructor-time options once
  // at startup (cost-reduction-structural §A): the worker is registered
  // only when `observationSummarizerEnabled=true` at boot, and concurrency
  // / per-call timeout / rate limit / queue cap are captured by the
  // worker constructor and bound to the running drain loops. A runtime
  // PATCH updates `settings`/`AgentConfig` storage but does not re-create
  // the worker — flag honestly via the restart badge so an operator that
  // bumped the rate limit knows the change isn't live yet.
  "observationSummarizerEnabled",
  "observationSummarizerConcurrency",
  "observationSummarizerMaxCallsPerMinute",
  "observationSummarizerQueueLimit",
  "observationSummarizerTimeoutMs",
] as const;

export type EditableRuntimeKey = (typeof EDITABLE_RUNTIME_KEY_TUPLE)[number];
export type EditableBootstrapKey = (typeof EDITABLE_BOOTSTRAP_KEY_TUPLE)[number];
export type EditableConfigKey = EditableRuntimeKey | EditableBootstrapKey;
export type RestartRequiredKey = (typeof RESTART_REQUIRED_KEY_TUPLE)[number];
