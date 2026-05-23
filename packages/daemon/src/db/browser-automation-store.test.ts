import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import {
  deleteWorkflowRunsOlderThan,
  getWorkflowRunById,
  insertWorkflowRun,
  isDomainAllowed,
  listAllowlistEntries,
  listRecentWorkflowRuns,
  removeAllowlistEntry,
  upsertAllowlistEntry,
} from "./browser-automation-store.js";
import { applySchema } from "./schema.js";

describe("browser-automation-store", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });
  afterEach(() => db.close());

  describe("workflow runs", () => {
    const makeRow = (overrides: Partial<Parameters<typeof insertWorkflowRun>[1]> = {}) => ({
      workflowId: "11111111-2222-3333-4444-555555555555",
      workflowName: "screenshotPage",
      paramsHash: "a1b2c3d4e5f60718",
      targetUrls: ["https://example.com/"] as readonly string[],
      blockedRequests: [] as readonly string[],
      durationMs: 123,
      outcome: "success" as const,
      startedAt: 1000,
      finishedAt: 1500,
      screenshotPath: "/api/browser-automation/traces/aaa/1-primary.png",
      tracePath: null,
      ...overrides,
    });

    it("insert + list round-trips", () => {
      insertWorkflowRun(db, makeRow());
      const all = listRecentWorkflowRuns(db, 10);
      expect(all).toHaveLength(1);
      expect(all[0].workflowName).toBe("screenshotPage");
      expect(all[0].targetUrls).toEqual(["https://example.com/"]);
    });

    it("listRecentWorkflowRuns caps + sorts by started_at DESC", () => {
      insertWorkflowRun(db, makeRow({ workflowId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", startedAt: 1000 }));
      insertWorkflowRun(db, makeRow({ workflowId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", startedAt: 2000 }));
      insertWorkflowRun(db, makeRow({ workflowId: "cccccccc-cccc-cccc-cccc-cccccccccccc", startedAt: 3000 }));
      const recent = listRecentWorkflowRuns(db, 2);
      expect(recent.map((r) => r.startedAt)).toEqual([3000, 2000]);
    });

    it("clamps limit to [1, 200]", () => {
      insertWorkflowRun(db, makeRow());
      expect(listRecentWorkflowRuns(db, 0)).toHaveLength(1);
      expect(listRecentWorkflowRuns(db, 10_000)).toHaveLength(1);
    });

    it("getWorkflowRunById returns the row or null", () => {
      insertWorkflowRun(db, makeRow());
      const fetched = getWorkflowRunById(db, "11111111-2222-3333-4444-555555555555");
      expect(fetched?.workflowName).toBe("screenshotPage");
      expect(getWorkflowRunById(db, "missing")).toBeNull();
    });

    it("handles corrupt JSON in target_urls / blocked_requests by returning []", () => {
      insertWorkflowRun(db, makeRow());
      db.prepare("UPDATE browser_automation_workflows SET target_urls = ?, blocked_requests = ?")
        .run("not-json", "{}");
      const rows = listRecentWorkflowRuns(db, 5);
      expect(rows[0].targetUrls).toEqual([]);
      expect(rows[0].blockedRequests).toEqual([]);
    });

    it("filters out non-string entries from corrupt array storage", () => {
      insertWorkflowRun(db, makeRow());
      db.prepare("UPDATE browser_automation_workflows SET target_urls = ?")
        .run(JSON.stringify(["ok.com", 42, null]));
      const rows = listRecentWorkflowRuns(db, 5);
      expect(rows[0].targetUrls).toEqual(["ok.com"]);
    });

    it("getWorkflowRunById survives corrupt JSON", () => {
      insertWorkflowRun(db, makeRow());
      db.prepare("UPDATE browser_automation_workflows SET target_urls = ?, blocked_requests = ?")
        .run("not-json", "also-not-json");
      const fetched = getWorkflowRunById(db, "11111111-2222-3333-4444-555555555555");
      expect(fetched?.targetUrls).toEqual([]);
      expect(fetched?.blockedRequests).toEqual([]);
    });

    it("deleteWorkflowRunsOlderThan prunes only stale rows", () => {
      insertWorkflowRun(db, makeRow({ workflowId: "11111111-1111-1111-1111-111111111111", startedAt: 100 }));
      insertWorkflowRun(db, makeRow({ workflowId: "22222222-2222-2222-2222-222222222222", startedAt: 5000 }));
      const deleted = deleteWorkflowRunsOlderThan(db, 1000);
      expect(deleted).toBe(1);
      expect(listRecentWorkflowRuns(db, 10)).toHaveLength(1);
    });

    it("enforces the outcome CHECK constraint via schema", () => {
      expect(() =>
        insertWorkflowRun(db, makeRow({ outcome: "totally-bogus" as unknown as "success" })),
      ).toThrow();
    });
  });

  describe("allowlist", () => {
    it("upsert + list + remove round-trips", () => {
      upsertAllowlistEntry(db, {
        domain: "example.com",
        mode: "read",
        addedAt: 100,
        addedBy: "user",
      });
      let rows = listAllowlistEntries(db);
      expect(rows).toEqual([{ domain: "example.com", mode: "read", addedAt: 100, addedBy: "user" }]);
      const removed = removeAllowlistEntry(db, "example.com");
      expect(removed).toBe(1);
      rows = listAllowlistEntries(db);
      expect(rows).toEqual([]);
    });

    it("removeAllowlistEntry returns 0 for unknown domain", () => {
      expect(removeAllowlistEntry(db, "unknown.com")).toBe(0);
    });

    it("upsert replaces mode on the existing row", () => {
      upsertAllowlistEntry(db, {
        domain: "example.com",
        mode: "read",
        addedAt: 100,
        addedBy: "user",
      });
      upsertAllowlistEntry(db, {
        domain: "example.com",
        mode: "denied",
        addedAt: 200,
        addedBy: "system",
      });
      const rows = listAllowlistEntries(db);
      expect(rows).toEqual([
        { domain: "example.com", mode: "denied", addedAt: 200, addedBy: "system" },
      ]);
    });

    it("isDomainAllowed returns true only for read-mode entries", () => {
      upsertAllowlistEntry(db, {
        domain: "example.com",
        mode: "read",
        addedAt: 100,
        addedBy: "user",
      });
      upsertAllowlistEntry(db, {
        domain: "denied.com",
        mode: "denied",
        addedAt: 100,
        addedBy: "user",
      });
      expect(isDomainAllowed(db, "example.com")).toBe(true);
      expect(isDomainAllowed(db, "denied.com")).toBe(false);
      expect(isDomainAllowed(db, "unknown.com")).toBe(false);
    });

    it("enforces CHECK constraints on mode + added_by", () => {
      expect(() =>
        upsertAllowlistEntry(db, {
          domain: "bad.com",
          mode: "bogus" as unknown as "read",
          addedAt: 1,
          addedBy: "user",
        }),
      ).toThrow();
      expect(() =>
        upsertAllowlistEntry(db, {
          domain: "bad.com",
          mode: "read",
          addedAt: 1,
          addedBy: "agent" as unknown as "user",
        }),
      ).toThrow();
    });
  });
});
