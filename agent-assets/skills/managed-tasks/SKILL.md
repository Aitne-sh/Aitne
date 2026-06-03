---
name: managed-tasks
description: Register / modify / stop / run-now a Managed Task (mt_<n>) — recurring agent fetch against a third-party app (Zoom, Gmail, Drive, Notion, custom MCP). Skip for one-off reminders (schedule), durable no-app rules (management-policy), DM-only cadences (recurring-schedules).
allowed-tools:
  - Bash(curl *)
  - Read
---

# Managed Tasks (`mt_<n>`)

A **managed task** is a user-delegated commitment: the agent runs a
recurring fetch against a specific App at a user-specified Cadence and
writes the resulting entities into a primary L2 directory (the
`Output path`). Each row lives in `policies/management.md` §B. The
authoritative store is the `managed_tasks` SQLite table; the file is
re-rendered from the table after every mutation, so do **not** PUT the
file yourself — every legal mutation goes through `/api/managed-tasks`
and the daemon owns the file write.

Conditionally loaded — see the `managedTasksActive(db)` predicate in
`packages/daemon/src/core/skills-manifest.ts`. The predicate fires
when at least one `managed_tasks` row exists OR the inbound DM
contains a trigger anchor (`mt_<n>`, "managed task", "recurring
fetch", or the app-verb pairs in the §"Register" trigger examples).

## When to use this skill

| Verb | User said | Section |
|---|---|---|
| Register | "check Zoom recordings every day at 10am" / "every Monday at 9 pull new Drive PDFs into receipts" | §Register |
| Modify | "move the Zoom check to 9am instead of 10am" / "send Drive receipts to `finance/receipts/`" | §Modify |
| Stop | "stop the daily Zoom check" / "cancel `mt_42`" | §Stop |
| Run-once | "run `mt_42` now" / "trigger the gmail triage immediately" | §Run once (off-schedule) |

## When NOT to use this skill

| Shape | Use instead |
|---|---|
| One-off "remind me at 3pm to call the bank" | `schedule` (`/api/schedule/dm`) |
| Recurring DM with no external-app fetch ("ping me every Monday at 9") | `schedule` recurring-schedules |
| "From now on, when X happens, do Y" passive rule with no cadence | `management-policy` |
| Tone / style / single fact about the user | `user-profile` |
| Source-of-Truth declaration ("notes live in Obsidian") | A-section binding via `PUT /api/sot-bindings` |
| Change which **app** an existing task targets | §Stop, then §Register (different connector ⇒ different commitment; the probe must run fresh) |

If the user already has `mt_<n>` for the same app + cadence, register
**refuses** with a DM pointing at the existing row — that is the
dedup contract. Do not register a duplicate.

---

## Register

### Step 1 — Read current state

```bash
curl -s "http://localhost:8321/api/context/policies/management" | jq -r .content
```

Extract §B (Managed tasks) and §A (Source-of-Truth bindings). §A
tells you which app already owns a category (e.g. `tasks → notion`);
a duplicate-cadence registration against an unrelated app for the
same category is a smell — confirm with the user before registering.

### Step 2 — Semantic dedup (LLM judgment)

For each existing §B row, compare the requested
`(app_normalized, cadence_semantic, intent_semantic)` against the
row. Treat a row as a **high-confidence match** when:

- `app_normalized` matches case-insensitively (`zoom` ≡ `Zoom`), AND
- the cadence resolves to the same structured recurrence, AND
- the intent describes the same fetch shape ("recordings → meeting
  entity" is the same as "new recordings → meeting entity").

On a match, DM the user verbatim with the existing row's id, cadence
and last result, and stop:

> Already managed as `mt_42` (daily 10:00 — last run ok 3 new). Modify
> or stop it via DM.

If multiple plausible matches exist, ask the user which one to update
and end the flow (their reply triggers §Modify).

If §B is at the cap (default 100, configurable
`managementMaxActiveTasks`), refuse with a DM pointing at the cap;
the user must stop something first.

### Step 3 — Tool selection (LLM judgment, in-session)

Enumerate the tools available to this session (`mcp__*`, native
backend connectors, custom MCP servers the user installed). Ask
yourself: *"Which of these, if any, lets me read the user-typed app
label?"*

- **Zero plausible** → DM "I don't see a connected tool for `<app>`
  on this backend. Connect one and ask again." Stop.
- **Multiple plausible** → DM the user with the candidates verbatim
  and ask which one to use. Stop. (The user's reply re-enters this
  flow with the chosen tool as a hint.)
- **One plausible** → continue.

NEVER hardcode tool names or pattern-match against a specific
namespace prefix. The user may have installed a custom MCP with
non-standard names — read the tool description and pick by
**capability**, not by name.

### Step 4 — Read-only probe

Invoke the chosen tool with the **smallest** read-only payload that
proves connectivity and authorization (list the first page with
`limit: 1`, fetch the user's profile / "me" endpoint, search empty
string). Do NOT mutate state.

On any error — auth failure, network error, schema error,
out-of-quota — DM the verbatim error message with one line of
context and stop:

> Couldn't reach `<app>`: `<verbatim error from tool>`.

The probe failure must surface the connector's own error string, not
a paraphrase. The user is the one who can fix auth / quota / install.

### Step 4a — Decide `output_path` (LLM judgment)

Infer the primary L2 directory the recurring fetch will write into:

1. Reuse an existing path if the source already lives somewhere —
   `curl -s "http://localhost:8321/api/entities?source=<app>&limit=5" | jq -r '.items[].path'`;
   if 1+ rows agree on `<domain>/<type-plural>`, that path wins.
2. Else pick by the probe sample's data shape (mapping table in the
   reference below).
3. Else omit the field (`output_path: null`) — the first scheduled run
   back-fills it.

The full grammar (allowed domain / type values, trailing-slash rule,
`..` rejection, 400 rejection shape, data-shape mapping) is below.

{{> ref:output-path }}

### Step 5 — Resolve the cadence

Translate the user's natural-language cadence into a free-text
`cadence` string (rendered in §B) AND a structured `recurrenceRule`
(the scheduler's input). The full grammar — daily / weekly / monthly
support, sub-daily refusal template, mapping table, daysOfWeek vs
daysOfMonth rules — is in the reference below.

{{> ref:recurrence-rule }}

### Step 6 — POST /api/managed-tasks

```bash
curl -sS -X POST http://localhost:8321/api/managed-tasks \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: <opaque uuid for this DM>' \
  -d @- <<'JSON'
{
  "intent":      "Zoom recordings → meeting entity",
  "app":         "zoom",
  "cadence":     "daily 10:00 (Asia/Tokyo)",
  "recurrenceRule": {
    "frequency": "daily",
    "time":      "10:00",
    "timezone":  "Asia/Tokyo"
  },
  "output_path": "work/meetings/"
}
JSON
```

| Field | Required | Notes |
|---|---|---|
| `intent` | yes | ≤ 200 chars, NFC, no newlines, no pipe chars |
| `app` | yes | ≤ 64 chars, NFC, no newlines, no pipe chars; user-typed label preserved verbatim (case + non-ASCII OK) |
| `cadence` | yes | Human-readable; rendered in §B (≤ 200 chars) |
| `recurrenceRule` | yes | See recurrence-rule reference |
| `output_path` | no | See output-path reference; omit while undecided (first scheduled run back-fills it) |

Response: `{status:"created", item:<ManagedTask>, render_status:"ok"|"lock_contended:..."}`.
On an idempotent replay (same `Idempotency-Key` within 24 h, row
still exists) you get `{status:"idempotent_replay", item:<ManagedTask>}`
with HTTP 200 — treat as success.

**Idempotency-Key**: generate a stable key per DM (e.g. SHA-256 of
the inbound message id + app). Concurrent retries collapse to the
same `mt_<n>`; a different key with the same `(app_normalized,
cadence)` collides at the uniqueness check and returns `409
duplicate` with the existing `mt_id` — DM the user pointing at it
instead of registering twice.

**Server-side**: the daemon runs the atomic tx (allocate `mt_<n>`,
INSERT the FK-linked `recurring_schedules` + `managed_tasks`, audit),
re-renders `policies/management.md`, and snapshots it — you do not
touch the file. On a DB failure you get a 5xx; surface the body.

### Step 7 — Confirm to user

DM the user once with `item.id`, `item.output_path`, and
`item.cadence` from the POST response. The next firing time is owned
by the scheduler — phrase around the cadence, not a clock time:

> Registered as `mt_43` (Zoom · daily 10:00 JST). Output → `work/meetings/`. Starts at the next 10:00 JST slot.

Persona / language rules are in `notify` — follow the awareness gate
and no-ceremony rules. Don't enumerate the steps ("did probe, did
INSERT, did re-render"); the daemon already audited them.

---

## Modify

### Step 1 — Locate the row

Same lookup as Stop. Either the user named the id, or fuzzy-match by
`(app, cadence, intent)`:

```bash
# By id when the user said "mt_42":
curl -s "http://localhost:8321/api/managed-tasks/mt_42" | jq .item

# By app fuzzy lookup:
curl -s "http://localhost:8321/api/managed-tasks" | jq '.items[] | select(.app_normalized == "zoom")'
```

GET-by-id wraps the row in `{item:<row>}`; the list returns
`{items:[…], count:N}`.

If no row matches, DM:

> No managed task for `<app>` is registered. Want me to register one?

If multiple rows could match, list them with id + cadence + intent
and ask the user to pick. Stop until they reply.

### Step 2 — Diff the requested change

Map the user's request to one or more of these fields:

| User request | PATCH field | Notes |
|---|---|---|
| "9am instead of 10am" / "every Monday" | `cadence` + `recurrenceRule` (send both together) | See recurrence-rule reference |
| "Rename intent" / "describe it as `<text>`" | `intent` | ≤ 200 chars, NFC, no `\n`, no `\|` |
| "Send to `<dir>/`" | `output_path` | See output-path reference; send `null` to clear |

If the request implies an **app change**, stop and route to "stop +
re-register" — a different connector is a different commitment.

### Step 3 — Confirm before mutating (Notify tier)

PATCH on a managed task is **Notify tier**. DM the user verbatim
with the proposed change and wait for an explicit yes:

> `mt_42` Zoom check — change cadence from `daily 10:00 (Asia/Tokyo)`
> to `daily 09:00 (Asia/Tokyo)`?

If they decline or amend, restart Step 2 with the new shape. When
the confirmation also implies a different output path, include both
fields in one PATCH so the audit row reflects the user's intent in a
single transition.

### Step 4 — PATCH /api/managed-tasks/:id

```bash
curl -sS -X PATCH http://localhost:8321/api/managed-tasks/mt_42 \
  -H 'Content-Type: application/json' \
  -d @- <<'JSON'
{
  "cadence":     "daily 09:00 (Asia/Tokyo)",
  "recurrenceRule": {
    "frequency": "daily",
    "time":      "09:00",
    "timezone":  "Asia/Tokyo"
  }
}
JSON
```

`app` / `app_normalized` / `last_run_at` / `last_result` /
`consecutive_failures` are NOT mutable through this PATCH. App
rename has its own dedicated route
(`POST /api/managed-tasks/:id/rename-app`) — but Step 1's
disambiguator already routes app-change requests to "stop + re-register"
for safety.

**Server-side**: the daemon runs the atomic tx + re-renders the file
+ audits — you do not touch the file.

`mt_id`, `last_run_at`, `last_result`, and `consecutive_failures`
are preserved across PATCH — history is continuous. A cadence change
cancels any in-flight `agent_schedule` row tied to the old cron; the
new cron takes effect from the next eligible slot.

**Output-path relocation does NOT move existing entity files.** Past
entities stay where written. For reorganisation: stop, move
manually, re-register.

### Step 5 — Confirm to user

One DM, persona-tone. Read the resolved fields from the PATCH
response — do NOT echo what you sent in case the daemon normalized
something:

> Updated `mt_42` Zoom check — now daily 09:00 JST. Next run 2026-12-05 09:00 JST.

If only `intent` or `output_path` changed (no cadence shift), do not
announce a "next run" line — the next firing is unchanged.

---

## Stop

Hard-deletes the row. The `recurring_schedules` row cascade-deletes
via FK and any pending `agent_schedule` rows for the old cron are
cancelled. History is preserved entirely in `agent_actions`
(`action_type='management_task.deleted'`) and `md_file_snapshots` —
there is no soft-stop placeholder in the file.

### Step 1 — Locate the row

Same lookup as Modify. **Never stop more than one row in a single
turn.** A bulk stop ("stop all gmail tasks") requires explicit
confirmation per row.

If no row matches, DM:

> No managed task for `<app>` is registered.

### Step 2 — Confirm (Notify tier — destructive)

DELETE is **Notify tier** AND removes a recurring commitment the
user themselves set up. Both safety invariants demand a real DM
confirmation. **Never auto-stop.**

> Stop `mt_42` Zoom check (daily 10:00 JST · last run ok 3 new)? It
> won't auto-resume.

If the user declines, stop. If they amend ("actually just make it
weekly"), route to §Modify instead — do not stop and re-register on
their behalf.

The "last run" line in the confirmation matters: a row that has been
silently failing (`consecutive_failures ≥ 3`) is exactly the kind
the user is most likely stopping by mistake. Surface `last_result`
so they can make an informed call.

### Step 3 — DELETE /api/managed-tasks/:id

```bash
curl -sS -X DELETE http://localhost:8321/api/managed-tasks/mt_42
```

**Server-side**: the daemon runs the atomic tx (snapshot the row,
DELETE `managed_tasks` cascading to `recurring_schedules`, cancel
pending fires, audit) + re-renders the file — you do not touch it.

The pre-delete row snapshot (`agent_actions.detail.original_row`)
plus the `md_file_snapshots` row is the recovery surface — for
audit / debug only, never the user-facing DM.

### Step 4 — Confirm to user

One DM:

> Stopped `mt_42` Zoom check. The row is gone from the registry; ask
> me to register a new one any time.

`state/activity/<source>.md`'s "Recently changed (90d)" section
auto-updates within ~10 s. You do NOT touch that file.

---

## Run once (off-schedule)

When the user asks to fire an existing `mt_<n>` immediately ("run
`mt_42` now", "trigger the gmail triage right away") **without**
modifying the schedule:

```bash
curl -sS -X POST http://localhost:8321/api/managed-tasks/mt_42/run-now
```

Success is `202 {status:"queued", mt_id, scheduled_row_id}` — the
route enqueues a one-shot `agent_schedule` row that runs the same
task-flow as a scheduled fire; the next regular firing is unaffected.
There is no in-flight guard, so the fire always enqueues — do not
fire it in a loop yourself.

Confirm to user with one DM after the fire enqueues:

> Triggered `mt_42` now (off-schedule). It runs alongside the regular
> 10:00 JST slot.

---

## Error envelope

Every error is the daemon envelope
(`{ok:false, summary, errors:[…], retryable, error?}`). Verbs (POST /
PATCH / DELETE / run-now), codes (`validation_error`, `duplicate`,
`cap_reached`, `invalid_id`, `not_found`, `internal_error`), and the
Idempotency-Key contract are in the errors reference below.

{{> ref:errors }}

---

## What this skill does NOT do

- Does NOT PUT `policies/management.md` (or INSERT `recurring_schedules`)
  directly — the only legal write is the `/api/managed-tasks` chokepoint;
  the daemon owns the file write and the FK pair.
- Does NOT mutate `app` through PATCH — a different connector is a
  different commitment; stop + re-register.
- Does NOT silently re-register on retry — use `Idempotency-Key`
  per-DM; conflicts surface the existing `mt_id`.
- Does NOT register a task with no probe-passing connector — probe
  failure is a hard stop.
- Does NOT delete entity files produced by past runs on stop — those
  stay where written; the DELETE only removes the row + its recurring
  schedule.
- Does NOT bulk-stop without per-row confirmation. "Stop all gmail
  tasks" is one DM round-trip per row.

## API surface

| Verb + path | Used in |
|---|---|
| `GET /api/context/policies/management` | Register Step 1 (read §A + §B) |
| `GET /api/entities?source=<app>` | Register Step 4a (output-path bias) |
| `GET /api/managed-tasks` / `/api/managed-tasks/:id` | Locate row (Modify / Stop Step 1; Register Step 1 alternate) |
| `POST /api/managed-tasks` | Register Step 6 (Notify tier; daemon DMs confirmation) |
| `PATCH /api/managed-tasks/:id` | Modify Step 4 (Notify tier) |
| `DELETE /api/managed-tasks/:id` | Stop Step 3 (Notify tier; destructive) |
| `POST /api/managed-tasks/:id/run-now` | Run once (off-schedule) |
| `POST /api/notify` | User-facing confirmations (your own DM-to-user replies) |

Every state-changing call writes one `agent_actions` row and
snapshots the file — do NOT post a separate audit event yourself.
