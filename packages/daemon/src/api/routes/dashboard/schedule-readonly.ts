import type { Hono } from "hono";
import type { ApiDependencies } from "../../server.js";

export function registerScheduleReadonlyRoutes(app: Hono, deps: ApiDependencies): void {
  const { db } = deps;

  // ── Schedule API ──

  /** GET /schedule/next — next pending scheduled task */
  app.get("/schedule/next", (c) => {
    const row = db
      .prepare(
        `SELECT id, scheduled_for, task_type, task_description, task_prompt
         FROM agent_schedule
         WHERE status = 'pending' AND scheduled_for > datetime('now')
         ORDER BY scheduled_for ASC LIMIT 1`,
      )
      .get() as
      | {
          id: number;
          scheduled_for: string;
          task_type: string;
          task_description: string;
          task_prompt: string | null;
        }
      | undefined;
    if (!row) return c.json({ next: null });
    // One-off rows make `task_description` an optional label, so it can be
    // empty. Coalesce to a prompt excerpt so the dashboard's "Next Up" card
    // always shows meaningful text. `task_prompt` is not surfaced raw.
    const { task_prompt, ...rest } = row;
    const label =
      rest.task_description && rest.task_description.trim().length > 0
        ? rest.task_description
        : (task_prompt ?? "").slice(0, 200);
    return c.json({ next: { ...rest, task_description: label } });
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
