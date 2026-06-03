---
name: roadmap
description: Load when writing to roadmap.md — roadmap refresh, morning/evening routines, DMs with long-horizon intent, or scheduled tasks. Owns the section schema, entry taxonomy, Preparation Timeline rules, destination extraction, and the roadmap write lock.
allowed-tools:
  - Bash(curl *)
  - Read
---

# roadmap.md Guide

Output language: roadmap.md is Policy B — see `<output_language_policy>`. Section headers stay English skeleton; items, narrative, and preparation-timeline prose are in `<settings primary_language>`. Preserve user-customized headers verbatim.

`plans/roadmap.md` is the single source of truth for **long-horizon user
intent** — everything that does not belong in `state/today.md`. It aggregates
Calendar events, pending `agent_schedule` rows, DM-captured intent,
mail-derived bookings, reading goals, and observations; Morning Routine
consumes it to shape `state/today.md`.

## Section schema

```
# Roadmap
> Last synced: YYYY-MM-DD

## Annual Goals          (user-authored — never rewrite autonomously)
## Quarterly Focus       (user-authored — never rewrite autonomously)
## Long-term Plans       (agent-writable, undated OK)
## Agent Action Plan     (agent-writable, dated entries)
## Recurring             (preserved verbatim)
```

- Preserve user-authored sections (`## Annual Goals`, `## Quarterly
  Focus`, `## Recurring`) verbatim.
- `## Agent Action Plan` is rebuilt by entry ID during refresh. Do not
  regenerate it as anonymous text: preserve stable IDs and completed
  Preparation Timeline rows.
- `## Long-term Plans` is cumulative: append / per-entry edit; **never
  clear it during refresh**.
- The `> Last synced` header line carries the audit-timestamp role.
  Always bump it on PUT, even on no-op runs.

## Decision tree — where does this item go?

```
Is the item actionable and does it need agent-side preparation or awareness?
├── No → don't write to roadmap
│       (short-lived → today.md; preference → user-profile)
└── Yes
    ├── Is it an agent_schedule row?
    │   ├── task_context.importance is "transient" or "low" → don't write to roadmap
    │   ├── task_context.importance === "strategic"         → Agent Action Plan "Scheduled:" entry
    │   ├── scheduled_for <= now + 7d                       → today.md Agent Plan only
    │   └── normal/unspecified beyond 7d                    → Agent Action Plan "Scheduled:" entry
    ├── Does it have a specific event date?
    │   ├── Yes + within 48h                   → today.md only, not roadmap
    │   ├── Yes + >48h away                    → Agent Action Plan event entry
    │   │                                        with Preparation Timeline
    │   └── No                                 → Long-term Plans (single line,
    │                                             dateable later)
```

## Entry shapes

### Event entry (calendar / travel-bookings / DM-dated)

```
### YYYY-MM-DD ~ MM-DD: <event title>  <!-- id: rm-YYYYMMDD-abcdef -->
Source: <Google Calendar | Travel Bookings | DM>
Destination: <resolved location or "unknown — pending check">

**Preparation Timeline:**
- YYYY-MM-DD [tag]: action description
- ...

**Agent Notes:**
- supplementary info
```

### Scheduled-task entry (`agent_schedule` rows)

```
### Scheduled: <description>  (task #<id>)  <!-- id: rm-YYYYMMDD-abcdef -->
Source: scheduled.task — wake-up YYYY-MM-DD HH:MM
Status: pending | running | completed | failed

**Preparation Timeline:** (optional — only when the agent judges prep is useful)
- ...
```

### Long-term plan line

```
- [<horizon-tag>] <intent> — Source: <dm|mail|observation|reading|dashboard|manual> <YYYY-MM-DD> — Review: <YYYY-MM-DD|[noreview]> — ReviewCount: <0-3>  <!-- id: rm-YYYYMMDD-abcdef -->
```

One worked example (full horizon-tag grammar + more examples are in
the horizon-tags reference):
- `- [2026-05] LA trip candidate — Source: dm 2026-04-19 — Review: 2026-04-20 — ReviewCount: 0  <!-- id: rm-20260419-a3f1c2 -->`

## Stable entry identity

Every `## Agent Action Plan` entry and every `## Long-term Plans` line
must carry a daemon-minted HTML comment ID:

```
<!-- id: rm-YYYYMMDD-abcdef -->
```

- Format: `rm-YYYYMMDD-<6 lowercase hex>`.
- The `YYYYMMDD` segment is the entry creation date / Source date, not
  the event date. Keep it stable when dates are refined.
- Do not invent IDs in prose. Before adding a new roadmap entry, call
  `POST /api/context/plans/roadmap/id`:
  ```bash
  curl -s -X POST http://localhost:8321/api/context/plans/roadmap/id \
    -H 'Content-Type: application/json' \
    -d '{"creationDate": "YYYY-MM-DD"}'
  ```
- If preserving or editing an existing entry, keep its ID byte-for-byte.
- When promoting a Long-term Plan into Agent Action Plan, transfer the
  same ID to the new `###` heading and remove the original line.
- If a `roadmap_candidate` observation has
  `payload.roadmap_entry_id`, treat that as the intended entry ID
  before considering destination/date matching or minting a fresh ID.
- If a PUT/PATCH fails with duplicate-ID validation, re-GET roadmap,
  mint a fresh ID for only the colliding new entry, and retry once.

## Long-term Plans review fields

{{> ref:horizon-tags }}

## Preparation Timeline taxonomy

{{> ref:preparation-timeline }}

## Destination extraction (travel-class entries)

1. `calendar.location` is non-empty and parseable → use it.
2. Else: title regex for a known city / country →
   classify international vs. domestic.
3. Else: description body regex.
4. Else: destination = `"unknown — pending check"`, and add a
   `[check] <event_date - 28d>: Confirm destination for <title>` line
   to the Preparation Timeline.

## travel_bookings cross-check

Before generating a new event entry or a `[check]` prep line for
accommodation or flights, match against the user's actual booked
travel via `GET /api/travel-bookings/upcoming`. Match rules,
flip-to-completed grammar, and the no-match fallback are in the
cross-check reference below.

{{> ref:cross-check }}

## Long-horizon DM-intent detection

DM-driven long-horizon writes are dispatched from
`message.received.dm.md` / `message.received.dm_first.md` Step 4 via
the `_partials/dm-intent.long-horizon.md` task-flow partial — that
partial carries the signal/non-signal enumeration and the
post-detection routing rules (Agent Action Plan vs Long-term Plans vs
agent-journal candidate line).

**This skill is the writer.** Entry-shape recipes, stable identity,
preparation timeline taxonomy, destination extraction, retention, and
the cross-request write lock all live below — the partial dispatches,
this skill executes the writes.

## Section auto-ensure PATCH recipe

Legacy roadmaps may be missing `## Long-term Plans`. The PATCH-driven
recovery recipe — GET-inspect, insert after `## Quarterly Focus`,
then PATCH the target section — is in the migration reference below.

Full-file PUT writers (e.g. `routine.roadmap_refresh`) do not need
this recipe — they always emit the full section schema.

{{> ref:migration }}

## Retention (RFC-D preview)

{{> ref:retention }}

## API surface

Generic GET / PUT / PATCH / DELETE lives in the **context** skill's
`references/api.md`. The roadmap-specific layer — lock endpoints
(with the path-name gotchas), ID mint, the duplicate-id retry recipe,
and the transition guard — is in the reference below.

{{> ref:api }}

## Roadmap section schema (auto-curated)

<!-- CURATION:knowledge_layout id="entry-types" -->
