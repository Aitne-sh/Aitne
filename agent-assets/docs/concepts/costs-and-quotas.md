---
schema_version: 1
slug: concepts/costs-and-quotas
title: Costs and Quotas
id: costs-and-quotas
aliases:
  - cost
  - budget
  - quota
  - daily cap
  - cost cap
  - per-token billing
category: concepts
summary: |
  How Aitne meters per-call costs and provider quotas, and where the
  operator sees the rollup. Cost tracking is observational — the
  dashboard reports, it does not bill.
section: cost
tags:
  - core
  - cost
  - quotas
  - backends
  - operations
status: stable
ask_examples:
  - How do I see how much my agent is spending?
  - Why did the agent fail over from Claude to Codex?
  - What does the autonomous daily cost cap do?
  - Does OpenCode billing differ from the other backends?
  - How does Gemini's per-day quota work?
locale: en-US
created: 2026-04-25
updated: 2026-06-07
keywords:
  - cost
  - budget
  - quota
  - api quota
  - per-token billing
  - gemini quota
  - subscription fallback
  - opencode
  - openrouter
  - daily cap
  - monthly cap
  - autonomous cap
related:
  - concepts/backends-and-tiers
  - concepts/auth-health
  - features/operations/cost-tracking
ui_anchors:
  - /analytics
  - /settings/models
config_keys:
  - autonomousDailyCostCapUsd
  - autonomousMonthlyCostCapUsd
process_keys:
  - routine.morning_routine
  - routine.fetch_window
  - routine.activity_scan
---

# Costs and Quotas

## TL;DR

Aitne is designed to run on **provider API keys** registered in the
dashboard. With keys configured, every backend bills per-token /
per-call against your provider account:

- **Claude (via Claude Code)** — per-token billing on
  `ANTHROPIC_API_KEY`.
- **Codex (via Codex CLI)** — per-token billing on `OPENAI_API_KEY`.
- **Gemini (via Gemini CLI)** — per-token billing on `GEMINI_API_KEY`
  / `GOOGLE_API_KEY`; the free tier has per-day caps.
- **OpenCode (via `@opencode-ai/sdk`)** — billing follows whichever
  upstream provider the OpenCode server is configured against
  (Anthropic / OpenAI / OpenRouter / …). Aitne reads cost telemetry
  from the SDK's `session.info.cost` + `info.tokens` fields and
  falls back to its local `MODEL_REGISTRY` pricing when the upstream
  reports `cost === 0` against non-zero tokens.

If you skip the API key, the daemon falls back to whatever
subscription auth the CLI already has on your machine. That fallback
is not provider-supported for automated agent use — see
[Authentication policy](#authentication-policy) below — and the cost
shape becomes whatever the underlying subscription enforces (e.g.
Claude's rolling 5-hour Opus window when running on a Max plan login).

The dashboard rolls cost up by ProcessKey, by backend, and by agent day.

## Why This Concept Exists

A proactive agent can spend without you watching. Aitne's
philosophy is that cost is the operator's problem to *see*, not the
agent's problem to *avoid*: the dashboard shows you what each routine
costs so you can re-pin tiers if a routine has gotten too expensive.

The autonomous daily-cost cap (`autonomousDailyCostCapUsd`) is a
bumper, not a budget — once the day's autonomous spend crosses it the
dispatcher starts shedding the *lowest-priority* routines first
(activity scan), and only escalates to higher-priority ones as spend
climbs further; the morning routine is the last to be cut. Reactive
(in-the-loop) DMs and dashboard chat always pass through. A separate
`autonomousMonthlyCostCapUsd` is a notifications-only soft cap — it
fires an alert when crossed but never skips a session.

## Authentication policy

**Provider API keys are the recommended way to run Aitne.** The
daemon exposes only one auth-config surface — the per-backend API
key picker on `/settings/models` — and treats whatever
*subscription* login the matching CLI happens to have on your
machine purely as a fallback when no key is registered.

Concretely:

- **Subscription-plan registration has been removed.** The setup
  wizard and `/settings/models` no longer ask the operator which
  subscription tier they hold; the DB no longer stores plan state;
  the router never branches on plan.
- **API key first.** When a key is registered (direct or one of the
  cloud-provider options — Bedrock / Vertex / Foundry / Azure
  OpenAI / Gemini-Vertex), Aitne mirrors the corresponding env vars
  into the backend subprocess and bills per-token / per-call
  against your provider account.
- **Subscription is fallback only.** If you skip the key, the
  daemon runs against whatever local CLI login is present
  (`claude`, `codex login`, `gemini`). The dashboard surfaces
  a `SubscriptionAuthWarning` banner whenever any backend is on
  this path because most provider policies for headless /
  programmatic agents do not extend to personal subscriptions —
  **Anthropic currently prohibits using the Claude Agent SDK with a
  Claude Pro / Max subscription**.

If you see the warning banner, the recommended action is to
register an API key on `/settings/models`.

## Definitions

- **API key**: per-backend secret stored in the OS keychain (or
  inherited from your shell env) — the daemon's preferred auth
  method. Mirrored into the SDK / CLI subprocess via
  `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` /
  `GOOGLE_API_KEY`.
- **Subscription fallback**: the CLI's local login (`claude`,
  `codex login`, `gemini`). Used only when no API key is
  configured. Cost behaviour then matches whatever the subscription
  enforces (e.g. Claude's rolling 5-hour Opus window on a Max plan).
- **Daily cost cap**: `autonomousDailyCostCapUsd` (default unset) —
  once the day's autonomous spend crosses it, lower-priority routines
  are skipped first (activity scan at 100% of the cap, the morning
  routine only at 200%). Reactive DMs / dashboard chat keep running;
  you can always reach the agent. Distinct from the removed
  `maxDailyCostUsd`, which used to blanket-block reactive traffic too.
- **Monthly cost cap**: `autonomousMonthlyCostCapUsd` (default unset) —
  a notifications-only soft threshold across the rolling agent month;
  it raises an alert in the Notifications Center but never skips a
  session.
- **Per-process tier**: each ProcessKey has its own tier, max-turns,
  and max-budget USD. Configurable on `/settings/models`.
- **Quota error**: `BackendQuotaError` thrown by an SDK / CLI tells
  the router to fail over to the fallback backend. Its sibling
  `BackendDecisiveFailure` (e.g. an auth failure) triggers the same
  failover — these two signals are why a routine that started on
  Claude can finish on Codex.

## Concrete Examples

- Morning routine on Sonnet via `ANTHROPIC_API_KEY` = per-token
  billing against your Anthropic account, typical cost a few cents.
  Since 2026-05, a lite-tier `routine.fetch_window` pre-pass (Haiku)
  fetches mail / calendar / Notion windows ahead of the main session,
  trimming the main Sonnet input from ~35k tokens to ~18k (~24% total
  cost reduction per fire).
- Morning routine on Opus via `ANTHROPIC_API_KEY` = per-token billing
  on the Opus rate; pin only when Sonnet has failed the task. **No
  recurring routine seeds on Opus by default**, and after
  morning-routine Phase 7 (2026-05-16) **no one-shot routine seeds
  on Opus either** — `routine.morning_routine_initial` was retired
  and the first-run branch runs on the parent
  `routine.morning_routine` envelope (medium tier) with a
  daemon-prepared `<roadmap_skeleton>` block.
- Gemini activity scan on Flash via `GEMINI_API_KEY` = ~$0.0005 per
  fire on the paid tier; the free tier instead consumes one of a
  fixed per-day request budget (Aitne caps Gemini at 450 requests/day
  to match Google's free-tier daily limit — this ceiling is
  Gemini-only by design; Claude and Codex meter per-window and surface
  exhaustion as a quota error).
- Claude Code without an API key (subscription fallback on a Max20
  login) = covered by the subscription, but the daemon flags the
  fallback because it falls outside Anthropic's published policy.

## Where You See It

In the dashboard:

- **Analytics** (`/analytics`) rolls cost by backend, by ProcessKey
  (event type), by model, and over daily / weekly / monthly periods,
  plus a today total.
- **Sidebar** shows the day's running total next to the Analytics
  entry.
- **Activity** event details include the per-execute cost.
- **Settings → Models** (`/settings/models`) exposes the per-backend
  API-key panel and a warning banner whenever a backend is running on
  subscription auth.

From a DM or the terminal:

- **`!cost`** (and `!cost claude` / `!cost codex` / `!cost gemini` /
  `!cost opencode`)
  DM the agent for trailing-7-day spend, broken down or per-backend.
- **`aitne status`** prints today's action count and spend;
  **`aitne audit`** lists the action log (filter with `--since`,
  `--backend`, `--result`).

## Related

- [Cost Tracking](../features/operations/cost-tracking.md) — operator
  surface walkthrough.
- [Backends and Tiers](backends-and-tiers.md)
