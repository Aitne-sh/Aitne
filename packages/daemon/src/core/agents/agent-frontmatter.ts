import yaml from "js-yaml";

/**
 * Agent definition frontmatter parser (AGENT_DEFINITIONS_DESIGN.md §4.3 / §6.1).
 *
 * `agent.md` files — both built-in (`agent-assets/agents/<slug>/agent.md`) and
 * user (`<contextDir>/policies/agents/<slug>/agent.md`) — carry a YAML
 * frontmatter block fenced by `---` lines, followed by a Markdown body.
 *
 * The frontmatter is **deeply nested** (`schedule` / `backend` / `limits` /
 * `tools` / `success_criteria` / `stop_warning`), so the repo's flat
 * line-scalar `extractContextFrontmatter` parser cannot read it — it would
 * silently drop every nested block. This module uses `js-yaml` instead (the
 * dependency Phase 4 added for exactly this surface; see the Phase 4
 * design-drift correction in AGENT_DEFINITIONS_IMPLEMENTATION_PLAN.md).
 *
 * The fence-splitting logic mirrors `core/context-frontmatter-extract.ts`
 * (open on a leading `---`, close on the next `---`); only the block parser
 * changes. This is the same shape Phase 4's `builtin-yaml.test.ts` proved
 * against the shipped built-ins, lifted into the loader module so production
 * and the test share one parser.
 */

/** Outcome of splitting + parsing an `agent.md` file. */
export interface AgentFrontmatterParse {
  /** Parsed frontmatter as a plain object (validate with `agentDefinitionSchema`). */
  frontmatter: unknown;
  /** Markdown body after the closing fence, trimmed. */
  body: string;
}

/**
 * Thrown when the file is not a well-formed frontmatter document: it must open
 * with a `---` fence on the first line and close with a later `---`, and the
 * captured block must parse as a YAML mapping. The loader catches this and
 * records the file as an invalid definition (§6.6) rather than crashing boot.
 */
export class AgentFrontmatterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentFrontmatterError";
  }
}

/**
 * Split a Markdown file into its YAML frontmatter object + body.
 *
 * Throws {@link AgentFrontmatterError} when the document does not open/close a
 * frontmatter fence, or when the captured block does not parse to a plain
 * object (a bare scalar / sequence frontmatter is not a valid agent
 * definition). `js-yaml` v4 `load` is the safe loader — the code-executing
 * loader and the `!!js/function` type were removed in v4, so `DEFAULT_SCHEMA`
 * constructs no arbitrary types.
 */
export function parseAgentFrontmatter(content: string): AgentFrontmatterParse {
  // `split` always yields at least one element, so `lines[0]` is defined.
  const lines = content.split(/\r?\n/);
  if (lines[0].trim() !== "---") {
    throw new AgentFrontmatterError(
      "agent.md must open with a `---` frontmatter fence on the first line",
    );
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) {
    throw new AgentFrontmatterError(
      "agent.md frontmatter block is never closed with `---`",
    );
  }

  let frontmatter: unknown;
  try {
    frontmatter = yaml.load(lines.slice(1, end).join("\n"));
  } catch (err) {
    // `${err}` renders js-yaml's YAMLException ("…: bad indentation …") via its
    // own toString — no `instanceof Error` branch (js-yaml always throws here).
    throw new AgentFrontmatterError(`agent.md frontmatter is not valid YAML: ${err}`);
  }

  if (frontmatter === null || frontmatter === undefined) {
    throw new AgentFrontmatterError("agent.md frontmatter block is empty");
  }
  if (typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    throw new AgentFrontmatterError(
      "agent.md frontmatter must be a YAML mapping, not a scalar or sequence",
    );
  }

  return {
    frontmatter,
    body: lines.slice(end + 1).join("\n").trim(),
  };
}

/**
 * Render an Agent definition object back into an `agent.md` document: a YAML
 * frontmatter block + a Markdown body. Used by the auto-import path (§6.5) to
 * materialise a user Agent file from a legacy `recurring_schedules` row.
 *
 * The frontmatter is emitted with `js-yaml` `dump` (stable key order, no
 * line-wrapping so cron strings / paths stay intact). The result round-trips
 * cleanly through {@link parseAgentFrontmatter}.
 */
export function renderAgentMarkdown(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const yamlBlock = yaml.dump(frontmatter, {
    lineWidth: -1,
    noRefs: true,
    sortKeys: false,
  });
  const trimmedBody = body.trim();
  // yaml.dump already ends with a trailing newline; bracket it with fences and
  // append the body so the file opens/closes a frontmatter block exactly like
  // the shipped built-ins.
  return `---\n${yamlBlock}---\n\n${trimmedBody}\n`;
}
