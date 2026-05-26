import {
  DOMAINS,
  pluralToType,
  type Domain,
  type EntityType,
} from "@aitne/shared";

/**
 * Domain-index reconciler — pure render + diff for
 * `<contextDir>/<domain>/_index.md`
 * (docs/design/21-management-registry-and-entities.md §7.2 / §9.7).
 *
 * Inputs come from the `entities` SQLite mirror (P5 entity-mirror
 * reconciler). The pure layer here is responsible for:
 *
 *   - bucketing rows by `domain` (each domain renders one file),
 *   - producing the §9.7 markdown body deterministically,
 *   - exposing `renderActiveItemsTable` so tests can assert table-shape
 *     invariants without round-tripping through file I/O.
 *
 * The driver layer (`domain-index-runner.ts`) walks the buckets, reads
 * the existing on-disk file, compares output, and writes via the
 * atomic-write helper when a diff is detected.
 *
 * Determinism contract: the renderer is a pure function of its inputs.
 * For a given snapshot + `updated` value, the rendered string is byte-
 * identical across calls and across releases of the same schema.
 */

const EM_DASH = "—";

/**
 * One entity row consumed by the domain-index renderer. Mirrors the
 * `entities` table columns the renderer cares about. Lives here (not
 * in `entities-store.ts`) because the renderer does not use the
 * `EntityRecord` shape's parsed `sources` — it only renders the
 * lex-sorted source-key list, which is cheaper to compute from the
 * sidecar.
 */
export interface DomainIndexEntityInput {
  path: string;
  domain: Domain;
  type: EntityType;
  title: string;
  status: string | null;
  /** ISO date when present in frontmatter, else null. */
  date: string | null;
  /** ISO datetime — `last_synced_at`. Used as a fallback for "Last touched". */
  lastSyncedAt: string | null;
  /** Lex-sorted source keys (pre-aggregated from `entity_source_keys`). */
  sourceKeys: string[];
}

export interface DomainIndexBuckets {
  /** Domain → entities, sorted by display rules (see `bucketByDomain`). */
  byDomain: Map<Domain, DomainIndexEntityInput[]>;
}

/**
 * Group entities by their `domain` field. Within a bucket, rows are
 * ordered by:
 *   1. status precedence — `upcoming` and `active` first, `done` next,
 *      `archived` last, anything else (or null) interleaves alphabetically
 *      after `active`,
 *   2. `lastTouched` descending — fresher rows on top within a status,
 *   3. `path` ascending — final tiebreaker for determinism.
 *
 * Empty domains are still returned (with an empty array) so the runner
 * can produce a placeholder index file when a domain has no entities
 * yet (avoids a "missing index" warning on the dashboard).
 */
export function bucketByDomain(
  entities: readonly DomainIndexEntityInput[],
): DomainIndexBuckets {
  const byDomain = new Map<Domain, DomainIndexEntityInput[]>();
  for (const domain of DOMAINS) byDomain.set(domain, []);
  for (const entity of entities) {
    const bucket = byDomain.get(entity.domain);
    /* c8 ignore next 4 — `entity.domain` is typed as `Domain`, so the
       Map lookup is guaranteed to return a bucket; the branch exists
       only as a defensive guard against an out-of-enum row leaking
       past the type system. */
    if (!bucket) continue;
    bucket.push(entity);
  }
  for (const bucket of byDomain.values()) bucket.sort(compareForRender);
  return { byDomain };
}

const STATUS_ORDER: Record<string, number> = {
  upcoming: 0,
  active: 1,
  done: 3,
  archived: 4,
};

function statusRank(status: string | null): number {
  if (!status) return 2;
  return STATUS_ORDER[status] ?? 2;
}

function compareForRender(
  a: DomainIndexEntityInput,
  b: DomainIndexEntityInput,
): number {
  const sa = statusRank(a.status);
  const sb = statusRank(b.status);
  if (sa !== sb) return sa - sb;
  const ta = lastTouchedSortKey(a);
  const tb = lastTouchedSortKey(b);
  if (ta !== tb) return tb.localeCompare(ta);
  return a.path.localeCompare(b.path);
}

function lastTouchedSortKey(entity: DomainIndexEntityInput): string {
  // Prefer the structured `date` (a calendar anchor) for sort; fall
  // back to `last_synced_at` (a sync stamp) when `date` is absent.
  // Empty string sorts last under descending order, which is what we
  // want for entities with neither — they go to the bottom of their
  // status bucket.
  return entity.date ?? entity.lastSyncedAt ?? "";
}

/**
 * Format the "Last touched" column. Prefers `date` (ISO-date) over
 * `last_synced_at` (ISO-datetime, sliced to the YYYY-MM-DD prefix).
 */
export function formatLastTouched(entity: DomainIndexEntityInput): string {
  if (entity.date) return entity.date;
  if (entity.lastSyncedAt) return entity.lastSyncedAt.slice(0, 10);
  return EM_DASH;
}

/**
 * Format the source-keys column. Outputs `+`-joined keys for the
 * §9.7 example (`calendar+zoom+docs`); empty list renders an em-dash.
 */
export function formatSources(sourceKeys: readonly string[]): string {
  if (sourceKeys.length === 0) return EM_DASH;
  return sourceKeys.join("+");
}

/**
 * Render the §9.7 file body for a single domain.
 *
 *   - frontmatter → `type: index`, `domain: <d>`, `auto_generated:
 *     true`, `last_built: <updated>`,
 *   - H1 with `<Capitalised Domain> — Index`,
 *   - H2 "Active items" with the §9.7 table layout.
 *
 * The renderer never throws on empty input; an empty domain emits the
 * frontmatter, the H1, the H2, and an em-dash placeholder row — so the
 * file remains schema-valid for the prompt assembly path.
 */
export function renderDomainIndex(
  domain: Domain,
  entities: readonly DomainIndexEntityInput[],
  updated: string,
): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push("type: index");
  lines.push(`domain: ${domain}`);
  lines.push("auto_generated: true");
  lines.push(`last_built: ${updated}`);
  lines.push("---");
  lines.push(`# ${capitalize(domain)} — Index`);
  lines.push("");
  lines.push("## Active items");
  lines.push("");
  lines.push("| Title | Type | Sources | Status | Last touched |");
  lines.push("|---|---|---|---|---|");
  if (entities.length === 0) {
    lines.push(`| ${EM_DASH} | ${EM_DASH} | ${EM_DASH} | ${EM_DASH} | ${EM_DASH} |`);
  } else {
    for (const entity of entities) lines.push(renderRow(entity));
  }
  lines.push("");
  return lines.join("\n");
}

function renderRow(entity: DomainIndexEntityInput): string {
  return [
    "|",
    escapeCell(entity.title),
    "|",
    escapeCell(entity.type),
    "|",
    escapeCell(formatSources(entity.sourceKeys)),
    "|",
    escapeCell(entity.status ?? EM_DASH),
    "|",
    escapeCell(formatLastTouched(entity)),
    "|",
  ].join(" ");
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim() || EM_DASH;
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

// ── Path resolution ────────────────────────────────────────────────────────

/**
 * Relative path to a domain's `_index.md`. Stable across releases — the
 * runner uses this to resolve the absolute write target.
 */
export function relativeDomainIndexPath(domain: Domain): string {
  return `knowledge/entities/${domain}/_index.md`;
}

/**
 * Validate a relative path looks like a domain index. Used by the
 * runner's safety check before writing — defense-in-depth against a
 * caller-supplied domain that was tampered with.
 *
 * After CONTEXT_VAULT_REDESIGN domain indexes live at
 * `knowledge/entities/<domain>/_index.md`.
 */
export function isDomainIndexPath(relativePath: string): boolean {
  const segments = relativePath.split("/");
  if (segments.length !== 4) return false;
  if (segments[0] !== "knowledge") return false;
  if (segments[1] !== "entities") return false;
  if (segments[3] !== "_index.md") return false;
  return (DOMAINS as readonly string[]).includes(segments[2]);
}

/**
 * Map an L2 entity directory back to its parent domain. Returns `null`
 * when the path is not a recognised entity directory (defense in depth
 * for tests that exercise foreign paths).
 */
export function entityDirToDomain(relativeDir: string): Domain | null {
  const segments = relativeDir.split("/");
  if (segments.length !== 2) return null;
  const [domain, plural] = segments;
  if (!(DOMAINS as readonly string[]).includes(domain)) return null;
  if (pluralToType(plural) === null) return null;
  return domain as Domain;
}
