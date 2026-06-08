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
updated: 2026-06-08
keywords:
  - API
  - REST
  - endpoint
  - Hono
  - PA_API_PORT
  - bearer token
  - /api
  - /api/context
  - /api/wiki
  - /api/browser-history
  - /api/browser-task
related:
  - reference/config
  - reference/disallowed-tools
  - features/integrations/browser-history
  - features/operations/managed-chromium
---

# API Reference

The daemon serves a single Hono app on `127.0.0.1:PA_API_PORT` (default
`8321`). Almost all endpoints are mounted under `/api/*`; the lone
exception is the GitHub webhook receiver, mounted at root `/webhook/github`.
**Source of truth:** `packages/daemon/src/api/server.ts` (`createApp`)
registers most route groups, with one post-compose mount in
`packages/daemon/src/bootstrap/api.ts` (the docs corpus + docs-QA, wired
only after the indexer handle exists). Each group lives in its own file
or directory under `packages/daemon/src/api/routes/`.

## Auth

A bearer token is generated at first launch and stored in the OS
keychain. The dashboard reads it via the daemon proxy; external
callers pass it as `Authorization: Bearer <token>`.

## Route Groups

### Memory and observations

| Group | Path | Source | Purpose |
|---|---|---|---|
| Context | `/api/context/*` | `context/` | The ONLY legal write path for context Markdown — the agent uses curl into this endpoint, never `Edit`/`Write`. Canonical paths are class-prefixed: `/api/context/state/today`, `/api/context/plans/roadmap`, `/api/context/journal/agent` (legacy bare paths like `/api/context/today.md` still resolve via an in-process alias layer). |
| Observations | `/api/observations/*` | `observations.ts` | Phase 9 pending / consume; also the in-turn POST target for native-mode integration connectors. |
| FS | `/api/fs/*` | `fs.ts` | Sandboxed filesystem reads. |
| Knowledge | `/api/knowledge/*` | `knowledge.ts` | Knowledge-file import / export. |

### Agent control

| Group | Path | Source | Purpose |
|---|---|---|---|
| Agent | `/api/agent/*` | `agent.ts` | `run-now` (accepts `requestedModel: sonnet\|opus`), `regenerate`, `notify`, `schedule`, `schedule/dm`. Note: `POST /api/escalate` is **removed** — it returns HTTP 410 Gone; trigger Opus explicitly via `POST /api/agent/run-now {requestedModel:'opus'}`. |
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
| Voice | `/api/voice/*` | `voice.ts` | Whisper model install / status / weight-removal opt-in surface for the dashboard. |

### Integrations

| Group | Path | Source | Purpose |
|---|---|---|---|
| Mail | `/api/mail/*` | `mail/` | Multi-provider mail proxy (Gmail / Outlook / Yahoo / iCloud / IMAP) + FTS5 local search. |
| Calendar | `/api/calendar/*` | `calendar.ts` | Google Calendar proxy. |
| Apple Calendar | `/api/apple-calendar/*` | `apple-calendar.ts` | macOS Calendar.app bridge. |
| Notion | `/api/notion/*` | `notion.ts` | Notion proxy. |
| Obsidian | `/api/obsidian/*` | `obsidian.ts` | Obsidian vault proxy. |
| Git | `/api/git/*`, `/api/git-accounts/*` | `git.ts`, `git-accounts.ts`, `git-templates.ts` | Read-only git proxy (`/api/git/{log,diff,show}`), repo templates (`/api/git/templates/*`), and git-account CRUD (`/api/git-accounts/*`). |
| Repositories | `/api/repositories/*` | `repositories.ts` | Unified repository CRUD (replaces split Git/GitHub settings). |
| GitHub | `/api/github/*`, `POST /webhook/github` | `github.ts` | GitHub proxy and webhook receiver (mounted under `/`, not `/api`). |
| Integrations | `/api/integrations/*` | `integrations/`, `integrations-reconcile.ts` | Integration mode CRUD (`direct \| delegated \| native \| disabled`), live probe endpoint, mode reconciliation. |
| Delegated sync | `/api/delegated/*`, `/api/delegated-sync/*` | `delegated.ts`, `delegated-sync.ts` | Delegated worker control + opt-in cadence config. |
| MCP | `/api/mcp/*` | `mcp.ts` | Per-session MCP materializer. |

### Browser history and managed Chromium

| Group | Path | Source | Purpose |
|---|---|---|---|
| Browser history | `/api/browser-history/*` | `browser-history.ts` | Visit timeline, reload signals (`/reloads/today`, `/reloads/weekly`), research clusters CRUD. |
| Browser history (managed) | `/api/browser-history-managed/*` | `browser-history-managed.ts` | Managed-Chromium history surfacing. |
| Browser task | `/api/browser-task`, `/api/browser-task/:id*` | `browser-task.ts` | Managed-Chromium browser-task surface — create a task (`POST /api/browser-task`), poll status, stream events, fetch screenshots, mid-task `clarify`, `cancel`. Mounted unconditionally (the runner is wired separately). |
| Browser automation sites | `/api/browser-automation/sites/*` | `browser-automation-sites.ts` | Per-site opt-in / experimental-danger ack (`connect`, `status`, `finalize`, `reauth`, `disconnect`). |
| Browser automation purchase / B-4 | `/api/browser-automation/purchase-tokens`, `/api/browser-automation/b4/*` | `browser-automation-purchase.ts` | B-4 purchase-confirmation flow (single-use `!~xxxxxxxx` token, screenshot-first consent, 5-min timeout). Default-off — master toggle `runtime_state.managed_chromium.b4_enabled` ships `false`. |

### Lifestyle

| Group | Path | Source | Purpose |
|---|---|---|---|
| Receipts | `/api/receipts/*` | `receipts.ts` | Receipt CRUD. |
| Books | `/api/books/*` | `books.ts` | Reading-list CRUD. |
| Travel bookings | `/api/travel-bookings/*` | `travel-bookings.ts` | Travel-booking CRUD. |

### Feedback learning

All three routes are `RiskTier.Autonomous`. `POST /api/feedback` server-restricts `source` to `explicit` / `self_critique` — `behavioral` signals are daemon-only (written by `SignalDetector`) and a `behavioral` body returns 400.

| Group | Path | Source | Purpose |
|---|---|---|---|
| Feedback | `POST /api/feedback` | `feedback.ts` | Record an explicit or self-critique feedback signal. Dedups on `(scope_type, scope_ref, summary)` within 10 min. When `feedbackLearningEnabled=false` returns `200 {disabled:true}` without recording. |
| Feedback consume | `POST /api/feedback/consume` | `feedback.ts` | `{ids: number[], lessonRef?}` → `{consumed, notFound}`. Marks signals consumed after a consolidation pass. |
| Feedback lessons | `GET /api/feedback/lessons` | `feedback.ts` | Read-only lesson-store overview for the dashboard — global `agent` store plus every per-agent store on disk, with cap-utilisation metrics. |

### Docs and wiki

| Group | Path | Source | Purpose |
|---|---|---|---|
| Docs | `/api/docs/*` | `docs.ts` | Docs corpus search + QA pipeline. Mounted in `bootstrap/api.ts` (not `server.ts`) once the indexer handle is ready. |
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

Every endpoint carries a `RiskTier` from
`packages/daemon/src/safety/risk-classifier.ts`. The enum has three
values (the former **notify** tier was abolished daemon-wide — Approve
now covers everything that used to be Notify):

- **autonomous** — safe to execute without any auth or notification.
- **read_sensitive** — touches personal data (email, calendar, notes,
  context files); gated by `X-Read-Token` or Bearer auth when
  `enforceReadToken=true`.
- **approve** — requires explicit user approval (Bearer token).

At boot, `auditRiskClassifications(app.routes)` (called in `server.ts`)
checks for routes with no explicit classification. It does **not** abort
boot — unclassified routes fall back to the Approve default (so they
require Bearer auth) and a warning is logged only when the unclassified
set changes from the previous boot.

## Related

- [Config](config.md)
- [Disallowed Tools](disallowed-tools.md)
- [Browser History](../features/integrations/browser-history.md)
- [Managed Chromium](../features/operations/managed-chromium.md)
