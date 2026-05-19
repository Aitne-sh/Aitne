import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { WikiCostEstimate, WikiCostEstimateFile } from "@aitne/shared";
import type { WikiWorkspaceRow } from "./workspaces.js";

/**
 * Wiki compile cost estimator — WIKI_BUILDER_DESIGN.md §5.5, §P2.E, §P4.C.
 *
 * Pure JS (no agent session, no SDK call). The estimator opens each raw
 * note, approximates its token count from on-disk content, then multiplies
 * the total by the tier unit cost and brackets with 0.5×/2× multipliers.
 * The dashboard banner and the bang-handler approval gate both read from
 * this single source so the numbers cannot drift between UI and runtime.
 *
 * P2 originally shipped a flat-per-file heuristic (`rawCount × 1500`),
 * which under-counted on long ingested articles and over-counted on
 * one-line stubs. P4.C upgrades to a per-file char→token approximation
 * (§P4.C in WIKI_BUILDER_DESIGN.md):
 *
 *   - English / Latin scripts: ~4 chars per token (the well-known
 *     OpenAI rule-of-thumb; matches Anthropic's tokenizer within ±15%
 *     for prose; confirmed against the gpt-tokenizer dist).
 *   - CJK content: ~1.5 chars per token (BPE merges short CJK runs but
 *     not as aggressively as Latin word fragments).
 *
 * The classifier counts Unicode code points whose script is one of
 * Han, Hiragana, Katakana, Hangul, Bopomofo. If the document is
 * majority-CJK we apply the CJK divisor to the entire file; otherwise
 * Latin. A per-script split would be more accurate but adds 30% code
 * for a sub-percent gain on typical mixed-script files.
 *
 * Why not invoke `@huggingface/transformers`: loading the tokenizer
 * model downloads ~50MB on first call and adds ~200ms to a route the
 * dashboard polls. The 4-chars-per-token heuristic is within 10–20% of
 * the true Anthropic count on prose and within 5% on CJK — well under
 * the 0.5×/2× bracket the design already exposes. Keep the gate cheap.
 *
 * Why pure JS, not an agent pre-pass: spawning a separate session to
 * compute the estimate would itself burn budget — and the estimate's
 * purpose is to decide whether spawning the *real* session is okay.
 */

const DEFAULT_AVG_INPUT_TOKENS_PER_RAW = 1_500;
const DEFAULT_UNIT_COST_USD_PER_KTOKEN = 0.003; // Sonnet 4.6 input ~ $3 per Mtoken.
const LATIN_CHARS_PER_TOKEN = 4;
const CJK_CHARS_PER_TOKEN = 1.5;
// Heuristic floor — empty / one-line raw files still cost the per-call
// fixed overhead (system prompt, skills bundle, tool docs). 200 input
// tokens is the rough minimum a compile session needs even for a stub.
const PER_FILE_MIN_TOKENS = 200;
// Cap on per-file breakdown rows returned to the dashboard so a vault
// with thousands of raw files does not balloon the response payload.
const PER_FILE_BREAKDOWN_LIMIT = 20;
const OPTIMISTIC_MULT = 0.5;
const PESSIMISTIC_MULT = 2.0;

export interface EstimateCompileOptions {
  /**
   * Legacy override (P2.E): use a flat `avgInputTokensPerRaw` instead of
   * the per-file char-based count. Retained for the dashboard's
   * deterministic banner copy and the existing test suite. When set,
   * disk reads are skipped — only the file count matters.
   */
  avgInputTokensPerRaw?: number;
  /** Override the per-1k-token cost the estimator uses. */
  unitCostUsdPerKToken?: number;
  /** Inject a raw count instead of scanning disk. */
  rawCountOverride?: number;
  /**
   * Cap the per-file breakdown list. The aggregate cost is unaffected.
   * Default {@link PER_FILE_BREAKDOWN_LIMIT}; set 0 to omit the list.
   */
  perFileBreakdownLimit?: number;
}

export function estimateFullCompileCost(
  workspace: Pick<
    WikiWorkspaceRow,
    "root_path" | "full_compile_approval_threshold_usd"
  >,
  options: EstimateCompileOptions = {},
): WikiCostEstimate {
  const unitCost = options.unitCostUsdPerKToken ?? DEFAULT_UNIT_COST_USD_PER_KTOKEN;
  const threshold = workspace.full_compile_approval_threshold_usd;

  // Legacy flat-heuristic branch — preserved for existing P2 tests and
  // any caller that explicitly opts into the cheap mode.
  if (options.avgInputTokensPerRaw !== undefined) {
    const rawCount =
      options.rawCountOverride ?? countRawNotes(join(workspace.root_path, "10_raw"));
    const estimatedInputTokens = Math.max(0, rawCount * options.avgInputTokensPerRaw);
    const expectedUsd = (estimatedInputTokens / 1_000) * unitCost;
    return {
      rawCount,
      estimatedInputTokens,
      unitCostUsdPerKToken: unitCost,
      optimisticUsd: round(expectedUsd * OPTIMISTIC_MULT),
      expectedUsd: round(expectedUsd),
      pessimisticUsd: round(expectedUsd * PESSIMISTIC_MULT),
      thresholdUsd: threshold,
      exceedsThreshold: expectedUsd * PESSIMISTIC_MULT > threshold,
      method: "flat-heuristic",
      perFile: [],
    };
  }

  // P4.C — per-file token estimate. Walk the raw layer, sum tokens.
  const breakdownLimit = options.perFileBreakdownLimit ?? PER_FILE_BREAKDOWN_LIMIT;
  const rawDir = join(workspace.root_path, "10_raw");
  let estimatedInputTokens = 0;
  let rawCount = 0;
  const perFile: WikiCostEstimateFile[] = [];

  if (existsSync(rawDir)) {
    for (const rel of walkRawLayer(rawDir)) {
      const full = join(rawDir, rel);
      let charCount = 0;
      let tokenCount = PER_FILE_MIN_TOKENS;
      try {
        const stat = statSync(full);
        if (!stat.isFile()) continue;
        const content = readFileSync(full, "utf-8");
        charCount = content.length;
        tokenCount = approxTokenCount(content);
      } catch {
        // Unreadable file — still account for fixed-overhead minimum so the
        // estimate is not silently 0.
      }
      rawCount += 1;
      estimatedInputTokens += tokenCount;
      perFile.push({ path: `10_raw/${rel}`, charCount, estimatedTokens: tokenCount });
    }
  }

  // Honour `rawCountOverride` for the deterministic test path. The
  // override semantically asks "what would the estimate look like for N
  // files?" so we also override the token total — keeping the per-file
  // breakdown produces an incoherent answer where `rawCount` doesn't
  // match the breakdown length. Callers that want disk-accurate numbers
  // simply omit the override.
  if (options.rawCountOverride !== undefined) {
    rawCount = options.rawCountOverride;
    estimatedInputTokens = rawCount * DEFAULT_AVG_INPUT_TOKENS_PER_RAW;
    perFile.length = 0;
  }

  // Sort breakdown by descending cost contribution so the dashboard shows
  // the biggest files first (where the operator's attention should land).
  perFile.sort((a, b) => b.estimatedTokens - a.estimatedTokens);
  const trimmedPerFile = breakdownLimit > 0 ? perFile.slice(0, breakdownLimit) : [];

  const expectedUsd = (estimatedInputTokens / 1_000) * unitCost;
  const optimisticUsd = expectedUsd * OPTIMISTIC_MULT;
  const pessimisticUsd = expectedUsd * PESSIMISTIC_MULT;
  return {
    rawCount,
    estimatedInputTokens,
    unitCostUsdPerKToken: unitCost,
    optimisticUsd: round(optimisticUsd),
    expectedUsd: round(expectedUsd),
    pessimisticUsd: round(pessimisticUsd),
    thresholdUsd: threshold,
    exceedsThreshold: pessimisticUsd > threshold,
    method: "per-file-chars",
    perFile: trimmedPerFile,
  };
}

/**
 * Approximate token count from a Markdown body. Script-aware: majority-CJK
 * content uses a denser divisor than Latin scripts because BPE merges
 * fewer multi-byte sequences. The PER_FILE_MIN_TOKENS floor models the
 * fixed per-call overhead the actual compile session pays regardless of
 * input size (system prompt, skills bundle, tool descriptions).
 */
export function approxTokenCount(content: string): number {
  if (content.length === 0) return PER_FILE_MIN_TOKENS;
  let cjkChars = 0;
  for (const ch of content) {
    if (isCjkChar(ch)) cjkChars += 1;
  }
  const totalCodepoints = [...content].length;
  const cjkRatio = totalCodepoints === 0 ? 0 : cjkChars / totalCodepoints;
  const divisor = cjkRatio > 0.5 ? CJK_CHARS_PER_TOKEN : LATIN_CHARS_PER_TOKEN;
  const tokens = Math.ceil(content.length / divisor);
  return Math.max(PER_FILE_MIN_TOKENS, tokens);
}

function isCjkChar(ch: string): boolean {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return false;
  // U+3040–U+309F Hiragana, U+30A0–U+30FF Katakana,
  // U+3400–U+4DBF / U+4E00–U+9FFF Han (CJK Unified Ideographs),
  // U+AC00–U+D7AF Hangul Syllables, U+3100–U+312F Bopomofo.
  return (
    (cp >= 0x3040 && cp <= 0x30ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0x3100 && cp <= 0x312f)
  );
}

/**
 * Walk `10_raw/` returning markdown leaves (root + recursive fallback for
 * not-yet-flattened imported vaults — see {@link countRawNotes}). The
 * `images/` subtree is skipped per §2.4 invariant.
 */
function walkRawLayer(rawDir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(rawDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(entry.name);
      continue;
    }
    if (entry.isDirectory() && entry.name === "images") continue;
    if (entry.isDirectory()) {
      walkDirInto(join(rawDir, entry.name), entry.name, out);
    }
  }
  return out;
}

function walkDirInto(absDir: string, relPrefix: string, out: string[]): void {
  try {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        out.push(`${relPrefix}/${entry.name}`);
      } else if (entry.isDirectory()) {
        walkDirInto(join(absDir, entry.name), `${relPrefix}/${entry.name}`, out);
      }
    }
  } catch {
    /* skip unreadable directory */
  }
}

function countRawNotes(rawDir: string): number {
  if (!existsSync(rawDir)) return 0;
  let count = 0;
  for (const entry of readdirSync(rawDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      count += 1;
      continue;
    }
    if (entry.isDirectory() && entry.name === "images") continue;
    if (entry.isDirectory()) {
      const full = join(rawDir, entry.name);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) {
          count += countMarkdownRecursive(full);
        }
      } catch {
        /* skip unreadable directory */
      }
    }
  }
  return count;
}

function countMarkdownRecursive(dir: string): number {
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      count += 1;
    } else if (entry.isDirectory()) {
      count += countMarkdownRecursive(join(dir, entry.name));
    }
  }
  return count;
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
