import { join } from "node:path";

/**
 * Canonical path constants for the vault layout (B-007 §5.1, shipped).
 * Every daemon module that references files inside `~/.personal-agent/context/`
 * imports from here instead of hardcoding strings. The full tree is
 * documented in `docs/design/06-memory.md`.
 *
 * Two layers:
 *  - `CONTEXT_RELATIVE_PATHS` — relative paths for DB / API / wikilink uses
 *    (no leading slash, kept stable across clean reinstall).
 *  - Helper `fullPath(contextDir, relativePath)` — joins against runtime
 *    `contextDir` (usually `~/.personal-agent/context`).
 */

export const CONTEXT_RELATIVE_PATHS = {
  rootIndex: "_index.md",

  today: "today.md",
  yesterday: "yesterday.md",
  roadmap: "roadmap.md",
  contextIndex: "context-index.md",

  user: {
    index: "user/_index.md",
    profile: "user/profile.md",
    people: "user/people.md",
    work: "user/work.md",
    expertise: "user/expertise.md",
    personal: "user/personal.md",
    goals: "user/goals.md",
  },

  rules: {
    index: "rules/_index.md",
    management: "rules/management.md",
    mcp: "rules/mcp.md",
    journalFormat: "rules/journal-format.md",
    journalExport: "rules/journal-export.md",
    redaction: "rules/redaction.md",
    policiesDir: "rules/policies",
    policiesIndex: "rules/policies/_index.md",
  },

  routines: {
    index: "routines/_index.md",
    hourly: "routines/hourly.md",
    morning: "routines/morning.md",
    evening: "routines/evening.md",
    weekly: "routines/weekly.md",
    monthly: "routines/monthly.md",
    customDir: "routines/custom",
  },

  projects: {
    index: "projects/_index.md",
    activeBase: "projects/_active.base",
    dir: "projects",
  },

  /**
   * @deprecated Legacy lightweight git-repo registry path. Replaced by the
   * `git/<slug>/overview.md` layout (docs/design/appendices/unified-repositories.md
   * §4.5). Kept as a const for transitional reads only — new writes go to
   * `git/<slug>/`.
   */
  gitRepos: {
    dir: "git-repos",
  },

  /**
   * Unified repositories — per-repo project overview + per-day journal.
   * See `docs/design/appendices/unified-repositories.md` §4.5.
   */
  git: {
    dir: "git",
  },

  daily: { dir: "daily" },
  weekly: { dir: "weekly" },
  monthly: { dir: "monthly" },

  dossiers: {
    index: "dossiers/_index.md",
    dir: "dossiers",
  },

  inbox: { dir: "inbox" },

  agent: {
    journal: "agent/journal.md",
    scratchDir: "agent/scratch",
  },
} as const;

/**
 * Directory names (no trailing slash) allowed under context/ for listing /
 * validation. Used by API route whitelists and reinstall planner.
 */
export const CONTEXT_DIR_NAMES = [
  "user",
  "rules",
  "rules/policies",
  "routines",
  "routines/custom",
  "projects",
  "git-repos",
  "git",
  "daily",
  "weekly",
  "monthly",
  "dossiers",
  "inbox",
  "agent",
  "agent/scratch",
] as const;

export type ContextDirName = (typeof CONTEXT_DIR_NAMES)[number];

/**
 * File types permitted inside context/. `.md` for all human-editable prose;
 * `.base` for Obsidian Bases views (B-007 §11).
 */
export const CONTEXT_FILE_EXTENSIONS = [".md", ".base"] as const;

export type ContextFileExtension = (typeof CONTEXT_FILE_EXTENSIONS)[number];

/**
 * Relative paths that are stored on disk as `.base` files. The context API
 * accepts these with or without the trailing extension and must never
 * silently fall back to a `.md` sibling.
 */
export const CONTEXT_BASE_FILE_STEMS = [
  CONTEXT_RELATIVE_PATHS.projects.activeBase.replace(/\.base$/, ""),
] as const;

export type ContextBaseFileStem = (typeof CONTEXT_BASE_FILE_STEMS)[number];

/**
 * Relative path to a daily synthesized journal file. The morning routine
 * writes this every 04:00 (B-007 §5.9).
 */
export function dailyJournalPath(dateStr: string): string {
  return `daily/${dateStr}.md`;
}

/**
 * Relative path to a weekly review file (ISO year-week format, e.g. 2026-W16).
 */
export function weeklyReviewPath(isoYearWeek: string): string {
  return `weekly/${isoYearWeek}.md`;
}

/**
 * Relative path to a monthly review file (YYYY-MM).
 */
export function monthlyReviewPath(yearMonth: string): string {
  return `monthly/${yearMonth}.md`;
}

/**
 * Relative path to a project file by slug (kebab-case, no extension).
 */
export function projectPath(slug: string): string {
  return `projects/${slug}.md`;
}

/**
 * Relative path to a lightweight git repository registry file.
 *
 * @deprecated Use `gitRepoOverviewPath(slug)` from the unified-repositories
 * layout. This helper is retained transitionally for reading legacy files
 * left behind in pre-cutover vaults.
 */
export function gitRepoPath(slug: string): string {
  return `git-repos/${slug}.md`;
}

/**
 * Relative path to the project-level overview MD for a unified repository.
 * Written by `git.project.init` and updated when something durable
 * changes during a daily scan. See appendix §4.5.
 */
export function gitRepoOverviewPath(slug: string): string {
  return `git/${slug}/overview.md`;
}

/**
 * Relative path to the per-day git journal entry for a unified repository.
 * Written by `git.project.update` (daily scan) when the day had activity.
 */
export function gitRepoJournalPath(slug: string, dateStr: string): string {
  return `git/${slug}/journal/${dateStr}.md`;
}

/**
 * Relative path to a custom routine definition.
 */
export function customRoutinePath(slug: string): string {
  return `routines/custom/${slug}.md`;
}

/**
 * Relative path to a dossier file for a given flow slug.
 */
export function dossierPath(flowSlug: string): string {
  return `dossiers/${flowSlug}.md`;
}

/**
 * Relative path to a management policy file
 * (MANAGEMENT-POLICY-CAPTURE-PLAN §4.1). Slug must match the validator's
 * kebab-case pattern; this helper does not re-validate.
 */
export function policyPath(slug: string): string {
  return `rules/policies/${slug}.md`;
}

/**
 * Relative path for an agent scratch file (ephemeral, 48h TTL — B-007 §5.3).
 */
export function agentScratchPath(dateStr: string, slug: string): string {
  return `agent/scratch/${dateStr}-${slug}.md`;
}

/**
 * Relative path for an inbox dump file (user-pasted memo, morning triage).
 */
export function inboxPath(dateStr: string, slug: string): string {
  return `inbox/${dateStr}-${slug}.md`;
}

/**
 * Join a relative context path with the runtime contextDir to produce an
 * absolute filesystem path.
 */
export function fullPath(contextDir: string, relativePath: string): string {
  return join(contextDir, relativePath);
}

/**
 * Return true if the relative path is one of the user-area files B-006/B-007
 * expect to exist post-setup. Used by validators and dashboard tree views.
 */
export const USER_AREA_FILE_PATHS = [
  CONTEXT_RELATIVE_PATHS.user.profile,
  CONTEXT_RELATIVE_PATHS.user.people,
  CONTEXT_RELATIVE_PATHS.user.work,
  CONTEXT_RELATIVE_PATHS.user.expertise,
  CONTEXT_RELATIVE_PATHS.user.personal,
  CONTEXT_RELATIVE_PATHS.user.goals,
] as const;

const USER_AREA_FILES = new Set<string>(USER_AREA_FILE_PATHS);

export function isKnownUserAreaFile(relativePath: string): boolean {
  return USER_AREA_FILES.has(relativePath);
}

/**
 * B-007 §6 — type field values for common frontmatter. Used by schema
 * validators and Bases view definitions.
 */
export const CONTEXT_FRONTMATTER_TYPES = [
  "project",
  "git-repo",
  "git-project",
  "git-journal",
  "user",
  "rule",
  "index",
  "daily",
  "weekly",
  "monthly",
  "dossier",
  "journal-entry",
  "scratch",
  "inbox",
] as const;

export type ContextFrontmatterType = (typeof CONTEXT_FRONTMATTER_TYPES)[number];
