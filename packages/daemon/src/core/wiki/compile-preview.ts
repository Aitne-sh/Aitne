import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { WikiCompilePreview, WikiCompileMode } from "@aitne/shared";
import type { WikiWorkspaceRow } from "./workspaces.js";
import { estimateFullCompileCost } from "./cost-estimate.js";

/**
 * WIKI_BUILDER_DESIGN.md §P4.B — pure-JS preview producer for
 * `!compile --preview` (and `--dry-run` aliases). Surfaces what
 * `wiki.compile` would touch before any agent session runs, so the
 * operator can approve / reject from a DM reply or the dashboard.
 *
 * The compiler itself is an LLM session — its page-graph determination
 * is opaque to pure code. The preview approximates the touch set with
 * the only signal we have without running it:
 *
 *   - Raw note `10_raw/<slug>.md` whose mtime is newer than the workspace
 *     `last_compile_at` is "pending"; older is "stale" (would be skipped
 *     in incremental mode, re-processed in full mode).
 *   - A pending raw whose stem matches an existing `20_wiki/<slug>.md` is
 *     "modified" (compiler likely updates the wiki page).
 *   - A pending raw with no matching wiki page is "added".
 *   - In full mode, every raw is pending and reuses the same classifier.
 *
 * This is intentionally fuzzy: the actual compile is allowed to override
 * the classification (e.g. merge two raws into one wiki page). The
 * preview's contract is "no surprises larger than this set", not "exactly
 * this set". The §P4.B copy in WIKI_BUILDER_DESIGN.md states the same
 * caveat — the dry-run is an upper-bound courtesy, not a commitment.
 *
 * Duration: estimated from the token total and a per-MTok throughput
 * constant (`SECONDS_PER_MTOK_INPUT`). Sonnet at peak streams ~1.2k
 * tokens/sec but compile sessions are tool-loop-bounded; the constant
 * undershoots so the dashboard ETA isn't optimistic.
 */

// Sonnet 4.6 tool-loop steady-state in compile sessions runs ~5–8 minutes
// per million input tokens once the tool fan-out overhead is folded in.
// Stay on the pessimistic side so a "10-minute compile" never surprises
// the operator by taking 25.
const SECONDS_PER_MTOK_INPUT = 480;

export interface CompilePreviewInput {
  workspace: WikiWorkspaceRow;
  mode: WikiCompileMode;
}

export function buildCompilePreview(input: CompilePreviewInput): WikiCompilePreview {
  const rawDir = join(input.workspace.root_path, "10_raw");
  const wikiDir = join(input.workspace.root_path, "20_wiki");

  const rawFiles = listRawSlugs(rawDir);
  const wikiSlugs = new Set(listWikiSlugs(wikiDir));
  const lastCompileEpoch = parseEpoch(input.workspace.last_compile_at);

  const added: string[] = [];
  const modified: string[] = [];
  const unchanged: string[] = [];

  for (const raw of rawFiles) {
    const isPending =
      input.mode === "full" ||
      lastCompileEpoch === null ||
      raw.mtimeEpoch > lastCompileEpoch;
    if (!isPending) {
      unchanged.push(`10_raw/${raw.relPath}`);
      continue;
    }
    if (wikiSlugs.has(raw.slug)) {
      modified.push(`20_wiki/${raw.slug}.md`);
    } else {
      added.push(`20_wiki/${raw.slug}.md`);
    }
  }

  // Wiki pages without a corresponding pending raw are reported under
  // `unchanged` so the dashboard can render a "pages that will keep their
  // current content" count next to "pages that will change".
  const touchedSlugs = new Set<string>();
  for (const path of [...added, ...modified]) {
    const m = path.match(/^20_wiki\/(.+)\.md$/);
    if (m) touchedSlugs.add(m[1]);
  }
  for (const slug of wikiSlugs) {
    if (touchedSlugs.has(slug)) continue;
    unchanged.push(`20_wiki/${slug}.md`);
  }

  // Reuse the canonical estimator so the preview, the dashboard banner,
  // and the !compile-full approval gate quote identical numbers.
  const estimate = estimateFullCompileCost(input.workspace);
  // For incremental mode, scale the estimate to the pending-raw subset
  // so the preview cost isn't full-rebuild cost. The 0.5×/2× brackets in
  // `WikiCostEstimate` keep their meaning at the scaled magnitude.
  const pendingCount = added.length + modified.length;
  const scaledEstimate =
    input.mode === "full" || estimate.rawCount === 0
      ? estimate
      : scaleEstimate(estimate, pendingCount);

  const estimatedDurationSeconds = Math.ceil(
    (scaledEstimate.estimatedInputTokens / 1_000_000) * SECONDS_PER_MTOK_INPUT,
  );

  return {
    workspace: input.workspace.name,
    mode: input.mode,
    added: added.sort(),
    modified: modified.sort(),
    unchanged: unchanged.sort(),
    estimate: scaledEstimate,
    estimatedDurationSeconds,
  };
}

function scaleEstimate(
  estimate: ReturnType<typeof estimateFullCompileCost>,
  pendingCount: number,
): ReturnType<typeof estimateFullCompileCost> {
  if (estimate.rawCount === 0) return estimate;
  const ratio = pendingCount / estimate.rawCount;
  const scaledTokens = Math.round(estimate.estimatedInputTokens * ratio);
  const expectedUsd = (scaledTokens / 1_000) * estimate.unitCostUsdPerKToken;
  return {
    ...estimate,
    rawCount: pendingCount,
    estimatedInputTokens: scaledTokens,
    optimisticUsd: round(expectedUsd * 0.5),
    expectedUsd: round(expectedUsd),
    pessimisticUsd: round(expectedUsd * 2),
    exceedsThreshold: expectedUsd * 2 > estimate.thresholdUsd,
  };
}

interface RawFileEntry {
  relPath: string;
  slug: string;
  mtimeEpoch: number;
}

function listRawSlugs(rawDir: string): RawFileEntry[] {
  if (!existsSync(rawDir)) return [];
  const out: RawFileEntry[] = [];
  for (const entry of readdirSync(rawDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      try {
        const stat = statSync(join(rawDir, entry.name));
        out.push({
          relPath: entry.name,
          slug: entry.name.slice(0, -3),
          mtimeEpoch: stat.mtimeMs,
        });
      } catch {
        /* skip */
      }
      continue;
    }
    if (entry.isDirectory() && entry.name === "images") continue;
    // Imported vaults may keep type-subdirs under 10_raw until migration;
    // walk them so the preview is still useful pre-flatten. Slugs collide
    // across subdirs are tolerated because the compiler treats each raw
    // file independently — the rare duplicate is reported as `modified`
    // twice, which is correct intent for the operator.
    if (entry.isDirectory()) {
      walkSubdir(join(rawDir, entry.name), entry.name, out);
    }
  }
  return out;
}

function walkSubdir(absDir: string, prefix: string, out: RawFileEntry[]): void {
  try {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        try {
          const stat = statSync(join(absDir, entry.name));
          out.push({
            relPath: `${prefix}/${entry.name}`,
            slug: entry.name.slice(0, -3),
            mtimeEpoch: stat.mtimeMs,
          });
        } catch {
          /* skip */
        }
      } else if (entry.isDirectory()) {
        walkSubdir(join(absDir, entry.name), `${prefix}/${entry.name}`, out);
      }
    }
  } catch {
    /* skip unreadable directory */
  }
}

function listWikiSlugs(wikiDir: string): string[] {
  if (!existsSync(wikiDir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(wikiDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const slug = entry.name.slice(0, -3);
    if (slug === "_index") continue;
    out.push(slug);
  }
  return out;
}

function parseEpoch(timestamp: string | null): number | null {
  if (!timestamp) return null;
  // SQLite emits `YYYY-MM-DD HH:MM:SS` from CURRENT_TIMESTAMP, which
  // `new Date(...)` reads as local time in Node — but the value is UTC.
  // Treat the space-separator shape explicitly so the comparison against
  // `mtimeMs` (always UTC epoch) stays correct across operator timezones.
  const isoCandidate = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(timestamp)
    ? `${timestamp.replace(" ", "T")}Z`
    : timestamp;
  const epoch = Date.parse(isoCandidate);
  return Number.isNaN(epoch) ? null : epoch;
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
