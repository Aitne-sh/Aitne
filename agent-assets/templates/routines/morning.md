---
type: rule
slug: morning
owner: shared
updated: 2026-04-17
template_version: 1
---
# Morning Routine — extension checks

The fixed 04:00 pipeline (handoff → sync → observations → inbox triage →
journal synthesis → today.md → schedule → log) is owned by the task-flow
`routine.morning_routine.md`. This file is the user-editable extension
surface: anything listed here is executed in Step 8 of the pipeline, after
the built-in steps complete, unless a check is already covered above.

DM-added entries are appended here by the agent. Built-in checks are not
re-enumerated — the task-flow owns those. Delete an entry or set an
obvious precondition to turn it off.

## Checks

### (example — remove or edit)
- **Precondition**: weekday only
- **Added**: 2026-04-17 by setup wizard (placeholder)
- **Action**: nothing — this block exists so the section is parse-safe.
  Remove or replace it with a real check.
