---
schema_version: 1
slug: features/integrations/git
title: Git
id: git
aliases:
  - git repos
  - git observer
  - git integration
category: features
summary: |
  Watch one or more git repositories for new commits. Changes record
  observations the hourly check coalesces — there is no per-commit
  notification spam.
section: integrations
tags:
  - integrations
  - git
  - observations
status: stable
ask_examples:
  - How do I add a git repo to watch?
  - Will the agent message me on every commit?
  - Can the agent push to my repos?
locale: en-US
created: 2026-04-25
updated: 2026-04-25
keywords:
  - git
  - commit
  - repository
  - observer
related:
  - features/integrations/github
  - features/routines/hourly-check
  - concepts/observations
ui_anchors:
  - /connections/repositories
config_keys:
  - gitPollIntervalSeconds
---

# Git

Add local git repositories to a watched set; the daemon polls them
and the hourly check decides whether the recent activity is worth
flagging.

## What It Does

- **Polls** each watched repo every `gitPollIntervalSeconds`.
- **Records observations** when new commits land between polls. The
  commit author is included so agent-originated commits do not
  re-surface to the agent (defended via `AgentWriteTracker`).
- **Surfaces patterns**, not individual commits — three small commits
  in an hour will not page you.

The agent never pushes, never amends, never force-resets. Read-only
by design.

## When It Runs / How It Is Triggered

- The poller is continuous.
- The hourly check consumes the accumulated observations.

## What It Outputs

- An `observation` row per detected change set.
- A summary in the hourly check's output when observations qualified.

## Where in the Dashboard

- **Connections → Git** lists the watched paths and last-poll times.

## Configuration

| Setting | Default | Notes |
|---|---|---|
| `gitPollIntervalSeconds` | 300 | How often to scan watched repos. |

## When Something Goes Wrong

- A **missing observation** for a commit you just made: check that the
  repo path is actually watched on `/connections/git` and that the
  poll has fired since.
- A repo that **never appears** in observations: the agent's own
  writes are filtered out (see `AgentWriteTracker`); make sure the
  commit was authored by you, not by an agent session.

## Related

- [GitHub](github.md) — separate integration for remote-side data.
- [Hourly Check](../routines/hourly-check.md) — the consumer.
