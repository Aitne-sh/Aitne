---
schema_version: 1
slug: pages/browser
title: "Browser Page"
id: page-browser
aliases:
  - browser page
  - browser hub
category: pages
summary: |
  The Browser page is the home for everything the agent does with a
  browser: reading your existing Chrome history, driving a dedicated
  sandboxed Chromium, the experimental purchase-confirmation flow, and the
  browser tasks it has run.
tags:
  - autonomous
status: stable
ask_examples:
  - What can I do on the Browser page?
  - How do I let the agent read my browsing history?
  - Where do I see browser tasks the agent ran?
  - What is the managed Chromium for?
locale: en-US
created: 2026-07-01
updated: 2026-07-01
keywords:
  - browser
  - chromium
  - browsing history
  - automation
  - browser tasks
related:
  - features/operations/managed-chromium
  - features/operations/browser-tasks
  - features/integrations/browser-history
ui_anchors:
  - /browser
  - /browser-tasks
---

# Browser Page

The `/browser` page brings every browser feature together in one place.
Each one has its own on/off switch and settings.

## What you can do here

- **Browser History** — let the agent read your existing Chrome history so
  it can build research clusters and add revisit nudges to the morning
  digest.
- **Browser Automation** — set up the dedicated, sandboxed Chromium (a
  separate, isolated browser) that the agent drives for sign-in (OAuth)
  sites and task slots. A hostname denylist limits which sites it may open.
- **Purchase Confirmations** — the experimental B-4 flow. Before the agent
  can go through with a purchase, it must use a single-use token that is
  sent to you by DM. This is off by default.
- **Browser tasks** — review the tasks the agent has run, including any
  waiting for your confirmation, one click away at `/browser-tasks`.

## Where to go deeper

- [Managed Chromium](../features/operations/managed-chromium.md) — the
  sandboxed browser the agent drives.
- [Browser tasks](../features/operations/browser-tasks.md) — how a browser
  task is requested, run, and confirmed.
- [Browser history](../features/integrations/browser-history.md) — reading
  from your existing Chrome.

## Related

- [Connections page](connections.md) — where other integrations are linked.
- [Settings page](settings.md) — Browser History and Automation also have
  settings panels.
