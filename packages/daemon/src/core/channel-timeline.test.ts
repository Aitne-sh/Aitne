import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.js";
import {
  PROACTIVE_FORWARD_TYPES,
  formatForwardSuffix,
  getProactiveForwardType,
  isProactiveForwardMetadata,
  metadataDispatchIds,
  parseMessageMetadata,
  recordProactiveForwardDeliveries,
} from "./channel-timeline.js";
import type { AgentConfig } from "../config.js";

function makeConfig(
  overrides: Partial<
    Pick<
      AgentConfig,
      | "proactiveForwardChannelTimelineEnabled"
      | "proactiveForwardForceFreshSession"
    >
  > = {},
): Pick<
  AgentConfig,
  "proactiveForwardChannelTimelineEnabled" | "proactiveForwardForceFreshSession"
> {
  return {
    proactiveForwardChannelTimelineEnabled: true,
    proactiveForwardForceFreshSession: false,
    ...overrides,
  } as Pick<
    AgentConfig,
    | "proactiveForwardChannelTimelineEnabled"
    | "proactiveForwardForceFreshSession"
  >;
}

describe("parseMessageMetadata", () => {
  it("returns the object verbatim when given a plain record", () => {
    const obj = { foo: "bar", n: 1 };
    expect(parseMessageMetadata(obj)).toBe(obj);
  });

  it("returns an empty object for null", () => {
    expect(parseMessageMetadata(null)).toEqual({});
  });

  it("returns an empty object for an array (arrays are not records)", () => {
    expect(parseMessageMetadata([1, 2, 3])).toEqual({});
  });

  it("returns an empty object for a non-string non-object value", () => {
    expect(parseMessageMetadata(42)).toEqual({});
  });

  it("returns an empty object for an empty / whitespace-only string", () => {
    expect(parseMessageMetadata("")).toEqual({});
    expect(parseMessageMetadata("   ")).toEqual({});
  });

  it("parses a JSON-encoded record", () => {
    expect(parseMessageMetadata('{"foo":"bar"}')).toEqual({ foo: "bar" });
  });

  it("returns an empty object when the JSON parses to an array", () => {
    expect(parseMessageMetadata("[1,2,3]")).toEqual({});
  });

  it("returns an empty object when the JSON parses to a primitive", () => {
    expect(parseMessageMetadata('"just-a-string"')).toEqual({});
    expect(parseMessageMetadata("123")).toEqual({});
  });

  it("returns an empty object for malformed JSON (catch branch)", () => {
    expect(parseMessageMetadata("{not-json")).toEqual({});
  });
});

describe("getProactiveForwardType", () => {
  it("returns the value when notificationType is a known forward type", () => {
    for (const type of PROACTIVE_FORWARD_TYPES) {
      expect(getProactiveForwardType({ notificationType: type })).toBe(type);
    }
  });

  it("returns null when notificationType is some other string", () => {
    expect(
      getProactiveForwardType({ notificationType: "system_notice" }),
    ).toBeNull();
  });

  it("returns null when notificationType is missing entirely", () => {
    // Pins the `String(undefined)` -> "undefined" branch in
    // getProactiveForwardType — must not match a forward type.
    expect(getProactiveForwardType({})).toBeNull();
  });

  it("returns null when notificationType is a non-string value", () => {
    expect(getProactiveForwardType({ notificationType: 42 })).toBeNull();
    expect(getProactiveForwardType({ notificationType: null })).toBeNull();
  });
});

describe("isProactiveForwardMetadata", () => {
  it("is true for proactive_forward / proactive_forward_batched / scheduled_dm", () => {
    expect(
      isProactiveForwardMetadata({ notificationType: "proactive_forward" }),
    ).toBe(true);
    expect(
      isProactiveForwardMetadata({
        notificationType: "proactive_forward_batched",
      }),
    ).toBe(true);
    expect(
      isProactiveForwardMetadata({ notificationType: "scheduled_dm" }),
    ).toBe(true);
  });

  it("is false for any other metadata", () => {
    expect(isProactiveForwardMetadata({})).toBe(false);
    expect(
      isProactiveForwardMetadata({ notificationType: "system_notice" }),
    ).toBe(false);
  });
});

describe("formatForwardSuffix", () => {
  it("returns the autonomous-run suffix for proactive_forward(_batched)", () => {
    expect(
      formatForwardSuffix({ notificationType: "proactive_forward" }),
    ).toBe(" (forwarded from autonomous run)");
    expect(
      formatForwardSuffix({ notificationType: "proactive_forward_batched" }),
    ).toBe(" (forwarded from autonomous run)");
  });

  it("returns the scheduled-dm suffix for scheduled_dm", () => {
    expect(
      formatForwardSuffix({ notificationType: "scheduled_dm" }),
    ).toBe(" (scheduled DM dispatched)");
  });

  it("returns an empty string for non-forward metadata", () => {
    expect(formatForwardSuffix({})).toBe("");
    expect(
      formatForwardSuffix({ notificationType: "system_notice" }),
    ).toBe("");
  });
});

describe("metadataDispatchIds", () => {
  it("returns an empty array when dispatchIds is missing", () => {
    expect(metadataDispatchIds({})).toEqual([]);
  });

  it("returns an empty array when dispatchIds is not an array", () => {
    expect(metadataDispatchIds({ dispatchIds: "abc" })).toEqual([]);
  });

  it("filters non-string entries from dispatchIds", () => {
    expect(
      metadataDispatchIds({ dispatchIds: ["a", 1, null, "b", undefined, "c"] }),
    ).toEqual(["a", "b", "c"]);
  });
});

describe("recordProactiveForwardDeliveries", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns zero work when the channel-timeline feature is disabled", () => {
    const result = recordProactiveForwardDeliveries({
      db,
      config: makeConfig({ proactiveForwardChannelTimelineEnabled: false }),
      deliveries: [
        { platform: "telegram", channel: "owner-chat" },
      ],
      content: "hello",
      notificationType: "proactive_forward",
    });
    expect(result).toEqual({ inserted: 0, sessionIds: [] });
    // No conversation_sessions row should have been created.
    const rows = db
      .prepare("SELECT COUNT(*) AS n FROM conversation_sessions")
      .get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it("returns zero work when there are no deliveries", () => {
    const result = recordProactiveForwardDeliveries({
      db,
      config: makeConfig(),
      deliveries: [],
      content: "ignored",
      notificationType: "proactive_forward",
    });
    expect(result).toEqual({ inserted: 0, sessionIds: [] });
  });

  it("returns zero work when content is empty", () => {
    const result = recordProactiveForwardDeliveries({
      db,
      config: makeConfig(),
      deliveries: [
        { platform: "telegram", channel: "owner-chat" },
      ],
      content: "",
      notificationType: "proactive_forward",
    });
    expect(result).toEqual({ inserted: 0, sessionIds: [] });
  });

  it("records a forward into the owner DM scope and stores the dispatch metadata", () => {
    const result = recordProactiveForwardDeliveries({
      db,
      config: makeConfig(),
      deliveries: [
        { platform: "telegram", channel: "owner-chat" },
      ],
      content: "Heads up: meeting at 3pm",
      dispatchId: "dispatch-1",
      originSessionIds: [42],
      notificationType: "proactive_forward",
    });
    expect(result.inserted).toBe(1);
    expect(result.sessionIds).toHaveLength(1);
    const sessionId = result.sessionIds[0];

    const row = db
      .prepare(
        `SELECT role, content, platform, metadata, notification_dispatch_id
           FROM messages WHERE session_id = ?`,
      )
      .get(sessionId) as {
        role: string;
        content: string;
        platform: string;
        metadata: string;
        notification_dispatch_id: string | null;
      };
    expect(row.role).toBe("assistant");
    expect(row.content).toBe("Heads up: meeting at 3pm");
    expect(row.platform).toBe("telegram");
    expect(row.notification_dispatch_id).toBe("dispatch-1");
    const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    expect(metadata).toEqual({
      notificationType: "proactive_forward",
      dispatchIds: ["dispatch-1"],
      originSessionIds: [42],
    });
  });

  it("nulls notification_dispatch_id for proactive_forward_batched (only single forwards carry the id)", () => {
    const result = recordProactiveForwardDeliveries({
      db,
      config: makeConfig(),
      deliveries: [
        { platform: "telegram", channel: "owner-chat" },
      ],
      content: "Batched roundup",
      dispatchId: "dispatch-batch",
      dispatchIds: ["dispatch-batch", "dispatch-other"],
      notificationType: "proactive_forward_batched",
    });
    expect(result.inserted).toBe(1);

    const row = db
      .prepare(
        `SELECT notification_dispatch_id, metadata
           FROM messages WHERE session_id = ?`,
      )
      .get(result.sessionIds[0]) as {
        notification_dispatch_id: string | null;
        metadata: string;
      };
    expect(row.notification_dispatch_id).toBeNull();
    const meta = JSON.parse(row.metadata) as Record<string, unknown>;
    expect(meta.dispatchIds).toEqual(["dispatch-batch", "dispatch-other"]);
  });

  it("clears backend_session_id when proactiveForwardForceFreshSession is true", () => {
    // Seed an active session with a backend_session_id so the test
    // can observe the UPDATE; otherwise the session would be created
    // here and start with NULL backend_session_id anyway.
    db.prepare(
      `INSERT INTO conversation_sessions (
         id, scope, scope_key, platform, channel_id, status, is_dm,
         backend_session_id
       )
       VALUES (1, 'owner_dm', 'telegram:owner-chat', 'telegram',
               'owner-chat', 'active', 1, 'sdk-existing')`,
    ).run();

    const result = recordProactiveForwardDeliveries({
      db,
      config: makeConfig({ proactiveForwardForceFreshSession: true }),
      deliveries: [{ platform: "telegram", channel: "owner-chat" }],
      content: "force fresh",
      notificationType: "proactive_forward",
    });
    expect(result.inserted).toBe(1);

    const row = db
      .prepare(
        `SELECT backend_session_id FROM conversation_sessions WHERE id = ?`,
      )
      .get(result.sessionIds[0]) as { backend_session_id: string | null };
    expect(row.backend_session_id).toBeNull();
  });

  it("skips delivery and does not bump counters when MessageRecorder.recordMessage fails", () => {
    // Pin the `if (!recorded) continue;` branch. We force the
    // recorder to fail by spying on db.prepare so the INSERT inside
    // the recorder transaction throws. The function should report
    // zero inserts and not push the session id into the result list.
    const realPrepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (typeof sql === "string" && sql.includes("INSERT INTO messages")) {
        throw new Error("simulated insert failure");
      }
      return realPrepare(sql);
    });

    const result = recordProactiveForwardDeliveries({
      db,
      config: makeConfig(),
      deliveries: [{ platform: "telegram", channel: "owner-chat" }],
      content: "would have been forwarded",
      notificationType: "proactive_forward",
    });
    spy.mockRestore();

    expect(result).toEqual({ inserted: 0, sessionIds: [] });
    // The session row created by findOrCreateActiveChannelSession
    // survives — the recorder's failure only rolls back the message
    // insert + counter bump, not the session creation. Pin this so a
    // future move of session creation inside the recorder transaction
    // is caught here.
    const sessionRows = db
      .prepare("SELECT id, message_count FROM conversation_sessions")
      .all() as Array<{ id: number; message_count: number }>;
    expect(sessionRows.length).toBeGreaterThan(0);
    for (const row of sessionRows) {
      expect(row.message_count).toBe(0);
    }
  });

  it("records a scheduled_dm dispatch end-to-end (H-1)", () => {
    // Pin the H-1 path: a `scheduled_dm` notification flowing through
    // the same channel-timeline helper produces a normal `messages`
    // row with `notificationType: 'scheduled_dm'` metadata. Because
    // scheduled_dm is single-dispatch (one dispatchId per
    // handleDirectDm call) it joins `proactive_forward` on the
    // single-id branch — the row carries the dispatch_id on the
    // indexed `notification_dispatch_id` column so it can be looked
    // up via the same fast path notification_log uses.
    const result = recordProactiveForwardDeliveries({
      db,
      config: makeConfig(),
      deliveries: [{ platform: "slack", channel: "D-owner" }],
      content: "Reminder: standup in 5 minutes",
      dispatchId: "sched-1",
      dispatchIds: ["sched-1"],
      notificationType: "scheduled_dm",
    });
    expect(result.inserted).toBe(1);

    const row = db
      .prepare(
        `SELECT m.role, m.content, m.platform, m.metadata,
                m.notification_dispatch_id,
                s.scope, s.scope_key
           FROM messages m
           JOIN conversation_sessions s ON m.session_id = s.id
          WHERE session_id = ?`,
      )
      .get(result.sessionIds[0]) as {
        role: string;
        content: string;
        platform: string;
        metadata: string;
        notification_dispatch_id: string | null;
        scope: string;
        scope_key: string;
      };
    expect(row.role).toBe("assistant");
    expect(row.content).toBe("Reminder: standup in 5 minutes");
    expect(row.scope).toBe("owner_dm");
    expect(row.notification_dispatch_id).toBe("sched-1");
    const meta = JSON.parse(row.metadata) as Record<string, unknown>;
    expect(meta.notificationType).toBe("scheduled_dm");
    expect(meta.dispatchIds).toEqual(["sched-1"]);
  });

  it("dedupes session ids and dispatch ids across multiple deliveries on the same channel", () => {
    const result = recordProactiveForwardDeliveries({
      db,
      config: makeConfig(),
      deliveries: [
        { platform: "telegram", channel: "owner-chat" },
        { platform: "telegram", channel: "owner-chat" },
      ],
      content: "duplicate channel deliveries",
      dispatchIds: ["d1", "d1", "d2"],
      originSessionIds: [7, 7, 0, -1, 1.5],
      notificationType: "proactive_forward",
    });
    expect(result.inserted).toBe(2);
    // sessionIds is deduped via dedupeNumbers
    expect(result.sessionIds).toHaveLength(1);

    const row = db
      .prepare(
        `SELECT metadata FROM messages WHERE session_id = ? ORDER BY id ASC`,
      )
      .get(result.sessionIds[0]) as { metadata: string };
    const meta = JSON.parse(row.metadata) as Record<string, unknown>;
    // dispatchIds deduped, non-string values stripped.
    expect(meta.dispatchIds).toEqual(["d1", "d2"]);
    // originSessionIds: 0 / -1 (non-positive) and 1.5 (non-integer)
    // stripped, 7 deduped to a single entry.
    expect(meta.originSessionIds).toEqual([7]);
  });
});
