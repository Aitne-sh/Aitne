---
name: notion
description: Load when the task touches Notion AND Notion is in native mode bound to Claude (`nativeBackend === "claude"`). Use the in-session Notion connector directly; the daemon does not proxy Notion. `/api/notion/databases` (label → UUID dump) is the only daemon route still reachable.
allowed-tools:
  - Bash(curl *)
  - Read
---

# Notion (native — in-session Notion connector)

> **Refusal directive — read first.** Notion is in `native` mode bound
> to Claude. Do **NOT** call any of:
>
> - `POST /api/integrations/notion/exec` (returns `409 mode_mismatch`
>   in native mode — this route is NOT route-gated and carries no
>   `X-Integration-Mode` header; `/exec` only succeeds in `delegated`
>   mode)
> - `POST /api/integrations/notion/reconcile` (not route-gated either;
>   an LLM-issued notion reconcile returns `400 validation_error` on the
>   window-key allowlist, which is calendar-only)
> - `/api/notion/query`, `/api/notion/search`, `/api/notion/pages`,
>   `/api/notion/pages/<id>/content` (each route-prefix returns `410`
>   with `X-Integration-Mode: native` — these ARE route-gated)
>
> Reach Notion through the in-session Notion connector your harness
> exposes. Your tool menu lists every available tool at session start
> — pick the Notion one.
>
> The one exception: **`GET /api/notion/databases`** remains reachable
> in every mode. It is a config dump (label → UUID map) with no Notion
> API side-effect; native-mode gating does not apply to it.

Confirm the binding via `<integration_modes>` (`notion="native"`) and
the `<integration-routing-table>` block in the session preamble.

## 1. Label resolution — read `/api/notion/databases` first

Database UUIDs are unstable; user-facing labels (`"projects"`,
`"meeting-notes"`, `"tasks"`) map to UUIDs through the daemon's
settings store. Resolve label → UUID BEFORE any Notion call so the
connector arguments carry concrete UUIDs.

```bash
curl -s http://localhost:8321/api/notion/databases
# → { "databases": { "<label>": { "id": "<uuid>", "title": "..." }, ... } }
```

This route is **not** part of the absolute deny set and is intentionally
ungated in native mode — the agent reads the same labels in every mode.
Notion page fetch typically accepts either a page URL or a UUID; pass
the UUID resolved here.

## 2. Notion — in-session connector

The exact tool names depend on which Notion connector your harness has
loaded. Inspect your tool menu at session start and pick the matching
capability.

### Read-class capabilities

| Capability | What to do |
|---|---|
| `search` | Workspace search (text + Notion query parameters), optionally filtered to a specific data source. |
| `read` | Retrieve a single page / database / block by URL or UUID; returns content + child block tree. |
| `comments` | Read comments on a page. |
| `users` | Enumerate workspace users. |
| `teams` | Enumerate teams / teamspaces. |

Canonical search flow:

1. Resolve the database label → UUID via `/api/notion/databases` (§1).
2. Invoke your connector's search function with the user's query, the
   data-source URL constructed from the resolved UUID, and the
   `internal` query-type when targeting a known database.

Canonical page read: invoke your connector's fetch / read-page function
with the page's URL or UUID.

### Destructive capabilities (require explicit user confirmation)

Per the registry's
`notion.backendConnectors.claude.destructiveTools`, the following
capability classes are destructive in native:claude mode:

- **Page creation** — adds new pages.
- **Page update** — mutates properties / content; **also** the archive
  workaround (Status="Archived") — §3 below.
- **Page duplicate** — clones a page.
- **Page move** — relocates pages between databases / parents.
- **Comment create** — posts a comment (user-visible).
- **Database create** — schema admin (creates new DB).
- **Data-source update** — schema admin (mutates DB columns).
- **View create / update** — schema admin (new view / mutates view config).

Apply the destructive-confirm contract every time:

1. Summarise the plan in one line.
2. Surface verbatim and wait for explicit user OK.
3. On OK, issue the call.

Schema-admin capability classes (database create, data-source update,
view create / update) are higher stakes than page mutations — explicitly
name "this is a schema-admin change" in the plan you surface.

The starter `deniedTools` list (typically denies the schema-admin set)
is enforced before the call lands. The absolute-block layer continues
to fire regardless of mode.

## 3. Page archive — workaround only

Hosted Notion connectors typically do **not** expose an archive / trash
tool. `in_trash` is rejected as a property by the page-update function.
To "archive" a page:

1. **Property workaround** (preferred when the page lives in a
   database with a Status property): update the page's Status property
   to "Archived". The page stays addressable but drops out of default
   views.
2. **Move to a "Trash" page**: move the page under a top-level "Trash"
   page (creating it first via page-creation if absent). Reversible
   without admin intervention.

Surface either option to the user before issuing — they are
explicitly user-visible workarounds, not silent archive equivalents.

## 4. Structured database filtering

For "what tasks are in status X" or any `WHERE <property> = ...`
intent, use your connector's search function with a data-source filter
and let the connector do the matching. The hosted Notion connector
typically does not expose a SQL-style query primitive (Codex's
`notion_query_data_sources` covers that gap when delegated
cross-backend; native-Claude has the search-with-filter primitive
instead).

## 5. Decision rules

- **Hourly check is read-only.** Native variants inherit the
  "External services are read-only this hour" constraint from
  `routine.hourly_check.native.claude.md`. No creates, property
  updates, content patches, or archives during the hourly pass.
- **Mass-update — ask first.** A page-creation call can take up to
  100 pages in one shot, and move / update batches can touch many
  rows. Summarise and confirm any change that would touch more than
  ~10 pages.
- **Schema admin — Approve-tier.** Database / view / data-source
  mutations alter workspace structure. Surface explicitly and ask;
  do not auto-confirm "this looks right".
- **Comments are user-visible.** Posting a page comment is treated
  like a send: confirm before issuing.

## 6. Persisting observations from native fetches

When `routine.hourly_check.native.claude.md`'s Step 0c fetches recent
Notion edits, POST each materialised page to `/api/observations`. The
daemon computes `contentHash` server-side via
`@aitne/shared/observations-hash.ts`; pass `payload` verbatim.

**Batch when you have more than one page.** Use
`POST /api/observations/batch` with up to 200 items in one
`observations[]` array (see the `observations` skill for the envelope).
The single-item form below is for the rare "one page changed" case.

```bash
curl -s -X POST http://localhost:8321/api/observations \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "notion:<workspaceId>",
    "ref": "<pageId>",
    "changeType": "created",
    "actor": "agent",
    "payload": <verbatim connector page object>
  }'
```

`actor` MUST be `"agent"` or `"system"` — the server rejects `"user"`.

`/api/observations` is never gated. HTTP 409 indicates a mode-flip
race window (§11.3.1); stop and re-read `<integration_modes>`.

## 7. Owner notification (opt-in)

The daemon does not auto-DM the owner. When a Notion action is
user-visible enough to warrant an immediate awareness ping (a
public comment, a mass-archive operation, content moved out of a
long-lived database), call:

```bash
curl -s -X POST http://localhost:8321/api/notify \
  -H 'Content-Type: application/json' \
  -d '{"message": "Archived 7 stale pages under the <db> database."}'
```

Single page edits and routine reads do not need a notify.

## 8. Cost / audit

Native connector calls land `agent_actions` rows of type `mcp_call`
with `provider="claude"`, the tool name, and the parent `event_id` /
`processKey`. The cost dashboard joins these to the registry by
`toolNamespace` prefix for the `nativeAttribution` rollup (§14.4).
