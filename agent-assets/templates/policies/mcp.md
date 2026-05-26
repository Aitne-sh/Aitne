---
type: rule
slug: mcp
owner: shared
updated: 2026-04-17
template_version: 1
---
# MCP usage rules

This file governs how the agent uses attached Model Context Protocol
(MCP) servers. Edit to add per-MCP policies as you connect them.

## Global policies

- Read before write. Before any MCP write call, the agent must confirm
  the target with me via DM when the change is visible to others (a new
  issue, a posted message, an edited doc).
- Failures are loggable events. On repeated MCP call failures, the agent
  appends to `journal/agent.md` and surfaces the pattern at the next
  hourly check.
- Scope to the active task. MCP calls unrelated to the current flow's
  stated goal are skipped.

## Per-server rules

Add one block per connected server:

### monday
- Read-only unless I DM a `[monday]` directive.
- Never create boards.

### home-assistant
- Read-only. Actuator calls require my confirmation.

### figma
- Read designs freely. Writes create comments, never commit changes.

### notion
- Use the database IDs configured in `settings.notionDatabaseIds`.
- Never move pages between teams.
