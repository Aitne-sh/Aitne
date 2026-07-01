import { agentDefinitionSchema, lintAgentDefinition } from "@aitne/shared";
import type { AgentLintIssue } from "@aitne/shared";
import { AgentFrontmatterError, parseAgentFrontmatter } from "./agent-frontmatter.js";

/**
 * User Agent definitions written through the context-vault chokepoint live at
 * `policies/agents/<slug>/agent.md` (AGENT_DEFINITIONS_DESIGN.md §3.3 / §9.5).
 *
 * They carry the deeply-nested `agentDefinitionSchema` frontmatter
 * (`slug`/`name`/`kind`/`schedule`/`backend`/…) — NOT the flat
 * `type`/`owner`/`updated` context-vault rule frontmatter — so the generic
 * `validateContextFileFrontmatter` validator must skip them (see
 * `shouldValidateContextFileFrontmatter`), and this module owns their
 * write-boundary shape check instead.
 */
const AGENT_DEFINITION_PATH_RE = /^policies\/agents\/([^/]+)\/agent\.md$/;

/** True for the canonical user agent-definition path this module validates. */
export function isAgentDefinitionPath(relativePath: string): boolean {
  return AGENT_DEFINITION_PATH_RE.test(relativePath);
}

/**
 * Validate an `agent.md` payload at the context-vault write boundary, mirroring
 * the `POST /api/agents` (`planCreate`) shape check: parse the YAML frontmatter
 * with `parseAgentFrontmatter`, then `agentDefinitionSchema.safeParse`. Returns
 * a single human-readable message on failure (the route maps it to HTTP 400) or
 * `null` when the payload is well-formed.
 *
 * Deeper semantic cross-checks (`process_key` ∈ live `PROCESS_KEYS`, skill /
 * tool-pattern / absolute-block checks, slug-vs-builtin collision) stay the
 * loader's job — they need `db` + the live skill list and run on the watcher
 * reload, exactly as they do for the `POST /api/agents` path. The `slug`-vs-path
 * cross-check IS done here because it is cheap, path-local, and a common
 * copy-paste mistake the loader would otherwise only surface asynchronously.
 */
export function validateAgentDefinitionMarkdown(
  relativePath: string,
  content: string,
): string | null {
  const match = AGENT_DEFINITION_PATH_RE.exec(relativePath);
  /* c8 ignore next — callers gate on isAgentDefinitionPath; defensive guard. */
  if (!match) return null;
  const pathSlug = match[1];

  let frontmatter: unknown;
  try {
    ({ frontmatter } = parseAgentFrontmatter(content));
  } catch (err) {
    // parseAgentFrontmatter only ever throws AgentFrontmatterError.
    /* c8 ignore next */
    if (!(err instanceof AgentFrontmatterError)) throw err;
    return err.message;
  }

  const parsed = agentDefinitionSchema.safeParse(frontmatter);
  if (!parsed.success) {
    // Mirror `planCreate`'s issue rendering: every agentDefinitionSchema issue
    // carries a non-empty path (field name or superRefine path), which the
    // caller surfaces verbatim.
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return `agent definition invalid: ${issues}`;
  }

  if (parsed.data.slug !== pathSlug) {
    return `agent definition slug "${parsed.data.slug}" must match the directory name "${pathSlug}".`;
  }

  return null;
}

/**
 * Non-blocking prompt-quality lint for an `agent.md` payload at the context-vault
 * write boundary (AGENT_PROMPT_QUALITY_DESIGN.md §3.5 / audit B5). Mirrors the
 * `POST /api/agents` create-path lint (`planCreate`, views.ts) so that editing an
 * agent's prompt/`playbooks:` via the raw-`agent.md` PATCH/PUT path — the
 * recommended way to change them — gets the same authoring feedback the create
 * path does, instead of silently drifting.
 *
 * Returns `[]` for a non-agent path, unparseable frontmatter, or schema-invalid
 * frontmatter — those cases are already hard-rejected (400) upstream by
 * `validateAgentDefinitionMarkdown`, so this runs strictly on the SUCCESS side of
 * a write and NEVER turns a PATCH/PUT into a 400. The `agent.md` body is the
 * deployed Agent's prompt (see `renderAgentMarkdown`), so it is passed verbatim
 * as the lint's `prompt`.
 */
export function lintAgentDefinitionMarkdown(
  relativePath: string,
  content: string,
): AgentLintIssue[] {
  if (!AGENT_DEFINITION_PATH_RE.test(relativePath)) return [];
  let frontmatter: unknown;
  let body: string;
  try {
    ({ frontmatter, body } = parseAgentFrontmatter(content));
  } catch {
    return [];
  }
  const parsed = agentDefinitionSchema.safeParse(frontmatter);
  if (!parsed.success) return [];
  return lintAgentDefinition({
    prompt: body,
    playbooks: parsed.data.playbooks,
    tags: parsed.data.tags,
  });
}
