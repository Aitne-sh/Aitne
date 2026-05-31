---
name: mail-acquire.outlook_mail
description: Acquire an Outlook Mail message window per <acquisition-plan> row.
spec: docs/design/appendices/routine-data-acquisition.md §6.8 / §8.2
---

# Outlook Mail acquisition

For every `<fetch integration="outlook_mail" ...>` row in `<acquisition-plan>`,
take the branch below that matches the row's `mode` attribute.

**Account attribution.** In `direct` mode each row carries
`account="<accountId>"` — apply the query against THAT account only. In
`delegated-same` / `delegated-cross` / `native` modes the daemon emits a
single row WITHOUT an `account` attribute (the bound MCP authenticates as
one user); substitute the literal string `default` wherever the observation
contract below references `<accountId>`. The `userManagedConnector`
collapse (see below) means `delegated-cross` never carries an account
either.

Outlook Mail is a **user-managed** integration: the daemon has no
delegation proxy for it (no `/api/integrations/outlook_mail/exec` exists).
The four non-disabled branches therefore split into two real flows:

- `direct` → the unified daemon mail route (transparently handles Outlook
  accounts).
- `delegated-same`, `delegated-cross`, `native` → use the in-session
  connector surface your skills document. The user picks the binding (an
  in-session connector, a local CLI invoked via a skill, a custom script);
  this partial states the intent, not specific tool names. If no surface
  is bound, record an error and continue.

Submit every returned message — for a whole window in **one** call — via the
`mcp__aitne-observations__submit_observations` MCP tool when it is in your
allowed tools (preferred — the structured MCP transport carries
Unicode-bearing subjects / snippets that would deterministically trip
`curl … -d '{…}'` on the SDK's bash preflight). Build the tool input as
`{"observations":[…]}` with one entry per message.

If the MCP tool is unavailable (non-Claude session backend), fall back to
`POST http://localhost:8321/api/observations/batch` with the same envelope:

```json
{"observations":[
  {"source":"outlook_mail:<accountId>","ref":"<messageId>","changeType":"created","actor":"agent",
   "payload":{"kind":"mail","providerId":"<accountId>","raw":{"subject":"…","from":"…","snippet":"…","date":"…"}}},
  …
]}
```

Field rules per element:

- `source`     = `"outlook_mail:<accountId>"` (use `"outlook_mail:default"`
  when the `<fetch>` row has no `account` attribute — see Account
  attribution above)
- `ref`        = provider-side stable message id
- `changeType` = `"created"` for fresh items; `"modified"` when the row
  updates a payload already known under `(source, ref)`
- `actor`      = `"agent"`
- `payload`    = `{ "kind": "mail", "providerId": "<accountId>", "raw": {
                    "subject": ..., "from": ..., "snippet": ...,
                    "date": ... } }` (providerId is `"default"` when no
                    `account` attribute)

The server computes the dedup hash from `(source, payload)`. The MCP tool
and the batch endpoint return the same envelope: `{ "results": [...],
"fetched": N, "posted": N, "duplicates": N, "errors": N }`. Per-item
`results[*].status`:

- `"created"` / `"modified"` — rolled into `posted`.
- `"duplicate"` — rolled into `duplicates`.
- `"flip_locked"` — append
  `{type:"flip-locked","integration":"outlook_mail","account":"<accountId>"}`
  (use `"default"` when no `account` attribute) to `errors` and
  continue; do not retry inline.
- `"validation_error"` — append
  `{type:"validation-error","integration":"outlook_mail","account":"<accountId>","ref":"<ref>","detail":"<results[*].error>"}`
  to `errors` and continue.

Cap each batch at 200 entries — split the window into multiple
`submit_observations` (or POST) calls if the upstream returns more than that.

<!-- mode:direct:outlook_mail -->
GET `http://localhost:8321/api/mail/<accountId>/messages<query>` where
`<query>` is the literal `query` attribute of the `<fetch>` row (e.g.
`?since=2026-05-11T00:00:00.000Z&limit=20` or
`?folder=sent&since=2026-05-11T00:00:00.000Z&limit=30`). The route
accepts `since` (ISO 8601), `limit`, `folder`, `q`, `unreadOnly` — it
does NOT accept `days=…`. The daemon returns `{ "messages": [...] }`
regardless of the underlying provider; map every message into the
`observations[]` array of a single `submit_observations` MCP tool call
(or `POST /api/observations/batch` fallback).
<!-- /mode:direct:outlook_mail -->

<!-- mode:delegated-same:outlook_mail -->
The integration is bound to your own session backend. Use the in-session
connector surface your skills document for Outlook Mail. The `<fetch>`
row's `query` attribute carries the catalog's `delegated` form (e.g.
`filter=receivedDateTime ge 2026-05-11T00:00:00Z`) — translate it into the
args your bound surface accepts. POST every returned message as specified
above.

If no Outlook Mail surface is bound on this backend, append
`{"type":"no-surface","integration":"outlook_mail","account":"<accountId>"}` (use `"default"` when no `account` attribute)
to your `errors` array and continue with the next row. Do NOT halt the
pre-pass; the parent routine continues with whatever observations the rest
of the plan produced.
<!-- /mode:delegated-same:outlook_mail -->

<!-- mode:delegated-cross:outlook_mail -->
Outlook Mail is user-managed, so the daemon does not host a delegation
proxy. The dispatcher should not have emitted a `delegated-cross` row for
this integration — if you see one, treat it exactly like
`delegated-same`: use whichever in-session surface your skills document
for Outlook Mail. If nothing is bound, append
`{"type":"no-surface","integration":"outlook_mail","account":"<accountId>"}` (use `"default"` when no `account` attribute)
to `errors` and continue.
<!-- /mode:delegated-cross:outlook_mail -->

<!-- mode:native:outlook_mail -->
The integration is bound natively to your own session backend. Use the
in-session connector surface your skills document for Outlook Mail —
same call shape as `delegated-same`. The daemon does not proxy.

If no Outlook Mail surface is bound, append
`{"type":"no-surface","integration":"outlook_mail","account":"<accountId>"}` (use `"default"` when no `account` attribute)
to `errors` and continue.
<!-- /mode:native:outlook_mail -->

<!-- mode:disabled:outlook_mail -->
Defensive no-op. The dispatcher filters disabled integrations out of
`<acquisition-plan>`. If a `<fetch integration="outlook_mail">` row still
reaches this branch, skip it and append
`{"type":"unexpected-row","integration":"outlook_mail","reason":"disabled-row-emitted"}`
to your `errors` array.
<!-- /mode:disabled:outlook_mail -->
