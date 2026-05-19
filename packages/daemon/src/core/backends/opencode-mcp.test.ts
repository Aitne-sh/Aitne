import { describe, expect, it } from "vitest";
import {
  renderOpencodeMcp,
  isAcceptableOpencodeServerName,
} from "./opencode-mcp.js";
import type { McpServer } from "../../services/mcp/types.js";

function stdio(overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: "weather",
    name: "Weather",
    transport: "stdio",
    command: "node",
    args: ["./weather-mcp.js"],
    cwd: null,
    url: null,
    envKeys: [],
    headerKeys: [],
    backends: ["opencode"],
    enabled: true,
    riskTier: "read",
    toolAllowlist: null,
    lastProbeAt: null,
    lastProbeStatus: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as McpServer;
}

function http(overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: "linear",
    name: "Linear",
    transport: "http",
    command: null,
    args: null,
    cwd: null,
    url: "https://mcp.example/v1",
    envKeys: [],
    headerKeys: ["Authorization"],
    backends: ["opencode"],
    enabled: true,
    riskTier: "approve",
    toolAllowlist: null,
    lastProbeAt: null,
    lastProbeStatus: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as McpServer;
}

describe("isAcceptableOpencodeServerName", () => {
  it.each([
    ["weather", true],
    ["weather-app", true],
    ["wx2", true],
    ["weather_app", false], // underscore disallowed
    ["Weather", false], // uppercase disallowed
    ["-leading", false],
    ["", false],
    ["a.b", false],
  ])("'%s' → %s", (id, expected) => {
    expect(isAcceptableOpencodeServerName(id)).toBe(expected);
  });
});

describe("renderOpencodeMcp — stdio transport", () => {
  it("emits a local config with command + args joined into argv", () => {
    const res = renderOpencodeMcp({
      servers: [stdio()],
      secrets: {},
    });
    expect(res.mcp).toEqual({
      weather: {
        type: "local",
        command: ["node", "./weather-mcp.js"],
        enabled: true,
      },
    });
    expect(res.warnings).toEqual([]);
    expect(res.env).toEqual({});
  });

  it("inlines envKeys into the 'environment' map (no ${VAR} expansion)", () => {
    const res = renderOpencodeMcp({
      servers: [stdio({ envKeys: ["OPENWEATHER_TOKEN"] })],
      secrets: { "weather:OPENWEATHER_TOKEN": "sk-xyz" },
    });
    const local = res.mcp.weather as {
      environment?: Record<string, string>;
    };
    expect(local.environment).toEqual({ OPENWEATHER_TOKEN: "sk-xyz" });
  });

  it("omits envKeys whose secret value was not resolved", () => {
    const res = renderOpencodeMcp({
      servers: [stdio({ envKeys: ["MISSING"] })],
      secrets: {},
    });
    const local = res.mcp.weather as {
      environment?: Record<string, string>;
    };
    expect(local.environment).toBeUndefined();
  });

  it("applies defaultTimeoutMs when provided", () => {
    const res = renderOpencodeMcp({
      servers: [stdio()],
      secrets: {},
      defaultTimeoutMs: 10_000,
    });
    expect((res.mcp.weather as { timeout?: number }).timeout).toBe(10_000);
  });

  it("skips stdio servers with no command and reports the skip", () => {
    const res = renderOpencodeMcp({
      servers: [stdio({ command: null })],
      secrets: {},
    });
    expect(res.mcp).toEqual({});
    expect(res.warnings[0]).toMatch(/no 'command'/);
  });

  it("handles missing args array gracefully", () => {
    const res = renderOpencodeMcp({
      servers: [stdio({ args: null })],
      secrets: {},
    });
    expect((res.mcp.weather as { command: string[] }).command).toEqual(["node"]);
  });
});

describe("renderOpencodeMcp — http / sse transports", () => {
  it("emits a remote config with url + Authorization header inlined", () => {
    const res = renderOpencodeMcp({
      servers: [http()],
      secrets: { "linear:Authorization": "Bearer abc" },
    });
    expect(res.mcp).toEqual({
      linear: {
        type: "remote",
        url: "https://mcp.example/v1",
        enabled: true,
        headers: { Authorization: "Bearer abc" },
      },
    });
  });

  it("sse transport flows through the same shape as http", () => {
    const res = renderOpencodeMcp({
      servers: [http({ id: "linear-sse", transport: "sse" })],
      secrets: { "linear-sse:Authorization": "Bearer abc" },
    });
    expect((res.mcp["linear-sse"] as { type: string }).type).toBe("remote");
  });

  it("skips remote servers with no url and reports the skip", () => {
    const res = renderOpencodeMcp({
      servers: [http({ url: null })],
      secrets: {},
    });
    expect(res.mcp).toEqual({});
    expect(res.warnings[0]).toMatch(/no 'url'/);
  });

  it("omits headers when no header secret resolved", () => {
    const res = renderOpencodeMcp({
      servers: [http({ headerKeys: ["X-Custom"] })],
      secrets: {},
    });
    expect((res.mcp.linear as { headers?: Record<string, string> }).headers).toBeUndefined();
  });

  it("applies defaultTimeoutMs to remote configs (parity with stdio)", () => {
    const res = renderOpencodeMcp({
      servers: [http()],
      secrets: { "linear:Authorization": "Bearer t" },
      defaultTimeoutMs: 12_000,
    });
    expect((res.mcp.linear as { timeout?: number }).timeout).toBe(12_000);
  });
});

describe("renderOpencodeMcp — lint and disabled rows", () => {
  it("rejects server ids containing underscores with an explanatory warning", () => {
    const res = renderOpencodeMcp({
      servers: [stdio({ id: "weather_app" })],
      secrets: {},
    });
    expect(res.mcp).toEqual({});
    expect(res.warnings[0]).toMatch(/server 'weather_app' rejected/);
    expect(res.warnings[0]).toMatch(/mcp__<server>__<tool>/);
  });

  it("drops disabled servers entirely (no row, no warning)", () => {
    const res = renderOpencodeMcp({
      servers: [stdio({ enabled: false })],
      secrets: {},
    });
    expect(res.mcp).toEqual({});
    expect(res.warnings).toEqual([]);
  });

  it("multiple servers — one valid, one rejected — produce a partial map", () => {
    const res = renderOpencodeMcp({
      servers: [stdio(), stdio({ id: "bad_name" })],
      secrets: {},
    });
    expect(Object.keys(res.mcp)).toEqual(["weather"]);
    expect(res.warnings).toHaveLength(1);
  });
});

describe("renderOpencodeMcp — empty input", () => {
  it("returns an empty render for no servers", () => {
    const res = renderOpencodeMcp({ servers: [], secrets: {} });
    expect(res).toEqual({ mcp: {}, env: {}, warnings: [] });
  });
});
