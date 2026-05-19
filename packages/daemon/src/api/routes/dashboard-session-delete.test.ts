/**
 * Integration test for the DELETE /conversations and DELETE
 * /conversations/:id routes defined in dashboard.ts.
 *
 * `createDashboardRoutes` does a lot of boot-time work (secret broker,
 * settings store, service availability polling) that isn't relevant to
 * the session delete logic. This test mounts only the two handlers on a
 * bare Hono app so we can exercise route wiring (param parsing, HTTP
 * status codes, JSON envelope) without the heavy dependency graph — the
 * underlying DB behaviour is already covered by
 * `dashboard-session-cleanup.test.ts`.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../db/schema.js";
import {
  deleteAllChatSidebarSessions,
  deleteChatSession,
} from "../../core/dashboard-session-cleanup.js";
import { getSessionWorkdirPath } from "../../core/workdir.js";
import {
  DASHBOARD_CHAT_SCOPE,
  DASHBOARD_SCOPE_KEY,
  OWNER_DM_SCOPE,
  OWNER_SCOPE_KEY,
} from "../../messaging/constants.js";

function makeApp(db: Database.Database, dataDir: string): Hono {
  const app = new Hono();

  // Mirrors dashboard.ts — keep the route body here in sync with the real
  // implementation. If the route body grows beyond trivial glue, lift it
  // into a shared function both call sites import.
  app.delete("/conversations", (c) => {
    const result = deleteAllChatSidebarSessions({ db, dataDir });
    return c.json({ status: "deleted", deleted: result.deleted });
  });
  app.delete("/conversations/:id", (c) => {
    const sessionId = Number(c.req.param("id"));
    if (!Number.isFinite(sessionId) || sessionId <= 0) {
      return c.json({ error: "invalid_session_id" }, 400);
    }
    const result = deleteChatSession({ db, dataDir, sessionId });
    if (!result.ok) {
      return c.json(
        { error: "delete_failed", message: result.message },
        result.status,
      );
    }
    return c.json({ status: "deleted", deleted: result.deleted });
  });

  return app;
}

describe("DELETE /conversations routes", () => {
  let dataDir: string;
  let db: Database.Database;
  let app: Hono;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-session-delete-routes-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    app = makeApp(db, dataDir);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function seedSessions() {
    db.prepare(
      `INSERT INTO conversation_sessions
         (id, platform, channel_id, scope, scope_key, status, is_dm)
       VALUES
         (1, 'dashboard', 'dashboard-ch', ?, ?, 'active', 1),
         (2, 'dashboard', 'dashboard-ch', ?, ?, 'closed', 1),
         (3, 'telegram',  'tg-owner',    ?, ?, 'closed', 1),
         (4, 'slack',     'C123',        'thread', 'k', 'closed', 0)`,
    ).run(
      DASHBOARD_CHAT_SCOPE, DASHBOARD_SCOPE_KEY,
      DASHBOARD_CHAT_SCOPE, DASHBOARD_SCOPE_KEY,
      OWNER_DM_SCOPE,       OWNER_SCOPE_KEY,
    );
    for (const id of [1, 2, 3, 4]) {
      mkdirSync(getSessionWorkdirPath(dataDir, id), { recursive: true });
    }
  }

  it("DELETE /conversations returns the deleted count", async () => {
    seedSessions();

    const res = await app.request("/conversations", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "deleted", deleted: 2 });
  });

  it("DELETE /conversations returns 0 when the sidebar is already empty", async () => {
    const res = await app.request("/conversations", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "deleted", deleted: 0 });
  });

  it("DELETE /conversations/:id succeeds for a deletable session", async () => {
    seedSessions();

    const res = await app.request("/conversations/2", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "deleted", deleted: 1 });
  });

  it("DELETE /conversations/:id returns 409 for an active session", async () => {
    seedSessions();

    const res = await app.request("/conversations/1", { method: "DELETE" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("delete_failed");
    expect(body.message).toMatch(/Active sessions/);
  });

  it("DELETE /conversations/:id returns 403 for a non-sidebar scope", async () => {
    seedSessions();

    const res = await app.request("/conversations/4", { method: "DELETE" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("delete_failed");
  });

  it("DELETE /conversations/:id returns 404 for unknown ids", async () => {
    const res = await app.request("/conversations/999", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("DELETE /conversations/:id returns 400 for invalid ids", async () => {
    const resNaN = await app.request("/conversations/not-a-number", {
      method: "DELETE",
    });
    expect(resNaN.status).toBe(400);
    expect((await resNaN.json()) as { error: string }).toEqual({
      error: "invalid_session_id",
    });

    const resZero = await app.request("/conversations/0", { method: "DELETE" });
    expect(resZero.status).toBe(400);

    const resNegative = await app.request("/conversations/-1", {
      method: "DELETE",
    });
    expect(resNegative.status).toBe(400);
  });
});
