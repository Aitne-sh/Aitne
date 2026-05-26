---
name: scheduled-managed-task
description: A `scheduled.task` session with `task_context.mt_id` matching `mt_<n>`; `task_context.adhoc === true` marks on-demand pulls. SKIP for regular scheduled tasks, DM-tone scheduled sessions (`scheduled.dm`), or one-off reminder delivery.
allowed-tools:
  - Bash(curl *)
  - Read
---

# Scheduled Managed-Task Run

This skill is the **scheduled execution** half of the management
registry. The DM-side counterpart — the `managed-tasks` skill
(`## Register` / `## Modify` / `## Stop` / `## Run once`) — owns the
row's lifecycle. This skill is what fires every cron slot to actually
do the work.

## When this skill activates

Auto-loaded when the dispatcher routes a `scheduled.task` event whose
`task_context.mt_id` matches `^mt_[1-9]\d*$`. The `mt_id` field in
`task_context` is the contract between the managed-tasks route and
this skill — both the recurring fire (`POST /api/managed-tasks` →
`recurring_schedules` → `agent_schedule`) and the on-demand fire
(`POST /api/managed-tasks/:id/run-now`) populate it. The
`task_context.adhoc === true` boolean (also set by the on-demand
route) signals which one you're in.

If `task_context.mt_id` is absent, this is **not** a managed-task
run — fall through to the regular `scheduled.task` flow per
`scheduled.task.md`.

## Algorithm (mirror of design 21 §10.4)

### Step 0 — Identify the row

Pull `mt_<n>` from `task_context.mt_id`. When `task_context.adhoc ===
true`, this run came from `POST /api/managed-tasks/:id/run-now` — the
row's `last_run_at` IS updated, but the audit row gets tagged
`adhoc:true` so the activity-view reconciler can distinguish it. The
`task_context.reason` field (from the run-now body) is a free-text
hint about why the user pulled.

### Step 1 — Read the row

```bash
curl -s "http://localhost:8321/api/managed-tasks/mt_43" | jq .item
```

The route wraps the row in `{item:<ManagedTask>}`. Relevant fields on
`item`:

```jsonc
{
  "id":             "mt_43",
  "intent":         "Zoom recordings → meeting entity",
  "app":            "zoom",
  "app_normalized": "zoom",
  "cadence":        "daily 10:00 (Asia/Tokyo)",
  "output_path":    "work/meetings/",   // may be null on first run
  "schedule_id":    17,
  "last_run_at":    "2026-12-04T10:00:00Z",
  "last_result":    "ok (3 new)",
  "consecutive_failures": 0
}
```

If the GET returns 404, the row was stopped between schedule firing
and skill invocation. End the session quietly — the daemon's audit
records the orphan firing.

### Step 2 — Select tool (LLM judgment, fresh each run)

Same rule as the `managed-tasks` skill's `## Register` Step 3:
enumerate the tools available to this session and pick by capability for
`item.app`. The user's prior choice (when surfaced as a hint in
`task_context.lastToolChoice` by an earlier run) is a **hint**, not
a binding — if it no longer exists in this session (the user
reinstalled MCPs, the backend rotated), pick afresh.

- **Zero plausible** → record `last_result='failed: connector
  unavailable'`; the three-strikes rule (§10.4 step 6) handles
  user-facing notification. Stop.
- **Multiple plausible AND no hint** → record `last_result='failed:
  ambiguous tool selection'`; the next on-demand DM lets the user
  disambiguate. Stop.
- **One plausible OR hint resolves** → continue.

NEVER hardcode tool names — see ADR §8.4 / FR-4.

### Step 3 — Invoke with `since = last_run_at`

Issue the smallest read that returns "everything new since
`last_run_at`". For most apps that is a `since` / `updated_after` /
`q: "after:<ISO>"` parameter. If the tool only exposes a `limit`,
fetch a generous page and filter client-side.

For an `.adhoc` run with no explicit `since` from the user, default
to `now − 24h` (safety: don't pull months on a manual fire).

If the tool returns an error, record `last_result='failed: <verbatim
error>'` and stop. The 3-strikes rule (Step 6) governs notifications.

### Step 4 — Resolve each new datum to an entity (§7.6 lookup contract)

For every new item the tool returned, decide *which* `<domain>/<type-plural>/<slug>.md`
file to merge it into. Lookup precedence is **strict** — fall through
in order:

#### 4.1 Exact `(source_key, external_id)` match

```bash
curl -s "http://localhost:8321/api/entities?source=zoom&external_id=zm_xyz789" | jq .
```

If 1 result, that's the entity. Reuse its `path`. This is the
strongest signal and guarantees no duplicates when the upstream app
exposes a stable id.

If >1 result the mirror is corrupted — record
`last_result='failed: entity-mirror conflict'` and stop. The boot
reconciler converges from the L2 files.

#### 4.2 Fallback: `(domain, type, date, fuzzy title)` within ±48 h

```bash
curl -s "http://localhost:8321/api/entities?domain=work&type=meeting&date=2026-12-04&q=foo+1on1" | jq .
```

The daemon does the fuzzy match server-side (token-overlap on
`title`). If 1 confident result, reuse. If >1 confident result, pick
the one whose `sources.<other_app>.*` already overlaps with this
datum's metadata (e.g. a Calendar entity already bound to the same
attendees → that's the right meeting).

#### 4.3 Otherwise: allocate a new entity

Decide `(domain, type)` from the datum shape. **Bias toward the row's
`output_path`** when present — it encodes the user's intent for this
managed task:

```
output_path = "work/meetings/"  →  domain=work, type=meeting
output_path = "finance/receipts/" → domain=finance, type=receipt
```

If `output_path` is null (first run), pick the best `(domain, type)`
from the data shape using the same prior table from the `managed-tasks`
skill `## Register` Step 4a. After this run, write the chosen path back
to the row (Step 5b) so subsequent runs converge.

Slug: `<YYYY-MM-DD>-<sanitized-title>`. Sanitization rules:
lowercase, ASCII-fold, replace `[^a-z0-9-]+` with `-`, collapse
runs of `-`, trim leading/trailing `-`, cap at 64 chars. The slug
must match `^[a-z0-9][a-z0-9-]*$` per §9.3 EntitySchema.

### Step 5a — Merge into the entity file

For each resolved entity:

```bash
curl -sS -X PATCH "http://localhost:8321/api/context/work/meetings/2026-12-04-foo-1on1" \
  -H 'Content-Type: application/json' \
  -d @- <<'JSON'
{
  "section": "Zoom Notes",
  "mode":    "append",
  "content": "- duration 60 min\n- recording: <link>\n- external_id: zm_xyz789\n- transcript snippet: …\n"
}
JSON
```

The daemon's section-append `mode:"append"` adds the lines under the
named `## Zoom Notes` heading; the heading itself is stable across
runs. The (`section`, `mode`, `content`, `cutoff`, `maxEntries`)
shape is the contract today — see `contextPatchSchema` in
`packages/shared/src/schemas.ts`.

**Source-id capture (write the `external_id` into the body lines):**
the entity-mirror watcher (P5) reparses the file's frontmatter on
change, so the dedup contract in §7.6 hinges on the upstream id
landing in **frontmatter**, not just the body. Until the entity-mirror
reconciler ships AND the context API gains a `frontmatter*` patch
mode for `<domain>/<type-plural>/*` files, do this:

1. Always include `- external_id: <id>` on its own line in the
   appended `## <App> Notes` body so a future reconciler-rebuild can
   recover the binding from prose.
2. Track the binding in the §B "Recently changed" path — the
   `agent_actions.management_task.run_recorded` row's `detail` is
   structured and survives even when the file body doesn't reflect
   the binding cleanly.

> **Implementation gap to flag** (Phase 5 / extended Phase 3): the
> context PATCH route does not currently:
>   - allow writes under `<domain>/<type-plural>/*` (no entry in
>     `CONTEXT_WRITE_PERMISSIONS`), so this PATCH returns `403
>     forbidden` until the whitelist is widened, and
>   - expose a `frontmatterMerge` mode for deep-merging
>     `frontmatter.sources.<app>`.
> Both are required by design 21 §10.4 step 4b and must land before
> this Step 5a goes from "designed" to "operational". Until then,
> Step 5b's audit row is the durable trace of the run — surface that
> in the activity-view rather than relying on the entity body.

If the entity file does not previously exist, today's API requires a
PUT with full content (the `<domain>/<type-plural>/*` write path is
gated by the same whitelist note above). When the gap closes, the
first PATCH must include a complete frontmatter block — `type`,
`domain`, `slug`, `title`, `created`, `sources` — or the daemon
returns 422 against `EntitySchema`.

### Step 5b — Update the row

The user-facing PATCH (`/api/managed-tasks/:id`) is **immutable** for
`last_run_at` / `last_result` / `consecutive_failures` by design — those
fields are written by this skill through a dedicated internal endpoint
so the user-facing surface and the run-result surface have separate
schemas and risk-tier intents.

```bash
# Success path
curl -sS -X PATCH http://localhost:8321/api/managed-tasks/mt_43/run-result \
  -H 'Content-Type: application/json' \
  -d '{"last_run_at":"2026-12-04T10:00:00Z","last_result":"ok (3 new)","consecutive_failures":0}'

# Failure path — explicit count, NOT an increment flag
curl -sS -X PATCH http://localhost:8321/api/managed-tasks/mt_43/run-result \
  -H 'Content-Type: application/json' \
  -d '{"last_run_at":"2026-12-04T10:00:00Z","last_result":"failed: <reason>","consecutive_failures":<prev+1>}'
```

`managedTaskRunResultSchema` is **replace-semantics** for
`consecutive_failures` — read the previous value from Step 1's
response and send the next integer (`prev + 1` for failures, `0` for
success). There is no `consecutiveFailuresIncrement` flag.

**Output-path back-fill.** If `output_path` was null going in and you
allocated entities under one consistent `<domain>/<type-plural>/`,
relocate it via the user-facing PATCH **after** the run-result PATCH
(two writes — the schemas don't overlap):

```bash
curl -sS -X PATCH http://localhost:8321/api/managed-tasks/mt_43 \
  -H 'Content-Type: application/json' \
  -d '{"output_path":"work/meetings/"}'
```

The two-step write is intentional — the user-facing PATCH emits a
`management_task.modified` audit row with `from`/`to`, which is the
right signal for "the agent learned the path on its own". Combining
both into `/run-result` would hide the path change in a less specific
audit shape.

If the run produced a mix of domains/types (e.g. Drive PDFs that were
half receipts and half random docs), leave `output_path` null — let
the next run try again. The renderer marks null-path rows in §B with
an em-dash; the user can also set the path explicitly via the
`managed-tasks` skill `## Modify` flow.

### Step 6 — Three-strikes notify

The design (§10.4 step 6) places the 3-strikes notify on the daemon
side: the `/run-result` route should auto-enqueue a `POST /api/notify`
when the post-update `consecutive_failures` crosses the threshold,
keeping the agent out of the user-paging loop and centralizing the
threshold (`managementFailureNotifyThreshold`, default 3).

**Implementation status:** the daemon does NOT currently emit this
notify — `/api/managed-tasks/:id/run-result` records the run and
re-renders the file but stops there. Until the daemon closes the
gap, **this skill is the safety net**: after Step 5b's failure-path
PATCH, if the post-update `consecutive_failures` you computed is ≥ 3
AND was < 3 before this run (i.e. the *crossing*, not every
subsequent failure), call:

```bash
curl -sS -X POST http://localhost:8321/api/notify \
  -H 'Content-Type: application/json' \
  -d '{
    "message":  "Managed task mt_43 has failed 3 consecutive runs: <reason>. The schedule remains active. Stop or modify it via DM.",
    "priority": "normal"
  }'
```

The crossing-edge condition is critical — DM-ing on every failure
once over the threshold would spam the user. Trip on the transition
3-to-now-3, never on 4 → 4 / 5 → 5 / etc.

The schedule is **never auto-stopped** — see ADR-flavored note in
§10.4: "Auto-stop would silently lose user intent. Notify-then-defer-
to-user honors 'destructive ops require user confirmation'." So the
agent keeps trying, but doesn't disappear silently.

### Step 7 — End the session

`scheduled.task` flow's "Output contract — your final text becomes a
DM" applies (`scheduled.task.md`). For managed-task runs the default
is **empty final text**: bookkeeping is invisible by design. The user
sees the change reflected in `state/activity/<source>.md` (auto-built) and
`<domain>/_index.md`, not in a chat ping per fire.

Exceptions:

- The `notify` skill's awareness gate fired *during* this run — e.g.
  the new datum is a meeting starting in 15 min. Then call
  `/api/notify` and keep the final text empty (a follow-up "Sent"
  line is duplicate noise per `scheduled.task.md`).
- `last_result='failed: ...'` with `consecutive_failures < 3` — final
  text empty; the activity view records it; the user is not paged.
- `last_result='failed: ...'` at the threshold crossing — Step 6 fired
  the `/api/notify`; final text empty.

NEVER write a `## Agent Plan` row for a managed-task run — managed
tasks are not the same as Agent Plan rows. The Agent Plan loop close
in `scheduled.task.md` Step 4 is for DM-originated tasks, not for
`mt_<n>` correlated firings. Skip Steps 1 / 4 of `scheduled.task.md`
when this skill is the executing skill.

## Idempotency

A scheduled fire that crashes mid-run leaves the row's
`last_run_at` un-updated. The next slot picks up the same `since`
window and re-fetches the same data — the entity-mirror's
`(source_key, external_id)` lookup makes this a **merge**, not a
duplicate. The PATCH body is content-additive: a section appended
twice with the same content is harmless because Step 5a's
`frontmatterMerge` is deep, and the section-append mode is
"add this block as-is" (the daemon de-duplicates exact-string-match
sections with the same heading on append). For sources without a
stable `external_id`, use Step 4.2's date+title window — at the cost
of occasional dedup misses, never duplicates by construction.

## Caps

`output_path` validation, app-string length, intent length all carry
through from §13.3. The daemon enforces them at PATCH time; if the
fetched data violates them (rare — usually upstream titles too long),
truncate the offending field and surface a one-line warning in the
appended `## <App> Notes` body, not as a separate DM.

## Error envelope

| HTTP | `error` | What to do |
|---|---|---|
| 400 (`/api/managed-tasks/:id/run-result`) | `invalid_id` / `validation_error` | Body shape drift — re-check field names exactly match `last_run_at` / `last_result` / `consecutive_failures` |
| 403 (`/api/context/<domain>/<type-plural>/...`) | `forbidden` | Entity-domain write paths are not yet whitelisted (Phase 5 gap, §Step 5a). Skip the entity merge for this run, still record run-result, and surface a one-line warning in `last_result`. |
| 404 (`/api/managed-tasks/:id`) | `not_found` | Row was stopped mid-run. End the session quietly. |
| 422 (`/api/context/...`) | `validation_error` | Frontmatter incomplete or malformed; populate all required fields and retry once |
| 422 (`/api/managed-tasks/:id`) | `validation_error` | Path / body shape rejected; drop the offending field (typically `output_path`) and retry once with the rest |
| 5xx | `internal_error` | Record `last_result='failed: <body.message>'` via Step 5b's failure form and end the session |

## What this skill does NOT do

- Does NOT post `/api/notify` for routine successes (silent by design).
- Does NOT post `/api/notify` for routine failures (final text empty).
  The exception is the 3-strikes crossing — see Step 6: until the
  daemon owns the threshold notify, the agent emits one DM at the
  3rd consecutive failure, then stays silent until success or stop.
- Does NOT touch the §B row's `app` or `cadence` — those are
  user-mutable only via the `managed-tasks` skill `## Modify` flow.
- Does NOT INSERT `agent_schedule` rows. The cron scheduler does.
- Does NOT delete entity files when a tool returns "this item was
  removed upstream". Removal-from-source is recorded as a
  `frontmatter.sources.<app>.deleted_at` annotation, not a file
  delete (the user's notes might still be valuable).
- Does NOT call any skill outside the read-only context API + the
  selected backend tool. Specifically: no `management-task-*`
  variant, no `schedule` mutation, no `roadmap` write.
- Does NOT include the row's `output_path` change in Step 5b unless
  the run actually produced data confirming the path. Speculative
  back-fill is forbidden.

## API summary

| Verb + path | Used in |
|---|---|
| `GET /api/managed-tasks/:id` | Step 1 (response wraps row in `{item}`) |
| `GET /api/entities?source=&external_id=` | Step 4.1 (tier-1 exact) |
| `GET /api/entities?source=` | Step 4 bias hint (list-by-source-key) |
| `GET /api/entities?domain=&type=&date=&q=` | Step 4.2 (tier-2 fuzzy) |
| `GET /api/entities/by-path?path=` | Step 4 (verify before merging) |
| `PATCH /api/context/<domain>/<type-plural>/<slug>` | Step 5a (gated by entity-domain write whitelist — Phase 5 gap) |
| `PATCH /api/managed-tasks/:id/run-result` | Step 5b (internal — last_run_at / last_result / consecutive_failures) |
| `PATCH /api/managed-tasks/:id` | Step 5b output-path back-fill only |
| `POST /api/notify` | Step 6 (only on the 3-failures-in-a-row crossing edge) |

The PATCH on `/api/managed-tasks/:id/run-result` writes one
`agent_actions` row (`management_task.run_recorded`); the §B render
and snapshot are the daemon's job. Do NOT post a separate audit
event.
