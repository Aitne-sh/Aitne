import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { WikiWorkspaceRow } from "./workspaces.js";
import { createLogger } from "../../logging.js";

const logger = createLogger("wiki-fts");

/**
 * WIKI_BUILDER_DESIGN.md §12 / §P4.A — FTS5 sync layer for the
 * `fts_wiki` content-less virtual table.
 *
 * Why content-less: wiki content lives on disk under
 * `<workspace>.root_path`, not in a SQL table. The mail FTS pattern
 * (`fts_mail_messages`) uses AFTER-INSERT/UPDATE/DELETE triggers on
 * `mail_messages_index` because the source rows are themselves in
 * SQLite. Wiki has no such source table — the write chokepoint
 * (`/api/wiki/:ws/files/*` POST/PATCH in `wiki.ts`) is the only place
 * the file is mutated, so this module is invoked directly from the
 * route handlers after a successful disk write. Centralising the FTS
 * upsert/delete here keeps the trigger-equivalent logic in one place.
 *
 * The single canonical key for a wiki row is the pair
 * (`workspace_id`, `path`). FTS5 has no `UNIQUE` constraint, so the
 * delete-then-insert pattern is what we use to model "upsert" — it's
 * also what `trg_mail_messages_au` does on UPDATE and is the FTS5-idiomatic
 * approach (see `https://www.sqlite.org/fts5.html` §4.4.2).
 */

export type WikiFtsLayer = "raw" | "wiki" | "output" | "meta" | "log" | "inbox";

export interface UpsertWikiFulltextInput {
  workspaceId: number;
  path: string;
  layer: WikiFtsLayer;
  content: string;
  mtime?: string;
}

export function upsertWikiFulltextRow(
  db: Database.Database,
  input: UpsertWikiFulltextInput,
): void {
  if (input.layer === "log" || input.layer === "inbox") {
    // `log.md` is an append-only audit trail; `00_inbox/` is human-only
    // (§2.3 invariants). Neither should appear in agent search results —
    // indexing them would bury wiki/raw matches under log noise.
    deleteWikiFulltextRow(db, input.workspaceId, input.path);
    return;
  }
  const { title, body } = extractTitleAndBody(input.content);
  const mtime = input.mtime ?? new Date().toISOString();
  // Delete-then-insert == "upsert" for a content-less FTS5 table. Wrap in
  // an IMMEDIATE transaction so a partial failure cannot leave the index
  // missing both the old row and the new one.
  const tx = db.transaction(() => {
    db.prepare(
      `DELETE FROM fts_wiki WHERE workspace_id = ? AND path = ?`,
    ).run(input.workspaceId, input.path);
    db.prepare(
      `INSERT INTO fts_wiki
         (workspace_id, path, layer, title, body, mtime)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(input.workspaceId, input.path, input.layer, title, body, mtime);
  });
  tx();
}

export function deleteWikiFulltextRow(
  db: Database.Database,
  workspaceId: number,
  path: string,
): void {
  db.prepare(
    `DELETE FROM fts_wiki WHERE workspace_id = ? AND path = ?`,
  ).run(workspaceId, path);
}

export function deleteWikiFulltextWorkspace(
  db: Database.Database,
  workspaceId: number,
): void {
  db.prepare(`DELETE FROM fts_wiki WHERE workspace_id = ?`).run(workspaceId);
}

export interface WikiFtsSearchOptions {
  layer?: WikiFtsLayer;
  limit?: number;
}

export interface WikiFtsSearchResult {
  path: string;
  layer: string;
  title: string;
  snippet: string;
  mtime: string;
  rank: number;
}

export function searchWikiFulltext(
  db: Database.Database,
  workspaceId: number,
  query: string,
  options: WikiFtsSearchOptions = {},
): WikiFtsSearchResult[] {
  const limit = Math.max(1, Math.min(50, options.limit ?? 20));
  const ftsQuery = buildFtsMatchExpression(query);
  if (!ftsQuery) return [];
  const params: Array<string | number> = [ftsQuery, workspaceId];
  let layerClause = "";
  if (options.layer) {
    layerClause = " AND layer = ?";
    params.push(options.layer);
  }
  params.push(limit);
  try {
    // BM25 weights: one entry per column, in the CREATE-VIRTUAL-TABLE order
    // (workspace_id, path, layer, title, body, mtime). Missing trailing
    // weights default to 1.0 — so the previous shorthand
    // `bm25(fts_wiki, 3.0, 1.0)` was applying 3.0 to `workspace_id` (which
    // is UNINDEXED and contributes 0 anyway), leaving `title` at the
    // default 1.0 and silently dropping the boost. UNINDEXED columns get
    // 0.0 to match the pattern in `docs.ts`. snippet() uses -1 to let FTS5
    // pick the column with the best match (so title-only hits still get a
    // meaningful excerpt instead of a leading body fragment).
    return db
      .prepare(
        `SELECT path, layer, title,
                snippet(fts_wiki, -1, '<mark>', '</mark>', '…', 12) AS snippet,
                mtime,
                bm25(fts_wiki, 0.0, 0.0, 0.0, 3.0, 1.0, 0.0) AS rank
           FROM fts_wiki
          WHERE fts_wiki MATCH ?
            AND workspace_id = ?${layerClause}
          ORDER BY rank
          LIMIT ?`,
      )
      .all(...params) as WikiFtsSearchResult[];
  } catch (err) {
    // Malformed FTS5 expressions throw SQLITE_ERROR; surface as empty
    // results so the route can fall back to grep without 500-ing.
    logger.warn({ err, query, ftsQuery }, "wiki fts search failed; returning empty");
    return [];
  }
}

/**
 * Translate a free-form user query into an FTS5 MATCH expression.
 *
 * We quote each token to defeat FTS5's tiny operator vocabulary (AND/OR/
 * NOT/NEAR/etc.) — a user typing literally "rust AND go" should match the
 * phrase, not parse as a boolean. Tokens are joined by implicit AND so
 * multi-word queries narrow correctly. Empty input returns null so the
 * caller can short-circuit.
 */
function buildFtsMatchExpression(query: string): string | null {
  const trimmed = query.trim();
  if (!trimmed) return null;
  const tokens = trimmed
    .split(/\s+/)
    .map((tok) => tok.replace(/[^\p{L}\p{N}_-]+/gu, ""))
    .filter((tok) => tok.length > 0);
  if (tokens.length === 0) return null;
  return tokens.map((tok) => `"${tok.replace(/"/g, "")}"`).join(" ");
}

/**
 * Best-effort title extraction: first `# Heading` line, with frontmatter
 * skipped. Frontmatter is removed from the body before indexing so the
 * structural keys (`type`, `aliases`, …) don't pollute relevance.
 */
function extractTitleAndBody(content: string): { title: string; body: string } {
  const { frontmatterKeys, body } = stripFrontmatter(content);
  const heading = body
    .split("\n")
    .find((line) => line.startsWith("# "))
    ?.slice(2)
    .trim();
  // Frontmatter `title:` is a strong secondary signal — it survives the
  // body strip so the search index can still rank a file whose H1 happens
  // to be missing (a common shape for short raw notes).
  const title = heading ?? frontmatterKeys.title ?? "";
  return { title, body };
}

interface StripFrontmatterResult {
  frontmatterKeys: { title?: string };
  body: string;
}

function stripFrontmatter(content: string): StripFrontmatterResult {
  // Obsidian vaults authored/synced on Windows (or checked out under
  // git core.autocrlf=true) are CRLF. The frontmatter fence gate below is
  // LF-only, so without this normalize a `---\r\n…---\r\n` block leaks into
  // the indexed body and the title fallback never populates. Indexed
  // body/title are search tokens only and never round-trip to disk, so
  // collapsing interior CRLF to LF is harmless (LF input is unchanged).
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatterKeys: {}, body: normalized };
  }
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) {
    return { frontmatterKeys: {}, body: normalized };
  }
  const frontmatter = normalized.slice(4, end);
  const body = normalized.slice(end + 5);
  const keys: { title?: string } = {};
  for (const line of frontmatter.split("\n")) {
    const match = line.match(/^title:\s*(.*?)\s*$/);
    if (match) {
      keys.title = match[1].replace(/^["']|["']$/g, "");
      break;
    }
  }
  return { frontmatterKeys: keys, body };
}

/**
 * Rebuild the FTS index for one workspace by walking its disk tree.
 *
 * Used by:
 *   1. The boot-time backfill (`backfillWikiFulltext`) when the index is
 *      empty for a workspace that has on-disk files.
 *   2. An explicit `POST /api/wiki/:ws/reindex` (operator escape hatch).
 *
 * The function is intentionally synchronous: it runs inside a single
 * transaction so partial failures roll back, and it is invoked rarely
 * (boot, manual reindex) so the simpler shape outweighs streaming.
 */
export function reindexWikiWorkspace(
  db: Database.Database,
  workspace: WikiWorkspaceRow,
): { indexed: number; skipped: number } {
  let indexed = 0;
  let skipped = 0;
  const rows: UpsertWikiFulltextInput[] = [];
  for (const rel of walkWikiTree(workspace.root_path)) {
    const layer = classifyWikiPathForFts(rel);
    if (!layer || layer === "log" || layer === "inbox") {
      skipped += 1;
      continue;
    }
    const full = join(workspace.root_path, rel);
    try {
      const stat = statSync(full);
      if (!stat.isFile()) {
        skipped += 1;
        continue;
      }
      const content = readFileSync(full, "utf-8");
      rows.push({
        workspaceId: workspace.id,
        path: rel,
        layer,
        content,
        mtime: stat.mtime.toISOString(),
      });
      indexed += 1;
    } catch (err) {
      logger.warn({ err, workspace: workspace.name, path: rel }, "wiki reindex: skipped unreadable file");
      skipped += 1;
    }
  }
  const tx = db.transaction(() => {
    deleteWikiFulltextWorkspace(db, workspace.id);
    for (const row of rows) {
      const { title, body } = extractTitleAndBody(row.content);
      db.prepare(
        `INSERT INTO fts_wiki (workspace_id, path, layer, title, body, mtime)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(row.workspaceId, row.path, row.layer, title, body, row.mtime ?? "");
    }
  });
  tx();
  logger.info({ workspace: workspace.name, indexed, skipped }, "wiki fts reindex complete");
  return { indexed, skipped };
}

/**
 * Boot-time backfill — called from `index.ts` after `applySchema`. The
 * branch checks per-workspace so adding a second workspace later only
 * pays the cost for the new one. Empty workspaces are a no-op.
 */
export function backfillWikiFulltext(
  db: Database.Database,
  workspaces: WikiWorkspaceRow[],
): void {
  if (workspaces.length === 0) return;
  const countByWorkspace = db
    .prepare(`SELECT workspace_id, COUNT(*) AS n FROM fts_wiki GROUP BY workspace_id`)
    .all() as Array<{ workspace_id: number; n: number }>;
  const counts = new Map(countByWorkspace.map((row) => [row.workspace_id, row.n]));
  for (const workspace of workspaces) {
    if (workspace.active !== 1) continue;
    if ((counts.get(workspace.id) ?? 0) > 0) continue;
    if (!existsSync(workspace.root_path)) continue;
    reindexWikiWorkspace(db, workspace);
  }
}

function walkWikiTree(rootPath: string): string[] {
  const out: string[] = [];
  if (!existsSync(rootPath)) return out;
  walk("", out);
  return out;

  function walk(relDir: string, accumulator: string[]): void {
    const dir = relDir ? join(rootPath, relDir) : rootPath;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      // `.snapshots/` is the internal-mode backup tree (§14 Q3) and must
      // never appear in search — its bytes would be a duplicate index of
      // the live wiki. The recurse also stops here for free.
      if (rel.startsWith(".snapshots") || rel === ".snapshots") continue;
      if (entry.isDirectory()) {
        walk(rel, accumulator);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        accumulator.push(rel);
      }
    }
  }
}

/**
 * Mirror of `classifyWikiPath` in `wiki.ts` but returning just the layer
 * tag the FTS index cares about. Kept here to avoid importing the API
 * route module from a core helper (one-way dependency: routes → core).
 */
export function classifyWikiPathForFts(relPath: string): WikiFtsLayer | null {
  if (relPath === "log.md") return "log";
  const [root, ...rest] = relPath.split("/");
  switch (root) {
    case "00_inbox":
      return rest.length > 0 ? "inbox" : null;
    case "10_raw":
      return rest.length >= 1 ? "raw" : null;
    case "20_wiki":
      return rest.length === 1 ? "wiki" : null;
    case "30_outputs":
      return rest.length === 1 ? "output" : null;
    case "90_meta":
      return rest.length >= 1 ? "meta" : null;
    default:
      return null;
  }
}
