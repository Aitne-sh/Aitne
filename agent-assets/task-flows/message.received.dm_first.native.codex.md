{context}

## DM — First Message of the Day (Native Mode — Codex connectors)

This is the first DM of today. <today> contains today's schedule,
user tasks, and the agent's day plan. Variant of
`message.received.dm_first` selected when at least one integration is
in `native` mode bound to Codex.

Behavior is identical to `message.received.dm.native.codex.md` except
for the first-day delta in Step 3 (handled by the base
`message.received.dm_first.md` flow inlined below).

> **Connector routing (native).** Use the in-session connector tools
> your harness exposes for each native integration directly, per each
> skill's `SKILL.native.codex.md` body. Do **NOT** call
> `POST /api/integrations/<key>/exec` (410) or the per-integration
> daemon routes (410). Write-class connector calls require explicit
> user confirmation; direct-mode siblings keep using their direct
> routes.

### Per-session integration routing

<integration-routing-table>

### Native connector routing — per integration

**Calendar.** When `google_calendar="native"`, use your in-session
Google Calendar connector (search / window-list events / read event /
batch-read / free-busy + destructive set). `/api/calendar/*` and
`POST /api/integrations/google_calendar/exec` both return 410.

**Mail.** When `gmail="native"`, use your in-session Gmail connector.
The Codex-side hosted Gmail destructive surface (send / send-draft /
forward / delete / archive / label / batch modify) requires explicit
user confirmation. For non-Gmail accounts keep using
`/api/mail/<acct>/*`.

**Notion.** When `notion="native"`, use your in-session Notion
connector. Use the structured query primitive when the connector
exposes it (Codex-side hosted Notion connectors typically do — see the
`notion` skill's native body); fall back to search + client-side
filtering otherwise. `/api/notion/databases` config dump is reachable
in every mode.

The first-DM dispatch decision flow (capture user info, profile-question
reconcile, compose reply with the optional 1–2 task preview, route
durable intent) is shared with the direct first-DM variant via the
`{{> base }}` partial below.

{{> base }}
