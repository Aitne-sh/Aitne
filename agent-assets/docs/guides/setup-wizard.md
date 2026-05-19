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
  Walks through the setup wizard step by step: profile, time axis,
  backend selection and API-key registration, messaging pairing,
  integrations, execution mode.
section: setup-wizard
tags:
  - core
  - guide
  - getting-started
  - setup
  - backends
status: stable
ask_examples:
  - What does each setup step do?
  - Can I rerun the setup wizard?
  - Do I have to connect every integration to start?
  - Where do I paste my API key?
locale: en-US
created: 2026-04-25
updated: 2026-05-15
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
ui_anchors:
  - /setup
---

# Setup Wizard Walkthrough

## Goal

Take a fresh install through the wizard with informed answers at each
step. The wizard is rerunnable any time (`/setup?mode=update`); skip
the steps you have already filled in.

## Prerequisites

- The daemon is launched (`aitne start` or `pnpm start`).
- The dashboard is reachable at `http://localhost:3000`.

## Steps

### Step 1 — Profile

Pick a display name for the agent and (optionally) a character
prompt. The character is prepended to every session as part of the
agent profile.

### Step 2 — Time Axis

Set your timezone and `dayBoundaryHour` (default 04:00). See
[Agent Day](../concepts/agent-day.md) for why the boundary is not
midnight.

### Step 3 — Backends and API Keys

Pick a main backend (Claude / Codex / Gemini), verify the CLI is
installed, and register a provider API key for it. The wizard uses
the per-backend API-key panel to store the key in the OS keychain;
the daemon mirrors it into `process.env` so the SDK / CLI subprocess
picks it up.

The provider dropdown picks one of:

- **Claude** — `anthropic` (direct), `bedrock` (Amazon Bedrock),
  `vertex` (Google Vertex AI), `foundry` (Microsoft Foundry).
- **Codex** — `openai` (direct), `azure-openai` (Azure OpenAI; the
  daemon writes a managed `config.toml` under `<dataDir>/codex-home/`
  so your personal `~/.codex/` is untouched).
- **Gemini** — `google` (direct AI Studio key), `gemini-vertex`
  (Vertex AI).

For non-direct providers, the form re-renders with the cloud-specific
fields (region, project ID, AWS auth mode, deployment names, …). Refer
to your cloud provider's enterprise / Vertex / Bedrock documentation
for the value of each field; the daemon stores them in the OS keychain
and mirrors the matching env vars into the backend subprocess.

API key (or cloud-provider) registration is the recommended path
because it is what Anthropic, OpenAI, and Google document for
headless / programmatic agent use. Skipping the key is allowed —
the daemon falls back to the backend's local CLI login
(subscription auth) — but the dashboard flags the fallback because
most providers do not officially support running automated agents on
a personal subscription. Anthropic in particular currently prohibits
using the Claude Agent SDK with a Claude Pro / Max subscription.

Per-process model bindings are seeded with fixed defaults (Sonnet for
owner-facing work, Haiku for delegated/simple polling); subscription-
plan registration has been removed. You can change the bindings or
the credentials any time on `/settings/models`.

### Step 4 — Execution Mode

Choose Safe (recommended) or Allow per backend. The absolute-block
layer holds in both modes; Safe is the strict-permission posture.

### Step 5 — Messaging

Pair at least one messaging app (Telegram is the easiest). Without
a paired app, the agent has no way to DM you.

### Step 6 — Integrations

Optional — connect mail, calendar, git, Notion, Obsidian as you go.
Each integration is independently re-runnable from `/connections`.

### Step 7 — Routines

Toggle which routines are enabled (morning, evening, weekly, hourly
check) and pick the hours.

## Verification

- The dashboard's Overview shows a green health pill and your paired
  messaging app.
- Send a DM from the paired app and watch the response.

## If It Fails

- A step that errors: check `aitne logs` for the underlying daemon
  message. Most failures are credential shape issues.
- A backend that won't authenticate: see [Auth Failed](../troubleshooting/auth-failed.md).

## Related

- [What is Aitne?](../getting-started/01-what-is-this.md)
- [First Steps](../getting-started/02-first-steps.md) — the orientation
  that points here.
- [Your First Day](../getting-started/04-first-day.md) — what to do
  after the wizard completes.
