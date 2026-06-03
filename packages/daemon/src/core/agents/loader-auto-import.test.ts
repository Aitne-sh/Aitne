import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { applySchema } from "../../db/schema.js";
import { getAgent, listAgents } from "../../db/agents-store.js";
import {
  loadAgents,
  type AgentLoadOptions,
  type RecurringAgentRow,
  type RecurringSchedulePort,
} from "./loader.js";

/**
 * §6.5 — first-boot auto-import of orphan `recurring_schedules` rows into user
 * Agent files, idempotent on YAML existence (Q9).
 *
 * `agents.recurring_schedule_id` carries a FK to `recurring_schedules`, so the
 * test ports back every row id with a real `recurring_schedules` row — the
 * loader links the freshly-imported Agent to it.
 */

let db: Database.Database;
let tmpRoot: string;
let builtinDir: string;
let userDir: string;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  tmpRoot = mkdtempSync(join(tmpdir(), "agents-import-"));
  builtinDir = join(tmpRoot, "builtin");
  userDir = join(tmpRoot, "user");
  mkdirSync(builtinDir, { recursive: true });
  mkdirSync(userDir, { recursive: true });
});

afterEach(() => {
  db.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** Insert a real recurring_schedules row so the agents FK resolves. */
function insertRecurring(id: number): void {
  db.prepare(
    "INSERT INTO recurring_schedules (id, task_type, recurrence_rule) VALUES (?, 'agent.task', '{}')",
  ).run(id);
}

function makeRow(over: Partial<RecurringAgentRow> = {}): RecurringAgentRow {
  return {
    id: 1,
    enabled: true,
    taskType: "agent.task",
    description: "Nightly cleanup",
    prompt: null,
    model: null,
    tier: null,
    backendId: null,
    recurrence: { frequency: "daily", time: "09:00", timezone: "America/New_York" },
    taskContext: {},
    ...over,
  };
}

/** A port backed by real recurring_schedules rows for the given orphan rows. */
function backedPort(rows: RecurringAgentRow[]): { port: RecurringSchedulePort; createdCount: () => number } {
  const map = new Map<number, RecurringAgentRow>();
  for (const r of rows) {
    insertRecurring(r.id);
    map.set(r.id, r);
  }
  const state = { created: 0 };
  const port: RecurringSchedulePort = {
    list: () => [...map.values()],
    get: (id) => map.get(id) ?? null,
    create: () => {
      state.created += 1;
      const res = db
        .prepare("INSERT INTO recurring_schedules (task_type, recurrence_rule) VALUES ('agent.task', '{}')")
        .run();
      return Number(res.lastInsertRowid);
    },
    update: () => {},
  };
  return { port, createdCount: () => state.created };
}

function options(over: Partial<AgentLoadOptions> = {}): AgentLoadOptions {
  return { builtinDir, userDir, dayBoundaryHour: 4, timezone: "UTC", ...over };
}

describe("loadAgents: auto-import", () => {
  it("writes a user file + creates a row for an orphan recurring schedule", () => {
    const { port } = backedPort([makeRow({ id: 42, description: "Nightly cleanup" })]);
    loadAgents(db, options({ recurring: port }));

    const filePath = join(userDir, "imported-42", "agent.md");
    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("slug: imported-42");
    expect(content).toContain("kind: user");

    const row = getAgent(db, "imported-42")!;
    expect(row.source).toBe("user");
    expect(row.recurringScheduleId).toBe(42);
    expect(row.enabled).toBe(true);
  });

  it("is idempotent: a second boot re-imports nothing", () => {
    const { port } = backedPort([makeRow({ id: 42 })]);
    loadAgents(db, options({ recurring: port }));
    const firstCount = listAgents(db, { source: "user" }).length;

    loadAgents(db, options({ recurring: port }));
    const secondCount = listAgents(db, { source: "user" }).length;
    expect(secondCount).toBe(firstCount);
    expect(
      listAgents(db, { source: "user" }).filter((a) => a.slug === "imported-42"),
    ).toHaveLength(1);
  });

  it("does not overwrite an existing imported file for an unreferenced row", () => {
    // A prior import left a file on disk, but no agents row references row 99
    // yet (auto-import runs before the scan that would create it). The existing
    // file must be left untouched (existsSync → continue, §6.5 idempotency).
    const dir = join(userDir, "imported-99");
    mkdirSync(dir, { recursive: true });
    const original =
      "---\nslug: imported-99\nname: Manual\ndescription: kept\nkind: user\n"
      + "schedule:\n  kind: cron\n  expression: \"0 9 * * *\"\n  timezone: UTC\n"
      + "backend:\n  process_key: agent.task\nlimits: {}\n---\n\nkept body\n";
    writeFileSync(join(dir, "agent.md"), original, "utf-8");
    const { port } = backedPort([makeRow({ id: 99 })]);
    loadAgents(db, options({ recurring: port }));
    expect(readFileSync(join(dir, "agent.md"), "utf-8")).toBe(original);
  });

  it("skips a managed-tasks-owned row (task_context.mt_id)", () => {
    const { port } = backedPort([makeRow({ id: 50, taskContext: { mt_id: "mt-7" } })]);
    loadAgents(db, options({ recurring: port }));
    expect(existsSync(join(userDir, "imported-50", "agent.md"))).toBe(false);
    expect(getAgent(db, "imported-50")).toBeNull();
  });

  it("skips a setup morning-briefing seed (dm_session)", () => {
    const { port } = backedPort([makeRow({ id: 51, taskType: "dm_session" })]);
    loadAgents(db, options({ recurring: port }));
    expect(existsSync(join(userDir, "imported-51", "agent.md"))).toBe(false);
    expect(getAgent(db, "imported-51")).toBeNull();
  });

  it("skips an automation-trigger row (task_context.triggerSource)", () => {
    const { port } = backedPort([
      makeRow({ id: 52, taskContext: { triggerSource: "automation_trigger" } }),
    ]);
    loadAgents(db, options({ recurring: port }));
    expect(existsSync(join(userDir, "imported-52", "agent.md"))).toBe(false);
    expect(getAgent(db, "imported-52")).toBeNull();
  });

  it("skips a recurring row already referenced by an Agent", () => {
    insertRecurring(7);
    db.prepare(
      `INSERT INTO agents (id, name, source, definition_path, definition_hash, enabled,
         process_key, schedule_kind, schedule_expression, schedule_timezone, recurring_schedule_id,
         created_at, updated_at)
       VALUES ('existing', 'Existing', 'user', '/x/agent.md', 'h', 1,
         'agent.task', 'cron', '0 9 * * *', 'UTC', 7, 1, 1)`,
    ).run();
    const map = new Map<number, RecurringAgentRow>([[7, makeRow({ id: 7 })]]);
    const port: RecurringSchedulePort = {
      list: () => [...map.values()],
      get: (id) => map.get(id) ?? null,
      create: () => 0,
      update: () => {},
    };
    loadAgents(db, options({ recurring: port }));
    expect(existsSync(join(userDir, "imported-7", "agent.md"))).toBe(false);
  });

  it("falls back to slug + default text when the recurring row has no description", () => {
    const { port } = backedPort([makeRow({ id: 9, description: "", prompt: null })]);
    loadAgents(db, options({ recurring: port }));
    const content = readFileSync(join(userDir, "imported-9", "agent.md"), "utf-8");
    expect(content).toContain("name: imported-9");
    expect(content).toContain("Imported recurring schedule 9");
    expect(content).toContain("Imported on first boot from recurring schedule 9");
    expect(getAgent(db, "imported-9")!.name).toBe("imported-9");
  });

  it("emits frontmatter with backend pins + prompt body when present", () => {
    const { port } = backedPort([
      makeRow({
        id: 5,
        tier: "lite",
        model: "claude-haiku-4-5",
        backendId: "claude",
        prompt: "Do the nightly thing.",
        recurrence: { frequency: "weekly", time: "21:00", timezone: "UTC", daysOfWeek: [0] },
      }),
    ]);
    loadAgents(db, options({ recurring: port }));
    const content = readFileSync(join(userDir, "imported-5", "agent.md"), "utf-8");
    expect(content).toContain("tier: lite");
    expect(content).toContain("model: claude-haiku-4-5");
    expect(content).toContain("backend_id: claude");
    expect(content).toContain("Do the nightly thing.");
    expect(content).toContain("0 21 * * 0"); // weekly Sunday
  });

  it("uses the description body when the recurring row's prompt is blank", () => {
    const { port } = backedPort([makeRow({ id: 11, prompt: "   ", description: "Nightly cleanup" })]);
    loadAgents(db, options({ recurring: port }));
    const content = readFileSync(join(userDir, "imported-11", "agent.md"), "utf-8");
    expect(content).toContain("Nightly cleanup");
  });

  it("degrades to a warning (Error) when the recurring port throws", () => {
    const port: RecurringSchedulePort = {
      list: () => {
        throw new Error("db is down");
      },
      get: () => null,
      create: () => 0,
      update: () => {},
    };
    const result = loadAgents(db, options({ recurring: port }));
    expect(result.warnings.join()).toMatch(/auto-import failed: db is down/);
    expect(getAgent(db, "morning-routine")).not.toBeNull();
  });

  it("degrades to a warning (non-Error throw) when the port throws a string", () => {
    const port: RecurringSchedulePort = {
      list: () => {
        throw "boom";
      },
      get: () => null,
      create: () => 0,
      update: () => {},
    };
    const result = loadAgents(db, options({ recurring: port }));
    expect(result.warnings.join()).toMatch(/auto-import failed: boom/);
  });
});
