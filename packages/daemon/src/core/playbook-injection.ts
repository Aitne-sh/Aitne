/**
 * Playbook injection — the Phase-2 "by-injection" delivery of operating
 * playbooks (AGENT_PROMPT_QUALITY_DESIGN.md §3.2 / §4 Phase 2).
 *
 * Generalizes the proven `policyFiles → appendPolicyBlocks` mechanism
 * (`policy-files.ts`) to a *different content root*: policy files are
 * vault-relative (read from `contextDir`), whereas playbooks are curated
 * daemon-bundle assets read from
 * `<workspaceDir>/agent-assets/playbooks/<slug>.md`.
 *
 * Injection is the *single* delivery path for playbook content (the retired
 * Phase-1 `playbooks` skill used to materialize the same text into the session
 * as a second copy; that duplication was removed — see AGENT_PROMPT_QUALITY
 * _DESIGN.md §4 "Injection is the single delivery"). Nothing is captured-once:
 * the dispatcher re-reads the Agent's declared `playbooks:` off disk each firing,
 * and the content itself is read fresh from the bundle here, so a central edit
 * takes effect on the next run.
 *
 * Shares the caller's `PromptInjectionBudget` with the policy + review-context
 * injectors so the aggregate `POLICY_TOTAL_MAX_BYTES` cap covers all three and
 * one runaway block can't inflate the effective prompt ceiling.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PLAYBOOK_REGISTRY, isPlaybookSlug, type PlaybookSlug } from "@aitne/shared";

import {
  POLICY_FILE_MAX_BYTES,
  createPromptInjectionBudget,
  type PromptInjectionBudget,
} from "./policy-files.js";
import { stripFrontmatter } from "./skills-compiler-skill-index.js";
import { createLogger } from "../logging.js";

const logger = createLogger("playbook-injection");

export interface AppendPlaybookBlocksOptions {
  /** Package root that contains `agent-assets/` (config.workspaceDir). */
  workspaceDir: string;
  /** The Agent's declared playbook slugs (order + duplicates tolerated). */
  playbooks: readonly string[];
  /**
   * Shared injection budget. When omitted a private budget scoped to this call
   * is created (legacy behaviour); prompt-assembly sites should pass the one
   * budget they thread through every injector.
   */
  budget?: PromptInjectionBudget;
  /** Override the file reader — used by tests. */
  readFile?: (path: string) => string;
}

export interface PlaybookBlock {
  slug: PlaybookSlug;
  label: string;
  content: string;
}

/** Resolve a playbook slug to its bundled content file's absolute path. */
export function playbookReferencePath(
  workspaceDir: string,
  slug: PlaybookSlug,
): string {
  return join(
    workspaceDir,
    "agent-assets",
    "playbooks",
    PLAYBOOK_REGISTRY[slug].referenceFile,
  );
}

/**
 * Read each declared playbook's bundled content file, strip its YAML frontmatter
 * (via the shared `stripFrontmatter` helper), and return structured blocks.
 * Unknown slugs, missing/empty files, and oversize/over-budget files are skipped
 * with a warning — the same "describe intent, inject what resolves" posture as
 * `loadPolicyBlocks`. Duplicate slugs are de-duplicated (first wins).
 */
export function loadPlaybookBlocks(
  opts: AppendPlaybookBlocksOptions,
): PlaybookBlock[] {
  const budget = opts.budget ?? createPromptInjectionBudget();
  const blocks: PlaybookBlock[] = [];
  const seen = new Set<PlaybookSlug>();

  for (const raw of opts.playbooks) {
    if (!isPlaybookSlug(raw)) {
      logger.warn({ playbook: raw }, "Unknown playbook slug — skipped");
      continue;
    }
    if (seen.has(raw)) continue;
    seen.add(raw);

    const absolute = playbookReferencePath(opts.workspaceDir, raw);
    const rawContent = readPlaybookFile(absolute, opts.readFile);
    if (rawContent === null) {
      logger.warn(
        { slug: raw, path: absolute },
        "Playbook reference file missing/unreadable — skipped",
      );
      continue;
    }
    const content = stripFrontmatter(rawContent).trim();
    if (content.length === 0) continue;

    const size = Buffer.byteLength(content, "utf-8");
    if (size > POLICY_FILE_MAX_BYTES) {
      logger.warn(
        { slug: raw, size, cap: POLICY_FILE_MAX_BYTES },
        "Playbook exceeds per-file cap — skipped",
      );
      continue;
    }
    if (budget.usedBytes + size > budget.maxBytes) {
      logger.warn(
        { slug: raw, size, usedSoFar: budget.usedBytes, cap: budget.maxBytes },
        "Playbook total cap reached — remaining playbooks skipped",
      );
      break;
    }
    budget.usedBytes += size;
    blocks.push({ slug: raw, label: PLAYBOOK_REGISTRY[raw].label, content });
  }

  return blocks;
}

/**
 * Concatenate loaded playbook blocks into a prompt-ready string. Mirrors
 * `renderPolicyBlocks`: a section heading per block, content raw (not fenced) so
 * the playbook's own `###` subsections render. The lead-in restates the
 * division of labor (prompt = what, playbook = how) the SKILL.md index carries.
 */
export function renderPlaybookBlocks(blocks: PlaybookBlock[]): string {
  if (blocks.length === 0) return "";
  const parts: string[] = [
    "",
    "## Operating playbooks",
    "",
    "Durable methodology for this Agent's task family — follow each as the "
      + "operating standard. Your task specifics above take precedence for *what* to "
      + "produce; the playbook governs *how* to produce it well.",
    "",
  ];
  for (const block of blocks) {
    parts.push(`### ${block.label} playbook (\`playbooks:${block.slug}\`)`);
    parts.push("");
    parts.push(block.content);
    parts.push("");
  }
  return parts.join("\n");
}

/** Append the rendered playbook blocks to a base prompt (no-op when empty). */
export function appendPlaybookBlocks(
  basePrompt: string,
  opts: AppendPlaybookBlocksOptions,
): string {
  const blocks = loadPlaybookBlocks(opts);
  const rendered = renderPlaybookBlocks(blocks);
  if (!rendered) return basePrompt;
  return `${basePrompt.trimEnd()}\n${rendered}`;
}

function readPlaybookFile(
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
