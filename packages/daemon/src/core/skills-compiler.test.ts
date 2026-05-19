import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
import {
  applyAllDeniedToolsForSkill,
  applyDeniedTools,
  buildSameBackendDenyBlock,
  cliInstructionFileName,
  cliSkillsDirName,
  EMPTY_MAIL_ACCOUNTS_MD,
  isValidSkillSlug,
  logger as skillsCompilerLogger,
  missingDelegatedVariants,
  missingNativeVariants,
  parseSkillFrontmatter,
  pruneStaleBuiltinSkillDirs,
  READ_SENSITIVE_API_PREFIXES,
  refreshSkillIndexBlock,
  renderMailAccountsMd,
  renderPartialIncludes,
  renderReferenceIncludes,
  renderSkillIndexBlock,
  rewriteCharacterBlock,
  setWikiWorkspaceTokenResolver,
  SkillsCompiler,
  SKILL_DESCRIPTION_MAX_LENGTH,
  stripUnconfiguredServices,
  validateBuiltinSkillSourceTree,
} from "./skills-compiler.js";
import { listReadSensitiveGetPathKeys } from "../safety/risk-classifier.js";
import {
  loadFetchWindowSystemPrompt,
  resetFetchWindowSystemPromptForTest,
} from "./fetch-window-prompt-loader.js";
import type { MailAccount } from "../services/mail/provider.js";
import {
  APP_NAME,
  INTEGRATION_DESCRIPTORS,
  INTEGRATION_KEYS,
  type BackendId,
  type IntegrationKey,
} from "@aitne/shared";

/**
 * Unit tests for the `{{> base }}` partial-include renderer (§4.7 composition
 * pattern). Covers the three observable branches — no directive present,
 * directive with a readable base file, directive with a missing base file —
 * plus the frontmatter-strip contract that keeps variant files from
 * double-counting YAML headers.
 */
describe("renderPartialIncludes", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pa-partial-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns content unchanged when no directive is present", () => {
    const content = "# Some skill\n\nNothing to include here.\n";
    const basePath = join(dir, "SKILL.base.md");
    writeFileSync(basePath, "SHOULD_NOT_BE_READ", "utf-8");
    expect(renderPartialIncludes(content, basePath)).toBe(content);
  });

  it("inlines the base file verbatim (frontmatter stripped)", () => {
    const basePath = join(dir, "SKILL.base.md");
    writeFileSync(
      basePath,
      "---\nname: mail\ndescription: mail base\n---\n\nShared body prose.",
      "utf-8",
    );
    const variant = "# mail delegated\n\n{{> base }}\n\nBackend-specific suffix.\n";
    const out = renderPartialIncludes(variant, basePath);
    expect(out).toContain("Shared body prose.");
    expect(out).not.toContain("---");
    expect(out).not.toContain("description: mail base");
    expect(out).toContain("Backend-specific suffix.");
  });

  it("drops the directive silently when the base file is missing", () => {
    const basePath = join(dir, "SKILL.base.md"); // never created
    const variant = "Before\n{{> base }}\nAfter\n";
    const out = renderPartialIncludes(variant, basePath);
    expect(out).toBe("Before\n\nAfter\n");
  });

  it("replaces every occurrence when the directive appears multiple times", () => {
    const basePath = join(dir, "SKILL.base.md");
    writeFileSync(basePath, "BASE_PROSE", "utf-8");
    const variant = "{{> base }} — then {{> base }}\n";
    expect(renderPartialIncludes(variant, basePath)).toBe(
      "BASE_PROSE — then BASE_PROSE\n",
    );
  });

  it("handles a base file without frontmatter", () => {
    const basePath = join(dir, "SKILL.base.md");
    writeFileSync(basePath, "plain body\n", "utf-8");
    expect(renderPartialIncludes("{{> base }}", basePath)).toBe("plain body");
  });
});

/**
 * Unit tests for the `{{> ref:<name> }}` intra-skill reference resolver
 * (SKILLS-PHASE-2-PLAN.md §3.1). Mirrors the `renderPartialIncludes`
 * suite above — same shape, different surface. Cases #1-#7 cover the
 * resolver in isolation; case #14 pins the (intentional) lack of
 * fence-awareness so a later fence-aware refactor lands as a deliberate
 * change with its own test update.
 */
describe("renderReferenceIncludes", () => {
  let skillDir: string;

  beforeEach(() => {
    skillDir = mkdtempSync(join(tmpdir(), "pa-ref-"));
    mkdirSync(join(skillDir, "references"), { recursive: true });
  });

  afterEach(() => {
    rmSync(skillDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns content unchanged when no directive is present", () => {
    const input = "# Some skill\n\nNothing to include here.\n";
    // Reference-equality, not just structural — guards against an
    // over-eager regex that touches similar markdown by re-emitting an
    // identical string.
    expect(renderReferenceIncludes(input, skillDir)).toBe(input);
  });

  it("inlines `references/<name>.md` (frontmatter stripped) when the directive is present", () => {
    writeFileSync(
      join(skillDir, "references", "providers.md"),
      "---\nkind: reference\nparent_skill: mail\n---\n## Providers\n\nGmail, Outlook, IMAP.\n",
      "utf-8",
    );
    const body = "# mail\n\n{{> ref:providers }}\n";
    const out = renderReferenceIncludes(body, skillDir);
    expect(out).toContain("## Providers");
    expect(out).toContain("Gmail, Outlook, IMAP.");
    // YAML delimiters and frontmatter keys must not leak into the rendered body.
    expect(out).not.toContain("kind: reference");
    expect(out).not.toContain("parent_skill: mail");
    // The reference file's own `---\n...\n---\n` opener must not survive.
    const yamlOpener = out.split("\n").slice(0, 5).join("\n");
    expect(yamlOpener).not.toMatch(/^---\s*$/m);
  });

  it("drops the directive silently (logs WARN) when `references/<name>.md` is missing", () => {
    const warnSpy = vi.spyOn(skillsCompilerLogger, "warn");
    const body = "Before\n{{> ref:nope }}\nAfter\n";
    const out = renderReferenceIncludes(body, skillDir);
    // Marker site collapses to an empty string; surrounding lines remain.
    expect(out).toBe("Before\n\nAfter\n");
    // Pin the WARN call so a future change that swaps the logger or drops
    // the warning surfaces here rather than in a far-removed CI alert.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ skillSrcDir: skillDir, name: "nope" }),
      expect.stringContaining("missing reference file"),
    );
  });

  it("replaces every occurrence of the same directive (no caching across occurrences)", () => {
    writeFileSync(
      join(skillDir, "references", "foo.md"),
      "FOO_BODY",
      "utf-8",
    );
    const body = "{{> ref:foo }} — then {{> ref:foo }}\n";
    expect(renderReferenceIncludes(body, skillDir)).toBe(
      "FOO_BODY — then FOO_BODY\n",
    );

    // Pin the no-caching contract behaviorally: a second call with a
    // mutated reference file picks up the new content. (`node:fs`'s ESM
    // exports are non-configurable in vitest, so a `readFileSync` spy is
    // not available — the mutation-then-call pattern is the cheapest
    // observable proxy for "reads happen at expansion time, not cached
    // across calls". A future caching refactor that breaks this would
    // either surface here or land as a deliberate change with this
    // assertion updated.)
    writeFileSync(
      join(skillDir, "references", "foo.md"),
      "BAR_BODY",
      "utf-8",
    );
    expect(renderReferenceIncludes(body, skillDir)).toBe(
      "BAR_BODY — then BAR_BODY\n",
    );
  });

  it("handles a reference file without frontmatter", () => {
    writeFileSync(
      join(skillDir, "references", "foo.md"),
      "## Foo\n\nPlain body.\n",
      "utf-8",
    );
    const out = renderReferenceIncludes("{{> ref:foo }}", skillDir);
    // `stripFrontmatter` is a no-op when no `---` opener exists —
    // output starts directly with the heading.
    expect(out.startsWith("## Foo")).toBe(true);
    expect(out).toContain("Plain body.");
  });

  it("rejects path-traversal directives at the regex level (output unchanged, escaped file not inlined)", () => {
    // Even with a sibling file that would resolve a traversal, the
    // strict-kebab regex must reject the directive before any FS lookup.
    // (`node:fs`'s ESM exports are non-configurable in vitest, so we
    // can't directly assert `existsSync` was never called — instead we
    // verify the behavioral evidence: output is byte-identical to input
    // AND the would-be-leaked content does NOT appear, which is the
    // strongest user-facing guarantee.)
    writeFileSync(join(skillDir, "secret.md"), "ESCAPED_SECRET", "utf-8");
    const body = "{{> ref:../secret }}\n";
    const out = renderReferenceIncludes(body, skillDir);
    expect(out).toBe(body);
    expect(out).not.toContain("ESCAPED_SECRET");
  });

  it("rejects directives with uppercase or underscore characters", () => {
    // `[a-z][a-z0-9-]*` is strict-kebab; `Foo` and `foo_bar` both fail.
    writeFileSync(join(skillDir, "references", "Foo.md"), "X", "utf-8");
    writeFileSync(join(skillDir, "references", "foo_bar.md"), "Y", "utf-8");
    const body = "{{> ref:Foo }} and {{> ref:foo_bar }}\n";
    expect(renderReferenceIncludes(body, skillDir)).toBe(body);
  });

  it("expands `{{> ref:foo }}` even inside a triple-backtick markdown fence (pinned, not fence-aware)", () => {
    // Phase 2 v1's resolver matches `renderPartialIncludes` semantics —
    // it does NOT respect markdown fences. This test PINS that
    // behaviour so a fence-aware refactor (later phase) lands as a
    // deliberate change with its own test update, not a silent
    // regression. (Risk row 1 in §6.)
    writeFileSync(
      join(skillDir, "references", "foo.md"),
      "FOO_BODY",
      "utf-8",
    );
    const body = "Before\n```\n{{> ref:foo }}\n```\nAfter\n";
    const out = renderReferenceIncludes(body, skillDir);
    expect(out).toContain("FOO_BODY");
    // The fence is preserved; only the directive inside it is replaced.
    expect(out).toContain("```");
  });
});

/**
 * docs/design/appendices/skills-unification.md Phase 1 §R6 — `adaptSkillForCli` is deleted.
 * Source SKILL.md frontmatter is now byte-identical across all four
 * backends post-materialisation; no per-backend frontmatter fork.
 * `when_to_use:` has been stripped from every built-in SKILL.md (sister
 * doc Phase 0.1) so the field is no longer part of the schema. Coverage
 * for the new compile path lives in `renderSkillIndexBlock` /
 * `parseSkillFrontmatter` / `validateBuiltinSkillSourceTree` tests below.
 */
describe("parseSkillFrontmatter", () => {
  it("extracts single-line `name` and `description`", () => {
    const out = parseSkillFrontmatter(
      "---\nname: mail\ndescription: Load when reading mail.\n---\n# body\n",
    );
    expect(out.name).toBe("mail");
    expect(out.description).toBe("Load when reading mail.");
  });

  it("returns null fields when no frontmatter", () => {
    const out = parseSkillFrontmatter("# body only\n");
    expect(out).toEqual({ name: null, description: null });
  });

  it("returns null fields when frontmatter is unclosed", () => {
    const out = parseSkillFrontmatter("---\nname: x\n");
    expect(out).toEqual({ name: null, description: null });
  });
});

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
 * Unit tests for the `<!-- service:<name> -->` conditional-section stripper.
 * Protects the contract that external-services/SKILL.md only ships sections
 * for services the user has configured — a drift here has been cited as a
 * risk in the skills audit because the same body is consumed by both the
 * direct SKILL.md and the delegated variants after partial-include expansion.
 */
describe("stripUnconfiguredServices", () => {
  const body = [
    "prelude",
    "<!-- service:obsidian -->",
    "OBS BODY",
    "<!-- /service:obsidian -->",
    "mid",
    "<!-- service:calendar -->",
    "CAL BODY",
    "<!-- /service:calendar -->",
    "<!-- service:notion -->",
    "NOTION BODY",
    "<!-- /service:notion -->",
    "tail",
  ].join("\n");

  it("returns content unchanged when configuredServices is empty (fresh install)", () => {
    // Empty set means "user hasn't configured anything yet" — the agent
    // should see the full menu, not an empty shell. The function
    // short-circuits in that case; only once at least one service is
    // configured does the stripping kick in.
    expect(stripUnconfiguredServices(body, new Set())).toBe(body);
  });

  it("drops sections whose key is absent from configuredServices", () => {
    const out = stripUnconfiguredServices(body, new Set(["obsidian"]));
    expect(out).toContain("OBS BODY");
    expect(out).not.toContain("CAL BODY");
    expect(out).not.toContain("NOTION BODY");
  });

  it("preserves text outside service-delimited blocks untouched", () => {
    const out = stripUnconfiguredServices(body, new Set(["obsidian"]));
    expect(out).toContain("prelude");
    expect(out).toContain("mid");
    expect(out).toContain("tail");
  });

  it("is a no-op when the body contains no service delimiters", () => {
    const plain = "# Skill\n\nNo service blocks here.\n";
    expect(stripUnconfiguredServices(plain, new Set(["obsidian"]))).toBe(plain);
  });

  it("keeps multiple configured services side-by-side", () => {
    const out = stripUnconfiguredServices(body, new Set(["calendar", "notion"]));
    expect(out).not.toContain("OBS BODY");
    expect(out).toContain("CAL BODY");
    expect(out).toContain("NOTION BODY");
  });
});

/**
 * Unit tests for `missingDelegatedVariants`. Consumed by
 * `/api/integrations/:key` (pre-commit reject when the user flips to
 * delegated) and `/health.integrationModes.*.variantsMissing`; silent bugs
 * here would let a delegated-mode flip succeed with no variant file on
 * disk, dropping the session back to direct `/api/*` calls that the route
 * middleware then 410-gates.
 *
 * The real skill slugs and task-flow keys come from the shared
 * `INTEGRATION_DESCRIPTORS` registry, so the test sets up a miniature
 * `agent-assets/` tree mirroring what the registry declares.
 */
describe("missingDelegatedVariants", () => {
  let workspace: string;
  let skillsRoot: string;
  let taskFlowsRoot: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "pa-variants-"));
    skillsRoot = join(workspace, "agent-assets", "skills");
    taskFlowsRoot = join(workspace, "agent-assets", "task-flows");
    mkdirSync(join(skillsRoot, "mail"), { recursive: true });
    mkdirSync(join(skillsRoot, "external-services"), { recursive: true });
    mkdirSync(taskFlowsRoot, { recursive: true });
    // INTEGRATION_NATIVE_MODE_DESIGN.md §8.1 — `message.received.dm` /
    // `message.received.dm_first` are listed in gmail/google_calendar/
    // notion `taskFlowsTouched` so the native DM variants resolve. Their
    // delegated variants are intentionally absent (the base files carry
    // inline mode markers). `missingVariantsForMode` accepts a missing
    // variant when the base file exists. Write the base files here so
    // these tests focus on the variants that actually MUST exist on disk.
    writeFileSync(
      join(taskFlowsRoot, "message.received.dm.md"),
      "placeholder base dm\n",
      "utf-8",
    );
    writeFileSync(
      join(taskFlowsRoot, "message.received.dm_first.md"),
      "placeholder base dm_first\n",
      "utf-8",
    );
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  function writeVariant(relPath: string) {
    writeFileSync(join(workspace, relPath), "placeholder\n", "utf-8");
  }

  it("DELEGATED-MODE-V2 §4.1.1 — gmail × claude: same-backend resolves to null (no skill body), so only the cross-backend variants for codex / gemini sessions are required, plus the hourly_check task-flow for all three session backends", () => {
    writeVariant("agent-assets/skills/mail/SKILL.delegated.codex.md");
    writeVariant("agent-assets/skills/mail/SKILL.delegated.gemini.md");
    writeVariant("agent-assets/task-flows/routine.hourly_check.delegated.claude.md");
    writeVariant("agent-assets/task-flows/routine.hourly_check.delegated.codex.md");
    writeVariant("agent-assets/task-flows/routine.hourly_check.delegated.gemini.md");
    const result = missingDelegatedVariants(workspace, "gmail", "claude");
    expect(result).toEqual({ skills: [], taskFlows: [] });
  });

  it("DELEGATED-MODE-V2 §4.1.1 — gmail × codex: same-backend (codex) resolves null; cross-backend variants for claude / gemini sessions are required", () => {
    writeVariant("agent-assets/skills/mail/SKILL.delegated.claude.md");
    writeVariant("agent-assets/skills/mail/SKILL.delegated.gemini.md");
    writeVariant("agent-assets/task-flows/routine.hourly_check.delegated.claude.md");
    writeVariant("agent-assets/task-flows/routine.hourly_check.delegated.codex.md");
    writeVariant("agent-assets/task-flows/routine.hourly_check.delegated.gemini.md");
    const result = missingDelegatedVariants(workspace, "gmail", "codex");
    expect(result).toEqual({ skills: [], taskFlows: [] });
  });

  it("DELEGATED-MODE-V2 §4.1.1 — google_calendar × claude needs external-services {codex, gemini} variants + hourly_check {claude, codex, gemini} variants", () => {
    writeVariant("agent-assets/skills/external-services/SKILL.delegated.codex.md");
    writeVariant("agent-assets/skills/external-services/SKILL.delegated.gemini.md");
    writeVariant("agent-assets/task-flows/routine.hourly_check.delegated.claude.md");
    writeVariant("agent-assets/task-flows/routine.hourly_check.delegated.codex.md");
    writeVariant("agent-assets/task-flows/routine.hourly_check.delegated.gemini.md");
    const result = missingDelegatedVariants(workspace, "google_calendar", "claude");
    expect(result).toEqual({ skills: [], taskFlows: [] });
  });

  it("DELEGATED-MODE-V2 §4.1.1 — gmail surfaces every cross-backend skill variant + every session-backend task-flow variant when none exist on disk", () => {
    const result = missingDelegatedVariants(workspace, "gmail", "claude");
    // claude is the delegatedBackend → same-backend → null → no file required.
    // codex / gemini are cross-backend → SKILL.delegated.<sessionBackend>.md
    // required for each.
    expect(result.skills.sort()).toEqual([
      join(skillsRoot, "mail", "SKILL.delegated.codex.md"),
      join(skillsRoot, "mail", "SKILL.delegated.gemini.md"),
    ].sort());
    // selectTaskFlowVariantSuffix returns `delegated.<sessionBackend>` for
    // every session backend when any touched integration is delegated.
    expect(result.taskFlows.sort()).toEqual([
      join(taskFlowsRoot, "routine.hourly_check.delegated.claude.md"),
      join(taskFlowsRoot, "routine.hourly_check.delegated.codex.md"),
      join(taskFlowsRoot, "routine.hourly_check.delegated.gemini.md"),
    ].sort());
  });

  it("DELEGATED-MODE-V2 §4.1.1 — notion × claude: same-backend skill resolves null; cross-backend variants for codex / gemini sessions are required", () => {
    mkdirSync(join(skillsRoot, "notion"), { recursive: true });
    const result = missingDelegatedVariants(workspace, "notion", "claude");
    expect(result.skills.sort()).toEqual([
      join(skillsRoot, "notion", "SKILL.delegated.codex.md"),
      join(skillsRoot, "notion", "SKILL.delegated.gemini.md"),
    ].sort());
    expect(result.taskFlows.sort()).toEqual([
      join(taskFlowsRoot, "routine.hourly_check.delegated.claude.md"),
      join(taskFlowsRoot, "routine.hourly_check.delegated.codex.md"),
      join(taskFlowsRoot, "routine.hourly_check.delegated.gemini.md"),
    ].sort());
  });
});

/**
 * Integrity test against the real `agent-assets/` tree. Catches the class
 * of bug where the integrations registry advertises a `taskFlowsTouched`
 * entry (or `skillsTouched` slug) that has no `*.delegated.<backend>.md`
 * file on disk — a state in which `PATCH /api/integrations/:key` rejects
 * every delegated flip with HTTP 400 `missing_variants`, making delegated
 * mode unreachable for that integration. The unit tests above exercise
 * the helper in synthetic workspaces; this test pins the real registry
 * against the real assets so adding a touch entry without authoring the
 * matching file fails loudly.
 */
describe("missingDelegatedVariants — real agent-assets integrity", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

  for (const integrationKey of INTEGRATION_KEYS) {
    const descriptor = INTEGRATION_DESCRIPTORS[integrationKey];
    const declaredBackends = Object.keys(descriptor.backendConnectors) as BackendId[];

    for (const backendId of declaredBackends) {
      it(`${integrationKey} → ${backendId}: every advertised variant exists on disk`, () => {
        const result = missingDelegatedVariants(
          repoRoot,
          integrationKey as IntegrationKey,
          backendId,
        );
        expect(result).toEqual({ skills: [], taskFlows: [] });
      });
    }
  }
});

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

describe("applyDeniedTools (§7.7)", () => {
  it("removes denied entries from a Claude allowed-tools block list", () => {
    const skillBody = `---
name: notion
description: Notion delegated
allowed-tools:
  - Bash(curl *)
  - mcp__claude_ai_Notion__notion-search
  - mcp__claude_ai_Notion__notion-create-database
  - mcp__claude_ai_Notion__notion-update-data-source
---

# body
`;
    const out = applyDeniedTools(skillBody, "notion", "claude", [
      "notion-create-database",
      "notion-update-data-source",
    ]);
    expect(out).toContain("- mcp__claude_ai_Notion__notion-search");
    expect(out).not.toContain("notion-create-database");
    expect(out).not.toContain("notion-update-data-source");
    // Other frontmatter fields preserved.
    expect(out).toContain("name: notion");
    expect(out).toContain("description: Notion delegated");
    // Body untouched.
    expect(out).toContain("# body");
  });

  it("handles the inline-array allowed-tools form", () => {
    const skillBody = `---
name: notion
allowed-tools: [mcp__claude_ai_Notion__notion-search, mcp__claude_ai_Notion__notion-create-database]
---
body
`;
    const out = applyDeniedTools(skillBody, "notion", "claude", [
      "notion-create-database",
    ]);
    expect(out).toContain("mcp__claude_ai_Notion__notion-search");
    expect(out).not.toContain("notion-create-database");
  });

  it("appends a soft-enforcement deny block on Codex", () => {
    const skillBody = `---
name: notion
description: Notion delegated codex
---

# body
`;
    const out = applyDeniedTools(skillBody, "notion", "codex", [
      "notion_create_database",
    ]);
    expect(out).toContain("## Denied tools (do not invoke)");
    expect(out).toContain("`mcp__codex_apps__notion._notion_create_database`");
    // Frontmatter intact.
    expect(out).toContain("name: notion");
    expect(out).toContain("# body");
  });

  it("re-running on a body with a prior deny block replaces it (idempotent on changed list)", () => {
    let out = `---
name: notion
---

# body
`;
    out = applyDeniedTools(out, "notion", "codex", ["notion_create_database"]);
    out = applyDeniedTools(out, "notion", "codex", ["notion_update_data_source"]);
    // Old entry is gone, new entry is present, only one deny block.
    const denyHeadings = out.match(/## Denied tools \(do not invoke\)/g);
    expect(denyHeadings).toHaveLength(1);
    expect(out).not.toContain("notion_create_database");
    expect(out).toContain("notion_update_data_source");
  });

  it("silently ignores stale entries that don't match the active backend's tool universe", () => {
    // `notion-create-database` is the Claude name; passing it to a Codex
    // backend should leave content unchanged (filterDeniedToolsForBackend
    // drops it as stale).
    const skillBody = `---
name: notion
---
body
`;
    const out = applyDeniedTools(skillBody, "notion", "codex", [
      "notion-create-database",
    ]);
    expect(out).toBe(skillBody);
  });

  it("returns input unchanged when deniedTools is empty", () => {
    const body = "---\nname: x\n---\nbody\n";
    expect(applyDeniedTools(body, "notion", "claude", [])).toBe(body);
  });

  // The "input unchanged when descriptor has no connector for backend"
  // branch is reserved for future integrations that omit a backend.
  // Today every (integrationKey, BackendId) pair has a connector.
});

describe("applyAllDeniedToolsForSkill (§7.7 — per-integration aggregation)", () => {
  it("applies the deny pass for each integration whose skillsTouched matches the skill", () => {
    const skillBody = `---
name: notion
allowed-tools:
  - mcp__claude_ai_Notion__notion-search
  - mcp__claude_ai_Notion__notion-create-database
---
body
`;
    const out = applyAllDeniedToolsForSkill(skillBody, "notion", "claude", {
      notion: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: ["notion-create-database"],
        lastChangedAt: "2026-04-25T00:00:00Z",
      },
    });
    expect(out).not.toContain("notion-create-database");
    expect(out).toContain("notion-search");
  });

  it("no-ops when integration is not delegated", () => {
    const body = "---\nname: x\n---\nbody\n";
    const out = applyAllDeniedToolsForSkill(body, "notion", "claude", {
      notion: {
        mode: "direct",
        deniedTools: ["notion-create-database"],
        lastChangedAt: "2026-04-25T00:00:00Z",
      },
    });
    expect(out).toBe(body);
  });

  it("no-ops when delegatedBackend doesn't match the session backend", () => {
    // User picked Codex but we're materializing for Claude — the deny list
    // is ineligible (different namespace).
    const body = "---\nname: x\n---\nbody\n";
    const out = applyAllDeniedToolsForSkill(body, "notion", "claude", {
      notion: {
        mode: "delegated",
        delegatedBackend: "codex",
        deniedTools: ["notion_create_database"],
        lastChangedAt: "2026-04-25T00:00:00Z",
      },
    });
    expect(out).toBe(body);
  });

  it("no-ops when the integration's deniedTools is empty", () => {
    const body = "---\nname: x\n---\nbody\n";
    const out = applyAllDeniedToolsForSkill(body, "notion", "claude", {
      notion: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-04-25T00:00:00Z",
      },
    });
    expect(out).toBe(body);
  });

  it("skips skills not declared in any integration's skillsTouched", () => {
    const body = "---\nname: x\n---\nbody\n";
    // `today` is not in any descriptor's skillsTouched, so passing it
    // through should leave content untouched even with denied entries set.
    const out = applyAllDeniedToolsForSkill(body, "today", "claude", {
      notion: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: ["notion-create-database"],
        lastChangedAt: "2026-04-25T00:00:00Z",
      },
    });
    expect(out).toBe(body);
  });

  it("applies the deny pass via deniedToolsAppliesToSkills (kept for symmetry with non-default-variant cases)", () => {
    // DELEGATED-MODE-V2 Phase 3.4 restored `skillsTouched: ["mail"]` on
    // gmail, so the OR-arm `deniedToolsAppliesToSkills` is structurally
    // redundant for the default case. Pinned anyway because the v2
    // design explicitly keeps the field.
    const skillBody = `---
name: mail
allowed-tools:
  - Bash(curl *)
  - mcp__claude_ai_Gmail__search_threads
  - mcp__claude_ai_Gmail__create_draft
---
body
`;
    const out = applyAllDeniedToolsForSkill(skillBody, "mail", "claude", {
      gmail: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: ["create_draft"],
        lastChangedAt: "2026-04-25T00:00:00Z",
      },
    });
    expect(out).not.toContain("mcp__claude_ai_Gmail__create_draft");
    expect(out).toContain("mcp__claude_ai_Gmail__search_threads");
  });

  it("deniedToolsAppliesToSkills is also wired for google_calendar → external-services", () => {
    const skillBody = `---
name: external-services
allowed-tools:
  - Bash(curl *)
  - mcp__claude_ai_Google_Calendar__list_events
  - mcp__claude_ai_Google_Calendar__delete_event
---
body
`;
    const out = applyAllDeniedToolsForSkill(skillBody, "external-services", "claude", {
      google_calendar: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: ["delete_event"],
        lastChangedAt: "2026-04-25T00:00:00Z",
      },
    });
    expect(out).not.toContain("mcp__claude_ai_Google_Calendar__delete_event");
    expect(out).toContain("mcp__claude_ai_Google_Calendar__list_events");
  });
});

/**
 * Pure-helper unit coverage for exports that were previously only exercised
 * indirectly via session materialization. Covers `cliSkillsDirName`,
 * `renderMailAccountsMd` + `EMPTY_MAIL_ACCOUNTS_MD`, and
 * `buildSameBackendDenyBlock`. These are pinned here so a future refactor
 * (e.g. unifying skills-dir naming, restructuring the deny-block heading)
 * surfaces in a focused failure rather than in a far-removed integration
 * test that is harder to map back to the regression.
 */
describe("cliSkillsDirName", () => {
  it("returns null for claude (Claude uses a separate `.claude/skills/` path)", () => {
    expect(cliSkillsDirName("claude")).toBeNull();
  });

  it("returns `.codex` for the codex backend", () => {
    expect(cliSkillsDirName("codex")).toBe(".codex");
  });

  it("returns `.gemini` for the gemini backend", () => {
    expect(cliSkillsDirName("gemini")).toBe(".gemini");
  });

  // docs/design/appendices/skills-unification.md Phase 1 — opencode flipped from path (b)
  // (`.claude/skills/` redundancy-avoiding alias) to path (c)
  // (`.opencode/skills/`). The helper now exposes that namespace so
  // `materializeOpencodeSession` and downstream tooling stay in sync.
  it("returns `.opencode` for the opencode backend", () => {
    expect(cliSkillsDirName("opencode")).toBe(".opencode");
  });
});

function makeMailAccount(overrides: Partial<MailAccount> = {}): MailAccount {
  return {
    id: "acct-1",
    kind: "gmail",
    email: "user@example.com",
    authStatus: "healthy",
    idleEnabled: false,
    active: true,
    createdAt: "2026-04-01T00:00:00Z",
    ...overrides,
  };
}

describe("renderMailAccountsMd", () => {
  it("renders an empty table (header + separator only) when no accounts are passed", () => {
    const out = renderMailAccountsMd([]);
    expect(out).toContain("| accountId | kind | email | transport |");
    expect(out).toContain("|---|---|---|---|");
    // No data rows — the only backtick-quoted ids should be zero. Use a
    // count rather than `not.toMatch` so we don't accidentally allow a
    // single stray row to slip through.
    const rowMatches = out.match(/^\| `[^`]+\|/gm) ?? [];
    expect(rowMatches.length).toBe(0);
  });

  it("renders one row per account with backtick-quoted ids and kind/email columns", () => {
    const out = renderMailAccountsMd([
      makeMailAccount({ id: "g1", kind: "gmail", email: "a@x.com" }),
      makeMailAccount({ id: "o1", kind: "outlook", email: "b@y.com" }),
    ]);
    expect(out).toContain("| `g1` | gmail | a@x.com");
    expect(out).toContain("| `o1` | outlook | b@y.com");
  });

  it("appends ` (label)` after the email when an account has a non-empty label", () => {
    const out = renderMailAccountsMd([
      makeMailAccount({ id: "a", email: "owner@example.com", label: "Personal" }),
    ]);
    expect(out).toContain("owner@example.com (Personal)");
  });

  it("omits the label suffix when label is undefined", () => {
    const out = renderMailAccountsMd([
      makeMailAccount({ id: "a", email: "owner@example.com" }),
    ]);
    // Catches a regression that would render `email ()` from a falsy-but-string label.
    expect(out).not.toMatch(/owner@example\.com \(/);
  });

  it("emits `IDLE` for idleEnabled=true accounts and `poll` otherwise", () => {
    const out = renderMailAccountsMd([
      makeMailAccount({ id: "idle", idleEnabled: true }),
      makeMailAccount({ id: "polling", idleEnabled: false }),
    ]);
    // Anchored on the trailing pipe to ensure we're matching the transport
    // column, not a stray `IDLE` substring elsewhere.
    expect(out).toMatch(/\| `idle` \| .* \| IDLE \|/);
    expect(out).toMatch(/\| `polling` \| .* \| poll \|/);
  });
});

describe("EMPTY_MAIL_ACCOUNTS_MD", () => {
  it("instructs the agent to refuse account guessing and stop", () => {
    // Pinned because the materializer falls back to this constant when the
    // active-mail-accounts list is empty; a wording drift that softens the
    // refusal would invite the agent to invent account ids.
    expect(EMPTY_MAIL_ACCOUNTS_MD).toContain("# Mail accounts");
    expect(EMPTY_MAIL_ACCOUNTS_MD).toContain("do NOT guess account ids");
    expect(EMPTY_MAIL_ACCOUNTS_MD).toContain("stop");
  });
});

describe("buildSameBackendDenyBlock", () => {
  it("returns null when no integrations declare denied tools for the session backend", () => {
    expect(
      buildSameBackendDenyBlock(
        {
          gmail: {
            mode: "delegated",
            delegatedBackend: "claude",
            deniedTools: [],
            lastChangedAt: "2026-04-25T00:00:00Z",
          },
        },
        "claude",
      ),
    ).toBeNull();
  });

  it("returns null when integrations are delegated to a different backend than the session", () => {
    // gmail is delegated to codex but the session is claude — collectSessionDeniedTools
    // filters by `delegatedBackend === sessionBackend`, so nothing is contributed.
    expect(
      buildSameBackendDenyBlock(
        {
          gmail: {
            mode: "delegated",
            delegatedBackend: "codex",
            deniedTools: ["create_draft"],
            lastChangedAt: "2026-04-25T00:00:00Z",
          },
        },
        "claude",
      ),
    ).toBeNull();
  });

  it("returns null when integrations are in direct mode", () => {
    expect(
      buildSameBackendDenyBlock(
        {
          gmail: {
            mode: "direct",
            deniedTools: ["create_draft"],
            lastChangedAt: "2026-04-25T00:00:00Z",
          },
        },
        "claude",
      ),
    ).toBeNull();
  });

  it("renders the heading + a per-integration subsection with namespaced tool names", () => {
    const block = buildSameBackendDenyBlock(
      {
        gmail: {
          mode: "delegated",
          delegatedBackend: "claude",
          deniedTools: ["create_draft"],
          lastChangedAt: "2026-04-25T00:00:00Z",
        },
      },
      "claude",
    );
    expect(block).not.toBeNull();
    expect(block).toContain("## Denied tools (per-integration)");
    expect(block).toContain("### gmail");
    // The block must namespace the unsuffixed name with the connector's
    // `toolNamespace` — a regression that drops the prefix would let the
    // agent invoke the bare tool unfiltered.
    expect(block).toContain("`mcp__claude_ai_Gmail__create_draft`");
  });

  it("aggregates multiple integrations into separate subsections in registry order", () => {
    const block = buildSameBackendDenyBlock(
      {
        gmail: {
          mode: "delegated",
          delegatedBackend: "claude",
          deniedTools: ["create_draft"],
          lastChangedAt: "2026-04-25T00:00:00Z",
        },
        google_calendar: {
          mode: "delegated",
          delegatedBackend: "claude",
          deniedTools: ["delete_event"],
          lastChangedAt: "2026-04-25T00:00:00Z",
        },
      },
      "claude",
    );
    expect(block).not.toBeNull();
    expect(block).toContain("### gmail");
    expect(block).toContain("### google_calendar");
    expect(block).toContain("`mcp__claude_ai_Gmail__create_draft`");
    expect(block).toContain("`mcp__claude_ai_Google_Calendar__delete_event`");
  });

  it("ignores stale denied entries that don't map to any tool in the active backend's connector", () => {
    // `not_a_real_capability` doesn't appear in the gmail/claude connector's
    // capabilityTools, so filterDeniedToolsForBackend strips it. With nothing
    // else to render, the block collapses back to null.
    expect(
      buildSameBackendDenyBlock(
        {
          gmail: {
            mode: "delegated",
            delegatedBackend: "claude",
            deniedTools: ["not_a_real_capability"],
            lastChangedAt: "2026-04-25T00:00:00Z",
          },
        },
        "claude",
      ),
    ).toBeNull();
  });
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
describe("pruneStaleBuiltinSkillDirs", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "pa-prune-"));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  // `listBuiltinSlugs` (and therefore `pruneStaleBuiltinSkillDirs`)
  // recognises a directory as a built-in slug only when it carries an
  // actual SKILL.md — empty fixture dirs no longer count, which keeps
  // category subdirectories like `wiki/` from being treated as a slug.
  it("removes built-in dirs not in `keep`", () => {
    const source = join(workspace, "agent-assets", "skills");
    const dest = join(workspace, "session", ".claude", "skills");
    mkdirSync(join(source, "alpha"), { recursive: true });
    mkdirSync(join(source, "beta"), { recursive: true });
    writeFileSync(join(source, "alpha", "SKILL.md"), "---\nname: alpha\n---\n");
    writeFileSync(join(source, "beta", "SKILL.md"), "---\nname: beta\n---\n");
    mkdirSync(join(dest, "alpha"), { recursive: true });
    mkdirSync(join(dest, "beta"), { recursive: true });
    pruneStaleBuiltinSkillDirs(dest, source, ["alpha"]);
    expect(existsSync(join(dest, "alpha"))).toBe(true);
    expect(existsSync(join(dest, "beta"))).toBe(false);
  });

  it("leaves user-authored dirs alone (not in source tree)", () => {
    const source = join(workspace, "agent-assets", "skills");
    const dest = join(workspace, "session", ".claude", "skills");
    mkdirSync(join(source, "alpha"), { recursive: true });
    writeFileSync(join(source, "alpha", "SKILL.md"), "---\nname: alpha\n---\n");
    mkdirSync(join(dest, "alpha"), { recursive: true });
    mkdirSync(join(dest, "user-skill"), { recursive: true });
    pruneStaleBuiltinSkillDirs(dest, source, []);
    expect(existsSync(join(dest, "alpha"))).toBe(false);
    expect(existsSync(join(dest, "user-skill"))).toBe(true);
  });

  // WIKI_BUILDER_DESIGN.md §9.1 — wiki slugs live nested under
  // `skills/wiki/<slug>/`. The prune helper must treat those nested
  // slugs as built-ins so a stale wiki-* dir in the session workdir
  // gets cleaned up when the manifest narrows.
  it("recognises category-nested slugs (skills/wiki/<slug>) as built-ins", () => {
    const source = join(workspace, "agent-assets", "skills");
    const dest = join(workspace, "session", ".claude", "skills");
    mkdirSync(join(source, "wiki", "wiki-vault-rules"), { recursive: true });
    writeFileSync(
      join(source, "wiki", "wiki-vault-rules", "SKILL.md"),
      "---\nname: wiki-vault-rules\n---\n",
    );
    mkdirSync(join(dest, "wiki-vault-rules"), { recursive: true });
    pruneStaleBuiltinSkillDirs(dest, source, []);
    expect(existsSync(join(dest, "wiki-vault-rules"))).toBe(false);
  });

  it("is a no-op when `dest` does not exist", () => {
    const source = join(workspace, "agent-assets", "skills");
    mkdirSync(source, { recursive: true });
    expect(() =>
      pruneStaleBuiltinSkillDirs(
        join(workspace, "missing"),
        source,
        ["anything"],
      ),
    ).not.toThrow();
  });
});

/**
 * INTEGRATION_NATIVE_MODE_DESIGN.md §7.4 / §12.3 — native-mode skill
 * variant resolution. Mirrors the existing `missingDelegatedVariants`
 * unit tests but pinned on the new `missingNativeVariants` helper.
 * Consumed by `PATCH /api/integrations/:key` pre-commit (rejects a
 * native flip if any variant file is missing on disk) and by
 * `/health.integrationModes.<key>.variantsMissing`. Silent bugs here
 * would let a native flip succeed against an unauthored variant.
 */
describe("missingNativeVariants", () => {
  let workspace: string;
  let skillsRoot: string;
  let taskFlowsRoot: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "pa-native-variants-"));
    skillsRoot = join(workspace, "agent-assets", "skills");
    taskFlowsRoot = join(workspace, "agent-assets", "task-flows");
    mkdirSync(join(skillsRoot, "mail"), { recursive: true });
    mkdirSync(join(skillsRoot, "external-services"), { recursive: true });
    mkdirSync(join(skillsRoot, "notion"), { recursive: true });
    mkdirSync(taskFlowsRoot, { recursive: true });
    // Mirror the delegated-variant tests' setup: write the base DM /
    // dm_first files so the `missingVariantsForMode` leniency check
    // accepts the absence of `message.received.dm.native.<backend>.md`
    // for the OTHER session backends (the helper only requires the
    // native binding's backend variant, but the loader path needs the
    // base file to fall back to for completeness).
    writeFileSync(
      join(taskFlowsRoot, "message.received.dm.md"),
      "placeholder base dm\n",
      "utf-8",
    );
    writeFileSync(
      join(taskFlowsRoot, "message.received.dm_first.md"),
      "placeholder base dm_first\n",
      "utf-8",
    );
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  function writeVariant(relPath: string) {
    writeFileSync(join(workspace, relPath), "placeholder\n", "utf-8");
  }

  it("§5.4.1 — gmail × claude: native binding requires only the SKILL.native.claude.md skill variant + the routine.hourly_check.native.claude.md task-flow variant; other session backends resolve to `disabled` and need no file", () => {
    // Native is always same-backend by construction. A claude binding
    // therefore only needs the variant authored for claude sessions —
    // codex / gemini sessions land on `disabled` per §5.4.1's safety
    // degrade and need no file.
    writeVariant("agent-assets/skills/mail/SKILL.native.claude.md");
    writeVariant("agent-assets/task-flows/routine.hourly_check.native.claude.md");
    const result = missingNativeVariants(workspace, "gmail", "claude");
    expect(result).toEqual({ skills: [], taskFlows: [] });
  });

  it("§5.4.1 — gmail × codex: native binding requires the codex variant only", () => {
    writeVariant("agent-assets/skills/mail/SKILL.native.codex.md");
    writeVariant("agent-assets/task-flows/routine.hourly_check.native.codex.md");
    const result = missingNativeVariants(workspace, "gmail", "codex");
    expect(result).toEqual({ skills: [], taskFlows: [] });
  });

  it("§5.4.1 — gmail × gemini: native binding requires the gemini variant only", () => {
    writeVariant("agent-assets/skills/mail/SKILL.native.gemini.md");
    writeVariant("agent-assets/task-flows/routine.hourly_check.native.gemini.md");
    const result = missingNativeVariants(workspace, "gmail", "gemini");
    expect(result).toEqual({ skills: [], taskFlows: [] });
  });

  it("§8.5 — surfaces both the missing skill variant AND task-flow variant when neither exists on disk", () => {
    const result = missingNativeVariants(workspace, "gmail", "claude");
    expect(result.skills).toEqual([
      join(skillsRoot, "mail", "SKILL.native.claude.md"),
    ]);
    expect(result.taskFlows).toEqual([
      join(taskFlowsRoot, "routine.hourly_check.native.claude.md"),
    ]);
  });

  it("§5.4.1 — google_calendar × codex: native binding requires the external-services native.codex.md skill + hourly_check.native.codex.md task-flow", () => {
    writeVariant("agent-assets/skills/external-services/SKILL.native.codex.md");
    writeVariant("agent-assets/task-flows/routine.hourly_check.native.codex.md");
    const result = missingNativeVariants(workspace, "google_calendar", "codex");
    expect(result).toEqual({ skills: [], taskFlows: [] });
  });

  it("§5.4.1 — notion × gemini: native binding requires only the gemini variant (gemini ships a user-installed Notion MCP descriptor)", () => {
    writeVariant("agent-assets/skills/notion/SKILL.native.gemini.md");
    writeVariant("agent-assets/task-flows/routine.hourly_check.native.gemini.md");
    const result = missingNativeVariants(workspace, "notion", "gemini");
    expect(result).toEqual({ skills: [], taskFlows: [] });
  });

  it("§7.4 — same-backend native ALWAYS emits an explicit skill body (no `sameBackendDropsSkillBody` shortcut). The notion descriptor declares `sameBackendDropsSkillBody: ['notion']` for the delegated path, but native must emit SKILL.native.claude.md regardless.", () => {
    // The descriptor's `sameBackendDropsSkillBody: ["notion"]` flag
    // resolves to `null` for `same-backend` delegated AND every
    // touched integration declares the slug in that set. Native must
    // not honour the flag — §7.5 of the design pins explicit native
    // bodies. With no variant on disk, the helper surfaces it.
    const result = missingNativeVariants(workspace, "notion", "claude");
    expect(result.skills).toContain(
      join(skillsRoot, "notion", "SKILL.native.claude.md"),
    );
  });
});

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

/**
 * docs/design/appendices/fetch-window-cost-reduction.md §14 — `cliInstructionFileName`
 * helper. Single source of truth so the wide path
 * (`materializeCliSession`) and the slim path
 * (`materializeFetchWindowCliSession`) can never drift on which file
 * name to write.
 */
describe("cliInstructionFileName", () => {
  it("returns the auto-discovered filename for each non-Claude backend", () => {
    expect(cliInstructionFileName("codex")).toBe("AGENTS.md");
    expect(cliInstructionFileName("opencode")).toBe("AGENTS.md");
    expect(cliInstructionFileName("gemini")).toBe("GEMINI.md");
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

describe("isValidSkillSlug — docs/design/appendices/opencode-backend.md §10 D6", () => {
  it("accepts lowercase alphanumeric + hyphen up to 64 chars", () => {
    expect(isValidSkillSlug("mail")).toBe(true);
    expect(isValidSkillSlug("user-profile")).toBe(true);
    expect(isValidSkillSlug("a")).toBe(true);
    expect(isValidSkillSlug("a".repeat(64))).toBe(true);
    expect(isValidSkillSlug("with-123-numbers")).toBe(true);
  });

  it("rejects names that opencode would silently drop", () => {
    expect(isValidSkillSlug("")).toBe(false);
    expect(isValidSkillSlug("a".repeat(65))).toBe(false);
    expect(isValidSkillSlug("Has-Capital")).toBe(false);
    expect(isValidSkillSlug("under_score")).toBe(false);
    expect(isValidSkillSlug("space inside")).toBe(false);
    expect(isValidSkillSlug("dot.separator")).toBe(false);
  });

  it("regression — every checked-in built-in skill slug conforms", () => {
    // Audit: walk `agent-assets/skills/` and assert every directory
    // name passes the lint. Catches a future skill addition that
    // accidentally introduces an invalid slug before opencode silently
    // rejects it at runtime. The `existsSync` import is already
    // available at module scope; the path resolution mirrors the
    // workspace root the test run already binds.
    // Resolve relative to this test file: `packages/daemon/src/core/`
    // ↑ four dirs up reaches the workspace root.
    const here = dirname(fileURLToPath(import.meta.url));
    const skillsRoot = resolve(here, "..", "..", "..", "..", "agent-assets", "skills");
    if (!existsSync(skillsRoot)) {
      // Non-standard layout — skip without failing; the direct
      // conformance assertions above still cover the lint behaviour.
      return;
    }
    for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // Top-level slugs only — nested category dirs like `wiki/<slug>/`
      // are walked separately through `listBuiltinSlugs` in production.
      expect(isValidSkillSlug(entry.name)).toBe(true);
    }
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
    mkdirSync(join(contextDir, "routines"), { recursive: true });
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
      join(contextDir, "routines", "evening.md"),
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
    writeFileSync(join(contextDir, "routines", "evening.md"), "", "utf-8");
    materialiseAcrossBackends({ contextDir });
    expectNotifyAbsent();
  });

  it("drops notify across every backend when routines/evening.md has no `### ` heading", () => {
    writeFileSync(
      join(contextDir, "routines", "evening.md"),
      "# Header only\n\nDraft notes — no rules yet.\n",
      "utf-8",
    );
    materialiseAcrossBackends({ contextDir });
    expectNotifyAbsent();
  });

  it("loads notify across every backend when routines/evening.md has at least one `### ` rule", () => {
    writeFileSync(
      join(contextDir, "routines", "evening.md"),
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
 * docs/design/appendices/skills-unification.md Phase 1 — `renderSkillIndexBlock` covers the
 * two failure cases (empty dir + dir-walk skipping non-frontmatter files)
 * and the happy path (sorted, post-materialisation listing).
 */
describe("renderSkillIndexBlock", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pa-skill-index-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("emits the empty marker when no skills materialised", () => {
    const out = renderSkillIndexBlock(dir, ".codex/skills");
    expect(out).toContain("<skill-index>");
    expect(out).toContain("</skill-index>");
    expect(out).toContain("(No skills materialized this turn");
    expect(out).toContain(".codex/skills/<name>/SKILL.md");
  });

  it("lists every materialised slug with name + description (sorted)", () => {
    mkdirSync(join(dir, "today"), { recursive: true });
    mkdirSync(join(dir, "notify"), { recursive: true });
    writeFileSync(
      join(dir, "today", "SKILL.md"),
      "---\nname: today\ndescription: Owns today.md reads and writes.\n---\nbody\n",
      "utf-8",
    );
    writeFileSync(
      join(dir, "notify", "SKILL.md"),
      "---\nname: notify\ndescription: Universal message discipline.\n---\nbody\n",
      "utf-8",
    );
    const out = renderSkillIndexBlock(dir, ".gemini/skills");
    expect(out).toContain(".gemini/skills/<name>/SKILL.md");
    // Sorted alphabetically — `notify` before `today`.
    const notifyIdx = out.indexOf("- name: notify");
    const todayIdx = out.indexOf("- name: today");
    expect(notifyIdx).toBeGreaterThan(-1);
    expect(todayIdx).toBeGreaterThan(notifyIdx);
    expect(out).toContain("description: Universal message discipline.");
    expect(out).toContain("description: Owns today.md reads and writes.");
  });

  it("skips dirs that have no SKILL.md or no frontmatter", () => {
    mkdirSync(join(dir, "ok"), { recursive: true });
    mkdirSync(join(dir, "broken"), { recursive: true });
    mkdirSync(join(dir, "no-skill"), { recursive: true });
    writeFileSync(
      join(dir, "ok", "SKILL.md"),
      "---\nname: ok\ndescription: fine.\n---\n",
      "utf-8",
    );
    writeFileSync(join(dir, "broken", "SKILL.md"), "no frontmatter here\n", "utf-8");
    const out = renderSkillIndexBlock(dir, ".codex/skills");
    expect(out).toContain("- name: ok");
    expect(out).not.toContain("- name: broken");
    expect(out).not.toContain("- name: no-skill");
  });
});

/**
 * docs/design/appendices/skills-unification.md Phase 1 — `refreshSkillIndexBlock` re-renders
 * the `<skill-index>` block inside an existing instruction file. The
 * happy path is exercised end-to-end via the workdir.ts user-skill sync
 * tests; here we pin the no-op branches (Claude, missing file, no index
 * tag) so a future refactor that broadens the helper surfaces here.
 */
describe("refreshSkillIndexBlock", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pa-refresh-index-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is a no-op for the Claude backend (no instruction-file `<skill-index>`)", () => {
    // No CLAUDE.md exists → no-op. Helper must not throw and must not
    // create files.
    expect(() => refreshSkillIndexBlock(dir, "claude")).not.toThrow();
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false);
  });

  it("is a no-op for the OpenCode backend even when codex-rendered AGENTS.md is present (R3 + shared-file safety)", () => {
    // docs/design/appendices/skills-unification.md Phase 1 §R3 — OpenCode never gets a
    // `<skill-index>` block. In a fallback workdir where codex AND
    // opencode have both materialised, AGENTS.md is shared (both use
    // it) but only codex's flavour carries the sentinels. An accidental
    // OpenCode refresh on the codex-rendered AGENTS.md would splice
    // OpenCode's skill listing into codex's region and silently
    // corrupt codex's index. Pin the early-return.
    writeFileSync(
      join(dir, "AGENTS.md"),
      [
        "# Aitne AGENTS.md (codex-rendered)",
        "",
        "<!-- skill-index:start -->",
        "<skill-index>",
        "(codex's listing — must not be overwritten by an opencode refresh)",
        "</skill-index>",
        "<!-- skill-index:end -->",
        "",
      ].join("\n"),
      "utf-8",
    );
    mkdirSync(join(dir, ".opencode", "skills", "leak"), { recursive: true });
    writeFileSync(
      join(dir, ".opencode", "skills", "leak", "SKILL.md"),
      "---\nname: leak\ndescription: should never appear in AGENTS.md.\n---\n",
      "utf-8",
    );
    refreshSkillIndexBlock(dir, "opencode");
    const after = readFileSync(join(dir, "AGENTS.md"), "utf-8");
    expect(after).toContain("(codex's listing — must not be overwritten by an opencode refresh)");
    expect(after).not.toContain("- name: leak");
  });

  it("is a no-op when the instruction file lacks a `<skill-index>` tag (slim fetch_window path)", () => {
    writeFileSync(
      join(dir, "AGENTS.md"),
      "# Aitne AGENTS.md\n\nslim fetch_window prompt with no skill-index\n",
      "utf-8",
    );
    refreshSkillIndexBlock(dir, "codex");
    const after = readFileSync(join(dir, "AGENTS.md"), "utf-8");
    expect(after).not.toContain("<skill-index>");
  });

  it("splices fresh slugs into the existing `<skill-index>` block (codex)", () => {
    // Real instruction files (post-Phase-1 hardening) wrap the visible
    // `<skill-index>` tags in `<!-- skill-index:start -->` /
    // `<!-- skill-index:end -->` sentinels so the splicer keys on them
    // instead. The fixture mirrors that shape.
    writeFileSync(
      join(dir, "AGENTS.md"),
      [
        "# Aitne AGENTS.md",
        "",
        "<!-- skill-index:start -->",
        "<skill-index>",
        "(old, stale listing)",
        "</skill-index>",
        "<!-- skill-index:end -->",
        "",
        "## Runtime profile",
        "",
        "stays put",
        "",
      ].join("\n"),
      "utf-8",
    );
    mkdirSync(join(dir, ".codex", "skills", "fresh"), { recursive: true });
    writeFileSync(
      join(dir, ".codex", "skills", "fresh", "SKILL.md"),
      "---\nname: fresh\ndescription: freshly added user skill.\n---\nbody\n",
      "utf-8",
    );
    refreshSkillIndexBlock(dir, "codex");
    const after = readFileSync(join(dir, "AGENTS.md"), "utf-8");
    expect(after).toContain("- name: fresh");
    expect(after).not.toContain("(old, stale listing)");
    expect(after).toContain("## Runtime profile");
    expect(after).toContain("stays put");
  });

  it("ignores a `<skill-index>` token quoted in user prose (collision defence)", () => {
    // A profile body, skill, or user-authored skill that mentions the
    // visible `<skill-index>` tag verbatim MUST NOT be misidentified as
    // the splice region. The splicer keys on the HTML-comment
    // sentinels, which user prose effectively never contains.
    const fixture = [
      "# Aitne AGENTS.md",
      "",
      "## Runtime profile",
      "",
      "Earlier turns may have mentioned `<skill-index>` literally — for",
      "instance when describing how skill loading works to the user.",
      "That mention must survive a `refreshSkillIndexBlock` call.",
      "",
      "</skill-index> closing-tag mention in prose, also unchanged.",
      "",
    ].join("\n");
    writeFileSync(join(dir, "AGENTS.md"), fixture, "utf-8");
    mkdirSync(join(dir, ".codex", "skills", "fresh"), { recursive: true });
    writeFileSync(
      join(dir, ".codex", "skills", "fresh", "SKILL.md"),
      "---\nname: fresh\ndescription: freshly added user skill.\n---\n",
      "utf-8",
    );
    refreshSkillIndexBlock(dir, "codex");
    const after = readFileSync(join(dir, "AGENTS.md"), "utf-8");
    // No splice happened — the prose stayed put and no `- name: fresh`
    // entry was injected (because there was no sentinel pair to splice
    // into).
    expect(after).toBe(fixture);
  });

  it("emits HTML-comment sentinels around the visible tags so the splicer is collision-safe", () => {
    mkdirSync(join(dir, ".codex", "skills", "ok"), { recursive: true });
    writeFileSync(
      join(dir, ".codex", "skills", "ok", "SKILL.md"),
      "---\nname: ok\ndescription: fine.\n---\n",
      "utf-8",
    );
    const out = renderSkillIndexBlock(
      join(dir, ".codex", "skills"),
      ".codex/skills",
    );
    expect(out).toContain("<!-- skill-index:start -->");
    expect(out).toContain("<!-- skill-index:end -->");
    expect(out).toContain("<skill-index>");
    expect(out).toContain("</skill-index>");
    // Sentinels MUST wrap the visible tags, not the other way around —
    // the splicer's `indexOf(START)` then `indexOf(END, startIdx + …)`
    // contract assumes start-sentinel precedes end-sentinel and both
    // enclose the visible region.
    expect(out.indexOf("<!-- skill-index:start -->"))
      .toBeLessThan(out.indexOf("<skill-index>"));
    expect(out.indexOf("</skill-index>"))
      .toBeLessThan(out.indexOf("<!-- skill-index:end -->"));
  });
});

/**
 * docs/design/appendices/skills-unification.md Phase 1 §R5 / item 6 — build-time invariant
 * pass. Refuses to boot on malformed source trees so the daemon can't
 * limp along with skills the model will mis-load on description.
 */
describe("validateBuiltinSkillSourceTree", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "pa-validate-"));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("passes on a clean tree", () => {
    const skillsRoot = join(workspace, "agent-assets", "skills", "ok");
    mkdirSync(skillsRoot, { recursive: true });
    writeFileSync(
      join(skillsRoot, "SKILL.md"),
      "---\nname: ok\ndescription: short.\n---\nbody\n",
      "utf-8",
    );
    expect(() => validateBuiltinSkillSourceTree(
      join(workspace, "agent-assets", "skills"),
    )).not.toThrow();
  });

  it("throws when a description exceeds the cap", () => {
    const skillsRoot = join(workspace, "agent-assets", "skills", "longdesc");
    mkdirSync(skillsRoot, { recursive: true });
    const overLong = "x".repeat(SKILL_DESCRIPTION_MAX_LENGTH + 1);
    writeFileSync(
      join(skillsRoot, "SKILL.md"),
      `---\nname: longdesc\ndescription: ${overLong}\n---\nbody\n`,
      "utf-8",
    );
    expect(() => validateBuiltinSkillSourceTree(
      join(workspace, "agent-assets", "skills"),
    )).toThrow(/description_too_long/);
  });

  it("throws when a built-in slug violates `[a-z0-9-]{1,64}`", () => {
    const skillsRoot = join(workspace, "agent-assets", "skills", "Bad_Slug");
    mkdirSync(skillsRoot, { recursive: true });
    writeFileSync(
      join(skillsRoot, "SKILL.md"),
      "---\nname: bad\ndescription: short.\n---\nbody\n",
      "utf-8",
    );
    expect(() => validateBuiltinSkillSourceTree(
      join(workspace, "agent-assets", "skills"),
    )).toThrow(/invalid_slug/);
  });

  it("throws when a SKILL.md is missing `name`", () => {
    const skillsRoot = join(workspace, "agent-assets", "skills", "noname");
    mkdirSync(skillsRoot, { recursive: true });
    writeFileSync(
      join(skillsRoot, "SKILL.md"),
      "---\ndescription: x.\n---\nbody\n",
      "utf-8",
    );
    expect(() => validateBuiltinSkillSourceTree(
      join(workspace, "agent-assets", "skills"),
    )).toThrow(/missing_frontmatter_name/);
  });

  it("is a no-op when the skills dir is absent (test workspaces)", () => {
    expect(() =>
      validateBuiltinSkillSourceTree(join(workspace, "no-skills-here")),
    ).not.toThrow();
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
 * docs/design/appendices/skills-unification.md Phase 1 §"Codex read-sensitive banner
 * inheritance" — `READ_SENSITIVE_API_PREFIXES` is a hand-maintained
 * mirror of `safety/risk-classifier.ts`'s `RiskTier.ReadSensitive` GET
 * surface. The runtime list is deliberately literal (no import of
 * `API_RISK`) to keep `core/skills-compiler` independent of
 * `safety/risk-classifier` at the bootstrap level — but a hand-
 * maintained mirror drifts.
 *
 * The drift surface is asymmetric:
 *
 *   - **Missing prefix** (skill body touches an RS endpoint that the
 *     mirror does not list) → Codex banner is silently skipped → the
 *     model retries on 401 instead of stopping. Real risk.
 *   - **Extra prefix** (mirror lists a path that is not RS) → banner
 *     falsely emitted for skills that touch that path → wasted prose
 *     but no incident. Low risk.
 *
 * The test below pins both directions so a future API_RISK edit cannot
 * silently regress the contract.
 */
describe("READ_SENSITIVE_API_PREFIXES drift guard vs risk-classifier", () => {
  const apiRiskPrefixes = listReadSensitiveGetPathKeys();

  it("covers every RiskTier.ReadSensitive GET endpoint declared in API_RISK", () => {
    // Every read-sensitive GET path in API_RISK must have at least one
    // prefix in READ_SENSITIVE_API_PREFIXES that it `startsWith(...)`.
    // A skill body that mentions the path will then trigger the Codex
    // banner via `skillBodyTouchesReadSensitive`.
    const uncovered: string[] = [];
    for (const apiPath of apiRiskPrefixes) {
      const covered = READ_SENSITIVE_API_PREFIXES.some((prefix) =>
        apiPath.startsWith(prefix),
      );
      if (!covered) uncovered.push(apiPath);
    }
    expect(uncovered).toEqual([]);
  });

  it("does not list a prefix that no API_RISK ReadSensitive route would match (low-risk regression)", () => {
    // Each entry in READ_SENSITIVE_API_PREFIXES should be the prefix of
    // at least one API_RISK ReadSensitive GET path. Failing here means
    // either the API_RISK entry has been moved/removed (delete the
    // mirror entry too) or the mirror entry was wrong to begin with
    // (`/api/profile-questions` was the canonical example before
    // rev3 — `slot-filled` is Autonomous, not RS, so the entry over-
    // triggered the banner on user-interview-adjacent skills).
    const unmatched: string[] = [];
    for (const prefix of READ_SENSITIVE_API_PREFIXES) {
      const matched = apiRiskPrefixes.some((apiPath) =>
        apiPath.startsWith(prefix) || prefix.startsWith(apiPath),
      );
      if (!matched) unmatched.push(prefix);
    }
    expect(unmatched).toEqual([]);
  });

  it("explicitly includes the previously-missing /api/mcp/servers prefix (regression pin)", () => {
    // `GET /api/mcp/servers` and `GET /api/mcp/servers/` are
    // RiskTier.ReadSensitive in `safety/risk-classifier.ts`. Pre-fix,
    // the mirror omitted them — any future skill that referenced an MCP
    // server listing would not trigger the Codex banner. Pin the entry
    // so a hand-maintenance pass cannot silently drop it again.
    expect(READ_SENSITIVE_API_PREFIXES).toContain("/api/mcp/servers");
  });

  it("does not list /api/profile-questions (no RS endpoint exists under it)", () => {
    // `GET /api/profile-questions/slot-filled` is RiskTier.Autonomous
    // (returns a single boolean, no personal payload). Pre-fix the
    // mirror over-listed `/api/profile-questions` which would falsely
    // banner-flag any skill that referenced /slot-filled. Pin the
    // exclusion so a future widening doesn't quietly regress.
    expect(READ_SENSITIVE_API_PREFIXES).not.toContain("/api/profile-questions");
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
 * skills-unification.md Test plan — U4a / X6 / P2 row.
 * Source-tree lints over the real `agent-assets/skills/` directory.
 * These are not testing materialisation; they assert invariants on the
 * source frontmatter that the unification + improvement plans hard-enforce.
 *
 * - U4a: no `when_to_use:` frontmatter line (Phase 0.1 + R6 cleanup).
 * - X6:  no `Bash(jq *)` in per-skill `allowed-tools` (Phase 0.8 — jq
 *        is allowed globally at the backend level instead).
 * - P2:  frontmatter keys are a strict subset of `{name, description,
 *        allowed-tools}`. Any other top-level key is a drift signal.
 */
describe("agent-assets source-tree lints (U4a / X6 / P2)", () => {
  const REPO_SKILLS_ROOT = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../agent-assets/skills",
  );

  /** Enumerate flat + one-level-nested skill dirs (matches the wiki/<slug> convention). */
  function listSkillSourceDirs(root: string): string[] {
    if (!existsSync(root)) return [];
    const out: string[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const top = join(root, entry.name);
      if (existsSync(join(top, "SKILL.md"))) {
        out.push(top);
        continue;
      }
      for (const sub of readdirSync(top, { withFileTypes: true })) {
        if (!sub.isDirectory()) continue;
        const nested = join(top, sub.name);
        if (existsSync(join(nested, "SKILL.md"))) out.push(nested);
      }
    }
    return out;
  }

  const ALLOWED_FRONTMATTER_KEYS = new Set([
    "name",
    "description",
    "allowed-tools",
  ]);

  it("U4a — no SKILL.md declares `when_to_use:` in its frontmatter", () => {
    const offenders: string[] = [];
    for (const dir of listSkillSourceDirs(REPO_SKILLS_ROOT)) {
      const body = readFileSync(join(dir, "SKILL.md"), "utf-8");
      const match = body.match(/^---\n([\s\S]*?)\n---/);
      if (!match) continue;
      if (/^when_to_use\s*:/m.test(match[1])) {
        offenders.push(dir);
      }
    }
    expect(
      offenders,
      `when_to_use: removed per Phase 0.1 + R6 — re-introduced in: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("X6 — no SKILL.md declares `Bash(jq *)` in allowed-tools (Phase 0.8)", () => {
    const offenders: string[] = [];
    for (const dir of listSkillSourceDirs(REPO_SKILLS_ROOT)) {
      const body = readFileSync(join(dir, "SKILL.md"), "utf-8");
      const match = body.match(/^---\n([\s\S]*?)\n---/);
      if (!match) continue;
      // Match either YAML list form `- Bash(jq …)` or inline `Bash(jq …)`.
      if (/Bash\s*\(\s*jq\s/m.test(match[1])) offenders.push(dir);
    }
    expect(
      offenders,
      `Bash(jq *) is globally allowed at backend level (Phase 0.8) — re-declared per-skill in: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("P2 — frontmatter top-level keys are a subset of {name, description, allowed-tools}", () => {
    const offenders: { dir: string; extras: string[] }[] = [];
    for (const dir of listSkillSourceDirs(REPO_SKILLS_ROOT)) {
      const body = readFileSync(join(dir, "SKILL.md"), "utf-8");
      const match = body.match(/^---\n([\s\S]*?)\n---/);
      if (!match) continue;
      const topLevel = new Set<string>();
      for (const line of match[1].split("\n")) {
        const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:/);
        if (m) topLevel.add(m[1]);
      }
      const extras = [...topLevel].filter((k) => !ALLOWED_FRONTMATTER_KEYS.has(k));
      if (extras.length > 0) offenders.push({ dir, extras });
    }
    expect(
      offenders,
      `extra frontmatter keys found: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });

  it("P2 (positive) — every SKILL.md has `name:` and `description:`", () => {
    const dirs = listSkillSourceDirs(REPO_SKILLS_ROOT);
    expect(dirs.length).toBeGreaterThan(0);
    for (const dir of dirs) {
      const body = readFileSync(join(dir, "SKILL.md"), "utf-8");
      expect(body, `${dir} missing name`).toMatch(/^name\s*:\s*\S/m);
      expect(body, `${dir} missing description`).toMatch(/^description\s*:\s*\S/m);
    }
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
