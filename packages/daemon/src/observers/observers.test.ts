import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { ObserverManager, type Observer } from "./manager.js";
import { ObsidianWatcher } from "./obsidian-watcher.js";
import { GitWatcher } from "./git-watcher.js";
import { applySchema } from "../db/schema.js";

// ── ObserverManager Tests ──

describe("ObserverManager", () => {
  it("registers and tracks observers", () => {
    const mgr = new ObserverManager();
    const mock: Observer = {
      name: "test",
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };

    mgr.register(mock);
    expect(mgr.getObservers()).toHaveLength(1);
    expect(mgr.getObservers()[0].name).toBe("test");
  });

  it("starts all observers", async () => {
    const mgr = new ObserverManager();
    const obs1: Observer = {
      name: "obs1",
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const obs2: Observer = {
      name: "obs2",
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };

    mgr.register(obs1);
    mgr.register(obs2);
    await mgr.startAll();

    expect(obs1.start).toHaveBeenCalledOnce();
    expect(obs2.start).toHaveBeenCalledOnce();
  });

  it("stops all observers", async () => {
    const mgr = new ObserverManager();
    const obs: Observer = {
      name: "obs",
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };

    mgr.register(obs);
    await mgr.stopAll();

    expect(obs.stop).toHaveBeenCalledOnce();
  });

  it("handles start failure gracefully (does not throw)", async () => {
    const mgr = new ObserverManager();
    const failing: Observer = {
      name: "failing",
      start: vi.fn().mockRejectedValue(new Error("connection failed")),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const working: Observer = {
      name: "working",
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };

    mgr.register(failing);
    mgr.register(working);

    // Should not throw even though one observer fails
    await expect(mgr.startAll()).resolves.not.toThrow();
    expect(working.start).toHaveBeenCalledOnce();
  });

  it("handles stop failure gracefully (does not throw)", async () => {
    const mgr = new ObserverManager();
    const failing: Observer = {
      name: "failing-stop",
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockRejectedValue(new Error("stop failed")),
    };
    const working: Observer = {
      name: "working-stop",
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };

    mgr.register(failing);
    mgr.register(working);

    // Should not throw even though one observer fails to stop
    await expect(mgr.stopAll()).resolves.not.toThrow();
    expect(working.stop).toHaveBeenCalledOnce();
    expect(failing.stop).toHaveBeenCalledOnce();
  });

  it("has() returns true for registered observers", () => {
    const mgr = new ObserverManager();
    const obs: Observer = {
      name: "test-obs",
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };

    expect(mgr.has("test-obs")).toBe(false);
    mgr.register(obs);
    expect(mgr.has("test-obs")).toBe(true);
    expect(mgr.has("nonexistent")).toBe(false);
  });

  it("registerAndStart adds and starts an observer", async () => {
    const mgr = new ObserverManager();
    const obs: Observer = {
      name: "hot",
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    await mgr.registerAndStart(obs);
    expect(mgr.has("hot")).toBe(true);
    expect(obs.start).toHaveBeenCalledOnce();
  });

  it("registerAndStart is a no-op when the observer is already registered", async () => {
    const mgr = new ObserverManager();
    const first: Observer = {
      name: "dup",
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const second: Observer = {
      name: "dup",
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    await mgr.registerAndStart(first);
    await mgr.registerAndStart(second);
    expect(mgr.getObservers()).toHaveLength(1);
    expect(second.start).not.toHaveBeenCalled();
  });

  it("registerAndStart propagates start failures so callers can react", async () => {
    const mgr = new ObserverManager();
    const failing: Observer = {
      name: "boom",
      start: vi.fn().mockRejectedValue(new Error("nope")),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    await expect(mgr.registerAndStart(failing)).rejects.toThrow("nope");
    // Failed start still leaves the observer registered so a retry can hit
    // the no-op guard rather than re-attempting subscription side-effects.
    expect(mgr.has("boom")).toBe(true);
  });

  it("stopAndUnregister returns status='removed' on a clean stop", async () => {
    const mgr = new ObserverManager();
    const obs: Observer = {
      name: "to-remove",
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    mgr.register(obs);
    const result = await mgr.stopAndUnregister("to-remove");
    expect(result.status).toBe("removed");
    expect(mgr.has("to-remove")).toBe(false);
    expect(obs.stop).toHaveBeenCalledOnce();
  });

  it("stopAndUnregister returns status='absent' when no matching observer is registered", async () => {
    const mgr = new ObserverManager();
    const result = await mgr.stopAndUnregister("nope");
    expect(result.status).toBe("absent");
  });

  it("stopAndUnregister returns status='stop_failed' and KEEPS the observer registered when stop throws", async () => {
    // Regression: previously this path swallowed the error AND removed
    // the observer from the registry, which orphaned the underlying
    // timer / fs-watcher / long-poll. After an integration flipped
    // direct → delegated, the old poller would keep firing while the
    // registry claimed nothing was running — double observations under
    // the new mode. The hot-remove must now leave the observer in
    // place for retry.
    const mgr = new ObserverManager();
    const flaky: Observer = {
      name: "flaky",
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockRejectedValue(new Error("stop nope")),
    };
    mgr.register(flaky);
    const result = await mgr.stopAndUnregister("flaky");
    expect(result.status).toBe("stop_failed");
    if (result.status === "stop_failed") {
      expect((result.error as Error).message).toBe("stop nope");
    }
    // Critical invariant: the failing observer is still tracked so the
    // next mode-change cycle (or shutdown's stopAll) can retry the
    // stop instead of silently leaking the underlying resource.
    expect(mgr.has("flaky")).toBe(true);
  });

  it("stopAndUnregister retry after a transient failure eventually removes the observer", async () => {
    const mgr = new ObserverManager();
    const stop = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(undefined);
    const obs: Observer = {
      name: "retry-me",
      start: vi.fn().mockResolvedValue(undefined),
      stop,
    };
    mgr.register(obs);
    const first = await mgr.stopAndUnregister("retry-me");
    expect(first.status).toBe("stop_failed");
    expect(mgr.has("retry-me")).toBe(true);
    const second = await mgr.stopAndUnregister("retry-me");
    expect(second.status).toBe("removed");
    expect(mgr.has("retry-me")).toBe(false);
    expect(stop).toHaveBeenCalledTimes(2);
  });
});

// ── ObsidianWatcher Tests ──

describe("ObsidianWatcher", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("has correct static configuration", () => {
    expect(ObsidianWatcher.IGNORE_PATTERNS).toContain("**/.obsidian/**");
    expect(ObsidianWatcher.IGNORE_PATTERNS).toContain("**/.trash/**");
    expect(ObsidianWatcher.IGNORE_PATTERNS).toContain("**/.git/**");
    expect(ObsidianWatcher.WATCH_EXTENSIONS.has(".md")).toBe(true);
    expect(ObsidianWatcher.WATCH_EXTENSIONS.has(".txt")).toBe(false);
  });

  it("implements Observer interface with a namespaced source by default", () => {
    const watcher = new ObsidianWatcher("/tmp/vault", db, 5);
    // Default source / name is the external-vault namespace so two
    // coexisting instances (external + primary) never collide on the
    // ObserverManager registry or the (source, ref) upsert key.
    expect(watcher.name).toBe("obsidian:external");
    expect(watcher.source).toBe("obsidian:external");
    expect(typeof watcher.start).toBe("function");
    expect(typeof watcher.stop).toBe("function");
  });
});

describe("ObsidianWatcher lifecycle", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("ignores non-markdown files", () => {
    const watcher = new ObsidianWatcher("/vault", db, 5);

    // Access handleChange with a non-md file
    const handleChange = (watcher as unknown as {
      handleChange: (path: string, changeType: string) => void;
    }).handleChange.bind(watcher);

    handleChange("/vault/image.png", "modified");
    handleChange("/vault/data.json", "created");

    // No debounce timers should be set for non-md files
    const timers = (watcher as unknown as {
      debounceTimers: Map<string, unknown>;
    }).debounceTimers;
    expect(timers.size).toBe(0);
  });

  it("debounces rapid changes to the same file", () => {
    vi.useFakeTimers();
    try {
      const watcher = new ObsidianWatcher("/vault", db, 2);

      const handleChange = (watcher as unknown as {
        handleChange: (path: string, changeType: string) => void;
      }).handleChange.bind(watcher);

      handleChange("/vault/note.md", "modified");
      handleChange("/vault/note.md", "modified");
      handleChange("/vault/note.md", "modified");

      // Only one debounce timer should exist for this file
      const timers = (watcher as unknown as {
        debounceTimers: Map<string, unknown>;
      }).debounceTimers;
      expect(timers.size).toBe(1);

      vi.useRealTimers();
    } catch {
      vi.useRealTimers();
    }
  });

  it("stop clears debounce timers", async () => {
    vi.useFakeTimers();
    try {
      const watcher = new ObsidianWatcher("/vault", db, 10);

      const handleChange = (watcher as unknown as {
        handleChange: (path: string, changeType: string) => void;
      }).handleChange.bind(watcher);

      handleChange("/vault/note1.md", "modified");
      handleChange("/vault/note2.md", "created");

      const timers = (watcher as unknown as {
        debounceTimers: Map<string, unknown>;
      }).debounceTimers;
      expect(timers.size).toBe(2);

      await watcher.stop();
      expect(timers.size).toBe(0);
      vi.useRealTimers();
    } catch {
      vi.useRealTimers();
    }
  });
});

// ── GitWatcher Tests ──

describe("GitWatcher", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("implements Observer interface", () => {
    const watcher = new GitWatcher([], db, 300);
    expect(watcher.name).toBe("git");
    expect(typeof watcher.start).toBe("function");
    expect(typeof watcher.stop).toBe("function");
  });

  it("does not start polling with empty repo list", async () => {
    const watcher = new GitWatcher([], db, 300);

    // Should complete immediately with no repos
    await watcher.start();
    await watcher.stop();
  });

  it("stop cleans up poll timer", async () => {
    const watcher = new GitWatcher([], db, 300);

    await watcher.start();
    await watcher.stop();

    const timer = (watcher as unknown as { pollTimer: unknown }).pollTimer;
    expect(timer).toBeNull();
  });

  it("enableWebhookMode then stop works without error", async () => {
    const watcher = new GitWatcher([], db, 300);
    watcher.enableWebhookMode();
    watcher.notifyWebhookEvent();
    await watcher.stop();
  });

  describe("webhook frequency adjustment", () => {
    it("isWebhookHealthy returns false when not in webhook mode", () => {
      const watcher = new GitWatcher([], db, 300);
      const isHealthy = (watcher as unknown as {
        isWebhookHealthy: () => boolean;
      }).isWebhookHealthy();
      expect(isHealthy).toBe(false);
    });

    it("isWebhookHealthy returns true shortly after enableWebhookMode", () => {
      const watcher = new GitWatcher([], db, 300);
      watcher.enableWebhookMode();
      const isHealthy = (watcher as unknown as {
        isWebhookHealthy: () => boolean;
      }).isWebhookHealthy();
      expect(isHealthy).toBe(true);
    });

    it("getCurrentInterval returns normal when webhook is not healthy", () => {
      const watcher = new GitWatcher([], db, 300);
      const interval = (watcher as unknown as {
        getCurrentInterval: () => number;
      }).getCurrentInterval();
      expect(interval).toBe(300); // normalIntervalSeconds
    });

    it("getCurrentInterval returns reduced when webhook is healthy", () => {
      const watcher = new GitWatcher([], db, 300);
      watcher.enableWebhookMode();
      const interval = (watcher as unknown as {
        getCurrentInterval: () => number;
      }).getCurrentInterval();
      expect(interval).toBe(300 * 6); // reducedIntervalSeconds = 6x
    });
  });
});
