{context}

## DM Reply — Native Mode (Gemini connectors)

Variant of `message.received.dm` selected when at least one integration
the agent may need to reach during this DM is in `native` mode and the
session backend (Gemini) matches the integration's `nativeBackend`.

> **Connector routing (native).** `<integration_modes>` carries
> `gmail`, `google_calendar`, and `notion` mode attributes plus
> `<key>_native_backend="<backend>"` for every native key. For any
> native integration the user's DM may need:
>
> - Call the in-session connector tools your harness exposes for that
>   service directly. Your tool menu lists every available tool at
>   session start. Per-service guidance lives in each skill's
>   `SKILL.native.gemini.md` body materialised for this session
>   (`mail`, `external-services`, `notion`).
> - Do **NOT** call `POST /api/integrations/<key>/exec` (410 in native).
> - Do **NOT** call the per-integration daemon routes
>   (`/api/calendar/*`, `/api/notion/query|search|pages|...`, Gmail
>   accounts under `/api/mail/*`) — each returns 410 in native mode.
> - Write-class connector calls (per registry `destructiveTools`)
>   require explicit user confirmation; the absolute-block layer
>   continues to fire.
> - Direct-mode siblings keep using their direct routes.
> - **Gemini-specific quirks** (typical of the `google-workspace`
>   extension): `maxResults` is silently ignored on Gmail search and
>   Calendar list-events — narrow the query window when the result is
>   larger than expected.

### Per-session integration routing

<integration-routing-table>

### Native connector routing — per integration

**Calendar — real-time queries.** When `google_calendar="native"`, use
your in-session Google Calendar connector (list-events / get-event /
list-calendars / find-free-time + destructive set). See the
`external-services` skill's native body for capability shapes and the
destructive-confirm contract. `/api/calendar/*` and
`POST /api/integrations/google_calendar/exec` both return 410.
`maxResults` is typically silently ignored on list-events — narrow the
window when needed. The default `attendeeResponseStatus` typically
excludes declined events; pass the full list explicitly when declined
meetings are relevant.

**Mail — DM read / draft / reply.** When `gmail="native"`, use your
in-session Gmail connector per the `mail` skill's native body (search /
read / create-draft). The destructive set (send / send-draft / modify
/ modify-thread / create-label / batch-modify) requires explicit user
confirmation. Some Gemini-side Gmail connectors expose no dedicated
delete or forward tool — compose from primitives (delete = modify +
add `TRASH`; forward = send with re-quoted body). For non-Gmail
accounts (IMAP / Outlook / iCloud / Yahoo), keep using the direct-mode
`/api/mail/<acct>/*` routes per the base `mail` skill body.

**Notion — DM read / search.** When `notion="native"`, use your
in-session Notion connector per the `notion` skill's native body
(search / fetch and the destructive set). Native:gemini mode assumes
the user has registered a Notion MCP server against their Gemini CLI;
the §9.3 probe at flip time verifies presence. The
`/api/notion/databases` config dump remains reachable in every mode.

The dispatch decision flow (capture user info, profile-question
reconcile, compose reply, route durable intent) is shared with the
direct variant via the `{{> base }}` partial below.

{{> base }}
