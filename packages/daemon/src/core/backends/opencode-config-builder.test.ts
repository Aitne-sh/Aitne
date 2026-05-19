/**
 * Golden tests for docs/design/appendices/opencode-backend.md §5.1 / §5.8 config-builder.
 */

import { describe, expect, it } from "vitest";
import {
  buildOpencodeRuntimeConfig,
  defensiveInstructionsFromEnv,
} from "./opencode-config-builder.js";
import type { OpencodeConfigBuilderInput } from "./opencode-config-builder.js";

function defaults(
  overrides: Partial<OpencodeConfigBuilderInput> = {},
): OpencodeConfigBuilderInput {
  return {
    modelId: "anthropic/claude-sonnet-4-6",
    executionMode: "strict",
    disallowedTools: [],
    allowedToolsOverride: null,
    mcpDisallowed: [],
    mcp: {},
    ...overrides,
  };
}

describe("buildOpencodeRuntimeConfig — empty envelope", () => {
  it("emits self-contained config with task:false and absolute-block bash denies", () => {
    const { config, warnings } = buildOpencodeRuntimeConfig(defaults());
    // Subagent suppression is always on.
    expect(config.tools).toEqual({ task: false });
    // Model is forwarded when it parses as provider/model.
    expect(config.model).toBe("anthropic/claude-sonnet-4-6");
    // No MCP, no defensive instructions.
    expect(config.mcp).toBeUndefined();
    expect(config.instructions).toBeUndefined();
    // Absolute-block layer always contributes bash denies.
    const bash = config.permission!.bash as Record<string, string>;
    expect(bash["rm -rf *"]).toBe("deny");
    expect(bash["sudo *"]).toBe("deny");
    // No translator warnings for empty input.
    expect(warnings).toEqual([]);
  });

  it("omits model when modelId has no '/' separator", () => {
    const { config } = buildOpencodeRuntimeConfig(
      defaults({ modelId: "claude-sonnet" }),
    );
    expect(config.model).toBeUndefined();
  });
});

describe("buildOpencodeRuntimeConfig — disallowedTools translation", () => {
  it("merges per-session Bash patterns with the absolute-block layer", () => {
    const { config, warnings } = buildOpencodeRuntimeConfig(
      defaults({ disallowedTools: ["Bash(npm publish *)"] }),
    );
    const bash = config.permission!.bash as Record<string, string>;
    expect(bash["npm publish *"]).toBe("deny");
    // Absolute-block entries still present.
    expect(bash["rm -rf *"]).toBe("deny");
    expect(warnings).toEqual([]);
  });

  it("surfaces translator warnings (e.g. Edit pattern collapse)", () => {
    const { warnings } = buildOpencodeRuntimeConfig(
      defaults({ disallowedTools: ["Edit(/etc/**)"] }),
    );
    expect(warnings.some((w) => /edit permission is whole-tool only/.test(w))).toBe(
      true,
    );
  });

  it("Read(<glob>) emits tools.read=false alongside task=false", () => {
    const { config } = buildOpencodeRuntimeConfig(
      defaults({ disallowedTools: ["Read(~/.ssh/**)"] }),
    );
    expect(config.tools).toEqual({ task: false, read: false });
  });
});

describe("buildOpencodeRuntimeConfig — allow mode", () => {
  it("drops user denies but keeps absolute-block layer", () => {
    const { config } = buildOpencodeRuntimeConfig(
      defaults({
        executionMode: "allow",
        disallowedTools: ["Bash(npm publish *)"],
      }),
    );
    const bash = config.permission!.bash as Record<string, string>;
    // Per-session deny is gone (allow mode drops user denies).
    expect(bash["npm publish *"]).toBeUndefined();
    // Absolute-block still wins — `rm -rf *` is denied regardless of mode.
    expect(bash["rm -rf *"]).toBe("deny");
  });

  it("ignores allowedToolsOverride (no per-session denies to override)", () => {
    const { config } = buildOpencodeRuntimeConfig(
      defaults({
        executionMode: "allow",
        allowedToolsOverride: ["Bash(rm -rf *)"],
      }),
    );
    const bash = config.permission!.bash as Record<string, string>;
    // CRITICAL: allow mode cannot widen past absolute-block.
    // Even though the override says rm -rf is allowed, the absolute-block
    // layer's deny wins.
    expect(bash["rm -rf *"]).toBe("deny");
  });
});

describe("buildOpencodeRuntimeConfig — allowedToolsOverride", () => {
  it("per-session bash allow does NOT erase the absolute-block deny on the same pattern", () => {
    const { config } = buildOpencodeRuntimeConfig(
      defaults({
        disallowedTools: ["Bash(rm -rf *)"],
        allowedToolsOverride: ["Bash(rm -rf *)"],
      }),
    );
    const bash = config.permission!.bash as Record<string, string>;
    // Absolute-block re-asserts deny in the final merge.
    expect(bash["rm -rf *"]).toBe("deny");
  });

  it("per-session bash allow on a non-absolute pattern survives the merge", () => {
    const { config } = buildOpencodeRuntimeConfig(
      defaults({
        disallowedTools: ["Bash(npm *)"],
        allowedToolsOverride: ["Bash(npm test)"],
      }),
    );
    const bash = config.permission!.bash as Record<string, string>;
    expect(bash["npm test"]).toBe("allow");
    expect(bash["npm *"]).toBe("deny");
  });

  it("allowedToolsOverride cannot widen past absolute-block deny for sudo", () => {
    // Explicit coverage for the privilege-escalation case (always-
    // disallowed.ts). The dashboard's `allowedToolsOverride` knob must
    // never be able to bypass the absolute-block layer regardless of
    // mode — this is the EXECUTION-MODE-DESIGN.md §6 invariant restated
    // for opencode (Claude has its own PreToolUse hook, codex/gemini
    // their own policy surfaces; opencode relies on this merge).
    for (const executionMode of ["strict", "allow"] as const) {
      const { config } = buildOpencodeRuntimeConfig(
        defaults({
          executionMode,
          disallowedTools: ["Bash(sudo *)"],
          allowedToolsOverride: ["Bash(sudo *)"],
        }),
      );
      const bash = config.permission!.bash as Record<string, string>;
      expect(bash["sudo *"]).toBe("deny");
    }
  });
});

describe("buildOpencodeRuntimeConfig — MCP", () => {
  it("attaches per-session mcp map when non-empty", () => {
    const { config } = buildOpencodeRuntimeConfig(
      defaults({
        mcp: {
          weather: {
            type: "local",
            command: ["node", "wx.js"],
            enabled: true,
          },
        },
      }),
    );
    expect(config.mcp).toEqual({
      weather: {
        type: "local",
        command: ["node", "wx.js"],
        enabled: true,
      },
    });
  });

  it("omits mcp field when empty (self-contained — no merge dependency)", () => {
    const { config } = buildOpencodeRuntimeConfig(defaults());
    expect(Object.prototype.hasOwnProperty.call(config, "mcp")).toBe(false);
  });
});

describe("buildOpencodeRuntimeConfig — defensive instructions", () => {
  it("omits 'instructions' by default (V1+V2 — cwd auto-discovery)", () => {
    const { config } = buildOpencodeRuntimeConfig(defaults());
    expect(config.instructions).toBeUndefined();
  });

  it("emits the defensive glob list when defensiveInstructions=true", () => {
    const { config } = buildOpencodeRuntimeConfig(
      defaults({ defensiveInstructions: true }),
    );
    expect(config.instructions).toEqual(["AGENTS.md", ".opencode/agent/*.md"]);
  });
});

describe("buildOpencodeRuntimeConfig — extraHardDisable composition", () => {
  it("composes task:false with caller-supplied extras", () => {
    const { config } = buildOpencodeRuntimeConfig(
      defaults({ extraHardDisable: { agent: false } }),
    );
    expect(config.tools).toEqual({ task: false, agent: false });
  });

  it("read hard-disable from disallowedTools wins over caller-supplied 'read: true'", () => {
    // The translator's `read: false` must override a caller's permissive
    // `read: true` — defense-in-depth.
    const { config } = buildOpencodeRuntimeConfig(
      defaults({
        disallowedTools: ["Read(~/.ssh/**)"],
        extraHardDisable: { read: true },
      }),
    );
    expect(config.tools).toEqual({ task: false, read: false });
  });
});

describe("buildOpencodeRuntimeConfig — full stack", () => {
  it("composes model + permission + tools + mcp + warnings into one envelope", () => {
    const { config, warnings } = buildOpencodeRuntimeConfig({
      modelId: "anthropic/claude-haiku-4-5",
      executionMode: "strict",
      disallowedTools: ["Bash(npm publish *)", "Edit(/etc/**)", "WebFetch"],
      allowedToolsOverride: ["Bash(npm test)"],
      mcpDisallowed: ["mcp__finance__transfer"],
      mcp: {
        weather: { type: "local", command: ["node", "wx.js"], enabled: true },
      },
      defensiveInstructions: true,
    });

    expect(config.model).toBe("anthropic/claude-haiku-4-5");
    const bash = config.permission!.bash as Record<string, string>;
    expect(bash["npm publish *"]).toBe("deny");
    expect(bash["npm test"]).toBe("allow");
    expect(bash["rm -rf *"]).toBe("deny");
    expect(config.permission!.edit).toBe("deny");
    expect(config.permission!.webfetch).toBe("deny");
    expect(config.tools).toEqual({ task: false });
    expect(config.mcp).toBeDefined();
    expect(config.instructions).toEqual(["AGENTS.md", ".opencode/agent/*.md"]);
    // Warnings flow through from both translators.
    expect(warnings.some((w) => /edit permission is whole-tool only/.test(w))).toBe(
      true,
    );
    expect(warnings.some((w) => /server 'finance'/.test(w))).toBe(true);
  });
});

describe("buildOpencodeRuntimeConfig — bash merge edge cases", () => {
  it("absolute-block pattern-map merges into a per-session pattern-map", () => {
    // Two pattern-maps merge per-pattern, with absolute-block winning on
    // collisions; non-colliding entries from both sides survive.
    const { config } = buildOpencodeRuntimeConfig(
      defaults({ disallowedTools: ["Bash(npm *)"] }),
    );
    const bash = config.permission!.bash as Record<string, string>;
    expect(bash["npm *"]).toBe("deny");
    expect(bash["rm -rf *"]).toBe("deny");
  });

  it("absolute-block pattern-map merges into a per-session 'deny' triple", () => {
    // Per-session bare-name Bash → triple deny. Absolute-block is a
    // pattern map; the merge must yield a pattern map (so the absolute
    // patterns stay enforceable) + a '*' catch-all if the bare deny
    // was meaningful. We preserve the absolute-block patterns; the bare
    // 'Bash' deny was already widened by the translator into a '*' entry.
    const { config } = buildOpencodeRuntimeConfig(
      defaults({ disallowedTools: ["Bash", "Bash(npm *)"] }),
    );
    const bash = config.permission!.bash as Record<string, string>;
    // The translator emits patterns + a '*' catch-all when bare Bash is mixed
    // with patterns; absolute-block patterns ride on top.
    expect(bash["npm *"]).toBe("deny");
    expect(bash["*"]).toBe("deny");
    expect(bash["rm -rf *"]).toBe("deny");
  });

  it("bare 'Bash' (no per-session patterns) preserves wholesale deny through the merge", () => {
    // REGRESSION GUARD — the prior `mergeBash` returned only the
    // absolute-block pattern-map for this input, silently widening the
    // user's "deny all bash" to "deny only rm -rf, sudo, etc." A user
    // who runs `npm test` after this would have it allowed even though
    // they denied all bash. The fix: encode the wholesale `"deny"`
    // semantic as a `"*"` catch-all on the merged pattern map.
    const { config } = buildOpencodeRuntimeConfig(
      defaults({ disallowedTools: ["Bash"] }),
    );
    const bash = config.permission!.bash as Record<string, string>;
    expect(bash["*"]).toBe("deny");
    // Absolute-block patterns still present (defense-in-depth observability).
    expect(bash["rm -rf *"]).toBe("deny");
    expect(bash["sudo *"]).toBe("deny");
  });
});

describe("defensiveInstructionsFromEnv", () => {
  it("returns true only when env var is exactly '1'", () => {
    expect(defensiveInstructionsFromEnv({})).toBe(false);
    expect(
      defensiveInstructionsFromEnv({ PA_OPENCODE_DEFENSIVE_INSTRUCTIONS: "1" }),
    ).toBe(true);
    expect(
      defensiveInstructionsFromEnv({ PA_OPENCODE_DEFENSIVE_INSTRUCTIONS: "true" }),
    ).toBe(false);
    expect(
      defensiveInstructionsFromEnv({ PA_OPENCODE_DEFENSIVE_INSTRUCTIONS: "" }),
    ).toBe(false);
  });
});
