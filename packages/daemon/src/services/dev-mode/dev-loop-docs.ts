/**
 * Development-mode working directory (.aitne-dev/) reader/writer + git ops +
 * the deterministic verify runner. This is the on-disk memory both the model
 * legs (via Read/Write in the repo) and the deterministic evaluator share —
 * the native port of loop-kit's .loop/ directory, living gitignored INSIDE
 * the registered repo.
 *
 * I/O-bound (fs + git/verify subprocesses); excluded from the coverage gate.
 * The PURE ledger/verdict logic it leans on lives in the covered peers
 * (verdict-parse.ts, dev-loop-evaluate.ts).
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { DevRequirementStatus } from "../../db/dev-sessions-store.js";

export const DEV_DIR_NAME = ".aitne-dev";

/** Relative doc paths inside .aitne-dev/. */
export const DEV_DOCS = {
  contract: "docs/product-contract.md",
  /** Machine loop config the interview agent proposes (verifyCommands etc.);
   *  the runner reads + validates it at CONTRACT_READY. JSON. */
  loopConfig: "docs/loop-config.json",
  ledger: "docs/requirements-ledger.md",
  plan: "docs/implementation-plan.md",
  progress: "docs/progress.md",
  assumptions: "docs/assumptions.md",
  decisionRequests: "docs/decision-requests.md",
  evidence: "docs/evidence-report.md",
  agentState: "agent-state",
  reviewFeedback: "review-feedback.md",
  lastVerify: "last-verify.log",
  /** Per-command baseline verify results captured once at run start — the
   *  red→green record the evidence report flips against (loop-kit
   *  .loop/baseline-verify.log). Lives under docs/ so the per-iteration
   *  history snapshots carry it. */
  baselineVerify: "docs/baseline-verify.log",
  // ── fleet/flow docs (loop-kit task-plan / supervisor / worktree files) ──
  /** The decomposed task DAG (grammar in task-plan.ts). */
  taskPlan: "docs/task-plan.md",
  /** A worker worktree's job — the decomposed TASK body. */
  taskInstruction: "docs/task-instruction.md",
  /** Reuse marker: sha256(contract + task-plan) of the APPROVED plan. */
  decomposeApproved: "decompose-approved",
  /** Deterministic-validator feedback for the decompose retry. */
  decomposeFeedback: "decompose-feedback.md",
  /** Decompose-reviewer feedback for the regenerate round. */
  decomposeReviewFeedback: "decompose-review-feedback.md",
  /** Supervisor ANSWER payload — the worker treats it as the owner decision. */
  supervisorGuidance: "supervisor-guidance.md",
  /** Fleet budget signal (computeSplitNudge output). */
  splitNudge: "split-nudge.md",
  /** What the sibling loops are doing (refreshed on launch/merge/supersede). */
  parallelContext: "parallel-context.md",
} as const;

/** Directory (inside .aitne-dev/) holding merged dependencies' archived
 *  task-instruction + evidence, copied into a dependent's worktree. */
export const DEV_PHASE_CONTEXT_DIR = "phase-context";
/** Directory (inside .aitne-dev/) holding the per-iteration docs snapshots
 *  that make `!rollback <n>` able to restore the gitignored working memory
 *  alongside the code reset (docs are NOT in the checkpoint commits). */
export const DEV_HISTORY_DIR = "history";
/** Directory (inside the PARENT repo's .aitne-dev/) archiving each merged
 *  task's instruction/evidence/ledger — the phase-context + publisher source. */
export const DEV_TASK_ARCHIVE_DIR = "task-archive";

/** Filename (inside a merged task's `${DEV_TASK_ARCHIVE_DIR}/<taskKey>/`) that
 *  records the owner's answer to a plan-review escalation. Written by the
 *  runner on resume and re-read by the orchestrator's `planReviewTask` so the
 *  re-run folds the owner's keep/drop/revise call into the plan review rather
 *  than rubber-stamping it (WP3 P1-14). */
export const DEV_OWNER_PLAN_DECISION_FILE = "owner-plan-decision.md";

function devDir(repoPath: string): string {
  return join(repoPath, DEV_DIR_NAME);
}

function devPath(repoPath: string, rel: string): string {
  return join(devDir(repoPath), rel);
}

// ── working-dir lifecycle ───────────────────────────────────────────────

/** Create .aitne-dev/docs/ and ensure the repo .gitignore excludes it
 *  (idempotent — loop-kit ensure_gitignore). */
export function ensureDevWorkdir(repoPath: string): void {
  mkdirSync(devPath(repoPath, "docs"), { recursive: true });
  const gitignorePath = join(repoPath, ".gitignore");
  const line = `${DEV_DIR_NAME}/`;
  let body = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
  const has = body
    .split(/\r?\n/)
    .some((l) => l.trim() === line || l.trim() === DEV_DIR_NAME);
  if (!has) {
    if (body.length > 0 && !body.endsWith("\n")) body += "\n";
    body += `${line}\n`;
    writeFileSync(gitignorePath, body, "utf8");
  }
}

// ── generic doc read/write ──────────────────────────────────────────────

export function readDevDoc(repoPath: string, rel: string): string | null {
  const p = devPath(repoPath, rel);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

export function writeDevDoc(repoPath: string, rel: string, content: string): void {
  const p = devPath(repoPath, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content, "utf8");
}

export function appendDevDoc(repoPath: string, rel: string, content: string): void {
  const existing = readDevDoc(repoPath, rel) ?? "";
  const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  writeDevDoc(repoPath, rel, existing + sep + content);
}

export function removeDevDoc(repoPath: string, rel: string): void {
  const p = devPath(repoPath, rel);
  if (existsSync(p)) rmSync(p);
}

/** Copy one .aitne-dev doc between repos/worktrees (phase-context / archive
 *  plumbing). Missing sources are a silent no-op — the archives are advisory. */
export function copyDevDoc(
  fromRepo: string,
  fromRel: string,
  toRepo: string,
  toRel: string,
): void {
  const body = readDevDoc(fromRepo, fromRel);
  if (body === null) return;
  writeDevDoc(toRepo, toRel, body);
}

// ── per-iteration docs snapshots (!rollback support) ────────────────────

/**
 * Snapshot docs/ → history/iter-<n>/ right after each iteration's checkpoint
 * commit. `.aitne-dev/` is gitignored, so the checkpoint commits do NOT carry
 * the working memory — without these, `!rollback <n>` would reset the code
 * while the ledger/plan/progress kept describing a FUTURE state. Bounded by
 * maxIterations; snapshots copy docs/ only (never history/ itself).
 */
export function snapshotDevDocs(repoPath: string, iteration: number): void {
  const src = devPath(repoPath, "docs");
  if (!existsSync(src)) return;
  const dst = devPath(repoPath, join(DEV_HISTORY_DIR, `iter-${iteration}`));
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dst, { recursive: true });
  cpSync(src, dst, { recursive: true });
}

/** Restore docs/ from the iteration-n snapshot; false when the snapshot is
 *  absent (pre-feature session — the caller reports the docs may be stale). */
export function restoreDevDocsSnapshot(repoPath: string, iteration: number): boolean {
  const src = devPath(repoPath, join(DEV_HISTORY_DIR, `iter-${iteration}`));
  if (!existsSync(src)) return false;
  const dst = devPath(repoPath, "docs");
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dst, { recursive: true });
  cpSync(src, dst, { recursive: true });
  return true;
}

/**
 * Concatenate a worktree's phase-context/<dep>/ files (merged dependencies'
 * archived task instruction + evidence) into one advisory block for the
 * plan/implement context, capped. Null when the dir is absent/empty.
 */
export function readPhaseContext(repoPath: string, capBytes = 24_000): string | null {
  const dir = devPath(repoPath, DEV_PHASE_CONTEXT_DIR);
  if (!existsSync(dir)) return null;
  const parts: string[] = [];
  for (const dep of readdirSync(dir).sort()) {
    const depDir = join(dir, dep);
    let files: string[];
    try {
      files = readdirSync(depDir).sort();
    } catch {
      continue; // a stray file at the top level — phase-context is dirs only
    }
    for (const f of files) {
      try {
        const body = readFileSync(join(depDir, f), "utf8").trim();
        if (body.length > 0) parts.push(`### ${dep}/${f}\n${body}`);
      } catch {
        // advisory — skip unreadable entries
      }
    }
  }
  if (parts.length === 0) return null;
  const joined = parts.join("\n\n");
  return joined.length > capBytes
    ? `${joined.slice(0, capBytes)}\n… (phase context truncated)`
    : joined;
}

/** The first token of agent-state (implement leg's declared state), or null. */
export function readAgentStateFirstLine(repoPath: string): string | null {
  const body = readDevDoc(repoPath, DEV_DOCS.agentState);
  if (body === null) return null;
  const first = body.split(/\r?\n/)[0];
  return first !== undefined && first.trim().length > 0 ? first : null;
}

/** Delete agent-state at the top of an iteration (loop-kit deletes it each
 *  iteration so a stale token never leaks forward). */
export function clearAgentState(repoPath: string): void {
  removeDevDoc(repoPath, DEV_DOCS.agentState);
}

// ── requirements ledger (Markdown <-> DB status) ────────────────────────

/** MD status token (hyphenated) → DB status token (underscored). */
export function ledgerStatusToDb(md: string): DevRequirementStatus {
  const norm = md.trim().toLowerCase().replace(/-/g, "_");
  switch (norm) {
    case "in_progress":
      return "in_progress";
    case "met":
      return "met";
    case "at_risk":
      return "at_risk";
    case "regressed":
      return "regressed";
    default:
      return "unstarted";
  }
}

export interface ParsedLedgerRow {
  reqId: string;
  status: DevRequirementStatus;
  evidence: string;
  iter: number | null;
}

/**
 * Parse the ledger Markdown table (| REQ | Status | Evidence | Iter |) into
 * rows. Only lines whose first cell is a REQ-### id count; the header/
 * separator rows are ignored.
 */
export function parseLedgerMarkdown(md: string | null): ParsedLedgerRow[] {
  if (!md) return [];
  const rows: ParsedLedgerRow[] = [];
  for (const raw of md.split(/\r?\n/)) {
    if (!raw.includes("|")) continue;
    const cells = raw.split("|").map((c) => c.trim());
    // Leading empty cell from the border pipe → cells[1] is REQ.
    const idCell = cells.find((c) => /^REQ-\d+$/i.test(c));
    if (!idCell) continue;
    const idx = cells.indexOf(idCell);
    const reqId = `REQ-${idCell.replace(/^REQ-/i, "").padStart(3, "0")}`;
    const status = ledgerStatusToDb(cells[idx + 1] ?? "unstarted");
    const evidence = cells[idx + 2] ?? "";
    const iterRaw = cells[idx + 3] ?? "";
    const iterNum = Number.parseInt(iterRaw, 10);
    rows.push({
      reqId,
      status,
      evidence,
      iter: Number.isFinite(iterNum) ? iterNum : null,
    });
  }
  return rows;
}

// ── git operations (execFileSync — no shell) ────────────────────────────

function git(repoPath: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** True when repoPath is inside a git worktree (loop-kit assert_git_worktree
 *  — replicated because the daemon's own guard is not exported). */
export function isGitWorktree(repoPath: string): boolean {
  try {
    return git(repoPath, ["rev-parse", "--is-inside-work-tree"]) === "true";
  } catch {
    return false;
  }
}

export function gitInit(repoPath: string): void {
  git(repoPath, ["init"]);
}

export function gitHead(repoPath: string): string | null {
  try {
    return git(repoPath, ["rev-parse", "HEAD"]);
  } catch {
    return null; // zero-commit repo
  }
}

/** Per-path absolute git-dir memo. The guards below run at EVERY iteration
 *  top + before every commit; on machines with slow process spawn (~200ms/
 *  exec) doing them as subprocesses is real per-iteration latency, so they
 *  read the git plumbing files directly and only spawn to (re)discover the
 *  git dir. A stale entry (repo re-created / worktree re-added) self-heals:
 *  the HEAD probe fails and the dir is re-derived. */
const GIT_DIR_CACHE = new Map<string, string>();

function resolveGitDir(repoPath: string): string | null {
  const cached = GIT_DIR_CACHE.get(repoPath);
  if (cached && existsSync(join(cached, "HEAD"))) return cached;
  try {
    const dir = git(repoPath, ["rev-parse", "--absolute-git-dir"]);
    GIT_DIR_CACHE.set(repoPath, dir);
    return dir;
  } catch {
    GIT_DIR_CACHE.delete(repoPath);
    return null;
  }
}

export function gitCurrentBranch(repoPath: string): string | null {
  const dir = resolveGitDir(repoPath);
  if (dir) {
    try {
      const head = readFileSync(join(dir, "HEAD"), "utf8").trim();
      if (head.startsWith("ref: refs/heads/")) {
        return head.slice("ref: refs/heads/".length);
      }
      return null; // detached HEAD (raw sha)
    } catch {
      // racing checkout — fall through to the subprocess
    }
  }
  try {
    const b = git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    return b === "HEAD" ? null : b;
  } catch {
    return null;
  }
}

export function gitCreateBranch(repoPath: string, branch: string): void {
  git(repoPath, ["checkout", "-B", branch]);
}

/** True when a merge is in progress (MERGE_HEAD exists). Canonical home —
 *  dev-flow-git re-exports it for the fleet callers. Reads the plumbing file
 *  directly (see GIT_DIR_CACHE) — this runs before every commit. */
export function gitMergeInProgress(repoPath: string): boolean {
  const dir = resolveGitDir(repoPath);
  if (dir) return existsSync(join(dir, "MERGE_HEAD"));
  try {
    git(repoPath, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]);
    return true;
  } catch {
    return false;
  }
}

/** Any uncommitted change, tracked or untracked (`git status --porcelain`
 *  non-empty) — the recovered-work-commit probe on resume. Distinct from
 *  dev-flow-git's hasUncommittedTracked (-uno), which deliberately ignores
 *  untracked files for the merge-defer guard. */
export function gitStatusDirty(repoPath: string): boolean {
  try {
    return git(repoPath, ["status", "--porcelain"]).length > 0;
  } catch {
    return false;
  }
}

/**
 * Pre-flight guards for any in-place git mutation (loop-kit 3775-3784 +
 * the branch-identity hazard unique to a daemon sharing the owner's
 * checkout): never `add -A` over a half-resolved merge, and never commit /
 * merge when the owner moved the checkout off the expected branch. The
 * returned `question` is chat-ready — callers park the session on it via the
 * existing spec_decision escalation. `expectedBranch` null skips the
 * branch-identity half (pre-approval sites). TOCTOU between this check and
 * the following git call is accepted (single-owner local repo; same posture
 * as loop-kit).
 */
export type DevRepoGuard =
  | { ok: true }
  | {
      ok: false;
      kind: "merge_in_progress" | "branch_moved";
      currentBranch: string | null;
      question: string;
    };

export type DevRepoGuardFailure = Extract<DevRepoGuard, { ok: false }>;

/** Thrown by the helpers that CANNOT return an outcome (gitCommitAll's
 *  backstop, the plan leg's pre-commit preflight). Callers park the session
 *  on `guard.question` instead of failing it. */
export class DevRepoGuardError extends Error {
  readonly guard: DevRepoGuardFailure;

  constructor(guard: DevRepoGuardFailure) {
    super(guard.question);
    this.name = "DevRepoGuardError";
    this.guard = guard;
  }
}

function mergeInProgressGuard(repoPath: string): DevRepoGuardFailure {
  return {
    ok: false,
    kind: "merge_in_progress",
    currentBranch: gitCurrentBranch(repoPath),
    question:
      "A git merge is in progress in the repository — resolve it (or run "
      + "`git merge --abort`), then reply here to resume, or !exit.",
  };
}

export function checkRepoGuards(
  repoPath: string,
  expectedBranch: string | null,
): DevRepoGuard {
  if (gitMergeInProgress(repoPath)) {
    return mergeInProgressGuard(repoPath);
  }
  if (expectedBranch !== null) {
    const current = gitCurrentBranch(repoPath);
    if (current !== expectedBranch) {
      const shown = current ?? "(detached HEAD)";
      return {
        ok: false,
        kind: "branch_moved",
        currentBranch: current,
        question:
          `The repository checkout moved to '${shown}' (expected `
          + `'${expectedBranch}'). Run \`git checkout ${expectedBranch}\` and `
          + "reply here to resume, or !exit.",
      };
    }
  }
  return { ok: true };
}

/**
 * Re-validate a recorded base sha against real git history (loop-kit
 * 6913-6923): the ref must resolve to a commit AND be an ancestor of HEAD.
 * On failure — history rewritten, ref garbage, or null — degrade to HEAD,
 * which is never weaker than a fresh run (a fresh run resets the base to the
 * interruption point anyway). Callers journal the degradation.
 */
export function validateBaseRef(
  repoPath: string,
  ref: string | null,
): { ref: string; degraded: boolean } {
  if (ref && ref.trim().length > 0) {
    try {
      git(repoPath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      git(repoPath, ["merge-base", "--is-ancestor", ref, "HEAD"]);
      return { ref, degraded: false };
    } catch {
      // fall through to the HEAD degradation
    }
  }
  return { ref: gitHead(repoPath) ?? "HEAD", degraded: true };
}

/** Stage everything (incl. untracked, excl. gitignored .aitne-dev/) and
 *  commit; returns the new sha, or null when there was nothing to commit.
 *  THROWS on an in-progress merge — `add -A` would stage the conflict
 *  markers as resolved and silently finalize the owner's half-merge
 *  (loop-kit dies here too; callers pre-check via checkRepoGuards, this is
 *  the backstop). */
export function gitCommitAll(repoPath: string, message: string): string | null {
  if (gitMergeInProgress(repoPath)) {
    throw new DevRepoGuardError(mergeInProgressGuard(repoPath));
  }
  git(repoPath, ["add", "-A"]);
  const status = git(repoPath, ["status", "--porcelain"]);
  if (status.length === 0) return gitHead(repoPath);
  // -c flags avoid depending on the user's git identity for automated commits.
  // --no-gpg-sign: a repo with commit.gpgsign=true but no key in the daemon's
  // env would otherwise fail every automated commit (dev mode never signs).
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Aitne Dev Mode",
      "-c",
      "user.email=dev-mode@aitne.local",
      "commit",
      "--no-verify",
      "--no-gpg-sign",
      "-m",
      message,
    ],
    { cwd: repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return gitHead(repoPath);
}

/**
 * The iteration diff scope loop-kit uses: tracked changes since preRef PLUS
 * untracked files, both excluding the .aitne-dev/ working dir, sorted-unique.
 */
export function gitDiffPaths(repoPath: string, preRef: string): string[] {
  const set = new Set<string>();
  try {
    const tracked = git(repoPath, [
      "diff",
      "--name-only",
      preRef,
      "--",
      ".",
      `:(exclude)${DEV_DIR_NAME}`,
    ]);
    for (const l of tracked.split(/\r?\n/)) if (l.trim()) set.add(l.trim());
  } catch {
    // preRef may be unresolvable on a zero-commit repo — fall through to untracked.
  }
  try {
    const untracked = git(repoPath, [
      "ls-files",
      "--others",
      "--exclude-standard",
    ]);
    for (const l of untracked.split(/\r?\n/)) {
      const t = l.trim();
      if (t && !t.startsWith(`${DEV_DIR_NAME}/`)) set.add(t);
    }
  } catch {
    // ignore
  }
  return [...set].sort();
}

/** Whether the whole-run diff (baseRef..now, excl. .aitne-dev) is empty —
 *  the NO_OP discriminator at the final gate. */
export function isWholeRunDiffEmpty(repoPath: string, baseRef: string): boolean {
  return gitDiffPaths(repoPath, baseRef).length === 0;
}

/** The unified diff text since baseRef (excl. .aitne-dev), capped — injected
 *  into the review/evidence leg context. */
export function gitDiffText(
  repoPath: string,
  baseRef: string,
  capBytes = 60_000,
): string {
  let text = "";
  try {
    text = git(repoPath, ["diff", baseRef, "--", ".", `:(exclude)${DEV_DIR_NAME}`]);
  } catch {
    // Unresolvable baseRef (zero-commit repo) — fall back to the staged/working set.
    try {
      text = git(repoPath, ["diff", "--", ".", `:(exclude)${DEV_DIR_NAME}`]);
    } catch {
      text = "";
    }
  }
  return text.length > capBytes ? `${text.slice(0, capBytes)}\n… (diff truncated)` : text;
}

// ── the deterministic verify runner (a real subprocess, never a model) ──

export interface VerifyRun {
  exitCode: number;
  output: string;
}

/**
 * Run one verify command through /bin/sh -c in the repo, capturing combined
 * stdout+stderr and the exit code. This is loop-kit evaluate.sh's VERIFY step
 * — deterministic, never a model. ⚠️ Runs unsandboxed with the daemon's
 * privileges (the design's honest security gap; acceptable for local-first
 * use on the owner's own repos).
 */
export function runVerifyCommand(
  repoPath: string,
  command: string,
  timeoutMs: number,
): VerifyRun {
  const res = spawnSync("/bin/sh", ["-c", command], {
    cwd: repoPath,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  // A timeout/kill surfaces as a null status → treat as a non-zero failure.
  const exitCode = res.status === null ? 124 : res.status;
  return { exitCode, output: `${stdout}${stderr}`.trim() };
}

function formatVerifyLog(
  results: readonly { command: string; passed: boolean; exitCode: number; output: string }[],
): string {
  const body = results
    .map(
      (r) =>
        `$ ${r.command}\n${r.output}\n${r.passed ? "[PASS]" : `[FAIL] (exit ${r.exitCode})`}`,
    )
    .join("\n\n");
  return `${body}\n`;
}

/** Persist the verify results as loop-kit's last-verify.log for the evidence
 *  report + audit. */
export function writeLastVerifyLog(
  repoPath: string,
  results: readonly { command: string; passed: boolean; exitCode: number; output: string }[],
): void {
  writeDevDoc(repoPath, DEV_DOCS.lastVerify, formatVerifyLog(results));
}

/** Persist the run-start baseline verify pass (same grammar) — the red→green
 *  record consumed by the evidence report + the contract-review judgment. */
export function writeBaselineVerifyLog(
  repoPath: string,
  results: readonly { command: string; passed: boolean; exitCode: number; output: string }[],
): void {
  writeDevDoc(repoPath, DEV_DOCS.baselineVerify, formatVerifyLog(results));
}
