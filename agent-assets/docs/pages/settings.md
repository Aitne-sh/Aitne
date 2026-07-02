---
schema_version: 1
slug: pages/settings
title: "Settings Page"
id: page-settings
aliases:
  - settings page
  - settings hub
  - preferences page
category: pages
summary: |
  The Settings page is the configuration hub. The landing tab covers the
  agent's identity and management mode; a sidebar groups the rest —
  Profile, Intelligence, Operations, Browser, and System.
tags:
  - config
status: stable
ask_examples:
  - What can I do on the Settings page?
  - Where do I change the agent's name or character?
  - Where do I set quiet hours?
  - Where do I change which model handles a tier?
locale: en-US
created: 2026-07-01
updated: 2026-07-01
keywords:
  - settings
  - configuration
  - models
  - hours
  - safety
related:
  - concepts/agent-day
  - concepts/backends-and-tiers
  - features/operations/quiet-hours
  - concepts/safety-and-execution
ui_anchors:
  - /settings
---

# Settings Page

The `/settings` landing (**Agent**) covers the basics — the agent's display
name, its character, management mode, and vault health. A sidebar groups
everything else.

## What you can do here

- **Profile** — **Agent** (name, character, management mode) and
  **Hours & Notifications** (quiet hours, notification policy).
- **Intelligence** — **Models** (which model serves each tier — the
  agent's speed/cost levels),
  **Self-learning** (skill-overlay review), **Lessons** (the feedback
  learning store), and **Wiki** (workspace configuration).
- **Operations** — **Management** (the agent's primary vault + management
  mode) and **Commands** (settings for bang-commands — the `!`-prefixed
  shortcuts you type in chat).
- **Browser** — **Browser History** and **Browser Automation** settings
  (mirrored on the [Browser page](../pages/browser.md)).
- **System** — **Safety** (tool policy), **Infrastructure** (config keys,
  paths), and **Danger Zone** (reset and reinstall).

## Where to go deeper

- [The agent's day](../concepts/agent-day.md) — hours and routines.
- [Backends & tiers](../concepts/backends-and-tiers.md) — what the Models
  page controls.
- [Quiet hours](../features/operations/quiet-hours.md) — when the agent
  stays silent.
- [Safety & execution](../concepts/safety-and-execution.md) — what the
  Safety page governs.
- [Config reference](../reference/config.md) — every editable key.

## Related

- [Agents page](agents.md) — per-agent schedules and rulebooks.
- [Connections page](connections.md) — link outside services.
