/**
 * Advisor model allowlist — single source of truth for which Claude
 * model IDs the Claude Agent SDK accepts as the `advisor_20260301`
 * server-side tool.
 *
 * The SDK ships its own substring-based allowlist (`zR6` / `w88` in
 * SDK 0.2.98) that currently matches only `*opus-4-6` and
 * `*sonnet-4-6`. Opus 4.7 is the daemon's preferred heavy main model
 * but is silently rejected by the SDK's advisor path — see
 * `docs/advisor.md` §"SDK compatibility" and the auto-memory entry
 * `project_advisor_sdk_constraint`.
 *
 * Three places must agree on this allowlist:
 *   1. `packages/daemon/src/settings/runtime-settings.ts`
 *      — runtime-config zod refine
 *   2. `packages/daemon/src/api/routes/backends.ts`
 *      — `PUT /api/backends/advisor` body schema
 *   3. `packages/dashboard/src/components/settings/backends-and-plans-section.tsx`
 *      — dropdown filter + form fallback default
 *
 * Update them by bumping this list. The first element is the canonical
 * default surfaced when no model has been picked yet (preserved from
 * the prior triple-hardcoded value).
 *
 * Tests intentionally hardcode these IDs as fixtures
 * (`docs/maintenance.md` §"Adding a model" "Pitfalls"). Don't alias
 * test fixtures to this constant — the fixture stability is the point.
 */
export const ADVISOR_ALLOWED_MODELS = [
  "claude-sonnet-4-6",
  "claude-opus-4-6",
] as const;

export type AdvisorModel = (typeof ADVISOR_ALLOWED_MODELS)[number];

/** Default advisor model surfaced in the dashboard when no value is set. */
export const DEFAULT_ADVISOR_MODEL: AdvisorModel = ADVISOR_ALLOWED_MODELS[0];

export function isAdvisorModel(value: unknown): value is AdvisorModel {
  return (
    typeof value === "string"
    && (ADVISOR_ALLOWED_MODELS as readonly string[]).includes(value)
  );
}
