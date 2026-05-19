---
name: notion
description: Load when the user mentions Notion or the agent needs to read, query, search, create, update, or archive Notion pages and databases. Mail is in `mail`; Calendar / external Obsidian / GitHub in `external-services`; scheduling in `schedule`.
allowed-tools:
  - Bash(curl *)
  - Read
---

# Notion API Reference

Output language: Notion property **names** are Policy A — never translate them; pass them through verbatim as the database defines them. Property **values** and page body content are Policy C (`<settings primary_language>`). See `<output_language_policy>`.

Base URL: `http://localhost:8321`. All calls via `curl -s` with
`Content-Type: application/json` on POST/PATCH/PUT. URL-encode spaces in paths.

Full CRUD over Notion pages plus workspace search. Reads and writes are
Autonomous; writes are still serialized per-process and pre-marked
`notion:<pageId>` for write attribution. The daemon does not DM the
owner before a write — the user's `deniedTools` setting is the gate.
Call `POST /api/notify` yourself when you judge the user would
want immediate awareness.

**Parent shorthand**: `parent` accepts a label string (`"tasks"`),
`{ database: "tasks" }`, `{ data_source_id }`, `{ database_id }`, or
`{ page_id }`. Resolve labels via `GET /api/notion/databases` first.

## Read operations

```bash
curl -s http://localhost:8321/api/notion/databases                          # list configured DBs
curl -s "http://localhost:8321/api/notion/query?database=tasks"             # query a database
curl -s "http://localhost:8321/api/notion/query?database=tasks&filter=..."  # filtered (URL-encoded JSON)
curl -s "http://localhost:8321/api/notion/search?q=launch+plan"             # search workspace
curl -s http://localhost:8321/api/notion/pages/abc123...                    # retrieve page
```

Pagination: `page_size` (1–100, default 20) + `start_cursor` from response's
`next_cursor`. Check `has_more` to know if more pages exist.

## Create a page (write — Autonomous)

```bash
curl -s -X POST http://localhost:8321/api/notion/pages \
  -H 'Content-Type: application/json' \
  -d '{"parent": "tasks", "properties": {"Name": {"title": [{"text": {"content": "Review roadmap"}}]}, "Status": {"status": {"name": "Todo"}}}, "markdown": "## Context\n\nDetails."}'
```

## Update page properties (write — Autonomous)

```bash
curl -s -X PATCH http://localhost:8321/api/notion/pages/abc123... \
  -H 'Content-Type: application/json' \
  -d '{"properties": {"Done": {"checkbox": true}, "Status": {"status": {"name": "Done"}}}}'
```

## Update page content (write — Autonomous)

**Concurrency warning**: Notion v5 has no etags. If another client edits
between GET and PATCH, `oldStr` may fail silently. For high-risk edits,
prefer `mode=replace_all`.

Modes: `append`, `replace_all`, `update` (find-and-replace via
`updates: [{oldStr, newStr}]`).

```bash
curl -s -X PATCH http://localhost:8321/api/notion/pages/abc123.../content \
  -H 'Content-Type: application/json' \
  -d '{"mode": "append", "content": "\n## Follow-ups\n- Call vendor"}'
```

## Archive a page (write — Autonomous)

```bash
curl -s -X DELETE http://localhost:8321/api/notion/pages/abc123...
```

Moves to trash (~30 days). Restore via `PATCH` with `{ "in_trash": false }`.

## When NOT to act

- During `routine.hourly_check` this skill is **read-only** — no creates,
  property updates, content patches, or archives.
- No bulk operations without user confirmation. If you're about to update
  3+ pages at once, stop and ask the user first.
- Writes are Autonomous; the daemon does not DM the owner. Single ops
  only — the agent's own judgment is the gate, not the daemon. The
  message-discipline contract for any `POST /api/notify` call you issue
  here is in the `notify` skill — do not invent ad-hoc phrasing rules.
