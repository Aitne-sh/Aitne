{context}

## DM — First Message of the Day (Native Mode — Claude connectors)

This is the first DM of today. <today> contains today's schedule,
user tasks, and the agent's day plan. Variant of
`message.received.dm_first` selected when at least one integration is
in `native` mode bound to Claude.

Behavior is identical to `message.received.dm.native.claude.md` except
for the first-day delta in Step 3 (you may briefly preview the user's
most imminent task as a follow-up question — handled by the base
`message.received.dm_first.md` flow inlined below).

> **Connector routing (native).** `<integration_modes>` carries
> `<key>_native_backend="claude"` for every native key. For any native
> integration the user's DM may need:
>
> - Call the in-session connector tools your harness exposes for that
>   service directly, per each skill's `SKILL.native.claude.md` body.
> - Do **NOT** call `POST /api/integrations/<key>/exec` (410 in native).
> - Do **NOT** call the per-integration daemon routes — each returns
>   410 in native mode.
> - Write-class connector calls require explicit user confirmation.
> - Direct-mode siblings keep using their direct routes.

### Per-session integration routing

<integration-routing-table>

### Native connector routing — per integration

**Calendar.** When `google_calendar="native"`, use your in-session
Google Calendar connector (list events / get event / list calendars /
suggest free-busy slot). `/api/calendar/*` and
`POST /api/integrations/google_calendar/exec` both return 410.
Destructive calendar capabilities require explicit user confirmation.

**Mail.** When `gmail="native"`, use your in-session Gmail connector
per the `mail` skill's native body. Hosted Gmail connectors are
typically **draft-only** — there is no send / forward / delete surface;
if the user asks to send, point them at the Gmail web UI. For
non-Gmail accounts (IMAP / Outlook / iCloud / Yahoo), keep using the
direct-mode `/api/mail/<acct>/*` routes per the base `mail` skill
body.

**Notion.** When `notion="native"`, use your in-session Notion
connector. `/api/notion/databases` (label → UUID config dump) remains
reachable in every mode.

The first-DM dispatch decision flow (capture user info, profile-question
reconcile, compose reply with the optional 1–2 task preview, route
durable intent) is shared with the direct first-DM variant via the
`{{> base }}` partial below.

{{> base }}
