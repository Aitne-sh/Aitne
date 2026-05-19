/**
 * Property-matrix tests for docs/design/appendices/opencode-backend.md §5.6 translator.
 * Lands in the 100%-coverage subset.
 */

import { describe, expect, it } from "vitest";
import { buildOpencodePermission, __test } from "./opencode-permission.js";
import type { OpencodePermissionBuildInput } from "./opencode-config.js";

function build(
  overrides: Partial<OpencodePermissionBuildInput>,
): ReturnType<typeof buildOpencodePermission> {
  return buildOpencodePermission({
    mode: "strict",
    disallowedTools: [],
    allowedToolsOverride: null,
    mcpDisallowed: [],
    ...overrides,
  });
}

describe("buildOpencodePermission — bash patterns", () => {
  it("maps Bash(<pattern>) to a deny pattern-map entry", () => {
    const res = build({ disallowedTools: ["Bash(rm -rf *)"] });
    expect(res.permission).toEqual({ bash: { "rm -rf *": "deny" } });
    expect(res.toolsHardDisable).toEqual({});
    expect(res.warnings).toEqual([]);
  });

  it("merges multiple bash patterns into a single pattern-map", () => {
    const res = build({
      disallowedTools: ["Bash(rm -rf *)", "Bash(sudo *)", "Bash(curl * | sh*)"],
    });
    expect(res.permission.bash).toEqual({
      "rm -rf *": "deny",
      "sudo *": "deny",
      "curl * | sh*": "deny",
    });
  });

  it("bare Bash collapses to triple deny", () => {
    const res = build({ disallowedTools: ["Bash"] });
    expect(res.permission).toEqual({ bash: "deny" });
  });

  it("bare Bash + patterns emits pattern-map with '*' catch-all", () => {
    const res = build({
      disallowedTools: ["Bash", "Bash(npm test)"],
    });
    expect(res.permission.bash).toEqual({
      "npm test": "deny",
      "*": "deny",
    });
  });

  it("does not overwrite an explicit '*' pattern with the catch-all", () => {
    const res = build({
      disallowedTools: ["Bash", "Bash(*)"],
    });
    // The explicit Bash(*) deny stays; the bare Bash deny is absorbed.
    expect(res.permission.bash).toEqual({ "*": "deny" });
  });
});

describe("buildOpencodePermission — edit / write collapse", () => {
  it("Edit(<glob>) collapses to whole-tool deny with a warning", () => {
    const res = build({ disallowedTools: ["Edit(/etc/**)"] });
    expect(res.permission).toEqual({ edit: "deny" });
    expect(res.warnings[0]).toMatch(/edit permission is whole-tool only/);
    expect(res.warnings[0]).toContain("/etc/**");
  });

  it("Write(<glob>) collapses into edit (per OpenCode docs)", () => {
    const res = build({ disallowedTools: ["Write(/etc/**)"] });
    expect(res.permission).toEqual({ edit: "deny" });
  });

  it("bare Edit emits triple deny with no warning", () => {
    const res = build({ disallowedTools: ["Edit"] });
    expect(res.permission).toEqual({ edit: "deny" });
    expect(res.warnings).toEqual([]);
  });

  it("Edit and Write together produce a single edit deny", () => {
    const res = build({ disallowedTools: ["Edit", "Write(*)"] });
    expect(res.permission).toEqual({ edit: "deny" });
  });
});

describe("buildOpencodePermission — read hard-disable", () => {
  it("Read(<glob>) hard-disables the read tool with a warning suggesting Bash mitigation", () => {
    const res = build({ disallowedTools: ["Read(~/.ssh/**)"] });
    expect(res.permission).toEqual({});
    expect(res.toolsHardDisable).toEqual({ read: false });
    expect(res.warnings[0]).toMatch(/no read permission key/);
    expect(res.warnings[0]).toContain("~/.ssh/**");
  });

  it("bare Read hard-disables with a different warning", () => {
    const res = build({ disallowedTools: ["Read"] });
    expect(res.toolsHardDisable).toEqual({ read: false });
    expect(res.warnings[0]).toMatch(/tools\.read=false/);
  });
});

describe("buildOpencodePermission — webfetch", () => {
  it("WebFetch maps directly to webfetch:deny", () => {
    const res = build({ disallowedTools: ["WebFetch"] });
    expect(res.permission).toEqual({ webfetch: "deny" });
    expect(res.warnings).toEqual([]);
  });

  it("WebFetch(<pattern>) silently emits webfetch:deny (no pattern surface)", () => {
    const res = build({ disallowedTools: ["WebFetch(https://*)"] });
    expect(res.permission).toEqual({ webfetch: "deny" });
  });
});

describe("buildOpencodePermission — MCP server-level only", () => {
  it("mcp__finance__transfer surfaces ONE warning for the finance server", () => {
    const res = build({
      disallowedTools: ["mcp__finance__transfer", "mcp__finance__balance"],
    });
    expect(res.permission).toEqual({});
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain("server 'finance'");
    expect(res.warnings[0]).toContain("disallowedTools");
  });

  it("mcp prefix without a __<tool>__ suffix is ignored", () => {
    const res = build({ disallowedTools: ["mcp__bogus"] });
    expect(res.permission).toEqual({});
    expect(res.warnings).toEqual([]);
  });

  it("mcpDisallowed tool ids surface as server warnings tagged with mcpDisallowed origin", () => {
    const res = build({
      mcpDisallowed: ["mcp__finance__a", "mcp__notes__b"],
    });
    expect(res.warnings).toHaveLength(2);
    expect(res.warnings[0]).toContain("server 'finance'");
    expect(res.warnings[0]).toContain("mcpDisallowed");
    expect(res.warnings[1]).toContain("server 'notes'");
  });

  it("a server flagged via disallowedTools is not double-reported when mcpDisallowed names the same server", () => {
    const res = build({
      disallowedTools: ["mcp__finance__a"],
      mcpDisallowed: ["mcp__finance__b"],
    });
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain("disallowedTools");
  });
});

describe("buildOpencodePermission — malformed entries", () => {
  it("empty string is ignored without crashing", () => {
    const res = build({ disallowedTools: ["", "  "] });
    expect(res.permission).toEqual({});
    expect(res.warnings).toHaveLength(2);
    res.warnings.forEach((w) =>
      expect(w).toMatch(/could not parse disallowedTools/),
    );
  });

  it("unterminated paren is rejected with a parse warning", () => {
    const res = build({ disallowedTools: ["Bash(rm -rf *"] });
    expect(res.permission).toEqual({});
    expect(res.warnings[0]).toMatch(/could not parse disallowedTools/);
  });

  it("Tool name missing before paren is rejected", () => {
    const res = build({ disallowedTools: ["(rm -rf *)"] });
    expect(res.permission).toEqual({});
    expect(res.warnings[0]).toMatch(/could not parse/);
  });

  it("unknown tool name yields a no-mapping warning", () => {
    const res = build({ disallowedTools: ["FaxMachine(send *)"] });
    expect(res.permission).toEqual({});
    expect(res.warnings[0]).toMatch(/no opencode permission mapping/);
  });

  it("malformed allowedToolsOverride entry surfaces its own warning", () => {
    const res = build({
      disallowedTools: ["Bash(*)"],
      allowedToolsOverride: ["Bash(npm *", ""],
    });
    expect(res.warnings.filter((w) => /allowedToolsOverride/.test(w))).toHaveLength(2);
  });
});

describe("buildOpencodePermission — allowedToolsOverride", () => {
  it("Bash(<pattern>) override emits 'allow' alongside the existing deny map", () => {
    const res = build({
      disallowedTools: ["Bash(rm -rf *)"],
      allowedToolsOverride: ["Bash(npm test)"],
    });
    expect(res.permission.bash).toEqual({
      "rm -rf *": "deny",
      "npm test": "allow",
    });
  });

  it("bare Bash override flips wholesale bash deny back to no-rule", () => {
    const res = build({
      disallowedTools: ["Bash"],
      allowedToolsOverride: ["Bash"],
    });
    expect(res.permission.bash).toBeUndefined();
  });

  it("Edit override flips edit deny off; pattern is dropped with warning", () => {
    const res = build({
      disallowedTools: ["Edit"],
      allowedToolsOverride: ["Edit(/safe/**)"],
    });
    expect(res.permission.edit).toBeUndefined();
    expect(res.warnings.some((w) => /allowedToolsOverride.*edit/i.test(w))).toBe(
      true,
    );
  });

  it("Read override lifts the tools.read hard-disable", () => {
    const res = build({
      disallowedTools: ["Read"],
      allowedToolsOverride: ["Read"],
    });
    expect(res.toolsHardDisable).toEqual({});
  });

  it("Read override with a pattern lifts the hard-disable AND warns", () => {
    const res = build({
      disallowedTools: ["Read"],
      allowedToolsOverride: ["Read(/safe/**)"],
    });
    expect(res.toolsHardDisable).toEqual({});
    expect(res.warnings.some((w) => /Read.*hard-disable lifted wholesale/.test(w))).toBe(
      true,
    );
  });

  it("WebFetch override lifts webfetch deny", () => {
    const res = build({
      disallowedTools: ["WebFetch"],
      allowedToolsOverride: ["WebFetch"],
    });
    expect(res.permission.webfetch).toBeUndefined();
  });

  it("unknown tool name in override is silently ignored (no warning)", () => {
    const res = build({
      allowedToolsOverride: ["FaxMachine"],
    });
    expect(res.warnings).toEqual([]);
  });

  it("override with a Write entry collapses to edit unflip", () => {
    const res = build({
      disallowedTools: ["Write"],
      allowedToolsOverride: ["Write"],
    });
    expect(res.permission.edit).toBeUndefined();
  });
});

describe("buildOpencodePermission — mode semantics", () => {
  it("allow mode drops the user-configured denylist entirely", () => {
    const res = build({
      mode: "allow",
      disallowedTools: ["Bash(rm -rf *)", "Edit(/etc/**)", "Read(~/.ssh/**)"],
    });
    expect(res.permission).toEqual({});
    expect(res.toolsHardDisable).toEqual({});
    expect(res.warnings).toEqual([]);
  });

  it("allow mode still surfaces mcpDisallowed warnings (autonomous-strip safety net)", () => {
    const res = build({
      mode: "allow",
      mcpDisallowed: ["mcp__finance__a"],
    });
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain("server 'finance'");
  });

  it("allow mode ignores allowedToolsOverride (moot — no denies to override)", () => {
    const res = build({
      mode: "allow",
      disallowedTools: ["Bash(x)"],
      allowedToolsOverride: ["Bash(y)"],
    });
    expect(res.permission).toEqual({});
  });
});

describe("buildOpencodePermission — empty input", () => {
  it("empty arrays return an entirely empty result", () => {
    const res = build({});
    expect(res).toEqual({
      permission: {},
      toolsHardDisable: {},
      warnings: [],
    });
  });
});

describe("__test.parseToolEntry — internal parser exposed for property tests", () => {
  const { parseToolEntry } = __test;

  it.each([
    ["Bash", { name: "Bash", pattern: null }],
    ["Bash(rm -rf *)", { name: "Bash", pattern: "rm -rf *" }],
    ["WebFetch", { name: "WebFetch", pattern: null }],
    ["mcp__a__b", { name: "mcp__a__b", pattern: null }],
    ["  Edit ( /etc/** )  ", { name: "Edit", pattern: "/etc/**" }],
    ["Read()", { name: "Read", pattern: null }],
  ])("parses %s", (input, expected) => {
    expect(parseToolEntry(input)).toEqual(expected);
  });

  it.each([" ", "", "Bash(", "()", "(no-name)"])(
    "rejects malformed entry: %s",
    (input) => {
      expect(parseToolEntry(input)).toBeNull();
    },
  );
});

describe("__test.extractMcpServerId", () => {
  const { extractMcpServerId } = __test;

  it("returns server id for valid mcp__server__tool", () => {
    expect(extractMcpServerId("mcp__finance__transfer")).toBe("finance");
  });

  it("returns null for non-mcp tools", () => {
    expect(extractMcpServerId("Bash")).toBeNull();
  });

  it("returns null when there is no separator after server", () => {
    expect(extractMcpServerId("mcp__lone")).toBeNull();
  });

  it("returns null when server segment is empty", () => {
    expect(extractMcpServerId("mcp____tool")).toBeNull();
  });
});
