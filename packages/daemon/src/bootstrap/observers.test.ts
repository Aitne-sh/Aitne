/**
 * Peer tests for `./observers.ts` (bootstrap factory).
 *
 * Scope: per `docs/design/appendices/index-bootstrap-stage-split.md` §8,
 * pin the per-observer registration gate matrix and the feature-flag
 * branches the pre-split inline §7 of `index.ts` owned but had no
 * isolated test for:
 *
 *   1. Per-observer registration gate matrix — for each of the five
 *      hot-register builders (`buildGitWatcher`, `buildGithubPoller`,
 *      `buildGitDelegatedCronObserver`, `buildCalendarPoller`,
 *      `buildNotionPoller`) the boot-time conditional matches the
 *      design contract: register only when the integration mode is
 *      `direct` (plus per-builder additional preconditions: git repo
 *      rows non-empty; calendar / notion service present; notion
 *      database id list non-empty).
 *   2. Builder idempotency — calling the same builder twice without
 *      a side-effect `register()` does not duplicate registrations.
 *   3. Secondary observer feature flags — `observationSummarizerEnabled`
 *      toggles the §7.2 worker; `externalObsidianVaultPath` +
 *      `externalObsidianWatch` toggle the secondary vault watcher;
 *      `services.mail` toggles the mail poller + reconciliation job.
 *   4. State holders — `getGitWatcher()` / `clearGitWatcher()` reflect
 *      the live slot; `setPromptContextChangedSink` installs the
 *      forward-reference callback the context-index reconciler reads.
 *
 * The factory is async (dynamic imports inside §7.04 / §7.1 fire on
 * every call). Minimal mocks back the SecretBroker / ServiceRegistry /
 * MessageHub fields the builders capture in closure but never invoke
 * before `observerManager.startAll()` — which the test never calls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { applySchema } from "../db/schema.js";
import { writeIntegrations } from "../db/integrations-store.js";
import { createServiceRegistry, type ServiceRegistry } from "../services/service-registry.js";
import { AgentWriteTracker } from "../safety/agent-write-tracker.js";
import { EventBus } from "../core/event-bus.js";
import { SecretBroker } from "../secrets/secret-broker.js";
import {
  InMemoryTodayWriteLockManager,
  getTodayWriteLockTimeoutMs,
} from "../core/today-write-lock.js";
import {
  createInitialSecretState,
  type BootstrapSecretState,
} from "./services.js";
import {
  createObservers,
  type BootstrapObserversDeps,
} from "./observers.js";
import type { AgentConfig } from "../config.js";
import type {
  IntegrationKey,
  IntegrationMode,
  IntegrationState,
} from "@aitne/shared";
import type { SecretStore } from "../secrets/secret-store.js";
import type { StoredSecretName } from "../secrets/secret-names.js";
import type { EncryptedBlobStore } from "../secrets/encrypted-blob-store.js";
import type { BlobName } from "../secrets/types.js";
import type { MessageHub } from "../adapters/message-hub.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Resolve to the repo root so dynamic imports inside the factory
// (`SkillCurationWalker`, `scanAndRecordOrphanOverlays`, `McpAutoProbe`)
// run against the real built-in skills tree without spurious FS errors.
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");

// ── Test doubles ─────────────────────────────────────────────────────────────

class InMemorySecretStore implements SecretStore {
  private readonly values = new Map<StoredSecretName, string>();
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

// ── Helpers ──────────────────────────────────────────────────────────────────

function openDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return db;
}

function setIntegrationMode(
  db: Database.Database,
  key: IntegrationKey,
  mode: IntegrationMode,
): void {
  const now = new Date().toISOString();
  const state = {
    mode,
    lastChangedAt: now,
    ...(mode === "delegated" ? { delegatedBackend: "claude" as const } : {}),
    ...(mode === "native" ? { nativeBackend: "claude" as const } : {}),
  } as unknown as IntegrationState;
  writeIntegrations(db, { [key]: state });
}

function insertRepository(
  db: Database.Database,
  options: {
    id: string;
    localPath?: string;
    githubOwner?: string;
    githubRepo?: string;
  },
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO repositories (
       id, github_owner, github_repo, github_account, local_path,
       local_only, display_name, classification, category, poll_priority,
       poll_interval_sec, created_at, updated_at
     ) VALUES (?, ?, ?, NULL, ?, ?, ?, 'repo-only', 'personal', 'normal', NULL, ?, ?)`,
  ).run(
    options.id,
    options.githubOwner ?? null,
    options.githubRepo ?? null,
    options.localPath ?? null,
    options.localPath && !options.githubOwner ? 1 : 0,
    options.id,
    now,
    now,
  );
}

interface MakeDepsOverrides {
  configOverrides?: Partial<AgentConfig>;
  services?: ServiceRegistry;
  secretState?: BootstrapSecretState;
  triggerRoadmapRefresh?: BootstrapObserversDeps["triggerRoadmapRefresh"];
}

function makeConfig(
  tmpDir: string,
  overrides: Partial<AgentConfig> = {},
): AgentConfig {
  return {
    dataDir: tmpDir,
    workspaceDir: REPO_ROOT,
    timezone: "UTC",
    dayBoundaryHour: 0,
    executeTimeoutMinutes: 30,
    obsidianDebounceSeconds: 5,
    vaultMode: "plain",
    primaryVaultPath: "",
    externalObsidianVaultPath: "",
    externalObsidianWatch: false,
    gitAccounts: {},
    gitPollIntervalSeconds: 60,
    gitPushOverdueMinutes: 120,
    gitProjectUpdateDebounceMinutes: 5,
    githubPollIntervalSeconds: 60,
    activityScanEnabled: true,
    calendarPollIntervalSeconds: 60,
    googleCalendarId: "primary",
    notionPollIntervalSeconds: 60,
    notionDatabaseIds: {},
    mailPollIntervalSeconds: 120,
    mailMaxMessagesPerPoll: 50,
    mailAuthFailureRetryHours: 24,
    gmailPollIntervalSeconds: 120,
    vipMailSenders: [],
    mcpAutoProbeIntervalMinutes: 0,
    observationSummarizerEnabled: false,
    observationSummarizerConcurrency: 1,
    observationSummarizerTimeoutMs: 30000,
    observationSummarizerMaxCallsPerMinute: 30,
    observationSummarizerQueueLimit: 100,
    ...overrides,
  } as unknown as AgentConfig;
}

function makeDeps(
  tmpDir: string,
  db: Database.Database,
  overrides: MakeDepsOverrides = {},
): BootstrapObserversDeps {
  const config = makeConfig(tmpDir, overrides.configOverrides);
  const services = overrides.services ?? createServiceRegistry();
  const secretBroker = new SecretBroker(new InMemorySecretStore(), {
    cacheTtlMs: 0,
  });
  const messageHub = {
    sendToUser: vi.fn(async () => []),
  } as unknown as MessageHub;
  const morningRoutineLock = new InMemoryTodayWriteLockManager(
    getTodayWriteLockTimeoutMs(config.executeTimeoutMinutes),
  );
  return {
    db,
    config,
    eventBus: new EventBus(),
    secretBroker,
    services,
    writeTracker: new AgentWriteTracker(),
    blobStore: new MemoryBlobStore(),
    messageHub,
    morningRoutineLock,
    secretState: overrides.secretState ?? createInitialSecretState(),
    triggerRoadmapRefresh:
      overrides.triggerRoadmapRefresh ?? (() => undefined),
  };
}

function observerNames(
  manager: { getObservers(): readonly { name: string }[] },
): string[] {
  return manager.getObservers().map((o) => o.name);
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe("createObservers — gate matrix for the five hot-register builders", () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pa-bootstrap-observers-test-"));
    db = openDb();
  });

  afterEach(() => {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── buildGitWatcher ─────────────────────────────────────────────────────
  describe("buildGitWatcher (git integration)", () => {
    it("registers when git.mode='direct' AND at least one local repo exists", async () => {
      insertRepository(db, { id: "r1", localPath: "/tmp/aitne-repo-a" });
      setIntegrationMode(db, "git", "direct");

      const observers = await createObservers(makeDeps(tmpDir, db));
      expect(observerNames(observers.observerManager)).toContain("git");
      expect(observers.getGitWatcher()).not.toBeNull();
    });

    it("skips registration when git.mode='direct' but no repo rows exist", async () => {
      setIntegrationMode(db, "git", "direct");

      const observers = await createObservers(makeDeps(tmpDir, db));
      expect(observerNames(observers.observerManager)).not.toContain("git");
      expect(observers.getGitWatcher()).toBeNull();
    });

    it.each(["delegated", "native", "disabled"] as const)(
      "skips registration when git.mode='%s' even with repo rows",
      async (mode) => {
        insertRepository(db, { id: "r1", localPath: "/tmp/aitne-repo-a" });
        setIntegrationMode(db, "git", mode);

        const observers = await createObservers(makeDeps(tmpDir, db));
        expect(observerNames(observers.observerManager)).not.toContain("git");
        expect(observers.getGitWatcher()).toBeNull();
      },
    );
  });

  // ── buildGithubPoller ───────────────────────────────────────────────────
  describe("buildGithubPoller (github integration)", () => {
    it("registers when github.mode='direct'", async () => {
      setIntegrationMode(db, "github", "direct");

      const observers = await createObservers(makeDeps(tmpDir, db));
      // GitHubPoller's observer name.
      expect(observerNames(observers.observerManager)).toContain("github");
    });

    it.each(["delegated", "native", "disabled"] as const)(
      "skips registration when github.mode='%s'",
      async (mode) => {
        setIntegrationMode(db, "github", mode);

        const observers = await createObservers(makeDeps(tmpDir, db));
        expect(observerNames(observers.observerManager)).not.toContain("github");
      },
    );
  });

  // ── buildGitDelegatedCronObserver ──────────────────────────────────────
  describe("buildGitDelegatedCronObserver (git lifecycle in delegated/native mode)", () => {
    it("registers when git.mode='delegated'", async () => {
      setIntegrationMode(db, "git", "delegated");

      const observers = await createObservers(makeDeps(tmpDir, db));
      expect(observerNames(observers.observerManager)).toContain(
        "git-delegated-cron",
      );
    });

    it("skips registration when git.mode='direct' (handled by GitWatcher instead)", async () => {
      setIntegrationMode(db, "git", "direct");

      const observers = await createObservers(makeDeps(tmpDir, db));
      expect(observerNames(observers.observerManager)).not.toContain(
        "git-delegated-cron",
      );
    });

    it("skips registration when git.mode='disabled'", async () => {
      setIntegrationMode(db, "git", "disabled");

      const observers = await createObservers(makeDeps(tmpDir, db));
      expect(observerNames(observers.observerManager)).not.toContain(
        "git-delegated-cron",
      );
    });

    it("skips registration when git.mode='native' (delegated-cron is delegated-only)", async () => {
      // `hasActiveDelegatedGitLifecycleIntegration` matches mode==='delegated'
      // for both git and github. native mode therefore must NOT trip the
      // delegated cron — pin the negative case explicitly so the gate
      // can't drift into matching native by accident.
      setIntegrationMode(db, "git", "native");

      const observers = await createObservers(makeDeps(tmpDir, db));
      expect(observerNames(observers.observerManager)).not.toContain(
        "git-delegated-cron",
      );
    });

    it("registers when github.mode='delegated' even with git.mode='direct'", async () => {
      // The gate is OR'd across git and github — pin that contract so a
      // refactor that loses the github branch is caught.
      setIntegrationMode(db, "git", "direct");
      setIntegrationMode(db, "github", "delegated");

      const observers = await createObservers(makeDeps(tmpDir, db));
      expect(observerNames(observers.observerManager)).toContain(
        "git-delegated-cron",
      );
    });
  });

  // ── buildCalendarPoller ─────────────────────────────────────────────────
  describe("buildCalendarPoller (google_calendar integration)", () => {
    it("registers when calendar service present AND mode='direct'", async () => {
      setIntegrationMode(db, "google_calendar", "direct");
      const services = createServiceRegistry();
      services.calendar = {} as ServiceRegistry["calendar"];

      const observers = await createObservers(makeDeps(tmpDir, db, { services }));
      expect(observerNames(observers.observerManager)).toContain("calendar");
    });

    it("skips registration when service absent even if mode='direct'", async () => {
      setIntegrationMode(db, "google_calendar", "direct");

      const observers = await createObservers(makeDeps(tmpDir, db));
      expect(observerNames(observers.observerManager)).not.toContain("calendar");
    });

    it.each(["delegated", "native", "disabled"] as const)(
      "skips registration when service present but mode='%s'",
      async (mode) => {
        setIntegrationMode(db, "google_calendar", mode);
        const services = createServiceRegistry();
        services.calendar = {} as ServiceRegistry["calendar"];

        const observers = await createObservers(makeDeps(tmpDir, db, { services }));
        expect(observerNames(observers.observerManager)).not.toContain("calendar");
      },
    );
  });

  // ── buildNotionPoller ───────────────────────────────────────────────────
  describe("buildNotionPoller (notion integration)", () => {
    it("registers when service present, databaseIds non-empty, mode='direct'", async () => {
      setIntegrationMode(db, "notion", "direct");
      const services = createServiceRegistry();
      services.notion = {} as ServiceRegistry["notion"];

      const observers = await createObservers(
        makeDeps(tmpDir, db, {
          configOverrides: { notionDatabaseIds: { project: "abc" } },
          services,
        }),
      );
      expect(observerNames(observers.observerManager)).toContain("notion-poller");
    });

    it("skips registration when service absent", async () => {
      setIntegrationMode(db, "notion", "direct");

      const observers = await createObservers(
        makeDeps(tmpDir, db, {
          configOverrides: { notionDatabaseIds: { project: "abc" } },
        }),
      );
      expect(observerNames(observers.observerManager)).not.toContain(
        "notion-poller",
      );
    });

    it("skips registration when databaseIds map is empty", async () => {
      setIntegrationMode(db, "notion", "direct");
      const services = createServiceRegistry();
      services.notion = {} as ServiceRegistry["notion"];

      const observers = await createObservers(
        makeDeps(tmpDir, db, {
          configOverrides: { notionDatabaseIds: {} },
          services,
        }),
      );
      expect(observerNames(observers.observerManager)).not.toContain(
        "notion-poller",
      );
    });

    it.each(["delegated", "native", "disabled"] as const)(
      "skips registration when mode='%s' even with service + database ids",
      async (mode) => {
        setIntegrationMode(db, "notion", mode);
        const services = createServiceRegistry();
        services.notion = {} as ServiceRegistry["notion"];

        const observers = await createObservers(
          makeDeps(tmpDir, db, {
            configOverrides: { notionDatabaseIds: { project: "abc" } },
            services,
          }),
        );
        expect(observerNames(observers.observerManager)).not.toContain(
          "notion-poller",
        );
      },
    );
  });
});

describe("createObservers — builder idempotency", () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pa-bootstrap-observers-test-"));
    db = openDb();
  });

  afterEach(() => {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("calling buildGitWatcher twice returns the second instance and overwrites the slot", async () => {
    insertRepository(db, { id: "r1", localPath: "/tmp/aitne-repo-a" });
    setIntegrationMode(db, "git", "direct");

    const observers = await createObservers(makeDeps(tmpDir, db));
    const first = observers.getGitWatcher();
    expect(first).not.toBeNull();

    const second = observers.buildGitWatcher();
    expect(second).not.toBeNull();
    expect(observers.getGitWatcher()).toBe(second);
  });

  it("ObserverManager.has(name) prevents duplicate boot-time registration", async () => {
    insertRepository(db, { id: "r1", localPath: "/tmp/aitne-repo-a" });
    setIntegrationMode(db, "git", "direct");

    const observers = await createObservers(makeDeps(tmpDir, db));
    const names = observerNames(observers.observerManager);
    const occurrences = names.filter((n) => n === "git").length;
    expect(occurrences).toBe(1);
  });

  it("buildCalendarPoller can be called repeatedly without registering twice", async () => {
    setIntegrationMode(db, "google_calendar", "direct");
    const services = createServiceRegistry();
    services.calendar = {} as ServiceRegistry["calendar"];

    const observers = await createObservers(makeDeps(tmpDir, db, { services }));
    // Boot-time registration ran once; a follow-up call produces a fresh
    // instance but does NOT register — registration is the caller's
    // responsibility (mirrors `applyIntegrationModeChange`).
    const before = observerNames(observers.observerManager).filter(
      (n) => n === "calendar",
    ).length;
    expect(before).toBe(1);

    const fresh = observers.buildCalendarPoller();
    expect(fresh).not.toBeNull();
    const after = observerNames(observers.observerManager).filter(
      (n) => n === "calendar",
    ).length;
    expect(after).toBe(1);
  });
});

describe("createObservers — secondary observer feature flags", () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pa-bootstrap-observers-test-"));
    db = openDb();
  });

  afterEach(() => {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("registers the observation summarizer worker when observationSummarizerEnabled=true", async () => {
    const observers = await createObservers(
      makeDeps(tmpDir, db, {
        configOverrides: { observationSummarizerEnabled: true },
      }),
    );
    expect(observerNames(observers.observerManager)).toContain(
      "observation-summarizer",
    );
  });

  it("skips the observation summarizer worker when observationSummarizerEnabled=false", async () => {
    const observers = await createObservers(makeDeps(tmpDir, db));
    expect(observerNames(observers.observerManager)).not.toContain(
      "observation-summarizer",
    );
  });

  it("registers the external Obsidian vault watcher when path AND watch flag are set", async () => {
    const vaultDir = mkdtempSync(join(tmpdir(), "pa-vault-"));
    try {
      const observers = await createObservers(
        makeDeps(tmpDir, db, {
          configOverrides: {
            externalObsidianVaultPath: vaultDir,
            externalObsidianWatch: true,
          },
        }),
      );
      expect(observerNames(observers.observerManager)).toContain(
        "obsidian:external",
      );
    } finally {
      rmSync(vaultDir, { recursive: true, force: true });
    }
  });

  it("skips the external vault watcher when externalObsidianWatch=false even if a path is set", async () => {
    const observers = await createObservers(
      makeDeps(tmpDir, db, {
        configOverrides: {
          externalObsidianVaultPath: "/tmp/some/vault",
          externalObsidianWatch: false,
        },
      }),
    );
    expect(observerNames(observers.observerManager)).not.toContain(
      "obsidian:external",
    );
  });

  it("skips the external vault watcher when externalObsidianVaultPath is empty", async () => {
    const observers = await createObservers(
      makeDeps(tmpDir, db, {
        configOverrides: {
          externalObsidianVaultPath: "",
          externalObsidianWatch: true,
        },
      }),
    );
    expect(observerNames(observers.observerManager)).not.toContain(
      "obsidian:external",
    );
  });

  it("registers mail poller + reconciliation job when services.mail is present", async () => {
    const services = createServiceRegistry();
    services.mail = {} as ServiceRegistry["mail"];

    const observers = await createObservers(makeDeps(tmpDir, db, { services }));
    const names = observerNames(observers.observerManager);
    expect(names).toContain("mail");
    expect(names).toContain("mail-reconciliation");
  });

  it("skips mail observers when services.mail is null", async () => {
    const observers = await createObservers(makeDeps(tmpDir, db));
    const names = observerNames(observers.observerManager);
    expect(names).not.toContain("mail");
    expect(names).not.toContain("mail-reconciliation");
  });
});

describe("createObservers — always-on observers", () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pa-bootstrap-observers-test-"));
    db = openDb();
  });

  afterEach(() => {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("registers the always-on observer cohort regardless of integration mode", async () => {
    // No integrations seeded — every key falls through to the default
    // `disabled` row from `defaultIntegrationsMap`. Always-on observers
    // must still be present. The list covers every observer the factory
    // registers without a config flag or integration-mode gate:
    //   - §7   RepositoryManagementCron
    //   - §7   PrimaryVaultWatcher (dormant until setVaultPath)
    //   - §7   ImminentEventScheduler
    //   - §7.04 SkillCurationWalker
    //   - §7.05 ContextIndexReconcilerObserver
    //   - §7.6  EntityMirrorObserver
    //   - §7.1  McpAutoProbe (intervalMinutes=0 disables internally,
    //           but the observer itself is always registered)
    const observers = await createObservers(makeDeps(tmpDir, db));
    const names = observerNames(observers.observerManager);
    expect(names).toEqual(
      expect.arrayContaining([
        "repository-management-cron",
        "obsidian:primary",
        "imminent-event-scheduler",
        "skill-curation-walker",
        "context-index-reconciler",
        "entity-mirror",
        "mcp-auto-probe",
      ]),
    );
  });
});

describe("createObservers — mutable state surface", () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pa-bootstrap-observers-test-"));
    db = openDb();
  });

  afterEach(() => {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("clearGitWatcher() nulls the slot so a subsequent getGitWatcher() returns null", async () => {
    insertRepository(db, { id: "r1", localPath: "/tmp/aitne-repo-a" });
    setIntegrationMode(db, "git", "direct");

    const observers = await createObservers(makeDeps(tmpDir, db));
    expect(observers.getGitWatcher()).not.toBeNull();
    observers.clearGitWatcher();
    expect(observers.getGitWatcher()).toBeNull();
  });

  it("clearGitWatcher() is idempotent when no watcher exists", async () => {
    // git.mode='disabled' so no watcher gets built at boot.
    setIntegrationMode(db, "git", "disabled");

    const observers = await createObservers(makeDeps(tmpDir, db));
    expect(observers.getGitWatcher()).toBeNull();
    expect(() => observers.clearGitWatcher()).not.toThrow();
    expect(observers.getGitWatcher()).toBeNull();
  });

  it("setPromptContextChangedSink installs the callback the reconciler reads", async () => {
    const observers = await createObservers(makeDeps(tmpDir, db));
    const sink = vi.fn();
    observers.setPromptContextChangedSink(sink);

    // The reconciler is exposed on the result so we can fish out the
    // internal handler the factory wired into it. The handler is the
    // closure that forwards to whichever sink is currently installed.
    const reconcilerOpts = (
      observers.contextIndexReconciler as unknown as {
        opts: { onPromptContextChanged?: (...args: unknown[]) => void };
      }
    ).opts;
    expect(reconcilerOpts.onPromptContextChanged).toBeDefined();

    reconcilerOpts.onPromptContextChanged!(
      "context/today.md",
      "fs_event",
      "dm_safe",
      undefined,
    );
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith(
      "context/today.md",
      "fs_event",
      "dm_safe",
      undefined,
    );
  });

  it("reconciler indirection swallows emissions when no sink is installed", async () => {
    const observers = await createObservers(makeDeps(tmpDir, db));
    const reconcilerOpts = (
      observers.contextIndexReconciler as unknown as {
        opts: { onPromptContextChanged?: (...args: unknown[]) => void };
      }
    ).opts;
    // Should not throw — the `?.` indirection short-circuits.
    expect(() =>
      reconcilerOpts.onPromptContextChanged!(
        "context/today.md",
        "fs_event",
        "dm_safe",
        undefined,
      ),
    ).not.toThrow();
  });

  it("triggerRoadmapRefresh is captured and invoked from the calendar poller closure", async () => {
    setIntegrationMode(db, "google_calendar", "direct");
    const services = createServiceRegistry();
    services.calendar = {} as ServiceRegistry["calendar"];
    const trigger = vi.fn();

    const observers = await createObservers(
      makeDeps(tmpDir, db, { services, triggerRoadmapRefresh: trigger }),
    );

    // Verify the closure is the *same* identity the poller stored —
    // forwarded refresh calls re-resolve `emitRoadmapRefreshSink` lazily.
    // We rely on the public `buildCalendarPoller` returning a poller
    // constructed with our trigger; a direct invocation of the callback
    // confirms the wiring without needing to spin up the poller's loop.
    const fresh = observers.buildCalendarPoller();
    expect(fresh).not.toBeNull();
    // Internals expose the callback as `triggerRoadmapRefresh` per the
    // CalendarPoller constructor. Calling it directly proves identity.
    const exposed = (
      fresh as unknown as { triggerRoadmapRefresh: (s: string) => void }
    ).triggerRoadmapRefresh;
    exposed("test");
    expect(trigger).toHaveBeenCalledWith("test");
  });
});
