import type Database from "better-sqlite3";
import type { SuccessCriterion } from "@aitne/shared";

import { getAgent } from "../../db/agents-store.js";
import type { AgentExecutionTrigger } from "../../db/agent-executions-store.js";
import type { AgentExecutionRecorder } from "../agent-execution-recorder.js";
import { createLogger } from "../../logging.js";
import { evaluateSuccessCriteria } from "./success-criteria.js";
import {
  resolveAgentId,
  type AgentIdResolutionInput,
} from "./agent-id-resolver.js";

/**
 * Per-firing execution lifecycle (AGENT_DEFINITIONS_DESIGN.md §8.1–§8.3).
 *
 * The single owner of the {@link AgentExecutionRecorder} hookup so the
 * dispatcher + result-processor (both coverage-excluded orchestrators) carry
 * only three thin calls — `begin` / `recordOutcome` / `completeFromDispatch` —
 * keyed by the event `correlationId`. Every firing that resolves to a known
 * Agent opens exactly one `agent_executions` row at start and settles it once
 * at the dispatch boundary, where success AND both failure modes converge:
 *
 *   - a **thrown** dispatch → `result='error'`, `error_kind='exception'`;
 *   - a **soft** failure (`AgentResult.isError`, recorded via
 *     {@link recordOutcome}) → `result='error'`, `error_kind='agent_error'`;
 *   - otherwise → `result='success'`.
 *
 * Anchoring completion at the dispatch boundary (not solely at the
 * result-processor) means a routine that never reaches `processResult` still
 * settles — the boot janitor only ever sweeps a genuinely abandoned (crashed)
 * row. Completion is idempotent: the map entry is consumed on the first call.
 *
 * Success criteria are evaluated best-effort at completion (§8.3); a throwing
 * criterion records `false` + a warning and never flips the LLM-level result.
 */

const baseLogger = createLogger("agent-execution-tracker");

type TrackerLogger = Pick<ReturnType<typeof createLogger>, "warn" | "debug">;

/** Terminal outcome the result-processor records before the dispatch settles. */
export interface AgentExecutionOutcome {
  /** `AgentResult.isError` — a soft failure that did not throw. */
  isError: boolean;
  costUsd?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  turns?: number | null;
  outputSummary?: string | null;
}

/** Sum two nullable numeric fields, preserving `null` only when both are absent. */
function addNullable(
  a: number | null | undefined,
  b: number | null | undefined,
): number | null {
  if (a == null) return b ?? null;
  if (b == null) return a;
  return a + b;
}

/**
 * Fold a stage's outcome into the execution's running rollup. The first call
 * (`prev === undefined`) adopts the outcome verbatim; a later call (a second
 * stage of the same firing) sums the spend and keeps `isError` sticky so any
 * stage's error marks the run, deterministically and independent of the
 * `Promise.allSettled` completion order. `outputSummary` keeps the latest
 * non-empty value.
 */
function mergeOutcome(
  prev: AgentExecutionOutcome | undefined,
  next: AgentExecutionOutcome,
): AgentExecutionOutcome {
  if (prev === undefined) return next;
  return {
    isError: prev.isError || next.isError,
    costUsd: addNullable(prev.costUsd, next.costUsd),
    tokensIn: addNullable(prev.tokensIn, next.tokensIn),
    tokensOut: addNullable(prev.tokensOut, next.tokensOut),
    turns: addNullable(prev.turns, next.turns),
    outputSummary: next.outputSummary ?? prev.outputSummary,
  };
}

export interface AgentExecutionTrackerDeps {
  db: Database.Database;
  recorder: AgentExecutionRecorder;
  /** Resolved context-vault root for `file_*` success criteria. */
  contextDir: string;
  /** SSE emitter for the dashboard's live execution feed (§9.8). */
  emitSse: (event: string, payload: unknown) => void;
  /** Loads an Agent's `success_criteria` from its definition file (§8.3). */
  loadCriteria: (definitionPath: string) => SuccessCriterion[];
  logger?: TrackerLogger;
}

interface ActiveExecution {
  executionId: number;
  startedAt: number;
  dateStr: string;
  agentId: string;
  criteria: SuccessCriterion[];
  outcome?: AgentExecutionOutcome;
}

export class AgentExecutionTracker {
  private readonly db: Database.Database;
  private readonly recorder: AgentExecutionRecorder;
  private readonly contextDir: string;
  private readonly emitSse: (event: string, payload: unknown) => void;
  private readonly loadCriteria: (definitionPath: string) => SuccessCriterion[];
  private readonly logger: TrackerLogger;
  private readonly active = new Map<string, ActiveExecution>();

  constructor(deps: AgentExecutionTrackerDeps) {
    this.db = deps.db;
    this.recorder = deps.recorder;
    this.contextDir = deps.contextDir;
    this.emitSse = deps.emitSse;
    this.loadCriteria = deps.loadCriteria;
    this.logger = deps.logger ?? baseLogger;
  }

  /**
   * Open an execution for a firing. Resolves the owning Agent (§8.1); when none
   * resolves, returns `null` and records nothing (legacy task, no-LLM pass).
   * Otherwise starts the `agent_executions` row, caches the loaded criteria,
   * and emits `agent.execution.started`. Returns the resolved Agent slug so the
   * dispatcher can short-circuit stamping when there is no Agent.
   */
  begin(
    correlationId: string,
    resolution: AgentIdResolutionInput,
    opts: { scheduleRowId?: number | null; trigger: AgentExecutionTrigger },
  ): string | null {
    const agentId = resolveAgentId(this.db, resolution);
    if (agentId === null) return null;

    // resolveAgentId verified the row exists synchronously, so getAgent is
    // non-null here (better-sqlite3 is single-threaded; no row can vanish
    // between the two reads).
    const definitionPath = getAgent(this.db, agentId)!.definitionPath;
    const criteria = this.loadCriteria(definitionPath);
    const handle = this.recorder.start({
      agentId,
      scheduleRowId: opts.scheduleRowId ?? null,
      trigger: opts.trigger,
    });
    this.active.set(correlationId, {
      executionId: handle.executionId,
      startedAt: handle.startedAt,
      dateStr: handle.dateStr,
      agentId,
      criteria,
    });
    this.emitSse("agent.execution.started", {
      slug: agentId,
      executionId: handle.executionId,
      trigger: opts.trigger,
      startedAt: handle.startedAt,
    });
    return agentId;
  }

  /**
   * Record the terminal LLM-level outcome (cost / soft-error) before the
   * dispatch boundary settles the row. No-op when no execution is active.
   *
   * A single-session firing calls this exactly once (merge == replace). A
   * **multi-stage** firing — today only the morning routine, whose Stage A
   * (today.md) and Stage B (daily journal) are two separate LLM sessions that
   * both funnel through the shared `ResultProcessor` carrying the
   * parent's `correlationId` — calls it once per stage. The outcomes are
   * therefore *folded* (see {@link mergeOutcome}): cost / tokens / turns are
   * SUMMED so the rollup reflects the firing's total spend rather than the
   * last (race-ordered) stage's, and `isError` is sticky-OR.
   */
  recordOutcome(correlationId: string, outcome: AgentExecutionOutcome): void {
    const entry = this.active.get(correlationId);
    if (entry === undefined) return;
    entry.outcome = mergeOutcome(entry.outcome, outcome);
  }

  /** The Agent slug currently executing for this correlation id, for
   *  `agent_actions.agent_id` stamping. `null` when no execution is active. */
  currentAgentId(correlationId: string): string | null {
    return this.active.get(correlationId)?.agentId ?? null;
  }

  /**
   * Settle the active execution as a deliberate skip (AGENT_DEFINITIONS_DESIGN.md
   * §5.2 — `result='skipped'` is a reserved non-error terminal that does NOT
   * count toward `errorRate`). Called from a dispatch path that opened a row via
   * {@link begin} but then decided not to run the routine this tick — e.g. a
   * review routine blocked by the morning-routine-pending gate, or skill
   * curation when the optimizer workdir is unwired. Success criteria are NOT
   * evaluated (the run never happened); `reason` is recorded in `output_summary`
   * so the dashboard can show why. Idempotent — consumes the map entry, so the
   * trailing `completeFromDispatch` in `dispatchSafe` is a no-op. No-op when no
   * execution is active (the firing resolved to no Agent, so `begin` opened no
   * row).
   */
  markSkipped(correlationId: string, reason?: string): void {
    const entry = this.active.get(correlationId);
    if (entry === undefined) return;
    this.active.delete(correlationId);
    this.recorder.complete({
      executionId: entry.executionId,
      result: "skipped",
      ...(reason !== undefined ? { outputSummary: reason } : {}),
    });
    this.emitSse("agent.execution.completed", {
      slug: entry.agentId,
      executionId: entry.executionId,
      result: "skipped",
    });
  }

  /**
   * Settle the active execution at the dispatch boundary. Idempotent — the map
   * entry is consumed, so a later call (e.g. the error path after the success
   * path already completed) is a no-op. Evaluates success criteria, writes the
   * terminal row (+ `agents.last_execution_id`), and emits
   * `agent.execution.completed`.
   */
  completeFromDispatch(
    correlationId: string,
    opts: { thrown?: unknown } = {},
  ): void {
    const entry = this.active.get(correlationId);
    if (entry === undefined) return;
    this.active.delete(correlationId);

    const thrown = "thrown" in opts;
    let result: "success" | "error";
    let errorKind: string | null = null;
    let errorMessage: string | null = null;
    if (thrown) {
      result = "error";
      errorKind = "exception";
      errorMessage =
        opts.thrown instanceof Error
          ? opts.thrown.message
          : String(opts.thrown);
    } else if (entry.outcome?.isError === true) {
      result = "error";
      errorKind = "agent_error";
    } else {
      result = "success";
    }

    const { hits, warnings } = evaluateSuccessCriteria(entry.criteria, {
      db: this.db,
      contextDir: this.contextDir,
      agentId: entry.agentId,
      startedAt: entry.startedAt,
      dateStr: entry.dateStr,
    });
    for (const warning of warnings) {
      this.logger.warn(
        { slug: entry.agentId, criterionId: warning.id, kind: warning.kind, message: warning.message },
        "success criterion could not be evaluated",
      );
    }

    const outcome = entry.outcome;
    this.recorder.complete({
      executionId: entry.executionId,
      result,
      errorKind,
      errorMessage,
      cost: {
        usd: outcome?.costUsd ?? null,
        tokensIn: outcome?.tokensIn ?? null,
        tokensOut: outcome?.tokensOut ?? null,
        turns: outcome?.turns ?? null,
      },
      successCriteriaHits: hits,
      outputSummary: outcome?.outputSummary ?? null,
    });

    this.emitSse("agent.execution.completed", {
      slug: entry.agentId,
      executionId: entry.executionId,
      result,
      errorKind,
      successCriteria: hits,
    });
  }
}
