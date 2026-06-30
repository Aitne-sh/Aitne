---
schema_version: 1
slug: concepts/backends-and-tiers
title: Backends and Tiers
id: backends-and-tiers
aliases:
  - models
  - claude codex gemini opencode
  - heavy tier
  - light tier
  - main backend
  - fallback backend
category: concepts
summary: |
  Aitne runs on four backends — Claude Code, Codex, Gemini CLI, OpenCode.
  Each backend exposes light, medium, and high model tiers; the dispatcher
  picks the binding for every ProcessKey based on operator configuration.
section: backends
tags:
  - core
  - backends
  - models
  - cost
  - routing
status: stable
ask_examples:
  - Which model does my morning routine use?
  - How do I switch from Claude to Codex?
  - What is the difference between heavy and light tier?
  - What is OpenCode and when should I use it?
  - How does Aitne fail over when a backend hits its quota?
locale: en-US
created: 2026-04-25
updated: 2026-06-07
keywords:
  - claude
  - codex
  - gemini
  - opencode
  - opus
  - sonnet
  - haiku
  - gpt-5
  - tier
  - bedrock
  - vertex
  - foundry
  - azure-openai
  - openrouter
  - routing
  - fallback
related:
  - concepts/process-keys
  - concepts/costs-and-quotas
  - features/operations/backend-routing
ui_anchors:
  - /settings/models
  - /analytics
process_keys:
  - message.dm
  - dashboard.chat
  - dashboard.docs_qa
  - routine.morning_routine
  - gmail_classify
  - calendar.change
  - delegated_task
  - delegated_task_heavy
config_keys:
  - claudeExecutionPermissionMode
  - codexExecutionPermissionMode
  - geminiExecutionPermissionMode
  - opencodeExecutionPermissionMode
  - opencodeBaseUrl
  - opencodeServerUsername
  - delegatedTaskHeavyEnabled
---

# Backends and Tiers

## TL;DR

Four backends are supported: **Claude Code** (default), **Codex**,
**Gemini CLI**, and **OpenCode**. Each backend exposes three model
tiers. The per-backend defaults seeded at install time are:

| Tier | Claude | Codex | Gemini | OpenCode |
|---|---|---|---|---|
| **medium** (main) | Sonnet 5 | GPT-5.4 | Gemini 3.1 Pro (preview) | Sonnet 5 |
| **lite** (delegated) | Haiku 4.5 | GPT-5.4 Mini | Gemini 3.1 Flash Lite (preview) | Haiku 4.5 |
| **high** (heavy) | Opus 4.8 | GPT-5.4¹ | Gemini 3.1 Pro (preview)¹ | Opus 4.8 |

¹ Codex and Gemini have no separately-seeded high model — their high
tier collapses to the medium model via `SEED_HIGH_TIER_OVERRIDE`.
Codex's flagship GPT-5.5 is Opus-priced and stays an opt-in; Gemini
has no Opus-priced Google flagship worth defaulting to. Pin a higher
model per row from `/settings/models` if you want it.

What each tier is for:

- **Medium / Main** — the default for owner-facing work: DMs and
  mentions, dashboard chat, morning / evening / weekly / monthly
  review, the activity scan, scheduled tasks.
- **Lite / Delegated** — the cheaper model for "simple" backend
  surfaces with no owner in the loop: Gmail classification, GitHub
  event triage, git-poll observers, calendar-change handlers, the
  routine pre-pass fetcher, the `delegated_task` invoker.
- **High / Heavy** — registered but *not* auto-selected. After the
  "no Opus by default" pass (2026-05-16), **no install-time-seeded
  surface defaults to high.** The only `high`-tagged ProcessKey is
  `delegated_task_heavy`, and it is opt-in (gated by the
  `delegatedTaskHeavyEnabled` config flag). Operators can pin any
  other ProcessKey to high per row from `/settings/models`. The
  first morning routine after setup runs on **medium** tier with a
  daemon-prepared `<roadmap_skeleton>` block instead of the retired
  heavy `routine.morning_routine_initial`.

Every ProcessKey resolves to a backend + model binding via
`BackendRouter`. Aitne **does not store or read subscription-plan
state** — there is no "Claude Pro / Max / Team" or "ChatGPT Plus /
Pro" picker in the wizard or settings, and the DB has no plan
column. Bindings come from `process_backend_config` rows seeded at
install time and edited from `/settings/models`.

Each backend authenticates via a provider API key registered on
`/settings/models`. The provider dropdown picks one of:

| Backend | Direct API key | Cloud / aggregator options |
|---|---|---|
| `claude` | `anthropic` (`sk-ant-…`) | `bedrock` (Amazon Bedrock), `vertex` (Google Vertex AI), `foundry` (Microsoft Foundry) |
| `codex` | `openai` (`sk-…`) | `azure-openai` (Codex CLI on Azure OpenAI; daemon writes a managed `config.toml` under `<dataDir>/codex-home/`) |
| `gemini` | `google` (`AIza…`) | `gemini-vertex` (Gemini on Google Vertex AI) |
| `opencode` | `opencode-server` (server URL + HTTP Basic-Auth username / optional password). Model-provider keys (Anthropic / OpenAI / OpenRouter / …) live on the OpenCode server itself — configure them there with `opencode auth login`; Aitne does not store or forward them | "Managed" mode runs a local `opencode` HTTP server on loopback; a "Remote" mode pointing at a baseUrl you operate is designed but not wired up yet |

API keys are the recommended and provider-supported auth method for
headless agent use; if you skip the key the daemon falls back to the
CLI's local subscription login, which most providers do not
officially support — Anthropic in particular currently prohibits the
Claude Agent SDK on a Claude Pro / Max subscription. The dashboard
surfaces a warning whenever a backend is on subscription auth.

Cloud / aggregator providers (Bedrock / Vertex / Foundry / Azure
OpenAI / Gemini-Vertex / OpenRouter via OpenCode) let teams reuse
an existing enterprise contract, keep model traffic inside a private
VPC, or take advantage of provider-side rate-limit pools. Aitne
stores the credentials in the OS keychain and mirrors the
corresponding env vars (`CLAUDE_CODE_USE_BEDROCK=1`,
`CLAUDE_CODE_USE_VERTEX=1`, `CLAUDE_CODE_USE_FOUNDRY=1`,
`GOOGLE_GENAI_USE_VERTEXAI=true`, …) into the backend subprocess.
See [Costs and Quotas](costs-and-quotas.md) for the cost shape of
each path.

## OpenCode (4th backend)

OpenCode joined as a 4th backend in 2026-05. It is implemented on
top of the `@opencode-ai/sdk` HTTP server and supports the same
`ProcessKey` set as the other backends. Two operating modes are
designed:

- **Managed** — the daemon spawns and supervises a local
  `opencode` HTTP server on loopback (`127.0.0.1`, OS-picked port).
  Per-session config (model, permissions, agent dir) is passed
  inline to the server via the `OPENCODE_CONFIG_CONTENT` env var —
  no config file is written to disk. This is the only mode wired up
  today.
- **Remote** — pointing Aitne at an existing OpenCode server baseUrl
  (your own cluster or a managed deployment). The `opencodeBaseUrl` /
  `opencodeServerUsername` config keys exist, but the daemon's
  server factory currently always runs the Managed local server —
  Remote lands in a later phase.

OpenCode is a runtime peer of Claude / Codex / Gemini for
dispatching ProcessKeys, but it intentionally does **not** host
native-mode integration connectors (Gmail / Calendar / Notion go
through the daemon's polling path or another backend's MCP). See
`docs/design/appendices/opencode-backend.md` for the full design.

## Why This Concept Exists

Different work has different cost / quality tradeoffs. Owner-facing
surfaces (DMs, daily review) need real instruction-following.
Background polling (mail / calendar / git events) just needs a
classifier-shaped output. Splitting Sonnet vs Haiku at the seed layer
keeps the cost of an autonomous loop bounded without compromising the
quality of work the operator actually reads.

Multiple backends exist so Aitne isn't single-vendor. The same
operator can keep Claude as the primary brain, fall back to Codex when
Claude's quota is exhausted, or use Gemini for cheap polling tasks.

## Definitions

- **Backend**: the agent runtime. One of `claude`, `codex`, `gemini`,
  `opencode`.
- **Tier**: `lite`, `medium`, or `high`. `high` maps to the strongest
  model class (Opus-class — Opus 4.8 on Claude and OpenCode; on Codex
  and Gemini the seeded high binding collapses to the medium model).
  `medium` (Sonnet-class — Sonnet 5 and equivalents) is the
  operator's day-to-day tier for owner-facing work; `lite`
  (Haiku-class — Haiku 4.5 and equivalents) is reserved for
  mechanical / delegated surfaces. Sonnet 5 became the seeded medium
  default on 2026-06-30; the prior **Sonnet 4.6** is retained as a
  `(legacy)` model — hidden from the pickers but still resolvable for
  any row already pinned to it.
- **Main / Fallback**: each ProcessKey has a `main` backend and a
  `fallback`. The router fails over on `BackendQuotaError` /
  `BackendDecisiveFailure`.

## Concrete Examples

| ProcessKey | Default main | Seeded model |
|---|---|---|
| `routine.morning_routine` | claude | Sonnet 5 |
| `routine.evening_review` | claude | Sonnet 5 |
| `routine.weekly_review` | claude | Sonnet 5 |
| `routine.activity_scan` | claude | Sonnet 5 |
| `message.dm` | claude | Sonnet 5 |
| `dashboard.chat` | claude | Sonnet 5 |
| `dashboard.docs_qa` | inherits from `message.dm` | Sonnet 5 (locked to medium) |
| `gmail_classify` | claude | Haiku 4.5 |
| `github.*` | claude | Haiku 4.5 |
| `git.push.detected` (and other git-poll keys) | claude | Haiku 4.5 |
| `calendar.change` | claude | Haiku 4.5 |
| `delegated_task` | claude | Haiku 4.5 |
| `delegated_task_heavy` | claude | Opus 4.8 (high; opt-in, off by default) |

## Where You See It in the Dashboard

- **Settings → Models** is the unified surface: pick the main backend,
  override the per-process binding, toggle the optional advisor.
- The **Activity** event detail shows which backend / model actually
  ran each turn (after fallback resolution).
- **Analytics** rolls cost up by backend.

## Related

- [Costs and Quotas](costs-and-quotas.md) — how to read the rollup.
- [Backend Routing](../features/operations/backend-routing.md) — the
  fallover machinery.
