---
name: task
description: Unified write facade for tracked work — create/edit/delete any task through one path. POST /api/tasks {kind: reminder|dm|agent|app_fetch|background}; PATCH/DELETE /api/tasks/<ref>. Forwards to the hardened owners (dedup, cascade, dm_session split intact).
allowed-tools:
  - Bash(curl *)
---

# Task — one path to create, edit, or delete any tracked work

Instead of choosing among six creation skills, route every write through
`/api/tasks`. The facade **forwards** your request to the existing hardened
owner endpoint by `kind` (create) or ref prefix (edit/delete) — it never
re-implements them, so each owner's dedup, FK cascade, validation, the
`dm_session` recurring split, and auth tier all still apply unchanged.

Pair it with the **`board`** skill (read inventory + blast-radius).

## Create — `POST /api/tasks`

Send `{ "kind": "...", ...ownerFields }`. The facade strips `kind` and forwards
the rest to the owner, so **provide the owner's own fields** (it does not rename
them). Pick the kind:

| `kind` | Routes to | Provide | Detailed authoring skill |
|---|---|---|---|
| `reminder` | `POST /api/schedule/dm` | `time` (ISO8601), `message` | `schedule` |
| `dm` | `POST /api/recurring-schedules` | `description` (≥20), `recurrenceRule`, `prompt?` (task_type is pinned to `dm_session`) | `schedule` |
| `agent` | `POST /api/agents` | `slug`, `name`, `schedule` (`{kind:"recurring",recurrence}` or `{kind:"cron",expression}`), `prompt?` | `agent-create` |
| `app_fetch` | `POST /api/managed-tasks` | `intent`, `app`, `cadence`, `recurrenceRule`, `output_path?` (send an `Idempotency-Key` header) | `managed-tasks` |
| `background` | `POST /api/background-task` | `brief`, `title?`, `notificationPolicy?` | `background-task` |

```bash
curl --silent --fail -X POST -H 'Content-Type: application/json' \
  -d '{"kind":"reminder","time":"2026-07-01T15:00:00+09:00","message":"call the dentist"}' \
  http://localhost:8321/api/tasks
```

For anything beyond the simple case — authoring a full recurring Agent, an
app-fetch where dedup / output-path shape matter, a self-contained background
brief — open the **detailed skill** in the last column for its field rules, then
either POST through that skill directly or mirror its body here. The facade is
the front door; the specialised skills are the manual.

## Edit / delete — `PATCH` / `DELETE /api/tasks/<ref>`

Address the row by its typed `ref` from the board (`rs:<id>`, `mt_<n>`,
`agent:<slug>`, `as:<id>`, `trigger:<id>`). PATCH forwards your patch body to
the owning edit endpoint; DELETE forwards to the owning delete (cascade
preserved). A `trigger:` write routes to `/api/triggers/<id>` (Approve tier;
`401` = needs the dashboard's authorization; no facade create kind) and its
delete removes the paired recurring schedule too.

```bash
curl --silent --fail -X PATCH -H 'Content-Type: application/json' \
  -d '{"enabled":false}' http://localhost:8321/api/tasks/rs:42

curl --silent --fail -X DELETE http://localhost:8321/api/tasks/mt_3
```

## Response envelope

Every dispatch returns the owner's HTTP status with
`{ ok, dispatchedTo, kind, result }` — `result` is the owner's own body
(e.g. `{ status:"created", item }`). Read `result` for ids and warnings.

## Hard rules

1. **Localhost only.** `http://localhost:8321/api/tasks*`.
2. **A `dm` create is always a `dm_session` row.** You cannot create recurring
   autonomous *work* through `kind:"dm"` — that is `kind:"agent"`. The facade
   enforces this (it never opens the 410'd recurring agent-task door, and never
   stamps an agent id onto a schedule).
3. **Editing/deleting an Agent is privileged.** `agent:<slug>` routes to
   `/api/agents`, which may require the dashboard's authorization — a `401` means
   it needs human approval, exactly as editing the Agent directly does. Built-in
   Agents are undeletable (`409`); stopping one needs the stop-warning ack.
4. **Fulfillers are read-only here.** `bt:` / `bx:` / `cluster:` refs return
   `422` — manage them on their own surfaces; never resume a force-failed browser
   task or surface a pending `!~` confirm token.
5. **Preview destructive changes first.** For a delete/modify the user may not
   fully grasp, run `GET /api/tasks/impact?ref=<ref>` (the `board` skill) and
   confirm the blast radius before acting.
