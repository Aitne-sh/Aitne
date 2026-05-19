import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../db/schema.js";
import { createEntitiesRoutes, buildEntitiesRoutesDepsFromApi } from "./entities.js";
import type { ApiDependencies } from "../server.js";

/**
 * §7.6 entity-lookup contract tests.
 *
 * The route reads a SQLite mirror that the §7.2 entity-mirror watcher
 * (P5) populates from L2 entity files. P3 ships only the read API;
 * for the route tests we seed the mirror by hand to exercise the
 * lookup tiers without the watcher.
 */

interface SeedEntityInput {
  path: string;
  domain: string;
  type: string;
  slug: string;
  title: string;
  status?: string | null;
  date?: string | null;
  lastSyncedAt?: string | null;
  sources?: Record<string, { external_id?: string; url?: string }>;
}

function seedEntity(db: Database.Database, input: SeedEntityInput): void {
  db.prepare(
    `INSERT INTO entities
       (path, domain, type, slug, title, status, date, last_synced_at, sources_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.path,
    input.domain,
    input.type,
    input.slug,
    input.title,
    input.status ?? null,
    input.date ?? null,
    input.lastSyncedAt ?? null,
    JSON.stringify(input.sources ?? {}),
  );
  for (const sourceKey of Object.keys(input.sources ?? {})) {
    db.prepare(
      `INSERT OR IGNORE INTO entity_source_keys (path, source_key) VALUES (?, ?)`,
    ).run(input.path, sourceKey);
  }
}

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return db;
}

describe("GET /api/entities", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => db.close());

  it("returns 400 when neither tier-1 nor tier-2 query shape is supplied", async () => {
    const app = createEntitiesRoutes({ db });
    const res = await app.request("/entities");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing_query");
  });

  it("returns 400 when both tier-1 and tier-2 params are supplied", async () => {
    const app = createEntitiesRoutes({ db });
    const res = await app.request(
      "/entities?source=zoom&external_id=zm_x&domain=work&type=meeting&date=2026-12-04",
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ambiguous_query");
  });

  it("tier-1: looks up by (source_key, external_id)", async () => {
    seedEntity(db, {
      path: "work/meetings/2026-12-04-foo.md",
      domain: "work",
      type: "meeting",
      slug: "2026-12-04-foo",
      title: "Foo 1on1",
      date: "2026-12-04",
      sources: { zoom: { external_id: "zm_xyz789" } },
    });
    const app = createEntitiesRoutes({ db });
    const res = await app.request("/entities?source=zoom&external_id=zm_xyz789");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tier: number;
      items: Array<{ slug: string; sources: Record<string, unknown> }>;
    };
    expect(body.tier).toBe(1);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].slug).toBe("2026-12-04-foo");
    expect(body.items[0].sources.zoom).toMatchObject({ external_id: "zm_xyz789" });
  });

  it("tier-1: returns empty array when external_id does not match", async () => {
    seedEntity(db, {
      path: "work/meetings/2026-12-04-foo.md",
      domain: "work",
      type: "meeting",
      slug: "2026-12-04-foo",
      title: "Foo 1on1",
      sources: { zoom: { external_id: "zm_xyz789" } },
    });
    const app = createEntitiesRoutes({ db });
    const res = await app.request("/entities?source=zoom&external_id=other");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(0);
  });

  it("tier-1 by-source-key: lists every entity tagged with the source", async () => {
    seedEntity(db, {
      path: "work/meetings/2026-12-04-foo.md",
      domain: "work",
      type: "meeting",
      slug: "2026-12-04-foo",
      title: "Foo",
      sources: { zoom: { external_id: "zm_a" } },
    });
    seedEntity(db, {
      path: "work/meetings/2026-12-05-bar.md",
      domain: "work",
      type: "meeting",
      slug: "2026-12-05-bar",
      title: "Bar",
      sources: { zoom: { external_id: "zm_b" } },
    });
    seedEntity(db, {
      path: "personal/notes/2026-12-04-baz.md",
      domain: "personal",
      type: "note",
      slug: "2026-12-04-baz",
      title: "Baz",
      sources: { obsidian: { external_id: "ob_x" } },
    });
    const app = createEntitiesRoutes({ db });
    const res = await app.request("/entities?source=zoom");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tier: number;
      mode: string;
      items: Array<{ slug: string }>;
    };
    expect(body.tier).toBe(1);
    expect(body.mode).toBe("by_source_key");
    expect(body.items.map((b) => b.slug).sort()).toEqual([
      "2026-12-04-foo",
      "2026-12-05-bar",
    ]);
  });

  it("tier-1 by-source-key: respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      seedEntity(db, {
        path: `work/meetings/2026-12-0${i + 1}-meeting.md`,
        domain: "work",
        type: "meeting",
        slug: `2026-12-0${i + 1}-meeting`,
        title: `Meeting ${i}`,
        sources: { zoom: { external_id: `zm_${i}` } },
      });
    }
    const app = createEntitiesRoutes({ db });
    const res = await app.request("/entities?source=zoom&limit=2");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(2);
  });

  it("tier-1: source lookup is case-insensitive across casing variants", async () => {
    // §7.6.1 source_key_normalized — caller passes any casing, sidecar
    // join collapses to lower-case so all three rows surface.
    seedEntity(db, {
      path: "work/meetings/2026-12-04-cap.md",
      domain: "work",
      type: "meeting",
      slug: "2026-12-04-cap",
      title: "Cap",
      sources: { ZOOM: { external_id: "zm_a" } },
    });
    seedEntity(db, {
      path: "work/meetings/2026-12-05-pretty.md",
      domain: "work",
      type: "meeting",
      slug: "2026-12-05-pretty",
      title: "Pretty",
      sources: { Zoom: { external_id: "zm_b" } },
    });
    seedEntity(db, {
      path: "work/meetings/2026-12-06-flat.md",
      domain: "work",
      type: "meeting",
      slug: "2026-12-06-flat",
      title: "Flat",
      sources: { zoom: { external_id: "zm_c" } },
    });
    const app = createEntitiesRoutes({ db });
    const res = await app.request("/entities?source=ZOOM");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ slug: string }> };
    expect(body.items.map((b) => b.slug).sort()).toEqual([
      "2026-12-04-cap",
      "2026-12-05-pretty",
      "2026-12-06-flat",
    ]);
  });

  it("tier-1 by-source-key: rejects negative limit", async () => {
    const app = createEntitiesRoutes({ db });
    const res = await app.request("/entities?source=zoom&limit=-1");
    expect(res.status).toBe(400);
  });

  it("tier-1: rejects when external_id is provided without source", async () => {
    const app = createEntitiesRoutes({ db });
    const res = await app.request("/entities?external_id=zm_x");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("validation_error");
  });

  it("tier-1: tags exact-match responses with mode=exact", async () => {
    seedEntity(db, {
      path: "work/meetings/2026-12-04-foo.md",
      domain: "work",
      type: "meeting",
      slug: "2026-12-04-foo",
      title: "Foo",
      sources: { zoom: { external_id: "zm_xyz789" } },
    });
    const app = createEntitiesRoutes({ db });
    const res = await app.request("/entities?source=zoom&external_id=zm_xyz789");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mode: string };
    expect(body.mode).toBe("exact");
  });

  it("tier-2: looks up by (domain, type, date)", async () => {
    seedEntity(db, {
      path: "work/meetings/2026-12-04-foo.md",
      domain: "work",
      type: "meeting",
      slug: "2026-12-04-foo",
      title: "Foo 1on1",
      date: "2026-12-04",
    });
    seedEntity(db, {
      path: "work/meetings/2026-12-04-bar.md",
      domain: "work",
      type: "meeting",
      slug: "2026-12-04-bar",
      title: "Bar planning",
      date: "2026-12-04",
    });
    const app = createEntitiesRoutes({ db });
    const res = await app.request(
      "/entities?domain=work&type=meeting&date=2026-12-04",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tier: number;
      items: Array<{ slug: string }>;
    };
    expect(body.tier).toBe(2);
    expect(body.items.map((b) => b.slug).sort()).toEqual([
      "2026-12-04-bar",
      "2026-12-04-foo",
    ]);
  });

  it("tier-2: filters by `q` (case-insensitive title substring)", async () => {
    seedEntity(db, {
      path: "work/meetings/2026-12-04-foo.md",
      domain: "work",
      type: "meeting",
      slug: "2026-12-04-foo",
      title: "Foo 1on1",
      date: "2026-12-04",
    });
    seedEntity(db, {
      path: "work/meetings/2026-12-04-bar.md",
      domain: "work",
      type: "meeting",
      slug: "2026-12-04-bar",
      title: "Bar planning",
      date: "2026-12-04",
    });
    const app = createEntitiesRoutes({ db });
    const res = await app.request(
      "/entities?domain=work&type=meeting&date=2026-12-04&q=FOO",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ slug: string }> };
    expect(body.items.map((b) => b.slug)).toEqual(["2026-12-04-foo"]);
  });

  it("tier-2: rejects unknown domain", async () => {
    const app = createEntitiesRoutes({ db });
    const res = await app.request(
      "/entities?domain=mars&type=meeting&date=2026-12-04",
    );
    expect(res.status).toBe(400);
  });

  it("tier-2: rejects unknown type", async () => {
    const app = createEntitiesRoutes({ db });
    const res = await app.request(
      "/entities?domain=work&type=widget&date=2026-12-04",
    );
    expect(res.status).toBe(400);
  });

  it("tier-2: rejects malformed date", async () => {
    const app = createEntitiesRoutes({ db });
    const res = await app.request(
      "/entities?domain=work&type=meeting&date=12/4/2026",
    );
    expect(res.status).toBe(400);
  });

  it("tier-2: rejects negative limit", async () => {
    const app = createEntitiesRoutes({ db });
    const res = await app.request(
      "/entities?domain=work&type=meeting&date=2026-12-04&limit=-1",
    );
    expect(res.status).toBe(400);
  });

  it("tier-2: rejects non-numeric limit", async () => {
    // Exercises `!Number.isFinite(n)` branch where parseInt returns NaN.
    const app = createEntitiesRoutes({ db });
    const res = await app.request(
      "/entities?domain=work&type=meeting&date=2026-12-04&limit=abc",
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("validation_error");
  });

  it("tier-2: applies a valid limit when provided", async () => {
    // Exercises the `limit = n` assignment branch — the false side of the
    // `!Number.isFinite(n) || n < 1` validation guard.
    for (let i = 0; i < 5; i++) {
      seedEntity(db, {
        path: `work/meetings/2026-12-04-foo${i}.md`,
        domain: "work",
        type: "meeting",
        slug: `2026-12-04-foo${i}`,
        title: `Foo ${i}`,
        date: "2026-12-04",
      });
    }
    const app = createEntitiesRoutes({ db });
    const res = await app.request(
      "/entities?domain=work&type=meeting&date=2026-12-04&limit=2",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tier: number; items: unknown[] };
    expect(body.tier).toBe(2);
    expect(body.items.length).toBe(2);
  });

  it("tier-2: rejects when only domain is supplied", async () => {
    // The tier-2 missing-fields validator: `!domain || !type || !date`.
    // domain is set but type/date are missing → 400 with the structured
    // validation_error envelope.
    const app = createEntitiesRoutes({ db });
    const res = await app.request("/entities?domain=work");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("validation_error");
    expect(body.message).toMatch(/tier-2 lookup requires/);
  });

  it("tier-2: rejects when only type is supplied", async () => {
    const app = createEntitiesRoutes({ db });
    const res = await app.request("/entities?type=meeting");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("validation_error");
  });

  it("tier-2: rejects when only date is supplied", async () => {
    const app = createEntitiesRoutes({ db });
    const res = await app.request("/entities?date=2026-12-04");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("validation_error");
  });

  it("tier-2: flags `date` as the missing field when domain + type are set", async () => {
    // Exercises the third arm of `!domain ? "domain" : !type ? "type" : "date"`.
    const app = createEntitiesRoutes({ db });
    const res = await app.request("/entities?domain=work&type=meeting");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: Array<{ field: string }> };
    expect(body.errors[0].field).toBe("date");
  });
});

describe("GET /api/entities/by-path", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => db.close());

  it("returns the entity when the path exists", async () => {
    seedEntity(db, {
      path: "work/meetings/2026-12-04-foo.md",
      domain: "work",
      type: "meeting",
      slug: "2026-12-04-foo",
      title: "Foo",
      sources: { zoom: { external_id: "zm_x" } },
    });
    const app = createEntitiesRoutes({ db });
    const res = await app.request(
      "/entities/by-path?path=work/meetings/2026-12-04-foo.md",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      item: { slug: string; sources: Record<string, unknown> };
    };
    expect(body.item.slug).toBe("2026-12-04-foo");
    expect(body.item.sources.zoom).toMatchObject({ external_id: "zm_x" });
  });

  it("returns 404 when the path does not exist", async () => {
    const app = createEntitiesRoutes({ db });
    const res = await app.request(
      "/entities/by-path?path=work/meetings/missing.md",
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when the path is malformed", async () => {
    const app = createEntitiesRoutes({ db });
    const res = await app.request(
      "/entities/by-path?path=../etc/passwd",
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 when path is missing", async () => {
    const app = createEntitiesRoutes({ db });
    const res = await app.request("/entities/by-path");
    expect(res.status).toBe(400);
  });
});

describe("buildEntitiesRoutesDepsFromApi", () => {
  it("forwards the db handle from ApiDependencies", () => {
    const db = new Database(":memory:");
    applySchema(db);
    const deps = { db } as unknown as ApiDependencies;
    const result = buildEntitiesRoutesDepsFromApi(deps);
    expect(result).toEqual({ db });
    // Same reference, not a copy — the routes hold the live handle.
    expect(result.db).toBe(db);
    db.close();
  });
});
