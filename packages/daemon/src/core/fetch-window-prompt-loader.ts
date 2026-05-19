/**
 * docs/design/appendices/fetch-window-cost-reduction.md Phase 1 / Phase 1.5 — single
 * source of truth for the `routine.fetch_window` slim system prompt.
 *
 * The same `agent-assets/system-prompts/routine-fetch-window.md` template
 * is consumed by two backend paths:
 *   - Claude SDK — passed as `query()`'s `systemPrompt` string by
 *     `claude-code-core.ts:buildSystemPrompt` (Phase 1).
 *   - Codex / Gemini CLI — written verbatim as `AGENTS.md` / `GEMINI.md`
 *     by `skills-compiler.ts:materializeFetchWindowCliSession` (Phase 1.5).
 *
 * Hoisting the loader out of `claude-code-core.ts` lets the skills
 * compiler import it without a cross-backend dependency, and keeps the
 * disk read + cache amortized across both code paths (one read per
 * daemon boot regardless of how many sessions of either backend run).
 *
 * The template is immutable for the daemon's lifetime, so a single
 * module-level cache is sufficient. The test reset helper is exported
 * via `_testInternals` so unit tests can simulate a fresh boot without
 * reaching into module internals.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { substituteBrandTokens } from "@aitne/shared";

let cachedFetchWindowSystemPrompt: string | null = null;

/**
 * Load the slim `routine.fetch_window` system-prompt template from disk,
 * caching the result for the daemon's lifetime.
 *
 * Path resolution follows the same shape as `prompts.ts:resolveTaskFlowsDir`:
 * `__dirname` lives at `packages/daemon/src/core/` (or the matching
 * `dist/core/` after build), so the repo's `agent-assets/` directory is
 * four levels up. The cwd fallback only fires in unusual harness layouts.
 *
 * Brand tokens (`{APP_NAME}`) are substituted at load time so the slim
 * template stays aligned with the wide path's substitution contract.
 * Today the template uses no brand tokens — substitution is a no-op —
 * but applying it here keeps the loader honest the moment a future edit
 * introduces `{APP_NAME}`: the Claude SDK systemPrompt and the CLI
 * AGENTS.md / GEMINI.md both see the substituted product name instead
 * of a literal "{APP_NAME}" leaking through. APP_NAME is a compile-time
 * constant so the per-boot cache is still byte-stable.
 */
export function loadFetchWindowSystemPrompt(): string {
  if (cachedFetchWindowSystemPrompt !== null) return cachedFetchWindowSystemPrompt;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "..", "..", "..", "agent-assets", "system-prompts", "routine-fetch-window.md"),
    // Defensive fallback — if the module is invoked from an unexpected
    // layout we still find the asset by walking up from cwd. Last-resort
    // only; the relative path above is the canonical resolution.
    join(process.cwd(), "agent-assets", "system-prompts", "routine-fetch-window.md"),
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      cachedFetchWindowSystemPrompt = substituteBrandTokens(readFileSync(path, "utf-8"));
      return cachedFetchWindowSystemPrompt;
    }
  }
  throw new Error(
    `routine.fetch_window system prompt not found. Looked in: ${candidates.join(", ")}`,
  );
}

/**
 * Test-only — drop the cached prompt so a subsequent call re-reads from
 * disk. Production never needs this; the prompt is immutable per daemon
 * boot.
 */
export function resetFetchWindowSystemPromptForTest(): void {
  cachedFetchWindowSystemPrompt = null;
}
