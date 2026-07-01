---
name: schedule
description: Schedule future agent wake-ups, pre-composed DMs, or recurring tasks via /api/schedule. Use when registering a timed follow-up, a one-off reminder, or de-duping against pending schedules.
allowed-tools:
  - Bash(curl *)
  - Read
---

# Schedule Wake-Up Decision Guide

## When to Schedule
Register a wake-up when **all three** are true:
1. There is follow-up work that must happen at a specific time
2. The current session is ending before that time
3. No other session will reliably pick it up (a peer routine, an SSE poll, etc.)

Common triggers: morning routine end, calendar event prep (15 min before), deadline/reminder requests, in-flight work needing follow-up (e.g. PR review).

## Before creating — dedup pre-check (mandatory)

Every `POST /api/schedule` / `POST /api/schedule/dm` call MUST be
preceded by a dedup scan. Duplicate schedules are invisible to the
user but compound into duplicate DMs/notifications at fire time.

1. **Agent Plan check.** Scan `<today>` `## Agent Plan` for a row with
   HH:MM within ±15 min of your target AND an overlapping subject. If
   present, the plan is already in place — do NOT add a second one.
2. **Pending schedule check.** In a live owner DM pending one-off rows
   appear in `<scheduled_reminders>` — dedup there and cancel/PATCH any
   the conversation made moot. Else `GET
   /api/schedule?status=pending,running` for one within ±15 min with a
   matching `description`; if found, skip or PATCH.
3. **Recurring check.** `GET /api/recurring-schedules?enabled=true` to
   confirm no recurring rule/Agent already covers this cadence (e.g. a
   daily 09:00 inbox triage, or the morning briefing). If covered, skip.
   (How recurring work/DMs are created — see "Recurring" below.)
4. **`confirm_dedup_key` check (mandatory for `confirm:` sub-flow rows
   only).** When scheduling a `dm_session` row with
   `taskContext.sub_flow="confirm"`, run the dedup pre-check + shape
   contract documented in
   `task-flows/_partials/confirm-subflow.md` (also included verbatim
   by `scheduled.dm.md` and `message.received.dm{,_first}.md`). The
   single source covers the `dedup_key` filter, the
   `<gate>:<stable-topic>` shape, and cross-path cancellation.

Log the skip to `## Agent Log`:
`- HH:MM [schedule] skipped <subject>: duplicate of <planId|row>`.

Only after all four clear do you create the new schedule.

## When the user wants a durable rule, not a wake-up

If the request expresses an **ongoing management practice** with a
recorded reason — "every morning, run my finance app and log the
balance to a finance dossier", "from now on whenever X happens, do
Y" — switch to the `management-policy` skill instead. It creates a
`policies/management-captures/<slug>.md` that captures the WHY alongside the cadence
(scheduled via a linked recurring Agent, `POST /api/agents`) so the rule
survives a context reset. When the cadence is all that matters and there is no intent to
record, create the recurring work/DM per the "Recurring" section below.

## DM vs Agent Task

| Criterion | `/api/schedule/dm` (free) | `/api/schedule` (~$0.03) |
|---|---|---|
| Message text knowable now? | Yes | No — needs lookup/decision at execution |
| Needs calendar/API data at execution? | No | Yes |
| Multi-step action at execution? | No | Yes |
| Conditional on state that may change? | No | Yes |

**Default to DM** when possible. Every agent wake-up costs money and context.

## Writing a Good Prompt (for agent tasks)

> **The wake-up agent has NO memory of why it was scheduled.** A `scheduled.task` session is self-contained: it receives only `state/today.md` (which carries the day's schedule and state) plus the `prompt` + `taskContext` you provide — **NOT** `identity/profile.md` or `policies/management.md` (the `scheduled.task` injection policy opts those out). Nothing else. (`description` is just an optional list label — never the agent body.)

Author the `prompt` with the **core frame** below. A one-shot task rarely needs the
extended (operational) sections; if a one-shot *does* mutate code or state, add two
sections on top of the core frame — `# Scope` (WHERE it may act: the editable
surface, and what it must not touch) and `# Verification` (which checks confirm the
change is good, and "don't claim success unless they passed").

{{> ref:prompt-frame }}

For a simple one-shot — a timed reminder — the frame collapses to one tight,
self-contained brief:

**Good:** `"15-minute reminder for the 14:00 design review. Attendees: Sarah, Mike. Agenda: API v2 breaking changes. Prepare the meeting-note template and notify the user via Slack."`

**Bad:** `"Meeting prep"` — which meeting? when? what to prepare?

## Using `taskContext`
Structured metadata for IDs, URLs, and correlation. Put long identifiers here so the `prompt` stays focused:
```json
{ "scheduledBy": "morning_routine", "prUrl": "https://github.com/user/repo/pull/42" }
```

**`importance`** controls whether a row becomes a `plans/roadmap.md` `Scheduled:` entry. Default `transient` for `/api/schedule/dm`, `normal` for `/api/schedule`; use `strategic` only for roadmap-shaped long-prep reminders. Tier table + defaults in the reference below.

{{> ref:importance }}

## Tier / Model selection

Pick `tier` (`lite` / `medium` / `high`) by default — backend-neutral cost knob. Pin `model` (registered id, alias, or `<backendId>/<modelId>`) only when the row must outlive a `/settings/models` re-route. Mutually exclusive — both set returns `schedule.tier_and_model_conflict`. Omit both to use the dispatcher's process-key default. Discovery, PATCH swap form, alias rewrite, and `/api/schedule/options` payload are in the reference below.

{{> ref:model-selection }}

## Time discipline
- **Absolute time required** — resolve relative expressions via `<current_time>` into ISO 8601 with offset. E.g. "in 1 hour" at 15:30 EDT → `2026-04-06T16:30:00-04:00`.
- **No quiet hours (default 22:00-08:00, configurable)** unless `critical` priority.
- **Check today.md Schedule** before creating wakes to avoid piling onto a busy hour.

## Budget
- **Max 5 wake-ups per execution.** Consolidate into a single briefing task if more.
- **Morning Routine batches all day's wake-ups at once.** Other events schedule only immediate needs.

## Lock-step on PATCH / DELETE

Agent Plan rows and schedule entries move together in both directions.
When a schedule you PATCH or DELETE backs an `## Agent Plan` row in
<today>, update that row in the same turn — today skill §"Agent Plan
revision — cancel / amend" (flip + `(cancelled: <reason>)`, or re-time
the row) — and append the Agent Log line. A schedule edit without the
row edit leaves a plan that lies.

---

## API Reference

### POST /api/schedule/dm — Schedule a direct DM
Sends a pre-composed message at the specified time. No AI agent invoked.
```bash
curl -s -X POST http://localhost:8321/api/schedule/dm \
  -H 'Content-Type: application/json' \
  -d '{"time":"2026-04-06T16:00:00-04:00","message":"Reminder: Design review in 30 min.","platform":"slack"}'
```
| Field | Required | Description |
|---|---|---|
| `time` | Yes | ISO 8601 with timezone offset |
| `message` | Yes | Complete message text — sent as-is |
| `platform` | No | Target platform (defaults to primary) |
| `importance` | No | `transient` (default), `normal`, or `strategic`. Use `strategic` only for roadmap-shaped long-prep reminders. |

Response: `{ "status":"scheduled", "scheduleId":"123", "scheduledFor":"..." }`. Rejects times in the past (> 1 min ago).

### POST /api/schedule — Schedule an agent task
```bash
curl -s -X POST http://localhost:8321/api/schedule \
  -H 'Content-Type: application/json' \
  -d '{"time":"2026-04-06T16:00:00-04:00","taskType":"wake","prompt":"Hourly docker health check: run `docker ps --format` and DM if any container is in restart loop.","description":"Docker health check","tier":"lite","taskContext":{"scheduledBy":"docker_monitor"}}'
```
| Field | Required | Description |
|---|---|---|
| `time` | Yes | ISO 8601 with timezone offset |
| `taskType` | Yes | Free-form provenance label; use `wake` for agent wake-ups. The closed set `wake`/`dm_session`/`check`/`dm` is enforced only on `/api/schedule/batch`. The label doesn't change firing — every non-`dm`/`dm_session`/`browser_task` row runs as a generic `scheduled.task`. |
| `prompt` | Yes | The agent's instruction at fire time — its ONLY context (the session has no memory). Self-contained: what + why + who + expected output. See format above. Max 8000 chars (~2000 tokens); move bulk reference material into a file the agent reads at fire time rather than inlining it. |
| `description` | No | Optional short label shown in the schedule list (max 200 chars). NOT the agent body — that is `prompt`. Omit it and the list shows a `prompt` excerpt. |
| `tier` | No | `lite` / `medium` / `high`. Omit to use the dispatcher's process-key default (medium for `scheduled.task`). See "Tier / Model selection" above. Mutually exclusive with `model`. |
| `model` | No | Registered model id (`claude-opus-4-8`, `gpt-5.4`, …), legacy alias (`sonnet` / `opus`, auto-rewritten to `tier`), or composite `<backendId>/<modelId>`. See "Tier / Model selection" above. Mutually exclusive with `tier`. |
| `taskContext` | No | Structured metadata object |

Response: `{ "status":"scheduled", "scheduleId":"123", "scheduledFor":"YYYY-MM-DD HH:MM:SS" }`. `scheduledFor` is the normalized UTC SQLite timestamp the daemon actually stored — log this verbatim instead of re-formatting the input `time`. Rejects times in the past (> 1 min ago), same as `/api/schedule/dm`.

### PATCH /api/schedule/:id — Edit a pending item
```bash
curl -s -X PATCH http://localhost:8321/api/schedule/42 \
  -H 'Content-Type: application/json' \
  -d '{"time":"2026-04-06T17:00:00-04:00"}'
```
Fields: `time` (ISO 8601), `prompt` (the agent instruction, ≤8000 chars, non-dm only — cannot be cleared; a row must always carry a non-empty prompt), `description` (optional label ≤200 chars, non-dm only), `message` (dm only), `tier` (`lite`/`medium`/`high` OR `null` to clear), `model` (registered id / alias / composite OR `null` to clear), `taskContext`. At least one required. Only `pending` items editable. `description`/`message` mutually exclusive; `prompt`/`message` mutually exclusive. Tier ↔ model swap form is in the model-selection reference above. Response: `{ "status":"updated", "id":42, "warnings":[] }` / 404 / 409 — surface `warnings[]` (e.g. `schedule.model_deprecated`) to the next turn.

### GET /api/schedule — List scheduled items
```bash
curl -s "http://localhost:8321/api/schedule?status=pending"
```
Param `status` (default `pending,running`): comma-separated `pending`, `running`, `completed`, `failed`, `skipped`. DELETE/cancel does not remove a row — it moves it to `status='skipped'`, so re-listing a cancelled item requires `status=skipped`.
Param `roadmapEligible=true`: return only rows that may become
roadmap `Scheduled:` entries (`transient` / `low` excluded, `normal`
only beyond 7 days, `strategic` included).
Response: `{ "items":[{ "id","scheduledFor","taskType","description","prompt","status","model","backendId","tier","taskContext","createdAt" }] }`. `prompt` / `tier` / `model` / `backendId` are `null` when no override is set. `model` is a registered id verbatim and travels with `backendId` when set — the row carries either the `(model, backendId)` pin or `tier`, never both. Legacy alias inputs (`sonnet` / `opus`) are normalized to `tier` at write time. `taskContext` is the parsed JSON (always an object — `{}` when unset); filter with `jq` e.g. `'.items[] | select(.taskContext.confirm_dedup_key == "create_project:la-pm-masters")'`.

### DELETE /api/schedule/:id — Cancel a pending item
```bash
curl -s -X DELETE http://localhost:8321/api/schedule/42
```
Only cancels `pending` items. Response: `{ "status":"cancelled", "id":42 }` / 404 / 409.

### POST /api/schedule/batch — Bulk register rich-context schedules

Morning-routine Stage A only. Single-row callers use `POST /api/schedule`
above. The required `taskContext.background` + `expected_output`
fields, the 50-row cap, the atomic / per-row commit modes, and the
success payload are in the batch reference below.

{{> ref:batch }}

---

## Errors

Every endpoint in this skill emits errors in the **agent-consumable
envelope** — read `errors[].hint`, fix the value at `errors[].field`,
and resubmit the same body. The full envelope shape and every
`schedule.*` code (request-shape, time-bound, row-content, taskContext,
model, batch) are in the errors reference below.

{{> ref:errors }}

---

## Recurring: work → Agent; DM → dm_session

`/schedule` registers **one-shot** wake-ups and DMs. For repeating tasks:

- **Recurring autonomous work** (daily inbox triage, weekly review, hourly
  health check) is a **recurring Agent** — a durable, named identity with
  metrics on `/agents`. Create it with the **`agent-create` skill**
  (`POST /api/agents`). Creating a recurring `agent.task` row directly on
  `POST /api/recurring-schedules` is **410 Gone** — use an Agent.
- **Recurring scheduled DM / briefing** ("DM me a summary every morning")
  stays on `POST /api/recurring-schedules` with `taskType: "dm_session"`
  (its fire time can track quiet-hours; PATCH/DELETE edit it). The morning
  briefing is one of these.

`GET /api/recurring-schedules` stays read-only for the dedup pre-check.

### recurrenceRule grammar — the shared recurrence engine

The recurrence engine grammar (mapping table, frequency-vs-field matrix,
cadence-string discipline) is shared with the `managed-tasks` skill and
the `dm_session` recurring rule above. The reference is byte-identical
across both skills —
pinned by `skills-manifest.test.ts` so they cannot drift.

{{> ref:recurrence-rule }}
