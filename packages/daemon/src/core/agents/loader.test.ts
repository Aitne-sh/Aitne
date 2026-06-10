import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import yaml from "js-yaml";
import { agentDefinitionSchema, type AgentDefinition } from "@aitne/shared";
import { applySchema } from "../../db/schema.js";
import {
  getAgent,
  listAgents,
  setEnabled,
  upsertAgent,
  type AgentDTO,
} from "../../db/agents-store.js";
import {
  getBuiltinRegistryEntry,
  BUILTIN_AGENT_REGISTRY,
} from "./builtin-registry.js";
import {
  AgentEnabledCache,
  findAbsoluteBlockOverlap,
  loadAgents,
  resolveEnabled,
  resolveScheduleExpression,
  resolveTimezone,
  scanAgentDir,
  synthesizeRegistryDefinition,
  validateDefinition,
  type AgentLoadOptions,
  type RecurringAgentRow,
  type RecurringSchedulePort,
} from "./loader.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

let db: Database.Database;
let builtinDir: string;
let userDir: string;
let tmpRoot: string;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  tmpRoot = mkdtempSync(join(tmpdir(), "agents-loader-"));
  builtinDir = join(tmpRoot, "builtin");
  userDir = join(tmpRoot, "user");
  mkdirSync(builtinDir, { recursive: true });
  mkdirSync(userDir, { recursive: true });
});

afterEach(() => {
  db.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function baseOptions(over: Partial<AgentLoadOptions> = {}): AgentLoadOptions {
  return {
    builtinDir,
    userDir,
    dayBoundaryHour: 4,
    timezone: "America/New_York",
    ...over,
  };
}

function writeAgentFile(
  root: string,
  slug: string,
  frontmatter: Record<string, unknown>,
  body = "Built-in routine pointer.",
): string {
  const dir = join(root, slug);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "agent.md");
  writeFileSync(path, `---\n${yaml.dump(frontmatter)}---\n\n${body}\n`, "utf-8");
  return path;
}

function builtinFrontmatter(slug: string, over: Record<string, unknown> = {}) {
  const entry = getBuiltinRegistryEntry(slug)!;
  return {
    slug,
    name: entry.name,
    description: entry.description,
    kind: "builtin",
    schedule: {
      kind: "cron",
      expression: entry.cronExpression
        ? entry.cronExpression({ dayBoundaryHour: 4 })
        : "0 * * * *",
    },
    backend: { process_key: entry.processKey },
    limits: { max_turns: 20, max_budget_usd: 0.25, timeout_minutes: 10 },
    stop_warning: entry.stopWarning,
    ...over,
  };
}

function userFrontmatter(slug: string, over: Record<string, unknown> = {}) {
  return {
    slug,
    name: "User Agent",
    description: "A user-authored agent.",
    kind: "user",
    schedule: { kind: "cron", expression: "0 21 * * 0", timezone: "America/New_York" },
    backend: { process_key: "agent.task" },
    limits: { max_turns: 12, max_budget_usd: 0.1, timeout_minutes: 8 },
    ...over,
  };
}

function userDef(over: Record<string, unknown> = {}): AgentDefinition {
  return agentDefinitionSchema.parse(userFrontmatter("my-agent", over));
}

function builtinDef(slug: string, over: Record<string, unknown> = {}): AgentDefinition {
  return agentDefinitionSchema.parse(builtinFrontmatter(slug, over));
}

function makeRow(over: Partial<RecurringAgentRow> = {}): RecurringAgentRow {
  return {
    id: 1,
    enabled: true,
    taskType: "agent.task",
    description: "Imported task",
    prompt: null,
    model: null,
    tier: null,
    backendId: null,
    recurrence: { frequency: "daily", time: "09:00", timezone: "America/New_York" },
    taskContext: {},
    ...over,
  };
}

// `agents.recurring_schedule_id` has a FK to recurring_schedules, so the port
// backs every id with a real row: pre-seeded ids are inserted up-front, and
// create() inserts a fresh recurring_schedules row and returns its real rowid.
function fakePort(initial: RecurringAgentRow[] = []) {
  const map = new Map<number, RecurringAgentRow>();
  for (const r of initial) {
    db.prepare(
      "INSERT INTO recurring_schedules (id, task_type, recurrence_rule) VALUES (?, 'agent.task', '{}')",
    ).run(r.id);
    map.set(r.id, r);
  }
  const created: Array<{ id: number; input: unknown }> = [];
  const updated: Array<{ id: number; patch: unknown }> = [];
  const port: RecurringSchedulePort = {
    list: () => [...map.values()],
    get: (id) => map.get(id) ?? null,
    create: (input) => {
      const res = db
        .prepare("INSERT INTO recurring_schedules (task_type, recurrence_rule) VALUES ('agent.task', '{}')")
        .run();
      const id = Number(res.lastInsertRowid);
      map.set(id, makeRow({ id, ...input }));
      created.push({ id, input });
      return id;
    },
    update: (id, patch) => {
      updated.push({ id, patch });
      const existing = map.get(id);
      if (existing) map.set(id, { ...existing, ...patch });
    },
  };
  return { port, created, updated, map };
}

// ── Pure helpers ──────────────────────────────────────────────────────────

describe("scanAgentDir", () => {
  it("returns [] for a missing root", () => {
    expect(scanAgentDir(join(tmpRoot, "nope"), "user")).toEqual([]);
  });

  it("returns one entry per <slug>/agent.md, skipping bare files and empty dirs", () => {
    writeAgentFile(userDir, "has-file", userFrontmatter("has-file"));
    mkdirSync(join(userDir, "empty-dir"), { recursive: true });
    writeFileSync(join(userDir, "stray.txt"), "x", "utf-8");
    const scanned = scanAgentDir(userDir, "user");
    expect(scanned.map((s) => s.slug)).toEqual(["has-file"]);
    expect(scanned[0]).toMatchObject({ source: "user" });
  });
});

describe("resolveTimezone", () => {
  it("prefers the YAML timezone", () => {
    expect(resolveTimezone("Asia/Tokyo", "America/New_York")).toBe("Asia/Tokyo");
  });
  it("falls back to the config timezone", () => {
    expect(resolveTimezone(undefined, "America/New_York")).toBe("America/New_York");
    expect(resolveTimezone("", "America/New_York")).toBe("America/New_York");
  });
  it("falls back to the system zone when both are empty", () => {
    expect(resolveTimezone(undefined, "").length).toBeGreaterThan(0);
  });
});

describe("resolveScheduleExpression", () => {
  it("substitutes a cron placeholder", () => {
    const def = builtinDef("morning-routine", {
      schedule: { kind: "cron", expression: "0 {dayBoundaryHour} * * *" },
    });
    expect(resolveScheduleExpression(def, 4)).toBe("0 4 * * *");
  });
  it("returns null for a cron schedule with no expression (defensive)", () => {
    const def = { schedule: { kind: "cron" } } as unknown as AgentDefinition;
    expect(resolveScheduleExpression(def, 4)).toBeNull();
  });
  it("returns the one_shot timestamp", () => {
    const withTs = { schedule: { kind: "one_shot", one_shot_at: "2026-01-01T00:00:00Z" } } as unknown as AgentDefinition;
    expect(resolveScheduleExpression(withTs, 4)).toBe("2026-01-01T00:00:00Z");
    const noTs = { schedule: { kind: "one_shot" } } as unknown as AgentDefinition;
    expect(resolveScheduleExpression(noTs, 4)).toBeNull();
  });
  it("returns the event ref", () => {
    const withRef = { schedule: { kind: "event", event_ref: "push.failed" } } as unknown as AgentDefinition;
    expect(resolveScheduleExpression(withRef, 4)).toBe("push.failed");
    const noRef = { schedule: { kind: "event" } } as unknown as AgentDefinition;
    expect(resolveScheduleExpression(noRef, 4)).toBeNull();
  });
});

describe("resolveEnabled", () => {
  const existing = (enabled: boolean, overriddenAt: number | null): AgentDTO =>
    ({ enabled, enabledOverriddenAt: overriddenAt }) as unknown as AgentDTO;
  it("uses the base value when there is no row", () => {
    expect(resolveEnabled(true, null, 100)).toBe(true);
  });
  it("uses the base value when there is no dashboard override", () => {
    expect(resolveEnabled(false, existing(true, null), 100)).toBe(false);
  });
  it("keeps the dashboard override when it is newer than the file", () => {
    expect(resolveEnabled(true, existing(false, 200), 100)).toBe(false);
  });
  it("lets the file win when it is newer than the override", () => {
    expect(resolveEnabled(true, existing(false, 50), 100)).toBe(true);
  });
});

describe("findAbsoluteBlockOverlap", () => {
  it("returns null for a clean allow-list", () => {
    expect(findAbsoluteBlockOverlap(["Read", "Bash", "WebFetch"])).toBeNull();
    expect(findAbsoluteBlockOverlap(["Read(notes.md)"])).toBeNull();
  });
  it("flags an exact bare-tool match", () => {
    expect(findAbsoluteBlockOverlap(["CronCreate"])).toBe("CronCreate");
  });
  it("flags a Tool(arg) entry that classifies as an absolute block", () => {
    expect(findAbsoluteBlockOverlap(["Bash(rm -rf /tmp/x)"])).toBe("Bash(rm -rf /tmp/x)");
    expect(findAbsoluteBlockOverlap(["Read(.env)"])).toBe("Read(.env)");
  });
});

describe("synthesizeRegistryDefinition", () => {
  it("builds a schema-valid definition from a cron entry", () => {
    const def = synthesizeRegistryDefinition(getBuiltinRegistryEntry("evening-review")!, 4);
    expect(def.kind).toBe("builtin");
    expect(def.schedule.expression).toBe("0 18 * * *");
    expect(def.enabled).toBe(true);
    expect(def.backend.tier).toBeNull();
    expect(def.stop_warning).toBeDefined();
  });
  it("uses the fallback cron for the runtime-window hourly-check", () => {
    const def = synthesizeRegistryDefinition(getBuiltinRegistryEntry("hourly-check")!, 4);
    expect(def.schedule.expression).toBe("0 * * * *");
  });
  it("honours monthly-review's OFF-by-default", () => {
    const def = synthesizeRegistryDefinition(getBuiltinRegistryEntry("monthly-review")!, 4);
    expect(def.enabled).toBe(false);
  });
});

describe("validateDefinition", () => {
  it("accepts a valid user definition", () => {
    expect(validateDefinition(userDef(), "user", "my-agent", {}, [])).toBeNull();
  });
  it("rejects a slug/dir mismatch", () => {
    expect(validateDefinition(userDef(), "user", "other", {}, [])).toMatch(/does not match directory/);
  });
  it("rejects a kind/location mismatch", () => {
    expect(
      validateDefinition(builtinDef("evening-review"), "user", "evening-review", {}, []),
    ).toMatch(/does not match its location/);
  });
  it("rejects a built-in slug not in the registry", () => {
    const def = agentDefinitionSchema.parse({
      slug: "not-a-builtin",
      name: "X",
      description: "d",
      kind: "builtin",
      schedule: { kind: "cron", expression: "0 4 * * *" },
      backend: { process_key: "routine.morning_routine" },
      limits: {},
      stop_warning: { level: "normal", services_lost: ["x"] },
    });
    expect(validateDefinition(def, "builtin", "not-a-builtin", {}, [])).toMatch(
      /not in BUILTIN_AGENT_REGISTRY/,
    );
  });
  it("rejects an unknown process_key", () => {
    const def = userDef();
    def.backend.process_key = "not.a.process.key";
    expect(validateDefinition(def, "user", "my-agent", {}, [])).toMatch(/not a known ProcessKey/);
  });
  it("accepts a custom-routine process_key", () => {
    const def = userDef();
    def.backend.process_key = "routine.custom.my-routine";
    expect(validateDefinition(def, "user", "my-agent", {}, [])).toBeNull();
  });
  it("accepts a null process_key (no-LLM built-in pass)", () => {
    expect(
      validateDefinition(builtinDef("roadmap-maintenance"), "builtin", "roadmap-maintenance", {}, []),
    ).toBeNull();
  });
  it("rejects tools.allowed that overlaps the absolute-block layer", () => {
    const def = userDef();
    def.tools.allowed = ["Bash(rm -rf /x)"];
    expect(validateDefinition(def, "user", "my-agent", {}, [])).toMatch(/overlaps the absolute-block/);
  });
  it("warns (non-fatal) when a codex agent declares extra tools", () => {
    const def = userDef();
    def.backend.backend_id = "codex";
    def.tools.allowed = ["Read"];
    const warnings: string[] = [];
    expect(validateDefinition(def, "user", "my-agent", {}, warnings)).toBeNull();
    expect(warnings.join()).toMatch(/codex backend cannot enforce/);
  });
  it("warns for an unknown skill but stays valid", () => {
    const def = userDef();
    def.tools.skills = ["known", "ghost"];
    const warnings: string[] = [];
    const res = validateDefinition(
      def,
      "user",
      "my-agent",
      { listSkillSlugs: () => new Set(["known"]) },
      warnings,
    );
    expect(res).toBeNull();
    expect(warnings.join()).toMatch(/unknown skill "ghost"/);
    expect(warnings.join()).not.toMatch(/"known"/);
  });
  it("rejects a malformed cron expression", () => {
    const def = userDef();
    def.schedule.expression = "0 9 * *";
    expect(validateDefinition(def, "user", "my-agent", {}, [])).toMatch(/invalid cron expression/);
  });
  it("warns on cron drift for a built-in", () => {
    const def = builtinDef("evening-review", { schedule: { kind: "cron", expression: "0 19 * * *" } });
    const warnings: string[] = [];
    expect(validateDefinition(def, "builtin", "evening-review", {}, warnings)).toBeNull();
    expect(warnings.join()).toMatch(/cron drift/);
  });
  it("does not flag drift for the null-resolver hourly-check", () => {
    const def = builtinDef("hourly-check", { schedule: { kind: "cron", expression: "30 5 * * *" } });
    const warnings: string[] = [];
    expect(validateDefinition(def, "builtin", "hourly-check", {}, warnings)).toBeNull();
    expect(warnings.join()).not.toMatch(/drift/);
  });
});

// ── loadAgents — registry fallback + built-in files ─────────────────────────

describe("loadAgents: built-ins", () => {
  it("synthesises all 10 built-ins from the registry when no files exist", () => {
    const result = loadAgents(db, baseOptions({ now: () => 1000 }));
    expect(result.upserted).toHaveLength(10);
    expect(result.warnings.filter((w) => /missing/.test(w))).toHaveLength(10);
    const rows = listAgents(db, { source: "builtin" });
    expect(rows).toHaveLength(10);
    expect(getAgent(db, "monthly-review")!.enabled).toBe(false);
    expect(getAgent(db, "morning-routine")!.enabled).toBe(true);
    expect(getAgent(db, "morning-routine")!.metadata.version_counter).toBe(1);
  });

  it("loads a valid built-in file instead of the fallback", () => {
    writeAgentFile(builtinDir, "evening-review", builtinFrontmatter("evening-review"));
    const result = loadAgents(db, baseOptions());
    expect(result.invalid).toHaveLength(0);
    const row = getAgent(db, "evening-review")!;
    expect(row.scheduleExpression).toBe("0 18 * * *");
    expect(row.scheduleTimezone).toBe("America/New_York");
  });

  it("rescues an invalid built-in file with the registry fallback", () => {
    writeAgentFile(builtinDir, "weekly-review", { not: "valid", kind: "builtin" });
    const result = loadAgents(db, baseOptions());
    expect(result.invalid.some((i) => i.slug === "weekly-review")).toBe(true);
    // Fallback still produced a working, enabled Agent.
    const row = getAgent(db, "weekly-review")!;
    expect(row.invalid).toBe(false);
    expect(row.enabled).toBe(true);
  });

  it("uses defaults for now and skips unchanged rows on reload", () => {
    loadAgents(db, baseOptions()); // default Date.now
    const before = getAgent(db, "evening-review")!.updatedAt;
    loadAgents(db, baseOptions({ now: () => before + 999_999 }));
    expect(getAgent(db, "evening-review")!.updatedAt).toBe(before);
  });

  it("emits SSE + records a snapshot on a definition change", () => {
    const emit = vi.fn();
    const record = vi.fn();
    loadAgents(db, baseOptions({ events: { emit }, snapshot: { record } }));
    expect(emit).toHaveBeenCalledWith("agent.updated", expect.objectContaining({ source: "builtin" }));
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "agent_definition_change" }),
    );
  });

  it("carries a built-in override snapshot forward through a definition change", () => {
    loadAgents(db, baseOptions({ dayBoundaryHour: 4, now: () => 1000 }));
    // Operator override stored out-of-band (the PATCH path), then a real
    // definition change (day-boundary shift moves morning-routine's cron) so
    // the reload actually rewrites the row rather than hitting the skip path.
    const seed = getAgent(db, "morning-routine")!;
    upsertAgent(db, {
      slug: "morning-routine",
      name: seed.name,
      description: seed.description,
      source: "builtin",
      definitionPath: seed.definitionPath,
      definitionHash: seed.definitionHash,
      enabled: seed.enabled,
      processKey: seed.processKey,
      scheduleKind: seed.scheduleKind,
      scheduleExpression: seed.scheduleExpression,
      scheduleTimezone: seed.scheduleTimezone,
      tags: seed.tags,
      stopWarning: seed.stopWarning,
      metadata: { version_counter: 3, override_snapshot: { "limits.max_budget_usd": 0.99 } },
    }, 1000);
    loadAgents(db, baseOptions({ dayBoundaryHour: 5, now: () => 2000 }));
    const after = getAgent(db, "morning-routine")!;
    expect(after.scheduleExpression).toBe("0 5 * * *");
    expect(after.metadata.override_snapshot).toEqual({ "limits.max_budget_usd": 0.99 });
    expect(after.metadata.version_counter).toBe(4); // bumped on the change
  });

  it("keeps a dashboard enabled-override that is newer than the file", () => {
    writeAgentFile(builtinDir, "weekly-review", builtinFrontmatter("weekly-review"));
    loadAgents(db, baseOptions());
    // Operator disables from the dashboard far in the future.
    setEnabled(db, "weekly-review", false, Date.now() + 86_400_000);
    loadAgents(db, baseOptions());
    expect(getAgent(db, "weekly-review")!.enabled).toBe(false);
  });
});

// ── loadAgents — user agents ────────────────────────────────────────────────

describe("loadAgents: user agents", () => {
  it("loads a valid user agent with no recurring pairing", () => {
    writeAgentFile(userDir, "weekly-bookmarks", userFrontmatter("weekly-bookmarks"));
    const result = loadAgents(db, baseOptions());
    expect(result.invalid).toHaveLength(0);
    const row = getAgent(db, "weekly-bookmarks")!;
    expect(row.source).toBe("user");
    expect(row.recurringScheduleId).toBeNull();
  });

  it("persists an invalid user file as a disabled row in invalid[]", () => {
    writeAgentFile(userDir, "broken", { slug: "broken", kind: "user" });
    const result = loadAgents(db, baseOptions());
    expect(result.invalid.some((i) => i.slug === "broken" && !i.collision)).toBe(true);
    const row = getAgent(db, "broken")!;
    expect(row.invalid).toBe(true);
    expect(row.enabled).toBe(false);
  });

  it("persists a file that cannot be read as invalid", () => {
    // Create agent.md as a *directory* so readFileSync throws (EISDIR).
    mkdirSync(join(userDir, "dirfile", "agent.md"), { recursive: true });
    const result = loadAgents(db, baseOptions());
    expect(
      result.invalid.some((i) => i.slug === "dirfile" && /failed to read/.test(i.error)),
    ).toBe(true);
    expect(getAgent(db, "dirfile")!.invalid).toBe(true);
  });

  it("persists a non-mapping frontmatter as invalid", () => {
    writeAgentFile(userDir, "scalar", {});
    // Overwrite with a scalar frontmatter the dump helper cannot express.
    writeFileSync(join(userDir, "scalar", "agent.md"), "---\njust-a-string\n---\nbody\n", "utf-8");
    const result = loadAgents(db, baseOptions());
    expect(result.invalid.some((i) => i.slug === "scalar")).toBe(true);
  });

  it("pairs a cron user agent with a freshly-created recurring row", () => {
    writeAgentFile(userDir, "weekly-bookmarks", userFrontmatter("weekly-bookmarks"));
    const { port, created } = fakePort();
    const result = loadAgents(db, baseOptions({ recurring: port }));
    expect(created).toHaveLength(1);
    expect(getAgent(db, "weekly-bookmarks")!.recurringScheduleId).toBe(created[0].id);
    expect(result.invalid).toHaveLength(0);
  });

  it("captures the Markdown body as the new recurring row's prompt", () => {
    writeAgentFile(
      userDir,
      "with-body",
      userFrontmatter("with-body"),
      "Summarise my unread bookmarks and DM me the top 5.",
    );
    const { port, created } = fakePort();
    loadAgents(db, baseOptions({ recurring: port }));
    expect(created).toHaveLength(1);
    expect((created[0].input as { prompt: string | null }).prompt).toBe(
      "Summarise my unread bookmarks and DM me the top 5.",
    );
  });

  it("stores a null recurring prompt when the body is blank", () => {
    writeAgentFile(userDir, "no-body", userFrontmatter("no-body"), "");
    const { port, created } = fakePort();
    loadAgents(db, baseOptions({ recurring: port }));
    expect(created).toHaveLength(1);
    expect((created[0].input as { prompt: string | null }).prompt).toBeNull();
  });

  it("does not re-sync task_prompt onto an already-paired row on reconcile", () => {
    // First boot pairs + captures the body as task_prompt; a later boot whose
    // body changed must NOT push the new body onto the recurring row (§6.1 step
    // 5 — task_prompt is owned at creation, re-sync is a v1 limitation).
    writeAgentFile(userDir, "edited", userFrontmatter("edited"), "Original prompt.");
    const { port, created, updated } = fakePort();
    loadAgents(db, baseOptions({ recurring: port }));
    expect((created[0].input as { prompt: string | null }).prompt).toBe("Original prompt.");

    writeAgentFile(userDir, "edited", userFrontmatter("edited"), "Rewritten prompt.");
    loadAgents(db, baseOptions({ recurring: port }));
    // The reconcile patch carries no `prompt` key at all.
    expect(updated.every((u) => !("prompt" in (u.patch as Record<string, unknown>)))).toBe(true);
  });

  it("reconciles an already-paired recurring row (YAML wins)", () => {
    writeAgentFile(userDir, "weekly-bookmarks", userFrontmatter("weekly-bookmarks"));
    loadAgents(db, baseOptions()); // no port → recurringScheduleId stays null
    const { port, updated } = fakePort([makeRow({ id: 7 })]); // inserts recurring 7
    setRecurringId(db, "weekly-bookmarks", 7); // FK now resolves
    loadAgents(db, baseOptions({ recurring: port }));
    expect(updated.some((u) => u.id === 7)).toBe(true);
    expect(getAgent(db, "weekly-bookmarks")!.recurringScheduleId).toBe(7);
  });

  it("creates a disabled recurring row when the user YAML is authored enabled:false (§6.4 mirror)", () => {
    writeAgentFile(userDir, "off-agent", userFrontmatter("off-agent", { enabled: false }));
    const { port, created } = fakePort();
    loadAgents(db, baseOptions({ recurring: port }));
    expect(created).toHaveLength(1);
    expect((created[0].input as { enabled: boolean }).enabled).toBe(false);
    expect(getAgent(db, "off-agent")!.enabled).toBe(false);
  });

  it("mirrors a dashboard disable onto the paired recurring row on reload — does NOT re-enable it (§6.4)", () => {
    // Regression guard: the loader used to push the raw YAML `enabled` (true)
    // onto the recurring row every boot, silently resuming a dashboard-disabled
    // Agent after a restart (the reconciler gates firing on
    // recurring_schedules.enabled, and the scheduler's enabled-gate covers only
    // built-in crons — not user-Agent recurring firings).
    writeAgentFile(userDir, "weekly-bookmarks", userFrontmatter("weekly-bookmarks"));
    const { port, created, updated } = fakePort();
    loadAgents(db, baseOptions({ recurring: port })); // boot 1: pair + create (enabled)
    expect((created[0].input as { enabled: boolean }).enabled).toBe(true);

    // Operator disables from the dashboard; the override timestamp is in the
    // future so §6.4 keeps it disabled across the file-untouched reload.
    setEnabled(db, "weekly-bookmarks", false, Date.now() + 86_400_000);

    loadAgents(db, baseOptions({ recurring: port })); // boot 2: file untouched
    expect(getAgent(db, "weekly-bookmarks")!.enabled).toBe(false);
    const lastPatch = updated.at(-1)!.patch as { enabled?: boolean };
    expect(lastPatch.enabled).toBe(false);
    // Only `enabled` diverged — the disable must NOT also churn the recurrence
    // (which would needlessly re-materialise the pending row).
    expect("recurrence" in lastPatch).toBe(false);
  });

  it("reconcile is a no-op when nothing diverged — no agent_schedule churn on an unchanged reload (§6.1 step 5)", () => {
    // Regression guard for §11.3.2 step 1: an unchanged-on-disk paired Agent
    // reloaded across a restart must not re-fire the cancel+re-materialise
    // (which would falsely tag skipReason=agent_definition_changed and could
    // drop an imminent fire). The reconcile patch must be empty → no port.update.
    writeAgentFile(userDir, "weekly-bookmarks", userFrontmatter("weekly-bookmarks"));
    const { port, updated } = fakePort();
    loadAgents(db, baseOptions({ recurring: port })); // boot 1: create
    expect(updated).toHaveLength(0);
    loadAgents(db, baseOptions({ recurring: port })); // boot 2: identical → no-op
    expect(updated).toHaveLength(0);
  });

  it("reconcile patches ONLY the diverged fields (description/model/tier/backend/recurrence)", () => {
    writeAgentFile(
      userDir,
      "weekly-bookmarks",
      userFrontmatter("weekly-bookmarks", {
        backend: { process_key: "agent.task", model: "claude-opus-4-8", tier: "high", backend_id: "claude" },
      }),
    );
    loadAgents(db, baseOptions());
    const { port, updated } = fakePort([
      makeRow({
        id: 7,
        model: "old-model",
        tier: "lite",
        backendId: "codex",
        recurrence: { frequency: "daily", time: "09:00", timezone: "America/New_York" },
      }),
    ]);
    setRecurringId(db, "weekly-bookmarks", 7);
    loadAgents(db, baseOptions({ recurring: port }));

    const patch = updated.find((u) => u.id === 7)!.patch as Record<string, unknown>;
    expect(patch.model).toBe("claude-opus-4-8");
    expect(patch.tier).toBe("high");
    expect(patch.backendId).toBe("claude");
    expect(patch.recurrence).toBeDefined(); // daily → weekly diverged
    expect(patch.description).toBe("User Agent"); // "Imported task" → "User Agent"
    // enabled matched (both true) → not patched.
    expect("enabled" in patch).toBe(false);
  });

  it("creates the recurring row with task_context.defer_in_quiet_hours for an opted-in Agent", () => {
    // QUIET_HOURS_HARDENING_PLAN.md §6 — the flag rides the recurring row's
    // task_context (the pin_to_quiet_hours_end precedent) so every materialised
    // agent_schedule row carries it for the scheduler's claim-time check.
    writeAgentFile(userDir, "dm-y", userFrontmatter("dm-y", {
      schedule: { kind: "cron", expression: "0 3 * * *", defer_in_quiet_hours: true },
    }));
    const { port, created } = fakePort();
    loadAgents(db, baseOptions({ recurring: port }));
    expect(created).toHaveLength(1);
    expect(
      (created[0].input as { taskContext: Record<string, unknown> }).taskContext,
    ).toEqual({ defer_in_quiet_hours: true });
  });

  it("creates the recurring row with an empty task_context when the flag is absent (default false)", () => {
    writeAgentFile(userDir, "silent", userFrontmatter("silent"));
    const { port, created } = fakePort();
    loadAgents(db, baseOptions({ recurring: port }));
    expect(created).toHaveLength(1);
    expect(
      (created[0].input as { taskContext: Record<string, unknown> }).taskContext,
    ).toEqual({});
  });

  it("reconciles a flag opt-in onto an existing row, preserving unrelated context keys", () => {
    writeAgentFile(userDir, "weekly-bookmarks", userFrontmatter("weekly-bookmarks", {
      name: "Imported task", // match the row so only the flag diverges
      schedule: {
        kind: "cron",
        expression: "0 9 * * *",
        timezone: "America/New_York",
        defer_in_quiet_hours: true,
      },
    }));
    loadAgents(db, baseOptions());
    const { port, updated } = fakePort([
      makeRow({ id: 7, description: "Imported task", taskContext: { keep: "me" } }),
    ]);
    setRecurringId(db, "weekly-bookmarks", 7);
    loadAgents(db, baseOptions({ recurring: port }));
    const patch = updated.find((u) => u.id === 7)!.patch as Record<string, unknown>;
    expect(patch.taskContext).toEqual({ keep: "me", defer_in_quiet_hours: true });
  });

  it("reconciles a flag opt-out by dropping the key, preserving unrelated context keys", () => {
    writeAgentFile(userDir, "weekly-bookmarks", userFrontmatter("weekly-bookmarks", {
      name: "Imported task",
      schedule: { kind: "cron", expression: "0 9 * * *", timezone: "America/New_York" },
    }));
    loadAgents(db, baseOptions());
    const { port, updated } = fakePort([
      makeRow({
        id: 7,
        description: "Imported task",
        taskContext: { keep: "me", defer_in_quiet_hours: true },
      }),
    ]);
    setRecurringId(db, "weekly-bookmarks", 7);
    loadAgents(db, baseOptions({ recurring: port }));
    const patch = updated.find((u) => u.id === 7)!.patch as Record<string, unknown>;
    expect(patch.taskContext).toEqual({ keep: "me" });
  });

  it("does not patch task_context when the flag already matches", () => {
    writeAgentFile(userDir, "weekly-bookmarks", userFrontmatter("weekly-bookmarks", {
      schedule: {
        kind: "cron",
        expression: "0 21 * * 0",
        timezone: "America/New_York",
        defer_in_quiet_hours: true,
      },
    }));
    const { port, updated } = fakePort();
    loadAgents(db, baseOptions({ recurring: port })); // boot 1: create (flag set)
    loadAgents(db, baseOptions({ recurring: port })); // boot 2: identical
    expect(
      updated.every((u) => !("taskContext" in (u.patch as Record<string, unknown>))),
    ).toBe(true);
  });

  it("recreates a paired recurring row that has vanished from the port view", () => {
    writeAgentFile(userDir, "weekly-bookmarks", userFrontmatter("weekly-bookmarks"));
    loadAgents(db, baseOptions());
    // A real recurring row exists (FK holds) but the port's view does not see
    // it (get → null), exercising the recreate fall-through.
    db.prepare(
      "INSERT INTO recurring_schedules (id, task_type, recurrence_rule) VALUES (999, 'agent.task', '{}')",
    ).run();
    setRecurringId(db, "weekly-bookmarks", 999);
    const { port, created } = fakePort([]); // get(999) → null
    loadAgents(db, baseOptions({ recurring: port }));
    expect(created).toHaveLength(1);
  });

  it("rejects a user one_shot agent as invalid (recurring-only)", () => {
    writeAgentFile(userDir, "oneshot", userFrontmatter("oneshot", {
      schedule: { kind: "one_shot", one_shot_at: "2027-01-01T00:00:00Z" },
    }));
    const { port, created } = fakePort();
    const result = loadAgents(db, baseOptions({ recurring: port }));
    // No recurring row is paired; the file lands as an invalid row whose
    // last_error points the operator at the one-shot /schedule queue.
    expect(created).toHaveLength(0);
    const row = getAgent(db, "oneshot")!;
    expect(row.invalid).toBe(true);
    expect(row.metadata.last_error).toMatch(/recurring-only/);
    expect(row.recurringScheduleId).toBeNull();
    expect(result.invalid.map((d) => d.slug)).toContain("oneshot");
  });

  it("rejects a user event agent as invalid (recurring-only)", () => {
    writeAgentFile(userDir, "evented", userFrontmatter("evented", {
      schedule: { kind: "event", event_ref: "pr.opened" },
    }));
    const result = loadAgents(db, baseOptions());
    expect(getAgent(db, "evented")!.invalid).toBe(true);
    expect(result.invalid.map((d) => d.slug)).toContain("evented");
  });

  it("warns and does not pair a cron user agent with a non-representable expression", () => {
    writeAgentFile(userDir, "stepped", userFrontmatter("stepped", {
      schedule: { kind: "cron", expression: "*/5 9 * * *", timezone: "UTC" },
    }));
    const { port, created } = fakePort();
    const result = loadAgents(db, baseOptions({ recurring: port }));
    expect(created).toHaveLength(0);
    expect(getAgent(db, "stepped")!.recurringScheduleId).toBeNull();
    expect(result.warnings.join()).toMatch(/not representable as a recurrence rule/);

    // Reload: the still-null link exercises the existing-null branch again.
    loadAgents(db, baseOptions({ recurring: port }));
    expect(getAgent(db, "stepped")!.recurringScheduleId).toBeNull();
  });

  it("carries a numeric enabled-override forward on a recurring-only re-upsert", () => {
    writeAgentFile(userDir, "latepair", userFrontmatter("latepair"));
    loadAgents(db, baseOptions()); // no port → recurringScheduleId null, version 1
    // A dashboard toggle stamps a concrete (old) enabledOverriddenAt; the file
    // still wins on enabled, but the timestamp must carry forward.
    setEnabled(db, "latepair", true, 12345);
    const { port, created } = fakePort();
    // Re-upsert is driven purely by the recurring pairing (hash unchanged) —
    // exercises nextMetadata's no-hash-change path + the numeric override carry.
    loadAgents(db, baseOptions({ recurring: port }));
    expect(created).toHaveLength(1);
    const row = getAgent(db, "latepair")!;
    expect(row.recurringScheduleId).toBe(created[0].id);
    expect(row.enabledOverriddenAt).toBe(12345);
    expect(row.metadata.version_counter).toBe(1);
  });

  it("persists a parse-OK but validation-failing file as invalid", () => {
    writeAgentFile(userDir, "bad-tools", userFrontmatter("bad-tools", {
      tools: { allowed: ["Bash(rm -rf /etc)"] },
    }));
    const result = loadAgents(db, baseOptions());
    expect(
      result.invalid.some((i) => i.slug === "bad-tools" && /absolute-block/.test(i.error)),
    ).toBe(true);
    expect(getAgent(db, "bad-tools")!.invalid).toBe(true);
  });

  it("preserves prior identity when a valid agent's file becomes invalid", () => {
    writeAgentFile(userDir, "flips", userFrontmatter("flips", { name: "Original Name" }));
    loadAgents(db, baseOptions());
    expect(getAgent(db, "flips")!.invalid).toBe(false);

    writeFileSync(join(userDir, "flips", "agent.md"), "---\nnope: true\nkind: user\n---\nx\n", "utf-8");
    const result = loadAgents(db, baseOptions());
    expect(result.invalid.some((i) => i.slug === "flips")).toBe(true);
    const row = getAgent(db, "flips")!;
    expect(row.invalid).toBe(true);
    expect(row.enabled).toBe(false);
    expect(row.name).toBe("Original Name"); // prior identity carried forward
  });
});

// ── AgentEnabledCache ───────────────────────────────────────────────────────

describe("AgentEnabledCache", () => {
  it("reports stored enabled state, defaults unknown to enabled, and invalidates", () => {
    loadAgents(db, baseOptions());
    const cache = new AgentEnabledCache(db);
    expect(cache.isEnabled("morning-routine")).toBe(true);
    expect(cache.isEnabled("monthly-review")).toBe(false);
    expect(cache.isEnabled("ghost-agent")).toBe(true);
    setEnabled(db, "morning-routine", false, Date.now());
    expect(cache.isEnabled("morning-routine")).toBe(true); // cached
    cache.invalidate();
    expect(cache.isEnabled("morning-routine")).toBe(false); // re-queried
  });
});

// Helper: directly stamp a recurring id onto an agent row for pairing tests.
function setRecurringId(database: Database.Database, slug: string, id: number): void {
  database.prepare("UPDATE agents SET recurring_schedule_id = ? WHERE id = ?").run(id, slug);
}

// Reference the registry export so an accidental empty registry fails loudly.
it("ships exactly 10 registry entries", () => {
  expect(BUILTIN_AGENT_REGISTRY).toHaveLength(10);
});
