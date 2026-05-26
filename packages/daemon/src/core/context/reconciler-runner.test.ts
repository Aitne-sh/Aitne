import { describe, expect, it, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  utimesSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../../db/schema.js";
import {
  RECONCILER_LAST_RUN_KEY,
  runReconciler,
  type ReconcilerRunRecord,
} from "./reconciler-runner.js";
import {
  readRuntimeState,
  setDegradedMode,
} from "../../db/runtime-state.js";
import { AgentWriteTracker } from "../../safety/agent-write-tracker.js";
import { parseContextIndexRows } from "../review-context.js";

const FIXED_NOW = new Date("2026-04-21T15:00:00Z");
const now = () => FIXED_NOW;

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function seedTemplate(contextDir: string): void {
  writeFileSync(
    join(contextDir, "_index.md"),
    [
      "---",
      "type: index",
      "owner: agent",
      "updated: 2026-04-17",
      "---",
      "# Context Index",
      "",
      "## Files",
      "",
      "| Path | Purpose | Review flows | Last touched |",
      "|---|---|---|---|",
      "| `state/today.md` | Today's state | hourly, morning, evening | 2026-04-17 |",
      "| `identity/profile.md` | User profile | all | 2026-04-17 |",
      "| `plans/projects/legacy.md` | Old project | weekly | 2026-04-10 |",
      "",
    ].join("\n"),
  );
}

function touch(path: string, dateIso: string): void {
  const when = new Date(dateIso);
  utimesSync(path, when, when);
}

describe("runReconciler", () => {
  let tmp: string;
  let contextDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "reconciler-runner-"));
    contextDir = join(tmp, "context");
    mkdirSync(contextDir, { recursive: true });
    mkdirSync(join(contextDir, "identity"), { recursive: true });
    mkdirSync(join(contextDir, "state"), { recursive: true });
    mkdirSync(join(contextDir, "plans", "projects"), { recursive: true });
    mkdirSync(join(contextDir, "policies"), { recursive: true });
    mkdirSync(join(contextDir, "journal", "daily"), { recursive: true });
    mkdirSync(join(contextDir, "knowledge", "dossiers"), { recursive: true });
    db = makeDb();
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writes a fresh index, removes stale rows, and refreshes mtime", async () => {
    seedTemplate(contextDir);
    writeFileSync(join(contextDir, "state", "today.md"), "# Today\n\nstub");
    writeFileSync(
      join(contextDir, "identity/profile.md"),
      "---\ntype: user\nowner: shared\nupdated: 2026-04-20\n---\n# Profile\n",
    );
    writeFileSync(
      join(contextDir, "plans/projects/alpha.md"),
      "---\ntype: project\nowner: shared\nupdated: 2026-04-21\n---\n# Project Alpha — Q2\n",
    );
    touch(join(contextDir, "state", "today.md"), "2026-04-17T00:00:00Z");
    touch(join(contextDir, "identity/profile.md"), "2026-04-20T00:00:00Z");
    touch(join(contextDir, "plans/projects/alpha.md"), "2026-04-21T00:00:00Z");

    const writeTracker = new AgentWriteTracker();
    const contextChangeCalls: Array<{
      path: string;
      reason: string;
      tier: string | undefined;
      tierReason: string | undefined;
    }> = [];

    const result = await runReconciler({
      db,
      contextDir,
      writeTracker,
      onPromptContextChanged: (path, reason, tier, metadata) =>
        contextChangeCalls.push({
          path,
          reason,
          tier,
          tierReason: metadata?.tierReason,
        }),
      trigger: "startup",
      timezone: "UTC",
      now,
    });

    expect(result.result).toBe("applied");
    expect(result.added).toBeGreaterThan(0);
    expect(result.removed).toBeGreaterThan(0);
    expect(result.refreshedMtime).toBeGreaterThan(0);

    const rewritten = readFileSync(join(contextDir, "_index.md"), "utf-8");
    // V15: the outer frontmatter `updated:` is user-curated and survives
    // verbatim — the seed wrote `updated: 2026-04-17`, the reconciler does
    // not touch it. The bump date lives inside the reconciler block body
    // (`_Reconciled by daemon on YYYY-MM-DD._`).
    expect(rewritten).toContain("updated: 2026-04-17");
    expect(rewritten).toContain("_Reconciled by daemon on 2026-04-21._");
    const rows = parseContextIndexRows(rewritten);
    const rowPaths = rows.map((r) => r.path);
    expect(rowPaths).toContain("plans/projects/alpha.md");
    expect(rowPaths).not.toContain("plans/projects/legacy.md");

    const alphaRow = rows.find((r) => r.path === "plans/projects/alpha.md")!;
    expect(alphaRow.purpose).toBe("Project Alpha — Q2");
    expect(alphaRow.lastTouched).toBe("2026-04-21");

    const profileRow = rows.find((r) => r.path === "identity/profile.md")!;
    // User-edited Purpose/reviewFlows survive verbatim.
    expect(profileRow.purpose).toBe("User profile");
    expect(profileRow.reviewFlows).toBe("all");
    expect(profileRow.lastTouched).toBe("2026-04-20");

    expect(contextChangeCalls).toEqual([
      {
        path: "_index.md",
        reason: "reconciler",
        tier: "quiet",
        tierReason: "derived_context_index",
      },
    ]);

    const snapshotRow = db
      .prepare(
        "SELECT trigger FROM md_file_snapshots WHERE file_path = ? ORDER BY id DESC LIMIT 1",
      )
      .get("_index.md") as { trigger: string } | undefined;
    expect(snapshotRow?.trigger).toBe("reconciler_write");

    const persisted = readRuntimeState<ReconcilerRunRecord>(
      db,
      RECONCILER_LAST_RUN_KEY,
    );
    expect(persisted?.result).toBe("applied");
    expect(persisted?.trigger).toBe("startup");
    expect(persisted?.error).toBeNull();
  });

  it("creates the index when the file is missing (recovery path)", async () => {
    writeFileSync(
      join(contextDir, "state", "today.md"),
      "---\ntype: daily\nowner: agent\nupdated: 2026-04-21\n---\n# Today\n",
    );
    touch(join(contextDir, "state", "today.md"), "2026-04-21T00:00:00Z");
    expect(existsSync(join(contextDir, "_index.md"))).toBe(false);

    const result = await runReconciler({
      db,
      contextDir,
      trigger: "startup",
      timezone: "UTC",
      now,
    });

    expect(result.result).toBe("applied");
    expect(existsSync(join(contextDir, "_index.md"))).toBe(true);
    const rows = parseContextIndexRows(
      readFileSync(join(contextDir, "_index.md"), "utf-8"),
    );
    expect(rows.some((row) => row.path === "state/today.md")).toBe(true);
  });

  it("returns noop when the snapshot already matches the index", async () => {
    writeFileSync(
      join(contextDir, "state", "today.md"),
      "---\ntype: daily\nowner: agent\nupdated: 2026-04-21\n---\n# Today\n",
    );
    touch(join(contextDir, "state", "today.md"), "2026-04-21T00:00:00Z");

    // First run to establish the canonical index.
    await runReconciler({
      db,
      contextDir,
      trigger: "startup",
      timezone: "UTC",
      now,
    });
    const first = readFileSync(join(contextDir, "_index.md"), "utf-8");

    // Second run with no filesystem changes.
    const second = await runReconciler({
      db,
      contextDir,
      trigger: "cron",
      timezone: "UTC",
      now,
    });
    expect(second.result).toBe("noop");
    expect(readFileSync(join(contextDir, "_index.md"), "utf-8")).toBe(first);
  });

  it("records an error when the write fails but still persists the run record", async () => {
    writeFileSync(
      join(contextDir, "state", "today.md"),
      "---\ntype: daily\nowner: agent\nupdated: 2026-04-21\n---\n# Today\n",
    );
    touch(join(contextDir, "state", "today.md"), "2026-04-21T00:00:00Z");
    // Replace `context-index.md` with a directory — writeFileSync then
    // fails with EISDIR, which is the real failure shape we expect when
    // the user has mis-placed a directory at the reconciler's target.
    mkdirSync(join(contextDir, "_index.md"));

    const result = await runReconciler({
      db,
      contextDir,
      trigger: "cron",
      timezone: "UTC",
      now,
    });

    expect(result.result).toBe("error");
    expect(result.error).not.toBeNull();

    const persisted = readRuntimeState<ReconcilerRunRecord>(
      db,
      RECONCILER_LAST_RUN_KEY,
    );
    expect(persisted?.result).toBe("error");
  });

  it("exits early when degraded mode is active", async () => {
    writeFileSync(
      join(contextDir, "state", "today.md"),
      "---\ntype: daily\nowner: agent\nupdated: 2026-04-21\n---\n# Today\n",
    );
    touch(join(contextDir, "state", "today.md"), "2026-04-21T00:00:00Z");
    setDegradedMode(db, {
      reason: "primary_unreachable",
      path: contextDir,
      since: "2026-04-21T00:00:00Z",
    });

    const result = await runReconciler({
      db,
      contextDir,
      trigger: "fs_event",
      timezone: "UTC",
      now,
    });
    expect(result.result).toBe("noop");
    expect(result.error).toBe("degraded_mode:primary_unreachable");
    // No index written.
    expect(existsSync(join(contextDir, "_index.md"))).toBe(false);
  });

  it("treats an unparseable context-index.md as empty and rebuilds it", async () => {
    writeFileSync(join(contextDir, "state", "today.md"), "# Today\nstub");
    touch(join(contextDir, "state", "today.md"), "2026-04-21T00:00:00Z");
    writeFileSync(
      join(contextDir, "_index.md"),
      "not a table at all",
    );

    const result = await runReconciler({
      db,
      contextDir,
      trigger: "cron",
      timezone: "UTC",
      now,
    });
    expect(result.result).toBe("applied");
    const rows = parseContextIndexRows(
      readFileSync(join(contextDir, "_index.md"), "utf-8"),
    );
    expect(rows.some((r) => r.path === "state/today.md")).toBe(true);
  });

  it("returns noop when contextDir does not exist", async () => {
    const missing = join(tmp, "missing");
    const result = await runReconciler({
      db,
      contextDir: missing,
      trigger: "cron",
      timezone: "UTC",
      now,
    });
    expect(result.result).toBe("noop");
  });

  it("serializes concurrent calls", async () => {
    writeFileSync(
      join(contextDir, "state", "today.md"),
      "---\ntype: daily\nowner: agent\nupdated: 2026-04-21\n---\n# Today\n",
    );
    touch(join(contextDir, "state", "today.md"), "2026-04-21T00:00:00Z");

    const [ra, rb] = await Promise.all([
      runReconciler({
        db,
        contextDir,
        trigger: "startup",
        timezone: "UTC",
        now,
      }),
      runReconciler({
        db,
        contextDir,
        trigger: "cron",
        timezone: "UTC",
        now,
      }),
    ]);
    const results = [ra.result, rb.result].sort();
    expect(results).toEqual(["applied", "noop"]);
  });

  it("extracts H1 titles while skipping frontmatter blocks", async () => {
    writeFileSync(
      join(contextDir, "plans/projects/alpha.md"),
      [
        "---",
        "type: project",
        "owner: shared",
        "updated: 2026-04-21",
        "---",
        "",
        "Some intro line",
        "# Project Alpha — Q2",
        "",
        "body",
      ].join("\n"),
    );
    touch(join(contextDir, "plans/projects/alpha.md"), "2026-04-21T00:00:00Z");

    const result = await runReconciler({
      db,
      contextDir,
      trigger: "cron",
      timezone: "UTC",
      now,
    });
    expect(result.result).toBe("applied");
    const rows = parseContextIndexRows(
      readFileSync(join(contextDir, "_index.md"), "utf-8"),
    );
    const alpha = rows.find((r) => r.path === "plans/projects/alpha.md");
    expect(alpha?.purpose).toBe("Project Alpha — Q2");
  });

  it("silently skips the snapshot write when md_file_snapshots is unavailable", async () => {
    writeFileSync(
      join(contextDir, "state", "today.md"),
      "---\ntype: daily\nowner: agent\nupdated: 2026-04-21\n---\n# Today\n",
    );
    touch(join(contextDir, "state", "today.md"), "2026-04-21T00:00:00Z");
    writeFileSync(join(contextDir, "_index.md"), "placeholder");
    db.prepare("DROP TABLE md_file_snapshots").run();

    const result = await runReconciler({
      db,
      contextDir,
      trigger: "cron",
      timezone: "UTC",
      now,
    });
    // Snapshot insert failed; the reconciler continues and the index is
    // still rewritten because the snapshot is a best-effort side-effect.
    expect(result.result).toBe("applied");
    expect(readFileSync(join(contextDir, "_index.md"), "utf-8")).toContain(
      "updated: 2026-04-21",
    );
  });
});

describe("runReconciler — run-record persistence", () => {
  it("does not throw when writeRuntimeState fails", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "reconciler-runner-err-"));
    const contextDir = join(tmp, "context");
    mkdirSync(contextDir, { recursive: true });
    mkdirSync(join(contextDir, "state"), { recursive: true });
    writeFileSync(join(contextDir, "state", "today.md"), "# Today\n");
    try {
      const db = makeDb();
      db.prepare("DROP TABLE runtime_state").run();
      const result = await runReconciler({
        db,
        contextDir,
        trigger: "manual",
        timezone: "UTC",
        now,
      });
      expect(result.trigger).toBe("manual");
      db.close();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
