# Dashboard Automation IA Redesign — merge Schedule into Tasks

Date: 2026-07-01
Status: implemented (dashboard-only; no daemon changes)
Scope: `/tasks`, `/schedule`, `/agents` pages + sidebar Automation section

## 1. Problem audit

The Automation section shipped three sibling pages whose roles overlap. Audit
against the five review questions:

### F1 — Role overlap (user confusion)

One logical item is visible on up to three pages:

| Item | /agents | /tasks | /schedule |
|---|---|---|---|
| An Agent (e.g. morning routine) | identity card + health | `agent:` board row | its materialized runs in "Upcoming" |
| A recurring DM (morning briefing) | — | `dm` board row | "Scheduled DMs" CRUD **and** instances in "Upcoming" |
| A one-off reminder | — | `reminder` board row | "Upcoming" row |

"Tasks" vs "Schedule" as *names* don't communicate which page answers what.
The board's own detail drawer deep-links to `/schedule` — an admission that the
two pages are halves of one surface.

### F2 — Scatter + density

- "What runs next?" → /schedule. "What standing jobs exist?" → /tasks.
  "Is it healthy?" → /agents. Three visits for one mental model.
- /schedule "Upcoming" was backed by `GET /schedule/list` ordered
  `scheduled_for DESC` — newest-first **history mixed with future rows**, under
  a tab named "Upcoming", while the Next-Up hero counts down above it.
- Page descriptions leaked internal vocabulary (`wake`, `dm`, `custom`,
  `rs:` refs) into first-run copy.

### F3 — Intuition

- /tasks rows led with the typed ref (`rs:42`) — an internal handle — while
  burying cadence/next-run, which is what a person scans for.
- /schedule's type filter chips were raw enum tokens (`morning_routine`).
- The two pages rendered the same concept (a scheduled thing) with two
  different visual grammars (list rows vs table).

### F4 — Menu

Agents → Tasks → Schedule is one entry too many. Schedule is not a peer
concept; it is the *time axis* of the same inventory Tasks shows.

### F5 — Tasks page is under-informative

A flat read-only list. No "what's next", no "what's running", no failure
visibility, nothing that rewards the visit.

## 2. Decision

**Merge /schedule into /tasks.** Automation = **Agents / Tasks / Browser**.

- **Agents** stays the identity + configuration surface (recently redesigned;
  unchanged except the header link).
- **Tasks** becomes the single operations hub: *what exists, what's next,
  what happened, what needs attention*.
- **/schedule** becomes a server redirect → `/tasks?tab=queue` (deep links,
  docs, and muscle memory keep working).

Alternatives considered:

- *Keep three pages, sharpen copy* — rejected: copy can't fix the same row
  appearing in three places under two indistinguishable names.
- *Merge Tasks into Schedule (keep the name Schedule)* — rejected: the merged
  page holds standing commitments (some without a cadence: background/browser
  work), and "Tasks" covers both; "Schedule" implies only the time axis. The
  Unified Task Board design (docs/design/appendices/unified-task-board.md)
  also already names `/tasks` as the inventory surface.
- *Drop agent rows from the board to kill overlap* — rejected: the board's
  contract is "everything in motion" (single inventory); instead agent rows
  stay compact and deep-link to /agents for management.

Menu order stays **Agents first**: identity (who) → operations (what/when) →
surface (where it acts). Tasks is expected to take the most daily clicks, but
Agents is the anchor concept of the section and the creation entry point.

## 3. The new /tasks page

```
┌ Tasks                                    [Refresh Today] [+ Schedule] ┐
│ What your agent is set up to do — and when it runs next.              │
│                                                                       │
│ ┌──────────────────────────┬─────────┬───────────┬──────────────────┐ │
│ │ NEXT UP                  │ RUNNING │ RECURRING │ NEEDS ATTENTION  │ │
│ │ 23m 14s                  │ 2       │ 14        │ 1 failed (24h) → │ │
│ │ Morning briefing · 7:00  │ in flight│ active   │                  │ │
│ └──────────────────────────┴─────────┴───────────┴──────────────────┘ │
│                                                                       │
│ [ Board ] [ Queue ] [ Scheduled DMs ]                                 │
│ ─────────────────────────────────────────────────────────────────────│
│ Board: kind-grouped standing inventory (read-only, detail drawer)     │
│ Queue: [Upcoming | History] materialized runs, humanized type chips   │
│ Scheduled DMs: recurring DM rules CRUD (moved verbatim from /schedule)│
└───────────────────────────────────────────────────────────────────────┘
```

### Status strip (signature element)

One `Card` — a console-style strip, not four floating stat cards — divided
into four cells:

- **Next up**: live 1s countdown (display face), description + absolute time.
  Source: `GET /schedule/next` (existing 30s poll).
- **Running**: count of board items with `status === "running"` (agents in
  flight, background/browser work). Pulsing success dot when > 0.
- **Recurring**: count of board items with a cadence and `status === "active"`.
- **Needs attention**: failed queue rows in the last 24h (first page of
  `GET /schedule/list?status=failed`, DESC — accurate unless >50 failures/day,
  capped as "50+"). Non-zero renders destructive tint + icon and is a button
  that jumps to Queue → History → Failed. Zero renders muted "All clear".

Status is never color-alone (icon + label accompany tints); all hues are
semantic tokens (color-guard compliant).

### Board tab

The existing kind-grouped inventory with quieter rows:

- Row line 1: title. Line 2: cadence · next/last run (viewer TZ, relative).
  The typed ref moves to the detail drawer only.
- Right: origin badge (System/You/Agent) + status + chevron.
- Detail drawer unchanged except: `dm`/`reminder` "Manage on …" links now
  switch the in-page tab (`/tasks?tab=dms`, `/tasks?tab=queue`) and close the
  drawer instead of leaving the page.

### Queue tab

Segmented **Upcoming | History** — the fix for F2's history/future mix:

- **Upcoming**: `GET /schedule` (agent-facing route; `pending,running`,
  `scheduled_for ASC`, limit 50). Soonest first, exactly what "upcoming"
  means. Client-side humanized type filter (Wake-up / DM / Morning routine /
  Evening review / One-off).
- **History**: existing `GET /schedule/list` (DESC, paginated) with status
  chips (All / Completed / Skipped / Failed) + the same type chips.
- Both segments open the existing `ScheduleDetailSheet` (edit/cancel pending
  rows). Upcoming rows are mapped camelCase→`ScheduleRow` by a pure helper.

### Scheduled DMs tab

`ScheduledDmsTable` moved verbatim (component untouched); the daemon-side
ownership story is unchanged — this tab *is* the owning surface for
`dm_session` rules now that it lives inside /tasks.

### Header actions

`[Refresh Today]` (regenerate today's plan → re-materializes the queue) and
`[+ Schedule]` (one-off / recurring DM create sheet) move from /schedule.

## 4. Data plumbing (all existing endpoints; zero daemon edits)

| Need | Source |
|---|---|
| Board inventory | `GET /api/tasks` (existing hook) |
| Next up | `GET /api/schedule/next` (existing hook) |
| Upcoming queue | `GET /api/schedule` — **new hook** `use-schedule-queue` (key `["schedule-list","queue"]` so the existing mutation invalidation prefix `["schedule-list"]` reaches it) |
| History | `GET /api/schedule/list` (existing infinite hook) |
| Recent failures | `GET /api/schedule/list?status=failed&limit=50` page 1 (new tiny query, 60s) |
| DM rules | `GET /api/recurring-schedules` (existing hook) |

The daemon package carries unrelated uncommitted WIP — deliberately untouched.

## 5. File plan

New:
- `lib/schedule/queue.ts` (+ `.test.ts`) — `ScheduleQueueItem` DTO,
  `humanizeTaskType`, `queueItemToScheduleRow`, `countRecentFailures`.
- `lib/hooks/use-schedule-queue.ts` — Upcoming + recent-failures queries.
- `components/tasks/status-strip.tsx` — the strip (countdown ticker inside).
- `components/tasks/queue-tab.tsx` — Upcoming/History segments + table.

Modified:
- `app/tasks/page.tsx` — hub layout: strip + 3 URL-addressable tabs (`?tab=`).
- `app/schedule/page.tsx` — `redirect("/tasks?tab=queue")`.
- `components/layout/app-sidebar.tsx` — remove Schedule entry.
- `app/agents/page.tsx` — header link → `/tasks?tab=queue`.
- `components/overview/tips-card.tsx` — schedule tip → `/tasks?tab=queue`.
- `lib/tasks/view.ts` (+ test) — `manageHref` dm/reminder → in-page tabs;
  `boardStats` pure helper for the strip.
- `lib/docs/page-doc-map.ts` — `/tasks` → schedule doc mapping.

## 6. Test plan

- Pure helpers unit-tested (dashboard convention: node-env `.test.ts`, no
  jsdom): queue mapping (incl. `task_context` stringify round-trip),
  type humanization fallback, failure counting window/cap, `boardStats`,
  updated `manageHref` pins.
- Full dashboard suite + `tsc`/`next build` for the package.
- Color-guard: no raw status-hue classes introduced (tokens only).

## 7. Follow-ups (not in this change)

- `trigger` board rows still have no owning dashboard page (API-managed).
- Consider surfacing per-kind cost rollups (migration 0022 groundwork) on the
  board detail drawer once the daemon WIP lands.
- Docs pages referencing the Schedule page should eventually rename; the
  redirect keeps them functional meanwhile.
