import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type DatabaseNs from "better-sqlite3";
import {
  APP_NAME,
  INTEGRATION_KEYS,
  applyIntegrationModeFilter,
  selectSkillVariantFile,
  substituteBrandTokens,
  type BackendId,
  type IntegrationKey,
  type IntegrationState,
  type ProcessKey,
} from "@aitne/shared";

import {
  getProfileForEvent,
  getProfileForProcess,
  resolveSkillManifest,
  resolveSkillManifestForProcess,
} from "./skills-manifest.js";
import { applyCharacterBlockRewrite, buildCharacterBlock } from "./character-block.js";
import { applyOutputLanguagePointerRewrite } from "./output-language-policy.js";
import { createLogger } from "../logging.js";
import { loadFetchWindowSystemPrompt } from "./fetch-window-prompt-loader.js";
import { substituteIntegrationRoutingTables } from "./management-md.js";
import type { MailAccount } from "../services/mail/provider.js";
import {
  loadCurationDeclaration,
  type LoadedCurationDeclaration,
} from "./skill-curation/declarations.js";
import { resolveBuiltinSkillDir } from "./skill-source-paths.js";
import { OverlayStore } from "./skill-curation/overlay-store.js";
import {
  hasCurationAnchors,
  spliceCurationAnchors,
} from "./skill-curation/splicer.js";

import {
  isValidSkillSlug,
  missingDelegatedVariants,
} from "./skills-compiler-variants.js";
import {
  EMPTY_MAIL_ACCOUNTS_MD,
  pruneStaleBuiltinSkillDirs,
  readTreeFiles,
  renderMailAccountsMd,
  substituteBrandTokensInDir,
  substituteWikiWorkspaceTokens,
  substituteWikiWorkspaceTokensInDir,
  type SkillCompilerFile,
} from "./skills-compiler-tree.js";
import {
  loadSkillIndexPreamble,
  renderPartialIncludes,
  renderReferenceIncludes,
  renderSkillIndexBlock,
  stripUnconfiguredServices,
} from "./skills-compiler-skill-index.js";
import { applyAllDeniedToolsForSkill, buildSameBackendDenyBlock } from "./skills-compiler-denied-tools.js";
import {
  cliInstructionFileName,
  cliSkillsDirName,
  prependCodexReadSensitiveBanner,
  renderCliInstructionFile,
  renderDaemonApiUsageSection,
} from "./skills-compiler-cli-renderer.js";

// Module logger for the class's own warn callsites (invalid-slug warning
// in writeSkillsDir, skill-curation declaration / anchor warnings in
// spliceCurationAnchorsInSkill). Not exported — sibling modules carry
// their own peer loggers; the test suite spies on those.
const logger = createLogger("skills-compiler");

// docs/design/appendices/fetch-window-cost-reduction.md Phase 1.5 — single shared constant
// for the pre-pass process key. Typed as `ProcessKey` (not the inferred
// string literal) so a rename in `@aitne/shared/process-key.ts` lights up
// here rather than silently dead-branching the slim materializer.
const FETCH_WINDOW_PROCESS_KEY: ProcessKey = "routine.fetch_window";

// Single skill kept in the slim fetch_window CLI session: the
// `observations` SKILL.md is the POST contract for
// `/api/observations/batch` and the fetcher's only structural assertion.
// The other skills the wide path inlines (`mail`, `notion`,
// `external-services`, `attach`) are already restated by the integration
// partial the runner inlines into the user prompt.
const FETCH_WINDOW_SLIM_SKILL = "observations";

interface SessionPromptBundleParams {
  backendId: BackendId;
  sessionDir: string;
  eventType: string;
  processKey?: ProcessKey;
  /**
   * WIKI_BUILDER_DESIGN.md §P5.C — per-event wiki workspace name. Forwarded
   * to the `wikiWorkspaceTokenResolver` so `{{vault_path}}`, `{{language}}`,
   * `{{workspace_name}}`, and `{{schema_version}}` tokens in the wiki-agent
   * profile and `wiki-*` skill bodies render the *target* workspace's
   * values. Undefined falls back to the default workspace, matching the
   * `<wiki_workspace>` XML resolution in `context-builder.ts`.
   *
   * No-op for non-wiki process keys (the resolver early-returns).
   */
  wikiWorkspaceName?: string;
  /**
   * Per-turn overrides used by custom messaging bang commands
   * (`!commandname`). When provided, both fields apply atomically:
   *  - `skillSlugs` replaces the manifest-resolved skill set. An empty
   *    array means "no skills"; the materializer still emits the safety
   *    preamble + character block + an empty Skills section.
   *  - `profileBody` replaces the rendered `agent-profiles/<profile>.md`
   *    body. Safety + character + behavioral rules + daemon-API + skills
   *    sections still render around it.
   *
   * `null` skills or `null` body each fall back to the manifest defaults
   * for that field independently.
   */
  override?: {
    skillSlugs: readonly string[] | null;
    profileBody: string | null;
  };
  /**
   * `evening-review-slimdown.md` §2.1 — runtime context root used by
   * `resolveSkillManifest` to apply per-event predicates (today: the
   * evening rulebook gate that decides whether `notify` is loaded for
   * `routine.evening_review`).
   *
   * Optional and default-`undefined` — events without a predicate ignore
   * this field entirely, so non-evening call sites do not need to plumb
   * it through. When omitted on an evening session, the gate evaluates to
   * "rulebook inactive" and the conservative `notify`-dropped manifest
   * wins. Production call sites always pass `getContextDir(config)`.
   */
  contextDir?: string;
  /**
   * docs/design/appendices/skills-improvement.md §9-§11 + §14 — DB handle threaded into
   * `gmailLifestyleActive` / `managedTasksActive`. Undefined →
   * predicates return the conservative include branch.
   */
  db?: DatabaseNs.Database | null;
  /**
   * docs/design/appendices/skills-improvement.md §9-§11 + §14 — inbound DM message text
   * for the `*ForDm` trigger-phrase fallback. Undefined / null for
   * routine and scheduled events that have no user-typed text.
   */
  messageText?: string | null;
}

/**
 * Materializes backend-specific instruction files for session workdirs
 * by reading directly from the source tree (agent-assets/agent-profiles/ and
 * agent-assets/skills/). User-authored skills are managed separately via workdir.ts.
 *
 * Previous versions maintained a "deploy" layer at {dataDir}/prompts/{backendId}/
 * that was an exact copy of source. That layer was removed in favour of reading
 * source directly — every session now always gets the latest files.
 */
export class SkillsCompiler {
  constructor(
    private readonly workspaceDir: string,
    /** Set of configured service names (e.g. 'calendar', 'obsidian', 'notion', 'github'). */
    private readonly configuredServices: ReadonlySet<string> = new Set(),
    /**
     * Snapshot of active mail accounts (§Phase 5). When non-empty and the
     * `mail` skill is part of the session, an `accounts.md` file is written
     * into the session's mail skill dir so the agent can resolve labels →
     * accountId without a round-trip to the daemon.
     *
     * Intentionally generated at session-materialization time (not into the
     * checked-in `agent-assets/skills/mail/` source tree) so the repo stays
     * git-clean. Deviation from the design-doc phrasing — see
     * `docs/design/appendices/multi-mail-provider.md` §7.
     */
    private readonly mailAccounts: readonly MailAccount[] = [],
    /**
     * Current integration states (Phase 3). Used by `selectSkillVariantFile`
     * to choose the right SKILL.*.md variant at session-materialization time.
     * Defaults to empty (all integrations treated as non-delegated → SKILL.md).
     */
    private readonly integrations: Partial<Record<IntegrationKey, IntegrationState>> = {},
    /**
     * User-defined communication style / persona (design §15.4). When
     * non-empty, a `## Character (user-defined)` block is rendered into
     * every backend's instruction file (CLAUDE.md / AGENTS.md / GEMINI.md)
     * between the safety preamble and the profile body. Defaults to the
     * empty string, which omits the block.
     */
    private readonly character: string = "",
  ) {}

  /**
   * P22 — skill-curation overlay context. When set, the materializer runs an
   * extra pass that resolves `<!-- CURATION:<kind> id="<id>" -->` anchors in
   * each skill's SKILL.md against `<dataDir>/skills/overlays/<slug>/<id>.json`
   * (overlay) or `agent-assets/skills/<slug>/seeds/<id>.seed.json` (seed).
   *
   * Optional and default-OFF — daemon code is expected to call
   * `setSkillCurationContext({ dataDir })` at startup. Test workspaces and
   * lint passes that don't need overlays leave it unset, which short-circuits
   * the pass and is safe (anchors already render to nothing if there's no
   * overlay AND no seed; a missing context_dir simply skips the pass).
   */
  private skillCurationDataDir: string | null = null;
  private skillCurationCacheInvalidated = new Set<string>();

  setSkillCurationContext(opts: { dataDir: string }): void {
    this.skillCurationDataDir = opts.dataDir;
  }

  /** Called by the apply / revert flow so future session materializations
   *  re-render the affected skill's anchors. The cache itself is per-session
   *  (we always read overlays from disk fresh inside the materializer) — this
   *  flag exists so an in-process consumer can react to writes. */
  invalidateSkillCurationCache(skillSlug: string): void {
    this.skillCurationCacheInvalidated.add(skillSlug);
  }

  /**
   * Validate that all skill AND task-flow variants required by
   * currently-delegated integrations exist on disk. Called at daemon
   * startup after integration state is loaded; returns missing variant
   * paths grouped by kind (empty arrays = everything present).
   *
   * §4.7 "Missing-variant policy": if any paths come back, the caller
   * should refuse to enter delegated mode or at least log a loud warning.
   * The per-integration variant for the hypothetical PATCH path lives in
   * `missingDelegatedVariants` in `./skills-compiler-variants.js`; this
   * method aggregates across every currently-delegated integration using
   * its declared `delegatedBackend` (not the session backend — see the
   * helper docstring for the rationale).
   */
  validateDelegatedVariants(): { skills: string[]; taskFlows: string[] } {
    const skills: string[] = [];
    const taskFlows: string[] = [];
    for (const key of INTEGRATION_KEYS) {
      const state = this.integrations[key];
      if (state?.mode !== "delegated" || !state.delegatedBackend) continue;
      const result = missingDelegatedVariants(
        this.workspaceDir,
        key,
        state.delegatedBackend,
      );
      skills.push(...result.skills);
      taskFlows.push(...result.taskFlows);
    }
    return { skills, taskFlows };
  }

  /**
   * Resolve the effective SKILL.md filename for a skill + session backend pair.
   *
   *   - `"SKILL.md"`                     — direct/default body
   *   - `"SKILL.delegated.<backend>.md"` — cross-backend variant (only if it
   *                                         exists on disk; falls back to
   *                                         `"SKILL.md"` when missing)
   *   - `null`                           — same-backend native MCP; do NOT
   *                                         materialize the skill at all
   *                                         (DELEGATED-MODE-V2-DESIGN.md §4.1.2).
   */
  private resolveSkillVariantFile(skillSlug: string, backendId: BackendId): string | null {
    const candidate = selectSkillVariantFile(skillSlug, backendId, this.integrations);
    if (candidate === null) return null;
    if (candidate === "SKILL.md") return "SKILL.md";
    const candidatePath = join(
      resolveBuiltinSkillDir(this.getSourceSkillsRoot(), skillSlug),
      candidate,
    );
    return existsSync(candidatePath) ? candidate : "SKILL.md";
  }

  getSourceSkillsRoot(): string {
    return join(this.workspaceDir, "agent-assets", "skills");
  }

  getSourceProfilesRoot(): string {
    return join(this.workspaceDir, "agent-assets", "agent-profiles");
  }

  getSourceTaskFlowsRoot(): string {
    return join(this.workspaceDir, "agent-assets", "task-flows");
  }

  /** Read all source skill and profile files (for dashboard inspection). */
  readSourceFiles(): SkillCompilerFile[] {
    const files: SkillCompilerFile[] = [];
    const profilesRoot = this.getSourceProfilesRoot();
    const skillsRoot = this.getSourceSkillsRoot();
    if (existsSync(profilesRoot)) {
      for (const file of readTreeFiles(profilesRoot)) {
        files.push({ ...file, path: join("agent-profiles", file.path) });
      }
    }
    if (existsSync(skillsRoot)) {
      for (const file of readTreeFiles(skillsRoot)) {
        files.push({ ...file, path: join("skills", file.path) });
      }
    }
    return files;
  }

  materializeSessionBundle(params: SessionPromptBundleParams): {
    profile: string;
    skills: string[];
  } {
    const profileName = params.processKey
      ? getProfileForProcess(params.processKey)
      : getProfileForEvent(params.eventType);
    // `evening-review-slimdown.md` §2.1 — route through the predicate-aware
    // wrapper so the evening rulebook gate (and any future per-event
    // predicate) is consulted exactly once per session, at materialization
    // time. The wrapper passes non-conditional events through verbatim, so
    // every other process key keeps its old behaviour.
    const manifestOpts = {
      ...(params.contextDir ? { contextDir: params.contextDir } : {}),
      ...(params.db !== undefined ? { db: params.db } : {}),
      ...(params.messageText !== undefined ? { messageText: params.messageText } : {}),
    };
    const hasManifestOpts = Object.keys(manifestOpts).length > 0;
    const manifestSkills = params.processKey
      ? resolveSkillManifestForProcess(
          params.processKey,
          hasManifestOpts ? manifestOpts : undefined,
        )
      : resolveSkillManifest(
          params.eventType,
          hasManifestOpts ? manifestOpts : undefined,
        );
    // Custom bang command override: when the dispatcher passes a slug array
    // we use it verbatim, ignoring the manifest. Empty array is allowed and
    // means "no skills." `null` keeps manifest behavior — the override is a
    // partial replacement so a future caller can pass just `profileBody`
    // without affecting skill selection.
    const skills =
      params.override?.skillSlugs !== null
      && params.override?.skillSlugs !== undefined
        ? [...params.override.skillSlugs]
        : manifestSkills;
    const profileBodyOverride = params.override?.profileBody ?? null;
    // Always materialize the `mail` skill when the manifest asks for it —
    // even if the current account list is empty. The skill is inert when
    // `accounts.md` is empty (it carries an explicit "no accounts
    // configured" marker), and materializing unconditionally gives
    // `refreshSessionMailAccountsMd` a skill dir to target when the user
    // adds their first account mid-session (0→N transition). Filtering
    // here would leave the skill dir absent forever since refresh only
    // writes into existing dirs.

    // docs/design/appendices/opencode-backend.md §6.5 / Phase 4 — opencode discovers
    // skills via cwd auto-discovery from `.claude/skills/` (V2) AND uses
    // a per-process agent file at `.opencode/agent/<slug>.md` (V5,
    // singular `agent/`). Routing through `materializeCliSession` would
    // inline skill bodies into AGENTS.md, which we explicitly do NOT
    // want for opencode (skills are auto-discovered by the `skill` tool).
    if (params.backendId === "claude") {
      this.materializeClaudeSession(
        params.sessionDir,
        profileName,
        skills,
        profileBodyOverride,
        params.processKey ?? params.eventType,
        params.wikiWorkspaceName,
      );
    } else if (params.backendId === "opencode") {
      this.materializeOpencodeSession(
        params.sessionDir,
        profileName,
        skills,
        profileBodyOverride,
        params.processKey ?? params.eventType,
        params.wikiWorkspaceName,
      );
    } else {
      this.materializeCliSession(
        params.sessionDir,
        profileName,
        skills,
        params.backendId,
        params.processKey ?? params.eventType,
        profileBodyOverride,
        params.wikiWorkspaceName,
      );
    }

    // docs/design/appendices/fetch-window-cost-reduction.md Phase 1.5 — the slim
    // CLI materializer drops every manifest skill except `observations`.
    // The Claude path is wide for fetch_window today (Phase 1 swaps only
    // the system prompt, not the workdir layout). Report what was
    // actually written so log lines / callers see truth, not the
    // manifest's pre-narrow list.
    const effectiveSkills =
      params.backendId !== "claude"
      && (params.processKey ?? params.eventType) === FETCH_WINDOW_PROCESS_KEY
        ? [FETCH_WINDOW_SLIM_SKILL]
        : skills;
    return { profile: profileName, skills: effectiveSkills };
  }

  /** Read raw profile .md without safety injection. */
  private readProfile(profileName: string): string | null {
    const profilePath = join(this.getSourceProfilesRoot(), `${profileName}.md`);
    if (!existsSync(profilePath)) return null;
    return substituteBrandTokens(readFileSync(profilePath, "utf-8"));
  }

  /**
   * Read the shared safety preamble (_safety.md) and append the
   * `<!-- safety:end -->` sentinel so downstream helpers (notably
   * `insertCharacterBlock` in `character-block.ts`) can place the
   * Character block directly below safety rather than above whichever
   * `## ` heading the preamble opens with. See design §15.4.2 / §15.5.
   */
  private readSafetyPreamble(): string | null {
    const safetyPath = join(this.getSourceProfilesRoot(), "_safety.md");
    if (!existsSync(safetyPath)) return null;
    const content = substituteBrandTokens(readFileSync(safetyPath, "utf-8")).trim();
    if (!content) return null;
    return `${content}\n\n<!-- safety:end -->`;
  }

  /**
   * Read a profile .md and prepend the shared safety preamble (_safety.md).
   * Used for Claude SDK sessions where skills are separate files.
   * Returns null if the profile file doesn't exist.
   *
   * The safety preamble is emitted with a trailing `<!-- safety:end -->`
   * sentinel so the Character-block rewriter can insert below safety even
   * when the preamble itself starts with `## Safety Invariants` (design
   * §15.4.2 / §15.5).
   */
  private readProfileWithSafety(profileName: string): string | null {
    const profilePath = join(this.getSourceProfilesRoot(), `${profileName}.md`);
    if (!existsSync(profilePath)) return null;
    const profile = substituteBrandTokens(readFileSync(profilePath, "utf-8"));
    const safety = this.readSafetyPreamble();
    if (!safety) return profile;
    // Inject safety preamble after the first heading line
    const lines = profile.split("\n");
    const headingIdx = lines.findIndex((l) => l.startsWith("# "));
    if (headingIdx >= 0) {
      // Insert after heading + its following blank line (if any)
      let insertIdx = headingIdx + 1;
      while (insertIdx < lines.length && lines[insertIdx].trim() === "") insertIdx++;
      // Insert before the first non-blank content after heading
      const descriptionEnd = lines.findIndex(
        (l, i) => i > headingIdx && l.startsWith("## "),
      );
      const insertAt = descriptionEnd >= 0 ? descriptionEnd : insertIdx;
      lines.splice(insertAt, 0, safety, "");
      return lines.join("\n");
    }
    // No heading found — prepend
    return `${safety}\n\n${profile}`;
  }

  /**
   * Compose a synthesized profile document from a user-supplied body — used
   * by custom bang commands whose `instruction_md` replaces the
   * conversational profile. Wraps the body in a top-level heading so the
   * downstream `applyCharacterBlockRewrite` insertion logic finds the
   * `# ` anchor it expects, then prepends the safety preamble using the
   * same shape as `readProfileWithSafety` so safety always lands above
   * Character + body. Empty body inputs are caller-responsibility — the
   * storage layer normalises whitespace-only strings to null.
   */
  private composeClaudeProfileFromBody(body: string): string {
    const safety = this.readSafetyPreamble();
    const heading = "# Custom command instructions";
    const trimmedBody = body.trim();
    if (!safety) {
      return `${heading}\n\n${trimmedBody}\n`;
    }
    return `${heading}\n\n${safety}\n\n${trimmedBody}\n`;
  }

  private materializeClaudeSession(
    sessionDir: string,
    profileName: string,
    skillSlugs: string[],
    profileBodyOverride: string | null,
    processKey: ProcessKey | string,
    wikiWorkspaceName: string | undefined,
  ): void {
    let profileContent = profileBodyOverride !== null
      ? this.composeClaudeProfileFromBody(profileBodyOverride)
      : this.readProfileWithSafety(profileName);
    if (profileContent) {
      // Insert the user-defined character block between the safety
      // preamble and the first profile `## ` section (design §15.4.2).
      // `applyCharacterBlockRewrite` is idempotent — the input here is
      // a fresh render with no existing block, so this is always the
      // "insert" branch.
      profileContent = applyCharacterBlockRewrite(profileContent, this.character);
      // Output-language pointer paragraph (design `output-language-policy.md`
      // §13.3) — sits as a peer of the Character block, after safety/character
      // and before the runtime profile body. Mirrors the CLI render path so
      // the rendered file is byte-identical across backends modulo file-name
      // and CLI-only sections.
      profileContent = applyOutputLanguagePointerRewrite(profileContent);
      profileContent += "\n\n" + renderDaemonApiUsageSection(true);
      // INTEGRATION_NATIVE_MODE_DESIGN.md §7.3 — substitute the
      // `<integration-routing-table>` placeholder (and its
      // `actionable` sibling, defensively in case a profile carries
      // it) so the rendered CLAUDE.md tells the agent the per-session
      // routing for every integration. No-op when the profile body
      // contains no placeholder.
      profileContent = substituteIntegrationRoutingTables(
        profileContent,
        this.integrations,
      );
      profileContent = substituteWikiWorkspaceTokens(profileContent, processKey, wikiWorkspaceName);
      mkdirSync(dirname(join(sessionDir, "CLAUDE.md")), { recursive: true });
      writeFileSync(join(sessionDir, "CLAUDE.md"), profileContent, "utf-8");
    }

    this.writeSkillsDir(
      sessionDir,
      join(".claude", "skills"),
      skillSlugs,
      "claude",
      processKey,
      wikiWorkspaceName,
    );
  }

  /**
   * docs/design/appendices/skills-unification.md Phase 1 — per-backend skill-dir writer.
   *
   * Writes `<sessionDir>/<destSkillsRootRelative>/<slug>/SKILL.md` for each
   * slug, applying the full per-skill transformation pipeline:
   * variant resolution → brand tokens → partial / reference inlining →
   * service strip → mode filter → deny filter → curation splice → mail
   * `accounts.md`. The destination directory is the only thing that varies
   * across backends:
   *
   *   - Claude  → `.claude/skills`
   *   - OpenCode → `.opencode/skills`
   *   - Codex   → `.codex/skills`
   *   - Gemini  → `.gemini/skills`
   *
   * For Codex sessions, this method ALSO prepends a one-line read-sensitive
   * banner to each materialised SKILL.md whose body references a read-
   * sensitive `/api/*` endpoint (those endpoints 401 on Codex because the
   * Codex backend does not hold the read-sensitive token). The banner
   * points the agent at the `## Read-sensitive endpoints are UNAVAILABLE`
   * section already rendered into `AGENTS.md`.
   *
   * Returns the list of slugs that ended up on disk (slugs whose variant
   * resolved to `null` for same-backend native MCP and slugs whose source
   * SKILL.md was missing are excluded). Callers use this list to render
   * the `<skill-index>` block from a stable, post-materialisation source.
   */
  private writeSkillsDir(
    sessionDir: string,
    destSkillsRootRelative: string,
    skillSlugs: string[],
    sessionBackend: BackendId,
    processKey: ProcessKey | string,
    wikiWorkspaceName: string | undefined,
  ): string[] {
    const materialised: string[] = [];
    const skillsRoot = this.getSourceSkillsRoot();
    const destSkillsRoot = join(sessionDir, destSkillsRootRelative);
    mkdirSync(destSkillsRoot, { recursive: true });
    // Re-materialize cleanup: a previous turn (especially one with a wider
    // skill set or a different custom-command override) may have left
    // built-in skill dirs that aren't in the current `skillSlugs`. Remove
    // them so the next turn's tool inventory matches expectations.
    // User-authored skills live alongside built-ins in the same dir but
    // are recognised by absence-from-source — those we never touch here;
    // `syncAllUserSkills` is the authoritative writer for that subset.
    pruneStaleBuiltinSkillDirs(destSkillsRoot, skillsRoot, skillSlugs);
    for (const skillSlug of skillSlugs) {
      // docs/design/appendices/opencode-backend.md §10 D6 / Phase 4 — slug must match
      // opencode's skill-name lint regex `[a-z0-9-]{1,64}` because a
      // future opencode release may reject names that fall outside it.
      // Warn at materialisation; do not strip the skill (every Aitne
      // built-in slug already conforms — see audit acceptance criterion).
      if (!isValidSkillSlug(skillSlug)) {
        logger.warn(
          { skillSlug, expected: "[a-z0-9-]{1,64}" },
          "skills_compiler.skill_slug_invalid",
        );
      }
      const src = resolveBuiltinSkillDir(skillsRoot, skillSlug);
      if (!existsSync(join(src, "SKILL.md"))) {
        continue;
      }
      const variantFile = this.resolveSkillVariantFile(skillSlug, sessionBackend);
      const destDir = join(destSkillsRoot, skillSlug);
      // DELEGATED-MODE-V2-DESIGN.md §4.1.2 — same-backend native MCP. The
      // agent already has the connector's tools in its inventory; a skill
      // body would mis-direct it at the daemon proxy (which 409s in this
      // case). Remove any prior-materialization leftovers from disk so a
      // mode flip (direct ↔ delegated.same-backend) doesn't leave stale
      // prose in the workdir.
      if (variantFile === null) {
        if (existsSync(destDir)) {
          rmSync(destDir, { recursive: true, force: true });
        }
        continue;
      }
      cpSync(src, destDir, { recursive: true });
      // Resolve `{APP_NAME}` brand tokens in the verbatim copy before any
      // downstream transform reads them. Source-of-truth: branding.ts.
      substituteBrandTokensInDir(destDir);
      substituteWikiWorkspaceTokensInDir(destDir, processKey, wikiWorkspaceName);

      if (variantFile !== "SKILL.md") {
        // Render variant (resolving {{> base }} partials) and overwrite SKILL.md.
        // Wrap the inliner output: renderPartialIncludes reads from src verbatim,
        // so an `{APP_NAME}` token in SKILL.base.md would slip through if we only
        // substituted `raw`. Idempotent — re-running on already-substituted text
        // is a no-op.
        const raw = substituteBrandTokens(readFileSync(join(src, variantFile), "utf-8"));
        const rendered = substituteWikiWorkspaceTokens(
          substituteBrandTokens(
            renderPartialIncludes(raw, join(src, "SKILL.base.md")),
          ),
          processKey,
          wikiWorkspaceName,
        );
        writeFileSync(join(destDir, "SKILL.md"), rendered, "utf-8");
      }

      // Resolve `{{> ref:<name> }}` directives by inlining
      // `references/<name>.md` from the SOURCE skill dir. Read from src so
      // the references content is canonical (the directory copy under
      // `destDir/references/` is identical, but reading from src makes the
      // dependency direction explicit and matches the CLI path).
      //
      // Order: refs BEFORE strip-services. The CLI paths
      // (`materializeCliSession` inline + directory copy) both run refs
      // before strip; aligning here preserves the byte-equivalence
      // contract (plan §3.1) for the case where a reference file carries
      // `<!-- service:* -->` markers — strip-first would leak those on
      // Claude/OpenCode while CLI scrubs them.
      const destSkillMdForRefs = join(destDir, "SKILL.md");
      if (existsSync(destSkillMdForRefs)) {
        const raw = readFileSync(destSkillMdForRefs, "utf-8");
        // renderReferenceIncludes inlines `references/*.md` directly from src,
        // bypassing the post-cpSync substitution walk. Wrap the result so a
        // future `{APP_NAME}` token added to a reference file resolves cleanly.
        const expanded = substituteWikiWorkspaceTokens(
          substituteBrandTokens(renderReferenceIncludes(raw, src)),
          processKey,
          wikiWorkspaceName,
        );
        if (expanded !== raw) {
          writeFileSync(destSkillMdForRefs, expanded, "utf-8");
        }
      }

      // Strip unconfigured service sections from external-services
      if (skillSlug === "external-services" && this.configuredServices.size > 0) {
        const destSkillMd = join(destDir, "SKILL.md");
        const raw = readFileSync(destSkillMd, "utf-8");
        const stripped = stripUnconfiguredServices(raw, this.configuredServices);
        if (stripped !== raw) {
          writeFileSync(destSkillMd, stripped, "utf-8");
        }
      }

      // Mode-conditional sections (`<!-- mode:<predicate>:<key> -->`)
      // collapse to the right branch for the current integration state.
      // Runs AFTER service-strip so unrelated service sections that carry
      // mode markers still see them. Runs BEFORE the deny pass so any
      // `allowed-tools` entry inside a struck branch gets removed before
      // deny-list filtering inspects the frontmatter.
      const destSkillMdForMode = join(destDir, "SKILL.md");
      if (existsSync(destSkillMdForMode)) {
        const raw = readFileSync(destSkillMdForMode, "utf-8");
        const filtered = applyIntegrationModeFilter(
          raw,
          this.integrations,
          sessionBackend,
        );
        if (filtered !== raw) {
          writeFileSync(destSkillMdForMode, filtered, "utf-8");
        }
      }

      // §7.7 — apply tool-deny policy AFTER partial includes and
      // service-section stripping. For the Claude SDK this rewrites the
      // `allowed-tools` frontmatter (hard); for opencode the rewrite is
      // a soft-enforcement prose body addition that the runtime config
      // doubles up via `permission.bash.deny` rules.
      const destSkillMdForDeny = join(destDir, "SKILL.md");
      if (existsSync(destSkillMdForDeny)) {
        const raw = readFileSync(destSkillMdForDeny, "utf-8");
        const filtered = applyAllDeniedToolsForSkill(
          raw,
          skillSlug,
          sessionBackend,
          this.integrations,
        );
        if (filtered !== raw) {
          writeFileSync(destSkillMdForDeny, filtered, "utf-8");
        }
      }

      // P22 — skill-curation anchor splicer pass. Runs LAST so anchors
      // resolve over the fully transformed body (mode-conditional + deny
      // already applied). No-op when no curation context is configured or
      // when the skill ships no curation.json.
      this.spliceCurationAnchorsInSkill(destDir, skillSlug);
      if (skillSlug === "mail") {
        // Always write accounts.md — the empty marker (rendered when the
        // list is empty) tells the agent not to guess ids, and having the
        // file unconditionally keeps the refresh hook's existsSync checks
        // truthful on both 0→N and N→0 transitions.
        writeFileSync(
          join(destDir, "accounts.md"),
          this.mailAccounts.length > 0
            ? renderMailAccountsMd(this.mailAccounts)
            : EMPTY_MAIL_ACCOUNTS_MD,
          "utf-8",
        );
      }
      // Phase 1 §"Codex read-sensitive banner inheritance" — prepend the
      // 3-line caveat banner to every Codex skill body that touches a
      // read-sensitive `/api/*` endpoint. Skipped for the other three
      // backends: Claude / Gemini hold the read-sensitive token; OpenCode
      // surfaces those routes via its own credential flow.
      if (sessionBackend === "codex") {
        prependCodexReadSensitiveBanner(join(destDir, "SKILL.md"));
      }
      materialised.push(skillSlug);
    }
    return materialised;
  }

  /**
   * docs/design/appendices/opencode-backend.md §6.5 / Phase 4 — opencode-specific
   * materialisation.
   *
   * Three on-disk artefacts are written per session:
   *   1. `AGENTS.md` (cwd-auto-discovered by opencode per V1) — same
   *      shape as `materializeCliSession` produces for Codex EXCEPT
   *      skill bodies are NOT inlined (skills auto-discover from
   *      `.claude/skills/` via opencode's `skill` tool — V2). Includes
   *      safety, character, behavioral rules, daemon-API, integration
   *      routing tables, and the runtime profile body.
   *   2. `.opencode/agent/<profile-slug>.md` (singular `agent/` per V5)
   *      — the per-process agent persona with V5-correct frontmatter
   *      (`mode: primary`, `permission` block keyed only on
   *      `edit/bash/webfetch/doom_loop/external_directory` — NO `read`
   *      key per V5 contract). Body is the profile body; opencode
   *      invokes this via `session.prompt({ body: { agent: <slug> } })`
   *      so the per-agent permission overrides the server-level
   *      defaults.
   *   3. `.opencode/skills/<slug>/` via `writeSkillsDir` — every
   *      manifest skill becomes a discoverable SKILL.md tree opencode
   *      reads on `skill` tool activation. `.claude/skills/` is
   *      intentionally NOT written: docs/design/appendices/skills-unification.md Phase 1
   *      flipped opencode from V2 path (b) (`.claude/skills/`
   *      redundancy-avoiding alias) to V2 path (c) (`.opencode/skills/`)
   *      so each backend lives under its own brand-aligned namespace.
   *
   * The dispatcher passes `agent: <slug>` (where `<slug>` matches the
   * profile filename without `.md`) on every `session.prompt` call so
   * the right agent file is selected.
   */
  private materializeOpencodeSession(
    sessionDir: string,
    profileName: string,
    skillSlugs: string[],
    profileBodyOverride: string | null,
    processKey: ProcessKey | string,
    wikiWorkspaceName: string | undefined,
  ): void {
    // ── 1. AGENTS.md — cwd context (no skill inlining) ──
    let profileContent =
      profileBodyOverride !== null
        ? profileBodyOverride.trim()
        : (this.readProfile(profileName) ?? "");
    profileContent = substituteWikiWorkspaceTokens(
      profileContent,
      processKey,
      wikiWorkspaceName,
    );
    const safetyContent = this.readSafetyPreamble();
    const characterBlock = buildCharacterBlock(this.character);
    // DELEGATED-MODE-V2-DESIGN.md §4.3.3-§4.3.4 — same-backend deny prose.
    // Opencode's MCP-tool deny is server-level only (§5.6 v1: drop the
    // server from config to deny). The prose duplicates intent so the
    // agent doesn't waste tokens drafting calls that will be dropped.
    const sameBackendDenyBlock = buildSameBackendDenyBlock(
      this.integrations,
      "opencode",
    );
    const rawInstruction = renderCliInstructionFile({
      backendId: "opencode",
      processKey,
      profileName,
      profileContent,
      safetyContent,
      characterBlock,
      skillSlugs,
      // R3 — OpenCode never gets a `<skill-index>` block. The cwd
      // auto-discovery loader is the source of truth; emitting an index
      // here would inject a second listing the runtime ignores and the
      // agent could mistake for canonical. The `## Skills` slug manifest
      // (no path, no inlined bodies) survives as a turn-scope hint.
      skillPreamble: null,
      skillIndexBlock: null,
      sameBackendDenyBlock,
    });
    const instruction = substituteWikiWorkspaceTokens(
      substituteIntegrationRoutingTables(rawInstruction, this.integrations),
      processKey,
      wikiWorkspaceName,
    );
    writeFileSync(join(sessionDir, "AGENTS.md"), instruction, "utf-8");

    // ── 2. .opencode/agent/<profileName>.md — V5 frontmatter wrapper ──
    this.writeOpencodeAgentFile(
      sessionDir,
      profileName,
      profileContent,
      safetyContent,
      characterBlock,
    );

    // ── 3. .opencode/skills/ — auto-discovered by opencode 1.14+ ──
    // docs/design/appendices/skills-unification.md Phase 1 — opencode 1.14+ auto-discovers
    // skills from `.opencode/skills/<slug>/SKILL.md` (V2 path (c),
    // empirically verified). The earlier path (b) (`.claude/skills/`)
    // worked as a redundancy-avoiding alias; per-backend brand-aligned
    // naming now picks (c) explicitly.
    this.writeSkillsDir(
      sessionDir,
      join(".opencode", "skills"),
      skillSlugs,
      "opencode",
      processKey,
      wikiWorkspaceName,
    );
  }

  /**
   * docs/design/appendices/opencode-backend.md §6.5 / V5 — write the per-process agent
   * profile to `.opencode/agent/<slug>.md` (singular `agent/`; the
   * plural form does NOT register per V5).
   *
   * Frontmatter shape (V5-correct keys only):
   *   - `mode: primary` — opencode's primary-agent mode; subagent is
   *     reserved for the disabled `task` tool path.
   *   - NO `permission` block here — the server-level
   *     `OpencodeRuntimeConfig.permission` is the per-session truth and
   *     is stricter for narrow agents (delegated runs use a separate
   *     `delegated-<callId>` agent file with its own tight permission).
   *     Emitting `permission: {}` here would NOT widen anything (the
   *     server-level deny still wins), but the absence keeps the
   *     frontmatter a manifest and avoids drift between two seats.
   *   - NO `model` field — opencode falls back to `OPENCODE_CONFIG_CONTENT.model`
   *     (set per-session by `OpencodeCore`'s runtime-config builder),
   *     and the dispatcher additionally overrides per `session.prompt`
   *     body. Pinning here would either drift from the per-call value
   *     or duplicate it.
   *
   * Body composition mirrors AGENTS.md (safety + character + profile)
   * so an `agent: <slug>` invocation that REPLACES opencode's default
   * cwd context still gets safety/character rules — V5 confirmed the
   * agent body becomes the system prompt for that turn.
   */
  private writeOpencodeAgentFile(
    sessionDir: string,
    profileName: string,
    profileBody: string,
    safetyContent: string | null,
    characterBlock: string | null,
  ): void {
    const agentDir = join(sessionDir, ".opencode", "agent");
    mkdirSync(agentDir, { recursive: true });

    // Strip a description from the profile body's first paragraph for
    // the frontmatter `description` field. Opencode displays this in
    // its agent picker; we use a stable phrasing so re-renders produce
    // identical bytes.
    const description =
      `${APP_NAME} ${profileName} — per-process persona`;

    const frontmatter = [
      "---",
      `description: ${description}`,
      "mode: primary",
      "---",
      "",
    ].join("\n");

    const bodySections: string[] = [];
    if (safetyContent) bodySections.push(safetyContent);
    if (characterBlock) bodySections.push(characterBlock);
    if (profileBody.trim()) bodySections.push(profileBody.trim());
    const body = bodySections.join("\n\n");

    writeFileSync(
      join(agentDir, `${profileName}.md`),
      `${frontmatter}${body}\n`,
      "utf-8",
    );
  }

  /**
   * P22 §1.5 — splice CURATION anchors in a single skill's materialized
   * SKILL.md against overlay/seed JSON. Pure file I/O — overlay store
   * dictates payload precedence (overlay > seed > strip-line). No-op when
   * no curation context is configured or when the skill has no anchors.
   */
  private spliceCurationAnchorsInSkill(destDir: string, skillSlug: string): void {
    if (!this.skillCurationDataDir) return;
    const skillMdPath = join(destDir, "SKILL.md");
    if (!existsSync(skillMdPath)) return;
    const md = readFileSync(skillMdPath, "utf-8");
    if (!hasCurationAnchors(md)) return;
    let decl: LoadedCurationDeclaration["declaration"];
    try {
      decl = loadCurationDeclaration(this.getSourceSkillsRoot(), skillSlug);
      // Note: `loadCurationDeclaration` resolves the slug via the shared
      // `resolveBuiltinSkillDir` so wiki skills (nested under
      // `skills/wiki/<slug>/`) are picked up alongside flat slugs.
    } catch (err) {
      logger.warn(
        { skillSlug, err: err instanceof Error ? err.message : String(err) },
        "skill_curation.declaration.invalid",
      );
      return;
    }
    const overlay = new OverlayStore(this.skillCurationDataDir, this.getSourceSkillsRoot());
    const knownIds = decl ? new Set(decl.sections.map((s) => s.id)) : undefined;
    const result = spliceCurationAnchors(
      md,
      (sectionId, kind) => overlay.readPayload(skillSlug, sectionId, kind),
      { knownSectionIds: knownIds },
    );
    if (result.warnings.length > 0) {
      for (const w of result.warnings) {
        logger.warn({ skillSlug, anchorId: w.anchorId, code: w.code, message: w.message }, w.code);
      }
    }
    if (result.body !== md) {
      writeFileSync(skillMdPath, result.body, "utf-8");
    }
  }

  /**
   * docs/design/appendices/skills-unification.md Phase 1 item 15 — the slim path does NOT
   * emit a `<skill-index>` block or the skill-discovery preamble. The
   * fetch_window system prompt is a self-contained operational contract
   * (one-window-one-curl, no sub-tasks, exactly-one JSON-on-stdout) and
   * the only skill copied (`observations`) is referenced inline by the
   * runner-emitted user prompt. Adding the index would mis-signal the
   * fetcher to scan for skills before executing the acquisition plan.
   *
   * docs/design/appendices/fetch-window-cost-reduction.md Phase 1.5 — slim instruction-file
   * materializer for `routine.fetch_window` on Codex / Gemini CLI.
   *
   * Mirrors the Claude SDK's Phase 1 systemPrompt swap (the same
   * `agent-assets/system-prompts/routine-fetch-window.md` template is the
   * single source of truth): write the slim body verbatim as AGENTS.md /
   * GEMINI.md and copy only the `observations` skill — the
   * `/api/observations/batch` POST contract is the fetcher's sole
   * structural assertion. The integration partial inlined by the runner
   * (`routine-fetch-window-runner.ts:reassemblePrompt`) covers the
   * per-attempt call shape, so `mail` / `notion` / `external-services` /
   * `attach` skill bodies are deliberately omitted.
   *
   * No safety preamble / character / behavioral-rules / daemon-API
   * sections — the slim template restates the only rules the fetcher
   * needs (localhost-only curl, no sub-tasks, no context writes, no
   * notify, JSON-on-stdout-and-exit). The destructive-action policy layer
   * (absolute-block list, Codex sandbox, Gemini admin TOML) still applies
   * unchanged at runtime.
   *
   * The `<mcp-servers>` section is appended downstream by
   * `services/mcp/session-materializer.ts:appendMcpSection` exactly as on
   * the wide path — Phase 3's allowlist filter, when it lands, will scope
   * that section without further changes here.
   */
  private materializeFetchWindowCliSession(
    sessionDir: string,
    backendId: Exclude<BackendId, "claude">,
  ): void {
    mkdirSync(sessionDir, { recursive: true });
    const slim = loadFetchWindowSystemPrompt();
    writeFileSync(
      join(sessionDir, cliInstructionFileName(backendId)),
      slim,
      "utf-8",
    );

    // Copy ONLY the `observations` skill dir. The wide path's prune step
    // is replaced by an explicit single-slug list — `pruneStaleBuiltinSkillDirs`
    // removes any other built-in skill dir that a prior re-materialization
    // (e.g. a fallback-driven wide path on the same workdir) may have left.
    const cliSkillsRoot = cliSkillsDirName(backendId);
    if (cliSkillsRoot === null) return; // Claude-only — fetch_window slim runs on Claude SDK natively.
    const skillsRoot = this.getSourceSkillsRoot();
    const destSkillsRoot = join(sessionDir, cliSkillsRoot, "skills");
    mkdirSync(destSkillsRoot, { recursive: true });
    pruneStaleBuiltinSkillDirs(destSkillsRoot, skillsRoot, [FETCH_WINDOW_SLIM_SKILL]);

    const src = resolveBuiltinSkillDir(skillsRoot, FETCH_WINDOW_SLIM_SKILL);
    const skillMdPath = join(src, "SKILL.md");
    if (!existsSync(skillMdPath)) return;
    const destDir = join(destSkillsRoot, FETCH_WINDOW_SLIM_SKILL);
    cpSync(src, destDir, { recursive: true });
    substituteBrandTokensInDir(destDir);
    // No `substituteWikiWorkspaceTokensInDir` — fetch_window never touches
    // wiki workspace state, and the resolver is a no-op for non-wiki
    // process keys anyway.
    let adapted = substituteBrandTokens(readFileSync(skillMdPath, "utf-8"));
    // observations/SKILL.md ships no `{{> base }}` or `{{> ref:* }}`
    // directives today, but run the resolvers anyway so a future curation
    // edit cannot silently drop content. Idempotent on plain content.
    adapted = substituteBrandTokens(renderPartialIncludes(adapted, join(src, "SKILL.base.md")));
    adapted = substituteBrandTokens(renderReferenceIncludes(adapted, src));
    // Mode-conditional filter — observations/SKILL.md carries
    // `<!-- mode:<predicate>:notion -->` markers (lines 273-345 today)
    // because the source / consume contract differs across `direct` /
    // `delegated-same` / `delegated-cross` / `native` / `disabled`. The
    // wide path applies this filter at `materializeCliSession`; the
    // slim path must match so the agent doesn't get every mode's prose
    // for every integration. Idempotent on bodies that lack markers.
    adapted = applyIntegrationModeFilter(adapted, this.integrations, backendId);
    // Tool-deny policy stays in force — even though the fetcher is fed a
    // narrow allowlist, the soft-enforcement prose lands in the body
    // BEFORE the CLI frontmatter strip so it's not lost.
    adapted = applyAllDeniedToolsForSkill(
      adapted,
      FETCH_WINDOW_SLIM_SKILL,
      backendId,
      this.integrations,
    );
    // docs/design/appendices/skills-unification.md Phase 1 §R6 — frontmatter stays intact
    // across all backends. `adaptSkillForCli` is gone; the source body's
    // YAML preamble flows through verbatim.
    writeFileSync(join(destDir, "SKILL.md"), adapted, "utf-8");
    this.spliceCurationAnchorsInSkill(destDir, FETCH_WINDOW_SLIM_SKILL);
  }

  private materializeCliSession(
    sessionDir: string,
    profileName: string,
    skillSlugs: string[],
    backendId: Exclude<BackendId, "claude">,
    processKey: ProcessKey | string,
    profileBodyOverride: string | null,
    wikiWorkspaceName: string | undefined,
  ): void {
    // docs/design/appendices/fetch-window-cost-reduction.md Phase 1.5 — divert
    // `routine.fetch_window` to a slim materializer that mirrors the
    // Claude SDK's Phase 1 systemPrompt swap. Custom bang commands cannot
    // reach this branch (they bind to `messaging.custom_command`), so
    // `profileBodyOverride` is intentionally NOT forwarded.
    if (processKey === FETCH_WINDOW_PROCESS_KEY) {
      this.materializeFetchWindowCliSession(sessionDir, backendId);
      return;
    }
    // docs/design/appendices/skills-unification.md Phase 1 — directory-based skill delivery.
    // The Codex / Gemini CLIs have no native cwd auto-discovery today, so
    // the instruction file (AGENTS.md / GEMINI.md) carries a compact
    // `<skill-index>` block and the agent `Read`s each `SKILL.md` from the
    // per-backend dir on demand. Skill bodies are NEVER inlined into the
    // instruction file.
    //
    // OpenCode reaches `materializeOpencodeSession` instead, so this method
    // only handles Codex and Gemini. The defensive `null` check below
    // protects future backends that might temporarily route through here
    // before getting their own materialiser.
    const cliSkillsDir = cliSkillsDirName(backendId);
    if (cliSkillsDir === null) {
      throw new Error(
        `materializeCliSession: no skills directory mapped for backend "${backendId}"`,
      );
    }
    const destSkillsRootRelative = join(cliSkillsDir, "skills");
    const materialisedSlugs = this.writeSkillsDir(
      sessionDir,
      destSkillsRootRelative,
      skillSlugs,
      backendId,
      processKey,
      wikiWorkspaceName,
    );

    // Read profile and safety separately so renderCliInstructionFile can
    // place safety at the top level for prominence (instead of burying it
    // inside the profile section). For custom bang commands the dispatcher
    // passes a `profileBodyOverride` that replaces the persona body; the
    // safety + character + skill index sections still wrap around it via
    // `renderCliInstructionFile`.
    let profileContent =
      profileBodyOverride !== null
        ? profileBodyOverride.trim()
        : (this.readProfile(profileName) ?? "");
    profileContent = substituteWikiWorkspaceTokens(profileContent, processKey, wikiWorkspaceName);
    const safetyContent = this.readSafetyPreamble();
    const characterBlock = buildCharacterBlock(this.character);
    // DELEGATED-MODE-V2-DESIGN.md §4.3.3-§4.3.4 — same-backend deny prose.
    // Codex's connector apps (`mcp__codex_apps__*`) are built into the CLI
    // and have no admin-policy or per-tool deny surface (γ outcome). Prose
    // injection into AGENTS.md is the only enforcement available. For
    // Gemini, the admin-policy already hard-denies the same tools; the
    // prose duplicates intent so the agent doesn't waste tokens drafting
    // calls that will be denied at the policy layer.
    const sameBackendDenyBlock = buildSameBackendDenyBlock(
      this.integrations,
      backendId,
    );
    // docs/design/appendices/skills-unification.md Phase 1 §"Skill preamble" — render the
    // universal preamble + `<skill-index>` block. The index is derived
    // from the **materialised** SKILL.md frontmatter on disk so curation /
    // mode-filter / deny passes are reflected. Reading post-materialisation
    // also keeps user-authored slugs synced by `syncAllUserSkills` (which
    // runs LATER from the workdir layer) out of the index — those land in
    // the same dir but are appended after this render. The
    // `refreshSkillIndexBlock` helper (called by workdir.ts post-sync) is
    // responsible for splicing user-authored slugs into the block.
    const skillPreamble = loadSkillIndexPreamble(this.workspaceDir);
    const destSkillsRootAbs = join(sessionDir, destSkillsRootRelative);
    const skillIndexBlock = renderSkillIndexBlock(
      destSkillsRootAbs,
      destSkillsRootRelative,
    );
    const rawInstruction = renderCliInstructionFile({
      backendId,
      processKey,
      profileName,
      profileContent,
      safetyContent,
      characterBlock,
      skillSlugs: materialisedSlugs,
      skillPreamble,
      skillIndexBlock,
      sameBackendDenyBlock,
    });
    // INTEGRATION_NATIVE_MODE_DESIGN.md §7.3 — substitute the
    // `<integration-routing-table>` placeholder in the rendered
    // instruction file. Runs after the whole document is assembled so
    // placeholders anywhere (profile body, preamble, index) all resolve
    // in one pass.
    const instruction = substituteWikiWorkspaceTokens(
      substituteIntegrationRoutingTables(
        rawInstruction,
        this.integrations,
      ),
      processKey,
      wikiWorkspaceName,
    );
    writeFileSync(
      join(sessionDir, cliInstructionFileName(backendId)),
      instruction,
      "utf-8",
    );
  }
}

