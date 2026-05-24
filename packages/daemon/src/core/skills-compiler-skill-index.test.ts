import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  logger as skillIndexLogger,
  refreshSkillIndexBlock,
  renderPartialIncludes,
  renderReferenceIncludes,
  renderSkillIndexBlock,
  stripUnconfiguredServices,
} from "./skills-compiler-skill-index.js";

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
    const warnSpy = vi.spyOn(skillIndexLogger, "warn");
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
