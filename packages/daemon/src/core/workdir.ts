/**
 * WorkdirManager — creates working directories for agent sessions.
 *
 * The Agent SDK reads `CLAUDE.md` and `.claude/skills/` from the `cwd` passed
 * to `query()`, and stores session history per-cwd in `~/.claude/projects/`.
 *
 * Two directory strategies:
 *
 * 1. **Per-session persistent dirs** (for conversations that may resume):
 *    Path: `<dataDir>/agent-sessions/<dbSessionId>/`
 *    Created on first execute, reused on resume, cleaned up on session close.
 *    The deterministic path ensures execute() and executeResume() share the
 *    same cwd, so the SDK can find the session history.
 *
 * 2. **Disposable temp dirs** (for one-shot light-tier events):
 *    Path: `/tmp/pa-<random>/`
 *    Created per-call, deleted immediately after.
 */

import {
  mkdirSync,
  cpSync,
  existsSync,
  rmSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import type DatabaseNs from "better-sqlite3";

import type {
  BackendId,
  IntegrationKey,
  IntegrationState,
  ProcessKey,
} from "@aitne/shared";
import {
  DASHBOARD_CHAT_SCOPE,
  OWNER_DM_SCOPE,
} from "../messaging/constants.js";
import { createLogger } from "../logging.js";
import { SkillsCompiler } from "./skills-compiler.js";
import {
  EMPTY_MAIL_ACCOUNTS_MD,
  renderMailAccountsMd,
} from "./skills-compiler-tree.js";
import { refreshSkillIndexBlock } from "./skills-compiler-skill-index.js";
import {
  getProfileForEvent,
  resolveSkillManifest,
  resolveSkillManifestForProcess,
} from "./skills-manifest.js";
import { ensureDaemonApiCli } from "./daemon-api-cli.js";
import {
  computeInstructionAssetStatus,
  readInstructionStampManifest,
  sessionInstructionAssetsStale,
  writeInstructionAssetStamp,
} from "./release-assets.js";

const logger = createLogger("workdir");

export { getProfileForEvent, getSkillsForEvent } from "./skills-manifest.js";

/**
 * Name of the manifest file (under `{sessionDir}/.claude/skills/`) that
 * tracks which subdirectories inside `.claude/skills/` were placed there by
 * `syncUserSkills` — i.e. which slugs are "user-managed" vs. built-ins.
 *
 * The leading dot makes it a hidden file that Claude Code's skill loader
 * ignores during discovery (it only picks up directories containing
 * `SKILL.md`), so the manifest doesn't pollute the agent's skill list.
 */
const USER_SKILLS_MANIFEST = ".user-skills.json";

function readUserSkillsManifest(destSkillsDir: string): string[] {
  const path = join(destSkillsDir, USER_SKILLS_MANIFEST);
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((x): x is string => typeof x === "string")) {
      return parsed;
    }
  } catch {
    // Corrupt manifest — treat as empty; sync will regenerate it
  }
  return [];
}

function writeUserSkillsManifest(destSkillsDir: string, slugs: string[]): void {
  const path = join(destSkillsDir, USER_SKILLS_MANIFEST);
  writeFileSync(path, JSON.stringify(slugs), "utf-8");
}

/**
 * Discover valid user-skill slugs under `userSkillsDir` — each must be a
 * subdirectory containing a `SKILL.md`.
 */
function discoverUserSkillSlugs(userSkillsDir: string): string[] {
  if (!existsSync(userSkillsDir)) return [];
  try {
    return readdirSync(userSkillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(userSkillsDir, e.name, "SKILL.md")))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Reconcile the session workdir's user-authored skill set with the source
 * at `userSkillsDir`.
 *
 * Idempotent and cheap — safe to call on every message. Uses a manifest
 * file (`.user-skills.json`) inside the session's `.claude/skills/` dir to
 * track which subdirectories this function manages, so built-ins copied by
 * `ensureSessionWorkdir` (via SKILL_SETS) are never touched.
 *
 * Behaviour:
 *   • A slug present in source but missing from manifest → copy it in,
 *     unless a directory already exists there (which must be a built-in
 *     with the same name — the API blocks this case but we defend anyway).
 *   • A slug present in both source and manifest → overwrite from source
 *     so mid-session PUTs propagate.
 *   • A slug present in manifest but missing from source → delete from
 *     dest (mid-session DELETEs propagate).
 *
 * Returns a summary for logging.
 */
export function syncUserSkills(
  sessionDir: string,
  userSkillsDir: string,
): { added: number; updated: number; removed: number } {
  return syncUserSkillsInto(sessionDir, userSkillsDir, join(".claude", "skills"));
}

export function syncUserSkillDocs(
  sessionDir: string,
  userSkillsDir: string,
): { added: number; updated: number; removed: number } {
  return syncUserSkillsInto(sessionDir, userSkillsDir, "skills");
}

type SyncResult = { added: number; updated: number; removed: number };

/**
 * Backend-specific skill directories to check for user-skill sync.
 * Only directories that already exist are synced — existence means
 * `materializeSessionBundle` (or `ensureBackendMaterialized`) created
 * them for the target backend.
 *
 * docs/design/appendices/skills-unification.md Phase 1 item 10 — `.opencode/skills/` was
 * added when opencode flipped from path (b) (`.claude/skills/` alias) to
 * path (c) (`.opencode/skills/`). The `.claude/skills/` entry is retained
 * so a workdir that has materialised a Claude main + opencode fallback
 * still gets its user-authored skills synced into both trees.
 */
const SKILL_DIR_ENTRIES: ReadonlyArray<{ key: BackendId; relDir: string }> = [
  { key: "claude",   relDir: join(".claude",   "skills") },
  { key: "opencode", relDir: join(".opencode", "skills") },
  { key: "codex",    relDir: join(".codex",    "skills") },
  { key: "gemini",   relDir: join(".gemini",   "skills") },
];

export function syncAllUserSkills(
  sessionDir: string,
  userSkillsDir: string,
): Record<string, SyncResult> {
  // Always sync the docs layer (skills/ at session root) — CLI backends
  // reference it as a fallback path in the instruction file.
  const results: Record<string, SyncResult> = {
    docs: syncUserSkillDocs(sessionDir, userSkillsDir),
  };

  // Sync to each backend-specific skill directory that already exists.
  // This avoids creating spurious directories (e.g. .claude/skills/ in
  // a Codex-only session). The directory is created by the compiler
  // during materialization; its existence is the signal that the backend
  // needs it.
  for (const { key, relDir } of SKILL_DIR_ENTRIES) {
    const destDir = join(sessionDir, relDir);
    if (existsSync(destDir)) {
      results[key] = syncUserSkillsInto(sessionDir, userSkillsDir, relDir);
      // docs/design/appendices/skills-unification.md Phase 1 §R4 — splice user-authored slugs
      // into the `<skill-index>` block so a freshly added user skill
      // surfaces in Codex/Gemini's AGENTS.md/GEMINI.md listing on the next
      // turn. No-op for Claude (cwd auto-discovery) and OpenCode (R3 —
      // never emits an index block); idempotent for backends whose
      // instruction file is missing or already in sync. Embedded here
      // (not at every caller) so the dispatcher's per-turn syncs
      // (`dispatcher-message-handler.ts` resume + fresh-execute paths)
      // cannot forget to refresh and silently leave the Codex/Gemini
      // index stale after a mid-session `PUT /api/skills`.
      refreshSkillIndexBlock(sessionDir, key);
    }
  }

  return results;
}

function syncUserSkillsInto(
  sessionDir: string,
  userSkillsDir: string,
  destRelativeDir: string,
): { added: number; updated: number; removed: number } {
  const destSkillsDir = join(sessionDir, destRelativeDir);
  // Ensure the dest dir exists — when ensureSessionWorkdir ran, it may have
  // skipped this tree if no built-ins were needed for the event type.
  mkdirSync(destSkillsDir, { recursive: true });

  const previous = readUserSkillsManifest(destSkillsDir);
  const current = discoverUserSkillSlugs(userSkillsDir);

  let added = 0;
  let updated = 0;
  let removed = 0;

  // Remove skills that were previously user-managed but no longer exist in source
  for (const slug of previous) {
    if (current.includes(slug)) continue;
    const destDir = join(destSkillsDir, slug);
    if (existsSync(destDir)) {
      try {
        rmSync(destDir, { recursive: true, force: true });
        removed++;
      } catch (err) {
        logger.warn(
          { err, sessionDir, slug },
          "Failed to remove stale user skill from session workdir",
        );
      }
    }
  }

  // Copy / update current user skills
  for (const slug of current) {
    const srcDir = join(userSkillsDir, slug);
    const destDir = join(destSkillsDir, slug);
    const existedBefore = existsSync(destDir);
    const wasTrackedByUs = previous.includes(slug);

    // Collision guard: if the dest already exists and we DIDN'T put it there,
    // it's a built-in with the same name. Built-ins always win.
    if (existedBefore && !wasTrackedByUs) continue;

    try {
      if (existedBefore) {
        rmSync(destDir, { recursive: true, force: true });
      }
      cpSync(srcDir, destDir, { recursive: true });
      if (existedBefore) {
        updated++;
      } else {
        added++;
      }
    } catch (err) {
      logger.warn(
        { err, sessionDir, slug },
        "Failed to sync user skill into session workdir",
      );
    }
  }

  // Write manifest (always, even if nothing changed, so a corrupt or missing
  // manifest gets repaired on the next call).
  try {
    writeUserSkillsManifest(destSkillsDir, current);
  } catch (err) {
    logger.warn(
      { err, sessionDir },
      "Failed to write user-skills manifest",
    );
  }

  return { added, updated, removed };
}

/**
 * Create a disposable temp directory for one-shot events.
 * Caller must call `cleanupSessionWorkdir()` after use.
 *
 * @param projectRoot - Workspace root containing `agent-assets/skills/`
 * @param eventType - Selects SKILL_SET and agent profile
 * @param userSkillsDir - Optional path to `{dataDir}/skills/`; if provided,
 *   every user-authored skill is copied into the workdir
 */
export function createSessionWorkdir(
  projectRoot: string,
  eventType: string,
  userSkillsDir?: string,
  options?: {
    backendId?: BackendId;
    processKey?: ProcessKey;
    configuredServices?: ReadonlySet<string>;
    mailAccounts?: readonly import("../services/mail/provider.js").MailAccount[];
    integrations?: Partial<Record<IntegrationKey, IntegrationState>>;
    /** User-defined character / persona (design §15). Empty = no block. */
    character?: string;
    /** P22 — when set, SkillsCompiler runs the curation anchor splicer
     *  during materialization so each skill's CURATION anchors resolve to
     *  the active overlay (or seed) JSON. */
    skillCurationDataDir?: string;
    /** WIKI_BUILDER_DESIGN.md §P5.C — per-event wiki workspace name for
     *  `{{vault_path}}` / `{{language}}` / `{{workspace_name}}` /
     *  `{{schema_version}}` token substitution in skill bodies and the
     *  wiki-agent profile. Undefined falls back to the default workspace. */
    wikiWorkspaceName?: string;
    /** `evening-review-slimdown.md` §2.1 — runtime context root consulted
     *  by `resolveSkillManifest`. Production callers thread
     *  `getContextDir(config)` through; tests and tooling may omit it,
     *  in which case the conservative "rulebook inactive" branch wins. */
    contextDir?: string;
    /** docs/design/appendices/skills-improvement.md §9-§11 + §14 — DB handle for the
     *  `gmail-lifestyle` / `managed-tasks` predicates. Undefined →
     *  conservative include. */
    db?: DatabaseNs.Database | null;
    /** Inbound DM message text for the *ForDm trigger-phrase fallback.
     *  Undefined / null for routine and scheduled events. */
    messageText?: string | null;
    /** AGENT_DEFINITIONS_DESIGN.md §4.2 — the firing Agent's `tools.skills`,
     *  composed onto the process-key bundle by `materializeSessionBundle`
     *  (union, or replace when `skillsReplace`). Empty/undefined is a no-op.
     *  This disposable path is the ONLY one that carries the override —
     *  every Agent firing runs in a fresh temp dir created here. */
    extraSkills?: readonly string[];
    /** AGENT_DEFINITIONS_DESIGN.md §4.2 — `tools.skills_replace`. */
    skillsReplace?: boolean;
  },
): string {
  const sessionId = randomUUID().slice(0, 8);
  const sessionDir = join(tmpdir(), `pa-${sessionId}`);
  const backendId = options?.backendId ?? "claude";

  try {
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    const compiler = new SkillsCompiler(
      projectRoot,
      options?.configuredServices,
      options?.mailAccounts,
      options?.integrations,
      options?.character,
    );
    if (options?.skillCurationDataDir) {
      compiler.setSkillCurationContext({ dataDir: options.skillCurationDataDir });
    }
    const deployed = compiler.materializeSessionBundle({
      backendId,
      sessionDir,
      eventType,
      processKey: options?.processKey,
      wikiWorkspaceName: options?.wikiWorkspaceName,
      ...(options?.contextDir ? { contextDir: options.contextDir } : {}),
      ...(options?.db !== undefined ? { db: options.db } : {}),
      ...(options?.messageText !== undefined ? { messageText: options.messageText } : {}),
      ...(options?.extraSkills && options.extraSkills.length > 0
        ? { extraSkills: options.extraSkills }
        : {}),
      ...(options?.skillsReplace ? { skillsReplace: true } : {}),
    });
    writeInstructionAssetStamp(
      sessionDir,
      computeInstructionAssetStatus(projectRoot),
      // docs/design/appendices/skills-unification.md Phase 1 item 14 — record the manifest
      // snapshot the workdir was just materialised against. The next
      // `ensureSessionWorkdir` call compares this with the live manifest
      // and re-renders on drift (e.g. evening rulebook activates between
      // turns, manifest now resolves to a different skill set).
      { processKey: options?.processKey ?? eventType, skillSlugs: deployed.skills },
    );
    ensureDaemonApiCli(sessionDir);

    // User skills: every skill the user has authored, regardless of event type.
    // Uses the manifest-backed sync so the initial population is consistent
    // with the per-message sync the dispatcher runs on Opus events.
    let userSync: ReturnType<typeof syncAllUserSkills> | null = null;
    if (userSkillsDir) {
      userSync = syncAllUserSkills(sessionDir, userSkillsDir);
      // docs/design/appendices/skills-unification.md Phase 1 §R4 — splice user-authored
      // slugs into the `<skill-index>` block AFTER they land on disk.
      // No-op for Claude (no instruction file index) and OpenCode (R3 —
      // never gets an index).
      refreshSkillIndexBlock(sessionDir, backendId);
    }

    logger.debug(
      {
        sessionDir,
        eventType,
        processKey: options?.processKey,
        backendId,
        deployed,
        userSync,
        profile: getProfileForEvent(eventType),
      },
      "Session workdir created",
    );
  } catch (err) {
    cleanupSessionWorkdir(sessionDir);
    throw err;
  }

  return sessionDir;
}

/**
 * Ensure a per-session persistent working directory exists.
 *
 * Path is deterministic: `<dataDir>/agent-sessions/<dbSessionId>/`
 * This guarantees that execute() and executeResume() use the same cwd,
 * so the Agent SDK can locate the session history.
 *
 * If the directory already exists (resume case), this is a no-op.
 * Skills and profile are only read at session init, so subsequent calls
 * can safely skip the copy.
 */
/**
 * Stamp file written into the session workdir at the end of a successful
 * custom bang-command materialization. Its presence on the next call is
 * the cue to "reset" the workdir back to manifest defaults — without it
 * the prior turn's narrowed skill set + custom profile body would leak
 * into the regular DM that follows.
 *
 * Removed at the end of a successful reset so subsequent regular DMs
 * take the fast path.
 */
const BANG_COMMAND_STAMP = ".aitne-bang-active";

/**
 * docs/design/appendices/skills-unification.md Phase 1 item 14 — return true when the live
 * manifest the dispatcher is about to materialise diverges from the
 * snapshot recorded in `.aitne-instruction-assets.json`. Three possible
 * verdicts:
 *
 *  - Stamp has no manifest field (pre-Phase-1 stamp): treat as drift so
 *    the workdir upgrades to the new stamp shape on the next dispatch.
 *  - Recorded `processKey` differs OR recorded slug set differs from the
 *    live resolve: drift → force re-materialise.
 *  - Otherwise stable → no-op.
 *
 * Note: the manifest resolver is pure and cheap (no I/O beyond reading a
 * couple of in-memory tables, plus a single existsSync via
 * `evening-review-slimdown` when the gate fires), so calling it on every
 * `ensureSessionWorkdir` invocation is fine. The override path (custom
 * bang commands) bypasses this check because the dispatcher's
 * `options.override` already forces re-materialisation.
 */
function resolveManifestDriftAgainstStamp(
  sessionDir: string,
  eventType: string,
  options: {
    processKey?: ProcessKey;
    override?: { skillSlugs: readonly string[] | null; profileBody: string | null };
    contextDir?: string;
    db?: DatabaseNs.Database | null;
    messageText?: string | null;
  } | undefined,
): boolean {
  if (options?.override) return false; // override path force-rematerialises elsewhere
  const stamp = readInstructionStampManifest(sessionDir);
  if (!stamp) return true; // Pre-Phase-1 stamp → re-materialise to upgrade
  const recordedKey = stamp.processKey;
  const expectedKey = options?.processKey ?? eventType;
  if (recordedKey !== expectedKey) return true;
  const manifestOpts = {
    ...(options?.contextDir ? { contextDir: options.contextDir } : {}),
    ...(options?.db !== undefined ? { db: options.db } : {}),
    ...(options?.messageText !== undefined ? { messageText: options.messageText } : {}),
  };
  const hasManifestOpts = Object.keys(manifestOpts).length > 0;
  // Agent `tools.skills` overrides are NOT composed here: they only ever ride
  // the disposable `createSessionWorkdir` path (one fresh temp dir per Agent
  // firing, never re-checked for drift). The persistent `ensureSessionWorkdir`
  // path — DMs / resumable Opus sessions — is never an Agent firing, so its
  // stamp never carries an extra-skill set and the live resolve below matches.
  const liveSlugs = options?.processKey
    ? resolveSkillManifestForProcess(
        options.processKey,
        hasManifestOpts ? manifestOpts : undefined,
      )
    : resolveSkillManifest(
        eventType,
        hasManifestOpts ? manifestOpts : undefined,
      );
  // The stamp records the EFFECTIVE slug set (post fetch_window narrow /
  // post variant-resolution). The live resolve here returns the manifest
  // BEFORE the per-backend variant narrow, but since the manifest contains
  // the canonical slug set the override doesn't change, comparing on the
  // sorted union is a safe proxy. False-positive drift (re-render when
  // not strictly needed) is acceptable; the cost is one Markdown emit.
  const recordedSorted = [...stamp.skillSlugs].sort();
  const liveSorted = [...liveSlugs].sort();
  if (recordedSorted.length !== liveSorted.length) return true;
  for (let i = 0; i < recordedSorted.length; i++) {
    if (recordedSorted[i] !== liveSorted[i]) return true;
  }
  return false;
}

export function ensureSessionWorkdir(
  projectRoot: string,
  dataDir: string,
  dbSessionId: number,
  eventType: string,
  options?: {
    backendId?: BackendId;
    processKey?: ProcessKey;
    configuredServices?: ReadonlySet<string>;
    mailAccounts?: readonly import("../services/mail/provider.js").MailAccount[];
    integrations?: Partial<Record<IntegrationKey, IntegrationState>>;
    /** User-defined character / persona (design §15). Empty = no block. */
    character?: string;
    /**
     * Per-turn override used by custom messaging bang commands. Forces a
     * full re-materialize of the workdir even when one already exists,
     * because the prior turn's skill set / profile body may have been
     * different (two `!cmd` turns with different configurations, or a
     * regular DM following a `!cmd` turn).
     *
     * `null` for either field falls back to the manifest defaults for
     * that field independently. Passing the override at all is what
     * triggers re-materialization.
     *
     * Note: regular DM turns (no `override` set) also force a
     * re-materialize when `BANG_COMMAND_STAMP` is present from a prior
     * turn — this restores the workdir to manifest defaults so a `!cmd`
     * configuration cannot leak into a subsequent natural DM.
     */
    override?: {
      skillSlugs: readonly string[] | null;
      profileBody: string | null;
    };
    /** WIKI_BUILDER_DESIGN.md §P5.C — see createSessionWorkdir options. */
    wikiWorkspaceName?: string;
    /** `evening-review-slimdown.md` §2.1 — see createSessionWorkdir options. */
    contextDir?: string;
    /** docs/design/appendices/skills-improvement.md §9-§11 + §14 — see createSessionWorkdir options. */
    db?: DatabaseNs.Database | null;
    /** docs/design/appendices/skills-improvement.md §9-§11 + §14 — see createSessionWorkdir options. */
    messageText?: string | null;
    // NOTE: no `extraSkills` here. An Agent's `tools.skills` override only
    // rides the disposable `createSessionWorkdir` path (Agent firings run in a
    // fresh temp dir). The persistent path this function serves — DMs and
    // resumable sessions — is never an Agent firing, so wiring the override
    // here would be dead code plus a latent fallback-asymmetry trap
    // (`prepareSessionDir` re-materialisation does not carry it).
  },
): string {
  const sessionDir = join(dataDir, "agent-sessions", String(dbSessionId));
  const stampPath = join(sessionDir, BANG_COMMAND_STAMP);
  // `wasBangActive` triggers a reset on the next regular DM. The stamp is
  // an absent-or-present boolean — we never read its content.
  const wasBangActive =
    existsSync(sessionDir) && existsSync(stampPath);
  const instructionAssetsStale = sessionInstructionAssetsStale(
    sessionDir,
    projectRoot,
  );
  // docs/design/appendices/skills-unification.md Phase 1 item 14 — manifest-snapshot drift
  // guard. Even when the source assets are byte-identical (asset stamp
  // matches), the manifest can resolve to a different slug set between
  // turns (e.g. evening rulebook activates → `notify` enters scope). The
  // recorded slug set in the stamp file is the per-session checkpoint;
  // a delta forces re-materialisation so `<skill-index>` and the
  // per-backend dir reflect the live manifest.
  const manifestStale = existsSync(sessionDir)
    && resolveManifestDriftAgainstStamp(sessionDir, eventType, options);
  const forceRematerialize =
    !!options?.override
    || wasBangActive
    || instructionAssetsStale
    || manifestStale;

  if (existsSync(sessionDir) && !forceRematerialize) {
    ensureDaemonApiCli(sessionDir);
    if (options?.mailAccounts) {
      refreshSessionMailAccountsMd(sessionDir, options.mailAccounts);
    }
    logger.debug({ sessionDir, dbSessionId }, "Session workdir already exists (pa-api helper refreshed)");
    return sessionDir;
  }

  const backendId = options?.backendId ?? "claude";
  const compiler = new SkillsCompiler(
    projectRoot,
    options?.configuredServices,
    options?.mailAccounts,
    options?.integrations,
    options?.character,
  );

  try {
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    const deployed = compiler.materializeSessionBundle({
      backendId,
      sessionDir,
      eventType,
      processKey: options?.processKey,
      wikiWorkspaceName: options?.wikiWorkspaceName,
      ...(options?.override ? { override: options.override } : {}),
      ...(options?.contextDir ? { contextDir: options.contextDir } : {}),
      ...(options?.db !== undefined ? { db: options.db } : {}),
      ...(options?.messageText !== undefined ? { messageText: options.messageText } : {}),
    });
    writeInstructionAssetStamp(
      sessionDir,
      computeInstructionAssetStatus(projectRoot),
      // docs/design/appendices/skills-unification.md Phase 1 item 14 — manifest snapshot
      // for the per-turn drift guard (see `manifestStale` above).
      { processKey: options?.processKey ?? eventType, skillSlugs: deployed.skills },
    );
    ensureDaemonApiCli(sessionDir);

    // User-authored skills — initial population via the manifest-backed sync
    // so subsequent mid-session calls (from dispatcher) share the same state.
    // CONTEXT_VAULT_REDESIGN_PLAN.md v4 V11 — user skills root moved to
    // `<contextDir>/policies/skills`. We derive from `options.contextDir`
    // when the caller provides it; otherwise fall back to the default
    // `<dataDir>/context/policies/skills` (matches `getContextDir`'s plain
    // vault-mode default). The legacy `<dataDir>/skills` path is dead post
    // CONTEXT_VAULT_REDESIGN — falling back there would resurrect the
    // Obsidian-mode divergence bug v4 V11 fixed.
    const userSkillsDir = join(
      options?.contextDir ?? join(dataDir, "context"),
      "policies",
      "skills",
    );
    const userSync = syncAllUserSkills(sessionDir, userSkillsDir);
    // docs/design/appendices/skills-unification.md Phase 1 §R4 — fold user-authored slugs
    // into the `<skill-index>` block now that they're on disk. Idempotent
    // and inexpensive (single instruction-file rewrite).
    refreshSkillIndexBlock(sessionDir, backendId);

    // Bang-command lifecycle: write the stamp on a successful override turn
    // so the NEXT non-override call detects it and resets. On a successful
    // reset call (no override but stamp existed), drop the stamp so future
    // regular turns take the fast path.
    if (options?.override) {
      writeFileSync(stampPath, "1", "utf-8");
    } else if (wasBangActive) {
      try {
        rmSync(stampPath, { force: true });
      } catch (err) {
        // Stamp removal failure leaves us in a "stamp-stuck" state where
        // future regular turns keep re-materializing. That's wasteful but
        // not incorrect, and the next override turn rewrites it anyway.
        logger.warn(
          { err, sessionDir },
          "Failed to remove bang-command stamp after reset",
        );
      }
    }

    logger.debug(
      {
        sessionDir,
        dbSessionId,
        eventType,
        processKey: options?.processKey,
        backendId,
        deployed,
        userSync,
        rematerialized: forceRematerialize,
        bangResetTurn: !options?.override && wasBangActive,
        instructionAssetsStale,
      },
      "Persistent session workdir created",
    );
  } catch (err) {
    // Failure during a re-materialize would leave the workdir half-written;
    // the caller will retry on the next turn. We don't unconditionally
    // cleanup on the override path because the prior workdir's session
    // history (.claude/projects/*) outside `sessionDir` is the SDK's
    // responsibility, and forcing a remove here would break resume.
    if (!existsSync(sessionDir) || !forceRematerialize) {
      cleanupSessionWorkdir(sessionDir);
    }
    throw err;
  }

  return sessionDir;
}

/**
 * Rewrite `accounts.md` in the mail skill dir of an existing session workdir
 * so mid-session registry mutations (addAccount / removeAccount) reach the
 * agent on the next turn instead of waiting for a session restart. Walks
 * the three possible skill-dir locations (`.claude/skills/mail`,
 * `.codex/skills/mail`, `.gemini/skills/mail`) and rewrites whichever exist
 * — the compiler materializes one per session based on backend.
 *
 * No-op if the mail skill wasn't deployed, or if the accounts list is empty.
 */
function refreshSessionMailAccountsMd(
  sessionDir: string,
  mailAccounts: readonly import("../services/mail/provider.js").MailAccount[],
): void {
  // Both transitions are covered here:
  //  - N→M (M>0): write the populated table.
  //  - N→0: write an explicit empty marker so the agent stops targeting
  //    accounts that no longer exist (otherwise the prior table would
  //    stay cached in the session dir indefinitely).
  //  - 0→N: only works because SkillsCompiler now materializes the `mail`
  //    skill unconditionally — the existsSync check below is truthful on
  //    every session after this change. Sessions created before the fix
  //    keep their pre-fix filtered state until re-materialized.
  const rendered =
    mailAccounts.length === 0
      ? EMPTY_MAIL_ACCOUNTS_MD
      : renderMailAccountsMd(mailAccounts);
  // docs/design/appendices/skills-unification.md Phase 1 — opencode flipped to its own
  // `.opencode/skills/` dir, so the refresh walker must include it.
  for (const root of [".claude", ".opencode", ".codex", ".gemini"] as const) {
    const mailSkillDir = join(sessionDir, root, "skills", "mail");
    if (!existsSync(mailSkillDir)) continue;
    try {
      writeFileSync(join(mailSkillDir, "accounts.md"), rendered, "utf-8");
    } catch (err) {
      logger.warn(
        { err, mailSkillDir },
        "Failed to refresh mail accounts.md in existing session workdir",
      );
    }
  }
}

/**
 * Get the deterministic path for a session workdir (without creating it).
 */
export function getSessionWorkdirPath(dataDir: string, dbSessionId: number): string {
  return join(dataDir, "agent-sessions", String(dbSessionId));
}

/**
 * Remove a session working directory.
 * Safe to call even if the directory doesn't exist.
 */
export function cleanupSessionWorkdir(sessionDir: string): void {
  try {
    rmSync(sessionDir, { recursive: true, force: true });
    logger.debug({ sessionDir }, "Session workdir cleaned up");
  } catch (err) {
    logger.warn({ err, sessionDir }, "Failed to cleanup session workdir");
  }
}

/**
 * Clean up all session workdirs for sessions that are no longer active.
 * Called periodically (e.g., daily cleanup) or on daemon shutdown.
 *
 * @param dataDir - Data directory containing agent-sessions/
 * @param activeSessionIds - Set of DB session IDs that are still active
 */
export function cleanupStaleWorkdirs(
  dataDir: string,
  activeSessionIds: Set<number>,
): number {
  const sessionsRoot = join(dataDir, "agent-sessions");
  if (!existsSync(sessionsRoot)) return 0;

  let cleaned = 0;
  try {
    for (const entry of readdirSync(sessionsRoot)) {
      const id = parseInt(entry, 10);
      if (isNaN(id)) continue;
      if (activeSessionIds.has(id)) continue;

      const dirPath = join(sessionsRoot, entry);
      const stat = statSync(dirPath, { throwIfNoEntry: false });
      if (stat?.isDirectory()) {
        cleanupSessionWorkdir(dirPath);
        cleaned++;
      }
    }
  } catch (err) {
    logger.warn({ err }, "Error during stale workdir cleanup");
  }

  if (cleaned > 0) {
    logger.info({ cleaned }, "Stale session workdirs cleaned up");
  }
  return cleaned;
}

/**
 * Ensure a session workdir contains the instruction files for a specific
 * backend. Called by BackendRouter before executing a fallback backend on
 * a heavy-tier session dir that was originally materialized for a different
 * (main) backend.
 *
 * Idempotent — if the files already exist for this backend, it overwrites
 * with the latest content (which is cheap since the source hasn't changed).
 *
 * `contextDir` is the runtime context root consulted by
 * `resolveSkillManifest` for per-event predicates (today: the evening
 * rulebook gate for `routine.evening_review`). Production callers MUST
 * pass `getContextDir(config, db)` — without it, a fallback re-materialize
 * for evening_review evaluates the gate as "rulebook inactive" and drops
 * `notify` from the fallback backend's manifest even when the operator's
 * `policies/routines/evening.md` is active, breaking the contract that the
 * fallback backend behaves identically to the main one
 * (`evening-review-slimdown.md` §3.5).
 */
export function ensureBackendMaterialized(
  projectRoot: string,
  sessionDir: string,
  backendId: BackendId,
  eventType: string,
  processKey?: ProcessKey,
  configuredServices?: ReadonlySet<string>,
  mailAccounts?: readonly import("../services/mail/provider.js").MailAccount[],
  integrations?: Partial<Record<IntegrationKey, IntegrationState>>,
  character?: string,
  wikiWorkspaceName?: string,
  contextDir?: string,
  db?: DatabaseNs.Database | null,
  messageText?: string | null,
): void {
  const compiler = new SkillsCompiler(
    projectRoot,
    configuredServices,
    mailAccounts,
    integrations,
    character,
  );
  const deployed = compiler.materializeSessionBundle({
    backendId,
    sessionDir,
    eventType,
    processKey,
    wikiWorkspaceName,
    ...(contextDir ? { contextDir } : {}),
    ...(db !== undefined ? { db } : {}),
    ...(messageText !== undefined ? { messageText } : {}),
  });
  writeInstructionAssetStamp(
    sessionDir,
    computeInstructionAssetStatus(projectRoot),
    // docs/design/appendices/skills-unification.md Phase 1 item 14 — also captured on the
    // fallback re-materialisation path so the per-turn drift guard
    // remains correct across (main, fallback) backend pairs.
    { processKey: processKey ?? eventType, skillSlugs: deployed.skills },
  );
  ensureDaemonApiCli(sessionDir);
  // docs/design/appendices/skills-unification.md Phase 1 §R4 — fold any already-synced user
  // skills (from prior turns on this workdir) into the freshly rendered
  // `<skill-index>` block. No-op on a clean dir with zero user skills.
  refreshSkillIndexBlock(sessionDir, backendId);
  logger.debug(
    { sessionDir, backendId, eventType, processKey, deployed },
    "Ensured backend instruction files in session workdir",
  );
}

/**
 * Validate that every delegated-mode skill AND task-flow variant required by
 * the currently-stored integration state exists on disk. Returns the missing
 * paths split by kind — both arrays empty means "all good."
 *
 * Called at daemon startup after integration state is loaded. Also used by
 * the PATCH pre-commit check and by `/health.integrationModes.<key>` to
 * surface the gap before the agent ever activates the missing variant.
 */
export function validateDelegatedStartup(
  projectRoot: string,
  integrations: Partial<Record<IntegrationKey, IntegrationState>>,
): { skills: string[]; taskFlows: string[] } {
  const compiler = new SkillsCompiler(projectRoot, new Set(), [], integrations);
  return compiler.validateDelegatedVariants();
}

/**
 * Resolve the ProcessKey that a DM conversation-session scope uses. Kept in
 * sync with `Dispatcher.execute` — both dashboard_chat and owner_dm currently
 * dispatch through ProcessKeys that map to the `message.received.dm` event
 * type in the skills manifest. Returning the right key lets mid-session
 * skill refreshes pick up the same bundle the next DM turn will use, instead
 * of defaulting to the generic event type.
 */
export function processKeyForDmScope(scope: string): ProcessKey {
  if (scope === DASHBOARD_CHAT_SCOPE) return "dashboard.chat";
  if (scope === OWNER_DM_SCOPE) return "message.dm";
  // Unknown scope — fall through to the owner DM processKey so the skill
  // bundle still resolves. This shouldn't happen because call sites filter
  // by scope before invoking, but keeping the default conservative avoids
  // silently skipping refresh on scope additions we haven't thought about.
  return "message.dm";
}

export interface DmSessionRef {
  id: number;
  backend: BackendId | null;
  scope: string;
}

export interface RefreshDmSessionWorkdirsParams {
  projectRoot: string;
  dataDir: string;
  sessions: readonly DmSessionRef[];
  configuredServices: ReadonlySet<string>;
  mailAccounts: readonly import("../services/mail/provider.js").MailAccount[];
  /**
   * Current integration state, threaded through to the per-session
   * `SkillsCompiler` so the rebaked skill bodies pick up the right
   * `SKILL.delegated.<backend>.md` variant for non-proxied integrations
   * AND so `applyAllDeniedToolsForSkill` re-emits the soft-deny prose for
   * any deniedTools the user has configured. Required (not optional) so
   * callers can't silently drop the field and re-introduce the latent
   * staleness bug — passing an empty object is fine for callers that
   * truly have no integration context, but the choice has to be explicit.
   */
  integrations: Partial<Record<IntegrationKey, IntegrationState>>;
  /**
   * User-defined character / persona (design §15). Threaded through so a
   * re-materialized workdir keeps the Character block the owner had
   * configured — without it, a mid-session refresh would wipe the block
   * from every active DM session.
   */
  character: string;
  /**
   * Session ids to skip — intended for:
   * - ids already marked stale (their workdir will be abandoned on the next
   *   turn; refreshing it is pure waste),
   * - future-proofing for in-flight ids if/when the dispatcher exposes them.
   */
  skip?: ReadonlySet<number>;
}

export interface RefreshDmSessionWorkdirsResult {
  eligible: number;
  refreshed: number;
  skippedStale: number;
  skippedMissing: number;
  failed: number;
}

/**
 * Re-materialize every active DM session workdir so the next turn picks up
 * the current mail scope, integration state, and per-backend instruction
 * file without tearing down its SDK session. Triggered by
 * {@link MailAccountRegistry}'s `onScopeChanged` hook AND by
 * `applyIntegrationModeChange` (DELEGATED-PROXY-API-DESIGN.md Phase F §4.8).
 *
 * Caveat: this overwrites `CLAUDE.md`/`AGENTS.md`/`GEMINI.md` and the
 * backend-specific skill directories. If a DM turn is currently executing
 * in the target workdir, the SDK is in the middle of reading these files —
 * in the worst case the turn sees mixed pre/post content. We accept that
 * race because (a) skill files are read at session init and lazy-loaded
 * skills reload from disk each activation so the current turn rarely holds
 * a long-running file handle, (b) the write is synchronous so half-states
 * don't persist on disk, and (c) skipping in-flight turns would need
 * intrusive dispatcher plumbing for a scenario that fires on a human-
 * triggered dashboard toggle. If the race ever bites, thread an in-flight
 * set into `skip`.
 */
export function refreshDmSessionWorkdirs(
  params: RefreshDmSessionWorkdirsParams,
): RefreshDmSessionWorkdirsResult {
  const result: RefreshDmSessionWorkdirsResult = {
    eligible: params.sessions.length,
    refreshed: 0,
    skippedStale: 0,
    skippedMissing: 0,
    failed: 0,
  };
  for (const session of params.sessions) {
    if (params.skip?.has(session.id)) {
      result.skippedStale++;
      continue;
    }
    const sessionDir = getSessionWorkdirPath(params.dataDir, session.id);
    if (!existsSync(sessionDir)) {
      result.skippedMissing++;
      continue;
    }
    try {
      ensureBackendMaterialized(
        params.projectRoot,
        sessionDir,
        session.backend ?? "claude",
        "message.received.dm",
        processKeyForDmScope(session.scope),
        params.configuredServices,
        params.mailAccounts,
        params.integrations,
        params.character,
      );
      result.refreshed++;
    } catch (err) {
      logger.warn(
        { err, sessionId: session.id, backend: session.backend },
        "Failed to re-materialize DM session workdir",
      );
      result.failed++;
    }
  }
  return result;
}

/**
 * Build a set of configured service names.
 * Used by SkillsCompiler to strip unconfigured service sections from
 * external-services/SKILL.md at materialization time.
 *
 * Calendar availability is determined from ServiceRegistry (non-null means
 * OAuth succeeded), NOT from `googleCalendarId` which defaults to "primary"
 * and is always truthy. GitHub presence is sourced from the unified
 * `repositories` table (rows with a github side) rather than the legacy
 * `gitRepos` / `gitWatchedRepos` / `githubRepos` config arrays, which were
 * removed at the unified-repositories cutover. Other services use config
 * fields that default to null/empty when unconfigured.
 */
export function buildConfiguredServices(
  config: {
    externalObsidianVaultPath?: string | null;
    notionDatabaseIds?: Record<string, string>;
  },
  serviceAvailability?: {
    calendar?: unknown;
    github?: unknown;
  },
): Set<string> {
  const services = new Set<string>();
  if (serviceAvailability?.calendar) services.add("calendar");
  if (serviceAvailability?.github) services.add("github");
  if (config.externalObsidianVaultPath) services.add("obsidian");
  if (config.notionDatabaseIds && Object.keys(config.notionDatabaseIds).length > 0) {
    services.add("notion");
  }
  return services;
}
