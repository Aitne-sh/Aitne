---
schema_version: 1
slug: reference/keyboard-shortcuts
title: Keyboard Shortcuts
id: keyboard-shortcuts
aliases:
  - keyboard shortcuts
  - hotkeys
  - key bindings
category: reference
summary: |
  Keyboard shortcuts available in the dashboard. The set is small on
  purpose — the dashboard is meant to stay calm and easy to scan.
section: reference
tags:
  - dashboard
status: stable
ask_examples:
  - What keyboard shortcuts work in the dashboard?
  - How do I open the search palette?
  - What does pressing "?" do in the dashboard?
locale: en-US
created: 2026-04-25
updated: 2026-07-01
keywords:
  - shortcut
  - hotkey
  - Cmd+K
  - Ctrl+K
  - keyboard
  - cmdk
  - command palette
  - help slide-over
ui_anchors:
  - /chat
  - /docs
related:
  - features/messaging/dashboard-chat
---

# Keyboard Shortcuts

The dashboard ships a deliberately small set of shortcuts — it is built
to stay calm and easy to scan, not to be a power-user IDE. These work
from any dashboard screen.

| Keys | Action |
|---|---|
| `Cmd+K` / `Ctrl+K` | Toggle the search palette — jump to any setting or run an action (e.g. "Ask docs…"). |
| `?` | Open the contextual help slide-over. On the `/docs` viewer it focuses the inline question composer instead. |
| `Esc` | Close the open slide-over or palette. |
| `Cmd+Enter` / `Ctrl+Enter` | Send the message you are typing — works in the chat composer and the docs question composer. |

## When shortcuts are suppressed

Most shortcuts are ignored while a text field (input, textarea, or
contenteditable) is focused, so typing `?` into a chat message does not
pop the help slide-over.

**`Cmd+K` / `Ctrl+K` is the exception** — it opens the search palette
regardless of where focus sits.

## Examples

- Press `Cmd+K`, type "timezone", and hit Enter to jump straight to the
  Timezone field on `/settings/hours`.
- On any screen, press `?` to ask a question about what you are looking
  at; the help slide-over opens pre-scoped to that page's doc.
- While drafting a message in `/chat`, press `Cmd+Enter` to send without
  reaching for the mouse.

## Related

- [Dashboard Chat](../features/messaging/dashboard-chat.md)
