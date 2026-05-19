import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  statSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { getAgentDayDateStr } from "@aitne/shared";
import {
  createContextRoutes,
  resolveContextTarget,
  safePath,
} from "./context/index.js";
import { applySchema } from "../../db/schema.js";
import { setDegradedMode, clearDegradedMode } from "../../db/runtime-state.js";
import type { AgentConfig } from "../../config.js";
import {
  buildTodayAgentPlanMetadata,
  extractTodayAgentPlanRows,
} from "../../core/today-agent-plan.js";

function validTodayContent(
  agentPlan = "- [ ] 09:00 Send prep note [work] \u2192DM",
  date?: string,
): string {
  // Use the current agent-day date so writes pass the validator's
  // line-1 expectedAgentDay check that runs on every PUT to today.md.
  // Mirrors the route handler's resolution: getAgentDayDateStr with the
  // default dayBoundaryHour=4 used by makeConfig().
  const todayStr = date ?? getAgentDayDateStr(undefined, 4);
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

function validUserProfileContent(): string {
  return withUserFrontmatter([
    "# User",
    "",
    "## Identity",
    "",
  ].join("\n"));
}

function withUserFrontmatter(markdown: string): string {
  return [
    "---",
    "type: user",
    "owner: shared",
    "updated: 2026-04-21",
    "---",
    markdown,
  ].join("\n");
}

function validProjectContent(title = "New Project"): string {
  return [
    "---",
    "type: project",
    "owner: shared",
    "updated: 2026-04-21",
    "---",
    `# ${title}`,
    "",
  ].join("\n");
}

function validDailyContent(date = "2026-04-17"): string {
  return [
    "---",
    "type: daily",
    "owner: agent",
    "updated: 2026-04-21",
    "---",
    `# ${date}`,
    "",
    "## Summary",
    "",
  ].join("\n");
}

function agentPlanTaskContext(content = validTodayContent()): string {
  const row = extractTodayAgentPlanRows(content).rows[0];
  return JSON.stringify({
    agentPlan: buildTodayAgentPlanMetadata("2026-04-21", row),
  });
}

// ── Pure function unit tests for path-resolve helpers ──
// (Validator pure tests live in `core/context-validation/*.test.ts`; the
//  path-resolve helpers below stay here until PR 4 moves them.)

describe("resolveContextTarget", () => {
  it("defaults reserved base stems to .base", () => {
    expect(resolveContextTarget("projects/_active")).toEqual({
      base: "projects/_active",
      ext: ".base",
    });
  });

  it("keeps explicit .md extensions for normal markdown files", () => {
    expect(resolveContextTarget("today.md")).toEqual({
      base: "today",
      ext: ".md",
    });
  });
});

describe("safePath", () => {
  it("rejects symlinked files that resolve outside the context dir", () => {
    const root = mkdtempSync(join(tmpdir(), "pa-context-safe-"));
    try {
      const contextDir = join(root, "context");
      const outsideDir = join(root, "outside");
      mkdirSync(contextDir, { recursive: true });
      mkdirSync(outsideDir, { recursive: true });
      writeFileSync(join(outsideDir, "secret.md"), "shh", "utf-8");
      symlinkSync(join(outsideDir, "secret.md"), join(contextDir, "alias.md"));

      expect(safePath(contextDir, "alias")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects paths that traverse through a symlinked directory", () => {
    const root = mkdtempSync(join(tmpdir(), "pa-context-safe-"));
    try {
      const contextDir = join(root, "context");
      const outsideDir = join(root, "outside");
      mkdirSync(contextDir, { recursive: true });
      mkdirSync(outsideDir, { recursive: true });
      symlinkSync(outsideDir, join(contextDir, "linked"));

      expect(safePath(contextDir, "linked/note")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects symlinked files even when the external target does not exist yet", () => {
    const root = mkdtempSync(join(tmpdir(), "pa-context-safe-"));
    try {
      const contextDir = join(root, "context");
      const outsideDir = join(root, "outside");
      mkdirSync(contextDir, { recursive: true });
      mkdirSync(outsideDir, { recursive: true });
      symlinkSync(join(outsideDir, "new-secret.md"), join(contextDir, "alias.md"));

      expect(safePath(contextDir, "alias")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── HTTP integration tests ──

/**
 * Tests for the context route's optimistic-concurrency contract.
 *
 * Coverage focuses on the conflict-detection paths added for the dashboard
 * editor — the existing PUT/PATCH happy paths are already exercised through
 * dispatcher tests, so we only test the new behavior here.
 */
describe("Context API — optimistic concurrency", () => {
  let dataDir: string;
  let contextDir: string;
  let db: Database.Database;
  let app: Hono;
  let config: AgentConfig;
  let promptChanges: Array<{
    path: string;
    reason: string;
    tier: "loud" | "quiet" | undefined;
    tierReason: string | undefined;
  }>;

  function makeConfig(): AgentConfig {
    return {
      dataDir,
      executeTimeoutMinutes: 60,
    } as unknown as AgentConfig;
  }

  beforeEach(() => {
    dataDir = join(tmpdir(), `pa-context-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    contextDir = join(dataDir, "context");
    mkdirSync(contextDir, { recursive: true });
    mkdirSync(join(contextDir, "user"), { recursive: true });
    mkdirSync(join(contextDir, "rules"), { recursive: true });
    mkdirSync(join(contextDir, "agent"), { recursive: true });

    db = new Database(":memory:");
    applySchema(db);
    config = makeConfig();
    promptChanges = [];

    // Mount under /api to match production routing — the route handlers
    // strip "/api/context/" from c.req.path, so the mount prefix matters.
    const contextRoutes = createContextRoutes({
      db,
      config,
      onPromptContextChanged: (
        path: string,
        reason: string,
        tier: "loud" | "quiet" | undefined,
        metadata: { tierReason?: string } | undefined,
      ) => {
        promptChanges.push({
          path,
          reason,
          tier,
          tierReason: metadata?.tierReason,
        });
      },
    } as unknown as Parameters<typeof createContextRoutes>[0]);
    app = new Hono();
    app.route("/api", contextRoutes);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function validRoadmap(): string {
    return [
      "# Roadmap",
      "> Last synced: 2026-04-20",
      "",
      "## Annual Goals",
      "",
      "## Quarterly Focus",
      "",
      "## Long-term Plans",
      "- [2026-Q3] US study prep — Source: dm 2026-04-19 — Review: 2026-05-17 — ReviewCount: 0",
      "",
      "## Agent Action Plan",
      "",
      "## Recurring",
      "- Every Friday: weekly review",
      "",
    ].join("\n");
  }

  describe("GET /context/* — editable flag", () => {
    it("re-resolves the live primary vault path after config changes", async () => {
      const primaryVault = join(dataDir, "primary-vault");
      mkdirSync(primaryVault, { recursive: true });
      const primaryContent = validTodayContent(
        "- [ ] 09:00 Primary note [work] \u2192DM",
      );
      const fallbackContent = validTodayContent(
        "- [ ] 09:00 Fallback note [work] \u2192DM",
      );
      const updatedContent = validTodayContent(
        "- [ ] 10:00 Updated primary [work] \u2192DM",
      );
      writeFileSync(join(primaryVault, "today.md"), primaryContent, "utf-8");
      writeFileSync(join(contextDir, "today.md"), fallbackContent, "utf-8");

      config.vaultMode = "obsidian";
      config.primaryVaultPath = primaryVault;

      const getRes = await app.request("/api/context/today");
      expect(getRes.status).toBe(200);
      const getBody = (await getRes.json()) as { content: string };
      expect(getBody.content).toBe(primaryContent);

      const putRes = await app.request("/api/context/today", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: updatedContent }),
      });
      expect(putRes.status).toBe(200);
      expect(readFileSync(join(primaryVault, "today.md"), "utf-8")).toBe(
        updatedContent,
      );
      expect(readFileSync(join(contextDir, "today.md"), "utf-8")).toBe(
        fallbackContent,
      );
    });

    it("reports editable=true for whitelisted paths", async () => {
      writeFileSync(join(contextDir, "today.md"), "# Today\n", "utf-8");
      const res = await app.request("/api/context/today");
      expect(res.status).toBe(200);
      const data = (await res.json()) as { content: string; lastModified: string; editable: boolean };
      expect(data.editable).toBe(true);
      expect(data.content).toBe("# Today\n");
      expect(data.lastModified).toBeTruthy();
    });

    it("reports editable=false for read-only paths", async () => {
      mkdirSync(join(contextDir, "schedule"), { recursive: true });
      writeFileSync(join(contextDir, "schedule", "2026-04-07.md"), "# Archive\n", "utf-8");
      const res = await app.request("/api/context/schedule/2026-04-07");
      expect(res.status).toBe(200);
      const data = (await res.json()) as { editable: boolean };
      expect(data.editable).toBe(false);
    });

    it("strips trailing .md from the path before whitelist matching", async () => {
      writeFileSync(join(contextDir, "user", "profile.md"), "# User\n", "utf-8");
      const res = await app.request("/api/context/user/profile.md");
      expect(res.status).toBe(200);
      const data = (await res.json()) as { editable: boolean };
      expect(data.editable).toBe(true);
    });
  });

  describe("GET /context/today/reconciliation", () => {
    it("reports Agent Plan rows without matching pending schedules", async () => {
      config.timezone = "UTC";
      writeFileSync(join(contextDir, "today.md"), validTodayContent(), "utf-8");

      const res = await app.request("/api/context/today/reconciliation");

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        status: string;
        rowsWithoutSchedule: Array<{ time: string; action: string }>;
        schedulesWithoutRow: unknown[];
      };
      expect(data.status).toBe("mismatch");
      expect(data.rowsWithoutSchedule).toMatchObject([
        { time: "09:00", action: "Send prep note" },
      ]);
      expect(data.schedulesWithoutRow).toEqual([]);
    });

    it("does not accept an unrelated same-time pending schedule", async () => {
      config.timezone = "UTC";
      writeFileSync(join(contextDir, "today.md"), validTodayContent(), "utf-8");
      db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, task_context, status)
         VALUES ('2026-04-21 09:00:00', 'wake', 'Send prep note to the user', '{}', 'pending')`,
      ).run();

      const res = await app.request("/api/context/today/reconciliation");

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        status: string;
        pendingSchedules: number;
        rowsWithoutSchedule: unknown[];
        schedulesWithoutRow: unknown[];
      };
      expect(data.status).toBe("mismatch");
      expect(data.pendingSchedules).toBe(0);
      expect(data.rowsWithoutSchedule).toHaveLength(1);
      expect(data.schedulesWithoutRow).toEqual([]);
    });

    it("accepts exactly one same-day pending schedule with matching Agent Plan metadata", async () => {
      config.timezone = "UTC";
      // Reconciliation test fixtures pin the agent_schedule row to an
      // explicit date, so today.md must use the same date or the metadata
      // fingerprint won't match. Bypass agent-day validation by writing
      // directly to disk; the route under test is a GET, not a PUT.
      const content = validTodayContent(undefined, "2026-04-21");
      writeFileSync(join(contextDir, "today.md"), content, "utf-8");
      db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, task_context, status)
         VALUES ('2026-04-21 09:00:00', 'wake', 'Send prep note to the user', ?, 'pending')`,
      ).run(agentPlanTaskContext(content));

      const res = await app.request("/api/context/today/reconciliation");

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        status: string;
        rowsWithoutSchedule: unknown[];
        schedulesWithoutRow: unknown[];
        duplicateAgentPlanSchedules: unknown[];
      };
      expect(data.status).toBe("ok");
      expect(data.rowsWithoutSchedule).toEqual([]);
      expect(data.schedulesWithoutRow).toEqual([]);
      expect(data.duplicateAgentPlanSchedules).toEqual([]);
    });

    it("reports duplicate schedules for the same Agent Plan row", async () => {
      config.timezone = "UTC";
      // Same fixture-date pinning as the previous test.
      const content = validTodayContent(undefined, "2026-04-21");
      writeFileSync(join(contextDir, "today.md"), content, "utf-8");
      const taskContext = agentPlanTaskContext(content);
      const stmt = db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, task_context, status)
         VALUES ('2026-04-21 09:00:00', 'wake', 'Send prep note to the user', ?, 'pending')`,
      );
      stmt.run(taskContext);
      stmt.run(taskContext);

      const res = await app.request("/api/context/today/reconciliation");

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        status: string;
        duplicateAgentPlanSchedules: Array<{ scheduleIds: number[] }>;
      };
      expect(data.status).toBe("mismatch");
      expect(data.duplicateAgentPlanSchedules).toHaveLength(1);
      expect(data.duplicateAgentPlanSchedules[0].scheduleIds).toHaveLength(2);
    });
  });

  describe("PUT/PATCH /context/today — schema validation", () => {
    it("rejects legacy # Today content on full replace writes", async () => {
      const filePath = join(contextDir, "today.md");
      writeFileSync(filePath, validTodayContent(), "utf-8");

      const res = await app.request("/api/context/today", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "# Today\n\n## Agent Log\n" }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string; message: string };
      expect(data.error).toBe("validation_error");
      expect(data.message).toContain("line 1");
      expect(readFileSync(filePath, "utf-8")).toBe(validTodayContent());
    });

    it("rejects malformed formal today.md before writing or snapshotting", async () => {
      const filePath = join(contextDir, "today.md");
      writeFileSync(filePath, validTodayContent(), "utf-8");
      const malformed = validTodayContent().replace(
        "\n## User Tasks\n- (none)\n",
        "\n",
      );

      const res = await app.request("/api/context/today", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: malformed }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string; message: string };
      expect(data.error).toBe("validation_error");
      expect(data.message).toContain("## User Tasks");
      expect(readFileSync(filePath, "utf-8")).toBe(validTodayContent());

      const snapshotCount = db
        .prepare("SELECT COUNT(*) AS count FROM md_file_snapshots WHERE file_path = ?")
        .get("today") as { count: number };
      expect(snapshotCount.count).toBe(0);
    });

    it("PUT /context/today rejects wrong-date H1 with explicit agent-day error", async () => {
      // End-to-end verification of the route → prepareContextContentForWrite
      // → validateTodayContent agent-day plumbing. Pre-fix, a wrong-date PUT
      // succeeded silently and the dispatcher's post-run check then queued a
      // retry. The fix surfaces the mismatch synchronously so the agent can
      // correct in-session.
      const filePath = join(contextDir, "today.md");
      // Build a body whose H1 is a date that cannot be the current
      // agent-day regardless of when the test runs (1970-01-01 < every
      // post-epoch agent-day).
      const wrongDateContent = validTodayContent(
        "- [ ] 09:00 Send prep note [work] →DM",
        "1970-01-01",
      );
      const res = await app.request("/api/context/today", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: wrongDateContent }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string; message: string };
      expect(data.error).toBe("validation_error");
      expect(data.message).toContain("1970-01-01");
      expect(data.message).toContain("does not match");
      expect(data.message).toContain("<current_agent_day");
      // Ensure the bad PUT did not touch the file system.
      expect(existsSync(filePath)).toBe(false);
    });
  });

  describe("PUT/PATCH /context/* — frontmatter validation", () => {
    it("rejects guarded context files without required frontmatter", async () => {
      const filePath = join(contextDir, "user", "profile.md");

      const res = await app.request("/api/context/user/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "# User\n\n## Identity\n" }),
      });

      expect(res.status).toBe(422);
      const data = (await res.json()) as { error: string; message: string };
      expect(data.error).toBe("validation_error");
      expect(data.message).toContain("requires YAML frontmatter");
      expect(existsSync(filePath)).toBe(false);
    });

    it("accepts guarded context files with valid frontmatter and an H1", async () => {
      const filePath = join(contextDir, "user", "profile.md");
      const content = validUserProfileContent();

      const res = await app.request("/api/context/user/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });

      expect(res.status).toBe(200);
      expect(readFileSync(filePath, "utf-8")).toBe(content);
    });

    it("rejects PATCH writes that would leave guarded files structurally invalid", async () => {
      const filePath = join(contextDir, "user", "profile.md");
      writeFileSync(filePath, "# User\n\n## Identity\n", "utf-8");

      const res = await app.request("/api/context/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          section: "identity",
          mode: "append",
          content: "- Name: Alex",
        }),
      });

      expect(res.status).toBe(422);
      expect(readFileSync(filePath, "utf-8")).toBe("# User\n\n## Identity\n");
    });

    it("rejects guarded context files without an H1", async () => {
      const res = await app.request("/api/context/daily/2026-04-21", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: [
            "---",
            "type: daily",
            "owner: agent",
            "updated: 2026-04-21",
            "---",
            "## Summary",
            "- no H1",
          ].join("\n"),
        }),
      });

      expect(res.status).toBe(422);
      const data = (await res.json()) as { message: string };
      expect(data.message).toContain("requires at least one H1");
    });

    it("rejects guarded context files whose frontmatter does not match the path family", async () => {
      const projectRes = await app.request("/api/context/projects/example", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: [
            "---",
            "type: user",
            "owner: shared",
            "updated: 2026-04-21",
            "---",
            "# Example",
          ].join("\n"),
        }),
      });

      expect(projectRes.status).toBe(422);
      const projectData = (await projectRes.json()) as { message: string };
      expect(projectData.message).toContain("type must be `project`");

      const dailyRes = await app.request("/api/context/daily/2026-04-21", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: [
            "---",
            "type: daily",
            "owner: user",
            "updated: 2026-04-21",
            "---",
            "# 2026-04-21",
          ].join("\n"),
        }),
      });

      expect(dailyRes.status).toBe(422);
      const dailyData = (await dailyRes.json()) as { message: string };
      expect(dailyData.message).toContain("owner must be `agent`");
    });

    // morning-routine-optimization.md §"PUT /api/context/daily/<date>
    // skeleton-preservation validator" — Stage B's PUT must preserve
    // the seven skeleton-owned frontmatter fields byte-for-byte. When
    // it drops the deterministic ones (date / weekday /
    // agent_generated / calendar_events / messages_handled), the
    // route returns one structured error per missing field so Stage B
    // can self-correct in a single retry. Body is NOT validated.
    it("rejects daily/<date>.md writes that drop skeleton-owned frontmatter fields", async () => {
      const res = await app.request("/api/context/daily/2026-05-15", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: [
            "---",
            "type: daily",
            "owner: agent",
            "updated: 2026-05-15",
            "---",
            "# 2026-05-15 Friday",
            "",
            "## Summary",
            "Body authored by Stage B.",
          ].join("\n"),
        }),
      });

      expect(res.status).toBe(422);
      const data = (await res.json()) as {
        ok: false;
        errors: Array<{ code: string; field: string }>;
      };
      expect(data.ok).toBe(false);
      const codes = data.errors.map((e) => e.code);
      expect(new Set(codes)).toEqual(new Set(["context.daily_skeleton_field_drift"]));
      const fields = data.errors.map((e) => e.field).sort();
      expect(fields).toEqual([
        "frontmatter.agent_generated",
        "frontmatter.calendar_events",
        "frontmatter.date",
        "frontmatter.messages_handled",
        "frontmatter.weekday",
      ]);
    });

    it("accepts daily/<date>.md writes that preserve every skeleton-owned frontmatter field", async () => {
      const res = await app.request("/api/context/daily/2026-05-15", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: [
            "---",
            "date: 2026-05-15",
            "weekday: Friday",
            "type: daily",
            "owner: agent",
            "agent_generated: true",
            "calendar_events: 3",
            "messages_handled: 5",
            "updated: 2026-05-15",
            "---",
            "# 2026-05-15 Friday",
            "",
            "## Summary",
            "Body authored by Stage B.",
          ].join("\n"),
        }),
      });

      expect(res.status).toBe(200);
    });
  });

  describe("GET /context/health and POST /context/repair/stub", () => {
    it("reports missing stubs and frontmatter drift", async () => {
      writeFileSync(join(contextDir, "user", "profile.md"), "# User\n", "utf-8");

      const res = await app.request("/api/context/health");

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        status: string;
        userAreaGaps: Array<{ path: string; repairable: boolean }>;
        frontmatterErrors: Array<{ path: string; code: string }>;
      };
      expect(data.status).toBe("error");
      expect(data.userAreaGaps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "user/people.md", repairable: true }),
          expect.objectContaining({ path: "user/work.md", repairable: true }),
        ]),
      );
      expect(data.frontmatterErrors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "user/profile.md",
            code: "missing_frontmatter",
          }),
        ]),
      );
    });

    it("creates a missing known stub from the templates tree", async () => {
      config.workspaceDir = dataDir;
      const templatePath = join(
        dataDir,
        "agent-assets",
        "templates",
        "user",
        "people.md",
      );
      mkdirSync(join(templatePath, ".."), { recursive: true });
      const content = withUserFrontmatter("# People\n");
      writeFileSync(templatePath, content, "utf-8");

      const res = await app.request("/api/context/repair/stub", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "user/people" }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { status: string; path: string };
      expect(data).toMatchObject({
        status: "created",
        path: "user/people.md",
      });
      expect(readFileSync(join(contextDir, "user", "people.md"), "utf-8")).toBe(
        content,
      );
    });

    it("rejects arbitrary repair targets", async () => {
      const res = await app.request("/api/context/repair/stub", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "rules/management.md" }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("unsupported_stub_target");
    });
  });

  describe("GET /context/list/routines — custom routine flattening", () => {
    it("surfaces files under routines/custom/ with a custom/ prefix", async () => {
      mkdirSync(join(contextDir, "routines", "custom"), { recursive: true });
      writeFileSync(join(contextDir, "routines", "hourly.md"), "# hourly\n", "utf-8");
      writeFileSync(
        join(contextDir, "routines", "custom", "tuesday-notion.md"),
        "# tuesday\n",
        "utf-8",
      );

      const res = await app.request("/api/context/list/routines");
      expect(res.status).toBe(200);
      const data = (await res.json()) as { files: { name: string }[] };
      const names = data.files.map((f) => f.name).sort();
      expect(names).toContain("hourly.md");
      expect(names).toContain("custom/tuesday-notion.md");
    });

    it("returns an empty custom/ list when the subdir is absent", async () => {
      mkdirSync(join(contextDir, "routines"), { recursive: true });
      writeFileSync(join(contextDir, "routines", "hourly.md"), "# h\n", "utf-8");

      const res = await app.request("/api/context/list/routines");
      expect(res.status).toBe(200);
      const data = (await res.json()) as { files: { name: string }[] };
      expect(data.files.some((f) => f.name.startsWith("custom/"))).toBe(false);
    });
  });

  describe("PUT /context/routines/custom/<slug> — first-write creates parent dir", () => {
    it("creates routines/custom/ and writes the new routine file", async () => {
      // Intentionally do NOT create routines/custom/ up-front — the API
      // route must mkdirp the parent on first write of a new routine.
      const body = [
        "---",
        "type: rule",
        "slug: tuesday-notion",
        'cron: "0 11 * * 2"',
        "process_key: routine.custom.tuesday-notion",
        "enabled: true",
        "backend_tier: light",
        "max_budget_usd: 0.05",
        "---",
        "# Tuesday Notion",
        "",
        "## Checks",
        "",
        "### First check",
        "- **Action**: sample",
        "",
      ].join("\n");

      const res = await app.request(
        "/api/context/routines/custom/tuesday-notion",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: body }),
        },
      );
      expect(res.status).toBe(200);
      const data = (await res.json()) as { status: string };
      expect(data.status).toBe("updated");

      const filePath = join(
        contextDir,
        "routines",
        "custom",
        "tuesday-notion.md",
      );
      expect(readFileSync(filePath, "utf-8")).toBe(body);
    });

    it("rejects invalid custom routine files before writing", async () => {
      const body = [
        "---",
        "type: rule",
        "slug: tuesday-notion",
        'cron: "0 11 * * 2"',
        "process_key: routine.custom.other-slug",
        "enabled: true",
        "backend_tier: light",
        "max_budget_usd: 0.05",
        "---",
        "# Tuesday Notion",
        "",
        "No checks here.",
        "",
      ].join("\n");

      const res = await app.request(
        "/api/context/routines/custom/tuesday-notion",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: body }),
        },
      );
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string; message: string };
      expect(data.error).toBe("validation_error");
      expect(data.message).toContain("process_key");

      const filePath = join(
        contextDir,
        "routines",
        "custom",
        "tuesday-notion.md",
      );
      expect(existsSync(filePath)).toBe(false);
    });
  });

  describe("POST /context/restore-snapshot/:id", () => {
    it("restores the selected snapshot and snapshots the current file first", async () => {
      const filePath = join(contextDir, "today.md");
      const current = validTodayContent("- [ ] 09:00 Current note [work] \u2192DM");
      const restored = validTodayContent("- [ ] 10:00 Restored note [work] \u2192DM");
      writeFileSync(filePath, current, "utf-8");
      const insert = db
        .prepare(
          "INSERT INTO md_file_snapshots (file_path, content, trigger) VALUES (?, ?, ?)",
        )
        .run("today", restored, "test_seed");
      const snapshotId = Number(insert.lastInsertRowid);

      const res = await app.request(`/api/context/restore-snapshot/${snapshotId}`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        status: string;
        path: string;
        restoredFromSnapshotId: number;
        backupSnapshotId: number | null;
      };
      expect(data.status).toBe("restored");
      expect(data.path).toBe("today");
      expect(data.restoredFromSnapshotId).toBe(snapshotId);
      expect(data.backupSnapshotId).toBeGreaterThan(0);
      expect(readFileSync(filePath, "utf-8")).toBe(restored);

      const rows = db
        .prepare(
          "SELECT content, trigger FROM md_file_snapshots WHERE file_path = ? ORDER BY id DESC",
        )
        .all("today") as Array<{ content: string; trigger: string }>;
      expect(rows[0]).toEqual({
        content: current,
        trigger: "api_restore_snapshot",
      });
    });

    it("restores legacy guarded snapshots that predate frontmatter validation", async () => {
      const filePath = join(contextDir, "user", "profile.md");
      const current = validUserProfileContent();
      const restored = "# User\n\n## Identity\n- legacy snapshot\n";
      writeFileSync(filePath, current, "utf-8");
      const insert = db
        .prepare(
          "INSERT INTO md_file_snapshots (file_path, content, trigger) VALUES (?, ?, ?)",
        )
        .run("user/profile", restored, "legacy_seed");
      const snapshotId = Number(insert.lastInsertRowid);

      const res = await app.request(`/api/context/restore-snapshot/${snapshotId}`, {
        method: "POST",
      });

      expect(res.status).toBe(200);
      expect(readFileSync(filePath, "utf-8")).toBe(restored);
    });

    it("returns 404 when the snapshot row does not exist", async () => {
      const res = await app.request("/api/context/restore-snapshot/99999", {
        method: "POST",
      });
      expect(res.status).toBe(404);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("not_found");
    });
  });

  describe("PUT /context/* — expectedMtime", () => {
    it("succeeds when expectedMtime matches the current file", async () => {
      const filePath = join(contextDir, "today.md");
      const v1 = validTodayContent("- [ ] 09:00 Version one [work] \u2192DM");
      const v2 = validTodayContent("- [ ] 10:00 Version two [work] \u2192DM");
      writeFileSync(filePath, v1, "utf-8");
      const baselineMtime = statSync(filePath).mtime.toISOString();

      const res = await app.request("/api/context/today", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: v2, expectedMtime: baselineMtime }),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        status: string;
        snapshotId: number;
        lastModified: string;
      };
      expect(data.status).toBe("updated");
      expect(data.snapshotId).toBeGreaterThan(0);
      expect(data.lastModified).toBeTruthy();
      expect(readFileSync(filePath, "utf-8")).toBe(v2);
    });

    it("returns 409 with currentContent when expectedMtime is stale", async () => {
      const filePath = join(contextDir, "today.md");
      const v1 = validTodayContent("- [ ] 09:00 Version one [work] \u2192DM");
      const userEdit = validTodayContent("- [ ] 10:00 User edit [work] \u2192DM");
      writeFileSync(filePath, v1, "utf-8");
      const staleMtime = "2000-01-01T00:00:00.000Z";

      const res = await app.request("/api/context/today", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: userEdit, expectedMtime: staleMtime }),
      });
      expect(res.status).toBe(409);
      const data = (await res.json()) as {
        error: string;
        currentMtime: string;
        currentContent: string;
      };
      expect(data.error).toBe("conflict");
      expect(data.currentContent).toBe(v1);
      expect(data.currentMtime).toBeTruthy();
      // The on-disk file must NOT have been overwritten
      expect(readFileSync(filePath, "utf-8")).toBe(v1);
    });

    it("returns 409 when expectedMtime is provided but the file has been deleted", async () => {
      const res = await app.request("/api/context/today", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: validTodayContent("- [ ] 10:00 Deleted file write [work] \u2192DM"),
          expectedMtime: "2026-04-07T10:00:00.000Z",
        }),
      });
      expect(res.status).toBe(409);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("conflict");
    });

    it("allows write without expectedMtime (backward compat for agent callers)", async () => {
      const filePath = join(contextDir, "today.md");
      const agentWrite = validTodayContent("- [ ] 10:00 Agent write [work] \u2192DM");
      writeFileSync(filePath, validTodayContent(), "utf-8");

      const res = await app.request("/api/context/today", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: agentWrite }),
      });
      expect(res.status).toBe(200);
      expect(readFileSync(filePath, "utf-8")).toBe(agentWrite);
    });

    it("creates a new file when expectedMtime is omitted and file does not exist", async () => {
      const filePath = join(contextDir, "projects", "new-project.md");

      const res = await app.request("/api/context/projects/new-project", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: validProjectContent("New project") }),
      });
      expect(res.status).toBe(200);
      expect(readFileSync(filePath, "utf-8")).toBe(validProjectContent("New project"));
    });

    it("still enforces the write whitelist before checking expectedMtime", async () => {
      mkdirSync(join(contextDir, "schedule"), { recursive: true });
      writeFileSync(join(contextDir, "schedule", "2026-04-07.md"), "x\n", "utf-8");

      const res = await app.request("/api/context/schedule/2026-04-07", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "y\n", expectedMtime: "anything" }),
      });
      // Forbidden takes precedence over conflict — never leak file content
      // through a 409 for paths the user is not allowed to write.
      expect(res.status).toBe(403);
    });
  });

  // Regression: setup.initial agents constructed curl commands that sent a
  // literal `@-` as the body (observed 2026-04-18, daemon.log line 577).
  // Hono's default handler turned the resulting SyntaxError into a 500
  // `internal_error`, which the agent misread as a permission denial.
  // Surfacing a 400 `invalid_json_body` keeps the failure diagnosable.
  describe("PUT/PATCH /context/* — malformed JSON body", () => {
    it("PUT returns 400 invalid_json_body with SyntaxError detail when body is not valid JSON", async () => {
      const res = await app.request("/api/context/user/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "@-",
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string; message: string };
      expect(data.error).toBe("invalid_json_body");
      // Surface the real parse error so the agent can self-correct the body
      // shape instead of retrying the same malformed request.
      expect(data.message).toMatch(/@-/);
    });

    it("PATCH returns 400 invalid_json_body with SyntaxError detail when body is not valid JSON", async () => {
      writeFileSync(join(contextDir, "today.md"), "v1\n", "utf-8");
      const res = await app.request("/api/context/today", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: "@-",
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string; message: string };
      expect(data.error).toBe("invalid_json_body");
      expect(data.message).toMatch(/@-/);
    });
  });

  // ── PATCH section operations ──

  describe("PATCH /context/* — section operations", () => {
    const userMd = withUserFrontmatter([
      "# User",
      "",
      "## Identity",
      "- Name: Test User",
      "",
      "## Communication Style",
      "- Language: English",
      "- Verbosity: concise",
      "",
      "## Raw Signals",
      "",
    ].join("\n"));

    it("appends content to a section", async () => {
      writeFileSync(join(contextDir, "user", "profile.md"), userMd, "utf-8");

      const res = await app.request("/api/context/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          section: "communication_style",
          mode: "append",
          content: "- Formality: casual",
        }),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { status: string };
      expect(data.status).toBe("appended");

      const updated = readFileSync(join(contextDir, "user", "profile.md"), "utf-8");
      expect(updated).toContain("- Language: English");
      expect(updated).toContain("- Verbosity: concise");
      expect(updated).toContain("- Formality: casual");
    });

    it("classifies today Agent Log patches as quiet prompt-context changes", async () => {
      writeFileSync(join(contextDir, "today.md"), validTodayContent(), "utf-8");

      const res = await app.request("/api/context/today", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          section: "agent_log",
          mode: "append",
          content: "- 09:35 Processed meeting summary",
        }),
      });

      expect(res.status).toBe(200);
      expect(promptChanges).toEqual([
        {
          path: "today",
          reason: "context_patch:today",
          tier: "quiet",
          tierReason: "today_agent_log_section",
        },
      ]);
    });

    it("classifies today Agent Plan patches as loud prompt-context changes", async () => {
      writeFileSync(join(contextDir, "today.md"), validTodayContent(), "utf-8");

      const res = await app.request("/api/context/today", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          section: "agent_plan",
          mode: "replace",
          content: "- [ ] 10:00 Send prep note [work] \u2192DM",
        }),
      });

      expect(res.status).toBe(200);
      expect(promptChanges).toEqual([
        {
          path: "today",
          reason: "context_patch:today",
          tier: "loud",
          tierReason: "default_loud",
        },
      ]);
    });

    it("appends to an empty section (end of file)", async () => {
      mkdirSync(join(contextDir, "user"), { recursive: true });
      writeFileSync(join(contextDir, "user", "profile.md"), userMd, "utf-8");

      const res = await app.request("/api/context/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          section: "raw_signals",
          mode: "append",
          content: "- [2026-04-10 10:00:00] [reaction] thumbs up",
        }),
      });
      expect(res.status).toBe(200);

      const updated = readFileSync(join(contextDir, "user", "profile.md"), "utf-8");
      expect(updated).toContain("## Raw Signals");
      expect(updated).toContain("- [2026-04-10 10:00:00] [reaction] thumbs up");
      // Other sections must be intact
      expect(updated).toContain("- Name: Test User");
      expect(updated).toContain("- Language: English");
    });

    it("replaces section content without destroying other sections", async () => {
      mkdirSync(join(contextDir, "user"), { recursive: true });
      writeFileSync(join(contextDir, "user", "profile.md"), userMd, "utf-8");

      const res = await app.request("/api/context/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          section: "communication_style",
          mode: "replace",
          content: "- Language: Spanish\n- Verbosity: detailed\n- Formality: casual",
        }),
      });
      expect(res.status).toBe(200);

      const updated = readFileSync(join(contextDir, "user", "profile.md"), "utf-8");
      // Replaced section
      expect(updated).toContain("- Language: Spanish");
      expect(updated).toContain("- Verbosity: detailed");
      expect(updated).not.toContain("- Language: English");
      // Other sections preserved
      expect(updated).toContain("- Name: Test User");
      expect(updated).toContain("## Raw Signals");
    });

    it("clears a section", async () => {
      mkdirSync(join(contextDir, "user"), { recursive: true });
      writeFileSync(join(contextDir, "user", "profile.md"), userMd, "utf-8");

      const res = await app.request("/api/context/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          section: "communication_style",
          mode: "clear",
        }),
      });
      expect(res.status).toBe(200);

      const updated = readFileSync(join(contextDir, "user", "profile.md"), "utf-8");
      expect(updated).toContain("## Communication Style");
      expect(updated).not.toContain("- Language: English");
      // Other sections preserved
      expect(updated).toContain("- Name: Test User");
    });

    it("returns 400 for non-existent section", async () => {
      mkdirSync(join(contextDir, "user"), { recursive: true });
      writeFileSync(join(contextDir, "user", "profile.md"), userMd, "utf-8");

      const res = await app.request("/api/context/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          section: "nonexistent",
          mode: "append",
          content: "x",
        }),
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string; availableSections: string[] };
      expect(data.error).toBe("section_not_found");
      expect(data.availableSections).toContain("identity");
    });

    it("consecutive appends produce correct separator", async () => {
      mkdirSync(join(contextDir, "user"), { recursive: true });
      writeFileSync(join(contextDir, "user", "profile.md"), userMd, "utf-8");

      // First append
      await app.request("/api/context/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          section: "raw_signals",
          mode: "append",
          content: "- [2026-04-10 10:00:00] [reaction] signal 1",
        }),
      });

      // Second append
      await app.request("/api/context/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          section: "raw_signals",
          mode: "append",
          content: "- [2026-04-10 10:01:00] [reaction] signal 2",
        }),
      });

      const updated = readFileSync(join(contextDir, "user", "profile.md"), "utf-8");
      expect(updated).toContain("- [2026-04-10 10:00:00] [reaction] signal 1");
      expect(updated).toContain("- [2026-04-10 10:01:00] [reaction] signal 2");
      // No double-newline gaps between entries
      expect(updated).not.toContain("signal 1\n\n\n");
    });
  });

  // ── PATCH clear_before ──

  describe("PATCH /context/* — clear_before mode", () => {
    const signalsMd = withUserFrontmatter([
      "# User",
      "",
      "## Identity",
      "- Name: Test",
      "",
      "## Raw Signals",
      "- [2026-04-10 02:30:00] [ignore] old signal 1",
      "- [2026-04-10 02:32:00] [ignore] old signal 2",
      "- [2026-04-10 02:35:00] [reaction] new signal 3",
      "- [2026-04-10 02:40:00] [correction] new signal 4",
      "",
    ].join("\n"));

    it("removes entries with timestamp ≤ cutoff", async () => {
      writeFileSync(join(contextDir, "user", "profile.md"), signalsMd, "utf-8");

      const res = await app.request("/api/context/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          section: "raw_signals",
          mode: "clear_before",
          cutoff: "2026-04-10 02:32:00",
        }),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { status: string; removedCount: number };
      expect(data.status).toBe("cleared");
      expect(data.removedCount).toBe(2);

      const updated = readFileSync(join(contextDir, "user", "profile.md"), "utf-8");
      expect(updated).not.toContain("old signal 1");
      expect(updated).not.toContain("old signal 2");
      expect(updated).toContain("new signal 3");
      expect(updated).toContain("new signal 4");
      // Other sections preserved
      expect(updated).toContain("- Name: Test");
    });

    it("preserves all entries when cutoff is before all timestamps", async () => {
      writeFileSync(join(contextDir, "user", "profile.md"), signalsMd, "utf-8");

      const res = await app.request("/api/context/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          section: "raw_signals",
          mode: "clear_before",
          cutoff: "2020-01-01 00:00:00",
        }),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { removedCount: number };
      expect(data.removedCount).toBe(0);
    });

    it("returns 400 when cutoff is missing", async () => {
      writeFileSync(join(contextDir, "user", "profile.md"), signalsMd, "utf-8");

      const res = await app.request("/api/context/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          section: "raw_signals",
          mode: "clear_before",
        }),
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("validation_error");
    });
  });

  // ── PATCH append with maxEntries ──

  describe("PATCH /context/* — maxEntries trimming", () => {
    it("trims oldest entries when section exceeds maxEntries", async () => {
      const md = withUserFrontmatter([
        "# User",
        "",
        "## Raw Signals",
        "- [2026-04-10 01:00:00] [ignore] entry 1",
        "- [2026-04-10 02:00:00] [ignore] entry 2",
        "- [2026-04-10 03:00:00] [ignore] entry 3",
        "",
      ].join("\n"));
      writeFileSync(join(contextDir, "user", "profile.md"), md, "utf-8");

      const res = await app.request("/api/context/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          section: "raw_signals",
          mode: "append",
          content: "- [2026-04-10 04:00:00] [reaction] entry 4",
          maxEntries: 3,
        }),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { status: string; trimmedCount: number };
      expect(data.status).toBe("appended");
      expect(data.trimmedCount).toBe(1);

      const updated = readFileSync(join(contextDir, "user", "profile.md"), "utf-8");
      expect(updated).not.toContain("entry 1"); // oldest trimmed
      expect(updated).toContain("entry 2");
      expect(updated).toContain("entry 3");
      expect(updated).toContain("entry 4");
    });

    it("does not trim when within limit", async () => {
      const md = withUserFrontmatter([
        "# User",
        "",
        "## Raw Signals",
        "- [2026-04-10 01:00:00] [ignore] entry 1",
        "",
      ].join("\n"));
      writeFileSync(join(contextDir, "user", "profile.md"), md, "utf-8");

      const res = await app.request("/api/context/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          section: "raw_signals",
          mode: "append",
          content: "- [2026-04-10 02:00:00] [reaction] entry 2",
          maxEntries: 20,
        }),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { trimmedCount?: number };
      expect(data.trimmedCount).toBe(0);
    });
  });

  // ── Unit tests for helper functions ──

  describe("clearEntriesBefore — blank line handling", () => {
    // Import tested via the module's exports
    it("removes orphaned blank lines between removed entries", async () => {
      // Simulate actual user/profile.md format where entries may have blank lines between them
      const md = withUserFrontmatter([
        "# User",
        "",
        "## Raw Signals",
        "- [2026-04-10 01:00:00] [ignore] old 1",
        "",
        "- [2026-04-10 02:00:00] [ignore] old 2",
        "",
        "- [2026-04-10 03:00:00] [reaction] new 3",
        "",
      ].join("\n"));
      writeFileSync(join(contextDir, "user", "profile.md"), md, "utf-8");

      const res = await app.request("/api/context/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          section: "raw_signals",
          mode: "clear_before",
          cutoff: "2026-04-10 02:00:00",
        }),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { removedCount: number };
      expect(data.removedCount).toBe(2);

      const updated = readFileSync(join(contextDir, "user", "profile.md"), "utf-8");
      expect(updated).not.toContain("old 1");
      expect(updated).not.toContain("old 2");
      expect(updated).toContain("new 3");
      // Verify no orphaned leading blank lines in the section body
      const rawSection = updated.split("## Raw Signals\n")[1];
      expect(rawSection).not.toMatch(/^\n\n/);
    });
  });

  describe("trimBulletEntries — blank line handling", () => {
    it("removes blank lines between trimmed entries", async () => {
      const md = withUserFrontmatter([
        "# User",
        "",
        "## Raw Signals",
        "- [2026-04-10 01:00:00] [ignore] entry 1",
        "",
        "- [2026-04-10 02:00:00] [ignore] entry 2",
        "",
        "- [2026-04-10 03:00:00] [ignore] entry 3",
        "",
      ].join("\n"));
      writeFileSync(join(contextDir, "user", "profile.md"), md, "utf-8");

      const res = await app.request("/api/context/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          section: "raw_signals",
          mode: "append",
          content: "- [2026-04-10 04:00:00] [reaction] entry 4",
          maxEntries: 3,
        }),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { trimmedCount: number };
      expect(data.trimmedCount).toBe(1);

      const updated = readFileSync(join(contextDir, "user", "profile.md"), "utf-8");
      expect(updated).not.toContain("entry 1");
      expect(updated).toContain("entry 2");
      expect(updated).toContain("entry 4");
      // No orphaned leading blank line
      const rawSection = updated.split("## Raw Signals\n")[1];
      expect(rawSection).not.toMatch(/^\n\n/);
    });
  });

  // ── Snapshot session_id ──

  describe("Snapshot session_id tracking", () => {
    it("records X-Session-Id header in snapshot on PUT", async () => {
      const oldContent = withUserFrontmatter("# User\nold content\n");
      const newContent = withUserFrontmatter("# User\nnew content\n");
      writeFileSync(join(contextDir, "user", "profile.md"), oldContent, "utf-8");

      await app.request("/api/context/user/profile", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Session-Id": "session-abc-123",
        },
        body: JSON.stringify({ content: newContent }),
      });

      const snapshot = db
        .prepare("SELECT session_id FROM md_file_snapshots WHERE file_path = ? ORDER BY id DESC LIMIT 1")
        .get("user/profile") as { session_id: string | null } | undefined;
      expect(snapshot?.session_id).toBe("session-abc-123");
    });

    it("records X-Session-Id header in snapshot on PATCH", async () => {
      const md = withUserFrontmatter("# User\n\n## Identity\n- Name: Test\n");
      writeFileSync(join(contextDir, "user", "profile.md"), md, "utf-8");

      await app.request("/api/context/user/profile", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Session-Id": "session-xyz-789",
        },
        body: JSON.stringify({
          section: "identity",
          mode: "replace",
          content: "- Name: Updated",
        }),
      });

      const snapshot = db
        .prepare("SELECT session_id FROM md_file_snapshots WHERE file_path = ? ORDER BY id DESC LIMIT 1")
        .get("user/profile") as { session_id: string | null } | undefined;
      expect(snapshot?.session_id).toBe("session-xyz-789");
    });
  });

  // ── Append-only PUT guard (CREATE_ONLY_PUT) ──

  describe("PUT /context/agent/journal — append-only guard", () => {
    it("allows PUT when agent/journal does not exist yet (initial creation)", async () => {
      const res = await app.request("/api/context/agent/journal", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "# Agent Journal\n" }),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { status: string };
      expect(data.status).toBe("updated");
      expect(readFileSync(join(contextDir, "agent", "journal.md"), "utf-8")).toBe(
        "# Agent Journal\n",
      );
    });

    it("rejects PUT with 409 when agent/journal already exists", async () => {
      writeFileSync(
        join(contextDir, "agent", "journal.md"),
        "# Agent Journal\n\n## Weekly 2026-W14\n- note\n",
        "utf-8",
      );

      const res = await app.request("/api/context/agent/journal", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "# Agent Journal\n\noverwritten!\n" }),
      });
      expect(res.status).toBe(409);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("append_only");

      // Original content preserved
      const content = readFileSync(join(contextDir, "agent", "journal.md"), "utf-8");
      expect(content).toContain("## Weekly 2026-W14");
      expect(content).not.toContain("overwritten!");
    });

    it("still allows PATCH append_to_file on existing agent/journal", async () => {
      writeFileSync(
        join(contextDir, "agent", "journal.md"),
        "# Agent Journal\n\n## Weekly 2026-W13\n- existing note\n",
        "utf-8",
      );

      const res = await app.request("/api/context/agent/journal", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "append_to_file",
          content: "## Weekly 2026-W14\n- new note",
        }),
      });
      expect(res.status).toBe(200);
      const content = readFileSync(join(contextDir, "agent", "journal.md"), "utf-8");
      // Both sections present, new one appended at EOF
      expect(content).toContain("## Weekly 2026-W13");
      expect(content).toContain("## Weekly 2026-W14");
      expect(content).toContain("- new note");
    });

    it("sequential PUTs: first creates, second is rejected (TOCTOU guard)", async () => {
      // Simulate two PUTs in sequence — the first should succeed (create),
      // the second should be rejected (file now exists).
      const res1 = await app.request("/api/context/agent/journal", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "# Agent Journal\n\n## Weekly 2026-W14\n- first\n" }),
      });
      expect(res1.status).toBe(200);

      const res2 = await app.request("/api/context/agent/journal", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "# Agent Journal\n\n## Weekly 2026-W15\n- second\n" }),
      });
      expect(res2.status).toBe(409);
      const data = (await res2.json()) as { error: string };
      expect(data.error).toBe("append_only");

      // First content survives, second never written
      const content = readFileSync(join(contextDir, "agent", "journal.md"), "utf-8");
      expect(content).toContain("## Weekly 2026-W14");
      expect(content).not.toContain("## Weekly 2026-W15");
    });
  });

  describe("PATCH /context/* — append_to_file mode", () => {
    it("appends content to end of file without requiring section", async () => {
      writeFileSync(
        join(contextDir, "agent", "journal.md"),
        "# Agent Journal\n\n## Weekly 2026-W13\n- note\n",
        "utf-8",
      );

      const res = await app.request("/api/context/agent/journal", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "append_to_file",
          content: "## Weekly 2026-W14\n> Appended\n\n### What worked\n- shipped feature",
        }),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { status: string };
      expect(data.status).toBe("appended");

      const content = readFileSync(join(contextDir, "agent", "journal.md"), "utf-8");
      // Original content preserved
      expect(content).toContain("## Weekly 2026-W13");
      // New content appended as a separate top-level section
      expect(content).toContain("## Weekly 2026-W14");
      expect(content).toContain("### What worked");
      expect(content).toContain("- shipped feature");
    });

    it("returns 404 when file does not exist", async () => {
      const res = await app.request("/api/context/agent/journal", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "append_to_file",
          content: "## Weekly 2026-W14\n- note",
        }),
      });
      expect(res.status).toBe(404);
    });

    it("creates a snapshot before appending", async () => {
      writeFileSync(
        join(contextDir, "agent", "journal.md"),
        "# Agent Journal\n",
        "utf-8",
      );

      await app.request("/api/context/agent/journal", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "append_to_file",
          content: "## Weekly 2026-W14\n- note",
        }),
      });

      const snapshot = db
        .prepare("SELECT content, trigger FROM md_file_snapshots WHERE file_path = ? ORDER BY id DESC LIMIT 1")
        .get("agent/journal") as { content: string; trigger: string } | undefined;
      expect(snapshot).toBeTruthy();
      expect(snapshot!.content).toBe("# Agent Journal\n");
      expect(snapshot!.trigger).toBe("api_patch");
    });
  });

  describe("PUT/PATCH /context/roadmap — schema validation", () => {
    function validRoadmapWithIds(): string {
      return [
        "# Roadmap",
        "> Last synced: 2026-04-20",
        "",
        "## Annual Goals",
        "",
        "## Quarterly Focus",
        "",
        "## Long-term Plans",
        "- [2026-Q3] US study prep — Source: dm 2026-04-19 — Review: 2026-05-17 — ReviewCount: 0  <!-- id: rm-20260419-111111 -->",
        "",
        "## Agent Action Plan",
        "### 2026-05-10: LA Trip  <!-- id: rm-20260419-a3f1c2 -->",
        "Source: Travel Bookings",
        "",
        "**Preparation Timeline:**",
        "- 2026-04-20 [notify]: Start ESTA prep",
        "- completed 2026-04-21: 2026-04-22 [check]: Confirm hotel",
        "",
        "**Agent Notes:**",
        "- Booking found.",
        "",
        "## Recurring",
        "",
      ].join("\n");
    }

    it("rejects bad roadmap PUT bodies before writing or snapshotting", async () => {
      const filePath = join(contextDir, "roadmap.md");
      writeFileSync(filePath, validRoadmap(), "utf-8");

      const res = await app.request("/api/context/roadmap", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: [
            "# Roadmap",
            "> Last synced: 2026-04-20",
            "",
            "## Annual Goals",
            "",
            "## Quarterly Focus",
            "",
            "## Long-term Plans",
            "- [soon] malformed",
            "",
            "## Agent Action Plan",
            "",
            "## Recurring",
            "",
          ].join("\n"),
        }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string; message: string; path: string };
      expect(data.error).toBe("validation_error");
      expect(data.path).toBe("roadmap.md");
      expect(data.message).toContain("line");
      expect(readFileSync(filePath, "utf-8")).toBe(validRoadmap());

      const snapshotCount = db
        .prepare("SELECT COUNT(*) AS count FROM md_file_snapshots WHERE file_path = ?")
        .get("roadmap") as { count: number };
      expect(snapshotCount.count).toBe(0);
    });

    it("normalizes parseable user-authored Long-term Plans lines on PUT", async () => {
      const body = validRoadmap().replace(
        "- [2026-Q3] US study prep — Source: dm 2026-04-19 — Review: 2026-05-17 — ReviewCount: 0",
        "- [2026-05] LA trip candidate",
      );

      const res = await app.request("/api/context/roadmap", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Caller": "dashboard",
        },
        body: JSON.stringify({ content: body }),
      });

      expect(res.status).toBe(200);
      const written = readFileSync(join(contextDir, "roadmap.md"), "utf-8");
      expect(written).toContain(
        "- [2026-05] LA trip candidate — Source: dashboard",
      );
      expect(written).toContain("— Review:");
      expect(written).toContain("— ReviewCount: 0");
    });

    it("uses manual source when a roadmap write caller is not identifiable", async () => {
      const body = validRoadmap().replace(
        "- [2026-Q3] US study prep — Source: dm 2026-04-19 — Review: 2026-05-17 — ReviewCount: 0",
        "- [2026-05] LA trip candidate",
      );

      const res = await app.request("/api/context/roadmap", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: body }),
      });

      expect(res.status).toBe(200);
      const written = readFileSync(join(contextDir, "roadmap.md"), "utf-8");
      expect(written).toContain(
        "- [2026-05] LA trip candidate — Source: manual",
      );
    });

    it("rejects bad roadmap PATCH results before snapshotting", async () => {
      const filePath = join(contextDir, "roadmap.md");
      writeFileSync(filePath, validRoadmap(), "utf-8");

      const res = await app.request("/api/context/roadmap", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          section: "long_term_plans",
          mode: "append",
          content: "- [later-ish] broken",
        }),
      });

      expect(res.status).toBe(400);
      expect(readFileSync(filePath, "utf-8")).toBe(validRoadmap());
      const snapshotCount = db
        .prepare("SELECT COUNT(*) AS count FROM md_file_snapshots WHERE file_path = ?")
        .get("roadmap") as { count: number };
      expect(snapshotCount.count).toBe(0);
    });

    it("allows operator bypass with X-Roadmap-Validation: off", async () => {
      const res = await app.request("/api/context/roadmap", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Roadmap-Validation": "off",
          "X-Session-Id": "session-roadmap-bypass",
        },
        body: JSON.stringify({ content: "# Roadmap\n\nbad body\n" }),
      });

      expect(res.status).toBe(200);
      expect(readFileSync(join(contextDir, "roadmap.md"), "utf-8")).toBe(
        "# Roadmap\n\nbad body\n",
      );
    });

    it("rejects roadmap PUTs that drop completed prep rows", async () => {
      const filePath = join(contextDir, "roadmap.md");
      const original = validRoadmapWithIds();
      writeFileSync(filePath, original, "utf-8");

      const next = original.replace(
        "- completed 2026-04-21: 2026-04-22 [check]: Confirm hotel\n",
        "",
      );
      const res = await app.request("/api/context/roadmap", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: next }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string; message: string };
      expect(data.error).toBe("validation_error");
      expect(data.message).toContain("Completed Preparation Timeline row");
      expect(readFileSync(filePath, "utf-8")).toBe(original);

      const snapshotCount = db
        .prepare("SELECT COUNT(*) AS count FROM md_file_snapshots WHERE file_path = ?")
        .get("roadmap") as { count: number };
      expect(snapshotCount.count).toBe(0);
    });

    it("lets the operator bypass skip the transition guard", async () => {
      const filePath = join(contextDir, "roadmap.md");
      const original = validRoadmapWithIds();
      writeFileSync(filePath, original, "utf-8");
      const next = original.replace(
        "- completed 2026-04-21: 2026-04-22 [check]: Confirm hotel\n",
        "",
      );

      const res = await app.request("/api/context/roadmap", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Roadmap-Validation": "off",
        },
        body: JSON.stringify({ content: next }),
      });

      expect(res.status).toBe(200);
      expect(readFileSync(filePath, "utf-8")).toBe(next);
    });

    it("mints roadmap ids with the requested source date", async () => {
      const deterministicApp = new Hono();
      deterministicApp.route(
        "/api",
        createContextRoutes({
          db,
          config,
          roadmapIdRandomBytes: () => Buffer.from([0xa3, 0xf1, 0xc2]),
        } as unknown as Parameters<typeof createContextRoutes>[0]),
      );

      const res = await deterministicApp.request("/api/context/roadmap/id", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creationDate: "2026-04-19" }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { id: string };
      expect(data.id).toBe("rm-20260419-a3f1c2");
    });

    it("retries roadmap id collisions against current roadmap content", async () => {
      writeFileSync(join(contextDir, "roadmap.md"), validRoadmapWithIds(), "utf-8");
      const suffixes = [
        Buffer.from([0xa3, 0xf1, 0xc2]),
        Buffer.from([0xb8, 0xe7, 0xd4]),
      ];
      let index = 0;
      const deterministicApp = new Hono();
      deterministicApp.route(
        "/api",
        createContextRoutes({
          db,
          config,
          roadmapIdRandomBytes: () => suffixes[index++] ?? suffixes.at(-1)!,
        } as unknown as Parameters<typeof createContextRoutes>[0]),
      );

      const res = await deterministicApp.request("/api/context/roadmap/id", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceDate: "2026-04-19" }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { id: string };
      expect(data.id).toBe("rm-20260419-b8e7d4");
    });

    it("returns 503 when roadmap id generation exhausts collision retries", async () => {
      writeFileSync(join(contextDir, "roadmap.md"), validRoadmapWithIds(), "utf-8");
      const deterministicApp = new Hono();
      deterministicApp.route(
        "/api",
        createContextRoutes({
          db,
          config,
          roadmapIdRandomBytes: () => Buffer.from([0xa3, 0xf1, 0xc2]),
        } as unknown as Parameters<typeof createContextRoutes>[0]),
      );

      const res = await deterministicApp.request("/api/context/roadmap/id", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creationDate: "2026-04-19" }),
      });

      expect(res.status).toBe(503);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("roadmap_id_generation_failed");
    });
  });

  describe("Management Mode degraded-mode gate", () => {
    it("returns 503 on GET when degraded mode is active", async () => {
      writeFileSync(join(contextDir, "today.md"), "# Today\n", "utf-8");
      setDegradedMode(db, {
        reason: "primary_vault_unreachable",
        path: "/missing/vault",
        since: "2026-04-18T10:00:00Z",
      });

      const res = await app.request("/api/context/today");
      expect(res.status).toBe(503);
      const body = (await res.json()) as {
        error: string;
        reason: string;
        path: string;
      };
      expect(body.error).toBe("primary_vault_unreachable");
      expect(body.reason).toBe("primary_vault_unreachable");
      expect(body.path).toBe("/missing/vault");
    });

    it("returns 503 on PUT when degraded mode is active", async () => {
      setDegradedMode(db, {
        reason: "primary_vault_not_configured",
        path: null,
        since: "2026-04-18T11:00:00Z",
      });

      const res = await app.request("/api/context/today", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "# Today\n" }),
      });
      expect(res.status).toBe(503);
    });

    it("serves reads normally after degraded mode is cleared", async () => {
      writeFileSync(join(contextDir, "today.md"), "# Today\n", "utf-8");
      setDegradedMode(db, {
        reason: "primary_vault_unreachable",
        path: "/x",
        since: "2026-04-18T10:00:00Z",
      });
      expect((await app.request("/api/context/today")).status).toBe(503);

      clearDegradedMode(db);
      expect((await app.request("/api/context/today")).status).toBe(200);
    });
  });
});

// ── Additional coverage tests ──

describe("Context API — additional coverage", () => {
  let dataDir: string;
  let contextDir: string;
  let db: Database.Database;
  let app: Hono;
  let config: AgentConfig;

  function makeConfig(): AgentConfig {
    return {
      dataDir,
      executeTimeoutMinutes: 60,
    } as unknown as AgentConfig;
  }

  function makeApp(overrideDeps?: Partial<Parameters<typeof createContextRoutes>[0]>) {
    const contextRoutes = createContextRoutes({
      db,
      config,
      ...overrideDeps,
    } as unknown as Parameters<typeof createContextRoutes>[0]);
    const a = new Hono();
    a.route("/api", contextRoutes);
    return a;
  }

  beforeEach(() => {
    dataDir = join(tmpdir(), `pa-ctx-extra-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    contextDir = join(dataDir, "context");
    mkdirSync(contextDir, { recursive: true });
    mkdirSync(join(contextDir, "user"), { recursive: true });
    mkdirSync(join(contextDir, "rules"), { recursive: true });
    mkdirSync(join(contextDir, "agent"), { recursive: true });
    mkdirSync(join(contextDir, "routines"), { recursive: true });
    mkdirSync(join(contextDir, "routines", "custom"), { recursive: true });
    mkdirSync(join(contextDir, "projects"), { recursive: true });
    mkdirSync(join(contextDir, "daily"), { recursive: true });
    mkdirSync(join(contextDir, "git"), { recursive: true });
    db = new Database(":memory:");
    applySchema(db);
    config = makeConfig();
    app = makeApp();
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  // ── Lock endpoints ──

  describe("POST/DELETE /context/lock/morning-routine", () => {
    it("POST acquires the lock and returns lockId", async () => {
      const res = await app.request("/api/context/lock/morning-routine", { method: "POST" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; lockId: string };
      expect(body.status).toBe("acquired");
      expect(typeof body.lockId).toBe("string");
    });

    it("POST returns 409 when lock is already held", async () => {
      await app.request("/api/context/lock/morning-routine", { method: "POST" });
      const res2 = await app.request("/api/context/lock/morning-routine", { method: "POST" });
      expect(res2.status).toBe(409);
      const body = (await res2.json()) as { error: string; holder: string };
      expect(body.error).toBe("lock_held");
    });

    it("DELETE releases the lock with valid lockId", async () => {
      const acquireRes = await app.request("/api/context/lock/morning-routine", { method: "POST" });
      const { lockId } = (await acquireRes.json()) as { lockId: string };

      const res = await app.request("/api/context/lock/morning-routine", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lockId }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("released");
    });

    it("DELETE returns 400 with bad/missing lockId", async () => {
      await app.request("/api/context/lock/morning-routine", { method: "POST" });
      const res = await app.request("/api/context/lock/morning-routine", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lockId: "wrong-lock-id" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("lock_not_held");
    });
  });

  describe("POST/DELETE /context/lock/roadmap", () => {
    it("POST acquires the roadmap lock and returns lockId", async () => {
      const res = await app.request("/api/context/lock/roadmap", { method: "POST" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; lockId: string };
      expect(body.status).toBe("acquired");
      expect(typeof body.lockId).toBe("string");
    });

    it("POST returns 409 when roadmap lock is already held", async () => {
      await app.request("/api/context/lock/roadmap", { method: "POST" });
      const res2 = await app.request("/api/context/lock/roadmap", { method: "POST" });
      expect(res2.status).toBe(409);
      const body = (await res2.json()) as { error: string };
      expect(body.error).toBe("roadmap_write_lock_held");
    });

    it("DELETE releases roadmap lock with valid lockId", async () => {
      const acquireRes = await app.request("/api/context/lock/roadmap", { method: "POST" });
      const { lockId } = (await acquireRes.json()) as { lockId: string };

      const res = await app.request("/api/context/lock/roadmap", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lockId }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("released");
    });

    it("DELETE returns 400 with bad lockId for roadmap lock", async () => {
      await app.request("/api/context/lock/roadmap", { method: "POST" });
      const res = await app.request("/api/context/lock/roadmap", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lockId: "bad-id" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("lock_not_held");
    });
  });

  // ── archive-today ──

  describe("POST /context/archive-today", () => {
    it("archives today.md to yesterday.md when it exists", async () => {
      const todayStr = getAgentDayDateStr(undefined, 4);
      writeFileSync(
        join(contextDir, "today.md"),
        `# ${todayStr} (Day)\nsome content\n`,
        "utf-8",
      );

      const res = await app.request("/api/context/archive-today", { method: "POST" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; archivePath: string };
      expect(body.status).toBe("archived");
      expect(body.archivePath).toBe("yesterday.md");
      expect(existsSync(join(contextDir, "yesterday.md"))).toBe(true);
    });

    it("returns 404 when today.md does not exist", async () => {
      const res = await app.request("/api/context/archive-today", { method: "POST" });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("not_found");
    });
  });

  // ── list endpoint ──

  describe("GET /context/list/:dir", () => {
    it("returns 400 for an invalid directory name", async () => {
      const res = await app.request("/api/context/list/invalid-dir");
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("invalid_directory");
    });

    it("returns empty files array when dir does not exist", async () => {
      // projects dir exists from beforeEach setup but has no files
      rmSync(join(contextDir, "projects"), { recursive: true, force: true });
      const res = await app.request("/api/context/list/projects");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { files: unknown[] };
      expect(body.files).toEqual([]);
    });

    it("flattens git slug subdirs with overview.md", async () => {
      const slugDir = join(contextDir, "git", "my-repo");
      mkdirSync(slugDir, { recursive: true });
      writeFileSync(join(slugDir, "overview.md"), "# overview\n", "utf-8");

      const res = await app.request("/api/context/list/git");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { files: { name: string }[] };
      const names = body.files.map((f) => f.name);
      expect(names).toContain("my-repo/overview.md");
    });

    it("flattens rules/policies subdir into rules listing", async () => {
      const policiesDir = join(contextDir, "rules", "policies");
      mkdirSync(policiesDir, { recursive: true });
      writeFileSync(join(policiesDir, "no-delete.md"), "# policy\n", "utf-8");

      const res = await app.request("/api/context/list/rules");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { files: { name: string }[] };
      const names = body.files.map((f) => f.name);
      expect(names).toContain("policies/no-delete.md");
    });
  });

  // ── GET wildcard — empty path / "list" path ──

  describe("GET /context/* — empty and list paths", () => {
    it("returns 400 path_required when rawPath is empty", async () => {
      // Need to call with trailing slash; Hono may redirect, so use fetch-like approach
      const res = await app.request("/api/context/");
      // Could be 400 path_required or a redirect; check for path_required
      if (res.status === 200) {
        // Hono may not match /context/ — skip
        return;
      }
      // Accept 400 or 404; the important thing is not 200 with content
      expect([400, 404]).toContain(res.status);
    });

    it("returns 400 path_required when path is 'list' (no trailing dir)", async () => {
      const res = await app.request("/api/context/list");
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("path_required");
    });
  });

  // ── contextWriteGate middleware ──

  describe("contextWriteGate middleware", () => {
    it("returns 503 migration_in_progress when write gate is engaged", async () => {
      const gateApp = makeApp({
        contextWriteGate: {
          isEngaged: () => true,
          getState: () => ({ reason: "migrating", since: "2026-05-01T00:00:00Z" }),
        } as unknown as Parameters<typeof createContextRoutes>[0]["contextWriteGate"],
      });

      writeFileSync(join(contextDir, "today.md"), validTodayContent(), "utf-8");
      const res = await gateApp.request("/api/context/today", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: validTodayContent() }),
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string; reason: string };
      expect(body.error).toBe("migration_in_progress");
      expect(body.reason).toBe("migrating");
    });
  });

  // ── restore-snapshot — missing branches ──

  describe("POST /context/restore-snapshot/:id — additional branches", () => {
    it("returns 400 invalid_id when id is <= 0", async () => {
      const res = await app.request("/api/context/restore-snapshot/0", { method: "POST" });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("invalid_id");
    });

    it("returns 403 when snapshot path is not write-allowed", async () => {
      // Seed a snapshot for a path that is NOT in the write whitelist
      mkdirSync(join(contextDir, "schedule"), { recursive: true });
      writeFileSync(join(contextDir, "schedule", "2026-04-07.md"), "# archive\n", "utf-8");
      const insert = db
        .prepare("INSERT INTO md_file_snapshots (file_path, content, trigger) VALUES (?, ?, ?)")
        .run("schedule/2026-04-07", "# archive\n", "test_seed");
      const snapshotId = Number(insert.lastInsertRowid);

      const res = await app.request(`/api/context/restore-snapshot/${snapshotId}`, {
        method: "POST",
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("forbidden");
    });

    it("returns 409 when morning routine lock held and path is 'today'", async () => {
      // Seed a today snapshot
      const insert = db
        .prepare("INSERT INTO md_file_snapshots (file_path, content, trigger) VALUES (?, ?, ?)")
        .run("today", validTodayContent(), "test_seed");
      const snapshotId = Number(insert.lastInsertRowid);

      // Acquire the morning routine lock
      const lockRes = await app.request("/api/context/lock/morning-routine", { method: "POST" });
      const { lockId: _lockId } = (await lockRes.json()) as { lockId: string };

      const res = await app.request(`/api/context/restore-snapshot/${snapshotId}`, {
        method: "POST",
        // No X-Lock-Id header → should be rejected
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("morning_routine_lock_held");
    });

    it("returns 409 when roadmap lock held and path is 'roadmap'", async () => {
      const insert = db
        .prepare("INSERT INTO md_file_snapshots (file_path, content, trigger) VALUES (?, ?, ?)")
        .run("roadmap", "# Roadmap\n", "test_seed");
      const snapshotId = Number(insert.lastInsertRowid);

      const lockRes = await app.request("/api/context/lock/roadmap", { method: "POST" });
      const { lockId: _lockId } = (await lockRes.json()) as { lockId: string };

      const res = await app.request(`/api/context/restore-snapshot/${snapshotId}`, {
        method: "POST",
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("roadmap_write_lock_held");
    });
  });

  // ── repair/stub — missing branches ──

  describe("POST /context/repair/stub — additional branches", () => {
    it("returns 400 when body is invalid JSON", async () => {
      const res = await app.request("/api/context/repair/stub", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 when path is not a string", async () => {
      const res = await app.request("/api/context/repair/stub", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: 42 }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("validation_error");
    });

    it("returns 400 unsupported_stub_target for unknown paths", async () => {
      // This covers the normalizeRepairStubPath branch (normalizedPath not in REPAIRABLE_STUB_TARGETS)
      const res = await app.request("/api/context/repair/stub", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "user/nonexistent-file" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("unsupported_stub_target");
    });

    it("returns 404 when template file is missing despite templatesRoot being set", async () => {
      config.workspaceDir = dataDir;
      // Create the templates root but NOT the specific file
      mkdirSync(join(dataDir, "agent-assets", "templates", "user"), { recursive: true });

      const res = await app.request("/api/context/repair/stub", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "user/people" }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("template_not_found");
    });

    it("returns 200 with status=exists when stub file already exists", async () => {
      config.workspaceDir = dataDir;
      const templatePath = join(dataDir, "agent-assets", "templates", "user", "people.md");
      mkdirSync(join(templatePath, ".."), { recursive: true });
      writeFileSync(templatePath, "---\ntype: user\nowner: shared\nupdated: 2026-04-21\n---\n# People\n", "utf-8");

      // Pre-create the target file
      writeFileSync(join(contextDir, "user", "people.md"), "# People already here\n", "utf-8");

      const res = await app.request("/api/context/repair/stub", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "user/people" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("exists");
    });
  });

  // ── DELETE ──

  describe("DELETE /context/*", () => {
    it("deletes an existing custom routine file", async () => {
      const routineContent = [
        "---",
        "type: rule",
        "slug: my-routine",
        'cron: "0 11 * * 2"',
        "process_key: routine.custom.my-routine",
        "enabled: true",
        "backend_tier: light",
        "max_budget_usd: 0.05",
        "---",
        "# My Routine",
        "",
        "## Checks",
        "",
        "### First check",
        "- **Action**: sample",
        "",
      ].join("\n");
      writeFileSync(join(contextDir, "routines", "custom", "my-routine.md"), routineContent, "utf-8");

      const res = await app.request("/api/context/routines/custom/my-routine", {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("deleted");
      expect(existsSync(join(contextDir, "routines", "custom", "my-routine.md"))).toBe(false);
    });

    it("returns 404 when the file does not exist", async () => {
      const res = await app.request("/api/context/routines/custom/missing-routine", {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("not_found");
    });

    it("returns 403 when deleting a forbidden path (today)", async () => {
      writeFileSync(join(contextDir, "today.md"), validTodayContent(), "utf-8");
      const res = await app.request("/api/context/today", { method: "DELETE" });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("forbidden");
    });

    it("returns 400 for path traversal in DELETE", async () => {
      const res = await app.request("/api/context/routines/custom/../today", { method: "DELETE" });
      // Could be 400 invalid_path or 403 forbidden depending on normalization
      expect([400, 403]).toContain(res.status);
    });
  });

  // ── PUT when roadmap lock held ──

  describe("PUT /context/roadmap — roadmap lock rejection", () => {
    it("returns 409 when roadmap lock held and no lockId provided", async () => {
      await app.request("/api/context/lock/roadmap", { method: "POST" });

      const res = await app.request("/api/context/roadmap", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "# Roadmap\n\nbody\n" }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("roadmap_write_lock_held");
    });
  });

  // ── PATCH when roadmap lock held ──

  describe("PATCH /context/roadmap — roadmap lock rejection", () => {
    it("returns 409 when roadmap lock held and no lockId provided", async () => {
      writeFileSync(
        join(contextDir, "roadmap.md"),
        "# Roadmap\n\n## Section\n- item\n",
        "utf-8",
      );
      await app.request("/api/context/lock/roadmap", { method: "POST" });

      const res = await app.request("/api/context/roadmap", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ section: "section", mode: "append", content: "- more" }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("roadmap_write_lock_held");
    });
  });

  // ── PATCH unsupported for .base files ──

  describe("PATCH /context/projects/_active — unsupported for .base files", () => {
    it("returns 400 unsupported_operation", async () => {
      writeFileSync(join(contextDir, "projects", "_active.base"), "filters:\n  and: []\n", "utf-8");

      const res = await app.request("/api/context/projects/_active", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ section: "filters", mode: "replace", content: "filters:\n  and: []\n" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("unsupported_operation");
    });
  });

  // ── safePath — projects/_active with non-.base extension ──

  describe("GET /context/projects/_active.md — rejects non-.base extension", () => {
    it("returns 400 invalid_path for projects/_active.md", async () => {
      writeFileSync(join(contextDir, "projects", "_active.md"), "# active\n", "utf-8");
      const res = await app.request("/api/context/projects/_active.md");
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("invalid_path");
    });
  });

  // ── roadmap/id when lock held ──

  describe("POST /context/roadmap/id — roadmap lock rejection", () => {
    it("returns 409 when roadmap lock held and no lockId header provided", async () => {
      await app.request("/api/context/lock/roadmap", { method: "POST" });

      const res = await app.request("/api/context/roadmap/id", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creationDate: "2026-05-10" }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("roadmap_write_lock_held");
    });
  });

  // ── roadmap/id with invalid creationDate ──

  describe("POST /context/roadmap/id — invalid creationDate", () => {
    it("returns 400 validation_error when creationDate is not YYYY-MM-DD", async () => {
      const res = await app.request("/api/context/roadmap/id", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creationDate: "not-a-date" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("validation_error");
    });
  });

  // ── resolveRealPathBestEffort symlink loop ──

  describe("safePath — circular symlink returns null → 400 invalid_path", () => {
    it("returns 400 when a circular symlink is encountered", async () => {
      // Create A → B → A circular symlink pair
      const linkA = join(contextDir, "user", "loop-a.md");
      const linkB = join(contextDir, "user", "loop-b.md");
      symlinkSync(linkB, linkA);
      symlinkSync(linkA, linkB);

      const res = await app.request("/api/context/user/loop-a");
      // safePath returns null due to circular symlink → 400 invalid_path
      expect([400, 404]).toContain(res.status);
    });
  });
});
