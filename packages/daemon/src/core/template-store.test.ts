import { afterEach, describe, expect, it, vi } from "vitest";
import * as nodePath from "node:path";

// Wrap `relative` with a vi.fn so individual tests can inject a mocked return
// value via mockReturnValueOnce to exercise the defense-in-depth second check
// in resolveContextFilePath (lines 625-629) — a path that passes the split-
// based first check but where resolve/relative "disagrees" is unreachable on a
// standard FS without this interception.
vi.mock("node:path", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:path")>();
  return { ...original, relative: vi.fn(original.relative) };
});
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.js";
import {
  PROJECT_TEMPLATE_NAME,
  RETEMPLATE_STATUS_KEY,
  applyPerFileUpdate,
  backupTimestampSegment,
  buildBackupRoot,
  finalizeRetemplate,
  isTerminalFileStatus,
  persistPerFileStatus,
  prepareRetemplateRun,
  readRetemplateStatus,
  readTemplateBody,
  resolveContextFilePath,
  safeFileSize,
  selectRetemplateTargets,
  summarizeFinalStatus,
  templateFilePath,
  templateFileName,
  templatesDir,
  writeRetemplateStatus,
  writeTemplateBody,
  type RetemplateFileEntry,
  type RetemplateStatusRecord,
} from "./template-store.js";
import type { NormalizedGitWatchedRepo } from "./git-project-docs.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix = "pa-template-store-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function seedDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function makeRepo(
  overrides: Partial<NormalizedGitWatchedRepo> = {},
): NormalizedGitWatchedRepo {
  return {
    path: overrides.path ?? "/tmp/repo-aitne",
    slug: overrides.slug ?? "aitne",
    classification: overrides.classification ?? "project",
    category: overrides.category ?? "personal",
    org: overrides.org,
    accountAlias: overrides.accountAlias,
    pollPriority: overrides.pollPriority ?? "normal",
  };
}

function seedTemplates(dataDir: string): void {
  mkdirSync(templatesDir(dataDir), { recursive: true });
  writeFileSync(
    join(templatesDir(dataDir), PROJECT_TEMPLATE_NAME),
    "# project template body",
    "utf-8",
  );
  writeFileSync(
    join(templatesDir(dataDir), templateFileName("git-repo")),
    "# git-repo template body",
    "utf-8",
  );
}

function seedContextFile(
  contextDir: string,
  rel: string,
  body: string,
): string {
  const abs = join(contextDir, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body, "utf-8");
  return abs;
}

function workspaceFixturesDir(): string {
  // Empty workspace — bundled lookup falls back to in-module defaults.
  return tempDir("pa-template-store-ws-");
}

/* ════════════════════════════════════════════════════════════════════ */
/* Pure helpers                                                          */
/* ════════════════════════════════════════════════════════════════════ */

describe("template-store pure helpers", () => {
  it("templateFileName + templateFilePath route by kind", () => {
    expect(templateFileName("project")).toBe("project.md");
    expect(templateFileName("git-repo")).toBe("git-repo.md");
    const dir = "/tmp/data";
    expect(templateFilePath(dir, "project")).toContain("/templates/project.md");
    expect(templateFilePath(dir, "git-repo")).toContain(
      "/templates/git-repo.md",
    );
  });

  it("backupTimestampSegment escapes ISO punctuation for FS safety", () => {
    const seg = backupTimestampSegment(new Date("2026-04-30T12:34:56.789Z"));
    expect(seg).toBe("2026-04-30T12-34-56-789Z");
    expect(seg.includes(":")).toBe(false);
    expect(seg.includes(".")).toBe(false);
  });

  it("buildBackupRoot composes dataDir/backups/templates/<segment>", () => {
    const root = buildBackupRoot("/tmp/d", new Date("2026-04-30T01:02:03.000Z"));
    expect(root).toContain("/backups/templates/2026-04-30T01-02-03-000Z");
  });

  it("isTerminalFileStatus matches every settled state", () => {
    expect(isTerminalFileStatus("completed")).toBe(true);
    expect(isTerminalFileStatus("skipped")).toBe(true);
    expect(isTerminalFileStatus("failed")).toBe(true);
    expect(isTerminalFileStatus("rolled_back")).toBe(true);
    expect(isTerminalFileStatus("pending")).toBe(false);
    expect(isTerminalFileStatus("started")).toBe(false);
  });

  it("summarizeFinalStatus returns success / partial / failed by mix", () => {
    const f = (status: RetemplateFileEntry["status"]): RetemplateFileEntry => ({
      slug: status,
      contextPath: `projects/${status}`,
      contextFile: `projects/${status}.md`,
      backupRelPath: `projects/${status}.md`,
      classification: "project",
      category: "other",
      org: "",
      accountAlias: "",
      repoPath: "/tmp",
      status,
    });
    expect(summarizeFinalStatus({})).toBe("success");
    expect(summarizeFinalStatus({ a: f("completed") })).toBe("success");
    expect(
      summarizeFinalStatus({ a: f("completed"), b: f("skipped") }),
    ).toBe("success");
    expect(summarizeFinalStatus({ a: f("failed") })).toBe("failed");
    expect(summarizeFinalStatus({ a: f("rolled_back") })).toBe("failed");
    expect(
      summarizeFinalStatus({ a: f("completed"), b: f("failed") }),
    ).toBe("partial");
    expect(
      summarizeFinalStatus({ a: f("skipped"), b: f("rolled_back") }),
    ).toBe("partial");
  });

  it("applyPerFileUpdate stamps timestamps and merges fields", () => {
    const record: RetemplateStatusRecord = {
      scheduleId: 1,
      correlationId: "c",
      kind: "project",
      backupRoot: "/tmp/b",
      startedAt: "2026-04-30T00:00:00.000Z",
      files: {
        a: {
          slug: "a",
          contextPath: "projects/a",
          contextFile: "projects/a.md",
          backupRelPath: "projects/a.md",
          classification: "project",
          category: "other",
          org: "",
          accountAlias: "",
          repoPath: "/tmp/a",
          status: "pending",
        },
      },
    };
    const fixedNow = new Date("2026-04-30T01:00:00.000Z");
    const started = applyPerFileUpdate(record, {
      slug: "a",
      status: "started",
      now: () => fixedNow,
    });
    expect(started?.files.a.status).toBe("started");
    expect(started?.files.a.startedAt).toBe(fixedNow.toISOString());

    const completed = applyPerFileUpdate(started!, {
      slug: "a",
      status: "completed",
      beforeBytes: 100,
      afterBytes: 120,
      now: () => new Date("2026-04-30T01:01:00.000Z"),
    });
    expect(completed?.files.a.status).toBe("completed");
    expect(completed?.files.a.beforeBytes).toBe(100);
    expect(completed?.files.a.afterBytes).toBe(120);
    expect(completed?.files.a.completedAt).toBe(
      "2026-04-30T01:01:00.000Z",
    );
    // Started timestamp survives because applyPerFileUpdate spreads existing.
    expect(completed?.files.a.startedAt).toBe(fixedNow.toISOString());

    expect(
      applyPerFileUpdate(record, { slug: "missing", status: "started" }),
    ).toBeNull();

    // Pin the "neither started nor terminal" branch in the timestamp
    // ternary: re-applying status="pending" must not stamp startedAt
    // or completedAt. This guards against a future addition of a new
    // non-terminal status leaking timestamps that the dashboard treats
    // as proof of activity.
    const repending = applyPerFileUpdate(record, {
      slug: "a",
      status: "pending",
      now: () => new Date("2026-04-30T02:00:00.000Z"),
    });
    expect(repending?.files.a.status).toBe("pending");
    expect(repending?.files.a.startedAt).toBeUndefined();
    expect(repending?.files.a.completedAt).toBeUndefined();

    // Cover the `options.reason !== undefined ? { reason } : {}` true branch
    // at line 311 — reason is carried through to the next entry.
    const withReason = applyPerFileUpdate(record, {
      slug: "a",
      status: "pending",
      reason: "user_skipped",
    });
    expect(withReason?.files.a.reason).toBe("user_skipped");
  });

  it("selectRetemplateTargets filters by classification and existence", () => {
    const ctx = tempDir("pa-template-targets-");
    seedContextFile(ctx, "git/a/overview.md", "a");
    // b's overview.md missing on disk — should be skipped.
    seedContextFile(ctx, "git/c/overview.md", "c");

    const repos = [
      makeRepo({ slug: "a", path: "/tmp/a", classification: "project" }),
      makeRepo({ slug: "b", path: "/tmp/b", classification: "project" }),
      makeRepo({ slug: "c", path: "/tmp/c", classification: "repo-only" }),
      makeRepo({ slug: "d", path: "/tmp/d", classification: "repo-only" }),
    ];

    const projectTargets = selectRetemplateTargets(repos, "project", ctx);
    expect(projectTargets.map((t) => t.slug)).toEqual(["a"]);
    expect(projectTargets[0].contextFile).toBe("git/a/overview.md");

    const repoTargets = selectRetemplateTargets(repos, "git-repo", ctx);
    expect(repoTargets.map((t) => t.slug)).toEqual(["c"]);
    expect(repoTargets[0].backupRelPath).toBe("git/c/overview.md");
  });

  it("selectRetemplateTargets dedupes by slug across duplicate repos", () => {
    const ctx = tempDir();
    seedContextFile(ctx, "git/dup/overview.md", "dup");
    const repos = [
      makeRepo({ slug: "dup", path: "/tmp/x", classification: "project" }),
      makeRepo({ slug: "dup", path: "/tmp/y", classification: "project" }),
    ];
    expect(selectRetemplateTargets(repos, "project", ctx)).toHaveLength(1);
  });

  it("resolveContextFilePath rejects path traversal", () => {
    const ctx = tempDir();
    expect(() =>
      resolveContextFilePath(ctx, "../escape.md"),
    ).toThrow(/path_outside_context_dir/);
    expect(() =>
      resolveContextFilePath(ctx, "..\\escape.md"),
    ).toThrow(/path_outside_context_dir/);
    const ok = resolveContextFilePath(ctx, "projects/foo.md");
    expect(ok.startsWith(ctx)).toBe(true);
  });

  it("resolveContextFilePath rejects when relative() returns a traversal string (defense-in-depth second check)", () => {
    // The first check (split-based) catches obvious `..` segments. The second
    // check (resolve→relative) is a defense-in-depth guard for obscure
    // platform-specific normalisation differences. It is unreachable on a
    // standard FS, so we inject a mock return value to exercise it.
    const ctx = tempDir();
    vi.mocked(nodePath.relative).mockReturnValueOnce("..");
    expect(() =>
      resolveContextFilePath(ctx, "projects/foo.md"),
    ).toThrow(/path_outside_context_dir/);
  });

  it("safeFileSize returns size for existing file, undefined otherwise", () => {
    const ctx = tempDir();
    const abs = seedContextFile(ctx, "projects/x.md", "hello");
    expect(safeFileSize(abs)).toBe(5);
    expect(safeFileSize(join(ctx, "missing.md"))).toBeUndefined();
  });
});

/* ════════════════════════════════════════════════════════════════════ */
/* Template body read/write                                              */
/* ════════════════════════════════════════════════════════════════════ */

describe("template body read/write", () => {
  it("writeTemplateBody writes atomically and is readable back", () => {
    const dataDir = tempDir();
    const ws = workspaceFixturesDir();
    writeTemplateBody(dataDir, "project", "# new project body");
    expect(readTemplateBody(dataDir, ws, "project")).toBe(
      "# new project body",
    );
  });

  it("writeTemplateBody enforces the 64 KiB cap", () => {
    const dataDir = tempDir();
    const oversized = "x".repeat(64 * 1024 + 1);
    expect(() => writeTemplateBody(dataDir, "project", oversized)).toThrow(
      /template_body_too_large/,
    );
  });

  it("readTemplateBody falls back to bundled when no override exists", () => {
    const dataDir = tempDir();
    const ws = workspaceFixturesDir();
    // Without seeding, falls through to FALLBACK_PROJECT_TEMPLATE.
    const body = readTemplateBody(dataDir, ws, "project");
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain("type: project");
  });
});

/* ════════════════════════════════════════════════════════════════════ */
/* Status grid persistence                                               */
/* ════════════════════════════════════════════════════════════════════ */

describe("status grid persistence", () => {
  it("read/write round-trip via runtime_state", () => {
    const db = seedDb();
    expect(readRetemplateStatus(db)).toBeNull();
    const record: RetemplateStatusRecord = {
      scheduleId: 7,
      correlationId: "c-7",
      kind: "project",
      backupRoot: "/tmp/b",
      startedAt: "2026-04-30T00:00:00.000Z",
      files: {},
    };
    writeRetemplateStatus(db, record);
    const back = readRetemplateStatus(db);
    expect(back?.scheduleId).toBe(7);
    expect(back?.correlationId).toBe("c-7");
    // Confirm it landed at the expected key.
    const row = db.prepare(
      "SELECT value_json FROM runtime_state WHERE key = ?",
    ).get(RETEMPLATE_STATUS_KEY) as { value_json: string };
    expect(JSON.parse(row.value_json).scheduleId).toBe(7);
  });

  it("persistPerFileStatus enforces correlationId match and unknown slug", () => {
    const db = seedDb();
    const record: RetemplateStatusRecord = {
      scheduleId: 1,
      correlationId: "abc",
      kind: "project",
      backupRoot: "/tmp/b",
      startedAt: "2026-04-30T00:00:00.000Z",
      files: {
        a: {
          slug: "a",
          contextPath: "projects/a",
          contextFile: "projects/a.md",
          backupRelPath: "projects/a.md",
          classification: "project",
          category: "other",
          org: "",
          accountAlias: "",
          repoPath: "/tmp/a",
          status: "pending",
        },
      },
    };
    writeRetemplateStatus(db, record);

    expect(
      persistPerFileStatus({
        db,
        slug: "a",
        status: "started",
        correlationId: "wrong",
      }),
    ).toEqual({ ok: false, reason: "correlation_mismatch" });

    expect(
      persistPerFileStatus({
        db,
        slug: "missing",
        status: "started",
      }),
    ).toEqual({ ok: false, reason: "unknown_slug" });

    const ok = persistPerFileStatus({
      db,
      slug: "a",
      status: "completed",
      beforeBytes: 10,
      afterBytes: 20,
      correlationId: "abc",
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.entry.status).toBe("completed");
      expect(ok.entry.beforeBytes).toBe(10);
    }
  });

  it("persistPerFileStatus returns no_active_run when grid is empty", () => {
    const db = seedDb();
    expect(
      persistPerFileStatus({ db, slug: "a", status: "started" }),
    ).toEqual({ ok: false, reason: "no_active_run" });
  });
});

/* ════════════════════════════════════════════════════════════════════ */
/* prepareRetemplateRun — concurrency + backup + enqueue                 */
/* ════════════════════════════════════════════════════════════════════ */

describe("prepareRetemplateRun", () => {
  it("returns missing_template when the user template is absent and not seeded", () => {
    const db = seedDb();
    const dataDir = tempDir();
    const ws = workspaceFixturesDir();
    const ctx = tempDir();
    const result = prepareRetemplateRun({
      db,
      dataDir,
      workspaceDir: ws,
      contextDir: ctx,
      kind: "project",
      repos: [makeRepo()],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing_template");
  });

  it("returns no_targets when no matching context files exist", () => {
    const db = seedDb();
    const dataDir = tempDir();
    const ws = workspaceFixturesDir();
    const ctx = tempDir();
    seedTemplates(dataDir);
    const result = prepareRetemplateRun({
      db,
      dataDir,
      workspaceDir: ws,
      contextDir: ctx,
      kind: "project",
      repos: [makeRepo()], // file not yet on disk
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_targets");
  });

  it("backs up every target, initializes status grid, and inserts agent_schedule row", () => {
    const db = seedDb();
    const dataDir = tempDir();
    const ws = workspaceFixturesDir();
    const ctx = tempDir();
    seedTemplates(dataDir);
    seedContextFile(ctx, "git/aitne/overview.md", "ORIG");

    const fixed = new Date("2026-04-30T05:06:07.890Z");
    const result = prepareRetemplateRun({
      db,
      dataDir,
      workspaceDir: ws,
      contextDir: ctx,
      kind: "project",
      repos: [makeRepo({ slug: "aitne" })],
      now: () => fixed,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Backup file exists with original content
    const backupPath = join(
      result.backupRoot,
      "git/aitne/overview.md",
    );
    expect(existsSync(backupPath)).toBe(true);
    expect(readFileSync(backupPath, "utf-8")).toBe("ORIG");

    // agent_schedule row inserted with the right shape
    const row = db.prepare(
      `SELECT id, task_type, task_context, correlation_id, status
         FROM agent_schedule WHERE id = ?`,
    ).get(result.scheduleId) as {
      id: number;
      task_type: string;
      task_context: string;
      correlation_id: string;
      status: string;
    };
    expect(row.task_type).toBe("git.project.retemplate");
    expect(row.status).toBe("pending");
    expect(row.correlation_id).toBe(result.correlationId);
    const ctxJson = JSON.parse(row.task_context);
    expect(ctxJson.processKey).toBe("git.project.retemplate");
    expect(ctxJson.kind).toBe("project");
    expect(ctxJson.targets).toHaveLength(1);
    expect(ctxJson.targets[0].slug).toBe("aitne");
    expect(ctxJson.backupRoot).toBe(result.backupRoot);

    // Status grid persisted at expected key
    const status = readRetemplateStatus(db);
    expect(status?.scheduleId).toBe(result.scheduleId);
    expect(status?.kind).toBe("project");
    expect(status?.files.aitne.status).toBe("pending");
    expect(status?.finalizedAt).toBeUndefined();
  });

  it("returns in_progress when a pending row already exists (concurrency guard)", () => {
    const db = seedDb();
    const dataDir = tempDir();
    const ws = workspaceFixturesDir();
    const ctx = tempDir();
    seedTemplates(dataDir);
    seedContextFile(ctx, "git/aitne/overview.md", "ORIG");

    const repos = [makeRepo({ slug: "aitne" })];
    const first = prepareRetemplateRun({
      db,
      dataDir,
      workspaceDir: ws,
      contextDir: ctx,
      kind: "project",
      repos,
    });
    expect(first.ok).toBe(true);

    const second = prepareRetemplateRun({
      db,
      dataDir,
      workspaceDir: ws,
      contextDir: ctx,
      kind: "project",
      repos,
    });
    expect(second.ok).toBe(false);
    if (!second.ok && second.reason === "in_progress") {
      expect(second.detail?.scheduleId).toBeDefined();
    }
  });

  it("returns in_progress with correlationId=undefined when the existing row has NULL correlation_id (line 369 branch)", () => {
    // The `existingRow.correlation_id ?? undefined` at line 369 fires when
    // `correlation_id` is NULL in the DB (e.g. a legacy or externally-created
    // schedule row).  We INSERT such a row directly to hit that branch.
    const db = seedDb();
    db.prepare(
      `INSERT INTO agent_schedule
         (scheduled_for, task_type, task_description, task_context,
          correlation_id, model, status)
       VALUES (datetime('now'), 'git.project.retemplate', 'legacy desc', '{}',
               NULL, NULL, 'pending')`,
    ).run();

    const result = prepareRetemplateRun({
      db,
      dataDir: tempDir(),
      workspaceDir: workspaceFixturesDir(),
      contextDir: tempDir(),
      kind: "project",
      repos: [makeRepo()],
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "in_progress") {
      expect(result.detail.correlationId).toBeUndefined();
    }
  });

  it("uses 'git-repo' label in the task description when kind is git-repo (line 425 branch)", () => {
    // The ternary `options.kind === "project" ? "project" : "git-repo"` at
    // line 425: the false branch fires when kind === "git-repo".
    const db = seedDb();
    const dataDir = tempDir();
    const ws = workspaceFixturesDir();
    const ctx = tempDir();
    seedTemplates(dataDir);
    // selectRetemplateTargets filters for classification === "repo-only" when
    // kind === "git-repo", so use a repo with that classification.
    const repo = makeRepo({ slug: "lib", classification: "repo-only" });
    seedContextFile(ctx, "git/lib/overview.md", "# lib\n");

    const result = prepareRetemplateRun({
      db,
      dataDir,
      workspaceDir: ws,
      contextDir: ctx,
      kind: "git-repo",
      repos: [repo],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.kind).toBe("git-repo");
      // Verify the task_description stored in the DB contains "git-repo".
      const row = db
        .prepare(
          `SELECT task_description FROM agent_schedule WHERE id = ?`,
        )
        .get(result.scheduleId) as { task_description: string };
      expect(row.task_description).toContain("git-repo");
    }
  });
});

/* ════════════════════════════════════════════════════════════════════ */
/* finalizeRetemplate — rollback semantics                               */
/* ════════════════════════════════════════════════════════════════════ */

describe("finalizeRetemplate", () => {
  function setupRunWithStartedFile(opts: {
    erroredHalfWritten: boolean;
  }): {
    db: Database.Database;
    ctx: string;
    scheduleId: number;
    targetPath: string;
    backupPath: string;
  } {
    const db = seedDb();
    const dataDir = tempDir();
    const ws = workspaceFixturesDir();
    const ctx = tempDir();
    seedTemplates(dataDir);
    seedContextFile(ctx, "git/aitne/overview.md", "ORIGINAL_BODY");
    const result = prepareRetemplateRun({
      db,
      dataDir,
      workspaceDir: ws,
      contextDir: ctx,
      kind: "project",
      repos: [makeRepo({ slug: "aitne" })],
    });
    if (!result.ok) throw new Error("setup_failed");
    // Mark as started — agent has begun the file
    persistPerFileStatus({
      db,
      slug: "aitne",
      status: "started",
      correlationId: result.correlationId,
    });
    if (opts.erroredHalfWritten) {
      // Simulate the agent half-writing the target before crashing
      writeFileSync(
        join(ctx, "git/aitne/overview.md"),
        "HALF_WRITTEN",
        "utf-8",
      );
    }
    return {
      db,
      ctx,
      scheduleId: result.scheduleId,
      targetPath: join(ctx, "git/aitne/overview.md"),
      backupPath: join(result.backupRoot, "git/aitne/overview.md"),
    };
  }

  it("restores in-flight 'started' file from backup on clean exit", () => {
    const setup = setupRunWithStartedFile({ erroredHalfWritten: true });
    const result = finalizeRetemplate({
      db: setup.db,
      contextDir: setup.ctx,
      scheduleId: setup.scheduleId,
      errored: false,
    });
    expect(result.applied).toBe(true);
    expect(result.rolledBackSlugs).toEqual(["aitne"]);
    expect(result.finalStatus).toBe("failed"); // rolled_back counts as failed
    expect(readFileSync(setup.targetPath, "utf-8")).toBe("ORIGINAL_BODY");

    const status = readRetemplateStatus(setup.db);
    expect(status?.files.aitne.status).toBe("rolled_back");
    expect(status?.finalizedAt).toBeDefined();
    expect(status?.finalStatus).toBe("failed");
  });

  it("on errored run, restores even pending entries (defensive)", () => {
    const db = seedDb();
    const dataDir = tempDir();
    const ws = workspaceFixturesDir();
    const ctx = tempDir();
    seedTemplates(dataDir);
    seedContextFile(ctx, "git/aitne/overview.md", "ORIGINAL");
    const result = prepareRetemplateRun({
      db,
      dataDir,
      workspaceDir: ws,
      contextDir: ctx,
      kind: "project",
      repos: [makeRepo({ slug: "aitne" })],
    });
    if (!result.ok) throw new Error("setup_failed");
    // Simulate an out-of-band write before the agent even reported started
    writeFileSync(join(ctx, "git/aitne/overview.md"), "DAMAGED", "utf-8");

    const finalize = finalizeRetemplate({
      db,
      contextDir: ctx,
      scheduleId: result.scheduleId,
      errored: true,
    });
    expect(finalize.applied).toBe(true);
    expect(finalize.rolledBackSlugs).toEqual(["aitne"]);
    expect(readFileSync(join(ctx, "git/aitne/overview.md"), "utf-8")).toBe(
      "ORIGINAL",
    );
  });

  it("on clean exit with all files completed, applied=false at file level and finalStatus is success", () => {
    const db = seedDb();
    const dataDir = tempDir();
    const ws = workspaceFixturesDir();
    const ctx = tempDir();
    seedTemplates(dataDir);
    seedContextFile(ctx, "git/aitne/overview.md", "ORIGINAL");
    const prep = prepareRetemplateRun({
      db,
      dataDir,
      workspaceDir: ws,
      contextDir: ctx,
      kind: "project",
      repos: [makeRepo({ slug: "aitne" })],
    });
    if (!prep.ok) throw new Error("prep_failed");
    persistPerFileStatus({
      db,
      slug: "aitne",
      status: "completed",
      correlationId: prep.correlationId,
      beforeBytes: 8,
      afterBytes: 9,
    });
    const finalize = finalizeRetemplate({
      db,
      contextDir: ctx,
      scheduleId: prep.scheduleId,
      errored: false,
    });
    expect(finalize.applied).toBe(true);
    expect(finalize.rolledBackSlugs).toEqual([]);
    expect(finalize.finalStatus).toBe("success");
    const status = readRetemplateStatus(db);
    expect(status?.finalStatus).toBe("success");
    expect(status?.finalizedAt).toBeDefined();
  });

  it("does NOT add session_aborted reason when entry already carries an error (entry.error truthy branch, line 542)", () => {
    // Lines 516 and 542: exercises the `options.now?.()` defined path (passing
    // now explicitly) AND the `entry.error ? {} : { reason: "session_aborted" }`
    // true branch (entry already has an error, so we must not overwrite the
    // existing error message with "session_aborted").
    const setup = setupRunWithStartedFile({ erroredHalfWritten: false });
    // Inject a pre-existing error onto the still-started entry — simulates a
    // scenario where a prior attempt wrote an error field without settling the
    // status to a terminal state.
    const injectResult = persistPerFileStatus({
      db: setup.db,
      slug: "aitne",
      status: "started",
      error: "prior_error",
    });
    expect(injectResult.ok).toBe(true);

    const fixedNow = new Date("2026-05-07T00:00:00.000Z");
    const result = finalizeRetemplate({
      db: setup.db,
      contextDir: setup.ctx,
      scheduleId: setup.scheduleId,
      errored: false,
      now: () => fixedNow,
    });
    expect(result.rolledBackSlugs).toEqual(["aitne"]);
    const status = readRetemplateStatus(setup.db);
    // The existing error must survive — no "session_aborted" reason added.
    expect(status?.files.aitne.error).toBe("prior_error");
    expect(status?.files.aitne.reason).toBeUndefined();
    expect(status?.files.aitne.completedAt).toBe("2026-05-07T00:00:00.000Z");
  });

  it("is idempotent — second call after finalize is a no-op", () => {
    const setup = setupRunWithStartedFile({ erroredHalfWritten: false });
    const first = finalizeRetemplate({
      db: setup.db,
      contextDir: setup.ctx,
      scheduleId: setup.scheduleId,
      errored: false,
    });
    expect(first.applied).toBe(true);
    const second = finalizeRetemplate({
      db: setup.db,
      contextDir: setup.ctx,
      scheduleId: setup.scheduleId,
      errored: false,
    });
    expect(second.applied).toBe(false);
    expect(second.rolledBackSlugs).toEqual([]);
  });

  it("returns no-op when the status grid does not match the schedule id", () => {
    const db = seedDb();
    const result = finalizeRetemplate({
      db,
      contextDir: tempDir(),
      scheduleId: 999,
      errored: false,
    });
    expect(result.applied).toBe(false);
  });

  it("marks file as failed with rollback_failed error when restoring throws", () => {
    // Pin the catch branch in finalizeRetemplate's restore loop.
    // We force `writeFileAtomically` to throw by replacing the
    // destination file with a symlink — atomic-write refuses to
    // overwrite a symlink and throws EATOMIC_TARGET_SYMLINK. The
    // file row must end up `failed` with `rollback_failed:` prefixed
    // error message rather than silently rolled back.
    const setup = setupRunWithStartedFile({ erroredHalfWritten: false });
    rmSync(setup.targetPath, { force: true });
    // Point the dst at a symlink — writeFileAtomically refuses to
    // overwrite a symlink and throws synchronously.
    symlinkSync("/dev/null", setup.targetPath);

    const result = finalizeRetemplate({
      db: setup.db,
      contextDir: setup.ctx,
      scheduleId: setup.scheduleId,
      errored: false,
    });
    expect(result.applied).toBe(true);
    expect(result.rolledBackSlugs).toEqual([]);
    expect(result.finalStatus).toBe("failed");
    const status = readRetemplateStatus(setup.db);
    expect(status?.files.aitne.status).toBe("failed");
    expect(status?.files.aitne.error).toMatch(/^rollback_failed: /);
    expect(status?.finalizedAt).toBeDefined();
  });

  it("marks file as failed when backup is missing (cannot restore)", () => {
    const setup = setupRunWithStartedFile({ erroredHalfWritten: true });
    rmSync(setup.backupPath, { force: true });
    const result = finalizeRetemplate({
      db: setup.db,
      contextDir: setup.ctx,
      scheduleId: setup.scheduleId,
      errored: false,
    });
    expect(result.rolledBackSlugs).toEqual([]);
    expect(result.finalStatus).toBe("failed");
    const status = readRetemplateStatus(setup.db);
    expect(status?.finalizedAt).toBeDefined();
    expect(status?.files.aitne.status).toBe("failed");
    expect(status?.files.aitne.error).toContain("backup_missing");
  });
});
