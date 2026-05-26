import { resolve } from "node:path";
import { getContextDir, type AgentConfig } from "../config.js";

/**
 * Absolute path of the user-skills root.
 *
 * CONTEXT_VAULT_REDESIGN_PLAN.md v4 V11 — every runtime consumer of the
 * user-skills location (skills API, session workdir materialization,
 * dispatcher fallback materializer, backend cores, release-assets shadow
 * alerts, tests) MUST route through this single helper so the location
 * cannot drift between modules.
 *
 * Skill curation overlay JSON is NOT inside the vault — it lives at
 * `<dataDir>/skill-curation-overlays/` (see `resolveSkillCurationOverlaysRoot`).
 */
export function resolveUserSkillsRoot(config: AgentConfig): string {
  return resolve(getContextDir(config), "policies", "skills");
}

/**
 * Absolute path of the skill-curation overlay JSON root.
 *
 * CONTEXT_VAULT_REDESIGN_PLAN.md v4 V11 — overlays are operational, not
 * content. They stay outside the vault even though the user `SKILL.md`
 * files moved into `policies/skills/`. The vault-restructure migration
 * moves any pre-existing overlays from `<dataDir>/skills/overlays/` to
 * this new root on first boot post-upgrade.
 */
export function resolveSkillCurationOverlaysRoot(dataDir: string): string {
  return resolve(dataDir, "skill-curation-overlays");
}
