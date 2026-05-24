import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cliInstructionFileName,
  cliSkillsDirName,
  prependCodexReadSensitiveBanner,
} from "./skills-compiler-cli-renderer.js";

/**
 * Pure-helper unit coverage for the CLI dotfile-mapping exports. Pinned in
 * a focused suite so a future refactor (unifying skills-dir naming,
 * renaming the CLI instruction filenames) surfaces here rather than in a
 * far-removed integration test that is harder to map back to the
 * regression.
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

/**
 * `cliInstructionFileName` — the inverse-ish of `cliSkillsDirName`. Pinned
 * here so the wide path (`materializeCliSession`) and the slim path
 * (`materializeFetchWindowCliSession`) can never drift on which file name
 * to write per backend.
 */
describe("cliInstructionFileName", () => {
  it("returns the auto-discovered filename for each non-Claude backend", () => {
    expect(cliInstructionFileName("codex")).toBe("AGENTS.md");
    expect(cliInstructionFileName("opencode")).toBe("AGENTS.md");
    expect(cliInstructionFileName("gemini")).toBe("GEMINI.md");
  });
});

/**
 * Direct unit coverage for `prependCodexReadSensitiveBanner`. The materializer
 * integration tests in `skills-compiler.test.ts > codex read-sensitive banner`
 * only exercise the well-formed-frontmatter happy path (every built-in skill
 * ships frontmatter). The two no-fm fallback branches and the
 * already-bannered idempotency check live here so a regression in either
 * surfaces in this focused suite instead of as a silent Codex-session
 * lossy retry on 401.
 */
describe("prependCodexReadSensitiveBanner", () => {
  let dir: string;
  let skillMdPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pa-codex-banner-unit-"));
    skillMdPath = join(dir, "SKILL.md");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is a no-op when the skill file does not exist", () => {
    // existsSync short-circuit at the top — must not throw, must not create
    // the file as a side effect.
    expect(() => prependCodexReadSensitiveBanner(skillMdPath)).not.toThrow();
    expect(existsSync(skillMdPath)).toBe(false);
  });

  it("is a no-op when the skill body references no read-sensitive endpoint", () => {
    const body = "---\nname: notify\ndescription: x.\n---\n\nPOST /api/notify\n";
    writeFileSync(skillMdPath, body, "utf-8");
    prependCodexReadSensitiveBanner(skillMdPath);
    expect(readFileSync(skillMdPath, "utf-8")).toBe(body);
  });

  it("prepends the banner immediately after a closed frontmatter block (happy path)", () => {
    const body = [
      "---",
      "name: mail",
      "description: m.",
      "---",
      "",
      "GET /api/mail/x",
      "",
    ].join("\n");
    writeFileSync(skillMdPath, body, "utf-8");
    prependCodexReadSensitiveBanner(skillMdPath);
    const after = readFileSync(skillMdPath, "utf-8");
    // Frontmatter is the first thing in the file; banner sentinel sits
    // immediately after the closing `---`.
    const fmEnd = after.indexOf("\n---\n");
    const sentinelIdx = after.indexOf("<!-- codex-read-sensitive-banner -->");
    expect(fmEnd).toBeGreaterThan(-1);
    expect(sentinelIdx).toBeGreaterThan(fmEnd);
    // Body content survives.
    expect(after).toContain("GET /api/mail/x");
  });

  it("prepends the banner at the very top when the body has no frontmatter", () => {
    // Line 354-357 branch: a skill body that touches RS endpoints but ships
    // no `---` opener. Defensive — built-ins always have frontmatter, but
    // user-authored skills written via PUT /api/skills/<slug> can skip it.
    const body = "Reads from GET /api/mail/x without any frontmatter.\n";
    writeFileSync(skillMdPath, body, "utf-8");
    prependCodexReadSensitiveBanner(skillMdPath);
    const after = readFileSync(skillMdPath, "utf-8");
    expect(after.startsWith("<!-- codex-read-sensitive-banner -->")).toBe(true);
    expect(after).toContain(body.trimEnd());
  });

  it("prepends the banner at the top when the frontmatter opener is unclosed", () => {
    // Line 359-362 branch: `---` opener with no matching close. The helper
    // treats this as "no frontmatter" and prepends at offset 0 rather than
    // attempting to inject inside the broken header.
    const body = "---\nname: broken\ndescription: GET /api/mail/x\n";
    writeFileSync(skillMdPath, body, "utf-8");
    prependCodexReadSensitiveBanner(skillMdPath);
    const after = readFileSync(skillMdPath, "utf-8");
    expect(after.startsWith("<!-- codex-read-sensitive-banner -->")).toBe(true);
    // Original (broken) content is preserved verbatim after the banner.
    expect(after).toContain(body);
  });

  it("is idempotent — a second call on an already-bannered file is a no-op", () => {
    const body = [
      "---",
      "name: mail",
      "description: m.",
      "---",
      "",
      "GET /api/mail/x",
      "",
    ].join("\n");
    writeFileSync(skillMdPath, body, "utf-8");
    prependCodexReadSensitiveBanner(skillMdPath);
    const afterFirst = readFileSync(skillMdPath, "utf-8");
    prependCodexReadSensitiveBanner(skillMdPath);
    const afterSecond = readFileSync(skillMdPath, "utf-8");
    expect(afterSecond).toBe(afterFirst);
    // Sentinel appears exactly once.
    const matches = afterSecond.match(/<!-- codex-read-sensitive-banner -->/g);
    expect(matches).toHaveLength(1);
  });
});
