import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../db/schema.js";
import { enumerateActivitySources } from "./activity-sources.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
});

afterEach(() => {
  db.close();
});

const CUTOFF = "2020-01-01";

function insertManagementAction(detail: Record<string, unknown>, kind: string = "management_task.created"): void {
  db.prepare(
    `INSERT INTO agent_actions
       (event_id, action_type, trigger, result, detail, started_at, completed_at)
     VALUES (?, ?, 'reactive', 'success', ?, datetime('now'), datetime('now'))`,
  ).run(`evt:${Math.random()}`, kind, JSON.stringify(detail));
}

describe("enumerateActivitySources — covered-line branch coverage", () => {
  it("skips audit rows whose app_normalized json field is missing", () => {
    // Row with NO app_normalized AT ALL — the SQL `WHERE … IS NOT NULL`
    // filter should drop it before it reaches the JS loop. Add a sibling
    // valid row so the result set is non-empty.
    insertManagementAction({ note: "no app at all" });
    insertManagementAction({ app: "Calendar", app_normalized: "calendar" });
    const out = enumerateActivitySources(db, CUTOFF);
    expect(out.map((r) => r.normalized)).toEqual(["calendar"]);
  });

  it("skips audit rows where app_normalized is the JSON literal 'null'", () => {
    // SQLite json_extract returns NULL for missing keys, but a row that
    // explicitly stores `app_normalized: null` (rare but possible) flows
    // through the SQL filter and must be skipped in the JS loop at the
    // `if (!row.app_normalized) continue;` guard.
    db.prepare(
      `INSERT INTO agent_actions
         (event_id, action_type, trigger, result, detail, started_at, completed_at)
       VALUES ('explicit-null', 'management_task.created', 'reactive', 'success',
               json_object('app_normalized', json('null')),
               datetime('now'), datetime('now'))`,
    ).run();
    insertManagementAction({ app: "Mail", app_normalized: "mail" });
    const out = enumerateActivitySources(db, CUTOFF);
    expect(out.map((r) => r.normalized)).toEqual(["mail"]);
  });

  it("falls back to the normalized form as label when audit row has no readable app", () => {
    // The `?? row.app_normalized` ternary on line 105: app stored as null
    // (or missing) → label should default to the normalized form.
    db.prepare(
      `INSERT INTO agent_actions
         (event_id, action_type, trigger, result, detail, started_at, completed_at)
       VALUES ('null-app', 'management_task.created', 'reactive', 'success',
               json_object('app_normalized', 'gmail'),
               datetime('now'), datetime('now'))`,
    ).run();
    const out = enumerateActivitySources(db, CUTOFF);
    expect(out).toEqual([
      { normalized: "gmail", label: "gmail", status: "stopped" },
    ]);
  });

  it("uses managed_tasks.app as the label when both an audit and an active row claim the same normalized form", () => {
    // Active row arrives first → wins the label slot. Audit's user-typed
    // label ("g-mail" with hyphen) must NOT overwrite it.
    db.prepare(
      `INSERT INTO recurring_schedules (id, task_type, task_description, recurrence_rule)
       VALUES (101, 'scheduled.task', 'fetch — daily 10:00', '{}')`,
    ).run();
    db.prepare(
      `INSERT INTO managed_tasks (id, intent, app, app_normalized, cadence,
        output_path, schedule_id)
       VALUES ('mt-1', 'fetch', 'Gmail', 'gmail', 'daily 10:00', 'work/meetings/', 101)`,
    ).run();
    insertManagementAction({ app: "g-mail", app_normalized: "gmail" });
    const out = enumerateActivitySources(db, CUTOFF);
    expect(out).toEqual([
      { normalized: "gmail", label: "Gmail", status: "active" },
    ]);
  });

  it("contributes both new and old labels for an app_renamed audit row", () => {
    db.prepare(
      `INSERT INTO agent_actions
         (event_id, action_type, trigger, result, detail, started_at, completed_at)
       VALUES ('rename-1', 'management_task.app_renamed', 'reactive', 'success',
               json_object(
                 'app',                'New Gmail',
                 'app_normalized',     'newgmail',
                 'old_app',            'Old Gmail',
                 'old_app_normalized', 'oldgmail'
               ),
               datetime('now'), datetime('now'))`,
    ).run();
    const out = enumerateActivitySources(db, CUTOFF);
    expect(out.map((r) => r.normalized).sort()).toEqual(["newgmail", "oldgmail"]);
    expect(out.find((r) => r.normalized === "newgmail")?.label).toBe("New Gmail");
    expect(out.find((r) => r.normalized === "oldgmail")?.label).toBe("Old Gmail");
  });

  it("returns an empty list when no managed_tasks, entities, or audits match", () => {
    const out = enumerateActivitySources(db, CUTOFF);
    expect(out).toEqual([]);
  });

  it("filters entity_source_keys to entities inside the 90-day window", () => {
    // Insert one entity inside and one outside the cutoff window.
    db.prepare(
      `INSERT INTO entities (path, domain, type, slug, title, last_synced_at, date)
       VALUES ('p1', 'meetings', 'meeting', 's1', 'in', '2025-06-01', NULL),
              ('p2', 'meetings', 'meeting', 's2', 'out', '2019-01-01', NULL)`,
    ).run();
    db.prepare(
      `INSERT INTO entity_source_keys (path, source_key)
       VALUES ('p1', 'inside-window'), ('p2', 'outside-window')`,
    ).run();
    const out = enumerateActivitySources(db, CUTOFF);
    expect(out.map((r) => r.normalized)).toContain("inside-window");
    expect(out.map((r) => r.normalized)).not.toContain("outside-window");
  });

  it("preserves first-seen labels for entity-only sources (no audit/active overlap)", () => {
    db.prepare(
      `INSERT INTO entities (path, domain, type, slug, title, last_synced_at, date)
       VALUES ('p1', 'meetings', 'meeting', 's1', 'standup', '2025-06-01', NULL)`,
    ).run();
    db.prepare(
      `INSERT INTO entity_source_keys (path, source_key)
       VALUES ('p1', 'Slack: #ops')`,
    ).run();
    const out = enumerateActivitySources(db, CUTOFF);
    const row = out.find((r) => r.label === "Slack: #ops");
    expect(row?.status).toBe("stopped");
  });

  it("skips audit rows where app_normalized is an empty string (falsy JS value, passes SQL IS NOT NULL)", () => {
    // An empty-string app_normalized passes SQLite's IS NOT NULL filter (empty
    // string ≠ SQL NULL), but is falsy in JS. The `if (!row.app_normalized)
    // continue` guard on line 103 must fire and exclude it from results.
    db.prepare(
      `INSERT INTO agent_actions
         (event_id, action_type, trigger, result, detail, started_at, completed_at)
       VALUES ('empty-norm', 'management_task.created', 'reactive', 'success',
               json_object('app', 'Ghost', 'app_normalized', ''),
               datetime('now'), datetime('now'))`,
    ).run();
    insertManagementAction({ app: "Notion", app_normalized: "notion" });
    const out = enumerateActivitySources(db, CUTOFF);
    // The empty-string row is skipped; only 'notion' appears.
    expect(out.map((r) => r.normalized)).toEqual(["notion"]);
  });
});
