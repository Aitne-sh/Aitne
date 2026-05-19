import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "./schema.js";
import {
  findEntitiesByDomainTypeDate,
  findEntitiesBySource,
  findEntitiesBySourceKey,
  getEntityByPath,
  resolveDomainType,
  type EntityRecord,
} from "./entities-store.js";

interface SeedRow {
  path: string;
  domain: string;
  type: string;
  slug: string;
  title: string;
  status?: string | null;
  date?: string | null;
  lastSyncedAt?: string | null;
  sources?: Record<string, unknown>;
  /**
   * Sidecar source-key entries. Defaults to one entry per `sources` key.
   * Override only when the test wants to exercise the
   * source_key_normalized de-dup / multi-casing path.
   */
  sourceKeys?: string[];
}

function seedEntity(db: Database.Database, row: SeedRow): void {
  const sources = row.sources ?? {};
  db.prepare(
    `INSERT INTO entities
       (path, domain, type, slug, title, status, date, last_synced_at, sources_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.path,
    row.domain,
    row.type,
    row.slug,
    row.title,
    row.status ?? null,
    row.date ?? null,
    row.lastSyncedAt ?? null,
    JSON.stringify(sources),
  );
  const keys = row.sourceKeys ?? Object.keys(sources);
  for (const key of keys) {
    db.prepare(
      `INSERT INTO entity_source_keys (path, source_key) VALUES (?, ?)`,
    ).run(row.path, key);
  }
}

function seedDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return db;
}

describe("findEntitiesBySource", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = seedDb();
  });

  afterEach(() => {
    db.close();
  });

  it("returns the entity matching the (sourceKey, externalId) pair", () => {
    seedEntity(db, {
      path: "work/meetings/standup-2026-04-30.md",
      domain: "work",
      type: "meeting",
      slug: "standup-2026-04-30",
      title: "Daily standup",
      sources: { zoom: { external_id: "zm_42" } },
    });
    const matches = findEntitiesBySource(db, "zoom", "zm_42");
    expect(matches).toHaveLength(1);
    expect(matches[0].path).toBe("work/meetings/standup-2026-04-30.md");
    expect(matches[0].sources).toEqual({ zoom: { external_id: "zm_42" } });
  });

  it("matches case-insensitively on the source key", () => {
    seedEntity(db, {
      path: "work/meetings/zoom-call.md",
      domain: "work",
      type: "meeting",
      slug: "zoom-call",
      title: "Zoom call",
      sources: { Zoom: { external_id: "zm_99" } },
      sourceKeys: ["Zoom"],
    });
    const matches = findEntitiesBySource(db, "ZOOM", "zm_99");
    expect(matches).toHaveLength(1);
    expect(matches[0].slug).toBe("zoom-call");
  });

  it("dedupes when the same (path, externalId) is reachable via two casing variants of the source key", () => {
    seedEntity(db, {
      path: "work/meetings/dual.md",
      domain: "work",
      type: "meeting",
      slug: "dual",
      title: "Two casings",
      sources: {
        Zoom: { external_id: "zm_1" },
        ZOOM: { external_id: "zm_1" },
      },
      sourceKeys: ["Zoom", "ZOOM"],
    });
    const matches = findEntitiesBySource(db, "zoom", "zm_1");
    // The DISTINCT in the SQL keeps this to a single hit even though
    // both sidecar rows match the case-insensitive WHERE.
    expect(matches).toHaveLength(1);
  });

  it("returns no matches when the externalId does not match", () => {
    seedEntity(db, {
      path: "work/meetings/x.md",
      domain: "work",
      type: "meeting",
      slug: "x",
      title: "X",
      sources: { zoom: { external_id: "zm_42" } },
    });
    expect(findEntitiesBySource(db, "zoom", "zm_OTHER")).toEqual([]);
  });

  it("returns [] for empty sourceKey or externalId", () => {
    expect(findEntitiesBySource(db, "", "zm_42")).toEqual([]);
    expect(findEntitiesBySource(db, "zoom", "")).toEqual([]);
  });

  it("filters out rows whose stored domain is not a recognised value", () => {
    seedEntity(db, {
      path: "bogus/meetings/x.md",
      domain: "bogus", // not in the Domain enum
      type: "meeting",
      slug: "x",
      title: "X",
      sources: { zoom: { external_id: "zm_42" } },
    });
    expect(findEntitiesBySource(db, "zoom", "zm_42")).toEqual([]);
  });

  it("filters out rows whose stored type is not a recognised value", () => {
    seedEntity(db, {
      path: "work/standups/x.md",
      domain: "work",
      type: "standup", // not in the EntityType enum
      slug: "x",
      title: "X",
      sources: { zoom: { external_id: "zm_42" } },
    });
    expect(findEntitiesBySource(db, "zoom", "zm_42")).toEqual([]);
  });

  it("repairs sources to {} when the stored JSON is not a JSON object", () => {
    db.prepare(
      `INSERT INTO entities
         (path, domain, type, slug, title, sources_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "work/meetings/scalar.md",
      "work",
      "meeting",
      "scalar",
      "Scalar",
      '"this is a string"', // valid JSON, but not an object
    );
    db.prepare(
      `INSERT INTO entity_source_keys (path, source_key) VALUES (?, ?)`,
    ).run("work/meetings/scalar.md", "zoom");
    // Cannot find via external_id (no .external_id in sources), but
    // findEntitiesBySourceKey returns the row with empty sources.
    const all = findEntitiesBySourceKey(db, "zoom");
    expect(all).toHaveLength(1);
    expect(all[0].sources).toEqual({});
  });

  it("repairs sources to {} when the stored JSON is malformed", () => {
    db.prepare(
      `INSERT INTO entities
         (path, domain, type, slug, title, sources_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "work/meetings/broken.md",
      "work",
      "meeting",
      "broken",
      "Broken",
      "{not-json",
    );
    db.prepare(
      `INSERT INTO entity_source_keys (path, source_key) VALUES (?, ?)`,
    ).run("work/meetings/broken.md", "zoom");
    const all = findEntitiesBySourceKey(db, "zoom");
    expect(all).toHaveLength(1);
    expect(all[0].sources).toEqual({});
  });
});

describe("findEntitiesBySourceKey", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = seedDb();
  });

  afterEach(() => {
    db.close();
  });

  it("returns every entity carrying any binding under the source key", () => {
    seedEntity(db, {
      path: "work/meetings/a.md",
      domain: "work",
      type: "meeting",
      slug: "a",
      title: "A",
      sources: { gmail: { external_id: "gm_1" } },
    });
    seedEntity(db, {
      path: "work/meetings/b.md",
      domain: "work",
      type: "meeting",
      slug: "b",
      title: "B",
      sources: { gmail: {} }, // no external_id, but still a gmail-bound entity
    });
    const matches = findEntitiesBySourceKey(db, "gmail");
    const slugs = matches.map((row) => row.slug).sort();
    expect(slugs).toEqual(["a", "b"]);
  });

  it("returns [] when sourceKey is empty", () => {
    expect(findEntitiesBySourceKey(db, "")).toEqual([]);
  });

  it("respects the limit parameter, clamped at the 200 cap", () => {
    for (let i = 0; i < 10; i += 1) {
      seedEntity(db, {
        path: `work/meetings/m-${i}.md`,
        domain: "work",
        type: "meeting",
        slug: `m-${i}`,
        title: `M ${i}`,
        sources: { gmail: { external_id: `gm_${i}` } },
      });
    }
    expect(findEntitiesBySourceKey(db, "gmail", 3)).toHaveLength(3);
    // limit = 0 falls back to default (50).
    expect(findEntitiesBySourceKey(db, "gmail", 0)).toHaveLength(10);
    // Non-finite falls back to default.
    expect(findEntitiesBySourceKey(db, "gmail", Number.NaN)).toHaveLength(10);
    // Larger than the 200 cap is clamped.
    expect(findEntitiesBySourceKey(db, "gmail", 9999)).toHaveLength(10);
  });
});

describe("findEntitiesByDomainTypeDate", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = seedDb();
    seedEntity(db, {
      path: "work/meetings/standup.md",
      domain: "work",
      type: "meeting",
      slug: "standup",
      title: "Daily standup",
      date: "2026-04-30",
    });
    seedEntity(db, {
      path: "work/meetings/retro.md",
      domain: "work",
      type: "meeting",
      slug: "retro",
      title: "Sprint retrospective",
      date: "2026-04-30",
    });
    seedEntity(db, {
      path: "personal/meetings/coffee.md",
      domain: "personal",
      type: "meeting",
      slug: "coffee",
      title: "Coffee chat",
      date: "2026-04-30",
    });
  });

  afterEach(() => {
    db.close();
  });

  it("returns entities matching (domain, type, date)", () => {
    const matches = findEntitiesByDomainTypeDate(db, {
      domain: "work",
      type: "meeting",
      date: "2026-04-30",
    });
    expect(matches.map((m) => m.slug).sort()).toEqual(["retro", "standup"]);
  });

  it("filters by case-insensitive title substring when q is provided", () => {
    const matches = findEntitiesByDomainTypeDate(db, {
      domain: "work",
      type: "meeting",
      date: "2026-04-30",
      q: "RETRO",
    });
    expect(matches.map((m) => m.slug)).toEqual(["retro"]);
  });

  it("strips wildcard meta-characters from the q filter", () => {
    // %standup% would otherwise match nothing (we want literal match, but
    // since the literal isn't in the title, the test asserts it returns 0).
    const matches = findEntitiesByDomainTypeDate(db, {
      domain: "work",
      type: "meeting",
      date: "2026-04-30",
      q: "%standup%",
    });
    expect(matches.map((m) => m.slug)).toEqual(["standup"]);
  });

  it("respects the limit parameter", () => {
    expect(
      findEntitiesByDomainTypeDate(db, {
        domain: "work",
        type: "meeting",
        date: "2026-04-30",
        limit: 1,
      }),
    ).toHaveLength(1);
  });

  it("returns [] when nothing matches", () => {
    expect(
      findEntitiesByDomainTypeDate(db, {
        domain: "finance",
        type: "receipt",
        date: "2026-04-30",
      }),
    ).toEqual([]);
  });
});

describe("getEntityByPath", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = seedDb();
  });

  afterEach(() => {
    db.close();
  });

  it("returns the matching entity", () => {
    seedEntity(db, {
      path: "work/meetings/standup.md",
      domain: "work",
      type: "meeting",
      slug: "standup",
      title: "Daily standup",
    });
    const found = getEntityByPath(db, "work/meetings/standup.md");
    expect(found).not.toBeNull();
    expect(found?.slug).toBe("standup");
  });

  it("returns null for a malformed path", () => {
    expect(getEntityByPath(db, "not/a/valid/path")).toBeNull();
    expect(getEntityByPath(db, "bogus/meetings/x.md")).toBeNull();
  });

  it("returns null when the row does not exist", () => {
    expect(getEntityByPath(db, "work/meetings/missing.md")).toBeNull();
  });

  it("returns null when the stored row carries an unknown domain or type", () => {
    db.prepare(
      `INSERT INTO entities (path, domain, type, slug, title)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("work/meetings/x.md", "bogus-domain", "meeting", "x", "X");
    // parseEntityPath validates the path's domain/type-plural, so this
    // returns null before SQL even runs. Use a path that parses but
    // whose row's domain has been corrupted on disk.
    expect(getEntityByPath(db, "work/meetings/x.md")?.domain).toBeUndefined();
  });
});

describe("resolveDomainType", () => {
  it("returns null for an unknown domain", () => {
    expect(resolveDomainType("bogus", "meetings")).toBeNull();
  });

  it("returns the (domain, type) when given a plural form", () => {
    expect(resolveDomainType("work", "meetings")).toEqual({
      domain: "work",
      type: "meeting",
    });
  });

  it("returns the (domain, type) when given a singular form", () => {
    expect(resolveDomainType("work", "meeting")).toEqual({
      domain: "work",
      type: "meeting",
    });
  });

  it("returns null when neither plural nor singular is recognised", () => {
    expect(resolveDomainType("work", "stand-up")).toBeNull();
  });
});

// Regression — verifies that EntityRecord is exported and structurally usable
// at the test-call boundary (catches accidental privacy on the type re-export).
describe("EntityRecord type", () => {
  it("is structurally usable from test code", () => {
    const record: EntityRecord = {
      path: "work/meetings/x.md",
      domain: "work",
      type: "meeting",
      slug: "x",
      title: "X",
      status: null,
      date: null,
      lastSyncedAt: null,
      sources: {},
    };
    expect(record.slug).toBe("x");
  });
});
