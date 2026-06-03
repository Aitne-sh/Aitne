---
name: notion
description: Load when the task touches Notion AND Notion is in native mode bound to Gemini (`nativeBackend === "gemini"`). Use the Gemini Notion connector directly; daemon does not proxy Notion. `/api/notion/databases` (label → UUID dump) is the only daemon route still reachable.
allowed-tools:
  - Bash(curl *)
  - Read
---

# Notion (native — in-session Notion connector)

> **Refusal directive — read first.** Notion is in `native` mode bound
> to Gemini. Do **NOT** call any of:
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
> exposes (typically a user-installed Notion MCP server registered
> against the Gemini CLI). Your tool menu lists every available tool at
> session start — pick the Notion one.
>
> Exception: **`GET /api/notion/databases`** remains reachable in every
> mode (config dump, no Notion API side-effect).

## Connector presence assumption

Native:gemini mode assumes a Notion MCP server is registered against
the user's Gemini CLI. The §9.3 probe at flip time verifies every
required capability is reachable from the in-session tool menu; if the
probe fails (wrong server name, server not registered, or capabilities
missing), the dashboard surfaces an actionable hint and the mode does
not flip. This skill body assumes the probe passed.

Confirm the binding via `<integration_modes>` (`notion="native"`) and
the `<integration-routing-table>` block in the session preamble.

## 1. Label resolution — read `/api/notion/databases` first

```bash
curl -s http://localhost:8321/api/notion/databases
# → { "databases": { "<label>": { "id": "<uuid>", "title": "..." }, ... } }
```

Resolve label → UUID before any Notion call.

## 2. Notion — in-session connector

The exact tool names depend on which Notion MCP server the user has
registered against their Gemini CLI. Inspect your tool menu at session
start and pick the matching capability. Notion's official MCP server
exposes hyphenated identifiers (search / fetch / get-comments / …);
under Gemini's namespace convention they surface with a server prefix.
The capability classes below are stable across connectors; the exact
tool names depend on the server you have loaded.

### Read-class capabilities

| Capability | What to do |
|---|---|
| `search` | Workspace search (text + Notion query parameters), optionally filtered to a specific data source. |
| `read` | Retrieve a single page / database / block by URL or UUID; returns block tree. |
| `comments` | Read page comments. |
| `users` | Enumerate workspace users. |
| `teams` | Enumerate teams / teamspaces. |

Canonical search flow: invoke your connector's search function with
the user's text query and the data-source URL constructed from the
resolved UUID (e.g.
`https://www.notion.so/<workspace>/<database-uuid>`).

Canonical page read: invoke your connector's fetch / read-page
function with the page's URL or UUID.

### Destructive capabilities (require explicit user confirmation)

Per the registry's `notion.backendConnectors.gemini.destructiveTools`,
the following capability classes are destructive in native:gemini mode:

- **Page creation** — adds new pages (batch-aware on most connectors).
- **Page update** — mutates properties / content; **also** the archive
  workaround (Status="Archived") — §3 below.
- **Page duplicate** — clones a page.
- **Page move** — relocates pages between databases / parents.
- **Comment create** — posts a comment (user-visible).
- **Database create** — schema admin (creates new DB).
- **Data-source update** — schema admin (mutates DB columns).
- **View create / update** — schema admin (new view / mutates view
  config).

Apply the destructive-confirm contract every time. Schema-admin
capability classes warrant an explicit "schema admin" label on the
surfaced plan. The starter `deniedTools` list is enforced before the
call lands.

## 3. Page archive — workaround only

Same gap as Claude / Codex hosted connectors — typically no dedicated
archive tool. To "archive":

1. **Property workaround** (preferred): update the page's Status
   property to "Archived" via the page-update capability.
2. **Move to a "Trash" page**: relocate the page under a top-level
   "Trash" page via the page-move capability.

Surface the choice to the user.

## 4. Decision rules

- **Hourly check is read-only** — inherits the constraint from
  `routine.hourly_check.native.gemini.md`.
- **Mass-update — ask first.** Batch page-creation can take up to 100
  pages; batches >~10 pages warrant explicit confirmation.
- **Schema admin — Approve-tier.** Database / view / data-source
  mutations alter workspace structure.
- **Comments are user-visible.** Posting a page comment is treated
  like a send: confirm before issuing.
- **No SQL-style structured query on this surface.** Notion's official
  MCP server (the typical native:gemini connector) does not expose a
  structured-filter primitive equivalent to Codex's
  `query_data_sources`. For "what tasks are in status X" intents, use
  the workspace search capability with a data-source filter scoping
  the request and process the result client-side.

## 5. Persisting observations from native fetches

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

The daemon computes `contentHash` server-side. Pass `payload`
verbatim. `actor` MUST be `"agent"` or `"system"` — the server
rejects `"user"`. HTTP 409 → mode-flip race window (§11.3.1); stop
and re-read `<integration_modes>`.

## 6. Owner notification (opt-in)

```bash
curl -s -X POST http://localhost:8321/api/notify \
  -H 'Content-Type: application/json' \
  -d '{"message": "Archived 7 stale pages under the <db> database."}'
```

For public comments, mass archives, or content moved out of long-lived
databases. Routine reads and single-page edits do not need a notify.

## 7. Cost / audit

Native MCP calls land `agent_actions` rows of type `mcp_call` with
`provider="gemini"`, the tool name, and the parent `event_id` /
`processKey`. The cost dashboard joins these to the registry by
`toolNamespace` prefix (§14.4 `nativeAttribution`).
