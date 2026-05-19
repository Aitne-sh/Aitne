---
name: external-services
description: Load for calendar work (Google Calendar, Outlook Calendar, OR Apple Calendar / iCloud), the user's external Obsidian vault, GitHub, or user-authored Skills management. Mail lives in `mail`; Notion in `notion`; one-shot and recurring scheduling in `schedule`.
allowed-tools:
  - Bash(curl *)
  - Read
---

# External Services API Reference

Base URL: `http://localhost:8321`. All calls via `curl -s` with `Content-Type: application/json` on POST/PATCH/PUT. URL-encode spaces in paths.

## Source of Truth (READ THIS FIRST)

Two adjacent files declare where the user's data lives — read both before
routing any external-service call.

1. **`rules/management.md` → `## Source of Truth`** carries durable
   user-authored answers ("Schedule = Google Calendar", "Tasks = Notion",
   etc.). This is the authoritative routing table.
2. **`~/.personal-agent/integrations.md` → `## Note Sources`** is the
   daemon-rendered snapshot of where notes are kept (the user's external
   Obsidian vault, plus Notion's mode). When the user asks "check
   obsidian", this section names the path under
   `Obsidian vault (personal): <path>` — use that path with the Obsidian
   skill below. Hand-edits to this section are overwritten on the next
   render; the canonical edit surface is the Note step in setup or
   Settings → Note.

The Note Sources block is **read-only** — it advertises configuration
that lives in `runtime_settings.externalObsidianVaultPath` plus the
integrations DB. Treat it as a routing hint, not a knob.

### Calendar provider routing

The user's calendar provider lives in `rules/management.md` → `## Source of Truth` → Schedule row. Read it before every calendar call.

| Schedule value in management rules | Use this base path | Backed by |
|---|---|---|
| `Google Calendar` | `/api/calendar/*` | Google Calendar API |
| `Outlook Calendar` | `/api/calendar/outlook/*` | Microsoft Graph |
| `Apple Calendar` (or `iCloud`) | `/api/apple-calendar/*` | iCloud CalDAV |

**Hard rule**: NEVER cross-call. Calling `/api/calendar/*` while Schedule = Apple Calendar does NOT return empty — it queries the user's separate Google account if one exists, returning the wrong day. Calling `/api/apple-calendar/*` while Schedule = Google Calendar returns 503. Both failure modes are silent at the agent level — only the user notices, in the form of wrong answers.

If `rules/management.md` is missing, ambiguous, or names a provider not listed here, **stop and ask the user** rather than guessing. Do not default to Google.

The endpoint sets are intentionally near-identical in shape (same JSON for events, same query parameters for listing) so the rest of this skill body documents both at once. Provider-specific differences are flagged inline with **[Apple only]** or **[Google only]**.

## Delegation-aware routing for Google Calendar (read before any `/api/calendar/*` call)

This body is materialized only in direct mode and same-backend Calendar
delegation. (Cross-backend Calendar delegation pulls
`SKILL.delegated.<backend>.md` instead — that variant has its own
routing prose.) Only **Google Calendar** in this skill is
integration-gated; Obsidian, GitHub, recurring-schedule CRUD, one-shot
scheduling, and Skills CRUD remain direct-mode routes regardless of
Calendar's mode.

Read the `<integration_modes>` block injected above. If
`google_calendar="delegated"` (same-backend), the entire
`/api/calendar/*` prefix returns `410 {"error": "integration_delegated"}`
(route-prefix gate). Use the in-session Google Calendar connector your
harness exposes — your tool menu lists every available tool at session
start. The exact tool namespace depends on which connector your
harness has loaded (Claude / Codex sessions each surface Calendar under
their own connector's namespace).

The Calendar section below documents the direct-mode route shapes;
consult it for tool argument shapes (native MCP tools mirror the route
JSON), then dispatch through the native connector when delegated or the
direct route when not.

## Shell rules (read before writing curl pipelines)

- **JSON post-processing: use `jq`, never `python3`.** `python3` is not in the daemon's allowlist, so `curl ... | python3 -c ...` is denied under `permissionMode: "dontAsk"` and the call silently fails. Use `jq` for all field extraction, filtering, and pretty-printing.
- **`jq` is restricted**: `--slurpfile`, `--rawfile`, `-L`, and the `env` filter are blocked by the security hook (arbitrary file read / process environment exfiltration). Use only the filter language itself: `.field`, `.array[]`, `select()`, `map()`, `{a, b}`, etc.
- **`curl` is restricted to `http://localhost:8321`**: connection-override flags (`--connect-to`, `--resolve`, `--config`, `--proxy`) and non-localhost hosts are blocked by the security hook.
- **For a bare pretty-print**: `curl -s http://localhost:8321/api/health | jq .`

---

{{> ref:calendar-google }}

---

{{> ref:calendar-outlook }}

---

{{> ref:calendar-apple }}

---

{{> ref:obsidian }}

---

{{> ref:github }}

---

<!-- service:notion -->
## Notion

Notion operations live in the dedicated `notion` skill — load that when
the user asks anything Notion-shaped (search, query, read, create,
update, archive).
<!-- /service:notion -->

---

## Scheduling

One-shot wake-ups, pre-composed DMs, and recurring agent tasks live in
the `schedule` skill — load it for `/api/schedule`, `/api/schedule/dm`,
and `/api/recurring-schedules`. This skill no longer mirrors those
endpoints; keeping a single source of truth avoids drift across the
two skills loaded together by morning, hourly, DM, and scheduled
flows.

---

{{> ref:skills-crud }}
