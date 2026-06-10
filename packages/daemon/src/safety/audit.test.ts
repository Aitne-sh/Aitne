import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEvent, EventPriority, type AgentResult } from "@aitne/shared";
import { applySchema } from "../db/schema.js";
import { AuditLogger, bangStatusToResult } from "./audit.js";
import type { MessageEvent } from "@aitne/shared";

describe("AuditLogger", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("logs successful actions", () => {
    const audit = new AuditLogger(db);
    const event = createEvent({
      type: "message.received",
      source: "slack",
      priority: EventPriority.HIGH,
    });

    audit.logAction({
      event,
      model: "claude-sonnet-4-6",
      costUsd: 0.01,
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      modelUsage: {},
      durationMs: 250,
      numTurns: 1,
      trigger: "reactive",
      contextUpdated: true,
    });

    const row = db
      .prepare(
        "SELECT model_used, cost_usd, context_updated FROM agent_actions LIMIT 1",
      )
      .get() as {
        model_used: string;
        cost_usd: number;
        context_updated: number;
      };

    expect(row.model_used).toBe("claude-sonnet-4-6");
    expect(row.cost_usd).toBe(0.01);
    expect(row.context_updated).toBe(1);
  });

  it("persists backend metadata when migrated schema is present", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pa-audit-"));
    try {
      applySchema(db);
      const audit = new AuditLogger(db);
      const event = createEvent({
        type: "routine.hourly_check",
        source: "cron",
        priority: EventPriority.NORMAL,
      });

      audit.logAction({
        event,
        model: "gpt-5.4",
        costUsd: 0.123,
        usage: {
          inputTokens: 1000,
          outputTokens: 250,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
        modelUsage: {
          "gpt-5.4": {
            inputTokens: 1000,
            outputTokens: 250,
            costUsd: 0.123,
          },
        } satisfies AgentResult["modelUsage"],
        durationMs: 800,
        numTurns: 2,
        trigger: "autonomous",
          backend: "codex",
        costSource: "hardcoded",
        contextUpdated: false,
      });

      const row = db
        .prepare(
          "SELECT backend, cost_source, model_usage_json FROM agent_actions LIMIT 1",
        )
        .get() as {
          backend: string | null;
          cost_source: string | null;
          model_usage_json: string | null;
        };

      expect(row.backend).toBe("codex");
      expect(row.cost_source).toBe("hardcoded");
      expect(row.model_usage_json).toContain("gpt-5.4");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("logSkip records a skipped event with reason", () => {
    const audit = new AuditLogger(db);
    const event = createEvent({
      type: "routine.hourly_check",
      source: "cron",
      priority: EventPriority.NORMAL,
    });

    audit.logSkip(event, "no_observations", "autonomous");

    const row = db
      .prepare(
        "SELECT action_type, result, error, trigger FROM agent_actions LIMIT 1",
      )
      .get() as {
        action_type: string;
        result: string;
        error: string;
        trigger: string;
      };

    expect(row.action_type).toBe("routine.hourly_check");
    expect(row.result).toBe("skipped");
    expect(row.error).toBe("no_observations");
    expect(row.trigger).toBe("autonomous");
  });

  it("logError records a failed event with error message", () => {
    const audit = new AuditLogger(db);
    const event = createEvent({
      type: "message.received",
      source: "slack",
      priority: EventPriority.HIGH,
    });

    audit.logError(event, new Error("quota exceeded"), "reactive");

    const row = db
      .prepare(
        "SELECT action_type, result, error, trigger FROM agent_actions LIMIT 1",
      )
      .get() as {
        action_type: string;
        result: string;
        error: string;
        trigger: string;
      };

    expect(row.action_type).toBe("message.received");
    expect(row.result).toBe("failed");
    expect(row.error).toBe("quota exceeded");
    expect(row.trigger).toBe("reactive");
  });

  it("logError persists duration / backend / failure shape when supplied", () => {
    const audit = new AuditLogger(db);
    const event = createEvent({
      type: "scheduled.task",
      source: "cron",
      priority: EventPriority.NORMAL,
    });

    audit.logError(
      event,
      new Error('Backend "claude" failed without fallback: quota:max_budget_usd — Reached maximum budget ($0.1)'),
      "autonomous",
      {
        durationMs: 59415,
        backendId: "claude",
        failureKind: "quota",
        failureCode: "max_budget_usd",
      },
    );

    const row = db
      .prepare(
        `SELECT result, duration_ms, backend, model_used, detail,
                started_at, completed_at, error
           FROM agent_actions LIMIT 1`,
      )
      .get() as {
        result: string;
        duration_ms: number;
        backend: string | null;
        model_used: string | null;
        detail: string | null;
        started_at: string;
        completed_at: string;
        error: string;
      };

    expect(row.result).toBe("failed");
    expect(row.duration_ms).toBe(59415);
    expect(row.backend).toBe("claude");
    expect(row.detail).toBe(
      JSON.stringify({ failureKind: "quota", failureCode: "max_budget_usd" }),
    );
    // started_at must precede completed_at by ~the duration so the
    // dashboard "Started" column reflects when the run actually began.
    const startedMs = Date.parse(`${row.started_at}Z`);
    const completedMs = Date.parse(`${row.completed_at}Z`);
    expect(completedMs - startedMs).toBeGreaterThanOrEqual(58_000);
    expect(completedMs - startedMs).toBeLessThanOrEqual(61_000);
    expect(row.error).toContain("max_budget_usd");
  });

  // daily-journal-daemon-write.md §4.11 — dailyWrite block lands on
  // both the success path (logAction) and the failure path (logError)
  // INSERT/UPSERT for Stage B's row, so a single atomic write carries
  // the discriminated outcome alongside the row's terminal result.
  it("logAction persists dailyWrite into detail JSON when supplied", () => {
    const audit = new AuditLogger(db);
    const event = createEvent({
      type: "routine.morning_routine_journal",
      source: "cron",
      priority: EventPriority.HIGH,
    });

    audit.logAction({
      event,
      model: "claude-haiku-4-5",
      costUsd: 0.05,
      usage: {
        inputTokens: 1000,
        outputTokens: 200,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      modelUsage: {},
      durationMs: 5000,
      numTurns: 1,
      trigger: "autonomous",
      dailyWrite: {
        ok: "partial",
        bytesWritten: 1234,
        wroteMode: "put",
        partialReason: "frontmatter_tag_missing",
      },
    });

    const row = db.prepare(`SELECT detail FROM agent_actions LIMIT 1`).get() as {
      detail: string | null;
    };
    expect(row.detail).not.toBeNull();
    const detail = JSON.parse(row.detail!) as { dailyWrite: unknown };
    expect(detail.dailyWrite).toEqual({
      ok: "partial",
      bytesWritten: 1234,
      wroteMode: "put",
      partialReason: "frontmatter_tag_missing",
    });
  });

  it("logError persists dailyWrite into detail JSON when supplied", () => {
    const audit = new AuditLogger(db);
    const event = createEvent({
      type: "routine.morning_routine_journal",
      source: "cron",
      priority: EventPriority.HIGH,
    });

    audit.logError(event, new Error("Stage B threw"), "autonomous", {
      durationMs: 1000,
      backendId: "claude",
      dailyWrite: { ok: false, reason: "write_failed" },
    });

    const row = db.prepare(`SELECT detail FROM agent_actions LIMIT 1`).get() as {
      detail: string | null;
    };
    expect(row.detail).not.toBeNull();
    const detail = JSON.parse(row.detail!) as { dailyWrite: unknown };
    expect(detail.dailyWrite).toEqual({ ok: false, reason: "write_failed" });
  });

  it("publishes persisted rows when a callback is configured", () => {
    const onRowInserted = vi.fn();
    const audit = new AuditLogger(db, { onRowInserted });

    const successEvent = createEvent({
      type: "message.received",
      source: "slack",
      priority: EventPriority.HIGH,
    });
    const skippedEvent = createEvent({
      type: "routine.hourly_check",
      source: "cron",
      priority: EventPriority.NORMAL,
    });
    const failedEvent = createEvent({
      type: "scheduled.task",
      source: "cron",
      priority: EventPriority.NORMAL,
    });

    audit.logAction({
      event: successEvent,
      model: "claude-sonnet-4-6",
      costUsd: 0.01,
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      modelUsage: {},
      durationMs: 250,
      numTurns: 1,
      trigger: "reactive",
    });
    audit.logSkip(skippedEvent, "no_observations", "autonomous");
    audit.logError(failedEvent, new Error("quota exceeded"), "autonomous");

    expect(onRowInserted).toHaveBeenCalledTimes(3);
    expect(onRowInserted).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        id: 1,
        action_type: "message.received",
        result: "success",
      }),
    );
    expect(onRowInserted).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        id: 2,
        action_type: "routine.hourly_check",
        result: "skipped",
        error: "no_observations",
      }),
    );
    expect(onRowInserted).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        id: 3,
        action_type: "scheduled.task",
        result: "failed",
        error: "quota exceeded",
      }),
    );
  });

  it("logAction does not throw when DB insert fails", () => {
    // Close the DB to force an error
    const brokenDb = new Database(":memory:");
    brokenDb.pragma("foreign_keys = ON");
    applySchema(brokenDb);
    const audit = new AuditLogger(brokenDb);
    brokenDb.close();

    const event = createEvent({
      type: "message.received",
      source: "slack",
      priority: EventPriority.HIGH,
    });

    // Should not throw — the error is caught and logged
    expect(() => {
      audit.logAction({
        event,
        model: "claude-sonnet-4-6",
        costUsd: 0.01,
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
        modelUsage: {},
        durationMs: 250,
        numTurns: 1,
        trigger: "reactive",
      });
    }).not.toThrow();
  });

  it("logSkip does not throw when DB insert fails", () => {
    const brokenDb = new Database(":memory:");
    brokenDb.pragma("foreign_keys = ON");
    applySchema(brokenDb);
    const audit = new AuditLogger(brokenDb);
    brokenDb.close();

    const event = createEvent({
      type: "routine.hourly_check",
      source: "cron",
      priority: EventPriority.NORMAL,
    });

    expect(() => {
      audit.logSkip(event, "test reason", "autonomous");
    }).not.toThrow();
  });

  it("logError does not throw when DB insert fails", () => {
    const brokenDb = new Database(":memory:");
    brokenDb.pragma("foreign_keys = ON");
    applySchema(brokenDb);
    const audit = new AuditLogger(brokenDb);
    brokenDb.close();

    const event = createEvent({
      type: "message.received",
      source: "slack",
      priority: EventPriority.HIGH,
    });

    expect(() => {
      audit.logError(event, new Error("test error"), "reactive");
    }).not.toThrow();
  });

  it("logAction defaults contextUpdated to false (0)", () => {
    const audit = new AuditLogger(db);
    const event = createEvent({
      type: "message.received",
      source: "slack",
      priority: EventPriority.HIGH,
    });

    audit.logAction({
      event,
      model: "claude-sonnet-4-6",
      costUsd: 0.01,
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      modelUsage: {},
      durationMs: 250,
      numTurns: 1,
      trigger: "reactive",
      // contextUpdated omitted — should default to false
    });

    const row = db
      .prepare("SELECT context_updated FROM agent_actions LIMIT 1")
      .get() as { context_updated: number };
    expect(row.context_updated).toBe(0);
  });

  it("persists advisorCallCount into agent_actions.advisor_call_count (migrated schema)", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pa-audit-advisor-"));
    try {
      applySchema(db);
      const audit = new AuditLogger(db);
      const event = createEvent({
        type: "message.received",
        source: "dashboard",
        priority: EventPriority.HIGH,
      });

      audit.logAction({
        event,
        model: "claude-sonnet-4-6",
        costUsd: 0.01,
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
        modelUsage: {},
        durationMs: 250,
        numTurns: 1,
        trigger: "reactive",
        backend: "claude",
        advisorCallCount: 3,
      });

      const row = db
        .prepare(
          "SELECT advisor_call_count FROM agent_actions LIMIT 1",
        )
        .get() as { advisor_call_count: number };
      expect(row.advisor_call_count).toBe(3);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("logAction advisorCallCount defaults to 0 when omitted (migrated schema)", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pa-audit-advisor-default-"));
    try {
      applySchema(db);
      const audit = new AuditLogger(db);
      const event = createEvent({
        type: "message.received",
        source: "dashboard",
        priority: EventPriority.HIGH,
      });

      audit.logAction({
        event,
        model: "claude-sonnet-4-6",
        costUsd: 0.01,
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
        modelUsage: {},
        durationMs: 250,
        numTurns: 1,
        trigger: "reactive",
        backend: "claude",
        // advisorCallCount omitted — should default to 0 at the audit layer
      });

      const row = db
        .prepare("SELECT advisor_call_count FROM agent_actions LIMIT 1")
        .get() as { advisor_call_count: number };
      expect(row.advisor_call_count).toBe(0);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("logAction clamps negative advisorCallCount to 0", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pa-audit-advisor-clamp-"));
    try {
      applySchema(db);
      const audit = new AuditLogger(db);
      const event = createEvent({
        type: "message.received",
        source: "dashboard",
        priority: EventPriority.HIGH,
      });

      audit.logAction({
        event,
        model: "claude-sonnet-4-6",
        costUsd: 0.01,
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
        modelUsage: {},
        durationMs: 250,
        numTurns: 1,
        trigger: "reactive",
        backend: "claude",
        advisorCallCount: -5,
      });

      const row = db
        .prepare("SELECT advisor_call_count FROM agent_actions LIMIT 1")
        .get() as { advisor_call_count: number };
      expect(row.advisor_call_count).toBe(0);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  describe("logAttachment (Phase 1 chat attachments)", () => {
    it("inserts a reactive inbound upload row tagged `attachment.upload.inbound`", () => {
      const audit = new AuditLogger(db);
      audit.logAttachment({
        direction: "inbound",
        attachmentId: "att-inbound-1",
        mimeType: "image/png",
        sizeBytes: 12_345,
        provenance: "user_dashboard",
        originalFilename: "screenshot.png",
      });
      const row = db
        .prepare(
          `SELECT event_id, action_type, trigger, result, detail
           FROM agent_actions WHERE action_type = 'attachment.upload.inbound'`,
        )
        .get() as {
          event_id: string;
          action_type: string;
          trigger: string;
          result: string;
          detail: string;
        };
      expect(row.event_id).toBe("att-inbound-1");
      expect(row.trigger).toBe("reactive");
      expect(row.result).toBe("success");
      const detail = JSON.parse(row.detail);
      expect(detail).toMatchObject({
        mimeType: "image/png",
        sizeBytes: 12_345,
        provenance: "user_dashboard",
        originalFilename: "screenshot.png",
      });
    });

    it("inserts an autonomous outbound row tagged `attachment.upload.outbound`", () => {
      const audit = new AuditLogger(db);
      audit.logAttachment({
        direction: "outbound",
        attachmentId: "att-outbound-1",
        mimeType: "application/pdf",
        sizeBytes: 40_000,
        provenance: "agent",
        originalFilename: "report.pdf",
      });
      const row = db
        .prepare(
          `SELECT action_type, trigger, result
           FROM agent_actions WHERE action_type = 'attachment.upload.outbound'`,
        )
        .get() as { action_type: string; trigger: string; result: string };
      expect(row).toMatchObject({
        action_type: "attachment.upload.outbound",
        trigger: "autonomous",
        result: "success",
      });
    });

    it("swallows DB failures so a broken audit never fails the upload", () => {
      const audit = new AuditLogger(db);
      db.close(); // subsequent writes throw
      // Must not throw — the user's upload already succeeded, the
      // caller only cares about the optional audit trail.
      expect(() =>
        audit.logAttachment({
          direction: "inbound",
          attachmentId: "x",
          mimeType: "image/png",
          sizeBytes: 1,
          provenance: "user_dashboard",
          originalFilename: "x.png",
        }),
      ).not.toThrow();
      // Reopen an in-memory DB so the outer afterEach `db.close()` is a no-op.
      db = new Database(":memory:");
    });
  });

  describe("logBangCommand (messaging-bang-commands.md §6.6)", () => {
    function makeBangEvent(): MessageEvent {
      return {
        type: "message.received",
        source: "slack",
        priority: 1 as MessageEvent["priority"],
        timestamp: new Date(),
        data: {},
        correlationId: "corr-99",
        sender: "owner",
        channel: "D1",
        content: "!stop",
        platform: "telegram",
        threadId: null,
        isDm: true,
        isMention: false,
      };
    }

    it("inserts a bang_command row with mapped result and detail JSON", () => {
      const audit = new AuditLogger(db);
      audit.logBangCommand(makeBangEvent(), {
        command: "!stop",
        status: "ok",
        prevPaused: false,
        nextPaused: true,
      });
      const row = db
        .prepare(
          `SELECT event_id, action_type, trigger, result, detail
           FROM agent_actions`,
        )
        .get() as {
        event_id: string;
        action_type: string;
        trigger: string;
        result: string;
        detail: string;
      };
      expect(row.event_id).toBe("corr-99");
      expect(row.action_type).toBe("bang_command");
      expect(row.trigger).toBe("reactive");
      expect(row.result).toBe("success");
      const detail = JSON.parse(row.detail);
      expect(detail).toMatchObject({
        command: "!stop",
        status: "ok",
        platform: "telegram",
        prevPaused: false,
        nextPaused: true,
      });
    });

    it("maps paused_decline to result='skipped'", () => {
      const audit = new AuditLogger(db);
      audit.logBangCommand(makeBangEvent(), {
        command: "(non-command)",
        status: "paused_decline",
      });
      const row = db
        .prepare("SELECT result FROM agent_actions")
        .get() as { result: string };
      expect(row.result).toBe("skipped");
    });

    it("maps unknown to result='failed'", () => {
      const audit = new AuditLogger(db);
      audit.logBangCommand(makeBangEvent(), {
        command: "!banana",
        status: "unknown",
      });
      const row = db
        .prepare("SELECT result FROM agent_actions")
        .get() as { result: string };
      expect(row.result).toBe("failed");
    });

    it("emits onRowInserted for the new bang_command row", () => {
      const onRowInserted = vi.fn();
      const audit = new AuditLogger(db, { onRowInserted });
      audit.logBangCommand(makeBangEvent(), {
        command: "!stop",
        status: "ok",
      });
      expect(onRowInserted).toHaveBeenCalledTimes(1);
      const row = onRowInserted.mock.calls[0]?.[0];
      expect(row.action_type).toBe("bang_command");
    });

    it("swallows DB errors and logs them", () => {
      const audit = new AuditLogger(db);
      // Closing the DB makes subsequent prepare() throw — we must not
      // propagate the error to the caller.
      db.close();
      expect(() =>
        audit.logBangCommand(makeBangEvent(), {
          command: "!stop",
          status: "ok",
        }),
      ).not.toThrow();
      // Reopen so the outer afterEach close is a no-op.
      db = new Database(":memory:");
    });
  });

  describe("bangStatusToResult", () => {
    it("maps every status variant", () => {
      expect(bangStatusToResult("ok")).toBe("success");
      expect(bangStatusToResult("unknown")).toBe("failed");
      expect(bangStatusToResult("skipped")).toBe("skipped");
      expect(bangStatusToResult("paused_decline")).toBe("skipped");
    });
  });

  it("logError detail contains only failureKind when failureCode is omitted", () => {
    const audit = new AuditLogger(db);
    const event = createEvent({
      type: "scheduled.task",
      source: "cron",
      priority: EventPriority.NORMAL,
    });

    audit.logError(event, new Error("only kind"), "autonomous", {
      failureKind: "quota",
    });

    const row = db
      .prepare("SELECT detail FROM agent_actions LIMIT 1")
      .get() as { detail: string | null };
    expect(JSON.parse(row.detail!)).toEqual({ failureKind: "quota" });
  });

  it("logError detail contains only failureCode when failureKind is omitted", () => {
    const audit = new AuditLogger(db);
    const event = createEvent({
      type: "scheduled.task",
      source: "cron",
      priority: EventPriority.NORMAL,
    });

    audit.logError(event, new Error("only code"), "autonomous", {
      failureCode: "max_budget_usd",
    });

    const row = db
      .prepare("SELECT detail FROM agent_actions LIMIT 1")
      .get() as { detail: string | null };
    expect(JSON.parse(row.detail!)).toEqual({ failureCode: "max_budget_usd" });
  });

  it("logError persists modelId into model_used when supplied", () => {
    const audit = new AuditLogger(db);
    const event = createEvent({
      type: "scheduled.task",
      source: "cron",
      priority: EventPriority.NORMAL,
    });

    audit.logError(event, new Error("budget overrun"), "autonomous", {
      durationMs: 1234,
      backendId: "claude",
      modelId: "claude-sonnet-4-6",
      failureKind: "quota",
      failureCode: "max_budget_usd",
    });

    const row = db
      .prepare(
        `SELECT result, duration_ms, backend, model_used, detail, error
           FROM agent_actions LIMIT 1`,
      )
      .get() as {
        result: string;
        duration_ms: number;
        backend: string | null;
        model_used: string | null;
        detail: string | null;
        error: string;
      };

    expect(row.result).toBe("failed");
    expect(row.duration_ms).toBe(1234);
    expect(row.backend).toBe("claude");
    expect(row.model_used).toBe("claude-sonnet-4-6");
    expect(row.error).toBe("budget overrun");
    expect(JSON.parse(row.detail!)).toEqual({
      failureKind: "quota",
      failureCode: "max_budget_usd",
    });
  });

  it("logAction tags wiki.* events with source_kind/source_ref from event.data.workspace", () => {
    const audit = new AuditLogger(db);
    const event = createEvent({
      type: "wiki.compile",
      source: "cron",
      priority: EventPriority.NORMAL,
      data: { workspace: "obsidian-primary" },
    });
    audit.logAction({
      event,
      model: "claude-sonnet-4-6",
      costUsd: 0.05,
      usage: {
        inputTokens: 200,
        outputTokens: 50,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      modelUsage: {},
      durationMs: 500,
      numTurns: 2,
      trigger: "autonomous",
    });
    const row = db
      .prepare("SELECT source_kind, source_ref FROM agent_actions LIMIT 1")
      .get() as { source_kind: string | null; source_ref: string | null };
    expect(row.source_kind).toBe("wiki");
    expect(row.source_ref).toBe("obsidian-primary");
  });

  it("logAction tags wiki.* events with source_ref=null when workspace is not a string", () => {
    // Pins the inverse of the `typeof === "string"` ternary — source_ref
    // must fall back to null rather than coercing a non-string value.
    const audit = new AuditLogger(db);
    const event = createEvent({
      type: "wiki.compile",
      source: "cron",
      priority: EventPriority.NORMAL,
      data: { workspace: 42 },
    });
    audit.logAction({
      event,
      model: "claude-sonnet-4-6",
      costUsd: 0.05,
      usage: {
        inputTokens: 200,
        outputTokens: 50,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      modelUsage: {},
      durationMs: 500,
      numTurns: 2,
      trigger: "autonomous",
    });
    const row = db
      .prepare("SELECT source_kind, source_ref FROM agent_actions LIMIT 1")
      .get() as { source_kind: string | null; source_ref: string | null };
    expect(row.source_kind).toBe("wiki");
    expect(row.source_ref).toBeNull();
  });

  it("logAction persists detail.prePass when a pre-pass success payload is supplied", () => {
    // Mirrors the logError prePass test below — the metrics aggregator
    // filters on detail.prePass being a non-null object regardless of
    // result, so the success-path payload must round-trip too.
    const audit = new AuditLogger(db);
    const event = createEvent({
      type: "routine.fetch_window",
      source: "cron",
      priority: EventPriority.NORMAL,
    });
    audit.logAction({
      event,
      model: "claude-haiku-4-5",
      costUsd: 0.002,
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      modelUsage: {},
      durationMs: 250,
      numTurns: 1,
      trigger: "autonomous",
      backend: "claude",
      prePass: {
        parentCorrelationId: "parent-corr-success",
        parentRoutine: "routine.morning_routine_today",
        integrationKey: "gmail",
        attempt: 1,
        maxAttempts: 2,
        retriedFromAttempt: null,
        status: "success",
        fetched: 12,
        posted: 12,
        duplicates: 0,
        errors: [],
        willRetry: false,
        retryReason: "",
        fallbackTriggered: true,
        requestedBackend: "claude",
      },
    });
    const row = db
      .prepare("SELECT detail FROM agent_actions LIMIT 1")
      .get() as { detail: string | null };
    const parsed = JSON.parse(row.detail!) as Record<string, unknown>;
    expect(parsed.prePass).toMatchObject({
      parentCorrelationId: "parent-corr-success",
      parentRoutine: "routine.morning_routine_today",
      integrationKey: "gmail",
      status: "success",
      fetched: 12,
      posted: 12,
      fallbackTriggered: true,
      requestedBackend: "claude",
    });
  });

  it("logAction prePass omits fallbackTriggered/requestedBackend when not supplied", () => {
    // Pins the inverse branches of the spread guards — neither optional
    // key should appear when the caller leaves them undefined.
    const audit = new AuditLogger(db);
    const event = createEvent({
      type: "routine.fetch_window",
      source: "cron",
      priority: EventPriority.NORMAL,
    });
    audit.logAction({
      event,
      model: "claude-haiku-4-5",
      costUsd: 0.001,
      usage: {
        inputTokens: 50,
        outputTokens: 20,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      modelUsage: {},
      durationMs: 100,
      numTurns: 1,
      trigger: "autonomous",
      prePass: {
        parentCorrelationId: "parent-corr-minimal",
        parentRoutine: "routine.hourly_check",
        integrationKey: "google_calendar",
        attempt: 1,
        maxAttempts: 1,
        retriedFromAttempt: null,
        status: "skipped",
        fetched: 0,
        posted: 0,
        duplicates: 0,
        errors: [],
        willRetry: false,
        retryReason: "freshness-skip",
      },
    });
    const row = db
      .prepare("SELECT detail FROM agent_actions LIMIT 1")
      .get() as { detail: string | null };
    const parsed = JSON.parse(row.detail!) as { prePass: Record<string, unknown> };
    expect(parsed.prePass).not.toHaveProperty("fallbackTriggered");
    expect(parsed.prePass).not.toHaveProperty("requestedBackend");
    expect(parsed.prePass.status).toBe("skipped");
  });

  it("logError prePass persists fallbackTriggered when supplied", () => {
    // Pins the fallbackTriggered spread guard's truthy arm in logError.
    // The existing prePass test only exercises requestedBackend.
    const audit = new AuditLogger(db);
    const event = createEvent({
      type: "routine.fetch_window",
      source: "cron",
      priority: EventPriority.NORMAL,
    });
    audit.logError(event, new Error("fallback fired"), "autonomous", {
      durationMs: 600,
      backendId: "claude",
      failureKind: "agent-execute-failed",
      prePass: {
        parentCorrelationId: "parent-corr-fb",
        parentRoutine: "routine.hourly_check",
        integrationKey: "notion",
        attempt: 2,
        maxAttempts: 2,
        retriedFromAttempt: 1,
        status: "failed",
        fetched: 0,
        posted: 0,
        duplicates: 0,
        errors: [{ kind: "agent-execute-failed" }],
        willRetry: false,
        retryReason: "max-attempts",
        fallbackTriggered: false,
      },
    });
    const row = db
      .prepare("SELECT detail FROM agent_actions LIMIT 1")
      .get() as { detail: string | null };
    const parsed = JSON.parse(row.detail!) as { prePass: Record<string, unknown> };
    expect(parsed.prePass.fallbackTriggered).toBe(false);
    expect(parsed.prePass).not.toHaveProperty("requestedBackend");
  });

  it("logError persists detail.prePass so MetricsCollector.collectPrePassMetrics sees the failure", () => {
    // Bug 005 regression — before the fix, fan-out failures wrote either
    // no row (binding-resolve / budget-cap / context-build) or a
    // failureKind-only row (agent-execute) that the aggregator skipped
    // because it filters on `detail.prePass` being a non-null object.
    const audit = new AuditLogger(db);
    const event = createEvent({
      type: "routine.fetch_window",
      source: "cron",
      priority: EventPriority.NORMAL,
    });
    audit.logError(event, new Error("execute boom"), "autonomous", {
      durationMs: 800,
      backendId: "claude",
      modelId: "claude-haiku-4-5",
      failureKind: "agent-execute-failed",
      prePass: {
        parentCorrelationId: "parent-corr-1",
        parentRoutine: "routine.hourly_check",
        integrationKey: "gmail",
        attempt: 1,
        maxAttempts: 1,
        retriedFromAttempt: null,
        status: "failed",
        fetched: 0,
        posted: 0,
        duplicates: 0,
        errors: [{ type: "pre-pass-failed", kind: "agent-execute-failed" }],
        willRetry: false,
        retryReason: "max-attempts",
        requestedBackend: "claude",
      },
    });

    const row = db
      .prepare("SELECT detail FROM agent_actions LIMIT 1")
      .get() as { detail: string | null };
    const parsed = JSON.parse(row.detail!) as Record<string, unknown>;
    expect(parsed.failureKind).toBe("agent-execute-failed");
    expect(parsed.prePass).toMatchObject({
      parentCorrelationId: "parent-corr-1",
      parentRoutine: "routine.hourly_check",
      integrationKey: "gmail",
      attempt: 1,
      status: "failed",
      willRetry: false,
      retryReason: "max-attempts",
      requestedBackend: "claude",
    });
  });

  it("emitInsertedRow swallows errors when the post-insert SELECT throws", () => {
    const onRowInserted = vi.fn();
    const audit = new AuditLogger(db, { onRowInserted });

    const origPrepare = db.prepare.bind(db);
    const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("FROM agent_actions") && sql.includes("WHERE id = ?")) {
        throw new Error("simulated post-insert SELECT failure");
      }
      return origPrepare(sql);
    });

    try {
      const event = createEvent({
        type: "message.received",
        source: "slack",
        priority: EventPriority.HIGH,
      });

      expect(() => {
        audit.logAction({
          event,
          model: "claude-sonnet-4-6",
          costUsd: 0,
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
          },
          modelUsage: {},
          durationMs: 1,
          numTurns: 1,
          trigger: "reactive",
        });
      }).not.toThrow();

      // Inserted row exists despite the SELECT failure.
      prepareSpy.mockRestore();
      const inserted = db
        .prepare("SELECT COUNT(*) as n FROM agent_actions")
        .get() as { n: number };
      expect(inserted.n).toBe(1);
      // emitInsertedRow caught — no callback fires.
      expect(onRowInserted).not.toHaveBeenCalled();
    } finally {
      prepareSpy.mockRestore();
    }
  });

  // ── UPSERT semantics (morning-routine-optimization.md) ──

  describe("insertInProgressRow + logAction UPSERT", () => {
    it("insertInProgressRow lands a row with result='in_progress' and the supplied identity", () => {
      const audit = new AuditLogger(db);
      const id = audit.insertInProgressRow({
        correlationId: "morning-corr-1",
        actionType: "routine.morning_routine_today",
        trigger: "autonomous",
      });
      expect(id).toBeGreaterThan(0);
      const row = db
        .prepare(
          "SELECT event_id, action_type, trigger, result FROM agent_actions WHERE id = ?",
        )
        .get(id) as {
          event_id: string;
          action_type: string;
          trigger: string;
          result: string;
        };
      expect(row).toEqual({
        event_id: "morning-corr-1",
        action_type: "routine.morning_routine_today",
        trigger: "autonomous",
        result: "in_progress",
      });
    });

    it("logAction UPDATEs the in_progress row in-place rather than inserting a duplicate", () => {
      const audit = new AuditLogger(db);
      const inProgressId = audit.insertInProgressRow({
        correlationId: "morning-corr-2",
        actionType: "routine.morning_routine_today",
        trigger: "autonomous",
      });
      // Simulate the agent writing structured metadata mid-session.
      db.prepare(
        `UPDATE agent_actions SET metadata = ? WHERE id = ?`,
      ).run(
        JSON.stringify({ dayType: "weekday", anomalies: ["pre-pass partial"] }),
        inProgressId,
      );

      const event = createEvent({
        type: "routine.morning_routine_today",
        source: "cron",
        priority: EventPriority.HIGH,
        correlationId: "morning-corr-2",
      });
      audit.logAction({
        event,
        model: "claude-sonnet-4-6",
        costUsd: 0.32,
        usage: {
          inputTokens: 1200,
          outputTokens: 800,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
        modelUsage: {},
        durationMs: 1500,
        numTurns: 12,
        trigger: "autonomous",
      });

      // Exactly ONE row for (event_id, action_type) — the in_progress
      // sentinel was settled in place.
      const rows = db
        .prepare(
          `SELECT id, result, cost_usd, num_turns, metadata
             FROM agent_actions
            WHERE event_id = ? AND action_type = ?
            ORDER BY id`,
        )
        .all("morning-corr-2", "routine.morning_routine_today") as Array<{
        id: number;
        result: string;
        cost_usd: number;
        num_turns: number;
        metadata: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(inProgressId);
      expect(rows[0].result).toBe("success");
      expect(rows[0].cost_usd).toBe(0.32);
      expect(rows[0].num_turns).toBe(12);
      // Metadata preserved across the UPDATE.
      const metadata = JSON.parse(rows[0].metadata);
      expect(metadata).toEqual({
        dayType: "weekday",
        anomalies: ["pre-pass partial"],
      });
    });

    it("logAction INSERTs fresh when no in_progress row exists (legacy path unchanged)", () => {
      const audit = new AuditLogger(db);
      const event = createEvent({
        type: "routine.morning_routine_today",
        source: "cron",
        priority: EventPriority.HIGH,
        correlationId: "morning-corr-3",
      });
      audit.logAction({
        event,
        model: "claude-sonnet-4-6",
        costUsd: 0.1,
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
        modelUsage: {},
        durationMs: 200,
        numTurns: 3,
        trigger: "autonomous",
      });
      const rows = db
        .prepare(
          `SELECT result, metadata FROM agent_actions WHERE event_id = ?`,
        )
        .all("morning-corr-3") as { result: string; metadata: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].result).toBe("success");
      // Default `metadata` is '{}', not preserved from a non-existent
      // in_progress row.
      expect(JSON.parse(rows[0].metadata)).toEqual({});
    });

    it("logAction UPSERT settles the in_progress row even when dmFreshness flips on `detail` column inclusion", () => {
      // Exercise the UPDATE branch's `column === 'detail'` arm by
      // supplying dmFreshness, which causes logAction to emit a `detail`
      // column. Without coverage here the `detail = json(?)` UPDATE
      // assignment path goes untested.
      const audit = new AuditLogger(db);
      audit.insertInProgressRow({
        correlationId: "morning-corr-detail",
        actionType: "message.received.dm",
        trigger: "reactive",
      });
      const event = createEvent({
        type: "message.received.dm",
        source: "slack",
        priority: EventPriority.HIGH,
        correlationId: "morning-corr-detail",
      });
      audit.logAction({
        event,
        model: "claude-sonnet-4-6",
        costUsd: 0.05,
        usage: {
          inputTokens: 50,
          outputTokens: 30,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
        modelUsage: {},
        durationMs: 200,
        numTurns: 1,
        trigger: "reactive",
        dmFreshness: {
          resumed: true,
          agentLogLagMinutes: 5,
          loudWritesSinceSessionStart: 1,
          quietWritesSinceSessionStart: 0,
          refetchedToday: true,
          triggerMatched: true,
        },
      });
      const row = db
        .prepare(
          `SELECT result, detail FROM agent_actions WHERE event_id = ?`,
        )
        .get("morning-corr-detail") as { result: string; detail: string };
      expect(row.result).toBe("success");
      const detail = JSON.parse(row.detail);
      expect(detail.dm_freshness.resumed).toBe(true);
    });

    it("falls back to INSERT preserving the `detail` column when UPDATE fails on a dmFreshness-bearing call", () => {
      // Combines: pre-inserted in_progress row + simulated UPDATE
      // failure + dmFreshness on the logAction call so the fallback
      // INSERT exercises the `column === 'detail'` placeholder branch
      // (`json(?)` mapping). Without dmFreshness here, the fallback
      // INSERT skips the detail column and that branch goes untested.
      const audit = new AuditLogger(db);
      audit.insertInProgressRow({
        correlationId: "morning-corr-detail-fallback",
        actionType: "message.received.dm",
        trigger: "reactive",
      });
      const originalPrepare = db.prepare.bind(db);
      const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
        if (sql.trim().startsWith("UPDATE agent_actions SET")) {
          throw new Error("simulated UPDATE failure with detail");
        }
        return originalPrepare(sql);
      });
      try {
        const event = createEvent({
          type: "message.received.dm",
          source: "slack",
          priority: EventPriority.HIGH,
          correlationId: "morning-corr-detail-fallback",
        });
        audit.logAction({
          event,
          model: "claude-sonnet-4-6",
          costUsd: 0.05,
          usage: {
            inputTokens: 50,
            outputTokens: 30,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
          },
          modelUsage: {},
          durationMs: 200,
          numTurns: 1,
          trigger: "reactive",
          dmFreshness: {
            resumed: true,
            agentLogLagMinutes: 1,
            loudWritesSinceSessionStart: 0,
            quietWritesSinceSessionStart: 0,
            refetchedToday: false,
            triggerMatched: true,
          },
        });
      } finally {
        prepareSpy.mockRestore();
      }
      // Both the in_progress sentinel AND a fresh terminal INSERT exist;
      // the terminal row carries the detail JSON.
      const rows = db
        .prepare(
          `SELECT id, result, detail FROM agent_actions WHERE event_id = ? ORDER BY id`,
        )
        .all("morning-corr-detail-fallback") as Array<{
          id: number;
          result: string;
          detail: string | null;
        }>;
      expect(rows).toHaveLength(2);
      expect(rows[1].result).toBe("success");
      expect(rows[1].detail).not.toBeNull();
      expect(JSON.parse(rows[1].detail as string).dm_freshness.resumed).toBe(true);
    });

    it("falls back to INSERT when the UPDATE on the in_progress row fails", () => {
      // Simulate the UPDATE branch throwing (e.g. the in_progress row
      // was garbage-collected between SELECT and UPDATE). The fallback
      // INSERT must still land the terminal row so monitoring tooling
      // sees the run.
      const audit = new AuditLogger(db);
      const inProgressId = audit.insertInProgressRow({
        correlationId: "morning-corr-update-fail",
        actionType: "routine.morning_routine_today",
        trigger: "autonomous",
      });
      // Manually DELETE the row to simulate a janitor sweep so the
      // UPDATE statement's `WHERE id = ?` matches no rows; SQLite
      // doesn't throw on zero-row UPDATEs, so for a "throw fallback"
      // proof we stub the prepare call instead.
      const originalPrepare = db.prepare.bind(db);
      let updateCallCount = 0;
      const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
        if (sql.trim().startsWith("UPDATE agent_actions SET")) {
          updateCallCount += 1;
          if (updateCallCount === 1) {
            throw new Error("simulated UPDATE failure");
          }
        }
        return originalPrepare(sql);
      });
      try {
        const event = createEvent({
          type: "routine.morning_routine_today",
          source: "cron",
          priority: EventPriority.HIGH,
          correlationId: "morning-corr-update-fail",
        });
        audit.logAction({
          event,
          model: "claude-sonnet-4-6",
          costUsd: 0.1,
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
          },
          modelUsage: {},
          durationMs: 100,
          numTurns: 1,
          trigger: "autonomous",
        });
      } finally {
        prepareSpy.mockRestore();
      }
      // Two rows now: the in_progress sentinel (NOT settled because
      // UPDATE threw) + the fresh terminal INSERT.
      const rows = db
        .prepare(
          `SELECT id, result FROM agent_actions WHERE event_id = ? ORDER BY id`,
        )
        .all("morning-corr-update-fail") as { id: number; result: string }[];
      expect(rows).toHaveLength(2);
      expect(rows[0].id).toBe(inProgressId);
      expect(rows[0].result).toBe("in_progress");
      expect(rows[1].result).toBe("success");
    });

    it("insertInProgressRow swallows SQL failures and returns -1", () => {
      const audit = new AuditLogger(db);
      const originalPrepare = db.prepare.bind(db);
      const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
        if (sql.startsWith("INSERT INTO agent_actions")) {
          throw new Error("simulated insertInProgressRow failure");
        }
        return originalPrepare(sql);
      });
      try {
        const id = audit.insertInProgressRow({
          correlationId: "morning-corr-fail",
          actionType: "routine.morning_routine_today",
          trigger: "autonomous",
        });
        expect(id).toBe(-1);
      } finally {
        prepareSpy.mockRestore();
      }
    });

    it("insertInProgressRow attaches optional backend + modelId when supplied", () => {
      const audit = new AuditLogger(db);
      audit.insertInProgressRow({
        correlationId: "morning-corr-backend",
        actionType: "routine.morning_routine_today",
        trigger: "autonomous",
        backend: "claude",
        modelId: "claude-sonnet-4-6",
      });
      const row = db
        .prepare(
          `SELECT backend, model_used FROM agent_actions WHERE event_id = ?`,
        )
        .get("morning-corr-backend") as { backend: string; model_used: string };
      expect(row.backend).toBe("claude");
      expect(row.model_used).toBe("claude-sonnet-4-6");
    });

    it("findInProgressRowId returns null when the SELECT throws (treats as no row)", () => {
      const audit = new AuditLogger(db);
      const originalPrepare = db.prepare.bind(db);
      const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
        if (sql.trim().startsWith("SELECT id FROM agent_actions")) {
          throw new Error("simulated SELECT failure");
        }
        return originalPrepare(sql);
      });
      try {
        const event = createEvent({
          type: "routine.morning_routine_today",
          source: "cron",
          priority: EventPriority.HIGH,
          correlationId: "morning-corr-select-fail",
        });
        // logAction's findInProgressRowId call throws; the catch
        // returns null so logAction falls through to fresh INSERT.
        audit.logAction({
          event,
          model: "claude-sonnet-4-6",
          costUsd: 0.1,
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
          },
          modelUsage: {},
          durationMs: 100,
          numTurns: 1,
          trigger: "autonomous",
        });
      } finally {
        prepareSpy.mockRestore();
      }
      // One INSERT landed — no UPSERT happened because the lookup
      // returned null.
      const rows = db
        .prepare(
          `SELECT COUNT(*) AS n FROM agent_actions WHERE event_id = ?`,
        )
        .get("morning-corr-select-fail") as { n: number };
      expect(rows.n).toBe(1);
    });

    it("findInProgressRowId tolerates a null correlationId on the in_progress sentinel and matches by `event_id IS NULL`", () => {
      // Exercises the `correlationId ?? null` nullish-coalesce branch:
      // when a caller pre-inserts an in_progress row with no
      // correlationId, the lookup must still resolve via SQLite's NULL-
      // tolerant `IS` predicate so logAction settles in place.
      const audit = new AuditLogger(db);
      audit.insertInProgressRow({
        correlationId: null,
        actionType: "routine.morning_routine_today",
        trigger: "autonomous",
      });
      const event = {
        type: "routine.morning_routine_today" as const,
        source: "cron" as const,
        priority: EventPriority.HIGH,
        timestamp: new Date(),
        data: {},
        correlationId: null as unknown as string,
      };
      audit.logAction({
        event: event as unknown as ReturnType<typeof createEvent>,
        model: "claude-sonnet-4-6",
        costUsd: 0.1,
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
        modelUsage: {},
        durationMs: 100,
        numTurns: 1,
        trigger: "autonomous",
      });
      const rows = db
        .prepare(
          `SELECT result FROM agent_actions WHERE event_id IS NULL AND action_type = ?`,
        )
        .all("routine.morning_routine_today") as { result: string }[];
      // Exactly one row — the in_progress sentinel was settled rather
      // than a parallel terminal row landing.
      expect(rows).toHaveLength(1);
      expect(rows[0].result).toBe("success");
    });

    it("logAction's UPSERT scope is keyed on (event_id, action_type) — does not collide with sibling action types", () => {
      const audit = new AuditLogger(db);
      // Pre-insert a Stage A in_progress sentinel.
      audit.insertInProgressRow({
        correlationId: "morning-corr-4",
        actionType: "routine.morning_routine_today",
        trigger: "autonomous",
      });
      // Now logAction for Stage B (different action_type) — should NOT
      // settle the Stage A row.
      const stageBEvent = createEvent({
        type: "routine.morning_routine_journal",
        source: "cron",
        priority: EventPriority.HIGH,
        correlationId: "morning-corr-4",
      });
      audit.logAction({
        event: stageBEvent,
        model: "claude-haiku-4-5",
        costUsd: 0.05,
        usage: {
          inputTokens: 50,
          outputTokens: 30,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
        modelUsage: {},
        durationMs: 100,
        numTurns: 2,
        trigger: "autonomous",
      });
      const rows = db
        .prepare(
          `SELECT action_type, result FROM agent_actions WHERE event_id = ? ORDER BY id`,
        )
        .all("morning-corr-4") as { action_type: string; result: string }[];
      expect(rows).toEqual([
        { action_type: "routine.morning_routine_today", result: "in_progress" },
        { action_type: "routine.morning_routine_journal", result: "success" },
      ]);
    });
  });

  // ── morning-routine failed-row fix — logError UPSERT semantics ────────
  //
  // The morning-routine pipeline orchestrator pre-inserts a
  // `result='in_progress'` row for Stage A. When Stage A throws (or any
  // other caller's stage rejects), `logError` must SETTLE the existing
  // sentinel rather than INSERT a parallel `result='failed'` row —
  // otherwise `loadMorningRoutineActionRows` (most-recent-row-wins on
  // (event_id, action_type)) reads whichever landed last and downstream
  // composers (`agent-journal-appender.formatJournalLine`,
  // `parent-audit-emitter.readStageSummaries`) get inconsistent shapes.
  // Mirrors the `logAction` UPSERT block above.
  describe("insertInProgressRow + logError UPSERT (morning-routine failed-row fix)", () => {
    it("logError UPDATEs the in_progress row in-place rather than inserting a duplicate", () => {
      const audit = new AuditLogger(db);
      const inProgressId = audit.insertInProgressRow({
        correlationId: "morning-fail-1",
        actionType: "routine.morning_routine_today",
        trigger: "autonomous",
      });
      // Simulate the agent writing structured metadata mid-session
      // before the throw — the UPSERT must preserve it (mirrors the
      // logAction UPSERT contract).
      db.prepare(
        `UPDATE agent_actions SET metadata = ? WHERE id = ?`,
      ).run(
        JSON.stringify({ dayType: "weekday", anomalies: ["pre-pass partial"] }),
        inProgressId,
      );

      const event = createEvent({
        type: "routine.morning_routine_today",
        source: "cron",
        priority: EventPriority.HIGH,
        correlationId: "morning-fail-1",
      });
      audit.logError(event, new Error("stage A boom"), "autonomous", {
        durationMs: 1500,
        backendId: "claude",
        modelId: "claude-sonnet-4-6",
        failureKind: "quota",
        failureCode: "max_budget_usd",
      });

      // Exactly ONE row for (event_id, action_type) — the in_progress
      // sentinel was settled to 'failed' in place.
      const rows = db
        .prepare(
          `SELECT id, result, error, duration_ms, backend, model_used, detail, metadata
             FROM agent_actions
            WHERE event_id = ? AND action_type = ?
            ORDER BY id`,
        )
        .all("morning-fail-1", "routine.morning_routine_today") as Array<{
        id: number;
        result: string;
        error: string;
        duration_ms: number;
        backend: string;
        model_used: string;
        detail: string;
        metadata: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(inProgressId);
      expect(rows[0].result).toBe("failed");
      expect(rows[0].error).toBe("stage A boom");
      expect(rows[0].duration_ms).toBe(1500);
      expect(rows[0].backend).toBe("claude");
      expect(rows[0].model_used).toBe("claude-sonnet-4-6");
      const detail = JSON.parse(rows[0].detail);
      expect(detail).toEqual({
        failureKind: "quota",
        failureCode: "max_budget_usd",
      });
      // Metadata preserved across the UPDATE — the agent's structured
      // PATCH side-channel survives the settle so `agent-journal-
      // appender` still sees `dayType` even on a Stage A failure.
      const metadata = JSON.parse(rows[0].metadata);
      expect(metadata).toEqual({
        dayType: "weekday",
        anomalies: ["pre-pass partial"],
      });
    });

    it("logError INSERTs fresh when no in_progress row exists (legacy path unchanged)", () => {
      const audit = new AuditLogger(db);
      const event = createEvent({
        type: "routine.morning_routine_journal",
        source: "cron",
        priority: EventPriority.HIGH,
        correlationId: "morning-fail-2",
      });
      audit.logError(event, new Error("stage B boom"), "autonomous", {
        durationMs: 250,
        backendId: "claude",
      });
      const rows = db
        .prepare(
          `SELECT id, result, error, backend FROM agent_actions
            WHERE event_id = ? AND action_type = ?
            ORDER BY id`,
        )
        .all("morning-fail-2", "routine.morning_routine_journal") as Array<{
        id: number;
        result: string;
        error: string;
        backend: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].result).toBe("failed");
      expect(rows[0].error).toBe("stage B boom");
      expect(rows[0].backend).toBe("claude");
    });

    it("falls back to INSERT when the UPDATE on the in_progress row fails", () => {
      // Mirrors the same defensive fall-through `logAction` has — if the
      // UPDATE branch fails (e.g. the row was garbage-collected between
      // SELECT and UPDATE), a fresh INSERT still records the failure
      // rather than dropping it on the floor.
      const audit = new AuditLogger(db);
      const inProgressId = audit.insertInProgressRow({
        correlationId: "morning-fail-update-fail",
        actionType: "routine.morning_routine_today",
        trigger: "autonomous",
      });
      const event = createEvent({
        type: "routine.morning_routine_today",
        source: "cron",
        priority: EventPriority.HIGH,
        correlationId: "morning-fail-update-fail",
      });

      const originalPrepare = db.prepare.bind(db);
      const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
        if (sql.startsWith("UPDATE agent_actions SET")) {
          throw new Error("simulated UPDATE failure");
        }
        return originalPrepare(sql);
      });
      try {
        audit.logError(event, new Error("stage A boom"), "autonomous", {
          durationMs: 800,
        });
      } finally {
        prepareSpy.mockRestore();
      }

      // Both rows now exist — the in_progress sentinel (unsettled) and a
      // fresh terminal 'failed' INSERT. The orphan sentinel survives but
      // `loadMorningRoutineActionRows` picks the latest row (the failed
      // INSERT) so the audit trail still surfaces the failure.
      const rows = db
        .prepare(
          `SELECT id, result FROM agent_actions WHERE event_id = ? ORDER BY id`,
        )
        .all("morning-fail-update-fail") as { id: number; result: string }[];
      expect(rows).toHaveLength(2);
      expect(rows[0].id).toBe(inProgressId);
      expect(rows[0].result).toBe("in_progress");
      expect(rows[1].result).toBe("failed");
    });
  });

  describe("agent_id stamping (AGENT_DEFINITIONS §8.1)", () => {
    function logOnce(audit: AuditLogger, correlationId?: string): void {
      const event = createEvent({
        type: "routine.morning_routine",
        source: "scheduler",
        priority: EventPriority.NORMAL,
        ...(correlationId ? { correlationId } : {}),
      });
      audit.logAction({
        event,
        model: "claude-sonnet-4-6",
        costUsd: 0.01,
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
        modelUsage: {},
        durationMs: 200,
        numTurns: 1,
        trigger: "autonomous",
        backend: "claude",
      });
    }

    function readAgentId(): string | null {
      const row = db
        .prepare("SELECT agent_id FROM agent_actions ORDER BY id DESC LIMIT 1")
        .get() as { agent_id: string | null };
      return row.agent_id;
    }

    it("leaves agent_id NULL when no resolver is wired", () => {
      const audit = new AuditLogger(db);
      logOnce(audit);
      expect(readAgentId()).toBeNull();
    });

    it("stamps agent_id from the resolver", () => {
      const audit = new AuditLogger(db);
      audit.setAgentIdResolver(() => "morning-routine");
      logOnce(audit);
      expect(readAgentId()).toBe("morning-routine");
    });

    it("leaves agent_id NULL when the resolver returns null", () => {
      const audit = new AuditLogger(db);
      audit.setAgentIdResolver(() => null);
      logOnce(audit);
      expect(readAgentId()).toBeNull();
    });

    it("stamps agent_id on a logSkip row when the resolver resolves one", () => {
      const audit = new AuditLogger(db);
      audit.setAgentIdResolver(() => "evening-review");
      const event = createEvent({
        type: "routine.evening_review",
        source: "scheduler",
        priority: EventPriority.NORMAL,
      });
      audit.logSkip(event, "morning_routine_pending_for_today", "autonomous");
      expect(readAgentId()).toBe("evening-review");
    });

    it("leaves agent_id NULL on a logSkip row when no Agent resolves", () => {
      const audit = new AuditLogger(db);
      audit.setAgentIdResolver(() => null);
      const event = createEvent({
        type: "routine.evening_review",
        source: "scheduler",
        priority: EventPriority.NORMAL,
      });
      audit.logSkip(event, "no_observations", "autonomous");
      expect(readAgentId()).toBeNull();
    });

    it("stamps agent_id on a logError row when the resolver resolves one", () => {
      const audit = new AuditLogger(db);
      audit.setAgentIdResolver(() => "morning-routine");
      const event = createEvent({
        type: "routine.morning_routine",
        source: "scheduler",
        priority: EventPriority.NORMAL,
      });
      audit.logError(event, new Error("stage A threw"), "autonomous");
      expect(readAgentId()).toBe("morning-routine");
    });

    it("carries agent_id through the in_progress UPSERT settle path", () => {
      const audit = new AuditLogger(db);
      audit.setAgentIdResolver(() => "morning-routine");
      const correlationId = "corr-upsert-agent";
      const inProgressId = audit.insertInProgressRow({
        correlationId,
        actionType: "routine.morning_routine",
        trigger: "autonomous",
      });
      expect(inProgressId).toBeGreaterThan(0);
      logOnce(audit, correlationId);
      const rows = db
        .prepare(
          "SELECT id, agent_id FROM agent_actions WHERE event_id = ?",
        )
        .all(correlationId) as { id: number; agent_id: string | null }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(inProgressId);
      expect(rows[0].agent_id).toBe("morning-routine");
    });
  });
});

describe("PREPASS_COST_REDUCTION_PLAN.md N1/N2/N3 audit extensions", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function makeRoutineEvent() {
    return createEvent({
      type: "routine.fetch_window",
      source: "cron",
      priority: EventPriority.NORMAL,
    });
  }

  it("logSkip persists the optional detail payload as JSON", () => {
    const audit = new AuditLogger(db);
    const event = makeRoutineEvent();
    audit.logSkip(event, "offline", "autonomous", {
      spawnGate: { backends: [{ backendId: "claude", offline: true }] },
    });
    const row = db
      .prepare("SELECT result, error, detail FROM agent_actions LIMIT 1")
      .get() as { result: string; error: string; detail: string };
    expect(row.result).toBe("skipped");
    expect(row.error).toBe("offline");
    const detail = JSON.parse(row.detail) as {
      spawnGate: { backends: Array<{ backendId: string; offline: boolean }> };
    };
    expect(detail.spawnGate.backends[0]).toMatchObject({
      backendId: "claude",
      offline: true,
    });
  });

  it("logSkip without detail keeps the legacy NULL detail shape", () => {
    const audit = new AuditLogger(db);
    audit.logSkip(makeRoutineEvent(), "no_observations", "autonomous");
    const row = db
      .prepare("SELECT detail FROM agent_actions LIMIT 1")
      .get() as { detail: string | null };
    expect(row.detail).toBeNull();
  });

  it("logError persists recovered spend fields (cost/tokens/turns/source)", () => {
    const audit = new AuditLogger(db);
    const event = makeRoutineEvent();
    audit.logError(event, new Error("agent-execute-failed"), "autonomous", {
      durationMs: 12_000,
      backendId: "claude",
      modelId: "claude-haiku-4-5-20251001",
      failureKind: "agent-execute-failed",
      costUsd: 0.5,
      costSource: "sdk_partial",
      tokensInput: 30_000,
      tokensOutput: 1_500,
      numTurns: 9,
    });
    const row = db
      .prepare(
        `SELECT result, cost_usd, cost_source, tokens_input, tokens_output, num_turns
         FROM agent_actions LIMIT 1`,
      )
      .get() as {
        result: string;
        cost_usd: number;
        cost_source: string;
        tokens_input: number;
        tokens_output: number;
        num_turns: number;
      };
    expect(row.result).toBe("failed");
    expect(row.cost_usd).toBeCloseTo(0.5, 4);
    expect(row.cost_source).toBe("sdk_partial");
    expect(row.tokens_input).toBe(30_000);
    expect(row.tokens_output).toBe(1_500);
    expect(row.num_turns).toBe(9);
  });

  it("logError persists cache-token spend fields into cache_creation_tokens / cache_read_tokens", () => {
    const audit = new AuditLogger(db);
    audit.logError(makeRoutineEvent(), new Error("budget kill"), "autonomous", {
      durationMs: 5_000,
      backendId: "claude",
      costUsd: 0.3,
      costSource: "sdk_partial",
      tokensInput: 1_000,
      tokensOutput: 200,
      tokensCacheCreation: 4_321,
      tokensCacheRead: 9_876,
      numTurns: 2,
    });
    const row = db
      .prepare(
        "SELECT result, cache_creation_tokens, cache_read_tokens FROM agent_actions LIMIT 1",
      )
      .get() as {
        result: string;
        cache_creation_tokens: number;
        cache_read_tokens: number;
      };
    expect(row.result).toBe("failed");
    expect(row.cache_creation_tokens).toBe(4_321);
    expect(row.cache_read_tokens).toBe(9_876);
  });

  it("logError without cache-token fields leaves cache columns NULL", () => {
    const audit = new AuditLogger(db);
    audit.logError(makeRoutineEvent(), new Error("boom"), "autonomous", {
      durationMs: 1_000,
      costUsd: 0.1,
      tokensInput: 500,
      tokensOutput: 50,
    });
    const row = db
      .prepare(
        "SELECT cache_creation_tokens, cache_read_tokens FROM agent_actions LIMIT 1",
      )
      .get() as {
        cache_creation_tokens: number | null;
        cache_read_tokens: number | null;
      };
    expect(row.cache_creation_tokens).toBeNull();
    expect(row.cache_read_tokens).toBeNull();
  });

  it("logError without spend fields leaves cost columns NULL (no fabricated values)", () => {
    const audit = new AuditLogger(db);
    audit.logError(makeRoutineEvent(), new Error("boom"), "autonomous", {
      durationMs: 1_000,
      failureKind: "context-build-failed",
    });
    const row = db
      .prepare("SELECT cost_usd, tokens_input, num_turns FROM agent_actions LIMIT 1")
      .get() as { cost_usd: number | null; tokens_input: number | null; num_turns: number | null };
    expect(row.cost_usd).toBeNull();
    expect(row.tokens_input).toBeNull();
    expect(row.num_turns).toBeNull();
  });

  it("logError settles an in_progress sentinel row with the spend fields (UPSERT path)", () => {
    const audit = new AuditLogger(db);
    const event = makeRoutineEvent();
    const id = audit.insertInProgressRow({
      correlationId: event.correlationId,
      actionType: event.type,
      trigger: "autonomous",
    });
    expect(id).toBeGreaterThan(0);
    audit.logError(event, new Error("late failure"), "autonomous", {
      costUsd: 0.25,
      costSource: "post_hoc_error",
      numTurns: 4,
    });
    const rows = db
      .prepare(
        "SELECT id, result, cost_usd, cost_source, num_turns FROM agent_actions WHERE event_id = ?",
      )
      .all(event.correlationId) as Array<{
        id: number;
        result: string;
        cost_usd: number | null;
        cost_source: string | null;
        num_turns: number | null;
      }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id,
      result: "failed",
      cost_source: "post_hoc_error",
      num_turns: 4,
    });
    expect(rows[0]?.cost_usd).toBeCloseTo(0.25, 4);
  });
});
