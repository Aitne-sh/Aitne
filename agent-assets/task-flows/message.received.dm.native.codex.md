{context}

## DM Reply — Native Mode (Codex connectors)

Variant of `message.received.dm` selected when at least one integration
the agent may need to reach during this DM is in `native` mode and the
session backend (Codex) matches the integration's `nativeBackend`.

> **Connector routing (native).** `<integration_modes>` carries
> `gmail`, `google_calendar`, and `notion` mode attributes plus
> `<key>_native_backend="<backend>"` for every native key. For any
> native integration the user's DM may need:
>
> - Call the in-session connector tools your harness exposes for that
>   service directly. Your tool menu lists every available tool at
>   session start. Per-service guidance lives in each skill's
>   `SKILL.native.codex.md` body materialised for this session
>   (`mail`, `external-services`, `notion`).
> - Do **NOT** call `POST /api/integrations/<key>/exec` (410 in native).
> - Do **NOT** call the per-integration daemon routes
>   (`/api/calendar/*`, `/api/notion/query|search|pages|...`, Gmail
>   accounts under `/api/mail/*`) — each returns 410 in native mode.
> - Write-class connector calls (per registry `destructiveTools`)
>   require explicit user confirmation; the absolute-block layer
>   continues to fire.
> - Direct-mode siblings keep using their direct routes — native gate
>   is per-key.

### Per-session integration routing

<integration-routing-table>

### Native connector routing — per integration

**Calendar — real-time queries.** When `google_calendar="native"`, use
your in-session Google Calendar connector (search / window-list events
/ read event / batch-read / free-busy + destructive set). See the
`external-services` skill's native body for capability shapes and the
destructive-confirm contract for create / update / delete / RSVP.
`/api/calendar/*` and `POST /api/integrations/google_calendar/exec`
both return 410.

**Mail — DM read / draft / reply.** When `gmail="native"`, use your
in-session Gmail connector per the `mail` skill's native body (search /
read / read-thread / create-draft). The Codex-side hosted Gmail
connector typically exposes a richer destructive surface than Claude's
(send / send-draft / forward / delete / archive / label / batch
modify); each of those capability classes requires explicit user
confirmation. For non-Gmail accounts (IMAP / Outlook / iCloud / Yahoo),
keep using the direct-mode `/api/mail/<acct>/*` routes per the base
`mail` skill body.

**Notion — DM read / search.** When `notion="native"`, use your
in-session Notion connector per the `notion` skill's native body
(search / fetch + the structured query primitive when the connector
exposes it, for property-shaped intents like "tasks in status X"). The
`/api/notion/databases` config dump remains reachable in every mode.

The dispatch decision flow (capture user info, profile-question
reconcile, compose reply, route durable intent) is shared with the
direct variant via the `{{> base }}` partial below.

{{> base }}
