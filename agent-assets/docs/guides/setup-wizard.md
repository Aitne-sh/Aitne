---
schema_version: 1
slug: guides/setup-wizard
title: Setup Wizard Walkthrough
id: setup-wizard
aliases:
  - setup wizard
  - first run wizard
  - install wizard
category: guides
summary: |
  Walks through the setup wizard step by step: basics (name + language),
  vault, AI backend + API-key registration + execution mode, mail,
  calendar, notes, messaging pairing, and the chat-driven Customize
  Rules step.
section: guides
tags:
  - core
  - guides
  - getting-started
  - setup
  - backends
  - messaging
status: stable
ask_examples:
  - What does each setup step do?
  - Can I rerun the setup wizard?
  - Do I have to connect every integration to start?
  - Where do I paste my API key?
locale: en-US
created: 2026-04-25
updated: 2026-06-07
keywords:
  - setup
  - wizard
  - first run
  - cloud providers
  - bedrock
  - vertex
  - foundry
  - azure-openai
  - opencode
  - execution mode
related:
  - getting-started/01-what-is-this
  - getting-started/02-first-steps
  - getting-started/04-first-day
  - concepts/safety-and-execution
  - concepts/backends-and-tiers
config_keys:
  - agentDisplayName
  - primaryLanguage
  - vaultMode
api_endpoints:
  - POST /api/setup/mode
ui_anchors:
  - /setup
  - /settings/models
  - /connections
  - /settings/routines
  - /settings/schedule
---

# Setup Wizard Walkthrough

## Goal

Take a fresh install through the wizard with informed answers at each
step. The wizard is rerunnable any time at `/setup?mode=update`, which
jumps straight to the Customize Rules step so you can refine the agent
without redoing the whole flow.

## Prerequisites

- The daemon is launched (`aitne start` or `pnpm start`).
- The dashboard is reachable at `http://localhost:8322`.

## The steps at a glance

The wizard has eight collection steps plus a terminal "Done" screen.
Three are required (**Basics**, **Vault**, **AI Backend**, plus
**Customize Rules**); the four integration/messaging steps are
skippable and re-runnable later.

| # | Step | Required? | What it sets |
|---|------|-----------|--------------|
| 1 | Basics | required | Agent display name + primary language |
| 2 | Vault | required | Vault mode (plain MD vs. Obsidian) + primary path |
| 3 | AI Backend | required | Main backend, API key, execution mode |
| 4 | Mail | skippable | Gmail / Outlook / IMAP accounts |
| 5 | Calendar | skippable | Google / Outlook calendars |
| 6 | Notes | skippable | Notion + external Obsidian vault |
| 7 | Messaging | skippable | Slack / Telegram / Discord / WhatsApp pairing |
| 8 | Customize Rules | required | Chat-driven persona + house rules |

## Steps

### Step 1 — Basics

Pick a display name for the agent and the primary language it should
write in. The character/persona itself is *not* set here — that is
generated interactively in the Customize Rules step (Step 8).

### Step 2 — Vault

Choose how durable memory is stored: **plain** (Markdown under
`~/.personal-agent/context/`, the default) or **Obsidian** (point the
agent at an existing vault and set the primary path inline). See
[Use an Existing Obsidian Vault](use-an-existing-obsidian-vault.md)
for the Obsidian path.

### Step 3 — AI Backend

Pick a main backend (**Claude**, **Codex**, **Gemini**, or
**OpenCode**), verify the CLI is installed, and register a provider
API key for it. The wizard stores the key in the OS keychain; the
daemon mirrors it into the backend subprocess environment so the SDK /
CLI picks it up.

The provider dropdown picks one of:

- **Claude** — `anthropic` (direct), `bedrock` (Amazon Bedrock),
  `vertex` (Google Vertex AI), `foundry` (Microsoft Foundry).
- **Codex** — `openai` (direct), `azure-openai` (Azure OpenAI; the
  daemon writes a managed `config.toml` under `<dataDir>/codex-home/`
  so your personal `~/.codex/` is untouched).
- **Gemini** — `google` (direct AI Studio key), `gemini-vertex`
  (Vertex AI).

For non-direct providers the form re-renders with the cloud-specific
fields (region, project ID, AWS auth mode, deployment names, …). Refer
to your cloud provider's enterprise / Vertex / Bedrock documentation
for each field's value; the daemon stores them in the OS keychain and
mirrors the matching env vars into the backend subprocess.

API-key (or cloud-provider) registration is the recommended path
because it is what Anthropic, OpenAI, and Google document for
headless / programmatic agent use. Skipping the key is allowed — the
daemon falls back to the backend's local CLI login (subscription auth)
— but the dashboard flags the fallback, because most providers do not
officially support running automated agents on a personal
subscription. Anthropic in particular currently prohibits using the
Claude Agent SDK with a Claude Pro / Max subscription.

Per-process model bindings are seeded with fixed defaults: **Claude
Sonnet 4.6** (`claude-sonnet-4-6`) for owner-facing work and **Claude
Haiku 4.5** (`claude-haiku-4-5-20251001`) for delegated/simple
polling. Opus (`claude-opus-4-8`) is registered but not seeded — opt
in per row. There are no subscription-plan questions. Change the
bindings or credentials any time on `/settings/models`.

**Execution mode** is set on this same step (one card below the
backend picker). Choose **Safe** (recommended) or **Allow** per
backend; the top-level choice applies to every backend you do not
override. Safe is the strict-permission posture; the absolute-block
layer holds in both modes. The same setting is exposed later via
`POST /api/setup/mode` (`{mode, perBackend?}`) and the Execution Mode
card on `/settings/models`. See
[Safety and Execution](../concepts/safety-and-execution.md).

### Step 4 — Mail (skippable)

Connect Gmail, Outlook, or a generic IMAP account. Re-runnable later
from `/connections`.

### Step 5 — Calendar (skippable)

Connect Google or Outlook calendars. Re-runnable from `/connections`.

### Step 6 — Notes (skippable)

Connect Notion and/or point at an external Obsidian vault. Re-runnable
from `/connections`.

### Step 7 — Messaging (skippable, but do it)

Pair at least one messaging app (Telegram is the easiest). Without a
paired app, the agent has no way to DM you, so this is the one
"skippable" step worth completing on the first run. Re-runnable from
`/connections`.

### Step 8 — Customize Rules

A chat-driven step (no form): you talk to the agent to shape its
persona/character and your house rules. The agent stages a character
block and rule set you can review before saving. This is where the
character prompt referenced in Step 1 actually gets written.

## After the wizard

Routines are **not** configured in the wizard. Edit the per-cadence
rulebooks (morning / evening / weekly / hourly) and register custom cron
routines post-setup on `/settings/routines`; the hourly-check master
switch, active / quiet hours, and the monthly review live on
`/settings/schedule`. Repositories are also added after setup, from
Connections → Repositories.

## Verification

- The dashboard Overview shows a green health pill and your paired
  messaging app.
- Send a DM from the paired app and watch for the response.

## If it fails

- A step that errors: check `aitne logs` for the underlying daemon
  message. Most failures are credential-shape issues.
- A backend that won't authenticate: see
  [Auth Failed](../troubleshooting/auth-failed.md).

## Related

- [What is Aitne?](../getting-started/01-what-is-this.md)
- [First Steps](../getting-started/02-first-steps.md) — the orientation
  that points here.
- [Your First Day](../getting-started/04-first-day.md) — what to do
  after the wizard completes.
