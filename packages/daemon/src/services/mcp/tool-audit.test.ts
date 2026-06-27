import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { logMcpToolCall, updateMcpToolCallResult, listMcpToolCalls, pruneOldMcpToolCalls } from "./tool-audit.js";

function setupSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE mcp_tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      event_type TEXT,
      session_id TEXT,
      ok INTEGER,
      error TEXT,
      called_at INTEGER NOT NULL,
      duration_ms INTEGER
    );
    CREATE INDEX idx_mcp_tool_calls_server
      ON mcp_tool_calls(server_id, called_at DESC);
  `);
}

describe("tool-audit", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    setupSchema(db);
  });

  describe("logMcpToolCall", () => {
    it("inserts a row and returns the new row id", () => {
      const id = logMcpToolCall(db, { serverId: "monday", toolName: "create_item" });
      expect(id).toBeGreaterThan(0);
      const rows = db
        .prepare("SELECT * FROM mcp_tool_calls WHERE id = ?")
        .all(id) as { server_id: string; tool_name: string; ok: null }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].server_id).toBe("monday");
      expect(rows[0].tool_name).toBe("create_item");
      expect(rows[0].ok).toBeNull();
    });

    it("returns incrementing ids for successive inserts", () => {
      const id1 = logMcpToolCall(db, { serverId: "a", toolName: "t1" });
      const id2 = logMcpToolCall(db, { serverId: "a", toolName: "t2" });
      expect(id2).toBeGreaterThan(id1);
    });

    it("stores optional eventType and sessionId", () => {
      logMcpToolCall(db, {
        serverId: "ha",
        toolName: "turn_on",
        eventType: "routine.activity_scan",
        sessionId: "sess-abc",
      });
      const row = db
        .prepare("SELECT event_type, session_id FROM mcp_tool_calls WHERE server_id = 'ha'")
        .get() as { event_type: string; session_id: string };
      expect(row.event_type).toBe("routine.activity_scan");
      expect(row.session_id).toBe("sess-abc");
    });

    it("stores called_at as a positive integer (ms epoch)", () => {
      const before = Date.now();
      logMcpToolCall(db, { serverId: "x", toolName: "y" });
      const after = Date.now();
      const row = db
        .prepare("SELECT called_at FROM mcp_tool_calls WHERE server_id = 'x'")
        .get() as { called_at: number };
      expect(row.called_at).toBeGreaterThanOrEqual(before);
      expect(row.called_at).toBeLessThanOrEqual(after);
    });
  });

  describe("updateMcpToolCallResult", () => {
    it("sets ok=true, clears error, and stores durationMs", () => {
      const rowId = logMcpToolCall(db, { serverId: "mon", toolName: "create_item" });
      updateMcpToolCallResult(db, rowId, true, null, 123);
      const row = db
        .prepare("SELECT ok, error, duration_ms FROM mcp_tool_calls WHERE id = ?")
        .get(rowId) as { ok: number; error: null; duration_ms: number };
      expect(row.ok).toBe(1);
      expect(row.error).toBeNull();
      expect(row.duration_ms).toBe(123);
    });

    it("sets ok=false and stores error message", () => {
      const rowId = logMcpToolCall(db, { serverId: "ha", toolName: "turn_on" });
      updateMcpToolCallResult(db, rowId, false, "connection refused", 450);
      const row = db
        .prepare("SELECT ok, error, duration_ms FROM mcp_tool_calls WHERE id = ?")
        .get(rowId) as { ok: number; error: string; duration_ms: number };
      expect(row.ok).toBe(0);
      expect(row.error).toBe("connection refused");
      expect(row.duration_ms).toBe(450);
    });

    it("omitting durationMs leaves duration_ms as NULL", () => {
      const rowId = logMcpToolCall(db, { serverId: "s", toolName: "t" });
      updateMcpToolCallResult(db, rowId, true, null);
      const row = db
        .prepare("SELECT duration_ms FROM mcp_tool_calls WHERE id = ?")
        .get(rowId) as { duration_ms: null };
      expect(row.duration_ms).toBeNull();
    });

    it("unknown rowId is a no-op (no error thrown)", () => {
      expect(() => updateMcpToolCallResult(db, 99999, true, null, 10)).not.toThrow();
    });
  });

  describe("listMcpToolCalls", () => {
    it("returns empty array when no calls exist", () => {
      expect(listMcpToolCalls(db, "monday")).toEqual([]);
    });

    it("returns calls for the matching server, newest first", () => {
      db.prepare(
        "INSERT INTO mcp_tool_calls (server_id, tool_name, event_type, session_id, ok, error, called_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("monday", "search_items", "message.received.dm", null, null, null, 1000, null);
      db.prepare(
        "INSERT INTO mcp_tool_calls (server_id, tool_name, event_type, session_id, ok, error, called_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("monday", "create_item", null, "s1", null, null, 2000, null);

      const calls = listMcpToolCalls(db, "monday");
      expect(calls).toHaveLength(2);
      expect(calls[0].toolName).toBe("create_item");
      expect(calls[0].calledAt).toBe(2000);
      expect(calls[1].toolName).toBe("search_items");
    });

    it("does not return calls for other servers", () => {
      db.prepare(
        "INSERT INTO mcp_tool_calls (server_id, tool_name, event_type, session_id, ok, error, called_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("ha", "turn_on", null, null, null, null, 1000, null);

      expect(listMcpToolCalls(db, "monday")).toEqual([]);
    });

    it("respects the limit parameter", () => {
      for (let i = 0; i < 5; i++) {
        db.prepare(
          "INSERT INTO mcp_tool_calls (server_id, tool_name, event_type, session_id, ok, error, called_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run("monday", "tool", null, null, null, null, i * 1000, null);
      }
      const calls = listMcpToolCalls(db, "monday", 3);
      expect(calls).toHaveLength(3);
    });

    it("maps ok integer to boolean or null correctly", () => {
      db.prepare(
        "INSERT INTO mcp_tool_calls (server_id, tool_name, event_type, session_id, ok, error, called_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("s", "t1", null, null, 1, null, 3000, 99);
      db.prepare(
        "INSERT INTO mcp_tool_calls (server_id, tool_name, event_type, session_id, ok, error, called_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("s", "t2", null, null, 0, "oops", 2000, 200);
      db.prepare(
        "INSERT INTO mcp_tool_calls (server_id, tool_name, event_type, session_id, ok, error, called_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("s", "t3", null, null, null, null, 1000, null);

      const calls = listMcpToolCalls(db, "s");
      expect(calls[0].ok).toBe(true);
      expect(calls[0].durationMs).toBe(99);
      expect(calls[1].ok).toBe(false);
      expect(calls[1].error).toBe("oops");
      expect(calls[1].durationMs).toBe(200);
      expect(calls[2].ok).toBeNull();
      expect(calls[2].durationMs).toBeNull();
    });

    it("maps row fields to camelCase including durationMs", () => {
      db.prepare(
        "INSERT INTO mcp_tool_calls (server_id, tool_name, event_type, session_id, ok, error, called_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("srv", "do_thing", "routine.morning_routine", "ses-1", 1, null, 5000, 77);
      const [call] = listMcpToolCalls(db, "srv");
      expect(call.serverId).toBe("srv");
      expect(call.toolName).toBe("do_thing");
      expect(call.eventType).toBe("routine.morning_routine");
      expect(call.sessionId).toBe("ses-1");
      expect(call.calledAt).toBe(5000);
      expect(call.durationMs).toBe(77);
      expect(typeof call.id).toBe("number");
    });

    it("returns empty array when mcp_tool_calls table does not exist", () => {
      const emptyDb = new Database(":memory:");
      // No schema — simulates a pre-migration DB
      expect(listMcpToolCalls(emptyDb, "any-server")).toEqual([]);
    });
  });

  describe("pruneOldMcpToolCalls", () => {
    it("returns 0 when table does not exist (pre-migration DB)", () => {
      const emptyDb = new Database(":memory:");
      expect(pruneOldMcpToolCalls(emptyDb, 30)).toBe(0);
    });

    it("deletes rows older than the threshold and returns count", () => {
      const old = Date.now() - 40 * 24 * 60 * 60 * 1000; // 40 days ago
      const recent = Date.now() - 1 * 24 * 60 * 60 * 1000; // 1 day ago
      db.prepare(
        "INSERT INTO mcp_tool_calls (server_id, tool_name, event_type, session_id, ok, error, called_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("srv", "old_tool", null, null, null, null, old, null);
      db.prepare(
        "INSERT INTO mcp_tool_calls (server_id, tool_name, event_type, session_id, ok, error, called_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("srv", "recent_tool", null, null, null, null, recent, null);

      const deleted = pruneOldMcpToolCalls(db, 30);
      expect(deleted).toBe(1);
      const remaining = listMcpToolCalls(db, "srv");
      expect(remaining).toHaveLength(1);
      expect(remaining[0].toolName).toBe("recent_tool");
    });

    it("returns 0 when no rows are older than the threshold", () => {
      const recent = Date.now() - 5 * 24 * 60 * 60 * 1000;
      db.prepare(
        "INSERT INTO mcp_tool_calls (server_id, tool_name, event_type, session_id, ok, error, called_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("srv", "tool", null, null, null, null, recent, null);
      expect(pruneOldMcpToolCalls(db, 30)).toBe(0);
    });

    it("returns 0 on empty table", () => {
      expect(pruneOldMcpToolCalls(db, 30)).toBe(0);
    });
  });
});
