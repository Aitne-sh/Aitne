import { join } from "node:path";

/**
 * Canonical path constants for the vault layout
 * (CONTEXT_VAULT_REDESIGN_PLAN.md §3 — six authority classes).
 *
 * Every daemon module that references files inside the vault imports
 * symbols from here instead of hardcoding strings. Symbol names are
 * preserved across the restructure (CONTEXT_VAULT_REDESIGN_PLAN.md §14.1)
 * — only the values move. That keeps 37+ importers "automatically"
 * pointing at the new layout once this module flips.
 *
 * Two layers:
 *  - `CONTEXT_RELATIVE_PATHS` — relative paths for DB / API / wikilink
 *    uses (no leading slash).
 *  - Helper `fullPath(contextDir, relativePath)` — joins against runtime
 *    `contextDir` (usually `~/.personal-agent/context`).
 *
 * Backward-compatibility for HTTP callers happens at the API layer via
 * `core/context-vault-aliases.ts:aliasVaultPath`. This file ships the
 * canonical destinations only.
 */

export const CONTEXT_RELATIVE_PATHS = {
  rootIndex: "_index.md",

  // ── state/ ────────────────────────────────────────────────────
  today: "state/today.md",
  yesterday: "state/yesterday.md",

  // Reconciler-merged index. The legacy top-level `context-index.md`
  // is folded into `_index.md`'s `<!-- reconciler-section -->` block
  // by the vault-restructure migration; the standalone path is gone.
  // Kept as a stem alias for code that snapshots by `contextIndex`.
  contextIndex: "_index.md",

  // ── identity/ ← user/ ────────────────────────────────────────
  user: {
    index: "identity/_index.md",
    profile: "identity/profile.md",
    people: "identity/people.md",
    work: "identity/work.md",
    expertise: "identity/expertise.md",
    personal: "identity/personal.md",
    goals: "identity/goals.md",
  },

  // ── policies/ ← rules/ + routines/ ───────────────────────────
  rules: {
    index: "policies/_index.md",
    management: "policies/management.md",
    mcp: "policies/mcp.md",
    journalFormat: "policies/journal-format.md",
    journalExport: "policies/journal-export.md",
    redaction: "policies/redaction.md",
    /**
     * `policies/management-captures/` — per
     * MANAGEMENT-POLICY-CAPTURE-PLAN §4.1, originally lived at
     * `rules/policies/`. Renamed in lockstep with the six-class move // drift-allow
     * to avoid the `policies/policies/` anti-pattern and to make the
     * directory name self-documenting.
     */
    policiesDir: "policies/management-captures",
    policiesIndex: "policies/management-captures/_index.md",
  },

  routines: {
    index: "policies/routines/_index.md",
    hourly: "policies/routines/hourly.md",
    morning: "policies/routines/morning.md",
    evening: "policies/routines/evening.md",
    weekly: "policies/routines/weekly.md",
    monthly: "policies/routines/monthly.md",
    customDir: "policies/routines/custom",
  },

  // `~/.personal-agent/integrations.md` moved under `policies/`.
  integrations: "policies/integrations.md",

  // Feedback Learning Loop (FEEDBACK_LEARNING_LOOP_DESIGN.md §3.3) —
  // global `agent`-scope lessons store, lazy-created on first nightly
  // consolidation write. Per-agent (`agent:<slug>`) lessons live next to
  // the agent definition under `policies/agents/<slug>/lessons.md` (Phase 4).
  agentLessons: "policies/agent-lessons.md",

  // User-registered skill bundles (lazy-created).
  skillsDir: "policies/skills",

  // ── plans/ ← projects/ + roadmap.md ──────────────────────────
  roadmap: "plans/roadmap.md",
  projects: {
    index: "plans/projects/_index.md",
    activeBase: "plans/projects/_active.base",
    dir: "plans/projects",
  },

  // ── knowledge/repos/ ← git/<slug>/ overview ──────────────────
  git: {
    dir: "knowledge/repos",
  },
  /**
   * @deprecated Legacy lightweight git-repo registry path. Replaced by
   * the unified `knowledge/repos/<slug>/overview.md` layout. Pre-existing
   * vaults preserve `git-repos/` content under
   * `knowledge/repos/legacy-registry/`; no new code writes here.
   */
  gitRepos: {
    dir: "knowledge/repos/legacy-registry",
  },

  // ── journal/ ← daily/ + weekly/ + monthly/ + agent/journal.md +
  //              git/<slug>/journal/ ─────────────────────────────
  daily: { dir: "journal/daily" },
  weekly: { dir: "journal/weekly" },
  monthly: { dir: "journal/monthly" },

  // ── knowledge/dossiers/ ← dossiers/ ──────────────────────────
  dossiers: {
    index: "knowledge/dossiers/_index.md",
    dir: "knowledge/dossiers",
  },

  // ── state/ subpaths ──────────────────────────────────────────
  inbox: { dir: "state/inbox" },

  agent: {
    /** Agent decision log; CREATE_ONLY_PUT + append-only PATCH. */
    journal: "journal/agent.md",
    /** 48h-TTL agent scratch dir (state/scratch/YYYY-MM-DD-<slug>.md). */
    scratchDir: "state/scratch",
    /** Profile-question queue — agent-owned operational state. */
    profileQuestions: "state/profile-questions.md",
  },

  // Generated 90-day activity views written by the activity reconciler.
  activityDir: "state/activity",

  // ── knowledge/entities/ — management registry surface ────────
  entitiesDir: "knowledge/entities",

  // ── knowledge/wiki/ ← <dataDir>/wiki/ ────────────────────────
  wikiDir: "knowledge/wiki",
} as const;

/**
 * Directory names (no trailing slash) the daemon creates under
 * contextDir on `initDirectories`. Listed in dependency order so
 * `mkdir -p` resolves nested entries.
 *
 * Each of the six classes is present here so a fresh install lands on
 * the new layout before any migration runs. The
 * CONTEXT_VAULT_REDESIGN_PLAN.md v4.1 V18 invariant pins this: step 4
 * (`bootstrapManagementMd`) writes `<contextDir>/policies/integrations.md`
 * and runs before `ensureSkeletonFiles`, so `policies/` MUST exist by
 * the time `initDirectories` completes.
 */
export const CONTEXT_DIR_NAMES = [
  "identity",
  "state",
  "state/inbox",
  "state/scratch",
  "state/activity",
  "plans",
  "plans/projects",
  "journal",
  "journal/daily",
  "journal/weekly",
  "journal/monthly",
  "journal/repos",
  "knowledge",
  "knowledge/dossiers",
  "knowledge/wiki",
  "knowledge/repos",
  "knowledge/entities",
  "policies",
  "policies/routines",
  "policies/routines/custom",
  "policies/management-captures",
  "policies/skills",
] as const;

export type ContextDirName = (typeof CONTEXT_DIR_NAMES)[number];

/**
 * File types permitted inside context/. `.md` for all human-editable
 * prose; `.base` for Obsidian Bases views.
 */
export const CONTEXT_FILE_EXTENSIONS = [".md", ".base"] as const;

export type ContextFileExtension = (typeof CONTEXT_FILE_EXTENSIONS)[number];

/**
 * Relative paths that are stored on disk as `.base` files. The context
 * API accepts these with or without the trailing extension and must
 * never silently fall back to a `.md` sibling.
 */
export const CONTEXT_BASE_FILE_STEMS = [
  CONTEXT_RELATIVE_PATHS.projects.activeBase.replace(/\.base$/, ""),
] as const;

export type ContextBaseFileStem = (typeof CONTEXT_BASE_FILE_STEMS)[number];

/**
 * Relative path to a daily synthesized journal file. The morning
 * routine writes this every 04:00.
 */
export function dailyJournalPath(dateStr: string): string {
  return `journal/daily/${dateStr}.md`;
}

/**
 * Relative path to a weekly review file (ISO year-week format, e.g. 2026-W16).
 */
export function weeklyReviewPath(isoYearWeek: string): string {
  return `journal/weekly/${isoYearWeek}.md`;
}

/**
 * Relative path to a monthly review file (YYYY-MM).
 */
export function monthlyReviewPath(yearMonth: string): string {
  return `journal/monthly/${yearMonth}.md`;
}

/**
 * Relative path to a project file by slug (kebab-case, no extension).
 */
export function projectPath(slug: string): string {
  return `plans/projects/${slug}.md`;
}

/**
 * Relative path to a lightweight git repository registry file.
 *
 * @deprecated Use `gitRepoOverviewPath(slug)`. Retained for reading the
 * pre-restructure legacy entries preserved under
 * `knowledge/repos/legacy-registry/`.
 */
export function gitRepoPath(slug: string): string {
  return `knowledge/repos/legacy-registry/${slug}.md`;
}

/**
 * Relative path to the project-level overview MD for a unified
 * repository.
 */
export function gitRepoOverviewPath(slug: string): string {
  return `knowledge/repos/${slug}/overview.md`;
}

/**
 * Relative path to the per-day git journal entry for a unified
 * repository.
 */
export function gitRepoJournalPath(slug: string, dateStr: string): string {
  return `journal/repos/${slug}/${dateStr}.md`;
}

/**
 * Relative path to a custom routine definition.
 */
export function customRoutinePath(slug: string): string {
  return `policies/routines/custom/${slug}.md`;
}

/**
 * Relative path to an Agent's per-agent (`agent:<slug>`) feedback lessons store
 * (FEEDBACK_LEARNING_LOOP_DESIGN.md §3.3, Phase 4). Sits next to the agent
 * definition at `policies/agents/<slug>/agent.md`; lazy-created on the first
 * nightly consolidation write and injected only into that agent's own
 * executions. The slug is assumed pre-validated (`isSafeAgentSlug`); this
 * helper does not re-validate — it only composes the canonical path.
 */
export function agentLessonsPath(slug: string): string {
  return `policies/agents/${slug}/lessons.md`;
}

/**
 * Relative path to a dossier file for a given flow slug.
 */
export function dossierPath(flowSlug: string): string {
  return `knowledge/dossiers/${flowSlug}.md`;
}

/**
 * Relative path to a management policy capture file
 * (MANAGEMENT-POLICY-CAPTURE-PLAN §4.1). Slug must match the validator's
 * kebab-case pattern; this helper does not re-validate.
 */
export function policyPath(slug: string): string {
  return `policies/management-captures/${slug}.md`;
}

/**
 * Relative path for an agent scratch file (ephemeral, 48h TTL).
 */
export function agentScratchPath(dateStr: string, slug: string): string {
  return `state/scratch/${dateStr}-${slug}.md`;
}

/**
 * Relative path for an inbox dump file (user-pasted memo, morning triage).
 */
export function inboxPath(dateStr: string, slug: string): string {
  return `state/inbox/${dateStr}-${slug}.md`;
}

/**
 * Relative path to a 90-day Activity view file.
 */
export function activityViewPath(source: string): string {
  return `state/activity/${source}.md`;
}

/**
 * Relative path to a management-registry entity file.
 */
export function entityPath(
  domain: string,
  typePlural: string,
  slug: string,
): string {
  return `knowledge/entities/${domain}/${typePlural}/${slug}.md`;
}

/**
 * Relative path to a management-registry domain index.
 */
export function entityDomainIndexPath(domain: string): string {
  return `knowledge/entities/${domain}/_index.md`;
}

/**
 * Join a relative context path with the runtime contextDir to produce
 * an absolute filesystem path.
 */
export function fullPath(contextDir: string, relativePath: string): string {
  return join(contextDir, relativePath);
}

/**
 * Return true if the relative path is one of the identity-area files
 * post-setup expects to exist. Used by validators and dashboard tree
 * views.
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
 * Frontmatter `type:` field values used by schema validators and Bases
 * view definitions. CONTEXT_VAULT_REDESIGN_PLAN.md §5.2 keeps this
 * legacy enum alongside the new `kind:` field — both coexist during
 * the Phase 1 → Phase 2 transition. New entity shapes that ride along
 * with the restructure (management registry meetings/trips/etc, agent
 * profile-question queue, activity-log views) are listed here.
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
  // Added in lockstep with the vault restructure (v4 V10).
  "agent_questions",
  "activity-log",
  "meeting",
  "trip",
  "receipt",
  "book",
  "note",
] as const;

export type ContextFrontmatterType = (typeof CONTEXT_FRONTMATTER_TYPES)[number];
