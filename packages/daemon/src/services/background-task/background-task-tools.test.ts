import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

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

  it("finish writes the artifact + completes + sets finishFlag", async () => {
    const rt = runtime(db, contextDir);
    const r = await handler(rt, "finish")({
      result: "verbatim 42",
      draft: "two repos red",
      notify: true,
      significance: "2 red",
    });
    expect(r.isError).toBeFalsy();
    expect(payload(r)).toMatchObject({ completed: true, notify: true });
    expect(rt.finishFlag.current).toBe(true);
    const row = getBackgroundTask(db, "t1");
    expect(row?.state).toBe("completed");
    expect(row?.report).toBe("verbatim 42");
    expect(row?.draft).toBe("two repos red");
    expect(row?.notify).toBe(true);
  });

  it("finish on an already-terminal task is an error, no artifact forced", async () => {
    markTerminal(db, { id: "t1", state: "cancelled", outcomeDetail: "user", finishedAt: 1500 });
    const rt = runtime(db, contextDir);
    const r = await handler(rt, "finish")({ result: "r", draft: "d", notify: true });
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
