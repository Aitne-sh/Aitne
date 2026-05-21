import { describe, expect, it, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { Event } from "@aitne/shared";
import { applySchema } from "../../db/schema.js";
import {
  fanoutResearchClusterUpdates,
} from "./research-cluster-fanout.js";

class StubBus {
  events: Event[] = [];
  async put(event: Event): Promise<void> {
    this.events.push(event);
  }
}

function seedCluster(
  db: Database.Database,
  args: {
    slug: string;
    rootTaskId: number;
    status?: "active" | "muted" | "concluded" | "dormant";
    lastActivityAt: number;
  },
): void {
  db.prepare(
    `INSERT INTO browser_research_clusters
       (slug, root_task_id, display_name, started_at, last_activity_at,
        visits_total, meaningful_visits_total, meaningful_foreground_sec_total,
        distinct_meaningful_domains, status)
     VALUES (?, ?, ?, ?, ?, 1, 1, 120, 1, ?)`,
  ).run(
    args.slug,
    args.rootTaskId,
    args.slug,
    1_700_000_000_000,
    args.lastActivityAt,
    args.status ?? "active",
  );
}

describe("fanoutResearchClusterUpdates", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });
  afterEach(() => {
    db.close();
  });

  it("returns empty when no EventBus is wired", async () => {
    const result = await fanoutResearchClusterUpdates(db, null);
    expect(result.enqueuedSlugs).toEqual([]);
  });

  it("enqueues one event per active cluster with recent activity", async () => {
    const now = Date.now();
    seedCluster(db, { slug: "fresh-a", rootTaskId: 1, lastActivityAt: now - 1000 });
    seedCluster(db, { slug: "fresh-b", rootTaskId: 2, lastActivityAt: now - 2000 });
    // Stale (>24h) — should NOT appear.
    seedCluster(db, {
      slug: "stale",
      rootTaskId: 3,
      lastActivityAt: now - 10 * 86_400_000,
    });
    // Muted — should NOT appear.
    seedCluster(db, {
      slug: "muted",
      rootTaskId: 4,
      lastActivityAt: now - 1000,
      status: "muted",
    });
    const bus = new StubBus();
    const result = await fanoutResearchClusterUpdates(db, bus, { nowMs: now });
    expect(result.enqueuedSlugs.sort()).toEqual(["fresh-a", "fresh-b"]);
    expect(bus.events.every((e) => e.type === "routine.research_cluster_update")).toBe(true);
  });

  it("defaults nowMs to Date.now() when omitted (covers the ?? branch)", async () => {
    seedCluster(db, {
      slug: "fresh-now",
      rootTaskId: 7,
      lastActivityAt: Date.now() - 1000,
    });
    const bus = new StubBus();
    const result = await fanoutResearchClusterUpdates(db, bus);
    expect(result.enqueuedSlugs).toContain("fresh-now");
  });

  it("respects the limit argument", async () => {
    const now = Date.now();
    for (let i = 0; i < 5; i += 1) {
      seedCluster(db, {
        slug: `c${i}`,
        rootTaskId: i + 1,
        lastActivityAt: now - (i + 1) * 1000,
      });
    }
    const bus = new StubBus();
    const result = await fanoutResearchClusterUpdates(db, bus, {
      nowMs: now,
      limit: 2,
    });
    expect(result.enqueuedSlugs).toHaveLength(2);
  });
});
