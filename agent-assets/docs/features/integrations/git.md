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
  observations the activity scan coalesces — there is no per-commit
  notification spam.
section: integrations
tags:
  - integrations
  - git
  - observations
  - polling
status: stable
ask_examples:
  - How do I add a git repo to watch?
  - Will the agent message me on every commit?
  - Can the agent push to my repos?
  - How often does the daemon poll my repos?
locale: en-US
created: 2026-04-25
updated: 2026-06-07
keywords:
  - git
  - commit
  - repository
  - observer
  - polling
related:
  - features/integrations/github
  - features/routines/activity-scan
  - concepts/observations
ui_anchors:
  - /connections/repositories
  - /git
config_keys:
  - gitPollIntervalSeconds
process_keys:
  - git.push.detected
  - git.lifecycle.poll
api_endpoints:
  - /api/git/log
  - /api/git/diff
  - /api/git/show
---

# Git

Add local git repositories to a watched set; the daemon polls them
and the activity scan decides whether the recent activity is worth
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
- The activity scan consumes the accumulated observations.

## What It Outputs

- An `observation` row per detected change set.
- A summary in the activity scan's output when observations qualified.

## Where in the Dashboard

- **Connections → Repositories** lists the watched paths. Git repos are
  managed as part of the unified Repositories surface (the same place
  that links a local checkout to its GitHub remote).
- **My Life → Git** (`/git`) configures per-repo polling cadence,
  automation triggers, and daily git management.

## Configuration

| Setting | Default | Notes |
|---|---|---|
| `gitPollIntervalSeconds` | 3600 | How often to scan watched repos. |

## When Something Goes Wrong

- A **missing observation** for a commit you just made: check that the
  repo path is actually watched on `/connections/repositories` and that
  the poll has fired since (it runs every `gitPollIntervalSeconds`).
- A repo that **never appears** in observations: the agent's own
  writes are filtered out (see `AgentWriteTracker`); make sure the
  commit was authored by you, not by an agent session.

## Related

- [GitHub](github.md) — separate integration for remote-side data.
- [Activity Scan](../routines/activity-scan.md) — the consumer.
