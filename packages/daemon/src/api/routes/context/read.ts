import type { Hono } from "hono";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { localDateStr } from "@aitne/shared";
import { CONTEXT_FILE_EXTENSIONS } from "../../../core/context-paths.js";
import { buildContextHealthReport } from "../../../core/context-health.js";
import {
  type AgentPlanScheduleCandidate,
  toTodayScheduleCandidate,
  validateTodayContent,
} from "../../../core/context-validation/index.js";
import {
  buildTodayAgentPlanMetadata,
  extractTodayAgentPlanRows,
  extractTodayDate,
  readTodayAgentPlanMetadata,
} from "../../../core/today-agent-plan.js";
import { createLogger } from "../../../logging.js";
import {
  composeIssue,
  respondWithAgentError,
} from "../../helpers/agent-errors.js";
import { isWriteAllowed } from "./permissions.js";
import { normalizeContextPath, safePath } from "./path-resolve.js";
import type { ContextRouteContext } from "./index.js";

const logger = createLogger("context-api");

export function registerReadRoutes(app: Hono, ctx: ContextRouteContext): void {
  const { deps, getCurrentContextDir } = ctx;
  const { db, config } = deps;

  // GET /context/list/:dir — List files in directory
  app.get("/context/list/:dir", (c) => {
    const dir = c.req.param("dir");
    // B-007 §5.1 — canonical listable directories.
    const allowedDirs = [
      "projects",
      "weekly",
      "monthly",
      "daily",
      "user",
      "rules",
      "routines",
      "dossiers",
      "git",
      "git-repos",
      "inbox",
    ];
    if (!allowedDirs.includes(dir)) {
      return respondWithAgentError(c, 400, [
        composeIssue("context.directory_invalid", {
          field: "dir",
          received: { dir, allowed: allowedDirs },
        }),
      ]);
    }

    const contextDir = getCurrentContextDir();
    const dirPath = join(contextDir, dir);
    if (!existsSync(dirPath)) {
      return c.json({ files: [] });
    }

    const files = readdirSync(dirPath)
      .filter((f) =>
        CONTEXT_FILE_EXTENSIONS.some((ext) => f.endsWith(ext)),
      )
      .map((f) => {
        const stat = statSync(join(dirPath, f));
        return { name: f, lastModified: stat.mtime.toISOString() };
      });

    // B-007 §5.8 Q3 — surface custom routines so the dashboard routines
    // editor sees them alongside the built-ins. `routines/custom/` is the
    // only nested directory we need to flatten; other listable dirs are
    // flat by design (§5.1).
    if (dir === "routines") {
      const customDir = join(dirPath, "custom");
      if (existsSync(customDir)) {
        for (const f of readdirSync(customDir)) {
          if (!CONTEXT_FILE_EXTENSIONS.some((ext) => f.endsWith(ext))) continue;
          const stat = statSync(join(customDir, f));
          files.push({
            name: `custom/${f}`,
            lastModified: stat.mtime.toISOString(),
          });
        }
      }
    }
    // Unified repositories layout (`git/<slug>/overview.md` +
    // `git/<slug>/journal/<YYYY-MM-DD>.md`) — surface every per-repo file
    // under the `git` listing so the Knowledge page tree shows them.
    // Without this the listing only contains files directly under `git/`,
    // and the per-slug subdirectories silently drop off the dashboard.
    // Mirrors the `routines/custom/` flatten above.
    if (dir === "git") {
      for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const slug = entry.name;
        const slugDir = join(dirPath, slug);
        for (const f of readdirSync(slugDir)) {
          if (!CONTEXT_FILE_EXTENSIONS.some((ext) => f.endsWith(ext))) continue;
          const stat = statSync(join(slugDir, f));
          files.push({
            name: `${slug}/${f}`,
            lastModified: stat.mtime.toISOString(),
          });
        }
        const journalDir = join(slugDir, "journal");
        if (existsSync(journalDir)) {
          for (const f of readdirSync(journalDir)) {
            if (!CONTEXT_FILE_EXTENSIONS.some((ext) => f.endsWith(ext))) continue;
            const stat = statSync(join(journalDir, f));
            files.push({
              name: `${slug}/journal/${f}`,
              lastModified: stat.mtime.toISOString(),
            });
          }
        }
      }
    }
    // MANAGEMENT-POLICY-CAPTURE-PLAN §4.4.1 step 1 — surface policy files
    // under `rules/policies/` flattened into the `rules` listing so the
    // `management-policy` skill can use the directory listing as its
    // source-of-truth (the agent-maintained `_index.md` is only the
    // convenience snapshot). Mirrors the `routines/custom/` flatten above.
    if (dir === "rules") {
      const policiesDir = join(dirPath, "policies");
      if (existsSync(policiesDir)) {
        for (const f of readdirSync(policiesDir)) {
          if (!CONTEXT_FILE_EXTENSIONS.some((ext) => f.endsWith(ext))) continue;
          const stat = statSync(join(policiesDir, f));
          files.push({
            name: `policies/${f}`,
            lastModified: stat.mtime.toISOString(),
          });
        }
      }
    }

    return c.json({ files });
  });

  // GET /context/today/reconciliation — compare open Agent Plan rows with
  // pending/running schedules for the same local day. This is intentionally
  // diagnostic only: morning routine may write today.md and register schedules
  // in separate API calls, so write-time hard failure would create false
  // conflicts. The endpoint gives operators and future jobs a server-side
  // reconciliation surface.
  app.get("/context/today/reconciliation", (c) => {
    const contextDir = getCurrentContextDir();
    const fullPath = safePath(contextDir, "today");
    if (!fullPath) {
      return respondWithAgentError(c, 400, [
        composeIssue("context.path_invalid", {
          field: "path",
          received: "today",
        }),
      ]);
    }
    if (!existsSync(fullPath)) {
      return respondWithAgentError(c, 404, [
        composeIssue("context.path_not_found", {
          field: "path",
          received: "today",
        }),
      ]);
    }

    const content = readFileSync(fullPath, "utf-8");
    const validationError = validateTodayContent(content);
    const todayDate =
      extractTodayDate(content) ??
      localDateStr(new Date(), config.timezone || undefined);
    const openRows = extractTodayAgentPlanRows(content).rows.filter(
      (row) => !row.checked,
    );
    const openRowsWithMetadata = openRows.map((row) => ({
      row,
      agentPlan: buildTodayAgentPlanMetadata(todayDate, row),
    }));
    const pendingRows = db
      .prepare(
        `SELECT id, scheduled_for, task_type, task_description, task_context, status
           FROM agent_schedule
          WHERE status IN ('pending', 'running')`,
      )
      .all() as Array<{
        id: number;
        scheduled_for: string;
        task_type: string;
        task_description: string | null;
        task_context: string | null;
        status: string;
      }>;

    const schedules = pendingRows
      .map((row) =>
        toTodayScheduleCandidate(row, config.timezone || undefined),
      )
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .map((row) => ({
        ...row,
        agentPlan: readTodayAgentPlanMetadata(row.taskContext),
      }))
      .filter(
        (row): row is AgentPlanScheduleCandidate =>
          row.agentPlan !== null && row.agentPlan.date === todayDate,
      );

    const rowMatches = openRowsWithMetadata.map(({ row, agentPlan }) => {
      const matches = schedules.filter((schedule) =>
        schedule.localDate === todayDate &&
        schedule.localTime === row.time &&
        schedule.agentPlan.ref === agentPlan.ref &&
        schedule.agentPlan.fingerprint === agentPlan.fingerprint &&
        schedule.agentPlan.category === row.category &&
        schedule.agentPlan.trigger === row.trigger,
      );
      return { row, agentPlan, matches };
    });
    const rowsWithoutSchedule = rowMatches.filter(
      ({ matches }) => matches.length === 0,
    );
    const duplicateAgentPlanSchedules = rowMatches.filter(
      ({ matches }) => matches.length > 1,
    );
    const matchedScheduleIds = new Set<number>();
    for (const { matches } of rowMatches) {
      for (const schedule of matches) matchedScheduleIds.add(schedule.id);
    }
    const schedulesWithoutRow = schedules.filter(
      (row) => !matchedScheduleIds.has(row.id),
    );
    const mismatchCount = (
      rowsWithoutSchedule.length +
      duplicateAgentPlanSchedules.length +
      schedulesWithoutRow.length
    );

    return c.json({
      status: validationError
        ? "invalid_today"
        : mismatchCount > 0
          ? "mismatch"
          : "ok",
      validationError,
      todayDate,
      openAgentPlanRows: openRows.length,
      pendingSchedules: schedules.length,
      rowsWithoutSchedule: rowsWithoutSchedule.map(({ row, agentPlan }) => ({
        line: row.line,
        ref: agentPlan.ref,
        time: row.time,
        action: row.action,
        category: row.category,
        trigger: row.trigger,
      })),
      schedulesWithoutRow: schedulesWithoutRow.map((row) => ({
        id: row.id,
        ref: row.agentPlan.ref,
        localTime: row.localTime,
        scheduledFor: row.scheduledFor,
        taskType: row.taskType,
        status: row.status,
        description: row.description,
      })),
      duplicateAgentPlanSchedules: duplicateAgentPlanSchedules.map(
        ({ row, agentPlan, matches }) => ({
          line: row.line,
          ref: agentPlan.ref,
          time: row.time,
          action: row.action,
          scheduleIds: matches.map((match) => match.id),
        }),
      ),
    });
  });

  // GET /context/health — schema drift and missing-file report for the
  // primary context vault. Registered before the wildcard read route.
  app.get("/context/health", (c) => {
    const contextDir = getCurrentContextDir();
    return c.json(buildContextHealthReport(contextDir));
  });

  // GET /context/* — Read context file. Registered LAST in this file so
  // the specific routes above (`/list/:dir`, `/today/reconciliation`,
  // `/health`) take precedence under Hono's first-match dispatch.
  app.get("/context/*", (c) => {
    const rawPath = c.req.path.replace("/api/context/", "");
    if (!rawPath || rawPath === "list") {
      return respondWithAgentError(c, 400, [
        composeIssue("context.path_required", {
          field: "path",
          received: rawPath === "list" ? "list (route ambiguous with /list/:dir)" : "<empty>",
        }),
      ]);
    }
    const path = normalizeContextPath(rawPath);

    const contextDir = getCurrentContextDir();
    const fullPath = safePath(contextDir, rawPath);
    if (!fullPath) {
      return respondWithAgentError(c, 400, [
        composeIssue("context.path_invalid", {
          field: "path",
          received: path,
        }),
      ]);
    }
    if (!existsSync(fullPath)) {
      return respondWithAgentError(c, 404, [
        composeIssue("context.path_not_found", {
          field: "path",
          received: path,
        }),
      ]);
    }

    const content = readFileSync(fullPath, "utf-8");
    const stat = statSync(fullPath);

    // STAGE-C-DM-FRESHNESS-PLAN §Task 4 — record reads of `today` so the
    // dashboard refetch-hit metric can detect when the agent invokes the
    // Task 3 directive on a resumed turn. Bounded to `today` reads only
    // so the agent_actions volume stays small. Best-effort: any logging
    // failure must not break the read.
    if (path === "today") {
      try {
        deps.db
          .prepare(
            `INSERT INTO agent_actions (action_type, trigger, result, detail, started_at, completed_at)
             VALUES ('context_read', 'reactive', 'success', json(?), datetime('now'), datetime('now'))`,
          )
          .run(JSON.stringify({ path }));
      } catch (err) {
        /* c8 ignore next 5 — DB INSERT failure inside a best-effort audit path;
         * triggering requires closing the DB mid-request which destroys
         * the test harness. */
        logger.warn(
          { err, path },
          "Failed to record context_read agent_actions row (Stage C metrics)",
        );
      }
    }

    return c.json({
      content,
      lastModified: stat.mtime.toISOString(),
      editable: isWriteAllowed(path, "PUT"),
    });
  });
}
