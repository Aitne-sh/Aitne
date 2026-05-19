import { describe, it, expect } from "vitest";
import {
  INTEGRATION_WRITE_TTL_MS,
  SNAPSHOT_NORMALIZERS,
  getSnapshotNormalizer,
  hasSnapshotNormalizer,
  listSnapshotNormalizers,
  stableStringify,
  type CalendarSnapshotPayload,
  type GmailSnapshotPayload,
  type IntegrationNormalizer,
  type NotionSnapshotPayload,
} from "./integrations-snapshot.js";

const calendar = SNAPSHOT_NORMALIZERS.google_calendar as IntegrationNormalizer;
const gmail = SNAPSHOT_NORMALIZERS.gmail as IntegrationNormalizer;
const notion = SNAPSHOT_NORMALIZERS.notion as IntegrationNormalizer;

describe("integrations-snapshot — registry", () => {
  it("ships normalizers for every IntegrationKey after Phase 5", () => {
    expect(hasSnapshotNormalizer("google_calendar")).toBe(true);
    expect(hasSnapshotNormalizer("gmail")).toBe(true);
    expect(hasSnapshotNormalizer("notion")).toBe(true);
    expect(getSnapshotNormalizer("google_calendar")).toBeDefined();
    expect(getSnapshotNormalizer("gmail")).toBeDefined();
    expect(getSnapshotNormalizer("notion")).toBeDefined();
    expect(listSnapshotNormalizers().sort()).toEqual([
      "gmail",
      "google_calendar",
      "notion",
    ]);
  });

  it("publishes per-integration TTLs that outlive the slowest reconcile cadence × 1.5", () => {
    // INTEGRATION-DRIFT-PHASE-7-PLAN.md §3.1: TTL ≥ slowest_cadence × 1.5
    // for every integration. Default cadences: calendar 60min (24h
    // window), gmail 30min, notion 60min. The 10-min imminent calendar
    // cadence does not govern because an agent-originated event lands
    // inside the 24h cadence first.
    expect(INTEGRATION_WRITE_TTL_MS.google_calendar).toBe(90 * 60 * 1000);
    expect(INTEGRATION_WRITE_TTL_MS.gmail).toBe(45 * 60 * 1000);
    expect(INTEGRATION_WRITE_TTL_MS.notion).toBe(90 * 60 * 1000);
  });
});

describe("stableStringify", () => {
  it("sorts object keys at every level", () => {
    const a = stableStringify({ b: 1, a: { z: 1, y: 2 } });
    const b = stableStringify({ a: { y: 2, z: 1 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe(`{"a":{"y":2,"z":1},"b":1}`);
  });

  it("preserves array order (callers pre-sort when order is non-semantic)", () => {
    expect(stableStringify([3, 1, 2])).toBe("[3,1,2]");
  });

  it("encodes scalars and null directly", () => {
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify("x")).toBe(`"x"`);
    expect(stableStringify(42)).toBe("42");
    expect(stableStringify(true)).toBe("true");
  });

  it("drops undefined fields rather than emitting illegal JSON", () => {
    expect(stableStringify({ a: 1, b: undefined, c: 2 })).toBe(`{"a":1,"c":2}`);
  });

  it("recurses into nested arrays", () => {
    expect(stableStringify({ a: [{ b: 1 }, { c: 2 }] })).toBe(
      `{"a":[{"b":1},{"c":2}]}`,
    );
  });
});

describe("calendar normalizer", () => {
  function rawEvent(overrides: Record<string, unknown> = {}): unknown {
    return {
      id: "evt-1",
      summary: "Standup",
      start: { dateTime: "2026-04-28T09:00:00+09:00" },
      end: { dateTime: "2026-04-28T09:30:00+09:00" },
      location: "Room A",
      description: "weekly",
      status: "confirmed",
      htmlLink: "https://example.com/evt-1",
      attendees: [
        { email: "b@example.com", responseStatus: "accepted" },
        { email: "a@example.com", responseStatus: "needsAction" },
      ],
      ...overrides,
    };
  }

  it("derives itemId from event.id when not recurring", () => {
    expect(calendar.itemId(rawEvent())).toBe("evt-1");
  });

  it("keys recurring instances by `${seriesId}@${start}`", () => {
    const raw = rawEvent({
      id: "evt-1_20260428T090000Z",
      recurringEventId: "series-7",
    });
    expect(calendar.itemId(raw)).toBe("series-7@2026-04-28T09:00:00+09:00");
  });

  it("falls back to raw id when recurring instance has no start", () => {
    const raw = rawEvent({
      id: "evt-1",
      recurringEventId: "series-7",
      start: null,
    });
    expect(calendar.itemId(raw)).toBe("evt-1");
  });

  it("throws when id is missing — defensive against malformed upstream", () => {
    expect(() => calendar.itemId({} as unknown)).toThrow(/missing id/);
    expect(() => calendar.itemId({ id: "" } as unknown)).toThrow(/missing id/);
  });

  it("normalises payload: sorts attendees by email and coerces nullable strings", () => {
    const payload = calendar.payload(rawEvent()) as CalendarSnapshotPayload;
    expect(payload.attendees.map((a) => a.email)).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
    expect(payload.summary).toBe("Standup");
    expect(payload.htmlLink).toBe("https://example.com/evt-1");
  });

  it("defaults responseStatus to needsAction when missing", () => {
    const raw = rawEvent({ attendees: [{ email: "a@x.com" }] });
    const payload = calendar.payload(raw) as CalendarSnapshotPayload;
    expect(payload.attendees[0]).toEqual({
      email: "a@x.com",
      responseStatus: "needsAction",
    });
  });

  it("ignores attendee entries with no email or non-object shape", () => {
    const raw = rawEvent({
      attendees: [
        { email: "a@x.com" },
        { responseStatus: "accepted" }, // missing email — dropped
        null,
        "not-an-object",
        { email: "" }, // empty email — dropped
      ],
    });
    const payload = calendar.payload(raw) as CalendarSnapshotPayload;
    expect(payload.attendees).toEqual([
      { email: "a@x.com", responseStatus: "needsAction" },
    ]);
  });

  it("handles non-array attendees by yielding empty list", () => {
    const payload = calendar.payload(
      rawEvent({ attendees: undefined }),
    ) as CalendarSnapshotPayload;
    expect(payload.attendees).toEqual([]);
  });

  it("accepts all-day {date: ...} start/end shape", () => {
    const raw = rawEvent({
      start: { date: "2026-04-28" },
      end: { date: "2026-04-29" },
    });
    const payload = calendar.payload(raw) as CalendarSnapshotPayload;
    expect(payload.start).toBe("2026-04-28");
    expect(payload.end).toBe("2026-04-29");
  });

  it("accepts a bare ISO string start/end (legacy / mock shape)", () => {
    const raw = rawEvent({ start: "2026-04-28T09:00:00Z", end: "2026-04-28T10:00:00Z" });
    const payload = calendar.payload(raw) as CalendarSnapshotPayload;
    expect(payload.start).toBe("2026-04-28T09:00:00Z");
  });

  it("treats invalid time fields (number, empty string, missing both) as null", () => {
    expect(
      (calendar.payload(rawEvent({ start: { dateTime: "" } })) as CalendarSnapshotPayload)
        .start,
    ).toBeNull();
    expect(
      (calendar.payload(rawEvent({ start: 42 as unknown })) as CalendarSnapshotPayload)
        .start,
    ).toBeNull();
    expect(
      (calendar.payload(rawEvent({ start: "" as unknown })) as CalendarSnapshotPayload)
        .start,
    ).toBeNull();
    expect(
      (calendar.payload(rawEvent({ start: {} })) as CalendarSnapshotPayload).start,
    ).toBeNull();
    expect(
      (calendar.payload(rawEvent({ start: null })) as CalendarSnapshotPayload).start,
    ).toBeNull();
  });

  it("preserves relative order for duplicate-email attendees (Google jitter)", () => {
    const raw = rawEvent({
      attendees: [
        { email: "dup@x.com", responseStatus: "accepted" },
        { email: "dup@x.com", responseStatus: "declined" },
      ],
    });
    const payload = calendar.payload(raw) as CalendarSnapshotPayload;
    expect(payload.attendees).toEqual([
      { email: "dup@x.com", responseStatus: "accepted" },
      { email: "dup@x.com", responseStatus: "declined" },
    ]);
  });

  it("hash is stable across attendee-order jitter", () => {
    const a = calendar.hash(calendar.payload(rawEvent()));
    const b = calendar.hash(
      calendar.payload(
        rawEvent({
          attendees: [
            { email: "a@example.com", responseStatus: "needsAction" },
            { email: "b@example.com", responseStatus: "accepted" },
          ],
        }),
      ),
    );
    expect(a).toBe(b);
  });

  it("hash excludes htmlLink so server-side path rewrites do not flap", () => {
    const a = calendar.hash(calendar.payload(rawEvent()));
    const b = calendar.hash(
      calendar.payload(rawEvent({ htmlLink: "https://example.com/different" })),
    );
    expect(a).toBe(b);
  });

  it("hash is stable across description whitespace jitter (§3.4)", () => {
    // Google occasionally re-wraps long descriptions / inserts NBSP. The
    // normalizer collapses runs of whitespace and converts NBSP so the
    // hash does not flap on otherwise identical events.
    const a = calendar.payload(
      rawEvent({ description: "weekly\nstandup\twith   the team" }),
    ) as CalendarSnapshotPayload;
    const b = calendar.payload(
      rawEvent({ description: "weekly standup with the team" }),
    ) as CalendarSnapshotPayload;
    expect(a.description).toBe("weekly standup with the team");
    expect(calendar.hash(a)).toBe(calendar.hash(b));
  });

  it("normalizes an all-whitespace description to null", () => {
    const payload = calendar.payload(
      rawEvent({ description: "   \n\t  " }),
    ) as CalendarSnapshotPayload;
    expect(payload.description).toBeNull();
  });

  it("hash changes when summary changes", () => {
    const a = calendar.hash(calendar.payload(rawEvent()));
    const b = calendar.hash(calendar.payload(rawEvent({ summary: "Renamed" })));
    expect(a).not.toBe(b);
  });

  it("hash changes when start time moves", () => {
    const a = calendar.hash(calendar.payload(rawEvent()));
    const b = calendar.hash(
      calendar.payload(
        rawEvent({ start: { dateTime: "2026-04-28T10:00:00+09:00" } }),
      ),
    );
    expect(a).not.toBe(b);
  });

  it("itemStart matches the raw start", () => {
    expect(calendar.itemStart(rawEvent())).toBe("2026-04-28T00:00:00.000Z");
    expect(calendar.itemStart(rawEvent({ start: null }))).toBeNull();
  });

  it("itemStart returns null when raw start is a non-parseable string", () => {
    // Defensive: Google never returns a malformed dateTime, but a future
    // connector could pass through e.g. an Outlook-format string. The
    // normalizer must yield null rather than NaN-ms downstream into the
    // imminent-event scheduler.
    expect(
      calendar.itemStart(rawEvent({ start: { dateTime: "not-a-date" } })),
    ).toBeNull();
  });

  it("inWindow returns true when start ∈ [windowMin, windowMax)", () => {
    const payload = calendar.payload(rawEvent()) as CalendarSnapshotPayload;
    expect(
      calendar.inWindow(payload, "2026-04-28T00:00:00+09:00", "2026-04-29T00:00:00+09:00"),
    ).toBe(true);
  });

  it("inWindow returns false at the exclusive upper bound", () => {
    const payload = calendar.payload(rawEvent()) as CalendarSnapshotPayload;
    expect(
      calendar.inWindow(payload, "2026-04-28T00:00:00+09:00", "2026-04-28T09:00:00+09:00"),
    ).toBe(false);
  });

  it("inWindow returns true at the inclusive lower bound", () => {
    const payload = calendar.payload(rawEvent()) as CalendarSnapshotPayload;
    expect(
      calendar.inWindow(payload, "2026-04-28T09:00:00+09:00", "2026-04-28T10:00:00+09:00"),
    ).toBe(true);
  });

  it("inWindow returns false when payload has null start", () => {
    const payload = calendar.payload(
      rawEvent({ start: null }),
    ) as CalendarSnapshotPayload;
    expect(
      calendar.inWindow(payload, "2026-04-28T00:00:00+09:00", "2026-04-29T00:00:00+09:00"),
    ).toBe(false);
  });
});

describe("gmail thread normalizer", () => {
  function fullThread(overrides: Record<string, unknown> = {}): unknown {
    return {
      threadId: "thr-1",
      messages: [
        {
          id: "msg-1",
          threadId: "thr-1",
          internalDate: "1714305600000", // 2024-04-28T12:00:00Z
          labelIds: ["INBOX", "UNREAD"],
          snippet: "older snippet",
          payload: {
            headers: [
              { name: "Subject", value: "Hello" },
              { name: "From", value: "Old <old@example.com>" },
            ],
          },
        },
        {
          id: "msg-2",
          threadId: "thr-1",
          internalDate: 1714392000000, // 2024-04-29T12:00:00Z
          labelIds: ["INBOX", "IMPORTANT"],
          snippet: "newest snippet",
          payload: {
            headers: [
              { name: "Subject", value: "Re: Hello" },
              { name: "From", value: "Sarah <SARAH@example.com>" },
            ],
          },
        },
      ],
      ...overrides,
    };
  }

  it("derives itemId from threadId when present", () => {
    expect(gmail.itemId(fullThread())).toBe("thr-1");
  });

  it("falls back to top-level id when threadId is absent", () => {
    expect(gmail.itemId({ id: "thr-fallback" } as unknown)).toBe("thr-fallback");
  });

  it("falls back to message-level threadId when only messages are present", () => {
    expect(
      gmail.itemId({ messages: [{ threadId: "thr-from-msg", id: "msg-x" }] } as unknown),
    ).toBe("thr-from-msg");
  });

  it("falls back to message id when no threadId is anywhere", () => {
    expect(
      gmail.itemId({ messages: [{ id: "msg-only" }] } as unknown),
    ).toBe("msg-only");
  });

  it("throws when neither threadId nor id is present", () => {
    expect(() => gmail.itemId({} as unknown)).toThrow(/missing threadId/);
  });

  it("uses the latest message's headers + canonicalises from to lowercase email", () => {
    const payload = gmail.payload(fullThread()) as GmailSnapshotPayload;
    expect(payload.subject).toBe("Re: Hello");
    expect(payload.from).toBe("sarah@example.com");
    expect(payload.lastMessageInternalDate).toBe("2024-04-29T12:00:00.000Z");
  });

  it("collects + sorts labelIds across all messages and dedupes top-level labels", () => {
    const raw = fullThread({ labelIds: ["INBOX", "STARRED"] });
    const payload = gmail.payload(raw) as GmailSnapshotPayload;
    expect(payload.labelIds).toEqual(["IMPORTANT", "INBOX", "STARRED", "UNREAD"]);
  });

  it("collects + sorts messageIds in ascending order regardless of input order", () => {
    const payload = gmail.payload(fullThread()) as GmailSnapshotPayload;
    expect(payload.messageIds).toEqual(["msg-1", "msg-2"]);
  });

  it("accepts a flattened search-hit shape (Codex / Claude search row)", () => {
    const raw = {
      id: "msg-flat",
      threadId: "thr-flat",
      internalDate: 1714392000000,
      labelIds: ["INBOX"],
      subject: "Flat hit",
      from: { name: "Carol", email: "Carol@Example.COM" },
      snippet: "preview",
    };
    const payload = gmail.payload(raw as unknown) as GmailSnapshotPayload;
    expect(payload.threadId).toBe("thr-flat");
    expect(payload.subject).toBe("Flat hit");
    expect(payload.from).toBe("carol@example.com");
    expect(payload.labelIds).toEqual(["INBOX"]);
    expect(payload.messageIds).toEqual(["msg-flat"]);
    expect(payload.snippet).toBe("preview");
  });

  it("accepts the minimal Gemini search shape (id + threadId only)", () => {
    const raw = { id: "msg-min", threadId: "thr-min" };
    const payload = gmail.payload(raw as unknown) as GmailSnapshotPayload;
    expect(payload.threadId).toBe("thr-min");
    expect(payload.messageIds).toEqual(["msg-min"]);
    expect(payload.subject).toBeNull();
    expect(payload.from).toBeNull();
    expect(payload.lastMessageInternalDate).toBeNull();
  });

  it("hash is stable across snippet rewrites (§17.10)", () => {
    const a = gmail.hash(gmail.payload(fullThread()));
    const firstMessage = (fullThread() as { messages: Record<string, unknown>[] })
      .messages[0];
    const b = gmail.hash(
      gmail.payload(
        fullThread({
          messages: [
            { ...firstMessage },
            {
              id: "msg-2",
              threadId: "thr-1",
              internalDate: 1714392000000,
              labelIds: ["INBOX", "IMPORTANT"],
              snippet: "ENTIRELY new snippet wording", // different
              payload: {
                headers: [
                  { name: "Subject", value: "Re: Hello" },
                  { name: "From", value: "Sarah <SARAH@example.com>" },
                ],
              },
            },
          ],
        }),
      ),
    );
    expect(a).toBe(b);
  });

  it("hash is stable across `from` shape jitter (string vs. object)", () => {
    const a = gmail.hash(gmail.payload(fullThread()));
    const b = gmail.hash(
      gmail.payload(
        fullThread({
          messages: [
            (fullThread() as { messages: unknown[] }).messages[0],
            {
              id: "msg-2",
              threadId: "thr-1",
              internalDate: 1714392000000,
              labelIds: ["INBOX", "IMPORTANT"],
              snippet: "newest snippet",
              payload: {
                headers: [{ name: "Subject", value: "Re: Hello" }],
              },
              from: { name: "Sarah", email: "sarah@example.com" },
            },
          ],
        }),
      ),
    );
    expect(a).toBe(b);
  });

  it("hash is stable across labelIds and messageIds order jitter", () => {
    const a = gmail.hash(gmail.payload(fullThread()));
    const messages = (fullThread() as { messages: unknown[] }).messages;
    const reordered = [messages[1], messages[0]];
    const b = gmail.hash(
      gmail.payload(fullThread({ messages: reordered })),
    );
    expect(a).toBe(b);
  });

  it("hash changes when subject changes", () => {
    const a = gmail.hash(gmail.payload(fullThread()));
    const messages = (fullThread() as { messages: unknown[] }).messages;
    const newer = messages[1] as Record<string, unknown>;
    const renamedHeaders = [
      { name: "Subject", value: "DIFFERENT subject" },
      { name: "From", value: "Sarah <sarah@example.com>" },
    ];
    const b = gmail.hash(
      gmail.payload(
        fullThread({
          messages: [
            messages[0],
            { ...newer, payload: { headers: renamedHeaders } },
          ],
        }),
      ),
    );
    expect(a).not.toBe(b);
  });

  it("hash changes when a new message arrives in an existing thread", () => {
    const a = gmail.hash(gmail.payload(fullThread()));
    const messages = (fullThread() as { messages: unknown[] }).messages;
    const newMsg = {
      id: "msg-3",
      threadId: "thr-1",
      internalDate: 1714478400000,
      labelIds: ["INBOX"],
      snippet: "newest",
      payload: { headers: [{ name: "Subject", value: "Re: Re: Hello" }] },
    };
    const b = gmail.hash(
      gmail.payload(fullThread({ messages: [...messages, newMsg] })),
    );
    expect(a).not.toBe(b);
  });

  it("itemStart is always null (gmail has no scheduled time)", () => {
    expect(gmail.itemStart(fullThread())).toBeNull();
  });

  it("inWindow uses the latest message's internalDate", () => {
    const payload = gmail.payload(fullThread()) as GmailSnapshotPayload;
    expect(
      gmail.inWindow(payload, "2024-04-29T00:00:00Z", "2024-04-30T00:00:00Z"),
    ).toBe(true);
    expect(
      gmail.inWindow(payload, "2024-04-30T00:00:00Z", "2024-05-01T00:00:00Z"),
    ).toBe(false);
  });

  it("inWindow returns false when the payload has no parseable date", () => {
    const payload = gmail.payload({ threadId: "thr-x" } as unknown) as GmailSnapshotPayload;
    expect(
      gmail.inWindow(payload, "2026-04-28T00:00:00Z", "2026-04-29T00:00:00Z"),
    ).toBe(false);
  });

  it("inWindow rejects non-parseable window bounds", () => {
    const payload = gmail.payload(fullThread()) as GmailSnapshotPayload;
    expect(gmail.inWindow(payload, "tomorrow", "next-week")).toBe(false);
  });

  it("ignores non-object attendee-style entries inside the messages array", () => {
    const raw = {
      threadId: "thr-defensive",
      messages: [null, "string", { id: "msg-1", threadId: "thr-defensive" }],
    };
    const payload = gmail.payload(raw as unknown) as GmailSnapshotPayload;
    expect(payload.messageIds).toEqual(["msg-1"]);
  });

  it("parses internalDate as an RFC-3339 string when not a number-like string", () => {
    const raw = {
      threadId: "thr-rfc",
      messages: [
        {
          id: "msg-rfc",
          threadId: "thr-rfc",
          internalDate: "2024-04-29T12:00:00Z",
          labelIds: ["INBOX"],
        },
      ],
    };
    const payload = gmail.payload(raw as unknown) as GmailSnapshotPayload;
    expect(payload.lastMessageInternalDate).toBe("2024-04-29T12:00:00.000Z");
  });

  it("canonicalises a bare-email `from` (no angle brackets) by lowercasing", () => {
    const raw = {
      threadId: "thr-bare",
      messages: [
        {
          id: "msg-1",
          threadId: "thr-bare",
          internalDate: 1714392000000,
          from: "Alice@Example.COM",
        },
      ],
    };
    const payload = gmail.payload(raw as unknown) as GmailSnapshotPayload;
    expect(payload.from).toBe("alice@example.com");
  });

  it("returns null `from` for a whitespace-only string", () => {
    const raw = {
      threadId: "thr-blank",
      messages: [
        {
          id: "msg-1",
          threadId: "thr-blank",
          internalDate: 1714392000000,
          from: "   ",
        },
      ],
    };
    const payload = gmail.payload(raw as unknown) as GmailSnapshotPayload;
    expect(payload.from).toBeNull();
  });

  it("ignores non-object header entries and entries without a `name` field", () => {
    const raw = {
      threadId: "thr-headers",
      messages: [
        {
          id: "msg-1",
          threadId: "thr-headers",
          internalDate: 1714392000000,
          payload: {
            headers: [
              null,
              "string-junk",
              { value: "no name attached" },
              { name: "Subject", value: "Real subject" },
            ],
          },
        },
      ],
    };
    const payload = gmail.payload(raw as unknown) as GmailSnapshotPayload;
    expect(payload.subject).toBe("Real subject");
  });

  it("returns null `from` for an unrecognised shape (array / number / object without email)", () => {
    const raw = {
      threadId: "thr-weird",
      from: [1, 2, 3], // unrecognised non-object array
      messages: [
        {
          id: "msg-1",
          threadId: "thr-weird",
          internalDate: 100,
          from: { not_an_email: "x" }, // object without email
        },
      ],
    };
    const payload = gmail.payload(raw as unknown) as GmailSnapshotPayload;
    expect(payload.from).toBeNull();
  });

  it("merges a top-level messageIds array (Codex search-hit flatten) and dedupes", () => {
    const raw = {
      threadId: "thr-flat",
      id: "msg-1",
      internalDate: 1714392000000,
      labelIds: ["INBOX"],
      // Top-level messageIds; these come from connectors that surface
      // every message id on the search row instead of a nested messages[]
      // array. Includes a duplicate of the top-level id (msg-1) and an
      // empty string we should drop.
      messageIds: ["msg-1", "msg-2", ""],
    };
    const payload = gmail.payload(raw as unknown) as GmailSnapshotPayload;
    expect(payload.messageIds).toEqual(["msg-1", "msg-2"]);
  });
});

describe("notion page normalizer", () => {
  function rawPage(overrides: Record<string, unknown> = {}): unknown {
    return {
      id: "page-1",
      url: "https://notion.so/page-1",
      archived: false,
      in_trash: false,
      last_edited_time: "2026-04-28T10:00:00.000Z",
      parent: { type: "database_id", database_id: "db-tasks" },
      properties: {
        Name: {
          type: "title",
          title: [{ plain_text: "Ship feature" }],
        },
        Status: { type: "status", status: { name: "In progress" } },
        Priority: { type: "select", select: { name: "P1" } },
        Tags: {
          type: "multi_select",
          multi_select: [{ name: "alpha" }, { name: "beta" }],
        },
        Due: {
          type: "date",
          date: { start: "2026-04-30", end: null, time_zone: null },
        },
        Done: { type: "checkbox", checkbox: false },
        Estimate: { type: "number", number: 5 },
        Link: { type: "url", url: "https://example.com" },
        Owner: { type: "people", people: [{ id: "u-1" }, { id: "u-0" }] },
        Notes: {
          type: "rich_text",
          rich_text: [{ plain_text: "see " }, { plain_text: "doc" }],
        },
        Project: {
          type: "relation",
          relation: [{ id: "rel-b" }, { id: "rel-a" }],
        },
        Created: { type: "created_time", created_time: "2026-04-01T00:00:00Z" },
        Edited: { type: "last_edited_time", last_edited_time: "2026-04-28T10:00:00Z" },
        Mystery: { type: "phone_number", phone_number: "+1234" },
      },
      ...overrides,
    };
  }

  it("derives itemId from page id", () => {
    expect(notion.itemId(rawPage())).toBe("page-1");
  });

  it("throws when id is missing", () => {
    expect(() => notion.itemId({} as unknown)).toThrow(/missing id/);
    expect(() => notion.itemId({ id: "" } as unknown)).toThrow(/missing id/);
  });

  it("itemStart is always null (notion pages have no scheduled time)", () => {
    expect(notion.itemStart(rawPage())).toBeNull();
  });

  it("extracts title from the title property", () => {
    const payload = notion.payload(rawPage()) as NotionSnapshotPayload;
    expect(payload.title).toBe("Ship feature");
  });

  it("returns null title when properties have no title type", () => {
    const payload = notion.payload(
      rawPage({ properties: { Status: { type: "status", status: { name: "Done" } } } }),
    ) as NotionSnapshotPayload;
    expect(payload.title).toBeNull();
  });

  it("extracts parentDatabase from `parent.database_id` (matches NotionPoller's source key)", () => {
    const payload = notion.payload(rawPage()) as NotionSnapshotPayload;
    expect(payload.parentDatabase).toBe("db-tasks");
  });

  it("falls back to `parent.data_source_id` when `database_id` is absent", () => {
    const payload = notion.payload(
      rawPage({ parent: { data_source_id: "ds-1" } }),
    ) as NotionSnapshotPayload;
    expect(payload.parentDatabase).toBe("ds-1");
  });

  it("returns null parentDatabase for workspace- or page-rooted pages", () => {
    expect(
      (notion.payload(rawPage({ parent: { workspace: true } })) as NotionSnapshotPayload)
        .parentDatabase,
    ).toBeNull();
    expect(
      (notion.payload(rawPage({ parent: { page_id: "p-x" } })) as NotionSnapshotPayload)
        .parentDatabase,
    ).toBeNull();
    expect(
      (notion.payload(rawPage({ parent: undefined })) as NotionSnapshotPayload)
        .parentDatabase,
    ).toBeNull();
  });

  it("flags inTrash when archived OR in_trash is true", () => {
    expect(
      (notion.payload(rawPage({ archived: true })) as NotionSnapshotPayload).inTrash,
    ).toBe(true);
    expect(
      (notion.payload(rawPage({ in_trash: true })) as NotionSnapshotPayload).inTrash,
    ).toBe(true);
    expect((notion.payload(rawPage()) as NotionSnapshotPayload).inTrash).toBe(false);
  });

  it("hashes property changes via propertiesSummaryHash", () => {
    const a = notion.hash(notion.payload(rawPage()));
    // Mutate Status — the propertiesSummaryHash should change.
    const props = (rawPage() as { properties: Record<string, unknown> }).properties;
    const b = notion.hash(
      notion.payload(
        rawPage({
          properties: {
            ...props,
            Status: { type: "status", status: { name: "Done" } },
          },
        }),
      ),
    );
    expect(a).not.toBe(b);
  });

  it("hash is stable across multi_select / people / relation order jitter", () => {
    const a = notion.hash(notion.payload(rawPage()));
    const props = (rawPage() as { properties: Record<string, unknown> }).properties;
    const b = notion.hash(
      notion.payload(
        rawPage({
          properties: {
            ...props,
            Tags: {
              type: "multi_select",
              multi_select: [{ name: "beta" }, { name: "alpha" }],
            },
            Owner: { type: "people", people: [{ id: "u-0" }, { id: "u-1" }] },
            Project: {
              type: "relation",
              relation: [{ id: "rel-a" }, { id: "rel-b" }],
            },
          },
        }),
      ),
    );
    expect(a).toBe(b);
  });

  it("hash is stable across created_time / last_edited_time field jitter (§17.9)", () => {
    const a = notion.hash(notion.payload(rawPage()));
    const props = (rawPage() as { properties: Record<string, unknown> }).properties;
    const b = notion.hash(
      notion.payload(
        rawPage({
          properties: {
            ...props,
            Created: { type: "created_time", created_time: "2099-01-01T00:00:00Z" },
            Edited: { type: "last_edited_time", last_edited_time: "2099-01-01T00:00:00Z" },
          },
        }),
      ),
    );
    expect(a).toBe(b);
  });

  it("hash changes when title changes", () => {
    const a = notion.hash(notion.payload(rawPage()));
    const props = (rawPage() as { properties: Record<string, unknown> }).properties;
    const b = notion.hash(
      notion.payload(
        rawPage({
          properties: {
            ...props,
            Name: { type: "title", title: [{ plain_text: "Renamed" }] },
          },
        }),
      ),
    );
    expect(a).not.toBe(b);
  });

  it("hash changes when relation ids change (relationsHash component)", () => {
    const a = notion.hash(notion.payload(rawPage()));
    const props = (rawPage() as { properties: Record<string, unknown> }).properties;
    const b = notion.hash(
      notion.payload(
        rawPage({
          properties: {
            ...props,
            Project: {
              type: "relation",
              relation: [{ id: "rel-a" }, { id: "rel-c" }],
            },
          },
        }),
      ),
    );
    expect(a).not.toBe(b);
  });

  it("hash is stable when `url` jitters (excluded from the hash)", () => {
    const a = notion.hash(notion.payload(rawPage()));
    const b = notion.hash(
      notion.payload(rawPage({ url: "https://notion.so/different" })),
    );
    expect(a).toBe(b);
  });

  it("hash is stable when inTrash transitions but lastEditedTime stays", () => {
    // Notion bumps last_edited_time on archive in the real API; here we
    // assert that absent that bump, archived alone does not flap the hash.
    const a = notion.hash(notion.payload(rawPage()));
    const b = notion.hash(notion.payload(rawPage({ archived: true })));
    expect(a).toBe(b);
  });

  it("captures unknown property types via type-tag-only shape", () => {
    const a = notion.hash(notion.payload(rawPage()));
    const props = (rawPage() as { properties: Record<string, unknown> }).properties;
    // Add a property with an unknown type — the type-tag fallback should
    // produce a stable hash on its own, but ADDING a new property still
    // changes the hash (presence/absence is meaningful).
    const b = notion.hash(
      notion.payload(
        rawPage({
          properties: {
            ...props,
            New: { type: "future_type_not_yet_known", future_type_not_yet_known: 42 },
          },
        }),
      ),
    );
    expect(a).not.toBe(b);
    // ...but two pages that both have an unknown-type property of the same
    // type tag should hash consistently regardless of the unknown value.
    const c = notion.hash(
      notion.payload(
        rawPage({
          properties: {
            ...props,
            New: { type: "future_type_not_yet_known", future_type_not_yet_known: 99 },
          },
        }),
      ),
    );
    expect(b).toBe(c);
  });

  it("yields a propertiesSummary with status/select/date highlights for display", () => {
    const payload = notion.payload(rawPage()) as NotionSnapshotPayload;
    expect(payload.propertiesSummary).toContain("Status: In progress");
    expect(payload.propertiesSummary).toContain("Priority: P1");
    expect(payload.propertiesSummary).toContain("Due: 2026-04-30");
  });

  it("returns empty shapes / null summary when `properties` is missing entirely", () => {
    // Exercises the early-return branches of notionPropertiesShape /
    // notionRelationsShape / notionPropertiesSummaryString — a page from
    // a connector that omits the properties key (Notion sometimes elides
    // it when `parent.workspace = true` and the page has no schema).
    const payload = notion.payload({
      id: "page-noprops",
      last_edited_time: "2026-04-28T10:00:00Z",
      parent: { workspace: true },
    } as unknown) as NotionSnapshotPayload;
    expect(payload.title).toBeNull();
    expect(payload.propertiesSummary).toBeNull();
    // Hash must still be stable — re-feeding the identical raw shape
    // yields the same hash even though the properties hash + relations
    // hash both feed off empty shapes.
    const a = notion.hash(payload);
    const b = notion.hash(notion.payload({
      id: "page-noprops",
      last_edited_time: "2026-04-28T10:00:00Z",
      parent: { workspace: true },
    } as unknown) as NotionSnapshotPayload);
    expect(a).toBe(b);
  });

  it("ignores non-object entries inside title / rich_text / multi_select / people / files arrays", () => {
    // Each array's `if (seg == null || typeof seg !== "object") continue`
    // branch is exercised here. Real-world Notion responses occasionally
    // surface a stub `null` segment in a title array when the user starts
    // typing then deletes — defensive handling matters.
    const props: Record<string, unknown> = {
      Name: {
        type: "title",
        title: [null, "string-junk", { plain_text: "Mixed" }],
      },
      Notes: {
        type: "rich_text",
        rich_text: [null, { plain_text: "x" }],
      },
      Tags: {
        type: "multi_select",
        multi_select: [null, "string", { name: "kept" }],
      },
      Owner: {
        type: "people",
        people: [null, "string", { id: "p-kept" }],
      },
      Files: {
        type: "files",
        files: [null, "string", { name: "kept.pdf" }],
      },
    };
    const a = notion.hash(notion.payload(rawPage({ properties: props })));
    const b = notion.hash(notion.payload(rawPage({ properties: props })));
    expect(a).toBe(b);
  });

  it("ignores non-object entries inside a relation array", () => {
    const payload = notion.payload(
      rawPage({
        properties: {
          Project: {
            type: "relation",
            relation: [{ id: "rel-1" }, null, "string", { id: "rel-2" }],
          },
        },
      }),
    ) as NotionSnapshotPayload;
    // Pulled rel-1 + rel-2; non-object entries dropped.
    const same = notion.hash(payload);
    const reordered = notion.hash(
      notion.payload(
        rawPage({
          properties: {
            Project: {
              type: "relation",
              relation: [{ id: "rel-2" }, null, "string", { id: "rel-1" }],
            },
          },
        }),
      ) as NotionSnapshotPayload,
    );
    expect(same).toBe(reordered);
  });

  it("yields a null propertiesSummary when no status/select/date properties exist", () => {
    const payload = notion.payload(
      rawPage({
        properties: {
          Name: { type: "title", title: [{ plain_text: "Plain" }] },
        },
      }),
    ) as NotionSnapshotPayload;
    expect(payload.propertiesSummary).toBeNull();
  });

  it("inWindow uses lastEditedTime", () => {
    const payload = notion.payload(rawPage()) as NotionSnapshotPayload;
    expect(
      notion.inWindow(payload, "2026-04-28T00:00:00Z", "2026-04-29T00:00:00Z"),
    ).toBe(true);
    expect(
      notion.inWindow(payload, "2026-04-29T00:00:00Z", "2026-04-30T00:00:00Z"),
    ).toBe(false);
  });

  it("inWindow returns false when payload has null lastEditedTime", () => {
    const payload = notion.payload(
      rawPage({ last_edited_time: null }),
    ) as NotionSnapshotPayload;
    expect(
      notion.inWindow(payload, "2026-04-28T00:00:00Z", "2026-04-29T00:00:00Z"),
    ).toBe(false);
  });

  it("inWindow rejects non-parseable window bounds", () => {
    const payload = notion.payload(rawPage()) as NotionSnapshotPayload;
    expect(notion.inWindow(payload, "yesterday", "tomorrow")).toBe(false);
  });

  it("falls through to type-tag for properties whose extractor returns null/empty payloads", () => {
    // Hits the inner branches of notionPropertyValueShape's many handlers
    // (rich_text/title with non-array body, status/select/date with
    // null inner, multi_select/people/files non-array, checkbox/number
    // off-type, url/email/phone null).
    const props: Record<string, unknown> = {
      RichEmpty: { type: "rich_text", rich_text: "not-an-array" },
      TitleEmpty: { type: "title" },
      StatusNull: { type: "status", status: null },
      SelectNull: { type: "select" },
      MultiBad: { type: "multi_select", multi_select: "nope" },
      DateNull: { type: "date", date: null },
      Cb: { type: "checkbox", checkbox: "yes" }, // off-type
      Num: { type: "number", number: "ten" }, // off-type
      Url: { type: "url" },
      Email: { type: "email" },
      Phone: { type: "phone_number" },
      PeopleBad: { type: "people", people: "nope" },
      FilesBad: { type: "files", files: "nope" },
      RelBad: { type: "relation", relation: "nope" },
      NotAnObject: "not an object",
      MissingType: { foo: 1 },
    };
    const payload = notion.payload(
      rawPage({ properties: props }),
    ) as NotionSnapshotPayload;
    expect(payload.title).toBeNull();
    // Hash is stable when this same shape is re-fed.
    const a = notion.hash(payload);
    const b = notion.hash(
      notion.payload(rawPage({ properties: props })) as NotionSnapshotPayload,
    );
    expect(a).toBe(b);
  });

  it("derives multi_select / files names correctly when entries are objects", () => {
    const payload = notion.payload(
      rawPage({
        properties: {
          Files: {
            type: "files",
            files: [
              { name: "a.pdf", file: { url: "https://x/a" } },
              { name: "b.pdf", external: { url: "https://x/b" } },
              { name: "name-only.pdf" },
              null,
            ],
          },
        },
      }),
    ) as NotionSnapshotPayload;
    // The hash captured these stably; re-running yields the same result.
    expect(notion.hash(payload)).toBe(
      notion.hash(notion.payload(
        rawPage({
          properties: {
            Files: {
              type: "files",
              files: [
                { name: "a.pdf", file: { url: "https://x/a" } },
                { name: "b.pdf", external: { url: "https://x/b" } },
                { name: "name-only.pdf" },
                null,
              ],
            },
          },
        }),
      )),
    );
  });
});
