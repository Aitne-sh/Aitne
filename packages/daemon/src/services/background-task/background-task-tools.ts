/**
 * Background-task worker tools — BACKGROUND_TASK_RUNNER_DESIGN.md §4.1 / §4.3.
 *
 * The generic worker's tool envelope. Unlike browser-task's 11-tool
 * Playwright plane, the background worker gets exactly three tools:
 *
 *   - `read_memory(key)` — READ-ONLY access to an allowlisted set of
 *     owner memory / profile files so the worker can personalize results
 *     itself rather than the brief enumerating everything (§9 / §10.4).
 *     The worker MUST NOT write shared memory — results come back as the
 *     artifact and the DM agent persists anything memory-worthy.
 *   - `ask_user(question, contextSummary)` — write a clarification
 *     artifact, park the task (`awaiting_user`), and end the turn. The
 *     runner surfaces it through the gated delivery boundary.
 *   - `finish(result, draft, notify, verification, significance?)` —
 *     WRITE THE ARTIFACT (verbatim `result` + plain `draft` summary + the
 *     `notify` disposition the worker evaluated against the spawn-time
 *     policy + a REQUIRED requirement-by-requirement `verification`
 *     checklist) and complete the task. Any unmet requirement marks the
 *     completion `completed_with_gaps` and appends a deterministic gap
 *     disclosure to the draft — structural honesty, no extra LLM call.
 *     The runner's reconcile hook reads the artifact and decides delivery.
 *
 * The tools do NOT send DMs or enqueue delivery — they only write to the
 * task store + transition state. Delivery is the runner's job (it owns
 * the `notify` gate + the `task.delivery` enqueue), keeping the
 * disposition decision in one place. This module is store-write glue,
 * excluded from the coverage gate; the pure decision (`notify` evaluation)
 * is the worker's, and the budget arithmetic is covered separately.
 */

import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { createClarification } from "../../db/background-task-clarifications-store.js";
import {
  markAwaitingUser,
  markTerminal,
} from "../../db/background-task-store.js";
import { CONTEXT_RELATIVE_PATHS, fullPath } from "../../core/context-paths.js";
import {
  noopBackgroundTaskTransitionEmitter,
  type BackgroundTaskTransitionEmitter,
} from "./background-task-transition-events.js";
import { createLogger } from "../../logging.js";

const logger = createLogger("background-task-tools");

export const BACKGROUND_TASK_MCP_SERVER_NAME = "aitne-task";

export const BACKGROUND_TASK_TOOL_FQNS = [
  `mcp__${BACKGROUND_TASK_MCP_SERVER_NAME}__read_memory`,
  `mcp__${BACKGROUND_TASK_MCP_SERVER_NAME}__ask_user`,
  `mcp__${BACKGROUND_TASK_MCP_SERVER_NAME}__finish`,
] as const;

/** Per-read output cap so a large memory file can't blow the worker's
 *  context window or budget in one tool call. */
const MEMORY_READ_CHAR_CAP = 8_000;

/** Cap on the comma-joined unmet-requirement list inside the automatic
 *  gap disclosure, so ten near-max (300-char) requirements can't balloon
 *  the persisted draft. */
const GAP_DISCLOSURE_LIST_CHAR_CAP = 600;

/**
 * Allowlist of READ-ONLY memory keys → vault-relative paths. A fixed
 * enum (no user-controlled path component) so there is no traversal
 * surface. Single files only; the worker reads what it needs to
 * personalize a result (the owner's profile, today's state, project
 * context, the management policy).
 */
const MEMORY_FILE_ALLOWLIST: Record<string, string> = {
  today: CONTEXT_RELATIVE_PATHS.today,
  profile: CONTEXT_RELATIVE_PATHS.user.profile,
  people: CONTEXT_RELATIVE_PATHS.user.people,
  work: CONTEXT_RELATIVE_PATHS.user.work,
  goals: CONTEXT_RELATIVE_PATHS.user.goals,
  projects: CONTEXT_RELATIVE_PATHS.projects.index,
  management: CONTEXT_RELATIVE_PATHS.rules.management,
  integrations: CONTEXT_RELATIVE_PATHS.integrations,
};

export const MEMORY_KEYS = Object.keys(MEMORY_FILE_ALLOWLIST) as readonly string[];

// The SDK `tool()` helper takes a Zod RAW SHAPE (a `{ key: ZodType }`
// object), not a `z.object(...)` — mirroring browser-task's schemas.
const readMemoryArgsSchema = {
  key: z
    .enum(Object.keys(MEMORY_FILE_ALLOWLIST) as [string, ...string[]])
    .describe(
      "Which owner memory file to read. One of: "
        + MEMORY_KEYS.join(", ")
        + ". Read-only.",
    ),
};

const askUserArgsSchema = {
  question: z
    .string()
    .min(1)
    .max(2_000)
    .describe(
      "The clarification you need from the owner, phrased plainly. The DM agent weaves this into the conversation.",
    ),
  contextSummary: z
    .string()
    .max(2_000)
    .optional()
    .describe(
      "Optional one-paragraph recap of where the task is and why you're stuck, so the owner can answer without re-reading the whole brief.",
    ),
};

const finishArgsSchema = {
  result: z
    .string()
    .min(1)
    .max(100_000)
    .describe(
      "The FULL, verbatim outcome — every finding, number, URL, and id. Persisted unchanged as the fidelity anchor; precise follow-ups read this. Do NOT summarize here.",
    ),
  draft: z
    .string()
    .min(1)
    .max(4_000)
    .describe(
      "A plain, human-readable summary in the owner's language. NOT the final DM — the DM agent uses this as grounding / the idle-send body. 1-4 short paragraphs.",
    ),
  notify: z
    .boolean()
    .describe(
      "Your disposition vs the spawn-time notification policy. always ⇒ true (even for a '0 issues' result — the owner asked). if_significant ⇒ true ONLY if the brief's concrete criteria are met. silent ⇒ false. When unsure on always, prefer true.",
    ),
  verification: z
    .array(
      z.object({
        requirement: z.string().min(1).max(300),
        met: z.boolean(),
        evidence: z.string().min(1).max(500),
      }),
    )
    .min(1)
    .max(10)
    .describe(
      "REQUIRED self-verification checklist. Derive the requirements from the brief's Expected output section (fallback: the Objective), then judge each against your ACTUAL result with concrete evidence. Any met=false completes the task with an automatic gap disclosure appended to the draft — never claim met=true without evidence.",
    ),
  significance: z
    .string()
    .max(500)
    .optional()
    .describe(
      "One line on why notify is true/false (e.g. '2 repos red' / 'no criteria met'). Used in the filed-results digest + audit.",
    ),
};

export interface BackgroundTaskRuntime {
  taskId: string;
  db: Database.Database;
  /** Vault root for `read_memory`. */
  contextDir: string;
  /** Clarification TTL in ms (from `backgroundTaskClarificationTtlMinutes`). */
  clarificationTtlMs: number;
  transitionEmitter: BackgroundTaskTransitionEmitter;
  abortSignal: AbortSignal;
  /** Set true once `ask_user` parks the task — read by the runner's
   *  post-execute hook to distinguish a clean park from a hang. */
  yieldFlag: { current: boolean };
  /** Set true once `finish` writes the artifact — read by the runner to
   *  confirm a clean completion vs an SDK-side natural end. */
  finishFlag: { current: boolean };
  nowFn?: () => number;
}

export function createBackgroundTaskRuntime(input: {
  taskId: string;
  db: Database.Database;
  contextDir: string;
  clarificationTtlMs: number;
  abortSignal: AbortSignal;
  transitionEmitter?: BackgroundTaskTransitionEmitter;
  nowFn?: () => number;
}): BackgroundTaskRuntime {
  return {
    taskId: input.taskId,
    db: input.db,
    contextDir: input.contextDir,
    clarificationTtlMs: input.clarificationTtlMs,
    abortSignal: input.abortSignal,
    transitionEmitter:
      input.transitionEmitter ?? noopBackgroundTaskTransitionEmitter,
    yieldFlag: { current: false },
    finishFlag: { current: false },
    nowFn: input.nowFn,
  };
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function textResult(payload: Record<string, unknown>, isError = false): ToolResult {
  return {
    isError,
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

function makeReadMemoryTool(runtime: BackgroundTaskRuntime) {
  return tool(
    "read_memory",
    "Read one owner memory / profile file (read-only) to personalize your result. Keys: "
      + MEMORY_KEYS.join(", ")
      + ". You cannot write memory — return everything memory-worthy in finish().",
    readMemoryArgsSchema,
    async (args): Promise<ToolResult> => {
      const relative = MEMORY_FILE_ALLOWLIST[args.key];
      if (!relative) {
        return textResult(
          { ok: false, error: "unknown_key", detail: `key must be one of: ${MEMORY_KEYS.join(", ")}` },
          true,
        );
      }
      const path = fullPath(runtime.contextDir, relative);
      try {
        const raw = await readFile(path, "utf-8");
        const truncated = raw.length > MEMORY_READ_CHAR_CAP;
        const content = truncated ? raw.slice(0, MEMORY_READ_CHAR_CAP) : raw;
        return textResult({
          ok: true,
          key: args.key,
          truncated,
          content: truncated
            ? `${content}\n\n[... truncated at ${MEMORY_READ_CHAR_CAP} chars]`
            : content,
        });
      } catch {
        // Missing file is normal (a fresh vault may not have every file).
        return textResult({
          ok: true,
          key: args.key,
          truncated: false,
          content: "",
          note: "file not present in the vault yet",
        });
      }
    },
  );
}

function makeAskUserTool(runtime: BackgroundTaskRuntime) {
  return tool(
    "ask_user",
    "Pause for an owner clarification. Writes the question, parks your task, and ends the turn — the DM agent surfaces it and relays the answer back so you resume. Call this and then STOP; do not call further tools this turn.",
    askUserArgsSchema,
    async (args): Promise<ToolResult> => {
      const now = (runtime.nowFn ?? (() => Date.now()))();
      // running → awaiting_user CAS before writing the clarification row.
      // On a CAS miss the task already transitioned (cancel-while-running)
      // — bail without committing an orphan row the deadline tick would
      // later process for a terminal task.
      const parked = markAwaitingUser(runtime.db, runtime.taskId);
      if (!parked) {
        return textResult(
          {
            ok: false,
            error: "task_not_running",
            detail: "This task is no longer running (it may have been cancelled). Stop now.",
          },
          true,
        );
      }
      const id = randomUUID();
      const row = createClarification(runtime.db, {
        id,
        taskId: runtime.taskId,
        question: args.question,
        contextSummary: args.contextSummary ?? null,
        askedAt: now,
        ttlMs: runtime.clarificationTtlMs,
      });
      runtime.yieldFlag.current = true;
      runtime.transitionEmitter.emitFromRow(parked, now);
      return textResult({
        ok: true,
        status: "parked",
        clarificationId: id,
        deadlineAt: row.deadlineAt,
        note: "Your task is parked. STOP now — the owner's answer will resume you.",
      });
    },
  );
}

function makeFinishTool(runtime: BackgroundTaskRuntime) {
  return tool(
    "finish",
    "Done. Writes your artifact (verbatim result + plain draft summary + the notify disposition + your self-verification checklist) and completes the task. Any unmet requirement is disclosed to the owner automatically. Do not call any tool after finish — your session ends here.",
    finishArgsSchema,
    async (args): Promise<ToolResult> => {
      const now = (runtime.nowFn ?? (() => Date.now()))();
      // Structural self-verification: any unmet requirement downgrades the
      // completion to `completed_with_gaps` and appends a deterministic
      // disclosure so the DM agent cannot present a gapped result as a
      // clean one. Notify is deliberately NOT overridden — the policy
      // evaluation stands; the gap only changes how the result is framed.
      const unmet = args.verification.filter((v) => !v.met);
      const passed = unmet.length === 0;
      let draft = args.draft;
      let significance = args.significance ?? null;
      if (!passed) {
        const gapSummary = `${unmet.length} of ${args.verification.length} requirements not fully met`;
        let unmetList = unmet.map((v) => v.requirement).join(", ");
        if (unmetList.length > GAP_DISCLOSURE_LIST_CHAR_CAP) {
          unmetList = `${unmetList.slice(0, GAP_DISCLOSURE_LIST_CHAR_CAP)}…`;
        }
        draft = `${draft}\n\nNote: ${gapSummary}: ${unmetList}`;
        significance = significance
          ? `completed_with_gaps; ${significance}`
          : `completed_with_gaps; ${gapSummary}`;
      }
      const terminal = markTerminal(runtime.db, {
        id: runtime.taskId,
        state: "completed",
        outcomeDetail: passed ? null : "completed_with_gaps",
        finishedAt: now,
        report: args.result,
        draft,
        notify: args.notify,
        significance,
        verification: args.verification,
      });
      if (!terminal) {
        // CAS miss — the task was already cancelled / timed out. Surface
        // it so the agent stops; the artifact is intentionally not forced
        // onto a terminal row.
        return textResult(
          {
            ok: false,
            error: "task_not_active",
            detail: "This task already reached a terminal state; the result was not stored. Stop now.",
          },
          true,
        );
      }
      runtime.finishFlag.current = true;
      runtime.transitionEmitter.emitFromRow(terminal, now);
      return textResult({
        ok: true,
        completed: true,
        notify: args.notify,
        state: terminal.state,
      });
    },
  );
}

/** The three worker tools, bound to a runtime. Exported so tests can
 *  invoke a tool's `handler` directly without standing up the MCP
 *  transport. */
export function createBackgroundTaskTools(runtime: BackgroundTaskRuntime) {
  return [
    makeReadMemoryTool(runtime),
    makeAskUserTool(runtime),
    makeFinishTool(runtime),
  ];
}

/** Construct the per-task MCP server. Returned config is passed verbatim
 *  into `query({ options: { mcpServers: { [BACKGROUND_TASK_MCP_SERVER_NAME]:
 *  <return value> } } })`. */
export function createBackgroundTaskMcpServer(
  runtime: BackgroundTaskRuntime,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: BACKGROUND_TASK_MCP_SERVER_NAME,
    version: "1.0.0",
    tools: createBackgroundTaskTools(runtime),
  });
}

void logger;
