import {
  INTEGRATION_DESCRIPTORS,
  INTEGRATION_KEYS,
  collectSessionDeniedTools,
  filterDeniedToolsForBackend,
  type BackendId,
  type IntegrationKey,
  type IntegrationState,
} from "@aitne/shared";

/**
 * §7.7 — apply the per-integration tool-deny policy to a delegated skill
 * body. Two enforcement modes:
 *
 *  - **Claude (hard enforcement):** parse the YAML frontmatter and remove
 *    every `allowed-tools` entry whose unsuffixed name (after the
 *    descriptor's `toolNamespace`) is in `deniedTools`. The Claude Agent
 *    SDK refuses to invoke any tool not present in `allowed-tools`, so
 *    this is hard enforcement at the SDK boundary.
 *
 *  - **Codex / Gemini (soft enforcement):** append a "Denied tools (do
 *    not invoke)" prose block at the end of the skill body listing the
 *    full namespaced tool names. The CLI surfaces have no per-tool deny
 *    mechanism comparable to Claude's `allowed-tools`; the prose is the
 *    only guard. Documented soft-enforcement gap.
 *
 * Stale entries (a deniedTools name that doesn't match any tool in the
 * active backend's `capabilityTools`) are silently ignored — the API
 * already rejects them at PATCH time, but a delegatedBackend swap can
 * leave Claude-namespaced names in a list now active for Codex.
 *
 * Run AFTER `renderPartialIncludes` and `stripUnconfiguredServices` so
 * partial includes and service-section gating land first.
 */
export function applyDeniedTools(
  content: string,
  integrationKey: IntegrationKey,
  backendId: BackendId,
  deniedTools: readonly string[],
): string {
  if (deniedTools.length === 0) return content;
  const descriptor = INTEGRATION_DESCRIPTORS[integrationKey];
  const connector = descriptor.backendConnectors[backendId];
  if (!connector) return content;

  const { active } = filterDeniedToolsForBackend(
    integrationKey,
    backendId,
    deniedTools,
  );
  if (active.length === 0) return content;

  const namespacedDenied = active.map((t) => `${connector.toolNamespace}${t}`);

  if (backendId === "claude") {
    return filterClaudeAllowedTools(content, new Set(namespacedDenied));
  }
  return appendCliDenyBlock(content, namespacedDenied);
}

/**
 * Strip every `allowed-tools` frontmatter entry whose name appears in
 * `deniedSet`. Preserves frontmatter ordering, line breaks, and any other
 * fields. Tolerates two YAML shapes:
 *
 *   allowed-tools:
 *     - name1
 *     - name2
 *
 *   allowed-tools: [name1, name2]
 *
 * The first form is what every skill in `agent-assets/skills/` uses today;
 * the inline form is supported because it's valid YAML and the API + UI
 * have no way to prevent a hand-edited skill from using it.
 */
function filterClaudeAllowedTools(
  content: string,
  deniedSet: ReadonlySet<string>,
): string {
  if (!content.startsWith("---")) return content;
  const endIdx = content.indexOf("\n---", 3);
  if (endIdx < 0) return content;
  const frontmatter = content.slice(4, endIdx);
  const body = content.slice(endIdx + 4);

  const lines = frontmatter.split("\n");
  const out: string[] = [];
  let inAllowedTools = false;
  for (const line of lines) {
    if (/^allowed-tools:\s*\[/.test(line)) {
      // Inline-array form: parse, filter, re-emit on one line.
      const m = /^(allowed-tools:\s*)\[([^\]]*)\]/.exec(line);
      if (m) {
        const items = m[2]
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""))
          .filter((s) => s.length > 0 && !deniedSet.has(s));
        out.push(`${m[1]}[${items.join(", ")}]`);
        continue;
      }
    }
    if (/^allowed-tools:\s*$/.test(line)) {
      inAllowedTools = true;
      out.push(line);
      continue;
    }
    if (inAllowedTools) {
      // Block-list form continuation. A block-list item is `  - <name>`;
      // anything else (next top-level key, blank, or end of frontmatter)
      // ends the section.
      const itemMatch = /^\s*-\s*(.+?)\s*$/.exec(line);
      if (itemMatch) {
        const name = itemMatch[1].replace(/^["']|["']$/g, "");
        if (!deniedSet.has(name)) out.push(line);
        continue;
      }
      // Anything else closes the block.
      inAllowedTools = false;
    }
    out.push(line);
  }

  return `---\n${out.join("\n")}\n---${body}`;
}

/**
 * DELEGATED-MODE-V2-DESIGN.md §4.3.3-§4.3.4 — render a top-level prose
 * deny block listing every same-backend integration tool the user has
 * denied. Returns `null` when no integration is in same-backend mode for
 * this backend or the deny lists are empty.
 *
 * Codex (γ outcome): this prose is the ONLY enforcement surface — the
 * Codex CLI's connector apps have no admin-policy or per-tool deny config.
 * The agent profile (`AGENTS.md`) inlines this block above the behavioral
 * rules so it is impossible to miss.
 *
 * Gemini: duplicate intent — admin-policy already hard-denies these tools
 * (§4.3.3 hard enforcement), but echoing the deny in prose saves tokens
 * the model would otherwise spend drafting a doomed call.
 */
export function buildSameBackendDenyBlock(
  integrations: Partial<Record<IntegrationKey, IntegrationState>>,
  sessionBackend: BackendId,
): string | null {
  const map = collectSessionDeniedTools(integrations, sessionBackend);
  if (map.size === 0) return null;
  const lines: string[] = [
    "## Denied tools (per-integration)",
    "",
    "The user has restricted the following connector tools for this session.",
    "Do NOT invoke them in any flow — including activity scan, morning routine,",
    "or DM responses. If a workflow appears to require one, stop and tell the",
    "user the tool is denied.",
  ];
  for (const [key, names] of map.entries()) {
    lines.push("", `### ${key}`, "");
    for (const n of names) lines.push(`- \`${n}\``);
  }
  return lines.join("\n");
}

/**
 * Append a soft-enforcement deny block to a CLI skill body. The block is
 * idempotent — re-running with the same denied set produces identical
 * output.
 */
function appendCliDenyBlock(
  content: string,
  namespacedDenied: readonly string[],
): string {
  // Strip any prior deny block we wrote, so re-materialization with a
  // changed list doesn't accumulate stale ones. The block starts with
  // `\n## Denied tools (do not invoke)` (one preceding newline, the join
  // contributes the second) and runs until either the next `## ` heading
  // or end of file.
  const stripped = content.replace(
    /\n+## Denied tools \(do not invoke\)[\s\S]*?(?=\n## (?!Denied tools)|$)/,
    "",
  );
  const items = namespacedDenied.map((n) => `- \`${n}\``).join("\n");
  // Two leading empty strings → block begins with "\n\n## " so the heading
  // sits on its own paragraph (markdown convention) regardless of what
  // trailing whitespace the body carried.
  const block = [
    "",
    "",
    "## Denied tools (do not invoke)",
    "",
    "The user has restricted these connector tools for this integration. Do",
    "NOT invoke them in any flow — including activity scan, morning routine,",
    "or DM responses. If a workflow appears to require one, stop and tell",
    "the user the tool is denied.",
    "",
    items,
    "",
  ].join("\n");
  return stripped.replace(/\s*$/, "") + block;
}

/**
 * Apply the deny pass for every integration whose `skillsTouched` OR
 * `deniedToolsAppliesToSkills` includes the given skill slug. A skill that
 * touches no integration leaves content unchanged. Touching multiple
 * integrations runs the pass once per integration so each contributes its
 * own deny list.
 *
 * Hard enforcement of the same deny list for cross-backend delegated
 * calls lives at the `POST /api/integrations/:key/exec` task-mode
 * chokepoint (DELEGATED-MODE-V2-DESIGN.md §4.3.2). For same-backend
 * native MCP it is
 * enforced via SDK `disallowedTools` (Claude) / admin policy (Gemini);
 * see `collectSessionDeniedTools` (§4.3.3).
 */
export function applyAllDeniedToolsForSkill(
  content: string,
  skillSlug: string,
  backendId: BackendId,
  integrations: Partial<Record<IntegrationKey, IntegrationState>>,
): string {
  let result = content;
  for (const key of INTEGRATION_KEYS) {
    const descriptor = INTEGRATION_DESCRIPTORS[key];
    const touched =
      descriptor.skillsTouched.includes(skillSlug)
      || (descriptor.deniedToolsAppliesToSkills?.includes(skillSlug) ?? false);
    if (!touched) continue;
    const state = integrations[key];
    if (!state) continue;
    if (state.mode !== "delegated") continue;
    if (!state.delegatedBackend || state.delegatedBackend !== backendId) continue;
    const denied = state.deniedTools ?? [];
    if (denied.length === 0) continue;
    result = applyDeniedTools(result, key, backendId, denied);
  }
  return result;
}
