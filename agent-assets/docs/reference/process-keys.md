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
  - core
  - reference
  - dispatch
  - backends
  - routing
status: stable
ask_examples:
  - List all the ProcessKeys
  - What is the default tier for hourly check?
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
updated: 2026-05-15
related:
  - concepts/process-keys
  - concepts/backends-and-tiers
  - features/operations/backend-routing
---

# ProcessKeys

| ProcessKey | Trigger | Default tier | Configurable |
|---|---|---|---|
| `routine.morning_routine` | Daily at `dayBoundaryHour` (default 04:00). Parent envelope; LLM dispatch flows through the two stage keys below. | medium | yes |
| `routine.morning_routine_today` | Stage A of the morning-routine pipeline — today.md synthesis, schedule fan-out, profile-question pick, user-editable checks. Stage A also populates roadmap.md from a daemon-prepared `<roadmap_skeleton>` block on the first-run branch (Phase 7 retired the heavy-tier `routine.morning_routine_initial`). | medium | yes |
| `routine.morning_routine_journal` | Stage B of the morning-routine pipeline — authors `daily/<yesterday>.md` from the daemon-prepared journal skeleton. | lite | yes |
| `routine.today_refresh` | Every 4h inside the active window — drift-refresh of `today.md` | medium | yes |
| `routine.evening_review` | Daily at 18:00 local (fixed) | medium | yes |
| `routine.weekly_review` | Friday 18:00 local (fixed) | medium | yes |
| `routine.monthly_review` | Monthly cadence (gated OFF by default — kill switch `monthlyReviewEnabled` in runtime settings) | medium | no |
| `routine.hourly_check` | Every `hourlyCheckIntervalMinutes` (default 60) inside the active window | medium | yes |
| `routine.hourly_check.triage` | Stage 2 triage gate of every hourly check | lite | yes |
| `routine.fetch_window` | Pre-pass fetcher spawned before each main routine | lite | yes |
| `routine.user_profile_sweep` | Periodic agent-day profile summarization pass | medium | no |
| `routine.roadmap_refresh` | Periodic roadmap re-derivation (NOT in `ROUTINE_WINDOWS` — no `routine.fetch_window` pre-pass; the synthesis session itself drives the native-mode MCP fan-out) | medium | yes |
| `routine.skill_curation` | Background skill-curation / overlay refinement loop (cron cadence picked at `/settings/self-learning`) | medium | yes |
| `routine.custom.<slug>` | Operator-defined recurrence (see [Custom Routines](../features/routines/custom-routines.md)) | configurable | yes |
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
| `git.project.{init,update,refresh_architecture,retemplate}` | Project-doc lifecycle hooks for watched repos (one-shot, generative — Sonnet by default) | medium | yes |
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

"Configurable" = the operator can override the backend / tier on
`/settings/models` (i.e. the key appears in `CONFIGURABLE_PROCESS_KEYS`).
"no" means the binding is fixed and uses the corresponding tier's
global default.

This list mirrors `packages/shared/src/process-key.ts`. The codebase
is the source of truth.
