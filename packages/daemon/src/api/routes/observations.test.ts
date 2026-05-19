import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../db/schema.js";
import { createObservationRoutes } from "./observations.js";
import { recordObservation } from "../../db/observations.js";

describe("Observations API routes", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("GET /observations", () => {
    it("returns pending rows with default limit 20", async () => {
      for (let i = 0; i < 3; i++) {
        recordObservation(db, {
          source: "obsidian",
          ref: `notes/${i}.md`,
          changeType: "modified",
          actor: "user",
          payload: { index: i },
        });
      }

      const app = createObservationRoutes({ db } as never);
      const res = await app.request("/observations");
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        observations: Array<{ ref: string; source: string; payload: unknown }>;
        limit: number;
      };
      expect(body.limit).toBe(20);
      expect(body.observations).toHaveLength(3);
      expect(body.observations.every((o) => o.source === "obsidian")).toBe(true);
      expect(body.observations[0].payload).toEqual({ index: 0 });
    });

    it("supports actor and source filters", async () => {
      recordObservation(db, { source: "obsidian", ref: "a.md", changeType: "modified", actor: "user" });
      recordObservation(db, { source: "obsidian", ref: "b.md", changeType: "modified", actor: "agent" });
      recordObservation(db, { source: "git:/repo", ref: "abc", changeType: "created", actor: "user" });

      const app = createObservationRoutes({ db } as never);

      const userRes = await app.request("/observations?actor=user");
      const userBody = (await userRes.json()) as { observations: Array<{ ref: string }> };
      expect(userBody.observations.map((o) => o.ref).sort()).toEqual(["a.md", "abc"]);

      const obsidianRes = await app.request("/observations?source=obsidian");
      const obsidianBody = (await obsidianRes.json()) as { observations: Array<{ ref: string }> };
      expect(obsidianBody.observations).toHaveLength(2);
    });

    it("clamps limit between 1 and 100", async () => {
      for (let i = 0; i < 5; i++) {
        recordObservation(db, {
          source: "obsidian",
          ref: `notes/${i}.md`,
          changeType: "modified",
        });
      }

      const app = createObservationRoutes({ db } as never);

      const lowRes = await app.request("/observations?limit=0");
      const lowBody = (await lowRes.json()) as { limit: number; observations: unknown[] };
      expect(lowBody.limit).toBe(1);
      expect(lowBody.observations).toHaveLength(1);

      const highRes = await app.request("/observations?limit=9999");
      const highBody = (await highRes.json()) as { limit: number };
      expect(highBody.limit).toBe(100);
    });

    it("returns 400 for an invalid actor value", async () => {
      const app = createObservationRoutes({ db } as never);
      const res = await app.request("/observations?actor=bogus");
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; errors: Array<{ code: string }> };
      expect(body.error).toBe("invalid_actor");
      expect(body.errors?.[0]?.code).toBe("observations.invalid_actor");
    });

    // docs/design/appendices/routine-data-acquisition.md §6.7 — the routine pre-pass
    // bodies read merged windows in one shot via `source_prefix=` with a
    // comma-separated prefix list. The route must OR each prefix into a
    // `LIKE '<prefix>%'` predicate.
    it("supports source_prefix= with multiple comma-separated prefixes", async () => {
      recordObservation(db, {
        source: "gmail:acc-1",
        ref: "msg-1",
        changeType: "created",
        actor: "agent",
      });
      recordObservation(db, {
        source: "outlook_mail:acc-2",
        ref: "msg-2",
        changeType: "created",
        actor: "agent",
      });
      recordObservation(db, {
        source: "notion:ws-1",
        ref: "page-1",
        changeType: "modified",
        actor: "agent",
      });

      const app = createObservationRoutes({ db } as never);
      const res = await app.request(
        "/observations?source_prefix=gmail:,outlook_mail:",
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        observations: Array<{ source: string }>;
      };
      const sources = body.observations.map((o) => o.source).sort();
      expect(sources).toEqual(["gmail:acc-1", "outlook_mail:acc-2"]);
    });

    it("source_prefix= takes precedence over source= when both are present", async () => {
      // Defense-in-depth: if a caller passes both, prefer the more
      // expressive multi-prefix form. The single-source filter is
      // ignored rather than AND'd (a logical AND would produce an
      // empty set when the two disagree, which is hard to debug).
      recordObservation(db, {
        source: "gmail:acc-1",
        ref: "msg-1",
        changeType: "created",
        actor: "agent",
      });
      recordObservation(db, {
        source: "outlook_mail:acc-2",
        ref: "msg-2",
        changeType: "created",
        actor: "agent",
      });

      const app = createObservationRoutes({ db } as never);
      const res = await app.request(
        "/observations?source=outlook_mail:&source_prefix=gmail:",
      );
      const body = (await res.json()) as {
        observations: Array<{ source: string }>;
      };
      expect(body.observations.map((o) => o.source)).toEqual(["gmail:acc-1"]);
    });

    it("source_prefix= ignores empty / whitespace-only segments", async () => {
      // `?source_prefix=,gmail:,` would otherwise emit `LIKE '%'`
      // and silently widen the query to every row.
      recordObservation(db, {
        source: "gmail:acc-1",
        ref: "msg-1",
        changeType: "created",
        actor: "agent",
      });
      recordObservation(db, {
        source: "git:/repo",
        ref: "abc",
        changeType: "created",
        actor: "user",
      });

      const app = createObservationRoutes({ db } as never);
      const res = await app.request("/observations?source_prefix=,gmail:,");
      const body = (await res.json()) as {
        observations: Array<{ source: string }>;
      };
      expect(body.observations.map((o) => o.source)).toEqual(["gmail:acc-1"]);
    });

    it("observed_at_after= is honoured as an alias for since=", async () => {
      // Insert two rows at controlled observed_at values; querying
      // with the alias must return only the more recent one.
      db.prepare(
        `INSERT INTO observations (source, ref, change_type, actor, observed_at, summary_status)
         VALUES ('gmail:acc-1', 'old', 'created', 'agent',
                 '2026-05-10 00:00:00', 'pending')`,
      ).run();
      db.prepare(
        `INSERT INTO observations (source, ref, change_type, actor, observed_at, summary_status)
         VALUES ('gmail:acc-1', 'fresh', 'created', 'agent',
                 '2026-05-11 12:00:00', 'pending')`,
      ).run();

      const app = createObservationRoutes({ db } as never);
      const aliasRes = await app.request(
        "/observations?source=gmail:&observed_at_after=2026-05-11T00:00:00.000Z",
      );
      const aliasBody = (await aliasRes.json()) as {
        observations: Array<{ ref: string }>;
      };
      expect(aliasBody.observations.map((o) => o.ref)).toEqual(["fresh"]);

      // Canonical `since=` keeps working unchanged.
      const sinceRes = await app.request(
        "/observations?source=gmail:&since=2026-05-11T00:00:00.000Z",
      );
      const sinceBody = (await sinceRes.json()) as {
        observations: Array<{ ref: string }>;
      };
      expect(sinceBody.observations.map((o) => o.ref)).toEqual(["fresh"]);
    });

    // docs/design/appendices/routine-data-acquisition.md CR2 — silent filtering on
    // bad timestamps is worse than a 400. The canonical behaviour is:
    //   - missing or empty / whitespace-only → no filter applied
    //   - non-empty but unparseable           → 400 with diagnostic
    it("treats an empty since= as no filter (does NOT drop all rows)", async () => {
      recordObservation(db, {
        source: "gmail:acc-1",
        ref: "msg-1",
        changeType: "created",
        actor: "agent",
      });

      const app = createObservationRoutes({ db } as never);
      // Bare `?since=` would map to datetime("") = NULL on the SQL
      // side and silently exclude every row. The route normalises
      // empty / whitespace-only to "no filter".
      const res = await app.request("/observations?since=");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { observations: unknown[] };
      expect(body.observations).toHaveLength(1);

      const wsRes = await app.request("/observations?since=%20%20");
      const wsBody = (await wsRes.json()) as { observations: unknown[] };
      expect(wsBody.observations).toHaveLength(1);
    });

    it("treats an empty observed_at_after= as no filter", async () => {
      recordObservation(db, {
        source: "gmail:acc-1",
        ref: "msg-1",
        changeType: "created",
        actor: "agent",
      });

      const app = createObservationRoutes({ db } as never);
      const res = await app.request("/observations?observed_at_after=");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { observations: unknown[] };
      expect(body.observations).toHaveLength(1);
    });

    it("returns 400 when since= is non-empty but unparseable", async () => {
      const app = createObservationRoutes({ db } as never);
      const res = await app.request("/observations?since=not-a-timestamp");
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: string;
        param: string;
        value: string;
      };
      expect(body.error).toBe("invalid_since");
      expect(body.param).toBe("since");
      expect(body.value).toBe("not-a-timestamp");
    });

    it("returns 400 when observed_at_after= is non-empty but unparseable", async () => {
      const app = createObservationRoutes({ db } as never);
      const res = await app.request("/observations?observed_at_after=garbage");
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; param: string };
      expect(body.error).toBe("invalid_since");
      expect(body.param).toBe("observed_at_after");
    });

    // docs/design/appendices/routine-data-acquisition.md CR4 — every filter in a single
    // request must AND together (no silent OR widening). Routine pre-
    // pass reads typically combine `source_prefix=gmail:,outlook_mail:`
    // with `actor=agent` and `since=<agent_day_start_iso>`; a regression
    // that turned any pair into OR would silently flood the main session
    // with stale or wrong-actor observations.
    it("source_prefix + actor + since compose with AND (no silent OR widening)", async () => {
      // 4 rows differing on one axis each:
      //   - matches all three  → in result
      //   - wrong actor        → excluded by actor=
      //   - wrong source       → excluded by source_prefix=
      //   - too old            → excluded by since=
      db.prepare(
        `INSERT INTO observations (source, ref, change_type, actor, observed_at, summary_status)
         VALUES ('gmail:acc-1', 'match', 'created', 'agent', '2026-05-11 12:00:00', 'pending')`,
      ).run();
      db.prepare(
        `INSERT INTO observations (source, ref, change_type, actor, observed_at, summary_status)
         VALUES ('gmail:acc-1', 'wrong-actor', 'created', 'user', '2026-05-11 12:00:00', 'pending')`,
      ).run();
      db.prepare(
        `INSERT INTO observations (source, ref, change_type, actor, observed_at, summary_status)
         VALUES ('notion:ws-1', 'wrong-source', 'created', 'agent', '2026-05-11 12:00:00', 'pending')`,
      ).run();
      db.prepare(
        `INSERT INTO observations (source, ref, change_type, actor, observed_at, summary_status)
         VALUES ('gmail:acc-1', 'too-old', 'created', 'agent', '2026-05-10 12:00:00', 'pending')`,
      ).run();

      const app = createObservationRoutes({ db } as never);
      const res = await app.request(
        "/observations?source_prefix=gmail:,outlook_mail:"
          + "&actor=agent"
          + "&since=2026-05-11T00:00:00.000Z",
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        observations: Array<{ ref: string }>;
      };
      expect(body.observations.map((o) => o.ref)).toEqual(["match"]);
    });

    it("since= wins when both since= and observed_at_after= are present", async () => {
      // Canonical name takes precedence; the alias is purely a
      // routine-prose ergonomics helper.
      db.prepare(
        `INSERT INTO observations (source, ref, change_type, actor, observed_at, summary_status)
         VALUES ('gmail:acc-1', 'r1', 'created', 'agent',
                 '2026-05-10 12:00:00', 'pending')`,
      ).run();
      db.prepare(
        `INSERT INTO observations (source, ref, change_type, actor, observed_at, summary_status)
         VALUES ('gmail:acc-1', 'r2', 'created', 'agent',
                 '2026-05-11 12:00:00', 'pending')`,
      ).run();

      const app = createObservationRoutes({ db } as never);
      const res = await app.request(
        "/observations?source=gmail:"
          + "&since=2026-05-11T00:00:00.000Z"
          + "&observed_at_after=1970-01-01T00:00:00.000Z",
      );
      const body = (await res.json()) as {
        observations: Array<{ ref: string }>;
      };
      expect(body.observations.map((o) => o.ref)).toEqual(["r2"]);
    });

    it("flags summaries older than 6h relative to observed_at as stale", async () => {
      // Pin observed_at to a fixed past moment, then set summary_at
      // 7 hours after — past the §A staleness gate. A second row with
      // a fresh summary should not be flagged.
      db.prepare(
        `INSERT INTO observations (source, ref, change_type, actor, observed_at, summary_status,
                                   summary_text, novelty_score, summary_at, summary_backend)
         VALUES ('obsidian:external', 'stale.md', 'modified', 'user',
                 '2026-05-06 00:00:00', 'done', 'old', 1, '2026-05-06T07:30:00.000Z', 'claude')`,
      ).run();
      db.prepare(
        `INSERT INTO observations (source, ref, change_type, actor, observed_at, summary_status,
                                   summary_text, novelty_score, summary_at, summary_backend)
         VALUES ('obsidian:external', 'fresh.md', 'modified', 'user',
                 '2026-05-06 00:00:00', 'done', 'fresh', 1, '2026-05-06T01:00:00.000Z', 'claude')`,
      ).run();

      const app = createObservationRoutes({ db } as never);
      const res = await app.request("/observations");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        observations: Array<{ ref: string; summaryStale: boolean }>;
      };
      const byRef = new Map(body.observations.map((o) => [o.ref, o.summaryStale]));
      expect(byRef.get("stale.md")).toBe(true);
      expect(byRef.get("fresh.md")).toBe(false);
    });

    it("returns summaryStale=false when summary_at is not set yet", async () => {
      db.prepare(
        `INSERT INTO observations (source, ref, change_type, actor, observed_at, summary_status)
         VALUES ('obsidian:external', 'pending.md', 'modified', 'user',
                 '2026-05-06 00:00:00', 'pending')`,
      ).run();

      const app = createObservationRoutes({ db } as never);
      const res = await app.request("/observations");
      const body = (await res.json()) as {
        observations: Array<{ summaryStale: boolean }>;
      };
      expect(body.observations[0].summaryStale).toBe(false);
    });
  });

  describe("POST /observations (record agent-originated)", () => {
    it("records a roadmap_candidate observation with defaults", async () => {
      const app = createObservationRoutes({ db } as never);
      const res = await app.request("/observations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "roadmap_candidate:travel",
          ref: "trip-kyoto-2026-summer",
          payload: { note: "DM mentioned Kyoto trip this summer" },
        }),
      });
      expect(res.status).toBe(200);
      // INTEGRATION_NATIVE_MODE_DESIGN.md §8.3 — the server computes a
      // canonical `contentHash` over `source + payload` so pollers,
      // delegated-sync-worker, and native-mode in-turn writes all dedup
      // against the same hash. The route returns it in the response so
      // the caller can record-and-verify without re-querying.
      const body = (await res.json()) as { ok: boolean; contentHash: string };
      expect(body.ok).toBe(true);
      expect(body.contentHash).toMatch(/^[0-9a-f]{64}$/);

      const row = db
        .prepare("SELECT source, ref, change_type, actor, payload FROM observations")
        .get() as {
        source: string;
        ref: string;
        change_type: string;
        actor: string;
        payload: string;
      };
      expect(row.source).toBe("roadmap_candidate:travel");
      expect(row.actor).toBe("agent");
      expect(row.change_type).toBe("created");
      expect(JSON.parse(row.payload)).toEqual({
        note: "DM mentioned Kyoto trip this summer",
      });
    });

    it("rejects user-actor writes (forgery guard)", async () => {
      const app = createObservationRoutes({ db } as never);
      const res = await app.request("/observations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "obsidian",
          ref: "fake.md",
          actor: "user",
        }),
      });
      expect(res.status).toBe(400);
      // Body shape now carries an explanatory `message` + `hint` alongside
      // the `error` code (2026-05 cost-spike fix). Match on the
      // discriminator, not on the full body.
      expect(((await res.json()) as { error: string }).error).toBe("invalid_actor");
    });

    it("rejects invalid changeType", async () => {
      const app = createObservationRoutes({ db } as never);
      const res = await app.request("/observations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "roadmap_candidate",
          ref: "x",
          changeType: "not-a-type",
        }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(
        "invalid_change_type",
      );
    });

    it("rejects missing source or ref", async () => {
      const app = createObservationRoutes({ db } as never);
      const res = await app.request("/observations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "x" }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(
        "validation_error",
      );
    });

    it("UPSERTs on (source, ref) for pending rows — idempotent across ticks", async () => {
      const app = createObservationRoutes({ db } as never);
      const first = await app.request("/observations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "roadmap_candidate:dm",
          ref: "trip-osaka",
          payload: { round: 1 },
        }),
      });
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as { action: string };
      expect(firstBody.action).toBe("created");

      const second = await app.request("/observations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "roadmap_candidate:dm",
          ref: "trip-osaka",
          payload: { round: 2 },
        }),
      });
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as { action: string };
      expect(secondBody.action).toBe("modified");

      const rows = db
        .prepare("SELECT payload FROM observations WHERE ref = 'trip-osaka'")
        .all() as Array<{ payload: string }>;
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0].payload)).toEqual({ round: 2 });
    });

    // docs/design/appendices/routine-data-acquisition.md CR1 — the routine pre-pass
    // fetcher's `<fetch_report>` JSON shape carries a `duplicates`
    // counter sourced from 409 responses. The route must produce 409
    // with `error: "duplicate"` when a pending row with an identical
    // payload already exists. Distinct from the §11.3.1
    // `integration_flip_in_progress` 409 — the `error` body field is
    // what disambiguates.
    it("returns 409 error=\"duplicate\" when (source, ref, payload) is identical to a pending row", async () => {
      const app = createObservationRoutes({ db } as never);
      const payload = { subject: "Q2 plan", from: "alice@example.com" };

      const first = await app.request("/observations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "gmail:acc-1",
          ref: "msg-1",
          payload,
        }),
      });
      expect(first.status).toBe(200);

      const replay = await app.request("/observations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "gmail:acc-1",
          ref: "msg-1",
          payload,
        }),
      });
      expect(replay.status).toBe(409);
      const replayBody = (await replay.json()) as {
        error: string;
        contentHash: string;
        id: number;
      };
      expect(replayBody.error).toBe("duplicate");
      expect(replayBody.contentHash).toMatch(/^[0-9a-f]{64}$/);
      // The hash returned on dedup must match the hash returned on the
      // original write — that's the invariant the partial body relies on
      // when surfacing duplicates in the report.
      const firstBody = (await first.json()) as { contentHash: string };
      expect(replayBody.contentHash).toBe(firstBody.contentHash);

      // No second row written.
      const rows = db
        .prepare("SELECT id FROM observations")
        .all() as Array<{ id: number }>;
      expect(rows).toHaveLength(1);
    });

    it("dedup is order-invariant under canonical payload hashing", async () => {
      // Object key order should not matter — `canonicalStringify` sorts
      // keys at every depth. Re-posting the same payload with reordered
      // keys must still surface as a 409 duplicate.
      const app = createObservationRoutes({ db } as never);
      const first = await app.request("/observations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "gmail:acc-1",
          ref: "msg-1",
          payload: { a: 1, b: 2, c: { x: true, y: false } },
        }),
      });
      expect(first.status).toBe(200);

      const reordered = await app.request("/observations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "gmail:acc-1",
          ref: "msg-1",
          payload: { c: { y: false, x: true }, b: 2, a: 1 },
        }),
      });
      expect(reordered.status).toBe(409);
      expect(((await reordered.json()) as { error: string }).error).toBe(
        "duplicate",
      );
    });

    it("a re-post after consume creates a fresh row (UNIQUE index is pending-scoped)", async () => {
      // The UNIQUE index is `(source, ref) WHERE consumed_at IS NULL` —
      // consumed rows don't block a new write. CR1's dedup short-circuit
      // must respect this and let the new INSERT through.
      const app = createObservationRoutes({ db } as never);
      const first = await app.request("/observations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "gmail:acc-1",
          ref: "msg-1",
          payload: { v: 1 },
        }),
      });
      expect(first.status).toBe(200);
      const firstId = ((await first.json()) as { id: number }).id;

      // Consume the row.
      await app.request("/observations/consume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [firstId], correlationId: "x" }),
      });

      // Same payload should INSERT a fresh row, not 409.
      const replay = await app.request("/observations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "gmail:acc-1",
          ref: "msg-1",
          payload: { v: 1 },
        }),
      });
      expect(replay.status).toBe(200);
      const replayBody = (await replay.json()) as { action: string; id: number };
      expect(replayBody.action).toBe("created");
      expect(replayBody.id).not.toBe(firstId);
    });

    it("dedup does NOT re-enqueue the summarizer (unchanged payload, no work)", async () => {
      // CR1 / cost-reduction-structural §A — the legacy UPSERT cleared
      // summary_text on every identical re-post and re-enqueued the
      // summarizer, wasting Haiku turns. The dedup short-circuit must
      // skip the write AND the enqueue when nothing changed.
      let enqueueCalls = 0;
      const { setObservationEnqueueHook } = await import(
        "../../db/observations.js"
      );
      setObservationEnqueueHook(() => {
        enqueueCalls += 1;
      });

      const app = createObservationRoutes({ db } as never);
      await app.request("/observations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "gmail:acc-1",
          ref: "msg-1",
          payload: { v: 1 },
        }),
      });
      const afterFirst = enqueueCalls;
      expect(afterFirst).toBe(1);

      await app.request("/observations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "gmail:acc-1",
          ref: "msg-1",
          payload: { v: 1 },
        }),
      });
      // No new enqueue on dedup.
      expect(enqueueCalls).toBe(afterFirst);

      setObservationEnqueueHook(null);
    });
  });

  describe("POST /observations/batch", () => {
    // The endpoint exists so the routine.fetch_window pre-pass can post
    // many observations from a single Bash curl call. The bashCurlHook
    // caps each Bash invocation at one HTTP request and strips heredoc
    // content from URL extraction, which collectively block every shell
    // batching shape Haiku reaches for. The tests below pin the on-wire
    // contract the pre-pass partials depend on.

    it("records multiple observations in one transaction and reports per-item results", async () => {
      const app = createObservationRoutes({ db } as never);
      const res = await app.request("/observations/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          observations: [
            {
              source: "google_calendar:primary",
              ref: "evt-1",
              payload: { kind: "calendar", providerId: "primary", raw: { title: "A" } },
            },
            {
              source: "google_calendar:primary",
              ref: "evt-2",
              payload: { kind: "calendar", providerId: "primary", raw: { title: "B" } },
            },
            {
              source: "gmail:acc-1",
              ref: "msg-1",
              changeType: "created",
              payload: { kind: "mail", from: "alice@example.com" },
            },
          ],
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: Array<{ index: number; status: string; contentHash?: string; id?: number }>;
        fetched: number;
        posted: number;
        duplicates: number;
        errors: number;
      };
      expect(body.fetched).toBe(3);
      expect(body.posted).toBe(3);
      expect(body.duplicates).toBe(0);
      expect(body.errors).toBe(0);
      expect(body.results).toHaveLength(3);
      expect(body.results.every((r) => r.status === "created")).toBe(true);
      expect(body.results.every((r) => /^[0-9a-f]{64}$/.test(r.contentHash ?? ""))).toBe(true);

      const rows = db
        .prepare("SELECT source, ref FROM observations ORDER BY id")
        .all() as Array<{ source: string; ref: string }>;
      expect(rows).toHaveLength(3);
    });

    it("counts duplicates and continues past them", async () => {
      // Seed an identical-payload row so the second-batch entry collides.
      recordObservation(db, {
        source: "gmail:acc-1",
        ref: "msg-1",
        changeType: "created",
        actor: "agent",
        payload: { subject: "Q2" },
      });

      const app = createObservationRoutes({ db } as never);
      const res = await app.request("/observations/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          observations: [
            { source: "gmail:acc-1", ref: "msg-1", payload: { subject: "Q2" } },
            { source: "gmail:acc-1", ref: "msg-2", payload: { subject: "Q3" } },
          ],
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: Array<{ status: string; ref?: string }>;
        posted: number;
        duplicates: number;
        errors: number;
      };
      expect(body.posted).toBe(1);
      expect(body.duplicates).toBe(1);
      expect(body.errors).toBe(0);
      const dup = body.results.find((r) => r.ref === "msg-1");
      const fresh = body.results.find((r) => r.ref === "msg-2");
      expect(dup?.status).toBe("duplicate");
      expect(fresh?.status).toBe("created");
    });

    it("validates per-item and continues past validation errors", async () => {
      const app = createObservationRoutes({ db } as never);
      const res = await app.request("/observations/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          observations: [
            { source: "gmail:acc-1", ref: "msg-1", payload: { v: 1 } },
            { source: "", ref: "msg-2" }, // empty source
            { source: "gmail:acc-1" }, // missing ref
            { source: "gmail:acc-1", ref: "msg-3", actor: "user" }, // forged actor
            { source: "gmail:acc-1", ref: "msg-4", changeType: "weird" }, // bad changeType
            "not-an-object",
          ],
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: Array<{ index: number; status: string; error?: string }>;
        fetched: number;
        posted: number;
        errors: number;
      };
      expect(body.fetched).toBe(6);
      expect(body.posted).toBe(1);
      expect(body.errors).toBe(5);
      // The lone good row landed; the rest are validation_error with a
      // distinct `error` string per category so the agent can correct
      // the malformed entries without re-sending the whole batch.
      const errorsByIdx = new Map(body.results.map((r) => [r.index, r]));
      expect(errorsByIdx.get(0)?.status).toBe("created");
      expect(errorsByIdx.get(1)?.status).toBe("validation_error");
      expect(errorsByIdx.get(2)?.status).toBe("validation_error");
      expect(errorsByIdx.get(3)?.status).toBe("validation_error");
      expect(errorsByIdx.get(4)?.status).toBe("validation_error");
      expect(errorsByIdx.get(5)?.status).toBe("validation_error");

      const rows = db
        .prepare("SELECT ref FROM observations")
        .all() as Array<{ ref: string }>;
      expect(rows.map((r) => r.ref)).toEqual(["msg-1"]);
    });

    it("returns 200 with empty results for an empty observations array", async () => {
      const app = createObservationRoutes({ db } as never);
      const res = await app.request("/observations/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ observations: [] }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: unknown[];
        fetched: number;
        posted: number;
        duplicates: number;
        errors: number;
      };
      expect(body.results).toEqual([]);
      expect(body.fetched).toBe(0);
      expect(body.posted).toBe(0);
      expect(body.duplicates).toBe(0);
      expect(body.errors).toBe(0);
    });

    it("returns 400 when 'observations' is missing or not an array", async () => {
      const app = createObservationRoutes({ db } as never);

      const missing = await app.request("/observations/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(missing.status).toBe(400);
      const missingBody = (await missing.json()) as { error: string; hint?: string };
      expect(missingBody.error).toBe("validation_error");
      // Hint must steer the caller to the `observations` envelope so a
      // bare-array body (a common LLM mistake) self-corrects on retry.
      expect(missingBody.hint).toContain("observations");

      const notArray = await app.request("/observations/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ observations: { source: "x", ref: "y" } }),
      });
      expect(notArray.status).toBe(400);
    });

    it("returns 400 when batch size exceeds maximum", async () => {
      const app = createObservationRoutes({ db } as never);
      const oversized = Array.from({ length: 201 }, (_, i) => ({
        source: "gmail:acc-1",
        ref: `msg-${i}`,
        payload: { i },
      }));
      const res = await app.request("/observations/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ observations: oversized }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; maxItems: number };
      expect(body.error).toBe("batch_too_large");
      expect(body.maxItems).toBe(200);
    });

    it("returns 400 on malformed JSON envelope", async () => {
      const app = createObservationRoutes({ db } as never);
      const res = await app.request("/observations/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; example?: string };
      expect(body.error).toBe("invalid_json_body");
      expect(body.example).toContain("observations");
    });
  });

  describe("POST /observations/consume", () => {
    it("marks the provided ids as consumed and returns count", async () => {
      recordObservation(db, { source: "obsidian", ref: "1.md", changeType: "modified" });
      recordObservation(db, { source: "obsidian", ref: "2.md", changeType: "modified" });
      const ids = (
        db.prepare("SELECT id FROM observations ORDER BY id").all() as Array<{ id: number }>
      ).map((r) => r.id);

      const app = createObservationRoutes({ db } as never);
      const res = await app.request("/observations/consume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, correlationId: "corr-999" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ consumed: 2, notFound: [] });

      const consumedRows = db
        .prepare("SELECT consumed_by FROM observations WHERE consumed_at IS NOT NULL")
        .all() as Array<{ consumed_by: string }>;
      expect(consumedRows).toHaveLength(2);
      expect(consumedRows.every((r) => r.consumed_by === "corr-999")).toBe(true);
    });

    it("returns 400 when body shape is invalid", async () => {
      const app = createObservationRoutes({ db } as never);

      const missing = await app.request("/observations/consume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [1, 2] }), // missing correlationId
      });
      expect(missing.status).toBe(400);

      const wrongType = await app.request("/observations/consume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [1, "not-a-number"], correlationId: "c" }),
      });
      expect(wrongType.status).toBe(400);
    });

    // 2026-05 cost-spike fix: the legacy `{ error: "validation_error" }`
    // body gave the agent zero signal about which field was wrong, so
    // a single Stage-3 hourly_check burned 8 retries on this endpoint
    // ($0.58, 25 turns). The contract below guarantees every 400 carries
    // an `issues` array naming the offending field, an `expectedShape`,
    // and a concrete `example` the agent can copy-paste.
    it("400 body names the missing correlationId issue", async () => {
      const app = createObservationRoutes({ db } as never);
      const res = await app.request("/observations/consume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [1, 2] }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: string;
        expectedShape: string;
        example: string;
        issues: Array<{ field: string; hint?: string }>;
      };
      expect(body.error).toBe("validation_error");
      expect(body.expectedShape).toContain("correlationId");
      expect(body.example).toContain("correlationId");
      const fields = body.issues.map((i) => i.field);
      expect(fields).toContain("correlationId");
    });

    it("400 body flags snake_case 'correlation_id' with a rename hint", async () => {
      const app = createObservationRoutes({ db } as never);
      const res = await app.request("/observations/consume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [1], correlation_id: "x" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        issues: Array<{ field: string; got: string; hint?: string }>;
      };
      const issue = body.issues.find((i) => i.field === "correlationId");
      expect(issue).toBeDefined();
      expect(issue!.got).toContain("snake_case");
      expect(issue!.hint).toContain("camelCase");
    });

    it("400 body flags stringified ids", async () => {
      const app = createObservationRoutes({ db } as never);
      const res = await app.request("/observations/consume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: ["14", "17"], correlationId: "c" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        issues: Array<{ field: string; got: string; hint?: string }>;
      };
      const issue = body.issues.find((i) => i.field === "ids");
      expect(issue).toBeDefined();
      expect(issue!.got).toContain("strings");
    });

    it("400 body flags the angle-bracket placeholder", async () => {
      const app = createObservationRoutes({ db } as never);
      const res = await app.request("/observations/consume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ids: [1],
          correlationId: "<event_correlation_id>",
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        issues: Array<{ field: string; got: string; hint?: string }>;
      };
      const issue = body.issues.find((i) => i.field === "correlationId");
      expect(issue).toBeDefined();
      expect(issue!.got).toContain("placeholder");
    });

    // Empty ids array is a documented no-op — the legacy behaviour
    // `consumeObservations` already short-circuited at length 0 and the
    // existing "additional branches" test below asserts the 200 path.
    // The validator deliberately does NOT reject empty arrays so callers
    // that compose ids dynamically can pass an empty list without a
    // special case.

    it("400 body when the root is not an object", async () => {
      const app = createObservationRoutes({ db } as never);
      const res = await app.request("/observations/consume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([1, 2, 3]),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; expectedShape: string };
      expect(body.error).toBe("validation_error");
      expect(body.expectedShape).toContain("correlationId");
    });

    it("returns notFound for already-consumed ids", async () => {
      recordObservation(db, { source: "obsidian", ref: "1.md", changeType: "modified" });
      const id = (
        db.prepare("SELECT id FROM observations LIMIT 1").get() as { id: number }
      ).id;

      const app = createObservationRoutes({ db } as never);
      await app.request("/observations/consume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [id], correlationId: "first" }),
      });
      const res = await app.request("/observations/consume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [id], correlationId: "second" }),
      });
      const body = (await res.json()) as { consumed: number; notFound: number[] };
      expect(body.consumed).toBe(0);
      expect(body.notFound).toEqual([id]);
    });
  });

  describe("Observations helpful method-mismatch handlers", () => {
    // The per-id consume path used to 404 with body "404 Not Found" and
    // GET on the bulk path did the same. Telemetry shows the agent
    // retried 10+ times before giving up — these handlers exist purely
    // to short-circuit that loop.
    it("POST /observations/:id/consume returns 405 with a bulk-endpoint hint", async () => {
      const app = createObservationRoutes({ db } as never);
      const res = await app.request("/observations/14/consume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ correlationId: "c" }),
      });
      expect(res.status).toBe(405);
      const body = (await res.json()) as {
        error: string;
        hint: string;
        example: string;
      };
      expect(body.error).toBe("use_bulk_endpoint");
      expect(body.hint).toContain("POST /api/observations/consume");
      expect(body.hint).toContain("[14]");
    });

    it("GET /observations/:id/consume also 405s via the all() handler", async () => {
      const app = createObservationRoutes({ db } as never);
      const res = await app.request("/observations/14/consume", {
        method: "GET",
      });
      expect(res.status).toBe(405);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("use_bulk_endpoint");
    });

    it("GET /observations/consume returns 405 method_not_allowed with Allow header", async () => {
      const app = createObservationRoutes({ db } as never);
      const res = await app.request("/observations/consume", {
        method: "GET",
      });
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("POST");
      const body = (await res.json()) as {
        error: string;
        hint: string;
      };
      expect(body.error).toBe("method_not_allowed");
      expect(body.hint).toContain("POST /api/observations/consume");
    });
  });

  describe("POST /observations method-confusion guard", () => {
    // The agent sent `POST /api/observations` with body `limit=30`
    // expecting it to fetch. Forwarding readJsonBody's generic
    // "Unexpected token 'l'" gave it no signal that the right call was
    // a GET — and it then retried POST with random variants.
    it("returns method_confusion with a GET hint when body looks like a query string", async () => {
      const app = createObservationRoutes({ db } as never);
      const res = await app.request("/observations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "limit=30",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: string;
        hint: string;
      };
      expect(body.error).toBe("method_confusion");
      expect(body.hint).toContain("GET /api/observations?limit=30");
    });

    it("still validates real JSON bodies with field-level issues", async () => {
      const app = createObservationRoutes({ db } as never);
      const res = await app.request("/observations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref: "x" }), // missing source
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: string;
        issues: Array<{ field: string }>;
      };
      expect(body.error).toBe("validation_error");
      expect(body.issues.map((i) => i.field)).toContain("source");
    });

    it("invalid_change_type and invalid_actor carry a hint", async () => {
      const app = createObservationRoutes({ db } as never);
      const badType = await app.request("/observations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "roadmap_candidate:x",
          ref: "r",
          changeType: "bogus",
        }),
      });
      expect(badType.status).toBe(400);
      const typeBody = (await badType.json()) as { error: string; hint: string };
      expect(typeBody.error).toBe("invalid_change_type");
      expect(typeBody.hint).toBeTruthy();

      const badActor = await app.request("/observations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "roadmap_candidate:x",
          ref: "r",
          actor: "user",
        }),
      });
      expect(badActor.status).toBe(400);
      const actorBody = (await badActor.json()) as { error: string; hint: string };
      expect(actorBody.error).toBe("invalid_actor");
      expect(actorBody.hint).toBeTruthy();
    });
  });

  describe("GET /observations/stats", () => {
    it("returns total and by-source pending breakdown", async () => {
      recordObservation(db, { source: "obsidian", ref: "1.md", changeType: "modified" });
      recordObservation(db, { source: "obsidian", ref: "2.md", changeType: "created" });
      recordObservation(db, { source: "git:/repo", ref: "abc", changeType: "created" });

      const app = createObservationRoutes({ db } as never);
      const res = await app.request("/observations/stats");
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        totalPending: number;
        bySource: Array<{ source: string; pendingCount: number }>;
      };
      expect(body.totalPending).toBe(3);
      expect(body.bySource.find((s) => s.source === "obsidian")?.pendingCount).toBe(2);
      expect(body.bySource.find((s) => s.source === "git:/repo")?.pendingCount).toBe(1);
    });
  });

  describe("GET /observations — additional branches", () => {
    it("returns all observations including consumed ones when pending=false", async () => {
      recordObservation(db, { source: "obsidian", ref: "1.md", changeType: "modified" });
      recordObservation(db, { source: "obsidian", ref: "2.md", changeType: "created" });

      // Consume the first observation
      const id = (db.prepare("SELECT id FROM observations ORDER BY id LIMIT 1").get() as { id: number }).id;
      db.prepare("UPDATE observations SET consumed_at = datetime('now'), consumed_by = 'test' WHERE id = ?").run(id);

      const app = createObservationRoutes({ db } as never);
      const res = await app.request("/observations?pending=false");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { observations: unknown[] };
      // Both pending and consumed rows returned
      expect(body.observations).toHaveLength(2);
    });

    it("respects offset parameter to skip rows", async () => {
      for (let i = 0; i < 3; i++) {
        recordObservation(db, { source: "obsidian", ref: `${i}.md`, changeType: "modified" });
      }

      const app = createObservationRoutes({ db } as never);
      const res = await app.request("/observations?offset=2");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { observations: unknown[] };
      expect(body.observations).toHaveLength(1);
    });

    it("filters by since parameter", async () => {
      // Insert two observations at different times
      db.prepare(
        `INSERT INTO observations (source, ref, change_type, actor, observed_at)
         VALUES ('obsidian', 'old.md', 'modified', 'user', '2026-01-01 00:00:00')`,
      ).run();
      db.prepare(
        `INSERT INTO observations (source, ref, change_type, actor, observed_at)
         VALUES ('obsidian', 'new.md', 'modified', 'user', '2026-06-01 00:00:00')`,
      ).run();

      const app = createObservationRoutes({ db } as never);
      const res = await app.request("/observations?since=2026-03-01T00:00:00Z");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { observations: Array<{ ref: string }> };
      expect(body.observations).toHaveLength(1);
      expect(body.observations[0].ref).toBe("new.md");
    });

    it("returns raw string for invalid JSON payload", async () => {
      // Insert row with invalid JSON payload directly
      db.prepare(
        `INSERT INTO observations (source, ref, change_type, actor, payload, observed_at)
         VALUES ('obsidian', 'broken.md', 'modified', 'user', 'invalid{json', '2026-05-01 00:00:00')`,
      ).run();

      const app = createObservationRoutes({ db } as never);
      const res = await app.request("/observations");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        observations: Array<{ ref: string; payload: unknown }>;
      };
      const brokenRow = body.observations.find((o) => o.ref === "broken.md");
      // parsePayload catch path: returns the raw string when JSON.parse fails
      expect(brokenRow?.payload).toBe("invalid{json");
    });

    it("returns summaryStale=false when observed_at is invalid (non-T format)", async () => {
      // 'bad-date' doesn't contain 'T' so it goes through the SQLite-format branch
      // and Date.parse('bad-dateT...Z') returns NaN → parseSqliteTimestampMs returns null
      db.prepare(
        `INSERT INTO observations (source, ref, change_type, actor, observed_at, summary_at, summary_status)
         VALUES ('obsidian', 'badts.md', 'modified', 'user', 'bad-date', '2026-01-01T00:00:00Z', 'done')`,
      ).run();

      const app = createObservationRoutes({ db } as never);
      const res = await app.request("/observations");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        observations: Array<{ ref: string; summaryStale: boolean }>;
      };
      const row = body.observations.find((o) => o.ref === "badts.md");
      // When observed_at cannot be parsed, isSummaryStale returns false
      expect(row?.summaryStale).toBe(false);
    });

    it("returns summaryStale=false when summary_at contains T but is invalid ISO-8601", async () => {
      // summary_at contains 'T' so parseSqliteTimestampMs uses Date.parse directly.
      // An invalid ISO-8601 with T returns NaN → returns null → isSummaryStale returns false.
      db.prepare(
        `INSERT INTO observations (source, ref, change_type, actor, observed_at, summary_at, summary_status)
         VALUES ('obsidian', 'badiso.md', 'modified', 'user', '2026-05-01 00:00:00', 'not-T-valid-T-iso', 'done')`,
      ).run();

      const app = createObservationRoutes({ db } as never);
      const res = await app.request("/observations");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        observations: Array<{ ref: string; summaryStale: boolean }>;
      };
      const row = body.observations.find((o) => o.ref === "badiso.md");
      // parseSqliteTimestampMs("not-T-valid-T-iso") → contains "T" → Date.parse returns NaN → null
      expect(row?.summaryStale).toBe(false);
    });
  });

  describe("POST /observations — additional branches", () => {
    it("records an observation with changeType: modified explicitly", async () => {
      const app = createObservationRoutes({ db } as never);
      const res = await app.request("/observations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "obsidian",
          ref: "modified-file.md",
          changeType: "modified",
        }),
      });
      expect(res.status).toBe(200);
      const row = db
        .prepare("SELECT change_type FROM observations WHERE ref = 'modified-file.md'")
        .get() as { change_type: string } | undefined;
      expect(row?.change_type).toBe("modified");
    });

    it("records an observation with changeType: deleted explicitly", async () => {
      const app = createObservationRoutes({ db } as never);
      const res = await app.request("/observations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "obsidian",
          ref: "deleted-file.md",
          changeType: "deleted",
        }),
      });
      expect(res.status).toBe(200);
      const row = db
        .prepare("SELECT change_type FROM observations WHERE ref = 'deleted-file.md'")
        .get() as { change_type: string } | undefined;
      expect(row?.change_type).toBe("deleted");
    });

    it("records an observation with actor: system", async () => {
      const app = createObservationRoutes({ db } as never);
      const res = await app.request("/observations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "system-monitor",
          ref: "system-event",
          actor: "system",
        }),
      });
      expect(res.status).toBe(200);
      const row = db
        .prepare("SELECT actor FROM observations WHERE ref = 'system-event'")
        .get() as { actor: string } | undefined;
      expect(row?.actor).toBe("system");
    });

    it("returns 400 when changeType is a number (non-string, non-undefined)", async () => {
      const app = createObservationRoutes({ db } as never);
      const res = await app.request("/observations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "obsidian",
          ref: "test.md",
          changeType: 123,
        }),
      });
      expect(res.status).toBe(400);
      // Body shape now includes `issues` + `expectedShape` + `example`
      // (2026-05 cost-spike fix). Match on the discriminator and on the
      // presence of the field-level issue.
      const body = (await res.json()) as {
        error: string;
        issues?: Array<{ field: string }>;
      };
      expect(body.error).toBe("validation_error");
      expect(body.issues?.map((i) => i.field)).toContain("changeType");
    });

    it("returns 400 for invalid JSON body (not-ok readJsonBody)", async () => {
      const app = createObservationRoutes({ db } as never);
      const res = await app.request("/observations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ not valid json }",
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("invalid_json_body");
    });
  });

  describe("POST /observations/consume — additional branches", () => {
    it("returns consumed: 0 and notFound: [] when ids array is empty", async () => {
      const app = createObservationRoutes({ db } as never);
      const res = await app.request("/observations/consume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [], correlationId: "empty-consume" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ consumed: 0, notFound: [] });
    });

    it("returns 400 for invalid JSON body (not-ok readJsonBody)", async () => {
      const app = createObservationRoutes({ db } as never);
      const res = await app.request("/observations/consume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ not valid json }",
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("invalid_json_body");
    });
  });

  // HOURLY_CHECK_GATE_REDESIGN_PLAN.md Phase 3 — pre-pass mail payload
  // normalization. Gmail / Outlook pre-pass partials POST
  // `{kind, providerId, raw: {subject, from, snippet, date}}`; the
  // chokepoint augments with `is_read=0` + `from_email=<lower>` so the
  // gate's vipMailUnreadCount query reads a single canonical shape.
  describe("POST /observations — mail payload normalization", () => {
    it("attaches is_read=0 and from_email when posting a gmail pre-pass payload", async () => {
      const app = createObservationRoutes({ db } as never);
      const res = await app.request("/observations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "gmail:default",
          ref: "msg-vip",
          changeType: "created",
          actor: "agent",
          payload: {
            kind: "mail",
            providerId: "default",
            raw: { subject: "Hi", from: "VIP <vip@example.com>", snippet: "" },
          },
        }),
      });
      expect(res.status).toBe(200);
      const row = db
        .prepare("SELECT payload FROM observations WHERE ref = 'msg-vip'")
        .get() as { payload: string };
      const parsed = JSON.parse(row.payload) as {
        is_read?: number;
        from_email?: string;
        raw?: { from?: string };
      };
      expect(parsed.is_read).toBe(0);
      expect(parsed.from_email).toBe("vip@example.com");
      // Original `raw.from` is preserved verbatim.
      expect(parsed.raw?.from).toBe("VIP <vip@example.com>");
    });

    it("passes non-mail observations through verbatim", async () => {
      const app = createObservationRoutes({ db } as never);
      const res = await app.request("/observations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "obsidian:primary",
          ref: "notes/a.md",
          changeType: "modified",
          actor: "agent",
          payload: { snippet: "edit" },
        }),
      });
      expect(res.status).toBe(200);
      const row = db
        .prepare("SELECT payload FROM observations WHERE ref = 'notes/a.md'")
        .get() as { payload: string };
      const parsed = JSON.parse(row.payload) as Record<string, unknown>;
      expect(parsed).toEqual({ snippet: "edit" });
    });

    it("passes mail payloads without raw.from through verbatim", async () => {
      // Direct-mode aggregate `mail:lifecycle` rows or ad-hoc agent
      // posts that don't match the partial contract must not get
      // synthetic keys grafted on — that would corrupt the dedup hash
      // against any other writer.
      const app = createObservationRoutes({ db } as never);
      const res = await app.request("/observations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "gmail:default",
          ref: "lifecycle-1",
          changeType: "modified",
          actor: "agent",
          payload: { kind: "mail", providerId: "default" },
        }),
      });
      expect(res.status).toBe(200);
      const row = db
        .prepare("SELECT payload FROM observations WHERE ref = 'lifecycle-1'")
        .get() as { payload: string };
      const parsed = JSON.parse(row.payload) as Record<string, unknown>;
      expect(parsed).toEqual({ kind: "mail", providerId: "default" });
    });
  });
});
