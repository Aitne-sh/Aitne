import type { AgentDefinition, AgentTier, OverrideEditPath } from "@aitne/shared";
import { AGENT_TIERS } from "@aitne/shared";

/**
 * Pure logic for the restricted built-in editor (§10.4). A built-in Agent's
 * YAML is shipped read-only; the operator may override only a small allow-list
 * of fields, which the daemon stores in `override_snapshot` and the
 * `PATCH /api/agents/:slug` planner validates (`OVERRIDE_EDIT_PATHS` in
 * `views.ts`). This module mirrors that allow-list so the form surfaces exactly
 * the editable fields and produces a valid JSON-diff PATCH body. Tested
 * directly; the form component is a dumb renderer over it.
 */

/**
 * Dot-paths a built-in operator may override. Aliased to the shared
 * `OverrideEditPath` single source of truth (imported by the daemon
 * override-merge + PATCH planner too), so the form's field set can never drift
 * from what the API accepts. The `BUILTIN_OVERRIDE_FIELDS` order below is pinned
 * against `OVERRIDE_EDIT_PATHS` in the test.
 */
export type OverrideFieldKey = OverrideEditPath;

export type OverrideFieldValue = string | number | boolean | null;

export type OverrideValues = Record<OverrideFieldKey, OverrideFieldValue>;

export type OverrideFieldKind = "tier" | "model" | "int" | "number" | "boolean";

export interface OverrideFieldSpec {
  key: OverrideFieldKey;
  label: string;
  kind: OverrideFieldKind;
  help: string;
}

/** Field metadata in display order. The single source for the form layout. */
export const BUILTIN_OVERRIDE_FIELDS: readonly OverrideFieldSpec[] = [
  {
    key: "backend.tier",
    label: "Tier",
    kind: "tier",
    help: "Model tier override. Default routes via process_backend_config.",
  },
  {
    key: "backend.model",
    label: "Model",
    kind: "model",
    help: "Pin a specific model id, or leave blank to use the tier default.",
  },
  {
    key: "limits.max_turns",
    label: "Max turns",
    kind: "int",
    help: "Maximum agent turns per execution.",
  },
  {
    key: "limits.max_budget_usd",
    label: "Max budget (USD)",
    kind: "number",
    help: "Per-execution soft cost cap (advisory in v1).",
  },
  {
    key: "limits.timeout_minutes",
    label: "Timeout (minutes)",
    kind: "int",
    help: "Per-execution wall-clock timeout.",
  },
  {
    key: "on_error.notify_owner",
    label: "Notify owner on error",
    kind: "boolean",
    help: "DM the owner when an execution errors.",
  },
] as const;

export const AGENT_TIER_OPTIONS: readonly AgentTier[] = AGENT_TIERS;

function isAgentTier(v: unknown): v is AgentTier {
  return typeof v === "string" && (AGENT_TIERS as readonly string[]).includes(v);
}

/** Read the current effective value of each editable field from a definition. */
export function extractOverrideValues(def: AgentDefinition): OverrideValues {
  return {
    "backend.tier": def.backend.tier,
    "backend.model": def.backend.model,
    "limits.max_turns": def.limits.max_turns,
    "limits.max_budget_usd": def.limits.max_budget_usd,
    "limits.timeout_minutes": def.limits.timeout_minutes,
    "on_error.notify_owner": def.on_error.notify_owner,
  };
}

/** Per-field validation mirroring the daemon `isValidOverrideValue`. */
export function validateOverrideValue(
  key: OverrideFieldKey,
  value: OverrideFieldValue,
): string | null {
  switch (key) {
    case "backend.tier":
      return value === null || isAgentTier(value) ? null : "Invalid tier";
    case "backend.model":
      return value === null || (typeof value === "string" && value.length > 0)
        ? null
        : "Model must be a non-empty string or blank";
    case "limits.max_turns":
    case "limits.timeout_minutes":
      return typeof value === "number" && Number.isInteger(value) && value > 0
        ? null
        : "Must be a positive whole number";
    case "limits.max_budget_usd":
      return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? null
        : "Must be zero or a positive number";
    case "on_error.notify_owner":
      return typeof value === "boolean" ? null : "Must be true or false";
  }
}

/** Validate the whole edited set. Returns a map of field → error (only errors). */
export function validateOverrideValues(
  edited: OverrideValues,
): Partial<Record<OverrideFieldKey, string>> {
  const errors: Partial<Record<OverrideFieldKey, string>> = {};
  for (const { key } of BUILTIN_OVERRIDE_FIELDS) {
    const err = validateOverrideValue(key, edited[key]);
    if (err) errors[key] = err;
  }
  return errors;
}

const PARENT_OF: Record<OverrideFieldKey, "backend" | "limits" | "on_error"> = {
  "backend.tier": "backend",
  "backend.model": "backend",
  "limits.max_turns": "limits",
  "limits.max_budget_usd": "limits",
  "limits.timeout_minutes": "limits",
  "on_error.notify_owner": "on_error",
};

function leafOf(key: OverrideFieldKey): string {
  return key.slice(key.indexOf(".") + 1);
}

export interface BuiltinPatchResult {
  /** PATCH body with only the changed fields nested under their parent. */
  body: Record<string, Record<string, OverrideFieldValue>>;
  changedKeys: OverrideFieldKey[];
}

/**
 * Build the `PATCH /api/agents/:slug` body for a built-in override save: a
 * nested object carrying ONLY the fields whose value changed from `original`.
 * An unchanged field is omitted (no-op PATCH for it). Reset-to-default is a
 * separate explicit action — see `buildOverrideResetBody`.
 */
export function buildBuiltinPatchBody(
  original: OverrideValues,
  edited: OverrideValues,
): BuiltinPatchResult {
  const body: Record<string, Record<string, OverrideFieldValue>> = {};
  const changedKeys: OverrideFieldKey[] = [];
  for (const { key } of BUILTIN_OVERRIDE_FIELDS) {
    if (Object.is(original[key], edited[key])) continue;
    changedKeys.push(key);
    const parent = PARENT_OF[key];
    (body[parent] ??= {})[leafOf(key)] = edited[key];
  }
  return { body, changedKeys };
}

/** PATCH body that clears one override field back to the shipped default. */
export function buildOverrideResetBody(
  keys: readonly OverrideFieldKey[],
): { reset: OverrideFieldKey[] } {
  return { reset: [...keys] };
}

/** Which fields currently carry an override (present in the snapshot). */
export function overriddenFieldKeys(
  snapshot: Record<string, unknown> | null | undefined,
): OverrideFieldKey[] {
  if (!snapshot) return [];
  return BUILTIN_OVERRIDE_FIELDS.map((f) => f.key).filter((key) =>
    Object.prototype.hasOwnProperty.call(snapshot, key),
  );
}
