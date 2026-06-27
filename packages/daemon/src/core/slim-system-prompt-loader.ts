/**
 * Single source of truth for the daemon's per-process **slim** system-prompt
 * templates. A slim prompt replaces the verbose `preset: "claude_code"` system
 * prompt (Claude SDK) / the wide profile + skill-index instruction file
 * (Codex / Gemini CLI) with a tight, self-contained operational contract for
 * one short, mechanical, lite-tier process key — shedding ~30 K tokens of
 * built-in tool descriptions, the skills index, the memory-system docs, and
 * tone/style guidance the key never uses.
 *
 * Two cost-reduction efforts share this registry:
 *   - `routine.fetch_window` — docs/design/appendices/fetch-window-cost-reduction.md
 *     Phase 1 / 1.5 (the original slim prompt).
 *   - `routine.research_cluster_update` — RESEARCH_CLUSTER_COST_FIX_PLAN.md F4
 *     (Phase 2): the nightly per-cluster journal-append session.
 *
 * Adding a slim key is a one-line entry in `SLIM_SYSTEM_PROMPT_LOADERS` below
 * (plus the asset file under agent-assets/system-prompts/ and, for CLI parity,
 * the skill set in skills-compiler.ts:`SLIM_CLI_SKILL_SETS`).
 *
 * The same template is consumed by two backend paths so the body stays
 * byte-identical across backends:
 *   - Claude SDK — passed as `query()`'s `systemPrompt` string by
 *     `claude-code-core.ts:buildSystemPrompt`.
 *   - Codex / Gemini CLI — written verbatim as `AGENTS.md` / `GEMINI.md` by
 *     `skills-compiler.ts:materializeSlimCliSession`.
 *
 * Hoisting the loaders out of `claude-code-core.ts` lets the skills compiler
 * import them without a cross-backend dependency, and keeps the disk read +
 * cache amortised across both code paths (one read per template per daemon
 * boot regardless of how many sessions of either backend run).
 *
 * Each template is immutable for the daemon's lifetime, so a single
 * per-template module-level cache is sufficient. The test reset helpers let
 * unit tests simulate a fresh boot without reaching into module internals.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { substituteBrandTokens, type ProcessKey } from "@aitne/shared";

/**
 * Resolve + read a slim-prompt asset by file basename (without the `.md`
 * extension), applying brand-token substitution.
 *
 * Path resolution follows the same shape as `prompts.ts:resolveTaskFlowsDir`:
 * `__dirname` lives at `packages/daemon/src/core/` (or the matching
 * `dist/core/` after build), so the repo's `agent-assets/` directory is four
 * levels up. The cwd fallback only fires in unusual harness layouts.
 *
 * Brand tokens (`{APP_NAME}`) are substituted here so the slim template stays
 * aligned with the wide path's substitution contract: the Claude SDK
 * systemPrompt and the CLI AGENTS.md / GEMINI.md both see the substituted
 * product name instead of a literal `{APP_NAME}` leaking through. APP_NAME is
 * a compile-time constant, so the per-boot cache stays byte-stable.
 */
function readSlimSystemPromptAsset(basename: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "..", "..", "..", "agent-assets", "system-prompts", `${basename}.md`),
    // Defensive fallback — if the module is invoked from an unexpected layout
    // we still find the asset by walking up from cwd. Last-resort only; the
    // relative path above is the canonical resolution.
    join(process.cwd(), "agent-assets", "system-prompts", `${basename}.md`),
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      return substituteBrandTokens(readFileSync(path, "utf-8"));
    }
  }
  throw new Error(
    `slim system prompt "${basename}" not found. Looked in: ${candidates.join(", ")}`,
  );
}

// Per-template module-level caches. Each template is byte-stable per boot, so
// a single cached string is sufficient; the reset helper drops them for tests.
let cachedFetchWindowSystemPrompt: string | null = null;
let cachedResearchClusterUpdateSystemPrompt: string | null = null;

/**
 * Load the slim `routine.fetch_window` system-prompt template, caching the
 * result for the daemon's lifetime.
 */
export function loadFetchWindowSystemPrompt(): string {
  if (cachedFetchWindowSystemPrompt !== null) return cachedFetchWindowSystemPrompt;
  cachedFetchWindowSystemPrompt = readSlimSystemPromptAsset("routine-fetch-window");
  return cachedFetchWindowSystemPrompt;
}

/**
 * Load the slim `routine.research_cluster_update` system-prompt template
 * (RESEARCH_CLUSTER_COST_FIX_PLAN.md F4), caching for the daemon's lifetime.
 */
export function loadResearchClusterUpdateSystemPrompt(): string {
  if (cachedResearchClusterUpdateSystemPrompt !== null) {
    return cachedResearchClusterUpdateSystemPrompt;
  }
  cachedResearchClusterUpdateSystemPrompt = readSlimSystemPromptAsset(
    "routine-research-cluster-update",
  );
  return cachedResearchClusterUpdateSystemPrompt;
}

/**
 * Registry of process keys whose session uses a slim system prompt instead of
 * the wide preset / profile. Typed as `Partial<Record<ProcessKey, …>>` (not an
 * inferred string-literal map) so a rename in `@aitne/shared/process-key.ts`
 * lights up here rather than silently dead-branching every consumer.
 *
 * Both call sites (Claude SDK `buildSystemPrompt`, CLI `materializeSlimCliSession`)
 * resolve membership through `loadSlimSystemPrompt` / `isSlimSystemPromptKey`,
 * so adding a key here is the single edit that wires both backends.
 */
export const SLIM_SYSTEM_PROMPT_LOADERS: Partial<Record<ProcessKey, () => string>> = {
  "routine.fetch_window": loadFetchWindowSystemPrompt,
  "routine.research_cluster_update": loadResearchClusterUpdateSystemPrompt,
};

/** True when `processKey` has a slim system-prompt template registered. */
export function isSlimSystemPromptKey(processKey: ProcessKey | undefined): boolean {
  return processKey !== undefined && processKey in SLIM_SYSTEM_PROMPT_LOADERS;
}

/**
 * Load the slim system-prompt body for `processKey`, or `null` when the key
 * has no slim template (callers fall through to the wide preset / profile).
 * The disk read is amortised by the per-template cache.
 */
export function loadSlimSystemPrompt(processKey: ProcessKey | undefined): string | null {
  if (processKey === undefined) return null;
  const loader = SLIM_SYSTEM_PROMPT_LOADERS[processKey];
  return loader ? loader() : null;
}

/**
 * Test-only — drop every cached slim prompt so a subsequent load re-reads from
 * disk. Production never needs this; the templates are immutable per boot.
 */
export function resetSlimSystemPromptsForTest(): void {
  cachedFetchWindowSystemPrompt = null;
  cachedResearchClusterUpdateSystemPrompt = null;
}

/**
 * Back-compat alias retained so the existing fetch_window tests / call sites
 * keep working after the Phase 2 generalization. Resets every slim cache (a
 * superset of the prior fetch_window-only reset — harmless for tests). Prefer
 * `resetSlimSystemPromptsForTest` in new code.
 */
export function resetFetchWindowSystemPromptForTest(): void {
  resetSlimSystemPromptsForTest();
}
