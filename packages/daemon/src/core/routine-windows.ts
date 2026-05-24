/**
 * Routine data-acquisition window catalog.
 *
 * docs/design/appendices/routine-data-acquisition.md §6.5 — declarative map keyed by
 * `(routine, window-symbol, integration, mode)` that the pre-pass
 * fetcher (`routine.fetch_window`) and its assembly helper (§6.4)
 * consult to build the `<acquisition-plan>` block.
 *
 * Design invariants:
 *
 *  - **No model IDs.** Routine windows describe *what to fetch*; tier
 *    binding for `routine.fetch_window` lives in
 *    `process_backend_config` (db/schema.ts) and is resolved by the
 *    BackendRouter at session-spawn time.
 *  - **No daemon-side tool-name discovery.** `WINDOW_QUERIES[*][*][
 *    delegated-same | native]` carries the *query expression* the
 *    partial substitutes into its prose, not a tool name. The user's
 *    skills + bound tools resolve the call path (P7).
 *  - **Calendar / context-block dedup.** Routines whose calendar window
 *    is already covered by `ContextBuilder.buildCalendarBlock`
 *    (`<calendar_events_*>`) MUST NOT also list that window here,
 *    otherwise the agent reads the same events twice (R7). The matrix
 *    below curates `cal_next_24h` etc. only for routines whose
 *    ContextBuilder coverage does not match the desired window.
 */

import type { IntegrationKey, IntegrationMode } from "@aitne/shared";

// ── Window kinds + symbols ─────────────────────────────────────────────────

/**
 * The shape of fetch a row produces. `mail` and `calendar` rows may
 * fan out per account; `notion` rows are workspace-scoped.
 */
export type WindowKind = "mail" | "calendar" | "notion";

/**
 * Window symbols. Each routine declares the rows it needs from this
 * vocabulary; the partial body resolves the symbol → concrete query
 * via `WINDOW_QUERIES`. Names are stable identifiers — renaming one
 * cascades into every partial and every prompt-assembly call site, so
 * treat additions as additive.
 */
export const WINDOW_SYMBOLS = [
  // Mail
  "inbox_today",
  "unread_last_hour",
  "today_outcomes",
  // Calendar — only symbols a routine actually consumes. The §6.5
  // example listed cal_next_24h / cal_next_7d / cal_next_30d /
  // cal_tomorrow too, but ContextBuilder's multi-provider
  // `<calendar_events_*>` block (§6.6) covers those windows, so
  // duplicating them in the catalog would double-fetch (R7). When a
  // routine genuinely needs one of those, add the symbol back along
  // with the matching `ROUTINE_WINDOWS` row.
  "cal_next_24h_drift",
  // `cal_iso_week_to_now` — weekly_review's calendar retrospective.
  // Previously named `cal_past_7d` with rolling-7-day-ending-at-now
  // semantics, which (a) silently included
  // last week's Fri–Sun events that did not appear in any current-ISO-week
  // daily/*.md file, forcing the agent to disambiguate, and (b) misaligned
  // the direct-mode UTC `date+days` shape with the delegated/native
  // `timeMin/timeMax` shape, dropping today's events in direct mode. The
  // window is now anchored at the current ISO week's Monday 00:00 local
  // (matching the calendar-date keying of `daily/YYYY-MM-DD.md`) and runs
  // through `now`, so daily files and calendar retrospective cover the
  // same set of days across all three modes.
  "cal_iso_week_to_now",
  "imminent_2h",
  // morning_routine's 7-day calendar fetch. ContextBuilder's
  // `<calendar_events_7d>` covers `direct` mode inline,
  // but emits a "fetch yourself" directive for `delegated` / `native`
  // modes — which forces the main routine session (Sonnet) to drive the
  // MCP fan-out and burn medium-tier turns on a fetch the Haiku pre-pass
  // can do cheaper. This symbol is gated to non-direct cells in
  // WINDOW_QUERIES so the direct path stays unchanged.
  "cal_morning_7d",
  // Notion
  "updated_24h",
  "updated_1h",
] as const;
export type WindowSymbol = (typeof WINDOW_SYMBOLS)[number];

// ── Routine bindings ───────────────────────────────────────────────────────

/**
 * Routine ProcessKeys that the pre-pass fetcher can be dispatched for.
 * Kept narrow on purpose: only routines that need external data
 * acquisition appear here.
 *
 * `routine.morning_routine_initial` was retired by
 * `docs/design/appendices/morning-routine-optimization.md`. Both the
 * recurring and first-run branches now flow through
 * `routine.morning_routine`; the daemon-prepared `<roadmap_skeleton>`
 * block (not a window fetch) handles the first-run roadmap populate.
 */
export const ROUTINE_WINDOW_KEYS = [
  "routine.morning_routine",
  "routine.today_refresh",
  "routine.hourly_check",
  "routine.evening_review",
  "routine.weekly_review",
  "routine.monthly_review",
] as const;
export type RoutineWindowKey = (typeof ROUTINE_WINDOW_KEYS)[number];

export interface RoutineWindowSpec {
  /** Fetch shape — drives partial selection (mail-acquire vs calendar-acquire vs notion-acquire). */
  kind: WindowKind;
  /** Window symbol — resolved against `WINDOW_QUERIES` per (integration, mode). */
  window: WindowSymbol;
  /**
   * When `true`, fan the row out per active account **in `direct` mode
   * only**. Direct mode is the only configuration where the daemon
   * stores multiple per-account OAuth tokens and polls each
   * independently, so per-account `<fetch>` rows are meaningful there.
   *
   * In `delegated-same` / `delegated-cross` / `native` modes the
   * integration's bound MCP authenticates as a single user and the
   * daemon's `mail_accounts` table is intentionally empty — fanning
   * out would either produce zero rows (collapsing the plan to empty
   * and silently skipping the pre-pass, which was the failure mode
   * that motivated this contract) or duplicate work across stale
   * registry rows. `routine-acquisition-plan.ts` therefore emits a
   * single shared row without an `account` attribute for those modes;
   * the mail partials substitute `"default"` for `<accountId>` in the
   * observation contract.
   *
   * When `false`, emit one row per integration regardless of mode
   * (calendar / notion windows).
   */
  perAccount: boolean;
}

/**
 * Per-routine acquisition plan. The dispatcher resolves each row
 * against the current integration state and emits one `<fetch>` element
 * per applicable (mode, account) combination.
 *
 * Curation notes per row:
 *
 *  - `morning_routine` calendar omission: ContextBuilder injects
 *    `<calendar_events_7d>` for this routine (covers the standard
 *    next-week view). The pre-pass does NOT duplicate; it acquires the
 *    "next 24h" focus window only when ContextBuilder's 7-day block
 *    does not give the routine enough resolution for the day-plan
 *    synthesis — today the 7d block IS the resolution, so calendar is
 *    omitted from the morning pre-pass.
 *  - `today_refresh`: full 24h calendar fetch in every mode. The
 *    window name retains the historical `cal_next_24h_drift` slug for
 *    backwards-compatibility with operator overrides, but B2 dropped
 *    the server-side `updatedMin` / `lastModifiedDateTime ge` filter:
 *    "drift" semantics now lives entirely at the observation-row
 *    layer (server `contentHash` over `(source, payload)` returns 409
 *    on unchanged events, writes a fresh row only when the payload
 *    differs). The dispatcher's `applySinceFilter` in
 *    `db/observations.ts` ensures the main session reads back the
 *    merged pending set uniformly.
 *  - `hourly_check`: small, frequent. `unread_last_hour` typically
 *    yields ≤1 mail item; `imminent_2h` ≤1 calendar item. Notion
 *    `updated_1h` is similarly bounded.
 *  - `evening_review`: ContextBuilder covers `<calendar_events_3d>`,
 *    so no calendar row here. Mail `today_outcomes` is the "what did I
 *    send / reply today" retrospective signal.
 *  - `weekly_review`: ContextBuilder covers `<calendar_events_7d>`
 *    forward. The pre-pass adds the retrospective `cal_iso_week_to_now`
 *    so the weekly note has both directions, and the retrospective is
 *    anchored at the same ISO-week boundary the `daily/*.md` archive
 *    keys on (Monday 00:00 local through `now`).
 *  - `monthly_review`: ContextBuilder covers `<calendar_events_30d>`;
 *    monthly signals already flow through daily journals. The
 *    monthly review is summative — no pre-pass rows.
 */
export const ROUTINE_WINDOWS: Readonly<
  Record<RoutineWindowKey, readonly RoutineWindowSpec[]>
> = {
  "routine.morning_routine": [
    { kind: "mail", window: "inbox_today", perAccount: true },
    // A8 / Finding 5 — calendar pre-pass for non-direct modes only.
    // WINDOW_QUERIES[cal_morning_7d] intentionally omits the `direct`
    // cell, so this row resolves to a `<fetch>` only when at least
    // one calendar provider is in delegated / native mode. In direct
    // mode ContextBuilder already pre-fetches inline events into
    // `<calendar_events_7d>` and the row is silently skipped (no
    // double-fetch). Without this row, native-mode morning_routine
    // forced Sonnet to drive the calendar MCP fan-out itself —
    // shaving the seeded $1.00 envelope on a busy calendar day.
    { kind: "calendar", window: "cal_morning_7d", perAccount: false },
    { kind: "notion", window: "updated_24h", perAccount: false },
  ],
  // `routine.morning_routine_initial` is retired — its plan was identical
  // to `routine.morning_routine` above.
  "routine.today_refresh": [
    { kind: "calendar", window: "cal_next_24h_drift", perAccount: false },
  ],
  "routine.hourly_check": [
    { kind: "mail", window: "unread_last_hour", perAccount: true },
    { kind: "calendar", window: "imminent_2h", perAccount: false },
    { kind: "notion", window: "updated_1h", perAccount: false },
  ],
  "routine.evening_review": [
    { kind: "mail", window: "today_outcomes", perAccount: true },
  ],
  "routine.weekly_review": [
    { kind: "calendar", window: "cal_iso_week_to_now", perAccount: false },
  ],
  "routine.monthly_review": [],
};

// ── Per-(symbol, integration, mode) query expressions ─────────────────────

/**
 * Per-mode query expressions. `direct` carries the REST query string;
 * `delegated-same` / `delegated-cross` / `native` carry MCP-shape
 * arguments expressed in the partial's prose substitution form.
 *
 * Substitution tokens (replaced by `routine-acquisition-plan.ts`'s
 * `buildAcquisitionTimestamps` + `substituteAcquisitionTokens` at fetch
 * time):
 *
 *  ISO 8601 datetimes (UTC, used by MCP / Graph queries and as REST
 *  fallbacks where the route accepts a precise instant):
 *  - `{day_start_iso}`   — agent-day start in UTC ISO
 *  - `{day_end_iso}`     — agent-day end (start + 24h)
 *  - `{day_plus_24h}`    — alias for `{day_end_iso}`
 *  - `{day_plus_48h}`    — `{day_start_iso}` + 48h
 *  - `{day_plus_2h}`     — `{now_iso}` + 2h
 *  - `{hour_start_iso}`  — current hour boundary
 *  - `{now_iso}`         — current instant
 *  - `{iso_week_start_iso}` — current ISO week Monday 00:00 local in UTC
 *  - `{week_end_iso}`    — 7 days after `{day_start_iso}`
 *  - `{month_end_iso}`   — 30 days after `{day_start_iso}`
 *
 *  Date-only (`YYYY-MM-DD`) — used by `/api/calendar/events` and
 *  `/api/calendar/outlook/events`, which take `date=` + `days=`:
 *  - `{day_start_date}`     — agent-day start as `YYYY-MM-DD`
 *  - `{iso_week_start_date}` — current ISO week Monday in local time
 *  - `{now_date}`           — today's calendar date
 *
 * Missing-cell semantics: if `WINDOW_QUERIES[symbol]?.[integration]?
 * .[mode]` returns `undefined`, the acquisition-plan assembly helper
 * MUST omit the row entirely — that combination is not supported and
 * should never reach the partial (silent skip is fine because the
 * matrix below is curated against `ROUTINE_WINDOWS`; the omission is
 * not a runtime error).
 */
export const WINDOW_QUERIES: Readonly<
  Record<
    WindowSymbol,
    Partial<
      Record<IntegrationKey, Partial<Record<IntegrationMode, string>>>
    >
  >
> = {
  // ── Mail ────────────────────────────────────────────────────────────────
  // Direct-mode query strings target the unified mail route
  // `GET /api/mail/:accountId/messages` which accepts `since`, `limit`,
  // `unreadOnly`, `folder`, `q`. The previous draft of this catalog used
  // `?days=1` / `?unread=true` / `?sent_since=...` — none of those
  // parameters exist on the route, so the daemon silently fell back to
  // its default (today, no filter) and the routine read the wrong
  // window. The shapes below match the route handler's parsed query
  // params verbatim.
  // Gmail noise filter (`-category:promotions -category:social`) is baked
  // into every inbox-windowing query. Promotional and social-network
  // emails account for the majority of unread volume in most accounts and
  // are deterministic to identify (Gmail labels them server-side).
  // Promotional payloads (Amazon promo with NBSP in the subject is a
  // representative case) are exactly the kind of payload that's both
  // (a) noise the user doesn't want triaged and (b) likely to carry
  // shell-fragile Unicode whitespace. Filtering at the FETCH boundary
  // means the agent never sees these messages at all: zero cost, zero
  // chance of a Unicode-whitespace-bearing curl body, zero observations
  // for the morning_routine / hourly_check skill to wade through.
  //
  // Sent-folder windows (today_outcomes) skip the filter — sent mail is
  // the user's own writing, not promotional.
  //
  // Outlook has no equivalent server-side category — narrowing Outlook
  // noise is a follow-up (subject/from denylist, Phase D).
  //
  // URL encoding: `&q=` value is space-encoded to `+` and `:` to `%3A`
  // so the daemon's `c.req.query("q")` decoder reads the intended Gmail
  // operator string. The MCP-shape (delegated / native) query passes
  // through the partial verbatim into the agent's tool call; no URL
  // encoding needed because the value is JSON-string-typed at the MCP
  // boundary.
  inbox_today: {
    gmail: {
      direct:
        "?since={day_start_iso}&limit=20&q=-category%3Apromotions+-category%3Asocial",
      delegated:
        'q="newer_than:1d -category:promotions -category:social" maxResults=20',
      native:
        'q="newer_than:1d -category:promotions -category:social" maxResults=20',
    },
    outlook_mail: {
      direct: "?since={day_start_iso}&limit=20",
      // userManagedConnector — delegated-same / delegated-cross / native
      // converge on the same in-session surface (no daemon proxy exists).
      // The partial encodes the convergence in prose; the query string
      // below describes the intent in Graph-filter form so the user's
      // skill can translate it.
      delegated: "filter=receivedDateTime ge {day_start_iso}",
      native: "filter=receivedDateTime ge {day_start_iso}",
    },
  },
  unread_last_hour: {
    gmail: {
      direct:
        "?since={hour_start_iso}&unreadOnly=true&limit=10&q=-category%3Apromotions+-category%3Asocial",
      delegated:
        'q="is:unread newer_than:1h -category:promotions -category:social" maxResults=10',
      native:
        'q="is:unread newer_than:1h -category:promotions -category:social" maxResults=10',
    },
    outlook_mail: {
      direct: "?since={hour_start_iso}&unreadOnly=true&limit=10",
      delegated:
        "filter=isRead eq false and receivedDateTime ge {hour_start_iso}",
      native:
        "filter=isRead eq false and receivedDateTime ge {hour_start_iso}",
    },
  },
  today_outcomes: {
    gmail: {
      direct: "?folder=sent&since={day_start_iso}&limit=30",
      delegated: 'q="in:sent newer_than:1d" maxResults=30',
      native: 'q="in:sent newer_than:1d" maxResults=30',
    },
    outlook_mail: {
      direct: "?folder=sent&since={day_start_iso}&limit=30",
      delegated: "filter=sentDateTime ge {day_start_iso}&folder=sentitems",
      native: "filter=sentDateTime ge {day_start_iso}&folder=sentitems",
    },
  },

  // ── Calendar ────────────────────────────────────────────────────────────
  // Direct-mode query strings target `GET /api/calendar/events`
  // (Google) and `GET /api/calendar/outlook/events` (Outlook). Both
  // routes accept `date=YYYY-MM-DD` + `days=N` (≤90); they do NOT
  // accept `timeMin` / `timeMax` — those tokens were silently dropped
  // by the route handler in the previous catalog draft, defaulting
  // every window to "today + 1 day". The `{*_date}` tokens below are
  // calendar-date-only variants of the corresponding ISO tokens; the
  // assembly helper substitutes both. Delegated/native cells retain
  // the MCP-shape timestamps because session connectors typically take
  // ISO ranges.
  //
  // `cal_next_24h_drift` is intentionally NOT a server-side delta
  // filter. docs/design/appendices/routine-data-acquisition.md §7.2 / B2 — the daemon
  // does not track a per-routine "last sync" anchor today; using
  // `hour_start_iso` (or the equivalent `lastModifiedDateTime ge` on
  // Graph) lost any change that happened earlier in the today_refresh
  // cron interval (4h cadence). Every mode now fetches the full 24h
  // window; the server `contentHash` over `(source, payload)` upserts
  // unchanged events to 409 and writes a fresh row only when the
  // payload differs. The "drift" semantics is therefore captured at
  // the observation-row layer, not the upstream-fetch layer — and
  // remains uniform across direct / delegated / native.
  cal_next_24h_drift: {
    google_calendar: {
      direct: "?date={day_start_date}&days=1",
      delegated:
        'timeMin="{now_iso}" timeMax="{day_plus_24h}" maxResults=100',
      native:
        'timeMin="{now_iso}" timeMax="{day_plus_24h}" maxResults=100',
    },
    outlook_calendar: {
      direct: "?date={day_start_date}&days=1",
      delegated: "startDateTime={now_iso}&endDateTime={day_plus_24h}",
      native: "startDateTime={now_iso}&endDateTime={day_plus_24h}",
    },
  },
  // `cal_iso_week_to_now` — weekly_review retrospective spanning the
  // current ISO week's Monday 00:00 local through `now`. Direct mode uses
  // `timeMin`/`timeMax` on `/api/calendar/events` so the daemon REST
  // path returns the same window the delegated/native MCP fan-out sees.
  // Before the rename this row used a UTC `date+days=7` shape, which
  // (a) silently dropped current-day events
  // for non-UTC timezones (the window ended at today's UTC midnight, i.e.
  // 09:00 JST) and (b) drifted away from the ISO week boundary that
  // `daily/YYYY-MM-DD.md` is keyed on.
  cal_iso_week_to_now: {
    google_calendar: {
      direct: "?timeMin={iso_week_start_iso}&timeMax={now_iso}",
      delegated:
        'timeMin="{iso_week_start_iso}" timeMax="{now_iso}" maxResults=100',
      native:
        'timeMin="{iso_week_start_iso}" timeMax="{now_iso}" maxResults=100',
    },
    outlook_calendar: {
      direct: "?timeMin={iso_week_start_iso}&timeMax={now_iso}",
      delegated: "startDateTime={iso_week_start_iso}&endDateTime={now_iso}",
      native: "startDateTime={iso_week_start_iso}&endDateTime={now_iso}",
    },
  },
  // A8 / Finding 5 — morning_routine 7-day calendar window.
  // `direct` cells are intentionally OMITTED — in direct mode
  // ContextBuilder pre-fetches inline events via the daemon's
  // CalendarService (Google) or routes the agent to /api/calendar/outlook
  // (Outlook), so a pre-pass row would double-fetch. The dispatcher
  // skips rows whose `(symbol, integration, mode)` cell is undefined
  // (cf. `lookupQuery`); pre-pass only fires for delegated / native.
  cal_morning_7d: {
    google_calendar: {
      delegated:
        'timeMin="{day_start_iso}" timeMax="{week_end_iso}" maxResults=100',
      native:
        'timeMin="{day_start_iso}" timeMax="{week_end_iso}" maxResults=100',
    },
    outlook_calendar: {
      delegated: "startDateTime={day_start_iso}&endDateTime={week_end_iso}",
      native: "startDateTime={day_start_iso}&endDateTime={week_end_iso}",
    },
  },
  imminent_2h: {
    google_calendar: {
      // The REST route's smallest legal window is one day; the pre-pass
      // fetches today's events and the partial body filters to the next
      // 2h client-side. Delegated/native carry the precise 2h window
      // because MCP surfaces accept arbitrary ISO ranges.
      direct: "?date={now_date}&days=1",
      delegated:
        'timeMin="{now_iso}" timeMax="{day_plus_2h}" maxResults=10',
      native:
        'timeMin="{now_iso}" timeMax="{day_plus_2h}" maxResults=10',
    },
    outlook_calendar: {
      direct: "?date={now_date}&days=1",
      delegated: "startDateTime={now_iso}&endDateTime={day_plus_2h}",
      native: "startDateTime={now_iso}&endDateTime={day_plus_2h}",
    },
  },

  // ── Notion ──────────────────────────────────────────────────────────────
  // Direct-mode query strings target `GET /api/notion/search`, which
  // accepts `q`, `type`, `sort`, `page_size`, `start_cursor`. The route
  // has NO time filter — the partial body filters client-side using the
  // `last_edited_time` of each result against the window threshold the
  // partial knows from its symbol. `sort=descending` plus a generous
  // `page_size` ensures the pre-pass sees every page edited within the
  // window without paginating.
  updated_24h: {
    notion: {
      direct: "?page_size=50&sort=descending",
      delegated: "last_edited_time>={day_start_iso}",
      native: "last_edited_time>={day_start_iso}",
    },
  },
  updated_1h: {
    notion: {
      direct: "?page_size=20&sort=descending",
      delegated: "last_edited_time>={hour_start_iso}",
      native: "last_edited_time>={hour_start_iso}",
    },
  },
};

/**
 * Resolve `WINDOW_QUERIES[symbol]?.[integration]?.[mode]`. Returns
 * `undefined` when the cell is unmapped — callers MUST treat that as
 * "skip this row" rather than emitting an empty query string.
 */
export function lookupWindowQuery(
  symbol: WindowSymbol,
  integration: IntegrationKey,
  mode: IntegrationMode,
): string | undefined {
  return WINDOW_QUERIES[symbol]?.[integration]?.[mode];
}

/**
 * True when the routine has any rows that the pre-pass needs to fetch.
 * The dispatcher skips spawning a pre-pass session when this returns
 * false — saves a cold-start for routines whose data needs are already
 * covered by ContextBuilder blocks (today: `monthly_review`).
 */
export function routineHasWindows(key: RoutineWindowKey): boolean {
  return ROUTINE_WINDOWS[key].length > 0;
}

// Note: there is intentionally no `routineHasCalendarPrepass` helper
// even though every morning_routine / hourly_check / today_refresh /
// weekly_review row carries a calendar entry. The decision a caller
// (e.g. ContextBuilder.buildCalendarBlock) really wants to make is
// "does the pre-pass own the window I'm about to emit," and that needs
// a window-by-window match between ROUTINE_WINDOWS and the requested
// days — `cal_iso_week_to_now` for weekly_review does NOT cover ContextBuilder's
// future 7d block, so a coarse "has calendar row" predicate would be
// the wrong abstraction. ContextBuilder's call-sites pass an explicit
// `prepassCovers` flag instead, derived from local knowledge of
// which window they are constructing.
