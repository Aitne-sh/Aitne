import type Database from "better-sqlite3";
import { createLogger } from "../logging.js";
import {
  inferPathFlavor,
  isPathInsideOrEqual,
  slashPath,
  type PathFlavor,
} from "./path-compat.js";

const logger = createLogger("path-rewrite");

/**
 * Management Mode Phase 2 — rewrite every persisted absolute path that
 * pointed at the old primary context directory so it points at the new
 * one. Called inside the migration endpoint's single transaction AFTER
 * the filesystem move completes and BEFORE settings are updated, so a
 * failure here triggers full rollback (§6.6, §6.9).
 *
 * Phase 0 audit (§1.1) identified the following relevant stores:
 *   - `agent_actions.detail` — open-ended JSON; may contain absolute paths
 *     written by `POST /api/action/log` or future producers. Generic walk.
 *   - `observations.payload` — open-ended JSON; observer-specific. Obsidian
 *     watcher writes external-vault paths (not rewritten here), but other
 *     producers may write primary-context paths.
 *   - `md_file_snapshots.file_path` — logical keys like `today`,
 *     `rules/management`. Already relative; NOT rewritten (left as-is). // drift-allow
 *   - `messages.metadata` — currently unused at runtime but open-ended;
 *     generic walk for defense in depth.
 *   - `receipts.obsidian_path` — external vault relative path. NOT
 *     rewritten (the primary-store move doesn't affect the external vault).
 *
 * The walker is deliberately generic: any string value whose normalized
 * form starts with `oldPrefix + "/"` (or equals `oldPrefix`) is rewritten.
 * Anchoring on the segment boundary prevents false matches where
 * `oldPrefix = "/foo"` would incorrectly rewrite `/foobar/baz`.
 */

export interface RewriteStats {
  /** Rows the walker actually mutated. */
  rowsRewritten: number;
  /** Rows the walker parsed successfully but left unchanged. */
  rowsUnchanged: number;
  /** Rows the walker could not parse (likely legacy / corrupt JSON). */
  rowsUnparseable: number;
}

interface RewriteTarget {
  table: string;
  idCol: string;
  jsonCol: string;
}

const DEFAULT_TARGETS: RewriteTarget[] = [
  { table: "agent_actions", idCol: "id", jsonCol: "detail" },
  { table: "observations", idCol: "id", jsonCol: "payload" },
  { table: "messages", idCol: "id", jsonCol: "metadata" },
];

/**
 * Walk an arbitrary JSON value and return a new copy with every string
 * that sits under `oldPrefix` rewritten to sit under `newPrefix`.
 * Returns the original reference when nothing changed so callers can
 * detect no-op rewrites without a deep compare.
 */
export function rewriteJsonPaths(
  value: unknown,
  oldPrefix: string,
  newPrefix: string,
): { value: unknown; changed: boolean } {
  const flavor = inferPathFlavor(oldPrefix, newPrefix);
  const oldCompare = normalizeForPathRewrite(oldPrefix, flavor);
  const newBase = trimPathRewriteSeparators(newPrefix);

  function rewrite(node: unknown): { value: unknown; changed: boolean } {
    if (typeof node === "string") {
      const nodeCompare = normalizeForPathRewrite(node, flavor);
      if (nodeCompare === oldCompare) {
        return { value: newPrefix, changed: true };
      }
      if (isPathInsideOrEqual(oldCompare, nodeCompare, flavor)) {
        const remainder = node.slice(oldPrefix.length);
        const trimmedRemainder = remainder.replace(/^[\\/]+/, "");
        const separator = separatorForNewPrefix(newPrefix, flavor);
        const tail = separator === "\\"
          ? trimmedRemainder.replace(/[\\/]+/g, "\\")
          : slashPath(trimmedRemainder);
        return {
          value: trimmedRemainder
            ? `${newBase}${separator}${tail}`
            : newPrefix,
          changed: true,
        };
      }
      return { value: node, changed: false };
    }
    if (Array.isArray(node)) {
      let anyChanged = false;
      const out = node.map((item) => {
        const r = rewrite(item);
        if (r.changed) anyChanged = true;
        return r.value;
      });
      return anyChanged ? { value: out, changed: true } : { value: node, changed: false };
    }
    if (node && typeof node === "object") {
      let anyChanged = false;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        const r = rewrite(v);
        if (r.changed) anyChanged = true;
        out[k] = r.value;
      }
      return anyChanged ? { value: out, changed: true } : { value: node, changed: false };
    }
    return { value: node, changed: false };
  }

  return rewrite(value);
}

function normalizeForPathRewrite(value: string, flavor: PathFlavor): string {
  return flavor === "win32" ? slashPath(value).toLowerCase() : value;
}

function trimPathRewriteSeparators(value: string): string {
  const rootMatch = /^[A-Za-z]:[\\/]?$/.exec(value) ?? /^[/\\]+$/.exec(value);
  if (rootMatch) return value;
  return value.replace(/[\\/]+$/, "");
}

function separatorForNewPrefix(newPrefix: string, flavor: PathFlavor): string {
  if (newPrefix.includes("\\")) return "\\";
  if (newPrefix.includes("/")) return "/";
  return flavor === "win32" ? "\\" : "/";
}

/**
 * Run the JSON rewrite over every row of every configured table.
 * Executes as a single DB transaction so a failure in the middle
 * reverts the entire pass — callers that have already moved files on
 * disk at this point should restore from backup and bail.
 */
export function rewritePathsInDb(
  db: Database.Database,
  oldPrefix: string,
  newPrefix: string,
  targets: RewriteTarget[] = DEFAULT_TARGETS,
): RewriteStats {
  const stats: RewriteStats = {
    rowsRewritten: 0,
    rowsUnchanged: 0,
    rowsUnparseable: 0,
  };
  const isSamePrefix = oldPrefix === newPrefix;
  if (isSamePrefix) {
    logger.debug("rewritePathsInDb: old and new prefixes identical — noop");
    return stats;
  }

  const tx = db.transaction(() => {
    for (const target of targets) {
      // Missing tables in freshly-seeded test DBs are non-fatal.
      const tableExists = db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get(target.table);
      if (!tableExists) {
        logger.debug({ target }, "rewritePathsInDb: table missing, skipping");
        continue;
      }
      const rows = db
        .prepare(`SELECT ${target.idCol} AS id, ${target.jsonCol} AS json FROM ${target.table}`)
        .all() as Array<{ id: number | string; json: string | null }>;
      const update = db.prepare(
        `UPDATE ${target.table} SET ${target.jsonCol} = ? WHERE ${target.idCol} = ?`,
      );
      for (const row of rows) {
        if (row.json === null || row.json === undefined) {
          stats.rowsUnchanged += 1;
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.json);
        } catch {
          stats.rowsUnparseable += 1;
          continue;
        }
        const { value, changed } = rewriteJsonPaths(parsed, oldPrefix, newPrefix);
        if (changed) {
          update.run(JSON.stringify(value), row.id);
          stats.rowsRewritten += 1;
        } else {
          stats.rowsUnchanged += 1;
        }
      }
    }
  });

  tx();
  logger.info({ oldPrefix, newPrefix, stats }, "rewritePathsInDb complete");
  return stats;
}
