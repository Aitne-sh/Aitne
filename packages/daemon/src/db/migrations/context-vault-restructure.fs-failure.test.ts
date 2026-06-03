import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted; route every fs call through the actual module and let
// individual tests opt into a `renameSync` override. This is the established
// pattern in `core/atomic-write.failure.test.ts`. It lets us drive the EXDEV
// cross-device fallbacks (renameSync throws EXDEV → cpSync + rmSync) and the
// non-EXDEV rethrow paths.
//
// IMPORTANT: only `renameSync` is overridden. The v8 coverage provider uses
// `readdirSync` (to enumerate `coverage/.tmp`), and because a vi.mock of
// `node:fs` persists for the rest of the worker, mocking `readdirSync` here
// would break coverage-report generation for the whole suite. `renameSync`
// is not used by the provider, so overriding only it is safe.
const overrides = vi.hoisted(() => ({
  renameSync: undefined as
    | ((from: string, to: string) => void)
    | undefined,
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    renameSync: (from: import("node:fs").PathLike, to: import("node:fs").PathLike) =>
      overrides.renameSync
        ? overrides.renameSync(String(from), String(to))
        : actual.renameSync(from, to),
  };
});

const { runContextVaultRestructure } = await import(
  "./context-vault-restructure.js"
);
const { renameSync: realRename } = await import("node:fs");

afterEach(() => {
  overrides.renameSync = undefined;
});

function makeLayout() {
  const base = mkdtempSync(join(tmpdir(), "vault-fsfail-"));
  const dataDir = join(base, "data");
  const contextDir = join(dataDir, "context");
  mkdirSync(contextDir, { recursive: true });
  const db = new Database(":memory:");
  db.exec(
    `CREATE TABLE wiki_workspaces (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, kind TEXT, root_path TEXT);
     CREATE TABLE agent_actions (id INTEGER PRIMARY KEY AUTOINCREMENT, action_type TEXT NOT NULL, detail TEXT, result TEXT, started_at TEXT DEFAULT CURRENT_TIMESTAMP, completed_at TEXT DEFAULT CURRENT_TIMESTAMP);
     CREATE TABLE observations (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT);
     CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, metadata TEXT);
     CREATE VIRTUAL TABLE fts_wiki USING fts5(workspace_id UNINDEXED, path UNINDEXED, content);`,
  );
  return { base, dataDir, contextDir, db };
}

describe("context-vault-restructure — fs failure fallbacks", () => {
  it("falls back to cp+rm when renameSync reports EXDEV (cross-device)", () => {
    const { base, dataDir, contextDir, db } = makeLayout();
    try {
      // Seed an in-context file, an out-of-context integrations.md, and an
      // internal wiki workspace — each goes through a different mover, all
      // sharing the EXDEV catch.
      writeFileSync(join(contextDir, "today.md"), "# today\n", "utf-8");
      writeFileSync(join(dataDir, "integrations.md"), "# i\n", "utf-8");
      const wikiRoot = join(dataDir, "wiki", "default");
      mkdirSync(join(wikiRoot, "20_wiki"), { recursive: true });
      writeFileSync(join(wikiRoot, "20_wiki", "a.md"), "# a\n", "utf-8");
      db.prepare(
        "INSERT INTO wiki_workspaces (name, kind, root_path) VALUES (?,?,?)",
      ).run("default", "internal", wikiRoot);

      // Every rename surfaces EXDEV → the cp+rm fallback runs instead.
      overrides.renameSync = () => {
        const err = new Error(
          "cross-device link not permitted",
        ) as NodeJS.ErrnoException;
        err.code = "EXDEV";
        throw err;
      };

      const result = runContextVaultRestructure({ db, dataDir, contextDir });
      expect(result.moved).toBe(true);
      expect(existsSync(join(contextDir, "state", "today.md"))).toBe(true);
      expect(
        existsSync(join(contextDir, "policies", "integrations.md")),
      ).toBe(true);
      expect(
        existsSync(
          join(contextDir, "knowledge", "wiki", "default", "20_wiki", "a.md"),
        ),
      ).toBe(true);
    } finally {
      db.close();
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("rethrows a non-EXDEV rename failure out of the manifest loop", () => {
    const { base, dataDir, contextDir, db } = makeLayout();
    try {
      writeFileSync(join(contextDir, "today.md"), "# today\n", "utf-8");
      overrides.renameSync = () => {
        throw new Error("disk on fire");
      };
      expect(() =>
        runContextVaultRestructure({ db, dataDir, contextDir }),
      ).toThrow(/disk on fire/);
    } finally {
      db.close();
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("rethrows a non-EXDEV failure from the out-of-context (integrations.md) mover", () => {
    const { base, dataDir, contextDir, db } = makeLayout();
    try {
      // ONLY an out-of-context move queued (no in-context files) so the
      // first rename reached is executeOutOfContextMove's.
      writeFileSync(join(dataDir, "integrations.md"), "# i\n", "utf-8");
      overrides.renameSync = () => {
        throw new Error("ooc disk on fire");
      };
      expect(() =>
        runContextVaultRestructure({ db, dataDir, contextDir }),
      ).toThrow(/ooc disk on fire/);
    } finally {
      db.close();
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("rethrows a non-EXDEV failure from the internal-wiki mover", () => {
    const { base, dataDir, contextDir, db } = makeLayout();
    try {
      // ONLY an internal-wiki move queued.
      const wikiRoot = join(dataDir, "wiki", "default");
      mkdirSync(wikiRoot, { recursive: true });
      writeFileSync(join(wikiRoot, "a.md"), "# a\n", "utf-8");
      db.prepare(
        "INSERT INTO wiki_workspaces (name, kind, root_path) VALUES (?,?,?)",
      ).run("default", "internal", wikiRoot);
      overrides.renameSync = () => {
        throw new Error("wiki disk on fire");
      };
      expect(() =>
        runContextVaultRestructure({ db, dataDir, contextDir }),
      ).toThrow(/wiki disk on fire/);
    } finally {
      db.close();
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("uses realRename for an unrelated sanity move (mock delegates by default)", () => {
    const base = mkdtempSync(join(tmpdir(), "vault-realrename-"));
    try {
      const a = join(base, "a.txt");
      const b = join(base, "b.txt");
      writeFileSync(a, "x", "utf-8");
      realRename(a, b);
      expect(existsSync(b)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
