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
 * prompt/section, or a playbook the prompt/tags point at but the `playbooks:`
 * field omits — so it never false-positives on a well-formed but unconventional
 * Agent. There is intentionally no archetype heuristic: the product has no
 * archetype field, and guessing "this looks like a research agent" from prose
 * would be exactly the kind of unreliable inference the design rejects.
 */

import { PLAYBOOK_REGISTRY, PLAYBOOK_SLUGS, type PlaybookSlug } from "./playbooks.js";

export type AgentLintCode =
  | "empty_prompt"
  | "empty_instruction"
  | "playbook_referenced_not_declared";

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
 * Lint an authored Agent definition. Pure: takes only the declared `playbooks`,
 * the `tags`, and the prompt body — no DB/fs — so it runs identically in the
 * daemon's create path and (potentially) the dashboard editor.
 */
export function lintAgentDefinition(input: {
  prompt: string;
  playbooks?: readonly string[];
  tags?: readonly string[];
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

  return issues;
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
  const label = PLAYBOOK_REGISTRY[slug].label.toLowerCase();
  return (
    normalizedPrompt.includes(`${slug} playbook`)
    || normalizedPrompt.includes(`${label} playbook`)
  );
}
