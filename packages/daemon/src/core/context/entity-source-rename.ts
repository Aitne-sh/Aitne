import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { AgentWriteTracker } from "../../safety/agent-write-tracker.js";
import { writeFileAtomically } from "../atomic-write.js";
import { createLogger } from "../../logging.js";

const logger = createLogger("entity-source-rename");

/**
 * Entity-file rewriter for `management_task.app_renamed` consumers
 * (docs/design/21-management-registry-and-entities.md §12, "Failure
 * modes & recovery"; followups doc Issue 2 prerequisite).
 *
 * The DB-side rename mutates `managed_tasks.app` atomically. Without
 * this rewriter, every entity file's `frontmatter.sources.<oldKey>`
 * stays pointing at the now-deleted label — silently orphaning the
 * §7.6 lookup contract for the renamed app.
 *
 * Match semantics — case-insensitive, single-variant per file:
 *
 *   - SQL: enumerate entity paths via `entity_source_keys.source_key_
 *     normalized = LOWER(:oldKey)`. This catches every casing variant
 *     (`zoom`, `Zoom`, `ZOOM`) the entity-mirror has ever indexed.
 *   - Per file: scan the frontmatter `sources:` block for any key whose
 *     lower-cased form matches `LOWER(oldKey)`. The chosen rewrite
 *     target is the FIRST such match (for byte-determinism and to keep
 *     the rewriter idempotent across reruns).
 *   - When a single file holds **multiple** casing variants of `oldKey`
 *     (e.g. both `sources.zoom` and `sources.ZOOM`), the rewriter
 *     SKIPS the file with `skippedMultipleVariants`. Renaming all of
 *     them to `newKey` would produce a duplicate-key YAML, and merging
 *     their inner records is hard to do safely without surprising the
 *     user. Manual reconciliation is the right escape hatch.
 *   - When `<newKey>` (exact case) already exists in the file alongside
 *     the matched old key, the rewriter SKIPS with `skippedNewKeyExists`
 *     for the same merge-safety reason.
 *
 * The frontmatter pass is line-based (mirroring entity-mirror.ts's
 * parser) — no full YAML round-trip. The trade-off: comments,
 * anchors, and unusual quoting in the rest of the frontmatter are
 * untouched (they don't intersect with the `sources:` block).
 */

const FRONTMATTER_FENCE = /^---\s*$/;

export type RenameOutcome =
  | { kind: "rewrote"; body: string }
  | { kind: "old_key_missing" }
  | { kind: "new_key_exists" }
  | { kind: "multiple_variants"; variants: string[] }
  | { kind: "no_frontmatter" };

/**
 * Rewrite a single entity-file body so its `frontmatter.sources.<X>`
 * line — where `LOWER(X) === LOWER(oldKey)` — is renamed to `<newKey>`.
 * Returns the new body verbatim; the caller writes it.
 */
export function renameFrontmatterSourceKey(
  body: string,
  oldKey: string,
  newKey: string,
): RenameOutcome {
  if (oldKey === newKey) return { kind: "old_key_missing" };
  const oldNormalized = oldKey.toLowerCase();
  const normalized = body.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  // `String.split('\n')` always returns at least one element, so
  // `lines.length === 0` is unreachable and `lines[0] ?? ""` never
  // triggers its fallback. The defensive guards keep the type-narrowing
  // honest for downstream readers but cannot be hit at runtime.
  /* c8 ignore next */
  if (lines.length === 0 || !FRONTMATTER_FENCE.test(lines[0] ?? "")) {
    return { kind: "no_frontmatter" };
  }
  const closeIdx = lines.findIndex(
    (line, idx) => idx > 0 && FRONTMATTER_FENCE.test(line),
  );
  if (closeIdx < 0) return { kind: "no_frontmatter" };

  let inSourcesBlock = false;
  const matchedKeyLines: { lineIdx: number; key: string }[] = [];
  let newKeyExistsExact = false;

  // Walk frontmatter lines, tracking the `sources:` block boundary.
  // Top-level keys always start in column 0; child keys under `sources:`
  // sit at 2-space indent. Anything deeper than 2 spaces is a field
  // under a source — we skip those.
  for (let i = 1; i < closeIdx; i++) {
    const line = lines[i];
    if (line === "" || /^\s*#/.test(line)) continue;
    if (!/^\s/.test(line)) {
      const topMatch = /^([A-Za-z0-9_-]+)\s*:/.exec(line);
      inSourcesBlock = topMatch?.[1] === "sources";
      continue;
    }
    if (!inSourcesBlock) continue;
    // `line` reached this point via `/^\s/.test(line)` above, so the
    // leading-whitespace regex always matches; the `?? 0` fallback is
    // defensive only.
    /* c8 ignore next */
    const indent = line.match(/^\s+/)?.[0].length ?? 0;
    if (indent !== 2) continue;
    const keyName = parseChildKey(line);
    if (keyName === null) continue;
    if (keyName === newKey) newKeyExistsExact = true;
    if (keyName.toLowerCase() === oldNormalized) {
      matchedKeyLines.push({ lineIdx: i, key: keyName });
    }
  }

  if (matchedKeyLines.length === 0) return { kind: "old_key_missing" };
  // Multiple casing variants in the same file (`zoom` and `ZOOM`) —
  // renaming both would collide. Surface for manual reconciliation.
  if (matchedKeyLines.length > 1) {
    return {
      kind: "multiple_variants",
      variants: matchedKeyLines.map((m) => m.key),
    };
  }
  // The exact target case already exists — refuse to merge two records
  // even when one of them is the matched old key. The user can resolve
  // by deleting the duplicate manually before retrying the rename.
  if (newKeyExistsExact) return { kind: "new_key_exists" };

  // Rewrite the matched line. Preserve everything after the key colon
  // (the inline value form `zoom: zm_xyz` keeps its value; the empty
  // `zoom:` form remains an empty record marker for the children below).
  const target = lines[matchedKeyLines[0].lineIdx];
  const m = /^( {2})("?'?)([^:]+?)\2(\s*:.*)$/.exec(target);
  /* c8 ignore start — `m` is guaranteed truthy here: the same pattern
     matched in the walk above; defensive guard only. */
  if (!m) return { kind: "old_key_missing" };
  /* c8 ignore stop */
  lines[matchedKeyLines[0].lineIdx] =
    `${m[1]}${quoteIfNeeded(newKey)}${m[4]}`;
  return { kind: "rewrote", body: lines.join("\n") };
}

function parseChildKey(line: string): string | null {
  const match = /^ {2}("?'?)([^:]+?)\1\s*:/.exec(line);
  if (!match) return null;
  return match[2].trim();
}

/**
 * Quote a YAML key when it contains characters that would break the
 * `key:` form (whitespace, colons, hashes, leading dashes). The entity-
 * mirror's `stripQuotes` helper handles double + single quotes
 * symmetrically; we always emit double quotes here for determinism.
 */
function quoteIfNeeded(key: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(key)) return key;
  return `"${key.replace(/"/g, '\\"')}"`;
}

// ── Filesystem driver ─────────────────────────────────────────────────────

export interface RewriteResult {
  /** Files whose frontmatter was rewritten and re-saved. */
  rewrote: string[];
  /** Files where `<newKey>` already existed — manual resolution needed. */
  skippedNewKeyExists: string[];
  /** Files where multiple casing variants of `oldKey` co-exist. */
  skippedMultipleVariants: { path: string; variants: string[] }[];
  /** Files where `<oldKey>` was absent (e.g. mirror lag); informational. */
  skippedOldKeyMissing: string[];
  /** Read / parse / write errors keyed by the offending path. */
  errors: { path: string; reason: string }[];
}

export interface RewriteEntitySourceRenameDeps {
  db: Database.Database;
  contextDir: string;
  oldKey: string;
  newKey: string;
  writeTracker?: AgentWriteTracker;
}

/**
 * Walk every entity file referencing `oldKey` — via the
 * `entity_source_keys` mirror's normalized index — and rewrite its
 * frontmatter to use `newKey` instead. Casing variants (`zoom`, `Zoom`,
 * `ZOOM`) all surface; the rewriter rewrites the canonical first
 * single-variant case and SKIPS files whose multi-variant frontmatter
 * would collide.
 *
 * Failures are isolated per-file: a single read/write error doesn't
 * abort the whole rename. The result enumerates each outcome so the
 * caller can append it to the audit row and the dashboard's history
 * surface.
 */
export async function rewriteEntityFilesForSourceRename(
  deps: RewriteEntitySourceRenameDeps,
): Promise<RewriteResult> {
  const result: RewriteResult = {
    rewrote: [],
    skippedNewKeyExists: [],
    skippedMultipleVariants: [],
    skippedOldKeyMissing: [],
    errors: [],
  };
  if (deps.oldKey === deps.newKey) return result;

  // Use the normalized generated column so case variants of the old
  // label all surface. The activity-view runner already keys on this
  // index; staying consistent with it avoids one-off SQL drift.
  const rows = deps.db
    .prepare(
      "SELECT DISTINCT path FROM entity_source_keys WHERE source_key_normalized = ? ORDER BY path ASC",
    )
    .all(deps.oldKey.toLowerCase()) as { path: string }[];

  for (const row of rows) {
    const absolute = join(deps.contextDir, row.path);
    let body: string;
    try {
      body = await readFile(absolute, "utf-8");
    } catch (err) {
      // The `?? "read_error"` fallback fires only when the rejection
      // has no `.code` field. Node's fs/promises.readFile always
      // rejects with a NodeJS.ErrnoException whose `.code` is set, so
      // the fallback is genuinely unreachable in production. Vitest's
      // ESM-namespace immutability also blocks `vi.spyOn` on
      // fs/promises, so we accept the unreachable arm.
      /* c8 ignore next */
      const reason = (err as NodeJS.ErrnoException).code ?? "read_error";
      result.errors.push({ path: row.path, reason });
      continue;
    }
    const outcome = renameFrontmatterSourceKey(body, deps.oldKey, deps.newKey);
    switch (outcome.kind) {
      case "rewrote":
        try {
          // Mark before the rename so FS-watch consumers attribute the
          // resulting event to the agent. Roll back on failure (C2).
          deps.writeTracker?.markWriting(absolute, outcome.body);
          try {
            writeFileAtomically(absolute, outcome.body);
          } catch (writeErr) {
            deps.writeTracker?.unmark(absolute);
            throw writeErr;
          }
          result.rewrote.push(row.path);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          result.errors.push({ path: row.path, reason });
        }
        break;
      case "new_key_exists":
        result.skippedNewKeyExists.push(row.path);
        break;
      case "multiple_variants":
        result.skippedMultipleVariants.push({
          path: row.path,
          variants: outcome.variants,
        });
        break;
      case "old_key_missing":
      case "no_frontmatter":
        // Mirror lag — the sidecar row points at a key that no longer
        // resides in the file. Surface it but don't error: the entity-
        // mirror's chokidar watcher converges on the next file write.
        result.skippedOldKeyMissing.push(row.path);
        break;
    }
  }

  if (
    result.rewrote.length > 0 ||
    result.skippedNewKeyExists.length > 0 ||
    result.skippedMultipleVariants.length > 0 ||
    result.errors.length > 0
  ) {
    logger.info(
      {
        oldKey: deps.oldKey,
        newKey: deps.newKey,
        rewrote: result.rewrote.length,
        skippedNewKeyExists: result.skippedNewKeyExists.length,
        skippedMultipleVariants: result.skippedMultipleVariants.length,
        skippedOldKeyMissing: result.skippedOldKeyMissing.length,
        errors: result.errors.length,
      },
      "entity-source-rename: completed",
    );
  }

  return result;
}
