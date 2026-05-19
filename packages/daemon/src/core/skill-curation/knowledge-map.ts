// P22 §3.3 + §4 walker — knowledge-map snapshot.
//
// Walks the live `getContextDir(config)` tree and returns a structural
// snapshot the optimizer agent can read AND the smoke test's
// `paths_resolve` / `sections_resolve` checks can validate against.
//
// Globs declared in a skill's `curation.json` `scope_paths` (e.g.
// `user/*.md`) are NOT pre-expanded here — callers do the expansion via
// `matchScopePath()`. The snapshot is a flat list of files, each with
// frontmatter + heading list in document order.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface SnapshotFile {
  path: string;                     // relative to contextDir, posix-style separators
  headings: string[];               // every "## " / "### " in document order, leading hashes stripped
  frontmatter: Record<string, unknown>;
  last_modified_at: number;         // ms since epoch
}

export interface KnowledgeMapSnapshot {
  context_dir: string;              // absolute path
  taken_at: number;
  files: SnapshotFile[];
}

const SKIP_DIRS = new Set([".git", "node_modules", ".obsidian", "history"]);

export function buildKnowledgeMap(contextDir: string): KnowledgeMapSnapshot {
  const files: SnapshotFile[] = [];
  if (existsSync(contextDir)) {
    walk(contextDir, contextDir, files);
  }
  return {
    context_dir: contextDir,
    taken_at: Date.now(),
    files,
  };
}

function walk(root: string, dir: string, out: SnapshotFile[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(root, full, out);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    let content: string;
    let mtime: number;
    try {
      content = readFileSync(full, "utf-8");
      mtime = statSync(full).mtimeMs;
    } catch {
      continue;
    }
    const rel = relative(root, full).split(/[\\/]/g).join("/");
    out.push({
      path: rel,
      headings: extractHeadings(content),
      frontmatter: extractFrontmatter(content),
      last_modified_at: mtime,
    });
  }
}

export function extractHeadings(md: string): string[] {
  const out: string[] = [];
  for (const line of md.split("\n")) {
    if (/^##{1,2}\s+/.test(line)) {
      out.push(line.replace(/^##{1,2}\s+/, "").trim());
    }
  }
  return out;
}

export function extractFrontmatter(md: string): Record<string, unknown> {
  if (!md.startsWith("---\n")) return {};
  const end = md.indexOf("\n---", 4);
  if (end === -1) return {};
  const block = md.slice(4, end);
  const out: Record<string, unknown> = {};
  for (const line of block.split("\n")) {
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = parseScalar(m[2].trim());
  }
  return out;
}

function parseScalar(value: string): unknown {
  if (value === "" || value === "~" || value === "null") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

/** Test whether `relativePath` matches one of `scopePaths` (a list of literal
 *  paths or glob patterns like `user/*.md`). Used by the structure-diff walker
 *  and the API's smoke-test `paths_resolve` check. */
export function matchScopePath(relativePath: string, scopePaths: string[]): boolean {
  const norm = relativePath.replace(/\\/g, "/");
  for (const sp of scopePaths) {
    if (sp === norm) return true;
    if (matchesGlob(norm, sp)) return true;
  }
  return false;
}

function matchesGlob(path: string, pattern: string): boolean {
  // Minimal glob: "/", "*", "**" — not full minimatch.
  // Translate to a regex that does not span `/` on `*` and does on `**`.
  const re = new RegExp(
    "^" +
      pattern
        .split("/")
        .map((segment) =>
          segment
            .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
            .replace(/\*\*/g, "::DOUBLESTAR::")
            .replace(/\*/g, "[^/]*")
            .replace(/::DOUBLESTAR::/g, ".*"),
        )
        .join("/") +
      "$",
  );
  return re.test(path);
}

/** Returns true when the snapshot contains a file matching the given path
 *  spec (literal or glob). */
export function snapshotMatchesPath(snapshot: KnowledgeMapSnapshot, pathSpec: string): boolean {
  if (pathSpec.includes("*")) {
    return snapshot.files.some((f) => matchScopePath(f.path, [pathSpec]));
  }
  return snapshot.files.some((f) => f.path === pathSpec);
}

/** Returns true when at least one file matching `pathSpec` contains a
 *  heading matching `sectionHeading` (compared after stripping leading `## `). */
export function snapshotMatchesSection(
  snapshot: KnowledgeMapSnapshot,
  pathSpec: string,
  sectionHeading: string,
): boolean {
  const target = sectionHeading.replace(/^##{1,2}\s+/, "").trim();
  for (const f of snapshot.files) {
    const ok = pathSpec.includes("*") ? matchScopePath(f.path, [pathSpec]) : f.path === pathSpec;
    if (!ok) continue;
    if (f.headings.some((h) => h === target)) return true;
  }
  return false;
}

export function filterSnapshotByScope(
  snapshot: KnowledgeMapSnapshot,
  scopePaths: string[],
): SnapshotFile[] {
  return snapshot.files.filter((f) => matchScopePath(f.path, scopePaths));
}
