---
name: notion-acquire.notion
description: Acquire recently-updated Notion pages per <acquisition-plan> row.
spec: docs/design/appendices/routine-data-acquisition.md §6.8 / §8.5
---

# Notion acquisition

For every `<fetch integration="notion" ...>` row in `<acquisition-plan>`,
take the branch below that matches the row's `mode` attribute. Notion rows
do not fan out per account — the dispatcher emits one row per workspace.

Submit every returned page — for a whole window in **one** call — via the
`mcp__aitne-observations__submit_observations` MCP tool when it is in your
allowed tools (preferred — the structured MCP transport carries
Unicode-bearing titles that would deterministically trip `curl … -d '{…}'`
on the SDK's bash preflight). Build the tool input as
`{"observations":[…]}` with one entry per page.

If the MCP tool is unavailable (non-Claude session backend), fall back to
`POST http://localhost:8321/api/observations/batch` with the same envelope:

```json
{"observations":[
  {"source":"notion:<workspaceId>","ref":"<pageId>","changeType":"created","actor":"agent",
   "payload":{"kind":"notion","providerId":"<workspaceId>","raw":{"title":"…","last_edited":"…","parent":"…","url":"…"}}},
  …
]}
```

Field rules per element:

- `source`     = `"notion:<workspaceId>"` (use `"default"` when the daemon
  reports no explicit workspace id)
- `ref`        = Notion page id (stable UUID)
- `changeType` = `"created"` for fresh pages; `"modified"` when the
  payload updates an existing `(source, ref)`
- `actor`      = `"agent"`
- `payload`    = `{ "kind": "notion", "providerId": "<workspaceId>",
                    "raw": { "title": ..., "last_edited": ...,
                             "parent": ..., "url": ... } }`

The server computes the dedup hash from `(source, payload)`. The MCP tool
and the batch endpoint return the same envelope: `{ "results": [...],
"fetched": N, "posted": N, "duplicates": N, "errors": N }`. Per-item
`results[*].status`:

- `"created"` / `"modified"` — rolled into `posted`.
- `"duplicate"` — rolled into `duplicates`.
- `"flip_locked"` — append `{type:"flip-locked","integration":"notion"}`
  to `errors` and continue.
- `"validation_error"` — append `{type:"validation-error","integration":"notion","ref":"<ref>","detail":"<results[*].error>"}`
  to `errors` and continue.

Cap each batch at 200 entries — split the window into multiple
`submit_observations` (or POST) calls if the upstream returns more than that.

<!-- mode:direct:notion -->
GET `http://localhost:8321/api/notion/search<query>` where `<query>` is
the literal `query` attribute of the `<fetch>` row (e.g.
`?page_size=50&sort=descending` or `?page_size=20&sort=descending`).
The route accepts `q`, `type`, `sort` (`ascending` / `descending`),
`page_size` (≤100), `start_cursor` — it has NO time filter, so do the
window cutoff client-side. The daemon returns `{ "results": [...] }`
sorted by `last_edited_time` descending; filter to entries whose
`last_edited_time` is at or after the window the `<fetch>` row's
window symbol implies (`updated_24h` → today's agent-day start,
`updated_1h` → the current hour boundary), then map every surviving
page into the `observations[]` array of a single `submit_observations`
MCP tool call (or `POST /api/observations/batch` fallback).
<!-- /mode:direct:notion -->

<!-- mode:delegated-same:notion -->
The connector is bound to your own session backend. Use the in-session
connector surface your skills document for Notion; the `<fetch>` row's
`query` attribute carries the catalog's `delegated` form
(e.g. `last_edited_time>=<iso>`). Translate it into the args your bound
surface accepts. The Notion MCP `notion-search` tool caps `page_size`
at **25** — page through with `start_cursor` if the window needs more.
POST every returned page as specified above.
<!-- /mode:delegated-same:notion -->

<!-- mode:delegated-cross:notion -->
The connector is bound to a different backend than this session — reach
it through the daemon's delegation proxy. POST to
`http://localhost:8321/api/integrations/notion/exec` with the following
body (substitute the row's `query` into `task`):

```json
{
  "task": "Search Notion for pages with last_edited_time matching <query>. Return id, title, last_edited, parent, url for each page. Up to 50 pages.",
  "outputSchema": {
    "type": "object",
    "required": ["pages"],
    "properties": {
      "pages": {
        "type": "array",
        "items": {
          "type": "object",
          "required": ["id"],
          "properties": {
            "id":          { "type": "string" },
            "title":       { "type": "string" },
            "last_edited": { "type": "string" },
            "parent":      { "type": "string" },
            "url":         { "type": "string" }
          }
        }
      }
    }
  },
  "maxToolCalls": 3,
  "cacheable": true
}
```

Map all items in `result.pages[]` into a single `submit_observations`
MCP tool call (or `POST /api/observations/batch` fallback).
<!-- /mode:delegated-cross:notion -->

<!-- mode:native:notion -->
The connector is bound natively to your own session backend. Use the
in-session connector surface your skills document — same call shape as
`delegated-same`. The Notion MCP `notion-search` tool caps `page_size`
at **25** — page through with `start_cursor` if the window needs more.
The daemon does not proxy. POST every returned page as specified above.
<!-- /mode:native:notion -->

<!-- mode:disabled:notion -->
Defensive no-op. The dispatcher filters disabled integrations out of
`<acquisition-plan>`. If a `<fetch integration="notion">` row still
reaches this branch, skip it and append
`{"type":"unexpected-row","integration":"notion","reason":"disabled-row-emitted"}`
to your `errors` array.
<!-- /mode:disabled:notion -->
