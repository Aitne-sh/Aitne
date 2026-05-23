---
schema_version: 1
slug: reference/api
title: API Reference
id: api-ref
aliases:
  - api reference
  - rest api
  - http api
  - daemon api
category: reference
summary: |
  Aitne's daemon serves a Hono HTTP API on PA_API_PORT
  (default 8321). This is a high-level map; the source of truth is
  the route registrations in packages/daemon/src/api/server.ts.
section: api
tags:
  - reference
  - api
  - core
  - operations
status: stable
ask_examples:
  - What endpoints does the daemon expose?
  - How do I read context files via API?
locale: en-US
created: 2026-04-25
updated: 2026-05-16
keywords:
  - API
  - REST
  - endpoint
  - Hono
  - PA_API_PORT
  - bearer token
  - /api
  - /api/wiki
related:
  - reference/config
---

# API Reference

| Group | Path | Purpose |
|---|---|---|
| Context | `/api/context/*` | Read / write context Markdown files. |
| Agent | `/api/agent/*` | run-now, regenerate, schedule, notify. |
| Backends | `/api/backends/*` | Backend / process-config CRUD. |
| Calendar | `/api/calendar` | Calendar proxy. |
| Mail | `/api/mail` | Multi-provider mail proxy. |
| Obsidian | `/api/obsidian` | Obsidian vault proxy. |
| Notion | `/api/notion` | Notion proxy. |
| Git / GitHub | `/api/git`, `/api/github` | Git / GitHub proxies. |
| Skills | `/api/skills` | Skill metadata. |
| Reading | `/api/books` | Reading list CRUD. |
| Lifestyle | `/api/receipts`, `/api/travel-bookings` | Lifestyle data. |
| Docs | `/api/docs/*` | Docs corpus + QA pipeline. |
| Wiki | `/api/wiki/*` | Wiki workspaces, files, search (FTS5), index, estimate, compile preview, reindex. |
| Dashboard | `/api/dashboard/*` | Dashboard config + state. |
| SSE | `/api/chat/stream`, `/api/events/stream` | SSE streams. |
| Health | `/api/health`, `/api/metrics` | Daemon liveness / metrics. |
| Setup | `/api/setup/*` | Setup wizard endpoints. |

Auth: bearer token written to the OS keychain at first launch.

## Wiki — Phase 4 endpoints

All wiki routes require an `x-process-key` header. Search and read endpoints accept DM-tier keys (`message.dm`, `message.mention`, `dashboard.chat`); writes and operator-level endpoints require `wiki.*` keys.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/wiki/:ws/search?q=<term>&kind=fts\|grep&layer=<l>&limit=<n>` | Search the workspace. Default `kind=fts` (SQLite FTS5). `kind=grep` is the legacy substring fallback; empty queries automatically fall back to grep so callers can enumerate the vault. |
| POST | `/api/wiki/:ws/reindex` | Operator escape hatch: rebuild the FTS5 index from disk. Requires a wiki-tier process key. |
| GET | `/api/wiki/:ws/compile/preview?mode=incremental\|full` | Dry-run preview of `!compile`. Returns the predicted touch set (added / modified / unchanged), scaled cost estimate, and estimated duration. No agent session runs. |
| GET | `/api/wiki/:ws/estimate?strategy=per-file\|flat` | Cost estimate for `!compile full`. Default `per-file` returns a token-level estimate (script-aware char→token approximation) with a top-N breakdown; `flat` returns the legacy P2 heuristic. |

## Related

- [Config](config.md)
