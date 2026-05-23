/**
 * `ScheduledTaskRunner` — owns every non-message dispatch path that
 * routes through the dispatcher's main `dispatch` switch:
 *   - `scheduled.task` (generic + repository run + git project doc +
 *     today_refresh + morning-routine retry);
 *   - `routine.morning_routine` retries (the wake-task fast path);
 *   - `routine.roadmap_refresh` (with the cross-request roadmap write
 *     lock + skip-on-conflict semantics);
 *   - `routine.skill_curation` (P22 §3.4 — optimizer workdir
 *     materialization + hard-clamped tool envelope);
 *   - the catch-all `executeDefault` for every routine that doesn't
 *     have its own dedicated runner method (today_refresh,
 *     evening_review, weekly_review, …).
 *
 * Plus the today.md utilities the morning-routine path consults
 * through callbacks: `rotateDayFiles`, `diagnoseTodayMdState`,
 * `hasCurrentAgentDayTodayMd`.
 *
 * Extracted from `core/dispatcher.ts` as part of phase D-2 of
 * `docs/design/appendices/file-split-plan.md`. Pattern B (stateful
 * coordinator): the runner has no mutable state of its own; it
 * borrows lazy accessors for the dispatcher's optimizer hooks
 * (set by `setSkillCurationHooks` after construction) and bridges
 * back into `MorningRoutineRunner.executeMorningRoutine` when a
 * morning-routine retry wake-task fires.
 *
 * Dispatcher entry points served:
 *   - `EventDispatcher.dispatch` switches on event type; each non-
 *     message branch now calls into a `runner.X()` method here
 *     (`executeScheduledTask`, `executeRoadmapRefresh`,
 *     `executeSkillCurationRoutine`, `executeDefault`);
 *   - `MorningRoutineRunner` uses `rotateDayFiles` /
 *     `diagnoseTodayMdState` via the dep callbacks the dispatcher
 *     wires at construction time.
 *
 * Shared-state references held:
 *   - `getMaterializeOptimizerWorkdir` / `getTeardownOptimizerWorkdir`
 *     — lazy accessors; the optimizer hooks are wired by
 *     `setSkillCurationHooks` after the dispatcher is constructed.
 *     Reading through the closures means the runner sees the current
 *     value at call time.
 *   - `roadmapWriteLock` — read-only reference to the dispatcher's
 *     write-lock manager. The runner calls `acquire` / `release` but
 *     does not own the manager's lifecycle.
 */

import type Database from "better-sqlite3";
import type {
  AgentTaskEvent,
  BackendId,
  Event,
  ProcessKey,
  RoutineEvent,
} from "@aitne/shared";
import {
  EventPriority,
  createEvent,
  formatSqliteDatetime,
  getAgentDayDateStr,
  isBackendId,
  isKnowledgeImportEvent,
  isRoutineEvent,
  resolveProcessKey,
} from "@aitne/shared";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentConfig } from "../config.js";
import { CONTEXT_RELATIVE_PATHS } from "./context-paths.js";
import { getContextDir } from "../config.js";
import {
  cleanupSessionWorkdir,
  ensureBackendMaterialized,
} from "./workdir.js";
import { readIntegrations, readIntegrationState } from "../db/integrations-store.js";
import { refreshInterestsReflection } from "../services/browser-history/refresh-interests-reflection.js";
import { InterestsReflectionLockBusyError } from "../services/browser-history/interests-reflection-lock.js";
import { findSectionLineBounds } from "./roadmap-validate.js";
import { writeFileAtomically } from "./atomic-write.js";
import {
  getRepository,
  getRepositoryByLocalPath,
  recordManagementInitDone,
  recordManagementScan,
  type RepositoryDTO,
} from "../db/repositories-store.js";
import {
  runRepositoryManagementInit,
  runRepositoryManagementScan,
} from "./repository-management-docs.js";
import type { IAgentRouter } from "./backends/backend-router.js";
import type { RoadmapWriteLockManager } from "./roadmap-write-lock.js";
import type { AgentWriteTracker } from "../safety/agent-write-tracker.js";
import type { MailAccount } from "../services/mail/provider.js";
import type { IContextBuilder } from "./dispatcher-types.js";
import type { PromptAssembler } from "./dispatcher-prompt.js";
import type { DispatcherErrorRouter } from "./dispatcher-error-handling.js";
import type { ResultProcessor } from "./dispatcher-result-processor.js";
import type { MorningRoutineRunner } from "./dispatcher-morning-routine.js";
import type { RoutineFetchWindowRunner } from "./routine-fetch-window-runner.js";
import { routineWindowKeyFromEvent } from "./routine-fetch-window-runner.js";
import { routineHasWindows } from "./routine-windows.js";
import { morningRoutineRanToday } from "../bootstrap/schedule-helpers.js";
import { releaseWikiCompileLock } from "./wiki/compile-lock.js";
import {
  parseGithubRepoSlug,
  normalizeRepositoryClassification,
  normalizeRepositoryCategory,
  parseRepositoryRunTaskContext,
  repositoryRunInstructionFilename,
  safeRepositoryRunDirName,
  type RepositoryRunTaskContext,
} from "./dispatcher-repository-helpers.js";
import { createLogger } from "../logging.js";

const logger = createLogger("dispatcher-scheduled-tasks");

/**
 * Mirror of the `MorningRoutineRunner.diagnoseTodayMdState` return
 * shape. Re-declared here because this runner owns the underlying
 * implementation; the morning-routine runner consumes it via the
 * dep callback the dispatcher wires at construction time.
 */
export type TodayMdState =
  | { kind: "fresh" }
  | { kind: "missing" }
  | { kind: "no_h1_date" }
  | { kind: "wrong_date"; writtenDate: string; expectedAgentDay: string };

/**
 * P22 §3.4 step 4 — the optimizer-only allowedTools envelope. Every
 * `routine.skill_curation` event runs the agent with exactly these tools
 * and nothing else. The curl glob is anchored on the daemon's loopback URL
 * so a hook-bypassed request still hits the curation API's chokepoint
 * (Zod, run-token, smoke test); `Read` is required for the agent to
 * consume the inlined data dump under the workdir's `data/` subtree.
 *
 * Kept narrow on purpose: adding any other tool here widens the optimizer's
 * blast radius. If a future signal source needs the agent to write to a
 * different surface, add a new curation API endpoint and let the curl glob
 * cover it — do NOT add `Bash(*)` or `Write` here.
 */
export const SKILL_CURATION_OPTIMIZER_ALLOWED_TOOLS = [
  "Read",
  "Bash(curl http://localhost:8321/api/skill-curation/*)",
] as const;

/**
 * Read-only tool envelope for `git.project.refresh_architecture`. This agent
 * walks the user's local git worktree at `<task_context.localPath>` to compose
 * the `## Architecture` section of `git/<slug>/overview.md`, and lands the
 * result through `PUT /api/repositories/:id/architecture-section` — the one
 * daemon-side chokepoint. Without this clamp the session would inherit
 * `CLAUDE_DEFAULT_ALLOWED_TOOLS` (Write/Edit/`Bash(git *)`/`Bash(curl *)`),
 * which would let a prompt-injected README or a misbehaving turn mutate the
 * user's repository (e.g. `git reset --hard`, `git push --force`, arbitrary
 * `Write` to source files) OR exfiltrate via other Autonomous daemon APIs
 * (`POST /api/notify` to DM the owner with attacker content, `POST
 * /api/observations` to inject fake observations, `PUT /api/obsidian/notes`
 * to overwrite vault notes, etc.). The Architecture analysis itself only
 * needs to *read* the worktree.
 *
 * What is INCLUDED and why:
 *   - `Read` / `Glob` / `Grep` — the task-flow's only durable need (README,
 *     manifests, source files, design docs). `Glob` covers the literal
 *     `ls <localPath>` step without giving the agent shell access.
 *   - `Bash(curl http://localhost:8321/api/repositories/*\/architecture-section*)`
 *     — endpoint-pinned write path. The SDK's prefix-glob layer forbids the
 *     command from reaching ANY other host, port, or daemon-API namespace.
 *     The curl PreToolUse hook adds defense-in-depth (rechecks host/port,
 *     denies connection-override flags); the API risk classifier supplies
 *     the floor (only `PUT .../architecture-section` is Autonomous under
 *     `/api/repositories/`; everything else inherits Approve and 401s a
 *     tokenless agent curl). Port is hardcoded to the daemon's default
 *     `8321` matching the optimizer-clamp convention; operators who change
 *     `PA_API_PORT` accept the gap consciously (the same constraint applies
 *     to `SKILL_CURATION_OPTIMIZER_ALLOWED_TOOLS`).
 *   - `Bash(jq *)` — body construction. The PUT body is
 *     `{"markdown":"..."}` and the markdown contains arbitrary characters
 *     that must be JSON-escaped; `jq -n --arg md "$body" '{markdown:$md}'`
 *     is the only robust escape path under a no-`Write` envelope. The jq
 *     hook denies `--slurpfile` / `--rawfile` / `-L` / `env`-filter
 *     exfiltration.
 *
 * What is INTENTIONALLY EXCLUDED:
 *   - `Write` / `Edit` — would let the agent write anywhere, including the
 *     user's checked-out worktree. The chokepoint is the daemon API.
 *   - `Bash(git *)` — even read-only verbs let the agent chain into
 *     `git push --force`, `git reset --hard`, `git checkout --`, etc. via
 *     shell separators; the `always-disallowed.ts` classifier hook catches
 *     `rm -rf` / `sudo` / pipe-to-shell but does NOT classify mutating git
 *     subcommands. The Architecture analysis doesn't need git CLI:
 *     filesystem reads via `Read` / `Glob` suffice for module / data-flow /
 *     build / test-surface description.
 *   - `Bash(ls *)` — `Glob` covers directory enumeration without shell
 *     access.
 *   - `Skill` / `WebSearch` — not referenced by the task-flow; smaller
 *     surface is better.
 *
 * Defense-in-depth layering:
 *   - SDK `allowedTools` (this list) — first gate. Prefix glob forces the
 *     curl command to literally begin with the architecture-section URL.
 *   - SDK `disallowedTools` — `ALWAYS_DISALLOWED_TOOLS` +
 *     `config.disallowedTools` still merge on top.
 *   - PreToolUse hooks — curl localhost-only + jq exfil bans + Write/Edit
 *     context-dir chokepoint stay armed. `claude-code-core.ts` forces
 *     strict hook mode (curl + jq hooks re-enabled) whenever any
 *     `allowedToolsOverride` is active, so Allow-mode operators do not
 *     inadvertently widen this surface — see the `optimizerClampActive`
 *     branch.
 *   - Allow mode bypass — `claude-code-core.ts` detects the non-empty
 *     `allowedToolsOverride` and forces `permissionMode: "dontAsk"` for
 *     this run, stripping `bypassPermissions` even if the operator has
 *     Allow mode globally enabled.
 *   - API risk classifier — `PUT /api/repositories/:id/architecture-section`
 *     is RiskTier.Autonomous (agent-callable, no Bearer required) but
 *     enforces marker-bracketed body validation and 64KB size cap
 *     server-side. All sibling routes under `/api/repositories/` inherit
 *     the blanket Approve tier and 401 a tokenless agent curl.
 *
 * Multi-request defenses (closed in `claude-tool-collection.ts:bashCurlHook`,
 * benefit every clamped session inheriting the curl hook):
 *   1. **Shell-chained second curl** — `curl ARCH_URL ; curl
 *      http://localhost:8321/api/notify -d @evil` and the `&&` / `||` /
 *      `|` / newline / backtick / `$(…)` variants. The hook counts
 *      `curl` tokens anchored at command-start positions (mirroring the
 *      `cmdStart` regex in `safety/always-disallowed.ts`) and blocks any
 *      command with more than one anchored `curl`. A single
 *      `jq -n '{markdown:$md}' | curl URL -d @-` pipeline still counts
 *      as ONE curl token and is allowed.
 *   2. **`--next` / `-:` URL multiplexing** — curl's same-process URL
 *      separator that resets option state per transaction. Hook-blocked
 *      via flag regex (covers `--next`, `--next=URL`, and the `-:`
 *      short form).
 *   3. **Multi-positional URLs** — `curl URL1 URL2 -X PUT -d @body`
 *      sends identical options to both URLs sequentially. The hook
 *      tokenizes the command at the top level (outside paired single /
 *      double quotes) and blocks when more than one URL appears as a
 *      top-level token. URLs that legitimately appear inside `-d '…'`
 *      / `-H "…"` strings — e.g. external links inside the architecture
 *      markdown body — are not counted and not host-checked, so the
 *      agent can reference external code in its analysis.
 *
 * Per-backend support:
 *   - Claude (`ClaudeCodeCore`) — consumes this list verbatim.
 *   - Codex / Gemini — no per-execute allowedTools surface today (mirrors
 *     `AgentExecuteParams.allowedToolsOverride` JSDoc). The default
 *     `process_backend_config` seed binds `git.project.refresh_architecture`
 *     to the medium tier (Sonnet), so the realistic risk surface today is
 *     Claude-only. An operator who reroutes this process key to a
 *     non-Claude backend via `/settings/models` accepts the gap
 *     consciously.
 */
export const REFRESH_ARCHITECTURE_ALLOWED_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Bash(curl http://localhost:8321/api/repositories/*/architecture-section*)",
  "Bash(jq *)",
] as const;

/**
 * Backends that honor the per-execute `allowedToolsOverride` clamp end-to-
 * end. Claude consumes the list verbatim through the SDK's `dontAsk` +
 * `allowedTools` posture and the dispatcher swaps Allow mode back to
 * strict for the run. Codex / Gemini have no per-execute allowedTools
 * surface today (see `AgentExecuteParams.allowedToolsOverride` JSDoc),
 * so the clamp would silently drop and the read-only contract would
 * become a no-op. We refuse-at-execute rather than silently widen the
 * envelope; the operator sees an `agent_actions` row of action_type
 * `scheduled_task_clamp_unsupported` and a clear log line.
 *
 * Add a backend here only after verifying its core threads
 * `allowedToolsOverride` through to its concrete deny enforcement layer
 * — NOT just into the CLI flag set.
 */
export const TOOL_CLAMP_SUPPORTING_BACKENDS: ReadonlySet<BackendId> = new Set<BackendId>([
  "claude",
]);

export interface ScheduledTaskRunnerDeps {
  db: Database.Database;
  config: AgentConfig;
  contextBuilder: IContextBuilder;
  agentRouter: IAgentRouter;
  prompt: PromptAssembler;
  errorRouter: DispatcherErrorRouter;
  resultProcessor: ResultProcessor;
  morningRoutine: MorningRoutineRunner;
  /**
   * docs/design/appendices/routine-data-acquisition.md Phase 4 / D4 — pre-pass runner
   * spawned by `executeDefault` for routine events whose ProcessKey is
   * in `ROUTINE_WINDOWS` (today_refresh / evening_review / weekly_review;
   * monthly_review is registered but has zero rows so the runner
   * short-circuits without dispatching a session). Idempotent against
   * the morning_routine + hourly_check paths: when the upstream
   * dispatcher already attached a `fetchReportBlock`, `executeDefault`
   * skips re-running the pre-pass.
   */
  fetchWindowRunner: RoutineFetchWindowRunner;
  roadmapWriteLock: RoadmapWriteLockManager | undefined;
  writeTracker: AgentWriteTracker | undefined;
  /**
   * Returns the dispatcher's currently-configured "services" the
   * agent's prompt should disclose. Read at call time so the hand-
   * off through index.ts's lazy ServiceRegistry stays correct.
   */
  getConfiguredServices: () => ReadonlySet<string>;
  /**
   * Returns the live mail-account list the workdir materializer
   * should bake into the session.
   */
  getActiveMailAccounts: () => readonly MailAccount[];
  /**
   * Lazy accessor for the optimizer materializer hook. Returns null
   * until `EventDispatcher.setSkillCurationHooks` has been called.
   */
  getMaterializeOptimizerWorkdir: () =>
    | ((opts?: {
        manual?: boolean;
        targetSkillsOverride?: string[];
      }) => Promise<{
        runId: string;
        runToken: string;
        workdirPath: string;
        targetSkills: string[];
      }>)
    | null;
  /** Lazy accessor for the optimizer teardown hook. */
  getTeardownOptimizerWorkdir: () => ((workdirPath: string) => void) | null;
}

export class ScheduledTaskRunner {
  private readonly db: Database.Database;
  private readonly config: AgentConfig;
  private readonly contextBuilder: IContextBuilder;
  private readonly agentRouter: IAgentRouter;
  private readonly prompt: PromptAssembler;
  private readonly errorRouter: DispatcherErrorRouter;
  private readonly resultProcessor: ResultProcessor;
  private readonly morningRoutine: MorningRoutineRunner;
  private readonly fetchWindowRunner: RoutineFetchWindowRunner;
  private readonly roadmapWriteLock: RoadmapWriteLockManager | undefined;
  private readonly writeTracker: AgentWriteTracker | undefined;
  private readonly getConfiguredServices: () => ReadonlySet<string>;
  private readonly getActiveMailAccounts: () => readonly MailAccount[];
  private readonly getMaterializeOptimizerWorkdir: ScheduledTaskRunnerDeps["getMaterializeOptimizerWorkdir"];
  private readonly getTeardownOptimizerWorkdir: ScheduledTaskRunnerDeps["getTeardownOptimizerWorkdir"];

  constructor(deps: ScheduledTaskRunnerDeps) {
    this.db = deps.db;
    this.config = deps.config;
    this.contextBuilder = deps.contextBuilder;
    this.agentRouter = deps.agentRouter;
    this.prompt = deps.prompt;
    this.errorRouter = deps.errorRouter;
    this.resultProcessor = deps.resultProcessor;
    this.morningRoutine = deps.morningRoutine;
    this.fetchWindowRunner = deps.fetchWindowRunner;
    this.roadmapWriteLock = deps.roadmapWriteLock;
    this.writeTracker = deps.writeTracker;
    this.getConfiguredServices = deps.getConfiguredServices;
    this.getActiveMailAccounts = deps.getActiveMailAccounts;
    this.getMaterializeOptimizerWorkdir = deps.getMaterializeOptimizerWorkdir;
    this.getTeardownOptimizerWorkdir = deps.getTeardownOptimizerWorkdir;
  }

  // ────── Repository run + scheduled task entry points ──────

  buildRepositoryRunPrompt(ctx: RepositoryRunTaskContext): string {
    const lines = [
      "{context}",
      "",
      "## Repository Run",
      `Repository id: ${ctx.repositoryId}`,
      `Repository slug: ${ctx.slug}`,
      `GitHub repo: ${ctx.githubRepo ?? "(none)"}`,
      `Local path: ${ctx.localPath ?? "(none)"}`,
      `Workdir mode: ${ctx.workdirMode}`,
      `Trigger source: ${ctx.triggerSource}`,
    ];
    if (ctx.triggerId || ctx.triggerName || ctx.triggerEventType) {
      lines.push(
        "",
        "## Trigger",
        `Trigger id: ${ctx.triggerId ?? "(manual)"}`,
        `Trigger name: ${ctx.triggerName ?? "(manual)"}`,
        `Event type: ${ctx.triggerEventType ?? "(manual)"}`,
      );
      if (ctx.triggerEventPayload !== undefined) {
        lines.push(
          "",
          "<trigger_event_payload>",
          JSON.stringify(ctx.triggerEventPayload, null, 2),
          "</trigger_event_payload>",
        );
      }
    }
    lines.push("", "## User Prompt", ctx.prompt);
    return lines.join("\n");
  }

  prepareRepositoryRunSessionDir(
    ctx: RepositoryRunTaskContext,
    backendId: BackendId,
  ): { sessionDir: string; cleanup: boolean } {
    // docs/design/appendices/skills-improvement.md §9-§11 + §14 / `evening-review-slimdown.md`
    // §3.5 — even though `scheduled.task`'s static manifest carries no
    // per-event predicate today, thread `contextDir`, `db`, and an
    // explicit `messageText = null` so this path stays symmetric with
    // every other materialise site (dispatcher-message-handler,
    // backend-core fresh sessions, index.ts fallback callback). Future
    // predicates added for `scheduled.task` will receive the correct
    // inputs without revisiting this file; threading `null` for
    // `messageText` documents the contract — repository runs never
    // surface inbound DM text — so a `*ForDm` predicate added later
    // will degrade cleanly to its base branch instead of silently
    // reading from `undefined`.
    const contextDir = getContextDir(this.config, this.db);
    if (ctx.workdirMode === "local-clone") {
      if (!ctx.localPath) {
        throw new Error("Repository local-clone run missing localPath");
      }
      ensureBackendMaterialized(
        this.config.workspaceDir,
        ctx.localPath,
        backendId,
        "scheduled.task",
        "agent.task",
        this.getConfiguredServices(),
        this.getActiveMailAccounts(),
        readIntegrations(this.db),
        this.config.character,
        undefined, // wikiWorkspaceName — repository runs are not wiki tasks
        contextDir,
        this.db,
        null,
      );
      return { sessionDir: ctx.localPath, cleanup: false };
    }

    if (!ctx.instructionMd) {
      throw new Error("Repository temp run missing instructionMd");
    }
    const sessionDir = join(
      this.config.dataDir,
      "run",
      `${safeRepositoryRunDirName(ctx.slug)}-${Date.now()}-${randomUUID().slice(0, 8)}`,
    );
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    try {
      ensureBackendMaterialized(
        this.config.workspaceDir,
        sessionDir,
        backendId,
        "scheduled.task",
        "agent.task",
        this.getConfiguredServices(),
        this.getActiveMailAccounts(),
        readIntegrations(this.db),
        this.config.character,
        undefined,
        contextDir,
        this.db,
        null,
      );
      writeFileSync(
        join(sessionDir, repositoryRunInstructionFilename(backendId)),
        ctx.instructionMd,
        "utf-8",
      );
      return { sessionDir, cleanup: true };
    } catch (err) {
      cleanupSessionWorkdir(sessionDir);
      throw err;
    }
  }

  async executeRepositoryRunTask(
    event: AgentTaskEvent,
    ctx: RepositoryRunTaskContext,
  ): Promise<void> {
    const context = await this.contextBuilder.build(event);
    const processKey: ProcessKey = "agent.task";
    // Tier override > model-derived tier > undefined (resolve via
    // process-key default = medium). agent_schedule.tier_override is
    // the primary cost-pinning surface; the legacy `model` column
    // stays as an Opus/Sonnet escape hatch for callers that still
    // want a concrete Claude model.
    const requestedTier = event.requestedTier
      ?? (event.requestedModel
        ? (event.requestedModel === "sonnet" ? "medium" as const : "high" as const)
        : undefined);
    const internalBackendOverride =
      event.requestedBackendId
      && isBackendId(event.requestedBackendId)
      && typeof event.requestedModelId === "string"
        ? {
            requestedBackendId: event.requestedBackendId,
            requestedModelId: event.requestedModelId,
          }
        : {};
    const binding = this.agentRouter.resolveBinding(event, {
      processKey,
      requestedTier,
      ...internalBackendOverride,
    });
    const prompt = this.buildRepositoryRunPrompt(ctx);
    const { sessionDir, cleanup } = this.prepareRepositoryRunSessionDir(
      ctx,
      binding.main.backendId,
    );
    try {
      const result = await this.errorRouter.executeWithRetry(
        () =>
          this.agentRouter.execute({
            prompt,
            context,
            event,
            processKey,
            requestedTier,
            preResolvedBinding: binding,
            reassemblePrompt: () => prompt,
            sessionDir,
            workdirEventType: "scheduled.task",
            workdirProcessKey: processKey,
            ...internalBackendOverride,
          }),
        event,
      );
      await this.resultProcessor.processResult(result, event);
    } finally {
      if (cleanup) {
        cleanupSessionWorkdir(sessionDir);
      }
    }
  }

  /**
   * Execute a scheduled task with the model specified when the task was
   * registered via POST /api/schedule.
   *
   * Morning-routine retry tasks take a dedicated fast path: they skip
   * the generic scheduled.task prompt and run the *real* morning routine
   * flow via executeMorningRoutine, so the retry carries the same rotateDayFiles
   * / prompt selection / roadmap-refresh chain as the cron-fired path.
   */
  async executeScheduledTask(event: AgentTaskEvent): Promise<void> {
    // Morning-routine retry detection: if taskContext says this wake
    // task is a morning-routine retry, dispatch through executeMorningRoutine
    // with a synthesized RoutineEvent instead of the generic flow.
    const taskCtx = event.taskContext;
    if (
      taskCtx &&
      typeof taskCtx === "object" &&
      (taskCtx as { routine?: unknown }).routine === "morning_routine"
    ) {
      await this.handleMorningRoutineRetry(
        event,
        taskCtx as {
          routine: string;
          retryCount?: number;
          originalCorrelationId?: string;
        },
      );
      return;
    }
    if (
      taskCtx &&
      typeof taskCtx === "object" &&
      (taskCtx as { routine?: unknown }).routine === "today_refresh"
    ) {
      await this.executeScheduledRoutine(event, "today_refresh");
      return;
    }
    const repositoryRunCtx = parseRepositoryRunTaskContext(taskCtx);
    if (repositoryRunCtx) {
      await this.executeRepositoryRunTask(event, repositoryRunCtx);
      return;
    }
    if (await this.executeGitProjectDocTaskIfApplicable(event, taskCtx)) {
      return;
    }

    const context = await this.contextBuilder.build(event);
    const processKeyOverride =
      taskCtx
      && typeof taskCtx === "object"
      && typeof (taskCtx as { processKey?: unknown }).processKey === "string"
        ? (taskCtx as { processKey: string }).processKey
        : null;
    const processKey = (processKeyOverride ?? resolveProcessKey(event)) as ProcessKey;
    const promptKey = processKeyOverride ?? event.type;
    // Tier override > model-derived tier > undefined (see
    // executeRepositoryRunTask for the precedence rationale).
    const requestedTier = event.requestedTier
      ?? (event.requestedModel
        ? (event.requestedModel === "sonnet" ? "medium" as const : "high" as const)
        : undefined);
    const internalBackendOverride =
      event.requestedBackendId
      && isBackendId(event.requestedBackendId)
      && typeof event.requestedModelId === "string"
        ? {
            requestedBackendId: event.requestedBackendId,
            requestedModelId: event.requestedModelId,
          }
        : {};
    const binding = this.agentRouter.resolveBinding(event, {
      processKey,
      requestedTier,
      ...internalBackendOverride,
    });
    const reassemblePrompt = (bid: BackendId): string =>
      this.prompt.assemble(promptKey, processKey, bid);
    const prompt = reassemblePrompt(binding.main.backendId);
    // Daily-git-management safety clamp — see
    // `REFRESH_ARCHITECTURE_ALLOWED_TOOLS` JSDoc. The check is on
    // `processKey` (carried by the agent_schedule row's task_context)
    // rather than `event.source` so a downstream rename of the schedule
    // source string cannot silently widen the envelope; the process key
    // is the contract surface.
    const refreshArchitectureOverride =
      processKey === "git.project.refresh_architecture"
        ? REFRESH_ARCHITECTURE_ALLOWED_TOOLS
        : undefined;
    if (
      refreshArchitectureOverride
      && !this.clampSupportedByBackend(
        processKey,
        binding.main.backendId,
        event.correlationId,
        "REFRESH_ARCHITECTURE_ALLOWED_TOOLS",
      )
    ) {
      // Refuse-at-execute. The audit row + log line are written inside
      // the guard; mark the schedule row done so the operator's only
      // path to "fix it" is via /settings/models, not by waiting for a
      // retry storm.
      this.markScheduledTaskCompleted(event);
      return;
    }
    const result = await this.errorRouter.executeWithRetry(
      () =>
        this.agentRouter.execute({
          prompt,
          context,
          event,
          processKey,
          requestedTier,
          preResolvedBinding: binding,
          reassemblePrompt,
          ...(refreshArchitectureOverride
            ? { allowedToolsOverride: refreshArchitectureOverride }
            : {}),
        }),
      event,
    );
    await this.resultProcessor.processResult(result, event);
  }

  /**
   * Legacy git project documentation tasks used to run as autonomous Claude
   * task-flows. That made file creation probabilistic: the backend could
   * finish "successfully" without calling the daemon context API, or fail
   * before receiving the `<task_context>` block. The daemon now owns these
   * writes directly, matching the manual Daily git management buttons and
   * the repository-management cron.
   */
  private async executeGitProjectDocTaskIfApplicable(
    event: AgentTaskEvent,
    taskCtx: AgentTaskEvent["taskContext"],
  ): Promise<boolean> {
    const processKey = this.resolveGitProjectDocProcessKey(event, taskCtx);
    if (!processKey) return false;

    const ctx = taskCtx && typeof taskCtx === "object"
      ? taskCtx as Record<string, unknown>
      : {};
    const repo = this.resolveRepositoryForGitProjectDocTask(ctx);
    const triggerSource = typeof ctx.triggerSource === "string"
      ? ctx.triggerSource
      : null;
    const isManagementSource =
      triggerSource === "repository_management_cron" ||
      triggerSource === "repository_management_manual";

    try {
      if (processKey === "git.project.init") {
        const result = runRepositoryManagementInit({
          db: this.db,
          repo,
          contextDir: getContextDir(this.config, this.db),
          timezone: this.config.timezone || undefined,
          writeTracker: this.writeTracker,
        });
        if (isManagementSource) {
          recordManagementInitDone(this.db, repo.id);
        }
        this.markScheduledTaskCompleted(event);
        logger.info(
          {
            scheduleId: event.scheduleId ?? null,
            repositoryId: repo.id,
            slug: repo.slug,
            result: result.status,
            architectureScheduleId: result.architectureScheduleId,
          },
          "Handled git.project.init with direct markdown writer",
        );
      } else {
        const lookbackHours = typeof ctx.lookbackHours === "number"
          && Number.isFinite(ctx.lookbackHours)
          && ctx.lookbackHours > 0
          ? ctx.lookbackHours
          : undefined;
        const result = await runRepositoryManagementScan({
          db: this.db,
          repo,
          contextDir: getContextDir(this.config, this.db),
          timezone: this.config.timezone || undefined,
          lookbackHours,
          writeTracker: this.writeTracker,
        });
        if (isManagementSource) {
          recordManagementScan(
            this.db,
            repo.id,
            result.status === "skipped_no_activity" ? "skipped_no_activity" : "ok",
          );
        }
        this.markScheduledTaskCompleted(event);
        logger.info(
          {
            scheduleId: event.scheduleId ?? null,
            repositoryId: repo.id,
            slug: repo.slug,
            result: result.status,
            journalPath: result.journalPath,
          },
          "Handled git.project.update with direct markdown writer",
        );
      }
      return true;
    } catch (err) {
      if (isManagementSource) {
        try {
          recordManagementScan(this.db, repo.id, "failed");
        } catch (recordErr) {
          logger.error(
            { err: recordErr, repositoryId: repo.id },
            "Failed to record repository management direct-writer failure",
          );
        }
      }
      if (event.scheduleId) {
        this.db
          .prepare(
            "UPDATE agent_schedule SET status = 'failed' WHERE id = ? AND status = 'running'",
          )
          .run(event.scheduleId);
      }
      logger.error(
        { err, scheduleId: event.scheduleId ?? null, repositoryId: repo.id },
        "Git project documentation direct writer failed",
      );
      throw err;
    }
  }

  private resolveGitProjectDocProcessKey(
    event: AgentTaskEvent,
    taskCtx: AgentTaskEvent["taskContext"],
  ): "git.project.init" | "git.project.update" | null {
    const ctxProcessKey =
      taskCtx &&
      typeof taskCtx === "object" &&
      typeof (taskCtx as { processKey?: unknown }).processKey === "string"
        ? (taskCtx as { processKey: string }).processKey
        : null;
    const value = ctxProcessKey ?? event.source;
    return value === "git.project.init" || value === "git.project.update"
      ? value
      : null;
  }

  private resolveRepositoryForGitProjectDocTask(
    ctx: Record<string, unknown>,
  ): RepositoryDTO {
    const repositoryId = typeof ctx.repositoryId === "string"
      ? ctx.repositoryId
      : null;
    if (repositoryId) {
      const byId = getRepository(this.db, repositoryId);
      if (byId) return byId;
    }

    const localPath = typeof ctx.localPath === "string"
      ? ctx.localPath
      : typeof (ctx.repository as { localPath?: unknown } | undefined)?.localPath === "string"
        ? (ctx.repository as { localPath: string }).localPath
        : null;
    if (localPath) {
      const byPath = getRepositoryByLocalPath(this.db, localPath);
      if (byPath) return byPath;
    }

    const slug = typeof ctx.slug === "string"
      ? ctx.slug
      : typeof (ctx.repository as { slug?: unknown } | undefined)?.slug === "string"
        ? (ctx.repository as { slug: string }).slug
        : null;
    if (!slug || !localPath) {
      throw new Error(
        "git project documentation task requires repositoryId or slug/localPath task context",
      );
    }

    const githubRepo = typeof ctx.githubRepo === "string"
      ? ctx.githubRepo
      : typeof (ctx.repository as { githubRepo?: unknown } | undefined)?.githubRepo === "string"
        ? (ctx.repository as { githubRepo: string }).githubRepo
        : null;
    const [githubOwner, githubRepoName] = parseGithubRepoSlug(githubRepo);
    const now = Date.now();
    return {
      id: repositoryId ?? (githubRepo ? `github:${githubRepo}` : `local:${slug}`),
      githubOwner,
      githubRepo: githubRepoName,
      githubAccount: null,
      localPath,
      localOnly: githubRepo === null,
      displayName: typeof ctx.displayName === "string" ? ctx.displayName : slug,
      classification: normalizeRepositoryClassification(ctx.classification),
      category: normalizeRepositoryCategory(ctx.category),
      pollPriority: "normal",
      pollIntervalSec: null,
      slug,
      createdAt: now,
      updatedAt: now,
    };
  }

  private markScheduledTaskCompleted(event: AgentTaskEvent): void {
    if (!event.scheduleId) return;
    this.db
      .prepare(
        "UPDATE agent_schedule SET status = 'completed' WHERE id = ? AND status = 'running'",
      )
      .run(event.scheduleId);
  }

  /**
   * Defense-in-depth gate for per-execute tool clamps. When the
   * dispatcher pins an `allowedToolsOverride` for a known-safe envelope
   * (refresh_architecture, skill_curation) the clamp MUST hold; if the
   * router resolves to a backend that ignores per-execute clamps the
   * call would silently widen back to the default tool surface and the
   * read-only contract documented in the clamp's JSDoc would dissolve.
   *
   * Returns `true` when the resolved main backend honors clamps (the
   * caller should pass the override through to `execute`). Returns
   * `false` when the operator has rebound the process key to a backend
   * we cannot trust — the caller bails out of the execute, an
   * `agent_actions` row records the refusal for the audit log, and an
   * error-level log line surfaces the misconfiguration immediately.
   *
   * Implementation note: the audit row uses `result = 'failed'` to
   * match the `blocked_absolute` precedent — the `agent_actions.result`
   * CHECK constraint only permits the canonical settle states
   * (success / failed / partial / skipped / in_progress); a literal
   * `"blocked"` here would silently violate the constraint and the
   * try/catch would swallow the audit. The `action_type` is the
   * discriminator that lets dashboards / queries distinguish a "blocked
   * by clamp" row from a real agent failure.
   */
  private clampSupportedByBackend(
    processKey: ProcessKey,
    backendId: BackendId,
    correlationId: string | undefined,
    clampName: string,
  ): boolean {
    if (TOOL_CLAMP_SUPPORTING_BACKENDS.has(backendId)) return true;
    logger.error(
      { processKey, backendId, clampName, correlationId },
      "Refusing scheduled task: process key carries a per-execute tool clamp that the resolved backend cannot enforce. Reconfigure /settings/models to bind this process key to a backend in TOOL_CLAMP_SUPPORTING_BACKENDS (currently: claude) or remove the clamp.",
    );
    try {
      const detail = {
        process_key: processKey,
        backend: backendId,
        clamp: clampName,
        supported_backends: Array.from(TOOL_CLAMP_SUPPORTING_BACKENDS),
        correlation_id: correlationId ?? null,
        reason:
          "allowedToolsOverride is not enforceable on this backend " +
          "(no per-execute allowedTools surface); refused at dispatch.",
      };
      this.db
        .prepare(
          `INSERT INTO agent_actions
             (action_type, trigger, result, detail, started_at, completed_at)
           VALUES ('scheduled_task_clamp_unsupported', 'autonomous', 'failed', json(?), datetime('now'), datetime('now'))`,
        )
        .run(JSON.stringify(detail));
    } catch (err) {
      logger.warn({ err }, "Failed to record clamp_unsupported audit row");
    }
    return false;
  }

  private async executeScheduledRoutine(
    event: AgentTaskEvent,
    routine: "today_refresh",
  ): Promise<void> {
    const routineEvent: RoutineEvent = {
      ...createEvent({
        type: `routine.${routine}`,
        source:
          typeof event.taskContext.source === "string"
            ? event.taskContext.source
            : event.source,
        priority: EventPriority.NORMAL,
        correlationId: event.correlationId,
        data: {
          ...event.taskContext,
          scheduleId: event.scheduleId ?? null,
        },
      }),
      routine,
      ...(event.requestedModel ? { requestedModel: event.requestedModel } : {}),
      ...(event.requestedTier ? { requestedTier: event.requestedTier } : {}),
    };

    try {
      await this.executeDefault(routineEvent);
      if (event.scheduleId) {
        this.db
          .prepare(
            "UPDATE agent_schedule SET status = 'completed' WHERE id = ? AND status = 'running'",
          )
          .run(event.scheduleId);
      }
    } catch (err) {
      if (event.scheduleId) {
        this.db
          .prepare(
            "UPDATE agent_schedule SET status = 'failed' WHERE id = ? AND status = 'running'",
          )
          .run(event.scheduleId);
      }
      throw err;
    }
  }

  /**
   * Handle a morning-routine retry wake task.
   *
   * Steps:
   *  1. Early skip: if today.md already exists (e.g., the cron-fired
   *     morning routine raced us to it), mark this wake task completed
   *     without running the agent — saves one Opus session.
   *  2. Synthesize a RoutineEvent with `event.data.retryCount` carrying
   *     the current attempt number, so that the recursive
   *     scheduleMorningRetry call from executeMorningRoutine can increment the
   *     retry chain naturally via the event.data code path.
   *  3. Invoke executeMorningRoutine — this reuses the full morning-routine flow
   *     (rotateDayFiles, prompt selection, agent execute, post-result
   *     today.md check, roadmap_refresh emission).
   *  4. Mark the wake task row completed. processResult inside the
   *     executeMorningRoutine call operates on the synthetic RoutineEvent, which
   *     is not an AgentTaskEvent, so it does not touch scheduleId — we
   *     must do it ourselves.
   */
  private async handleMorningRoutineRetry(
    event: AgentTaskEvent,
    taskCtx: {
      routine: string;
      retryCount?: number;
      originalCorrelationId?: string;
      source?: string;
      postCatchupRoutines?: string[];
      postCatchupHourlyCheck?: boolean;
    },
  ): Promise<void> {
    const retryCount = Number(taskCtx.retryCount ?? 0);

    // O1 + 2026-05-14 stall-loop fix: skip ONLY when both signals agree
    // that the morning routine has genuinely completed for the current
    // agent-day:
    //   (a) today.md exists with the expected H1 date, AND
    //   (b) `agent_actions.result='success'` for `routine.morning_routine`
    //       within the current agent-day window.
    //
    // The original implementation skipped on (a) alone, which created a
    // silent stall loop in two real scenarios:
    //   - the daemon crashes between the today.md write and the audit
    //     row insert (today.md is fresh, audit row is missing);
    //   - the user manually edits today.md to the current date (CLAUDE.md
    //     calls this out as a documented edit path).
    // In both, the hourly_check pre-routine gate (`morningRoutineRanToday`)
    // would keep refusing to run because the audit row is absent, the
    // pre-routine gate kept enqueuing wake rows, and each wake row was
    // fast-path completed here — never producing the audit row that would
    // break the loop. The morning-routine stall watchdog could not catch
    // it either because the wake rows transitioned to `completed` before
    // the watchdog's pending/running window.
    //
    // Requiring both signals means a missing audit row falls through to
    // the actual retry path, which performs the work that produces the
    // audit row and unblocks the autonomous routines. The lock-acquire
    // step still guards against concurrent retries.
    const todayMdFresh = this.hasCurrentAgentDayTodayMd();
    const auditRowPresent = morningRoutineRanToday(this.db, this.config);
    if (todayMdFresh && auditRowPresent) {
      logger.info(
        {
          retryCount,
          originalCorrelationId: taskCtx.originalCorrelationId,
        },
        "Morning routine retry skipped — today.md fresh and morning_routine audit row present (cron likely raced us)",
      );
      if (event.scheduleId) {
        this.db
          .prepare(
            "UPDATE agent_schedule SET status = 'completed' WHERE id = ? AND status = 'running'",
          )
          .run(event.scheduleId);
      }
      return;
    }
    if (todayMdFresh && !auditRowPresent) {
      logger.warn(
        {
          retryCount,
          originalCorrelationId: taskCtx.originalCorrelationId,
        },
        "Morning routine retry proceeding even though today.md exists — morning_routine audit row missing for current agent-day (recovers from the 2026-05-14 silent-stall failure mode)",
      );
    }

    // Synthesize a RoutineEvent for executeMorningRoutine. event.data.retryCount
    // carries the previous attempt so executeMorningRoutine → scheduleMorningRetry
    // can increment properly. correlationId tracks back to the original
    // cron morning_routine for log correlation.
    const synthEvent: RoutineEvent = {
      ...createEvent({
        type: "routine.morning_routine",
        source:
          typeof taskCtx.source === "string"
            ? taskCtx.source
            : retryCount > 0
              ? `morning_routine_retry_${retryCount}`
              : "scheduled_morning_routine",
        priority: retryCount > 0 ? EventPriority.NORMAL : EventPriority.HIGH,
        correlationId: taskCtx.originalCorrelationId ?? event.correlationId,
        data: {
          ...(retryCount > 0 ? { retryCount, isRetry: true } : {}),
          ...(Array.isArray(taskCtx.postCatchupRoutines)
            ? { postCatchupRoutines: taskCtx.postCatchupRoutines }
            : {}),
          ...(taskCtx.postCatchupHourlyCheck === true
            ? { postCatchupHourlyCheck: true }
            : {}),
          ...(typeof taskCtx.source === "string"
            ? { queuedSource: taskCtx.source }
            : {}),
        },
      }),
      routine: "morning_routine",
    };

    logger.info(
      { retryCount, correlationId: synthEvent.correlationId },
      "Morning routine retry — routing to executeMorningRoutine with synthesized RoutineEvent",
    );

    await this.morningRoutine.executeMorningRoutine(synthEvent);

    // Mark the wake task row completed — executeMorningRoutine doesn't know about
    // scheduleId since it received a RoutineEvent, not an AgentTaskEvent.
    if (event.scheduleId) {
      this.db
        .prepare(
          "UPDATE agent_schedule SET status = 'completed' WHERE id = ? AND status = 'running'",
        )
        .run(event.scheduleId);
    }
  }

  hasCurrentAgentDayTodayMd(): boolean {
    return this.diagnoseTodayMdState().kind === "fresh";
  }

  /**
   * Inspect today.md and report its state relative to the current agent-day.
   * Used by the post-routine retry gate so the log can distinguish between
   * "file is missing" and "file has stale H1 date", which are different
   * failure modes (process crash vs. format-confusion bug).
   */
  diagnoseTodayMdState(): TodayMdState {
    const todayPath = join(getContextDir(this.config, this.db), "today.md");
    if (!existsSync(todayPath)) {
      return { kind: "missing" };
    }
    const content = readFileSync(todayPath, "utf-8");
    const writtenDate = content.match(/^#.*(\d{4}-\d{2}-\d{2})/)?.[1];
    if (!writtenDate) {
      return { kind: "no_h1_date" };
    }
    const expectedAgentDay = getAgentDayDateStr(
      this.config.timezone || undefined,
      this.config.dayBoundaryHour,
    );
    if (writtenDate !== expectedAgentDay) {
      return { kind: "wrong_date", writtenDate, expectedAgentDay };
    }
    return { kind: "fresh" };
  }

  /**
   * Rotate day files before Morning Routine:
   * 1. today.md → schedule/YYYY-MM-DD.md (archive)
   * 2. today.md → yesterday.md (rename for context injection)
   *
   * After this, ContextBuilder will read yesterday.md as <yesterday>
   * and today.md will not exist (agent generates it fresh).
   */
  rotateDayFiles(): void {
    const contextDir = getContextDir(this.config, this.db);
    const todayPath = join(contextDir, "today.md");

    if (!existsSync(todayPath)) return;

    const content = readFileSync(todayPath, "utf-8");
    const dateStr =
      content.match(/^#.*(\d{4}-\d{2}-\d{2})/)?.[1];

    // Skip if today.md is already today's date (no rotation needed)
    const todayDateStr = getAgentDayDateStr(
      this.config.timezone || undefined,
      this.config.dayBoundaryHour,
    );
    if (dateStr === todayDateStr) return;
    if (!dateStr) return;

    // B-007 §5.9 — mechanical copy to schedule/ is retired. The only
    // rotation artifact we preserve is a DB snapshot of the closing
    // today.md; the synthesized `daily/YYYY-MM-DD.md` is written later by
    // the morning routine from yesterday.md + SQLite event records.

    // 1. Snapshot to DB for rebuild safety
    try {
      this.db
        .prepare(
          "INSERT INTO md_file_snapshots (file_path, content, trigger) VALUES (?, ?, ?)",
        )
        .run("today", content, "day_rotation");
    } catch (err) {
      logger.warn({ err }, "Failed to save rotation snapshot");
    }

    // 2. Rename today.md → yesterday.md
    const yesterdayPath = join(contextDir, CONTEXT_RELATIVE_PATHS.yesterday);
    renameSync(todayPath, yesterdayPath);

    logger.info({ archived: `schedule/${dateStr}.md` }, "Day files rotated");
  }

  /**
   * Roadmap-refresh execution with an exclusive cross-request write
   * lock. The lockId is surfaced to the session context as
   * `<roadmap_write_lock_id>` so the task-flow PUT / PATCH calls can
   * pass `X-Lock-Id` and other concurrent flows (DM handler, evening
   * sweeper) that attempt to write `/api/context/roadmap` during the
   * refresh receive a 409.
   *
   * If the lock cannot be acquired (another session is mid-write), the
   * refresh is skipped — `emitRoadmapRefresh` will retry on the next
   * qualifying signal (dedup window permitting). This is the correct
   * behaviour: the holder is already producing a fresher roadmap than
   * anything we would emit right now.
   */
  async executeRoadmapRefresh(event: Event): Promise<void> {
    let lockId: string | null = null;
    let effectiveEvent = event;

    if (this.roadmapWriteLock) {
      const lock = this.roadmapWriteLock.acquire();
      if (!lock.ok) {
        logger.info(
          {
            eventType: event.type,
            source: event.source,
            holder: lock.holder,
          },
          "roadmap.md write lock held — skipping this refresh",
        );
        return;
      }
      lockId = lock.lockId;
      effectiveEvent = {
        ...event,
        data: {
          ...event.data,
          roadmapWriteLockId: lockId,
        },
      };
    }

    try {
      await this.executeDefault(effectiveEvent);
    } finally {
      if (lockId && this.roadmapWriteLock) {
        this.roadmapWriteLock.release(lockId);
      }
    }
  }

  /**
   * P22 §3.4 — skill curation routine. Provisions an isolated optimizer
   * workdir, hands the runId + runToken into the agent's task context via
   * `event.data`, and tears the workdir down regardless of success/failure.
   *
   * The standard `executeDefault` path produces the agent session itself —
   * the only differences from a normal routine are: (a) the workdir is the
   * pre-built optimizer dir (built by `materializeOptimizerWorkdir`), and
   * (b) `executeDefault` recognises `routine.skill_curation` events and
   * pins `allowedToolsOverride` to `SKILL_CURATION_OPTIMIZER_ALLOWED_TOOLS`,
   * which the Claude SDK consumes verbatim and which suspends Allow-mode
   * `bypassPermissions`. The curation API's run-token + Zod chokepoint
   * remains the safety floor for the rare case the override is bypassed
   * (e.g. a future backend that doesn't read `allowedTools`).
   */
  async executeSkillCurationRoutine(event: Event): Promise<void> {
    const materialize = this.getMaterializeOptimizerWorkdir();
    if (!materialize) return;
    // P22 §6.4 — manual run flag rides on the routine event's `data.manual`
    // (set by `POST /api/skill-curation/runs/manual` from the dashboard).
    // Cadence-driven cron events have no `manual` key, so the default is
    // false — exactly the desired contract.
    const eventData = (event as Event & { data?: Record<string, unknown> }).data ?? {};
    const manual = eventData.manual === true;
    const targetSkillsOverride = Array.isArray(eventData.target_skills)
      ? (eventData.target_skills as string[])
      : undefined;
    let workdir: { runId: string; runToken: string; workdirPath: string; targetSkills: string[] } | null = null;
    try {
      workdir = await materialize({ manual, ...(targetSkillsOverride ? { targetSkillsOverride } : {}) });
      logger.info(
        { runId: workdir.runId, targetSkills: workdir.targetSkills, workdirPath: workdir.workdirPath, manual },
        "Skill-curation optimizer run starting",
      );
      // Inject the runId + token into the event so the agent core can pick
      // them up. The standard executor path runs from here.
      const enriched = {
        ...event,
        data: {
          ...(event as Event & { data?: Record<string, unknown> }).data,
          skill_curation_run_id: workdir.runId,
          skill_curation_run_token: workdir.runToken,
          skill_curation_workdir: workdir.workdirPath,
          skill_curation_target_skills: workdir.targetSkills,
        },
      } as Event;
      await this.executeDefault(enriched);
    } catch (err) {
      logger.error({ err, runId: workdir?.runId }, "Skill-curation routine failed");
      throw err;
    } finally {
      const teardown = this.getTeardownOptimizerWorkdir();
      if (workdir && teardown) {
        try {
          teardown(workdir.workdirPath);
        } catch (err) {
          logger.warn({ err, workdirPath: workdir.workdirPath }, "Skill-curation workdir teardown failed");
        }
      }
    }
  }

  async executeDefault(event: Event): Promise<void> {
    // WIKI_BUILDER_DESIGN.md §3.5 / §14 Q4 — the bang handler acquires the
    // workspace-scoped wiki-compile lock at enqueue time; we release it
    // here in a `finally` so the lock falls back to "free" whether the
    // session succeeds, fails, or any step in this method (context build,
    // binding resolution, prompt assembly, executeWithRetry, result
    // processing) throws. The TTL inside `compile-lock.ts` is the daemon-
    // crash safety net; release-here is the steady-state path.
    //
    // Capture from the immutable `event` argument so the workspace name
    // is fixed before any code below runs — `effectiveEvent` is rebound
    // later for routine pre-pass and shouldn't influence release.
    const wikiCompileWorkspace =
      event.type === "wiki.compile"
        ? (event.data?.workspace as string | undefined)
        : undefined;
    try {
      // docs/design/appendices/routine-data-acquisition.md Phase 4 / D4 — pre-pass for
      // routine events whose ProcessKey appears in `ROUTINE_WINDOWS`
      // (today_refresh, evening_review, weekly_review). The hourly_check
      // and morning_routine dispatch paths attach their own
      // `fetchReportBlock` upstream (D2 / D3); we honour an existing
      // attachment to avoid double-spawning the fetcher. `monthly_review`
      // has zero rows and short-circuits inside the runner.
      //
      // skill_curation / roadmap_refresh / user_profile_sweep are not in
      // `ROUTINE_WINDOWS`, so `routineWindowKeyFromEvent` returns null
      // and the pre-pass is skipped without touching the runner.
      let effectiveEvent: Event = event;
      if (isRoutineEvent(event)) {
        const routineKey = routineWindowKeyFromEvent(event);
        const alreadyPrepassed = typeof event.data?.fetchReportBlock === "string";
        if (routineKey && !alreadyPrepassed && routineHasWindows(routineKey)) {
          const prepass = await this.fetchWindowRunner.run(event, routineKey);
          effectiveEvent = {
            ...event,
            data: {
              ...event.data,
              fetchReportBlock: prepass.block,
            },
          };
        }
      }
      // WEEKLY_INTERESTS_REFLECTION_PLAN.md §10.4 — deterministic
      // pre-hook for `routine.weekly_review`. Runs synchronously
      // BEFORE `contextBuilder.build` so the freshly-refreshed
      // `## Current research themes (auto)` block lands in the
      // session's `<user>` injection. Failure-isolated: a throw
      // here is caught (`appendWeeklyInterestsJournalLine`) and the
      // user-facing weekly artifact still ships. Skip when the
      // upstream `browser-history` integration is disabled, mirroring
      // the F1 / F2 / F4 gate.
      if (
        isRoutineEvent(effectiveEvent)
        && (effectiveEvent as RoutineEvent).routine === "weekly_review"
      ) {
        this.runWeeklyInterestsReflectionPreHook(effectiveEvent as RoutineEvent);
      }
      const context = await this.contextBuilder.build(effectiveEvent);
      const processKey = resolveProcessKey(effectiveEvent);
      // Honour run-now's `requestedModel` hint for routine events. Other event
      // types (messages, scheduled.task) have their own dedicated paths that
      // already handle tier selection, so this branch is routine-only.
      // `requestedTier` (set by the today_refresh fast-path forwarder) wins
      // when present so the caller's abstract tier choice isn't downgraded
      // through the binary sonnet/opus → medium/high mapping.
      const routineHint = isRoutineEvent(effectiveEvent)
        ? (effectiveEvent.requestedTier
            ?? (effectiveEvent.requestedModel
              ? effectiveEvent.requestedModel === "opus"
                ? "high" as const
                : "medium" as const
              : undefined))
        : undefined;
      // Knowledge-import events carry the dashboard form's backend/model
      // pick. Honor the (backendId, modelId) pair only when the event was
      // emitted by the dashboard route — same defense-in-depth gate as the
      // chat picker — so a malformed event from another path cannot pin a
      // specific model.
      const importOverride =
        isKnowledgeImportEvent(effectiveEvent)
          && effectiveEvent.platform === "dashboard"
          && effectiveEvent.requestedBackendId
          && effectiveEvent.requestedModelId
          ? {
              requestedBackendId: effectiveEvent.requestedBackendId,
              requestedModelId: effectiveEvent.requestedModelId,
            }
          : undefined;
      const binding = this.agentRouter.resolveBinding(effectiveEvent, {
        processKey,
        ...(routineHint ? { requestedTier: routineHint } : {}),
        ...(importOverride ?? {}),
      });
      const reassemblePrompt = (bid: BackendId): string =>
        this.prompt.assemble(effectiveEvent.type, processKey, bid);
      const prompt = reassemblePrompt(binding.main.backendId);
      // P22 §3.4 step 4 — optimizer agent runs with a hard-clamped tool
      // envelope. The check is on event type rather than processKey so the
      // override is impossible to widen by accident from a downstream
      // dispatch refactor; the only path to skill_curation execution is
      // through `routine.skill_curation` events, which have no other code
      // path that strips the override.
      const skillCurationOverride =
        isRoutineEvent(effectiveEvent) && (effectiveEvent as RoutineEvent).routine === "skill_curation"
          ? SKILL_CURATION_OPTIMIZER_ALLOWED_TOOLS
          : undefined;
      if (
        skillCurationOverride
        && !this.clampSupportedByBackend(
          processKey,
          binding.main.backendId,
          effectiveEvent.correlationId,
          "SKILL_CURATION_OPTIMIZER_ALLOWED_TOOLS",
        )
      ) {
        // Refuse-at-execute. The skill curation routine has no schedule
        // row to mark (it runs from the optimizer cron), so the audit row
        // + log line written by the guard are the entire signal. Early
        // return is inside the try block, so the wiki-compile finally
        // still runs — but `wikiCompileWorkspace` is undefined for skill
        // curation events, so the release is a no-op.
        return;
      }
      // WIKI_BUILDER_DESIGN.md §4.3 — only `wiki.ingest_url` actually fetches
      // external URLs. `wiki.compile` and `wiki.ask` operate against already-
      // ingested files via the daemon Wiki API (verified in the skill bodies:
      // wiki-compile reads 10_raw via the API; wiki-ask reads 20_wiki). Keep
      // the widening as narrow as possible — granting WebFetch / Gemini
      // web_fetch allow to sessions that should not need it would silently
      // expand the blast radius for free.
      const wikiUrlFetchEnabled = effectiveEvent.type === "wiki.ingest_url";
      const result = await this.errorRouter.executeWithRetry(
        () =>
          this.agentRouter.execute({
            prompt,
            context,
            event: effectiveEvent,
            processKey,
            preResolvedBinding: binding,
            reassemblePrompt,
            ...(skillCurationOverride
              ? { allowedToolsOverride: skillCurationOverride }
              : {}),
            ...(wikiUrlFetchEnabled ? { wikiUrlFetchEnabled: true } : {}),
          }),
        effectiveEvent,
      );
      await this.resultProcessor.processResult(result, effectiveEvent);
    } finally {
      if (wikiCompileWorkspace) {
        releaseWikiCompileLock(wikiCompileWorkspace);
      }
    }
  }

  /** Bridge for `MorningRoutineRunner`'s `formatSqliteDatetime` use. */
  static formatScheduledFor(date: Date): string {
    return formatSqliteDatetime(date);
  }

  /**
   * WEEKLY_INTERESTS_REFLECTION_PLAN.md §10.4 pre-hook.
   *
   * Synchronous and failure-isolated. The only side-effect the caller
   * cares about is the freshly-refreshed `context/user/profile.md`
   * block — which `contextBuilder.build` (called immediately after
   * this method returns) picks up via its normal read path. Every
   * branch below routes through a try/catch so a throw cannot abort
   * the user-facing weekly artifact.
   *
   * Three terminal states:
   *
   *   - `browser_history` mode is `disabled` → no-op (with a journal
   *     line for traceability so an operator wondering "why didn't the
   *     reflection run this week?" finds the answer in
   *     `agent/journal.md` rather than having to greppling
   *     `agent_actions`).
   *   - The helper returns `{ skipped }` → journal line + audit row
   *     already emitted by the helper.
   *   - The helper throws → log + journal line. Audit row may or may
   *     not have been written depending on how far the helper got;
   *     the journal line is the defensive trace.
   */
  private runWeeklyInterestsReflectionPreHook(event: RoutineEvent): void {
    try {
      const browserHistory = readIntegrationState(this.db, "browser_history");
      const integrationDisabled = browserHistory.mode === "disabled";

      // Pass `this.db` so degraded-Obsidian-mode falls back to the
      // internal `~/.personal-agent/context/` — the rest of this file
      // (lines 424, 698, 725, 1107, 1135) follows the same convention;
      // without the db argument the pre-hook would write into the
      // user's Obsidian vault even when the daemon has decided to skip
      // it, leaving the LLM's contextBuilder reading from a different
      // location than the writer wrote to.
      const contextDir = getContextDir(this.config, this.db);
      const boundary = {
        timezone: this.config.timezone ? this.config.timezone : undefined,
        dayBoundaryHour: this.config.dayBoundaryHour ?? 4,
      };
      // rev 4 — the disabled gate is now enforced INSIDE the helper
      // (via `integrationDisabled`) so the audit-row shape is uniform
      // across both skip reasons. The helper short-circuits without
      // taking the lock or touching disk; it still emits the audit
      // row + returns `{ skipped: { reason: "no_browser_history" } }`.
      const result = refreshInterestsReflection(this.db, contextDir, {
        trigger: "scheduler",
        boundary,
        integrationDisabled,
        // Thread the agent-write tracker so each write the helper does
        // to user/profile.md, user/research-themes.md, user/_index.md,
        // and projects/*.md is attributed to the agent by FS-watch
        // consumers (the context-index reconciler chain + future
        // observers). Without this thread the chokidar `change` events
        // would be classified as user edits and feed into the hourly-
        // check pending floor as if the user had typed them.
        writeTracker: this.writeTracker,
        // `correlationId` is the routine event's identifier in the
        // bus; thread it as `event_id` on the audit row so the
        // dashboard's audit log can join the reflection trace to the
        // triggering weekly_review event.
        eventId: event.correlationId,
      });
      if (result.skipped) {
        this.appendWeeklyInterestsJournalLine(
          `interest reflection skipped: ${result.skipped.reason} (weekStart=${result.weekStart})`,
        );
      } else {
        logger.info(
          {
            correlationId: event.correlationId,
            weekStart: result.weekStart,
            targetsWritten: result.targetsWritten.length,
            themesSelected: result.themesSelected.length,
            projectsAnnotated: result.projectsAnnotated,
          },
          "Weekly interests reflection pre-hook completed",
        );
      }
    } catch (err) {
      // Catch-all: never propagate up to `executeDefault` — the user-
      // facing weekly artifact must still ship. Lock contention is a
      // distinct, expected failure mode (e.g. the dashboard's
      // "Refresh now" button is mid-flight when the scheduler tick
      // fires) so we tag it separately for operator clarity.
      if (err instanceof InterestsReflectionLockBusyError) {
        logger.warn(
          { err, correlationId: event.correlationId },
          "Weekly interests reflection pre-hook hit lock contention — yielding to in-flight run",
        );
        this.appendWeeklyInterestsJournalLine(
          `interest reflection deferred: lock busy (${err.heldBy})`,
        );
        return;
      }
      logger.error(
        { err, correlationId: event.correlationId },
        "Weekly interests reflection pre-hook threw — continuing to LLM session",
      );
      const message =
        err instanceof Error ? err.message : String(err);
      this.appendWeeklyInterestsJournalLine(
        `interest reflection failed: ${message}`,
      );
    }
  }

  /**
   * Append a single bullet under `## Weekly interests reflection`
   * inside `context/agent/journal.md`, creating the section (and the
   * file) when absent. Mirrors the `appendToJournalSection` pattern
   * `roadmap-maintenance.ts` uses for its own one-liner trace; kept
   * inline here because the section header is feature-specific and
   * the helper has zero call sites outside this module.
   *
   * Best-effort: any FS failure is logged and swallowed.
   */
  private appendWeeklyInterestsJournalLine(message: string): void {
    try {
      // Same `this.db` thread-through as the pre-hook — keep the
      // journal write in the same file tree the reflection writes to.
      const contextDir = getContextDir(this.config, this.db);
      const journalPath = join(
        contextDir,
        CONTEXT_RELATIVE_PATHS.agent.journal,
      );
      const now = new Date();
      const tz = this.config.timezone ? this.config.timezone : undefined;
      const dayStr = getAgentDayDateStr(
        tz,
        this.config.dayBoundaryHour ?? 4,
        now,
      );
      const hm = formatJournalTime(now, tz);
      const bullet = `- ${dayStr} ${hm}: ${message}`;

      const original = existsSync(journalPath)
        ? readFileSync(journalPath, "utf-8")
        : null;
      // Thread `now.getTime()` so the 30-day retention window cuts
      // deterministically against the same instant the bullet's date
      // prefix was computed from — without it, prune would default to
      // `Date.now()` and a long-running test (or a slow disk) could
      // see the two diverge across the read/append boundary.
      const next = appendToWeeklyInterestsJournalSection(
        original,
        bullet,
        now.getTime(),
      );

      // The agent-write tracker must see the new content BEFORE the
      // rename so a downstream FS-watch consumer attributes the
      // resulting event to the agent (and not to the user). The same
      // mark-then-write-then-unmark-on-failure dance the roadmap-
      // maintenance journal appender uses.
      this.writeTracker?.markWriting(journalPath, next);
      try {
        writeFileAtomically(journalPath, next);
      } catch (writeErr) {
        this.writeTracker?.unmark(journalPath);
        throw writeErr;
      }
    } catch (err) {
      // The journal line is a best-effort trace — never fail the
      // pre-hook on a journal write hiccup. The structured log is
      // sufficient for daemon-log triage.
      logger.error(
        { err },
        "Failed to append weekly interests journal line",
      );
    }
  }
}

const WEEKLY_INTERESTS_JOURNAL_SECTION = "## Weekly interests reflection";

/**
 * rev 4 — monthly retention window for the `## Weekly interests
 * reflection` section. Bullets whose date prefix is older than this
 * window get pruned on the next append. At the weekly cadence the
 * pre-hook fires, this caps the section at ~4-5 entries.
 *
 * Rationale: `context/agent/journal.md` is the operator-facing trace
 * for "why didn't my reflection fire?" type questions. Six months of
 * weekly skip/success lines is noise — the load-bearing detail is
 * "did it work this month and last?", which a 30-day window captures
 * comfortably. Lines older than that live in git history if needed.
 */
const WEEKLY_INTERESTS_JOURNAL_RETENTION_DAYS = 30;

/**
 * Match the date prefix our journal bullets carry — `- YYYY-MM-DD HH:MM:`
 * — and capture the date component. Lines that don't match (e.g. a
 * user-authored note inside the section) are left untouched by the
 * rotation pass; only daemon-emitted bullets get pruned.
 */
const JOURNAL_BULLET_DATE_RE = /^- (\d{4}-\d{2}-\d{2})\s/;

/**
 * Drop bullets whose date prefix is older than `retentionDays` days
 * before `nowMs`. Pure of FS/DB; exported for tests.
 *
 * Lines that aren't recognisable as daemon-emitted bullets (no
 * `- YYYY-MM-DD` prefix) are preserved as-is — the rotation only
 * targets entries we created, never user prose someone may have
 * dropped into the section by hand.
 */
export function pruneWeeklyInterestsJournalBullets(
  lines: string[],
  bodyStart: number,
  bodyEnd: number,
  nowMs: number,
  retentionDays: number = WEEKLY_INTERESTS_JOURNAL_RETENTION_DAYS,
): string[] {
  const cutoffMs = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  const kept: string[] = [];
  for (let i = bodyStart; i < bodyEnd; i++) {
    const line = lines[i]!;
    const match = JOURNAL_BULLET_DATE_RE.exec(line);
    if (!match) {
      kept.push(line);
      continue;
    }
    // Anchor at noon UTC so a DST flip in the host's local zone
    // cannot move the parsed date into the day before/after.
    const dateMs = Date.parse(`${match[1]}T12:00:00Z`);
    if (Number.isNaN(dateMs) || dateMs >= cutoffMs) {
      kept.push(line);
    }
  }
  return [...lines.slice(0, bodyStart), ...kept, ...lines.slice(bodyEnd)];
}

/**
 * Append `bullet` to the `## Weekly interests reflection` section of
 * an agent-journal file, creating section + skeleton when absent.
 * Also prunes bullets older than the retention window (rev 4 — see
 * `WEEKLY_INTERESTS_JOURNAL_RETENTION_DAYS`).
 *
 * The function is pure of FS / DB — exported only for tests.
 */
export function appendToWeeklyInterestsJournalSection(
  original: string | null,
  bullet: string,
  nowMs: number = Date.now(),
): string {
  if (original === null) {
    return `# Agent journal\n\n${WEEKLY_INTERESTS_JOURNAL_SECTION}\n\n${bullet}\n`;
  }
  const lines = original.split("\n");
  const bounds = findSectionLineBounds(lines, "Weekly interests reflection");
  if (bounds) {
    // Prune first so the section contains only the last `RETENTION_DAYS`
    // worth of entries BEFORE we compute the insertion point — without
    // this, a long-stale bullet at the end would push the new bullet
    // into a section that's about to lose half its content.
    const pruned = pruneWeeklyInterestsJournalBullets(
      lines,
      bounds.bodyStart,
      bounds.bodyEnd,
      nowMs,
    );
    // Re-resolve bounds after pruning — bodyEnd shifted by the
    // delta. Section header position is unchanged so re-using
    // bodyStart is safe; we recompute bodyEnd as the old end minus
    // the number of lines we dropped.
    const removedCount = lines.length - pruned.length;
    const newBodyStart = bounds.bodyStart;
    const newBodyEnd = bounds.bodyEnd - removedCount;
    let insertAt = newBodyEnd;
    while (insertAt > newBodyStart && pruned[insertAt - 1]!.trim() === "") {
      insertAt -= 1;
    }
    const next = [
      ...pruned.slice(0, insertAt),
      bullet,
      ...pruned.slice(insertAt),
    ];
    let out = next.join("\n");
    if (!out.endsWith("\n")) out += "\n";
    return out;
  }
  const trimmed = original.replace(/\n+$/, "");
  return `${trimmed}\n\n${WEEKLY_INTERESTS_JOURNAL_SECTION}\n\n${bullet}\n`;
}

/**
 * Local 2-digit "HH:MM". Mirrors `roadmap-maintenance.ts:formatHm`
 * (which is module-private) without re-exporting from there — the
 * roadmap helper has the same posture (best-effort wall-clock for a
 * journal bullet) but lives in a feature-specific module.
 */
function formatJournalTime(now: Date, timezone?: string): string {
  if (!timezone) {
    return (
      `${String(now.getHours()).padStart(2, "0")}:`
      + `${String(now.getMinutes()).padStart(2, "0")}`
    );
  }
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const hh = parts.find((p) => p.type === "hour")?.value ?? "00";
  const mm = parts.find((p) => p.type === "minute")?.value ?? "00";
  // Intl can emit "24" for midnight in some locales — guard so the
  // journal line is stable regardless of host locale.
  const normalizedHh = hh === "24" ? "00" : hh;
  return `${normalizedHh}:${mm}`;
}
