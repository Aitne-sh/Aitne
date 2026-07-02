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
  Watch an Obsidian vault for new and changed notes. Each change
  records an observation that the activity scan later reviews; the
  agent can also read notes on demand.
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
updated: 2026-07-01
keywords:
  - obsidian
  - vault
  - vault watcher
  - obsidian observer
related:
  - features/integrations/notion
  - features/routines/activity-scan
  - concepts/observations
ui_anchors:
  - /connections/notes
config_keys:
  - externalObsidianVaultPath
  - externalObsidianVaultName
  - externalObsidianWatch
  - obsidianDebounceSeconds
---

# Obsidian

Point Aitne at your Obsidian vault folder (the directory where your
notes live). When you add or change a note, Aitne records an
observation — a short note-to-self that the
[activity scan](../routines/activity-scan.md) reviews on its next run.
The agent can also read and write vault notes through the
`external-services` skill.

Reads and writes go through the Obsidian app's own command-line tool
(CLI), so the Obsidian app must be running — otherwise vault read and
write calls fail.

## What It Does

- Watches the vault folder for file changes.
- Ignores writes the agent made itself, using `AgentWriteTracker`.
- Records an observation for each edit you make by hand.

### Will it edit my notes?

The agent reads on demand and can create, append to, overwrite, or
delete notes when you ask it to (via the `external-services` skill). It
never edits your vault unprompted. When the agent does write, the
watcher does not treat its own writes as new observations —
`AgentWriteTracker` suppresses them — so the agent does not re-observe
its own output.

## When It Runs / How It Is Triggered

Continuously — the watcher runs as long as the daemon is up and a vault
path is configured (`externalObsidianWatch=true`). After you save,
Aitne waits `obsidianDebounceSeconds` before recording the change (a
short pause called debouncing), so a burst of quick saves is folded
into one observation. The [activity scan](../routines/activity-scan.md)
picks up those observations on its next run.

## Where in the Dashboard

- **Connections → Notes** to point at the vault directory.

## Configuration

| Setting | Default | Notes |
|---|---|---|
| `externalObsidianVaultPath` | unset | Vault directory; set in Connections → Notes. |
| `externalObsidianWatch` | true | Set false to keep the path but stop recording changes — handy for a large, busy vault. |
| `obsidianDebounceSeconds` | 5 | How many seconds to wait after a save before recording. |

## When Something Goes Wrong

- A read or write failed: the Obsidian app must be running, because
  reads and writes go through its CLI. Open Obsidian and try again.
- A change didn't show up: the debounce pause may have folded several
  saves together; the next save will record it.

## Related

- [Notion](notion.md)
