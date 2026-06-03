import { readFileSync } from "node:fs";

import { agentDefinitionSchema, type SuccessCriterion } from "@aitne/shared";

import { parseAgentFrontmatter } from "./agent-frontmatter.js";

/**
 * Best-effort load of an Agent's `success_criteria` from its definition file
 * (AGENT_DEFINITIONS_DESIGN.md §8.3). Read at execution time from the on-disk
 * `agent.md` so the criteria always reflect the live definition without the
 * loader having to denormalise them into a column.
 *
 * Totally non-throwing: a missing / unreadable / malformed file yields `[]`
 * (no criteria → a no-op evaluation), so a definition that became unreadable
 * after the Agent's row was written never breaks completion recording. The
 * `success_criteria` schema default is also `[]`, so a definition that simply
 * declares none returns the same empty array.
 */
export function loadAgentSuccessCriteria(
  definitionPath: string,
): SuccessCriterion[] {
  try {
    const raw = readFileSync(definitionPath, "utf-8");
    const { frontmatter } = parseAgentFrontmatter(raw);
    return agentDefinitionSchema.parse(frontmatter).success_criteria;
  } catch {
    return [];
  }
}
