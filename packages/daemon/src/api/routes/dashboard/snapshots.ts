import type { Hono } from "hono";
import type { ApiDependencies } from "../../server.js";

export function registerSnapshotsRoutes(app: Hono, deps: ApiDependencies): void {
  const { db } = deps;

  // ── Snapshots API ──

  /** GET /snapshots/content/:id — single snapshot content */
  app.get("/snapshots/content/:id", (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isSafeInteger(id) || id <= 0) {
      return c.json({ error: "invalid id" }, 400);
    }
    const row = db
      .prepare(
        "SELECT id, file_path, content, trigger, created_at FROM md_file_snapshots WHERE id = ?",
      )
      .get(id);
    if (!row) return c.json({ error: "not_found" }, 404);
    return c.json(row);
  });

  /** GET /snapshots/* — snapshot history for a context file */
  app.get("/snapshots/*", (c) => {
    const filePath = c.req.path.replace("/api/snapshots/", "");

    // Validate: reject path traversal and unsafe characters
    if (!filePath || /\.\./.test(filePath) || !/^[\w./-]+$/.test(filePath)) {
      return c.json({ error: "invalid file path" }, 400);
    }

    const limit = Math.min(Number(c.req.query("limit") ?? "20"), 50);
    const rows = db
      .prepare(
        `SELECT id, file_path, trigger, session_id, created_at
         FROM md_file_snapshots WHERE file_path = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(filePath, limit);
    return c.json({ snapshots: rows });
  });
}
