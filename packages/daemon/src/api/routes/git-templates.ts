/**
 * Git project document template editor + Re-template (P6 Decision 8).
 *
 * Three concerns share one route file because they are one workflow:
 *
 *   1. **Template editor.** `GET / PUT /api/git/templates/:kind` reads
 *      and writes `<dataDir>/templates/{project,git-repo}.md`. Reads
 *      additionally surface the bundled body so the dashboard can show
 *      a "reset to bundled" affordance and a per-side diff.
 *
 *   2. **Apply.** `POST /api/git/templates/:kind/apply` enumerates the
 *      target context files for the kind, atomically backs every one of
 *      them up under `<dataDir>/backups/templates/<safeIso>/`,
 *      initializes the status grid in `runtime_state`, and inserts a
 *      single `agent_schedule.task_type='git.project.retemplate'` row.
 *      A second concurrent invocation gets 409 with the in-flight
 *      schedule id so the dashboard can render "already running" state.
 *
 *   3. **Status surface + per-file reporter.** `GET /api/git/templates/retemplate/status`
 *      returns the live status grid for the dashboard. `POST /api/git/templates/retemplate/file`
 *      is what the agent calls to report per-file progress; each call
 *      updates the status grid, and on terminal status (`completed`,
 *      `skipped`, `failed`) it also emits one `agent_actions` audit row
 *      tagged `action_type='git.project.retemplate'`. `started` updates
 *      the grid only — it is a work-begin marker that the daemon's
 *      finalize hook needs to know about for rollback, but not a
 *      per-file outcome the audit log should record (audit rows count
 *      outcomes, not work-begin pings).
 *
 * Risk-tier split (see risk-classifier.ts §"Git templates"):
 *
 *   • Editor (`GET / PUT /:kind`), apply (`POST /:kind/apply`), and
 *     status (`GET /retemplate/status`) are dashboard-driven and stay
 *     Approve-tier (Bearer required).
 *   • The per-file reporter (`POST /retemplate/file`) is the exception:
 *     the re-template task-flow runs as an autonomous session and posts
 *     over curl from the session workdir, which carries no Bearer. The
 *     classifier has an exact-match `Autonomous` override for this path.
 */

import { Hono } from "hono";
import {
  persistPerFileStatus,
  prepareRetemplateRun,
  readRetemplateStatus,
  readTemplateBody,
  templateFilePath,
  writeTemplateBody,
  type RetemplateFileStatus,
  type TemplateKind,
} from "../../core/template-store.js";
import {
  normalizeGitWatchedRepos,
  readBundledGitProjectDocTemplate,
} from "../../core/git-project-docs.js";
import { selectGitWatchedRepos } from "../../db/repositories-store.js";
import type Database from "better-sqlite3";
import type { AgentConfig } from "../../config.js";
import { existsSync, readFileSync } from "node:fs";
import { createLogger, toSafeErrorMessage } from "../../logging.js";
import { readJsonBody } from "../json-body.js";
import { composeIssue, respondWithAgentError } from "../helpers/agent-errors.js";

const logger = createLogger("git-templates-api");

const TEMPLATE_BODY_MAX_BYTES = 64 * 1024;
const REPORT_BODY_MAX_BYTES = 4 * 1024;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

function parseKind(kind: string | undefined): TemplateKind | null {
  return kind === "project" || kind === "git-repo" ? kind : null;
}

const VALID_REPORT_STATUSES: ReadonlySet<RetemplateFileStatus> = new Set<
  RetemplateFileStatus
>(["started", "completed", "skipped", "failed"]);

export interface GitTemplatesRouteDependencies {
  db: Database.Database;
  config: AgentConfig;
  /** Resolves the active context root (vault or `<dataDir>/context`). */
  getContextDir: () => string;
}

export function createGitTemplatesRoutes(
  deps: GitTemplatesRouteDependencies,
): Hono {
  const app = new Hono();

  /* ── Editor ───────────────────────────────────────────────────────── */

  app.get("/git/templates/:kind", (c) => {
    const rawKind = c.req.param("kind");
    const kind = parseKind(rawKind);
    if (!kind) {
      return respondWithAgentError(c, 400, [
        composeIssue("git_templates.invalid_kind", {
          field: "kind",
          received: rawKind,
        }),
      ]);
    }
    try {
      const overridePath = templateFilePath(deps.config.dataDir, kind);
      const hasOverride = existsSync(overridePath);
      const overrideBody = hasOverride
        ? readFileSync(overridePath, "utf-8")
        : null;
      // Bundled body — independent of the override layer so the
      // dashboard can render a "reset to bundled" affordance.
      const bundledBody = readBundledGitProjectDocTemplate(
        deps.config.workspaceDir,
        kind === "project" ? "project" : "repo-only",
      );
      const activeBody = readTemplateBody(
        deps.config.dataDir,
        deps.config.workspaceDir,
        kind,
      );
      return c.json({
        kind,
        active: activeBody,
        bundled: bundledBody,
        override: overrideBody,
        hasOverride,
        path: overridePath,
      });
    } catch (err) {
      logger.error({ kind, err }, "Failed to read git template");
      return respondWithAgentError(c, 500, [
        composeIssue("git_templates.read_failed", {
          field: "kind",
          received: kind,
        }),
      ], { legacyFields: { message: toSafeErrorMessage(err) } });
    }
  });

  app.put("/git/templates/:kind", async (c) => {
    const rawKind = c.req.param("kind");
    const kind = parseKind(rawKind);
    if (!kind) {
      return respondWithAgentError(c, 400, [
        composeIssue("git_templates.invalid_kind", {
          field: "kind",
          received: rawKind,
        }),
      ]);
    }
    const parsed = await readJsonBody(c, { maxBytes: TEMPLATE_BODY_MAX_BYTES });
    if (!parsed.ok) return parsed.response;
    const body = parsed.body as { content?: unknown };
    if (typeof body.content !== "string") {
      return respondWithAgentError(c, 400, [
        composeIssue("git_templates.content_required", {
          field: "content",
          received: typeof body.content,
        }),
      ]);
    }
    try {
      const result = writeTemplateBody(deps.config.dataDir, kind, body.content);
      logger.info({ kind, bytes: result.bytes }, "Git template override written");
      return c.json({
        ok: true,
        kind,
        bytes: result.bytes,
        path: templateFilePath(deps.config.dataDir, kind),
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      /* c8 ignore start — readJsonBody caps the request at the same
         TEMPLATE_BODY_MAX_BYTES, so any payload that reaches
         writeTemplateBody is already within the cap. The ETEMPLATE_BODY_TOO_LARGE
         branch stays as defense-in-depth in case the cap is later relaxed
         on either side. */
      if (code === "ETEMPLATE_BODY_TOO_LARGE") {
        return respondWithAgentError(c, 413, [
          composeIssue("git_templates.body_too_large", {
            field: "content",
            received: `>${TEMPLATE_BODY_MAX_BYTES} bytes`,
            constraint: { type: "string", maximum: TEMPLATE_BODY_MAX_BYTES },
          }),
        ], { legacyFields: { maxBytes: TEMPLATE_BODY_MAX_BYTES } });
      }
      /* c8 ignore stop */
      logger.error({ kind, err }, "Failed to write git template");
      return respondWithAgentError(c, 500, [
        composeIssue("git_templates.write_failed", {
          field: "kind",
          received: kind,
        }),
      ], { legacyFields: { message: toSafeErrorMessage(err) } });
    }
  });

  /* ── Apply (enqueue retemplate run) ───────────────────────────────── */

  app.post("/git/templates/:kind/apply", (c) => {
    const rawKind = c.req.param("kind");
    const kind = parseKind(rawKind);
    if (!kind) {
      return respondWithAgentError(c, 400, [
        composeIssue("git_templates.invalid_kind", {
          field: "kind",
          received: rawKind,
        }),
      ]);
    }
    const repos = normalizeGitWatchedRepos({
      gitWatchedRepos: selectGitWatchedRepos(deps.db),
    });
    const result = prepareRetemplateRun({
      db: deps.db,
      dataDir: deps.config.dataDir,
      workspaceDir: deps.config.workspaceDir,
      contextDir: deps.getContextDir(),
      kind,
      repos,
    });
    if (result.ok) {
      logger.info(
        {
          kind,
          scheduleId: result.scheduleId,
          targets: result.targets.length,
          backupRoot: result.backupRoot,
        },
        "Retemplate run prepared",
      );
      return c.json({
        ok: true,
        kind,
        scheduleId: result.scheduleId,
        correlationId: result.correlationId,
        backupRoot: result.backupRoot,
        targets: result.targets.map((t) => ({
          slug: t.slug,
          contextFile: t.contextFile,
          backupRelPath: t.backupRelPath,
        })),
      });
    }
    if (result.reason === "in_progress") {
      return respondWithAgentError(c, 409, [
        composeIssue("git_templates.in_progress", {
          field: "<server>",
          received: { scheduleId: result.detail.scheduleId },
        }),
      ], {
        legacyFields: {
          scheduleId: result.detail.scheduleId,
          correlationId: result.detail.correlationId ?? null,
        },
      });
    }
    if (result.reason === "missing_template") {
      return respondWithAgentError(c, 412, [
        composeIssue("git_templates.missing_template", {
          field: "kind",
          received: kind,
        }),
      ], { legacyFields: { kind } });
    }
    return respondWithAgentError(c, 422, [
      composeIssue("git_templates.no_targets", {
        field: "<server>",
        received: { kind, targets: 0 },
      }),
    ], { legacyFields: { kind } });
  });

  /* ── Status surface ───────────────────────────────────────────────── */

  app.get("/git/templates/retemplate/status", (c) => {
    const record = readRetemplateStatus(deps.db);
    return c.json({ status: record });
  });

  /* ── Per-file reporter (called by the agent task-flow) ────────────── */

  app.post("/git/templates/retemplate/file", async (c) => {
    const parsed = await readJsonBody(c, { maxBytes: REPORT_BODY_MAX_BYTES });
    if (!parsed.ok) return parsed.response;
    const body = parsed.body as {
      slug?: unknown;
      status?: unknown;
      reason?: unknown;
      error?: unknown;
      beforeBytes?: unknown;
      afterBytes?: unknown;
      correlationId?: unknown;
    };
    if (typeof body.slug !== "string" || !SLUG_PATTERN.test(body.slug)) {
      return respondWithAgentError(c, 400, [
        composeIssue("git_templates.invalid_slug", {
          field: "slug",
          received: body.slug,
        }),
      ]);
    }
    if (
      typeof body.status !== "string"
      || !VALID_REPORT_STATUSES.has(body.status as RetemplateFileStatus)
    ) {
      return respondWithAgentError(c, 400, [
        composeIssue("git_templates.invalid_status", {
          field: "status",
          received: body.status,
        }),
      ]);
    }
    const slug = body.slug;
    const status = body.status as RetemplateFileStatus;

    const persisted = persistPerFileStatus({
      db: deps.db,
      slug,
      status,
      ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
      ...(typeof body.error === "string" ? { error: body.error } : {}),
      ...(typeof body.beforeBytes === "number"
        ? { beforeBytes: body.beforeBytes }
        : {}),
      ...(typeof body.afterBytes === "number"
        ? { afterBytes: body.afterBytes }
        : {}),
      ...(typeof body.correlationId === "string"
        ? { correlationId: body.correlationId }
        : {}),
    });

    if (!persisted.ok) {
      const reasonToCode: Record<string, "git_templates.no_active_run" | "git_templates.correlation_mismatch" | "git_templates.slug_not_in_run"> = {
        no_active_run: "git_templates.no_active_run",
        correlation_mismatch: "git_templates.correlation_mismatch",
      };
      const registryCode = reasonToCode[persisted.reason] ?? "git_templates.slug_not_in_run";
      const status =
        persisted.reason === "no_active_run"
          ? 409
          : persisted.reason === "correlation_mismatch"
            ? 409
            : 404;
      return respondWithAgentError(c, status, [
        composeIssue(registryCode, {
          field: persisted.reason === "correlation_mismatch"
            ? "correlationId"
            : "slug",
          received: persisted.reason === "correlation_mismatch"
            ? (typeof body.correlationId === "string" ? body.correlationId : null)
            : slug,
        }),
      ]);
    }

    // Per-file audit row — emitted only on terminal status so the audit
    // log shows exactly one row per file (Decision 8 §2: "Audit row per
    // file"). `started` updates the status grid (the daemon's finalize
    // hook needs the marker to decide whether to restore from backup),
    // but it is a work-begin ping, not an outcome — recording it would
    // double the row count and pollute success/failed analytics. The
    // child row reuses the run's `correlationId` as `event_id` so it
    // stitches to the parent session row the dispatcher writes for the
    // scheduled task (the scheduler propagates `agent_schedule.correlation_id`
    // onto `event.correlationId`, which the dispatcher then logs).
    if (
      status === "completed"
      || status === "failed"
      || status === "skipped"
    ) {
      const auditResult: "success" | "failed" | "skipped" =
        status === "completed"
          ? "success"
          : status === "failed"
            ? "failed"
            : "skipped";
      try {
        const detail = JSON.stringify({
          slug,
          contextFile: persisted.entry.contextFile,
          backupRelPath: persisted.entry.backupRelPath,
          kind: persisted.record.kind,
          backupRoot: persisted.record.backupRoot,
          status,
          ...(persisted.entry.beforeBytes !== undefined
            ? { beforeBytes: persisted.entry.beforeBytes }
            : {}),
          ...(persisted.entry.afterBytes !== undefined
            ? { afterBytes: persisted.entry.afterBytes }
            : {}),
          ...(persisted.entry.reason ? { reason: persisted.entry.reason } : {}),
          ...(persisted.entry.error ? { error: persisted.entry.error } : {}),
        });
        const errorText: string | null =
          status === "failed"
            ? typeof body.error === "string"
              ? body.error
              : "unspecified"
            : null;
        deps.db
          .prepare(
            `INSERT INTO agent_actions
               (event_id, action_type, trigger, result, detail, error, started_at, completed_at)
             VALUES (?, 'git.project.retemplate', 'autonomous', ?, ?, ?, datetime('now'), datetime('now'))`,
          )
          .run(
            persisted.record.correlationId,
            auditResult,
            detail,
            errorText,
          );
      } catch (err) {
        logger.warn(
          { err, slug, status },
          "Failed to write per-file retemplate audit row (status grid still updated)",
        );
      }
    }

    return c.json({
      ok: true,
      slug,
      status,
      record: persisted.record,
    });
  });

  return app;
}
