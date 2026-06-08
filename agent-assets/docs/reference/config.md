---
schema_version: 1
slug: reference/config
title: Config Reference
id: config-ref
aliases:
  - config
  - AgentConfig
  - settings keys
  - runtime config
category: reference
summary: |
  Source-of-truth map for AgentConfig — where each field is set
  (env, dashboard PATCH, OS keychain), which fields require a restart,
  and pointers to the canonical key tuples in shared/.
section: config
tags:
  - core
  - reference
  - config
  - operations
  - backends
status: stable
ask_examples:
  - What configuration keys does the agent expose?
  - Where does config get loaded from?
  - How do I change the day boundary?
  - Which config keys are runtime-editable from the dashboard?
  - Which keys need a daemon restart?
  - Where is the pre-pass freshness window set?
  - What is the default daily cost cap?
locale: en-US
keywords:
  - AgentConfig
  - applyConfigUpdates
  - EDITABLE_RUNTIME_KEY_TUPLE
  - RESTART_REQUIRED_KEY_TUPLE
  - dayBoundaryHour
  - hourlyCheckIntervalMinutes
  - quietHoursStart
  - quietHoursEnd
  - executeTimeoutMinutes
  - autonomousDailyCostCapUsd
  - allowedToolsOverride
  - voiceTranscriptionEnabled
  - hourlyCheckPrePassFreshnessMinutes
  - vaultMode
  - PA_DATA_DIR
  - PA_API_PORT
config_keys:
  - dayBoundaryHour
  - timezone
  - primaryLanguage
  - vaultMode
  - hourlyCheckEnabled
  - hourlyCheckIntervalMinutes
  - hourlyCheckPrePassFreshnessMinutes
  - quietHoursStart
  - quietHoursEnd
  - maxNotificationsPerHour
  - maxNotificationsPerDay
  - maxConcurrentSessions
  - maxReactiveSessions
  - executeTimeoutMinutes
  - autonomousDailyCostCapUsd
  - autonomousMonthlyCostCapUsd
  - disallowedTools
  - allowedToolsOverride
  - claudeExecutionPermissionMode
  - enabledMailProviders
  - voiceTranscriptionEnabled
  - advisorEnabled
  - advisorModel
api_endpoints:
  - PATCH /api/config
  - POST /api/voice/install
ui_anchors:
  - /settings/advanced
  - /settings/models
created: 2026-04-25
updated: 2026-06-07
related:
  - reference/api
  - reference/cli-commands
  - reference/disallowed-tools
  - concepts/safety-and-execution
---

# Config Reference

The full `AgentConfig` schema lives in
`packages/daemon/src/config.ts`. Three canonical tuples in
`packages/shared/src/editable-config-keys.ts` govern what is editable
and when:

- **`EDITABLE_RUNTIME_KEY_TUPLE`** — the ~130 keys mutable at runtime
  via `PATCH /api/config`. Both the daemon and the dashboard import
  from this tuple so the accepted-key set is enforced at compile time
  in both packages.
- **`RESTART_REQUIRED_KEY_TUPLE`** — runtime-editable keys whose
  change does not apply to a running worker (the dashboard renders a
  restart-required badge for these).
- **`EDITABLE_BOOTSTRAP_KEY_TUPLE`** — `apiPort` only, written to
  `.env` because it's read before the daemon binds.

Anything not in those tuples must be set via env or restart.

## Where Each Field Comes From

| Source | What lives there |
|---|---|
| `.env` | `PA_DATA_DIR`, `PA_API_PORT`, log level, the bootstrap port from `EDITABLE_BOOTSTRAP_KEY_TUPLE`. Chmod 0600 on first launch; never store secrets here. |
| OS keychain | All secrets — backend API keys, messaging tokens, OAuth grants. Resolved via `PlatformSecretStore` (macOS Keychain / Windows DPAPI / Linux libsecret or AES-GCM file). |
| `settings` DB table | Runtime-edited values from `EDITABLE_RUNTIME_KEY_TUPLE`, merged on top of env at boot via `mergeRuntimeSettingsFromDb`. |
| `runtime_state` DB table | Operational state that the agent or daemon writes (pause flag, integration flip locks, pre-pass freshness, B-4 toggles). Not editable as config. |

## Selected Keys

A representative slice of `EDITABLE_RUNTIME_KEY_TUPLE` — the full list
of ~130 keys is in `editable-config-keys.ts`. Names below are exact and
case-sensitive.

### Identity and timezone

| Key | Type | Notes |
|---|---|---|
| `agentDisplayName` | string | What the agent calls itself in DMs. |
| `character` | string | Free-text user-defined communication style / persona (max 1000 chars). When non-empty, rendered as a `## Character (user-defined)` block into each backend's instruction file. The agent profile itself is selected by ProcessKey, not by this key. |
| `timezone` | IANA tz | Empty falls back to the system tz. |
| `dayBoundaryHour` | 0–9 | Default `4`. Controls the agent-day rollover (must be an early-morning hour). |
| `primaryLanguage` | BCP-47 | Output language for DMs, journal, and Obsidian writes. Templates stay English-headered. |
| `vaultMode` | enum | Where context lives — `plain` (default; `<dataDir>/context`) or `obsidian` (an external Obsidian vault). |

### Hourly check and gate

| Key | Type | Notes |
|---|---|---|
| `hourlyCheckEnabled` | boolean | Default `true`. |
| `hourlyCheckIntervalMinutes` | number | Default `60`. |
| `hourlyCheckActiveStartHour` | 0–23 | Default `4`. |
| `hourlyCheckActiveEndHour` | 1–24 | End-exclusive; `24` ≡ midnight. |
| `hourlyCheckMinObservations` | number | Default `1`. |
| `hourlyCheckStage2Enabled` | boolean | cost-reduction-structural §B Stage 2 toggle. |
| `hourlyCheckHeartbeatHours` | number | Quiet-day heartbeat cadence. |
| `hourlyCheckLowSignalPendingCeiling` | number | Low-signal ceiling before forcing dispatch. |
| `hourlyCheckPrePassFreshnessMinutes` | number | Layer-1 freshness window — `harvestForGate` skips a per-integration fetch if `runtime_state.pre_pass_last_run:<key>` is fresher. |

### Notifications and quiet hours

| Key | Type | Notes |
|---|---|---|
| `quietHoursStart` / `quietHoursEnd` | `HH:MM` | Defaults `"22:00"` / `"08:00"`. |
| `maxNotificationsPerHour` | number | Default `3`. |
| `maxNotificationsPerDay` | number | Default `12`. |
| `batchIntervalMinutes` | number | Notification batching window. |
| `primaryPlatform` | enum | Channel the agent defaults to for new DMs. |
| `defaultNotificationPlatforms` | enum[] | Fan-out set. |

### Sessions and execution

| Key | Type | Notes |
|---|---|---|
| `maxConcurrentSessions` | number | Default `3`. |
| `maxReactiveSessions` | number | Sub-cap reserved for DM/mention work. |
| `executeTimeoutMinutes` | number | Per-execute wall-clock cap. |
| `sessionTimeoutDmMinutes` / `…ChannelMinutes` / `…DashboardMinutes` | number | Idle TTLs per surface. |
| `historyInjectionMaxMessages` / `…MaxTokens` | number | History-window caps for next-turn injection. |
| `autonomousDailyCostCapUsd` / `…MonthlyCostCapUsd` | number / null | Spend ceilings for autonomous work; default `null` (off). When set, must be positive. The daily cap makes the dispatcher skip autonomous sessions once the day's cumulative cost exceeds it — reactive DMs/mentions always pass through. The monthly cap is a notifications-only soft cap (no dispatcher enforcement). Distinct from the removed Phase-9 `maxDailyCostUsd`, which blanket-blocked every session. |

### Safety and execution mode

| Key | Type | Notes |
|---|---|---|
| `disallowedTools` | string[] | Hard-deny tool matchers (Safe-mode strict set). |
| `allowedToolsOverride` | string[] | Runtime widening — cannot widen past `ALWAYS_DISALLOWED_TOOLS`. |
| `claudeExecutionPermissionMode` | `"safe"`/`"allow"` | Per-backend Safe/Allow posture. |
| `codexExecutionPermissionMode` | `"safe"`/`"allow"` | Same; allow mode cannot enforce absolute-block on shell. |
| `geminiExecutionPermissionMode` | `"safe"`/`"allow"` | Same. |
| `opencodeExecutionPermissionMode` | `"safe"`/`"allow"` | Per-backend mode for OpenCode. |

### Pre-pass and observation summarizer

| Key | Type | Notes |
|---|---|---|
| `prePassMaxAttemptsPerIntegration` | number | Retry cap per integration in the routine pre-pass. |
| `prePassBackoffMs` | number | Backoff between retries. |
| `prePassRetryEscalationTier` | enum | Tier to escalate to on partial / failure. |
| `prePassFanOutConcurrency` | number | Parallel integrations during pre-pass fan-out. |
| `prePassMaxBudgetUsdPerIntegration` | number | Budget cap per integration per routine. |
| `prePassMaxBudgetUsdPerRoutine` | number | Aggregate budget cap per routine. |
| `prePassRetryOnPartial` | boolean | Whether partial results trigger a retry. |
| `observationSummarizerEnabled` | boolean | cost-reduction-structural §A — observation summariser worker on/off. |
| `observationSummarizerConcurrency` / `…MaxCallsPerMinute` / `…QueueLimit` / `…TimeoutMs` | number | Summariser tuning. **Restart-required** (worker captures these at boot). |

### Mail / calendar / git / browser-history polling

| Key | Type | Notes |
|---|---|---|
| `mailPollIntervalSeconds` / `mailIdleEnabled` / `mailIdleInstabilityThreshold` / `mailIdleFallbackRecoveryMinutes` / `mailMaxMessagesPerPoll` / `mailAuthFailureRetryHours` | various | Mail-poller knobs (multi-provider). |
| `enabledMailProviders` | enum[] | Which providers participate. One or more of `gmail`, `outlook`, `yahoo`, `icloud`. Default `["gmail"]`. |
| `vipMailSenders` | string[] | Sender list that bumps mail priority. |
| `outlookDeltaPageSize` / `outlookGraphConcurrency` | number | Outlook Graph API tuning. |
| `imapReconnectBaseMs` / `imapReconnectMaxMs` | number | IMAP reconnect backoff. |
| `gmailPollIntervalSeconds` | number | Gmail-specific cadence (restart-required). |
| `calendarPollIntervalSeconds` | number | Google Calendar poll interval. |
| `notionPollIntervalSeconds` | number | Notion poll interval. |
| `gitPollIntervalSeconds` / `githubPollIntervalSeconds` | number | Git / GitHub cadences (both restart-required — `GitWatcher` / `GitHubPoller` bind at construction). |
| `browserHistoryConsentAccepted` | boolean | B-3 consent gate — must be `true` for the poller to start. |
| `browserHistoryBrowserOverrides` | object | Per-browser opt-in/out and DB-path overrides. |
| `browserHistoryCategories` | enum[] | Visit-category allowlist. |
| `browserHistoryRetentionDays` / `…SearchQueryRetentionDays` | number | Retention windows. |
| `browserHistoryLifecycle` | object | Cluster lifecycle thresholds. |
| `browserHistoryResearchDomainAllowlist` / `…Denylist` | string[] | Domain filters for cluster qualification. |

### Voice transcription

| Key | Type | Notes |
|---|---|---|
| `voiceTranscriptionEnabled` | boolean | Whisper local transcription for voice attachments. Default `false`. Restart-required when the env var is set; live-flip via `POST /api/voice/install` (downloads weights with progress UI). |
| `voiceTranscriptionPrimaryLanguage` | BCP-47 | Fallback language after Whisper's auto-detect. Live-applied on the next inbound audio attachment. |

### Delegated tasks

| Key | Type | Notes |
|---|---|---|
| `delegatedTaskModeEnabled` | boolean | Master kill switch for the `/api/integrations/:key/exec` task-mode endpoints. Default `false`; mutable at runtime so an emergency disable needs no restart. |
| `delegatedTaskMaxPerDay` | number | Per-day quota. |
| `delegatedTaskDefaultMaxToolCalls` / `…DefaultMaxBudgetUsd` / `…DefaultTimeoutMs` | various | Per-task defaults. |
| `delegatedTaskHeavyEnabled` | boolean | Approve-tier opt-in gate for the heavy variant. |
| `delegatedTaskStructuredOutputEnabled` / `…CacheEnabled` / `…CacheTtlSeconds` / `…CacheMaxEntries` / `…SubprocessPoolEnabled` / `…SubprocessPoolTtlSeconds` | various | Phase-3 optimisation kill switches (independent). |
| `delegatedProxyMaxConcurrent` | number | Concurrency cap for the proxy worker. |

### Advisor

| Key | Type | Notes |
|---|---|---|
| `advisorEnabled` | boolean | SDK advisor toggle. |
| `advisorModel` | string / null | Model id; default `null`. Validated against `ADVISOR_ALLOWED_MODELS`, which the SDK pins to `claude-sonnet-4-6` and `claude-opus-4-6` only. Newer Opus generations (`claude-opus-4-7`, `claude-opus-4-8`) are silently skipped by the SDK advisor path — see `docs/advisor.md`. |

## Routine Schedule Times Are Not Configurable

The morning, evening, weekly, and monthly routines fire at fixed times
defined in `packages/daemon/src/core/scheduler.ts`. There is no
`morningRoutineHour`, `eveningReviewHour`, or `weeklyReviewDay` key — to
shift the whole day, change `dayBoundaryHour` instead.

| Routine | Trigger |
|---|---|
| `routine.morning_routine` | Daily at `dayBoundaryHour` (default 04:00). |
| `routine.evening_review` | Daily at `18:00` local. |
| `routine.weekly_review` | Friday `19:00` local (one hour after the evening review). |
| `routine.monthly_review` | Last day of the month at `18:00` local, but **disabled by default** (`monthlyReviewEnabled = false`). |

The hourly check is the one autonomous routine with a configurable
cadence (`hourlyCheckIntervalMinutes`) and active window
(`hourlyCheckActiveStartHour` / `…ActiveEndHour`).

## Restart-Required Keys

The `RESTART_REQUIRED_KEY_TUPLE` covers fields whose new value is
written through `applyConfigUpdates` but does not apply to a running
worker — the dashboard renders a badge prompting an `aitne restart`.
The current list:

- `apiPort` (env-only)
- `externalObsidianVaultName` / `externalObsidianVaultPath` / `externalObsidianWatch`
- `primaryVaultPath` / `primaryVaultName`
- `slackOwnerUserId` / `telegramOwnerChatId` / `discordOwnerUserId`
- `whatsappEnabled` / `whatsappOwnerPhone` / `whatsappAuthDir`
- `notionDatabaseIds`
- `gmailPollIntervalSeconds` / `gitPollIntervalSeconds` / `githubPollIntervalSeconds`
- `delegatedProbeIntervalMinutes`
- `voiceTranscriptionEnabled` (only when `PA_VOICE_TRANSCRIPTION_ENABLED` env is set)
- `observationSummarizerEnabled` / `…Concurrency` / `…MaxCallsPerMinute` / `…QueueLimit` / `…TimeoutMs`

## Related

- [API](api.md)
- [CLI Commands](cli-commands.md)
- [Disallowed Tools](disallowed-tools.md)
- [Safety and Execution](../concepts/safety-and-execution.md)
