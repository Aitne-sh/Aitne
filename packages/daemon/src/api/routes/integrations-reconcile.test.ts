import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  getSnapshotNormalizer,
  type IntegrationNormalizer,
} from "@aitne/shared";
import { applySchema } from "../../db/schema.js";
import { createIntegrationReconcileRoutes } from "./integrations-reconcile.js";

const calendar = getSnapshotNormalizer("google_calendar") as IntegrationNormalizer;

function makeDeps(db: Database.Database) {
  return { db, config: {} } as never;
}

function buildRawEvent(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "evt-1",
    summary: "Standup",
    start: { dateTime: "2026-04-28T09:00:00Z" },
    end: { dateTime: "2026-04-28T09:30:00Z" },
    attendees: [{ email: "a@example.com", responseStatus: "accepted" }],
    ...overrides,
  };
}

describe("POST /api/integrations/:key/reconcile — Phase 1", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function post(body: unknown, key = "google_calendar"): Promise<Response> {
    const app = createIntegrationReconcileRoutes(makeDeps(db));
    return Promise.resolve(
      app.request(`/integrations/${key}/reconcile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  it("404s on unknown integration key", async () => {
    const res = await post(
      {
        windowKey: "primary:24h",
        windowMin: "2026-04-28T00:00:00Z",
        windowMax: "2026-04-29T00:00:00Z",
        fetchedAt: "2026-04-28T12:00:00Z",
        items: [],
      },
      "unknown",
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unknown_integration");
  });

  it("Phase 5 partition-collision fix: gmail / notion windowKeys are NOT on the LLM-callable allowlist", async () => {
    // §11 (post-implementation review): the daemon's delegated-sync-worker
    // owns `inbox:7d` (gmail) and `recently_updated` (notion). A narrow
    // LLM fetch posted into either partition would classify every
    // 1-7d-old prior as `deleted` (the per-integration `inWindow`
    // predicate evaluates against the LLM's windowMin/Max — see
    // `reconcile.ts:319-345`). Defense-in-depth: the route rejects the
    // call so even a future overlay rewrite that re-introduces the LLM
    // POST cannot pollute the snapshot.
    const gmailRes = await post(
      {
        windowKey: "inbox:7d",
        windowMin: "2026-04-21T00:00:00Z",
        windowMax: "2026-04-28T00:00:00Z",
        fetchedAt: "2026-04-28T12:00:00Z",
        items: [],
      },
      "gmail",
    );
    expect(gmailRes.status).toBe(400);
    const gmailBody = (await gmailRes.json()) as {
      error: string;
      field: string;
      message: string;
    };
    expect(gmailBody.error).toBe("validation_error");
    expect(gmailBody.field).toBe("windowKey");
    expect(gmailBody.message).toMatch(/not on the LLM-callable allowlist/);

    const notionRes = await post(
      {
        windowKey: "recently_updated",
        windowMin: "2026-04-21T00:00:00Z",
        windowMax: "2026-04-28T00:00:00Z",
        fetchedAt: "2026-04-28T12:00:00Z",
        items: [],
      },
      "notion",
    );
    expect(notionRes.status).toBe(400);
    const notionBody = (await notionRes.json()) as {
      error: string;
      field: string;
      message: string;
    };
    expect(notionBody.error).toBe("validation_error");
    expect(notionBody.field).toBe("windowKey");
    expect(notionBody.message).toMatch(/not on the LLM-callable allowlist/);
  });

  it("400s on invalid JSON body", async () => {
    const app = createIntegrationReconcileRoutes(makeDeps(db));
    const res = await app.request("/integrations/google_calendar/reconcile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });

  it("400s when body is not a JSON object", async () => {
    const res = await post([] as unknown);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; field: string };
    expect(body.error).toBe("validation_error");
    expect(body.field).toBe("body");
  });

  it("400s on disallowed window_key (not on the allowlist)", async () => {
    const res = await post({
      windowKey: "primary:14d",
      windowMin: "2026-04-28T00:00:00Z",
      windowMax: "2026-05-12T00:00:00Z",
      fetchedAt: "2026-04-28T12:00:00Z",
      items: [],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; field: string; message: string };
    expect(body.error).toBe("validation_error");
    expect(body.field).toBe("windowKey");
    expect(body.message).toMatch(/not on the LLM-callable allowlist/);
  });

  it("400s on missing windowKey / windowMin / windowMax / fetchedAt", async () => {
    const cases: Array<{ field: string; mutate: (b: Record<string, unknown>) => void }> = [
      { field: "windowKey", mutate: (b) => delete b.windowKey },
      { field: "windowMin", mutate: (b) => delete b.windowMin },
      { field: "windowMax", mutate: (b) => delete b.windowMax },
      { field: "fetchedAt", mutate: (b) => delete b.fetchedAt },
    ];
    for (const { field, mutate } of cases) {
      const body: Record<string, unknown> = {
        windowKey: "primary:24h",
        windowMin: "2026-04-28T00:00:00Z",
        windowMax: "2026-04-29T00:00:00Z",
        fetchedAt: "2026-04-28T12:00:00Z",
        items: [],
      };
      mutate(body);
      const res = await post(body);
      expect(res.status, `case ${field}`).toBe(400);
      const json = (await res.json()) as { field: string };
      expect(json.field).toBe(field);
    }
  });

  it("400s when windowMin >= windowMax", async () => {
    const res = await post({
      windowKey: "primary:24h",
      windowMin: "2026-04-29T00:00:00Z",
      windowMax: "2026-04-28T00:00:00Z",
      fetchedAt: "2026-04-28T12:00:00Z",
      items: [],
    });
    expect(res.status).toBe(400);
  });

  it("400s when windowMin/windowMax/fetchedAt do not parse to a valid instant", async () => {
    // §5.1 inWindow predicate parses bounds with Date.parse and silently
    // treats NaN as "out of window". A typo like "yesterday" would drop
    // every deleted observation. Reject at the route boundary instead.
    const cases: Array<{
      field: "windowMin" | "windowMax" | "fetchedAt";
      mutate: (b: Record<string, unknown>) => void;
    }> = [
      { field: "windowMin", mutate: (b) => (b.windowMin = "yesterday") },
      { field: "windowMax", mutate: (b) => (b.windowMax = "tomorrow") },
      { field: "fetchedAt", mutate: (b) => (b.fetchedAt = "now-ish") },
    ];
    for (const { field, mutate } of cases) {
      const body: Record<string, unknown> = {
        windowKey: "primary:24h",
        windowMin: "2026-04-28T00:00:00Z",
        windowMax: "2026-04-29T00:00:00Z",
        fetchedAt: "2026-04-28T12:00:00Z",
        items: [],
      };
      mutate(body);
      const res = await post(body);
      expect(res.status, `case ${field}`).toBe(400);
      const json = (await res.json()) as { field: string; message: string };
      expect(json.field).toBe(field);
      expect(json.message).toMatch(/valid instant/);
    }
  });

  it("400s when items is not an array", async () => {
    const res = await post({
      windowKey: "primary:24h",
      windowMin: "2026-04-28T00:00:00Z",
      windowMax: "2026-04-29T00:00:00Z",
      fetchedAt: "2026-04-28T12:00:00Z",
      items: "nope",
    });
    expect(res.status).toBe(400);
  });

  it("400s when an item is not an object", async () => {
    const res = await post({
      windowKey: "primary:24h",
      windowMin: "2026-04-28T00:00:00Z",
      windowMax: "2026-04-29T00:00:00Z",
      fetchedAt: "2026-04-28T12:00:00Z",
      items: ["string-item"],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { field: string };
    expect(body.field).toBe("items[0]");
  });

  it("400s with field annotation when normalization fails on a specific item", async () => {
    const res = await post({
      windowKey: "primary:24h",
      windowMin: "2026-04-28T00:00:00Z",
      windowMax: "2026-04-29T00:00:00Z",
      fetchedAt: "2026-04-28T12:00:00Z",
      items: [{}], // missing id
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { field: string; message: string };
    expect(body.field).toBe("items[0]");
    expect(body.message).toMatch(/missing id/);
  });

  it("400s on unknown actorHint value", async () => {
    const res = await post({
      windowKey: "primary:24h",
      windowMin: "2026-04-28T00:00:00Z",
      windowMax: "2026-04-29T00:00:00Z",
      fetchedAt: "2026-04-28T12:00:00Z",
      items: [{ ...(buildRawEvent() as object), actorHint: "robot" }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { field: string };
    expect(body.field).toBe("items[0].actorHint");
  });

  it.each(["agent", "system"] as const)(
    "rejects HTTP actorHint='%s' — only integration_writes may grant agent attribution",
    async (hint) => {
      const res = await post({
        windowKey: "primary:24h",
        windowMin: "2026-04-28T00:00:00Z",
        windowMax: "2026-04-29T00:00:00Z",
        fetchedAt: "2026-04-28T12:00:00Z",
        items: [{ ...(buildRawEvent() as object), actorHint: hint }],
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { field: string; message: string };
      expect(body.field).toBe("items[0].actorHint");
      expect(body.message).toMatch(/integration_writes/);
    },
  );

  it("returns silent diff on initial snapshot and writes audit row", async () => {
    const res = await post({
      windowKey: "primary:24h",
      windowMin: "2026-04-28T00:00:00Z",
      windowMax: "2026-04-29T00:00:00Z",
      fetchedAt: "2026-04-28T12:00:00Z",
      items: [buildRawEvent()],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      diff: {
        created: unknown[];
        modified: unknown[];
        deleted: unknown[];
        unchanged: number;
        isInitialSnapshot: boolean;
      };
      sideEffects: {
        observationsWritten: number;
        scheduleApproachingEmitted: string[];
        roadmapRefreshTriggered: boolean;
        todayRefreshScheduled: boolean;
      };
    };
    expect(body.diff.isInitialSnapshot).toBe(true);
    expect(body.diff.created).toHaveLength(0);
    expect(body.sideEffects.observationsWritten).toBe(0);
    expect(body.sideEffects.scheduleApproachingEmitted).toEqual([]);

    const audit = db
      .prepare(
        "SELECT action_type, trigger, result, detail FROM agent_actions WHERE action_type = 'reconcile'",
      )
      .get() as { action_type: string; trigger: string | null; result: string; detail: string };
    expect(audit.action_type).toBe("reconcile");
    // Phase 1 leaves trigger NULL — integration is in detail JSON. Phase 3
    // will propagate parentProcessKey when the DelegatedSyncWorker calls
    // through HTTP.
    expect(audit.trigger).toBeNull();
    expect(audit.result).toBe("success");
    const detail = JSON.parse(audit.detail) as {
      windowKey: string;
      itemsSeen: number;
      isInitialSnapshot: boolean;
    };
    expect(detail.windowKey).toBe("primary:24h");
    expect(detail.itemsSeen).toBe(1);
    expect(detail.isInitialSnapshot).toBe(true);
  });

  it("emits created entries on a follow-up call after seeding", async () => {
    // Seed.
    await post({
      windowKey: "primary:24h",
      windowMin: "2026-04-28T00:00:00Z",
      windowMax: "2026-04-29T00:00:00Z",
      fetchedAt: "2026-04-28T11:00:00Z",
      items: [buildRawEvent({ id: "evt-old" })],
    });
    // Follow-up adds evt-new.
    const res = await post({
      windowKey: "primary:24h",
      windowMin: "2026-04-28T00:00:00Z",
      windowMax: "2026-04-29T00:00:00Z",
      fetchedAt: "2026-04-28T12:00:00Z",
      items: [
        buildRawEvent({ id: "evt-old" }),
        buildRawEvent({
          id: "evt-new",
          start: { dateTime: "2026-04-28T15:00:00Z" },
        }),
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      diff: {
        created: Array<{ itemId: string; actor: string }>;
        unchanged: number;
      };
      sideEffects: { observationsWritten: number };
    };
    expect(body.diff.created.map((c) => c.itemId)).toEqual(["evt-new"]);
    expect(body.diff.created[0].actor).toBe("user");
    expect(body.diff.unchanged).toBe(1);
    expect(body.sideEffects.observationsWritten).toBe(1);

    const observation = db
      .prepare("SELECT source, ref, change_type FROM observations WHERE ref = ?")
      .get("evt-new") as {
        source: string;
        ref: string;
        change_type: string;
      };
    expect(observation).toEqual({
      source: "calendar:primary",
      ref: "evt-new",
      change_type: "created",
    });
  });

  it("re-hashes server-side and counts caller-supplied hash mismatches", async () => {
    const event = buildRawEvent();
    const res = await post({
      windowKey: "primary:24h",
      windowMin: "2026-04-28T00:00:00Z",
      windowMax: "2026-04-29T00:00:00Z",
      fetchedAt: "2026-04-28T12:00:00Z",
      items: [
        {
          ...(event as object),
          contentHash: "deadbeef-not-the-real-hash",
        },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meta: { callerHashMismatches: number } };
    expect(body.meta.callerHashMismatches).toBe(1);

    // Snapshot row carries the *server-side* hash, not the caller's
    // value — never trust the caller blindly (§5.2).
    const expected = calendar.hash(calendar.payload(event));
    const row = db
      .prepare("SELECT content_hash FROM integration_snapshots LIMIT 1")
      .get() as { content_hash: string };
    expect(row.content_hash).toBe(expected);
  });

  it("treats a matching caller hash as zero mismatches", async () => {
    const event = buildRawEvent();
    const expected = calendar.hash(calendar.payload(event));
    const res = await post({
      windowKey: "primary:24h",
      windowMin: "2026-04-28T00:00:00Z",
      windowMax: "2026-04-29T00:00:00Z",
      fetchedAt: "2026-04-28T12:00:00Z",
      items: [{ ...(event as object), contentHash: expected }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meta: { callerHashMismatches: number } };
    expect(body.meta.callerHashMismatches).toBe(0);
  });

  it("returns 500 when the database is closed mid-request", async () => {
    // Force a downstream throw by closing the DB before invocation. The
    // route must catch and surface a 500 rather than crashing the
    // process. Audit-row write is best-effort here (DB is gone), so we
    // don't assert on agent_actions.
    const app = createIntegrationReconcileRoutes(makeDeps(db));
    db.close();
    const res = await app.request("/integrations/google_calendar/reconcile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        windowKey: "primary:24h",
        windowMin: "2026-04-28T00:00:00Z",
        windowMax: "2026-04-29T00:00:00Z",
        fetchedAt: "2026-04-28T12:00:00Z",
        items: [buildRawEvent()],
      }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("reconcile_failed");
    // Reopen for afterEach close().
    db = new Database(":memory:");
    applySchema(db);
  });

  it("writes a 'failed' audit row when validation rejects the body (§6.0 defense layer 3)", async () => {
    // Misbehaving caller posts garbage. The 400 still leaves a trace so
    // operators can see fabrication attempts in /api/observations/stats.
    const res = await post({
      windowKey: "not-on-allowlist",
      windowMin: "2026-04-28T00:00:00Z",
      windowMax: "2026-04-29T00:00:00Z",
      fetchedAt: "2026-04-28T12:00:00Z",
      items: [],
    });
    expect(res.status).toBe(400);
    const audit = db
      .prepare(
        "SELECT action_type, result, detail, error FROM agent_actions WHERE action_type = 'reconcile'",
      )
      .get() as {
        action_type: string;
        result: string;
        detail: string;
        error: string;
      };
    expect(audit.action_type).toBe("reconcile");
    expect(audit.result).toBe("failed");
    expect(audit.error).toMatch(/validation_error:windowKey/);
    const detail = JSON.parse(audit.detail) as {
      windowKey: string;
      itemsSeen: number;
    };
    expect(detail.windowKey).toBe("not-on-allowlist");
    expect(detail.itemsSeen).toBe(0);
  });

  it("writes a 'failed' audit row with <invalid> windowKey when body is not an object", async () => {
    const res = await post([] as unknown);
    expect(res.status).toBe(400);
    const audit = db
      .prepare(
        "SELECT detail, error FROM agent_actions WHERE action_type = 'reconcile'",
      )
      .get() as { detail: string; error: string };
    expect(audit.error).toMatch(/validation_error:body/);
    const detail = JSON.parse(audit.detail) as { windowKey: string };
    expect(detail.windowKey).toBe("<invalid>");
  });

  it("dry-run mode (?dry-run=1) computes the diff but writes nothing — next non-dry-run sees the same prior", async () => {
    // Seed evt-1 with one apply call. The route accepts raw upstream
    // event shapes verbatim and re-normalises server-side.
    const seed = await post({
      windowKey: "primary:24h",
      windowMin: "2026-04-28T08:00:00Z",
      windowMax: "2026-04-28T10:00:00Z",
      fetchedAt: "2026-04-28T09:00:00Z",
      items: [buildRawEvent()],
    });
    expect(seed.status).toBe(200);

    // Trigger the actual created emission so prior is non-empty for the
    // dry-run below.
    const seedNonInitial = await post({
      windowKey: "primary:24h",
      windowMin: "2026-04-28T08:00:00Z",
      windowMax: "2026-04-28T10:00:00Z",
      fetchedAt: "2026-04-28T09:10:00Z",
      items: [buildRawEvent()],
    });
    expect(seedNonInitial.status).toBe(200);

    // Dry-run with a renamed event.
    const dryApp = createIntegrationReconcileRoutes(makeDeps(db));
    const dryRes = await dryApp.request(
      "/integrations/google_calendar/reconcile?dry-run=1",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          windowKey: "primary:24h",
          windowMin: "2026-04-28T08:00:00Z",
          windowMax: "2026-04-28T10:00:00Z",
          fetchedAt: "2026-04-28T09:30:00Z",
          items: [buildRawEvent({ summary: "Renamed" })],
        }),
      },
    );
    expect(dryRes.status).toBe(200);
    const dryBody = (await dryRes.json()) as {
      diff: { modified: unknown[]; isInitialSnapshot: boolean };
      sideEffects: { observationsWritten: number };
      meta: { mode: string };
    };
    expect(dryBody.diff.modified).toHaveLength(1);
    expect(dryBody.sideEffects.observationsWritten).toBe(0);
    expect(dryBody.meta.mode).toBe("dry-run");

    // Snapshot table still carries the seed payload, not the rename.
    const stored = db
      .prepare(
        "SELECT payload_json FROM integration_snapshots WHERE integration = 'google_calendar' AND window_key = 'primary:24h' AND item_id = 'evt-1'",
      )
      .get() as { payload_json: string };
    const storedPayload = JSON.parse(stored.payload_json) as { summary: string };
    expect(storedPayload.summary).toBe("Standup");

    // Audit row records the mode flag so retros separate inspections from
    // real mutations.
    const auditRows = db
      .prepare(
        "SELECT detail FROM agent_actions WHERE action_type = 'reconcile' ORDER BY id",
      )
      .all() as Array<{ detail: string }>;
    const lastDetail = JSON.parse(auditRows[auditRows.length - 1].detail) as {
      mode: string;
      modified: number;
    };
    expect(lastDetail.mode).toBe("dry-run");
    expect(lastDetail.modified).toBe(1);

    // No observation rows have been written.
    const obsCount = db
      .prepare("SELECT COUNT(*) AS n FROM observations WHERE source = 'calendar:primary'")
      .get() as { n: number };
    expect(obsCount.n).toBe(0);
  });

  it("dry-run audit row preserves the mode flag even on validation failure", async () => {
    const app = createIntegrationReconcileRoutes(makeDeps(db));
    const res = await app.request(
      "/integrations/google_calendar/reconcile?dryRun=true",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ windowKey: "rogue", items: [] }),
      },
    );
    expect(res.status).toBe(400);
    const audit = db
      .prepare(
        "SELECT detail FROM agent_actions WHERE action_type = 'reconcile' ORDER BY id DESC LIMIT 1",
      )
      .get() as { detail: string };
    const detail = JSON.parse(audit.detail) as { mode: string; windowKey: string };
    expect(detail.mode).toBe("dry-run");
    expect(detail.windowKey).toBe("rogue");
  });

  // ── isTruthyQueryFlag additional branches ──

  it("isTruthyQueryFlag: bare flag (?dry-run, empty string value) → isDryRun=true", async () => {
    // Hono/URLSearchParams represent ?dry-run (no '=') as an empty string ""
    const app = createIntegrationReconcileRoutes(makeDeps(db));
    const res = await app.request(
      "/integrations/google_calendar/reconcile?dry-run",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          windowKey: "primary:24h",
          windowMin: "2026-04-28T00:00:00Z",
          windowMax: "2026-04-29T00:00:00Z",
          fetchedAt: "2026-04-28T12:00:00Z",
          items: [buildRawEvent()],
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meta: { mode: string } };
    expect(body.meta.mode).toBe("dry-run");
  });

  it("isTruthyQueryFlag: ?dry-run=yes → isDryRun=true", async () => {
    const app = createIntegrationReconcileRoutes(makeDeps(db));
    const res = await app.request(
      "/integrations/google_calendar/reconcile?dry-run=yes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          windowKey: "primary:24h",
          windowMin: "2026-04-28T00:00:00Z",
          windowMax: "2026-04-29T00:00:00Z",
          fetchedAt: "2026-04-28T12:00:00Z",
          items: [buildRawEvent()],
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meta: { mode: string } };
    expect(body.meta.mode).toBe("dry-run");
  });

  it("isTruthyQueryFlag: ?dry-run=ON (uppercase) → isDryRun=true", async () => {
    const app = createIntegrationReconcileRoutes(makeDeps(db));
    const res = await app.request(
      "/integrations/google_calendar/reconcile?dry-run=ON",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          windowKey: "primary:24h",
          windowMin: "2026-04-28T00:00:00Z",
          windowMax: "2026-04-29T00:00:00Z",
          fetchedAt: "2026-04-28T12:00:00Z",
          items: [buildRawEvent()],
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meta: { mode: string } };
    expect(body.meta.mode).toBe("dry-run");
  });

  it("isTruthyQueryFlag: ?dry-run=0 → isDryRun=false (apply mode)", async () => {
    const app = createIntegrationReconcileRoutes(makeDeps(db));
    const res = await app.request(
      "/integrations/google_calendar/reconcile?dry-run=0",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          windowKey: "primary:24h",
          windowMin: "2026-04-28T00:00:00Z",
          windowMax: "2026-04-29T00:00:00Z",
          fetchedAt: "2026-04-28T12:00:00Z",
          items: [buildRawEvent()],
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meta: { mode: string } };
    expect(body.meta.mode).toBe("apply");
  });

  // ── validateReconcileBody additional branches ──

  it("400s when windowKey is an empty string", async () => {
    const res = await post({
      windowKey: "",
      windowMin: "2026-04-28T00:00:00Z",
      windowMax: "2026-04-29T00:00:00Z",
      fetchedAt: "2026-04-28T12:00:00Z",
      items: [],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { field: string };
    expect(body.field).toBe("windowKey");
  });

  it("400s when fetchedAt is an empty string (fails isIsoLikeString)", async () => {
    const res = await post({
      windowKey: "primary:24h",
      windowMin: "2026-04-28T00:00:00Z",
      windowMax: "2026-04-29T00:00:00Z",
      fetchedAt: "",
      items: [],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { field: string };
    expect(body.field).toBe("fetchedAt");
  });

  it("400s when actorHint is a non-string type (e.g. number)", async () => {
    const res = await post({
      windowKey: "primary:24h",
      windowMin: "2026-04-28T00:00:00Z",
      windowMax: "2026-04-29T00:00:00Z",
      fetchedAt: "2026-04-28T12:00:00Z",
      items: [{ ...(buildRawEvent() as object), actorHint: 42 }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { field: string };
    expect(body.field).toBe("items[0].actorHint");
  });

  it("accepts actorHint='user' and stores it in the diff", async () => {
    // Seed first so the second call produces a real diff
    await post({
      windowKey: "primary:24h",
      windowMin: "2026-04-28T00:00:00Z",
      windowMax: "2026-04-29T00:00:00Z",
      fetchedAt: "2026-04-28T11:00:00Z",
      items: [],
    });
    const res = await post({
      windowKey: "primary:24h",
      windowMin: "2026-04-28T00:00:00Z",
      windowMax: "2026-04-29T00:00:00Z",
      fetchedAt: "2026-04-28T12:00:00Z",
      items: [{ ...(buildRawEvent() as object), actorHint: "user" }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meta: { callerHashMismatches: number } };
    expect(body.meta.callerHashMismatches).toBe(0);
  });

  it("accepts actorHint='unknown' (valid HTTP actor hint)", async () => {
    await post({
      windowKey: "primary:24h",
      windowMin: "2026-04-28T00:00:00Z",
      windowMax: "2026-04-29T00:00:00Z",
      fetchedAt: "2026-04-28T11:00:00Z",
      items: [],
    });
    const res = await post({
      windowKey: "primary:24h",
      windowMin: "2026-04-28T00:00:00Z",
      windowMax: "2026-04-29T00:00:00Z",
      fetchedAt: "2026-04-28T12:00:00Z",
      items: [{ ...(buildRawEvent() as object), actorHint: "unknown" }],
    });
    expect(res.status).toBe(200);
  });

  it("uses caller-supplied itemId string when explicitly set", async () => {
    const res = await post({
      windowKey: "primary:24h",
      windowMin: "2026-04-28T00:00:00Z",
      windowMax: "2026-04-29T00:00:00Z",
      fetchedAt: "2026-04-28T12:00:00Z",
      items: [{ ...(buildRawEvent() as object), itemId: "custom-override-id" }],
    });
    expect(res.status).toBe(200);
    // The snapshot table should carry the caller-supplied itemId
    const row = db
      .prepare("SELECT item_id FROM integration_snapshots WHERE integration = 'google_calendar'")
      .get() as { item_id: string } | undefined;
    expect(row?.item_id).toBe("custom-override-id");
  });

  it("callerHash empty string is NOT counted as mismatch", async () => {
    const res = await post({
      windowKey: "primary:24h",
      windowMin: "2026-04-28T00:00:00Z",
      windowMax: "2026-04-29T00:00:00Z",
      fetchedAt: "2026-04-28T12:00:00Z",
      items: [{ ...(buildRawEvent() as object), contentHash: "" }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meta: { callerHashMismatches: number } };
    expect(body.meta.callerHashMismatches).toBe(0);
  });

  it("isInitialSnapshot=false is propagated in the diff", async () => {
    // Seed the snapshot first so the next call is non-initial
    await post({
      windowKey: "primary:24h",
      windowMin: "2026-04-28T00:00:00Z",
      windowMax: "2026-04-29T00:00:00Z",
      fetchedAt: "2026-04-28T11:00:00Z",
      items: [buildRawEvent()],
    });
    const res = await post({
      windowKey: "primary:24h",
      windowMin: "2026-04-28T00:00:00Z",
      windowMax: "2026-04-29T00:00:00Z",
      fetchedAt: "2026-04-28T12:00:00Z",
      items: [buildRawEvent()],
      isInitialSnapshot: false,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { diff: { isInitialSnapshot: boolean } };
    expect(body.diff.isInitialSnapshot).toBe(false);
  });
});
