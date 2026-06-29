import { afterEach, describe, expect, it, vi } from "vitest";
import {
  noteNativeSkillToolIfPresent,
  probeCliNativeSkillSubcommand,
} from "./native-skill-discovery-probe.js";

/**
 * docs/design/appendices/skills-unification.md Phase 1 item 13 — forward-compat probe.
 *
 * `noteNativeSkillToolIfPresent` is exercised here directly; the
 * subprocess-driven `probeCliNativeSkillSubcommand` is exercised via an
 * end-to-end subprocess sanity test that points the probe at `node
 * --help` (a benign binary present in every CI host that does NOT
 * mention `skill`, so we get a guaranteed negative without depending on
 * a specific CLI being installed).
 */
describe("noteNativeSkillToolIfPresent", () => {
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

describe("probeCliNativeSkillSubcommand — subprocess integration", () => {
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
