/**
 * Dev-sessions API — the dashboard read projection over the development-mode
 * tables. Two read endpoints:
 *   - GET /dev-sessions[?repository_id=&state=]  → session list (summaries)
 *   - GET /dev-sessions/:id                      → one session + its iteration
 *     timeline, REQ ledger, escalations, and spend rollup.
 *
 * Read-only (no agent chokepoint here — the contract is authored in-process by
 * the interview runner, not POSTed). Both are `Approve` risk (dashboard/Bearer)
 * in `safety/risk-classifier.ts`.
 */

import { Hono } from "hono";
import type { ApiDependencies } from "../server.js";
import {
  getDevSession,
  listDevSessions,
  listDevIterations,
  listDevRequirements,
  countDevRequirements,
  type DevSessionState,
} from "../../db/dev-sessions-store.js";
import { listDevEscalationsForSession } from "../../db/dev-session-escalations-store.js";
import { listDevTasks } from "../../db/dev-session-tasks-store.js";
import { planParallelGroups } from "../../services/dev-mode/task-plan.js";
import { composeIssue, respondWithAgentError } from "../helpers/agent-errors.js";

export type DevSessionsRouteDeps = Pick<ApiDependencies, "db">;

const KNOWN_STATES: ReadonlySet<string> = new Set([
  "interview",
  "awaiting_approval",
  "running",
  "awaiting_user",
  "done",
  "exited",
  "failed",
]);

export function createDevSessionsRoutes(deps: DevSessionsRouteDeps): Hono {
  const { db } = deps;
  const app = new Hono();

  app.get("/dev-sessions", (c) => {
    const repositoryId = c.req.query("repository_id") || undefined;
    const stateParam = c.req.query("state");
    const states = stateParam
      ? (stateParam
          .split(",")
          .map((s) => s.trim())
          .filter((s) => KNOWN_STATES.has(s)) as DevSessionState[])
      : undefined;
    // A `state=` filter that resolves to zero VALID tokens (e.g. `?state=nonsense`)
    // must match nothing — not silently fall through to "no filter" (which the
    // store's `states.length > 0` guard would do), returning every session.
    if (stateParam && (!states || states.length === 0)) {
      return c.json({ sessions: [] });
    }
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
    const rows = listDevSessions(db, { repositoryId, states, limit });
    const sessions = rows.map((row) => {
      const { total, met } = countDevRequirements(db, row.id);
      const tasks = listDevTasks(db, row.id);
      return {
        id: row.id,
        repositoryId: row.repositoryId,
        slug: row.slug,
        state: row.state,
        loopState: row.loopState,
        branch: row.branch,
        iteration: row.iteration,
        requirementsMet: met,
        requirementsTotal: total,
        // Fleet progress (0 tasks = a single-loop or not-yet-decomposed run).
        tasksTotal: tasks.length,
        tasksMerged: tasks.filter((t) => t.state === "merged").length,
        costUsd: row.costUsd,
        maxBudgetUsd: row.maxBudgetUsd,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        exitedAt: row.exitedAt,
      };
    });
    return c.json({ sessions });
  });

  app.get("/dev-sessions/:id", (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const session = getDevSession(db, id);
    if (!session) {
      return respondWithAgentError(c, 404, [
        composeIssue("dev_sessions.not_found", { field: "id", received: id }),
      ]);
    }
    const { total, met } = countDevRequirements(db, id);
    const taskRows = listDevTasks(db, id);
    // Topological layer index per task (the "runs after ↑" grouping the
    // dashboard renders). Derived from the live depends_on edges.
    const layerByKey = new Map<string, number>();
    planParallelGroups(
      taskRows.map((t) => ({
        key: t.taskKey,
        summary: t.summary,
        dependsOn: t.dependsOn,
        scope: t.scope,
        reqs: t.reqs,
        body: t.body,
      })),
    ).forEach((group, layer) => group.forEach((key) => layerByKey.set(key, layer)));
    const tasks = taskRows.map((t) => ({
      id: t.id,
      taskKey: t.taskKey,
      summary: t.summary,
      dependsOn: t.dependsOn,
      reqs: t.reqs,
      origin: t.origin,
      state: t.state,
      loopState: t.loopState,
      branch: t.branch,
      iteration: t.iteration,
      costUsd: t.costUsd,
      failReason: t.failReason,
      group: layerByKey.get(t.taskKey) ?? 0,
      createdAt: t.createdAt,
      mergedAt: t.mergedAt,
    }));
    // Label each iteration with its owning task key so the dashboard flow view
    // can group the timeline by task without a client-side join.
    const taskKeyById = new Map(taskRows.map((t) => [t.id, t.taskKey]));
    const iterations = listDevIterations(db, id).map((it) => ({
      ...it,
      taskKey: it.taskId ? taskKeyById.get(it.taskId) ?? null : null,
    }));
    return c.json({
      session: {
        ...session,
        requirementsMet: met,
        requirementsTotal: total,
      },
      tasks,
      iterations,
      requirements: listDevRequirements(db, id),
      escalations: listDevEscalationsForSession(db, id),
    });
  });

  return app;
}
