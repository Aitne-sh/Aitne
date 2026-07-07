import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { BackendId } from "@aitne/shared";
// Value import into the evaluator is safe: trigger-evaluator only imports
// a *type* from this module, so there is no runtime cycle.
import { compileGlob } from "../core/trigger-evaluator.js";
import type { GitWatchedRepoSetting } from "../settings/runtime-settings.js";

/**
 * Unified Repositories store — see
 * `docs/design/appendices/unified-repositories.md`.
 *
 * **Trigger nomenclature.** Two distinct trigger families live in this
 * codebase; do not confuse them:
 *
 *   - `repository_triggers` (this file)        — per-row, **event-driven**
 *     (e.g. `git.push.detected`, `github.workflow_run.failed`). Fired by
 *     `core/trigger-dispatch.ts` from the post-observation hooks of
 *     `git-watcher` / `github-poller`. Each trigger carries its own
 *     `(backend, model, workdirMode, prompt)` action.
 *   - `automation_triggers` (`db/automation-triggers.ts`) — domain-keyed
 *     **cron-driven** (`cron.daily`, `cron.weekly`). Backed by
 *     `recurring_schedules` and the scheduler; the prompt is shared per
 *     trigger and executes on the default backend.
 *
 * One Repository row pairs an optional GitHub remote and an optional local
 * clone. The DB-level CHECK constraints enforce structural invariants
 * (at least one side; `local_only=1` forbids GitHub fields). This module
 * adds cross-table validation that SQLite cannot express cleanly:
 *
 *   - A trigger with `workdir_mode='local-clone'` requires the parent row to
 *     have `local_path !== null`. Enforced in `createTrigger` /
 *     `updateTrigger` and on the inverse mutation
 *     (clearing `local_path` while a `local-clone` trigger exists).
 *   - The deterministic slug derivation lives here so management init/scan
 *     and the future doctor drift check share one path-building helper.
 *
 * The legacy three config arrays (`gitRepos`, `gitWatchedRepos`,
 * `githubRepos`) are gone. The three projection selectors below preserve
 * the legacy shapes so observers and the read-proxy git/github routes
 * don't all need to change at once.
 */

// ── Types ────────────────────────────────────────────────────────────

export type RepositoryClassification = "project" | "repo-only";
export type RepositoryCategory =
  | "work"
  | "personal"
  | "research"
  | "client"
  | "other";
export type RepositoryPollPriority = "high" | "normal";

export interface RepositoryRow {
  id: string;
  github_owner: string | null;
  github_repo: string | null;
  github_account: string | null;
  local_path: string | null;
  local_only: number;
  display_name: string | null;
  classification: RepositoryClassification;
  category: RepositoryCategory;
  poll_priority: RepositoryPollPriority;
  poll_interval_sec: number | null;
  created_at: number;
  updated_at: number;
}

export interface RepositoryDTO {
  id: string;
  githubOwner: string | null;
  githubRepo: string | null;
  githubAccount: string | null;
  localPath: string | null;
  localOnly: boolean;
  displayName: string | null;
  classification: RepositoryClassification;
  category: RepositoryCategory;
  pollPriority: RepositoryPollPriority;
  pollIntervalSec: number | null;
  /** Derived deterministic slug used for output paths and dashboard deep-links. */
  slug: string;
  createdAt: number;
  updatedAt: number;
}

export interface RepositoryCreateInput {
  githubOwner?: string | null;
  githubRepo?: string | null;
  githubAccount?: string | null;
  localPath?: string | null;
  localOnly?: boolean;
  displayName?: string | null;
  classification?: RepositoryClassification;
  category?: RepositoryCategory;
  pollPriority?: RepositoryPollPriority;
  pollIntervalSec?: number | null;
}

export interface RepositoryUpdateInput {
  githubOwner?: string | null;
  githubRepo?: string | null;
  githubAccount?: string | null;
  localPath?: string | null;
  localOnly?: boolean;
  displayName?: string | null;
  classification?: RepositoryClassification;
  category?: RepositoryCategory;
  pollPriority?: RepositoryPollPriority;
  pollIntervalSec?: number | null;
}

export type TriggerWorkdirMode = "temp" | "local-clone";
export type TriggerBackend = BackendId;

export interface RepositoryTriggerRow {
  id: string;
  repository_id: string;
  name: string;
  enabled: number;
  event_type: string;
  filters_json: string;
  backend: TriggerBackend;
  model: string;
  workdir_mode: TriggerWorkdirMode;
  prompt: string;
  instruction_md: string | null;
  last_fired_at: number | null;
  fire_count: number;
  created_at: number;
  updated_at: number;
}

export interface RepositoryTriggerDTO {
  id: string;
  repositoryId: string;
  name: string;
  enabled: boolean;
  eventType: string;
  filters: Record<string, unknown>;
  backend: TriggerBackend;
  model: string;
  workdirMode: TriggerWorkdirMode;
  prompt: string;
  instructionMd: string | null;
  lastFiredAt: number | null;
  fireCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface RepositoryTriggerCreateInput {
  name: string;
  enabled?: boolean;
  eventType: string;
  filters?: Record<string, unknown>;
  backend: TriggerBackend;
  model: string;
  workdirMode: TriggerWorkdirMode;
  prompt: string;
  instructionMd?: string | null;
}

export interface RepositoryTriggerUpdateInput {
  name?: string;
  enabled?: boolean;
  eventType?: string;
  filters?: Record<string, unknown>;
  backend?: TriggerBackend;
  model?: string;
  workdirMode?: TriggerWorkdirMode;
  prompt?: string;
  instructionMd?: string | null;
}

/**
 * Optional validator injected by the route layer to gate `(backend,model)`
 * pairs against the live model registry (`/settings/models` uses the same
 * gate). Returns true when the model is registered for the backend; false
 * means create/update should reject with `model_invalid`.
 *
 * The store keeps backend internals out — the daemon's
 * `core/backends/model-registry.ts` is wired by the route handler. Tests
 * can pass a stub or omit the option entirely (`true` = no validation,
 * preserving the pre-validation behaviour for legacy fixtures).
 */
export type TriggerModelValidator = (
  backend: TriggerBackend,
  model: string,
) => boolean;

export interface TriggerWriteOptions {
  validateModel?: TriggerModelValidator;
}

export interface RepositoryManagementRow {
  repository_id: string;
  enabled: number;
  init_completed_at: number | null;
  last_scan_at: number | null;
  last_scan_status: "ok" | "failed" | "skipped_no_activity" | null;
  scan_failure_count: number;
  created_at: number;
  updated_at: number;
}

export interface RepositoryManagementDTO {
  repositoryId: string;
  enabled: boolean;
  initCompletedAt: number | null;
  lastScanAt: number | null;
  lastScanStatus: "ok" | "failed" | "skipped_no_activity" | null;
  scanFailureCount: number;
  createdAt: number;
  updatedAt: number;
}

export class RepositoryStoreError extends Error {
  constructor(
    public readonly code:
      | "missing_side"
      | "github_pair_required"
      | "invalid_github_ref"
      | "invalid_local_path"
      | "local_only_with_github"
      | "duplicate_github"
      | "duplicate_local"
      | "duplicate_slug"
      | "invalid_poll_interval"
      | "not_found"
      | "trigger_workdir_requires_local_clone"
      | "trigger_workdir_local_clone_blocks_clear"
      | "instruction_required"
      | "filters_invalid"
      | "model_invalid",
    message: string,
  ) {
    super(message);
    this.name = "RepositoryStoreError";
  }
}

// ── Slug helper ──────────────────────────────────────────────────────

const SLUG_MAX = 60;
const SLUG_PATTERN = /[^a-z0-9._-]+/g;
// Defense-in-depth (C3): the SLUG_PATTERN allows `.` so legitimate slugs
// like `v1.2.3` or `my.tool` survive sanitization. A *pure-dot* slug
// (`.`, `..`, `...`) is structurally legal under that pattern but
// catastrophic downstream: `path.join(contextDir, "knowledge/repos/../overview.md")`
// normalises the `..` segment and redirects the agent's architecture
// write to a top-level context file. Reject pure-dot candidates here so
// no caller — direct store user, future API loosening, or fixture import
// — can produce a slug that escapes the `knowledge/repos/<slug>/` namespace.
const PURE_DOT_PATTERN = /^\.+$/;

function lastPathSegment(value: string): string | null {
  const trimmed = value.replace(/[\\/]+$/g, "");
  const segments = trimmed.split(/[\\/]+/).filter((s) => s.length > 0);
  return segments[segments.length - 1] ?? null;
}

function looksWindowsLocalPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value)
    || /^\\\\/.test(value)
    || /^\/\/[^/]+\/[^/]+/.test(value)
    || value.includes("\\");
}

function localPathCompareKey(value: string): string {
  const trimmed = value.replace(/[\\/]+$/g, "");
  if (looksWindowsLocalPath(trimmed)) {
    return trimmed.replace(/[\\/]+/g, "\\").toLowerCase();
  }
  return trimmed;
}

/**
 * Deterministic slug derivation per design §4.5. Sanitized to
 * `[a-z0-9._-]+`, max 60 chars. Order:
 *
 *   1. `displayName` if set, lowercased and `[^a-z0-9._-]` → `-`.
 *   2. Otherwise `<owner>-<repo>` (e.g. "acme-widgets").
 *   3. Otherwise `basename(localPath)`.
 *
 * The result is always non-empty for a valid row (one of the three
 * sources is present per the CHECK constraint), but the helper still
 * defends against an empty result by returning `repo-<id-prefix>` so
 * dashboard URLs never collapse into a bare slash.
 */
export function deriveSlug(input: {
  id?: string;
  displayName?: string | null;
  githubOwner?: string | null;
  githubRepo?: string | null;
  localPath?: string | null;
}): string {
  const candidates: string[] = [];
  if (input.displayName) candidates.push(input.displayName);
  if (input.githubOwner && input.githubRepo) {
    candidates.push(`${input.githubOwner}-${input.githubRepo}`);
  }
  if (input.localPath) {
    const last = lastPathSegment(input.localPath);
    if (last) candidates.push(last);
  }

  for (const raw of candidates) {
    const sanitized = raw
      .toLowerCase()
      .replace(SLUG_PATTERN, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, SLUG_MAX);
    if (sanitized.length === 0) continue;
    // Pure-dot slugs are rejected even though they sanitize cleanly — see
    // PURE_DOT_PATTERN comment above for the path-traversal rationale.
    if (PURE_DOT_PATTERN.test(sanitized)) continue;
    return sanitized;
  }

  // Final fallback. The id-prefix is normally hex/colon (e.g.
  // `local:<sha1[:12]>`, `github:<owner>/<repo>`) and sanitizes to a safe
  // slug, but a synthetic id could theoretically reduce to dots-only —
  // harden that branch too with a deterministic hash escape via the
  // existing `pathHash12` helper (sha1, 12-char hex prefix).
  const fallback = (input.id ?? "row").slice(0, 12);
  const fallbackSlug = fallback
    .toLowerCase()
    .replace(SLUG_PATTERN, "-")
    .replace(/^-+|-+$/g, "");
  if (fallbackSlug.length === 0 || PURE_DOT_PATTERN.test(fallbackSlug)) {
    // input.id is non-undefined whenever this branch fires — a missing
    // id sanitizes to "row" which never matches the pure-dot / empty
    // guard above. The `?? "row"` is purely defensive.
    return `repo-${pathHash12(input.id ?? /* c8 ignore next */ "row")}`;
  }
  return `repo-${fallbackSlug}`;
}

function pathHash12(path: string): string {
  return createHash("sha1").update(path).digest("hex").slice(0, 12);
}

/**
 * Slug uniqueness gate (unified-repositories §4.5 + review note C). The
 * `<contextDir>/knowledge/repos/<slug>/` output layout is keyed by
 * `deriveSlug`, so two rows with the same slug would collide on
 * `overview.md` / `journal/repos/<slug>/<date>.md` writes. The slug is
 * computed (not stored), so a DB UNIQUE constraint isn't viable; this
 * helper performs an in-JS check at create/update time. `excludeId`
 * lets the update path skip the row being mutated.
 *
 * Race-conditions exist in principle (two parallel POST /repositories
 * with colliding slugs) but the dashboard is single-operator and the
 * cost of a colliding write is bounded — both rows would attempt the
 * same `knowledge/repos/<slug>/overview.md` file path through the
 * `/api/context/...` chokepoint, which is itself locked.
 */
function findRepositoryWithSlug(
  db: Database.Database,
  slug: string,
  excludeId: string | null,
): RepositoryRow | null {
  const rows = db
    .prepare<[], RepositoryRow>("SELECT * FROM repositories")
    .all();
  for (const row of rows) {
    if (excludeId !== null && row.id === excludeId) continue;
    const rowSlug = deriveSlug({
      id: row.id,
      displayName: row.display_name,
      githubOwner: row.github_owner,
      githubRepo: row.github_repo,
      localPath: row.local_path,
    });
    if (rowSlug === slug) return row;
  }
  return null;
}

function findRepositoryWithEquivalentLocalPath(
  db: Database.Database,
  localPath: string,
  excludeId: string | null,
): RepositoryRow | null {
  const targetKey = localPathCompareKey(localPath);
  const rows = db
    .prepare<[], RepositoryRow>(
      "SELECT * FROM repositories WHERE local_path IS NOT NULL",
    )
    .all();
  for (const row of rows) {
    if (excludeId !== null && row.id === excludeId) continue;
    // SQL filter already excludes NULL local_path; the JS guard is
    // defensive against schema drift.
    /* c8 ignore next */
    if (!row.local_path) continue;
    if (localPathCompareKey(row.local_path) === targetKey) return row;
  }
  return null;
}

/**
 * ID derivation per design §3.1. GitHub-paired rows get the canonical
 * `github:<owner>/<repo>` slug; local-only rows get `local:<sha1[:12]>`
 * of the absolute path.
 */
export function deriveRepositoryId(input: {
  githubOwner?: string | null;
  githubRepo?: string | null;
  localPath?: string | null;
}): string {
  if (input.githubOwner && input.githubRepo) {
    return `github:${input.githubOwner}/${input.githubRepo}`;
  }
  if (input.localPath) {
    return `local:${pathHash12(input.localPath)}`;
  }
  throw new RepositoryStoreError(
    "missing_side",
    "deriveRepositoryId requires github owner+repo or localPath",
  );
}

// ── Validation ───────────────────────────────────────────────────────

/**
 * Single path segment of a GitHub `owner/repo` slug. Deliberately
 * permissive (GitHub's real rules differ slightly between users, orgs,
 * and repos) but blocks the failure modes that corrupt derived state:
 * `/` (a pasted `owner/repo` in the owner field yields a
 * `github:a/b/c` id and a broken `gh api repos/a/b/c/...` URL path),
 * whitespace, and empty strings.
 */
const GITHUB_REF_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * Canonicalize a user-supplied local clone path: trim, expand a leading
 * `~`/`~/` to the daemon's home directory, require the result to be
 * absolute (POSIX or Windows-style), and strip trailing separators so
 * `/a/b/` and `/a/b` derive the same `local:<hash>` id.
 *
 * A relative path would silently resolve against the daemon's cwd in
 * every later `git -C` call — reject it here with the same message the
 * link-local route advertises.
 */
function normalizeLocalPathInput(value: string): string {
  let path = value.trim();
  if (path === "~" || path.startsWith("~/") || path.startsWith("~\\")) {
    path = join(homedir(), path.slice(1).replace(/^[\\/]/, ""));
  }
  if (path.length === 0 || !(isAbsolute(path) || looksWindowsLocalPath(path))) {
    throw new RepositoryStoreError(
      "invalid_local_path",
      `localPath must be an absolute path (got ${JSON.stringify(value)}); `
        + "a leading '~/' is expanded to the daemon's home directory",
    );
  }
  const stripped = path.replace(/[\\/]+$/g, "");
  return stripped.length > 0 ? stripped : path;
}

function validateInputShape(input: {
  githubOwner?: string | null;
  githubRepo?: string | null;
  localPath?: string | null;
  localOnly?: boolean;
}): void {
  const hasGithubOwner = Boolean(input.githubOwner);
  const hasGithubRepo = Boolean(input.githubRepo);
  if (hasGithubOwner !== hasGithubRepo) {
    throw new RepositoryStoreError(
      "github_pair_required",
      "githubOwner and githubRepo must be supplied together or both be null",
    );
  }
  const hasGithub = hasGithubOwner && hasGithubRepo;
  if (hasGithub) {
    for (const [field, value] of [
      ["githubOwner", input.githubOwner!],
      ["githubRepo", input.githubRepo!],
    ] as const) {
      if (!GITHUB_REF_SEGMENT_PATTERN.test(value)) {
        throw new RepositoryStoreError(
          "invalid_github_ref",
          `${field} must match ${GITHUB_REF_SEGMENT_PATTERN} (got ${JSON.stringify(value)}); `
            + "pass owner and repo as separate fields, not a combined 'owner/repo' slug",
        );
      }
    }
  }
  const hasLocal = Boolean(input.localPath);
  if (!hasGithub && !hasLocal) {
    throw new RepositoryStoreError(
      "missing_side",
      "Repository must have a GitHub remote, a local clone, or both",
    );
  }
  if (input.localOnly && hasGithub) {
    throw new RepositoryStoreError(
      "local_only_with_github",
      "localOnly=true forbids githubOwner/githubRepo — clear them first or set localOnly=false",
    );
  }
}

function validatePollInterval(value: number | null | undefined): void {
  if (value === undefined || value === null) return;
  if (!Number.isInteger(value) || value <= 0) {
    throw new RepositoryStoreError(
      "invalid_poll_interval",
      "pollIntervalSec must be a positive integer or null",
    );
  }
}

function rowToDTO(row: RepositoryRow): RepositoryDTO {
  return {
    id: row.id,
    githubOwner: row.github_owner,
    githubRepo: row.github_repo,
    githubAccount: row.github_account,
    localPath: row.local_path,
    localOnly: row.local_only === 1,
    displayName: row.display_name,
    classification: row.classification,
    category: row.category,
    pollPriority: row.poll_priority,
    pollIntervalSec: row.poll_interval_sec,
    slug: deriveSlug({
      id: row.id,
      displayName: row.display_name,
      githubOwner: row.github_owner,
      githubRepo: row.github_repo,
      localPath: row.local_path,
    }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Repository CRUD ──────────────────────────────────────────────────

export function listRepositories(
  db: Database.Database,
  filters: {
    hasGithub?: boolean;
    hasLocal?: boolean;
    localOnly?: boolean;
    account?: string;
  } = {},
): RepositoryDTO[] {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (filters.hasGithub === true) {
    where.push("github_owner IS NOT NULL AND github_repo IS NOT NULL");
  } else if (filters.hasGithub === false) {
    where.push("github_owner IS NULL");
  }
  if (filters.hasLocal === true) {
    where.push("local_path IS NOT NULL");
  } else if (filters.hasLocal === false) {
    where.push("local_path IS NULL");
  }
  if (filters.localOnly === true) {
    where.push("local_only = 1");
  } else if (filters.localOnly === false) {
    where.push("local_only = 0");
  }
  if (filters.account !== undefined) {
    where.push("github_account = ?");
    params.push(filters.account);
  }

  const sql = `SELECT * FROM repositories ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at ASC`;
  const rows = db.prepare(sql).all(...params) as RepositoryRow[];
  return rows.map(rowToDTO);
}

export function getRepository(
  db: Database.Database,
  id: string,
): RepositoryDTO | null {
  const row = db
    .prepare<[string], RepositoryRow>("SELECT * FROM repositories WHERE id = ?")
    .get(id);
  return row ? rowToDTO(row) : null;
}

/**
 * Resolve either the immutable row id or a GitHub-side alias. This keeps
 * local-start rows usable after the user later links a GitHub remote: the row
 * id remains `local:<hash>` for historical references, while API callers may
 * still pass `github:<owner>/<repo>` or `owner/repo`.
 */
export function resolveRepositoryIdentifier(
  db: Database.Database,
  identifier: string,
): RepositoryDTO | null {
  const direct = getRepository(db, identifier);
  if (direct) return direct;

  const githubSlug = identifier.startsWith("github:")
    ? identifier.slice("github:".length)
    : identifier;
  const parts = githubSlug.split("/");
  if (parts.length === 2 && parts[0] && parts[1]) {
    return getRepositoryByGithub(db, parts[0], parts[1]);
  }
  return null;
}

export function getRepositoryByGithub(
  db: Database.Database,
  owner: string,
  repo: string,
): RepositoryDTO | null {
  const row = db
    .prepare<[string, string], RepositoryRow>(
      "SELECT * FROM repositories WHERE github_owner = ? AND github_repo = ?",
    )
    .get(owner, repo);
  return row ? rowToDTO(row) : null;
}

export function getRepositoryByLocalPath(
  db: Database.Database,
  localPath: string,
): RepositoryDTO | null {
  const row = db
    .prepare<[string], RepositoryRow>(
      "SELECT * FROM repositories WHERE local_path = ?",
    )
    .get(localPath);
  return row ? rowToDTO(row) : null;
}

export function createRepository(
  db: Database.Database,
  input: RepositoryCreateInput,
  now: number = Date.now(),
): RepositoryDTO {
  if (input.localPath) {
    // Canonicalize before anything derives from the path — the id hash,
    // duplicate detection, and slug all key off the stored value.
    input = { ...input, localPath: normalizeLocalPathInput(input.localPath) };
  }
  validateInputShape(input);
  validatePollInterval(input.pollIntervalSec);

  const id = deriveRepositoryId({
    githubOwner: input.githubOwner ?? null,
    githubRepo: input.githubRepo ?? null,
    localPath: input.localPath ?? null,
  });

  const existing = db
    .prepare<[string], { id: string }>("SELECT id FROM repositories WHERE id = ?")
    .get(id);
  if (existing) {
    throw new RepositoryStoreError(
      input.githubOwner ? "duplicate_github" : "duplicate_local",
      `Repository ${id} already exists`,
    );
  }
  if (input.githubOwner && input.githubRepo) {
    const duplicateGithub = db
      .prepare<[string, string], { id: string }>(
        "SELECT id FROM repositories WHERE github_owner = ? AND github_repo = ? LIMIT 1",
      )
      .get(input.githubOwner, input.githubRepo);
    /* c8 ignore start — `id` (`github:<owner>/<repo>`) is derived from
       the same fields, so the id-based existence check above already
       catches every duplicate. The owner/repo SELECT here is defensive
       against future id-derivation changes that decouple the slug from
       the github fields. */
    if (duplicateGithub) {
      throw new RepositoryStoreError(
        "duplicate_github",
        `GitHub remote ${input.githubOwner}/${input.githubRepo} is already registered`,
      );
    }
    /* c8 ignore stop */
  }
  if (input.localPath) {
    const duplicateLocal = findRepositoryWithEquivalentLocalPath(
      db,
      input.localPath,
      null,
    );
    if (duplicateLocal) {
      throw new RepositoryStoreError(
        "duplicate_local",
        `Local path ${input.localPath} is already registered by ${duplicateLocal.id}`,
      );
    }
  }

  const candidateSlug = deriveSlug({
    id,
    displayName: input.displayName ?? null,
    githubOwner: input.githubOwner ?? null,
    githubRepo: input.githubRepo ?? null,
    localPath: input.localPath ?? null,
  });
  const slugCollision = findRepositoryWithSlug(db, candidateSlug, null);
  if (slugCollision) {
    throw new RepositoryStoreError(
      "duplicate_slug",
      `Slug '${candidateSlug}' is already used by repository '${slugCollision.id}'. `
        + "Pick a different displayName to disambiguate.",
    );
  }

  db.prepare(
    `INSERT INTO repositories (
        id, github_owner, github_repo, github_account, local_path, local_only,
        display_name, classification, category, poll_priority, poll_interval_sec,
        created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.githubOwner ?? null,
    input.githubRepo ?? null,
    input.githubAccount ?? null,
    input.localPath ?? null,
    input.localOnly ? 1 : 0,
    input.displayName ?? null,
    input.classification ?? "repo-only",
    input.category ?? "other",
    input.pollPriority ?? "normal",
    input.pollIntervalSec ?? null,
    now,
    now,
  );

  const row = db
    .prepare<[string], RepositoryRow>("SELECT * FROM repositories WHERE id = ?")
    .get(id)!;
  return rowToDTO(row);
}

export function updateRepository(
  db: Database.Database,
  id: string,
  patch: RepositoryUpdateInput,
  now: number = Date.now(),
): RepositoryDTO {
  const current = db
    .prepare<[string], RepositoryRow>("SELECT * FROM repositories WHERE id = ?")
    .get(id);
  if (!current) {
    throw new RepositoryStoreError("not_found", `Repository ${id} not found`);
  }

  const merged = {
    githubOwner: patch.githubOwner !== undefined ? patch.githubOwner : current.github_owner,
    githubRepo: patch.githubRepo !== undefined ? patch.githubRepo : current.github_repo,
    githubAccount:
      patch.githubAccount !== undefined ? patch.githubAccount : current.github_account,
    localPath: patch.localPath !== undefined
      ? (patch.localPath === null ? null : normalizeLocalPathInput(patch.localPath))
      : current.local_path,
    localOnly: patch.localOnly !== undefined ? patch.localOnly : current.local_only === 1,
    displayName:
      patch.displayName !== undefined ? patch.displayName : current.display_name,
    classification: patch.classification ?? current.classification,
    category: patch.category ?? current.category,
    pollPriority: patch.pollPriority ?? current.poll_priority,
    pollIntervalSec:
      patch.pollIntervalSec !== undefined
        ? patch.pollIntervalSec
        : current.poll_interval_sec,
  };

  validateInputShape({
    githubOwner: merged.githubOwner,
    githubRepo: merged.githubRepo,
    localPath: merged.localPath,
    localOnly: merged.localOnly,
  });
  validatePollInterval(merged.pollIntervalSec);

  if (merged.githubOwner && merged.githubRepo) {
    const duplicateGithub = db
      .prepare<[string, string, string], { id: string }>(
        `SELECT id FROM repositories
          WHERE github_owner = ? AND github_repo = ? AND id <> ?
          LIMIT 1`,
      )
      .get(merged.githubOwner, merged.githubRepo, id);
    if (duplicateGithub) {
      throw new RepositoryStoreError(
        "duplicate_github",
        `GitHub remote ${merged.githubOwner}/${merged.githubRepo} is already registered by ${duplicateGithub.id}`,
      );
    }
  }

  if (merged.localPath) {
    const duplicateLocal = findRepositoryWithEquivalentLocalPath(
      db,
      merged.localPath,
      id,
    );
    if (duplicateLocal) {
      throw new RepositoryStoreError(
        "duplicate_local",
        `Local path ${merged.localPath} is already registered by ${duplicateLocal.id}`,
      );
    }
  }

  // Cross-table: clearing local_path while a local-clone trigger exists
  // is rejected (design §3.5).
  const clearingLocal = current.local_path !== null && merged.localPath === null;
  if (clearingLocal) {
    const blockers = db
      .prepare<[string], { id: string }>(
        "SELECT id FROM repository_triggers WHERE repository_id = ? AND workdir_mode = 'local-clone'",
      )
      .all(id);
    if (blockers.length > 0) {
      throw new RepositoryStoreError(
        "trigger_workdir_local_clone_blocks_clear",
        `Cannot clear local_path: ${blockers.length} trigger(s) use workdirMode='local-clone'. Update or delete them first.`,
      );
    }
  }

  // The row id is immutable, but the two sides are not. A local-start row
  // keeps its `local:<hash>` id after GitHub is linked; a GitHub-start row
  // keeps its `github:<owner>/<repo>` id if the GitHub side is later
  // unlinked. Historical observation / agent_action references therefore
  // remain stable while the unique indexes preserve current-side identity.

  // Slug-collision gate — only check when a slug-input column actually
  // changed (cheap when the user is just toggling category or
  // pollPriority).
  const slugInputsChanged =
    patch.displayName !== undefined
    || patch.localPath !== undefined
    || patch.githubOwner !== undefined
    || patch.githubRepo !== undefined;
  if (slugInputsChanged) {
    const candidateSlug = deriveSlug({
      id,
      displayName: merged.displayName ?? null,
      githubOwner: merged.githubOwner ?? null,
      githubRepo: merged.githubRepo ?? null,
      localPath: merged.localPath ?? null,
    });
    const slugCollision = findRepositoryWithSlug(db, candidateSlug, id);
    if (slugCollision) {
      throw new RepositoryStoreError(
        "duplicate_slug",
        `Slug '${candidateSlug}' is already used by repository '${slugCollision.id}'. `
          + "Pick a different displayName to disambiguate.",
      );
    }
  }

  db.prepare(
    `UPDATE repositories SET
        github_owner = ?, github_repo = ?, github_account = ?,
        local_path = ?, local_only = ?, display_name = ?,
        classification = ?, category = ?, poll_priority = ?, poll_interval_sec = ?,
        updated_at = ?
      WHERE id = ?`,
  ).run(
    merged.githubOwner ?? null,
    merged.githubRepo ?? null,
    merged.githubAccount ?? null,
    merged.localPath ?? null,
    merged.localOnly ? 1 : 0,
    merged.displayName ?? null,
    merged.classification,
    merged.category,
    merged.pollPriority,
    merged.pollIntervalSec ?? null,
    now,
    id,
  );

  const row = db
    .prepare<[string], RepositoryRow>("SELECT * FROM repositories WHERE id = ?")
    .get(id)!;
  return rowToDTO(row);
}

export function deleteRepository(db: Database.Database, id: string): boolean {
  const result = db
    .prepare("DELETE FROM repositories WHERE id = ?")
    .run(id);
  return result.changes > 0;
}

// ── Legacy projection selectors (transitional) ───────────────────────

/**
 * Local-clone path allowlist for the read-only `/api/git/{log,diff,show}`
 * proxy and the workdir presence check. Rows without a local clone are
 * skipped — the proxy 404s for those slugs, and the workdir gate doesn't
 * surface them.
 */
export function selectGitRepoPaths(db: Database.Database): string[] {
  const rows = db
    .prepare<
      [],
      { local_path: string }
    >("SELECT local_path FROM repositories WHERE local_path IS NOT NULL ORDER BY created_at ASC")
    .all();
  return rows.map((r) => r.local_path);
}

/**
 * Local-clone rows projected into the legacy `GitWatchedRepoSetting` shape
 * for `git-watcher`, `git-delegated-cron`, and project-doc helpers. The
 * `repositoryId` field carries the unified id so downstream observation
 * sinks can resolve back to a row.
 */
export function selectGitWatchedRepos(
  db: Database.Database,
): GitWatchedRepoSetting[] {
  const rows = db
    .prepare<[], RepositoryRow>(
      "SELECT * FROM repositories WHERE local_path IS NOT NULL ORDER BY created_at ASC",
    )
    .all();
  return rows.map((row): GitWatchedRepoSetting => ({
    path: row.local_path!,
    slug: deriveSlug({
      id: row.id,
      displayName: row.display_name,
      githubOwner: row.github_owner,
      githubRepo: row.github_repo,
      localPath: row.local_path,
    }),
    classification: row.classification,
    category: row.category,
    org: row.github_owner ?? undefined,
    accountAlias: row.github_account ?? undefined,
    pollPriority: row.poll_priority,
    pollIntervalSec: row.poll_interval_sec,
    githubRepo:
      row.github_owner && row.github_repo
        ? `${row.github_owner}/${row.github_repo}`
        : null,
    repositoryId: row.id,
  }));
}

/**
 * GitHub-paired `owner/repo` slugs for `github-poller` and the
 * `/api/github/repos` listing.
 */
export function selectGithubRepoSlugs(db: Database.Database): string[] {
  const rows = db
    .prepare<
      [],
      { github_owner: string; github_repo: string }
    >(
      `SELECT github_owner, github_repo FROM repositories
        WHERE github_owner IS NOT NULL AND github_repo IS NOT NULL
        ORDER BY created_at ASC`,
    )
    .all();
  return rows.map((r) => `${r.github_owner}/${r.github_repo}`);
}

// ── Triggers CRUD ────────────────────────────────────────────────────

function triggerRowToDTO(row: RepositoryTriggerRow): RepositoryTriggerDTO {
  let filters: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.filters_json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      filters = parsed as Record<string, unknown>;
    }
  } catch {
    filters = {};
  }
  return {
    id: row.id,
    repositoryId: row.repository_id,
    name: row.name,
    enabled: row.enabled === 1,
    eventType: row.event_type,
    filters,
    backend: row.backend,
    model: row.model,
    workdirMode: row.workdir_mode,
    prompt: row.prompt,
    instructionMd: row.instruction_md,
    lastFiredAt: row.last_fired_at,
    fireCount: row.fire_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const PROMPT_MAX_BYTES = 16 * 1024;

function validateTriggerFilters(filters: Record<string, unknown>): string {
  // Filters language v1: flat key/value with a special `path_pattern` key
  // whose value is string|string[]. JSON serialization rejects symbols /
  // functions / circular structures up-front via JSON.stringify.
  for (const [key, value] of Object.entries(filters)) {
    if (key === "path_pattern") {
      const patterns = typeof value === "string"
        ? [value]
        : Array.isArray(value) && value.every((v) => typeof v === "string")
          ? (value as string[])
          : null;
      if (patterns === null) {
        throw new RepositoryStoreError(
          "filters_invalid",
          "filters.path_pattern must be string or string[]",
        );
      }
      // Compile-check each glob NOW. A pattern that only throws at match
      // time (e.g. `[a\`) would silently kill evaluation for every
      // trigger sharing the same (repository, event) — reject at write
      // time so the operator sees the error while editing the trigger.
      for (const pattern of patterns) {
        try {
          compileGlob(pattern);
        } catch {
          throw new RepositoryStoreError(
            "filters_invalid",
            `filters.path_pattern contains an invalid glob: ${JSON.stringify(pattern)}`,
          );
        }
      }
      continue;
    }
    // All other keys: scalar (string|number|boolean|null) for flat equality.
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      continue;
    }
    throw new RepositoryStoreError(
      "filters_invalid",
      `filters.${key} must be a scalar (string/number/boolean/null) or path_pattern`,
    );
  }
  return JSON.stringify(filters);
}

function validatePromptSize(text: string, fieldName: string): void {
  if (Buffer.byteLength(text, "utf8") > PROMPT_MAX_BYTES) {
    throw new RepositoryStoreError(
      "filters_invalid",
      `${fieldName} exceeds ${PROMPT_MAX_BYTES}-byte cap`,
    );
  }
}

function generateTriggerId(now: number): string {
  // Compact monotonic-ish id: <base36 timestamp>-<6 random>.
  const ts = now.toString(36);
  const rand = createHash("sha1")
    .update(`${now}:${Math.random()}`)
    .digest("hex")
    .slice(0, 6);
  return `trg_${ts}${rand}`;
}

function assertTriggerWorkdirCompatibility(
  db: Database.Database,
  repositoryId: string,
  workdirMode: TriggerWorkdirMode,
): void {
  if (workdirMode !== "local-clone") return;
  const repo = db
    .prepare<[string], { local_path: string | null }>(
      "SELECT local_path FROM repositories WHERE id = ?",
    )
    .get(repositoryId);
  if (!repo) {
    throw new RepositoryStoreError(
      "not_found",
      `Repository ${repositoryId} not found`,
    );
  }
  if (repo.local_path === null) {
    throw new RepositoryStoreError(
      "trigger_workdir_requires_local_clone",
      "workdirMode='local-clone' requires the repository to have a local_path",
    );
  }
}

export function listTriggers(
  db: Database.Database,
  repositoryId: string,
): RepositoryTriggerDTO[] {
  const rows = db
    .prepare<[string], RepositoryTriggerRow>(
      `SELECT * FROM repository_triggers
        WHERE repository_id = ?
        ORDER BY created_at ASC`,
    )
    .all(repositoryId);
  return rows.map(triggerRowToDTO);
}

export function listEnabledTriggersForEvent(
  db: Database.Database,
  repositoryId: string,
  eventType: string,
): RepositoryTriggerDTO[] {
  const rows = db
    .prepare<[string, string], RepositoryTriggerRow>(
      `SELECT * FROM repository_triggers
        WHERE repository_id = ? AND event_type = ? AND enabled = 1
        ORDER BY created_at ASC`,
    )
    .all(repositoryId, eventType);
  return rows.map(triggerRowToDTO);
}

export function getTrigger(
  db: Database.Database,
  triggerId: string,
): RepositoryTriggerDTO | null {
  const row = db
    .prepare<[string], RepositoryTriggerRow>(
      "SELECT * FROM repository_triggers WHERE id = ?",
    )
    .get(triggerId);
  return row ? triggerRowToDTO(row) : null;
}

export function createTrigger(
  db: Database.Database,
  repositoryId: string,
  input: RepositoryTriggerCreateInput,
  options: TriggerWriteOptions | number = {},
  legacyNow?: number,
): RepositoryTriggerDTO {
  // Backwards-compat overload: the original signature was
  // `(db, repoId, input, now?)`. Accept that shape too so callers
  // without the new validator (e.g. older tests) keep working.
  const now =
    typeof options === "number"
      ? options
      : (legacyNow ?? Date.now());
  const opts: TriggerWriteOptions =
    typeof options === "number" ? {} : options;

  if (input.workdirMode === "temp" && !input.instructionMd) {
    throw new RepositoryStoreError(
      "instruction_required",
      "workdirMode='temp' requires instructionMd",
    );
  }
  assertTriggerWorkdirCompatibility(db, repositoryId, input.workdirMode);
  if (opts.validateModel && !opts.validateModel(input.backend, input.model)) {
    throw new RepositoryStoreError(
      "model_invalid",
      `Model '${input.model}' is not registered for backend '${input.backend}'`,
    );
  }

  const filtersJson = validateTriggerFilters(input.filters ?? {});
  validatePromptSize(input.prompt, "prompt");
  if (input.instructionMd) validatePromptSize(input.instructionMd, "instructionMd");

  const id = generateTriggerId(now);
  db.prepare(
    `INSERT INTO repository_triggers (
        id, repository_id, name, enabled, event_type, filters_json,
        backend, model, workdir_mode, prompt, instruction_md,
        last_fired_at, fire_count, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)`,
  ).run(
    id,
    repositoryId,
    input.name,
    input.enabled === false ? 0 : 1,
    input.eventType,
    filtersJson,
    input.backend,
    input.model,
    input.workdirMode,
    input.prompt,
    input.instructionMd ?? null,
    now,
    now,
  );

  const row = db
    .prepare<[string], RepositoryTriggerRow>(
      "SELECT * FROM repository_triggers WHERE id = ?",
    )
    .get(id)!;
  return triggerRowToDTO(row);
}

export function updateTrigger(
  db: Database.Database,
  triggerId: string,
  patch: RepositoryTriggerUpdateInput,
  options: TriggerWriteOptions | number = {},
  legacyNow?: number,
): RepositoryTriggerDTO {
  const now =
    typeof options === "number"
      ? options
      : (legacyNow ?? Date.now());
  const opts: TriggerWriteOptions =
    typeof options === "number" ? {} : options;

  const current = db
    .prepare<[string], RepositoryTriggerRow>(
      "SELECT * FROM repository_triggers WHERE id = ?",
    )
    .get(triggerId);
  if (!current) {
    throw new RepositoryStoreError(
      "not_found",
      `Trigger ${triggerId} not found`,
    );
  }

  const merged = {
    name: patch.name ?? current.name,
    enabled: patch.enabled !== undefined ? patch.enabled : current.enabled === 1,
    eventType: patch.eventType ?? current.event_type,
    workdirMode: patch.workdirMode ?? current.workdir_mode,
    backend: patch.backend ?? current.backend,
    model: patch.model ?? current.model,
    prompt: patch.prompt ?? current.prompt,
    instructionMd:
      patch.instructionMd !== undefined ? patch.instructionMd : current.instruction_md,
    filtersJson: patch.filters !== undefined
      ? validateTriggerFilters(patch.filters)
      : current.filters_json,
  };

  if (merged.workdirMode === "temp" && !merged.instructionMd) {
    throw new RepositoryStoreError(
      "instruction_required",
      "workdirMode='temp' requires instructionMd",
    );
  }
  assertTriggerWorkdirCompatibility(db, current.repository_id, merged.workdirMode);
  // Validate `(backend, model)` only when either side actually changed
  // — re-validating an unchanged pair would punish operators whose
  // backend later disabled a model that was valid at original write
  // time. The route layer can opt out of this scoping by passing a
  // validator that always re-checks.
  if (opts.validateModel) {
    const backendChanged = patch.backend !== undefined && patch.backend !== current.backend;
    const modelChanged = patch.model !== undefined && patch.model !== current.model;
    if (backendChanged || modelChanged) {
      if (!opts.validateModel(merged.backend, merged.model)) {
        throw new RepositoryStoreError(
          "model_invalid",
          `Model '${merged.model}' is not registered for backend '${merged.backend}'`,
        );
      }
    }
  }

  validatePromptSize(merged.prompt, "prompt");
  if (merged.instructionMd) validatePromptSize(merged.instructionMd, "instructionMd");

  db.prepare(
    `UPDATE repository_triggers SET
        name = ?, enabled = ?, event_type = ?, filters_json = ?,
        backend = ?, model = ?, workdir_mode = ?, prompt = ?, instruction_md = ?,
        updated_at = ?
      WHERE id = ?`,
  ).run(
    merged.name,
    merged.enabled ? 1 : 0,
    merged.eventType,
    merged.filtersJson,
    merged.backend,
    merged.model,
    merged.workdirMode,
    merged.prompt,
    merged.instructionMd,
    now,
    triggerId,
  );

  const row = db
    .prepare<[string], RepositoryTriggerRow>(
      "SELECT * FROM repository_triggers WHERE id = ?",
    )
    .get(triggerId)!;
  return triggerRowToDTO(row);
}

export function deleteTrigger(
  db: Database.Database,
  triggerId: string,
): boolean {
  const result = db
    .prepare("DELETE FROM repository_triggers WHERE id = ?")
    .run(triggerId);
  return result.changes > 0;
}

export function recordTriggerFire(
  db: Database.Database,
  triggerId: string,
  now: number = Date.now(),
): void {
  db.prepare(
    `UPDATE repository_triggers
        SET last_fired_at = ?, fire_count = fire_count + 1, updated_at = ?
      WHERE id = ?`,
  ).run(now, now, triggerId);
}

// ── Management CRUD ──────────────────────────────────────────────────

function managementRowToDTO(
  row: RepositoryManagementRow,
): RepositoryManagementDTO {
  return {
    repositoryId: row.repository_id,
    enabled: row.enabled === 1,
    initCompletedAt: row.init_completed_at,
    lastScanAt: row.last_scan_at,
    lastScanStatus: row.last_scan_status,
    scanFailureCount: row.scan_failure_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getManagement(
  db: Database.Database,
  repositoryId: string,
): RepositoryManagementDTO | null {
  const row = db
    .prepare<[string], RepositoryManagementRow>(
      "SELECT * FROM repository_management WHERE repository_id = ?",
    )
    .get(repositoryId);
  return row ? managementRowToDTO(row) : null;
}

export function setManagementEnabled(
  db: Database.Database,
  repositoryId: string,
  enabled: boolean,
  now: number = Date.now(),
): RepositoryManagementDTO {
  const repo = getRepository(db, repositoryId);
  if (!repo) {
    throw new RepositoryStoreError(
      "not_found",
      `Repository ${repositoryId} not found`,
    );
  }

  const existing = db
    .prepare<[string], RepositoryManagementRow>(
      "SELECT * FROM repository_management WHERE repository_id = ?",
    )
    .get(repositoryId);

  if (existing) {
    db.prepare(
      `UPDATE repository_management SET enabled = ?, updated_at = ? WHERE repository_id = ?`,
    ).run(enabled ? 1 : 0, now, repositoryId);
  } else {
    db.prepare(
      `INSERT INTO repository_management (
          repository_id, enabled, init_completed_at, last_scan_at, last_scan_status,
          scan_failure_count, created_at, updated_at
       ) VALUES (?, ?, NULL, NULL, NULL, 0, ?, ?)`,
    ).run(repositoryId, enabled ? 1 : 0, now, now);
  }

  const row = db
    .prepare<[string], RepositoryManagementRow>(
      "SELECT * FROM repository_management WHERE repository_id = ?",
    )
    .get(repositoryId)!;
  return managementRowToDTO(row);
}

export function recordManagementInitDone(
  db: Database.Database,
  repositoryId: string,
  now: number = Date.now(),
): void {
  db.prepare(
    `UPDATE repository_management
        SET init_completed_at = ?, updated_at = ?
      WHERE repository_id = ?`,
  ).run(now, now, repositoryId);
}

/**
 * Optimistic pre-fire mark: bump `last_scan_at` to "now" so the daily
 * cron's "last scan more than 24h ago" gate skips this row until the
 * next cadence window. Called BEFORE enqueueing the scan event, so a
 * task-flow that crashes mid-flight does not cause the cron to re-fire
 * on every tick (an event with the cron's hourly default would queue
 * 24 redundant scans per day otherwise).
 *
 * `last_scan_status` is NOT touched here — the dispatcher finalizer
 * flips it to `'ok'` / `'failed'` on completion. A row with
 * `last_scan_at` recent and `last_scan_status` stale (or null) means
 * "scan in flight or crashed silently" — surface it in the dashboard.
 *
 * Idempotent: if the row already has `last_scan_at` newer than `now`
 * (clock skew, manual run mid-cron) we still rewrite — the value goes
 * forward only on `now`, never backwards.
 */
export function markManagementScanQueued(
  db: Database.Database,
  repositoryId: string,
  now: number = Date.now(),
): void {
  db.prepare(
    `UPDATE repository_management
        SET last_scan_at = ?, updated_at = ?
      WHERE repository_id = ?`,
  ).run(now, now, repositoryId);
}

export function recordManagementScan(
  db: Database.Database,
  repositoryId: string,
  status: "ok" | "failed" | "skipped_no_activity",
  now: number = Date.now(),
): void {
  // failure_count strictly counts terminal failures so the dashboard can
  // surface a steadily-climbing badge; skipped_no_activity does not bump it.
  const failureDelta = status === "failed" ? 1 : 0;
  const failureReset = status === "ok" ? 0 : null;
  if (failureReset === 0) {
    db.prepare(
      `UPDATE repository_management
          SET last_scan_at = ?, last_scan_status = ?, scan_failure_count = 0, updated_at = ?
        WHERE repository_id = ?`,
    ).run(now, status, now, repositoryId);
  } else {
    db.prepare(
      `UPDATE repository_management
          SET last_scan_at = ?, last_scan_status = ?,
              scan_failure_count = scan_failure_count + ?, updated_at = ?
        WHERE repository_id = ?`,
    ).run(now, status, failureDelta, now, repositoryId);
  }
}

/**
 * Iterator for the daily scan cron — returns rows whose management is
 * enabled, that have a local clone, and whose last scan was more than
 * `intervalMs` ago (or never ran).
 */
export function listManagementDueForScan(
  db: Database.Database,
  intervalMs: number,
  now: number = Date.now(),
): RepositoryDTO[] {
  const cutoff = now - intervalMs;
  const rows = db
    .prepare<[number], RepositoryRow>(
      `SELECT r.*
         FROM repositories r
         JOIN repository_management m ON m.repository_id = r.id
        WHERE m.enabled = 1
          AND r.local_path IS NOT NULL
          AND (m.last_scan_at IS NULL OR m.last_scan_at < ?)
        ORDER BY r.created_at ASC`,
    )
    .all(cutoff);
  return rows.map(rowToDTO);
}
