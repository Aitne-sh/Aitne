---
schema_version: 1
slug: features/memory-files/user-profile
title: user/profile.md
id: user-profile
aliases:
  - user.md
  - user/profile.md
  - user profile
  - about-me
category: features
summary: |
  user/profile.md is the agent's stable profile of the operator — role,
  focus areas, preferences, names of important people. The agent reads
  it on every session and appends with the operator's permission.
section: memory-files
tags:
  - memory
  - profile
  - core
status: stable
ask_examples:
  - What is user/profile.md?
  - How do I tell the agent something about me?
  - Will the agent change my profile without asking?
locale: en-US
created: 2026-04-25
updated: 2026-04-25
keywords:
  - user profile
  - user/profile.md
  - user slices
  - people
  - expertise
related:
  - getting-started/04-first-day
  - concepts/memory-model
context_files:
  - user/profile.md
  - user/people.md
  - user/work.md
  - user/expertise.md
  - user/personal.md
  - user/goals.md
---

# user/profile.md

## In One Sentence

A stable, mostly hand-edited profile of you — the agent reads it
every session and appends only with explicit permission.

## What It Does

- Captures who you are, what you do, who matters in your life.
- Pinned at the top of every session prompt so the agent has the
  same baseline understanding turn-to-turn.
- The companion files in the `user/` directory split the dossier into
  topic-shaped slices: `user/people.md`, `user/work.md`,
  `user/expertise.md`, `user/personal.md`, `user/goals.md`. The agent
  loads them on demand instead of inlining everything.

## When It Runs / How It Is Triggered

Read continuously. Written only when the operator says "remember
that…" or during a profile sweep routine
(`routine.user_profile_sweep`).

## Where in the Dashboard

- **Knowledge → Context Files → user/profile.md** to view and edit.
  The other `user/*.md` slices are listed alongside.
- **Knowledge → Upload** to seed `user/*.md` from a Markdown / text
  file — useful for migrating an existing profile out of ChatGPT,
  Gemini, Obsidian, or Notion. See
  [Import a Knowledge File](../../guides/import-knowledge-file.md).

## When Something Goes Wrong

- The agent forgets something it should remember: append it to
  the appropriate `user/*.md` slice by hand.

## Related

- [Memory Model](../../concepts/memory-model.md)
- [Import a Knowledge File](../../guides/import-knowledge-file.md)
