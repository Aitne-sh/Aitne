import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

import type DatabaseNs from "better-sqlite3";
import {
  APP_NAME,
  BACKEND_IDS,
  INTEGRATION_DESCRIPTORS,
  INTEGRATION_KEYS,
  applyIntegrationModeFilter,
  collectSessionDeniedTools,
  filterDeniedToolsForBackend,
  selectSkillVariantFile,
  selectTaskFlowVariantSuffix,
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
import {
  applyOutputLanguagePointerRewrite,
  renderOutputLanguagePolicyPointer,
} from "./output-language-policy.js";
import { createLogger } from "../logging.js";
import { loadFetchWindowSystemPrompt } from "./fetch-window-prompt-loader.js";
import { substituteIntegrationRoutingTables } from "./management-md.js";
import type { MailAccount } from "../services/mail/provider.js";
import {
  loadCurationDeclaration,
  type LoadedCurationDeclaration,
} from "./skill-curation/declarations.js";
import {
  listBuiltinSlugs,
  resolveBuiltinSkillDir,
} from "./skill-source-paths.js";
import { OverlayStore } from "./skill-curation/overlay-store.js";
import {
  hasCurationAnchors,
  spliceCurationAnchors,
} from "./skill-curation/splicer.js";

// Exported so tests can spy on `logger.warn` (e.g. the missing-reference
// branch of `renderReferenceIncludes`). Production callers do not import it.
export const logger = createLogger("skills-compiler");

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

interface SkillCompilerFile {
  path: string;
  content: string;
  updatedAt: string | null;
}

/**
 * Check whether the skill AND task-flow variants a given integration would
 * require when delegated to `delegatedBackend` are all present on disk.
 * Returns missing file paths split by kind.
 *
 * DELEGATED-MODE-V2-DESIGN.md §4.1.1 — variant filenames are keyed on
 * **session backend**, not the delegated backend. Three resolutions:
 *  - sessionBackend === delegatedBackend → `null` (no skill body, native MCP)
 *  - sessionBackend !== delegatedBackend → `SKILL.delegated.<sessionBackend>.md`
 *    (cross-backend; the daemon proxy spawns delegatedBackend)
 *  - non-delegated touch → `SKILL.md` (no delegated variant required)
 *
 * Task flow variants always fire as `delegated.<sessionBackend>` whenever
 * any touched integration is delegated, regardless of same- vs cross-backend
 * (`selectTaskFlowVariantSuffix`).
 *
 * The gate enumerates every potential session backend (`BACKEND_IDS`) and
 * defers to the resolvers; that keeps the gate automatically aligned with
 * `selectSkillVariantFile` / `selectTaskFlowVariantSuffix` if those grow new
 * cases. We pin the integration's mode locally as `delegated` with the
 * supplied `delegatedBackend` so the resolvers see the post-PATCH state.
 *
 * Consumed by:
 *  - `SkillsCompiler.validateDelegatedVariants()` — startup aggregate
 *  - `PATCH /api/integrations/:key` — pre-commit hard reject (§4.7)
 *  - `buildIntegrationHealthMap` — surfaces the list in
 *    `/health.integrationModes.<key>.variantsMissing`
 */
/**
 * Walk a materialized session subdirectory and rewrite every `.md` file with
 * `{APP_NAME}` tokens resolved. Called immediately after `cpSync(src, dest, …)`
 * so the verbatim copy from `agent-assets/` becomes brand-substituted before
 * any downstream transform (renderReferenceIncludes, applyIntegrationModeFilter,
 * tool-deny filter) reads it. Idempotent — running it twice is a no-op.
 */
function substituteBrandTokensInDir(dir: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      substituteBrandTokensInDir(full);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const original = readFileSync(full, "utf-8");
      const substituted = substituteBrandTokens(original);
      if (substituted !== original) {
        writeFileSync(full, substituted, "utf-8");
      }
    }
  }
}

interface WikiWorkspaceTokens {
  vault_path: string;
  language: string;
  workspace_name: string;
  schema_version: string;
}

let wikiWorkspaceTokenResolver:
  | ((processKey: string, workspaceName?: string) => WikiWorkspaceTokens | null)
  | null = null;

export function setWikiWorkspaceTokenResolver(
  resolver:
    | ((processKey: string, workspaceName?: string) => WikiWorkspaceTokens | null)
    | null,
): void {
  wikiWorkspaceTokenResolver = resolver;
}

function wikiTokensFor(
  processKey: string | null | undefined,
  workspaceName: string | undefined,
): WikiWorkspaceTokens | null {
  if (!processKey?.startsWith("wiki.")) return null;
  return wikiWorkspaceTokenResolver?.(processKey, workspaceName) ?? null;
}

function substituteWikiWorkspaceTokens(
  content: string,
  processKey: string | null | undefined,
  workspaceName: string | undefined,
): string {
  const tokens = wikiTokensFor(processKey, workspaceName);
  if (!tokens) return content;
  return content
    .replaceAll("{{vault_path}}", tokens.vault_path)
    .replaceAll("{{language}}", tokens.language)
    .replaceAll("{{workspace_name}}", tokens.workspace_name)
    .replaceAll("{{schema_version}}", tokens.schema_version);
}

function substituteWikiWorkspaceTokensInDir(
  dir: string,
  processKey: string | null | undefined,
  workspaceName: string | undefined,
): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      substituteWikiWorkspaceTokensInDir(full, processKey, workspaceName);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const original = readFileSync(full, "utf-8");
      const substituted = substituteWikiWorkspaceTokens(original, processKey, workspaceName);
      if (substituted !== original) {
        writeFileSync(full, substituted, "utf-8");
      }
    }
  }
}

export function missingDelegatedVariants(
  workspaceDir: string,
  integrationKey: IntegrationKey,
  delegatedBackend: BackendId,
): { skills: string[]; taskFlows: string[] } {
  return missingVariantsForMode(workspaceDir, integrationKey, {
    mode: "delegated",
    delegatedBackend,
  });
}

/**
 * INTEGRATION_NATIVE_MODE_DESIGN.md §7.4 / §8.5 — symmetric to
 * {@link missingDelegatedVariants} for the new `native` mode. Used by
 * the PATCH route's pre-commit hard reject and (Phase B2 onwards) by
 * `skills-manifest.test.ts` to assert variant existence on every
 * supported `(integration, native backend)` pair before a release.
 */
export function missingNativeVariants(
  workspaceDir: string,
  integrationKey: IntegrationKey,
  nativeBackend: BackendId,
): { skills: string[]; taskFlows: string[] } {
  return missingVariantsForMode(workspaceDir, integrationKey, {
    mode: "native",
    nativeBackend,
  });
}

function missingVariantsForMode(
  workspaceDir: string,
  integrationKey: IntegrationKey,
  pinnedState:
    | { mode: "delegated"; delegatedBackend: BackendId }
    | { mode: "native"; nativeBackend: BackendId },
): { skills: string[]; taskFlows: string[] } {
  const descriptor = INTEGRATION_DESCRIPTORS[integrationKey];
  const skillsRoot = join(workspaceDir, "agent-assets", "skills");
  const taskFlowsRoot = join(workspaceDir, "agent-assets", "task-flows");

  // Synthetic post-PATCH state. The resolvers consume only `mode` and
  // the backend binding; `lastChangedAt` is required by the type but not
  // read here.
  const synthetic: IntegrationState =
    pinnedState.mode === "delegated"
      ? {
          mode: "delegated",
          delegatedBackend: pinnedState.delegatedBackend,
          deniedTools: [],
          lastChangedAt: "1970-01-01T00:00:00.000Z",
        }
      : {
          mode: "native",
          nativeBackend: pinnedState.nativeBackend,
          deniedTools: [],
          lastChangedAt: "1970-01-01T00:00:00.000Z",
        };
  const integrationsState: Partial<Record<IntegrationKey, IntegrationState>> = {
    [integrationKey]: synthetic,
  };

  // For `native` mode the variant is only required when the session
  // backend is the bound native backend (other session backends would
  // resolve to `disabled` per §5.4.1's safety degrade, so they don't need
  // a SKILL.native.<other>.md file). For `delegated` we keep the original
  // walk over every session backend since cross-backend variants ARE
  // required.
  const sessionBackendsToCheck: readonly BackendId[] =
    pinnedState.mode === "native"
      ? [pinnedState.nativeBackend]
      : BACKEND_IDS.filter((backend) => backend !== "opencode");

  // De-dup with sets — the same file path can come up under multiple
  // session backends when descriptors share a slug.
  const skills = new Set<string>();
  for (const slug of descriptor.skillsTouched) {
    for (const sessionBackend of sessionBackendsToCheck) {
      const variantFile = selectSkillVariantFile(
        slug,
        sessionBackend,
        integrationsState,
      );
      // null  → same-backend delegated drops body; no file required.
      // SKILL.md → resolver fell back to direct/disabled; no variant file.
      if (variantFile === null || variantFile === "SKILL.md") continue;
      const variantPath = join(resolveBuiltinSkillDir(skillsRoot, slug), variantFile);
      if (!existsSync(variantPath)) skills.add(variantPath);
    }
  }

  const taskFlows = new Set<string>();
  for (const flowKey of descriptor.taskFlowsTouched) {
    for (const sessionBackend of sessionBackendsToCheck) {
      const suffix = selectTaskFlowVariantSuffix(
        flowKey,
        sessionBackend,
        integrationsState,
      );
      if (suffix === "direct") continue;
      const variantPath = join(
        taskFlowsRoot,
        `${flowKey}.${suffix}.md`,
      );
      if (existsSync(variantPath)) continue;
      // INTEGRATION_NATIVE_MODE_DESIGN.md §8.1 — when a task-flow lists a
      // mode-aware integration in `taskFlowsTouched` but doesn't ship a
      // per-mode variant file, the loader (`prompts.ts:loadFlowVariant`)
      // gracefully falls back to the canonical base file. Treat that as
      // a valid coverage path so the `missingDelegatedVariants` /
      // `missingNativeVariants` PATCH-time check doesn't reject a flip
      // for which the loader's base-file fallback is the designed answer.
      //
      // Concrete example: `message.received.dm` is listed in gmail /
      // google_calendar / notion `taskFlowsTouched` so the native DM
      // variant resolves; the matching delegated variant
      // (`message.received.dm.delegated.<backend>.md`) is intentionally
      // absent. The base `message.received.dm.md` carries inline
      // `<!-- mode:<predicate>:<key> -->` markers for the Calendar block
      // and routes other integrations through their per-skill bodies. The
      // loader correctly falls back, so the missing variant is not a real
      // configuration gap.
      //
      // Skill variants remain strict — a missing `SKILL.<mode>.<backend>.md`
      // leaves the agent with no per-mode body for the integration, which
      // IS a real gap. The strict check above (no leniency branch) handles
      // that.
      const basePath = join(taskFlowsRoot, `${flowKey}.md`);
      if (!existsSync(basePath)) {
        taskFlows.add(variantPath);
      }
    }
  }

  return { skills: [...skills], taskFlows: [...taskFlows] };
}

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

interface SessionInstructionParams {
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
   * the standalone `missingDelegatedVariants` helper below; this method
   * aggregates across every currently-delegated integration using its
   * declared `delegatedBackend` (not the session backend — see the helper
   * docstring for the rationale).
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

export const EMPTY_MAIL_ACCOUNTS_MD = [
  "# Mail accounts",
  "",
  "No active mail accounts are configured right now. The `mail` skill's API",
  "calls will fail without an `accountId` — do NOT guess account ids. If no",
  "account matches, tell the user no active mail account is configured and",
  "stop — account setup is outside this skill's scope.",
  "",
].join("\n");

export function renderMailAccountsMd(accounts: readonly MailAccount[]): string {
  const rows = accounts.map((a) => {
    const label = a.label ? ` (${a.label})` : "";
    return `| \`${a.id}\` | ${a.kind} | ${a.email}${label} | ${a.idleEnabled ? "IDLE" : "poll"} |`;
  });
  return [
    "# Mail accounts",
    "",
    "Active mail accounts this session can use. Resolve `accountId` from this",
    "table before calling `/api/mail/:accountId/*`. Inactive / unhealthy",
    "accounts are omitted by design — no global \"primary\" default exists;",
    "pick the account from conversation context (reply thread, user mention,",
    "or a single active row) and ask when ambiguous.",
    "",
    "| accountId | kind | email | transport |",
    "|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

/**
 * docs/design/appendices/opencode-backend.md §10 D6 — opencode 1.14.50 documents
 * `[a-z0-9-]{1,64}` as the legal skill-slug pattern. Aitne's existing
 * built-ins all conform; this helper is the predicate the build-time
 * validator (`validateBuiltinSkillSourceTree`) and the user-skill PUT
 * endpoint both gate on.
 *
 * docs/design/appendices/skills-unification.md Phase 1 §R5 / item 6 — promoted from a
 * runtime warn to a build-time throw at SkillsCompiler construction so
 * a malformed source tree refuses to boot the daemon.
 *
 * Exported for unit testing (`skills-compiler.test.ts` regression).
 */
export function isValidSkillSlug(slug: string): boolean {
  return /^[a-z0-9-]{1,64}$/.test(slug);
}

/**
 * docs/design/appendices/skills-unification.md Phase 1 §R5 / item 6 — build-time invariant
 * pass over `agent-assets/skills/`. Throws on:
 *   - Any built-in slug that doesn't match `[a-z0-9-]{1,64}`.
 *   - Any SKILL.md (incl. variants like `SKILL.delegated.<backend>.md`)
 *     whose `description` exceeds `SKILL_DESCRIPTION_MAX_LENGTH`.
 *   - Any SKILL.md missing `name` or `description`.
 *
 * No-op when the source tree is absent (test workspaces / partial-clone
 * scenarios). Memoised per workspace dir + skill-tree fingerprint so
 * repeated SkillsCompiler constructions in the same process don't pay
 * the walk cost twice; tests that mutate source between constructions
 * get fresh validation because the fingerprint shifts.
 *
 * Exported for tests that exercise the failure paths in isolation.
 */
export function validateBuiltinSkillSourceTree(skillsRoot: string): void {
  if (!existsSync(skillsRoot)) return;
  const fingerprint = computeSkillTreeFingerprint(skillsRoot);
  const cached = validatedTreeCache.get(skillsRoot);
  if (cached === fingerprint) return;
  for (const slug of listBuiltinSlugs(skillsRoot)) {
    if (!isValidSkillSlug(slug)) {
      throw new Error(
        `skills_compiler.invalid_slug: ${slug} (expected [a-z0-9-]{1,64})`,
      );
    }
    const skillDir = resolveBuiltinSkillDir(skillsRoot, slug);
    const skillMdPath = join(skillDir, "SKILL.md");
    if (!existsSync(skillMdPath)) continue; // skip slugs that ship only a variant
    const primaryContent = readFileSync(skillMdPath, "utf-8");
    const primaryFm = parseSkillFrontmatter(primaryContent);
    // Stub primary (no frontmatter) — treat the whole skill as a test
    // scaffold and skip its variants too. Production builds always have
    // proper frontmatter; the fingerprint cache picks up any future
    // primary-content fix automatically.
    if (!primaryFm.name && !primaryFm.description) continue;
    if (!primaryFm.name) {
      throw new Error(
        `skills_compiler.missing_frontmatter_name: ${slug}/SKILL.md`,
      );
    }
    if (!primaryFm.description) {
      throw new Error(
        `skills_compiler.missing_frontmatter_description: ${slug}/SKILL.md`,
      );
    }
    if (primaryFm.description.length > SKILL_DESCRIPTION_MAX_LENGTH) {
      throw new Error(
        `skills_compiler.description_too_long: ${slug}/SKILL.md `
          + `(${primaryFm.description.length} > ${SKILL_DESCRIPTION_MAX_LENGTH})`,
      );
    }
    // Variant validation — only run when the primary is well-formed. Each
    // variant is shipped to the model the same way the primary is, so the
    // same description-length cap applies. Variants that are stub
    // sentinels in tests are caught by the primary-stub short-circuit
    // above (this loop never runs for those).
    const entries = readdirSync(skillDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      if (!name.startsWith("SKILL.") || !name.endsWith(".md")) continue;
      if (name === "SKILL.base.md") continue; // base partial — frontmatter optional
      const variantContent = readFileSync(join(skillDir, name), "utf-8");
      const variantFm = parseSkillFrontmatter(variantContent);
      if (!variantFm.name || !variantFm.description) {
        throw new Error(
          `skills_compiler.variant_missing_frontmatter: ${slug}/${name}`,
        );
      }
      if (variantFm.description.length > SKILL_DESCRIPTION_MAX_LENGTH) {
        throw new Error(
          `skills_compiler.description_too_long: ${slug}/${name} `
            + `(${variantFm.description.length} > ${SKILL_DESCRIPTION_MAX_LENGTH})`,
        );
      }
    }
  }
  validatedTreeCache.set(skillsRoot, fingerprint);
}

const validatedTreeCache = new Map<string, string>();

function computeSkillTreeFingerprint(skillsRoot: string): string {
  // mtime-only fingerprint over SKILL*.md files: enough to bust the
  // cache on a source-tree edit between constructions without paying
  // the cost of a full content hash. Tests that mutate files within
  // the same millisecond should call SkillsCompiler.invalidateValidator()
  // — but in practice the millisecond resolution suffices.
  const parts: string[] = [];
  for (const slug of listBuiltinSlugs(skillsRoot).sort()) {
    const skillDir = resolveBuiltinSkillDir(skillsRoot, slug);
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(skillDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile()) continue;
      const name = e.name;
      if (!name.startsWith("SKILL") || !name.endsWith(".md")) continue;
      try {
        const stat = statSync(join(skillDir, name));
        parts.push(`${slug}/${name}:${stat.mtimeMs}:${stat.size}`);
      } catch { /* ignore */ }
    }
  }
  return parts.join("|");
}

/**
 * Return the backend-specific dotfile namespace name for a given backend's
 * skill directory, **without** the trailing `skills` segment — callers
 * join `skills` themselves. Returns `null` only for Claude (which is
 * dispatched through `materializeClaudeSession` and writes
 * `<sessionDir>/.claude/skills/` directly).
 *
 * docs/design/appendices/skills-unification.md Phase 1 — every non-Claude backend now writes
 * to its own brand-aligned namespace:
 *   - `codex`    → `.codex`
 *   - `gemini`   → `.gemini`
 *   - `opencode` → `.opencode` (V2 path (c); flipped from prior `.claude/`
 *                  redundancy-avoiding alias).
 */
export function cliSkillsDirName(backendId: BackendId): string | null {
  switch (backendId) {
    case "codex": return ".codex";
    case "gemini": return ".gemini";
    case "opencode": return ".opencode";
    default: return null;
  }
}

/**
 * Return the CLI instruction-file name for a given backend. Codex and
 * OpenCode both auto-discover `AGENTS.md` from cwd; Gemini reads
 * `GEMINI.md`. Throws for `claude` — the Claude SDK consumes a per-cwd
 * `CLAUDE.md` written by `materializeClaudeSession`, not an instruction
 * file from this helper.
 *
 * Single helper so the choice is consistent between the wide
 * `materializeCliSession` and the slim `materializeFetchWindowCliSession`
 * paths (docs/design/appendices/fetch-window-cost-reduction.md §4.5.7).
 */
export function cliInstructionFileName(
  backendId: Exclude<BackendId, "claude">,
): "AGENTS.md" | "GEMINI.md" {
  switch (backendId) {
    case "codex":
    case "opencode":
      return "AGENTS.md";
    case "gemini":
      return "GEMINI.md";
  }
}

/**
 * Session instruction files the live-overwrite path (design §15.6.1 /
 * §15.9) walks when the owner PATCHes `character` mid-session. Each file
 * corresponds to a backend (CLAUDE.md = Claude Code SDK, AGENTS.md =
 * Codex CLI, GEMINI.md = Gemini CLI). A workdir that has already seen a
 * heavy-tier fallback can contain two of these side-by-side — see
 * CLAUDE.md "Fallback re-materialization".
 */
const CHARACTER_INSTRUCTION_FILES = [
  "CLAUDE.md",
  "AGENTS.md",
  "GEMINI.md",
] as const;

/**
 * Rewrite the `## Character (user-defined)` block inside every backend
 * instruction file that currently lives in `workdir`. Used by the
 * `PATCH /api/config` live-overwrite path (§15.6.1) so an owner editing
 * character on the dashboard doesn't have to wait for the next session
 * spawn for the change to land.
 *
 * Multi-backend aware: a workdir that has seen a Claude→Codex fallback
 * contains both CLAUDE.md and AGENTS.md, and both must end up byte-
 * identical in their character block. Each write is atomic (tmp +
 * rename, both on the same filesystem so rename stays cheap) and
 * per-file errors are logged without failing the whole call.
 *
 * Returns a summary of how many files were rewritten. Useful for
 * instrumentation and for the dashboard PATCH handler to log.
 *
 * The helper is an FS wrapper: its pure parse/compose half lives in
 * `character-block.ts` and is covered 100% there. This side is excluded
 * from coverage along with the rest of `skills-compiler.ts`.
 */
export function rewriteCharacterBlock(
  workdir: string,
  character: string,
): { rewritten: number; skipped: number; failed: number } {
  const summary = { rewritten: 0, skipped: 0, failed: 0 };
  const targets: string[] = CHARACTER_INSTRUCTION_FILES.map((name) =>
    join(workdir, name),
  );
  // docs/design/appendices/opencode-backend.md §6.5 — opencode also carries the character
  // block inside `.opencode/agent/<slug>.md` (the per-process persona
  // body). Walk the dir so a mid-session character PATCH lands on every
  // active opencode agent file (typically one per workdir). Defensive
  // existence check below — a non-opencode workdir simply has no
  // `.opencode/agent/` dir and contributes zero rewrites.
  const opencodeAgentDir = join(workdir, ".opencode", "agent");
  if (existsSync(opencodeAgentDir)) {
    try {
      for (const entry of readdirSync(opencodeAgentDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          targets.push(join(opencodeAgentDir, entry.name));
        }
      }
    } catch (err) {
      logger.warn(
        { err, opencodeAgentDir },
        "rewriteCharacterBlock failed to enumerate opencode agent dir",
      );
    }
  }
  for (const target of targets) {
    if (!existsSync(target)) {
      summary.skipped++;
      continue;
    }
    try {
      const current = readFileSync(target, "utf-8");
      const next = applyCharacterBlockRewrite(current, character);
      if (next === current) {
        summary.skipped++;
        continue;
      }
      // `.tmp` lives next to the target so the rename stays on one
      // filesystem (design R1 mitigation).
      const tmp = `${target}.tmp`;
      writeFileSync(tmp, next, "utf-8");
      renameSync(tmp, target);
      summary.rewritten++;
    } catch (err) {
      // Per-file logging so a partial failure (e.g. CLAUDE.md written,
      // AGENTS.md EACCES) is recoverable post-hoc — the outer PATCH
      // handler only sees aggregate totals.
      logger.warn(
        { err, target },
        "rewriteCharacterBlock failed to update instruction file",
      );
      summary.failed++;
    }
  }
  return summary;
}

function renderCliInstructionFile(params: SessionInstructionParams): string {
  const toolName = cliInstructionFileName(params.backendId);
  const parts: string[] = [
    `# ${APP_NAME} ${toolName}`,
    "",
    `Process key: \`${params.processKey}\``,
    `Profile: \`${params.profileName}\``,
    "",
  ];

  // Safety invariants at top level for prominence — CLI backends don't
  // have a separate project-instruction layer, so burying safety inside
  // the profile section risks it being overlooked by weaker models.
  if (params.safetyContent) {
    parts.push(params.safetyContent, "");
  }

  // User-defined character sits immediately after safety so it strictly
  // outranks every profile / skill / task-flow layer below it, and
  // strictly below safety (design §15.4.2 / §15.5).
  if (params.characterBlock) {
    parts.push(params.characterBlock, "");
  }

  // DELEGATED-MODE-V2-DESIGN.md §4.3.4 — same-backend integration deny block.
  // Sits right after character / safety (above behavioral rules + skills) so
  // weak models cannot miss it. For Codex this is the only enforcement
  // surface; for Gemini it duplicates the admin-policy hard-deny.
  if (params.sameBackendDenyBlock) {
    parts.push(params.sameBackendDenyBlock, "");
  }

  // Output-language pointer paragraph (design `output-language-policy.md`
  // §13.3). Identical byte-for-byte across CLAUDE.md / AGENTS.md /
  // GEMINI.md — declarative only, never inlines the current
  // `primaryLanguage` (that lives in the per-turn XML and would go
  // stale here on a PATCH /api/config mid-session).
  parts.push(renderOutputLanguagePolicyPointer(), "");

  // Behavioral rules that Claude Code receives via system prompt append but
  // CLI backends don't have a system prompt layer for.
  parts.push(
    "## Behavioral rules",
    "",
    "- WhatsApp outbound messages are prefixed by the daemon. Do not add that prefix yourself unless the user explicitly asks.",
    "",
  );

  // Daemon-API usage hoisted ABOVE the skills (was: appended at the end
  // of the file). Skill bodies inline below carry hundreds of `curl
  // http://localhost:8321/api/...` examples; for Codex specifically those
  // examples target endpoints that return 401 because Codex does not
  // hold the read-sensitive token. Surfacing the constraint up-front
  // gives the agent the routing rule before it reads the first skill.
  // For Gemini / Claude the section is informational; the position is
  // kept consistent so the rendered file shape is uniform.
  parts.push(
    renderDaemonApiUsageSection(params.backendId !== "codex"),
    "",
  );

  // docs/design/appendices/skills-unification.md Phase 1 §R2 — preamble + `<skill-index>`
  // sit after Character (already emitted above) and **before** the
  // Runtime profile (which carries the integration routing table
  // substitution). Codex / Gemini only — `skillPreamble` and
  // `skillIndexBlock` are `null` for OpenCode (R3) so the section is
  // suppressed entirely and the `## Skills` slug manifest below holds.
  if (params.skillPreamble) {
    parts.push(params.skillPreamble.trim(), "");
  }
  if (params.skillIndexBlock) {
    parts.push(params.skillIndexBlock, "");
  }

  parts.push(
    "## Runtime profile",
    "",
    params.profileContent.trim(),
    "",
  );

  // docs/design/appendices/skills-unification.md Phase 1 §R3 — the `## Skills` slug manifest
  // only fires for OpenCode (no `<skill-index>` block; cwd auto-discovery
  // already enumerates the skills, but the manifest pins the per-turn
  // active set so the agent doesn't grab unrelated user skills). Codex /
  // Gemini suppress this section since their `<skill-index>` above already
  // serves as the canonical listing — duplicating it here would risk the
  // agent mistaking the manifest for the authoritative path source.
  if (!params.skillIndexBlock) {
    parts.push("## Skills", "");
    if (params.skillSlugs.length === 0) {
      parts.push("No process-scoped built-in skills were selected for this turn.", "");
    } else {
      parts.push(
        "Active built-in skills for this turn (cwd auto-discovery loads them):",
        "",
      );
      for (const slug of params.skillSlugs) {
        parts.push(`- \`${slug}\``);
      }
      parts.push("");
    }
    parts.push(
      "User-authored skills may also be discovered from the same directory.",
    );
  }

  return parts.join("\n");
}

function renderDaemonApiUsageSection(readSensitiveAvailable: boolean): string {
  const lines = [
    "## Daemon API Usage",
    "",
    "- Use plain `curl` for daemon API calls. The daemon prepends a session-local wrapper on PATH.",
    "- Never use absolute curl paths, alternative HTTP clients, connection overrides, or custom auth headers.",
  ];

  if (readSensitiveAvailable) {
    lines.push(
      "- The wrapper auto-attaches session auth for read-sensitive endpoints.",
    );
  } else {
    lines.push(
      "",
      "### Read-sensitive endpoints are UNAVAILABLE on this backend",
      "",
      "Codex sessions do not receive the read-sensitive daemon token. The",
      "wrapper still prepends headers it can supply, but the daemon answers",
      "personal-data reads with `401 Unauthorized` regardless. Endpoints",
      "below are affected; the per-skill `SKILL.md` files under",
      "`.codex/skills/<name>/` listed in `<skill-index>` describe them as if",
      "they were available — treat their `curl /api/*` examples as a",
      "contract you cannot satisfy on this backend.",
      "",
      "- Context vault: `GET /api/context/*`, `GET /api/context/list/*`",
      "- Mail (multi-provider): `GET /api/mail/*` (read), search, providers",
      "- Calendar (direct mode): `GET /api/calendar/*`",
      "- Notion (direct mode): `GET /api/notion/{query,search,pages}`",
      "- Obsidian: `GET /api/obsidian/*`",
      "- Observations: `GET /api/observations`",
      "- Reading list / receipts / travel bookings",
      "",
      "If a skill body directs you at one of these reads, stop and tell",
      "the user the task needs a different backend (Claude or Gemini).",
      "Do not hammer the endpoint — the 401 is permanent for this",
      "session, not transient. Writes and autonomous-tier endpoints",
      "stay reachable; the gate is read-sensitive scope only.",
    );
  }

  return lines.join("\n");
}

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
 * docs/design/appendices/skills-unification.md Phase 1 — parse the `name` and `description`
 * single-line YAML scalars out of a SKILL.md frontmatter block. Returns
 * `{ name: null, description: null }` when no frontmatter is present or
 * neither key is set. Multi-line block scalars (`description: |` /
 * `description: >`) are rejected at the regex level — the schema enforces
 * single-line scalars across all backends (R6).
 */
export function parseSkillFrontmatter(content: string): {
  name: string | null;
  description: string | null;
} {
  if (!content.startsWith("---")) return { name: null, description: null };
  const endIdx = content.indexOf("\n---", 3);
  if (endIdx < 0) return { name: null, description: null };
  const fm = content.slice(4, endIdx);
  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  const descMatch = fm.match(/^description:\s*(.+)$/m);
  return {
    name: nameMatch ? nameMatch[1].trim() : null,
    description: descMatch ? descMatch[1].trim() : null,
  };
}

/**
 * docs/design/appendices/skills-unification.md Phase 1 §R5 — hard upper bound on a
 * SKILL.md `description` scalar. Enforced at SkillsCompiler construction
 * for built-in skills (refuses to boot on violation) and at
 * `PUT /api/skills/<slug>` for user-authored skills (HTTP 400). Sized to
 * fit the model's selection decision without pinning enough prose to
 * encode body content.
 */
export const SKILL_DESCRIPTION_MAX_LENGTH = 280;

/**
 * docs/design/appendices/skills-unification.md Phase 1 §"Codex read-sensitive banner
 * inheritance" — endpoints flagged `RiskTier.ReadSensitive` by
 * `safety/risk-classifier.ts` that a Codex session cannot satisfy (no
 * read-sensitive token). Any SKILL.md whose body references one of these
 * prefixes triggers a one-line banner prepend on the Codex copy. Listed
 * literally (not derived from `API_RISK` at module-load time) so the
 * core/skills-compiler module stays independent of safety/risk-classifier
 * — a circular import would invert the bootstrap order.
 *
 * Drift guard: `skills-compiler.test.ts` pins this list against the
 * RiskTier.ReadSensitive GET-prefix set in `risk-classifier.ts` so a new
 * read-sensitive endpoint added to API_RISK surfaces here at test time
 * instead of as silent 401 retries in a future Codex session.
 *
 * Exported for the drift-guard regression test only — production code
 * MUST use {@link skillBodyTouchesReadSensitive} to keep the
 * "literal prefix" decision encapsulated.
 */
export const READ_SENSITIVE_API_PREFIXES = [
  "/api/apple-calendar",
  "/api/books",
  "/api/calendar",
  "/api/context",
  "/api/entities",
  "/api/mail",
  "/api/mcp/servers",
  "/api/notion",
  "/api/observations",
  "/api/obsidian",
  "/api/receipts",
  "/api/travel-bookings",
] as const;

function skillBodyTouchesReadSensitive(skillBody: string): boolean {
  return READ_SENSITIVE_API_PREFIXES.some((prefix) =>
    skillBody.includes(prefix),
  );
}

const CODEX_READ_SENSITIVE_BANNER_HEADER = "<!-- codex-read-sensitive-banner -->";
const CODEX_READ_SENSITIVE_BANNER = [
  CODEX_READ_SENSITIVE_BANNER_HEADER,
  "> NOTE (Codex session): Some endpoints in this skill are read-sensitive and",
  "> return 401 here. See `## Read-sensitive endpoints are UNAVAILABLE` in",
  "> AGENTS.md before invoking. Do not retry on 401 — stop and notify the user.",
  "",
].join("\n");

/**
 * docs/design/appendices/skills-unification.md Phase 1 §"Codex read-sensitive banner
 * inheritance" — prepend the 3-line caveat banner to a Codex skill body
 * whose contents reference any read-sensitive `/api/*` endpoint. The
 * banner sits immediately after the YAML frontmatter (so the frontmatter
 * parser on the agent side still picks up `name`/`description`/
 * `allowed-tools` first) and is idempotent — re-running on an already-
 * banner-bearing file is a no-op (the HTML-comment sentinel lets us
 * detect prior insertion without false positives from user prose).
 *
 * No-op when:
 *  - The skill body references zero read-sensitive endpoints.
 *  - The banner is already present (sentinel hit).
 */
function prependCodexReadSensitiveBanner(skillMdPath: string): void {
  if (!existsSync(skillMdPath)) return;
  const content = readFileSync(skillMdPath, "utf-8");
  if (!skillBodyTouchesReadSensitive(content)) return;
  if (content.includes(CODEX_READ_SENSITIVE_BANNER_HEADER)) return;
  if (!content.startsWith("---")) {
    writeFileSync(skillMdPath, CODEX_READ_SENSITIVE_BANNER + content, "utf-8");
    return;
  }
  const fmCloseIdx = content.indexOf("\n---", 3);
  if (fmCloseIdx < 0) {
    writeFileSync(skillMdPath, CODEX_READ_SENSITIVE_BANNER + content, "utf-8");
    return;
  }
  const afterFm = fmCloseIdx + 4; // include `\n---`
  // Skip a single trailing newline after `---` so the banner sits on its
  // own line cleanly. If no newline follows, we still emit one before the
  // banner so the prose split is unambiguous.
  const head = content.slice(0, afterFm);
  const tail = content.slice(afterFm).replace(/^\n+/, "");
  writeFileSync(
    skillMdPath,
    `${head}\n\n${CODEX_READ_SENSITIVE_BANNER}${tail ? `\n${tail}` : ""}`,
    "utf-8",
  );
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
function loadSkillIndexPreamble(workspaceDir: string): string {
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
  if (backendId === "claude" || backendId === "opencode") return;
  const cliRoot = cliSkillsDirName(backendId);
  if (cliRoot === null) return;
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
 * docs/design/appendices/skills-unification.md Phase 1 §R6 — `adaptSkillForCli` (which used
 * to retain only `name`/`description`/`when_to_use` and strip
 * `allowed-tools` from CLI-bound copies) is deleted. The source
 * SKILL.md frontmatter is byte-identical across all backends post-
 * materialisation. Codex / Gemini tolerate unknown YAML keys; OpenCode's
 * permissive frontmatter parser does too (verified against
 * `docs/design/appendices/opencode-backend.md` §5.5). The `when_to_use:` field has been
 * dropped from every built-in SKILL.md (Phase 0.1 of the sister doc) so
 * there is no per-backend fork to maintain.
 */

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
    "Do NOT invoke them in any flow — including hourly check, morning routine,",
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
    "NOT invoke them in any flow — including hourly check, morning routine,",
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
 * chokepoint (DELEGATED-MODE-V2-DESIGN.md §4.3.2; the legacy `/invoke`
 * RPC was retired 2026-05-01). For same-backend native MCP it is
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

/**
 * Remove any built-in skill directory under `destRoot` whose slug is not
 * in `keep`. Recognises a directory as a built-in by its presence under
 * the source `agent-assets/skills/` tree — anything else (user-authored
 * skill, accounts.md, etc.) is left alone, since `syncAllUserSkills` is
 * the canonical writer for those.
 *
 * Idempotent and side-effect-free when there is nothing to prune.
 * Exported for unit testing only.
 */
export function pruneStaleBuiltinSkillDirs(
  destRoot: string,
  sourceSkillsRoot: string,
  keep: readonly string[],
): void {
  if (!existsSync(destRoot)) return;
  if (!existsSync(sourceSkillsRoot)) return;
  const keepSet = new Set(keep);
  // `listBuiltinSlugs` recurses one level into category subdirs (e.g.
  // WIKI_BUILDER_DESIGN.md §9.1 `wiki/`) so wiki slugs are recognised
  // as built-ins for prune purposes even though their source dir is
  // nested. Destination layout stays flat — `<destRoot>/<slug>/` for
  // every slug regardless of source category.
  const builtinSlugs = new Set(listBuiltinSlugs(sourceSkillsRoot));
  for (const entry of readdirSync(destRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!builtinSlugs.has(entry.name)) continue;
    if (keepSet.has(entry.name)) continue;
    rmSync(join(destRoot, entry.name), { recursive: true, force: true });
  }
}

function readTreeFiles(root: string): SkillCompilerFile[] {
  if (!existsSync(root)) {
    return [];
  }

  const files: SkillCompilerFile[] = [];
  for (const relPath of walkTree(root)) {
    const absPath = join(root, relPath);
    const stat = statSync(absPath);
    files.push({
      path: relPath,
      content: readFileSync(absPath, "utf-8"),
      updatedAt: stat.mtime.toISOString(),
    });
  }
  return files;
}

function walkTree(root: string, current = root): string[] {
  if (!existsSync(current)) {
    return [];
  }

  const entries = readdirSync(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absPath = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTree(root, absPath));
      continue;
    }
    files.push(relative(root, absPath));
  }
  return files.sort();
}
