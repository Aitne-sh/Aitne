---
schema_version: 1
slug: getting-started/01-what-is-this
title: What is Aitne?
id: what-is-this
aliases:
  - aitne
  - what is aitne
  - what is this
  - introduction
  - personal AI agent
category: getting-started
summary: |
  Aitne is a local-first proactive personal AI agent. It runs
  as a daemon on your own machine, calls Claude / Codex / Gemini via
  API keys you register (with the local CLI's subscription auth as a
  fallback), and stores all memory as plain Markdown files.
section: getting-started
tags:
  - core
  - getting-started
  - overview
status: stable
ask_examples:
  - What is Aitne?
  - How is this different from ChatGPT?
  - Where does my data live?
  - What can Aitne actually do for me?
  - Which backends can Aitne drive?
locale: en-US
keywords:
  - introduction
  - overview
  - what is aitne
  - personal agent
  - local-first
  - proactive
  - markdown memory
  - backends
created: 2026-04-25
updated: 2026-05-15
related:
  - getting-started/02-first-steps
  - getting-started/03-what-can-this-do
  - getting-started/04-first-day
  - concepts/memory-model
  - concepts/backends-and-tiers
---

# What is Aitne?

Aitne is a local-first personal AI agent. It runs as a long-running
daemon on your own machine, drives Claude Code, Codex CLI, Gemini
CLI, or OpenCode (`@opencode-ai/sdk` server) via provider API keys
you register (with the CLI's local subscription login as a
fallback), and keeps all of its memory as plain Markdown files under
`~/.personal-agent/`.

Unlike a chat assistant that only responds when you type, Aitne also
runs on its own — on a schedule, in reaction to changes it sees in
your apps, or when you DM it from a messenger.

## What It Can Do

### Run on a schedule

Aitne can run [routines](../concepts/routines.md) without being asked.
By default:

- Every morning, it reads your calendar, unread mail, open tasks, and
  recent notes, and writes today's plan into
  [`state/today.md`](../features/memory-files/today.md).
- Every evening, it reviews how the day went and updates
  [`journal.md`](../features/memory-files/agent-journal.md).
- Once a week and once a month, it rolls those journals up.
- Once an hour during active hours, it checks
  [observations](../concepts/observations.md) it has collected from
  the integrations below.

You can change the times, disable any of them, or add your own.

→ [Morning Routine](../features/routines/morning-routine.md) ·
[Evening Review](../features/routines/evening-review.md) ·
[Hourly Check](../features/routines/hourly-check.md) ·
[Custom Routines](../features/routines/custom-routines.md)

### Reach you through a messenger

When something the agent notices needs your attention — a moved
meeting, a flight confirmation it wants to file, a reply you said
you'd send — it can DM you. You can also DM it back to ask questions
or give instructions.

Supported channels:

- [Telegram](../features/messaging/telegram.md)
- [Slack](../features/messaging/slack.md)
- [Discord](../features/messaging/discord.md)
- [WhatsApp](../features/messaging/whatsapp.md)
- [Dashboard chat](../features/messaging/dashboard-chat.md) (built in)

Pairing is one-time per channel.

→ [Messaging Overview](../features/messaging/overview.md) ·
[Pairing & Magic Phrase](../features/messaging/pairing-and-magic-phrase.md)

### Watch the apps you connect

When you connect an integration, the agent polls it on a schedule and
records anything that looks relevant as an
[observation](../concepts/observations.md). The hourly routine then
decides what (if anything) is worth telling you about.

- [Mail](../features/integrations/mail.md) — Gmail, Outlook, Yahoo,
  iCloud, or any IMAP server. Searches your messages locally via
  FTS5. Auto-classifies into
  [reading list](../features/lifestyle/reading.md),
  [receipts](../features/lifestyle/receipts.md), and
  [travel bookings](../features/lifestyle/travel-bookings.md).
- [Calendar](../features/integrations/calendar.md) — pre-meeting
  nudges and same-day briefing context.
- [Obsidian](../features/integrations/obsidian.md) — watches a vault
  for new notes.
- [Notion](../features/integrations/notion.md) — watches selected
  pages and databases.
- [Git](../features/integrations/git.md) /
  [GitHub](../features/integrations/github.md) — watches local repos
  and tracked GitHub repositories.

### Remember things in plain Markdown

Everything the agent learns about you is written as Markdown files
you can read, edit, and version yourself. Nothing important lives in
an opaque vector store.

- [`identity/profile.md`](../features/memory-files/user-profile.md) —
  what the agent knows about you.
- [`projects/*.md`](../features/memory-files/projects.md) — one file
  per active project.
- [`plans/roadmap.md`](../features/memory-files/roadmap.md) — longer-term
  goals.
- [`schedule/YYYY-MM-DD.md`](../features/memory-files/schedule.md) —
  per-day plans.
- [`state/today.md`](../features/memory-files/today.md) — today's plan.
- [`journal/agent.md`](../features/memory-files/agent-journal.md) —
  what the agent did and noticed.

→ [Memory Model](../concepts/memory-model.md)

### Drive Claude Code / Codex / Gemini / OpenCode via API keys

Aitne drives Claude Code, Codex CLI, Gemini CLI, and OpenCode on
your behalf. The recommended setup is to register a provider API key
for each backend you want to use — this matches what Anthropic,
OpenAI, and Google document for headless / programmatic agent use,
and gives you predictable per-call billing that is unambiguously
permitted.

- Claude — `ANTHROPIC_API_KEY` (via Claude Code)
- Codex — `OPENAI_API_KEY` (via Codex CLI)
- Gemini — `GEMINI_API_KEY` / `GOOGLE_API_KEY` (via Gemini CLI)
- OpenCode — provider key (Anthropic / OpenAI / OpenRouter / …)
  forwarded into the OpenCode server in Managed or Remote mode

If you skip the API key, Aitne falls back to whatever local
subscription login the CLI already has on your machine (`claude`,
`codex login`, `gemini auth`). This fallback works mechanically, but
most providers do not officially support running automated agents on
a personal subscription — Anthropic currently prohibits using the
Claude Agent SDK with a Claude Pro / Max subscription. The dashboard
surfaces a warning whenever a backend is running on subscription
auth.

Each kind of work (heavy reasoning vs. a quick reply) is mapped to a
backend; you can change the mapping any time.

→ [Backends and Tiers](../concepts/backends-and-tiers.md) ·
[Costs and Quotas](../concepts/costs-and-quotas.md) ·
[Backend Routing](../features/operations/backend-routing.md)

### Stay within limits you set

- [Quiet hours](../features/operations/quiet-hours.md) — windows
  during which the agent will not DM you or run autonomous routines.
- [Approvals](../features/operations/approvals.md) — write actions
  the agent must ask about before executing.
- An always-disallowed list of operations the agent cannot perform
  even with permission widened (see
  [safety model](../concepts/safety-model.md)).
- No automated social posting and no financial transactions, by
  design.

→ [Safety Model](../concepts/safety-model.md) ·
[Safety and Execution](../concepts/safety-and-execution.md)

## What It Is Not

- **Cloud-hosted**: nothing leaves your machine except per-turn LLM
  calls (and only the prompt text, not your raw vault).
- **Multi-user**: single-owner by design. DMs and mentions only;
  group chats are filtered out.
- **An IDE plugin**: Claude Code is one of its backends, but the
  agent daemon is the surface, not the editor.
- **A separate subscription**: Aitne itself does not bill you; you
  pay your LLM provider directly via the API key you register (or via
  the CLI's local subscription auth, if you opt into the fallback
  path).

## Where to Start

If the dashboard is already open, the daemon is running — start here:

- [First Steps](02-first-steps.md) — finish the setup wizard, pair
  messaging.
- [What This App Can Do](03-what-can-this-do.md) — the full
  capability tour with one-line summaries.
- [Your First Day](04-first-day.md) — what to expect once the agent
  starts running on its own.

If you are still installing:

- [Install and Run](../guides/install-and-run.md)
- [CLI Commands](../reference/cli-commands.md)

## Related

- [Memory Model](../concepts/memory-model.md)
- [Backends and Tiers](../concepts/backends-and-tiers.md)
- [Routines](../concepts/routines.md)
- [Agent Day](../concepts/agent-day.md)
