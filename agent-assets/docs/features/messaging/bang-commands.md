---
schema_version: 1
slug: features/messaging/bang-commands
title: Bang Commands
id: bang-commands
aliases:
  - "!stop"
  - "!start"
  - "!cost"
  - "!report"
  - "!help"
  - exclamation commands
  - chat commands
category: features
summary: |
  Short owner-only commands typed in any paired DM (Slack, Telegram,
  Discord, WhatsApp, dashboard chat) that the daemon answers directly,
  with no agent backend involved and no cost. Use them to pause /
  resume, check spend, see recent failures, and list every command.
section: messaging
tags:
  - core
  - messaging
  - operations
status: stable
ask_examples:
  - How do I pause the agent from my phone?
  - What can I type in the DM to control Aitne?
  - How do I list all the commands?
  - Where do I see how much the agent spent this week?
locale: en-US
created: 2026-05-12
updated: 2026-05-12
keywords:
  - bang command
  - "!stop"
  - "!start"
  - "!cost"
  - "!report"
  - "!help"
  - pause
  - resume
related:
  - features/messaging/overview
  - features/messaging/pairing-and-magic-phrase
  - guides/pause-the-agent
  - features/operations/cost-tracking
ui_anchors:
  - /settings/commands
---

# Bang Commands

## In One Sentence

DM the agent a short word starting with `!` and the daemon answers
directly — no LLM call, no cost, no session opened.

## Who Can Use Them

Only the **paired owner channel**. A bang from any other sender is
dropped by the same single-owner filter that drops every other DM.
Pair your messaging app first; see
[Pairing & Magic Phrase](pairing-and-magic-phrase.md).

## Available Commands

| Command | What it does |
|---|---|
| `!help` | Lists every command currently registered — built-ins plus any custom user commands. |
| `!stop` | Pauses cron-driven autonomous work (hourly check, morning / evening / weekly routines, scheduled tasks). In-flight runs are **not** aborted. |
| `!start` | Resumes autonomous work after `!stop`. |
| `!close` | Closes the active DM session for the current routing tuple so the next DM starts a fresh conversation. Returns `null` if no session was open. |
| `!cost` | Last-7-day spend across all backends. |
| `!cost claude` / `!cost codex` / `!cost gemini` / `!cost opencode` | Spend for a single backend (one row per registered backend). |
| `!report` | Recent agent failures (last 7 days, top groups, most recent sample). |
| `!wiki` | Wiki status snapshot (workspaces, recent ingests / compiles, queue depth). |
| `!ingest <url>` | Ingest a URL into the wiki raw layer. Enqueues `wiki.ingest_url`. |
| `!compile [full]` | Run wiki compile (raw → wiki synthesis). `full` mode crosses the per-workspace cost threshold and routes through the dashboard approval queue. |
| `!ask <question>` | Q&A against the compiled wiki. Reply lands back on the same channel. |
| `!lint` | Wiki health pass — writes `90_meta/health/<date>.md`. |
| `!trace <idea>` | Chronological evolution of an idea across raw / wiki / outputs layers. |
| `!connect <A> <B>` | Bridge two domains; writes `30_outputs/<date>-connect-<slug>.md`. |

Wiki commands accept an optional `@<workspace>` suffix
(e.g. `!compile @work`) to target a specific workspace when multiple
are configured. Custom commands added at `/settings/commands` show
up in `!help` automatically — no restart needed.

## How They Look

Every reply leads with a `[SYSTEM · <command>]` marker so you can tell
at a glance it came from the daemon, not the agent:

```
[SYSTEM · !cost · last 7d]
Total: $1.42 (37 sessions)

- claude: $1.10 (29 sessions)
- codex:  $0.32 ( 8 sessions)
- gemini: $0.00 ( 0 sessions)
```

`!help` lists each entry with the name on its own line and the
description indented:

```
[SYSTEM · !help]

Built-in:

!cost
  Show last-7-day Claude / Codex / Gemini spend.

!help
  Show every registered command.

!report
  Show recent agent failures.

!start
  Resume autonomous work after !stop.

!stop
  Pause cron-driven autonomous work. In-flight runs are not aborted.
```

The `Custom:` section appears below the built-ins when you have
enabled user commands at `/settings/commands`.

## How They Behave

- **Exact match.** `!stop`, `!cost`, `!cost claude` are recognised;
  `!stop now please` is not — it falls through to the agent path.
- **DM only.** Bangs typed into a shared channel are ignored.
- **No cost.** No LLM is invoked; no `conversation_sessions` row is
  opened. Every invocation writes one `bang_command` row to
  `agent_actions` for the activity log.
- **While paused**, any DM (bang or not) replies with the paused
  notice; only `!start`, `!cost`, `!report`, `!help`, and `!close`
  continue to run.
- **Replies land where the command did** — same platform, same
  channel, same thread.

## Pause vs. `aitne stop`

`!stop` pauses **autonomous** work; the daemon stays up so it can
receive `!start`. It is the right tool for "be quiet for a bit".

`aitne stop` (CLI) shuts the daemon down entirely. Use it when you
want everything off, including the message receivers. See
[Pause the Agent](../../guides/pause-the-agent.md) for the longer-
window version.

## When Something Goes Wrong

- **No reply at all.** The DM is probably hitting an unpaired channel
  — pair first. See [Messaging Overview](overview.md).
- **The reply lists fewer commands than you expect.** `!help` only
  lists *enabled* user commands. Toggle the row on at
  `/settings/commands`.
- **`!cost foo` says "unknown command".** Valid backend arguments
  match the registered backends — `claude`, `codex`, `gemini`,
  `opencode`. Plain `!cost` (no argument) covers all of them.

## Related

- [Messaging Overview](overview.md)
- [Pairing & Magic Phrase](pairing-and-magic-phrase.md)
- [Pause the Agent](../../guides/pause-the-agent.md)
- [Cost Tracking](../operations/cost-tracking.md)
