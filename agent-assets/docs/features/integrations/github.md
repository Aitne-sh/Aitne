---
schema_version: 1
slug: features/integrations/github
title: GitHub
id: github
aliases:
  - github integration
  - github poller
  - github notifications
  - github delegated mode
category: features
summary: |
  GitHub is the remote-side counterpart to the Git integration. The
  daemon polls notifications and CI failures via the local `gh` CLI;
  high-priority signals (review requests, default-branch CI failures,
  security alerts, assignments) become direct DMs. Watched repos are
  registered as unified Repository rows, not config keys.
section: integrations
tags:
  - integrations
  - github
  - observations
  - polling
status: stable
ask_examples:
  - How do I connect GitHub?
  - Will the agent message me on every CI failure?
  - Can the agent reply to GitHub issues?
  - Where do I add a GitHub repo to watch?
locale: en-US
created: 2026-04-25
updated: 2026-05-28
keywords:
  - github
  - issue
  - pull request
  - PR review
  - workflow run
  - security alert
  - delegated mode
  - gh cli
  - repositories
related:
  - features/integrations/git
  - concepts/observations
  - concepts/delegated-mode
ui_anchors:
  - /connections/repositories
config_keys:
  - githubPollIntervalSeconds
api_endpoints:
  - PATCH /api/integrations/github
process_keys:
  - github.pull_request.review_requested
  - github.assigned
  - github.security_alert
  - github.workflow_run.failed
context_files:
  - state/today.md
---

# GitHub

The daemon polls GitHub via the local `gh` CLI: review requests, CI
failures on the default branch, security alerts, and assignments
become DMs; everything else is recorded for the hourly check.

## What It Does

- **Polls Notifications** every `githubPollIntervalSeconds` (default
  1800s / 30 min) using ETag caching — 304 responses cost no
  rate-limit quota.
- **Polls workflow_runs** per watched GitHub repository, filtered by
  `status=failure`. Each repo's GitHub side comes from a unified
  **Repository** row (a `owner/repo` remote, optionally paired with a
  local clone — see [Setup](#setup)). Per-repo cadence overrides apply
  to the workflow-runs side; the notifications poll always runs at the
  global cadence.
- **DMs the user** on the four high-priority triggers below; quieter
  signals are coalesced into the hourly check summary.

The agent never auto-comments, auto-merges, or pushes.

## High-priority events

The agent will DM the user (priority `high`, can break quiet hours
depending on your notify-skill settings) on:

- A teammate or bot **requested your review** on a PR.
- You were **assigned** to an issue or PR.
- A **Dependabot or code-scanning security alert** fired on a watched
  repository.
- A **default-branch CI failure** (feature-branch failures stay
  observation-only — they're the normal developer feedback loop).

Each DM follows the notify skill's awareness-gate: if the agent already
sees you triaging it in `state/today.md`, it stays silent and just logs.

## Setup

1. Install `gh`: `brew install gh` on macOS; see
   [cli.github.com](https://cli.github.com/) for other platforms.
2. Authenticate: `gh auth login` (browser flow).
3. Register the repos to watch on **Connections → Repositories**. Each
   row links an `owner/repo` GitHub remote, an optional local clone, or
   both. If you link only a local clone, the poller derives `owner/name`
   from its `origin` remote — non-GitHub remotes are silently skipped.
4. Restart the daemon (the poll interval is captured at start time).

The daemon does NOT need a personal access token in its keychain — it
re-uses whatever `gh` already has.

## Cold-start behavior

The first time the daemon polls a watched repo's **workflow runs**, it
records the latest failures **without emitting any events**. This
prevents a flood of DMs about historical CI failures you have already
triaged. New failures landing after that warm-up are surfaced normally.

The notifications side needs no warm-up: GitHub returns only unread
items, so there is no historical backlog to suppress.

## Where in the Dashboard

Everything lives on **Connections → Repositories**
(`/connections/repositories`):

- The GitHub integration card shows status, the `gh auth login` hint,
  and the integration mode picker (see [Modes](#modes)).
- Each repository row links an `owner/repo` GitHub remote and/or a
  local clone. When at least one row has a GitHub remote, notification
  processing is scoped to those repos.
- Per-repo polling cadence, automation triggers, and daily git
  management are configured on **My Life → Git** (`/git`), not here.

## Configuration

| Setting | Default | Notes |
|---|---|---|
| `githubPollIntervalSeconds` | 1800 (30 min) | Global poll cadence. Lower for faster review-request alerts at the cost of slightly more rate-limit budget. **Restart-required.** |

Watched repos are no longer config keys. The old `gitRepos` /
`githubRepos` settings were removed at the unified-repositories
cutover — repos now live in the `repositories` table and are managed on
**Connections → Repositories**. Per-repo polling cadence is set on
**My Life → Git** and overrides the global interval for that repo's
workflow-runs poll.

## When Something Goes Wrong

- **No DMs after enabling.** Run `gh auth status` from your shell. If
  it reports anything other than logged-in, the daemon log will show
  a backoff message — re-run `gh auth login` and the next poll tick
  picks up.
- **`gh` not installed.** Daemon logs warn with the install command;
  the observer keeps retrying with exponential backoff (capped at
  ~16 ticks).
- **Default branch detected as `main` but mine is `master`.** The
  one-time `gh api repos/<o>/<r> --jq .default_branch` lookup at
  startup failed (rate limit or transient). Restart after the
  condition clears.
- **Repeated DMs for the same notification.** Should not happen — the
  poller pre-checks `observations(source, ref)` before every emit. If
  it does, file a bug with the notification id.

## Modes

GitHub supports three integration modes: `direct` (default),
`delegated`, and `disabled`. Native mode is not offered — the
backend-side connectors are read-only `gh` CLI wrappers that do not
need a daemon-spawned poller's bookkeeping.

- **direct** — the daemon's `GitHubPoller` runs as described above.
  Use this when you want the daemon to own the poll schedule and to
  emit DMs without the main backend having to wake up.
- **delegated** — the delegated-sync worker invokes the chosen
  backend's read-only `gh` CLI surface on opt-in cadences (see
  [Delegated Mode](../../concepts/delegated-mode.md) and
  `docs/design/appendices/delegated-sync-opt-in.md`). The daemon
  poller stays off; the lite-tier delegated session takes the polling
  cost.
- **disabled** — neither the poller nor the delegated worker runs;
  the integration is silent.

Pick the mode from the GitHub card on **Connections → Repositories**.
Mode changes go through the standard `PATCH /api/integrations/github`
flip-lock so the poller and the delegated worker never run
simultaneously.

## Related

- [Git](git.md) — local repo file watcher (separate observer).
- [Hourly Check](../routines/hourly-check.md) — the consumer of
  non-DM-priority observations.
- [Delegated Mode](../../concepts/delegated-mode.md) — how the
  `delegated` mode polls without a daemon poller.
