import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applySchema } from "../../../db/schema.js";
import type { AgentConfig } from "../../../config.js";
import type { ApiDependencies } from "../../server.js";
import { getAgent } from "../../../db/agents-store.js";
import { listRecurringSchedules } from "../../../db/recurring-schedules.js";
import { createAgentDefinitionRoutes } from "./index.js";

/**
 * `POST /api/agents` — the programmatic create door (the LLM/agent-create skill
 * counterpart to the dashboard "+ New Agent" form). `/agents` is recurring-only:
 * a cron definition is written to the user agents root, the loader pairs a
 * `recurring_schedules` row synchronously, and a one_shot/event request is
 * rejected with a pointer to the `/schedule` one-shot queue.
 *
 * Purpose-built harness: `dataDir`/`workspaceDir` point at a temp dir so
 * `buildAgentLoadOptions` resolves real (empty) roots — built-ins synthesise
 * from the registry; the only user agent is the one this suite creates.
 */

interface Harness {
  db: Database.Database;
  app: ReturnType<typeof createAgentDefinitionRoutes>;
  tmp: string;
}

function setup(): Harness {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  const tmp = mkdtempSync(join(tmpdir(), "agents-create-"));

  const deps = {
    db,
    config: {
      dayBoundaryHour: 4,
      timezone: "Asia/Tokyo",
      dataDir: tmp,
      workspaceDir: tmp,
    } as unknown as AgentConfig,
    eventBroadcaster: { broadcastEvent: () => {} },
    agentEnabledCache: { invalidate: () => {}, isEnabled: () => true },
  } as unknown as ApiDependencies;

  return { db, app: createAgentDefinitionRoutes(deps), tmp };
}

function postAgent(app: Harness["app"], body: unknown) {
  return app.request("/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const CRON_BODY = {
  slug: "daily-triage",
  name: "Daily Triage",
  description: "Triage the inbox every morning.",
  schedule: { kind: "cron", expression: "0 9 * * *", timezone: "Asia/Tokyo" },
  backend: { tier: "medium" },
  prompt: "## Goal\nTriage the inbox.\n## Steps\n1. Read unread.\n2. Summarise.",
};

describe("POST /api/agents", () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });
  afterEach(() => {
    h.db.close();
    rmSync(h.tmp, { recursive: true, force: true });
  });

  it("creates a recurring user Agent (201), writes the file, and pairs a recurring row", async () => {
    const res = await postAgent(h.app, CRON_BODY);
    expect(res.status).toBe(201);
    const json = (await res.json()) as { status: string; slug: string };
    expect(json).toEqual({ status: "created", slug: "daily-triage" });

    const dto = getAgent(h.db, "daily-triage")!;
    expect(dto.source).toBe("user");
    expect(dto.invalid).toBe(false);
    expect(dto.scheduleKind).toBe("cron");
    expect(dto.recurringScheduleId).not.toBeNull();

    // The agent.md landed under the resolved user agents root.
    const filePath = join(h.tmp, "context", "policies", "agents", "daily-triage", "agent.md");
    expect(existsSync(filePath)).toBe(true);

    // A backing recurring_schedules row exists (pairRecurring ran in-request).
    const recurring = listRecurringSchedules(h.db);
    expect(recurring.length).toBe(1);
    expect(recurring[0].id).toBe(dto.recurringScheduleId);
  });

  it("creates a structured hourly Agent (201) and pairs an hourly recurring row", async () => {
    const res = await postAgent(h.app, {
      slug: "hourly-pulse",
      name: "Hourly Pulse",
      description: "Surface new activity every hour.",
      schedule: {
        kind: "recurring",
        recurrence: { frequency: "hourly", intervalHours: 1, minuteOfHour: 0 },
        timezone: "Asia/Tokyo",
      },
      prompt: "## Goal\nSurface new activity.\n## Steps\n1. Look.\n2. Act.",
    });
    expect(res.status).toBe(201);

    const dto = getAgent(h.db, "hourly-pulse")!;
    expect(dto.invalid).toBe(false);
    // Structured recurrence is stored as the canonical cron …
    expect(dto.scheduleKind).toBe("cron");
    expect(dto.scheduleExpression).toBe("0 * * * *");
    // … and the hourly Agent IS paired — the former silent-failure trap is closed.
    expect(dto.recurringScheduleId).not.toBeNull();

    const recurring = listRecurringSchedules(h.db);
    expect(recurring.length).toBe(1);
    expect(recurring[0].recurrenceRule.frequency).toBe("hourly");
    expect(recurring[0].recurrenceRule.intervalHours).toBe(1);
  });

  it("carries schedule.defer_in_quiet_hours end-to-end onto the recurring row and its materialised occurrence (QUIET_HOURS_HARDENING_PLAN §6)", async () => {
    const res = await postAgent(h.app, {
      ...CRON_BODY,
      slug: "nightly-dm",
      name: "Nightly DM",
      schedule: {
        kind: "cron",
        expression: "0 3 * * *",
        timezone: "Asia/Tokyo",
        defer_in_quiet_hours: true,
      },
    });
    expect(res.status).toBe(201);

    const dto = getAgent(h.db, "nightly-dm")!;
    expect(dto.invalid).toBe(false);
    expect(dto.recurringScheduleId).not.toBeNull();

    // The flag landed in the recurring row's task_context …
    const recurring = listRecurringSchedules(h.db);
    expect(recurring[0].taskContext.defer_in_quiet_hours).toBe(true);

    // … and spread onto the materialised agent_schedule occurrence the
    // scheduler will claim (the row-local read path).
    const pending = h.db
      .prepare(
        "SELECT task_context FROM agent_schedule WHERE recurring_schedule_id = ? AND status = 'pending'",
      )
      .get(dto.recurringScheduleId) as { task_context: string } | undefined;
    expect(pending).toBeDefined();
    expect(JSON.parse(pending!.task_context).defer_in_quiet_hours).toBe(true);
  });

  it("pairs a raw hourly cron (0 * * * *) — previously written-but-never-fired", async () => {
    const res = await postAgent(h.app, {
      slug: "hourly-cron",
      name: "Hourly Cron",
      description: "Hourly via a raw cron expression.",
      schedule: { kind: "cron", expression: "0 * * * *", timezone: "Asia/Tokyo" },
      prompt: "## Goal\nDo work.\n## Steps\n1. Go.",
    });
    expect(res.status).toBe(201);
    const dto = getAgent(h.db, "hourly-cron")!;
    expect(dto.recurringScheduleId).not.toBeNull();
    expect(listRecurringSchedules(h.db)[0].recurrenceRule.frequency).toBe("hourly");
  });

  it("defaults backend.process_key to agent.task when omitted", async () => {
    const res = await postAgent(h.app, { ...CRON_BODY, backend: undefined });
    expect(res.status).toBe(201);
    expect(getAgent(h.db, "daily-triage")!.processKey).toBe("agent.task");
  });

  it("rejects a one_shot schedule (400) with a /schedule pointer", async () => {
    const res = await postAgent(h.app, {
      slug: "one-off",
      name: "One Off",
      schedule: { kind: "one_shot", one_shot_at: "2099-01-01T00:00:00Z" },
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; hint: string };
    expect(json.error).toBe("one_shot_not_supported");
    expect(json.hint).toContain("/api/schedule");
    expect(getAgent(h.db, "one-off")).toBeNull();
  });

  it("rejects a duplicate slug (409)", async () => {
    expect((await postAgent(h.app, CRON_BODY)).status).toBe(201);
    const res = await postAgent(h.app, CRON_BODY);
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string; slug: string };
    expect(json.error).toBe("slug_collision");
    expect(json.slug).toBe("daily-triage");
  });

  it("rejects a non-object body (400)", async () => {
    const res = await postAgent(h.app, ["not", "an", "object"]);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("invalid_body");
  });

  it("rejects a missing slug (400)", async () => {
    const res = await postAgent(h.app, { name: "X", schedule: { kind: "cron", expression: "0 9 * * *" } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("slug_required");
  });

  it("rejects a tools.allowed entry that overlaps the absolute-block layer (400) and leaves no row", async () => {
    const res = await postAgent(h.app, {
      ...CRON_BODY,
      slug: "danger",
      tools: { allowed: ["Bash(rm -rf /)"] },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_definition");
    expect(getAgent(h.db, "danger")).toBeNull();
    expect(existsSync(join(h.tmp, "context", "policies", "agents", "danger"))).toBe(false);
  });
});
