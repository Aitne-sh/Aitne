import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { writeFileAtomically } from "../atomic-write.js";
import { extractFrontmatter } from "./import-probe.js";

/**
 * Import-migrate — WIKI_BUILDER_DESIGN.md §7 (Migrate branch).
 *
 * Two-step operation:
 *   1. `planImportMigration(rootPath)` — pure inspection. Returns the list
 *      of files that would be rewritten, the frontmatter-key mappings,
 *      and the subdirectory flattening moves. **Never touches disk.**
 *      The dashboard renders the plan as the user-facing preview.
 *   2. `applyImportMigration(rootPath, plan, opts)` — executes the plan.
 *      Always writes a sibling backup mirror under
 *      `90_meta/health/pre-migrate-<date>/` before touching any file
 *      (the per-vault `git` backup is layered on top by §P2.E for git
 *      vaults; this mirror is the always-available recovery surface for
 *      non-git vaults).
 *
 * Migrations supported in P2:
 *   - Flatten type-based subdirectories under `20_wiki/<type>/<slug>.md`
 *     → `20_wiki/<slug>.md`, preserving the `type:` frontmatter (which
 *     stays the discriminator, per §2.4 Bases-era convention).
 *   - Flatten subdirectories under `10_raw/<topic>/<slug>.md` →
 *     `10_raw/<slug>.md`. The `images/<slug>/` subdirectory is the only
 *     permitted nested layout (§2.3) and is preserved as-is.
 *   - Frontmatter key rename for any keys that map cleanly between the
 *     two schema flavours. Unknown keys are passed through untouched —
 *     `wiki.lint` is the long-term enforcer; the migration is a one-shot
 *     best effort.
 *
 * Slug collisions during flattening are reported in the plan as
 * `conflicts` and the migration refuses to apply until the wizard
 * surfaces them and the operator chooses how to resolve.
 *
 * **Known limitation — iCloud-sandboxed external vaults**: this module
 * uses `renameSync` and direct `writeFileAtomically` for moves and
 * rewrites. Both fail with EPERM on iCloud-sandboxed paths, and the
 * Obsidian CLI (which the runtime write path falls back to for normal
 * file writes) does not expose a `rename` primitive — there is no
 * equivalent fallback to route a move through. Callers running the
 * import flow against an iCloud vault must temporarily relocate it
 * outside the sandbox, run the migration, and move it back. The wizard
 * surfaces this in the troubleshooting guide; the API call itself just
 * propagates the EPERM upstream.
 */

const KEY_RENAMES_RAW: Record<string, string> = {
  // Common renames observed in pre-Aitne LLM-wiki implementations.
  source_url: "url",
  retrieved_at: "captured_at",
  fetched_at: "captured_at",
};

const KEY_RENAMES_WIKI: Record<string, string> = {
  topic: "title",
  kind: "type",
  state: "status",
  last_compiled: "compiled_at",
};

const KEY_RENAMES_OUTPUT: Record<string, string> = {
  asked_at: "generated_at",
  refs: "sources",
  answer_to: "question",
};

export interface FrontmatterMigration {
  path: string;
  renames: Array<{ from: string; to: string }>;
}

export interface FlattenMove {
  fromRelPath: string;
  toRelPath: string;
}

export interface SlugConflict {
  layer: "10_raw" | "20_wiki";
  slug: string;
  paths: string[];
}

export interface WikiImportMigrationPlan {
  rootPath: string;
  frontmatterMigrations: FrontmatterMigration[];
  flattenMoves: FlattenMove[];
  conflicts: SlugConflict[];
  estimatedBackupBytes: number;
  generatedAtIso: string;
}

export interface ApplyImportMigrationResult {
  backupDir: string;
  filesWritten: number;
  filesMoved: number;
}

export function planImportMigration(rootPath: string): WikiImportMigrationPlan {
  const flattenMoves: FlattenMove[] = [];
  const conflicts: SlugConflict[] = [];

  collectFlattenMoves(rootPath, "20_wiki", flattenMoves, conflicts);
  collectFlattenMoves(rootPath, "10_raw", flattenMoves, conflicts);

  const frontmatterMigrations = collectFrontmatterMigrations(
    rootPath,
    flattenMoves,
  );
  const estimatedBackupBytes =
    estimateBytes(
      rootPath,
      flattenMoves.map((move) => move.fromRelPath),
    ) +
    estimateBytes(
      rootPath,
      frontmatterMigrations.map((m) => m.path),
    );

  return {
    rootPath,
    frontmatterMigrations,
    flattenMoves,
    conflicts,
    estimatedBackupBytes,
    generatedAtIso: new Date().toISOString(),
  };
}

export interface ApplyMigrationOptions {
  /** ISO date used to name the backup directory. */
  dateStamp?: string;
  /** Skip the conflict guard. Use only when the wizard explicitly chose to overwrite. */
  allowConflicts?: boolean;
}

export function applyImportMigration(
  plan: WikiImportMigrationPlan,
  options: ApplyMigrationOptions = {},
): ApplyImportMigrationResult {
  if (plan.conflicts.length > 0 && !options.allowConflicts) {
    throw Object.assign(
      new Error(
        `import-migrate: ${plan.conflicts.length} slug collision(s) detected — resolve them in the wizard before applying.`,
      ),
      { code: "EWIKI_IMPORT_CONFLICT" },
    );
  }
  const dateStamp = options.dateStamp ?? new Date().toISOString().slice(0, 10);
  const backupDir = join(plan.rootPath, "90_meta", "health", `pre-migrate-${dateStamp}`);
  mkdirSync(backupDir, { recursive: true });

  let filesWritten = 0;
  let filesMoved = 0;

  for (const move of plan.flattenMoves) {
    const from = join(plan.rootPath, move.fromRelPath);
    const to = join(plan.rootPath, move.toRelPath);
    backupFile(plan.rootPath, move.fromRelPath, backupDir);
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    filesMoved += 1;
  }

  for (const migration of plan.frontmatterMigrations) {
    const fullPath = join(plan.rootPath, migration.path);
    backupFile(plan.rootPath, migration.path, backupDir);
    const original = readFileSafely(fullPath);
    const rewritten = applyFrontmatterRenames(original, migration.renames);
    if (rewritten !== original) {
      writeFileAtomically(fullPath, rewritten);
      filesWritten += 1;
    }
  }

  writeImportReport(plan.rootPath, dateStamp, plan, {
    filesWritten,
    filesMoved,
    backupDir,
  });

  return { backupDir, filesWritten, filesMoved };
}

function collectFlattenMoves(
  rootPath: string,
  layer: "10_raw" | "20_wiki",
  moves: FlattenMove[],
  conflicts: SlugConflict[],
): void {
  const dir = join(rootPath, layer);
  if (!existsSync(dir)) return;
  const seenSlugs = new Map<string, string[]>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (layer === "10_raw" && entry.name === "images") continue;
    const subPath = join(dir, entry.name);
    for (const md of readMarkdownChildren(subPath)) {
      const fromRel = `${layer}/${entry.name}/${md}`;
      const toRel = `${layer}/${md}`;
      moves.push({ fromRelPath: fromRel, toRelPath: toRel });
      const existing = seenSlugs.get(toRel) ?? [];
      existing.push(fromRel);
      seenSlugs.set(toRel, existing);
    }
  }
  // Any slug also living at the layer root would conflict with a move.
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const rootRel = `${layer}/${entry.name}`;
    if (seenSlugs.has(rootRel)) {
      seenSlugs.get(rootRel)?.push(rootRel);
    }
  }
  for (const [toRel, sources] of seenSlugs) {
    if (sources.length > 1) {
      conflicts.push({
        layer,
        slug: toRel.split("/").pop() ?? toRel,
        paths: sources,
      });
    }
  }
}

function* readMarkdownChildren(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      yield entry.name;
    }
  }
}

function collectFrontmatterMigrations(
  rootPath: string,
  moves: FlattenMove[],
): FrontmatterMigration[] {
  const out: FrontmatterMigration[] = [];
  const moveByFrom = new Map(moves.map((move) => [move.fromRelPath, move.toRelPath]));
  for (const layer of ["10_raw", "20_wiki", "30_outputs"] as const) {
    const dir = join(rootPath, layer);
    if (!existsSync(dir)) continue;
    const renameMap = renameMapForLayer(layer);
    // Inspect the file at its *current* on-disk location so the
    // frontmatter scan sees real bytes. The recorded `path` in the
    // returned plan is the post-flatten location — that is where the
    // rewrite step will look after `renameSync` has run.
    for (const currentAbs of iterateLayerMarkdownOnDisk(rootPath, layer)) {
      const content = readFileSafely(currentAbs);
      const fm = extractFrontmatter(content);
      if (!fm) continue;
      const renames: Array<{ from: string; to: string }> = [];
      for (const [from, to] of Object.entries(renameMap)) {
        if (Object.prototype.hasOwnProperty.call(fm, from)) {
          renames.push({ from, to });
        }
      }
      if (renames.length === 0) continue;
      const currentRel = relative(rootPath, currentAbs).split(/[\\/]/).join("/");
      const postMoveRel = moveByFrom.get(currentRel) ?? currentRel;
      out.push({ path: postMoveRel, renames });
    }
  }
  return out;
}

function* iterateLayerMarkdownOnDisk(
  rootPath: string,
  layer: "10_raw" | "20_wiki" | "30_outputs",
): Generator<string> {
  const dir = join(rootPath, layer);
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      yield join(dir, entry.name);
    } else if (entry.isDirectory()) {
      if (layer === "10_raw" && entry.name === "images") continue;
      const sub = join(dir, entry.name);
      for (const md of readdirSync(sub, { withFileTypes: true })) {
        if (md.isFile() && md.name.endsWith(".md")) {
          yield join(sub, md.name);
        }
      }
    }
  }
}

function renameMapForLayer(layer: "10_raw" | "20_wiki" | "30_outputs"): Record<string, string> {
  switch (layer) {
    case "10_raw":
      return KEY_RENAMES_RAW;
    case "20_wiki":
      return KEY_RENAMES_WIKI;
    case "30_outputs":
      return KEY_RENAMES_OUTPUT;
  }
}

function applyFrontmatterRenames(
  content: string,
  renames: Array<{ from: string; to: string }>,
): string {
  if (renames.length === 0) return content;
  const delim = "---";
  if (!content.startsWith(delim)) return content;
  const lines = content.split(/\r?\n/);
  const endIdx = lines.findIndex((line, idx) => idx > 0 && line === delim);
  if (endIdx < 0) return content;
  const renameByFrom = new Map(renames.map((r) => [r.from, r.to]));
  for (let i = 1; i < endIdx; i += 1) {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*)(\s*:\s*.*)$/.exec(lines[i]);
    if (!match) continue;
    const [, key, rest] = match;
    const replacement = renameByFrom.get(key);
    if (!replacement) continue;
    lines[i] = `${replacement}${rest}`;
  }
  return lines.join("\n");
}

function readFileSafely(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function estimateBytes(rootPath: string, relPaths: string[]): number {
  let total = 0;
  for (const rel of relPaths) {
    const full = join(rootPath, rel);
    try {
      total += statSync(full).size;
    } catch {
      /* skip — file already moved by an earlier step */
    }
  }
  return total;
}

function backupFile(rootPath: string, relPath: string, backupDir: string): void {
  const src = join(rootPath, relPath);
  if (!existsSync(src)) return;
  const dest = join(backupDir, relPath);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileAtomically(dest, readFileSync(src, "utf-8"));
}

function writeImportReport(
  rootPath: string,
  dateStamp: string,
  plan: WikiImportMigrationPlan,
  outcome: { filesWritten: number; filesMoved: number; backupDir: string },
): void {
  const reportPath = join(rootPath, "90_meta", "health", `import-${dateStamp}.md`);
  const lines = [
    `# Wiki Import Report — ${dateStamp}`,
    "",
    `- Generated: ${plan.generatedAtIso}`,
    `- Backup directory: \`${relative(rootPath, outcome.backupDir).split(/[\\/]/).join("/")}\``,
    `- Files written (frontmatter rewrite): ${outcome.filesWritten}`,
    `- Files moved (flatten): ${outcome.filesMoved}`,
    "",
    "## Frontmatter migrations",
    "",
    ...(plan.frontmatterMigrations.length === 0
      ? ["_None._"]
      : plan.frontmatterMigrations.map((m) =>
          `- \`${m.path}\` — ${m.renames
            .map((r) => `\`${r.from}\` → \`${r.to}\``)
            .join(", ")}`,
        )),
    "",
    "## Flatten moves",
    "",
    ...(plan.flattenMoves.length === 0
      ? ["_None._"]
      : plan.flattenMoves.map((m) =>
          `- \`${m.fromRelPath}\` → \`${m.toRelPath}\``,
        )),
    "",
    "## Slug conflicts (resolved during apply)",
    "",
    ...(plan.conflicts.length === 0
      ? ["_None._"]
      : plan.conflicts.map((c) =>
          `- ${c.layer} \`${c.slug}\` — ${c.paths.map((p) => `\`${p}\``).join(", ")}`,
        )),
    "",
  ];
  writeFileAtomically(reportPath, lines.join("\n"));
}
