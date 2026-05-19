/**
 * Peer tests for `./services.ts` (bootstrap factory).
 *
 * Scope: confirm the factory wires the shared `services` registry and
 * `secretState` holders through to each reloader's read/write paths. We
 * stub `SecretBroker` rather than spinning up real Google/Notion/GitHub
 * services because the underlying SDKs are network-bound and not what
 * this Tier 2 extraction is responsible for — the older
 * `claude-code-core.test.ts` / route handler tests already exercise the
 * SDK-touching surfaces.
 *
 * What we check:
 *  - `createInitialSecretState` returns the all-false default shape.
 *  - The reloaders flip the right secretState fields based on the
 *    presence / absence of broker secrets.
 *  - `reloadAppleCalendarService` / `reloadNotionService` /
 *    `reloadGitHubService` clear the matching `services.*` reference and
 *    `services.errors.*` entry on every invocation (early-return path).
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  createInitialSecretState,
  createServiceReloaders,
} from "./services.js";
import { createServiceRegistry } from "../services/service-registry.js";

interface StubBroker {
  google: string | null;
  googleToken: string | null;
  apple: string | null;
  notion: string | null;
  github: string | null;
  githubWebhook: string | null;
}

function makeStubBroker(overrides: Partial<StubBroker> = {}) {
  const state: StubBroker = {
    google: null,
    googleToken: null,
    apple: null,
    notion: null,
    github: null,
    githubWebhook: null,
    ...overrides,
  };
  return {
    state,
    broker: {
      getGoogleCredentialsJson: async () => state.google,
      getGoogleTokenJson: async () => state.googleToken,
      getAppleCalendarCredentialsJson: async () => state.apple,
      getNotionApiKey: async () => state.notion,
      getGitHubToken: async () => state.github,
      getGitHubWebhookSecret: async () => state.githubWebhook,
    },
  };
}

describe("bootstrap/services createInitialSecretState", () => {
  it("returns the all-unconfigured default shape", () => {
    const s = createInitialSecretState();
    expect(s).toEqual({
      googleCredentialsConfigured: false,
      googleTokenConfigured: false,
      googleCredentialType: null,
      notionConfigured: false,
      githubConfigured: false,
      githubWebhookConfigured: false,
    });
  });

  it("returns a fresh object every call (no shared mutation)", () => {
    const a = createInitialSecretState();
    const b = createInitialSecretState();
    a.googleCredentialsConfigured = true;
    expect(b.googleCredentialsConfigured).toBe(false);
  });
});

describe("bootstrap/services createServiceReloaders", () => {
  // The reloaders take `db` + `config` opaquely; the values are passed
  // through to service constructors that we don't exercise here. A
  // typed cast keeps the test data lightweight.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stubDb = {} as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stubConfig = {} as any;

  let services: ReturnType<typeof createServiceRegistry>;
  let secretState: ReturnType<typeof createInitialSecretState>;

  beforeEach(() => {
    services = createServiceRegistry();
    secretState = createInitialSecretState();
  });

  describe("refreshGoogleSecretState", () => {
    it("leaves all-unconfigured when broker returns no secrets", async () => {
      const { broker } = makeStubBroker();
      const { refreshGoogleSecretState } = createServiceReloaders({
        db: stubDb,
        config: stubConfig,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        secretBroker: broker as any,
        services,
        secretState,
      });
      await refreshGoogleSecretState();
      expect(secretState.googleCredentialsConfigured).toBe(false);
      expect(secretState.googleTokenConfigured).toBe(false);
      expect(secretState.googleCredentialType).toBeNull();
    });

    it("flips googleCredentialsConfigured when broker returns credentials JSON", async () => {
      const { broker } = makeStubBroker({
        google: JSON.stringify({ web: { client_id: "abc" } }),
      });
      const { refreshGoogleSecretState } = createServiceReloaders({
        db: stubDb,
        config: stubConfig,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        secretBroker: broker as any,
        services,
        secretState,
      });
      await refreshGoogleSecretState();
      expect(secretState.googleCredentialsConfigured).toBe(true);
    });
  });

  describe("reloadGoogleServices", () => {
    it("returns early when credentials are absent — clears any prior services + errors", async () => {
      const { broker } = makeStubBroker();
      services.calendar = "stale" as never;
      services.gmail = "stale" as never;
      services.errors.googleCalendar = "old error";
      services.errors.gmail = "old error";

      const { reloadGoogleServices } = createServiceReloaders({
        db: stubDb,
        config: stubConfig,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        secretBroker: broker as any,
        services,
        secretState,
      });
      await reloadGoogleServices();
      expect(services.calendar).toBeNull();
      expect(services.gmail).toBeNull();
      expect(services.errors.googleCalendar).toBeUndefined();
      expect(services.errors.gmail).toBeUndefined();
    });
  });

  describe("reloadAppleCalendarService", () => {
    it("clears appleCalendar + errors and returns early on missing secret", async () => {
      const { broker } = makeStubBroker();
      services.appleCalendar = "stale" as never;
      services.errors.appleCalendar = "old";

      const { reloadAppleCalendarService } = createServiceReloaders({
        db: stubDb,
        config: stubConfig,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        secretBroker: broker as any,
        services,
        secretState,
      });
      await reloadAppleCalendarService();
      expect(services.appleCalendar).toBeNull();
      expect(services.errors.appleCalendar).toBeUndefined();
    });
  });

  describe("reloadNotionService", () => {
    it("clears notion + errors and flips notionConfigured=false on missing key", async () => {
      const { broker } = makeStubBroker();
      services.notion = "stale" as never;
      services.errors.notion = "old";
      secretState.notionConfigured = true;

      const { reloadNotionService } = createServiceReloaders({
        db: stubDb,
        config: stubConfig,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        secretBroker: broker as any,
        services,
        secretState,
      });
      await reloadNotionService();
      expect(services.notion).toBeNull();
      expect(services.errors.notion).toBeUndefined();
      expect(secretState.notionConfigured).toBe(false);
    });

    it("flips notionConfigured=true when api key is present", async () => {
      const { broker } = makeStubBroker({ notion: "secret_xxx" });
      const { reloadNotionService } = createServiceReloaders({
        db: stubDb,
        config: stubConfig,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        secretBroker: broker as any,
        services,
        secretState,
      });
      try {
        await reloadNotionService();
      } catch {
        // NotionService constructor may throw on init — we only care
        // that the secretState flag was set before init was attempted.
      }
      expect(secretState.notionConfigured).toBe(true);
    });
  });

  describe("reloadGitHubService", () => {
    it("clears github + flips both flags=false on missing token", async () => {
      const { broker } = makeStubBroker();
      services.github = "stale" as never;
      services.errors.github = "old";
      secretState.githubConfigured = true;
      secretState.githubWebhookConfigured = true;

      const { reloadGitHubService } = createServiceReloaders({
        db: stubDb,
        config: stubConfig,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        secretBroker: broker as any,
        services,
        secretState,
      });
      await reloadGitHubService();
      expect(services.github).toBeNull();
      expect(services.errors.github).toBeUndefined();
      expect(secretState.githubConfigured).toBe(false);
      expect(secretState.githubWebhookConfigured).toBe(false);
    });

    it("flips githubConfigured=true when token is present (webhook flag tracks separately)", async () => {
      const { broker } = makeStubBroker({ github: "ghp_xxx" });
      const { reloadGitHubService } = createServiceReloaders({
        db: stubDb,
        config: stubConfig,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        secretBroker: broker as any,
        services,
        secretState,
      });
      try {
        await reloadGitHubService();
      } catch {
        /* init may throw — flag check below is what we care about */
      }
      expect(secretState.githubConfigured).toBe(true);
      expect(secretState.githubWebhookConfigured).toBe(false);
    });
  });
});
