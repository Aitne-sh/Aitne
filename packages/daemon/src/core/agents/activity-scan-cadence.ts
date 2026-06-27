/**
 * Activity-scan cadence resolution (AGENTS_HUB_REDESIGN_PLAN.md §2).
 *
 * The activity-scan Agent's firing window (interval + active hours) and its
 * observation-threshold gate live on the **agent row** —
 * `agents.metadata_json.runtime_window`, written by `PATCH /api/agents/
 * activity-scan` (`schedule_window` body block) and preserved across loader
 * re-runs / `npm i -g` by `loader.ts:nextMetadata`. The `activityScan*`
 * config keys (`hourlyCheck*` before the v0.1.11 rename) are deprecated but
 * still parsed; they act as the per-field fallback so a value an operator
 * persisted pre-redesign keeps working until they touch the agent-level
 * setting.
 *
 * Resolution order, per field: `runtime_window` override → legacy config key
 * (which itself carries the shipped default). Pure module — callers fetch the
 * stored override via `agents-store.ts:getRuntimeWindow` and supply the live
 * config; this keeps the precedence logic in the 100%-coverage set.
 */

/** Field bounds, shared by the PATCH validator and the sanitizer. */
export const RUNTIME_WINDOW_BOUNDS = {
  interval_minutes: { min: 5, max: 1440 },
  active_start_hour: { min: 0, max: 23 },
  active_end_hour: { min: 1, max: 24 },
  min_observations: { min: 0, max: 1000 },
} as const;

export type RuntimeWindowField = keyof typeof RUNTIME_WINDOW_BOUNDS;

export const RUNTIME_WINDOW_FIELDS = Object.keys(
  RUNTIME_WINDOW_BOUNDS,
) as readonly RuntimeWindowField[];

/**
 * The persisted shape under `metadata_json.runtime_window`. Every field is
 * optional — only operator-touched fields are stored, so an untouched field
 * keeps tracking the config fallback.
 */
export interface RuntimeWindowOverride {
  interval_minutes?: number;
  active_start_hour?: number;
  active_end_hour?: number;
  min_observations?: number;
}

/**
 * The legacy config keys the resolver falls back to. Fields are optional at
 * the type level so partially-stubbed test configs (and any pre-schema boot
 * edge) resolve to the shipped defaults instead of producing a `NaN` cron.
 */
export interface ActivityScanCadenceConfig {
  activityScanIntervalMinutes?: number;
  activityScanActiveStartHour?: number;
  activityScanActiveEndHour?: number;
  activityScanMinObservations?: number;
}

/** Shipped defaults — mirror `runtime-settings.ts` (`activityScan*` keys). */
export const ACTIVITY_SCAN_CADENCE_DEFAULTS = {
  intervalMinutes: 120,
  activeStartHour: 4,
  activeEndHour: 24,
  minObservations: 1,
} as const;

/** Fully-resolved cadence every consumer (scheduler, gate, API) reads. */
export interface ResolvedActivityScanCadence {
  intervalMinutes: number;
  activeStartHour: number;
  activeEndHour: number;
  minObservations: number;
}

/** True when `value` is an integer within the field's bounds. */
export function isValidRuntimeWindowValue(
  field: RuntimeWindowField,
  value: unknown,
): value is number {
  if (typeof value !== "number" || !Number.isInteger(value)) return false;
  const { min, max } = RUNTIME_WINDOW_BOUNDS[field];
  return value >= min && value <= max;
}

/**
 * Sanitize a raw `metadata_json.runtime_window` blob (untrusted: hand-edited
 * DBs, older daemons). Out-of-bounds / non-integer fields are dropped — the
 * resolver then falls back to config for them rather than failing the boot.
 */
export function parseRuntimeWindowOverride(value: unknown): RuntimeWindowOverride {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const out: RuntimeWindowOverride = {};
  for (const field of RUNTIME_WINDOW_FIELDS) {
    const v = raw[field];
    if (isValidRuntimeWindowValue(field, v)) out[field] = v;
  }
  return out;
}

/**
 * Resolve the effective cadence: per-field `runtime_window` override, else the
 * legacy config key. A start ≥ end pairing (possible when an override touches
 * only one side of an old config window) is repaired by widening the end to
 * `start + 1` so `buildActivityScanCronExpr` always receives a non-empty window.
 */
/** Pick `v` when it is a finite number, else `fallback`. */
function num(v: number | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function resolveActivityScanCadence(
  override: RuntimeWindowOverride | undefined,
  config: ActivityScanCadenceConfig,
): ResolvedActivityScanCadence {
  const o = override ?? {};
  const activeStartHour =
    o.active_start_hour
    ?? num(config.activityScanActiveStartHour, ACTIVITY_SCAN_CADENCE_DEFAULTS.activeStartHour);
  let activeEndHour =
    o.active_end_hour
    ?? num(config.activityScanActiveEndHour, ACTIVITY_SCAN_CADENCE_DEFAULTS.activeEndHour);
  if (activeEndHour <= activeStartHour) activeEndHour = Math.min(activeStartHour + 1, 24);
  return {
    intervalMinutes:
      o.interval_minutes
      ?? num(config.activityScanIntervalMinutes, ACTIVITY_SCAN_CADENCE_DEFAULTS.intervalMinutes),
    activeStartHour,
    activeEndHour,
    minObservations:
      o.min_observations
      ?? num(config.activityScanMinObservations, ACTIVITY_SCAN_CADENCE_DEFAULTS.minObservations),
  };
}

export type RuntimeWindowMergeResult =
  | { ok: true; value: RuntimeWindowOverride; cadenceChanged: boolean }
  | { ok: false; field: string; error: "invalid_field_value" | "invalid_window" };

/**
 * Merge a PATCH `schedule_window` block onto the stored override. Per-field
 * type/bounds are validated; the cross-field window check (`end > start`) runs
 * against the post-merge **resolved** values so a partial patch can't sneak an
 * empty window past per-field validation. `null` resets a field back to the
 * config fallback. `cadenceChanged` tells the route whether a cron rebuild
 * (`reloadCrons`) is needed — `min_observations` is a fire-time gate and never
 * requires one.
 */
export function mergeRuntimeWindow(
  current: RuntimeWindowOverride,
  patch: Record<string, unknown>,
  config: ActivityScanCadenceConfig,
): RuntimeWindowMergeResult {
  const next: RuntimeWindowOverride = { ...current };
  let cadenceChanged = false;
  for (const [key, value] of Object.entries(patch)) {
    if (!(RUNTIME_WINDOW_FIELDS as readonly string[]).includes(key)) {
      return { ok: false, field: `schedule_window.${key}`, error: "invalid_field_value" };
    }
    const field = key as RuntimeWindowField;
    if (value === null) {
      if (next[field] !== undefined) {
        delete next[field];
        if (field !== "min_observations") cadenceChanged = true;
      }
      continue;
    }
    if (!isValidRuntimeWindowValue(field, value)) {
      return { ok: false, field: `schedule_window.${field}`, error: "invalid_field_value" };
    }
    if (next[field] !== value) {
      next[field] = value;
      if (field !== "min_observations") cadenceChanged = true;
    }
  }
  const requestedEnd =
    next.active_end_hour
    ?? num(config.activityScanActiveEndHour, ACTIVITY_SCAN_CADENCE_DEFAULTS.activeEndHour);
  const requestedStart =
    next.active_start_hour
    ?? num(config.activityScanActiveStartHour, ACTIVITY_SCAN_CADENCE_DEFAULTS.activeStartHour);
  if (requestedEnd <= requestedStart) {
    return { ok: false, field: "schedule_window.active_end_hour", error: "invalid_window" };
  }
  return { ok: true, value: next, cadenceChanged };
}
