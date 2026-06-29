// ── Agent-consumable error envelope ──────────────────────────────────────────
//
// Public barrel for the agent-error helpers. Every route file under
// `packages/daemon/src/api/routes/**` imports from `../helpers/agent-errors.js`;
// keeping that import path stable across the split is the whole point of this
// re-export shim. Internal layout (types / registry / envelope / zod) is an
// implementation detail — see FILE_SPLIT_PLAN_AGENT_ERRORS.md for the rationale
// behind the four-file decomposition.
//
// Symbols intentionally NOT re-exported here are folder-private and have no
// external consumers: `AgentErrorRegistryEntry` (only registry.ts builds
// entries), plus internal helpers `computeRetryable`, `resolveLegacyAlias`,
// `extractRowIndex`, `inferReceivedFromIssue`, `isMissingFieldIssue`,
// `PLACEHOLDER_HINT_PREFIX`, `MISSING_SENTINEL`.

export type {
  AgentErrorConstraint,
  AgentErrorEnvelope,
  AgentErrorIssue,
  AgentErrorSeverity,
} from "./agent-errors-types.js";

export { AGENT_ERROR_REGISTRY } from "./agent-errors-registry.js";

export {
  buildEnvelope,
  composeIssue,
  composeWarning,
  respondWithAgentError,
} from "./agent-errors-envelope.js";

export {
  formatZodPath,
  translateZodError,
  translateZodIssue,
  type ZodTranslationContext,
} from "./agent-errors-zod.js";
