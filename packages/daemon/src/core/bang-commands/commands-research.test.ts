import { describe, expect, it, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { Event, MessageEvent } from "@aitne/shared";
import { EventPriority, createEvent } from "@aitne/shared";
import { applySchema } from "../../db/schema.js";
import {
  parseResearchArgs,
  researchCommand,
} from "./commands-research.js";
import { BangArgError, type BangCommandContext } from "./registry.js";

function makeMessageEvent(): MessageEvent {
  return createEvent({
    type: "message.dm.received",
    source: "slack",
    priority: EventPriority.HIGH,
    data: {
      platform: "slack",
      channel: "D1",
      sender: "U1",
      content: "!research",
      isDm: true,
    },
  }) as MessageEvent;
}

interface CapturedNotify {
  messages: string[];
  events: Event[];
}

function buildCtx(
  db: Database.Database,
): { ctx: BangCommandContext; capture: CapturedNotify } {
  const capture: CapturedNotify = { messages: [], events: [] };
  const ctx: BangCommandContext = {
    event: makeMessageEvent(),
    db,
    config: { dayBoundaryHour: 4 } as never,
    notify: async (text: string) => {
      capture.messages.push(text);
    },
    audit: {
      logBangCommand: () => {},
    } as never,
    registry: undefined as never,
    enqueueBrowserResearchEvent: async (event) => {
      capture.events.push(event);
    },
  };
  return { ctx, capture };
}

function seedCluster(
  db: Database.Database,
  slug: string,
  rootTaskId: number,
): void {
  db.prepare(
    `INSERT INTO browser_research_clusters
       (slug, root_task_id, display_name, started_at, last_activity_at,
        visits_total, meaningful_visits_total, meaningful_foreground_sec_total,
        distinct_meaningful_domains, status)
     VALUES (?, ?, ?, ?, ?, 1, 1, 120, 1, 'active')`,
  ).run(slug, rootTaskId, slug, 1_700_000_000_000, 1_700_000_000_000);
}

describe("parseResearchArgs", () => {
  it("defaults to list when no subcommand is provided", () => {
    expect(parseResearchArgs("")).toMatchObject({ subcommand: "list" });
    expect(parseResearchArgs("   ")).toMatchObject({ subcommand: "list" });
  });

  it("parses show via a bare slug", () => {
    expect(parseResearchArgs("quantum-mechanics")).toMatchObject({
      subcommand: "show",
      slug: "quantum-mechanics",
    });
  });

  it.each([
    ["accept quantum-mechanics", "accept"],
    ["wiki quantum-mechanics", "wiki"],
    ["decline quantum-mechanics", "decline"],
    ["mute quantum-mechanics", "mute"],
    ["unmute quantum-mechanics", "unmute"],
    ["conclude quantum-mechanics", "conclude"],
  ])("parses %s as %s", (rest, subcommand) => {
    expect(parseResearchArgs(rest).subcommand).toBe(subcommand);
    expect(parseResearchArgs(rest).slug).toBe("quantum-mechanics");
  });

  it.each(["accept", "wiki", "decline", "mute", "unmute", "conclude"])(
    "throws when %s has no slug",
    (head) => {
      expect(() => parseResearchArgs(head)).toThrow(BangArgError);
    },
  );

  it("rejects an invalid slug (uppercase)", () => {
    // Uppercase fails the slug regex; the parser falls into the
    // default branch and rejects as "unknown subcommand".
    expect(() => parseResearchArgs("SomeBadSlug")).toThrow(BangArgError);
  });

  it("rejects an unknown subcommand", () => {
    // Mixed-case head is neither a registered subcommand nor a valid
    // slug — the same rejection branch fires.
    expect(() => parseResearchArgs("DELETE x")).toThrow(BangArgError);
  });

  it("researchCommand.parseArgs is a thin wrapper around parseResearchArgs", () => {
    const parsed = researchCommand.parseArgs?.("quantum-mechanics", undefined as never);
    expect(parsed).toMatchObject({
      subcommand: "show",
      slug: "quantum-mechanics",
    });
  });

  it("parses rename with a multi-word new name", () => {
    const args = parseResearchArgs("rename quantum Quantum Mechanics Deep Dive");
    expect(args.subcommand).toBe("rename");
    expect(args.slug).toBe("quantum");
    expect(args.payload).toBe("Quantum Mechanics Deep Dive");
  });

  it("rejects rename without a new name", () => {
    expect(() => parseResearchArgs("rename quantum")).toThrow(BangArgError);
  });

  it("rejects rename with an over-length name", () => {
    const longName = "x".repeat(150);
    expect(() => parseResearchArgs(`rename quantum ${longName}`)).toThrow(
      BangArgError,
    );
  });

  it("rejects rename with an invalid slug", () => {
    expect(() => parseResearchArgs("rename BadSlug name")).toThrow(
      BangArgError,
    );
  });
});

describe("researchCommand — runtime handlers", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });
  afterEach(() => db.close());

  it("list with no clusters emits a friendly message", async () => {
    const { ctx, capture } = buildCtx(db);
    await researchCommand.handler(ctx, { subcommand: "list", slug: null, payload: "" });
    expect(capture.messages[0]).toContain("No active or dormant research clusters yet.");
  });

  it("list emits a multi-line summary when clusters exist", async () => {
    seedCluster(db, "quantum-mechanics", 1);
    const { ctx, capture } = buildCtx(db);
    await researchCommand.handler(ctx, {
      subcommand: "list",
      slug: null,
      payload: "",
    });
    expect(capture.messages[0]).toContain("Research clusters");
    expect(capture.messages[0]).toContain("quantum-mechanics");
  });

  it("list truncates at 12 clusters with a 'more' line", async () => {
    for (let i = 0; i < 15; i += 1) {
      seedCluster(db, `c-${i}`, i + 100);
    }
    const { ctx, capture } = buildCtx(db);
    await researchCommand.handler(ctx, {
      subcommand: "list",
      slug: null,
      payload: "",
    });
    expect(capture.messages[0]).toContain("more");
  });

  it("show returns details for an existing cluster", async () => {
    seedCluster(db, "quantum-mechanics", 1);
    const { ctx, capture } = buildCtx(db);
    await researchCommand.handler(ctx, {
      subcommand: "show",
      slug: "quantum-mechanics",
      payload: "",
    });
    expect(capture.messages[0]).toContain("quantum-mechanics");
  });

  it("show reports missing slug", async () => {
    const { ctx, capture } = buildCtx(db);
    await researchCommand.handler(ctx, {
      subcommand: "show",
      slug: "missing",
      payload: "",
    });
    expect(capture.messages[0]).toContain("No cluster `missing` found");
  });

  it("accept enqueues a research_dispatch event and clears pending offer", async () => {
    seedCluster(db, "quantum-mechanics", 1);
    db.prepare(
      `INSERT INTO browser_pending_offers (slug, kind, offered_at, expires_at)
       VALUES ('quantum-mechanics', 'research_assist', 0, 9999999999999)`,
    ).run();
    const { ctx, capture } = buildCtx(db);
    await researchCommand.handler(ctx, {
      subcommand: "accept",
      slug: "quantum-mechanics",
      payload: "",
    });
    expect(capture.events).toHaveLength(1);
    expect(capture.events[0].type).toBe("routine.research_dispatch");
    const remaining = db
      .prepare(`SELECT COUNT(*) AS n FROM browser_pending_offers`)
      .get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  it("accept on missing cluster does not enqueue", async () => {
    const { ctx, capture } = buildCtx(db);
    await researchCommand.handler(ctx, {
      subcommand: "accept",
      slug: "ghost",
      payload: "",
    });
    expect(capture.events).toHaveLength(0);
    expect(capture.messages[0]).toContain("No cluster `ghost` found");
  });

  it("show includes acceptance and wiki-summary dates when populated", async () => {
    seedCluster(db, "quantum-mechanics", 1);
    const stamp = 1_710_000_000_000;
    db.prepare(
      `UPDATE browser_research_clusters
       SET research_offer_accepted_at = ?, wiki_summary_written_at = ?
       WHERE slug = 'quantum-mechanics'`,
    ).run(stamp, stamp);
    const { ctx, capture } = buildCtx(db);
    await researchCommand.handler(ctx, {
      subcommand: "show",
      slug: "quantum-mechanics",
      payload: "",
    });
    expect(capture.messages[0]).toContain("research_assist accepted");
    expect(capture.messages[0]).toContain("wiki summary written");
  });

  it("wiki on missing cluster reports not found", async () => {
    const { ctx, capture } = buildCtx(db);
    await researchCommand.handler(ctx, {
      subcommand: "wiki",
      slug: "ghost",
      payload: "",
    });
    expect(capture.events).toHaveLength(0);
    expect(capture.messages[0]).toContain("No cluster `ghost` found");
  });

  it("wiki enqueues a research_wiki_summary event", async () => {
    seedCluster(db, "quantum-mechanics", 1);
    const { ctx, capture } = buildCtx(db);
    await researchCommand.handler(ctx, {
      subcommand: "wiki",
      slug: "quantum-mechanics",
      payload: "",
    });
    expect(capture.events[0].type).toBe("routine.research_wiki_summary");
  });

  it("decline stamps re-fire timestamps and clears pending offers", async () => {
    seedCluster(db, "quantum-mechanics", 1);
    db.prepare(
      `INSERT INTO browser_pending_offers (slug, kind, offered_at, expires_at)
       VALUES ('quantum-mechanics', 'wiki_summary', 0, 9999999999999)`,
    ).run();
    const { ctx, capture } = buildCtx(db);
    await researchCommand.handler(ctx, {
      subcommand: "decline",
      slug: "quantum-mechanics",
      payload: "",
    });
    expect(capture.messages[0]).toContain("silencing offers");
    const row = db
      .prepare(`SELECT last_research_offer_at AS r, last_wiki_offer_at AS w
                FROM browser_research_clusters WHERE slug = 'quantum-mechanics'`)
      .get() as { r: number | null; w: number | null };
    expect(row.r).not.toBeNull();
    expect(row.w).not.toBeNull();
  });

  it("decline on missing cluster reports not found", async () => {
    const { ctx, capture } = buildCtx(db);
    await researchCommand.handler(ctx, {
      subcommand: "decline",
      slug: "missing",
      payload: "",
    });
    expect(capture.messages[0]).toContain("No cluster `missing` found");
  });

  it("mute and unmute flip cluster status", async () => {
    seedCluster(db, "quantum-mechanics", 1);
    const { ctx, capture } = buildCtx(db);
    await researchCommand.handler(ctx, {
      subcommand: "mute",
      slug: "quantum-mechanics",
      payload: "",
    });
    let row = db
      .prepare(
        "SELECT status FROM browser_research_clusters WHERE slug = 'quantum-mechanics'",
      )
      .get() as { status: string };
    expect(row.status).toBe("muted");
    await researchCommand.handler(ctx, {
      subcommand: "unmute",
      slug: "quantum-mechanics",
      payload: "",
    });
    row = db
      .prepare(
        "SELECT status FROM browser_research_clusters WHERE slug = 'quantum-mechanics'",
      )
      .get() as { status: string };
    expect(row.status).toBe("active");
    expect(capture.messages[0]).toContain("Muted");
    expect(capture.messages[1]).toContain("Unmuted");
  });

  it("mute / unmute / conclude on missing cluster report not found", async () => {
    const { ctx, capture } = buildCtx(db);
    await researchCommand.handler(ctx, {
      subcommand: "mute",
      slug: "missing",
      payload: "",
    });
    await researchCommand.handler(ctx, {
      subcommand: "unmute",
      slug: "missing",
      payload: "",
    });
    await researchCommand.handler(ctx, {
      subcommand: "conclude",
      slug: "missing",
      payload: "",
    });
    for (const msg of capture.messages) {
      expect(msg).toContain("No cluster `missing` found");
    }
  });

  it("conclude marks status concluded and notifies the destination path", async () => {
    seedCluster(db, "quantum-mechanics", 1);
    const { ctx, capture } = buildCtx(db);
    await researchCommand.handler(ctx, {
      subcommand: "conclude",
      slug: "quantum-mechanics",
      payload: "",
    });
    const row = db
      .prepare(
        "SELECT status FROM browser_research_clusters WHERE slug = 'quantum-mechanics'",
      )
      .get() as { status: string };
    expect(row.status).toBe("concluded");
    expect(capture.messages[0]).toContain(
      "context/research/quantum-mechanics.md",
    );
  });

  it("rename updates display_name", async () => {
    seedCluster(db, "quantum-mechanics", 1);
    const { ctx, capture } = buildCtx(db);
    await researchCommand.handler(ctx, {
      subcommand: "rename",
      slug: "quantum-mechanics",
      payload: "Custom Title",
    });
    const row = db
      .prepare(
        "SELECT display_name FROM browser_research_clusters WHERE slug = 'quantum-mechanics'",
      )
      .get() as { display_name: string };
    expect(row.display_name).toBe("Custom Title");
    expect(capture.messages[0]).toContain("Custom Title");
  });

  it("rename on missing cluster reports not found", async () => {
    const { ctx, capture } = buildCtx(db);
    await researchCommand.handler(ctx, {
      subcommand: "rename",
      slug: "missing",
      payload: "x",
    });
    expect(capture.messages[0]).toContain("No cluster `missing` found");
  });

  it("accept without an EventBus wired emits the 'not wired' notice and skips enqueue", async () => {
    seedCluster(db, "quantum-mechanics", 1);
    db.prepare(
      `INSERT INTO browser_pending_offers (slug, kind, offered_at, expires_at)
       VALUES ('quantum-mechanics', 'research_assist', 0, 9999999999999)`,
    ).run();
    const ctx: BangCommandContext = {
      event: makeMessageEvent(),
      db,
      config: { dayBoundaryHour: 4 } as never,
      notify: async () => {},
      audit: { logBangCommand: () => {} } as never,
      registry: undefined as never,
      // No `enqueueBrowserResearchEvent` wired.
    };
    let capturedMessage = "";
    ctx.notify = async (text: string) => {
      capturedMessage = text;
    };
    await researchCommand.handler(ctx, {
      subcommand: "accept",
      slug: "quantum-mechanics",
      payload: "",
    });
    expect(capturedMessage).toContain("Browser-history dispatch is not wired");
    // Regression: the pre-fix handler stamped `researchOfferAcceptedAt`
    // and deleted the pending offer BEFORE checking enqueue success, so
    // an unwired bus quietly leaked state. The fix moves both writes
    // behind a successful enqueue.
    const cluster = db
      .prepare(
        `SELECT research_offer_accepted_at AS acceptedAt
         FROM browser_research_clusters WHERE slug = 'quantum-mechanics'`,
      )
      .get() as { acceptedAt: number | null };
    expect(cluster.acceptedAt).toBeNull();
    const remaining = db
      .prepare(`SELECT COUNT(*) AS n FROM browser_pending_offers`)
      .get() as { n: number };
    expect(remaining.n).toBe(1);
  });

  it("wiki without an EventBus wired emits the 'not wired' notice and leaves pending rows intact", async () => {
    // Symmetric to the accept-path regression test above — the wiki
    // subcommand must also defer pending-offer deletion until after a
    // successful enqueue.
    seedCluster(db, "quantum-mechanics", 1);
    db.prepare(
      `INSERT INTO browser_pending_offers (slug, kind, offered_at, expires_at)
       VALUES ('quantum-mechanics', 'wiki_summary', 0, 9999999999999)`,
    ).run();
    let capturedMessage = "";
    const ctx: BangCommandContext = {
      event: makeMessageEvent(),
      db,
      config: { dayBoundaryHour: 4 } as never,
      notify: async (text: string) => {
        capturedMessage = text;
      },
      audit: { logBangCommand: () => {} } as never,
      registry: undefined as never,
      // No `enqueueBrowserResearchEvent` wired.
    };
    await researchCommand.handler(ctx, {
      subcommand: "wiki",
      slug: "quantum-mechanics",
      payload: "",
    });
    expect(capturedMessage).toContain("Browser-history dispatch is not wired");
    const remaining = db
      .prepare(`SELECT COUNT(*) AS n FROM browser_pending_offers`)
      .get() as { n: number };
    expect(remaining.n).toBe(1);
  });

  it("wiki accept does NOT stamp wikiSummaryWrittenAt (agent-owned field)", async () => {
    // BROWSER_HISTORY_INTEGRATION_PLAN §10.6 — `wikiSummaryWrittenAt` is
    // the agent's "wiki note already exists" gate per
    // `routine.research_wiki_summary.md` step 3. Pre-stamping it on
    // acceptance made the agent skip the very write the operator just
    // asked for. The bang command must leave it untouched; the pending-
    // offer deletion plus the 14-day `lastWikiOfferAt` re-fire gate are
    // what prevent the templated DM from re-firing immediately.
    seedCluster(db, "quantum-mechanics", 1);
    db.prepare(
      `INSERT INTO browser_pending_offers (slug, kind, offered_at, expires_at)
       VALUES ('quantum-mechanics', 'wiki_summary', 0, 9999999999999)`,
    ).run();
    const { ctx, capture } = buildCtx(db);
    await researchCommand.handler(ctx, {
      subcommand: "wiki",
      slug: "quantum-mechanics",
      payload: "",
    });
    expect(capture.events[0].type).toBe("routine.research_wiki_summary");
    const cluster = db
      .prepare(
        `SELECT wiki_summary_written_at AS writtenAt
         FROM browser_research_clusters WHERE slug = 'quantum-mechanics'`,
      )
      .get() as { writtenAt: number | null };
    expect(cluster.writtenAt).toBeNull();
    const remaining = db
      .prepare(`SELECT COUNT(*) AS n FROM browser_pending_offers`)
      .get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  it("research accept clears a seventh-pass kind='offered' pending row", async () => {
    // BROWSER_HISTORY_INTEGRATION_PLAN seventh-pass — the poller now
    // inserts kind='offered' for the two-option offer flow. Before the
    // seventh-pass fix the bang command deleted only the kind-specific
    // row ('research_assist' / 'wiki_summary'), so an 'offered' row
    // survived acceptance and silenced the cluster for the 14-day TTL.
    // The fix switches to deletePendingOffersForCluster — clear all
    // pending rows for the slug on accept, regardless of kind.
    seedCluster(db, "quantum-mechanics", 1);
    db.prepare(
      `INSERT INTO browser_pending_offers (slug, kind, offered_at, expires_at)
       VALUES ('quantum-mechanics', 'offered', 0, 9999999999999)`,
    ).run();
    const { ctx, capture } = buildCtx(db);
    await researchCommand.handler(ctx, {
      subcommand: "accept",
      slug: "quantum-mechanics",
      payload: "",
    });
    expect(capture.events[0].type).toBe("routine.research_dispatch");
    const remaining = db
      .prepare(`SELECT COUNT(*) AS n FROM browser_pending_offers`)
      .get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  it("wiki accept clears a seventh-pass kind='offered' pending row", async () => {
    seedCluster(db, "quantum-mechanics", 1);
    db.prepare(
      `INSERT INTO browser_pending_offers (slug, kind, offered_at, expires_at)
       VALUES ('quantum-mechanics', 'offered', 0, 9999999999999)`,
    ).run();
    const { ctx, capture } = buildCtx(db);
    await researchCommand.handler(ctx, {
      subcommand: "wiki",
      slug: "quantum-mechanics",
      payload: "",
    });
    expect(capture.events[0].type).toBe("routine.research_wiki_summary");
    const remaining = db
      .prepare(`SELECT COUNT(*) AS n FROM browser_pending_offers`)
      .get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  // Mirror of the API accept test in browser-history.test.ts: bang
  // wiki acceptance must clear `lastWikiOfferAt` so the rate-limit
  // gate's decline_backoff cannot trip when the wiki write fails or
  // /wiki-written is skipped. Without this, accepting via `!research
  // wiki` would silence the cluster for 30 days despite engagement.
  it("wiki accept clears last_wiki_offer_at so decline_backoff cannot trip", async () => {
    seedCluster(db, "quantum-mechanics", 1);
    const offeredAt = 1_700_000_000_000;
    db.prepare(
      `UPDATE browser_research_clusters
         SET last_research_offer_at = ?, last_wiki_offer_at = ?, last_dm_at = ?
       WHERE slug = ?`,
    ).run(offeredAt, offeredAt, offeredAt, "quantum-mechanics");
    const { ctx, capture } = buildCtx(db);
    await researchCommand.handler(ctx, {
      subcommand: "wiki",
      slug: "quantum-mechanics",
      payload: "",
    });
    expect(capture.events[0].type).toBe("routine.research_wiki_summary");
    const row = db
      .prepare(
        `SELECT last_research_offer_at AS r, last_wiki_offer_at AS w
           FROM browser_research_clusters WHERE slug = ?`,
      )
      .get("quantum-mechanics") as { r: number | null; w: number | null };
    expect(row.w).toBeNull();
    expect(row.r).toBe(offeredAt);
  });
});
