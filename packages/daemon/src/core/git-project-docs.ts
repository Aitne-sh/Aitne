import type Database from "better-sqlite3";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  formatSqliteDatetime,
  parseSqliteUtcMs,
} from "@aitne/shared";
import type { GitWatchedRepoSettingInput } from "../settings/runtime-settings.js";
import type { GitEventClassification } from "../observers/git-event-classifier.js";
import {
  gitRepoJournalPath,
  gitRepoOverviewPath,
  gitRepoPath,
  projectPath,
} from "./context-paths.js";
import { createLogger } from "../logging.js";

const logger = createLogger("git-project-docs");
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_TEMPLATE_NAME = "project.md";
const GIT_REPO_TEMPLATE_NAME = "git-repo.md";
/**
 * Cap on `events` array carried in a pending `git.project.update` task_context.
 * The array lands in the prompt verbatim; an unbounded array (a force-push /
 * rebase loop within the debounce window) would erode the token budget. We
 * keep the most recent N entries — a tag/merge that fired earlier and was
 * displaced is still recoverable from `git log` / `git ls-remote --tags`,
 * which the task-flow already permits.
 */
const MAX_PENDING_EVENT_SUMMARIES = 50;

export type GitRepoClassification = "project" | "repo-only";
export type GitRepoCategory =
  | "work"
  | "personal"
  | "research"
  | "client"
  | "other";

export interface NormalizedGitWatchedRepo {
  path: string;
  slug: string;
  classification: GitRepoClassification;
  category: GitRepoCategory;
  org?: string;
  accountAlias?: string;
  pollPriority: "high" | "normal";
  /**
   * Per-row poll cadence override (seconds). Null when the row should
   * fall back to the global default.
   */
  pollIntervalSec?: number | null;
  /**
   * `owner/repo` for rows that have a GitHub side. Null for local-only rows,
   * undefined for legacy test-only config inputs.
   */
  githubRepo?: string | null;
  /**
   * Stable id from the unified `repositories` table. Optional only for
   * the legacy `gitRepos` (string-array) path, which post-cutover is
   * exercised solely from tests; production callers always come through
   * `selectGitWatchedRepos(db)` and carry an id.
   */
  repositoryId?: string;
}

/**
 * Input shape for `normalizeGitWatchedRepos`. Production callers pass
 * `{ gitWatchedRepos: selectGitWatchedRepos(db) }`. Tests retain the
 * pre-cutover shape (including the legacy `gitRepos: string[]`
 * fallback) so test-only paths don't churn — see
 * `docs/design/appendices/unified-repositories.md` §3.4.
 */
export interface NormalizeGitWatchedReposInput {
  gitWatchedRepos?: readonly GitWatchedRepoSettingInput[];
  gitRepos?: readonly string[];
}

interface GitProjectScheduleDeps {
  db: Database.Database;
  dataDir: string;
  workspaceDir: string;
  now?: () => Date;
}

export interface QueueMissingGitProjectInitsOptions extends GitProjectScheduleDeps {
  contextDir: string;
  repos: NormalizedGitWatchedRepo[];
}

export interface QueueGitProjectUpdateOptions extends GitProjectScheduleDeps {
  repo: NormalizedGitWatchedRepo;
  event: Extract<GitEventClassification, { kind: "observe" }>;
  debounceMinutes: number;
}

interface ScheduleRow {
  id: number;
  scheduled_for: string;
  task_context: string | null;
  status: string;
}

interface GitProjectEventSummary {
  eventType: string;
  ref: string;
  payload: Record<string, unknown>;
  observedAt: string;
}

const FALLBACK_PROJECT_TEMPLATE = `---
type: project
owner: shared
updated: {updated}
slug: {repo_slug}
category: {category}
status: active
org: {org}
git_repo: {repo_path}
default_branch: {default_branch}
remote: {origin_url}
account_alias: {account_alias}
created: {first_commit_date}
last_activity: {last_commit_date}
---
# {repo_name}

## Overview
- Purpose:
- Current state:
- Primary owner:

## Git Activity
- Last reviewed: {updated}
- Default branch: {default_branch}
- Remote: {origin_url}

## Lifecycle Phases
- Initial documentation created from Git history.

## Notable Changes
- Add durable project milestones and important merges here.

## Open Threads
- Add follow-ups that should remain visible across sessions.

## History (compressed)
- Summarize older activity here as the file grows.
`;

const FALLBACK_GIT_REPO_TEMPLATE = `---
type: git-repo
owner: shared
updated: {updated}
slug: {repo_slug}
classification: repo-only
git_repo: {repo_path}
default_branch: {default_branch}
remote: {origin_url}
account_alias: {account_alias}
last_activity: {last_commit_date}
---
# {repo_name}

## Activity
- Last reviewed: {updated}
- Default branch: {default_branch}
- Remote: {origin_url}

## Recent Pushes
- Add notable remote changes here.
`;

function expandHome(p: string): string {
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return resolve(homedir(), p.slice(2));
  }
  return resolve(p);
}

export function slugifyRepoPath(repoPath: string): string {
  const trimmed = repoPath.replace(/[\\/]+$/g, "");
  const segments = trimmed.split(/[\\/]+/).filter((s) => s.length > 0);
  const name = (segments[segments.length - 1] ?? trimmed).replace(/\.git$/i, "");
  return slugifySegment(name);
}

function slugifySegment(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return slug || "repo";
}

function makeUniqueSlug(baseSlug: string, used: Set<string>): string {
  let candidate = baseSlug;
  let suffix = 2;
  while (used.has(candidate)) {
    const suffixText = `-${suffix}`;
    candidate = `${baseSlug.slice(0, Math.max(1, 80 - suffixText.length)).replace(/-+$/g, "")}${suffixText}`;
    suffix++;
  }
  used.add(candidate);
  return candidate;
}

export function normalizeGitWatchedRepos(
  input: NormalizeGitWatchedReposInput,
): NormalizedGitWatchedRepo[] {
  const usedSlugs = new Set<string>();
  const explicitPaths = new Set<string>();
  const repos: NormalizedGitWatchedRepo[] = [];

  const add = (
    raw: GitWatchedRepoSettingInput | string,
    legacyDefaults: Pick<
      NormalizedGitWatchedRepo,
      "classification" | "category" | "pollPriority"
    > = {
      classification: "repo-only",
      category: "other",
      pollPriority: "normal",
    },
  ) => {
    const rawPath = typeof raw === "string" ? raw : raw.path;
    const path = expandHome(rawPath);
    const rawSlug = typeof raw === "string" ? undefined : raw.slug;
    const slugBase = slugifySegment(rawSlug ?? slugifyRepoPath(path));
    const isLegacy = typeof raw === "string";
    repos.push({
      path,
      slug: makeUniqueSlug(slugBase, usedSlugs),
      classification: isLegacy
        ? legacyDefaults.classification
        : raw.classification ?? legacyDefaults.classification,
      category: isLegacy ? legacyDefaults.category : raw.category ?? legacyDefaults.category,
      org: isLegacy ? undefined : raw.org,
      accountAlias: isLegacy ? undefined : raw.accountAlias,
      pollPriority: isLegacy
        ? legacyDefaults.pollPriority
        : raw.pollPriority ?? legacyDefaults.pollPriority,
      pollIntervalSec: isLegacy ? null : raw.pollIntervalSec ?? null,
      githubRepo: isLegacy ? null : raw.githubRepo ?? null,
      repositoryId: isLegacy ? undefined : raw.repositoryId,
    });
    explicitPaths.add(path);
  };

  for (const repo of input.gitWatchedRepos ?? []) {
    add(repo);
  }
  for (const legacyPath of input.gitRepos ?? []) {
    const normalizedPath = expandHome(legacyPath);
    if (explicitPaths.has(normalizedPath)) continue;
    add(normalizedPath);
  }

  return repos;
}

export function repoDocContextFilePath(repo: NormalizedGitWatchedRepo): string {
  return gitRepoOverviewPath(repo.slug);
}

export function repoDocContextPath(repo: NormalizedGitWatchedRepo): string {
  return repoDocContextFilePath(repo).replace(/\.md$/, "");
}

export function repoDocTemplateName(repo: Pick<NormalizedGitWatchedRepo, "classification">): string {
  return repo.classification === "project"
    ? PROJECT_TEMPLATE_NAME
    : GIT_REPO_TEMPLATE_NAME;
}

export function resolveGitProjectTemplateRoot(workspaceDir: string): string {
  if (process.env.PA_GIT_PROJECT_TEMPLATES_DIR) {
    return expandHome(process.env.PA_GIT_PROJECT_TEMPLATES_DIR);
  }
  const workspaceCandidate = join(
    workspaceDir,
    "agent-assets",
    "project-doc-templates",
  );
  if (existsSync(workspaceCandidate)) return workspaceCandidate;
  return join(
    MODULE_DIR,
    "..",
    "..",
    "..",
    "..",
    "agent-assets",
    "project-doc-templates",
  );
}

export function seedGitProjectDocTemplates(
  dataDir: string,
  workspaceDir: string,
): void {
  const templatesDir = join(dataDir, "templates");
  mkdirSync(templatesDir, { recursive: true });
  const bundledRoot = resolveGitProjectTemplateRoot(workspaceDir);
  for (const name of [PROJECT_TEMPLATE_NAME, GIT_REPO_TEMPLATE_NAME]) {
    const target = join(templatesDir, name);
    if (existsSync(target)) continue;
    const bundled = join(bundledRoot, name);
    if (existsSync(bundled)) {
      copyFileSync(bundled, target);
    } else {
      writeFileSync(target, fallbackTemplateForName(name), "utf-8");
    }
  }
}

export function readGitProjectDocTemplate(
  dataDir: string,
  workspaceDir: string,
  classification: GitRepoClassification,
): string {
  const name = classification === "project"
    ? PROJECT_TEMPLATE_NAME
    : GIT_REPO_TEMPLATE_NAME;
  const userTemplate = join(dataDir, "templates", name);
  if (existsSync(userTemplate)) {
    return readFileSync(userTemplate, "utf-8");
  }
  return readBundledGitProjectDocTemplate(workspaceDir, classification);
}

/**
 * Bundled-only resolver — skips the `<dataDir>/templates/` override
 * layer. Used by the dashboard's template editor to render the "bundled"
 * column independently of whatever override the user may have written.
 */
export function readBundledGitProjectDocTemplate(
  workspaceDir: string,
  classification: GitRepoClassification,
): string {
  const name = classification === "project"
    ? PROJECT_TEMPLATE_NAME
    : GIT_REPO_TEMPLATE_NAME;
  const bundled = join(resolveGitProjectTemplateRoot(workspaceDir), name);
  if (existsSync(bundled)) {
    return readFileSync(bundled, "utf-8");
  }
  return fallbackTemplateForName(name);
}

function fallbackTemplateForName(name: string): string {
  return name === PROJECT_TEMPLATE_NAME
    ? FALLBACK_PROJECT_TEMPLATE
    : FALLBACK_GIT_REPO_TEMPLATE;
}

function buildBaseTaskContext(
  repo: NormalizedGitWatchedRepo,
  now: Date,
): Record<string, unknown> {
  const overviewPath = repoDocContextFilePath(repo);
  const journalPath = gitRepoJournalPath(repo.slug, now.toISOString().slice(0, 10));
  const repository = {
    id: repo.repositoryId ?? null,
    slug: repo.slug,
    localPath: repo.path,
    githubRepo: repo.githubRepo ?? null,
    classification: repo.classification,
    category: repo.category,
    org: repo.org ?? null,
    accountAlias: repo.accountAlias ?? null,
    pollPriority: repo.pollPriority,
  };
  return {
    repository,
    ...(repo.repositoryId ? { repositoryId: repo.repositoryId } : {}),
    slug: repo.slug,
    localPath: repo.path,
    githubRepo: repo.githubRepo ?? null,
    classification: repo.classification,
    category: repo.category,
    overviewPath,
    journalPath,
    lookbackHours: 24,
    importance: "low",
  };
}

export function queueMissingGitProjectInits(
  options: QueueMissingGitProjectInitsOptions,
): number {
  const now = options.now?.() ?? new Date();
  let inserted = 0;

  // Hoisted out of the loop: GitWatcher.start() fires `onRepoBaseline` once
  // per repo and each callback invokes this function over every repo, so
  // a per-iteration query was N² across baseline fan-out. Pending/running
  // paths for `task_type='git.project.init'` are repo-scoped and do not
  // change between iterations except via `insert.run` below — track newly
  // inserted repo paths in a local set instead of re-reading the DB.
  const existingRepoKeys = new Set(
    (
      options.db
        .prepare(
          `SELECT task_context
             FROM agent_schedule
            WHERE task_type = 'git.project.init'
              AND status IN ('pending', 'running')`,
        )
        .all() as Array<Pick<ScheduleRow, "task_context">>
    )
      .flatMap((row) => scheduleRepoKeys(parseTaskContext(row.task_context)))
  );
  const insert = options.db.prepare(
    `INSERT INTO agent_schedule
       (scheduled_for, task_type, task_description, task_context, correlation_id, model, status)
     VALUES (?, 'git.project.init', ?, ?, ?, NULL, 'pending')`,
  );

  for (const repo of options.repos) {
    const contextFile = repoDocContextFilePath(repo);
    if (existsSync(join(options.contextDir, contextFile))) continue;
    const legacyFile = legacyClassificationFilePaths(repo).find((file) =>
      existsSync(join(options.contextDir, file))
    );
    if (legacyFile) {
      logger.warn(
        {
          repo: repo.path,
          slug: repo.slug,
          classification: repo.classification,
          legacyFile,
          target: contextFile,
        },
        "Legacy git project context file exists; unified repository init will create git/<slug>/overview.md and leave the legacy file in place",
      );
    }
    if (hasExistingScheduleForRepo(existingRepoKeys, repo)) continue;
    const taskContext = {
      triggerSource: "git_watcher_baseline",
      processKey: "git.project.init",
      ...buildBaseTaskContext(repo, now),
    };
    insert.run(
      formatSqliteDatetime(now),
      `Initialize git project documentation for ${repo.slug}.`,
      JSON.stringify(taskContext),
      randomUUID(),
    );
    addScheduleKeysForRepo(existingRepoKeys, repo);
    inserted++;
  }
  return inserted;
}

function legacyClassificationFilePaths(repo: NormalizedGitWatchedRepo): string[] {
  return [projectPath(repo.slug), gitRepoPath(repo.slug)];
}

export function queueGitProjectUpdate(
  options: QueueGitProjectUpdateOptions,
): "queued" | "merged" | "debounced" | "skipped" {
  if (!shouldScheduleGitProjectUpdate(options.event)) {
    return "skipped";
  }

  const now = options.now?.() ?? new Date();
  const rows = options.db.prepare(
    `SELECT id, scheduled_for, task_context, status
       FROM agent_schedule
      WHERE task_type = 'git.project.update'
        AND status IN ('pending', 'running', 'completed')
      ORDER BY id DESC
      LIMIT 50`,
  ).all() as ScheduleRow[];

  const matching = rows
    .map((row) => ({ row, ctx: parseTaskContext(row.task_context) }))
    .filter(({ ctx }) => matchesScheduleForRepo(ctx, options.repo));

  if (matching.some(({ row }) => row.status === "running")) {
    return "debounced";
  }

  const pending = matching.find(({ row }) => row.status === "pending");
  const eventSummary = summarizeGitProjectEvent(options.event, now);
  if (pending) {
    const nextContext = mergeGitProjectEvent(
      pending.ctx,
      options.repo,
      now,
      eventSummary,
    );
    const result = options.db.prepare(
      `UPDATE agent_schedule
          SET task_context = ?
        WHERE id = ? AND status = 'pending'`,
    ).run(JSON.stringify(nextContext), pending.row.id);
    if (result.changes > 0) {
      return "merged";
    }
    // Race: the scheduler claimed the pending row between the SELECT and the
    // UPDATE (status flipped to 'running'). The running session now carries
    // the pre-merge context; if we returned here the new event would be
    // silently lost (`recentlyCompleted` would short-circuit any later
    // attempt within the debounce window). Fall through to insert a fresh
    // pending row so the next debounce window re-runs with this event.
  }

  const cutoffMs = now.getTime() - options.debounceMinutes * 60_000;
  const recentlyCompleted = matching.some(({ row }) =>
    row.status === "completed" && parseSqliteUtcMs(row.scheduled_for) >= cutoffMs,
  );
  if (recentlyCompleted) {
    return "debounced";
  }

  const taskContext = {
    triggerSource: "git_watcher_lifecycle",
    processKey: "git.project.update",
    ...buildBaseTaskContext(options.repo, now),
    events: [eventSummary],
  };
  options.db.prepare(
    `INSERT INTO agent_schedule
       (scheduled_for, task_type, task_description, task_context, correlation_id, model, status)
     VALUES (?, 'git.project.update', ?, ?, ?, NULL, 'pending')`,
  ).run(
    formatSqliteDatetime(now),
    `Update git project documentation for ${options.repo.slug}.`,
    JSON.stringify(taskContext),
    randomUUID(),
  );
  return "queued";
}

function parseTaskContext(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch (err) {
    logger.debug({ err }, "Failed to parse git project schedule context");
    return {};
  }
}

function shouldScheduleGitProjectUpdate(
  event: Extract<GitEventClassification, { kind: "observe" }>,
): boolean {
  if (event.eventType === "git.merge_to_default" || event.eventType === "git.tag.created") {
    return true;
  }
  if (event.eventType !== "git.push.detected") return false;
  const branch = event.payload.branch;
  const defaultBranch = event.payload.defaultBranch;
  return (
    typeof branch === "string"
    && typeof defaultBranch === "string"
    && branch === defaultBranch
  );
}

function summarizeGitProjectEvent(
  event: Extract<GitEventClassification, { kind: "observe" }>,
  now: Date,
): GitProjectEventSummary {
  return {
    eventType: event.eventType,
    ref: event.ref,
    payload: event.payload,
    observedAt: now.toISOString(),
  };
}

function mergeGitProjectEvent(
  existing: Record<string, unknown>,
  repo: NormalizedGitWatchedRepo,
  now: Date,
  event: GitProjectEventSummary,
): Record<string, unknown> {
  const base = {
    triggerSource: "git_watcher_lifecycle",
    processKey: "git.project.update",
    ...buildBaseTaskContext(repo, now),
    ...existing,
  };
  const currentEvents = Array.isArray(existing.events)
    ? existing.events.filter(isGitProjectEventSummary)
    : [];
  const alreadyPresent = currentEvents.some(
    (item) => item.eventType === event.eventType && item.ref === event.ref,
  );
  const merged = alreadyPresent ? currentEvents : [...currentEvents, event];
  // Cap the array — a force-push / rebase loop within a 15min debounce
  // window can accumulate dozens of summaries, and the array lands in the
  // prompt as JSON. Drop the oldest first; the agent re-reads `git log`
  // for definitive history anyway.
  const capped = merged.length > MAX_PENDING_EVENT_SUMMARIES
    ? merged.slice(merged.length - MAX_PENDING_EVENT_SUMMARIES)
    : merged;
  return { ...base, events: capped };
}

function scheduleRepoKeys(ctx: Record<string, unknown>): string[] {
  return [
    typeof ctx.repositoryId === "string" ? ctx.repositoryId : null,
    typeof ctx.localPath === "string" ? ctx.localPath : null,
    typeof ctx.repoPath === "string" ? ctx.repoPath : null,
  ].filter((value): value is string => Boolean(value));
}

function hasExistingScheduleForRepo(
  keys: Set<string>,
  repo: NormalizedGitWatchedRepo,
): boolean {
  return (
    (repo.repositoryId ? keys.has(repo.repositoryId) : false)
    || keys.has(repo.path)
  );
}

function addScheduleKeysForRepo(
  keys: Set<string>,
  repo: NormalizedGitWatchedRepo,
): void {
  if (repo.repositoryId) keys.add(repo.repositoryId);
  keys.add(repo.path);
}

function matchesScheduleForRepo(
  ctx: Record<string, unknown>,
  repo: NormalizedGitWatchedRepo,
): boolean {
  if (repo.repositoryId && ctx.repositoryId === repo.repositoryId) return true;
  return ctx.localPath === repo.path || ctx.repoPath === repo.path;
}

function isGitProjectEventSummary(value: unknown): value is GitProjectEventSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.eventType === "string"
    && typeof record.ref === "string"
    && typeof record.observedAt === "string"
    && !!record.payload
    && typeof record.payload === "object"
    && !Array.isArray(record.payload)
  );
}
