import { describe, it, expect } from "vitest";
import { extractWriteItemIds } from "./extract-write-item-id.js";

/**
 * INTEGRATION-DRIFT-DETECTION-PLAN.md §11 Phase 4 — pure helper that
 * extracts upstream item ids from a delegated `/api/integrations/:key/exec`
 * write response so the route handler can mark `integration_writes`.
 * (The same shape walk previously fed the retired `/invoke` RPC; the
 * `exec.ts` defensive guards still cover that arm for future
 * reactivation — see `maybeMarkIntegrationWrite`.)
 *
 * The extractor walks a small set of canonical field names per
 * integration; this test enforces the contract field-by-field. Per-
 * connector shape drift is a documented concern (see the "no_id_in_result"
 * branch — the route handler logs at debug and degrades to one self-
 * noticed observation), so we test BOTH the happy paths and the miss.
 */
describe("extractWriteItemIds — google_calendar", () => {
  it("extracts top-level eventId", () => {
    const result = extractWriteItemIds({
      integration: "google_calendar",
      bareTool: "create_event",
      toolResult: { eventId: "abc-123", htmlLink: "https://..." },
    });
    expect(result.itemIds).toEqual(["abc-123"]);
    expect(result.reason).toBe("extracted");
  });

  it("extracts top-level id when eventId is absent", () => {
    const result = extractWriteItemIds({
      integration: "google_calendar",
      bareTool: "update_event",
      toolResult: { id: "evt-xyz" },
    });
    expect(result.itemIds).toEqual(["evt-xyz"]);
  });

  it("falls back to nested event.id for Codex-shaped responses", () => {
    const result = extractWriteItemIds({
      integration: "google_calendar",
      bareTool: "create_event",
      toolResult: { event: { id: "evt-codex-1", summary: "..." } },
    });
    expect(result.itemIds).toEqual(["evt-codex-1"]);
  });

  it("walks events[] collection for batch-shaped responses", () => {
    const result = extractWriteItemIds({
      integration: "google_calendar",
      bareTool: "create_event",
      toolResult: {
        events: [
          { id: "evt-1" },
          { id: "evt-2" },
        ],
      },
    });
    expect(result.itemIds).toEqual(["evt-1", "evt-2"]);
  });

  it("falls back to args.eventId for delete_event / respond_to_event responses", () => {
    const result = extractWriteItemIds({
      integration: "google_calendar",
      bareTool: "delete_event",
      toolResult: { ok: true },
      args: { eventId: "evt-deleted-7" },
    });
    expect(result.itemIds).toEqual(["evt-deleted-7"]);
    expect(result.reason).toBe("extracted_from_args");
  });

  it("falls back to args.event_id (snake_case)", () => {
    const result = extractWriteItemIds({
      integration: "google_calendar",
      bareTool: "delete_event",
      toolResult: {},
      args: { event_id: "evt-snake" },
    });
    expect(result.itemIds).toEqual(["evt-snake"]);
  });

  it("returns no_id_in_result when neither response nor args carry an id", () => {
    const result = extractWriteItemIds({
      integration: "google_calendar",
      bareTool: "create_event",
      toolResult: { ok: true, status: 200 },
    });
    expect(result.itemIds).toEqual([]);
    expect(result.reason).toBe("no_id_in_result");
  });
});

describe("extractWriteItemIds — gmail", () => {
  it("extracts top-level messageId + threadId", () => {
    const result = extractWriteItemIds({
      integration: "gmail",
      bareTool: "send_email",
      toolResult: { messageId: "msg-A", threadId: "thr-1" },
    });
    expect(result.itemIds).toEqual(["msg-A", "thr-1"]);
    expect(result.reason).toBe("extracted");
  });

  it("dedupes the same id appearing under multiple keys", () => {
    const result = extractWriteItemIds({
      integration: "gmail",
      bareTool: "send_draft",
      toolResult: { messageId: "msg-B", id: "msg-B", threadId: "thr-2" },
    });
    expect(result.itemIds).toEqual(["msg-B", "thr-2"]);
  });

  it("flags threadId-only responses with `extracted_threadId_only`", () => {
    const result = extractWriteItemIds({
      integration: "gmail",
      bareTool: "label_thread",
      toolResult: { threadId: "thr-only-3" },
    });
    expect(result.itemIds).toEqual(["thr-only-3"]);
    expect(result.reason).toBe("extracted_threadId_only");
  });

  it("walks messages[] collection for batch-shaped responses", () => {
    const result = extractWriteItemIds({
      integration: "gmail",
      bareTool: "batch_modify_email",
      toolResult: { messages: [{ id: "msg-1" }, { messageId: "msg-2" }] },
    });
    expect(result.itemIds).toEqual(["msg-1", "msg-2"]);
  });

  it("falls back to args.messageId when response is `{ ok: true }`", () => {
    const result = extractWriteItemIds({
      integration: "gmail",
      bareTool: "label_message",
      toolResult: { ok: true },
      args: { messageId: "msg-args-1", labelIds: ["INBOX"] },
    });
    expect(result.itemIds).toEqual(["msg-args-1"]);
    expect(result.reason).toBe("extracted_from_args");
  });

  it("falls back to args.messageIds[] for bulk_label_matching_emails", () => {
    const result = extractWriteItemIds({
      integration: "gmail",
      bareTool: "bulk_label_matching_emails",
      toolResult: { ok: true },
      args: { messageIds: ["a", "b", "c"], add: ["IMPORTANT"] },
    });
    expect(result.itemIds).toEqual(["a", "b", "c"]);
  });

  it("walks args.message_ids[] (Codex snake_case)", () => {
    const result = extractWriteItemIds({
      integration: "gmail",
      bareTool: "apply_labels_to_emails",
      toolResult: { ok: true },
      args: { message_ids: ["m1", "m2"] },
    });
    expect(result.itemIds).toEqual(["m1", "m2"]);
  });

  it("walks args.threadIds[] for thread-collection mutations", () => {
    const result = extractWriteItemIds({
      integration: "gmail",
      bareTool: "modifyThread",
      toolResult: {},
      args: { threadIds: ["t1", "t2"] },
    });
    expect(result.itemIds).toEqual(["t1", "t2"]);
  });

  it("ignores non-string elements inside args plural arrays", () => {
    const result = extractWriteItemIds({
      integration: "gmail",
      bareTool: "apply_labels_to_emails",
      toolResult: {},
      args: { messageIds: ["good", null, 42, "also-good"] },
    });
    expect(result.itemIds).toEqual(["good", "also-good"]);
  });
});

describe("extractWriteItemIds — notion", () => {
  it("extracts top-level pageId", () => {
    const result = extractWriteItemIds({
      integration: "notion",
      bareTool: "notion-create-pages",
      toolResult: { pageId: "page-aaa" },
    });
    expect(result.itemIds).toEqual(["page-aaa"]);
  });

  it("falls back to nested page.id (Notion API echoes the full page object)", () => {
    const result = extractWriteItemIds({
      integration: "notion",
      bareTool: "notion-create-pages",
      toolResult: { page: { id: "page-bbb", title: "..." } },
    });
    expect(result.itemIds).toEqual(["page-bbb"]);
  });

  it("walks pages[] for create-many shapes", () => {
    const result = extractWriteItemIds({
      integration: "notion",
      bareTool: "notion-create-pages",
      toolResult: { pages: [{ id: "p1" }, { id: "p2" }] },
    });
    expect(result.itemIds).toEqual(["p1", "p2"]);
  });

  it("walks the official Notion search/list `results[]` shape", () => {
    const result = extractWriteItemIds({
      integration: "notion",
      bareTool: "notion-update-page",
      toolResult: { results: [{ id: "p3" }] },
    });
    expect(result.itemIds).toEqual(["p3"]);
  });

  it("falls back to args.page_id for notion-update-page", () => {
    const result = extractWriteItemIds({
      integration: "notion",
      bareTool: "notion-update-page",
      toolResult: { ok: true },
      args: { page_id: "page-args-1", properties: {} },
    });
    expect(result.itemIds).toEqual(["page-args-1"]);
  });
});

describe("extractWriteItemIds — degradation paths", () => {
  it("returns empty for null toolResult and no args", () => {
    const result = extractWriteItemIds({
      integration: "google_calendar",
      bareTool: "create_event",
      toolResult: null,
    });
    expect(result.itemIds).toEqual([]);
    expect(result.reason).toBe("no_id_in_result");
  });

  it("returns empty for scalar toolResult", () => {
    const result = extractWriteItemIds({
      integration: "google_calendar",
      bareTool: "create_event",
      toolResult: "ok",
    });
    expect(result.itemIds).toEqual([]);
  });

  it("returns empty for an empty events[] array", () => {
    const result = extractWriteItemIds({
      integration: "google_calendar",
      bareTool: "create_event",
      toolResult: { events: [] },
    });
    expect(result.itemIds).toEqual([]);
  });

  it("ignores nested objects with no id field", () => {
    const result = extractWriteItemIds({
      integration: "google_calendar",
      bareTool: "create_event",
      toolResult: { event: { summary: "no-id" } },
    });
    expect(result.itemIds).toEqual([]);
  });

  it("ignores non-object entries inside collection arrays", () => {
    const result = extractWriteItemIds({
      integration: "gmail",
      bareTool: "send_email",
      toolResult: { messages: [null, "bad", 3, { id: "good" }] },
    });
    expect(result.itemIds).toEqual(["good"]);
  });

  it("ignores empty strings in id fields", () => {
    const result = extractWriteItemIds({
      integration: "google_calendar",
      bareTool: "create_event",
      toolResult: { eventId: "" },
    });
    expect(result.itemIds).toEqual([]);
  });

  it("treats array toolResult as no-id (top-level array isn't a recognised wrapper)", () => {
    const result = extractWriteItemIds({
      integration: "google_calendar",
      bareTool: "create_event",
      toolResult: [{ id: "evt-array" }],
    });
    expect(result.itemIds).toEqual([]);
  });

  it("ignores args when toolResult already supplied an id (response-shape wins)", () => {
    const result = extractWriteItemIds({
      integration: "google_calendar",
      bareTool: "update_event",
      toolResult: { eventId: "from-response" },
      args: { eventId: "from-args" },
    });
    expect(result.itemIds).toEqual(["from-response"]);
    expect(result.reason).toBe("extracted");
  });

  it("skips non-object args (defensive — caller should pass {} or omit)", () => {
    const result = extractWriteItemIds({
      integration: "gmail",
      bareTool: "label_message",
      toolResult: {},
      args: null,
    });
    expect(result.itemIds).toEqual([]);
  });

  it("skips array args", () => {
    const result = extractWriteItemIds({
      integration: "gmail",
      bareTool: "label_message",
      toolResult: {},
      args: ["unexpected"],
    });
    expect(result.itemIds).toEqual([]);
  });

  it("ignores plural args entries that aren't arrays", () => {
    const result = extractWriteItemIds({
      integration: "gmail",
      bareTool: "apply_labels_to_emails",
      toolResult: {},
      args: { messageIds: "not-an-array" },
    });
    expect(result.itemIds).toEqual([]);
  });
});
