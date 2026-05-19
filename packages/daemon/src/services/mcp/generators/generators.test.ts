import { describe, it, expect } from "vitest";
import type { McpServer } from "../types.js";
import {
  generateClaudeConfig,
  generateCodexConfig,
  generateGeminiConfig,
  generateMcpConfig,
  GENERATOR_SPEC_VERSIONS,
} from "./index.js";

function makeServer(overrides: Partial<McpServer>): McpServer {
  const now = Date.now();
  return {
    id: overrides.id ?? "srv",
    name: overrides.name ?? "Srv",
    transport: overrides.transport ?? "stdio",
    command: overrides.command ?? null,
    args: overrides.args ?? null,
    cwd: overrides.cwd ?? null,
    url: overrides.url ?? null,
    envKeys: overrides.envKeys ?? [],
    headerKeys: overrides.headerKeys ?? [],
    backends: overrides.backends ?? ["claude"],
    enabled: overrides.enabled ?? true,
    riskTier: overrides.riskTier ?? "approve",
    toolAllowlist: overrides.toolAllowlist ?? null,
    lastProbeAt: null,
    lastProbeStatus: null,
    createdAt: now,
    updatedAt: now,
  };
}

const MONDAY: McpServer = makeServer({
  id: "monday",
  name: "Monday",
  transport: "http",
  url: "https://mcp.monday.com/mcp",
  headerKeys: ["Authorization"],
  backends: ["claude", "codex", "gemini"],
});

const HA: McpServer = makeServer({
  id: "home-assistant",
  name: "Home Assistant",
  transport: "stdio",
  command: "npx",
  args: ["-y", "ha-mcp-server"],
  envKeys: ["HA_URL", "HA_TOKEN"],
  backends: ["claude", "codex", "gemini"],
});

const DISABLED: McpServer = makeServer({
  id: "disabled",
  name: "Disabled",
  transport: "http",
  url: "https://x",
  backends: ["claude"],
  enabled: false,
});

describe("generators — spec versions", () => {
  it("exports a SPEC_VERSION per backend", () => {
    expect(GENERATOR_SPEC_VERSIONS.claude).toMatch(/^claude-\d{4}-\d{2}-\d{2}$/);
    expect(GENERATOR_SPEC_VERSIONS.codex).toMatch(/^codex-\d{4}-\d{2}-\d{2}$/);
    expect(GENERATOR_SPEC_VERSIONS.gemini).toMatch(/^gemini-\d{4}-\d{2}-\d{2}$/);
    expect(GENERATOR_SPEC_VERSIONS.opencode).toBe("deferred");
  });
});

describe("generateClaudeConfig", () => {
  it("skips disabled servers", () => {
    const out = generateClaudeConfig([DISABLED], { secrets: {} });
    expect(JSON.parse(out.contents)).toEqual({ mcpServers: {} });
  });

  it("renders http with header placeholder + stdio with env placeholder", () => {
    const out = generateClaudeConfig([MONDAY, HA], {
      secrets: {
        "monday:Authorization": "Bearer tok",
        "home-assistant:HA_URL": "http://ha",
        "home-assistant:HA_TOKEN": "t",
      },
    });
    expect(out.path).toBe(".mcp.json");
    const parsed = JSON.parse(out.contents);
    expect(parsed.mcpServers.monday).toEqual({
      type: "http",
      url: "https://mcp.monday.com/mcp",
      headers: { Authorization: "${MCP_MONDAY_AUTHORIZATION}" },
    });
    expect(parsed.mcpServers["home-assistant"]).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "ha-mcp-server"],
      env: {
        HA_URL: "${MCP_HOME_ASSISTANT_HA_URL}",
        HA_TOKEN: "${MCP_HOME_ASSISTANT_HA_TOKEN}",
      },
    });
    expect(out.env).toEqual({
      MCP_MONDAY_AUTHORIZATION: "Bearer tok",
      MCP_HOME_ASSISTANT_HA_URL: "http://ha",
      MCP_HOME_ASSISTANT_HA_TOKEN: "t",
    });
  });

  it("omits empty env/headers sections", () => {
    const bare = makeServer({
      id: "bare",
      transport: "http",
      url: "https://x",
      headerKeys: [],
      backends: ["claude"],
    });
    const out = generateClaudeConfig([bare], { secrets: {} });
    const parsed = JSON.parse(out.contents);
    expect(parsed.mcpServers.bare).toEqual({ type: "http", url: "https://x" });
  });

  it("filters servers that don't target claude", () => {
    const codexOnly = makeServer({
      id: "codex-only",
      transport: "http",
      url: "https://x",
      backends: ["codex"],
    });
    const out = generateClaudeConfig([codexOnly], { secrets: {} });
    expect(JSON.parse(out.contents)).toEqual({ mcpServers: {} });
  });

  it("renders sse transport", () => {
    const sse = makeServer({
      id: "sse-srv",
      transport: "sse",
      url: "https://example.com/sse",
      backends: ["claude"],
    });
    const out = generateClaudeConfig([sse], { secrets: {} });
    const parsed = JSON.parse(out.contents);
    expect(parsed.mcpServers["sse-srv"]).toEqual({
      type: "sse",
      url: "https://example.com/sse",
    });
  });
});

describe("generateCodexConfig", () => {
  it("inlines stdio env and adds experimental_use_rmcp_client only when HTTP is present", () => {
    const out = generateCodexConfig([HA], {
      secrets: {
        "home-assistant:HA_URL": "http://ha",
        "home-assistant:HA_TOKEN": "t",
      },
    });
    expect(out.path).toBe(".codex/config.toml");
    expect(out.contents).toContain("[mcp_servers.home-assistant]");
    expect(out.contents).toContain(`command = "npx"`);
    expect(out.contents).toContain(`HA_URL = "http://ha"`);
    expect(out.contents).toContain(`HA_TOKEN = "t"`);
    expect(out.contents).not.toContain("experimental_use_rmcp_client");
    // stdio secrets are inlined into the TOML, not carried via env.
    expect(out.env).toEqual({});
  });

  it("uses bearer_token_env_var for http servers with Authorization", () => {
    const out = generateCodexConfig([MONDAY], {
      secrets: { "monday:Authorization": "Bearer tok" },
    });
    expect(out.contents).toContain("experimental_use_rmcp_client = true");
    expect(out.contents).toContain(`url = "https://mcp.monday.com/mcp"`);
    expect(out.contents).toContain(
      `bearer_token_env_var = "MCP_MONDAY_AUTHORIZATION"`,
    );
    expect(out.env).toEqual({ MCP_MONDAY_AUTHORIZATION: "Bearer tok" });
  });

  it("skips servers not targeting codex", () => {
    const claudeOnly = makeServer({
      id: "claude-only",
      transport: "http",
      url: "https://x",
      backends: ["claude"],
    });
    const out = generateCodexConfig([claudeOnly], { secrets: {} });
    expect(out.contents).toBe("");
  });
});

describe("generateGeminiConfig", () => {
  it("emits httpUrl with $VAR (no braces) and stdio env with $VAR", () => {
    const out = generateGeminiConfig([MONDAY, HA], {
      secrets: {
        "monday:Authorization": "Bearer tok",
        "home-assistant:HA_URL": "http://ha",
        "home-assistant:HA_TOKEN": "t",
      },
    });
    expect(out.path).toBe(".gemini/settings.json");
    const parsed = JSON.parse(out.contents);
    expect(parsed.mcpServers.monday).toEqual({
      httpUrl: "https://mcp.monday.com/mcp",
      headers: { Authorization: "$MCP_MONDAY_AUTHORIZATION" },
    });
    expect(parsed.mcpServers["home-assistant"]).toEqual({
      command: "npx",
      args: ["-y", "ha-mcp-server"],
      env: {
        HA_URL: "$MCP_HOME_ASSISTANT_HA_URL",
        HA_TOKEN: "$MCP_HOME_ASSISTANT_HA_TOKEN",
      },
    });
    // Gemini does not read .env — we MUST export every referenced var.
    expect(out.env).toEqual({
      MCP_MONDAY_AUTHORIZATION: "Bearer tok",
      MCP_HOME_ASSISTANT_HA_URL: "http://ha",
      MCP_HOME_ASSISTANT_HA_TOKEN: "t",
    });
  });

  it("uses url (not httpUrl) for sse transport", () => {
    const sse = makeServer({
      id: "sse-srv",
      transport: "sse",
      url: "https://example.com/sse",
      backends: ["gemini"],
    });
    const out = generateGeminiConfig([sse], { secrets: {} });
    const parsed = JSON.parse(out.contents);
    expect(parsed.mcpServers["sse-srv"]).toEqual({
      url: "https://example.com/sse",
    });
  });
});

describe("generateMcpConfig dispatcher", () => {
  it("routes to the right generator per backend", () => {
    expect(generateMcpConfig("claude", [MONDAY], { secrets: {} }).path).toBe(
      ".mcp.json",
    );
    expect(generateMcpConfig("codex", [MONDAY], { secrets: {} }).path).toBe(
      ".codex/config.toml",
    );
    expect(generateMcpConfig("gemini", [MONDAY], { secrets: {} }).path).toBe(
      ".gemini/settings.json",
    );
  });

  it("makes OpenCode MCP generation explicitly deferred", () => {
    expect(() =>
      generateMcpConfig("opencode", [MONDAY], { secrets: {} }),
    ).toThrow(/OpenCode.*deferred/);
  });

  it("throws for an unknown backend", () => {
    expect(() =>
      // @ts-expect-error — exhaustive check for safety
      generateMcpConfig("unknown", [], { secrets: {} }),
    ).toThrow(/Unsupported backend/);
  });
});

describe("generator branches — stdio with cwd, missing pieces", () => {
  it("claude: stdio keeps cwd and omits args/env when absent", () => {
    const bare = makeServer({
      id: "bare",
      transport: "stdio",
      command: "foo",
      cwd: "/srv/here",
      backends: ["claude"],
    });
    const out = generateClaudeConfig([bare], { secrets: {} });
    const parsed = JSON.parse(out.contents);
    expect(parsed.mcpServers.bare).toEqual({
      type: "stdio",
      command: "foo",
      cwd: "/srv/here",
    });
  });

  it("claude: stdio server whose command is cleared falls through silently", () => {
    // Simulates a row where the DB somehow has transport=stdio but command=null
    // (e.g. read from a hand-edited DB). The generator must not emit an entry
    // and must not throw.
    const broken = makeServer({
      id: "broken",
      transport: "stdio",
      command: null,
      backends: ["claude"],
    });
    const out = generateClaudeConfig([broken], { secrets: {} });
    expect(JSON.parse(out.contents)).toEqual({ mcpServers: {} });
  });

  it("claude: http server without a url is skipped", () => {
    const noUrl = makeServer({
      id: "no-url",
      transport: "http",
      url: null,
      backends: ["claude"],
    });
    const out = generateClaudeConfig([noUrl], { secrets: {} });
    expect(JSON.parse(out.contents)).toEqual({ mcpServers: {} });
  });

  it("codex: http without Authorization header omits bearer_token_env_var", () => {
    const anon = makeServer({
      id: "anon",
      transport: "http",
      url: "https://example.com/mcp",
      headerKeys: [],
      backends: ["codex"],
    });
    const out = generateCodexConfig([anon], { secrets: {} });
    expect(out.contents).toContain(`url = "https://example.com/mcp"`);
    expect(out.contents).not.toContain("bearer_token_env_var");
    expect(out.env).toEqual({});
  });

  it("codex: stdio without args/env still emits a valid entry", () => {
    const bare = makeServer({
      id: "bare",
      transport: "stdio",
      command: "foo",
      backends: ["codex"],
    });
    const out = generateCodexConfig([bare], { secrets: {} });
    expect(out.contents).toContain(`command = "foo"`);
    expect(out.contents).not.toContain("args");
    expect(out.contents).not.toContain("env");
  });

  it("codex: stdio with cwd emits cwd", () => {
    const cwdServer = makeServer({
      id: "cwd",
      transport: "stdio",
      command: "foo",
      cwd: "/srv",
      backends: ["codex"],
    });
    const out = generateCodexConfig([cwdServer], { secrets: {} });
    expect(out.contents).toContain(`cwd = "/srv"`);
  });

  it("codex: stdio server missing command is silently skipped", () => {
    const broken = makeServer({
      id: "broken",
      transport: "stdio",
      command: null,
      backends: ["codex"],
    });
    const out = generateCodexConfig([broken], { secrets: {} });
    expect(out.contents).toBe("");
  });

  it("codex: http server without url is silently skipped", () => {
    const noUrl = makeServer({
      id: "nu",
      transport: "http",
      url: null,
      backends: ["codex"],
    });
    const out = generateCodexConfig([noUrl], { secrets: {} });
    expect(out.contents).toBe("");
  });

  it("codex: stdio skips env keys whose secrets are absent", () => {
    const srv = makeServer({
      id: "srv",
      transport: "stdio",
      command: "a",
      envKeys: ["KNOWN", "MISSING"],
      backends: ["codex"],
    });
    const out = generateCodexConfig([srv], {
      secrets: { "srv:KNOWN": "k" },
    });
    expect(out.contents).toContain(`KNOWN = "k"`);
    expect(out.contents).not.toContain("MISSING");
  });

  it("gemini: stdio keeps cwd and omits args/env when absent", () => {
    const bare = makeServer({
      id: "bare",
      transport: "stdio",
      command: "foo",
      cwd: "/srv/two",
      backends: ["gemini"],
    });
    const out = generateGeminiConfig([bare], { secrets: {} });
    const parsed = JSON.parse(out.contents);
    expect(parsed.mcpServers.bare).toEqual({
      command: "foo",
      cwd: "/srv/two",
    });
  });

  it("gemini: http without headers has no headers section", () => {
    const bare = makeServer({
      id: "bare",
      transport: "http",
      url: "https://example.com",
      headerKeys: [],
      backends: ["gemini"],
    });
    const out = generateGeminiConfig([bare], { secrets: {} });
    const parsed = JSON.parse(out.contents);
    expect(parsed.mcpServers.bare).toEqual({
      httpUrl: "https://example.com",
    });
  });

  it("gemini: sse without headers has no headers section", () => {
    const bare = makeServer({
      id: "sse-bare",
      transport: "sse",
      url: "https://example.com/sse",
      headerKeys: [],
      backends: ["gemini"],
    });
    const out = generateGeminiConfig([bare], { secrets: {} });
    const parsed = JSON.parse(out.contents);
    expect(parsed.mcpServers["sse-bare"]).toEqual({
      url: "https://example.com/sse",
    });
  });

  it("gemini: stdio without command is skipped", () => {
    const broken = makeServer({
      id: "broken",
      transport: "stdio",
      command: null,
      backends: ["gemini"],
    });
    const out = generateGeminiConfig([broken], { secrets: {} });
    expect(JSON.parse(out.contents)).toEqual({ mcpServers: {} });
  });

  it("gemini: http/sse without url are skipped", () => {
    const noUrl = makeServer({
      id: "http-no-url",
      transport: "http",
      url: null,
      backends: ["gemini"],
    });
    const noSse = makeServer({
      id: "sse-no-url",
      transport: "sse",
      url: null,
      backends: ["gemini"],
    });
    const out = generateGeminiConfig([noUrl, noSse], { secrets: {} });
    expect(JSON.parse(out.contents)).toEqual({ mcpServers: {} });
  });

  it("gemini: sse with a header key emits the headers object with $VAR", () => {
    const sseAuth = makeServer({
      id: "sse-auth",
      transport: "sse",
      url: "https://example.com/sse",
      headerKeys: ["Authorization"],
      backends: ["gemini"],
    });
    const out = generateGeminiConfig([sseAuth], {
      secrets: { "sse-auth:Authorization": "tok" },
    });
    const parsed = JSON.parse(out.contents);
    expect(parsed.mcpServers["sse-auth"]).toEqual({
      url: "https://example.com/sse",
      headers: { Authorization: "$MCP_SSE_AUTH_AUTHORIZATION" },
    });
  });

  it("codex: sse transport reuses the http branch and emits url + bearer env", () => {
    const sseAuth = makeServer({
      id: "sse-auth",
      transport: "sse",
      url: "https://example.com/sse",
      headerKeys: ["Authorization"],
      backends: ["codex"],
    });
    const out = generateCodexConfig([sseAuth], {
      secrets: { "sse-auth:Authorization": "Bearer tok" },
    });
    expect(out.contents).toContain("experimental_use_rmcp_client = true");
    expect(out.contents).toContain(`url = "https://example.com/sse"`);
    expect(out.contents).toContain(
      `bearer_token_env_var = "MCP_SSE_AUTH_AUTHORIZATION"`,
    );
  });
});
