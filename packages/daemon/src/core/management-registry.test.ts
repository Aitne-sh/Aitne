import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type { ManagedTask, SotBindings } from "@aitne/shared";
import { applySchema } from "../db/schema.js";
import {
  bootstrapManagementRegistry,
  getManagementMdPath,
  MANAGEMENT_MD_SCHEMA_VERSION,
  parseManagementMd,
  readAndParseManagementMd,
  reconcileManagementMdFromFile,
  renderAndWriteManagementMd,
  renderManagementMd,
  verifyManagementMdLoadable,
} from "./management-registry.js";
import {
  InMemoryManagementMdWriteLockManager,
  withManagementMdWriteLock,
} from "./management-md-write-lock.js";
import { writeSotBindings } from "../db/sot-bindings-store.js";
import { listManagementParseFailures } from "../db/management-parse-failures-store.js";

const FIXED_DATE = "2026-05-03";
const FIXED_RENDER = { updatedDate: FIXED_DATE } as const;

function tmpContextDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mgmt-registry-"));
  // CONTEXT_VAULT_REDESIGN: management.md now lives under policies/.
  mkdirSync(join(dir, "policies"), { recursive: true });
  return dir;
}

function inMemoryDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function insertSchedule(db: Database.Database, cron = "0 10 * * *"): number {
  const r = db
    .prepare(
      `INSERT INTO recurring_schedules (task_type, task_description, recurrence_rule, enabled)
         VALUES (?, ?, json(?), 1)`,
    )
    .run("scheduled.task", "managed task", JSON.stringify({ cron }));
  return Number(r.lastInsertRowid);
}

function insertManagedTask(
  db: Database.Database,
  partial: Partial<ManagedTask> & Pick<ManagedTask, "id">,
): void {
  const sid = partial.schedule_id ?? insertSchedule(db);
  db.prepare(
    `INSERT INTO managed_tasks
       (id, intent, app, app_normalized, cadence, output_path,
        schedule_id, last_run_at, last_result, consecutive_failures)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    partial.id,
    partial.intent ?? "Sample intent",
    partial.app ?? "zoom",
    partial.app_normalized ?? "zoom",
    partial.cadence ?? "daily 10:00 (Asia/Tokyo)",
    partial.output_path ?? "work/meetings/",
    sid,
    partial.last_run_at ?? null,
    partial.last_result ?? null,
    partial.consecutive_failures ?? 0,
  );
}

const SAMPLE_BINDINGS: SotBindings = [
  {
    category: "tasks",
    sotApp: "notion",
    mirrorPath: "context/work/tasks-index.md",
    policy: null,
    writer: "agent",
  },
  {
    category: "meetings",
    sotApp: "google_calendar",
    mirrorPath: null,
    policy: "Calendar holds slot only",
    writer: "shared",
  },
];

describe("renderManagementMd", () => {
  it("renders the v3 frontmatter with the correct schema_version", () => {
    const out = renderManagementMd(
      { sotBindings: [], managedTasks: [] },
      FIXED_RENDER,
    );
    expect(out).toMatch(/schema_version: 3/);
    expect(out).toMatch(/template_version: 2/);
    expect(out).toContain("## A. Source-of-Truth bindings");
    expect(out).toContain("## B. Managed tasks (active only)");
    expect(out).toContain("## C. Active Policies");
  });

  it("is byte-deterministic for identical inputs", () => {
    const a = renderManagementMd(
      { sotBindings: SAMPLE_BINDINGS, managedTasks: [] },
      FIXED_RENDER,
    );
    const b = renderManagementMd(
      { sotBindings: SAMPLE_BINDINGS, managedTasks: [] },
      FIXED_RENDER,
    );
    expect(a).toBe(b);
  });

  it("renders sample SoT bindings into Section A", () => {
    const out = renderManagementMd(
      { sotBindings: SAMPLE_BINDINGS, managedTasks: [] },
      FIXED_RENDER,
    );
    expect(out).toContain("| tasks | notion | context/work/tasks-index.md | — | agent |");
    expect(out).toContain("| meetings | google_calendar | — | Calendar holds slot only | shared |");
  });

  it("escapes pipe characters in cells", () => {
    const out = renderManagementMd(
      {
        sotBindings: [
          {
            category: "weird|cat",
            sotApp: "weird|app",
            mirrorPath: null,
            policy: null,
            writer: "agent",
          },
        ],
        managedTasks: [],
      },
      FIXED_RENDER,
    );
    expect(out).toContain("weird\\|cat");
    expect(out).toContain("weird\\|app");
  });

  it("renders managed task rows with rs:<id> + em-dash for nulls", () => {
    const out = renderManagementMd(
      {
        sotBindings: [],
        managedTasks: [
          {
            id: "mt_42",
            intent: "Zoom recordings → meeting entity",
            app: "zoom",
            app_normalized: "zoom",
            cadence: "daily 10:00 (Asia/Tokyo)",
            output_path: "work/meetings/",
            schedule_id: 42,
            last_run_at: null,
            last_result: null,
            consecutive_failures: 0,
            created_at: "2026-05-03",
            updated_at: "2026-05-03",
          },
        ],
      },
      FIXED_RENDER,
    );
    expect(out).toContain(
      "| mt_42 | Zoom recordings → meeting entity | zoom | daily 10:00 (Asia/Tokyo) | work/meetings/ | rs:42 | — | — |",
    );
  });

  it("renders an empty state for both tables when no rows exist", () => {
    const out = renderManagementMd(
      { sotBindings: [], managedTasks: [] },
      FIXED_RENDER,
    );
    expect(out).toContain("_No SoT bindings yet");
    expect(out).toContain("_No managed tasks yet");
  });

  it("preserves a hand-edited section C verbatim", () => {
    const preserved =
      "## C. Active Policies\n\n_2 active policies — see [[rules/policies/_index.md]]_\n";
    const out = renderManagementMd(
      { sotBindings: [], managedTasks: [] },
      { ...FIXED_RENDER, preservedSectionC: preserved },
    );
    expect(out).toContain("_2 active policies — see [[rules/policies/_index.md]]_");
  });

  it("preserves user free-prose blocks under their original H2 headers", () => {
    const preserved = new Map<string, string>([
      ["## Language", "## Language\n\nJapanese for prose, English for tables.\n"],
    ]);
    const out = renderManagementMd(
      { sotBindings: [], managedTasks: [] },
      { ...FIXED_RENDER, preservedFreeProse: preserved },
    );
    expect(out).toContain("Japanese for prose, English for tables.");
    // Notes block still appended when not present in the preserved map.
    expect(out).toContain("## Notes");
  });

  it("does not duplicate the Notes block when the user already provided it", () => {
    const preserved = new Map<string, string>([
      ["## Notes", "## Notes\n\nUser-curated notes only.\n"],
    ]);
    const out = renderManagementMd(
      { sotBindings: [], managedTasks: [] },
      { ...FIXED_RENDER, preservedFreeProse: preserved },
    );
    const occurrences = out.match(/^## Notes/gm)?.length ?? 0;
    expect(occurrences).toBe(1);
    expect(out).toContain("User-curated notes only.");
  });
});

describe("parseManagementMd", () => {
  it("recognizes schema_version 3 frontmatter", () => {
    const body = renderManagementMd(
      { sotBindings: SAMPLE_BINDINGS, managedTasks: [] },
      FIXED_RENDER,
    );
    const parsed = parseManagementMd(body);
    expect(parsed.ok).toBe(true);
    expect(parsed.schemaVersion).toBe(3);
    expect(parsed.sotBindings).toHaveLength(2);
    expect(parsed.failures).toEqual([]);
  });

  it("treats missing schema_version as null (v2 detection)", () => {
    const body = `---\ntype: rule\ntemplate_version: 2\n---\n# x\n`;
    const parsed = parseManagementMd(body);
    expect(parsed.schemaVersion).toBeNull();
  });

  it("fails fatally when frontmatter is absent", () => {
    const parsed = parseManagementMd("# Body without frontmatter\n");
    expect(parsed.ok).toBe(false);
    expect(parsed.errors[0]).toContain("frontmatter missing");
  });

  it("rejects schema_version that is not an integer", () => {
    const body = `---\nschema_version: not-a-number\n---\n# x\n`;
    expect(parseManagementMd(body).schemaVersion).toBeNull();
  });

  it("round-trips a rendered file (Section A + B)", () => {
    const input = {
      sotBindings: SAMPLE_BINDINGS,
      managedTasks: [
        {
          id: "mt_1",
          intent: "Watch Zoom",
          app: "zoom",
          app_normalized: "zoom",
          cadence: "daily 10:00 (Asia/Tokyo)",
          output_path: "work/meetings/",
          schedule_id: 5,
          last_run_at: "2026-05-02T10:00:00Z",
          last_result: "ok (3 new)",
          consecutive_failures: 0,
          created_at: "2026-05-02",
          updated_at: "2026-05-02",
        } satisfies ManagedTask,
      ],
    };
    const body = renderManagementMd(input, FIXED_RENDER);
    const parsed = parseManagementMd(body);
    expect(parsed.sotBindings).toEqual(SAMPLE_BINDINGS);
    expect(parsed.managedTasks).toHaveLength(1);
    expect(parsed.managedTasks[0]).toMatchObject({
      id: "mt_1",
      app: "zoom",
      cadence: "daily 10:00 (Asia/Tokyo)",
      outputPath: "work/meetings/",
      scheduleId: 5,
      lastRunAt: "2026-05-02T10:00:00Z",
      lastResult: "ok (3 new)",
    });
  });

  it("drops a section B row whose id does not match /^mt_[1-9]\\d*$/", () => {
    const body = [
      "---",
      "schema_version: 3",
      "---",
      "## A. Source-of-Truth bindings",
      "",
      "| Category | SoT app | Mirror MD path | Policy | Writer |",
      "|---|---|---|---|---|",
      "",
      "## B. Managed tasks (active only)",
      "",
      "| ID | Intent | App | Cadence | Output path | Schedule | Last run | Last result |",
      "|---|---|---|---|---|---|---|---|",
      "| mt_0 | bad id | zoom | daily | work/meetings/ | rs:1 | — | — |",
      "| mt_2 | good id | zoom | daily | work/meetings/ | rs:2 | — | — |",
      "",
    ].join("\n");
    const parsed = parseManagementMd(body);
    expect(parsed.managedTasks.map((r) => r.id)).toEqual(["mt_2"]);
    expect(parsed.failures).toHaveLength(1);
    expect(parsed.failures[0].section).toBe("B");
    expect(parsed.failures[0].reason).toContain("mt_0");
  });

  it("drops a section B row with an empty App column", () => {
    const body = [
      "---",
      "schema_version: 3",
      "---",
      "## B. Managed tasks (active only)",
      "",
      "| ID | Intent | App | Cadence | Output path | Schedule | Last run | Last result |",
      "|---|---|---|---|---|---|---|---|",
      "| mt_1 | intent |  | daily | work/meetings/ | rs:1 | — | — |",
      "",
    ].join("\n");
    const parsed = parseManagementMd(body);
    expect(parsed.managedTasks).toHaveLength(0);
    expect(parsed.failures[0].reason).toContain("empty App column");
  });

  it("drops a section B row with an unknown output_path domain", () => {
    const body = [
      "---",
      "schema_version: 3",
      "---",
      "## B. Managed tasks (active only)",
      "",
      "| ID | Intent | App | Cadence | Output path | Schedule | Last run | Last result |",
      "|---|---|---|---|---|---|---|---|",
      "| mt_1 | intent | zoom | daily | foo/meetings/ | rs:1 | — | — |",
      "",
    ].join("\n");
    const parsed = parseManagementMd(body);
    expect(parsed.managedTasks).toHaveLength(0);
    expect(parsed.failures[0].reason).toContain("invalid output_path");
  });

  it("drops a section B row with an unknown type-plural", () => {
    const body = [
      "---",
      "schema_version: 3",
      "---",
      "## B. Managed tasks (active only)",
      "",
      "| ID | Intent | App | Cadence | Output path | Schedule | Last run | Last result |",
      "|---|---|---|---|---|---|---|---|",
      "| mt_1 | intent | zoom | daily | work/widgets/ | rs:1 | — | — |",
      "",
    ].join("\n");
    const parsed = parseManagementMd(body);
    expect(parsed.managedTasks).toHaveLength(0);
  });

  it("drops a section B row with malformed Schedule cell", () => {
    const body = [
      "---",
      "schema_version: 3",
      "---",
      "## B. Managed tasks (active only)",
      "",
      "| ID | Intent | App | Cadence | Output path | Schedule | Last run | Last result |",
      "|---|---|---|---|---|---|---|---|",
      "| mt_1 | intent | zoom | daily | work/meetings/ | foobar | — | — |",
      "",
    ].join("\n");
    const parsed = parseManagementMd(body);
    expect(parsed.managedTasks).toHaveLength(0);
    expect(parsed.failures[0].reason).toContain("Schedule cell");
  });

  it("flags a section B table missing its divider", () => {
    const body = [
      "---",
      "schema_version: 3",
      "---",
      "## B. Managed tasks (active only)",
      "",
      "| ID | Intent | App | Cadence | Output path | Schedule | Last run | Last result |",
      "| mt_1 | x | zoom | daily | work/meetings/ | rs:1 | — | — |",
      "",
    ].join("\n");
    const parsed = parseManagementMd(body);
    expect(parsed.managedTasks).toEqual([]);
    expect(
      parsed.failures.some(
        (f) => f.section === "B" && f.reason.includes("divider"),
      ),
    ).toBe(true);
  });

  it("flags a section A table missing its divider", () => {
    const body = [
      "---",
      "schema_version: 3",
      "---",
      "## A. Source-of-Truth bindings",
      "",
      "| Category | SoT app | Mirror MD path | Policy | Writer |",
      "| tasks | notion | — | — | agent |",
      "",
    ].join("\n");
    const parsed = parseManagementMd(body);
    expect(parsed.sotBindings).toEqual([]);
    expect(parsed.failures.some((f) => f.reason.includes("divider"))).toBe(true);
  });

  it("flags a section B row whose cell count is short", () => {
    const body = [
      "---",
      "schema_version: 3",
      "---",
      "## B. Managed tasks (active only)",
      "",
      "| ID | Intent | App | Cadence | Output path | Schedule | Last run | Last result |",
      "|---|---|---|---|---|---|---|---|",
      "| mt_1 | shortrow |",
      "",
    ].join("\n");
    const parsed = parseManagementMd(body);
    expect(parsed.failures[0].reason).toContain("expected 8");
  });

  it("warns and best-effort accepts a section B row with extra columns", () => {
    const body = [
      "---",
      "schema_version: 3",
      "---",
      "## B. Managed tasks (active only)",
      "",
      "| ID | Intent | App | Cadence | Output path | Schedule | Last run | Last result |",
      "|---|---|---|---|---|---|---|---|",
      "| mt_1 | x | zoom | daily | work/meetings/ | rs:1 | — | — | extra |",
      "",
    ].join("\n");
    const parsed = parseManagementMd(body);
    expect(parsed.managedTasks).toHaveLength(1);
    expect(parsed.managedTasks[0].id).toBe("mt_1");
    expect(
      parsed.failures.some(
        (f) =>
          f.section === "B" && f.reason.includes("extra columns dropped"),
      ),
    ).toBe(true);
  });

  it("warns and best-effort accepts a section A row with extra columns", () => {
    const body = [
      "---",
      "schema_version: 3",
      "---",
      "## A. Source-of-Truth bindings",
      "",
      "| Category | SoT app | Mirror MD path | Policy | Writer |",
      "|---|---|---|---|---|",
      "| tasks | notion | — | — | agent | extra |",
      "",
    ].join("\n");
    const parsed = parseManagementMd(body);
    expect(parsed.sotBindings).toHaveLength(1);
    expect(parsed.sotBindings[0].category).toBe("tasks");
    expect(
      parsed.failures.some(
        (f) =>
          f.section === "A" && f.reason.includes("extra columns dropped"),
      ),
    ).toBe(true);
  });

  it("flags a section A row whose cell count is short", () => {
    const body = [
      "---",
      "schema_version: 3",
      "---",
      "## A. Source-of-Truth bindings",
      "",
      "| Category | SoT app | Mirror MD path | Policy | Writer |",
      "|---|---|---|---|---|",
      "| short | row |",
      "",
    ].join("\n");
    const parsed = parseManagementMd(body);
    expect(parsed.failures[0].section).toBe("A");
    expect(parsed.failures[0].reason).toContain("expected 5");
  });

  it("flags a section A row whose Zod validation fails", () => {
    const body = [
      "---",
      "schema_version: 3",
      "---",
      "## A. Source-of-Truth bindings",
      "",
      "| Category | SoT app | Mirror MD path | Policy | Writer |",
      "|---|---|---|---|---|",
      "| tasks | notion | — | — | robot |",
      "",
    ].join("\n");
    const parsed = parseManagementMd(body);
    expect(parsed.sotBindings).toHaveLength(0);
    expect(parsed.failures[0].reason).toMatch(/writer/);
  });

  it("preserves Section C verbatim through parse → render", () => {
    const body = [
      "---",
      "schema_version: 3",
      "---",
      "## A. Source-of-Truth bindings",
      "",
      "## B. Managed tasks (active only)",
      "",
      "## C. Active Policies",
      "",
      "_3 active policies. See [[rules/policies/_index.md]]_",
      "",
    ].join("\n");
    const parsed = parseManagementMd(body);
    expect(parsed.preservedSectionC).toContain("_3 active policies");
    const rendered = renderManagementMd(
      { sotBindings: [], managedTasks: [] },
      { ...FIXED_RENDER, preservedSectionC: parsed.preservedSectionC ?? undefined },
    );
    expect(rendered).toContain("_3 active policies");
  });

  it("preserves free prose between sections", () => {
    const body = [
      "---",
      "schema_version: 3",
      "---",
      "## A. Source-of-Truth bindings",
      "",
      "## Language",
      "",
      "User prose in Japanese.",
      "",
      "## B. Managed tasks (active only)",
      "",
    ].join("\n");
    const parsed = parseManagementMd(body);
    expect(parsed.preservedFreeProse.has("## Language")).toBe(true);
    expect(parsed.preservedFreeProse.get("## Language")).toContain(
      "User prose in Japanese.",
    );
  });
});

describe("renderAndWriteManagementMd", () => {
  let dir: string;
  let db: Database.Database;
  beforeEach(() => {
    dir = tmpContextDir();
    db = inMemoryDb();
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("requires a held lockId — fire-and-forget calls throw", async () => {
    const lockManager = new InMemoryManagementMdWriteLockManager();
    await expect(
      renderAndWriteManagementMd(
        dir,
        db,
        { sotBindings: [], managedTasks: [] },
        {
          lockManager,
          lockId: "not-held",
          trigger: "test.bypass",
        },
      ),
    ).rejects.toThrow("not the current holder");
  });

  it("writes the file and inserts a snapshot row", async () => {
    const lockManager = new InMemoryManagementMdWriteLockManager();
    const result = await withManagementMdWriteLock(lockManager, async () => {
      const lockId = lockManager.getHolder()!;
      return renderAndWriteManagementMd(
        dir,
        db,
        { sotBindings: SAMPLE_BINDINGS, managedTasks: [] },
        {
          lockManager,
          lockId,
          trigger: "test.write",
          render: FIXED_RENDER,
        },
      );
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    const onDisk = readFileSync(getManagementMdPath(dir), "utf-8");
    expect(onDisk).toContain("schema_version: 3");
    expect(onDisk).toContain("notion");

    const snapshot = db
      .prepare(
        "SELECT file_path, content, trigger FROM md_file_snapshots WHERE id = ?",
      )
      .get(result.value.snapshotId!) as {
      file_path: string;
      content: string;
      trigger: string;
    };
    expect(snapshot.file_path).toBe("policies/management.md");
    expect(snapshot.trigger).toBe("test.write");
    expect(snapshot.content).toBe(onDisk);
  });

  it("write succeeds even when the snapshot insert fails", async () => {
    // Drop the snapshot table so the INSERT throws — the file write
    // must still land and the function must return snapshotId=null.
    db.exec("DROP TABLE md_file_snapshots");
    const lockManager = new InMemoryManagementMdWriteLockManager();
    const result = await withManagementMdWriteLock(lockManager, async () => {
      const lockId = lockManager.getHolder()!;
      return renderAndWriteManagementMd(
        dir,
        db,
        { sotBindings: [], managedTasks: [] },
        {
          lockManager,
          lockId,
          trigger: "test.snapshot-fail",
          render: FIXED_RENDER,
        },
      );
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.snapshotId).toBeNull();
    const onDisk = readFileSync(getManagementMdPath(dir), "utf-8");
    expect(onDisk).toContain("schema_version: 3");
  });
});

describe("readAndParseManagementMd", () => {
  it("returns null when the file does not exist", async () => {
    const dir = tmpContextDir();
    try {
      expect(await readAndParseManagementMd(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a parsed structure for an existing file", async () => {
    const dir = tmpContextDir();
    try {
      writeFileSync(
        getManagementMdPath(dir),
        renderManagementMd(
          { sotBindings: SAMPLE_BINDINGS, managedTasks: [] },
          FIXED_RENDER,
        ),
        "utf-8",
      );
      const parsed = await readAndParseManagementMd(dir);
      expect(parsed?.schemaVersion).toBe(3);
      expect(parsed?.sotBindings).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("propagates non-ENOENT errors", async () => {
    // Make the management.md path a directory so readFile rejects with
    // EISDIR rather than ENOENT — exercises the non-null rethrow branch.
    const dir = tmpContextDir();
    try {
      mkdirSync(getManagementMdPath(dir), { recursive: true });
      await expect(readAndParseManagementMd(dir)).rejects.toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("bootstrapManagementRegistry", () => {
  let dir: string;
  let db: Database.Database;
  beforeEach(() => {
    dir = tmpContextDir();
    db = inMemoryDb();
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the file from DB defaults when missing", async () => {
    const result = await bootstrapManagementRegistry(dir, db);
    expect(result.rewritten).toBe(true);
    const body = readFileSync(getManagementMdPath(dir), "utf-8");
    expect(body).toContain("schema_version: 3");
    expect(body).toContain("_No SoT bindings yet");
  });

  it("renders existing DB rows on first boot", async () => {
    writeSotBindings(db, SAMPLE_BINDINGS);
    insertManagedTask(db, { id: "mt_1" });
    const result = await bootstrapManagementRegistry(dir, db);
    expect(result.rendered.sotBindings).toHaveLength(2);
    expect(result.rendered.managedTasks).toHaveLength(1);
    const body = readFileSync(getManagementMdPath(dir), "utf-8");
    expect(body).toContain("notion");
    expect(body).toContain("mt_1");
  });

  it("overwrites a file lacking schema_version with a fresh render", async () => {
    const path = getManagementMdPath(dir);
    writeFileSync(
      path,
      [
        "---",
        "type: rule",
        "template_version: 2",
        "---",
        "# Management rules",
        "",
        "## Source of Truth",
        "",
        "| Category | Canonical store | Writer |",
        "|---|---|---|",
        "| Tasks | Notion | shared |",
        "",
      ].join("\n"),
      "utf-8",
    );
    const result = await bootstrapManagementRegistry(dir, db);
    expect(result.rewritten).toBe(true);
    const rendered = readFileSync(path, "utf-8");
    expect(rendered).toContain("schema_version: 3");
    expect(rendered).toContain("## A. Source-of-Truth bindings");
  });

  it("reconciles a hand-edited Section A back into settings.sot_bindings", async () => {
    writeSotBindings(db, []);
    const handEdit = renderManagementMd(
      { sotBindings: SAMPLE_BINDINGS, managedTasks: [] },
      FIXED_RENDER,
    );
    writeFileSync(getManagementMdPath(dir), handEdit, "utf-8");
    await bootstrapManagementRegistry(dir, db);
    const stored = db
      .prepare("SELECT value_json FROM settings WHERE key = 'sot_bindings'")
      .get() as { value_json: string };
    expect(JSON.parse(stored.value_json)).toHaveLength(2);
  });

  it("re-renders forward-incompat (schema_version 99) files as v3 with a warning", async () => {
    writeFileSync(
      getManagementMdPath(dir),
      [
        "---",
        "schema_version: 99",
        "---",
        "# Future format",
        "",
      ].join("\n"),
      "utf-8",
    );
    const result = await bootstrapManagementRegistry(dir, db);
    expect(result.rewritten).toBe(true);
    const body = readFileSync(getManagementMdPath(dir), "utf-8");
    expect(body).toContain("schema_version: 3");
  });

  it("records management_parse_failures rows when the file has row drops", async () => {
    writeFileSync(
      getManagementMdPath(dir),
      [
        "---",
        "schema_version: 3",
        "---",
        "## A. Source-of-Truth bindings",
        "",
        "| Category | SoT app | Mirror MD path | Policy | Writer |",
        "|---|---|---|---|---|",
        "| tasks | notion | — | — | robot |",
        "",
        "## B. Managed tasks (active only)",
        "",
        "| ID | Intent | App | Cadence | Output path | Schedule | Last run | Last result |",
        "|---|---|---|---|---|---|---|---|",
        "",
      ].join("\n"),
      "utf-8",
    );
    await bootstrapManagementRegistry(dir, db);
    const failures = listManagementParseFailures(db);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].section).toBe("A");
  });

  it("clears stale parse failures on a clean parse", async () => {
    db.prepare(
      "INSERT INTO management_parse_failures (reason) VALUES (?)",
    ).run("old failure");
    // Bootstrap now writes a fresh, clean file.
    await bootstrapManagementRegistry(dir, db);
    expect(listManagementParseFailures(db)).toHaveLength(0);
  });

  it("returns gracefully when the lock is contended at boot", async () => {
    const lockManager = new InMemoryManagementMdWriteLockManager();
    const heldByOther = lockManager.acquire();
    expect(heldByOther.ok).toBe(true);
    try {
      const result = await bootstrapManagementRegistry(dir, db, lockManager);
      expect(result.rewritten).toBe(false);
      // No file written because the lock was contended.
      expect(() => readFileSync(getManagementMdPath(dir), "utf-8")).toThrow();
    } finally {
      if (heldByOther.ok) lockManager.release(heldByOther.lockId);
    }
  });
});

describe("verifyManagementMdLoadable", () => {
  it("returns missing when the file is absent", () => {
    const dir = tmpContextDir();
    try {
      expect(verifyManagementMdLoadable(dir, 32 * 1024)).toEqual({
        ok: false,
        reason: "missing",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns ok with the byte count for a present small file", () => {
    const dir = tmpContextDir();
    try {
      writeFileSync(getManagementMdPath(dir), "small content", "utf-8");
      const result = verifyManagementMdLoadable(dir, 32 * 1024);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.bytes).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flags files above the per-file cap", () => {
    const dir = tmpContextDir();
    try {
      writeFileSync(
        getManagementMdPath(dir),
        "x".repeat(64 * 1024),
        "utf-8",
      );
      const result = verifyManagementMdLoadable(dir, 32 * 1024);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("exceeds");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("reconcileManagementMdFromFile (watcher reconcile body)", () => {
  let dir: string;
  let db: Database.Database;
  beforeEach(() => {
    dir = tmpContextDir();
    db = inMemoryDb();
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns noop when the file does not exist (mid-handler vanish)", async () => {
    const lockManager = new InMemoryManagementMdWriteLockManager();
    const result = await reconcileManagementMdFromFile(dir, db, lockManager);
    expect(result.kind).toBe("noop");
  });

  it("applies a clean Section A hand-edit and re-renders", async () => {
    const lockManager = new InMemoryManagementMdWriteLockManager();
    writeFileSync(
      getManagementMdPath(dir),
      renderManagementMd(
        { sotBindings: SAMPLE_BINDINGS, managedTasks: [] },
        FIXED_RENDER,
      ),
      "utf-8",
    );
    const result = await reconcileManagementMdFromFile(dir, db, lockManager);
    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") throw new Error("unreachable");
    expect(result.failures).toBe(0);
    const stored = db
      .prepare("SELECT value_json FROM settings WHERE key = 'sot_bindings'")
      .get() as { value_json: string };
    expect(JSON.parse(stored.value_json)).toHaveLength(2);
  });

  it("reverts on fatal parse error (no frontmatter)", async () => {
    writeFileSync(
      getManagementMdPath(dir),
      "# Body without frontmatter\n",
      "utf-8",
    );
    const lockManager = new InMemoryManagementMdWriteLockManager();
    const result = await reconcileManagementMdFromFile(dir, db, lockManager);
    expect(result.kind).toBe("revert-fatal-parse");
    const after = readFileSync(getManagementMdPath(dir), "utf-8");
    expect(after).toContain("schema_version: 3");
    expect(listManagementParseFailures(db).length).toBeGreaterThan(0);
  });

  it("records both file-level errors and section row failures on a doubly-broken edit", async () => {
    // Missing frontmatter + a malformed Section B row → exercises the
    // failures-loop arm of the revert path (errors[] AND failures[]).
    writeFileSync(
      getManagementMdPath(dir),
      [
        "# No frontmatter",
        "",
        "## B. Managed tasks (active only)",
        "",
        "| ID | Intent | App | Cadence | Output path | Schedule | Last run | Last result |",
        "|---|---|---|---|---|---|---|---|",
        "| mt_0 | bad | zoom | daily | work/meetings/ | rs:1 | — | — |",
        "",
      ].join("\n"),
      "utf-8",
    );
    const lockManager = new InMemoryManagementMdWriteLockManager();
    const result = await reconcileManagementMdFromFile(dir, db, lockManager);
    expect(result.kind).toBe("revert-fatal-parse");
    const reasons = listManagementParseFailures(db).map((r) => r.reason);
    expect(reasons.some((r) => r.includes("frontmatter missing"))).toBe(true);
    expect(reasons.some((r) => r.includes("mt_0"))).toBe(true);
  });

  it("reverts a v2-shaped hand-edit (no schema_version)", async () => {
    writeFileSync(
      getManagementMdPath(dir),
      [
        "---",
        "type: rule",
        "template_version: 2",
        "---",
        "# Old format",
        "",
      ].join("\n"),
      "utf-8",
    );
    const lockManager = new InMemoryManagementMdWriteLockManager();
    const result = await reconcileManagementMdFromFile(dir, db, lockManager);
    expect(result.kind).toBe("revert-v2");
    const after = readFileSync(getManagementMdPath(dir), "utf-8");
    expect(after).toContain("schema_version: 3");
  });

  it("returns noop on a self-write (suppression path)", async () => {
    const lockManager = new InMemoryManagementMdWriteLockManager();
    // Write through the registry's write helper so the path is stamped.
    await withManagementMdWriteLock(lockManager, async () => {
      const lockId = lockManager.getHolder()!;
      await renderAndWriteManagementMd(
        dir,
        db,
        { sotBindings: [], managedTasks: [] },
        {
          lockManager,
          lockId,
          trigger: "test.self-write",
          render: FIXED_RENDER,
        },
      );
    });
    // Now the path is in pendingSelfWrites; a reconcile pass should
    // short-circuit with noop and the file stays as the daemon wrote
    // it.
    const before = readFileSync(getManagementMdPath(dir), "utf-8");
    const result = await reconcileManagementMdFromFile(dir, db, lockManager);
    expect(result.kind).toBe("noop");
    const after = readFileSync(getManagementMdPath(dir), "utf-8");
    expect(after).toBe(before);
  });

  it("returns lock-contended when another caller holds the lock", async () => {
    const lockManager = new InMemoryManagementMdWriteLockManager();
    writeFileSync(
      getManagementMdPath(dir),
      renderManagementMd(
        { sotBindings: SAMPLE_BINDINGS, managedTasks: [] },
        FIXED_RENDER,
      ),
      "utf-8",
    );
    const held = lockManager.acquire();
    expect(held.ok).toBe(true);
    try {
      const result = await reconcileManagementMdFromFile(dir, db, lockManager);
      expect(result.kind).toBe("lock-contended");
    } finally {
      if (held.ok) lockManager.release(held.lockId);
    }
  });

  it("records failures (does not clear) when a hand-edit has row drops", async () => {
    writeFileSync(
      getManagementMdPath(dir),
      [
        "---",
        "schema_version: 3",
        "---",
        "## A. Source-of-Truth bindings",
        "",
        "| Category | SoT app | Mirror MD path | Policy | Writer |",
        "|---|---|---|---|---|",
        "| tasks | notion | — | — | robot |",
        "",
        "## B. Managed tasks (active only)",
        "",
        "| ID | Intent | App | Cadence | Output path | Schedule | Last run | Last result |",
        "|---|---|---|---|---|---|---|---|",
        "",
      ].join("\n"),
      "utf-8",
    );
    const lockManager = new InMemoryManagementMdWriteLockManager();
    const result = await reconcileManagementMdFromFile(dir, db, lockManager);
    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") throw new Error("unreachable");
    expect(result.failures).toBeGreaterThan(0);
    expect(listManagementParseFailures(db).length).toBeGreaterThan(0);
  });

  it("clears stale parse failures on a fully clean reconcile", async () => {
    db.prepare(
      "INSERT INTO management_parse_failures (reason) VALUES (?)",
    ).run("stale");
    writeFileSync(
      getManagementMdPath(dir),
      renderManagementMd(
        { sotBindings: SAMPLE_BINDINGS, managedTasks: [] },
        FIXED_RENDER,
      ),
      "utf-8",
    );
    const lockManager = new InMemoryManagementMdWriteLockManager();
    await reconcileManagementMdFromFile(dir, db, lockManager);
    expect(listManagementParseFailures(db)).toHaveLength(0);
  });

  it("treats semantically-identical Section A as a no-op DB write", async () => {
    writeSotBindings(db, SAMPLE_BINDINGS);
    const before = db
      .prepare("SELECT updated_at FROM settings WHERE key = 'sot_bindings'")
      .get() as { updated_at: string };
    await new Promise((r) => setTimeout(r, 1100)); // enough for SQL CURRENT_TIMESTAMP to tick
    writeFileSync(
      getManagementMdPath(dir),
      renderManagementMd(
        { sotBindings: SAMPLE_BINDINGS, managedTasks: [] },
        FIXED_RENDER,
      ),
      "utf-8",
    );
    const lockManager = new InMemoryManagementMdWriteLockManager();
    await reconcileManagementMdFromFile(dir, db, lockManager);
    const after = db
      .prepare("SELECT updated_at FROM settings WHERE key = 'sot_bindings'")
      .get() as { updated_at: string };
    expect(after.updated_at).toBe(before.updated_at);
  });

  it("treats both-empty SotBindings as a no-op DB write (early-return branch)", async () => {
    writeFileSync(
      getManagementMdPath(dir),
      renderManagementMd(
        { sotBindings: [], managedTasks: [] },
        FIXED_RENDER,
      ),
      "utf-8",
    );
    const lockManager = new InMemoryManagementMdWriteLockManager();
    const result = await reconcileManagementMdFromFile(dir, db, lockManager);
    expect(result.kind).toBe("applied");
    const stored = db
      .prepare("SELECT value_json FROM settings WHERE key = 'sot_bindings'")
      .get() as { value_json: string } | undefined;
    expect(stored).toBeUndefined();
  });
});

describe("constants", () => {
  it("MANAGEMENT_MD_SCHEMA_VERSION matches the design (v3)", () => {
    expect(MANAGEMENT_MD_SCHEMA_VERSION).toBe(3);
  });
});
