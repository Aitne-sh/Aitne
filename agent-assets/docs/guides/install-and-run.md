---
schema_version: 1
slug: guides/install-and-run
title: Install and Run
id: install-and-run
aliases:
  - install
  - installation
  - first install
  - first run
  - get aitne running
category: guides
summary: |
  Install Aitne via the npm package (or clone the repo for development),
  start the daemon and dashboard, and open the dashboard at :3000.
section: install-and-run
tags:
  - core
  - guide
  - getting-started
  - install
  - setup
  - operations
status: stable
ask_examples:
  - How do I install Aitne?
  - What command starts the daemon?
  - Where does Aitne put its data?
  - How do I install the aitne npm package?
locale: en-US
created: 2026-04-25
updated: 2026-05-15
keywords:
  - install
  - first run
  - pnpm
  - npm install aitne
  - aitne start
  - PA_DATA_DIR
  - node 22
related:
  - reference/cli-commands
  - guides/reinstall-cleanly
  - guides/migrate-machines
  - getting-started/02-first-steps
---

# Install and Run

## Goal

Get the daemon and dashboard running on your machine so you can step
through the setup wizard.

## Prerequisites

- Node ≥ 22, pnpm 10.x.
- A provider API key for at least one backend you intend to use:
  Anthropic (`ANTHROPIC_API_KEY`), OpenAI (`OPENAI_API_KEY`), or
  Google (`GEMINI_API_KEY` / `GOOGLE_API_KEY`). API keys are the
  recommended and provider-supported way to run Aitne. If you skip
  the key, Aitne falls back to the corresponding CLI's local
  subscription login (`claude`, `codex login`, `gemini auth`); see
  [Costs and Quotas](../concepts/costs-and-quotas.md) for the trade-
  offs and the provider policies that apply.
- The CLI binary for whichever backend you pick (Claude Code, Codex
  CLI, or Gemini CLI) installed on `PATH`.
- ~200 MB of disk for the daemon's local state.

## Steps

1. `git clone <repo> personal_agent && cd personal_agent`
2. `pnpm install`
3. `pnpm start` — builds (if stale) and launches daemon + dashboard
   in the background.
4. Open `http://localhost:3000` and follow the setup wizard.

## Verification

- `pnpm status` shows two PIDs (daemon + dashboard) and a green health
  pill.
- `~/.personal-agent/` has been created with `data/personal_agent.db`,
  `context/`, and the log directory.

## If It Fails

- A port conflict — set `PA_API_PORT` (default 8321) or
  `PA_DASHBOARD_PORT` (default 3000).
- Build errors during `pnpm start`: run `pnpm clean && pnpm build`
  for verbose output.

## Related

- [CLI Commands](../reference/cli-commands.md) — full `pa` command
  list and environment overrides.
- [Setup Wizard](setup-wizard.md) — what each wizard step does.
- [Reinstall Cleanly](reinstall-cleanly.md) — wipe and start over.
