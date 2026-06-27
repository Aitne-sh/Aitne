import type { BackendId, ProcessModelTier } from "@aitne/shared";
import { AGENT_TIERS, BACKEND_IDS } from "@aitne/shared";

import { findRegisteredModel } from "../backends/model-registry.js";

/**
 * Built-in Agent runtime route override (AGENT_DEFINITIONS_DESIGN.md §6.4.1,
 * runtime wiring).
 *
 * A built-in Agent's Definition-tab edits land in
 * `agents.metadata_json.override_snapshot`. Until this module existed they
 * were display-only — routing stayed governed entirely by
 * `process_backend_config`. `BackendRouter.resolveBinding` now calls
 * `extractAgentRouteOverride` on the snapshot of the firing's resolved Agent
 * (`event.data.agentId`, stamped by `Dispatcher.beginAgentExecution`) and
 * layers the result UNDER any caller-explicit options:
 *
 *     caller-explicit (chat picker, run-now hint, schedule row)
 *       > agent override (this module)
 *         > process_backend_config / process-key defaults
 *
 * Pure + dependency-light so it stays in the 100%-coverage set; the router
 * supplies the snapshot it read from the `agents` row.
 */

export interface AgentRouteOverride {
  /** Tier override, applied as a `requestedTier` default. */
  tier: ProcessModelTier | null;
  /** Model pin; when set, `backendId` names the owning backend. */
  modelId: string | null;
  /** Owning backend for `modelId` (stored, or inferred from the registry). */
  backendId: BackendId | null;
  /** Per-execution turn cap, applied onto the resolved binding. */
  maxTurns: number | null;
  /** Per-execution budget cap, applied onto the resolved binding. */
  maxBudgetUsd: number | null;
}

function isTier(value: unknown): value is ProcessModelTier {
  return typeof value === "string" && (AGENT_TIERS as readonly string[]).includes(value);
}

function isBackendId(value: unknown): value is BackendId {
  return typeof value === "string" && (BACKEND_IDS as readonly string[]).includes(value);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Find the backend that owns `modelId` in the static model registry. Needed
 * for override snapshots written before `backend.backend_id` existed (the
 * model field was a free-text input then). Returns `null` for an id no
 * registered backend knows — the model pin is dropped in that case rather
 * than guessed, because executing a model id on the wrong backend fails the
 * whole firing.
 */
export function inferBackendForModel(modelId: string): BackendId | null {
  for (const backendId of BACKEND_IDS) {
    if (findRegisteredModel(backendId, modelId)) return backendId;
  }
  return null;
}

/**
 * Extract the routing-relevant overrides from a built-in's
 * `override_snapshot`. Returns `null` when the snapshot carries nothing that
 * affects routing (so the router can skip the merge entirely). Values are
 * re-guarded with the same contracts `override-merge.ts` enforces —
 * defence-in-depth against a hand-edited snapshot; an out-of-contract value
 * is dropped, never thrown on.
 *
 * A model pin without a resolvable backend (no stored `backend.backend_id`,
 * no registry match) drops the pin but keeps the tier/limit overrides.
 */
export function extractAgentRouteOverride(
  snapshot: unknown,
): AgentRouteOverride | null {
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
    return null;
  }
  const snap = snapshot as Record<string, unknown>;

  const tier = isTier(snap["backend.tier"]) ? (snap["backend.tier"] as ProcessModelTier) : null;

  const rawModel = snap["backend.model"];
  let modelId =
    typeof rawModel === "string" && rawModel.length > 0 ? rawModel : null;
  let backendId: BackendId | null = null;
  if (modelId !== null) {
    const rawBackend = snap["backend.backend_id"];
    backendId = isBackendId(rawBackend) ? rawBackend : inferBackendForModel(modelId);
    if (backendId === null) modelId = null;
  }

  const maxTurns = isPositiveInt(snap["limits.max_turns"])
    ? (snap["limits.max_turns"] as number)
    : null;
  const maxBudgetUsd = isNonNegativeFinite(snap["limits.max_budget_usd"])
    ? (snap["limits.max_budget_usd"] as number)
    : null;

  if (
    tier === null
    && modelId === null
    && maxTurns === null
    && maxBudgetUsd === null
  ) {
    return null;
  }
  return { tier, modelId, backendId, maxTurns, maxBudgetUsd };
}
