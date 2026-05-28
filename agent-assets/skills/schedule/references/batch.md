---
kind: reference
name: batch
description: POST /api/schedule/batch — bulk register up to 50 rich-context schedules in one atomic transaction. Morning-routine Stage A is the primary caller.
---

# POST /api/schedule/batch — Bulk register rich-context schedules

Used by the morning-routine Stage A to register every same-day
schedule in one atomic transaction. Each row's `taskContext` MUST
carry the context a future `scheduled.task` / `scheduled.dm` session
needs to produce high-quality output hours later — the daemon cannot
reconstruct this from the user-facing description.

If you are not the morning routine, you almost certainly want
`POST /api/schedule` (single-row) instead — batch's required
`taskContext.background` + `expected_output` fields are overkill for
one-off DM-handler reminders.

## Example

```bash
curl -s -X POST http://localhost:8321/api/schedule/batch \
  -H 'Content-Type: application/json' \
  -d '{
    "rows": [
      {
        "scheduledFor": "2026-05-15T14:30:00-04:00",
        "taskType": "wake",
        "taskDescription": "Pre-brief the 15:00 standup with the two open Q2 risks.",
        "taskContext": {
          "background": "User flagged Q2 roadmap risks in yesterdays DM; standup needs the two open items front-loaded so the team aligns before 15:30.",
          "expected_output": "DM with two bullet items + one suggested mitigation each, sent 30min before standup.",
          "references": ["plans/projects/q2-roadmap.md#open-risks", "calendar:event:standup-2026-05-15"],
          "tone": "concise"
        }
      }
    ],
    "atomic": true
  }'
```

## Fields

| Field | Required | Description |
|---|---|---|
| `rows` | Yes | Array of row objects (max 50 per batch). Empty array is a documented no-op. |
| `rows[].scheduledFor` | Yes | ISO 8601 with timezone offset. Must be >= 1 minute in the future. |
| `rows[].taskType` | Yes | `wake` / `dm_session` / `check` / `dm`. |
| `rows[].taskDescription` | Yes | Self-contained (min 20 chars). Doubles as the agent body unless `taskPrompt` overrides. |
| `rows[].taskContext.background` | Yes | Why this task is being scheduled (min 30 chars). Anchor for the future session. |
| `rows[].taskContext.expected_output` | Yes | What the future session should produce (min 20 chars). |
| `rows[].taskContext.references` | No | Stable handles the future session can look up (project paths, calendar event ids). |
| `rows[].taskContext.tone` | No | Free-form tone hint for DM-shaped output. |
| `rows[].taskContext.tier_override` | No | `lite` / `medium` / `high` / `null`. **Legacy slot — prefer `rows[].tier` (top-level)**. When `tier` is omitted, this value is lifted into the row's `tier_override` column at insert time. |
| `rows[].tier` | No | `lite` / `medium` / `high`. Abstract cost knob — primary path. Wins over `taskContext.tier_override` when both are set. Mutually exclusive with `rows[].model` on the same row. |
| `rows[].taskContext.sub_flow` | No | Branches the task-flow rendering when the dispatcher needs a specialised sub-flow. |
| `rows[].taskPrompt` | No | Override for the agent body (min 20 chars when set). |
| `rows[].correlationId` | No | Defaults to the morning routine's correlation id when omitted. |
| `rows[].model` | No | Registered model id (`claude-opus-4-8`, `claude-sonnet-4-6`, `gpt-5.4`, `gemini-3.1-pro-preview`, …), legacy alias (`sonnet` / `opus` — auto-rewritten to `tier`), composite `<backendId>/<modelId>`, or `null`. Mutually exclusive with `rows[].tier`. Omit both to let `process_backend_config` decide. |
| `atomic` | No | `true` (default) wraps inserts in one transaction — any row error rolls back all. `false` commits successful rows individually. |

## Success

201:

```json
{ "ok": true, "rowsAttempted": 1, "rowsCommitted": 1, "ids": [101], "warnings": [] }
```

`warnings[]` carries non-blocking advisories (per-row issues like
`schedule.model_deprecated` keep the rowIndex so the agent can map
warnings back to the offending row). Rows are still committed —
surface the warnings to the next turn so the LLM can refine without
re-POSTing.

## Errors

Returns the standard agent-consumable envelope — see
`references/errors.md`. `rowsCommitted` tells you how much of the
batch landed; with `atomic:true` any error means `rowsCommitted === 0`.
Per-row `model_unknown` / `model_ambiguous` / `tier_and_model_conflict`
all reach this envelope with `rowIndex` set — fix the offending rows
and resubmit the same body.

## When NOT to use batch

- One-off DM-handler reminders → use `POST /api/schedule` (single
  row, no required `taskContext.background`).
- DM-tone scheduled messages → use `POST /api/schedule/dm` (no agent
  invoked at fire time).
- More than 50 rows in a single horizon → chunk into multiple
  `atomic:true` batches; do not raise the cap.
