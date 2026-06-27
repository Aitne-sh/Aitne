import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

import { applySchema } from "../../db/schema.js";
import { upsertAgent } from "../../db/agents-store.js";
import { recordAgentFiringBlocked } from "./firing-blocked.js";

function seedAgent(db: Database.Database, slug: string): void {
  upsertAgent(db, {
    slug,
    name: slug,
    source: "builtin",
    definitionPath: `/agents/${slug}/agent.md`,
    definitionHash: `hash-${slug}`,
    enabled: false,
    scheduleKind: "cron",
    scheduleExpression: "0 4 * * *",
    scheduleTimezone: "UTC",
  });
}

function readRow(
  db: Database.Database,
  slug: string,
  agentDay: string,
): { count: number; detail: string } {
  const rows = db
    .prepare(
      `SELECT detail FROM agent_actions
        WHERE action_type = 'agent.firing_blocked'
          AND agent_id = ?
          AND json_extract(detail, '$.agent_day') = ?`,
    )
    .all(slug, agentDay) as { detail: string }[];
  return { count: rows.length, detail: rows[0]?.detail ?? "{}" };
}

describe("recordAgentFiringBlocked", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    seedAgent(db, "morning-routine");
  });

  afterEach(() => {
    db.close();
  });

  it("inserts a fresh row on the first block of an agent-day", () => {
    const outcome = recordAgentFiringBlocked(db, {
      slug: "morning-routine",
      agentDay: "2026-05-31",
      reason: "disabled",
    });
    expect(outcome).toBe("inserted");
    const { count, detail } = readRow(db, "morning-routine", "2026-05-31");
    expect(count).toBe(1);
    const parsed = JSON.parse(detail);
    expect(parsed.suppressed_count).toBe(0);
    expect(parsed.reason).toBe("disabled");
  });

  it("increments suppressed_count on subsequent blocks within the same agent-day", () => {
    recordAgentFiringBlocked(db, { slug: "morning-routine", agentDay: "2026-05-31", reason: "disabled" });
    const second = recordAgentFiringBlocked(db, { slug: "morning-routine", agentDay: "2026-05-31", reason: "disabled" });
    const third = recordAgentFiringBlocked(db, { slug: "morning-routine", agentDay: "2026-05-31", reason: "disabled" });
    expect(second).toBe("incremented");
    expect(third).toBe("incremented");
    const { count, detail } = readRow(db, "morning-routine", "2026-05-31");
    expect(count).toBe(1);
    expect(JSON.parse(detail).suppressed_count).toBe(2);
  });

  it("opens a new row on a new agent-day", () => {
    recordAgentFiringBlocked(db, { slug: "morning-routine", agentDay: "2026-05-31", reason: "disabled" });
    const next = recordAgentFiringBlocked(db, { slug: "morning-routine", agentDay: "2026-06-01", reason: "disabled" });
    expect(next).toBe("inserted");
    expect(readRow(db, "morning-routine", "2026-05-31").count).toBe(1);
    expect(readRow(db, "morning-routine", "2026-06-01").count).toBe(1);
  });

  it("keeps separate rows per Agent on the same agent-day", () => {
    seedAgent(db, "activity-scan");
    recordAgentFiringBlocked(db, { slug: "morning-routine", agentDay: "2026-05-31", reason: "disabled" });
    const other = recordAgentFiringBlocked(db, { slug: "activity-scan", agentDay: "2026-05-31", reason: "disabled" });
    expect(other).toBe("inserted");
    expect(readRow(db, "morning-routine", "2026-05-31").count).toBe(1);
    expect(readRow(db, "activity-scan", "2026-05-31").count).toBe(1);
  });
});
