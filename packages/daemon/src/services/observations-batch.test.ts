/**
 * Focused tests for `services/observations-batch.ts`.
 *
 * The HTTP-route layer (`api/routes/observations.test.ts`) exercises the
 * envelope handling (content-length cap, JSON-parse errors, batch-too-large
 * 400) but historically left two branches of the per-item write loop
 * uncovered:
 *
 *   - `flip_locked` — `readIntegrationFlipLock` returns truthy for the
 *     row's integration; the item is recorded as `flip_locked` and the
 *     loop continues.
 *   - mixed validation + write-success — verifies that a single
 *     `validation_error` does NOT abort the surrounding successful items.
 *
 * Both branches now live in the extracted service (after Phase B moved
 * the per-item loop here so the SDK MCP tool and the HTTP route share
 * one code path). These tests pin them so coverage stays at 100% on
 * the new module without parking it in the vitest exclusion list.
 */

import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.js";
import { acquireIntegrationFlipLock } from "../core/integration-lifecycle.js";
import {
  BATCH_MAX_OBSERVATIONS,
  inferIntegrationKeyFromSource,
  normalizeMailObservationPayload,
  processObservationsBatch,
  validateBatchItem,
} from "./observations-batch.js";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

describe("inferIntegrationKeyFromSource", () => {
  it("returns the exact key when source is a bare integration name", () => {
    expect(inferIntegrationKeyFromSource("gmail")).toBe("gmail");
  });
  it("returns the prefix key for colon-delimited per-account sources", () => {
    expect(inferIntegrationKeyFromSource("gmail:acct-1")).toBe("gmail");
    expect(inferIntegrationKeyFromSource("google_calendar:primary")).toBe(
      "google_calendar",
    );
  });
  it("returns null for unknown sources", () => {
    expect(inferIntegrationKeyFromSource("custom:thing")).toBeNull();
    expect(inferIntegrationKeyFromSource("")).toBeNull();
  });
});

describe("validateBatchItem", () => {
  it("accepts a well-formed object with defaults applied", () => {
    const result = validateBatchItem(
      { source: "gmail:default", ref: "msg-1", payload: { kind: "mail" } },
      0,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe("gmail:default");
      expect(result.ref).toBe("msg-1");
      expect(result.changeType).toBe("created");
      expect(result.actor).toBe("agent");
    }
  });
  it("rejects non-object items", () => {
    const r = validateBatchItem("string", 3);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.result.status).toBe("validation_error");
      expect(r.result.index).toBe(3);
      expect(r.result.error).toMatch(/JSON object/);
    }
  });
  it("rejects arrays", () => {
    const r = validateBatchItem([], 0);
    expect(r.ok).toBe(false);
  });
  it("rejects items missing source", () => {
    const r = validateBatchItem({ ref: "a" }, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.result.error).toMatch(/source/);
    }
  });
  it("rejects empty-string source", () => {
    const r = validateBatchItem({ source: "", ref: "a" }, 0);
    expect(r.ok).toBe(false);
  });
  it("rejects items missing ref", () => {
    const r = validateBatchItem({ source: "gmail:default" }, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.result.error).toMatch(/ref/);
    }
  });
  it("rejects empty-string ref", () => {
    const r = validateBatchItem({ source: "gmail:default", ref: "" }, 0);
    expect(r.ok).toBe(false);
  });
  it("rejects items with unsupported changeType", () => {
    const r = validateBatchItem(
      { source: "gmail:default", ref: "a", changeType: "renamed" },
      0,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.result.error).toMatch(/changeType/);
    }
  });
  it("rejects items with unsupported actor", () => {
    const r = validateBatchItem(
      { source: "gmail:default", ref: "a", actor: "operator" },
      0,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.result.error).toMatch(/actor/);
    }
  });
});

describe("normalizeMailObservationPayload", () => {
  it("attaches is_read=0 and from_email for gmail pre-pass payloads", () => {
    const normalized = normalizeMailObservationPayload("gmail:default", {
      kind: "mail",
      providerId: "default",
      raw: {
        subject: "Hello",
        from: "Sender Name <sender@example.com>",
        snippet: "...",
      },
    });
    expect(normalized).toMatchObject({
      kind: "mail",
      is_read: 0,
      from_email: "sender@example.com",
    });
  });
  it("respects an existing is_read on the payload", () => {
    const normalized = normalizeMailObservationPayload("gmail:default", {
      kind: "mail",
      providerId: "default",
      is_read: 1,
      raw: { from: "a@b.com" },
    });
    expect((normalized as { is_read: number }).is_read).toBe(1);
  });
  it("respects an existing from_email on the payload", () => {
    const normalized = normalizeMailObservationPayload("gmail:default", {
      kind: "mail",
      providerId: "default",
      from_email: "explicit@b.com",
      raw: { from: "Other <other@b.com>" },
    });
    expect((normalized as { from_email: string }).from_email).toBe(
      "explicit@b.com",
    );
  });
  it("passes non-mail integrations through verbatim", () => {
    const payload = { kind: "calendar", raw: { from: "noisy" } };
    expect(normalizeMailObservationPayload("google_calendar:primary", payload))
      .toBe(payload);
  });
  it("passes unknown sources through verbatim", () => {
    const payload = { kind: "mail", raw: { from: "a@b" } };
    expect(normalizeMailObservationPayload("custom:thing", payload)).toBe(payload);
  });
  it("passes payloads without raw through verbatim", () => {
    const payload = { kind: "mail" };
    expect(normalizeMailObservationPayload("gmail:default", payload)).toBe(payload);
  });
  it("passes payloads whose raw.from is missing through verbatim", () => {
    const payload = { kind: "mail", raw: { subject: "x" } };
    expect(normalizeMailObservationPayload("gmail:default", payload)).toBe(payload);
  });
  it("passes null payload through verbatim", () => {
    expect(normalizeMailObservationPayload("gmail:default", null)).toBeNull();
  });
  it("passes array payload through verbatim", () => {
    const payload = [1, 2, 3];
    expect(normalizeMailObservationPayload("gmail:default", payload)).toBe(payload);
  });
  it("passes payload with array raw through verbatim", () => {
    const payload = { kind: "mail", raw: [1, 2] };
    expect(normalizeMailObservationPayload("gmail:default", payload)).toBe(payload);
  });
  it("skips from_email when the address cannot be extracted", () => {
    // raw.from is a string but contains no @, so EMAIL_RE returns null.
    const normalized = normalizeMailObservationPayload("gmail:default", {
      kind: "mail",
      raw: { from: "no-email-address-here" },
    }) as Record<string, unknown>;
    expect(normalized.is_read).toBe(0);
    expect(normalized).not.toHaveProperty("from_email");
  });
});

describe("processObservationsBatch", () => {
  it("records every well-formed item and returns posted=N", () => {
    const db = freshDb();
    const result = processObservationsBatch(db, [
      { source: "gmail:default", ref: "m1", payload: { kind: "mail" } },
      { source: "gmail:default", ref: "m2", payload: { kind: "mail" } },
    ]);
    expect(result.fetched).toBe(2);
    expect(result.posted).toBe(2);
    expect(result.duplicates).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.results).toHaveLength(2);
    expect(result.results.every((r) => r.status === "created")).toBe(true);
    db.close();
  });

  it("returns duplicate status for an identical re-submission", () => {
    const db = freshDb();
    processObservationsBatch(db, [
      { source: "gmail:default", ref: "m1", payload: { kind: "mail", title: "x" } },
    ]);
    const result = processObservationsBatch(db, [
      { source: "gmail:default", ref: "m1", payload: { kind: "mail", title: "x" } },
    ]);
    expect(result.posted).toBe(0);
    expect(result.duplicates).toBe(1);
    expect(result.results[0]!.status).toBe("duplicate");
    db.close();
  });

  it("collects validation_error per item without aborting the batch", () => {
    const db = freshDb();
    const result = processObservationsBatch(db, [
      { source: "gmail:default", ref: "m1", payload: { kind: "mail" } },
      { source: "", ref: "m2" },
      { source: "gmail:default", ref: "m3", payload: { kind: "mail" } },
    ]);
    expect(result.posted).toBe(2);
    expect(result.errors).toBe(1);
    expect(result.results[1]!.status).toBe("validation_error");
  });

  it("records flip_locked when the integration's flip lock is held", () => {
    // Pin the flip-lock branch that was previously uncovered in
    // observations.ts (the route file). Acquire the lock for gmail,
    // submit a batch, observe the per-item flip_locked status.
    const db = freshDb();
    const lockResult = acquireIntegrationFlipLock(db, "gmail");
    expect(lockResult.ok).toBe(true);

    const result = processObservationsBatch(db, [
      { source: "gmail:default", ref: "m1", payload: { kind: "mail" } },
      { source: "notion:ws-1", ref: "p1", payload: { kind: "notion" } },
    ]);
    // gmail item blocked, notion item succeeds (lock is per-integration).
    expect(result.results[0]).toMatchObject({
      status: "flip_locked",
      source: "gmail:default",
      ref: "m1",
    });
    expect(result.results[1]!.status).toBe("created");
    expect(result.posted).toBe(1);
    expect(result.errors).toBe(1);
    db.close();
  });

  it("returns posted=0/duplicates=0/errors=0 for an empty batch", () => {
    const db = freshDb();
    const result = processObservationsBatch(db, []);
    expect(result).toEqual({
      results: [],
      fetched: 0,
      posted: 0,
      duplicates: 0,
      errors: 0,
    });
    db.close();
  });
});

describe("module constants", () => {
  it("exposes BATCH_MAX_OBSERVATIONS at the documented cap of 200", () => {
    // Pinned because the cap is referenced both by the route's
    // batch-too-large 400 and by the SDK MCP tool's zod schema; a silent
    // drift would let one path accept payloads the other rejects.
    expect(BATCH_MAX_OBSERVATIONS).toBe(200);
  });
});
