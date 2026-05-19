import { describe, it, expect } from "vitest";
import {
  buildMcpDisallowedTools,
  claudeMcpToolName,
  classifyMcpServerTier,
  mcpToolNamespaceKey,
  parseMcpToolName,
} from "./risk.js";
import { RiskTier } from "../../safety/risk-classifier.js";
import type { McpServer } from "./types.js";

function makeServer(partial: Partial<McpServer> & Pick<McpServer, "id">): McpServer {
  return {
    id: partial.id,
    name: partial.name ?? partial.id,
    transport: partial.transport ?? "http",
    command: partial.command ?? null,
    args: partial.args ?? null,
    cwd: partial.cwd ?? null,
    url: partial.url ?? "https://example.com/mcp",
    envKeys: partial.envKeys ?? [],
    headerKeys: partial.headerKeys ?? [],
    backends: partial.backends ?? ["claude"],
    enabled: partial.enabled ?? true,
    riskTier: partial.riskTier ?? "approve",
    toolAllowlist: partial.toolAllowlist ?? null,
    lastProbeAt: partial.lastProbeAt ?? Date.now(),
    lastProbeStatus: partial.lastProbeStatus ?? null,
    createdAt: partial.createdAt ?? 0,
    updatedAt: partial.updatedAt ?? 0,
  };
}

describe("classifyMcpServerTier", () => {
  it("maps each McpRiskTier to the shared RiskTier (post-Notify-abolition)", () => {
    expect(classifyMcpServerTier("read")).toBe(RiskTier.ReadSensitive);
    expect(classifyMcpServerTier("approve")).toBe(RiskTier.Approve);
  });
});

describe("tool name formatters", () => {
  it("formats the Claude SDK double-underscore tool name", () => {
    expect(claudeMcpToolName("monday", "create-task")).toBe(
      "mcp__monday__create-task",
    );
  });
  it("formats the namespace key used for audit / risk reasoning", () => {
    expect(mcpToolNamespaceKey("monday", "create-task")).toBe(
      "mcp-tool:monday:create-task",
    );
  });
});

describe("parseMcpToolName", () => {
  it("parses a well-formed Claude SDK MCP tool name", () => {
    expect(parseMcpToolName("mcp__monday__create-task")).toEqual({
      serverId: "monday",
      toolName: "create-task",
    });
  });

  it("returns null for non-MCP tool names", () => {
    expect(parseMcpToolName("Bash")).toBeNull();
    expect(parseMcpToolName("")).toBeNull();
  });

  it("returns null for malformed MCP names missing a server or tool segment", () => {
    expect(parseMcpToolName("mcp____tool")).toBeNull();
    expect(parseMcpToolName("mcp__srv__")).toBeNull();
    expect(parseMcpToolName("mcp__srv")).toBeNull();
  });

  it("tolerates tool names that themselves contain `__`", () => {
    // Server ids are kebab-only (no `__`), so splitting on the first `__`
    // after `mcp__` always picks the right boundary.
    expect(parseMcpToolName("mcp__srv__tool__with__underscores")).toEqual({
      serverId: "srv",
      toolName: "tool__with__underscores",
    });
  });

  it("parses Gemini single-underscore namespace (mcp_<server>_<tool>)", () => {
    // Confirmed via Gemini stream-event probe 2026-04-26: Gemini CLI
    // emits `mcp_<server>_<tool>` (single underscore separators) per its
    // baked-in MCP_TOOL_PREFIX = "mcp_" runtime constant. Server ids may
    // contain hyphens; tool names may contain dots and additional
    // underscores. Splitting on the FIRST `_` after `mcp_` picks the
    // server/tool boundary correctly.
    expect(parseMcpToolName("mcp_google-workspace_gmail.search")).toEqual({
      serverId: "google-workspace",
      toolName: "gmail.search",
    });
    expect(parseMcpToolName("mcp_google-workspace_calendar.listEvents")).toEqual(
      { serverId: "google-workspace", toolName: "calendar.listEvents" },
    );
    expect(parseMcpToolName("mcp_notion_notion-search")).toEqual({
      serverId: "notion",
      toolName: "notion-search",
    });
  });

  it("returns null for malformed Gemini-shape names", () => {
    // No tool segment after the server name.
    expect(parseMcpToolName("mcp_notion_")).toBeNull();
    // No server segment between the prefix and the separator.
    expect(parseMcpToolName("mcp__tool")).toBeNull();
  });
});

describe("buildMcpDisallowedTools", () => {
  it("returns empty when no servers are enabled", () => {
    const servers = [makeServer({ id: "a", enabled: false })];
    expect(
      buildMcpDisallowedTools({ servers, autonomous: true }),
    ).toEqual([]);
  });

  it("on reactive session with no allowlist, emits nothing", () => {
    const servers = [
      makeServer({
        id: "monday",
        riskTier: "approve",
        lastProbeStatus: {
          ok: true,
          toolCount: 2,
          tools: [{ name: "read-task" }, { name: "create-task" }],
          durationMs: 5,
        },
      }),
    ];
    expect(
      buildMcpDisallowedTools({ servers, autonomous: false }),
    ).toEqual([]);
  });

  it("on autonomous session, strips every probe tool from approve-tier server", () => {
    const servers = [
      makeServer({
        id: "monday",
        riskTier: "approve",
        lastProbeStatus: {
          ok: true,
          toolCount: 2,
          tools: [{ name: "read-task" }, { name: "create-task" }],
          durationMs: 5,
        },
      }),
      // Read-tier server survives autonomous sessions; only approve-tier
      // is stripped per the autonomous gate.
      makeServer({
        id: "weather",
        riskTier: "read",
        lastProbeStatus: {
          ok: true,
          toolCount: 1,
          tools: [{ name: "forecast" }],
          durationMs: 3,
        },
      }),
    ];
    expect(
      buildMcpDisallowedTools({ servers, autonomous: true }).sort(),
    ).toEqual(["mcp__monday__create-task", "mcp__monday__read-task"]);
  });

  it("blocks probe tools not on allowlist regardless of autonomous", () => {
    const servers = [
      makeServer({
        id: "monday",
        riskTier: "read",
        toolAllowlist: ["read-task"],
        lastProbeStatus: {
          ok: true,
          toolCount: 3,
          tools: [
            { name: "read-task" },
            { name: "create-task" },
            { name: "delete-task" },
          ],
          durationMs: 5,
        },
      }),
    ];
    expect(
      buildMcpDisallowedTools({ servers, autonomous: false }).sort(),
    ).toEqual(["mcp__monday__create-task", "mcp__monday__delete-task"]);
    expect(
      buildMcpDisallowedTools({ servers, autonomous: true }).sort(),
    ).toEqual(["mcp__monday__create-task", "mcp__monday__delete-task"]);
  });

  it("missing lastProbeStatus leaves the disallow list empty even with allowlist", () => {
    const servers = [
      makeServer({
        id: "fresh",
        riskTier: "read",
        toolAllowlist: ["only-one"],
        lastProbeStatus: null,
      }),
    ];
    // Nothing to enumerate — the probe hasn't run yet. The UI should block
    // enable without a probe, but the helper itself is tolerant.
    expect(buildMcpDisallowedTools({ servers, autonomous: true })).toEqual(
      [],
    );
  });
});
