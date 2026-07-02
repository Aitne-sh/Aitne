import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";

import { applySchema } from "../../db/schema.js";
import {
  createBackgroundTask,
  getBackgroundTask,
  markRunning,
  markTerminal,
} from "../../db/background-task-store.js";
import { listClarificationsForTask } from "../../db/background-task-clarifications-store.js";
import { CONTEXT_RELATIVE_PATHS } from "../../core/context-paths.js";
import {
  createBackgroundTaskRuntime,
  createBackgroundTaskTools,
} from "./background-task-tools.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function runtime(db: Database.Database, contextDir: string) {
  return createBackgroundTaskRuntime({
    taskId: "t1",
    db,
    contextDir,
    clarificationTtlMs: 60 * 60 * 1000,
    abortSignal: new AbortController().signal,
    nowFn: () => 5000,
  });
}

function handler(rt: ReturnType<typeof runtime>, name: string) {
  const tool = createBackgroundTaskTools(rt).find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return (args: unknown) =>
    (tool.handler as (a: unknown, extra: unknown) => Promise<ToolResult>)(args, {});
}

function payload(r: ToolResult): Record<string, unknown> {
  return JSON.parse(r.content[0].text) as Record<string, unknown>;
}

describe("background-task worker tools", () => {
  let db: Database.Database;
  let contextDir: string;
  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    contextDir = mkdtempSync(join(tmpdir(), "bgtask-vault-"));
    createBackgroundTask(db, {
      id: "t1",
      brief: "audit repos",
      title: "audit",
      notificationPolicy: "always",
      originatingChannel: "slack:C1",
      correlationId: null,
      scheduleRowId: null,
      tier: "medium",
      maxBudgetUsd: null,
      createdAt: 1000,
    });
    markRunning(db, "t1", 1100);
  });

  it("finish with an all-met verification writes a clean artifact + completes + sets finishFlag", async () => {
    const rt = runtime(db, contextDir);
    const r = await handler(rt, "finish")({
      result: "verbatim 42",
      draft: "two repos red",
      notify: true,
      significance: "2 red",
      verification: [
        { requirement: "one line per repo", met: true, evidence: "both repos listed" },
        { requirement: "state the failing job", met: true, evidence: "job names quoted" },
      ],
    });
    expect(r.isError).toBeFalsy();
    expect(payload(r)).toMatchObject({ completed: true, notify: true });
    expect(rt.finishFlag.current).toBe(true);
    const row = getBackgroundTask(db, "t1");
    expect(row?.state).toBe("completed");
    expect(row?.report).toBe("verbatim 42");
    // all met ⇒ NO gap disclosure suffix, no outcome downgrade, no
    // significance prefix — the artifact is exactly what the worker wrote.
    expect(row?.draft).toBe("two repos red");
    expect(row?.outcomeDetail).toBeNull();
    expect(row?.significance).toBe("2 red");
    expect(row?.notify).toBe(true);
    expect(row?.verification).toEqual([
      { requirement: "one line per repo", met: true, evidence: "both repos listed" },
      { requirement: "state the failing job", met: true, evidence: "job names quoted" },
    ]);
  });

  it("gapped finish appends the disclosure, downgrades to completed_with_gaps, keeps notify", async () => {
    const rt = runtime(db, contextDir);
    const r = await handler(rt, "finish")({
      result: "partial findings",
      draft: "checked one repo",
      notify: true,
      significance: "1 red",
      verification: [
        { requirement: "one line per repo", met: false, evidence: "second repo API 404ed" },
        { requirement: "state the failing job", met: true, evidence: "job named" },
      ],
    });
    expect(r.isError).toBeFalsy();
    const row = getBackgroundTask(db, "t1");
    expect(row?.state).toBe("completed");
    expect(row?.outcomeDetail).toBe("completed_with_gaps");
    expect(row?.draft).toBe(
      "checked one repo\n\nNote: 1 of 2 requirements not fully met: one line per repo",
    );
    expect(row?.significance).toBe("completed_with_gaps; 1 red");
    // gaps must NOT override the worker's notify disposition
    expect(row?.notify).toBe(true);
    expect(row?.verification).toEqual([
      { requirement: "one line per repo", met: false, evidence: "second repo API 404ed" },
      { requirement: "state the failing job", met: true, evidence: "job named" },
    ]);
  });

  it("gapped finish without a significance line synthesizes one", async () => {
    const rt = runtime(db, contextDir);
    await handler(rt, "finish")({
      result: "r",
      draft: "d",
      notify: false,
      verification: [{ requirement: "req A", met: false, evidence: "not reachable" }],
    });
    const row = getBackgroundTask(db, "t1");
    expect(row?.significance).toBe(
      "completed_with_gaps; 1 of 1 requirements not fully met",
    );
    expect(row?.notify).toBe(false);
  });

  it("gap disclosure truncates a huge unmet-requirement list", async () => {
    const rt = runtime(db, contextDir);
    const requirement = "x".repeat(300);
    await handler(rt, "finish")({
      result: "r",
      draft: "d",
      notify: true,
      verification: Array.from({ length: 3 }, () => ({
        requirement,
        met: false,
        evidence: "missing",
      })),
    });
    const draft = getBackgroundTask(db, "t1")?.draft ?? "";
    expect(draft).toContain("3 of 3 requirements not fully met");
    expect(draft.endsWith("…")).toBe(true);
    // 600-char cap + the ellipsis, not the raw ~900-char join
    expect(draft.length).toBeLessThan(700);
  });

  it("finish schema REQUIRES a non-empty verification array", () => {
    const rt = runtime(db, contextDir);
    const finishTool = createBackgroundTaskTools(rt).find((t) => t.name === "finish");
    const schema = z.object(finishTool!.inputSchema as z.ZodRawShape);
    const base = { result: "r", draft: "d", notify: true };
    expect(schema.safeParse(base).success).toBe(false);
    expect(schema.safeParse({ ...base, verification: [] }).success).toBe(false);
    expect(
      schema.safeParse({
        ...base,
        verification: [{ requirement: "req", met: true, evidence: "seen" }],
      }).success,
    ).toBe(true);
  });

  it("finish on an already-terminal task is an error, no artifact forced", async () => {
    markTerminal(db, { id: "t1", state: "cancelled", outcomeDetail: "user", finishedAt: 1500 });
    const rt = runtime(db, contextDir);
    const r = await handler(rt, "finish")({
      result: "r",
      draft: "d",
      notify: true,
      verification: [{ requirement: "req", met: true, evidence: "seen" }],
    });
    expect(r.isError).toBe(true);
    expect(payload(r).error).toBe("task_not_active");
    expect(getBackgroundTask(db, "t1")?.state).toBe("cancelled");
    expect(getBackgroundTask(db, "t1")?.report).toBeNull();
  });

  it("ask_user parks the task + writes a clarification + sets yieldFlag", async () => {
    const rt = runtime(db, contextDir);
    const r = await handler(rt, "ask_user")({ question: "web or api?", contextSummary: "scoping" });
    expect(r.isError).toBeFalsy();
    expect(payload(r).status).toBe("parked");
    expect(rt.yieldFlag.current).toBe(true);
    expect(getBackgroundTask(db, "t1")?.state).toBe("awaiting_user");
    const clars = listClarificationsForTask(db, "t1");
    expect(clars).toHaveLength(1);
    expect(clars[0].question).toBe("web or api?");
  });

  it("ask_user on a non-running task errors without an orphan clarification", async () => {
    markTerminal(db, { id: "t1", state: "cancelled", outcomeDetail: "user", finishedAt: 1500 });
    const rt = runtime(db, contextDir);
    const r = await handler(rt, "ask_user")({ question: "q" });
    expect(r.isError).toBe(true);
    expect(payload(r).error).toBe("task_not_running");
    expect(listClarificationsForTask(db, "t1")).toHaveLength(0);
  });

  it("read_memory returns an allowlisted file's content, empty for a missing one", async () => {
    // seed the profile file
    const profilePath = join(contextDir, CONTEXT_RELATIVE_PATHS.user.profile);
    mkdirSync(join(contextDir, "identity"), { recursive: true });
    writeFileSync(profilePath, "# Owner\nPrefers concise answers.", "utf-8");
    const rt = runtime(db, contextDir);
    const hit = await handler(rt, "read_memory")({ key: "profile" });
    expect(payload(hit)).toMatchObject({ ok: true, key: "profile" });
    expect(String(payload(hit).content)).toContain("Prefers concise");
    // missing file → ok with empty content (a fresh vault is normal)
    const miss = await handler(rt, "read_memory")({ key: "goals" });
    expect(payload(miss)).toMatchObject({ ok: true, content: "" });
  });
});
