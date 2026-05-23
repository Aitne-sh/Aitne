import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as nodePath from "node:path";

// Wrap `relative` with a vi.fn so individual tests can inject a mocked return
// value (mockReturnValueOnce) to exercise the dead-code defense-in-depth
// branch in resolveInside (rel.startsWith("..")) that is unreachable from a
// normal FS because path.resolve never produces a traversal path from valid
// relative inputs.
vi.mock("node:path", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:path")>();
  return { ...original, relative: vi.fn(original.relative) };
});
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.js";
import { readRuntimeState } from "../db/runtime-state.js";
import { readPendingTemplateUpgrades } from "./template-versions.js";
import {
  INSTRUCTION_ASSETS_STAMP,
  RELEASE_ASSETS_DOCS_SNAPSHOT_KEY,
  RELEASE_ASSETS_STATUS_KEY,
  computeInstructionAssetStatus,
  findBuiltinShadowedUserSkills,
  readInstructionAssetStamp,
  readInstructionStampManifest,
  readReleaseAssetStatus,
  reconcileDocsCorpus,
  reconcileTemplateAssets,
  recordInstructionAssetStatus,
  recordSkillAssetStatus,
  sessionInstructionAssetsStale,
  sha256File,
  sourceFileStats,
  writeInstructionAssetStamp,
  type AssetSnapshotRecord,
  type ReleaseAssetStatusRecord,
} from "./release-assets.js";

const NOW = new Date("2026-05-06T12:00:00.000Z");

function seedDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function write(root: string, rel: string, body: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf-8");
}

function read(root: string, rel: string): string {
  return readFileSync(join(root, rel), "utf-8");
}

describe("release asset reconciliation", () => {
  let tmp: string;
  let db: Database.Database;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pa-release-assets-"));
    db = seedDb();
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("seeds missing docs from the bundled corpus and stores a snapshot", () => {
    const source = join(tmp, "agent-assets", "docs");
    const target = join(tmp, "docs", "user");
    write(source, "guides/setup.md", "---\ntitle: Setup\n---\n# Setup\n");

    const status = reconcileDocsCorpus({
      db,
      sourceDir: source,
      targetDir: target,
      backupRoot: join(tmp, "backups"),
      now: () => NOW,
    });

    expect(status.added).toBe(1);
    expect(status.conflicts).toEqual([]);
    expect(read(target, "guides/setup.md")).toContain("# Setup");
    const snapshot = readRuntimeState<AssetSnapshotRecord>(
      db,
      RELEASE_ASSETS_DOCS_SNAPSHOT_KEY,
    );
    expect(snapshot?.files["guides/setup.md"].sourceSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("auto-refreshes docs that still match the previous shipped hash", () => {
    const source = join(tmp, "agent-assets", "docs");
    const target = join(tmp, "docs", "user");
    const backups = join(tmp, "backups");
    write(source, "reference/api.md", "---\ntitle: API\n---\n# API v1\n");
    reconcileDocsCorpus({
      db,
      sourceDir: source,
      targetDir: target,
      backupRoot: backups,
      now: () => NOW,
    });

    write(source, "reference/api.md", "---\ntitle: API\n---\n# API v2\n");
    const status = reconcileDocsCorpus({
      db,
      sourceDir: source,
      targetDir: target,
      backupRoot: backups,
      now: () => NOW,
    });

    expect(status.autoUpdated).toBe(1);
    expect(status.conflicts).toEqual([]);
    expect(read(target, "reference/api.md")).toContain("# API v2");
    expect(
      existsSync(
        join(
          backups,
          "2026-05-06T12-00-00-000Z",
          "docs",
          "reference",
          "api.md",
        ),
      ),
    ).toBe(true);
  });

  it("preserves user-edited docs and reports a manual-review conflict", () => {
    const source = join(tmp, "agent-assets", "docs");
    const target = join(tmp, "docs", "user");
    write(source, "guides/setup.md", "---\ntitle: Setup\n---\n# Setup v1\n");
    reconcileDocsCorpus({
      db,
      sourceDir: source,
      targetDir: target,
      now: () => NOW,
    });

    write(target, "guides/setup.md", "---\ntitle: Setup\n---\n# My setup notes\n");
    write(source, "guides/setup.md", "---\ntitle: Setup\n---\n# Setup v2\n");
    const status = reconcileDocsCorpus({
      db,
      sourceDir: source,
      targetDir: target,
      now: () => NOW,
    });

    expect(status.conflicts).toEqual([
      expect.objectContaining({
        path: "guides/setup.md",
        reason: "user_modified",
      }),
    ]);
    expect(read(target, "guides/setup.md")).toContain("My setup notes");
  });

  it("auto-updates versioned templates when the user copy is unmodified", () => {
    const templates = join(tmp, "agent-assets", "templates");
    const context = join(tmp, "context");
    write(
      templates,
      "_manifest.json",
      JSON.stringify({ manifestVersion: 1, templates: { "rules/x.md": { version: 1 } } }),
    );
    write(templates, "rules/x.md", "---\ntemplate_version: 1\n---\n# X v1\n");
    reconcileTemplateAssets({
      db,
      templatesRoot: templates,
      contextDir: context,
      now: () => NOW,
    });

    write(
      templates,
      "_manifest.json",
      JSON.stringify({ manifestVersion: 1, templates: { "rules/x.md": { version: 2 } } }),
    );
    write(templates, "rules/x.md", "---\ntemplate_version: 2\n---\n# X v2\n");
    const status = reconcileTemplateAssets({
      db,
      templatesRoot: templates,
      contextDir: context,
      backupRoot: join(tmp, "backups"),
      now: () => NOW,
    });

    expect(status.autoUpdated).toBe(1);
    expect(status.pending).toEqual([]);
    expect(read(context, "rules/x.md")).toContain("# X v2");
    expect(readPendingTemplateUpgrades(db)?.pending).toEqual([]);
  });

  it("preserves edited old templates and keeps them pending", () => {
    const templates = join(tmp, "agent-assets", "templates");
    const context = join(tmp, "context");
    write(
      templates,
      "_manifest.json",
      JSON.stringify({ manifestVersion: 1, templates: { "rules/x.md": { version: 1 } } }),
    );
    write(templates, "rules/x.md", "---\ntemplate_version: 1\n---\n# X v1\n");
    reconcileTemplateAssets({
      db,
      templatesRoot: templates,
      contextDir: context,
      now: () => NOW,
    });

    write(context, "rules/x.md", "---\ntemplate_version: 1\n---\n# User edit\n");
    write(
      templates,
      "_manifest.json",
      JSON.stringify({ manifestVersion: 1, templates: { "rules/x.md": { version: 2 } } }),
    );
    write(templates, "rules/x.md", "---\ntemplate_version: 2\n---\n# X v2\n");
    const status = reconcileTemplateAssets({
      db,
      templatesRoot: templates,
      contextDir: context,
      now: () => NOW,
    });

    expect(status.pending).toEqual([{ path: "rules/x.md", from: 1, to: 2 }]);
    expect(status.conflicts[0]).toMatchObject({
      path: "rules/x.md",
      reason: "user_modified",
    });
    expect(read(context, "rules/x.md")).toContain("User edit");
    expect(readPendingTemplateUpgrades(db)?.pending).toEqual([
      { path: "rules/x.md", from: 1, to: 2 },
    ]);
    const releaseStatus = readRuntimeState<ReleaseAssetStatusRecord>(
      db,
      RELEASE_ASSETS_STATUS_KEY,
    );
    expect(releaseStatus?.templates?.pending).toHaveLength(1);
  });

  it("findBuiltinShadowedUserSkills returns empty array when both skill directories are absent", () => {
    // Neither dataDir/skills/ nor workspaceDir/agent-assets/skills/ exists —
    // listSkillSlugs fires the !existsSync(root) early-return branch (line 573).
    const dataDir = join(tmp, "data-no-skills");
    const workspaceDir = join(tmp, "ws-no-skills");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    expect(findBuiltinShadowedUserSkills(dataDir, workspaceDir)).toEqual([]);
  });

  it("detects user skills shadowed by newly shipped built-ins", () => {
    const dataDir = join(tmp, "data");
    const workspaceDir = join(tmp, "workspace");
    write(dataDir, "skills/travel/SKILL.md", "---\nname: travel\n---\n# Mine\n");
    write(workspaceDir, "agent-assets/skills/travel/SKILL.md", "---\nname: travel\n---\n# Built-in\n");
    write(workspaceDir, "agent-assets/skills/mail/SKILL.md", "---\nname: mail\n---\n# Mail\n");

    expect(findBuiltinShadowedUserSkills(dataDir, workspaceDir)).toEqual(["travel"]);
  });

  /* ── readInstructionStampManifest ──────────────────────────────────── */

  it("readInstructionStampManifest returns null when no stamp file exists", () => {
    const sessionDir = join(tmp, "session-no-stamp");
    mkdirSync(sessionDir, { recursive: true });
    expect(readInstructionStampManifest(sessionDir)).toBeNull();
  });

  it("readInstructionStampManifest round-trips a manifest written by writeInstructionAssetStamp", () => {
    const workspaceDir = join(tmp, "workspace-rt");
    const sessionDir = join(tmp, "session-rt");
    write(workspaceDir, "agent-assets/agent-profiles/task.md", "# Task\n");
    write(workspaceDir, "agent-assets/task-flows/default.md", "{context}\n");
    mkdirSync(sessionDir, { recursive: true });
    const status = computeInstructionAssetStatus(workspaceDir, () => NOW);
    writeInstructionAssetStamp(sessionDir, status, {
      processKey: "morning_routine",
      skillSlugs: ["b-skill", "a-skill"],
    });
    const m = readInstructionStampManifest(sessionDir);
    expect(m).not.toBeNull();
    expect(m!.processKey).toBe("morning_routine");
    // writeInstructionAssetStamp sorts the slugs deterministically.
    expect(m!.skillSlugs).toEqual(["a-skill", "b-skill"]);
  });

  it("readInstructionStampManifest returns null when the stamp lacks a manifest field", () => {
    const sessionDir = join(tmp, "session-no-manifest");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, INSTRUCTION_ASSETS_STAMP),
      JSON.stringify({ fingerprint: "deadbeef" }),
      "utf-8",
    );
    expect(readInstructionStampManifest(sessionDir)).toBeNull();
  });

  it("readInstructionStampManifest rejects a manifest whose processKey is not a string", () => {
    const sessionDir = join(tmp, "session-bad-key");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, INSTRUCTION_ASSETS_STAMP),
      JSON.stringify({ manifest: { processKey: 7, skillSlugs: [] } }),
      "utf-8",
    );
    expect(readInstructionStampManifest(sessionDir)).toBeNull();
  });

  it("readInstructionStampManifest rejects a manifest whose skillSlugs is not an array", () => {
    const sessionDir = join(tmp, "session-bad-slugs");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, INSTRUCTION_ASSETS_STAMP),
      JSON.stringify({ manifest: { processKey: "x", skillSlugs: "not-array" } }),
      "utf-8",
    );
    expect(readInstructionStampManifest(sessionDir)).toBeNull();
  });

  it("readInstructionStampManifest rejects a manifest with a non-string slug element", () => {
    const sessionDir = join(tmp, "session-bad-slug-elem");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, INSTRUCTION_ASSETS_STAMP),
      JSON.stringify({ manifest: { processKey: "x", skillSlugs: ["ok", 42] } }),
      "utf-8",
    );
    expect(readInstructionStampManifest(sessionDir)).toBeNull();
  });

  it("readInstructionStampManifest returns null when the stamp file is not valid JSON", () => {
    const sessionDir = join(tmp, "session-bad-json");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, INSTRUCTION_ASSETS_STAMP),
      "{not: valid json",
      "utf-8",
    );
    expect(readInstructionStampManifest(sessionDir)).toBeNull();
  });

  it("stamps session workdirs with the instruction asset fingerprint", () => {
    const workspaceDir = join(tmp, "workspace");
    const sessionDir = join(tmp, "session");
    write(workspaceDir, "agent-assets/agent-profiles/task.md", "# Task\n");
    write(workspaceDir, "agent-assets/skills/context/SKILL.md", "---\nname: context\n---\n# Context\n");
    write(workspaceDir, "agent-assets/task-flows/default.md", "{context}\n");
    mkdirSync(sessionDir, { recursive: true });

    const status = computeInstructionAssetStatus(workspaceDir, () => NOW);
    expect(sessionInstructionAssetsStale(sessionDir, workspaceDir)).toBe(true);
    writeInstructionAssetStamp(sessionDir, status);
    expect(readInstructionAssetStamp(sessionDir)).toBe(status.fingerprint);
    expect(sessionInstructionAssetsStale(sessionDir, workspaceDir)).toBe(false);
    expect(existsSync(join(sessionDir, INSTRUCTION_ASSETS_STAMP))).toBe(true);
  });

  /* ── sha256File ─────────────────────────────────────────────────── */

  it("sha256File returns a 64-char hex digest of the file content", () => {
    const srcFile = join(tmp, "hashme.txt");
    writeFileSync(srcFile, "hello-world", "utf-8");
    const digest = sha256File(srcFile);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    // Content-sensitive: mutating the file must change the hash.
    writeFileSync(srcFile, "goodbye-world", "utf-8");
    expect(sha256File(srcFile)).not.toBe(digest);
  });

  /* ── sourceFileStats ─────────────────────────────────────────────── */

  it("sourceFileStats counts files and sums byte sizes recursively", () => {
    const root = join(tmp, "stats-root");
    write(root, "a.md", "hello");       // 5 bytes
    write(root, "sub/b.md", "world!");  // 6 bytes
    const stats = sourceFileStats(root);
    expect(stats.files).toBe(2);
    expect(stats.bytes).toBe(11);
  });

  /* ── readReleaseAssetStatus ──────────────────────────────────────── */

  it("readReleaseAssetStatus returns null before any reconcile, then reflects merged state", () => {
    expect(readReleaseAssetStatus(db)).toBeNull();

    const source = join(tmp, "docs-src");
    const target = join(tmp, "docs-tgt");
    write(source, "index.md", "# Docs\n");
    reconcileDocsCorpus({ db, sourceDir: source, targetDir: target, now: () => NOW });

    const record = readReleaseAssetStatus(db);
    expect(record?.checkedAt).toBe(NOW.toISOString());
    expect(record?.docs?.added).toBe(1);
  });

  /* ── recordInstructionAssetStatus ───────────────────────────────── */

  it("recordInstructionAssetStatus persists fingerprint to the DB", () => {
    const workspaceDir = join(tmp, "ws-record");
    write(workspaceDir, "agent-assets/agent-profiles/main.md", "# Main\n");
    write(workspaceDir, "agent-assets/skills/inbox/SKILL.md", "---\nname: inbox\n---\n");
    write(workspaceDir, "agent-assets/task-flows/dm.md", "# DM flow\n");

    const status = recordInstructionAssetStatus(db, workspaceDir, () => NOW);
    expect(status.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(status.files).toBeGreaterThanOrEqual(3);

    const record = readReleaseAssetStatus(db);
    expect(record?.instructionAssets?.fingerprint).toBe(status.fingerprint);
    expect(record?.instructionAssets?.files).toBe(status.files);
  });

  /* ── recordSkillAssetStatus ──────────────────────────────────────── */

  it("recordSkillAssetStatus detects shadowed user skills and persists to the DB", () => {
    const dataDir = join(tmp, "data-skills");
    const workspaceDir = join(tmp, "ws-skills");
    write(dataDir, "skills/mail/SKILL.md", "---\nname: mail\n---\n");
    write(workspaceDir, "agent-assets/skills/mail/SKILL.md", "---\nname: mail\n---\n");
    write(workspaceDir, "agent-assets/skills/calendar/SKILL.md", "---\nname: calendar\n---\n");

    const status = recordSkillAssetStatus(db, dataDir, workspaceDir, () => NOW);
    expect(status.builtinShadowedUserSkills).toEqual(["mail"]);

    const record = readReleaseAssetStatus(db);
    expect(record?.skills?.builtinShadowedUserSkills).toEqual(["mail"]);
  });

  /* ── computeInstructionAssetStatus — cache hit ───────────────────── */

  it("computeInstructionAssetStatus returns the cached object on a second call with the same workspace", () => {
    const workspaceDir = join(tmp, "ws-cache");
    write(workspaceDir, "agent-assets/agent-profiles/agent.md", "# Agent\n");

    const first = computeInstructionAssetStatus(workspaceDir, () => NOW);
    const second = computeInstructionAssetStatus(workspaceDir, () => NOW);
    // Same object reference — the cache branch at line ~494 returns early.
    expect(first).toBe(second);
  });

  /* ── readInstructionAssetStamp — error paths ─────────────────────── */

  it("readInstructionAssetStamp returns null for malformed JSON in the stamp file", () => {
    const sessionDir = join(tmp, "sess-badjson");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, INSTRUCTION_ASSETS_STAMP), "{not-valid-json", "utf-8");
    expect(readInstructionAssetStamp(sessionDir)).toBeNull();
  });

  it("readInstructionAssetStamp returns null when fingerprint value is not a string", () => {
    const sessionDir = join(tmp, "sess-wrongtype");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, INSTRUCTION_ASSETS_STAMP),
      JSON.stringify({ fingerprint: 42 }),
      "utf-8",
    );
    expect(readInstructionAssetStamp(sessionDir)).toBeNull();
  });

  /* ── sessionInstructionAssetsStale — nonexistent session dir ─────── */

  it("sessionInstructionAssetsStale returns false when sessionDir does not exist", () => {
    const workspaceDir = join(tmp, "ws-stale");
    write(workspaceDir, "agent-assets/agent-profiles/a.md", "# A\n");
    const missingSession = join(tmp, "no-such-session-XYZ");
    expect(sessionInstructionAssetsStale(missingSession, workspaceDir)).toBe(false);
  });

  /* ── reconcileDocsCorpus — additional branch coverage ───────────── */

  it("reports source_missing error when sourceDir does not exist", () => {
    const source = join(tmp, "nonexistent-source-docs");
    const target = join(tmp, "tgt-src-missing");
    const status = reconcileDocsCorpus({
      db,
      sourceDir: source,
      targetDir: target,
      now: () => NOW,
    });
    expect(status.added).toBe(0);
    expect(status.errors).toHaveLength(1);
    expect(status.errors[0].reason).toBe("write_failed");
    expect(status.errors[0].detail).toBe("source_missing");
  });

  it("reports unknown_base conflict when target exists before any snapshot is recorded", () => {
    // The target file was placed manually before the daemon ever ran reconcile.
    // There is no previous snapshot for this file, so we cannot prove the user
    // hasn't modified it — the file is flagged as unknown_base rather than
    // auto-updated or silently overwritten.
    const source = join(tmp, "src-unknown-base");
    const target = join(tmp, "tgt-unknown-base");
    write(source, "guide.md", "# Source v1\n");
    write(target, "guide.md", "# Pre-existing user content\n");

    const status = reconcileDocsCorpus({
      db,
      sourceDir: source,
      targetDir: target,
      now: () => NOW,
    });

    expect(status.conflicts).toEqual([
      expect.objectContaining({ path: "guide.md", reason: "unknown_base" }),
    ]);
    // The pre-existing user content must survive.
    expect(read(target, "guide.md")).toContain("Pre-existing user content");
  });

  it("reports removedFromSource for files present in the previous snapshot but absent from the current source", () => {
    const source = join(tmp, "src-removed");
    const target = join(tmp, "tgt-removed");
    write(source, "docs/keep.md", "# Keep\n");
    write(source, "docs/gone.md", "# Gone\n");
    reconcileDocsCorpus({ db, sourceDir: source, targetDir: target, now: () => NOW });

    // Remove one file from the source — simulates a doc being deleted in a new release.
    rmSync(join(source, "docs/gone.md"));
    const status = reconcileDocsCorpus({ db, sourceDir: source, targetDir: target, now: () => NOW });

    expect(status.removedFromSource).toContain("docs/gone.md");
    // The target copy should still exist (daemon never auto-deletes user docs).
    expect(existsSync(join(target, "docs/gone.md"))).toBe(true);
  });

  it("auto-updates docs without a backupRoot (backupExistingFile returns null branch)", () => {
    const source = join(tmp, "src-nobackup");
    const target = join(tmp, "tgt-nobackup");
    write(source, "ref.md", "# Ref v1\n");
    reconcileDocsCorpus({ db, sourceDir: source, targetDir: target, now: () => NOW });

    write(source, "ref.md", "# Ref v2\n");
    const status = reconcileDocsCorpus({
      db,
      sourceDir: source,
      targetDir: target,
      // No backupRoot — backupExistingFile must return null without throwing.
      now: () => NOW,
    });

    expect(status.autoUpdated).toBe(1);
    expect(read(target, "ref.md")).toContain("# Ref v2");
  });

  it("records a write_failed error when copying a new doc file fails", () => {
    // Skip on root — chmod restrictions don't apply.
    if (process.getuid?.() === 0) return;

    const source = join(tmp, "src-copy-fail");
    const target = join(tmp, "tgt-copy-fail");
    write(source, "sub/new.md", "# New\n");
    // Create targetDir now so reconcileDocsCorpus's mkdirSync is a no-op, then
    // lock it so the sub-directory cannot be created during copy.
    mkdirSync(target, { recursive: true });
    chmodSync(target, 0o555);

    let status;
    try {
      status = reconcileDocsCorpus({ db, sourceDir: source, targetDir: target, now: () => NOW });
    } finally {
      chmodSync(target, 0o700);
    }

    expect(status!.errors.length).toBeGreaterThanOrEqual(1);
    expect(status!.errors[0].reason).toBe("write_failed");
  });

  /* ── reconcileTemplateAssets — additional branch coverage ─────────── */

  it("returns an empty status when templatesRoot is null (no template dir configured)", () => {
    const status = reconcileTemplateAssets({
      db,
      templatesRoot: null,
      contextDir: join(tmp, "ctx-null-root"),
      now: () => NOW,
    });
    expect(status.added).toBe(0);
    expect(status.pending).toEqual([]);
    expect(status.errors).toEqual([]);
    expect(status.sourceRoot).toBeNull();
    // pending upgrades table must be cleared.
    const record = readReleaseAssetStatus(db);
    expect(record?.templates?.pending).toEqual([]);
  });

  it("returns manifest_missing error when the templates dir has no _manifest.json", () => {
    const templates = join(tmp, "tpl-no-manifest");
    mkdirSync(templates, { recursive: true });
    const status = reconcileTemplateAssets({
      db,
      templatesRoot: templates,
      contextDir: join(tmp, "ctx-no-manifest"),
      now: () => NOW,
    });
    expect(status.errors).toHaveLength(1);
    expect(status.errors[0].detail).toBe("manifest_missing_or_malformed");
  });

  it("records path_outside_root for an absolute manifest key (normalizeRelPath isAbsolute branch)", () => {
    // readTemplateManifest validates `..` traversal but not absolute paths.
    // An absolute key passes the manifest parser and is caught later by
    // resolveInside → normalizeRelPath (isAbsolute → return null, line ~142).
    const templates = join(tmp, "tpl-abs-escape");
    write(
      templates,
      "_manifest.json",
      JSON.stringify({ manifestVersion: 1, templates: { "/etc/shadow": { version: 1 } } }),
    );
    const status = reconcileTemplateAssets({
      db,
      templatesRoot: templates,
      contextDir: join(tmp, "ctx-abs-escape"),
      now: () => NOW,
    });
    expect(status.errors).toHaveLength(1);
    expect(status.errors[0].detail).toBe("path_outside_root");
  });

  it("records path_outside_root for a manifest key with a dot segment (normalizeRelPath parts.some branch, lines 145-146)", () => {
    // A path like "a/./b.md" has no `..` (passes readTemplateManifest's check)
    // but contains a `.` segment. normalizeRelPath's parts.some() guard fires
    // and returns null, which propagates to a path_outside_root error.
    const templates = join(tmp, "tpl-dot-escape");
    write(
      templates,
      "_manifest.json",
      JSON.stringify({ manifestVersion: 1, templates: { "a/./b.md": { version: 1 } } }),
    );
    const status = reconcileTemplateAssets({
      db,
      templatesRoot: templates,
      contextDir: join(tmp, "ctx-dot-escape"),
      now: () => NOW,
    });
    expect(status.errors).toHaveLength(1);
    expect(status.errors[0].detail).toBe("path_outside_root");
  });

  it("records path_outside_root in the docs reconcile loop when resolveInside returns null for the target (lines 279-281)", () => {
    // The `!src || !dst` guard in reconcileDocsCorpus is dead code under a
    // standard FS — path.resolve never returns a traversal path from a valid
    // relative input. We use mockReturnValueOnce to simulate a platform where
    // path.relative disagrees with path.resolve (defense-in-depth path).
    //
    // Call sequence within reconcileDocsCorpus for one file "guide.md":
    //   call 1 — resolveInside(sourceDir, "guide.md") → relative(sourceDir, abs) → "guide.md" (pass)
    //   call 2 — resolveInside(targetDir, "guide.md") → relative(targetDir, abs) → ".." (fail → dst=null)
    const source = join(tmp, "src-dead-docs");
    const target = join(tmp, "tgt-dead-docs");
    write(source, "guide.md", "# Guide\n");
    const { join: pjoin } = nodePath;
    vi.mocked(nodePath.relative)
      .mockReturnValueOnce("guide.md") // call 1 — src check passes
      .mockReturnValueOnce("..");       // call 2 — dst check triggers !dst
    const status = reconcileDocsCorpus({
      db,
      sourceDir: source,
      targetDir: target,
      now: () => NOW,
    });
    expect(pjoin).toBeDefined(); // dummy use to suppress unused-import lint
    expect(status.errors).toHaveLength(1);
    expect(status.errors[0].detail).toBe("path_outside_root");
  });

  it("records a source_missing error when a manifest entry's source file is absent", () => {
    const templates = join(tmp, "tpl-src-missing");
    write(
      templates,
      "_manifest.json",
      JSON.stringify({ manifestVersion: 1, templates: { "ghost.md": { version: 1 } } }),
    );
    // ghost.md is in the manifest but NOT written to disk.
    const status = reconcileTemplateAssets({
      db,
      templatesRoot: templates,
      contextDir: join(tmp, "ctx-src-missing"),
      now: () => NOW,
    });
    expect(status.errors).toHaveLength(1);
    expect(status.errors[0].detail).toBe("source_missing");
  });

  it("counts a context file as unchanged when it has no template_version frontmatter", () => {
    // A file without `template_version:` in its YAML frontmatter cannot be
    // compared to the manifest version — the daemon treats it as unchanged to
    // avoid clobbering user-rewritten files.
    const templates = join(tmp, "tpl-no-ver");
    const context = join(tmp, "ctx-no-ver");
    write(
      templates,
      "_manifest.json",
      JSON.stringify({ manifestVersion: 1, templates: { "rules/x.md": { version: 2 } } }),
    );
    write(templates, "rules/x.md", "---\ntemplate_version: 2\n---\n# X v2\n");
    // Target file exists but has NO template_version field.
    write(context, "rules/x.md", "# User rewrite — no frontmatter version\n");

    const status = reconcileTemplateAssets({
      db,
      templatesRoot: templates,
      contextDir: context,
      now: () => NOW,
    });
    expect(status.unchanged).toBe(1);
    expect(status.conflicts).toEqual([]);
    // User file must be preserved verbatim.
    expect(read(context, "rules/x.md")).toContain("User rewrite");
  });

  it("reports unknown_base conflict when target has an old version but no previous snapshot exists", () => {
    const templates = join(tmp, "tpl-unknown-base");
    const context = join(tmp, "ctx-unknown-base");
    write(
      templates,
      "_manifest.json",
      JSON.stringify({ manifestVersion: 1, templates: { "rules/y.md": { version: 2 } } }),
    );
    write(templates, "rules/y.md", "---\ntemplate_version: 2\n---\n# Y v2\n");
    // Manually place a target file at version 1 — no reconcile has ever run,
    // so there is no snapshot for this file.
    write(context, "rules/y.md", "---\ntemplate_version: 1\n---\n# Y v1\n");

    const status = reconcileTemplateAssets({
      db,
      templatesRoot: templates,
      contextDir: context,
      now: () => NOW,
    });

    expect(status.conflicts).toHaveLength(1);
    expect(status.conflicts[0]).toMatchObject({
      path: "rules/y.md",
      reason: "unknown_base",
      from: 1,
      to: 2,
    });
    expect(status.pending).toHaveLength(1);
    // Target must be preserved unchanged.
    expect(read(context, "rules/y.md")).toContain("Y v1");
  });

  it("reconcileDocsCorpus uses real Date when now is omitted (covers ?? new Date() fallback at lines 125 and 251)", () => {
    const source = join(tmp, "src-no-now");
    const target = join(tmp, "tgt-no-now");
    write(source, "guide.md", "# Guide\n");
    // Omitting `now` exercises the `options.now?.() ?? new Date()` fallback.
    const status = reconcileDocsCorpus({ db, sourceDir: source, targetDir: target });
    expect(status.added).toBe(1);
    expect(status.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("reconcileTemplateAssets uses real Date when now is omitted (covers ?? new Date() fallback at lines 125 and 362)", () => {
    const templates = join(tmp, "tpl-no-now");
    const context = join(tmp, "ctx-no-now");
    write(
      templates,
      "_manifest.json",
      JSON.stringify({ manifestVersion: 1, templates: { "x.md": { version: 1 } } }),
    );
    write(templates, "x.md", "---\ntemplate_version: 1\n---\n# X\n");
    // Omitting `now` exercises the `options.now?.() ?? new Date()` fallback.
    const status = reconcileTemplateAssets({ db, templatesRoot: templates, contextDir: context });
    expect(status.added).toBe(1);
    expect(status.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("listFiles skips non-regular, non-directory entries (e.g. symlinks) in the source dir (line 170 branch)", () => {
    const source = join(tmp, "src-symlink");
    const target = join(tmp, "tgt-symlink");
    write(source, "real.md", "# Real\n");
    // A symlink's dirent returns isDirectory()=false AND isFile()=false, which
    // triggers the `if (!entry.isFile()) continue` branch.
    symlinkSync(join(source, "real.md"), join(source, "link.md"));

    const status = reconcileDocsCorpus({ db, sourceDir: source, targetDir: target, now: () => NOW });
    expect(status.added).toBe(1);
    expect(read(target, "real.md")).toContain("# Real");
    expect(existsSync(join(target, "link.md"))).toBe(false);
  });

  it("records a write_failed error when copying a new template file fails", () => {
    // Skip on root — chmod restrictions don't apply.
    if (process.getuid?.() === 0) return;

    const templates = join(tmp, "tpl-write-fail");
    const context = join(tmp, "ctx-write-fail");
    write(
      templates,
      "_manifest.json",
      JSON.stringify({ manifestVersion: 1, templates: { "sub/t.md": { version: 1 } } }),
    );
    write(templates, "sub/t.md", "---\ntemplate_version: 1\n---\n# T\n");
    mkdirSync(context, { recursive: true });
    // Lock contextDir so the sub-directory cannot be created during copy.
    chmodSync(context, 0o555);

    let status;
    try {
      status = reconcileTemplateAssets({
        db,
        templatesRoot: templates,
        contextDir: context,
        now: () => NOW,
      });
    } finally {
      chmodSync(context, 0o700);
    }

    expect(status!.errors.length).toBeGreaterThanOrEqual(1);
    expect(status!.errors[0].reason).toBe("write_failed");
  });
});
