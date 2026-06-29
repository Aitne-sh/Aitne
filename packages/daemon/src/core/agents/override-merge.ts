import type { AgentDefinition, AgentTier, BackendId } from "@aitne/shared";
import { AGENT_TIERS, BACKEND_IDS, OVERRIDE_EDIT_PATHS } from "@aitne/shared";

/**
 * Built-in override merge (AGENT_DEFINITIONS_DESIGN.md §6.4.1).
 *
 * Built-in Agents ship inside `@aitne-sh/aitne`, so their YAML at
 * `agent-assets/agents/<slug>/agent.md` is overwritten on every `npm i -g`.
 * Operator edits to a built-in therefore must NOT be written back to disk —
 * they live in `agents.metadata_json.override_snapshot` (a flat dot-path →
 * value map) and are re-applied on top of the shipped definition every boot.
 *
 * This module is the pure reducer that composes the effective definition:
 *
 *     effective = (shippedYaml ?? registryFallback)  then  override snapshot
 *
 * Override wins. Only the allow-listed fields are mergeable; any other key in
 * the snapshot is dropped (the API validates on write, this re-validates on
 * read — defence-in-depth). The merge is total and never throws: an
 * out-of-contract value for an allow-listed path is dropped, leaving the base
 * value, so a corrupt snapshot can never produce an invalid definition or
 * crash boot.
 *
 * Pure + dependency-free (beyond the shared schema) so it stays in the
 * 100%-coverage set and is reused by the loader (§6) and the `/api/agents`
 * PATCH handler (§9.5).
 */

/**
 * The ONLY fields a built-in override snapshot may carry (§6.4.1). The API's
 * PATCH handler restricts writes to these; `mergeAgentDefinition` applies only
 * these. Flat dot-path keys so a reset (`PATCH { reset: ["limits.max_budget_usd"] }`)
 * is a single `delete snapshot[path]`.
 *
 * `enabled_overridden_at` is part of the canonical allow-list because it
 * travels with an `enabled` override (§6.4.1 step 4: an empty snapshot clears
 * it), but it is a metadata timestamp, NOT an `AgentDefinition` field — the
 * merge recognises it as allow-listed and applies nothing to the definition
 * (no target). The loader resolves the real enabled-state from the
 * `agents.enabled_overridden_at` column via the §6.4 timestamp comparison.
 */
// Derived from the shared `OVERRIDE_EDIT_PATHS` single source of truth so the
// loader/merge allow-list can never drift from the API PATCH allow-list. The
// two `enabled*` keys are merge-only (column-authority, no definition target —
// see the doc above) and prepend the shared field-edit paths.
export const MERGEABLE_OVERRIDE_PATHS = [
  "enabled",
  "enabled_overridden_at",
  ...OVERRIDE_EDIT_PATHS,
] as const;

export type MergeableOverridePath = (typeof MERGEABLE_OVERRIDE_PATHS)[number];

// ── Per-path value guards (defence-in-depth; mirror agentDefinitionSchema) ──

function isAgentTier(value: unknown): value is AgentTier {
  return typeof value === "string" && (AGENT_TIERS as readonly string[]).includes(value);
}

function isBackendIdValue(value: unknown): value is BackendId {
  return typeof value === "string" && (BACKEND_IDS as readonly string[]).includes(value);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Apply a single allow-listed override path to a (mutable, already-cloned)
 * definition. Each branch type-guards the value against the same contract
 * `agentDefinitionSchema` enforces; a value that fails its guard is dropped so
 * the base value survives. `enabled_overridden_at` has no definition target
 * and is a deliberate no-op.
 */
function applyOverridePath(
  def: AgentDefinition,
  path: MergeableOverridePath,
  value: unknown,
): void {
  switch (path) {
    case "enabled":
      if (typeof value === "boolean") def.enabled = value;
      break;
    case "enabled_overridden_at":
      // Metadata sidecar — no AgentDefinition target (see MERGEABLE_OVERRIDE_PATHS).
      break;
    case "backend.tier":
      if (value === null || isAgentTier(value)) def.backend.tier = value;
      break;
    case "backend.model":
      // `null` defers to process_backend_config; a non-empty string pins a
      // model. An empty string is neither (matches the schema's `.min(1)`).
      if (value === null || (typeof value === "string" && value.length > 0)) {
        def.backend.model = value;
      }
      break;
    case "backend.backend_id":
      if (value === null || isBackendIdValue(value)) {
        def.backend.backend_id = value;
      }
      break;
    case "limits.max_turns":
      if (isPositiveInt(value)) def.limits.max_turns = value;
      break;
    case "limits.max_budget_usd":
      if (isNonNegativeFinite(value)) def.limits.max_budget_usd = value;
      break;
    case "limits.timeout_minutes":
      if (isPositiveInt(value)) def.limits.timeout_minutes = value;
      break;
    case "on_error.notify_owner":
      if (typeof value === "boolean") def.on_error.notify_owner = value;
      break;
  }
}

/**
 * Compose the effective Agent definition from the shipped YAML (or the
 * registry fallback when no YAML is present) plus the operator's override
 * snapshot (§6.4.1).
 *
 * @param shippedYaml      parsed `agent.md` frontmatter, or `null` when the
 *                         built-in has no YAML on disk yet.
 * @param registryFallback synthesised-from-registry definition; the base used
 *                         when `shippedYaml` is `null`.
 * @param overrideSnapshot flat dot-path → value map from
 *                         `metadata_json.override_snapshot`; non-allow-listed
 *                         keys are ignored.
 * @returns a fresh, valid `AgentDefinition` — inputs are never mutated.
 */
export function mergeAgentDefinition(
  shippedYaml: AgentDefinition | null,
  registryFallback: AgentDefinition,
  overrideSnapshot: Record<string, unknown>,
): AgentDefinition {
  const base = structuredClone(shippedYaml ?? registryFallback);
  // Iterate the allow-list (not the snapshot) so non-allow-listed snapshot
  // keys are inherently ignored — they are never read.
  for (const path of MERGEABLE_OVERRIDE_PATHS) {
    if (Object.prototype.hasOwnProperty.call(overrideSnapshot, path)) {
      applyOverridePath(base, path, overrideSnapshot[path]);
    }
  }
  return base;
}
