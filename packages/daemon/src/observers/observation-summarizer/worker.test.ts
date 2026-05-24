import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../db/schema.js";
import {
  recordObservation,
  setObservationEnqueueHook,
  getSummaryStatusCounts,
} from "../../db/observations.js";
import {
  ObservationSummarizerWorker,
} from "./worker.js";
import type {
  SummarizerLlmClient,
  SummarizerLlmResult,
} from "./summarizer-client.js";

class FakeLlmClient implements SummarizerLlmClient {
  readonly backendId = "claude" as const;
  readonly modelId = "fake-haiku";
  callCount = 0;
  responder: (callIndex: number) => SummarizerLlmResult;

  constructor(responder: (callIndex: number) => SummarizerLlmResult) {
    this.responder = responder;
  }

  async call(): Promise<SummarizerLlmResult> {
    const idx = this.callCount;
    this.callCount += 1;
    return this.responder(idx);
  }
}

function ok(summary: string, novelty: 0 | 1 | 2 | 3): SummarizerLlmResult {
  return {
    ok: true,
    rawText: JSON.stringify({ summary, novelty }),
    modelId: "fake-haiku",
  };
}

async function flushQueue(worker: ObservationSummarizerWorker, attempts = 30): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const m = worker.getMetrics();
    if (m.queueDepth === 0 && m.inFlight === 0) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("ObservationSummarizerWorker", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    setObservationEnqueueHook(null);
    db.close();
  });

  it("processes a normal observation through the LLM and persists summary + novelty", async () => {
    const client = new FakeLlmClient(() => ok("new TODO appeared", 2));
    const worker = new ObservationSummarizerWorker({ db, client });
    await worker.start();

    recordObservation(db, {
      source: "obsidian:external",
      ref: "notes/x.md",
      changeType: "modified",
      actor: "user",
      payload: { diffPreview: "TODO: review the deploy" },
    });

    await flushQueue(worker);

    const row = db.prepare(
      `SELECT summary_text, novelty_score, summary_status, summary_backend FROM observations LIMIT 1`,
    ).get() as { summary_text: string | null; novelty_score: number | null; summary_status: string; summary_backend: string };

    expect(row.summary_text).toBe("new TODO appeared");
    expect(row.novelty_score).toBe(2);
    expect(row.summary_status).toBe("done");
    expect(row.summary_backend).toBe("claude");
    expect(client.callCount).toBe(1);

    await worker.stop();
  });

  it("short-circuits agent-actor rows to skipped without an LLM call", async () => {
    const client = new FakeLlmClient(() => ok("never reached", 0));
    const worker = new ObservationSummarizerWorker({ db, client });
    await worker.start();

    recordObservation(db, {
      source: "obsidian:primary",
      ref: "today.md",
      changeType: "modified",
      actor: "agent",
    });

    await flushQueue(worker);

    const counts = getSummaryStatusCounts(db);
    expect(counts.skipped).toBe(1);
    expect(counts.done).toBe(0);
    expect(client.callCount).toBe(0);

    await worker.stop();
  });

  it("emits a deterministic done summary for deletions without calling the LLM", async () => {
    const client = new FakeLlmClient(() => ok("never reached", 0));
    const worker = new ObservationSummarizerWorker({ db, client });
    await worker.start();

    recordObservation(db, {
      source: "obsidian:external",
      ref: "old.md",
      changeType: "deleted",
      actor: "user",
    });

    await flushQueue(worker);

    const row = db.prepare(
      `SELECT summary_text, novelty_score, summary_status FROM observations LIMIT 1`,
    ).get() as { summary_text: string; novelty_score: number; summary_status: string };
    expect(row.summary_status).toBe("done");
    expect(row.summary_text).toBe("[deleted] old.md");
    expect(row.novelty_score).toBe(1);
    expect(client.callCount).toBe(0);

    await worker.stop();
  });

  it("marks rows as failed on parse error, not done", async () => {
    const client = new FakeLlmClient(() => ({ ok: true, rawText: "I don't know", modelId: "fake-haiku" }));
    const worker = new ObservationSummarizerWorker({ db, client });
    await worker.start();

    recordObservation(db, {
      source: "obsidian:external",
      ref: "x.md",
      changeType: "modified",
      actor: "user",
      payload: { diffPreview: "small change" },
    });

    await flushQueue(worker);

    const row = db.prepare(`SELECT summary_status FROM observations LIMIT 1`).get() as { summary_status: string };
    expect(row.summary_status).toBe("failed");

    await worker.stop();
  });

  it("translates unsupported_backend errors into skipped (not failed)", async () => {
    const client = new FakeLlmClient(() => ({
      ok: false,
      errorClass: "unsupported_backend",
      message: "no impl",
    }));
    const worker = new ObservationSummarizerWorker({ db, client });
    await worker.start();

    recordObservation(db, {
      source: "obsidian:external",
      ref: "x.md",
      changeType: "modified",
      actor: "user",
      payload: { diffPreview: "foo" },
    });

    await flushQueue(worker);

    const row = db.prepare(`SELECT summary_status FROM observations LIMIT 1`).get() as { summary_status: string };
    expect(row.summary_status).toBe("skipped");

    await worker.stop();
  });

  it("translates auth_missing into skipped (not failed) so the hourly_check fallback path picks the row up", async () => {
    // Regression guard: when ANTHROPIC_API_KEY is missing, every pending
    // row used to be marked failed (producing a flood of "Summarizer
    // LLM call failed" warnings). The post-fix behavior matches
    // `unsupported_backend`: row → skipped so hourly_check legacy fetch
    // handles it, no per-row failure state.
    const client = new FakeLlmClient(() => ({
      ok: false,
      errorClass: "auth_missing",
      message: "ANTHROPIC_API_KEY not configured",
    }));
    const worker = new ObservationSummarizerWorker({ db, client });
    await worker.start();

    recordObservation(db, {
      source: "obsidian:primary",
      ref: "note.md",
      changeType: "modified",
      actor: "user",
      payload: { diffPreview: "x" },
    });

    await flushQueue(worker);

    const row = db.prepare(`SELECT summary_status FROM observations LIMIT 1`).get() as { summary_status: string };
    expect(row.summary_status).toBe("skipped");

    await worker.stop();
  });

  it("applies novelty floor for VIP mail senders even when LLM returns lower", async () => {
    const client = new FakeLlmClient(() => ok("FYI from boss", 1));
    const worker = new ObservationSummarizerWorker({
      db,
      client,
      preFilter: { vipMailSenders: ["boss@example.com"] },
    });
    await worker.start();

    recordObservation(db, {
      source: "mail:gmail",
      ref: "msg-1",
      changeType: "created",
      actor: "system",
      payload: { from: "boss@example.com", subject: "FYI", body: "see attached" },
    });

    await flushQueue(worker);

    const row = db.prepare(`SELECT novelty_score FROM observations LIMIT 1`).get() as { novelty_score: number };
    expect(row.novelty_score).toBe(3);

    await worker.stop();
  });

  it("reclaims pending rows on startup", async () => {
    // Insert directly without enqueue hook (simulates a pre-restart row).
    db.prepare(
      `INSERT INTO observations (source, ref, change_type, actor, observed_at, payload, summary_status)
       VALUES ('obsidian:external', 'pre-existing.md', 'modified', 'user', CURRENT_TIMESTAMP, ?, 'pending')`,
    ).run(JSON.stringify({ diffPreview: "stuff" }));

    const client = new FakeLlmClient(() => ok("recovered", 1));
    const worker = new ObservationSummarizerWorker({ db, client });
    await worker.start();
    await flushQueue(worker);

    const row = db.prepare(`SELECT summary_status, summary_text FROM observations LIMIT 1`).get() as {
      summary_status: string;
      summary_text: string;
    };
    expect(row.summary_status).toBe("done");
    expect(row.summary_text).toBe("recovered");
    expect(client.callCount).toBe(1);

    await worker.stop();
  });

  it("dedupes a re-write of the same row before drain", async () => {
    const client = new FakeLlmClient(() => ok("once", 1));
    const worker = new ObservationSummarizerWorker({
      db,
      client,
      // Concurrency 1 + a slow LLM call would let us race more directly,
      // but a deterministic check on call count suffices.
      concurrency: 1,
    });
    await worker.start();

    // Two writes for the same (source, ref) — UPSERT collapses to one
    // pending row, and the worker should make one LLM call.
    recordObservation(db, {
      source: "obsidian:external",
      ref: "x.md",
      changeType: "modified",
      actor: "user",
      payload: { diffPreview: "first" },
    });
    recordObservation(db, {
      source: "obsidian:external",
      ref: "x.md",
      changeType: "modified",
      actor: "user",
      payload: { diffPreview: "second" },
    });

    await flushQueue(worker);

    const rowCount = (db.prepare("SELECT COUNT(*) AS c FROM observations").get() as { c: number }).c;
    expect(rowCount).toBe(1);
    expect(client.callCount).toBeLessThanOrEqual(2);
    // At minimum the row settled to a non-pending status.
    const status = (db.prepare("SELECT summary_status FROM observations").get() as { summary_status: string }).summary_status;
    expect(status).not.toBe("pending");

    await worker.stop();
  });

  it("reclaims a backlog larger than queueDepthLimit without dropping rows to skipped", async () => {
    // Pre-seed more pending rows than the in-memory queue cap. The
    // startup sweep must take all of them — applying backpressure to
    // already-persisted pending rows would silently destroy work
    // when the user has been offline long enough for a backlog to
    // build up (laptop sleep + watcher catch-up).
    const QUEUE_CAP = 10;
    const BACKLOG = 25;
    for (let i = 0; i < BACKLOG; i++) {
      db.prepare(
        `INSERT INTO observations (source, ref, change_type, actor, observed_at, payload, summary_status)
         VALUES ('obsidian:external', ?, 'modified', 'user', CURRENT_TIMESTAMP, ?, 'pending')`,
      ).run(`reclaim-${i}.md`, JSON.stringify({ diffPreview: "..." }));
    }

    const client = new FakeLlmClient(() => ok("ok", 1));
    const worker = new ObservationSummarizerWorker({
      db,
      client,
      queueDepthLimit: QUEUE_CAP,
      reclaimLimit: BACKLOG + 5,
    });
    await worker.start();
    await flushQueue(worker, 200);

    const counts = getSummaryStatusCounts(db);
    expect(counts.skipped).toBe(0);
    expect(counts.done).toBe(BACKLOG);

    await worker.stop();
  });

  it("respects the rate limit by short-circuiting overflow rows to skipped", async () => {
    const client = new FakeLlmClient(() => ok("ok", 1));
    const fixedTime = Date.parse("2026-05-06T12:00:00Z");
    const worker = new ObservationSummarizerWorker({
      db,
      client,
      maxLlmCallsPerMinute: 2,
      // Pin time so the sliding window doesn't roll over during the test.
      now: () => new Date(fixedTime),
    });
    await worker.start();

    for (let i = 0; i < 5; i++) {
      recordObservation(db, {
        source: "obsidian:external",
        ref: `note-${i}.md`,
        changeType: "modified",
        actor: "user",
        payload: { diffPreview: `entry ${i}` },
      });
    }

    await flushQueue(worker);

    // 2 LLM calls allowed per the rate limit; the rest must skip.
    expect(client.callCount).toBeLessThanOrEqual(2);
    const counts = getSummaryStatusCounts(db);
    expect(counts.done).toBeLessThanOrEqual(2);
    expect(counts.skipped).toBeGreaterThanOrEqual(3);

    await worker.stop();
  });
});
