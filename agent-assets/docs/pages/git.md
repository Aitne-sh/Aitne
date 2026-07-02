---
schema_version: 1
slug: pages/git
title: "Git Page"
id: page-git
aliases:
  - git page
  - repositories page
category: pages
summary: |
  The Git page configures how the agent watches each registered
  repository — polling cadence, automation triggers, and the daily git
  management the morning routine performs. Repositories are registered on
  the Connections page.
tags:
  - git
  - lifestyle
status: stable
ask_examples:
  - What can I do on the Git page?
  - How do I change how often the agent checks a repo?
  - Where do I set up automation triggers for a repository?
  - How do I add a repository?
locale: en-US
created: 2026-07-01
updated: 2026-07-01
keywords:
  - git
  - repositories
  - polling
  - triggers
  - daily management
related:
  - features/lifestyle/git
  - features/integrations/git
  - features/integrations/github
ui_anchors:
  - /git
---

# Git Page

The `/git` page is where you fine-tune how the agent handles each
repository you've registered. Every registered repo shows three
collapsible sections.

## What you can do here

- **Polling** — how often the agent checks the repo for changes.
- **Triggers** — automation rules that start follow-up work when a change
  matches a rule you set.
- **Daily git management** — the routine upkeep the morning routine runs
  on the repo each day.

You add repositories on the Connections page
(`/connections/repositories`), not here. If you haven't registered any
yet, this page just shows a "No repositories registered" prompt that links
you there.

## Where to go deeper

- [Git (lifestyle)](../features/lifestyle/git.md) — how the agent watches
  and reports on your repos.
- [Git integration](../features/integrations/git.md) — registering and
  authenticating repositories.
- [GitHub integration](../features/integrations/github.md) — the GitHub
  side (PRs, issues).

## Related

- [Connections page](connections.md) — register repositories here first.
- [Agents page](agents.md) — the morning routine that runs daily git
  management.
