import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../db/schema.js";
import { getPendingObservations } from "../db/observations.js";
import { AgentWriteTracker } from "../safety/agent-write-tracker.js";
import { recordFileChange } from "./obsidian-watcher.js";

/**
 * Direct tests for the pure `recordFileChange` helper. Bypasses
 * chokidar entirely so the semantics we care about — source tagging,
 * agent-write suppression, extension filter — are covered
 * deterministically.
 */
describe("recordFileChange", () => {
  let tmpRoot: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "pa-record-file-change-"));
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("records a user edit with the supplied source tag", async () => {
    const vaultPath = join(tmpRoot, "vault");
    mkdirSync(vaultPath);
    const filePath = join(vaultPath, "today.md");
    writeFileSync(filePath, "# user wrote this\n");

    const outcome = await recordFileChange({
      vaultPath,
      filePath,
      changeType: "modified",
      source: "obsidian:primary",
      db,
    });

    expect(outcome).toBe("recorded");
    const rows = getPendingObservations(db, { sourceFilter: "obsidian" });
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("obsidian:primary");
    expect(rows[0].ref).toBe("today.md");
    expect(rows[0].actor).toBe("user");
  });

  it("primary and external same-named file do NOT collide on upsert", async () => {
    const primaryVault = join(tmpRoot, "primary");
    const externalVault = join(tmpRoot, "external");
    mkdirSync(primaryVault);
    mkdirSync(externalVault);
    writeFileSync(join(primaryVault, "today.md"), "# primary\n");
    writeFileSync(join(externalVault, "today.md"), "# external\n");

    await recordFileChange({
      vaultPath: primaryVault,
      filePath: join(primaryVault, "today.md"),
      changeType: "modified",
      source: "obsidian:primary",
      db,
    });
    await recordFileChange({
      vaultPath: externalVault,
      filePath: join(externalVault, "today.md"),
      changeType: "modified",
      source: "obsidian:external",
      db,
    });

    const rows = getPendingObservations(db, { sourceFilter: "obsidian" });
    // Two rows — one per source. Pre-fix behaviour would have upserted
    // one over the other on the (source='obsidian', ref='today.md')
    // conflict key.
    expect(rows).toHaveLength(2);
    const bySource = new Map(rows.map((r) => [r.source, r]));
    expect(bySource.get("obsidian:primary")).toBeDefined();
    expect(bySource.get("obsidian:external")).toBeDefined();
  });

  it("silently drops agent-originated writes instead of tagging them actor='agent'", async () => {
    const vaultPath = join(tmpRoot, "vault");
    mkdirSync(vaultPath);
    const filePath = join(vaultPath, "roadmap.md");
    const content = "# agent rewrote\n";
    writeFileSync(filePath, content);

    const tracker = new AgentWriteTracker();
    tracker.markWriting(filePath, content);

    const outcome = await recordFileChange({
      vaultPath,
      filePath,
      changeType: "modified",
      source: "obsidian:primary",
      db,
      writeTracker: tracker,
    });

    expect(outcome).toBe("skipped:agent");
    const rows = getPendingObservations(db, { sourceFilter: "obsidian" });
    expect(rows).toHaveLength(0);
  });

  it("ignores non-markdown files entirely", async () => {
    const vaultPath = join(tmpRoot, "vault");
    mkdirSync(vaultPath);
    const filePath = join(vaultPath, "image.png");
    writeFileSync(filePath, "bytes");

    const outcome = await recordFileChange({
      vaultPath,
      filePath,
      changeType: "created",
      source: "obsidian:primary",
      db,
    });

    expect(outcome).toBe("skipped:ext");
    expect(getPendingObservations(db)).toHaveLength(0);
  });

  it("records a deletion with empty preview", async () => {
    const vaultPath = join(tmpRoot, "vault");
    mkdirSync(vaultPath);
    const filePath = join(vaultPath, "gone.md");

    const outcome = await recordFileChange({
      vaultPath,
      filePath,
      changeType: "deleted",
      source: "obsidian:primary",
      db,
    });

    expect(outcome).toBe("recorded");
    const rows = getPendingObservations(db, { sourceFilter: "obsidian" });
    expect(rows).toHaveLength(1);
    expect(rows[0].change_type).toBe("deleted");
  });
});
