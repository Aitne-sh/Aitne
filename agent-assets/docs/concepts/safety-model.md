---
schema_version: 1
slug: concepts/safety-model
title: Safety Model (deniedTools + Approve Tier)
id: safety-model
aliases:
  - safety model
  - 2-tier safety
  - notify abolished
  - deny list
  - deniedTools
  - on-demand retrospective
category: concepts
summary: |
  Aitne's safety model collapsed from four tiers to two: most
  actions run autonomously, a small set of posture-changing operations
  require explicit Approve. The previous Notify tier (DM the operator
  before / during a write) was abolished — the operator's `deniedTools`
  list is now the primary defense, and "what did the agent do?" is
  answered on demand via `GET /api/agent/actions` instead of pushed as
  a daily digest.
section: safety
tags:
  - core
  - safety
  - integrations
  - skills
status: stable
ask_examples:
  - Why doesn't the agent ask before sending an email anymore?
  - How do I stop the agent from deleting things on its own?
  - What does the agent ask me to approve, vs do without asking?
  - Where do I see what the agent has been doing?
locale: en-US
created: 2026-04-26
updated: 2026-05-17
keywords:
  - deniedTools
  - safety floor
  - Approve tier
  - Autonomous tier
  - ReadSensitive
  - agent_actions
  - retrospective
  - starter denylist
related:
  - concepts/delegated-mode
  - concepts/safety-and-execution
  - features/operations/approvals
  - reference/disallowed-tools
ui_anchors:
  - /connections
  - /settings/cost
config_keys:
  - integrations
  - deniedTools
---

# Safety Model (deniedTools + Approve Tier)

## TL;DR

The risk classifier has two write tiers, not three:

- **Autonomous** — agent runs the action without asking. Default for
  every connector tool call (send mail, archive, label, create event,
  delete event, …) and for normal context writes.
- **Approve** — agent must present a Bearer token issued through the
  dashboard. Reserved for posture-changing daemon configuration:
  flipping integration modes, swapping the main backend, deleting
  backends, wiping config.
- (`ReadSensitive` is the third tier, but it gates *reads* of personal
  data — orthogonal to write notifications. It is unchanged.)

The middleware that used to DM the operator before a write
("Notify-tier") is gone. The defenses against unwanted destructive
actions are:

1. **`deniedTools` list** (primary) — per-integration deny list. The
   setup wizard pre-populates a recommended starter list on first
   delegated setup so the floor is non-empty out of the box.
2. **Approve tier** — only for daemon-config changes that affect the
   safety posture itself.
3. **On-demand retrospective** — `GET /api/agent/actions` returns the
   agent's own audit trail. When the operator asks "what did you do
   yesterday?", the agent queries this and answers in conversation.

## Why This Concept Exists

The previous Notify tier (3-tier model: Autonomous / Notify / Approve)
gave a *false sense* of safety: the action completed regardless, the
operator could miss the DM, and the middleware was structurally unable
to intercept native MCP calls (the agent could reach Gmail through the
backend's connector without ever touching the daemon). Curating a
per-tool Notify policy across direct + cross-backend + same-backend +
operator-installed MCPs was an ever-growing maintenance trap.

The new model is honest: dangerous actions either (a) are denied at the
chokepoint by the operator's `deniedTools`, (b) require explicit
Approve (sparse, intentional, daemon-config only), or (c) happen
autonomously and are auditable on demand.

The *value proposition* — the agent manages the operator's life — is
preserved. The operator should not have to manage the agent's calendar
of "report to me" events. Information about what the agent did is
**available on demand**, not pushed.

## Definitions

- **Risk tier** — `Autonomous`, `ReadSensitive`, or `Approve`. The
  former `Notify` tier was removed. `ReadSensitive` is unchanged and
  gates personal-data *reads* via X-Read-Token / Bearer.
- **`deniedTools`** — per-integration list of tool names (or
  prefix-globs) the agent must not call. Lives in
  `integrationStateSchema.deniedTools`. Editable in
  **Connections → \<integration\> → Tool Permissions**.
- **Starter denylist** — non-empty default `deniedTools` the setup
  wizard pre-populates when the operator first picks `delegated` for an
  integration. Closes the "fresh-install with empty deny list lets the
  agent send freely" gap.
- **`matchToolPattern`** — pattern matcher used everywhere `deniedTools`
  is enforced. Exact match (`send_email`), prefix glob (`send_*`), or
  bare `*`.
- **`/api/integrations/:key/exec`** — the cross-backend chokepoint
  (task mode; the RPC-style `/invoke` route was retired 2026-05-01,
  see `docs/design/17-delegated-mode-v2.md` §4.2). Enforces `deniedTools`
  server-side by filtering the integration's `capabilityTools` through
  the deny list before spawning the delegated backend, so the
  task-mode planner can only pick from the allowed surface. A
  fully-denied surface short-circuits with `errorClass: "denied_tool"`
  before any subprocess spawn.
- **`agent_actions`** — SQLite table of every agent action. Direct +
  cross-backend rows are full-fidelity (current cross-backend writes
  emit `delegated_task.run` / `delegated_task.exec` /
  `delegated_task.tool_step`; legacy rows from before 2026-05-01 carry
  `delegated_proxy.invoke`). Same-backend native MCP rolls up to
  `mcp_tool_calls` + the parent session row.

## Where the Defenses Apply

| Path | Enforcement |
|---|---|
| Direct mode (`/api/mail/*`, `/api/calendar/*`) | Route handler middleware checks `deniedTools` against the materialized skill body's `allowed-tools` list (frontmatter). |
| Cross-backend (`/api/integrations/:key/exec`) | Invoker filters the integration's `capabilityTools` through `deniedTools` before spawning the delegated backend so the task-mode planner can only pick from the allowed surface. A fully-denied surface short-circuits with `errorClass: "denied_tool"`; individual tool denials surface as the same error from the invoker's `resolveAllowedToolPatterns`. |
| Same-backend / native MCP — Claude | `collectSessionDeniedTools` merges the deny patterns into the SDK's `disallowedTools` array at `query()` time. Same code path covers both delegated same-backend and native — they share the in-session MCP surface. |
| Same-backend / native MCP — Gemini | Patterns are folded into `generateAdminPolicy`'s TOML deny rules (priority 1000). |
| Same-backend / native MCP — Codex | **Prose-only.** Codex bundles its connector apps into the binary; there is no per-tool deny config and the workspace-write sandbox does not match MCP tool calls. Skill prose lists the denied tools explicitly. Operators who require strict deny on Gmail / Calendar should pick a non-Codex DM backend or route those integrations through `delegated` cross-backend mode (which IS deny-enforced at `/exec`). |

## Recommended Starter Denylists

The setup wizard pre-populates these on first delegated setup. The
operator can keep them, edit, or explicitly opt for an empty list (a
confirmation modal explains the trade-off).

**Gmail × Codex** (Codex's `mcp__codex_apps__gmail._*`):

| Tool | Why deny by default |
|---|---|
| `send_email` | Strictly destructive — irreversible from the agent's POV |
| `delete_emails` | Strictly destructive — moves to Trash; the connector exposes no separate "trash" tool |
| `archive_emails` | Recoverable from "All Mail" but easy to lose track of |
| `apply_labels_to_emails` | Mutating; can hide threads from default views |

**Gmail × Claude** (the hosted connector is draft-only — no send /
delete / archive surface):

| Tool | Why deny by default |
|---|---|
| `label_message` | The only mutating tool the connector exposes |
| `label_thread` | Same |

**Google Calendar** (Codex + Claude):

| Tool | Why deny by default |
|---|---|
| `delete_event` | Strictly destructive |
| `update_event` | Mutating; not strictly destructive but hard to undo cleanly |

The floor is intentionally wider than the strict
"irreversible-only" minimum. `archive_emails`,
`apply_labels_to_emails`, and `update_event` are technically reversible
but practically destructive in a manage-my-life context: an agent that
silently archives 30 threads or rewrites calendar invites creates
cleanup work that may take longer than the agent saved. If you want
the agent to archive freely, remove `archive_emails`. If you trust it
on calendar edits, remove `update_event`. The strictly-destructive
entries (`send_email`, `delete_emails`, `delete_event`) are the ones
to keep.

Tool names are **bare**: no `mcp__*` prefix, no leading underscore. The
daemon prepends the connector's namespace before forwarding.

## Pattern Language

`deniedTools` accepts both exact names and prefix globs:

- `send_email` — exact match.
- `send_*` — anything starting with `send_` (matches `send_email`,
  `send_message`, `send_draft` …).
- `*` — matches anything (deny everything in the integration; rare).

Anchors are implicit. `*` is only honored as a suffix to keep the
pattern language single-purpose. Patterns are validated at PATCH time
against the connector's `capabilityTools` set so typos fail fast.

## When the Wizard Re-Fires the Starter Floor

The starter floor re-fires not just on first-delegated setup but also
on `delegatedBackend` swap (e.g. claude → codex) when the previous
deny list is namespace-stale on the new backend and the operator
hadn't already chosen an empty list. The audit row carries
`trigger="backend_swap_stale"` to distinguish from
`trigger="first_delegated"`. Operators who explicitly set
`deniedTools: []` before the swap are honored — the swap clause does
not silently re-establish a floor they had already rejected.

## On-Demand Retrospective

When the operator asks "what did you do yesterday?" / "have you sent
anything from Gmail this week?" the agent calls:

```bash
curl 'http://localhost:8321/api/agent/actions?since=2026-04-25T00:00:00Z&kind=delegated_task.run&kind=delegated_task.tool_step&limit=50'
```

and answers in conversation. The endpoint:

- Lives at `Autonomous` tier — the agent reads only its own audit
  trail, no operator data.
- Accepts `since`, `kind` (repeat for multiple values, e.g.
  `?kind=a&kind=b`), `limit` (default 50, max 200).
- Redacts values via the standard secret-redaction utility before
  serializing.
- Returns rows from `agent_actions`, optionally joined with
  `mcp_tool_calls` when `kind=mcp` (same-backend / native MCP).

Common `kind` values for the cross-backend proxy: `delegated_task.run`
(one row per `/exec` call), `delegated_task.exec` (the planner's
chosen tool), `delegated_task.tool_step` (each individual tool call
inside the task). The legacy `delegated_proxy.invoke` rows persist
from before 2026-05-01 — include them if the `since` window crosses
that date.

This **replaces** the rejected daily-digest pattern. Reasons:

- Token cost is paid only when the operator actually wants to know.
- Information arrives as conversation, not a wall-of-text DM.
- The operator does not have to manage the agent's reporting calendar.

The optional fallback — extending the existing morning routine to
summarize yesterday's `agent_actions` into `agent/journal.md` — is
deferred until the on-demand path proves insufficient.

## What Stayed Approve-Tier

Approve is reserved for operations that change the safety posture or
infrastructure itself, not for connector tool calls. Every connector
tool call (send, delete, archive, …) is `Autonomous`, gated only by
`deniedTools`.

Approve still gates:

- `PATCH /api/integrations/:key` — mode / `delegatedBackend` /
  `deniedTools` changes.
- `PUT /api/backends/main`, `DELETE /api/backends/:id`.
- `PATCH /api/config` for fields that wipe protections.
- `/api/system/*` — config reset, history purge, factory reset.

## Where You See It in the Dashboard

- **Connections → \<integration\> → Tool Permissions** — the
  `deniedTools` editor with the starter list pre-populated. Above the
  editor, the safety guidance prose explains each entry and which the
  team recommends keeping.
- **Settings → Cost → Delegated proxy facet** — only cross-backend
  invocations show here; same-backend rolls up under the parent
  session.
- **Activity / Audit** — every action with full attribution, queried
  the same way the agent queries `GET /api/agent/actions`.

## Related

- [Delegated Mode](delegated-mode.md) — the three modes and two
  delegated sub-cases that this safety floor applies to.
- [Safety and Execution](safety-and-execution.md) — the lower-level
  always-disallowed layer; absolute-block holds in both Safe and
  Allow modes.
- Integration Delegation Framework (design) — `docs/design/14-integration-delegation.md`
  §14.12, the deniedTools spec.
- Delegated Mode v2 (design) — `docs/design/17-delegated-mode-v2.md` §4.5,
  the rationale for Notify-tier abolition + the starter denylist.
