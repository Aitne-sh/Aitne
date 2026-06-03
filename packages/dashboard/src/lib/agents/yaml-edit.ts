import yaml from "js-yaml";
import { agentDefinitionSchema } from "@aitne/shared";

/**
 * Pure logic for the user-Agent YAML editor (§10.4): fence-split + js-yaml
 * parse + `agentDefinitionSchema` validation, mirroring the daemon's
 * `core/agents/agent-frontmatter.ts` so the dashboard's *live* client-side
 * validation matches exactly what the loader will accept on save. The editor
 * disables Save until `validateAgentMarkdown` returns `ok`.
 *
 * Importing the schema (a runtime value) from `@aitne/shared` is what keeps the
 * two validators from drifting — there is no second copy of the rules here.
 */

export interface YamlValidationIssue {
  /** Dotted path to the offending field, or "" for document-level errors. */
  path: string;
  message: string;
}

export type AgentMarkdownValidation =
  | { ok: true }
  | { ok: false; issues: YamlValidationIssue[] };

export interface FrontmatterSplit {
  yamlText: string;
  body: string;
}

/**
 * Split an `agent.md` document into its raw YAML frontmatter text + body.
 * Returns `null` (rather than throwing) when the fences are missing/unclosed —
 * the caller turns that into a single document-level issue. Fence logic mirrors
 * `parseAgentFrontmatter` (open on a leading `---`, close on the next `---`).
 */
export function splitFrontmatter(content: string): FrontmatterSplit | null {
  const lines = content.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== "---") return null;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) return null;
  return {
    yamlText: lines.slice(1, end).join("\n"),
    body: lines.slice(end + 1).join("\n").trim(),
  };
}

/**
 * Validate a full `agent.md` document. Checks, in order: frontmatter fences →
 * YAML parses to a mapping → `agentDefinitionSchema` accepts it. Every failure
 * mode produces inline issues for the editor.
 */
export function validateAgentMarkdown(content: string): AgentMarkdownValidation {
  const split = splitFrontmatter(content);
  if (!split) {
    return {
      ok: false,
      issues: [
        {
          path: "",
          message:
            "Document must open with a `---` frontmatter fence on the first line and close with a later `---`.",
        },
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(split.yamlText);
  } catch (err) {
    return { ok: false, issues: [{ path: "", message: `Frontmatter is not valid YAML: ${err}` }] };
  }

  if (parsed === null || parsed === undefined) {
    return { ok: false, issues: [{ path: "", message: "Frontmatter block is empty." }] };
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      issues: [{ path: "", message: "Frontmatter must be a YAML mapping, not a scalar or sequence." }],
    };
  }

  const result = agentDefinitionSchema.safeParse(parsed);
  if (result.success) return { ok: true };

  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  };
}

/**
 * Validate an edit to an EXISTING user Agent. Runs the full schema validation,
 * then enforces slug immutability (§3.3: "Slug fixed after creation"): the
 * dashboard writes the file to the existing `<canonicalSlug>/agent.md`
 * directory, so changing the frontmatter `slug:` would land a file whose slug
 * ≠ its directory — which the loader rejects on reload (`def.slug !==
 * expectedSlug`), silently dropping the Agent into "Needs attention". Surfacing
 * it as an inline `slug` issue blocks Save with a clear edit-time message
 * instead. Pass no `canonicalSlug` for the "+ New Agent" scaffold (create
 * legitimately derives the directory from the edited slug).
 */
export function validateUserAgentEdit(
  content: string,
  canonicalSlug?: string,
): AgentMarkdownValidation {
  const base = validateAgentMarkdown(content);
  if (!base.ok || canonicalSlug === undefined) return base;
  const edited = slugFromMarkdown(content);
  if (edited !== null && edited !== canonicalSlug) {
    return {
      ok: false,
      issues: [
        {
          path: "slug",
          message: `slug must stay "${canonicalSlug}" — renaming an existing Agent is not supported in v1 (create a new Agent instead).`,
        },
      ],
    };
  }
  return base;
}

/** Pull the `slug:` value from a document, if the frontmatter parses to it. */
export function slugFromMarkdown(content: string): string | null {
  const split = splitFrontmatter(content);
  if (!split) return null;
  try {
    const parsed = yaml.load(split.yamlText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const slug = (parsed as Record<string, unknown>).slug;
      return typeof slug === "string" ? slug : null;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Scaffold a minimal valid user-Agent `agent.md` for the "+ New Agent" flow
 * (§10.1). Defaults: kind=user, a daily cron, the `agent.task` process key
 * (the user-Agent default, confirmed in `process-key.ts`), and a blank prompt
 * body for the operator to fill in. The result passes `validateAgentMarkdown`.
 */
export function scaffoldUserAgentMarkdown(slug: string): string {
  const safeSlug = slug.trim() || "my-agent";
  return `---
slug: ${safeSlug}
name: ${safeSlug}
description: Describe what this agent does.
kind: user
enabled: true
schedule:
  kind: cron
  expression: "0 9 * * *"
backend:
  process_key: agent.task
limits:
  max_turns: 20
  max_budget_usd: 0.25
  timeout_minutes: 10
---

Write the agent's task prompt here.
`;
}
