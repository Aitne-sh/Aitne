---
schema_version: 1
slug: features/memory-files/user-profile
title: identity/profile.md
id: user-profile
aliases:
  - user.md
  - user/profile.md
  - identity/profile.md
  - user profile
  - about-me
category: features
summary: |
  identity/profile.md is the agent's stable profile of the operator — role,
  focus areas, preferences, names of important people. The agent reads it
  on every session and silently appends durable facts the operator states
  in DMs.
section: memory-files
tags:
  - memory
status: stable
ask_examples:
  - What is identity/profile.md?
  - How do I tell the agent something about me?
  - Will the agent change my profile without asking?
locale: en-US
created: 2026-04-25
updated: 2026-07-01
keywords:
  - user profile
  - identity/profile.md
  - identity slices
  - people
  - expertise
related:
  - getting-started/04-first-day
  - concepts/memory-model
process_keys:
  - routine.user_profile_sweep
api_endpoints:
  - PUT /api/context/*
  - PATCH /api/context/*
context_files:
  - identity/profile.md
  - identity/people.md
  - identity/work.md
  - identity/expertise.md
  - identity/personal.md
  - identity/goals.md
---

# identity/profile.md

## In One Sentence

A steady profile of you. The agent reads it at the start of every
session and quietly adds durable facts — things that stay true, like
your role or your manager's name — that you mention in DMs.

## What It Does

- Captures who you are, what you do, and who matters in your life.
- Sits at the top of every session prompt, so the agent keeps the same
  baseline understanding of you from one message to the next.
- Anchors a set of companion files — called slices — in the `identity/`
  directory, one per topic:
  `identity/people.md`, `identity/work.md`, `identity/expertise.md`,
  `identity/personal.md`, `identity/goals.md`. The agent loads these
  only when it needs them, instead of packing everything into every
  prompt.

> Older docs and exports may call these files `user/profile.md`,
> `user/people.md`, and so on. `user/` is a legacy alias for
> `identity/`; the daemon rewrites it in-process, so the current
> canonical location is `identity/`.

## When It Runs / How It Is Triggered

- **Read continuously** — loaded at the start of every session.
- **Written** silently, within the same reply, when you state a
  durable fact about yourself in a DM ("remember that…", "I'm a…",
  "my manager is…"), and during the profile sweep routine
  (`routine.user_profile_sweep`), which catches facts that the
  in-chat capture missed and files them into the right
  `identity/*.md` slice.

The agent never edits these files directly. It writes through the
daemon's context API — for example
`PATCH /api/context/identity/profile.md` — the single validated write
path with locks and backup snapshots.

## Where in the Dashboard

- **Knowledge → Context Files** (`/knowledge?tab=context-files`) to
  view and edit `identity/profile.md`. The other `identity/*.md`
  slices are listed alongside it.
- **Knowledge → Upload** (`/knowledge?tab=upload`) to seed the
  `identity/*.md` slices from a Markdown or text file — useful when
  migrating an existing profile out of ChatGPT, Gemini, Obsidian, or
  Notion. See [Import a Knowledge File](../../guides/import-knowledge-file.md).

## Example

To tell the agent a durable fact about yourself, just say it in a DM:

> remember that my manager is Priya and we sync every Monday at 10am

The agent silently appends a line to the relevant slice (here
`identity/people.md`) right away, and recalls it in future
sessions.

## When Something Goes Wrong

- **The agent forgets something it should remember:** open
  **Knowledge → Context Files** and append it to the appropriate
  `identity/*.md` slice by hand.

## Related

- [Memory Model](../../concepts/memory-model.md)
- [First Day](../../getting-started/04-first-day.md)
- [Import a Knowledge File](../../guides/import-knowledge-file.md)
