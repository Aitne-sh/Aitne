import {
  NATIVE_CONNECTOR_BACKEND_IDS,
  RUNTIME_AVAILABLE_BACKEND_IDS,
  type BackendId,
  type IntegrationKey,
} from "@aitne/shared";
import type {
  ConfigResponse,
  IntegrationHealthEntry,
  IntegrationListItem,
  IntegrationSubTier,
} from "@/lib/api-types";

/**
 * Pure derivations for the integration card. Tests live in the `.test.ts`
 * sibling. The card component pulls these + calls the PATCH / probe hooks;
 * nothing here touches React or the network.
 */

// ── Capability humanization ────────────────────────────────────────────────

/**
 * Map internal capability keys (used in `backendConnectors[...].capabilityTools`
 * and `/health.integrationModes.<key>.features`) to end-user labels.
 *
 * Keys come from `packages/shared/src/integrations.ts`. Unknown keys fall back
 * to a Title-Case render of the raw string so a future registry widening does
 * not require a dashboard change to *display* — only to *polish*.
 */
const CAPABILITY_LABELS: Readonly<Record<string, string>> = {
  // Gmail
  search: "Search",
  read: "Read",
  draft: "Drafts",
  update_draft: "Update drafts",
  send: "Send",
  forward: "Forward",
  delete: "Archive / delete",
  label: "Labels",
  create_label: "Create labels",
  read_attachment: "Read attachments",
  batch: "Batch operations",
  // Calendar
  list_events: "List events",
  get_event: "Read event",
  create_event: "Create event",
  update_event: "Update event",
  delete_event: "Delete event",
  respond_to_event: "RSVP",
  respond_event: "RSVP",
  suggest_time: "Suggest time",
  list_calendars: "List calendars",
  get_availability: "Check availability",
  batch_read: "Batch read",
};

export function capabilityLabel(capability: string): string {
  const labeled = CAPABILITY_LABELS[capability];
  if (labeled !== undefined) return labeled;
  return capability
    .split("_")
    .map((s) => (s.length === 0 ? s : s[0].toUpperCase() + s.slice(1)))
    .join(" ");
}

// ── Mode + sub-tier labels ─────────────────────────────────────────────────

export function modeLabel(
  mode: IntegrationHealthEntry["mode"],
  backend: BackendId | null,
): string {
  if (mode === "direct") return "Direct";
  if (mode === "disabled") return "Disabled";
  if (mode === "native") {
    if (backend === null) return "Native";
    return `Native — ${backend}`;
  }
  if (backend === null) return "Delegated";
  return `Delegated — ${backend}`;
}

export function subTierLabel(tier: IntegrationSubTier): string | null {
  if (tier === "draft-only") return "Draft-Only";
  if (tier === "full-auto") return "Full-Auto";
  return null;
}

// ── Feature matrix rendering ───────────────────────────────────────────────

export interface FeatureMatrixRow {
  capability: string;
  label: string;
  present: boolean;
  required: boolean;
}

/**
 * Build a sorted feature matrix for a delegated integration. Order:
 * required-present first, then optional-present, then required-missing,
 * then optional-missing — so the "what works" half of the list is visible
 * without scrolling.
 *
 * When `features` is null (direct mode or no backend wired), returns an
 * empty list; callers render a different view.
 */
export function buildFeatureMatrix(
  features: Readonly<Record<string, boolean>> | null,
  descriptor: IntegrationListItem,
  backend: BackendId | null,
): FeatureMatrixRow[] {
  if (features === null || backend === null) return [];
  const connector = descriptor.backendConnectors[backend];
  if (!connector) return [];

  const required = new Set(connector.requiredCapabilities);
  const seen = new Set<string>();
  const rows: FeatureMatrixRow[] = [];
  for (const cap of [
    ...connector.requiredCapabilities,
    ...connector.optionalCapabilities,
  ]) {
    if (seen.has(cap)) continue;
    seen.add(cap);
    rows.push({
      capability: cap,
      label: capabilityLabel(cap),
      present: features[cap] === true,
      required: required.has(cap),
    });
  }

  return rows.sort((a, b) => {
    // present-and-required > present-optional > missing-required > missing-optional
    const score = (r: FeatureMatrixRow): number => {
      if (r.present && r.required) return 0;
      if (r.present) return 1;
      if (r.required) return 2;
      return 3;
    };
    const delta = score(a) - score(b);
    if (delta !== 0) return delta;
    return a.label.localeCompare(b.label);
  });
}

// ── Backend availability ───────────────────────────────────────────────────

/** Backends the registry says could host a delegated version of this integration. */
export function availableDelegatedBackends(
  descriptor: IntegrationListItem,
): BackendId[] {
  // User-managed connector integrations (e.g. Outlook) ship no
  // descriptor-side connector — the user wires up an MCP on the
  // backend they pick. Offer every runtime-available backend so they
  // can route to whichever one they configured. Sourced from the shared
  // `RUNTIME_AVAILABLE_BACKEND_IDS` so opencode joins automatically when
  // `docs/design/appendices/opencode-backend.md` Phase 2 wires `OpencodeCore` — no
  // dashboard edit needed.
  if (descriptor.userManagedConnector) {
    return [...RUNTIME_AVAILABLE_BACKEND_IDS];
  }
  return Object.keys(descriptor.backendConnectors) as BackendId[];
}

/**
 * INTEGRATION_NATIVE_MODE_DESIGN.md §5.3 / §11.1 — backends that can host
 * `native` mode for this integration. The setup wizard and IntegrationCard
 * hide the Native option entirely when this list does not include the
 * current main backend (the §3.3 invariant: native binds to the main
 * backend).
 *
 * Two paths:
 *
 *   - Descriptor-driven connector (gmail, google_calendar, notion):
 *     return the backends declared in `backendConnectors`. The probe
 *     verifies the connector's `requiredCapabilities` at flip time and
 *     the daemon ships a `SKILL.native.<backend>.md` body for each.
 *
 *   - User-managed connector (outlook_mail, outlook_calendar — and any
 *     future integration with `userManagedConnector: true`): return all
 *     three backends. The user installs their own MCP / skill harness on
 *     the main backend; the daemon trusts that wiring, synthesises a
 *     probe result, and skips the `SKILL.native.<backend>.md` materialise
 *     gate. Matches the long-standing {@link availableDelegatedBackends}
 *     contract — 2026-05 amendment to §5.3.
 */
export function availableNativeBackends(
  descriptor: IntegrationListItem,
): BackendId[] {
  // Native mode is permanently unavailable on opencode (`docs/design/appendices/opencode-backend.md`
  // §11 — opencode is not a native-mode connector host). The shared
  // `NATIVE_CONNECTOR_BACKEND_IDS` constant captures that permanent
  // exclusion; do NOT switch this to `RUNTIME_AVAILABLE_BACKEND_IDS`
  // when opencode lands runtime support in Phase 2.
  if (descriptor.userManagedConnector) return [...NATIVE_CONNECTOR_BACKEND_IDS];
  return Object.keys(descriptor.backendConnectors) as BackendId[];
}

/**
 * §3.3 invariant — true when the integration can be flipped to `native`
 * on the current main backend. Combines three signals:
 *
 *   1. descriptor.supportedModes includes "native"
 *   2. mainBackend ∈ availableNativeBackends(descriptor)
 *   3. mainBackend is known (null = no main backend chosen yet)
 *
 * The setup wizard and IntegrationCard call this before rendering the
 * Native radio; the PATCH route has the same gate as defense-in-depth.
 */
export function canFlipToNative(
  descriptor: IntegrationListItem,
  mainBackend: BackendId | null | undefined,
): boolean {
  if (!descriptor.supportedModes.includes("native")) return false;
  if (!mainBackend) return false;
  return availableNativeBackends(descriptor).includes(mainBackend);
}

/**
 * True when `mode` is allowed for this integration given current connector
 * support. Delegated is allowed iff at least one backend has a connector.
 */
export function modeIsAvailable(
  descriptor: IntegrationListItem,
  mode: IntegrationHealthEntry["mode"],
): boolean {
  if (!descriptor.supportedModes.includes(mode)) return false;
  if (mode !== "delegated") return true;
  return availableDelegatedBackends(descriptor).length > 0;
}

// ── Direct-mode credential presence (per-integration) ─────────────────────

/**
 * Whether the daemon currently holds usable direct-mode credentials for the
 * given integration. The dashboard exposes integration-specific "configured"
 * flags on `/api/config` (Notion has one bit, Google has two), so this can't
 * be a uniform `${name}Configured` lookup — we map the integration key to the
 * concrete flag(s) explicitly. Returns false when config has not loaded yet
 * so the dialog defaults to the "needs setup" branch instead of falsely
 * promising a one-click resume.
 */
export function directCredentialsPresent(
  key: IntegrationKey,
  config: ConfigResponse | undefined,
): boolean {
  if (!config) return false;
  if (key === "gmail" || key === "google_calendar") {
    return (
      config.googleCalendarCredentialsConfigured
      && config.googleCalendarTokenConfigured
    );
  }
  if (key === "notion") {
    return config.notionConfigured;
  }
  if (key === "git" || key === "github") {
    // Direct Git/GitHub mode uses local CLIs (`git`, `gh`) and repo config
    // rather than daemon-managed keychain secrets. Treat direct mode as
    // resumable; runtime CLI/auth errors surface in daemon logs and health.
    return true;
  }
  if (key === "outlook_mail" || key === "outlook_calendar") {
    // SETUP-FLOW-REDESIGN-PLAN §6.1: Outlook auth is the per-account MSAL
    // cache plus the BYOA client config blob. The dashboard's
    // `outlookClientConfigConfigured` flag covers the second; the first is
    // discovered live by the Mail wizard step. For the connections page,
    // treat the integration as resumable when the BYOA config is present —
    // the per-account row's authStatus surfaces in /health, not /config.
    return Boolean(
      (config as ConfigResponse & { outlookClientConfigConfigured?: boolean })
        .outlookClientConfigConfigured,
    );
  }
  return false;
}

// ── Delegated proxy model picker (DELEGATED-PROXY-API-DESIGN.md §7) ───────

/**
 * Per-call token estimate the dashboard uses for the "estimated cost" chip
 * in the model dropdown. Numbers come from §7 of the design doc — a typical
 * search-style proxy call carries ~800 input prompt tokens (the proxy
 * profile + tool args JSON) and ~200 output tokens (the tool-use call
 * itself, since the model is told to return only the raw tool result).
 *
 * These are deliberately conservative; the actual surface depends on the
 * connector tool being called. Surfaced as ranges in the UI tooltip so a
 * power user can read "rough estimate" without digging into the design doc.
 */
export const PROXY_CALL_TOKEN_ESTIMATE = {
  inputTokens: 800,
  outputTokens: 200,
} as const;

/**
 * Compute the estimated USD per call for a given model's per-token rates.
 * Returns `null` when the registry has no pricing data — the dashboard
 * hides the chip in that case rather than rendering "$0.0000" or "$NaN".
 */
export function estimateCostPerCallUsd(
  usdPer1kIn: number | null,
  usdPer1kOut: number | null,
): number | null {
  if (usdPer1kIn === null || usdPer1kOut === null) return null;
  const inputUsd =
    (usdPer1kIn * PROXY_CALL_TOKEN_ESTIMATE.inputTokens) / 1000;
  const outputUsd =
    (usdPer1kOut * PROXY_CALL_TOKEN_ESTIMATE.outputTokens) / 1000;
  return inputUsd + outputUsd;
}

/** Format a USD figure for the per-call cost chip. */
export function formatPerCallUsd(usd: number): string {
  if (usd < 0.001) return "<$0.001";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

/**
 * The dropdown's "Auto" sentinel — picked by default and translated to
 * `delegatedModel: null` on PATCH. Distinct from any registered model id
 * so the controlled select stays in sync without a parallel boolean.
 */
export const PROXY_MODEL_AUTO_VALUE = "__auto__";

// ── Recent proxy calls table (DELEGATED-PROXY-API-DESIGN.md §7) ────────────

/**
 * Format a per-call cost cell. Shorter than `formatPerCallUsd` because the
 * table column is dense — show <$0.001 sentinel for sub-millicent figures
 * (typical for queue-saturation / precondition rows that recorded zero
 * cost), four decimals for sub-cent, three otherwise. `null` (no cost
 * recorded — e.g. unimplemented backends) renders as "—".
 */
export function formatRecentCallCost(usd: number | null): string {
  if (usd === null) return "—";
  if (usd === 0) return "$0";
  if (usd < 0.001) return "<$0.001";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

/**
 * Format a duration cell. ms < 1000 stays in ms; otherwise switch to
 * seconds with one decimal. Keeps the column narrow without sacrificing
 * the order-of-magnitude signal users care about.
 */
export function formatRecentCallDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Format the started_at timestamp for the table. Locale time when the call
 * happened today, locale date+time otherwise. Keeps the today-heavy debug
 * pattern (open the table after a failure) tight while still letting the
 * user spot last-week rows.
 *
 * `now` is injectable for tests so they're not coupled to the host clock.
 */
export function formatRecentCallTimestamp(
  iso: string | null,
  now: Date = new Date(),
): string {
  if (iso === null) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sameDay =
    d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString();
  }
  return d.toLocaleString();
}

/**
 * Compress a fully-qualified tool name into something narrow enough for the
 * table cell. The unsuffixed leaf is the part the user recognises (e.g.
 * `_search_emails`); the namespace prefix is redundant given the row's
 * backend column. Never strip if the result would be empty.
 */
export function shortenRecentCallTool(toolName: string | null): string {
  if (!toolName) return "—";
  // mcp__claude_ai_Gmail__search_threads → search_threads
  // mcp__codex_apps__gmail._search_emails → _search_emails
  const parts = toolName.split("__");
  const tail = parts[parts.length - 1];
  return tail && tail.length > 0 ? tail : toolName;
}

// ── Reconfigure banner gate (§11.5) ────────────────────────────────────────

/**
 * INTEGRATION_NATIVE_MODE_DESIGN.md §11.5 — predicate for showing the
 * "Native binding lost — re-configure" banner on an integration card.
 *
 * The banner exists because §11.4 cascades a native row to `disabled` on
 * main-backend change. We surface that gap until the user has acted on it.
 *
 * Show when ALL of:
 *   1. `dismissedLocally === false` — user hasn't clicked Dismiss this session.
 *   2. A `integration.native_unbound` audit row exists for this key within
 *      the lookup window (`useNativeUnboundActions` defaults to 7 days).
 *   3. Current mode is still `disabled` (a re-bind to native/delegated/direct
 *      changes the mode and the banner is implicitly answered).
 *   4. The integration row has NOT been touched since the cascade. Without
 *      this gate the banner persists even when the user has consciously
 *      re-disabled the row (e.g. "I really don't want Gmail anymore") —
 *      the local-state Dismiss does not survive a page reload, so the only
 *      durable acknowledgement is interacting with the mode.
 *
 * Step 4 compares `state.lastChangedAt` (JS ISO with a `Z` suffix) against
 * the audit row's `startedAt` (SQLite `datetime('now')`, which lacks the
 * `Z`). The string forms are NOT comparable lexicographically — the space-
 * separator in SQLite's format sorts before `T`, so a naive `>` returns
 * the wrong answer. {@link parseTimestamp} routes both formats through
 * `Date.parse` so we end up comparing real epoch milliseconds.
 *
 * Returns false when timestamps are missing or unparseable so the banner
 * still shows for the cascade-just-happened case (the safer default).
 */
export interface ReconfigureBannerInputs {
  mode: IntegrationHealthEntry["mode"];
  /** The most recent `integration.native_unbound` audit row for this key, if any. */
  unboundEntry: { startedAt: string | null } | undefined;
  /** `state.lastChangedAt` from the integration descriptor (JS ISO format). */
  stateLastChangedAt: string;
  /** Local dismiss state (per-session in the card). */
  dismissedLocally: boolean;
}

export function shouldShowReconfigureBanner(
  inputs: ReconfigureBannerInputs,
): boolean {
  const { mode, unboundEntry, stateLastChangedAt, dismissedLocally } = inputs;
  if (dismissedLocally) return false;
  if (unboundEntry === undefined) return false;
  if (mode !== "disabled") return false;
  if (unboundEntry.startedAt === null) return true; // fall-through: show
  const lastTouchedMs = parseTimestamp(stateLastChangedAt);
  const cascadeMs = parseTimestamp(unboundEntry.startedAt);
  if (lastTouchedMs === null || cascadeMs === null) return true;
  // Treat "lastChangedAt strictly after cascade.startedAt" as user
  // acknowledgement. Equal-ms (cascade just landed) keeps the banner up.
  return lastTouchedMs <= cascadeMs;
}

/**
 * Parse either an ISO-8601 string ("2026-05-11T12:34:56.789Z") or a SQLite
 * `datetime('now')` string ("2026-05-11 12:34:56") into epoch milliseconds.
 * Returns null when the input is unparseable so callers can fall back to a
 * conservative default. Mirrors `parseUtcDate` in `lib/utils.ts` but stays
 * in the .logic file so the pure tests do not need a React import path.
 */
function parseTimestamp(value: string): number | null {
  const normalized =
    value.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(value)
      ? value
      : value.replace(" ", "T") + "Z";
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}

// ── Mode switch action classification ──────────────────────────────────────

/**
 * What the card should do when the user picks a new mode. The dialog layer
 * uses this to pick which modal to render; the card uses it to decide whether
 * to pop a modal at all (a no-op flip is swallowed).
 *
 * INTEGRATION_NATIVE_MODE_DESIGN.md §11 — `to-native` is a single kind
 * regardless of the source mode because the dialog body for it (probe
 * results + main-backend confirmation + cost delta) is the same whether
 * the source was direct, delegated, or disabled. The source mode is
 * carried as `fromMode` so the body can still highlight what's being
 * surrendered (e.g. delegated worker cadence stops, direct poller stops).
 */
export type ModeSwitchAction =
  | { kind: "no-op" } // same mode + same backend — swallow
  | { kind: "direct-to-delegated"; toBackend: BackendId }
  | { kind: "delegated-to-direct"; needsOauthSetup: boolean }
  | { kind: "delegated-backend-change"; toBackend: BackendId }
  | { kind: "enable-from-disabled"; to: "direct" | "delegated"; toBackend?: BackendId }
  | { kind: "disable-from-active" }
  | {
      kind: "to-native";
      fromMode: "direct" | "delegated" | "disabled";
      toBackend: BackendId;
    }
  | { kind: "native-to-direct"; needsOauthSetup: boolean }
  | { kind: "native-to-delegated"; toBackend: BackendId }
  | { kind: "native-to-disabled" };

export interface ModeSwitchRequest {
  toMode: IntegrationHealthEntry["mode"];
  toBackend?: BackendId;
}

export interface CurrentStateForSwitch {
  mode: IntegrationHealthEntry["mode"];
  backend: BackendId | null;
  /** True when the daemon keychain has a usable Google OAuth token pair. */
  directCredentialsPresent: boolean;
}

export function classifyModeSwitch(
  current: CurrentStateForSwitch,
  request: ModeSwitchRequest,
): ModeSwitchAction {
  const { mode: fromMode, backend: fromBackend } = current;
  const { toMode, toBackend } = request;

  if (fromMode === toMode) {
    if (fromMode === "delegated" && toBackend && toBackend !== fromBackend) {
      return { kind: "delegated-backend-change", toBackend };
    }
    // Native re-bind is impossible by §3.3 — the only way to change the
    // native backend is to change the main backend. Swallow as no-op.
    return { kind: "no-op" };
  }

  // Native-as-target — single dispatch, regardless of source.
  if (toMode === "native") {
    if (!toBackend) throw new Error("toBackend required for native flip");
    if (fromMode !== "direct" && fromMode !== "delegated" && fromMode !== "disabled") {
      // Defensive: classifyModeSwitch's caller restricts fromMode to one of
      // these four. If a future widening lands a fifth mode, fall through to
      // a generic enable so the dialog still renders something useful rather
      // than crashing.
      /* c8 ignore next */
      return { kind: "to-native", fromMode: "disabled", toBackend };
    }
    return { kind: "to-native", fromMode, toBackend };
  }

  // Native-as-source — explicit transitions so the dialog can name the
  // observability changes (in-turn observations vs. background poller /
  // delegated worker writes).
  if (fromMode === "native") {
    if (toMode === "direct") {
      return {
        kind: "native-to-direct",
        needsOauthSetup: !current.directCredentialsPresent,
      };
    }
    if (toMode === "delegated") {
      if (!toBackend) throw new Error("toBackend required for native→delegated");
      return { kind: "native-to-delegated", toBackend };
    }
    return { kind: "native-to-disabled" };
  }

  if (fromMode === "direct" && toMode === "delegated") {
    if (!toBackend) throw new Error("toBackend required for direct→delegated");
    return { kind: "direct-to-delegated", toBackend };
  }

  if (fromMode === "delegated" && toMode === "direct") {
    return {
      kind: "delegated-to-direct",
      needsOauthSetup: !current.directCredentialsPresent,
    };
  }

  if (fromMode === "disabled") {
    if (toMode === "delegated") {
      if (!toBackend) throw new Error("toBackend required for delegated flip");
      return { kind: "enable-from-disabled", to: "delegated", toBackend };
    }
    return { kind: "enable-from-disabled", to: "direct" };
  }

  // fromMode is direct or delegated; toMode is disabled
  return { kind: "disable-from-active" };
}
