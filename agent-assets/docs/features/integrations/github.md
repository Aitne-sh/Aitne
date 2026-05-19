---
schema_version: 1
slug: features/integrations/github
title: GitHub
id: github
aliases:
  - github integration
  - github poller
  - github notifications
category: features
summary: |
  GitHub is the remote-side counterpart to the Git integration. The
  daemon polls notifications and CI failures via the local `gh` CLI;
  high-priority signals (review requests, default-branch CI failures,
  security alerts, assignments) become direct DMs.
section: integrations
tags:
  - integrations
  - github
  - observations
status: stable
ask_examples:
  - How do I connect GitHub?
  - Will the agent message me on every CI failure?
  - Can the agent reply to GitHub issues?
locale: en-US
created: 2026-04-25
updated: 2026-04-28
keywords:
  - github
  - issue
  - pull request
  - PR review
  - workflow run
  - security alert
related:
  - features/integrations/git
  - concepts/observations
ui_anchors:
  - /connections/repositories
---

# GitHub

## In One Sentence

The daemon polls GitHub via the local `gh` CLI: review requests, CI
failures on the default branch, security alerts, and assignments
become DMs; everything else is recorded for the hourly check.

## What It Does

- **Polls Notifications** every `githubPollIntervalSeconds` (default
  600s) using ETag caching — 304s cost no rate-limit quota.
- **Polls workflow_runs** per watched GitHub repository on the same
  cadence, filtered by `status=failure`. Watched repos can come from a
  local clone's GitHub `origin` or from an explicit `owner/repo` entry.
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
sees you triaging it in `today.md`, it stays silent and just logs.

## Setup

1. Install `gh`: `brew install gh` on macOS; see
   [cli.github.com](https://cli.github.com/) for other platforms.
2. Authenticate: `gh auth login` (browser flow).
3. Add `owner/repo` entries to **Connections → GitHub**, or add local
   repository paths to **Connections → Git Repositories**. For local
   paths, the poller derives `owner/name` from each repo's `origin`
   remote — non-GitHub remotes are silently skipped.
4. Restart the daemon (the poll interval is captured at start time).

The daemon does NOT need a personal access token in its keychain — it
re-uses whatever `gh` already has.

## Cold-start behavior

The first time the daemon polls a watched repo, it records the latest
failed workflow runs **without emitting any events**. This prevents a
flood of DMs about historical CI failures the user has already triaged.
New failures landing after that warm-up are surfaced normally.

## Where in the Dashboard

- **Connections → GitHub** shows status and the `gh auth login`
  hint.
- **Connections → GitHub** controls explicit `owner/repo` watched repos.
  When this list is non-empty, notification processing is scoped to it.
- **Connections → Git Repositories** controls local clone paths whose
  GitHub remotes are watched for workflow_run failures.

## Configuration

| Setting | Default | Notes |
|---|---|---|
| `githubPollIntervalSeconds` | 600 (10 min) | Both poll cadences. Lower for faster review-request alerts at the cost of slightly more rate-limit budget. **Restart-required.** |
| `gitRepos` | `[]` | Local repo paths to watch. |
| `githubRepos` | `[]` | Direct remote repos in `owner/repo` form. Also scopes notification processing when non-empty. |

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

## Delegated mode (coming soon)

A future release will let Claude Code, Codex, or Gemini CLI handle
GitHub directly via their native MCP / `gh` integrations, optionally
replacing the daemon-side poller. Most users won't need this — the
built-in poller already covers the common surface — but it'll be
useful if you'd rather skip the daemon-side polling entirely.

## Related

- [Git](git.md) — local repo file watcher (separate observer).
- [Hourly Check](../routines/hourly-check.md) — the consumer of
  non-DM-priority observations.
