import type { BackendId, ProcessKey } from "@aitne/shared";

/**
 * Shape consumed by `renderCliInstructionFile` (now in
 * `skills-compiler-cli-renderer.ts`). The owning `SkillsCompiler` class
 * composes every field in `materializeCliSession` / `materializeOpencodeSession`.
 *
 * Lives in its own module so the renderer can import the type without
 * pulling the 1100-line class file. `SessionPromptBundleParams` (the
 * params shape `materializeSessionBundle` itself takes) is internal to
 * the class and stays in `skills-compiler.ts`.
 */
export interface SessionInstructionParams {
  backendId: Exclude<BackendId, "claude">;
  processKey: ProcessKey | string;
  profileName: string;
  profileContent: string;
  safetyContent: string | null;
  /**
   * Fully-rendered `## Character (user-defined)` block (from
   * `buildCharacterBlock`), or `null` when the user has no character set.
   */
  characterBlock: string | null;
  /** Slug list rendered into the `## Skills` manifest section for OpenCode
   *  (slug listing only, no path) and ignored by Codex / Gemini (which
   *  pivot to the on-demand `<skill-index>` block below). */
  skillSlugs: string[];
  /**
   * docs/design/appendices/skills-unification.md Phase 1 — preamble + index pair emitted for
   * Codex / Gemini only. The preamble is the universal "how to use skills"
   * paragraph loaded from `agent-assets/system-prompts/skill-index-instruction.md`;
   * the index block is the per-slug `name`/`description` listing rendered
   * from the materialised SKILL.md frontmatter. Both `null` for OpenCode,
   * where cwd auto-discovery removes the need for either (R3 — emitting
   * either to OpenCode could shadow its native loader).
   */
  skillPreamble: string | null;
  skillIndexBlock: string | null;
  /**
   * DELEGATED-MODE-V2-DESIGN.md §4.3.3-§4.3.4 — same-backend integration deny
   * list rendered as a top-level prose block. For Codex this is the only
   * enforcement surface (γ outcome — no MCP-tool deny mechanism); for Gemini
   * it duplicates the admin-policy hard-deny as belt-and-suspenders prose.
   * `null` when no same-backend integration has deniedTools entries.
   */
  sameBackendDenyBlock: string | null;
}
