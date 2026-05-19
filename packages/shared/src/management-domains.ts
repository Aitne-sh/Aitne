import { z } from "zod";
import { recurrenceRuleSchema } from "./schemas.js";

/**
 * Management Registry — shared types and validators.
 *
 * This module is the single source of truth for the four-layer management
 * model defined in `docs/design/21-management-registry-and-entities.md`:
 *
 *   - L1 — `rules/management.md` SoT bindings (Section A) and Managed
 *     Tasks (Section B).
 *   - L2 — Entity files at `context/<domain>/<type-plural>/<slug>.md`.
 *   - L3 — `context/_activity/<source>.md` (auto-generated).
 *   - L4 — `agent_actions` / `md_file_snapshots` (existing audit tables).
 *
 * Pure-logic only — no I/O, no DB access, no fs. Imported by the daemon
 * (`api/routes/managed-tasks.ts`, `core/management-registry.ts`,
 * `core/entity-mirror.ts`), the dashboard (Settings → Management page,
 * entity browser), and skill prompts.
 *
 * 100% coverage is required (see `vitest.config.ts`'s curated set).
 */

// ── Domains (§9.4) ────────────────────────────────────────────────────────

/**
 * The fixed v1 domain enum (§8.8). Drives:
 *   - L2 directory layout (`context/<domain>/<type-plural>/<slug>.md`),
 *   - SoT-binding rows (Section A of management.md),
 *   - Managed-task `Output path` validation (§9.1 render rules),
 *   - dashboard navigation tabs.
 *
 * Custom user-defined domains are deferred to v4 (OQ-1). Adding a new
 * value here is an additive change; removing one is a breaking change.
 */
export const DOMAINS = [
  "work",
  "travel",
  "finance",
  "personal",
  "health",
  "learning",
] as const;

export type Domain = (typeof DOMAINS)[number];

const DOMAIN_SET: ReadonlySet<string> = new Set(DOMAINS);

export function isDomain(value: unknown): value is Domain {
  return typeof value === "string" && DOMAIN_SET.has(value);
}

// ── Entity types (§9.3) ───────────────────────────────────────────────────

/**
 * The fixed v1 entity-type enum. Each `type` corresponds to exactly one
 * directory name (the plural form). Adding a new type requires:
 *   1. an entry here,
 *   2. a `TYPE_PLURALS` entry,
 *   3. an EntitySchema enum bump,
 *   4. a dashboard tab if user-visible.
 *
 * Singular form is the canonical identifier (matches frontmatter `type`);
 * the plural form is derived from `TYPE_PLURALS`.
 */
export const ENTITY_TYPES = [
  "meeting",
  "trip",
  "receipt",
  "project",
  "book",
  "note",
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

const ENTITY_TYPE_SET: ReadonlySet<string> = new Set(ENTITY_TYPES);

export function isEntityType(value: unknown): value is EntityType {
  return typeof value === "string" && ENTITY_TYPE_SET.has(value);
}

/**
 * Singular → plural map. The plural form is the directory segment in
 * L2 paths (`context/<domain>/<type-plural>/<slug>.md`). Static — no
 * inflection library is used (§9.3).
 */
export const TYPE_PLURALS: Readonly<Record<EntityType, string>> = {
  meeting: "meetings",
  trip: "trips",
  receipt: "receipts",
  project: "projects",
  book: "books",
  note: "notes",
};

const PLURAL_TO_TYPE: ReadonlyMap<string, EntityType> = new Map(
  ENTITY_TYPES.map((t) => [TYPE_PLURALS[t], t]),
);

export function pluralToType(plural: string): EntityType | null {
  return PLURAL_TO_TYPE.get(plural) ?? null;
}

// ── Caps & limits (§13.2) ─────────────────────────────────────────────────

/** Max length of the user-typed `App` label rendered in management.md. */
export const APP_MAX_LENGTH = 64;

/** Max length of the `Intent` description on a managed task. */
export const INTENT_MAX_LENGTH = 200;

/** Max length of `last_result` (free text). */
export const LAST_RESULT_MAX_LENGTH = 120;

/** Default cap on active managed tasks (NFR-8); configurable. */
export const MANAGEMENT_MAX_ACTIVE_TASKS_DEFAULT = 100;

/** Soft warning threshold surfaced on the dashboard (§NFR-1a). */
export const MANAGEMENT_ACTIVE_TASKS_SOFT_WARNING = 30;

/** Default minimum cadence interval, in minutes (§13.2). */
export const MANAGEMENT_MIN_CADENCE_MINUTES_DEFAULT = 5;

/** Default consecutive-failure count before notifying the owner (§10.4). */
export const MANAGEMENT_FAILURE_NOTIFY_THRESHOLD_DEFAULT = 3;

// ── String validators (§13.3) ─────────────────────────────────────────────

const APP_FORBIDDEN_CHARS = /[\n\r|]/;

/**
 * Reasons a user-typed label can fail validation. Returned as a discriminated
 * union so Zod transforms (and any future caller) can surface a specific
 * message instead of a generic `null`.
 */
export type LabelError =
  | { kind: "empty" }
  | { kind: "too-long"; max: number }
  | { kind: "forbidden-char" };

/**
 * Trim, NFC-normalize, and validate a user-typed `App` label. Rejects
 * empty input, newlines, and pipe characters (would break the rendered
 * Markdown table). Returns `null` on rejection so callers can format
 * the error in their context. The Zod schemas use `validateLabel`
 * directly to surface a specific failure reason in the issue message.
 */
export function validateAppLabel(value: string): string | null {
  const r = validateLabel(value, APP_MAX_LENGTH);
  return r.ok ? r.value : null;
}

/**
 * Lowercase + collapse-whitespace form used as the dedup key in
 * `managed_tasks.app_normalized` (§9.2). Two visually-different inputs
 * that map to the same normalized form are considered the same app
 * for dedup purposes (§12 failure modes).
 *
 * Caller is expected to have run `validateAppLabel` first; this function
 * is purely lexical and does not enforce length / forbidden-char caps.
 */
export function normalizeAppLabel(value: string): string {
  return value.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Trim, NFC-normalize, and validate a user-typed `Intent` description.
 * Same rules as `validateAppLabel` but with `INTENT_MAX_LENGTH` cap.
 */
export function validateIntent(value: string): string | null {
  const detailed = validateLabel(value, INTENT_MAX_LENGTH);
  return detailed.ok ? detailed.value : null;
}

/** Internal — shared validator for app/intent/category labels. */
function validateLabel(
  value: string,
  max: number,
): { ok: true; value: string } | { ok: false; reason: LabelError } {
  const cleaned = value.normalize("NFC").trim();
  if (!cleaned) return { ok: false, reason: { kind: "empty" } };
  if (cleaned.length > max)
    return { ok: false, reason: { kind: "too-long", max } };
  if (APP_FORBIDDEN_CHARS.test(cleaned))
    return { ok: false, reason: { kind: "forbidden-char" } };
  return { ok: true, value: cleaned };
}

function labelErrorMessage(field: string, reason: LabelError): string {
  switch (reason.kind) {
    case "empty":
      return `${field} must not be empty after trimming`;
    case "too-long":
      return `${field} must be ≤ ${reason.max} chars`;
    case "forbidden-char":
      return `${field} must not contain newline or pipe characters`;
  }
}

/**
 * Build a Zod schema fragment that accepts a raw string, applies
 * `validateLabel(field, max)`, and emits a specific issue on failure.
 * Used by every public input schema that takes a user-typed label so the
 * trim/NFC/forbidden-char invariants are enforced at the API boundary
 * (§13.3) — not just in the standalone helpers.
 */
function trimmedLabel(field: string, max: number) {
  return z.string().transform((val, ctx) => {
    const r = validateLabel(val, max);
    if (!r.ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: labelErrorMessage(field, r.reason),
      });
      return z.NEVER;
    }
    return r.value;
  });
}

// ── Slug validator (§9.3) ─────────────────────────────────────────────────

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const SLUG_MAX_LENGTH = 100;

/**
 * Lowercase kebab-case slug. Must start with `[a-z0-9]`, may contain
 * `-`. Used as the file-name segment of an entity path. Length-capped
 * to keep filesystem paths well under typical `PATH_MAX` limits.
 */
export function isValidSlug(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= SLUG_MAX_LENGTH &&
    SLUG_RE.test(value)
  );
}

// ── Path validators (§9.1, §9.3) ──────────────────────────────────────────

/**
 * Components extracted from a parsed entity path. Returned by
 * `parseEntityPath`; used by API routes and the entity-mirror watcher
 * to look up/insert into the `entities` SQLite table.
 */
export interface EntityPathParts {
  domain: Domain;
  type: EntityType;
  /** Plural directory segment (e.g. "meetings"). */
  typePlural: string;
  slug: string;
  /** Reconstructed canonical path: `<domain>/<type-plural>/<slug>.md`. */
  path: string;
}

const PATH_TRAVERSAL_RE = /(^|\/)\.\.(\/|$)/;

/**
 * Validate an `Output path` value rendered in management.md's B-section
 * (§9.1 render rules). The path:
 *
 *   - is relative (no leading `/`),
 *   - has exactly two segments: `<domain>/<type-plural>/`,
 *   - ends with a trailing `/`,
 *   - contains no `..` traversal,
 *   - has a `<domain>` in `DOMAINS` and `<type-plural>` in `TYPE_PLURALS`.
 *
 * The leading `context/` is implicit (every L2 path lives there). The
 * SQL `CHECK (output_path IS NULL OR output_path LIKE '%/')` constraint
 * (§9.2) is the DB-side enforcement; this function is the renderer/
 * parser-side enforcement.
 */
export function isValidOutputPath(value: string): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.startsWith("/")) return false;
  if (PATH_TRAVERSAL_RE.test(value)) return false;
  if (!value.endsWith("/")) return false;
  // Strip trailing slash and split — must have exactly two segments.
  const segments = value.slice(0, -1).split("/");
  if (segments.length !== 2) return false;
  const [domain, typePlural] = segments;
  if (!domain || !typePlural) return false;
  if (!isDomain(domain)) return false;
  if (pluralToType(typePlural) === null) return false;
  return true;
}

/**
 * Parse an entity-file path of the form
 * `<domain>/<type-plural>/<slug>.md` into its components. Returns
 * `null` when the path is malformed or any segment fails its enum
 * check. The leading `context/` MUST already be stripped — this is
 * the relative form used in `entities.path`.
 */
export function parseEntityPath(path: string): EntityPathParts | null {
  if (typeof path !== "string" || path.length === 0) return null;
  if (path.startsWith("/")) return null;
  if (PATH_TRAVERSAL_RE.test(path)) return null;
  if (!path.endsWith(".md")) return null;
  const segments = path.split("/");
  if (segments.length !== 3) return null;
  const [domain, typePlural, fileName] = segments;
  if (!domain || !typePlural || !fileName) return null;
  if (!isDomain(domain)) return null;
  const type = pluralToType(typePlural);
  if (type === null) return null;
  const slug = fileName.slice(0, -3); // strip ".md"
  if (!isValidSlug(slug)) return null;
  return { domain, type, typePlural, slug, path };
}

// ── Managed-task ID (§9.2, §13.3) ─────────────────────────────────────────

const MT_ID_RE = /^mt_[1-9]\d*$/;

/**
 * Validate a managed-task identifier. Format: `mt_<n>` where n is a
 * positive decimal with no leading zeros. Allocated by
 * `managed_task_seq` (§9.2); IDs are never reused so historical
 * `agent_actions` references stay unambiguous.
 */
export function isValidManagedTaskId(value: unknown): value is string {
  return typeof value === "string" && MT_ID_RE.test(value);
}

/** Format a numeric sequence value as a managed-task id. */
export function formatManagedTaskId(seq: number): string {
  if (!Number.isInteger(seq) || seq < 1) {
    throw new RangeError(
      `managed-task sequence must be a positive integer, got ${seq}`,
    );
  }
  return `mt_${seq}`;
}

// ── Zod schemas (§9.3, §9.5, §9.2) ────────────────────────────────────────

/**
 * Per-source frontmatter sub-record on an entity file. Each contributing
 * app gets one entry under `frontmatter.sources.<key>`. The map key is
 * the user-typed app label — the same string that appears in
 * management.md's `App` column. This is the cross-link between L1 and
 * L2 (§8.2 ADR — entity-per-file, not app-per-file).
 *
 * `passthrough` permits app-specific fields beyond the four named ones
 * without forcing a schema bump per integration.
 */
export const entitySourceEntrySchema = z
  .object({
    /** App-internal id (free-form, e.g. Google Doc id). */
    id: z.string().optional(),
    /** Canonical URL into the source app for human follow-through. */
    url: z.string().url().optional(),
    /**
     * Stable upstream identifier — the strongest signal for the §7.6
     * lookup contract's tier-1 dedup match.
     */
    external_id: z.string().optional(),
  })
  .passthrough();

export type EntitySourceEntry = z.infer<typeof entitySourceEntrySchema>;

/**
 * EntitySchema — frontmatter schema for L2 entity files (§9.3).
 *
 * Validated on every PATCH to `/api/context/<domain>/<type-plural>/
 * <slug>.md` and by the entity-mirror watcher before a row is upserted
 * into the `entities` SQLite table.
 */
export const entitySchema = z.object({
  type: z.enum(ENTITY_TYPES),
  domain: z.enum(DOMAINS),
  slug: z.string().refine(isValidSlug, "invalid slug"),
  title: z.string().min(1).max(200),
  status: z.enum(["upcoming", "active", "done", "archived"]).optional(),
  /**
   * Map of app-label → per-app metadata. Keys are user-typed strings;
   * Zod `record` enforces non-empty string keys at parse time.
   */
  sources: z.record(z.string().min(1), entitySourceEntrySchema).default({}),
  /** Wikilinks / paths to related entities. */
  related: z.array(z.string()).default([]),
  /** Free-form classification labels. */
  tags: z.array(z.string()).default([]),
  /** ISO-8601 datetime — when the entity file was first created. */
  created: z.string().datetime(),
  /** ISO-8601 datetime — most recent successful sync from any source. */
  last_synced_at: z.string().datetime().optional(),
});

export type Entity = z.infer<typeof entitySchema>;

/**
 * SotBindingSchema — one row of management.md's Section A (§9.5).
 *
 * Persisted in `settings(key='sot_bindings', value_json=...)` as a JSON
 * array; mirrors the §A render in management.md.
 *
 * **`category` vs `Domain` (resolves design-doc §9.1/§9.5 ambiguity).**
 * §9.1's example A-section renders rows like `tasks → notion`,
 * `meetings → google_calendar+zoom`, `notes → obsidian` — values that
 * are **not** in the §9.4 `DOMAINS` enum (which lists life-areas:
 * `work`, `travel`, `finance`, `personal`, `health`, `learning`).
 *
 * SoT bindings are coarse data-categories independent of life-area —
 * the v2 template's "Category" column made this explicit, and OQ-3
 * defers per-life-area SoT bindings to v4. So `category` is a
 * free-form, validated string here, **not** a `Domain`. Rendering uses
 * a "Category" column header.
 */
export const sotBindingSchema = z.object({
  /**
   * Free-form data-category label (e.g. `tasks`, `meetings`, `notes`,
   * `projects`). Validated with the same trim/NFC/forbidden-char rules
   * as `App`.
   */
  category: trimmedLabel("category", APP_MAX_LENGTH),
  /** Free-form, user-typed canonical app label (e.g. "notion"). */
  sotApp: trimmedLabel("sotApp", APP_MAX_LENGTH),
  /**
   * Optional path to a local mirror MD file (e.g. `context/work/tasks-
   * index.md`). `null` when the SoT is external-only and no local
   * mirror is maintained.
   */
  mirrorPath: z.string().min(1).max(255).nullable(),
  /** Free-text policy note (≤200 chars). `null` when no policy applies. */
  policy: z.string().max(200).nullable(),
  /** Who is permitted to write the canonical store / its mirror. */
  writer: z.enum(["agent", "shared", "user"]),
});

export type SotBinding = z.infer<typeof sotBindingSchema>;

export const sotBindingsSchema = z.array(sotBindingSchema);
export type SotBindings = z.infer<typeof sotBindingsSchema>;

/**
 * ManagedTaskSchema — DB-row shape for `managed_tasks` (§9.2).
 *
 * Matches the table column order; consumed by API GET responses and
 * by the management.md renderer. Strings here represent the **stored**
 * (already-cleaned) form — per-input cleaning lives on
 * `managedTaskCreateSchema` / `managedTaskPatchSchema` so a row read
 * from the DB does not get re-trimmed every load.
 */
export const managedTaskSchema = z.object({
  id: z.string().refine(isValidManagedTaskId, "must match /^mt_[1-9]\\d*$/"),
  intent: z.string().min(1).max(INTENT_MAX_LENGTH),
  app: z.string().min(1).max(APP_MAX_LENGTH),
  app_normalized: z.string().min(1).max(APP_MAX_LENGTH),
  cadence: z.string().min(1).max(200),
  /**
   * `output_path` is nullable only between row creation and the first
   * successful run (FR-16). Validated against `isValidOutputPath` when
   * non-null.
   */
  output_path: z
    .string()
    .nullable()
    .refine(
      (v) => v === null || isValidOutputPath(v),
      "output_path must be `<domain>/<type-plural>/` (see §9.1)",
    ),
  schedule_id: z.number().int().positive(),
  /** ISO-8601 UTC; `null` until the first successful fire. */
  last_run_at: z.string().datetime().nullable(),
  last_result: z.string().max(LAST_RESULT_MAX_LENGTH).nullable(),
  consecutive_failures: z.number().int().nonnegative(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type ManagedTask = z.infer<typeof managedTaskSchema>;

/**
 * Request body for `POST /api/managed-tasks` (§10.1 step 5).
 *
 * The structured `recurrenceRule` (frequency + time + tz + days) is
 * threaded directly into the underlying `recurring_schedules` row
 * (`db/recurring-schedules.ts` consumes this exact shape). The server
 * allocates `mt_id` and `schedule_id` itself. `app` and `intent` are
 * trimmed/NFC-normalized at this boundary so the downstream rendering
 * and dedup paths see a clean value (§13.3).
 *
 * Note: the design doc (§10.1, §10.4) frames the cadence as `cron`+`tz`
 * for prose readability, but the daemon's recurrence engine has never
 * accepted raw cron — `RecurrenceRule` is the canonical shape. The
 * registration skill resolves the user's natural-language phrasing
 * (`"daily 10:00 (Asia/Tokyo)"`) into both:
 *   - `cadence` (free text rendered in management.md), and
 *   - `recurrenceRule` (the executable form).
 */
export const managedTaskCreateSchema = z.object({
  intent: trimmedLabel("intent", INTENT_MAX_LENGTH),
  app: trimmedLabel("app", APP_MAX_LENGTH),
  /**
   * Human-readable cadence (e.g. "daily 10:00 (Asia/Tokyo)"). Length
   * cap is intentionally generous; the structured `recurrenceRule` is
   * the executable form, this string is the rendered form.
   */
  cadence: z.string().min(1).max(200),
  /** Structured recurrence — the same shape `recurring_schedules` uses. */
  recurrenceRule: recurrenceRuleSchema,
  /** Optional initial output path; first run populates it when omitted. */
  output_path: z
    .string()
    .refine(
      (v) => isValidOutputPath(v),
      "output_path must be `<domain>/<type-plural>/` (see §9.1)",
    )
    .optional(),
});

export type ManagedTaskCreate = z.infer<typeof managedTaskCreateSchema>;

/**
 * Request body for `PATCH /api/managed-tasks/:id` (§10.2).
 *
 * Any subset of mutable columns. The `id`, `app`, `app_normalized`,
 * `schedule_id`, and timestamps are NOT mutable through this surface.
 * `last_run_at` / `last_result` / `consecutive_failures` are written
 * by the scheduled-managed-task skill, not by user-facing PATCHes.
 *
 * `app` is intentionally immutable — renaming an app would silently
 * orphan all entity-file `frontmatter.sources.<key>` references. The
 * separate `POST /api/managed-tasks/:id/rename-app` endpoint (§12)
 * handles that atomically.
 */
export const managedTaskPatchSchema = z
  .object({
    intent: trimmedLabel("intent", INTENT_MAX_LENGTH).optional(),
    cadence: z.string().min(1).max(200).optional(),
    /**
     * Structured recurrence (matches the create-schema shape). The
     * route layer threads this through `updateRecurringSchedule` which
     * regenerates the next `agent_schedule` row.
     */
    recurrenceRule: recurrenceRuleSchema.optional(),
    output_path: z
      .string()
      .refine(
        (v) => isValidOutputPath(v),
        "output_path must be `<domain>/<type-plural>/` (see §9.1)",
      )
      .nullable()
      .optional(),
  })
  .refine(
    (data) => Object.keys(data).length > 0,
    "PATCH body must specify at least one field",
  );

export type ManagedTaskPatch = z.infer<typeof managedTaskPatchSchema>;

/**
 * Internal-update schema — used by the scheduled-managed-task skill
 * via `PATCH /api/managed-tasks/:id/run-result` (§10.4 step 5).
 * Separate from the user-facing PATCH because the surfaces and
 * risk-tier classifications differ.
 */
export const managedTaskRunResultSchema = z.object({
  /** ISO-8601 UTC. Validated strictly so a malformed write fails loudly. */
  last_run_at: z.string().datetime(),
  last_result: z.string().max(LAST_RESULT_MAX_LENGTH),
  /**
   * Replace-semantics. The server sets the value verbatim; the skill
   * is responsible for bumping/resetting based on success or failure
   * (§10.4).
   */
  consecutive_failures: z.number().int().nonnegative(),
});

export type ManagedTaskRunResult = z.infer<typeof managedTaskRunResultSchema>;
