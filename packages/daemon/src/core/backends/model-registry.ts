/**
 * Compatibility barrel — the canonical model registry moved to
 * `@aitne/shared` (`packages/shared/src/model-registry.ts`) so the dashboard
 * and shared-layer code can consume the single source of truth without
 * importing the daemon (dependency direction is daemon → shared).
 *
 * Existing daemon imports of `./model-registry.js` keep resolving through
 * these re-exports; new code may import the same symbols directly from
 * `@aitne/shared`. There is nothing to edit here on a model bump — update the
 * registry array in the shared module.
 */
export {
  DEFAULT_CLAUDE_LITE_MODEL,
  DEFAULT_CLAUDE_MEDIUM_MODEL,
  DEFAULT_CLAUDE_HIGH_MODEL,
  DEFAULT_CODEX_LITE_MODEL,
  DEFAULT_CODEX_MEDIUM_MODEL,
  DEFAULT_GEMINI_LITE_MODEL,
  DEFAULT_GEMINI_MEDIUM_MODEL,
  DEFAULT_OPENCODE_LITE_MODEL,
  DEFAULT_OPENCODE_MEDIUM_MODEL,
  DEFAULT_OPENCODE_HIGH_MODEL,
  getModelsForBackend,
  findRegisteredModel,
  latestHighFor,
  latestMediumFor,
  latestLiteFor,
  defaultModelForTier,
  estimateCostForUsage,
  estimateTextInputTokens,
  getModelLabel,
} from "@aitne/shared";
