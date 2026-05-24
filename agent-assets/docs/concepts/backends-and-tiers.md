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
updated: 2026-05-15
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
config_keys:
  - claudeExecutionPermissionMode
  - codexExecutionPermissionMode
  - geminiExecutionPermissionMode
  - opencodeExecutionPermissionMode
---

# Backends and Tiers

## TL;DR

Four backends are supported: **Claude Code** (default), **Codex**,
**Gemini CLI**, and **OpenCode**. Each backend exposes three classes
of model used at install time:

- **Medium / Main** (Sonnet 4.6 / GPT-5.4-mini / Gemini 3 Flash /
  Sonnet 4.6 via OpenCode) — the default for owner-facing work (DMs,
  daily / weekly review, morning routine, dashboard chat, scheduled
  tasks).
- **Lite / Delegated** (Haiku 4.5 on Claude and OpenCode; latest
  light tier on Codex / Gemini) — cheaper model used for "simple"
  backend surfaces with no owner in the loop: Gmail classification,
  GitHub event triage, git-poll observers, calendar-change
  handlers, the routine pre-pass fetcher, the `delegated_task`
  invoker.
- **High / Heavy** (Opus 4.7 / GPT-5.5 / Gemini 3 Pro / Opus 4.7
  via OpenCode) — registered but *not* auto-selected. Operators opt
  in per-process from `/settings/models`. After morning-routine
  Phase 7 (2026-05-16) the only flows that run heavy by default are
  `setup` (one-shot wizard) and `knowledge.import` (owner-uploaded
  files). The first morning routine after setup runs on medium
  tier with a daemon-prepared `<roadmap_skeleton>` block instead of
  the retired heavy `routine.morning_routine_initial`.

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
| `opencode` | provider key forwarded to the OpenCode server (Anthropic / OpenAI / OpenRouter / …) | "Managed" mode runs a local `opencode` HTTP server on loopback; "Remote" mode points at a baseUrl you operate |

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
`ProcessKey` set as the other backends. Two operating modes:

- **Managed** — the daemon spawns and supervises a local
  `opencode` HTTP server on loopback. Configuration (model,
  permissions, agent dir) is written into a managed `opencode.json`
  under `<dataDir>/opencode-home/`.
- **Remote** — you point Aitne at an existing OpenCode server
  baseUrl (your own cluster or a managed deployment).

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
  model (Opus 4.7 / GPT-5.5 / Gemini 3 Pro / Opus 4.7 via OpenCode).
  `medium` (Sonnet 4.6 and equivalents) is the operator's day-to-day
  tier for owner-facing work; `lite` (Haiku 4.5 and equivalents) is
  reserved for mechanical / delegated surfaces.
- **Main / Fallback**: each ProcessKey has a `main` backend and a
  `fallback`. The router fails over on `BackendQuotaError` /
  `BackendDecisiveFailure`.

## Concrete Examples

| ProcessKey | Default main | Seeded model |
|---|---|---|
| `routine.morning_routine` | claude | Sonnet 4.6 |
| `routine.evening_review` | claude | Sonnet 4.6 |
| `routine.weekly_review` | claude | Sonnet 4.6 |
| `routine.hourly_check` | claude | Sonnet 4.6 |
| `message.dm` | claude | Sonnet 4.6 |
| `dashboard.chat` | claude | Sonnet 4.6 |
| `dashboard.docs_qa` | inherits from `message.dm` | Sonnet 4.6 (light forced) |
| `gmail_classify` | claude | Haiku 4.5 |
| `github.*` | claude | Haiku 4.5 |
| `git.push.detected` (and other git-poll keys) | claude | Haiku 4.5 |
| `calendar.change` | claude | Haiku 4.5 |
| `delegated_task` | claude | Haiku 4.5 |

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
