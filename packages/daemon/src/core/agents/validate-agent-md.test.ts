import { describe, expect, it } from "vitest";
import {
  isAgentDefinitionPath,
  validateAgentDefinitionMarkdown,
} from "./validate-agent-md.js";

/** Minimal valid user agent.md frontmatter + body for slug `say-hi`. */
function validAgentMarkdown(overrides: { slug?: string } = {}): string {
  const slug = overrides.slug ?? "say-hi";
  return [
    "---",
    `slug: ${slug}`,
    "name: Say Hi",
    "description: A friendly greeting agent.",
    "kind: user",
    "schedule:",
    "  kind: cron",
    '  expression: "0 9 * * *"',
    "backend:",
    "  process_key: agent.task",
    "limits:",
    "  max_turns: 5",
    "  max_budget_usd: 0.1",
    "  timeout_minutes: 5",
    "---",
    "",
    "# Say Hi",
    "",
    "Send a friendly greeting.",
    "",
  ].join("\n");
}

describe("isAgentDefinitionPath", () => {
  it("matches the canonical policies/agents/<slug>/agent.md path", () => {
    expect(isAgentDefinitionPath("policies/agents/say-hi/agent.md")).toBe(true);
  });

  it("rejects non-agent and malformed paths", () => {
    expect(isAgentDefinitionPath("policies/agents/say-hi/proposals/2026-06-02.md")).toBe(false);
    expect(isAgentDefinitionPath("policies/agents/agent.md")).toBe(false);
    expect(isAgentDefinitionPath("policies/routines/morning.md")).toBe(false);
    expect(isAgentDefinitionPath("identity/profile.md")).toBe(false);
  });
});

describe("validateAgentDefinitionMarkdown", () => {
  const PATH = "policies/agents/say-hi/agent.md";

  it("accepts a well-formed user agent.md (regression: no `type` required)", () => {
    expect(validateAgentDefinitionMarkdown(PATH, validAgentMarkdown())).toBeNull();
  });

  it("reports a frontmatter-fence error verbatim", () => {
    const message = validateAgentDefinitionMarkdown(PATH, "no frontmatter here\n# Say Hi\n");
    expect(message).toContain("must open with a `---` frontmatter fence");
  });

  it("reports invalid YAML in the frontmatter block", () => {
    // Unterminated flow sequence — js-yaml throws, surfaced as AgentFrontmatterError.
    const content = ["---", "slug: [unclosed", "---", "# x"].join("\n");
    const message = validateAgentDefinitionMarkdown(PATH, content);
    expect(message).toContain("agent.md frontmatter is not valid YAML");
  });

  it("reports schema-validation failures with field paths", () => {
    // Drop `name` (required, min length 1) → agentDefinitionSchema rejects it.
    const content = validAgentMarkdown().replace("name: Say Hi\n", "");
    const message = validateAgentDefinitionMarkdown(PATH, content);
    expect(message).toMatch(/^agent definition invalid: /);
    expect(message).toContain("name");
  });

  it("rejects a user agent with a null process_key (superRefine path)", () => {
    const content = validAgentMarkdown().replace("  process_key: agent.task", "  process_key: null");
    const message = validateAgentDefinitionMarkdown(PATH, content);
    expect(message).toContain("backend.process_key");
  });

  it("rejects a frontmatter slug that disagrees with the path slug", () => {
    const content = validAgentMarkdown({ slug: "different" });
    const message = validateAgentDefinitionMarkdown(PATH, content);
    expect(message).toBe(
      'agent definition slug "different" must match the directory name "say-hi".',
    );
  });
});
