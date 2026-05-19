import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "./schema.js";
import { isWikiEnabled } from "./wiki-store.js";

function seedWorkspace(
  db: Database.Database,
  opts: { name: string; active: 0 | 1 },
): void {
  db.prepare(
    `INSERT INTO wiki_workspaces (
       name, kind, root_path, language, dispatch_mode, concurrency_cap,
       dm_agent_write_enabled, bridge_enabled, bridge_measurement_only,
       bridge_min_confidence, full_compile_approval_threshold_usd,
       write_strategy, git_pre_compile_enabled, schema_version, active
     ) VALUES (?, 'internal', '/tmp/wiki', 'en', 'parallel', 3,
               0, 0, 1, 0.7, 2.0, 'fs', 1, 1, ?)`,
  ).run(opts.name, opts.active);
}

describe("isWikiEnabled", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns false when no workspaces exist", () => {
    expect(isWikiEnabled(db)).toBe(false);
  });

  it("returns false when every workspace is inactive", () => {
    seedWorkspace(db, { name: "default", active: 0 });
    seedWorkspace(db, { name: "archive", active: 0 });
    expect(isWikiEnabled(db)).toBe(false);
  });

  it("returns true when at least one workspace is active", () => {
    seedWorkspace(db, { name: "default", active: 1 });
    expect(isWikiEnabled(db)).toBe(true);
  });

  it("returns true when a mix of active and inactive workspaces exists", () => {
    seedWorkspace(db, { name: "archive", active: 0 });
    seedWorkspace(db, { name: "default", active: 1 });
    expect(isWikiEnabled(db)).toBe(true);
  });
});
