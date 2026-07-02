/**
 * Deterministic Agent-definition lint (AGENT_PROMPT_QUALITY_DESIGN.md §3.5 /
 * Phase 2 item 4 — "verify-agent-definitions").
 *
 * The design's assembler is a *deterministic* validator, not a generator LLM:
 * after schema validation it runs this lint over the authored prompt + declared
 * playbooks and returns any issues to the DM agent, which fixes them or asks the
 * user. Because there is no LLM in this path it is enforceable and testable —
 * exactly the property the design's "consistency comes from frozen assets, not a
 * creative LLM" thesis requires.
 *
 * Scope discipline: these are **non-blocking warnings** (schema validation still
 * owns hard rejection). Every check keys off a *deterministic* signal — an empty
 * prompt/section, a playbook the prompt/tags point at but the `playbooks:` field
 * omits, or an `# Output` contract with zero `success_criteria` — so it never
 * false-positives on a well-formed but unconventional Agent. There is intentionally no archetype heuristic: the product has no
 * archetype field, and guessing "this looks like a research agent" from prose
 * would be exactly the kind of unreliable inference the design rejects.
 *
 * One caller-side exception: the two prompt-stub codes (`empty_prompt` /
 * `placeholder_prompt`) are promoted to a blocking 400 by `planCreate` at the
 * `POST /api/agents` chokepoint, because such a body is *guaranteed* to be
 * dropped as ambiguous at run time. The lint itself stays warning-only so the
 * raw `agent.md` PATCH/PUT editor path never 400s on lint.
 */

import { PLAYBOOK_REGISTRY, PLAYBOOK_SLUGS, type PlaybookSlug } from "./playbooks.js";

export type AgentLintCode =
  | "empty_prompt"
  | "placeholder_prompt"
  | "empty_instruction"
  | "playbook_referenced_not_declared"
  | "no_success_criteria";

export type AgentLintSeverity = "warning" | "info";

export interface AgentLintIssue {
  readonly code: AgentLintCode;
  readonly severity: AgentLintSeverity;
  /** One-line, actionable message aimed at the DM agent authoring the prompt. */
  readonly message: string;
  /** The playbook involved, when the issue is playbook-specific. */
  readonly playbook?: PlaybookSlug;
}

/**
 * Headings that signal the author used the *core* prompt frame — the shape that
 * carries an `# Instruction` section. Only a core-framed prompt is expected to
 * have one; an unframed free-prose prompt is never flagged for its absence.
 */
const CORE_FRAME_HEADING = /^#{1,6}[ \t]+(Role|Important)\b/im;

/**
 * Headings unique to the *extended* (operational, state-mutating) frame, which
 * deliberately replaces `# Instruction` with `# Requirements` / `# Verification`
 * / `# Scope` / `# Execution Mode` (AGENT_PROMPT_QUALITY_DESIGN.md §3.1 +
 * Appendix D). When any is present we do NOT require an `# Instruction` section —
 * flagging one would be a false positive on a well-formed operational agent.
 */
const EXTENDED_FRAME_HEADING =
  /^#{1,6}[ \t]+(Requirements|Verification|Execution Mode|Scope|Constraints)\b/im;

// Accept the plural `# Instructions` too — the frame template is singular, but
// the plural is a natural authoring variation, and flagging a populated
// `# Instructions` section as "missing" would be a false positive.
const INSTRUCTION_HEADING = /^#{1,6}[ \t]+Instructions?\b/i;
const ANY_HEADING = /^#{1,6}[ \t]+/;

/**
 * The frame's `# Output` section — the prompt's checkable output contract
 * (shared by BOTH the core and the extended frame, unlike `# Instruction`).
 * Its presence is the deterministic signal that the Agent's run produces
 * something `success_criteria` could verify; the plural `# Outputs` is accepted
 * as a natural authoring variation, mirroring `INSTRUCTION_HEADING`.
 */
const OUTPUT_HEADING = /^#{1,6}[ \t]+Outputs?\b/im;

/**
 * Lint an authored Agent definition. Pure: takes only the declared `playbooks`,
 * the `tags`, the prompt body, and the declared `success_criteria` count — no
 * DB/fs — so it runs identically in the daemon's create path and (potentially)
 * the dashboard editor.
 */
export function lintAgentDefinition(input: {
  prompt: string;
  playbooks?: readonly string[];
  tags?: readonly string[];
  /**
   * Number of declared `success_criteria`. Optional so callers that do not
   * know the criteria (e.g. a prompt-only editor) never trip the
   * `no_success_criteria` check — only an explicit `0` can.
   */
  successCriteriaCount?: number;
}): AgentLintIssue[] {
  const issues: AgentLintIssue[] = [];
  const prompt = input.prompt ?? "";
  const trimmed = prompt.trim();

  // 1. Empty prompt body. The body becomes the deployed Agent's task_prompt; an
  //    empty one means the Agent has no task and the runtime drops it as
  //    ambiguous. Nothing else is worth checking on an empty body.
  if (trimmed.length === 0) {
    issues.push({
      code: "empty_prompt",
      severity: "warning",
      message:
        "The prompt body is empty. It becomes the deployed Agent's task — write a "
        + "# Role / # Important / # Instruction / # Output frame describing exactly "
        + "what it should do each run.",
    });
    return issues;
  }

  // 1b. Whole-body placeholder stub ("placeholder", "TODO", "your prompt
  //     here", …) left by an author intending to fill the task in later. Same
  //     terminal outcome as an empty body — every run is dropped as ambiguous —
  //     so nothing else is worth checking here either.
  if (isPlaceholderPrompt(trimmed)) {
    issues.push({
      code: "placeholder_prompt",
      severity: "warning",
      message:
        `The prompt body is a placeholder stub ("${truncateForMessage(trimmed)}"), not a task. `
        + "It becomes the deployed Agent's task and every run would be dropped as "
        + "ambiguous — replace it with a # Role / # Important / # Instruction / "
        + "# Output frame describing exactly what the Agent should do.",
    });
    return issues;
  }

  // 2. Core-framed prompt with no non-empty # Instruction section — the #1 cause
  //    of a drifting Agent (design §3.1). Skipped for the extended/operational
  //    frame, which intentionally has no # Instruction section.
  if (
    CORE_FRAME_HEADING.test(prompt)
    && !EXTENDED_FRAME_HEADING.test(prompt)
    && !hasNonEmptyInstruction(prompt)
  ) {
    issues.push({
      code: "empty_instruction",
      severity: "warning",
      message:
        "The prompt uses the frame but has no non-empty # Instruction section. Add "
        + "ordered, concrete steps (with worked examples) so the Agent knows exactly "
        + "what to do.",
    });
  }

  // 3. A playbook the prompt names (or a tag matches) but `playbooks:` omits.
  //    In Phase 2 the by-injection guarantee fires ONLY for declared playbooks;
  //    a bare mention in the prose no longer suffices, so the methodology would
  //    silently not be injected.
  const declared = new Set<string>(input.playbooks ?? []);
  const tags = new Set<string>(input.tags ?? []);
  const normalizedPrompt = normalizeForMatch(prompt);
  for (const slug of PLAYBOOK_SLUGS) {
    if (declared.has(slug)) continue;
    if (playbookReferenced(normalizedPrompt, tags, slug)) {
      issues.push({
        code: "playbook_referenced_not_declared",
        severity: "warning",
        playbook: slug,
        message:
          `This Agent points at the "${slug}" playbook but does not declare it in `
          + `playbooks:. Add "${slug}" to playbooks so its methodology is injected at `
          + `fire time — a mention in the prompt alone is not injected in Phase 2.`,
      });
    }
  }

  // 4. An `# Output` contract with zero declared `success_criteria`. The prompt
  //    promises a checkable output, but with no criteria the post-run evaluator
  //    never fires and the Agent's `criteriaHitRate` metric stays null — no
  //    quality signal on /agents. Undefined count = caller doesn't know the
  //    criteria (never flagged); a prompt without an output contract has
  //    nothing deterministic to check against (also never flagged).
  if (input.successCriteriaCount === 0 && OUTPUT_HEADING.test(prompt)) {
    issues.push({
      code: "no_success_criteria",
      severity: "warning",
      message:
        "The prompt declares an # Output contract but the Agent has no "
        + "success_criteria, so its criteria hit-rate metric stays empty. Derive 1-3 "
        + "criteria from the # Output section (file_exists / file_section_count / "
        + "notification_log) so every run is verified.",
    });
  }

  return issues;
}

/**
 * Whole-body stub markers an author pastes intending to "fill the prompt in
 * later" (`placeholder`, `TODO`, `your prompt here`, …). Matched against the
 * FULL normalized body only — a real prompt that merely *contains* one of
 * these words never matches, so the check cannot false-positive on a
 * legitimate (even terse) task definition.
 */
const PLACEHOLDER_TOKEN_RE = new RegExp(
  "^(?:"
    + "placeholder(?: (?:prompt|text|body|only))?"
    + "|todo|to do|tbd|tba|wip|n/a|none|pending"
    + "|fill (?:me |this )?in(?: later)?"
    + "|to be (?:filled(?: in)?|determined|added|written|done)"
    + "|coming soon"
    + "|(?:your |insert |add )?prompt(?: goes)? here"
    + "|x{3,}"
    + ")$",
);

/**
 * True when a prompt body is effectively a stub: missing, whitespace-only,
 * pure punctuation, or a whole-body placeholder token. Such a body becomes the
 * deployed Agent's `task_prompt` verbatim and the runtime's ambiguous-task
 * rule drops the run without doing any work — so the daemon gates on this at
 * its API chokepoints (`planCreate` rejects the create, `planRunNow` refuses
 * the manual run).
 */
export function isPlaceholderPrompt(prompt: string | null | undefined): boolean {
  const trimmed = (prompt ?? "").trim();
  if (trimmed.length === 0) return true;
  // Strip markdown/punctuation dressing ("# TODO", "**placeholder**",
  // "[placeholder]") and collapse whitespace before the whole-body match.
  const normalized = trimmed
    .toLowerCase()
    .replace(/[#>*_`[\](){}<>"'.…!?:;,~|=+-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length === 0 || PLACEHOLDER_TOKEN_RE.test(normalized);
}

/** Quote at most the first 40 characters of the body in a lint message. */
function truncateForMessage(text: string): string {
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

function hasNonEmptyInstruction(prompt: string): boolean {
  const lines = prompt.split(/\r?\n/);
  const start = lines.findIndex((line) => INSTRUCTION_HEADING.test(line));
  if (start < 0) return false;
  for (let i = start + 1; i < lines.length; i++) {
    if (ANY_HEADING.test(lines[i])) break; // reached the next section
    if (lines[i].trim().length > 0) return true;
  }
  return false;
}

/** Lowercase + drop markdown emphasis/backticks + collapse whitespace so
 *  "Follow the **research** playbook." matches "research playbook". */
function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ");
}

function playbookReferenced(
  normalizedPrompt: string,
  tags: ReadonlySet<string>,
  slug: PlaybookSlug,
): boolean {
  if (tags.has(slug)) return true;
  // The `<slug> playbook` phrasing is the realistic one and does the work. The
  // `<label> playbook` branch is a best-effort secondary matcher for a
  // multi-word label; it is redundant for slug-like labels (e.g. "Research")
  // and a no-op for labels that never appear verbatim in prose (e.g.
  // "Monitoring / digest") — harmless either way (audit C7).
  const label = PLAYBOOK_REGISTRY[slug].label.toLowerCase();
  return (
    normalizedPrompt.includes(`${slug} playbook`)
    || normalizedPrompt.includes(`${label} playbook`)
  );
}
