import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../db/schema.js";
import { PrimaryVaultWatcher } from "./primary-vault-watcher.js";
import type { InnerWatcherFactory } from "./primary-vault-watcher.js";
import type { Observer } from "./manager.js";

/**
 * Fake inner watcher that records lifecycle calls + the path it was
 * constructed with. No chokidar, no FSEvents, no filesystem wait — the
 * whole PrimaryVaultWatcher contract (path targeting, teardown /
 * rebuild on re-target, noop on duplicate-path calls) is covered by
 * arithmetic on this fake's state.
 */
interface FakeWatcher extends Observer {
  readonly vaultPath: string;
  readonly events: Array<"start" | "stop">;
  stopError?: Error;
}

function fakeFactory(): {
  factory: InnerWatcherFactory;
  created: FakeWatcher[];
} {
  const created: FakeWatcher[] = [];
  const factory: InnerWatcherFactory = (vaultPath, _db, _debounce, _tracker, name) => {
    const watcher: FakeWatcher = {
      name,
      vaultPath,
      events: [],
      async start() {
        this.events.push("start");
      },
      async stop() {
        this.events.push("stop");
        if (this.stopError) throw this.stopError;
      },
    };
    created.push(watcher);
    return watcher;
  };
  return { factory, created };
}

describe("PrimaryVaultWatcher", () => {
  let tmpRoot: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "pa-primary-watcher-"));
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("stays dormant with no target path", async () => {
    const { factory, created } = fakeFactory();
    const watcher = new PrimaryVaultWatcher(db, 0, undefined, {
      innerFactory: factory,
    });
    await watcher.start();
    expect(created).toHaveLength(0);
    await watcher.stop();
  });

  it("spins up an inner watcher when setVaultPath + start land", async () => {
    const vault = join(tmpRoot, "vault");
    mkdirSync(vault);
    const { factory, created } = fakeFactory();
    const watcher = new PrimaryVaultWatcher(db, 0, undefined, {
      innerFactory: factory,
    });

    await watcher.setVaultPath(vault);
    await watcher.start();

    expect(created).toHaveLength(1);
    expect(created[0].vaultPath).toBe(vault);
    expect(created[0].events).toEqual(["start"]);
    expect(created[0].name).toBe("obsidian:primary");

    await watcher.stop();
    expect(created[0].events).toEqual(["start", "stop"]);
  });

  it("sequence-order independent: start → setVaultPath also spins up", async () => {
    const vault = join(tmpRoot, "vault");
    mkdirSync(vault);
    const { factory, created } = fakeFactory();
    const watcher = new PrimaryVaultWatcher(db, 0, undefined, {
      innerFactory: factory,
    });

    await watcher.start();
    expect(created).toHaveLength(0); // no path yet
    await watcher.setVaultPath(vault);
    expect(created).toHaveLength(1);
    expect(created[0].events).toEqual(["start"]);

    await watcher.stop();
  });

  it("re-targets by stopping old inner and starting a new one with the new path", async () => {
    const first = join(tmpRoot, "first");
    const second = join(tmpRoot, "second");
    mkdirSync(first);
    mkdirSync(second);
    const { factory, created } = fakeFactory();
    const watcher = new PrimaryVaultWatcher(db, 0, undefined, {
      innerFactory: factory,
    });

    await watcher.setVaultPath(first);
    await watcher.start();
    await watcher.setVaultPath(second);

    expect(created).toHaveLength(2);
    expect(created[0].vaultPath).toBe(first);
    expect(created[0].events).toEqual(["start", "stop"]);
    expect(created[1].vaultPath).toBe(second);
    expect(created[1].events).toEqual(["start"]);

    await watcher.stop();
  });

  it("treats duplicate setVaultPath as a no-op", async () => {
    const vault = join(tmpRoot, "vault");
    mkdirSync(vault);
    const { factory, created } = fakeFactory();
    const watcher = new PrimaryVaultWatcher(db, 0, undefined, {
      innerFactory: factory,
    });

    await watcher.setVaultPath(vault);
    await watcher.start();
    await watcher.setVaultPath(vault);

    expect(created).toHaveLength(1);
    expect(created[0].events).toEqual(["start"]);

    await watcher.stop();
  });

  it("setVaultPath(null) tears down without spinning up a new inner", async () => {
    const vault = join(tmpRoot, "vault");
    mkdirSync(vault);
    const { factory, created } = fakeFactory();
    const watcher = new PrimaryVaultWatcher(db, 0, undefined, {
      innerFactory: factory,
    });

    await watcher.setVaultPath(vault);
    await watcher.start();
    await watcher.setVaultPath(null);

    expect(created).toHaveLength(1);
    expect(created[0].events).toEqual(["start", "stop"]);
    expect(watcher.getVaultPath()).toBeNull();

    await watcher.stop();
  });

  it("setVaultPath while stopped: stores path, no inner spun up until start", async () => {
    const vault = join(tmpRoot, "vault");
    mkdirSync(vault);
    const { factory, created } = fakeFactory();
    const watcher = new PrimaryVaultWatcher(db, 0, undefined, {
      innerFactory: factory,
    });

    await watcher.setVaultPath(vault);
    expect(created).toHaveLength(0);
    expect(watcher.getVaultPath()).toBe(vault);

    await watcher.start();
    expect(created).toHaveLength(1);
    await watcher.stop();
  });

  it("survives an inner stop() throw during re-target without leaking the old inner", async () => {
    const first = join(tmpRoot, "first");
    const second = join(tmpRoot, "second");
    mkdirSync(first);
    mkdirSync(second);
    const { factory, created } = fakeFactory();
    const watcher = new PrimaryVaultWatcher(db, 0, undefined, {
      innerFactory: factory,
    });

    await watcher.setVaultPath(first);
    await watcher.start();
    created[0].stopError = new Error("inner stop exploded");

    // Re-target must not throw — failure to stop the old inner is
    // logged but the new one still spins up.
    await watcher.setVaultPath(second);

    expect(created).toHaveLength(2);
    expect(created[1].vaultPath).toBe(second);
    expect(created[1].events).toEqual(["start"]);

    // Clean up (second watcher doesn't throw on stop).
    await watcher.stop();
  });
});
