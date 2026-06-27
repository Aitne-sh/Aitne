---
name: notion-acquire.notion
description: Acquire recently-updated Notion pages per <acquisition-plan> row.
spec: docs/design/appendices/routine-data-acquisition.md §6.8 / §8.5
---

# Notion acquisition

For every `<fetch integration="notion" ...>` row in `<acquisition-plan>`,
take the branch below that matches the row's `mode` attribute. Notion rows
do not fan out per account — the dispatcher emits one row per workspace.

Every Notion row MUST carry a `targets='[...]'` attribute. Treat it as the
user's allowlist of pages / notes the routine may inspect:

- Parse it as a JSON array of `{ "label": "...", "locator": "..." }`.
- `locator` may be a Notion page URL, page id, database item id, or page
  title. Prefer direct fetch by URL/id when the connector supports it. For a
  title locator, search only that exact title with the smallest supported
  page size and choose at most one best match.
- Never browse or page through the whole workspace. Do not use
  `start_cursor` for routine acquisition.
- Fetch at most one page per target and at most 10 pages per row. If more
  than 10 targets are present, process the first 10 and append
  `{"type":"target-cap","integration":"notion","cap":10}` to `errors`.
- After resolving targets, apply the row's time window cutoff
  (`updated_24h` / `updated_1h`) client-side and submit only pages whose
  `last_edited_time` is inside the window.

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
Resolve each allowlisted target against the daemon API — never the
`query` attribute's whole-window search shape:

- URL / id locator — extract the page id (the trailing 32-hex run of a
  Notion URL; dashed UUID form also accepted) and GET
  `http://localhost:8321/api/notion/pages/<id>?markdown=false`. The
  `markdown=false` flag returns metadata only (`lastEditedTime`, title,
  parent, url) without page content — the routine never needs the body.
- Title locator — GET
  `http://localhost:8321/api/notion/search?q=<title>&page_size=3&sort=descending`
  and keep at most the single best title match.

Do not pass `start_cursor` and do not issue an unfiltered
`/api/notion/search` call. Filter resolved pages by the row's window
symbol and map every surviving page into the `observations[]` array of a
single `submit_observations` MCP tool call (or
`POST /api/observations/batch` fallback).
<!-- /mode:direct:notion -->

<!-- mode:delegated-same:notion -->
The connector is bound to your own session backend. Use the in-session
connector surface your skills document for Notion; the `<fetch>` row's
`query` attribute carries the catalog's `delegated` form
(e.g. `last_edited_time>=<iso>`). Translate it into the args your bound
surface accepts, but restrict work to the `targets` allowlist. The Notion MCP
`notion-search` tool caps `page_size` at **25** — use `page_size=3` for title
resolution and never page through with `start_cursor`. POST every returned
allowlisted page as specified above.
<!-- /mode:delegated-same:notion -->

<!-- mode:delegated-cross:notion -->
The connector is bound to a different backend than this session — reach
it through the daemon's delegation proxy. POST to
`http://localhost:8321/api/integrations/notion/exec` with the following
body (substitute the row's `query` into `task`):

```json
{
  "task": "Resolve only the allowlisted Notion targets whose last_edited_time matches <query>. Return id, title, last_edited, parent, url for each page. Up to 10 pages. Do not paginate.",
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

Include the parsed target allowlist in `task` and instruct the delegated
backend to resolve only those pages, up to 10 pages total and with no
pagination. Map all items in `result.pages[]` into a single
`submit_observations` MCP tool call (or `POST /api/observations/batch`
fallback).
<!-- /mode:delegated-cross:notion -->

<!-- mode:native:notion -->
The connector is bound natively to your own session backend. Use the
in-session connector surface your skills document — same call shape as
`delegated-same`. Restrict work to the `targets` allowlist, use `page_size=3`
for title resolution, and never page through with `start_cursor`. The daemon
does not proxy. POST every returned allowlisted page as specified above.
<!-- /mode:native:notion -->

<!-- mode:disabled:notion -->
Defensive no-op. The dispatcher filters disabled integrations out of
`<acquisition-plan>`. If a `<fetch integration="notion">` row still
reaches this branch, skip it and append
`{"type":"unexpected-row","integration":"notion","reason":"disabled-row-emitted"}`
to your `errors` array.
<!-- /mode:disabled:notion -->
