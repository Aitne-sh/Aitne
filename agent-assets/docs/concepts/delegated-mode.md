---
schema_version: 1
slug: concepts/delegated-mode
title: Delegated Mode (Integration Modes)
id: delegated-mode
aliases:
  - delegated
  - direct mode
  - native mode
  - same-backend
  - cross-backend
  - integration delegation
category: concepts
summary: |
  Each integration (Gmail, Google Calendar, …) runs in one of four
  modes: direct (the daemon holds OAuth credentials and polls),
  delegated (the agent's backend connector holds them; the daemon syncs
  on opt-in cadences), native (the main backend's MCP connector reaches
  the integration on-demand; no daemon polling and no daemon-side
  proxy), or disabled. Under `delegated`, the agent reaches the
  integration through one of two paths depending on whether its DM
  session backend matches the connector's owner — same-backend (native
  MCP, no daemon involved) or cross-backend
  (`/api/integrations/:key/exec` task-mode proxy).
section: integrations
tags:
  - core
  - integrations
  - safety
  - skills
status: stable
ask_examples:
  - What's the difference between direct and delegated mode?
  - Why does Gmail work without my OAuth setup?
  - When does the daemon spawn another backend to handle a Gmail call?
  - Why don't I see a SKILL.md for Gmail in my Codex session?
locale: en-US
created: 2026-04-26
updated: 2026-05-17
keywords:
  - delegated mode
  - direct mode
  - native mode
  - same-backend
  - cross-backend
  - integrations.md
  - delegatedBackend
  - nativeBackend
  - SKILL.delegated
  - exec endpoint
related:
  - concepts/safety-model
  - concepts/skills
  - concepts/safety-and-execution
  - features/integrations/mail
ui_anchors:
  - /connections
  - /settings/models
config_keys:
  - integrations
---

# Delegated Mode (Integration Modes)

## TL;DR

Each integration is in one of four modes:

| Mode | Who holds credentials | What the agent calls |
|---|---|---|
| `direct` | Daemon (OAuth in macOS Keychain) | `curl /api/mail/*` / `curl /api/calendar/*` |
| `delegated` | The agent's backend connector (claude.ai / ChatGPT / Google) | Native MCP tools (same-backend) or the `/api/integrations/:key/exec` task-mode proxy (cross-backend) |
| `native` | The main backend's connector (no daemon credentials, no daemon poller) | Native MCP tools on the main backend; observations are POSTed to `/api/observations/batch` for the routine pre-pass |
| `disabled` | Nobody | Nothing — the integration is off |

Under `delegated`, two sub-cases exist depending on whether the DM session's
backend is the same as the integration's `delegatedBackend`:

- **Same-backend** — DM agent calls the connector's MCP tool directly.
  The daemon is not involved. No skill body is materialized.
- **Cross-backend** — DM agent calls
  `POST /api/integrations/:key/exec` in **task mode** with body
  `{task: "<natural-language description>", outputSchema, maxToolCalls,
  cacheable}`. The daemon spawns a one-shot subprocess of
  `delegatedBackend`, the task-mode planner picks the appropriate tool
  from the integration's registered `capabilityTools`, runs it, and
  returns a structured result conforming to `outputSchema`. The legacy
  RPC route `POST /api/integrations/:key/invoke {tool, args}` was
  retired 2026-05-01 — cross-backend tool-name divergence (Claude
  `search_threads` vs Codex `search_emails` vs Gemini `search`) made
  the RPC shape brittle. See `docs/design/17-delegated-mode-v2.md` §4.2 for the
  retirement rationale and `docs/design/appendices/routine-data-acquisition.md` §8.1
  for the task-mode body shape.

`native` has no sub-cases. The integration's `nativeBackend` must equal
the main DM backend — `BackendRouter.setMainBackend` cascades unmatched
`native` rows to `disabled`. From the agent's call-site view, `native`
is indistinguishable from `delegated` same-backend (both are in-session
MCP); the difference is who polls (no one, for `native`).

## Why This Concept Exists

The setup tax for direct mode (OAuth client setup in a vendor console, then
JSON download, then keychain seeding) is the single biggest blocker for
non-technical operators. Every supported backend — Claude Code, Codex,
Gemini CLI — already ships first-party connectors to Gmail, Calendar,
Drive, and more. When the operator is signed into claude.ai or ChatGPT,
the agent can reach those services through the backend's own MCP tools,
zero daemon credentials required.

Delegated mode lets the operator skip the vendor console entirely. The
two sub-cases (same- vs cross-backend) exist because the agent's DM
session may run on a different backend than the one whose connector is
signed in — e.g. a Claude DM session whose Gmail comes from Codex. In
that case the daemon spawns the other backend per call.

## Definitions

- **`direct`** — daemon holds the credentials (OAuth refresh token in
  macOS Keychain, app-password for Yahoo / iCloud, …). Pollers run.
  Full feature set. The operator did the vendor-console setup.
- **`delegated`** — daemon holds nothing for this integration. The
  daemon's `delegated-sync-worker` polls on opt-in cadences via the
  delegated backend's connector. Per-DM-turn calls reach the connector
  through the agent's backend (same-backend) or via the daemon's
  `/exec` proxy (cross-backend).
- **`native`** — daemon holds nothing AND runs no poller. The main
  backend's MCP connector reaches the integration on-demand within the
  agent's own turn (DM, hourly_check, routine pre-pass). The agent
  POSTs results to `/api/observations/batch` so the rest of the
  observation pipeline (summarizer, hourly check) still operates. See
  `docs/design/appendices/native-integration-mode.md` for the full
  spec, including the per-key `runtime_state.integration_flip_lock:<key>`
  drain protocol.
- **`disabled`** — nobody holds credentials. The integration is off.
- **`delegatedBackend`** — when delegated, which backend's connector
  serves the calls. `claude` / `codex` / `gemini`. Editable per
  integration in **Connections → Gmail / Google Calendar**.
- **`nativeBackend`** — when native, which backend's connector is
  expected. Must equal the main DM backend; changing the main backend
  cascades unmatched `native` rows to `disabled` (the cascade is
  triggered by `BackendRouter.setMainBackend` /
  `PUT /api/backends/main`).
- **Same-backend** — DM session backend matches `delegatedBackend` /
  `nativeBackend`. The daemon is not in the loop; the agent calls
  native MCP directly. No skill body is materialized for the
  integration's slug — the connector describes its own tools at
  session-init.
- **Cross-backend** — DM session backend differs from
  `delegatedBackend`. Cross-backend exists only for `delegated` — never
  for `native`, which is locked to the main DM backend. The agent
  reaches the integration through `POST /api/integrations/:key/exec`
  in task mode and the daemon spawns `delegatedBackend` as a
  subprocess for each call. A `SKILL.delegated.<sessionBackend>.md`
  file is materialized into the session workdir.
- **`integrations.md`** — daemon-rendered snapshot of every
  integration's mode at `~/.personal-agent/integrations.md`. The agent
  reads it to know which path to take.

## How to Choose

| You want… | Pick |
|---|---|
| Full feature set (send mail, attachments, full search) and you're comfortable with one-time vendor-console setup | **direct** |
| Zero setup tax, with opt-in background polling on the delegated backend's connector cadence | **delegated** |
| Zero setup tax, on-demand only — main backend reaches the integration when the agent turns up a reason to look (no daemon polling, no proxy spawn) | **native** |
| The integration off entirely | **disabled** |

When you pick `delegated`, also pick `delegatedBackend`:

- **Same as your DM main backend** → faster, simpler, no proxy spawn,
  but per-tool cost is not measurable (rolls up into the parent
  session). Best when one backend has everything you need.
- **Different from your DM main backend** → adds a one-shot subprocess
  per call; per-call cost is auditable. Best when one backend has the
  connector you want (e.g. Codex's full Gmail) but a different backend
  is your preferred DM driver (e.g. Claude).

When you pick `native`, `nativeBackend` is fixed to your main DM
backend. Flipping the main backend re-targets every `native` row; rows
whose new `nativeBackend` has no descriptor connector for the
integration (e.g. `gmail` native on a backend that doesn't ship a Gmail
connector) cascade to `disabled` and the operator gets a DM.

## Concrete Examples

| Setup | What happens on a Gmail search |
|---|---|
| Gmail direct | Agent: `curl /api/mail/<acct>/messages?q=...` → daemon hits Gmail API with stored OAuth |
| Gmail delegated to Codex × Codex DM (same-backend) | Agent: `mcp__codex_apps__gmail._search_emails(...)` → Codex's connector hits Gmail. No daemon involvement. No skill file. |
| Gmail delegated to Codex × Claude DM (cross-backend) | Agent: `curl -X POST /api/integrations/gmail/exec -d '{"task":"Search Gmail for newer_than:1d, return id/subject/from/snippet/date for each message","outputSchema":{"type":"object","required":["messages"],"properties":{"messages":{"type":"array","items":{...}}}},"maxToolCalls":3,"cacheable":true}'` → daemon spawns Codex subprocess with `proxy.md` profile → task-mode planner picks `_search_emails` from the registered `capabilityTools` → returns structured `{messages:[…]}` conforming to `outputSchema` |
| Gmail native on Codex DM | Agent: `mcp__codex_apps__gmail._search_emails(...)` (identical to delegated same-backend) → Codex's connector hits Gmail. No daemon involvement. Daemon poller is OFF; the routine pre-pass POSTs results to `/api/observations/batch`. |

## How the Skill File Resolves

`selectSkillVariantFile(skillSlug, sessionBackend, integrations)`
returns one of four values, picked by tie-break order
(`docs/design/appendices/native-integration-mode.md` §5.4.1):

1. `"SKILL.delegated.<sessionBackend>.md"` — at least one touched
   integration is delegated cross-backend. The body documents the
   `/exec` task-mode proxy and any native siblings inline (§7.4
   mixed-mode prompts).
2. `"SKILL.native.<sessionBackend>.md"` — at least one touched
   integration is `native` (and no cross-backend wins above). Native
   is always explicit-skill-required (§7.5 — never drops to `null`).
3. `null` — every touched integration is delegated same-backend AND
   each declares the skill in its descriptor's
   `sameBackendDropsSkillBody`. The connector self-describes; no body
   is materialized.
4. `"SKILL.md"` — direct mode, mixed states, or skill not gated by any
   integration.

## Where You See It in the Dashboard

- **Connections → Gmail / Google Calendar** — per-integration mode
  picker, `delegatedBackend` dropdown, deny-list editor.
- **Settings → Models** — main backend switch. Flipping main flips the
  same-/cross-backend status of every delegated integration and
  re-materializes the active DM workdir.
- **Setup wizard** — first-run integration mode picker; both
  `delegated` and `native` are gated on a **live probe** (§4.12.2)
  that confirms three things before the mode is written to
  `integrations.md`: the backend binary is resolvable, backend auth
  is valid, and the connector reports every `requiredCapability` the
  descriptor demands. Cached probe rows are invalidated on mode
  change. `POST /api/integrations/:key/probe` is the chokepoint.

## How `integrations.md` Reflects This

`~/.personal-agent/integrations.md` is the operator-readable snapshot the
agent consults at session-init. It is rendered as a Markdown table:

```markdown
## Current state

| Integration | Mode | Backend | Sub-tier | Last changed |
|---|---|---|---|---|
| gmail | delegated | codex | full-auto | 2026-05-15T07:15:32.911Z |
| google_calendar | native | codex | — | 2026-05-15T07:15:38.605Z |
| notion | disabled | — | — | 2026-05-15T07:14:56Z |
```

The "Backend" column surfaces whichever binding is active for the row —
`delegatedBackend` for `delegated`, `nativeBackend` for `native`. For
`direct` and `disabled` rows it is `—`. The "Sub-tier" column annotates
delegated Gmail rows (`draft-only` for Claude, `full-auto` for Codex)
and is `—` for everything else. The file also includes the per-backend
connector support matrix and the `deniedTools` block; both are rendered
by `renderManagementMd` (`packages/daemon/src/core/management-md.ts`).

A daemon-side write chokepoint guarantees the file matches DB state. The
fs-watcher reverts hand-edits that fail validation and DMs the operator.

## Failure Modes

- **Cross-backend, connector signed out on `delegatedBackend`** — the
  `/exec` endpoint returns `502 auth_error`. Skill prose tells the
  agent to surface this as "re-sign-in to the connector."
- **Cross-backend, daemon's delegated-task queue saturated** — `/exec`
  returns `503 delegated_proxy_busy`. The skill body advises a 3–5s
  backoff with one retry.
- **Cross-backend, fully-denied surface** — when every tool in the
  integration's `capabilityTools` is in `deniedTools`, the task-mode
  planner has nothing to pick. `/exec` short-circuits with
  `errorClass: "denied_tool"` before spawning a subprocess.
- **Same-backend or native, connector not signed in on the DM backend**
  — the agent has no Gmail tools at all. The setup wizard's pre-commit
  live probe is the primary defense; if the operator signs out
  post-setup, the agent will report "no Gmail tools available" until
  re-signed.
- **Mode flip mid-call** — `/exec` returns `409 precondition`; agent
  re-reads `integrations.md` and replans. `native` rows also flip-lock
  via the per-key `runtime_state.integration_flip_lock:<key>` row —
  observations posted during the drain receive
  `results[*].status = "flip_locked"`; the partial / agent profile
  records the row in `errors[]` and the next routine tick reaps it.

## Related

- [Safety Model](safety-model.md) — how the deny list (the primary
  defense in delegated mode) works.
- [Skills](skills.md) — how `selectSkillVariantFile` picks the body.
- Integration Delegation Framework (design) —
  `docs/design/14-integration-delegation.md`, the load-bearing spec
  (§14.14 covers the four modes and their cascade rules).
- Delegated Mode v2 (design) — `docs/design/17-delegated-mode-v2.md` §4.2, the
  `/exec` task-mode model that replaced the retired `/invoke` RPC
  route.
- Native Integration Mode (design) —
  `docs/design/appendices/native-integration-mode.md`, the on-demand
  surface used by `native` rows and its `integration_flip_lock:<key>`
  drain protocol.
- Routine Data Acquisition (design) — `docs/design/appendices/routine-data-acquisition.md`
  §6.8 / §8.1, the per-(integration, mode) partial schema used by
  `routine.fetch_window`.
