import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, relative } from "node:path";

/**
 * Existing-vault import probe — WIKI_BUILDER_DESIGN.md §7.
 *
 * Called by the setup wizard against a candidate `external` mode root
 * path BEFORE the workspace row is created. The probe is read-only:
 * it never modifies files on disk. Its job is to classify the vault
 * (empty, partial-LLM-Wiki, full-LLM-Wiki, foreign) and surface the
 * data the wizard needs to render the Adopt / Migrate / Split choice.
 *
 * Contract:
 * - Returns `kind: "empty"` when the root has no markdown files under any
 *   of the layered directories. The wizard then offers "Initialise empty
 *   vault" rather than the Adopt/Migrate/Split branching.
 * - Returns `kind: "partial"` when fewer than two of the canonical layer
 *   directories exist. The wizard nudges the owner to inspect the dir
 *   before continuing — likely a foreign vault we should not touch.
 * - Returns `kind: "wiki"` when two or more layer directories exist. The
 *   wizard then surfaces the schema/layout deltas and the Adopt /
 *   Migrate / Split decision.
 *
 * The probe deliberately rejects layouts where any layer directory is a
 * symlink — refusing the import is the safe default and matches the
 * defensive posture taken by `writeFileAtomically`.
 */

export type WikiImportKind = "empty" | "partial" | "wiki";

const LAYER_DIRS = ["00_inbox", "10_raw", "20_wiki", "30_outputs", "90_meta"] as const;
type LayerDir = (typeof LAYER_DIRS)[number];

const EXPECTED_SCHEMAS: Record<"raw" | "wiki" | "output", string[]> = {
  raw: ["title", "url", "captured_at", "type", "tags"],
  wiki: ["title", "type", "status", "tags", "source", "created"],
  output: ["title", "type", "generated_at", "sources", "tags"],
};

export interface LayerInventory {
  dir: LayerDir;
  exists: boolean;
  isSymlink: boolean;
  fileCount: number;
  subdirectories: string[];
  lastModifiedAt: string | null;
}

export interface SchemaDelta {
  schema: "raw" | "wiki" | "output";
  present: boolean;
  expectedKeys: string[];
  foundKeys: string[];
  missingKeys: string[];
  extraKeys: string[];
}

export interface WikiImportProbeResult {
  rootPath: string;
  kind: WikiImportKind;
  layers: LayerInventory[];
  schemas: SchemaDelta[];
  /**
   * Top values of the `type:` frontmatter property across the vault.
   * Used by the wizard to preview the existing taxonomy.
   */
  topTypes: Array<{ value: string; count: number }>;
  /**
   * Detected nested layout (e.g. `20_wiki/concepts/`). Aitne is flat;
   * the wizard offers to flatten as part of Migrate mode.
   */
  unexpectedSubdirectories: Array<{ layer: LayerDir; subdir: string }>;
  /** Whether `90_meta/taxonomy.md` exists. */
  taxonomyPresent: boolean;
  /** Whether `20_wiki/_index.md` exists. */
  indexPresent: boolean;
  /** Whether the root is a git repository (used by the precompile gate). */
  isGitRepo: boolean;
}

export function probeExistingWikiVault(rootPath: string): WikiImportProbeResult {
  const layers: LayerInventory[] = LAYER_DIRS.map((dir) =>
    inventoryLayer(rootPath, dir),
  );
  const existingLayerCount = layers.filter((layer) => layer.exists).length;

  let kind: WikiImportKind = "empty";
  if (existingLayerCount >= 2) {
    kind = "wiki";
  } else if (existingLayerCount === 1) {
    kind = hasMarkdownFiles(rootPath) ? "partial" : "empty";
  } else if (hasMarkdownFiles(rootPath)) {
    kind = "partial";
  }

  const schemas = computeSchemaDeltas(rootPath);
  const topTypes = collectTopTypeValues(rootPath, layers);
  const unexpectedSubdirectories = layers.flatMap((layer) =>
    layer.subdirectories
      .filter((sub) => !isExpectedSubdir(layer.dir, sub))
      .map((sub) => ({ layer: layer.dir, subdir: sub })),
  );

  return {
    rootPath,
    kind,
    layers,
    schemas,
    topTypes,
    unexpectedSubdirectories,
    taxonomyPresent: existsAsFile(join(rootPath, "90_meta/taxonomy.md")),
    indexPresent: existsAsFile(join(rootPath, "20_wiki/_index.md")),
    isGitRepo: isGitRepository(rootPath),
  };
}

function inventoryLayer(rootPath: string, dir: LayerDir): LayerInventory {
  const full = join(rootPath, dir);
  if (!existsSync(full)) {
    return {
      dir,
      exists: false,
      isSymlink: false,
      fileCount: 0,
      subdirectories: [],
      lastModifiedAt: null,
    };
  }
  // `lstatSync` does NOT follow symlinks; `statSync` does. The probe
  // needs the symlink-itself state so the wizard can flag a layer-dir
  // symlink (§7 — refusing the import is the safe default).
  let lstat;
  try {
    lstat = lstatSync(full);
  } catch {
    return {
      dir,
      exists: false,
      isSymlink: false,
      fileCount: 0,
      subdirectories: [],
      lastModifiedAt: null,
    };
  }
  let lastModifiedAt: string | null = null;
  let fileCount = 0;
  const subdirectories: string[] = [];
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    const childPath = join(full, entry.name);
    if (entry.isDirectory()) {
      subdirectories.push(entry.name);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      fileCount += 1;
      try {
        const childStat = statSync(childPath);
        const iso = childStat.mtime.toISOString();
        if (!lastModifiedAt || iso > lastModifiedAt) lastModifiedAt = iso;
      } catch {
        /* skip unreadable file */
      }
    }
  }
  return {
    dir,
    exists: true,
    isSymlink: lstat.isSymbolicLink(),
    fileCount,
    subdirectories: subdirectories.sort(),
    lastModifiedAt,
  };
}

function hasMarkdownFiles(rootPath: string): boolean {
  if (!existsSync(rootPath)) return false;
  for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) return true;
  }
  return false;
}

function computeSchemaDeltas(rootPath: string): SchemaDelta[] {
  return (Object.keys(EXPECTED_SCHEMAS) as Array<keyof typeof EXPECTED_SCHEMAS>).map(
    (schema) => {
      const path = join(rootPath, `90_meta/schemas/${schema}.md`);
      if (!existsAsFile(path)) {
        return {
          schema,
          present: false,
          expectedKeys: EXPECTED_SCHEMAS[schema],
          foundKeys: [],
          missingKeys: EXPECTED_SCHEMAS[schema],
          extraKeys: [],
        };
      }
      const content = readFileSafely(path);
      const found = extractFrontmatterKeys(content);
      const expected = EXPECTED_SCHEMAS[schema];
      return {
        schema,
        present: true,
        expectedKeys: expected,
        foundKeys: found,
        missingKeys: expected.filter((key) => !found.includes(key)),
        extraKeys: found.filter((key) => !expected.includes(key)),
      };
    },
  );
}

function collectTopTypeValues(
  rootPath: string,
  layers: LayerInventory[],
): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const layer of layers) {
    if (!layer.exists) continue;
    const dir = join(rootPath, layer.dir);
    for (const file of walkMarkdown(dir)) {
      const text = readFileSafely(file);
      const value = extractFrontmatterValue(text, "type");
      if (!value) continue;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 20)
    .map(([value, count]) => ({ value, count }));
}

function isExpectedSubdir(layer: LayerDir, sub: string): boolean {
  if (layer === "10_raw") return sub === "images";
  if (layer === "90_meta") return sub === "schemas" || sub === "health";
  return false;
}

function existsAsFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function readFileSafely(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function isGitRepository(rootPath: string): boolean {
  const gitDir = join(rootPath, ".git");
  if (!existsSync(gitDir)) return false;
  try {
    const stat = statSync(gitDir);
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

const FRONTMATTER_DELIMITER = "---";

export function extractFrontmatter(content: string): Record<string, string> | null {
  if (!content.startsWith(FRONTMATTER_DELIMITER)) return null;
  const lines = content.split(/\r?\n/);
  if (lines[0] !== FRONTMATTER_DELIMITER) return null;
  const endIdx = lines.findIndex((line, idx) => idx > 0 && line === FRONTMATTER_DELIMITER);
  if (endIdx < 0) return null;
  const map: Record<string, string> = {};
  for (let i = 1; i < endIdx; i += 1) {
    const raw = lines[i];
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    // We only support flat scalar `key: value` lines — Bases-era schema (§2.4).
    const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(raw);
    if (!match) continue;
    const [, key, valueRaw] = match;
    map[key] = valueRaw.trim();
  }
  return map;
}

function extractFrontmatterKeys(content: string): string[] {
  const fm = extractFrontmatter(content);
  return fm ? Object.keys(fm) : [];
}

function extractFrontmatterValue(content: string, key: string): string | null {
  const fm = extractFrontmatter(content);
  if (!fm) return null;
  const value = fm[key];
  if (!value) return null;
  // Strip surrounding quotes if present.
  return value.replace(/^['"]|['"]$/g, "").trim();
}

function* walkMarkdown(rootDir: string): Generator<string> {
  if (!existsSync(rootDir)) return;
  let entries;
  try {
    entries = readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      yield* walkMarkdown(full);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      yield full;
    }
  }
}

export function formatProbeRelativePath(rootPath: string, abs: string): string {
  return relative(rootPath, abs).split(/[\\/]/).join("/");
}
