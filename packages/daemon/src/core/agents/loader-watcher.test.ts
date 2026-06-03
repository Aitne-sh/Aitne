import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { applySchema } from "../../db/schema.js";
import { AgentEnabledCache, type AgentLoadOptions, type LoadAgentsResult } from "./loader.js";
import { startAgentsWatcher, type AgentsWatcherHandle } from "./loader-watcher.js";

/**
 * §6.2 — the filesystem watcher re-runs the loader on a user-agent edit and
 * invalidates the enabled-cache + emits an SSE event. Uses real chokidar
 * against a tempdir; the reload itself is injected so the assertion is
 * deterministic (loadAgents is covered by loader.test.ts).
 */

let db: Database.Database;
let tmpRoot: string;
let builtinDir: string;
let userDir: string;
let handle: AgentsWatcherHandle | null = null;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  tmpRoot = mkdtempSync(join(tmpdir(), "agents-watcher-"));
  builtinDir = join(tmpRoot, "builtin");
  userDir = join(tmpRoot, "user");
  mkdirSync(builtinDir, { recursive: true });
  mkdirSync(userDir, { recursive: true });
});

afterEach(async () => {
  if (handle) await handle.stop();
  handle = null;
  db.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function options(): AgentLoadOptions {
  return { builtinDir, userDir, dayBoundaryHour: 4, timezone: "UTC" };
}

const emptyResult: LoadAgentsResult = { upserted: ["x"], invalid: [], warnings: [] };

describe("startAgentsWatcher", () => {
  it("reloads + invalidates cache + emits SSE on a user-agent add", async () => {
    const cache = new AgentEnabledCache(db);
    const invalidate = vi.spyOn(cache, "invalidate");
    const emit = vi.fn();
    const reload = vi.fn(() => emptyResult);

    handle = startAgentsWatcher(db, options(), {
      reload,
      cache,
      events: { emit },
      debounceMs: 30,
    });

    // Give chokidar a beat to attach before the first write.
    await new Promise((r) => setTimeout(r, 50));
    mkdirSync(join(userDir, "new-agent"), { recursive: true });
    writeFileSync(join(userDir, "new-agent", "agent.md"), "---\nslug: new-agent\n---\nbody\n", "utf-8");

    await vi.waitFor(() => expect(reload).toHaveBeenCalled(), { timeout: 5000, interval: 50 });
    expect(invalidate).toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith("agent.updated", expect.objectContaining({ reason: "add" }));
  });

  it("survives a throwing reload without crashing", async () => {
    const reload = vi.fn((): LoadAgentsResult => {
      throw new Error("reload boom");
    });
    handle = startAgentsWatcher(db, options(), { reload, debounceMs: 30, watchBuiltin: true });

    await new Promise((r) => setTimeout(r, 50));
    mkdirSync(join(userDir, "boom-agent"), { recursive: true });
    writeFileSync(join(userDir, "boom-agent", "agent.md"), "---\nslug: boom\n---\nb\n", "utf-8");

    await vi.waitFor(() => expect(reload).toHaveBeenCalled(), { timeout: 5000, interval: 50 });
    // No throw escaped; the handle is still stoppable.
    await handle.stop();
    handle = null;
  });

  it("stops cleanly", async () => {
    handle = startAgentsWatcher(db, options(), { reload: () => emptyResult });
    await handle.stop();
    handle = null;
    expect(true).toBe(true);
  });
});
