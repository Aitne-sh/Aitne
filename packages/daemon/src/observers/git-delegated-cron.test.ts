import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.js";
import { writeIntegrations } from "../db/integrations-store.js";
import { EventBus } from "../core/event-bus.js";
import {
  GIT_DELEGATED_PROCESS_KEY,
  GitDelegatedCronObserver,
  hasActiveDelegatedGitLifecycleIntegration,
} from "./git-delegated-cron.js";
import type { AgentTaskEvent } from "@aitne/shared";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

describe("GitDelegatedCronObserver", () => {
  it("does not emit when git and github are direct/default", async () => {
    const db = freshDb();
    const bus = new EventBus();
    const observer = new GitDelegatedCronObserver({
      db,
      eventBus: bus,
      repoPaths: ["/repo"],
      githubRepos: ["owner/repo"],
      cadenceSeconds: 3600,
      pushOverdueMinutes: 60,
      now: () => new Date("2026-04-30T12:00:00.000Z"),
    });

    expect(hasActiveDelegatedGitLifecycleIntegration(db)).toBe(false);
    await expect(observer.tick()).resolves.toBe(0);
  });

  it("emits a scheduled git lifecycle poll on the delegated backend", async () => {
    const db = freshDb();
    writeIntegrations(db, {
      git: {
        mode: "delegated",
        delegatedBackend: "codex",
        delegatedModel: "gpt-5.4-mini",
        deniedTools: [],
        lastChangedAt: "2026-04-30T12:00:00.000Z",
      },
      github: {
        mode: "delegated",
        delegatedBackend: "codex",
        deniedTools: [],
        lastChangedAt: "2026-04-30T12:00:00.000Z",
      },
    });
    const bus = new EventBus();
    const observer = new GitDelegatedCronObserver({
      db,
      eventBus: bus,
      repoPaths: ["/repo"],
      githubRepos: ["owner/repo"],
      cadenceSeconds: 300,
      pushOverdueMinutes: 60,
      now: () => new Date("2026-04-30T12:00:00.000Z"),
    });

    expect(hasActiveDelegatedGitLifecycleIntegration(db)).toBe(true);
    await expect(observer.tick()).resolves.toBe(1);
    const event = (await bus.get()) as AgentTaskEvent;

    expect(event.type).toBe("scheduled.task");
    expect(event.requestedBackendId).toBe("codex");
    expect(event.requestedModelId).toBe("gpt-5.4-mini");
    expect(event.taskContext.processKey).toBe(GIT_DELEGATED_PROCESS_KEY);
    expect(event.taskContext.triggerSource).toBe("integration_delegated_cron");
    expect(event.taskContext.activeIntegrations).toEqual(["git", "github"]);
    expect(event.taskContext.repoPaths).toEqual(["/repo"]);
    expect(event.taskContext.githubRepos).toEqual(["owner/repo"]);
    expect(event.taskContext.cadenceSeconds).toBe(600);
  });

  it("stop() prevents the timer chain from re-arming after an in-flight tick completes", async () => {
    const db = freshDb();
    writeIntegrations(db, {
      git: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-04-30T12:00:00.000Z",
      },
    });
    const bus = new EventBus();
    const observer = new GitDelegatedCronObserver({
      db,
      eventBus: bus,
      repoPaths: ["/repo"],
      githubRepos: [],
      cadenceSeconds: 600,
      pushOverdueMinutes: 60,
    });

    // Mark "running" before stop() to simulate a stop racing an in-flight tick.
    (observer as unknown as { running: boolean }).running = true;
    await observer.stop();
    (observer as unknown as { running: boolean }).running = false;

    // After stop(), tick() must short-circuit even when the running flag is
    // cleared by the in-flight cycle's finally block.
    await expect(observer.tick()).resolves.toBe(0);

    // Re-running start() after stop() must not arm a new timer chain — the
    // observer is dead. The lifecycle helper builds a fresh instance instead.
    await observer.start();
    expect((observer as unknown as { timer: unknown }).timer).toBeNull();
  });

  it("does not emit after stop() even if the cached running flag flips", async () => {
    const db = freshDb();
    writeIntegrations(db, {
      git: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-04-30T12:00:00.000Z",
      },
    });
    const bus = new EventBus();
    const observer = new GitDelegatedCronObserver({
      db,
      eventBus: bus,
      repoPaths: ["/repo"],
      githubRepos: [],
      cadenceSeconds: 3600,
      pushOverdueMinutes: 60,
    });

    await observer.stop();
    await expect(observer.tick()).resolves.toBe(0);
    expect(bus.size).toBe(0);
  });

  it("keeps separate backend/model scopes when git and github pin different models", async () => {
    const db = freshDb();
    writeIntegrations(db, {
      git: {
        mode: "delegated",
        delegatedBackend: "codex",
        delegatedModel: "gpt-5.4-mini",
        deniedTools: [],
        lastChangedAt: "2026-04-30T12:00:00.000Z",
      },
      github: {
        mode: "delegated",
        delegatedBackend: "codex",
        delegatedModel: "gpt-5.4",
        deniedTools: [],
        lastChangedAt: "2026-04-30T12:00:00.000Z",
      },
    });
    const bus = new EventBus();
    const observer = new GitDelegatedCronObserver({
      db,
      eventBus: bus,
      repoPaths: ["/repo"],
      githubRepos: ["owner/repo"],
      cadenceSeconds: 3600,
      pushOverdueMinutes: 60,
      now: () => new Date("2026-04-30T12:00:00.000Z"),
    });

    await expect(observer.tick()).resolves.toBe(2);
    const first = (await bus.get()) as AgentTaskEvent;
    const second = (await bus.get()) as AgentTaskEvent;

    expect(
      [first, second].map((event) => ({
        integrations: event.taskContext.activeIntegrations,
        model: event.requestedModelId,
      })),
    ).toEqual([
      { integrations: ["git"], model: "gpt-5.4-mini" },
      { integrations: ["github"], model: "gpt-5.4" },
    ]);
  });
});

describe("GitDelegatedCronObserver — edge cases and scheduling", () => {
  it("clamps non-finite cadenceSeconds to 3600", () => {
    const db = freshDb();
    const bus = new EventBus();
    const observer = new GitDelegatedCronObserver({
      db,
      eventBus: bus,
      repoPaths: [],
      githubRepos: [],
      cadenceSeconds: Infinity,
      pushOverdueMinutes: 60,
    });
    expect((observer as unknown as { cadenceSeconds: number }).cadenceSeconds).toBe(3600);
  });

  it("tick() returns 0 immediately when a previous tick is still in-flight", async () => {
    const db = freshDb();
    const bus = new EventBus();
    const observer = new GitDelegatedCronObserver({
      db,
      eventBus: bus,
      repoPaths: [],
      githubRepos: [],
      cadenceSeconds: 600,
      pushOverdueMinutes: 60,
    });
    (observer as unknown as { running: boolean }).running = true;
    await expect(observer.tick()).resolves.toBe(0);
  });

  it("tick() swallows errors from eventBus.put and returns 0", async () => {
    const db = freshDb();
    writeIntegrations(db, {
      git: {
        mode: "delegated",
        delegatedBackend: "codex",
        delegatedModel: "gpt-5.4-mini",
        deniedTools: [],
        lastChangedAt: "2026-04-30T12:00:00.000Z",
      },
    });
    const throwingBus = {
      put: vi.fn(() => Promise.reject(new Error("bus error"))),
    };
    const observer = new GitDelegatedCronObserver({
      db,
      eventBus: throwingBus as unknown as EventBus,
      repoPaths: ["/repo"],
      githubRepos: [],
      cadenceSeconds: 600,
      pushOverdueMinutes: 60,
      now: () => new Date("2026-04-30T12:00:00.000Z"),
    });
    await expect(observer.tick()).resolves.toBe(0);
  });

  it("hasActiveDelegatedGitLifecycleIntegration returns true when github override is delegated but DB has none", () => {
    const db = freshDb();
    const result = hasActiveDelegatedGitLifecycleIntegration(db, {
      key: "github",
      state: {
        mode: "delegated",
        delegatedBackend: "codex",
        deniedTools: [],
        lastChangedAt: "2026-04-30T12:00:00.000Z",
      },
    });
    expect(result).toBe(true);
  });

  it("hasActiveDelegatedGitLifecycleIntegration returns false when git override is direct but DB has git as delegated", () => {
    const db = freshDb();
    writeIntegrations(db, {
      git: {
        mode: "delegated",
        delegatedBackend: "codex",
        deniedTools: [],
        lastChangedAt: "2026-04-30T12:00:00.000Z",
      },
    });
    const result = hasActiveDelegatedGitLifecycleIntegration(db, {
      key: "git",
      state: {
        mode: "direct",
        deniedTools: [],
        lastChangedAt: "2026-04-30T12:30:00.000Z",
      },
    });
    // override forces git back to direct; github is also not delegated → false
    expect(result).toBe(false);
  });

  it("start() arms the timer and scheduleNext fires tick() on expiry", async () => {
    vi.useFakeTimers();
    try {
      const db = freshDb();
      writeIntegrations(db, {
        git: {
          mode: "delegated",
          delegatedBackend: "codex",
          delegatedModel: "gpt-5.4-mini",
          deniedTools: [],
          lastChangedAt: "2026-04-30T12:00:00.000Z",
        },
      });
      const bus = new EventBus();
      const observer = new GitDelegatedCronObserver({
        db,
        eventBus: bus,
        repoPaths: ["/repo"],
        githubRepos: [],
        cadenceSeconds: 600,
        pushOverdueMinutes: 60,
        now: () => new Date("2026-04-30T12:00:00.000Z"),
      });

      await observer.start();
      expect((observer as unknown as { timer: unknown }).timer).not.toBeNull();

      await vi.advanceTimersByTimeAsync(600 * 1000);
      expect(bus.size).toBeGreaterThan(0);

      await observer.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("delays first tick by 30 min when hourlyCheckEnabled=true and cadenceSeconds=3600", async () => {
    vi.useFakeTimers();
    try {
      const db = freshDb();
      writeIntegrations(db, {
        git: {
          mode: "delegated",
          delegatedBackend: "codex",
          delegatedModel: "gpt-5.4-mini",
          deniedTools: [],
          lastChangedAt: "2026-04-30T12:00:00.000Z",
        },
      });
      const bus = new EventBus();
      const observer = new GitDelegatedCronObserver({
        db,
        eventBus: bus,
        repoPaths: ["/repo"],
        githubRepos: [],
        cadenceSeconds: 3600,
        pushOverdueMinutes: 60,
        hourlyCheckEnabled: true,
        now: () => new Date("2026-04-30T12:00:00.000Z"),
      });

      await observer.start();
      // Advance just under 30 minutes — tick must NOT have fired yet
      // The initial delay is 30 * 60 = 1800 seconds = 1,800,000 ms
      await vi.advanceTimersByTimeAsync(1800 * 1000 - 1);
      expect(bus.size).toBe(0);

      // Cross the 30-minute threshold — tick should now have fired
      await vi.advanceTimersByTimeAsync(2);
      expect(bus.size).toBeGreaterThan(0);

      await observer.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("scheduleNext returns early when stopped flag is true on entry", () => {
    vi.useFakeTimers();
    try {
      const db = freshDb();
      const bus = new EventBus();
      const observer = new GitDelegatedCronObserver({
        db,
        eventBus: bus,
        repoPaths: [],
        githubRepos: [],
        cadenceSeconds: 600,
        pushOverdueMinutes: 60,
      });

      // Simulate stopped state then call scheduleNext directly via the private method.
      (observer as unknown as { stopped: boolean }).stopped = true;
      const scheduleNext = (observer as unknown as { scheduleNext: (d: number) => void }).scheduleNext.bind(observer);
      scheduleNext(600);

      // Since stopped=true, scheduleNext must have returned early without arming a timer.
      expect((observer as unknown as { timer: unknown }).timer).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the default now() when no now option is provided", async () => {
    const db = freshDb();
    writeIntegrations(db, {
      git: {
        mode: "delegated",
        delegatedBackend: "codex",
        delegatedModel: "gpt-5.4-mini",
        deniedTools: [],
        lastChangedAt: "2026-04-30T12:00:00.000Z",
      },
    });
    const bus = new EventBus();
    const before = Date.now();
    const observer = new GitDelegatedCronObserver({
      db,
      eventBus: bus,
      repoPaths: ["/repo"],
      githubRepos: [],
      cadenceSeconds: 600,
      pushOverdueMinutes: 60,
      // deliberately omit `now` to exercise the default `() => new Date()` branch
    });
    await observer.tick();
    const after = Date.now();

    const event = (await bus.get()) as AgentTaskEvent;
    const firedAt = new Date(event.taskContext.firedAt as string).getTime();
    expect(firedAt).toBeGreaterThanOrEqual(before);
    expect(firedAt).toBeLessThanOrEqual(after);
  });
});
