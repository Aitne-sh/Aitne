import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applySchema } from "../db/schema.js";
import {
  createRepository,
  type RepositoryDTO,
} from "../db/repositories-store.js";
import {
  ARCHITECTURE_MARKERS,
  enqueueArchitectureRefresh,
  findInFlightArchitectureRefresh,
  mergeArchitectureSection,
  runRepositoryArchitectureSectionReplace,
  runRepositoryManagementInit,
  runRepositoryManagementScan,
  STUCK_ARCHITECTURE_REFRESH_THRESHOLD_MS,
  validateArchitectureMarkdown,
} from "./repository-management-docs.js";

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("repository-management-docs", () => {
  let db: Database.Database;
  let root: string;
  let repoDir: string;
  let contextDir: string;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    root = mkdtempSync(join(tmpdir(), "pa-repo-management-docs-"));
    repoDir = join(root, "repo");
    contextDir = join(root, "context");
    mkdirSync(repoDir, { recursive: true });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test User"]);
    git(["config", "commit.gpgsign", "false"]);
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  function git(args: string[], cwd = repoDir, env?: NodeJS.ProcessEnv): string {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
  }

  function commitFile(
    file: string,
    body: string,
    message: string,
    isoDate: string,
  ): void {
    writeFileSync(join(repoDir, file), body, "utf-8");
    git(["add", file]);
    git(["commit", "-q", "-m", message], repoDir, {
      GIT_AUTHOR_DATE: isoDate,
      GIT_COMMITTER_DATE: isoDate,
    });
  }

  function createRepoRow(): RepositoryDTO {
    return createRepository(db, {
      githubOwner: "acme",
      githubRepo: "widgets",
      localPath: repoDir,
      displayName: "Widgets",
      classification: "project",
      category: "work",
    });
  }

  it("init writes a deterministic overview from git evidence", () => {
    commitFile("README.md", "# Widgets\n\nUseful repo.\n", "Initial commit", "2026-05-06T12:00:00Z");
    const repo = createRepoRow();

    const result = runRepositoryManagementInit({
      db,
      repo,
      contextDir,
      now: new Date("2026-05-07T18:00:00Z"),
    });

    expect(result.status).toBe("written");
    expect(result.readmeCopiedTo).toBe("knowledge/repos/widgets/README.md");
    const content = readFileSync(join(contextDir, "knowledge/repos/widgets/overview.md"), "utf-8");
    expect(content).toContain("type: git-project");
    expect(content).toContain("repository_id: \"github:acme/widgets\"");
    expect(content).toContain("architecture_status: pending");
    expect(content).toContain("architecture_refreshed_at: null");
    expect(content).toContain("Initial commit");
    expect(content).toContain("[README.md](./README.md)");
    expect(content).toContain(ARCHITECTURE_MARKERS.begin);
    expect(content).toContain(ARCHITECTURE_MARKERS.end);
    expect(content).toContain(ARCHITECTURE_MARKERS.placeholder);
    expect(content).not.toContain("README excerpt:");

    // Mechanical README copy lands at the slug directory.
    const readmeMirror = readFileSync(join(contextDir, "knowledge/repos/widgets/README.md"), "utf-8");
    expect(readmeMirror).toBe("# Widgets\n\nUseful repo.\n");

    const second = runRepositoryManagementInit({
      db,
      repo,
      contextDir,
      now: new Date("2026-05-07T18:00:00Z"),
    });
    expect(second.status).toBe("exists");
    // README copy is re-run on subsequent inits so the mirror tracks
    // the source even when the overview already exists.
    expect(second.readmeCopiedTo).toBe("knowledge/repos/widgets/README.md");
  });

  it("init handles an empty git history", () => {
    writeFileSync(join(repoDir, "README.md"), "# Widgets\n\nNo commits yet.\n", "utf-8");
    const repo = createRepoRow();

    const result = runRepositoryManagementInit({
      db,
      repo,
      contextDir,
      now: new Date("2026-05-07T18:00:00Z"),
    });

    expect(result.status).toBe("written");
    const content = readFileSync(join(contextDir, "knowledge/repos/widgets/overview.md"), "utf-8");
    expect(content).toContain("First commit: unknown");
    expect(content).toContain("No commits found in the sampled history.");
  });

  it("scan writes today's journal and appends the overview daily log", async () => {
    commitFile("README.md", "# Widgets\n", "Initial commit", "2026-05-07T10:00:00Z");
    commitFile("feature.txt", "feature\n", "Add feature", "2026-05-07T11:00:00Z");
    const repo = createRepoRow();
    runRepositoryManagementInit({
      db,
      repo,
      contextDir,
      now: new Date("2026-05-07T18:00:00Z"),
    });

    const result = await runRepositoryManagementScan({
      db,
      repo,
      contextDir,
      now: new Date("2026-05-07T18:00:00Z"),
    });

    expect(result.status).toBe("written");
    expect(result.commitCount).toBe(2);
    const journal = readFileSync(
      join(contextDir, "journal/repos/widgets/2026-05-07.md"),
      "utf-8",
    );
    expect(journal).toContain("type: git-journal");
    expect(journal).toContain("Add feature");
    expect(journal).toContain("feature.txt");
    const overview = readFileSync(join(contextDir, "knowledge/repos/widgets/overview.md"), "utf-8");
    expect(overview).toContain("2026-05-07: 2 commits");
    const snapshots = db
      .prepare("SELECT COUNT(*) AS count FROM md_file_snapshots")
      .get() as { count: number };
    expect(snapshots.count).toBeGreaterThan(0);
  });

  it("scan writes observation-only activity when git history is empty", async () => {
    const repo = createRepoRow();
    db.prepare(
      `INSERT INTO observations
         (source, ref, change_type, actor, observed_at, payload, summary_text, summary_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "github:notification:acme/widgets",
      "pull/1",
      "modified",
      "system",
      "2026-05-07 12:00:00",
      JSON.stringify({ title: "Review requested" }),
      "Review requested",
      "done",
    );

    const result = await runRepositoryManagementScan({
      db,
      repo,
      contextDir,
      now: new Date("2026-05-07T18:00:00Z"),
    });

    expect(result.status).toBe("written");
    expect(result.commitCount).toBe(0);
    expect(result.prEvents).toBe(1);
    const journal = readFileSync(
      join(contextDir, "journal/repos/widgets/2026-05-07.md"),
      "utf-8",
    );
    expect(journal).toContain("No commits in the lookback window.");
    expect(journal).toContain("Review requested");
  });

  it("scan skips without writing when there is no activity in the lookback window", async () => {
    commitFile("README.md", "# Widgets\n", "Old commit", "2026-05-01T10:00:00Z");
    const repo = createRepoRow();

    const result = await runRepositoryManagementScan({
      db,
      repo,
      contextDir,
      now: new Date("2026-05-07T18:00:00Z"),
    });

    expect(result.status).toBe("skipped_no_activity");
    expect(existsSync(join(contextDir, "journal/repos/widgets/2026-05-07.md"))).toBe(false);
  });

  describe("architecture section replace", () => {
    it("rewrites the marker block while preserving other sections", async () => {
      commitFile("README.md", "# Widgets\n", "Initial commit", "2026-05-06T12:00:00Z");
      const repo = createRepoRow();
      runRepositoryManagementInit({
        db,
        repo,
        contextDir,
        now: new Date("2026-05-07T18:00:00Z"),
      });
      await runRepositoryManagementScan({
        db,
        repo,
        contextDir,
        now: new Date("2026-05-07T18:00:00Z"),
      });

      const result = await runRepositoryArchitectureSectionReplace(
        {
          db,
          repo,
          contextDir,
          now: new Date("2026-05-07T19:00:00Z"),
        },
        "### Modules\n\n- `packages/widget`: core widget runtime.\n- `packages/cli`: thin CLI wrapper.\n",
      );

      expect(result.status).toBe("written");
      const content = readFileSync(join(contextDir, "knowledge/repos/widgets/overview.md"), "utf-8");
      // Architecture content replaced.
      expect(content).toContain("### Modules");
      expect(content).toContain("packages/widget");
      expect(content).not.toContain(ARCHITECTURE_MARKERS.placeholder);
      // Markers still wrap the section.
      expect(content).toContain(ARCHITECTURE_MARKERS.begin);
      expect(content).toContain(ARCHITECTURE_MARKERS.end);
      // Frontmatter updated.
      expect(content).toContain("architecture_status: complete");
      expect(content).toMatch(/architecture_refreshed_at: "2026-05-07T19:00:00.000Z"/);
      // Other sections preserved.
      expect(content).toContain("## Notable Changes");
      expect(content).toContain("## Daily Activity Log");
      expect(content).toContain("Initial commit");
    });

    it("returns no_overview when overview.md is missing", async () => {
      const repo = createRepoRow();
      const result = await runRepositoryArchitectureSectionReplace(
        {
          db,
          repo,
          contextDir,
          now: new Date("2026-05-07T19:00:00Z"),
        },
        "### Modules\n\n- placeholder\n",
      );
      expect(result.status).toBe("no_overview");
    });

    it("re-injects the markers if a previous version stripped them", async () => {
      commitFile("README.md", "# Widgets\n", "Initial commit", "2026-05-06T12:00:00Z");
      const repo = createRepoRow();
      runRepositoryManagementInit({
        db,
        repo,
        contextDir,
        now: new Date("2026-05-07T18:00:00Z"),
      });
      const overviewPath = join(contextDir, "knowledge/repos/widgets/overview.md");
      const original = readFileSync(overviewPath, "utf-8");
      const stripped = original
        .replace(ARCHITECTURE_MARKERS.begin, "")
        .replace(ARCHITECTURE_MARKERS.end, "");
      writeFileSync(overviewPath, stripped, "utf-8");

      const result = await runRepositoryArchitectureSectionReplace(
        {
          db,
          repo,
          contextDir,
          now: new Date("2026-05-07T19:00:00Z"),
        },
        "### Modules\n\n- recovered\n",
      );
      expect(result.status).toBe("written");
      const content = readFileSync(overviewPath, "utf-8");
      expect(content).toContain(ARCHITECTURE_MARKERS.begin);
      expect(content).toContain(ARCHITECTURE_MARKERS.end);
      expect(content).toContain("recovered");
      expect(content).toContain("## Notable Changes");
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // mergeArchitectureSection is the pure surgical merger; everything
  // above tests the wrapper that wires it through SQLite + the
  // filesystem. These pin the edge cases that the wrapper tests can't
  // economically express — code-fence collisions, CRLF, orphans, and
  // back-to-back headings — directly on the pure function.
  // ──────────────────────────────────────────────────────────────────
  describe("mergeArchitectureSection (pure)", () => {
    const BEGIN = ARCHITECTURE_MARKERS.begin;
    const END = ARCHITECTURE_MARKERS.end;
    const NEW_BODY = "### Modules\n\n- one\n- two";

    it("replaces the marker-bracketed block when markers are well-formed", () => {
      const current = [
        "# Repo",
        "",
        "## Summary",
        "",
        "- one line",
        "",
        "## Architecture",
        "",
        BEGIN,
        "",
        "old body",
        "",
        END,
        "",
        "## Notable Changes",
        "",
        "- changelog",
        "",
      ].join("\n");
      const out = mergeArchitectureSection(current, NEW_BODY);
      expect(out).toContain("### Modules");
      expect(out).not.toContain("old body");
      expect(out).toContain("## Summary");
      expect(out).toContain("- one line");
      expect(out).toContain("## Notable Changes");
      expect(out).toContain("- changelog");
      // Exactly one of each marker survives.
      expect((out.match(new RegExp(escapeForRegex(BEGIN), "g")) ?? []).length).toBe(1);
      expect((out.match(new RegExp(escapeForRegex(END), "g")) ?? []).length).toBe(1);
    });

    it("ignores marker occurrences INSIDE a fenced code block (the regression)", () => {
      // Concretely: a Summary section that documents the marker contract
      // with a code-fence example would have previously caused the
      // merger to slice from the fence's `:start` to the real `:end`,
      // obliterating the real `## Architecture` body AND every section
      // in between (Summary tail + Architecture).
      const current = [
        "# Repo",
        "",
        "## Summary",
        "",
        "Block layout:",
        "",
        "```markdown",
        BEGIN,
        "(example only, not the real block)",
        END,
        "```",
        "",
        "## Architecture",
        "",
        BEGIN,
        "",
        "real body to replace",
        "",
        END,
        "",
        "## Notable Changes",
        "",
        "- changelog",
        "",
      ].join("\n");
      const out = mergeArchitectureSection(current, NEW_BODY);
      // The example fence content is preserved verbatim.
      expect(out).toContain("(example only, not the real block)");
      // The real body is gone, replaced by the new content.
      expect(out).not.toContain("real body to replace");
      expect(out).toContain("### Modules");
      // Summary tail and Notable Changes are intact — this is the
      // bug we are pinning.
      expect(out).toContain("Block layout:");
      expect(out).toContain("## Notable Changes");
      expect(out).toContain("- changelog");
    });

    it("ignores markers inside a tilde-fenced code block (~~~ as well as ```)", () => {
      const current = [
        "# Repo",
        "",
        "## Summary",
        "",
        "~~~markdown",
        BEGIN,
        "(example inside tildes)",
        END,
        "~~~",
        "",
        "## Architecture",
        "",
        BEGIN,
        "real body",
        END,
        "",
        "## Notable Changes",
        "",
      ].join("\n");
      const out = mergeArchitectureSection(current, NEW_BODY);
      expect(out).toContain("(example inside tildes)");
      expect(out).not.toContain("real body");
      expect(out).toContain("### Modules");
      expect(out).toContain("## Notable Changes");
    });

    it("preserves CRLF line endings end-to-end", () => {
      const lfBody = [
        "# Repo",
        "",
        "## Architecture",
        "",
        BEGIN,
        "",
        "old body",
        "",
        END,
        "",
        "## Notable Changes",
        "",
      ].join("\n");
      const crlfBody = lfBody.replace(/\n/g, "\r\n");
      const out = mergeArchitectureSection(crlfBody, NEW_BODY);
      expect(out.includes("\r\n")).toBe(true);
      expect(out.includes("### Modules")).toBe(true);
      expect(out.includes("## Notable Changes")).toBe(true);
      // No bare LF leaked into the CRLF output.
      const bareLf = out.match(/(?<!\r)\n/g);
      expect(bareLf).toBe(null);
    });

    it("tolerates `## Architecture ` with a trailing space (regression)", () => {
      const current = [
        "# Repo",
        "",
        "## Architecture ", // <-- trailing space — the old literal indexOf missed this
        "",
        "(orphan body, no markers)",
        "",
        "## Notable Changes",
        "",
      ].join("\n");
      const out = mergeArchitectureSection(current, NEW_BODY);
      // A fresh marker-bracketed block lands under the heading; the
      // pre-existing orphan body is replaced.
      expect(out).toContain(BEGIN);
      expect(out).toContain(END);
      expect(out).toContain("### Modules");
      expect(out).toContain("## Notable Changes");
    });

    it("heals an orphan `:start` marker by stripping it before re-injecting", () => {
      const current = [
        "# Repo",
        "",
        "## Architecture",
        "",
        BEGIN,
        "leftover body without an end marker",
        "",
        "## Notable Changes",
        "",
      ].join("\n");
      const out = mergeArchitectureSection(current, NEW_BODY);
      // Exactly one `:start` and one `:end` in the result.
      expect((out.match(new RegExp(escapeForRegex(BEGIN), "g")) ?? []).length).toBe(1);
      expect((out.match(new RegExp(escapeForRegex(END), "g")) ?? []).length).toBe(1);
      expect(out).toContain("### Modules");
      expect(out).toContain("## Notable Changes");
    });

    it("heals an orphan `:end` marker similarly", () => {
      const current = [
        "# Repo",
        "",
        "## Architecture",
        "",
        "leftover body",
        "",
        END,
        "",
        "## Notable Changes",
        "",
      ].join("\n");
      const out = mergeArchitectureSection(current, NEW_BODY);
      expect((out.match(new RegExp(escapeForRegex(BEGIN), "g")) ?? []).length).toBe(1);
      expect((out.match(new RegExp(escapeForRegex(END), "g")) ?? []).length).toBe(1);
      expect(out).toContain("### Modules");
      expect(out).toContain("## Notable Changes");
    });

    it("heals markers that are out of order (`end` appears before `start`)", () => {
      const current = [
        "# Repo",
        "",
        "## Architecture",
        "",
        END,           // wrong order
        "stray text",
        BEGIN,
        "",
        "## Notable Changes",
        "",
      ].join("\n");
      const out = mergeArchitectureSection(current, NEW_BODY);
      // Both orphans stripped; clean block re-injected.
      expect((out.match(new RegExp(escapeForRegex(BEGIN), "g")) ?? []).length).toBe(1);
      expect((out.match(new RegExp(escapeForRegex(END), "g")) ?? []).length).toBe(1);
      expect(out).toContain("### Modules");
      expect(out).toContain("## Notable Changes");
    });

    it("appends a new section before `## Notable Changes` when no Architecture heading exists", () => {
      const current = [
        "# Repo",
        "",
        "## Summary",
        "",
        "- only summary",
        "",
        "## Notable Changes",
        "",
        "- changelog",
        "",
      ].join("\n");
      const out = mergeArchitectureSection(current, NEW_BODY);
      // A new `## Architecture` block is planted before Notable Changes.
      const archIdx = out.indexOf("## Architecture");
      const notableIdx = out.indexOf("## Notable Changes");
      expect(archIdx).toBeGreaterThan(-1);
      expect(notableIdx).toBeGreaterThan(archIdx);
      expect(out).toContain("### Modules");
      expect(out).toContain("- only summary");
      expect(out).toContain("- changelog");
    });

    it("appends a new section at EOF when neither Architecture nor Notable Changes exists", () => {
      const current = "# Repo\n\n## Summary\n\n- only summary\n";
      const out = mergeArchitectureSection(current, NEW_BODY);
      expect(out).toMatch(/## Summary\n\n- only summary\n[\s\S]*## Architecture/);
      expect(out).toContain("### Modules");
    });
  });

  describe("validateArchitectureMarkdown", () => {
    it("rejects non-string and empty bodies", () => {
      expect(validateArchitectureMarkdown(undefined)).toMatchObject({
        ok: false,
        error: "validation_error",
      });
      expect(validateArchitectureMarkdown("")).toMatchObject({
        ok: false,
        error: "validation_error",
      });
      expect(validateArchitectureMarkdown("   \n   ")).toMatchObject({
        ok: false,
        error: "validation_error",
      });
    });

    it("rejects bodies that smuggle the architecture markers", () => {
      const smuggled = `### x\n\n${ARCHITECTURE_MARKERS.end}\nsneak`;
      expect(validateArchitectureMarkdown(smuggled)).toMatchObject({
        ok: false,
        error: "validation_error",
      });
    });

    it("rejects bodies that exceed the size cap", () => {
      // 64 KiB cap — pad with ascii so byte length === char length.
      const large = "a".repeat(64 * 1024 + 1);
      expect(validateArchitectureMarkdown(large)).toMatchObject({
        ok: false,
        error: "payload_too_large",
      });
    });

    it("accepts a normal body and returns the trimmed text", () => {
      const result = validateArchitectureMarkdown("  ### Modules\n- ok  ");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.body).toBe("### Modules\n- ok");
      }
    });
  });

  describe("findInFlightArchitectureRefresh stuck-row rescue", () => {
    it("rescues a pending row older than the threshold and returns null", () => {
      const repo = createRepoRow();
      const stale = new Date("2026-05-07T06:00:00Z");
      const now = new Date("2026-05-07T08:00:00Z"); // >60 minutes later
      const enq = enqueueArchitectureRefresh(db, repo, stale);

      const result = findInFlightArchitectureRefresh(db, repo.id, now);

      expect(result).toBeNull();
      const row = db
        .prepare("SELECT status FROM agent_schedule WHERE id = ?")
        .get(enq.scheduleId) as { status: string };
      expect(row.status).toBe("skipped");
    });

    it("rescues a running row older than the threshold and returns null", () => {
      const repo = createRepoRow();
      const stale = new Date("2026-05-07T06:00:00Z");
      const now = new Date("2026-05-07T08:00:00Z");
      const enq = enqueueArchitectureRefresh(db, repo, stale);
      db.prepare("UPDATE agent_schedule SET status = 'running' WHERE id = ?")
        .run(enq.scheduleId);

      const result = findInFlightArchitectureRefresh(db, repo.id, now);

      expect(result).toBeNull();
      const row = db
        .prepare("SELECT status FROM agent_schedule WHERE id = ?")
        .get(enq.scheduleId) as { status: string };
      expect(row.status).toBe("skipped");
    });

    it("keeps a fresh pending row visible (no rescue, returns the row)", () => {
      const repo = createRepoRow();
      const fresh = new Date("2026-05-07T07:30:00Z");
      const now = new Date("2026-05-07T08:00:00Z"); // 30 minutes later — under threshold
      const enq = enqueueArchitectureRefresh(db, repo, fresh);

      const result = findInFlightArchitectureRefresh(db, repo.id, now);

      expect(result).not.toBeNull();
      expect(result!.scheduleId).toBe(enq.scheduleId);
      expect(result!.status).toBe("pending");
    });

    it("does not rescue rows for other repositories", () => {
      const repoA = createRepoRow();
      const otherRepoDir = join(root, "repo-other");
      mkdirSync(otherRepoDir, { recursive: true });
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: otherRepoDir });
      const repoB = createRepository(db, {
        githubOwner: "acme",
        githubRepo: "other",
        localPath: otherRepoDir,
        displayName: "Other",
        classification: "project",
        category: "work",
      });
      const stale = new Date("2026-05-07T06:00:00Z");
      const now = new Date("2026-05-07T08:00:00Z");
      const enqA = enqueueArchitectureRefresh(db, repoA, stale);
      const enqB = enqueueArchitectureRefresh(db, repoB, stale);

      findInFlightArchitectureRefresh(db, repoA.id, now);

      const a = db.prepare("SELECT status FROM agent_schedule WHERE id = ?")
        .get(enqA.scheduleId) as { status: string };
      const b = db.prepare("SELECT status FROM agent_schedule WHERE id = ?")
        .get(enqB.scheduleId) as { status: string };
      expect(a.status).toBe("skipped");
      expect(b.status).toBe("pending");
    });

    it("threshold constant is 60 minutes", () => {
      expect(STUCK_ARCHITECTURE_REFRESH_THRESHOLD_MS).toBe(60 * 60 * 1000);
    });
  });

  describe("scan vs architecture-refresh serialization", () => {
    // Both `appendOverviewDailyLog` (inside scan) and
    // `runRepositoryArchitectureSectionReplace` follow read-modify-write
    // on overview.md. The lock guarantees that whichever runs second
    // sees the first's write, so neither operation's modifications can
    // be silently overwritten when concurrent calls land.
    it("interleaved arch-replace + scan preserves both writes", async () => {
      commitFile("README.md", "# Widgets\n", "Initial commit", "2026-05-07T10:00:00Z");
      commitFile("feature.txt", "feature\n", "Add feature", "2026-05-07T11:00:00Z");
      const repo = createRepoRow();
      runRepositoryManagementInit({
        db,
        repo,
        contextDir,
        now: new Date("2026-05-07T18:00:00Z"),
      });

      const archPromise = runRepositoryArchitectureSectionReplace(
        {
          db,
          repo,
          contextDir,
          now: new Date("2026-05-07T18:30:00Z"),
        },
        "### Modules\n\n- locked path keeps both writes coherent\n",
      );
      const scanPromise = runRepositoryManagementScan({
        db,
        repo,
        contextDir,
        now: new Date("2026-05-07T18:31:00Z"),
      });

      const [archResult, scanResult] = await Promise.all([archPromise, scanPromise]);
      expect(archResult.status).toBe("written");
      expect(scanResult.status).toBe("written");

      const overview = readFileSync(join(contextDir, "knowledge/repos/widgets/overview.md"), "utf-8");
      // Architecture body landed.
      expect(overview).toContain("locked path keeps both writes coherent");
      expect(overview).not.toContain(ARCHITECTURE_MARKERS.placeholder);
      // Daily log entry landed.
      expect(overview).toContain("2026-05-07: 2 commits");
      // Frontmatter from arch replace stayed.
      expect(overview).toContain("architecture_status: complete");
    });
  });
});
