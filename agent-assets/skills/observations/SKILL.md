---
name: observations
description: Drain the pending-observations queue and inspect raw external-source state (Obsidian edits, new git commits, Notion updates), marking processed entries consumed. Use during activity scan or morning routine review.
allowed-tools:
  - Bash(curl *)
  - Read
---

# Observations Review & Source Access

Output language: write-ups inherit the destination file's policy via the `today` / `roadmap` / `context` / `project-doc` skills you call. See `<output_language_policy>`.

## Workflow

1. Fetch pending user-originated observations:
   `curl -s "http://localhost:8321/api/observations?pending=true&actor=user&limit=20"`
2. Group related observations before acting.
3. For each group, apply the **fetch decision** (below) — `summary_text` + `novelty_score` are pre-computed by the daemon's per-observation summarizer; only `novelty_score >= 2` warrants full content fetch.
4. Decide actionability:
   - Update `state/today.md` for TODOs, blockers, decisions, or deadlines
   - Update `plans/roadmap.md` or `projects/*.md` only for material project-state changes
   - Schedule a wake-up if the observation implies a future reminder
5. Apply the smallest meaningful set of context updates.
6. Mark processed observations consumed via the bulk endpoint
   (`POST /api/observations/consume`) — see "POST /api/observations/consume"
   in the API Reference below for the exact body shape and the
   `correlationId` rule. There is no per-id variant.

## Skip Criteria

- Journal-only edits with no actionable follow-up
- Formatting-only churn / auto-generated files / index refreshes
- Agent-originated changes (already filtered via `actor=user`)

## Actionable Criteria

- New TODO/FIXME items or explicit deadlines affecting current work
- Meeting notes with decisions or blockers
- Project milestones or status changes worth reflecting in roadmap/projects

**Cost:** Prefer one grouped patch over many small writes. If all noise, just log that you reviewed.

---

## Fetch Decision Guide

The daemon pre-summarizes every observation with a per-source LLM call (lite tier) and writes `summary_text` (≤120 chars) + `novelty_score` (0–3) onto the row. Use those signals as your primary input — fetch full content **only** when the score warrants it.

### Tiered consumption (cost-reduction-structural §A)

| `summary_status` / `novelty_score` | Action | Notes |
|---|---|---|
| `summary_status === 'done'` AND `novelty_score >= 2` AND `summaryStale === false` | **Fetch full** if needed; route to today.md / projects / roadmap | High-signal — usually justifies the round-trip |
| `summary_status === 'done'` AND `novelty_score === 1` AND `summaryStale === false` | **Use `summary_text` only** | Minor — no fetch unless cross-referenced by another observation in the same batch |
| `summary_status === 'done'` AND `novelty_score === 0` AND `summaryStale === false` | **Silently consume** | Noise — log only when aggregating |
| `summaryStale === true` | Treat as if `summary_status !== 'done'` — fall back to legacy fetch-on-doubt | Summary aged out (>6h since observed_at); content may have drifted under it |
| `summary_status !== 'done'` (pending/skipped/failed/null) | Fall back to legacy fetch-on-doubt below | Summarizer disabled, lagging, or crashed |

**Hard rule:** never fetch raw content when `novelty_score < 2`, unless a different observation in the same batch references the same path/ref OR `summaryStale === true`. This is the primary lever for activity_scan cost reduction.

### Legacy fetch-on-doubt (used when `summary_status !== 'done'`)

When the summarizer hasn't run (`summary_status !== 'done'`) or its summary aged out (`summaryStale === true`), fall back to the fetch-on-doubt heuristic table: {{> ref:fetch-fallback }}

---

## Observation Review Logging

Activity scan and Morning Routine review pending observations in aggregate. Even when nothing is surfaced, the review must remain auditable.

### observations → Agent Log

Section: `agent_log` · Mode: `append` · Format: `- HH:MM [observations] summary_of_review`

Examples:
- `- 09:35 [observations] reviewed 6 pending changes, added 2 tasks from Obsidian, skipped 4 as non-actionable`
- `- 16:08 [observations] reviewed 5 changes, no actionable updates`

Skip reasons: `skipped (personal journal)`, `skipped (auto-generated)`, `skipped (no actionable content)`, `skipped (routine note)`.

---

## API Reference — Observations

### GET /api/observations

```bash
curl -s "http://localhost:8321/api/observations?pending=true&actor=user&limit=20"
```

Params: `pending` (bool, default true), `actor` (user/agent/system/unknown), `limit` (1-100, default 20), `offset`, `source` (prefix match — e.g. `obsidian`, `obsidian:primary`, `obsidian:external`, `git`, `calendar`), `since` (ISO 8601).

The `source` filter is a prefix match: `source=obsidian` returns rows from both the primary management vault (`obsidian:primary`) and the external note vault (`obsidian:external`). Narrow to one side with the namespaced form when the distinction matters — typically `obsidian:primary` refers to the agent's own files and most user-actionable edits come from `obsidian:external`.

Response: `{ "observations": [{ "id", "source", "ref", "changeType", "actor", "observedAt", "payload", "consumedAt?", "consumedBy?", "summaryText?", "noveltyScore?", "summaryStatus?", "summaryAt?", "summaryBackend?", "summaryStale" }], "limit", "offset", "pending" }`

`summaryText` / `noveltyScore` are populated asynchronously by the per-observation summarizer (cost-reduction-structural §A). When `summaryStatus !== 'done'` the row may have been skipped (deny-list, agent-actor) or the summarizer hasn't caught up yet — fall back to the legacy fetch-on-doubt rules in that case. `summaryStale === true` flags summaries older than 6 h relative to `observedAt`; treat them the same way as a missing summary.

### POST /api/observations

Record an agent-queued observation (only `actor: "agent"` or `"system"`
accepted — user-authored observations arrive through the vault / mail
watchers, never this route). Used by `routine.activity_scan` to queue
`roadmap_candidate` signals the next `routine.roadmap_refresh` consumes.

```bash
curl -s -X POST http://localhost:8321/api/observations \
  -H 'Content-Type: application/json' \
  -d '{"source":"roadmap_candidate:travel","ref":"trip-portland-2026-summer","changeType":"created","actor":"agent","payload":{"note":"DM mentioned Portland trip this summer"}}'
```

`(source, ref)` is the idempotency key — re-posting the same pair while
the prior row is still pending **updates** the payload rather than
creating a duplicate. Subkind suffixes after the colon are by
convention (`roadmap_candidate:calendar`, `roadmap_candidate:vault`,
etc.) and are picked up by the prefix match on the GET route.

### POST /api/observations/batch

Bulk-insert up to 200 observations in a single transaction. Use this
whenever a single fetch surface (a mail window, a calendar query, a
Notion page list) yields more than one observation — calling
`POST /api/observations` once per item collides with the Bash hook
that caps each curl invocation at one HTTP request and strips heredoc
bodies before URL validation. The batch endpoint resolves the
cardinality mismatch without weakening either hook.

> **If `mcp__aitne-observations__submit_observations` is in your allowed
> tools (the `routine.fetch_window` pre-pass on Claude), submit the batch
> through that MCP tool instead of the curl below.** The structured
> transport never goes through the SDK bash preflight, so Unicode-bearing
> payloads (NBSP/ZWS in subjects, U+3000 in titles) can't trip its
> `too-complex` gate and cascade to a denied curl / wasted retry /
> `budget-cap`. The tool input is the same `{"observations":[…]}` envelope
> and the response is identical. The curl form below is the fallback for
> sessions without the MCP tool (the activity scan, Codex/Gemini).

```bash
curl -s -X POST http://localhost:8321/api/observations/batch \
  -H 'Content-Type: application/json' \
  -d @- <<'JSON'
{
  "observations": [
    {"source":"gmail:acct-1","ref":"msg-123","changeType":"created","actor":"agent",
     "payload":{"kind":"mail","providerId":"acct-1","raw":{"subject":"…","from":"…","snippet":"…","date":"…"}}},
    {"source":"gmail:acct-1","ref":"msg-124","changeType":"created","actor":"agent",
     "payload":{"kind":"mail","providerId":"acct-1","raw":{"subject":"…","from":"…","snippet":"…","date":"…"}}}
  ]
}
JSON
```

Per-element shape mirrors `POST /api/observations` exactly. Same
forgery guard (`actor` must be `"agent"` or `"system"`), same
server-side `(source, payload)` content-hash dedup.

Response is always `200` with envelope:

```json
{
  "results": [
    {"index":0,"status":"created","source":"gmail:acct-1","ref":"msg-123","contentHash":"…","id":42},
    {"index":1,"status":"duplicate","source":"gmail:acct-1","ref":"msg-124","contentHash":"…","id":17}
  ],
  "fetched": 2,
  "posted": 1,
  "duplicates": 1,
  "errors": 0
}
```

`results[*].status` is one of `"created"`, `"modified"`, `"duplicate"`,
`"flip_locked"` (integration mode-flip in progress — retry on the next
tick), `"validation_error"` (malformed item; `error` field names the
issue). The envelope's `posted` / `duplicates` / `errors` counters are
pre-aggregated; the per-item array is for correlating a failure back
to a specific input.

Hard limits:

- Max 200 items per call. Larger batches return 400 `batch_too_large` —
  split into chunks.
- 1 MiB body cap (shared with the single-item route).
- Envelope JSON must have an `observations` array; missing or
  non-array returns 400 `validation_error` with a hint.

### POST /api/observations/consume

Marks one or more observations consumed. **Bulk-only** — there is no
per-id endpoint (`POST /api/observations/<id>/consume` returns 405
`use_bulk_endpoint`). Always use this shape, even for a single id.

Copy the `correlationId` value verbatim from the
`<event_correlation_id>…</event_correlation_id>` tag in your turn
context — do not paste the angle-bracket placeholder.

```bash
# Example: <event_correlation_id>hourly-2026-04-23T15:00:00Z-7af3</event_correlation_id>
# arrived in context, and observations 14 and 17 were processed.
curl -s -X POST http://localhost:8321/api/observations/consume \
  -H 'Content-Type: application/json' \
  -d '{"ids":[14,17],"correlationId":"hourly-2026-04-23T15:00:00Z-7af3"}'
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `ids` | `number[]` | yes | Integers, not strings. `["14"]` is rejected. |
| `correlationId` | `string` | yes | camelCase, verbatim from the `<event_correlation_id>` context tag. Non-string, missing, snake_case `correlation_id`, or the literal placeholder `<...>` → 400. |

Response: `{ "consumed": <count>, "notFound": [<id>...] }`. Validation
failures return 400 with `{ "error": "validation_error", "issues": [...], "expectedShape": "...", "example": "..." }`. **Read the
`issues` array — each entry names the offending field and a one-line
fix. Do NOT retry with a different shape unless the issue list tells
you to.**

#### Common mistakes — do not retry these, they will keep failing

The live `issues[]` array names any other malformed field; these are the highest-frequency ones.

| Wrong call | Why it fails | Correct shape |
|---|---|---|
| `POST /api/observations/14/consume` | Per-id path returns 405 `use_bulk_endpoint`. | `POST /api/observations/consume -d '{"ids":[14],"correlationId":"..."}'` |
| `-d '{"ids":[14],"correlation_id":"..."}'` | snake_case. Field must be camelCase. | `-d '{"ids":[14],"correlationId":"..."}'` |
| `-d '{"ids":["14"],"correlationId":"..."}'` | Stringified ids. Use integers. | `-d '{"ids":[14],"correlationId":"..."}'` |

### GET /api/observations/stats

`curl -s http://localhost:8321/api/observations/stats` → `{ "totalPending", "oldestPendingObservedAt", "bySource": [{ "source", "pendingCount", "oldestObservedAt" }], "summaryStatusCounts": {...}, "noveltyDistribution": [...] }`

`totalPending` is the single count of unconsumed observations (no separate `total` / `pending` keys). `bySource` is an **array** of per-source rows, not a map. There is no `byActor`. `summaryStatusCounts` / `noveltyDistribution` are summarizer-health telemetry.

---

## External Source Read Endpoints

Use when the fetch decision says to retrieve full content. These access the
**external** Obsidian vault, Git repos, and Notion — not the agent's primary
management vault. Primary-vault reads and writes go through `/api/context/*`
(see the `context` skill).

### Obsidian (external vault)

```bash
curl -s http://localhost:8321/api/obsidian/status
curl -s "http://localhost:8321/api/obsidian/search?q=meeting+notes&limit=10"
curl -s http://localhost:8321/api/obsidian/notes/Daily%20Notes/2026-04-06  # URL-encode spaces, omit .md
```

### Git

Only repos in `PA_GIT_REPOS`. Use `repoPath` from event data.

```bash
curl -s "http://localhost:8321/api/git/log?repo=/path/to/repo&count=5"
curl -s "http://localhost:8321/api/git/diff?repo=/path/to/repo&ref=HEAD~3..HEAD"
curl -s "http://localhost:8321/api/git/show?repo=/path/to/repo&hash=abc1234"
```

### Notion

The wire surface depends on Notion's integration mode (read
`<integration_modes>` injected above). Pick the branch that matches the
current state.

<!-- mode:direct:notion -->
```bash
# ?database= takes a database LABEL (default "tasks"), not a UUID.
# An unrecognized label returns 404 notion.database_not_found with the
# list of valid labels; an absent param silently uses "tasks".
curl -s "http://localhost:8321/api/notion/query?database=tasks"
```
<!-- /mode:direct:notion -->
<!-- mode:delegated-same:notion -->
The `/api/notion/query|search|pages` routes return 410 in delegated
mode. Use your session backend's native Notion MCP tool — the
connector is signed in directly on this backend, no daemon proxy is
involved. Resolve `<databaseId>` first by reading the un-gated
`/api/notion/databases` config dump
(`curl -s http://localhost:8321/api/notion/databases`) and then pass
the UUID to the connector's data-source / search tool:

| session backend | structured filter (data-source query) | listing fallback (no filter support) | workspace search |
|-----------------|---------------------------------------|--------------------------------------|------------------|
| claude          | n/a — hosted connector has no filtered query | in-session Notion page-fetch capability | in-session Notion search capability |
| codex           | in-session Notion data-source-query capability | in-session Notion fetch capability | in-session Notion search capability |
| gemini          | n/a — hosted connector has no filtered query | in-session Notion page-fetch capability | in-session Notion search capability |

The exact tool names depend on which Notion connector your harness has
loaded — pick them from your tool menu at session start by capability.
For Claude / Gemini sessions: call the listing capability against the
data source and post-filter in this skill (the structured-filter
capability is typically Codex-only). For Codex sessions: pass the
SQLite-style `WHERE` clause directly to the data-source-query
capability. See the `notion` skill body for full property-naming and
write-tier conventions.
<!-- /mode:delegated-same:notion -->
<!-- mode:delegated-cross:notion -->
The `/api/notion/query|search|pages` routes return 410 in delegated
mode and your own backend's native Notion connector (if signed in)
reads a different workspace than the user's delegated one. Call the
daemon's `/exec` task endpoint with a natural-language intent — the
daemon spawns the delegated backend's subprocess and lets it pick
the right connector primitive whichever backend currently owns
Notion. Resolve `<databaseId>` first via
`curl -s http://localhost:8321/api/notion/databases` (the config-dump
path is un-gated), then:

```bash
curl -s -X POST http://localhost:8321/api/integrations/notion/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "task": "Fetch the most recent <N> pages in the <DB-LABEL> database (data source <UUID>). For each return id, title, lastEditedAt, and any Status property.",
    "outputSchema": { "type": "object", "required": ["pages"], "properties": { "pages": { "type": "array", "items": { "type": "object", "required": ["id","title","lastEditedAt"] } } } },
    "maxToolCalls": 5,
    "cacheable": true
  }'
```

Do NOT call `/api/notion/{query,search,pages}` directly (returns
410), and do NOT fall back to your own backend's native Notion MCP
tools — that connector reads a different workspace than the user's
delegated one.
<!-- /mode:delegated-cross:notion -->
<!-- mode:native:notion -->
Notion is in native mode — the `/api/notion/{query,search,pages}`
routes return 410 `{"error":"integration_native"}` and the daemon
does not host an `/exec` proxy. Use your session backend's native
Notion MCP tools directly; the materialized `notion` skill body
(`SKILL.native.<session-backend>.md`) lists the per-backend tool
names and the canonical search / fetch call shapes. Resolve
`<databaseId>` first via the un-gated config dump
(`curl -s http://localhost:8321/api/notion/databases`) and pass the
UUID to the connector's data-source / search tool. Do NOT call
`/api/notion/*` (410) or `/api/integrations/notion/exec` (returns 409
`mode_mismatch` in native mode — the `/exec` path is not route-gated,
so it is the handler, not the 410 gate, that rejects it).
<!-- /mode:native:notion -->
<!-- mode:disabled:notion -->
Notion is disabled — there is no live source. Treat the observation
as preview-only and proceed without a Notion fetch.
<!-- /mode:disabled:notion -->

## Source namespacing (auto-curated)

<!-- CURATION:convention_notes id="source-namespacing" -->
