import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { StopWarning } from "@aitne/shared";
import { applySchema } from "./schema.js";
import {
  deleteAgent,
  disableOneShotAfterFire,
  getAgent,
  getOverrideSnapshot,
  getRuntimeWindow,
  listAgents,
  setEnabled,
  setLastExecutionId,
  setOverrideSnapshot,
  setRuntimeWindow,
  upsertAgent,
  type AgentUpsertInput,
} from "./agents-store.js";
import { startExecution } from "./agent-executions-store.js";

const STOP_WARNING: StopWarning = {
  level: "critical",
  services_lost: ["Daily today.md regeneration"],
  dependent_agents: ["evening-review"],
};

/** A fully-populated user-Agent input — exercises every optional field. */
function fullInput(overrides: Partial<AgentUpsertInput> = {}): AgentUpsertInput {
  return {
    slug: "deploy-watch",
    name: "Deploy Watch",
    description: "Watches the deploy pipeline",
    source: "user",
    definitionPath: "/vault/policies/agents/deploy-watch/agent.md",
    definitionHash: "abc123",
    enabled: true,
    enabledOverriddenAt: 1000,
    processKey: "agent.task",
    scheduleKind: "cron",
    scheduleExpression: "0 9 * * *",
    scheduleTimezone: "America/New_York",
    tags: ["ops", "ci"],
    stopWarning: STOP_WARNING,
    recurringScheduleId: 42,
    metadata: { version_counter: 3 },
    ...overrides,
  };
}

/** A minimal input — every optional field omitted, exercising the defaults. */
function minimalInput(
  overrides: Partial<AgentUpsertInput> = {},
): AgentUpsertInput {
  return {
    slug: "roadmap-maintenance",
    name: "Roadmap Maintenance",
    source: "builtin",
    definitionPath: "/pkg/agent-assets/agents/roadmap-maintenance/agent.md",
    definitionHash: "def456",
    enabled: false,
    scheduleKind: "cron",
    scheduleExpression: "45 17 * * *",
    scheduleTimezone: "UTC",
    ...overrides,
  };
}

describe("agents-store", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    // fullInput() pins recurringScheduleId=42; with foreign_keys ON the
    // recurring_schedules row must exist for the FK to hold. Insert with an
    // explicit id so the reference resolves.
    db.prepare(
      "INSERT INTO recurring_schedules (id, task_type, recurrence_rule) VALUES (42, 'agent.task', '{}')",
    ).run();
  });

  afterEach(() => {
    db.close();
  });

  describe("upsertAgent / getAgent", () => {
    it("inserts a fully-populated row and round-trips every field", () => {
      const dto = upsertAgent(db, fullInput(), 5000);
      expect(dto).toMatchObject({
        slug: "deploy-watch",
        name: "Deploy Watch",
        description: "Watches the deploy pipeline",
        source: "user",
        definitionPath: "/vault/policies/agents/deploy-watch/agent.md",
        definitionHash: "abc123",
        enabled: true,
        enabledOverriddenAt: 1000,
        processKey: "agent.task",
        scheduleKind: "cron",
        scheduleExpression: "0 9 * * *",
        scheduleTimezone: "America/New_York",
        tags: ["ops", "ci"],
        stopWarning: STOP_WARNING,
        recurringScheduleId: 42,
        lastExecutionId: null,
        invalid: false,
        createdAt: 5000,
        updatedAt: 5000,
      });
      expect(dto.metadata).toEqual({ version_counter: 3 });
      expect(getAgent(db, "deploy-watch")).toEqual(dto);
    });

    it("applies defaults when optional fields are omitted", () => {
      const dto = upsertAgent(db, minimalInput(), 7000);
      expect(dto).toMatchObject({
        slug: "roadmap-maintenance",
        description: null,
        enabled: false,
        enabledOverriddenAt: null,
        processKey: null, // no-LLM in-process pass — nullable key
        tags: [],
        stopWarning: null,
        recurringScheduleId: null,
        lastExecutionId: null,
        metadata: {},
        invalid: false,
      });
    });

    it("returns null from getAgent for an unknown slug", () => {
      expect(getAgent(db, "nope")).toBeNull();
    });

    it("stores a null schedule_expression when omitted", () => {
      const dto = upsertAgent(db, minimalInput({ scheduleExpression: undefined }));
      expect(dto.scheduleExpression).toBeNull();
    });

    it("updates on slug conflict, preserving created_at and last_execution_id", () => {
      upsertAgent(db, fullInput(), 1000);
      const execId = startExecution(
        db,
        { agentId: "deploy-watch", trigger: "cron" },
        1500,
      );
      setLastExecutionId(db, "deploy-watch", execId, 1600);

      const updated = upsertAgent(
        db,
        fullInput({ name: "Renamed", definitionHash: "newhash", enabled: false }),
        9000,
      );
      expect(updated.name).toBe("Renamed");
      expect(updated.definitionHash).toBe("newhash");
      expect(updated.enabled).toBe(false);
      // Preserved across the conflict-update.
      expect(updated.createdAt).toBe(1000);
      expect(updated.lastExecutionId).toBe(execId);
      // Refreshed.
      expect(updated.updatedAt).toBe(9000);
    });

    it("marks a row invalid when metadata.last_error is set", () => {
      const dto = upsertAgent(
        db,
        minimalInput({ metadata: { last_error: "schema parse failed" } }),
      );
      expect(dto.invalid).toBe(true);
    });

    it("treats an empty-string last_error as valid", () => {
      const dto = upsertAgent(
        db,
        minimalInput({ metadata: { last_error: "" } }),
      );
      expect(dto.invalid).toBe(false);
    });
  });

  describe("listAgents", () => {
    beforeEach(() => {
      upsertAgent(db, minimalInput({ slug: "builtin-a", source: "builtin", enabled: true }));
      upsertAgent(db, minimalInput({ slug: "builtin-b", source: "builtin", enabled: false }));
      upsertAgent(db, fullInput({ slug: "user-a", source: "user", enabled: true }));
      upsertAgent(
        db,
        fullInput({
          slug: "user-invalid",
          source: "user",
          metadata: { last_error: "boom" },
        }),
      );
    });

    it("returns every row ordered by source then slug with no filter", () => {
      const slugs = listAgents(db).map((a) => a.slug);
      expect(slugs).toEqual(["builtin-a", "builtin-b", "user-a", "user-invalid"]);
    });

    it("filters by source", () => {
      const slugs = listAgents(db, { source: "builtin" }).map((a) => a.slug);
      expect(slugs).toEqual(["builtin-a", "builtin-b"]);
    });

    it("filters by enabled", () => {
      const slugs = listAgents(db, { enabled: true }).map((a) => a.slug);
      expect(slugs).toEqual(["builtin-a", "user-a", "user-invalid"]);
    });

    it("filters by disabled", () => {
      const slugs = listAgents(db, { enabled: false }).map((a) => a.slug);
      expect(slugs).toEqual(["builtin-b"]);
    });

    it("excludes invalid rows when includeInvalid is false", () => {
      const slugs = listAgents(db, { includeInvalid: false }).map((a) => a.slug);
      expect(slugs).toEqual(["builtin-a", "builtin-b", "user-a"]);
    });

    it("includes invalid rows when includeInvalid is true", () => {
      const slugs = listAgents(db, { includeInvalid: true }).map((a) => a.slug);
      expect(slugs).toContain("user-invalid");
    });

    it("combines filters", () => {
      const slugs = listAgents(db, {
        source: "user",
        enabled: true,
        includeInvalid: false,
      }).map((a) => a.slug);
      expect(slugs).toEqual(["user-a"]);
    });
  });

  describe("setEnabled", () => {
    it("toggles enabled and stamps enabled_overridden_at", () => {
      upsertAgent(db, fullInput({ enabled: true, enabledOverriddenAt: null }), 1000);
      const dto = setEnabled(db, "deploy-watch", false, 8888, 9000);
      expect(dto).not.toBeNull();
      expect(dto!.enabled).toBe(false);
      expect(dto!.enabledOverriddenAt).toBe(8888);
      expect(dto!.updatedAt).toBe(9000);
    });

    it("can re-enable and clear the override timestamp", () => {
      upsertAgent(db, fullInput({ enabled: false, enabledOverriddenAt: 5 }));
      const dto = setEnabled(db, "deploy-watch", true, null);
      expect(dto!.enabled).toBe(true);
      expect(dto!.enabledOverriddenAt).toBeNull();
    });

    it("returns null for an unknown slug", () => {
      expect(setEnabled(db, "ghost", false, 1)).toBeNull();
    });
  });

  describe("setLastExecutionId", () => {
    it("points the agent at an execution and can clear it", () => {
      upsertAgent(db, fullInput(), 1000);
      const execId = startExecution(db, { agentId: "deploy-watch", trigger: "manual" });
      expect(setLastExecutionId(db, "deploy-watch", execId, 2000)).toBe(true);
      expect(getAgent(db, "deploy-watch")!.lastExecutionId).toBe(execId);

      expect(setLastExecutionId(db, "deploy-watch", null, 3000)).toBe(true);
      expect(getAgent(db, "deploy-watch")!.lastExecutionId).toBeNull();
    });

    it("returns false for an unknown slug", () => {
      expect(setLastExecutionId(db, "ghost", null)).toBe(false);
    });
  });

  describe("deleteAgent", () => {
    it("removes the row and cascades to its executions", () => {
      upsertAgent(db, fullInput(), 1000);
      startExecution(db, { agentId: "deploy-watch", trigger: "cron" });
      expect(deleteAgent(db, "deploy-watch")).toBe(true);
      expect(getAgent(db, "deploy-watch")).toBeNull();
      const remaining = db
        .prepare<[string], { n: number }>(
          "SELECT COUNT(*) AS n FROM agent_executions WHERE agent_id = ?",
        )
        .get("deploy-watch");
      expect(remaining).toEqual({ n: 0 });
    });

    it("returns false for an unknown slug", () => {
      expect(deleteAgent(db, "ghost")).toBe(false);
    });
  });

  describe("override snapshot", () => {
    it("returns {} for a missing agent", () => {
      expect(getOverrideSnapshot(db, "ghost")).toEqual({});
    });

    it("returns {} for an agent without a snapshot", () => {
      upsertAgent(db, fullInput());
      expect(getOverrideSnapshot(db, "deploy-watch")).toEqual({});
    });

    it("round-trips a snapshot while preserving sibling metadata keys", () => {
      upsertAgent(db, fullInput({ metadata: { version_counter: 2 } }), 1000);
      const dto = setOverrideSnapshot(
        db,
        "deploy-watch",
        { "limits.max_budget_usd": 0.2 },
        2000,
      );
      expect(dto).not.toBeNull();
      expect(dto!.updatedAt).toBe(2000);
      expect(getOverrideSnapshot(db, "deploy-watch")).toEqual({
        "limits.max_budget_usd": 0.2,
      });
      // version_counter survived.
      expect(getAgent(db, "deploy-watch")!.metadata.version_counter).toBe(2);
    });

    it("removes the override_snapshot key when set to an empty object", () => {
      upsertAgent(
        db,
        fullInput({
          metadata: {
            version_counter: 1,
            override_snapshot: { "backend.tier": "high" },
          },
        }),
      );
      setOverrideSnapshot(db, "deploy-watch", {});
      expect(getOverrideSnapshot(db, "deploy-watch")).toEqual({});
      const md = getAgent(db, "deploy-watch")!.metadata;
      expect(md.override_snapshot).toBeUndefined();
      expect(md.version_counter).toBe(1);
    });

    it("returns null when setting a snapshot on a missing agent", () => {
      expect(setOverrideSnapshot(db, "ghost", { a: 1 })).toBeNull();
    });
  });

  describe("runtime window (activity-scan cadence overrides)", () => {
    it("returns {} for a missing agent or one without an override", () => {
      expect(getRuntimeWindow(db, "ghost")).toEqual({});
      upsertAgent(db, fullInput());
      expect(getRuntimeWindow(db, "deploy-watch")).toEqual({});
    });

    it("round-trips a window while preserving sibling metadata keys", () => {
      upsertAgent(
        db,
        fullInput({
          metadata: {
            version_counter: 3,
            override_snapshot: { "backend.tier": "high" },
          },
        }),
        1000,
      );
      const dto = setRuntimeWindow(
        db,
        "deploy-watch",
        { interval_minutes: 30, min_observations: 2 },
        2000,
      );
      expect(dto).not.toBeNull();
      expect(dto!.updatedAt).toBe(2000);
      expect(getRuntimeWindow(db, "deploy-watch")).toEqual({
        interval_minutes: 30,
        min_observations: 2,
      });
      const md = getAgent(db, "deploy-watch")!.metadata;
      expect(md.version_counter).toBe(3);
      expect(md.override_snapshot).toEqual({ "backend.tier": "high" });
    });

    it("sanitizes garbage fields on read", () => {
      upsertAgent(
        db,
        fullInput({
          metadata: {
            runtime_window: { interval_minutes: 9999, active_start_hour: 9, junk: true },
          },
        }),
      );
      expect(getRuntimeWindow(db, "deploy-watch")).toEqual({ active_start_hour: 9 });
    });

    it("removes the runtime_window key when set to an empty object", () => {
      upsertAgent(
        db,
        fullInput({
          metadata: { version_counter: 1, runtime_window: { interval_minutes: 15 } },
        }),
      );
      setRuntimeWindow(db, "deploy-watch", {});
      const md = getAgent(db, "deploy-watch")!.metadata;
      expect(md.runtime_window).toBeUndefined();
      expect(md.version_counter).toBe(1);
    });

    it("returns null when setting a window on a missing agent", () => {
      expect(setRuntimeWindow(db, "ghost", { interval_minutes: 10 })).toBeNull();
    });
  });

  describe("defensive JSON parsing", () => {
    // Insert raw rows with malformed / wrong-shape JSON, bypassing the store's
    // serializers, to exercise rowToDTO's try/catch fallbacks.
    function insertRaw(
      slug: string,
      tagsJson: string,
      stopWarningJson: string | null,
      metadataJson: string,
    ): void {
      db.prepare(
        `INSERT INTO agents
           (id, name, source, definition_path, definition_hash, schedule_kind,
            schedule_timezone, tags_json, stop_warning_json, metadata_json,
            created_at, updated_at)
         VALUES (?, 'n', 'user', 'p', 'h', 'cron', 'UTC', ?, ?, ?, 0, 0)`,
      ).run(slug, tagsJson, stopWarningJson, metadataJson);
    }

    it("falls back to [] on malformed or non-array tags_json", () => {
      insertRaw("bad-tags", "not json", null, "{}");
      insertRaw("obj-tags", '{"x":1}', null, "{}");
      expect(getAgent(db, "bad-tags")!.tags).toEqual([]);
      expect(getAgent(db, "obj-tags")!.tags).toEqual([]);
    });

    it("drops non-string tag elements", () => {
      insertRaw("mixed-tags", '["a", 1, "b", null]', null, "{}");
      expect(getAgent(db, "mixed-tags")!.tags).toEqual(["a", "b"]);
    });

    it("falls back to null on malformed or array stop_warning_json", () => {
      insertRaw("bad-sw", "[]", "{bad json", "{}");
      insertRaw("arr-sw", "[]", "[1,2]", "{}");
      expect(getAgent(db, "bad-sw")!.stopWarning).toBeNull();
      expect(getAgent(db, "arr-sw")!.stopWarning).toBeNull();
    });

    it("falls back to {} on malformed or array metadata_json", () => {
      insertRaw("bad-md", "[]", null, "not json");
      insertRaw("arr-md", "[]", null, "[1,2]");
      expect(getAgent(db, "bad-md")!.metadata).toEqual({});
      expect(getAgent(db, "bad-md")!.invalid).toBe(false);
      expect(getAgent(db, "arr-md")!.metadata).toEqual({});
    });
  });

  // ── One-shot Agent lifecycle (legacy / defensive) ─────────────────────────

  function makeAgent(
    slug: string,
    scheduleKind: "cron" | "one_shot",
    enabled: boolean,
  ): void {
    upsertAgent(
      db,
      {
        slug,
        name: slug,
        source: "user",
        definitionPath: `/vault/policies/agents/${slug}/agent.md`,
        definitionHash: "h",
        enabled,
        processKey: "agent.task",
        scheduleKind,
        scheduleExpression:
          scheduleKind === "one_shot" ? "2099-01-02T09:00:00.000Z" : "0 9 * * *",
        scheduleTimezone: "UTC",
      },
      1000,
    );
  }

  function insertScheduleRow(agentId: string, status: string): number {
    const r = db
      .prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_context, status)
         VALUES ('2099-01-01 00:00:00', 'agent.task', ?, ?)`,
      )
      .run(JSON.stringify({ agent_id: agentId }), status);
    return Number(r.lastInsertRowid);
  }

  describe("disableOneShotAfterFire", () => {
    it("disables a one_shot agent and skips its sibling pending fires", () => {
      makeAgent("remind-me", "one_shot", true);
      const sibling = insertScheduleRow("remind-me", "pending");
      expect(disableOneShotAfterFire(db, "remind-me", 5000)).toBe(true);
      const agent = getAgent(db, "remind-me")!;
      expect(agent.enabled).toBe(false);
      expect(agent.enabledOverriddenAt).toBe(5000);
      const sib = db
        .prepare("SELECT status FROM agent_schedule WHERE id = ?")
        .get(sibling) as { status: string };
      expect(sib.status).toBe("skipped");
    });

    it("is a no-op for a cron agent — leaves it enabled and its row pending", () => {
      makeAgent("daily", "cron", true);
      const row = insertScheduleRow("daily", "pending");
      expect(disableOneShotAfterFire(db, "daily", 5000)).toBe(false);
      expect(getAgent(db, "daily")!.enabled).toBe(true);
      const r = db
        .prepare("SELECT status FROM agent_schedule WHERE id = ?")
        .get(row) as { status: string };
      expect(r.status).toBe("pending");
    });

    it("returns false for an already-disabled one_shot but still skips pending", () => {
      makeAgent("remind-me", "one_shot", false);
      const sibling = insertScheduleRow("remind-me", "pending");
      expect(disableOneShotAfterFire(db, "remind-me", 5000)).toBe(false);
      const sib = db
        .prepare("SELECT status FROM agent_schedule WHERE id = ?")
        .get(sibling) as { status: string };
      expect(sib.status).toBe("skipped");
    });

    it("returns false when the agent does not exist", () => {
      expect(disableOneShotAfterFire(db, "ghost", 5000)).toBe(false);
    });
  });
});
