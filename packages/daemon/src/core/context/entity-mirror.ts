import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  type Dirent,
} from "node:fs";
import { join, relative, sep, resolve } from "node:path";
import * as chokidar from "chokidar";
import type Database from "better-sqlite3";
import {
  DOMAINS,
  TYPE_PLURALS,
  parseEntityPath,
  pluralToType,
  type Domain,
  type EntityType,
} from "@aitne/shared";
import type { AgentWriteTracker } from "../../safety/agent-write-tracker.js";
import { recordEntityMirrorLag } from "../management-telemetry.js";
import { createLogger } from "../../logging.js";

const logger = createLogger("entity-mirror");

/**
 * Entity-mirror reconciler — docs/design/21-management-registry-and-
 * entities.md §7.6 (the SQLite mirror under the §7.6 lookup contract).
 *
 * Scope:
 *   - Parse an L2 entity file (`<contextDir>/<domain>/<type-plural>/<slug>.md`)
 *     into a mirror row (pure).
 *   - Compute the upsert / delete plan for a directory snapshot vs the
 *     current `entities` table (pure).
 *   - Apply the plan to SQLite atomically (one transaction per row, both
 *     `entities` and `entity_source_keys` updated together).
 *   - Walk the L2 tree on boot to rebuild the mirror from disk (the §7.6
 *     "MD wins on divergence" invariant).
 *   - Watch L2 with chokidar so the mirror converges within NFR-9
 *     (≤500 ms per write on ≤5000 entity files).
 *
 * Self-write suppression: when an API write reaches an L2 file, the
 * route layer marks the path on the shared {@link AgentWriteTracker}.
 * The watcher consults the tracker before re-parsing so a daemon-driven
 * PATCH doesn't trigger a redundant mirror update + chokidar fan-out.
 *
 * Authority: the MD file is the source of truth (§7.6 "Why not
 * authoritative SQLite"). The mirror is a lookup index. On boot, the
 * mirror is rebuilt verbatim from disk; if the table has diverged, the
 * file wins.
 *
 * Pure-logic split: `parseEntityFromBody`, `buildMirrorRowFromFile`,
 * `computeMirrorDiff`, and `enumerateEntityFiles` carry the testable
 * logic; the chokidar wrapper at the bottom is an event-binding glue
 * layer. Coverage gate excludes the wrapper but enforces 100% on the
 * pure parts (vitest.config.ts curated set).
 */

// ── L2 path helpers ────────────────────────────────────────────────────────

/**
 * Domains under `<contextDir>/` that the mirror walks. Restricted to
 * the §9.4 `DOMAINS` enum so an unrelated top-level directory (e.g.
 * `routines/`, `rules/`) is never mistakenly classified as L2.
 */
const L2_DOMAINS = DOMAINS;

const L2_TYPE_PLURALS: ReadonlySet<string> = new Set(Object.values(TYPE_PLURALS));

/** Directory-traversal sentinels skipped by the L2 walker. */
const SKIP_DIR_NAMES = new Set([".git", ".obsidian", ".DS_Store"]);

// ── Frontmatter parsing (pure) ─────────────────────────────────────────────

const FRONTMATTER_OPEN_RE = /^---\s*$/;

/**
 * Parsed entity-file frontmatter. The mirror only consumes a subset of
 * the §9.3 schema — the fields it indexes — so the parser is permissive
 * about unknown keys. Validation that the frontmatter conforms to the
 * full schema lives in `/api/context/...` PATCH handlers.
 */
export interface ParsedEntityFrontmatter {
  domain: Domain;
  type: EntityType;
  slug: string;
  title: string;
  status: string | null;
  date: string | null;
  lastSyncedAt: string | null;
  /** Verbatim sources record (JSON) keyed by user-typed app label. */
  sources: Record<string, Record<string, unknown>>;
}

/**
 * Parse an entity-file body into a mirror-ready record. Returns `null`
 * when the file is structurally invalid for the mirror's purposes:
 *
 *   - no frontmatter,
 *   - frontmatter does not close with `---`,
 *   - missing `domain` / `type` / `slug` / `title`,
 *   - `domain` is not a member of the §9.4 enum,
 *   - `type` is not a member of the §9.3 enum.
 *
 * The L2 path-derived overrides are layered in by the caller (the file
 * path is the strongest signal — the directory layout cannot lie about
 * domain or type the way frontmatter can).
 */
export function parseEntityFromBody(body: string): ParsedEntityFrontmatter | null {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  // `String.split` always returns at least one element; the empty-array
  // guard below is a defensive belt-and-braces for the `?? ""` fallback.
  /* c8 ignore next */
  if (lines.length === 0 || !FRONTMATTER_OPEN_RE.test(lines[0] ?? "")) {
    return null;
  }
  const closeIndex = lines.findIndex(
    (line, idx) => idx > 0 && FRONTMATTER_OPEN_RE.test(line),
  );
  if (closeIndex < 0) return null;

  const flat: Record<string, string> = {};
  const sources: Record<string, Record<string, unknown>> = {};
  let inSourcesBlock = false;
  let currentSourceKey: string | null = null;

  for (const rawLine of lines.slice(1, closeIndex)) {
    if (rawLine.trim() === "" || rawLine.trim().startsWith("#")) continue;

    // Indented child: only meaningful inside a `sources:` block. The
    // 2-space indent declares a new source key (with optional inline
    // value); deeper indent declares fields under the most recent
    // source. Indented lines outside a `sources:` block are ignored —
    // unknown nested keys are not part of the entity-mirror schema.
    if (/^\s+/.test(rawLine)) {
      if (!inSourcesBlock) continue;
      const childMatch = /^\s{2,}([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/.exec(rawLine);
      if (!childMatch) continue;
      // `^\s+` already passed in the outer `if`; the inner match cannot
      // fail when reached. `?? 0` is a defensive guard for the type
      // narrowing only.
      /* c8 ignore next */
      const indent = rawLine.match(/^\s+/)?.[0].length ?? 0;
      const [, childKey, childValueRaw] = childMatch;
      const childValue = stripQuotes(childValueRaw);
      if (indent === 2) {
        if (childValue === "") {
          sources[childKey] = sources[childKey] ?? {};
          currentSourceKey = childKey;
          continue;
        }
        // Inline source declaration like `zoom: zm_xyz789` — treat the
        // value as the external_id by convention.
        sources[childKey] = { external_id: childValue };
        currentSourceKey = childKey;
        continue;
      }
      if (currentSourceKey !== null) {
        const target = sources[currentSourceKey];
        if (target) {
          target[childKey] = childValue;
        }
      }
      continue;
    }

    const topMatch = /^([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/.exec(rawLine);
    if (!topMatch) {
      inSourcesBlock = false;
      currentSourceKey = null;
      continue;
    }
    const [, key, valueRaw] = topMatch;
    const value = stripQuotes(valueRaw);
    if (key === "sources") {
      // Reserve the upcoming nested block. Reject inline forms
      // (`sources: foo`) because the schema requires a record.
      inSourcesBlock = value === "";
      currentSourceKey = null;
      continue;
    }
    inSourcesBlock = false;
    flat[key] = value;
    currentSourceKey = null;
  }

  const domainRaw = flat.domain;
  const typeRaw = flat.type;
  const slug = flat.slug;
  const title = flat.title;
  if (!domainRaw || !typeRaw || !slug || !title) return null;
  if (!isDomainEnum(domainRaw)) return null;
  if (!isEntityTypeEnum(typeRaw)) return null;

  return {
    domain: domainRaw,
    type: typeRaw,
    slug,
    title,
    status: flat.status ?? null,
    date: flat.date ?? null,
    lastSyncedAt: flat.last_synced_at ?? null,
    sources,
  };
}

function isDomainEnum(value: string): value is Domain {
  return (DOMAINS as readonly string[]).includes(value);
}

function isEntityTypeEnum(value: string): value is EntityType {
  return value in TYPE_PLURALS;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

// ── Snapshot model + diff (pure) ───────────────────────────────────────────

export interface MirrorSnapshotRow {
  path: string;
  domain: Domain;
  type: EntityType;
  slug: string;
  title: string;
  status: string | null;
  date: string | null;
  lastSyncedAt: string | null;
  /**
   * Stable JSON serialization of the parsed `sources` record, sorted by
   * key so identical inputs produce identical strings (the diff compares
   * stored vs new with a string equality check).
   */
  sourcesJson: string;
  /** Lex-sorted list of source keys for the `entity_source_keys` sidecar. */
  sourceKeys: string[];
}

export interface MirrorCurrentRow {
  path: string;
  domain: string;
  type: string;
  slug: string;
  title: string;
  status: string | null;
  date: string | null;
  lastSyncedAt: string | null;
  sourcesJson: string;
}

export interface MirrorDiff {
  /** Rows present in the snapshot AND either absent from current or changed. */
  upserts: MirrorSnapshotRow[];
  /** Paths that exist in the current table but not in the snapshot. */
  deletes: string[];
  /** True when no upserts and no deletes — caller skips the SQL roundtrip. */
  noOp: boolean;
}

/**
 * Diff a directory snapshot against the current `entities` table state.
 * Returns the upsert + delete plan with deterministic ordering so a
 * single fixture's expected output is reproducible across runs.
 */
export function computeMirrorDiff(
  snapshot: MirrorSnapshotRow[],
  current: MirrorCurrentRow[],
): MirrorDiff {
  const snapshotByPath = new Map<string, MirrorSnapshotRow>();
  for (const row of snapshot) snapshotByPath.set(row.path, row);
  const currentByPath = new Map<string, MirrorCurrentRow>();
  for (const row of current) currentByPath.set(row.path, row);

  const upserts: MirrorSnapshotRow[] = [];
  for (const [path, snap] of snapshotByPath) {
    const cur = currentByPath.get(path);
    if (!cur || !rowsEqual(cur, snap)) {
      upserts.push(snap);
    }
  }
  upserts.sort((a, b) => a.path.localeCompare(b.path));

  const deletes: string[] = [];
  for (const path of currentByPath.keys()) {
    if (!snapshotByPath.has(path)) deletes.push(path);
  }
  deletes.sort();

  return {
    upserts,
    deletes,
    noOp: upserts.length === 0 && deletes.length === 0,
  };
}

function rowsEqual(cur: MirrorCurrentRow, snap: MirrorSnapshotRow): boolean {
  return (
    cur.domain === snap.domain &&
    cur.type === snap.type &&
    cur.slug === snap.slug &&
    cur.title === snap.title &&
    cur.status === snap.status &&
    cur.date === snap.date &&
    cur.lastSyncedAt === snap.lastSyncedAt &&
    cur.sourcesJson === snap.sourcesJson
  );
}

/**
 * Stable JSON serializer. Each top-level key (the source label) is
 * emitted in sorted order; nested fields under each source are likewise
 * sorted. Two parses producing identical content map to byte-identical
 * strings — that's the contract `computeMirrorDiff` relies on.
 */
export function serializeSourcesJson(
  sources: Record<string, Record<string, unknown>>,
): string {
  const sortedKeys = Object.keys(sources).sort();
  const out: Record<string, Record<string, unknown>> = {};
  for (const key of sortedKeys) {
    // `key` came from `Object.keys(sources)` directly above; the lookup
    // is guaranteed to return an object. `?? {}` is a defensive guard
    // for the type narrowing only.
    /* c8 ignore next */
    const inner = sources[key] ?? {};
    const innerKeys = Object.keys(inner).sort();
    const sortedInner: Record<string, unknown> = {};
    for (const k of innerKeys) sortedInner[k] = inner[k];
    out[key] = sortedInner;
  }
  return JSON.stringify(out);
}

// ── Filesystem walk (pure-ish — wraps node:fs) ─────────────────────────────

/**
 * Build a mirror snapshot row from an entity file body + relative path.
 * The relative path supplies the canonical (domain, type, slug) triple
 * — the directory layout cannot misrepresent these the way frontmatter
 * can — and a frontmatter mismatch is logged but does not abort the
 * mirror entry.
 */
export function buildSnapshotRow(
  relativePath: string,
  body: string,
): MirrorSnapshotRow | null {
  const pathParts = parseEntityPath(relativePath);
  if (!pathParts) return null;
  const parsed = parseEntityFromBody(body);
  if (!parsed) return null;
  // Path-derived domain/type override frontmatter when they disagree
  // (the §7.6 "MD file wins" invariant requires we still mirror the
  // file even when frontmatter is mistyped — the dashboard surfaces
  // the divergence via parse-failure rows in P8).
  const domain = pathParts.domain;
  const type = pathParts.type;
  const slug = pathParts.slug;
  const sourcesJson = serializeSourcesJson(parsed.sources);
  const sourceKeys = Object.keys(parsed.sources).sort();
  return {
    path: relativePath,
    domain,
    type,
    slug,
    title: parsed.title,
    status: parsed.status,
    date: parsed.date,
    lastSyncedAt: parsed.lastSyncedAt,
    sourcesJson,
    sourceKeys,
  };
}

/**
 * Enumerate `<contextDir>/<domain>/<type-plural>/*.md` paths. Skips
 * hidden directories (`.git`, `.obsidian`, `.DS_Store`) and any file
 * that is not under one of the §9.4 / §9.3 enums.
 *
 * Returns relative paths (forward-slashed) so the caller can hand
 * them to {@link parseEntityPath} without further normalisation.
 */
export function enumerateEntityFiles(contextDir: string): string[] {
  if (!existsSync(contextDir)) return [];
  const out: string[] = [];
  for (const domain of L2_DOMAINS) {
    const domainAbs = join(contextDir, domain);
    if (!existsSyncSafe(domainAbs)) continue;
    let entries: Dirent[];
    try {
      entries = readdirSync(domainAbs, { withFileTypes: true });
      /* c8 ignore start — defensive readdir-error catch: only fires
         when a permission flip happens between `existsSyncSafe` and
         this call, or when the fd table is exhausted. Walked dirs
         under tempdirs cannot reach the branch in tests. */
    } catch {
      continue;
    }
    /* c8 ignore stop */
    for (const entry of entries) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      if (!entry.isDirectory()) continue;
      if (!L2_TYPE_PLURALS.has(entry.name)) continue;
      const typeDirAbs = join(domainAbs, entry.name);
      let files: Dirent[];
      try {
        files = readdirSync(typeDirAbs, { withFileTypes: true });
        /* c8 ignore start — same rationale as the parent dir catch. */
      } catch {
        continue;
      }
      /* c8 ignore stop */
      for (const file of files) {
        if (SKIP_DIR_NAMES.has(file.name)) continue;
        // Defensive — sub-directories under `<domain>/<plural>/` are
        // not part of the L2 layout and should be ignored. The test
        // surface for this branch lives under the `enumerateEntityFiles`
        // describe block.
        if (!file.isFile()) continue;
        if (!file.name.endsWith(".md")) continue;
        if (file.name.startsWith("_")) continue; // _index.md and friends
        out.push(`${domain}/${entry.name}/${file.name}`);
      }
    }
  }
  out.sort();
  return out;
}

function existsSyncSafe(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Read + parse an L2 file from disk into a snapshot row. Returns `null`
 * when the file is unreadable, has no parseable frontmatter, or the
 * relative path is not a valid `<domain>/<type-plural>/<slug>.md`.
 */
export function readSnapshotRow(
  contextDir: string,
  relativePath: string,
): MirrorSnapshotRow | null {
  const absolute = join(contextDir, relativePath);
  let body: string;
  try {
    body = readFileSync(absolute, "utf-8");
  } catch {
    return null;
  }
  return buildSnapshotRow(relativePath, body);
}

/**
 * Build the full snapshot of L2 entity files for a context directory.
 * Used by both the boot reconciler and the watcher's incremental
 * single-file refresh path.
 */
export function buildFullSnapshot(contextDir: string): MirrorSnapshotRow[] {
  const out: MirrorSnapshotRow[] = [];
  for (const relativePath of enumerateEntityFiles(contextDir)) {
    const row = readSnapshotRow(contextDir, relativePath);
    if (row) out.push(row);
  }
  return out;
}

// ── DB I/O ─────────────────────────────────────────────────────────────────

/**
 * Read the current `entities` rows for the boot diff. Includes
 * `sources_json` so the diff's equality check matches `MirrorSnapshotRow.
 * sourcesJson` (both produced by `serializeSourcesJson`).
 */
export function readCurrentMirror(db: Database.Database): MirrorCurrentRow[] {
  const rows = db
    .prepare(
      `SELECT path, domain, type, slug, title, status, date,
              last_synced_at AS lastSyncedAt, sources_json AS sourcesJson
         FROM entities`,
    )
    .all() as MirrorCurrentRow[];
  return rows;
}

/**
 * Apply a single row's upsert: replace the entity row + replace the
 * sidecar source-key set. Wrapped in `db.transaction` so a partial
 * failure (entity inserted, source-keys not) is impossible.
 */
export function upsertMirrorRow(
  db: Database.Database,
  row: MirrorSnapshotRow,
): void {
  const tx = db.transaction((r: MirrorSnapshotRow) => {
    db.prepare(
      `INSERT INTO entities
         (path, domain, type, slug, title, status, date, last_synced_at, sources_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         domain = excluded.domain,
         type = excluded.type,
         slug = excluded.slug,
         title = excluded.title,
         status = excluded.status,
         date = excluded.date,
         last_synced_at = excluded.last_synced_at,
         sources_json = excluded.sources_json`,
    ).run(
      r.path,
      r.domain,
      r.type,
      r.slug,
      r.title,
      r.status,
      r.date,
      r.lastSyncedAt,
      r.sourcesJson,
    );
    // Replace the sidecar set wholesale. The PK (path, source_key) plus
    // the parent's ON DELETE CASCADE keeps the two tables in lockstep.
    db.prepare(`DELETE FROM entity_source_keys WHERE path = ?`).run(r.path);
    if (r.sourceKeys.length > 0) {
      const insert = db.prepare(
        `INSERT INTO entity_source_keys (path, source_key) VALUES (?, ?)`,
      );
      for (const key of r.sourceKeys) insert.run(r.path, key);
    }
  });
  tx(row);
}

/**
 * Hard-delete a mirror row. The FK ON DELETE CASCADE removes matching
 * `entity_source_keys` rows automatically.
 */
export function deleteMirrorRow(db: Database.Database, path: string): void {
  db.prepare(`DELETE FROM entities WHERE path = ?`).run(path);
}

// ── Boot reconciler ───────────────────────────────────────────────────────

export interface BootstrapEntityMirrorOptions {
  db: Database.Database;
  contextDir: string;
}

export interface BootstrapEntityMirrorResult {
  scanned: number;
  upserted: number;
  deleted: number;
  /** Wall-clock millis of the full pass — surfaces in metrics + tests. */
  durationMs: number;
}

/**
 * Boot-time pass — walks the L2 tree, diffs against the current mirror,
 * applies upserts and deletes. Idempotent: a second call with no
 * filesystem changes is a no-op (`upserted === 0 && deleted === 0`).
 */
export function bootstrapEntityMirror(
  opts: BootstrapEntityMirrorOptions,
): BootstrapEntityMirrorResult {
  const start = Date.now();
  const snapshot = buildFullSnapshot(opts.contextDir);
  const current = readCurrentMirror(opts.db);
  const diff = computeMirrorDiff(snapshot, current);
  for (const row of diff.upserts) upsertMirrorRow(opts.db, row);
  for (const path of diff.deletes) deleteMirrorRow(opts.db, path);
  return {
    scanned: snapshot.length,
    upserted: diff.upserts.length,
    deleted: diff.deletes.length,
    durationMs: Date.now() - start,
  };
}

// ── Single-file refresh (watcher's hot path) ───────────────────────────────

export type SingleRefreshResult =
  | { kind: "noop" }
  | { kind: "self-write" }
  | { kind: "ignored"; reason: "not-l2" | "is-index" | "unparseable" }
  | { kind: "upserted"; path: string }
  | { kind: "deleted"; path: string };

export interface RefreshOneOptions {
  db: Database.Database;
  contextDir: string;
  /** Absolute path the watcher emitted. */
  absolutePath: string;
  /** Optional self-write tracker — when present, marked paths short-circuit. */
  writeTracker?: AgentWriteTracker;
}

/**
 * Apply a single-path delta to the mirror. The watcher calls this on
 * `add`, `change`, and `unlink` events. The function classifies the
 * path, reads the file (if present), and writes the row delta. Returns
 * a discriminated outcome so the caller can record metrics + tests can
 * assert behavior without poking SQLite directly.
 */
export function refreshEntityMirrorForPath(
  opts: RefreshOneOptions,
): SingleRefreshResult {
  const relativePath = toRelativePath(opts.contextDir, opts.absolutePath);
  if (!relativePath) return { kind: "ignored", reason: "not-l2" };
  if (!isL2EntityRelativePath(relativePath)) {
    return { kind: "ignored", reason: "not-l2" };
  }

  if (
    opts.writeTracker?.isMarked(opts.absolutePath, undefined) &&
    existsSync(opts.absolutePath)
  ) {
    // Self-write — the daemon API just wrote this file. The mirror was
    // already updated synchronously in the route handler (or will be on
    // the next debounce tick); skip to avoid a redundant parse + write.
    return { kind: "self-write" };
  }

  if (!existsSync(opts.absolutePath)) {
    deleteMirrorRow(opts.db, relativePath);
    return { kind: "deleted", path: relativePath };
  }

  const snapshot = readSnapshotRow(opts.contextDir, relativePath);
  if (!snapshot) {
    return { kind: "ignored", reason: "unparseable" };
  }
  const current = readCurrentMirrorRow(opts.db, relativePath);
  if (current && rowsEqual(current, snapshot)) {
    return { kind: "noop" };
  }
  upsertMirrorRow(opts.db, snapshot);
  // §14.3 `aitne_entity_mirror_lag_ms` — gauge tracking the most-recent
  // observed lag between an L2 file's last-write and the mirror
  // upsert that consumed it. The mtime read is best-effort (`statSync`
  // can throw if the file has been unlinked between `existsSync` and
  // here); a stat failure simply skips the recording — the next event
  // refreshes the gauge.
  try {
    const mtimeMs = statSync(opts.absolutePath).mtimeMs;
    const lag = Date.now() - mtimeMs;
    if (Number.isFinite(lag) && lag >= 0) {
      recordEntityMirrorLag(lag);
    }
    /* c8 ignore start — defensive stat-failure branch (race between
       existsSync above and statSync here). The pure `recordEntityMirrorLag`
       contract is covered in management-telemetry.test.ts. */
  } catch {
    // best-effort
  }
  /* c8 ignore stop */
  return { kind: "upserted", path: relativePath };
}

function readCurrentMirrorRow(
  db: Database.Database,
  path: string,
): MirrorCurrentRow | null {
  const row = db
    .prepare(
      `SELECT path, domain, type, slug, title, status, date,
              last_synced_at AS lastSyncedAt, sources_json AS sourcesJson
         FROM entities WHERE path = ?`,
    )
    .get(path) as MirrorCurrentRow | undefined;
  return row ?? null;
}

/**
 * Map an absolute path under `contextDir` back to its forward-slashed
 * relative form. Returns `null` when the absolute path is outside the
 * context directory (defense in depth — chokidar should never emit
 * out-of-tree events, but a misconfigured ignore list could).
 */
export function toRelativePath(
  contextDir: string,
  absolutePath: string,
): string | null {
  const rel = relative(resolve(contextDir), resolve(absolutePath));
  if (rel.startsWith("..") || rel === "" || rel.startsWith(`..${sep}`)) {
    return null;
  }
  return rel.split(sep).join("/");
}

/**
 * True when the given relative path matches the L2 layout
 * `<domain>/<type-plural>/<slug>.md`. Does NOT validate the slug — that
 * is the parser's job — only the directory shape.
 */
export function isL2EntityRelativePath(relativePath: string): boolean {
  if (!relativePath.endsWith(".md")) return false;
  const segments = relativePath.split("/");
  if (segments.length !== 3) return false;
  const [domain, typePlural, fileName] = segments;
  if (!isDomainEnum(domain)) return false;
  if (pluralToType(typePlural) === null) return false;
  if (fileName.startsWith("_")) return false;
  return true;
}

// ── Watcher (chokidar glue) ────────────────────────────────────────────────

export interface EntityMirrorWatcherOptions {
  db: Database.Database;
  contextDir: string;
  writeTracker?: AgentWriteTracker;
  /**
   * Invoked after every applied entity-mirror delta (upsert or delete).
   * The daemon wires this to the context-index reconciler observer's
   * `requestReconcile("fs_event")` so the §7.2 chain (domain-index +
   * activity-view) re-renders when an L2 file changes — without it,
   * those views only refreshed on the nightly cron + 30 s startup pass
   * because `shouldIndexPath` filters L2 paths out of the context-
   * index's own watcher (followups item 7).
   *
   * No fan-out risk: the reconciler outputs (`<domain>/_index.md`,
   * `_activity/<source>.md`) live outside the entity-mirror watcher's
   * `<contextDir>/<domain>/<plural>/*.md` patterns and `_*.md` is
   * explicitly ignored, so the chain cannot loop back through this
   * observer.
   */
  onEntityChanged?: () => void;
  /**
   * Test seam — override the watcher factory so unit tests can drive
   * the watcher end-to-end without booting chokidar.
   */
  watcherFactory?: (contextDir: string) => EntityFileWatcher;
}

export interface EntityFileWatcher {
  onChange(handler: (absolutePath: string) => void): void;
  onUnlink(handler: (absolutePath: string) => void): void;
  close(): Promise<void>;
}

export interface EntityMirrorWatcherHandle {
  stop(): Promise<void>;
}

/* c8 ignore start — chokidar wrapper. The pure logic
   (`refreshEntityMirrorForPath`, the diff helpers) is unit-tested with
   100% coverage; the wrapper is only event-binding glue. */
export function startEntityMirrorWatcher(
  opts: EntityMirrorWatcherOptions,
): EntityMirrorWatcherHandle {
  const factory = opts.watcherFactory ?? defaultEntityWatcherFactory;
  const watcher = factory(opts.contextDir);

  const handle = (absolutePath: string): void => {
    try {
      const result = refreshEntityMirrorForPath({
        db: opts.db,
        contextDir: opts.contextDir,
        absolutePath,
        writeTracker: opts.writeTracker,
      });
      if (result.kind === "upserted" || result.kind === "deleted") {
        logger.debug(
          { kind: result.kind, path: result.path },
          "entity-mirror updated",
        );
        // Fan the entity delta out to the §7.2 reconciler chain. The
        // callback is debounced on the consumer side (10 s in
        // ContextIndexReconcilerObserver) so a burst of writes coalesces
        // into one chain run.
        try {
          opts.onEntityChanged?.();
        } catch (err) {
          logger.warn({ err }, "onEntityChanged callback threw");
        }
      }
    } catch (err) {
      logger.warn(
        { err, absolutePath },
        "entity-mirror refresh failed for path",
      );
    }
  };

  watcher.onChange(handle);
  watcher.onUnlink(handle);

  logger.info({ contextDir: opts.contextDir }, "entity-mirror watcher started");

  return {
    async stop() {
      try {
        await watcher.close();
      } catch (err) {
        logger.warn({ err }, "entity-mirror watcher close failed");
      }
      logger.info({ contextDir: opts.contextDir }, "entity-mirror watcher stopped");
    },
  };
}

function defaultEntityWatcherFactory(contextDir: string): EntityFileWatcher {
  // Watch every L2 directory pattern explicitly so unrelated files
  // (rules/, routines/, etc.) never trigger a refresh.
  const patterns = L2_DOMAINS.flatMap((domain) =>
    Array.from(L2_TYPE_PLURALS).map((plural) =>
      join(contextDir, domain, plural, "*.md"),
    ),
  );
  const watcher = chokidar.watch(patterns, {
    ignored: ["**/.git/**", "**/.obsidian/**", "**/.DS_Store", "**/_*.md"],
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });

  const changeHandlers: Array<(p: string) => void> = [];
  const unlinkHandlers: Array<(p: string) => void> = [];

  watcher
    .on("add", (p: string) => changeHandlers.forEach((h) => h(p)))
    .on("change", (p: string) => changeHandlers.forEach((h) => h(p)))
    .on("unlink", (p: string) => unlinkHandlers.forEach((h) => h(p)));

  return {
    onChange(handler) {
      changeHandlers.push(handler);
    },
    onUnlink(handler) {
      unlinkHandlers.push(handler);
    },
    async close() {
      await watcher.close();
    },
  };
}
/* c8 ignore stop */
