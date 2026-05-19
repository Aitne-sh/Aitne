import type Database from "better-sqlite3";
import {
  isDomain,
  isEntityType,
  pluralToType,
  parseEntityPath,
  type Domain,
  type EntityType,
} from "@aitne/shared";

/**
 * Entity-mirror read helpers (docs/design/21-management-registry-and-
 * entities.md §7.6 lookup contract).
 *
 * The `entities` SQLite table is a watcher-maintained mirror of the
 * L2 `<contextDir>/<domain>/<type-plural>/<slug>.md` tree — NOT
 * authoritative (§7.6 "Why not authoritative SQLite"). The MD file
 * wins on divergence; the boot pass rebuilds the mirror from disk.
 *
 * This module is read-only. The watcher / boot reconciler that
 * populates `entities` + `entity_source_keys` lives at
 * `core/entity-mirror.ts` (P5 deliverable). The route layer
 * (`api/routes/entities.ts`) is the consumer here; the scheduled-
 * managed-task skill (§10.4 step 4a) and the query path (§7.5 step 3)
 * both reach the table through the route, never directly.
 */

interface EntityRow {
  path: string;
  domain: string;
  type: string;
  slug: string;
  title: string;
  status: string | null;
  date: string | null;
  last_synced_at: string | null;
  sources_json: string;
}

/**
 * Public entity DTO. `sources` is the parsed `frontmatter.sources` map
 * — keys are user-typed app labels, matching the `App` column in
 * `rules/management.md`. The route layer serializes this directly.
 */
export interface EntityRecord {
  path: string;
  domain: Domain;
  type: EntityType;
  slug: string;
  title: string;
  status: string | null;
  date: string | null;
  lastSyncedAt: string | null;
  sources: Record<string, unknown>;
}

function rowToRecord(row: EntityRow): EntityRecord | null {
  // The mirror is built from validated frontmatter, but this is the
  // boundary between SQL strings and the public TS contract — the
  // domain/type fields go through `isDomain` / `pluralToType` so a
  // hand-poked row (or an out-of-date schema) cannot smuggle an unknown
  // value into the route response.
  if (!isDomain(row.domain)) return null;
  if (!isEntityType(row.type)) return null;
  let sources: Record<string, unknown>;
  try {
    const parsed = JSON.parse(row.sources_json);
    sources =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
  } catch {
    sources = {};
  }
  return {
    path: row.path,
    domain: row.domain,
    type: row.type,
    slug: row.slug,
    title: row.title,
    status: row.status,
    date: row.date,
    lastSyncedAt: row.last_synced_at,
    sources,
  };
}

const SELECT_COLUMNS =
  "path, domain, type, slug, title, status, date, last_synced_at, sources_json";

/**
 * §7.6 tier-1 lookup: exact `(source_key, external_id)` match. Joins
 * the `entity_source_keys` sidecar (§7.6.1) to use its index, then
 * extracts the per-source `external_id` from the JSON blob.
 *
 * Source-key matching is case-insensitive — the sidecar's
 * `source_key_normalized` column collapses every casing variant onto
 * the same bucket so a caller passing `"Zoom"` still matches an entity
 * that wrote `sources.ZOOM` to its frontmatter. The JSON-path
 * extraction below uses `k.source_key` (verbatim) so the per-row
 * casing of the stored sidecar key is what reads the JSON blob —
 * lowercasing the JSON path would break entries whose verbatim key is
 * not lower-case.
 *
 * Returns 0..N matches. Multiple matches are valid in principle (an
 * external_id could be reused across two entities the user explicitly
 * wants to keep separate), but the lookup is intended for the
 * scheduled-managed-task skill's "is this row already mirrored?"
 * probe which expects ≤ 1 hit.
 */
export function findEntitiesBySource(
  db: Database.Database,
  sourceKey: string,
  externalId: string,
): EntityRecord[] {
  if (!sourceKey || !externalId) return [];
  // Qualify every column with the `e.` alias — `path` is in both
  // `entities` and `entity_source_keys`, so the bare reference is
  // ambiguous to SQLite's column resolver. `DISTINCT` guards against
  // an entity that carries the same `external_id` under multiple
  // casing variants of the source key (`sources.Zoom` AND
  // `sources.ZOOM` both pointing to `zm_x`) — both sidecar rows match
  // the case-insensitive WHERE so the JOIN would otherwise surface
  // the entity twice.
  const rows = db
    .prepare(
      `SELECT DISTINCT e.path, e.domain, e.type, e.slug, e.title, e.status,
              e.date, e.last_synced_at, e.sources_json
         FROM entities e
         JOIN entity_source_keys k ON k.path = e.path
        WHERE k.source_key_normalized = ?
          AND json_extract(
                e.sources_json,
                '$.' || k.source_key || '.external_id'
              ) = ?
        ORDER BY e.path ASC`,
    )
    .all(sourceKey.toLowerCase(), externalId) as EntityRow[];
  return rows
    .map(rowToRecord)
    .filter((r): r is EntityRecord => r !== null);
}

/**
 * Bias-input lookup for the `managed-tasks` skill's `## Register` flow
 * (Step 4a — Decide `output_path`). Returns every entity carrying a
 * `sources.<sourceKey>.*` binding regardless of `external_id`. Used so
 * the registration flow can pick the `(domain, type)` already dominant
 * for that app instead of guessing from the probe sample shape alone.
 *
 * Distinct from `findEntitiesBySource` (which requires both the key
 * and the id) because the bias query has no candidate id yet — it
 * runs at registration time, before any datum has been fetched.
 */
export function findEntitiesBySourceKey(
  db: Database.Database,
  sourceKey: string,
  limit?: number,
): EntityRecord[] {
  if (!sourceKey) return [];
  const cap = clampLimit(limit, 50, 200);
  // Case-insensitive match via the sidecar's normalised column — see
  // {@link findEntitiesBySource} for the rationale.
  const rows = db
    .prepare(
      `SELECT DISTINCT e.path, e.domain, e.type, e.slug, e.title, e.status,
              e.date, e.last_synced_at, e.sources_json
         FROM entities e
         JOIN entity_source_keys k ON k.path = e.path
        WHERE k.source_key_normalized = ?
        ORDER BY e.path ASC
        LIMIT ?`,
    )
    .all(sourceKey.toLowerCase(), cap) as EntityRow[];
  return rows
    .map(rowToRecord)
    .filter((r): r is EntityRecord => r !== null);
}

/**
 * §7.6 tier-2 lookup: fall-back when the upstream app does not expose
 * a stable `external_id`. Matches on `(domain, type, date)` and
 * (optionally) a substring of `title` (case-insensitive).
 *
 * `date` is the ISO-`YYYY-MM-DD` form pulled from the entity
 * frontmatter; the column is indexed (idx_entities_domain_type_date).
 * The `title` filter is a `LIKE %q%` over the indexed-by-prefix path
 * but is intentionally not a full-text search — that lives at
 * tier 3 (`fts_docs`, §7.6 lookup precedence) and is out of scope for
 * this lookup helper.
 */
export interface FindEntitiesByDateInput {
  domain: Domain;
  type: EntityType;
  /** ISO `YYYY-MM-DD`. */
  date: string;
  /** Optional case-insensitive substring of `title`. */
  q?: string;
  limit?: number;
}

export function findEntitiesByDomainTypeDate(
  db: Database.Database,
  input: FindEntitiesByDateInput,
): EntityRecord[] {
  const limit = clampLimit(input.limit, 50, 200);
  const params: (string | number)[] = [input.domain, input.type, input.date];
  let where = "domain = ? AND type = ? AND date = ?";
  if (input.q) {
    where += " AND title LIKE ? COLLATE NOCASE";
    params.push(`%${escapeLike(input.q)}%`);
  }
  params.push(limit);
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLUMNS}
         FROM entities
        WHERE ${where}
        ORDER BY path ASC
        LIMIT ?`,
    )
    .all(...params) as EntityRow[];
  return rows
    .map(rowToRecord)
    .filter((r): r is EntityRecord => r !== null);
}

/**
 * Exact-path lookup (`GET /api/entities/by-path`). Returns `null` when
 * the path is malformed or no row matches; the route translates the
 * latter into a 404. The path validator runs before the DB hit so a
 * bad `domain` / `type-plural` returns 404 without a SQL roundtrip.
 */
export function getEntityByPath(
  db: Database.Database,
  path: string,
): EntityRecord | null {
  if (!parseEntityPath(path)) return null;
  const row = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM entities WHERE path = ?`)
    .get(path) as EntityRow | undefined;
  return row ? rowToRecord(row) : null;
}

/**
 * Sanity helper for routes — returns a normalized `(domain, type)`
 * pair from a `<domain>/<type-plural>/` partial path, or `null` when
 * either segment is unrecognised. Lives here (not in
 * management-domains.ts) because it is a route-layer convenience
 * over the shared validators, not a property of the L2 schema itself.
 */
export function resolveDomainType(
  domain: string,
  typePluralOrSingular: string,
): { domain: Domain; type: EntityType } | null {
  if (!isDomain(domain)) return null;
  const pluralMatch = pluralToType(typePluralOrSingular);
  if (pluralMatch !== null) return { domain, type: pluralMatch };
  if (isEntityType(typePluralOrSingular)) {
    return { domain, type: typePluralOrSingular };
  }
  return null;
}

function clampLimit(
  raw: number | undefined,
  defaultValue: number,
  max: number,
): number {
  if (raw === undefined) return defaultValue;
  if (!Number.isFinite(raw) || raw < 1) return defaultValue;
  return Math.min(Math.floor(raw), max);
}

function escapeLike(value: string): string {
  // SQLite LIKE: backslash is the default escape character only when
  // ESCAPE is specified. Strip it from user input together with `%`/`_`
  // so a free-form title query cannot smuggle a wildcard. The mirror
  // is a recall aid, not an exact-match contract — collapsing wildcard
  // metacharacters keeps the API contract simple.
  return value.replace(/[\\%_]/g, "");
}
