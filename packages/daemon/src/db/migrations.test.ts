import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import {
  MIGRATIONS,
  columnExists,
  indexExists,
  runMigrations,
  tableExists,
  type Migration,
} from "./migrations.js";

function openDb(): Database.Database {
  return new Database(":memory:");
}

describe("runMigrations", () => {
  it("creates schema_migrations table and applies nothing when the list is empty", () => {
    const db = openDb();
    const result = runMigrations(db, []);
    expect(result.applied).toEqual([]);
    expect(tableExists(db, "schema_migrations")).toBe(true);
  });

  it("applies a pending migration once and records it", () => {
    const db = openDb();
    let upCalls = 0;
    const migration: Migration = {
      id: "0001-test",
      description: "Creates a test table",
      up(target) {
        upCalls += 1;
        target.exec(
          "CREATE TABLE test_thing (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
        );
      },
    };
    const first = runMigrations(db, [migration]);
    expect(first.applied).toEqual(["0001-test"]);
    expect(upCalls).toBe(1);
    expect(tableExists(db, "test_thing")).toBe(true);

    const recorded = db
      .prepare<[], { id: string; applied_at: string }>(
        "SELECT id, applied_at FROM schema_migrations",
      )
      .all();
    expect(recorded).toHaveLength(1);
    expect(recorded[0].id).toBe("0001-test");
    expect(recorded[0].applied_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const second = runMigrations(db, [migration]);
    expect(second.applied).toEqual([]);
    expect(upCalls).toBe(1);
  });

  it("applies multiple migrations in array order", () => {
    const db = openDb();
    const order: string[] = [];
    const a: Migration = {
      id: "0001-a",
      description: "First",
      up() {
        order.push("a");
      },
    };
    const b: Migration = {
      id: "0002-b",
      description: "Second",
      up() {
        order.push("b");
      },
    };
    const result = runMigrations(db, [a, b]);
    expect(result.applied).toEqual(["0001-a", "0002-b"]);
    expect(order).toEqual(["a", "b"]);
  });

  it("rolls back a failing migration and rethrows, without recording it", () => {
    const db = openDb();
    const failing: Migration = {
      id: "0001-bad",
      description: "Throws inside up",
      up(target) {
        target.exec("CREATE TABLE partial (id INTEGER PRIMARY KEY)");
        throw new Error("boom");
      },
    };
    expect(() => runMigrations(db, [failing])).toThrow(/boom/);
    expect(tableExists(db, "partial")).toBe(false);
    const recorded = db
      .prepare<[], { id: string }>("SELECT id FROM schema_migrations")
      .all();
    expect(recorded).toEqual([]);
  });

  it("uses the production MIGRATIONS list when no override is passed", () => {
    const db = openDb();
    const result = runMigrations(db);
    expect(result.applied).toEqual([...MIGRATIONS].map((m) => m.id));
  });
});

describe("schema introspection helpers", () => {
  it("tableExists returns true for an existing table and false otherwise", () => {
    const db = openDb();
    db.exec("CREATE TABLE present (id INTEGER PRIMARY KEY)");
    expect(tableExists(db, "present")).toBe(true);
    expect(tableExists(db, "missing")).toBe(false);
  });

  it("columnExists returns true only when both table and column are present", () => {
    const db = openDb();
    db.exec("CREATE TABLE things (id INTEGER PRIMARY KEY, name TEXT)");
    expect(columnExists(db, "things", "name")).toBe(true);
    expect(columnExists(db, "things", "missing")).toBe(false);
    expect(columnExists(db, "no_such_table", "name")).toBe(false);
  });

  it("columnExists rejects identifiers that are not plain SQL names", () => {
    const db = openDb();
    db.exec("CREATE TABLE safe (id INTEGER PRIMARY KEY)");
    expect(() => columnExists(db, "safe; DROP TABLE safe; --", "id")).toThrow(
      /Invalid SQL identifier/,
    );
  });

  it("indexExists returns true only for an existing index", () => {
    const db = openDb();
    db.exec("CREATE TABLE rows (id INTEGER PRIMARY KEY, value TEXT)");
    db.exec("CREATE INDEX idx_rows_value ON rows(value)");
    expect(indexExists(db, "idx_rows_value")).toBe(true);
    expect(indexExists(db, "idx_missing")).toBe(false);
  });
});
