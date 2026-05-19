---
kind: reference
name: snapshot-files
description: Weekly / monthly review snapshots, rules / routines files — who writes, when, with what cadence and frontmatter.
---

# Snapshot files — weekly / monthly / rules / routines

These files live in the primary management vault under
`weekly/`, `monthly/`, `rules/`, and `routines/`. They are not part
of the day-to-day context churn (`today.md`, `roadmap.md`,
`projects/*.md`); they accumulate slowly and are written by routines
or by explicit user request.

## weekly/*.md, monthly/*.md

| File | Path | Cadence | Writer | Verb |
|---|---|---|---|---|
| Weekly review | `weekly/YYYY-Www.md` | Friday Weekly Review only | `routine.weekly_review` | `PUT` (full body) |
| Monthly review | `monthly/YYYY-MM.md` | Month-end Monthly Review only | `routine.monthly_review` | `PUT` (full body) |

Notes:

- Monthly files are **user-facing only** — agent-side metrics (cost,
  retry counts, self-critique) go to `agent/journal.md`, not here.
- Weekly file name uses ISO week (`YYYY-Www` — `2026-W19`, not
  `2026-W5`); pad the week to two digits.
- Never write `weekly/*.md` or `monthly/*.md` on any other day. The
  Morning Routine, Hourly Check, Evening Review, and DM handlers do
  not produce these files; if you are not the matching review
  routine, do not PUT this path.
- `PATCH` is technically accepted but unusual. The normal write is a
  single full-body `PUT` at the end of the review session.
- **Weekly leverage contract.** `weekly/YYYY-Www.md` carries three
  load-bearing H2 sections — `## Carry Over to Next Week`,
  `## Next Week Focus`, `## Lessons for Next Week` — that the
  morning_routine lifts mechanically via the `<previous_week>` context
  block every morning of the next ISO week. Headings must match
  verbatim (digest extractor is header-regex bound); caps are 5 / 3 /
  3 bullets respectively; empty sections render as `(none recorded)`
  downstream. Full design: `docs/design/appendices/weekly-next-week-leverage.md`.

## agent/journal.md

| Field | Value |
|---|---|
| Owner | agent |
| User-facing | No — never read in DMs / briefings / notifications |
| Write verb | `PATCH mode: "append_to_file"` (no `section` needed) |

Weekly sections: `## Weekly YYYY-Www` (What worked / slipped /
improvements / Metrics). Monthly: `## Monthly YYYY-MM` (follow-up /
self-critique / gap / adjustments / Metrics). The Evening Review,
Weekly Review, and Monthly Review each append their own block.

**Nothing from this file should appear in notifications.** The journal
is the agent's private metrics surface, not user-readable content.

## rules/*.md, routines/*.md

User-controlled policy and routine files. Only modify when the user
explicitly asks to change the policy or routine itself.

### `rules/*.md`

- Preserve unrelated sections verbatim. PATCH the one section the
  user is changing; do not full-body PUT.
- `rules/management.md` is the durable management policy file —
  modify only when the user explicitly asks.

### `rules/policies/<slug>.md` and `rules/policies/_index.md`

Route to the `management-policy` skill. It owns the read-before-write,
similarity-detection, and pause/resume fan-out for durable policies.
**Do not hand-edit from this skill.** A direct PATCH here bypasses the
similarity check and the dossier / routine fan-out.

### `routines/<cadence>.md` (built-in cadences)

- Cadences: `morning`, `evening`, `weekly`, `monthly`, `hourly`.
- Keep the existing frontmatter. Keep a `## Checks` section.
- Append or edit `### <label>` blocks under `## Checks`; each block
  is one user-authored rule the cadence runs.

### `routines/custom/<slug>.md`

Full-file `PUT` is usually safest. Required frontmatter:

```yaml
type: rule
slug: <kebab-name>
cron: '<cron expression>'
process_key: <ProcessKey from packages/shared/src/process-key.ts>
enabled: true
backend_tier: lite | medium | high
max_budget_usd: <number>
```

The file body must also contain a `## Checks` section.

Deleting a custom routine uses `DELETE /api/context/routines/custom/<slug>`
**only** after the user asks to retire it. The daemon snapshots the
prior content for restore.
