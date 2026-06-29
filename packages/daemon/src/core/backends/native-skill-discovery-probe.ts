/**
 * docs/design/appendices/skills-unification.md Phase 1 item 13 — forward-compat probe.
 *
 * Codex and Gemini did not ship native skill auto-discovery when Phase 1
 * landed (which is why the instruction file carries a `<skill-index>`
 * block + on-demand `Read` protocol). When their CLIs grow a built-in
 * `skill` / `Skill` surface — analogous to the Claude Agent SDK's
 * loader — we want a loud one-line signal so a follow-up PR can drop
 * the `<skill-index>` block for that backend.
 *
 * Two detection strategies are wired here. They are complementary
 * because the surface a future CLI exposes is not knowable in advance.
 *
 *  1. {@link noteNativeSkillToolIfPresent} — pure name-pattern scan
 *     against a tool-name list. Cheap defense-in-depth. The caller
 *     supplies whatever inventory it already has. Today's wiring (Codex
 *     `mcp__`-filtered probe, Gemini synthetic capability list) means
 *     this path will not actually fire on a future native surface
 *     because that surface won't be MCP-namespaced — but the function
 *     stays in case a richer inventory source lands later.
 *
 *  2. {@link probeCliNativeSkillSubcommand} — runs `<cli> --help` once
 *     and scans the output for a top-level `skill` / `skills`
 *     subcommand. This is the ground-truth signal. Verified:
 *       - `gemini --help` already lists `gemini skills <command>`
 *         (aliased `skill`). When this probe is wired, Gemini will be
 *         the first backend to trip the alarm.
 *       - `codex --help` does NOT yet ship a skill subcommand. Its
 *         `codex features list` carries `skill_mcp_dependency_install`
 *         (stable, true) and `skill_env_var_dependency_prompt` (under
 *         development) — both gate MCP dependency wiring, not skill
 *         discovery, so they are NOT load-bearing signals.
 *
 * Both probes are idempotent per process (`reportedKeys` /
 * `subcommandReportedKeys`). Re-fires across daemon restarts, which is
 * fine — the signal is meant to be noticed in logs during the rollout
 * window, not deduplicated across boots.
 *
 * No-op for Claude (`materializeClaudeSession` already trusts the SDK
 * loader) and for OpenCode (cwd auto-discovery is the source of truth;
 * Phase 1 §R3 pins zero `<skill-index>` for that backend).
 */

import { tmpdir } from "node:os";
import type { BackendId } from "@aitne/shared";
import { createLogger } from "../../logging.js";
import { runLineCommand } from "./cli-utils.js";

const logger = createLogger("native-skill-discovery-probe");

/**
 * Heuristic tool-name patterns that would suggest the CLI gained a skill
 * loader. Matched case-insensitively against the FULL tool name (including
 * any `mcp__<server>__` prefix). Conservative — false positives only
 * trigger one extra log line, false negatives delay detection until a
 * future PR tightens the heuristic.
 */
const SKILL_LIKE_TOOL_PATTERNS: ReadonlyArray<RegExp> = [
  /^skill$/i,
  /(^|_)skills?(_|$)/i, // matches `skill`, `Skill`, `skills`, `skill_load`, etc.
  /skill_discover/i,
  /load_skill/i,
];

const reportedKeys = new Set<string>();

export function noteNativeSkillToolIfPresent(
  backendId: Exclude<BackendId, "claude">,
  toolNames: readonly string[],
): void {
  if (backendId === "opencode") return; // R3 — auto-discovery is the source of truth
  const matches = toolNames.filter((name) =>
    SKILL_LIKE_TOOL_PATTERNS.some((re) => re.test(name)),
  );
  if (matches.length === 0) return;
  const key = `${backendId}:${matches.sort().join(",")}`;
  if (reportedKeys.has(key)) return;
  reportedKeys.add(key);
  logger.warn(
    {
      backendId,
      matches,
      hint:
        "Native skill-discovery surface detected. Consider dropping the "
        + "<skill-index> block from the instruction file for this backend "
        + "in a follow-up PR (docs/design/appendices/skills-unification.md §Risks).",
    },
    "native_skill_discovery.candidate_tool_detected",
  );
}

/**
 * Per-backend dedupe set for the `<cli> --help` subcommand probe. Held
 * separately from {@link reportedKeys} so the two probes don't suppress
 * each other.
 */
const subcommandReportedKeys = new Set<string>();

/** Hard upper bound for the `--help` invocation; we only need its
 *  top-level command listing, which every CLI prints synchronously
 *  on stdout in well under 1 s. 5 s leaves room for cold-start. */
const HELP_PROBE_TIMEOUT_MS = 5_000;

/**
 * Top-level command-line detector. Two anchors:
 *   - `<cli> skill[s]` literal — every CLI we care about renders its
 *     usage lines that way (e.g. `gemini skills <command>`; codex's
 *     hypothetical future form would be `codex skill <command>`).
 *   - Indented command-list entry `<indent>skill[s]<space>` — the
 *     "Commands:" block shape both yargs (Gemini) and clap (Codex)
 *     render.
 *
 * Case-insensitive so a `Skill` or `Skills` heading is not missed.
 * Word-boundary terminator `\b` prevents false hits on `skill_search`
 * or `skill_install`-style sub-tokens that are not load-bearing
 * subcommand names.
 */
function helpTextLooksLikeSkillSubcommand(
  helpText: string,
  backendId: string,
): boolean {
  const usageLine = new RegExp(
    `(^|\\n)\\s*${backendId}\\s+skills?\\b`,
    "i",
  );
  const commandsListEntry = /(^|\n)\s+skills?\b/i;
  return usageLine.test(helpText) || commandsListEntry.test(helpText);
}

/**
 * Probe the backend CLI's `--help` output for a top-level skill
 * subcommand. Idempotent per process — once a backend has been
 * reported, subsequent calls short-circuit.
 *
 * Designed to be called from `probeTools()` (which runs at integration
 * mode-flip probe time). Failure modes are silent (missing CLI,
 * non-zero exit, parse-fail, timeout) so the daemon's main flow is not
 * blocked on a forward-compat heuristic.
 */
export async function probeCliNativeSkillSubcommand(
  cliPath: string | null,
  backendId: Exclude<BackendId, "claude" | "opencode">,
): Promise<void> {
  if (subcommandReportedKeys.has(backendId)) return;
  if (!cliPath) return;
  let stdoutLines: string[];
  let stderrLines: string[];
  let exitCode: number | null;
  let timedOut: boolean;
  try {
    const result = await runLineCommand({
      command: cliPath,
      args: ["--help"],
      cwd: tmpdir(),
      timeoutMs: HELP_PROBE_TIMEOUT_MS,
    });
    stdoutLines = result.stdoutLines;
    stderrLines = result.stderrLines;
    exitCode = result.exitCode;
    timedOut = result.timedOut;
  } catch (err) {
    logger.debug(
      { backendId, err: err instanceof Error ? err.message : String(err) },
      "native_skill_discovery.help_probe.spawn_failed",
    );
    return;
  }
  if (timedOut) {
    logger.debug({ backendId }, "native_skill_discovery.help_probe.timed_out");
    return;
  }
  // Some CLIs (gemini) print `--help` to stdout with exit 0; some flavours
  // emit to stderr with exit 1. Accept either as long as we got output.
  if (exitCode !== 0 && exitCode !== null && stdoutLines.length === 0) {
    return;
  }
  const helpText = [...stdoutLines, ...stderrLines].join("\n");
  if (!helpTextLooksLikeSkillSubcommand(helpText, backendId)) return;
  subcommandReportedKeys.add(backendId);
  logger.warn(
    {
      backendId,
      hint:
        `${backendId} CLI ships a top-level \`skill\`/\`skills\` subcommand `
        + "(native skill loader). Evaluate dropping the `<skill-index>` block "
        + "+ on-demand `Read` protocol from this backend's instruction file "
        + "(docs/design/appendices/skills-unification.md §Risks).",
    },
    "native_skill_discovery.subcommand_detected",
  );
}
