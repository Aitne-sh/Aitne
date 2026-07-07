---
schema_version: 1
slug: reference/process-keys
title: ProcessKeys (Reference)
id: process-keys-ref
aliases:
  - process key list
  - dispatch keys
  - processkey reference
  - routine keys
category: reference
summary: |
  The full list of ProcessKeys, what triggers each, and the default
  tier. Mirrors packages/shared/src/process-key.ts.
section: process-keys
tags:
  - routing
  - backends
status: stable
ask_examples:
  - List all the ProcessKeys
  - What is the default tier for activity scan?
  - Which ProcessKeys are configurable from the dashboard?
  - What is routine.fetch_window used for?
locale: en-US
keywords:
  - processkey
  - ProcessKey
  - dispatch
  - tier
  - lite
  - medium
  - high
  - routine.morning_routine
  - routine.fetch_window
  - message.dm
  - calendar.change
  - delegated_task
  - gmail_classify
created: 2026-04-25
updated: 2026-07-01
config_keys:
  - monthlyReviewEnabled
  - delegatedTaskHeavyEnabled
  - activityScanIntervalMinutes
  - dayBoundaryHour
api_endpoints:
  - POST /api/browser-task
ui_anchors:
  - /settings/models
related:
  - concepts/process-keys
  - concepts/backends-and-tiers
  - features/operations/backend-routing
  - features/integrations/browser-history
  - features/operations/managed-chromium
---

# ProcessKeys

A **ProcessKey** is a label for one kind of work the agent runs — an owner
DM, the morning routine, an activity scan, and so on. When a piece of work
starts, the dispatcher hands its ProcessKey to the `BackendRouter`, which
turns the key into a `{ main, fallback }` backend pair plus an execution
tier. The dispatcher itself never picks a model; the router does that.

The **default tier** column maps to a model size, not to a specific id:

- `lite` → Haiku-class (cheap, fast, narrow)
- `medium` → Sonnet-class (the default for most owner-facing and routine work)
- `high` → Opus-class (opt-in only; see [Tier Locks](#tier-locks) and
  [Delegated Task Hard Caps](#delegated-task-hard-caps))

| ProcessKey | Trigger | Default tier | Configurable |
|---|---|---|---|
| `routine.morning_routine` | Daily at `dayBoundaryHour` (default 04:00). Parent envelope; LLM dispatch flows through the two stage keys below. | medium | yes |
| `routine.morning_routine_today` | Stage A of the morning-routine pipeline — `state/today.md` synthesis, schedule fan-out, profile-question pick, user-editable checks. Stage A also populates `plans/roadmap.md` from a daemon-prepared `<roadmap_skeleton>` block on the first-run branch (Phase 7 retired the heavy-tier `routine.morning_routine_initial`). | medium | yes |
| `routine.morning_routine_journal` | Stage B of the morning-routine pipeline — authors `journal/daily/<yesterday>.md` from the daemon-prepared journal skeleton. | lite | yes |
| `routine.today_refresh` | Calendar-drift-triggered (calendar change touching today's items; 5-min dedup, fires ~30s later) — drift-refresh of `state/today.md` | medium | yes |
| `routine.evening_review` | Daily at 18:00 local (fixed) | medium | yes |
| `routine.weekly_review` | Friday 19:00 local (fixed) | medium | yes |
| `routine.monthly_review` | Monthly cadence (gated OFF by default — opt in by enabling the monthly-review agent at `/agents/monthly-review`; the legacy `monthlyReviewEnabled` config key is a deprecated fallback). The routine itself is off by default, but its backend/tier binding is still configurable. | medium | yes |
| `routine.activity_scan` | Every N interval minutes (default 60) inside the active window — cadence set on `/agents/activity-scan`; legacy key `activityScanIntervalMinutes` is a deprecated fallback | medium | yes |
| `routine.activity_scan.triage` | Stage 2 triage gate of every activity scan | lite | yes |
| `routine.fetch_window` | Pre-pass fetcher spawned before each main routine | lite | yes |
| `routine.user_profile_sweep` | Periodic agent-day profile summarization pass | medium | no |
| `routine.roadmap_refresh` | Periodic roadmap re-derivation (NOT in `ROUTINE_WINDOWS` — no `routine.fetch_window` pre-pass; the synthesis session itself drives the native-mode MCP fan-out) | medium | yes |
| `routine.skill_curation` | Background skill-curation / overlay refinement loop (cron cadence picked at `/settings/self-learning`) | medium | yes |
| `routine.custom.<slug>` | Retired — legacy custom routines no longer fire; they were converted to user Agents running under `agent.task` (see [Custom Routines (Retired)](../features/routines/custom-routines.md)). Seen only in historical Activity rows. | — | no |
| `message.dm` | Owner DM | medium | yes |
| `message.mention` | @-mention in a paired Slack channel where the agent is invited (DMs are `message.dm`; Telegram/WhatsApp groups are filtered out) | medium | yes |
| `dashboard.chat` | `/chat` send | medium | yes |
| `dashboard.docs_qa` | Docs QA panel — tier is hard-forced to medium regardless of any `message.dm` override; backend choice still inherits | medium (forced) | yes (backend only) |
| `agent.task` | Future-dated agent action (recurring schedules) | medium | yes |
| `agent.dm_task` | DM-tone scheduled session (e.g. morning briefing) | medium | yes |
| `schedule.approaching` | Pre-event reminder | medium | no |
| `calendar.change` | Calendar event added / moved / cancelled | lite | yes |
| `gmail_classify` | Mail classifier inference | lite | yes |
| `delegated_task` | Generic delegated sub-job invocation | lite | no (server-resolved) |
| `delegated_task_heavy` | Opt-in heavy variant gated by `delegatedTaskHeavyEnabled` (Approve-tier) | high | no (server-resolved) |
| `observation.summarize` | Per-observation summarizer (cost-reduction §A) | lite | yes |
| `integration_drift_sync` | Periodic drift-reconciler across connected integrations | lite | no |
| `knowledge.import` | One-shot heavy session that ingests an owner-uploaded knowledge file | medium | no |
| `setup` | One-shot setup wizard backend probe / write | medium | no |
| `git.lifecycle.poll` | Git repo poll observer | lite | yes |
| `git.push.detected` | New push on a watched git repo | lite | yes |
| `git.push.force_pushed` | Force-push detected on a watched repo | lite | yes |
| `git.branch.created` | New branch on a watched repo | lite | yes |
| `git.tag.created` | New tag on a watched repo | lite | yes |
| `git.merge_to_default` | Merge into the default branch | lite | yes |
| `git.local_ahead.stale` | Local branch ahead of remote for too long | lite | yes |
| `git.project.{init,update}` | Repo overview skeleton + daily journal scan — deterministic in-process daemon writers; no agent session runs, so the tier is unused in practice | medium | yes |
| `git.project.{refresh_architecture,retemplate}` | Agent-run project-doc sessions (architecture analysis, template re-conform) — one-shot, generative | medium | yes |
| `github.assigned` | Issue / PR assigned to the operator | lite | yes |
| `github.pull_request.review_requested` | PR review requested | lite | yes |
| `github.workflow_run.failed` | CI run failed on a tracked repo | lite | yes |
| `github.security_alert` | Dependabot / security alert raised | lite | yes |
| `wiki.ingest_url` | URL → vault ingest (WIKI_BUILDER_DESIGN P1) | medium | yes |
| `wiki.compile` | Raw → wiki synthesis (P1) | medium | yes |
| `wiki.ask` | Q&A against the compiled wiki (P1) | medium | yes |
| `wiki.lint` | Health pass over the wiki — writes `90_meta/health/<date>.md` | medium | yes |
| `wiki.trace` | Chronological evolution of an idea across raw / wiki / outputs | medium | yes |
| `wiki.connect` | Bridges two domains — writes `30_outputs/<date>-connect-<slug>.md` | medium | yes |
| `routine.research_cluster_update` | Nightly per-cluster journal append (one row per cluster per day with new activity) | lite | yes |
| `routine.research_offer_dm` | Two-Option Offer DM composition when a research cluster qualifies | lite | yes |
| `routine.research_dispatch` | Accept path for the "research dive" option — WebSearch + WebFetch parallel research. Claude-only per §10.3 backend safety floor. | medium | yes |
| `routine.research_wiki_summary` | Accept path for the "wiki summary" option — writes a wiki note into Obsidian inbox / Notion / local context per integration availability | medium | yes |
| `browser_task` | Open-ended browser sub-agent (BROWSER_TASK_REDESIGN_PLAN.md §6.1). Claude-only backend floor; dispatched from `POST /api/browser-task` (DM, dashboard, or scheduler). | medium | yes |

**Configurable** means the operator can override the backend or tier for
that key on `/settings/models` — these are the keys listed in
`CONFIGURABLE_PROCESS_KEYS`. **no** means the binding is fixed and always
uses the global default for its tier.

This list mirrors `packages/shared/src/process-key.ts`. The codebase
is the source of truth.

## Reactive vs Autonomous

Reactive keys run while the owner is in the loop, waiting on a reply.
`REACTIVE_PROCESS_KEYS` holds them: `message.dm`, `message.mention`,
`dashboard.chat`, `dashboard.docs_qa`, `setup`, `knowledge.import`. Every
other key is autonomous — it runs on its own, under the tighter Approve-tier
MCP tool-stripping that B-003 Phase 3 established.

## Tier Locks

`TIER_LOCKED_PROCESS_KEYS` supersedes operator pins. Current entry:

- `dashboard.docs_qa` → `medium` (DOCS_QA_DESIGN.md §10.1).

## Delegated Task Hard Caps

The `delegated_task` / `delegated_task_heavy` request shape is bounded
by `DELEGATED_TASK_HARD_CAPS` (server-enforced, not user-tunable):

- `maxToolCalls` ≤ 15
- `maxBudgetUsd` ≤ 0.50
- `maxTimeoutMs` ≤ 300 000
- `maxSchemaBytes` ≤ 4096

`config.ts` holds the *defaults* (`delegatedTaskDefaultMaxToolCalls`, …),
but the caps above bound the request even when a prompt-injected caller
tries to raise the per-request fields.
