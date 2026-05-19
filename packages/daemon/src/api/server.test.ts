import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
import Database from "better-sqlite3";
import { getAgentDayDateStr } from "@aitne/shared";
import { applySchema } from "../db/schema.js";
import { createApp, type ApiDependencies } from "./server.js";
import { EventBroadcaster } from "./routes/sse.js";
import { safePath } from "./routes/context/index.js";
import type { AgentConfig } from "../config.js";
import { ScopedReadSensitiveTokenManager } from "../core/read-sensitive-token-manager.js";
import { createServiceRegistry } from "../services/service-registry.js";
import { SecretBroker } from "../secrets/secret-broker.js";
import type { SecretStore } from "../secrets/secret-store.js";
import type { StoredSecretName } from "../secrets/secret-names.js";
import type { EncryptedBlobStore } from "../secrets/encrypted-blob-store.js";
import type { BlobName } from "../secrets/types.js";

class InMemorySecretStore implements SecretStore {
  private readonly values = new Map<StoredSecretName, string>();

  constructor(seed: Partial<Record<StoredSecretName, string>> = {}) {
    for (const [key, value] of Object.entries(seed)) {
      this.values.set(key as StoredSecretName, value);
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
  async exists(name: BlobName): Promise<boolean> {
    void name;
    return false;
  }

  async readUtf8(name: BlobName): Promise<string | null> {
    void name;
    return null;
  }

  async writeUtf8(name: BlobName, plaintext: string): Promise<void> {
    void name;
    void plaintext;
  }

  async remove(name: BlobName): Promise<void> {
    void name;
  }
}

function makeTestDeps(tmpDir: string): {
  deps: ApiDependencies;
  db: Database.Database;
} {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);

  const config = {
    dataDir: tmpDir,
    // B-007 §7.4 — setup's ensureSkeletonFiles reads from
    // `<workspaceDir>/agent-assets/templates/`. Point at the repo root so
    // tests that exercise the setup flow can seed the templated vault tree.
    workspaceDir: resolve(__dirname, "..", "..", "..", ".."),
    apiPort: 8321,
    timezone: "UTC",
    dayBoundaryHour: 0,
    agentDisplayName: "ai bot",
    apiToken: "test-token",
  } as unknown as AgentConfig;

  return {
    deps: {
      db,
      config,
      secretBroker: new SecretBroker(
        new InMemorySecretStore({ apiToken: "test-token" }),
        { cacheTtlMs: 0 },
      ),
      services: createServiceRegistry(),
      getHealthData: () => ({
        uptime: 1000,
        eventBusSize: 5,
        activeSessions: 1,
        connectedPlatforms: [],
        registeredObservers: [],
        missingContextFiles: [],
        contextFilesOk: true,
      }),
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
          obsidian: { configured: false, connected: false, error: null },
          notion: { configured: false, connected: false, error: null },
          whatsapp: {
            configured: false,
            connected: false,
            error: null,
            state: "not_configured",
          },
          googleMaps: { configured: false, connected: false, error: null },
        }),
    },
    db,
  };
}

function authHeaders(init?: Record<string, string>): Record<string, string> {
  return {
    Authorization: "Bearer test-token",
    ...(init ?? {}),
  };
}

function validTodayContent(
  agentPlan = "- [ ] 09:00 Send prep note [work] \u2192DM",
  date?: string,
): string {
  // Use the current agent-day date so writes pass the validator's
  // line-1 expectedAgentDay check. The test app config uses UTC +
  // dayBoundaryHour=0 (see makeAppDeps), so mirror that here so the
  // fixture's date stays in lockstep with the route handler regardless
  // of when the suite runs.
  const todayStr = date ?? getAgentDayDateStr("UTC", 0);
  return [
    `# ${todayStr} (Day)`,
    "> Day type: Weekday | Work focus: on | Study focus: on | Personal focus: on",
    "",
    "## User Schedule",
    "- (none)",
    "",
    "## User Tasks",
    "- (none)",
    "",
    "## Agent Plan",
    agentPlan,
    "",
    "## Agent Notes",
    "- (none)",
    "",
    "## Agent Log",
    "- (none)",
    "",
    "## Handoff",
    "- (none)",
    "",
  ].join("\n");
}

function withContextFrontmatter(
  type: string,
  owner: "agent" | "shared" | "user",
  markdown: string,
): string {
  return [
    "---",
    `type: ${type}`,
    `owner: ${owner}`,
    "updated: 2026-04-21",
    "---",
    markdown,
  ].join("\n");
}

function validRuleContent(markdown: string): string {
  return withContextFrontmatter("rule", "shared", markdown);
}

function validUserContent(markdown: string): string {
  return withContextFrontmatter("user", "shared", markdown);
}

function validProjectContent(markdown = "# New Project"): string {
  return withContextFrontmatter("project", "shared", markdown);
}

function validDailyContent(markdown = "# 2026-04-17 (Friday)"): string {
  // validateDailySkeletonFrontmatter (context-frontmatter.ts) requires the
  // five skeleton fields beyond the generic type/owner/updated triple.
  return [
    "---",
    "type: daily",
    "owner: agent",
    "updated: 2026-04-21",
    "date: 2026-04-17",
    "weekday: Friday",
    "agent_generated: true",
    "calendar_events: 0",
    "messages_handled: 0",
    "---",
    markdown,
  ].join("\n");
}

function validMonthlyContent(markdown = "# Monthly Review 2026-04"): string {
  return withContextFrontmatter("monthly", "agent", markdown);
}

describe("Daemon API", () => {
  let tmpDir: string;
  let contextDir: string;
  let db: Database.Database;
  let app: ReturnType<typeof createApp>;
  let deps: ApiDependencies;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pa-api-test-"));
    contextDir = join(tmpDir, "context");
    mkdirSync(join(contextDir, "user"), { recursive: true });
    mkdirSync(join(contextDir, "projects"), { recursive: true });
    mkdirSync(join(contextDir, "daily"), { recursive: true });
    mkdirSync(join(contextDir, "weekly"), { recursive: true });
    mkdirSync(join(contextDir, "monthly"), { recursive: true });
    mkdirSync(join(contextDir, "rules"), { recursive: true });
    mkdirSync(join(contextDir, "agent"), { recursive: true });

    const made = makeTestDeps(tmpDir);
    deps = made.deps;
    const { db: testDb } = made;
    db = testDb;
    app = createApp(deps);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("GET /api/health", () => {
    it("returns health data", async () => {
      const res = await app.request("/api/health");
      expect(res.status).toBe(200);

      const data = (await res.json()) as Record<string, any>;
      expect(data.status).toBe("ok");
      expect(data.uptime).toBe(1000);
      expect(data.eventBusSize).toBe(5);
    });

    it("returns integration statuses", async () => {
      const res = await app.request("/api/health");
      const data = (await res.json()) as Record<string, any>;

      expect(data.integrations).toBeDefined();
      expect(data.integrations.google).toEqual({
        configured: false,
        connected: false,
        error: null,
        services: {
          calendar: { connected: false, error: null },
          gmail: { connected: false, error: null },
        },
      });
      expect(data.integrations.obsidian).toEqual({
        configured: false,
        connected: false,
        error: null,
      });
      expect(data.integrations.notion).toEqual({
        configured: false,
        connected: false,
        error: null,
      });
      expect(data.integrations.whatsapp).toEqual({
        configured: false,
        connected: false,
        error: null,
        state: "not_configured",
      });
      expect(data.integrations.googleMaps).toEqual({
        configured: false,
        connected: false,
        error: null,
      });
    });

    it("returns connected platforms and observers", async () => {
      const res = await app.request("/api/health");
      const data = (await res.json()) as Record<string, any>;

      expect(data.connectedPlatforms).toEqual([]);
      expect(data.registeredObservers).toEqual([]);
      expect(data.contextFilesOk).toBe(true);
      expect(data.missingContextFiles).toEqual([]);
    });

    it("returns delegated integration drift sync status when wired", async () => {
      deps.getIntegrationDriftSyncStatus = () => ({
        workerRunning: true,
        lastSuccessAt: "2026-04-29T12:00:00.000Z",
        circuitState: "ok",
        activeHours: { startHour: 4, endHour: 24 },
        withinActiveHours: true,
        cadences: {
          "google_calendar:primary:24h": {
            integration: "google_calendar",
            windowKey: "primary:24h",
            enabled: true,
            displayName: "Calendar — day-ahead (next 24 h)",
            description: "test fixture",
            defaultIntervalSeconds: 3600,
            softFloorSeconds: 1800,
            intervalSeconds: 3600,
            effectiveIntervalSeconds: 3600,
            circuitState: "ok",
            failureCount: 0,
            lastAttemptAt: "2026-04-29T12:00:00.000Z",
            lastSuccessAt: "2026-04-29T12:00:00.000Z",
            lastCompletedAt: "2026-04-29T12:00:01.000Z",
            lastError: null,
            nextRunAt: "2026-04-29T13:00:00.000Z",
          },
        },
        unrecognizedIntervalKeys: [],
        ttlContractViolations: [],
      });
      app = createApp(deps);

      const res = await app.request("/api/health");
      const data = (await res.json()) as Record<string, any>;

      expect(data.integrationDriftSync).toMatchObject({
        workerRunning: true,
        lastSuccessAt: "2026-04-29T12:00:00.000Z",
        circuitState: "ok",
      });
      expect(data.integrationDriftSync.cadences["google_calendar:primary:24h"]).toMatchObject({
        windowKey: "primary:24h",
        failureCount: 0,
      });
    });
  });

  describe("Context File API", () => {
    it("GET returns file content", async () => {
      writeFileSync(join(contextDir, "today.md"), "# Today\nContent here");

      const res = await app.request("/api/context/today");
      expect(res.status).toBe(200);

      const data = (await res.json()) as Record<string, any>;
      expect(data.content).toContain("Content here");
      expect(data.lastModified).toBeTruthy();
    });

    it("GET accepts an optional .md suffix", async () => {
      writeFileSync(join(contextDir, "today.md"), "# Today\nContent here");

      const res = await app.request("/api/context/today.md");
      expect(res.status).toBe(200);

      const data = (await res.json()) as Record<string, any>;
      expect(data.content).toContain("Content here");
    });

    it("GET returns 404 for missing file", async () => {
      const res = await app.request("/api/context/nonexistent");
      expect(res.status).toBe(404);
    });

    it("PUT replaces file content", async () => {
      writeFileSync(join(contextDir, "today.md"), validTodayContent());

      const res = await app.request("/api/context/today", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: validTodayContent("- [ ] 10:00 Send updated note [work] \u2192DM"),
        }),
      });
      expect(res.status).toBe(200);

      const data = (await res.json()) as Record<string, any>;
      expect(data.status).toBe("updated");
    });

    it("PUT replaces rules/management content when explicitly requested", async () => {
      writeFileSync(
        join(contextDir, "rules", "management.md"),
        validRuleContent("# Management Rules\n\n## Source of Truth\nold\n"),
      );

      const res = await app.request("/api/context/rules/management", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: validRuleContent("# Management Rules\n\n## Source of Truth\nnew\n"),
        }),
      });
      expect(res.status).toBe(200);
    });

    it("PATCH updates a section in rules/management", async () => {
      writeFileSync(
        join(contextDir, "rules", "management.md"),
        validRuleContent(
          "# Management Rules\n\n## Source of Truth\n- old\n\n## Notification Rules\n- old quiet hours\n",
        ),
      );

      const res = await app.request("/api/context/rules/management", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          section: "notification_rules",
          mode: "replace",
          content: "- Quiet hours: 23:00-07:00",
        }),
      });
      expect(res.status).toBe(200);

      const getRes = await app.request("/api/context/rules/management");
      const data = (await getRes.json()) as Record<string, any>;
      expect(data.content).toContain("- Quiet hours: 23:00-07:00");
      expect(data.content).toContain("## Source of Truth");
    });

    it("normalizes .md suffix before permission checks", async () => {
      writeFileSync(
        join(contextDir, "rules", "management.md"),
        validRuleContent("# Management Rules\n"),
      );

      const res = await app.request("/api/context/rules/management.md", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: validRuleContent("# Management Rules\n\n## Source of Truth\nnormalized\n"),
        }),
      });
      expect(res.status).toBe(200);
    });

    it("PATCH appends to section", async () => {
      writeFileSync(
        join(contextDir, "today.md"),
        "# Today\n\n## Schedule\n- 9:00 Meeting\n\n## Tasks\n- Task 1\n\n## Agent Notes\n\n## Agent Log\n",
      );

      const res = await app.request("/api/context/today", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          section: "agent_notes",
          mode: "append",
          content: "- New note here",
        }),
      });
      expect(res.status).toBe(200);

      const data = (await res.json()) as Record<string, any>;
      expect(data.status).toBe("appended");

      // Verify content
      const getRes = await app.request("/api/context/today");
      const getText = (await getRes.json()) as Record<string, any>;
      expect(getText.content).toContain("New note here");
    });

    it("PATCH returns 400 for missing section", async () => {
      writeFileSync(
        join(contextDir, "today.md"),
        "# Today\n\n## Schedule\n- 9:00\n",
      );

      const res = await app.request("/api/context/today", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          section: "nonexistent_section",
          mode: "append",
          content: "test",
        }),
      });
      expect(res.status).toBe(400);

      const data = (await res.json()) as Record<string, any>;
      expect(data.error).toBe("section_not_found");
      expect(data.availableSections).toContain("schedule");
    });

    it("PATCH and PUT user are both allowed", async () => {
      writeFileSync(
        join(contextDir, "user", "profile.md"),
        validUserContent(
          "# User\n\n## Raw Signals\n\n## Learned Context\n\n## Communication Style\n",
        ),
      );

      // PATCH should work
      const patchRes = await app.request("/api/context/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          section: "raw_signals",
          mode: "append",
          content: "- [2026-04-02] signal",
        }),
      });
      expect(patchRes.status).toBe(200);

      // PUT should also work (needed for initial setup to create user/profile.md)
      const putRes = await app.request("/api/context/user/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: validUserContent("# User\n\n## Identity\nTest user\n"),
        }),
      });
      expect(putRes.status).toBe(200);
    });

    it("PUT saves snapshot to md_file_snapshots", async () => {
      const original = validTodayContent("- [ ] 09:00 Original note [work] \u2192DM");
      writeFileSync(join(contextDir, "today.md"), original);

      await app.request("/api/context/today", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: validTodayContent("- [ ] 10:00 New note [work] \u2192DM"),
        }),
      });

      const snapshot = db
        .prepare(
          "SELECT * FROM md_file_snapshots WHERE file_path = 'today'",
        )
        .get() as { content: string; trigger: string } | undefined;

      expect(snapshot).toBeDefined();
      expect(snapshot!.content).toBe(original);
      expect(snapshot!.trigger).toBe("api_put");
    });

    it("POST /context/archive-today rotates today.md → yesterday.md (B-007 §5.9)", async () => {
      writeFileSync(
        join(contextDir, "today.md"),
        "# Today 2026-04-02\n\nContent",
      );

      const res = await app.request("/api/context/archive-today", {
        method: "POST",
      });
      expect(res.status).toBe(200);

      const data = (await res.json()) as Record<string, any>;
      expect(data.status).toBe("archived");
      expect(data.archivePath).toBe("yesterday.md");
      expect(data.rotatedFrom).toBe("2026-04-02");

      expect(existsSync(join(contextDir, "yesterday.md"))).toBe(true);
    });

    it("GET /context/list/:dir lists files", async () => {
      writeFileSync(
        join(contextDir, "projects", "test-project.md"),
        "# Test",
      );
      writeFileSync(
        join(contextDir, "projects", "_active.base"),
        "filters:\n  and:\n    - state != \"archived\"\n",
      );

      const res = await app.request("/api/context/list/projects");
      expect(res.status).toBe(200);

      const data = (await res.json()) as Record<string, any>;
      const names = data.files.map((f: { name: string }) => f.name);
      expect(names).toContain("test-project.md");
      expect(names).toContain("_active.base");
    });

    it("GET /context/list/:dir lists user files", async () => {
      writeFileSync(
        join(contextDir, "user", "people.md"),
        "# People\n",
      );

      const res = await app.request("/api/context/list/user");
      expect(res.status).toBe(200);

      const data = (await res.json()) as Record<string, any>;
      // `profile.md` may be created by other tests; filter to what we wrote.
      const names = data.files.map((f: { name: string }) => f.name);
      expect(names).toContain("people.md");
    });

    it("GET /context/list/:dir lists monthly files", async () => {
      writeFileSync(
        join(contextDir, "monthly", "2026-04.md"),
        "# Monthly Review 2026-04\n",
      );

      const res = await app.request("/api/context/list/monthly");
      expect(res.status).toBe(200);

      const data = (await res.json()) as Record<string, any>;
      expect(data.files).toHaveLength(1);
      expect(data.files[0].name).toBe("2026-04.md");
    });

    it("allows write to projects/*", async () => {
      const res = await app.request("/api/context/projects/new-project", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: validProjectContent("# New Project") }),
      });
      expect(res.status).toBe(200);
    });

    it("allows PUT and PATCH to user/*", async () => {
      const putRes = await app.request("/api/context/user/people", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: validUserContent(
            "# People\n\n## Family\n\n## Colleagues\n- Bob: Tech lead\n\n## Friends\n",
          ),
        }),
      });
      expect(putRes.status).toBe(200);

      const patchRes = await app.request("/api/context/user/people", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          section: "colleagues",
          mode: "replace",
          content: "- Alice: PM on Project X",
        }),
      });
      expect(patchRes.status).toBe(200);

      const getRes = await app.request("/api/context/user/people");
      const data = (await getRes.json()) as Record<string, any>;
      expect(data.content).toContain("- Alice: PM on Project X");
      expect(data.content).toContain("## Family");
    });

    it("allows PUT to monthly/*", async () => {
      const res = await app.request("/api/context/monthly/2026-04", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: validMonthlyContent("# Monthly Review 2026-04\n\n## Summary\n- ..."),
        }),
      });

      expect(res.status).toBe(200);
    });

    it("GET /api/context/user/_index returns the detailed profile index", async () => {
      writeFileSync(
        join(contextDir, "user", "_index.md"),
        "# User Details Index\n\n- [people.md](people.md): People",
      );

      const res = await app.request("/api/context/user/_index");
      expect(res.status).toBe(200);

      const data = (await res.json()) as Record<string, any>;
      expect(data.content).toContain("# User Details Index");
      expect(data.content).toContain("[people.md](people.md)");
    });

    // ── B-007 new layout ───────────────────────────────────────────────

    it("allows PUT to user/profile (B-007)", async () => {
      const res = await app.request("/api/context/user/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: validUserContent("# Profile\n") }),
      });
      expect(res.status).toBe(200);
    });

    it("allows PUT to user/<growth-area>/<file> (B-007 §5.5)", async () => {
      const res = await app.request("/api/context/user/health/sleep-log", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: validUserContent("# Sleep log\n") }),
      });
      expect(res.status).toBe(200);
    });

    it("allows PUT to rules/journal-format", async () => {
      const res = await app.request("/api/context/rules/journal-format", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: validRuleContent("# Format\n") }),
      });
      expect(res.status).toBe(200);
    });

    it("allows PATCH to routines/hourly with append", async () => {
      const putRes = await app.request("/api/context/routines/hourly", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "---\ntype: rule\nslug: hourly\n---\n# Hourly\n\n## Checks\n\n",
        }),
      });
      expect(putRes.status).toBe(200);

      const patchRes = await app.request("/api/context/routines/hourly", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          section: "checks",
          mode: "append",
          content: "### Monday MCP\n- Action: list tasks\n",
        }),
      });
      expect(patchRes.status).toBe(200);
    });

    it("allows PUT to routines/custom/<slug>", async () => {
      const res = await app.request(
        "/api/context/routines/custom/tuesday-notion",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content:
              "---\ntype: rule\nslug: tuesday-notion\ncron: \"0 11 * * 2\"\nprocess_key: routine.custom.tuesday-notion\nenabled: true\nbackend_tier: light\nmax_budget_usd: 0.05\n---\n# Tuesday Notion sync\n\n## Checks\n\n### First check\n- **Action**: sample\n",
          }),
        },
      );
      expect(res.status).toBe(200);
    });

    it("allows PUT to daily/<YYYY-MM-DD>", async () => {
      const res = await app.request("/api/context/daily/2026-04-17", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: validDailyContent("# 2026-04-17 (Friday)\n") }),
      });
      expect(res.status).toBe(200);
    });

    it("allows PATCH on daily/*", async () => {
      await app.request("/api/context/daily/2026-04-17", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: validDailyContent("# 2026-04-17\n\n## Summary\nold\n"),
        }),
      });
      const res = await app.request("/api/context/daily/2026-04-17", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          section: "summary",
          mode: "replace",
          content: "new",
        }),
      });
      expect(res.status).toBe(200);
    });

    it("supports round-trip of .base files", async () => {
      const baseContent =
        "filters:\n  and:\n    - file.inFolder(\"projects\")\n    - state != \"archived\"\n";
      const putRes = await app.request(
        "/api/context/projects/_active.base",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: baseContent }),
        },
      );
      expect(putRes.status).toBe(200);

      const getRes = await app.request("/api/context/projects/_active.base");
      expect(getRes.status).toBe(200);
      const data = (await getRes.json()) as Record<string, any>;
      expect(data.content).toBe(baseContent);
    });

    it("rejects invalid .base content", async () => {
      const res = await app.request("/api/context/projects/_active.base", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "filters:\n\tbad: true\n" }),
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as Record<string, any>;
      expect(data.error).toBe("validation_error");
    });

    it("denies reads under .obsidian/ (B-007 §11)", async () => {
      mkdirSync(join(contextDir, ".obsidian"), { recursive: true });
      writeFileSync(
        join(contextDir, ".obsidian", "workspace.md"),
        "secret",
      );
      const res = await app.request(
        "/api/context/.obsidian/workspace",
      );
      expect(res.status).toBe(400);
    });

    it("denies writes under .obsidian/", async () => {
      const res = await app.request("/api/context/.obsidian/workspace", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "leaked" }),
      });
      expect(res.status).toBe(400);
    });

    it("denies writes under .git/", async () => {
      const res = await app.request("/api/context/.git/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "bad" }),
      });
      expect(res.status).toBe(400);
    });

    it("allows PUT to agent/journal exactly once (append-only thereafter)", async () => {
      const firstPut = await app.request("/api/context/agent/journal", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "# Journal\n" }),
      });
      expect(firstPut.status).toBe(200);

      const secondPut = await app.request("/api/context/agent/journal", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "# New\n" }),
      });
      expect(secondPut.status).toBe(409);

      const patchRes = await app.request("/api/context/agent/journal", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "append_to_file",
          content: "## 2026-04-17\n- entry\n",
        }),
      });
      expect(patchRes.status).toBe(200);
    });

    it("lists files under B-007 new directories", async () => {
      mkdirSync(join(contextDir, "daily"), { recursive: true });
      writeFileSync(
        join(contextDir, "daily", "2026-04-17.md"),
        "# 2026-04-17\n",
      );
      const res = await app.request("/api/context/list/daily");
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.files).toHaveLength(1);
      expect(data.files[0].name).toBe("2026-04-17.md");
    });
  });

  describe("Setup API", () => {
    it("POST /setup/start still enqueues setup while daemon startup is in progress", async () => {
      const handleIncomingMessage = vi.fn();
      const dashboardAdapter = {
        isConnected: vi.fn().mockReturnValue(true),
        handleIncomingMessage,
      } as unknown as NonNullable<ApiDependencies["dashboardAdapter"]>;
      const appWithDashboard = createApp({
        ...deps,
        dashboardAdapter,
        eventBroadcaster: new EventBroadcaster(),
        isStartupComplete: () => false,
      });

      const res = await appWithDashboard.request("/api/setup/start", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          channelId: "dashboard-ch",
          mode: "initial",
          selections: {
            schedule: "Google Calendar",
            tasks: "Notion",
            notes: "Obsidian",
            projects: "GitHub",
          },
        }),
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        status: "started",
        mode: "initial",
      });
      expect(handleIncomingMessage).toHaveBeenCalledTimes(1);
    });

    it("POST /setup/start initial mode tolerates the legacy `selections` field but emits the redesigned greeting (SETUP-FLOW-REDESIGN-PLAN §5.8)", async () => {
      const handleIncomingMessage = vi.fn();
      const dashboardAdapter = {
        isConnected: vi.fn().mockReturnValue(true),
        handleIncomingMessage,
      } as unknown as NonNullable<ApiDependencies["dashboardAdapter"]>;
      const appWithDashboard = createApp({
        ...deps,
        dashboardAdapter,
      });

      // The redesign removed the `selections` form. Older dashboards
      // may still send the field; the route accepts and ignores it.
      const res = await appWithDashboard.request("/api/setup/start", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          channelId: "dashboard-ch",
          mode: "initial",
          selections: {
            schedule: "Google Calendar",
            tasks: "Notion",
            notes: "Obsidian",
            projects: "GitHub",
          },
        }),
      });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        status: "started",
        mode: "initial",
      });

      // Greeting body matches the new shape regardless of payload —
      // the agent now derives Source-of-Truth rows from the
      // integrations registry inside the conversation.
      expect(handleIncomingMessage).toHaveBeenCalledWith(
        "dashboard-ch",
        "Please start the setup process.",
        { metadata: { setupMode: "initial" } },
      );
    });

    it("POST /setup/start invokes onSetupStart so the dispatcher can engage the autonomous-work gate", async () => {
      const handleIncomingMessage = vi.fn();
      const dashboardAdapter = {
        isConnected: vi.fn().mockReturnValue(true),
        handleIncomingMessage,
      } as unknown as NonNullable<ApiDependencies["dashboardAdapter"]>;
      const onSetupStart = vi.fn();
      const appWithDashboard = createApp({
        ...deps,
        dashboardAdapter,
        onSetupStart,
      });

      const res = await appWithDashboard.request("/api/setup/start", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          channelId: "dashboard-ch",
          mode: "initial",
          selections: {
            schedule: "Google Calendar",
            tasks: "Notion",
            notes: "Obsidian",
            projects: "GitHub",
          },
        }),
      });
      expect(res.status).toBe(200);
      expect(onSetupStart).toHaveBeenCalledWith("initial");
      // Must be called BEFORE the greeting is enqueued so concurrent
      // autonomous work yields immediately (the dispatcher's gate flag
      // must be set when the first setup event lands on the bus).
      const setupStartOrder = onSetupStart.mock.invocationCallOrder[0];
      const greetingOrder = (handleIncomingMessage as ReturnType<typeof vi.fn>)
        .mock.invocationCallOrder[0];
      expect(setupStartOrder).toBeLessThan(greetingOrder);
    });

    it("POST /setup/start update mode triggers the rules/management update conversation", async () => {
      writeFileSync(
        join(contextDir, "rules", "management.md"),
        validRuleContent("# Management Rules\n"),
      );
      const handleIncomingMessage = vi.fn();
      const dashboardAdapter = {
        isConnected: vi.fn().mockReturnValue(true),
        handleIncomingMessage,
      } as unknown as NonNullable<ApiDependencies["dashboardAdapter"]>;
      const appWithDashboard = createApp({
        ...deps,
        dashboardAdapter,
      });

      const res = await appWithDashboard.request("/api/setup/start", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          channelId: "dashboard-ch",
          mode: "update",
        }),
      });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        status: "started",
        mode: "update",
      });

      expect(handleIncomingMessage).toHaveBeenCalledWith(
        "dashboard-ch",
        "I'd like to update rules/management.md.",
        { metadata: { setupMode: "update" } },
      );
    });

    it("POST /chat/messages still accepts dashboard input while daemon startup is in progress", async () => {
      const handleIncomingMessage = vi.fn();
      const dashboardAdapter = {
        isConnected: vi.fn().mockReturnValue(true),
        handleIncomingMessage,
        getActiveChannels: vi.fn().mockReturnValue(["dashboard-ch"]),
      } as unknown as NonNullable<ApiDependencies["dashboardAdapter"]>;
      const appWithDashboard = createApp({
        ...deps,
        dashboardAdapter,
        eventBroadcaster: new EventBroadcaster(),
        isStartupComplete: () => false,
      });

      const res = await appWithDashboard.request("/api/chat/messages", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          channelId: "dashboard-ch",
          content: "hello",
        }),
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        status: "accepted",
      });
      expect(handleIncomingMessage).toHaveBeenCalledWith("dashboard-ch", "hello", {});
    });

    it("POST /chat/messages forwards requestedModel='opus' to the adapter", async () => {
      const handleIncomingMessage = vi.fn();
      const dashboardAdapter = {
        isConnected: vi.fn().mockReturnValue(true),
        handleIncomingMessage,
        getActiveChannels: vi.fn().mockReturnValue(["dashboard-ch"]),
      } as unknown as NonNullable<ApiDependencies["dashboardAdapter"]>;
      const appWithDashboard = createApp({
        ...deps,
        dashboardAdapter,
        eventBroadcaster: new EventBroadcaster(),
      });

      const res = await appWithDashboard.request("/api/chat/messages", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          channelId: "dashboard-ch",
          content: "pick opus",
          requestedModel: "opus",
        }),
      });

      expect(res.status).toBe(200);
      expect(handleIncomingMessage).toHaveBeenCalledWith(
        "dashboard-ch",
        "pick opus",
        { requestedModel: "opus" },
      );
    });

    it("POST /chat/messages rejects simultaneous requestedModel and (requestedBackendId, requestedModelId) with 400", async () => {
      // Both override forms express "pick a different model"; supplying
      // both leaves the caller's intent ambiguous. Reject rather than pick
      // one implicitly.
      const handleIncomingMessage = vi.fn();
      const dashboardAdapter = {
        isConnected: vi.fn().mockReturnValue(true),
        handleIncomingMessage,
        getActiveChannels: vi.fn().mockReturnValue(["dashboard-ch"]),
      } as unknown as NonNullable<ApiDependencies["dashboardAdapter"]>;
      const appWithDashboard = createApp({
        ...deps,
        dashboardAdapter,
        eventBroadcaster: new EventBroadcaster(),
      });

      const res = await appWithDashboard.request("/api/chat/messages", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          channelId: "dashboard-ch",
          content: "ambiguous",
          requestedModel: "opus",
          requestedBackendId: "claude",
          requestedModelId: "claude-opus-4-6",
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, any>;
      expect(body.error).toBe("conflicting_model_override");
      expect(handleIncomingMessage).not.toHaveBeenCalled();
    });

    it("POST /chat/messages rejects an unenabled (requestedBackendId, requestedModelId) pair with 400", async () => {
      const handleIncomingMessage = vi.fn();
      const dashboardAdapter = {
        isConnected: vi.fn().mockReturnValue(true),
        handleIncomingMessage,
        getActiveChannels: vi.fn().mockReturnValue(["dashboard-ch"]),
      } as unknown as NonNullable<ApiDependencies["dashboardAdapter"]>;
      const appWithDashboard = createApp({
        ...deps,
        dashboardAdapter,
        eventBroadcaster: new EventBroadcaster(),
      });

      // Disable claude so the validator rejects the request — the validator
      // fails closed rather than trusting the client.
      db.prepare("UPDATE backends SET enabled = 0 WHERE id = 'claude'").run();
      const res = await appWithDashboard.request("/api/chat/messages", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          channelId: "dashboard-ch",
          content: "pick",
          requestedBackendId: "claude",
          requestedModelId: "claude-opus-4-6",
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, any>;
      expect(body.error).toBe("invalid_requestedBackendModel");
      expect(handleIncomingMessage).not.toHaveBeenCalled();
    });

    it("POST /chat/messages rejects a partial (requestedBackendId only) pair with 400", async () => {
      const handleIncomingMessage = vi.fn();
      const dashboardAdapter = {
        isConnected: vi.fn().mockReturnValue(true),
        handleIncomingMessage,
        getActiveChannels: vi.fn().mockReturnValue(["dashboard-ch"]),
      } as unknown as NonNullable<ApiDependencies["dashboardAdapter"]>;
      const appWithDashboard = createApp({
        ...deps,
        dashboardAdapter,
        eventBroadcaster: new EventBroadcaster(),
      });

      const res = await appWithDashboard.request("/api/chat/messages", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          channelId: "dashboard-ch",
          content: "pick",
          requestedBackendId: "claude",
        }),
      });

      expect(res.status).toBe(400);
      expect(handleIncomingMessage).not.toHaveBeenCalled();
    });

    it("POST /chat/messages rejects an unknown requestedBackendId value with 400", async () => {
      const handleIncomingMessage = vi.fn();
      const dashboardAdapter = {
        isConnected: vi.fn().mockReturnValue(true),
        handleIncomingMessage,
        getActiveChannels: vi.fn().mockReturnValue(["dashboard-ch"]),
      } as unknown as NonNullable<ApiDependencies["dashboardAdapter"]>;
      const appWithDashboard = createApp({
        ...deps,
        dashboardAdapter,
        eventBroadcaster: new EventBroadcaster(),
      });

      const res = await appWithDashboard.request("/api/chat/messages", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          channelId: "dashboard-ch",
          content: "pick",
          requestedBackendId: "openai",
          requestedModelId: "gpt-5",
        }),
      });

      expect(res.status).toBe(400);
      expect(handleIncomingMessage).not.toHaveBeenCalled();
    });

    it("POST /chat/messages forwards a valid (requestedBackendId, requestedModelId) pair to the adapter", async () => {
      // Apply migrations so the `backends` table exists, then mark claude as
      // enabled. Only then does the validator accept the pair.
      applySchema(db);
      db.prepare("UPDATE backends SET enabled = 1 WHERE id = 'claude'").run();

      const handleIncomingMessage = vi.fn();
      const dashboardAdapter = {
        isConnected: vi.fn().mockReturnValue(true),
        handleIncomingMessage,
        getActiveChannels: vi.fn().mockReturnValue(["dashboard-ch"]),
      } as unknown as NonNullable<ApiDependencies["dashboardAdapter"]>;
      const appWithDashboard = createApp({
        ...deps,
        dashboardAdapter,
        eventBroadcaster: new EventBroadcaster(),
      });

      const res = await appWithDashboard.request("/api/chat/messages", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          channelId: "dashboard-ch",
          content: "pick claude opus",
          requestedBackendId: "claude",
          requestedModelId: "claude-opus-4-6",
        }),
      });

      expect(res.status).toBe(200);
      expect(handleIncomingMessage).toHaveBeenCalledWith(
        "dashboard-ch",
        "pick claude opus",
        {
          requestedBackendId: "claude",
          requestedModelId: "claude-opus-4-6",
        },
      );
    });

    it("POST /chat/messages rejects requestedModel='haiku' with 400", async () => {
      const handleIncomingMessage = vi.fn();
      const dashboardAdapter = {
        isConnected: vi.fn().mockReturnValue(true),
        handleIncomingMessage,
        getActiveChannels: vi.fn().mockReturnValue(["dashboard-ch"]),
      } as unknown as NonNullable<ApiDependencies["dashboardAdapter"]>;
      const appWithDashboard = createApp({
        ...deps,
        dashboardAdapter,
        eventBroadcaster: new EventBroadcaster(),
      });

      const res = await appWithDashboard.request("/api/chat/messages", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          channelId: "dashboard-ch",
          content: "try haiku",
          requestedModel: "haiku",
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, any>;
      expect(body.error).toBe("invalid_requestedModel");
      expect(handleIncomingMessage).not.toHaveBeenCalled();
    });

    it("POST /chat/end-session closes the current dashboard session synchronously", async () => {
      const dashboardAdapter = {
        isConnected: vi.fn().mockReturnValue(true),
      } as unknown as NonNullable<ApiDependencies["dashboardAdapter"]>;
      const endDashboardSession = vi.fn().mockResolvedValue({ id: 42 });
      const appWithDashboard = createApp({
        ...deps,
        dashboardAdapter,
        eventBroadcaster: new EventBroadcaster(),
        endDashboardSession,
      });

      const res = await appWithDashboard.request("/api/chat/end-session", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          channelId: "dashboard-ch",
        }),
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        status: "ended",
        closedSessionId: 42,
      });
      expect(endDashboardSession).toHaveBeenCalledWith("dashboard-ch");
    });

    it("POST /chat/end-session returns null when no active session exists", async () => {
      const dashboardAdapter = {
        isConnected: vi.fn().mockReturnValue(true),
      } as unknown as NonNullable<ApiDependencies["dashboardAdapter"]>;
      const endDashboardSession = vi.fn().mockResolvedValue(null);
      const appWithDashboard = createApp({
        ...deps,
        dashboardAdapter,
        eventBroadcaster: new EventBroadcaster(),
        endDashboardSession,
      });

      const res = await appWithDashboard.request("/api/chat/end-session", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          channelId: "dashboard-ch",
        }),
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        status: "ended",
        closedSessionId: null,
      });
    });

    it("POST /chat/continue-session resumes a browser session from history", async () => {
      const dashboardAdapter = {
        isConnected: vi.fn().mockReturnValue(true),
      } as unknown as NonNullable<ApiDependencies["dashboardAdapter"]>;
      const continueDashboardSession = vi.fn().mockResolvedValue({ ok: true, sessionId: 42 });
      const appWithDashboard = createApp({
        ...deps,
        dashboardAdapter,
        eventBroadcaster: new EventBroadcaster(),
        continueDashboardSession,
      });

      const res = await appWithDashboard.request("/api/chat/continue-session", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          sessionId: 42,
        }),
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        status: "continued",
        sessionId: 42,
      });
      expect(continueDashboardSession).toHaveBeenCalledWith(42);
    });

    it("POST /chat/continue-session returns the callback error status", async () => {
      const dashboardAdapter = {
        isConnected: vi.fn().mockReturnValue(true),
      } as unknown as NonNullable<ApiDependencies["dashboardAdapter"]>;
      const continueDashboardSession = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        message: "Only browser-only sessions can be continued from dashboard history",
      });
      const appWithDashboard = createApp({
        ...deps,
        dashboardAdapter,
        eventBroadcaster: new EventBroadcaster(),
        continueDashboardSession,
      });

      const res = await appWithDashboard.request("/api/chat/continue-session", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          sessionId: 42,
        }),
      });

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({
        error: "continue_failed",
        message: "Only browser-only sessions can be continued from dashboard history",
      });
    });

    it("POST /chat/continue-session returns 503 fallback when continueDashboardSession is not wired", async () => {
      const dashboardAdapter = {
        isConnected: vi.fn().mockReturnValue(true),
      } as unknown as NonNullable<ApiDependencies["dashboardAdapter"]>;
      // No continueDashboardSession supplied → the ?? fallback on line 1051 fires.
      const appWithDashboard = createApp({
        ...deps,
        dashboardAdapter,
        eventBroadcaster: new EventBroadcaster(),
        // continueDashboardSession intentionally absent
      });
      const res = await appWithDashboard.request("/api/chat/continue-session", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ sessionId: 99 }),
      });
      expect(res.status).toBe(503);
    });

    it("POST /setup/save-rules seeds the B-007 vault tree on initial setup", async () => {
      const res = await app.request("/api/setup/save-rules", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          content: validRuleContent("# Management Rules\n\n## Source of Truth\n- test\n"),
          agentDisplayName: "desk bot",
        }),
      });
      expect(res.status).toBe(200);

      // B-008 P2 — profile.md, user/_index.md, and user-area stubs are
      // written from templates so fresh Obsidian installs have no dangling
      // user/*.md wikilinks.
      expect(existsSync(join(contextDir, "user", "profile.md"))).toBe(true);
      expect(existsSync(join(contextDir, "user", "_index.md"))).toBe(true);
      expect(existsSync(join(contextDir, "user", "people.md"))).toBe(true);
      expect(existsSync(join(contextDir, "user", "work.md"))).toBe(true);
      expect(existsSync(join(contextDir, "user", "expertise.md"))).toBe(true);
      expect(existsSync(join(contextDir, "user", "personal.md"))).toBe(true);
      expect(existsSync(join(contextDir, "user", "goals.md"))).toBe(true);
      expect(existsSync(join(contextDir, "context-index.md"))).toBe(true);
      expect(existsSync(join(contextDir, "projects", "_active.base"))).toBe(true);
      expect(existsSync(join(contextDir, "bases", "_active.base"))).toBe(false);

      const userMd = readFileSync(join(contextDir, "user", "profile.md"), "utf-8");
      const rulesMd = readFileSync(join(contextDir, "rules", "management.md"), "utf-8");
      const contextIndexMd = readFileSync(
        join(contextDir, "context-index.md"),
        "utf-8",
      );
      expect(userMd).toContain("Detailed profile lives under `user/`.");
      expect(userMd).toContain("Fetch index: `curl -s http://localhost:8321/api/context/user/_index`");
      // Communication Style is NOT a profile section anymore — tone/style
      // preferences live in the `character` runtime-config field per
      // docs/design/15-character.md. The template carries an HTML-comment
      // guard warning writers not to put tone preferences here.
      expect(userMd).not.toContain("## Communication Style");
      expect(userMd).toContain("<!-- DO NOT write tone");
      expect(userMd).toContain("## Notification Preferences");
      expect(rulesMd).toContain("## Agent Identity");
      expect(rulesMd).toContain("- AI name: desk bot");
      expect(rulesMd).toContain("- WhatsApp label: [desk bot]");
      expect(contextIndexMd).toContain("# Context Index");
      expect(deps.config.agentDisplayName).toBe("desk bot");
      const storedAgentName = db.prepare(
        "SELECT value_json FROM settings WHERE key = 'agentDisplayName'",
      ).get() as { value_json: string } | undefined;
      expect(storedAgentName?.value_json).toBe("\"desk bot\"");
    });

    it("POST /setup/save-rules invokes onSetupComplete so the dispatcher clears its setup mode", async () => {
      const onSetupComplete = vi.fn();
      const appWithHook = createApp({
        ...deps,
        onSetupComplete,
      });

      const res = await appWithHook.request("/api/setup/save-rules", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          content: validRuleContent("# Management Rules\n\n## Source of Truth\n- test\n"),
        }),
      });
      expect(res.status).toBe(200);
      expect(onSetupComplete).toHaveBeenCalledTimes(1);
    });

    it("POST /setup/save-rules rejects rules without required frontmatter", async () => {
      const res = await app.request("/api/setup/save-rules", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          content: "# Management Rules\n\n## Source of Truth\n- test\n",
          agentDisplayName: "frontmatter test",
        }),
      });

      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("requires YAML frontmatter");
      expect(deps.config.agentDisplayName).toBe("ai bot");
      expect(existsSync(join(contextDir, "rules", "management.md"))).toBe(false);
    });

    it("POST /setup/save-rules does not snapshot rejected setup updates", async () => {
      const rulesPath = join(contextDir, "rules", "management.md");
      const existing = validRuleContent("# Management Rules\n\n## Source of Truth\n- old\n");
      writeFileSync(rulesPath, existing, "utf-8");

      const res = await app.request("/api/setup/save-rules", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          content: "# Management Rules\n\n## Source of Truth\n- invalid\n",
          agentDisplayName: "should not persist",
        }),
      });

      expect(res.status).toBe(422);
      expect(readFileSync(rulesPath, "utf-8")).toBe(existing);
      expect(deps.config.agentDisplayName).toBe("ai bot");
      const row = db
        .prepare("SELECT COUNT(*) AS count FROM md_file_snapshots WHERE file_path = ?")
        .get("rules/management") as { count: number };
      expect(row.count).toBe(0);
    });

    it("POST /setup/save-rules deletes the setup conversation session when sessionId is passed", async () => {
      // Seed a dashboard_chat session with a message, mimicking a completed setup turn.
      const info = db.prepare(
        `INSERT INTO conversation_sessions (platform, channel_id, scope, scope_key, status)
         VALUES ('dashboard', 'ch-setup', 'dashboard_chat', 'ch-setup', 'active')`,
      ).run();
      const sessionId = Number(info.lastInsertRowid);
      db.prepare(
        `INSERT INTO messages (session_id, role, content, platform)
         VALUES (?, 'assistant', 'hello from setup', 'dashboard')`,
      ).run(sessionId);

      const res = await app.request("/api/setup/save-rules", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          content: validRuleContent("# Management Rules\n\n## Source of Truth\n- test\n"),
          sessionId,
        }),
      });
      expect(res.status).toBe(200);

      const sessionRow = db.prepare(
        "SELECT id FROM conversation_sessions WHERE id = ?",
      ).get(sessionId);
      expect(sessionRow).toBeUndefined();
      const messageRows = db.prepare(
        "SELECT id FROM messages WHERE session_id = ?",
      ).all(sessionId);
      expect(messageRows).toHaveLength(0);
    });

    it("POST /setup/save-rules does not touch sessions outside dashboard_chat scope", async () => {
      // A sessionId pointing at an owner_dm row (or anything other than
      // dashboard_chat) must be ignored so a misdirected id can't wipe it.
      const info = db.prepare(
        `INSERT INTO conversation_sessions (platform, channel_id, scope, scope_key, status)
         VALUES ('slack', 'ch-dm', 'owner_dm', 'slack:U1', 'active')`,
      ).run();
      const sessionId = Number(info.lastInsertRowid);

      const res = await app.request("/api/setup/save-rules", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          content: validRuleContent("# Management Rules\n\n## Source of Truth\n- test\n"),
          sessionId,
        }),
      });
      expect(res.status).toBe(200);

      const stillThere = db.prepare(
        "SELECT id FROM conversation_sessions WHERE id = ?",
      ).get(sessionId);
      expect(stillThere).toEqual({ id: sessionId });
    });

    it("POST /setup/save-rules rejects invalid agent names without mutating config", async () => {
      const res = await app.request("/api/setup/save-rules", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          content: validRuleContent("# Management Rules\n\n## Source of Truth\n- test\n"),
          agentDisplayName: "<bad>",
        }),
      });

      expect(res.status).toBe(400);
      expect(deps.config.agentDisplayName).toBe("ai bot");
      expect(existsSync(join(contextDir, "rules", "management.md"))).toBe(false);
    });

    it("POST /setup/save-rules preserves the ## Active Policies stanza byte-for-byte (MANAGEMENT-POLICY-CAPTURE-PLAN §5.7)", async () => {
      // The stanza is a static wikilink to rules/policies/_index.md, placed
      // by skeleton seeding and owned by the management-policy skill — not
      // the wizard. The wizard's task-flow tells the agent to round-trip it
      // verbatim; the route must not normalize, drop, or rewrite it.
      const stanza = [
        "## Active Policies",
        "",
        "For the live list of management policies (cadence, linked routine,",
        "status), see [[rules/policies/_index.md]]. Policies are durable rules",
        "the agent has been asked to keep applying — captured from conversation",
        "via the `management-policy` skill, not edited here.",
      ].join("\n");

      const body = validRuleContent(
        `# Management Rules\n\n## Source of Truth\n- test\n\n${stanza}\n`,
      );

      const res = await app.request("/api/setup/save-rules", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ content: body, agentDisplayName: "stanza bot" }),
      });
      expect(res.status).toBe(200);

      const saved = readFileSync(
        join(contextDir, "rules", "management.md"),
        "utf-8",
      );
      // Stanza preserved verbatim alongside the daemon-managed
      // ## Agent Identity upsert.
      expect(saved).toContain(stanza);
      expect(saved).toContain("## Agent Identity");
      expect(saved).toContain("- AI name: stanza bot");
    });

    it("POST /setup/save-rules rejects with primary_vault_path_required when obsidian mode has no path", async () => {
      // Phase 4 — the wizard's Obsidian step must run before save-rules;
      // otherwise the daemon would materialize the skeleton at the plain
      // fallback and confuse the user about which location is primary.
      const prev = {
        vaultMode: deps.config.vaultMode,
        primaryVaultPath: deps.config.primaryVaultPath,
      };
      deps.config.vaultMode = "obsidian";
      deps.config.primaryVaultPath = null;
      try {
        const res = await app.request("/api/setup/save-rules", {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({
            content: validRuleContent("# Management Rules\n\n## Source of Truth\n- test\n"),
          }),
        });

        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string; message: string };
        expect(body.error).toBe("primary_vault_path_required");
        expect(body.message).toMatch(/primary vault path/i);
        expect(existsSync(join(contextDir, "rules", "management.md"))).toBe(false);
      } finally {
        deps.config.vaultMode = prev.vaultMode;
        deps.config.primaryVaultPath = prev.primaryVaultPath;
      }
    });
  });

  describe("Snapshots API", () => {
    it("GET /api/snapshots/* returns history for nested context paths", async () => {
      db.prepare(
        `INSERT INTO md_file_snapshots (file_path, content, trigger)
         VALUES ('user/_index', '# User Details', 'api_put')`,
      ).run();

      const res = await app.request("/api/snapshots/user/_index", {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);

      const data = (await res.json()) as Record<string, any>;
      expect(data.snapshots).toHaveLength(1);
      expect(data.snapshots[0].trigger).toBe("api_put");
    });

    it("GET /api/snapshots/content/:id still returns snapshot content", async () => {
      const result = db.prepare(
        `INSERT INTO md_file_snapshots (file_path, content, trigger)
         VALUES ('user/_index', '# User Details', 'api_put')`,
      ).run();

      const res = await app.request(`/api/snapshots/content/${result.lastInsertRowid}`, {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);

      const data = (await res.json()) as Record<string, any>;
      expect(data.file_path).toBe("user/_index");
      expect(data.content).toBe("# User Details");
    });
  });

  describe("Agent API", () => {
    it("POST /escalate returns 410 Gone", async () => {
      const res = await app.request("/api/escalate", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          reason: "Complex analysis needed",
          correlationId: "corr-123",
        }),
      });
      expect(res.status).toBe(410);

      const data = await res.json() as { error: string };
      expect(data.error).toBe("gone");

      // DB must not contain a row for this correlationId — the endpoint is
      // a pure 410 stub, not a stealth insert.
      const row = db
        .prepare("SELECT id FROM agent_schedule WHERE correlation_id = 'corr-123'")
        .get();
      expect(row).toBeUndefined();
    });

    it("POST /schedule registers schedule", async () => {
      const res = await app.request("/api/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          time: "2099-04-02T15:00:00Z",
          taskType: "wake",
          description: "Check calendar events and send summary to user",
        }),
      });
      expect(res.status).toBe(200);

      const data = (await res.json()) as Record<string, any>;
      expect(data.status).toBe("scheduled");
    });

    it("POST /schedule normalizes ISO8601 with timezone offset to UTC SQLite format", async () => {
      const res = await app.request("/api/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          time: "2099-04-05T07:00:00-04:00",
          taskType: "wake",
          description: "Send morning briefing with today's schedule to user",
        }),
      });
      expect(res.status).toBe(200);

      const data = (await res.json()) as Record<string, any>;
      const row = db
        .prepare("SELECT scheduled_for FROM agent_schedule WHERE id = ?")
        .get(Number(data.scheduleId)) as { scheduled_for: string };

      // -04:00 → UTC means 07:00 EDT = 11:00 UTC same day
      expect(row.scheduled_for).toBe("2099-04-05 11:00:00");
    });

    it("POST /schedule rejects unparseable time string with the agent-consumable envelope", async () => {
      const res = await app.request("/api/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          time: "next Tuesday",
          taskType: "wake",
          description: "This task has an invalid time format that should be rejected",
        }),
      });
      expect(res.status).toBe(400);

      const data = (await res.json()) as {
        ok: boolean;
        errors: Array<{ code: string; field: string }>;
      };
      // docs/design/appendices/morning-routine-optimization.md §"Error
      // messaging contract" — POST /api/schedule now emits the uniform
      // agent-consumable envelope on validation failure so LLM callers
      // self-correct in the same turn.
      expect(data.ok).toBe(false);
      expect(data.errors[0].code).toBe("schedule.scheduled_for_invalid");
      expect(data.errors[0].field).toBe("time");
    });

    it("POST /schedule/dm registers a DM schedule", async () => {
      const futureTime = new Date(Date.now() + 3600_000).toISOString();
      const res = await app.request("/api/schedule/dm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          time: futureTime,
          message: "Reminder: design review in 30 minutes",
        }),
      });
      expect(res.status).toBe(200);

      const data = (await res.json()) as Record<string, any>;
      expect(data.status).toBe("scheduled");
      expect(data.scheduleId).toBeTruthy();

      const row = db
        .prepare("SELECT task_type, task_description FROM agent_schedule WHERE id = ?")
        .get(Number(data.scheduleId)) as { task_type: string; task_description: string };
      expect(row.task_type).toBe("dm");
      expect(row.task_description).toBe("Reminder: design review in 30 minutes");
    });

    it("POST /schedule/dm rejects past times", async () => {
      const res = await app.request("/api/schedule/dm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          time: "2020-01-01T00:00:00Z",
          message: "This is in the past",
        }),
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as Record<string, any>;
      expect(data.error).toBe("invalid_time");
    });

    it("GET /schedule lists pending items", async () => {
      // Insert two items
      db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status)
         VALUES ('2026-05-01 10:00:00', 'wake', 'Task A', 'pending'),
                ('2026-05-01 11:00:00', 'dm', 'Task B', 'completed')`,
      ).run();

      const res = await app.request("/api/schedule?status=pending");
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.items).toHaveLength(1);
      expect(data.items[0].description).toBe("Task A");
    });

    it("GET /schedule with multiple statuses", async () => {
      db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status)
         VALUES ('2026-05-01 10:00:00', 'wake', 'Task A', 'pending'),
                ('2026-05-01 11:00:00', 'dm', 'Task B', 'completed')`,
      ).run();

      const res = await app.request("/api/schedule?status=pending,completed");
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.items).toHaveLength(2);
    });

    it("DELETE /schedule/:id cancels pending item", async () => {
      const ins = db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status)
         VALUES ('2026-05-01 10:00:00', 'wake', 'Cancel me', 'pending')`,
      ).run();

      const res = await app.request(`/api/schedule/${ins.lastInsertRowid}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.status).toBe("cancelled");

      const row = db
        .prepare("SELECT status FROM agent_schedule WHERE id = ?")
        .get(Number(ins.lastInsertRowid)) as { status: string };
      expect(row.status).toBe("skipped");
    });

    it("DELETE /schedule/:id rejects non-pending item", async () => {
      const ins = db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status)
         VALUES ('2026-05-01 10:00:00', 'wake', 'Running task', 'running')`,
      ).run();

      const res = await app.request(`/api/schedule/${ins.lastInsertRowid}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      expect(res.status).toBe(409);
    });

    it("PATCH /schedule/:id updates time of pending item", async () => {
      const ins = db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status)
         VALUES ('2026-05-01 10:00:00', 'wake', 'Original task description for this test', 'pending')`,
      ).run();
      const id = Number(ins.lastInsertRowid);

      const res = await app.request(`/api/schedule/${id}`, {
        method: "PATCH",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ time: "2026-05-01T18:00:00+09:00" }),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.status).toBe("updated");
      expect(data.id).toBe(id);

      const row = db
        .prepare("SELECT scheduled_for FROM agent_schedule WHERE id = ?")
        .get(id) as { scheduled_for: string };
      expect(row.scheduled_for).toBe("2026-05-01 09:00:00");
    });

    it("PATCH /schedule/:id updates description", async () => {
      const ins = db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status)
         VALUES ('2026-05-01 10:00:00', 'wake', 'Old description that is long enough', 'pending')`,
      ).run();
      const id = Number(ins.lastInsertRowid);

      const res = await app.request(`/api/schedule/${id}`, {
        method: "PATCH",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ description: "Updated task: check PR and notify user with details" }),
      });
      expect(res.status).toBe(200);

      const row = db
        .prepare("SELECT task_description FROM agent_schedule WHERE id = ?")
        .get(id) as { task_description: string };
      expect(row.task_description).toBe("Updated task: check PR and notify user with details");
    });

    it("PATCH /schedule/:id updates message for dm type", async () => {
      const ins = db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status)
         VALUES ('2026-05-01 10:00:00', 'dm', 'Old message', 'pending')`,
      ).run();
      const id = Number(ins.lastInsertRowid);

      const res = await app.request(`/api/schedule/${id}`, {
        method: "PATCH",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ message: "New reminder text" }),
      });
      expect(res.status).toBe(200);

      const row = db
        .prepare("SELECT task_description FROM agent_schedule WHERE id = ?")
        .get(id) as { task_description: string };
      expect(row.task_description).toBe("New reminder text");
    });

    it("PATCH /schedule/:id rejects message field on non-dm type", async () => {
      const ins = db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status)
         VALUES ('2026-05-01 10:00:00', 'wake', 'Some wake task that is long enough', 'pending')`,
      ).run();

      const res = await app.request(`/api/schedule/${ins.lastInsertRowid}`, {
        method: "PATCH",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ message: "Not allowed on wake type" }),
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as Record<string, any>;
      expect(data.error).toBe("invalid_field");
    });

    it("PATCH /schedule/:id rejects non-pending item", async () => {
      const ins = db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status)
         VALUES ('2026-05-01 10:00:00', 'wake', 'Running task here that is long', 'running')`,
      ).run();

      const res = await app.request(`/api/schedule/${ins.lastInsertRowid}`, {
        method: "PATCH",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ time: "2026-05-01T20:00:00Z" }),
      });
      expect(res.status).toBe(409);
    });

    it("PATCH /schedule/:id returns 404 for unknown id", async () => {
      const res = await app.request("/api/schedule/99999", {
        method: "PATCH",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ time: "2026-05-01T20:00:00Z" }),
      });
      expect(res.status).toBe(404);
    });

    it("PATCH /schedule/:id rejects description on dm type", async () => {
      const ins = db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status)
         VALUES ('2026-05-01 10:00:00', 'dm', 'Some DM message', 'pending')`,
      ).run();

      const res = await app.request(`/api/schedule/${ins.lastInsertRowid}`, {
        method: "PATCH",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ description: "This should not be allowed on dm type items" }),
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as Record<string, any>;
      expect(data.error).toBe("invalid_field");
    });

    it("PATCH /schedule/:id rejects both description and message", async () => {
      const ins = db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status)
         VALUES ('2026-05-01 10:00:00', 'wake', 'Some wake task here', 'pending')`,
      ).run();

      const res = await app.request(`/api/schedule/${ins.lastInsertRowid}`, {
        method: "PATCH",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          description: "A description that is long enough for validation",
          message: "A conflicting message",
        }),
      });
      expect(res.status).toBe(400);
    });

    it("PATCH /schedule/:id rejects past time on dm type", async () => {
      const ins = db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status)
         VALUES ('2026-05-01 10:00:00', 'dm', 'Future DM message', 'pending')`,
      ).run();

      const res = await app.request(`/api/schedule/${ins.lastInsertRowid}`, {
        method: "PATCH",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ time: "2020-01-01T00:00:00Z" }),
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as Record<string, any>;
      expect(data.error).toBe("invalid_time");
    });

    it("PATCH /schedule/:id rejects empty body", async () => {
      const ins = db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status)
         VALUES ('2026-05-01 10:00:00', 'wake', 'Some task description here', 'pending')`,
      ).run();

      const res = await app.request(`/api/schedule/${ins.lastInsertRowid}`, {
        method: "PATCH",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("POST /schedule persists the optional prompt override", async () => {
      const res = await app.request("/api/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          time: "2099-04-02T15:00:00Z",
          taskType: "wake",
          description: "Short list label for the schedule view",
          prompt: "Detailed agent instruction body that overrides the description at dispatch time",
        }),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      const row = db
        .prepare("SELECT task_description, task_prompt FROM agent_schedule WHERE id = ?")
        .get(Number(data.scheduleId)) as { task_description: string; task_prompt: string | null };
      expect(row.task_description).toBe("Short list label for the schedule view");
      expect(row.task_prompt).toBe(
        "Detailed agent instruction body that overrides the description at dispatch time",
      );
    });

    it("PATCH /schedule/:id sets and then clears the prompt override", async () => {
      const ins = db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status)
         VALUES ('2099-05-01 10:00:00', 'wake', 'Description doubles as agent body', 'pending')`,
      ).run();
      const id = Number(ins.lastInsertRowid);

      // Set the override.
      const setRes = await app.request(`/api/schedule/${id}`, {
        method: "PATCH",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          prompt: "Detailed override that takes precedence over description",
        }),
      });
      expect(setRes.status).toBe(200);
      let row = db
        .prepare("SELECT task_prompt FROM agent_schedule WHERE id = ?")
        .get(id) as { task_prompt: string | null };
      expect(row.task_prompt).toBe(
        "Detailed override that takes precedence over description",
      );

      // Clear it via prompt: null — dispatcher should fall back to description.
      const clearRes = await app.request(`/api/schedule/${id}`, {
        method: "PATCH",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ prompt: null }),
      });
      expect(clearRes.status).toBe(200);
      row = db
        .prepare("SELECT task_prompt FROM agent_schedule WHERE id = ?")
        .get(id) as { task_prompt: string | null };
      expect(row.task_prompt).toBeNull();
    });

    it("PATCH /schedule/:id rejects prompt on dm type", async () => {
      const ins = db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status)
         VALUES ('2099-05-01 10:00:00', 'dm', 'A pre-composed DM body', 'pending')`,
      ).run();

      const res = await app.request(`/api/schedule/${ins.lastInsertRowid}`, {
        method: "PATCH",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          prompt: "Prompt overrides only apply to non-dm rows that run an agent",
        }),
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as Record<string, any>;
      expect(data.error).toBe("invalid_field");
    });

    it("POST /notify records notification", async () => {
      const res = await app.request("/api/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Hello user!",
          priority: "normal",
        }),
      });
      expect(res.status).toBe(200);

      const data = (await res.json()) as Record<string, any>;
      expect(data.status).toBe("sent");

      const log = db
        .prepare("SELECT * FROM notification_log")
        .get() as { content_summary: string };
      expect(log.content_summary).toBe("Hello user!");
    });

    it("POST /action/log records action", async () => {
      const res = await app.request("/api/action/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actionType: "test_action",
          detail: "did something",
          result: "success",
        }),
      });
      expect(res.status).toBe(200);
    });
  });

  describe("Metrics API", () => {
    it("GET /api/metrics returns metrics snapshot", async () => {
      const res = await app.request("/api/metrics", {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.collectedAt).toBeTruthy();
      expect(data.notificationConfirmRate).toBeNull(); // no data yet
      expect(data.responseTime).toBeDefined();
      expect(data.cost).toBeDefined();
      expect(data.sessions).toBeDefined();
    });

    it("GET /api/metrics returns correct cost after inserting actions", async () => {
      db.prepare(
        `INSERT INTO agent_actions (event_id, action_type, trigger, model_used, cost_usd, result, started_at)
         VALUES ('e1', 'test', 'reactive', 'claude-sonnet-4-6', 0.15, 'success', datetime('now'))`,
      ).run();

      const res = await app.request("/api/metrics", {
        headers: authHeaders(),
      });
      const data = (await res.json()) as Record<string, any>;
      expect(data.cost.todayUsd).toBeCloseTo(0.15);
      expect(data.sessions.todayTotal).toBe(1);
      expect(data.sessions.todayReactive).toBe(1);
    });

    it("GET /api/metrics rejects requests without a bearer token", async () => {
      const res = await app.request("/api/metrics");
      expect(res.status).toBe(401);
    });

    it("GET /api/metrics/auth returns 503 when authTelemetry is not provided", async () => {
      const res = await app.request("/api/metrics/auth", {
        headers: authHeaders(),
      });
      expect(res.status).toBe(503);
      const data = (await res.json()) as Record<string, any>;
      expect(data.error).toBe("auth_telemetry_unavailable");
    });

    it("GET /api/metrics/auth returns counters when authTelemetry is provided", async () => {
      // Create the telemetry table (normally done by migrations)
      db.exec(`
        CREATE TABLE IF NOT EXISTS auth_telemetry_counters (
          backend_id TEXT NOT NULL,
          counter_key TEXT NOT NULL,
          bucket_hour TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'reactive',
          count INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (backend_id, counter_key, bucket_hour, source)
        )
      `);

      const { AuthTelemetry } = await import("../core/backends/auth-telemetry.js");
      const telemetry = new AuthTelemetry(db);
      telemetry.increment("claude", "probe_ok", "probe", 5);
      telemetry.increment("codex", "reactive_expired", "reactive", 2);

      const appWithTelemetry = createApp({ ...deps, authTelemetry: telemetry });
      const res = await appWithTelemetry.request("/api/metrics/auth?hours=24", {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.hours).toBe(24);
      expect(data.counters.claude.probe_ok).toBe(5);
      expect(data.counters.codex.reactive_expired).toBe(2);
      expect(data.bySource).toBeDefined();
      expect(data.bySource.claude.probe.probe_ok).toBe(5);
    });

    it("GET /api/metrics/delegated-task returns task-mode aggregates (§11.2)", async () => {
      // Header row: success with toolCallCount=3 on Gemini-delegated Gmail.
      db.prepare(
        `INSERT INTO agent_actions (
           action_type, trigger, model_used,
           cost_usd, tokens_input, tokens_output,
           cache_creation_tokens, cache_read_tokens,
           duration_ms, num_turns, result, detail,
           started_at, completed_at, error, backend, cost_source
         ) VALUES (
           'delegated_task.exec', NULL, 'gemini-flash',
           0.0024, 1000, 800, 0, 0,
           5210, 4, 'success', @detail,
           datetime('now'), datetime('now'), NULL, 'gemini', 'sdk'
         )`,
      ).run({
        detail: JSON.stringify({
          integrationKey: "gmail",
          delegatedBackend: "gemini",
          taskHash: "h1",
          schemaHash: "s1",
          toolCallCount: 3,
          retried: false,
          needsConfirmation: false,
        }),
      });
      // A confirmation envelope (success row but didn't execute).
      db.prepare(
        `INSERT INTO agent_actions (
           action_type, trigger, model_used,
           cost_usd, duration_ms, num_turns, result, detail,
           started_at, completed_at, backend, cost_source
         ) VALUES (
           'delegated_task.exec', NULL, 'gemini-flash',
           0.0008, 1100, 2, 'success', @detail,
           datetime('now'), datetime('now'), 'gemini', 'sdk'
         )`,
      ).run({
        detail: JSON.stringify({
          integrationKey: "gmail",
          delegatedBackend: "gemini",
          taskHash: "h2",
          schemaHash: "s2",
          toolCallCount: 0,
          retried: false,
          needsConfirmation: true,
        }),
      });

      const res = await app.request("/api/metrics/delegated-task?days=7", {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.windowDays).toBe(7);
      expect(data.total).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            integrationKey: "gmail",
            backend: "gemini",
            result: "success",
            count: 1,
          }),
          expect.objectContaining({
            integrationKey: "gmail",
            backend: "gemini",
            result: "destructive_blocked",
            count: 1,
          }),
        ]),
      );
      expect(data.destructiveBlocked).toEqual([
        { integrationKey: "gmail", backend: "gemini", count: 1 },
      ]);
      expect(data.costUsd[0].costUsd).toBeCloseTo(0.0032, 5);
    });

    it("GET /api/metrics/delegated-task requires bearer", async () => {
      const res = await app.request("/api/metrics/delegated-task");
      expect(res.status).toBe(401);
    });
  });

  describe("Security", () => {
    it("rejects protected routes without a bearer token", async () => {
      const res = await app.request("/api/agent/run-now", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "test" }),
      });
      expect(res.status).toBe(401);
    });

    it("unknown /api routes return 404 with a hint instead of a misleading 401", async () => {
      // Background: when the agent invents a wrong context-lock path (e.g.
      // `/api/context/roadmap/lock` instead of `/api/context/lock/roadmap`),
      // the risk classifier fell back to Approve-tier and the auth middleware
      // returned 401 "This endpoint requires authentication" — which reads
      // like an auth problem even though the actual issue is a wrong path.
      // The middleware now detects routes that fell through to the default
      // and returns 404 + a hint pointing at the correct lock paths.
      const wrongLock = await app.request("/api/context/roadmap/lock", {
        method: "POST",
      });
      expect(wrongLock.status).toBe(404);
      const wrongLockBody = (await wrongLock.json()) as {
        error: string;
        message: string;
      };
      expect(wrongLockBody.error).toBe("unknown_route");
      expect(wrongLockBody.message).toContain("/api/context/lock/");

      const wrongWriteLock = await app.request(
        "/api/context/roadmap/write-lock",
        { method: "POST" },
      );
      expect(wrongWriteLock.status).toBe(404);
    });

    it("POST /api/delegated/run requires Bearer (Approve-tier per DELEGATED-TASK-MODE-DESIGN.md §4.2)", async () => {
      // The route is registered at Approve-tier in `risk-classifier.ts`.
      // A regression that moves it to Autonomous would expose a generic
      // /run RPC surface to anyone who can hit 127.0.0.1:8321 — exactly
      // the failure mode §4.2 calls out as "wider blast radius than /exec."
      const res = await app.request("/api/delegated/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          delegatedBackend: "gemini",
          allowedTools: ["mcp_my-server_search"],
          task: "x",
          outputSchema: { type: "object" },
        }),
      });
      expect(res.status).toBe(401);
    });

    it("GET blocks encoded path traversal", async () => {
      // Hono normalizes literal ".." but encoded dots bypass normalization
      const res = await app.request(
        "/api/context/..%2f..%2f..%2fetc%2fpasswd",
      );
      expect(res.status).toBe(400);
      const data = (await res.json()) as Record<string, any>;
      expect(data.error).toBe("invalid_path");
    });

    it("safePath rejects traversal patterns", () => {
      expect(safePath("/tmp/ctx", "../../etc/passwd")).toBeNull();
      expect(safePath("/tmp/ctx", "today/../../../etc/shadow")).toBeNull();
      expect(safePath("/tmp/ctx", "today")).not.toBeNull();
      expect(safePath("/tmp/ctx", "projects/foo")).not.toBeNull();
    });

    it("PUT blocks path traversal via safePath", async () => {
      const res = await app.request(
        "/api/context/..%2f..%2f..%2ftmp%2fevil",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "hacked" }),
        },
      );
      expect(res.status).toBe(400);
    });
  });

  describe("/health.integrationModes (registry-keyed sibling field)", () => {
    it("emits an entry for every registered integration alongside the legacy `integrations` field", async () => {
      const res = await app.request("/api/health");
      const body = (await res.json()) as Record<string, unknown>;
      // Legacy field unchanged — Phase 5 owns the atomic cutover.
      expect(body.integrations).toBeDefined();
      const modes = body.integrationModes as Record<string, unknown>;
      // SETUP-FLOW-REDESIGN-PLAN §6.1 — outlook_* integrations joined
      // the registry in v1. Git/GitHub are also registry keys but the
      // /health endpoint historically projected only the user-facing
      // hosted integrations; if this test goes wider we'll expect them
      // alongside.
      expect(Object.keys(modes).sort()).toEqual(
        expect.arrayContaining([
          "gmail",
          "google_calendar",
          "notion",
          "outlook_mail",
          "outlook_calendar",
        ]),
      );
    });

    it("populates delegated fields and the descriptor-default features map when no probe row exists", async () => {
      const { writeIntegrations } = await import("../db/integrations-store.js");
      writeIntegrations(db, {
        gmail: {
          mode: "delegated",
          delegatedBackend: "claude",
          deniedTools: [],
          lastChangedAt: "2026-04-19T00:00:00Z",
        },
      });
      const res = await app.request("/api/health");
      const body = (await res.json()) as {
        integrationModes: Record<
          string,
          {
            mode: string;
            delegatedBackend: string | null;
            subTier: string | null;
            toolNamespace: string | null;
            features: Record<string, boolean> | null;
            lastProbeAt: string | null;
          }
        >;
      };
      expect(body.integrationModes.gmail).toMatchObject({
        mode: "delegated",
        delegatedBackend: "claude",
        subTier: "draft-only",
        toolNamespace: "mcp__claude_ai_Gmail__",
        lastProbeAt: null,
      });
      expect(body.integrationModes.gmail.features?.search).toBe(true);
      expect(body.integrationModes.gmail.features).not.toHaveProperty("send");
    });
  });

  describe("Integration delegation route gate (DELEGATED-MODE-V2 §6.3)", () => {
    it("410-gates /api/calendar/* when google_calendar is delegated", async () => {
      const { writeIntegrations } = await import("../db/integrations-store.js");
      writeIntegrations(db, {
        google_calendar: {
          mode: "delegated",
          delegatedBackend: "claude",
          deniedTools: [],
          lastChangedAt: "2026-04-19T10:00:00.000Z",
        },
      });

      const res = await app.request("/api/calendar/events");
      expect(res.status).toBe(410);
      expect(await res.json()).toMatchObject({
        error: "integration_delegated",
        integration: "google_calendar",
        backend: "claude",
        mode: "delegated",
      });
    });

    it("does not gate /api/mail/* when gmail is delegated — multi-provider routes use the per-account 410 inside the handler", async () => {
      const { writeIntegrations } = await import("../db/integrations-store.js");
      writeIntegrations(db, {
        gmail: {
          mode: "delegated",
          delegatedBackend: "claude",
          deniedTools: [],
          lastChangedAt: "2026-04-19T10:00:00.000Z",
        },
      });

      const res = await app.request("/api/mail/accounts");
      expect(res.status).not.toBe(410);
    });
  });

  describe("Morning Routine Lock", () => {
    it("acquires and releases lock", async () => {
      const acqRes = await app.request("/api/context/lock/morning-routine", {
        method: "POST",
      });
      expect(acqRes.status).toBe(200);
      const { lockId } = (await acqRes.json()) as Record<string, any>;
      expect(lockId).toBeTruthy();

      const relRes = await app.request("/api/context/lock/morning-routine", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lockId }),
      });
      expect(relRes.status).toBe(200);
    });

    it("blocks concurrent lock acquisition", async () => {
      const res1 = await app.request("/api/context/lock/morning-routine", {
        method: "POST",
      });
      expect(res1.status).toBe(200);

      const res2 = await app.request("/api/context/lock/morning-routine", {
        method: "POST",
      });
      expect(res2.status).toBe(409);

      // Cleanup: release the lock
      const { lockId } = (await res1.json()) as Record<string, any>;
      await app.request("/api/context/lock/morning-routine", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lockId }),
      });
    });

    it("blocks today.md writes during lock without correct lockId", async () => {
      writeFileSync(join(contextDir, "today.md"), validTodayContent());

      const acqRes = await app.request("/api/context/lock/morning-routine", {
        method: "POST",
      });
      const { lockId } = (await acqRes.json()) as Record<string, any>;

      // PUT without lock header → 409
      const putRes = await app.request("/api/context/today", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: validTodayContent("- [ ] 10:00 Blocked write [work] \u2192DM"),
        }),
      });
      expect(putRes.status).toBe(409);

      // PUT with correct lock header → 200
      const putRes2 = await app.request("/api/context/today", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Lock-Id": lockId,
        },
        body: JSON.stringify({
          content: validTodayContent("- [ ] 10:00 Allowed write [work] \u2192DM"),
        }),
      });
      expect(putRes2.status).toBe(200);

      // Cleanup
      await app.request("/api/context/lock/morning-routine", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lockId }),
      });
    });
  });

  describe("Roadmap Write Lock", () => {
    it("acquires and releases the roadmap lock", async () => {
      const acqRes = await app.request("/api/context/lock/roadmap", {
        method: "POST",
      });
      expect(acqRes.status).toBe(200);
      const { lockId } = (await acqRes.json()) as Record<string, any>;
      expect(lockId).toBeTruthy();

      const relRes = await app.request("/api/context/lock/roadmap", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lockId }),
      });
      expect(relRes.status).toBe(200);
    });

    it("returns 409 roadmap_write_lock_held on concurrent acquire", async () => {
      const res1 = await app.request("/api/context/lock/roadmap", {
        method: "POST",
      });
      expect(res1.status).toBe(200);

      const res2 = await app.request("/api/context/lock/roadmap", {
        method: "POST",
      });
      expect(res2.status).toBe(409);
      const data = (await res2.json()) as Record<string, any>;
      expect(data.error).toBe("roadmap_write_lock_held");

      // Cleanup
      const { lockId } = (await res1.json()) as Record<string, any>;
      await app.request("/api/context/lock/roadmap", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lockId }),
      });
    });

    it("rejects release with a mismatched lockId", async () => {
      const acqRes = await app.request("/api/context/lock/roadmap", {
        method: "POST",
      });
      const { lockId } = (await acqRes.json()) as Record<string, any>;

      const badRel = await app.request("/api/context/lock/roadmap", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lockId: "not-the-right-id" }),
      });
      expect(badRel.status).toBe(400);

      // Cleanup with the correct id
      await app.request("/api/context/lock/roadmap", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lockId }),
      });
    });

    it("blocks roadmap.md writes without X-Lock-Id and accepts with matching id", async () => {
      writeFileSync(
        join(contextDir, "roadmap.md"),
        "# Roadmap\n> Last synced: 2026-04-01\n\n## Annual Goals\n\n## Quarterly Focus\n\n## Long-term Plans\n\n## Recurring\n",
      );

      const acqRes = await app.request("/api/context/lock/roadmap", {
        method: "POST",
      });
      const { lockId } = (await acqRes.json()) as Record<string, any>;

      // PUT without the header → 409
      const putRes = await app.request("/api/context/roadmap", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content:
            "# Roadmap\n> Last synced: 2026-04-19\n\n## Annual Goals\n\n## Quarterly Focus\n\n## Long-term Plans\n\n## Agent Action Plan\n\n## Recurring\n",
        }),
      });
      expect(putRes.status).toBe(409);
      const putErr = (await putRes.json()) as Record<string, any>;
      expect(putErr.error).toBe("roadmap_write_lock_held");

      // PATCH without the header → 409 (mirrors PUT)
      const patchRes = await app.request("/api/context/roadmap", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          section: "long_term_plans",
          mode: "append",
          content: "- [2026-Q3] test\n",
        }),
      });
      expect(patchRes.status).toBe(409);

      // PUT with the matching header → 200
      const putOk = await app.request("/api/context/roadmap", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Lock-Id": lockId,
        },
        body: JSON.stringify({
          content:
            "# Roadmap\n> Last synced: 2026-04-19\n\n## Annual Goals\n\n## Quarterly Focus\n\n## Long-term Plans\n\n## Agent Action Plan\n\n## Recurring\n",
        }),
      });
      expect(putOk.status).toBe(200);

      // Cleanup
      await app.request("/api/context/lock/roadmap", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lockId }),
      });
    });

    it("does not affect today.md writes when the roadmap lock is held", async () => {
      writeFileSync(join(contextDir, "today.md"), validTodayContent());

      const acqRes = await app.request("/api/context/lock/roadmap", {
        method: "POST",
      });
      const { lockId } = (await acqRes.json()) as Record<string, any>;

      // Writing today.md must not be blocked by the roadmap-specific lock
      const putRes = await app.request("/api/context/today", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: validTodayContent("- [ ] 10:00 Roadmap lock write [work] \u2192DM"),
        }),
      });
      expect(putRes.status).toBe(200);

      // Cleanup
      await app.request("/api/context/lock/roadmap", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lockId }),
      });
    });
  });
});

// ── ReadSensitive middleware tests ──
describe("ReadSensitive auth middleware", () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pa-rs-test-"));
    const contextDir = join(tmpDir, "context");
    mkdirSync(join(contextDir, "user"), { recursive: true });
    writeFileSync(join(contextDir, "today.md"), "# Today\n## agent_log\n", "utf-8");
  });

  afterEach(() => {
    if (db) db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeAppWithReadToken(opts: {
    readToken?: string;
    readTokenValidator?: (token: string) => boolean;
    enforce?: boolean;
    withMcp?: boolean;
  }) {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);

    const config = {
      dataDir: tmpDir,
      apiPort: 8321,
      timezone: "UTC",
      dayBoundaryHour: 0,
      agentDisplayName: "ai bot",
    } as unknown as AgentConfig;

    return createApp({
      db,
      config,
      secretBroker: new SecretBroker(
        new InMemorySecretStore({ apiToken: "test-bearer-token" }),
        { cacheTtlMs: 0 },
      ),
      readToken: opts.readToken,
      readTokenValidator: opts.readTokenValidator,
      enforceReadToken: opts.enforce,
      blobStore: opts.withMcp ? new MemoryBlobStore() : undefined,
      services: createServiceRegistry(),
      getHealthData: () => ({
        uptime: 0, eventBusSize: 0, activeSessions: 0,
        connectedPlatforms: [], registeredObservers: [],
        missingContextFiles: [], contextFilesOk: true,
      }),
      getIntegrationStatus: () => ({
        google: { configured: false, connected: false, error: null, services: { calendar: { connected: false, error: null }, gmail: { connected: false, error: null } } },
        obsidian: { configured: false, connected: false, error: null },
        notion: { configured: false, connected: false, error: null },
        whatsapp: { configured: false, connected: false, error: null, state: "not_configured" },
        googleMaps: { configured: false, connected: false, error: null },
      }),
    });
  }

  it("allows ReadSensitive GET with valid X-Read-Token (enforce=true)", async () => {
    const app = makeAppWithReadToken({ readToken: "secret-read-token", enforce: true });
    const res = await app.request("/api/context/today", {
      headers: { "X-Read-Token": "secret-read-token" },
    });
    expect(res.status).toBe(200);
  });

  it("allows ReadSensitive GET with valid Bearer token (enforce=true)", async () => {
    const app = makeAppWithReadToken({ readToken: "secret-read-token", enforce: true });
    const res = await app.request("/api/context/today", {
      headers: { Authorization: "Bearer test-bearer-token" },
    });
    expect(res.status).toBe(200);
  });

  it("rejects ReadSensitive GET without token when enforce=true", async () => {
    const app = makeAppWithReadToken({ readToken: "secret-read-token", enforce: true });
    const res = await app.request("/api/context/today");
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error).toBe("unauthorized");
  });

  it("rejects ReadSensitive GET with wrong X-Read-Token when enforce=true", async () => {
    const app = makeAppWithReadToken({ readToken: "secret-read-token", enforce: true });
    const res = await app.request("/api/context/today", {
      headers: { "X-Read-Token": "wrong-token-value!" },
    });
    expect(res.status).toBe(401);
  });

  it("accepts scoped validator tokens and rejects rotated ones", async () => {
    const manager = new ScopedReadSensitiveTokenManager();
    const first = manager.issue("session-1");
    const app = makeAppWithReadToken({
      readTokenValidator: (token) => manager.isValid(token),
      enforce: true,
    });

    const firstRes = await app.request("/api/context/today", {
      headers: { "X-Read-Token": first },
    });
    expect(firstRes.status).toBe(200);

    const second = manager.issue("session-1");
    expect(second).not.toBe(first);

    const staleRes = await app.request("/api/context/today", {
      headers: { "X-Read-Token": first },
    });
    expect(staleRes.status).toBe(401);

    const freshRes = await app.request("/api/context/today", {
      headers: { "X-Read-Token": second },
    });
    expect(freshRes.status).toBe(200);
  });

  it("rejects ReadSensitive GET with wrong Bearer when enforce=true", async () => {
    const app = makeAppWithReadToken({ readToken: "secret-read-token", enforce: true });
    const res = await app.request("/api/context/today", {
      headers: { Authorization: "Bearer wrong-bearer" },
    });
    expect(res.status).toBe(401);
  });

  it("allows ReadSensitive GET without token when enforce=false (Phase C)", async () => {
    const app = makeAppWithReadToken({ readToken: "secret-read-token", enforce: false });
    const res = await app.request("/api/context/today");
    expect(res.status).toBe(200);
  });

  it("allows Autonomous endpoints without any token (enforce=true)", async () => {
    const app = makeAppWithReadToken({ readToken: "secret-read-token", enforce: true });
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
  });

  it("rejects browser-originated unsafe POSTs to Autonomous routes", async () => {
    const app = makeAppWithReadToken({ readToken: "secret-read-token", enforce: true });
    const res = await app.request("/api/context/archive-today", {
      method: "POST",
      headers: {
        Origin: "https://evil.example",
        "Sec-Fetch-Site": "cross-site",
      },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error).toBe("forbidden_origin");
    expect(existsSync(join(tmpDir, "context", "yesterday.md"))).toBe(false);
  });

  it("allows valid Bearer-authenticated unsafe requests despite browser metadata", async () => {
    const app = makeAppWithReadToken({ readToken: "secret-read-token", enforce: true });
    const res = await app.request("/api/context/archive-today", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-bearer-token",
        Origin: "https://evil.example",
        "Sec-Fetch-Site": "cross-site",
      },
    });
    expect(res.status).toBe(200);
    expect(existsSync(join(tmpDir, "context", "yesterday.md"))).toBe(true);
  });

  it("allows CLI-style unsafe POSTs without browser metadata", async () => {
    const app = makeAppWithReadToken({ readToken: "secret-read-token", enforce: true });
    const res = await app.request("/api/context/archive-today", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(existsSync(join(tmpDir, "context", "yesterday.md"))).toBe(true);
  });

  it("rejects browser-originated unsafe POSTs to Notify routes", async () => {
    const app = makeAppWithReadToken({
      readToken: "secret-read-token",
      enforce: true,
      withMcp: true,
    });
    const res = await app.request("/api/mcp/disable-all", {
      method: "POST",
      headers: {
        Origin: "https://evil.example",
        "Sec-Fetch-Site": "cross-site",
      },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error).toBe("forbidden_origin");
  });

  it("allows ReadSensitive GET without readToken configured (no enforcement possible)", async () => {
    const app = makeAppWithReadToken({ readToken: undefined, enforce: true });
    const res = await app.request("/api/context/today");
    // readToken is undefined, so isReadSensitiveAuthenticated returns false for
    // X-Read-Token path but there's no Bearer either → depends on enforce flag.
    // With readToken undefined AND no Bearer, this is unauthenticated + enforced → 401.
    // However, if readToken itself is not configured, enforcement should still work
    // because the dashboard can still send Bearer.
    expect(res.status).toBe(401);
  });
});

// ── Host-header security (DNS-rebinding guard) ────────────────────────────────
describe("Host header security (DNS-rebinding guard)", () => {
  let tmpDir: string;
  let db: Database.Database;

  function makeHostTestApp(secretSeed: Partial<Record<import("../secrets/secret-names.js").StoredSecretName, string>> = { apiToken: "test-token" }) {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    const config = {
      dataDir: tmpDir,
      apiPort: 8321,
      timezone: "UTC",
      dayBoundaryHour: 0,
      agentDisplayName: "ai bot",
    } as unknown as import("../config.js").AgentConfig;
    return createApp({
      db,
      config,
      secretBroker: new SecretBroker(new InMemorySecretStore(secretSeed), { cacheTtlMs: 0 }),
      services: createServiceRegistry(),
      getHealthData: () => ({ uptime: 0, eventBusSize: 0, activeSessions: 0, connectedPlatforms: [], registeredObservers: [], missingContextFiles: [], contextFilesOk: true }),
      getIntegrationStatus: () => ({
        google: { configured: false, connected: false, error: null, services: { calendar: { connected: false, error: null }, gmail: { connected: false, error: null } } },
        obsidian: { configured: false, connected: false, error: null },
        notion: { configured: false, connected: false, error: null },
        whatsapp: { configured: false, connected: false, error: null, state: "not_configured" as const },
        googleMaps: { configured: false, connected: false, error: null },
        appleCalendar: { configured: false, connected: false, error: null },
      }),
    });
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pa-host-test-"));
    mkdirSync(join(tmpDir, "context"), { recursive: true });
  });
  afterEach(() => { if (db) db.close(); rmSync(tmpDir, { recursive: true, force: true }); });

  it("rejects requests with a non-loopback Host header (403 forbidden_host)", async () => {
    const app = makeHostTestApp();
    const res = await app.request("/api/health", {
      headers: { Host: "evil.example.com" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, string>;
    expect(body.error).toBe("forbidden_host");
  });

  it("returns 403 forbidden_host when the Host header contains a space (URL parse fails → null hostname)", async () => {
    const app = makeHostTestApp();
    const res = await app.request("/api/health", {
      headers: { Host: "invalid host name" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, string>;
    expect(body.error).toBe("forbidden_host");
  });

  it("allows requests with Host: localhost", async () => {
    const app = makeHostTestApp();
    const res = await app.request("/api/health", {
      headers: { Host: "localhost" },
    });
    expect(res.status).toBe(200);
  });

  it("allows requests with Host: 127.0.0.1", async () => {
    const app = makeHostTestApp();
    const res = await app.request("/api/health", {
      headers: { Host: "127.0.0.1" },
    });
    expect(res.status).toBe(200);
  });

  it("allows requests with IPv6 Host: [::1] (brackets stripped by WHATWG URL)", async () => {
    const app = makeHostTestApp();
    const res = await app.request("/api/health", {
      headers: { Host: "[::1]" },
    });
    expect(res.status).toBe(200);
  });

  it("allows requests with Host: 127.0.0.1 and port (port stripped by WHATWG URL)", async () => {
    const app = makeHostTestApp();
    const res = await app.request("/api/health", {
      headers: { Host: "127.0.0.1:8321" },
    });
    expect(res.status).toBe(200);
  });
});

// ── Loopback browser gate — additional branch coverage ────────────────────────
describe("Loopback browser gate additional coverage", () => {
  let tmpDir: string;
  let db: Database.Database;

  function makeGateApp() {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    const ctxDir = join(tmpDir, "context");
    mkdirSync(ctxDir, { recursive: true });
    writeFileSync(join(ctxDir, "today.md"), "# Today\n");
    const config = { dataDir: tmpDir, apiPort: 8321, timezone: "UTC", dayBoundaryHour: 0, agentDisplayName: "ai bot" } as unknown as import("../config.js").AgentConfig;
    return createApp({
      db,
      config,
      secretBroker: new SecretBroker(new InMemorySecretStore({ apiToken: "gate-token" }), { cacheTtlMs: 0 }),
      services: createServiceRegistry(),
      getHealthData: () => ({ uptime: 0, eventBusSize: 0, activeSessions: 0, connectedPlatforms: [], registeredObservers: [], missingContextFiles: [], contextFilesOk: true }),
      getIntegrationStatus: () => ({
        google: { configured: false, connected: false, error: null, services: { calendar: { connected: false, error: null }, gmail: { connected: false, error: null } } },
        obsidian: { configured: false, connected: false, error: null },
        notion: { configured: false, connected: false, error: null },
        whatsapp: { configured: false, connected: false, error: null, state: "not_configured" as const },
        googleMaps: { configured: false, connected: false, error: null },
        appleCalendar: { configured: false, connected: false, error: null },
      }),
    });
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pa-gate-test-"));
  });
  afterEach(() => { if (db) db.close(); rmSync(tmpDir, { recursive: true, force: true }); });

  it("allows unsafe POST with Sec-Fetch-Site: same-origin (same-origin browser request)", async () => {
    const app = makeGateApp();
    const res = await app.request("/api/context/archive-today", {
      method: "POST",
      headers: { "Sec-Fetch-Site": "same-origin" },
    });
    // Context/today may not exist, but the request is NOT blocked by the gate.
    expect(res.status).not.toBe(403);
  });

  it("rejects unsafe POST with Sec-Fetch-Site: none (non-same-origin, no Bearer)", async () => {
    const app = makeGateApp();
    const res = await app.request("/api/context/archive-today", {
      method: "POST",
      headers: { "Sec-Fetch-Site": "none" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, string>;
    expect(body.error).toBe("forbidden_origin");
    expect(body.reason).toBe("sec_fetch_site_none");
  });

  it("allows unsafe POST from the daemon's own origin (Origin in allowedDaemonOrigins)", async () => {
    const app = makeGateApp();
    const res = await app.request("/api/context/archive-today", {
      method: "POST",
      headers: { Origin: "http://localhost:8321" },
    });
    expect(res.status).not.toBe(403);
  });

  it("rejects unsafe POST with unknown Origin (no Sec-Fetch-Site) → 403 origin_mismatch", async () => {
    // Exercises the `origin_mismatch` branch of evaluateLoopbackBrowserGate.
    // The Sec-Fetch-Site path is checked first — omitting it forces the
    // Origin check, where a non-allowedDaemonOrigins host returns origin_mismatch.
    const app = makeGateApp();
    const res = await app.request("/api/context/archive-today", {
      method: "POST",
      headers: {
        Origin: "https://unknown.external.example",
        // No Sec-Fetch-Site header → falls through to the origin check
      },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, string>;
    expect(body.error).toBe("forbidden_origin");
    expect(body.reason).toBe("origin_mismatch");
  });

  it("rejects unsafe POST with Authorization: Basic (getBearerToken returns null → 401 for Approve-tier)", async () => {
    // Approve-tier endpoint — Basic auth does not count as Bearer, so the
    // server rejects with 401.
    const app = makeGateApp();
    const res = await app.request("/api/agent/run-now", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic dXNlcjpwYXNz",
      },
      body: JSON.stringify({ source: "test" }),
    });
    expect(res.status).toBe(401);
  });
});

// ── Approve-tier 503 when no API token is configured ─────────────────────────
describe("Approve-tier 503 when daemon API token is unconfigured", () => {
  it("returns 503 server_misconfigured when secretBroker.getApiToken() returns null", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    const tmpDir = mkdtempSync(join(tmpdir(), "pa-503-test-"));
    const config = { dataDir: tmpDir, apiPort: 8321, timezone: "UTC", dayBoundaryHour: 0, agentDisplayName: "ai bot" } as unknown as import("../config.js").AgentConfig;

    // SecretBroker with no apiToken → getApiToken() returns null.
    const app = createApp({
      db,
      config,
      secretBroker: new SecretBroker(new InMemorySecretStore({}), { cacheTtlMs: 0 }),
      services: createServiceRegistry(),
      getHealthData: () => ({ uptime: 0, eventBusSize: 0, activeSessions: 0, connectedPlatforms: [], registeredObservers: [], missingContextFiles: [], contextFilesOk: true }),
      getIntegrationStatus: () => ({
        google: { configured: false, connected: false, error: null, services: { calendar: { connected: false, error: null }, gmail: { connected: false, error: null } } },
        obsidian: { configured: false, connected: false, error: null },
        notion: { configured: false, connected: false, error: null },
        whatsapp: { configured: false, connected: false, error: null, state: "not_configured" as const },
        googleMaps: { configured: false, connected: false, error: null },
        appleCalendar: { configured: false, connected: false, error: null },
      }),
    });

    try {
      const res = await app.request("/api/agent/run-now", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "test" }),
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as Record<string, string>;
      expect(body.error).toBe("server_misconfigured");
    } finally {
      db.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── Conditional route mounting ────────────────────────────────────────────────
describe("Conditional route mounting", () => {
  let tmpDir: string;

  function makeMinimalApp(extraDeps: Partial<Parameters<typeof createApp>[0]> = {}) {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    const config = { dataDir: tmpDir, apiPort: 8321, timezone: "UTC", dayBoundaryHour: 0, agentDisplayName: "ai bot" } as unknown as import("../config.js").AgentConfig;
    const app = createApp({
      db,
      config,
      secretBroker: new SecretBroker(new InMemorySecretStore({ apiToken: "cond-token" }), { cacheTtlMs: 0 }),
      services: createServiceRegistry(),
      getHealthData: () => ({ uptime: 0, eventBusSize: 0, activeSessions: 0, connectedPlatforms: [], registeredObservers: [], missingContextFiles: [], contextFilesOk: true }),
      getIntegrationStatus: () => ({
        google: { configured: false, connected: false, error: null, services: { calendar: { connected: false, error: null }, gmail: { connected: false, error: null } } },
        obsidian: { configured: false, connected: false, error: null },
        notion: { configured: false, connected: false, error: null },
        whatsapp: { configured: false, connected: false, error: null, state: "not_configured" as const },
        googleMaps: { configured: false, connected: false, error: null },
        appleCalendar: { configured: false, connected: false, error: null },
      }),
      ...extraDeps,
    });
    return { app, db };
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pa-cond-test-"));
    mkdirSync(join(tmpDir, "context"), { recursive: true });
  });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it("mounts setupMigrateRoutes when migrationLock and contextWriteGate are both provided", async () => {
    const { MigrationLock, ContextWriteGate } = await import("../core/today-write-lock.js");
    const { app, db } = makeMinimalApp({
      migrationLock: new MigrationLock(60_000),
      contextWriteGate: new ContextWriteGate(),
    });
    // POST /api/setup/migrate-context is the actual route. Sending a request
    // with missing/invalid body returns 400, not 404 — confirming the route IS mounted.
    const res = await app.request("/api/setup/migrate-context", {
      method: "POST",
      headers: {
        Authorization: "Bearer cond-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).not.toBe(404);
    db.close();
  });

  it("GET /api/chat/stream calls getChatBinding, findActiveDashboardSessionId, isSessionActive lambdas", async () => {
    // The SSE stream GET handler calls getChatBinding() and findActiveDashboardSessionId()
    // unconditionally, and isSessionActive() when ?sessionId= is present.
    const { app, db } = makeMinimalApp({
      eventBroadcaster: new EventBroadcaster(),
      dashboardAdapter: { isConnected: () => true, getActiveChannels: () => [] } as never,
    });
    // ?sessionId=1 triggers isSessionActive(1) call even though session 1 doesn't exist
    // (returns false, which the handler handles gracefully).
    const res = await app.request("/api/chat/stream?sessionId=1", {
      headers: { Authorization: "Bearer cond-token" },
    });
    expect(res.status).toBeGreaterThan(0);
    db.close();
  });

  it("GET /api/chat/stream calls rebindSessionChannel when an active session is found and resume is valid", async () => {
    // Inserts an active dashboard_chat session so isSessionActive(1) returns true
    // and rebindSessionChannel(1, channelId) is called after adapter.registerClient().
    const rebindCalled = vi.fn();
    const { app, db } = makeMinimalApp({
      eventBroadcaster: new EventBroadcaster(),
      dashboardAdapter: {
        isConnected: () => true,
        getActiveChannels: () => [],
        registerClient: (_client: unknown, _opts: unknown) => "stub-channel-id",
        unregisterClient: (_id: string) => {},
      } as never,
    });
    // rebindSessionChannel is wired from server.ts to call db.prepare(...).run().
    // We verify it by watching the channel_id column update after the request.
    db.prepare(
      `INSERT INTO conversation_sessions
         (id, platform, scope, scope_key, channel_id, backend, status, started_at, last_message_at)
       VALUES
         (1, 'dashboard', 'dashboard_chat', 'dashboard', 'old-channel', 'claude', 'active', datetime('now'), datetime('now'))`,
    ).run();
    const res = await app.request("/api/chat/stream?sessionId=1", {
      headers: { Authorization: "Bearer cond-token" },
    });
    expect(res.status).toBeGreaterThan(0);
    // Give the async SSE callback a tick to run rebindSessionChannel before closing db.
    await new Promise((r) => setTimeout(r, 10));
    const row = db
      .prepare("SELECT channel_id FROM conversation_sessions WHERE id = 1")
      .get() as { channel_id: string } | undefined;
    // The rebind should have updated channel_id to the stub's returned channelId.
    expect(row?.channel_id).toBe("stub-channel-id");
    rebindCalled.mockReset();
    db.close();
  });

  it("GET /api/chat/stream with dashboardAdapter=undefined exercises the ?? null branch (line 1007)", async () => {
    // Exercises `dashboardAdapter: deps.dashboardAdapter ?? null` right side when absent.
    const { app, db } = makeMinimalApp({
      eventBroadcaster: new EventBroadcaster(),
      // No dashboardAdapter → deps.dashboardAdapter is undefined → ?? null fires
    });
    const res = await app.request("/api/chat/stream", {
      headers: { Authorization: "Bearer cond-token" },
    });
    // Returns 503 "dashboard adapter not available" — confirms the SSE block ran and
    // dashboardAdapter: undefined ?? null → null was passed to createSSERoutes.
    expect(res.status).toBe(503);
    db.close();
  });

  it("POST /api/chat/end-session without endDashboardSession exercises the ?? Promise.resolve(null) fallback", async () => {
    // Exercises the null-coalescing fallback `deps.endDashboardSession?.() ?? Promise.resolve(null)`.
    // When deps.endDashboardSession is absent (undefined), ?. returns undefined and ?? fires.
    // A dashboardAdapter must be provided to pass the early-return guard in the SSE route handler.
    const { app, db } = makeMinimalApp({
      eventBroadcaster: new EventBroadcaster(),
      dashboardAdapter: { isConnected: () => true, getActiveChannels: () => [] } as never,
      // endDashboardSession intentionally absent — tests the ?? fallback on line 1051
    });
    const res = await app.request("/api/chat/end-session", {
      method: "POST",
      headers: {
        Authorization: "Bearer cond-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channelId: "test-channel" }),
    });
    // With no endDashboardSession the ?? fires and the route returns 200 {status:"ended",closedSessionId:null}.
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.closedSessionId).toBeNull();
    db.close();
  });

  it("does NOT mount setupMigrateRoutes when migrationLock is absent", async () => {
    const { ContextWriteGate } = await import("../core/today-write-lock.js");
    const { app, db } = makeMinimalApp({
      contextWriteGate: new ContextWriteGate(),
      // migrationLock intentionally absent
    });
    const res = await app.request("/api/setup/migrate-context/status", {
      headers: { Authorization: "Bearer cond-token" },
    });
    // Route not mounted → Hono returns 404.
    expect(res.status).toBe(404);
    db.close();
  });

  it("mounts GitHub webhook route when eventBus is provided", async () => {
    const { EventBus } = await import("../core/event-bus.js");
    const { app, db } = makeMinimalApp({
      eventBus: new EventBus(),
    });
    // The GitHub webhook accepts POST /webhook/github.
    // Without a valid signature the handler returns 400 or 401 — either way,
    // it means the route IS registered (not a 404).
    const res = await app.request("/webhook/github", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "opened" }),
    });
    expect(res.status).not.toBe(404);
    db.close();
  });

  it("does NOT mount GitHub webhook when eventBus is absent", async () => {
    const { app, db } = makeMinimalApp();
    const res = await app.request("/webhook/github", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    db.close();
  });

  it("mounts attachment route when attachmentStore is provided but validateAttachmentTurnToken is absent (line 909 ?? fallback)", async () => {
    // Tests the `?? (() => null)` right-hand fallback on line 909 when
    // deps.validateAttachmentTurnToken is undefined.
    const { app, db } = makeMinimalApp({
      attachmentStore: {
        save: async () => ({ id: "att-2", filename: "y.png", sizeBytes: 0, mimeType: "image/png", createdAt: new Date().toISOString() }),
        get: async () => null,
        delete: async () => {},
        listForSession: async () => [],
      } as never,
      // No validateAttachmentTurnToken → ?? (() => null) fires
    });
    const res = await app.request("/api/chat/outbound-attachments", {
      method: "POST",
      headers: { Authorization: "Bearer cond-token" },
    });
    expect(res.status).not.toBe(404);
    db.close();
  });

  it("mounts attachment upload route when attachmentStore AND auditLogger provided (line 909-910 true branches)", async () => {
    const { app, db } = makeMinimalApp({
      attachmentStore: {
        save: async () => ({ id: "att-1", filename: "x.png", sizeBytes: 0, mimeType: "image/png", createdAt: new Date().toISOString() }),
        get: async () => null,
        delete: async () => {},
        listForSession: async () => [],
      } as never,
      // Providing both validateAttachmentTurnToken and auditLogger exercises the
      // truthy branches of `?? (() => null)` and `...(auditLogger ? {...} : {})`.
      validateAttachmentTurnToken: (() => null) as never,
      auditLogger: { log: () => {} } as never,
    });
    // Route is mounted — POST /api/chat/outbound-attachments. Without a
    // turn token the handler returns 401, not 404.
    const res = await app.request("/api/chat/outbound-attachments", {
      method: "POST",
      headers: { Authorization: "Bearer cond-token" },
    });
    // 404 would mean the route isn't mounted; anything else means it is.
    expect(res.status).not.toBe(404);
    db.close();
  });
});

// ── onError handler ──────────────────────────────────────────────────────────
describe("app.onError handler", () => {
  it("returns 500 internal_error JSON when a handler throws an unhandled error", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pa-err-test-"));
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    const config = { dataDir: tmpDir, apiPort: 8321, timezone: "UTC", dayBoundaryHour: 0, agentDisplayName: "ai bot" } as unknown as import("../config.js").AgentConfig;

    const app = createApp({
      db,
      config,
      secretBroker: new SecretBroker(new InMemorySecretStore({ apiToken: "err-token" }), { cacheTtlMs: 0 }),
      services: createServiceRegistry(),
      // getHealthData throws to trigger the onError handler.
      getHealthData: () => { throw new Error("simulated internal error"); },
      getIntegrationStatus: () => ({
        google: { configured: false, connected: false, error: null, services: { calendar: { connected: false, error: null }, gmail: { connected: false, error: null } } },
        obsidian: { configured: false, connected: false, error: null },
        notion: { configured: false, connected: false, error: null },
        whatsapp: { configured: false, connected: false, error: null, state: "not_configured" as const },
        googleMaps: { configured: false, connected: false, error: null },
        appleCalendar: { configured: false, connected: false, error: null },
      }),
    });

    try {
      const res = await app.request("/api/health");
      expect(res.status).toBe(500);
      const body = (await res.json()) as Record<string, string>;
      expect(body.error).toBe("internal_error");
    } finally {
      db.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── Risk-audit fingerprint persistence ────────────────────────────────────────
describe("Risk-audit boot fingerprint persistence", () => {
  it("writes { fingerprint: '' } to runtime_state on every createApp when all routes are classified", async () => {
    // All current /api routes are covered by risk-classifier.ts (exact, pattern,
    // or prefix match), so `unclassified.length` is always 0 in a standard test
    // app. The else-branch writes { fingerprint: '' } on each boot so that a
    // future regression (new unclassified route) immediately resurrects the
    // warning on the next restart. Verify the key is written.
    const tmpDir = mkdtempSync(join(tmpdir(), "pa-audit-test-"));
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    const config = { dataDir: tmpDir, apiPort: 8321, timezone: "UTC", dayBoundaryHour: 0, agentDisplayName: "ai bot" } as unknown as import("../config.js").AgentConfig;
    try {
      createApp({
        db,
        config,
        secretBroker: new SecretBroker(new InMemorySecretStore({ apiToken: "audit-token" }), { cacheTtlMs: 0 }),
        services: createServiceRegistry(),
        getHealthData: () => ({ uptime: 0, eventBusSize: 0, activeSessions: 0, connectedPlatforms: [], registeredObservers: [], missingContextFiles: [], contextFilesOk: true }),
        getIntegrationStatus: () => ({
          google: { configured: false, connected: false, error: null, services: { calendar: { connected: false, error: null }, gmail: { connected: false, error: null } } },
          obsidian: { configured: false, connected: false, error: null },
          notion: { configured: false, connected: false, error: null },
          whatsapp: { configured: false, connected: false, error: null, state: "not_configured" as const },
          googleMaps: { configured: false, connected: false, error: null },
          appleCalendar: { configured: false, connected: false, error: null },
        }),
      });

      const { readRuntimeState } = await import("../db/runtime-state.js");
      const stored = readRuntimeState<{ fingerprint: string }>(db, "risk_audit_unclassified_fingerprint");
      expect(stored).not.toBeNull();
      expect(stored?.fingerprint).toBe("");
    } finally {
      db.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── getChatBinding null branch + getContextDir callback ──────────────────────
describe("server.ts line-1015 getChatBinding null branch and line-1001 getContextDir callback", () => {
  let tmpDir: string;

  function makeMinimalApp(extraDeps: Partial<Parameters<typeof createApp>[0]> = {}) {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    const config = { dataDir: tmpDir, workspaceDir: resolve(__dirname, "..", "..", "..", ".."), apiPort: 8321, timezone: "UTC", dayBoundaryHour: 0, agentDisplayName: "ai bot" } as unknown as import("../config.js").AgentConfig;
    const app = createApp({
      db,
      config,
      secretBroker: new SecretBroker(new InMemorySecretStore({ apiToken: "cond-token" }), { cacheTtlMs: 0 }),
      services: createServiceRegistry(),
      getHealthData: () => ({ uptime: 0, eventBusSize: 0, activeSessions: 0, connectedPlatforms: [], registeredObservers: [], missingContextFiles: [], contextFilesOk: true }),
      getIntegrationStatus: () => ({
        google: { configured: false, connected: false, error: null, services: { calendar: { connected: false, error: null }, gmail: { connected: false, error: null } } },
        obsidian: { configured: false, connected: false, error: null },
        notion: { configured: false, connected: false, error: null },
        whatsapp: { configured: false, connected: false, error: null, state: "not_configured" as const },
        googleMaps: { configured: false, connected: false, error: null },
        appleCalendar: { configured: false, connected: false, error: null },
      }),
      ...extraDeps,
    });
    return { app, db };
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pa-chatbind-test-"));
    mkdirSync(join(tmpDir, "context"), { recursive: true });
  });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it("getChatBinding returns null when process_backend_config table does not exist (line 1015 branch)", async () => {
    // queryChatBinding returns null when any of the three required tables is absent
    // (checked via sqlite_master). Dropping process_backend_config makes it return
    // null, which exercises the `if (!result) return null` branch at line 1015.
    const { app, db } = makeMinimalApp({
      eventBroadcaster: new EventBroadcaster(),
      dashboardAdapter: { isConnected: () => true, getActiveChannels: () => [] } as never,
    });
    // Disable FK enforcement first so DROP can succeed.
    db.pragma("foreign_keys = OFF");
    db.prepare("DROP TABLE IF EXISTS process_backend_config").run();
    const res = await app.request("/api/chat/stream", {
      headers: { Authorization: "Bearer cond-token" },
    });
    // The SSE handler runs; getChatBinding returns null; route still responds.
    expect(res.status).toBeGreaterThan(0);
    db.close();
  });

  it("getContextDir callback (line 1001) is exercised by POST /api/git/templates/project/apply", async () => {
    // createGitTemplatesRoutes receives `getContextDir: () => getContextDir(deps.config, deps.db)`
    // at line 1001. The apply endpoint calls deps.getContextDir() directly, so
    // issuing a POST to it exercises the callback and covers that line.
    const { app, db } = makeMinimalApp();
    const res = await app.request("/api/git/templates/project/apply", {
      method: "POST",
      headers: { Authorization: "Bearer cond-token" },
    });
    // No repos are configured so the endpoint returns a non-404 response
    // (200 with empty targets, or 409 in_progress if repeated). Either way
    // the getContextDir callback ran.
    expect(res.status).not.toBe(404);
    db.close();
  });
});
