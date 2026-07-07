/**
 * Development-mode deterministic evaluator — a native port of loop-kit's
 * evaluate.sh. This is the TRUST CORE: it NEVER trusts a model's self-report.
 * Pure control-flow over injected shims (git-diff + a verify-command runner),
 * so it stays IN the coverage gate at 100%.
 *
 * loop-kit's highest-trust-first decision order (evaluate.sh §7), adapted:
 *   1. Contract immutability — the engine's in-memory approved-hash vs the
 *      hash recomputed from the on-disk contract+config. Mismatch ⇒
 *      NEEDS_SPEC_DECISION. (This subsumes loop-kit's separate "harness
 *      paths" guard: there are no engine files inside the repo, and the
 *      contract lives under .aitne-dev/ which is excluded from the diff, so
 *      contract tampering is caught here, not by a path rule.)
 *   2. deniedPaths touched  ⇒ RISK_REQUIRES_APPROVAL
 *   3. escalatePaths touched ⇒ NEEDS_ARCHITECTURE_DECISION
 *   4. VERIFY — re-run every verifyCommand as a subprocess (via the shim);
 *      empty list ⇒ NEEDS_SPEC_DECISION (fail-closed, never a vacuous pass)
 *   5. Agent-declared state (NEEDS_SPEC_DECISION / NEEDS_ARCHITECTURE_DECISION
 *      / BLOCKED) is honored.
 *   6.5 Ledger self-consistency (candidate promotion only): verify-green +
 *      READY_FOR_REVIEW but a REQ still unmet ⇒ CONTINUE (refuse the gate).
 *   6/7. Success gate: verify-green AND (READY_FOR_REVIEW or assumeReady) ⇒
 *      SUCCESS (final; NO_OP when the whole-run diff is empty) or
 *      SUCCESS_CANDIDATE. Under --final a failed gate ⇒ BLOCKED.
 *   8. Bookkeeping (non-final): stagnation (no project diff N times ⇒
 *      STALLED) + repeat-fail (identical verify-failure fingerprint N times ⇒
 *      BLOCKED); otherwise CONTINUE.
 *
 * The diff the caller feeds MUST already exclude the .aitne-dev/ working dir
 * (loop-kit excludes .loop/), so working-memory writes never count as project
 * change for the path policy or stagnation.
 */

import type {
  DevEvaluateResult,
  DevEvaluateState,
  DevLoopConfig,
  DevVerifyResult,
} from "./types.js";

/** Persistent counters carried between iterations (loop-kit .loop/* files). */
export interface DevEvaluateBookkeeping {
  /** Consecutive no-project-diff iterations. */
  stagnationCount: number;
  /** Recent verify-failure fingerprints (most-recent-last, capped). */
  failFingerprints: readonly string[];
}

export const EMPTY_BOOKKEEPING: DevEvaluateBookkeeping = {
  stagnationCount: 0,
  failFingerprints: [],
};

export interface DevEvaluateInput {
  config: DevLoopConfig;
  /** The iteration's pre-ref (HEAD before this iteration's implement leg). */
  preRef: string;
  /** The immutability anchor stamped at !approve (dev_sessions.approved_hash). */
  approvedHash: string;
  /** Hash recomputed by the engine from the current on-disk contract+config. */
  currentApprovedHash: string;
  /** First-token of .aitne-dev/agent-state (uppercased), or null. */
  agentStateToken: string | null;
  /** Whether every REQ-ledger row is 'met' (the 6.5 consistency gate). */
  allRequirementsMet: boolean;
  /** The FINAL re-check maps the gate straight to SUCCESS/NO_OP and skips
   *  bookkeeping. */
  final: boolean;
  /** Forced gate — any non-escalation state counts as ready (MET_FORCE_N). */
  assumeReady: boolean;
  /** For NO_OP under --final: is the whole-run non-.aitne-dev diff empty? */
  wholeRunDiffEmpty: boolean;
  bookkeeping: DevEvaluateBookkeeping;
}

export interface DevEvaluateDeps {
  /** Changed project paths since preRef (tracked + untracked), ALREADY
   *  excluding .aitne-dev/. */
  diffPaths: (preRef: string) => readonly string[];
  /** Run one verify command; return its exit code + combined output. */
  runVerify: (command: string) => { exitCode: number; output: string };
}

export interface DevEvaluateOutput {
  result: DevEvaluateResult;
  bookkeeping: DevEvaluateBookkeeping;
}

const AGENT_READY_TOKEN = "READY_FOR_REVIEW";
const AGENT_ESCALATION_TOKENS = new Set([
  "NEEDS_SPEC_DECISION",
  "NEEDS_ARCHITECTURE_DECISION",
  "BLOCKED",
]);
/** Keep the last N fingerprints (>= any sane repeatFailN). */
const FINGERPRINT_WINDOW = 8;
const VERIFY_OUTPUT_CAP = 4000;

/** loop-kit glob semantics: `**` collapses to `*`, and `*` crosses `/`. */
export function globToRegExp(glob: string): RegExp {
  const collapsed = glob.replace(/\*\*/g, "*");
  const escaped = collapsed.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export function matchesAnyGlob(
  path: string,
  globs: readonly string[],
): string | null {
  for (const glob of globs) {
    if (globToRegExp(glob).test(path)) return glob;
  }
  return null;
}

/** Normalize volatile tokens (numbers, hex) out of the failure output so an
 *  identical failure fingerprints the same across runs (loop-kit fail-
 *  fingerprint). */
export function fingerprintFailure(verify: readonly DevVerifyResult[]): string {
  const failed = verify.filter((v) => !v.passed);
  const body = failed
    .map((v) => `${v.command}\n${v.output}`)
    .join("\n---\n")
    .replace(/0x[0-9a-fA-F]+/g, "#")
    .replace(/[0-9]+/g, "#")
    .replace(/[ \t]+/g, " ")
    .trim();
  return body;
}

function result(state: DevEvaluateState, reason: string, verify?: DevVerifyResult[]): DevEvaluateResult {
  return verify ? { state, reason, verify } : { state, reason };
}

/**
 * Run the deterministic evaluation for one iteration. Pure: all side effects
 * (git, subprocess) come through `deps`; all persistent state comes in via
 * `input.bookkeeping` and goes out via `output.bookkeeping`.
 */
export function evaluateIteration(
  input: DevEvaluateInput,
  deps: DevEvaluateDeps,
): DevEvaluateOutput {
  const { config, bookkeeping } = input;
  const keepBookkeeping = (): DevEvaluateBookkeeping => bookkeeping;

  // 1. Contract immutability (subsumes the harness-paths guard).
  if (input.currentApprovedHash !== input.approvedHash) {
    return {
      result: result(
        "NEEDS_SPEC_DECISION",
        "The product contract or stop conditions changed since approval "
          + "(hash mismatch). Re-approve to continue.",
      ),
      bookkeeping: keepBookkeeping(),
    };
  }

  const changed = deps.diffPaths(input.preRef);

  // 2. Denied paths.
  const deniedHit = matchesAnyGlob0(changed, config.deniedPaths);
  if (deniedHit) {
    return {
      result: result(
        "RISK_REQUIRES_APPROVAL",
        `A denied path was modified (${deniedHit.path} matches ${deniedHit.glob}).`,
      ),
      bookkeeping: keepBookkeeping(),
    };
  }

  // 3. Escalate paths.
  const escalateHit = matchesAnyGlob0(changed, config.escalatePaths);
  if (escalateHit) {
    return {
      result: result(
        "NEEDS_ARCHITECTURE_DECISION",
        `An escalate path was modified (${escalateHit.path} matches ${escalateHit.glob}).`,
      ),
      bookkeeping: keepBookkeeping(),
    };
  }

  // 4. VERIFY — fail-closed on an empty command set.
  if (config.verifyCommands.length === 0) {
    return {
      result: result(
        "NEEDS_SPEC_DECISION",
        "No verify commands are configured — refusing a vacuous success.",
      ),
      bookkeeping: keepBookkeeping(),
    };
  }
  const verify = runAllVerify(config.verifyCommands, deps);
  const verifyGreen = verify.every((v) => v.passed);

  // 5. Agent-declared escalation/block.
  if (input.agentStateToken && AGENT_ESCALATION_TOKENS.has(input.agentStateToken)) {
    return {
      result: result(
        input.agentStateToken as DevEvaluateState,
        `The implementer declared ${input.agentStateToken}.`,
        verify,
      ),
      bookkeeping: keepBookkeeping(),
    };
  }

  const agentReady = input.agentStateToken === AGENT_READY_TOKEN;

  // 6.5 Ledger self-consistency (candidate promotion only).
  if (!input.final && verifyGreen && agentReady && !input.allRequirementsMet) {
    return {
      result: result(
        "CONTINUE",
        "Verify is green and the implementer claims ready, but the "
          + "requirements ledger still has unmet items — refusing the gate.",
        verify,
      ),
      bookkeeping: keepBookkeeping(),
    };
  }

  // 6/7. Success gate.
  const ready = agentReady || input.assumeReady;
  if (verifyGreen && ready) {
    if (input.final) {
      return {
        result: result(
          input.wholeRunDiffEmpty ? "NO_OP" : "SUCCESS",
          input.wholeRunDiffEmpty
            ? "Final re-check passed with no code change needed."
            : "Final re-check passed — all verify commands green.",
          verify,
        ),
        bookkeeping: keepBookkeeping(),
      };
    }
    return {
      result: result("SUCCESS_CANDIDATE", "Verify green and ready for review.", verify),
      bookkeeping: keepBookkeeping(),
    };
  }

  // Under --final, a non-passing gate is a hard failure.
  if (input.final) {
    return {
      result: result(
        "BLOCKED",
        verifyGreen
          ? "Final re-check: not ready for success."
          : "Final re-check: verify commands are failing.",
        verify,
      ),
      bookkeeping: keepBookkeeping(),
    };
  }

  // 8. Bookkeeping — stagnation + repeat-fail.
  if (changed.length === 0) {
    const stagnationCount = bookkeeping.stagnationCount + 1;
    if (config.stagnationN > 0 && stagnationCount >= config.stagnationN) {
      return {
        result: result(
          "STALLED",
          `No project changes for ${stagnationCount} consecutive iterations.`,
          verify,
        ),
        bookkeeping: { stagnationCount, failFingerprints: bookkeeping.failFingerprints },
      };
    }
    // Continue but carry the incremented stagnation counter.
    return {
      result: result("CONTINUE", "No project changes this iteration.", verify),
      bookkeeping: { stagnationCount, failFingerprints: bookkeeping.failFingerprints },
    };
  }

  // Forward progress resets stagnation.
  let failFingerprints = bookkeeping.failFingerprints;
  if (!verifyGreen) {
    const fp = fingerprintFailure(verify);
    const next = [...failFingerprints, fp].slice(-FINGERPRINT_WINDOW);
    failFingerprints = next;
    if (config.repeatFailN > 0 && countTrailingIdentical(next) >= config.repeatFailN) {
      return {
        result: result(
          "BLOCKED",
          `The same verify failure recurred ${config.repeatFailN} times — no progress.`,
          verify,
        ),
        bookkeeping: { stagnationCount: 0, failFingerprints },
      };
    }
  } else {
    // A green verify clears the failure streak.
    failFingerprints = [];
  }

  return {
    result: result("CONTINUE", "Iteration made progress; continuing.", verify),
    bookkeeping: { stagnationCount: 0, failFingerprints },
  };
}

// ── helpers ─────────────────────────────────────────────────────────────

function matchesAnyGlob0(
  paths: readonly string[],
  globs: readonly string[],
): { path: string; glob: string } | null {
  if (globs.length === 0) return null;
  for (const path of paths) {
    const glob = matchesAnyGlob(path, globs);
    if (glob) return { path, glob };
  }
  return null;
}

function runAllVerify(
  commands: readonly string[],
  deps: DevEvaluateDeps,
): DevVerifyResult[] {
  return commands.map((command) => {
    const { exitCode, output } = deps.runVerify(command);
    return {
      command,
      exitCode,
      passed: exitCode === 0,
      output: output.length > VERIFY_OUTPUT_CAP ? output.slice(0, VERIFY_OUTPUT_CAP) : output,
    };
  });
}

/** How many trailing entries are identical to the last one. Only ever called
 *  with a non-empty list (the caller just pushed a fingerprint). */
function countTrailingIdentical(fingerprints: readonly string[]): number {
  const last = fingerprints[fingerprints.length - 1];
  let n = 0;
  for (let i = fingerprints.length - 1; i >= 0; i--) {
    if (fingerprints[i] === last) n++;
    else break;
  }
  return n;
}
