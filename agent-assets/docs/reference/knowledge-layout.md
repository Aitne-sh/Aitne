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
  - knowledge
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
updated: 2026-06-08
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
  - /knowledge?tab=context-files
process_keys:
  - routine.morning_routine
  - routine.morning_routine_journal
  - routine.evening_review
  - routine.weekly_review
  - routine.monthly_review
  - routine.activity_scan
  - routine.roadmap_refresh
config_keys:
  - dayBoundaryHour
api_endpoints:
  - PUT /api/context/state/today
  - PATCH /api/context/state/today
  - PUT /api/context/plans/roadmap
  - PUT /api/context/policies/management
context_files:
  - state/today.md
  - plans/roadmap.md
  - identity/profile.md
  - policies/management.md
  - journal/agent.md
---

# Knowledge layout — what Aitne remembers, and where

This is the authoritative map of everything Aitne writes to disk as its
knowledge of you. Every file lives under `PA_DATA_DIR/context/`
(default `~/.personal-agent/context/`) as plain Markdown that you can read,
edit, version, and back up with ordinary tools.

The vault is partitioned into **six authority classes** — `identity/`, `state/`,
`plans/`, `journal/`, `knowledge/`, and `policies/`. Each top-level directory
carries a distinct authority + lifecycle contract; the daemon enforces those
contracts via the file's YAML frontmatter (advisory in this release; strict in
the next phase). This shape landed in the context-vault v2 restructure
(migration `0004-context-vault-restructure`); legacy pre-v2 paths such as <!-- drift-allow -->
`today.md`, `user/profile`, `rules/management`, `agent/journal`, etc. continue to work <!-- drift-allow -->
because the daemon normalizes them in-process — never via HTTP 3xx — for one
minor release while shipped skills and task-flows are updated.

The layout below is the canonical source-of-truth. It mirrors
`packages/daemon/src/core/context-paths.ts` (`CONTEXT_RELATIVE_PATHS`) and
the write-permission whitelist in `packages/daemon/src/api/routes/context/permissions.ts`.

---

## Tree at a glance

```
~/.personal-agent/context/
├── _index.md                       Root nav + machine-rebuilt reconciler block
│
├── identity/                       USER-authored — who you are
│   ├── _index.md
│   ├── profile.md                  Identity, preferences (always injected)
│   ├── people.md                   People dictionary
│   ├── work.md                     Workplace, team, stack
│   ├── expertise.md                Domains, tools, skills
│   ├── personal.md                 Hobbies, health, habits, location
│   └── goals.md                    Developmental goals
│
├── state/                          AGENT-authored — volatile working state
│   ├── today.md                    Today's working view (always injected)
│   ├── yesterday.md                today.md snapshot rotated each morning
│   ├── profile-questions.md        Onboarding interview queue
│   ├── activity/
│   │   └── <source>.md             Per-source 90-day Activity view (reconciler)
│   ├── inbox/
│   │   └── YYYY-MM-DD-<slug>.md    Paste bucket (triaged at morning)
│   └── scratch/
│       └── YYYY-MM-DD-<slug>.md    Ephemeral 48-hour TTL working area
│
├── plans/                          MIXED — user direction + agent progress
│   ├── _index.md
│   ├── roadmap.md                  Long-horizon goals and recurring plans
│   └── projects/
│       ├── _index.md
│       ├── _active.base            Obsidian Bases live view of active projects
│       └── <slug>.md               Project page with structured frontmatter
│
├── journal/                        APPEND-ONLY narrative
│   ├── _index.md
│   ├── daily/
│   │   └── YYYY-MM-DD.md           Stage B morning synthesis (user's diary)
│   ├── weekly/
│   │   └── YYYY-Www.md             ISO year-week, e.g. 2026-W19.md
│   ├── monthly/
│   │   └── YYYY-MM.md
│   ├── repos/
│   │   └── <slug>/
│   │       └── YYYY-MM-DD.md       Per-repo daily activity journal
│   └── agent.md                    Agent decision log (CREATE_ONLY_PUT,
│                                   append-only PATCH only)
│
├── knowledge/                      Persistent reference material
│   ├── _index.md
│   ├── wiki/                       Internal wiki workspaces (FTS5-indexed)
│   │   └── <workspace>/
│   │       ├── 00_inbox/
│   │       ├── 10_raw/
│   │       ├── 20_wiki/
│   │       ├── 30_outputs/
│   │       ├── 90_meta/
│   │       └── log/
│   ├── repos/
│   │   └── <slug>/
│   │       └── overview.md         Long-arc per-repository overview
│   ├── entities/                   Management-registry entities
│   │   └── <domain>/               work/travel/finance/personal/health/learning
│   │       ├── _index.md           Per-domain index (reconciler-written)
│   │       └── <type-plural>/      meetings, trips, receipts, projects, books, notes
│   │           └── <slug>.md
│   └── dossiers/                   Per-flow carry-forward state (agent-owned)
│       ├── _index.md
│       └── <flow>.md               One per routine (activity-scan/morning/evening/…)
│
└── policies/                       USER-authored config + rules
    ├── _index.md
    ├── management.md               SoT bindings + managed tasks (always injected)
    ├── mcp.md                      Per-server MCP usage rules
    ├── redaction.md                Mirror of built-in secret-redaction patterns
    ├── journal-format.md           Format spec for the synthesized daily journal
    ├── journal-export.md           Inclusion / exclusion rules for exporting journal/daily/
    ├── integrations.md             Integration-mode snapshot (daemon-rendered,
    │                               chokidar-watched at this new path)
    ├── agent-lessons.md            Feedback Learning Loop global lessons (lazy)
    ├── agents/                     User-authored Agent definitions (lazy)
    │   └── <slug>/
    │       ├── agent.md
    │       └── lessons.md          Per-agent Feedback Learning Loop lessons (lazy)
    ├── management-captures/        One captured policy per file
    │   ├── _index.md
    │   └── <slug>.md
    ├── routines/                   Per-cadence checklist rulebooks
    │   ├── _index.md
    │   ├── activity-scan.md         Extension checks for routine.activity_scan
    │   ├── morning.md               …for routine.morning_routine
    │   ├── evening.md               …for routine.evening_review
    │   ├── weekly.md                …for routine.weekly_review
    │   ├── monthly.md               …for routine.monthly_review
    │   └── custom/
    │       └── <slug>.md           Retired custom routines (inert; migrated to user Agents)
    └── skills/                     User-registered skills (lazy directory)
        └── <slug>/
            └── SKILL.md            Built-in skills stay in agent-assets/skills/ (read-only)
```

> **Files outside the vault.** A few daemon-managed files intentionally live at `<dataDir>/` and never enter the vault: `<dataDir>/prompts/` (dashboard-editable prompt templates), `<dataDir>/templates/` (project-note rendering templates), `<dataDir>/skill-curation-overlays/` (skill JSON overlay metadata), and `<dataDir>/agent-sessions/` (per-session scratch workdirs). The integration-mode snapshot previously lived at `<dataDir>/integrations.md`; the v2 restructure moved it into the vault at `policies/integrations.md`.

---

## Always-injected context

Every backend session (DM responses, routines, dashboard chat — everything
except the slim `routine.fetch_window` pre-pass) loads these three files
into the prompt by default:

| Path | Injected as | Notes |
|---|---|---|
| `identity/profile.md` | `<user>` | Identity anchor for every turn. |
| `policies/management.md` | `<management_rules>` | Skipped only by Stage B of the morning routine (`routine.morning_routine_journal`). Size-capped: if it exceeds `POLICY_FILE_MAX_BYTES` it is dropped with a warning rather than truncated. |
| `state/today.md` | `<today snapshot_at="...">` | `## Agent Log` is truncated to the last 10 entries for non-evening sessions. `routine.evening_review` gets the full log. |

Other files (`plans/roadmap.md`, `journal/agent.md`, project pages, dossiers, etc.)
are loaded on demand by the specific routines or skills that need them —
see the reconciler block inside `_index.md` for the per-flow mapping.

---

## Top-level files

### `_index.md`
Root navigation hub. The top portion is human-curated (edit freely); the lower
portion sits inside a reserved `<!-- reconciler-section -->` … `<!-- /reconciler-section -->`
block that the daemon rebuilds from the filesystem (daily at 03:45, on startup,
and on file-event debounce). It serves as both the human-readable map and the
agent-facing file catalog the prompt loader consults when deciding which
non-always-injected files a given flow should pull in. (Pre-v2 installs kept
the agent-facing catalog at a separate `context-index.md` file; the migration
runner merges that file into the reconciler block.)

### `state/today.md`
The current agent-day's working view. Daemon-managed structure:

```
# YYYY-MM-DD (day-of-week)   — line 1 is the canonical agent-day date
> Day type: …               — parsed by every event handler
## User Schedule    — events for the day (from calendar observers)
## User Tasks       — what you need to do today
## Agent Plan       — what the agent intends to do today
## Agent Notes      — observations the agent surfaced
## Agent Log        — append-only action log (truncated to last 10 on injection)
## Handoff          — what carries into tomorrow
```

Always injected. Writes go through `PUT /api/context/state/today` (locked) and
are validated against the structure above. The agent-day boundary is 04:00
local by default (`dayBoundaryHour`); before that, "today" still refers to
the previous calendar date.

### `state/yesterday.md`
The previous agent-day's `state/today.md`, rotated at 04:00 by the morning
routine. The new morning's first job is to read it, parse the `## Handoff`
section, and seed today's plan. Replaced by the next rotation — there is no
multi-day `yesterday-N.md` history; the synthesized `daily/YYYY-MM-DD.md`
is the durable record.

### `plans/roadmap.md`
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

## `identity/` — who you are

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
| `goals.md` | Developmental goals (distinct from `plans/roadmap.md` project milestones). |

**Growth pattern.** When a topic outgrows a single file (e.g. a multi-month
sleep log), it can be promoted to a subdirectory: the API allows arbitrary
`identity/<area>/<file>.md` writes (e.g. `identity/health/sleep-log.md`). The
default install does not seed any subdirectories.

---

## `policies/` — how the agent should behave

Natural-language policy files. Edits take effect at the next task-flow
assembly. All writes go through the context API; the agent cannot `Edit` /
`Write` these directly.

### `_index.md`
Per-file navigation for the policies directory.

### `management.md`
The structured registry of:

- **A. Source-of-Truth bindings** — for each category of state (tasks,
  notes, calendar, etc.), which app is authoritative and which mirror MD
  path the agent writes to.
- **B. Managed tasks** — active recurring agent jobs (e.g. "check Zoom
  daily at 10 AM"), rendered from the DB. Re-parsed if hand-edited.
- **C. Active policies** — bullet list of policy slugs auto-rendered from
  `policies/management-captures/`.

**Always injected.** Capped in size on injection (oversize is skipped with
a warning, not truncated). Writes go through
`PUT /api/context/policies/management` (locked + snapshotted) or the
`managed-tasks` / `sot-bindings` API surfaces.

### `mcp.md`
MCP usage rules. One global-policy block + one section per connected
server (per-server read/write posture, scope rules).

### `journal-format.md`
Format spec for `journal/daily/YYYY-MM-DD.md`. Read by the morning routine's
Stage B as a natural-language template — required frontmatter fields,
required body sections (`## Summary`, `## Schedule`, `## Tasks`,
`## Conversations`), voice rules ("first-person from the user's
perspective"), wikilink rendering, and redaction layering.

### `journal-export.md`
User-defined inclusion / exclusion rules layered on top of `redaction.md`
when daily journal entries are mirrored to an external vault. Supports
per-day opt-out via `no_journal_export: true` frontmatter on the
individual `journal/daily/<date>.md`.

### `redaction.md`
Informational mirror of the built-in secret patterns. Actual redaction
lives in `packages/shared/src/secret-redaction.ts` — this file exists so
you can see what is being redacted from anything the agent writes.

### `management-captures/_index.md`
Auto-maintained registry of active policies (Active table + Removed
table). Direct edits are overwritten by the reconciler; to add or modify
a policy, edit its `management-captures/<slug>.md` file or use the
`management-policy` skill.

### `management-captures/<slug>.md`
One captured policy per file (origin DM, reasoning, linked routine).
Policies are deactivated by setting `status: removed` in frontmatter —
the file is preserved so the captured history survives. The directory is
not exposed for arbitrary `DELETE` via the API.

### `integrations.md`
Daemon-rendered snapshot of integration delegation state — kept in
bidirectional sync with the `integrations_json` settings row and
chokidar-watched at this new path (`policies/integrations.md`, formerly
`<dataDir>/integrations.md` before the v2 restructure). Hand-edits are
parsed back on every save.

### `skills/<slug>/SKILL.md`
User-registered skills. Built-in skills remain in `agent-assets/skills/`
(read-only, ships with the npm package). The directory is created lazily
on first user-skill registration.

---

## `policies/routines/` — per-cadence rulebooks

User-editable extension surfaces. Each routine's task-flow owns the fixed
pipeline; the matching file here lists user-added checks executed after
the built-in steps.

| File | Cadence | Process key |
|---|---|---|
| `_index.md` | — | (navigation) |
| `activity-scan.md` | every 2 h default (during active window) | `routine.activity_scan` |
| `morning.md` | 04:00 daily | `routine.morning_routine` |
| `evening.md` | evening | `routine.evening_review` |
| `weekly.md` | Friday | `routine.weekly_review` |
| `monthly.md` | month-end | `routine.monthly_review` |
| `custom/<slug>.md` | — (retired) | `routine.custom.<slug>` (historical) |

`custom/<slug>.md` files no longer fire — at the first start after the
upgrade each valid one was converted once into a user Agent at
`policies/agents/<slug>/agent.md`, and the source was marked inert
(`enabled: false` + `migrated_to_agent:`; see
[Custom Routines (Retired)](../features/routines/custom-routines.md)).
The path still supports `DELETE` so the inert files can be cleaned up.

---

## `plans/projects/` — one file per active project

| File | Holds |
|---|---|
| `_index.md` | Index of active projects. |
| `_active.base` | Obsidian Bases live view: filtered to `state ≠ archived`, sorted by last update. Query: `file.inFolder("plans/projects")`. |
| `<slug>.md` | Per-project page. Frontmatter: `type: project`, `slug`, `state` (`active` / `incubating` / `on-hold` / `archived`), `owner`, `start`, optional `due`, `stakeholders`, `next_milestone`, `tags`, `agent_last_synced_at`. |

---

## `knowledge/repos/` and `journal/repos/` — unified per-repository pages

For repositories paired between a local clone and a GitHub remote.

| File | Holds |
|---|---|
| `knowledge/repos/<slug>/overview.md` | Long-arc project overview (lifecycle phases, notable changes). Written by `git.project.init` and refreshed when something durable changes during a daily scan. |
| `journal/repos/<slug>/YYYY-MM-DD.md` | Per-day activity log, written by `git.project.update` on days that had activity. 365-day retention; older entries pruned by `retention.ts`. |

Arbitrary writes under `knowledge/repos/` and `journal/repos/` are not permitted — only these two patterns
are whitelisted to keep the layout disciplined.

---

## `knowledge/dossiers/` — per-flow carry-forward state

Agent-owned. Each dossier captures enough context for one specific
routine to run without re-scanning the full vault.

| File | Process key |
|---|---|
| `_index.md` | (navigation) |
| `activity-scan.md` | `routine.activity_scan` |
| `morning.md` | `routine.morning_routine`, `routine.morning_routine_today` |
| `evening.md` | `routine.evening_review` |
| `weekly.md` | `routine.weekly_review` |
| `monthly.md` | `routine.monthly_review` |
| `roadmap.md` | `routine.roadmap_refresh` (this is the dossier `knowledge/dossiers/roadmap.md`, not the plan at `plans/roadmap.md`) |

Each dossier carries a fixed shape: `## Standing checklist`, `## Focus
this period`, `## Open items`, `## Last run`. Pulled into prompts on
demand via the file catalog in the `_index.md` reconciler block (the
pre-v2 `context-index.md` catalog was merged there by the migration).

---

## `journal/daily/YYYY-MM-DD.md` — synthesized daily journal

Written by Stage B of the 04:00 morning routine. It is **the user's
diary** — first-person, from the user's perspective ("I shipped X", "I
met with Y") — not an agent activity log. Agent-side bookkeeping lives
in `journal/agent.md` instead.

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

## `journal/weekly/YYYY-Www.md` — weekly review

Written by `routine.weekly_review` (Fridays by default). ISO year-week
format, e.g. `2026-W19.md`.

**Retention: 365 days** (`retention.ts:weeklyMd`). The long-arc rollup
survives in `journal/agent.md`'s monthly sections.

---

## `journal/monthly/YYYY-MM.md` — monthly review

Written by `routine.monthly_review` (month-end). YYYY-MM format.

**Retention: persistent.** Not enrolled in `retention.ts` pruning.

---

## `state/inbox/` — paste bucket

Dump anything here — text snippets, captured links, pasted email,
brainstorming notes. The morning routine triages each file and moves
the original to `state/scratch/inbox-YYYY-MM-DD-<slug>.md`. The
synthesized content lands wherever it belongs (a project file, today.md
tasks, your journal). Supports `DELETE` for post-triage cleanup.

No fixed format — write whatever you want.

---

## `state/scratch/` and `journal/agent.md` — agent's private workspace

### `journal/agent.md`
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

### `state/scratch/`
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
- Holds a per-file lock (notably the `state/today.md` write lock)
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
| `state/today` · `state/yesterday` · `plans/roadmap` · `_index` | `PUT`, `PATCH` |
| `state/profile-questions` · `state/activity/*` | `PUT`, `PATCH` |
| `identity/_index` · `identity/*` | `PUT`, `PATCH` |
| `policies/_index` · `policies/*` (top-level files) | `PUT`, `PATCH` |
| `policies/agent-lessons` | `PUT`, `PATCH` (Feedback Learning Loop global lessons store) |
| `policies/agents/{slug}/{file}` | `PUT`, `PATCH`, `DELETE` (user-authored Agent definitions) |
| `policies/routines/_index` · `policies/routines/*` | `PUT`, `PATCH` |
| `policies/routines/custom/*` | `PUT`, `PATCH`, `DELETE` (legacy — files are inert and no longer fire) |
| `plans/projects/_index` · `plans/projects/*` | `PUT`, `PATCH` |
| `plans/projects/_active` | `PUT` (the Obsidian Bases view) |
| `knowledge/repos/{slug}/overview` · `journal/repos/{slug}/{date}` | `PUT`, `PATCH` |
| `knowledge/repos/legacy-registry/*` | `PUT`, `PATCH` (cleanup of dangling entries only) |
| `knowledge/entities/{domain}/_index` · `knowledge/entities/{domain}/{typePlural}/{slug}` | `PUT`, `PATCH` |
| `journal/daily/*` · `journal/weekly/*` · `journal/monthly/*` | `PUT`, `PATCH` |
| `knowledge/dossiers/_index` · `knowledge/dossiers/*` | `PUT`, `PATCH` |
| `state/inbox/*` · `state/scratch/*` | `PUT`, `PATCH`, `DELETE` |
| `journal/agent` | `PUT` once (create-only), then `PATCH` (append) |
| `policies/management-captures/_index` · `policies/management-captures/*` | `PUT`, `PATCH` |
| `research/*` | `PUT`, `PATCH` (browser-history research-cluster journals) |

> Legacy URL forms (`/api/context/today.md`, `/api/context/user/profile`, `/api/context/rules/management`, `/api/context/agent/journal`, etc.) are normalized to the class-prefixed canonical paths in-process by `core/context-vault-aliases.ts` before any of the above checks run. Normalization is not a redirect (no HTTP 3xx) so legacy `curl -X PUT/PATCH` callers keep working. The alias bridge lives for one minor release after PR-6's content sweep lands. <!-- drift-allow -->

---

## Retention summary

From `packages/daemon/src/core/retention.ts`:

| File / pattern | Retention | Mechanism |
|---|---|---|
| `state/today.md` | rotates every agent-day at 04:00 | morning routine writes the new file; previous becomes `state/yesterday.md` |
| `state/yesterday.md` | one agent-day | overwritten by next rotation |
| `journal/daily/YYYY-MM-DD.md` | **persistent by design** | safety-net value `dailyMd: 36500` (~100 years); not enrolled in prune |
| `journal/weekly/YYYY-Www.md` | 365 days | `retention.ts:weeklyMd` |
| `journal/monthly/YYYY-MM.md` | **persistent** | no prune entry |
| `journal/repos/<slug>/<date>.md` | 365 days | `retention.ts:gitJournalMd` |
| `journal/agent.md` weekly sections | last 12 | content-level rollup in `retention.ts` |
| `journal/agent.md` monthly sections | last 24 | content-level rollup in `retention.ts` |
| `state/scratch/*` | 48 hours | TTL sweep |
| `state/inbox/*` | until next morning routine | triage moves to `state/scratch/` |
| `md_file_snapshots` (DB) | 30 days | row-level prune |

---

## How to inspect / back up your knowledge

Everything here is plain text. The usual tooling works:

```bash
# Read your profile
cat ~/.personal-agent/context/identity/profile.md

# Edit any file
$EDITOR ~/.personal-agent/context/state/today.md

# Version it
cd ~/.personal-agent/context && git init && git add . && git commit -m "snapshot"

# Back it up
cp -r ~/.personal-agent/context ~/aitne-backup-$(date +%F)

# Search across everything
grep -rni "topic" ~/.personal-agent/context/
```

Edits take effect at the next routine. There is no proprietary index
and no migration step on uninstall — the directory is yours.
