/**
 * Background-task driver — generic Claude Agent SDK glue for the
 * per-task worker loop. BACKGROUND_TASK_RUNNER_DESIGN.md §4.1.
 *
 * The browser-task driver's analogue, with the entire Playwright /
 * managed-Chromium / allowlist / final-confirm plane removed. A worker
 * is a plain `query()` session seeded with a SELF-CONTAINED brief and a
 * three-tool MCP envelope (`read_memory`, `ask_user`, `finish`) plus the
 * SDK's `WebSearch` / `WebFetch` for research-type work. It opts out of
 * the `<user>` / `<management_rules>` injection (`settingSources:
 * ["project"]`, as browser-task does) — the brief carries the context,
 * the output-language directive, persona hints for the `draft`, and the
 * notification policy / criteria.
 *
 * Responsibilities:
 *   1. Resolve the `(model, maxTurns, maxBudgetUsd, executeTimeout)`
 *      envelope from `process_backend_config` + the row's tier/budget
 *      (`background-task-budget.ts`), pinned for the task's lifetime.
 *   2. Render a per-task workdir (empty dir + CLAUDE.md agent profile).
 *   3. Drive `query()` until terminal, honouring the AbortController
 *      (cancel + timeout) — no Playwright resources to release.
 *   4. Hand back a `DriverRunResult` the runner maps to terminal state /
 *      park. On the death paths the artifact is NULL — the runner
 *      synthesizes the fail-loud artifact (§4.3).
 *
 * Excluded from the 100% coverage gate — SDK stream consumer. The pure
 * sub-pieces (budget envelope) live in the covered set.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type Database from "better-sqlite3";
import { query, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

import { getTaskFlow } from "../../core/prompts.js";
import { ALWAYS_DISALLOWED_TOOLS } from "../../safety/always-disallowed.js";
import {
  getBackgroundTask,
  setBackendSessionId,
  type BackgroundTaskRow,
} from "../../db/background-task-store.js";
import { createLogger } from "../../logging.js";
import {
  resolveBackgroundTaskEnvelope,
  type BackgroundTaskEnvelope,
  type BackgroundTaskProcessConfig,
} from "./background-task-budget.js";
import {
  BACKGROUND_TASK_MCP_SERVER_NAME,
  BACKGROUND_TASK_TOOL_FQNS,
  createBackgroundTaskMcpServer,
  createBackgroundTaskRuntime,
  type BackgroundTaskRuntime,
} from "./background-task-tools.js";
import {
  noopBackgroundTaskTransitionEmitter,
  type BackgroundTaskTransitionEmitter,
} from "./background-task-transition-events.js";

const logger = createLogger("background-task-driver");

/** SDK tools the worker may use beyond its MCP envelope. Research-type
 *  background tasks (the flagship category) need web access; everything
 *  filesystem/shell is denied (the worker must not read arbitrary host
 *  files or write shared memory — §10.4). */
const BACKGROUND_TASK_WEB_TOOLS = ["WebSearch", "WebFetch"] as const;

/** Defence-in-depth deny list. These are NOT in `allowedTools`, so
 *  `dontAsk` already denies them — listing them ensures a future
 *  regression that widens `allowedTools` cannot unlock filesystem/shell
 *  access. */
const BACKGROUND_TASK_EXTRA_DISALLOWED = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "NotebookEdit",
  "Glob",
  "Grep",
] as const;

/** Read the operator-editable envelope row for `background_task`. */
export function loadBackgroundTaskProcessConfig(
  db: Database.Database,
): BackgroundTaskProcessConfig | null {
  try {
    const row = db
      .prepare(
        `SELECT main_backend, main_model, max_turns, max_budget_usd
           FROM process_backend_config
          WHERE process_key = 'background_task'`,
      )
      .get() as
      | {
          main_backend: string;
          main_model: string | null;
          max_turns: number | null;
          max_budget_usd: number | null;
        }
      | undefined;
    if (!row) return null;
    return {
      mainBackend: row.main_backend,
      mainModel: row.main_model,
      maxTurns: row.max_turns,
      maxBudgetUsd: row.max_budget_usd,
    };
  } catch (err) {
    logger.warn(
      { err },
      "background-task: process_backend_config read failed; falling back to tier defaults",
    );
    return null;
  }
}

export interface DriverDeps {
  db: Database.Database;
  paDataDir: string;
  /** Workspace dir root — resolves the agent-profile MD. */
  workspaceDir: string;
  transitionEmitter?: BackgroundTaskTransitionEmitter;
  /** Vault root for the worker's `read_memory` tool. */
  contextDir: string;
  /** Clarification TTL in ms (`backgroundTaskClarificationTtlMinutes`). */
  clarificationTtlMs: number;
  /** Override for tests; production wires `() => Date.now()`. */
  nowFn?: () => number;
}

export interface DriverHandle {
  abortController: AbortController;
  cwd: string;
  runtime: BackgroundTaskRuntime;
  sdkSessionId: string | null;
  binding: BackgroundTaskEnvelope;
}

export interface DriverRunResult {
  outcome:
    | "completed" // worker called finish()
    | "yielded_for_clarification" // worker called ask_user + parked
    | "no_finish" // SDK ended cleanly but no finish/ask_user
    | "max_turns_exceeded"
    | "budget_exceeded"
    | "timeout"
    | "cancelled"
    | "sdk_error"
    | "resume_unavailable" // a resume attempt could not load the SDK session
    | "backend_misconfigured";
  sdkSessionId: string | null;
  detail?: string | null;
  costUsd: number;
  numTurns: number;
  durationMs: number;
}

/**
 * Acquire a fresh workdir + runtime + binding for `row`. The runner
 * calls this BEFORE `runDriver` so it can stash the handle in its parked
 * map before any turn fires (an ask_user on the first turn must find the
 * handle already there).
 */
export async function prepareDriverHandle(input: {
  deps: DriverDeps;
  row: BackgroundTaskRow;
}): Promise<
  | { ok: true; handle: DriverHandle }
  | { ok: false; reason: DriverRunResult["outcome"]; detail?: string }
> {
  const { deps, row } = input;

  // Pin the envelope BEFORE any work so a misconfigured backend fails
  // fast AND the binding is frozen for the task's lifetime (no surprise
  // model swap between yield and clarify resume).
  const resolved = resolveBackgroundTaskEnvelope({
    tier: row.tier,
    maxBudgetUsd: row.maxBudgetUsd,
    processConfig: loadBackgroundTaskProcessConfig(deps.db),
  });
  if (!resolved.ok) {
    return { ok: false, reason: "backend_misconfigured", detail: resolved.detail };
  }

  const cwd = join(deps.paDataDir, "background-task-sessions", row.id);
  await mkdir(cwd, { recursive: true });
  try {
    const profileBody = await readAgentProfileBody(deps.workspaceDir);
    await writeFile(join(cwd, "CLAUDE.md"), profileBody, "utf-8");
  } catch (err) {
    logger.warn(
      { err, taskId: row.id },
      "background-task: agent profile read failed — proceeding with minimal CLAUDE.md",
    );
    await writeFile(
      join(cwd, "CLAUDE.md"),
      "# Background Task Worker\n",
      "utf-8",
    );
  }

  const abortController = new AbortController();
  const runtime = createBackgroundTaskRuntime({
    taskId: row.id,
    db: deps.db,
    contextDir: deps.contextDir,
    clarificationTtlMs: deps.clarificationTtlMs,
    abortSignal: abortController.signal,
    transitionEmitter: deps.transitionEmitter,
    nowFn: deps.nowFn,
  });

  return {
    ok: true,
    handle: {
      abortController,
      cwd,
      runtime,
      sdkSessionId: row.backendSessionId,
      binding: resolved.envelope,
    },
  };
}

/** Drive the initial turn — the worker reads the brief and works. */
export async function runDriver(
  deps: DriverDeps,
  row: BackgroundTaskRow,
  handle: DriverHandle,
): Promise<DriverRunResult> {
  const startMs = (deps.nowFn ?? (() => Date.now()))();
  return runQuery({
    deps,
    handle,
    row,
    prompt: renderTaskPrompt(row),
    resume: null,
    startMs,
  });
}

/** Resume a parked task after `/clarify` lands the owner's answer. Uses
 *  the persisted SDK session id so the prompt cache stays warm. Works both
 *  in-process (warm parked handle) and across a daemon restart (the runner
 *  reconstructs the handle from the persisted `backend_session_id`); in the
 *  cross-restart case a session the SDK can no longer load surfaces as
 *  `resume_unavailable`. */
export async function resumeDriver(
  deps: DriverDeps,
  row: BackgroundTaskRow,
  handle: DriverHandle,
  userAnswer: string,
): Promise<DriverRunResult> {
  if (!handle.sdkSessionId) {
    return {
      outcome: "no_finish",
      sdkSessionId: null,
      detail: "no sdk session id captured — cannot resume",
      costUsd: 0,
      numTurns: 0,
      durationMs: 0,
    };
  }
  const startMs = (deps.nowFn ?? (() => Date.now()))();
  return runQuery({
    deps,
    handle,
    row,
    prompt: `The owner answered your clarification:\n\n${userAnswer}\n\nContinue the task.`,
    resume: handle.sdkSessionId,
    isResume: true,
    startMs,
  });
}

/**
 * BACKGROUND_TASK_RUNNER_DESIGN.md §10.2 / Phase 4 — resume a task that was
 * mid-execution when the daemon restarted, using the persisted SDK session
 * id (`backend_session_id`) so the warm transcript + prompt cache survive
 * the restart instead of re-running the brief from scratch. The runner
 * reconstructs the handle (`prepareDriverHandle` recreates the per-task
 * workdir + sets `sdkSessionId` from the row). When the SDK can no longer
 * load the session, this returns `resume_unavailable` and the runner falls
 * back to re-dispatch-from-brief — so resume is a pure optimization with no
 * regression.
 */
export async function resumeFromBootDriver(
  deps: DriverDeps,
  row: BackgroundTaskRow,
  handle: DriverHandle,
): Promise<DriverRunResult> {
  if (!handle.sdkSessionId) {
    return {
      outcome: "resume_unavailable",
      sdkSessionId: null,
      detail: "no persisted sdk session id — cannot resume across restart",
      costUsd: 0,
      numTurns: 0,
      durationMs: 0,
    };
  }
  const startMs = (deps.nowFn ?? (() => Date.now()))();
  return runQuery({
    deps,
    handle,
    row,
    prompt:
      "The daemon restarted while you were working on this task. Pick up "
      + "exactly where you left off and finish it. If you had already "
      + "gathered enough, call finish() now.",
    resume: handle.sdkSessionId,
    isResume: true,
    startMs,
  });
}

interface RunQueryInput {
  deps: DriverDeps;
  handle: DriverHandle;
  row: BackgroundTaskRow;
  prompt: string;
  resume: string | null;
  /** True for a resume attempt (clarify or boot). When the session never
   *  loads (no `init` message), the outcome is `resume_unavailable` rather
   *  than `sdk_error`/`no_finish`, so the runner can fall back cleanly. */
  isResume?: boolean;
  startMs: number;
}

async function runQuery(input: RunQueryInput): Promise<DriverRunResult> {
  const { deps, handle, row, prompt, resume, isResume = false, startMs } = input;
  const mcpServer = createBackgroundTaskMcpServer(handle.runtime);
  const mcpServers: Record<string, McpServerConfig> = {
    [BACKGROUND_TASK_MCP_SERVER_NAME]: mcpServer as unknown as McpServerConfig,
  };
  const binding = handle.binding;

  let sessionId: string | null = handle.sdkSessionId;
  let costUsd = 0;
  let numTurns = 0;
  let stopReason: string | null = null;
  let isError = false;
  let sawInit = false;
  let outcome: DriverRunResult["outcome"] = "completed";
  let detail: string | null = null;

  const timeoutMs = binding.executeTimeoutMinutes * 60 * 1000;
  const timeoutTimer = setTimeout(() => {
    handle.abortController.abort(new Error("background_task_execute_timeout"));
  }, timeoutMs);

  try {
    const stream = query({
      prompt,
      options: {
        ...(resume ? { resume } : {}),
        cwd: handle.cwd,
        model: binding.modelId,
        maxTurns: binding.maxTurns,
        maxBudgetUsd: binding.maxBudgetUsd,
        abortController: handle.abortController,
        permissionMode: "dontAsk" as const,
        allowedTools: [
          ...BACKGROUND_TASK_TOOL_FQNS,
          ...BACKGROUND_TASK_WEB_TOOLS,
        ],
        disallowedTools: [
          ...ALWAYS_DISALLOWED_TOOLS,
          ...BACKGROUND_TASK_EXTRA_DISALLOWED,
        ],
        mcpServers,
        // CLAUDE.md in cwd is the persona; settingSources includes
        // "project" so the SDK auto-loads it but NOT the daemon's
        // <user>/<management_rules> (the brief is self-contained).
        settingSources: ["project"] as const,
        persistSession: true,
        includePartialMessages: false,
      },
    });

    try {
      for await (const message of stream) {
        if (
          message.type === "system"
          && (message as { subtype?: string }).subtype === "init"
        ) {
          sawInit = true;
          const sid = (message as { session_id?: string }).session_id ?? null;
          if (sid) {
            sessionId = sid;
            handle.sdkSessionId = sid;
            // Persist so a /clarify resume (and the boot path) can find it.
            try {
              setBackendSessionId(deps.db, row.id, sid);
            } catch (err) {
              /* c8 ignore next 3 -- defensive */
              logger.warn({ err, taskId: row.id }, "setBackendSessionId failed (continuing)");
            }
          }
        } else if (message.type === "result") {
          const result = message as {
            stop_reason?: string;
            is_error?: boolean;
            total_cost_usd?: number;
            num_turns?: number;
          };
          stopReason = result.stop_reason ?? null;
          isError = !!result.is_error;
          costUsd += result.total_cost_usd ?? 0;
          numTurns = result.num_turns ?? numTurns;
        }
      }
    } finally {
      try {
        await (stream as { return?: (v?: unknown) => Promise<unknown> }).return?.(
          undefined,
        );
      } catch {
        /* ignore */
      }
    }

    const dbStateAfterStream =
      getBackgroundTask(deps.db, row.id)?.state ?? "running";

    if (handle.abortController.signal.aborted) {
      const reason = handle.abortController.signal.reason;
      if (
        reason instanceof Error
        && reason.message === "background_task_execute_timeout"
      ) {
        outcome = "timeout";
        detail = `executeTimeoutMinutes=${binding.executeTimeoutMinutes}`;
      } else {
        outcome = "cancelled";
        detail = reason instanceof Error ? reason.message : String(reason ?? "abort");
      }
    } else if (isResume && !sawInit) {
      // A resume attempt whose session never loaded — no `init` message
      // ever arrived (e.g. the SDK can no longer find the persisted
      // session after a restart). The runner falls back to re-dispatch
      // rather than fail-loud. Comes after the abort check so a cancel /
      // timeout during resume is still classified as such.
      outcome = "resume_unavailable";
      detail = "resume target session did not load (no init message)";
    } else if (isError && stopReason && /max_turns/i.test(stopReason)) {
      outcome = "max_turns_exceeded";
      detail = stopReason;
    } else if (isError && stopReason && /budget|cost/i.test(stopReason)) {
      outcome = "budget_exceeded";
      detail = stopReason;
    } else if (handle.runtime.finishFlag.current || dbStateAfterStream === "completed") {
      outcome = "completed";
    } else if (
      dbStateAfterStream === "awaiting_user"
      && handle.runtime.yieldFlag.current
    ) {
      outcome = "yielded_for_clarification";
    } else if (isError) {
      outcome = "sdk_error";
      detail = stopReason ?? "sdk_isError";
    } else {
      // Clean SDK end but the worker never called finish/ask_user. The
      // runner treats this as a fail-loud terminal.
      outcome = "no_finish";
      detail = "SDK stream ended without finish() or ask_user()";
    }
  } catch (err) {
    if (handle.abortController.signal.aborted) {
      outcome = "cancelled";
      detail = err instanceof Error ? err.message : String(err);
    } else if (isResume && !sawInit) {
      // The resume query threw before the session loaded — treat as a
      // recoverable "couldn't resume" rather than a hard SDK error so the
      // runner re-dispatches from brief.
      outcome = "resume_unavailable";
      detail = err instanceof Error ? err.message : String(err);
    } else {
      outcome = "sdk_error";
      detail = err instanceof Error ? err.message : String(err);
      logger.error({ err, taskId: row.id }, "background-task SDK query threw");
    }
  } finally {
    clearTimeout(timeoutTimer);
  }

  const durationMs = (deps.nowFn ?? (() => Date.now()))() - startMs;
  return { outcome, sdkSessionId: sessionId, detail, costUsd, numTurns, durationMs };
}

/** Remove the per-task workdir. Idempotent. Parked tasks (awaiting_user)
 *  do NOT call this — the runner keeps the handle in its parked map so
 *  /clarify can resume the warm SDK session. */
export async function releaseDriverHandle(
  deps: DriverDeps,
  handle: DriverHandle,
): Promise<void> {
  try {
    await rm(handle.cwd, { recursive: true, force: true });
  } catch (err) {
    /* c8 ignore start -- defensive */
    logger.warn({ err, cwd: handle.cwd }, "background-task workdir cleanup failed");
    /* c8 ignore stop */
  }
  void deps;
}

async function readAgentProfileBody(workspaceDir: string): Promise<string> {
  const candidate = join(
    workspaceDir,
    "agent-assets",
    "agent-profiles",
    "background-task.md",
  );
  return readFile(candidate, "utf-8");
}

/** Render the worker prompt: the `background_task` task-flow (tool
 *  policy + notify-disposition rules + output-language reminder) with the
 *  `{context}` block, then the self-contained brief. */
function renderTaskPrompt(row: BackgroundTaskRow): string {
  const flow = getTaskFlow("background_task");
  const body = flow.length > 0 ? flow : "## Background Task\n\n{context}\n";
  return body
    .replace(/\{context\}/g, renderContextBlock(row))
    .concat("\n\n## Your task (the brief)\n\n", row.brief, "\n");
}

function renderContextBlock(row: BackgroundTaskRow): string {
  const lines = [
    "<task>",
    `<task_id>${row.id}</task_id>`,
    `<title>${row.title ?? ""}</title>`,
    `<notification_policy>${row.notificationPolicy}</notification_policy>`,
  ];
  // Phase 4 if_significant criteria DSL (§4.3): when the spawn carried
  // structured criteria, render them as a numbered checklist so the
  // worker's notify decision is a deterministic per-criterion evaluation
  // rather than a free judgement. Only meaningful for `if_significant`;
  // injected only when present (else the worker falls back to the brief's
  // prose criteria).
  if (
    row.notificationPolicy === "if_significant"
    && row.significanceCriteria
    && row.significanceCriteria.length > 0
  ) {
    lines.push("<significance_criteria>");
    lines.push(
      "Set notify=true if AT LEAST ONE of these is met by your result; "
        + "otherwise notify=false. In `significance`, state which criteria "
        + "were met / unmet.",
    );
    row.significanceCriteria.forEach((c, i) => {
      lines.push(`${i + 1}. ${c}`);
    });
    lines.push("</significance_criteria>");
  }
  lines.push("</task>");
  return lines.join("\n");
}

void noopBackgroundTaskTransitionEmitter;
