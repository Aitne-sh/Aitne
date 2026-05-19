/**
 * Tests for the Phase 2 DB path rewrite utility.
 * Pure value-space checks plus a minimal in-memory DB round-trip.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { rewriteJsonPaths, rewritePathsInDb } from "./path-rewrite.js";

describe("rewriteJsonPaths", () => {
  it("leaves non-string values alone", () => {
    const input = { n: 1, b: true, arr: [1, 2] };
    const { value, changed } = rewriteJsonPaths(input, "/a", "/b");
    expect(changed).toBe(false);
    expect(value).toBe(input);
  });

  it("rewrites an exact match", () => {
    const { value, changed } = rewriteJsonPaths("/old/vault", "/old/vault", "/new/place");
    expect(changed).toBe(true);
    expect(value).toBe("/new/place");
  });

  it("rewrites a prefix with boundary", () => {
    const { value, changed } = rewriteJsonPaths(
      "/old/vault/today.md",
      "/old/vault",
      "/new/place",
    );
    expect(changed).toBe(true);
    expect(value).toBe("/new/place/today.md");
  });

  it("does not rewrite a superstring that isn't segment-aligned", () => {
    // `/old/vaultaneous` must NOT become `/new/placeaneous`.
    const { value, changed } = rewriteJsonPaths(
      "/old/vaultaneous/file.md",
      "/old/vault",
      "/new/place",
    );
    expect(changed).toBe(false);
    expect(value).toBe("/old/vaultaneous/file.md");
  });

  it("rewrites Windows paths with backslash separators", () => {
    const { value, changed } = rewriteJsonPaths(
      "C:\\Users\\me\\OldVault\\today.md",
      "C:\\Users\\me\\OldVault",
      "D:\\Agent\\NewVault",
    );
    expect(changed).toBe(true);
    expect(value).toBe("D:\\Agent\\NewVault\\today.md");
  });

  it("rewrites Windows paths case-insensitively using the new prefix separator style", () => {
    const { value, changed } = rewriteJsonPaths(
      "c:/users/me/oldvault/projects/a.md",
      "C:\\Users\\me\\OldVault",
      "D:\\Agent\\NewVault",
    );
    expect(changed).toBe(true);
    expect(value).toBe("D:\\Agent\\NewVault\\projects\\a.md");
  });

  it("does not rewrite Windows paths on a different drive", () => {
    const { value, changed } = rewriteJsonPaths(
      "E:\\Users\\me\\OldVault\\today.md",
      "C:\\Users\\me\\OldVault",
      "D:\\Agent\\NewVault",
    );
    expect(changed).toBe(false);
    expect(value).toBe("E:\\Users\\me\\OldVault\\today.md");
  });

  it("walks nested arrays and objects", () => {
    const input = {
      paths: ["/old/a.md", "/old/sub/b.md", "/elsewhere/c.md"],
      meta: { source: "/old", unrelated: null, nested: { out: "/old/x.md" } },
    };
    const { value, changed } = rewriteJsonPaths(input, "/old", "/new");
    expect(changed).toBe(true);
    expect(value).toEqual({
      paths: ["/new/a.md", "/new/sub/b.md", "/elsewhere/c.md"],
      meta: { source: "/new", unrelated: null, nested: { out: "/new/x.md" } },
    });
  });

  it("is stable when no strings match", () => {
    const input = { k: "/elsewhere/file.md" };
    const { value, changed } = rewriteJsonPaths(input, "/old", "/new");
    expect(changed).toBe(false);
    expect(value).toBe(input);
  });

  it("collapses a trailing-slash-only suffix to bare newPrefix", () => {
    // node = oldPrefix + "/" → after slicing + stripping leading
    // separators the remainder is "". Hits the `trimmedRemainder ? … :
    // newPrefix` false branch (otherwise we'd emit `/new/` with a stray
    // trailing slash).
    const { value, changed } = rewriteJsonPaths("/old/", "/old", "/new");
    expect(changed).toBe(true);
    expect(value).toBe("/new");
  });

  it("rewrites to a Windows drive (newPrefix matches root regex; flavor default)", () => {
    // newPrefix = "C:" matches `/^[A-Za-z]:[\\/]?$/` so
    // trimPathRewriteSeparators short-circuits via the first regex of
    // the `??` chain (line 127 left). "C:" has no `\` or `/`, so
    // separatorForNewPrefix falls through to the `flavor === "win32" ?
    // "\\" : "/"` ternary (win32 side, since oldPrefix has `\`).
    const { value, changed } = rewriteJsonPaths(
      "C:\\Users\\old\\today.md",
      "C:\\Users\\old",
      "C:",
    );
    expect(changed).toBe(true);
    expect(value).toBe("C:\\today.md");
  });

  it("falls back to flavor default when newPrefix has no separators (posix)", () => {
    // Bare-name old/new with a `/`-separated child node: newPrefix has
    // no `\` and no `/`, so separatorForNewPrefix falls through to the
    // `flavor === "win32" ? "\\" : "/"` ternary (posix side here).
    const { value, changed } = rewriteJsonPaths("old/child", "old", "new");
    expect(changed).toBe(true);
    expect(value).toBe("new/child");
  });
});

describe("rewritePathsInDb", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE agent_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        detail TEXT
      );
      CREATE TABLE observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payload TEXT
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        metadata TEXT
      );
    `);
  });

  afterEach(() => {
    db.close();
  });

  it("rewrites matching prefixes across all tables in a single transaction", () => {
    db.prepare("INSERT INTO agent_actions (detail) VALUES (?)").run(
      JSON.stringify({ file: "/old/today.md", unrelated: 1 }),
    );
    db.prepare("INSERT INTO observations (payload) VALUES (?)").run(
      JSON.stringify({ path: "/old/notes/a.md" }),
    );
    db.prepare("INSERT INTO messages (metadata) VALUES (?)").run(
      JSON.stringify({ workdir: "/elsewhere/foo" }),
    );

    const stats = rewritePathsInDb(db, "/old", "/new");
    expect(stats.rowsRewritten).toBe(2);
    expect(stats.rowsUnchanged).toBe(1);

    const aa = db.prepare("SELECT detail FROM agent_actions").get() as { detail: string };
    expect(JSON.parse(aa.detail).file).toBe("/new/today.md");
    const ob = db.prepare("SELECT payload FROM observations").get() as { payload: string };
    expect(JSON.parse(ob.payload).path).toBe("/new/notes/a.md");
    const msg = db.prepare("SELECT metadata FROM messages").get() as { metadata: string };
    expect(JSON.parse(msg.metadata).workdir).toBe("/elsewhere/foo");
  });

  it("counts unparseable JSON and leaves it untouched", () => {
    db.prepare("INSERT INTO agent_actions (detail) VALUES (?)").run("not valid json");
    const stats = rewritePathsInDb(db, "/old", "/new");
    expect(stats.rowsUnparseable).toBe(1);
    const row = db.prepare("SELECT detail FROM agent_actions").get() as { detail: string };
    expect(row.detail).toBe("not valid json");
  });

  it("is a no-op when old === new", () => {
    db.prepare("INSERT INTO observations (payload) VALUES (?)").run(
      JSON.stringify({ path: "/same/place" }),
    );
    const stats = rewritePathsInDb(db, "/same", "/same");
    expect(stats.rowsRewritten).toBe(0);
    expect(stats.rowsUnchanged).toBe(0);
  });

  it("skips tables that don't exist", () => {
    db.exec("DROP TABLE observations");
    db.prepare("INSERT INTO agent_actions (detail) VALUES (?)").run(
      JSON.stringify({ file: "/old/a.md" }),
    );
    const stats = rewritePathsInDb(db, "/old", "/new");
    expect(stats.rowsRewritten).toBe(1);
  });

  it("counts NULL json rows as unchanged without parsing", () => {
    // A row with NULL `detail` triggers the `row.json === null` short-circuit
    // — the walker must not try to JSON.parse(null) (which would yield the
    // literal `null` token and be miscounted as unparseable).
    db.prepare("INSERT INTO agent_actions (detail) VALUES (NULL)").run();
    const stats = rewritePathsInDb(db, "/old", "/new");
    expect(stats.rowsUnchanged).toBe(1);
    expect(stats.rowsUnparseable).toBe(0);
    expect(stats.rowsRewritten).toBe(0);
  });
});
