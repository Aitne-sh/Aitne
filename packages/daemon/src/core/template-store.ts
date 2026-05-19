import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { formatSqliteDatetime } from "@aitne/shared";
import {
  readRuntimeState,
  writeRuntimeState,
} from "../db/runtime-state.js";
import { writeFileAtomically } from "./atomic-write.js";
import { createLogger } from "../logging.js";
import {
  type GitRepoClassification,
  type NormalizedGitWatchedRepo,
  readGitProjectDocTemplate,
  repoDocContextFilePath,
  repoDocContextPath,
} from "./git-project-docs.js";

const logger = createLogger("template-store");

/**
 * Phase 6 (git-lifecycle-and-triggers.md Decision 8) — owner-driven
 * "Apply current template to existing projects" flow.
 *
 * Three responsibilities:
 *
 *   1. Read/write the on-disk template files in `<dataDir>/templates/`
 *      (`project.md`, `git-repo.md`). The dashboard's Templates editor
 *      calls these on every save; downstream `git.project.init` /
 *      `git.project.update` sessions already pick the new body up via
 *      `readGitProjectDocTemplate` because that helper reads from disk
 *      on every call (forward-only behavior — see Decision 8 §1).
 *
 *   2. Prepare a re-template run: enumerate target files for the given
 *      template kind, atomically back them all up under
 *      `<dataDir>/backups/templates/<safeIso>/`, persist a status grid
 *      row in `runtime_state`, and enqueue exactly one
 *      `agent_schedule.task_type='git.project.retemplate'` row. This is
 *      the only place that creates retemplate runs, and it is guarded
 *      against concurrent invocations with a 409-style return.
 *
 *   3. Finalize a re-template run: when the dispatcher hands control back
 *      after a `git.project.retemplate` session finishes (success OR
 *      error), restore any file the agent marked `started` but never
 *      reported terminal status for, by copying its backup back over the
 *      live path. The agent itself cannot reliably roll back its own
 *      in-flight write — process exits, exceeded turn budgets, and
 *      backend faults all leave the file half-written. Owning rollback
 *      from the daemon side closes that gap.
 *
 * Per-file audit rows (action_type='git.project.retemplate') are written
 * by the route at the moment the agent reports each per-file status, not
 * here — keeping side effects close to their HTTP boundary makes the
 * telemetry trivially testable from the route surface.
 */

export const PROJECT_TEMPLATE_NAME = "project.md";
export const GIT_REPO_TEMPLATE_NAME = "git-repo.md";
export const RETEMPLATE_STATUS_KEY = "git.project.retemplate.status";

export type TemplateKind = "project" | "git-repo";

export type RetemplateFileStatus =
  | "pending"
  | "started"
  | "completed"
  | "skipped"
  | "failed"
  | "rolled_back";

export type RetemplateRunStatus =
  | "running"
  | "success"
  | "partial"
  | "failed";

export interface RetemplateTarget {
  slug: string;
  /** Relative context path without the trailing `.md` (e.g. `projects/aitne`). */
  contextPath: string;
  /** Relative context file with `.md` (e.g. `projects/aitne.md`). */
  contextFile: string;
  /** Path inside `backupRoot` mirroring the contextDir layout. */
  backupRelPath: string;
  classification: GitRepoClassification;
  category: string;
  org: string;
  accountAlias: string;
  repoPath: string;
}

export interface RetemplateFileEntry extends RetemplateTarget {
  status: RetemplateFileStatus;
  reason?: string;
  error?: string;
  beforeBytes?: number;
  afterBytes?: number;
  startedAt?: string;
  completedAt?: string;
}

export interface RetemplateStatusRecord {
  scheduleId: number;
  correlationId: string;
  kind: TemplateKind;
  backupRoot: string;
  startedAt: string;
  finalizedAt?: string;
  finalStatus?: RetemplateRunStatus;
  files: Record<string, RetemplateFileEntry>;
}

export interface PrepareRetemplateOptions {
  db: Database.Database;
  dataDir: string;
  workspaceDir: string;
  contextDir: string;
  kind: TemplateKind;
  repos: NormalizedGitWatchedRepo[];
  now?: () => Date;
}

export type PrepareRetemplateResult =
  | {
      ok: true;
      scheduleId: number;
      correlationId: string;
      backupRoot: string;
      kind: TemplateKind;
      targets: RetemplateTarget[];
      record: RetemplateStatusRecord;
    }
  | {
      ok: false;
      reason: "in_progress";
      detail: { scheduleId: number; correlationId: string | undefined };
    }
  | { ok: false; reason: "no_targets" | "missing_template" };

/* ────────────────────────────────────────────────────────────────────── */
/* Template file accessors                                                */
/* ────────────────────────────────────────────────────────────────────── */

export function templatesDir(dataDir: string): string {
  return resolve(dataDir, "templates");
}

export function templateFileName(kind: TemplateKind): string {
  return kind === "project" ? PROJECT_TEMPLATE_NAME : GIT_REPO_TEMPLATE_NAME;
}

export function templateFilePath(dataDir: string, kind: TemplateKind): string {
  return join(templatesDir(dataDir), templateFileName(kind));
}

export function readTemplateBody(
  dataDir: string,
  workspaceDir: string,
  kind: TemplateKind,
): string {
  return readGitProjectDocTemplate(dataDir, workspaceDir, classifyTemplateKind(kind));
}

const TEMPLATE_BODY_MAX_BYTES = 64 * 1024;

export function writeTemplateBody(
  dataDir: string,
  kind: TemplateKind,
  content: string,
): { bytes: number } {
  const bytes = Buffer.byteLength(content, "utf-8");
  if (bytes > TEMPLATE_BODY_MAX_BYTES) {
    throw Object.assign(new Error("template_body_too_large"), {
      code: "ETEMPLATE_BODY_TOO_LARGE",
      maxBytes: TEMPLATE_BODY_MAX_BYTES,
      actualBytes: bytes,
    });
  }
  const dir = templatesDir(dataDir);
  mkdirSync(dir, { recursive: true });
  writeFileAtomically(templateFilePath(dataDir, kind), content);
  return { bytes };
}

function classifyTemplateKind(kind: TemplateKind): GitRepoClassification {
  return kind === "project" ? "project" : "repo-only";
}

/* ────────────────────────────────────────────────────────────────────── */
/* Pure helpers — target enumeration + status-grid math (100% covered)   */
/* ────────────────────────────────────────────────────────────────────── */

export function selectRetemplateTargets(
  repos: NormalizedGitWatchedRepo[],
  kind: TemplateKind,
  contextDir: string,
): RetemplateTarget[] {
  const targets: RetemplateTarget[] = [];
  const wantClassification: GitRepoClassification = classifyTemplateKind(kind);
  const seenSlugs = new Set<string>();
  for (const repo of repos) {
    if (repo.classification !== wantClassification) continue;
    if (seenSlugs.has(repo.slug)) continue;
    const contextFile = repoDocContextFilePath(repo);
    const absPath = join(contextDir, contextFile);
    if (!existsSync(absPath)) continue;
    targets.push({
      slug: repo.slug,
      contextPath: repoDocContextPath(repo),
      contextFile,
      backupRelPath: contextFile,
      classification: repo.classification,
      category: repo.category,
      org: repo.org ?? "",
      accountAlias: repo.accountAlias ?? "",
      repoPath: repo.path,
    });
    seenSlugs.add(repo.slug);
  }
  return targets;
}

/**
 * ISO-8601 with the colon-and-dot characters reshuffled so the result is
 * a safe directory segment on every supported FS. We target macOS today
 * but the agent's data dir may live on a synced share with stricter
 * rules — pre-empt the issue.
 */
export function backupTimestampSegment(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

export function buildBackupRoot(dataDir: string, now: Date): string {
  return join(
    dataDir,
    "backups",
    "templates",
    backupTimestampSegment(now),
  );
}

export function isTerminalFileStatus(status: RetemplateFileStatus): boolean {
  return (
    status === "completed"
    || status === "skipped"
    || status === "failed"
    || status === "rolled_back"
  );
}

export function summarizeFinalStatus(
  files: Record<string, RetemplateFileEntry>,
): RetemplateRunStatus {
  const values = Object.values(files);
  if (values.length === 0) return "success";
  const anyFailed = values.some(
    (f) => f.status === "failed" || f.status === "rolled_back",
  );
  const anyOk = values.some(
    (f) => f.status === "completed" || f.status === "skipped",
  );
  if (anyFailed && anyOk) return "partial";
  if (anyFailed) return "failed";
  return "success";
}

/* ────────────────────────────────────────────────────────────────────── */
/* Status grid persistence                                                */
/* ────────────────────────────────────────────────────────────────────── */

export function readRetemplateStatus(
  db: Database.Database,
): RetemplateStatusRecord | null {
  return readRuntimeState<RetemplateStatusRecord>(db, RETEMPLATE_STATUS_KEY);
}

export function writeRetemplateStatus(
  db: Database.Database,
  record: RetemplateStatusRecord,
): void {
  writeRuntimeState(db, RETEMPLATE_STATUS_KEY, record);
}

export interface RecordPerFileOptions {
  slug: string;
  status: RetemplateFileStatus;
  reason?: string;
  error?: string;
  beforeBytes?: number;
  afterBytes?: number;
  now?: () => Date;
}

export function applyPerFileUpdate(
  record: RetemplateStatusRecord,
  options: RecordPerFileOptions,
): RetemplateStatusRecord | null {
  const existing = record.files[options.slug];
  if (!existing) return null;
  const nowIso = (options.now?.() ?? new Date()).toISOString();
  const next: RetemplateFileEntry = {
    ...existing,
    status: options.status,
    ...(options.reason !== undefined ? { reason: options.reason } : {}),
    ...(options.error !== undefined ? { error: options.error } : {}),
    ...(options.beforeBytes !== undefined
      ? { beforeBytes: options.beforeBytes }
      : {}),
    ...(options.afterBytes !== undefined
      ? { afterBytes: options.afterBytes }
      : {}),
    ...(options.status === "started"
      ? { startedAt: nowIso }
      : isTerminalFileStatus(options.status)
        ? { completedAt: nowIso }
        : {}),
  };
  return {
    ...record,
    files: { ...record.files, [options.slug]: next },
  };
}

/* ────────────────────────────────────────────────────────────────────── */
/* Concurrency guard                                                      */
/* ────────────────────────────────────────────────────────────────────── */

interface ScheduleRow {
  id: number;
  correlation_id: string | null;
  status: string;
}

function findActiveRetemplateRow(db: Database.Database): ScheduleRow | null {
  const row = db
    .prepare(
      `SELECT id, correlation_id, status
         FROM agent_schedule
        WHERE task_type = 'git.project.retemplate'
          AND status IN ('pending', 'running')
        ORDER BY id DESC
        LIMIT 1`,
    )
    .get() as ScheduleRow | undefined;
  return row ?? null;
}

/* ────────────────────────────────────────────────────────────────────── */
/* Run preparation — backup, status grid init, agent_schedule insert     */
/* ────────────────────────────────────────────────────────────────────── */

export function prepareRetemplateRun(
  options: PrepareRetemplateOptions,
): PrepareRetemplateResult {
  const existingRow = findActiveRetemplateRow(options.db);
  if (existingRow) {
    return {
      ok: false,
      reason: "in_progress",
      detail: {
        scheduleId: existingRow.id,
        correlationId: existingRow.correlation_id ?? undefined,
      },
    };
  }

  const templatePath = templateFilePath(options.dataDir, options.kind);
  if (!existsSync(templatePath)) {
    return { ok: false, reason: "missing_template" };
  }
  const templateContent = readFileSync(templatePath, "utf-8");

  const targets = selectRetemplateTargets(
    options.repos,
    options.kind,
    options.contextDir,
  );
  if (targets.length === 0) {
    return { ok: false, reason: "no_targets" };
  }

  const now = options.now?.() ?? new Date();
  const backupRoot = buildBackupRoot(options.dataDir, now);
  mkdirSync(backupRoot, { recursive: true });

  // Atomic-up-front backup. If any single copy fails the whole run aborts
  // before we touch agent_schedule — there is no half-armed state.
  for (const target of targets) {
    const src = join(options.contextDir, target.contextFile);
    const dst = join(backupRoot, target.backupRelPath);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  }

  const correlationId = randomUUID();
  const files: Record<string, RetemplateFileEntry> = {};
  for (const target of targets) {
    files[target.slug] = { ...target, status: "pending" };
  }

  const taskContext = {
    processKey: "git.project.retemplate",
    kind: options.kind,
    templateName: templateFileName(options.kind),
    templateContent,
    backupRoot,
    correlationId,
    targets,
  } satisfies Record<string, unknown>;

  const insert = options.db.prepare(
    `INSERT INTO agent_schedule
       (scheduled_for, task_type, task_description, task_context, correlation_id, model, status)
     VALUES (?, 'git.project.retemplate', ?, ?, ?, NULL, 'pending')`,
  );
  const result = insert.run(
    formatSqliteDatetime(now),
    `Re-conform ${targets.length} ${options.kind === "project" ? "project" : "git-repo"} document(s) to the current ${templateFileName(options.kind)} template.`,
    JSON.stringify(taskContext),
    correlationId,
  );
  const scheduleId = Number(result.lastInsertRowid);

  const record: RetemplateStatusRecord = {
    scheduleId,
    correlationId,
    kind: options.kind,
    backupRoot,
    startedAt: now.toISOString(),
    files,
  };
  writeRetemplateStatus(options.db, record);

  return {
    ok: true,
    scheduleId,
    correlationId,
    backupRoot,
    kind: options.kind,
    targets,
    record,
  };
}

/* ────────────────────────────────────────────────────────────────────── */
/* Per-file status persistence (called from API route)                    */
/* ────────────────────────────────────────────────────────────────────── */

export type PersistPerFileResult =
  | { ok: true; record: RetemplateStatusRecord; entry: RetemplateFileEntry }
  | { ok: false; reason: "no_active_run" | "unknown_slug" | "correlation_mismatch" };

export interface PersistPerFileOptions extends RecordPerFileOptions {
  db: Database.Database;
  correlationId?: string;
}

export function persistPerFileStatus(
  options: PersistPerFileOptions,
): PersistPerFileResult {
  const record = readRetemplateStatus(options.db);
  if (!record) return { ok: false, reason: "no_active_run" };
  if (
    options.correlationId !== undefined
    && options.correlationId !== record.correlationId
  ) {
    return { ok: false, reason: "correlation_mismatch" };
  }
  const next = applyPerFileUpdate(record, options);
  if (!next) return { ok: false, reason: "unknown_slug" };
  writeRetemplateStatus(options.db, next);
  return { ok: true, record: next, entry: next.files[options.slug] };
}

/* ────────────────────────────────────────────────────────────────────── */
/* Finalize hook — restore in-flight files from backup on session end    */
/* ────────────────────────────────────────────────────────────────────── */

export interface FinalizeRetemplateOptions {
  db: Database.Database;
  contextDir: string;
  scheduleId: number;
  /** True when the agent_schedule row settled to a non-success status. */
  errored: boolean;
  now?: () => Date;
}

export interface FinalizeRetemplateResult {
  applied: boolean;
  rolledBackSlugs: string[];
  finalStatus: RetemplateRunStatus;
}

export function finalizeRetemplate(
  options: FinalizeRetemplateOptions,
): FinalizeRetemplateResult {
  const record = readRetemplateStatus(options.db);
  if (!record || record.scheduleId !== options.scheduleId) {
    return { applied: false, rolledBackSlugs: [], finalStatus: "success" };
  }
  if (record.finalizedAt) {
    return {
      applied: false,
      rolledBackSlugs: [],
      /* v8 ignore next */
      finalStatus: record.finalStatus ?? "success",
    };
  }

  const nowIso = (options.now?.() ?? new Date()).toISOString();
  const nextFiles: Record<string, RetemplateFileEntry> = {};
  const rolledBackSlugs: string[] = [];

  for (const [slug, entry] of Object.entries(record.files)) {
    if (entry.status === "started" || entry.status === "pending") {
      // The agent never settled this file. If it reached `started` it
      // *may* have written a partial body before crashing; even
      // `pending` should be restored when the run errored, because the
      // agent could have written the file without first reporting
      // `started` (we cannot prove it didn't). Restore from backup
      // unconditionally when the run errored; on a clean exit only the
      // explicit `started`-but-unsettled case is restored.
      const shouldRestore = entry.status === "started" || options.errored;
      if (shouldRestore) {
        const src = join(record.backupRoot, entry.backupRelPath);
        const dst = join(options.contextDir, entry.contextFile);
        try {
          if (existsSync(src)) {
            const content = readFileSync(src, "utf-8");
            writeFileAtomically(dst, content);
            rolledBackSlugs.push(slug);
            nextFiles[slug] = {
              ...entry,
              status: "rolled_back",
              completedAt: nowIso,
              ...(entry.error ? {} : { reason: "session_aborted" }),
            };
            continue;
          }
          // Backup missing — operator deleted the backup root, or the
          // initial copy never landed. Mark explicitly so the dashboard
          // doesn't leave a row stuck in `started` forever.
          nextFiles[slug] = {
            ...entry,
            status: "failed",
            error: "rollback_failed: backup_missing",
            completedAt: nowIso,
          };
          continue;
        } catch (err) {
          logger.error(
            { err, slug, src, dst },
            "Failed to restore retemplate target from backup",
          );
          nextFiles[slug] = {
            ...entry,
            status: "failed",
            error:
              "rollback_failed: "
              /* v8 ignore next */
              + (err instanceof Error ? err.message : String(err)),
            completedAt: nowIso,
          };
          continue;
        }
      }
    }
    nextFiles[slug] = entry;
  }

  const finalStatus = summarizeFinalStatus(nextFiles);
  const finalized: RetemplateStatusRecord = {
    ...record,
    files: nextFiles,
    finalizedAt: nowIso,
    finalStatus,
  };
  writeRetemplateStatus(options.db, finalized);
  return {
    applied: true,
    rolledBackSlugs,
    finalStatus,
  };
}

/* ────────────────────────────────────────────────────────────────────── */
/* Helper — count bytes of a context file safely                         */
/* ────────────────────────────────────────────────────────────────────── */

export function safeFileSize(absPath: string): number | undefined {
  try {
    return statSync(absPath).size;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the path the route uses to read a file's pre-write byte count.
 * Relative to contextDir; rejects path traversal as defense-in-depth even
 * though all callers pass values produced by `selectRetemplateTargets`.
 */
export function resolveContextFilePath(
  contextDir: string,
  contextFile: string,
): string {
  if (
    contextFile.length === 0
    || isAbsolute(contextFile)
    || contextFile.split(/[\\/]+/).some((seg) => seg === "..")
  ) {
    throw Object.assign(
      new Error(`path_outside_context_dir: ${contextFile}`),
      { code: "ETEMPLATE_PATH_OUTSIDE_CONTEXT_DIR" },
    );
  }
  const abs = resolve(contextDir, contextFile);
  const rel = relative(contextDir, abs);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw Object.assign(
      new Error(`path_outside_context_dir: ${contextFile}`),
      { code: "ETEMPLATE_PATH_OUTSIDE_CONTEXT_DIR" },
    );
  }
  return abs;
}
