/**
 * Development-mode task-plan grammar + DAG validators — the pure trust core of
 * the flow port (loop-kit parse_task_plan / validate_plan_structure /
 * validate_plan_reqs / check_req_chains / supervise_replan /
 * apply_plan_revision / integration_fixup validation, loop.sh:4054-4300,
 * 2303-2560, 2656-2820, 4612-4680). No fs/db/network — stays IN the coverage
 * gate at 100%.
 *
 * The grammar is deliberately rigid (keys at column 0, exact markers) so a
 * model's plan is machine-checkable before anything runs:
 *
 *   <!-- TASK-PLAN-BEGIN v1 -->
 *   TASK: <id [a-z0-9][a-z0-9-], max 24>
 *   SUMMARY: <one line>
 *   DEPENDS: -            (or comma-separated task ids)
 *   SCOPE: <owned areas + must-not-touch>
 *   REQS: REQ-001,REQ-002
 *   BODY-BEGIN
 *   <standalone instruction>
 *   BODY-END
 *   TASK-END
 *   <!-- TASK-PLAN-END -->
 *
 * Validators fail closed with a single human/model-readable error string —
 * the caller writes it to decompose-feedback.md (retry) or escalates.
 */

// ── Types ───────────────────────────────────────────────────────────────

/** One parsed TASK block. */
export interface DevPlanTask {
  key: string;
  summary: string;
  /** [] = "DEPENDS: -". */
  dependsOn: string[];
  scope: string;
  reqs: string[];
  body: string;
}

export type DevPlanResult<T extends object = Record<never, never>> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

/**
 * The live-queue view the mutation validators re-verify against (a snapshot
 * of dev_session_tasks rows). Structural on purpose — no db import, so this
 * module stays pure and the store stays free to evolve.
 *
 * State mapping to loop-kit's maildir queue:
 *   queued            = new/
 *   running | supervise_pending | merge_pending | awaiting_user = claimed/
 *   merged            = done/
 *   failed | dep_failed = failed/ (still OWN their REQs — resumable autopsy)
 *   superseded        = failed/ with RESULT=REPLANNED (owns nothing)
 */
export interface DevLiveTaskLike {
  key: string;
  state:
    | "queued"
    | "running"
    | "supervise_pending"
    | "merge_pending"
    | "awaiting_user"
    | "merged"
    | "failed"
    | "superseded"
    | "dep_failed";
  dependsOn: readonly string[];
  reqs: readonly string[];
  seedBranch?: string | null;
}

const CLAIMED_STATES: ReadonlySet<DevLiveTaskLike["state"]> = new Set([
  "running",
  "supervise_pending",
  "merge_pending",
  "awaiting_user",
]);
/** loop-kit failed/ — a DEPENDS on any of these can never be satisfied. */
const FAILED_LIKE_STATES: ReadonlySet<DevLiveTaskLike["state"]> = new Set([
  "failed",
  "dep_failed",
  "superseded",
]);

const PLAN_BEGIN = "<!-- TASK-PLAN-BEGIN v1 -->";
const PLAN_END = "<!-- TASK-PLAN-END -->";
const TASK_KEY_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;

const err = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** Normalize a REQ token to the ledger's zero-padded form; non-REQ tokens
 *  pass through trimmed (the coverage check will flag them). */
function normalizeReq(token: string): string {
  const m = token.trim().match(/^REQ-(\d+)$/i);
  return m ? `REQ-${m[1]!.padStart(3, "0")}` : token.trim();
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = sortedUnique(a);
  const sb = sortedUnique(b);
  return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
}

// ── Grammar (parse_task_plan port) ──────────────────────────────────────

/** Wrap a REPLAN-payload body in the plan markers so one parser serves the
 *  decomposer, the supervisor, and the plan reviewer (loop-kit does the same
 *  with a temp file). */
export function wrapReplanBlock(blockBody: string): string {
  return `${PLAN_BEGIN}\n${blockBody}\n${PLAN_END}\n`;
}

/**
 * Parse the machine block of a task-plan document. Free prose before the
 * BEGIN marker (the rationale) and anything after the END marker is ignored.
 * Every violation is a hard error naming the line — the model gets it
 * verbatim as retry feedback.
 */
export function parseTaskPlan(md: string): DevPlanResult<{ tasks: DevPlanTask[] }> {
  const tasks: DevPlanTask[] = [];
  const seen = new Set<string>();
  let inPlan: 0 | 1 | 2 = 0;
  let inTask = false;
  let inBody: 0 | 1 | 2 = 0;
  let key = "";
  let summary = "";
  let depends = "";
  let scope = "";
  let reqs = "";
  let bodyLines: string[] = [];

  const lines = md.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const n = i + 1;
    if (inPlan === 0) {
      if (line === PLAN_BEGIN) inPlan = 1;
      continue;
    }
    if (inPlan !== 1) continue;
    if (inBody === 1) {
      if (line === "BODY-END") {
        inBody = 2;
      } else if (
        line === "BODY-BEGIN"
        || line === "TASK-END"
        || line.startsWith("TASK: ")
        || line.startsWith("<!-- TASK-PLAN-")
      ) {
        return err(`line ${n}: marker '${line}' inside the body of '${key}'`);
      } else {
        bodyLines.push(line);
      }
      continue;
    }
    if (line === PLAN_END) {
      if (inTask) return err(`line ${n}: plan ends inside task '${key}'`);
      inPlan = 2;
    } else if (line.startsWith("TASK: ")) {
      if (inTask) return err(`line ${n}: TASK before TASK-END of '${key}'`);
      key = line.slice("TASK: ".length);
      if (!TASK_KEY_RE.test(key)) {
        return err(
          `line ${n}: bad task id '${key}' (want [a-z0-9][a-z0-9-], max 24 chars)`,
        );
      }
      if (seen.has(key)) return err(`line ${n}: duplicate task id '${key}'`);
      inTask = true;
      inBody = 0;
      summary = "";
      depends = "";
      scope = "";
      reqs = "";
      bodyLines = [];
    } else if (line.startsWith("SUMMARY: ")) {
      if (!inTask || summary !== "") return err(`line ${n}: misplaced/duplicate SUMMARY`);
      summary = line.slice("SUMMARY: ".length);
    } else if (line.startsWith("DEPENDS: ")) {
      if (!inTask || depends !== "") return err(`line ${n}: misplaced/duplicate DEPENDS`);
      depends = line.slice("DEPENDS: ".length);
    } else if (line.startsWith("SCOPE: ")) {
      if (!inTask || scope !== "") return err(`line ${n}: misplaced/duplicate SCOPE`);
      scope = line.slice("SCOPE: ".length);
    } else if (line.startsWith("REQS: ")) {
      if (!inTask || reqs !== "") return err(`line ${n}: misplaced/duplicate REQS`);
      reqs = line.slice("REQS: ".length);
    } else if (line === "BODY-BEGIN") {
      if (!inTask) return err(`line ${n}: BODY-BEGIN outside a task`);
      if (!summary || !depends || !scope || !reqs) {
        return err(
          `line ${n}: task '${key}' is missing SUMMARY/DEPENDS/SCOPE/REQS before BODY-BEGIN`,
        );
      }
      inBody = 1;
    } else if (line === "TASK-END") {
      if (!inTask || inBody !== 2) {
        return err(`line ${n}: TASK-END without a completed body`);
      }
      const body = bodyLines.join("\n");
      if (body.trim().length === 0) {
        return err(`line ${n}: task '${key}' has an empty body`);
      }
      const parsedReqs = splitCsv(reqs).map(normalizeReq);
      // Reject a syntactically-present-but-empty REQS (`REQS:   ` / `REQS: ,,`)
      // here so EVERY caller (decompose, replan, plan-revision, fixup) is
      // protected: a zero-REQ task otherwise slips past coverage and can drop a
      // requirement from the obligation set.
      if (parsedReqs.length === 0) {
        return err(`line ${n}: task '${key}' names no REQ ids (REQS must list at least one)`);
      }
      tasks.push({
        key,
        summary,
        dependsOn: depends.trim() === "-" ? [] : splitCsv(depends),
        scope,
        reqs: parsedReqs,
        body,
      });
      seen.add(key);
      inTask = false;
      inBody = 0;
      key = "";
    } else if (line.trim() === "") {
      // blank lines between blocks are fine
    } else {
      return err(`line ${n}: unexpected line inside the plan block: ${line}`);
    }
  }
  if (inPlan !== 2) return err("missing or unterminated TASK-PLAN markers");
  if (tasks.length === 0) return err("no TASK blocks in the plan");
  return { ok: true, tasks };
}

// ── Structure (validate_plan_structure port) ────────────────────────────

export interface DevPlanStructureOpts {
  /** FLEET_MAX_TASKS. */
  cap: number;
  /** The n from the DECOMPOSE verdict; null skips the cross-check. */
  verdictN: number | null;
  /** Ids a DEPENDS may reference that are satisfied outside this plan
   *  (REPLAN blocks may depend on already-live tasks). */
  externalDepKeys: readonly string[];
}

/**
 * Deterministic, model-free, REQ-free checks. Returns the topological
 * enqueue order (Kahn's algorithm — leftovers with no progress ⇒ cycle).
 * External deps never block peeling; they are satisfied outside the plan.
 */
export function validatePlanStructure(
  tasks: readonly DevPlanTask[],
  opts: DevPlanStructureOpts,
): DevPlanResult<{ topo: string[] }> {
  const n = tasks.length;
  if (n < 1) return err("no tasks");
  if (n > opts.cap) return err(`${n} tasks exceeds the task cap of ${opts.cap}`);
  if (opts.verdictN !== null && opts.verdictN !== n) {
    return err(`the DECOMPOSE verdict says n=${opts.verdictN} but the plan defines ${n} tasks`);
  }
  const planKeys = new Set(tasks.map((t) => t.key));
  const known = new Set(opts.externalDepKeys);
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (dep === task.key) return err(`task '${task.key}' depends on itself`);
      if (!planKeys.has(dep) && !known.has(dep)) {
        return err(`task '${task.key}' depends on unknown task '${dep}'`);
      }
    }
  }
  let remaining = [...tasks];
  const topo: string[] = [];
  const peeled = new Set<string>();
  while (remaining.length > 0) {
    const rest: DevPlanTask[] = [];
    let progressed = false;
    for (const task of remaining) {
      const blocked = task.dependsOn.some(
        (dep) => planKeys.has(dep) && !peeled.has(dep),
      );
      if (blocked) {
        rest.push(task);
      } else {
        topo.push(task.key);
        peeled.add(task.key);
        progressed = true;
      }
    }
    remaining = rest;
    if (!progressed) {
      return err(`dependency cycle among: ${remaining.map((t) => t.key).join(", ")}`);
    }
  }
  return { ok: true, topo };
}

/** In-plan transitive DEPENDS closure of one task (plan_ancestors port). */
export function planAncestors(
  tasks: readonly DevPlanTask[],
  key: string,
): Set<string> {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const anc = new Set<string>();
  let frontier = [key];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const k of frontier) {
      for (const dep of byKey.get(k)?.dependsOn ?? []) {
        if (!byKey.has(dep) || anc.has(dep)) continue;
        anc.add(dep);
        next.push(dep);
      }
    }
    frontier = next;
  }
  return anc;
}

/**
 * The completing-owner rule (check_req_chains port): a REQ owned by several
 * tasks is legal ONLY when the topo-last owner is a DEPENDS-descendant of
 * EVERY other owner. Two shapes pass — a sequential chain and a fork-join
 * whose join owns the REQ. Join-less parallel co-owners are rejected.
 */
export function checkReqChains(
  tasks: readonly DevPlanTask[],
  topo: readonly string[],
): DevPlanResult {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const allReqs = sortedUnique(tasks.flatMap((t) => [...t.reqs]));
  for (const req of allReqs) {
    const owners = topo.filter((k) => byKey.get(k)?.reqs.includes(req));
    if (owners.length <= 1) continue;
    const last = owners[owners.length - 1]!;
    const anc = planAncestors(tasks, last);
    for (const owner of owners) {
      if (owner === last) continue;
      if (!anc.has(owner)) {
        return err(
          `REQ '${req}' is shared by tasks '${owner}' and '${last}' with no single `
            + "completing owner (a shared REQ needs a strictly sequential DEPENDS "
            + "chain, or a fork-join whose final owner depends on all other owners)",
        );
      }
    }
  }
  return { ok: true };
}

/**
 * REQ ownership (validate_plan_reqs port): every master REQ covered, nothing
 * invented, every task owns at least one REQ, shared REQs pass the
 * completing-owner check.
 */
export function validatePlanReqs(
  tasks: readonly DevPlanTask[],
  topo: readonly string[],
  masterReqIds: readonly string[],
): DevPlanResult {
  if (masterReqIds.length === 0) {
    return err("the master contract defines no REQ-xxx ids");
  }
  for (const task of tasks) {
    if (task.reqs.length === 0) return err(`task '${task.key}' owns no REQs`);
  }
  const planReqs = sortedUnique(tasks.flatMap((t) => [...t.reqs]));
  const master = sortedUnique(masterReqIds);
  if (!sameSet(planReqs, master)) {
    return err(
      `REQ coverage mismatch — master: ${master.join(" ")} / plan: ${planReqs.join(" ")}`,
    );
  }
  return checkReqChains(tasks, topo);
}

export interface DevTaskPlanOpts {
  cap: number;
  verdictN: number | null;
  masterReqIds: readonly string[];
}

/** Full decompose-output validation (validate_task_plan port). */
export function validateTaskPlan(
  md: string,
  opts: DevTaskPlanOpts,
): DevPlanResult<{ tasks: DevPlanTask[]; topo: string[] }> {
  const parsed = parseTaskPlan(md);
  if (!parsed.ok) return parsed;
  const structure = validatePlanStructure(parsed.tasks, {
    cap: opts.cap,
    verdictN: opts.verdictN,
    externalDepKeys: [],
  });
  if (!structure.ok) return structure;
  const reqsOk = validatePlanReqs(parsed.tasks, structure.topo, opts.masterReqIds);
  if (!reqsOk.ok) return reqsOk;
  return { ok: true, tasks: parsed.tasks, topo: structure.topo };
}

/** Topological layers — tasks in one layer have no path between them and may
 *  run in parallel (digest + dashboard rendering; not a scheduler input). */
export function planParallelGroups(tasks: readonly DevPlanTask[]): string[][] {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const depth = new Map<string, number>();
  const layerOf = (key: string, trail: Set<string>): number => {
    const cached = depth.get(key);
    if (cached !== undefined) return cached;
    if (trail.has(key)) return 0; // cycle guard — validators reject these anyway
    trail.add(key);
    // Only called with keys from `tasks` (the recursion filters on byKey.has).
    const inPlanDeps = byKey.get(key)!.dependsOn.filter((d) => byKey.has(d));
    const layer = inPlanDeps.length === 0
      ? 0
      : 1 + Math.max(...inPlanDeps.map((d) => layerOf(d, trail)));
    trail.delete(key);
    depth.set(key, layer);
    return layer;
  };
  const groups: string[][] = [];
  for (const task of tasks) {
    const layer = layerOf(task.key, new Set());
    while (groups.length <= layer) groups.push([]);
    groups[layer]!.push(task.key);
  }
  return groups.filter((g) => g.length > 0);
}

// ── Live-queue relations (env_dep_ancestors / dep_related /
//    fork_join_related / req_owner_elsewhere ports) ─────────────────────

/** Transitive DEPENDS closure over the LIVE queue (all recorded tasks,
 *  whatever their state — mirrors env_dep_ancestors over runs/*.env). */
export function liveDepAncestors(
  tasks: readonly DevLiveTaskLike[],
  key: string,
): Set<string> {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const anc = new Set<string>();
  let frontier = [key];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const k of frontier) {
      for (const dep of byKey.get(k)?.dependsOn ?? []) {
        if (anc.has(dep)) continue;
        anc.add(dep);
        if (byKey.has(dep)) next.push(dep);
      }
    }
    frontier = next;
  }
  return anc;
}

/** Two tasks sit on one DEPENDS chain (either direction) — chain members
 *  legally share a REQ (phased work). */
export function liveDepRelated(
  tasks: readonly DevLiveTaskLike[],
  a: string,
  b: string,
): boolean {
  return liveDepAncestors(tasks, a).has(b) || liveDepAncestors(tasks, b).has(a);
}

/** Some live (non-superseded) task owning `req` has BOTH `owner` and `anchor`
 *  in its transitive closure — the two are parallel branches of a DECLARED
 *  fork whose joining owner completes the REQ. Fail closed: no join found ⇒
 *  the conflict stands. */
export function liveForkJoinRelated(
  tasks: readonly DevLiveTaskLike[],
  owner: string,
  anchor: string,
  req: string,
): boolean {
  for (const j of tasks) {
    if (j.key === owner || j.key === anchor) continue;
    if (j.state === "superseded") continue;
    if (!j.reqs.includes(req)) continue;
    const anc = liveDepAncestors(tasks, j.key);
    if (anc.has(owner) && anc.has(anchor)) return true;
  }
  return false;
}

/**
 * Cross-fleet REQ-uniqueness re-verification (req_owner_elsewhere port):
 * the decompose validator proved it once, but replans/fix-ups mutate
 * ownership later. Returns the conflicting owner's key, or null.
 * Superseded tasks own nothing; merged tasks count only when `includeDone`;
 * failed-but-resumable tasks still own their REQs. An owner chain- or
 * fork-join-related to `chainOkKey` is NOT a conflict.
 */
export function liveReqOwnerElsewhere(
  tasks: readonly DevLiveTaskLike[],
  req: string,
  excludeKey: string,
  includeDone: boolean,
  chainOkKey?: string,
): string | null {
  for (const other of tasks) {
    if (other.key === excludeKey) continue;
    if (other.state === "superseded") continue;
    if (other.state === "merged" && !includeDone) continue;
    if (!other.reqs.includes(req)) continue;
    if (chainOkKey) {
      if (liveDepRelated(tasks, other.key, chainOkKey)) continue;
      if (liveForkJoinRelated(tasks, other.key, chainOkKey, req)) continue;
    }
    return other.key;
  }
  return null;
}

// ── Supervisor REPLAN validation (supervise_replan port) ────────────────

export interface DevReplanOpts {
  /** The escalated task's key (closes as superseded — a block DEPENDS on it
   *  is rejected as unknown, exactly like loop-kit). */
  escalatedKey: string;
  /** The escalated task's REQ ownership — the replacement scope bound. */
  escalatedReqs: readonly string[];
  /** EVERY recorded task of the session (any state), incl. the escalated. */
  liveTasks: readonly DevLiveTaskLike[];
  /** Cumulative replacement tasks already spent (session replan_count). */
  replanBudgetUsed: number;
  /** FLEET_MAX_REPLAN_TASKS. */
  replanCap: number;
  /** FLEET_MAX_TASKS (structural cap for the block itself). */
  maxTasks: number;
}

export interface DevReplanValidated {
  tasks: DevPlanTask[];
  topo: string[];
  /** The block member with no intra-block DEPENDS — the carryover seed
   *  target. Null when the block forks from 2+ roots (seed is dropped,
   *  journaled by the caller). */
  uniqueRootKey: string | null;
  /** Block members no other member depends on — dependents of the escalated
   *  task are rewired onto these. */
  sinkKeys: string[];
}

/** Validate a supervisor REPLAN payload (the body between REPLAN-BEGIN/END). */
export function validateReplanBlock(
  blockBody: string,
  opts: DevReplanOpts,
): DevPlanResult<DevReplanValidated> {
  const parsed = parseTaskPlan(wrapReplanBlock(blockBody));
  if (!parsed.ok) return parsed;
  const tasks = parsed.tasks;
  const existingKeys = new Set(opts.liveTasks.map((t) => t.key));
  for (const t of tasks) {
    if (existingKeys.has(t.key)) {
      return err(`replacement id '${t.key}' already exists`);
    }
  }
  // External deps = every recorded task EXCEPT the escalated one (it closes
  // as superseded; depending on it would DEP_FAIL the replacement at claim).
  const known = opts.liveTasks
    .map((t) => t.key)
    .filter((k) => k !== opts.escalatedKey);
  const structure = validatePlanStructure(tasks, {
    cap: opts.maxTasks,
    verdictN: null,
    externalDepKeys: known,
  });
  if (!structure.ok) return structure;
  // A DEPENDS on a failed-like task can never be satisfied.
  const failedDep = findFailedExternalDep(tasks, opts.liveTasks);
  if (failedDep) {
    return err(
      `replacement '${failedDep.taskKey}' depends on failed task `
        + `'${failedDep.depKey}' — it would park DEP_FAILED at claim`,
    );
  }
  const ownReqs = sortedUnique(opts.escalatedReqs);
  if (ownReqs.length > 0) {
    const ownSet = new Set(ownReqs);
    for (const t of tasks) {
      for (const req of t.reqs) {
        if (!ownSet.has(req)) {
          return err(
            `replacement '${t.key}' claims ${req} outside the escalated task's `
              + `REQs (${ownReqs.join(",")})`,
          );
        }
        const owner = liveReqOwnerElsewhere(
          opts.liveTasks,
          req,
          opts.escalatedKey,
          true,
          opts.escalatedKey,
        );
        if (owner) {
          return err(`replacement '${t.key}' claims ${req} already owned by task '${owner}'`);
        }
      }
    }
    const blockReqs = sortedUnique(tasks.flatMap((t) => [...t.reqs]));
    if (!sameSet(blockReqs, ownReqs)) {
      return err(
        "replacements do not cover the escalated task's REQs "
          + `(own: ${ownReqs.join(" ")} — plan: ${blockReqs.join(" ")})`,
      );
    }
    const chains = checkReqChains(tasks, structure.topo);
    if (!chains.ok) return chains;
  }
  if (opts.replanBudgetUsed + tasks.length > opts.replanCap) {
    return err(
      `replan budget exceeded (${opts.replanBudgetUsed} + ${tasks.length} > `
        + `cap ${opts.replanCap})`,
    );
  }
  // Post-swap in-flight cap (mirrors validatePlanRevision): the escalated task
  // closes superseded (−1 if it currently counts as live) and the block adds
  // its tasks. Without this, a REPLAN of an already-full fleet blows past
  // maxTasks concurrent workers.
  const liveCount = opts.liveTasks.filter(
    (t) => t.state === "queued" || CLAIMED_STATES.has(t.state),
  ).length;
  const escalatedLive = opts.liveTasks.some(
    (t) => t.key === opts.escalatedKey && (t.state === "queued" || CLAIMED_STATES.has(t.state)),
  )
    ? 1
    : 0;
  const after = liveCount - escalatedLive + tasks.length;
  if (after > opts.maxTasks) {
    return err(`replan would put ${after} tasks in flight > cap ${opts.maxTasks}`);
  }
  const { roots, sinks } = blockRootsAndSinks(tasks);
  return {
    ok: true,
    tasks,
    topo: structure.topo,
    uniqueRootKey: roots.length === 1 ? roots[0]! : null,
    sinkKeys: sinks,
  };
}

// ── Plan-review REVISE validation (apply_plan_revision port) ────────────

export interface DevPlanRevisionOpts {
  /** EVERY recorded task of the session (any state). */
  liveTasks: readonly DevLiveTaskLike[];
  /** FLEET_MAX_REPLAN_TASKS — also bounds a revision block. */
  maxReplanTasks: number;
  /** FLEET_MAX_TASKS — bounds the post-swap in-flight queue. */
  maxTasks: number;
}

export interface DevPlanRevisionValidated {
  tasks: DevPlanTask[];
  topo: string[];
  /** The queued tasks the block replaces (resolved from its REQ union). */
  replacedKeys: string[];
  /** A pending carryover seed held by a replaced task, if any. */
  seedBranch: string | null;
  /** Where the seed moves — the block's unique root; null = seed dropped
   *  (caller journals CARRYOVER_SKIPPED). */
  seedTargetKey: string | null;
}

/**
 * Validate a plan-review REVISE payload. The block implicitly targets the
 * QUEUED tasks whose REQ sets its REQ union covers; merged owners are fine
 * (completed chain phases legitimately share), claimed or parked owners
 * reject the revision.
 */
export function validatePlanRevision(
  blockBody: string,
  opts: DevPlanRevisionOpts,
): DevPlanResult<DevPlanRevisionValidated> {
  const parsed = parseTaskPlan(wrapReplanBlock(blockBody));
  if (!parsed.ok) return parsed;
  const tasks = parsed.tasks;
  const byKey = new Map(opts.liveTasks.map((t) => [t.key, t]));
  for (const t of tasks) {
    if (byKey.has(t.key)) return err(`replacement id '${t.key}' already exists`);
  }
  if (tasks.length > opts.maxReplanTasks) {
    return err(
      `revision block has ${tasks.length} tasks > cap ${opts.maxReplanTasks}`,
    );
  }
  // Resolve R (the replaced set) from the block's REQ union.
  const blockReqs = sortedUnique(tasks.flatMap((t) => [...t.reqs]));
  const replaced: string[] = [];
  for (const req of blockReqs) {
    for (const live of opts.liveTasks) {
      if (!live.reqs.includes(req)) continue;
      if (live.state === "queued") {
        if (!replaced.includes(live.key)) replaced.push(live.key);
      } else if (live.state === "merged" || live.state === "superseded") {
        // merged: a completed chain phase legitimately shares the REQ;
        // superseded: owns nothing.
      } else if (live.state === "failed" || live.state === "dep_failed") {
        return err(`REQ ${req} belongs to parked task '${live.key}' — not revisable`);
      } else {
        return err(
          `REQ ${req} belongs to claimed task '${live.key}' — a revision may `
            + "only touch unclaimed tasks",
        );
      }
    }
  }
  if (replaced.length === 0) {
    return err("the revision's REQs match no queued task — nothing to replace");
  }
  // REQ conservation: block union == union of the replaced tasks' REQs.
  const replacedReqs = sortedUnique(
    replaced.flatMap((k) => [...byKey.get(k)!.reqs]),
  );
  if (!sameSet(blockReqs, replacedReqs)) {
    return err(
      "revision does not conserve the replaced tasks' REQ union "
        + `(replaced: ${replaced.join(" ")})`,
    );
  }
  // No surviving queued task may depend on a replaced one.
  const replacedSet = new Set(replaced);
  for (const live of opts.liveTasks) {
    if (live.state !== "queued" || replacedSet.has(live.key)) continue;
    for (const dep of live.dependsOn) {
      if (replacedSet.has(dep)) {
        return err(
          `queued task '${live.key}' depends on replaced task '${dep}' — `
            + "include it in the revision",
        );
      }
    }
  }
  // Structural validation; external deps = every recorded id except R.
  const known = opts.liveTasks
    .map((t) => t.key)
    .filter((k) => !replacedSet.has(k));
  const structure = validatePlanStructure(tasks, {
    cap: opts.maxTasks,
    verdictN: null,
    externalDepKeys: known,
  });
  if (!structure.ok) return structure;
  const failedDep = findFailedExternalDep(tasks, opts.liveTasks);
  if (failedDep) {
    return err(
      `revision task '${failedDep.taskKey}' depends on failed task `
        + `'${failedDep.depKey}' — it would park DEP_FAILED at claim`,
    );
  }
  const chains = checkReqChains(tasks, structure.topo);
  if (!chains.ok) return chains;
  // Queue-size cap after the swap (queued + claimed states count as live).
  const liveCount = opts.liveTasks.filter(
    (t) => t.state === "queued" || CLAIMED_STATES.has(t.state),
  ).length;
  const after = liveCount - replaced.length + tasks.length;
  if (after > opts.maxTasks) {
    return err(`revision would put ${after} tasks in flight > cap ${opts.maxTasks}`);
  }
  // Preserve a pending carryover held by a replaced-but-unclaimed root.
  let seedBranch: string | null = null;
  for (const k of replaced) {
    const s = byKey.get(k)?.seedBranch;
    if (s) seedBranch = s;
  }
  let seedTargetKey: string | null = null;
  if (seedBranch) {
    const { roots } = blockRootsAndSinks(tasks);
    seedTargetKey = roots.length === 1 ? roots[0]! : null;
  }
  return {
    ok: true,
    tasks,
    topo: structure.topo,
    replacedKeys: replaced,
    seedBranch,
    seedTargetKey,
  };
}

// ── Integration fix-up validation (integration_fixup port) ──────────────

export interface DevFixupOpts {
  /** EVERY recorded task of the session (any state). */
  liveTasks: readonly DevLiveTaskLike[];
}

/** Validate an integration-gate fix-up payload: EXACTLY ONE task, unique id,
 *  deps must exist and not be failed-like, REQs must not collide with a
 *  live/parked task's scope (revisiting merged REQs is legitimate). */
export function validateFixupTask(
  blockBody: string,
  opts: DevFixupOpts,
): DevPlanResult<{ task: DevPlanTask }> {
  const parsed = parseTaskPlan(wrapReplanBlock(blockBody));
  if (!parsed.ok) return parsed;
  if (parsed.tasks.length !== 1) {
    return err(
      `integration fix-up must be exactly ONE task (got ${parsed.tasks.length})`,
    );
  }
  const task = parsed.tasks[0]!;
  const byKey = new Map(opts.liveTasks.map((t) => [t.key, t]));
  if (byKey.has(task.key)) return err(`fix-up id '${task.key}' already exists`);
  for (const dep of task.dependsOn) {
    const live = byKey.get(dep);
    if (!live) return err(`fix-up depends on unknown task '${dep}'`);
    if (FAILED_LIKE_STATES.has(live.state)) {
      return err(`fix-up depends on failed task '${dep}'`);
    }
  }
  for (const req of task.reqs) {
    const owner = liveReqOwnerElsewhere(opts.liveTasks, req, task.key, false);
    if (owner) return err(`fix-up claims ${req} owned by live task '${owner}'`);
  }
  return { ok: true, task };
}

// ── shared internals ────────────────────────────────────────────────────

/** Roots = block members with no intra-block DEPENDS; sinks = members no
 *  other member depends on. */
function blockRootsAndSinks(
  tasks: readonly DevPlanTask[],
): { roots: string[]; sinks: string[] } {
  const keys = new Set(tasks.map((t) => t.key));
  const referenced = new Set<string>();
  const roots: string[] = [];
  for (const t of tasks) {
    let hasIntra = false;
    for (const dep of t.dependsOn) {
      if (keys.has(dep)) {
        hasIntra = true;
        referenced.add(dep);
      }
    }
    if (!hasIntra) roots.push(t.key);
  }
  const sinks = tasks.map((t) => t.key).filter((k) => !referenced.has(k));
  return { roots, sinks };
}

/** First block task whose EXTERNAL dep is failed-like, if any. */
function findFailedExternalDep(
  tasks: readonly DevPlanTask[],
  liveTasks: readonly DevLiveTaskLike[],
): { taskKey: string; depKey: string } | null {
  const blockKeys = new Set(tasks.map((t) => t.key));
  const byKey = new Map(liveTasks.map((t) => [t.key, t]));
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (blockKeys.has(dep)) continue;
      const live = byKey.get(dep);
      if (live && FAILED_LIKE_STATES.has(live.state)) {
        return { taskKey: t.key, depKey: dep };
      }
    }
  }
  return null;
}
