import { z } from "zod";

/**
 * Docs & QA frontmatter schema (DOCS_QA_DESIGN.md §7).
 *
 * Shared between the daemon (indexer, FTS5 row builder) and dashboard
 * (renderer, ?-button map). The schema is `.strict()` — unknown top-level
 * keys must move under `extra:`. This is deliberate: loose passthrough lets
 * typos like `tag:` (instead of `tags:`) silently bypass validation.
 *
 * Forward-compat is provided via `schema_version` + the `extra` bag.
 */

export const DOCS_SCHEMA_VERSION = 1 as const;

const DOC_CATEGORIES = [
  "getting-started",
  "concepts",
  "features",
  "guides",
  "troubleshooting",
  "reference",
  "glossary",
] as const;
export type DocCategory = (typeof DOC_CATEGORIES)[number];

const DOC_STATUS = ["stable", "beta", "experimental", "draft", "deprecated"] as const;
export type DocStatus = (typeof DOC_STATUS)[number];

/**
 * Slug grammar: lowercase ASCII letters/digits with `/` separators and
 * `-` inside a segment. The first segment must be one of the known
 * categories, but the schema enforces only the shape — the cross-check
 * `slug.split('/')[0] === category` lives in the indexer because it
 * needs the runtime category value.
 *
 * Example: `features/routines/morning-routine`
 */
const slugSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(
    /^[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\/[a-z0-9]+(?:[-_][a-z0-9]+)*)*$/,
    "slug must be lowercase kebab-case path segments separated by '/'",
  );

/**
 * Cross-link target: same shape as `slug`, but used in `related:` /
 * `prerequisites:` / `supersedes:` lists. Kept as a separate alias so a
 * future grammar change to one side doesn't silently widen the other.
 */
const slugRefSchema = slugSchema;

/** Short id used in `[[id]]` cross-references. ASCII kebab-case only. */
const docIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "id must be lowercase kebab-case");

/** YAML date — ISO-8601 calendar date (`YYYY-MM-DD`). */
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

/**
 * Dashboard route used as a `ui_anchors` entry. Must start with `/` and
 * may carry a query string. The drift-guard test cross-checks each
 * value against `dashboard/src/app/**\/page.tsx` (DOCS_QA_DESIGN.md §8.3).
 */
const uiAnchorSchema = z
  .string()
  .min(1)
  .regex(/^\/[A-Za-z0-9\-_/?=&%.]*$/, "ui_anchors entries must look like a dashboard path");

export const docsFrontmatterSchema = z
  .object({
    // === Identity (required) ===
    schema_version: z.literal(DOCS_SCHEMA_VERSION),
    slug: slugSchema,
    title: z.string().min(1).max(200),

    // === Identity (recommended) ===
    id: docIdSchema.optional(),
    aliases: z.array(z.string().min(1).max(120)).max(32).optional(),

    // === Classification (required) ===
    category: z.enum(DOC_CATEGORIES),
    summary: z.string().min(1).max(2000),

    // === Classification (recommended) ===
    section: z.string().min(1).max(64).optional(),
    tags: z.array(z.string().min(1).max(64)).max(32).optional(),
    status: z.enum(DOC_STATUS).optional(),
    ask_examples: z.array(z.string().min(1).max(240)).max(16).optional(),

    // === Classification (optional) ===
    locale: z.string().min(2).max(16).optional(),

    // === Lifecycle (optional) ===
    created: isoDateSchema.optional(),
    updated: isoDateSchema.optional(),
    review_due: isoDateSchema.optional(),
    supersedes: z.array(slugRefSchema).max(16).optional(),

    // === Search (optional but valuable) ===
    keywords: z.array(z.string().min(1).max(120)).max(32).optional(),

    // === Cross-links (optional) ===
    related: z.array(slugRefSchema).max(32).optional(),
    prerequisites: z.array(slugRefSchema).max(16).optional(),

    // === System bindings (optional — drives ?-button + filtering) ===
    ui_anchors: z.array(uiAnchorSchema).max(32).optional(),
    process_keys: z.array(z.string().min(1).max(120)).max(32).optional(),
    config_keys: z.array(z.string().min(1).max(120)).max(32).optional(),
    api_endpoints: z.array(z.string().min(1).max(160)).max(32).optional(),
    context_files: z.array(z.string().min(1).max(160)).max(32).optional(),

    // === Forward-compat escape hatch ===
    // Zod 4.x: z.record(keySchema, valueSchema). The previous one-arg
    // form (`z.record(z.unknown())`) compiled but threw at parse time.
    extra: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type DocsFrontmatter = z.infer<typeof docsFrontmatterSchema>;

/**
 * Slugify an H1/H2/H3 heading text into the anchor id used inside
 * `[doc:slug#anchor]` citations. Mirrors the rule the dashboard renderer
 * is expected to use (lower, replace whitespace with `-`, drop punctuation).
 *
 * Kept in `shared` so the citation post-processor (daemon) and the
 * citation pill renderer (dashboard) cannot drift.
 */
export function slugifyAnchor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

/** Citation token shape: `[doc:slug#anchor]`. Anchor is optional. */
const CITATION_RE = /\[doc:([a-z0-9][a-z0-9\-_/]*)(?:#([a-z0-9][a-z0-9-]*))?\]/g;

export interface ParsedCitationToken {
  /** Index in the source string where `[doc:` starts. */
  start: number;
  /** Index in the source string just past the closing `]`. */
  end: number;
  slug: string;
  anchor: string | null;
  raw: string;
}

/** Find every `[doc:slug#anchor]` token in `text`. */
export function parseCitationTokens(text: string): ParsedCitationToken[] {
  const out: ParsedCitationToken[] = [];
  CITATION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CITATION_RE.exec(text)) !== null) {
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      slug: m[1]!,
      anchor: m[2] ?? null,
      raw: m[0],
    });
  }
  return out;
}
