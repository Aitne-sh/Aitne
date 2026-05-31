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
  - obsidian
status: stable
ask_examples:
  - How do I connect my Obsidian vault?
  - Will the agent edit my notes?
  - Why didn't the agent see my new note?
locale: en-US
created: 2026-04-25
updated: 2026-05-28
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
  - externalObsidianVaultPath
  - externalObsidianVaultName
  - externalObsidianWatch
  - obsidianDebounceSeconds
---

# Obsidian

Point Aitne at your Obsidian vault directory; new and changed notes
record observations the hourly check consumes. The agent can read and
write vault notes through the `external-services` skill.

Reads and writes go through the Obsidian app's CLI — the Obsidian app
must be running, or vault read/write calls fail.

## What It Does

- Watches the vault for filesystem changes.
- Filters out agent-originated writes via `AgentWriteTracker`.
- Records observations for genuine operator edits.

### Will it edit my notes?

The agent reads on demand and can create, append to, overwrite, or
delete notes when you ask it to (via the `external-services` skill). It
never edits your vault unprompted. When the agent does write, the
watcher does not treat its own writes as new observations —
`AgentWriteTracker` suppresses them — so the agent does not re-observe
its own output.

## When It Runs / How It Is Triggered

Continuously — the watcher runs as long as the daemon is up and a vault
path is configured (`externalObsidianWatch=true`). Saves are debounced
by `obsidianDebounceSeconds` before an observation is recorded; the
[hourly check](../routines/hourly-check.md) later consumes those
observations.

## Where in the Dashboard

- **Connections → Knowledge** to point at the vault directory.

## Configuration

| Setting | Default | Notes |
|---|---|---|
| `externalObsidianVaultPath` | unset | Vault directory; set in Connections → Knowledge. |
| `externalObsidianWatch` | true | Set false to keep the path but stop recording changes (large-vault churn control). |
| `obsidianDebounceSeconds` | 5 | How long to wait after a save before recording. |

## When Something Goes Wrong

- A vault read or write that failed: the Obsidian app must be running,
  since reads and writes proxy through its CLI. Open Obsidian and retry.
- A change that did not record: the debounce may have folded multiple
  saves; the next one will fire.

## Related

- [Notion](notion.md)
