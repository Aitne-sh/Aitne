---
type: rule
slug: management
owner: shared
updated: 2026-05-03
template_version: 2
schema_version: 3
---
# Management Rules

This file is the agent's structured registry of (a) Source-of-Truth
bindings and (b) active managed tasks. It is rendered from the daemon's
DB and re-parsed when hand-edited; see
`docs/design/21-management-registry-and-entities.md` for the full spec.

## A. Source-of-Truth bindings

| Category | SoT app | Mirror MD path | Policy | Writer |
|---|---|---|---|---|

_No SoT bindings yet — populate via the setup wizard or
`PUT /api/sot-bindings`._

## B. Managed tasks (active only)

| ID | Intent | App | Cadence | Output path | Schedule | Last run | Last result |
|---|---|---|---|---|---|---|---|

_No managed tasks yet — register via DM (e.g. "Check Zoom daily at 10 AM")
or the dashboard's Settings → Management page._

## C. Active Policies

Auto-maintained by the daemon (do not edit). Source files live under
`policies/management-captures/<slug>.md`; capture new policies via the
`management-policy` skill. Full index: [[policies/management-captures/_index.md]]

_No active policies yet._

## Notes

- The agent cannot use `Edit` / `Write` tools on this file — writes go
  through `/api/context/policies/management` (locked + snapshotted) or the
  managed-tasks / sot-bindings API surfaces.
- This file is injected into every flow via `policy-files.ts`. Keep it
  concise so prompt assembly stays cheap.
- Free prose between sections (Language, Conflict handling, etc.) is
  preserved across re-renders. Tables and frontmatter stay English.
