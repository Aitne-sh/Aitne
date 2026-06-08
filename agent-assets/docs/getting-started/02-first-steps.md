---
schema_version: 1
slug: getting-started/02-first-steps
title: First Steps in the Dashboard
id: first-steps
aliases:
  - first steps
  - first time
  - dashboard onboarding
  - after install
category: getting-started
summary: |
  What to do the moment the dashboard opens — finish the setup wizard,
  pair a messaging app, and arrive at a green health pill.
section: getting-started
tags:
  - core
  - getting-started
  - setup
status: stable
ask_examples:
  - I just opened the dashboard. What now?
  - How do I get the agent to talk to me?
  - Do I have to connect every integration?
  - Where is the setup wizard?
locale: en-US
keywords:
  - first steps
  - setup wizard
  - pair messaging
  - dashboard onboarding
  - health pill
created: 2026-04-27
updated: 2026-06-07
related:
  - getting-started/01-what-is-this
  - getting-started/03-what-can-this-do
  - getting-started/04-first-day
  - guides/setup-wizard
ui_anchors:
  - /setup
  - /
  - /activity
  - /connections
  - /settings/models
---

# First Steps in the Dashboard

## Goal

Get from a fresh dashboard to "the agent can reach me" — a green
health pill, a paired messaging app, and a backend the agent can call.

## What you should see right now

If the dashboard just opened, you are on `/setup` — the setup wizard.
The dashboard sends you back to this page until the required steps are
done (Basics, Vault, a main backend, and the Customize Rules step that
saves your management rules). Messaging and the other integrations are
skippable in the wizard. Run through it once, top to bottom.

## Steps

1. **Finish the setup wizard.** Each step is small and rerunnable.
   The walkthrough — what each step asks for and why — lives in
   [Setup Wizard](../guides/setup-wizard.md).
2. **Pair at least one messaging app.** Telegram is the easiest. The
   wizard's Messaging step prints a magic phrase you DM to the bot;
   the daemon claims you as the owner. See
   [Messaging Overview](../features/messaging/overview.md) for the
   list of supported apps and what each one does well.
3. **Pick a main backend and register an API key.** Pick the LLM
   the agent uses for "think hard" turns (Claude / Codex / Gemini /
   OpenCode) and paste a provider API key — the supported way to run
   a headless agent. If you skip the key, the daemon falls back to
   whatever subscription login the matching CLI already has on your
   machine; the dashboard surfaces a warning when this happens
   because most providers do not support running agents on a
   personal subscription. The same picker also lets you point the
   backend at a cloud provider (Bedrock / Vertex / Foundry / Azure
   OpenAI / Gemini-Vertex) instead of the direct API key — the
   provider dropdown on `/settings/models` is the single surface for
   both direct keys and cloud-provider credentials. Defaults are
   sensible and can be changed later from `/settings/models`.
   Background: [Backends and Tiers](../concepts/backends-and-tiers.md).
4. **Skip integrations you do not need yet.** Mail, calendar, git,
   Notion, Obsidian are all optional and re-runnable any time from
   `/connections`.

## Verification

- The Overview page (`/`) shows a green health pill.
- The Messaging card lists at least one paired app.
- A DM you send from the paired app shows up in
  `/activity` within a few seconds.

## If It Fails

- Can't get past a wizard step → check `pnpm logs` and look for the
  underlying daemon error. Most failures are credential-shape issues.
- Backend won't authenticate → see [Auth Failed](../troubleshooting/auth-failed.md).
- Messaging never claims you → see [Messaging Not Pairing](../troubleshooting/messaging-not-pairing.md).

## Related

- [What is Aitne?](01-what-is-this.md) — the orientation.
- [What This App Can Do](03-what-can-this-do.md) — once setup is
  done, here is the tour.
- [Your First Day](04-first-day.md) — what happens once the agent
  starts running on its own.
