import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEvent, EventPriority } from "@aitne/shared";
import type { Event, MessageEvent, AgentResult } from "@aitne/shared";
import { applySchema } from "../db/schema.js";
import {
  PROACTIVE_FORWARD_DISAVOWAL_PATTERNS,
  ResultProcessor,
} from "./dispatcher-result-processor.js";
import type { AgentConfig } from "../config.js";
import type {
  IAuditLogger,
  INotificationManager,
  ISessionManager,
} from "./dispatcher-types.js";

function fakeConfig(dataDir: string): AgentConfig {
  return {
    dataDir,
    workspaceDir: join(dataDir, "workdirs"),
    apiPort: 0,
    timezone: "UTC",
    dayBoundaryHour: 4,
    historyInjectionMaxMessages: 20,
    historyOtherSurfaceWindowMinutes: 1440,
  } as unknown as AgentConfig;
}

function makeProcessor(opts: {
  db: Database.Database;
  dataDir: string;
  audit?: IAuditLogger;
  notificationMgr?: INotificationManager;
  sessionMgr?: ISessionManager;
  isReactive?: (e: Event) => boolean;
  notifiedEvents?: Set<string>;
  hasMessageBackendMetadataColumns?: boolean;
}): {
  processor: ResultProcessor;
  audit: IAuditLogger;
  notificationMgr: INotificationManager;
  sessionMgr: ISessionManager;
  notifiedEvents: Set<string>;
} {
  const audit =
    opts.audit ??
    ({
      logAction: vi.fn(),
      logSkip: vi.fn(),
      logError: vi.fn(),
      logAttachment: vi.fn(),
      logBangCommand: vi.fn(),
    } as unknown as IAuditLogger);
  const notificationMgr =
    opts.notificationMgr ??
    ({
      send: vi.fn().mockResolvedValue(undefined),
      beginReplyActivity: vi.fn(),
    } as unknown as INotificationManager);
  const sessionMgr =
    opts.sessionMgr ??
    ({
      getPreviousDmSummary: vi.fn().mockReturnValue(null),
      getDmPlatformsWithNewMessages: vi.fn().mockReturnValue([]),
      getUnsummarizedDmMessages: vi.fn().mockReturnValue([]),
      saveDmSummary: vi.fn(),
    } as unknown as ISessionManager);
  const notifiedEvents = opts.notifiedEvents ?? new Set<string>();
  const processor = new ResultProcessor({
    db: opts.db,
    config: fakeConfig(opts.dataDir),
    audit,
    notificationMgr,
    sessionMgr,
    notifiedEvents,
    isReactive: opts.isReactive ?? (() => true),
    hasMessageBackendMetadataColumns:
      opts.hasMessageBackendMetadataColumns ?? true,
  });
  return { processor, audit, notificationMgr, sessionMgr, notifiedEvents };
}

function makeAgentResult(over: Partial<AgentResult> = {}): AgentResult {
  return {
    output: "agent reply",
    isError: false,
    durationMs: 50,
    numTurns: 1,
    sessionId: null,
    model: "claude-3-5-sonnet",
    backendId: "claude",
    costUsd: 0,
    usage: { input_tokens: 10, output_tokens: 5 },
    modelUsage: {},
    costSource: "backend",
    contextUpdated: false,
    advisorCallCount: 0,
    stopReason: null,
    ...over,
  } as AgentResult;
}

function makeMessageEvent(over: Partial<MessageEvent> = {}): MessageEvent {
  return {
    ...createEvent({
      type: "message.received",
      source: "dashboard",
      priority: EventPriority.HIGH,
    }),
    sender: "user",
    channel: "ch-1",
    content: "hi",
    platform: "dashboard",
    threadId: null,
    isDm: true,
    isMention: false,
    ...over,
  };
}

describe("ResultProcessor — shouldNotify", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-rp-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("notifies for message events", () => {
    const { processor } = makeProcessor({ db, dataDir });
    expect(processor.shouldNotify(makeMessageEvent())).toBe(true);
  });

  it("notifies for non-dashboard scheduled events", () => {
    const { processor } = makeProcessor({ db, dataDir });
    const event = {
      ...createEvent({ type: "scheduled.task", source: "wake", priority: EventPriority.NORMAL }),
      scheduleId: 1,
      taskType: "x",
      taskContext: {},
    } as unknown as Event;
    expect(processor.shouldNotify(event)).toBe(true);
  });

  it("does NOT notify for dashboard-triggered scheduled events", () => {
    const { processor } = makeProcessor({ db, dataDir });
    const event = {
      ...createEvent({ type: "scheduled.task", source: "wake", priority: EventPriority.NORMAL }),
      scheduleId: 1,
      taskType: "x",
      taskContext: { triggeredBy: "dashboard" },
    } as unknown as Event;
    expect(processor.shouldNotify(event)).toBe(false);
  });

  it("does NOT notify for routine events (silent by default)", () => {
    const { processor } = makeProcessor({ db, dataDir });
    const event = {
      ...createEvent({ type: "routine.morning_routine", source: "cron", priority: EventPriority.NORMAL }),
      routine: "morning_routine",
    } as unknown as Event;
    expect(processor.shouldNotify(event)).toBe(false);
  });

  // WIKI_BUILDER_DESIGN.md §3.4 — wiki.* sessions self-report on
  // completion so the operator sees per-URL / per-command outcomes.
  // All six wiki process keys take this path.
  it.each([
    "wiki.ingest_url",
    "wiki.compile",
    "wiki.ask",
    "wiki.lint",
    "wiki.trace",
    "wiki.connect",
  ])("notifies for wiki event %s", (type) => {
    const { processor } = makeProcessor({ db, dataDir });
    const event = createEvent({ type, source: "wiki.bang", priority: EventPriority.HIGH });
    expect(processor.shouldNotify(event)).toBe(true);
  });
});

describe("ResultProcessor — isObserverEvent", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-rp-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("classifies hourly_check, calendar.*, schedule.approaching, notion.*, github.*, git.* as observer events", () => {
    const { processor } = makeProcessor({ db, dataDir });
    const cases: Array<[string, boolean]> = [
      ["calendar.changed", true],
      ["schedule.approaching", true],
      ["notion.updated", true],
      ["github.push", true],
      ["git.commit", true],
      ["message.received", false],
      ["scheduled.task", false],
    ];
    for (const [type, expected] of cases) {
      const e = createEvent({ type, source: "src", priority: EventPriority.NORMAL });
      expect(processor.isObserverEvent(e)).toBe(expected);
    }
    // hourly_check carries the routine field.
    const hourly = {
      ...createEvent({ type: "routine.hourly_check", source: "cron", priority: EventPriority.NORMAL }),
      routine: "hourly_check",
    } as unknown as Event;
    expect(processor.isObserverEvent(hourly)).toBe(true);
  });
});

describe("ResultProcessor — processResult notify-dedup", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-rp-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("consumes the notifiedEvents marker and skips notify when already-notified", async () => {
    const event = makeMessageEvent();
    const notifiedEvents = new Set<string>([event.correlationId]);
    const { processor, notificationMgr } = makeProcessor({ db, dataDir, notifiedEvents });
    await processor.processResult(makeAgentResult(), event);
    expect(notificationMgr.send).not.toHaveBeenCalled();
    expect(notifiedEvents.has(event.correlationId)).toBe(false);
  });

  it("calls notificationMgr.send for an empty marker set + non-empty output", async () => {
    const event = makeMessageEvent();
    const { processor, notificationMgr } = makeProcessor({ db, dataDir });
    await processor.processResult(makeAgentResult({ output: "hello" }), event);
    expect(notificationMgr.send).toHaveBeenCalledWith("hello", event);
  });

  it("respects skipNotify=true", async () => {
    const event = makeMessageEvent();
    const { processor, notificationMgr } = makeProcessor({ db, dataDir });
    await processor.processResult(makeAgentResult(), event, true);
    expect(notificationMgr.send).not.toHaveBeenCalled();
  });

  it("logs to audit with trigger=reactive when isReactive returns true", async () => {
    const event = makeMessageEvent();
    const { processor, audit } = makeProcessor({
      db,
      dataDir,
      isReactive: () => true,
    });
    await processor.processResult(makeAgentResult({ output: "" }), event);
    expect(audit.logAction).toHaveBeenCalledTimes(1);
    expect((audit.logAction as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      trigger: "reactive",
    });
  });

  it("logs to audit with trigger=autonomous when isReactive returns false", async () => {
    const event = makeMessageEvent();
    const { processor, audit } = makeProcessor({
      db,
      dataDir,
      isReactive: () => false,
    });
    await processor.processResult(makeAgentResult({ output: "" }), event);
    expect((audit.logAction as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      trigger: "autonomous",
    });
  });

  it("propagates dmFreshness telemetry into the audit row", async () => {
    const event = makeMessageEvent();
    const { processor, audit } = makeProcessor({ db, dataDir });
    await processor.processResult(makeAgentResult({ output: "" }), event, false, {
      dmFreshness: {
        resumed: true,
        agentLogLagMinutes: 5,
        loudWritesSinceSessionStart: 1,
        quietWritesSinceSessionStart: 2,
        refetchedToday: false,
        triggerMatched: true,
      },
    });
    expect((audit.logAction as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      dmFreshness: { resumed: true, agentLogLagMinutes: 5, triggerMatched: true },
    });
  });

  it("uses originSessionId option when provided", async () => {
    const event = makeMessageEvent();
    const { processor, notificationMgr } = makeProcessor({ db, dataDir });
    await processor.processResult(makeAgentResult({ output: "hello" }), event, false, {
      originSessionId: 42,
    });
    expect(notificationMgr.send).toHaveBeenCalledWith("hello", event, {
      originSessionId: 42,
    });
  });

  // WIKI_BUILDER_DESIGN.md §3.4 — wiki.* events carry the originating
  // DM's routing tuple in `data.reply_target`. processResult must lift
  // it onto the notification manager's `replyTo` option so the
  // completion DM lands on the same channel the operator typed the
  // bang on.
  it("passes replyTo to notificationMgr when the wiki event carries a reply_target", async () => {
    const event = createEvent({
      type: "wiki.ingest_url",
      source: "wiki.bang",
      priority: EventPriority.HIGH,
      data: {
        workspace: "default",
        url: "https://example.com",
        reply_target: {
          platform: "telegram",
          channel: "chat-42",
          threadId: null,
          sender: "owner",
        },
      },
    });
    // The write-verification helper (added 2026-05 to defend against the
    // Sonnet 4.6 "claim success without writing" failure) requires an
    // `agent_actions` row recorded by the Wiki API before it lets the
    // agent's success DM through. Seed one so this test continues to
    // exercise the reply_target lift on the unmodified-output path.
    db.prepare(
      `INSERT INTO agent_actions
         (event_id, action_type, trigger, result, detail, started_at, completed_at, source_kind, source_ref)
       VALUES ('wiki.ingest_url:default:10_raw/example.md', 'wiki.ingest_url',
               'autonomous', 'success', json('{}'),
               datetime('now'), datetime('now'), 'wiki', 'default')`,
    ).run();
    const { processor, notificationMgr } = makeProcessor({ db, dataDir });
    await processor.processResult(
      makeAgentResult({ output: "Ingested https://example.com → 10_raw/example.md" }),
      event,
    );
    expect(notificationMgr.send).toHaveBeenCalledWith(
      "Ingested https://example.com → 10_raw/example.md",
      event,
      {
        replyTo: { platform: "telegram", channel: "chat-42", threadId: null },
      },
    );
  });

  // §3.4 fallback path: a wiki.* event WITHOUT reply_target — the
  // hypothetical routine-triggered wiki session shape — calls send
  // with no options object so it falls through to the proactive path
  // (configured destinations / primary messaging app).
  it("omits replyTo for wiki events without a reply_target field", async () => {
    const event = createEvent({
      type: "wiki.lint",
      source: "wiki.bang",
      priority: EventPriority.HIGH,
      data: { workspace: "default" },
    });
    const { processor, notificationMgr } = makeProcessor({ db, dataDir });
    await processor.processResult(
      makeAgentResult({ output: "Lint complete — 0 orphans, 0 broken links." }),
      event,
    );
    expect(notificationMgr.send).toHaveBeenCalledWith(
      "Lint complete — 0 orphans, 0 broken links.",
      event,
    );
  });

  // WIKI_BUILDER_DESIGN.md §3.4-bis — the `!compile full` above-threshold
  // path lands as a `scheduled.task` event (not `wiki.compile`) because
  // it flows through the approval queue + scheduler. The reply target
  // is lifted from `taskContext.replyTarget` onto `event.data.reply_target`
  // by `scheduler.ts`. processResult must honour it for ANY non-message
  // event, not just wiki.* types.
  it("passes replyTo for a scheduled.task event with reply_target (approval-path approved !compile full)", async () => {
    const event = {
      ...createEvent({
        type: "scheduled.task",
        source: "approved_task",
        priority: EventPriority.NORMAL,
        data: {
          reply_target: { platform: "slack", channel: "C-original", threadId: "thread-abc" },
        },
      }),
      task: "Run wiki.compile full mode",
      taskContext: { workspace: "default", processKey: "wiki.compile" },
      scheduleId: 1,
    } as unknown as Event;
    const { processor, notificationMgr } = makeProcessor({ db, dataDir });
    await processor.processResult(
      makeAgentResult({ output: "Compiled 8 pages from 5 raw notes." }),
      event,
    );
    expect(notificationMgr.send).toHaveBeenCalledWith(
      "Compiled 8 pages from 5 raw notes.",
      event,
      { replyTo: { platform: "slack", channel: "C-original", threadId: "thread-abc" } },
    );
  });

  // Defense-in-depth: a `message.received` event with reply_target in
  // data MUST NOT have its top-level routing overridden. MessageEvents
  // self-route via NotificationManager.deliverReply; honouring a stray
  // `data.reply_target` would conflict with that path.
  it("ignores data.reply_target on a MessageEvent (top-level routing wins)", async () => {
    const event = {
      ...makeMessageEvent({ platform: "slack", channel: "D-original" }),
      data: {
        reply_target: { platform: "evil", channel: "evil-channel", threadId: null },
      },
    } as MessageEvent;
    const { processor, notificationMgr } = makeProcessor({ db, dataDir });
    await processor.processResult(
      makeAgentResult({ output: "Hello." }),
      event,
    );
    // `send` is called without `replyTo` — the manager will self-derive
    // routing from the MessageEvent's top-level platform/channel via
    // `deliverReply`.
    expect(notificationMgr.send).toHaveBeenCalledWith("Hello.", event);
  });

  it("combines replyTo and originSessionId when both apply", async () => {
    const event = createEvent({
      type: "wiki.compile",
      source: "wiki.bang",
      priority: EventPriority.HIGH,
      data: {
        workspace: "default",
        reply_target: { platform: "slack", channel: "C1", threadId: "thread-x" },
      },
    });
    const { processor, notificationMgr } = makeProcessor({ db, dataDir });
    await processor.processResult(
      makeAgentResult({ output: "Compiled 2 pages." }),
      event,
      false,
      { originSessionId: 99 },
    );
    expect(notificationMgr.send).toHaveBeenCalledWith(
      "Compiled 2 pages.",
      event,
      {
        originSessionId: 99,
        replyTo: { platform: "slack", channel: "C1", threadId: "thread-x" },
      },
    );
  });
});

describe("ResultProcessor — wiki.ingest_url write-verification", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-rp-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function makeWikiIngestEvent(workspace: string, url: string): Event {
    return createEvent({
      type: "wiki.ingest_url",
      source: "wiki.bang",
      priority: EventPriority.HIGH,
      data: {
        workspace,
        url,
        reply_target: { platform: "slack", channel: "C1", threadId: null },
      },
    });
  }

  function seedWikiWriteRow(workspace: string): void {
    db.prepare(
      `INSERT INTO agent_actions
         (event_id, action_type, trigger, result, detail, started_at, completed_at, source_kind, source_ref)
       VALUES (?, 'wiki.ingest_url', 'autonomous', 'success', json('{}'),
               datetime('now'), datetime('now'), 'wiki', ?)`,
    ).run(`wiki.ingest_url:${workspace}:10_raw/x.md`, workspace);
  }

  it("forwards the agent's claimed-success DM unchanged when a wiki write row exists for the workspace in-window", async () => {
    const event = makeWikiIngestEvent("default", "https://example.com/a");
    seedWikiWriteRow("default");
    const { processor, notificationMgr } = makeProcessor({ db, dataDir });
    await processor.processResult(
      makeAgentResult({
        output: "Ingested https://example.com/a → 10_raw/example-a.md",
        durationMs: 1_000,
      }),
      event,
    );
    expect(notificationMgr.send).toHaveBeenCalledWith(
      "Ingested https://example.com/a → 10_raw/example-a.md",
      event,
      expect.objectContaining({ replyTo: { platform: "slack", channel: "C1", threadId: null } }),
    );
  });

  it("rewrites the DM into a failure notice when the agent claimed success but no wiki write row exists", async () => {
    const event = makeWikiIngestEvent("default", "https://example.com/fake");
    // No seedWikiWriteRow call — simulates the hallucinated-success scenario.
    const { processor, notificationMgr } = makeProcessor({ db, dataDir });
    await processor.processResult(
      makeAgentResult({
        output: "Ingested https://example.com/fake → 10_raw/articles/whatever.md",
        durationMs: 1_000,
      }),
      event,
    );
    const sentText = (notificationMgr.send as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(sentText).toContain("Failed https://example.com/fake");
    expect(sentText).toContain("no raw note was POSTed");
    expect(sentText).not.toContain("Ingested");
  });

  it("ignores wiki write rows that belong to a different workspace", async () => {
    const event = makeWikiIngestEvent("personal", "https://example.com/b");
    seedWikiWriteRow("default"); // Wrong workspace — must not satisfy the check.
    const { processor, notificationMgr } = makeProcessor({ db, dataDir });
    await processor.processResult(
      makeAgentResult({
        output: "Ingested https://example.com/b → 10_raw/example-b.md",
        durationMs: 1_000,
      }),
      event,
    );
    const sentText = (notificationMgr.send as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(sentText).toContain("Failed https://example.com/b");
  });

  it("does not touch non-wiki.ingest_url completion DMs", async () => {
    const event = createEvent({
      type: "wiki.compile",
      source: "wiki.bang",
      priority: EventPriority.HIGH,
      data: {
        workspace: "default",
        reply_target: { platform: "slack", channel: "C1", threadId: null },
      },
    });
    // wiki.compile has no write rows seeded — but the verifier must only
    // gate `wiki.ingest_url`, leaving every other event type untouched.
    const { processor, notificationMgr } = makeProcessor({ db, dataDir });
    await processor.processResult(
      makeAgentResult({ output: "Compiled 0 pages.", durationMs: 500 }),
      event,
    );
    expect(notificationMgr.send).toHaveBeenCalledWith(
      "Compiled 0 pages.",
      event,
      expect.any(Object),
    );
  });
});

describe("ResultProcessor — finalizeManagementScanIfApplicable", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-rp-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("is a no-op when the event is not an agent task event", () => {
    const { processor } = makeProcessor({ db, dataDir });
    expect(() =>
      processor.finalizeManagementScanIfApplicable(makeMessageEvent(), { errored: false }),
    ).not.toThrow();
  });

  it("is a no-op when taskContext lacks management metadata", () => {
    const { processor } = makeProcessor({ db, dataDir });
    const event = {
      ...createEvent({ type: "scheduled.task", source: "wake", priority: EventPriority.NORMAL }),
      scheduleId: 1,
      taskType: "x",
      taskContext: { processKey: "git.project.init" }, // missing repositoryId / triggerSource
    } as unknown as Event;
    expect(() =>
      processor.finalizeManagementScanIfApplicable(event, { errored: false }),
    ).not.toThrow();
  });
});

describe("ResultProcessor — formatSummaryRole", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-rp-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns the raw role for a user message", () => {
    const { processor } = makeProcessor({ db, dataDir });
    expect(processor.formatSummaryRole({ role: "user", metadata: null })).toBe("user");
  });

  it("returns the raw role for an assistant message without forward metadata", () => {
    const { processor } = makeProcessor({ db, dataDir });
    expect(processor.formatSummaryRole({ role: "assistant", metadata: null })).toBe(
      "assistant",
    );
  });

  it("decorates an assistant message with forward metadata", () => {
    const { processor } = makeProcessor({ db, dataDir });
    expect(
      processor.formatSummaryRole({
        role: "assistant",
        metadata: JSON.stringify({ notificationType: "proactive_forward" }),
      }),
    ).toBe("assistant (forwarded from autonomous run)");
  });

  it("decorates an assistant message dispatched by the scheduler", () => {
    // DM-HISTORY-CONTINUITY-FIX H-1 — scheduled_dm rows get their own
    // dedicated label so the model can tell a pre-composed dispatch
    // apart from a notification forward.
    const { processor } = makeProcessor({ db, dataDir });
    expect(
      processor.formatSummaryRole({
        role: "assistant",
        metadata: JSON.stringify({ notificationType: "scheduled_dm" }),
      }),
    ).toBe("assistant (scheduled DM dispatched)");
  });
});

describe("ResultProcessor — logProactiveForwardDisavowalIfMatched", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-rp-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("does nothing when no pattern matches", () => {
    const { processor } = makeProcessor({ db, dataDir });
    processor.logProactiveForwardDisavowalIfMatched(1, "nothing surprising here");
    const rows = db
      .prepare("SELECT COUNT(*) AS n FROM agent_actions WHERE action_type='proactive_forward_disavowed'")
      .get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it("inserts an agent_actions row when a disavowal pattern matches", () => {
    const { processor } = makeProcessor({ db, dataDir });
    processor.logProactiveForwardDisavowalIfMatched(7, "I don't recall saying that earlier");
    const rows = db
      .prepare(
        "SELECT detail FROM agent_actions WHERE action_type='proactive_forward_disavowed'",
      )
      .all() as Array<{ detail: string }>;
    expect(rows.length).toBe(1);
    const detail = JSON.parse(rows[0].detail) as { sessionId: number };
    expect(detail.sessionId).toBe(7);
  });

  it("recognises every English disavowal pattern in the table", () => {
    const probes = [
      "I don't recall that",
      "I do not remember",
      "I didn't say that",
      "I did not mention it",
      "what did the user say earlier",
      "referencing what",
    ];
    for (const probe of probes) {
      const matched = PROACTIVE_FORWARD_DISAVOWAL_PATTERNS.some((p) => p.test(probe));
      expect(matched, `probe should match: ${probe}`).toBe(true);
    }
  });
});
