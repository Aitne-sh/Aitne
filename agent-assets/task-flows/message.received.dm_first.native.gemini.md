{context}

## DM — First Message of the Day (Native Mode — Gemini connectors)

This is the first DM of today. <today> contains today's schedule,
user tasks, and the agent's day plan. Variant of
`message.received.dm_first` selected when at least one integration is
in `native` mode bound to Gemini.

Behavior is identical to `message.received.dm.native.gemini.md`
except for the first-day delta in Step 3 (handled by the base
`message.received.dm_first.md` flow inlined below).

> **Connector routing (native).** Use the in-session connector tools
> your harness exposes for each native integration directly, per each
> skill's `SKILL.native.gemini.md` body. Do **NOT** call
> `POST /api/integrations/<key>/exec` (410) or the per-integration
> daemon routes (410). Write-class connector calls require explicit
> user confirmation; direct-mode siblings keep using their direct
> routes. **Gemini quirks**: `maxResults` is typically silently
> ignored on Gmail search and Calendar list-events — narrow the query
> window when the result is larger than expected.

### Per-session integration routing

<integration-routing-table>

### Native connector routing — per integration

**Calendar.** When `google_calendar="native"`, use your in-session
Google Calendar connector (list-events / get-event / list-calendars /
find-free-time + destructive set). `maxResults` typically silently
ignored on list-events; default `attendeeResponseStatus` typically
excludes declined events (pass full list explicitly when needed).
`/api/calendar/*` and `POST /api/integrations/google_calendar/exec`
both return 410.

**Mail.** When `gmail="native"`, use your in-session Gmail connector.
Some Gemini-side connectors expose no dedicated delete or forward
tool — compose from primitives (delete = modify + add `TRASH`;
forward = send with re-quoted body). The destructive set requires
explicit user confirmation. For non-Gmail accounts keep using
`/api/mail/<acct>/*`.

**Notion.** When `notion="native"`, use your in-session Notion
connector per the `notion` skill's native body. No SQL-style
structured query primitive is typically exposed on this surface
(Notion's official MCP server lacks it) — use workspace search with a
data-source filter for property-shaped intents and filter
client-side. `/api/notion/databases` config dump is reachable in
every mode.

The first-DM dispatch decision flow (capture user info, profile-question
reconcile, compose reply with the optional 1–2 task preview, route
durable intent) is shared with the direct first-DM variant via the
`{{> base }}` partial below.

{{> base }}
