/**
 * Per-task control bang-commands — `!status` (list the active detached
 * tasks) and `!stop <id>` (cancel one of them). BACKGROUND_TASK_RUNNER_
 * DESIGN.md Phase 4.
 *
 * Both run OUTSIDE the SessionGate (the bang interceptor in
 * `dispatcher-message-handler` runs before any agent backend, ahead of
 * the gate), so the owner can inspect and cancel a long-running worker
 * even while a DM turn is in flight or a delivery turn is gated. Both are
 * `runsWhilePaused: true` — pure DB reads + a runner abort, no LLM work.
 *
 * `!stop` is a PREFIX command. Bare `!stop` resolves to the exact-match
 * pause command (`commands-stop-start.ts`); `!stop <id>` falls through to
 * the prefix matcher here and cancels that single task. The two never
 * collide because the registry resolves exact matches before prefixes.
 */

import {
  getBackgroundTask,
  listBackgroundTasks,
  type BackgroundTaskRow,
} from "../../db/background-task-store.js";
import {
  getBrowserTask,
  listBrowserTasks,
  type BrowserTaskRow,
} from "../../db/browser-task-store.js";
import type { BangCommand, BangCommandContext, BangPrefixCommand } from "./registry.js";

/** A unified, kind-tagged view of one active detached task. */
interface ActiveTask {
  id: string;
  kind: "background" | "browser";
  state: string;
  title: string;
}

const BACKGROUND_ACTIVE_STATES = ["pending", "running", "awaiting_user"] as const;
const BROWSER_ACTIVE_STATES = [
  "pending",
  "running",
  "awaiting_user",
  "final_confirm",
] as const;

function backgroundTitle(row: BackgroundTaskRow): string {
  return row.title ?? row.brief.slice(0, 60);
}
function browserTitle(row: BrowserTaskRow): string {
  return row.description.slice(0, 60);
}

/** Gather every non-terminal background + browser task, newest first. */
function listActiveTasks(ctx: BangCommandContext): ActiveTask[] {
  const background = listBackgroundTasks(ctx.db, {
    states: [...BACKGROUND_ACTIVE_STATES],
    limit: 50,
  }).map(
    (row): ActiveTask => ({
      id: row.id,
      kind: "background",
      state: row.state,
      title: backgroundTitle(row),
    }),
  );
  const browser = listBrowserTasks(ctx.db, {
    states: [...BROWSER_ACTIVE_STATES],
    limit: 50,
  }).map(
    (row): ActiveTask => ({
      id: row.id,
      kind: "browser",
      state: row.state,
      title: browserTitle(row),
    }),
  );
  return [...background, ...browser];
}

/** Short, copy-pasteable id stem for the `!status` listing. The full id is
 *  a uuid v4; the first 8 chars are unique in practice and `!stop` accepts
 *  any unambiguous prefix. */
function shortId(id: string): string {
  return id.slice(0, 8);
}

function formatStatus(tasks: readonly ActiveTask[]): string {
  if (tasks.length === 0) {
    return "No background or browser tasks are running.";
  }
  const lines = tasks.map((t) => {
    const label =
      t.kind === "background" ? "bg" : "web";
    return `• [${label} ${shortId(t.id)}] ${t.state} — ${t.title}`;
  });
  const header =
    tasks.length === 1
      ? "1 active task:"
      : `${tasks.length} active tasks:`;
  return [
    header,
    ...lines,
    "",
    "Stop one with !stop <id> (the short id shown above is fine).",
  ].join("\n");
}

export const statusCommand: BangCommand = {
  name: "!status",
  title: "Task status",
  describe: "List running background / browser tasks",
  runsWhilePaused: true,
  handler: async (ctx) => {
    await ctx.notify(formatStatus(listActiveTasks(ctx)));
  },
};

/** Resolve the owner-typed id to a single active task. Accepts the full
 *  uuid or any unambiguous prefix (so the `!status` short id works). */
function resolveTarget(
  ctx: BangCommandContext,
  raw: string,
):
  | { kind: "ok"; task: ActiveTask }
  | { kind: "none" }
  | { kind: "ambiguous"; count: number } {
  const needle = raw.trim().toLowerCase();
  // Exact-id fast path — a full uuid lands here without scanning.
  const bg = getBackgroundTask(ctx.db, needle);
  if (bg && (BACKGROUND_ACTIVE_STATES as readonly string[]).includes(bg.state)) {
    return { kind: "ok", task: { id: bg.id, kind: "background", state: bg.state, title: backgroundTitle(bg) } };
  }
  const web = getBrowserTask(ctx.db, needle);
  if (web && (BROWSER_ACTIVE_STATES as readonly string[]).includes(web.state)) {
    return { kind: "ok", task: { id: web.id, kind: "browser", state: web.state, title: browserTitle(web) } };
  }
  // Prefix match across the active set.
  const matches = listActiveTasks(ctx).filter((t) =>
    t.id.toLowerCase().startsWith(needle),
  );
  if (matches.length === 1) return { kind: "ok", task: matches[0] };
  if (matches.length === 0) return { kind: "none" };
  return { kind: "ambiguous", count: matches.length };
}

export const stopTaskCommand: BangPrefixCommand = {
  prefix: "!stop",
  title: "Stop a task",
  describe: "Cancel one task by id (bare !stop pauses the agent)",
  runsWhilePaused: true,
  handler: async (ctx, args) => {
    const id = typeof args === "string" ? args : "";
    if (id.length === 0) {
      // Unreachable in practice — bare `!stop` resolves to the exact pause
      // command — but guard so a future resolver change can't crash here.
      await ctx.notify(
        "Usage: !stop <id> to cancel one task (run !status for ids). " +
          "Bare !stop pauses the whole agent.",
      );
      return;
    }
    const resolved = resolveTarget(ctx, id);
    if (resolved.kind === "none") {
      await ctx.notify(
        `No active task matches "${id}". Run !status to see what's running.`,
      );
      return;
    }
    if (resolved.kind === "ambiguous") {
      await ctx.notify(
        `"${id}" matches ${resolved.count} active tasks — add more characters of the id.`,
      );
      return;
    }
    const task = resolved.task;
    const cancel =
      task.kind === "background"
        ? ctx.cancelBackgroundTask
        : ctx.cancelBrowserTask;
    if (!cancel) {
      // Runner not wired (lite install / boot race). The row still exists;
      // tell the owner rather than silently dropping the request.
      await ctx.notify(
        `Can't stop that ${task.kind} task right now — the runner isn't available. ` +
          "Try again in a moment.",
      );
      return;
    }
    const ok = await cancel(task.id, "user_bang_stop");
    await ctx.notify(
      ok
        ? `Stopping the ${task.kind} task "${task.title}".`
        : `Couldn't stop "${task.title}" — it may have already finished.`,
    );
  },
};
