---
schema_version: 1
slug: getting-started/03-what-can-this-do
title: What This App Can Do
id: what-can-this-do
aliases:
  - what can it do
  - capabilities
  - feature tour
  - what features exist
category: getting-started
summary: |
  A tour of Aitne's capabilities at a beginner-friendly
  granularity, with a link to the detailed feature doc for each.
section: getting-started
tags:
  - core
  - getting-started
  - overview
status: stable
ask_examples:
  - What can Aitne actually do?
  - What features should I try first?
  - How does the agent reach out to me?
  - Can the agent transcribe my voice messages?
  - Can the agent build me a personal wiki?
locale: en-US
keywords:
  - capabilities
  - feature tour
  - overview
  - voice transcription
  - wiki
  - lifestyle
created: 2026-04-27
updated: 2026-05-15
related:
  - getting-started/01-what-is-this
  - getting-started/02-first-steps
  - getting-started/04-first-day
  - concepts/routines
  - concepts/memory-model
  - features/messaging/overview
  - features/wiki/overview
  - features/wiki/commands
---

# What This App Can Do

A short tour. Each capability has a one-line summary plus a link to
the doc that goes deep.

## Plan your day, on its own

The agent runs **routines** on a schedule. The morning routine builds
`state/today.md` from your calendar, mail, tasks, and notes; the evening
review writes a journal entry; the weekly review rolls up the week.

- [Routines](../concepts/routines.md) — what runs and when.
- [Morning Routine](../features/routines/morning-routine.md)
- [Evening Review](../features/routines/evening-review.md)

## Talk to it from any messaging app

DM the agent from Telegram, Slack, Discord, WhatsApp, or the
dashboard's own chat. It answers, remembers, and can DM you back when
something comes up. Voice notes are transcribed locally with Whisper
so you can talk to it the same way you'd type.

- [Messaging Overview](../features/messaging/overview.md) — supported
  apps, how pairing works, and how voice notes get transcribed
  locally with Whisper.
- [Dashboard Chat](../features/messaging/dashboard-chat.md) — the
  in-dashboard chat surface.

## Watch what changes around you

Mail, calendar, git repos, your Obsidian vault, and Notion — the
agent watches the ones you connect and reacts when something worth
noticing happens.

- [Mail](../features/integrations/mail.md)
- [Calendar](../features/integrations/calendar.md)
- [Git](../features/integrations/git.md)
- [Obsidian](../features/integrations/obsidian.md)
- [Notion](../features/integrations/notion.md)

## Remember things in plain Markdown

Everything the agent learns about you lives as Markdown files under
`~/.personal-agent/context/`. You can read them, edit them, version
them — the agent reads what's there next time it runs.

- [Memory Model](../concepts/memory-model.md) — the layout and the
  rules around it.
- [user/profile.md](../features/memory-files/user-profile.md) — what
  the agent knows about you.
- [today.md](../features/memory-files/today.md) — today's plan.
- [agent/journal.md](../features/memory-files/agent-journal.md) —
  what the agent did and what it noticed.

## Build a personal wiki from what you DM

A workspace-scoped builder turns URLs, pastes, and notes you send into a
linked Markdown wiki. The raw capture, the synthesised article, and the
cited answer all stay on disk and the agent only writes via the daemon
API so the layout invariants hold.

- [Wiki Overview](../features/wiki/overview.md) — the workspace concept,
  the `00_inbox` / `10_raw` / `20_wiki` / `30_outputs` layers, and the
  approval gate on full rebuilds.
- [Wiki Commands](../features/wiki/commands.md) — `!ingest` (capture
  URLs), `!compile` (synthesise), `!ask` (cited Q&A), `!lint` /
  `!trace` / `!connect` (audit, history, bridges), `!wiki` (status).
- [Build Your Wiki](../guides/build-your-wiki.md) — the first-day
  walkthrough from empty workspace to first answered question.

## Help with the small lifestyle stuff

Reading lists, receipts, travel bookings — the agent collects what
arrives in mail and surfaces it in the right tab.

- [Reading](../features/lifestyle/reading.md)
- [Receipts](../features/lifestyle/receipts.md)
- [Travel Bookings](../features/lifestyle/travel-bookings.md)

## Stay in control

Quiet hours, approvals, and a strict set of always-disallowed
operations keep the agent from doing anything you don't want.

- [Safety Model](../concepts/safety-model.md) — what the agent will
  never do.
- [Approvals](../features/operations/approvals.md) — when it asks
  before acting.
- [Quiet Hours](../features/operations/quiet-hours.md) — when it
  stays silent.

## Get sharper over time

A background self-optimization loop watches how your knowledge layout
drifts (new folders, schema tweaks, vocabulary changes) and refines
specific skill sections to match. The original SKILL.md files are
never rewritten — overlays are reversible. The loop runs as a daemon
observer; you can review its proposals from the dashboard.

## Related

- [Your First Day](04-first-day.md) — what to expect when the agent
  begins running on its own.
- [What is Aitne?](01-what-is-this.md) — the elevator pitch.
- [First Steps](02-first-steps.md) — finish setup before exploring.
