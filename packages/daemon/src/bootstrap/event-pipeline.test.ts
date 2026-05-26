/**
 * Peer tests for `./event-pipeline.ts` (bootstrap factory).
 *
 * Scope: per `docs/design/appendices/index-bootstrap-stage-split.md` §10,
 * pin the invariants the pre-split inline §10 of `index.ts` owned but had
 * no isolated test for:
 *
 *   1. handleSecretChange routing matrix — every supported scope value
 *      (`slack`, `telegram`, `discord`, `notion`, `github`, `google`,
 *      `apple_calendar`, `apiToken`, unknown) invokes exactly the right
 *      reloader / hot-register helper. Spies on the injected reloader
 *      records prove "nothing else fired."
 *   2. Notion hot-register branches — pin the three gates
 *      (`services.notion`, `observerManager.has("notion-poller")`,
 *      `notionDatabaseIds.length`, `shouldStartObserversFor(db, "notion")`)
 *      that decide whether the post-reload register runs.
 *   3. GitHub webhook-mode upgrade — pin the two gates
 *      (`getGitWatcher()` non-null, `secretState.githubWebhookConfigured`)
 *      that decide whether `enableWebhookMode()` is called on the live
 *      watcher.
 *   4. handleGoogleServicesReady morning-routine gate — stale `today.md`
 *      → `queueMorningRoutineWake("google_auth_ready")` and skip the
 *      standalone roadmap refresh; fresh `today.md` + stale roadmap →
 *      `emitRoadmapRefresh("google_auth_ready")`.
 *   5. handleGoogleServicesReady calendar hot-register — `services.calendar`
 *      set + `google_calendar` in `direct` + no existing observer → build
 *      and start the poller; otherwise skip.
 *
 * The factory has a wide `BootstrapEventPipelineDeps` surface (Phase B-4
 * lifts every subsystem instance through here). Most fields are inert for
 * the assertions we make and are filled in with no-op stubs; only the
 * bits we exercise (db, config, services, secret state, observer manager,
 * the reloader spies) carry real behavior. The helpers below export each
 * cross-stage closure factory standalone — `createSecretChangeHandler`
 * and `createGoogleServicesReadyHandler` — so the tests can pin behavior
 * without booting the full event-pipeline (which would spin up four agent
 * cores, an opencode server manager, the auth keepalive timer, etc.).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { applySchema } from "../db/schema.js";
import { writeIntegrations } from "../db/integrations-store.js";
import { ObserverManager } from "../observers/manager.js";
import { createServiceRegistry } from "../services/service-registry.js";
import {
  createSecretChangeHandler,
  createGoogleServicesReadyHandler,
  type SecretChangeHandlerDeps,
  type GoogleServicesReadyHandlerDeps,
} from "./event-pipeline.js";
import { createInitialSecretState } from "./services.js";
import type { AgentConfig } from "../config.js";
import type { NotionPoller } from "../observers/notion-poller.js";
import type { CalendarPoller } from "../observers/calendar-poller.js";
import type { GitWatcher } from "../observers/git-watcher.js";

// ── Test doubles ─────────────────────────────────────────────────────────────

/**
 * Stand-in for a poller (Notion / Calendar). `start()` is a spy so the test
 * can assert hot-register kicked off the poll loop. `name` matches the
 * key used by ObserverManager.has() so registration is observable.
 */
function fakePoller<T extends string>(name: T): { name: T; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> } {
  return {
    name,
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
}

/**
 * Stand-in for a GitWatcher. Only the methods the github branch touches
 * matter — everything else throws so an over-broad test catches drift.
 */
function fakeGitWatcher(): {
  enableWebhookMode: ReturnType<typeof vi.fn>;
} {
  return {
    enableWebhookMode: vi.fn(),
  };
}

function makeReloaderSpies(): {
  reloadSlackAdapter: ReturnType<typeof vi.fn>;
  reloadTelegramAdapter: ReturnType<typeof vi.fn>;
  reloadDiscordAdapter: ReturnType<typeof vi.fn>;
  reloadNotionService: ReturnType<typeof vi.fn>;
  reloadGitHubService: ReturnType<typeof vi.fn>;
  reloadGoogleServices: ReturnType<typeof vi.fn>;
  reloadAppleCalendarService: ReturnType<typeof vi.fn>;
} {
  return {
    reloadSlackAdapter: vi.fn(async () => undefined),
    reloadTelegramAdapter: vi.fn(async () => undefined),
    reloadDiscordAdapter: vi.fn(async () => undefined),
    reloadNotionService: vi.fn(async () => undefined),
    reloadGitHubService: vi.fn(async () => undefined),
    reloadGoogleServices: vi.fn(async () => undefined),
    reloadAppleCalendarService: vi.fn(async () => undefined),
  };
}

/**
 * Assert that exactly one reloader was called and the rest stayed quiet.
 * Pinning the negative half of the matrix makes a future regression that
 * widens a scope to fire two reloaders impossible to miss.
 */
function expectExactlyOneReloaderCalled(
  spies: ReturnType<typeof makeReloaderSpies>,
  expectedKey: keyof ReturnType<typeof makeReloaderSpies>,
): void {
  for (const [key, spy] of Object.entries(spies)) {
    if (key === expectedKey) {
      expect(spy, `${key} should have been called`).toHaveBeenCalledTimes(1);
    } else {
      expect(spy, `${key} should NOT have been called`).not.toHaveBeenCalled();
    }
  }
}

function makeAgentConfig(
  tmpDir: string,
  overrides: Partial<AgentConfig> = {},
): AgentConfig {
  return {
    dataDir: tmpDir,
    workspaceDir: tmpDir,
    apiPort: 8321,
    timezone: "UTC",
    dayBoundaryHour: 4,
    notionDatabaseIds: {},
    ...overrides,
  } as unknown as AgentConfig;
}

function setIntegrationMode(
  db: Database.Database,
  key: "notion" | "google_calendar",
  mode: "direct" | "delegated" | "native" | "disabled",
): void {
  // `mode === "delegated"` requires a `delegatedBackend`; pin claude so the
  // schema validates regardless of which mode the test selects. The other
  // modes ignore the field per the §5.2 mutual-exclusion superRefine, so
  // we omit it unless needed.
  const state: Record<string, unknown> = {
    mode,
    lastChangedAt: new Date().toISOString(),
    deniedTools: [],
  };
  if (mode === "delegated") state.delegatedBackend = "claude";
  if (mode === "native") state.nativeBackend = "claude";
  writeIntegrations(db, { [key]: state } as never);
}

// ── handleSecretChange — scope routing matrix ───────────────────────────────

describe("createSecretChangeHandler", () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pa-event-pipeline-test-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    try {
      db?.close();
    } catch {
      /* may already be closed */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function buildDeps(
    overrides: Partial<SecretChangeHandlerDeps> = {},
  ): {
    deps: SecretChangeHandlerDeps;
    spies: ReturnType<typeof makeReloaderSpies>;
    observerManager: ObserverManager;
  } {
    const spies = makeReloaderSpies();
    const observerManager = new ObserverManager();
    const deps: SecretChangeHandlerDeps = {
      db,
      config: makeAgentConfig(tmpDir),
      services: createServiceRegistry(),
      observerManager,
      secretState: createInitialSecretState(),
      buildNotionPoller: () => null,
      getGitWatcher: () => null,
      // Default: bootstrap window has finished — matches the long-tail
      // production state. The race-window test below overrides this to
      // exercise the gated-start branch.
      isStartupComplete: () => true,
      ...spies,
      ...overrides,
    };
    return { deps, spies, observerManager };
  }

  for (const [scope, expectedKey] of [
    ["slack", "reloadSlackAdapter"],
    ["telegram", "reloadTelegramAdapter"],
    ["discord", "reloadDiscordAdapter"],
    ["google", "reloadGoogleServices"],
    ["apple_calendar", "reloadAppleCalendarService"],
  ] as const) {
    it(`routes "${scope}" to ${expectedKey} only`, async () => {
      const { deps, spies } = buildDeps();
      const handle = createSecretChangeHandler(deps);
      await handle(scope);
      expectExactlyOneReloaderCalled(spies, expectedKey);
    });
  }

  it("routes \"slack\" with force=true", async () => {
    const { deps, spies } = buildDeps();
    const handle = createSecretChangeHandler(deps);
    await handle("slack");
    expect(spies.reloadSlackAdapter).toHaveBeenCalledWith(true);
  });

  it("routes \"telegram\" with force=true", async () => {
    const { deps, spies } = buildDeps();
    const handle = createSecretChangeHandler(deps);
    await handle("telegram");
    expect(spies.reloadTelegramAdapter).toHaveBeenCalledWith(true);
  });

  it("routes \"discord\" with force=true", async () => {
    const { deps, spies } = buildDeps();
    const handle = createSecretChangeHandler(deps);
    await handle("discord");
    expect(spies.reloadDiscordAdapter).toHaveBeenCalledWith(true);
  });

  it("noops on \"apiToken\"", async () => {
    const { deps, spies } = buildDeps();
    const handle = createSecretChangeHandler(deps);
    await handle("apiToken");
    for (const spy of Object.values(spies)) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("noops on unknown scope (forward-compat for new secret kinds)", async () => {
    const { deps, spies } = buildDeps();
    const handle = createSecretChangeHandler(deps);
    await handle("some-future-scope");
    for (const spy of Object.values(spies)) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  // ── "notion" hot-register branches (design test bullet 4) ──
  describe("notion hot-register", () => {
    it("always reloads the notion service, and nothing else", async () => {
      const { deps, spies } = buildDeps();
      const handle = createSecretChangeHandler(deps);
      await handle("notion");
      expectExactlyOneReloaderCalled(spies, "reloadNotionService");
    });

    it("registers + starts a poller when all four gates pass", async () => {
      const poller = fakePoller("notion-poller");
      setIntegrationMode(db, "notion", "direct");
      const services = createServiceRegistry();
      services.notion = {} as never;
      const { deps, observerManager } = buildDeps({
        services,
        config: makeAgentConfig(tmpDir, {
          notionDatabaseIds: { primary: "abc123" },
        }),
        buildNotionPoller: () => poller as unknown as NotionPoller,
      });
      const handle = createSecretChangeHandler(deps);
      await handle("notion");
      expect(observerManager.has("notion-poller")).toBe(true);
      expect(poller.start).toHaveBeenCalledTimes(1);
    });

    it("skips when services.notion is null", async () => {
      setIntegrationMode(db, "notion", "direct");
      const buildPoller = vi.fn(
        () => fakePoller("notion-poller") as unknown as NotionPoller,
      );
      const { deps } = buildDeps({
        config: makeAgentConfig(tmpDir, {
          notionDatabaseIds: { primary: "abc123" },
        }),
        buildNotionPoller: buildPoller,
      });
      const handle = createSecretChangeHandler(deps);
      await handle("notion");
      expect(buildPoller).not.toHaveBeenCalled();
    });

    it("skips when the poller is already registered (idempotent)", async () => {
      const existingPoller = fakePoller("notion-poller");
      setIntegrationMode(db, "notion", "direct");
      const services = createServiceRegistry();
      services.notion = {} as never;
      const observerManager = new ObserverManager();
      observerManager.register(existingPoller as never);
      const buildPoller = vi.fn(
        () => fakePoller("notion-poller") as unknown as NotionPoller,
      );
      const { deps } = buildDeps({
        services,
        observerManager,
        config: makeAgentConfig(tmpDir, {
          notionDatabaseIds: { primary: "abc123" },
        }),
        buildNotionPoller: buildPoller,
      });
      const handle = createSecretChangeHandler(deps);
      await handle("notion");
      expect(buildPoller).not.toHaveBeenCalled();
      expect(existingPoller.start).not.toHaveBeenCalled();
    });

    it("skips when notionDatabaseIds is empty", async () => {
      setIntegrationMode(db, "notion", "direct");
      const services = createServiceRegistry();
      services.notion = {} as never;
      const buildPoller = vi.fn(
        () => fakePoller("notion-poller") as unknown as NotionPoller,
      );
      const { deps } = buildDeps({
        services,
        buildNotionPoller: buildPoller,
        // notionDatabaseIds defaults to {}
      });
      const handle = createSecretChangeHandler(deps);
      await handle("notion");
      expect(buildPoller).not.toHaveBeenCalled();
    });

    it("registers but does NOT start the poller during the bootstrap window", async () => {
      // Pre-startup: API listener is live but observerManager.startAll()
      // has not run yet. The handler must register the poller (so
      // startAll picks it up) WITHOUT calling start() — otherwise the
      // pending startAll() would call start() a second time and leak the
      // first setInterval handle (NotionPoller.start unconditionally
      // overwrites this.timer; see notion-poller.ts:91).
      const poller = fakePoller("notion-poller");
      setIntegrationMode(db, "notion", "direct");
      const services = createServiceRegistry();
      services.notion = {} as never;
      const { deps, observerManager } = buildDeps({
        services,
        config: makeAgentConfig(tmpDir, {
          notionDatabaseIds: { primary: "abc123" },
        }),
        buildNotionPoller: () => poller as unknown as NotionPoller,
        isStartupComplete: () => false,
      });
      const handle = createSecretChangeHandler(deps);
      await handle("notion");
      // Observer is registered so startAll() will start it.
      expect(observerManager.has("notion-poller")).toBe(true);
      // But the handler itself MUST NOT have called start().
      expect(poller.start).not.toHaveBeenCalled();
    });

    it("skips when notion integration is not in direct mode", async () => {
      setIntegrationMode(db, "notion", "delegated");
      const services = createServiceRegistry();
      services.notion = {} as never;
      const buildPoller = vi.fn(
        () => fakePoller("notion-poller") as unknown as NotionPoller,
      );
      const { deps } = buildDeps({
        services,
        config: makeAgentConfig(tmpDir, {
          notionDatabaseIds: { primary: "abc123" },
        }),
        buildNotionPoller: buildPoller,
      });
      const handle = createSecretChangeHandler(deps);
      await handle("notion");
      expect(buildPoller).not.toHaveBeenCalled();
    });
  });

  // ── "github" webhook-mode upgrade branch ──
  describe("github webhook-mode upgrade", () => {
    it("always reloads the github service, and nothing else", async () => {
      const { deps, spies } = buildDeps();
      const handle = createSecretChangeHandler(deps);
      await handle("github");
      expectExactlyOneReloaderCalled(spies, "reloadGitHubService");
    });

    it("upgrades the existing watcher when webhook secret is configured", async () => {
      const watcher = fakeGitWatcher();
      const secretState = createInitialSecretState();
      secretState.githubWebhookConfigured = true;
      const { deps } = buildDeps({
        secretState,
        getGitWatcher: () => watcher as unknown as GitWatcher,
      });
      const handle = createSecretChangeHandler(deps);
      await handle("github");
      expect(watcher.enableWebhookMode).toHaveBeenCalledTimes(1);
    });

    it("skips upgrade when no watcher exists", async () => {
      const secretState = createInitialSecretState();
      secretState.githubWebhookConfigured = true;
      const { deps } = buildDeps({
        secretState,
        getGitWatcher: () => null,
      });
      // Should not throw; just reload service and exit.
      const handle = createSecretChangeHandler(deps);
      await expect(handle("github")).resolves.toBeUndefined();
    });

    it("skips upgrade when webhook secret is NOT configured", async () => {
      const watcher = fakeGitWatcher();
      const { deps } = buildDeps({
        getGitWatcher: () => watcher as unknown as GitWatcher,
        // secretState.githubWebhookConfigured defaults to false
      });
      const handle = createSecretChangeHandler(deps);
      await handle("github");
      expect(watcher.enableWebhookMode).not.toHaveBeenCalled();
    });
  });
});

// ── handleGoogleServicesReady — gate matrix ─────────────────────────────────

describe("createGoogleServicesReadyHandler", () => {
  let tmpDir: string;
  let contextDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pa-event-pipeline-test-"));
    contextDir = join(tmpDir, "context");
    mkdirSync(contextDir, { recursive: true });
    mkdirSync(join(contextDir, "state"), { recursive: true });
    mkdirSync(join(contextDir, "plans"), { recursive: true });
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    try {
      db?.close();
    } catch {
      /* may already be closed */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function buildDeps(
    overrides: Partial<GoogleServicesReadyHandlerDeps> = {},
  ): {
    deps: GoogleServicesReadyHandlerDeps;
    spies: {
      queueMorningRoutineWake: ReturnType<typeof vi.fn>;
      emitRoadmapRefresh: ReturnType<typeof vi.fn>;
      buildCalendarPoller: ReturnType<typeof vi.fn>;
    };
    observerManager: ObserverManager;
  } {
    const observerManager = new ObserverManager();
    const queueMorningRoutineWake = vi.fn();
    const emitRoadmapRefresh = vi.fn();
    const buildCalendarPoller = vi.fn(() => null);
    const deps: GoogleServicesReadyHandlerDeps = {
      db,
      config: makeAgentConfig(tmpDir, {
        dataDir: tmpDir,
        workspaceDir: tmpDir,
      }),
      services: createServiceRegistry(),
      observerManager,
      buildCalendarPoller: buildCalendarPoller as unknown as () => CalendarPoller | null,
      scheduler: { queueMorningRoutineWake },
      dispatcher: { emitRoadmapRefresh },
      ...overrides,
    };
    return {
      deps,
      spies: { queueMorningRoutineWake, emitRoadmapRefresh, buildCalendarPoller },
      observerManager,
    };
  }

  /**
   * Write a `today.md` with the current agent-day stamp so
   * `hasFreshAgentDayTodayMd` returns true.
   */
  function writeFreshTodayMd(): void {
    const today = new Date();
    // The freshness predicate accepts any header containing the YYYY-MM-DD
    // for the current agent day. dayBoundaryHour=4 with UTC means we use
    // (now - 4h) for the agent date.
    const adjusted = new Date(today.getTime() - 4 * 60 * 60 * 1000);
    const yyyy = adjusted.getUTCFullYear();
    const mm = String(adjusted.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(adjusted.getUTCDate()).padStart(2, "0");
    writeFileSync(
      join(contextDir, "state", "today.md"),
      `# ${yyyy}-${mm}-${dd}\n\nfresh today.md\n`,
    );
  }

  describe("calendar hot-register", () => {
    it("registers + starts a poller when all three gates pass", async () => {
      const poller = fakePoller("calendar");
      setIntegrationMode(db, "google_calendar", "direct");
      const services = createServiceRegistry();
      services.calendar = {} as never;
      writeFreshTodayMd();
      const { deps, observerManager } = buildDeps({
        services,
        config: makeAgentConfig(tmpDir, {
          dataDir: tmpDir,
          workspaceDir: tmpDir,
        }),
        buildCalendarPoller: () => poller as unknown as CalendarPoller,
      });
      const handle = createGoogleServicesReadyHandler(deps);
      handle();
      expect(observerManager.has("calendar")).toBe(true);
      expect(poller.start).toHaveBeenCalledTimes(1);
    });

    it("skips registration when services.calendar is null", async () => {
      setIntegrationMode(db, "google_calendar", "direct");
      writeFreshTodayMd();
      const { deps, spies, observerManager } = buildDeps();
      const handle = createGoogleServicesReadyHandler(deps);
      handle();
      expect(spies.buildCalendarPoller).not.toHaveBeenCalled();
      expect(observerManager.has("calendar")).toBe(false);
    });

    it("skips registration when google_calendar is not in direct mode", async () => {
      setIntegrationMode(db, "google_calendar", "delegated");
      const services = createServiceRegistry();
      services.calendar = {} as never;
      writeFreshTodayMd();
      const { deps, spies } = buildDeps({ services });
      const handle = createGoogleServicesReadyHandler(deps);
      handle();
      expect(spies.buildCalendarPoller).not.toHaveBeenCalled();
    });

    it("skips registration when an observer is already registered (idempotent)", async () => {
      const existing = fakePoller("calendar");
      setIntegrationMode(db, "google_calendar", "direct");
      const services = createServiceRegistry();
      services.calendar = {} as never;
      const observerManager = new ObserverManager();
      observerManager.register(existing as never);
      writeFreshTodayMd();
      const buildCalendarPoller = vi.fn(
        () => fakePoller("calendar") as unknown as CalendarPoller,
      );
      const { deps } = buildDeps({
        services,
        observerManager,
        buildCalendarPoller: buildCalendarPoller as unknown as () =>
          | CalendarPoller
          | null,
      });
      const handle = createGoogleServicesReadyHandler(deps);
      handle();
      expect(buildCalendarPoller).not.toHaveBeenCalled();
      expect(existing.start).not.toHaveBeenCalled();
    });
  });

  describe("morning-routine + roadmap-refresh gate", () => {
    it("queues morning_routine wake and SKIPS roadmap refresh when today.md is stale", () => {
      // No today.md file → stale by definition.
      const { deps, spies } = buildDeps();
      const handle = createGoogleServicesReadyHandler(deps);
      handle();
      expect(spies.queueMorningRoutineWake).toHaveBeenCalledWith(
        "google_auth_ready",
      );
      expect(spies.emitRoadmapRefresh).not.toHaveBeenCalled();
    });

    it("emits roadmap_refresh when today.md is fresh AND roadmap is stale", () => {
      writeFreshTodayMd();
      // Roadmap.md absent → `isRoadmapStale(contextDir)` returns true.
      const { deps, spies } = buildDeps();
      const handle = createGoogleServicesReadyHandler(deps);
      handle();
      expect(spies.queueMorningRoutineWake).not.toHaveBeenCalled();
      expect(spies.emitRoadmapRefresh).toHaveBeenCalledWith(
        "google_auth_ready",
      );
    });

    it("does nothing when today.md is fresh AND roadmap is also fresh", () => {
      writeFreshTodayMd();
      // Write a non-stale roadmap. The `isRoadmapStale` predicate flags
      // the `(Not yet configured)` skeleton placeholder; anything else is
      // considered configured.
      writeFileSync(
        join(contextDir, "plans", "roadmap.md"),
        "# Roadmap\n\n## Today\n\n- ship the thing\n",
      );
      const { deps, spies } = buildDeps();
      const handle = createGoogleServicesReadyHandler(deps);
      handle();
      expect(spies.queueMorningRoutineWake).not.toHaveBeenCalled();
      expect(spies.emitRoadmapRefresh).not.toHaveBeenCalled();
    });
  });
});
