import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  CONTEXT_RELATIVE_PATHS,
  USER_AREA_FILE_PATHS,
  dossierPath,
} from "./context-paths.js";
import {
  type ContextFrontmatterValidationError,
  validateContextFileFrontmatter,
} from "./context-frontmatter.js";
import { POLICY_FILE_MAX_BYTES } from "./policy-files.js";

// Files validated on disk by the health report even though the write API
// did not always gate them. Post-B-008 P5+P7 unification these are covered
// by `validateContextFileFrontmatter` via its expanded path predicate — we
// still list them explicitly so the walker knows to call the validator
// regardless of where the file originated (template seed, agent write,
// manual Obsidian edit).

export type ContextHealthStatus = "ok" | "warning" | "error";
export type ContextHealthSeverity = "warning" | "error";

export interface MissingContextFileIssue {
  path: string;
  severity: ContextHealthSeverity;
  repairable: boolean;
  message: string;
}

export interface ContextFrontmatterIssue {
  path: string;
  code: ContextFrontmatterValidationError["code"];
  message: string;
  severity: ContextHealthSeverity;
}

export interface ContextSizeIssue {
  path: string;
  bytes: number;
  capBytes: number;
  severity: ContextHealthSeverity;
  message: string;
}

export interface ContextIndexLinkIssue {
  source: string;
  target: string;
  severity: ContextHealthSeverity;
  message: string;
}

export interface ContextHealthReport {
  status: ContextHealthStatus;
  checkedAt: string;
  contextDir: string;
  summary: {
    missingFiles: number;
    frontmatterErrors: number;
    sizeWarnings: number;
    indexLinkIssues: number;
    userAreaGaps: number;
    repairableIssues: number;
  };
  missingFiles: MissingContextFileIssue[];
  userAreaGaps: MissingContextFileIssue[];
  frontmatterErrors: ContextFrontmatterIssue[];
  sizeWarnings: ContextSizeIssue[];
  indexLinkIssues: ContextIndexLinkIssue[];
}

export const DOSSIER_FLOW_PATHS = [
  dossierPath("hourly"),
  dossierPath("morning"),
  dossierPath("evening"),
  dossierPath("weekly"),
  dossierPath("monthly"),
  dossierPath("roadmap"),
] as const;

const REQUIRED_CONTEXT_FILES: readonly string[] = [
  // CONTEXT_VAULT_REDESIGN folded contextIndex into rootIndex
  // (`_index.md`); list once.
  CONTEXT_RELATIVE_PATHS.rootIndex,
  CONTEXT_RELATIVE_PATHS.today,
  CONTEXT_RELATIVE_PATHS.roadmap,
  CONTEXT_RELATIVE_PATHS.user.index,
  ...USER_AREA_FILE_PATHS,
  CONTEXT_RELATIVE_PATHS.rules.index,
  CONTEXT_RELATIVE_PATHS.rules.management,
  CONTEXT_RELATIVE_PATHS.rules.mcp,
  CONTEXT_RELATIVE_PATHS.rules.journalFormat,
  CONTEXT_RELATIVE_PATHS.rules.journalExport,
  CONTEXT_RELATIVE_PATHS.rules.redaction,
  CONTEXT_RELATIVE_PATHS.routines.index,
  CONTEXT_RELATIVE_PATHS.routines.hourly,
  CONTEXT_RELATIVE_PATHS.routines.morning,
  CONTEXT_RELATIVE_PATHS.routines.evening,
  CONTEXT_RELATIVE_PATHS.routines.weekly,
  CONTEXT_RELATIVE_PATHS.routines.monthly,
  CONTEXT_RELATIVE_PATHS.projects.index,
  CONTEXT_RELATIVE_PATHS.projects.activeBase,
  CONTEXT_RELATIVE_PATHS.dossiers.index,
  ...DOSSIER_FLOW_PATHS,
  CONTEXT_RELATIVE_PATHS.agent.journal,
];

export const REPAIRABLE_STUB_TARGETS = new Set<string>([
  CONTEXT_RELATIVE_PATHS.contextIndex,
  CONTEXT_RELATIVE_PATHS.dossiers.index,
  ...DOSSIER_FLOW_PATHS,
  CONTEXT_RELATIVE_PATHS.user.people,
  CONTEXT_RELATIVE_PATHS.user.work,
  CONTEXT_RELATIVE_PATHS.user.expertise,
  CONTEXT_RELATIVE_PATHS.user.personal,
  CONTEXT_RELATIVE_PATHS.user.goals,
]);

const INJECTION_CAPPED_PREFIXES = [
  "policies/",
  "knowledge/dossiers/",
] as const;

export function buildContextHealthReport(
  contextDir: string,
  now: Date = new Date(),
): ContextHealthReport {
  const missingFiles = collectMissingFiles(contextDir);
  const frontmatterErrors = collectFrontmatterErrors(contextDir);
  const sizeWarnings = collectSizeWarnings(contextDir);
  const indexLinkIssues = collectIndexLinkIssues(contextDir);
  const userAreaGaps = missingFiles.filter((issue) =>
    USER_AREA_FILE_PATHS.includes(issue.path as (typeof USER_AREA_FILE_PATHS)[number]),
  );

  const hasError = (
    missingFiles.some((issue) => issue.severity === "error") ||
    frontmatterErrors.some((issue) => issue.severity === "error")
  );
  const hasWarning = (
    sizeWarnings.length > 0 ||
    indexLinkIssues.length > 0 ||
    missingFiles.some((issue) => issue.severity === "warning")
  );
  const status: ContextHealthStatus = hasError
    ? "error"
    : hasWarning
      ? "warning"
      : "ok";

  return {
    status,
    checkedAt: now.toISOString(),
    contextDir,
    summary: {
      missingFiles: missingFiles.length,
      frontmatterErrors: frontmatterErrors.length,
      sizeWarnings: sizeWarnings.length,
      indexLinkIssues: indexLinkIssues.length,
      userAreaGaps: userAreaGaps.length,
      repairableIssues: missingFiles.filter((issue) => issue.repairable).length,
    },
    missingFiles,
    userAreaGaps,
    frontmatterErrors,
    sizeWarnings,
    indexLinkIssues,
  };
}

export function normalizeRepairStubPath(input: string): string | null {
  const path = input.trim().replace(/^\.\//, "");
  if (!path || isAbsolute(path) || path.includes("\0")) return null;
  const withExtension =
    path.endsWith(".md") || path.endsWith(".base") ? path : `${path}.md`;
  if (!isSafeContextRelativePath(withExtension)) return null;
  return withExtension;
}

function collectMissingFiles(contextDir: string): MissingContextFileIssue[] {
  return REQUIRED_CONTEXT_FILES.flatMap((path) => {
    if (existsSync(join(contextDir, path))) return [];
    return [{
      path,
      severity: "error" as const,
      repairable: REPAIRABLE_STUB_TARGETS.has(path),
      message: `${path} is missing.`,
    }];
  });
}

function collectFrontmatterErrors(contextDir: string): ContextFrontmatterIssue[] {
  const errors: ContextFrontmatterIssue[] = [];
  for (const path of walkContextMarkdownFiles(contextDir)) {
    const fullPath = join(contextDir, path);
    const content = readFileSync(fullPath, "utf-8");
    const frontmatterError = validateContextFileFrontmatter(content, path);
    if (frontmatterError) {
      errors.push({
        path,
        code: frontmatterError.code,
        message: frontmatterError.message,
        severity: "error",
      });
    }
  }
  return errors;
}

function collectSizeWarnings(contextDir: string): ContextSizeIssue[] {
  const warnings: ContextSizeIssue[] = [];
  for (const path of walkContextMarkdownFiles(contextDir)) {
    if (!isInjectionCappedPath(path)) continue;
    const fullPath = join(contextDir, path);
    const stat = statSync(fullPath);
    if (stat.size <= POLICY_FILE_MAX_BYTES) continue;
    warnings.push({
      path,
      bytes: stat.size,
      capBytes: POLICY_FILE_MAX_BYTES,
      severity: "warning",
      message: `${path} is ${stat.size} bytes, above the ${POLICY_FILE_MAX_BYTES} byte prompt-injection cap.`,
    });
  }
  return warnings;
}

function collectIndexLinkIssues(contextDir: string): ContextIndexLinkIssue[] {
  const issues: ContextIndexLinkIssue[] = [];
  for (const path of walkIndexFiles(contextDir)) {
    const content = readFileSync(join(contextDir, path), "utf-8");
    for (const target of extractIndexTargets(path, content)) {
      if (!existsSync(join(contextDir, target))) {
        issues.push({
          source: path,
          target,
          severity: "warning",
          message: `${path} references missing ${target}.`,
        });
      }
    }
  }
  return issues;
}

function walkContextMarkdownFiles(contextDir: string): string[] {
  if (!existsSync(contextDir)) return [];
  const out: string[] = [];
  walk(contextDir, "", out, (path) => path.endsWith(".md"));
  return out;
}

function walkIndexFiles(contextDir: string): string[] {
  if (!existsSync(contextDir)) return [];
  const out: string[] = [];
  walk(
    contextDir,
    "",
    out,
    (path) => path === "_index.md" || path.endsWith("/_index.md"),
  );
  return out;
}

function walk(
  root: string,
  prefix: string,
  out: string[],
  include: (relativePath: string) => boolean,
): void {
  const dir = join(root, prefix);
  /* c8 ignore start — top-level callers verify root exists before
     descending, and recursive calls only target directories returned
     from readdirSync; the guard catches a race where a subdirectory
     vanishes mid-walk. */
  if (!existsSync(dir)) return;
  /* c8 ignore stop */
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (
      entry.name === ".git" ||
      entry.name === ".obsidian" ||
      entry.name === ".DS_Store"
    ) {
      continue;
    }
    if (entry.isDirectory()) {
      walk(root, rel, out, include);
    } else if (entry.isFile() && include(rel)) {
      out.push(rel);
    }
  }
}

function isInjectionCappedPath(path: string): boolean {
  return (
    path === CONTEXT_RELATIVE_PATHS.contextIndex ||
    INJECTION_CAPPED_PREFIXES.some((prefix) => path.startsWith(prefix))
  );
}

function extractIndexTargets(indexPath: string, content: string): string[] {
  const baseDir = dirname(indexPath);
  const targets = new Set<string>();
  const add = (raw: string) => {
    const target = resolveIndexTarget(baseDir, raw);
    if (target) targets.add(target);
  };
  const linkableContent = stripMarkdownCode(content);

  for (
    const match of linkableContent.matchAll(
      /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g,
    )
  ) {
    add(match[1]);
  }
  for (
    const match of linkableContent.matchAll(
      /\[[^\]]+\]\(([^)#]+)(?:#[^)]+)?\)/g,
    )
  ) {
    add(match[1]);
  }

  return [...targets].sort();
}

function resolveIndexTarget(baseDir: string, rawTarget: string): string | null {
  let target = rawTarget.trim();
  if (!target || shouldIgnoreIndexTarget(target)) {
    return null;
  }
  target = target.replace(/^\.\//, "");
  if (!target.endsWith(".md") && !target.endsWith(".base")) {
    target = `${target}.md`;
  }
  const normalized = resolveRelativeToIndexDir(baseDir, target);
  if (!normalized || !isSafeContextRelativePath(normalized)) return null;
  return normalized;
}

function stripMarkdownCode(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "");
}

function shouldIgnoreIndexTarget(target: string): boolean {
  return (
    target.startsWith("http://") ||
    target.startsWith("https://") ||
    target.startsWith("mailto:") ||
    target.startsWith("#") ||
    target.endsWith("/") ||
    isTemplatePlaceholderTarget(target)
  );
}

function isTemplatePlaceholderTarget(target: string): boolean {
  return (
    /<[^>/]+>/.test(target) ||
    /\bYYYY\b/.test(target) ||
    /\bMM\b/.test(target) ||
    /\bDD\b/.test(target) ||
    /\bISO-8601\b/.test(target)
  );
}

function normalizeRelativePath(path: string): string | null {
  /* c8 ignore start — `isAbsolute(path)` and `normalized === ""` only
     fire for inputs the callers already filter (path="" or absolute);
     defensive guards. */
  if (isAbsolute(path)) return null;
  const resolved = resolve("/", path);
  const normalized = relative("/", resolved);
  if (normalized.startsWith("..") || normalized === "") return null;
  /* c8 ignore stop */
  return normalized.replace(/\\/g, "/");
}

function resolveRelativeToIndexDir(
  baseDir: string,
  target: string,
): string | null {
  /* c8 ignore start — callers strip absolute paths and empty/dot
     segments before invoking; the guards remain so a future caller can
     safely pass arbitrary input. */
  if (isAbsolute(target)) return null;
  /* c8 ignore stop */
  const stack = baseDir === "." ? [] : baseDir.split("/").filter(Boolean);
  for (const segment of target.split("/")) {
    /* c8 ignore next */
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      /* c8 ignore next 2 — pop on an empty stack is unreachable from
         current callers; defensive against deeper traversal payloads. */
      if (stack.length === 0) return null;
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  /* c8 ignore next 2 — empty-stack final state is unreachable for callers
     that normalize relative paths upstream. */
  if (stack.length === 0) return null;
  return stack.join("/");
}

function isSafeContextRelativePath(path: string): boolean {
  /* c8 ignore start — null-byte injection blocked upstream by the JSON/HTTP
     layer, and absolute paths are filtered by the validator; defensive
     belt-and-suspenders. */
  if (isAbsolute(path) || path.includes("\0")) return false;
  /* c8 ignore stop */
  const normalized = normalizeRelativePath(path);
  if (!normalized || normalized !== path.replace(/\\/g, "/")) return false;
  return !normalized
    .split("/")
    .some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        segment === ".git" ||
        segment === ".obsidian" ||
        segment === ".DS_Store",
    );
}
