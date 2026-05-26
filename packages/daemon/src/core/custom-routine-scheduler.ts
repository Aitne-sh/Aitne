import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import cron, { type ScheduledTask } from "node-cron";
import {
  createEvent,
  EventPriority,
  customRoutineKey,
  isCustomRoutineKey,
  customRoutineSlugFromKey,
  type RoutineEvent,
} from "@aitne/shared";
import type { EventBus } from "./event-bus.js";
import { CONTEXT_RELATIVE_PATHS } from "./context-paths.js";
import { createLogger } from "../logging.js";

const logger = createLogger("custom-routine-scheduler");

/**
 * B-007 §5.8 Q3 — user-defined routines registered under
 * `context/policies/routines/custom/<slug>.md`. Each file's YAML frontmatter
 * describes the cadence and the runtime budget; `CustomRoutineScheduler`
 * enumerates them at startup, wires a `node-cron` job per enabled
 * routine, and pushes a `routine.custom.<slug>` event into the EventBus
 * on each firing. The routine file's `## Checks` body is injected into
 * the task-flow prompt by `policy-files.ts` — this class only drives
 * scheduling.
 *
 * Lifecycle:
 *   new → start() → running
 *   running → reload() → running (re-diffs registered vs on-disk)
 *   running → stop() → stopped (all cron jobs cleared)
 *
 * No fs.watch is used. The context API route (`src/api/routes/context.ts`)
 * calls `reload()` after every PUT/PATCH/DELETE under `policies/routines/custom/`.
 */

export interface CustomRoutineSpec {
  slug: string;
  cron: string;
  enabled: boolean;
  /**
   * Canonical model tier. Normalized from frontmatter — both legacy
   * `light`/`heavy` and current `lite`/`medium`/`high` strings are
   * accepted at parse time (`light → medium`, `heavy → high`).
   */
  backendTier: "lite" | "medium" | "high";
  maxBudgetUsd: number;
  processKey: string;
}

export type CustomRoutineParseError =
  | { kind: "missing_field"; field: string }
  | { kind: "invalid_cron"; value: string }
  | { kind: "invalid_slug"; value: string }
  | { kind: "invalid_type"; value: string }
  | { kind: "invalid_process_key"; value: string }
  | { kind: "invalid_enabled"; value: string }
  | { kind: "invalid_tier"; value: string }
  | { kind: "invalid_budget"; value: string }
  | { kind: "missing_checks_section" }
  | { kind: "no_frontmatter" };

export interface CustomRoutineEnumerationResult {
  specs: CustomRoutineSpec[];
  errors: { slug: string; error: CustomRoutineParseError }[];
}

/**
 * Extract the frontmatter body between the opening and closing `---`
 * delimiters. Returns null when the file has no YAML frontmatter.
 */
function extractFrontmatter(content: string): string | null {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return null;
  }
  const afterOpen = content.startsWith("---\r\n") ? 5 : 4;
  const endIdx = content.indexOf("\n---", afterOpen - 1);
  if (endIdx < 0) return null;
  return content.slice(afterOpen, endIdx);
}

function readScalar(frontmatter: string, field: string): string | null {
  const re = new RegExp(`^${field}\\s*:\\s*(.+?)\\s*$`, "m");
  const m = frontmatter.match(re);
  if (!m) return null;
  let v = m[1].trim();
  // Strip surrounding quotes (single or double).
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1);
  }
  return v;
}

function hasChecksSection(content: string): boolean {
  return /^##\s+Checks\s*$/m.test(content);
}

/**
 * Parse a `policies/routines/custom/<slug>.md` file body into a validated spec.
 * Pure function — safe to unit-test exhaustively. Returns a discriminated
 * result so callers can log structured errors without throwing.
 */
export function parseCustomRoutineSpec(
  slug: string,
  body: string,
): { ok: true; spec: CustomRoutineSpec } | { ok: false; error: CustomRoutineParseError } {
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(slug) || slug.length > 64) {
    return { ok: false, error: { kind: "invalid_slug", value: slug } };
  }

  const fm = extractFrontmatter(body);
  if (fm === null) {
    return { ok: false, error: { kind: "no_frontmatter" } };
  }

  const typeRaw = readScalar(fm, "type");
  if (!typeRaw) {
    return { ok: false, error: { kind: "missing_field", field: "type" } };
  }
  if (typeRaw !== "rule") {
    return { ok: false, error: { kind: "invalid_type", value: typeRaw } };
  }

  const slugRaw = readScalar(fm, "slug");
  if (!slugRaw) {
    return { ok: false, error: { kind: "missing_field", field: "slug" } };
  }
  if (slugRaw !== slug) {
    return { ok: false, error: { kind: "invalid_slug", value: slugRaw } };
  }

  const processKeyRaw = readScalar(fm, "process_key");
  if (!processKeyRaw) {
    return { ok: false, error: { kind: "missing_field", field: "process_key" } };
  }
  if (processKeyRaw !== customRoutineKey(slug)) {
    return { ok: false, error: { kind: "invalid_process_key", value: processKeyRaw } };
  }

  const cronExpr = readScalar(fm, "cron");
  if (!cronExpr) {
    return { ok: false, error: { kind: "missing_field", field: "cron" } };
  }
  if (!cron.validate(cronExpr)) {
    return { ok: false, error: { kind: "invalid_cron", value: cronExpr } };
  }

  const tierRaw = readScalar(fm, "backend_tier");
  if (!tierRaw) {
    return { ok: false, error: { kind: "missing_field", field: "backend_tier" } };
  }
  // Accept the legacy two-tier names ("light" / "heavy") and the canonical
  // three-tier names ("lite" / "medium" / "high"). Legacy "light" maps to
  // Sonnet (medium) and "heavy" to Opus (high), preserving behavior of
  // user-authored routine files written before the rename.
  const tierAliasMap: Record<string, "lite" | "medium" | "high"> = {
    "lite": "lite",
    "medium": "medium",
    "high": "high",
    "light": "medium",
    "heavy": "high",
  };
  const normalizedTier = tierAliasMap[tierRaw];
  if (!normalizedTier) {
    return { ok: false, error: { kind: "invalid_tier", value: tierRaw } };
  }

  const budgetRaw = readScalar(fm, "max_budget_usd");
  if (!budgetRaw) {
    return { ok: false, error: { kind: "missing_field", field: "max_budget_usd" } };
  }
  const budget = Number(budgetRaw);
  if (!Number.isFinite(budget) || budget <= 0) {
    return { ok: false, error: { kind: "invalid_budget", value: budgetRaw } };
  }

  const enabledRaw = readScalar(fm, "enabled");
  if (!enabledRaw) {
    return { ok: false, error: { kind: "missing_field", field: "enabled" } };
  }
  if (enabledRaw !== "true" && enabledRaw !== "false") {
    return { ok: false, error: { kind: "invalid_enabled", value: enabledRaw } };
  }
  const enabled = enabledRaw === "true";

  if (!hasChecksSection(body)) {
    return { ok: false, error: { kind: "missing_checks_section" } };
  }

  return {
    ok: true,
    spec: {
      slug,
      cron: cronExpr,
      enabled,
      backendTier: normalizedTier,
      maxBudgetUsd: budget,
      processKey: customRoutineKey(slug),
    },
  };
}

/**
 * Enumerate every `policies/routines/custom/*.md` file under `contextDir` and
 * parse each into a spec. Errors are returned alongside the successful
 * specs so the scheduler can log them without aborting startup.
 *
 * `readCustomRoutineDir` is injectable for tests — by default it reads
 * from disk. Passing null makes the helper return empty results, used
 * when the context directory has not yet been materialised.
 */
export function enumerateCustomRoutines(
  contextDir: string,
  options?: {
    readDir?: (dir: string) => string[];
    readFile?: (path: string) => string;
  },
): CustomRoutineEnumerationResult {
  const dir = join(contextDir, CONTEXT_RELATIVE_PATHS.routines.customDir);
  const readDir = options?.readDir ?? defaultReadDir;
  const readFile = options?.readFile ?? defaultReadFile;
  const files = readDir(dir);
  const specs: CustomRoutineSpec[] = [];
  const errors: { slug: string; error: CustomRoutineParseError }[] = [];

  for (const fileName of files) {
    if (!fileName.endsWith(".md")) continue;
    const slug = fileName.slice(0, -3);
    let body: string;
    try {
      body = readFile(join(dir, fileName));
    } catch {
      continue;
    }
    const result = parseCustomRoutineSpec(slug, body);
    if (result.ok) {
      specs.push(result.spec);
    } else {
      errors.push({ slug, error: result.error });
    }
  }

  return { specs, errors };
}

function defaultReadDir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir);
}

function defaultReadFile(path: string): string {
  return readFileSync(path, "utf-8");
}

/**
 * Compute which slugs to (un)register when reloading from disk. Pure
 * diff helper so the orchestrator class stays thin and the gate logic
 * is covered by unit tests without touching `cron.schedule`.
 */
export function diffRegistrations(
  current: Map<string, CustomRoutineSpec>,
  next: CustomRoutineSpec[],
): {
  toAdd: CustomRoutineSpec[];
  toReplace: CustomRoutineSpec[];
  toRemove: string[];
} {
  const nextBySlug = new Map<string, CustomRoutineSpec>();
  for (const spec of next) nextBySlug.set(spec.slug, spec);

  const toAdd: CustomRoutineSpec[] = [];
  const toReplace: CustomRoutineSpec[] = [];
  const toRemove: string[] = [];

  for (const [slug, spec] of nextBySlug) {
    const existing = current.get(slug);
    if (!existing) {
      if (spec.enabled) toAdd.push(spec);
      continue;
    }
    if (
      existing.cron !== spec.cron ||
      existing.enabled !== spec.enabled ||
      existing.backendTier !== spec.backendTier ||
      existing.maxBudgetUsd !== spec.maxBudgetUsd
    ) {
      if (spec.enabled) {
        toReplace.push(spec);
      } else {
        toRemove.push(slug);
      }
    }
  }

  for (const slug of current.keys()) {
    if (!nextBySlug.has(slug)) toRemove.push(slug);
  }

  return { toAdd, toReplace, toRemove };
}

export interface CustomRoutineSchedulerOptions {
  contextDir: string;
  eventBus: EventBus;
  timezone?: string;
  /** Injected by tests to skip real cron scheduling. */
  schedule?: (expr: string, callback: () => void, timezone?: string) => ScheduledTask;
}

/**
 * Orchestrates custom routine cron registration. Thin wrapper around
 * `node-cron` so the heavy lifting (parsing, diffing) lives in the
 * pure helpers above.
 */
export class CustomRoutineScheduler {
  private readonly contextDir: string;
  private readonly eventBus: EventBus;
  private readonly timezone: string | undefined;
  private readonly scheduleFn: NonNullable<CustomRoutineSchedulerOptions["schedule"]>;
  private readonly jobs = new Map<string, { spec: CustomRoutineSpec; job: ScheduledTask }>();
  private started = false;

  constructor(opts: CustomRoutineSchedulerOptions) {
    this.contextDir = opts.contextDir;
    this.eventBus = opts.eventBus;
    this.timezone = opts.timezone;
    this.scheduleFn =
      opts.schedule ??
      ((expr, cb, tz) => cron.schedule(expr, cb, tz ? { timezone: tz } : {}));
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.reload();
  }

  stop(): void {
    for (const { job } of this.jobs.values()) job.stop();
    this.jobs.clear();
    this.started = false;
  }

  /**
   * Re-enumerate the custom routines on disk and apply the diff.
   * Safe to call from any thread (API route hooks, startup).
   */
  reload(): { added: number; replaced: number; removed: number; errors: number } {
    const { specs, errors } = enumerateCustomRoutines(this.contextDir);
    for (const { slug, error } of errors) {
      logger.warn({ slug, error }, "Skipping custom routine with parse error");
    }

    const current = new Map<string, CustomRoutineSpec>(
      Array.from(this.jobs.entries()).map(([slug, entry]) => [slug, entry.spec]),
    );
    const { toAdd, toReplace, toRemove } = diffRegistrations(current, specs);

    for (const slug of toRemove) this.unregister(slug);
    for (const spec of toReplace) {
      this.unregister(spec.slug);
      this.register(spec);
    }
    for (const spec of toAdd) this.register(spec);

    logger.info(
      {
        added: toAdd.length,
        replaced: toReplace.length,
        removed: toRemove.length,
        errors: errors.length,
        total: this.jobs.size,
      },
      "Custom routines reloaded",
    );

    return {
      added: toAdd.length,
      replaced: toReplace.length,
      removed: toRemove.length,
      errors: errors.length,
    };
  }

  /** Snapshot of currently registered specs — used by dashboard / tests. */
  listRegistered(): CustomRoutineSpec[] {
    return Array.from(this.jobs.values()).map((entry) => entry.spec);
  }

  private register(spec: CustomRoutineSpec): void {
    if (!isCustomRoutineKey(spec.processKey)) {
      logger.warn(
        { slug: spec.slug, processKey: spec.processKey },
        "Rejecting custom routine with invalid process key",
      );
      return;
    }
    const job = this.scheduleFn(
      spec.cron,
      () => this.fire(spec),
      this.timezone,
    );
    this.jobs.set(spec.slug, { spec, job });
    logger.info({ slug: spec.slug, cron: spec.cron }, "Custom routine registered");
  }

  private unregister(slug: string): void {
    const entry = this.jobs.get(slug);
    if (!entry) return;
    entry.job.stop();
    this.jobs.delete(slug);
    logger.info({ slug }, "Custom routine unregistered");
  }

  private fire(spec: CustomRoutineSpec): void {
    // The downstream `RoutineEvent.requestedModel` contract is still the
    // binary `"sonnet" | "opus"` shape (used by the dashboard chat picker
    // / run-now); collapse the tri-tier `lite` and `medium` to "sonnet"
    // and `high` to "opus" until that wider contract is migrated.
    const event = {
      ...createEvent({
        type: spec.processKey,
        source: "custom-routine-scheduler",
        priority: EventPriority.NORMAL,
      }),
      routine: `custom.${spec.slug}`,
      requestedModel: spec.backendTier === "high" ? "opus" : "sonnet",
    } as RoutineEvent;

    void this.eventBus.put(event).catch((err: unknown) => {
      logger.error({ err, slug: spec.slug }, "Failed to enqueue custom routine event");
    });
    logger.info({ slug: spec.slug }, "Custom routine fired");
  }
}

/**
 * Convenience: extract the slug from a `policies/routines/custom/<slug>.md` path.
 * Returns null if the path is outside the custom-routine directory.
 * Used by the context API route when deciding whether to call `reload()`.
 */
export function slugFromCustomRoutinePath(relativePath: string): string | null {
  const prefix = `${CONTEXT_RELATIVE_PATHS.routines.customDir}/`;
  if (!relativePath.startsWith(prefix)) return null;
  const rest = relativePath.slice(prefix.length);
  if (!rest.endsWith(".md")) return null;
  const slug = rest.slice(0, -3);
  if (slug.includes("/")) return null;
  return slug;
}

export { customRoutineSlugFromKey };
