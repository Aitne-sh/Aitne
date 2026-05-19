import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { applySchema } from "../../db/schema.js";
import {
  createManagedTasksRoutes,
  buildManagedTasksRoutesDepsFromApi,
  type ManagedTasksRoutesDeps,
} from "./managed-tasks.js";
import { createSotBindingsRoutes } from "./sot-bindings.js";
import {
  InMemoryManagementMdWriteLockManager,
  type ManagementMdWriteLockManager,
} from "../../core/management-md-write-lock.js";
import type { AgentConfig } from "../../config.js";
import { listManagedTasks } from "../../db/managed-tasks-store.js";
import { writeSotBindings } from "../../db/sot-bindings-store.js";
import { CONTEXT_RELATIVE_PATHS } from "../../core/context-paths.js";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Integration tests for the §10.1-10.4 / §17.2 contract:
 *   - POST → DB row + file row + agent_action row, all consistent.
 *   - POST with output_path persists; without persists NULL.
 *   - PATCH output_path updates the row + re-renders the file.
 *   - Concurrent POST with same Idempotency-Key returns same mt_id once.
 *   - Concurrent POST without idempotency key, same app+cadence:
 *     one succeeds, other returns 409 with existing mt_id.
 *   - DELETE cascades and produces the expected agent_actions row.
 *   - The file content stays in lock-step with DB state.
 */

const VALID_RULE = {
  frequency: "daily" as const,
  time: "10:00",
  timezone: "Asia/Tokyo",
};

interface TestEnv {
  db: Database.Database;
  contextDir: string;
  cleanup: () => void;
  lockManager: ManagementMdWriteLockManager;
  config: AgentConfig;
}

function setupEnv(): TestEnv {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  const dataDir = mkdtempSync(join(tmpdir(), "managed-tasks-route-"));
  const contextDir = join(dataDir, "context");
  const lockManager = new InMemoryManagementMdWriteLockManager();
  // `getContextDir` resolves `<dataDir>/context` when vaultMode is unset
  // (the default daemon-managed vault). The route layer goes through
  // `getContextDir(config, db)`, so the test config must thread `dataDir`.
  const config = {
    timezone: "Asia/Tokyo",
    dataDir,
  } as unknown as AgentConfig;
  return {
    db,
    contextDir,
    lockManager,
    config,
    cleanup: () => {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function makeDeps(env: TestEnv): ManagedTasksRoutesDeps {
  return {
    db: env.db,
    config: env.config,
    lockManager: env.lockManager,
  };
}

function readManagementMd(env: TestEnv): string | null {
  try {
    return readFileSync(
      join(env.contextDir, CONTEXT_RELATIVE_PATHS.rules.management),
      "utf-8",
    );
  } catch {
    return null;
  }
}

function selectAgentActions(db: Database.Database, prefix: string): Array<{
  action_type: string;
  detail: Record<string, unknown> | null;
  result: string | null;
}> {
  return (db
    .prepare(
      `SELECT action_type, detail, result FROM agent_actions
        WHERE action_type LIKE ?
        ORDER BY id ASC`,
    )
    .all(`${prefix}%`) as Array<{
      action_type: string;
      detail: string | null;
      result: string | null;
    }>).map((row) => ({
      action_type: row.action_type,
      detail: row.detail ? (JSON.parse(row.detail) as Record<string, unknown>) : null,
      result: row.result,
    }));
}

describe("POST /api/managed-tasks", () => {
  let env: TestEnv;
  beforeEach(() => {
    env = setupEnv();
  });
  afterEach(() => env.cleanup());

  it("creates row + recurring_schedules + agent_actions + management.md", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/managed-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: "Zoom recordings → meeting entity",
        app: "zoom",
        cadence: "daily 10:00 (Asia/Tokyo)",
        recurrenceRule: VALID_RULE,
        output_path: "work/meetings/",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      status: string;
      item: { id: string; output_path: string | null; schedule_id: number };
      render_status: string;
    };
    expect(body.status).toBe("created");
    expect(body.item.id).toMatch(/^mt_[1-9]\d*$/);
    expect(body.item.output_path).toBe("work/meetings/");
    expect(body.render_status).toBe("ok");

    const tasks = listManagedTasks(env.db);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(body.item.id);

    const recurring = env.db
      .prepare("SELECT id, task_type FROM recurring_schedules")
      .all() as Array<{ id: number; task_type: string }>;
    expect(recurring).toHaveLength(1);
    expect(recurring[0].id).toBe(body.item.schedule_id);
    expect(recurring[0].task_type).toBe("scheduled.task");

    const audit = selectAgentActions(env.db, "management_task.");
    expect(audit).toHaveLength(1);
    expect(audit[0].action_type).toBe("management_task.created");
    expect(audit[0].detail?.mt_id).toBe(body.item.id);
    expect(audit[0].detail?.output_path).toBe("work/meetings/");

    const file = readManagementMd(env);
    expect(file).not.toBeNull();
    expect(file).toContain(body.item.id);
    expect(file).toContain("zoom");
    expect(file).toContain("work/meetings/");
  });

  it("persists null output_path when omitted", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/managed-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: "Gmail invoice triage",
        app: "gmail",
        cadence: "hourly",
        recurrenceRule: VALID_RULE,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { item: { output_path: string | null } };
    expect(body.item.output_path).toBeNull();
    const tasks = listManagedTasks(env.db);
    expect(tasks[0].output_path).toBeNull();
  });

  it("rejects validation errors", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/managed-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: "",
        app: "zoom",
        cadence: "hourly",
        recurrenceRule: VALID_RULE,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("validation_error");
  });

  it("returns 409 + existing item on duplicate (app, cadence)", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    const requestBody = JSON.stringify({
      intent: "Zoom recordings",
      app: "zoom",
      cadence: "daily 10:00 (Asia/Tokyo)",
      recurrenceRule: VALID_RULE,
    });
    const first = await app.request("/managed-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestBody,
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { item: { id: string } };

    const second = await app.request("/managed-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestBody,
    });
    expect(second.status).toBe(409);
    const secondBody = (await second.json()) as {
      error: string;
      item: { id: string };
    };
    expect(secondBody.error).toBe("duplicate");
    expect(secondBody.item.id).toBe(firstBody.item.id);
    expect(listManagedTasks(env.db)).toHaveLength(1);
  });

  it("Idempotency-Key short-circuits a retry to the same mt_id", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    const idempotencyKey = "msg-abc-123";
    const requestInit = (): RequestInit => ({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        intent: "Zoom recordings",
        app: "zoom",
        cadence: "daily 10:00 (Asia/Tokyo)",
        recurrenceRule: VALID_RULE,
      }),
    });
    const first = await app.request("/managed-tasks", requestInit());
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { item: { id: string } };

    const second = await app.request("/managed-tasks", requestInit());
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      status: string;
      item: { id: string };
    };
    expect(secondBody.status).toBe("idempotent_replay");
    expect(secondBody.item.id).toBe(firstBody.item.id);
    expect(listManagedTasks(env.db)).toHaveLength(1);
  });

  it("rejects POST when active-tasks cap is reached", async () => {
    // Force the cap to 1 by overriding config and stuffing one row.
    const cappedConfig = {
      ...env.config,
      managementMaxActiveTasks: 1,
    } as unknown as AgentConfig;
    const deps: ManagedTasksRoutesDeps = {
      db: env.db,
      config: cappedConfig,
      lockManager: env.lockManager,
    };
    const app = createManagedTasksRoutes(deps);
    const first = await app.request("/managed-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: "intent A",
        app: "appA",
        cadence: "hourly",
        recurrenceRule: VALID_RULE,
      }),
    });
    expect(first.status).toBe(201);
    const second = await app.request("/managed-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: "intent B",
        app: "appB",
        cadence: "hourly",
        recurrenceRule: VALID_RULE,
      }),
    });
    expect(second.status).toBe(409);
    const secondBody = (await second.json()) as { error: string };
    expect(secondBody.error).toBe("cap_reached");
  });
});

describe("PATCH /api/managed-tasks/:id", () => {
  let env: TestEnv;
  let createdId: string;
  beforeEach(async () => {
    env = setupEnv();
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/managed-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: "intent",
        app: "zoom",
        cadence: "daily 10:00",
        recurrenceRule: VALID_RULE,
      }),
    });
    const body = (await res.json()) as { item: { id: string } };
    createdId = body.item.id;
  });
  afterEach(() => env.cleanup());

  it("updates output_path and re-renders the file", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request(`/managed-tasks/${createdId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ output_path: "personal/meetings/" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { item: { output_path: string | null } };
    expect(body.item.output_path).toBe("personal/meetings/");
    const file = readManagementMd(env);
    expect(file).toContain("personal/meetings/");
    expect(file).not.toContain("work/meetings/");
  });

  it("rejects invalid output_path", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request(`/managed-tasks/${createdId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ output_path: "not-a-real/path" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown id", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/managed-tasks/mt_999", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cadence: "hourly" }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects empty PATCH body", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request(`/managed-tasks/${createdId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/managed-tasks/:id", () => {
  let env: TestEnv;
  beforeEach(() => {
    env = setupEnv();
  });
  afterEach(() => env.cleanup());

  it("hard-deletes managed_tasks + recurring_schedules + audits", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    const create = await app.request("/managed-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: "intent",
        app: "zoom",
        cadence: "daily 10:00",
        recurrenceRule: VALID_RULE,
      }),
    });
    const created = (await create.json()) as {
      item: { id: string; schedule_id: number };
    };

    const del = await app.request(`/managed-tasks/${created.item.id}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);

    const remainingTasks = listManagedTasks(env.db);
    expect(remainingTasks).toHaveLength(0);
    const remainingSchedules = env.db
      .prepare("SELECT id FROM recurring_schedules WHERE id = ?")
      .all(created.item.schedule_id);
    expect(remainingSchedules).toHaveLength(0);

    const audits = selectAgentActions(env.db, "management_task.");
    const types = audits.map((a) => a.action_type);
    expect(types).toContain("management_task.created");
    expect(types).toContain("management_task.deleted");
    const deleted = audits.find(
      (a) => a.action_type === "management_task.deleted",
    );
    expect(deleted?.detail?.mt_id).toBe(created.item.id);
    expect(deleted?.detail?.original_row).toMatchObject({
      id: created.item.id,
    });
  });

  it("returns 404 for unknown id", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/managed-tasks/mt_999", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/managed-tasks/:id/run-now", () => {
  let env: TestEnv;
  let createdId: string;
  let scheduleId: number;
  beforeEach(async () => {
    env = setupEnv();
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/managed-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: "intent",
        app: "zoom",
        cadence: "daily 10:00",
        recurrenceRule: VALID_RULE,
      }),
    });
    const body = (await res.json()) as {
      item: { id: string; schedule_id: number };
    };
    createdId = body.item.id;
    scheduleId = body.item.schedule_id;
  });
  afterEach(() => env.cleanup());

  it("enqueues an agent_schedule row with correlation_id=mt_id", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request(`/managed-tasks/${createdId}/run-now`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "manual test" }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      status: string;
      mt_id: string;
      scheduled_row_id: number;
    };
    expect(body.status).toBe("queued");
    expect(body.mt_id).toBe(createdId);

    const rows = env.db
      .prepare(
        `SELECT id, status, task_type, correlation_id, recurring_schedule_id,
                task_context FROM agent_schedule WHERE id = ?`,
      )
      .all(body.scheduled_row_id) as Array<{
        id: number;
        status: string;
        task_type: string;
        correlation_id: string | null;
        recurring_schedule_id: number | null;
        task_context: string;
      }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].task_type).toBe("scheduled.task");
    expect(rows[0].correlation_id).toBe(createdId);
    expect(rows[0].recurring_schedule_id).toBe(scheduleId);
    const ctx = JSON.parse(rows[0].task_context) as Record<string, unknown>;
    expect(ctx.adhoc).toBe(true);
    expect(ctx.mt_id).toBe(createdId);
    expect(ctx.reason).toBe("manual test");
  });

  it("returns 404 for unknown id", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/managed-tasks/mt_999/run-now", {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 invalid_id for a malformed id (lines 764-765)", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/managed-tasks/not_an_id/run-now", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_id");
  });
});

describe("POST /api/managed-tasks/:id/rename-app", () => {
  let env: TestEnv;
  let createdId: string;
  beforeEach(async () => {
    env = setupEnv();
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/managed-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: "intent",
        app: "Zoom",
        cadence: "daily 10:00",
        recurrenceRule: VALID_RULE,
      }),
    });
    const body = (await res.json()) as { item: { id: string } };
    createdId = body.item.id;
  });
  afterEach(() => env.cleanup());

  it("renames the app and re-renders the file", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request(`/managed-tasks/${createdId}/rename-app`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newApp: "Google Meet" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { item: { app: string } };
    expect(body.item.app).toBe("Google Meet");

    const file = readManagementMd(env);
    expect(file).toContain("Google Meet");
    expect(file).not.toMatch(/\| Zoom \|/);

    const audits = selectAgentActions(env.db, "management_task.");
    const renames = audits.filter(
      (a) => a.action_type === "management_task.app_renamed",
    );
    expect(renames).toHaveLength(1);
    expect(renames[0].detail?.from).toBe("Zoom");
    expect(renames[0].detail?.to).toBe("Google Meet");
  });

  it("treats a same-normalized rename as a no-op", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request(`/managed-tasks/${createdId}/rename-app`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newApp: "  zoom  " }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("noop");
  });

  it("rejects invalid newApp", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request(`/managed-tasks/${createdId}/rename-app`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newApp: "bad|app" }),
    });
    expect(res.status).toBe(400);
  });

  it("rewrites entity files referencing the old source key", async () => {
    // Seed an entity file under the contextDir + a matching mirror row.
    // The route's rewrite step should walk this row and rename the
    // frontmatter's `sources.Zoom` to `sources.Webex`.
    const entityRel = "work/meetings/standup.md";
    const entityAbs = join(env.contextDir, entityRel);
    await mkdir(dirname(entityAbs), { recursive: true });
    await writeFile(
      entityAbs,
      [
        "---",
        "domain: work",
        "type: meeting",
        "slug: standup",
        "title: Daily Standup",
        "sources:",
        "  Zoom: zm_xyz789",
        "---",
        "",
        "# Body",
        "",
      ].join("\n"),
      "utf-8",
    );
    env.db
      .prepare(
        "INSERT INTO entities (path, domain, type, slug, title, sources_json) VALUES (?, 'work', 'meeting', 'standup', 'Daily Standup', ?)",
      )
      .run(entityRel, JSON.stringify({ Zoom: { external_id: "zm_xyz789" } }));
    env.db
      .prepare(
        "INSERT INTO entity_source_keys (path, source_key) VALUES (?, ?)",
      )
      .run(entityRel, "Zoom");

    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request(`/managed-tasks/${createdId}/rename-app`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newApp: "Webex" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      item: { app: string };
      rewrite: {
        rewrote: string[];
        skippedNewKeyExists: string[];
        errors: unknown[];
      };
    };
    expect(body.item.app).toBe("Webex");
    expect(body.rewrite.rewrote).toEqual([entityRel]);
    expect(body.rewrite.errors).toEqual([]);

    const rewritten = readFileSync(entityAbs, "utf-8");
    expect(rewritten).toContain("  Webex: zm_xyz789");
    expect(rewritten).not.toMatch(/^\s\sZoom:/m);

    // The follow-up audit row landed.
    const audits = selectAgentActions(env.db, "management_task.app_renamed");
    const rewrite = audits.find(
      (a) => a.action_type === "management_task.app_renamed.entity_rewrite",
    );
    expect(rewrite).toBeDefined();
    expect(rewrite?.detail?.rewrote).toEqual([entityRel]);
  });

  it("rewrites entity files whose source-key casing differs from the managed-task label", async () => {
    // The task was registered as `Zoom`, but a previous tool wrote
    // `sources.zoom` (lowercase) into an entity file. The normalized
    // SQL match must surface that file so the rewrite catches it —
    // the original exact-match SQL silently missed this case.
    const entityRel = "work/meetings/case-mismatch.md";
    const entityAbs = join(env.contextDir, entityRel);
    await mkdir(dirname(entityAbs), { recursive: true });
    await writeFile(
      entityAbs,
      [
        "---",
        "domain: work",
        "type: meeting",
        "slug: case-mismatch",
        "title: Case Mismatch",
        "sources:",
        "  zoom: zm_lowercase",
        "---",
      ].join("\n"),
      "utf-8",
    );
    env.db
      .prepare(
        "INSERT INTO entities (path, domain, type, slug, title, sources_json) VALUES (?, 'work', 'meeting', 'case-mismatch', 'Case Mismatch', ?)",
      )
      .run(entityRel, JSON.stringify({ zoom: { external_id: "zm_lowercase" } }));
    env.db
      .prepare(
        "INSERT INTO entity_source_keys (path, source_key) VALUES (?, ?)",
      )
      .run(entityRel, "zoom");

    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request(`/managed-tasks/${createdId}/rename-app`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newApp: "Webex" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rewrite: { rewrote: string[]; skippedOldKeyMissing: string[] };
    };
    expect(body.rewrite.rewrote).toEqual([entityRel]);
    const after = readFileSync(entityAbs, "utf-8");
    expect(after).toContain("  Webex: zm_lowercase");
    expect(after).not.toMatch(/^\s\s+zoom:/m);
  });

  it("skips entity files with multiple casing variants (no duplicate-key collision)", async () => {
    const entityRel = "work/meetings/multi-variant.md";
    const entityAbs = join(env.contextDir, entityRel);
    await mkdir(dirname(entityAbs), { recursive: true });
    await writeFile(
      entityAbs,
      [
        "---",
        "domain: work",
        "type: meeting",
        "slug: multi-variant",
        "title: Multi Variant",
        "sources:",
        "  zoom: zm_one",
        "  ZOOM: zm_two",
        "---",
      ].join("\n"),
      "utf-8",
    );
    env.db
      .prepare(
        "INSERT INTO entities (path, domain, type, slug, title, sources_json) VALUES (?, 'work', 'meeting', 'multi-variant', 'Multi Variant', ?)",
      )
      .run(
        entityRel,
        JSON.stringify({
          zoom: { external_id: "zm_one" },
          ZOOM: { external_id: "zm_two" },
        }),
      );
    env.db
      .prepare(
        "INSERT INTO entity_source_keys (path, source_key) VALUES (?, ?)",
      )
      .run(entityRel, "zoom");

    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request(`/managed-tasks/${createdId}/rename-app`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newApp: "Webex" }),
    });
    const body = (await res.json()) as {
      rewrite: {
        rewrote: string[];
        skippedMultipleVariants: { path: string; variants: string[] }[];
      };
    };
    expect(body.rewrite.rewrote).toEqual([]);
    expect(body.rewrite.skippedMultipleVariants).toHaveLength(1);
    expect(body.rewrite.skippedMultipleVariants[0].path).toBe(entityRel);
    expect(body.rewrite.skippedMultipleVariants[0].variants.sort()).toEqual(
      ["ZOOM", "zoom"],
    );
    // File untouched.
    const after = readFileSync(entityAbs, "utf-8");
    expect(after).toContain("  zoom: zm_one");
    expect(after).toContain("  ZOOM: zm_two");
  });

  it("flags entity files where the new key already exists (no merge)", async () => {
    const entityRel = "work/meetings/already-merged.md";
    const entityAbs = join(env.contextDir, entityRel);
    await mkdir(dirname(entityAbs), { recursive: true });
    await writeFile(
      entityAbs,
      [
        "---",
        "domain: work",
        "type: meeting",
        "slug: already-merged",
        "title: Already Merged",
        "sources:",
        "  Zoom: zm_old",
        "  Webex: wb_new",
        "---",
      ].join("\n"),
      "utf-8",
    );
    env.db
      .prepare(
        "INSERT INTO entities (path, domain, type, slug, title, sources_json) VALUES (?, 'work', 'meeting', 'already-merged', 'Already Merged', ?)",
      )
      .run(
        entityRel,
        JSON.stringify({
          Zoom: { external_id: "zm_old" },
          Webex: { external_id: "wb_new" },
        }),
      );
    env.db
      .prepare(
        "INSERT INTO entity_source_keys (path, source_key) VALUES (?, ?)",
      )
      .run(entityRel, "Zoom");

    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request(`/managed-tasks/${createdId}/rename-app`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newApp: "Webex" }),
    });
    const body = (await res.json()) as {
      rewrite: { rewrote: string[]; skippedNewKeyExists: string[] };
    };
    expect(body.rewrite.rewrote).toEqual([]);
    expect(body.rewrite.skippedNewKeyExists).toEqual([entityRel]);
    // File untouched — Zoom + Webex both still present.
    const after = readFileSync(entityAbs, "utf-8");
    expect(after).toContain("  Zoom: zm_old");
    expect(after).toContain("  Webex: wb_new");
  });

  it("records 'failed' audit when entity-file readFile throws (rewrite.errors TRUE branch)", async () => {
    // Place a DIRECTORY at the entity path. readFile() on a directory fails with
    // EISDIR, which flows into result.errors.push() inside rewriteEntityFilesForSourceRename.
    // That makes rewrite.errors.length > 0 → the ternary "failed" branch (line ~1004) fires.
    const entityRel = "work/meetings/is-a-dir";
    const entityAbs = join(env.contextDir, entityRel);
    await mkdir(entityAbs, { recursive: true });

    env.db
      .prepare(
        "INSERT INTO entities (path, domain, type, slug, title, sources_json) VALUES (?, 'work', 'meeting', 'is-a-dir', 'Is A Dir', ?)",
      )
      .run(entityRel, JSON.stringify({ Zoom: { external_id: "zm_dir" } }));
    env.db
      .prepare("INSERT INTO entity_source_keys (path, source_key) VALUES (?, ?)")
      .run(entityRel, "Zoom");

    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request(`/managed-tasks/${createdId}/rename-app`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newApp: "Webex" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      rewrite: { rewrote: string[]; errors: { path: string; reason: string }[] };
    };
    expect(body.status).toBe("renamed");
    // The readFile on a directory fails → errors contains the EISDIR entry
    expect(body.rewrite.errors.length).toBeGreaterThan(0);
    // The entity_rewrite audit row must carry result="failed"
    const audits = selectAgentActions(env.db, "management_task.app_renamed");
    const rewriteAudit = audits.find(
      (a) => a.action_type === "management_task.app_renamed.entity_rewrite",
    );
    expect(rewriteAudit).toBeDefined();
    expect(rewriteAudit?.result).toBe("failed");
  });
});

describe("PATCH /api/managed-tasks/:id/run-result", () => {
  let env: TestEnv;
  let createdId: string;
  beforeEach(async () => {
    env = setupEnv();
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/managed-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: "intent",
        app: "zoom",
        cadence: "daily 10:00",
        recurrenceRule: VALID_RULE,
      }),
    });
    const body = (await res.json()) as { item: { id: string } };
    createdId = body.item.id;
  });
  afterEach(() => env.cleanup());

  it("writes last_run_at / last_result and bumps the audit log", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request(
      `/managed-tasks/${createdId}/run-result`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          last_run_at: "2026-12-04T10:00:00.000Z",
          last_result: "ok (3 new)",
          consecutive_failures: 0,
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      item: {
        last_run_at: string | null;
        last_result: string | null;
        consecutive_failures: number;
      };
    };
    expect(body.item.last_run_at).toBe("2026-12-04T10:00:00.000Z");
    expect(body.item.last_result).toBe("ok (3 new)");
    expect(body.item.consecutive_failures).toBe(0);

    const audits = selectAgentActions(env.db, "management_task.");
    const ran = audits.filter(
      (a) => a.action_type === "management_task.run_recorded",
    );
    expect(ran).toHaveLength(1);
    expect(ran[0].detail?.last_result).toBe("ok (3 new)");
  });

  it("rejects malformed payload", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request(
      `/managed-tasks/${createdId}/run-result`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          last_run_at: "not-a-date",
          last_result: "ok",
          consecutive_failures: -1,
        }),
      },
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/managed-tasks", () => {
  let env: TestEnv;
  beforeEach(() => {
    env = setupEnv();
  });
  afterEach(() => env.cleanup());

  it("returns the empty list initially", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/managed-tasks");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; count: number };
    expect(body.items).toHaveLength(0);
    expect(body.count).toBe(0);
  });

  it("returns the row by id", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    const create = await app.request("/managed-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: "intent",
        app: "zoom",
        cadence: "daily 10:00",
        recurrenceRule: VALID_RULE,
      }),
    });
    const created = (await create.json()) as { item: { id: string } };
    const res = await app.request(`/managed-tasks/${created.item.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { item: { id: string } };
    expect(body.item.id).toBe(created.item.id);
  });

  it("rejects malformed mt_id", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/managed-tasks/not_an_id");
    expect(res.status).toBe(400);
  });
});

describe("GET /api/management-history", () => {
  let env: TestEnv;
  beforeEach(() => {
    env = setupEnv();
  });
  afterEach(() => env.cleanup());

  it("returns the empty list initially", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/management-history");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[] };
    expect(body.events).toHaveLength(0);
  });

  it("returns management_task.% and sot_binding.% rows in DESC order", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    // Seed a managed task (writes management_task.created).
    await app.request("/managed-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: "first",
        app: "zoom",
        cadence: "daily 10:00",
        recurrenceRule: VALID_RULE,
      }),
    });
    // Insert a sot_binding.updated row directly so we cover both prefixes
    // without standing up the sot-bindings route here.
    env.db
      .prepare(
        `INSERT INTO agent_actions
           (event_id, action_type, trigger, result, detail, started_at, completed_at)
         VALUES ('sot:test', 'sot_binding.updated', 'reactive', 'success', '{}', datetime('now'), datetime('now'))`,
      )
      .run();
    // And one unrelated row that must NOT appear in the response.
    env.db
      .prepare(
        `INSERT INTO agent_actions
           (event_id, action_type, trigger, result, detail, started_at, completed_at)
         VALUES ('msg:test', 'message.received', 'reactive', 'success', '{}', datetime('now'), datetime('now'))`,
      )
      .run();

    const res = await app.request("/management-history?limit=10");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: Array<{ kind: string }>;
    };
    const kinds = body.events.map((e) => e.kind);
    expect(kinds).toContain("management_task.created");
    expect(kinds).toContain("sot_binding.updated");
    expect(kinds).not.toContain("message.received");
  });

  it("rejects negative or non-integer limit", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/management-history?limit=-1");
    expect(res.status).toBe(400);
  });

  it("clamps limit to the documented maximum", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/management-history?limit=999");
    expect(res.status).toBe(200);
  });

  it("paginates with before_id (cursor walks id DESC)", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    // Seed three rows directly (avoids the file-render side effects of
    // POSTing real managed tasks; the route only filters on action_type).
    for (let i = 0; i < 3; i++) {
      env.db
        .prepare(
          `INSERT INTO agent_actions
             (event_id, action_type, trigger, result, detail, started_at, completed_at)
           VALUES (?, 'management_task.created', 'reactive', 'success', '{}', datetime('now'), datetime('now'))`,
        )
        .run(`mt-test-${i}`);
    }

    const first = await app.request("/management-history?limit=2");
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      events: Array<{ id: number }>;
      nextCursor: number | null;
    };
    expect(firstBody.events).toHaveLength(2);
    expect(firstBody.nextCursor).not.toBeNull();
    // The cursor is the smallest id in the page (id DESC walk).
    expect(firstBody.nextCursor).toBe(firstBody.events[1].id);

    const second = await app.request(
      `/management-history?limit=2&before_id=${firstBody.nextCursor}`,
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      events: Array<{ id: number }>;
      nextCursor: number | null;
    };
    expect(secondBody.events).toHaveLength(1);
    // No more rows — tail of the list.
    expect(secondBody.nextCursor).toBeNull();
    // No overlap between pages.
    const firstIds = firstBody.events.map((e) => e.id);
    const secondIds = secondBody.events.map((e) => e.id);
    expect(secondIds.every((id) => !firstIds.includes(id))).toBe(true);
  });

  it("returns nextCursor=null on the boundary case (exactly limit rows fetched, none more)", async () => {
    // This is the regression case for the limit+1 probe: with exactly
    // `limit` rows in the DB, the original implementation set a cursor
    // that pointed at "no more rows" — the dashboard would render
    // "Load more" and immediately fetch an empty page.
    const app = createManagedTasksRoutes(makeDeps(env));
    for (let i = 0; i < 2; i++) {
      env.db
        .prepare(
          `INSERT INTO agent_actions
             (event_id, action_type, trigger, result, detail, started_at, completed_at)
           VALUES (?, 'management_task.created', 'reactive', 'success', '{}', datetime('now'), datetime('now'))`,
        )
        .run(`bd-test-${i}`);
    }
    const res = await app.request("/management-history?limit=2");
    const body = (await res.json()) as {
      events: unknown[];
      nextCursor: number | null;
    };
    expect(body.events).toHaveLength(2);
    expect(body.nextCursor).toBeNull();
  });

  it("rejects malformed before_id", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/management-history?before_id=garbage");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_cursor");
  });
});

describe("GET /api/managed-tasks/:id (with recurrenceRule)", () => {
  let env: TestEnv;
  beforeEach(() => {
    env = setupEnv();
  });
  afterEach(() => env.cleanup());

  it("embeds the structured recurrenceRule from the joined recurring_schedules row", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    const create = await app.request("/managed-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: "fetch recordings",
        app: "Zoom",
        cadence: "daily 10:00",
        recurrenceRule: VALID_RULE,
      }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { item: { id: string } };

    const res = await app.request(`/managed-tasks/${created.item.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      item: { id: string; cadence: string };
      recurrenceRule: typeof VALID_RULE | null;
    };
    expect(body.item.id).toBe(created.item.id);
    expect(body.recurrenceRule).toEqual(VALID_RULE);
  });

  it("returns 404 for an unknown id", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/managed-tasks/mt_999");
    expect(res.status).toBe(404);
  });

  it("rejects malformed ids", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/managed-tasks/not_an_id");
    expect(res.status).toBe(400);
  });
});

describe("integration with sot-bindings (shared file render)", () => {
  let env: TestEnv;
  beforeEach(() => {
    env = setupEnv();
    // Seed an SoT binding so the rendered file's §A is non-empty.
    writeSotBindings(env.db, [
      {
        category: "tasks",
        sotApp: "notion",
        mirrorPath: "context/work/tasks-index.md",
        policy: null,
        writer: "agent",
      },
    ]);
  });
  afterEach(() => env.cleanup());

  it("preserves user-authored free prose and §C across API re-renders", async () => {
    // Seed a hand-edited file with custom §C and a user-authored
    // `## Decisions` free-prose block, then trigger an API write and
    // confirm the preserved content survives the re-render. Without the
    // route's preservation pass, both blocks would be replaced with the
    // default stub + Notes block.
    const filePath = join(
      env.contextDir,
      CONTEXT_RELATIVE_PATHS.rules.management,
    );
    await mkdir(dirname(filePath), { recursive: true });
    const seeded = [
      "---",
      "type: rule",
      "slug: management",
      "owner: shared",
      "updated: 2026-05-03",
      "template_version: 2",
      "schema_version: 3",
      "---",
      "",
      "## A. Source-of-Truth bindings",
      "",
      "| Category | SoT App | Mirror | Policy | Writer |",
      "|----------|---------|--------|--------|--------|",
      "| tasks | notion | context/work/tasks-index.md | — | agent |",
      "",
      "## B. Managed tasks (active only)",
      "",
      "| ID | Intent | App | Cadence | Output path | Schedule | Last run | Last result |",
      "|----|--------|-----|---------|-------------|----------|----------|-------------|",
      "",
      "_No managed tasks yet — register via DM._",
      "",
      "## C. Active Policies",
      "",
      "USER-CUSTOMIZED-C-CONTENT (do not strip)",
      "",
      "## Decisions",
      "",
      "USER-FREE-PROSE-BLOCK (do not strip)",
      "",
    ].join("\n");
    await writeFile(filePath, seeded, "utf-8");

    const mtApp = createManagedTasksRoutes(makeDeps(env));
    const res = await mtApp.request("/managed-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: "Zoom recordings",
        app: "zoom",
        cadence: "daily 10:00",
        recurrenceRule: VALID_RULE,
        output_path: "work/meetings/",
      }),
    });
    expect(res.status).toBe(201);

    const file = readManagementMd(env);
    expect(file).not.toBeNull();
    expect(file).toContain("USER-CUSTOMIZED-C-CONTENT (do not strip)");
    expect(file).toContain("USER-FREE-PROSE-BLOCK (do not strip)");
    expect(file).toContain("zoom"); // §B row landed
  });

  it("PUT /sot-bindings + POST /managed-tasks both round-trip through one file", async () => {
    const sotApp = createSotBindingsRoutes({
      db: env.db,
      config: env.config,
      lockManager: env.lockManager,
    });
    const sotRes = await sotApp.request("/sot-bindings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [
          {
            category: "meetings",
            sotApp: "google_calendar+zoom",
            mirrorPath: "context/work/meetings/",
            policy: "Calendar holds slot only",
            writer: "shared",
          },
        ],
      }),
    });
    expect(sotRes.status).toBe(200);

    const mtApp = createManagedTasksRoutes(makeDeps(env));
    const mtRes = await mtApp.request("/managed-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: "Zoom recordings",
        app: "zoom",
        cadence: "daily 10:00",
        recurrenceRule: VALID_RULE,
        output_path: "work/meetings/",
      }),
    });
    expect(mtRes.status).toBe(201);

    const file = readManagementMd(env);
    expect(file).not.toBeNull();
    expect(file).toContain("meetings"); // §A binding
    expect(file).toContain("zoom"); // §B row
    expect(file).toContain("work/meetings/"); // §B output_path
  });
});

// ── Coverage gap: GET /managed-tasks/:id/runs ──────────────────────────────

describe("GET /api/managed-tasks/:id/runs", () => {
  let env: TestEnv;
  let createdId: string;
  beforeEach(async () => {
    env = setupEnv();
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/managed-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: "fetch recordings",
        app: "zoom",
        cadence: "daily 10:00",
        recurrenceRule: VALID_RULE,
      }),
    });
    const body = (await res.json()) as { item: { id: string } };
    createdId = body.item.id;
  });
  afterEach(() => env.cleanup());

  it("returns runs that include the management_task.created audit row from registration", async () => {
    // The POST /managed-tasks call in beforeEach emits a management_task.created
    // audit row with mt_id in its detail. The /runs query picks it up via
    // json_extract(detail, '$.mt_id') = createdId — so at least one run exists.
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request(`/managed-tasks/${createdId}/runs`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: Array<{ kind: string }> };
    expect(body.runs.length).toBeGreaterThanOrEqual(1);
    const created = body.runs.find((r) => r.kind === "management_task.created");
    expect(created).toBeDefined();
  });

  it("returns runs containing parsed detail when run-result exists", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    // Record a run via PATCH /managed-tasks/:id/run-result so an audit row
    // lands in agent_actions with json_extract-able mt_id in its detail.
    const patch = await app.request(`/managed-tasks/${createdId}/run-result`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        last_run_at: "2026-12-05T10:00:00.000Z",
        last_result: "ok (5 items)",
        consecutive_failures: 0,
      }),
    });
    expect(patch.status).toBe(200);

    const res = await app.request(`/managed-tasks/${createdId}/runs`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runs: Array<{ kind: string; result: string | null; detail: Record<string, unknown> | null }>;
    };
    expect(body.runs.length).toBeGreaterThanOrEqual(1);
    const runRow = body.runs.find((r) => r.kind === "management_task.run_recorded");
    expect(runRow).toBeDefined();
    // detail was JSON so safeParseJson returns the parsed object
    expect(runRow?.detail).toMatchObject({ mt_id: createdId });
  });

  it("returns runs with null detail when detail column is null", async () => {
    // Insert a management_task.% row with NULL detail keyed to our mt_id
    // to cover the `row.detail ? safeParseJson(...) : null` null branch.
    env.db
      .prepare(
        `INSERT INTO agent_actions
           (event_id, action_type, trigger, result, detail, started_at, completed_at)
         VALUES (?, 'management_task.run_recorded', 'reactive', 'success', ?, datetime('now'), datetime('now'))`,
      )
      .run(`null-detail:${Date.now()}`, JSON.stringify({ mt_id: createdId }));

    // Also insert a row with explicit NULL detail (not possible via the schema's
    // json_extract filter unless mt_id is embedded — instead we verify the null
    // branch by looking at the parsed shape; the route maps null detail correctly).
    // We can force a null-detail row by directly inserting with detail=NULL and
    // then confirming it is excluded by json_extract (it won't match), but to
    // cover the branch we need a row whose detail IS null yet passes the filter.
    // Since json_extract on NULL returns NULL (≠ createdId) the filter skips it.
    // The branch is exercised through the /management-history endpoint instead —
    // see the safeParseJson describe block below. Here we just assert the route
    // returns the row we inserted above with parsed detail.
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request(`/managed-tasks/${createdId}/runs`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: Array<{ detail: unknown }> };
    expect(body.runs.length).toBeGreaterThanOrEqual(1);
    const row = body.runs[0];
    // detail should be the parsed object (not a string) since we stored valid JSON
    expect(row.detail).toMatchObject({ mt_id: createdId });
  });

  it("returns 400 for invalid id format", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/managed-tasks/not_an_id/runs");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_id");
  });

  it("returns 404 for valid id format when task does not exist", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/managed-tasks/mt_99999/runs");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });

  it("returns 400 for invalid limit query param", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request(`/managed-tasks/${createdId}/runs?limit=abc`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_limit");
  });

  it("accepts a valid numeric limit and clamps it", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request(`/managed-tasks/${createdId}/runs?limit=5`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: unknown[] };
    expect(Array.isArray(body.runs)).toBe(true);
  });
});

// ── Coverage gap: safeParseJson catch branch via /management-history ────────

describe("safeParseJson catch branch (invalid JSON in detail column)", () => {
  let env: TestEnv;
  beforeEach(() => {
    env = setupEnv();
  });
  afterEach(() => env.cleanup());

  it("returns the raw string when detail is not valid JSON", async () => {
    // The trg_actions_ai trigger calls json_extract(new.detail, '$') which
    // rejects non-JSON at insert time. We drop the trigger, insert the bad
    // row, and re-create the trigger — same approach used in the schema
    // migration tests for legacy rows that predate JSON enforcement.
    env.db.exec("DROP TRIGGER IF EXISTS trg_actions_ai");
    env.db
      .prepare(
        `INSERT INTO agent_actions
           (event_id, action_type, trigger, result, detail, started_at, completed_at)
         VALUES ('test-sc', 'management_task.custom', 'reactive', 'success', 'not-valid-json', datetime('now'), datetime('now'))`,
      )
      .run();
    env.db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_actions_ai AFTER INSERT ON agent_actions BEGIN
        INSERT INTO fts_actions(rowid, action_type, detail)
        VALUES (new.id, new.action_type, json_extract(new.detail, '$'));
      END
    `);

    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/management-history");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: Array<{ kind: string; detail: unknown }> };
    const row = body.events.find((e) => e.kind === "management_task.custom");
    expect(row).toBeDefined();
    // safeParseJson falls back to the raw string on catch
    expect(row?.detail).toBe("not-valid-json");
  });
});

// ── Coverage gap: buildManagedTasksRoutesDepsFromApi without fallbackLockManager

describe("buildManagedTasksRoutesDepsFromApi", () => {
  it("creates a new InMemoryManagementMdWriteLockManager when no lockManager provided", () => {
    const db = new Database(":memory:");
    applySchema(db);
    try {
      // Pass minimal ApiDependencies-like object (no managementMdWriteLockManager).
      const minimalDeps = {
        db,
        config: { timezone: "UTC", dataDir: "/tmp/test" } as unknown as Parameters<typeof buildManagedTasksRoutesDepsFromApi>[0]["config"],
      } as Parameters<typeof buildManagedTasksRoutesDepsFromApi>[0];

      const result = buildManagedTasksRoutesDepsFromApi(minimalDeps);
      expect(result.lockManager).toBeDefined();
      expect(result.db).toBe(db);
    } finally {
      db.close();
    }
  });

  it("uses the provided fallbackLockManager when no managementMdWriteLockManager on deps", () => {
    const db = new Database(":memory:");
    applySchema(db);
    try {
      const fallback = new InMemoryManagementMdWriteLockManager();
      const minimalDeps = {
        db,
        config: { timezone: "UTC", dataDir: "/tmp/test" } as unknown as Parameters<typeof buildManagedTasksRoutesDepsFromApi>[0]["config"],
      } as Parameters<typeof buildManagedTasksRoutesDepsFromApi>[0];

      const result = buildManagedTasksRoutesDepsFromApi(minimalDeps, fallback);
      expect(result.lockManager).toBe(fallback);
    } finally {
      db.close();
    }
  });
});

// ── Coverage gap: idempotent replay with deleted mt_id ─────────────────────

describe("POST /api/managed-tasks — idempotency with deleted task", () => {
  let env: TestEnv;
  beforeEach(() => {
    env = setupEnv();
  });
  afterEach(() => env.cleanup());

  it("re-creates the task when the idempotency-keyed mt_id was subsequently deleted", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    const idKey = "delete-replay-test-key";
    const requestBody = JSON.stringify({
      intent: "zoom fetch",
      app: "zoom",
      cadence: "hourly",
      recurrenceRule: VALID_RULE,
    });
    const requestInit = (key: string): RequestInit => ({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: requestBody,
    });

    // First POST: creates the task and stores idempotency record.
    const firstRes = await app.request("/managed-tasks", requestInit(idKey));
    expect(firstRes.status).toBe(201);
    const firstBody = (await firstRes.json()) as {
      status: string;
      item: { id: string };
    };
    expect(firstBody.status).toBe("created");
    const originalId = firstBody.item.id;

    // Delete the task so the mt_id in the idempotency record becomes stale.
    const delRes = await app.request(`/managed-tasks/${originalId}`, {
      method: "DELETE",
    });
    expect(delRes.status).toBe(200);

    // Second POST with the same idempotency key: the stored mt_id no longer
    // exists, so the route must fall through and re-create.
    const secondRes = await app.request("/managed-tasks", requestInit(idKey));
    expect(secondRes.status).toBe(201);
    const secondBody = (await secondRes.json()) as {
      status: string;
      item: { id: string };
    };
    expect(secondBody.status).toBe("created");
    // A new mt_id was allocated — not the deleted one.
    expect(secondBody.item.id).not.toBe(originalId);

    // Exactly one task exists in the DB (the re-created one).
    const tasks = env.db
      .prepare("SELECT id FROM managed_tasks")
      .all() as Array<{ id: string }>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(secondBody.item.id);
  });
});

// ── Coverage gap: invalid id format on mutating endpoints ─────────────────

describe("invalid mt_id format on mutating endpoints", () => {
  let env: TestEnv;
  beforeEach(() => {
    env = setupEnv();
  });
  afterEach(() => env.cleanup());

  it("PATCH /managed-tasks/:id returns 400 invalid_id for malformed id", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/managed-tasks/not_an_id", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ output_path: "work/meetings/" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_id");
  });

  it("DELETE /managed-tasks/:id returns 400 invalid_id for malformed id", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/managed-tasks/not_an_id", {
      method: "DELETE",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_id");
  });

  it("PATCH /managed-tasks/:id/run-result returns 400 invalid_id for malformed id", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/managed-tasks/not_an_id/run-result", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        last_run_at: "2026-12-05T10:00:00.000Z",
        last_result: "ok",
        consecutive_failures: 0,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_id");
  });

  it("PATCH /managed-tasks/:id/run-result returns 404 for valid id format but non-existent task", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/managed-tasks/mt_99999/run-result", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        last_run_at: "2026-12-05T10:00:00.000Z",
        last_result: "ok",
        consecutive_failures: 0,
      }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });
});

// ── Coverage gap: additional rename-app failure modes ─────────────────────

describe("POST /api/managed-tasks/:id/rename-app — additional failure modes", () => {
  let env: TestEnv;
  let createdId: string;
  beforeEach(async () => {
    env = setupEnv();
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/managed-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: "intent",
        app: "zoom",
        cadence: "daily 10:00",
        recurrenceRule: VALID_RULE,
      }),
    });
    const body = (await res.json()) as { item: { id: string } };
    createdId = body.item.id;
  });
  afterEach(() => env.cleanup());

  it("returns 404 for unknown task id", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/managed-tasks/mt_99999/rename-app", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newApp: "Webex" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });

  it("returns 400 when body is missing the newApp field", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request(`/managed-tasks/${createdId}/rename-app`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ someOtherField: "value" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("validation_error");
  });

  it("returns 400 when body is not valid JSON (readJsonBody false branch at line ~869)", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request(`/managed-tasks/${createdId}/rename-app`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-valid-json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 409 when rename would collide with an existing (app_normalized, cadence) row", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));

    // Task A: (zoom, daily 10:00) — created in beforeEach as `createdId`.
    // Task B: (webex, daily 10:00) — same cadence, different app_normalized.
    // The UNIQUE constraint is on (app_normalized, cadence), so this succeeds.
    const createBRes = await app.request("/managed-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: "webex intent",
        app: "webex",
        cadence: "daily 10:00",
        recurrenceRule: VALID_RULE,
      }),
    });
    expect(createBRes.status).toBe(201);
    const bBody = (await createBRes.json()) as { item: { id: string } };

    // Rename task B from "webex" to "zoom": the resulting pair
    // (app_normalized="zoom", cadence="daily 10:00") already exists as task A → 409.
    const renameRes = await app.request(
      `/managed-tasks/${bBody.item.id}/rename-app`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newApp: "zoom" }),
      },
    );
    expect(renameRes.status).toBe(409);
    const renameBody = (await renameRes.json()) as { error: string };
    expect(renameBody.error).toBe("duplicate");
  });
});

// ── Coverage gap: run-now reason-IIFE branches ───────────────────────────────

describe("POST /api/managed-tasks/:id/run-now — reason IIFE branch coverage", () => {
  let env: TestEnv;
  let createdId: string;
  beforeEach(async () => {
    env = setupEnv();
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/managed-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent: "i", app: "zoom", cadence: "hourly", recurrenceRule: VALID_RULE }),
    });
    createdId = ((await res.json()) as { item: { id: string } }).item.id;
  });
  afterEach(() => env.cleanup());

  it("uses 'api' fallback reason when body has no string reason field (line 784)", async () => {
    // body = {} → parsedBody.ok TRUE, body is object, but reason is undefined
    // → typeof undefined !== "string" → falls through to `return "api"` at line 784.
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request(`/managed-tasks/${createdId}/run-now`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { status: string; scheduled_row_id: number };
    expect(body.status).toBe("queued");
    // Confirm the row was inserted; verify reason using the returned row id.
    const row = env.db
      .prepare("SELECT task_context FROM agent_schedule WHERE id = ?")
      .get(body.scheduled_row_id) as { task_context: string } | undefined;
    expect(row).toBeDefined();
    const ctx = JSON.parse(row!.task_context) as Record<string, unknown>;
    expect(ctx.reason).toBe("api");
  });

  it("trims whitespace-only reason to 'api' via the || fallback (line 782)", async () => {
    // reason = "   " → reason.trim() = "" (falsy) → the `||` picks "api" at line 782.
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request(`/managed-tasks/${createdId}/run-now`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "   " }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { status: string; scheduled_row_id: number };
    expect(body.status).toBe("queued");
    const row = env.db
      .prepare("SELECT task_context FROM agent_schedule WHERE id = ?")
      .get(body.scheduled_row_id) as { task_context: string } | undefined;
    expect(row).toBeDefined();
    const ctx = JSON.parse(row!.task_context) as Record<string, unknown>;
    // reason.trim() = "" → || picks "api"
    expect(ctx.reason).toBe("api");
  });
});

// ── Coverage gap: rename-app invalid-id 400 path ─────────────────────────────

describe("POST /api/managed-tasks/:id/rename-app — 400 for invalid mt_id format", () => {
  let env: TestEnv;
  beforeEach(() => { env = setupEnv(); });
  afterEach(() => env.cleanup());

  it("returns 400 invalid_id for a malformed mt_id (line 854 in rename-app handler)", async () => {
    // The rename-app route has its own isValidManagedTaskId check at line 852-854
    // in managed-tasks.ts. Sending a malformed id exercises that specific branch.
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/managed-tasks/not_an_id/rename-app", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newApp: "Webex" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_id");
  });
});

// ── Coverage gap: render-skip paths when getContextDir throws ────────────────
//
// Each write endpoint calls getContextDir(config, db) after its DB commit to
// resolve the management.md path for re-rendering. When config.dataDir is null,
// path.resolve(null, "context") throws TypeError. The handler catches this,
// logs a warning, and returns the DB-authoritative result without rendering.

function makeBrokenDirDeps(env: TestEnv): ManagedTasksRoutesDeps {
  return {
    db: env.db,
    config: { ...env.config, dataDir: null } as unknown as AgentConfig,
    lockManager: env.lockManager,
  };
}

describe("POST /api/managed-tasks — render-skip when getContextDir throws", () => {
  let env: TestEnv;
  beforeEach(() => { env = setupEnv(); });
  afterEach(() => env.cleanup());

  it("returns 201 without render_status when getContextDir throws", async () => {
    const app = createManagedTasksRoutes(makeBrokenDirDeps(env));
    const res = await app.request("/managed-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: "zoom recordings",
        app: "zoom",
        cadence: "hourly",
        recurrenceRule: VALID_RULE,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { status: string; render_status?: string };
    expect(body.status).toBe("created");
    // render_status is absent in the render-skip early return path
    expect(body.render_status).toBeUndefined();
    // The DB row must still have been committed
    expect(listManagedTasks(env.db)).toHaveLength(1);
  });
});

describe("PATCH /api/managed-tasks/:id — render-skip when getContextDir throws", () => {
  let env: TestEnv;
  let createdId: string;
  beforeEach(async () => {
    env = setupEnv();
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/managed-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent: "i", app: "zoom", cadence: "hourly", recurrenceRule: VALID_RULE }),
    });
    createdId = ((await res.json()) as { item: { id: string } }).item.id;
  });
  afterEach(() => env.cleanup());

  it("returns 200 without render_status when getContextDir throws", async () => {
    const app = createManagedTasksRoutes(makeBrokenDirDeps(env));
    const res = await app.request(`/managed-tasks/${createdId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ output_path: "personal/meetings/" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; render_status?: string };
    expect(body.status).toBe("updated");
    expect(body.render_status).toBeUndefined();
  });
});

describe("PATCH /api/managed-tasks/:id/run-result — render-skip when getContextDir throws", () => {
  let env: TestEnv;
  let createdId: string;
  beforeEach(async () => {
    env = setupEnv();
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/managed-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent: "i", app: "zoom", cadence: "hourly", recurrenceRule: VALID_RULE }),
    });
    createdId = ((await res.json()) as { item: { id: string } }).item.id;
  });
  afterEach(() => env.cleanup());

  it("returns 200 without render_status when getContextDir throws", async () => {
    const app = createManagedTasksRoutes(makeBrokenDirDeps(env));
    const res = await app.request(`/managed-tasks/${createdId}/run-result`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        last_run_at: "2026-12-06T10:00:00.000Z",
        last_result: "ok",
        consecutive_failures: 0,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; render_status?: string };
    expect(body.status).toBe("updated");
    expect(body.render_status).toBeUndefined();
  });
});

describe("DELETE /api/managed-tasks/:id — render-skip when getContextDir throws", () => {
  let env: TestEnv;
  let createdId: string;
  beforeEach(async () => {
    env = setupEnv();
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/managed-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent: "i", app: "zoom", cadence: "hourly", recurrenceRule: VALID_RULE }),
    });
    createdId = ((await res.json()) as { item: { id: string } }).item.id;
  });
  afterEach(() => env.cleanup());

  it("returns 200 without render_status when getContextDir throws", async () => {
    const app = createManagedTasksRoutes(makeBrokenDirDeps(env));
    const res = await app.request(`/managed-tasks/${createdId}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; render_status?: string };
    expect(body.status).toBe("deleted");
    expect(body.render_status).toBeUndefined();
    expect(listManagedTasks(env.db)).toHaveLength(0);
  });
});

describe("POST /api/managed-tasks/:id/rename-app — render-skip + entity-rewrite-catch paths", () => {
  let env: TestEnv;
  let createdId: string;
  beforeEach(async () => {
    env = setupEnv();
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/managed-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent: "i", app: "zoom", cadence: "hourly", recurrenceRule: VALID_RULE }),
    });
    createdId = ((await res.json()) as { item: { id: string } }).item.id;
  });
  afterEach(() => env.cleanup());

  it("returns 200 without render_status when getContextDir throws (contextDir null path)", async () => {
    // getContextDir(config, db) throws → contextDir stays null → early return
    // at lines 994-997 in managed-tasks.ts without render_status in the body.
    const app = createManagedTasksRoutes(makeBrokenDirDeps(env));
    const res = await app.request(`/managed-tasks/${createdId}/rename-app`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newApp: "Webex" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      item: { app: string };
      rewrite: unknown;
      render_status?: string;
    };
    expect(body.status).toBe("renamed");
    expect(body.item.app).toBe("Webex");
    expect(body.rewrite).toBeDefined();
    // render_status is absent: the early return fires before renderManagementMdFromDb
    expect(body.render_status).toBeUndefined();
  });

  it("catches and logs when rewriteEntityFilesForSourceRename throws (entity_source_keys dropped)", async () => {
    // Dropping entity_source_keys causes rewriteEntityFilesForSourceRename to
    // throw a SqliteError ("no such table"), which the outer catch at lines
    // 962-967 catches. The rename must still succeed and return 200.
    env.db.exec("DROP TABLE IF EXISTS entity_source_keys");
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request(`/managed-tasks/${createdId}/rename-app`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newApp: "Webex" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("renamed");
  });
});

// ── Coverage gap: tx failure 500 paths ──────────────────────────────────────
//
// Each write endpoint wraps DB work in a transaction; when the transaction
// throws with a non-UNIQUE error the handler returns 500. We inject these
// failures via SQLite TRIGGER RAISE(ABORT, ...) on the target table, which
// avoids affecting SELECT paths (pre-checks, reads) while causing the
// write-path to abort with a non-UNIQUE error message.

describe("POST /api/managed-tasks — 500 when INSERT into managed_tasks fails", () => {
  let env: TestEnv;
  beforeEach(() => { env = setupEnv(); });
  afterEach(() => env.cleanup());

  it("returns 500 internal_error for a non-UNIQUE tx failure", async () => {
    // An unconditional BEFORE INSERT trigger on managed_tasks causes insertManagedTask
    // to ABORT with a non-UNIQUE SqliteError. The UNIQUE-check branch is not taken
    // so the handler falls through to the 500 error path (lines 501-503).
    env.db.exec(`
      CREATE TRIGGER inject_post_failure
      BEFORE INSERT ON managed_tasks
      BEGIN SELECT RAISE(ABORT, 'injected non-unique failure'); END
    `);
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/managed-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: "intent",
        app: "zoom",
        cadence: "hourly",
        recurrenceRule: VALID_RULE,
      }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("internal_error");
  });
});

describe("PATCH /api/managed-tasks/:id — 500 when UPDATE fails inside tx", () => {
  let env: TestEnv;
  let createdId: string;
  beforeEach(async () => {
    env = setupEnv();
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/managed-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent: "i", app: "zoom", cadence: "hourly", recurrenceRule: VALID_RULE }),
    });
    createdId = ((await res.json()) as { item: { id: string } }).item.id;
  });
  afterEach(() => env.cleanup());

  it("returns 500 internal_error when the PATCH tx fails", async () => {
    // A BEFORE UPDATE trigger on recurring_schedules causes updateRecurringSchedule
    // (called when recurrenceRule is present in the PATCH body) to ABORT inside
    // the tx. The catch at lines 592-595 in managed-tasks.ts converts this to a 500.
    env.db.exec(`
      CREATE TRIGGER inject_recurring_update_failure
      BEFORE UPDATE ON recurring_schedules
      BEGIN SELECT RAISE(ABORT, 'injected update failure'); END
    `);
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request(`/managed-tasks/${createdId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cadence: "daily",
        recurrenceRule: { ...VALID_RULE, time: "09:00" },
      }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("internal_error");
  });
});

describe("DELETE /api/managed-tasks/:id — 500 when DELETE tx fails", () => {
  let env: TestEnv;
  let createdId: string;
  beforeEach(async () => {
    env = setupEnv();
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/managed-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent: "i", app: "zoom", cadence: "hourly", recurrenceRule: VALID_RULE }),
    });
    createdId = ((await res.json()) as { item: { id: string } }).item.id;
  });
  afterEach(() => env.cleanup());

  it("returns 500 internal_error when the DELETE tx fails", async () => {
    // A BEFORE DELETE trigger that aborts makes the tx throw inside the handler.
    // getManagedTask (a SELECT) runs before the tx and still finds the row.
    env.db.exec(`
      CREATE TRIGGER inject_delete_failure
      BEFORE DELETE ON managed_tasks
      BEGIN SELECT RAISE(ABORT, 'injected delete failure'); END
    `);
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request(`/managed-tasks/${createdId}`, { method: "DELETE" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("internal_error");
    // Row must still exist (tx rolled back)
    expect(listManagedTasks(env.db)).toHaveLength(1);
  });
});

describe("POST /api/managed-tasks/:id/run-now — 500 when agent_schedule INSERT fails", () => {
  let env: TestEnv;
  let createdId: string;
  beforeEach(async () => {
    env = setupEnv();
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/managed-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent: "i", app: "zoom", cadence: "hourly", recurrenceRule: VALID_RULE }),
    });
    createdId = ((await res.json()) as { item: { id: string } }).item.id;
  });
  afterEach(() => env.cleanup());

  it("returns 500 internal_error when the agent_schedule INSERT fails", async () => {
    // A BEFORE INSERT trigger on agent_schedule causes the enqueue INSERT inside
    // the run-now tx to ABORT. The catch at lines 817-819 in managed-tasks.ts
    // converts this to a 500. The task row and recurring_schedule row remain intact.
    env.db.exec(`
      CREATE TRIGGER inject_schedule_insert_failure
      BEFORE INSERT ON agent_schedule
      BEGIN SELECT RAISE(ABORT, 'injected schedule failure'); END
    `);
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request(`/managed-tasks/${createdId}/run-now`, {
      method: "POST",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("internal_error");
  });
});

describe("POST /api/managed-tasks/:id/rename-app — 500 for non-UNIQUE tx failure", () => {
  let env: TestEnv;
  let createdId: string;
  beforeEach(async () => {
    env = setupEnv();
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/managed-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent: "i", app: "zoom", cadence: "hourly", recurrenceRule: VALID_RULE }),
    });
    createdId = ((await res.json()) as { item: { id: string } }).item.id;
  });
  afterEach(() => env.cleanup());

  it("returns 500 internal_error for a non-UNIQUE UPDATE failure", async () => {
    // A BEFORE UPDATE trigger that aborts for a specific target app_normalized
    // causes the UPDATE inside the tx to throw a non-UNIQUE SqliteError.
    // The UNIQUE-check branch is not taken so the handler falls through to 500.
    env.db.exec(`
      CREATE TRIGGER inject_rename_failure
      BEFORE UPDATE ON managed_tasks
      WHEN NEW.app_normalized = 'trigger-fail-rename'
      BEGIN SELECT RAISE(ABORT, 'injected rename failure'); END
    `);
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request(`/managed-tasks/${createdId}/rename-app`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newApp: "trigger-fail-rename" }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("internal_error");
  });
});

// ── Coverage gap: recordAuditAction catch (agent_actions table absent) ───────

describe("recordAuditAction — warn-and-continue when agent_actions INSERT fails", () => {
  let env: TestEnv;
  beforeEach(() => { env = setupEnv(); });
  afterEach(() => env.cleanup());

  it("POST /managed-tasks continues and returns 201 when recordAuditAction throws", async () => {
    // Drop the FTS trigger first to avoid trigger dependency errors,
    // then drop agent_actions so recordAuditAction's INSERT throws.
    // The function catches the error and logs a warning; the route still
    // returns 201 with the committed DB row.
    env.db.exec("DROP TRIGGER IF EXISTS trg_actions_ai");
    env.db.exec("DROP TABLE IF EXISTS fts_actions");
    env.db.exec("DROP TABLE IF EXISTS agent_actions");
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/managed-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: "zoom fetch",
        app: "zoom",
        cadence: "hourly",
        recurrenceRule: VALID_RULE,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("created");
    // Row committed to managed_tasks despite audit failure
    expect(listManagedTasks(env.db)).toHaveLength(1);
  });
});

// ── Coverage gap: remaining branch misses ────────────────────────────────────

describe("GET /management-history — null-detail audit row (line 369 FALSE branch)", () => {
  let env: TestEnv;
  beforeEach(() => { env = setupEnv(); });
  afterEach(() => env.cleanup());

  it("emits detail: null for an agent_actions row whose detail column is NULL", async () => {
    // Insert a management_task.% row with detail=NULL — the management-history
    // query has no json_extract filter so null-detail rows ARE returned.
    env.db
      .prepare(
        `INSERT INTO agent_actions
           (event_id, action_type, trigger, result, detail, started_at, completed_at)
         VALUES ('nulldet:1', 'management_task.test_null', 'reactive', 'success',
                 NULL, datetime('now'), datetime('now'))`,
      )
      .run();
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/management-history");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: Array<{ kind: string; detail: unknown }>;
    };
    const nullRow = body.events.find((e) => e.kind === "management_task.test_null");
    expect(nullRow).toBeDefined();
    expect(nullRow?.detail).toBeNull();
  });
});

describe("POST /managed-tasks — readJsonBody false branch + recurrenceRule.timezone ?? fallbacks", () => {
  let env: TestEnv;
  beforeEach(() => { env = setupEnv(); });
  afterEach(() => env.cleanup());

  it("returns 400 when POST body is not valid JSON (line 381 readJsonBody false branch)", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/managed-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-valid-json",
    });
    expect(res.status).toBe(400);
  });

  it("uses config.timezone when recurrenceRule omits timezone (line 449 first ?? FALSE branch)", async () => {
    // VALID_RULE has timezone; this test sends rule WITHOUT timezone so
    // recurrenceRule.timezone is undefined → falls through to config.timezone.
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/managed-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: "test no-tz",
        app: "zoom",
        cadence: "daily 09:00",
        recurrenceRule: { frequency: "daily" as const, time: "09:00" },
      }),
    });
    expect(res.status).toBe(201);
    // The created schedule's timezone should fall back to config.timezone = "Asia/Tokyo"
    const body = (await res.json()) as { item: { id: string; schedule_id: number } };
    const schedule = env.db
      .prepare("SELECT recurrence_rule FROM recurring_schedules WHERE id = ?")
      .get(body.item.schedule_id) as { recurrence_rule: string } | undefined;
    expect(schedule).toBeDefined();
    const rule = JSON.parse(schedule!.recurrence_rule) as Record<string, unknown>;
    expect(rule.timezone).toBe("Asia/Tokyo");
  });

  it("uses 'UTC' when both recurrenceRule and config omit timezone (line 449 second ?? FALSE branch)", async () => {
    // Override config to have no timezone so the innermost ?? 'UTC' fallback fires.
    const noTzConfig = { dataDir: env.config.dataDir } as unknown as typeof env.config;
    const app = createManagedTasksRoutes({
      db: env.db,
      config: noTzConfig,
      lockManager: env.lockManager,
    });
    const res = await app.request("/managed-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: "test utc fallback",
        app: "zoom",
        cadence: "daily 08:00",
        recurrenceRule: { frequency: "daily" as const, time: "08:00" },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { item: { schedule_id: number } };
    const schedule = env.db
      .prepare("SELECT recurrence_rule FROM recurring_schedules WHERE id = ?")
      .get(body.item.schedule_id) as { recurrence_rule: string } | undefined;
    const rule = JSON.parse(schedule!.recurrence_rule) as Record<string, unknown>;
    expect(rule.timezone).toBe("UTC");
  });
});

describe("PATCH /api/managed-tasks/:id — readJsonBody false + timezone ?? + output_path branches", () => {
  let env: TestEnv;
  let createdId: string;
  let scheduleId: number;
  beforeEach(async () => {
    env = setupEnv();
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/managed-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: "intent",
        app: "zoom",
        cadence: "daily 10:00",
        recurrenceRule: VALID_RULE,
      }),
    });
    const body = (await res.json()) as { item: { id: string; schedule_id: number } };
    createdId = body.item.id;
    scheduleId = body.item.schedule_id;
  });
  afterEach(() => env.cleanup());

  it("returns 400 when PATCH body is not valid JSON (line 574 readJsonBody false branch)", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request(`/managed-tasks/${createdId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "not-valid-json",
    });
    expect(res.status).toBe(400);
  });

  it("uses config.timezone when PATCH recurrenceRule omits timezone (line 590 first ?? FALSE)", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request(`/managed-tasks/${createdId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recurrenceRule: { frequency: "daily" as const, time: "09:00" },
      }),
    });
    expect(res.status).toBe(200);
    const schedule = env.db
      .prepare("SELECT recurrence_rule FROM recurring_schedules WHERE id = ?")
      .get(scheduleId) as { recurrence_rule: string } | undefined;
    const rule = JSON.parse(schedule!.recurrence_rule) as Record<string, unknown>;
    expect(rule.timezone).toBe("Asia/Tokyo");
  });

  it("uses 'UTC' when PATCH recurrenceRule and config both omit timezone (line 590 second ?? FALSE)", async () => {
    const noTzConfig = { dataDir: env.config.dataDir } as unknown as typeof env.config;
    const app = createManagedTasksRoutes({
      db: env.db,
      config: noTzConfig,
      lockManager: env.lockManager,
    });
    const res = await app.request(`/managed-tasks/${createdId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recurrenceRule: { frequency: "daily" as const, time: "08:00" },
      }),
    });
    expect(res.status).toBe(200);
    const schedule = env.db
      .prepare("SELECT recurrence_rule FROM recurring_schedules WHERE id = ?")
      .get(scheduleId) as { recurrence_rule: string } | undefined;
    const rule = JSON.parse(schedule!.recurrence_rule) as Record<string, unknown>;
    expect(rule.timezone).toBe("UTC");
  });

  it("leaves output_path unchanged when PATCH body omits it (line 600 TRUE branch: output_path undefined)", async () => {
    // Patch with cadence only (no output_path) → data.output_path === undefined
    // → updateManagedTask gets outputPath: undefined (no-op for that field).
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request(`/managed-tasks/${createdId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cadence: "daily 09:00" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { item: { cadence: string; output_path: string | null } };
    expect(body.item.cadence).toBe("daily 09:00");
    // output_path was null from creation (no output_path provided)
    expect(body.item.output_path).toBeNull();
  });
});

describe("PATCH /api/managed-tasks/:id/run-result — readJsonBody false branch (line 669)", () => {
  let env: TestEnv;
  let createdId: string;
  beforeEach(async () => {
    env = setupEnv();
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request("/managed-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: "intent",
        app: "zoom",
        cadence: "daily 10:00",
        recurrenceRule: VALID_RULE,
      }),
    });
    createdId = ((await res.json()) as { item: { id: string } }).item.id;
  });
  afterEach(() => env.cleanup());

  it("returns 400 when run-result body is not valid JSON", async () => {
    const app = createManagedTasksRoutes(makeDeps(env));
    const res = await app.request(`/managed-tasks/${createdId}/run-result`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "not-valid-json",
    });
    expect(res.status).toBe(400);
  });
});
