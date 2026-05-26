import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../db/schema.js";
import {
  ContextIndexReconcilerObserver,
  type FileWatcher,
} from "./context-index-reconciler-observer.js";
import { parseContextIndexRows } from "../core/review-context.js";
import type { TodayWriteLockManager } from "../core/today-write-lock.js";
import {
  RECONCILER_LAST_RUN_KEY,
  type ReconcilerRunRecord,
} from "../core/context/reconciler-runner.js";
import { POLICY_INDEX_RECONCILER_LAST_RUN_KEY } from "../core/context/policy-index-runner.js";
import { readRuntimeState } from "../db/runtime-state.js";
import { CONTEXT_RELATIVE_PATHS } from "../core/context-paths.js";

class FakeWatcher implements FileWatcher {
  public handlers: Array<(relativePath: string) => void> = [];
  public closed = false;

  onChange(handler: (relativePath: string) => void): void {
    this.handlers.push(handler);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  emit(relativePath: string): void {
    for (const handler of this.handlers) handler(relativePath);
  }
}

function touch(path: string, dateIso: string): void {
  const when = new Date(dateIso);
  utimesSync(path, when, when);
}

describe("ContextIndexReconcilerObserver", () => {
  let tmp: string;
  let contextDir: string;
  let db: Database.Database;

  beforeEach(() => {
    vi.useFakeTimers();
    tmp = mkdtempSync(join(tmpdir(), "reconciler-observer-"));
    contextDir = join(tmp, "context");
    mkdirSync(contextDir, { recursive: true });
    mkdirSync(join(contextDir, "state"), { recursive: true });
    mkdirSync(join(contextDir, "identity"), { recursive: true });
    mkdirSync(join(contextDir, "plans", "projects"), { recursive: true });
    mkdirSync(join(contextDir, "policies"), { recursive: true });
    mkdirSync(join(contextDir, "journal", "daily"), { recursive: true });
    mkdirSync(join(contextDir, "knowledge", "dossiers"), { recursive: true });
    db = new Database(":memory:");
    applySchema(db);
    writeFileSync(
      join(contextDir, "state", "today.md"),
      "---\ntype: daily\nowner: agent\nupdated: 2026-04-21\n---\n# Today\n",
    );
    touch(join(contextDir, "state", "today.md"), "2026-04-21T00:00:00Z");
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("runs the reconciler 30s after start()", async () => {
    const watcher = new FakeWatcher();
    const observer = new ContextIndexReconcilerObserver({
      db,
      contextDir,
      watcherFactory: () => watcher,
      timezone: "UTC",
    });
    await observer.start();
    expect(watcher.handlers).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(30_000);
    // Drain any lingering microtasks from the reconciler promise.
    await vi.runOnlyPendingTimersAsync();

    const persisted = readRuntimeState<ReconcilerRunRecord>(
      db,
      RECONCILER_LAST_RUN_KEY,
    );
    expect(persisted?.trigger).toBe("startup");
    expect(persisted?.result).toBe("applied");
    await observer.stop();
    expect(watcher.closed).toBe(true);
  });

  it("debounces FS events into a single reconcile after 10s", async () => {
    const watcher = new FakeWatcher();
    const observer = new ContextIndexReconcilerObserver({
      db,
      contextDir,
      watcherFactory: () => watcher,
      timezone: "UTC",
    });
    await observer.start();

    // Skip the startup run.
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.runOnlyPendingTimersAsync();

    // Create a new projects/ file that the reconciler should pick up.
    writeFileSync(join(contextDir, "plans/projects/alpha.md"), "# Alpha\n");
    touch(join(contextDir, "plans/projects/alpha.md"), "2026-04-21T00:00:00Z");

    // Fire multiple events within the debounce window — only one reconcile
    // should result.
    watcher.emit("plans/projects/alpha.md");
    await vi.advanceTimersByTimeAsync(5_000);
    watcher.emit("plans/projects/alpha.md");
    await vi.advanceTimersByTimeAsync(5_000);
    // Still within the most-recent 10 s debounce — no run yet.
    await vi.advanceTimersByTimeAsync(4_000);
    const beforeFinalTick = readRuntimeState<ReconcilerRunRecord>(
      db,
      RECONCILER_LAST_RUN_KEY,
    );
    expect(beforeFinalTick?.trigger).toBe("startup");

    await vi.advanceTimersByTimeAsync(7_000);
    await vi.runOnlyPendingTimersAsync();
    const afterDebounce = readRuntimeState<ReconcilerRunRecord>(
      db,
      RECONCILER_LAST_RUN_KEY,
    );
    expect(afterDebounce?.trigger).toBe("fs_event");
    expect(afterDebounce?.result).toBe("applied");

    const rows = parseContextIndexRows(
      readFileSync(join(contextDir, "_index.md"), "utf-8"),
    );
    expect(rows.some((r) => r.path === "plans/projects/alpha.md")).toBe(true);

    await observer.stop();
  });

  it("ignores FS events for paths outside the indexer include set", async () => {
    const watcher = new FakeWatcher();
    const observer = new ContextIndexReconcilerObserver({
      db,
      contextDir,
      watcherFactory: () => watcher,
      timezone: "UTC",
    });
    await observer.start();
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.runOnlyPendingTimersAsync();

    // Ephemeral scratch file, _index.md, and non-md are all filtered.
    watcher.emit("state/scratch/2026-04-21-note.md");
    watcher.emit("plans/projects/_index.md");
    watcher.emit("README.txt");
    await vi.advanceTimersByTimeAsync(11_000);

    const persisted = readRuntimeState<ReconcilerRunRecord>(
      db,
      RECONCILER_LAST_RUN_KEY,
    );
    // Only the startup run has fired.
    expect(persisted?.trigger).toBe("startup");

    await observer.stop();
  });

  it("defers a cron trigger when the morning routine lock is held", async () => {
    const fakeLock: TodayWriteLockManager = {
      acquire: () => ({ ok: true, lockId: "fake" }),
      release: () => true,
      isHeldBy: () => true,
      getHolder: () => "morning-routine",
    };
    const watcher = new FakeWatcher();
    const observer = new ContextIndexReconcilerObserver({
      db,
      contextDir,
      watcherFactory: () => watcher,
      morningRoutineLock: fakeLock,
      timezone: "UTC",
    });
    await observer.start();
    // Skip startup.
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.runOnlyPendingTimersAsync();

    observer.requestReconcile("cron");
    // The cron request should have scheduled a retry 5 minutes out rather
    // than running immediately.
    const afterFirstRequest = readRuntimeState<ReconcilerRunRecord>(
      db,
      RECONCILER_LAST_RUN_KEY,
    );
    expect(afterFirstRequest?.trigger).toBe("startup");

    // Allow the 5-minute retry — the lock is still held, so it re-defers
    // by another 5 minutes.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    const stillStartup = readRuntimeState<ReconcilerRunRecord>(
      db,
      RECONCILER_LAST_RUN_KEY,
    );
    expect(stillStartup?.trigger).toBe("startup");
    await observer.stop();
  });

  it("latches a follow-up trigger when one fires mid-run", async () => {
    const watcher = new FakeWatcher();
    const observer = new ContextIndexReconcilerObserver({
      db,
      contextDir,
      watcherFactory: () => watcher,
      timezone: "UTC",
    });
    await observer.start();
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.runOnlyPendingTimersAsync();

    // Simulate a manual request while another is pending inFlight. We do
    // this by issuing two requestReconcile calls back-to-back — the
    // second is latched into `pendingTrigger`.
    observer.requestReconcile("manual");
    observer.requestReconcile("fs_event");
    await vi.runOnlyPendingTimersAsync();
    const persisted = readRuntimeState<ReconcilerRunRecord>(
      db,
      RECONCILER_LAST_RUN_KEY,
    );
    expect(["manual", "fs_event"]).toContain(persisted?.trigger);

    await observer.stop();
  });

  it("is a no-op when start() is called twice", async () => {
    const watcher = new FakeWatcher();
    const observer = new ContextIndexReconcilerObserver({
      db,
      contextDir,
      watcherFactory: () => watcher,
      timezone: "UTC",
    });
    await observer.start();
    await observer.start();
    expect(watcher.handlers).toHaveLength(1);
    await observer.stop();
    await observer.stop();
    expect(watcher.closed).toBe(true);
  });

  it("defers the FS watcher when contextDir is missing at start()", async () => {
    const missing = join(tmp, "missing");
    const created: FakeWatcher[] = [];
    const observer = new ContextIndexReconcilerObserver({
      db,
      contextDir: missing,
      watcherFactory: () => {
        const watcher = new FakeWatcher();
        created.push(watcher);
        return watcher;
      },
      timezone: "UTC",
    });
    await observer.start();
    expect(created).toHaveLength(0);
    // Startup timer still fires; reconciler logs noop since contextDir
    // does not exist yet.
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.runOnlyPendingTimersAsync();
    const persisted = readRuntimeState<ReconcilerRunRecord>(
      db,
      RECONCILER_LAST_RUN_KEY,
    );
    expect(persisted?.result).toBe("noop");
    await observer.stop();
  });

  it("ignores requestReconcile after stop()", async () => {
    const watcher = new FakeWatcher();
    const observer = new ContextIndexReconcilerObserver({
      db,
      contextDir,
      watcherFactory: () => watcher,
      timezone: "UTC",
    });
    await observer.start();
    await observer.stop();
    observer.requestReconcile("manual");
    await vi.runOnlyPendingTimersAsync();
    const persisted = readRuntimeState<ReconcilerRunRecord>(
      db,
      RECONCILER_LAST_RUN_KEY,
    );
    expect(persisted).toBeNull();
  });

  it("chains the policy-index reconciler off the same trigger latch", async () => {
    // MANAGEMENT-POLICY-CAPTURE-PLAN §9 P4 — a chokidar event under
    // rules/policies/ should run BOTH reconcilers in a single inFlight
    // pass. We verify by seeding a policy file + linked routine, firing
    // an FS event, and inspecting both runtime_state rows.
    const policyBody = `---
type: rule
kind: policy
owner: agent
updated: 2026-04-21
slug: morning-finance
status: active
created_at: 2026-04-21
created_via: dm
origin: "User DM 2026-04-21: every morning run finance app"
linked:
  routine: morning-finance
  dossier: finance
template_version: 1
---
# Morning finance check

## Why

Daily Moneytree balance and transactions snapshot.
`;
    const routineBody = `---
type: rule
slug: morning-finance
process_key: routine.custom.morning-finance
cron: "0 7 * * *"
backend_tier: light
max_budget_usd: 0.20
enabled: true
---
# Morning finance routine

## Checks

### balance
**Action**: read.
`;
    const watcher = new FakeWatcher();
    const observer = new ContextIndexReconcilerObserver({
      db,
      contextDir,
      watcherFactory: () => watcher,
      timezone: "UTC",
    });
    await observer.start();
    // Skip the startup pass — at startup the policies dir is empty so
    // the policy reconciler is a no-op. We then write the policy +
    // routine files and fire an FS event to verify the chain re-runs.
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.runOnlyPendingTimersAsync();

    mkdirSync(join(contextDir, CONTEXT_RELATIVE_PATHS.rules.policiesDir), {
      recursive: true,
    });
    mkdirSync(join(contextDir, CONTEXT_RELATIVE_PATHS.routines.customDir), {
      recursive: true,
    });
    writeFileSync(
      join(
        contextDir,
        CONTEXT_RELATIVE_PATHS.rules.policiesDir,
        "morning-finance.md",
      ),
      policyBody,
    );
    writeFileSync(
      join(
        contextDir,
        CONTEXT_RELATIVE_PATHS.routines.customDir,
        "morning-finance.md",
      ),
      routineBody,
    );

    // Fire an FS event for the policy file.
    watcher.emit("policies/management-captures/morning-finance.md");
    await vi.advanceTimersByTimeAsync(11_000);
    await vi.runOnlyPendingTimersAsync();

    const contextRecord = readRuntimeState<ReconcilerRunRecord>(
      db,
      RECONCILER_LAST_RUN_KEY,
    );
    const policyRecord = readRuntimeState<ReconcilerRunRecord>(
      db,
      POLICY_INDEX_RECONCILER_LAST_RUN_KEY,
    );
    expect(contextRecord?.trigger).toBe("fs_event");
    expect(policyRecord?.trigger).toBe("fs_event");
    expect(policyRecord?.result).toBe("applied");

    const indexBody = readFileSync(
      join(contextDir, CONTEXT_RELATIVE_PATHS.rules.policiesIndex),
      "utf-8",
    );
    expect(indexBody).toContain("morning-finance");
    expect(indexBody).toContain("`0 7 * * *`");

    await observer.stop();
  });
});
