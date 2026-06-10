/**
 * `<acquisition-plan>` block assembly for the routine pre-pass fetcher.
 *
 * docs/design/appendices/routine-data-acquisition.md §6.4 / F5 — pure helper that the
 * routine dispatchers (Phase 4) call to render the XML block the
 * `routine.fetch_window` session reads. Stays I/O-free so it can be
 * tested in isolation against synthetic integration state.
 *
 * The block lists one `<fetch>` element per (integration × mode × account)
 * combination implied by `ROUTINE_WINDOWS[routine]` and the current
 * integration state. Disabled integrations and unmapped query cells are
 * skipped; `native` bindings whose `nativeBackend` differs from the
 * input `sessionBackend` are NOT skipped — `resolveIntegrationBackend`
 * routes the row to its actual `nativeBackend` and the runner spawns
 * each sub-session on its `requiredBackend` via the BackendRouter's
 * backend-only override.
 *
 * Output shape (§6.4 example, but with substituted timestamps and the
 * resolved mode-suffix the partial filters on):
 *
 * ```xml
 * <acquisition-plan routine="morning_routine" agent_day="2026-05-11">
 *   <fetch integration="gmail" mode="direct" window="inbox_today"
 *          account="alice@gmail.com" query="?days=1&amp;limit=20" />
 *   ...
 * </acquisition-plan>
 * ```
 */

import {
  INTEGRATION_KEYS,
  getAgentDayBoundsUtc,
  getIntegrationDescriptor,
  nowInTimezone,
  parseSqliteUtcMs,
  type BackendId,
  type IntegrationKey,
  type IntegrationState,
} from "@aitne/shared";
import {
  ROUTINE_WINDOWS,
  WINDOW_QUERIES,
  type RoutineWindowKey,
  type WindowSymbol,
} from "./routine-windows.js";

// ── Public types ───────────────────────────────────────────────────────────

/**
 * Per-mode predicate string the partial filters on. Matches the predicate
 * names used by `applyIntegrationModeFilter` in `@aitne/shared`.
 */
export type AcquisitionFetchMode =
  | "direct"
  | "delegated-same"
  | "delegated-cross"
  | "native";

/**
 * Why a (window × integration) cell was dropped at plan-assembly time —
 * PREPASS_COST_REDUCTION_PLAN.md N3. Before N3 these drops vanished
 * without a trace; the runner now writes one `skipped` audit row per
 * (integration × reason) group so the deferred no-surface streak skip
 * (R5) and the empty-window backoff (R4) can be sized from data.
 *
 *  - `no_state` — integration absent from the `readIntegrations` snapshot.
 *  - `no_binding` — delegated/native mode with a null backend binding.
 *  - `disabled` — integration mode is explicitly `disabled`.
 *  - `unknown_mode` — unrecognized mode string (forward-compat guard).
 *  - `no_window_query` — `WINDOW_QUERIES` has no cell for the
 *    (window, integration, mode) tuple where one was expected — a
 *    genuine catalog hole.
 *  - `no_accounts` — direct-mode per-account fan-out with zero active
 *    accounts for the integration.
 *  - `direct_inline_prefetch` — the catalog *deliberately* omits the
 *    `direct` cell because the daemon serves that data inline
 *    (ContextBuilder pre-fetch / REST route) and a pre-pass row would
 *    double-fetch (cf. `cal_morning_7d` in routine-windows.ts). Working
 *    as designed, so the runner does NOT write an audit row for it —
 *    counting it as a drop would pollute the R4/R5 sizing data the N3
 *    audit stream exists to provide.
 */
export type AcquisitionPlanDropReason =
  | "no_state"
  | "no_binding"
  | "disabled"
  | "unknown_mode"
  | "no_window_query"
  | "no_accounts"
  | "direct_inline_prefetch";

/** One dropped (window × integration) cell. */
export interface AcquisitionPlanDrop {
  integration: IntegrationKey;
  window: WindowSymbol;
  reason: AcquisitionPlanDropReason;
}

export interface AcquisitionAccount {
  /**
   * Integration key the account belongs to. Today only `gmail` and
   * `outlook_mail` map per-account; future per-calendar fan-out could
   * add `google_calendar` / `outlook_calendar` rows.
   */
  integration: IntegrationKey;
  /** Stable account identifier (e.g. mail account row id). */
  accountId: string;
  /**
   * Optional human label included verbatim in the `<fetch>` element for
   * debugging — usually the email address.
   */
  label?: string;
}

export interface AcquisitionTimestamps {
  /** Current instant, ISO 8601 UTC. */
  now_iso: string;
  /** Top-of-current-hour boundary, ISO 8601 UTC. */
  hour_start_iso: string;
  /** Agent-day start (per `dayBoundaryHour`) as UTC ISO. */
  day_start_iso: string;
  /** Agent-day start + 24h as UTC ISO. */
  day_end_iso: string;
  /** Same as `day_end_iso`, retained as an alias for readability. */
  day_plus_24h: string;
  /** Agent-day start + 48h. */
  day_plus_48h: string;
  /** Current instant + 2h. */
  day_plus_2h: string;
  /**
   * Current ISO week's Monday at 00:00 local-time, expressed as a UTC
   * ISO instant. The "ISO week" follows ISO-8601 (Mon = week start,
   * Sun = week end). `weekly_review`'s `cal_iso_week_to_now` window
   * uses this as `timeMin` so the calendar retrospective and the
   * archived `daily/YYYY-MM-DD.md` files (which are also keyed by the
   * ISO week's Mon–Sun calendar dates) cover the same days. The
   * anchor is **00:00 local**, not the agent-day boundary, because
   * the `daily/*.md` cadence is also calendar-date-keyed.
   */
  iso_week_start_iso: string;
  /** Agent-day start + 7 days. */
  week_end_iso: string;
  /** Agent-day start + 30 days. */
  month_end_iso: string;
  /**
   * Date-only (`YYYY-MM-DD`) variants used by the daemon's calendar
   * REST routes (`GET /api/calendar/events` and
   * `GET /api/calendar/outlook/events`), which take `date=` + `days=`
   * rather than `timeMin` / `timeMax`. The date is the calendar date in
   * UTC of the corresponding ISO timestamp — the assembly helper does
   * not re-shift into local time because the REST routes themselves
   * parse the date in UTC.
   */
  day_start_date: string;
  /** Current ISO week Monday in local time, as a `YYYY-MM-DD` slug. */
  iso_week_start_date: string;
  /** Today's calendar date in UTC. */
  now_date: string;
}

export interface BuildAcquisitionPlanInput {
  routine: RoutineWindowKey;
  /** YYYY-MM-DD; rendered as the block's `agent_day` attribute. */
  agentDay: string;
  /** Current integration state (mode + bindings) — `readIntegrations(db)` output. */
  integrations: Partial<Record<IntegrationKey, IntegrationState>>;
  /** Backend that will run the pre-pass session. Drives same/cross predicate resolution. */
  sessionBackend: BackendId;
  /**
   * Active per-account fan-out for the integrations that flag
   * `perAccount: true` in `ROUTINE_WINDOWS`. Today: mail accounts
   * (gmail / outlook_mail). If empty, perAccount rows are skipped
   * silently — the pre-pass simply has nothing to do for that
   * integration.
   */
  accounts: readonly AcquisitionAccount[];
  /** Pre-computed timestamps used to substitute window-query tokens. */
  timestamps: AcquisitionTimestamps;
}

/**
 * Compute the timestamp set the assembly helper uses. Anchors to the
 * agent-day boundary `dayBoundaryHour` (configurable; the daemon's
 * config default is 4 = 04:00 local per CLAUDE.md), so
 * `day_start_iso` matches the same UTC instant `getAgentDayBoundsUtc`
 * uses everywhere else in the daemon.
 *
 * The parameter has no built-in default — callers MUST thread
 * `config.dayBoundaryHour` through so a future config change does not
 * silently desync this layer from the rest of the daemon. Tests can
 * pass `0` for stable arithmetic against a UTC fixture.
 */
export function buildAcquisitionTimestamps(
  now: Date,
  timezone: string | undefined,
  dayBoundaryHour: number,
): AcquisitionTimestamps {
  const bounds = getAgentDayBoundsUtc(timezone, dayBoundaryHour, now);
  const dayStartMs = parseSqliteUtcMs(bounds.start);
  const dayEndMs = dayStartMs + 24 * 60 * 60 * 1000;
  const day48Ms = dayStartMs + 48 * 60 * 60 * 1000;
  const weekEndMs = dayStartMs + 7 * 24 * 60 * 60 * 1000;
  const monthEndMs = dayStartMs + 30 * 24 * 60 * 60 * 1000;
  const nowMs = now.getTime();
  const hourStartMs = nowMs - (nowMs % (60 * 60 * 1000));
  const plus2hMs = nowMs + 2 * 60 * 60 * 1000;
  // ISO week anchor — Monday 00:00 in the configured local timezone,
  // expressed as a UTC instant. Computed in two steps:
  //   1. Walk back from today (local) to this ISO week's Monday in
  //      local-calendar space (TZ-naive at the date level).
  //   2. Resolve "Monday 00:00 local" to its UTC instant via
  //      getAgentDayBoundsUtc with `dayBoundaryHour=0`, which already
  //      handles DST transitions correctly for non-UTC zones.
  // The local-calendar walk is intentionally separate from the
  // agent-day boundary anchor — `weekly_review`'s `daily/YYYY-MM-DD.md`
  // archive is keyed by local calendar date, so the ISO week must be
  // anchored at midnight local even when `dayBoundaryHour ≠ 0`.
  const local = nowInTimezone(timezone, now);
  const noonUtcAnchor = new Date(
    Date.UTC(local.year, local.month - 1, local.day, 12),
  );
  const dayNrFromMon = (noonUtcAnchor.getUTCDay() + 6) % 7; // Mon=0, Sun=6
  const mondayAnchorUtc = new Date(noonUtcAnchor);
  mondayAnchorUtc.setUTCDate(noonUtcAnchor.getUTCDate() - dayNrFromMon);
  const mondayBounds = getAgentDayBoundsUtc(timezone, 0, mondayAnchorUtc);
  const isoWeekStartMs = parseSqliteUtcMs(mondayBounds.start);
  const dateOnly = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  return {
    now_iso: new Date(nowMs).toISOString(),
    hour_start_iso: new Date(hourStartMs).toISOString(),
    day_start_iso: new Date(dayStartMs).toISOString(),
    day_end_iso: new Date(dayEndMs).toISOString(),
    day_plus_24h: new Date(dayEndMs).toISOString(),
    day_plus_48h: new Date(day48Ms).toISOString(),
    day_plus_2h: new Date(plus2hMs).toISOString(),
    iso_week_start_iso: new Date(isoWeekStartMs).toISOString(),
    week_end_iso: new Date(weekEndMs).toISOString(),
    month_end_iso: new Date(monthEndMs).toISOString(),
    day_start_date: dateOnly(dayStartMs),
    iso_week_start_date: dateOnly(isoWeekStartMs),
    now_date: dateOnly(nowMs),
  };
}

// ── Internal helpers ───────────────────────────────────────────────────────

/**
 * The integrations a window symbol applies to. Used to map a routine's
 * `RoutineWindowSpec.kind` onto concrete integration keys. Walking
 * `WINDOW_QUERIES[symbol]` keeps the catalog as the single source of
 * truth — no hardcoded "mail → gmail+outlook_mail" mapping here.
 */
function integrationsForWindow(symbol: WindowSymbol): IntegrationKey[] {
  return Object.keys(WINDOW_QUERIES[symbol] ?? {}) as IntegrationKey[];
}

/**
 * Resolve the integration's runtime mode to the predicate string the
 * partial filters on. Returns `null` when the row should be skipped
 * (disabled, missing state, native binding on a different backend).
 *
 * §6.8 / §3 glossary — for `userManagedConnector` integrations
 * (today: `outlook_mail`, `outlook_calendar`) the daemon ships no
 * `/api/integrations/<key>/exec` proxy, so `delegated-cross` is
 * unreachable. The dispatcher MUST collapse cross-backend delegated to
 * `delegated-same` for these descriptors — the only viable path is
 * the session backend's own MCP, identical to same-backend. Without
 * this collapse, the partial's `delegated-cross` defensive guard
 * fires every tick instead of remaining dormant.
 */
function resolveFetchMode(
  integration: IntegrationKey,
  state: IntegrationState | undefined,
  sessionBackend: BackendId,
): AcquisitionFetchMode | AcquisitionPlanDropReason {
  if (!state) return "no_state";
  switch (state.mode) {
    case "direct":
      return "direct";
    case "delegated":
      if (state.delegatedBackend === sessionBackend) {
        return "delegated-same";
      }
      // Cross-backend delegated requires a non-null `delegatedBackend`.
      // Missing binding ≈ misconfiguration → skip.
      if (
        state.delegatedBackend !== null
        && state.delegatedBackend !== undefined
      ) {
        // User-managed integrations have no daemon proxy; collapse to
        // same-backend so the partial body's main delegated-same prose
        // runs instead of its defensive delegated-cross fallback.
        if (getIntegrationDescriptor(integration).userManagedConnector === true) {
          return "delegated-same";
        }
        return "delegated-cross";
      }
      return "no_binding";
    case "native":
      // Native binding must match the session backend. Otherwise the
      // partial's `mode:native:<key>` block would be filtered out by
      // `applyIntegrationModeFilter` anyway — skip the row to avoid
      // emitting a `<fetch>` that no branch can handle. With
      // per-integration backend routing (`resolveIntegrationBackend`)
      // the caller passes the integration's own `nativeBackend` here, so
      // in practice this branch only drops rows whose binding is null.
      if (state.nativeBackend === sessionBackend) return "native";
      return "no_binding";
    case "disabled":
      return "disabled";
    default:
      return "unknown_mode";
  }
}

/** Narrow a `resolveFetchMode` result to the fetch-mode side of the union. */
function isFetchMode(
  value: AcquisitionFetchMode | AcquisitionPlanDropReason,
): value is AcquisitionFetchMode {
  return (
    value === "direct"
    || value === "delegated-same"
    || value === "delegated-cross"
    || value === "native"
  );
}

/**
 * Resolve the backend the sub-session for this integration MUST run on
 * so that the partial body's resolved `mode:` block has a working wire
 * surface (MCP tools, daemon REST, or daemon proxy).
 *
 * Semantics:
 *  - `native`: the MCP tools only exist on the `nativeBackend`; the
 *    sub-session has to spawn there. This is the case the previous
 *    single-backend pre-pass model silently dropped via `resolveFetchMode`
 *    returning `null` when `nativeBackend !== sessionBackend` — fixed
 *    structurally by routing the sub-session to `nativeBackend` instead.
 *  - `delegated` + `userManagedConnector`: there is no daemon
 *    `/api/integrations/<key>/exec` proxy for these descriptors (Outlook
 *    today), so cross-backend delegated collapses to delegated-same. The
 *    sub-session must spawn on `delegatedBackend` to reach the user's
 *    own MCP.
 *  - `delegated` + non-userManaged + same-backend
 *    (`delegatedBackend === defaultBackend`): MCP on the default backend
 *    — sub-session stays on `defaultBackend` (no change).
 *  - `delegated` + non-userManaged + cross-backend: the partial uses the
 *    daemon proxy via curl — sub-session can spawn anywhere, default
 *    backend keeps the pre-pass tier predictable.
 *  - `direct`: REST via curl to the daemon — sub-session stays on
 *    `defaultBackend`.
 *  - `disabled` / no state: irrelevant (`resolveFetchMode` returns a
 *    drop reason and the row is dropped before backend matters);
 *    returning `defaultBackend` is a no-op safety default.
 *
 * The function is intentionally `null`-free — every call site benefits
 * from a guaranteed backend so the per-integration spawn path never has
 * to short-circuit on missing data.
 */
function resolveIntegrationBackend(
  integration: IntegrationKey,
  state: IntegrationState | undefined,
  defaultBackend: BackendId,
): BackendId {
  if (!state) return defaultBackend;
  if (state.mode === "native" && state.nativeBackend) {
    return state.nativeBackend;
  }
  if (state.mode === "delegated" && state.delegatedBackend) {
    if (getIntegrationDescriptor(integration).userManagedConnector === true) {
      return state.delegatedBackend;
    }
    // Non-userManaged delegated: same-backend uses the default's MCP
    // (delegatedBackend == defaultBackend by definition); cross-backend
    // uses the daemon proxy from any session. Either way, returning
    // `defaultBackend` keeps the spawn on the configured fetch_window
    // backend, which is the right tier-cost-predictable choice.
    return defaultBackend;
  }
  return defaultBackend;
}

/**
 * Resolve the WINDOW_QUERIES cell for a (symbol, integration, mode)
 * tuple. delegated-same / delegated-cross both look up "delegated" in
 * the catalog; the predicate distinction is only meaningful at the
 * partial-filtering layer.
 */
function lookupQuery(
  symbol: WindowSymbol,
  integration: IntegrationKey,
  fetchMode: AcquisitionFetchMode,
): string | undefined {
  const catalog = WINDOW_QUERIES[symbol]?.[integration];
  if (!catalog) return undefined;
  if (fetchMode === "delegated-same" || fetchMode === "delegated-cross") {
    return catalog.delegated;
  }
  return catalog[fetchMode];
}

/**
 * Substitute `{token}` placeholders in a query string with the
 * pre-computed timestamps. Unknown tokens are left verbatim — they will
 * surface as `{foo}` in the rendered prompt, which is visible failure
 * (the partial author can grep for `{` in their query).
 */
export function substituteAcquisitionTokens(
  query: string,
  timestamps: AcquisitionTimestamps,
): string {
  return query.replace(
    /\{([a-z_][a-z0-9_]*)\}/g,
    (match, name: string) => {
      const value = (timestamps as unknown as Record<string, string | undefined>)[name];
      return value ?? match;
    },
  );
}

/**
 * Attribute escaping for non-query `<fetch>` attribute values
 * (`integration`, `mode`, `window`, `account`, `label`, and the
 * block's `routine` / `agent_day`). These are short tokens drawn
 * from controlled vocabularies; the conventional XML escape set
 * keeps them robust against future authors who slip a special
 * character in.
 */
function xmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Escaping for the `<fetch query='…'>` attribute, which uses
 * single-quote delimiters so URL query strings can be rendered
 * verbatim.
 *
 * The consumer of this block is the LLM, not an XML parser — the
 * agent is told to use the `query` attribute literally as a URL
 * query string (`GET .../messages<query>`) or as MCP-tool arguments
 * (`q="newer_than:1d"`). Two characters in our catalog would
 * otherwise need entity-decode steps the agent must remember:
 *  - `&` separates URL query parameters (`?a=1&b=2`),
 *  - `"` wraps Gmail / Calendar MCP query expressions
 *    (`q="newer_than:1d"`, `timeMin="…"`).
 *
 * Single-quote delimiters let us keep both literal. The only
 * character that would now break the attribute structure is `'`,
 * which no query in `WINDOW_QUERIES` uses today. We escape `'` and
 * `<` / `>` defensively for any future catalog author who uses
 * them.
 */
function xmlQueryAttr(value: string): string {
  return value
    .replace(/'/g, "&apos;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

interface FetchRow {
  integration: IntegrationKey;
  mode: AcquisitionFetchMode;
  window: WindowSymbol;
  accountId?: string;
  label?: string;
  query: string;
  /**
   * Backend the sub-session for this row's integration must spawn on.
   * Computed by `resolveIntegrationBackend` from the integration's mode +
   * binding; bubbled up to `AcquisitionSubPlan.requiredBackend` so the
   * runner's per-integration spawn can pass it as `requestedBackendId`
   * to the BackendRouter. Not rendered in the `<fetch>` element — the
   * partial body is mode-aware but not backend-aware, and the daemon
   * never embeds backend names in agent-visible blocks.
   */
  requiredBackend: BackendId;
}

function renderFetchRow(row: FetchRow): string {
  const parts: string[] = [
    `integration="${xmlAttr(row.integration)}"`,
    `mode="${xmlAttr(row.mode)}"`,
    `window="${xmlAttr(row.window)}"`,
  ];
  if (row.accountId !== undefined) {
    parts.push(`account="${xmlAttr(row.accountId)}"`);
  }
  if (row.label !== undefined) {
    parts.push(`label="${xmlAttr(row.label)}"`);
  }
  // Single-quote delimiter on `query=` — see `xmlQueryAttr` rationale.
  parts.push(`query='${xmlQueryAttr(row.query)}'`);
  return `  <fetch ${parts.join(" ")} />`;
}

// ── Row collection (shared by buildAcquisitionPlan + splitAcquisitionPlanByIntegration) ──

/**
 * Resolve every `<fetch>` row implied by `input` from the routine
 * catalog + integration state. Pure, deterministic, ordering-stable —
 * the loop walks `ROUTINE_WINDOWS[routine]` in spec order, then
 * `WINDOW_QUERIES[symbol]` key order. Both consumers (`buildAcquisitionPlan`
 * and `splitAcquisitionPlanByIntegration`) share this so the rendered
 * monolithic block and the union of per-integration sub-plan blocks
 * carry bit-identical row sequences.
 */
function collectFetchRows(
  input: BuildAcquisitionPlanInput,
  /**
   * N3 observability hook — invoked once per dropped (window ×
   * integration) cell with the drop reason. Optional so the render-only
   * consumers (`buildAcquisitionPlan`, `rebuildSubPlanForBackend`) pay
   * nothing.
   */
  onDrop?: (drop: AcquisitionPlanDrop) => void,
): FetchRow[] {
  const rows: FetchRow[] = [];
  const specs = ROUTINE_WINDOWS[input.routine];

  for (const spec of specs) {
    const integrations = integrationsForWindow(spec.window);
    for (const integration of integrations) {
      const state = input.integrations[integration];
      // Per-integration backend resolution. Was: `input.sessionBackend`
      // (single backend for the whole plan), which caused `resolveFetchMode`
      // to drop rows for native bindings on a different backend. With
      // `resolveIntegrationBackend` the sub-session is routed to the
      // integration's actual bound backend (`nativeBackend`, or
      // `delegatedBackend` for userManagedConnector), and
      // `resolveFetchMode` then matches on the correct backend so the
      // row survives. The runner uses `requiredBackend` (bubbled up via
      // `FetchRow`) to spawn each sub-session on the right backend via
      // `BackendRouter.resolveBinding({ requestedBackendId })`.
      const requiredBackend = resolveIntegrationBackend(
        integration,
        state,
        input.sessionBackend,
      );
      const fetchMode = resolveFetchMode(integration, state, requiredBackend);
      if (!isFetchMode(fetchMode)) {
        onDrop?.({ integration, window: spec.window, reason: fetchMode });
        continue;
      }

      const queryTemplate = lookupQuery(spec.window, integration, fetchMode);
      if (queryTemplate === undefined) {
        // `integrationsForWindow` only yields integrations present in
        // the catalog for this window, so an undefined template means
        // the MODE cell is missing. For `direct` that is the documented
        // intentional pattern (cf. `cal_morning_7d` in
        // routine-windows.ts): the daemon serves the data inline, so the
        // pre-pass must not double-fetch. Any other mode is a genuine
        // catalog hole.
        onDrop?.({
          integration,
          window: spec.window,
          reason: fetchMode === "direct"
            ? "direct_inline_prefetch"
            : "no_window_query",
        });
        continue;
      }
      const query = substituteAcquisitionTokens(queryTemplate, input.timestamps);

      // perAccount fan-out is meaningful only in `direct` mode, where the
      // daemon stores per-account OAuth tokens and polls each. In
      // `delegated-same` / `delegated-cross` / `native` the integration's
      // bound MCP authenticates as a single user, and `mail_accounts` in
      // the daemon DB is intentionally empty — fanning out would produce
      // zero rows and silently skip the pre-pass entirely (the failure
      // mode that left Sonnet doing both fetch and synthesis in one run
      // and hitting `routine.morning_routine`'s $1 budget cap). Emit one
      // shared row for non-direct modes; the partial body substitutes
      // `"default"` for the missing `<accountId>` in the observation
      // contract. Same pattern as the userManagedConnector
      // delegated-cross → delegated-same collapse in `resolveFetchMode`:
      // the dispatcher folds away configurations that have no real wire
      // surface so the partials never need to defend against them.
      if (spec.perAccount && fetchMode === "direct") {
        const accountRows = input.accounts.filter(
          (a) => a.integration === integration,
        );
        if (accountRows.length === 0) {
          onDrop?.({ integration, window: spec.window, reason: "no_accounts" });
        }
        for (const account of accountRows) {
          rows.push({
            integration,
            mode: fetchMode,
            window: spec.window,
            accountId: account.accountId,
            label: account.label,
            query,
            requiredBackend,
          });
        }
      } else {
        rows.push({
          integration,
          mode: fetchMode,
          window: spec.window,
          query,
          requiredBackend,
        });
      }
    }
  }
  return rows;
}

/**
 * Render the `<acquisition-plan>` wrapper around a row sequence.
 * `scoped` is an optional fan-out debugging affordance — when set, the
 * block's element carries a `scoped="<key>"` attribute so a sub-plan is
 * visually distinguishable from a full plan in the daemon log and in
 * test fixtures. The partials ignore the attribute.
 */
function renderAcquisitionPlanBlock(
  routine: RoutineWindowKey,
  agentDay: string,
  rows: readonly FetchRow[],
  scoped?: IntegrationKey,
): string {
  // Strip the `routine.` prefix in the attribute for compactness; the
  // surrounding daemon log carries the full ProcessKey.
  const routineAttr = routine.replace(/^routine\./, "");
  const openParts = [
    `routine="${xmlAttr(routineAttr)}"`,
    `agent_day="${xmlAttr(agentDay)}"`,
  ];
  if (scoped !== undefined) {
    openParts.push(`scoped="${xmlAttr(scoped)}"`);
  }
  const lines = [
    `<acquisition-plan ${openParts.join(" ")}>`,
    ...rows.map(renderFetchRow),
    "</acquisition-plan>",
  ];
  return lines.join("\n");
}

// ── Public entry point ────────────────────────────────────────────────────

/**
 * Build the `<acquisition-plan>` block string for a routine.
 *
 * Pure function: deterministic for a given input. Returns the rendered
 * XML even when no rows survive — an empty plan still gives the
 * pre-pass an explicit "nothing to do" signal rather than the absence
 * of a block.
 */
export function buildAcquisitionPlan(input: BuildAcquisitionPlanInput): string {
  const rows = collectFetchRows(input);
  return renderAcquisitionPlanBlock(input.routine, input.agentDay, rows);
}

// ── Fan-out splitter (docs/design/appendices/pre-pass-fan-out.md §4.1) ────────────────────

/**
 * One integration's slice of an acquisition plan. The fan-out
 * coordinator (Phase 1 / `RoutineFetchWindowRunner.runFanOut`) spawns
 * one Haiku sub-session per slice so each session sees exactly one
 * partial, one schema, one set of MCP tools — the structural fix for
 * the §1.1 cross-integration argument-name confusion.
 *
 * Sub-plans never carry zero `<fetch>` rows — `splitAcquisitionPlanByIntegration`
 * drops integrations whose row-set resolves to empty so the coordinator
 * never spawns a no-op session.
 */
export interface AcquisitionSubPlan {
  integrationKey: IntegrationKey;
  /**
   * Full `<acquisition-plan routine="…" agent_day="…" scoped="<key>">`
   * XML scoped to this integration only.
   */
  block: string;
  /** Always ≥ 1 — see invariant above. Exported for telemetry. */
  fetchRowCount: number;
  /**
   * True iff at least one row in this sub-plan carries an `account=`
   * attribute. Direct-mode multi-account hint — used by the
   * coordinator to size per-attempt budgets or surface multi-account
   * fan-out in dashboard progress envelopes.
   */
  rowsHaveAccount: boolean;
  /**
   * Backend this integration's sub-session MUST spawn on so the
   * partial body's resolved `mode:` block has a working wire surface.
   *
   *  - `native`: equals `state.nativeBackend` (MCP only exists there).
   *  - `userManagedConnector` delegated: equals `state.delegatedBackend`
   *    (no daemon proxy — must use the bound backend's MCP).
   *  - Other modes: equals the input `sessionBackend` (default
   *    fetch_window backend).
   *
   * Consumed by `RoutineFetchWindowRunner.runOneIntegrationWithRetry`,
   * which passes it as `requestedBackendId` to
   * `BackendRouter.resolveBinding`. The router's
   * `requestedBackendId`-only override path (added alongside this
   * field) resolves the canonical model for that backend at the
   * configured tier, preserving `routine.fetch_window`'s
   * `process_backend_config` envelope (maxTurns / maxBudgetUsd).
   *
   * Within an integration's sub-plan every row carries the same
   * `requiredBackend`, so the sub-plan stores one value instead of
   * surfacing per-row variation that does not exist.
   */
  requiredBackend: BackendId;
}

/**
 * Partition a routine's acquisition plan into one sub-plan per active
 * `IntegrationKey`. Pure helper consumed by the fan-out coordinator
 * (Phase 1). Returns:
 *
 *  - An empty array when no integration is active for the routine
 *    (every cell skipped — caller short-circuits to `status="skipped"`).
 *  - One `AcquisitionSubPlan` per integration that contributes ≥ 1 row.
 *
 * **Ordering invariant.** Sub-plans are sorted by `INTEGRATION_KEYS`
 * enumeration order regardless of the order rows appear in
 * `ROUTINE_WINDOWS`. The coordinator's `Promise.all` + `mergeSubReports`
 * pipeline preserves the ordering downstream so daemon logs and test
 * fixtures are stable across runs.
 *
 * **Row preservation.** Each sub-plan's `block` is rendered through the
 * same `renderAcquisitionPlanBlock` helper that backs `buildAcquisitionPlan`,
 * so the union of sub-plan rows equals `buildAcquisitionPlan(input)`'s
 * rows row-for-row (same attribute order, same query substitution, same
 * perAccount fan-out). The only differences are the per-block wrapper's
 * `scoped="<key>"` attribute and the partition itself.
 */
export function splitAcquisitionPlanByIntegration(
  input: BuildAcquisitionPlanInput,
): readonly AcquisitionSubPlan[] {
  return buildAcquisitionPlanAssembly(input).subPlans;
}

/**
 * `splitAcquisitionPlanByIntegration` + the drop trace —
 * PREPASS_COST_REDUCTION_PLAN.md N3. The fan-out runner consumes this
 * variant so every (window × integration) cell dropped at plan-assembly
 * time can be surfaced as a `skipped` audit row instead of vanishing.
 * Same purity / ordering / row-preservation contract as the wrapper
 * above.
 */
export interface AcquisitionPlanAssembly {
  subPlans: readonly AcquisitionSubPlan[];
  drops: readonly AcquisitionPlanDrop[];
}

export function buildAcquisitionPlanAssembly(
  input: BuildAcquisitionPlanInput,
): AcquisitionPlanAssembly {
  const drops: AcquisitionPlanDrop[] = [];
  const rows = collectFetchRows(input, (drop) => drops.push(drop));
  if (rows.length === 0) return { subPlans: [], drops };

  // Group rows by integration while keeping insertion order inside each
  // group (the `ROUTINE_WINDOWS` walk order from `collectFetchRows`).
  const groups = new Map<IntegrationKey, FetchRow[]>();
  for (const row of rows) {
    const existing = groups.get(row.integration);
    if (existing) {
      existing.push(row);
    } else {
      groups.set(row.integration, [row]);
    }
  }

  // Emit sub-plans in `INTEGRATION_KEYS` enumeration order — deterministic
  // resolution order per §4.6.
  const out: AcquisitionSubPlan[] = [];
  for (const key of INTEGRATION_KEYS) {
    const groupRows = groups.get(key);
    if (!groupRows || groupRows.length === 0) continue;
    // Every row in a group shares the same `requiredBackend` (it's a
    // per-integration property derived from the integration's state, not
    // per-row). Take the first row's value — `collectFetchRows` writes
    // the same backend onto every row of an integration.
    const requiredBackend = groupRows[0]!.requiredBackend;
    out.push({
      integrationKey: key,
      block: renderAcquisitionPlanBlock(
        input.routine,
        input.agentDay,
        groupRows,
        key,
      ),
      fetchRowCount: groupRows.length,
      rowsHaveAccount: groupRows.some((r) => r.accountId !== undefined),
      requiredBackend,
    });
  }
  return { subPlans: out, drops };
}
