import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEvent, EventPriority } from "@aitne/shared";
import type { AgentResult, BackendId, RoutineEvent } from "@aitne/shared";
import { applySchema } from "../db/schema.js";
import { BackendQuotaError } from "./agent-core.js";
import { PromptAssembler } from "./dispatcher-prompt.js";
import {
  getTaskFlow as realGetTaskFlow,
  initTaskFlows,
  resetTaskFlowsForTest,
} from "./prompts.js";
import {
  RoutineFetchWindowRunner,
  composePrePassAllowedTools,
  parseFetchWindowOutput,
  renderFetchReportBlock,
  routineWindowKeyFromEvent,
} from "./routine-fetch-window-runner.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TEST_DIR, "..", "..", "..", "..");
import type { IntegrationKey, IntegrationState } from "@aitne/shared";
import type { AgentConfig } from "../config.js";
import type { IAgentRouter } from "./backends/backend-router.js";
import type { AutonomousSpawnGate } from "./spawn-gates.js";
import type { IAuditLogger, IContextBuilder } from "./dispatcher-types.js";
import type { MailAccount } from "../services/mail/provider.js";

function fakeConfig(
  dataDir: string,
  overrides: Partial<AgentConfig> = {},
): AgentConfig {
  return {
    dataDir,
    workspaceDir: join(dataDir, "workdirs"),
    apiPort: 0,
    timezone: "UTC",
    dayBoundaryHour: 4,
    ...overrides,
  } as unknown as AgentConfig;
}

function makeAudit(): IAuditLogger {
  return {
    logAction: vi.fn(),
    logSkip: vi.fn(),
    logError: vi.fn(),
    logAttachment: vi.fn(),
    logBangCommand: vi.fn(),
  } as unknown as IAuditLogger;
}

function makeBinding(overrides: { backendId?: BackendId; modelId?: string } = {}) {
  const backendId: BackendId = overrides.backendId ?? ("claude" as BackendId);
  return {
    main: {
      backendId,
      modelId: overrides.modelId ?? "claude-haiku-4-5",
      maxTurns: 20,
      maxBudgetUsd: 0.2,
    },
    fallback: null,
    processKey: "routine.fetch_window" as const,
  };
}

function makeAgentResult(output: string, costUsd: number = 0.001): AgentResult {
  return {
    output,
    sessionId: null,
    backendId: "claude" as BackendId,
    modelId: "claude-haiku-4-5",
    costUsd,
    usage: {
      inputTokens: 1000,
      outputTokens: 50,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    modelUsage: {},
    numTurns: 1,
    durationMs: 800,
    durationApiMs: 600,
    model: "claude-haiku-4-5",
    isError: false,
    stopReason: null,
    contextUpdated: false,
  };
}

function makeRouter(
  result: AgentResult | Error = makeAgentResult(
    '{"fetched":3,"posted":2,"duplicates":1,"errors":[]}',
  ),
): { router: IAgentRouter; execute: ReturnType<typeof vi.fn>; resolveBinding: ReturnType<typeof vi.fn> } {
  const execute = vi.fn().mockImplementation(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  const resolveBinding = vi.fn().mockReturnValue(makeBinding());
  const router: IAgentRouter = {
    execute,
    executeResume: vi.fn(),
    summarize: vi.fn(),
    resolveBinding,
  } as unknown as IAgentRouter;
  return { router, execute, resolveBinding };
}

function makeFetcherRunner(opts: {
  db: Database.Database;
  dataDir: string;
  router?: IAgentRouter;
  mailAccounts?: readonly MailAccount[];
  audit?: IAuditLogger;
  contextBuilder?: IContextBuilder;
  config?: Partial<AgentConfig>;
  /** N2 spawn-gate stub — omitted = no gate (legacy behavior). */
  spawnGate?: AutonomousSpawnGate;
  /**
   * Optional override for the task-flow body the assembler resolves.
   * Most existing tests use the default constant "fetcher-prompt-body";
   * the substitution tests pass a per-eventType resolver that returns
   * a body carrying the `{integration_partial}` placeholder so the
   * assertions can verify the runner inlines the integration partial.
   */
  getTaskFlow?: (
    eventType: string,
    backendId?: string,
    integrations?: Partial<Record<IntegrationKey, IntegrationState>>,
  ) => string;
}): {
  runner: RoutineFetchWindowRunner;
  audit: IAuditLogger;
  router: IAgentRouter;
  prompt: PromptAssembler;
} {
  const config = fakeConfig(opts.dataDir, opts.config);
  const audit = opts.audit ?? makeAudit();
  const router = opts.router ?? makeRouter().router;
  const contextBuilder: IContextBuilder =
    opts.contextBuilder ?? {
      build: vi.fn().mockResolvedValue("<context/>"),
      buildResumeCatchupContext: vi.fn().mockResolvedValue(null),
      buildScheduledRemindersBlock: vi.fn().mockReturnValue(null),
    };
  const prompt = new PromptAssembler({
    db: opts.db,
    config,
    getTaskFlow: opts.getTaskFlow ?? (() => "fetcher-prompt-body"),
    activeTurnTokens: new Map(),
    getAttachmentStore: () => null,
    getVoiceTranscriber: () => null,
  });
  const runner = new RoutineFetchWindowRunner({
    db: opts.db,
    config,
    contextBuilder,
    agentRouter: router,
    audit,
    prompt,
    getActiveMailAccounts: () => opts.mailAccounts ?? [],
    ...(opts.spawnGate ? { spawnGate: opts.spawnGate } : {}),
  });
  return { runner, audit, router, prompt };
}

/** Permissive-or-blocking N2 spawn-gate stub. */
function makeSpawnGate(decision: {
  skip: boolean;
  reason?: "offline" | "auth_unhealthy";
}): AutonomousSpawnGate {
  return {
    evaluate: vi.fn(async () => ({
      ...decision,
      backends: [],
    })),
  } as unknown as AutonomousSpawnGate;
}

function morningEvent(over: Partial<RoutineEvent> = {}): RoutineEvent {
  return {
    ...createEvent({
      type: "routine.morning_routine",
      source: "cron",
      priority: EventPriority.HIGH,
    }),
    routine: "morning_routine",
    data: {},
    ...over,
  } as RoutineEvent;
}

function hourlyEvent(over: Partial<RoutineEvent> = {}): RoutineEvent {
  return {
    ...createEvent({
      type: "routine.activity_scan",
      source: "cron",
      priority: EventPriority.NORMAL,
    }),
    routine: "activity_scan",
    data: {},
    ...over,
  } as RoutineEvent;
}

function integrationState(
  partial: Partial<IntegrationState> & { mode: IntegrationState["mode"] },
): IntegrationState {
  return {
    delegatedBackend: null,
    nativeBackend: null,
    deniedTools: [],
    lastChangedAt: "2026-05-11T00:00:00.000Z",
    ...partial,
  } as IntegrationState;
}

function seedIntegrations(
  db: Database.Database,
  integrations: Partial<Record<IntegrationKey, IntegrationState>>,
): void {
  db.prepare(
    `UPDATE settings
     SET value_json = ?
     WHERE key = 'integrations'`,
  ).run(JSON.stringify(integrations));
}

function gmailIntegrationDirect(db: Database.Database): void {
  // Seed integrations.gmail=direct so the acquisition plan emits a row.
  db.prepare(
    `UPDATE settings
     SET value_json = json_set(
       coalesce(value_json, '{}'),
       '$.gmail',
       json_object('mode', 'direct', 'lastChangedAt', '2026-05-11T00:00:00Z')
     )
     WHERE key = 'integrations'`,
  ).run();
}

function seedMailAccount(): MailAccount {
  return {
    id: "acct1",
    kind: "gmail",
    email: "alice@example.com",
    authStatus: "healthy",
    idleEnabled: false,
    active: true,
    createdAt: "2026-05-01T00:00:00Z",
  };
}

describe("parseFetchWindowOutput", () => {
  it("parses a well-formed JSON line", () => {
    const result = parseFetchWindowOutput(
      '{"fetched":5,"posted":4,"duplicates":1,"errors":[]}',
    );
    expect(result).toMatchObject({
      status: "success",
      fetched: 5,
      posted: 4,
      duplicates: 1,
      errors: [],
      skipped: false,
    });
  });

  it("marks status='partial' when errors are present", () => {
    const result = parseFetchWindowOutput(
      '{"fetched":3,"posted":3,"duplicates":0,"errors":[{"type":"no-surface","integration":"outlook_mail"}]}',
    );
    expect(result).toMatchObject({
      status: "partial",
      fetched: 3,
      errors: [{ type: "no-surface", integration: "outlook_mail" }],
    });
  });

  it("tolerates code fences", () => {
    const result = parseFetchWindowOutput(
      '```json\n{"fetched":1,"posted":1,"duplicates":0,"errors":[]}\n```',
    );
    expect(result).toMatchObject({ status: "success", fetched: 1 });
  });

  it("picks the LAST JSON object when prose precedes it", () => {
    const result = parseFetchWindowOutput(
      'thinking aloud {"intermediate":true}\nfinal: {"fetched":2,"posted":2,"duplicates":0,"errors":[]}',
    );
    expect(result).toMatchObject({ fetched: 2, posted: 2 });
  });

  it("returns parseError for empty output", () => {
    expect(parseFetchWindowOutput("")).toEqual({ parseError: "empty-output" });
  });

  it("returns parseError when no JSON object is found", () => {
    expect(parseFetchWindowOutput("just prose, no json")).toEqual({
      parseError: "no-json-object",
    });
  });

  it("returns parseError on malformed JSON", () => {
    const result = parseFetchWindowOutput("{not valid json}");
    expect(result).toMatchObject({ parseError: expect.stringContaining("invalid-json") });
  });

  it("coerces missing numeric fields to 0 instead of failing", () => {
    const result = parseFetchWindowOutput('{"errors":[]}');
    expect(result).toMatchObject({
      status: "success",
      fetched: 0,
      posted: 0,
      duplicates: 0,
    });
  });
});

describe("renderFetchReportBlock", () => {
  it("renders an attribute-only block when there are no errors", () => {
    const block = renderFetchReportBlock(
      {
        status: "success",
        fetched: 3,
        posted: 3,
        duplicates: 0,
        errors: [],
        skipped: false,
      },
      { routine: "routine.morning_routine", agentDay: "2026-05-11" },
    );
    expect(block).toContain('routine="morning_routine"');
    expect(block).toContain('status="success"');
    expect(block).toContain('fetched="3"');
    expect(block).toContain('posted="3"');
    expect(block).not.toContain("<error");
    expect(block.trim().endsWith("</fetch_report>")).toBe(true);
  });

  it("renders each error as a self-closing element with its attributes", () => {
    const block = renderFetchReportBlock(
      {
        status: "partial",
        fetched: 1,
        posted: 0,
        duplicates: 0,
        errors: [
          { type: "no-surface", integration: "outlook_mail", account: "me" },
          { type: "fetch-failed", integration: "gmail", status: 503 },
        ],
        skipped: false,
      },
      { routine: "routine.activity_scan", agentDay: "2026-05-11" },
    );
    expect(block).toContain(
      '<error type="no-surface" integration="outlook_mail" account="me" />',
    );
    expect(block).toContain(
      '<error type="fetch-failed" integration="gmail" status="503" />',
    );
  });

  it("XML-escapes attribute values", () => {
    const block = renderFetchReportBlock(
      {
        status: "partial",
        fetched: 0,
        posted: 0,
        duplicates: 0,
        errors: [{ type: "fetch-failed", message: 'a & b "c" <d>' }],
        skipped: false,
      },
      { routine: "routine.weekly_review", agentDay: "2026-05-11" },
    );
    expect(block).toContain("a &amp; b &quot;c&quot; &lt;d&gt;");
  });

  it("emits the failure reason for status='failed' runs", () => {
    const block = renderFetchReportBlock(
      {
        status: "failed",
        fetched: 0,
        posted: 0,
        duplicates: 0,
        errors: [{ type: "pre-pass-failed", kind: "agent-execute-failed" }],
        skipped: false,
        failureReason: "agent-execute-failed: boom",
      },
      { routine: "routine.today_refresh", agentDay: "2026-05-11" },
    );
    expect(block).toContain('status="failed"');
    expect(block).toContain("<failure>agent-execute-failed: boom</failure>");
  });
});

describe("composePrePassAllowedTools", () => {
  function state(
    partial: Partial<IntegrationState> & { mode: IntegrationState["mode"] },
  ): IntegrationState {
    return {
      delegatedBackend: null,
      nativeBackend: null,
      deniedTools: [],
      lastChangedAt: "2026-05-11T00:00:00.000Z",
      ...partial,
    } as IntegrationState;
  }

  it("emits the daemon-REST + jq baseline regardless of integration state", () => {
    const tools = composePrePassAllowedTools(8321, {}, "claude" as const);
    // The baseline covers every READ endpoint the partials hit in `direct`
    // mode plus the delegated-cross proxy plus the always-needed jq. The
    // observations WRITE surface is backend-specific (claude → MCP tool,
    // codex/gemini → curl) and is asserted separately below.
    // The `curl *URL*` shape (wildcard between `curl` and the URL)
    // tolerates the Haiku fetcher emitting flags before the URL —
    // `curl -X POST -H ... <url>` matched the same glob as
    // `curl <url> -X POST -H ...`.
    expect(tools).toContain("Bash(curl *http://localhost:8321/api/mail/*)");
    expect(tools).toContain("Bash(curl *http://localhost:8321/api/calendar/*)");
    expect(tools).toContain("Bash(curl *http://localhost:8321/api/notion/*)");
    expect(tools).toContain("Bash(curl *http://localhost:8321/api/integrations/*)");
    expect(tools).toContain("Bash(jq *)");
  });

  it("uses a wildcard between `curl` and the URL so flags-first commands match", () => {
    // Regression guard. The original prefix-anchored form
    // `Bash(curl <url>*)` silently denied `curl -X POST <url> -d @-` —
    // the SDK glob requires the literal text `curl <url>` immediately
    // after the command name, which the Haiku fetcher does NOT always
    // emit. The wildcard form must remain in every curl pattern.
    const tools = composePrePassAllowedTools(8321, {}, "claude" as const);
    const curlPatterns = tools.filter((t) => t.startsWith("Bash(curl "));
    for (const pattern of curlPatterns) {
      expect(
        pattern,
        `pre-pass curl pattern ${pattern} must start with "Bash(curl *" — otherwise flags-first POSTs are denied`,
      ).toMatch(/^Bash\(curl \*/);
    }
    // And cover the symmetric form (URL first) too — the glob's leading
    // `*` matches zero characters, so `curl <url>...` still passes.
    expect(curlPatterns.length).toBeGreaterThan(0);
  });

  it("substitutes the configured apiPort into the curl prefixes (non-default port survives)", () => {
    const tools = composePrePassAllowedTools(9999, {}, "claude" as const);
    // The override REPLACES the SDK default — a hardcoded `8321`
    // would silently deny every call on a non-default deployment.
    // (Assert on a read endpoint present for every backend; the
    // observations write curl is omitted on claude — see below.)
    expect(tools).toContain("Bash(curl *http://localhost:9999/api/mail/*)");
    expect(tools).not.toContain("Bash(curl *http://localhost:8321/api/mail/*)");
  });

  it("includes the descriptor's MCP tool names for delegated-same gmail (claude session)", () => {
    const tools = composePrePassAllowedTools(
      8321,
      { gmail: state({ mode: "delegated", delegatedBackend: "claude" }) },
      "claude" as const,
    );
    // Every Claude Gmail capability tool is namespaced
    // `mcp__claude_ai_Gmail__*` per the descriptor; assert at least one
    // representative tool is present so a registry rename surfaces
    // here instead of silently denying the partial's call.
    expect(tools.some((t) => t.startsWith("mcp__claude_ai_Gmail__"))).toBe(true);
  });

  it("includes native-mode descriptor MCP tool names when nativeBackend matches", () => {
    const tools = composePrePassAllowedTools(
      8321,
      {
        google_calendar: state({ mode: "native", nativeBackend: "claude" }),
      },
      "claude" as const,
    );
    expect(
      tools.some((t) => t.startsWith("mcp__claude_ai_Google_Calendar__")),
    ).toBe(true);
  });

  it("excludes MCP tools for cross-backend delegated bindings (proxy used instead)", () => {
    // Cross-backend delegated reaches the integration via
    // /api/integrations/<key>/exec, NOT via the session backend's MCP
    // namespace. The override should NOT widen to include the
    // cross-bound backend's MCP tools.
    const tools = composePrePassAllowedTools(
      8321,
      { gmail: state({ mode: "delegated", delegatedBackend: "codex" }) },
      "claude" as const,
    );
    expect(tools.every((t) => !t.startsWith("mcp__claude_ai_Gmail__"))).toBe(true);
    // The integrations curl prefix still allows the proxy.
    expect(tools).toContain("Bash(curl *http://localhost:8321/api/integrations/*)");
  });

  it("skips user-managed connectors (no descriptor entry → no MCP tool widening)", () => {
    // outlook_mail is user-managed; the descriptor has no
    // `backendConnectors.claude`, so the helper has nothing to add.
    // The partial records `no-surface` for these rows, which is the
    // documented contract.
    const tools = composePrePassAllowedTools(
      8321,
      {
        outlook_mail: state({ mode: "native", nativeBackend: "claude" }),
      },
      "claude" as const,
    );
    expect(tools.every((t) => !t.toLowerCase().includes("outlook"))).toBe(true);
  });

  it("never includes the catastrophic surfaces (/api/context, /api/notify, /api/agent)", () => {
    // Locks the failure mode that motivated the clamp: a misbehaving
    // Haiku turn must not be able to write context files, send
    // notifications, or call /api/agent endpoints. These must remain
    // outside the override under any integration permutation.
    const integrations: Partial<Record<IntegrationKey, IntegrationState>> = {
      gmail: state({ mode: "delegated", delegatedBackend: "claude" }),
      google_calendar: state({ mode: "native", nativeBackend: "claude" }),
      notion: state({ mode: "direct" }),
    };
    const tools = composePrePassAllowedTools(8321, integrations, "claude" as const);
    for (const tool of tools) {
      expect(tool).not.toContain("/api/context/");
      expect(tool).not.toContain("/api/notify");
      expect(tool).not.toContain("/api/agent/");
      expect(tool).not.toContain("/api/skill-curation/");
    }
  });

  it("exposes the in-process aitne-observations MCP tool on every claude pre-pass session", () => {
    // Structural fix for the 2026-05-18 gmail Unicode-whitespace incident:
    // the in-process MCP tool replaces the fragile curl-with-inline-JSON
    // path. The tool name must be present in allowed-tools for every
    // claude pre-pass session, regardless of which integrations are
    // enabled — claude-code-core registers the in-process server in
    // lock-step.
    const cases: Array<Parameters<typeof composePrePassAllowedTools>[1]> = [
      {},
      { gmail: state({ mode: "disabled" }) },
      { gmail: state({ mode: "direct" }) },
      { gmail: state({ mode: "native", nativeBackend: "claude" }) },
      { notion: state({ mode: "native", nativeBackend: "claude" }) },
    ];
    for (const integrations of cases) {
      const tools = composePrePassAllowedTools(8321, integrations, "claude" as const);
      expect(tools).toContain("mcp__aitne-observations__submit_observations");
    }
  });

  it("does NOT expose the in-process aitne-observations MCP tool on codex/gemini pre-pass (SDK MCP is Claude-only)", () => {
    // The in-process SDK MCP server is wired into claude-code-core via the
    // SDK's `mcpServers` query option. Codex / Gemini CLI subprocesses
    // have no equivalent surface today, so the tool name in their
    // allowed-tools list would silently deny every invocation. Better to
    // omit it cleanly so the partial's curl fallback path is the agent's
    // visible option.
    for (const backend of ["codex", "gemini"] as const) {
      const tools = composePrePassAllowedTools(
        8321,
        { gmail: state({ mode: "native", nativeBackend: backend }) },
        backend,
      );
      expect(tools).not.toContain("mcp__aitne-observations__submit_observations");
    }
  });

  it("omits the observations-write curl pattern on claude pre-pass (MCP tool is the only write path)", () => {
    // Root-cause fix for the recurring google_calendar `budget-cap`: a
    // `curl … -d @- <<'JSON'` body carrying Unicode whitespace (U+3000 in
    // JP calendar titles, NBSP/ZWS in promo mail subjects) trips the SDK's
    // `Ae6` bash preflight ("Contains Unicode whitespace") → too-complex →
    // dontAsk denial → retried until budget-cap. Dropping the curl allow
    // rule forces claude onto `mcp__aitne-observations__submit_observations`
    // (structured JSON, never shell-parsed). The READ curls are untouched.
    const tools = composePrePassAllowedTools(8321, {}, "claude" as const);
    expect(tools).not.toContain(
      "Bash(curl *http://localhost:8321/api/observations*)",
    );
    expect(tools).toContain("mcp__aitne-observations__submit_observations");
    expect(tools).toContain("Bash(curl *http://localhost:8321/api/mail/*)");
  });

  it("retains the observations-write curl pattern on codex/gemini pre-pass (no MCP transport)", () => {
    // Codex/Gemini have no in-process SDK MCP server, so the curl write
    // path is their only way to POST observations — keep it. They remain
    // exposed to the Unicode-whitespace preflight class until those
    // backends gain a structured channel (accepted gap, see
    // composePrePassAllowedTools).
    for (const backend of ["codex", "gemini"] as const) {
      const tools = composePrePassAllowedTools(8321, {}, backend);
      expect(tools).toContain(
        "Bash(curl *http://localhost:8321/api/observations*)",
      );
      expect(tools).not.toContain(
        "mcp__aitne-observations__submit_observations",
      );
    }
  });

  it("emits no integration MCP tool names when every integration is disabled (only the in-process aitne-observations tool remains)", () => {
    // Pre-Phase B (2026-05-18) this asserted "every tool is curl/jq baseline".
    // After Phase B the in-process MCP tool
    // `mcp__aitne-observations__submit_observations` is ALWAYS exposed for
    // claude pre-pass (it's the structural fix for the Unicode-whitespace
    // SDK denial; not an integration-dependent surface). Integration-tool
    // names (`mcp__claude_ai_*`) remain gated on enabled integrations.
    const tools = composePrePassAllowedTools(
      8321,
      {
        gmail: state({ mode: "disabled" }),
        google_calendar: state({ mode: "disabled" }),
        notion: state({ mode: "disabled" }),
      },
      "claude" as const,
    );
    const mcpTools = tools.filter((t) => t.startsWith("mcp__"));
    expect(mcpTools).toEqual(["mcp__aitne-observations__submit_observations"]);
  });

  it("appends ToolSearch on Claude sessions whenever a descriptor-bound MCP tool is present", () => {
    // Claude Code 2.1+ defers `mcp__claude_ai_*` manifests behind
    // `ToolSearch`. Without ToolSearch allowed, the Haiku fetcher's
    // first turn is a denied ToolSearch call — the session collapses
    // to one turn with no JSON, and the parent routine sees
    // `<fetch_report status="failed" reason="no-json-object">`.
    // Mirrors the same workaround in claude-delegated.ts (the
    // delegated-proxy path).
    const tools = composePrePassAllowedTools(
      8321,
      {
        google_calendar: state({ mode: "native", nativeBackend: "claude" }),
      },
      "claude" as const,
    );
    expect(tools).toContain("ToolSearch");
  });

  it("omits ToolSearch when no descriptor-bound MCP tool is present (Claude session, all disabled)", () => {
    // Pure curl/jq baseline doesn't need deferred-tool discovery —
    // keep the override minimal so a misbehaving Haiku turn has the
    // smallest possible surface.
    const tools = composePrePassAllowedTools(
      8321,
      {
        gmail: state({ mode: "disabled" }),
        google_calendar: state({ mode: "disabled" }),
      },
      "claude" as const,
    );
    expect(tools).not.toContain("ToolSearch");
  });

  it("omits ToolSearch when the only active binding is delegated-cross (proxy path, no MCP tool widening)", () => {
    // Cross-backend delegated routes through the daemon proxy, so the
    // session has no `mcp__claude_ai_*` tools to discover — ToolSearch
    // would be dead weight in the override.
    const tools = composePrePassAllowedTools(
      8321,
      { gmail: state({ mode: "delegated", delegatedBackend: "codex" }) },
      "claude" as const,
    );
    expect(tools).not.toContain("ToolSearch");
  });

  it("omits ToolSearch on non-Claude sessions (Codex/Gemini have no allowedTools surface)", () => {
    // Codex and Gemini ignore `allowedToolsOverride` for per-spawn tool
    // gating — adding ToolSearch is meaningless there and would only
    // mislead a reader scanning the override list.
    const tools = composePrePassAllowedTools(
      8321,
      {
        google_calendar: state({ mode: "native", nativeBackend: "codex" }),
      },
      "codex" as const,
    );
    expect(tools).not.toContain("ToolSearch");
  });
});

describe("routineWindowKeyFromEvent", () => {
  it("returns the matching key for routine events whose routine is in the catalog", () => {
    expect(routineWindowKeyFromEvent(morningEvent())).toBe(
      "routine.morning_routine",
    );
  });

  it("returns null for routines outside the catalog (skill_curation)", () => {
    expect(
      routineWindowKeyFromEvent(
        morningEvent({ routine: "skill_curation", type: "routine.skill_curation" }),
      ),
    ).toBeNull();
  });

  it("returns null for non-routine events (message.received)", () => {
    const msg = {
      ...createEvent({
        type: "message.received",
        source: "slack",
        priority: EventPriority.NORMAL,
      }),
    };
    expect(routineWindowKeyFromEvent(msg)).toBeNull();
  });
});

describe("RoutineFetchWindowRunner.run — skip paths (no session spawn)", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-fw-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("skips with status='skipped' when the routine is not in the catalog", async () => {
    const { router, execute } = makeRouter();
    const { runner } = makeFetcherRunner({ db, dataDir, router });
    const parent = {
      ...createEvent({
        type: "routine.skill_curation",
        source: "cron",
        priority: EventPriority.NORMAL,
      }),
      routine: "skill_curation",
      data: {},
    } as RoutineEvent;
    const { report, block } = await runner.run(parent);
    expect(report.skipped).toBe(true);
    expect(report.status).toBe("skipped");
    expect(execute).not.toHaveBeenCalled();
    expect(block).toContain('status="skipped"');
    // Attribute the report to the parent's actual event type, not to a
    // catalog placeholder — otherwise the audit feed would surface
    // misleading `routine="monthly_review"` rows whenever the runner
    // is invoked for a routine outside the window catalog.
    expect(block).toContain('routine="skill_curation"');
    expect(block).not.toContain('routine="monthly_review"');
  });

  it("skips for monthly_review (zero rows in the catalog)", async () => {
    const { router, execute } = makeRouter();
    const { runner } = makeFetcherRunner({ db, dataDir, router });
    const parent = morningEvent({
      type: "routine.monthly_review",
      routine: "monthly_review",
    });
    const { report } = await runner.run(parent);
    expect(report.skipped).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it("skips when the plan resolves to zero <fetch> rows (every integration disabled)", async () => {
    // Default seed has every mode-aware integration at 'disabled', so a
    // routine with rows in the catalog still produces an empty plan.
    const { router, execute } = makeRouter();
    const { runner } = makeFetcherRunner({ db, dataDir, router });
    const { report, block } = await runner.run(morningEvent());
    expect(report.skipped).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(block).toContain('status="skipped"');
  });
});

describe("RoutineFetchWindowRunner.run — success path", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-fw-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    gmailIntegrationDirect(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("spawns one sub-session for the single active integration, parses the report, and writes one audit row", async () => {
    const { router, execute } = makeRouter(
      makeAgentResult('{"fetched":3,"posted":2,"duplicates":1,"errors":[]}'),
    );
    const audit = makeAudit();
    const { runner } = makeFetcherRunner({
      db,
      dataDir,
      router,
      audit,
      mailAccounts: [seedMailAccount()],
      config: { prePassMaxAttemptsPerIntegration: 1 },
    });
    const parent = morningEvent();
    const { report, block } = await runner.run(parent);
    // gmail is the only active integration → exactly one sub-session.
    expect(execute).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({
      status: "success",
      fetched: 3,
      posted: 2,
      duplicates: 1,
    });
    expect(report.skipped).toBe(false);
    expect((report.perIntegration ?? []).map((r) => r.integrationKey)).toEqual([
      "gmail",
    ]);
    expect(audit.logAction).toHaveBeenCalledTimes(1);
    expect(block).toContain('status="success"');
    expect(block).toContain('<integration key="gmail"');
    // Each sub-session receives a per-integration scoped plan in event.data.
    const sentEvent = execute.mock.calls[0]![0].event as RoutineEvent;
    expect(sentEvent.type).toBe("routine.fetch_window");
    expect(typeof sentEvent.data.acquisitionPlanBlock).toBe("string");
    expect(sentEvent.data.acquisitionPlanBlock).toContain('integration="gmail"');
    expect(sentEvent.data.acquisitionPlanBlock).toContain('scoped="gmail"');

    // Defense-in-depth: every dispatched pre-pass must clamp the SDK
    // tool surface so a misbehaving Haiku turn cannot reach
    // /api/notify, /api/context/*, or any tool outside the documented
    // partial contract. The override REPLACES the SDK default (no
    // union with delegated tools) per claude-code-core.ts:437, so the
    // list must enumerate every surface the partials touch under any
    // (integration, mode) cell.
    const executeCall = execute.mock.calls[0]![0] as {
      allowedToolsOverride?: readonly string[];
    };
    expect(Array.isArray(executeCall.allowedToolsOverride)).toBe(true);
    // Claude pre-pass (makeBinding defaults to claude): the observations
    // WRITE surface is the in-process MCP tool, not a curl pattern — the
    // curl-to-/api/observations rule is deliberately omitted to close the
    // Unicode-whitespace `Ae6` preflight → budget-cap failure class.
    expect(executeCall.allowedToolsOverride).toContain(
      "mcp__aitne-observations__submit_observations",
    );
    expect(executeCall.allowedToolsOverride).not.toContain(
      "Bash(curl *http://localhost:0/api/observations*)",
    );
    expect(executeCall.allowedToolsOverride).toContain(
      "Bash(curl *http://localhost:0/api/mail/*)",
    );
    expect(executeCall.allowedToolsOverride).toContain("Bash(jq *)");
    // Catastrophic surfaces must NOT slip in via the override.
    for (const tool of executeCall.allowedToolsOverride ?? []) {
      expect(tool).not.toContain("/api/context/");
      expect(tool).not.toContain("/api/notify");
      expect(tool).not.toContain("/api/agent/");
    }
  });

  it("HOURLY_CHECK_GATE_REDESIGN_PLAN.md §3.4 — persists pre_pass_last_run runtime_state on successful completion", async () => {
    const { router } = makeRouter(
      makeAgentResult('{"fetched":1,"posted":1,"duplicates":0,"errors":[]}'),
    );
    const { runner } = makeFetcherRunner({
      db,
      dataDir,
      router,
      mailAccounts: [seedMailAccount()],
      config: { prePassMaxAttemptsPerIntegration: 1 },
    });
    const before = db
      .prepare("SELECT value_json FROM runtime_state WHERE key = 'pre_pass_last_run:gmail'")
      .get();
    expect(before).toBeUndefined();

    await runner.run(morningEvent());

    const after = db
      .prepare("SELECT value_json FROM runtime_state WHERE key = 'pre_pass_last_run:gmail'")
      .get() as { value_json: string } | undefined;
    expect(after).toBeDefined();
    const ts = JSON.parse(after!.value_json) as string;
    expect(Number.isFinite(Date.parse(ts))).toBe(true);
  });

  it("does NOT persist pre_pass_last_run when the sub-session ends in partial/failed status", async () => {
    // A `partial` outcome means real data may be missing; the
    // freshness gate must not suppress the next tick's retry.
    const { router } = makeRouter(
      makeAgentResult(
        '{"fetched":2,"posted":1,"duplicates":0,"errors":[{"type":"no-surface"}]}',
      ),
    );
    const { runner } = makeFetcherRunner({
      db,
      dataDir,
      router,
      mailAccounts: [seedMailAccount()],
      config: { prePassMaxAttemptsPerIntegration: 1 },
    });
    await runner.run(morningEvent());
    const row = db
      .prepare("SELECT value_json FROM runtime_state WHERE key = 'pre_pass_last_run:gmail'")
      .get();
    expect(row).toBeUndefined();
  });

  it("emits status='partial' when the fetcher reports per-row errors", async () => {
    const { router } = makeRouter(
      makeAgentResult(
        '{"fetched":2,"posted":1,"duplicates":0,"errors":[{"type":"no-surface","integration":"outlook_mail"}]}',
      ),
    );
    const { runner } = makeFetcherRunner({
      db,
      dataDir,
      router,
      mailAccounts: [seedMailAccount()],
      config: { prePassMaxAttemptsPerIntegration: 1 },
    });
    const { report, block } = await runner.run(morningEvent());
    expect(report.status).toBe("partial");
    // The aggregated errors array carries each sub-session's errors
    // tagged with `integration: <key>`.
    expect(report.errors[0]).toMatchObject({
      type: "no-surface",
      integration: "gmail",
    });
    expect(block).toContain('status="partial"');
  });
});

describe("RoutineFetchWindowRunner.run — fan-out coordinator (docs/design/appendices/pre-pass-fan-out.md)", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-fw-fanout-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    seedIntegrations(db, {
      gmail: integrationState({ mode: "direct" }),
      google_calendar: integrationState({ mode: "direct" }),
      notion: integrationState({ mode: "disabled" }),
    });
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("spawns one sub-session per active integration in the plan", async () => {
    const { router, execute } = makeRouter();
    execute
      .mockResolvedValueOnce(
        makeAgentResult('{"fetched":1,"posted":1,"duplicates":0,"errors":[]}'),
      )
      .mockResolvedValueOnce(
        makeAgentResult('{"fetched":2,"posted":2,"duplicates":0,"errors":[]}'),
      );
    const { runner } = makeFetcherRunner({
      db,
      dataDir,
      router,
      mailAccounts: [seedMailAccount()],
      config: {
        prePassFanOutConcurrency: 1,
        prePassMaxAttemptsPerIntegration: 1,
      },
    });

    const parent = hourlyEvent();
    const { report, block } = await runner.run(parent);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(report.status).toBe("success");
    expect(report.fetched).toBe(3);
    expect((report.perIntegration ?? []).map((r) => r.integrationKey)).toEqual([
      "gmail",
      "google_calendar",
    ]);
    expect(block).toContain('<integration key="gmail"');
    expect(block).toContain('<integration key="google_calendar"');

    const firstEvent = execute.mock.calls[0]![0].event as RoutineEvent;
    const secondEvent = execute.mock.calls[1]![0].event as RoutineEvent;
    const firstPlan = firstEvent.data.acquisitionPlanBlock as string;
    const secondPlan = secondEvent.data.acquisitionPlanBlock as string;
    expect(firstPlan).toContain('scoped="gmail"');
    expect(firstPlan).toContain('integration="gmail"');
    expect(firstPlan).not.toContain('integration="google_calendar"');
    expect(secondPlan).toContain('scoped="google_calendar"');
    expect(secondPlan).toContain('integration="google_calendar"');
    expect(secondPlan).not.toContain('integration="gmail"');
    expect(firstEvent.data.parentCorrelationId).toBe(parent.correlationId);
    expect(firstEvent.correlationId).not.toBe(parent.correlationId);
  });

  it("retries one failed integration without re-running successful siblings", async () => {
    const { router, execute } = makeRouter();
    execute
      .mockResolvedValueOnce(
        makeAgentResult('{"fetched":1,"posted":1,"duplicates":0,"errors":[]}'),
      )
      .mockResolvedValueOnce(
        makeAgentResult(
          '{"fetched":3,"posted":0,"duplicates":0,"errors":[{"type":"fetch-failed","status":400,"message":"Unknown name \\"limit\\""}]}',
        ),
      )
      .mockResolvedValueOnce(
        makeAgentResult('{"fetched":3,"posted":3,"duplicates":0,"errors":[]}'),
      );
    const audit = makeAudit();
    const { runner } = makeFetcherRunner({
      db,
      dataDir,
      router,
      audit,
      mailAccounts: [seedMailAccount()],
      config: {
        prePassFanOutConcurrency: 1,
        prePassMaxAttemptsPerIntegration: 2,
        prePassBackoffMs: [0],
      },
    });

    const { report, block } = await runner.run(hourlyEvent());

    expect(execute).toHaveBeenCalledTimes(3);
    const breakdown = report.perIntegration ?? [];
    const gmail = breakdown.find((r) => r.integrationKey === "gmail");
    const calendar = breakdown.find((r) => r.integrationKey === "google_calendar");
    expect(gmail?.attempts).toHaveLength(1);
    expect(calendar?.attempts).toHaveLength(2);
    expect(calendar?.status).toBe("success");
    expect(report.status).toBe("success");
    expect(block).toContain('key="google_calendar"');
    expect(block).toContain('attempts="2"');
    expect(block).toContain('attempt="1"');

    const retryPrompt = execute.mock.calls[2]![0].prompt as string;
    expect(retryPrompt).toContain("<prior_attempt_error");
    expect(retryPrompt).toContain('integration="google_calendar"');
    expect(retryPrompt).toContain("Unknown name &quot;limit&quot;");

    expect(audit.logAction).toHaveBeenCalledTimes(3);
    const auditCalls = (audit.logAction as ReturnType<typeof vi.fn>).mock.calls;
    const retryAudit = auditCalls[1]![0];
    expect(retryAudit.prePass).toMatchObject({
      integrationKey: "google_calendar",
      attempt: 1,
      willRetry: true,
      retryReason: "partial-no-post",
      // §7.1: the FIRST attempt has no prior — `retriedFromAttempt` is
      // explicitly null so the dashboard can render "fresh sub-session"
      // without doing a cross-row join.
      retriedFromAttempt: null,
    });
    const finalRetryAudit = auditCalls[2]![0];
    expect(finalRetryAudit.prePass).toMatchObject({
      integrationKey: "google_calendar",
      attempt: 2,
      // §7.1 example: attempt 2's audit row carries `retriedFromAttempt: 1`
      // so the audit feed reads naturally as "retry of attempt 1".
      retriedFromAttempt: 1,
    });
  });

  it("promotes attempt > 1 via requestedTier when prePassRetryEscalationTier is set", async () => {
    // §4.4 optional tier escalation. Attempt 1 of each sub-session resolves
    // with no requestedTier (inherits routine.fetch_window's seeded lite
    // tier); attempt > 1 must thread `requestedTier: "medium"` through
    // agentRouter.resolveBinding so the binding swaps to Sonnet.
    const execute = vi.fn();
    execute
      .mockResolvedValueOnce(
        makeAgentResult('{"fetched":1,"posted":1,"duplicates":0,"errors":[]}'),
      )
      .mockResolvedValueOnce(
        makeAgentResult(
          '{"fetched":3,"posted":0,"duplicates":0,"errors":[{"type":"fetch-failed","status":400,"message":"x"}]}',
        ),
      )
      .mockResolvedValueOnce(
        makeAgentResult('{"fetched":3,"posted":3,"duplicates":0,"errors":[]}'),
      );
    const resolveBinding = vi.fn().mockReturnValue(makeBinding());
    const router: IAgentRouter = {
      execute,
      executeResume: vi.fn(),
      summarize: vi.fn(),
      resolveBinding,
    } as unknown as IAgentRouter;

    const { runner } = makeFetcherRunner({
      db,
      dataDir,
      router,
      mailAccounts: [seedMailAccount()],
      config: {
        prePassFanOutConcurrency: 1,
        prePassMaxAttemptsPerIntegration: 2,
        prePassBackoffMs: [0],
        prePassRetryEscalationTier: "medium",
      },
    });

    await runner.run(hourlyEvent());

    // First resolveBinding call comes from buildFanOutPlanContext (placeholder
    // event resolves the session backend before the plan is built). Each
    // sub-session attempt then re-resolves. With the policy above:
    //   call 0 — placeholder (no requestedTier)
    //   call 1 — gmail attempt 1     (no requestedTier)
    //   call 2 — google_cal attempt 1 (no requestedTier)
    //   call 3 — google_cal attempt 2 (requestedTier: "medium")
    expect(resolveBinding).toHaveBeenCalledTimes(4);
    const lastCall = resolveBinding.mock.calls[3]![1] as {
      processKey: string;
      requestedTier?: string;
    };
    expect(lastCall.requestedTier).toBe("medium");
    // Earlier calls must NOT escalate so attempt 1 keeps the seeded lite tier.
    for (let i = 0; i < 3; i++) {
      const opts = resolveBinding.mock.calls[i]![1] as {
        requestedTier?: string;
      };
      expect(opts.requestedTier).toBeUndefined();
    }
  });

  it("passes requestedBackendId=subPlan.requiredBackend to resolveBinding (per-integration backend routing)", async () => {
    // Structural fix for the silent-drop of native bindings whose
    // nativeBackend differs from the configured `routine.fetch_window`
    // backend. The runner now hands each sub-session the integration's
    // bound backend via `BackendRouter`'s `requestedBackendId`-only
    // override, so gmail-native-codex spawns on codex even when the
    // pre-pass default is claude. This test guards the wiring: if
    // `requestedBackendId` ever stops flowing through, the silent-drop
    // regresses.
    const execute = vi.fn().mockResolvedValue(
      makeAgentResult('{"fetched":1,"posted":1,"duplicates":0,"errors":[]}'),
    );
    // The resolveBinding mock echoes the requested backend so we can
    // assert each sub-session resolved against its bound backend.
    const resolveBinding = vi.fn().mockImplementation(
      (_evt: unknown, opts?: { requestedBackendId?: BackendId }) =>
        makeBinding({ backendId: opts?.requestedBackendId ?? "claude" }),
    );
    const router: IAgentRouter = {
      execute,
      executeResume: vi.fn(),
      summarize: vi.fn(),
      resolveBinding,
    } as unknown as IAgentRouter;

    seedIntegrations(db, {
      // Three integrations covering the three backend-routing branches:
      //  - gmail native → codex (cross-default native; the regression
      //    case this fix addresses)
      //  - google_calendar direct → claude (REST proxy uses default)
      //  - notion delegated-same → claude (MCP on the default backend)
      gmail: integrationState({ mode: "native", nativeBackend: "codex" }),
      google_calendar: integrationState({ mode: "direct" }),
      notion: integrationState({
        mode: "delegated",
        delegatedBackend: "claude",
        fetchTargets: [{ label: "Projects", locator: "https://notion.so/projects" }],
      }),
    });

    const { runner } = makeFetcherRunner({
      db,
      dataDir,
      router,
      mailAccounts: [seedMailAccount()],
      config: {
        prePassFanOutConcurrency: 1,
        prePassMaxAttemptsPerIntegration: 1,
      },
    });

    await runner.run(hourlyEvent());

    // Call 0 is the placeholder binding resolved in `buildFanOutPlanContext`
    // (no requestedBackendId — it just needs ANY backend to compute the
    // default fetch_window backend). Calls 1..N are per-integration
    // sub-sessions in INTEGRATION_KEYS order: gmail, google_calendar,
    // notion.
    expect(resolveBinding).toHaveBeenCalled();
    const subSessionCalls = resolveBinding.mock.calls.slice(1);
    expect(subSessionCalls.length).toBeGreaterThanOrEqual(3);
    const byBackend: Record<string, BackendId | undefined> = {};
    for (const call of subSessionCalls) {
      const opts = call[1] as {
        requestedBackendId?: BackendId;
        processKey?: string;
      };
      expect(opts.processKey).toBe("routine.fetch_window");
      // Record one entry per backend so we don't double-count escalation
      // retries (this test sets maxAttempts=1, so each integration
      // produces exactly one sub-session call).
      const backend = opts.requestedBackendId;
      if (backend) byBackend[backend] = backend;
    }
    // gmail is native to codex → requestedBackendId="codex".
    expect(byBackend["codex"]).toBe("codex");
    // google_calendar (direct) and notion (delegated-same to claude)
    // both route to the default backend (claude).
    expect(byBackend["claude"]).toBe("claude");
  });

  it("re-derives the per-attempt sub-plan when the binding's backend changes (defensive regression guard)", async () => {
    // Defensive regression guard. In production this path is no longer
    // reachable: per-integration backend routing (added alongside this
    // test) pins each sub-session to `subPlan.requiredBackend` via
    // `requestedBackendId`, so the binding's backend always equals the
    // sub-plan's backend and `rebuildSubPlanForBackend` is a no-op.
    // We mock `resolveBinding` here to IGNORE the pin and return a
    // different backend mid-loop, simulating a future regression that
    // re-introduces cross-backend swaps (e.g. an extension to
    // escalation that also flips backends, or a router change that
    // drops the `requestedBackendId` pin). If such a regression lands,
    // `rebuildSubPlanForBackend` must still align the plan's
    // `<fetch mode="…">` attribute with the partial's mode-branch —
    // otherwise attempt 2's plan would say `mode="delegated-same"`
    // while the partial — re-rendered for the new backend by
    // `renderPartialForFanOut` — only carries the `delegated-cross`
    // branch, mis-routing the agent.
    const execute = vi.fn();
    execute
      .mockResolvedValueOnce(
        // Attempt 1 — partial-no-post triggers retry per defaultRetryDecision.
        makeAgentResult(
          '{"fetched":3,"posted":0,"duplicates":0,"errors":[{"type":"fetch-failed","status":400,"message":"x"}]}',
        ),
      )
      .mockResolvedValueOnce(
        makeAgentResult('{"fetched":3,"posted":3,"duplicates":0,"errors":[]}'),
      );
    let resolveCalls = 0;
    const resolveBinding = vi.fn().mockImplementation(() => {
      resolveCalls += 1;
      // Placeholder + attempt 1 → claude. Attempt 2 → codex (simulating
      // the post-fallback persistent re-resolution case).
      if (resolveCalls <= 2) return makeBinding({ backendId: "claude" });
      return makeBinding({ backendId: "codex" });
    });
    const router: IAgentRouter = {
      execute,
      executeResume: vi.fn(),
      summarize: vi.fn(),
      resolveBinding,
    } as unknown as IAgentRouter;
    // Single integration whose mode is delegated-bound to claude — when the
    // binding swaps to codex, `resolveFetchMode` flips to delegated-cross
    // and the rendered plan block must reflect the new mode.
    seedIntegrations(db, {
      gmail: integrationState({ mode: "delegated", delegatedBackend: "claude" }),
    });
    const { runner } = makeFetcherRunner({
      db,
      dataDir,
      router,
      mailAccounts: [seedMailAccount()],
      config: {
        prePassMaxAttemptsPerIntegration: 2,
        prePassBackoffMs: [0],
      },
    });

    await runner.run(morningEvent());

    expect(execute).toHaveBeenCalledTimes(2);
    const attempt1Event = execute.mock.calls[0]![0].event as RoutineEvent;
    const attempt2Event = execute.mock.calls[1]![0].event as RoutineEvent;
    const attempt1Plan = attempt1Event.data.acquisitionPlanBlock as string;
    const attempt2Plan = attempt2Event.data.acquisitionPlanBlock as string;
    // Attempt 1: claude binding → delegated-same.
    expect(attempt1Plan).toContain('mode="delegated-same"');
    // Attempt 2: codex binding → delegated-cross. The rebuild MUST
    // refresh the plan block on the fetcher event before context build.
    expect(attempt2Plan).toContain('mode="delegated-cross"');
    expect(attempt2Plan).not.toContain('mode="delegated-same"');
  });

  it("records fallbackTriggered + requestedBackend on the audit row when SDK fell back mid-execute (§5)", async () => {
    // §5 mitigation — when `result.backendId` differs from the binding
    // the runner asked for, the audit row carries `fallbackTriggered:
    // true` so the operator can grep recurring fallbacks without
    // joining additional state.
    const audit = makeAudit();
    const result: AgentResult = {
      ...makeAgentResult('{"fetched":1,"posted":1,"duplicates":0,"errors":[]}'),
      // Asked for claude, the SDK actually ran on codex.
      backendId: "codex",
    };
    const { router, execute } = makeRouter(result);
    const { runner } = makeFetcherRunner({
      db,
      dataDir,
      router,
      audit,
      mailAccounts: [seedMailAccount()],
      config: { prePassMaxAttemptsPerIntegration: 1 },
    });

    await runner.run(morningEvent());

    expect(execute).toHaveBeenCalledTimes(1);
    const auditCall = (audit.logAction as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(auditCall.prePass).toMatchObject({
      integrationKey: "gmail",
      fallbackTriggered: true,
      requestedBackend: "claude",
    });
    // The row's `backend` column holds the ACTUAL backend (the SDK's
    // result.backendId), so the operator's grep yields the canonical
    // pairing: requestedBackend="claude" + backend="codex".
    expect(auditCall.backend).toBe("codex");
  });

  it("does NOT set fallbackTriggered when the actual backend matches the requested binding", async () => {
    // Negative case — happy path must NOT emit fallbackTriggered, so the
    // operator's grep doesn't false-positive on the typical run.
    const audit = makeAudit();
    const result: AgentResult = {
      ...makeAgentResult('{"fetched":1,"posted":1,"duplicates":0,"errors":[]}'),
      backendId: "claude",
    };
    const { router, execute } = makeRouter(result);
    const { runner } = makeFetcherRunner({
      db,
      dataDir,
      router,
      audit,
      mailAccounts: [seedMailAccount()],
      config: { prePassMaxAttemptsPerIntegration: 1 },
    });

    await runner.run(morningEvent());

    expect(execute).toHaveBeenCalledTimes(1);
    const auditCall = (audit.logAction as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(auditCall.prePass.fallbackTriggered).toBeUndefined();
    expect(auditCall.prePass.requestedBackend).toBe("claude");
  });

  it("records parentRoutine on every fan-out audit row (§7.3 metric aggregation)", async () => {
    // §7.3 — `pre_pass_total{routine, integration, status}` aggregator
    // SQL groups by parentRoutine. The runner MUST stamp it on every
    // sub-session's audit row so a single SQL pass over agent_actions
    // can build the per-routine breakdown without reconstructing the
    // routine from a join.
    const audit = makeAudit();
    const { router } = makeRouter();
    const { runner } = makeFetcherRunner({
      db,
      dataDir,
      router,
      audit,
      mailAccounts: [seedMailAccount()],
      config: { prePassMaxAttemptsPerIntegration: 1 },
    });

    await runner.run(morningEvent());

    const auditCall = (audit.logAction as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(auditCall.prePass.parentRoutine).toBe("routine.morning_routine");
  });

  it("short-circuits the second sub-session when the global budget cap is exhausted after the first sub-session commits", async () => {
    // §4.7 global-budget-cap trip. The runner floors the configured
    // cap at `sum(binding.maxBudgetUsd)` so a stale Claude-baseline
    // default cannot dead-lock attempt 1 on a higher-envelope binding
    // (the regression that triggered Codex's `routine.fetch_window`
    // failure on every install with default_backend=codex). Once the
    // floor is in place, a real cap trip only happens AFTER an attempt
    // commits actual cost. This test serializes the fan-out and gives
    // gmail a high-cost first attempt so calendar's reserve trips.
    const execute = vi.fn();
    execute.mockResolvedValueOnce(
      // gmail attempt 1 — succeeds but commits a high actual cost.
      makeAgentResult(
        '{"fetched":1,"posted":1,"duplicates":0,"errors":[]}',
        0.3,
      ),
    );
    const router: IAgentRouter = {
      execute,
      executeResume: vi.fn(),
      summarize: vi.fn(),
      resolveBinding: vi.fn().mockReturnValue(makeBinding()),
    } as unknown as IAgentRouter;
    const { runner } = makeFetcherRunner({
      db,
      dataDir,
      router,
      mailAccounts: [seedMailAccount()],
      config: {
        prePassFanOutConcurrency: 1, // serialize: gmail commits before cal reserves
        prePassMaxAttemptsPerIntegration: 1,
        // cap = sum of bindings (2 × 0.20 = 0.40). Floor leaves it
        // unchanged. After gmail's $0.30 commit, only $0.10 remains —
        // calendar's reserve(0.20) trips with global-budget-cap.
        prePassMaxBudgetUsdPerRoutine: 0.4,
      },
    });

    const { report } = await runner.run(hourlyEvent());

    // gmail ran; calendar tripped the cap on reserve before its
    // execute fired.
    expect(execute).toHaveBeenCalledTimes(1);
    const breakdown = report.perIntegration ?? [];
    const gmail = breakdown.find((r) => r.integrationKey === "gmail");
    const calendar = breakdown.find((r) => r.integrationKey === "google_calendar");
    expect(gmail?.status).toBe("success");
    expect(calendar?.status).toBe("failed");
    expect(calendar?.retriesExhausted).toBe(true);
    const calendarErrors = calendar?.errors ?? [];
    expect(calendarErrors[0]).toMatchObject({ type: "global-budget-cap" });
    // Aggregate is partial (one success + one failed), not failed.
    expect(report.status).toBe("partial");
  });

  it("stops one sub-session's retry chain at the per-integration budget cap without affecting siblings", async () => {
    // §4.7 per-integration FanOutBudgetGuard. The per-integration cap is a
    // fresh counter per sub-session (each sub-session constructs its own
    // FanOutBudgetGuard), so gmail's first reservation must NOT consume
    // calendar's headroom. With cap = per-attempt envelope (0.20), attempt 1
    // of each sub-session reserves OK; attempt 2 of calendar (after its
    // partial-no-post attempt 1 committed actual cost 0.001) finds remaining
    // = 0.20 - 0.001 = 0.199, reserve(0.20) > 0.199 → fail with budget-cap.
    // gmail never touches the cap because attempt 1 succeeded and the loop
    // broke before any retry reservation.
    const execute = vi.fn();
    execute
      .mockResolvedValueOnce(
        // gmail — success on attempt 1, never retries.
        makeAgentResult('{"fetched":1,"posted":1,"duplicates":0,"errors":[]}'),
      )
      .mockResolvedValueOnce(
        // google_calendar attempt 1 — partial-no-post (would normally retry).
        makeAgentResult(
          '{"fetched":3,"posted":0,"duplicates":0,"errors":[{"type":"fetch-failed","status":400,"message":"x"}]}',
        ),
      );
    const router: IAgentRouter = {
      execute,
      executeResume: vi.fn(),
      summarize: vi.fn(),
      resolveBinding: vi.fn().mockReturnValue(makeBinding()),
    } as unknown as IAgentRouter;
    const { runner } = makeFetcherRunner({
      db,
      dataDir,
      router,
      mailAccounts: [seedMailAccount()],
      config: {
        prePassFanOutConcurrency: 1,
        prePassMaxAttemptsPerIntegration: 2,
        prePassBackoffMs: [0],
        prePassMaxBudgetUsdPerIntegration: 0.2,
      },
    });

    const { report } = await runner.run(hourlyEvent());

    // gmail attempt 1 (success) + calendar attempt 1 (partial); calendar
    // attempt 2 never fires because its reservation tripped the cap.
    expect(execute).toHaveBeenCalledTimes(2);
    const breakdown = report.perIntegration ?? [];
    const gmail = breakdown.find((r) => r.integrationKey === "gmail");
    const calendar = breakdown.find((r) => r.integrationKey === "google_calendar");
    expect(gmail?.status).toBe("success");
    expect(gmail?.attempts).toHaveLength(1);
    // Calendar has attempt 1 (partial) + synthetic budget-cap attempt 2.
    expect(calendar?.attempts).toHaveLength(2);
    const lastCalendarAttempt = calendar!.attempts[1]!;
    expect(lastCalendarAttempt.status).toBe("failed");
    expect(lastCalendarAttempt.errors[0]).toMatchObject({ type: "budget-cap" });
    expect(calendar?.retriesExhausted).toBe(true);
    expect(report.status).toBe("partial");
  });

  it("floors the per-integration and per-routine caps at the binding envelope so attempt 1 always fits", async () => {
    // Regression for the codex-default install where every fetch_window
    // dispatch died with `{type:"budget-cap", remaining:0.6, attempt:1}`:
    // `routine.fetch_window`'s envelope scales to $1.25 on Codex via
    // `applyBackendBudgetFactor` (lite × 2.5), but the static defaults
    // `prePassMaxBudgetUsdPerIntegration=0.6` and
    // `prePassMaxBudgetUsdPerRoutine=1.5` were sized for Claude's $0.50
    // baseline. Without flooring, the very first `integrationBudget.reserve(1.25)`
    // rejects against `remaining=0.6` and the whole pre-pass aborts
    // before any attempt runs. The fix floors the per-integration cap
    // at the binding's envelope and the per-routine cap at the sum of
    // bindings — a cap below a single attempt's envelope would block
    // every integration, which is a misconfiguration, not an
    // intentional bound.
    const execute = vi.fn().mockResolvedValue(
      makeAgentResult('{"fetched":1,"posted":1,"duplicates":0,"errors":[]}'),
    );
    const router: IAgentRouter = {
      execute,
      executeResume: vi.fn(),
      summarize: vi.fn(),
      // Binding envelope $1.25 (Codex lite via applyBackendBudgetFactor) —
      // larger than both default caps below.
      resolveBinding: vi.fn().mockReturnValue({
        main: {
          backendId: "codex" as BackendId,
          modelId: "gpt-5.4-mini",
          maxTurns: 20,
          maxBudgetUsd: 1.25,
        },
        fallback: null,
        processKey: "routine.fetch_window" as const,
      }),
    } as unknown as IAgentRouter;
    const { runner } = makeFetcherRunner({
      db,
      dataDir,
      router,
      mailAccounts: [seedMailAccount()],
      config: {
        prePassFanOutConcurrency: null, // parallel — exercise sum floor
        prePassMaxAttemptsPerIntegration: 1,
        // Bare defaults — both below $1.25 binding envelope. Without
        // the floor, attempt 1 would trip budget-cap.
        prePassMaxBudgetUsdPerIntegration: 0.6,
        prePassMaxBudgetUsdPerRoutine: 1.5,
      },
    });

    const { report } = await runner.run(hourlyEvent());

    // Both gmail and google_calendar must run to completion. Before
    // the fix this asserted 0 executes and 2 failed/budget-cap rows.
    expect(execute).toHaveBeenCalledTimes(2);
    const breakdown = report.perIntegration ?? [];
    expect(breakdown.find((r) => r.integrationKey === "gmail")?.status).toBe("success");
    expect(breakdown.find((r) => r.integrationKey === "google_calendar")?.status).toBe("success");
    expect(report.status).toBe("success");
  });

  it("emits status='failed' with a failureReason summary when every sub-session exhausts retries on parse errors", async () => {
    // status="failed" requires every non-skipped sub-report's final status
    // to be "failed". Parse errors give us exactly that — each attempt
    // records status=failed (defaultRetryDecision retries failed-status
    // until MAX_ATTEMPTS).
    const { router, execute } = makeRouter(makeAgentResult("not json"));
    const { runner } = makeFetcherRunner({
      db,
      dataDir,
      router,
      mailAccounts: [seedMailAccount()],
      config: {
        prePassFanOutConcurrency: 1,
        prePassMaxAttemptsPerIntegration: 2,
        prePassBackoffMs: [0],
      },
    });

    const { report, block } = await runner.run(hourlyEvent());

    // 2 sub-sessions × 2 attempts = 4 SDK execute calls.
    expect(execute).toHaveBeenCalledTimes(4);
    expect(report.status).toBe("failed");
    expect(report.failureReason).toContain("2 integrations failed");
    expect(report.failureReason).toContain("gmail (2 attempts)");
    expect(report.failureReason).toContain("google_calendar (2 attempts)");
    const breakdown = report.perIntegration ?? [];
    for (const sub of breakdown) {
      expect(sub.status).toBe("failed");
      expect(sub.retriesExhausted).toBe(true);
    }
    expect(block).toContain("<failure>");
    expect(block).toContain('status="failed"');
  });

  it("captures the integrations snapshot once and freezes it across the retry chain (§5 TOCTOU)", async () => {
    // §5 TOCTOU row: "Integration mode flipped mid-fan-out — integrationsSnapshot
    // is captured once at the start of run() and threaded through every
    // sub-session." Pin the invariant: a flip mid-routine MUST NOT poison
    // the in-flight retry loop's prompt context. Without the snapshot,
    // a disable-flip between attempt 1 and attempt 2 would leave attempt 2
    // with no integration data and produce a divergent prompt — the
    // pre-pass would silently degrade rather than complete the originally-
    // planned chain.
    const execute = vi.fn();
    let executeCallCount = 0;
    execute.mockImplementation(() => {
      executeCallCount += 1;
      // Mid-flight DB mutation — between attempt 1 and attempt 2 of the
      // gmail sub-session, flip gmail to disabled. The snapshot pinned
      // at run() entry must keep treating gmail as direct so attempt 2
      // composes its prompt against the original state.
      if (executeCallCount === 1) {
        db.prepare(
          `UPDATE settings
             SET value_json = json_set(
               coalesce(value_json, '{}'),
               '$.gmail',
               json_object('mode', 'disabled', 'lastChangedAt', '2026-05-13T01:00:00Z')
             )
             WHERE key = 'integrations'`,
        ).run();
      }
      // Attempt 1 = partial-no-post (triggers retry). Attempt 2 = success.
      return Promise.resolve(
        executeCallCount === 1
          ? makeAgentResult(
              '{"fetched":3,"posted":0,"duplicates":0,"errors":[{"type":"fetch-failed","status":400,"message":"x"}]}',
            )
          : makeAgentResult('{"fetched":3,"posted":3,"duplicates":0,"errors":[]}'),
      );
    });
    const router: IAgentRouter = {
      execute,
      executeResume: vi.fn(),
      summarize: vi.fn(),
      resolveBinding: vi.fn().mockReturnValue(makeBinding()),
    } as unknown as IAgentRouter;
    const { runner } = makeFetcherRunner({
      db,
      dataDir,
      router,
      mailAccounts: [seedMailAccount()],
      config: {
        prePassFanOutConcurrency: 1,
        prePassMaxAttemptsPerIntegration: 2,
        prePassBackoffMs: [0],
      },
    });

    const { report } = await runner.run(morningEvent());

    expect(execute).toHaveBeenCalledTimes(2);
    // Attempt 2's allowedToolsOverride must reflect the snapshot's gmail
    // state (active, direct), not the post-flip state (disabled). The
    // direct-mode mail curl prefix is the proxy for "gmail's snapshot
    // state was direct"; if we'd re-read the DB, the override would
    // collapse to the curl baseline only.
    const attempt2Allowed = execute.mock.calls[1]![0].allowedToolsOverride as readonly string[];
    expect(
      attempt2Allowed,
      "attempt 2 must use the snapshot's gmail=direct state — the curl prefixes for direct-mode mail must still be allowed even though the DB flipped to disabled mid-routine",
    ).toContain("Bash(curl *http://localhost:0/api/mail/*)");
    // The retry chain succeeds because the prompt composition stayed
    // self-consistent across the flip.
    const breakdown = report.perIntegration ?? [];
    const gmail = breakdown.find((r) => r.integrationKey === "gmail");
    expect(gmail?.attempts).toHaveLength(2);
    expect(gmail?.status).toBe("success");
  });
});

describe("RoutineFetchWindowRunner.run — failure paths (never throws)", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-fw-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    gmailIntegrationDirect(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns status='failed' when the agent execute throws", async () => {
    const { router } = makeRouter(new Error("agent boom"));
    const { runner } = makeFetcherRunner({
      db,
      dataDir,
      router,
      mailAccounts: [seedMailAccount()],
      config: { prePassMaxAttemptsPerIntegration: 1 },
    });
    const { report, block } = await runner.run(morningEvent());
    expect(report.status).toBe("failed");
    // Per-integration error annotated with the failing integration key.
    expect(report.errors[0]).toMatchObject({
      type: "pre-pass-failed",
      kind: "agent-execute-failed",
      integration: "gmail",
    });
    // Aggregate failureReason summarises the failed integrations.
    expect(report.failureReason).toContain("gmail");
    expect(block).toContain('status="failed"');
  });

  it("returns status='failed' when the agent output cannot be parsed", async () => {
    const { router } = makeRouter(makeAgentResult("totally not json"));
    const { runner } = makeFetcherRunner({
      db,
      dataDir,
      router,
      mailAccounts: [seedMailAccount()],
      config: { prePassMaxAttemptsPerIntegration: 1 },
    });
    const { report, block } = await runner.run(morningEvent());
    expect(report.status).toBe("failed");
    expect(report.errors[0]).toMatchObject({
      type: "pre-pass-parse-failed",
      integration: "gmail",
    });
    expect(block).toContain('status="failed"');
  });

  it("returns status='failed' when context build throws", async () => {
    const failingBuilder: IContextBuilder = {
      buildResumeCatchupContext: vi.fn(),
      buildScheduledRemindersBlock: vi.fn().mockReturnValue(null),
      build: vi.fn().mockRejectedValue(new Error("context boom")),
    };
    const { router } = makeRouter();
    const { runner } = makeFetcherRunner({
      db,
      dataDir,
      router,
      mailAccounts: [seedMailAccount()],
      contextBuilder: failingBuilder,
      config: { prePassMaxAttemptsPerIntegration: 1 },
    });
    const { report } = await runner.run(morningEvent());
    expect(report.status).toBe("failed");
    expect(report.errors[0]).toMatchObject({
      type: "pre-pass-failed",
      kind: "context-build-failed",
      integration: "gmail",
    });
  });

  it("returns status='failed' when binding resolution throws", async () => {
    // Use a router whose resolveBinding throws on calls after the first —
    // the first call (in buildFanOutPlanContext's placeholder resolve)
    // succeeds so the plan is built; each sub-session attempt then trips
    // the binding-resolve-failed branch.
    const calls: number[] = [];
    const router: IAgentRouter = {
      execute: vi.fn(),
      executeResume: vi.fn(),
      summarize: vi.fn(),
      resolveBinding: vi.fn().mockImplementation(() => {
        calls.push(1);
        if (calls.length === 1) return makeBinding();
        throw new Error("binding boom");
      }),
    } as unknown as IAgentRouter;
    const { runner } = makeFetcherRunner({
      db,
      dataDir,
      router,
      mailAccounts: [seedMailAccount()],
      config: { prePassMaxAttemptsPerIntegration: 1 },
    });
    const { report } = await runner.run(morningEvent());
    expect(report.status).toBe("failed");
    expect(report.errors[0]).toMatchObject({
      type: "pre-pass-failed",
      kind: "binding-resolve-failed",
      integration: "gmail",
    });
  });
});

describe("RoutineFetchWindowRunner.run — per-account fan-out", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-fw-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    gmailIntegrationDirect(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("emits one <fetch> row per active gmail account when perAccount=true", async () => {
    const { router, execute } = makeRouter();
    const { runner } = makeFetcherRunner({
      db,
      dataDir,
      router,
      mailAccounts: [
        { ...seedMailAccount(), id: "alice", email: "alice@example.com" },
        { ...seedMailAccount(), id: "work", email: "work@example.com" },
      ],
    });
    await runner.run(morningEvent());
    const sentEvent = execute.mock.calls[0]![0].event as RoutineEvent;
    const plan = sentEvent.data.acquisitionPlanBlock as string;
    expect(plan).toContain('account="alice"');
    expect(plan).toContain('account="work"');
  });

  it("skips outlook accounts when outlook_mail integration is disabled", async () => {
    const { router, execute } = makeRouter();
    const { runner } = makeFetcherRunner({
      db,
      dataDir,
      router,
      mailAccounts: [
        { ...seedMailAccount(), id: "alice", email: "alice@example.com" },
        {
          ...seedMailAccount(),
          id: "ms",
          kind: "outlook",
          email: "me@outlook.com",
        },
      ],
    });
    await runner.run(morningEvent());
    const sentEvent = execute.mock.calls[0]![0].event as RoutineEvent;
    const plan = sentEvent.data.acquisitionPlanBlock as string;
    expect(plan).toContain('account="alice"');
    expect(plan).not.toContain('integration="outlook_mail"');
  });
});

// B2 — pre-pass progress SSE broadcasts. The runner emits a
// `prepass_started` + `prepass_completed` pair around every invocation
// (including skip paths, since "we checked and there's nothing to do"
// is itself information the dashboard wants to surface). Broadcaster
// failures must never propagate into the runner's return value.
describe("RoutineFetchWindowRunner.run — pre-pass progress broadcast (B2)", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-fw-broadcast-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function makeRunnerWithBroadcaster(opts: {
    broadcaster: { broadcastEvent: (data: unknown) => void } | null;
    router?: IAgentRouter;
    mailAccounts?: readonly MailAccount[];
    config?: Partial<AgentConfig>;
  }): RoutineFetchWindowRunner {
    const config = fakeConfig(dataDir, opts.config);
    const audit = makeAudit();
    const router = opts.router ?? makeRouter().router;
    const contextBuilder: IContextBuilder = {
      buildResumeCatchupContext: vi.fn(),
      buildScheduledRemindersBlock: vi.fn().mockReturnValue(null),
      build: vi.fn().mockResolvedValue("<context/>"),
    };
    const prompt = new PromptAssembler({
      db,
      config,
      getTaskFlow: () => "fetcher-prompt-body",
      activeTurnTokens: new Map(),
      getAttachmentStore: () => null,
      getVoiceTranscriber: () => null,
    });
    return new RoutineFetchWindowRunner({
      db,
      config,
      contextBuilder,
      agentRouter: router,
      audit,
      prompt,
      getActiveMailAccounts: () => opts.mailAccounts ?? [],
      getEventBroadcaster: () => opts.broadcaster,
    });
  }

  it("emits prepass_started then prepass_completed with status='skipped' on the empty-plan short-circuit", async () => {
    const events: Array<Record<string, unknown>> = [];
    const runner = makeRunnerWithBroadcaster({
      broadcaster: {
        broadcastEvent: (data) => {
          events.push(data as Record<string, unknown>);
        },
      },
    });
    // Default seed leaves every integration at 'disabled' → empty plan.
    await runner.run(morningEvent());
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(["prepass_started", "prepass_completed"]);
    expect(events[1]).toMatchObject({
      kind: "prepass_completed",
      status: "skipped",
    });
  });

  it("emits prepass_completed with status='success' on a healthy fetcher run", async () => {
    gmailIntegrationDirect(db);
    const events: Array<Record<string, unknown>> = [];
    const { router, execute } = makeRouter();
    execute.mockResolvedValue({
      output: '{"fetched":3,"posted":3,"duplicates":0,"errors":[]}',
      isError: false,
      durationMs: 100,
      numTurns: 1,
      sessionId: null,
      model: "haiku",
      backendId: "claude",
      costUsd: 0.01,
      usage: {},
      modelUsage: {},
      costSource: "backend",
      contextUpdated: false,
      advisorCallCount: 0,
      stopReason: null,
    });
    const runner = makeRunnerWithBroadcaster({
      broadcaster: {
        broadcastEvent: (data) => {
          events.push(data as Record<string, unknown>);
        },
      },
      router,
      mailAccounts: [seedMailAccount()],
    });
    await runner.run(morningEvent());
    // The runner also emits `prepass_subsession_*` events for every
    // fan-out attempt; this suite asserts only the top-level
    // `prepass_started` / `prepass_completed` envelope, so filter the
    // sub-session kinds out before pinning the sequence.
    const topLevelKinds = events
      .map((e) => e.kind)
      .filter((k) => k === "prepass_started" || k === "prepass_completed");
    expect(topLevelKinds).toEqual(["prepass_started", "prepass_completed"]);
    const completed = events.find((e) => e.kind === "prepass_completed");
    expect(completed).toMatchObject({
      kind: "prepass_completed",
      status: "success",
    });
  });

  it("emits prepass_completed even when the runner returns a failed report (never throws)", async () => {
    gmailIntegrationDirect(db);
    const events: Array<Record<string, unknown>> = [];
    const { router, execute } = makeRouter();
    execute.mockRejectedValue(new Error("execute boom"));
    const runner = makeRunnerWithBroadcaster({
      broadcaster: {
        broadcastEvent: (data) => {
          events.push(data as Record<string, unknown>);
        },
      },
      router,
      mailAccounts: [seedMailAccount()],
    });
    const result = await runner.run(morningEvent());
    expect(result.report.status).toBe("failed");
    const topLevelKinds = events
      .map((e) => e.kind)
      .filter((k) => k === "prepass_started" || k === "prepass_completed");
    expect(topLevelKinds).toEqual(["prepass_started", "prepass_completed"]);
    const completed = events.find((e) => e.kind === "prepass_completed");
    expect(completed).toMatchObject({
      kind: "prepass_completed",
      status: "failed",
    });
  });

  it("survives a broadcaster that throws (broadcast failure must not break dispatch)", async () => {
    const runner = makeRunnerWithBroadcaster({
      broadcaster: {
        broadcastEvent: () => {
          throw new Error("sse writer down");
        },
      },
    });
    // Default seed → skip path; the test exercises both broadcast call
    // sites (started + completed). No throw must reach the caller.
    const result = await runner.run(morningEvent());
    expect(result.report.status).toBe("skipped");
  });

  it("is a no-op when no broadcaster is wired (matches pre-A2 behavior)", async () => {
    const runner = makeRunnerWithBroadcaster({ broadcaster: null });
    // Should run the skip path cleanly with no broadcast calls — the
    // assertion here is the absence of a throw + a return value, since
    // we have no broadcaster to record against.
    const result = await runner.run(morningEvent());
    expect(result.report.status).toBe("skipped");
  });

  it("enriches prepass_completed with aggregate + perIntegration headlines (§7.2)", async () => {
    // §7.2 — `prepass_completed` payload contract:
    //   { status, aggregate:{status, fetched, posted, duplicates, costUsd},
    //     perIntegration:[{key, status, attempts, fetched, posted,
    //                      duplicates, costUsd, durationMs, finalError?}] }
    // The dashboard's per-integration progress card relies on these
    // headline numbers — without them it would have to re-fetch from
    // /api/agent_actions to render. Pin the shape so a regression here
    // surfaces loudly instead of silently breaking the UI.
    seedIntegrations(db, {
      gmail: integrationState({ mode: "direct" }),
      google_calendar: integrationState({ mode: "direct" }),
      notion: integrationState({ mode: "disabled" }),
    });
    const events: Array<Record<string, unknown>> = [];
    const { router, execute } = makeRouter();
    execute
      .mockResolvedValueOnce(
        makeAgentResult('{"fetched":5,"posted":5,"duplicates":0,"errors":[]}'),
      )
      .mockResolvedValueOnce(
        makeAgentResult('{"fetched":3,"posted":3,"duplicates":1,"errors":[]}'),
      );
    const runner = makeRunnerWithBroadcaster({
      broadcaster: {
        broadcastEvent: (data) => events.push(data as Record<string, unknown>),
      },
      router,
      mailAccounts: [seedMailAccount()],
    });
    await runner.run(hourlyEvent());

    const completed = events.find((e) => e.kind === "prepass_completed");
    expect(completed).toBeTruthy();
    expect(completed).toMatchObject({
      status: "success",
      aggregate: {
        status: "success",
        fetched: 8,
        posted: 8,
        duplicates: 1,
      },
    });
    const aggregate = completed!.aggregate as Record<string, unknown>;
    expect(typeof aggregate.costUsd).toBe("number");
    const perIntegration = completed!.perIntegration as Array<Record<string, unknown>>;
    expect(perIntegration).toHaveLength(2);
    expect(perIntegration[0]).toMatchObject({
      key: "gmail",
      status: "success",
      attempts: 1,
      fetched: 5,
      posted: 5,
    });
    expect(perIntegration[1]).toMatchObject({
      key: "google_calendar",
      status: "success",
      attempts: 1,
      fetched: 3,
      posted: 3,
      duplicates: 1,
    });
    for (const integ of perIntegration) {
      expect(typeof integ.costUsd).toBe("number");
      expect(typeof integ.durationMs).toBe("number");
    }
  });

  it("includes finalError on failed perIntegration entries (§7.2)", async () => {
    // When every attempt in a sub-session ends in parse failure, the
    // sub-report's status is "failed" and the SSE payload's
    // perIntegration entry must carry `finalError` so the dashboard
    // can surface the upstream message without parsing the
    // <fetch_report> XML or hitting the audit feed.
    seedIntegrations(db, {
      gmail: integrationState({ mode: "direct" }),
    });
    const events: Array<Record<string, unknown>> = [];
    const { router, execute } = makeRouter();
    // Output that always fails strict-JSON parse → every attempt's
    // SubAttemptRecord ends with status="failed", and the final
    // sub-report status is therefore "failed" (not "partial"), so the
    // §7.1 `finalError` field fires.
    execute.mockResolvedValue(makeAgentResult("not json at all"));
    const runner = makeRunnerWithBroadcaster({
      broadcaster: {
        broadcastEvent: (data) => events.push(data as Record<string, unknown>),
      },
      router,
      mailAccounts: [seedMailAccount()],
      config: {
        prePassMaxAttemptsPerIntegration: 2,
        prePassBackoffMs: [0],
      },
    });
    await runner.run(morningEvent());

    const completed = events.find((e) => e.kind === "prepass_completed");
    const perIntegration = completed!.perIntegration as Array<Record<string, unknown>>;
    expect(perIntegration).toHaveLength(1);
    const gmail = perIntegration[0]!;
    expect(gmail).toMatchObject({
      key: "gmail",
      status: "failed",
      attempts: 2,
    });
    // The parse error message is what `pickFinalErrorMessage` extracts
    // from the final attempt's first error record (`errors[0].reason`
    // when set; falls back to `kind` and `message`).
    expect(typeof gmail.finalError).toBe("string");
    expect(gmail.finalError).toBe("no-json-object");
  });

  it("emits empty perIntegration[] on the skipped short-circuit (§7.2)", async () => {
    // No integrations active → splitAcquisitionPlanByIntegration returns
    // empty → runner short-circuits to status="skipped" before the
    // fan-out runs. The SSE payload must still carry the contract
    // shape: aggregate present, perIntegration as the empty array (not
    // undefined).
    const events: Array<Record<string, unknown>> = [];
    const runner = makeRunnerWithBroadcaster({
      broadcaster: {
        broadcastEvent: (data) => events.push(data as Record<string, unknown>),
      },
    });
    await runner.run(morningEvent());

    const completed = events.find((e) => e.kind === "prepass_completed");
    expect(completed).toMatchObject({
      kind: "prepass_completed",
      status: "skipped",
      aggregate: {
        status: "skipped",
        fetched: 0,
        posted: 0,
        duplicates: 0,
      },
    });
    expect(completed!.perIntegration).toEqual([]);
  });
});

// docs/design/appendices/pre-pass-fan-out.md §7.2 — every sub-session iteration must emit
// a matching `prepass_subsession_started` + `prepass_subsession_completed`
// pair. Earlier the started broadcast was inside the success branch only
// — binding-resolve-failed and budget-cap paths emitted nothing, and the
// context-build / agent-execute throw paths emitted a stray completed
// without a matching started. The dashboard would either miss the attempt
// entirely or render an unbalanced timeline. These tests pin the
// invariant from the failure paths.
describe("RoutineFetchWindowRunner.run — fan-out subsession SSE symmetry (§7.2)", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-fw-symmetry-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    seedIntegrations(db, {
      gmail: integrationState({ mode: "direct" }),
      google_calendar: integrationState({ mode: "direct" }),
      notion: integrationState({ mode: "disabled" }),
    });
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function makeRunnerWithBroadcaster(opts: {
    broadcaster: { broadcastEvent: (data: unknown) => void } | null;
    router?: IAgentRouter;
    mailAccounts?: readonly MailAccount[];
    config?: Partial<AgentConfig>;
  }): RoutineFetchWindowRunner {
    const config = fakeConfig(dataDir, opts.config);
    const audit = makeAudit();
    const router = opts.router ?? makeRouter().router;
    const contextBuilder: IContextBuilder = {
      buildResumeCatchupContext: vi.fn(),
      buildScheduledRemindersBlock: vi.fn().mockReturnValue(null),
      build: vi.fn().mockResolvedValue("<context/>"),
    };
    const prompt = new PromptAssembler({
      db,
      config,
      getTaskFlow: () => "fetcher-prompt-body",
      activeTurnTokens: new Map(),
      getAttachmentStore: () => null,
      getVoiceTranscriber: () => null,
    });
    return new RoutineFetchWindowRunner({
      db,
      config,
      contextBuilder,
      agentRouter: router,
      audit,
      prompt,
      getActiveMailAccounts: () => opts.mailAccounts ?? [],
      getEventBroadcaster: () => opts.broadcaster,
    });
  }

  it("emits matching started+completed pairs for each successful sub-session attempt", async () => {
    const events: Array<Record<string, unknown>> = [];
    const { router, execute } = makeRouter();
    execute
      .mockResolvedValueOnce(
        makeAgentResult('{"fetched":1,"posted":1,"duplicates":0,"errors":[]}'),
      )
      .mockResolvedValueOnce(
        makeAgentResult('{"fetched":2,"posted":2,"duplicates":0,"errors":[]}'),
      );
    const runner = makeRunnerWithBroadcaster({
      broadcaster: {
        broadcastEvent: (data) => events.push(data as Record<string, unknown>),
      },
      router,
      mailAccounts: [seedMailAccount()],
      config: {
        prePassFanOutConcurrency: 1,
        prePassMaxAttemptsPerIntegration: 1,
      },
    });

    await runner.run(hourlyEvent());

    const subStarts = events.filter((e) => e.kind === "prepass_subsession_started");
    const subEnds = events.filter((e) => e.kind === "prepass_subsession_completed");
    expect(subStarts).toHaveLength(2);
    expect(subEnds).toHaveLength(2);
    // Each started has a matching completed for the same fetcherCorrelationId.
    for (const startEvt of subStarts) {
      const matched = subEnds.find(
        (e) => e.fetcherCorrelationId === startEvt.fetcherCorrelationId,
      );
      expect(
        matched,
        `every prepass_subsession_started must have a matching completed for fetcherCorrelationId=${String(startEvt.fetcherCorrelationId)}`,
      ).toBeTruthy();
    }
    // Started always precedes its matching completed in the timeline.
    for (const startEvt of subStarts) {
      const startIdx = events.indexOf(startEvt);
      const completedIdx = events.findIndex(
        (e) =>
          e.kind === "prepass_subsession_completed"
          && e.fetcherCorrelationId === startEvt.fetcherCorrelationId,
      );
      expect(completedIdx).toBeGreaterThan(startIdx);
    }
  });

  it("emits started+completed pair on the binding-resolve-failed branch", async () => {
    // Synthesize a router whose first resolveBinding succeeds (placeholder
    // event in buildFanOutPlanContext), and whose subsequent resolveBinding
    // throws — every sub-session attempt then trips the binding-resolve-failed
    // branch. With 1 attempt per integration we get one started+completed
    // pair per sub-plan that failed binding resolution.
    const events: Array<Record<string, unknown>> = [];
    let resolveCalls = 0;
    const router: IAgentRouter = {
      execute: vi.fn(),
      executeResume: vi.fn(),
      summarize: vi.fn(),
      resolveBinding: vi.fn().mockImplementation(() => {
        resolveCalls += 1;
        if (resolveCalls === 1) return makeBinding();
        throw new Error("binding resolution boom");
      }),
    } as unknown as IAgentRouter;
    const runner = makeRunnerWithBroadcaster({
      broadcaster: {
        broadcastEvent: (data) => events.push(data as Record<string, unknown>),
      },
      router,
      mailAccounts: [seedMailAccount()],
      config: {
        prePassFanOutConcurrency: 1,
        prePassMaxAttemptsPerIntegration: 1,
      },
    });

    await runner.run(hourlyEvent());

    const subStarts = events.filter((e) => e.kind === "prepass_subsession_started");
    const subEnds = events.filter((e) => e.kind === "prepass_subsession_completed");
    // Two sub-plans (gmail, google_calendar), 1 attempt each — every attempt
    // hits binding-resolve-failed and must still fire the pair.
    expect(subStarts).toHaveLength(2);
    expect(subEnds).toHaveLength(2);
    for (const completedEvt of subEnds) {
      expect(completedEvt.status).toBe("failed");
      // Decision is computed from defaultRetryDecision over a status='failed'
      // record at maxAttempts=1, so the reason is MAX_ATTEMPTS.
      expect(completedEvt.willRetry).toBe(false);
    }
  });

  it("emits started+completed pair on the global-budget-cap short-circuit", async () => {
    // §4.7 reserve-then-commit. The runner's per-routine cap is
    // floored at `sum(binding.maxBudgetUsd)` so attempt 1 never trips
    // on a misconfigured-low cap (the regression that broke Codex
    // installs). A real reserve-time trip now requires accumulated
    // commits exhausting the cap mid-fan-out. We serialize the
    // sub-sessions and give gmail a high-cost first attempt so
    // calendar's reserve sees the cap exhausted. Both sub-sessions
    // must still emit the started+completed pair so the dashboard
    // renders the trip.
    const events: Array<Record<string, unknown>> = [];
    const execute = vi.fn();
    execute.mockResolvedValueOnce(
      makeAgentResult(
        '{"fetched":1,"posted":1,"duplicates":0,"errors":[]}',
        0.3,
      ),
    );
    const router: IAgentRouter = {
      execute,
      executeResume: vi.fn(),
      summarize: vi.fn(),
      resolveBinding: vi.fn().mockReturnValue(makeBinding()),
    } as unknown as IAgentRouter;
    const runner = makeRunnerWithBroadcaster({
      broadcaster: {
        broadcastEvent: (data) => events.push(data as Record<string, unknown>),
      },
      router,
      mailAccounts: [seedMailAccount()],
      config: {
        prePassFanOutConcurrency: 1,
        prePassMaxAttemptsPerIntegration: 1,
        // cap = sum of bindings (0.40). After gmail's $0.30 commit,
        // calendar's reserve(0.20) trips on remaining=$0.10.
        prePassMaxBudgetUsdPerRoutine: 0.4,
      },
    });

    await runner.run(hourlyEvent());

    const subStarts = events.filter((e) => e.kind === "prepass_subsession_started");
    const subEnds = events.filter((e) => e.kind === "prepass_subsession_completed");
    // gmail's execute ran (commits the high cost); calendar tripped
    // the cap on reserve. Both still emit the started+completed pair.
    expect(execute).toHaveBeenCalledTimes(1);
    expect(subStarts).toHaveLength(2);
    expect(subEnds).toHaveLength(2);
    const calendarCompleted = subEnds.find((e) => e.integrationKey === "google_calendar");
    expect(calendarCompleted).toBeDefined();
    expect(calendarCompleted!.status).toBe("failed");
    expect(calendarCompleted!.willRetry).toBe(false);
    expect(calendarCompleted!.retryReason).toBe("global-budget-cap");
  });

  it("emits started+completed pair on the agent-execute-throw branch", async () => {
    // Pre-fix bug: the started broadcast lived inside the try block
    // *after* the agentRouter.execute call, so a thrown execute fired
    // a stray prepass_subsession_completed without a matching started.
    const events: Array<Record<string, unknown>> = [];
    const { router, execute } = makeRouter();
    execute.mockRejectedValue(new Error("execute boom"));
    const runner = makeRunnerWithBroadcaster({
      broadcaster: {
        broadcastEvent: (data) => events.push(data as Record<string, unknown>),
      },
      router,
      mailAccounts: [seedMailAccount()],
      config: {
        prePassFanOutConcurrency: 1,
        prePassMaxAttemptsPerIntegration: 1,
      },
    });

    await runner.run(hourlyEvent());

    const subStarts = events.filter((e) => e.kind === "prepass_subsession_started");
    const subEnds = events.filter((e) => e.kind === "prepass_subsession_completed");
    expect(subStarts).toHaveLength(2);
    expect(subEnds).toHaveLength(2);
    for (const completedEvt of subEnds) {
      expect(completedEvt.status).toBe("failed");
    }
  });
});

// docs/design/appendices/pre-pass-fan-out.md §4.2 — fan-out sub-sessions assemble the
// `routine.fetch_window` task-flow body and the runner substitutes the
// `{integration_partial}` token with the integration-specific partial
// body loaded via the descriptor's `prePassPartial` field. These tests
// exercise the wiring end-to-end (mocked task-flow body + real on-disk
// partials) so the substitution shape stays stable.
describe("RoutineFetchWindowRunner.run — task-flow + partial substitution", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-fw-substitute-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    seedIntegrations(db, {
      gmail: integrationState({ mode: "direct" }),
      google_calendar: integrationState({ mode: "direct" }),
      notion: integrationState({ mode: "disabled" }),
    });
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /**
   * Per-eventType task-flow resolver. Returns the placeholder-bearing
   * body for `routine.fetch_window`, and a loud marker for anything
   * else so a mis-routed lookup fails the assertion visibly. The
   * recorded `assembleCalls` array lets the assertions check which
   * task-flow keys the assembler consulted across the run.
   */
  function makeRecordingGetTaskFlow() {
    const assembleCalls: string[] = [];
    const getTaskFlow = vi.fn(
      (eventType: string) => {
        assembleCalls.push(eventType);
        if (eventType === "routine.fetch_window") {
          return "FETCH-WINDOW-BODY-START\n{integration_partial}\nFETCH-WINDOW-BODY-END";
        }
        return `UNEXPECTED:${eventType}`;
      },
    );
    return { getTaskFlow, assembleCalls };
  }

  it("every sub-session assembles against the routine.fetch_window task-flow", async () => {
    const { router, execute } = makeRouter();
    execute
      .mockResolvedValueOnce(
        makeAgentResult('{"fetched":1,"posted":1,"duplicates":0,"errors":[]}'),
      )
      .mockResolvedValueOnce(
        makeAgentResult('{"fetched":1,"posted":1,"duplicates":0,"errors":[]}'),
      );
    const { getTaskFlow, assembleCalls } = makeRecordingGetTaskFlow();
    const { runner } = makeFetcherRunner({
      db,
      dataDir,
      router,
      mailAccounts: [seedMailAccount()],
      getTaskFlow,
      config: {
        prePassFanOutConcurrency: 1,
        prePassMaxAttemptsPerIntegration: 1,
      },
    });

    await runner.run(hourlyEvent());

    // Two sub-sessions, both pointed at the canonical task-flow key.
    // No call to an unexpected key — if a stale `routine.fetch_window.scoped`
    // ever leaks back, this assertion fails loudly.
    const fetchWindowCalls = assembleCalls.filter(
      (k) => k === "routine.fetch_window",
    );
    const unexpectedCalls = assembleCalls.filter(
      (k) => k !== "routine.fetch_window",
    );
    expect(fetchWindowCalls.length).toBeGreaterThanOrEqual(2);
    expect(unexpectedCalls).toEqual([]);
  });

  it("substitutes {integration_partial} with the prePassPartial body for each sub-session", async () => {
    // Seed user-override partials so we don't depend on the real
    // _partials/ files for body comparison. Each override is a unique
    // marker the assertion can match exactly.
    const gmailPartialBody = "GMAIL-PARTIAL-BODY";
    const calendarPartialBody = "CALENDAR-PARTIAL-BODY";
    const overrideDir = join(dataDir, "task-flows", "_partials");
    mkdirSync(overrideDir, { recursive: true });
    writeFileSync(
      join(overrideDir, "mail-acquire.gmail.md"),
      gmailPartialBody,
      "utf-8",
    );
    writeFileSync(
      join(overrideDir, "calendar-acquire.google_calendar.md"),
      calendarPartialBody,
      "utf-8",
    );
    // Refresh the prompt loader so the user-override directory is
    // visible. The previous suite may have left a different dataDir
    // mounted on the singleton.
    resetTaskFlowsForTest();
    initTaskFlows(REPO_ROOT, dataDir);

    const { router, execute } = makeRouter();
    execute
      .mockResolvedValueOnce(
        makeAgentResult('{"fetched":1,"posted":1,"duplicates":0,"errors":[]}'),
      )
      .mockResolvedValueOnce(
        makeAgentResult('{"fetched":1,"posted":1,"duplicates":0,"errors":[]}'),
      );
    const { runner } = makeFetcherRunner({
      db,
      dataDir,
      router,
      mailAccounts: [seedMailAccount()],
      getTaskFlow: realGetTaskFlow,
      config: {
        prePassFanOutConcurrency: 1,
        prePassMaxAttemptsPerIntegration: 1,
      },
    });

    await runner.run(hourlyEvent());

    expect(execute).toHaveBeenCalledTimes(2);
    const firstPrompt = execute.mock.calls[0]![0].prompt as string;
    const secondPrompt = execute.mock.calls[1]![0].prompt as string;
    // Each sub-session sees ONLY its own partial. The placeholder must
    // have been substituted (no raw `{integration_partial}` leaks) and
    // no cross-integration body must appear.
    expect(firstPrompt).not.toContain("{integration_partial}");
    expect(secondPrompt).not.toContain("{integration_partial}");
    expect(firstPrompt).toContain(gmailPartialBody);
    expect(firstPrompt).not.toContain(calendarPartialBody);
    expect(secondPrompt).toContain(calendarPartialBody);
    expect(secondPrompt).not.toContain(gmailPartialBody);

    resetTaskFlowsForTest();
  });

  it("uses real on-disk task-flow + real partials when initTaskFlows points at the repo", async () => {
    // End-to-end wiring: task-flow body + real partials must compose
    // into a single sub-session prompt with the partial's prose
    // substituted for the placeholder and no cross-integration prose
    // visible.
    resetTaskFlowsForTest();
    initTaskFlows(REPO_ROOT, dataDir);

    const { router, execute } = makeRouter();
    execute
      .mockResolvedValueOnce(
        makeAgentResult('{"fetched":1,"posted":1,"duplicates":0,"errors":[]}'),
      )
      .mockResolvedValueOnce(
        makeAgentResult('{"fetched":1,"posted":1,"duplicates":0,"errors":[]}'),
      );
    const { runner } = makeFetcherRunner({
      db,
      dataDir,
      router,
      mailAccounts: [seedMailAccount()],
      getTaskFlow: realGetTaskFlow,
      config: {
        prePassFanOutConcurrency: 1,
        prePassMaxAttemptsPerIntegration: 1,
      },
    });

    await runner.run(hourlyEvent());

    const gmailPrompt = execute.mock.calls[0]![0].prompt as string;
    const calendarPrompt = execute.mock.calls[1]![0].prompt as string;

    // The task-flow's heading must appear in every sub-session.
    expect(gmailPrompt).toContain("Routine Data-Fetch Pre-Pass");
    expect(calendarPrompt).toContain("Routine Data-Fetch Pre-Pass");

    // Each sub-session shows its own partial's body, not the other's.
    expect(gmailPrompt).toContain("Gmail acquisition");
    expect(gmailPrompt).not.toContain("Google Calendar acquisition");
    expect(calendarPrompt).toContain("Google Calendar acquisition");
    expect(calendarPrompt).not.toContain("Gmail acquisition");

    // Placeholder must not leak through.
    expect(gmailPrompt).not.toContain("{integration_partial}");
    expect(calendarPrompt).not.toContain("{integration_partial}");

    resetTaskFlowsForTest();
  });
});

// Bug 005 regression — fan-out pre-execute failures and the agent-execute
// throw path must persist a `detail.prePass` row via `audit.logError` so
// `MetricsCollector.collectPrePassMetrics` (filters on
// `detail.prePass` being a non-null object) can see them. Before the fix
// the four pre-execute branches wrote nothing at all and the
// agent-execute path wrote a `failureKind`-only row the aggregator
// silently skipped.
describe("RoutineFetchWindowRunner.run — audit row carries detail.prePass on every failure path", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-fw-fail-audit-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    seedIntegrations(db, {
      gmail: integrationState({ mode: "direct" }),
    });
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("binding-resolve-failed writes an audit row with detail.prePass", async () => {
    let resolveCalls = 0;
    const router: IAgentRouter = {
      execute: vi.fn(),
      executeResume: vi.fn(),
      summarize: vi.fn(),
      resolveBinding: vi.fn().mockImplementation(() => {
        resolveCalls += 1;
        if (resolveCalls === 1) return makeBinding();
        throw new Error("binding resolution boom");
      }),
    } as unknown as IAgentRouter;
    const audit = makeAudit();
    const { runner } = makeFetcherRunner({
      db,
      dataDir,
      router,
      audit,
      mailAccounts: [seedMailAccount()],
      config: { prePassMaxAttemptsPerIntegration: 1 },
    });
    await runner.run(hourlyEvent());

    const logError = audit.logError as ReturnType<typeof vi.fn>;
    expect(logError).toHaveBeenCalledTimes(1);
    const [, error, trigger, context] = logError.mock.calls[0]!;
    expect((error as Error).message).toBe("binding resolution boom");
    expect(trigger).toBe("autonomous");
    expect(context).toMatchObject({
      failureKind: "binding-resolve-failed",
      prePass: {
        parentRoutine: "routine.activity_scan",
        integrationKey: "gmail",
        attempt: 1,
        maxAttempts: 1,
        status: "failed",
        fetched: 0,
        posted: 0,
        duplicates: 0,
        willRetry: false,
      },
    });
    // Pre-execute branches have no binding — `requestedBackend` is absent.
    expect((context as { prePass: { requestedBackend?: string } }).prePass.requestedBackend).toBeUndefined();
  });

  it("global-budget-cap writes an audit row with detail.prePass + binding", async () => {
    // Reserve-time global-budget-cap trip after a high-cost commit on
    // an earlier attempt. cap is at the floor (sum of bindings); the
    // attempt 1 reserve succeeds, commits a high actual cost, and
    // attempt 2's reserve trips with `retryReason="global-budget-cap"`.
    const execute = vi.fn();
    execute
      .mockResolvedValueOnce(
        // attempt 1 — partial-no-post (would normally retry per
        // defaultRetryDecision §4.4 rule 4) with high actual cost.
        makeAgentResult(
          '{"fetched":3,"posted":0,"duplicates":0,"errors":[{"type":"fetch-failed","status":400,"message":"x"}]}',
          0.25,
        ),
      );
    const router: IAgentRouter = {
      execute,
      executeResume: vi.fn(),
      summarize: vi.fn(),
      resolveBinding: vi.fn().mockReturnValue(makeBinding()),
    } as unknown as IAgentRouter;
    const audit = makeAudit();
    const { runner } = makeFetcherRunner({
      db,
      dataDir,
      router,
      audit,
      mailAccounts: [seedMailAccount()],
      config: {
        prePassMaxAttemptsPerIntegration: 2,
        prePassBackoffMs: [0],
        // 1 integration, binding 0.2 → sum = 0.2; cap = 0.3 (floor
        // no-op). attempt 1 commits 0.25 → remaining 0.05; attempt 2's
        // reserve(0.20) > 0.05 → trip.
        prePassMaxBudgetUsdPerRoutine: 0.3,
      },
    });
    await runner.run(hourlyEvent());

    const logError = audit.logError as ReturnType<typeof vi.fn>;
    expect(logError).toHaveBeenCalledTimes(1);
    const [, , , context] = logError.mock.calls[0]!;
    expect(context).toMatchObject({
      failureKind: "global-budget-cap",
      backendId: "claude",
      prePass: {
        parentRoutine: "routine.activity_scan",
        integrationKey: "gmail",
        status: "failed",
        retryReason: "global-budget-cap",
        willRetry: false,
        requestedBackend: "claude",
      },
    });
  });

  it("budget-cap (per-integration) writes an audit row with detail.prePass + binding", async () => {
    // Reserve-time per-integration budget-cap trip after a high-cost
    // commit. cap is above the binding (floor no-op); attempt 1
    // reserve succeeds, commits 0.25 (≥ binding 0.20 but below
    // policy.perIntegrationBudgetUsd 0.30 — so the soft cumulative
    // check in defaultRetryDecision passes too); attempt 2's
    // integrationBudget.reserve(0.20) trips on remaining 0.05.
    const execute = vi.fn();
    execute
      .mockResolvedValueOnce(
        makeAgentResult(
          '{"fetched":3,"posted":0,"duplicates":0,"errors":[{"type":"fetch-failed","status":400,"message":"x"}]}',
          0.25,
        ),
      );
    const router: IAgentRouter = {
      execute,
      executeResume: vi.fn(),
      summarize: vi.fn(),
      resolveBinding: vi.fn().mockReturnValue(makeBinding()),
    } as unknown as IAgentRouter;
    const audit = makeAudit();
    const { runner } = makeFetcherRunner({
      db,
      dataDir,
      router,
      audit,
      mailAccounts: [seedMailAccount()],
      config: {
        prePassMaxAttemptsPerIntegration: 2,
        prePassBackoffMs: [0],
        // Global cap is permissive (no global trip).
        prePassMaxBudgetUsdPerRoutine: 1.0,
        // Per-integration cap above the binding so the floor is a
        // no-op. After attempt 1's 0.25 commit, only 0.05 remains;
        // attempt 2's reserve(0.20) trips with budget-cap.
        prePassMaxBudgetUsdPerIntegration: 0.3,
      },
    });
    await runner.run(hourlyEvent());

    const logError = audit.logError as ReturnType<typeof vi.fn>;
    expect(logError).toHaveBeenCalledTimes(1);
    const [, , , context] = logError.mock.calls[0]!;
    expect(context).toMatchObject({
      failureKind: "budget-cap",
      backendId: "claude",
      prePass: {
        parentRoutine: "routine.activity_scan",
        integrationKey: "gmail",
        status: "failed",
        retryReason: "budget-cap",
        willRetry: false,
        requestedBackend: "claude",
      },
    });
  });

  it("context-build-failed writes an audit row with detail.prePass + binding", async () => {
    const { router } = makeRouter();
    const audit = makeAudit();
    const contextBuilder: IContextBuilder = {
      buildResumeCatchupContext: vi.fn(),
      buildScheduledRemindersBlock: vi.fn().mockReturnValue(null),
      build: vi.fn().mockRejectedValue(new Error("context boom")),
    };
    const { runner } = makeFetcherRunner({
      db,
      dataDir,
      router,
      audit,
      contextBuilder,
      mailAccounts: [seedMailAccount()],
      config: { prePassMaxAttemptsPerIntegration: 1 },
    });
    await runner.run(hourlyEvent());

    const logError = audit.logError as ReturnType<typeof vi.fn>;
    expect(logError).toHaveBeenCalledTimes(1);
    const [, error, , context] = logError.mock.calls[0]!;
    expect((error as Error).message).toBe("context boom");
    expect(context).toMatchObject({
      failureKind: "context-build-failed",
      backendId: "claude",
      prePass: {
        parentRoutine: "routine.activity_scan",
        integrationKey: "gmail",
        status: "failed",
        willRetry: false,
        requestedBackend: "claude",
      },
    });
  });

  it("agent-execute-failed writes an audit row with detail.prePass + binding (replaces the old failureKind-only row)", async () => {
    const { router, execute } = makeRouter();
    execute.mockRejectedValue(new Error("execute boom"));
    const audit = makeAudit();
    const { runner } = makeFetcherRunner({
      db,
      dataDir,
      router,
      audit,
      mailAccounts: [seedMailAccount()],
      config: { prePassMaxAttemptsPerIntegration: 1 },
    });
    await runner.run(hourlyEvent());

    const logError = audit.logError as ReturnType<typeof vi.fn>;
    expect(logError).toHaveBeenCalledTimes(1);
    const [, error, , context] = logError.mock.calls[0]!;
    expect((error as Error).message).toBe("execute boom");
    expect(context).toMatchObject({
      failureKind: "agent-execute-failed",
      backendId: "claude",
      modelId: "claude-haiku-4-5",
      prePass: {
        parentRoutine: "routine.activity_scan",
        integrationKey: "gmail",
        status: "failed",
        willRetry: false,
        requestedBackend: "claude",
      },
    });
  });
});

describe("RoutineFetchWindowRunner — N2 spawn gate + N1 failure spend + N3 drops", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-fw-n2-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    gmailIntegrationDirect(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("skips the sub-session with a skipped audit row when the gate blocks, leaving freshness unwritten", async () => {
    const { router, execute } = makeRouter();
    const audit = makeAudit();
    const spawnGate = makeSpawnGate({ skip: true, reason: "offline" });
    const { runner } = makeFetcherRunner({
      db,
      dataDir,
      router,
      audit,
      spawnGate,
      mailAccounts: [seedMailAccount()],
      config: { prePassMaxAttemptsPerIntegration: 1 },
    });
    const { report } = await runner.run(morningEvent());

    expect(execute).not.toHaveBeenCalled();
    expect(report.status).toBe("skipped");
    expect((report.perIntegration ?? [])[0]).toMatchObject({
      integrationKey: "gmail",
      status: "skipped",
    });
    expect(audit.logSkip).toHaveBeenCalledWith(
      expect.objectContaining({ type: "routine.fetch_window" }),
      "offline",
      "autonomous",
      expect.objectContaining({
        prePass: expect.objectContaining({
          integrationKey: "gmail",
          skipReason: "offline",
        }),
      }),
    );
    // Freshness untouched — the next tick retries.
    const freshness = db
      .prepare("SELECT value_json FROM runtime_state WHERE key = 'pre_pass_last_run:gmail'")
      .get();
    expect(freshness).toBeUndefined();
  });

  it("runs normally when the gate passes", async () => {
    const { router, execute } = makeRouter();
    const spawnGate = makeSpawnGate({ skip: false });
    const { runner } = makeFetcherRunner({
      db,
      dataDir,
      router,
      spawnGate,
      mailAccounts: [seedMailAccount()],
      config: { prePassMaxAttemptsPerIntegration: 1 },
    });
    const { report } = await runner.run(morningEvent());
    expect(execute).toHaveBeenCalledTimes(1);
    expect(report.status).toBe("success");
    expect(
      (spawnGate as unknown as { evaluate: ReturnType<typeof vi.fn> }).evaluate,
    ).toHaveBeenCalledWith(["claude"]);
  });

  it("fails open when the gate itself rejects", async () => {
    const { router, execute } = makeRouter();
    const spawnGate = {
      evaluate: vi.fn(async () => {
        throw new Error("gate exploded");
      }),
    } as unknown as AutonomousSpawnGate;
    const { runner } = makeFetcherRunner({
      db,
      dataDir,
      router,
      spawnGate,
      mailAccounts: [seedMailAccount()],
      config: { prePassMaxAttemptsPerIntegration: 1 },
    });
    const { report } = await runner.run(morningEvent());
    expect(execute).toHaveBeenCalledTimes(1);
    expect(report.status).toBe("success");
  });

  it("recovers the failure spend into the attempt record, budget guard, and audit row (N1)", async () => {
    const spend = {
      usage: {
        inputTokens: 30_000,
        outputTokens: 1_000,
        cacheCreationInputTokens: 34_000,
        cacheReadInputTokens: 0,
      },
      costUsd: 0.5,
      modelId: "claude-haiku-4-5",
      numTurns: 9,
      durationMs: 90_000,
      costSource: "sdk_partial" as const,
    };
    const quotaKill = new BackendQuotaError(
      "claude",
      "max_budget_usd",
      null,
      "max budget exceeded",
      spend,
    );
    const { router, execute } = makeRouter(quotaKill as unknown as Error);
    const audit = makeAudit();
    const { runner } = makeFetcherRunner({
      db,
      dataDir,
      router,
      audit,
      mailAccounts: [seedMailAccount()],
      config: { prePassMaxAttemptsPerIntegration: 1 },
    });
    const { report } = await runner.run(morningEvent());

    expect(execute).toHaveBeenCalledTimes(1);
    const sub = (report.perIntegration ?? [])[0];
    expect(sub?.status).toBe("failed");
    // The attempt record carries the recovered spend, not a silent 0.
    expect(sub?.attempts[0]?.costUsd).toBeCloseTo(0.5, 4);
    expect(sub?.attempts[0]?.numTurns).toBe(9);
    // The audit row carries the recovered cost/tokens/turns.
    expect(audit.logError).toHaveBeenCalledWith(
      expect.objectContaining({ type: "routine.fetch_window" }),
      expect.any(Error),
      "autonomous",
      expect.objectContaining({
        failureKind: "agent-execute-failed",
        costUsd: 0.5,
        costSource: "sdk_partial",
        tokensInput: 30_000,
        tokensOutput: 1_000,
        numTurns: 9,
      }),
    );
  });

  it("writes one plan_drop audit row per dropped integration×reason group (N3)", async () => {
    // gmail is seeded direct (beforeEach) but NO mail accounts are passed
    // → its per-account mail windows drop with `no_accounts`. The other
    // mode-aware integrations sit at the store default `disabled`.
    // (A delegated/native row without a binding cannot round-trip through
    // the integrations store — integrationStateSchema rejects it — so the
    // defensive `no_binding` reason is exercised at the
    // routine-acquisition-plan unit level instead.)
    const { router, execute } = makeRouter();
    const audit = makeAudit();
    const { runner } = makeFetcherRunner({ db, dataDir, router, audit });
    const { report } = await runner.run(morningEvent());

    expect(execute).not.toHaveBeenCalled();
    expect(report.status).toBe("skipped");
    expect(audit.logSkip).toHaveBeenCalledWith(
      expect.objectContaining({ type: "routine.fetch_window" }),
      "plan_drop:no_accounts",
      "autonomous",
      expect.objectContaining({
        prePass: expect.objectContaining({
          parentRoutine: "routine.morning_routine",
          integrationKey: "gmail",
          skipReason: "no_accounts",
          windows: expect.arrayContaining([expect.any(String)]),
        }),
      }),
    );
    expect(audit.logSkip).toHaveBeenCalledWith(
      expect.objectContaining({ type: "routine.fetch_window" }),
      "plan_drop:disabled",
      "autonomous",
      expect.objectContaining({
        prePass: expect.objectContaining({
          integrationKey: "notion",
          skipReason: "disabled",
        }),
      }),
    );
    // One row per (integration, reason) group — gmail's mail windows
    // collapse into a single no_accounts row.
    const gmailDropCalls = (audit.logSkip as ReturnType<typeof vi.fn>).mock.calls
      .filter(([, reason]) => reason === "plan_drop:no_accounts");
    expect(gmailDropCalls).toHaveLength(1);
  });

  it("filters direct_inline_prefetch drops out of the N3 audit stream — only the genuine drop group logs", async () => {
    // morning_routine with both calendar providers in `direct` mode hits
    // the deliberately-omitted cal_morning_7d direct cells →
    // `direct_inline_prefetch` drops (catalog working as designed —
    // ContextBuilder pre-fetches those events inline). notion `disabled`
    // is the single genuine drop group. gmail / outlook_mail run direct
    // with one account each so the mail windows emit rows instead of
    // dropping.
    seedIntegrations(db, {
      gmail: integrationState({ mode: "direct" }),
      outlook_mail: integrationState({ mode: "direct" }),
      google_calendar: integrationState({ mode: "direct" }),
      outlook_calendar: integrationState({ mode: "direct" }),
      notion: integrationState({ mode: "disabled" }),
    });
    const { router } = makeRouter();
    const audit = makeAudit();
    const { runner } = makeFetcherRunner({
      db,
      dataDir,
      router,
      audit,
      mailAccounts: [
        seedMailAccount(),
        {
          ...seedMailAccount(),
          id: "acct2",
          kind: "outlook",
          email: "alice@outlook.example.com",
        },
      ],
    });
    const { report } = await runner.run(morningEvent());

    expect(report.status).toBe("success");
    // Exactly ONE skipped audit row — the notion disabled group. The two
    // direct_inline_prefetch drops (google_calendar + outlook_calendar)
    // must NOT produce rows: counting them would pollute the R4/R5
    // sizing data every single run.
    expect(audit.logSkip).toHaveBeenCalledTimes(1);
    expect(audit.logSkip).toHaveBeenCalledWith(
      expect.objectContaining({ type: "routine.fetch_window" }),
      "plan_drop:disabled",
      "autonomous",
      expect.objectContaining({
        prePass: expect.objectContaining({
          parentRoutine: "routine.morning_routine",
          integrationKey: "notion",
          skipReason: "disabled",
          windows: ["updated_24h"],
        }),
      }),
    );
  });

  it("drops Notion with plan_drop:no_fetch_targets when the allowlist is empty", async () => {
    // Active Notion without a configured fetch-target allowlist must not
    // spawn a sub-session (the pre-pass would otherwise scan the whole
    // workspace) — and the skip must be visible in the N3 audit stream so
    // the silent absence of Notion observations is diagnosable.
    seedIntegrations(db, {
      gmail: integrationState({ mode: "direct" }),
      notion: integrationState({ mode: "direct" }),
    });
    const { router, execute } = makeRouter();
    const audit = makeAudit();
    const { runner } = makeFetcherRunner({
      db,
      dataDir,
      router,
      audit,
      mailAccounts: [seedMailAccount()],
    });
    const { report } = await runner.run(morningEvent());

    expect(report.status).toBe("success");
    // gmail spawns; notion must not.
    expect(execute).toHaveBeenCalledTimes(1);
    expect(audit.logSkip).toHaveBeenCalledWith(
      expect.objectContaining({ type: "routine.fetch_window" }),
      "plan_drop:no_fetch_targets",
      "autonomous",
      expect.objectContaining({
        prePass: expect.objectContaining({
          parentRoutine: "routine.morning_routine",
          integrationKey: "notion",
          skipReason: "no_fetch_targets",
        }),
      }),
    );
  });

  it("writes zero plan_drop audit rows when every drop is direct_inline_prefetch", async () => {
    // All five morning_routine integrations active in `direct` mode: the
    // mail + notion windows emit rows, and the ONLY drops are the two
    // cal_morning_7d direct_inline_prefetch cells. The N3 audit stream
    // must stay silent — these drops are deterministic catalog design,
    // not a signal.
    seedIntegrations(db, {
      gmail: integrationState({ mode: "direct" }),
      outlook_mail: integrationState({ mode: "direct" }),
      google_calendar: integrationState({ mode: "direct" }),
      outlook_calendar: integrationState({ mode: "direct" }),
      notion: integrationState({
        mode: "direct",
        fetchTargets: [{ label: "Projects", locator: "https://notion.so/projects" }],
      }),
    });
    const { router, execute } = makeRouter();
    const audit = makeAudit();
    const { runner } = makeFetcherRunner({
      db,
      dataDir,
      router,
      audit,
      mailAccounts: [
        seedMailAccount(),
        {
          ...seedMailAccount(),
          id: "acct2",
          kind: "outlook",
          email: "alice@outlook.example.com",
        },
      ],
    });
    const { report } = await runner.run(morningEvent());

    // The plan was non-empty (gmail + outlook_mail + notion sub-sessions
    // spawned) — the drops were real but all filtered.
    expect(execute).toHaveBeenCalledTimes(3);
    expect(report.status).toBe("success");
    expect(audit.logSkip).not.toHaveBeenCalled();
  });
});
