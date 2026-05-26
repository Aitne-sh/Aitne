import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../../db/schema.js";
import { readRuntimeState, writeRuntimeState } from "../../db/runtime-state.js";
import { AgentWriteTracker } from "../../safety/agent-write-tracker.js";
import { cleanupInterestsReflection } from "./cleanup-interests-reflection.js";
import {
  InterestsReflectionLockBusyError,
  _resetInterestsReflectionLockForTests,
  acquireInterestsReflectionLock,
} from "./interests-reflection-lock.js";
import {
  RUNTIME_STATE_LAST_RUN_AT_KEY,
  RUNTIME_STATE_LAST_RUN_TARGETS_KEY,
} from "./refresh-interests-reflection.js";

function seedFile(
  dir: string,
  relPath: string,
  contents: string | string[],
): string {
  const full = join(dir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, Array.isArray(contents) ? contents.join("\n") : contents);
  return full;
}

function block(disambiguator: string, body: string): string[] {
  const beginTail = disambiguator ? ` ${disambiguator}` : "";
  const endTail = disambiguator ? ` ${disambiguator}` : "";
  return [
    `<!-- BEGIN aitne:browser-interests v1${beginTail} weekStart=2026-05-19 generatedAt=2026-05-26T00:00:00Z -->`,
    body,
    `<!-- END aitne:browser-interests v1${endTail} -->`,
  ];
}

describe("cleanupInterestsReflection", () => {
  let db: Database.Database;
  let dir: string;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    dir = mkdtempSync(join(tmpdir(), "cir-test-"));
    _resetInterestsReflectionLockForTests();
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    _resetInterestsReflectionLockForTests();
  });

  it("strips blocks from profile.md, _index.md, and projects/*.md", () => {
    seedFile(dir, "identity/profile.md", [
      "---",
      "type: user",
      "owner: user",
      "---",
      "# Profile",
      "",
      "## Identity",
      "User identity.",
      "",
      ...block("", "- **Theme A** — body"),
      "",
    ]);
    seedFile(dir, "identity/_index.md", [
      "---",
      "owner: user",
      "---",
      "# User topic index",
      "",
      "- `expertise.md` — what the user knows",
      "",
      ...block(
        "target=research-themes",
        "- `research-themes.md` — last refreshed 2026-05-26",
      ),
      "",
    ]);
    seedFile(dir, "plans/projects/aitne.md", [
      "---",
      "owner: user",
      "---",
      "# Aitne",
      "",
      ...block("project=aitne", "- **Theme A** — body"),
      "",
    ]);
    seedFile(dir, "plans/projects/no-block.md", [
      "---",
      "owner: user",
      "---",
      "# Plain",
      "",
      "No auto-block here.",
    ]);
    seedFile(dir, "identity/research-themes.md", [
      "---",
      "type: user",
      "owner: aitne-browser-history",
      "---",
      "# Research themes",
    ]);
    // Seed runtime_state markers so cleanup clears them.
    writeRuntimeState(db, RUNTIME_STATE_LAST_RUN_AT_KEY, 1_700_000_000_000);
    writeRuntimeState(db, RUNTIME_STATE_LAST_RUN_TARGETS_KEY, [
      "identity/profile.md",
      "identity/research-themes.md",
    ]);

    const result = cleanupInterestsReflection(db, dir, { trigger: "test" });

    expect(result.blocksRemoved).toBe(3);
    expect(result.researchThemesDeleted).toBe(true);
    expect(result.filesAffected.sort()).toEqual(
      [
        "plans/projects/aitne.md",
        "identity/_index.md",
        "identity/profile.md",
        "identity/research-themes.md",
      ].sort(),
    );

    // Block markers are gone, user-authored content survives.
    const profile = readFileSync(join(dir, "identity/profile.md"), "utf-8");
    expect(profile).not.toContain("aitne:browser-interests");
    expect(profile).toContain("## Identity");
    expect(profile).toContain("User identity.");

    const idx = readFileSync(join(dir, "identity/_index.md"), "utf-8");
    expect(idx).not.toContain("aitne:browser-interests");
    expect(idx).toContain("- `expertise.md` — what the user knows");

    const project = readFileSync(join(dir, "plans/projects/aitne.md"), "utf-8");
    expect(project).not.toContain("aitne:browser-interests");
    expect(project).toContain("# Aitne");

    // research-themes.md was deleted.
    expect(existsSync(join(dir, "identity/research-themes.md"))).toBe(false);

    // no-block.md was untouched.
    const plain = readFileSync(join(dir, "plans/projects/no-block.md"), "utf-8");
    expect(plain).toContain("No auto-block here.");

    // runtime_state markers were cleared.
    expect(readRuntimeState(db, RUNTIME_STATE_LAST_RUN_AT_KEY)).toBeNull();
    expect(readRuntimeState(db, RUNTIME_STATE_LAST_RUN_TARGETS_KEY)).toBeNull();

    // Audit row recorded.
    const audit = db
      .prepare(
        `SELECT result, trigger, source_kind, detail FROM agent_actions
         WHERE action_type = 'browser_interests_reflection_cleanup'`,
      )
      .get() as {
      result: string;
      trigger: string;
      source_kind: string;
      detail: string;
    };
    expect(audit.result).toBe("success");
    expect(audit.trigger).toBe("weekly_interests_cleanup:test");
    expect(audit.source_kind).toBe("manual");
    const detail = JSON.parse(audit.detail);
    expect(detail.blocks_removed).toBe(3);
    expect(detail.research_themes_deleted).toBe(true);
    expect(detail.files_affected).toContain("identity/profile.md");
  });

  it("retains research-themes.md when alsoDeleteResearchThemesFile=false", () => {
    seedFile(dir, "identity/profile.md", [
      "# Profile",
      "",
      ...block("", "- **Theme A**"),
    ]);
    seedFile(dir, "identity/research-themes.md", "# Research themes\n");

    const result = cleanupInterestsReflection(db, dir, {
      alsoDeleteResearchThemesFile: false,
      trigger: "test",
    });

    expect(result.researchThemesDeleted).toBe(false);
    expect(result.blocksRemoved).toBe(1);
    expect(existsSync(join(dir, "identity/research-themes.md"))).toBe(true);
    expect(result.filesAffected).not.toContain("identity/research-themes.md");
  });

  it("is idempotent — a second call returns blocksRemoved=0 with no errors", () => {
    seedFile(dir, "identity/profile.md", [
      "# Profile",
      "",
      ...block("", "- **Theme A**"),
    ]);

    cleanupInterestsReflection(db, dir, { trigger: "test" });
    const second = cleanupInterestsReflection(db, dir, { trigger: "test" });

    expect(second.blocksRemoved).toBe(0);
    expect(second.filesAffected).toEqual([]);
    expect(second.researchThemesDeleted).toBe(false);

    const rows = db
      .prepare(
        `SELECT COUNT(*) AS n FROM agent_actions
         WHERE action_type = 'browser_interests_reflection_cleanup'`,
      )
      .get() as { n: number };
    expect(rows.n).toBe(2);
  });

  it("is a no-op when no auto-blocks and no themes file exist", () => {
    seedFile(dir, "identity/profile.md", "# Profile\n\nNo auto-block.\n");
    seedFile(dir, "identity/_index.md", "# Index\n");
    seedFile(dir, "plans/projects/aitne.md", "# Aitne\n");

    const result = cleanupInterestsReflection(db, dir, { trigger: "test" });

    expect(result.blocksRemoved).toBe(0);
    expect(result.filesAffected).toEqual([]);
    expect(result.researchThemesDeleted).toBe(false);
  });

  it("strips multiple blocks from a single project file", () => {
    // A project file that somehow accreted two blocks with different
    // disambiguators (or one stale + one fresh). Cleanup strips both.
    seedFile(dir, "plans/projects/aitne.md", [
      "---",
      "owner: user",
      "---",
      "# Aitne",
      "",
      ...block("project=aitne", "- **stale A**"),
      "",
      "Some user-authored content in between.",
      "",
      ...block("project=other", "- **stale B**"),
    ]);

    const result = cleanupInterestsReflection(db, dir, { trigger: "test" });
    expect(result.blocksRemoved).toBe(2);

    const after = readFileSync(join(dir, "plans/projects/aitne.md"), "utf-8");
    expect(after).not.toContain("stale A");
    expect(after).not.toContain("stale B");
    expect(after).not.toContain("aitne:browser-interests");
    expect(after).toContain("# Aitne");
    expect(after).toContain("Some user-authored content in between.");
  });

  it("skips projects subdirectories that don't exist", () => {
    // No projects/ directory at all — must not throw.
    seedFile(dir, "identity/profile.md", [
      "# Profile",
      "",
      ...block("", "- **Theme A**"),
    ]);
    const result = cleanupInterestsReflection(db, dir, { trigger: "test" });
    expect(result.blocksRemoved).toBe(1);
  });

  it("does not recurse into projects/ subdirectories", () => {
    seedFile(dir, "plans/projects/aitne.md", [
      "# Aitne",
      "",
      ...block("project=aitne", "- top-level block"),
    ]);
    // Block in a nested project file should NOT be touched — only the
    // matcher writes here, and it never recurses, so the cleanup
    // mirror must match.
    seedFile(dir, "plans/projects/nested/deep.md", [
      "# Deep",
      "",
      ...block("project=deep", "- nested block"),
    ]);

    const result = cleanupInterestsReflection(db, dir, { trigger: "test" });
    expect(result.blocksRemoved).toBe(1);
    expect(
      readFileSync(join(dir, "plans/projects/nested/deep.md"), "utf-8"),
    ).toContain("nested block");
  });

  it("ignores non-.md files inside projects/", () => {
    seedFile(dir, "plans/projects/aitne.md", [
      "# Aitne",
      "",
      ...block("project=aitne", "- the block"),
    ]);
    // .txt and dotfiles must not be opened — verifies the extension
    // filter rather than reaching into adjacent state.
    seedFile(
      dir,
      "projects/notes.txt",
      "<!-- BEGIN aitne:browser-interests v1 -->bogus<!-- END aitne:browser-interests v1 -->",
    );

    const result = cleanupInterestsReflection(db, dir, { trigger: "test" });
    expect(result.blocksRemoved).toBe(1);
    expect(result.filesAffected).toEqual(["plans/projects/aitne.md"]);
    expect(readFileSync(join(dir, "projects/notes.txt"), "utf-8")).toContain(
      "bogus",
    );
  });

  it("preserves disjoint user-authored content in profile.md", () => {
    // A realistic profile.md with every section the testimonial
    // pipeline writes — none of these may be touched by cleanup.
    seedFile(dir, "identity/profile.md", [
      "---",
      "type: user",
      "owner: user",
      "---",
      "# Profile",
      "",
      "## Identity",
      "Author.",
      "",
      "## Work Pattern",
      "Patterns.",
      "",
      "## Expertise",
      "Knows things.",
      "",
      "## Raw Signals",
      "- 2026-05-10 raw thing",
      "",
      "## Learned Context",
      "- 2026-05-09 learned thing",
      "",
      ...block("", "- **Theme** — body"),
    ]);

    cleanupInterestsReflection(db, dir, { trigger: "test" });

    const after = readFileSync(join(dir, "identity/profile.md"), "utf-8");
    for (const heading of [
      "## Identity\nAuthor.",
      "## Work Pattern\nPatterns.",
      "## Expertise\nKnows things.",
      "## Raw Signals\n- 2026-05-10 raw thing",
      "## Learned Context\n- 2026-05-09 learned thing",
    ]) {
      expect(after).toContain(heading);
    }
    expect(after).not.toContain("aitne:browser-interests");
  });

  it("defaults trigger to 'dashboard' when omitted", () => {
    seedFile(dir, "identity/profile.md", [
      "# Profile",
      "",
      ...block("", "- **Theme**"),
    ]);
    cleanupInterestsReflection(db, dir);

    const audit = db
      .prepare(
        `SELECT trigger FROM agent_actions
         WHERE action_type = 'browser_interests_reflection_cleanup'`,
      )
      .get() as { trigger: string };
    expect(audit.trigger).toBe("weekly_interests_cleanup:dashboard");
  });

  it("marks each stripped file (content-hash) and the unlinked themes file (path-only) on the agent-write tracker", () => {
    seedFile(dir, "identity/profile.md", [
      "---",
      "owner: user",
      "---",
      "# Profile",
      "",
      ...block("", "- **Theme**"),
    ]);
    seedFile(dir, "plans/projects/aitne.md", [
      "---",
      "owner: user",
      "---",
      "# Aitne",
      "",
      ...block("project=aitne", "- **Theme**"),
    ]);
    const themesPath = join(dir, "identity/research-themes.md");
    seedFile(dir, "identity/research-themes.md", "# themes\n");

    const writeTracker = new AgentWriteTracker(60_000);
    cleanupInterestsReflection(db, dir, { trigger: "test", writeTracker });

    // Stripped files were marked in content-hash mode — the observer
    // would supply the post-strip bytes when reading off disk.
    for (const rel of ["identity/profile.md", "plans/projects/aitne.md"]) {
      const fullPath = join(dir, rel);
      const bytes = readFileSync(fullPath, "utf-8");
      expect(writeTracker.isMarked(fullPath, bytes)).toBe(true);
    }
    // The deleted research-themes.md was marked path-only — `isMarked`
    // returns true regardless of the content argument the observer
    // supplies (it has no file to read post-unlink).
    expect(writeTracker.isMarked(themesPath, undefined)).toBe(true);
    expect(writeTracker.isMarked(themesPath, null)).toBe(true);
  });

  it("is a structural no-op when writeTracker is omitted", () => {
    // Optional dep contract — tests and direct admin invocations both
    // can pass `undefined`; the helper must not depend on it implicitly.
    seedFile(dir, "identity/profile.md", [
      "# Profile",
      "",
      ...block("", "- **Theme**"),
    ]);
    expect(() =>
      cleanupInterestsReflection(db, dir, { trigger: "test" }),
    ).not.toThrow();
  });

  it("does not throw when the audit-row insert fails", () => {
    seedFile(dir, "identity/profile.md", [
      "# Profile",
      "",
      ...block("", "- **Theme**"),
    ]);
    db.prepare("DROP TABLE agent_actions").run();
    expect(() => cleanupInterestsReflection(db, dir, { trigger: "test" })).not.toThrow();
    expect(readFileSync(join(dir, "identity/profile.md"), "utf-8")).not.toContain(
      "aitne:browser-interests",
    );
  });

  // ──────────────────────────────────────────────────────────────────
  // Defensive I/O catch arms (§10.3.1 — purge must be non-fatal so the
  // operator can recover from a corrupted layout in one shot). Each
  // test below targets exactly one catch branch in the helper.
  // ──────────────────────────────────────────────────────────────────

  it("absorbs a readdirSync failure on projects/ and still strips profile.md / themes", () => {
    // existsSync(projectsDir) → true, readdirSync(projectsDir) → throws.
    // The cheapest way to produce that without mocking node:fs is to
    // create `projects` as a regular file. existsSync is true; readdir
    // raises ENOTDIR. The helper must log + continue.
    seedFile(dir, "identity/profile.md", [
      "# Profile",
      "",
      ...block("", "- **Theme**"),
    ]);
    seedFile(dir, "identity/research-themes.md", "wholly daemon-owned\n");
    seedFile(dir, "projects", "");

    const result = cleanupInterestsReflection(db, dir, { trigger: "test" });

    // profile.md block stripped; themes file deleted; projects/ skipped
    // without throwing.
    expect(result.blocksRemoved).toBe(1);
    expect(result.researchThemesDeleted).toBe(true);
    expect(result.filesAffected).toEqual(
      expect.arrayContaining(["identity/profile.md", "identity/research-themes.md"]),
    );
  });

  it("absorbs an unlinkSync failure on user/research-themes.md", () => {
    // existsSync(themesPath) → true, unlinkSync(themesPath) → throws.
    // Make the path a non-empty directory (existsSync is true; unlink on
    // a directory raises EISDIR / EPERM depending on platform). The
    // helper must roll back the writeTracker mark, log, and return with
    // researchThemesDeleted = false.
    seedFile(dir, "identity/profile.md", [
      "# Profile",
      "",
      ...block("", "- **Theme**"),
    ]);
    mkdirSync(join(dir, "identity", "research-themes.md"), { recursive: true });
    writeFileSync(join(dir, "identity", "research-themes.md", "stub.txt"), "x");

    const tracker = new AgentWriteTracker(5_000);
    const themesPath = join(dir, "identity", "research-themes.md");

    const result = cleanupInterestsReflection(db, dir, {
      trigger: "test",
      writeTracker: tracker,
    });

    expect(result.researchThemesDeleted).toBe(false);
    // The directory we put there is still on disk — the failed unlink
    // didn't remove it. profile.md is still purged regardless.
    expect(existsSync(themesPath)).toBe(true);
    expect(result.blocksRemoved).toBe(1);
    // The mark was rolled back — a subsequent legit user edit on the
    // path must still be observable as user-originated.
    expect(tracker.isMarked(themesPath, undefined)).toBe(false);
  });

  it("absorbs a deleteRuntimeState failure and still completes the file purge", () => {
    seedFile(dir, "identity/profile.md", [
      "# Profile",
      "",
      ...block("", "- **Theme**"),
    ]);
    // Drop the table so deleteRuntimeState throws. The audit emitter
    // and file writes must still succeed.
    db.prepare("DROP TABLE runtime_state").run();

    const result = cleanupInterestsReflection(db, dir, { trigger: "test" });

    expect(result.blocksRemoved).toBe(1);
    expect(readFileSync(join(dir, "identity/profile.md"), "utf-8")).not.toContain(
      "aitne:browser-interests",
    );
  });

  it("skips a target file whose readFileSync throws (path is a directory)", () => {
    // existsSync(profilePath) → true, readFileSync(profilePath, 'utf-8')
    // → EISDIR. The helper must log + return 0 for that target without
    // bringing the purge down.
    mkdirSync(join(dir, "identity", "profile.md"), { recursive: true });
    seedFile(dir, "identity/_index.md", [
      "# Index",
      "",
      ...block("target=research-themes", "- `research-themes.md` — entry"),
    ]);

    const result = cleanupInterestsReflection(db, dir, { trigger: "test" });

    // profile.md was unreadable → returned 0; _index.md still purged.
    expect(result.blocksRemoved).toBe(1);
    expect(result.filesAffected).toEqual(["identity/_index.md"]);
  });

  it("rolls back the writeTracker mark when writeFileAtomically throws on a target", async () => {
    // Force writeFileAtomically to fail by chmod'ing the parent dir
    // read-only — the atomic-write helper's tempfile open in the same
    // dir then errors out (EACCES on a read-only dir). readFileSync of
    // the file itself still succeeds because the file is readable.
    seedFile(dir, "plans/projects/aitne.md", [
      "# Aitne",
      "",
      ...block("project=aitne", "- block to strip"),
    ]);
    const projectsDir = join(dir, "plans", "projects");
    const { chmodSync } = await import("node:fs");
    chmodSync(projectsDir, 0o500); // r-x only, no writes for owner

    const tracker = new AgentWriteTracker(5_000);
    try {
      const result = cleanupInterestsReflection(db, dir, {
        trigger: "test",
        writeTracker: tracker,
      });

      // Strip computed `blocksRemoved=1` from the in-memory pass, but
      // the write failed → the helper returns 0 for that file, so the
      // top-level counter stays at 0.
      expect(result.blocksRemoved).toBe(0);
      expect(result.filesAffected).toEqual([]);
      // The mark was rolled back so a later user edit on the same path
      // is still observable as user-originated.
      const projectPath = join(projectsDir, "aitne.md");
      expect(tracker.isMarked(projectPath, undefined)).toBe(false);
    } finally {
      // Restore permissions so afterEach's rmSync can clean up.
      chmodSync(projectsDir, 0o700);
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // rev 4 — lock contention + explicit metadata column.
  // ──────────────────────────────────────────────────────────────────

  it("throws InterestsReflectionLockBusyError when another caller holds the lock", () => {
    const externalRelease = acquireInterestsReflectionLock("refresh:dashboard");
    try {
      expect(() =>
        cleanupInterestsReflection(db, dir, { trigger: "test" }),
      ).toThrow(InterestsReflectionLockBusyError);
    } finally {
      externalRelease();
    }
  });

  it("releases the lock in finally even when no work happens", () => {
    // No files seeded; cleanup is a structural no-op. Lock MUST still
    // release — without it the next reflection caller would deadlock.
    cleanupInterestsReflection(db, dir, { trigger: "test" });
    const release = acquireInterestsReflectionLock("post-cleanup:test");
    release();
  });

  it("passes explicit metadata='{}' to the audit insert (rev 4 — documents the empty side-channel)", () => {
    seedFile(dir, "identity/profile.md", [
      "# Profile",
      "",
      ...block("", "- **Theme**"),
    ]);
    cleanupInterestsReflection(db, dir, { trigger: "test" });
    const row = db
      .prepare(
        `SELECT metadata FROM agent_actions
         WHERE action_type = 'browser_interests_reflection_cleanup'`,
      )
      .get() as { metadata: string };
    expect(row.metadata).toBe("{}");
  });
});
