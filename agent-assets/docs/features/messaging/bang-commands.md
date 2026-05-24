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
  - "!checks"
  - "!research"
  - exclamation commands
  - chat commands
category: features
summary: |
  Short owner-only commands typed in any paired DM (Slack, Telegram,
  Discord, WhatsApp, dashboard chat) that the daemon answers directly,
  with no agent backend involved and no cost. Use them to pause /
  resume, check spend, see recent failures, manage research clusters,
  and list every command.
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
  - What did I keep refreshing today?
  - How do I accept a research-cluster offer?
locale: en-US
created: 2026-05-12
updated: 2026-05-22
keywords:
  - bang command
  - "!stop"
  - "!start"
  - "!cost"
  - "!report"
  - "!help"
  - "!checks"
  - "!research"
  - pause
  - resume
related:
  - features/messaging/overview
  - features/messaging/pairing-and-magic-phrase
  - guides/pause-the-agent
  - features/operations/cost-tracking
  - features/integrations/browser-history
ui_anchors:
  - /settings/commands
---

# Bang Commands

DM the agent a short word starting with `!` and the daemon answers
directly — no LLM call, no cost, no session opened. Use them to pause,
check spend, look at recent failures, manage research clusters, and
list every command.

## Who Can Use Them

Only the **paired owner channel**. A bang from any other sender is
dropped by the same single-owner filter that drops every other DM.
Pair your messaging app first; see
[Pairing & Magic Phrase](pairing-and-magic-phrase.md).

## Available Commands

### Lifecycle

| Command | What it does |
|---|---|
| `!help` | List every registered command — built-ins plus enabled user commands. |
| `!stop` | Pause cron-driven autonomous work (hourly check, morning / evening / weekly routines, scheduled tasks). In-flight runs are **not** aborted. |
| `!start` | Resume autonomous work after `!stop`. |
| `!close` | Close the active DM session for the current routing tuple so the next DM starts a fresh conversation. |

### Reporting (pure DB reads, safe while paused)

| Command | What it does |
|---|---|
| `!cost` | Last-7-day spend across all backends. |
| `!cost claude` · `!cost codex` · `!cost gemini` · `!cost opencode` | Spend for a single backend (one row per registered backend). |
| `!report` | Recent agent failures (last 7 days, top groups, most recent sample). |
| `!checks` | Today's top browser reload patterns (domain + first path segment). Pure read on `browser_reload_signals`; anchored on the agent-day (`dayBoundaryHour`). Empty state is the common case for a quiet day. |

### Research clusters (browser-history)

`!research` is a prefix command that takes a subcommand. Clusters are
derived from your browser history when a topic crosses the
meaningful-visits threshold; see
[Browser History](../integrations/browser-history.md).

| Command | What it does |
|---|---|
| `!research` | List active + dormant clusters (top 12, with visits / hours / domains / status). |
| `!research <slug>` | Show full detail for one cluster. |
| `!research accept <slug>` | Accept a research-dive offer. Enqueues `routine.research_dispatch`. |
| `!research wiki <slug>` | Accept a wiki-summary offer. Enqueues `routine.research_wiki_summary`. |
| `!research decline <slug>` | Silence offers for 14 days; cluster journal keeps updating. |
| `!research mute <slug>` / `unmute <slug>` | Toggle offers off (until unmute) / restore. |
| `!research rename <slug> <new name>` | Change display name (≤ 120 chars). |
| `!research conclude <slug>` | Mark concluded; the `context/research/<slug>.md` journal is preserved. |

### Wiki

Wiki commands accept an optional `@<workspace>` suffix
(e.g. `!compile @work`) to target a non-default workspace. See
[Wiki Commands](../wiki/commands.md) for the full reference and the
cost-gate / approval semantics.

| Command | What it does |
|---|---|
| `!wiki` | Workspace status (per-workspace counts when multiple are configured). |
| `!wiki help` | Wiki command list. |
| `!ingest <url> [url…]` | Capture URLs into the workspace's `10_raw/` layer (max 10 per batch). |
| `!compile [full] [--preview]` | Synthesise raw → wiki. `full` triggers an approval gate above the per-workspace cost threshold; `--preview` is a JS-only dry-run. |
| `!ask <question>` | Cited Q&A against the compiled wiki. Reply lands on the same channel; output saved to `30_outputs/`. |
| `!lint` | Wiki health pass — writes `90_meta/health/<date>.md`. |
| `!trace <idea>` | Chronological evolution of an idea across `10_raw` / `20_wiki` / `30_outputs`. |
| `!connect <A>, <B>` | Bridge two domains; writes `30_outputs/<date>-connect-<slug>.md`. |

Custom commands added at `/settings/commands` show up in `!help`
automatically — no restart needed.

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

- **Exact match for atomic commands** (`!stop`, `!cost`, `!checks`)
  and **prefix match for parameterised ones** (`!cost claude`,
  `!research accept <slug>`, `!compile @work full`). Anything
  spanning newlines falls through to the agent path so a
  `"!stop\nignore me"` payload cannot spoof a command.
- **DM only.** Bangs typed into a shared channel are ignored.
- **No agent cost on built-ins.** No LLM is invoked for the
  daemon-side commands; one `bang_command` row is appended to
  `agent_actions` for the activity log. `!compile`, `!ingest`,
  `!ask`, `!lint`, `!trace`, `!connect`, and `!research accept|wiki`
  *do* enqueue agent sessions and therefore *do* cost.
- **While paused**, any DM (bang or not) replies with the paused
  notice; only commands that opt into `runsWhilePaused` continue to
  run: `!start`, `!stop`, `!cost`, `!report`, `!help`, `!close`,
  `!wiki` (status), `!checks`, and the read-only `!research` subcommands
  (list / show / mute / unmute / rename / decline / conclude).
  LLM-dispatching commands reply with a command-aware "unavailable while
  paused" notice instead of executing.
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
- [Browser History](../integrations/browser-history.md) — source of
  `!checks` and the `!research` clusters.
