import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";
import { formatSqliteDatetime, localDateStr } from "@aitne/shared";
import type { RepositoryDTO } from "../db/repositories-store.js";
import type { AgentWriteTracker } from "../safety/agent-write-tracker.js";
import { writeFileAtomically } from "./atomic-write.js";
import { gitRepoJournalPath, gitRepoOverviewPath } from "./context-paths.js";
import { withOverviewWriteLock } from "./overview-write-lock.js";
import { createLogger } from "../logging.js";

const logger = createLogger("repository-management-docs");

const LOG_LIMIT = 200;
const MAX_TEXT_BYTES = 16_000;
const MAX_STAT_BYTES = 20_000;

const ARCHITECTURE_BEGIN_MARKER = "<!-- architecture:start -->";
const ARCHITECTURE_END_MARKER = "<!-- architecture:end -->";
const ARCHITECTURE_PLACEHOLDER =
  "_Architecture analysis pending. Click \"Refresh architecture\" on the Daily git management panel — an agent will read the repository and replace this block with a detailed module / data-flow / integration breakdown._";

const ARCHITECTURE_SECTION_MAX_BYTES = 64 * 1024;

/**
 * How long a `git.project.refresh_architecture` row may sit in
 * `pending` or `running` before the in-flight check treats it as stuck
 * and rescues it (`status = 'skipped'`). A pending row older than this
 * means the scheduler never picked it up — backend quota out, an
 * unrecoverable pre-condition failure, or the dispatcher pruning it
 * mid-flight. A running row older than this means the daemon crashed
 * mid-execution without flipping status, and the next startup
 * `recoverOrphanedRunningSchedules` would resolve it — but that leaves
 * dashboard buttons disabled until the daemon restarts.
 *
 * Without this rescue the dashboard's Generate-overview / Refresh-
 * architecture buttons stay disabled forever for the affected repo.
 * Sixty minutes is comfortably longer than any real architecture
 * analysis (typical runs settle in single-digit minutes) but short
 * enough that a user who hits a stuck row early in the day can
 * recover the same session by clicking again. Manual cancel and
 * timeout warnings are tracked separately.
 */
export const STUCK_ARCHITECTURE_REFRESH_THRESHOLD_MS = 60 * 60 * 1000;

export interface RepositoryManagementDocDeps {
  db: Database.Database;
  contextDir: string;
  repo: RepositoryDTO;
  now?: Date;
  timezone?: string;
  lookbackHours?: number;
  writeTracker?: AgentWriteTracker;
  onIndexableContextChange?: (path: string) => void;
}

export interface ManagementInitResult {
  status: "written" | "exists";
  overviewPath: string;
  absolutePath: string;
  readmeCopiedTo: string | null;
  /**
   * `agent_schedule.id` of the `git.project.refresh_architecture` row
   * that owns the agent run filling in the `## Architecture` body, or
   * `null` when init does not need to schedule one.
   *
   * Non-null when:
   * - A fresh skeleton was just written (`status: "written"`) — id of
   *   the row that was just inserted.
   * - The overview already exists with `architecture_status: pending`
   *   and a refresh is already in flight (`status: "running"` or
   *   `"pending"` in `agent_schedule`). The same id is returned so the
   *   dashboard can keep polling without inserting a duplicate that
   *   would race on the chokepoint write.
   * - The overview already exists with `architecture_status: pending`
   *   and a previous refresh has settled (failed/completed/skipped)
   *   without landing the body — a fresh recovery row is inserted so
   *   the next scheduler tick re-runs the analysis.
   *
   * `null` when:
   * - The overview's frontmatter reports `architecture_status:
   *   complete` — an analysis already landed; re-running is the
   *   explicit "Refresh architecture" button's job, not init's.
   * - The overview's frontmatter is missing, malformed, or carries an
   *   unrecognized status value. `runRepositoryArchitectureSectionReplace`
   *   cannot promote a file that lacks `---\n` frontmatter, so
   *   auto-enqueueing in that state would loop on every init click.
   *   Hand-managed files are left to the explicit refresh button.
   */
  architectureScheduleId: number | null;
}

export interface InFlightArchitectureRefresh {
  scheduleId: number;
  correlationId: string;
  status: "pending" | "running";
}

export interface EnqueueArchitectureRefreshResult {
  scheduleId: number;
  correlationId: string;
}

export interface ArchitectureSectionReplaceResult {
  status: "written" | "no_overview";
  overviewPath: string;
  absolutePath: string;
  refreshedAt: string;
}

export interface ManagementScanResult {
  status: "written" | "skipped_no_activity";
  overviewPath: string;
  journalPath: string;
  absoluteJournalPath: string;
  commitCount: number;
  prEvents: number;
  workflowEvents: number;
}

interface GitCommit {
  hash: string;
  short: string;
  date: string;
  author: string;
  subject: string;
}

interface GitEvidence {
  currentBranch: string;
  remoteUrl: string | null;
  firstCommitDate: string | null;
  lastCommitDate: string | null;
  recentCommits: GitCommit[];
  readmeFileName: string | null;
}

interface ObservationSummary {
  source: string;
  ref: string;
  changeType: string;
  observedAt: string;
  summary: string | null;
}

/**
 * Initialize (or reuse) the per-repository overview document and ensure the
 * agent will fill in the `## Architecture` section.
 *
 * The init flow is intentionally split into two phases that the daemon
 * owns end-to-end so that one click — manual init from the dashboard, the
 * GitWatcher baseline, or the cron-driven daily scan that finds the file
 * missing — always lands a complete overview.md once the queued agent run
 * settles:
 *
 *  1. **Skeleton** (synchronous, deterministic): write the YAML
 *     frontmatter, the git-evidence Summary, the placeholder Architecture
 *     block bracketed by markers, the Notable Changes list rendered from
 *     `git log`, and the empty Open Threads / Daily Activity Log sections.
 *     Mirror the repository's README into `git/<slug>/README.md` so the
 *     agent can read it through the daemon-owned context dir without
 *     leaving the workspace.
 *  2. **Architecture refresh** (asynchronous, agent-driven): enqueue a
 *     `git.project.refresh_architecture` row in `agent_schedule`. The
 *     scheduler dispatches it through the standard scheduled.task path,
 *     the agent reads the repo, and writes the body back through the
 *     `PUT /api/repositories/:id/architecture-section` chokepoint which
 *     surgically replaces the marker-bracketed Architecture block.
 *
 * The enqueue is idempotent in two dimensions:
 *
 *  - When the overview already exists with `architecture_status: complete`
 *    (a previous refresh landed), no new schedule row is inserted.
 *  - When a `pending`/`running` `git.project.refresh_architecture` row
 *    already exists for this repository, the existing row is returned
 *    instead of inserting a duplicate. Two concurrent agent sessions
 *    would race on the chokepoint write and burn quota.
 *
 * Re-init on an existing overview whose `architecture_status` is still
 * `pending` re-enqueues a refresh — that recovers cases where a prior
 * agent run failed or never landed (e.g. before the `{context}`-injection
 * fix that gave the task-flow access to `<task_context>`).
 */
export function runRepositoryManagementInit(
  deps: RepositoryManagementDocDeps,
): ManagementInitResult {
  const localPath = requireLocalPath(deps.repo);
  const now = deps.now ?? new Date();
  const date = dateStamp(now, deps.timezone);
  const overviewPath = gitRepoOverviewPath(deps.repo.slug);
  const absolutePath = join(deps.contextDir, overviewPath);

  if (existsSync(absolutePath)) {
    const readmeCopiedTo = copyRepositoryReadme(deps, localPath);
    const architectureScheduleId = ensureArchitectureRefreshForExisting(
      deps,
      absolutePath,
      now,
    );
    return {
      status: "exists",
      overviewPath,
      absolutePath,
      readmeCopiedTo,
      architectureScheduleId,
    };
  }

  const evidence = collectGitEvidence(localPath);
  const content = renderOverview({
    repo: deps.repo,
    evidence,
    date,
  });
  writeManagedContextFile(deps, overviewPath, content, "repository_management_init");
  const readmeCopiedTo = copyRepositoryReadme(deps, localPath);
  const architectureScheduleId = ensureArchitectureRefreshEnqueued(
    deps.db,
    deps.repo,
    now,
  );
  return {
    status: "written",
    overviewPath,
    absolutePath,
    readmeCopiedTo,
    architectureScheduleId,
  };
}

/**
 * For the "overview already exists" branch of init: only enqueue a
 * refresh when the existing file's frontmatter explicitly reports
 * `architecture_status: pending`. Any other state — `complete`, an
 * unrecognized value, missing frontmatter, or malformed YAML — produces
 * `null` and falls through to the explicit "Refresh architecture" button.
 *
 * The strict reading is deliberate: `runRepositoryArchitectureSectionReplace`
 * only writes the status field back when the file already starts with
 * `---\n`, so a file that was hand-edited to drop its frontmatter will
 * never have the field re-added by an agent run. Treating "missing
 * frontmatter" as `pending` would queue a refresh, the agent would land
 * the architecture body, the field would still be absent, and the next
 * init click would queue the same work again — an unbounded loop bounded
 * only by the in-flight guard. Returning `null` here makes the behavior
 * stable for hand-managed files: the user must explicitly click
 * "Refresh architecture" to opt into a re-run.
 */
function ensureArchitectureRefreshForExisting(
  deps: RepositoryManagementDocDeps,
  absolutePath: string,
  now: Date,
): number | null {
  const status = readArchitectureStatus(absolutePath);
  if (status !== "pending") return null;
  return ensureArchitectureRefreshEnqueued(deps.db, deps.repo, now);
}

type ArchitectureFrontmatterStatus = "pending" | "complete" | "unknown";

/**
 * Inspect the YAML frontmatter of a managed overview file and classify
 * its `architecture_status` field. Three explicit states keep the init
 * decision logic narrow:
 *
 *   - `"pending"`: the agent has not yet landed an analysis. The init
 *     flow will (re-)enqueue a refresh.
 *   - `"complete"`: an analysis already landed. Init skips so re-running
 *     it is reserved for the explicit "Refresh architecture" button.
 *   - `"unknown"`: anything else — frontmatter missing, no closing
 *     `---`, no `architecture_status` field, or an unrecognized value.
 *     Init treats this as "do not auto-enqueue" because
 *     `runRepositoryArchitectureSectionReplace` only writes the field
 *     back on files that already start with `---\n`, so a queued
 *     refresh cannot move a hand-managed file out of "unknown".
 *
 * Caller is responsible for `existsSync(absolutePath)` — this helper
 * follows the read-after-exists pattern used elsewhere in this file
 * (`appendOverviewDailyLog`, `runRepositoryArchitectureSectionReplace`)
 * and lets the I/O error surface up to the route's 500 path.
 */
function readArchitectureStatus(
  absolutePath: string,
): ArchitectureFrontmatterStatus {
  const body = readFileSync(absolutePath, "utf-8");
  if (!body.startsWith("---\n")) return "unknown";
  const closeIdx = body.indexOf("\n---\n", 4);
  if (closeIdx < 0) return "unknown";
  const frontmatter = body.slice(4, closeIdx);
  const match = /^architecture_status:\s*(\S+)\s*$/m.exec(frontmatter);
  if (!match) return "unknown";
  if (match[1] === "complete") return "complete";
  if (match[1] === "pending") return "pending";
  return "unknown";
}

/**
 * Enqueue a `git.project.refresh_architecture` agent run for `repo`,
 * skipping when one is already in flight. Used by both the init flow
 * (auto-enqueue when a fresh skeleton lands or recovery on a pending
 * existing file) and the dashboard's "Refresh architecture" button.
 *
 * The scheduled row carries the full `task_context` the task-flow reads
 * (`repositoryId`, `slug`, `localPath`, `githubRepo`, `classification`,
 * `category`, `correlationId`). The dispatcher's `executeScheduledTask`
 * picks up the `processKey` field to route the prompt through the
 * `git.project.refresh_architecture.md` task-flow; the `<task_context>`
 * block is materialized into the prompt by the context-builder via the
 * `{context}` placeholder at the top of that task-flow file.
 */
export function ensureArchitectureRefreshEnqueued(
  db: Database.Database,
  repo: RepositoryDTO,
  now: Date = new Date(),
): number | null {
  if (!repo.localPath) {
    throw new Error("Architecture refresh requires a local clone");
  }
  const existing = findInFlightArchitectureRefresh(db, repo.id);
  if (existing) return existing.scheduleId;
  const inserted = enqueueArchitectureRefresh(db, repo, now);
  return inserted.scheduleId;
}

/**
 * Insert a fresh `git.project.refresh_architecture` row unconditionally.
 * Callers that need idempotency should go through
 * `ensureArchitectureRefreshEnqueued` instead — this primitive exists so
 * the dashboard's "Refresh architecture" route can compose its own
 * 409-on-in-flight response rather than collapsing the two cases.
 */
export function enqueueArchitectureRefresh(
  db: Database.Database,
  repo: RepositoryDTO,
  now: Date = new Date(),
): EnqueueArchitectureRefreshResult {
  if (!repo.localPath) {
    throw new Error("Architecture refresh requires a local clone");
  }
  const correlationId = randomUUID();
  const taskContext = {
    processKey: "git.project.refresh_architecture",
    repositoryId: repo.id,
    slug: repo.slug,
    localPath: repo.localPath,
    githubRepo:
      repo.githubOwner && repo.githubRepo
        ? `${repo.githubOwner}/${repo.githubRepo}`
        : null,
    classification: repo.classification,
    category: repo.category,
    correlationId,
  } satisfies Record<string, unknown>;
  const result = db
    .prepare(
      `INSERT INTO agent_schedule
         (scheduled_for, task_type, task_description, task_context, correlation_id, model, status)
       VALUES (?, 'git.project.refresh_architecture', ?, ?, ?, NULL, 'pending')`,
    )
    .run(
      formatSqliteDatetime(now),
      `Refresh architecture analysis for ${repo.slug}.`,
      JSON.stringify(taskContext),
      correlationId,
    );
  return { scheduleId: Number(result.lastInsertRowid), correlationId };
}

/**
 * Locate an in-flight `git.project.refresh_architecture` row for this
 * repository so the init / refresh-architecture flows can short-circuit
 * duplicate enqueues. Two concurrent agent sessions for the same repo
 * would race on the chokepoint write and burn quota for no benefit.
 *
 * Before reading, this also rescues any pending/running row older than
 * `STUCK_ARCHITECTURE_REFRESH_THRESHOLD_MS` by flipping its status to
 * `skipped`. Without that sweep, a row stuck in `pending` (scheduler
 * never picked it up — quota out, backend down) or `running` (daemon
 * crashed mid-execution) would keep the dashboard's Generate-overview
 * and Refresh-architecture buttons disabled forever, and the next
 * click — even at full health — would 409 because this function would
 * still report the row in flight. The rescue lets the user click
 * again immediately and inserts a fresh row, while leaving an audit
 * trail (status: skipped) of the stuck attempt. Manual cancel and
 * timeout warnings are tracked separately.
 *
 * Reads `task_context.repositoryId` via JSON path; the table is small and
 * this call is rare so a per-row scan is fine.
 */
export function findInFlightArchitectureRefresh(
  db: Database.Database,
  repositoryId: string,
  now: Date = new Date(),
): InFlightArchitectureRefresh | null {
  const stuckBefore = formatSqliteDatetime(
    new Date(now.getTime() - STUCK_ARCHITECTURE_REFRESH_THRESHOLD_MS),
  );
  // `scheduled_for` is the canonical "when should this run" timestamp
  // for an agent_schedule row — it's set explicitly at enqueue and is
  // the value the scheduler watches. `created_at` defaults to
  // `CURRENT_TIMESTAMP` and is *not* test-controlled, so using it here
  // would prevent any deterministic test of the rescue threshold and
  // leak wall-clock time into the production check. For an
  // architecture refresh, `scheduled_for` is set to "now" at enqueue
  // (immediate dispatch), so freshness based on `scheduled_for`
  // matches the freshness based on enqueue time in production.
  db.prepare(
    `UPDATE agent_schedule
        SET status = 'skipped'
      WHERE task_type = 'git.project.refresh_architecture'
        AND status IN ('pending', 'running')
        AND json_extract(task_context, '$.repositoryId') = ?
        AND scheduled_for < ?`,
  ).run(repositoryId, stuckBefore);

  const row = db
    .prepare(
      `SELECT id, correlation_id, status
         FROM agent_schedule
        WHERE task_type = 'git.project.refresh_architecture'
          AND status IN ('pending', 'running')
          AND json_extract(task_context, '$.repositoryId') = ?
        ORDER BY id DESC
        LIMIT 1`,
    )
    .get(repositoryId) as
      | { id: number; correlation_id: string | null; status: string }
      | undefined;
  if (!row) return null;
  return {
    scheduleId: row.id,
    correlationId: row.correlation_id ?? "",
    status: row.status as "pending" | "running",
  };
}

export async function runRepositoryManagementScan(
  deps: RepositoryManagementDocDeps,
): Promise<ManagementScanResult> {
  const localPath = requireLocalPath(deps.repo);
  const now = deps.now ?? new Date();
  const lookbackHours = deps.lookbackHours ?? 24;
  const date = dateStamp(now, deps.timezone);
  const since = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);
  const overviewPath = gitRepoOverviewPath(deps.repo.slug);
  const journalPath = gitRepoJournalPath(deps.repo.slug, date);
  const absoluteJournalPath = join(deps.contextDir, journalPath);

  const commits = gitLog(localPath, [
    `--since=${since.toISOString()}`,
    `--max-count=${LOG_LIMIT}`,
  ]);
  const observations = recentRepositoryObservations(deps.db, deps.repo, since);
  const prEvents = observations.filter((row) =>
    row.source.startsWith("github:notification:"),
  ).length;
  const workflowEvents = observations.filter((row) =>
    row.source.startsWith("github:workflow:"),
  ).length;

  if (commits.length === 0 && observations.length === 0) {
    return {
      status: "skipped_no_activity",
      overviewPath,
      journalPath,
      absoluteJournalPath,
      commitCount: 0,
      prEvents: 0,
      workflowEvents: 0,
    };
  }

  if (!existsSync(join(deps.contextDir, overviewPath))) {
    runRepositoryManagementInit(deps);
  }

  const statSummary = gitStatSummary(localPath, [
    "log",
    "--stat",
    `--since=${since.toISOString()}`,
    `--max-count=${LOG_LIMIT}`,
  ]);
  const journal = renderJournal({
    repo: deps.repo,
    date,
    commits,
    observations,
    prEvents,
    workflowEvents,
    statSummary,
  });
  writeManagedContextFile(deps, journalPath, journal, "repository_management_scan");
  await appendOverviewDailyLog(deps, {
    date,
    overviewPath,
    commitCount: commits.length,
    prEvents,
    workflowEvents,
  });

  return {
    status: "written",
    overviewPath,
    journalPath,
    absoluteJournalPath,
    commitCount: commits.length,
    prEvents,
    workflowEvents,
  };
}

function requireLocalPath(repo: RepositoryDTO): string {
  if (!repo.localPath) {
    throw new Error("repository management requires a local clone");
  }
  assertGitWorkTree(repo.localPath);
  return repo.localPath;
}

function assertGitWorkTree(localPath: string): void {
  const value = git(localPath, ["rev-parse", "--is-inside-work-tree"]).trim();
  if (value !== "true") {
    throw new Error(`repository management requires a git worktree: ${localPath}`);
  }
}

function collectGitEvidence(localPath: string): GitEvidence {
  return {
    currentBranch: git(localPath, ["branch", "--show-current"]).trim() || "unknown",
    remoteUrl: nullableGit(localPath, ["remote", "get-url", "origin"]),
    firstCommitDate: nullableGit(localPath, ["log", "--reverse", "--format=%cs", "-1"]),
    lastCommitDate: nullableGit(localPath, ["log", "-1", "--format=%cs"]),
    recentCommits: gitLog(localPath, [`--max-count=${LOG_LIMIT}`]),
    readmeFileName: findReadmeFileName(localPath),
  };
}

/**
 * Locate the repo's README file in the worktree root. Prefers the
 * dominant convention (`.md` extension) over alternative formats so a
 * directory containing both `README.md` and `README.txt` always selects
 * the markdown one regardless of `readdirSync` ordering. Returns the
 * file *name* (relative to `localPath`), not the absolute path.
 */
function findReadmeFileName(localPath: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(localPath);
  } catch {
    return null;
  }
  const candidates = entries.filter((name) => /^readme(\.|$)/i.test(name));
  if (candidates.length === 0) return null;
  const score = (name: string): number => {
    const lower = name.toLowerCase();
    if (lower === "readme.md") return 0;
    if (lower.endsWith(".md")) return 1;
    if (lower.endsWith(".markdown")) return 2;
    if (lower === "readme") return 3;
    if (lower.endsWith(".rst")) return 4;
    if (lower.endsWith(".txt")) return 5;
    return 6;
  };
  candidates.sort((a, b) => score(a) - score(b) || a.localeCompare(b));
  for (const candidate of candidates) {
    const fullPath = join(localPath, candidate);
    try {
      if (statSync(fullPath).isFile()) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Mirror the repository's `README.*` verbatim to
 * `<contextDir>/git/<slug>/README.md`. Mechanical copy — no truncation,
 * no processing — but routed through `writeManagedContextFile` so the
 * write picks up the same chokepoint guarantees as every other managed
 * write in this module:
 *
 *   - Atomic write (no partial-state visible to readers).
 *   - Snapshot of the previous body into `md_file_snapshots` so an
 *     accidental upstream README rewrite is recoverable from history.
 *   - `AgentWriteTracker.markWriting` fires **before** the rename so
 *     observer-fired indexers tag the resulting fs event `actor='agent'`
 *     instead of mis-attributing it to the user. On write failure the
 *     mark is rolled back via `unmark()` so a stale mark cannot suppress
 *     a legitimate later user edit (C2).
 *
 * Returns the relative context-file path it wrote, or `null` if no
 * README was found in the repo root or the source could not be read.
 * Errors during the read are logged at warn — the init endpoint should
 * not blow up just because a README is unreadable.
 */
function copyRepositoryReadme(
  deps: RepositoryManagementDocDeps,
  localPath: string,
): string | null {
  const fileName = findReadmeFileName(localPath);
  if (!fileName) return null;
  const src = join(localPath, fileName);
  const relPath = `knowledge/repos/${deps.repo.slug}/README.md`;
  let body: string;
  try {
    body = readFileSync(src, "utf-8");
  } catch (err) {
    logger.warn(
      { err, repositoryId: deps.repo.id, src },
      "Failed to read repository README — skipping mirror copy",
    );
    return null;
  }
  writeManagedContextFile(deps, relPath, body, "repository_management_readme_copy");
  return relPath;
}

function gitLog(localPath: string, extraArgs: string[]): GitCommit[] {
  const recordSep = "\x1e";
  const fieldSep = "\x1f";
  let stdout: string;
  try {
    stdout = git(localPath, [
      "log",
      `--format=%H${fieldSep}%h${fieldSep}%cs${fieldSep}%an${fieldSep}%s${recordSep}`,
      ...extraArgs,
    ], MAX_TEXT_BYTES);
  } catch (err) {
    if (isEmptyGitHistoryError(err)) return [];
    throw err;
  }
  return stdout
    .split(recordSep)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash = "", short = "", date = "", author = "", ...subjectParts] =
        record.split(fieldSep);
      return {
        hash,
        short,
        date,
        author,
        subject: subjectParts.join(fieldSep).trim(),
      };
    });
}

function isEmptyGitHistoryError(err: unknown): boolean {
  const stderr = String((err as { stderr?: unknown } | null)?.stderr ?? "");
  const message = err instanceof Error ? err.message : String(err);
  const text = `${stderr}\n${message}`;
  return text.includes("does not have any commits yet") ||
    text.includes("bad default revision 'HEAD'");
}

function gitStatSummary(localPath: string, args: string[]): string {
  try {
    return git(localPath, args, MAX_STAT_BYTES);
  } catch (err) {
    if (isEmptyGitHistoryError(err)) return "";
    throw err;
  }
}

function git(localPath: string, args: string[], maxBuffer = MAX_TEXT_BYTES): string {
  return execFileSync("git", args, {
    cwd: localPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
    maxBuffer,
  });
}

function nullableGit(localPath: string, args: string[]): string | null {
  try {
    const value = git(localPath, args).trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function recentRepositoryObservations(
  db: Database.Database,
  repo: RepositoryDTO,
  since: Date,
): ObservationSummary[] {
  const sources = [`git:${repo.localPath}`];
  if (repo.githubOwner && repo.githubRepo) {
    const slug = `${repo.githubOwner}/${repo.githubRepo}`;
    sources.push(`github:notification:${slug}`, `github:workflow:${slug}`);
  }
  const placeholders = sources.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT source, ref, change_type, observed_at, payload, summary_text
         FROM observations
        WHERE observed_at >= ?
          AND source IN (${placeholders})
        ORDER BY observed_at ASC`,
    )
    .all(formatSqliteDatetime(since), ...sources) as Array<{
      source: string;
      ref: string;
      change_type: string;
      observed_at: string;
      payload: string | null;
      summary_text: string | null;
    }>;
  return rows.map((row) => ({
    source: row.source,
    ref: row.ref,
    changeType: row.change_type,
    observedAt: row.observed_at,
    summary: row.summary_text ?? payloadSummary(row.payload),
  }));
}

function payloadSummary(payload: string | null): string | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const title = parsed.title ?? parsed.subject ?? parsed.name ?? parsed.workflow;
    return typeof title === "string" && title.trim().length > 0
      ? title.trim()
      : null;
  } catch {
    return null;
  }
}

function renderOverview(params: {
  repo: RepositoryDTO;
  evidence: GitEvidence;
  date: string;
}): string {
  const { repo, evidence, date } = params;
  const displayName = repo.displayName ?? repo.githubRepo ?? basename(repo.localPath ?? repo.slug);
  const commits = evidence.recentCommits.slice(0, 30);
  const lifecycleSection = repo.classification === "project"
    ? "\n## Lifecycle Phases\n\n- Initial documentation created from Git history.\n"
    : "";
  const readmeNote = evidence.readmeFileName
    ? `- Source README: see [README.md](./README.md) (mirrored on init).`
    : "- README not found in the repository root.";
  return [
    "---",
    "type: git-project",
    "owner: agent",
    `repository_id: ${yamlValue(repo.id)}`,
    `slug: ${yamlValue(repo.slug)}`,
    `github_repo: ${yamlValue(repo.githubOwner && repo.githubRepo ? `${repo.githubOwner}/${repo.githubRepo}` : null)}`,
    `local_path: ${yamlValue(repo.localPath)}`,
    `classification: ${yamlValue(repo.classification)}`,
    `category: ${yamlValue(repo.category)}`,
    `created: ${date}`,
    `updated: ${date}`,
    "architecture_status: pending",
    "architecture_refreshed_at: null",
    "---",
    `# ${displayName}`,
    "",
    "## Summary",
    "",
    `- Repository: ${repo.githubOwner && repo.githubRepo ? `${repo.githubOwner}/${repo.githubRepo}` : repo.localPath}`,
    `- Default/current branch: ${evidence.currentBranch}`,
    `- Remote: ${evidence.remoteUrl ?? "none recorded"}`,
    `- First commit: ${evidence.firstCommitDate ?? "unknown"}`,
    `- Last commit: ${evidence.lastCommitDate ?? "unknown"}`,
    readmeNote,
    "",
    "## Architecture",
    "",
    ARCHITECTURE_BEGIN_MARKER,
    "",
    ARCHITECTURE_PLACEHOLDER,
    "",
    ARCHITECTURE_END_MARKER,
    "",
    "## Notable Changes",
    "",
    commits.length > 0
      ? commits.map((commit) => `- ${commit.date} ${commit.short}: ${commit.subject}`).join("\n")
      : "- No commits found in the sampled history.",
    lifecycleSection.trimEnd(),
    "## Open Threads",
    "",
    "- Add follow-ups that should remain visible across sessions.",
    "",
    "## Daily Activity Log",
    "",
    "- Initial documentation created from Git history.",
    "",
  ].filter((part) => part !== "").join("\n") + "\n";
}

function renderJournal(params: {
  repo: RepositoryDTO;
  date: string;
  commits: GitCommit[];
  observations: ObservationSummary[];
  prEvents: number;
  workflowEvents: number;
  statSummary: string;
}): string {
  const { repo, date, commits, observations, prEvents, workflowEvents, statSummary } = params;
  return [
    "---",
    "type: git-journal",
    "owner: agent",
    `repository_id: ${yamlValue(repo.id)}`,
    `date: ${date}`,
    `updated: ${date}`,
    `commit_count: ${commits.length}`,
    `pr_events: ${prEvents}`,
    `workflow_events: ${workflowEvents}`,
    "---",
    `# ${date} - ${repo.slug}`,
    "",
    "## Commits",
    "",
    commits.length > 0
      ? commits.map((commit) => `- ${commit.date} ${commit.short}: ${commit.subject} (${commit.author})`).join("\n")
      : "- No commits in the lookback window.",
    "",
    "## PR / Workflow Events",
    "",
    observations.length > 0
      ? observations.map((row) =>
          `- ${row.observedAt} ${row.source} ${row.changeType} ${row.ref}${row.summary ? ` - ${row.summary}` : ""}`,
        ).join("\n")
      : "- No PR or workflow observations in the lookback window.",
    "",
    "## Files Changed",
    "",
    statSummary.trim().length > 0 ? fenced(statSummary.trim().slice(0, MAX_STAT_BYTES)) : "- No file-change stat available.",
    "",
  ].join("\n") + "\n";
}

async function appendOverviewDailyLog(
  deps: RepositoryManagementDocDeps,
  params: {
    date: string;
    overviewPath: string;
    commitCount: number;
    prEvents: number;
    workflowEvents: number;
  },
): Promise<void> {
  const absolutePath = join(deps.contextDir, params.overviewPath);
  // Serialize against `runRepositoryArchitectureSectionReplace` on the
  // same overview file. Both follow read-modify-write, both use atomic
  // rename on commit; without a shared lock the second writer can clobber
  // the first by replaying a stale read. See `overview-write-lock.ts`.
  await withOverviewWriteLock(absolutePath, () => {
    if (!existsSync(absolutePath)) return;
    const current = readFileSync(absolutePath, "utf-8");
    // Normalize CRLF→LF for the split/filter/join + marker work, then
    // restore the original line ending at the single final emit. Mirrors
    // `mergeArchitectureSection`, which writes the same overview file and
    // already treats it as possibly CRLF — without this, a CRLF overview
    // would collapse to LF here and show a dirty git diff on Windows.
    const wasCrlf = /\r\n/.test(current);
    const normalized = wasCrlf ? current.replace(/\r\n/g, "\n") : current;
    const summary =
      `- ${params.date}: ${params.commitCount} commits; ${params.prEvents} PR/notification events; ${params.workflowEvents} workflow events.`;
    const withoutOldSameDay = normalized
      .split("\n")
      .filter((line) => keepDailyLogLine(line, params.date))
      .join("\n");
    const withUpdated = replaceUpdatedDate(withoutOldSameDay, params.date);
    const marker = "## Daily Activity Log";
    const next = withUpdated.includes(marker)
      ? withUpdated.replace(marker, `${marker}\n\n${summary}`)
      : `${withUpdated.trimEnd()}\n\n${marker}\n\n${summary}\n`;
    const out = wasCrlf ? next.replace(/\n/g, "\r\n") : next;
    writeManagedContextFile(deps, params.overviewPath, out, "repository_management_scan_overview");
  });
}

function keepDailyLogLine(line: string, today: string): boolean {
  const match = /^- (\d{4}-\d{2}-\d{2}): /.exec(line);
  if (!match) return true;
  if (match[1] === today) return false;
  const lineMs = Date.parse(`${match[1]}T00:00:00Z`);
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(lineMs) || !Number.isFinite(todayMs)) return true;
  return lineMs >= todayMs - 30 * 24 * 60 * 60 * 1000;
}

function writeManagedContextFile(
  deps: RepositoryManagementDocDeps,
  relativePath: string,
  content: string,
  trigger: string,
): void {
  const absolutePath = join(deps.contextDir, relativePath);
  const previous = existsSync(absolutePath) ? readFileSync(absolutePath, "utf-8") : null;
  if (previous !== null) {
    deps.db
      .prepare(
        "INSERT INTO md_file_snapshots (file_path, content, trigger, session_id) VALUES (?, ?, ?, ?)",
      )
      .run(relativePath, previous, trigger, null);
  }
  // Mark before the rename so FS-watch consumers attribute the resulting
  // event to the agent. Roll back on failure (C2).
  deps.writeTracker?.markWriting(absolutePath, content);
  try {
    writeFileAtomically(absolutePath, content);
  } catch (writeErr) {
    deps.writeTracker?.unmark(absolutePath);
    throw writeErr;
  }
  deps.onIndexableContextChange?.(relativePath);
}

function replaceUpdatedDate(content: string, date: string): string {
  if (/^updated:\s*.*$/m.test(content)) {
    return content.replace(/^updated:\s*.*$/m, `updated: ${date}`);
  }
  if (content.startsWith("---\n")) {
    return content.replace(/^---\n/, `---\nupdated: ${date}\n`);
  }
  return content;
}

function yamlValue(value: string | null): string {
  return value === null ? "null" : JSON.stringify(value);
}

function fenced(value: string): string {
  return "```text\n" + value + "\n```";
}

function dateStamp(date: Date, timezone?: string): string {
  return localDateStr(date, timezone);
}

/**
 * Replace the marker-bracketed `## Architecture` block in
 * `git/<slug>/overview.md` with `markdown`. Other sections (Summary,
 * Notable Changes, Daily Activity Log) and the YAML frontmatter are
 * preserved; the agent only ever submits the body of the Architecture
 * block via `PUT /api/repositories/:id/architecture-section`, the
 * daemon owns the surgical merge.
 *
 * Updates `architecture_status: complete`, `architecture_refreshed_at`,
 * and `updated:` frontmatter fields. If the overview file is missing
 * (e.g. management init has not run yet), returns `no_overview`
 * without writing.
 */
export async function runRepositoryArchitectureSectionReplace(
  deps: RepositoryManagementDocDeps,
  markdown: string,
): Promise<ArchitectureSectionReplaceResult> {
  const overviewPath = gitRepoOverviewPath(deps.repo.slug);
  const absolutePath = join(deps.contextDir, overviewPath);
  const now = deps.now ?? new Date();
  const refreshedAt = now.toISOString();

  // Serialize against `appendOverviewDailyLog` (the scan flow's daily
  // log append) on the same overview file. See `overview-write-lock.ts`
  // for the race this prevents.
  return withOverviewWriteLock(absolutePath, () => {
    if (!existsSync(absolutePath)) {
      return { status: "no_overview", overviewPath, absolutePath, refreshedAt };
    }
    const current = readFileSync(absolutePath, "utf-8");
    const merged = mergeArchitectureSection(current, markdown);
    const withFrontmatter = updateArchitectureFrontmatter(merged, {
      refreshedAt,
      date: dateStamp(now, deps.timezone),
    });
    writeManagedContextFile(
      deps,
      overviewPath,
      withFrontmatter,
      "repository_management_refresh_architecture",
    );
    return { status: "written", overviewPath, absolutePath, refreshedAt };
  });
}

/**
 * Replace the marker-bracketed Architecture block in an overview file with
 * a freshly composed body. Exported solely so the unit suite can pin edge
 * cases (code-fence collisions, CRLF, orphan markers) without having to
 * stand up a full SQLite + filesystem fixture for every shape.
 *
 * Contract:
 *   - Marker matches inside fenced code blocks (``` or ~~~) are ignored —
 *     the daemon's own README, an Architecture body that includes example
 *     fences, or a paste from a chat could otherwise mis-anchor the merge
 *     and overwrite Summary / Notable Changes / Daily Activity Log.
 *   - CRLF input is preserved (LF input stays LF).
 *   - Orphan markers (only `:start` or only `:end` present) are stripped
 *     and a clean block is re-injected under `## Architecture` — never
 *     left to drift in the file where the next refresh might mis-bind to
 *     them.
 *   - `## Architecture` / `## Notable Changes` headings are matched with
 *     a line-anchored regex that tolerates trailing whitespace and either
 *     line ending. The previous literal-`indexOf` match silently fell
 *     through on `## Architecture \n` (trailing space) or `## Architecture\r\n`.
 *   - Final fallback is append-before-Notable-Changes-or-EOF, identical
 *     to the original contract.
 */
export function mergeArchitectureSection(current: string, markdown: string): string {
  // Normalize line endings for internal processing; remember the original
  // shape so we can hand it back unchanged. Treating CRLF and LF the
  // same throughout simplifies every offset calculation below.
  const wasCrlf = /\r\n/.test(current);
  const normalized = wasCrlf ? current.replace(/\r\n/g, "\n") : current;

  const merged = mergeArchitectureSectionLf(normalized, markdown);
  return wasCrlf ? merged.replace(/\n/g, "\r\n") : merged;
}

function mergeArchitectureSectionLf(content: string, markdown: string): string {
  const body = markdown.trim();
  const block = `${ARCHITECTURE_BEGIN_MARKER}\n\n${body}\n\n${ARCHITECTURE_END_MARKER}`;
  const fences = computeFenceRanges(content);

  const beginIdx = indexOfOutsideFences(content, ARCHITECTURE_BEGIN_MARKER, fences);
  const endIdx = indexOfOutsideFences(content, ARCHITECTURE_END_MARKER, fences);

  // Happy path — both markers present and in the right order, outside
  // any fence. Replace between them.
  if (beginIdx >= 0 && endIdx > beginIdx) {
    return (
      content.slice(0, beginIdx)
      + block
      + content.slice(endIdx + ARCHITECTURE_END_MARKER.length)
    );
  }

  // Orphan-marker repair. An end marker without a begin (or vice versa)
  // is left over from a partial edit or an earlier bug. Strip the orphan
  // line entirely so the re-injection below can plant a clean block
  // without two `:end` markers staring at each other on the next refresh.
  let cleaned = content;
  if (beginIdx >= 0 && endIdx < 0) {
    cleaned = stripLineContaining(cleaned, ARCHITECTURE_BEGIN_MARKER, fences);
  } else if (endIdx >= 0 && beginIdx < 0) {
    cleaned = stripLineContaining(cleaned, ARCHITECTURE_END_MARKER, fences);
  } else if (beginIdx >= 0 && endIdx >= 0 && endIdx <= beginIdx) {
    // Markers are out of order (end before begin) — treat both as orphans.
    cleaned = stripLineContaining(cleaned, ARCHITECTURE_BEGIN_MARKER, fences);
    cleaned = stripLineContaining(cleaned, ARCHITECTURE_END_MARKER, computeFenceRanges(cleaned));
  }

  // Re-inject under `## Architecture` if the heading still exists outside
  // a fence, otherwise plant a fresh section before `## Notable Changes`
  // or at EOF.
  return injectArchitectureBlock(cleaned, block);
}

function injectArchitectureBlock(content: string, block: string): string {
  const fences = computeFenceRanges(content);
  const architectureHeading = findHeadingLine(content, "Architecture", fences);
  if (architectureHeading) {
    const afterHeading = architectureHeading.lineEndOffset; // offset of '\n' just after heading
    const tail = content.slice(afterHeading + 1); // skip the newline
    const fencesTail = shiftFenceRanges(fences, -(afterHeading + 1));
    const nextSectionRel = findNextSectionOffsetOutsideFences(tail, fencesTail);
    const sliceEnd =
      nextSectionRel >= 0
        ? afterHeading + 1 + nextSectionRel
        : content.length;
    return (
      content.slice(0, afterHeading + 1)
      + `\n${block}\n\n`
      + content.slice(sliceEnd)
    );
  }
  const notableHeading = findHeadingLine(content, "Notable Changes", fences);
  const newSection = `\n## Architecture\n\n${block}\n`;
  if (notableHeading) {
    return (
      content.slice(0, notableHeading.lineStartOffset)
      + newSection
      + "\n"
      + content.slice(notableHeading.lineStartOffset)
    );
  }
  return content.trimEnd() + "\n" + newSection;
}

/**
 * Compute byte ranges (inclusive of opening fence line through closing
 * fence line) that are part of fenced code blocks. Matching inside one
 * of these ranges is ignored. The fence delimiters themselves are also
 * considered fenced so an ``` ```text\n<!-- architecture:start --> ``` ``` example doesn't slip through on the
 * opening line's info-string position.
 *
 * An unclosed fence at EOF is treated as fenced through EOF — the
 * conservative choice (we'd rather refuse to touch ambiguous content
 * than risk corrupting it). For a well-formed daemon-generated overview
 * file this branch is unreachable.
 */
function computeFenceRanges(content: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let inFence = false;
  let fenceStart = 0;
  let fenceMarker: "```" | "~~~" = "```";
  let offset = 0;
  const lines = content.split("\n");
  for (const text of lines) {
    const trimmed = text.replace(/^\s*/, "");
    const opensTriple = /^```/.test(trimmed);
    const opensTilde = /^~~~/.test(trimmed);
    if (!inFence && (opensTriple || opensTilde)) {
      inFence = true;
      fenceStart = offset;
      fenceMarker = opensTriple ? "```" : "~~~";
    } else if (
      inFence
      && ((fenceMarker === "```" && opensTriple)
        || (fenceMarker === "~~~" && opensTilde))
    ) {
      ranges.push([fenceStart, offset + text.length]);
      inFence = false;
    }
    offset += text.length + 1; // +1 for \n
  }
  if (inFence) {
    ranges.push([fenceStart, content.length]);
  }
  return ranges;
}

function shiftFenceRanges(
  ranges: Array<[number, number]>,
  delta: number,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [s, e] of ranges) {
    const ns = s + delta;
    const ne = e + delta;
    if (ne <= 0) continue;
    out.push([Math.max(0, ns), ne]);
  }
  return out;
}

function isInsideFence(
  offset: number,
  ranges: Array<[number, number]>,
): boolean {
  for (const [s, e] of ranges) {
    if (offset >= s && offset < e) return true;
  }
  return false;
}

function indexOfOutsideFences(
  content: string,
  needle: string,
  ranges: Array<[number, number]>,
): number {
  let from = 0;
  while (from <= content.length) {
    const idx = content.indexOf(needle, from);
    if (idx < 0) return -1;
    if (!isInsideFence(idx, ranges)) return idx;
    from = idx + 1;
  }
  return -1;
}

interface HeadingLine {
  readonly lineStartOffset: number;
  readonly lineEndOffset: number;
}

function findHeadingLine(
  content: string,
  headingText: string,
  ranges: Array<[number, number]>,
): HeadingLine | null {
  // Match a line that IS `## <heading>` with optional trailing whitespace.
  // `^` is enforced by tracking the start-of-line offset; trailing `\s*`
  // accommodates the `## Architecture ` (trailing space) form that the
  // previous literal `\n## Architecture\n` indexOf silently dropped.
  const pattern = new RegExp(
    `^[ \\t]*##[ \\t]+${escapeRegex(headingText)}[ \\t]*$`,
  );
  let offset = 0;
  for (const text of content.split("\n")) {
    if (!isInsideFence(offset, ranges) && pattern.test(text)) {
      return { lineStartOffset: offset, lineEndOffset: offset + text.length };
    }
    offset += text.length + 1;
  }
  return null;
}

function findNextSectionOffsetOutsideFences(
  s: string,
  ranges: Array<[number, number]>,
): number {
  // Find the line-start offset of the next top-level `## ` heading. Same
  // line-aware walk as `findHeadingLine` but unconstrained on the heading
  // text. Matches at offset 0 too — the caller slices the tail starting
  // *after* the Architecture heading's newline, so a `## Foo` at offset
  // 0 is genuinely "the very next section" (pathological back-to-back
  // headings collapse to a clean replace).
  let offset = 0;
  for (const text of s.split("\n")) {
    if (!isInsideFence(offset, ranges) && /^[ \t]*##[ \t]+/.test(text)) {
      return offset;
    }
    offset += text.length + 1;
  }
  return -1;
}

function stripLineContaining(
  content: string,
  needle: string,
  ranges: Array<[number, number]>,
): string {
  // Remove the entire line that contains `needle` (outside fences), plus
  // any single trailing blank line so we don't accumulate ghost blank
  // lines on repeated orphan repairs.
  const out: string[] = [];
  let offset = 0;
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    const skipThis = !isInsideFence(offset, ranges) && text.includes(needle);
    if (!skipThis) {
      out.push(text);
    } else if (
      i + 1 < lines.length
      && lines[i + 1].trim() === ""
      && out.length > 0
      && out[out.length - 1].trim() === ""
    ) {
      // Drop the trailing blank too to avoid `\n\n\n` accumulation.
      i++;
    }
    offset += text.length + 1;
  }
  return out.join("\n");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function updateArchitectureFrontmatter(
  content: string,
  params: { refreshedAt: string; date: string },
): string {
  const setField = (text: string, key: string, value: string): string => {
    const re = new RegExp(`^${key}:\\s*.*$`, "m");
    if (re.test(text)) {
      return text.replace(re, `${key}: ${value}`);
    }
    if (text.startsWith("---\n")) {
      const closeIdx = text.indexOf("\n---\n", 4);
      if (closeIdx > 0) {
        return (
          text.slice(0, closeIdx)
          + `\n${key}: ${value}`
          + text.slice(closeIdx)
        );
      }
    }
    return text;
  };

  let next = setField(content, "architecture_status", "complete");
  next = setField(next, "architecture_refreshed_at", JSON.stringify(params.refreshedAt));
  next = setField(next, "updated", params.date);
  return next;
}

/**
 * Re-copy the repository's README.* into `git/<slug>/README.md`,
 * snapshotting the previous mirror to `md_file_snapshots`. Used by both
 * the management-init flow (initial mirror) and the architecture-refresh
 * flow (keep mirror in sync with the source the agent just analyzed).
 *
 * Returns the relative context-file path on success or `null` if no
 * README was found.
 */
export function copyRepositoryReadmeForRefresh(
  deps: RepositoryManagementDocDeps,
): string | null {
  const localPath = requireLocalPath(deps.repo);
  return copyRepositoryReadme(deps, localPath);
}

/** Validate that a body submitted to PUT /architecture-section is well-formed. */
export function validateArchitectureMarkdown(
  markdown: unknown,
): { ok: true; body: string } | { ok: false; error: string; message: string } {
  if (typeof markdown !== "string") {
    return {
      ok: false,
      error: "validation_error",
      message: "markdown (string) required",
    };
  }
  const trimmed = markdown.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      error: "validation_error",
      message: "markdown must be non-empty",
    };
  }
  if (Buffer.byteLength(trimmed, "utf-8") > ARCHITECTURE_SECTION_MAX_BYTES) {
    return {
      ok: false,
      error: "payload_too_large",
      message: `markdown exceeds ${ARCHITECTURE_SECTION_MAX_BYTES} bytes`,
    };
  }
  if (
    trimmed.includes(ARCHITECTURE_BEGIN_MARKER)
    || trimmed.includes(ARCHITECTURE_END_MARKER)
  ) {
    return {
      ok: false,
      error: "validation_error",
      message:
        "markdown must not include architecture begin/end markers — submit body content only",
    };
  }
  return { ok: true, body: trimmed };
}

export const ARCHITECTURE_MARKERS = {
  begin: ARCHITECTURE_BEGIN_MARKER,
  end: ARCHITECTURE_END_MARKER,
  placeholder: ARCHITECTURE_PLACEHOLDER,
} as const;
