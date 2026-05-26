import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { CONTEXT_RELATIVE_PATHS, dossierPath } from "./context-paths.js";
import { aliasVaultPath } from "./context-vault-aliases.js";
import {
  POLICY_FILE_MAX_BYTES,
  createPromptInjectionBudget,
  type PromptInjectionBudget,
} from "./policy-files.js";
import { createLogger } from "../logging.js";

const logger = createLogger("review-context");

export type ReviewFlowSlug =
  | "hourly"
  | "morning"
  | "evening"
  | "weekly"
  | "monthly"
  | "roadmap";

interface ReviewFlowConfig {
  flow: ReviewFlowSlug;
  dossierPath: string;
  dossierLabel: string;
}

const REVIEW_FLOW_BY_PROCESS_KEY: Record<string, ReviewFlowConfig> = {
  "routine.hourly_check": {
    flow: "hourly",
    dossierPath: dossierPath("hourly"),
    dossierLabel: "Hourly dossier",
  },
  "routine.morning_routine": {
    flow: "morning",
    dossierPath: dossierPath("morning"),
    dossierLabel: "Morning dossier",
  },
  // `routine.morning_routine_initial` is retired; the first-run branch
  // routes through `routine.morning_routine_today` below, which inherits
  // the same dossier.
  // Stage A inherits the
  // morning-routine review context (dossiers/morning.md + the morning
  // section of context-index.md). The task-flow body
  // (`routine.morning_routine_today.md`) refers to "the Vault review
  // context block appended to this prompt" by name; without this entry
  // the dispatcher-prompt assembler would skip the appender entirely
  // for Stage A and the prose would dangle.
  // Stage B (`routine.morning_routine_journal`) is deliberately NOT
  // registered here — design §"Per-stage input sketches" requires Stage
  // B to skip the Vault review context to clear the lite cold-start
  // floor.
  "routine.morning_routine_today": {
    flow: "morning",
    dossierPath: dossierPath("morning"),
    dossierLabel: "Morning dossier",
  },
  "routine.evening_review": {
    flow: "evening",
    dossierPath: dossierPath("evening"),
    dossierLabel: "Evening dossier",
  },
  "routine.weekly_review": {
    flow: "weekly",
    dossierPath: dossierPath("weekly"),
    dossierLabel: "Weekly dossier",
  },
  "routine.monthly_review": {
    flow: "monthly",
    dossierPath: dossierPath("monthly"),
    dossierLabel: "Monthly dossier",
  },
  "routine.roadmap_refresh": {
    flow: "roadmap",
    dossierPath: dossierPath("roadmap"),
    dossierLabel: "Roadmap dossier",
  },
};

export interface ContextIndexRow {
  path: string;
  purpose: string;
  reviewFlows: string;
  lastTouched: string;
}

export interface ReviewContextBlock {
  kind: "context-index" | "indexed-file" | "dossier";
  label: string;
  path: string;
  content: string;
}

/**
 * Feature flags that decide what the review-context loader injects.
 * Sourced from runtime settings — B-004 Phase 1 ships Phase-1-only by
 * default (dossier on, index-driven loading off) because Phase 2 requires
 * a nightly reconciler that is not yet implemented.
 */
export interface ReviewContextFlags {
  useReviewDossiers: boolean;
  useContextIndex: boolean;
}

export interface LoadReviewContextOptions {
  contextDir: string;
  processKey: string;
  flags: ReviewContextFlags;
  /** Shared injection budget — threads byte accounting through
   *  `appendPolicyBlocks` so the two injectors share a single cap. */
  budget?: PromptInjectionBudget;
  readFile?: (absolutePath: string) => string;
  statFile?: (absolutePath: string) => { size: number } | null;
}

export function resolveReviewFlow(
  processKey: string,
): ReviewFlowConfig | null {
  return REVIEW_FLOW_BY_PROCESS_KEY[processKey] ?? null;
}

/**
 * Parse the rows table from the root `_index.md`. CONTEXT_VAULT_REDESIGN
 * v4 V15 split the file into user-curated prose + a daemon-owned
 * `<!-- reconciler-section -->` block. When the block is present its body
 * is the authoritative slice; consumers must NOT mix in stale outer
 * tables the user may have left from a pre-V15 hand-curated index.
 * When no block exists (fresh install before first reconcile, or a user
 * who has deleted it), fall back to the first table found anywhere in
 * the file.
 */
export function parseContextIndexRows(content: string): ContextIndexRow[] {
  const blockMatch =
    /<!--\s*reconciler-section\s*-->([\s\S]*?)<!--\s*\/reconciler-section\s*-->/.exec(
      content,
    );
  const scope = blockMatch ? blockMatch[1] : content;
  const lines = scope.split(/\r?\n/);
  const rows: ContextIndexRow[] = [];

  for (let i = 0; i < lines.length; i++) {
    const header = splitMarkdownTableRow(lines[i]);
    if (!header) continue;

    const normalizedHeader = header.map(normalizeTableHeader);
    const pathIdx = normalizedHeader.indexOf("path");
    const purposeIdx = normalizedHeader.indexOf("purpose");
    const reviewFlowsIdx = normalizedHeader.indexOf("reviewflows");
    const lastTouchedIdx = normalizedHeader.indexOf("lasttouched");
    if (
      pathIdx < 0 ||
      purposeIdx < 0 ||
      reviewFlowsIdx < 0 ||
      lastTouchedIdx < 0
    ) {
      continue;
    }

    const separator = splitMarkdownTableRow(lines[i + 1] ?? "");
    if (!separator || !separator.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))) {
      continue;
    }

    for (let j = i + 2; j < lines.length; j++) {
      const cells = splitMarkdownTableRow(lines[j]);
      if (!cells) break;
      /* c8 ignore start — `splitMarkdownTableRow` never returns []
         (`"||".slice(1,-1).split("|")` is `[""]`), so `cells[pathIdx=0]`
         is always defined; the `?? ""` is forward-defensive. */
      const rawPath = cells[pathIdx] ?? "";
      /* c8 ignore stop */
      const path = cleanIndexPath(rawPath);
      if (!path) continue;
      rows.push({
        path,
        purpose: cleanTableCell(cells[purposeIdx] ?? ""),
        reviewFlows: cleanTableCell(cells[reviewFlowsIdx] ?? ""),
        lastTouched: cleanTableCell(cells[lastTouchedIdx] ?? ""),
      });
    }
    break;
  }

  return rows;
}

export function loadReviewContextBlocks(
  opts: LoadReviewContextOptions,
): ReviewContextBlock[] {
  const flowConfig = resolveReviewFlow(opts.processKey);
  if (!flowConfig) return [];

  const { useReviewDossiers, useContextIndex } = opts.flags;
  if (!useReviewDossiers && !useContextIndex) return [];

  const blocks: ReviewContextBlock[] = [];
  const budget = opts.budget ?? createPromptInjectionBudget();

  if (useContextIndex) {
    const contextIndex = readReviewFile(
      opts,
      CONTEXT_RELATIVE_PATHS.contextIndex,
    );
    if (contextIndex !== null) {
      const admitted = pushBlockWithinBudget(blocks, budget, {
        kind: "context-index",
        label: "Context index",
        path: CONTEXT_RELATIVE_PATHS.contextIndex,
        content: contextIndex,
      });

      if (admitted) {
        const indexRows = parseContextIndexRows(contextIndex);
        for (const row of indexRows) {
          if (!reviewFlowsMatch(row.reviewFlows, flowConfig.flow)) continue;
          // Translate legacy spellings (e.g. `plans/projects/foo.md`) to their
          // canonical six-class form (`plans/projects/foo.md`) so older
          // context-index rows still resolve and dossier dedup matches
          // the new layout. Idempotent on already-canonical paths.
          const aliasedRowPath = aliasVaultPath(row.path).canonicalPath;
          if (
            aliasedRowPath === CONTEXT_RELATIVE_PATHS.contextIndex ||
            aliasedRowPath === flowConfig.dossierPath
          ) {
            continue;
          }
          /* c8 ignore start — cleanIndexPath already routes through
             sanitizeContextIndexPath upstream, so this re-sanitize never
             rejects a path that survived parsing. */
          const safePath = sanitizeContextIndexPath(aliasedRowPath);
          if (!safePath) continue;
          /* c8 ignore stop */
          const content = readReviewFile(opts, safePath);
          if (content === null) continue;
          const ok = pushBlockWithinBudget(blocks, budget, {
            kind: "indexed-file",
            label: `Indexed context: ${row.purpose || safePath}`,
            path: safePath,
            content,
          });
          if (!ok) break;
        }
      }
    }
  }

  if (useReviewDossiers) {
    const dossier = readReviewFile(opts, flowConfig.dossierPath);
    if (dossier !== null) {
      pushBlockWithinBudget(blocks, budget, {
        kind: "dossier",
        label: flowConfig.dossierLabel,
        path: flowConfig.dossierPath,
        content: dossier,
      });
    }
  }

  return blocks;
}

export function renderReviewContextBlocks(
  processKey: string,
  blocks: ReviewContextBlock[],
): string {
  const flowConfig = resolveReviewFlow(processKey);
  if (!flowConfig || blocks.length === 0) return "";

  const parts: string[] = [
    "",
    "## Vault review context",
    "",
    `Flow: \`${flowConfig.flow}\``,
    "",
    "Use this block for carry-forward state and index-directed file coverage. If you update open items, write the change back through `/api/context/*` before finishing the routine.",
    "",
  ];

  for (const block of blocks) {
    if (block.kind === "dossier") {
      parts.push(`### ${block.label} (\`${block.path}\`)`);
      parts.push("");
      parts.push(`<dossier flow="${flowConfig.flow}" path="${block.path}">`);
      parts.push(block.content.trimEnd());
      parts.push("</dossier>");
      parts.push("");
      continue;
    }

    parts.push(`### ${block.label} (\`${block.path}\`)`);
    parts.push("");
    parts.push(block.content.trimEnd());
    parts.push("");
  }

  return parts.join("\n");
}

export function appendReviewContextBlocks(
  basePrompt: string,
  opts: LoadReviewContextOptions,
): string {
  const blocks = loadReviewContextBlocks(opts);
  const rendered = renderReviewContextBlocks(opts.processKey, blocks);
  if (!rendered) return basePrompt;
  return `${basePrompt.trimEnd()}\n${rendered}`;
}

function readReviewFile(
  opts: LoadReviewContextOptions,
  relativePath: string,
): string | null {
  const safeRelativePath = sanitizeContextIndexPath(relativePath);
  /* c8 ignore start — all in-tree callers pass `CONTEXT_RELATIVE_PATHS.*`
     constants or rows already sanitised upstream; the guard remains for
     hypothetical future callers passing arbitrary input. */
  if (!safeRelativePath) return null;
  /* c8 ignore stop */
  const absolute = join(opts.contextDir, safeRelativePath);
  try {
    const stat = opts.statFile
      ? opts.statFile(absolute)
      : existsSync(absolute)
        ? statSync(absolute)
        : null;
    if (!stat) return null;
    if (stat.size > POLICY_FILE_MAX_BYTES) {
      logger.warn(
        { path: safeRelativePath, size: stat.size, cap: POLICY_FILE_MAX_BYTES },
        "Review context file exceeds per-file cap — skipped",
      );
      return null;
    }
    return opts.readFile ? opts.readFile(absolute) : readFileSync(absolute, "utf-8");
  } catch {
    return null;
  }
}

function pushBlockWithinBudget(
  blocks: ReviewContextBlock[],
  budget: PromptInjectionBudget,
  block: ReviewContextBlock,
): boolean {
  const size = Buffer.byteLength(block.content, "utf-8");
  if (size > POLICY_FILE_MAX_BYTES) {
    logger.warn(
      { path: block.path, size, cap: POLICY_FILE_MAX_BYTES },
      "Review context block exceeds per-file cap — skipped",
    );
    return false;
  }
  if (budget.usedBytes + size > budget.maxBytes) {
    logger.warn(
      {
        path: block.path,
        size,
        usedSoFar: budget.usedBytes,
        cap: budget.maxBytes,
      },
      "Review context total cap reached — remaining files skipped",
    );
    return false;
  }
  blocks.push(block);
  budget.usedBytes += size;
  return true;
}

function splitMarkdownTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  return trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
}

function normalizeTableHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function cleanTableCell(value: string): string {
  return value
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}

function cleanIndexPath(value: string): string | null {
  const cleaned = cleanTableCell(value);
  const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(value.trim());
  return sanitizeContextIndexPath(linkMatch?.[2] ?? cleaned);
}

function reviewFlowsMatch(raw: string, flow: ReviewFlowSlug): boolean {
  const normalized = raw.toLowerCase();
  if (normalized.includes("all")) return true;
  const tokens = normalized
    .replace(/\([^)]*\)/g, " ")
    .split(/[,;/\s]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  return tokens.includes(flow);
}

function sanitizeContextIndexPath(rawPath: string): string | null {
  const path = rawPath.trim().replace(/^\.\//, "");
  if (
    !path ||
    path.includes("\0") ||
    path.startsWith("#") ||
    isAbsolute(path)
  ) {
    return null;
  }
  const normalized = path.replace(/\\/g, "/");
  const resolved = resolve("/", normalized);
  /* c8 ignore next 2 — `resolve("/", x)` clamps the result inside root,
     so `relative("/", resolved)` cannot start with "..". Forward-defensive. */
  if (relative("/", resolved).startsWith("..")) return null;
  const segments = normalized.split("/");
  if (
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        segment === ".git" ||
        segment === ".obsidian" ||
        segment === ".DS_Store",
    )
  ) {
    return null;
  }
  if (!normalized.endsWith(".md") && !normalized.endsWith(".base")) {
    return null;
  }
  return normalized;
}
