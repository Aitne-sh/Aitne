import { getBackendIds, type BackendId, type ExecutionPermissionMode } from "@aitne/shared";

/**
 * Execution mode step — pure state + payload logic.
 *
 * Design: `EXECUTION-MODE-DESIGN.md` §5.1.
 *
 * The user-visible labels are `Safe` / `Allow`; the daemon already stores
 * these as `strict` / `allow` in `<backend>ExecutionPermissionMode`.
 * The UI layer uses `ExecutionModeUi` everywhere so the copy and form state
 * stay consistent with the card labels, and this module owns the single
 * translation point into the internal `ExecutionPermissionMode` alphabet.
 */

export type ExecutionModeUi = "safe" | "allow";

export const EXECUTION_MODE_UI_VALUES = ["safe", "allow"] as const;

/**
 * Per-backend override as stored in form state. `null` means "follow the
 * top-level choice" — the accordion is collapsed-by-default and unchanged
 * rows should not silently diverge from the top-level pick.
 */
export type PerBackendOverrides = Partial<Record<BackendId, ExecutionModeUi | null>>;

export const EMPTY_OVERRIDES: PerBackendOverrides = {
  claude: null,
  codex: null,
  gemini: null,
  opencode: null,
};

export function uiToInternal(mode: ExecutionModeUi): ExecutionPermissionMode {
  return mode === "safe" ? "strict" : "allow";
}

export function internalToUi(mode: ExecutionPermissionMode): ExecutionModeUi {
  return mode === "strict" ? "safe" : "allow";
}

/**
 * API payload for `POST /api/setup/mode`. Per-backend overrides are only
 * emitted when they diverge from the top-level pick, so the shape stays
 * minimal for the common case.
 */
export interface SetupModePayload {
  mode: ExecutionModeUi;
  perBackend?: Partial<Record<BackendId, ExecutionModeUi>>;
}

/**
 * Build the `/setup/mode` payload from the current form state. Two paths:
 *
 * 1. `topLevel` non-null — standard case. Overrides that equal the top are
 *    filtered out; only divergent rows are emitted.
 * 2. `topLevel === null` — settings-page divergent-seed case (every backend
 *    had a different persisted mode, so there is no unified top to show).
 *    Caller must supply a fully-specified override set; a synthetic top is
 *    chosen as the majority mode across the backend rows, and the minority
 *    rows are emitted as overrides. This keeps the API shape unchanged —
 *    `mode` is still required by the endpoint — while letting the user
 *    commit an arbitrary per-backend configuration without first clicking
 *    one of the cards.
 *
 * Returns `null` when the state is incomplete (no top pick and at least
 * one override is null). Caller uses that to gate the Apply button.
 */
export function buildSetupModePayload(
  topLevel: ExecutionModeUi | null,
  overrides: PerBackendOverrides,
): SetupModePayload | null {
  if (topLevel === null) {
    if (
      getBackendIds().some((backend) => overrides[backend] == null)
    ) {
      return null;
    }
    const synthetic = majorityMode(overrides);
    const perBackend: Partial<Record<BackendId, ExecutionModeUi>> = {};
    for (const backend of getBackendIds()) {
      const value = overrides[backend];
      // The null guard above narrows `value` at runtime, but TS doesn't
      // track the per-index narrowing through the const-backends loop.
      if (value !== null && value !== synthetic) perBackend[backend] = value;
    }
    const payload: SetupModePayload = { mode: synthetic };
    if (Object.keys(perBackend).length > 0) payload.perBackend = perBackend;
    return payload;
  }

  const perBackend: Partial<Record<BackendId, ExecutionModeUi>> = {};
  for (const backend of getBackendIds()) {
    const override = overrides[backend];
    if (override != null && override !== topLevel) {
      perBackend[backend] = override;
    }
  }
  const payload: SetupModePayload = { mode: topLevel };
  if (Object.keys(perBackend).length > 0) {
    payload.perBackend = perBackend;
  }
  return payload;
}

/** True when the current form state is ready to POST. */
export function canApply(
  topLevel: ExecutionModeUi | null,
  overrides: PerBackendOverrides,
): boolean {
  return buildSetupModePayload(topLevel, overrides) !== null;
}

/**
 * Majority mode across non-null overrides. Ties resolve to the first-occurring
 * mode in backend order. Used for the divergent-apply synthetic top.
 */
function majorityMode(
  overrides: PerBackendOverrides,
): ExecutionModeUi {
  let safe = 0;
  let allow = 0;
  for (const b of getBackendIds()) {
    if (overrides[b] === "safe") safe++;
    else if (overrides[b] === "allow") allow++;
  }
  if (safe > allow) return "safe";
  if (allow > safe) return "allow";
  // Tie — pick the first non-null in backend order.
  for (const b of getBackendIds()) {
    if (overrides[b] !== null) return overrides[b] as ExecutionModeUi;
  }
  return "safe";
}

/**
 * Resolve what mode a backend will effectively run in given the current
 * form state. Used by the advanced accordion to echo the actual mode a
 * row will be written with — including when "follow top-level" is active.
 */
export function resolveEffectiveMode(
  backend: BackendId,
  topLevel: ExecutionModeUi,
  overrides: PerBackendOverrides,
): ExecutionModeUi {
  return overrides[backend] ?? topLevel;
}

/**
 * True when at least one per-backend row diverges from the top-level pick.
 * Drives the accordion's "mixed" indicator so the user can tell at a glance
 * whether the collapsed accordion hides a non-trivial configuration.
 */
export function hasDivergentOverride(
  topLevel: ExecutionModeUi,
  overrides: PerBackendOverrides,
): boolean {
  return getBackendIds().some((b) => {
    const override = overrides[b];
    return override != null && override !== topLevel;
  });
}
