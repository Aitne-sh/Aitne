---
kind: reference
name: errors
description: Agent-consumable error envelope shape + every `schedule.*` code emitted by /api/schedule and /api/schedule/batch.
---

# Schedule error envelope + codes

Every endpoint in this skill emits errors in the
**agent-consumable envelope** so you can self-correct in the same
turn instead of retrying blindly:

```jsonc
{
  "ok": false,
  "summary": "1 validation error. Fix the listed errors and retry.",
  "errors": [
    {
      "rowIndex": 2,                                  // null when not a batch row
      "code": "schedule.task_context_field_missing",  // stable machine code
      "field": "rows[2].taskContext.background",      // JSON-pointer-ish path
      "received": "<missing>",
      "expected": "string with >= 30 characters explaining why this task is being scheduled",
      "constraint": { "type": "string", "minLength": 30, "required": true },
      "validValues": null,                             // runtime-derived set, when applicable (see "validValues vs constraint.enum")
      "hint": "Stage A must populate taskContext.background so the future session can produce high-quality output without re-deriving context. Example: ...",
      "skillAnchor": "schedule#taskContext-required-fields",
      "docsUrl": "agent-assets/skills/schedule/references/errors.md#task_context_field_missing",
      "severity": "error"
    }
  ],
  "warnings": [],                                      // non-blocking advisories — see "Warnings channel"
  "retryable": true,
  "retryHint": "Fix the listed rows and POST the same body again. atomic=true (the default) means no rows were committed."
}
```

When you see an error: read `errors[].hint`, fix the value at
`errors[].field`, and resubmit the same body. The morning-routine
task-flow gates batch retries on `rowsCommitted === rows.length`; do
not retry a row-level fix on a different field path.

## Issue fields

| Field | Use |
|---|---|
| `code` | Stable namespaced identifier. Switch on this in skill prose, not on `expected` or `hint`. |
| `field` | JSON-pointer-ish path to the offending input (`rows[2].taskContext.background`). |
| `received` | Exact value the daemon saw. `'<missing>'` sentinel when the field was omitted. |
| `expected` | One-sentence summary of what would have been accepted. |
| `constraint` | Static, schema-level shape (`{type, minLength, enum: [...]}`). Fixed across deploys. |
| `validValues` | Runtime-derived list of acceptable values — populated when the answer is data the operator can change (model registry, IANA timezones, an integration's supported modes). Distinct from `constraint.enum`: never both on the same code. |
| `hint` | Concrete remediation guidance with an example. |
| `skillAnchor` | `<skill>#<slug>` reference for fuller context — `Read agent-assets/skills/<skill>/SKILL.md#<slug>`. |
| `docsUrl` | Repo-relative path to deeper "what to do" prose, including a fragment that lands on the code's heading in this file. |
| `severity` | `error` blocks the commit; `warning` is advisory only (also surfaced via `warnings[]` — see below). |

### validValues vs constraint.enum

These two fields look alike but answer different questions:

- **`constraint.enum`** — schema-level static list (`["lite","medium","high"]`, `["hourly","daily","weekly","monthly"]`). Same on every deploy.
- **`validValues`** — runtime-derived list (the model registry snapshot, which evolves as new models are registered; the IANA timezone set; an integration's `supportedModes`). Filled by the route at error-time.

Use `validValues` when present — it reflects what the daemon will accept on this run, including any newly added entries. `constraint.enum` is the
specification-time guarantee. The two never appear together on the same code.

## Warnings channel

Some inputs are syntactically valid but suspicious enough to flag —
deprecated model on a long-lived recurring rule, `daysOfMonth:[31]`
with the default `lastDayOfMonth` policy, etc. The daemon does **not**
reject these; the row is persisted and the response returns 200/201
with a `warnings: []` array using the same issue shape as `errors[]`:

```jsonc
{
  "status": "created",
  "item": { "id": 42, "recurrenceRule": { ... }, "nextRunAt": "2026-05-31T12:00:00Z" },
  "warnings": [
    {
      "rowIndex": null,
      "code": "schedule.on_missing_day_unused",
      "field": "recurrenceRule.onMissingDay",
      "received": "lastDayOfMonth",
      "expected": "onMissingDay only matters when daysOfMonth contains 29, 30, or 31",
      "hint": "Drop onMissingDay or add 29/30/31 to daysOfMonth.",
      "skillAnchor": "schedule#monthly-missing-day",
      "severity": "warning"
    }
  ]
}
```

Surface warnings to the next agent turn (e.g. include them in the
DM that confirms the schedule was created) so the LLM can refine on
the next call if the warning matters. **Don't treat warnings as
failures** — they are advisory, not blocking. `retryable` is computed
from `errors[]` only and ignores `warnings[]`.

When the same envelope contains both `errors` and `warnings`, the
errors path runs first: fix every entry in `errors[]`, then inspect
`warnings[]` on the retried response.

## Codes the schedule endpoints can emit

### Request-shape codes

Apply to `POST /api/schedule` and `POST /api/schedule/batch`.

<a id="request-shape"></a>

| Code | When | Fix |
|---|---|---|
| <a id="body_not_object"></a> `schedule.body_not_object` | Body is not a JSON object. | POST `{"rows":[…]}` for batch, or the row fields directly for single-row. |
| <a id="rows_field_missing"></a> `schedule.rows_field_missing` | Batch body is missing the `rows` array. | Wrap your row objects in a `rows` array. |
| <a id="rows_too_many"></a> `schedule.rows_too_many` | Batch contains > 50 rows. | Split into chunks of at most 50 rows. |
| <a id="batch_atomic_invalid"></a> `schedule.batch_atomic_invalid` | `atomic` is not a boolean. | Pass `true` / `false`, or omit (defaults to `true`). |

### Time-bound codes

<a id="scheduledFor-bounds"></a>

| Code | When | Fix |
|---|---|---|
| <a id="scheduled_for_invalid"></a> `schedule.scheduled_for_invalid` | `scheduledFor` / `time` is not parseable by `Date()`. | Use ISO 8601 with timezone offset. Resolve relative times via `<current_time>`. |
| <a id="scheduled_for_in_past"></a> `schedule.scheduled_for_in_past` | `scheduledFor` is earlier than now (with a 1-minute grace). | Pick a future time. Inspect `<current_time>` and pick now+1min minimum. |

### Row-content codes

<a id="taskType"></a>
<a id="description-shape"></a>

| Code | When | Fix |
|---|---|---|
| <a id="task_type_unknown"></a> `schedule.task_type_unknown` | `taskType` is not `wake` / `dm_session` / `check` / `dm`. | Pick the matching type. Use `/api/schedule/dm` for the precomposed-DM variant. |
| <a id="description_too_short"></a> `schedule.description_too_short` | `description` / `taskDescription` < 20 chars. | Expand the description so the wake-up agent has enough context to act. |
| <a id="prompt_too_short"></a> `schedule.prompt_too_short` | `prompt` / `taskPrompt` is set but < 20 chars. | Either remove it (description doubles as the body) or expand it. |

### taskContext required fields

<a id="taskContext-required-fields"></a>

For `POST /api/schedule/batch`, every row's `taskContext` must carry
`background` (>=30 chars) and `expected_output` (>=20 chars). The
future session firing at the scheduled time inherits these verbatim
— its output quality is bounded by the richness of what you write
here.

| Code | When | Fix |
|---|---|---|
| <a id="task_context_field_missing"></a> `schedule.task_context_field_missing` | `taskContext.background` or `taskContext.expected_output` is absent. | Populate both. `background` explains *why* this row exists; `expected_output` defines what "done" looks like. |
| <a id="task_context_field_too_short"></a> `schedule.task_context_field_too_short` | One of the required taskContext fields is below its min length. | Expand the string. Trivial values like "follow up" don't survive a 4-hour gap. |
| <a id="task_context_field_wrong_type"></a> `schedule.task_context_field_wrong_type` | A typed taskContext slot received the wrong type (e.g. `references` is a string instead of `string[]`). | Match the schema: references is `string[]`, tier_override is `null|"lite"|"medium"|"high"`, tone is a free string. |

### Model selection

<a id="model-selection"></a>
<a id="tier-selection"></a>
<a id="tier-vs-model"></a>

`model` accepts a free-form token after SCHEDULE_API_REDESIGN_PLAN
§4.3: legacy aliases (`sonnet` / `opus` — rewritten to `tier` at
the route), full registered model ids (e.g. `claude-opus-4-7`,
`gpt-5.4`), or the composite `<backendId>/<modelId>` form when an
id appears under multiple backends. `tier` (`lite` | `medium` |
`high`) is the abstract cost knob and is mutually exclusive with
`model`. Prefer `tier` for new schedules — the dispatcher picks the
latest non-deprecated model per resolved process key automatically.

| Code | When | Fix |
|---|---|---|
| <a id="model_unknown"></a> `schedule.model_unknown` | `model` is not a registered alias / model id. | Inspect `validValues.aliases` and `validValues.models` on the response — these list every value the daemon will accept right now. Omit `model` to let `process_backend_config` decide. |
| <a id="model_ambiguous"></a> `schedule.model_ambiguous` | `model` matches more than one backend in the registry. | Resubmit using the composite `<backendId>/<modelId>` form (see `validValues.matches`). |
| <a id="model_deprecated"></a> `schedule.model_deprecated` (warning) | `model` is registered but flagged deprecated. | The row was still created. Switch to a non-deprecated id from `validValues.availableModels`, or use `tier` instead. |
| <a id="backend_id_unknown"></a> `schedule.backend_id_unknown` | Backend portion of the composite token is not `claude` / `codex` / `gemini` / `opencode`. | Use one of the four BackendId values. |
| <a id="tier_unknown"></a> `schedule.tier_unknown` | `tier` is not `lite` / `medium` / `high`. | Pick one of the three tiers or omit entirely. |
| <a id="tier_and_model_conflict"></a> `schedule.tier_and_model_conflict` | Both `tier` AND `model` set on the same row. | Pick exactly one: `tier` (recommended) OR `model`. On PATCH you can clear one and set the other in the same request (pass `null` to clear). |

### Batch-shape codes

<a id="batch-shape"></a>

See the table under "Request-shape codes" above. `rowsAttempted` /
`rowsCommitted` in the envelope tell you how much of the batch
committed; with `atomic:true` (the default) every error means
`rowsCommitted === 0`.

### Recurring-schedules (`/api/recurring-schedules`)

<a id="recurring-shape"></a>

POST and PATCH `/api/recurring-schedules` route every Zod validation
failure through `translateZodError` so each offending field surfaces
as its own code instead of collapsing onto one
`recurring_schedules.validation_error` issue. The codes below mirror
the per-frequency rules in `recurrence-rule.md`.

| Code | When | Fix |
|---|---|---|
| <a id="frequency_unknown"></a> `schedule.frequency_unknown` | `recurrenceRule.frequency` not in the enum. | Pick `hourly` / `daily` / `weekly` / `monthly`. |
| <a id="frequency_field_mismatch"></a> `schedule.frequency_field_mismatch` | Wrong fields for the chosen frequency (e.g. `time` on `hourly`, `daysOfWeek` on `daily`). | See `validValues.requiredFor` / `forbiddenFor` for the exact matrix. |
| <a id="interval_hours_out_of_range"></a> `schedule.interval_hours_out_of_range` | `intervalHours` outside `[1, 23]`. | Use 1..23; for daily switch frequency. |
| <a id="minute_of_hour_out_of_range"></a> `schedule.minute_of_hour_out_of_range` | `minuteOfHour` outside `[0, 59]`. | Pick 0..59 (default 0). |
| <a id="time_format_invalid"></a> `schedule.time_format_invalid` | `time` not `HH:MM` 24h. | Use the exact form `09:00` / `21:30`. |
| <a id="days_of_week_invalid"></a> `schedule.days_of_week_invalid` | `daysOfWeek` empty, duplicate, or out of `[0, 6]`. | 0=Sun..6=Sat, distinct entries only. |
| <a id="days_of_month_invalid"></a> `schedule.days_of_month_invalid` | `daysOfMonth` empty, duplicate, or out of `[1, 31]`. | 1..31, distinct entries only — use `onMissingDay` to control 29-31 behavior. |
| <a id="on_missing_day_unknown"></a> `schedule.on_missing_day_unknown` | `onMissingDay` not `skip` / `lastDayOfMonth`. | Pick one (default `lastDayOfMonth`). |
| <a id="on_missing_day_unused"></a> `schedule.on_missing_day_unused` (warning) | `onMissingDay` set but `daysOfMonth` has no entry in `[29, 30, 31]`. | Advisory — row is created. Either drop `onMissingDay` (no effect on a 1..28 set) or extend `daysOfMonth` to include 29/30/31 if you meant a month-end rule. |
| <a id="timezone_unknown"></a> `schedule.timezone_unknown` | `timezone` is not a valid IANA zone. | Use a real zone (`Asia/Tokyo`, `America/New_York`, `UTC`). |
| <a id="recurrence_rule_invalid"></a> `schedule.recurrence_rule_invalid` | `recurrenceRule` is structurally invalid in a way the traversal could not localise. | Inspect the response `field` path and resubmit a well-formed object. |
| <a id="recurring_id_invalid"></a> `schedule.recurring_id_invalid` | id segment not a positive integer. | Use the `item.id` returned by POST. |
| <a id="recurring_not_found"></a> `schedule.recurring_not_found` | No row with this id. | List `/api/recurring-schedules` to see current rows. |
| <a id="recurring_no_changes"></a> `schedule.recurring_no_changes` | PATCH body is empty. | Supply at least one of `description` / `prompt` / `recurrenceRule` / `model` / `tier` / `taskContext` / `enabled`. |
