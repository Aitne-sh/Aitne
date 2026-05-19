import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTEXT_RELATIVE_PATHS } from "./context-paths.js";
import { createLogger } from "../logging.js";

const logger = createLogger("policy-files");

/**
 * Per-file byte cap. Files larger than this are skipped with a warning —
 * a user who accidentally pastes a 50MB transcript into rules/management.md
 * should not silently blow up prompt assembly. 32KB is comfortably above
 * the size of any realistic policy file (the largest templates under
 * `agent-assets/templates/` are under 4KB).
 */
export const POLICY_FILE_MAX_BYTES = 32 * 1024;

/**
 * Aggregate cap across all injected blocks per assembly. Acts as a
 * backstop when many small files sum to a runaway total.
 */
export const POLICY_TOTAL_MAX_BYTES = 128 * 1024;

/**
 * Shared byte budget threaded through `appendPolicyBlocks` and the
 * review-context injector so a single aggregate cap covers both. Callers
 * at prompt-assembly time instantiate one budget and pass it to every
 * injector that contributes to the same prompt.
 */
export interface PromptInjectionBudget {
  usedBytes: number;
  maxBytes: number;
}

export function createPromptInjectionBudget(
  maxBytes: number = POLICY_TOTAL_MAX_BYTES,
): PromptInjectionBudget {
  return { usedBytes: 0, maxBytes };
}

/**
 * B-007 §5.8 — policy-file injection mechanism.
 *
 * A "policy file" is a natural-language rulebook stored in the vault that
 * the agent should read when executing a particular ProcessKey. Examples:
 *
 *   - `rules/mcp.md` — MCP usage rules (B-003; inject when any MCP enabled)
 *   - `rules/journal-format.md` — daily journal format (morning routine)
 *   - `rules/redaction.md` — secret patterns (all flows)
 *   - `routines/hourly.md` — hourly check list
 *   - `routines/morning.md` — 04:00 checks (morning routine)
 *   - `routines/custom/<slug>.md` — per-custom-routine check list
 *
 * `appendPolicyBlocks` resolves the set of policy files relevant to a
 * ProcessKey, reads each from the runtime context dir, and returns a
 * single concatenated string suitable to append to a task-flow prompt.
 *
 * Phase 1 provides the module. Phase 2 wires it into `prompts.ts` at
 * task-flow assembly time. Phase 3 layers morning-routine-specific blocks
 * on top (journal-format + journal-export).
 *
 * Note: `rules/management.md` is NOT in this registry — `ContextBuilder`
 * injects it once at the top of every session prompt as the
 * `<management_rules>` block (see `context-builder.ts`). Task-flows
 * (`routine.morning_routine.md`, `setup.update.md`, …) reference that
 * XML tag directly, so the authoritative injection path lives there.
 *
 * Re-emitting it through `appendPolicyBlocks` (the pre-2026-05-15
 * shape; see `docs/design/21-management-registry-and-entities.md` §0.2
 * historical note) was a pure duplicate that (a) doubled the
 * SoT-bindings text in every prompt, and (b) consumed a slot from the
 * shared `POLICY_TOTAL_MAX_BYTES` budget that other registry files
 * (mcp.md, journal-format.md, journal-export.md, …) need to fit
 * under. The per-file 32 KB cap that previously guarded against a
 * runaway management.md was ported to `ContextBuilder` so NFR-1b's
 * safety contract is preserved.
 */

export interface PolicyFileRef {
  /** Relative path under contextDir, e.g. `rules/management.md`. */
  path: string;
  /** Short label used in the rendered block header. */
  label: string;
  /** Predicate deciding whether to inject for a given call. */
  injectIf?: (ctx: PolicyContext) => boolean;
}

export interface PolicyContext {
  processKey: string;
  /** Extra runtime flags the injectIf predicates can consume. */
  flags?: Record<string, unknown>;
}

/**
 * Static registry of policy files. Entries map a ProcessKey (or a broader
 * predicate) to one or more vault files that should be injected. Most
 * entries inject only when the corresponding user-edited file actually
 * exists so we don't spam the model with missing-file warnings.
 */
export const POLICY_FILE_REGISTRY: Record<string, PolicyFileRef[]> = {
  "*": [
    // `rules/management.md` is intentionally NOT in this registry.
    // ContextBuilder's `<management_rules>` block is the authoritative
    // injection (task-flows reference the XML tag by name); re-adding
    // a heading-form copy here would duplicate the SoT text in every
    // prompt AND burn a slot of POLICY_TOTAL_MAX_BYTES that mcp.md /
    // journal-format.md / journal-export.md need. The per-file 32 KB
    // cap is enforced by ContextBuilder (NFR-1b). See module-level
    // JSDoc + design 21 §0.2.
    {
      path: CONTEXT_RELATIVE_PATHS.rules.redaction,
      label: "Redaction patterns",
    },
    {
      // B-003 — MCP rules are only injected when at least one MCP server
      // is currently attached. The flag is populated by the dispatcher at
      // prompt-assembly time once B-003 lands. Registering the ref here
      // means B-003 does not need to modify the registry later; it only
      // flips the runtime flag.
      path: CONTEXT_RELATIVE_PATHS.rules.mcp,
      label: "MCP usage rules",
      injectIf: (ctx) => ctx.flags?.mcpEnabled === true,
    },
  ],
  "routine.hourly_check": [
    { path: CONTEXT_RELATIVE_PATHS.routines.hourly, label: "Hourly checks" },
  ],
  "routine.morning_routine": [
    {
      path: CONTEXT_RELATIVE_PATHS.routines.morning,
      label: "Morning routine checks",
    },
    {
      path: CONTEXT_RELATIVE_PATHS.rules.journalFormat,
      label: "Daily journal format spec",
    },
    {
      path: CONTEXT_RELATIVE_PATHS.rules.journalExport,
      label: "Journal export rules",
    },
  ],
  // `routine.morning_routine_initial` retired by
  // morning-routine-optimization.md Phase 7 (2026-05-16) — first-run
  // branch routes through `routine.morning_routine_today` below.
  // morning-routine-optimization.md Phase 5 — Stage A inherits the
  // global `*` set (redaction + mcp when enabled) PLUS the user-editable
  // morning checks. Journal-format / journal-export are deliberately
  // NOT injected on Stage A — those are Stage B's policy blocks now.
  // The Vault review context (dossiers/morning.md) is injected by the
  // review-context appender keyed on processKey, not by this registry.
  "routine.morning_routine_today": [
    {
      path: CONTEXT_RELATIVE_PATHS.routines.morning,
      label: "Morning routine checks",
    },
  ],
  // morning-routine-optimization.md Phase 5 — Stage B opts OUT of every
  // `*` default except `rules/redaction.md`. `resolvePolicyRefs` honours
  // the `POLICY_KEY_GLOBAL_OPTOUT` set below by skipping the `*` merge
  // entirely; Stage B re-declares the redaction ref here so it still
  // flows through the same vault-write protections every other writer
  // sees. `rules/mcp.md` is deliberately omitted — Stage B uses no MCP
  // tools (skill bundle is `context` + `_safety` only), so injecting
  // the rulebook would waste lite-tier prompt budget for no behaviour.
  "routine.morning_routine_journal": [
    {
      path: CONTEXT_RELATIVE_PATHS.rules.redaction,
      label: "Redaction patterns",
    },
    {
      path: CONTEXT_RELATIVE_PATHS.rules.journalFormat,
      label: "Daily journal format spec",
    },
    {
      path: CONTEXT_RELATIVE_PATHS.rules.journalExport,
      label: "Journal export rules",
    },
  ],
  "routine.evening_review": [
    {
      path: CONTEXT_RELATIVE_PATHS.routines.evening,
      label: "Evening review checks",
    },
  ],
  "routine.weekly_review": [
    {
      path: CONTEXT_RELATIVE_PATHS.routines.weekly,
      label: "Weekly review checks",
    },
  ],
  "routine.monthly_review": [
    {
      path: CONTEXT_RELATIVE_PATHS.routines.monthly,
      label: "Monthly review checks",
    },
  ],
  // `roadmap_refresh` is not its own user-editable cadence file in B-007.
  // It reuses the monthly planning rulebook so roadmap upkeep and monthly
  // planning checks stay in one place instead of drifting apart.
  "routine.roadmap_refresh": [
    {
      path: CONTEXT_RELATIVE_PATHS.routines.monthly,
      label: "Roadmap refresh checks",
    },
  ],
};

/**
 * Process keys that opt OUT of the global `*` registry merge. A key in
 * this set sees ONLY its own entries in `POLICY_FILE_REGISTRY[<key>]`
 * — the policies it actually needs must be re-declared inline (the
 * Stage B `routine.morning_routine_journal` entry above re-lists
 * `rules/redaction.md` for exactly this reason).
 *
 * Motivation (`morning-routine-optimization.md` Phase 5): Stage B runs
 * on the lite tier and ships with a `context` + `_safety` skill bundle
 * only. Inheriting `rules/mcp.md` (any time any MCP server is enabled
 * anywhere in the daemon) would pay prompt budget for behaviour Stage
 * B cannot exhibit, defeating the cold-start-floor sizing that makes
 * lite viable. Re-declaring `rules/redaction.md` inline keeps every
 * vault-write surface bound by the same patterns regardless of whether
 * the key opted out.
 */
const POLICY_KEY_GLOBAL_OPTOUT = new Set<string>([
  "routine.morning_routine_journal",
]);

/**
 * Pull the set of policy refs for a processKey. Process-specific entries
 * are appended to the global `*` set. Custom routines (keys starting with
 * `routine.custom.`) resolve to their slugged file automatically. Keys
 * in `POLICY_KEY_GLOBAL_OPTOUT` skip the `*` merge entirely and see only
 * their own entries.
 */
export function resolvePolicyRefs(processKey: string): PolicyFileRef[] {
  const global = POLICY_KEY_GLOBAL_OPTOUT.has(processKey)
    ? []
    : POLICY_FILE_REGISTRY["*"];
  const specific = POLICY_FILE_REGISTRY[processKey] ?? [];
  if (processKey.startsWith("routine.custom.")) {
    const slug = processKey.slice("routine.custom.".length);
    return [
      ...global,
      {
        path: `routines/custom/${slug}.md`,
        label: `Custom routine: ${slug}`,
      },
    ];
  }
  return [...global, ...specific];
}

export interface AppendPolicyBlocksOptions {
  contextDir: string;
  processKey: string;
  flags?: Record<string, unknown>;
  /**
   * Shared injection budget. When omitted, `loadPolicyBlocks` creates a
   * private budget scoped to this call (legacy behavior). Prompt-assembly
   * call sites that also inject review-context or other blocks should
   * create one budget via `createPromptInjectionBudget()` and pass it to
   * every injector so the aggregate cap holds.
   */
  budget?: PromptInjectionBudget;
  /** Override the file reader — used by tests. */
  readFile?: (path: string) => string;
}

export interface PolicyBlock {
  label: string;
  path: string;
  content: string;
}

/**
 * Read each resolved policy file from disk and return structured blocks.
 * Missing files are skipped silently — the registry describes INTENT; the
 * actual injection only happens when the user has materialized the file.
 * Oversize files (per-file or in aggregate) are skipped with a warning
 * to keep prompt assembly predictable.
 */
export function loadPolicyBlocks(
  opts: AppendPolicyBlocksOptions,
): PolicyBlock[] {
  const refs = resolvePolicyRefs(opts.processKey);
  const ctx: PolicyContext = {
    processKey: opts.processKey,
    flags: opts.flags,
  };
  const blocks: PolicyBlock[] = [];
  const budget = opts.budget ?? createPromptInjectionBudget();
  for (const ref of refs) {
    if (ref.injectIf && !ref.injectIf(ctx)) continue;
    const absolute = join(opts.contextDir, ref.path);
    const content = readPolicyFile(absolute, opts.readFile);
    if (content === null) continue;

    const size = Buffer.byteLength(content, "utf-8");
    if (size > POLICY_FILE_MAX_BYTES) {
      logger.warn(
        { path: ref.path, size, cap: POLICY_FILE_MAX_BYTES },
        "Policy file exceeds per-file cap — skipped",
      );
      continue;
    }
    if (budget.usedBytes + size > budget.maxBytes) {
      logger.warn(
        {
          path: ref.path,
          size,
          usedSoFar: budget.usedBytes,
          cap: budget.maxBytes,
        },
        "Policy total cap reached — remaining files skipped",
      );
      break;
    }
    budget.usedBytes += size;
    blocks.push({ label: ref.label, path: ref.path, content });
  }
  return blocks;
}

/**
 * Concatenate loaded blocks into a single prompt-ready string.
 * Each block is wrapped in a heading + fenced code block so it survives
 * further prompt assembly without being mistaken for instructions.
 */
export function renderPolicyBlocks(blocks: PolicyBlock[]): string {
  if (blocks.length === 0) return "";
  const parts: string[] = ["", "## Vault policy files", ""];
  for (const block of blocks) {
    parts.push(`### ${block.label} (\`${block.path}\`)`);
    parts.push("");
    parts.push(block.content.trimEnd());
    parts.push("");
  }
  return parts.join("\n");
}

export function appendPolicyBlocks(
  basePrompt: string,
  opts: AppendPolicyBlocksOptions,
): string {
  const blocks = loadPolicyBlocks(opts);
  const rendered = renderPolicyBlocks(blocks);
  if (!rendered) return basePrompt;
  return `${basePrompt.trimEnd()}\n${rendered}`;
}

function readPolicyFile(
  absolute: string,
  reader?: (path: string) => string,
): string | null {
  try {
    if (reader) {
      return reader(absolute);
    }
    if (!existsSync(absolute)) return null;
    return readFileSync(absolute, "utf-8");
  } catch {
    return null;
  }
}
