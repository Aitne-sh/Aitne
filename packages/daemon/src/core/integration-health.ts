import type Database from "better-sqlite3";
import {
  INTEGRATION_DESCRIPTORS,
  INTEGRATION_KEYS,
  type BackendId,
  type IntegrationKey,
  type IntegrationMode,
} from "@aitne/shared";
import { readIntegrations } from "../db/integrations-store.js";
import { listProbes, probeKey } from "../db/integration-probe-store.js";
import {
  descriptorDefaultFeaturesMap,
  probeFeaturesMap,
  type ProbeResult,
} from "./integration-probe.js";
import {
  missingDelegatedVariants,
  missingNativeVariants,
} from "./skills-compiler.js";

/**
 * Integration delegation framework — `/health.integrationModes` builder
 * (§4.11 keyed map shape).
 *
 * Sibling field — does NOT replace the existing `/health.integrations`
 * shape (which the dashboard still consumes for service connection
 * health). Phase 5's dashboard rewrite owns the atomic cutover.
 *
 * Per-key payload:
 *   - mode: from the persisted integrations map
 *   - delegatedBackend / toolNamespace / subTier: only populated when
 *     mode === "delegated"
 *   - features: per-capability boolean map. Sources, in priority order:
 *       1. Latest cached probe row for `(key, delegatedBackend ?? null)`
 *       2. Descriptor's `optionalCapabilities` for the active backend
 *          (POC inventory = trust default)
 *       3. null when neither is available (no backend wired up)
 *   - lastProbeAt: ISO timestamp of source 1, or null when sources 2/3
 *     supplied the features map.
 */

export type SubTier = "draft-only" | "full-auto" | null;

export interface IntegrationHealthEntry {
  mode: IntegrationMode;
  delegatedBackend: BackendId | null;
  /**
   * INTEGRATION_NATIVE_MODE_DESIGN.md §9.3 — populated only when
   * `mode === "native"`; null otherwise. Mirrors `delegatedBackend` and
   * is keyed separately so consumers can match on field presence.
   */
  nativeBackend: BackendId | null;
  subTier: SubTier;
  toolNamespace: string | null;
  features: Readonly<Record<string, boolean>> | null;
  lastProbeAt: string | null;
  /**
   * §4.7 / §8.5 "Missing-variant policy" surfacing. Populated when
   * `mode === "delegated"` (lists missing `SKILL.delegated.<backend>.md` /
   * `<key>.delegated.<backend>.md`) OR `mode === "native"` (lists missing
   * `SKILL.native.<backend>.md` / `<key>.native.<backend>.md`). Empty
   * array = all good. `null` for direct/disabled (no variant check
   * applies).
   *
   * The PATCH route already hard-rejects flips into this state, so a
   * non-empty list only appears when (a) an existing delegated/native
   * state predates the required variant files (e.g. after a registry
   * widening that ships ahead of the variant bodies) or (b) someone
   * hand-edited `integrations.md` around the API. Either way, dashboards
   * and Phase 5's wizard can flag it instead of hitting a silent
   * direct-mode fallback.
   */
  variantsMissing: string[] | null;
}

export type IntegrationHealthMap = Readonly<
  Record<IntegrationKey, IntegrationHealthEntry>
>;

/**
 * Sub-tier classification — registry-driven, not hand-maintained per
 * integration. The rule: a connector that ships `send` (gmail) is
 * "full-auto"; one that lacks `send` is "draft-only". Calendar gets
 * `null` because there's no equivalent send/draft split to label.
 */
function classifySubTier(
  integration: IntegrationKey,
  backend: BackendId,
): SubTier {
  if (integration !== "gmail") return null;
  const connector = INTEGRATION_DESCRIPTORS[integration].backendConnectors[
    backend
  ];
  // Forward-compat: every (gmail, backend) pair currently has a connector.
  /* c8 ignore next */
  if (!connector) return null;
  return connector.optionalCapabilities.includes("send")
    ? "full-auto"
    : "draft-only";
}

function buildEntry(
  key: IntegrationKey,
  state: {
    mode: IntegrationMode;
    delegatedBackend?: BackendId | null;
    nativeBackend?: BackendId | null;
  },
  cachedProbes: ReadonlyMap<string, ProbeResult>,
  workspaceDir: string,
): IntegrationHealthEntry {
  if (state.mode === "native") {
    // Zod's superRefine guarantees nativeBackend is set when mode === "native".
    const backend = state.nativeBackend as BackendId;
    const connector = INTEGRATION_DESCRIPTORS[key].backendConnectors[backend];
    const cached = cachedProbes.get(probeKey(key, backend));

    let features: Readonly<Record<string, boolean>> | null = null;
    let lastProbeAt: string | null = null;
    if (cached) {
      features = probeFeaturesMap(cached);
      lastProbeAt = cached.probedAt;
    } else {
      features = descriptorDefaultFeaturesMap(key, backend);
    }

    const missing = missingNativeVariants(workspaceDir, key, backend);
    const variantsMissing: string[] = [...missing.skills, ...missing.taskFlows];

    return {
      mode: "native",
      delegatedBackend: null,
      nativeBackend: backend,
      subTier: classifySubTier(key, backend),
      /* c8 ignore next */
      toolNamespace: connector?.toolNamespace ?? null,
      features,
      lastProbeAt,
      variantsMissing,
    };
  }

  if (state.mode !== "delegated") {
    return {
      mode: state.mode,
      delegatedBackend: null,
      nativeBackend: null,
      subTier: null,
      toolNamespace: null,
      // Direct mode goes through the daemon's first-party SDK code, where
      // the capability surface is whatever the SDK exposes — not a
      // connector contract. Keep `features` null so consumers don't
      // misinterpret it as a delegated-mode feature matrix.
      features: null,
      lastProbeAt: null,
      variantsMissing: null,
    };
  }

  // Zod's superRefine on integrationStateSchema guarantees delegatedBackend
  // is set whenever mode === "delegated". The TS type doesn't narrow
  // (mode is not part of a discriminated union), so we assert here.
  const backend = state.delegatedBackend as BackendId;
  const connector = INTEGRATION_DESCRIPTORS[key].backendConnectors[backend];
  const cached = cachedProbes.get(probeKey(key, backend));

  let features: Readonly<Record<string, boolean>> | null = null;
  let lastProbeAt: string | null = null;
  if (cached) {
    features = probeFeaturesMap(cached);
    lastProbeAt = cached.probedAt;
  } else {
    // Descriptor defaults — POC inventory used until a live probe lands.
    features = descriptorDefaultFeaturesMap(key, backend);
  }

  // §4.7 surfacing — list missing variant files for this delegated
  // (key, backend). The PATCH route pre-commits this check so a
  // freshly-flipped state never lands here non-empty, but pre-existing
  // delegated state or out-of-band integrations.md edits can.
  //
  // DELEGATED-MODE-V2-DESIGN.md §11 (Phase 3) re-activated the legacy
  // variant gate for every delegated integration: gmail and
  // google_calendar now ship `SKILL.delegated.<sessionBackend>.md`
  // (cross-backend) and `null` (same-backend), so missing variants are
  // a real configuration issue rather than the v1 unified-body skip.
  const missing = missingDelegatedVariants(workspaceDir, key, backend);
  const variantsMissing: string[] = [...missing.skills, ...missing.taskFlows];

  return {
    mode: "delegated",
    delegatedBackend: backend,
    nativeBackend: null,
    subTier: classifySubTier(key, backend),
    // Forward-compat: every (key, backend) pair currently has a connector.
    /* c8 ignore next */
    toolNamespace: connector?.toolNamespace ?? null,
    features,
    lastProbeAt,
    variantsMissing,
  };
}

export function buildIntegrationHealthMap(
  db: Database.Database,
  workspaceDir: string,
): IntegrationHealthMap {
  const states = readIntegrations(db);
  const cachedProbes = listProbes(db);
  const out = {} as Record<IntegrationKey, IntegrationHealthEntry>;
  for (const key of INTEGRATION_KEYS) {
    out[key] = buildEntry(key, states[key], cachedProbes, workspaceDir);
  }
  return out;
}
