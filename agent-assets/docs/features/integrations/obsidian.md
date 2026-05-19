---
schema_version: 1
slug: features/integrations/obsidian
title: Obsidian
id: obsidian
aliases:
  - obsidian vault
  - knowledge vault
category: features
summary: |
  Watch an Obsidian vault for new and changed notes. Changes record
  observations the hourly check consumes; the agent can also read
  notes on demand.
section: integrations
tags:
  - integrations
  - knowledge
  - observations
status: stable
ask_examples:
  - How do I connect my Obsidian vault?
  - Will the agent edit my notes?
  - Why didn't the agent see my new note?
locale: en-US
created: 2026-04-25
updated: 2026-04-25
keywords:
  - obsidian
  - vault
  - vault watcher
  - obsidian observer
related:
  - features/integrations/notion
  - features/routines/hourly-check
  - concepts/observations
ui_anchors:
  - /connections/knowledge
config_keys:
  - obsidianDebounceSeconds
---

# Obsidian

## In One Sentence

Point Aitne at your Obsidian vault directory; new and changed
notes record observations the hourly check consumes.

## What It Does

- Watches the vault for filesystem changes.
- Filters out agent-originated writes via `AgentWriteTracker`.
- Records observations for genuine operator edits.

## When It Runs / How It Is Triggered

Continuously. The watcher is debounced by `obsidianDebounceSeconds`.

## Where in the Dashboard

- **Connections → Knowledge** to point at the vault directory.

## Configuration

| Setting | Default | Notes |
|---|---|---|
| `obsidianDebounceSeconds` | 5 | How long to wait after a save before recording. |

## When Something Goes Wrong

- A change that did not record: the debounce may have folded multiple
  saves; the next one will fire.

## Related

- [Notion](notion.md)
