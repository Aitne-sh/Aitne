import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { applySchema } from "../../db/schema.js";
import { createGitRoutes } from "./git.js";

/**
 * Integration tests for /api/git/* routes — use a real temp git repo.
 * Git is assumed available in the test environment (same as every CI).
 */
describe("Git API routes", () => {
  let repoDir: string;
  let otherDir: string;
  let app: ReturnType<typeof createGitRoutes>;
  let firstHash: string;
  let secondHash: string;

  beforeAll(() => {
    repoDir = join(tmpdir(), `pa-git-test-${Date.now()}`);
    otherDir = join(tmpdir(), `pa-git-other-${Date.now()}`);
    mkdirSync(repoDir, { recursive: true });

    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });

    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    git(["config", "commit.gpgsign", "false"]);

    writeFileSync(join(repoDir, "README.md"), "# Initial\n");
    git(["add", "README.md"]);
    git(["commit", "-q", "-m", "Initial commit"]);
    firstHash = git(["rev-parse", "HEAD"]).trim();

    writeFileSync(join(repoDir, "README.md"), "# Initial\n\nMore content\n");
    writeFileSync(join(repoDir, "new.txt"), "added file\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "Second commit with body"]);
    secondHash = git(["rev-parse", "HEAD"]).trim();

    app = createGitRoutes({ allowedRepos: [repoDir] });
  });

  afterAll(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(otherDir, { recursive: true, force: true });
  });

  describe("GET /git/log", () => {
    it("returns commit list for allowed repo", async () => {
      const res = await app.request(
        `/git/log?repo=${encodeURIComponent(repoDir)}&count=5`,
      );
      expect(res.status).toBe(200);

      const data = (await res.json()) as {
        commits: Array<{
          hash: string;
          short: string;
          subject: string;
          author: string;
          ago: string;
        }>;
      };
      expect(data.commits).toHaveLength(2);
      expect(data.commits[0].subject).toBe("Second commit with body");
      expect(data.commits[0].hash).toBe(secondHash);
      expect(data.commits[0].short).toBe(secondHash.slice(0, 7));
      expect(data.commits[1].subject).toBe("Initial commit");
      expect(data.commits[0].author).toBe("Test");
      expect(data.commits[0].ago).toMatch(/ago/);
    });

    it("rejects missing repo parameter", async () => {
      const res = await app.request("/git/log");
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string; allowed: string[] };
      expect(data.error).toMatch(/invalid or missing repo/);
      expect(data.allowed).toEqual([repoDir]);
    });

    it("rejects repo not in allowed list", async () => {
      const res = await app.request(
        `/git/log?repo=${encodeURIComponent(otherDir)}`,
      );
      expect(res.status).toBe(400);
    });

    it("caps count at 20", async () => {
      const res = await app.request(
        `/git/log?repo=${encodeURIComponent(repoDir)}&count=9999`,
      );
      expect(res.status).toBe(200);
      const data = (await res.json()) as { commits: unknown[] };
      // Only 2 commits exist; the cap just means it doesn't error
      expect(data.commits).toHaveLength(2);
    });
  });

  describe("GET /git/diff", () => {
    it("returns diff between refs", async () => {
      const res = await app.request(
        `/git/diff?repo=${encodeURIComponent(repoDir)}&ref=HEAD~1..HEAD`,
      );
      expect(res.status).toBe(200);

      const data = (await res.json()) as { diff: string };
      expect(data.diff).toContain("README.md");
      expect(data.diff).toContain("new.txt");
      expect(data.diff).toContain("More content");
    });

    it("defaults to HEAD~1..HEAD", async () => {
      const res = await app.request(
        `/git/diff?repo=${encodeURIComponent(repoDir)}`,
      );
      expect(res.status).toBe(200);
      const data = (await res.json()) as { diff: string };
      expect(data.diff).toContain("new.txt");
    });

    it("rejects missing repo parameter on /git/diff", async () => {
      const res = await app.request("/git/diff");
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toMatch(/invalid or missing repo/);
    });

    it("supports three-dot (symmetric) diff syntax", async () => {
      // Regression: previously split("..") broke "a...b" into ["a", ".b"]
      // which git rejects. Passing ref as a single arg handles all forms.
      const res = await app.request(
        `/git/diff?repo=${encodeURIComponent(repoDir)}&ref=HEAD~1...HEAD`,
      );
      expect(res.status).toBe(200);
      const data = (await res.json()) as { diff: string };
      expect(data.diff).toContain("new.txt");
    });

    it("returns 500 when git diff fails with an invalid-but-safe ref", async () => {
      // A ref format that passes the sanitizer but git itself rejects.
      const res = await app.request(
        `/git/diff?repo=${encodeURIComponent(repoDir)}&ref=HEAD~9999..HEAD`,
      );
      expect(res.status).toBe(500);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBeTruthy();
    });

    it("falls back to default when ref is empty string", async () => {
      // Regression: ?ref= (explicit empty) previously bypassed the ?? default
      // and reached git as "", causing a 500. Use || to catch empty strings.
      const res = await app.request(
        `/git/diff?repo=${encodeURIComponent(repoDir)}&ref=`,
      );
      expect(res.status).toBe(200);
      const data = (await res.json()) as { diff: string };
      expect(data.diff).toContain("new.txt");
    });

    it("rejects shell metacharacters in ref", async () => {
      const res = await app.request(
        `/git/diff?repo=${encodeURIComponent(repoDir)}&ref=${encodeURIComponent("HEAD;rm -rf /")}`,
      );
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("invalid ref format");
    });

    it("rejects unknown repo", async () => {
      const res = await app.request(
        `/git/diff?repo=${encodeURIComponent("/not/allowed")}&ref=HEAD~1..HEAD`,
      );
      expect(res.status).toBe(400);
    });
  });

  describe("GET /git/show", () => {
    it("returns commit details for specific hash", async () => {
      const res = await app.request(
        `/git/show?repo=${encodeURIComponent(repoDir)}&hash=${secondHash}`,
      );
      expect(res.status).toBe(200);

      const data = (await res.json()) as { show: string };
      expect(data.show).toContain(secondHash);
      expect(data.show).toContain("Second commit with body");
      expect(data.show).toContain("README.md");
    });

    it("defaults to HEAD", async () => {
      const res = await app.request(
        `/git/show?repo=${encodeURIComponent(repoDir)}`,
      );
      expect(res.status).toBe(200);
      const data = (await res.json()) as { show: string };
      expect(data.show).toContain(secondHash);
    });

    it("rejects missing repo parameter on /git/show", async () => {
      const res = await app.request("/git/show");
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toMatch(/invalid or missing repo/);
    });

    it("falls back to HEAD when hash is empty string", async () => {
      // Regression: same ?? → || fix as /git/diff
      const res = await app.request(
        `/git/show?repo=${encodeURIComponent(repoDir)}&hash=`,
      );
      expect(res.status).toBe(200);
      const data = (await res.json()) as { show: string };
      expect(data.show).toContain(secondHash);
    });

    it("rejects shell metacharacters in hash", async () => {
      const res = await app.request(
        `/git/show?repo=${encodeURIComponent(repoDir)}&hash=${encodeURIComponent("HEAD`whoami`")}`,
      );
      expect(res.status).toBe(400);
    });

    it("returns 500 for invalid but safe hash", async () => {
      const res = await app.request(
        `/git/show?repo=${encodeURIComponent(repoDir)}&hash=nonexistent123`,
      );
      expect(res.status).toBe(500);
    });
  });

  describe("empty allowed list", () => {
    it("rejects any repo when list is empty", async () => {
      const emptyApp = createGitRoutes({ allowedRepos: [] });
      const res = await emptyApp.request(
        `/git/log?repo=${encodeURIComponent(repoDir)}`,
      );
      expect(res.status).toBe(400);
    });
  });

  // ── DB-backed repo resolution (selectGitRepoPaths + resolveRepositoryIdentifier) ──
  describe("DB-backed repo resolution", () => {
    it("resolves a local repo by its filesystem path via selectGitRepoPaths (DB direct path)", async () => {
      const db = new Database(":memory:");
      applySchema(db);
      db.prepare(
        `INSERT INTO repositories (id, local_path, local_only, created_at, updated_at)
         VALUES ('local:abc123', ?, 1, strftime('%s','now'), strftime('%s','now'))`,
      ).run(repoDir);

      const dbApp = createGitRoutes({ db });
      const res = await dbApp.request(
        `/git/log?repo=${encodeURIComponent(repoDir)}&count=1`,
      );
      expect(res.status).toBe(200);
      const data = (await res.json()) as { commits: unknown[] };
      expect(data.commits).toHaveLength(1);
      db.close();
    });

    it("resolves a repo by id string via resolveRepositoryIdentifier (DB id lookup)", async () => {
      const db = new Database(":memory:");
      applySchema(db);
      db.prepare(
        `INSERT INTO repositories (id, local_path, local_only, created_at, updated_at)
         VALUES ('local:idlookup99', ?, 1, strftime('%s','now'), strftime('%s','now'))`,
      ).run(repoDir);

      const dbApp = createGitRoutes({ db });
      const res = await dbApp.request(`/git/log?repo=local:idlookup99&count=1`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { commits: unknown[] };
      expect(data.commits).toHaveLength(1);
      db.close();
    });

    it("resolves a repo by github:<owner>/<repo> slug via resolveRepositoryIdentifier", async () => {
      const db = new Database(":memory:");
      applySchema(db);
      db.prepare(
        `INSERT INTO repositories (id, github_owner, github_repo, local_path, local_only, created_at, updated_at)
         VALUES ('local:ghslugtest', 'test-owner', 'test-repo', ?, 0, strftime('%s','now'), strftime('%s','now'))`,
      ).run(repoDir);

      const dbApp = createGitRoutes({ db });
      const res = await dbApp.request(`/git/log?repo=github:test-owner/test-repo&count=1`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { commits: unknown[] };
      expect(data.commits).toHaveLength(1);
      db.close();
    });

    it("returns 400 for a GitHub-only repo with no local clone (row has no local_path)", async () => {
      const db = new Database(":memory:");
      applySchema(db);
      db.prepare(
        `INSERT INTO repositories (id, github_owner, github_repo, local_only, created_at, updated_at)
         VALUES ('local:ghonly', 'acme', 'widgets', 0, strftime('%s','now'), strftime('%s','now'))`,
      ).run();

      const dbApp = createGitRoutes({ db });
      const res = await dbApp.request(`/git/log?repo=github:acme/widgets`);
      expect(res.status).toBe(400);
      db.close();
    });

    it("includes DB repo paths in the allowed list returned in the 400 error body (listAllowed reads DB)", async () => {
      const db = new Database(":memory:");
      applySchema(db);
      db.prepare(
        `INSERT INTO repositories (id, local_path, local_only, created_at, updated_at)
         VALUES ('local:listtest', ?, 1, strftime('%s','now'), strftime('%s','now'))`,
      ).run(repoDir);

      const dbApp = createGitRoutes({ db });
      const res = await dbApp.request(
        `/git/log?repo=${encodeURIComponent("/nonexistent/repo")}`,
      );
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string; allowed: string[] };
      expect(data.allowed).toContain(repoDir);
      db.close();
    });

    it("merges DB paths and allowedRepos when both are provided", async () => {
      const db = new Database(":memory:");
      applySchema(db);
      db.prepare(
        `INSERT INTO repositories (id, local_path, local_only, created_at, updated_at)
         VALUES ('local:combotest', ?, 1, strftime('%s','now'), strftime('%s','now'))`,
      ).run(repoDir);

      const extraPath = "/extra/not-a-real-repo";
      const dbApp = createGitRoutes({ db, allowedRepos: [extraPath] });
      // The DB path resolves correctly.
      const res = await dbApp.request(
        `/git/log?repo=${encodeURIComponent(repoDir)}&count=1`,
      );
      expect(res.status).toBe(200);

      // The extra allowedRepo path is accepted by resolveRepo but fails git.
      const res2 = await dbApp.request(
        `/git/log?repo=${encodeURIComponent(extraPath)}`,
      );
      expect(res2.status).toBe(500);
      db.close();
    });

    it("git diff returns 400 on missing repo when DB has no matching row", async () => {
      const db = new Database(":memory:");
      applySchema(db);

      const dbApp = createGitRoutes({ db });
      const res = await dbApp.request(`/git/diff?repo=${encodeURIComponent("/nope")}`);
      expect(res.status).toBe(400);
      db.close();
    });

    it("git show returns 400 on missing repo when DB has no matching row", async () => {
      const db = new Database(":memory:");
      applySchema(db);

      const dbApp = createGitRoutes({ db });
      const res = await dbApp.request(`/git/show?repo=${encodeURIComponent("/nope")}`);
      expect(res.status).toBe(400);
      db.close();
    });

    it("resolves a repo by owner/repo format (without github: prefix) via DB", async () => {
      const db = new Database(":memory:");
      applySchema(db);
      db.prepare(
        `INSERT INTO repositories (id, github_owner, github_repo, local_path, local_only, created_at, updated_at)
         VALUES ('local:nopfx', 'nopfx-owner', 'nopfx-repo', ?, 0, strftime('%s','now'), strftime('%s','now'))`,
      ).run(repoDir);

      const dbApp = createGitRoutes({ db });
      const res = await dbApp.request(`/git/log?repo=nopfx-owner/nopfx-repo&count=1`);
      expect(res.status).toBe(200);
      db.close();
    });
  });
});
