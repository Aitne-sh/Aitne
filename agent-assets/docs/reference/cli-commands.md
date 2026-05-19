---
schema_version: 1
slug: reference/cli-commands
title: CLI Commands
id: cli-commands
aliases:
  - cli
  - commands
  - aitne cli
  - pnpm scripts
category: reference
summary: |
  Lookup table for the aitne / pnpm commands that drive the daemon and
  dashboard, plus the environment variables that override defaults.
section: cli
tags:
  - core
  - reference
  - cli
  - operations
status: stable
ask_examples:
  - What command starts the daemon?
  - How do I stop Aitne?
  - How do I tail the daemon log?
  - Where does Aitne put its data?
  - How do I see what the agent has been doing?
  - How do I check my install with aitne doctor?
locale: en-US
created: 2026-04-27
updated: 2026-05-15
keywords:
  - aitne start
  - aitne stop
  - aitne restart
  - aitne status
  - aitne logs
  - aitne doctor
  - aitne audit
  - aitne setup
  - aitne open
  - aitne update
  - aitne uninstall
  - pnpm start
  - PA_DATA_DIR
  - PA_API_PORT
related:
  - guides/install-and-run
  - guides/reinstall-cleanly
  - features/wiki/commands
---

# CLI Commands

## `aitne` and `pnpm` are equivalent

`aitne` is the project's CLI (`bin/aitne.mjs`). The `pnpm <cmd>` forms are
workspace scripts that delegate to the same entry point. Use whichever you
prefer — `aitne start` and `pnpm start` do the same thing. After installing
the npm package globally (`npm i -g aitne`) the `aitne` binary is on
your `$PATH` and you no longer need to be inside the repo to use it. The
tables below show both forms.

## Lifecycle

| Command | What it does |
|---|---|
| `aitne start` / `pnpm start` | Build (if stale), then launch daemon + dashboard in the background. |
| `aitne stop` / `pnpm stop` | Graceful shutdown (SIGTERM → SIGKILL after 10s) of both processes. |
| `aitne restart` | `stop` then `start`. `--clean-context` wipes `context/` after a tarball backup. (Prefer the bin over `pnpm restart` / `npm restart`: those run the npm `stop` → `restart` → `start` lifecycle, which would re-fire each step.) |
| `aitne status` / `pnpm status` | PIDs, uptime, integrations, today's spend, last action timestamp, next scheduled item. |
| `aitne dev` / `pnpm dev` | Foreground mode — runs the daemon + dashboard with full stdio. |

## Operations

| Command | What it does |
|---|---|
| `aitne setup` | (Re-)open the dashboard `/setup` wizard; auto-starts the daemon if needed. |
| `aitne open` | Open the dashboard root in the default browser. |
| `aitne doctor` | Eight install-health checks (Node, ports, OS keychain, backend CLIs, native bindings, …). |
| `aitne audit [--since 24h] [--type X] [--result failed]` | Show the agent action log; flags filter by time, action type, result, or backend. `--json` for machine-readable. |
| `aitne version [--json]` | Print version, Node version, install path, last build time. |
| `aitne update [--check]` | Print the npm command to upgrade. `--check` makes one network call to compare against the latest published version. |
| `aitne uninstall [--keep-data\|--wipe-data]` | Stop the services, then offer to wipe `~/.personal-agent`. |

## Logs

| Command | What it does |
|---|---|
| `aitne logs` / `pnpm logs` | Print the daemon log (most recent lines). |
| `aitne logs -f` | Tail the daemon log. |
| `aitne logs -d` | Print the dashboard log instead. |
| `aitne logs -n N` | Last N lines. |

## Build and test

| Command | What it does |
|---|---|
| `pnpm install` | Install workspace dependencies (pnpm 10.x, Node ≥ 22). |
| `pnpm build` | Turbo build — shared → daemon → dashboard. |
| `pnpm test` | Run the vitest suite (compiles first if stale). |
| `pnpm test:watch` | Vitest in watch mode. |
| `pnpm lint` | Run eslint per package. |
| `pnpm clean` | Remove `node_modules`, `dist`, `.buildstamp`. |

## Wiki bang commands

Sent as DMs from a paired channel, not from the shell. Every command
accepts an optional `@<workspace>` token immediately after the bang to
target a non-default workspace. See
[Wiki Commands](../features/wiki/commands.md) for the full reference
and the cost-gate / approval semantics.

| Command | What it does |
|---|---|
| `!ingest [@<ws>] <url> [url...]` | Capture one or more URLs into the workspace's `10_raw/` layer. Caps at 10 URLs per batch; parallel or serial fan-out per the workspace's dispatch mode. |
| `!compile [@<ws>]` | Incremental compile — synthesises only raw notes touched since the last run into `20_wiki/`. |
| `!compile [@<ws>] --preview` | Dry-run touch list (added / modified / unchanged) plus cost and ETA. No agent session runs. Alias: `--dry-run`. |
| `!compile [@<ws>] full` | Full rebuild. Cost-gated: estimates above the per-workspace threshold queue a dashboard approval. On a clean external git vault, an automatic pre-compile snapshot is committed first. |
| `!compile [@<ws>] full --preview` | Dry-run of the full rebuild. |
| `!ask [@<ws>] <question>` | Cited answer from the workspace, written to `30_outputs/`. |
| `!lint [@<ws>]` | Audit orphans, broken links, schema drift, taxonomy candidates, stale notes. Writes `90_meta/health/<YYYY-MM-DD>.md`. |
| `!trace [@<ws>] <topic>` | Reconstruct how an idea has evolved across `10_raw` / `20_wiki` / `30_outputs`. |
| `!connect [@<ws>] <A>, <B>` | Find shared structure and bridges between two areas. |
| `!wiki` | Workspace status (per-workspace counts when multiple are active). |
| `!wiki help` | Wiki command list. |

## Environment overrides

| Variable | Default | What it controls |
|---|---|---|
| `PA_DATA_DIR` | `~/.personal-agent` | Where logs, the SQLite DB, context Markdown, and prompts live. |
| `PA_API_PORT` | `8321` | Daemon HTTP port. |
| `PA_DASHBOARD_PORT` | `3000` | Dashboard port. |

All runtime state — PIDs, logs, SQLite DB, context Markdown, prompts —
lives under `PA_DATA_DIR`, **not** inside the repo.

## Where data lives

```
~/.personal-agent/
├── data/personal_agent.db    # SQLite (sessions, actions, observations, FTS)
├── context/                  # Markdown memory the agent reads and writes
│   ├── user/profile.md       # user identity + topic slices alongside
│   ├── today.md
│   ├── roadmap.md
│   ├── agent/journal.md
│   ├── projects/
│   ├── schedule/
│   ├── daily/                # Per-day archives (YYYY-MM-DD.md)
│   ├── rules/                # Management registry + policies index
│   └── …
├── logs/                     # Daemon and dashboard logs
└── pids/                     # Process IDs for aitne start/stop
```

## Related

- [Install and Run](../guides/install-and-run.md) — the procedural
  guide that uses these commands end-to-end.
- [Reinstall Cleanly](../guides/reinstall-cleanly.md) — when you need
  to wipe state and start over.
