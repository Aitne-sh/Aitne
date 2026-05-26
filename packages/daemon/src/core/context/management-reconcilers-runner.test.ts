import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../../db/schema.js";
import { AgentWriteTracker } from "../../safety/agent-write-tracker.js";
import { bootstrapEntityMirror } from "./entity-mirror.js";
import { runDomainIndexReconciler } from "./domain-index-runner.js";
import { runActivityViewReconciler } from "./activity-view-runner.js";
import { setDegradedMode, clearDegradedMode } from "../../db/runtime-state.js";

/**
 * Integration tests for the §7.2 P5 runners. These exercise the full
 * (DB → render → atomic write → snapshot) pipeline using a tempdir
 * and an in-memory SQLite. The runner files themselves are excluded
 * from the coverage gate (FS + DB I/O), but a regression here would
 * still surface in CI as a failed test.
 */

interface SeedEntityInput {
  path: string; // relative
  domain: string;
  type: string;
  slug: string;
  title: string;
  date?: string | null;
  status?: string | null;
  lastSyncedAt?: string | null;
  sources?: Record<string, Record<string, unknown>>;
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
  for (const key of Object.keys(input.sources ?? {})) {
    db.prepare(
      `INSERT OR IGNORE INTO entity_source_keys (path, source_key) VALUES (?, ?)`,
    ).run(input.path, key);
  }
}

function makeContextDir(): string {
  return mkdtempSync(join(tmpdir(), "p5-runner-"));
}

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return db;
}

describe("runDomainIndexReconciler", () => {
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

  it("writes _index.md for each non-empty domain", async () => {
    seedEntity(db, {
      path: "knowledge/entities/work/meetings/foo.md",
      domain: "work",
      type: "meeting",
      slug: "foo",
      title: "Foo",
      date: "2026-12-04",
      sources: { zoom: { external_id: "zm_x" } },
    });
    const result = await runDomainIndexReconciler({
      db,
      contextDir,
      trigger: "startup",
      now: () => new Date("2026-12-05T00:00:00Z"),
    });
    expect(result.result).toBe("applied");
    expect(result.added).toBe(1);
    const body = readFileSync(join(contextDir, "knowledge/entities/work/_index.md"), "utf-8");
    expect(body).toContain("# Work — Index");
    expect(body).toContain("| Foo | meeting | zoom | — | 2026-12-04 |");
  });

  it("is idempotent — second pass is a noop", async () => {
    seedEntity(db, {
      path: "knowledge/entities/work/meetings/foo.md",
      domain: "work",
      type: "meeting",
      slug: "foo",
      title: "Foo",
      date: "2026-12-04",
    });
    await runDomainIndexReconciler({
      db,
      contextDir,
      trigger: "startup",
      now: () => new Date("2026-12-05T00:00:00Z"),
    });
    const second = await runDomainIndexReconciler({
      db,
      contextDir,
      trigger: "fs_event",
      now: () => new Date("2026-12-05T00:00:00Z"),
    });
    expect(second.added).toBe(0);
    expect(second.refreshedMtime).toBe(1);
    expect(second.result).toBe("noop");
  });

  it("is a noop on second pass even when the wall-clock advances", async () => {
    // Regression: without `last_built` stripping, two runs with the
    // same data but different `now()` would diverge on the timestamp
    // line and unconditionally rewrite. Production cron / fs_event
    // chains always advance the clock, so this is the realistic case.
    seedEntity(db, {
      path: "knowledge/entities/work/meetings/foo.md",
      domain: "work",
      type: "meeting",
      slug: "foo",
      title: "Foo",
      date: "2026-12-04",
    });
    await runDomainIndexReconciler({
      db,
      contextDir,
      trigger: "startup",
      now: () => new Date("2026-12-05T00:00:00Z"),
    });
    const second = await runDomainIndexReconciler({
      db,
      contextDir,
      trigger: "fs_event",
      now: () => new Date("2026-12-05T01:23:45Z"),
    });
    expect(second.added).toBe(0);
    expect(second.refreshedMtime).toBe(1);
    expect(second.result).toBe("noop");
  });

  it("skips empty domains when no file exists yet", async () => {
    const result = await runDomainIndexReconciler({
      db,
      contextDir,
      trigger: "startup",
      now: () => new Date("2026-12-05T00:00:00Z"),
    });
    expect(result.result).toBe("noop");
    expect(existsSync(join(contextDir, "knowledge/entities/work/_index.md"))).toBe(false);
  });

  it("snapshots prior contents into md_file_snapshots", async () => {
    mkdirSync(join(contextDir, "knowledge", "entities", "work"), { recursive: true });
    writeFileSync(join(contextDir, "knowledge/entities/work/_index.md"), "old", "utf-8");
    seedEntity(db, {
      path: "knowledge/entities/work/meetings/foo.md",
      domain: "work",
      type: "meeting",
      slug: "foo",
      title: "Foo",
      date: "2026-12-04",
    });
    await runDomainIndexReconciler({
      db,
      contextDir,
      trigger: "startup",
      now: () => new Date("2026-12-05T00:00:00Z"),
    });
    const snapshots = db
      .prepare(
        "SELECT file_path, content, trigger FROM md_file_snapshots WHERE file_path = ?",
      )
      .all("knowledge/entities/work/_index.md");
    expect(snapshots).toEqual([
      {
        file_path: "knowledge/entities/work/_index.md",
        content: "old",
        trigger: "domain_index_reconciled",
      },
    ]);
  });

  it("respects degraded mode (early-exit noop)", async () => {
    setDegradedMode(db, {
      reason: "test",
      path: null,
      since: "2026-12-05T00:00:00Z",
    });
    const result = await runDomainIndexReconciler({
      db,
      contextDir,
      trigger: "startup",
      now: () => new Date("2026-12-05T00:00:00Z"),
    });
    expect(result.result).toBe("noop");
    expect(result.error).toContain("degraded_mode");
    clearDegradedMode(db);
  });

  it("marks the AgentWriteTracker so the watcher does not re-loop", async () => {
    seedEntity(db, {
      path: "knowledge/entities/work/meetings/foo.md",
      domain: "work",
      type: "meeting",
      slug: "foo",
      title: "Foo",
      date: "2026-12-04",
    });
    const tracker = new AgentWriteTracker();
    await runDomainIndexReconciler({
      db,
      contextDir,
      writeTracker: tracker,
      trigger: "startup",
      now: () => new Date("2026-12-05T00:00:00Z"),
    });
    const indexPath = join(contextDir, "knowledge/entities/work/_index.md");
    const written = readFileSync(indexPath, "utf-8");
    expect(tracker.isMarked(indexPath, written)).toBe(true);
  });
});

describe("runActivityViewReconciler", () => {
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

  function seedManagedTask(input: {
    id: string;
    app: string;
    cadence: string;
    scheduleId?: number;
    lastRunAt?: string | null;
    lastResult?: string | null;
  }): void {
    const scheduleId = input.scheduleId ?? 1;
    db.prepare(
      `INSERT INTO recurring_schedules (id, task_type, recurrence_rule)
        VALUES (?, 'managed_task', '{}')`,
    ).run(scheduleId);
    db.prepare(
      `INSERT INTO managed_tasks
         (id, intent, app, app_normalized, cadence, output_path, schedule_id,
          last_run_at, last_result, consecutive_failures, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 0, datetime('now'), datetime('now'))`,
    ).run(
      input.id,
      "intent",
      input.app,
      input.app.toLowerCase(),
      input.cadence,
      scheduleId,
      input.lastRunAt ?? null,
      input.lastResult ?? null,
    );
  }

  it("renders an activity file for a source backed by a managed task", async () => {
    seedManagedTask({
      id: "mt_1",
      app: "Zoom",
      cadence: "daily 10:00",
      lastRunAt: "2026-12-04T10:00Z",
      lastResult: "ok (3 new)",
    });
    seedEntity(db, {
      path: "knowledge/entities/work/meetings/foo.md",
      domain: "work",
      type: "meeting",
      slug: "foo",
      title: "Foo",
      date: "2026-12-04",
      sources: {
        Zoom: { external_id: "zm_x", duration: "60min" },
      },
    });
    const result = await runActivityViewReconciler({
      db,
      contextDir,
      trigger: "startup",
      now: () => new Date("2026-12-05T00:00:00Z"),
    });
    expect(result.result).toBe("applied");
    expect(result.added).toBe(1);
    const body = readFileSync(
      join(contextDir, "state/activity/zoom.md"),
      "utf-8",
    );
    expect(body).toContain("source: zoom");
    expect(body).toContain("- mt_1 daily 10:00 — last 2026-12-04T10:00Z ok (3 new)");
    expect(body).toContain(
      "[Foo](../../knowledge/entities/work/meetings/foo.md)",
    );
    expect(body).toContain("duration 60min");
  });

  it("prunes activity files for sources that no longer exist", async () => {
    mkdirSync(join(contextDir, "state", "activity"), { recursive: true });
    writeFileSync(
      join(contextDir, "state/activity/stale.md"),
      "old content",
      "utf-8",
    );
    const result = await runActivityViewReconciler({
      db,
      contextDir,
      trigger: "startup",
      now: () => new Date("2026-12-05T00:00:00Z"),
    });
    expect(result.removed).toBe(1);
    expect(existsSync(join(contextDir, "state/activity/stale.md"))).toBe(false);
    const snapshots = db
      .prepare(
        "SELECT file_path, trigger FROM md_file_snapshots WHERE file_path = ?",
      )
      .all("state/activity/stale.md");
    expect(snapshots).toHaveLength(1);
  });

  it("does not duplicate an entity that carries multiple casing variants of the same source", async () => {
    // Regression: a single entity whose frontmatter declares both
    // `sources.Zoom` and `sources.ZOOM` produces two `entity_source_keys`
    // rows because the (path, source_key) PK treats casing as distinct.
    // The activity-view JOIN against `source_key_normalized` then returns
    // the entity twice. The renderer must collapse this to one row.
    seedManagedTask({
      id: "mt_1",
      app: "Zoom",
      cadence: "daily 10:00",
    });
    seedEntity(db, {
      path: "knowledge/entities/work/meetings/twokeys.md",
      domain: "work",
      type: "meeting",
      slug: "twokeys",
      title: "Two-key meeting",
      date: "2026-12-04",
      sources: {
        Zoom: { external_id: "zm_a" },
        ZOOM: { external_id: "zm_b" },
      },
    });

    const result = await runActivityViewReconciler({
      db,
      contextDir,
      trigger: "startup",
      now: () => new Date("2026-12-05T00:00:00Z"),
    });
    expect(result.result).toBe("applied");
    expect(result.added).toBe(1);

    const body = readFileSync(
      join(contextDir, "state/activity/zoom.md"),
      "utf-8",
    );
    const occurrences = body.split("Two-key meeting").length - 1;
    expect(occurrences).toBe(1);
  });

  it("collapses three casing variants of the same source onto one activity file", async () => {
    // §7.6.1 source_key_normalized — entities written with `Zoom`,
    // `zoom`, or `ZOOM` in their frontmatter all surface in the single
    // rendered `_activity/zoom.md`. Pre-fix this dropped the `ZOOM` row
    // because the dual-query fallback only covered two casings.
    seedManagedTask({
      id: "mt_1",
      app: "Zoom",
      cadence: "daily 10:00",
    });
    seedEntity(db, {
      path: "knowledge/entities/work/meetings/foo-cap.md",
      domain: "work",
      type: "meeting",
      slug: "foo-cap",
      title: "Foo (CAP)",
      date: "2026-12-04",
      sources: { ZOOM: { external_id: "zm_a" } },
    });
    seedEntity(db, {
      path: "knowledge/entities/work/meetings/foo-pretty.md",
      domain: "work",
      type: "meeting",
      slug: "foo-pretty",
      title: "Foo (Pretty)",
      date: "2026-12-04",
      sources: { Zoom: { external_id: "zm_b" } },
    });
    seedEntity(db, {
      path: "knowledge/entities/work/meetings/foo-flat.md",
      domain: "work",
      type: "meeting",
      slug: "foo-flat",
      title: "Foo (flat)",
      date: "2026-12-04",
      sources: { zoom: { external_id: "zm_c" } },
    });

    const result = await runActivityViewReconciler({
      db,
      contextDir,
      trigger: "startup",
      now: () => new Date("2026-12-05T00:00:00Z"),
    });
    expect(result.result).toBe("applied");
    expect(result.added).toBe(1);

    const body = readFileSync(
      join(contextDir, "state/activity/zoom.md"),
      "utf-8",
    );
    expect(body).toContain("Foo (CAP)");
    expect(body).toContain("Foo (Pretty)");
    expect(body).toContain("Foo (flat)");
  });

  it("includes deleted-task audit rows in 'Recently changed'", async () => {
    db.prepare(
      `INSERT INTO agent_actions
         (action_type, result, detail, started_at, completed_at)
       VALUES (?, 'success', ?, ?, ?)`,
    ).run(
      "management_task.deleted",
      JSON.stringify({
        mt_id: "mt_27",
        app: "Zoom",
        app_normalized: "zoom",
      }),
      "2026-11-15T10:00:00Z",
      "2026-11-15T10:00:00Z",
    );
    const result = await runActivityViewReconciler({
      db,
      contextDir,
      trigger: "startup",
      now: () => new Date("2026-12-05T00:00:00Z"),
    });
    expect(result.added).toBe(1);
    const body = readFileSync(
      join(contextDir, "state/activity/zoom.md"),
      "utf-8",
    );
    expect(body).toContain("- 2026-11-15 mt_27 stopped by user");
  });

  it("renders the cadence diff for a modified-task audit row", async () => {
    // Regression for design 21 §10.2 + activity-view-reconciler.ts
    // `extractAuditNote`: the route emits `from`/`to` as nested objects
    // (the canonical shape — preserved for the dashboard's history
    // card), so the reconciler MUST read `detail.from.cadence` /
    // `detail.to.cadence` rather than the flat `old_cadence` /
    // `new_cadence` keys an earlier draft expected.
    db.prepare(
      `INSERT INTO agent_actions
         (action_type, result, detail, started_at, completed_at)
       VALUES (?, 'success', ?, ?, ?)`,
    ).run(
      "management_task.modified",
      JSON.stringify({
        mt_id: "mt_42",
        app: "Zoom",
        app_normalized: "zoom",
        changed: ["cadence"],
        from: { intent: "i", cadence: "weekly", output_path: null },
        to: { intent: "i", cadence: "daily", output_path: null },
      }),
      "2026-11-10T09:00:00Z",
      "2026-11-10T09:00:00Z",
    );
    const result = await runActivityViewReconciler({
      db,
      contextDir,
      trigger: "startup",
      now: () => new Date("2026-12-05T00:00:00Z"),
    });
    expect(result.added).toBe(1);
    const body = readFileSync(
      join(contextDir, "state/activity/zoom.md"),
      "utf-8",
    );
    expect(body).toContain("- 2026-11-10 mt_42 modified (weekly → daily)");
  });

  it("surfaces a rename event in BOTH the old and new activity files", async () => {
    // Regression for design 21 §12 ("Renamed app label in
    // managed_tasks vs entity files"): the rename audit row carries
    // `app_normalized` (the post-rename label) AND
    // `old_app_normalized` (the pre-rename label) at the top level.
    // `enumerateActiveSources` and `buildActivitySnapshot` UNION on
    // both columns so the OLD source's `_activity/<old>.md` keeps
    // showing the rename event for the 90-day retention window
    // alongside the NEW one.
    db.prepare(
      `INSERT INTO agent_actions
         (action_type, result, detail, started_at, completed_at)
       VALUES (?, 'success', ?, ?, ?)`,
    ).run(
      "management_task.app_renamed",
      JSON.stringify({
        mt_id: "mt_42",
        from: "Zoom",
        to: "Google Meet",
        app: "Google Meet",
        app_normalized: "google meet",
        old_app: "Zoom",
        old_app_normalized: "zoom",
      }),
      "2026-11-15T10:00:00Z",
      "2026-11-15T10:00:00Z",
    );
    const result = await runActivityViewReconciler({
      db,
      contextDir,
      trigger: "startup",
      now: () => new Date("2026-12-05T00:00:00Z"),
    });
    // Two activity files written: the pre-rename `_activity/zoom.md`
    // (slugified from `old_app_normalized`) AND the post-rename
    // `_activity/google-meet.md` (from `app_normalized`).
    expect(result.added).toBe(2);
    const oldBody = readFileSync(
      join(contextDir, "state/activity/zoom.md"),
      "utf-8",
    );
    expect(oldBody).toContain(
      "- 2026-11-15 mt_42 app renamed (Zoom → Google Meet)",
    );
    const newBody = readFileSync(
      join(contextDir, "state/activity/google-meet.md"),
      "utf-8",
    );
    expect(newBody).toContain(
      "- 2026-11-15 mt_42 app renamed (Zoom → Google Meet)",
    );
  });

  it("noop on second pass with unchanged data", async () => {
    seedManagedTask({ id: "mt_1", app: "Zoom", cadence: "daily" });
    await runActivityViewReconciler({
      db,
      contextDir,
      trigger: "startup",
      now: () => new Date("2026-12-05T00:00:00Z"),
    });
    const second = await runActivityViewReconciler({
      db,
      contextDir,
      trigger: "fs_event",
      now: () => new Date("2026-12-05T00:00:00Z"),
    });
    expect(second.added).toBe(0);
    expect(second.refreshedMtime).toBe(1);
  });

  it("is a noop on second pass even when the wall-clock advances", async () => {
    // Regression: without `last_built` stripping, every cron / fs_event
    // chain rewrites every activity file just because `now()` advances.
    seedManagedTask({ id: "mt_1", app: "Zoom", cadence: "daily" });
    await runActivityViewReconciler({
      db,
      contextDir,
      trigger: "startup",
      now: () => new Date("2026-12-05T00:00:00Z"),
    });
    const second = await runActivityViewReconciler({
      db,
      contextDir,
      trigger: "fs_event",
      now: () => new Date("2026-12-05T01:23:45Z"),
    });
    expect(second.added).toBe(0);
    expect(second.refreshedMtime).toBe(1);
    expect(second.result).toBe("noop");
  });

  it("respects degraded mode", async () => {
    setDegradedMode(db, {
      reason: "test",
      path: null,
      since: "2026-12-05T00:00:00Z",
    });
    const result = await runActivityViewReconciler({
      db,
      contextDir,
      trigger: "startup",
      now: () => new Date("2026-12-05T00:00:00Z"),
    });
    expect(result.result).toBe("noop");
    expect(result.error).toContain("degraded_mode");
    clearDegradedMode(db);
  });
});

describe("end-to-end: bootstrap + reconcile", () => {
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

  it("converges entity-mirror + domain-index in one boot pass (NFR-9 budget)", async () => {
    // Seed a few L2 files so the boot pass walks a realistic shape.
    const files = [
      ["knowledge/entities/work/meetings/2026-12-04-foo.md", "Foo 1on1", "2026-12-04"],
      ["knowledge/entities/work/projects/acme.md", "Acme renewal", null],
      ["knowledge/entities/personal/notes/idea.md", "Idea seed", "2026-12-03"],
    ];
    for (const [path, title, date] of files) {
      const abs = join(contextDir, path as string);
      mkdirSync(join(abs, ".."), { recursive: true });
      const segments = (path as string).split("/");
      // knowledge/entities/<domain>/<plural>/...
      const [, , domain, plural] = segments;
      const type = plural === "meetings" ? "meeting"
        : plural === "projects" ? "project"
        : "note";
      writeFileSync(
        abs,
        `---
type: ${type}
domain: ${domain}
slug: ${(path as string).split("/").pop()!.replace(/\.md$/, "")}
title: ${title}
${date ? `date: ${date}` : ""}
sources:
  zoom:
    external_id: zm_${type}
---
# ${title}
`,
        "utf-8",
      );
    }

    const start = Date.now();
    const bootResult = bootstrapEntityMirror({ db, contextDir });
    const bootDuration = Date.now() - start;

    expect(bootResult.scanned).toBe(3);
    expect(bootResult.upserted).toBe(3);
    // NFR-9 — 3 files should converge well under 500 ms.
    expect(bootDuration).toBeLessThan(2_000);

    const indexResult = await runDomainIndexReconciler({
      db,
      contextDir,
      trigger: "startup",
      now: () => new Date("2026-12-05T00:00:00Z"),
    });
    expect(indexResult.added).toBe(2); // work, personal

    const activityResult = await runActivityViewReconciler({
      db,
      contextDir,
      trigger: "startup",
      now: () => new Date("2026-12-05T00:00:00Z"),
    });
    expect(activityResult.added).toBe(1); // single source: zoom
    expect(
      existsSync(join(contextDir, "state/activity/zoom.md")),
    ).toBe(true);
  });
});
