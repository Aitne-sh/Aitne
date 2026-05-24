import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { APP_NAME, type BackendId } from "@aitne/shared";

import { createLogger } from "../logging.js";
import { applyCharacterBlockRewrite } from "./character-block.js";
import { renderOutputLanguagePolicyPointer } from "./output-language-policy.js";
import { skillBodyTouchesReadSensitive } from "./skills-compiler-variants.js";
import type { SessionInstructionParams } from "./skills-compiler-types.js";

// Peer logger for this module — the `rewriteCharacterBlock` path emits
// per-file warnings on filesystem errors. Module-scoped so a future test
// can spy on it without crossing the `skills-compiler.ts` boundary.
const logger = createLogger("skills-compiler-cli-renderer");

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

export function renderCliInstructionFile(params: SessionInstructionParams): string {
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

/**
 * Daemon-API usage section. Pulled by `renderCliInstructionFile` for CLI
 * backends (passing `params.backendId !== "codex"`) and by
 * `SkillsCompiler.materializeClaudeSession` for the Claude SDK path
 * (always `true` — Claude holds the read-sensitive token). The single
 * source of truth keeps the rendered prose byte-identical across all four
 * backends.
 */
export function renderDaemonApiUsageSection(readSensitiveAvailable: boolean): string {
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
export function prependCodexReadSensitiveBanner(skillMdPath: string): void {
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
