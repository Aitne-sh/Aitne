---
schema_version: 1
slug: reference/knowledge-layout
title: Knowledge Layout Reference
id: knowledge-layout
aliases:
  - knowledge layout
  - context layout
  - memory layout
  - vault layout
  - context tree
  - file map
category: reference
summary: |
  The authoritative map of every Markdown file Aitne writes under
  ~/.personal-agent/context/ — purpose, structure, owner, retention,
  and write permissions. Mirrors CONTEXT_RELATIVE_PATHS in
  context-paths.ts and the whitelist in
  api/routes/context/permissions.ts.
section: knowledge-layout
tags:
  - reference
  - core
  - memory
  - context
  - operations
status: stable
ask_examples:
  - Where does the agent store what it remembers?
  - What lives in ~/.personal-agent/context/?
  - What files are always injected into prompts?
  - How long does the agent keep its memory files?
  - Where does the daily journal live?
  - Which files can the agent write to?
locale: en-US
created: 2026-05-18
updated: 2026-05-21
keywords:
  - context
  - knowledge
  - memory
  - vault
  - retention
  - permissions
  - today.md
  - roadmap.md
  - profile.md
  - management.md
related:
  - concepts/memory-model
  - features/memory-files/today
  - features/memory-files/roadmap
  - features/memory-files/user-profile
  - features/memory-files/agent-journal
  - features/memory-files/schedule
  - features/memory-files/projects
ui_anchors:
  - /knowledge
context_files:
  - today.md
  - roadmap.md
  - user/profile.md
  - rules/management.md
  - agent/journal.md
---

# Knowledge layout — what Aitne remembers, and where

This is the authoritative map of everything Aitne writes to disk as its
knowledge of you. Every file lives under `PA_DATA_DIR/context/`
(default `~/.personal-agent/context/`) as plain Markdown that you can read,
edit, version, and back up with ordinary tools.

The layout below is the canonical source-of-truth. It mirrors
`packages/daemon/src/core/context-paths.ts` (`CONTEXT_RELATIVE_PATHS`) and
the write-permission whitelist in `packages/daemon/src/api/routes/context/permissions.ts`.

---

## Tree at a glance

```
~/.personal-agent/context/
├── _index.md                    Human-readable navigation hub
├── context-index.md             Agent-facing file catalog (prompt-injection hub)
├── today.md                     Today's working view (always injected)
├── yesterday.md                 Yesterday's today.md snapshot (rotated each morning)
├── roadmap.md                   Long-horizon goals and recurring plans
│
├── user/                        Who you are — slow-changing facts
│   ├── _index.md
│   ├── profile.md               Identity, preferences, comms style (always injected)
│   ├── people.md                People dictionary
│   ├── work.md                  Workplace, team, stack
│   ├── expertise.md             Domains, tools, skills
│   ├── personal.md              Hobbies, health, habits, location
│   └── goals.md                 Developmental goals
│
├── rules/                       How the agent should behave
│   ├── _index.md
│   ├── management.md            Source-of-Truth bindings + managed tasks (always injected)
│   ├── mcp.md                   MCP usage rules (per-server policies)
│   ├── journal-format.md        Format spec for the synthesized daily journal
│   ├── journal-export.md        Inclusion / exclusion rules when exporting daily/
│   ├── redaction.md             Mirror of built-in secret-redaction patterns
│   └── policies/
│       ├── _index.md            Auto-maintained policy registry
│       └── <slug>.md            One captured policy per file
│
├── routines/                    Per-cadence checklist rulebooks
│   ├── _index.md
│   ├── hourly.md                Extension checks for routine.hourly_check
│   ├── morning.md               Extension checks for routine.morning_routine
│   ├── evening.md               Extension checks for routine.evening_review
│   ├── weekly.md                Extension checks for routine.weekly_review
│   ├── monthly.md               Extension checks for routine.monthly_review
│   └── custom/
│       └── <slug>.md            User-defined cron routines
│
├── projects/                    One file per active project
│   ├── _index.md
│   ├── _active.base             Obsidian Bases live view of non-archived projects
│   └── <slug>.md                Project page with structured frontmatter
│
├── git/                         Unified per-repository pages
│   └── <slug>/
│       ├── overview.md          Long-arc project overview
│       └── journal/
│           └── YYYY-MM-DD.md    Per-day activity log
│
├── dossiers/                    Per-flow carry-forward state (agent-owned)
│   ├── _index.md
│   ├── hourly.md
│   ├── morning.md
│   ├── evening.md
│   ├── weekly.md
│   ├── monthly.md
│   └── roadmap.md
│
├── daily/                       Synthesized daily journal (the user's diary)
│   └── YYYY-MM-DD.md
│
├── weekly/                      Weekly review files
│   └── YYYY-Www.md              ISO year-week, e.g. 2026-W19.md
│
├── monthly/                     Monthly review files
│   └── YYYY-MM.md
│
├── inbox/                       Paste bucket (triaged on next morning routine)
│   └── <anything>.md
│
└── agent/                       Agent's private notes
    ├── journal.md               Append-only self-reflection log
    └── scratch/
        ├── <YYYY-MM-DD>-<slug>.md          Ephemeral, 48-hour TTL
        └── inbox-YYYY-MM-DD-<slug>.md      Inbox triage residue (48h TTL)
```

---

## Always-injected context

Every backend session (DM responses, routines, dashboard chat — everything
except the slim `routine.fetch_window` pre-pass) loads these three files
into the prompt by default:

| Path | Injected as | Notes |
|---|---|---|
| `user/profile.md` | `<user>` | Identity anchor for every turn. |
| `rules/management.md` | `<management_rules>` | Skipped only by Stage B of the morning routine (`routine.morning_routine_journal`). Size-capped: if it exceeds `POLICY_FILE_MAX_BYTES` it is dropped with a warning rather than truncated. |
| `today.md` | `<today snapshot_at="...">` | `## Agent Log` is truncated to the last 10 entries for non-evening sessions. `routine.evening_review` gets the full log. |

Other files (`roadmap.md`, `agent/journal.md`, project pages, dossiers, etc.)
are loaded on demand by the specific routines or skills that need them —
see `context-index.md` for the per-flow mapping.

---

## Top-level files

### `_index.md`
Human-readable navigation hub. Tells you (the human) where things live and
how the agent reads/writes the vault. Edit freely.

### `context-index.md`
Agent-facing file catalog. Used by the prompt loader to decide which
non-always-injected files a given flow should pull in. Maintained from the
filesystem; you generally do not need to edit it.

### `today.md`
The current agent-day's working view. Daemon-managed structure:

```
# Today
## User Schedule    — events for the day (from calendar observers)
## User Tasks       — what you need to do today
## Agent Plan       — what the agent intends to do today
## Agent Notes      — observations the agent surfaced
## Agent Log        — append-only action log (truncated to last 10 on injection)
## Handoff          — what carries into tomorrow
```

Always injected. Writes go through `PUT /api/context/today` (locked) and
are validated against the structure above. The agent-day boundary is 04:00
local by default (`dayBoundaryHour`); before that, "today" still refers to
the previous calendar date.

### `yesterday.md`
The previous agent-day's `today.md`, rotated at 04:00 by the morning
routine. The new morning's first job is to read it, parse the `## Handoff`
section, and seed today's plan. Replaced by the next rotation — there is no
multi-day `yesterday-N.md` history; the synthesized `daily/YYYY-MM-DD.md`
is the durable record.

### `roadmap.md`
Long-horizon commitments and recurring plans. Structure:

```
# Roadmap
> Last synced: YYYY-MM-DD
## Annual Goals
## Quarterly Focus
## Long-term Plans
## Agent Action Plan
## Recurring
```

Loaded for the morning, evening, weekly, monthly, and roadmap-refresh
routines. Not loaded for ordinary DM turns.

---

## `user/` — who you are

Slow-changing biographical facts. The `user-profile` and `user-interview`
skills write here through the context API.

| File | Holds |
|---|---|
| `_index.md` | Per-area navigation for the directory. |
| `profile.md` | Identity, timezone, communication style, notification preferences, platforms. **Always injected.** |
| `people.md` | Colleagues, family, frequent contacts. |
| `work.md` | Employer, role, team, tech stack. |
| `expertise.md` | Domains, tools, skills the user has. |
| `personal.md` | Hobbies, sleep pattern, diet, background, health, location. |
| `goals.md` | Developmental goals (distinct from `roadmap.md` project milestones). |

**Growth pattern.** When a topic outgrows a single file (e.g. a multi-month
sleep log), it can be promoted to a subdirectory: the API allows arbitrary
`user/<area>/<file>.md` writes (e.g. `user/health/sleep-log.md`). The
default install does not seed any subdirectories.

---

## `rules/` — how the agent should behave

Natural-language policy files. Edits take effect at the next task-flow
assembly. All writes go through the context API; the agent cannot `Edit` /
`Write` these directly.

### `_index.md`
Per-file navigation for the rules directory.

### `management.md`
The structured registry of:

- **A. Source-of-Truth bindings** — for each category of state (tasks,
  notes, calendar, etc.), which app is authoritative and which mirror MD
  path the agent writes to.
- **B. Managed tasks** — active recurring agent jobs (e.g. "check Zoom
  daily at 10 AM"), rendered from the DB. Re-parsed if hand-edited.
- **C. Active policies** — bullet list of policy slugs auto-rendered from
  `rules/policies/`.

**Always injected.** Capped in size on injection (oversize is skipped with
a warning, not truncated). Writes go through
`PUT /api/context/rules/management` (locked + snapshotted) or the
`managed-tasks` / `sot-bindings` API surfaces.

### `mcp.md`
MCP usage rules. One global-policy block + one section per connected
server (per-server read/write posture, scope rules).

### `journal-format.md`
Format spec for `daily/YYYY-MM-DD.md`. Read by the morning routine's
Stage B as a natural-language template — required frontmatter fields,
required body sections (`## Summary`, `## Schedule`, `## Tasks`,
`## Conversations`), voice rules ("first-person from the user's
perspective"), wikilink rendering, and redaction layering.

### `journal-export.md`
User-defined inclusion / exclusion rules layered on top of `redaction.md`
when daily journal entries are mirrored to an external vault. Supports
per-day opt-out via `no_journal_export: true` frontmatter on the
individual `daily/<date>.md`.

### `redaction.md`
Informational mirror of the built-in secret patterns. Actual redaction
lives in `packages/shared/src/secret-redaction.ts` — this file exists so
you can see what is being redacted from anything the agent writes.

### `policies/_index.md`
Auto-maintained registry of active policies (Active table + Removed
table). Direct edits are overwritten by the reconciler; to add or modify
a policy, edit its `rules/policies/<slug>.md` file or use the
`management-policy` skill.

### `policies/<slug>.md`
One captured policy per file (origin DM, reasoning, linked routine).
Policies are deactivated by setting `status: removed` in frontmatter —
the file is preserved so the captured history survives. The directory is
not exposed for arbitrary `DELETE` via the API.

---

## `routines/` — per-cadence rulebooks

User-editable extension surfaces. Each routine's task-flow owns the fixed
pipeline; the matching file here lists user-added checks executed after
the built-in steps.

| File | Cadence | Process key |
|---|---|---|
| `_index.md` | — | (navigation) |
| `hourly.md` | every hour (during active window) | `routine.hourly_check` |
| `morning.md` | 04:00 daily | `routine.morning_routine` |
| `evening.md` | evening | `routine.evening_review` |
| `weekly.md` | Friday | `routine.weekly_review` |
| `monthly.md` | month-end | `routine.monthly_review` |
| `custom/<slug>.md` | user cron | `routine.custom.<slug>` |

`custom/<slug>.md` is the only routine path that supports `DELETE` —
when removed, the scheduler unregisters the cron job on the next reload.

---

## `projects/` — one file per active project

| File | Holds |
|---|---|
| `_index.md` | Index of active projects. |
| `_active.base` | Obsidian Bases live view: filtered to `state ≠ archived`, sorted by last update. |
| `<slug>.md` | Per-project page. Frontmatter: `type: project`, `slug`, `state` (`active` / `incubating` / `on-hold` / `archived`), `owner`, `start`, optional `due`, `stakeholders`, `next_milestone`, `tags`, `agent_last_synced_at`. |

---

## `git/` — unified per-repository pages

For repositories paired between a local clone and a GitHub remote.

| File | Holds |
|---|---|
| `<slug>/overview.md` | Long-arc project overview (lifecycle phases, notable changes). Written by `git.project.init` and refreshed when something durable changes during a daily scan. |
| `<slug>/journal/YYYY-MM-DD.md` | Per-day activity log, written by `git.project.update` on days that had activity. 365-day retention; older entries pruned by `retention.ts`. |

Arbitrary writes under `git/` are not permitted — only these two patterns
are whitelisted to keep the layout disciplined.

---

## `dossiers/` — per-flow carry-forward state

Agent-owned. Each dossier captures enough context for one specific
routine to run without re-scanning the full vault.

| File | Process key |
|---|---|
| `_index.md` | (navigation) |
| `hourly.md` | `routine.hourly_check` |
| `morning.md` | `routine.morning_routine`, `routine.morning_routine_today` |
| `evening.md` | `routine.evening_review` |
| `weekly.md` | `routine.weekly_review` |
| `monthly.md` | `routine.monthly_review` |
| `roadmap.md` | `routine.roadmap_refresh` |

Each dossier carries a fixed shape: `## Standing checklist`, `## Focus
this period`, `## Open items`, `## Last run`. Injected into prompts via
`context-index.md`.

---

## `daily/YYYY-MM-DD.md` — synthesized daily journal

Written by Stage B of the 04:00 morning routine. It is **the user's
diary** — first-person, from the user's perspective ("I shipped X", "I
met with Y") — not an agent activity log. Agent-side bookkeeping lives
in `agent/journal.md` instead.

Required frontmatter (daemon-owned, validated on write):
`date`, `weekday`, `type: daily`, `owner: agent`, `agent_generated: true`,
`calendar_events`, `messages_handled`, `updated`. Stage B adds
`agent_last_synced_at`, `content_hash`, `projects`, `people`, `tags`.

Body sections (Stage B-authored): `## Summary` (3–5 sentences),
`## Schedule`, `## Tasks`, `## Conversations`.

**Retention: persistent by design.** The cleanup config carries a 100-year
safety value (`dailyMd: 36500`) but the daily folder is not enrolled in
the prune loop.

**Conflict handling.** If you edited a previous day's entry, the next
write appends `## Agent revision — <ISO timestamp>` rather than overwriting
your edit.

---

## `weekly/YYYY-Www.md` — weekly review

Written by `routine.weekly_review` (Fridays by default). ISO year-week
format, e.g. `2026-W19.md`.

**Retention: 365 days** (`retention.ts:weeklyMd`). The long-arc rollup
survives in `agent/journal.md`'s monthly sections.

---

## `monthly/YYYY-MM.md` — monthly review

Written by `routine.monthly_review` (month-end). YYYY-MM format.

**Retention: persistent.** Not enrolled in `retention.ts` pruning.

---

## `inbox/` — paste bucket

Dump anything here — text snippets, captured links, pasted email,
brainstorming notes. The morning routine triages each file and moves
the original to `agent/scratch/inbox-YYYY-MM-DD-<slug>.md`. The
synthesized content lands wherever it belongs (a project file, today.md
tasks, your journal). Supports `DELETE` for post-triage cleanup.

No fixed format — write whatever you want.

---

## `agent/` — agent's private notes

### `agent/journal.md`
Append-only self-reflection log. Created with one `PUT` at first
boot; subsequent writes must be `PATCH` (append) — the API enforces
this with `CREATE_ONLY_PUT`. Used internally for the agent's own
notes about anomalies, MCP-call patterns, and the like.

Append-only is enforced; long-arc content is bounded by a rollup pass:

| Section | Kept | Why |
|---|---|---|
| `## Weekly YYYY-Www` | last 12 | superseded by the monthly rollup that covers them |
| `## Monthly YYYY-MM` | last 24 | 2 years of retrospectives, ~96 KB worst-case |

Duplicate sections (same week or month appended twice) are collapsed
last-write-wins. A single section over ~4000 bytes triggers a warning
log (never truncated mid-sentence). The file itself is never deleted
even when nothing qualifies for pruning.

This file is never auto-pushed as a notification.

### `agent/scratch/`
Ephemeral working files with a **48-hour TTL** (`B-007 §5.3`).

| File pattern | Origin |
|---|---|
| `<YYYY-MM-DD>-<slug>.md` | Skill working notes; helper `agentScratchPath(dateStr, slug)`. |
| `inbox-YYYY-MM-DD-<slug>.md` | Triage residue from the inbox post-morning-routine move. |

Both patterns support `PUT` / `PATCH` / `DELETE`.

---

## Write chokepoint

The agent cannot use the SDK's `Edit` / `Write` tools on any path inside
`context/`. Every write goes through `PUT /api/context/<path>` or
`PATCH /api/context/<path>`, which:

- Validates the path against the whitelist in `permissions.ts`
- Holds a per-file lock (notably the `today.md` write lock)
- Validates frontmatter against the file's schema where one exists
- Records a snapshot in the `md_file_snapshots` table (30-day retention)
- Notifies the prompt context cache so active DM sessions can refresh

Bash `curl` to `127.0.0.1:8321` is allowed; arbitrary file writes are
blocked at the SDK permission layer and the always-disallowed-tools
hook layer.

---

## File-permissions reference

This table is the contract enforced by
`CONTEXT_WRITE_PERMISSIONS` in
`packages/daemon/src/api/routes/context/permissions.ts`. Anything not
listed is read-only via the API.

| Pattern | Methods |
|---|---|
| `today` · `yesterday` · `roadmap` · `_index` · `context-index` | `PUT`, `PATCH` |
| `user/*` | `PUT`, `PATCH` |
| `rules/_index` · `rules/*` | `PUT`, `PATCH` |
| `routines/_index` · `routines/*` | `PUT`, `PATCH` |
| `routines/custom/*` | `PUT`, `PATCH`, `DELETE` |
| `projects/_index` · `projects/*` | `PUT`, `PATCH` |
| `projects/_active` | `PUT` (the Obsidian Bases view) |
| `git/{slug}/overview` · `git/{slug}/journal/{date}` | `PUT`, `PATCH` |
| `daily/*` · `weekly/*` · `monthly/*` | `PUT`, `PATCH` |
| `dossiers/_index` · `dossiers/*` | `PUT`, `PATCH` |
| `inbox/*` · `agent/scratch/*` | `PUT`, `PATCH`, `DELETE` |
| `agent/journal` | `PUT` once (create-only), then `PATCH` (append) |

---

## Retention summary

From `packages/daemon/src/core/retention.ts`:

| File / pattern | Retention | Mechanism |
|---|---|---|
| `today.md` | rotates every agent-day at 04:00 | morning routine writes the new file; previous becomes `yesterday.md` |
| `yesterday.md` | one agent-day | overwritten by next rotation |
| `daily/YYYY-MM-DD.md` | **persistent by design** | safety-net value `dailyMd: 36500` (~100 years); not enrolled in prune |
| `weekly/YYYY-Www.md` | 365 days | `retention.ts:weeklyMd` |
| `monthly/YYYY-MM.md` | **persistent** | no prune entry |
| `git/<slug>/journal/<date>.md` | 365 days | `retention.ts:gitJournalMd` |
| `agent/journal.md` weekly sections | last 12 | content-level rollup in `retention.ts` |
| `agent/journal.md` monthly sections | last 24 | content-level rollup in `retention.ts` |
| `agent/scratch/*` | 48 hours | TTL sweep |
| `inbox/*` | until next morning routine | triage moves to `agent/scratch/` |
| `md_file_snapshots` (DB) | 30 days | row-level prune |

---

## How to inspect / back up your knowledge

Everything here is plain text. The usual tooling works:

```bash
# Read your profile
cat ~/.personal-agent/context/user/profile.md

# Edit any file
$EDITOR ~/.personal-agent/context/today.md

# Version it
cd ~/.personal-agent/context && git init && git add . && git commit -m "snapshot"

# Back it up
cp -r ~/.personal-agent/context ~/aitne-backup-$(date +%F)

# Search across everything
grep -rni "topic" ~/.personal-agent/context/
```

Edits take effect at the next routine. There is no proprietary index
and no migration step on uninstall — the directory is yours.
