import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.js";
import {
  createRepository,
  createTrigger,
  getTrigger,
} from "../db/repositories-store.js";
import { EventBus } from "./event-bus.js";
import { dispatchMatchingTriggers } from "./trigger-dispatch.js";
import type { AgentTaskEvent } from "@aitne/shared";

function seedDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return db;
}

function makeRepoWithTriggers(
  db: Database.Database,
  opts: {
    eventType: string;
    triggers: Array<{
      name: string;
      filters?: Record<string, unknown>;
      enabled?: boolean;
      workdirMode?: "temp" | "local-clone";
      instructionMd?: string;
    }>;
  },
): { repoId: string; triggerIds: string[] } {
  const repo = createRepository(db, {
    githubOwner: "acme",
    githubRepo: "widgets",
    localPath: "/code/widgets",
  });
  const triggerIds: string[] = [];
  for (const t of opts.triggers) {
    const created = createTrigger(db, repo.id, {
      name: t.name,
      eventType: opts.eventType,
      filters: t.filters,
      backend: "claude",
      model: "sonnet",
      workdirMode: t.workdirMode ?? "local-clone",
      prompt: `prompt for ${t.name}`,
      instructionMd: t.instructionMd,
      ...(t.enabled === false ? { enabled: false } : {}),
    });
    triggerIds.push(created.id);
  }
  return { repoId: repo.id, triggerIds };
}

describe("dispatchMatchingTriggers", () => {
  let db: Database.Database;
  let eventBus: EventBus;

  beforeEach(() => {
    db = seedDb();
    eventBus = new EventBus(100);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it("returns 0 when triggers exist but the repository row has been deleted out from under them", async () => {
    // Pin the `if (!repo) { ... return 0; }` branch in
    // dispatchMatchingTriggers. We reproduce the race by
    // disabling FK enforcement, creating a trigger, then deleting
    // the repository row before dispatch — modelling the case where
    // a repository deletion lands between the trigger lookup and
    // the repo lookup.
    const { repoId } = makeRepoWithTriggers(db, {
      eventType: "git.push.detected",
      triggers: [{ name: "first", filters: { branch: "main" } }],
    });
    db.pragma("foreign_keys = OFF");
    db.prepare("DELETE FROM repositories WHERE id = ?").run(repoId);
    db.pragma("foreign_keys = ON");

    const emitted = await dispatchMatchingTriggers(
      { db, eventBus },
      repoId,
      "git.push.detected",
      { branch: "main" },
    );
    expect(emitted).toBe(0);
    eventBus.close();
    expect(await eventBus.get()).toBeNull();
  });

  it("returns 0 and enqueues nothing when no triggers exist for the event type", async () => {
    const repo = createRepository(db, {
      githubOwner: "a",
      githubRepo: "b",
      localPath: "/code/a-b",
    });
    const emitted = await dispatchMatchingTriggers(
      { db, eventBus },
      repo.id,
      "git.push.detected",
      { branch: "main" },
    );
    expect(emitted).toBe(0);
    // Nothing on the bus
    eventBus.close();
    expect(await eventBus.get()).toBeNull();
  });

  it("returns 0 when triggers exist but filters reject the payload", async () => {
    const { repoId } = makeRepoWithTriggers(db, {
      eventType: "git.push.detected",
      triggers: [{ name: "main-only", filters: { branch: "main" } }],
    });
    const emitted = await dispatchMatchingTriggers(
      { db, eventBus },
      repoId,
      "git.push.detected",
      { branch: "feature/x" },
    );
    expect(emitted).toBe(0);
  });

  it("enqueues a scheduled.task event for each matching trigger and bumps fire counters", async () => {
    const { repoId, triggerIds } = makeRepoWithTriggers(db, {
      eventType: "git.push.detected",
      triggers: [
        { name: "first", filters: { branch: "main" } },
        { name: "second", filters: { branch: "main" } },
      ],
    });
    const emitted = await dispatchMatchingTriggers(
      { db, eventBus },
      repoId,
      "git.push.detected",
      { branch: "main", commits: [] },
    );
    expect(emitted).toBe(2);

    eventBus.close();
    const e1 = (await eventBus.get()) as AgentTaskEvent | null;
    const e2 = (await eventBus.get()) as AgentTaskEvent | null;
    expect(e1?.type).toBe("scheduled.task");
    expect(e2?.type).toBe("scheduled.task");
    expect(e1?.taskContext?.processKey).toBe("agent.task");
    expect(e1?.taskContext?.repositoryId).toBe(repoId);
    expect(e1?.taskContext?.triggerEventType).toBe("git.push.detected");
    expect(e1?.taskContext?.triggerEventPayload).toEqual({
      branch: "main",
      commits: [],
    });
    expect(e1?.requestedBackendId).toBe("claude");
    expect(e1?.requestedModelId).toBe("sonnet");

    for (const tid of triggerIds) {
      const after = getTrigger(db, tid);
      expect(after?.fireCount).toBe(1);
      expect(after?.lastFiredAt).not.toBeNull();
    }
  });

  it("propagates GitHub remote into taskContext when the repo has both sides", async () => {
    const { repoId } = makeRepoWithTriggers(db, {
      eventType: "git.push.detected",
      triggers: [{ name: "x", filters: { branch: "main" } }],
    });
    await dispatchMatchingTriggers(
      { db, eventBus },
      repoId,
      "git.push.detected",
      { branch: "main" },
    );
    eventBus.close();
    const event = (await eventBus.get()) as AgentTaskEvent;
    expect(event.taskContext?.githubRepo).toBe("acme/widgets");
  });

  it("uses null githubRepo for local-only repositories", async () => {
    const local = createRepository(db, {
      localPath: "/code/private-vault",
      localOnly: true,
    });
    createTrigger(db, local.id, {
      name: "local-trigger",
      eventType: "git.push.detected",
      backend: "claude",
      model: "sonnet",
      workdirMode: "local-clone",
      prompt: "p",
    });
    const emitted = await dispatchMatchingTriggers(
      { db, eventBus },
      local.id,
      "git.push.detected",
      { branch: "main" },
    );
    expect(emitted).toBe(1);
    eventBus.close();
    const event = (await eventBus.get()) as AgentTaskEvent;
    expect(event.taskContext?.githubRepo).toBeNull();
  });

  it("includes instructionMd in taskContext for temp-mode triggers", async () => {
    const { repoId } = makeRepoWithTriggers(db, {
      eventType: "git.push.detected",
      triggers: [
        {
          name: "temp",
          workdirMode: "temp",
          instructionMd: "you are a summarizer",
        },
      ],
    });
    await dispatchMatchingTriggers(
      { db, eventBus },
      repoId,
      "git.push.detected",
      { branch: "main" },
    );
    eventBus.close();
    const event = (await eventBus.get()) as AgentTaskEvent;
    expect(event.taskContext?.workdirMode).toBe("temp");
    expect(event.taskContext?.instructionMd).toBe("you are a summarizer");
  });

  it("returns 0 when the repository row was deleted between trigger insert and dispatch", async () => {
    const { repoId } = makeRepoWithTriggers(db, {
      eventType: "git.push.detected",
      triggers: [{ name: "orphan", filters: { branch: "main" } }],
    });
    // Delete the repository directly via SQL — bypasses CASCADE so the
    // trigger row remains and listEnabledTriggersForEvent still returns
    // it. dispatchMatchingTriggers must observe the missing repo and
    // refuse to dispatch.
    db.prepare("DELETE FROM repositories WHERE id = ?").run(repoId);
    const emitted = await dispatchMatchingTriggers(
      { db, eventBus },
      repoId,
      "git.push.detected",
      { branch: "main" },
    );
    expect(emitted).toBe(0);
  });

  it("isolates a single failing trigger and continues with the next", async () => {
    const { repoId, triggerIds } = makeRepoWithTriggers(db, {
      eventType: "git.push.detected",
      triggers: [
        { name: "fails", filters: { branch: "main" } },
        { name: "succeeds", filters: { branch: "main" } },
      ],
    });
    const realPut = eventBus.put.bind(eventBus);
    let call = 0;
    const spy = vi.spyOn(eventBus, "put").mockImplementation((event) => {
      call += 1;
      if (call === 1) {
        return Promise.reject(new Error("boom"));
      }
      return realPut(event);
    });
    const emitted = await dispatchMatchingTriggers(
      { db, eventBus },
      repoId,
      "git.push.detected",
      { branch: "main" },
    );
    expect(emitted).toBe(1);
    expect(spy).toHaveBeenCalledTimes(2);

    // Only the second trigger advanced its fire counter
    const t1 = getTrigger(db, triggerIds[0]);
    const t2 = getTrigger(db, triggerIds[1]);
    expect(t1?.fireCount).toBe(0);
    expect(t2?.fireCount).toBe(1);
  });

  it("returns 0 and never throws when listEnabledTriggersForEvent throws", async () => {
    db.close();
    // Calling on a closed DB raises a SqliteError; the outer try/catch
    // must swallow it.
    const emitted = await dispatchMatchingTriggers(
      { db, eventBus },
      "github:a/b",
      "git.push.detected",
      {},
    );
    expect(emitted).toBe(0);
    // Re-open so afterEach can close cleanly
    db = seedDb();
  });

  it("ignores disabled triggers (filtered by listEnabledTriggersForEvent)", async () => {
    const { repoId } = makeRepoWithTriggers(db, {
      eventType: "git.push.detected",
      triggers: [
        { name: "off", enabled: false, filters: { branch: "main" } },
      ],
    });
    const emitted = await dispatchMatchingTriggers(
      { db, eventBus },
      repoId,
      "git.push.detected",
      { branch: "main" },
    );
    expect(emitted).toBe(0);
  });
});
