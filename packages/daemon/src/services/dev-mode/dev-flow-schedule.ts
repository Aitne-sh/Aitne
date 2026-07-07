/**
 * Development-mode fleet scheduling — the pure decision brain of the
 * orchestrator (the loop-kit `tick` order, `deps_state`, the settle
 * classification and `write_split_nudge`, loop.sh:3047 / 2071 / 1189 —
 * re-expressed as functions over a task snapshot instead of a 2s poll).
 * No fs/db/network — stays IN the coverage gate at 100%.
 *
 * The I/O orchestrator (dev-flow-orchestrator.ts) is a thin shell: it takes
 * the actions this module emits, runs them (workers as promises, the control
 * lane — supervise/merge/plan-review — behind one mutex so mutations stay
 * serialized), and re-plans on every wake.
 */

// ── Snapshot types (structural — mirror dev_session_tasks rows) ─────────

export type DevFleetTaskState =
  | "queued"
  | "running"
  | "supervise_pending"
  | "merge_pending"
  | "awaiting_user"
  | "merged"
  | "failed"
  | "superseded"
  | "dep_failed";

export interface DevFleetTaskSnapshot {
  id: string;
  taskKey: string;
  state: DevFleetTaskState;
  dependsOn: readonly string[];
  planReview: "pending" | "done" | "escalated" | null;
  loopState: string | null;
}

const FAILED_LIKE: ReadonlySet<DevFleetTaskState> = new Set([
  "failed",
  "dep_failed",
  "superseded",
]);

// ── deps_state port ─────────────────────────────────────────────────────

export type DevDepsState =
  | { kind: "ready" }
  | { kind: "waiting" }
  | { kind: "failed"; depKey: string };

/**
 * A task may start only when EVERY dependency has MERGED (not merely
 * finished) — its worktree must contain the dep's landed code. A merged dep
 * whose phase-boundary plan review is still pending/escalated keeps the
 * dependent waiting (the queued remainder may be about to be revised). A
 * failed-like dep (failed / dep_failed / superseded / unknown key) can never
 * be satisfied.
 */
export function depsState(
  task: DevFleetTaskSnapshot,
  byKey: ReadonlyMap<string, DevFleetTaskSnapshot>,
): DevDepsState {
  for (const depKey of task.dependsOn) {
    const dep = byKey.get(depKey);
    if (!dep || FAILED_LIKE.has(dep.state)) {
      return { kind: "failed", depKey };
    }
    if (dep.state !== "merged") return { kind: "waiting" };
    if (dep.planReview === "pending" || dep.planReview === "escalated") {
      return { kind: "waiting" };
    }
  }
  return { kind: "ready" };
}

// ── tick-order action planning ──────────────────────────────────────────

export type DevFleetAction =
  | { kind: "supervise"; taskId: string }
  | { kind: "merge"; taskId: string }
  | { kind: "planReview"; taskId: string }
  | { kind: "depFail"; taskId: string; failedDepKey: string }
  | { kind: "launch"; taskId: string };

/**
 * One planning pass (the tick order): ≤1 control-lane action (supervise,
 * else merge, else plan-review — mutations stay serialized), then the
 * dep-failure sweep, then launches into free worker slots. Launches are
 * independent of the control lane (loop-kit launches within the same tick
 * as its single merge).
 */
export function planFleetActions(
  tasks: readonly DevFleetTaskSnapshot[],
  maxParallel: number,
  runningCount: number,
  controlLaneBusy: boolean,
): DevFleetAction[] {
  const actions: DevFleetAction[] = [];
  const byKey = new Map(tasks.map((t) => [t.taskKey, t]));

  if (!controlLaneBusy) {
    const supervise = tasks.find((t) => t.state === "supervise_pending");
    const merge = supervise ? undefined : tasks.find((t) => t.state === "merge_pending");
    const planReview = supervise || merge
      ? undefined
      : tasks.find((t) => t.state === "merged" && t.planReview === "pending");
    if (supervise) actions.push({ kind: "supervise", taskId: supervise.id });
    else if (merge) actions.push({ kind: "merge", taskId: merge.id });
    else if (planReview) actions.push({ kind: "planReview", taskId: planReview.id });
  }

  let slots = Math.max(0, maxParallel - runningCount);
  for (const task of tasks) {
    if (task.state !== "queued") continue;
    const deps = depsState(task, byKey);
    if (deps.kind === "failed") {
      actions.push({ kind: "depFail", taskId: task.id, failedDepKey: deps.depKey });
    } else if (deps.kind === "ready" && slots > 0) {
      actions.push({ kind: "launch", taskId: task.id });
      slots--;
    }
  }
  return actions;
}

// ── Settle classification (orchestration-tail port) ─────────────────────

export type DevFleetIdleOutcome =
  | { kind: "clean" }
  | { kind: "needsHuman"; taskIds: string[] }
  | { kind: "failed"; taskIds: string[]; reason: string }
  | { kind: "stalled"; reason: string };

/**
 * Classify an IDLE fleet (no plannable actions, no running worker, control
 * lane free):
 *  - a task awaiting the user, or a merged task whose plan review escalated
 *    ⇒ the session parks (needsHuman);
 *  - everything merged/superseded ⇒ clean — run the integration gate;
 *  - any failed/dep_failed ⇒ the fleet is over, surface BLOCKED;
 *  - anything else ⇒ defensive stall (planFleetActions should be total).
 */
export function classifyIdleFleet(
  tasks: readonly DevFleetTaskSnapshot[],
): DevFleetIdleOutcome {
  const needsHuman = tasks.filter(
    (t) =>
      t.state === "awaiting_user"
      || (t.state === "merged" && t.planReview === "escalated"),
  );
  if (needsHuman.length > 0) {
    return { kind: "needsHuman", taskIds: needsHuman.map((t) => t.id) };
  }
  if (tasks.every((t) => t.state === "merged" || t.state === "superseded")) {
    return { kind: "clean" };
  }
  const failed = tasks.filter(
    (t) => t.state === "failed" || t.state === "dep_failed",
  );
  if (failed.length > 0) {
    return {
      kind: "failed",
      taskIds: failed.map((t) => t.id),
      reason:
        "fleet finished with failed task(s): "
        + failed.map((t) => `${t.taskKey} (${t.loopState ?? t.state})`).join(", "),
    };
  }
  return {
    kind: "stalled",
    reason: "fleet is idle but not settled — no plannable action remains",
  };
}

// ── Split nudge (write_split_nudge port) ────────────────────────────────

export interface DevSplitNudgeInput {
  /** The iteration about to run. */
  iteration: number;
  maxIterations: number;
  /** Percent of maxIterations; 0 = the nudge is off. */
  splitNudgeAt: number;
  /** REQ ids whose ledger status is not yet 'met'. */
  unmetReqIds: readonly string[];
  /** The wrap-up (stop) nudge always wins over the split nudge. */
  stopNudgeActive: boolean;
}

/**
 * Deterministic budget signal for fleet workers: past `splitNudgeAt`% of the
 * iteration budget with unmet REQs, nudge the next implement leg to either
 * declare NEEDS_DECOMPOSITION at a clean commit boundary or justify
 * continuing. Advisory only — the declaration is the sole stop path.
 * Returns the nudge markdown, or null when the nudge file must be removed.
 */
export function computeSplitNudge(input: DevSplitNudgeInput): string | null {
  if (input.splitNudgeAt <= 0 || input.stopNudgeActive) return null;
  const threshold = Math.max(
    1,
    Math.floor((input.maxIterations * input.splitNudgeAt) / 100),
  );
  if (input.iteration < threshold) return null;
  if (input.unmetReqIds.length === 0) return null;
  return [
    `# Budget signal: iteration ${input.iteration} of ${input.maxIterations} `
      + "with unmet requirements",
    "",
    `Still not met: ${input.unmetReqIds.join(", ")}. If the remaining work does`,
    "not clearly fit in the iterations left, do NOT push on: bring the tree to",
    "a clean, coherent boundary (the daemon commits it after evaluation), write",
    "a decision request stating exactly what is DONE (with evidence) and what",
    "REMAINS (as a proposed sequence of phases), and declare",
    "NEEDS_DECOMPOSITION in .aitne-dev/agent-state — the supervisor can split",
    "the remainder into phased tasks. If the remaining work clearly fits,",
    "justify continuing in progress.md and ignore this note.",
    "",
  ].join("\n");
}
