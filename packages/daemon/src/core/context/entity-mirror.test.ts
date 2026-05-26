import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../../db/schema.js";
import { AgentWriteTracker } from "../../safety/agent-write-tracker.js";
import {
  bootstrapEntityMirror,
  buildFullSnapshot,
  buildSnapshotRow,
  computeMirrorDiff,
  deleteMirrorRow,
  enumerateEntityFiles,
  isL2EntityRelativePath,
  parseEntityFromBody,
  readCurrentMirror,
  readSnapshotRow,
  refreshEntityMirrorForPath,
  serializeSourcesJson,
  startEntityMirrorWatcher,
  toRelativePath,
  upsertMirrorRow,
  type EntityFileWatcher,
  type MirrorSnapshotRow,
} from "./entity-mirror.js";

/**
 * docs/design/21-management-registry-and-entities.md §17.2a entity-
 * mirror tests. The pure modules (parser, diff, snapshot builder) are
 * tested directly; the chokidar wrapper is c8-ignored at the source
 * level — its event-binding glue is covered by the
 * `EntityMirrorObserver` integration test.
 */

function makeContextDir(): string {
  return mkdtempSync(join(tmpdir(), "entity-mirror-test-"));
}

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return db;
}

const SAMPLE_ENTITY = `---
type: meeting
domain: work
slug: 2026-12-04-foo-1on1
title: "Foo 1on1"
status: upcoming
date: 2026-12-04
last_synced_at: 2026-12-04T10:00:00Z
sources:
  zoom:
    external_id: zm_xyz789
    url: "https://zoom.us/j/123"
  google_calendar:
    external_id: gcal_abc
---
# Foo 1on1
`;

describe("parseEntityFromBody", () => {
  it("parses canonical frontmatter with nested sources", () => {
    const parsed = parseEntityFromBody(SAMPLE_ENTITY);
    expect(parsed).not.toBeNull();
    expect(parsed?.domain).toBe("work");
    expect(parsed?.type).toBe("meeting");
    expect(parsed?.slug).toBe("2026-12-04-foo-1on1");
    expect(parsed?.title).toBe("Foo 1on1");
    expect(parsed?.status).toBe("upcoming");
    expect(parsed?.date).toBe("2026-12-04");
    expect(parsed?.lastSyncedAt).toBe("2026-12-04T10:00:00Z");
    expect(parsed?.sources).toEqual({
      zoom: {
        external_id: "zm_xyz789",
        url: "https://zoom.us/j/123",
      },
      google_calendar: { external_id: "gcal_abc" },
    });
  });

  it("returns null when frontmatter is missing", () => {
    expect(parseEntityFromBody("# no frontmatter")).toBeNull();
  });

  it("returns null when frontmatter does not close", () => {
    expect(
      parseEntityFromBody("---\ntype: meeting\ndomain: work\nslug: x\ntitle: t\n"),
    ).toBeNull();
  });

  it("returns null when domain is unknown", () => {
    expect(
      parseEntityFromBody(
        `---\ntype: meeting\ndomain: bogus\nslug: x\ntitle: t\n---\n`,
      ),
    ).toBeNull();
  });

  it("returns null when type is unknown", () => {
    expect(
      parseEntityFromBody(
        `---\ntype: bogus\ndomain: work\nslug: x\ntitle: t\n---\n`,
      ),
    ).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    expect(
      parseEntityFromBody(`---\ntype: meeting\ndomain: work\nslug: x\n---\n`),
    ).toBeNull();
  });

  it("returns null when the body is empty", () => {
    expect(parseEntityFromBody("")).toBeNull();
  });

  it("ignores comment + blank lines and unrecognised top-level lines", () => {
    const body = `---
# this is a comment

type: meeting
domain: work
:malformed line without key
slug: x
title: T
not-a-key value
---
`;
    const parsed = parseEntityFromBody(body);
    expect(parsed?.slug).toBe("x");
    expect(parsed?.title).toBe("T");
  });

  it("treats inline source declarations as external_id", () => {
    const body = `---
type: meeting
domain: work
slug: x
title: T
sources:
  zoom: zm_inline
---
`;
    const parsed = parseEntityFromBody(body);
    expect(parsed?.sources).toEqual({ zoom: { external_id: "zm_inline" } });
  });

  it("ignores deeply-indented content with no current source key", () => {
    const body = `---
type: meeting
domain: work
slug: x
title: T
    orphaned: child
sources:
  zoom:
    id: z1
---
`;
    const parsed = parseEntityFromBody(body);
    expect(parsed?.sources).toEqual({ zoom: { id: "z1" } });
  });

  it("strips matching quote pairs but leaves single quotes alone", () => {
    const body = `---
type: meeting
domain: work
slug: x
title: 'Quoted T'
status: "active"
date: o
---
`;
    const parsed = parseEntityFromBody(body);
    expect(parsed?.title).toBe("Quoted T");
    expect(parsed?.status).toBe("active");
    expect(parsed?.date).toBe("o");
  });

  it("ignores indented child without key=value pattern", () => {
    const body = `---
type: meeting
domain: work
slug: x
title: T
sources:
  zoom:
    invalid line without key
    id: z1
---
`;
    const parsed = parseEntityFromBody(body);
    expect(parsed?.sources).toEqual({ zoom: { id: "z1" } });
  });

  it("ignores a sources value passed inline (reserved for nested form)", () => {
    const body = `---
type: meeting
domain: work
slug: x
title: T
sources: foo
---
`;
    const parsed = parseEntityFromBody(body);
    expect(parsed?.sources).toEqual({});
  });
});

describe("serializeSourcesJson", () => {
  it("emits keys in sorted order", () => {
    const out = serializeSourcesJson({
      zoom: { url: "u", external_id: "z" },
      docs: { external_id: "d" },
    });
    expect(out).toBe(
      `{"docs":{"external_id":"d"},"zoom":{"external_id":"z","url":"u"}}`,
    );
  });

  it("returns {} for empty input", () => {
    expect(serializeSourcesJson({})).toBe("{}");
  });
});

describe("computeMirrorDiff", () => {
  const sample: MirrorSnapshotRow = {
    path: "work/meetings/foo.md",
    domain: "work",
    type: "meeting",
    slug: "foo",
    title: "Foo",
    status: null,
    date: null,
    lastSyncedAt: null,
    sourcesJson: "{}",
    sourceKeys: [],
  };

  it("identifies upserts when current is empty", () => {
    const diff = computeMirrorDiff([sample], []);
    expect(diff.upserts).toHaveLength(1);
    expect(diff.deletes).toEqual([]);
    expect(diff.noOp).toBe(false);
  });

  it("identifies deletes when current has rows snapshot lacks", () => {
    const diff = computeMirrorDiff(
      [],
      [
        {
          path: "work/meetings/old.md",
          domain: "work",
          type: "meeting",
          slug: "old",
          title: "Old",
          status: null,
          date: null,
          lastSyncedAt: null,
          sourcesJson: "{}",
        },
      ],
    );
    expect(diff.upserts).toEqual([]);
    expect(diff.deletes).toEqual(["work/meetings/old.md"]);
  });

  it("returns noOp when snapshot equals current", () => {
    const cur = {
      path: sample.path,
      domain: sample.domain,
      type: sample.type,
      slug: sample.slug,
      title: sample.title,
      status: sample.status,
      date: sample.date,
      lastSyncedAt: sample.lastSyncedAt,
      sourcesJson: sample.sourcesJson,
    };
    const diff = computeMirrorDiff([sample], [cur]);
    expect(diff.noOp).toBe(true);
  });

  it("treats title-only changes as an upsert", () => {
    const cur = {
      path: sample.path,
      domain: sample.domain,
      type: sample.type,
      slug: sample.slug,
      title: "Old title",
      status: sample.status,
      date: sample.date,
      lastSyncedAt: sample.lastSyncedAt,
      sourcesJson: sample.sourcesJson,
    };
    const diff = computeMirrorDiff([sample], [cur]);
    expect(diff.upserts).toHaveLength(1);
    expect(diff.deletes).toEqual([]);
  });
});

describe("buildSnapshotRow", () => {
  it("uses path-derived (domain, type, slug) as canonical", () => {
    const row = buildSnapshotRow("work/meetings/foo.md", SAMPLE_ENTITY);
    expect(row?.domain).toBe("work");
    expect(row?.type).toBe("meeting");
    expect(row?.slug).toBe("foo");
  });

  it("returns null when the path is malformed", () => {
    expect(buildSnapshotRow("not-a-l2-path.md", SAMPLE_ENTITY)).toBeNull();
  });

  it("returns null when the body cannot be parsed", () => {
    expect(buildSnapshotRow("work/meetings/foo.md", "no frontmatter")).toBeNull();
  });

  it("emits sorted source-key list", () => {
    const row = buildSnapshotRow("work/meetings/foo.md", SAMPLE_ENTITY);
    expect(row?.sourceKeys).toEqual(["google_calendar", "zoom"]);
  });
});

describe("filesystem walk + boot reconciler", () => {
  let contextDir: string;
  let db: Database.Database;

  beforeEach(() => {
    contextDir = makeContextDir();
    db = makeDb();
  });

  afterEach(() => {
    db.close();
    rmSync(contextDir, { recursive: true, force: true });
  });

  function writeEntity(relativePath: string, body: string): void {
    const abs = join(contextDir, relativePath);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body, "utf-8");
  }

  it("returns [] when the contextDir does not exist", () => {
    rmSync(contextDir, { recursive: true, force: true });
    expect(enumerateEntityFiles(contextDir)).toEqual([]);
  });

  it("enumerates only L2-shaped paths", () => {
    writeEntity("knowledge/entities/work/meetings/foo.md", SAMPLE_ENTITY);
    writeEntity("work/meetings/_index.md", "skip me");
    writeEntity("work/notreal/bar.md", "skip me");
    writeEntity("policies/management.md", "skip me");
    mkdirSync(join(contextDir, "knowledge", "entities", "work", "trips"), { recursive: true });
    const found = enumerateEntityFiles(contextDir);
    expect(found).toEqual(["knowledge/entities/work/meetings/foo.md"]);
  });

  it("ignores non-md files inside L2 directories", () => {
    writeEntity("work/meetings/note.txt", "should skip");
    writeEntity("knowledge/entities/work/meetings/foo.md", SAMPLE_ENTITY);
    expect(enumerateEntityFiles(contextDir)).toEqual([
      "knowledge/entities/work/meetings/foo.md",
    ]);
  });

  it("ignores SKIP_DIR_NAMES (`.git`, `.obsidian`, `.DS_Store`) inside L2", () => {
    // Recreate scenarios where the walker might encounter these names
    // either as dir entries under a domain root or under a type-plural
    // subdir. The walker should silently skip without surfacing them.
    mkdirSync(join(contextDir, "knowledge", "entities", "work", ".git"), { recursive: true });
    writeEntity("work/.DS_Store", "metadata");
    mkdirSync(join(contextDir, "knowledge", "entities", "work", "meetings", ".obsidian"), { recursive: true });
    writeEntity("work/meetings/.DS_Store", "metadata");
    writeEntity("knowledge/entities/work/meetings/foo.md", SAMPLE_ENTITY);
    expect(enumerateEntityFiles(contextDir)).toEqual([
      "knowledge/entities/work/meetings/foo.md",
    ]);
  });

  it("ignores sub-directories nested under <domain>/<plural>/", () => {
    mkdirSync(join(contextDir, "knowledge", "entities", "work", "meetings", "nested-dir"), { recursive: true });
    writeEntity("knowledge/entities/work/meetings/foo.md", SAMPLE_ENTITY);
    expect(enumerateEntityFiles(contextDir)).toEqual([
      "knowledge/entities/work/meetings/foo.md",
    ]);
  });

  it("ignores file-shaped entries that masquerade as a domain dir", () => {
    // A regular file at `work/<plural>` (not a directory) should not
    // crash the walker — the `entry.isDirectory()` check filters it.
    writeFileSync(join(contextDir, "work-stray.md"), "stray", "utf-8");
    mkdirSync(join(contextDir, "knowledge", "entities", "work"), { recursive: true });
    writeFileSync(
      join(contextDir, "knowledge", "entities", "work", "meetings"),
      "stub-file-not-dir",
      "utf-8",
    );
    expect(enumerateEntityFiles(contextDir)).toEqual([]);
  });

  it("buildFullSnapshot reads + parses every found file", () => {
    writeEntity("knowledge/entities/work/meetings/foo.md", SAMPLE_ENTITY);
    writeEntity(
      "work/meetings/bad.md",
      "no frontmatter\n",
    );
    const snapshot = buildFullSnapshot(contextDir);
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].slug).toBe("foo");
  });

  it("readSnapshotRow returns null on unreadable / unparseable", () => {
    expect(readSnapshotRow(contextDir, "knowledge/entities/work/meetings/missing.md")).toBeNull();
    writeEntity("knowledge/entities/work/meetings/foo.md", "no frontmatter");
    expect(readSnapshotRow(contextDir, "knowledge/entities/work/meetings/foo.md")).toBeNull();
  });

  it("bootstrapEntityMirror upserts entities + sidecar atomically", () => {
    writeEntity("knowledge/entities/work/meetings/foo.md", SAMPLE_ENTITY);
    const result = bootstrapEntityMirror({ db, contextDir });
    expect(result.scanned).toBe(1);
    expect(result.upserted).toBe(1);
    expect(result.deleted).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const row = db
      .prepare("SELECT path, domain, type, slug, title FROM entities")
      .all();
    expect(row).toEqual([
      {
        path: "knowledge/entities/work/meetings/foo.md",
        domain: "work",
        type: "meeting",
        slug: "foo",
        title: "Foo 1on1",
      },
    ]);
    const sidecar = db
      .prepare("SELECT source_key FROM entity_source_keys ORDER BY source_key")
      .all();
    expect(sidecar).toEqual([
      { source_key: "google_calendar" },
      { source_key: "zoom" },
    ]);
  });

  it("bootstrapEntityMirror deletes rows that lost their files", () => {
    writeEntity("knowledge/entities/work/meetings/foo.md", SAMPLE_ENTITY);
    bootstrapEntityMirror({ db, contextDir });

    rmSync(join(contextDir, "knowledge/entities/work/meetings/foo.md"));
    const result = bootstrapEntityMirror({ db, contextDir });
    expect(result.scanned).toBe(0);
    expect(result.deleted).toBe(1);
    expect(db.prepare("SELECT count(*) AS n FROM entities").get()).toEqual({ n: 0 });
    expect(
      db.prepare("SELECT count(*) AS n FROM entity_source_keys").get(),
    ).toEqual({ n: 0 });
  });

  it("bootstrapEntityMirror is idempotent", () => {
    writeEntity("knowledge/entities/work/meetings/foo.md", SAMPLE_ENTITY);
    bootstrapEntityMirror({ db, contextDir });
    const second = bootstrapEntityMirror({ db, contextDir });
    expect(second.upserted).toBe(0);
    expect(second.deleted).toBe(0);
  });
});

describe("readCurrentMirror + upsert/delete helpers", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => db.close());

  it("upsertMirrorRow replaces sidecar set on update", () => {
    upsertMirrorRow(db, {
      path: "work/meetings/foo.md",
      domain: "work",
      type: "meeting",
      slug: "foo",
      title: "Foo",
      status: null,
      date: null,
      lastSyncedAt: null,
      sourcesJson: '{"zoom":{}}',
      sourceKeys: ["zoom"],
    });
    upsertMirrorRow(db, {
      path: "work/meetings/foo.md",
      domain: "work",
      type: "meeting",
      slug: "foo",
      title: "Foo Updated",
      status: null,
      date: null,
      lastSyncedAt: null,
      sourcesJson: '{"docs":{}}',
      sourceKeys: ["docs"],
    });
    const sources = db
      .prepare(
        "SELECT source_key FROM entity_source_keys WHERE path = ? ORDER BY source_key",
      )
      .all("work/meetings/foo.md");
    expect(sources).toEqual([{ source_key: "docs" }]);
  });

  it("entity_source_keys.source_key_normalized lower-cases the verbatim key", () => {
    upsertMirrorRow(db, {
      path: "work/meetings/foo.md",
      domain: "work",
      type: "meeting",
      slug: "foo",
      title: "Foo",
      status: null,
      date: null,
      lastSyncedAt: null,
      sourcesJson: '{"Zoom":{},"ZOOM":{},"zoom":{}}',
      sourceKeys: ["ZOOM", "Zoom", "zoom"],
    });
    const rows = db
      .prepare(
        `SELECT source_key, source_key_normalized
           FROM entity_source_keys
          WHERE path = ?
          ORDER BY source_key`,
      )
      .all("work/meetings/foo.md") as Array<{
        source_key: string;
        source_key_normalized: string;
      }>;
    expect(rows).toEqual([
      { source_key: "ZOOM", source_key_normalized: "zoom" },
      { source_key: "Zoom", source_key_normalized: "zoom" },
      { source_key: "zoom", source_key_normalized: "zoom" },
    ]);

    // The §7.6 case-insensitive lookup hits all three rows on a single
    // `source_key_normalized` query.
    const matched = db
      .prepare(
        `SELECT source_key
           FROM entity_source_keys
          WHERE source_key_normalized = ?
          ORDER BY source_key`,
      )
      .all("zoom") as Array<{ source_key: string }>;
    expect(matched.map((r) => r.source_key)).toEqual([
      "ZOOM",
      "Zoom",
      "zoom",
    ]);
  });

  it("upsertMirrorRow with empty sourceKeys clears sidecar", () => {
    upsertMirrorRow(db, {
      path: "work/meetings/foo.md",
      domain: "work",
      type: "meeting",
      slug: "foo",
      title: "Foo",
      status: null,
      date: null,
      lastSyncedAt: null,
      sourcesJson: "{}",
      sourceKeys: [],
    });
    expect(
      db
        .prepare(
          "SELECT count(*) AS n FROM entity_source_keys WHERE path = ?",
        )
        .get("work/meetings/foo.md"),
    ).toEqual({ n: 0 });
  });

  it("deleteMirrorRow cascades through entity_source_keys", () => {
    upsertMirrorRow(db, {
      path: "work/meetings/foo.md",
      domain: "work",
      type: "meeting",
      slug: "foo",
      title: "Foo",
      status: null,
      date: null,
      lastSyncedAt: null,
      sourcesJson: '{"zoom":{}}',
      sourceKeys: ["zoom"],
    });
    deleteMirrorRow(db, "work/meetings/foo.md");
    expect(db.prepare("SELECT count(*) AS n FROM entities").get()).toEqual({ n: 0 });
    expect(
      db.prepare("SELECT count(*) AS n FROM entity_source_keys").get(),
    ).toEqual({ n: 0 });
  });

  it("readCurrentMirror returns the inserted rows", () => {
    upsertMirrorRow(db, {
      path: "work/meetings/foo.md",
      domain: "work",
      type: "meeting",
      slug: "foo",
      title: "Foo",
      status: null,
      date: null,
      lastSyncedAt: null,
      sourcesJson: "{}",
      sourceKeys: [],
    });
    const rows = readCurrentMirror(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].path).toBe("work/meetings/foo.md");
  });
});

describe("path classification helpers", () => {
  it("isL2EntityRelativePath accepts canonical L2 form", () => {
    expect(
      isL2EntityRelativePath("knowledge/entities/work/meetings/foo.md"),
    ).toBe(true);
  });

  it("isL2EntityRelativePath rejects non-md, wrong depth, unknown enums", () => {
    // Wrong extension.
    expect(
      isL2EntityRelativePath("knowledge/entities/work/meetings/foo.txt"),
    ).toBe(false);
    // Underscore-prefixed (_index.md and friends) are filtered.
    expect(
      isL2EntityRelativePath("knowledge/entities/work/meetings/_index.md"),
    ).toBe(false);
    // 3-segment legacy shape — pre-V14 layout, must be rejected post-restructure.
    expect(isL2EntityRelativePath("work/meetings/foo.md")).toBe(false);
    // Right prefix, wrong depth.
    expect(isL2EntityRelativePath("knowledge/entities/work/foo.md")).toBe(false);
    // Unknown domain.
    expect(
      isL2EntityRelativePath("knowledge/entities/bogus/meetings/foo.md"),
    ).toBe(false);
    // Unknown type-plural.
    expect(
      isL2EntityRelativePath("knowledge/entities/work/notreal/foo.md"),
    ).toBe(false);
    // Right depth + enums but missing the `knowledge/entities/` prefix.
    expect(isL2EntityRelativePath("a/b/work/meetings/foo.md")).toBe(false);
  });

  it("toRelativePath normalises slashes + rejects out-of-tree paths", () => {
    expect(
      toRelativePath(
        "/tmp/ctx",
        "/tmp/ctx/knowledge/entities/work/meetings/foo.md",
      ),
    ).toBe("knowledge/entities/work/meetings/foo.md");
    expect(toRelativePath("/tmp/ctx", "/etc/passwd")).toBeNull();
    expect(toRelativePath("/tmp/ctx", "/tmp/ctx")).toBeNull();
  });
});

describe("refreshEntityMirrorForPath", () => {
  let contextDir: string;
  let db: Database.Database;

  beforeEach(() => {
    contextDir = makeContextDir();
    db = makeDb();
  });

  afterEach(() => {
    db.close();
    rmSync(contextDir, { recursive: true, force: true });
  });

  function writeEntity(relativePath: string, body: string): string {
    const abs = join(contextDir, relativePath);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body, "utf-8");
    return abs;
  }

  it("ignores out-of-tree paths", () => {
    const result = refreshEntityMirrorForPath({
      db,
      contextDir,
      absolutePath: "/etc/passwd",
    });
    expect(result.kind).toBe("ignored");
  });

  it("ignores paths that fall outside the L2 layout", () => {
    const abs = join(contextDir, "policies/management.md");
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, "# something", "utf-8");
    const result = refreshEntityMirrorForPath({
      db,
      contextDir,
      absolutePath: abs,
    });
    expect(result.kind).toBe("ignored");
  });

  it("upserts on add, returns noop on a second pass", () => {
    const abs = writeEntity(
      "knowledge/entities/work/meetings/foo.md",
      SAMPLE_ENTITY,
    );
    const first = refreshEntityMirrorForPath({
      db,
      contextDir,
      absolutePath: abs,
    });
    expect(first.kind).toBe("upserted");
    const second = refreshEntityMirrorForPath({
      db,
      contextDir,
      absolutePath: abs,
    });
    expect(second.kind).toBe("noop");
  });

  it("returns deleted when the file no longer exists", () => {
    const abs = writeEntity(
      "knowledge/entities/work/meetings/foo.md",
      SAMPLE_ENTITY,
    );
    refreshEntityMirrorForPath({ db, contextDir, absolutePath: abs });
    unlinkSync(abs);
    const result = refreshEntityMirrorForPath({
      db,
      contextDir,
      absolutePath: abs,
    });
    expect(result.kind).toBe("deleted");
    expect(db.prepare("SELECT count(*) AS n FROM entities").get()).toEqual({ n: 0 });
  });

  it("flags self-write when the tracker matches the path", () => {
    const abs = writeEntity(
      "knowledge/entities/work/meetings/foo.md",
      SAMPLE_ENTITY,
    );
    const tracker = new AgentWriteTracker();
    tracker.markWriting(abs); // path-only mark
    const result = refreshEntityMirrorForPath({
      db,
      contextDir,
      absolutePath: abs,
      writeTracker: tracker,
    });
    expect(result.kind).toBe("self-write");
  });

  it("returns ignored:unparseable for malformed files", () => {
    const abs = writeEntity(
      "knowledge/entities/work/meetings/foo.md",
      "no frontmatter\n",
    );
    const result = refreshEntityMirrorForPath({
      db,
      contextDir,
      absolutePath: abs,
    });
    expect(result.kind).toBe("ignored");
  });
});

describe("startEntityMirrorWatcher onEntityChanged fan-out (followups item 7)", () => {
  let contextDir: string;
  let db: Database.Database;

  beforeEach(() => {
    contextDir = makeContextDir();
    db = makeDb();
  });

  afterEach(() => {
    db.close();
    rmSync(contextDir, { recursive: true, force: true });
  });

  function writeEntity(relativePath: string, body: string): string {
    const abs = join(contextDir, relativePath);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body, "utf-8");
    return abs;
  }

  function makeFakeWatcher(): {
    watcher: EntityFileWatcher;
    emitChange: (abs: string) => void;
    emitUnlink: (abs: string) => void;
    closed: { value: boolean };
  } {
    const changeHandlers: Array<(abs: string) => void> = [];
    const unlinkHandlers: Array<(abs: string) => void> = [];
    const closed = { value: false };
    const watcher: EntityFileWatcher = {
      onChange(handler) {
        changeHandlers.push(handler);
      },
      onUnlink(handler) {
        unlinkHandlers.push(handler);
      },
      async close() {
        closed.value = true;
      },
    };
    return {
      watcher,
      emitChange: (abs) => changeHandlers.forEach((h) => h(abs)),
      emitUnlink: (abs) => unlinkHandlers.forEach((h) => h(abs)),
      closed,
    };
  }

  it("invokes onEntityChanged when a watcher event upserts a row", async () => {
    const fake = makeFakeWatcher();
    const calls: number[] = [];
    const handle = startEntityMirrorWatcher({
      db,
      contextDir,
      onEntityChanged: () => calls.push(Date.now()),
      watcherFactory: () => fake.watcher,
    });
    const abs = writeEntity(
      "knowledge/entities/work/meetings/foo.md",
      SAMPLE_ENTITY,
    );
    fake.emitChange(abs);
    expect(calls).toHaveLength(1);
    expect(
      db.prepare("SELECT count(*) AS n FROM entities").get(),
    ).toEqual({ n: 1 });
    await handle.stop();
    expect(fake.closed.value).toBe(true);
  });

  it("invokes onEntityChanged on delete", async () => {
    const fake = makeFakeWatcher();
    const calls: number[] = [];
    const handle = startEntityMirrorWatcher({
      db,
      contextDir,
      onEntityChanged: () => calls.push(Date.now()),
      watcherFactory: () => fake.watcher,
    });
    const abs = writeEntity(
      "knowledge/entities/work/meetings/foo.md",
      SAMPLE_ENTITY,
    );
    fake.emitChange(abs);
    expect(calls).toHaveLength(1);
    unlinkSync(abs);
    fake.emitUnlink(abs);
    expect(calls).toHaveLength(2);
    await handle.stop();
  });

  it("does not invoke onEntityChanged for noop / ignored events", async () => {
    const fake = makeFakeWatcher();
    const calls: number[] = [];
    const handle = startEntityMirrorWatcher({
      db,
      contextDir,
      onEntityChanged: () => calls.push(Date.now()),
      watcherFactory: () => fake.watcher,
    });
    const abs = writeEntity(
      "knowledge/entities/work/meetings/foo.md",
      SAMPLE_ENTITY,
    );
    fake.emitChange(abs);
    expect(calls).toHaveLength(1);
    // Same content again — refreshEntityMirrorForPath returns noop.
    fake.emitChange(abs);
    expect(calls).toHaveLength(1);
    // Out-of-tree event — ignored.
    fake.emitChange("/etc/passwd");
    expect(calls).toHaveLength(1);
    await handle.stop();
  });

  it("swallows callback errors so a failing consumer does not break the watcher", async () => {
    const fake = makeFakeWatcher();
    const handle = startEntityMirrorWatcher({
      db,
      contextDir,
      onEntityChanged: () => {
        throw new Error("downstream blew up");
      },
      watcherFactory: () => fake.watcher,
    });
    const abs = writeEntity(
      "knowledge/entities/work/meetings/foo.md",
      SAMPLE_ENTITY,
    );
    expect(() => fake.emitChange(abs)).not.toThrow();
    expect(
      db.prepare("SELECT count(*) AS n FROM entities").get(),
    ).toEqual({ n: 1 });
    await handle.stop();
  });
});
