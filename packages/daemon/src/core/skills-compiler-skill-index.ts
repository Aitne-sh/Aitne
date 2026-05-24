import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { BackendId } from "@aitne/shared";

import { createLogger } from "../logging.js";
import { parseSkillFrontmatter } from "./skills-compiler-variants.js";

// Peer logger for this module. Exported so tests can spy on `logger.warn`
// (specifically the missing-reference branch of `renderReferenceIncludes`).
// Production callers do not import it.
export const logger = createLogger("skills-compiler-skill-index");

/**
 * Strip service sections from external-services/SKILL.md that correspond to
 * unconfigured integrations. Sections are delimited by HTML comments:
 *   <!-- service:calendar --> ... <!-- /service:calendar -->
 * When `configuredServices` is empty the content is returned unchanged — the
 * "no services configured yet" case keeps every section so the agent can see
 * the full menu. Only strips once the user has configured at least one
 * service (and therefore expressed an intent to narrow the surface).
 */
export function stripUnconfiguredServices(
  content: string,
  configuredServices: ReadonlySet<string>,
): string {
  if (configuredServices.size === 0) return content;
  const servicePattern = /<!-- service:(\w+) -->\n([\s\S]*?)<!-- \/service:\1 -->\n?/g;
  return content.replace(servicePattern, (match, service: string) =>
    configuredServices.has(service) ? match : "",
  );
}

/** Strip YAML frontmatter (--- ... ---) from markdown content. */
function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const endIdx = content.indexOf("\n---", 3);
  if (endIdx < 0) return content;
  return content.slice(endIdx + 4).replace(/^\n+/, "");
}

/**
 * docs/design/appendices/skills-unification.md Phase 1 §"Skill preamble" — load the static
 * preamble shipped at
 * `agent-assets/system-prompts/skill-index-instruction.md`. The preamble
 * is constant per backend (Codex / Gemini) and explains the on-demand
 * skill-load protocol. Returns a built-in minimal fallback when the asset
 * is missing so tests that don't seed the system-prompts dir still
 * produce deterministic output.
 */
export function loadSkillIndexPreamble(workspaceDir: string): string {
  const path = join(
    workspaceDir,
    "agent-assets",
    "system-prompts",
    "skill-index-instruction.md",
  );
  if (existsSync(path)) {
    return readFileSync(path, "utf-8").trim();
  }
  return [
    "## Skills",
    "",
    "Skills are materialised on disk under the per-backend dotfile",
    "directory. When your task matches an entry in `<skill-index>` below,",
    "`Read` its `SKILL.md` and follow the contents.",
  ].join("\n");
}

/**
 * docs/design/appendices/skills-unification.md Phase 1 — splice sentinels.
 *
 * The visible `<skill-index>` / `</skill-index>` XML-style tags are the
 * agent-facing contract; they MUST stay in the rendered output for the
 * preamble's protocol to make sense. But using them as the splicer's
 * region markers is fragile — any profile body, skill body, or user
 * prose that quotes the tag verbatim would be misidentified as the
 * splice region and silently corrupted on `refreshSkillIndexBlock`.
 *
 * The sentinels below are unique HTML comments emitted immediately
 * outside the visible tags. The splicer keys on them instead, so even
 * a profile that quotes `<skill-index>` cannot collide with the splice
 * region. Comments render as low-signal tokens to the model and add
 * ~50 bytes per session — negligible against the ~3 KB block.
 */
const SKILL_INDEX_START_SENTINEL = "<!-- skill-index:start -->";
const SKILL_INDEX_END_SENTINEL = "<!-- skill-index:end -->";

/**
 * docs/design/appendices/skills-unification.md Phase 1 §"`<skill-index>` block" — render
 * the per-slug index from the **materialised** SKILL.md frontmatter on
 * disk. Walking the destination dir (instead of the source manifest)
 * keeps the index in sync with what the agent will actually find when
 * it reads:
 *
 *   - Same-backend native MCP slugs whose variant resolved to `null` are
 *     correctly omitted (no SKILL.md was written).
 *   - User-authored slugs synced AFTER `writeSkillsDir` (via
 *     `syncAllUserSkills` from the workdir layer) appear automatically
 *     when this is called from the post-sync refresh helper.
 *   - Frontmatter that has gone through curation / mode filter / deny
 *     pass / read-sensitive banner reflects the post-pipeline state.
 *
 * The block is emitted with a fixed XML-style envelope so tests can pin
 * its placement and the splicer in `refreshSkillIndexBlock` can locate
 * it for in-place rewrites between turns.
 *
 * `destSkillsRootRelative` is the on-disk path the agent should Read
 * (`.codex/skills` or `.gemini/skills`); it gets embedded in the header
 * sentence verbatim. Built-ins and user-authored slugs are not
 * distinguished here — see R4.
 */
export function renderSkillIndexBlock(
  destSkillsRootAbs: string,
  destSkillsRootRelative: string,
): string {
  const lines: string[] = [
    SKILL_INDEX_START_SENTINEL,
    "<skill-index>",
    `The following skills are materialized at \`${destSkillsRootRelative}/<name>/SKILL.md\`.`,
    "When your task matches a skill's `description`, `Read` the `SKILL.md`",
    "to load its guidance and follow it. Skill bodies are NOT inlined in",
    "this prompt — read them on demand. Multiple skills may be loaded in",
    "one turn.",
    "",
  ];
  let entryCount = 0;
  if (existsSync(destSkillsRootAbs)) {
    const slugs = readdirSync(destSkillsRootAbs, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
    for (const slug of slugs) {
      const skillMdPath = join(destSkillsRootAbs, slug, "SKILL.md");
      if (!existsSync(skillMdPath)) continue;
      const fm = parseSkillFrontmatter(readFileSync(skillMdPath, "utf-8"));
      if (!fm.name || !fm.description) continue;
      lines.push(`- name: ${fm.name}`);
      lines.push(`  description: ${fm.description}`);
      entryCount++;
    }
  }
  if (entryCount === 0) {
    lines.push(
      "(No skills materialized this turn — proceed with the runtime profile only.)",
    );
  }
  lines.push("</skill-index>", SKILL_INDEX_END_SENTINEL);
  return lines.join("\n");
}

/**
 * docs/design/appendices/skills-unification.md Phase 1 — re-render the `<skill-index>` block
 * inside an existing instruction file. Called by the workdir layer AFTER
 * `syncAllUserSkills` so user-authored slugs land in the index alongside
 * the built-ins (`renderSkillIndexBlock` reads the dest dir on disk, so a
 * post-sync re-render naturally picks them up).
 *
 * No-op when:
 *  - The backend is Claude (no instruction file with `<skill-index>`).
 *  - The instruction file is missing (the session has not been
 *    materialised yet).
 *  - The instruction file carries no `<skill-index>` block (slim
 *    fetch_window sessions, or future backends that opt out).
 *
 * Idempotent — re-running with the same dest contents produces an
 * identical instruction file.
 */
export function refreshSkillIndexBlock(
  sessionDir: string,
  backendId: BackendId,
): void {
  // docs/design/appendices/skills-unification.md Phase 1 §R3 — OpenCode never gets a
  // `<skill-index>` block. The cwd auto-discovery loader is the source
  // of truth; emitting an index would inject a second listing the
  // runtime ignores. Also matters in fallback workdirs where codex and
  // opencode share AGENTS.md: a stray opencode refresh would clobber
  // the codex-rendered sentinels with opencode's skill listing.
  //
  // Backend→dotfile dir mapping is inlined here (rather than imported from
  // skills-compiler-cli-renderer) so this module sits at the same DAG
  // level as cli-renderer — both depend only on `variants`. The mapping
  // is two cases and changes once per new backend; the cost of duplication
  // is bounded.
  let cliRoot: string;
  if (backendId === "codex") cliRoot = ".codex";
  else if (backendId === "gemini") cliRoot = ".gemini";
  else return; // claude / opencode / future backends without `<skill-index>`
  const destSkillsRootRelative = join(cliRoot, "skills");
  const destSkillsRootAbs = join(sessionDir, destSkillsRootRelative);
  const fileName: "AGENTS.md" | "GEMINI.md" =
    backendId === "gemini" ? "GEMINI.md" : "AGENTS.md";
  const instructionPath = join(sessionDir, fileName);
  if (!existsSync(instructionPath)) return;
  const current = readFileSync(instructionPath, "utf-8");
  // Splice on the HTML-comment sentinels, NOT on the visible
  // `<skill-index>` tags — the sentinels are unique enough that a
  // profile body or user-authored skill that quotes the visible tag
  // cannot collide with the splice region.
  const startIdx = current.indexOf(SKILL_INDEX_START_SENTINEL);
  const endIdx = startIdx >= 0
    ? current.indexOf(
        SKILL_INDEX_END_SENTINEL,
        startIdx + SKILL_INDEX_START_SENTINEL.length,
      )
    : -1;
  if (startIdx < 0 || endIdx < 0) return; // OpenCode (no index) or slim path
  const replacement = renderSkillIndexBlock(destSkillsRootAbs, destSkillsRootRelative);
  const next =
    current.slice(0, startIdx) +
    replacement +
    current.slice(endIdx + SKILL_INDEX_END_SENTINEL.length);
  if (next !== current) {
    writeFileSync(instructionPath, next, "utf-8");
  }
}

/**
 * Resolve `{{> base }}` include directives in a skill/task-flow variant file.
 * Reads `SKILL.base.md` (or `<key>.base.md` for task flows) from `basePath`
 * and replaces every occurrence of `{{> base }}` with the base file's content
 * (frontmatter stripped). A missing or empty base file is silently ignored.
 *
 * Only `{{> base }}` is supported — this is intentionally minimal (§4.7
 * design note: "~40 lines of pure TS").
 *
 * @deprecated DELEGATED-PROXY-API-DESIGN.md §11 — after Phase D no in-tree
 * skill uses `{{> base }}`: mail / external-services unified their bodies
 * during Phase D, and the lone surviving `notion/SKILL.base.md` was
 * removed in Phase 9 (its hourly-check read-only constraint moved to
 * `routine.hourly_check.md` task-flow where the rule applies in every
 * integration mode, including same-backend delegated where the skill
 * body is dropped). The helper is retained for future composition needs;
 * remove the call sites in `materializeClaudeSession` /
 * `materializeCliSession` when no consumer reappears.
 */
export function renderPartialIncludes(content: string, basePath: string): string {
  if (!content.includes("{{> base }}")) return content;
  if (!existsSync(basePath)) return content.replace(/\{\{> base \}\}/g, "");
  const baseRaw = readFileSync(basePath, "utf-8");
  const baseContent = stripFrontmatter(baseRaw).trim();
  return content.replace(/\{\{> base \}\}/g, baseContent);
}

/**
 * Resolve `{{> ref:<name> }}` directives in a skill body by inlining
 * `references/<name>.md` (frontmatter stripped) from the skill's source dir.
 *
 * Mirrors `renderPartialIncludes` but is intra-skill, not cross-skill: each
 * skill carries its own `references/` dir. Used by progressive-disclosure
 * skills (planned for `mail`, `roadmap`, `reading`, `user-interview` after
 * Phase 2-B) so heavy reference tables can live next to the skill body
 * without bloating the navigation overview.
 *
 * Behaviour:
 *  - Missing `references/<name>.md` → directive replaced with empty string;
 *    logged at WARN. (Mirrors the deprecated helper's missing-base behaviour.)
 *  - The directive matches `{{> ref:<name> }}` with the strict-kebab name
 *    pattern `[a-z][a-z0-9-]*`. Path-traversal (`../`, leading underscore,
 *    uppercase) is rejected at the regex level — `existsSync` is never
 *    consulted for invalid names.
 *  - Multiple occurrences each inline the same file's content (re-read per
 *    occurrence — pinned by the unit tests so a later caching refactor must
 *    surface as a deliberate change).
 *  - Frontmatter on the reference file (if present) is stripped before
 *    inline, so reference files can carry `---\nkind: reference\n---`
 *    headers for tooling without leaking YAML into skill bodies.
 *  - The resolver is NOT fence-aware; a directive inside a triple-backtick
 *    fence is still expanded. This matches `renderPartialIncludes` and is
 *    deliberate for v1 — fence-aware resolution would be a separate refactor.
 *
 * Phase 2-A ships compiler-only; no in-tree skill carries a directive yet
 * (`skills-manifest.test.ts` pins `0` as the lockstep count). Phase 2-B
 * starts emitting them per the migration map in `SKILLS-PHASE-2-PLAN.md`.
 */
export function renderReferenceIncludes(
  content: string,
  skillSrcDir: string,
): string {
  return content.replace(
    /\{\{> ref:([a-z][a-z0-9-]*) \}\}/g,
    (_match, name: string) => {
      const refPath = join(skillSrcDir, "references", `${name}.md`);
      if (!existsSync(refPath)) {
        logger.warn(
          { skillSrcDir, name },
          "renderReferenceIncludes: missing reference file",
        );
        return "";
      }
      return stripFrontmatter(readFileSync(refPath, "utf-8")).trim();
    },
  );
}
