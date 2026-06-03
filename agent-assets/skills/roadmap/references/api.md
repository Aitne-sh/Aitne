---
kind: reference
name: api
description: roadmap.md-specific layering on top of /api/context/* — lock endpoints, ID-mint, transition guard, duplicate-id retry recipe.
---

# roadmap.md API — specific rules

The generic GET / PUT / PATCH surface lives in the **context** skill's
`references/api.md`. The rules below are the roadmap-specific layer.

## Lock — `roadmap_write_lock_id`

| Action | Verb | Path |
|---|---|---|
| Acquire | `POST` | `/api/context/lock/roadmap` |
| Release | `DELETE` | `/api/context/lock/roadmap` (body `{"lockId":"…"}`) |

The dispatcher auto-acquires this lock for `routine.roadmap_refresh`
and exposes the id via `<roadmap_write_lock_id>` in the prompt
context. Other flows (DM handler, evening sweeper) may acquire and
release manually.

Include `X-Lock-Id: <roadmap_write_lock_id>` on every PUT / PATCH to
`/api/context/plans/roadmap` when the tag is in your context. Other
sessions get `409 roadmap_write_lock_held` while the lock is held —
back off 30 s and retry up to 3 times.

### Path-name gotchas

These return `404 {"error":"unknown_route", …}` with a hint pointing
at the correct path:

- `POST /api/context/plans/roadmap/lock` — order reversed
- `POST /api/context/plans/roadmap/write-lock` — order reversed and wrong noun
- `POST /api/context/lock/roadmap-write` — wrong noun

A `401 {"error":"unauthorized"}` from a path you believe is correct
means the path is still wrong (the lock endpoints are Autonomous-tier
so no bearer token is required).

## ID mint — `POST /api/context/plans/roadmap/id`

```bash
curl -s -X POST http://localhost:8321/api/context/plans/roadmap/id \
  -H 'Content-Type: application/json' \
  -H 'X-Lock-Id: <roadmap_write_lock_id>' \
  -d '{"creationDate":"YYYY-MM-DD"}'
```

Returns `{"id":"rm-YYYYMMDD-<6hex>"}`. Use the returned value as the
`<!-- id: ... -->` HTML comment on a new entry. Never invent the
6-hex suffix in prose.

When promoting a Long-term Plans line into Agent Action Plan, transfer
the existing id to the new `###` heading and remove the original line
— do NOT mint a fresh id (the journal trail would break).

## ID uniqueness + transition guard

The roadmap API validates two invariants on every PUT / PATCH:

1. **Uniqueness.** Every `<!-- id: rm-* -->` is unique within the
   file. Duplicate ids return:

   ```json
   {"ok":false,"errors":[{"code":"context.content_validation_failed"}],"error":"validation_error","message":"Duplicate roadmap entry id `rm-YYYYMMDD-abcdef` (first seen on line N).","path":"roadmap.md"}
   ```

   Recovery: re-GET `roadmap`, mint a fresh id **for the colliding
   new entry only**, retry the PUT / PATCH once. If the same error
   fires twice, abort and surface the message to the user — something
   in the pipeline is double-emitting.

2. **Transition guard.** If an entry id survives from previous → next
   content, every prior `completed …` row for that id must still
   exist byte-for-byte. If a completed prep row that existed before is
   gone — dropped or reworded, since a reword no longer matches
   byte-for-byte — the write returns:

   ```json
   {"ok":false,"errors":[{"code":"context.content_validation_failed"}],"error":"validation_error","message":"Completed Preparation Timeline row for entry `rm-…` was dropped.","path":"roadmap.md"}
   ```

   This is intentional: completed prep rows are the audit trail for
   what the agent actually did. Edit only forward-looking rows.

If an entry id disappears entirely between previous → next, removal
is accepted only when:

- The entry's retention window has elapsed (see the **retention**
  reference loaded by the skill body), OR
- The operator passes the `X-Operator-Bypass: 1` header (dashboard
  flows only; never set this from an agent curl).

A removal before the retention window permits it returns:

```json
{"ok":false,"errors":[{"code":"context.content_validation_failed"}],"error":"validation_error","message":"Roadmap entry `rm-…` was removed before its retention window permits removal.","path":"roadmap.md"}
```

Do not blind-retry this — wait out the window or use the operator
bypass from a dashboard flow.

## Body submission

- Full PUT body is multi-KB → use the heredoc shape
  (`-d @- <<'JSON'`) per `_safety.md` "Daemon-API body submission".
- Section PATCH bodies are small → inline `-d '{...}'`.
- ID-mint POST is small → inline `-d '{"creationDate":"…"}'`.
