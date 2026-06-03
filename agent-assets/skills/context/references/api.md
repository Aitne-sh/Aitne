---
kind: reference
name: api
description: Canonical /api/context/* surface — read / write / list / lock / archive / restore / health / repair / action-log. Organised by operation.
---

# /api/context/* — Operation reference

Body submission follows `_safety.md` "Daemon-API body submission":
small section PATCHes use inline `-d '{...}'`; full-file PUT uses the
stdin heredoc `-d @- <<'JSON'` shape because the body runs multi-KB.

Add `X-Lock-Id: <today_write_lock_id>` (for `state/today.md`) or
`X-Lock-Id: <roadmap_write_lock_id>` (for `plans/roadmap.md`) on every
PUT / PATCH when the matching lock-id tag is in your context — the
daemon emits the tag only while the corresponding lock is held by
this session.

## Read

### GET /api/context/:path

```bash
curl -s http://localhost:8321/api/context/plans/roadmap
```

Response: `{ "content": "...", "lastModified": "ISO8601" }` or `404`.
Returns the **entire file** — no section-level GET. Path traversal is
rejected; the trailing `.md` is implicit (do not include it in the
URL).

### GET /api/context/list/:dir

```bash
curl -s http://localhost:8321/api/context/list/projects
```

Response: `{ "files": [{ "name", "lastModified" }, …] }`. Use this to
enumerate `projects/`, `weekly/`, `monthly/`, `user/`, `rules/`,
`routines/`, `inbox/` before deciding a write target.

### GET /api/context/today/reconciliation

Returns the Morning Routine's reconciliation report for `state/today.md`
(which mail/calendar/Notion sources contributed what to User Tasks /
Agent Plan). Read-only diagnostic surface; not the place to write
changes.

### GET /api/context/health

Returns a file-by-file health report — missing frontmatter, stale
`updated`, validator failures. Read-only.

## Write

### PUT /api/context/:path — Full replace

Fields:

| Field | Type | Description |
|---|---|---|
| `content` | string (required) | Full file body, including frontmatter and H1 where the file's validator requires them. |
| `expectedMtime` | string (optional) | ISO 8601. When present the daemon returns `409` if the current mtime differs — race protection for read-modify-write loops. |

Add `X-Lock-Id: <lock-id>` when writing a locked file (`state/today.md`,
`plans/roadmap.md`). Snapshots the prior content for restore.

Common rejections:

- `400 {error:"validation_error", message, path}` — file-specific
  validator failed (e.g. `state/today.md` line-1 date regex, `plans/roadmap.md`
  transition guard, required frontmatter missing on `user/*.md` /
  `rules/*.md` / `projects/*.md` / `daily/*.md` / `weekly/*.md` /
  `monthly/*.md`).
- `409 {error:"morning_routine_lock_held"}` — the Morning Routine holds
  the `state/today.md` write lock; `409 {error:"roadmap_write_lock_held"}`
  — another session holds the `plans/roadmap.md` lock. Retry with
  backoff (30s × 3).
- `400 {error:"validation_error", message, path}` — also covers the
  `state/today.md` line-1 agent-day mismatch (the message echoes both the
  supplied date and the daemon's current agent-day). The `422` status is
  reserved for *frontmatter* validation on globbed files (`user/*.md`,
  `rules/*.md`, `projects/*.md`, `daily/*.md`, `weekly/*.md`,
  `monthly/*.md`), not for today.md line-1.

`policies/management.md` is user-controlled policy: modify only when the
user explicitly asks, and preserve every unrelated section.

### PATCH /api/context/:path — Section operation

```bash
curl -s -X PATCH http://localhost:8321/api/context/state/today \
  -H 'Content-Type: application/json' \
  -d '{"section": "agent_log", "mode": "append", "content": "- 09:35 Processed meeting summary"}'
```

| Field | Type | Description |
|---|---|---|
| `section` | string | snake_case of the heading (e.g. `learned_context`, `agent_log`, `log`). **Omit for `append_to_file` and `frontmatterMerge`**; required for every other mode. |
| `mode` | `append` \| `replace` \| `clear` \| `clear_before` \| `append_to_file` \| `frontmatterMerge` | Default `append`. |
| `content` | string | Ignored for `clear` / `clear_before` / `frontmatterMerge`. |
| `cutoff` | string | **Required when `mode: "clear_before"`.** SQLite format `YYYY-MM-DD HH:MM:SS` (zero-padded). Removes bullet rows whose `- [YYYY-MM-DD HH:MM:SS]` timestamp is ≤ cutoff. |
| `maxEntries` | number | Optional for `mode: "append"`. After appending, trim oldest bullet entries from the top of the section body so at most `maxEntries` bullets remain. Non-bullet lines are preserved. SignalDetector uses cap = 20. |
| `frontmatter` | object | **Required when `mode: "frontmatterMerge"`** (and only valid then). Non-empty partial frontmatter object, deep-merged into the file's YAML frontmatter. |

Mode semantics:

- `append` — add `content` to the end of the section body. Preserves siblings byte-for-byte.
- `replace` — replace the entire section body with `content`. **Read-before-write is mandatory** — `replace` does not merge; sending just one bullet erases every sibling. The skill body's "Worked example" shows the GET-merge-PATCH pattern.
- `clear` — drop the section body, keep the heading.
- `clear_before` — rolling-log trim, drops bullets with timestamps ≤ `cutoff`. Non-bullet lines preserved. Race-safe consumption shape for `Raw Signals` and similar logs.
- `append_to_file` — omit `section`, append `content` to the end of the file. The intended first-write path when a section header does not exist yet: include the header inside `content` (`"\n## Section\n- bullet\n"`). Also the only write shape for files with no canonical section schema (`journal/agent.md`).
- `frontmatterMerge` — omit `section`; deep-merge the `frontmatter` object into the file's existing YAML frontmatter (nested objects merge key-by-key; scalars/arrays replace), preserving the body verbatim. The chokepoint-safe way to link entity `sources.<app>.<id>` + set `last_synced_at` without a read-modify-write of the whole file (design 21 §10.4).

Common rejections (informational responses worth knowing):

- `400 {error:"section_not_found", section, availableSections:[…]}` — the section name did not match. `availableSections` lists every snake_cased heading the file actually has; pick the closest match and retry. Do NOT retry the same `section` value.
- `400 {error:"validation_error", message, path}` — content failed the file-specific validator.
- `400 {error:"cutoff_required", message}` — `clear_before` was called without a valid `cutoff`.
- `409 {error:"morning_routine_lock_held"}` (PATCH/PUT on `state/today`) or
  `409 {error:"roadmap_write_lock_held"}` (PATCH/PUT on `plans/roadmap`) —
  the file's write lock is held by another session. (The generic
  `lock_held` code is only emitted by `POST /api/context/lock/morning-routine`
  on contended acquisition, never by a PATCH/PUT.)

### DELETE /api/context/:path

Removes the file (snapshot first). The daemon only allows DELETE on a
small set of paths — notably `policies/routines/custom/<slug>` (after the user
asks to retire a custom routine). Most files are NOT delete-eligible
(e.g. `state/today.md`, `plans/roadmap.md`, `identity/profile.md`); the daemon returns
`403 {error:"forbidden"}` (with `errors[0].code: "context.write_forbidden"`)
for those.

## Lifecycle

### POST /api/context/archive-today

Rotates `state/today.md` → `state/yesterday.md` (synthesized `daily/YYYY-MM-DD.md`
is now written by the Morning Routine, not this endpoint). Called by
the Morning Routine during day rotation; other sessions should NOT
invoke this directly.

### POST /api/context/restore-snapshot/:id

Restores the file from snapshot `id` (the daemon snapshots every PUT /
PATCH / DELETE). Diagnostic / recovery surface; never part of a normal
write path. The snapshot listing endpoint is `GET /api/context/health`
adjacent and is dashboard-only — agents should not rely on it in flows.

### POST /api/context/repair/stub

Auto-repairs a stubbed file (e.g. a file that exists but has only the
H1) by re-running its template seed. Recovery surface; called only
when `GET /api/context/health` reports the file as stubbed.

## Locks

`state/today.md` and `plans/roadmap.md` are locked files: `PUT` / `PATCH` requires
the lock to be held by the calling session, and the daemon emits an
`X-Lock-Id` header value that must be echoed on each request via the
`X-Lock-Id:` header.

### Morning-routine lock (today.md)

| Action | Verb | Path |
|---|---|---|
| Acquire | `POST` | `/api/context/lock/morning-routine` |
| Release | `DELETE` | `/api/context/lock/morning-routine` (body `{"lockId":"…"}`) |

The dispatcher auto-acquires this lock for `routine.morning_routine`
and surfaces the id via `<today_write_lock_id>` in the prompt context.
Other sessions get `409 morning_routine_lock_held` on PUT / PATCH while
the lock is held — back off 30 s and retry up to 3 times.

### Roadmap lock

| Action | Verb | Path |
|---|---|---|
| Acquire | `POST` | `/api/context/lock/roadmap` |
| Release | `DELETE` | `/api/context/lock/roadmap` (body `{"lockId":"…"}`) |

The dispatcher auto-acquires for `routine.roadmap_refresh`. Other
flows (DM handler, evening sweeper) can acquire / release manually.
PUT / PATCH returns `409 roadmap_write_lock_held` while held by
another session — same 30 s × 3 retry pattern.

**Path-name gotchas** (these return `404 {"error":"unknown_route", …}`
with a hint pointing at the correct path):

- `POST /api/context/plans/roadmap/lock` — order reversed.
- `POST /api/context/plans/roadmap/write-lock` — order reversed and wrong noun.
- `POST /api/context/lock/roadmap-write` — wrong noun.

A `401 {"error":"unauthorized"}` from a path you believe is correct
means the path is still wrong (the lock endpoints are Autonomous-tier
so no bearer token is required).

## Roadmap-specific writes

### POST /api/context/plans/roadmap/id

Mints a new stable entry id (`rm-YYYYMMDD-<hash>`) for a roadmap row.
Requires `X-Lock-Id: <roadmap_write_lock_id>`.

```bash
curl -s -X POST http://localhost:8321/api/context/plans/roadmap/id \
  -H 'Content-Type: application/json' \
  -H 'X-Lock-Id: <roadmap_write_lock_id>' \
  -d '{"creationDate":"YYYY-MM-DD"}'
```

The roadmap API also validates ID uniqueness on PUT / PATCH and runs a
transition guard: if an entry id survives from previous → next
content, every previous `completed …` row for that id must still
exist byte-for-byte. If an entry id disappears entirely, removal is
accepted only when the retention window permits it or the operator
bypass header is used.

## Action log

### POST /api/action/log

```bash
curl -s -X POST http://localhost:8321/api/action/log \
  -H 'Content-Type: application/json' \
  -d '{"actionType": "observation", "detail": "reviewed 6 pending changes, added 2 tasks", "result": "success"}'
```

Records an entry in `agent_actions` for the dashboard's audit feed.
Not the same as `state/today.md ## Agent Log` (that's a markdown surface;
this is a SQLite row). Risk tier: Autonomous.
