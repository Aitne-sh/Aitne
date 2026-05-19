import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.js";
import { writeIntegrations } from "../db/integrations-store.js";
import { ObserverManager, type Observer } from "../observers/manager.js";
import {
  acquireIntegrationFlipLock,
  applyIntegrationModeChange,
  isIntegrationDaemonless,
  isIntegrationDelegated,
  isIntegrationNative,
  isIntegrationPollerless,
  readIntegrationFlipLock,
  releaseIntegrationFlipLock,
  shouldStartObserversFor,
} from "./integration-lifecycle.js";
import { DELEGATED_SYNC_OBSERVER_NAME } from "../observers/delegated-sync-worker.js";
import { GIT_DELEGATED_CRON_OBSERVER_NAME } from "../observers/git-delegated-cron.js";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function fakeObserver(name: string): Observer {
  return {
    name,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

describe("applyIntegrationModeChange", () => {
  it("starts gated observers when an integration enters direct mode", async () => {
    const observerManager = new ObserverManager();
    const built: Observer[] = [];
    const buildObserver = vi.fn((name: string) => {
      const obs = fakeObserver(name);
      built.push(obs);
      return obs;
    });

    await applyIntegrationModeChange(
      {
        db: freshDb(),
        observerManager,
        buildObserver,
      },
      "google_calendar",
      { mode: "delegated", delegatedBackend: "claude", deniedTools: [], lastChangedAt: "2026-04-19T10:00:00Z" },
      { mode: "direct", deniedTools: [], lastChangedAt: "2026-04-19T11:00:00Z" },
    );

    expect(buildObserver).toHaveBeenCalledWith("calendar");
    expect(observerManager.has("calendar")).toBe(true);
    expect(built[0].start).toHaveBeenCalledOnce();
  });

  it("stops gated observers when an integration leaves direct mode", async () => {
    const observerManager = new ObserverManager();
    const calendarObs = fakeObserver("calendar");
    observerManager.register(calendarObs);

    await applyIntegrationModeChange(
      {
        db: freshDb(),
        observerManager,
        buildObserver: () => null,
      },
      "google_calendar",
      { mode: "direct", deniedTools: [], lastChangedAt: "2026-04-19T10:00:00Z" },
      { mode: "delegated", delegatedBackend: "claude", deniedTools: [], lastChangedAt: "2026-04-19T11:00:00Z" },
    );

    expect(observerManager.has("calendar")).toBe(false);
    expect(calendarObs.stop).toHaveBeenCalledOnce();
  });

  it("skips observer side-effects when the mode change does not cross the direct boundary", async () => {
    // Note: rematerializeDmSessions still fires on this path — covered by
    // the dedicated suite below. Here we only assert observer isolation.
    const observerManager = new ObserverManager();
    const buildObserver = vi.fn();

    await applyIntegrationModeChange(
      { db: freshDb(), observerManager, buildObserver },
      "google_calendar",
      { mode: "delegated", delegatedBackend: "claude", deniedTools: [], lastChangedAt: "2026-04-19T10:00:00Z" },
      { mode: "delegated", delegatedBackend: "codex", deniedTools: [], lastChangedAt: "2026-04-19T11:00:00Z" },
    );

    expect(buildObserver).not.toHaveBeenCalled();
    expect(observerManager.getObservers()).toHaveLength(0);
  });

  it("warns and continues when buildObserver returns null", async () => {
    const observerManager = new ObserverManager();

    await applyIntegrationModeChange(
      {
        db: freshDb(),
        observerManager,
        buildObserver: () => null,
      },
      "google_calendar",
      { mode: "disabled", deniedTools: [], lastChangedAt: "2026-04-19T10:00:00Z" },
      { mode: "direct", deniedTools: [], lastChangedAt: "2026-04-19T11:00:00Z" },
    );

    expect(observerManager.has("calendar")).toBe(false);
  });

  it("does not start any observers when an integration's observersTouched list is empty", async () => {
    // gmail's observersTouched is empty (multi-provider poller — see
    // integrations.ts comment). The lifecycle still runs through the
    // direct boundary check but builds nothing.
    const observerManager = new ObserverManager();
    const buildObserver = vi.fn();

    await applyIntegrationModeChange(
      { db: freshDb(), observerManager, buildObserver },
      "gmail",
      { mode: "disabled", deniedTools: [], lastChangedAt: "2026-04-19T10:00:00Z" },
      { mode: "direct", deniedTools: [], lastChangedAt: "2026-04-19T11:00:00Z" },
    );

    expect(buildObserver).not.toHaveBeenCalled();
    expect(observerManager.getObservers()).toHaveLength(0);
  });

  it("logs no-op when integration leaves direct mode but observer was never registered", async () => {
    const observerManager = new ObserverManager();
    // No observer registered, so stopAndUnregister returns false.
    await applyIntegrationModeChange(
      {
        db: freshDb(),
        observerManager,
        buildObserver: () => null,
      },
      "google_calendar",
      { mode: "direct", deniedTools: [], lastChangedAt: "2026-04-19T10:00:00Z" },
      { mode: "delegated", delegatedBackend: "claude", deniedTools: [], lastChangedAt: "2026-04-19T11:00:00Z" },
    );
    expect(observerManager.has("calendar")).toBe(false);
  });

  it("starts notion-poller when notion enters direct mode", async () => {
    const observerManager = new ObserverManager();
    const built: Observer[] = [];
    const buildObserver = vi.fn((name: string) => {
      const obs = fakeObserver(name);
      built.push(obs);
      return obs;
    });

    await applyIntegrationModeChange(
      {
        db: freshDb(),
        observerManager,
        buildObserver,
      },
      "notion",
      { mode: "delegated", delegatedBackend: "claude", deniedTools: [], lastChangedAt: "2026-04-25T10:00:00Z" },
      { mode: "direct", deniedTools: [], lastChangedAt: "2026-04-25T11:00:00Z" },
    );

    expect(buildObserver).toHaveBeenCalledWith("notion-poller");
    expect(observerManager.has("notion-poller")).toBe(true);
    expect(built[0].start).toHaveBeenCalledOnce();
  });

  it("stops notion-poller when notion leaves direct mode", async () => {
    const observerManager = new ObserverManager();
    const notionObs = fakeObserver("notion-poller");
    observerManager.register(notionObs);

    await applyIntegrationModeChange(
      {
        db: freshDb(),
        observerManager,
        buildObserver: () => null,
      },
      "notion",
      { mode: "direct", deniedTools: [], lastChangedAt: "2026-04-25T10:00:00Z" },
      { mode: "delegated", delegatedBackend: "claude", deniedTools: [], lastChangedAt: "2026-04-25T11:00:00Z" },
    );

    expect(observerManager.has("notion-poller")).toBe(false);
    expect(notionObs.stop).toHaveBeenCalledOnce();
  });

  it("does not throw when an observer's start fails — logs and continues", async () => {
    const observerManager = new ObserverManager();
    const flaky: Observer = {
      name: "calendar",
      start: vi.fn().mockRejectedValue(new Error("api outage")),
      stop: vi.fn().mockResolvedValue(undefined),
    };

    await expect(
      applyIntegrationModeChange(
        { db: freshDb(), observerManager, buildObserver: () => flaky },
        "google_calendar",
        { mode: "disabled", deniedTools: [], lastChangedAt: "2026-04-19T10:00:00Z" },
        { mode: "direct", deniedTools: [], lastChangedAt: "2026-04-19T11:00:00Z" },
      ),
    ).resolves.not.toThrow();
  });

  it("starts delegated sync worker when an integration enters delegated mode", async () => {
    const observerManager = new ObserverManager();
    const worker = fakeObserver(DELEGATED_SYNC_OBSERVER_NAME);
    const buildDelegatedSyncWorker = vi.fn(() => worker);

    await applyIntegrationModeChange(
      {
        db: freshDb(),
        observerManager,
        buildObserver: () => null,
        buildDelegatedSyncWorker,
      },
      "google_calendar",
      { mode: "disabled", deniedTools: [], lastChangedAt: "2026-04-29T10:00:00Z" },
      { mode: "delegated", delegatedBackend: "claude", deniedTools: [], lastChangedAt: "2026-04-29T11:00:00Z" },
    );

    expect(buildDelegatedSyncWorker).toHaveBeenCalledOnce();
    expect(observerManager.has(DELEGATED_SYNC_OBSERVER_NAME)).toBe(true);
    expect(worker.start).toHaveBeenCalledOnce();
  });

  it("stops delegated sync worker when the last delegated integration leaves sync", async () => {
    const observerManager = new ObserverManager();
    const worker = fakeObserver(DELEGATED_SYNC_OBSERVER_NAME);
    observerManager.register(worker);

    await applyIntegrationModeChange(
      {
        db: freshDb(),
        observerManager,
        buildObserver: () => null,
        buildDelegatedSyncWorker: () => worker,
      },
      "google_calendar",
      { mode: "delegated", delegatedBackend: "claude", deniedTools: [], lastChangedAt: "2026-04-29T10:00:00Z" },
      { mode: "disabled", deniedTools: [], lastChangedAt: "2026-04-29T11:00:00Z" },
    );

    expect(observerManager.has(DELEGATED_SYNC_OBSERVER_NAME)).toBe(false);
    expect(worker.stop).toHaveBeenCalledOnce();
  });

  it("keeps delegated sync worker running while another integration still needs it", async () => {
    const db = freshDb();
    writeIntegrations(db, {
      gmail: {
        mode: "delegated",
        delegatedBackend: "codex",
        deniedTools: [],
        lastChangedAt: "2026-04-29T09:00:00Z",
      },
    });
    const observerManager = new ObserverManager();
    const worker = fakeObserver(DELEGATED_SYNC_OBSERVER_NAME);
    observerManager.register(worker);

    await applyIntegrationModeChange(
      {
        db,
        observerManager,
        buildObserver: () => null,
        buildDelegatedSyncWorker: () => worker,
      },
      "google_calendar",
      { mode: "delegated", delegatedBackend: "claude", deniedTools: [], lastChangedAt: "2026-04-29T10:00:00Z" },
      { mode: "disabled", deniedTools: [], lastChangedAt: "2026-04-29T11:00:00Z" },
    );

    expect(observerManager.has(DELEGATED_SYNC_OBSERVER_NAME)).toBe(true);
    expect(worker.stop).not.toHaveBeenCalled();
  });

  it("starts git delegated cron observer when git enters delegated mode", async () => {
    const observerManager = new ObserverManager();
    const cron = fakeObserver(GIT_DELEGATED_CRON_OBSERVER_NAME);
    const buildGitDelegatedCronObserver = vi.fn(() => cron);

    await applyIntegrationModeChange(
      {
        db: freshDb(),
        observerManager,
        buildObserver: () => null,
        buildGitDelegatedCronObserver,
      },
      "git",
      { mode: "direct", deniedTools: [], lastChangedAt: "2026-04-29T10:00:00Z" },
      { mode: "delegated", delegatedBackend: "claude", deniedTools: [], lastChangedAt: "2026-04-29T11:00:00Z" },
    );

    expect(buildGitDelegatedCronObserver).toHaveBeenCalledOnce();
    expect(observerManager.has(GIT_DELEGATED_CRON_OBSERVER_NAME)).toBe(true);
    expect(cron.start).toHaveBeenCalledOnce();
  });

  it("rebuilds the git delegated cron observer per call so config PATCHes propagate on the next mode flip", async () => {
    const db = freshDb();
    const observerManager = new ObserverManager();
    const builds: Observer[] = [];
    const buildGitDelegatedCronObserver = vi.fn(() => {
      const obs = fakeObserver(GIT_DELEGATED_CRON_OBSERVER_NAME);
      builds.push(obs);
      return obs;
    });

    // direct → delegated registers the first instance.
    await applyIntegrationModeChange(
      {
        db,
        observerManager,
        buildObserver: () => null,
        buildGitDelegatedCronObserver,
      },
      "git",
      { mode: "direct", deniedTools: [], lastChangedAt: "2026-04-29T10:00:00Z" },
      { mode: "delegated", delegatedBackend: "claude", deniedTools: [], lastChangedAt: "2026-04-29T11:00:00Z" },
    );
    writeIntegrations(db, {
      git: { mode: "delegated", delegatedBackend: "claude", deniedTools: [], lastChangedAt: "2026-04-29T11:00:00Z" },
    });

    // delegated → disabled stops it.
    await applyIntegrationModeChange(
      {
        db,
        observerManager,
        buildObserver: () => null,
        buildGitDelegatedCronObserver,
      },
      "git",
      { mode: "delegated", delegatedBackend: "claude", deniedTools: [], lastChangedAt: "2026-04-29T11:00:00Z" },
      { mode: "disabled", deniedTools: [], lastChangedAt: "2026-04-29T12:00:00Z" },
    );
    writeIntegrations(db, {
      git: { mode: "disabled", deniedTools: [], lastChangedAt: "2026-04-29T12:00:00Z" },
    });

    // disabled → delegated again must construct a fresh instance, not reuse
    // the prior one — that's how a `gitPollIntervalSeconds` PATCH made
    // between the two flips reaches the running observer.
    await applyIntegrationModeChange(
      {
        db,
        observerManager,
        buildObserver: () => null,
        buildGitDelegatedCronObserver,
      },
      "git",
      { mode: "disabled", deniedTools: [], lastChangedAt: "2026-04-29T12:00:00Z" },
      { mode: "delegated", delegatedBackend: "claude", deniedTools: [], lastChangedAt: "2026-04-29T13:00:00Z" },
    );

    expect(buildGitDelegatedCronObserver).toHaveBeenCalledTimes(2);
    expect(builds).toHaveLength(2);
    expect(builds[0]).not.toBe(builds[1]);
    expect(builds[0].stop).toHaveBeenCalledOnce();
    expect(builds[1].start).toHaveBeenCalledOnce();
  });

  it("keeps git delegated cron running while the other of git/github still needs it", async () => {
    const db = freshDb();
    writeIntegrations(db, {
      github: { mode: "delegated", delegatedBackend: "codex", deniedTools: [], lastChangedAt: "2026-04-29T09:00:00Z" },
    });
    const observerManager = new ObserverManager();
    const cron = fakeObserver(GIT_DELEGATED_CRON_OBSERVER_NAME);
    observerManager.register(cron);

    await applyIntegrationModeChange(
      {
        db,
        observerManager,
        buildObserver: () => null,
        buildGitDelegatedCronObserver: () => cron,
      },
      "git",
      { mode: "delegated", delegatedBackend: "claude", deniedTools: [], lastChangedAt: "2026-04-29T10:00:00Z" },
      { mode: "direct", deniedTools: [], lastChangedAt: "2026-04-29T11:00:00Z" },
    );

    expect(observerManager.has(GIT_DELEGATED_CRON_OBSERVER_NAME)).toBe(true);
    expect(cron.stop).not.toHaveBeenCalled();
  });

  it("does not start delegated sync worker when the per-integration kill switch is disabled", async () => {
    const observerManager = new ObserverManager();
    const buildDelegatedSyncWorker = vi.fn(() => fakeObserver(DELEGATED_SYNC_OBSERVER_NAME));

    await applyIntegrationModeChange(
      {
        db: freshDb(),
        observerManager,
        buildObserver: () => null,
        buildDelegatedSyncWorker,
      },
      "google_calendar",
      { mode: "disabled", deniedTools: [], lastChangedAt: "2026-04-29T10:00:00Z" },
      {
        mode: "delegated",
        delegatedBackend: "claude",
        delegatedSyncEnabled: false,
        deniedTools: [],
        lastChangedAt: "2026-04-29T11:00:00Z",
      },
    );

    expect(buildDelegatedSyncWorker).not.toHaveBeenCalled();
    expect(observerManager.has(DELEGATED_SYNC_OBSERVER_NAME)).toBe(false);
  });

  // DELEGATED-PROXY-API-DESIGN.md Phase F (§4.8) — re-materialize active
  // DM workdirs on every mode change so the unified skill body, mail
  // accounts, and per-backend instruction file reflect the new state on
  // the next turn without tearing down the SDK session.
  describe("rematerializeDmSessions hook (Phase F §4.8)", () => {
    it("fires on direct→delegated boundary flip", async () => {
      const observerManager = new ObserverManager();
      const rematerialize = vi.fn();

      await applyIntegrationModeChange(
        {
          db: freshDb(),
          observerManager,
          buildObserver: () => null,
          rematerializeDmSessions: rematerialize,
        },
        "google_calendar",
        { mode: "direct", deniedTools: [], lastChangedAt: "2026-04-25T10:00:00Z" },
        { mode: "delegated", delegatedBackend: "claude", deniedTools: [], lastChangedAt: "2026-04-25T11:00:00Z" },
      );

      expect(rematerialize).toHaveBeenCalledOnce();
      expect(rematerialize).toHaveBeenCalledWith(
        expect.stringContaining("integration_mode_change:google_calendar"),
      );
    });

    it("fires on delegated↔delegated backend swap (no direct-boundary flip)", async () => {
      // The pre-Phase-F early-return killed this case — observer flip is
      // unaffected by a backend swap, but the skill body's per-backend
      // tool listings change, so re-materialization MUST run.
      const observerManager = new ObserverManager();
      const rematerialize = vi.fn();
      const buildObserver = vi.fn();

      await applyIntegrationModeChange(
        {
          db: freshDb(),
          observerManager,
          buildObserver,
          rematerializeDmSessions: rematerialize,
        },
        "google_calendar",
        { mode: "delegated", delegatedBackend: "claude", deniedTools: [], lastChangedAt: "2026-04-25T10:00:00Z" },
        { mode: "delegated", delegatedBackend: "codex", deniedTools: [], lastChangedAt: "2026-04-25T11:00:00Z" },
      );

      expect(buildObserver).not.toHaveBeenCalled();
      expect(rematerialize).toHaveBeenCalledOnce();
    });

    it("fires on delegated→disabled (no direct-boundary flip)", async () => {
      const observerManager = new ObserverManager();
      const rematerialize = vi.fn();

      await applyIntegrationModeChange(
        {
          db: freshDb(),
          observerManager,
          buildObserver: () => null,
          rematerializeDmSessions: rematerialize,
        },
        "google_calendar",
        { mode: "delegated", delegatedBackend: "claude", deniedTools: [], lastChangedAt: "2026-04-25T10:00:00Z" },
        { mode: "disabled", deniedTools: [], lastChangedAt: "2026-04-25T11:00:00Z" },
      );

      expect(rematerialize).toHaveBeenCalledOnce();
    });

    it("does not throw when the rematerialize callback throws — DB state already committed", async () => {
      const observerManager = new ObserverManager();
      const rematerialize = vi.fn().mockImplementation(() => {
        throw new Error("workdir refresh exploded");
      });

      await expect(
        applyIntegrationModeChange(
          {
            db: freshDb(),
            observerManager,
            buildObserver: () => null,
            rematerializeDmSessions: rematerialize,
          },
          "google_calendar",
          { mode: "direct", deniedTools: [], lastChangedAt: "2026-04-25T10:00:00Z" },
          { mode: "delegated", delegatedBackend: "claude", deniedTools: [], lastChangedAt: "2026-04-25T11:00:00Z" },
        ),
      ).resolves.not.toThrow();

      expect(rematerialize).toHaveBeenCalledOnce();
    });

    it("is omittable — legacy callers without the hook still work", async () => {
      // The callback is optional so test harnesses and the boot-time
      // catchup path don't need to thread it.
      const observerManager = new ObserverManager();

      await expect(
        applyIntegrationModeChange(
          { db: freshDb(), observerManager, buildObserver: () => null },
          "google_calendar",
          { mode: "delegated", delegatedBackend: "claude", deniedTools: [], lastChangedAt: "2026-04-25T10:00:00Z" },
          { mode: "delegated", delegatedBackend: "codex", deniedTools: [], lastChangedAt: "2026-04-25T11:00:00Z" },
        ),
      ).resolves.not.toThrow();
    });
  });
});

describe("applyIntegrationModeChange — Phase 7 (b) snapshot partition cleanup", () => {
  function seedSnapshotRow(
    db: Database.Database,
    integration: string,
    windowKey: string,
    itemId: string,
  ): void {
    db.prepare(
      `INSERT INTO integration_snapshots
         (integration, window_key, item_id, content_hash, payload_json,
          item_start, fetched_at, actor_hint)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'user')`,
    ).run(
      integration,
      windowKey,
      itemId,
      "deadbeef",
      JSON.stringify({ id: itemId }),
      null,
      new Date().toISOString(),
    );
    db.prepare(
      `INSERT INTO runtime_state (key, value_json, updated_at)
       VALUES (?, 'true', CURRENT_TIMESTAMP)`,
    ).run(`integration_snapshot_initialized:${integration}:${windowKey}`);
  }

  function snapshotRowCount(
    db: Database.Database,
    integration: string,
    windowKey: string,
  ): number {
    return (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM integration_snapshots WHERE integration = ? AND window_key = ?",
        )
        .get(integration, windowKey) as { n: number }
    ).n;
  }

  function partitionInitExists(
    db: Database.Database,
    integration: string,
    windowKey: string,
  ): boolean {
    return (
      db
        .prepare("SELECT 1 FROM runtime_state WHERE key = ?")
        .get(`integration_snapshot_initialized:${integration}:${windowKey}`)
        !== undefined
    );
  }

  it("purges direct partitions when google_calendar enters delegated mode", async () => {
    const db = freshDb();
    seedSnapshotRow(db, "google_calendar", "primary:14d", "evt-direct");

    await applyIntegrationModeChange(
      { db, observerManager: new ObserverManager(), buildObserver: () => null },
      "google_calendar",
      { mode: "direct", deniedTools: [], lastChangedAt: "2026-04-19T10:00:00Z" },
      {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-04-19T11:00:00Z",
      },
    );

    expect(snapshotRowCount(db, "google_calendar", "primary:14d")).toBe(0);
    expect(partitionInitExists(db, "google_calendar", "primary:14d")).toBe(false);
  });

  it("purges delegated partitions when google_calendar enters direct mode", async () => {
    const db = freshDb();
    seedSnapshotRow(db, "google_calendar", "primary:imminent", "evt-imm");
    seedSnapshotRow(db, "google_calendar", "primary:24h", "evt-24h");
    // primary:14d is owned by direct mode; the flip to direct must NOT
    // purge it.
    seedSnapshotRow(db, "google_calendar", "primary:14d", "evt-stale");

    await applyIntegrationModeChange(
      { db, observerManager: new ObserverManager(), buildObserver: () => fakeObserver("calendar") },
      "google_calendar",
      {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-04-19T10:00:00Z",
      },
      { mode: "direct", deniedTools: [], lastChangedAt: "2026-04-19T11:00:00Z" },
    );

    expect(snapshotRowCount(db, "google_calendar", "primary:imminent")).toBe(0);
    expect(snapshotRowCount(db, "google_calendar", "primary:24h")).toBe(0);
    // The direct partition's existing row should remain — Phase 7 only
    // purges partitions whose writer is going away.
    expect(snapshotRowCount(db, "google_calendar", "primary:14d")).toBe(1);
  });

  it("purges gmail's inbox:7d when delegation is disabled", async () => {
    const db = freshDb();
    seedSnapshotRow(db, "gmail", "inbox:7d", "thread-1");

    await applyIntegrationModeChange(
      { db, observerManager: new ObserverManager(), buildObserver: () => null },
      "gmail",
      {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-04-19T10:00:00Z",
      },
      { mode: "disabled", deniedTools: [], lastChangedAt: "2026-04-19T11:00:00Z" },
    );

    expect(snapshotRowCount(db, "gmail", "inbox:7d")).toBe(0);
  });

  it("warns and continues when buildDelegatedSyncWorker returns null", async () => {
    // buildDelegatedSyncWorker may return null when the underlying invoker
    // has not initialized yet (boot-time race). Lifecycle must log warn
    // and leave the worker absent so the next mode change can retry.
    const observerManager = new ObserverManager();
    await applyIntegrationModeChange(
      {
        db: freshDb(),
        observerManager,
        buildObserver: () => null,
        buildDelegatedSyncWorker: () => null,
      },
      "google_calendar",
      { mode: "direct", deniedTools: [], lastChangedAt: "2026-04-19T10:00:00Z" },
      {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-04-19T11:00:00Z",
      },
    );
    expect(observerManager.has(DELEGATED_SYNC_OBSERVER_NAME)).toBe(false);
  });

  it("logs error and continues when delegated sync worker registerAndStart throws", async () => {
    const observerManager = new ObserverManager();
    const exploding = {
      name: DELEGATED_SYNC_OBSERVER_NAME,
      start: vi.fn().mockRejectedValue(new Error("simulated worker boot fail")),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    await expect(
      applyIntegrationModeChange(
        {
          db: freshDb(),
          observerManager,
          buildObserver: () => null,
          buildDelegatedSyncWorker: () => exploding,
        },
        "google_calendar",
        { mode: "direct", deniedTools: [], lastChangedAt: "2026-04-19T10:00:00Z" },
        {
          mode: "delegated",
          delegatedBackend: "claude",
          deniedTools: [],
          lastChangedAt: "2026-04-19T11:00:00Z",
        },
      ),
    ).resolves.not.toThrow();
    // The thrower's `start` was invoked but the failure was swallowed.
    expect(exploding.start).toHaveBeenCalledOnce();
  });

  it("does not purge anything when prev.mode === next.mode", async () => {
    // delegated→delegated backend swap leaves the delegated partitions
    // intact — the writer is still the same, just on a different backend.
    const db = freshDb();
    seedSnapshotRow(db, "notion", "recently_updated", "page-1");

    await applyIntegrationModeChange(
      { db, observerManager: new ObserverManager(), buildObserver: () => null },
      "notion",
      {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-04-19T10:00:00Z",
      },
      {
        mode: "delegated",
        delegatedBackend: "codex",
        deniedTools: [],
        lastChangedAt: "2026-04-19T11:00:00Z",
      },
    );

    expect(snapshotRowCount(db, "notion", "recently_updated")).toBe(1);
  });
});

describe("applyGitDelegatedCronLifecycle defensive paths", () => {
  it("logs and continues when the git delegated cron observer fails to register", async () => {
    // Pin the catch branch in applyGitDelegatedCronLifecycle: a failing
    // registerAndStart must not bubble up and abort the wider mode-change
    // flow (other lifecycle effects still run after it).
    const db = freshDb();
    const observerManager = new ObserverManager();
    const failing = fakeObserver(GIT_DELEGATED_CRON_OBSERVER_NAME);
    (failing.start as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("boot failure"),
    );

    await expect(
      applyIntegrationModeChange(
        {
          db,
          observerManager,
          buildObserver: () => null,
          buildGitDelegatedCronObserver: () => failing,
        },
        "git",
        { mode: "direct", deniedTools: [], lastChangedAt: "2026-04-29T10:00:00Z" },
        {
          mode: "delegated",
          delegatedBackend: "claude",
          deniedTools: [],
          lastChangedAt: "2026-04-29T11:00:00Z",
        },
      ),
    ).resolves.toBeUndefined();
    // ObserverManager.registerAndStart leaves the observer registered
    // even when start() throws — the integration-lifecycle catch
    // simply logs and continues. Pin the start failure was observed
    // so the catch path actually fired.
    expect(failing.start).toHaveBeenCalledOnce();
  });

  it("logs `already absent` when neither git nor github is in delegated mode and no cron is running", async () => {
    // Pin the `removed === false` branch of the post-stop ternary log.
    // Direct → disabled flip with no cron registered → stopAndUnregister
    // returns false → the "already absent" log fires.
    const db = freshDb();
    const observerManager = new ObserverManager();

    await applyIntegrationModeChange(
      {
        db,
        observerManager,
        buildObserver: () => null,
        buildGitDelegatedCronObserver: () =>
          fakeObserver(GIT_DELEGATED_CRON_OBSERVER_NAME),
      },
      "git",
      { mode: "direct", deniedTools: [], lastChangedAt: "2026-04-29T10:00:00Z" },
      { mode: "disabled", deniedTools: [], lastChangedAt: "2026-04-29T11:00:00Z" },
    );
    // No cron should be running — the `already absent` info-log path
    // executed without registering anything.
    expect(observerManager.has(GIT_DELEGATED_CRON_OBSERVER_NAME)).toBe(false);
  });

  it("skips git delegated cron side-effects when buildGitDelegatedCronObserver is not provided", async () => {
    // Exercises the early-return branch at `if (!deps.buildGitDelegatedCronObserver) return`
    // (line 170). The git/github key guard passes, but without the factory the
    // function must exit gracefully without touching the observer manager.
    const db = freshDb();
    const observerManager = new ObserverManager();

    await expect(
      applyIntegrationModeChange(
        { db, observerManager, buildObserver: () => null },
        "git",
        { mode: "direct", deniedTools: [], lastChangedAt: "2026-04-29T10:00:00Z" },
        {
          mode: "delegated",
          delegatedBackend: "claude",
          deniedTools: [],
          lastChangedAt: "2026-04-29T11:00:00Z",
        },
      ),
    ).resolves.toBeUndefined();

    expect(observerManager.has(GIT_DELEGATED_CRON_OBSERVER_NAME)).toBe(false);
  });
});

describe("shouldStartObserversFor", () => {
  it("returns true when the stored state is direct", () => {
    const db = freshDb();
    writeIntegrations(db, {
      google_calendar: { mode: "direct", deniedTools: [], lastChangedAt: "2026-04-19T10:00:00Z" },
    });
    expect(shouldStartObserversFor(db, "google_calendar")).toBe(true);
  });

  it("returns false for delegated", () => {
    const db = freshDb();
    writeIntegrations(db, {
      google_calendar: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-04-19T10:00:00Z",
      },
    });
    expect(shouldStartObserversFor(db, "google_calendar")).toBe(false);
  });

  it("returns false for disabled (the install default)", () => {
    const db = freshDb();
    expect(shouldStartObserversFor(db, "google_calendar")).toBe(false);
  });
});

describe("isIntegrationDelegated", () => {
  it("returns true only for delegated mode", () => {
    const db = freshDb();
    writeIntegrations(db, {
      gmail: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-04-19T10:00:00Z",
      },
    });
    expect(isIntegrationDelegated(db, "gmail")).toBe(true);
  });

  it("returns false for direct and disabled", () => {
    const db = freshDb();
    writeIntegrations(db, {
      gmail: { mode: "direct", deniedTools: [], lastChangedAt: "2026-04-19T10:00:00Z" },
    });
    expect(isIntegrationDelegated(db, "gmail")).toBe(false);
    // Default for an unconfigured key is `disabled`.
    expect(isIntegrationDelegated(db, "notion")).toBe(false);
  });
});

// INTEGRATION_NATIVE_MODE_DESIGN.md §5.6 — the predicate that lets
// multi-provider surfaces (MailPoller in Phase A; route gates in Phase B1)
// skip per-account when an integration's data path is owned by something
// other than the daemon poller. Phase A covers `delegated` and `disabled`;
// Phase B1 will extend the predicate to also return true for `native`.
describe("isIntegrationPollerless", () => {
  it("returns false for direct mode", () => {
    const db = freshDb();
    writeIntegrations(db, {
      gmail: {
        mode: "direct",
        deniedTools: [],
        lastChangedAt: "2026-04-19T10:00:00Z",
      },
    });
    expect(isIntegrationPollerless(db, "gmail")).toBe(false);
  });

  it("returns true for delegated mode", () => {
    const db = freshDb();
    writeIntegrations(db, {
      gmail: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-04-19T10:00:00Z",
      },
    });
    expect(isIntegrationPollerless(db, "gmail")).toBe(true);
  });

  it("returns true for disabled mode — Phase A bug fix", () => {
    const db = freshDb();
    writeIntegrations(db, {
      gmail: {
        mode: "disabled",
        deniedTools: [],
        lastChangedAt: "2026-04-19T10:00:00Z",
      },
    });
    expect(isIntegrationPollerless(db, "gmail")).toBe(true);
  });

  it("returns true for an unconfigured key (install default is disabled)", () => {
    const db = freshDb();
    // No write — `notion`'s install default is `disabled`, so the
    // predicate must report poller-less even without explicit config.
    expect(isIntegrationPollerless(db, "notion")).toBe(true);
  });
});

// ── INTEGRATION_NATIVE_MODE_DESIGN.md Phase B1 ──────────────────────────────

describe("isIntegrationNative (§5.6)", () => {
  it("returns true only when mode is native", () => {
    const db = freshDb();
    writeIntegrations(db, {
      gmail: {
        mode: "native",
        nativeBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-05-11T00:00:00Z",
      },
    });
    expect(isIntegrationNative(db, "gmail")).toBe(true);
    expect(isIntegrationNative(db, "google_calendar")).toBe(false);
  });

  it("returns false for delegated, direct, and disabled", () => {
    const db = freshDb();
    writeIntegrations(db, {
      gmail: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-05-11T00:00:00Z",
      },
      google_calendar: {
        mode: "direct",
        deniedTools: [],
        lastChangedAt: "2026-05-11T00:00:00Z",
      },
      // notion stays at default (disabled)
    });
    expect(isIntegrationNative(db, "gmail")).toBe(false);
    expect(isIntegrationNative(db, "google_calendar")).toBe(false);
    expect(isIntegrationNative(db, "notion")).toBe(false);
  });
});

describe("isIntegrationDaemonless (§5.6)", () => {
  it("returns true for native and disabled, false for direct and delegated", () => {
    const db = freshDb();
    writeIntegrations(db, {
      gmail: {
        mode: "native",
        nativeBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-05-11T00:00:00Z",
      },
      google_calendar: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-05-11T00:00:00Z",
      },
      // notion stays at default disabled
    });
    expect(isIntegrationDaemonless(db, "gmail")).toBe(true);
    expect(isIntegrationDaemonless(db, "google_calendar")).toBe(false);
    expect(isIntegrationDaemonless(db, "notion")).toBe(true);
  });
});

describe("isIntegrationPollerless — native mode (§5.6 widened)", () => {
  it("recognises native mode as pollerless", () => {
    const db = freshDb();
    writeIntegrations(db, {
      gmail: {
        mode: "native",
        nativeBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-05-11T00:00:00Z",
      },
    });
    expect(isIntegrationPollerless(db, "gmail")).toBe(true);
  });
});

describe("Integration flip lock (§11.3.1)", () => {
  it("acquires and reads back a fresh lock", () => {
    const db = freshDb();
    const result = acquireIntegrationFlipLock(db, "gmail");
    expect(result.ok).toBe(true);
    const readBack = readIntegrationFlipLock(db, "gmail");
    expect(readBack).not.toBeNull();
    expect(readBack?.byKey).toBe("gmail");
    expect(readBack?.processId).toBe(process.pid);
  });

  it("rejects a second acquire on the same key while the first lock is fresh", () => {
    const db = freshDb();
    const now = Date.parse("2026-05-11T12:00:00.000Z");
    const first = acquireIntegrationFlipLock(db, "gmail", now);
    expect(first.ok).toBe(true);
    // 10 seconds later → still well under STALE_LOCK_MS (30s).
    const second = acquireIntegrationFlipLock(db, "gmail", now + 10_000);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.current.byKey).toBe("gmail");
    }
  });

  it("reclaims a stale lock older than STALE_LOCK_MS", () => {
    const db = freshDb();
    const t0 = Date.parse("2026-05-11T12:00:00.000Z");
    const first = acquireIntegrationFlipLock(db, "gmail", t0);
    expect(first.ok).toBe(true);
    // 60 seconds later — past the 30s staleness threshold.
    const second = acquireIntegrationFlipLock(db, "gmail", t0 + 60_000);
    expect(second.ok).toBe(true);
  });

  it("allows concurrent flips on different keys", () => {
    const db = freshDb();
    const a = acquireIntegrationFlipLock(db, "gmail");
    const b = acquireIntegrationFlipLock(db, "google_calendar");
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  it("releases the lock so the next acquire succeeds", () => {
    const db = freshDb();
    acquireIntegrationFlipLock(db, "gmail");
    releaseIntegrationFlipLock(db, "gmail");
    expect(readIntegrationFlipLock(db, "gmail")).toBeNull();
    const next = acquireIntegrationFlipLock(db, "gmail");
    expect(next.ok).toBe(true);
  });
});
