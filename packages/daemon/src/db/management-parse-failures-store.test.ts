import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "./schema.js";
import {
  clearManagementParseFailures,
  listManagementParseFailures,
  recordManagementParseFailure,
} from "./management-parse-failures-store.js";

describe("management-parse-failures-store", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("records a failure and returns its row id", () => {
    const id = recordManagementParseFailure(db, {
      section: "B",
      reason: "unknown output_path domain",
      raw: "| mt_99 | … | foo/meetings/ |",
    });
    expect(id).toBeGreaterThan(0);
    const row = db
      .prepare(
        "SELECT section, reason, raw FROM management_parse_failures WHERE id = ?",
      )
      .get(id) as { section: string; reason: string; raw: string };
    expect(row.section).toBe("B");
    expect(row.reason).toBe("unknown output_path domain");
    expect(row.raw).toContain("foo/meetings/");
  });

  it("treats missing optional fields as NULL", () => {
    const id = recordManagementParseFailure(db, {
      reason: "frontmatter missing schema_version",
    });
    const row = db
      .prepare(
        "SELECT section, raw FROM management_parse_failures WHERE id = ?",
      )
      .get(id) as { section: string | null; raw: string | null };
    expect(row.section).toBeNull();
    expect(row.raw).toBeNull();
  });

  it("listManagementParseFailures returns newest first and respects limit", () => {
    recordManagementParseFailure(db, { reason: "first" });
    recordManagementParseFailure(db, { reason: "second" });
    recordManagementParseFailure(db, { reason: "third" });
    const out = listManagementParseFailures(db, 2);
    expect(out.map((r) => r.reason)).toEqual(["third", "second"]);
  });

  it("listManagementParseFailures clamps non-positive limit to 1", () => {
    recordManagementParseFailure(db, { reason: "only" });
    expect(listManagementParseFailures(db, 0)).toHaveLength(1);
    expect(listManagementParseFailures(db, -5)).toHaveLength(1);
  });

  it("clearManagementParseFailures wipes every row and returns the count", () => {
    recordManagementParseFailure(db, { reason: "a" });
    recordManagementParseFailure(db, { reason: "b" });
    expect(clearManagementParseFailures(db)).toBe(2);
    expect(listManagementParseFailures(db)).toEqual([]);
  });
});
