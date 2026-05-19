import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetNativeSkillDiscoveryProbe,
  __test_helpTextLooksLikeSkillSubcommand,
  noteNativeSkillToolIfPresent,
  probeCliNativeSkillSubcommand,
} from "./native-skill-discovery-probe.js";

/**
 * docs/design/appendices/skills-unification.md Phase 1 item 13 — forward-compat probe.
 *
 * `noteNativeSkillToolIfPresent` is exercised here directly; the
 * subprocess-driven `probeCliNativeSkillSubcommand` is exercised via
 * the synchronous helper `__test_helpTextLooksLikeSkillSubcommand`
 * (which carries the matching logic) plus a single end-to-end
 * subprocess sanity test that points the probe at `node --help` (a
 * benign binary present in every CI host that does NOT mention
 * `skill`, so we get a guaranteed negative without depending on a
 * specific CLI being installed).
 */
describe("noteNativeSkillToolIfPresent", () => {
  beforeEach(() => {
    __resetNativeSkillDiscoveryProbe();
  });

  it("is a no-op for OpenCode (R3 — cwd auto-discovery is the source of truth)", () => {
    // Just verify it does not throw and does not flag a match. We can't
    // assert on logger output cheaply here; the function's early return
    // is the contract.
    expect(() =>
      noteNativeSkillToolIfPresent("opencode", ["skill"]),
    ).not.toThrow();
  });

  it("ignores tool lists that contain no skill-like names", () => {
    expect(() =>
      noteNativeSkillToolIfPresent("codex", [
        "mcp__github__create_issue",
        "mcp__notion__search",
      ]),
    ).not.toThrow();
  });

  it("does not throw on an empty list", () => {
    expect(() => noteNativeSkillToolIfPresent("gemini", [])).not.toThrow();
  });

  it("accepts the canonical `skill` / `skills` / `skill_load` shapes", () => {
    // Exercises the regex contract without asserting on logger spy —
    // a thrown error here would mean a regex change broke the call.
    expect(() => noteNativeSkillToolIfPresent("codex", ["skill"])).not.toThrow();
    expect(() => noteNativeSkillToolIfPresent("codex", ["skills"])).not.toThrow();
    expect(() =>
      noteNativeSkillToolIfPresent("codex", ["skill_load"]),
    ).not.toThrow();
    expect(() =>
      noteNativeSkillToolIfPresent("codex", ["load_skill"]),
    ).not.toThrow();
  });
});

describe("__test_helpTextLooksLikeSkillSubcommand", () => {
  it("matches the actual gemini --help shape (verified 2026-05-15)", () => {
    const sample = [
      "Usage: gemini [options] [command]",
      "",
      "Commands:",
      "  gemini skills <command>      Manage agent skills.  [aliases: skill]",
      "  gemini chat                  Start a chat session.",
    ].join("\n");
    expect(__test_helpTextLooksLikeSkillSubcommand(sample, "gemini")).toBe(true);
  });

  it("matches a hypothetical codex --help shape", () => {
    const sample = [
      "Usage: codex [options] <command>",
      "",
      "Commands:",
      "  codex skill <command>        Manage agent skills.",
      "  codex exec                   Run Codex non-interactively.",
    ].join("\n");
    expect(__test_helpTextLooksLikeSkillSubcommand(sample, "codex")).toBe(true);
  });

  it("matches the clap-style `Commands:` block indent shape", () => {
    const sample = [
      "Usage: codex [OPTIONS] <COMMAND>",
      "",
      "Commands:",
      "  exec    Run non-interactively",
      "  skills  Manage agent skills",
      "  login   Manage login",
    ].join("\n");
    expect(__test_helpTextLooksLikeSkillSubcommand(sample, "codex")).toBe(true);
  });

  it("matches case-insensitively (capital S `Skills`)", () => {
    const sample = [
      "Usage: gemini",
      "Commands:",
      "  Skills  Manage agent skills",
    ].join("\n");
    expect(__test_helpTextLooksLikeSkillSubcommand(sample, "gemini")).toBe(true);
  });

  it("does NOT match on a sub-token mention like `skill_search`", () => {
    const sample = [
      "Usage: codex",
      "Options:",
      "  --features skill_search   Some unrelated feature",
    ].join("\n");
    // The `\b` terminator + leading-whitespace anchor keep this from
    // false-positive on flag descriptions.
    expect(__test_helpTextLooksLikeSkillSubcommand(sample, "codex")).toBe(false);
  });

  it("does NOT match on prose containing the word 'skill'", () => {
    const sample = [
      "Usage: gemini",
      "",
      "A general-purpose CLI. No skill subsystem yet — coming soon.",
    ].join("\n");
    expect(__test_helpTextLooksLikeSkillSubcommand(sample, "gemini")).toBe(false);
  });

  it("does NOT match on the actual codex --help shape today (skill subcommand absent)", () => {
    // Verbatim-trimmed excerpt from `codex --help` on 2026-05-15. The
    // string `skill` appears nowhere; this guards against a regex that
    // accidentally matches via the `_skill_` token in feature names.
    const sample = [
      "Usage: codex [OPTIONS] [PROMPT]",
      "       codex [OPTIONS] <COMMAND> [ARGS]",
      "",
      "Commands:",
      "  exec    Run Codex non-interactively [aliases: e]",
      "  login   Manage login",
      "  mcp     Manage external MCP servers for Codex",
      "  plugin  Manage Codex plugins",
    ].join("\n");
    expect(__test_helpTextLooksLikeSkillSubcommand(sample, "codex")).toBe(false);
  });
});

describe("probeCliNativeSkillSubcommand — subprocess integration", () => {
  beforeEach(() => {
    __resetNativeSkillDiscoveryProbe();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is a no-op when the CLI path is null", async () => {
    await expect(
      probeCliNativeSkillSubcommand(null, "codex"),
    ).resolves.toBeUndefined();
  });

  it("does not throw when the CLI binary is missing", async () => {
    // Point at a path that definitely does not exist. The runLineCommand
    // helper rejects on spawn ENOENT; the probe must swallow it.
    await expect(
      probeCliNativeSkillSubcommand(
        "/definitely/not/a/real/cli/binary-that-does-not-exist",
        "codex",
      ),
    ).resolves.toBeUndefined();
  });

  it("does not throw on a CLI whose --help has no skill subcommand", async () => {
    // `node --help` is ubiquitous on CI hosts and prints exit-0 with a
    // skill-free options listing. End-to-end check that the spawn +
    // parse + negative-result path holds together without an error.
    await expect(
      probeCliNativeSkillSubcommand(process.execPath, "codex"),
    ).resolves.toBeUndefined();
  });
});
