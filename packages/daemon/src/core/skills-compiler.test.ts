import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SkillsCompiler } from "./skills-compiler.js";
import { rewriteCharacterBlock } from "./skills-compiler-cli-renderer.js";
import { setWikiWorkspaceTokenResolver } from "./skills-compiler-tree.js";
import {
  loadFetchWindowSystemPrompt,
  resetFetchWindowSystemPromptForTest,
} from "./fetch-window-prompt-loader.js";
import { APP_NAME, type BackendId } from "@aitne/shared";




/**
 * Claude / CLI inline parity test (SKILLS-PHASE-2-PLAN.md §3.4.3).
 * Materializes the same synthetic skill via both code paths and asserts
 * that the body the agent will read is byte-identical (modulo CLI
 * frontmatter strip), preserving the "guaranteed availability" contract
 * documented in `materializeCliSession` lines 469-475 of the
 * pre-Phase-2-A version.
 */
describe("renderReferenceIncludes — Claude / CLI inline parity", () => {
  let workspace: string;
  let claudeDir: string;
  let codexDir: string;
  let geminiDir: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "pa-ref-parity-"));
    claudeDir = mkdtempSync(join(tmpdir(), "pa-ref-parity-claude-"));
    codexDir = mkdtempSync(join(tmpdir(), "pa-ref-parity-codex-"));
    geminiDir = mkdtempSync(join(tmpdir(), "pa-ref-parity-gemini-"));

    // Minimal agent-assets tree.
    const profilesRoot = join(workspace, "agent-assets", "agent-profiles");
    mkdirSync(profilesRoot, { recursive: true });
    writeFileSync(
      join(profilesRoot, "_safety.md"),
      "## Safety Invariants\n- Do no harm.",
      "utf-8",
    );
    writeFileSync(
      join(profilesRoot, "conversational.md"),
      "# conversational\n\n## Tone\n\nBe friendly.\n",
      "utf-8",
    );

    // Synthetic skill with a single `{{> ref:providers }}` directive.
    // Use a slug that is part of the default `message.received` skills
    // manifest so the materializer actually picks it up. `mail` works —
    // it's listed for `message.received`. We override the on-disk file
    // with our synthetic body to avoid pulling in the real (large) mail
    // skill body.
    const mailSkill = join(workspace, "agent-assets", "skills", "mail");
    mkdirSync(join(mailSkill, "references"), { recursive: true });
    writeFileSync(
      join(mailSkill, "SKILL.md"),
      [
        "---",
        "name: mail",
        "description: synthetic mail skill with one reference directive",
        "---",
        "",
        "# Mail (synthetic)",
        "",
        "## Providers",
        "",
        "{{> ref:providers }}",
        "",
      ].join("\n"),
      "utf-8",
    );
    writeFileSync(
      join(mailSkill, "references", "providers.md"),
      "Gmail, Outlook, IMAP — synthetic provider list.",
      "utf-8",
    );
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(claudeDir, { recursive: true, force: true });
    rmSync(codexDir, { recursive: true, force: true });
    rmSync(geminiDir, { recursive: true, force: true });
  });

  it("materializes byte-identical skill bodies across Claude / Codex / Gemini for a {{> ref:* }}-using skill", () => {
    // docs/design/appendices/skills-unification.md Phase 1 — skill bodies are no longer
    // inlined into AGENTS.md / GEMINI.md. The parity contract now reads:
    // `.claude/skills/<slug>/SKILL.md` body byte-equals
    // `.codex/skills/<slug>/SKILL.md` body byte-equals
    // `.gemini/skills/<slug>/SKILL.md` body. AGENTS.md / GEMINI.md instead
    // carry a `<skill-index>` block that lists each slug's frontmatter
    // metadata for on-demand `Read`.
    const compiler = new SkillsCompiler(workspace);
    compiler.materializeSessionBundle({
      backendId: "claude",
      sessionDir: claudeDir,
      eventType: "message.received",
    });
    compiler.materializeSessionBundle({
      backendId: "codex",
      sessionDir: codexDir,
      eventType: "message.received",
    });
    compiler.materializeSessionBundle({
      backendId: "gemini",
      sessionDir: geminiDir,
      eventType: "message.received",
    });

    const claudeBody = stripFrontmatterForTest(
      readFileSync(
        join(claudeDir, ".claude", "skills", "mail", "SKILL.md"),
        "utf-8",
      ),
    ).trim();
    const codexCopyBody = stripFrontmatterForTest(
      readFileSync(
        join(codexDir, ".codex", "skills", "mail", "SKILL.md"),
        "utf-8",
      ),
    ).trim();
    const geminiCopyBody = stripFrontmatterForTest(
      readFileSync(
        join(geminiDir, ".gemini", "skills", "mail", "SKILL.md"),
        "utf-8",
      ),
    ).trim();

    // The reference inline must have happened — every body contains the
    // synthetic provider list and not the directive marker.
    for (const body of [claudeBody, codexCopyBody, geminiCopyBody]) {
      expect(body).toContain("Gmail, Outlook, IMAP — synthetic provider list.");
      expect(body).not.toContain("{{> ref:providers }}");
    }

    // Parity: every body is byte-identical after frontmatter strip. The
    // synthetic `mail` body references no read-sensitive `/api/*` prefix
    // so the Codex banner is NOT prepended (it only fires on bodies that
    // touch read-sensitive endpoints — see READ_SENSITIVE_API_PREFIXES).
    expect(codexCopyBody).toBe(claudeBody);
    expect(geminiCopyBody).toBe(claudeBody);

    // docs/design/appendices/skills-unification.md Phase 1 — instruction files no longer
    // inline skill bodies. The body text appears ONLY in the per-backend
    // skills dir; AGENTS.md / GEMINI.md carry the `<skill-index>` block.
    const agentsMd = readFileSync(join(codexDir, "AGENTS.md"), "utf-8");
    const geminiMd = readFileSync(join(geminiDir, "GEMINI.md"), "utf-8");
    expect(agentsMd).not.toContain("Gmail, Outlook, IMAP — synthetic provider list.");
    expect(geminiMd).not.toContain("Gmail, Outlook, IMAP — synthetic provider list.");
    expect(agentsMd).toContain("<skill-index>");
    expect(agentsMd).toContain("- name: mail");
    expect(geminiMd).toContain("<skill-index>");
    expect(geminiMd).toContain("- name: mail");
  });

  it("ships `references/*.md` into all three CLI skill dirs (still discoverable by Read)", () => {
    const compiler = new SkillsCompiler(workspace);
    compiler.materializeSessionBundle({
      backendId: "claude",
      sessionDir: claudeDir,
      eventType: "message.received",
    });
    compiler.materializeSessionBundle({
      backendId: "codex",
      sessionDir: codexDir,
      eventType: "message.received",
    });
    compiler.materializeSessionBundle({
      backendId: "gemini",
      sessionDir: geminiDir,
      eventType: "message.received",
    });

    const sourceRef = readFileSync(
      join(workspace, "agent-assets", "skills", "mail", "references", "providers.md"),
      "utf-8",
    );

    // Claude: `.claude/skills/<slug>/references/<name>.md`
    const claudeRef = readFileSync(
      join(claudeDir, ".claude", "skills", "mail", "references", "providers.md"),
      "utf-8",
    );
    const codexRef = readFileSync(
      join(codexDir, ".codex", "skills", "mail", "references", "providers.md"),
      "utf-8",
    );
    const geminiRef = readFileSync(
      join(geminiDir, ".gemini", "skills", "mail", "references", "providers.md"),
      "utf-8",
    );

    expect(claudeRef).toBe(sourceRef);
    expect(codexRef).toBe(sourceRef);
    expect(geminiRef).toBe(sourceRef);
  });

  it("preserves Claude/CLI parity when a referenced file carries `<!-- service:* -->` markers (ordering regression)", () => {
    // Plan §3.1 byte-equivalence contract regression guard. Pre-fix the
    // Claude path ran `stripUnconfiguredServices` BEFORE
    // `renderReferenceIncludes`, while CLI paths ran refs first. The
    // observable drift only shows up when a reference file itself
    // carries `<!-- service:foo --> ... <!-- /service:foo -->` markers
    // for an unconfigured service: strip-first leaks them on Claude but
    // the CLI path scrubs them. Aligning to refs-first on Claude
    // (matching CLI) makes both paths byte-identical here.
    //
    // Synthetic `external-services` skill — overrides the in-tree body so
    // we can inject a directive without touching production assets.
    const extServices = join(
      workspace,
      "agent-assets",
      "skills",
      "external-services",
    );
    mkdirSync(join(extServices, "references"), { recursive: true });
    writeFileSync(
      join(extServices, "SKILL.md"),
      [
        "---",
        "name: external-services",
        "description: synthetic external-services with one ref directive",
        "---",
        "",
        "# external-services (synthetic)",
        "",
        "{{> ref:provider-notes }}",
        "",
        "<!-- service:calendar -->",
        "## Calendar (configured)",
        "<!-- /service:calendar -->",
        "",
      ].join("\n"),
      "utf-8",
    );
    writeFileSync(
      join(extServices, "references", "provider-notes.md"),
      [
        "## Provider notes",
        "",
        "Always-on guidance.",
        "",
        "<!-- service:legacy -->",
        "## Legacy (unconfigured)",
        "Stale text that must be stripped from BOTH backends.",
        "<!-- /service:legacy -->",
        "",
      ].join("\n"),
      "utf-8",
    );

    // Configured services = {calendar}. The `legacy` block inlined from
    // the reference file must be stripped on every backend; the
    // `calendar` block (already in SKILL.md) must survive on every
    // backend. The materializer's call site uses `> 0` to gate the
    // strip — passing a non-empty set is what triggers the bug.
    const compiler = new SkillsCompiler(
      workspace,
      new Set(["calendar"]),
    );
    compiler.materializeSessionBundle({
      backendId: "claude",
      sessionDir: claudeDir,
      eventType: "message.received",
    });
    compiler.materializeSessionBundle({
      backendId: "codex",
      sessionDir: codexDir,
      eventType: "message.received",
    });
    compiler.materializeSessionBundle({
      backendId: "gemini",
      sessionDir: geminiDir,
      eventType: "message.received",
    });

    const claudeBody = stripFrontmatterForTest(
      readFileSync(
        join(claudeDir, ".claude", "skills", "external-services", "SKILL.md"),
        "utf-8",
      ),
    ).trim();
    // docs/design/appendices/skills-unification.md Phase 1 — read the body from the
    // per-backend skill dir (not from inline AGENTS.md / GEMINI.md, which
    // no longer carry skill bodies).
    const codexBody = stripFrontmatterForTest(
      readFileSync(
        join(codexDir, ".codex", "skills", "external-services", "SKILL.md"),
        "utf-8",
      ),
    ).trim();
    const geminiBody = stripFrontmatterForTest(
      readFileSync(
        join(geminiDir, ".gemini", "skills", "external-services", "SKILL.md"),
        "utf-8",
      ),
    ).trim();

    // Sanity: the always-on prose from the reference inlined everywhere.
    for (const body of [claudeBody, codexBody, geminiBody]) {
      expect(body).toContain("Always-on guidance.");
      // The configured `calendar` block survives — strip drops only
      // sections whose service is NOT in the configured set.
      expect(body).toContain("## Calendar (configured)");
      // The unconfigured `legacy` block (which arrived via the inlined
      // reference) is stripped on every backend.
      expect(body).not.toContain("## Legacy (unconfigured)");
      expect(body).not.toContain("Stale text that must be stripped");
    }

    // Parity: byte-identical bodies across backends. Pre-fix the Claude
    // body would still carry the `## Legacy (unconfigured)` heading.
    expect(codexBody).toBe(claudeBody);
    expect(geminiBody).toBe(claudeBody);
  });
});

/** Local copy of the module-private `stripFrontmatter` for parity tests. */
function stripFrontmatterForTest(content: string): string {
  if (!content.startsWith("---")) return content;
  const endIdx = content.indexOf("\n---", 3);
  if (endIdx < 0) return content;
  return content.slice(endIdx + 4).replace(/^\n+/, "");
}

/**
 * Extract the body of a `### <slug>` section from an AGENTS.md / GEMINI.md
 * instruction file. The skill section runs until the next `### ` heading
 * or end of file (matching the layout of `renderCliInstructionFile`).
 * Returns the trimmed body so equality checks ignore trailing blank lines.
 */
function extractSkillSection(instruction: string, slug: string): string {
  const heading = `### ${slug}\n`;
  const start = instruction.indexOf(heading);
  if (start < 0) throw new Error(`section ### ${slug} not found`);
  const after = instruction.slice(start + heading.length);
  const nextHeading = after.search(/^### /m);
  const body = nextHeading >= 0 ? after.slice(0, nextHeading) : after;
  return body.trim();
}




/**
 * Cross-backend prose coverage — docs/design/appendices/routine-data-acquisition.md
 * Phase 3 R4 deleted the
 * `routine.hourly_check.delegated.<sessionBackend>.md` variant files
 * along with their `native.<sessionBackend>` siblings. The
 * cross-backend / same-backend split prose lives in the
 * `_partials/<kind>-acquire.<integration>.md` partials now: the
 * `<!-- mode:delegated-same:* -->` branch carries the in-session
 * connector flow, `<!-- mode:delegated-cross:* -->` carries the
 * `/api/integrations/<key>/exec` proxy flow, and
 * `applyIntegrationModeFilter` selects the right branch using the
 * session backend + the integration's `delegatedBackend` binding —
 * exactly what the deleted variants encoded by filename. This
 * replacement suite pins the equivalent contract against the rendered
 * `routine.hourly_check` body across the matrix that used to be the
 * variant files.
 */
describe("hourly_check main session is wire-surface agnostic (Phase 4 D3)", () => {
  // docs/design/appendices/routine-data-acquisition.md Phase 4 D3 — the dispatcher
  // pre-pass (`routine.fetch_window`) now owns the integration wire
  // surface for hourly_check. The main session reads observations and
  // is agnostic to (mode, backend) routing — the per-cell prose lives
  // in the pre-pass session's prompt, not in `routine.hourly_check.md`.
  // The substitute coverage below pins the contract that the main
  // session body never embeds the partials and never references the
  // delegation proxy directly, regardless of (session, mode → backend)
  // permutation. Per-cell wire-surface coverage moved to:
  //   - `routine-partials-render.test.ts` (per-partial branch markers)
  //   - `routine-task-flow-includes.test.ts` (pre-pass include resolution)
  //   - `routine-acquisition-plan.test.ts` (mode-resolution semantics)
  for (const sessionBackend of ["claude", "codex"] as const) {
    it(`routine.hourly_check (session=${sessionBackend}, gmail+calendar+notion delegated to ${sessionBackend}) main session reads observations + has no embedded wire surface`, async () => {
      const { getTaskFlow } = await import("./prompts.js");
      const ts = "2026-05-11T00:00:00.000Z";
      const flow = getTaskFlow("routine.hourly_check", sessionBackend, {
        gmail: { mode: "delegated", delegatedBackend: sessionBackend, deniedTools: [], lastChangedAt: ts },
        google_calendar: { mode: "delegated", delegatedBackend: sessionBackend, deniedTools: [], lastChangedAt: ts },
        notion: { mode: "delegated", delegatedBackend: sessionBackend, deniedTools: [], lastChangedAt: ts },
      });
      // Main session reads via /api/observations and consults the
      // pre-pass status block — no inline integration fetch.
      expect(flow).toContain("/api/observations");
      expect(flow).toContain("<fetch_report>");
      expect(flow).not.toContain("{include:_partials/");
      // The main session must not reference the delegation proxy —
      // that surface lives in the pre-pass partial bodies only.
      expect(flow).not.toContain("/api/integrations/gmail/exec");
      expect(flow).not.toContain("/api/integrations/notion/exec");
      expect(flow).not.toContain("/api/integrations/google_calendar/exec");
    });

    it(`routine.hourly_check (session=${sessionBackend}, gmail+calendar+notion delegated to the OTHER backend) main session stays agnostic of cross-backend routing`, async () => {
      const { getTaskFlow } = await import("./prompts.js");
      const otherBackend = sessionBackend === "claude" ? "codex" : "claude";
      const ts = "2026-05-11T00:00:00.000Z";
      const flow = getTaskFlow("routine.hourly_check", sessionBackend, {
        gmail: { mode: "delegated", delegatedBackend: otherBackend, deniedTools: [], lastChangedAt: ts },
        google_calendar: { mode: "delegated", delegatedBackend: otherBackend, deniedTools: [], lastChangedAt: ts },
        notion: { mode: "delegated", delegatedBackend: otherBackend, deniedTools: [], lastChangedAt: ts },
      });
      // The cross-backend proxy URL must NOT appear in the main session
      // body — the pre-pass partial owns that surface. Structural fix
      // for the previous double-fetch / partial-leak bug.
      expect(flow).not.toContain("/api/integrations/gmail/exec");
      expect(flow).not.toContain("/api/integrations/google_calendar/exec");
      expect(flow).not.toContain("/api/integrations/notion/exec");
      expect(flow).toContain("/api/observations");
      expect(flow).toContain("<fetch_report>");
    });
  }

  it("routine.hourly_check (session=gemini, gmail+calendar+notion delegated to claude) main session stays agnostic — pre-pass owns the cross-backend proxy", async () => {
    const { getTaskFlow } = await import("./prompts.js");
    const ts = "2026-05-11T00:00:00.000Z";
    const flow = getTaskFlow("routine.hourly_check", "gemini", {
      gmail: { mode: "delegated", delegatedBackend: "claude", deniedTools: [], lastChangedAt: ts },
      google_calendar: { mode: "delegated", delegatedBackend: "claude", deniedTools: [], lastChangedAt: ts },
      notion: { mode: "delegated", delegatedBackend: "claude", deniedTools: [], lastChangedAt: ts },
    });
    expect(flow).not.toContain("/api/integrations/gmail/exec");
    expect(flow).not.toContain("/api/integrations/google_calendar/exec");
    expect(flow).not.toContain("/api/integrations/notion/exec");
    expect(flow).toContain("/api/observations");
    expect(flow).toContain("<fetch_report>");
  });
});

/**
 * Materialization tests for the Character block (CHARACTER-IMPLEMENTATION-
 * PLAN.md Phase 2 / docs/design/15-character.md §15.4). The pure parse /
 * compose half is covered in `character-block.test.ts`; this set covers
 * the wiring into each backend's instruction file plus the `rewriteCharacterBlock`
 * multi-backend fs wrapper.
 *
 * Setup builds a miniature `agent-assets/` tree with just enough profile
 * and skill content for the compiler to run, then materializes a session
 * bundle into a tmp dir and inspects the resulting CLAUDE.md / AGENTS.md /
 * GEMINI.md.
 */
describe("character block materialization", () => {
  let workspace: string;
  let sessionDir: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "pa-character-"));
    sessionDir = mkdtempSync(join(tmpdir(), "pa-session-"));
    // Profiles — `conversational` is what `message.received` resolves to
    // in the default skills manifest.
    const profilesRoot = join(workspace, "agent-assets", "agent-profiles");
    mkdirSync(profilesRoot, { recursive: true });
    // Mirror the production safety fixture shape: `## Safety Invariants`
    // is an H2 heading, so a naive "insert before first `## `" placement
    // would land the Character block ABOVE safety and violate design
    // §15.4.2 / §15.5. The character-block rewriter uses the
    // `<!-- safety:end -->` sentinel emitted by `readSafetyPreamble` to
    // place the block after safety. Keeping these fixtures H2 guards
    // against a reintroduction of the pre-fix bug.
    writeFileSync(
      join(profilesRoot, "_safety.md"),
      "## Safety Invariants\n- Do no harm.",
      "utf-8",
    );
    writeFileSync(
      join(profilesRoot, "conversational.md"),
      "# conversational\n\n## Tone\n\nBe friendly.\n",
      "utf-8",
    );
    // A no-op skills root — the manifest's default skills may reference
    // slugs we don't have, which the compiler tolerates (materializeCliSession
    // skips missing SKILL.md files).
    mkdirSync(join(workspace, "agent-assets", "skills"), { recursive: true });
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  });

  it("injects the Character block into CLAUDE.md when character is non-empty", () => {
    const compiler = new SkillsCompiler(workspace, new Set(), [], {}, "Speak casually.");
    compiler.materializeSessionBundle({
      backendId: "claude",
      sessionDir,
      eventType: "message.received",
    });
    const claudeMd = readFileSync(join(sessionDir, "CLAUDE.md"), "utf-8");
    expect(claudeMd).toContain("## Character (user-defined)");
    expect(claudeMd).toContain("<!-- character:start -->");
    expect(claudeMd).toContain("Speak casually.");
    expect(claudeMd).toContain("<!-- character:end -->");
    // Position invariant (design §15.4.2 / §15.5): safety → character →
    // profile body. Specifically, the `## Character` heading must sit
    // AFTER the `## Safety Invariants` heading (an H2 in production), not
    // above it. This assertion pins the sentinel-driven placement that
    // replaced the pre-fix "before first `## `" behavior.
    const safetyHeadingIdx = claudeMd.indexOf("## Safety Invariants");
    const sentinelIdx = claudeMd.indexOf("<!-- safety:end -->");
    const characterIdx = claudeMd.indexOf("## Character (user-defined)");
    const toneIdx = claudeMd.indexOf("## Tone");
    expect(safetyHeadingIdx).toBeGreaterThanOrEqual(0);
    expect(sentinelIdx).toBeGreaterThan(safetyHeadingIdx);
    expect(characterIdx).toBeGreaterThan(sentinelIdx);
    expect(toneIdx).toBeGreaterThan(characterIdx);
  });

  it("omits the Character block from CLAUDE.md when character is empty", () => {
    const compiler = new SkillsCompiler(workspace, new Set(), [], {}, "");
    compiler.materializeSessionBundle({
      backendId: "claude",
      sessionDir,
      eventType: "message.received",
    });
    const claudeMd = readFileSync(join(sessionDir, "CLAUDE.md"), "utf-8");
    expect(claudeMd).not.toContain("## Character (user-defined)");
    expect(claudeMd).not.toContain("<!-- character:start -->");
  });

  it("injects the Character block into AGENTS.md (Codex) when character is non-empty", () => {
    const compiler = new SkillsCompiler(workspace, new Set(), [], {}, "Speak casually.");
    compiler.materializeSessionBundle({
      backendId: "codex",
      sessionDir,
      eventType: "message.received",
    });
    const agentsMd = readFileSync(join(sessionDir, "AGENTS.md"), "utf-8");
    expect(agentsMd).toContain("## Character (user-defined)");
    expect(agentsMd).toContain("Speak casually.");
    // Position: `## Safety Invariants` → `<!-- safety:end -->` sentinel →
    // `## Character` → `## Behavioral rules`. The sentinel guards against
    // placement regressions caused by the H2 safety heading.
    const safetyHeadingIdx = agentsMd.indexOf("## Safety Invariants");
    const sentinelIdx = agentsMd.indexOf("<!-- safety:end -->");
    const characterIdx = agentsMd.indexOf("## Character (user-defined)");
    const behavioralIdx = agentsMd.indexOf("## Behavioral rules");
    expect(safetyHeadingIdx).toBeGreaterThanOrEqual(0);
    expect(sentinelIdx).toBeGreaterThan(safetyHeadingIdx);
    expect(characterIdx).toBeGreaterThan(sentinelIdx);
    expect(behavioralIdx).toBeGreaterThan(characterIdx);
  });

  it("injects the Character block into GEMINI.md when character is non-empty", () => {
    const compiler = new SkillsCompiler(workspace, new Set(), [], {}, "Speak casually.");
    compiler.materializeSessionBundle({
      backendId: "gemini",
      sessionDir,
      eventType: "message.received",
    });
    const geminiMd = readFileSync(join(sessionDir, "GEMINI.md"), "utf-8");
    expect(geminiMd).toContain("## Character (user-defined)");
    expect(geminiMd).toContain("Speak casually.");
  });

  it("produces byte-identical character block content across Claude / Codex / Gemini", () => {
    // Design §15.4.1 requires the block itself to be byte-identical across
    // all three backends (different surrounding structure is fine).
    const claudeDir = mkdtempSync(join(tmpdir(), "pa-char-claude-"));
    const codexDir = mkdtempSync(join(tmpdir(), "pa-char-codex-"));
    const geminiDir = mkdtempSync(join(tmpdir(), "pa-char-gemini-"));
    try {
      const c = new SkillsCompiler(workspace, new Set(), [], {}, "Speak casually.");
      c.materializeSessionBundle({ backendId: "claude", sessionDir: claudeDir, eventType: "message.received" });
      c.materializeSessionBundle({ backendId: "codex", sessionDir: codexDir, eventType: "message.received" });
      c.materializeSessionBundle({ backendId: "gemini", sessionDir: geminiDir, eventType: "message.received" });
      const sliceBlock = (text: string) => {
        const start = text.indexOf("## Character (user-defined)");
        const end = text.indexOf("safety wins.", start) + "safety wins.".length;
        return text.slice(start, end);
      };
      const claudeBlock = sliceBlock(readFileSync(join(claudeDir, "CLAUDE.md"), "utf-8"));
      const codexBlock = sliceBlock(readFileSync(join(codexDir, "AGENTS.md"), "utf-8"));
      const geminiBlock = sliceBlock(readFileSync(join(geminiDir, "GEMINI.md"), "utf-8"));
      expect(codexBlock).toBe(claudeBlock);
      expect(geminiBlock).toBe(claudeBlock);
    } finally {
      rmSync(claudeDir, { recursive: true, force: true });
      rmSync(codexDir, { recursive: true, force: true });
      rmSync(geminiDir, { recursive: true, force: true });
    }
  });

  it("materializes the profile-importer profile into per-backend instruction files for knowledge.import sessions", () => {
    // End-to-end verification of the dashboard Knowledge upload path:
    // when the import session spawns, the SkillsCompiler must resolve
    // processKey="knowledge.import" → profile "profile-importer" and
    // write the strict-fidelity persona into the per-backend instruction
    // file in the session workdir. Without this, the agent would inherit
    // the default `task` profile and the user's explicit "do not deviate
    // from what I provided" requirement would silently fail.
    //
    // Uses the REAL agent-assets tree (not the synthetic fixture above)
    // so the assertion locks in the actual prose the user expects to see.
    const REPO_ROOT_REAL = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../",
    );
    const claudeDir2 = mkdtempSync(join(tmpdir(), "pa-import-claude-"));
    const codexDir2 = mkdtempSync(join(tmpdir(), "pa-import-codex-"));
    const geminiDir2 = mkdtempSync(join(tmpdir(), "pa-import-gemini-"));
    try {
      const c = new SkillsCompiler(REPO_ROOT_REAL);
      const claudeOut = c.materializeSessionBundle({
        backendId: "claude",
        sessionDir: claudeDir2,
        eventType: "knowledge.import",
        processKey: "knowledge.import",
      });
      const codexOut = c.materializeSessionBundle({
        backendId: "codex",
        sessionDir: codexDir2,
        eventType: "knowledge.import",
        processKey: "knowledge.import",
      });
      const geminiOut = c.materializeSessionBundle({
        backendId: "gemini",
        sessionDir: geminiDir2,
        eventType: "knowledge.import",
        processKey: "knowledge.import",
      });

      // Profile resolved correctly for all three backends.
      expect(claudeOut.profile).toBe("profile-importer");
      expect(codexOut.profile).toBe("profile-importer");
      expect(geminiOut.profile).toBe("profile-importer");

      // Per-backend instruction file exists at the canonical name.
      const claudeMd = readFileSync(join(claudeDir2, "CLAUDE.md"), "utf-8");
      const agentsMd = readFileSync(join(codexDir2, "AGENTS.md"), "utf-8");
      const geminiMd = readFileSync(join(geminiDir2, "GEMINI.md"), "utf-8");

      // The Profile Importer persona — strict-fidelity rule must reach
      // every backend. Drift here means the user's "verbatim only"
      // requirement was silently dropped.
      for (const md of [claudeMd, agentsMd, geminiMd]) {
        expect(md).toContain("Profile Importer");
        expect(md).toContain("transcriber, not a rewriter");
        expect(md).toContain("Never infer, extrapolate, summarize, paraphrase");
      }
    } finally {
      rmSync(claudeDir2, { recursive: true, force: true });
      rmSync(codexDir2, { recursive: true, force: true });
      rmSync(geminiDir2, { recursive: true, force: true });
    }
  });

  it("double materialization with the same character produces byte-identical output (prompt-cache invariant)", () => {
    const compiler = new SkillsCompiler(workspace, new Set(), [], {}, "Speak casually.");
    compiler.materializeSessionBundle({
      backendId: "claude",
      sessionDir,
      eventType: "message.received",
    });
    const first = readFileSync(join(sessionDir, "CLAUDE.md"), "utf-8");
    compiler.materializeSessionBundle({
      backendId: "claude",
      sessionDir,
      eventType: "message.received",
    });
    const second = readFileSync(join(sessionDir, "CLAUDE.md"), "utf-8");
    expect(second).toBe(first);
  });
});

describe("rewriteCharacterBlock", () => {
  let workdir: string;
  let workspace: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "pa-rewrite-"));
    workspace = mkdtempSync(join(tmpdir(), "pa-rewrite-ws-"));
    const profilesRoot = join(workspace, "agent-assets", "agent-profiles");
    mkdirSync(profilesRoot, { recursive: true });
    // Mirror the production safety fixture shape: `## Safety Invariants`
    // is an H2 heading, so a naive "insert before first `## `" placement
    // would land the Character block ABOVE safety and violate design
    // §15.4.2 / §15.5. The character-block rewriter uses the
    // `<!-- safety:end -->` sentinel emitted by `readSafetyPreamble` to
    // place the block after safety. Keeping these fixtures H2 guards
    // against a reintroduction of the pre-fix bug.
    writeFileSync(
      join(profilesRoot, "_safety.md"),
      "## Safety Invariants\n- Do no harm.",
      "utf-8",
    );
    writeFileSync(
      join(profilesRoot, "conversational.md"),
      "# conversational\n\n## Tone\n\nBe friendly.\n",
      "utf-8",
    );
    mkdirSync(join(workspace, "agent-assets", "skills"), { recursive: true });
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  it("rewrites the Character block in every instruction file present in the workdir", () => {
    // Materialize both Claude and Codex (simulating a fallback workdir
    // that ended up with both layouts — see CLAUDE.md "Fallback
    // re-materialization").
    const compiler = new SkillsCompiler(workspace, new Set(), [], {}, "Old value.");
    compiler.materializeSessionBundle({
      backendId: "claude",
      sessionDir: workdir,
      eventType: "message.received",
    });
    compiler.materializeSessionBundle({
      backendId: "codex",
      sessionDir: workdir,
      eventType: "message.received",
    });

    const summary = rewriteCharacterBlock(workdir, "New value.");
    expect(summary.rewritten).toBe(2);
    expect(summary.skipped).toBe(1); // GEMINI.md not present

    const claudeMd = readFileSync(join(workdir, "CLAUDE.md"), "utf-8");
    const agentsMd = readFileSync(join(workdir, "AGENTS.md"), "utf-8");
    expect(claudeMd).toContain("New value.");
    expect(claudeMd).not.toContain("Old value.");
    expect(agentsMd).toContain("New value.");
    expect(agentsMd).not.toContain("Old value.");
  });

  it("removes the Character block when the new value is empty", () => {
    const compiler = new SkillsCompiler(workspace, new Set(), [], {}, "Old value.");
    compiler.materializeSessionBundle({
      backendId: "claude",
      sessionDir: workdir,
      eventType: "message.received",
    });

    const summary = rewriteCharacterBlock(workdir, "");
    expect(summary.rewritten).toBe(1);
    const claudeMd = readFileSync(join(workdir, "CLAUDE.md"), "utf-8");
    expect(claudeMd).not.toContain("## Character (user-defined)");
    expect(claudeMd).not.toContain("Old value.");
    // Profile body intact.
    expect(claudeMd).toContain("## Tone");
  });

  it("inserts a fresh block into a legacy workdir that has no Character markers", () => {
    // Simulate a legacy workdir by materializing with empty character first.
    const compiler = new SkillsCompiler(workspace, new Set(), [], {}, "");
    compiler.materializeSessionBundle({
      backendId: "claude",
      sessionDir: workdir,
      eventType: "message.received",
    });
    const before = readFileSync(join(workdir, "CLAUDE.md"), "utf-8");
    expect(before).not.toContain("## Character (user-defined)");

    const summary = rewriteCharacterBlock(workdir, "Fresh value.");
    expect(summary.rewritten).toBe(1);
    const after = readFileSync(join(workdir, "CLAUDE.md"), "utf-8");
    expect(after).toContain("## Character (user-defined)");
    expect(after).toContain("Fresh value.");
  });

  it("is idempotent — the second call with the same value leaves the file untouched", () => {
    const compiler = new SkillsCompiler(workspace, new Set(), [], {}, "Speak casually.");
    compiler.materializeSessionBundle({
      backendId: "claude",
      sessionDir: workdir,
      eventType: "message.received",
    });

    const first = rewriteCharacterBlock(workdir, "Speak casually.");
    // No rewrite needed — the materialized file already has this value.
    expect(first.rewritten).toBe(0);
    expect(first.skipped).toBe(3); // all three tried; Claude skipped as no-op, Codex / Gemini absent

    const second = rewriteCharacterBlock(workdir, "Speak casually.");
    expect(second.rewritten).toBe(0);
  });

  it("skips files that don't exist in the workdir", () => {
    // Empty workdir — none of the three files exist.
    const summary = rewriteCharacterBlock(workdir, "Any value.");
    expect(summary.rewritten).toBe(0);
    expect(summary.skipped).toBe(3);
    expect(summary.failed).toBe(0);
    // None of the files materialize as a side effect.
    expect(existsSync(join(workdir, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(workdir, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(workdir, "GEMINI.md"))).toBe(false);
  });
});

/**
 * Smoke test for the Character block placement against the REAL
 * `agent-assets/` tree (not synthetic fixtures). Earlier tests use a
 * minimal `## Safety Invariants` H2 fixture that matches production
 * *shape*, but not its *contents* — a future edit that rearranges
 * `_safety.md` or `conversational.md` (e.g. adds a new pre-safety `## `
 * heading, or removes the H1 description that anchors `readProfileWithSafety`'s
 * splice) could regress the ordering invariant without any fixture-based
 * test catching it.
 *
 * This suite replaces the plan's §5 step 9 "pnpm restart + grep CLAUDE.md"
 * smoke test at the integration level: it materializes a real session
 * bundle and asserts the production-file invariants `safety → sentinel →
 * character → profile body`.
 */
describe("character block — real agent-assets smoke", () => {
  const projectRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "..",
  );
  let sessionDir: string;

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), "pa-real-character-"));
  });

  afterEach(() => {
    rmSync(sessionDir, { recursive: true, force: true });
  });

  it("materializes CLAUDE.md with character below safety against real agent-assets", () => {
    const compiler = new SkillsCompiler(
      projectRoot,
      new Set(),
      [],
      {},
      "Speak casually. Tight bullets, no emoji.",
    );
    compiler.materializeSessionBundle({
      backendId: "claude",
      sessionDir,
      eventType: "message.received",
    });
    const claudeMd = readFileSync(join(sessionDir, "CLAUDE.md"), "utf-8");

    const safetyHeadingIdx = claudeMd.indexOf("## Safety Invariants");
    const sentinelIdx = claudeMd.indexOf("<!-- safety:end -->");
    const characterIdx = claudeMd.indexOf("## Character (user-defined)");
    const characterBodyIdx = claudeMd.indexOf("Speak casually. Tight bullets, no emoji.");

    expect(safetyHeadingIdx).toBeGreaterThanOrEqual(0);
    expect(sentinelIdx).toBeGreaterThan(safetyHeadingIdx);
    expect(characterIdx).toBeGreaterThan(sentinelIdx);
    expect(characterBodyIdx).toBeGreaterThan(characterIdx);

    // `_safety.md` currently defines multiple `## ` sections (e.g.
    // `## Safety Invariants`, `## Common Patterns`). All of them must
    // sit above the Character block — if a future edit splits safety or
    // inserts another H2 below the sentinel, this check would break.
    const allSafetyHeadings = [...claudeMd.matchAll(/^## (?:Safety|Common) [A-Z]/gm)].map(
      (m) => m.index ?? -1,
    );
    for (const idx of allSafetyHeadings) {
      expect(idx).toBeLessThan(characterIdx);
    }
  });

  it("materializes AGENTS.md (Codex) with character below safety against real agent-assets", () => {
    const compiler = new SkillsCompiler(
      projectRoot,
      new Set(),
      [],
      {},
      "Speak casually. Tight bullets, no emoji.",
    );
    compiler.materializeSessionBundle({
      backendId: "codex",
      sessionDir,
      eventType: "message.received",
    });
    const agentsMd = readFileSync(join(sessionDir, "AGENTS.md"), "utf-8");

    const safetyHeadingIdx = agentsMd.indexOf("## Safety Invariants");
    const sentinelIdx = agentsMd.indexOf("<!-- safety:end -->");
    const characterIdx = agentsMd.indexOf("## Character (user-defined)");
    const behavioralIdx = agentsMd.indexOf("## Behavioral rules");

    expect(safetyHeadingIdx).toBeGreaterThanOrEqual(0);
    expect(sentinelIdx).toBeGreaterThan(safetyHeadingIdx);
    expect(characterIdx).toBeGreaterThan(sentinelIdx);
    expect(behavioralIdx).toBeGreaterThan(characterIdx);
  });

  it("materializes empty character without a spurious block against real agent-assets", () => {
    // Belt-and-suspenders for the omission contract (design §15.4.1): an
    // empty character must NOT leave a header / marker / footer behind.
    const compiler = new SkillsCompiler(projectRoot, new Set(), [], {}, "");
    compiler.materializeSessionBundle({
      backendId: "claude",
      sessionDir,
      eventType: "message.received",
    });
    const claudeMd = readFileSync(join(sessionDir, "CLAUDE.md"), "utf-8");
    expect(claudeMd).not.toContain("## Character (user-defined)");
    expect(claudeMd).not.toContain("<!-- character:start -->");
    expect(claudeMd).not.toContain("<!-- character:end -->");
    // Sentinel IS still present — the rewrite path relies on it for
    // correct insertion when the user later sets character mid-session.
    expect(claudeMd).toContain("<!-- safety:end -->");
  });
});

describe("brand-token materialization — single-point-of-change contract", () => {
  // End-to-end proof that the materialization pipeline calls
  // `substituteBrandTokens` at every read-from-src boundary. Uses the real
  // agent-assets/ tree (not a synthetic fixture) so that any future
  // wiring regression — someone deletes one of the read-side wraps in
  // skills-compiler.ts, or a new inliner is added without a wrap — surfaces
  // here. branding.test.ts proves the function itself; this test proves
  // the call sites stay wired.
  const projectRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "..",
  );
  let sessionDir: string;

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), "pa-brand-token-"));
  });

  afterEach(() => {
    rmSync(sessionDir, { recursive: true, force: true });
  });

  // dashboard.docs_qa is the canonical event that loads the docs-qa profile
  // and the docs-search skill — both contain `{APP_NAME}` tokens in source.
  const cases: Array<{
    backend: BackendId;
    instructionFile: string;
    skillSubdir: string;
  }> = [
    { backend: "claude", instructionFile: "CLAUDE.md", skillSubdir: ".claude/skills/docs-search" },
    { backend: "codex", instructionFile: "AGENTS.md", skillSubdir: ".codex/skills/docs-search" },
    { backend: "gemini", instructionFile: "GEMINI.md", skillSubdir: ".gemini/skills/docs-search" },
  ];

  for (const { backend, instructionFile, skillSubdir } of cases) {
    it(`${backend}: instruction file and skill body resolve {APP_NAME} to "${APP_NAME}"`, () => {
      const compiler = new SkillsCompiler(projectRoot);
      compiler.materializeSessionBundle({
        backendId: backend,
        sessionDir,
        eventType: "dashboard.docs_qa",
      });

      const instruction = readFileSync(join(sessionDir, instructionFile), "utf-8");
      expect(
        instruction,
        `${backend} ${instructionFile}: token must be resolved`,
      ).not.toContain("{APP_NAME}");
      expect(
        instruction,
        `${backend} ${instructionFile}: APP_NAME must appear`,
      ).toContain(APP_NAME);

      const skillPath = join(sessionDir, skillSubdir, "SKILL.md");
      // Skill dir copy may be omitted under some delegation/native-mcp
      // configurations; only assert when present so the test is portable.
      if (existsSync(skillPath)) {
        const skill = readFileSync(skillPath, "utf-8");
        expect(skill, `${backend} skill body: token must be resolved`).not.toContain(
          "{APP_NAME}",
        );
        expect(skill, `${backend} skill body: APP_NAME must appear`).toContain(APP_NAME);
      }
    });
  }
});





/**
 * Custom messaging bang command override — the dispatcher hands the
 * compiler `override.skillSlugs` and `override.profileBody` so a `!cmd`
 * turn renders with the row's exact configuration. The override is
 * narrow: when both fields are null it equals "manifest defaults" and
 * the result is byte-equivalent to a no-override call. When set, it
 * fully replaces both axes.
 */
describe("materializeSessionBundle — custom command override", () => {
  const repoRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "..",
  );
  let sessionDir: string;

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), "pa-bang-override-"));
  });

  afterEach(() => {
    rmSync(sessionDir, { recursive: true, force: true });
  });

  it("replaces the manifest skill set with the override list (Claude)", () => {
    const compiler = new SkillsCompiler(repoRoot);
    const result = compiler.materializeSessionBundle({
      backendId: "claude",
      sessionDir,
      eventType: "message.received.dm",
      override: { skillSlugs: ["notify"], profileBody: null },
    });
    expect(result.skills).toEqual(["notify"]);
    const skillsRoot = join(sessionDir, ".claude", "skills");
    expect(existsSync(join(skillsRoot, "notify", "SKILL.md"))).toBe(true);
    // The manifest's DM set carries `context`, `today`, `mail`, etc. —
    // none of those should be materialized when the override narrows
    // the surface.
    expect(existsSync(join(skillsRoot, "context"))).toBe(false);
    expect(existsSync(join(skillsRoot, "mail"))).toBe(false);
  });

  it("renders the custom profile body into CLAUDE.md when set", () => {
    const compiler = new SkillsCompiler(repoRoot);
    const body = "Reply with one short bullet, then stop. Owner asked for terse.";
    compiler.materializeSessionBundle({
      backendId: "claude",
      sessionDir,
      eventType: "message.received.dm",
      override: { skillSlugs: ["notify"], profileBody: body },
    });
    const claudeMd = readFileSync(join(sessionDir, "CLAUDE.md"), "utf-8");
    expect(claudeMd).toContain(body);
    // Safety preamble should still appear above the custom body.
    expect(claudeMd).toMatch(/Safety/i);
  });

  it("renders the custom profile body into AGENTS.md for Codex", () => {
    const compiler = new SkillsCompiler(repoRoot);
    const body = "You are a single-purpose digest writer.";
    compiler.materializeSessionBundle({
      backendId: "codex",
      sessionDir,
      eventType: "message.received.dm",
      override: { skillSlugs: ["notify"], profileBody: body },
    });
    const agentsMd = readFileSync(join(sessionDir, "AGENTS.md"), "utf-8");
    expect(agentsMd).toContain(body);
  });

  it("an empty skillSlugs override produces zero materialized built-in skills", () => {
    const compiler = new SkillsCompiler(repoRoot);
    const result = compiler.materializeSessionBundle({
      backendId: "claude",
      sessionDir,
      eventType: "message.received.dm",
      override: { skillSlugs: [], profileBody: null },
    });
    expect(result.skills).toEqual([]);
    const skillsRoot = join(sessionDir, ".claude", "skills");
    if (existsSync(skillsRoot)) {
      const entries = readdirSync(skillsRoot);
      // Only stale-pruning happens; nothing should remain.
      expect(entries.filter((n) => n !== ".gitkeep")).toEqual([]);
    }
  });

  it("a null skillSlugs override falls back to the manifest set", () => {
    const compiler = new SkillsCompiler(repoRoot);
    const result = compiler.materializeSessionBundle({
      backendId: "claude",
      sessionDir,
      eventType: "message.received.dm",
      override: { skillSlugs: null, profileBody: null },
    });
    // The manifest's `message.received.dm` set is the standard ~18 skills.
    expect(result.skills.length).toBeGreaterThan(1);
    expect(result.skills).toContain("notify");
    expect(result.skills).toContain("context");
  });

  it("re-materialization with a narrower set prunes stale skill dirs", () => {
    const compiler = new SkillsCompiler(repoRoot);
    // First pass: full DM manifest.
    compiler.materializeSessionBundle({
      backendId: "claude",
      sessionDir,
      eventType: "message.received.dm",
    });
    const skillsRoot = join(sessionDir, ".claude", "skills");
    expect(existsSync(join(skillsRoot, "context"))).toBe(true);
    // Second pass: narrow override should remove `context`.
    compiler.materializeSessionBundle({
      backendId: "claude",
      sessionDir,
      eventType: "message.received.dm",
      override: { skillSlugs: ["notify"], profileBody: null },
    });
    expect(existsSync(join(skillsRoot, "notify"))).toBe(true);
    expect(existsSync(join(skillsRoot, "context"))).toBe(false);
  });
});

describe("materializeSessionBundle — wiki workspace tokens", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "pa-wiki-skills-"));
    mkdirSync(join(repoRoot, "agent-assets", "agent-profiles"), { recursive: true });
    // WIKI_BUILDER_DESIGN.md §9.1 — wiki skills live under a `wiki/`
    // category subdirectory; slugs stay flat (`wiki-vault-rules` etc.).
    mkdirSync(join(repoRoot, "agent-assets", "skills", "wiki", "wiki-vault-rules"), { recursive: true });
    mkdirSync(join(repoRoot, "agent-assets", "skills", "wiki", "wiki-ingest"), { recursive: true });
    writeFileSync(
      join(repoRoot, "agent-assets", "agent-profiles", "wiki-agent.md"),
      "# Wiki\n\nVault {{vault_path}} language {{language}} workspace {{workspace_name}} schema {{schema_version}}\n",
      "utf-8",
    );
    for (const slug of ["wiki-vault-rules", "wiki-ingest"]) {
      writeFileSync(
        join(repoRoot, "agent-assets", "skills", "wiki", slug, "SKILL.md"),
        `---\nname: ${slug}\ndescription: test\n---\n\nUse {{vault_path}} for {{workspace_name}}.\n`,
        "utf-8",
      );
    }
    setWikiWorkspaceTokenResolver(() => ({
      vault_path: "/tmp/wiki",
      language: "ja",
      workspace_name: "default",
      schema_version: "1",
    }));
  });

  afterEach(() => {
    setWikiWorkspaceTokenResolver(null);
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("substitutes workspace tokens into wiki profiles and skills", () => {
    const sessionDir = join(repoRoot, "session");
    const compiler = new SkillsCompiler(repoRoot);
    compiler.materializeSessionBundle({
      backendId: "claude",
      sessionDir,
      eventType: "wiki.ingest_url",
      processKey: "wiki.ingest_url",
    });

    expect(readFileSync(join(sessionDir, "CLAUDE.md"), "utf-8")).toContain(
      "Vault /tmp/wiki language ja workspace default schema 1",
    );
    expect(
      readFileSync(
        join(sessionDir, ".claude", "skills", "wiki-vault-rules", "SKILL.md"),
        "utf-8",
      ),
    ).toContain("Use /tmp/wiki for default.");
  });

  it("forwards the per-event workspace name to the resolver so multi-workspace installs render the target vault", () => {
    // Regression for the workspace-token resolver bug: the resolver in
    // `index.ts` used to ignore the workspace argument and always look up
    // the default workspace, so a wiki.* event for a non-default vault
    // would render `<wiki_workspace>` XML naming the target while skill
    // prose substituted default-vault tokens.
    const resolverCalls: Array<{ processKey: string; workspaceName?: string }> = [];
    setWikiWorkspaceTokenResolver((processKey, workspaceName) => {
      resolverCalls.push({ processKey, workspaceName });
      const map: Record<string, { root: string; lang: string }> = {
        default: { root: "/tmp/wiki", lang: "ja" },
        personal: { root: "/vaults/personal", lang: "en" },
      };
      const key = workspaceName ?? "default";
      const row = map[key] ?? map.default;
      return {
        vault_path: row.root,
        language: row.lang,
        workspace_name: key,
        schema_version: "1",
      };
    });
    const sessionDir = join(repoRoot, "session-personal");
    const compiler = new SkillsCompiler(repoRoot);
    compiler.materializeSessionBundle({
      backendId: "claude",
      sessionDir,
      eventType: "wiki.ingest_url",
      processKey: "wiki.ingest_url",
      wikiWorkspaceName: "personal",
    });
    expect(resolverCalls.some((c) => c.workspaceName === "personal")).toBe(true);
    expect(readFileSync(join(sessionDir, "CLAUDE.md"), "utf-8")).toContain(
      "Vault /vaults/personal language en workspace personal schema 1",
    );
    expect(
      readFileSync(
        join(sessionDir, ".claude", "skills", "wiki-vault-rules", "SKILL.md"),
        "utf-8",
      ),
    ).toContain("Use /vaults/personal for personal.");
  });

  // `materializeCliSession` has its own independent set of
  // `substituteWikiWorkspaceTokens` call sites (AGENTS.md / GEMINI.md
  // inline render + `.codex/skills/` / `.gemini/skills/` directory copy);
  // assert both backends thread the workspace name end-to-end so the
  // Claude-only test above doesn't leave a CLI-path regression latent.
  it.each([
    { backendId: "codex" as const, instructionFile: "AGENTS.md", skillsRoot: ".codex" },
    { backendId: "gemini" as const, instructionFile: "GEMINI.md", skillsRoot: ".gemini" },
  ])(
    "forwards the workspace name into the $backendId CLI session bundle",
    ({ backendId, instructionFile, skillsRoot }) => {
      setWikiWorkspaceTokenResolver((processKey, workspaceName) => {
        const key = workspaceName ?? "default";
        return {
          vault_path: key === "personal" ? "/vaults/personal" : "/tmp/wiki",
          language: key === "personal" ? "en" : "ja",
          workspace_name: key,
          schema_version: "1",
        };
      });
      const sessionDir = join(repoRoot, `session-${backendId}-personal`);
      // Real callers (`createSessionWorkdir`) create the session dir
      // before invoking `materializeSessionBundle`; `materializeCliSession`
      // writes AGENTS.md / GEMINI.md directly into it without an internal
      // mkdir, so we mirror that contract here.
      mkdirSync(sessionDir, { recursive: true });
      const compiler = new SkillsCompiler(repoRoot);
      compiler.materializeSessionBundle({
        backendId,
        sessionDir,
        eventType: "wiki.ingest_url",
        processKey: "wiki.ingest_url",
        wikiWorkspaceName: "personal",
      });
      const instruction = readFileSync(join(sessionDir, instructionFile), "utf-8");
      // docs/design/appendices/skills-unification.md Phase 1 — only the runtime-profile
      // body lands in the instruction file; skill bodies (which carry
      // the `Use /vaults/personal for personal.` prose) live in the
      // per-backend skill dir and are read on demand.
      expect(instruction).toContain(
        "Vault /vaults/personal language en workspace personal schema 1",
      );
      // The materialised skill copy in the per-backend dir keeps the
      // workspace-token substitution intact — the skill body the agent
      // `Read`s carries the resolved path.
      expect(
        readFileSync(
          join(sessionDir, skillsRoot, "skills", "wiki-vault-rules", "SKILL.md"),
          "utf-8",
        ),
      ).toContain("Use /vaults/personal for personal.");
    },
  );
});

/**
 * `pruneStaleBuiltinSkillDirs` — pure helper, exercised against synthetic
 * dirs to keep the test fast and deterministic.
 */


/**
 * docs/design/appendices/fetch-window-cost-reduction.md Phase 1.5 — `routine.fetch_window`
 * CLI session materialization is diverted to a slim path so Codex /
 * Gemini sessions don't pay the wide path's ~14 K input-token tax.
 *
 * The slim path writes the same `agent-assets/system-prompts/routine-fetch-window.md`
 * template the Claude SDK consumes (Phase 1, single source of truth) and
 * keeps a single skill — `observations` — for the `/api/observations/batch`
 * POST contract. Tests run against the real agent-assets tree so the
 * shipped slim template + observations skill stay aligned with the
 * materializer contract.
 */
describe("materializeSessionBundle — routine.fetch_window CLI slim path (Phase 1.5)", () => {
  const repoRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "..",
  );
  let sessionDir: string;

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), "pa-fetch-window-slim-"));
    // Drop the loader's module-level cache so a stray earlier test (which
    // may have populated it from a different `repoRoot`) cannot leak into
    // the byte-equality assertions below.
    resetFetchWindowSystemPromptForTest();
  });

  afterEach(() => {
    rmSync(sessionDir, { recursive: true, force: true });
  });

  for (const { backendId, instructionFile, cliRoot } of [
    { backendId: "codex" as const, instructionFile: "AGENTS.md", cliRoot: ".codex" },
    { backendId: "gemini" as const, instructionFile: "GEMINI.md", cliRoot: ".gemini" },
  ]) {
    it(`writes the slim Phase 1 template as ${instructionFile} for ${backendId}`, () => {
      const compiler = new SkillsCompiler(repoRoot);
      compiler.materializeSessionBundle({
        backendId,
        sessionDir,
        eventType: "routine.fetch_window",
        processKey: "routine.fetch_window",
      });

      // Read the slim body through the shared loader (the same code path
      // the materializer uses) so this byte-equality check verifies the
      // single-source-of-truth contract end-to-end — including any brand-
      // token substitution the loader applies. Reading the raw .md file
      // here would silently pass the test even if the loader's
      // substitution diverged from the on-disk source.
      const slim = loadFetchWindowSystemPrompt();
      const instruction = readFileSync(join(sessionDir, instructionFile), "utf-8");
      expect(instruction).toBe(slim);
    });

    it(`copies ONLY the observations skill to ${cliRoot}/skills/ for ${backendId}`, () => {
      const compiler = new SkillsCompiler(repoRoot);
      compiler.materializeSessionBundle({
        backendId,
        sessionDir,
        eventType: "routine.fetch_window",
        processKey: "routine.fetch_window",
      });

      const cliSkillsRoot = join(sessionDir, cliRoot, "skills");
      expect(existsSync(join(cliSkillsRoot, "observations", "SKILL.md"))).toBe(true);
      // The four skills the wide fetch_window manifest carries are
      // intentionally omitted — the integration partial inlined into the
      // user prompt is authoritative for their content.
      for (const dropped of ["mail", "notion", "external-services", "attach"]) {
        expect(existsSync(join(cliSkillsRoot, dropped))).toBe(false);
      }
    });

    it(`omits wide-path scaffolding (safety / behavioral rules / daemon-API / multiple skill headings) from the slim ${instructionFile} for ${backendId}`, () => {
      const compiler = new SkillsCompiler(repoRoot);
      compiler.materializeSessionBundle({
        backendId,
        sessionDir,
        eventType: "routine.fetch_window",
        processKey: "routine.fetch_window",
      });
      const instruction = readFileSync(join(sessionDir, instructionFile), "utf-8");
      // Wide path opens with `# {APP_NAME} AGENTS.md` / `# {APP_NAME} GEMINI.md`
      // and emits a `## Behavioral rules` block, a `## Daemon API Usage`
      // block, and a `## Skills` heading that hosts inlined skill bodies.
      // The slim template carries none of those headings — its top-level
      // sections are `## Operating principles`, `## Tool conventions`,
      // `## Boundaries`, `## Output`.
      expect(instruction).not.toContain("## Behavioral rules");
      expect(instruction).not.toContain("## Daemon API Usage");
      expect(instruction).not.toContain("## Skills");
      expect(instruction).not.toMatch(/^# \w+ (AGENTS|GEMINI)\.md/);
      // docs/design/appendices/skills-unification.md Phase 1 item 15 — the slim path does
      // NOT emit a `<skill-index>` block. The fetcher's user prompt
      // inlines the integration partial directly; a skill-index would
      // mis-signal the fetcher to scan for skills before executing the
      // acquisition plan. Pin both the visible tag and the HTML-comment
      // sentinel so a future header-rendering refactor cannot quietly
      // re-introduce either.
      expect(instruction).not.toContain("<skill-index>");
      expect(instruction).not.toContain("<!-- skill-index:start -->");
      // Sanity: the slim sections survive.
      expect(instruction).toContain("## Operating principles");
      expect(instruction).toContain("## Boundaries");
    });

    it(`re-materialization is idempotent and prunes stale skill dirs from a prior wide-path turn (${backendId})`, () => {
      const compiler = new SkillsCompiler(repoRoot);
      // First pass: wide path leaves multiple skill dirs.
      compiler.materializeSessionBundle({
        backendId,
        sessionDir,
        eventType: "message.received.dm",
      });
      const cliSkillsRoot = join(sessionDir, cliRoot, "skills");
      // The DM manifest carries `mail` (verified by other tests in this
      // file); a wide-path turn must leave its directory present so the
      // prune step below has something to clean.
      expect(existsSync(join(cliSkillsRoot, "mail"))).toBe(true);

      // Second pass: fetch_window slim path narrows the surface.
      compiler.materializeSessionBundle({
        backendId,
        sessionDir,
        eventType: "routine.fetch_window",
        processKey: "routine.fetch_window",
      });
      expect(existsSync(join(cliSkillsRoot, "observations", "SKILL.md"))).toBe(true);
      // Stale wide-path skill dirs were pruned.
      expect(existsSync(join(cliSkillsRoot, "mail"))).toBe(false);
    });
  }

  for (const backendId of ["codex", "gemini"] as const) {
    it(`materializeSessionBundle reports only the observations skill in its return value on the slim ${backendId} path`, () => {
      const compiler = new SkillsCompiler(repoRoot);
      const result = compiler.materializeSessionBundle({
        backendId,
        sessionDir,
        eventType: "routine.fetch_window",
        processKey: "routine.fetch_window",
      });
      // Manifest lists 5 skills for fetch_window; the slim path drops 4.
      // The return value is consumed by the workdir log line, so it must
      // tell the truth about what landed on disk — not what the manifest
      // would have asked for in the wide path.
      expect(result.skills).toEqual(["observations"]);
    });

    it(`applies integration-mode filter to the slim ${backendId} observations skill copy (regression for the missing applyIntegrationModeFilter call)`, () => {
      // observations/SKILL.md carries `<!-- mode:<predicate>:notion -->`
      // markers (direct / delegated-same / delegated-cross / native /
      // disabled). With Notion in direct mode, every other branch must
      // be stripped from the materialized copy so the agent doesn't see
      // five copies of conflicting prose.
      const compiler = new SkillsCompiler(repoRoot, new Set(), [], {
        notion: {
          mode: "direct",
          deniedTools: [],
          lastChangedAt: "1970-01-01T00:00:00.000Z",
        },
      });
      compiler.materializeSessionBundle({
        backendId,
        sessionDir,
        eventType: "routine.fetch_window",
        processKey: "routine.fetch_window",
      });
      const skillsRoot =
        backendId === "codex" ? ".codex" : ".gemini";
      const adapted = readFileSync(
        join(sessionDir, skillsRoot, "skills", "observations", "SKILL.md"),
        "utf-8",
      );
      // Mode-filter has run if the unrelated branches are stripped.
      // applyIntegrationModeFilter removes the `<!-- mode:X:Y -->` and
      // `<!-- /mode:X:Y -->` markers themselves AND the prose between
      // them when the predicate doesn't match the integration's state.
      expect(adapted).not.toContain("<!-- mode:delegated-same:notion -->");
      expect(adapted).not.toContain("<!-- mode:native:notion -->");
      expect(adapted).not.toContain("<!-- mode:disabled:notion -->");
    });
  }

  // Single-source-of-truth guard: the slim AGENTS.md / GEMINI.md must be
  // byte-identical to what the Claude SDK gets as `systemPrompt`. Both
  // go through `loadFetchWindowSystemPrompt()`, so if a future edit to
  // the slim template ever drifted the two paths (e.g. one of them
  // wrapped the body, prepended a heading, or skipped substitution),
  // this assertion catches it before agents start behaving differently
  // per backend.
  it("emits a body byte-identical to the loader output across codex and gemini (single-source-of-truth)", () => {
    const compiler = new SkillsCompiler(repoRoot);
    const codexDir = mkdtempSync(join(tmpdir(), "pa-fetch-window-codex-"));
    const geminiDir = mkdtempSync(join(tmpdir(), "pa-fetch-window-gemini-"));
    try {
      compiler.materializeSessionBundle({
        backendId: "codex",
        sessionDir: codexDir,
        eventType: "routine.fetch_window",
        processKey: "routine.fetch_window",
      });
      compiler.materializeSessionBundle({
        backendId: "gemini",
        sessionDir: geminiDir,
        eventType: "routine.fetch_window",
        processKey: "routine.fetch_window",
      });
      const slim = loadFetchWindowSystemPrompt();
      const codexBody = readFileSync(join(codexDir, "AGENTS.md"), "utf-8");
      const geminiBody = readFileSync(join(geminiDir, "GEMINI.md"), "utf-8");
      expect(codexBody).toBe(slim);
      expect(geminiBody).toBe(slim);
      expect(codexBody).toBe(geminiBody);
    } finally {
      rmSync(codexDir, { recursive: true, force: true });
      rmSync(geminiDir, { recursive: true, force: true });
    }
  });

  // Future-proofing guard: brand tokens like `{APP_NAME}` are resolved
  // by the loader. If a template edit ever forgets the substitution
  // contract, the loader output would carry literal `{APP_NAME}` and
  // both the Claude SDK systemPrompt and the CLI AGENTS.md / GEMINI.md
  // would leak the placeholder. Anchor on a negative match so the test
  // documents the contract even when the template doesn't exercise it.
  it("substitutes brand tokens in the slim template (no literal {APP_NAME} reaches the agent)", () => {
    resetFetchWindowSystemPromptForTest();
    const slim = loadFetchWindowSystemPrompt();
    expect(slim).not.toMatch(/\{APP_NAME\}/);
  });

  it("preserves the wide CLI assembly path for non-fetch_window keys (regression guard for the processKey branch)", () => {
    // A `message.received.dm` session for Codex must still receive the
    // wide instruction file: safety preamble, behavioral rules, daemon-
    // API section, and the `## Skills` heading. The Phase 1.5 branch
    // gates on `processKey === "routine.fetch_window"` only.
    const compiler = new SkillsCompiler(repoRoot);
    compiler.materializeSessionBundle({
      backendId: "codex",
      sessionDir,
      eventType: "message.received.dm",
    });
    const agentsMd = readFileSync(join(sessionDir, "AGENTS.md"), "utf-8");
    expect(agentsMd).toContain("## Behavioral rules");
    expect(agentsMd).toContain("## Daemon API Usage");
    expect(agentsMd).toContain("## Skills");
  });
});


describe("materializeOpencodeSession — Phase 4 workdir layout", () => {
  let workspace: string;
  let sessionDir: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "pa-opencode-mat-"));
    sessionDir = mkdtempSync(join(tmpdir(), "pa-opencode-mat-session-"));

    const profilesRoot = join(workspace, "agent-assets", "agent-profiles");
    mkdirSync(profilesRoot, { recursive: true });
    writeFileSync(
      join(profilesRoot, "_safety.md"),
      "## Safety Invariants\n- Do no harm.",
      "utf-8",
    );
    writeFileSync(
      join(profilesRoot, "conversational.md"),
      "# conversational\n\n## Tone\n\nBe friendly.\n",
      "utf-8",
    );

    const mailSkill = join(workspace, "agent-assets", "skills", "mail");
    mkdirSync(mailSkill, { recursive: true });
    writeFileSync(
      join(mailSkill, "SKILL.md"),
      [
        "---",
        "name: mail",
        "description: synthetic mail skill for opencode mat test",
        "---",
        "",
        "# Mail (synthetic)",
        "",
        "Body content for opencode discovery.",
        "",
      ].join("\n"),
      "utf-8",
    );
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  });

  it("writes AGENTS.md, .opencode/agent/<slug>.md, and .opencode/skills/<slug>/", () => {
    const compiler = new SkillsCompiler(workspace);
    compiler.materializeSessionBundle({
      backendId: "opencode",
      sessionDir,
      eventType: "message.received",
    });

    // 1. AGENTS.md exists and contains safety + profile body but NOT
    //    the inlined skill body — opencode auto-discovers skills via
    //    cwd `.opencode/skills/` (docs/design/appendices/skills-unification.md Phase 1
    //    path (c)). The `## Skills` slug manifest is preserved as a
    //    turn-scope hint; the body content is absent.
    const agentsMd = readFileSync(join(sessionDir, "AGENTS.md"), "utf-8");
    expect(agentsMd).toContain("## Safety Invariants");
    expect(agentsMd).toContain("Be friendly");
    expect(agentsMd).not.toContain("Body content for opencode discovery.");
    expect(agentsMd).toContain("- `mail`");
    // docs/design/appendices/skills-unification.md Phase 1 §R3 — OpenCode never gets a
    // `<skill-index>` block. The instruction file carries the slug
    // manifest only; the auto-discovery loader is the source of truth.
    expect(agentsMd).not.toContain("<skill-index>");

    // 2. .opencode/agent/<slug>.md (singular `agent/` per V5) — NOT
    //    `.opencode/agents/` (plural form does not register).
    const profileSlug = "conversational"; // matches PROFILE_RULES for `message.received`
    const agentFile = join(sessionDir, ".opencode", "agent", `${profileSlug}.md`);
    expect(existsSync(agentFile)).toBe(true);
    const agentBody = readFileSync(agentFile, "utf-8");
    expect(agentBody.startsWith("---\n")).toBe(true);
    expect(agentBody).toMatch(/^description:.*conversational/m);
    expect(agentBody).toMatch(/^mode: primary$/m);
    // V5 — no `read` permission key (permission block omitted entirely
    // here, per the writeOpencodeAgentFile contract; server-level
    // permission JSON is the per-session truth).
    expect(agentBody).not.toMatch(/^\s*read:/m);
    // Body still carries safety so an `agent: <slug>` invocation that
    // replaces the cwd context still has the rules in scope.
    expect(agentBody).toContain("## Safety Invariants");
    expect(agentBody).toContain("Be friendly");

    // 3. docs/design/appendices/skills-unification.md Phase 1 — `.opencode/skills/<slug>/`
    //    is the materialised path opencode 1.14+ auto-discovers (V2 path
    //    (c)). `.claude/skills/` is NOT created (path (b) alias is gone).
    const opencodeSkillsDir = join(sessionDir, ".opencode", "skills", "mail");
    expect(existsSync(opencodeSkillsDir)).toBe(true);
    const skillBody = readFileSync(
      join(opencodeSkillsDir, "SKILL.md"),
      "utf-8",
    );
    expect(skillBody).toContain("Body content for opencode discovery.");
    expect(existsSync(join(sessionDir, ".claude", "skills"))).toBe(false);

    // 4. NO `.codex/skills/` or `.gemini/skills/` for an opencode
    //    session — those would only confuse a fallback-rematerialised
    //    workdir if they leaked through.
    expect(existsSync(join(sessionDir, ".codex"))).toBe(false);
    expect(existsSync(join(sessionDir, ".gemini"))).toBe(false);
  });
});


/**
 * `evening-review-slimdown.md` §2.1 / §3.5 — PR 2 behavioural assertions
 * for the materialized workdir on a `routine.evening_review` session.
 * Runs against the real `agent-assets/` tree (REPO_ROOT_REAL pattern) so
 * the cross-backend ergonomics are pinned end-to-end.
 *
 * Two invariants:
 *   1. The dropped `travel` skill must not appear on any backend.
 *   2. The `notify` skill must be conditionally present: absent when the
 *      operator has not authored an evening rulebook, present once at
 *      least one `### ` rule heading exists in `routines/evening.md`.
 */
describe("routine.evening_review session materialization (Phase 2 slimdown)", () => {
  const REPO_ROOT_REAL = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../",
  );

  let contextDir: string;
  let dirs: Record<"claude" | "codex" | "gemini" | "opencode", string>;

  beforeEach(() => {
    contextDir = mkdtempSync(join(tmpdir(), "pa-evening-mat-ctx-"));
    mkdirSync(join(contextDir, "policies", "routines"), { recursive: true });
    dirs = {
      claude: mkdtempSync(join(tmpdir(), "pa-evening-mat-claude-")),
      codex: mkdtempSync(join(tmpdir(), "pa-evening-mat-codex-")),
      gemini: mkdtempSync(join(tmpdir(), "pa-evening-mat-gemini-")),
      opencode: mkdtempSync(join(tmpdir(), "pa-evening-mat-opencode-")),
    };
  });

  afterEach(() => {
    rmSync(contextDir, { recursive: true, force: true });
    for (const d of Object.values(dirs)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  function materialiseAcrossBackends(opts: { contextDir?: string }): void {
    const compiler = new SkillsCompiler(REPO_ROOT_REAL);
    for (const backendId of ["claude", "codex", "gemini", "opencode"] as const) {
      compiler.materializeSessionBundle({
        backendId,
        sessionDir: dirs[backendId],
        eventType: "routine.evening_review",
        processKey: "routine.evening_review",
        ...(opts.contextDir ? { contextDir: opts.contextDir } : {}),
      });
    }
  }

  function expectNoTravel(): void {
    // Claude: `.claude/skills/travel/` must not exist.
    expect(
      existsSync(join(dirs.claude, ".claude", "skills", "travel")),
    ).toBe(false);
    // docs/design/appendices/skills-unification.md Phase 1 — CLI sessions surface dropped
    // skills as absence-from-`<skill-index>` AND absence-from-disk; the
    // body is no longer inlined into AGENTS.md / GEMINI.md.
    const agentsMd = readFileSync(join(dirs.codex, "AGENTS.md"), "utf-8");
    const geminiMd = readFileSync(join(dirs.gemini, "GEMINI.md"), "utf-8");
    expect(agentsMd).not.toMatch(/^- name: travel$/m);
    expect(geminiMd).not.toMatch(/^- name: travel$/m);
    expect(existsSync(join(dirs.codex, ".codex", "skills", "travel"))).toBe(false);
    expect(existsSync(join(dirs.gemini, ".gemini", "skills", "travel"))).toBe(false);
    // docs/design/appendices/skills-unification.md Phase 1 — opencode flipped to
    // `.opencode/skills/`; the absence assertion follows.
    expect(
      existsSync(join(dirs.opencode, ".opencode", "skills", "travel")),
    ).toBe(false);
  }

  function expectNotifyPresent(): void {
    expect(
      existsSync(join(dirs.claude, ".claude", "skills", "notify", "SKILL.md")),
    ).toBe(true);
    const agentsMd = readFileSync(join(dirs.codex, "AGENTS.md"), "utf-8");
    const geminiMd = readFileSync(join(dirs.gemini, "GEMINI.md"), "utf-8");
    // docs/design/appendices/skills-unification.md Phase 1 — `notify` surfaces in the
    // `<skill-index>` block (per-backend) and on disk; inline bodies are
    // gone.
    expect(agentsMd).toMatch(/^- name: notify$/m);
    expect(geminiMd).toMatch(/^- name: notify$/m);
    expect(
      existsSync(join(dirs.codex, ".codex", "skills", "notify", "SKILL.md")),
    ).toBe(true);
    expect(
      existsSync(join(dirs.gemini, ".gemini", "skills", "notify", "SKILL.md")),
    ).toBe(true);
    expect(
      existsSync(join(dirs.opencode, ".opencode", "skills", "notify", "SKILL.md")),
    ).toBe(true);
  }

  function expectNotifyAbsent(): void {
    expect(
      existsSync(join(dirs.claude, ".claude", "skills", "notify")),
    ).toBe(false);
    const agentsMd = readFileSync(join(dirs.codex, "AGENTS.md"), "utf-8");
    const geminiMd = readFileSync(join(dirs.gemini, "GEMINI.md"), "utf-8");
    expect(agentsMd).not.toMatch(/^- name: notify$/m);
    expect(geminiMd).not.toMatch(/^- name: notify$/m);
    expect(existsSync(join(dirs.codex, ".codex", "skills", "notify"))).toBe(false);
    expect(existsSync(join(dirs.gemini, ".gemini", "skills", "notify"))).toBe(false);
    expect(
      existsSync(join(dirs.opencode, ".opencode", "skills", "notify")),
    ).toBe(false);
  }

  it("never materializes the dropped `travel` skill on any backend (rulebook present)", () => {
    writeFileSync(
      join(contextDir, "policies", "routines", "evening.md"),
      "### Stripe metrics\n\nNotify me about churn outliers.\n",
      "utf-8",
    );
    materialiseAcrossBackends({ contextDir });
    expectNoTravel();
  });

  it("never materializes the dropped `travel` skill on any backend (rulebook absent)", () => {
    materialiseAcrossBackends({ contextDir });
    expectNoTravel();
  });

  it("drops notify across every backend when routines/evening.md is absent", () => {
    materialiseAcrossBackends({ contextDir });
    expectNotifyAbsent();
  });

  it("drops notify across every backend when routines/evening.md is empty", () => {
    writeFileSync(join(contextDir, "policies", "routines", "evening.md"), "", "utf-8");
    materialiseAcrossBackends({ contextDir });
    expectNotifyAbsent();
  });

  it("drops notify across every backend when routines/evening.md has no `### ` heading", () => {
    writeFileSync(
      join(contextDir, "policies", "routines", "evening.md"),
      "# Header only\n\nDraft notes — no rules yet.\n",
      "utf-8",
    );
    materialiseAcrossBackends({ contextDir });
    expectNotifyAbsent();
  });

  it("loads notify across every backend when routines/evening.md has at least one `### ` rule", () => {
    writeFileSync(
      join(contextDir, "policies", "routines", "evening.md"),
      [
        "# Evening rules",
        "",
        "### Stripe metrics",
        "Notify me about churn outliers — DM, not just journal.",
        "",
      ].join("\n"),
      "utf-8",
    );
    materialiseAcrossBackends({ contextDir });
    expectNotifyPresent();
  });

  it("falls back to the conservative (notify-off) shape when contextDir is omitted entirely", () => {
    // Production wiring threads `getContextDir(config)` through. Tests
    // and tooling that don't (e.g. a one-off `aitne run-now` invocation
    // pre-context-setup) must still produce a sane workdir; this case
    // pins the slim-only branch so a future "default contextDir to repo
    // root" patch doesn't inadvertently flip the manifest open.
    materialiseAcrossBackends({});
    expectNotifyAbsent();
    expectNoTravel();
  });
});




/**
 * docs/design/appendices/skills-unification.md Phase 1 §"Codex read-sensitive banner" —
 * Codex sessions get a 3-line caveat banner on every materialised skill
 * whose body references a read-sensitive `/api/*` endpoint. Gemini does
 * not (it holds the read-sensitive token). The banner is idempotent —
 * re-running materialisation does not stack copies.
 */
describe("codex read-sensitive banner", () => {
  let workspace: string;
  let sessionDir: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "pa-codex-banner-"));
    sessionDir = mkdtempSync(join(tmpdir(), "pa-codex-banner-session-"));
    const profilesRoot = join(workspace, "agent-assets", "agent-profiles");
    mkdirSync(profilesRoot, { recursive: true });
    writeFileSync(join(profilesRoot, "_safety.md"), "## Safety\n", "utf-8");
    writeFileSync(
      join(profilesRoot, "conversational.md"),
      "# conversational\n\nbody\n",
      "utf-8",
    );
    // `mail` is in the default `message.received` manifest, so the
    // materializer will pick it up.
    const mailSkill = join(workspace, "agent-assets", "skills", "mail");
    mkdirSync(mailSkill, { recursive: true });
    writeFileSync(
      join(mailSkill, "SKILL.md"),
      [
        "---",
        "name: mail",
        "description: mail.",
        "---",
        "",
        "# Mail",
        "",
        "Call `curl http://localhost:8321/api/mail/<accountId>/messages`.",
        "",
      ].join("\n"),
      "utf-8",
    );
    // A non-read-sensitive skill (notify, manifest-listed for message.received)
    // — banner must NOT be prepended even on Codex.
    const notifySkill = join(workspace, "agent-assets", "skills", "notify");
    mkdirSync(notifySkill, { recursive: true });
    writeFileSync(
      join(notifySkill, "SKILL.md"),
      "---\nname: notify\ndescription: notify.\n---\n\nUse `POST /api/notify`.\n",
      "utf-8",
    );
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  });

  it("prepends the banner on Codex skills that touch a read-sensitive endpoint", () => {
    const compiler = new SkillsCompiler(workspace);
    compiler.materializeSessionBundle({
      backendId: "codex",
      sessionDir,
      eventType: "message.received",
    });
    const mailBody = readFileSync(
      join(sessionDir, ".codex", "skills", "mail", "SKILL.md"),
      "utf-8",
    );
    expect(mailBody).toContain("<!-- codex-read-sensitive-banner -->");
    expect(mailBody).toContain("Some endpoints in this skill are read-sensitive");
  });

  it("does NOT prepend on Codex skills with no read-sensitive endpoint", () => {
    const compiler = new SkillsCompiler(workspace);
    compiler.materializeSessionBundle({
      backendId: "codex",
      sessionDir,
      eventType: "message.received",
    });
    const notifyBody = readFileSync(
      join(sessionDir, ".codex", "skills", "notify", "SKILL.md"),
      "utf-8",
    );
    expect(notifyBody).not.toContain("<!-- codex-read-sensitive-banner -->");
  });

  it("does NOT prepend on Gemini (read-sensitive token held)", () => {
    const compiler = new SkillsCompiler(workspace);
    compiler.materializeSessionBundle({
      backendId: "gemini",
      sessionDir,
      eventType: "message.received",
    });
    const mailBody = readFileSync(
      join(sessionDir, ".gemini", "skills", "mail", "SKILL.md"),
      "utf-8",
    );
    expect(mailBody).not.toContain("<!-- codex-read-sensitive-banner -->");
  });
});


/**
 * docs/design/appendices/skills-unification.md Phase 1 — fallback re-materialisation matrix.
 * A workdir initially materialised for `main` and then re-materialised
 * for `fallback` MUST contain both backends' instruction files and skill
 * dirs side-by-side. The matrix iterates every (main, fallback) pair
 * except identity pairs (which short-circuit elsewhere).
 */
describe("fallback re-materialisation matrix", () => {
  let workspace: string;
  let sessionDir: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "pa-fallback-matrix-"));
    sessionDir = mkdtempSync(join(tmpdir(), "pa-fallback-matrix-session-"));
    const profilesRoot = join(workspace, "agent-assets", "agent-profiles");
    mkdirSync(profilesRoot, { recursive: true });
    writeFileSync(join(profilesRoot, "_safety.md"), "## Safety\n", "utf-8");
    writeFileSync(
      join(profilesRoot, "conversational.md"),
      "# conversational\n\nbody\n",
      "utf-8",
    );
    const mailSkill = join(workspace, "agent-assets", "skills", "mail");
    mkdirSync(mailSkill, { recursive: true });
    writeFileSync(
      join(mailSkill, "SKILL.md"),
      "---\nname: mail\ndescription: mail.\n---\n\nbody.\n",
      "utf-8",
    );
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  });

  // docs/design/appendices/skills-unification.md Phase 1 risks row — "Fallback re-materialisation
  // writes the wrong brand dir" demands coverage of EVERY (main, fallback)
  // pair the BackendRouter supports. Four backends × three fallbacks = 12
  // ordered pairs (identity pairs short-circuit upstream and are excluded).
  // Earlier rev3 of this test only enumerated 8 pairs — the four opencode-
  // adjacent ones (codex↔opencode, gemini↔opencode, opencode→{codex,gemini})
  // were missing, leaving the opencode mid-flip path uncovered.
  const PAIRS: ReadonlyArray<{
    main: BackendId;
    fallback: BackendId;
    mainArtefacts: ReadonlyArray<string>;
    fallbackArtefacts: ReadonlyArray<string>;
  }> = [
    {
      main: "claude",
      fallback: "codex",
      mainArtefacts: ["CLAUDE.md", ".claude/skills/mail/SKILL.md"],
      fallbackArtefacts: ["AGENTS.md", ".codex/skills/mail/SKILL.md"],
    },
    {
      main: "claude",
      fallback: "gemini",
      mainArtefacts: ["CLAUDE.md", ".claude/skills/mail/SKILL.md"],
      fallbackArtefacts: ["GEMINI.md", ".gemini/skills/mail/SKILL.md"],
    },
    {
      main: "claude",
      fallback: "opencode",
      mainArtefacts: ["CLAUDE.md", ".claude/skills/mail/SKILL.md"],
      fallbackArtefacts: ["AGENTS.md", ".opencode/skills/mail/SKILL.md"],
    },
    {
      main: "codex",
      fallback: "claude",
      mainArtefacts: ["AGENTS.md", ".codex/skills/mail/SKILL.md"],
      fallbackArtefacts: ["CLAUDE.md", ".claude/skills/mail/SKILL.md"],
    },
    {
      main: "codex",
      fallback: "gemini",
      mainArtefacts: ["AGENTS.md", ".codex/skills/mail/SKILL.md"],
      fallbackArtefacts: ["GEMINI.md", ".gemini/skills/mail/SKILL.md"],
    },
    {
      main: "codex",
      fallback: "opencode",
      mainArtefacts: ["AGENTS.md", ".codex/skills/mail/SKILL.md"],
      fallbackArtefacts: ["AGENTS.md", ".opencode/skills/mail/SKILL.md"],
    },
    {
      main: "gemini",
      fallback: "claude",
      mainArtefacts: ["GEMINI.md", ".gemini/skills/mail/SKILL.md"],
      fallbackArtefacts: ["CLAUDE.md", ".claude/skills/mail/SKILL.md"],
    },
    {
      main: "gemini",
      fallback: "codex",
      mainArtefacts: ["GEMINI.md", ".gemini/skills/mail/SKILL.md"],
      fallbackArtefacts: ["AGENTS.md", ".codex/skills/mail/SKILL.md"],
    },
    {
      main: "gemini",
      fallback: "opencode",
      mainArtefacts: ["GEMINI.md", ".gemini/skills/mail/SKILL.md"],
      fallbackArtefacts: ["AGENTS.md", ".opencode/skills/mail/SKILL.md"],
    },
    {
      main: "opencode",
      fallback: "claude",
      mainArtefacts: ["AGENTS.md", ".opencode/skills/mail/SKILL.md"],
      fallbackArtefacts: ["CLAUDE.md", ".claude/skills/mail/SKILL.md"],
    },
    {
      main: "opencode",
      fallback: "codex",
      mainArtefacts: ["AGENTS.md", ".opencode/skills/mail/SKILL.md"],
      fallbackArtefacts: ["AGENTS.md", ".codex/skills/mail/SKILL.md"],
    },
    {
      main: "opencode",
      fallback: "gemini",
      mainArtefacts: ["AGENTS.md", ".opencode/skills/mail/SKILL.md"],
      fallbackArtefacts: ["GEMINI.md", ".gemini/skills/mail/SKILL.md"],
    },
  ];

  it.each(PAIRS)(
    "$main → $fallback fallback writes both brand dirs into the same workdir",
    ({ main, fallback, mainArtefacts, fallbackArtefacts }) => {
      const compiler = new SkillsCompiler(workspace);
      compiler.materializeSessionBundle({
        backendId: main,
        sessionDir,
        eventType: "message.received",
      });
      for (const rel of mainArtefacts) {
        expect(existsSync(join(sessionDir, rel))).toBe(true);
      }
      compiler.materializeSessionBundle({
        backendId: fallback,
        sessionDir,
        eventType: "message.received",
      });
      for (const rel of fallbackArtefacts) {
        expect(existsSync(join(sessionDir, rel))).toBe(true);
      }
      // Main's instruction file + skill dir must survive the fallback
      // re-materialisation (the workdir is shared between both backends).
      for (const rel of mainArtefacts) {
        expect(existsSync(join(sessionDir, rel))).toBe(true);
      }
    },
  );
});

/**
 * docs/design/appendices/skills-unification.md Phase 1 — Codex / Gemini AGENTS.md / GEMINI.md
 * snapshot guards. Pin the new instruction-file shape so a future refactor
 * that moves the preamble or `<skill-index>` block surfaces here, not at
 * agent runtime.
 */
describe("CLI instruction file — skill preamble + <skill-index> shape", () => {
  let workspace: string;
  let sessionDir: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "pa-cli-shape-"));
    sessionDir = mkdtempSync(join(tmpdir(), "pa-cli-shape-session-"));
    const profilesRoot = join(workspace, "agent-assets", "agent-profiles");
    mkdirSync(profilesRoot, { recursive: true });
    writeFileSync(join(profilesRoot, "_safety.md"), "## Safety\n", "utf-8");
    writeFileSync(
      join(profilesRoot, "conversational.md"),
      "# conversational\n\nbody\n",
      "utf-8",
    );
    const mailSkill = join(workspace, "agent-assets", "skills", "mail");
    mkdirSync(mailSkill, { recursive: true });
    writeFileSync(
      join(mailSkill, "SKILL.md"),
      "---\nname: mail\ndescription: mail skill.\n---\n\nbody.\n",
      "utf-8",
    );
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  });

  it("codex AGENTS.md carries the preamble + `<skill-index>` block; no inlined bodies", () => {
    const compiler = new SkillsCompiler(workspace);
    compiler.materializeSessionBundle({
      backendId: "codex",
      sessionDir,
      eventType: "message.received",
    });
    const agentsMd = readFileSync(join(sessionDir, "AGENTS.md"), "utf-8");
    expect(agentsMd).toContain("## Skills");
    expect(agentsMd).toContain("<skill-index>");
    expect(agentsMd).toContain("</skill-index>");
    expect(agentsMd).toContain(".codex/skills/<name>/SKILL.md");
    expect(agentsMd).toContain("- name: mail");
    expect(agentsMd).toContain("description: mail skill.");
    // Inlined `### mail` body is GONE.
    expect(agentsMd).not.toMatch(/^### mail\b/m);
  });

  it("gemini GEMINI.md mirrors the codex layout under .gemini/skills/", () => {
    const compiler = new SkillsCompiler(workspace);
    compiler.materializeSessionBundle({
      backendId: "gemini",
      sessionDir,
      eventType: "message.received",
    });
    const geminiMd = readFileSync(join(sessionDir, "GEMINI.md"), "utf-8");
    expect(geminiMd).toContain("<skill-index>");
    expect(geminiMd).toContain(".gemini/skills/<name>/SKILL.md");
    expect(geminiMd).toContain("- name: mail");
  });

  it("opencode AGENTS.md does NOT carry a `<skill-index>` block (R3)", () => {
    const compiler = new SkillsCompiler(workspace);
    compiler.materializeSessionBundle({
      backendId: "opencode",
      sessionDir,
      eventType: "message.received",
    });
    const agentsMd = readFileSync(join(sessionDir, "AGENTS.md"), "utf-8");
    expect(agentsMd).not.toContain("<skill-index>");
    expect(agentsMd).toContain("## Skills");
    expect(agentsMd).toContain("- `mail`");
  });

  it("claude CLAUDE.md carries no `<skill-index>` block (SDK auto-discovery)", () => {
    const compiler = new SkillsCompiler(workspace);
    compiler.materializeSessionBundle({
      backendId: "claude",
      sessionDir,
      eventType: "message.received",
    });
    const claudeMd = readFileSync(join(sessionDir, "CLAUDE.md"), "utf-8");
    expect(claudeMd).not.toContain("<skill-index>");
    expect(claudeMd).not.toContain("## Skills");
  });

  it("namespace collision regression — codex session does NOT write `.codex/config.toml` to cwd", () => {
    // Phase 1 risk row: ensure the session workdir layout doesn't leak a
    // file the Codex CLI would walk for cwd-local config (Codex reads
    // `~/.codex/config.toml` only).
    const compiler = new SkillsCompiler(workspace);
    compiler.materializeSessionBundle({
      backendId: "codex",
      sessionDir,
      eventType: "message.received",
    });
    expect(existsSync(join(sessionDir, ".codex", "config.toml"))).toBe(false);
  });

  it("namespace collision regression — gemini session does NOT write `.gemini/extensions/` to cwd", () => {
    // Phase 1 risk row: Gemini CLI's `~/.gemini/extensions/` walker is
    // hard-coded to `homedir()`. Pin that the session workdir layout never
    // leaks a `.gemini/extensions/` dir which a future cwd-walking change
    // upstream could mis-enumerate as a session-local extension source.
    const compiler = new SkillsCompiler(workspace);
    compiler.materializeSessionBundle({
      backendId: "gemini",
      sessionDir,
      eventType: "message.received",
    });
    expect(existsSync(join(sessionDir, ".gemini", "extensions"))).toBe(false);
  });

  it("R2 placement order — codex AGENTS.md emits Safety → Character → preamble → <skill-index> → Runtime profile (which carries the routing table)", () => {
    // Phase 1 §R2 — "Snapshot test pins exact placement so the CLI's
    // 'how to use → what's available' reading order is preserved." The
    // existing `toContain` substring assertions don't pin order; this
    // test does. Any refactor that moves the preamble above `## Character`
    // or below `## Runtime profile` surfaces here. The character is forced
    // non-empty so the optional `## Character (user-defined)` block is
    // exercised (the spec wording anchors on Character explicitly).
    const compiler = new SkillsCompiler(
      workspace,
      undefined,
      undefined,
      undefined,
      "Test persona.",
    );
    compiler.materializeSessionBundle({
      backendId: "codex",
      sessionDir,
      eventType: "message.received",
    });
    const agentsMd = readFileSync(join(sessionDir, "AGENTS.md"), "utf-8");
    // Anchor on the unique HTML-comment splice sentinels for the index
    // block. The visible `<skill-index>` tag can legitimately appear in
    // other prose (the Daemon-API 401 banner references it by name to
    // tell the agent where to look) — only the sentinels are guaranteed
    // unique by design (see `SKILL_INDEX_START_SENTINEL`).
    const safetyIdx = agentsMd.indexOf("## Safety");
    const characterIdx = agentsMd.indexOf("## Character");
    const preambleIdx = agentsMd.indexOf("## Skills");
    const indexStartIdx = agentsMd.indexOf("<!-- skill-index:start -->");
    const indexEndIdx = agentsMd.indexOf("<!-- skill-index:end -->");
    const runtimeProfileIdx = agentsMd.indexOf("## Runtime profile");
    // Every anchor must be present.
    expect(safetyIdx).toBeGreaterThanOrEqual(0);
    expect(characterIdx).toBeGreaterThanOrEqual(0);
    expect(preambleIdx).toBeGreaterThanOrEqual(0);
    expect(indexStartIdx).toBeGreaterThanOrEqual(0);
    expect(indexEndIdx).toBeGreaterThanOrEqual(0);
    expect(runtimeProfileIdx).toBeGreaterThanOrEqual(0);
    // Strict ordering: Safety < Character < preamble (## Skills) <
    //   `<!-- skill-index:start -->` < `<!-- skill-index:end -->` <
    //   Runtime profile (which substitutes the
    //   `<integration-routing-table>` placeholder downstream).
    expect(safetyIdx).toBeLessThan(characterIdx);
    expect(characterIdx).toBeLessThan(preambleIdx);
    expect(preambleIdx).toBeLessThan(indexStartIdx);
    expect(indexStartIdx).toBeLessThan(indexEndIdx);
    expect(indexEndIdx).toBeLessThan(runtimeProfileIdx);
  });
});


/**
 * skills-unification.md Test plan — U12 / U14 / U15.
 *
 * - U12: OpenCode AGENTS.md never carries `<skill-index>` (R3) — verified
 *        across the four most common event manifests, not just
 *        `message.received`.
 * - U14: Codex session does NOT write `.codex/config.toml` into the cwd
 *        (Risks row "Codex `.codex/` namespace collision"). Only
 *        `.codex/skills/` is permitted.
 * - U15: Gemini session writes both `.gemini/skills/` and the Safe-mode
 *        whitelist surface in a way that does not stomp the other.
 */
describe("namespace coexistence — codex/gemini cwd dotfile guards (U14 / U15)", () => {
  let workspace: string;
  let sessionDir: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "pa-ns-coexist-"));
    sessionDir = mkdtempSync(join(tmpdir(), "pa-ns-coexist-session-"));
    const profilesRoot = join(workspace, "agent-assets", "agent-profiles");
    mkdirSync(profilesRoot, { recursive: true });
    writeFileSync(join(profilesRoot, "_safety.md"), "## Safety\n", "utf-8");
    writeFileSync(
      join(profilesRoot, "conversational.md"),
      "# conversational\n\nbody\n",
      "utf-8",
    );
    const mailSkill = join(workspace, "agent-assets", "skills", "mail");
    mkdirSync(mailSkill, { recursive: true });
    writeFileSync(
      join(mailSkill, "SKILL.md"),
      "---\nname: mail\ndescription: mail.\n---\n\nbody.\n",
      "utf-8",
    );
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  });

  it("U14 — codex session writes only `.codex/skills/`; no `.codex/config.toml` leaks into cwd", () => {
    const compiler = new SkillsCompiler(workspace);
    compiler.materializeSessionBundle({
      backendId: "codex",
      sessionDir,
      eventType: "message.received",
    });
    const codexDir = join(sessionDir, ".codex");
    expect(existsSync(codexDir)).toBe(true);
    // Sibling brand dirs must be absent.
    expect(existsSync(join(sessionDir, ".claude"))).toBe(false);
    expect(existsSync(join(sessionDir, ".gemini"))).toBe(false);
    expect(existsSync(join(sessionDir, ".opencode"))).toBe(false);
    // The cwd `.codex/` should be skills-only — no config.toml / auth.json.
    expect(existsSync(join(codexDir, "config.toml"))).toBe(false);
    expect(existsSync(join(codexDir, "auth.json"))).toBe(false);
    const entries = readdirSync(codexDir);
    expect(entries).toEqual(expect.arrayContaining(["skills"]));
    for (const e of entries) {
      expect(
        ["skills"].includes(e),
        `Unexpected entry under .codex/: ${e}. Only skills/ is permitted in cwd.`,
      ).toBe(true);
    }
  });

  it("U15 — gemini session writes `.gemini/skills/`; sibling brand dirs absent", () => {
    const compiler = new SkillsCompiler(workspace);
    compiler.materializeSessionBundle({
      backendId: "gemini",
      sessionDir,
      eventType: "message.received",
    });
    const geminiDir = join(sessionDir, ".gemini");
    expect(existsSync(geminiDir)).toBe(true);
    expect(existsSync(join(geminiDir, "skills", "mail", "SKILL.md"))).toBe(true);
    // Sibling brand dirs must NOT exist.
    expect(existsSync(join(sessionDir, ".claude"))).toBe(false);
    expect(existsSync(join(sessionDir, ".codex"))).toBe(false);
    expect(existsSync(join(sessionDir, ".opencode"))).toBe(false);
    // If a settings.json is written by some other materialiser pass, it
    // must coexist with skills/ (i.e. is itself a file, not a directory
    // shadowing skills/).
    const settingsPath = join(geminiDir, "settings.json");
    if (existsSync(settingsPath)) {
      const stat = readFileSync(settingsPath, "utf-8");
      expect(stat.length).toBeGreaterThan(0);
    }
  });
});

/**
 * skills-unification.md Test plan — U12 row.
 *
 * The existing `materializeOpencodeSession — Phase 4 workdir layout`
 * describe pins R3 (no `<skill-index>` in AGENTS.md) for
 * `message.received` only. Extend across the four most common event
 * manifests so a future routine that re-adds the block surfaces here,
 * not in a live OpenCode session.
 */
describe("OpenCode AGENTS.md never carries <skill-index> across manifests (U12)", () => {
  let workspace: string;
  let sessionDir: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "pa-opencode-u12-"));
    sessionDir = mkdtempSync(join(tmpdir(), "pa-opencode-u12-session-"));
    const profilesRoot = join(workspace, "agent-assets", "agent-profiles");
    mkdirSync(profilesRoot, { recursive: true });
    writeFileSync(join(profilesRoot, "_safety.md"), "## Safety\n", "utf-8");
    writeFileSync(
      join(profilesRoot, "conversational.md"),
      "# conversational\n\nbody\n",
      "utf-8",
    );
    writeFileSync(
      join(profilesRoot, "routine.md"),
      "# routine\n\nroutine body\n",
      "utf-8",
    );
    const mailSkill = join(workspace, "agent-assets", "skills", "mail");
    mkdirSync(mailSkill, { recursive: true });
    writeFileSync(
      join(mailSkill, "SKILL.md"),
      "---\nname: mail\ndescription: mail.\n---\n\nbody.\n",
      "utf-8",
    );
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  });

  const EVENTS = [
    "message.received",
    "routine.morning_routine",
    "routine.evening_review",
    "routine.hourly_check",
  ] as const;

  it.each(EVENTS)(
    "%s — OpenCode AGENTS.md contains zero `<skill-index>` substrings",
    (eventType) => {
      const compiler = new SkillsCompiler(workspace);
      // Use a fresh session dir per iteration so we don't accumulate state.
      const sd = mkdtempSync(join(tmpdir(), "pa-opencode-u12-iter-"));
      try {
        compiler.materializeSessionBundle({
          backendId: "opencode",
          sessionDir: sd,
          eventType,
        });
        const agentsMd = readFileSync(join(sd, "AGENTS.md"), "utf-8");
        expect(agentsMd).not.toContain("<skill-index>");
        expect(agentsMd).not.toContain("<!-- skill-index:start -->");
      } finally {
        rmSync(sd, { recursive: true, force: true });
      }
    },
  );
});

/**
 * skills-unification.md Test plan — U13 row.
 *
 * For Codex / Gemini sessions, the slugs enumerated in the
 * `<skill-index>` block must be exactly the set of slugs that exist
 * on disk under `<sessionDir>/.<backend>/skills/<slug>/SKILL.md` —
 * not the raw manifest. A drift between the two means the agent
 * could be told to `Read` a SKILL.md that the variant-resolver or
 * mode-filter elided.
 */
describe("CLI <skill-index> matches on-disk slug set (U13)", () => {
  let workspace: string;
  let sessionDir: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "pa-u13-"));
    sessionDir = mkdtempSync(join(tmpdir(), "pa-u13-session-"));
    const profilesRoot = join(workspace, "agent-assets", "agent-profiles");
    mkdirSync(profilesRoot, { recursive: true });
    writeFileSync(join(profilesRoot, "_safety.md"), "## Safety\n", "utf-8");
    writeFileSync(
      join(profilesRoot, "conversational.md"),
      "# conversational\n\nbody\n",
      "utf-8",
    );
    // Two skills present on disk + one that the variant resolver drops
    // by virtue of not existing for this backend (no SKILL.md at all).
    for (const slug of ["mail", "context"]) {
      const dir = join(workspace, "agent-assets", "skills", slug);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "SKILL.md"),
        `---\nname: ${slug}\ndescription: ${slug} test.\n---\n\nbody.\n`,
        "utf-8",
      );
    }
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  });

  function diskSlugs(dir: string): Set<string> {
    if (!existsSync(dir)) return new Set();
    const out = new Set<string>();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (existsSync(join(dir, entry.name, "SKILL.md"))) {
        out.add(entry.name);
      }
    }
    return out;
  }

  function indexSlugs(indexBlock: string): Set<string> {
    const out = new Set<string>();
    for (const line of indexBlock.split("\n")) {
      const m = line.match(/^[-*]\s*name:\s*([a-z0-9-]+)/);
      if (m) out.add(m[1]);
    }
    return out;
  }

  it.each(["codex", "gemini"] as const)(
    "%s session: every slug in <skill-index> has a matching SKILL.md on disk",
    (backend) => {
      const compiler = new SkillsCompiler(workspace);
      compiler.materializeSessionBundle({
        backendId: backend,
        sessionDir,
        eventType: "message.received",
      });
      const instructionFile = backend === "codex" ? "AGENTS.md" : "GEMINI.md";
      const instructionPath = join(sessionDir, instructionFile);
      const skillsDir = join(sessionDir, `.${backend}`, "skills");
      const onDisk = diskSlugs(skillsDir);
      const body = readFileSync(instructionPath, "utf-8");
      // Extract the index block delimited by <!-- skill-index:start -->
      // and <!-- skill-index:end -->.
      const start = body.indexOf("<!-- skill-index:start -->");
      const end = body.indexOf("<!-- skill-index:end -->");
      expect(start, `${instructionFile} missing skill-index start marker`).toBeGreaterThanOrEqual(0);
      expect(end, `${instructionFile} missing skill-index end marker`).toBeGreaterThan(start);
      const indexed = indexSlugs(body.slice(start, end));
      // Both sets must be non-empty (else the test is a no-op).
      expect(onDisk.size).toBeGreaterThan(0);
      expect(indexed.size).toBeGreaterThan(0);
      // Every indexed slug must have a SKILL.md on disk.
      for (const slug of indexed) {
        expect(
          onDisk.has(slug),
          `<skill-index> lists "${slug}" but ${skillsDir}/${slug}/SKILL.md is missing`,
        ).toBe(true);
      }
    },
  );
});

// AGENT_DEFINITIONS_DESIGN.md §4.2 — `extraSkills` (a firing Agent's
// `tools.skills`) is composed onto the process-key manifest and reaches disk.
// Closes the last link the dispatcher (extraSkills → execute) and the pure
// `composeSkillSet` unit tests don't cover: the actual on-disk materialisation.
describe("materializeSessionBundle — Agent extraSkills override", () => {
  let workspace: string;
  let sessionDir: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "pa-extra-skills-"));
    sessionDir = mkdtempSync(join(tmpdir(), "pa-extra-skills-session-"));
    const profilesRoot = join(workspace, "agent-assets", "agent-profiles");
    mkdirSync(profilesRoot, { recursive: true });
    writeFileSync(join(profilesRoot, "_safety.md"), "## Safety\n- Do no harm.", "utf-8");
    writeFileSync(
      join(profilesRoot, "conversational.md"),
      "# conversational\n\n## Tone\n\nBe friendly.\n",
      "utf-8",
    );
    // A skill that is NOT in any process-key manifest — only an Agent's
    // `tools.skills` can pull it in. If it lands on disk, the override worked.
    const extraSkill = join(workspace, "agent-assets", "skills", "synthetic-extra");
    mkdirSync(extraSkill, { recursive: true });
    writeFileSync(
      join(extraSkill, "SKILL.md"),
      "---\nname: synthetic-extra\ndescription: synthetic extra skill for the override test\n---\n\n# Synthetic Extra\n",
      "utf-8",
    );
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  });

  const extraSkillMd = (): string =>
    join(sessionDir, ".claude", "skills", "synthetic-extra", "SKILL.md");

  it("materializes a skill that the process-key manifest never lists", () => {
    const compiler = new SkillsCompiler(workspace);
    const deployed = compiler.materializeSessionBundle({
      backendId: "claude",
      sessionDir,
      eventType: "message.received",
      extraSkills: ["synthetic-extra"],
    });
    expect(existsSync(extraSkillMd())).toBe(true);
    expect(deployed.skills).toContain("synthetic-extra");
  });

  it("is a no-op when extraSkills is omitted (manifest-only behaviour preserved)", () => {
    const compiler = new SkillsCompiler(workspace);
    const deployed = compiler.materializeSessionBundle({
      backendId: "claude",
      sessionDir,
      eventType: "message.received",
    });
    expect(existsSync(extraSkillMd())).toBe(false);
    expect(deployed.skills).not.toContain("synthetic-extra");
  });

  it("skillsReplace: true drops the manifest bundle, keeping only the extra slug", () => {
    const compiler = new SkillsCompiler(workspace);
    const deployed = compiler.materializeSessionBundle({
      backendId: "claude",
      sessionDir,
      eventType: "message.received",
      extraSkills: ["synthetic-extra"],
      skillsReplace: true,
    });
    expect(deployed.skills).toEqual(["synthetic-extra"]);
    expect(existsSync(extraSkillMd())).toBe(true);
  });
});
