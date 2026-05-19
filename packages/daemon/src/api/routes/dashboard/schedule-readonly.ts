import type { Hono } from "hono";
import type { ApiDependencies } from "../../server.js";

export function registerScheduleReadonlyRoutes(app: Hono, deps: ApiDependencies): void {
  const { db } = deps;

  // ── Schedule API ──

  /** GET /schedule/next — next pending scheduled task */
  app.get("/schedule/next", (c) => {
    const row = db
      .prepare(
        `SELECT id, scheduled_for, task_type, task_description
         FROM agent_schedule
         WHERE status = 'pending' AND scheduled_for > datetime('now')
         ORDER BY scheduled_for ASC LIMIT 1`,
      )
      .get() as { id: number; scheduled_for: string; task_type: string; task_description: string } | undefined;
    return c.json({ next: row ?? null });
  });

  /** GET /schedule/list — all scheduled tasks (paginated) */
  app.get("/schedule/list", (c) => {
    const page = Math.max(1, Number(c.req.query("page") ?? "1"));
    const limit = Math.min(Number(c.req.query("limit") ?? "20"), 50);
    const status = c.req.query("status");
    const type = c.req.query("type");
    const offset = (page - 1) * limit;

    let where = "1=1";
    const params: unknown[] = [];
    if (status) { where += " AND status = ?"; params.push(status); }
    if (type) { where += " AND task_type = ?"; params.push(type); }

    const total = (db
      .prepare(`SELECT COUNT(*) as count FROM agent_schedule WHERE ${where}`)
      .get(...params) as { count: number }).count;

    params.push(limit, offset);
    const schedules = db
      .prepare(
        `SELECT id, scheduled_for, task_type, task_description, task_prompt, model, status, task_context, created_at
         FROM agent_schedule WHERE ${where}
         ORDER BY scheduled_for DESC LIMIT ? OFFSET ?`,
      )
      .all(...params);

    return c.json({
      schedules,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  });
}
