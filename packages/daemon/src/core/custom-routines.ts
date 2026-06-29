import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import cron from "node-cron";
import { customRoutineKey } from "@aitne/shared";
import { CONTEXT_RELATIVE_PATHS } from "./context-paths.js";

/**
 * LEGACY custom-routine file format (B-007 §5.8 Q3) — parsing/enumeration
 * helpers only.
 *
 * The subsystem that FIRED these files (`CustomRoutineScheduler`, a per-file
 * node-cron job emitting `routine.custom.<slug>` events) was retired at the
 * Agents-hub redesign (AGENTS_HUB_REDESIGN_PLAN.md §3): user-defined recurring
 * work is a user Agent now (`agents` + `recurring_schedules`, visible on
 * `/agents` with metrics and execution history). What remains here serves two
 * callers:
 *
 *   1. `core/agents/custom-routine-migration.ts` — the one-time boot converter
 *      that turns each valid `policies/routines/custom/<slug>.md` into a user
 *      Agent definition.
 *   2. `core/context-validation/` — writes under the legacy path are still
 *      validated against this format so existing files stay well-formed
 *      (they are inert post-migration; the prompt-injection branch in
 *      `policy-files.ts` remains for one release).
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
 * specs so callers can log them without aborting.
 *
 * The readers are injectable for tests — by default they read from disk; a
 * missing directory yields empty results.
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
 * Convenience: extract the slug from a `policies/routines/custom/<slug>.md` path.
 * Returns null if the path is outside the custom-routine directory.
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
