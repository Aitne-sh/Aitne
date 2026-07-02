import type { Hono } from "hono";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { localDateStr } from "@aitne/shared";
import { CONTEXT_FILE_EXTENSIONS } from "../../../core/context-paths.js";
import { summarizeProjectFile } from "../../../core/context-builder-projects.js";
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

  // GET /context/list/:dir — List files in directory.
  //
  // Accepts both the new canonical names ("identity", "policies",
  // "policies/routines", "plans/projects", "journal/daily", ...) and
  // the legacy aliases ("user", "rules", "routines", "projects",
  // "daily", ...) — the latter are translated to the new dir before
  // listing. Legacy aliases are removed in the same minor-release
  // window as the §14.4 agent-asset prose sweep (PR-6).
  // `:dir{.+}` (not bare `:dir`) so the param captures slashes — after the
  // context-vault restructure the canonical dir names are nested
  // ("journal/daily", "knowledge/repos", "policies/routines", ...). A bare
  // single-segment `:dir` matches `[^/]+`, so those requests fell through to
  // Hono's default 404 and the dashboard file tree showed only the
  // single-segment dirs (identity, policies). The handler's `allowedDirs`
  // whitelist + `legacyDirAlias` map already expect the nested names.
  app.get("/context/list/:dir{.+}", (c) => {
    const rawDir = c.req.param("dir");
    const legacyDirAlias: Record<string, string> = {
      user: "identity",
      rules: "policies",
      routines: "policies/routines",
      projects: "plans/projects",
      daily: "journal/daily",
      weekly: "journal/weekly",
      monthly: "journal/monthly",
      dossiers: "knowledge/dossiers",
      inbox: "state/inbox",
      git: "knowledge/repos",
      "git-repos": "knowledge/repos/legacy-registry",
    };
    const dir = legacyDirAlias[rawDir] ?? rawDir;
    const allowedDirs = [
      "identity",
      "policies",
      "policies/routines",
      "policies/management-captures",
      "plans/projects",
      "journal/daily",
      "journal/weekly",
      "journal/monthly",
      "knowledge/dossiers",
      "knowledge/repos",
      "knowledge/repos/legacy-registry",
      "knowledge/sources",
      "state/inbox",
    ];
    if (!allowedDirs.includes(dir)) {
      return respondWithAgentError(c, 400, [
        composeIssue("context.directory_invalid", {
          field: "dir",
          received: { dir: rawDir, allowed: allowedDirs },
        }),
      ]);
    }

    const contextDir = getCurrentContextDir();
    const dirPath = join(contextDir, dir);
    if (!existsSync(dirPath)) {
      return c.json({ files: [] });
    }

    const files: {
      name: string;
      lastModified: string;
      meta?: { title: string; state: string };
    }[] = readdirSync(dirPath)
      .filter((f) =>
        CONTEXT_FILE_EXTENSIONS.some((ext) => f.endsWith(ext)),
      )
      .map((f) => {
        const stat = statSync(join(dirPath, f));
        return { name: f, lastModified: stat.mtime.toISOString() };
      });

    // Projects tree readability — attach the frontmatter/H1 summary the
    // dashboard sidebar groups by (title + state). Additive: every other
    // dir keeps the bare {name, lastModified} shape, and `_`-prefixed
    // files (`_index.md`, `_active.base`) stay meta-less on purpose.
    if (dir === "plans/projects") {
      for (const file of files) {
        if (file.name.startsWith("_") || !file.name.endsWith(".md")) continue;
        try {
          const content = readFileSync(join(dirPath, file.name), "utf-8");
          const summary = summarizeProjectFile(file.name, content);
          if (summary) {
            file.meta = { title: summary.title, state: summary.state };
          }
        } catch {
          // Unreadable file — leave the bare entry rather than failing the listing.
        }
      }
    }

    // Surface custom routines so the dashboard routines editor sees
    // them alongside the built-ins. After the restructure the parent
    // dir is `policies/routines` and the custom sub-dir is
    // `policies/routines/custom/`.
    if (dir === "policies/routines") {
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
    // Unified repositories layout — surface every per-repo file under
    // the `knowledge/repos` listing so the Knowledge page tree shows
    // them. Overview lives under `knowledge/repos/<slug>/overview.md`;
    // per-day journals live under `journal/repos/<slug>/` and are
    // surfaced as part of the journal/daily listing.
    if (dir === "knowledge/repos") {
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
      }
    }
    // Source-document cards live at `knowledge/sources/<collection>/<slug>.md`
    // (SOURCE_LIBRARY_DESIGN.md); the root `_index.md` is picked up by the
    // flat readdir above. Mirrors the knowledge/repos one-level flattening.
    // Cards nested deeper than one level (permitted by the write whitelist
    // but against the sources-skill convention) stay invisible here — same
    // accepted limitation as the repos block.
    if (dir === "knowledge/sources") {
      for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const collection = entry.name;
        const collectionDir = join(dirPath, collection);
        for (const f of readdirSync(collectionDir)) {
          if (!CONTEXT_FILE_EXTENSIONS.some((ext) => f.endsWith(ext))) continue;
          const stat = statSync(join(collectionDir, f));
          files.push({
            name: `${collection}/${f}`,
            lastModified: stat.mtime.toISOString(),
          });
        }
      }
    }
    // Surface policy capture files under `policies/management-captures/`
    // flattened into the `policies` listing for skill consumers.
    if (dir === "policies") {
      const policiesDir = join(dirPath, "management-captures");
      if (existsSync(policiesDir)) {
        for (const f of readdirSync(policiesDir)) {
          if (!CONTEXT_FILE_EXTENSIONS.some((ext) => f.endsWith(ext))) continue;
          const stat = statSync(join(policiesDir, f));
          files.push({
            name: `management-captures/${f}`,
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
    if (path === "state/today") {
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
