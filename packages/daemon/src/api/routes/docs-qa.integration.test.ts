import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentResult,
  type IntegrationKey,
  type IntegrationState,
} from "@aitne/shared";
import type { IAgentCore, StreamCallbacks } from "../../core/agent-core.js";
import { applySchema } from "../../db/schema.js";
import { EventBus } from "../../core/event-bus.js";
import { EventDispatcher } from "../../core/dispatcher.js";
import { BackendRouter } from "../../core/backends/backend-router.js";
import { SessionManager } from "../../core/session-manager.js";
import { MessageRecorder } from "../../core/message-recorder.js";
import { initTaskFlows, getTaskFlow } from "../../core/prompts.js";
import { DocsQAAdapter } from "../../adapters/docs-qa-adapter.js";
import { makeDbLookup } from "../../core/docs/citation-validator.js";
import { createDocsRoutes } from "./docs.js";
import {
  DEFAULT_CLAUDE_MEDIUM_MODEL,
  latestMediumFor,
} from "../../core/backends/model-registry.js";
import type { AgentConfig } from "../../config.js";

/**
 * Phase 3 — DOCS_QA_B7_DESIGN.md §S9 integration test.
 *
 * Wires the full HTTP→adapter→dispatcher→adapter→SSE round-trip with a
 * single mock IAgentCore. The unit-level assertions for "strip invalid
 * citations + log qa_invalid_citation" already live in
 * `dispatcher.test.ts` (with mocked SessionManager/MessageRecorder) and
 * the static TIER_LOCKED clamp assertions live in
 * `backend-router.test.ts`. This test's distinct value is verifying:
 *
 *   1. The end-to-end streaming path: an inbound POST mints a
 *      docs_qa MessageEvent, the dispatcher streams text deltas to the
 *      SSE wire via the real DocsQAAdapter (so the streaming citation
 *      validator runs in-process, not mocked).
 *   2. The real BackendRouter's TIER_LOCKED clamp surfaces a Sonnet
 *      `chat_meta` event on the wire even when `process_backend_config`
 *      pre-pinned the row to Opus — i.e. the runtime safety net is
 *      reachable from the dispatch path, not just from a synthetic
 *      `resolveBinding` call.
 *   3. The real SessionManager creates a `conversation_sessions` row
 *      with `scope='docs_qa'` (the S1c intent override fires through
 *      the dispatch path).
 *
 * Construction note: we deliberately don't bootstrap `index.ts`'s 2.6k
 * lines of startup. The dispatcher takes its dependencies via
 * constructor + setters, so we wire the minimum real surface (router,
 * session manager, message recorder, adapter) and stub the tangential
 * deps (context builder, notification manager, audit logger).
 */

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TEST_DIR, "..", "..", "..", "..", "..");

// Required so the dispatcher's `assemblePrompt` can load the
// `dashboard.docs_qa.md` task flow off disk during the workdir
// materialization step.
initTaskFlows(REPO_ROOT);

const VALID_SLUG = "features/routines/morning-routine";
const VALID_ANCHOR = "what-it-outputs";
const INVALID_SLUG = "nope/missing-doc";

const MOCK_REPLY = `Morning routine outputs today.md [doc:${VALID_SLUG}#${VALID_ANCHOR}]. Bogus claim [doc:${INVALID_SLUG}].`;

/** Seed a minimal `<dataDir>/context/rules/management.md` so the
 *  autonomous gate is open. Mirrors the helper in dispatcher.test.ts;
 *  required because the dispatcher consults the rules file even on
 *  reactive paths (it disables some logging branches without it). */
function seedManagementRules(dataDir: string): void {
  const rulesDir = join(dataDir, "context", "rules");
  mkdirSync(rulesDir, { recursive: true });
  const rulesPath = join(rulesDir, "management.md");
  if (!existsSync(rulesPath)) {
    writeFileSync(rulesPath, "# Management Rules\n");
  }
}

function makeConfig(dataDir: string): AgentConfig {
  return {
    googleCalendarId: "primary",
    notionDatabaseIds: {},
    dataDir,
    workspaceDir: REPO_ROOT,
    primaryVaultPath: null,
    primaryVaultName: null,
    externalObsidianVaultPath: null,
    externalObsidianVaultName: null,
    gitRepos: [],
    maxConcurrentSessions: 3,
    maxReactiveSessions: 2,
    executeTimeoutMinutes: 60,
    sessionTimeoutDmMinutes: 60,
    sessionTimeoutChannelMinutes: 30,
    sessionTimeoutDashboardMinutes: 120,
    character: "",
    timezone: "",
    dayBoundaryHour: 4,
    hourlyCheckEnabled: false,
    hourlyCheckIntervalMinutes: 60,
    hourlyCheckActiveStartHour: 4,
    hourlyCheckActiveEndHour: 24,
    hourlyCheckMinObservations: 1,
    schedulePollIntervalSeconds: 5,
    maxBriefingDelayMinutes: 30,
    maxNotificationsPerHour: 3,
    maxNotificationsPerDay: 12,
    quietHoursStart: "23:00",
    quietHoursEnd: "07:00",
    batchIntervalMinutes: 15,
    primaryPlatform: "slack",
    defaultNotificationPlatforms: [],
    disallowedTools: [],
    allowedToolsOverride: null,
    slackOwnerUserId: null,
    telegramOwnerChatId: null,
    discordOwnerUserId: null,
    whatsappEnabled: false,
    whatsappOwnerPhone: null,
    whatsappAuthDir: null,
    obsidianDebounceSeconds: 5,
    gitPollIntervalSeconds: 300,
    notionPollIntervalSeconds: 60,
    calendarPollIntervalSeconds: 300,
    apiPort: 8321,
  } as unknown as AgentConfig;
}

/**
 * Build a single Claude-typed mock IAgentCore. The mock streams the
 * fixed reply through `streamCallbacks.onText` (so the real
 * DocsQAAdapter's streaming validator splice runs against actual
 * SSE deltas) and echoes the resolved `modelId` back through
 * `AgentResult` so the dispatcher's `chat_meta` event reflects the
 * TIER_LOCKED clamp. We don't simulate `/search` or `/by-slug` HTTP
 * calls — the design's "mock IAgentCore that calls /search" framing
 * is descriptive of what the real agent would do; the test verifies
 * the resulting wire output, not the simulation fidelity.
 */
function makeMockCore(): IAgentCore {
  const execute = vi
    .fn()
    .mockImplementation(
      async (
        params: { modelId: string },
        streamCallbacks?: StreamCallbacks,
      ): Promise<AgentResult> => {
        // Simulate per-delta streaming so the per-channel streaming
        // citation validator buffers across the boundary the same way
        // it would under a real Claude SDK stream. Splitting in the
        // middle of the valid token is the harshest test of the
        // adapter's reassembly buffer.
        if (streamCallbacks?.onText) {
          const splitIdx = MOCK_REPLY.indexOf("morning-routine#") + 5;
          streamCallbacks.onText(MOCK_REPLY.slice(0, splitIdx));
          streamCallbacks.onText(MOCK_REPLY.slice(splitIdx));
        }
        streamCallbacks?.onEnd?.();
        return {
          output: MOCK_REPLY,
          sessionId: null,
          backendId: "claude",
          modelId: params.modelId,
          costUsd: 0.001,
          usage: {
            inputTokens: 100,
            outputTokens: 50,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
          },
          modelUsage: {},
          numTurns: 1,
          durationMs: 50,
          durationApiMs: 40,
          model: params.modelId,
          isError: false,
          stopReason: null,
          contextUpdated: false,
        };
      },
    );

  return {
    backendId: "claude",
    execute,
    executeResume: vi.fn().mockRejectedValue(new Error("not used")),
    summarize: vi.fn().mockResolvedValue("summary"),
    checkAuth: vi.fn().mockResolvedValue({ ok: true, method: "cli_login" }),
    checkAuthDetailed: vi
      .fn()
      .mockResolvedValue({ ok: true, status: "ok", method: "cli_login" }),
    probeTools: vi.fn().mockResolvedValue([]),
    listModels: vi.fn().mockReturnValue([
      {
        backendId: "claude",
        modelId: "claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        tier: "light",
        available: true,
      },
      {
        backendId: "claude",
        modelId: "claude-opus-4-7",
        label: "Claude Opus 4.7",
        tier: "heavy",
        available: true,
      },
    ]),
  } as unknown as IAgentCore;
}

interface SSEFrame {
  event: string;
  data: string;
}

/**
 * Drain SSE bytes into structured frames. Stops when `expectedEvent`
 * appears or when the reader closes. Keeps the test loop bounded so a
 * regression that drops the final event surfaces as an assertion
 * failure rather than a timeout.
 */
async function readUntilEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  buffer: { value: string },
  expectedEvent: string,
  maxAttempts = 60,
): Promise<SSEFrame[]> {
  const decoder = new TextDecoder();
  for (let i = 0; i < maxAttempts; i += 1) {
    if (buffer.value.includes(`event: ${expectedEvent}`)) break;
    const { value, done } = await reader.read();
    if (done) break;
    buffer.value += decoder.decode(value, { stream: true });
  }
  return parseSSE(buffer.value);
}

function parseSSE(raw: string): SSEFrame[] {
  // SSE frames are double-newline separated; each frame has zero or
  // more `event:` / `data:` / `id:` / `retry:` lines.
  return raw
    .split(/\n\n/)
    .map((block) => {
      let event = "message";
      const dataLines: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice("event: ".length);
        else if (line.startsWith("data: ")) dataLines.push(line.slice("data: ".length));
      }
      return dataLines.length === 0
        ? null
        : { event, data: dataLines.join("\n") };
    })
    .filter((f): f is SSEFrame => f !== null);
}

describe("Docs QA — end-to-end (DOCS_QA_B7_DESIGN.md §S9)", () => {
  let db: Database.Database;
  let dataDir: string;
  let dispatcher: EventDispatcher;
  let docsQAAdapter: DocsQAAdapter;
  let app: ReturnType<typeof createDocsRoutes>;
  let dispatcherRunPromise: Promise<void>;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-docs-qa-int-"));
    seedManagementRules(dataDir);

    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);

    // Seed the docs corpus so `makeDbLookup` finds the valid slug and
    // the `agent_assets/docs/...` fixtures aren't required.
    const upsert = db.prepare(
      `INSERT INTO fts_docs(
         slug, title, keywords, aliases, summary, ask_examples, body,
         tags, process_keys, config_keys, category, section, status, anchors,
         related
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    upsert.run(
      VALID_SLUG,
      "Morning Routine",
      "morning\nroutine",
      "morning_routine",
      "The autonomous routine that runs once per agent-day.",
      "When does morning routine run?",
      "# Morning Routine\n## What It Outputs",
      JSON.stringify(["routine", "core"]),
      JSON.stringify(["routine.morning_routine"]),
      JSON.stringify(["morningRoutineHour"]),
      "features",
      "routines",
      "stable",
      `morning-routine\n${VALID_ANCHOR}`,
      JSON.stringify([]),
    );

    // Pre-pin dashboard.docs_qa to a heavy model with updated_by='user',
    // mirroring the §S2 test fixture. This is what TIER_LOCKED has to
    // clamp over to surface Sonnet on the wire. The schema seeds an
    // initial cascade-written row, so update rather than insert.
    db.prepare(
      `UPDATE process_backend_config
          SET main_backend = 'claude',
              main_model = 'claude-opus-4-7',
              updated_by = 'user'
        WHERE process_key = 'dashboard.docs_qa'`,
    ).run();

    const config = makeConfig(dataDir);
    const eventBus = new EventBus();
    const sessionManager = new SessionManager(db, config);
    const messageRecorder = new MessageRecorder(db);
    const mockCore = makeMockCore();
    const backendRouter = new BackendRouter(db, config, [mockCore]);

    const mockContextBuilder = {
      build: vi.fn().mockResolvedValue(""),
      buildResumeCatchupContext: vi.fn().mockResolvedValue(""),
    };
    const mockNotificationMgr = {
      send: vi.fn().mockResolvedValue(undefined),
      beginReplyActivity: vi.fn().mockResolvedValue({
        stop: vi.fn().mockResolvedValue(undefined),
      }),
    };
    const mockAudit = {
      logAction: vi.fn(),
      logSkip: vi.fn(),
      logError: vi.fn(),
      logAttachment: vi.fn(),
      logBangCommand: vi.fn(),
      insertInProgressRow: vi.fn(() => -1),
    };

    dispatcher = new EventDispatcher(
      eventBus,
      backendRouter,
      mockContextBuilder,
      ((eventType: string, backendId?: string, integrations?: Partial<Record<IntegrationKey, IntegrationState>>) =>
        getTaskFlow(eventType, backendId, integrations)),
      mockNotificationMgr,
      sessionManager,
      messageRecorder,
      mockAudit,
      db,
      config,
    );
    dispatcher.setDocsCitationLookup(makeDbLookup(db));

    docsQAAdapter = new DocsQAAdapter(
      (event) => void eventBus.put(event),
      makeDbLookup(db),
    );
    // Single-stream wiring: this test instantiates only the docs-qa
    // adapter, so we skip CompositeDashboardStream and point the
    // dispatcher's lone IDashboardStream slot directly at it.
    dispatcher.setDashboardStream(docsQAAdapter);

    app = createDocsRoutes({ db, docsQAAdapter });
    dispatcherRunPromise = dispatcher.run();
  });

  afterEach(async () => {
    dispatcher.stop();
    // Nudge the loop with a low-priority dummy so `run()` returns
    // promptly instead of waiting on the next event tick. Mirrors the
    // teardown pattern in dispatcher.test.ts:5600-5609.
    await Promise.race([
      dispatcherRunPromise,
      new Promise((r) => setTimeout(r, 200)),
    ]);
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("strips invalid citations on the wire, persists clean assistant content, logs qa_invalid_citation, persists scope='docs_qa', and surfaces the TIER_LOCKED'd Sonnet model in chat_meta", async () => {
    // ── Open the SSE stream and capture the minted channelId ──
    const streamRes = await app.request("/docs/qa/stream");
    expect(streamRes.status).toBe(200);
    expect(streamRes.headers.get("content-type")).toContain("text/event-stream");

    const reader = streamRes.body!.getReader();
    const buffer = { value: "" };
    const initial = await readUntilEvent(reader, buffer, "session_info");
    const sessionInfoFrame = initial.find((f) => f.event === "session_info");
    expect(sessionInfoFrame).toBeDefined();
    const { channelId } = JSON.parse(sessionInfoFrame!.data) as {
      channelId: string;
    };
    expect(channelId).toMatch(/^[0-9a-f-]{36}$/);

    // ── POST a question against that channel ──
    const postRes = await app.request("/docs/qa/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channelId,
        content: "When does morning routine run?",
      }),
    });
    expect(postRes.status).toBe(202);

    // ── Drain the wire until the dispatcher's chat_meta lands ──
    // chat_meta is the *last* docs-qa event the dispatcher emits per
    // turn, so reaching it implies the streaming chunks + stream_end
    // already crossed the wire. parseSSE re-tokenizes the cumulative
    // buffer, so prior frames are still visible.
    const finalFrames = await readUntilEvent(reader, buffer, "chat_meta");

    // 1. The streamed text contains the valid citation token unchanged.
    const streamedText = finalFrames
      .filter((f) => f.event === "chat_stream")
      .map((f) => (JSON.parse(f.data) as { chunk: string }).chunk)
      .join("");
    expect(streamedText).toContain(`[doc:${VALID_SLUG}#${VALID_ANCHOR}]`);

    // 2. The streamed text does NOT contain the invalid token (the
    //    streaming validator stripped it before SSE write).
    expect(streamedText).not.toContain(INVALID_SLUG);
    expect(streamedText).not.toContain("[doc:nope/missing-doc]");

    // 3. The chat_meta envelope reports the TIER_LOCKED'd Sonnet model
    //    despite the operator's heavy Opus pin in process_backend_config.
    const chatMetaFrame = finalFrames.find((f) => f.event === "chat_meta");
    expect(chatMetaFrame).toBeDefined();
    const meta = JSON.parse(chatMetaFrame!.data) as {
      backend?: string;
      model?: string;
    };
    expect(meta.backend).toBe("claude");
    // Mirrors the §S2/§11.7 fallback chain so a future
    // `DEFAULT_CLAUDE_MEDIUM_MODEL` bump auto-tracks.
    const expectedMedium = latestMediumFor("claude") ?? DEFAULT_CLAUDE_MEDIUM_MODEL;
    expect(meta.model).toBe(expectedMedium);

    // ── Tear down the SSE reader so afterEach's dispatcher.stop()
    //    isn't racing on a still-open stream. The route's onAbort then
    //    unregisters the channel from the adapter. ──
    await reader.cancel().catch(() => {});

    // ── DB-level invariants ──

    // 4. agent_actions has exactly one qa_invalid_citation row, its
    //    detail mentions the stripped slug.
    const auditRows = db
      .prepare(
        `SELECT detail FROM agent_actions WHERE action_type = 'qa_invalid_citation'`,
      )
      .all() as { detail: string }[];
    expect(auditRows).toHaveLength(1);
    const detail = JSON.parse(auditRows[0]!.detail) as {
      slugMissing: { slug: string }[];
    };
    expect(detail.slugMissing.map((m) => m.slug)).toContain(INVALID_SLUG);

    // 5. conversation_sessions has exactly one row, and it's docs_qa
    //    scoped (proves S1c's intent override threaded all the way
    //    through SessionManager.getOrCreate).
    const sessionRows = db
      .prepare(`SELECT scope FROM conversation_sessions`)
      .all() as { scope: string }[];
    expect(sessionRows).toHaveLength(1);
    expect(sessionRows[0]!.scope).toBe("docs_qa");

    // 6. The persistence-side validator wrote the cleaned text — the
    //    invalid token is absent from `messages.content`. Without
    //    §11.1's persistence-side pass, a page reload would re-render
    //    the invalid citation that the wire stripped.
    const assistantRow = db
      .prepare(
        `SELECT content FROM messages WHERE role = 'assistant' ORDER BY id DESC LIMIT 1`,
      )
      .get() as { content: string } | undefined;
    expect(assistantRow).toBeDefined();
    expect(assistantRow!.content).toContain(`[doc:${VALID_SLUG}#${VALID_ANCHOR}]`);
    expect(assistantRow!.content).not.toContain(INVALID_SLUG);
  });

  it("rebinds the active docs_qa session's channel_id when the SSE reconnects (DOCS_QA_B7_DESIGN.md §11.14)", async () => {
    // ── Open the first SSE stream and mint channelId-A ──
    const streamA = await app.request("/docs/qa/stream");
    expect(streamA.status).toBe(200);
    const readerA = streamA.body!.getReader();
    const bufferA = { value: "" };
    const initialA = await readUntilEvent(readerA, bufferA, "session_info");
    const { channelId: channelA } = JSON.parse(
      initialA.find((f) => f.event === "session_info")!.data,
    ) as { channelId: string };

    // ── POST against channelId-A so a docs_qa session row exists with
    //    channel_id = channelA. We drain the wire to chat_meta to make
    //    sure the dispatcher finished writing the session row before
    //    we attempt a reconnect. ──
    const post = await app.request("/docs/qa/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channelId: channelA,
        content: "When does morning routine run?",
      }),
    });
    expect(post.status).toBe(202);
    await readUntilEvent(readerA, bufferA, "chat_meta");

    const sessionRowAfterFirst = db
      .prepare(
        `SELECT channel_id FROM conversation_sessions
           WHERE scope = 'docs_qa' AND status = 'active' LIMIT 1`,
      )
      .get() as { channel_id: string } | undefined;
    expect(sessionRowAfterFirst).toBeDefined();
    expect(sessionRowAfterFirst!.channel_id).toBe(channelA);

    // ── Tear down the first SSE (simulates EventSource auto-reconnect
    //    or tab reload — the route's onAbort fires unregisterClient). ──
    await readerA.cancel().catch(() => {});

    // ── Open a second SSE stream (the reconnect). ──
    const streamB = await app.request("/docs/qa/stream");
    const readerB = streamB.body!.getReader();
    const bufferB = { value: "" };
    const initialB = await readUntilEvent(readerB, bufferB, "session_info");
    const { channelId: channelB } = JSON.parse(
      initialB.find((f) => f.event === "session_info")!.data,
    ) as { channelId: string };
    expect(channelB).not.toBe(channelA);

    // ── The rebind UPDATE on connect must have moved the session's
    //    channel_id to channelId-B; otherwise a retry POST would orphan
    //    in the dispatcher's resolveDashboardChannel() lookup. ──
    const sessionRowAfterReconnect = db
      .prepare(
        `SELECT channel_id FROM conversation_sessions
           WHERE scope = 'docs_qa' AND status = 'active' LIMIT 1`,
      )
      .get() as { channel_id: string } | undefined;
    expect(sessionRowAfterReconnect).toBeDefined();
    expect(sessionRowAfterReconnect!.channel_id).toBe(channelB);

    await readerB.cancel().catch(() => {});
  });
});
