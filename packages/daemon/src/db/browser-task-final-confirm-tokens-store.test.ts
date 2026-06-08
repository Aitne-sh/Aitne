import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "./schema.js";
import {
  cancelLiteFinalConfirmToken,
  consumeLiteFinalConfirmToken,
  expireStaleLiteFinalConfirmTokens,
  getLiteFinalConfirmTokenByJti,
  getLiteFinalConfirmTokenByRaw,
  issueLiteFinalConfirmToken,
  listPendingLiteFinalConfirmTokens,
  listPendingLiteFinalConfirmTokensForChannel,
  scrubRotatedLiteFinalConfirmTokens,
  type IssueLiteFinalConfirmTokenInput,
} from "./browser-task-final-confirm-tokens-store.js";

let db: Database.Database;

/** A token row's FK requires a parent browser_task. */
function seedTask(id: string): void {
  db.prepare(
    `INSERT INTO browser_task
       (id, description, state, require_final_confirm, blocked_requests_count,
        extract_chars_total, created_at)
     VALUES (?, 'd', 'final_confirm', 1, 0, 0, 1)`,
  ).run(id);
}

function issueInput(
  overrides: Partial<IssueLiteFinalConfirmTokenInput> = {},
): IssueLiteFinalConfirmTokenInput {
  return {
    jti: overrides.jti ?? "jti-1",
    token: "!~aaaaaaaa",
    taskId: "task-1",
    actionSummary: "post hello to X",
    preScreenshotPath: "task-1/shot.png",
    deliveredChannels: ["slack:C1"],
    issuedAt: 1000,
    expiresAt: 1000 + 5 * 60_000,
    ...overrides,
  };
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  seedTask("task-1");
});

afterEach(() => {
  db.close();
});

describe("issueLiteFinalConfirmToken", () => {
  it("issues a pending token and round-trips by jti and by raw token", () => {
    const res = issueLiteFinalConfirmToken(db, issueInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.row).toMatchObject({
      jti: "jti-1",
      token: "!~aaaaaaaa",
      taskId: "task-1",
      deliveredChannels: ["slack:C1"],
      status: "pending",
      consumedAt: null,
      cancelledAt: null,
      cancelReason: null,
    });
    expect(getLiteFinalConfirmTokenByJti(db, "jti-1")).toEqual(res.row);
    expect(getLiteFinalConfirmTokenByRaw(db, "!~aaaaaaaa")).toEqual(res.row);
  });

  it("auto-generates a jti when none is supplied", () => {
    const res = issueLiteFinalConfirmToken(db, issueInput({ jti: undefined }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.row.jti).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("enforces per-task concurrency 1 — rejects a second live pending token", () => {
    issueLiteFinalConfirmToken(db, issueInput({ jti: "first" }));
    const second = issueLiteFinalConfirmToken(
      db,
      issueInput({ jti: "second", token: "!~bbbbbbbb" }),
    );
    expect(second).toEqual({ ok: false, reason: "pending_exists", pendingJti: "first" });
  });

  it("allows a fresh token once the prior pending token has passed its TTL", () => {
    issueLiteFinalConfirmToken(
      db,
      issueInput({ jti: "stale", issuedAt: 50, expiresAt: 100 }),
    );
    // New issue happens at 200 — the stale row's expires_at (100) is no longer
    // in the future, so it does not block.
    const res = issueLiteFinalConfirmToken(
      db,
      issueInput({ jti: "fresh", token: "!~cccccccc", issuedAt: 200, expiresAt: 500 }),
    );
    expect(res.ok).toBe(true);
  });

  it("reports a token_collision when the raw token already exists for another task", () => {
    seedTask("task-2");
    issueLiteFinalConfirmToken(db, issueInput({ jti: "a", taskId: "task-1" }));
    const collide = issueLiteFinalConfirmToken(
      db,
      issueInput({ jti: "b", taskId: "task-2", token: "!~aaaaaaaa" }),
    );
    expect(collide).toEqual({ ok: false, reason: "token_collision" });
  });
});

describe("fromDbRow delivered_channels resilience", () => {
  it("falls back to [] on malformed or non-array delivered_channels", () => {
    db.prepare(
      `INSERT INTO browser_task_final_confirm_tokens
         (jti, token, task_id, action_summary, pre_screenshot_path,
          delivered_channels, issued_at, expires_at, status)
       VALUES ('bad', '!~zz', 'task-1', 's', 'p', '{bad', 1, 2, 'pending')`,
    ).run();
    db.prepare(
      `INSERT INTO browser_task_final_confirm_tokens
         (jti, token, task_id, action_summary, pre_screenshot_path,
          delivered_channels, issued_at, expires_at, status)
       VALUES ('obj', '!~yy', 'task-1', 's', 'p', '{"a":1}', 1, 2, 'pending')`,
    ).run();
    expect(getLiteFinalConfirmTokenByJti(db, "bad")!.deliveredChannels).toEqual([]);
    expect(getLiteFinalConfirmTokenByJti(db, "obj")!.deliveredChannels).toEqual([]);
  });
});

describe("consumeLiteFinalConfirmToken (single-use CAS)", () => {
  it("confirms a live pending token exactly once", () => {
    issueLiteFinalConfirmToken(db, issueInput());
    const consumed = consumeLiteFinalConfirmToken(db, {
      jti: "jti-1",
      channelRef: "slack:C1",
      consumedAt: 2000,
      nowMs: 2000,
    });
    expect(consumed).toMatchObject({
      status: "confirmed",
      consumedAt: 2000,
      consumedViaChannel: "slack:C1",
    });
    // Second consume CAS-misses.
    expect(
      consumeLiteFinalConfirmToken(db, {
        jti: "jti-1",
        channelRef: "slack:C2",
        consumedAt: 2500,
        nowMs: 2500,
      }),
    ).toBeNull();
    expect(getLiteFinalConfirmTokenByJti(db, "jti-1")!.consumedViaChannel).toBe("slack:C1");
  });

  it("accepts consumption at exactly expires_at (>= boundary)", () => {
    issueLiteFinalConfirmToken(db, issueInput({ expiresAt: 4000 }));
    const consumed = consumeLiteFinalConfirmToken(db, {
      jti: "jti-1",
      channelRef: "slack:C1",
      consumedAt: 4000,
      nowMs: 4000,
    });
    expect(consumed).not.toBeNull();
  });

  it("refuses to consume an expired token", () => {
    issueLiteFinalConfirmToken(db, issueInput({ expiresAt: 4000 }));
    expect(
      consumeLiteFinalConfirmToken(db, {
        jti: "jti-1",
        channelRef: "slack:C1",
        consumedAt: 4001,
        nowMs: 4001,
      }),
    ).toBeNull();
  });

  it("refuses to consume a cancelled token", () => {
    issueLiteFinalConfirmToken(db, issueInput());
    cancelLiteFinalConfirmToken(db, {
      jti: "jti-1",
      reason: "explicit",
      cancelledAt: 1500,
      onlyIfPending: true,
    });
    expect(
      consumeLiteFinalConfirmToken(db, {
        jti: "jti-1",
        channelRef: "slack:C1",
        consumedAt: 1600,
        nowMs: 1600,
      }),
    ).toBeNull();
  });
});

describe("cancelLiteFinalConfirmToken", () => {
  it("cancels a pending token and records the reason", () => {
    issueLiteFinalConfirmToken(db, issueInput());
    const cancelled = cancelLiteFinalConfirmToken(db, {
      jti: "jti-1",
      reason: "user_reply",
      cancelledAt: 1500,
      onlyIfPending: true,
    });
    expect(cancelled).toMatchObject({
      status: "cancelled",
      cancelledAt: 1500,
      cancelReason: "user_reply",
    });
  });

  it("onlyIfPending refuses to cancel an already-consumed token", () => {
    issueLiteFinalConfirmToken(db, issueInput());
    consumeLiteFinalConfirmToken(db, {
      jti: "jti-1",
      channelRef: "slack:C1",
      consumedAt: 1500,
      nowMs: 1500,
    });
    expect(
      cancelLiteFinalConfirmToken(db, {
        jti: "jti-1",
        reason: "timeout",
        cancelledAt: 1600,
        onlyIfPending: true,
      }),
    ).toBeNull();
    // The non-onlyIfPending variant also only targets pending rows.
    expect(
      cancelLiteFinalConfirmToken(db, {
        jti: "jti-1",
        reason: "timeout",
        cancelledAt: 1600,
        onlyIfPending: false,
      }),
    ).toBeNull();
  });

  it("returns null for an unknown jti", () => {
    expect(
      cancelLiteFinalConfirmToken(db, {
        jti: "ghost",
        reason: "explicit",
        cancelledAt: 1,
        onlyIfPending: true,
      }),
    ).toBeNull();
  });
});

describe("listing helpers", () => {
  it("lists pending tokens for a channel, excluding terminal and other-channel rows", () => {
    issueLiteFinalConfirmToken(
      db,
      issueInput({ jti: "p1", token: "!~p1", deliveredChannels: ["slack:C1", "tg:9"] }),
    );
    issueLiteFinalConfirmToken(
      db,
      issueInput({ jti: "p2", token: "!~p2", deliveredChannels: ["slack:C2"], issuedAt: 1001, expiresAt: 600000 }),
    );
    // Consume p2 so it is no longer pending.
    consumeLiteFinalConfirmToken(db, { jti: "p2", channelRef: "slack:C2", consumedAt: 1002, nowMs: 1002 });

    const forC1 = listPendingLiteFinalConfirmTokensForChannel(db, "slack:C1", 1500);
    expect(forC1.map((r) => r.jti)).toEqual(["p1"]);
    expect(listPendingLiteFinalConfirmTokensForChannel(db, "slack:C2", 1500)).toEqual([]);
  });

  it("lists pending tokens ordered by issued_at DESC and honours the limit", () => {
    issueLiteFinalConfirmToken(db, issueInput({ jti: "old", token: "!~o", issuedAt: 100, expiresAt: 999999 }));
    seedTask("task-2");
    issueLiteFinalConfirmToken(
      db,
      issueInput({ jti: "new", token: "!~n", taskId: "task-2", issuedAt: 200, expiresAt: 999999 }),
    );
    const all = listPendingLiteFinalConfirmTokens(db, 150);
    expect(all.map((r) => r.jti)).toEqual(["new", "old"]);
    expect(listPendingLiteFinalConfirmTokens(db, 150, 1).map((r) => r.jti)).toEqual(["new"]);
  });
});

describe("retention sweeps", () => {
  it("expireStaleLiteFinalConfirmTokens flips past-TTL pending rows to expired/timeout", () => {
    issueLiteFinalConfirmToken(db, issueInput({ jti: "stale", expiresAt: 2000 }));
    seedTask("task-2");
    issueLiteFinalConfirmToken(
      db,
      issueInput({ jti: "live", token: "!~live", taskId: "task-2", expiresAt: 999999 }),
    );

    const expired = expireStaleLiteFinalConfirmTokens(db, 3000);
    expect(expired.map((r) => r.jti)).toEqual(["stale"]);
    const row = getLiteFinalConfirmTokenByJti(db, "stale")!;
    expect(row).toMatchObject({ status: "expired", cancelReason: "timeout", cancelledAt: 3000 });
    // The live token is untouched.
    expect(getLiteFinalConfirmTokenByJti(db, "live")!.status).toBe("pending");
  });

  it("expireStaleLiteFinalConfirmTokens returns [] when nothing is overdue", () => {
    issueLiteFinalConfirmToken(db, issueInput({ expiresAt: 999999 }));
    expect(expireStaleLiteFinalConfirmTokens(db, 2000)).toEqual([]);
  });

  it("scrubRotatedLiteFinalConfirmTokens nulls raw tokens on old terminal rows only", () => {
    // Confirmed + old → scrubbed.
    issueLiteFinalConfirmToken(db, issueInput({ jti: "done", token: "!~done" }));
    consumeLiteFinalConfirmToken(db, { jti: "done", channelRef: "slack:C1", consumedAt: 1100, nowMs: 1100 });
    // Pending → never scrubbed even if old.
    seedTask("task-2");
    issueLiteFinalConfirmToken(
      db,
      issueInput({ jti: "pend", token: "!~pend", taskId: "task-2", issuedAt: 1, expiresAt: 999999 }),
    );

    const scrubbed = scrubRotatedLiteFinalConfirmTokens(db, 10_000);
    expect(scrubbed).toBe(1);
    expect(getLiteFinalConfirmTokenByJti(db, "done")!.token).toBeNull();
    expect(getLiteFinalConfirmTokenByJti(db, "pend")!.token).toBe("!~pend");
  });

  it("scrubRotatedLiteFinalConfirmTokens leaves recent terminal rows intact", () => {
    issueLiteFinalConfirmToken(db, issueInput({ jti: "recent", token: "!~recent" }));
    consumeLiteFinalConfirmToken(db, { jti: "recent", channelRef: "slack:C1", consumedAt: 9000, nowMs: 9000 });
    // cutoff older than consumed_at → not scrubbed.
    expect(scrubRotatedLiteFinalConfirmTokens(db, 5000)).toBe(0);
    expect(getLiteFinalConfirmTokenByJti(db, "recent")!.token).toBe("!~recent");
  });
});
