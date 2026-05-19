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
  Keyboard shortcuts available in the dashboard. The set is small by
  design — the dashboard is a low-cognition surface.
section: keyboard-shortcuts
tags:
  - reference
  - dashboard
  - core
status: stable
ask_examples:
  - What keyboard shortcuts work in the dashboard?
locale: en-US
created: 2026-04-25
updated: 2026-04-25
keywords:
  - shortcut
  - hotkey
  - Cmd+K
  - Ctrl+K
  - keyboard
  - cmdk
  - command palette
related:
  - features/messaging/dashboard-chat
---

# Keyboard Shortcuts

| Keys | Action |
|---|---|
| `?` | Open the contextual help slide-over. On `/docs`, focuses the inline QA composer. |
| `Cmd+K` / `Ctrl+K` | Open the search palette (settings + Actions). |
| `Esc` | Close the slide-over / palette. |
| `Cmd+Enter` | Send the current QA composer / chat message. |

Shortcuts are skipped when an input or textarea is focused (so typing
`?` in chat does not open the slide-over). The exception is `Cmd+K`,
which still opens regardless.

## Related

- [Dashboard Chat](../features/messaging/dashboard-chat.md)
