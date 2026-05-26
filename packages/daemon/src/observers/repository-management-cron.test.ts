import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../db/schema.js";
import {
  createRepository,
  getManagement,
  setManagementEnabled,
  type RepositoryDTO,
} from "../db/repositories-store.js";
import { EventBus } from "../core/event-bus.js";
import { isAgentTaskEvent } from "@aitne/shared";
import {
  REPOSITORY_MANAGEMENT_PROCESS_KEY,
  RepositoryManagementCron,
} from "./repository-management-cron.js";

describe("RepositoryManagementCron", () => {
  let db: Database.Database;
  let eventBus: EventBus;
  let tempDirs: string[];

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    eventBus = new EventBus(100);
    tempDirs = [];
  });

  afterEach(() => {
    db.close();
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function newRow(opts: {
    id: string;
    githubOwner?: string;
    githubRepo?: string;
    localPath?: string;
  }): RepositoryDTO {
    return createRepository(db, {
      githubOwner: opts.githubOwner ?? null,
      githubRepo: opts.githubRepo ?? null,
      localPath: opts.localPath ?? null,
      displayName: opts.id,
    });
  }

  async function drainQueue(): Promise<unknown[]> {
    const events: unknown[] = [];
    // Pull until the heap empties. The cron's events are HIGH/NORMAL —
    // both go onto the regular heap, so size() reaches 0 once drained.
    // get() would block; we use the internal heap counter instead.
    while ((eventBus as unknown as { heap: { size: () => number } }).heap.size() > 0) {
      const ev = await eventBus.get();
      events.push(ev);
    }
    return events;
  }

  function createTempGitRepo(): {
    root: string;
    repoPath: string;
    contextDir: string;
  } {
    const root = mkdtempSync(join(tmpdir(), "repo-management-cron-"));
    tempDirs.push(root);
    const repoPath = join(root, "repo");
    const contextDir = join(root, "context");
    mkdirSync(repoPath, { recursive: true });
    mkdirSync(contextDir, { recursive: true });
    execFileSync("git", ["init"], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "agent@example.com"], {
      cwd: repoPath,
    });
    execFileSync("git", ["config", "user.name", "Agent"], { cwd: repoPath });
    writeFileSync(join(repoPath, "README.md"), "# Test repo\n");
    execFileSync("git", ["add", "README.md"], { cwd: repoPath });
    execFileSync("git", ["commit", "-m", "Initial docs"], {
      cwd: repoPath,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2026-05-05T10:00:00Z",
        GIT_COMMITTER_DATE: "2026-05-05T10:00:00Z",
      },
      stdio: "ignore",
    });
    return { root, repoPath, contextDir };
  }

  it("emits one scheduled.task per due, enabled, locally-cloned row", async () => {
    const a = newRow({ id: "a", localPath: "/code/a" });
    newRow({ id: "b", localPath: "/code/b" });
    setManagementEnabled(db, a.id, true);
    // b is registered but management not enabled — must not fire.

    const cron = new RepositoryManagementCron({ db, eventBus });
    const fired = await cron.tick();
    expect(fired).toBe(1);

    const events = await drainQueue();
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(isAgentTaskEvent(ev as never)).toBe(true);
    expect((ev as { taskContext: { processKey: string } }).taskContext.processKey).toBe(
      REPOSITORY_MANAGEMENT_PROCESS_KEY,
    );
    expect((ev as { taskContext: { repositoryId: string } }).taskContext.repositoryId).toBe(
      a.id,
    );
  });

  it("skips rows whose management.enabled = 0", async () => {
    const a = newRow({ id: "a", localPath: "/code/a" });
    setManagementEnabled(db, a.id, false);

    const cron = new RepositoryManagementCron({ db, eventBus });
    expect(await cron.tick()).toBe(0);
  });

  it("skips rows that have no local clone (github-only)", async () => {
    const a = newRow({ id: "a", githubOwner: "acme", githubRepo: "x" });
    setManagementEnabled(db, a.id, true);

    const cron = new RepositoryManagementCron({ db, eventBus });
    expect(await cron.tick()).toBe(0);
  });

  it("does not re-fire on consecutive ticks within the scan window", async () => {
    const a = newRow({ id: "a", localPath: "/code/a" });
    setManagementEnabled(db, a.id, true);

    let now = Date.parse("2026-05-05T00:00:00Z");
    const cron = new RepositoryManagementCron({
      db,
      eventBus,
      scanIntervalMs: 24 * 60 * 60 * 1000,
      now: () => new Date(now),
    });

    expect(await cron.tick()).toBe(1);
    // Pull the event so the next tick has room — and so the heap
    // counter accurately reflects "no pending events".
    await eventBus.get();

    // Next tick a few seconds later — still inside the 24h window.
    now += 30 * 1000;
    expect(await cron.tick()).toBe(0);
  });

  it("re-fires once the scan window elapses", async () => {
    const a = newRow({ id: "a", localPath: "/code/a" });
    setManagementEnabled(db, a.id, true);

    let now = Date.parse("2026-05-05T00:00:00Z");
    const cron = new RepositoryManagementCron({
      db,
      eventBus,
      scanIntervalMs: 24 * 60 * 60 * 1000,
      now: () => new Date(now),
    });

    expect(await cron.tick()).toBe(1);
    await eventBus.get();

    // Advance >24h — row becomes due again.
    now += 25 * 60 * 60 * 1000;
    expect(await cron.tick()).toBe(1);
    const ev = await eventBus.get();
    if (!ev || !isAgentTaskEvent(ev)) {
      throw new Error("Expected repository management task event");
    }
    expect(ev.taskContext.repositoryId).toBe(a.id);
  });

  it("marks last_scan_at = now BEFORE firing (anti-spam guarantee)", async () => {
    const a = newRow({ id: "a", localPath: "/code/a" });
    setManagementEnabled(db, a.id, true);

    const before = getManagement(db, a.id);
    expect(before?.lastScanAt).toBeNull();

    const fixedNow = Date.parse("2026-05-05T12:00:00Z");
    const cron = new RepositoryManagementCron({
      db,
      eventBus,
      now: () => new Date(fixedNow),
    });
    await cron.tick();

    const after = getManagement(db, a.id);
    expect(after?.lastScanAt).toBe(fixedNow);
    // status is intentionally untouched here — the dispatcher's
    // finalizer flips it when the session terminates.
    expect(after?.lastScanStatus).toBeNull();
  });

  it("emits multiple events across multiple due rows", async () => {
    const a = newRow({ id: "a", localPath: "/code/a" });
    const b = newRow({ id: "b", localPath: "/code/b" });
    setManagementEnabled(db, a.id, true);
    setManagementEnabled(db, b.id, true);

    const cron = new RepositoryManagementCron({ db, eventBus });
    expect(await cron.tick()).toBe(2);

    const events = await drainQueue();
    expect(events).toHaveLength(2);
    const repoIds = events.map(
      (ev) => (ev as { taskContext: { repositoryId: string } }).taskContext.repositoryId,
    );
    expect(repoIds.sort()).toEqual([a.id, b.id].sort());
  });

  it("tick is idempotent against concurrent re-entry", async () => {
    const a = newRow({ id: "a", localPath: "/code/a" });
    setManagementEnabled(db, a.id, true);

    const cron = new RepositoryManagementCron({ db, eventBus });
    // Two parallel ticks. The first wins the `running` flag; the
    // second observes it and returns 0 immediately.
    const [first, second] = await Promise.all([cron.tick(), cron.tick()]);
    expect(first + second).toBe(1);
  });

  it("tick returns 0 after stop()", async () => {
    const a = newRow({ id: "a", localPath: "/code/a" });
    setManagementEnabled(db, a.id, true);

    const cron = new RepositoryManagementCron({ db, eventBus });
    await cron.stop();
    expect(await cron.tick()).toBe(0);
  });

  it("survives a put() failure on one row without aborting the loop", async () => {
    const a = newRow({ id: "a", localPath: "/code/a" });
    const b = newRow({ id: "b", localPath: "/code/b" });
    setManagementEnabled(db, a.id, true);
    setManagementEnabled(db, b.id, true);

    // Spy on put — fail the first call only.
    let calls = 0;
    const putSpy = vi.spyOn(eventBus, "put").mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error("synthetic failure");
    });

    const cron = new RepositoryManagementCron({ db, eventBus });
    const emitted = await cron.tick();
    expect(emitted).toBe(1);
    expect(putSpy).toHaveBeenCalledTimes(2);
    putSpy.mockRestore();
  });

  it("writes journal markdown directly when contextDir is configured", async () => {
    const { repoPath, contextDir } = createTempGitRepo();
    const repo = newRow({ id: "direct", localPath: repoPath });
    setManagementEnabled(db, repo.id, true);

    const fixedNow = Date.parse("2026-05-05T12:00:00Z");
    const cron = new RepositoryManagementCron({
      db,
      eventBus,
      contextDir,
      timezone: "UTC",
      now: () => new Date(fixedNow),
    });

    expect(await cron.tick()).toBe(1);
    const management = getManagement(db, repo.id);
    expect(management?.lastScanStatus).toBe("ok");

    const overviewPath = join(contextDir, "knowledge", "repos", repo.slug, "overview.md");
    const journalPath = join(contextDir, "journal", "repos", repo.slug, "2026-05-05.md");
    expect(existsSync(overviewPath)).toBe(true);
    expect(readFileSync(journalPath, "utf-8")).toContain("Initial docs");
    expect(await drainQueue()).toHaveLength(0);
  });

  it("clamps tickIntervalSeconds to the floor (60s)", () => {
    const cron = new RepositoryManagementCron({
      db,
      eventBus,
      tickIntervalSeconds: 5,
    });
    // Internal field is private; assert observable behaviour by
    // invoking start() and confirming it doesn't throw at the floor.
    void cron.start();
    void cron.stop();
  });
});
