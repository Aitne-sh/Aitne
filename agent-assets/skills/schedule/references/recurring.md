---
kind: reference
name: recurring
description: /api/recurring-schedules — hourly / daily / weekly / monthly cadences auto-regenerating one-shot rows. Includes hourly anchor semantics, monthly missing-day recipes, and the tier ↔ model swap on PATCH.
---

# Recurring schedules

For tasks that repeat on a fixed pattern. The daemon auto-regenerates
the next one-shot occurrence after each execution; you never have to
re-POST a daily reminder.

Use a recurring schedule when the cadence is all that matters and
there is no need to record *why* the rule exists. If the user wants
the WHY captured alongside the cadence (so the rule survives a
context reset), use the `management-policy` skill — it produces a
`policies/management-captures/<slug>.md` linked to a `policies/routines/custom/<slug>.md`
custom routine.

## POST /api/recurring-schedules — Create

```bash
# Hourly at :00 (every hour)
curl -s -X POST http://localhost:8321/api/recurring-schedules \
  -H 'Content-Type: application/json' \
  -d '{"taskType":"wake","description":"Hourly docker container health check.","recurrenceRule":{"frequency":"hourly"},"tier":"lite"}'

# Every 2 hours at :30 (00:30, 02:30, …, 22:30 local)
curl -s -X POST http://localhost:8321/api/recurring-schedules \
  -H 'Content-Type: application/json' \
  -d '{"taskType":"wake","description":"Sync inbox triage signals.","recurrenceRule":{"frequency":"hourly","intervalHours":2,"minuteOfHour":30},"tier":"lite"}'

# Daily at 09:00
curl -s -X POST http://localhost:8321/api/recurring-schedules \
  -H 'Content-Type: application/json' \
  -d '{"taskType":"wake","description":"Morning inbox triage — check pending observations and update today.md.","recurrenceRule":{"frequency":"daily","time":"09:00"}}'

# Weekly Mon/Wed/Fri at 10:00
curl -s -X POST http://localhost:8321/api/recurring-schedules \
  -H 'Content-Type: application/json' \
  -d '{"taskType":"wake","description":"Standup prep — review PRs, calendar, and blockers.","recurrenceRule":{"frequency":"weekly","time":"10:00","daysOfWeek":[1,3,5]}}'

# Monthly on the 25th at 21:00 (billing reconciliation)
curl -s -X POST http://localhost:8321/api/recurring-schedules \
  -H 'Content-Type: application/json' \
  -d '{"taskType":"wake","description":"Monthly card reconciliation — pull statement, log balance to finance dossier.","recurrenceRule":{"frequency":"monthly","time":"21:00","daysOfMonth":[25]},"tier":"medium"}'
```

| Field | Required | Description |
|---|---|---|
| `taskType` | Yes | Task type for dispatch (e.g. `wake`) |
| `description` | Yes | Self-contained (min 20 chars). Same rules as one-shot. Doubles as the agent body unless `prompt` overrides it. |
| `prompt` | No | Optional override for the agent body (min 20 chars when set). Each materialized one-shot row inherits this from the recurring parent. |
| `recurrenceRule` | Yes | `{ frequency, time?, timezone?, intervalHours?, minuteOfHour?, daysOfWeek?, daysOfMonth?, onMissingDay? }` — fields gated by `frequency`; see grammar below. |
| `tier` | No | `lite` / `medium` / `high`. Mutually exclusive with `model`. |
| `model` | No | Registered model id (`claude-opus-4-7`, `gpt-5.4`, `gemini-3.1-pro-preview`, …), legacy alias (`sonnet` / `opus` — auto-rewritten to `tier`), or composite `<backendId>/<modelId>` for future disambiguation. Mutually exclusive with `tier`. The row stores `(model, backend_id)` together so the dispatcher honors the pin at fire time. |
| `taskContext` | No | Structured metadata object |

### Recurrence rule grammar (engine)

The recurrence engine accepts four frequencies. Each frequency
requires its own set of fields and rejects fields that don't apply.

| `frequency` | Required | Allowed | Forbidden |
|---|---|---|---|
| `"hourly"` | — | `intervalHours` (1..23, default 1), `minuteOfHour` (0..59, default 0), `timezone` | `time`, `daysOfWeek`, `daysOfMonth`, `onMissingDay` |
| `"daily"` | `time` | `timezone` | `intervalHours`, `minuteOfHour`, `daysOfWeek`, `daysOfMonth`, `onMissingDay` |
| `"weekly"` | `time`, `daysOfWeek` (1..7 distinct entries, 0=Sun..6=Sat) | `timezone` | `intervalHours`, `minuteOfHour`, `daysOfMonth`, `onMissingDay` |
| `"monthly"` | `time`, `daysOfMonth` (1..31 distinct entries) | `timezone`, `onMissingDay` (default `"lastDayOfMonth"`) | `intervalHours`, `minuteOfHour`, `daysOfWeek` |

`time` is `HH:MM` 24-hour local. `timezone` is an IANA zone
(`Asia/Tokyo`, `America/New_York`, `UTC`); auto-filled from daemon
config when omitted, but explicit is safer so a roaming laptop does
not surprise the user. The error envelope cites `validValues` on
every range / format failure — read it and resubmit instead of
guessing.

### Hourly anchor semantics

`intervalHours=N` fires when `(localHour % N) == 0` at
`minuteOfHour` local. The anchor is **local midnight** in the rule's
`timezone`, so `intervalHours:2, minuteOfHour:30` fires at 00:30,
02:30, …, 22:30 local — predictable for the user's mental model.

| Intent | `recurrenceRule` |
|---|---|
| Every hour at :00 | `{frequency:"hourly"}` |
| Every hour at :15 | `{frequency:"hourly", minuteOfHour:15}` |
| Every 2 hours at :30 | `{frequency:"hourly", intervalHours:2, minuteOfHour:30}` |
| Every 6 hours at :00 (Asia/Tokyo) | `{frequency:"hourly", intervalHours:6, timezone:"Asia/Tokyo"}` |

DST: in zones that observe it, a skipped local hour drops one fire;
a doubled local hour fires once. Accepted edge case — do not try to
compensate from the caller.

Use hourly sparingly. Sub-hour cadences are not representable (the
minimum is 1 hour); pick a coarser cadence or move the work into a
daemon-internal poller instead.

### Monthly missing-day semantics

Some months don't contain the day the user asked for (Feb 30, Apr
31). `onMissingDay` controls what happens that month:

- `"skip"` — don't fire that month for the missing day.
- `"lastDayOfMonth"` (default) — fire on the actual last day of the
  month. Preserves the pre-redesign clamp behavior, so existing
  recurring rules created before this redesign keep firing
  bit-identically.

The engine de-duplicates calendar dates that collapse to the same
fire (e.g. `daysOfMonth:[28,31]` in non-leap Feb with
`"lastDayOfMonth"` lands on Feb 28 once, not twice).

| Recipe | `recurrenceRule` |
|---|---|
| 25th of every month at 21:00 | `{frequency:"monthly", time:"21:00", daysOfMonth:[25]}` |
| 31st at 21:00, skip Feb/Apr/Jun/Sep/Nov | `{frequency:"monthly", time:"21:00", daysOfMonth:[31], onMissingDay:"skip"}` |
| 31st at 21:00, fall back to last day | `{frequency:"monthly", time:"21:00", daysOfMonth:[31], onMissingDay:"lastDayOfMonth"}` |
| **Last day of every month at 21:00** | same as above — `daysOfMonth:[31] + onMissingDay:"lastDayOfMonth"` clamps Feb/Apr/Jun/Sep/Nov to their last day; the 31st of every other month is already that month's last day |
| 29th at 21:00, skip non-leap Feb | `{frequency:"monthly", time:"21:00", daysOfMonth:[29], onMissingDay:"skip"}` |
| 1st AND 15th at 10:00 | `{frequency:"monthly", time:"10:00", daysOfMonth:[1,15]}` |

When `daysOfMonth` contains 29/30/31 and `onMissingDay` is omitted,
the daemon returns a `warnings[]` entry nudging you to be explicit.
Persistence still happens — the warning is advisory.

Response: `{ "status":"created", "item":{ "id","recurrenceRule","recurrenceLabel","nextRunAt",...}, "warnings":[] }`. `nextRunAt` is the UTC timestamp the engine has materialized as the first one-shot row's `scheduled_for`. `recurrenceLabel` is the human-readable form rendered into `policies/management.md` §B (e.g. `"Every 2 hours at :30 (UTC)"`, `"Monthly on the 31st at 21:00 (Asia/Tokyo); falls back to last day of month"`).

## GET /api/recurring-schedules — List

```bash
curl -s "http://localhost:8321/api/recurring-schedules?enabled=true"
```

Response: `{ "items":[{ "id","taskType","description","recurrenceRule","enabled","nextRunAt","recurrenceLabel","model","backendId","tier","taskContext" }] }`. `model` / `backendId` are populated together when the row pins a registered id; otherwise `model:null, backendId:null` and `tier` carries the pin (or all three are null and the row inherits the dispatcher's process-key default).

## PATCH /api/recurring-schedules/:id — Update

```bash
# Swap a daily rule to hourly + change model to Opus in one PATCH
curl -s -X PATCH http://localhost:8321/api/recurring-schedules/1 \
  -H 'Content-Type: application/json' \
  -d '{"recurrenceRule":{"frequency":"hourly","intervalHours":2,"minuteOfHour":0},"tier":null,"model":"claude-opus-4-7"}'
```

Updatable: `recurrenceRule`, `description`, `prompt` (string sets an
override, `null` clears), `tier` (set / `null` to clear), `model`
(set / `null` to clear), `taskContext`, `enabled`. Changing
`recurrenceRule` / `enabled` auto-reschedules — the pending one-shot
row tied to the old rule is cancelled and a fresh row is materialized
from the new `recurrenceRule` value, preserving the parent's
`(model, backend_id)` or `tier` pin.

**Tier ↔ model swap.** Pass `null` to clear one and a concrete value
to set the other in the same request — the row carries at most one
pin at rest. Setting a registered `model` token also clears any
prior `tier_override`. Setting a legacy alias (`sonnet` / `opus`) on
PATCH is rewritten to `tier:"medium"` / `tier:"high"`; the alias is
never stored verbatim.

**Re-materialization scope.** Changing `model` / `tier` alone does
**not** re-point the already-materialized pending one-shot row — only
`recurrenceRule` / `enabled` re-materialize. Delete the pending row
(`DELETE /api/schedule/:id`) and let the next reconcile pass pick up
the new pin, or PATCH `/api/schedule/:id` directly if you need the
pending row repointed now.

Set `{"enabled":false}` to pause without deleting. Surface
`warnings[]` (e.g. `schedule.model_deprecated`,
`schedule.on_missing_day_unused`) to the next turn — the PATCH still
succeeds but the warning carries replacement guidance.

## DELETE /api/recurring-schedules/:id — Delete

```bash
curl -s -X DELETE http://localhost:8321/api/recurring-schedules/1
```

Deletes the rule and cancels every materialized pending instance.
Response: `{ "status":"deleted", "id":1 }`.

Use pause (`PATCH ... {"enabled":false}`) instead when the user might
want to resume the same cadence later — DELETE loses the
`recurrenceRule` shape and the `taskContext` payload.
