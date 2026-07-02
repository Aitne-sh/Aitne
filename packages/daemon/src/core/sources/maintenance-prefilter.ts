import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { CONTEXT_RELATIVE_PATHS } from "../context-paths.js";
import { unconsumedSignalsForSkill } from "../skill-curation/signals.js";

export interface SourceMaintenancePrefilterResult {
  /** Sources awaiting a card (`status='unfiled'`). */
  unfiledCount: number;
  /** Library↔vault mismatches: filed rows whose card file is missing,
   *  plus on-disk cards whose `source_id:` has no ledger row. */
  inconsistencyCount: number;
  /** Unconsumed skill-curation drift signals scoped to the `sources` skill. */
  driftSignalCount: number;
  shouldRun: boolean;
}

interface CountRow {
  n: number;
}

function countUnfiled(db: Database.Database): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM source_documents WHERE status = 'unfiled'`)
    .get() as CountRow;
  return row.n;
}

function collectCardFiles(sourcesDir: string): string[] {
  // Cards live at most one collection level deep; a shallow two-level walk
  // (no recursion) keeps this pass O(cards) with no YAML parsing.
  const files: string[] = [];
  for (const entry of readdirSync(sourcesDir)) {
    if (entry.startsWith(".")) continue;
    const abs = join(sourcesDir, entry);
    const stat = statSync(abs);
    if (stat.isFile() && entry.endsWith(".md") && entry !== "_index.md") {
      files.push(abs);
    } else if (stat.isDirectory()) {
      for (const nested of readdirSync(abs)) {
        if (nested.endsWith(".md") && nested !== "_index.md") {
          files.push(join(abs, nested));
        }
      }
    }
  }
  return files;
}

function extractSourceId(cardAbsPath: string): string | null {
  // Line-scan the frontmatter head for `source_id: src_…` — no YAML parse.
  const head = readFileSync(cardAbsPath, "utf-8").slice(0, 2048);
  const match = /^source_id:\s*(\S+)\s*$/m.exec(head);
  return match ? match[1] : null;
}

function countInconsistencies(
  db: Database.Database,
  contextDir: string,
): number {
  let count = 0;

  // Leg 1 — filed ledger rows whose bound card no longer exists on disk.
  const filed = db
    .prepare(
      `SELECT card_path FROM source_documents
       WHERE status = 'filed' AND card_path IS NOT NULL`,
    )
    .all() as Array<{ card_path: string }>;
  for (const row of filed) {
    if (!existsSync(join(contextDir, row.card_path))) count += 1;
  }

  // Leg 2 — on-disk cards whose source_id has no ledger row (or none at all).
  const sourcesDir = join(contextDir, CONTEXT_RELATIVE_PATHS.sources.dir);
  if (existsSync(sourcesDir)) {
    const exists = db.prepare(
      `SELECT 1 FROM source_documents WHERE id = ?`,
    );
    for (const cardPath of collectCardFiles(sourcesDir)) {
      const sourceId = extractSourceId(cardPath);
      if (!sourceId || !exists.get(sourceId)) count += 1;
    }
  }

  return count;
}

/**
 * No-LLM prefilter for the weekly `source-librarian` firing
 * (SOURCE_LIBRARY_DESIGN.md). The scheduler calls this before
 * `emitRoutine("source_maintenance")` and skips the whole LLM session
 * when there is provably nothing to do — zero unfiled sources, zero
 * library↔vault inconsistencies, and no unconsumed taxonomy-drift
 * signals against the `sources` skill.
 *
 * Fail-open by design: any unexpected error (missing table mid-upgrade,
 * unreadable vault) returns `shouldRun: true` so a broken prefilter can
 * never silently starve maintenance — mirrors the conservative default
 * of the manifest predicates.
 */
export function evaluateSourceMaintenancePrefilter(
  db: Database.Database,
  contextDir: string,
): SourceMaintenancePrefilterResult {
  try {
    const unfiledCount = countUnfiled(db);
    const inconsistencyCount = countInconsistencies(db, contextDir);
    const driftSignalCount = unconsumedSignalsForSkill(db, "sources").length;
    return {
      unfiledCount,
      inconsistencyCount,
      driftSignalCount,
      shouldRun:
        unfiledCount > 0 || inconsistencyCount > 0 || driftSignalCount > 0,
    };
  } catch {
    return {
      unfiledCount: -1,
      inconsistencyCount: -1,
      driftSignalCount: -1,
      shouldRun: true,
    };
  }
}
