/**
 * Peer tests for `./api.ts` (bootstrap factory).
 *
 * Scope: per `docs/design/appendices/index-bootstrap-stage-split.md` §9,
 * pin the invariants the pre-split inline §11 of `index.ts` owned but
 * had no isolated test for:
 *
 *   1. Route-mount presence — every route file registered in `createApp`
 *      stays reachable through the composed app. Catches a regression
 *      where someone moves a file but forgets to re-mount it.
 *   2. Bearer-token gate order — privileged routes return 401 without a
 *      token and the route's real response with one. Pins the middleware
 *      ordering at the composition layer (route-level tests assume it).
 *   3. `serve` is invoked with `overrideGlobalObjects: false` — the
 *      `project_hono_global_response_pitfall` workaround for
 *      `@huggingface/transformers` cache-put. Asserted via the
 *      `serveImpl` test seam so the suite never opens a real socket.
 *
 * The factory has a wide `BootstrapApiDeps` surface (every subsystem
 * passes through here on the way to `ApiDependencies`). Most fields are
 * inert for the assertions we make and are filled in with no-op stubs
 * via `makeBootstrapApiDeps()`; only the bits we exercise (db, config,
 * secretBroker, the few hot-reload closures consumed by the routes we
 * hit) carry real behavior.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { applySchema } from "../db/schema.js";
import { SecretBroker } from "../secrets/secret-broker.js";
import { createServiceRegistry } from "../services/service-registry.js";
import { EventBroadcaster } from "../api/routes/sse.js";
import { startApiServer, type BootstrapApiDeps } from "./api.js";
import type { AgentConfig } from "../config.js";
import type { SecretStore } from "../secrets/secret-store.js";
import type { StoredSecretName } from "../secrets/secret-names.js";
import type { EncryptedBlobStore } from "../secrets/encrypted-blob-store.js";
import type { BlobName } from "../secrets/types.js";
import type { ServerType } from "@hono/node-server";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Test doubles ─────────────────────────────────────────────────────────────

class InMemorySecretStore implements SecretStore {
  private readonly values = new Map<StoredSecretName, string>();

  constructor(seed: Partial<Record<StoredSecretName, string>> = {}) {
    for (const [key, value] of Object.entries(seed)) {
      if (typeof value === "string") this.values.set(key as StoredSecretName, value);
    }
  }

  async has(name: StoredSecretName): Promise<boolean> {
    return this.values.has(name);
  }

  async get(name: StoredSecretName): Promise<string | null> {
    return this.values.get(name) ?? null;
  }

  async set(name: StoredSecretName, value: string): Promise<void> {
    this.values.set(name, value);
  }

  async delete(name: StoredSecretName): Promise<void> {
    this.values.delete(name);
  }
}

class MemoryBlobStore implements EncryptedBlobStore {
  async exists(_name: BlobName): Promise<boolean> {
    return false;
  }

  async readUtf8(_name: BlobName): Promise<string | null> {
    return null;
  }

  async writeUtf8(_name: BlobName, _plaintext: string): Promise<void> {
    /* noop */
  }

  async remove(_name: BlobName): Promise<void> {
    /* noop */
  }
}

/**
 * Spy-friendly stand-in for `@hono/node-server.serve`. Returns a fake
 * `ServerType` whose `close()` is a vi.fn() so suite teardown can
 * verify the shutdown handler would have run. The real `serve()` is
 * never called in this suite — `serveImpl` is the test seam.
 */
function makeServeSpy(): {
  spy: ReturnType<typeof vi.fn>;
  fakeServer: ServerType;
  closeSpy: ReturnType<typeof vi.fn>;
} {
  const closeSpy = vi.fn();
  const fakeServer = {
    close: closeSpy,
    listen: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
  } as unknown as ServerType;
  const spy = vi.fn(() => fakeServer);
  return { spy, fakeServer, closeSpy };
}

/**
 * Build a `BootstrapApiDeps` populated with safe defaults. Tests override
 * specific fields by spreading on top.
 */
function makeBootstrapApiDeps(
  tmpDir: string,
  overrides: Partial<BootstrapApiDeps> = {},
): { deps: BootstrapApiDeps; db: Database.Database } {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);

  const config = {
    dataDir: tmpDir,
    workspaceDir: resolve(__dirname, "..", "..", "..", ".."),
    apiPort: 8321,
    timezone: "UTC",
    dayBoundaryHour: 0,
    agentDisplayName: "ai bot",
    apiToken: "test-token",
    enforceReadToken: false,
    defaultNotificationPlatforms: [],
    whatsappEnabled: false,
  } as unknown as AgentConfig;

  const secretBroker = new SecretBroker(
    new InMemorySecretStore({ apiToken: "test-token" }),
    { cacheTtlMs: 0 },
  );

  const noop = () => undefined;
  const asyncNoop = async () => undefined;

  const deps: BootstrapApiDeps = {
    db,
    config,
    secretBroker,
    services: createServiceRegistry(),
    blobStore: new MemoryBlobStore(),
    agentBackends: [],
    authHealthMonitor: {} as BootstrapApiDeps["authHealthMonitor"],
    authRecovery: {} as BootstrapApiDeps["authRecovery"],
    authTelemetry: {} as BootstrapApiDeps["authTelemetry"],
    eventBus: {} as BootstrapApiDeps["eventBus"],
    readTokenManager: {
      isValid: () => false,
    } as unknown as BootstrapApiDeps["readTokenManager"],
    morningRoutineLock: {} as BootstrapApiDeps["morningRoutineLock"],
    roadmapWriteLock: {} as BootstrapApiDeps["roadmapWriteLock"],
    migrationLock: {} as BootstrapApiDeps["migrationLock"],
    contextWriteGate: {} as BootstrapApiDeps["contextWriteGate"],
    dispatcher: {
      getInFlightExecutions: () => [],
      isAutonomousAllowed: () => null,
      markEventNotified: vi.fn(),
      triggerHourlyCheck: vi.fn(),
      emitRoadmapRefresh: vi.fn(),
      beginSetupMode: vi.fn(),
      clearSetupMode: vi.fn(),
      validateAttachmentTurnToken: () => null,
    } as unknown as BootstrapApiDeps["dispatcher"],
    sessionManager: {} as BootstrapApiDeps["sessionManager"],
    scheduler: {
      reloadCrons: vi.fn(),
      queueMorningRoutineWake: vi.fn(),
    } as unknown as BootstrapApiDeps["scheduler"],
    customRoutineScheduler: {
      reload: vi.fn(),
    } as unknown as BootstrapApiDeps["customRoutineScheduler"],
    healthMonitor: {
      getStatus: () => ({
        daemonUptime: 0,
        eventBusSize: 0,
        activeSessions: 0,
        connectedPlatforms: [],
        registeredObservers: [],
        missingContextFiles: [],
        contextFilesOk: true,
      }),
    } as unknown as BootstrapApiDeps["healthMonitor"],
    heartbeat: {
      getLastTickAt: () => Date.now(),
    } as unknown as BootstrapApiDeps["heartbeat"],
    messageHub: {
      sendToUser: vi.fn(async () => []),
      getEffectiveFallbackPlatforms: () => [],
    } as unknown as BootstrapApiDeps["messageHub"],
    observerManager: {} as BootstrapApiDeps["observerManager"],
    contextIndexReconciler: {
      requestReconcile: vi.fn(),
    } as unknown as BootstrapApiDeps["contextIndexReconciler"],
    primaryVaultWatcher: {
      setVaultPath: vi.fn(),
    } as unknown as BootstrapApiDeps["primaryVaultWatcher"],
    delegatedBackendInvoker: {} as BootstrapApiDeps["delegatedBackendInvoker"],
    gitAccountRegistry: {} as BootstrapApiDeps["gitAccountRegistry"],
    writeTracker: {} as BootstrapApiDeps["writeTracker"],
    auditLogger: {} as BootstrapApiDeps["auditLogger"],
    attachmentStore: {} as BootstrapApiDeps["attachmentStore"],
    dashboardAdapter: {} as BootstrapApiDeps["dashboardAdapter"],
    docsQAAdapter: {} as BootstrapApiDeps["docsQAAdapter"],
    docsIndexer: null,
    eventBroadcaster: new EventBroadcaster(),
    getIntegrationStatus: () => ({
      google: {
        configured: false,
        connected: false,
        error: null,
        services: {
          calendar: { connected: false, error: null },
          gmail: { connected: false, error: null },
        },
      },
      appleCalendar: { configured: false, connected: false, error: null },
      obsidian: { configured: false, connected: false, error: null },
      notion: { configured: false, connected: false, error: null },
      whatsapp: {
        configured: false,
        connected: false,
        error: null,
        state: "not_configured",
      },
    }),
    getMessagingStatus: () => ({}),
    isStartupComplete: () => true,
    getDelegatedSyncWorker: () => null,
    handleSecretChange: asyncNoop,
    handlePromptContextChanged: () => undefined,
    onGoogleServicesReady: noop,
    rematerializeActiveDmWorkdirs: () => null,
    fireRoadmapMaintenance: () =>
      ({
        roadmapPath: join(tmpDir, "roadmap.md"),
      }) as unknown as ReturnType<BootstrapApiDeps["fireRoadmapMaintenance"]>,
    buildCalendarPoller: () => null,
    buildNotionPoller: () => null,
    buildGitWatcher: () => null,
    buildGithubPoller: () => null as unknown as ReturnType<BootstrapApiDeps["buildGithubPoller"]>,
    browserTaskSlotStateRef: {} as unknown as BootstrapApiDeps["browserTaskSlotStateRef"],
    browserTaskRunner: {} as unknown as BootstrapApiDeps["browserTaskRunner"],
    buildDelegatedSyncWorker: () =>
      ({}) as ReturnType<BootstrapApiDeps["buildDelegatedSyncWorker"]>,
    buildGitDelegatedCronObserver: () =>
      ({}) as ReturnType<BootstrapApiDeps["buildGitDelegatedCronObserver"]>,
    clearGitWatcher: noop,
    adapterState: {
      slack: null,
      telegram: null,
      discord: null,
      whatsapp: null,
    } as BootstrapApiDeps["adapterState"],
    buildWhatsAppAdapter: () =>
      ({}) as ReturnType<BootstrapApiDeps["buildWhatsAppAdapter"]>,
    teardownWhatsAppAdapter: asyncNoop,
    enableWhatsAppAdapter: asyncNoop,
    buildTelegramControls: () =>
      ({}) as ReturnType<BootstrapApiDeps["buildTelegramControls"]>,
    buildSlackControls: () =>
      ({}) as ReturnType<BootstrapApiDeps["buildSlackControls"]>,
    buildDiscordControls: () =>
      ({}) as ReturnType<BootstrapApiDeps["buildDiscordControls"]>,
    queueGitProjectInitsForCurrentConfig: noop,
    ...overrides,
  };

  return { deps, db };
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe("startApiServer", () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pa-bootstrap-api-test-"));
    mkdirSync(join(tmpDir, "context"), { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      db?.close();
    } catch {
      /* test DB may already be closed */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // §9 invariant 3 — load-bearing workaround from
  // `project_hono_global_response_pitfall`. The literal `false` must
  // propagate intact through the move; any future refactor that drops
  // it will silently break `@huggingface/transformers` cache-put on
  // model downloads. Pinning here makes the regression loud.
  describe("serve invariants", () => {
    it("calls serve with overrideGlobalObjects: false", () => {
      const { spy, fakeServer } = makeServeSpy();
      const built = makeBootstrapApiDeps(tmpDir, { serveImpl: spy as never });
      db = built.db;

      const result = startApiServer(built.deps);

      expect(spy).toHaveBeenCalledTimes(1);
      const options = spy.mock.calls[0]![0] as {
        fetch: unknown;
        hostname: string;
        port: number;
        overrideGlobalObjects: boolean;
      };
      expect(options.overrideGlobalObjects).toBe(false);
      // Sanity: the server returned by serve flows through to the result.
      expect(result.server).toBe(fakeServer);
    });

    it("binds the loopback hostname and configured port", () => {
      const { spy } = makeServeSpy();
      const built = makeBootstrapApiDeps(tmpDir, {
        serveImpl: spy as never,
        config: {
          dataDir: tmpDir,
          workspaceDir: resolve(__dirname, "..", "..", "..", ".."),
          apiPort: 18321,
          timezone: "UTC",
          dayBoundaryHour: 0,
          agentDisplayName: "ai bot",
          apiToken: "test-token",
          enforceReadToken: false,
          defaultNotificationPlatforms: [],
          whatsappEnabled: false,
        } as unknown as AgentConfig,
      });
      db = built.db;

      startApiServer(built.deps);

      const options = spy.mock.calls[0]![0] as {
        hostname: string;
        port: number;
      };
      expect(options.hostname).toBe("127.0.0.1");
      expect(options.port).toBe(18321);
    });

    it("returns the EventBroadcaster passed in via deps", () => {
      const { spy } = makeServeSpy();
      const broadcaster = new EventBroadcaster();
      const built = makeBootstrapApiDeps(tmpDir, {
        serveImpl: spy as never,
        eventBroadcaster: broadcaster,
      });
      db = built.db;

      const result = startApiServer(built.deps);

      expect(result.eventBroadcaster).toBe(broadcaster);
    });
  });

  // §9 invariant 1 — route-mount presence. We can't assert against
  // `app.fetch` directly (Hono's app exposes `.request()`), but the
  // semantics are identical: the test fakes a Request, lets Hono route
  // it through every mounted middleware/route, and asserts a non-404
  // response. A 404 here means the route was forgotten during the move
  // (the trip-wire the design doc calls out).
  describe("route mount presence", () => {
    async function expectRouteMounted(path: string): Promise<void> {
      const { spy } = makeServeSpy();
      const built = makeBootstrapApiDeps(tmpDir, { serveImpl: spy as never });
      db = built.db;
      const { app } = startApiServer(built.deps);

      const res = await app.request(path, {
        headers: {
          Host: "127.0.0.1",
          Authorization: "Bearer test-token",
        },
      });
      // A mounted route may return any status that's NOT the "unknown
      // route" 404 the middleware mints. The 404 from the bearer-gate
      // middleware (`error: "unknown_route"`) carries a specific shape,
      // so any other 2xx/4xx response proves the route exists.
      expect(res.status).not.toBe(404);
    }

    it("mounts /api/health", async () => {
      await expectRouteMounted("/api/health");
    });

    it("mounts /api/docs/* (post-createApp route)", async () => {
      // /api/docs/* is mounted AFTER createApp by bootstrap/api.ts itself
      // — this is the trip-wire for "someone moved createDocsRoutes but
      // forgot to wire it in the factory." Hit `/docs/health` because
      // it does not depend on the indexer handle and returns a real
      // payload even with no docs ingested.
      await expectRouteMounted("/api/docs/health");
    });

    // §9 invariant 1 (expanded) — the design doc calls for "every route
    // file registered in createApp" to be probed. Rather than write 40
    // individual it() blocks, enumerate `app.routes` (Hono surfaces every
    // mounted RouterRoute) and assert that the set of unique route
    // prefixes covers every route module shipped today. A regression that
    // drops a whole module from server.ts (e.g. someone deletes the
    // `app.route("/api", mailRoutes)` line) collapses the corresponding
    // prefix and the matching `expect(prefixes).toContain(...)` fails.
    it("registers every route module enumerated in createApp", () => {
      const { spy } = makeServeSpy();
      const built = makeBootstrapApiDeps(tmpDir, { serveImpl: spy as never });
      db = built.db;
      const { app } = startApiServer(built.deps);

      const routePaths = new Set(app.routes.map((r) => r.path));

      // One representative path per route module that server.ts mounts
      // (and the post-createApp /api/docs/* mount that bootstrap/api.ts
      // owns). Each entry corresponds to a single `app.route(...)` line
      // in api/server.ts. A regression that drops a whole module
      // collapses one of these prefixes and the matching probe fails.
      // Paths chosen from a live `app.routes` snapshot so they exactly
      // match the route handlers' registered patterns (including Hono's
      // `:param` segments).
      const expectedPaths = [
        // Always-on mounts (createApp lines 940-976)
        "/api/health",
        "/api/context/health",
        "/api/agent/run-now",
        "/api/dashboard/dm-freshness",
        "/api/notion/databases",
        "/api/metrics",
        "/api/setup/start",
        "/api/system/factory-reset",
        "/api/backends",
        "/api/skills",
        "/api/observations",
        "/api/skill-curation/runs",
        "/api/profile-questions/slot-filled",
        "/api/recurring-schedules",
        "/api/managed-tasks",
        "/api/sot-bindings",
        "/api/entities",
        "/api/activity-sources",
        "/api/triggers/:id",
        "/api/travel-bookings",
        "/api/receipts",
        "/api/books",
        "/api/integrations/:key",
        "/api/integrations/:key/reconcile",
        "/api/delegated/run",
        "/api/delegated-sync",
        "/api/knowledge/import",
        "/api/task-flows",
        "/api/git-accounts",
        "/api/commands",
        "/api/voice/status",
        "/api/wiki/workspaces",
        "/api/fs/probe",
        // Conditionally mounted (always present in the test setup)
        "/api/apple-calendar/status",
        "/api/mail/accounts",
        "/api/obsidian/status",
        "/api/git/log",
        "/api/repositories",
        "/api/git/templates/:kind",
        // Post-createApp mount (bootstrap/api.ts)
        "/api/docs/health",
      ];

      const missing = expectedPaths.filter((path) => !routePaths.has(path));
      // Surface the full set on failure so a misalignment is debuggable
      // without spelunking through Hono internals.
      expect(missing, `Routes missing from app.routes: ${missing.join(", ")}`).toEqual([]);
    });
  });

  // §9 invariant 2 — bearer-token gate ordering. The middleware stack
  // is composed inside `createApp`, but the composition layer
  // (`bootstrap/api.ts`) is the chokepoint that mounts it for the
  // process. If a future refactor swaps middleware ordering or routes
  // around it, this test catches the regression independent of any
  // route-level test.
  describe("bearer-token gate", () => {
    it("rejects Approve-tier requests without a Bearer token", async () => {
      const { spy } = makeServeSpy();
      const built = makeBootstrapApiDeps(tmpDir, { serveImpl: spy as never });
      db = built.db;
      const { app } = startApiServer(built.deps);

      // /api/config is an Approve-tier write — it requires a Bearer
      // token. Without one the gate returns 401.
      const res = await app.request("/api/config", {
        method: "PATCH",
        headers: {
          Host: "127.0.0.1",
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(401);
    });

    it("admits Approve-tier requests with the right Bearer token", async () => {
      const { spy } = makeServeSpy();
      const built = makeBootstrapApiDeps(tmpDir, { serveImpl: spy as never });
      db = built.db;
      const { app } = startApiServer(built.deps);

      const res = await app.request("/api/config", {
        method: "PATCH",
        headers: {
          Host: "127.0.0.1",
          Authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
      // We don't care about the body — any non-401 proves the gate let
      // the request through to the actual handler.
      expect(res.status).not.toBe(401);
    });

    it("allows Autonomous-tier reads without a token", async () => {
      const { spy } = makeServeSpy();
      const built = makeBootstrapApiDeps(tmpDir, { serveImpl: spy as never });
      db = built.db;
      const { app } = startApiServer(built.deps);

      const res = await app.request("/api/health", {
        headers: { Host: "127.0.0.1" },
      });
      expect(res.status).toBe(200);
    });
  });
});
