---
name: mail-acquire.gmail
description: Acquire a Gmail message window per <acquisition-plan> row.
spec: docs/design/appendices/routine-data-acquisition.md §6.8 / §8.1
---

# Gmail acquisition

For every `<fetch integration="gmail" ...>` row in `<acquisition-plan>`, take
the branch below that matches the row's `mode` attribute and acquire the
window described by `query`.

**Account attribution.** In `direct` mode each row carries
`account="<accountId>"` — apply the query against THAT account only, do not
pool across accounts. In `delegated-same` / `delegated-cross` / `native` modes
the daemon emits a single row WITHOUT an `account` attribute because the
bound Gmail MCP authenticates as a single user; substitute the literal
string `default` wherever the observation contract below references
`<accountId>`. Never invent an accountId from the message body — `default`
is the canonical placeholder.

Submit every returned message — for a whole window in **one** call — via the
`mcp__aitne-observations__submit_observations` MCP tool when it is in your
allowed tools (preferred — the structured MCP transport carries
Unicode-bearing subjects/snippets that would deterministically trip
`curl … -d '{…}'` on the SDK's bash preflight). Build the tool input as
`{"observations":[…]}` with one entry per message; the response from the
upstream call IS the payload (do not summarise or rank).

If the MCP tool is unavailable (non-Claude session backend), fall back to
`POST http://localhost:8321/api/observations/batch` with the same envelope:

```json
{"observations":[
  {"source":"gmail:<accountId>","ref":"<messageId>","changeType":"created","actor":"agent",
   "payload":{"kind":"mail","providerId":"<accountId>","raw":{"subject":"…","from":"…","snippet":"…","date":"…"}}},
  …
]}
```

Field rules per element:

- `source`     = `"gmail:<accountId>"` (use `"gmail:default"` when the
  `<fetch>` row has no `account` attribute — see Account attribution above)
- `ref`        = provider-side stable message id
- `changeType` = `"created"` for fresh items; `"modified"` when the row updates
  a payload the server already has under the same `(source, ref)`
- `actor`      = `"agent"`
- `payload`    = `{ "kind": "mail", "providerId": "<accountId>", "raw": {
                    "subject": ..., "from": ..., "snippet": ...,
                    "date": ... } }` (providerId is `"default"` when no
                    `account` attribute)

Do NOT compute the dedup hash — the server derives it from `(source, payload)`.

The MCP tool and the batch endpoint return the same envelope: `{ "results":
[...], "fetched": N, "posted": N, "duplicates": N, "errors": N }`. Add each
field-count into your top-level totals. Per-item `results[*].status` values:

- `"created"`  / `"modified"` — fresh or updated row; rolled into `posted`.
- `"duplicate"` — identical pending row already exists; rolled into `duplicates`.
- `"flip_locked"` — a mode flip is draining for this integration. Append
  `{type:"flip-locked","integration":"gmail","account":"<accountId>"}`
  (use `"default"` when no `account` attribute) to your `errors` array
  and continue (the parent routine will retry on the next tick).
- `"validation_error"` — a malformed item slipped through. Append
  `{type:"validation-error","integration":"gmail","account":"<accountId>","ref":"<ref>","detail":"<results[*].error>"}`
  to `errors` and continue.

Cap each batch at 200 entries — split the window into multiple
`submit_observations` (or POST) calls if the upstream returns more than that.

<!-- mode:direct:gmail -->
GET `http://localhost:8321/api/mail/<accountId>/messages<query>` where
`<query>` is the literal `query` attribute of the `<fetch>` row (e.g.
`?since=2026-05-11T00:00:00.000Z&limit=20` or
`?since=2026-05-11T10:00:00.000Z&unreadOnly=true&limit=10` or
`?folder=sent&since=2026-05-11T00:00:00.000Z&limit=30`). The route
accepts `since` (ISO 8601 datetime), `limit`, `folder`, `q`,
`unreadOnly` — `days=…` is NOT recognised. The daemon returns
`{ "messages": [...] }`; map every message into the `observations[]`
array of a single `submit_observations` MCP tool call (or `POST
/api/observations/batch` fallback).
<!-- /mode:direct:gmail -->

<!-- mode:delegated-same:gmail -->
The Gmail connector is bound to your own session backend. Use the in-session
connector surface your skills document for this integration; the `<fetch>`
row's `query` attribute carries the catalog's `delegated` form (e.g.
`q="newer_than:1d" maxResults=20`) — translate it into the args your bound
surface accepts. POST every returned message as specified above. The daemon
does not proxy in this branch.
<!-- /mode:delegated-same:gmail -->

<!-- mode:delegated-cross:gmail -->
The connector is bound to a different backend than this session, so reach it
through the daemon's delegation proxy. POST to
`http://localhost:8321/api/integrations/gmail/exec` with the following body
(substitute the row's `query` into `task`). The `<fetch>` row in this mode
carries no `account` attribute — the proxy's bound MCP authenticates as a
single user, so the task is account-implicit:

```json
{
  "task": "Search Gmail with the query expression <query> and return id, subject, from, snippet, date for each message. Up to 30 messages.",
  "outputSchema": {
    "type": "object",
    "required": ["messages"],
    "properties": {
      "messages": {
        "type": "array",
        "items": {
          "type": "object",
          "required": ["id"],
          "properties": {
            "id":      { "type": "string" },
            "subject": { "type": "string" },
            "from":    { "type": "string" },
            "snippet": { "type": "string" },
            "date":    { "type": "string" }
          }
        }
      }
    }
  },
  "maxToolCalls": 3,
  "cacheable": true
}
```

Map all items in `result.messages[]` into a single `submit_observations`
MCP tool call (or `POST /api/observations/batch` fallback when the MCP
tool is not available).
<!-- /mode:delegated-cross:gmail -->

<!-- mode:native:gmail -->
The connector is bound natively to your own session backend. Use the
in-session connector surface your skills document — same call shape as
`delegated-same`. The daemon does not proxy. POST every returned message as
specified above.
<!-- /mode:native:gmail -->

<!-- mode:disabled:gmail -->
Defensive no-op. The dispatcher filters disabled integrations out of
`<acquisition-plan>`, so no `<fetch integration="gmail">` row should ever
land in this branch. If one does, skip it and append
`{"type":"unexpected-row","integration":"gmail","reason":"disabled-row-emitted"}`
to your `errors` array.
<!-- /mode:disabled:gmail -->
