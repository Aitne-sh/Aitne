import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type Database from "better-sqlite3";
import * as chokidar from "chokidar";
import {
  docsFrontmatterSchema,
  FrontmatterParseError,
  parseFrontmatter,
  slugifyAnchor,
  type DocsFrontmatter,
} from "@aitne/shared";
import { createLogger } from "../../logging.js";
import { extractTerms, iterateHeadings } from "./extract-terms.js";
import { reconcileDocsCorpus } from "../release-assets.js";

const logger = createLogger("docs-indexer");

/**
 * Docs corpus indexer (DOCS_QA_DESIGN.md §5, §7, P1).
 *
 * Responsibilities:
 *   1. **Release-aware seed.** Mirror missing files from
 *      `<workspaceDir>/agent-assets/docs/` to `<workspaceDir>/docs/user/`,
 *      and refresh files that still match the previous shipped hash.
 *      User-edited files are preserved and reported via release-assets
 *      health instead of being overwritten.
 *   2. **Boot scan.** Walk `docs/user/`, parse frontmatter, validate
 *      against `docsFrontmatterSchema`, extract H1/H2/H3 anchors, and
 *      upsert into `fts_docs` + `docs_revisions`.
 *   3. **Watcher.** A chokidar watch on `docs/user/` with the same
 *      300ms `awaitWriteFinish.stabilityThreshold` used by
 *      `management-md.ts` so editor saves debounce cleanly. File events
 *      re-index that single doc; deletions remove the row.
 *
 * Indexer health (`docs/health` route) reads:
 *   - row count in `fts_docs`
 *   - `lastErrorCount` accumulated since last successful re-pass
 *   - `lastIndexedAt` from the most recent `docs_revisions.indexed_at`
 */

export interface DocsIndexerHandle {
  /** Stop the chokidar watcher. */
  stop(): Promise<void>;
  /** Manual re-pass over the entire corpus. */
  rebuild(): Promise<IndexerHealth>;
  /** Current health snapshot. */
  health(): IndexerHealth;
}

export interface IndexerHealth {
  status: "ok" | "degraded" | "empty";
  fileCount: number;
  errorCount: number;
  lastIndexedAt: string | null;
  errors: { slug: string; reason: string }[];
}

export interface DocsIndexerOptions {
  /**
   * Repo root. The seed source is `<workspaceDir>/agent-assets/docs/`
   * and the indexed corpus lives at `<workspaceDir>/docs/user/`.
   */
  workspaceDir: string;
  /** Optional override for the seed source (testing). */
  seedSourceDir?: string;
  /** Optional override for the corpus dir (testing). */
  corpusDir?: string;
  /** Skip the chokidar watcher. Used in tests + one-shot rebuilds. */
  watch?: boolean;
  /**
   * Optional backup root for release-driven docs refreshes. When omitted,
   * unedited docs are still refreshed but no extra file-level backup is made.
   */
  backupRoot?: string | null;
}

interface IndexedDoc {
  slug: string;
  frontmatter: DocsFrontmatter;
  body: string;
  anchors: string[];
}

interface IndexerErrorRow {
  slug: string;
  reason: string;
}

const SUMMARY_MAX_LEN_FOR_LOG = 240;

/**
 * Top-level entry point used by the daemon's startup sequence.
 *
 * Sequence:
 *   1. Reconcile `docs/user/` from `agent-assets/docs/` non-destructively.
 *   2. Run a boot-scan rebuild.
 *   3. Start the chokidar watcher (unless `watch === false`).
 *
 * Returns a handle for graceful shutdown + manual rebuild.
 */
export async function startDocsIndexer(
  db: Database.Database,
  options: DocsIndexerOptions,
): Promise<DocsIndexerHandle> {
  const seedSource = options.seedSourceDir
    ?? resolve(options.workspaceDir, "agent-assets", "docs");
  const corpusDir = options.corpusDir
    ?? resolve(options.workspaceDir, "docs", "user");
  const watchEnabled = options.watch ?? true;

  reconcileDocsCorpus({
    db,
    sourceDir: seedSource,
    targetDir: corpusDir,
    backupRoot: options.backupRoot ?? null,
  });

  let lastErrors: IndexerErrorRow[] = [];
  let lastIndexedAt: string | null = null;
  let fileCount = 0;

  async function rebuild(): Promise<IndexerHealth> {
    const result = await indexCorpus(db, corpusDir);
    lastErrors = result.errors;
    fileCount = result.fileCount;
    if (result.lastIndexedAt) lastIndexedAt = result.lastIndexedAt;
    return health();
  }

  function health(): IndexerHealth {
    const status: IndexerHealth["status"] =
      fileCount === 0 ? "empty" : lastErrors.length > 0 ? "degraded" : "ok";
    return {
      status,
      fileCount,
      errorCount: lastErrors.length,
      lastIndexedAt,
      errors: lastErrors,
    };
  }

  await rebuild();

  let watcher: chokidar.FSWatcher | null = null;
  if (watchEnabled) {
    watcher = chokidar.watch(corpusDir, {
      persistent: true,
      ignoreInitial: true,
      // Only watch markdown files; the chokidar `ignored` callback gets a
      // path that includes the corpusDir prefix, so an `endsWith(".md")`
      // negation is the simplest filter that won't drop directories.
      ignored: (p: string) => {
        const stat = (() => {
          try {
            return statSync(p);
          } catch {
            return null;
          }
        })();
        if (stat?.isDirectory()) return false;
        return !p.endsWith(".md");
      },
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    });

    const handleChange = async (path: string): Promise<void> => {
      try {
        await reindexSingle(db, corpusDir, path);
        // Refresh health-snapshot fields after a single-file change.
        const h = countCorpus(db);
        fileCount = h.fileCount;
        lastIndexedAt = h.lastIndexedAt ?? lastIndexedAt;
        // Single-file errors are not aggregated into `lastErrors`; they
        // surface via the per-event log line and the next manual rebuild.
      } catch (err) {
        logger.warn(
          { err, path },
          "docs indexer: failed to re-index file after change event",
        );
      }
    };

    const handleUnlink = (path: string): void => {
      try {
        const slug = slugFromPath(corpusDir, path);
        db.prepare("DELETE FROM fts_docs WHERE slug = ?").run(slug);
        db.prepare("DELETE FROM fts_doc_terms WHERE slug = ?").run(slug);
        db.prepare("DELETE FROM fts_docs_word WHERE slug = ?").run(slug);
        db.prepare("DELETE FROM docs_revisions WHERE slug = ?").run(slug);
        const h = countCorpus(db);
        fileCount = h.fileCount;
      } catch (err) {
        logger.warn({ err, path }, "docs indexer: failed to handle delete event");
      }
    };

    watcher.on("add", (p) => void handleChange(p));
    watcher.on("change", (p) => void handleChange(p));
    watcher.on("unlink", handleUnlink);
    watcher.on("error", (err: unknown) =>
      logger.error({ err }, "docs indexer: watcher error"),
    );
    logger.info({ corpusDir }, "docs indexer watcher started");
  }

  return {
    rebuild,
    health,
    async stop() {
      if (watcher) {
        await watcher.close();
        logger.info("docs indexer watcher stopped");
      }
    },
  };
}

/** Recursive copy from seed → corpus. Used only on first launch. */
export function seedCorpus(seedSource: string, corpusDir: string): void {
  if (!existsSync(seedSource)) {
    logger.warn(
      { seedSource, corpusDir },
      "docs indexer: seed source missing — corpus stays empty until operator authors docs",
    );
    mkdirSync(corpusDir, { recursive: true });
    return;
  }
  mkdirSync(dirname(corpusDir), { recursive: true });
  cpSync(seedSource, corpusDir, { recursive: true });
  logger.info(
    { seedSource, corpusDir },
    "docs indexer: seeded docs/user/ from agent-assets/docs/",
  );
}

/** Boot-scan rebuild: walk corpusDir, re-upsert every doc, drop orphans. */
export async function indexCorpus(
  db: Database.Database,
  corpusDir: string,
): Promise<{
  fileCount: number;
  errors: IndexerErrorRow[];
  lastIndexedAt: string | null;
}> {
  const errors: IndexerErrorRow[] = [];
  if (!existsSync(corpusDir)) {
    return { fileCount: 0, errors, lastIndexedAt: null };
  }

  const files = await listMarkdownFiles(corpusDir);
  const seen = new Set<string>();
  let fileCount = 0;
  let lastIndexedAt: string | null = null;

  const txn = db.transaction((paths: string[]) => {
    for (const absPath of paths) {
      try {
        const indexed = readAndValidate(corpusDir, absPath);
        if (!indexed) continue;
        upsertRow(db, indexed);
        seen.add(indexed.slug);
        fileCount += 1;
      } catch (err) {
        const slug = slugFromPath(corpusDir, absPath);
        const reason =
          err instanceof Error ? err.message : String(err);
        errors.push({ slug, reason });
        logger.warn({ slug, reason }, "docs indexer: skipped invalid doc");
      }
    }
    // Drop orphans: rows in fts_docs whose slug is not in `seen`.
    const indexedSlugs = (
      db
        .prepare("SELECT slug FROM fts_docs")
        .all() as { slug: string }[]
    ).map((r) => r.slug);
    for (const slug of indexedSlugs) {
      if (!seen.has(slug)) {
        db.prepare("DELETE FROM fts_docs WHERE slug = ?").run(slug);
        db.prepare("DELETE FROM fts_doc_terms WHERE slug = ?").run(slug);
        db.prepare("DELETE FROM fts_docs_word WHERE slug = ?").run(slug);
        db.prepare("DELETE FROM docs_revisions WHERE slug = ?").run(slug);
      }
    }
    const latest = db
      .prepare("SELECT MAX(indexed_at) AS t FROM docs_revisions")
      .get() as { t: string | null } | undefined;
    lastIndexedAt = latest?.t ?? null;
  });
  txn(files);
  return { fileCount, errors, lastIndexedAt };
}

/** Re-index a single file (chokidar event handler). */
export function reindexSingle(
  db: Database.Database,
  corpusDir: string,
  absPath: string,
): void {
  const indexed = readAndValidate(corpusDir, absPath);
  if (!indexed) return;
  upsertRow(db, indexed);
}

function readAndValidate(
  corpusDir: string,
  absPath: string,
): IndexedDoc | null {
  if (!existsSync(absPath)) return null;
  const content = readFileSync(absPath, "utf-8");
  let parsed;
  try {
    parsed = parseFrontmatter(content);
  } catch (err) {
    if (err instanceof FrontmatterParseError) {
      throw new Error(`frontmatter parse failed: ${err.message}`);
    }
    throw err;
  }
  if (!parsed) {
    throw new Error("missing frontmatter (file does not start with '---')");
  }

  const result = docsFrontmatterSchema.safeParse(parsed.values);
  if (!result.success) {
    throw new Error(
      `frontmatter validation failed: ${JSON.stringify(result.error.flatten())}`,
    );
  }
  const fm = result.data;

  // Slug-vs-filename consistency check. The slug is the canonical doc
  // identity; a mismatch with the on-disk path means cross-links and
  // citation tokens will not resolve. The dashboard URL is derived from
  // the slug, not the filename, but the indexer requires both to agree.
  const slugFromFile = slugFromPath(corpusDir, absPath);
  if (fm.slug !== slugFromFile) {
    throw new Error(
      `frontmatter slug "${fm.slug}" does not match filesystem path "${slugFromFile}"`,
    );
  }

  // Slug ↔ category cross-check: the first slug segment must equal the
  // category. Catches the common copy/paste mistake of leaving an old
  // category after moving the file.
  const firstSegment = fm.slug.split("/")[0]!;
  if (
    fm.category !== "glossary" &&
    firstSegment !== fm.category
  ) {
    throw new Error(
      `slug first segment "${firstSegment}" does not match category "${fm.category}"`,
    );
  }
  if (fm.category === "glossary" && fm.slug !== "glossary") {
    throw new Error(
      `category 'glossary' is reserved for the single 'glossary' slug; got "${fm.slug}"`,
    );
  }

  const anchors = extractAnchors(parsed.body);
  return { slug: fm.slug, frontmatter: fm, body: parsed.body, anchors };
}

/**
 * Map an absolute file path under `corpusDir` to a slug. Strips the
 * trailing `.md` and rewrites OS path separators to `/`.
 */
export function slugFromPath(corpusDir: string, absPath: string): string {
  const rel = relative(corpusDir, absPath).replace(/\\/g, "/");
  const noExt = rel.endsWith(".md") ? rel.slice(0, -3) : rel;
  return noExt;
}

/**
 * Extract H1/H2/H3 anchors from a Markdown body. Code-fence aware via the
 * shared `iterateHeadings` helper in `extract-terms.ts` — both the citation
 * post-processor (consumes this) and the term subindex (consumes
 * `iterateHeadings` directly through `extractTerms`) must agree on which
 * headings exist; sharing the walker is what guarantees that.
 */
export function extractAnchors(body: string): string[] {
  const anchors = new Set<string>();
  for (const heading of iterateHeadings(body)) {
    const slug = slugifyAnchor(heading.text);
    if (slug.length > 0) anchors.add(slug);
  }
  return [...anchors];
}

function upsertRow(db: Database.Database, doc: IndexedDoc): void {
  // FTS5 rebuild semantics — delete-then-insert because the FTS5 row's
  // primary key is its rowid, which changes across SQLite restarts. The
  // contentless table doesn't support a true upsert.
  db.prepare("DELETE FROM fts_docs WHERE slug = ?").run(doc.slug);
  db.prepare("DELETE FROM fts_doc_terms WHERE slug = ?").run(doc.slug);
  db.prepare("DELETE FROM fts_docs_word WHERE slug = ?").run(doc.slug);

  const fm = doc.frontmatter;
  db.prepare(
    `INSERT INTO fts_docs(
       slug, title, keywords, aliases, summary, ask_examples, body,
       tags, process_keys, config_keys, category, section, status, anchors,
       related
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    fm.slug,
    fm.title,
    joinTokens(fm.keywords),
    joinTokens(fm.aliases),
    fm.summary,
    joinTokens(fm.ask_examples),
    doc.body,
    JSON.stringify(fm.tags ?? []),
    JSON.stringify(fm.process_keys ?? []),
    JSON.stringify(fm.config_keys ?? []),
    fm.category,
    fm.section ?? "",
    fm.status ?? "",
    doc.anchors.join("\n"),
    JSON.stringify(fm.related ?? []),
  );

  // Phase 3 word-boundary parallel index — same ranked-text columns as
  // `fts_docs` under a unicode61 tokenizer, plus `category`/`tags` so the
  // ASCII /api/docs/search branch can stay a single-table query.
  db.prepare(
    `INSERT INTO fts_docs_word(
       slug, title, keywords, aliases, summary, ask_examples, body,
       category, tags
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    fm.slug,
    fm.title,
    joinTokens(fm.keywords),
    joinTokens(fm.aliases),
    fm.summary,
    joinTokens(fm.ask_examples),
    doc.body,
    fm.category,
    JSON.stringify(fm.tags ?? []),
  );

  // Phase 2 term subindex — one doc-level row + one row per H2/H3
  // section. Aliases pool merges three frontmatter fields (see §6.1.1
  // for why the merge is intentional).
  const insertTerm = db.prepare(
    `INSERT INTO fts_doc_terms(slug, anchor, term, aliases, summary, category)
       VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const t of extractTerms(fm, doc.body)) {
    insertTerm.run(fm.slug, t.anchor, t.term, t.aliases, t.summary, fm.category);
  }

  const bodyHash = sha256(doc.body);
  const fmHash = sha256(JSON.stringify(fm));
  db.prepare(
    `INSERT INTO docs_revisions (slug, body_hash, frontmatter_hash, indexed_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(slug) DO UPDATE SET
         body_hash = excluded.body_hash,
         frontmatter_hash = excluded.frontmatter_hash,
         indexed_at = excluded.indexed_at`,
  ).run(doc.slug, bodyHash, fmHash);

  // Truncate noisy summaries in the log line so the boot trace stays readable.
  const summaryPreview =
    fm.summary.length > SUMMARY_MAX_LEN_FOR_LOG
      ? `${fm.summary.slice(0, SUMMARY_MAX_LEN_FOR_LOG)}…`
      : fm.summary;
  logger.debug(
    { slug: fm.slug, anchors: doc.anchors.length, summaryPreview },
    "docs indexer: upserted row",
  );
}

function joinTokens(values: readonly string[] | undefined): string {
  if (!values || values.length === 0) return "";
  return values.join("\n");
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function countCorpus(db: Database.Database): {
  fileCount: number;
  lastIndexedAt: string | null;
} {
  const count = db
    .prepare("SELECT COUNT(*) AS c FROM fts_docs")
    .get() as { c: number };
  const latest = db
    .prepare("SELECT MAX(indexed_at) AS t FROM docs_revisions")
    .get() as { t: string | null } | undefined;
  return { fileCount: count.c, lastIndexedAt: latest?.t ?? null };
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

// Small re-export so tests that need to compose a path-style slug do not
// need to re-implement the OS-separator rewrite.
export const _internal = { sep, joinTokens };
