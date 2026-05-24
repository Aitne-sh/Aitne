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
  Aitne's daemon serves a Hono HTTP API on PA_API_PORT (default 8321).
  This page is a high-level map of route groups; the source of truth is
  the route registrations in packages/daemon/src/api/server.ts and the
  per-route files under packages/daemon/src/api/routes/.
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
  - What's the API surface for browser history?
  - How do I list registered backends?
locale: en-US
created: 2026-04-25
updated: 2026-05-22
keywords:
  - API
  - REST
  - endpoint
  - Hono
  - PA_API_PORT
  - bearer token
  - /api
  - /api/wiki
  - /api/browser-history
  - /api/browser-automation
related:
  - reference/config
  - reference/disallowed-tools
  - features/integrations/browser-history
  - features/operations/managed-chromium
---

# API Reference

The daemon serves a single Hono app on `PA_API_PORT` (default
`8321`). All endpoints are mounted under `/api/*`. **Source of truth:**
`packages/daemon/src/api/server.ts` registers every route group, and
each group lives in its own file under
`packages/daemon/src/api/routes/`.

## Auth

A bearer token is generated at first launch and stored in the OS
keychain. The dashboard reads it via the daemon proxy; external
callers pass it as `Authorization: Bearer <token>`.

## Route Groups

### Memory and observations

| Group | Path | Source | Purpose |
|---|---|---|---|
| Context | `/api/context/*` | `context.ts` | The ONLY legal write path for context Markdown — the agent uses curl into this endpoint, never `Edit`/`Write`. |
| Observations | `/api/observations/*` | `observations.ts` | Phase 9 pending / consume; also the in-turn POST target for native-mode integration connectors. |
| FS | `/api/fs/*` | `fs.ts` | Sandboxed filesystem reads. |
| Knowledge | `/api/knowledge/*` | `knowledge.ts` | Knowledge-file import / export. |

### Agent control

| Group | Path | Source | Purpose |
|---|---|---|---|
| Agent | `/api/agent/*` | `agent.ts` | `run-now`, `regenerate`, `notify`, `schedule`, `schedule/dm`. |
| Recurring schedules | `/api/recurring-schedules/*` | `recurring-schedules.ts` | Recurring schedule CRUD. |
| Schedule options | `/api/schedule/*` | `schedule-options.ts` | Schedule option helpers for the dashboard. |
| Managed tasks | `/api/managed-tasks/*` | `managed-tasks.ts` | Long-running operator tasks. |
| Triggers | `/api/triggers/*` | `triggers.ts` | Trigger CRUD for repository management. |
| Backends | `/api/backends/*` | `backends.ts` | Backend / process-config CRUD, chat binding resolver, `PUT /api/backends/main`, `POST /api/backends/apply-defaults`. |
| Skills | `/api/skills/*` | `skills.ts` | Skill metadata. |
| Skill curation | `/api/skill-curation/*` | `skill-curation.ts` | P22 skill self-optimization overlays. |
| Task flows | `/api/task-flows/*` | `task-flows.ts` | Task-flow template introspection. |
| Profile questions | `/api/profile-questions/*` | `profile-questions.ts` | User-interview question queue. |
| Activity sources | `/api/activity-sources/*` | `activity-sources.ts` | Activity feed sources. |
| Entities | `/api/entities/*` | `entities.ts` | Entity registry CRUD. |
| SoT bindings | `/api/sot-bindings/*` | `sot-bindings.ts` | Source-of-truth bindings (vault ↔ daemon). |
| Voice | `/api/voice/*` | `voice.ts` | Voice transcript cache + transcribe-on-demand. |

### Integrations

| Group | Path | Source | Purpose |
|---|---|---|---|
| Mail | `/api/mail/*` | `mail.ts`, `mail-search.ts` | Multi-provider mail proxy (Gmail / Outlook / Yahoo / iCloud / IMAP) + FTS5 local search. |
| Calendar | `/api/calendar/*` | `calendar.ts` | Google Calendar proxy. |
| Apple Calendar | `/api/apple-calendar/*` | `apple-calendar.ts` | macOS Calendar.app bridge. |
| Notion | `/api/notion/*` | `notion.ts` | Notion proxy. |
| Obsidian | `/api/obsidian/*` | `obsidian.ts` | Obsidian vault proxy. |
| Git | `/api/git/*` | `git.ts`, `git-accounts.ts`, `git-templates.ts` | Git accounts, templates, watcher state. |
| Repositories | `/api/repositories/*` | `repositories.ts` | Unified repository CRUD (replaces split Git/GitHub settings). |
| GitHub | `/api/github/*`, `POST /webhook/github` | `github.ts` | GitHub proxy and webhook receiver (mounted under `/`, not `/api`). |
| Integrations | `/api/integrations/*` | `integrations.ts`, `integrations-reconcile.ts` | Integration mode CRUD (`direct \| delegated \| native \| disabled`), live probe endpoint, mode reconciliation. |
| Delegated sync | `/api/delegated/*`, `/api/delegated-sync/*` | `delegated.ts`, `delegated-sync.ts` | Delegated worker control + opt-in cadence config. |
| MCP | `/api/mcp/*` | `mcp.ts` | Per-session MCP materializer. |

### Browser history and managed Chromium

| Group | Path | Source | Purpose |
|---|---|---|---|
| Browser history | `/api/browser-history/*` | `browser-history.ts` | Visit timeline, reload signals (`/reloads/today`, `/reloads/weekly`), research clusters CRUD. |
| Browser history (managed) | `/api/browser-history-managed/*` | `browser-history-managed.ts` | Managed-Chromium history surfacing. |
| Browser automation | `/api/browser-automation/*` | `browser-automation.ts` | Managed-Chromium session control (default-off, per-site opt-in). |
| Browser automation sites | `/api/browser-automation/sites/*` | `browser-automation-sites.ts` | Per-site opt-in / experimental-danger ack. |
| Browser automation purchase | `/api/browser-automation/purchase/*` | `browser-automation-purchase.ts` | B-4 purchase-confirmation flow (single-use `!~xxxxxxxx` token, screenshot-first consent, 5-min timeout). |

### Lifestyle

| Group | Path | Source | Purpose |
|---|---|---|---|
| Receipts | `/api/receipts/*` | `receipts.ts` | Receipt CRUD. |
| Books | `/api/books/*` | `books.ts` | Reading-list CRUD. |
| Travel bookings | `/api/travel-bookings/*` | `travel-bookings.ts` | Travel-booking CRUD. |

### Docs and wiki

| Group | Path | Source | Purpose |
|---|---|---|---|
| Docs | `/api/docs/*` | `docs.ts` | Docs corpus + QA pipeline. |
| Wiki | `/api/wiki/*` | `wiki.ts` | Wiki workspaces, files, search (FTS5), reindex, estimate, compile preview. |
| Attachments | `/api/attachments/*` | `attachments.ts` | DM attachment proxy. |

### Dashboard, lifecycle, telemetry

| Group | Path | Source | Purpose |
|---|---|---|---|
| Dashboard | `/api/dashboard/*` | `dashboard/` | Config PATCH, events, conversations, cost, approvals, messaging pairing, Google OAuth. |
| Setup | `/api/setup/*` | `setup.ts`, `setup-migrate.ts` | Setup-wizard endpoints and execution-mode toggles. |
| Commands | `/api/commands/*` | `commands.ts` | User bang-command CRUD (`/settings/commands`). |
| System | `/api/system/*` | `system.ts` | Daemon system info. |
| Health | `/api/health` | `health.ts` | Liveness + integration mode summary + backend auth state. |
| Metrics | `/api/metrics` | `metrics.ts` | Daemon metrics. |
| SSE | `/api/chat/stream`, `/api/events/stream` | `sse.ts` | SSE streams for chat tokens and event feed. |

## Wiki — selected write/read endpoints

All wiki routes require an `x-process-key` header. Search and read
accept DM-tier keys (`message.dm`, `message.mention`,
`dashboard.chat`); writes and operator-level endpoints require `wiki.*`
keys.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/wiki/:ws/search?q=<term>&kind=fts\|grep&layer=<l>&limit=<n>` | Search the workspace. Default `kind=fts` (SQLite FTS5). `kind=grep` is the substring fallback; empty queries automatically fall back to grep so callers can enumerate the vault. |
| POST | `/api/wiki/:ws/reindex` | Operator escape hatch — rebuild the FTS5 index from disk. Requires a wiki-tier process key. |
| GET | `/api/wiki/:ws/compile/preview?mode=incremental\|full` | Dry-run preview of `!compile`. Returns the predicted touch set (added / modified / unchanged), scaled cost estimate, and ETA. No agent session runs. |
| GET | `/api/wiki/:ws/estimate?strategy=per-file\|flat` | Cost estimate for `!compile full`. Default `per-file` returns a token-level estimate (script-aware char→token approximation) with a top-N breakdown; `flat` returns the legacy P2 heuristic. |

## Risk classification

Every write endpoint carries a `RiskTier` from
`packages/daemon/src/safety/risk-classifier.ts`:

- **read** — autonomous.
- **notify** — agent can act after DMing the owner.
- **approve** — requires a bearer token plus an explicit approval.

The startup audit fails the boot if any registered route is unclassified
(`auditRiskClassifications(app.routes)` in `server.ts`).

## Related

- [Config](config.md)
- [Disallowed Tools](disallowed-tools.md)
- [Browser History](../features/integrations/browser-history.md)
- [Managed Chromium](../features/operations/managed-chromium.md)
