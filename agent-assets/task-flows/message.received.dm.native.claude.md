{context}

## DM Reply — Native Mode (Claude connectors)

Variant of `message.received.dm` selected when at least one integration
the agent may need to reach during this DM is in `native` mode and the
session backend (Claude) matches the integration's `nativeBackend`.

> **Connector routing (native).** `<integration_modes>` carries
> `gmail`, `google_calendar`, and `notion` mode attributes plus
> `<key>_native_backend="<backend>"` for every native key. The
> `<integration-routing-table>` block below is the audit table; the
> actionable per-integration routing table is what you act on. For any
> native integration the user's DM may need:
>
> - Call the in-session connector tools your harness exposes for that
>   service directly. Your tool menu lists every available tool at
>   session start. Per-service guidance lives in each skill's
>   `SKILL.native.claude.md` body materialised for this session
>   (`mail`, `external-services`, `notion`).
> - Do **NOT** call `POST /api/integrations/<key>/exec` — returns 410
>   with `X-Integration-Mode: native`.
> - Do **NOT** call the per-integration daemon routes listed in
>   `<integration-routing-table>` as `(DO NOT call /api/<key>/*)` —
>   each route-prefix returns 410 in native mode.
> - Write-class connector calls (per each connector's registry
>   `destructiveTools` set) still require explicit user confirmation
>   per `docs/design/09-safety-cost.md` §7. The absolute-block layer
>   continues to fire regardless of mode.
> - For direct-mode siblings (e.g. when `gmail="native"` and
>   `google_calendar="direct"`), keep using the direct routes
>   documented in the base skill body for the direct integrations —
>   the native gate is per-key.

### Per-session integration routing

<integration-routing-table>

### Native connector routing — per integration

The Calendar / Mail / Notion entries below override the matching
sections in the shared base flow. Mode-conditional markers in the base
(`<!-- mode:native:google_calendar -->`) still fire, but the explicit
prose here carries the per-service intent and the safety contract for
in-session connectors so the agent does not have to derive it mid-turn.

**Calendar — real-time queries.** When `google_calendar="native"`, use
your in-session Google Calendar connector (list events / get event /
list calendars / suggest free-busy slot). See the `external-services`
skill's native body for capability shapes and the destructive-confirm
contract for create / update / delete / RSVP. `/api/calendar/*` returns
410. `POST /api/integrations/google_calendar/exec` returns 410.

**Mail — DM read / draft / reply.** When `gmail="native"`, use your
in-session Gmail connector per the `mail` skill's native body (search
threads / read thread / create draft / label operations). The hosted
Gmail connector is typically **draft-only** — there is no send /
forward / delete surface. If the user explicitly asks to send, point
them at the Gmail web UI. For non-Gmail accounts (IMAP / Outlook /
iCloud / Yahoo), keep using the direct-mode `/api/mail/<acct>/*` routes
per the base `mail` skill body.

**Notion — DM read / search / page operations.** When `notion="native"`,
use your in-session Notion connector per the `notion` skill's native
body (search / fetch / read-class + the destructive set).
`/api/notion/databases` (label → UUID config dump) is still reachable
in every mode — consult it before any Notion read so the connector
call carries a concrete UUID.

The dispatch decision flow (capture user info, profile-question
reconcile, compose reply, route durable intent) is identical to the
direct variant and lives below via the `{{> base }}` partial. Read
through it after the per-integration overrides above.

{{> base }}
