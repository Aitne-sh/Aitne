import {
  INTEGRATION_DESCRIPTORS,
  type BackendId,
  type IntegrationBackendConnector,
  type IntegrationDescriptor,
  type IntegrationKey,
} from "@aitne/shared";

/**
 * Integration delegation framework — connector probe evaluator (§4.12.2).
 *
 * Pure function over (live tool list, integration descriptor, target backend).
 * Returns which capabilities are present, which required ones are missing,
 * and a `present` boolean callers use to gate the §4.12.2 commit step.
 *
 * The evaluator does NOT launch agent subprocesses. The caller is expected
 * to gather the live MCP tool name list via whatever channel suits — the
 * agent SDK's tool-listing API, the §7 POC scripts, or a stub for unit
 * tests. This split keeps the cost-bearing piece (subprocess) out of the
 * boot path: §4.11 startup uses cached results from the
 * `integration_probes` DB table; only the explicit
 * `POST /api/integrations/:key/probe` endpoint and post-mode-change flips
 * trigger a fresh subprocess.
 */

export interface ProbeInput {
  /** Live MCP tool names visible to the agent — full namespaced strings. */
  tools: readonly string[];
  /** Integration whose connector we are probing. */
  integration: IntegrationKey;
  /** Backend whose connector to consult. */
  backend: BackendId;
  /** Optional ISO timestamp of the probe. Defaults to `new Date().toISOString()`. */
  probedAt?: string;
}

export interface ProbeCapabilityResult {
  /** Capability name from `requiredCapabilities ∪ optionalCapabilities`. */
  capability: string;
  /** True iff at least one tool listed under `capabilityTools[capability]` was found. */
  present: boolean;
  /** The matching tool names that satisfied the capability (for diagnostics). */
  matchedTools: readonly string[];
  /** True when the capability is in `requiredCapabilities`. */
  required: boolean;
}

export interface ProbeResult {
  integration: IntegrationKey;
  backend: BackendId;
  /**
   * Full namespaced tool names this connector exposed at probe time. Useful
   * for the dashboard to render "we found 21 tools" without re-deriving.
   */
  presentTools: readonly string[];
  /** Per-capability presence map for `requiredCapabilities ∪ optionalCapabilities`. */
  capabilities: readonly ProbeCapabilityResult[];
  /** Names of required capabilities with no matching tool. */
  missingRequired: readonly string[];
  /**
   * True iff every `requiredCapabilities` entry was satisfied. The §4.12.2
   * commit gate fails when this is false.
   */
  present: boolean;
  /** ISO-8601 timestamp the probe was taken. */
  probedAt: string;
}

/**
 * Look up the connector for `(integration, backend)`. Returns null when the
 * descriptor doesn't list this backend — the caller surfaces "this backend
 * isn't a connector option" rather than synthesizing an empty probe.
 */
export function getConnector(
  integration: IntegrationKey,
  backend: BackendId,
): IntegrationBackendConnector | null {
  const descriptor: IntegrationDescriptor = INTEGRATION_DESCRIPTORS[integration];
  // The `?? null` fallback is forward-compat: every (integration, backend)
  // pair currently has a connector. See the matching note on `evaluateProbe`.
  /* c8 ignore next */
  return descriptor.backendConnectors[backend] ?? null;
}

/**
 * Match a list of `capabilityTools` (relative names) against the live `tools`
 * list. A capability is present when at least one of its relative tool names
 * concatenates with `toolNamespace` to a name found in `tools`.
 */
function matchCapability(
  toolNamespace: string,
  toolNames: readonly string[],
  liveTools: ReadonlySet<string>,
): readonly string[] {
  const matched: string[] = [];
  for (const tool of toolNames) {
    const fullName = toolNamespace + tool;
    if (liveTools.has(fullName)) matched.push(fullName);
  }
  return matched;
}

/**
 * Build a synthetic probe result for a user-managed connector
 * integration (e.g. Outlook). The daemon ships no descriptor-side tool
 * inventory for these — the user installs an MCP / connector on the
 * agent backend they pick, and the daemon trusts that wiring. The
 * result has no capability rows (so the §4.12.2 commit gate is
 * satisfied trivially and the dashboard renders the user-managed
 * branch instead of a feature matrix), but `presentTools` carries the
 * live tool list when one was passed — useful for diagnostics ("we saw
 * N tools on your backend"). Callers without a live tool list (cached
 * synthesis, /health default) pass an empty array.
 */
export function makeUserManagedProbeResult(
  integration: IntegrationKey,
  backend: BackendId,
  tools: readonly string[],
  probedAt?: string,
): ProbeResult {
  return {
    integration,
    backend,
    presentTools: [...tools],
    capabilities: [],
    missingRequired: [],
    present: true,
    probedAt: probedAt ?? new Date().toISOString(),
  };
}

/**
 * Pure evaluation. Returns a {@link ProbeResult} that callers persist via
 * `writeProbe` (when this is a live probe) or pass directly to the /health
 * snapshot builder (when the caller has a fresh result in hand).
 */
export function evaluateProbe(input: ProbeInput): ProbeResult {
  const descriptor = INTEGRATION_DESCRIPTORS[input.integration];

  // User-managed connector integrations (e.g. Outlook) — see
  // {@link makeUserManagedProbeResult}. Defense-in-depth: every caller
  // that goes through the route handler is already routed via the
  // helper, but evaluators reached from observers (e.g. the periodic
  // DelegatedProbeObserver) land here and the synthetic shape is the
  // right answer for them too.
  if (descriptor.userManagedConnector) {
    return makeUserManagedProbeResult(
      input.integration,
      input.backend,
      input.tools,
      input.probedAt,
    );
  }

  const connector = getConnector(input.integration, input.backend);
  // Forward-compat: today every (integrationKey, BackendId) pair has a
  // connector descriptor, so this branch is unreachable through the live
  // registry. Reserved for a future integration that lands without all
  // three backends. Surfaced via thrown so callers don't silently mask a
  // misconfigured integration.
  /* c8 ignore next 5 */
  if (!connector) {
    throw new Error(
      `No connector for ${input.integration} on backend ${input.backend}`,
    );
  }

  const probedAt = input.probedAt ?? new Date().toISOString();

  // Restrict the live tool list to ones in this connector's namespace so
  // the evaluator's `presentTools` field doesn't drag in unrelated tools.
  const namespacedTools = input.tools.filter((t) =>
    t.startsWith(connector.toolNamespace),
  );
  const liveSet = new Set(namespacedTools);

  // Union required + optional, dedup. Required entries keep their `required`
  // flag so consumers can render the feature matrix without re-checking.
  const requiredSet = new Set(connector.requiredCapabilities);
  const allCapabilities = new Set([
    ...connector.requiredCapabilities,
    ...connector.optionalCapabilities,
  ]);

  const capabilities: ProbeCapabilityResult[] = [];
  for (const capability of allCapabilities) {
    // Connectors must list every required+optional capability in
    // capabilityTools — see the registry self-consistency test in
    // integration-probe.test.ts. A missing entry is a registry bug.
    const tools = connector.capabilityTools[capability];
    const matched = matchCapability(connector.toolNamespace, tools, liveSet);
    capabilities.push({
      capability,
      present: matched.length > 0,
      matchedTools: matched,
      required: requiredSet.has(capability),
    });
  }

  const missingRequired = capabilities
    .filter((c) => c.required && !c.present)
    .map((c) => c.capability);

  return {
    integration: input.integration,
    backend: input.backend,
    presentTools: namespacedTools,
    capabilities,
    missingRequired,
    present: missingRequired.length === 0,
    probedAt,
  };
}

/**
 * Shrink a probe result to the `{cap: boolean}` shape the §4.11 health
 * endpoint exposes. Optional capabilities, required capabilities, both flow
 * through identically — the consumer (dashboard / setup wizard) decides
 * how to render the gap.
 */
export function probeFeaturesMap(
  result: ProbeResult,
): Readonly<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const cap of result.capabilities) {
    out[cap.capability] = cap.present;
  }
  return out;
}

/**
 * Synthesize a "trust-the-POC" features map from the descriptor's
 * `optionalCapabilities` when no probe row exists yet. Every listed
 * capability defaults to `true` because the POC inventory IS the probe
 * result for the shipped registry. Used by /health to degrade gracefully
 * before the user has run a live probe.
 */
export function descriptorDefaultFeaturesMap(
  integration: IntegrationKey,
  backend: BackendId,
): Readonly<Record<string, boolean>> | null {
  const connector = getConnector(integration, backend);
  // Forward-compat: same case as `evaluateProbe`'s null guard — every
  // (integration, backend) pair currently has a connector.
  /* c8 ignore next */
  if (!connector) return null;
  const out: Record<string, boolean> = {};
  for (const cap of connector.optionalCapabilities) {
    out[cap] = true;
  }
  for (const cap of connector.requiredCapabilities) {
    out[cap] = true;
  }
  return out;
}
