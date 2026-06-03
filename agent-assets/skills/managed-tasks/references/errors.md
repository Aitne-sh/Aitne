---
kind: reference
name: errors
description: /api/managed-tasks error envelope — {ok:false, summary, errors[], retryable} plus POST / PATCH / DELETE codes (validation_error, duplicate, cap_reached, invalid_id, not_found, internal_error).
---

# /api/managed-tasks error envelope

Every error response is the standard daemon envelope:

```jsonc
{
  "ok":        false,
  "summary":   "<one-line human text — surface verbatim>",
  "errors":    [ { "code": "managed_tasks.validation_error", "field": "body", "hint": "..." } ],
  "retryable": false,
  "error":     "<legacy machine-code alias — present on single-issue envelopes>"
}
```

`summary`, `errors[]`, and `retryable` are ALWAYS present. Each
`errors[]` issue carries `code` / `field` / `hint`. The top-level
`error` is a legacy alias for the single issue's code. Legacy aliases
appear only on specific codes: `item` (the existing row) on `409
duplicate`, `message` on duplicate / cap, and `details` (the raw
ZodError) on `validation_error`. Per-verb tables below name the issue
`code`; surface `body.summary` or the issue `hint`, not a paraphrase.

The daemon does NOT emit `cron_too_tight`. Note: the recurrence schema
DOES accept `hourly` (the engine supports `hourly`/`daily`/`weekly`/
`monthly`), so a sub-daily POST is NOT rejected server-side — it
succeeds (201). The daily-or-coarser floor for managed tasks is a
**client-side** refusal only: YOU must refuse sub-daily cadences per
the recurrence-rule reference (`§ Consumer-specific refusal`) before
POSTing — do not expect the server to 400 an `hourly` rule. The daemon
also does not emit `cadence_partial` (the recurrence rule is one
structured field, so there is no partial-cadence shape to reject).

## POST /api/managed-tasks

| HTTP | `error` | When | What to do |
|---|---|---|---|
| 400 | `validation_error` | Body fails Zod (frequency unknown, time malformed, etc.) | Pick the offending field from `body.summary` / the issue `hint` (`details` is a serialized ZodError object, not an array) and ask the user to clarify. |
| 409 | `duplicate` | An existing row has the same `(app_normalized, cadence)` | DM `Already managed as <body.item.id>` and stop. The body's `item` is the existing row. |
| 409 | `cap_reached` | §B already at the active-task cap (default 100) | Surface `body.message` (carries the cap value); user must stop something first. |
| 5xx | `internal_error` | DB / cascade failure | DM "Couldn't register; daemon error. Try again, or check `aitne logs`." |

## PATCH /api/managed-tasks/:id

| HTTP | `error` | When | What to do |
|---|---|---|---|
| 400 | `invalid_id` | `:id` didn't match `^mt_[1-9]\d*$` | User typed the id wrong — ask them to repeat. |
| 400 | `validation_error` | Body fails Zod (empty body, recurrenceRule.daysOfWeek on a `daily`, etc.) | Pin the failing field from `body.summary` / the issue `hint` (`details` is a serialized ZodError object, not an array) and ask for a fix. |
| 404 | `not_found` | No row for `:id` | DM "I don't have an `mt_<id>` to modify"; offer to register one. |
| 5xx | `internal_error` | DB / cascade failure | Surface `body.summary`; advise `aitne logs`. |

## DELETE /api/managed-tasks/:id

| HTTP | `error` | When | What to do |
|---|---|---|---|
| 400 | `invalid_id` | `:id` didn't match `^mt_[1-9]\d*$` | Ask the user to repeat. |
| 404 | `not_found` | No row for `:id` | DM "No managed task with that id"; if you used a fuzzy match, re-list candidates. |
| 5xx | `internal_error` | DB / cascade failure | Surface `body.summary`; advise `aitne logs`. |

## POST /api/managed-tasks/:id/run-now

Success is `202 {status:"queued", mt_id, scheduled_row_id}` — the
route has no concurrency guard, so a fire enqueues unconditionally
(there is no `already_running` code). Errors:

| HTTP | `error` | When | What to do |
|---|---|---|---|
| 400 | `invalid_id` | `:id` didn't match `^mt_[1-9]\d*$` | Ask the user to repeat. |
| 404 | `not_found` | No row for `:id` | Cannot run a stopped task. |
| 5xx | `internal_error` | Dispatcher / cascade failure | Surface the issue `hint`. |

## Idempotency on POST

Per-DM `Idempotency-Key` (recommended: SHA-256 of the inbound message
id + app). Concurrent retries collapse to the same `mt_<n>`. A
different key with the same `(app_normalized, cadence)` collides at
the uniqueness check and the second POST returns `409 duplicate`
with the existing `mt_id` — DM the user pointing at it rather than
registering twice.
