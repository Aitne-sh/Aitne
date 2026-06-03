import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import Database from "better-sqlite3";
import type { SuccessCriterion } from "@aitne/shared";

import { applySchema } from "../../db/schema.js";
import { upsertAgent, type AgentUpsertInput } from "../../db/agents-store.js";
import {
  evaluateSuccessCriteria,
  type CriteriaEvalContext,
} from "./success-criteria.js";

// 06:00 UTC → agent-day 2026-05-31 under a 04:00 boundary.
const STARTED_AT = Date.parse("2026-05-31T06:00:00Z");
const DATE_STR = "2026-05-31";

function seedAgent(db: Database.Database, slug: string): void {
  upsertAgent(db, {
    slug,
    name: slug,
    source: "user",
    definitionPath: `/vault/policies/agents/${slug}/agent.md`,
    definitionHash: "h",
    enabled: true,
    processKey: "agent.task",
    scheduleKind: "cron",
    scheduleExpression: "0 9 * * *",
    scheduleTimezone: "UTC",
  } as AgentUpsertInput);
}

describe("evaluateSuccessCriteria", () => {
  let db: Database.Database;
  let contextDir: string;
  let ctx: CriteriaEvalContext;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    seedAgent(db, "morning-routine");
    // realpath so the symlinked macOS tmpdir (/var → /private/var) matches the
    // realpath comparison safePath does internally.
    contextDir = realpathSync(mkdtempSync(join(tmpdir(), "aitne-criteria-")));
    ctx = {
      db,
      contextDir,
      agentId: "morning-routine",
      startedAt: STARTED_AT,
      dateStr: DATE_STR,
    };
  });

  afterEach(() => {
    db.close();
    rmSync(contextDir, { recursive: true, force: true });
  });

  function writeVault(relPath: string, content: string): void {
    const abs = join(contextDir, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf-8");
  }

  // ── file_exists ──────────────────────────────────────────────────────

  it("file_exists → true when the target is present", () => {
    writeVault("state/today.md", "# Today");
    const c: SuccessCriterion = { id: "a", kind: "file_exists", target: "state/today.md" };
    expect(evaluateSuccessCriteria([c], ctx)).toEqual({ hits: { a: true }, warnings: [] });
  });

  it("file_exists → false when the target is absent", () => {
    const c: SuccessCriterion = { id: "a", kind: "file_exists", target: "state/today.md" };
    expect(evaluateSuccessCriteria([c], ctx)).toEqual({ hits: { a: false }, warnings: [] });
  });

  it("file_exists substitutes {date} with the agent-day label", () => {
    writeVault(`journal/daily/${DATE_STR}.md`, "# Journal");
    const c: SuccessCriterion = {
      id: "j",
      kind: "file_exists",
      target: "journal/daily/{date}.md",
    };
    expect(evaluateSuccessCriteria([c], ctx).hits).toEqual({ j: true });
  });

  it("file_exists → false + warning for an out-of-vault target", () => {
    const c: SuccessCriterion = { id: "a", kind: "file_exists", target: "../outside" };
    const result = evaluateSuccessCriteria([c], ctx);
    expect(result.hits).toEqual({ a: false });
    expect(result.warnings).toEqual([
      { id: "a", kind: "file_exists", message: expect.stringContaining("out-of-vault") },
    ]);
  });

  // ── file_section_count ───────────────────────────────────────────────

  it("file_section_count → true when the file has >= min level-2 headings", () => {
    writeVault("state/today.md", "## A\n## B\n## C\n");
    const c: SuccessCriterion = {
      id: "s",
      kind: "file_section_count",
      target: "state/today.md",
      min: 3,
      heading_level: 2,
    };
    expect(evaluateSuccessCriteria([c], ctx).hits).toEqual({ s: true });
  });

  it("file_section_count → false when below min", () => {
    writeVault("state/today.md", "## A\n## B\n");
    const c: SuccessCriterion = {
      id: "s",
      kind: "file_section_count",
      target: "state/today.md",
      min: 3,
      heading_level: 2,
    };
    expect(evaluateSuccessCriteria([c], ctx).hits).toEqual({ s: false });
  });

  it("file_section_count → false (no warning) when the file is absent", () => {
    const c: SuccessCriterion = {
      id: "s",
      kind: "file_section_count",
      target: "state/today.md",
      min: 1,
      heading_level: 2,
    };
    expect(evaluateSuccessCriteria([c], ctx)).toEqual({ hits: { s: false }, warnings: [] });
  });

  it("file_section_count → false + warning for an out-of-vault target", () => {
    const c: SuccessCriterion = {
      id: "s",
      kind: "file_section_count",
      target: "../outside",
      min: 1,
      heading_level: 2,
    };
    const result = evaluateSuccessCriteria([c], ctx);
    expect(result.hits).toEqual({ s: false });
    expect(result.warnings[0]).toMatchObject({ id: "s", kind: "file_section_count" });
  });

  it("file_section_count → false + warning when the file is unreadable (EISDIR)", () => {
    // A directory at the resolved path: existsSync passes, readFileSync throws.
    mkdirSync(join(contextDir, "state", "today.md"), { recursive: true });
    const c: SuccessCriterion = {
      id: "s",
      kind: "file_section_count",
      target: "state/today.md",
      min: 1,
      heading_level: 2,
    };
    const result = evaluateSuccessCriteria([c], ctx);
    expect(result.hits).toEqual({ s: false });
    expect(result.warnings[0]).toMatchObject({ id: "s", kind: "file_section_count" });
  });

  it("file_section_count counts only the exact heading level, skipping fenced code", () => {
    // Hits every countHeadings branch: level-1/level-3 not counted, fence
    // open/close, a different fence marker mid-fence (stays in-fence), a heading
    // inside the fence skipped, plain text, and an empty `##` (end-of-line term).
    const body = [
      "# Title", // level 1 — not counted at level 2
      "## Section A", // counted (1)
      "plain text line", // not a heading
      "### Subsection", // level 3 — not counted
      "```code", // fence open
      "## not a heading", // inside fence — skipped
      "~~~", // different marker mid-fence — stays in fence
      "still inside fence",
      "```", // fence close
      "## Section B", // counted (2)
      "##", // empty heading, end-of-line terminator — counted (3)
    ].join("\n");
    writeVault("state/today.md", body);
    const base = {
      kind: "file_section_count" as const,
      target: "state/today.md",
      heading_level: 2 as const,
    };
    expect(
      evaluateSuccessCriteria([{ id: "ok", ...base, min: 3 }], ctx).hits,
    ).toEqual({ ok: true });
    expect(
      evaluateSuccessCriteria([{ id: "no", ...base, min: 4 }], ctx).hits,
    ).toEqual({ no: false });
  });

  it("file_section_count honours heading_level=1", () => {
    writeVault("state/today.md", "# One\n## Two\n# Three\n");
    const c: SuccessCriterion = {
      id: "s",
      kind: "file_section_count",
      target: "state/today.md",
      min: 2,
      heading_level: 1,
    };
    expect(evaluateSuccessCriteria([c], ctx).hits).toEqual({ s: true });
  });

  // ── notification_log ─────────────────────────────────────────────────

  function insertNotification(type: string, createdAt: string): void {
    db.prepare(
      "INSERT INTO notification_log (notification_type, created_at) VALUES (?, ?)",
    ).run(type, createdAt);
  }

  function insertNotificationWithStatus(
    type: string,
    createdAt: string,
    status: string,
  ): void {
    db.prepare(
      "INSERT INTO notification_log (notification_type, created_at, status) VALUES (?, ?, ?)",
    ).run(type, createdAt, status);
  }

  it("notification_log → true when a matching row is within the window", () => {
    insertNotification("agent", "2026-05-31 06:30:00");
    const c: SuccessCriterion = {
      id: "n",
      kind: "notification_log",
      notification_type: "agent",
      delivered_within_minutes: 60,
    };
    expect(evaluateSuccessCriteria([c], ctx).hits).toEqual({ n: true });
  });

  it("notification_log → false when the only row is past the window", () => {
    insertNotification("agent", "2026-05-31 08:00:00"); // > started + 60m (07:00)
    const c: SuccessCriterion = {
      id: "n",
      kind: "notification_log",
      notification_type: "agent",
      delivered_within_minutes: 60,
    };
    expect(evaluateSuccessCriteria([c], ctx).hits).toEqual({ n: false });
  });

  it("notification_log → false when no row matches the type", () => {
    insertNotification("other", "2026-05-31 06:30:00");
    const c: SuccessCriterion = {
      id: "n",
      kind: "notification_log",
      notification_type: "agent",
      delivered_within_minutes: 60,
    };
    expect(evaluateSuccessCriteria([c], ctx).hits).toEqual({ n: false });
  });

  const deliveredCriterion: SuccessCriterion = {
    id: "n",
    kind: "notification_log",
    notification_type: "agent",
    delivered_within_minutes: 60,
  };

  it("notification_log → false for an in-window row that FAILED delivery", () => {
    insertNotificationWithStatus("agent", "2026-05-31 06:30:00", "failed");
    expect(evaluateSuccessCriteria([deliveredCriterion], ctx).hits).toEqual({ n: false });
  });

  it("notification_log → false for an in-window row that was SUPPRESSED", () => {
    insertNotificationWithStatus("agent", "2026-05-31 06:30:00", "suppressed");
    expect(evaluateSuccessCriteria([deliveredCriterion], ctx).hits).toEqual({ n: false });
  });

  it("notification_log → true for a BATCHED row (delivered via a digest)", () => {
    insertNotificationWithStatus("agent", "2026-05-31 06:30:00", "batched");
    expect(evaluateSuccessCriteria([deliveredCriterion], ctx).hits).toEqual({ n: true });
  });

  // ── agent_action_count ───────────────────────────────────────────────

  function insertAction(actionType: string, agentId: string, startedAt: string): void {
    db.prepare(
      "INSERT INTO agent_actions (action_type, agent_id, started_at) VALUES (?, ?, ?)",
    ).run(actionType, agentId, startedAt);
  }

  it("agent_action_count → true when count >= min from started_at onward", () => {
    insertAction("digest", "morning-routine", "2026-05-31 06:05:00");
    insertAction("digest", "morning-routine", "2026-05-31 06:10:00");
    const c: SuccessCriterion = {
      id: "c",
      kind: "agent_action_count",
      action_type: "digest",
      min: 2,
    };
    expect(evaluateSuccessCriteria([c], ctx).hits).toEqual({ c: true });
  });

  it("agent_action_count excludes rows before started_at and falls below min", () => {
    insertAction("digest", "morning-routine", "2026-05-31 05:00:00"); // before start
    insertAction("digest", "morning-routine", "2026-05-31 06:05:00"); // counted
    const c: SuccessCriterion = {
      id: "c",
      kind: "agent_action_count",
      action_type: "digest",
      min: 2,
    };
    expect(evaluateSuccessCriteria([c], ctx).hits).toEqual({ c: false });
  });

  // ── best-effort semantics ────────────────────────────────────────────

  it("isolates a throwing check: others still evaluate; warning captured (Error)", () => {
    writeVault("state/today.md", "# Today");
    const throwingDb = {
      prepare() {
        throw new Error("db down");
      },
    } as unknown as Database.Database;
    const fileOk: SuccessCriterion = { id: "f", kind: "file_exists", target: "state/today.md" };
    const dbCheck: SuccessCriterion = {
      id: "n",
      kind: "notification_log",
      notification_type: "agent",
      delivered_within_minutes: 60,
    };
    const result = evaluateSuccessCriteria([fileOk, dbCheck], { ...ctx, db: throwingDb });
    expect(result.hits).toEqual({ f: true, n: false });
    expect(result.warnings).toEqual([
      { id: "n", kind: "notification_log", message: "db down" },
    ]);
  });

  it("stringifies a non-Error throw in the warning message", () => {
    const throwingDb = {
      prepare() {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw "stringy failure";
      },
    } as unknown as Database.Database;
    const c: SuccessCriterion = {
      id: "c",
      kind: "agent_action_count",
      action_type: "digest",
      min: 1,
    };
    const result = evaluateSuccessCriteria([c], { ...ctx, db: throwingDb });
    expect(result.hits).toEqual({ c: false });
    expect(result.warnings).toEqual([
      { id: "c", kind: "agent_action_count", message: "stringy failure" },
    ]);
  });

  it("returns empty maps for an empty criteria array", () => {
    expect(evaluateSuccessCriteria([], ctx)).toEqual({ hits: {}, warnings: [] });
  });
});
