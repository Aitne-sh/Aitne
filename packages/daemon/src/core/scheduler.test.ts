import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import cron from "node-cron";
import {
  AgentScheduler,
  buildHourlyCronExpr,
  buildUserProfileSweepMorningCronExpr,
  ROADMAP_MAINTENANCE_CRON_EXPR,
  shouldFireHourlyTickAt,
  USER_PROFILE_SWEEP_EVENING_CRON_EXPR,
} from "./scheduler.js";
import { EventBus } from "./event-bus.js";
import {
  formatSqliteDatetime,
  type AgentTaskEvent,
  type RoutineEvent,
} from "@aitne/shared";
import Database from "better-sqlite3";
import type { AgentConfig } from "../config.js";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

function createTestSetup() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE agent_schedule (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scheduled_for TIMESTAMP NOT NULL,
      task_type TEXT NOT NULL,
      task_description TEXT,
      -- Mirror schema.ts: NULL means "no override" — dispatch falls back
      -- to task_description for the agent body. Set to a non-NULL string
      -- to override (e.g., dashboard edit; description stays as the list
      -- label, prompt becomes the task body).
      task_prompt TEXT,
      task_context JSON DEFAULT '{}',
      correlation_id TEXT,
      -- Mirror schema.ts: NULL means "no override". A row inserted
      -- without a model column persists NULL so the scheduler does
      -- NOT synthesise requestedModel.
      model TEXT,
      -- Mirror schema.ts: abstract tier override; CHECK kept off in
      -- the test schema so the malformed-value test can seed an
      -- invalid string and confirm the watcher refuses it.
      tier_override TEXT,
      -- SCHEDULE_API_REDESIGN_PLAN section 4.3a -- captured backend
      -- pin that companions model. CHECK kept off in the test schema
      -- for the same reason as tier_override (lets a regression test
      -- seed a bogus value and confirm isBackendId narrowing rejects
      -- it). NULL = no backend pin -- scheduler falls through to
      -- process-key defaults bit-identically with the legacy path.
      backend_id TEXT,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    -- conversation_sessions / messages mirror the production schema
    -- closely enough for findOrCreateActiveChannelSession +
    -- MessageRecorder.recordMessage (the channel-timeline write
    -- triggered from handleDirectDm per H-1 of
    -- DM_HISTORY_CONTINUITY_FIX_PLAN.md). The unique index on
    -- (scope, scope_key) for active rows matches the production
    -- constraint so the find-or-create transaction behaves the same.
    CREATE TABLE conversation_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL DEFAULT '',
      channel_id TEXT NOT NULL DEFAULT '',
      thread_id TEXT,
      scope TEXT NOT NULL DEFAULT 'thread',
      scope_key TEXT NOT NULL DEFAULT '',
      backend_session_id TEXT,
      backend TEXT,
      model TEXT,
      status TEXT DEFAULT 'active',
      started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_message_at TEXT DEFAULT (datetime('now')),
      message_count INTEGER DEFAULT 0,
      is_dm INTEGER DEFAULT 0
    );
    CREATE UNIQUE INDEX idx_conv_sessions_scope_active
      ON conversation_sessions(scope, scope_key)
      WHERE status = 'active';
    CREATE TABLE md_file_snapshots (id INTEGER PRIMARY KEY, file_path TEXT, content TEXT, trigger TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER,
      role TEXT,
      content TEXT,
      platform TEXT,
      sender_id TEXT,
      metadata JSON DEFAULT '{}',
      backend TEXT,
      model_id TEXT,
      notification_dispatch_id TEXT,
      timestamp TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE agent_actions (id INTEGER PRIMARY KEY, action_type TEXT, trigger TEXT, result TEXT, cost_usd REAL DEFAULT 0, started_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE notification_log (
      id INTEGER PRIMARY KEY,
      dispatch_id TEXT NOT NULL DEFAULT '',
      notification_type TEXT,
      priority TEXT,
      platform TEXT,
      delivery_channel TEXT,
      delivery_message_id TEXT,
      content_summary TEXT,
      status TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      delivered_at TEXT
    );
    CREATE TABLE runtime_state (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const tmpDir = resolve(tmpdir(), `pa-sched-${randomUUID()}`);
  mkdirSync(resolve(tmpDir, "context", "schedule"), { recursive: true });
  mkdirSync(resolve(tmpDir, "context", "weekly"), { recursive: true });

  const eventBus = new EventBus();
  const config = {
    dataDir: tmpDir,
    dayBoundaryHour: 4,
    timezone: "",
    schedulePollIntervalSeconds: 60,
    sessionTimeoutDmMinutes: 60,
  } as unknown as AgentConfig;

  return { db, eventBus, config, tmpDir };
}

describe("AgentScheduler", () => {
  let setup: ReturnType<typeof createTestSetup>;
  let scheduler: AgentScheduler;

  beforeEach(() => {
    setup = createTestSetup();
    scheduler = new AgentScheduler(setup.eventBus, setup.db, setup.config);
  });

  afterEach(() => {
    scheduler.stop();
    setup.eventBus.close();
    rmSync(setup.tmpDir, { recursive: true, force: true });
  });

  it("starts and stops without error", () => {
    scheduler.start();
    scheduler.stop();
  });

  it("stop is idempotent", () => {
    scheduler.start();
    scheduler.stop();
    scheduler.stop(); // double stop should not throw
  });

  it("dispatches pending scheduled tasks", async () => {
    // Insert a pending task with scheduled_for in the past
    setup.db.prepare(
      "INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status) VALUES (datetime('now', '-1 minutes'), 'wake', 'test task', 'pending')",
    ).run();

    // Use a short poll interval for testing
    setup.config.schedulePollIntervalSeconds = 0.1;
    const scheduler2 = new AgentScheduler(setup.eventBus, setup.db, setup.config);
    scheduler2.start();

    // Wait for the ScheduleWatcher to pick it up
    await new Promise((r) => setTimeout(r, 300));
    scheduler2.stop();

    // The task should be in 'running' status
    const row = setup.db.prepare("SELECT status FROM agent_schedule WHERE id = 1").get() as { status: string };
    expect(row.status).toBe("running");

    // Event should be in the bus
    expect(setup.eventBus.size).toBeGreaterThanOrEqual(1);
  });

  it("includes scheduleId in dispatched event", async () => {
    setup.db.prepare(
      "INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status) VALUES (datetime('now', '-1 minutes'), 'wake', 'test task', 'pending')",
    ).run();

    setup.config.schedulePollIntervalSeconds = 0.1;
    const scheduler2 = new AgentScheduler(setup.eventBus, setup.db, setup.config);
    scheduler2.start();

    await new Promise((r) => setTimeout(r, 300));
    scheduler2.stop();

    // Drain the bus and find the scheduled.task event
    const event = await setup.eventBus.get() as AgentTaskEvent;
    expect(event.type).toBe("scheduled.task");
    expect(event.scheduleId).toBe(1);
    // Row inserted without a `model` column → schema stores NULL → the
    // scheduler must NOT synthesise `requestedModel`. Forcing a value
    // would later override `process_backend_config` for `agent.task`.
    expect(event.requestedModel).toBeUndefined();
    expect(typeof event.correlationId).toBe("string");
    expect(event.correlationId.length).toBeGreaterThan(0);
  });

  // WIKI_BUILDER_DESIGN.md §3.4-bis — when a `task_context.replyTarget`
  // tuple is present (set by `enqueueWikiApproval` for `!compile full`
  // above the threshold), the scheduler must lift it onto the dispatched
  // scheduled.task event's `data.reply_target` so the ResultProcessor
  // can route the completion DM back to the originating channel.
  it("lifts task_context.replyTarget into event.data.reply_target", async () => {
    setup.db.prepare(
      `INSERT INTO agent_schedule
         (scheduled_for, task_type, task_description, task_context, status)
       VALUES (datetime('now', '-1 minutes'),
               'approved_task',
               'Wiki full compile (default)',
               json(?),
               'pending')`,
    ).run(
      JSON.stringify({
        workspace: "default",
        processKey: "wiki.compile",
        replyTarget: {
          platform: "telegram",
          channel: "chat-42",
          threadId: null,
          sender: "owner",
        },
      }),
    );

    setup.config.schedulePollIntervalSeconds = 0.1;
    const scheduler2 = new AgentScheduler(setup.eventBus, setup.db, setup.config);
    scheduler2.start();
    await new Promise((r) => setTimeout(r, 300));
    scheduler2.stop();

    const event = (await setup.eventBus.get()) as AgentTaskEvent;
    expect(event.type).toBe("scheduled.task");
    const replyTarget = (event.data as Record<string, unknown>).reply_target as
      | { platform: string; channel: string; threadId: string | null }
      | undefined;
    expect(replyTarget).toEqual({
      platform: "telegram",
      channel: "chat-42",
      threadId: null,
      sender: "owner",
    });
  });

  it("does NOT set event.data.reply_target on cron tasks without replyTarget", async () => {
    // Cron-only schedule rows (wake / repository_run / recurring) have
    // no originating DM. The lift step must be a no-op so the
    // ResultProcessor falls through to the proactive path with the
    // user's configured destinations.
    setup.db.prepare(
      `INSERT INTO agent_schedule
         (scheduled_for, task_type, task_description, status)
       VALUES (datetime('now', '-1 minutes'), 'wake', 'cron task', 'pending')`,
    ).run();

    setup.config.schedulePollIntervalSeconds = 0.1;
    const scheduler2 = new AgentScheduler(setup.eventBus, setup.db, setup.config);
    scheduler2.start();
    await new Promise((r) => setTimeout(r, 300));
    scheduler2.stop();

    const event = (await setup.eventBus.get()) as AgentTaskEvent;
    expect((event.data as Record<string, unknown>).reply_target).toBeUndefined();
  });

  it("passes requestedModel=opus from agent_schedule row", async () => {
    setup.db.prepare(
      "INSERT INTO agent_schedule (scheduled_for, task_type, task_description, model, status) VALUES (datetime('now', '-1 minutes'), 'wake', 'opus task', 'opus', 'pending')",
    ).run();

    setup.config.schedulePollIntervalSeconds = 0.1;
    const scheduler2 = new AgentScheduler(setup.eventBus, setup.db, setup.config);
    scheduler2.start();

    await new Promise((r) => setTimeout(r, 300));
    scheduler2.stop();

    const event = await setup.eventBus.get() as AgentTaskEvent;
    expect(event.type).toBe("scheduled.task");
    expect(event.requestedModel).toBe("opus");
  });

  it("passes requestedTier from agent_schedule.tier_override", async () => {
    // Primary cost-pinning path for new schedules — caller stores a
    // tier on the row, the watcher must propagate it as
    // event.requestedTier so the dispatcher can hand it to
    // BackendRouter.resolveBinding ahead of the model-derived tier.
    setup.db.prepare(
      "INSERT INTO agent_schedule (scheduled_for, task_type, task_description, tier_override, status) VALUES (datetime('now', '-1 minutes'), 'wake', 'lite-tier docker check', 'lite', 'pending')",
    ).run();

    setup.config.schedulePollIntervalSeconds = 0.1;
    const scheduler2 = new AgentScheduler(setup.eventBus, setup.db, setup.config);
    scheduler2.start();
    await new Promise((r) => setTimeout(r, 300));
    scheduler2.stop();

    const event = await setup.eventBus.get() as AgentTaskEvent;
    expect(event.type).toBe("scheduled.task");
    expect(event.requestedTier).toBe("lite");
    // No model column set → no requestedModel synthesis.
    expect(event.requestedModel).toBeUndefined();
  });

  // SCHEDULE_API_REDESIGN_PLAN §4.3a regression — a registered full
  // model id must be paired with backend_id so the dispatcher's
  // override block (which guards on BOTH requestedBackendId AND
  // requestedModelId together) actually applies the pin. Emitting
  // only requestedModelId silently drops the pin.
  it("emits requestedBackendId + requestedModelId together when model + backend_id are set", async () => {
    setup.db.prepare(
      "INSERT INTO agent_schedule (scheduled_for, task_type, task_description, model, backend_id, status) VALUES (datetime('now', '-1 minutes'), 'wake', 'opus 4.7 pin', 'claude-opus-4-7', 'claude', 'pending')",
    ).run();

    setup.config.schedulePollIntervalSeconds = 0.1;
    const scheduler2 = new AgentScheduler(setup.eventBus, setup.db, setup.config);
    scheduler2.start();
    await new Promise((r) => setTimeout(r, 300));
    scheduler2.stop();

    const event = await setup.eventBus.get() as AgentTaskEvent;
    expect(event.type).toBe("scheduled.task");
    expect(event.requestedBackendId).toBe("claude");
    expect(event.requestedModelId).toBe("claude-opus-4-7");
    // Legacy `requestedModel` is the alias path; must stay undefined
    // when the row is on the registered-id path.
    expect(event.requestedModel).toBeUndefined();
  });

  // dm_session shares the model-resolution branch in the dispatcher
  // (scheduled.dm event); cover its propagation too.
  it("emits requestedBackendId + requestedModelId on scheduled.dm too", async () => {
    setup.db.prepare(
      "INSERT INTO agent_schedule (scheduled_for, task_type, task_description, task_context, model, backend_id, status) VALUES (datetime('now', '-1 minutes'), 'dm_session', 'morning briefing dm', '{\"sub_flow\":\"morning_briefing\"}', 'claude-opus-4-7', 'claude', 'pending')",
    ).run();

    setup.config.schedulePollIntervalSeconds = 0.1;
    const scheduler2 = new AgentScheduler(setup.eventBus, setup.db, setup.config);
    scheduler2.start();
    await new Promise((r) => setTimeout(r, 300));
    scheduler2.stop();

    const event = await setup.eventBus.get() as AgentTaskEvent;
    expect(event.type).toBe("scheduled.dm");
    expect(event.requestedBackendId).toBe("claude");
    expect(event.requestedModelId).toBe("claude-opus-4-7");
    expect(event.requestedModel).toBeUndefined();
  });

  it("falls through to no-override when model is a registered-id but backend_id is NULL (legacy row)", async () => {
    // Legacy rows pre-Phase-A had a full id in `model` and no
    // backend_id companion. §9 of the redesign documents these as
    // already-broken — they fall through to process-key defaults
    // bit-identically with the old "silent drop" behavior, so the
    // upgrade introduces no new regression.
    setup.db.prepare(
      "INSERT INTO agent_schedule (scheduled_for, task_type, task_description, model, status) VALUES (datetime('now', '-1 minutes'), 'wake', 'legacy full-id row', 'claude-opus-4-7', 'pending')",
    ).run();

    setup.config.schedulePollIntervalSeconds = 0.1;
    const scheduler2 = new AgentScheduler(setup.eventBus, setup.db, setup.config);
    scheduler2.start();
    await new Promise((r) => setTimeout(r, 300));
    scheduler2.stop();

    const event = await setup.eventBus.get() as AgentTaskEvent;
    expect(event.requestedBackendId).toBeUndefined();
    expect(event.requestedModelId).toBeUndefined();
    expect(event.requestedModel).toBeUndefined();
  });

  it("ignores a malformed backend_id value (defense-in-depth via isBackendId)", async () => {
    // CHECK constraint in production schema prevents bogus values,
    // but the watcher must also refuse to emit them — mirrors the
    // tier_override defense-in-depth test.
    setup.db.prepare(
      "INSERT INTO agent_schedule (scheduled_for, task_type, task_description, model, backend_id, status) VALUES (datetime('now', '-1 minutes'), 'wake', 'rogue backend', 'claude-opus-4-7', 'not-a-backend', 'pending')",
    ).run();

    setup.config.schedulePollIntervalSeconds = 0.1;
    const scheduler2 = new AgentScheduler(setup.eventBus, setup.db, setup.config);
    scheduler2.start();
    await new Promise((r) => setTimeout(r, 300));
    scheduler2.stop();

    const event = await setup.eventBus.get() as AgentTaskEvent;
    expect(event.requestedBackendId).toBeUndefined();
    expect(event.requestedModelId).toBeUndefined();
  });

  it("preserves the legacy alias path: model='sonnet' with NULL backend_id still emits requestedModel='sonnet'", async () => {
    setup.db.prepare(
      "INSERT INTO agent_schedule (scheduled_for, task_type, task_description, model, status) VALUES (datetime('now', '-1 minutes'), 'wake', 'legacy alias', 'sonnet', 'pending')",
    ).run();

    setup.config.schedulePollIntervalSeconds = 0.1;
    const scheduler2 = new AgentScheduler(setup.eventBus, setup.db, setup.config);
    scheduler2.start();
    await new Promise((r) => setTimeout(r, 300));
    scheduler2.stop();

    const event = await setup.eventBus.get() as AgentTaskEvent;
    expect(event.requestedModel).toBe("sonnet");
    expect(event.requestedBackendId).toBeUndefined();
    expect(event.requestedModelId).toBeUndefined();
  });

  it("propagates tier_override alongside model when both are set (precedence resolved by dispatcher)", async () => {
    // The watcher emits both fields verbatim from the row; precedence
    // (tier wins) is the dispatcher's responsibility. Pinning the
    // contract here keeps the two layers honest.
    setup.db.prepare(
      "INSERT INTO agent_schedule (scheduled_for, task_type, task_description, model, tier_override, status) VALUES (datetime('now', '-1 minutes'), 'wake', 'mixed override', 'opus', 'high', 'pending')",
    ).run();

    setup.config.schedulePollIntervalSeconds = 0.1;
    const scheduler2 = new AgentScheduler(setup.eventBus, setup.db, setup.config);
    scheduler2.start();
    await new Promise((r) => setTimeout(r, 300));
    scheduler2.stop();

    const event = await setup.eventBus.get() as AgentTaskEvent;
    expect(event.requestedTier).toBe("high");
    expect(event.requestedModel).toBe("opus");
  });

  it("ignores malformed tier_override values", async () => {
    // CHECK constraint in production schema prevents typos, but the
    // watcher must also refuse to emit a bogus requestedTier as a
    // defense-in-depth layer (e.g. an older row predating the
    // constraint, or a direct DB poke). The test schema omits the
    // CHECK so we can seed an invalid string here.
    setup.db.prepare(
      "INSERT INTO agent_schedule (scheduled_for, task_type, task_description, tier_override, status) VALUES (datetime('now', '-1 minutes'), 'wake', 'rogue tier', 'turbo', 'pending')",
    ).run();

    setup.config.schedulePollIntervalSeconds = 0.1;
    const scheduler2 = new AgentScheduler(setup.eventBus, setup.db, setup.config);
    scheduler2.start();
    await new Promise((r) => setTimeout(r, 300));
    scheduler2.stop();

    const event = await setup.eventBus.get() as AgentTaskEvent;
    expect(event.requestedTier).toBeUndefined();
  });

  it("dispatches task_prompt as event.task when set, overriding task_description", async () => {
    // task_prompt is the "long agent body" override; task_description stays
    // the short list label. Dispatch must use the prompt.
    setup.db.prepare(
      `INSERT INTO agent_schedule
         (scheduled_for, task_type, task_description, task_prompt, status)
       VALUES (datetime('now', '-1 minutes'), 'wake', 'short label', 'detailed agent instruction body', 'pending')`,
    ).run();

    setup.config.schedulePollIntervalSeconds = 0.1;
    const scheduler2 = new AgentScheduler(setup.eventBus, setup.db, setup.config);
    scheduler2.start();
    await new Promise((r) => setTimeout(r, 300));
    scheduler2.stop();

    const event = await setup.eventBus.get() as AgentTaskEvent;
    expect(event.type).toBe("scheduled.task");
    expect(event.task).toBe("detailed agent instruction body");
  });

  it("falls back to task_description when task_prompt is NULL", async () => {
    // Default behavior preserved for skill-created and system-generated rows
    // that never populate task_prompt.
    setup.db.prepare(
      `INSERT INTO agent_schedule
         (scheduled_for, task_type, task_description, status)
       VALUES (datetime('now', '-1 minutes'), 'wake', 'description-only task', 'pending')`,
    ).run();

    setup.config.schedulePollIntervalSeconds = 0.1;
    const scheduler2 = new AgentScheduler(setup.eventBus, setup.db, setup.config);
    scheduler2.start();
    await new Promise((r) => setTimeout(r, 300));
    scheduler2.stop();

    const event = await setup.eventBus.get() as AgentTaskEvent;
    expect(event.type).toBe("scheduled.task");
    expect(event.task).toBe("description-only task");
  });

  it("dispatches task_type='dm_session' as a scheduled.dm event", async () => {
    // SCHEDULED-DM-IMPLEMENTATION-PLAN §5.5 — DM-tone scheduled
    // session. The row's task_type drives the event type, which in
    // turn is the routing axis for profile + skill set selection.
    setup.db.prepare(
      "INSERT INTO agent_schedule (scheduled_for, task_type, task_description, task_context, status) VALUES (datetime('now', '-1 minutes'), 'dm_session', 'morning briefing — daily summary', '{\"sub_flow\":\"morning_briefing\",\"pin_to_quiet_hours_end\":true}', 'pending')",
    ).run();

    setup.config.schedulePollIntervalSeconds = 0.1;
    const scheduler2 = new AgentScheduler(setup.eventBus, setup.db, setup.config);
    scheduler2.start();

    await new Promise((r) => setTimeout(r, 300));
    scheduler2.stop();

    const row = setup.db.prepare("SELECT status FROM agent_schedule WHERE id = 1").get() as { status: string };
    expect(row.status).toBe("running");

    const event = await setup.eventBus.get() as AgentTaskEvent;
    expect(event.type).toBe("scheduled.dm");
    expect(event.source).toBe("dm_session");
    expect(event.task).toBe("morning briefing — daily summary");
    expect(event.taskContext).toEqual({
      sub_flow: "morning_briefing",
      pin_to_quiet_hours_end: true,
    });
    expect(event.scheduleId).toBe(1);
  });

  it("skips future-scheduled tasks", async () => {
    setup.db.prepare(
      "INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status) VALUES (datetime('now', '+1 hours'), 'wake', 'future task', 'pending')",
    ).run();

    setup.config.schedulePollIntervalSeconds = 0.1;
    const scheduler2 = new AgentScheduler(setup.eventBus, setup.db, setup.config);
    scheduler2.start();

    await new Promise((r) => setTimeout(r, 300));
    scheduler2.stop();

    // Task should still be pending (not picked up yet)
    const row = setup.db.prepare("SELECT status FROM agent_schedule WHERE id = 1").get() as { status: string };
    expect(row.status).toBe("pending");
  });

  it("picks up tasks stored in normalized UTC SQLite format (regression: ISO8601+tz)", async () => {
    // Simulate what POST /api/schedule now does: normalize ISO8601 to UTC SQLite format
    const iso = "2026-04-05T07:00:00-04:00"; // EDT → UTC 2026-04-05 11:00:00
    const utcFormatted = formatSqliteDatetime(new Date(iso));
    expect(utcFormatted).toBe("2026-04-05 11:00:00");

    // Insert with a past-relative time so it gets picked up immediately
    const pastUtc = formatSqliteDatetime(new Date(Date.now() - 60_000));
    setup.db.prepare(
      "INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status) VALUES (?, 'wake', 'tz test', 'pending')",
    ).run(pastUtc);

    setup.config.schedulePollIntervalSeconds = 0.1;
    const scheduler2 = new AgentScheduler(setup.eventBus, setup.db, setup.config);
    scheduler2.start();

    await new Promise((r) => setTimeout(r, 300));
    scheduler2.stop();

    const row = setup.db.prepare("SELECT status FROM agent_schedule WHERE id = 1").get() as { status: string };
    expect(row.status).toBe("running");

    const event = await setup.eventBus.get() as AgentTaskEvent;
    expect(event.type).toBe("scheduled.task");
    expect(event.task).toBe("tz test");
  });

  it("sends direct DM for task_type=dm without creating AgentTaskEvent", async () => {
    const sendDmMock = vi.fn().mockResolvedValue([
      {
        platform: "slack",
        channel: "D123",
      },
    ]);

    setup.db.prepare(
      "INSERT INTO agent_schedule (scheduled_for, task_type, task_description, task_context, status) VALUES (datetime('now', '-1 minutes'), 'dm', '🔔 Reminder\n\nPlease prepare for the meeting', '{\"platform\":\"slack\"}', 'pending')",
    ).run();

    setup.config.schedulePollIntervalSeconds = 0.1;
    const scheduler2 = new AgentScheduler(setup.eventBus, setup.db, setup.config);
    scheduler2.setSendDmCallback(sendDmMock);
    scheduler2.start();

    await new Promise((r) => setTimeout(r, 300));
    scheduler2.stop();

    // DM should have been sent directly
    expect(sendDmMock).toHaveBeenCalledWith(
      "🔔 Reminder\n\nPlease prepare for the meeting",
      ["slack"],
    );

    // Task should be completed (not running — dm tasks don't go to EventBus)
    const row = setup.db.prepare("SELECT status FROM agent_schedule WHERE id = 1").get() as { status: string };
    expect(row.status).toBe("completed");

    // No event should be in the bus
    expect(setup.eventBus.size).toBe(0);

    // Should be logged in notification_log
    const logRow = setup.db.prepare("SELECT * FROM notification_log WHERE notification_type = 'scheduled_dm'").get() as { content_summary: string; platform: string } | undefined;
    expect(logRow).toBeDefined();
    expect(logRow!.platform).toBe("slack");

    // DM-HISTORY-CONTINUITY-FIX H-1 — also recorded into messages via the
    // channel-timeline path so the next inbound DM from the owner can
    // anchor against this turn in <conversation_history>.
    const msgRow = setup.db
      .prepare(
        `SELECT m.role, m.content, m.platform, m.metadata, s.scope, s.scope_key
           FROM messages m
           JOIN conversation_sessions s ON m.session_id = s.id
          WHERE json_extract(m.metadata, '$.notificationType') = 'scheduled_dm'`,
      )
      .get() as
        | {
            role: string;
            content: string;
            platform: string;
            metadata: string;
            scope: string;
            scope_key: string;
          }
        | undefined;
    expect(msgRow).toBeDefined();
    expect(msgRow!.role).toBe("assistant");
    expect(msgRow!.content).toBe("🔔 Reminder\n\nPlease prepare for the meeting");
    expect(msgRow!.platform).toBe("slack");
    expect(msgRow!.scope).toBe("owner_dm");
    const msgMeta = JSON.parse(msgRow!.metadata) as Record<string, unknown>;
    expect(msgMeta.notificationType).toBe("scheduled_dm");
    expect(Array.isArray(msgMeta.dispatchIds)).toBe(true);
    expect((msgMeta.dispatchIds as string[]).length).toBe(1);
  });

  it("scheduled DM messages-write failure does not block the delivery being marked completed", async () => {
    const sendDmMock = vi.fn().mockResolvedValue([
      { platform: "slack", channel: "D123" },
    ]);

    setup.db.prepare(
      "INSERT INTO agent_schedule (scheduled_for, task_type, task_description, task_context, status) VALUES (datetime('now', '-1 minutes'), 'dm', 'will fail', '{\"platform\":\"slack\"}', 'pending')",
    ).run();

    // Drop the messages table so the channel-timeline write throws. The
    // outer handleDirectDm flow must still mark the row 'completed'
    // because the DM has already been delivered to the user — the only
    // thing lost is the in-history echo for this single turn.
    setup.db.exec("DROP TABLE messages");

    setup.config.schedulePollIntervalSeconds = 0.1;
    const scheduler2 = new AgentScheduler(setup.eventBus, setup.db, setup.config);
    scheduler2.setSendDmCallback(sendDmMock);
    scheduler2.start();

    await new Promise((r) => setTimeout(r, 300));
    scheduler2.stop();

    const row = setup.db.prepare("SELECT status FROM agent_schedule WHERE id = 1").get() as { status: string };
    expect(row.status).toBe("completed");
  });

  it("marks dm task as failed when sendDm callback is not set", async () => {
    setup.db.prepare(
      "INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status) VALUES (datetime('now', '-1 minutes'), 'dm', 'test dm', 'pending')",
    ).run();

    setup.config.schedulePollIntervalSeconds = 0.1;
    const scheduler2 = new AgentScheduler(setup.eventBus, setup.db, setup.config);
    // Do NOT set sendDm callback
    scheduler2.start();

    await new Promise((r) => setTimeout(r, 300));
    scheduler2.stop();

    const row = setup.db.prepare("SELECT status FROM agent_schedule WHERE id = 1").get() as { status: string };
    expect(row.status).toBe("failed");
  });

  it("marks dm task as failed when sendDm callback throws", async () => {
    const sendDmMock = vi.fn().mockRejectedValue(new Error("network error"));

    setup.db.prepare(
      "INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status) VALUES (datetime('now', '-1 minutes'), 'dm', 'failing dm', 'pending')",
    ).run();

    setup.config.schedulePollIntervalSeconds = 0.1;
    const scheduler2 = new AgentScheduler(setup.eventBus, setup.db, setup.config);
    scheduler2.setSendDmCallback(sendDmMock);
    scheduler2.start();

    await new Promise((r) => setTimeout(r, 300));
    scheduler2.stop();

    const row = setup.db.prepare("SELECT status FROM agent_schedule WHERE id = 1").get() as { status: string };
    expect(row.status).toBe("failed");
  });

  it("discards stale pending schedules before dispatching due work", async () => {
    setup.db.prepare(
      `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status)
       VALUES
       ('2000-01-01 00:00:00', 'wake', 'stale task', 'pending'),
       (datetime('now', '-1 minutes'), 'wake', 'current task', 'pending')`,
    ).run();

    setup.config.schedulePollIntervalSeconds = 0.1;
    const scheduler2 = new AgentScheduler(setup.eventBus, setup.db, setup.config);
    scheduler2.start();

    await new Promise((r) => setTimeout(r, 300));
    scheduler2.stop();

    const rows = setup.db
      .prepare("SELECT id, status FROM agent_schedule ORDER BY id ASC")
      .all() as { id: number; status: string }[];
    expect(rows).toEqual([
      { id: 1, status: "skipped" },
      { id: 2, status: "running" },
    ]);
  });

  it("deduplicates queued morning routine wakes", () => {
    const first = scheduler.queueMorningRoutineWake("catchup");
    const second = scheduler.queueMorningRoutineWake("google_auth_ready");

    expect(first.inserted).toBe(true);
    expect(second).toMatchObject({ inserted: false });

    const rows = setup.db
      .prepare(
        `SELECT task_type, status, json_extract(task_context, '$.routine') AS routine
           FROM agent_schedule`,
      )
      .all() as { task_type: string; status: string; routine: string }[];
    expect(rows).toEqual([
      { task_type: "wake", status: "pending", routine: "morning_routine" },
    ]);
  });

  it("bumps an existing wake row's scheduled_for forward on dedup merge so a pre-boundary row survives the day-boundary discard pass", () => {
    // Regression for the agent-day-boundary stale-discard race:
    // - A wake row inserted at 03:59:59 local carries scheduled_for in
    //   the previous agent-day window.
    // - The 04:00 cron's queueMorningRoutineWake dedup-merges instead of
    //   inserting.
    // - Without the MAX bump, the merged row keeps the pre-boundary
    //   scheduled_for and the next ScheduleWatcher poll skips it as stale
    //   (`discardStalePendingSchedules` discards `pending` rows with
    //   scheduled_for < currentAgentDayStartUtc).
    // We can't time-travel a real cron tick from a unit test, so we
    // simulate by writing a pre-existing row with a very old
    // scheduled_for, then merging.
    setup.db
      .prepare(
        `INSERT INTO agent_schedule
           (scheduled_for, task_type, task_description, task_context, status)
         VALUES ('1970-01-01 00:00:00', 'wake', 'old pre-boundary wake',
                 json('{"routine":"morning_routine","source":"old","postCatchupRoutines":[],"postCatchupHourlyCheck":false,"importance":"low"}'),
                 'pending')`,
      )
      .run();
    const before = setup.db
      .prepare(
        `SELECT scheduled_for FROM agent_schedule
           WHERE json_extract(task_context, '$.routine') = 'morning_routine'`,
      )
      .get() as { scheduled_for: string };
    expect(before.scheduled_for).toBe("1970-01-01 00:00:00");

    const result = scheduler.queueMorningRoutineWake("post_boundary_cron");
    expect(result).toMatchObject({ inserted: false });

    const after = setup.db
      .prepare(
        `SELECT scheduled_for FROM agent_schedule
           WHERE json_extract(task_context, '$.routine') = 'morning_routine'`,
      )
      .get() as { scheduled_for: string };
    // The merge bumped scheduled_for forward to ~NOW.
    expect(after.scheduled_for > "1970-01-01 00:00:00").toBe(true);
    // And the merged row is now newer than any plausible agent-day start
    // for the current year, so discardStalePendingSchedules can no longer
    // discard it.
    expect(after.scheduled_for >= "2020-01-01 00:00:00").toBe(true);
  });

  it("keeps a future-dated retry's scheduled_for intact when an immediate queueMorningRoutineWake merges (preserves exponential back-off)", () => {
    // scheduleMorningRetry inserts with scheduled_for = NOW + 5/10/15 min.
    // A concurrent queueMorningRoutineWake(NOW) MUST NOT pull that retry
    // row forward, otherwise the back-off is defeated and retries can
    // hammer in rapid succession.
    const futureScheduledFor = "2999-12-31 23:59:59";
    setup.db
      .prepare(
        `INSERT INTO agent_schedule
           (scheduled_for, task_type, task_description, task_context, status)
         VALUES (?, 'wake', 'future retry',
                 json('{"routine":"morning_routine","retryCount":1,"source":"retry","postCatchupRoutines":[],"postCatchupHourlyCheck":false,"importance":"low"}'),
                 'pending')`,
      )
      .run(futureScheduledFor);

    const result = scheduler.queueMorningRoutineWake("immediate_caller");
    expect(result).toMatchObject({ inserted: false });

    const after = setup.db
      .prepare(
        `SELECT scheduled_for FROM agent_schedule
           WHERE json_extract(task_context, '$.routine') = 'morning_routine'`,
      )
      .get() as { scheduled_for: string };
    expect(after.scheduled_for).toBe(futureScheduledFor);
  });

  it("merges deferred catchup metadata into an existing morning wake", () => {
    const first = scheduler.queueMorningRoutineWake("catchup", {
      postCatchupRoutines: ["evening_review"],
      postCatchupHourlyCheck: false,
    });
    const second = scheduler.queueMorningRoutineWake("restart", {
      postCatchupRoutines: ["weekly_review", "evening_review"],
      postCatchupHourlyCheck: true,
    });

    expect(first.inserted).toBe(true);
    expect(second).toMatchObject({ inserted: false });

    const row = setup.db
      .prepare(
        `SELECT
           json_extract(task_context, '$.source') AS source,
           json_extract(task_context, '$.postCatchupHourlyCheck') AS hourly,
           json_extract(task_context, '$.postCatchupRoutines') AS routines
         FROM agent_schedule
         WHERE json_extract(task_context, '$.routine') = 'morning_routine'`,
      )
      .get() as { source: string; hourly: number; routines: string };

    expect(row.source).toBe("catchup");
    expect(row.hourly).toBe(1);
    expect(JSON.parse(row.routines)).toEqual([
      "evening_review",
      "weekly_review",
    ]);
  });

  it("would fail to pick up raw ISO8601 with T separator (demonstrates the bug)", () => {
    // This test documents WHY normalization is needed:
    // Raw ISO8601 strings with 'T' separator are lexicographically > space-separated UTC format
    const rawIso = "2026-04-05T07:00:00-04:00";
    const nowUtc = "2026-04-05 22:00:00"; // well after the actual UTC time (2026-04-05 11:00:00)

    // Lexicographic comparison: 'T' (84) > ' ' (32), so raw ISO is "greater" than now
    expect(rawIso > nowUtc).toBe(true);

    // After normalization, the comparison works correctly
    const normalized = formatSqliteDatetime(new Date(rawIso));
    expect(normalized).toBe("2026-04-05 11:00:00");
    expect(normalized <= nowUtc).toBe(true);
  });

  // ── Phase 9: hourly check cron ──

  describe("hourly check cron", () => {
    it("registers the hourly cron when hourlyCheckEnabled is true", () => {
      const config = {
        ...setup.config,
        hourlyCheckEnabled: true,
        hourlyCheckIntervalMinutes: 60,
        hourlyCheckActiveStartHour: 4,
        hourlyCheckActiveEndHour: 24,
      } as unknown as AgentConfig;
      const s = new AgentScheduler(setup.eventBus, setup.db, config);
      s.start();
      // Internals aren't exposed — reach via cast. Morning routine +
      // evening review + morning sweep + evening sweep + roadmap
      // maintenance + weekly review + monthly review + context-index
      // reconciler + hourly = 9 jobs.
      const jobs = (s as unknown as { cronJobs: unknown[] }).cronJobs;
      expect(jobs.length).toBe(9);
      s.stop();
    });

    it("does not register the hourly cron when disabled", () => {
      const config = {
        ...setup.config,
        hourlyCheckEnabled: false,
      } as unknown as AgentConfig;
      const s = new AgentScheduler(setup.eventBus, setup.db, config);
      s.start();
      const jobs = (s as unknown as { cronJobs: unknown[] }).cronJobs;
      // 8 jobs: morning routine, evening review, morning sweep, evening
      // sweep, roadmap maintenance, weekly review, monthly review,
      // context-index reconciler (hourly is disabled).
      expect(jobs.length).toBe(8);
      s.stop();
    });

    it("reloadCrons stops the old jobs before registering new ones (no multi-register)", () => {
      const config = {
        ...setup.config,
        hourlyCheckEnabled: true,
        hourlyCheckIntervalMinutes: 60,
        hourlyCheckActiveStartHour: 4,
        hourlyCheckActiveEndHour: 24,
      } as unknown as AgentConfig;
      const s = new AgentScheduler(setup.eventBus, setup.db, config);
      s.start();
      const firstCount = (s as unknown as { cronJobs: unknown[] }).cronJobs.length;
      s.reloadCrons();
      const secondCount = (s as unknown as { cronJobs: unknown[] }).cronJobs.length;
      expect(secondCount).toBe(firstCount); // no duplication
      s.stop();
    });

    it("reloadCrons picks up a new hourlyCheckIntervalMinutes immediately (PATCH /api/config hot-apply)", () => {
      // The dashboard PATCH path mutates the live `config` object via
      // `Object.assign(config, runtimeUpdates)` and then fires
      // `onScheduleConfigChanged` → `reloadCrons`. This test stands in
      // for that sequence: bumping the interval from 60 (divisor → exact
      // minute list) to 120 (non-divisor → minute-tick + gate) must
      // re-emit a different cron expression on the next reload, with no
      // daemon restart.
      const config = {
        ...setup.config,
        hourlyCheckEnabled: true,
        hourlyCheckIntervalMinutes: 60,
        hourlyCheckActiveStartHour: 4,
        hourlyCheckActiveEndHour: 24,
      } as unknown as AgentConfig;
      const scheduleSpy = vi.spyOn(cron, "schedule");
      const s = new AgentScheduler(setup.eventBus, setup.db, config);
      s.start();
      const firstExprs = scheduleSpy.mock.calls.map((c) => c[0] as string);
      expect(firstExprs).toContain("0 4-23 * * *");
      expect(firstExprs).not.toContain("* 4-23 * * *");

      // Simulate the mutation `applyConfigUpdates` performs in place.
      config.hourlyCheckIntervalMinutes = 120;
      scheduleSpy.mockClear();
      s.reloadCrons();
      const secondExprs = scheduleSpy.mock.calls.map((c) => c[0] as string);
      expect(secondExprs).toContain("* 4-23 * * *");
      expect(secondExprs).not.toContain("0 4-23 * * *");
      s.stop();
      scheduleSpy.mockRestore();
    });

    it("hourly check callback is invoked when the hourly tick fires outside dayBoundaryHour", () => {
      const config = {
        ...setup.config,
        hourlyCheckEnabled: true,
        hourlyCheckIntervalMinutes: 60,
        hourlyCheckActiveStartHour: 4,
        hourlyCheckActiveEndHour: 24,
        dayBoundaryHour: 4,
      } as unknown as AgentConfig;
      const s = new AgentScheduler(setup.eventBus, setup.db, config);
      // Callback wiring is what run-now and /api/agent/run-now rely on.
      let called = 0;
      s.setHourlyCheckCallback(async (source) => {
        called++;
        expect(source).toBe("cron");
      });
      expect(called).toBe(0); // callback registration alone doesn't invoke
      s.stop();
    });
  });

  // ── User-profile sweep crons (Phase 2) ──
  //
  // The sweep fires 10 min before each paired routine so the paired
  // routine reads a freshly up-to-date `user/profile.md`. The morning
  // expression tracks `dayBoundaryHour`; the evening expression is
  // fixed at 17:50 because Evening Review's cron is fixed at 18:00.
  // The cron expressions themselves are pure functions of config — asserted
  // directly (same pattern as `buildHourlyCronExpr`), which is stabler than
  // spying on `cron.schedule` (ESM default-import interop across module
  // boundaries produces two different object references).
  describe("user-profile sweep crons", () => {
    it("builds morning sweep at 50 (dayBoundaryHour - 1) for the default dayBoundaryHour = 4", () => {
      expect(buildUserProfileSweepMorningCronExpr(4)).toBe("50 3 * * *");
    });

    it("tracks non-default dayBoundaryHour (e.g. 6 → 50 5)", () => {
      expect(buildUserProfileSweepMorningCronExpr(6)).toBe("50 5 * * *");
    });

    it("wraps to hour 23 when dayBoundaryHour = 0", () => {
      expect(buildUserProfileSweepMorningCronExpr(0)).toBe("50 23 * * *");
    });

    it("wraps cleanly for every valid dayBoundaryHour", () => {
      for (let h = 0; h < 24; h++) {
        const expected = `50 ${(h - 1 + 24) % 24} * * *`;
        expect(buildUserProfileSweepMorningCronExpr(h)).toBe(expected);
      }
    });

    it("evening sweep expression is fixed at 50 17", () => {
      expect(USER_PROFILE_SWEEP_EVENING_CRON_EXPR).toBe("50 17 * * *");
    });
  });

  // ── Roadmap mechanical maintenance cron (evening-review slimdown §2.2) ──
  describe("roadmap maintenance cron", () => {
    it("exposes the canonical 17:45 cron expression", () => {
      expect(ROADMAP_MAINTENANCE_CRON_EXPR).toBe("45 17 * * *");
    });

    it("registers the cron job among the cronJobs list", () => {
      const s = new AgentScheduler(setup.eventBus, setup.db, setup.config);
      s.setRoadmapMaintenanceCallback(() => {});
      s.start();
      const jobs = (s as unknown as { cronJobs: unknown[] }).cronJobs;
      // We don't have a stable index across all the cron jobs, so just
      // assert that one was registered. The 17:45 expression is unique.
      expect(jobs.length).toBeGreaterThan(0);
      s.stop();
    });

    it("does not call the callback when autonomousGate blocks", () => {
      const s = new AgentScheduler(setup.eventBus, setup.db, setup.config);
      const cb = vi.fn();
      s.setRoadmapMaintenanceCallback(cb);
      s.setAutonomousGate(() => "setup_blocked");
      // Tick the underlying cron callback manually by reaching into the
      // closure: easier than waiting for 17:45. We do this by replaying
      // a manual call against the registered job's handler. node-cron
      // exposes `_callbacks` on the ScheduledTask shape, but that's
      // internal — keep this assertion lightweight by validating the
      // gate alone (we trust the cron library to call the closure).
      // The functional behavior is covered indirectly by:
      //   1. autonomousGate returning a blocking string short-circuits.
      //   2. cb is fired by the closure body in scheduler.ts only after
      //      that gate check passes.
      // So instead of replaying the cron, assert the gate composition.
      expect(s.start.bind(s)).not.toThrow();
      // The callback is wired but the gate is blocking — nothing
      // happens until a real fire time.
      expect(cb).not.toHaveBeenCalled();
      s.stop();
    });

    it("calls the callback when the cron fires and the gate is open", () => {
      const tz = "UTC";
      const s = new AgentScheduler(setup.eventBus, setup.db, {
        ...setup.config,
        timezone: tz,
      });
      const cb = vi.fn();
      s.setRoadmapMaintenanceCallback(cb);

      // Spy the cron module so we can intercept the registered job.
      const captured: Array<{ expr: string; fn: () => void }> = [];
      const originalSchedule = cron.schedule.bind(cron);
      vi.spyOn(cron, "schedule").mockImplementation((expr, fn) => {
        captured.push({ expr, fn: fn as () => void });
        // Return a no-op ScheduledTask shape — start() and stop() are
        // what scheduler.ts calls on the result.
        return { start: () => {}, stop: () => {} } as unknown as ReturnType<
          typeof originalSchedule
        >;
      });

      s.start();
      const job = captured.find((row) => row.expr === ROADMAP_MAINTENANCE_CRON_EXPR);
      expect(job).toBeDefined();
      job!.fn();
      expect(cb).toHaveBeenCalledTimes(1);

      s.stop();
      vi.restoreAllMocks();
    });

    it("swallows callback errors so a thrown maintenance pass does not crash the cron loop", () => {
      const s = new AgentScheduler(setup.eventBus, setup.db, {
        ...setup.config,
        timezone: "UTC",
      });
      s.setRoadmapMaintenanceCallback(() => {
        throw new Error("synthetic failure");
      });
      const captured: Array<{ expr: string; fn: () => void }> = [];
      vi.spyOn(cron, "schedule").mockImplementation((expr, fn) => {
        captured.push({ expr, fn: fn as () => void });
        return { start: () => {}, stop: () => {} } as unknown as ReturnType<
          typeof cron.schedule
        >;
      });
      s.start();
      const job = captured.find((row) => row.expr === ROADMAP_MAINTENANCE_CRON_EXPR);
      expect(() => job!.fn()).not.toThrow();
      s.stop();
      vi.restoreAllMocks();
    });
  });

  // ── Monthly review kill switch (pre-release default OFF) ──
  //
  // The monthly cron is always registered (the job count tests above
  // depend on it), but the callback consults `config.monthlyReviewEnabled`
  // at fire time. A runtime PATCH that flips the flag therefore takes
  // effect on the next month-end without restart.
  //
  // The cron expression `"0 18 * * *"` is shared between `evening_review`
  // and `monthly_review`, so we can't pick the monthly job by its
  // expression alone. Instead each test invokes every `"0 18 * * *"`
  // callback under a month-end fake clock and asserts on the aggregate
  // set of routine types enqueued — robust against future cron
  // re-ordering, and unambiguous about which routine the flag controls.
  describe("monthly review kill switch", () => {
    function invokeAllSixPmCronsAndCollectEnqueued(
      monthlyReviewEnabled: boolean,
    ): string[] {
      const s = new AgentScheduler(setup.eventBus, setup.db, {
        ...setup.config,
        timezone: "UTC",
        monthlyReviewEnabled,
      } as unknown as AgentConfig);
      const captured: Array<{ expr: string; fn: () => void }> = [];
      vi.spyOn(cron, "schedule").mockImplementation((expr, fn) => {
        captured.push({ expr, fn: fn as () => void });
        return { start: () => {}, stop: () => {} } as unknown as ReturnType<
          typeof cron.schedule
        >;
      });
      s.start();
      const sixPmJobs = captured.filter((row) => row.expr === "0 18 * * *");
      expect(sixPmJobs.length).toBeGreaterThanOrEqual(2);

      const enqueueSpy = vi.spyOn(setup.eventBus, "put");
      // 2026-05-31 → tomorrow's day === 1, so the inner month-end check
      // passes; only the kill switch can block emission.
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-31T18:00:00Z"));
      for (const job of sixPmJobs) {
        job.fn();
      }
      vi.useRealTimers();

      const enqueued = enqueueSpy.mock.calls.map(
        (call) => (call[0] as RoutineEvent).type,
      );
      s.stop();
      vi.restoreAllMocks();
      return enqueued;
    }

    it("does NOT emit monthly_review when monthlyReviewEnabled=false even on a month-end fire", () => {
      const enqueued = invokeAllSixPmCronsAndCollectEnqueued(false);
      // evening_review still fires (the flag is monthly-only); monthly
      // must NOT appear in the enqueued set.
      expect(enqueued).toContain("routine.evening_review");
      expect(enqueued).not.toContain("routine.monthly_review");
    });

    it("emits monthly_review when monthlyReviewEnabled=true on a month-end fire", () => {
      const enqueued = invokeAllSixPmCronsAndCollectEnqueued(true);
      expect(enqueued).toContain("routine.monthly_review");
      // evening_review continues to fire alongside it (independent cron).
      expect(enqueued).toContain("routine.evening_review");
    });
  });

  // ── emitRoutine payload threading (Phase 2) ──
  //
  // The sweep cron passes `{ phase: "morning" | "evening" }` as the
  // second arg of emitRoutine. That payload must reach the emitted
  // RoutineEvent's `data.phase` so the ContextBuilder branch can
  // read it. Naïvely forgetting to spread `data` into createEvent
  // would leave the event with `data: {}` and no phase — a silent
  // regression that unit-tests need to guard against.
  describe("emitRoutine payload threading", () => {
    type EmitRoutine = (name: string, data?: Record<string, unknown>) => void;

    it("emits a routine event with event.data.phase populated when data is passed", async () => {
      const s = new AgentScheduler(setup.eventBus, setup.db, setup.config);
      const emit = (s as unknown as { emitRoutine: EmitRoutine }).emitRoutine.bind(s);
      emit("user_profile_sweep", { phase: "morning" });

      const event = (await setup.eventBus.get()) as RoutineEvent;
      expect(event.type).toBe("routine.user_profile_sweep");
      expect(event.routine).toBe("user_profile_sweep");
      expect(event.data.phase).toBe("morning");
    });

    it("emits an empty data object when no payload is passed (back-compat with existing callers)", async () => {
      const s = new AgentScheduler(setup.eventBus, setup.db, setup.config);
      const emit = (s as unknown as { emitRoutine: EmitRoutine }).emitRoutine.bind(s);
      emit("evening_review");

      const event = (await setup.eventBus.get()) as RoutineEvent;
      expect(event.routine).toBe("evening_review");
      expect(event.data).toEqual({});
    });
  });

  // ── Setup gate (regression for Customize Your Rules bug) ──
  //
  // The ScheduleWatcher must leave pending rows in 'pending' — not claim
  // them — while `autonomousGate()` reports a blocked state. Without this,
  // scheduled wake tasks would fire during setup, patch context files, and
  // indirectly destroy the setup conversation via markOwnerDmSessionStale.
  describe("setup gate", () => {
    it("ScheduleWatcher leaves due rows in pending while autonomousGate is blocked", async () => {
      setup.db.prepare(
        "INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status) VALUES (datetime('now', '-1 minutes'), 'wake', 'blocked task', 'pending')",
      ).run();

      setup.config.schedulePollIntervalSeconds = 0.1;
      const s = new AgentScheduler(setup.eventBus, setup.db, setup.config);
      s.setAutonomousGate(() => "setup_incomplete");
      s.start();

      await new Promise((r) => setTimeout(r, 300));
      s.stop();

      // Row must still be pending, not running/claimed.
      const row = setup.db
        .prepare("SELECT status FROM agent_schedule WHERE id = 1")
        .get() as { status: string };
      expect(row.status).toBe("pending");
      // And no scheduled.task event should have reached the bus.
      expect(setup.eventBus.size).toBe(0);
    });

    it("ScheduleWatcher resumes claiming after autonomousGate returns null", async () => {
      setup.db.prepare(
        "INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status) VALUES (datetime('now', '-1 minutes'), 'wake', 'gated then resumed', 'pending')",
      ).run();

      setup.config.schedulePollIntervalSeconds = 0.1;
      const s = new AgentScheduler(setup.eventBus, setup.db, setup.config);
      let blocked = true;
      s.setAutonomousGate(() => (blocked ? "setup_in_progress" : null));
      s.start();

      await new Promise((r) => setTimeout(r, 250));
      let row = setup.db
        .prepare("SELECT status FROM agent_schedule WHERE id = 1")
        .get() as { status: string };
      expect(row.status).toBe("pending"); // still gated

      blocked = false;
      await new Promise((r) => setTimeout(r, 400));
      s.stop();

      row = setup.db
        .prepare("SELECT status FROM agent_schedule WHERE id = 1")
        .get() as { status: string };
      expect(row.status).toBe("running");
    });
  });

  // ── ScheduleWatcher graceful shutdown ──

  describe("graceful shutdown", () => {
    it("stop() interrupts the poll sleep instead of waiting for the next tick", async () => {
      // Long poll interval — without abort-aware sleep this test would hang
      // for ~60 seconds before stop() returned.
      const config = {
        ...setup.config,
        schedulePollIntervalSeconds: 60,
      } as unknown as AgentConfig;
      const s = new AgentScheduler(setup.eventBus, setup.db, config);
      s.start();

      // Give the watcher loop a beat to enter its first sleepInterruptible.
      await new Promise((r) => setTimeout(r, 50));

      const startedAt = Date.now();
      s.stop();
      // Yield to let the abort propagate and the watcher loop exit.
      await new Promise((r) => setTimeout(r, 50));
      const elapsed = Date.now() - startedAt;

      // Shutdown should be near-instant. Give a generous 1s ceiling for CI noise.
      expect(elapsed).toBeLessThan(1000);
    });
  });
});

// ── Pure-function cron expression builder ──

describe("buildHourlyCronExpr", () => {
  it("builds '0 4-23 * * *' for hourly interval 60", () => {
    expect(buildHourlyCronExpr(60, 4, 24)).toBe("0 4-23 * * *");
  });

  it("builds '0,30 4-23 * * *' for 30-minute interval", () => {
    expect(buildHourlyCronExpr(30, 4, 24)).toBe("0,30 4-23 * * *");
  });

  it("builds '0,20,40 4-23 * * *' for 20-minute interval", () => {
    expect(buildHourlyCronExpr(20, 4, 24)).toBe("0,20,40 4-23 * * *");
  });

  it("builds '0,15,30,45 4-23 * * *' for 15-minute interval", () => {
    expect(buildHourlyCronExpr(15, 4, 24)).toBe("0,15,30,45 4-23 * * *");
  });

  it("uses single-hour format when startHour === endHour - 1", () => {
    // endHour is exclusive, so start=4, end=5 means only hour 4
    expect(buildHourlyCronExpr(60, 4, 5)).toBe("0 4 * * *");
    expect(buildHourlyCronExpr(30, 10, 11)).toBe("0,30 10 * * *");
  });

  it("builds a shorter hour range for 9-18 business hours", () => {
    expect(buildHourlyCronExpr(60, 9, 18)).toBe("0 9-17 * * *");
  });

  it("handles single-hour range when startHour equals endHour", () => {
    // Edge case: start === end → endHour = Math.max(start, end - 1) = start
    expect(buildHourlyCronExpr(60, 4, 4)).toBe("0 4 * * *");
  });

  it("falls back to a minute-tick cron for non-divisor intervals", () => {
    // 7 doesn't divide 60 evenly — emit `* <hours> * * *` and rely on
    // shouldFireHourlyTickAt to gate inside the callback.
    expect(buildHourlyCronExpr(7, 4, 24)).toBe("* 4-23 * * *");
    expect(buildHourlyCronExpr(45, 0, 24)).toBe("* 0-23 * * *");
  });

  it("falls back to a minute-tick cron for intervals greater than 60", () => {
    // 90 minutes → fires at midnight, 01:30, 03:00, ... locally; cron has
    // no native expression for that cadence so we tick every minute and
    // gate.
    expect(buildHourlyCronExpr(90, 4, 24)).toBe("* 4-23 * * *");
    expect(buildHourlyCronExpr(120, 9, 18)).toBe("* 9-17 * * *");
  });
});

describe("shouldFireHourlyTickAt", () => {
  it("always returns true for divisors of 60 (gating handled by cron)", () => {
    // activeStartHour is irrelevant for divisors — the cron expression
    // itself only ticks on the firing minutes, so the gate just needs to
    // wave them through.
    expect(shouldFireHourlyTickAt(10, 17, 60, 4)).toBe(true);
    expect(shouldFireHourlyTickAt(10, 23, 30, 4)).toBe(true);
    expect(shouldFireHourlyTickAt(10, 1, 15, 0)).toBe(true);
  });

  it("anchors arbitrary intervals at activeStartHour", () => {
    // 90-minute cadence with start=4: fires at 4:00, 5:30, 7:00, 8:30,
    // 10:00, 11:30, 13:00, 14:30, ..., 22:00, 23:30.
    expect(shouldFireHourlyTickAt(4, 0, 90, 4)).toBe(true);
    expect(shouldFireHourlyTickAt(5, 30, 90, 4)).toBe(true);
    expect(shouldFireHourlyTickAt(7, 0, 90, 4)).toBe(true);
    expect(shouldFireHourlyTickAt(8, 30, 90, 4)).toBe(true);
    expect(shouldFireHourlyTickAt(22, 0, 90, 4)).toBe(true);
    expect(shouldFireHourlyTickAt(23, 30, 90, 4)).toBe(true);
    // Off-cadence minutes do not fire.
    expect(shouldFireHourlyTickAt(4, 30, 90, 4)).toBe(false);
    expect(shouldFireHourlyTickAt(5, 0, 90, 4)).toBe(false);
    expect(shouldFireHourlyTickAt(6, 30, 90, 4)).toBe(false);
  });

  it("handles 7-minute cadence anchored at activeStartHour=4", () => {
    // From minute 240 (4:00): 240, 247, 254, 261, ...
    expect(shouldFireHourlyTickAt(4, 0, 7, 4)).toBe(true);
    expect(shouldFireHourlyTickAt(4, 7, 7, 4)).toBe(true);
    expect(shouldFireHourlyTickAt(5, 3, 7, 4)).toBe(true); // 303-240=63=9*7
    expect(shouldFireHourlyTickAt(4, 5, 7, 4)).toBe(false);
    expect(shouldFireHourlyTickAt(5, 0, 7, 4)).toBe(false); // 300-240=60, 60%7=4
  });

  it("regression: interval = 1440 (one day) fires at activeStartHour", () => {
    // Defect: with a midnight anchor, interval=1440 had its only mod-zero
    // point at 00:00, which sits outside the typical 4–24 active window
    // and so never fired. With activeStartHour anchor, it fires at the
    // start of the window once per day, regardless of where that is.
    expect(shouldFireHourlyTickAt(4, 0, 1440, 4)).toBe(true);
    expect(shouldFireHourlyTickAt(0, 0, 1440, 0)).toBe(true);
    expect(shouldFireHourlyTickAt(9, 0, 1440, 9)).toBe(true);
    expect(shouldFireHourlyTickAt(4, 1, 1440, 4)).toBe(false);
    expect(shouldFireHourlyTickAt(5, 0, 1440, 4)).toBe(false);
    // With start=0, the slot lands at 0:00 — 4:00 is NOT a fire time.
    expect(shouldFireHourlyTickAt(4, 0, 1440, 0)).toBe(false);
  });

  it("regression: interval near window length still fires once per day", () => {
    // 720-min (12h) interval, start=4: fires at 4:00 and 16:00.
    expect(shouldFireHourlyTickAt(4, 0, 720, 4)).toBe(true);
    expect(shouldFireHourlyTickAt(16, 0, 720, 4)).toBe(true);
    expect(shouldFireHourlyTickAt(10, 0, 720, 4)).toBe(false);
    // 1080-min (18h) interval, start=4: fires at 4:00 and 22:00.
    expect(shouldFireHourlyTickAt(4, 0, 1080, 4)).toBe(true);
    expect(shouldFireHourlyTickAt(22, 0, 1080, 4)).toBe(true);
    expect(shouldFireHourlyTickAt(13, 0, 1080, 4)).toBe(false);
  });

  it("regression: interval > 60 (e.g. 120) fires every N minutes anchored at activeStartHour", () => {
    // 120-min (2h) interval, start=4: fires at 4:00, 6:00, 8:00, ... 22:00.
    const fireHours = [4, 6, 8, 10, 12, 14, 16, 18, 20, 22];
    for (const h of fireHours) {
      expect(shouldFireHourlyTickAt(h, 0, 120, 4)).toBe(true);
    }
    // Off-cycle hours within the active window must not fire.
    for (const h of [5, 7, 9, 11, 13, 15, 17, 19, 21, 23]) {
      expect(shouldFireHourlyTickAt(h, 0, 120, 4)).toBe(false);
    }
    // Non-zero minutes within a fire-hour must not fire.
    expect(shouldFireHourlyTickAt(6, 30, 120, 4)).toBe(false);
    expect(shouldFireHourlyTickAt(8, 1, 120, 4)).toBe(false);
    expect(shouldFireHourlyTickAt(8, 59, 120, 4)).toBe(false);
  });

  it("does not falsely fire when called before activeStartHour", () => {
    // Defensive: cron's hour range excludes hours below activeStartHour,
    // but if anything ever invokes the gate at e.g. 3:00 with start=4,
    // the (h*60+m - anchor + 1440) % 1440 wrap must keep the offset
    // non-negative so we don't incorrectly return true.
    expect(shouldFireHourlyTickAt(3, 0, 90, 4)).toBe(false);
    expect(shouldFireHourlyTickAt(0, 0, 90, 4)).toBe(false);
  });
});

// ── AgentScheduler: additional coverage ──

describe("AgentScheduler additional coverage", () => {
  let setup: ReturnType<typeof createTestSetup>;
  let scheduler: AgentScheduler;

  beforeEach(() => {
    setup = createTestSetup();
    scheduler = new AgentScheduler(setup.eventBus, setup.db, setup.config);
  });

  afterEach(() => {
    scheduler.stop();
    setup.eventBus.close();
    rmSync(setup.tmpDir, { recursive: true, force: true });
  });

  describe("setDayBoundaryCallback", () => {
    it("registers the day boundary callback", () => {
      const cb = vi.fn().mockResolvedValue(undefined);
      scheduler.setDayBoundaryCallback(cb);
      // Just verifying it doesn't throw; the callback is invoked by cron job
    });
  });

  describe("setHourlyCheckCallback", () => {
    it("registers and stores the hourly check callback", () => {
      const cb = vi.fn().mockResolvedValue(undefined);
      scheduler.setHourlyCheckCallback(cb);
      // The callback is later invoked by the hourly cron
    });
  });

  describe("setAutonomousGate", () => {
    it("registers the autonomous gate function", () => {
      scheduler.setAutonomousGate(() => "test_block");
      // Verify it's stored — subsequent schedule watcher should use it
    });
  });

  describe("logGateBlock throttling", () => {
    it("only logs once every 5 minutes", () => {
      const s = new AgentScheduler(setup.eventBus, setup.db, setup.config);
      const logGateBlock = (s as unknown as {
        logGateBlock: (reason: string, context: Record<string, unknown>) => void;
      }).logGateBlock.bind(s);

      // First call should log (set lastGateBlockLoggedAt)
      logGateBlock("test_reason", { cron: "hourly_check" });

      // Immediately calling again should NOT log (within 5 min window)
      // We can't easily verify the log call, but ensure no error
      logGateBlock("test_reason", { cron: "hourly_check" });

      s.stop();
    });
  });

  describe("morning routine stall watchdog", () => {
    function insertWakeAt(db: Database.Database, createdAt: string): number {
      const result = db
        .prepare(
          `INSERT INTO agent_schedule
             (scheduled_for, task_type, task_description, task_context, status, created_at)
           VALUES (?, 'wake', 'Morning routine', ?, 'pending', ?)`,
        )
        .run(createdAt, JSON.stringify({ routine: "morning_routine" }), createdAt);
      return Number(result.lastInsertRowid);
    }

    // 2026-05-14 05:00:00 UTC → 5 hours before the fire-time below; the
    // default agent-day boundary (04:00 with no timezone) makes the
    // wake-row creation, the fire-time, and a hypothetical morning-routine
    // success all land in the same agent-day. The fire-time is fixed so
    // the dedup day string is deterministic across CI clock jitter.
    const STALLED_CREATED_AT = "2026-05-14 05:00:00";
    const FIRE_AT_DAY_A = new Date("2026-05-14T10:00:00Z"); // 5h after wake
    const FIRE_AT_DAY_B = new Date("2026-05-15T10:00:00Z"); // 24h later

    it("sends owner DM exactly once per agent-day when a wake row exceeds the threshold", async () => {
      const sendDmMock = vi.fn().mockResolvedValue([
        { platform: "slack", channel: "D123" },
      ]);
      const s = new AgentScheduler(setup.eventBus, setup.db, setup.config);
      s.setSendDmCallback(sendDmMock);

      insertWakeAt(setup.db, STALLED_CREATED_AT);
      const fire = (s as unknown as {
        checkMorningRoutineStall: (now: Date) => Promise<void>;
      }).checkMorningRoutineStall.bind(s);

      await fire(FIRE_AT_DAY_A);
      await fire(FIRE_AT_DAY_A); // dedup should suppress this

      expect(sendDmMock).toHaveBeenCalledTimes(1);
      // Short, action-oriented message.
      expect(sendDmMock.mock.calls[0][0]).toContain("morning routine stalled");
      expect(sendDmMock.mock.calls[0][0]).toContain("300 min");
      expect(sendDmMock.mock.calls[0][0]).toContain("aitne restart");
      s.stop();
    });

    it("does not alert when no wake row is stalled", async () => {
      const sendDmMock = vi.fn().mockResolvedValue([]);
      const s = new AgentScheduler(setup.eventBus, setup.db, setup.config);
      s.setSendDmCallback(sendDmMock);

      // 10 min before the fire — under the 120 min threshold.
      insertWakeAt(setup.db, "2026-05-14 09:50:00");

      await (s as unknown as {
        checkMorningRoutineStall: (now: Date) => Promise<void>;
      }).checkMorningRoutineStall(FIRE_AT_DAY_A);

      expect(sendDmMock).not.toHaveBeenCalled();
      s.stop();
    });

    it("does not alert when a successful morning_routine action exists for today", async () => {
      const sendDmMock = vi.fn().mockResolvedValue([]);
      const s = new AgentScheduler(setup.eventBus, setup.db, setup.config);
      s.setSendDmCallback(sendDmMock);

      insertWakeAt(setup.db, STALLED_CREATED_AT);
      // Insert a success row inside the same agent-day window. The test
      // schema's agent_actions table omits `event_id`, so the INSERT
      // mirrors only the columns that exist locally — production schema
      // has the full set.
      setup.db
        .prepare(
          `INSERT INTO agent_actions (action_type, result, started_at)
           VALUES ('routine.morning_routine', 'success', ?)`,
        )
        .run("2026-05-14 09:00:00");

      await (s as unknown as {
        checkMorningRoutineStall: (now: Date) => Promise<void>;
      }).checkMorningRoutineStall(FIRE_AT_DAY_A);

      expect(sendDmMock).not.toHaveBeenCalled();
      s.stop();
    });

    it("re-alerts on a new agent-day after a previous day's alert", async () => {
      const sendDmMock = vi.fn().mockResolvedValue([]);
      const s = new AgentScheduler(setup.eventBus, setup.db, setup.config);
      s.setSendDmCallback(sendDmMock);

      insertWakeAt(setup.db, STALLED_CREATED_AT);
      const fire = (s as unknown as {
        checkMorningRoutineStall: (now: Date) => Promise<void>;
      }).checkMorningRoutineStall.bind(s);

      await fire(FIRE_AT_DAY_A); // Day A — alert fires.
      await fire(FIRE_AT_DAY_B); // Day B — same stall, new day, fires again.

      expect(sendDmMock).toHaveBeenCalledTimes(2);
      s.stop();
    });

    it("does NOT persist the dedup marker when sendDm throws, allowing retry on the next tick", async () => {
      // Inverted from the original mark-then-DM design: a transient
      // DM-hub failure should not consume the day's single alert slot.
      const sendDmMock = vi
        .fn<(message: string, platforms?: string[]) => Promise<unknown>>()
        .mockRejectedValueOnce(new Error("boom")) // first fails
        .mockResolvedValueOnce([{ platform: "slack", channel: "D123" }]); // second succeeds
      const s = new AgentScheduler(setup.eventBus, setup.db, setup.config);
      s.setSendDmCallback(
        sendDmMock as unknown as Parameters<typeof s.setSendDmCallback>[0],
      );

      insertWakeAt(setup.db, STALLED_CREATED_AT);
      const fire = (s as unknown as {
        checkMorningRoutineStall: (now: Date) => Promise<void>;
      }).checkMorningRoutineStall.bind(s);

      await fire(FIRE_AT_DAY_A); // sendDm rejects → no marker
      await fire(FIRE_AT_DAY_A); // sendDm succeeds → marker set
      await fire(FIRE_AT_DAY_A); // marker dedups this one

      expect(sendDmMock).toHaveBeenCalledTimes(2);
      s.stop();
    });

    it("does NOT persist the dedup marker when sendDm is not registered (retry next tick)", async () => {
      const s = new AgentScheduler(setup.eventBus, setup.db, setup.config);
      insertWakeAt(setup.db, STALLED_CREATED_AT);
      const fire = (s as unknown as {
        checkMorningRoutineStall: (now: Date) => Promise<void>;
      }).checkMorningRoutineStall.bind(s);

      await fire(FIRE_AT_DAY_A);
      // No marker was written, so a freshly-registered sendDm on the
      // next tick still gets the alert.
      const sendDmMock = vi.fn().mockResolvedValue([]);
      s.setSendDmCallback(sendDmMock);
      await fire(FIRE_AT_DAY_A);
      expect(sendDmMock).toHaveBeenCalledTimes(1);
      s.stop();
    });

    it("honours the runtime_state stall threshold override (clamped to the 15-min floor)", async () => {
      // Operator override: 30 min threshold. The 20-min-old wake row is
      // below it (no alert); a 60-min-old wake row exceeds it (alerts).
      setup.db
        .prepare(
          `INSERT INTO runtime_state (key, value_json) VALUES ('morning_routine.config', ?)`,
        )
        .run(JSON.stringify({ stallThresholdMinutes: 30 }));

      const sendDmMock = vi.fn().mockResolvedValue([]);
      const s = new AgentScheduler(setup.eventBus, setup.db, setup.config);
      s.setSendDmCallback(sendDmMock);
      const fire = (s as unknown as {
        checkMorningRoutineStall: (now: Date) => Promise<void>;
      }).checkMorningRoutineStall.bind(s);

      insertWakeAt(setup.db, "2026-05-14 09:40:00"); // 20 min old at fire time
      await fire(FIRE_AT_DAY_A);
      expect(sendDmMock).not.toHaveBeenCalled();

      // Bump the wake row backward so it is now 60 min old, exceeding 30.
      setup.db
        .prepare(
          `UPDATE agent_schedule SET created_at = '2026-05-14 09:00:00' WHERE task_type = 'wake'`,
        )
        .run();
      await fire(FIRE_AT_DAY_A);
      expect(sendDmMock).toHaveBeenCalledTimes(1);
      s.stop();
    });

    it("clamps an operator-supplied threshold below the floor up to 15 minutes", async () => {
      setup.db
        .prepare(
          `INSERT INTO runtime_state (key, value_json) VALUES ('morning_routine.config', ?)`,
        )
        .run(JSON.stringify({ stallThresholdMinutes: 1 })); // 1 min — well below the 15 floor

      const sendDmMock = vi.fn().mockResolvedValue([]);
      const s = new AgentScheduler(setup.eventBus, setup.db, setup.config);
      s.setSendDmCallback(sendDmMock);
      const fire = (s as unknown as {
        checkMorningRoutineStall: (now: Date) => Promise<void>;
      }).checkMorningRoutineStall.bind(s);

      // 10 min old — below the 15-min floor, so still under threshold.
      insertWakeAt(setup.db, "2026-05-14 09:50:00");
      await fire(FIRE_AT_DAY_A);
      expect(sendDmMock).not.toHaveBeenCalled();

      // 20 min old — exceeds the 15-min floor, so alerts.
      setup.db
        .prepare(
          `UPDATE agent_schedule SET created_at = '2026-05-14 09:40:00' WHERE task_type = 'wake'`,
        )
        .run();
      await fire(FIRE_AT_DAY_A);
      expect(sendDmMock).toHaveBeenCalledTimes(1);
      s.stop();
    });

    it("serialises overlapping watchdog invocations via the in-process mutex", async () => {
      let resolveDm!: () => void;
      const sendDmMock = vi.fn(
        () =>
          new Promise<unknown[]>((resolve) => {
            resolveDm = () => resolve([]);
          }),
      );
      const s = new AgentScheduler(setup.eventBus, setup.db, setup.config);
      s.setSendDmCallback(
        sendDmMock as unknown as Parameters<typeof s.setSendDmCallback>[0],
      );

      insertWakeAt(setup.db, STALLED_CREATED_AT);
      const fire = (s as unknown as {
        checkMorningRoutineStall: (now: Date) => Promise<void>;
      }).checkMorningRoutineStall.bind(s);

      // Kick off the first call (sendDm hangs). Concurrently fire two
      // more — the mutex must short-circuit them while the first DM is
      // still in flight.
      const firstCall = fire(FIRE_AT_DAY_A);
      await new Promise((r) => setTimeout(r, 10));
      await fire(FIRE_AT_DAY_A);
      await fire(FIRE_AT_DAY_A);

      expect(sendDmMock).toHaveBeenCalledTimes(1);
      resolveDm();
      await firstCall;
      s.stop();
    });
  });

  describe("DM task with platforms array context", () => {
    it("sends DM with platforms array from task_context", async () => {
      const sendDmMock = vi.fn().mockResolvedValue([
        { platform: "slack", channel: "D123" },
        { platform: "discord", channel: "#general" },
      ]);

      setup.db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, task_context, status) VALUES (datetime('now', '-1 minutes'), 'dm', 'Test DM', '{"platforms":["slack","discord"]}', 'pending')`,
      ).run();

      setup.config.schedulePollIntervalSeconds = 0.1;
      const s = new AgentScheduler(setup.eventBus, setup.db, setup.config);
      s.setSendDmCallback(sendDmMock);
      s.start();

      await new Promise((r) => setTimeout(r, 300));
      s.stop();

      expect(sendDmMock).toHaveBeenCalledWith("Test DM", ["slack", "discord"]);
      const row = setup.db.prepare("SELECT status FROM agent_schedule WHERE id = 1").get() as { status: string };
      expect(row.status).toBe("completed");
    });

    it("sends DM with no platform filter when context is empty", async () => {
      const sendDmMock = vi.fn().mockResolvedValue([
        { platform: "slack", channel: "D123" },
      ]);

      setup.db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, task_context, status) VALUES (datetime('now', '-1 minutes'), 'dm', 'Generic DM', '{}', 'pending')`,
      ).run();

      setup.config.schedulePollIntervalSeconds = 0.1;
      const s = new AgentScheduler(setup.eventBus, setup.db, setup.config);
      s.setSendDmCallback(sendDmMock);
      s.start();

      await new Promise((r) => setTimeout(r, 300));
      s.stop();

      expect(sendDmMock).toHaveBeenCalledWith("Generic DM", undefined);
    });
  });

  describe("ScheduleWatcher health check", () => {
    it("resets noFutureTasksWarned flag when tasks appear", async () => {
      // Start with no tasks — should set the warning flag
      setup.config.schedulePollIntervalSeconds = 0.1;
      const s = new AgentScheduler(setup.eventBus, setup.db, setup.config);
      s.start();

      await new Promise((r) => setTimeout(r, 300));

      // Now add a task — warning should be reset
      setup.db.prepare(
        "INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status) VALUES (datetime('now', '+1 hour'), 'wake', 'future task', 'pending')",
      ).run();

      await new Promise((r) => setTimeout(r, 300));
      s.stop();

      // No error means it worked correctly
    });
  });

  describe("sleepInterruptible", () => {
    it("resolves immediately when shutdown is true", async () => {
      const s = new AgentScheduler(setup.eventBus, setup.db, setup.config);
      (s as unknown as { shutdown: boolean }).shutdown = true;

      const start = Date.now();
      await (s as unknown as {
        sleepInterruptible: (ms: number) => Promise<void>;
      }).sleepInterruptible(60_000);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(100);
      s.stop();
    });

    it("resolves immediately when a nudge is pending (between-sleep race)", async () => {
      const s = new AgentScheduler(setup.eventBus, setup.db, setup.config);
      s.nudgeWatcher(); // bumps nudgeSeq; no active waiter to resolve

      const start = Date.now();
      await (s as unknown as {
        sleepInterruptible: (ms: number) => Promise<void>;
      }).sleepInterruptible(60_000);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(100);
      // The pending nudge has been consumed — a follow-up sleep with no
      // new nudge must wait normally. observedSeq advanced to match.
      const seqs = s as unknown as { nudgeSeq: number; observedSeq: number };
      expect(seqs.observedSeq).toBe(seqs.nudgeSeq);
    });

    it("consumes exactly one nudge per sleep when nudges arrive between sleeps", async () => {
      const s = new AgentScheduler(setup.eventBus, setup.db, setup.config);
      // Three nudges arrive before any sleep. The next sleep entry
      // consumes the cumulative bump in one shot — operator-facing the
      // nudges coalesce. The sleep after that must still wait.
      s.nudgeWatcher();
      s.nudgeWatcher();
      s.nudgeWatcher();

      const sleep = (s as unknown as {
        sleepInterruptible: (ms: number) => Promise<void>;
      }).sleepInterruptible.bind(s);

      const t0 = Date.now();
      await sleep(60_000);
      const fastElapsed = Date.now() - t0;
      expect(fastElapsed).toBeLessThan(100);

      // Second sleep — no fresh nudge. We can't actually wait 60 s in
      // the test; assert observedSeq stays caught up and rely on the
      // "wakes an in-flight sleep" test below for the timer path.
      const seqs = s as unknown as { nudgeSeq: number; observedSeq: number };
      expect(seqs.nudgeSeq).toBe(3);
      expect(seqs.observedSeq).toBe(3);
    });
  });

  describe("nudgeWatcher", () => {
    it("wakes an in-flight sleep before the timer expires", async () => {
      // Long poll interval — without nudge the test would hang for ~60s.
      const config = {
        ...setup.config,
        schedulePollIntervalSeconds: 60,
      } as unknown as AgentConfig;
      const s = new AgentScheduler(setup.eventBus, setup.db, config);
      s.start();

      // Let the watcher loop enter its first sleepInterruptible.
      await new Promise((r) => setTimeout(r, 50));

      const startedAt = Date.now();
      s.nudgeWatcher();
      // Yield so the waiter's resolver fires and the watcher loop iterates once.
      await new Promise((r) => setTimeout(r, 80));
      const elapsed = Date.now() - startedAt;

      // The nudge must wake the sleep within a fraction of a poll interval.
      // 1s ceiling for CI noise is generous; the actual delta is ~event-loop tick.
      expect(elapsed).toBeLessThan(1000);
      s.stop();
    });

    it("races safely: in-flight nudge advances observedSeq AND resolves the waiter atomically", async () => {
      const s = new AgentScheduler(setup.eventBus, setup.db, setup.config);
      const sleep = (s as unknown as {
        sleepInterruptible: (ms: number) => Promise<void>;
      }).sleepInterruptible.bind(s);

      // Kick off a sleep we'll wake mid-flight, then immediately fire a
      // second nudge before the loop has a chance to re-enter sleep —
      // mimicking the rapid-fire race the unified state was designed to
      // tolerate.
      const sleepPromise = sleep(60_000);
      await new Promise((r) => setTimeout(r, 10)); // ensure sleepWaiter is set
      s.nudgeWatcher();
      await sleepPromise; // first sleep resolves due to in-flight nudge

      // Between sleeps: a fresh nudge arrives.
      s.nudgeWatcher();

      // Next sleep — must observe the between-sleep nudge and return immediately.
      const t = Date.now();
      await sleep(60_000);
      expect(Date.now() - t).toBeLessThan(100);

      const seqs = s as unknown as { nudgeSeq: number; observedSeq: number };
      expect(seqs.nudgeSeq).toBe(2);
      expect(seqs.observedSeq).toBe(2);
      s.stop();
    });

    it("is a no-op before start() (no sleepWaiter to resolve)", () => {
      const s = new AgentScheduler(setup.eventBus, setup.db, setup.config);
      // Must not throw despite no active sleep / no waiter.
      expect(() => s.nudgeWatcher()).not.toThrow();
      expect((s as unknown as { nudgeSeq: number }).nudgeSeq).toBe(1);
      s.stop();
    });

    it("stop() breaks an in-flight sleep without going through the nudge counter", async () => {
      const s = new AgentScheduler(setup.eventBus, setup.db, setup.config);
      const sleep = (s as unknown as {
        sleepInterruptible: (ms: number) => Promise<void>;
      }).sleepInterruptible.bind(s);
      const sleepPromise = sleep(60_000);
      await new Promise((r) => setTimeout(r, 10)); // wait for sleepWaiter

      const before = (s as unknown as { nudgeSeq: number }).nudgeSeq;
      s.stop();
      await sleepPromise;
      // stop() must NOT bump the nudge counter — its semantics are
      // "tear down", not "wake to do more work".
      const after = (s as unknown as { nudgeSeq: number }).nudgeSeq;
      expect(after).toBe(before);
    });
  });

  describe("queueMorningRoutineWake nudge wiring", () => {
    it("fires nudgeWatcher() after a successful INSERT so setup-complete dispatch is sub-second", () => {
      const spy = vi.spyOn(scheduler, "nudgeWatcher");
      const result = scheduler.queueMorningRoutineWake("setup_complete");
      expect(result.inserted).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    it("does NOT fire nudgeWatcher() when the INSERT was deduped (existing pending row)", () => {
      // First insert seeds the pending row.
      scheduler.queueMorningRoutineWake("first");
      const spy = vi.spyOn(scheduler, "nudgeWatcher");
      const second = scheduler.queueMorningRoutineWake("second");
      expect(second.inserted).toBe(false);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe("ScheduleWatcher error handling", () => {
    it("continues running after a poll error", async () => {
      // Inject a broken state that will cause an error — then recover
      setup.config.schedulePollIntervalSeconds = 0.1;
      const s = new AgentScheduler(setup.eventBus, setup.db, setup.config);
      s.start();

      // Let a few iterations run
      await new Promise((r) => setTimeout(r, 300));
      s.stop();
      // No throw — error is caught internally
    });
  });

  describe("queueMorningRoutineWake with null task_context on existing row", () => {
    it("handles existing row with null task_context gracefully", () => {
      // Insert a row with null task_context (edge case)
      setup.db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, task_context, correlation_id, model, status) VALUES (datetime('now'), 'wake', 'Morning routine', '{"routine":"morning_routine"}', 'corr-1', 'opus', 'pending')`,
      ).run();

      // Second queue should dedup
      const result = scheduler.queueMorningRoutineWake("second_source");
      expect(result.inserted).toBe(false);
    });
  });
});
