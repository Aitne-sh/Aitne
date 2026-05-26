import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type {
  ClusterSnapshot,
  ProjectKeywords,
} from "./weekly-interests-summary.js";

/**
 * WEEKLY_INTERESTS_REFLECTION_PLAN.md §10.5 — frontmatter-driven
 * keyword extraction for project files + per-project Jaccard / filename
 * matcher.
 *
 * Pure helpers. The frontmatter parser here is a minimal flat-scalar
 * reader with two extensions over `core/context-frontmatter.ts`:
 *
 *   1. Keys may contain `.` (e.g. `aitne.exclude_from_interests`) — the
 *      existing flat parser is restricted to `[A-Za-z0-9_-]` keys.
 *   2. Values may be YAML flow arrays (`[a, b, "c d"]`) or block
 *      sequences (`\n  - a\n  - b\n`), both of which `aliases` / `tags`
 *      may legitimately use.
 *
 * Everything else is identical to the rest of the codebase's
 * frontmatter expectations: `---` fences delimit the block, the body
 * follows. No multi-line scalar support; we don't need it for the
 * three keys (`aitne_project_keywords`, `aitne.exclude_from_interests`,
 * `aliases`, `tags`) we read.
 */

// CONTEXT_VAULT_REDESIGN: project files live under plans/projects/.
const PROJECTS_DIR = "plans/projects";
const KEY_PROJECT_KEYWORDS = "aitne_project_keywords";
const KEY_EXCLUDE = "aitne.exclude_from_interests";
const KEY_ALIASES = "aliases";
const KEY_TAGS = "tags";
const TOKEN_SPLIT = /[-_/\s]+/;

const JACCARD_MIN_OVERLAP_TOKENS = 2;
const JACCARD_MIN_RATIO = 0.15;
const DEFAULT_MAX_CLUSTER_MATCHES = 5;

/**
 * Frontmatter values keyed by name. Scalars are strings (no quotes);
 * arrays come from flow `[a, b]` or block `- a\n- b` syntax.
 */
type FrontmatterValue = string | string[];

interface ParsedFrontmatter {
  values: Map<string, FrontmatterValue>;
}

function parseFrontmatter(content: string): ParsedFrontmatter | null {
  const lines = content.split(/\r?\n/);
  if (lines.length === 0 || lines[0]!.trim() !== "---") return null;
  const endIdx = lines.findIndex(
    (line, index) => index > 0 && line.trim() === "---",
  );
  if (endIdx < 0) return null;

  const values = new Map<string, FrontmatterValue>();
  let i = 1;
  while (i < endIdx) {
    const raw = lines[i]!;
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) {
      i += 1;
      continue;
    }
    // Allow dots in keys (`aitne.exclude_from_interests:`).
    const match = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) {
      i += 1;
      continue;
    }
    const key = match[1]!;
    const rest = match[2]!.trim();

    if (rest === "" || rest === "[]") {
      // Look ahead for a block sequence:
      //   tags:
      //     - foo
      //     - bar
      const items: string[] = [];
      let j = i + 1;
      while (j < endIdx) {
        const next = lines[j]!;
        const dashMatch = /^\s*-\s+(.*)$/.exec(next);
        if (!dashMatch) break;
        items.push(stripQuotes(dashMatch[1]!.trim()));
        j += 1;
      }
      if (items.length > 0) {
        values.set(key, items);
        i = j;
        continue;
      }
      values.set(key, "");
      i += 1;
      continue;
    }

    if (rest.startsWith("[") && rest.endsWith("]")) {
      values.set(key, parseFlowArray(rest));
      i += 1;
      continue;
    }

    values.set(key, stripQuotes(rest));
    i += 1;
  }
  return { values };
}

function parseFlowArray(value: string): string[] {
  // `value` is the full `[…]` text. Strip the brackets and split on
  // commas, respecting quoted strings.
  const inner = value.slice(1, -1);
  const out: string[] = [];
  let buf = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        buf += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ",") {
      const trimmed = buf.trim();
      if (trimmed.length > 0) out.push(trimmed);
      buf = "";
      continue;
    }
    buf += ch;
  }
  const tail = buf.trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

// Quoted-scalar matcher: double- or single-quotes surrounding the
// whole value. Anything else passes through unchanged.
const QUOTED_SCALAR_RE = /^(?:"([^"]*)"|'([^']*)')$/;

function stripQuotes(value: string): string {
  const m = QUOTED_SCALAR_RE.exec(value);
  if (!m) return value;
  // Exactly one of the alternation groups is populated when the regex
  // matches — both are bounded by `^…$` so they cannot be optional.
  return (m[1] ?? m[2])!;
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(TOKEN_SPLIT)
    .filter((tok) => tok.length > 1);
}

function isTruthyYamlBool(value: FrontmatterValue): boolean {
  if (Array.isArray(value)) return false;
  const v = value.trim().toLowerCase();
  return v === "true" || v === "yes" || v === "on";
}

function asStringArray(value: FrontmatterValue): string[] {
  if (Array.isArray(value)) return value;
  // Scalar provided where an array was expected (e.g. `tags: foo`).
  // Treat the whole scalar as a single entry the tokenizer will split.
  return value.trim().length > 0 ? [value] : [];
}

/**
 * Extract the keyword set for a single project file. Pure with
 * respect to the inputs `content` and `filename`; the FS reader below
 * (`loadProjectKeywords`) is the only impure entry.
 *
 * Returns `null` when the project opts out via
 * `aitne.exclude_from_interests: true`.
 */
export function extractKeywordsFromFile(
  filename: string,
  content: string,
  projectPath: string,
): ProjectKeywords | null {
  const projectSlug = filename.replace(/\.md$/i, "");
  const fm = parseFrontmatter(content);

  if (fm) {
    const exclude = fm.values.get(KEY_EXCLUDE);
    if (exclude !== undefined && isTruthyYamlBool(exclude)) return null;
  }

  // 1. Explicit override.
  const explicit = fm?.values.get(KEY_PROJECT_KEYWORDS);
  if (explicit !== undefined) {
    const items = asStringArray(explicit);
    const tokens = new Set<string>();
    for (const item of items) {
      for (const tok of tokenize(item)) tokens.add(tok);
    }
    if (tokens.size > 0) {
      return {
        projectSlug,
        projectPath,
        keywords: tokens,
        source: "explicit",
      };
    }
    // Fall through if the override was an empty array — same as
    // omitting the key.
  }

  // 2. Frontmatter aliases/tags + filename.
  const tokens = new Set<string>();
  let frontmatterContributed = false;
  if (fm) {
    for (const key of [KEY_ALIASES, KEY_TAGS]) {
      const value = fm.values.get(key);
      if (value === undefined) continue;
      const items = asStringArray(value);
      for (const item of items) {
        for (const tok of tokenize(item)) {
          tokens.add(tok);
          frontmatterContributed = true;
        }
      }
    }
  }

  // 3. Filename fallback (always added — it's free and never wrong).
  for (const tok of tokenize(projectSlug)) tokens.add(tok);

  return {
    projectSlug,
    projectPath,
    keywords: tokens,
    source: frontmatterContributed ? "frontmatter" : "filename",
  };
}

/**
 * Read every `*.md` directly under `<contextDir>/projects/`. Sub-
 * directories are ignored — projects are flat by convention in this
 * codebase. Missing or non-directory paths return `[]` quietly so the
 * caller does not need to feature-detect.
 */
export function loadProjectKeywords(contextDir: string): ProjectKeywords[] {
  const dir = join(contextDir, PROJECTS_DIR);
  let entries: string[];
  try {
    const stat = statSync(dir);
    if (!stat.isDirectory()) return [];
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: ProjectKeywords[] = [];
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith(".md")) continue;
    const filePath = join(dir, entry);
    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    const extracted = extractKeywordsFromFile(
      basename(entry),
      content,
      filePath,
    );
    if (extracted) out.push(extracted);
  }
  out.sort((a, b) => a.projectSlug.localeCompare(b.projectSlug));
  return out;
}

/**
 * Single-project matcher. Pure. Returns up to `cap` matches sorted in
 * the order they appear in `clusters` — the caller pre-sorts that
 * input (the Step 1 builder ranks by foreground_sec desc).
 */
export function matchClustersToProject(
  project: ProjectKeywords,
  clusters: readonly ClusterSnapshot[],
  cap: number = DEFAULT_MAX_CLUSTER_MATCHES,
): { slug: string; reason: "filename_match" | "jaccard" }[] {
  const matches: { slug: string; reason: "filename_match" | "jaccard" }[] = [];
  const seen = new Set<string>();
  const projectSlugLower = project.projectSlug.toLowerCase();

  for (const cluster of clusters) {
    if (matches.length >= cap) break;

    if (cluster.displayName.toLowerCase().includes(projectSlugLower)) {
      if (!seen.has(cluster.slug)) {
        matches.push({ slug: cluster.slug, reason: "filename_match" });
        seen.add(cluster.slug);
      }
      continue;
    }

    const clusterTokens = new Set<string>();
    for (const tok of tokenize(cluster.displayName)) clusterTokens.add(tok);
    for (const domain of cluster.topDomains) {
      const prefix = domain
        .replace(/^www\./, "")
        .split(".")[0]!
        .toLowerCase();
      if (prefix.length > 1) clusterTokens.add(prefix);
    }

    let overlap = 0;
    for (const tok of project.keywords) {
      if (clusterTokens.has(tok)) overlap += 1;
    }
    if (overlap < JACCARD_MIN_OVERLAP_TOKENS) continue;
    // Union size = |A| + |B| - |A ∩ B|. Avoids building the merged set.
    const union = project.keywords.size + clusterTokens.size - overlap;
    const ratio = overlap / union;
    if (ratio < JACCARD_MIN_RATIO) continue;
    if (!seen.has(cluster.slug)) {
      matches.push({ slug: cluster.slug, reason: "jaccard" });
      seen.add(cluster.slug);
    }
  }
  return matches;
}
