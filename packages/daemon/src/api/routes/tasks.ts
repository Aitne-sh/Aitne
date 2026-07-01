/**
 * Unified Task Board API — `/api/tasks` (docs/design/appendices/unified-task-board.md).
 *
 * L0 (read-only board, §5.2): `GET /tasks` (inventory) + `GET /tasks/impact`
 * (blast-radius), both **computed on demand** by JOINing the cross-refs that
 * already exist (§2.4) — zero schema change, zero maintained mirror, no
 * always-on context block.
 *
 * L1 (write facade, §5.3): `POST/PATCH/DELETE /tasks[/:ref]` route by `kind` /
 * ref-prefix to the existing hardened owner endpoints via an in-process
 * re-dispatch through the top-level app (`deps.dispatch`), so every owner's
 * dedup / FK-cascade / 410-split / auth-tier still applies unchanged. The
 * routing decisions (the §9 guards) live in the pure `dispatch.ts` planner; this
 * file is the thin DB-read + forward glue (excluded from the coverage gate, with
 * a peer `tasks.test.ts` pinning the happy + main error paths).
 */

import { Hono } from "hono";
import type Database from "better-sqlite3";
import { listRecurringSchedules } from "../../db/recurring-schedules.js";
import { listAgents } from "../../db/agents-store.js";
import { listManagedTasks } from "../../db/managed-tasks-store.js";
import {
  listBackgroundTasks,
  BACKGROUND_TASK_NON_TERMINAL_STATES,
} from "../../db/background-task-store.js";
import {
  listBrowserTasks,
  BROWSER_TASK_NON_TERMINAL_STATES,
} from "../../db/browser-task-store.js";
import { listTriggers } from "../../db/automation-triggers.js";
import { listBrowserResearchClusters } from "../../db/browser-history-store.js";
import {
  assembleInventory,
  type InventorySources,
  type PendingOneOff,
} from "../../core/task-board/inventory.js";
import {
  computeImpact,
  IMPACT_SOURCE_KEYS,
  type ImpactSources,
} from "../../core/task-board/impact.js";
import { parseTaskRef } from "../../core/task-board/refs.js";
import type { TaskRef } from "../../core/task-board/types.js";
import type { RecurringScheduleDTO } from "../../db/recurring-schedules.js";
import {
  planCreateDispatch,
  planRefDispatch,
  FACADE_CREATE_KINDS,
  type FacadeCreateKind,
} from "../../core/task-board/dispatch.js";

/** Dependencies the tasks routes need. */
export interface TasksRoutesDeps {
  db: Database.Database;
  /**
   * L1 only — re-dispatch a Request through the top-level app so the owner
   * route's full middleware (auth tier, host/browser gate, dedup, cascade)
   * runs. Built in `server.ts` as `(req) => app.fetch(req)`. When omitted, the
   * write facade returns 501 (read-only deployment).
   */
  dispatch?: (req: Request) => Response | Promise<Response>;
}

interface PendingOneOffRow {
  id: number;
  scheduled_for: string;
  task_type: string;
  task_description: string | null;
  task_prompt: string | null;
  task_context: string | null;
}

interface OccurrenceRow {
  id: number;
  recurring_schedule_id: number | null;
}

function parseCtx(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function buildInventorySources(db: Database.Database): InventorySources {
  const allRecurring = listRecurringSchedules(db);
  const recurringById = new Map(allRecurring.map((r) => [r.id, r]));
  const pendingRows = db
    .prepare(
      `SELECT id, scheduled_for, task_type, task_description, task_prompt, task_context
         FROM agent_schedule
        WHERE status = 'pending' AND recurring_schedule_id IS NULL
        ORDER BY scheduled_for ASC`,
    )
    .all() as PendingOneOffRow[];
  const pendingOneOffs: PendingOneOff[] = pendingRows.map((r) => ({
    id: r.id,
    scheduledFor: r.scheduled_for,
    taskType: r.task_type,
    taskDescription: r.task_description,
    taskPrompt: r.task_prompt,
    taskContext: parseCtx(r.task_context),
  }));
  return {
    recurringDmSessions: allRecurring.filter((r) => r.taskType === "dm_session"),
    // ALL agents (built-in + user). The board is the single inventory of
    // everything in motion, so built-ins are surfaced read-only (origin:system);
    // any write still hits the owner's built-in guards (409-undeletable /
    // stop-warning ack). Symmetric with buildImpactSources' agent resolver.
    agents: listAgents(db),
    managedTasks: listManagedTasks(db),
    recurringById,
    pendingOneOffs,
    backgroundTasks: listBackgroundTasks(db, {
      states: [...BACKGROUND_TASK_NON_TERMINAL_STATES],
    }),
    browserTasks: listBrowserTasks(db, { states: [...BROWSER_TASK_NON_TERMINAL_STATES] }),
    researchClusters: listBrowserResearchClusters(db).clusters.map((c) => ({
      slug: c.slug,
      displayName: c.displayName,
      status: c.status,
      lastActivityAt: c.lastActivityAt ?? null,
    })),
  };
}

/**
 * Build ONLY the impact sources the target `ref` actually needs, per
 * `IMPACT_SOURCE_KEYS` (the source-of-truth co-located with `computeImpact`,
 * drift-guarded in `impact.test.ts`). A blast-radius query is per-ref, so an
 * `rs:`/`agent:`/`mt:` lookup must not scan the fulfiller tables and a
 * `bt:`/`bx:`/`cluster:` existence check must not scan the whole schedule
 * spine. Fields outside the ref's declared set stay empty — and the drift guard
 * proves `computeImpact` never reads them for that prefix.
 */
function buildImpactSources(db: Database.Database, ref: TaskRef): ImpactSources {
  const need = new Set<keyof ImpactSources>(IMPACT_SOURCE_KEYS[ref.prefix]);
  const occurrenceRows = need.has("pendingOccurrences")
    ? (db
        .prepare(`SELECT id, recurring_schedule_id FROM agent_schedule WHERE status = 'pending'`)
        .all() as OccurrenceRow[])
    : [];
  return {
    recurringById: need.has("recurringById")
      ? new Map(listRecurringSchedules(db).map((r) => [r.id, r]))
      : new Map<number, RecurringScheduleDTO>(),
    managedTasks: need.has("managedTasks") ? listManagedTasks(db) : [],
    // ALL agents (incl. builtins) — a delete preview must surface any agent
    // that references the schedule, not just user-created ones.
    agents: need.has("agents") ? listAgents(db) : [],
    automationTriggers: need.has("automationTriggers") ? listTriggers(db) : [],
    pendingOccurrences: occurrenceRows.map((r) => ({
      id: r.id,
      recurringScheduleId: r.recurring_schedule_id ?? null,
    })),
    backgroundTaskIds: need.has("backgroundTaskIds")
      ? new Set(
          listBackgroundTasks(db, { states: [...BACKGROUND_TASK_NON_TERMINAL_STATES] }).map((t) => t.id),
        )
      : new Set<string>(),
    browserTaskIds: need.has("browserTaskIds")
      ? new Set(
          listBrowserTasks(db, { states: [...BROWSER_TASK_NON_TERMINAL_STATES] }).map((t) => t.id),
        )
      : new Set<string>(),
    researchClusterSlugs: need.has("researchClusterSlugs")
      ? new Set(listBrowserResearchClusters(db).clusters.map((c) => c.slug))
      : new Set<string>(),
  };
}

const REF_HINT =
  "Expected <prefix>:<id> with prefix in rs|mt|agent|as|cluster|bt|bx|obj (managed tasks use mt_<n>).";

export function createTasksRoutes(deps: TasksRoutesDeps): Hono {
  const app = new Hono();
  const { db } = deps;

  // ── L0 — read-only board (computed on demand) ──

  app.get("/tasks", (c) => {
    const items = assembleInventory(buildInventorySources(db));
    return c.json({ items, total: items.length, generatedAt: new Date().toISOString() });
  });

  app.get("/tasks/impact", (c) => {
    const raw = c.req.query("ref");
    if (!raw) {
      return c.json(
        { error: "ref_required", message: "Query param `ref` is required, e.g. ?ref=rs:42." },
        400,
      );
    }
    const ref = parseTaskRef(raw);
    if (!ref) {
      return c.json({ error: "ref_invalid", message: `Unrecognised task ref "${raw}". ${REF_HINT}` }, 400);
    }
    return c.json(computeImpact(ref, buildImpactSources(db, ref)));
  });

  // ── L1 — unified write facade (routes to the hardened owners) ──

  /** Forward a planned dispatch through the top-level app, preserving auth. */
  async function forward(
    c: import("hono").Context,
    method: string,
    ownerPath: string,
    body: unknown | undefined,
    extra: { kind?: string },
  ): Promise<Response> {
    // Defensive only (audit C9): `server.ts` always supplies `dispatch`, so this
    // 501 is unreachable in production. It stays as a guard for a standalone
    // `createTasksRoutes({ db })` (e.g. the read-only board in a test) that
    // routes a write — better a clear 501 than a null-deref.
    if (!deps.dispatch) {
      return c.json(
        { error: "facade_unavailable", message: "The task write facade is not enabled on this daemon." },
        501,
      );
    }
    const url = new URL(c.req.url);
    url.pathname = ownerPath;
    // Preserve the caller's query string on the forwarded request. No facade-
    // routed WRITE owner reads a query param today (every `c.req.query` hit is
    // a GET/list handler), but forwarding it keeps a future query-reading write
    // owner from being silently starved (audit B3). The pathname swap above is
    // the only rewrite the owner route needs.
    // Forward the caller's headers verbatim so the owner route re-applies the
    // exact same auth tier / host gate against the same credentials. Drop the
    // caller's `content-length`: the forwarded body is re-serialized (POST
    // strips `kind`, so its byte length differs from the inbound `/api/tasks`
    // body) and the Request constructor recomputes it from `init.body`.
    const headers = new Headers(c.req.raw.headers);
    headers.delete("content-length");
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers.set("content-type", "application/json");
      init.body = JSON.stringify(body);
    }
    const ownerRes = await deps.dispatch(new Request(url.toString(), init));
    const text = await ownerRes.text();
    let result: unknown;
    try {
      result = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      result = text;
    }
    // One consistent envelope (§5.3): the owner's status is preserved, its body
    // is nested under `result`, and the dispatch target is surfaced.
    return c.json(
      { ok: ownerRes.ok, dispatchedTo: ownerPath, kind: extra.kind, result },
      ownerRes.status as never,
    );
  }

  app.post("/tasks", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json_body", message: "Request body must be valid JSON." }, 400);
    }
    const kind = (body as { kind?: unknown } | null)?.kind;
    if (typeof kind !== "string" || !FACADE_CREATE_KINDS.includes(kind as FacadeCreateKind)) {
      return c.json(
        {
          error: "kind_invalid",
          message: `\`kind\` must be one of ${FACADE_CREATE_KINDS.join(", ")}.`,
        },
        400,
      );
    }
    const plan = planCreateDispatch(kind as FacadeCreateKind, body as Record<string, unknown>);
    return forward(c, "POST", plan.ownerPath, plan.body, { kind });
  });

  app.patch("/tasks/:ref", async (c) => {
    const ref = parseTaskRef(c.req.param("ref"));
    if (!ref) {
      return c.json({ error: "ref_invalid", message: `Unrecognised task ref. ${REF_HINT}` }, 400);
    }
    const plan = planRefDispatch(ref);
    if (!plan.editable) {
      return c.json({ error: "ref_not_editable", message: plan.reason }, 422);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json_body", message: "Request body must be valid JSON." }, 400);
    }
    return forward(c, "PATCH", plan.ownerPath, body, { kind: ref.prefix });
  });

  app.delete("/tasks/:ref", async (c) => {
    const ref = parseTaskRef(c.req.param("ref"));
    if (!ref) {
      return c.json({ error: "ref_invalid", message: `Unrecognised task ref. ${REF_HINT}` }, 400);
    }
    const plan = planRefDispatch(ref);
    if (!plan.editable) {
      return c.json({ error: "ref_not_deletable", message: plan.reason }, 422);
    }
    // Forward the caller's DELETE body so a `{keep_history:false}` hard-delete
    // reaches the agent owner — without this the facade always disabled (never
    // hard-deleted) a user Agent (audit A2). An ABSENT body → `undefined`, which
    // `forward()` omits, preserving current behaviour for the rs/mt/as owners
    // (they read the path id only). A PRESENT but malformed body is a 400,
    // matching the PATCH handler rather than silently soft-disabling.
    const rawBody = await c.req.text();
    let body: unknown;
    if (rawBody.trim().length > 0) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        return c.json({ error: "invalid_json_body", message: "Request body must be valid JSON." }, 400);
      }
    }
    return forward(c, "DELETE", plan.ownerPath, body, { kind: ref.prefix });
  });

  return app;
}
