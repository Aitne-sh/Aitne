/**
 * Browser-task driver — Playwright + Claude SDK glue for the
 * per-task sub-agent loop.
 *
 * BROWSER_TASK_REDESIGN_PLAN.md §5 / §14.x.
 *
 * Responsibilities:
 *
 *  1. Resolve `siteKey` → Instance A auth-profile dir + spawn the
 *     Chromium process via the existing `acquirePlaywrightContext`
 *     primitive (B-2.5 path).
 *  2. Install the §14.3 popup auto-close + §14.4 dialog / file-chooser
 *     / download auto-handle on the BrowserContext.
 *  3. Compose the per-task `aitne-browser` MCP server (see
 *     `browser-task-tools/server.ts`) bound to the live `Page`.
 *  4. Render the task workdir: empty dir + `CLAUDE.md` (agent
 *     profile) + the task-flow rendered into the user prompt. **No**
 *     SkillsCompiler.materialize call per §5.
 *  5. Drive the Claude Agent SDK `query()` call with
 *     `mcpServers`, `allowedTools` pinned to the 11 tools,
 *     `disallowedTools` merging the absolute-block layer +
 *     `Bash`/`Read`/`Write`/`Edit`/`WebFetch` for defence in depth,
 *     `maxTurns=30`, `maxBudgetUsd=$1.00`, `executeTimeoutMinutes=5`.
 *  6. Stream the SDK output until terminal. Honour the
 *     `AbortController` (§14.11 Q#4) by passing `abortController` into
 *     the SDK options.
 *  7. Detect the `blocked_request_spike > 100` shape (§14.2) via the
 *     recorder + flip the task to `failed`.
 *  8. Hand back a `DriverOutcome` the runner uses to flip terminal
 *     state + decide whether to release or PARK the BrowserContext
 *     (parked when the agent called `yield_for_clarification` or the
 *     final-confirm gate is mid-flight).
 *
 * Excluded from the 100% coverage gate — Playwright dynamic import +
 * SDK stream consumer. The pure sub-pieces (tool schemas, guards,
 * gates, loop-guard, extract-cap, screenshot-output) live in the
 * covered set under `browser-task-tools/`.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type Database from "better-sqlite3";
import {
  query,
  type McpServerConfig,
} from "@anthropic-ai/claude-agent-sdk";

import { getTaskFlow } from "../../core/prompts.js";
import {
  ALWAYS_DISALLOWED_TOOLS,
} from "../../safety/always-disallowed.js";
import { BROWSER_TASK_ALLOWLIST_REGEX_FLAGS } from "./browser-task-allowlist.js";
import {
  acquirePlaywrightContext,
  type AcquirePlaywrightContextResult,
  type ManagedPlaywrightHandle,
} from "../browser-history/managed-chromium/cdp-connect.js";
import { insertBrowserTaskActionLog } from "../../db/browser-task-action-log-store.js";
import {
  getBrowserTask,
  incrementBlockedRequests,
  type BrowserTaskRow,
} from "../../db/browser-task-store.js";
import type { HostProfile } from "../browser-history/types.js";
import { createLogger } from "../../logging.js";
import {
  BROWSER_TASK_MCP_SERVER_NAME,
  BROWSER_TASK_TOOL_FQNS,
} from "../browser-history/automation/browser-task-tools/schemas.js";
import {
  createBrowserTaskMcpServer,
  createBrowserTaskRuntime,
  type BrowserTaskMcpNotifier,
  type BrowserTaskRuntime,
  type PageLike,
} from "../browser-history/automation/browser-task-tools/server.js";
import type { FinalConfirmHandler } from "../browser-history/automation/final-confirm-handler.js";
import type { BrowserTaskTransitionEmitter } from "./browser-task-transition-events.js";

const logger = createLogger("browser-task-driver");

/** §5 — per-task envelope DEFAULTS. The live values come from
 *  `process_backend_config` (§6.1) at runtime via
 *  `loadBrowserTaskBackendBinding` so the operator's `/settings/models`
 *  tier picks (Sonnet / Opus / Haiku, custom turn / budget caps) flow
 *  through. These constants are the fallback the driver uses when the
 *  DB row is missing (fresh install racing schema apply) AND the upper
 *  bound the driver clamps user-supplied values to so a runaway dashboard
 *  edit can't blow past the §5 safety envelope. */
export const BROWSER_TASK_DEFAULT_MAX_TURNS = 30;
export const BROWSER_TASK_DEFAULT_MAX_BUDGET_USD = 1.0;
/** Hard upper bounds the driver clamps against. The seed row sits at
 *  the defaults; the bounds give the operator room to relax + a ceiling
 *  the §5 safety floor cannot be edited past. The $10 budget ceiling
 *  reflects that a single multimodal browser turn on Sonnet (≤ 1MB PNG +
 *  a ≤ 32 KB DOM snapshot) can spend a few cents, and a 30-turn loop
 *  that legitimately needs every turn lands under $10 — sites with
 *  heavier per-page extraction (long IR pages, multi-step research)
 *  routinely exceed $5 before they finish. */
export const BROWSER_TASK_MAX_TURNS_CAP = 60;
export const BROWSER_TASK_MAX_BUDGET_USD_CAP = 10.0;
export const BROWSER_TASK_EXECUTE_TIMEOUT_MINUTES = 5;
/** §14.2 — abort the task when the per-task CDP block counter spikes. */
export const BROWSER_TASK_BLOCKED_REQUEST_ABORT_THRESHOLD = 100;
/** Default Claude model id the driver falls back to when the DB row is
 *  missing or carries an empty `main_model`. Mirrors the seed default
 *  (`DEFAULT_CLAUDE_MEDIUM_MODEL`). */
const BROWSER_TASK_FALLBACK_CLAUDE_MODEL = "claude-sonnet-5";

interface BrowserTaskBackendBinding {
  modelId: string;
  maxTurns: number;
  maxBudgetUsd: number;
}

/**
 * Resolve the live `(modelId, maxTurns, maxBudgetUsd)` envelope for
 * `browser_task` from `process_backend_config`. The function is the
 * single chokepoint that translates an operator-editable DB row into
 * the SDK call's `model` / `maxTurns` / `maxBudgetUsd` options.
 *
 * Three branches:
 *
 *   1. Row present + `main_backend === 'claude'` → honour
 *      `main_model` (or fall back to the constant when the column is
 *      empty), clamp the turn / budget caps into the safe range, and
 *      return.
 *   2. Row present + `main_backend !== 'claude'` → REFUSE. §5 declares
 *      browser_task Claude-only and `BROWSER_HISTORY_PROCESS_KEYS`
 *      locks the dashboard surface to Claude; a non-Claude row is a
 *      manual DB edit the safety floor would have rejected. Returning
 *      a soft "use the constant" here would silently launch Claude
 *      with whatever model id the operator typed — bypassing the
 *      eligibility floor. Hard-fail with `backend_misconfigured` so
 *      the parent task transitions to `failed` and the user gets a DM.
 *   3. Row missing OR SELECT throws → fall back to constants, log warn.
 *      A fresh install before `applySchema` seeds the row hits this
 *      path; treating it as "use the §5 default envelope" is the
 *      safe-by-default behaviour.
 *
 * The clamp is one-sided: values below the defaults are honoured
 * (operator wants stricter caps); values above the caps are reduced
 * to the cap (operator's lax pin can't bypass the §5 safety envelope).
 */
function loadBrowserTaskBackendBinding(
  db: Database.Database,
):
  | { ok: true; binding: BrowserTaskBackendBinding }
  | { ok: false; reason: "backend_misconfigured"; detail: string } {
  let row:
    | {
        main_backend: string;
        main_model: string | null;
        max_turns: number | null;
        max_budget_usd: number | null;
      }
    | undefined;
  try {
    row = db
      .prepare(
        `SELECT main_backend, main_model, max_turns, max_budget_usd
           FROM process_backend_config
          WHERE process_key = 'browser_task'`,
      )
      .get() as typeof row;
  } catch (err) {
    logger.warn(
      { err },
      "browser-task: process_backend_config read failed; falling back to seeded envelope",
    );
    return {
      ok: true,
      binding: {
        modelId: BROWSER_TASK_FALLBACK_CLAUDE_MODEL,
        maxTurns: BROWSER_TASK_DEFAULT_MAX_TURNS,
        maxBudgetUsd: BROWSER_TASK_DEFAULT_MAX_BUDGET_USD,
      },
    };
  }
  if (!row) {
    logger.warn(
      "browser-task: process_backend_config row missing for 'browser_task'; falling back to seeded envelope",
    );
    return {
      ok: true,
      binding: {
        modelId: BROWSER_TASK_FALLBACK_CLAUDE_MODEL,
        maxTurns: BROWSER_TASK_DEFAULT_MAX_TURNS,
        maxBudgetUsd: BROWSER_TASK_DEFAULT_MAX_BUDGET_USD,
      },
    };
  }
  if (row.main_backend !== "claude") {
    return {
      ok: false,
      reason: "backend_misconfigured",
      detail: `process_backend_config.main_backend='${row.main_backend}' — browser_task is Claude-only (BROWSER_HISTORY_PROCESS_KEYS); refusing to dispatch`,
    };
  }
  const modelId =
    typeof row.main_model === "string" && row.main_model.length > 0
      ? row.main_model
      : BROWSER_TASK_FALLBACK_CLAUDE_MODEL;
  const rawTurns =
    typeof row.max_turns === "number" && Number.isFinite(row.max_turns)
      ? Math.max(1, Math.floor(row.max_turns))
      : BROWSER_TASK_DEFAULT_MAX_TURNS;
  const rawBudget =
    typeof row.max_budget_usd === "number" && Number.isFinite(row.max_budget_usd) && row.max_budget_usd > 0
      ? row.max_budget_usd
      : BROWSER_TASK_DEFAULT_MAX_BUDGET_USD;
  const maxTurns = Math.min(rawTurns, BROWSER_TASK_MAX_TURNS_CAP);
  const maxBudgetUsd = Math.min(rawBudget, BROWSER_TASK_MAX_BUDGET_USD_CAP);
  if (rawTurns > BROWSER_TASK_MAX_TURNS_CAP) {
    logger.warn(
      { configured: rawTurns, clamped: maxTurns },
      "browser-task: process_backend_config.max_turns exceeds §5 cap; clamping",
    );
  }
  if (rawBudget > BROWSER_TASK_MAX_BUDGET_USD_CAP) {
    logger.warn(
      { configured: rawBudget, clamped: maxBudgetUsd },
      "browser-task: process_backend_config.max_budget_usd exceeds §5 cap; clamping",
    );
  }
  return {
    ok: true,
    binding: { modelId, maxTurns, maxBudgetUsd },
  };
}

export interface DriverDeps {
  db: Database.Database;
  paDataDir: string;
  /** Workspace dir root — used to resolve the agent-profile MD
   *  (`agent-assets/agent-profiles/browser-task.md`). */
  workspaceDir: string;
  hostProfile: HostProfile;
  finalConfirmHandler: FinalConfirmHandler;
  notifier: BrowserTaskMcpNotifier;
  /** BROWSER_TASK_REDESIGN_PLAN.md §9a.5 Shape B — driven through into
   *  each per-task `BrowserTaskRuntime` so the tool layer (ask_user,
   *  final-confirm gate, finish) can emit transitions to the dashboard
   *  SSE stream. Optional — when absent, the tool layer falls back to
   *  the no-op emitter so test fixtures don't need to stand up an
   *  EventBroadcaster. */
  transitionEmitter?: BrowserTaskTransitionEmitter;
  /** Override for tests; production wires `() => Date.now()`. */
  nowFn?: () => number;
  /**
   * Live getter for the user-curated hostname denylist. Called once
   * per task (at `prepareDriverHandle`) so a Dashboard PATCH /api/config
   * takes effect on the **next** browser-task — no daemon restart
   * needed. Implemented as a thunk (not a precompiled array) because
   * `runtime-settings.browserTaskHostnameDenylist` is hot-mutable via
   * `applyConfigUpdates` and the driver should not capture a stale
   * compilation. Returns an empty array when no entries are configured.
   */
  getHostnameDenylist?: () => ReadonlyArray<RegExp>;
}

export interface DriverHandle {
  /** The live AbortController — the runner stashes it in its in-memory
   *  map so a `/cancel` POST can abort an in-flight SDK query (§14.11
   *  Q#4). */
  abortController: AbortController;
  /** The Playwright handle owning the BrowserContext + Page + recorder.
   *  Released when the driver decides the task terminates;
   *  retained-in-map when the runner parks the task for clarify. */
  playwrightHandle: ManagedPlaywrightHandle;
  /** Live Page — runtime.pageRef.current points at this. */
  page: PageLike;
  /** Per-task workdir under PA_DATA_DIR. Removed on terminal release. */
  cwd: string;
  /** Per-task runtime container (mutable refs for popup swap, loop
   *  guard, extract cap, yield/finish flags). */
  runtime: BrowserTaskRuntime;
  /** SDK session id captured from the init message. Null when the
   *  SDK never sent an init (early failure). */
  sdkSessionId: string | null;
  /** Last persisted blocked-request count for this task. The Playwright
   *  recorder is cumulative across the handle's lifetime; we need the
   *  delta-since-last-persist to keep `browser_task.blocked_requests_count`
   *  monotonically correct across initial + every resume turn. */
  lastPersistedBlockedRequests: number;
  /** Model / turn / budget envelope resolved at `prepareDriverHandle`
   *  time. Pinned for the task's lifetime — a mid-task operator change
   *  to `process_backend_config.main_model` (between yield and clarify
   *  resume) is INTENTIONALLY ignored so the SDK prompt cache + per-turn
   *  cost accounting stay consistent. The next task picks up the new
   *  value. */
  binding: BrowserTaskBackendBinding;
}

export interface DriverRunResult {
  /** Why the driver exited. */
  outcome:
    | "completed" // agent called finish()
    | "yielded_for_clarification" // agent yielded for ask_user
    | "yielded_for_final_confirm" // mid-flight final-confirm gate (rare — usually completes inside the tool)
    | "failed_ask_user_without_yield" // post-execute hook detected
    | "max_turns_exceeded"
    | "budget_exceeded"
    | "blocked_request_spike"
    | "tool_loop_detected"
    | "timeout"
    | "cancelled"
    | "sdk_error"
    | "site_unregistered"
    | "playwright_unavailable"
    /** process_backend_config row carries main_backend != 'claude' — see
     *  loadBrowserTaskBackendBinding. */
    | "backend_misconfigured";
  /** SDK session id, when available. */
  sdkSessionId: string | null;
  /** Free-form detail surfaced to the audit / DM. */
  detail?: string | null;
  /** Token / cost telemetry. */
  costUsd: number;
  numTurns: number;
  durationMs: number;
}

/**
 * Acquire a fresh BrowserContext + workdir + runtime for `row`. The
 * runner calls this BEFORE calling `runDriver` so it can stash the
 * resulting handle in its parked-task map before any agent turn fires
 * (a yield-for-clarification on the first turn must find the handle
 * already there).
 */
export async function prepareDriverHandle(input: {
  deps: DriverDeps;
  row: BrowserTaskRow;
}): Promise<
  | { ok: true; handle: DriverHandle }
  | { ok: false; reason: DriverRunResult["outcome"]; detail?: string }
> {
  const { deps, row } = input;
  // 2026-05-27 open-navigation revision — `siteKey === null` rows are
  // the canonical browser-task path and carry `effective_allowlist_regex
  // === null` by construction (the route's `composeAllowlistRegex(
  // { siteKey: null })` always returns `composedSource: null`). The
  // downstream Playwright branch installs no positive selector at the
  // CDP layer; CDP per-request route gating is the user-curated hostname
  // denylist + network IP CIDR (egress-denylist). The payment-path URL
  // block is NOT a CDP route gate — it is enforced in the `navigate` tool,
  // pre-flight on the agent-supplied URL and again on the post-redirect
  // final URL.
  //
  // The guard here only rejects the legacy-corruption shape — a row
  // that DOES pin a siteKey but is missing its allowlist regex. The
  // auth-variant Playwright branch needs a positive selector to scope
  // the signed-in BrowserContext, so a null regex on that path is an
  // unrecoverable DB state, not an open-nav-style "denylist-only" run.
  if (row.siteKey !== null && !row.effectiveAllowlistRegex) {
    return {
      ok: false,
      reason: "site_unregistered",
      detail:
        "legacy browser_task row pins siteKey but is missing effective_allowlist_regex",
    };
  }

  // F4 — pin the model / turn / budget envelope BEFORE spawning Playwright
  // so a misconfigured backend fails fast (no wasted Chromium process)
  // AND the binding is frozen for the task's lifetime (no surprise swap
  // between yield and clarify resume).
  const bindingResult = loadBrowserTaskBackendBinding(deps.db);
  if (!bindingResult.ok) {
    return {
      ok: false,
      reason: "backend_misconfigured",
      detail: bindingResult.detail,
    };
  }

  // 2026-05-27 open-navigation revision — `effectiveAllowlistRegex`
  // is now NULL for new tasks (the API drops the siteKey/extraAllowedHosts
  // composition path). Legacy rows that still carry a source string are
  // honored as the positive selector; null rows install no positive
  // selector at the CDP layer (denylist-only gating).
  const allowlistRegex =
    row.effectiveAllowlistRegex === null
      ? null
      : new RegExp(
          row.effectiveAllowlistRegex,
          BROWSER_TASK_ALLOWLIST_REGEX_FLAGS,
        );

  // 2026-05-27 open-navigation revision — when siteKey is null (the
  // new browser-task default) launch an anonymous BrowserContext with
  // no per-site cookie jar; when a legacy row pins a siteKey, take the
  // B-2.5 signed-in profile path. The hostname denylist is read FRESH
  // here (not at deps-construction time) so a Dashboard save applies
  // on the next task without a daemon restart.
  const hostnameDenylist = deps.getHostnameDenylist?.() ?? undefined;
  const acquire: AcquirePlaywrightContextResult =
    row.siteKey === null
      ? await acquirePlaywrightContext({
          db: deps.db,
          host: deps.hostProfile,
          paDataDir: deps.paDataDir,
          workflowId: row.id,
          variant: "anon",
          allowlistRegex,
          hostnameDenylist,
        })
      : await acquirePlaywrightContext({
          db: deps.db,
          host: deps.hostProfile,
          paDataDir: deps.paDataDir,
          workflowId: row.id,
          variant: "auth",
          siteKey: row.siteKey,
          // Auth variant requires a real allowlistRegex; the open-nav
          // path takes the anon branch above, so allowlistRegex must be
          // non-null on this leg. A null here indicates a legacy row
          // with a siteKey but a null effective_allowlist_regex — fail
          // closed by recomposing from the site pattern.
          allowlistRegex:
            allowlistRegex
            ?? (() => {
              throw new Error(
                `browser_task ${row.id}: siteKey="${row.siteKey}" but effective_allowlist_regex is null — legacy row shape unsupported`,
              );
            })(),
          // User-managed hostname denylist applies to ALL variants
          // (anon / auth / purchase). The user's "don't reach this
          // host" intent is independent of whether the BrowserContext
          // carries signed-in cookies.
          hostnameDenylist,
        });
  if (!acquire.ok) {
    logger.warn(
      { taskId: row.id, siteKey: row.siteKey, reason: acquire.reason },
      "browser-task: playwright acquire failed",
    );
    return {
      ok: false,
      reason: "playwright_unavailable",
      detail: acquire.reason,
    };
  }
  const handle = acquire.handle;

  // Install popup / dialog / file-chooser / download auto-handle
  // (§14.3 + §14.4). The context.on('page') handler closes any
  // popup; per-page handlers dismiss dialogs, cancel file choosers,
  // and block downloads. Each emits a `browser_internal` audit row.
  const playwrightContext = handle.context as {
    on(event: "page", cb: (page: unknown) => void): void;
    pages(): unknown[];
    newPage(): Promise<unknown>;
  };
  const installPageHandlers = (rawPage: unknown): void => {
    const page = rawPage as {
      on: (event: string, cb: (...args: unknown[]) => unknown) => void;
      url: () => string;
      close: () => Promise<void>;
    };
    page.on("dialog", async (rawDialog: unknown) => {
      const dialog = rawDialog as {
        type: () => string;
        message: () => string;
        dismiss: () => Promise<void>;
      };
      writeInternalAudit(deps.db, row.id, "dialog_dismissed", {
        type: dialog.type(),
        message: dialog.message().slice(0, 200),
      });
      await dialog.dismiss().catch(() => {});
    });
    page.on("filechooser", async (chooser: unknown) => {
      writeInternalAudit(deps.db, row.id, "filechooser_cancelled", {});
      const c = chooser as { setFiles: (paths: readonly string[]) => Promise<void> };
      await c.setFiles([]).catch(() => {});
    });
    page.on("download", async (rawDownload: unknown) => {
      const dl = rawDownload as {
        url: () => string;
        suggestedFilename: () => string;
        cancel: () => Promise<void>;
      };
      writeInternalAudit(deps.db, row.id, "download_blocked", {
        url: dl.url().slice(0, 200),
        suggested: dl.suggestedFilename(),
      });
      await dl.cancel().catch(() => {});
    });
  };
  // The auth variant attaches to the persistent default context whose
  // initial page is whatever was already open in the profile. The anon
  // variant starts from an empty context and we must mint a Page to
  // bind tools to. Either way, this is the page the sub-agent drives —
  // NOT a popup. Bind it BEFORE installing the context-level popup
  // closer so the closer's `page` event handler is not yet attached
  // when `newPage()` fires its emit.
  let initialPage: unknown;
  const existingPages = playwrightContext.pages();
  if (existingPages.length > 0) {
    initialPage = existingPages[0];
  } else {
    initialPage = await playwrightContext.newPage();
  }
  installPageHandlers(initialPage);
  const page = initialPage as PageLike;

  // Any subsequent `page` event is a real popup (window.open /
  // target="_blank"). Close + audit per §14.3. Defense-in-depth: if a
  // late launch race ever re-fires the event for the page we already
  // bound, skip it rather than killing the task.
  playwrightContext.on("page", async (rawPage: unknown) => {
    if (rawPage === initialPage) return;
    const newPage = rawPage as {
      url: () => string;
      close: () => Promise<void>;
    };
    writeInternalAudit(deps.db, row.id, "popup_blocked", {
      url: newPage.url(),
    });
    await newPage.close().catch(() => {});
  });

  // Per-task workdir — empty dir + CLAUDE.md.
  const cwd = join(deps.paDataDir, "browser-task-sessions", row.id);
  await mkdir(cwd, { recursive: true });
  try {
    const profileBody = await readAgentProfileBody(deps.workspaceDir);
    await writeFile(join(cwd, "CLAUDE.md"), profileBody, "utf-8");
  } catch (err) {
    logger.warn(
      { err, taskId: row.id },
      "browser-task: agent profile read failed — proceeding with empty CLAUDE.md",
    );
    await writeFile(join(cwd, "CLAUDE.md"), "# Browser Task Sub-Agent\n", "utf-8");
  }

  const abortController = new AbortController();
  const runtime = createBrowserTaskRuntime({
    taskId: row.id,
    allowlistRegex,
    hostnameDenylist,
    requireFinalConfirm: row.requireFinalConfirm,
    originatingChannel: row.originatingChannel,
    paDataDir: deps.paDataDir,
    page,
    finalConfirmHandler: deps.finalConfirmHandler,
    notifier: deps.notifier,
    db: deps.db,
    abortSignal: abortController.signal,
    transitionEmitter: deps.transitionEmitter,
  });

  return {
    ok: true,
    handle: {
      abortController,
      playwrightHandle: handle,
      page,
      cwd,
      runtime,
      sdkSessionId: null,
      lastPersistedBlockedRequests: 0,
      binding: bindingResult.binding,
    },
  };
}

/**
 * Drive one SDK turn (the initial run, OR a resume after `/clarify`).
 *
 * The runner controls the lifecycle: it calls `prepareDriverHandle`
 * once, then `runDriver` for the initial turn, then `resumeDriver`
 * if the task parked for clarify. The handle's `playwrightHandle` /
 * `runtime` / `abortController` carry across.
 */
export async function runDriver(
  deps: DriverDeps,
  row: BrowserTaskRow,
  handle: DriverHandle,
): Promise<DriverRunResult> {
  const startMs = (deps.nowFn ?? (() => Date.now()))();
  const promptBody = renderTaskPrompt(row);
  return runQuery({
    deps,
    handle,
    row,
    prompt: promptBody,
    resume: null,
    startMs,
  });
}

/** Resume a parked task after `/clarify` lands the user's answer.
 *  Uses the persisted SDK session id so the prompt cache stays warm. */
export async function resumeDriver(
  deps: DriverDeps,
  row: BrowserTaskRow,
  handle: DriverHandle,
  userAnswer: string,
): Promise<DriverRunResult> {
  if (!handle.sdkSessionId) {
    return {
      outcome: "failed_ask_user_without_yield",
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
    prompt: userAnswer,
    resume: handle.sdkSessionId,
    startMs,
  });
}

interface RunQueryInput {
  deps: DriverDeps;
  handle: DriverHandle;
  row: BrowserTaskRow;
  prompt: string;
  resume: string | null;
  startMs: number;
}

async function runQuery(input: RunQueryInput): Promise<DriverRunResult> {
  const { deps, handle, row, prompt, resume, startMs } = input;
  const mcpServer = createBrowserTaskMcpServer(handle.runtime);
  const mcpServers: Record<string, McpServerConfig> = {
    [BROWSER_TASK_MCP_SERVER_NAME]: mcpServer as unknown as McpServerConfig,
  };

  // Binding was resolved + pinned at `prepareDriverHandle` time (F4).
  // We READ from `handle.binding` here rather than re-querying the DB so
  // an operator-side `/settings/models` change between yield and
  // clarify resume does NOT swap models mid-task.
  const binding = handle.binding;

  let sessionId: string | null = handle.sdkSessionId;
  let costUsd = 0;
  let numTurns = 0;
  let stopReason: string | null = null;
  let isError = false;
  let outcome: DriverRunResult["outcome"] = "completed";
  let detail: string | null = null;

  // SDK timeout wall — per §5 (executeTimeoutMinutes=5). Bind to the
  // abortController so a timeout AND a manual cancel both abort the
  // stream + signal `awaitReply`.
  const timeoutMs = BROWSER_TASK_EXECUTE_TIMEOUT_MINUTES * 60 * 1000;
  const timeoutTimer = setTimeout(() => {
    handle.abortController.abort(new Error("browser_task_execute_timeout"));
  }, timeoutMs);

  // Per-tool blocked-request spike sweep — §14.2. We poll the
  // recorder every 2s; when the count crosses the threshold we abort
  // the SDK stream.
  const spikeTimer = setInterval(() => {
    const count = handle.playwrightHandle.blockedRequests.list().length;
    if (count > BROWSER_TASK_BLOCKED_REQUEST_ABORT_THRESHOLD) {
      handle.abortController.abort(new Error("blocked_request_spike"));
    }
  }, 2_000);

  try {
    const stream = query({
      prompt,
      options: {
        ...(resume ? { resume } : {}),
        cwd: handle.cwd,
        model: binding.modelId,
        maxTurns: binding.maxTurns,
        maxBudgetUsd: binding.maxBudgetUsd,
        // §14.11 Q#4 — hand the SDK the same AbortController the runner /
        // tool body / timeout / spike-timer all signal through. Without
        // this the SDK keeps iterating after a `/cancel` arrives,
        // burning turns + cost up to the static caps even though every
        // other surface believes the task is done.
        abortController: handle.abortController,
        permissionMode: "dontAsk" as const,
        allowedTools: [...BROWSER_TASK_TOOL_FQNS],
        disallowedTools: [
          ...ALWAYS_DISALLOWED_TOOLS,
          // Redundant defence-in-depth — these are NOT in
          // `allowedTools`, so `dontAsk` already denies them, but
          // listing them explicitly ensures a future regression that
          // widens `allowedTools` cannot accidentally unlock them.
          "Bash",
          "Read",
          "Write",
          "Edit",
          "WebFetch",
          "WebSearch",
          "Glob",
          "Grep",
        ],
        mcpServers,
        // The agent profile in cwd/CLAUDE.md serves as the persistent
        // persona; settingSources includes "project" so the SDK auto-
        // loads it.
        settingSources: ["project"] as const,
        // Persist the session so /clarify can resume by id.
        persistSession: true,
        includePartialMessages: false,
      },
    });

    try {
      for await (const message of stream) {
        if (input.deps.nowFn) {
          // For tests — nothing to do; the message loop drives itself.
        }
        if (message.type === "system" && (message as { subtype?: string }).subtype === "init") {
          sessionId = (message as { session_id?: string }).session_id ?? sessionId;
          handle.sdkSessionId = sessionId;
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
        // Best-effort cleanup of any half-iterated stream.
        await (stream as { return?: (v?: unknown) => Promise<unknown> }).return?.(undefined);
      } catch {
        /* ignore */
      }
    }

    // Post-execute hook (§5 ergonomic guard). Read the current DB
    // state — the ask_user tool already moved the row to
    // `awaiting_user` if it fired, and the final-confirm gate moves
    // to `final_confirm`. The yield/finish flags on the runtime
    // distinguish a clean yield from a hallucinated "I'll just stop".
    const dbStateAfterStream =
      getBrowserTask(deps.db, row.id)?.state ?? "running";

    if (handle.abortController.signal.aborted) {
      const reason = handle.abortController.signal.reason;
      if (reason instanceof Error && reason.message === "browser_task_execute_timeout") {
        outcome = "timeout";
        detail = `executeTimeoutMinutes=${BROWSER_TASK_EXECUTE_TIMEOUT_MINUTES}`;
      } else if (reason instanceof Error && reason.message === "blocked_request_spike") {
        outcome = "blocked_request_spike";
        detail = `blocked_requests_count>${BROWSER_TASK_BLOCKED_REQUEST_ABORT_THRESHOLD}`;
      } else {
        outcome = "cancelled";
        detail = reason instanceof Error ? reason.message : String(reason ?? "abort");
      }
    } else if (isError && stopReason && /max_turns/i.test(stopReason)) {
      outcome = "max_turns_exceeded";
      detail = stopReason;
    } else if (isError && stopReason && /budget|cost/i.test(stopReason)) {
      outcome = "budget_exceeded";
      detail = stopReason;
    } else if (handle.runtime.finishFlag.current) {
      // The agent called finish() — the tool already wrote the
      // `completed` terminal transition + DMed the report. The
      // runner's reconcile step is idempotent on the terminal markTerminal.
      outcome = "completed";
    } else if (
      dbStateAfterStream === "awaiting_user"
      && handle.runtime.yieldFlag.current
    ) {
      // Proper yield — the agent called ask_user + yield_for_clarification.
      // The runner parks the BrowserContext for `/clarify`.
      outcome = "yielded_for_clarification";
    } else if (
      dbStateAfterStream === "awaiting_user"
      && !handle.runtime.yieldFlag.current
    ) {
      // §5 hard-rule violation: agent called ask_user but never
      // yielded; the SDK session ended (likely on maxTurns) leaving
      // the BrowserContext parked forever. Flip to failed +
      // outcome_detail='ask_user_without_yield' so the runner releases
      // the context.
      outcome = "failed_ask_user_without_yield";
      detail = "ask_user without yield_for_clarification";
    } else if (dbStateAfterStream === "final_confirm") {
      // Mid-flight final-confirm gate — the click/press_key tool
      // entered the gate but the SDK stream ended before the gate
      // resolved (could be cancel race, could be SDK shutdown). The
      // runner parks the handle so a token reply or cancel can still
      // unwind it.
      outcome = "yielded_for_final_confirm";
    } else if (isError) {
      outcome = "sdk_error";
      detail = stopReason ?? "sdk_isError";
    } else {
      // SDK stream ended cleanly but the agent never called
      // finish/yield. Treat as a soft failure so the runner releases
      // the context and the user gets a terminal DM.
      outcome = "failed_ask_user_without_yield";
      detail = "SDK stream ended without finish() or yield_for_clarification()";
    }
  } catch (err) {
    if (handle.abortController.signal.aborted) {
      outcome = "cancelled";
      detail = err instanceof Error ? err.message : String(err);
    } else {
      outcome = "sdk_error";
      detail = err instanceof Error ? err.message : String(err);
      logger.error(
        { err, taskId: row.id },
        "browser-task SDK query threw",
      );
    }
  } finally {
    clearTimeout(timeoutTimer);
    clearInterval(spikeTimer);
    // Persist the running per-task block counter so the dashboard's
    // detail page can render it without polling the recorder. The
    // recorder is CUMULATIVE for the lifetime of the Playwright handle
    // (initial run + every resume turn share one recorder), so persist
    // ONLY the delta since the last increment — without this guard a
    // task with N resumes would record `count * (N+1)` blocks instead
    // of `count`.
    try {
      const cumulative = handle.playwrightHandle.blockedRequests.list().length;
      const delta = cumulative - handle.lastPersistedBlockedRequests;
      if (delta > 0) {
        incrementBlockedRequests(deps.db, row.id, delta);
        handle.lastPersistedBlockedRequests = cumulative;
      }
    } catch (err) {
      /* c8 ignore start -- defensive */
      logger.warn(
        { err, taskId: row.id },
        "failed to persist blocked_requests_count",
      );
      /* c8 ignore stop */
    }
  }

  const durationMs = (deps.nowFn ?? (() => Date.now()))() - startMs;
  return {
    outcome,
    sdkSessionId: sessionId,
    detail,
    costUsd,
    numTurns,
    durationMs,
  };
}

/** Release the BrowserContext + Chromium + workdir. Called when the
 *  driver decides the task terminates (completed / failed / cancelled /
 *  timeout / abandoned). Idempotent.
 *
 *  Parked tasks (awaiting_user / final_confirm) do NOT call this — the
 *  runner stashes the handle in its parked-task map so /clarify can
 *  resume with the same Page state. */
export async function releaseDriverHandle(
  deps: DriverDeps,
  handle: DriverHandle,
): Promise<void> {
  try {
    await handle.playwrightHandle.release();
  } catch (err) {
    /* c8 ignore start -- defensive */
    logger.warn({ err }, "playwright handle release failed");
    /* c8 ignore stop */
  }
  try {
    await rm(handle.cwd, { recursive: true, force: true });
  } catch (err) {
    /* c8 ignore start -- defensive */
    logger.warn({ err, cwd: handle.cwd }, "browser-task workdir cleanup failed");
    /* c8 ignore stop */
  }
  void deps; // keep API shape for future telemetry
}

/** Read the bundled agent-profile body. Falls back to a minimal stub
 *  when the file is unreachable so the driver still spawns. */
async function readAgentProfileBody(workspaceDir: string): Promise<string> {
  const candidate = join(
    workspaceDir,
    "agent-assets",
    "agent-profiles",
    "browser-task.md",
  );
  return readFile(candidate, "utf-8");
}

/** Render the user-prompt body — concatenate the task-flow template
 *  with the user's actual task description. The task-flow is the
 *  policy document (`{context}` placeholder + hard rules + tool
 *  table); the description is the actual ask. */
function renderTaskPrompt(row: BrowserTaskRow): string {
  const flow = getTaskFlow("browser_task");
  const body = flow.length > 0 ? flow : "## Browser Task\n\n{context}\n";
  const contextBlock = renderContextBlock(row);
  return body
    .replace(/\{context\}/g, contextBlock)
    .concat(
      "\n\n## Your task\n\n",
      row.description,
      "\n",
    );
}

function renderContextBlock(row: BrowserTaskRow): string {
  return [
    "<task>",
    `<task_id>${row.id}</task_id>`,
    `<site_key>${row.siteKey ?? ""}</site_key>`,
    `<require_final_confirm>${row.requireFinalConfirm ? "true" : "false"}</require_final_confirm>`,
    `<originating_channel>${row.originatingChannel ?? ""}</originating_channel>`,
    "</task>",
  ].join("\n");
}

/** §14.3 / §14.4 — write a `browser_internal` audit row when the
 *  popup / dialog / filechooser / download auto-handler fires. */
function writeInternalAudit(
  db: Database.Database,
  taskId: string,
  kind: "popup_blocked" | "dialog_dismissed" | "filechooser_cancelled" | "download_blocked",
  detail: Record<string, unknown>,
): void {
  try {
    // The action log's step_index is monotonic per task; use a fresh
    // tail step rather than racing with the SDK tool calls.
    insertBrowserTaskActionLog(db, {
      taskId,
      stepIndex: nextInternalStepIndex(db, taskId),
      toolName: "browser_internal",
      args: detail,
      outcome: kind,
      blockedReason: null,
      screenshotKey: null,
      durationMs: 0,
      at: Date.now(),
    });
  } catch (err) {
    /* c8 ignore start -- defensive */
    logger.warn(
      { err, taskId, kind },
      "browser-task internal-audit row write failed",
    );
    /* c8 ignore stop */
  }
}

/** Standalone step-index reader so the internal-audit writer doesn't
 *  thread through the action-log store import order. */
function nextInternalStepIndex(db: Database.Database, taskId: string): number {
  const row = db
    .prepare<[string], { m: number | null }>(
      `SELECT MAX(step_index) AS m FROM browser_task_action_log WHERE task_id = ?`,
    )
    .get(taskId);
  return (row?.m ?? -1) + 1;
}
