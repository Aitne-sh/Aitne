/**
 * Task flow loader — reads event-type templates from agent-assets/task-flows/*.md.
 *
 * These define WHAT the agent should do and in what order.
 * HOW to do it (API calls, behavioral rules) lives in agent-assets/skills/.
 *
 * Flows are injected as part of the user message by the dispatcher.
 * The {context} placeholder is replaced with the ContextBuilder output.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyIntegrationModeFilter,
  isCustomRoutineKey,
  selectTaskFlowVariantSuffix,
  substituteBrandTokens,
  type BackendId,
  type IntegrationKey,
  type IntegrationState,
} from "@aitne/shared";
import {
  appendPolicyBlocks,
  createPromptInjectionBudget,
} from "./policy-files.js";
import { appendReviewContextBlocks } from "./review-context.js";
import { substituteIntegrationRoutingTables } from "./management-md.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let taskFlowsDir: string | null = null;
let userTaskFlowsDir: string | null = null;
const flowCache = new Map<string, string>();

/**
 * Initialize the task-flow loader.
 *
 * `workspaceDir` resolves the bundled directory at
 * `<workspaceDir>/agent-assets/task-flows/`. `dataDir` (P5) resolves the
 * user-override directory at `<dataDir>/task-flows/` — when present, the
 * loader checks the override directory before falling back to the bundled
 * one for the SAME filename (`<eventType>.md` or
 * `<eventType>.<variant-suffix>.md`). This mirrors the bundled directory
 * layout exactly so users can override either the base flow or a specific
 * backend/delegated variant by dropping a file with the matching name.
 *
 * Subsequent calls update the directories (useful for tests). `dataDir`
 * is optional so legacy callers that haven't been threaded through
 * `config.dataDir` keep working — those callers see no override layer
 * and fall straight through to the bundled directory.
 */
export function initTaskFlows(workspaceDir: string, dataDir?: string): void {
  taskFlowsDir = join(workspaceDir, "agent-assets", "task-flows");
  userTaskFlowsDir = dataDir ? join(dataDir, "task-flows") : null;
  flowCache.clear();
}

/**
 * Test-only: clear the loader state so a fresh `initTaskFlows` call
 * starts from defaults. Production callers should not need this.
 */
export function resetTaskFlowsForTest(): void {
  taskFlowsDir = null;
  userTaskFlowsDir = null;
  flowCache.clear();
}

function resolveTaskFlowsDir(): string {
  if (taskFlowsDir) return taskFlowsDir;
  // Fallback: resolve from this file's location (4 levels up from packages/daemon/src/core/)
  // Works in both source (vitest) and compiled (dist/core/) layouts.
  const fallback = join(__dirname, "..", "..", "..", "..", "agent-assets", "task-flows");
  if (existsSync(fallback)) {
    taskFlowsDir = fallback;
    return fallback;
  }
  throw new Error(
    "Task flows directory not found. Call initTaskFlows(workspaceDir) at startup.",
  );
}

/**
 * Resolve the user override directory. Returns null when `initTaskFlows`
 * was called without a `dataDir` (legacy paths) — the rest of the loader
 * treats null as "no override layer present".
 */
export function getUserTaskFlowsDir(): string | null {
  return userTaskFlowsDir;
}

/**
 * Resolve a task-flow file by exact filename. Mirrors the bundled-vs-user
 * lookup contract: user dir wins, bundled is the fallback. Used by both
 * `loadFlow` (for `<key>.md`) and `loadFlowVariant` (for
 * `<key>.<suffix>.md`) so the override semantics stay consistent.
 *
 * User-side reads are intentionally uncached — the user can hot-edit
 * their override file from the dashboard or directly on disk, and a
 * stale cache would silently shadow their changes. File I/O on a single
 * MD file is microseconds; the savings aren't worth the correctness
 * risk. Bundled files are immutable once shipped, so the cache key
 * suffix `:bundled:<filename>` keeps the existing speedup.
 */
function readFlowFile(filename: string): string | null {
  const cacheKey = `:bundled:${filename}`;
  if (userTaskFlowsDir) {
    const userPath = join(userTaskFlowsDir, filename);
    if (existsSync(userPath)) {
      try {
        return substituteBrandTokens(readFileSync(userPath, "utf-8"));
      } catch {
        // Fall through to the bundled file — a corrupt user override
        // shouldn't take down the dispatcher. The dashboard validates
        // user input on PUT so this only fires on out-of-band damage.
      }
    }
  }

  const cached = flowCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const dir = resolveTaskFlowsDir();
  const bundledPath = join(dir, filename);
  if (!existsSync(bundledPath)) return null;

  const content = substituteBrandTokens(readFileSync(bundledPath, "utf-8"));
  flowCache.set(cacheKey, content);
  return content;
}

function loadFlow(eventType: string): string | null {
  return readFlowFile(`${eventType}.md`);
}

/**
 * Load a task-flow variant for a specific backend + integration state.
 * Tries `<eventType>.<suffix>.md` first (e.g. `routine.morning_routine.delegated.claude.md`),
 * falling back to `<eventType>.md` when the variant file doesn't exist.
 * Variant selection runs through the same user-override layer as
 * `loadFlow` so users can override either layer independently — drop
 * `git.push.detected.delegated.claude.md` in `<dataDir>/task-flows/`
 * to retarget only the cross-backend Claude variant.
 */
function loadFlowVariant(
  eventType: string,
  backendId: BackendId,
  integrations: Partial<Record<IntegrationKey, IntegrationState>>,
): string | null {
  const suffix = selectTaskFlowVariantSuffix(eventType, backendId, integrations);

  if (suffix !== "direct") {
    const variant = readFlowFile(`${eventType}.${suffix}.md`);
    if (variant !== null) return expandTaskFlowPartials(variant, eventType);
  }

  // Fall back to the canonical file (covers direct mode and missing variants)
  return loadFlow(eventType);
}

/**
 * INTEGRATION_NATIVE_MODE_DESIGN.md §8.2 — a task-flow variant may
 * include the canonical base flow via the `{{> base }}` directive,
 * mirroring `renderPartialIncludes` for skills in `skills-compiler.ts`.
 * The directive is replaced with the body of `<eventType>.md` with the
 * leading `{context}\n\n` block stripped — the variant carries its own
 * `{context}` at the top, and duplicating the token would double the
 * context-builder output once `resolveTemplate` fills both occurrences.
 *
 * Missing / empty base flow → directive collapses to the empty string
 * (mirrors `renderPartialIncludes`'s missing-base behaviour). Pure
 * function on the file content; no caching beyond the loader's existing
 * `flowCache`.
 */
function expandTaskFlowPartials(content: string, eventType: string): string {
  if (!content.includes("{{> base }}")) return content;
  // Resolve against the BUNDLED base file only — the user-override
  // resolution layer is one-way (variants may override; partial includes
  // pin to canonical assets so a malformed override doesn't cascade into
  // every variant that includes it). Matches the skill partial
  // resolver's "read from src verbatim" stance in `skills-compiler.ts`.
  const dir = resolveTaskFlowsDir();
  const basePath = join(dir, `${eventType}.md`);
  if (!existsSync(basePath)) return content.replaceAll("{{> base }}", "");
  const baseRaw = substituteBrandTokens(readFileSync(basePath, "utf-8"));
  // Strip the leading `{context}\n\n` (or `{context}\n` for unix-style
  // files that omit the second newline) so the merged body has exactly
  // one context block at the very top — the one the variant author put
  // there. Anchored at start with `^` so a `{context}` token appearing
  // mid-flow (none today, but defensive) is preserved.
  const baseStripped = baseRaw.replace(/^\{context\}\n\n?/, "");
  return content.replaceAll("{{> base }}", baseStripped);
}

/**
 * docs/design/appendices/routine-data-acquisition.md Phase 1 / F0 — resolve
 * `{include:_partials/<name>.md}` directives in a task-flow body by
 * inlining the verbatim contents of `agent-assets/task-flows/_partials/
 * <name>.md`. Runs BEFORE `applyIntegrationModeFilter` so any
 * `<!-- mode:...:... -->` blocks the partial carries are filtered
 * normally for the current integration state.
 *
 * Behaviour:
 *  - Partials live at `agent-assets/task-flows/_partials/`. The
 *    user-override layer (`<dataDir>/task-flows/_partials/`) wins per
 *    file, matching `readFlowFile`'s contract.
 *  - The leading YAML frontmatter block (`---\n…\n---\n`) is stripped
 *    so authors may carry editorial metadata in partials without it
 *    leaking into the prompt body.
 *  - **Depth cap = 1.** Includes inside an included partial are NOT
 *    expanded — the include directive there is left visible so a
 *    runaway recursion shows up as a verbatim `{include:...}` token in
 *    the rendered prompt rather than silently looping. Tests / authors
 *    can grep for the directive to detect cycles.
 *  - Missing partials collapse to the empty string, matching
 *    `{{> base }}`'s missing-base behaviour. The lint pass (R2/F8)
 *    catches references to non-existent partials at test time.
 *  - Filename safety: `<name>` is constrained to
 *    `[A-Za-z0-9][A-Za-z0-9._-]*` — no slashes, no `..` — so an attacker
 *    or buggy authoring tool cannot path-traverse out of `_partials/`.
 *    Directives with invalid names are left verbatim, which means the
 *    raw token shows up in the prompt (visible failure) rather than
 *    silently disappearing.
 */
const PARTIAL_INCLUDE_RE =
  /\{include:_partials\/([A-Za-z0-9][A-Za-z0-9._-]*\.md)\}/g;
const FRONTMATTER_STRIP_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

function readPartialFile(name: string): string | null {
  // User-override layer first (mirrors readFlowFile). The file lives at
  // `<dataDir>/task-flows/_partials/<name>` — same nesting as the
  // bundled layout so an author can override one partial without
  // disturbing the rest.
  if (userTaskFlowsDir) {
    const userPath = join(userTaskFlowsDir, "_partials", name);
    if (existsSync(userPath)) {
      try {
        return substituteBrandTokens(readFileSync(userPath, "utf-8"));
      } catch {
        // Corrupt override falls through to the bundled file.
      }
    }
  }
  const bundledPath = join(resolveTaskFlowsDir(), "_partials", name);
  if (!existsSync(bundledPath)) return null;
  return substituteBrandTokens(readFileSync(bundledPath, "utf-8"));
}

export function expandPartialIncludes(content: string): string {
  if (!content.includes("{include:_partials/")) return content;
  return content.replace(PARTIAL_INCLUDE_RE, (_match, filename: string) => {
    const raw = readPartialFile(filename);
    if (raw === null) return "";
    // Strip leading frontmatter block, then trim a single trailing
    // newline so the substitution doesn't accumulate blank-line drift
    // across multiple sibling includes.
    return raw.replace(FRONTMATTER_STRIP_RE, "").replace(/\n+$/, "\n");
  });
}

/**
 * docs/design/appendices/pre-pass-fan-out.md §4.2 Path (a) — load a single
 * `_partials/<name>.md` body for runner-side substitution into the
 * `{integration_partial}` placeholder of `routine.fetch_window.md`.
 * Reuses the same lookup as `expandPartialIncludes` (user-override →
 * bundled, brand-token substitution, frontmatter strip, single-newline
 * tail) so authoring conventions stay consistent across the two
 * consumers.
 *
 * The runner passes a per-integration slice of the integrations
 * snapshot so the partial's `<!-- mode:...:... -->` blocks collapse to
 * the single branch that applies to this sub-session's
 * `(integration, mode)` cell. Filtering happens here, not after
 * substitution, because the surrounding `routine.fetch_window.md` body
 * has already been through `applyIntegrationModeFilter` via the
 * standard `getTaskFlow` path — running the filter again on the merged
 * string would be a no-op for the host body but could mis-fire if a
 * partial used `<!-- mode:... -->` markers for an integration other
 * than its own (the partials lint forbids that, but the defence keeps
 * the runner robust to future authoring drift).
 *
 * Missing partials collapse to the empty string (mirroring
 * `expandPartialIncludes`'s missing-partial behaviour); the
 * `routine-partials.test.ts` lint catches references to non-existent
 * partials at test time so this never fires in a healthy build.
 *
 * Filename safety: same `[A-Za-z0-9][A-Za-z0-9._-]*` constraint as the
 * include directive — a malformed name returns the empty string
 * instead of path-traversing out of `_partials/`.
 */
const PARTIAL_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

export function renderPartialForFanOut(
  filename: string,
  integrations: Partial<Record<IntegrationKey, IntegrationState>>,
  backendId: BackendId,
): string {
  if (!PARTIAL_FILENAME_RE.test(filename)) return "";
  const raw = readPartialFile(filename);
  if (raw === null) return "";
  const stripped = raw.replace(FRONTMATTER_STRIP_RE, "").replace(/\n+$/, "\n");
  return applyIntegrationModeFilter(stripped, integrations, backendId);
}

/**
 * Get the task flow template for a given event type.
 *
 * Fallback chain:
 *   1. Integration variant (`<eventType>.delegated.<backend>.md`) when any
 *      touched integration is delegated and the variant file exists
 *   2. Event-specific template (`<eventType>.md`)
 *   3. Custom routine generic template (`routine.custom.md`) — only when
 *      `eventType` is of the form `routine.custom.<slug>` (B-007 §5.8 Q3)
 *   4. Default template (`default.md`)
 *
 * After resolution, the template runs through `applyIntegrationModeFilter`
 * so `<!-- mode:<predicate>:<key> -->` blocks inside any flow file (base
 * or variant) collapse to the right branch for the current integration
 * state. Integration-state-aware filtering is the surgical alternative to
 * authoring whole-file variants when the only delta is a few endpoint
 * references — see DELEGATED-MODE-V2-DESIGN.md §4.7.1.
 */
export function getTaskFlow(
  eventType: string,
  backendId?: string,
  integrations?: Partial<Record<IntegrationKey, IntegrationState>>,
): string {
  const raw = resolveTaskFlowSource(eventType, backendId, integrations);
  if (!raw) return raw;
  // docs/design/appendices/routine-data-acquisition.md F0 — expand
  // `{include:_partials/<name>.md}` directives BEFORE mode filtering so
  // the partial's `<!-- mode:... -->` blocks participate in the same
  // filter pass as the host body. Depth cap = 1; nested includes inside
  // a partial are left verbatim (visible failure on cycles).
  let rendered = expandPartialIncludes(raw);
  // Mode-conditional sections are stripped only when we know the session
  // backend (from `backendId`). Tooling that doesn't carry one (legacy
  // tests, prompt previews) keeps the markers visible — better than
  // collapsing them with a placeholder backend that may misroute prose.
  if (backendId && integrations) {
    rendered = applyIntegrationModeFilter(rendered, integrations, backendId as BackendId);
  }
  // INTEGRATION_NATIVE_MODE_DESIGN.md §6.5.2 / §7.3 — substitute the
  // `<integration-routing-table>` and `<integration-routing-table-actionable>`
  // placeholders the native variants and (Phase C onwards) the direct/
  // delegated variants embed. Runs AFTER mode-conditional filtering so
  // a placeholder inside a struck branch is dropped before substitution.
  // Pure no-op when neither placeholder is present, so legacy task-flow
  // files that pre-date the placeholder syntax are unaffected.
  if (integrations) {
    rendered = substituteIntegrationRoutingTables(rendered, integrations);
  }
  return rendered;
}

function resolveTaskFlowSource(
  eventType: string,
  backendId: string | undefined,
  integrations:
    | Partial<Record<IntegrationKey, IntegrationState>>
    | undefined,
): string {
  if (backendId && integrations) {
    const variant = loadFlowVariant(eventType, backendId as BackendId, integrations);
    if (variant !== null) return variant;
  }

  const direct = loadFlow(eventType);
  if (direct !== null) return direct;
  if (isCustomRoutineKey(eventType)) {
    const custom = loadFlow("routine.custom");
    if (custom !== null) return custom;
  }
  return loadFlow("default") ?? "";
}

/**
 * Assemble the final prompt by loading the task-flow template and
 * appending the configured set of vault policy blocks + review-context
 * (B-007 §5.8, B-004 Phase 1). The production dispatcher has its own
 * assembly path that threads runtime settings through; this module-level
 * helper exists for tests and tooling that need a self-contained prompt
 * builder. Caller must pass explicit B-004 flags — there is no runtime
 * settings reader here.
 */
export function assemblePrompt(
  eventType: string,
  opts: {
    backendId?: string;
    processKey?: string;
    contextDir?: string;
    flags?: Record<string, unknown>;
    reviewContextFlags?: {
      useReviewDossiers: boolean;
      useContextIndex: boolean;
    };
    integrations?: Partial<Record<IntegrationKey, IntegrationState>>;
  } = {},
): string {
  const base = getTaskFlow(eventType, opts.backendId, opts.integrations);
  if (!opts.contextDir) return base;
  const budget = createPromptInjectionBudget();
  const withPolicies = appendPolicyBlocks(base, {
    contextDir: opts.contextDir,
    processKey: opts.processKey ?? eventType,
    flags: opts.flags,
    budget,
  });
  const reviewFlags = opts.reviewContextFlags ?? {
    useReviewDossiers: false,
    useContextIndex: false,
  };
  return appendReviewContextBlocks(withPolicies, {
    contextDir: opts.contextDir,
    processKey: opts.processKey ?? eventType,
    flags: reviewFlags,
    budget,
  });
}

/**
 * Enumerate every known task-flow file across the bundled and user
 * directories. Used by the dashboard's per-event override editor (P5
 * `/connections/git`) to populate the dropdown of available keys with a
 * per-row "user-overridden" badge.
 *
 * Each entry surfaces the filename minus the `.md` suffix as `key` so
 * variant filenames (`git.push.detected.delegated.claude.md`) appear as
 * distinct rows the user can override independently. The base flow lives
 * alongside its variants in the same listing — there is no implicit
 * grouping, and the UI is responsible for any visual hierarchy.
 *
 * `hasOverride: true` means a same-named file exists in
 * `<dataDir>/task-flows/`; the bundled file may or may not also exist
 * (a user-only key — supported, just unusual).
 */
export interface TaskFlowListEntry {
  key: string;
  hasBundled: boolean;
  hasOverride: boolean;
}

export function listTaskFlows(): TaskFlowListEntry[] {
  const bundled = listMdFilesByKey(resolveTaskFlowsDir());
  const overrides = userTaskFlowsDir ? listMdFilesByKey(userTaskFlowsDir) : new Set<string>();
  const allKeys = new Set([...bundled, ...overrides]);
  return [...allKeys]
    .sort((a, b) => a.localeCompare(b))
    .map((key) => ({
      key,
      hasBundled: bundled.has(key),
      hasOverride: overrides.has(key),
    }));
}

/**
 * Read both the user override and the bundled body for a single
 * task-flow key. Returns `null` for either side that doesn't exist on
 * disk so the caller can render "no override" / "user-only" states
 * without a separate existence probe.
 */
export function readTaskFlowSources(key: string): {
  bundled: string | null;
  override: string | null;
} {
  const bundled = (() => {
    const dir = resolveTaskFlowsDir();
    const path = join(dir, `${key}.md`);
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8");
  })();
  const override = (() => {
    if (!userTaskFlowsDir) return null;
    const path = join(userTaskFlowsDir, `${key}.md`);
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8");
  })();
  return { bundled, override };
}

function listMdFilesByKey(dir: string): Set<string> {
  if (!existsSync(dir)) return new Set();
  try {
    return new Set(
      readdirSync(dir)
        .filter((name) => name.endsWith(".md"))
        .filter((name) => {
          // Skip directories that happen to end in `.md` (rare; defensive).
          try {
            return statSync(join(dir, name)).isFile();
          } catch {
            return false;
          }
        })
        .map((name) => name.slice(0, -3)),
    );
  } catch {
    return new Set();
  }
}
