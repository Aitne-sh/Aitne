---
name: board
description: Read-only Task Board — list everything in motion (recurring DMs, Agents, app-fetch, automation triggers, reminders, background/browser work) via GET /api/tasks, and preview a delete's blast radius via GET /api/tasks/impact. For writes use the `task` skill.
allowed-tools:
  - Bash(curl *)
  - Read
---

# Task Board — see everything in motion

One place to answer two questions the user actually asks:

1. **"What do I have running / set up?"** — a single inventory across every
   creation path (recurring DMs, Agents, app-fetch managed tasks, automation
   triggers, pending one-off reminders, and in-flight background / browser
   work).
2. **"What breaks if I delete / change X?"** — the blast radius, with each
   affected row labelled by its real cascade.

The board is **read-only and computed on demand** — it stores nothing and
mirrors nothing. It does **not** replace the proactive reminder surface: pending
one-off reminders are already injected into your DM context every turn, so use
the board when the user *asks* to look, not as a standing checklist.

## When to use

- The user asks what's scheduled / running / set up ("show me my agents",
  "what's running", "do I still have that Zoom sweep?").
- Before a delete/modify, to tell the user the impact ("if I stop the digest,
  what goes with it?").
- To resolve a vague reference ("turn off the morning thing") to a concrete
  `ref` you can then act on with the `task` skill.

## Inventory — `GET /api/tasks`

```bash
curl --silent --fail http://localhost:8321/api/tasks
```

Returns `{ items, total, generatedAt }`. Each item:

| Field | Meaning |
|---|---|
| `ref` | typed handle — `rs:<id>` (recurring DM), `mt_<n>` (app-fetch), `agent:<slug>`, `trigger:<id>` (automation trigger), `as:<id>` (one-off reminder), `bt:<id>` (background), `bx:<id>` (browser) |
| `title` | human label — passed through verbatim from the owning row |
| `kind` | `dm` / `agent` / `app_fetch` / `trigger` / `reminder` / `background` / `browser` |
| `status` | `active` / `paused` / `pending` / `running` (incl. an Agent with a turn in flight) / a fulfiller state (`awaiting_user`, …) |
| `cadence` | human schedule label, or null for one-shot work |
| `fulfilledBy` | typed ref of the row that actually executes (for `app_fetch`, its `rs:` schedule) |
| `origin` | `system` / `user` / `agent` |
| `lastResult`, `lastRunAt`, `nextRunAt` | at-a-glance health, when the owner tracks them |

Summarise naturally; don't read the JSON back verbatim. The `kind` / `status`
/ `cadence` labels are a fixed English vocabulary; `title` is passed through
verbatim from the owning row.

## Blast radius — `GET /api/tasks/impact?ref=<ref>`

```bash
curl --silent --fail "http://localhost:8321/api/tasks/impact?ref=mt_3"
```

Returns `{ ref, found, summary, nodes }`. Each node is a row a delete/modify
would touch, with its real cascade semantics:

- `is_a_cascade` — a 1:1 wrapper deleted **with** the target (a managed task and
  its recurring schedule die together).
- `set_null_satellite` — an Agent or automation trigger that **references** the
  schedule and **survives** its deletion.
- `owner_paired_schedule` — an Agent's **own** recurring schedule (shown when the
  target is `agent:<slug>`): disabled with the Agent, removed only on hard-delete.
- `no_action_unlinked` — pending fires that are unlinked/skipped, not deleted.
- `self` — the target row itself.

`found:false` (still `200`) means the ref resolves to no live row. Lead with the
`summary`, then list what survives vs what's removed so the user can decide.

## Writes go through the `task` skill

This skill never creates, edits, or deletes. When the user wants to act on a
board item, hand the resolved `ref` (or a `kind` for a new item) to the **`task`**
skill, which routes the write to the hardened owner endpoint. Detailed authoring
(a full recurring Agent, an app-fetch with dedup) still belongs to the
specialised skills (`agent-create`, `managed-tasks`, `schedule`,
`background-task`) — `task` is the single front door to them.

## Hard rules

1. **Localhost only.** `http://localhost:8321/api/tasks*`.
2. **Read-only.** This skill issues only GETs. Never mutate from here.
3. **Never read or relay a browser-task final-confirm token.** The board surfaces
   only safe fields (`status`/`ref`); a pending `!~xxxxxxxx` token is never shown.
