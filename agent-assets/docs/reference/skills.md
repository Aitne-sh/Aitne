---
schema_version: 1
slug: reference/skills
title: Skills (Reference)
id: skills-ref
aliases:
  - skill index
  - built-in skills
  - skill registry
category: reference
summary: |
  Index of built-in skills bundled with Aitne. Each maps to
  a SKILL.md under agent-assets/skills/<slug>/.
section: skills
tags:
  - core
  - reference
  - skills
status: stable
ask_examples:
  - List all the built-in skills
  - What does the docs-search skill do?
  - What does the wiki skill do?
  - How is each skill scoped?
locale: en-US
keywords:
  - skill
  - skills
  - SKILL.md
  - skill registry
  - overlay
  - context skill
  - mail skill
  - wiki skill
  - notify skill
created: 2026-04-25
updated: 2026-05-28
ui_anchors:
  - /knowledge?tab=skills
process_keys:
  - dashboard.docs_qa
api_endpoints:
  - /api/skills
  - /api/skills/manifest/:processKey
  - /api/browser-task
  - /api/browser-history/offers/:slug/accept
context_files:
  - state/today.md
  - plans/roadmap.md
  - state/profile-questions.md
related:
  - concepts/skills
  - features/integrations/browser-history
  - features/operations/managed-chromium
---

# Built-in Skills

Aitne ships a fixed set of built-in skills the agent loads per session. Most
are always available; a few are **conditional** — loaded only when a gating
flag is set (`gmail-lifestyle`, `managed-tasks`) or only for a specific event
type (`browser-task`, on owner DMs). The table below is the canonical roster.

| Slug | Purpose |
|---|---|
| `agent-actions` | Read the agent action log (`agent_actions` table) for retrospective audits. |
| `attach` | Attach a generated or downloaded file to the agent's reply when the user expects a file artifact. |
| `browser-history` | Read normalised browser activity through `/api/browser-history/*`. Used by research-cluster journal updates, accept-path dispatches, owner pulls of shopping / reload traces, and the morning research summary. Never reads browser SQLite or profile dirs directly. |
| `browser-history-respond` | Bridge the owner's natural-language reply to a research-offer DM ("dig deeper" / "summarise") into a structured `/api/browser-history/offers/<slug>/{accept,decline}` call. |
| `browser-task` | Drive managed Chromium for open-ended browser tasks the user describes in DM. POSTs to `/api/browser-task` with a natural-language description; relays sub-agent clarifications back through DM. Loaded only on `message.received.dm`. |
| `context` | Read / write context Markdown — projects, weekly summaries, agent journal, generic context files. |
| `docs-search` | Read-only search and fetch over the operator-facing docs corpus. Used for `dashboard.docs_qa`. |
| `external-services` | Call Google Calendar, the user's Obsidian vault, GitHub, or the agent Skills-management routes through the daemon proxy. |
| `mail` | Unified multi-provider mail interface (Gmail, Outlook, Yahoo, iCloud, generic IMAP) — search, label, classify. |
| `gmail-lifestyle` | Conditional skill (gated by `gmailLifestyleActive` / `gmailLifestyleActiveForDm`). Merges travel-booking queries, calendar-event commute calculations, and receipt save-to-external-vault. |
| `managed-tasks` | Register, modify, stop, or one-off-run a Managed Task (`mt_<n>`) — a recurring agent fetch against a third-party app (Zoom / Gmail / Drive / Notion / custom MCP). Conditional skill gated by `managedTasksActive` / `managedTasksActiveForDm`. |
| `management-policy` | Capture a durable management rule from a DM ("every morning X", "from now on when Y, do Z"). Persists to the management policy store. |
| `notify` | Send a notification through the paired messaging app and decide whether notifying is warranted. |
| `notion` | Read, query, search, create, update, and archive Notion pages and databases. |
| `observations` | Drain the pending-observations queue and inspect raw external-source change records. |
| `project-doc` | Read / write Git-backed and manual project context docs. Git-managed repos write to `knowledge/repos/<slug>/overview.md` plus per-day `journal/repos/<slug>/<date>.md`; manual non-git project pages live at `plans/projects/<slug>.md`. |
| `reading` | Query reading history and highlights; owns the reading-taste profile via the `books` and `reading_highlights` tables. |
| `roadmap` | Read / write `plans/roadmap.md` (cross-request write lock). |
| `schedule` | Schedule future agent wake-ups and DMs via the daemon (writes `agent_schedule` and `recurring_schedules` rows). |
| `scheduled-managed-task` | Surface and act on Managed Tasks that are due now. |
| `today` | Read or write `state/today.md` — morning routines, hourly checks, DMs that need a today snapshot. |
| `user-interview` | Manage the profile-interview queue at `state/profile-questions.md`; ask one question at a time. |
| `user-profile` | Record user facts — identity, people, work, expertise, habits, goals — into the `identity/*` slices (`profile.md`, `people.md`, `work.md`, …). |
| `wiki` | Build and maintain the personal wiki workspace — `!ingest` / `!compile` / `!ask` / `!lint` / `!trace` / `!connect`. |

## How skills are sourced

The source of truth is each skill's `SKILL.md` under
`agent-assets/skills/<slug>/`. The `description` field in that file's
frontmatter is what the dispatcher uses for runtime skill selection.

## Runtime overlays

A subset of these skills' sections (knowledge layout, routing tables, search
recipes, etc.) is refined at runtime through JSON **overlays** maintained by
the skill-curation loop. The seed files in `agent-assets/skills/` are never
rewritten — overlays are applied at session-init by the `SkillsCompiler` and
live under `<dataDir>/overlays/<skill>/<section-id>.json`.
