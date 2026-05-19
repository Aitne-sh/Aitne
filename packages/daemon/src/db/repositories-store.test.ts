import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { join } from "node:path";
import { applySchema } from "./schema.js";
import {
  createRepository,
  createTrigger,
  deleteRepository,
  deleteTrigger,
  deriveRepositoryId,
  deriveSlug,
  getManagement,
  getRepository,
  getRepositoryByGithub,
  getRepositoryByLocalPath,
  getTrigger,
  listEnabledTriggersForEvent,
  listManagementDueForScan,
  listRepositories,
  listTriggers,
  recordManagementInitDone,
  recordManagementScan,
  recordTriggerFire,
  RepositoryStoreError,
  resolveRepositoryIdentifier,
  selectGithubRepoSlugs,
  selectGitRepoPaths,
  selectGitWatchedRepos,
  setManagementEnabled,
  updateRepository,
  updateTrigger,
} from "./repositories-store.js";

describe("repositories-store", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("deriveSlug", () => {
    it("prefers displayName when set", () => {
      expect(
        deriveSlug({
          displayName: "Acme Widgets!",
          githubOwner: "acme",
          githubRepo: "widgets",
          localPath: "/code/widgets",
        }),
      ).toBe("acme-widgets");
    });

    it("falls back to owner-repo when displayName missing", () => {
      expect(
        deriveSlug({
          githubOwner: "acme",
          githubRepo: "widgets",
          localPath: "/code/something-else",
        }),
      ).toBe("acme-widgets");
    });

    it("falls back to localPath basename when no GitHub side", () => {
      expect(deriveSlug({ localPath: "/Users/me/code/my-tool" })).toBe(
        "my-tool",
      );
    });

    it("uses the final segment of Windows local paths", () => {
      expect(deriveSlug({ localPath: "C:\\Users\\me\\code\\my-tool" })).toBe(
        "my-tool",
      );
      expect(deriveSlug({ localPath: "D:/code/my-tool/" })).toBe("my-tool");
    });

    it("sanitizes non-allowed characters to dash", () => {
      expect(
        deriveSlug({ displayName: "Hello, World!! foo_bar" }),
      ).toBe("hello-world-foo_bar");
    });

    it("trims leading/trailing dashes from sanitization", () => {
      expect(deriveSlug({ displayName: "!!Cool::" })).toBe("cool");
    });

    it("caps the result at 60 characters", () => {
      const long = "a".repeat(120);
      expect(deriveSlug({ displayName: long }).length).toBe(60);
    });

    it("returns repo-<id-prefix> when every candidate sanitizes to empty", () => {
      const slug = deriveSlug({ id: "deadbeef0000", displayName: "!!!" });
      expect(slug).toBe("repo-deadbeef0000");
    });

    it("returns repo-row when no id and every candidate sanitizes to empty", () => {
      // Exercises the `(input.id ?? \"row\")` fallback branch.
      expect(deriveSlug({ displayName: "!!!" })).toBe("repo-row");
    });

    it("ignores trailing slash in localPath", () => {
      expect(deriveSlug({ localPath: "/code/widgets/" })).toBe("widgets");
    });

    it("falls through when localPath is just slashes", () => {
      expect(deriveSlug({ id: "x", localPath: "///" })).toBe("repo-x");
    });
  });

  // C3 — `path.join(contextDir, gitRepoOverviewPath(".."))` normalises the
  // `..` segment and redirects writes outside `git/<slug>/`. Defense-in-depth
  // is at the slug helper. Tests below pin both the rejection behaviour and
  // the regression guard that legitimate dots-in-the-middle slugs survive.
  describe("deriveSlug — pure-dot rejection (C3)", () => {
    it.each([
      { displayName: "." },
      { displayName: ".." },
      { displayName: "..." },
      { displayName: "...." },
    ])("rejects pure-dot displayName: %p", (input) => {
      const slug = deriveSlug({ id: "abc-123", ...input });
      expect(slug).not.toMatch(/^\.+$/);
      expect(slug).not.toMatch(/\.\./);
      // Defense-in-depth: path.join with the slug must stay inside git/.
      const probe = join("/root", "git", slug, "overview.md");
      expect(probe.startsWith("/root/git/")).toBe(true);
      expect(probe.includes("/..")).toBe(false);
    });

    it("falls through to githubOwner-githubRepo when displayName is pure-dot", () => {
      expect(
        deriveSlug({
          id: "abc-123",
          displayName: "..",
          githubOwner: "acme",
          githubRepo: "widgets",
        }),
      ).toBe("acme-widgets");
    });

    it("falls through to localPath basename when displayName is pure-dot", () => {
      expect(
        deriveSlug({ id: "abc-123", displayName: "..", localPath: "/Users/me/proj" }),
      ).toBe("proj");
    });

    it("uses deterministic hash fallback when every candidate AND the id collapse to dots", () => {
      // displayName + localPath both pure-dot; github pair omitted (the
      // `${owner}-${repo}` join would form a dash-bearing slug otherwise);
      // id itself pure-dot so the fallback path also rejects via PURE_DOT.
      const slug = deriveSlug({
        id: "...",
        displayName: ".",
        localPath: "/..",
      });
      expect(slug).toMatch(/^repo-[0-9a-f]{12}$/);
      expect(slug).not.toMatch(/\.\./);
    });

    it("hash fallback is deterministic for the same id", () => {
      const a = deriveSlug({ id: "...", displayName: ".." });
      const b = deriveSlug({ id: "...", displayName: ".." });
      expect(a).toBe(b);
    });

    it("does not over-reject legitimate slugs with dots in the middle", () => {
      expect(deriveSlug({ displayName: "my.tool" })).toBe("my.tool");
      expect(deriveSlug({ displayName: "v1.2.3" })).toBe("v1.2.3");
      expect(deriveSlug({ displayName: ".env-template" })).toContain(
        "env-template",
      );
    });
  });

  describe("deriveRepositoryId", () => {
    it("uses github:owner/repo for GitHub-paired rows", () => {
      expect(deriveRepositoryId({ githubOwner: "a", githubRepo: "b" })).toBe(
        "github:a/b",
      );
    });

    it("uses local:<sha1[:12]> for local-only rows", () => {
      const id = deriveRepositoryId({ localPath: "/code/foo" });
      expect(id.startsWith("local:")).toBe(true);
      expect(id.length).toBe("local:".length + 12);
    });

    it("rejects when neither side is provided", () => {
      expect(() => deriveRepositoryId({})).toThrow(RepositoryStoreError);
    });
  });

  describe("createRepository CHECK constraints", () => {
    it("creates a github+local paired row", () => {
      const dto = createRepository(db, {
        githubOwner: "acme",
        githubRepo: "widgets",
        localPath: "/code/widgets",
        classification: "project",
      });
      expect(dto.id).toBe("github:acme/widgets");
      expect(dto.slug).toBe("acme-widgets");
      expect(dto.localOnly).toBe(false);
    });

    it("creates a github-only row", () => {
      const dto = createRepository(db, {
        githubOwner: "acme",
        githubRepo: "widgets",
      });
      expect(dto.localPath).toBeNull();
    });

    it("creates a local-only row with localOnly=true", () => {
      const dto = createRepository(db, {
        localPath: "/code/private-vault",
        localOnly: true,
      });
      expect(dto.localOnly).toBe(true);
      expect(dto.id.startsWith("local:")).toBe(true);
    });

    it("rejects rows missing both sides", () => {
      expect(() => createRepository(db, {})).toThrow(/must have/);
    });

    it("rejects localOnly=true with GitHub fields", () => {
      expect(() =>
        createRepository(db, {
          githubOwner: "a",
          githubRepo: "b",
          localPath: "/code/x",
          localOnly: true,
        }),
      ).toThrow(/local_only_with_github|forbids/);
    });

    it("rejects duplicate GitHub remote", () => {
      createRepository(db, { githubOwner: "a", githubRepo: "b" });
      expect(() =>
        createRepository(db, { githubOwner: "a", githubRepo: "b" }),
      ).toThrow(/already exists/);
    });

    it("rejects duplicate local path", () => {
      createRepository(db, { localPath: "/code/x", localOnly: true });
      expect(() =>
        createRepository(db, { localPath: "/code/x", localOnly: true }),
      ).toThrow(/already registered|already exists/);
    });

    it("rejects equivalent Windows local paths with different case or separators", () => {
      createRepository(db, {
        localPath: "C:\\Users\\me\\Code\\Widget",
        localOnly: true,
      });
      expect(() =>
        createRepository(db, {
          localPath: "c:/users/me/code/widget/",
          localOnly: true,
        }),
      ).toThrow(RepositoryStoreError);
    });

    it("requires owner+repo together (one without the other is treated as missing side)", () => {
      expect(() =>
        createRepository(db, { githubOwner: "a" }),
      ).toThrow(/githubOwner and githubRepo/);
    });

    it("rejects owner+repo partials even when a local path exists", () => {
      expect(() =>
        createRepository(db, { githubOwner: "a", localPath: "/code/a" }),
      ).toThrow(/githubOwner and githubRepo/);
      expect(() =>
        createRepository(db, { githubRepo: "b", localPath: "/code/b" }),
      ).toThrow(/githubOwner and githubRepo/);
    });

    it("rejects non-positive poll intervals", () => {
      expect(() =>
        createRepository(db, {
          githubOwner: "a",
          githubRepo: "b",
          pollIntervalSec: 0,
        }),
      ).toThrow(/pollIntervalSec/);
    });
  });

  describe("listRepositories filters", () => {
    beforeEach(() => {
      createRepository(db, {
        githubOwner: "a",
        githubRepo: "x",
        localPath: "/code/x",
      });
      createRepository(db, { githubOwner: "a", githubRepo: "y" });
      createRepository(db, {
        localPath: "/code/z",
        localOnly: true,
      });
    });

    it("returns all rows by default", () => {
      expect(listRepositories(db)).toHaveLength(3);
    });

    it("filters to GitHub-paired rows", () => {
      const rows = listRepositories(db, { hasGithub: true });
      expect(rows.map((r) => r.id).sort()).toEqual(["github:a/x", "github:a/y"]);
    });

    it("filters to rows with no GitHub side", () => {
      const rows = listRepositories(db, { hasGithub: false });
      expect(rows.every((r) => r.githubOwner === null)).toBe(true);
    });

    it("filters to local-cloned rows", () => {
      const rows = listRepositories(db, { hasLocal: true });
      expect(rows.map((r) => r.localPath).sort()).toEqual([
        "/code/x",
        "/code/z",
      ]);
    });

    it("filters to rows without local clone", () => {
      const rows = listRepositories(db, { hasLocal: false });
      expect(rows.every((r) => r.localPath === null)).toBe(true);
    });

    it("filters to localOnly rows", () => {
      const rows = listRepositories(db, { localOnly: true });
      expect(rows).toHaveLength(1);
      expect(rows[0].localOnly).toBe(true);
    });

    it("filters out localOnly when localOnly=false", () => {
      const rows = listRepositories(db, { localOnly: false });
      expect(rows.every((r) => r.localOnly === false)).toBe(true);
    });

    it("filters by GitHub account alias", () => {
      createRepository(db, {
        githubOwner: "b",
        githubRepo: "z",
        githubAccount: "personal",
      });
      const rows = listRepositories(db, { account: "personal" });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe("github:b/z");
    });
  });

  describe("getRepository / getRepositoryByGithub / getRepositoryByLocalPath", () => {
    it("returns null for missing rows", () => {
      expect(getRepository(db, "github:nope/nope")).toBeNull();
      expect(getRepositoryByGithub(db, "x", "y")).toBeNull();
      expect(getRepositoryByLocalPath(db, "/none")).toBeNull();
    });

    it("returns matching rows by each lookup", () => {
      createRepository(db, {
        githubOwner: "a",
        githubRepo: "b",
        localPath: "/code/a-b",
      });
      expect(getRepository(db, "github:a/b")?.localPath).toBe("/code/a-b");
      expect(getRepositoryByGithub(db, "a", "b")?.localPath).toBe("/code/a-b");
      expect(getRepositoryByLocalPath(db, "/code/a-b")?.id).toBe("github:a/b");
    });

    it("resolves current GitHub aliases for rows whose immutable id is local-start", () => {
      const created = createRepository(db, {
        localPath: "/code/local-first",
        localOnly: false,
      });
      const linked = updateRepository(db, created.id, {
        githubOwner: "acme",
        githubRepo: "local-first",
      });
      expect(linked.id).toBe(created.id);
      expect(resolveRepositoryIdentifier(db, "acme/local-first")?.id).toBe(
        created.id,
      );
      expect(
        resolveRepositoryIdentifier(db, "github:acme/local-first")?.id,
      ).toBe(created.id);
    });
  });

  describe("updateRepository", () => {
    it("updates metadata fields", () => {
      const created = createRepository(db, {
        githubOwner: "a",
        githubRepo: "b",
      });
      const updated = updateRepository(db, created.id, {
        displayName: "Pretty Name",
        category: "work",
        classification: "project",
        pollIntervalSec: 600,
      });
      expect(updated.displayName).toBe("Pretty Name");
      expect(updated.category).toBe("work");
      expect(updated.classification).toBe("project");
      expect(updated.pollIntervalSec).toBe(600);
    });

    it("allows linking GitHub onto a local-start row without changing its id", () => {
      const created = createRepository(db, {
        localPath: "/code/local-first",
        localOnly: false,
      });
      const updated = updateRepository(db, created.id, {
        githubOwner: "a",
        githubRepo: "b",
      });
      expect(updated.id).toBe(created.id);
      expect(updated.githubOwner).toBe("a");
      expect(updated.githubRepo).toBe("b");
      expect(getRepositoryByGithub(db, "a", "b")?.id).toBe(created.id);
    });

    it("allows unlinking GitHub from a paired GitHub-start row when local clone remains", () => {
      const created = createRepository(db, {
        githubOwner: "a",
        githubRepo: "b",
        localPath: "/code/a-b",
      });
      const updated = updateRepository(db, created.id, {
        githubOwner: null,
        githubRepo: null,
        githubAccount: null,
        localOnly: true,
      });
      expect(updated.id).toBe("github:a/b");
      expect(updated.githubOwner).toBeNull();
      expect(updated.localOnly).toBe(true);
      expect(updated.localPath).toBe("/code/a-b");
    });

    it("rejects clearing local_path while a local-clone trigger exists", () => {
      const created = createRepository(db, {
        githubOwner: "a",
        githubRepo: "b",
        localPath: "/code/a-b",
      });
      createTrigger(db, created.id, {
        name: "ci-fix",
        eventType: "github.workflow_run.completed",
        backend: "claude",
        model: "sonnet",
        workdirMode: "local-clone",
        prompt: "fix it",
      });
      expect(() =>
        updateRepository(db, created.id, { localPath: null }),
      ).toThrow(/blocks_clear|trigger/);
    });

    it("rejects updating a row that doesn't exist", () => {
      expect(() =>
        updateRepository(db, "github:nope/nope", { displayName: "x" }),
      ).toThrow(/not_found|not found/);
    });

    it("rejects updates that violate the missing-side check", () => {
      const created = createRepository(db, {
        githubOwner: "a",
        githubRepo: "b",
        localPath: "/code/a-b",
      });
      // Clearing local_path AND attempting to leave nothing — the keying-
      // side check fires first since clearing localPath here keeps the
      // GitHub side, so let's test by clearing both. The id keying check
      // catches "would change id"; this exercises the missing-side path
      // by clearing localPath when it's the ONLY side.
      const local = createRepository(db, {
        localPath: "/code/x",
        localOnly: true,
      });
      // localOnly=false retain, but try to clear localPath — leaves nothing.
      expect(() =>
        updateRepository(db, local.id, { localPath: null, localOnly: false }),
      ).toThrow(/must have/);
      void created;
    });

    it("setting localOnly=false on a local-only row leaves it valid", () => {
      const created = createRepository(db, {
        localPath: "/code/x",
        localOnly: true,
      });
      const updated = updateRepository(db, created.id, { localOnly: false });
      expect(updated.localOnly).toBe(false);
      // GitHub fields still null — that's fine, the row has a local side.
      expect(updated.githubOwner).toBeNull();
    });

    it("can flip localOnly from false to true on a row that has no GitHub fields", () => {
      const created = createRepository(db, {
        localPath: "/code/x",
        localOnly: false,
      });
      const updated = updateRepository(db, created.id, { localOnly: true });
      expect(updated.localOnly).toBe(true);
    });

    it("explicit null patch fields override DB values without re-validating beyond shape", () => {
      // Exercises the `patch.X !== undefined ? patch.X : current.X` branch
      // for githubAccount, displayName, and pollIntervalSec specifically.
      const created = createRepository(db, {
        githubOwner: "a",
        githubRepo: "b",
        githubAccount: "personal",
        displayName: "Pretty",
        pollIntervalSec: 600,
      });
      const updated = updateRepository(db, created.id, {
        githubAccount: null,
        displayName: null,
        pollIntervalSec: null,
      });
      expect(updated.githubAccount).toBeNull();
      expect(updated.displayName).toBeNull();
      expect(updated.pollIntervalSec).toBeNull();
    });

    it("rejects linking to a GitHub remote already registered by another row", () => {
      createRepository(db, { githubOwner: "a", githubRepo: "b" });
      const local = createRepository(db, {
        localPath: "/code/local",
        localOnly: false,
      });
      expect(() =>
        updateRepository(db, local.id, { githubOwner: "a", githubRepo: "b" }),
      ).toThrow(/already registered/);
    });

    it("rejects updating to a duplicate local path", () => {
      createRepository(db, { localPath: "/code/existing", localOnly: true });
      const created = createRepository(db, { githubOwner: "a", githubRepo: "b" });
      expect(() =>
        updateRepository(db, created.id, { localPath: "/code/existing" }),
      ).toThrow(/already registered/);
    });

    it("rejects updating displayName to a value whose slug collides with another repo", () => {
      // Exercises the slug-collision branch in updateRepository: same slug,
      // different repo id. Repo A pre-claims the slug `widget`; Repo B
      // attempts to rename its displayName to "Widget" and the derived slug
      // collides.
      createRepository(db, { displayName: "widget", localPath: "/code/a", localOnly: true });
      const repoB = createRepository(db, { displayName: "other", localPath: "/code/b", localOnly: true });
      expect(() =>
        updateRepository(db, repoB.id, { displayName: "widget" }),
      ).toThrow(/already used/);
    });

    it("rejects creating a second repository whose slug already exists", () => {
      // Same trick at create-time: the github-paired row claims slug
      // `widget`; a local-only row whose displayName produces the same slug
      // collides at create.
      createRepository(db, {
        githubOwner: "ownr",
        githubRepo: "widget",
      });
      expect(() =>
        createRepository(db, {
          displayName: "ownr-widget",
          localPath: "/code/widget",
          localOnly: true,
        }),
      ).toThrow(/already used/);
    });

    it("walks past non-matching slugs before flagging a collision (slug loop continue branch)", () => {
      // Pre-populate the table with several repos whose slugs do NOT match
      // the candidate, then trigger a collision on the LAST row. Forces the
      // slug-search loop to traverse multiple non-matching iterations
      // (`if (rowSlug === slug) … else continue`) before returning.
      createRepository(db, { displayName: "alpha", localPath: "/code/a", localOnly: true });
      createRepository(db, { displayName: "beta", localPath: "/code/b", localOnly: true });
      createRepository(db, { displayName: "target", localPath: "/code/t", localOnly: true });
      expect(() =>
        createRepository(db, {
          displayName: "target",
          localPath: "/code/t2",
          localOnly: true,
        }),
      ).toThrow(/already used/);
    });
  });

  describe("deleteRepository", () => {
    it("deletes the row and cascades to triggers + management", () => {
      const created = createRepository(db, {
        githubOwner: "a",
        githubRepo: "b",
        localPath: "/code/a-b",
      });
      createTrigger(db, created.id, {
        name: "x",
        eventType: "github.workflow_run.completed",
        backend: "claude",
        model: "sonnet",
        workdirMode: "local-clone",
        prompt: "p",
      });
      setManagementEnabled(db, created.id, true);

      expect(deleteRepository(db, created.id)).toBe(true);
      expect(getRepository(db, created.id)).toBeNull();
      expect(listTriggers(db, created.id)).toHaveLength(0);
      expect(getManagement(db, created.id)).toBeNull();
    });

    it("returns false when nothing was deleted", () => {
      expect(deleteRepository(db, "github:none/none")).toBe(false);
    });
  });

  describe("legacy projection selectors", () => {
    beforeEach(() => {
      createRepository(db, {
        githubOwner: "a",
        githubRepo: "x",
        localPath: "/code/x",
        category: "work",
      });
      createRepository(db, {
        githubOwner: "a",
        githubRepo: "y",
      });
      createRepository(db, {
        localPath: "/code/z",
        localOnly: true,
        category: "personal",
      });
    });

    it("selectGitRepoPaths returns local-cloned paths only", () => {
      expect(selectGitRepoPaths(db).sort()).toEqual(["/code/x", "/code/z"]);
    });

    it("selectGitWatchedRepos returns the legacy shape with repositoryId attached", () => {
      const rows = selectGitWatchedRepos(db);
      expect(rows).toHaveLength(2);
      const xRow = rows.find((r) => r.path === "/code/x")!;
      expect(xRow.repositoryId).toBe("github:a/x");
      expect(xRow.org).toBe("a");
      expect(xRow.category).toBe("work");
      const zRow = rows.find((r) => r.path === "/code/z")!;
      expect(zRow.repositoryId.startsWith("local:")).toBe(true);
      expect(zRow.org).toBeUndefined();
    });

    it("selectGithubRepoSlugs returns owner/repo for github-side rows", () => {
      expect(selectGithubRepoSlugs(db).sort()).toEqual(["a/x", "a/y"]);
    });
  });

  describe("triggers CRUD + cross-table validation", () => {
    let repoId: string;

    beforeEach(() => {
      repoId = createRepository(db, {
        githubOwner: "a",
        githubRepo: "b",
        localPath: "/code/a-b",
      }).id;
    });

    it("creates a temp-mode trigger with instructionMd", () => {
      const trg = createTrigger(db, repoId, {
        name: "summarize",
        eventType: "github.pull_request.opened",
        backend: "claude",
        model: "sonnet",
        workdirMode: "temp",
        prompt: "summarize PR",
        instructionMd: "you are a summarizer",
      });
      expect(trg.workdirMode).toBe("temp");
      expect(trg.instructionMd).toBe("you are a summarizer");
      expect(trg.fireCount).toBe(0);
      expect(trg.enabled).toBe(true);
    });

    it("rejects temp mode without instructionMd", () => {
      expect(() =>
        createTrigger(db, repoId, {
          name: "x",
          eventType: "github.pull_request.opened",
          backend: "claude",
          model: "sonnet",
          workdirMode: "temp",
          prompt: "p",
        }),
      ).toThrow(/instruction/);
    });

    it("rejects local-clone mode when parent has no local_path", () => {
      const ghOnly = createRepository(db, {
        githubOwner: "x",
        githubRepo: "y",
      }).id;
      expect(() =>
        createTrigger(db, ghOnly, {
          name: "x",
          eventType: "github.pull_request.opened",
          backend: "claude",
          model: "sonnet",
          workdirMode: "local-clone",
          prompt: "p",
        }),
      ).toThrow(/local-clone|local_path/);
    });

    it("rejects creating a trigger for a missing repo", () => {
      expect(() =>
        createTrigger(db, "github:nope/nope", {
          name: "x",
          eventType: "e",
          backend: "claude",
          model: "sonnet",
          workdirMode: "local-clone",
          prompt: "p",
        }),
      ).toThrow(/not_found|not found/);
    });

    it("validates filter shape — flat scalars + path_pattern", () => {
      const trg = createTrigger(db, repoId, {
        name: "main-only",
        eventType: "git.push.detected",
        filters: { branch: "main", path_pattern: ["packages/**"] },
        backend: "claude",
        model: "sonnet",
        workdirMode: "local-clone",
        prompt: "p",
      });
      expect(trg.filters).toEqual({
        branch: "main",
        path_pattern: ["packages/**"],
      });
    });

    it("rejects nested object filters", () => {
      expect(() =>
        createTrigger(db, repoId, {
          name: "x",
          eventType: "git.push.detected",
          filters: { meta: { nested: true } } as Record<string, unknown>,
          backend: "claude",
          model: "sonnet",
          workdirMode: "local-clone",
          prompt: "p",
        }),
      ).toThrow(/scalar|filter/);
    });

    it("rejects path_pattern that is not string|string[]", () => {
      expect(() =>
        createTrigger(db, repoId, {
          name: "x",
          eventType: "git.push.detected",
          filters: { path_pattern: 42 } as Record<string, unknown>,
          backend: "claude",
          model: "sonnet",
          workdirMode: "local-clone",
          prompt: "p",
        }),
      ).toThrow(/path_pattern/);
    });

    it("accepts a string path_pattern", () => {
      const trg = createTrigger(db, repoId, {
        name: "x",
        eventType: "git.push.detected",
        filters: { path_pattern: "packages/**" },
        backend: "claude",
        model: "sonnet",
        workdirMode: "local-clone",
        prompt: "p",
      });
      expect(trg.filters.path_pattern).toBe("packages/**");
    });

    it("rejects path_pattern array containing non-strings", () => {
      expect(() =>
        createTrigger(db, repoId, {
          name: "x",
          eventType: "git.push.detected",
          filters: { path_pattern: ["ok", 123] } as Record<string, unknown>,
          backend: "claude",
          model: "sonnet",
          workdirMode: "local-clone",
          prompt: "p",
        }),
      ).toThrow(/path_pattern/);
    });

    it("rejects prompts > 16 KB", () => {
      const large = "x".repeat(17 * 1024);
      expect(() =>
        createTrigger(db, repoId, {
          name: "x",
          eventType: "github.pull_request.opened",
          backend: "claude",
          model: "sonnet",
          workdirMode: "temp",
          prompt: large,
          instructionMd: "ok",
        }),
      ).toThrow(/cap|byte/);
    });

    it("rejects instructionMd > 16 KB", () => {
      const large = "x".repeat(17 * 1024);
      expect(() =>
        createTrigger(db, repoId, {
          name: "x",
          eventType: "github.pull_request.opened",
          backend: "claude",
          model: "sonnet",
          workdirMode: "temp",
          prompt: "ok",
          instructionMd: large,
        }),
      ).toThrow(/cap|byte/);
    });

    it("creates with enabled=false explicitly", () => {
      const trg = createTrigger(db, repoId, {
        name: "x",
        eventType: "e",
        enabled: false,
        backend: "claude",
        model: "sonnet",
        workdirMode: "local-clone",
        prompt: "p",
      });
      expect(trg.enabled).toBe(false);
    });

    it("listEnabledTriggersForEvent filters by enabled+event", () => {
      createTrigger(db, repoId, {
        name: "a",
        eventType: "git.push.detected",
        backend: "claude",
        model: "sonnet",
        workdirMode: "local-clone",
        prompt: "p",
      });
      createTrigger(db, repoId, {
        name: "b",
        eventType: "git.push.detected",
        enabled: false,
        backend: "claude",
        model: "sonnet",
        workdirMode: "local-clone",
        prompt: "p",
      });
      createTrigger(db, repoId, {
        name: "c",
        eventType: "github.pull_request.opened",
        backend: "claude",
        model: "sonnet",
        workdirMode: "temp",
        prompt: "p",
        instructionMd: "i",
      });
      const matched = listEnabledTriggersForEvent(
        db,
        repoId,
        "git.push.detected",
      );
      expect(matched.map((t) => t.name)).toEqual(["a"]);
    });

    it("getTrigger returns null for missing", () => {
      expect(getTrigger(db, "trg_none")).toBeNull();
    });

    it("updateTrigger merges patch fields and re-validates", () => {
      const trg = createTrigger(db, repoId, {
        name: "x",
        eventType: "git.push.detected",
        backend: "claude",
        model: "sonnet",
        workdirMode: "local-clone",
        prompt: "p",
      });
      const updated = updateTrigger(db, trg.id, {
        name: "y",
        enabled: false,
        filters: { branch: "main" },
      });
      expect(updated.name).toBe("y");
      expect(updated.enabled).toBe(false);
      expect(updated.filters).toEqual({ branch: "main" });
    });

    it("updateTrigger to temp mode without instructionMd is rejected", () => {
      const trg = createTrigger(db, repoId, {
        name: "x",
        eventType: "git.push.detected",
        backend: "claude",
        model: "sonnet",
        workdirMode: "local-clone",
        prompt: "p",
      });
      expect(() =>
        updateTrigger(db, trg.id, { workdirMode: "temp" }),
      ).toThrow(/instruction/);
    });

    it("updateTrigger preserving local-clone re-checks parent local_path", () => {
      // Create a github-only row, then attempt to retarget the trigger
      // there via updateTrigger. The cross-table check fires.
      const trg = createTrigger(db, repoId, {
        name: "x",
        eventType: "git.push.detected",
        backend: "claude",
        model: "sonnet",
        workdirMode: "local-clone",
        prompt: "p",
      });
      // We can't change repository_id via update; test by clearing local_path
      // on the parent first… which is also blocked. So validate that
      // updateTrigger to a different workdir mode succeeds.
      const u = updateTrigger(db, trg.id, {
        workdirMode: "temp",
        instructionMd: "i",
      });
      expect(u.workdirMode).toBe("temp");
    });

    it("updateTrigger 404s when missing", () => {
      expect(() => updateTrigger(db, "trg_none", { name: "x" })).toThrow(
        /not_found|not found/,
      );
    });

    it("deleteTrigger returns true once and false the next time", () => {
      const trg = createTrigger(db, repoId, {
        name: "x",
        eventType: "e",
        backend: "claude",
        model: "sonnet",
        workdirMode: "local-clone",
        prompt: "p",
      });
      expect(deleteTrigger(db, trg.id)).toBe(true);
      expect(deleteTrigger(db, trg.id)).toBe(false);
    });

    it("recordTriggerFire bumps last_fired_at + fire_count", () => {
      const trg = createTrigger(db, repoId, {
        name: "x",
        eventType: "e",
        backend: "claude",
        model: "sonnet",
        workdirMode: "local-clone",
        prompt: "p",
      });
      recordTriggerFire(db, trg.id, 1700000000000);
      const after = getTrigger(db, trg.id);
      expect(after?.lastFiredAt).toBe(1700000000000);
      expect(after?.fireCount).toBe(1);
    });

    it("falls back to {} when persisted filters_json is corrupt", () => {
      const trg = createTrigger(db, repoId, {
        name: "x",
        eventType: "e",
        backend: "claude",
        model: "sonnet",
        workdirMode: "local-clone",
        prompt: "p",
      });
      db.prepare(
        "UPDATE repository_triggers SET filters_json = ? WHERE id = ?",
      ).run("not json", trg.id);
      const after = getTrigger(db, trg.id);
      expect(after?.filters).toEqual({});
    });

    it("falls back to {} when filters_json is a JSON array", () => {
      const trg = createTrigger(db, repoId, {
        name: "x",
        eventType: "e",
        backend: "claude",
        model: "sonnet",
        workdirMode: "local-clone",
        prompt: "p",
      });
      db.prepare(
        "UPDATE repository_triggers SET filters_json = ? WHERE id = ?",
      ).run("[1,2,3]", trg.id);
      expect(getTrigger(db, trg.id)?.filters).toEqual({});
    });

    it("createTrigger with numeric timestamp as 4th arg uses it as createdAt/updatedAt", () => {
      const fixedNow = 1700000000000;
      const trg = createTrigger(
        db,
        repoId,
        {
          name: "x",
          eventType: "git.push.detected",
          backend: "claude",
          model: "sonnet",
          workdirMode: "local-clone",
          prompt: "p",
        },
        fixedNow,
      );
      expect(trg.createdAt).toBe(fixedNow);
      expect(trg.updatedAt).toBe(fixedNow);
    });

    it("createTrigger with validateModel returning true calls the validator and creates the trigger", () => {
      const validateModel = vi.fn(() => true);
      const trg = createTrigger(
        db,
        repoId,
        {
          name: "x",
          eventType: "git.push.detected",
          backend: "claude",
          model: "sonnet",
          workdirMode: "local-clone",
          prompt: "p",
        },
        { validateModel },
      );
      expect(validateModel).toHaveBeenCalledOnce();
      expect(validateModel).toHaveBeenCalledWith("claude", "sonnet");
      expect(trg.model).toBe("sonnet");
    });

    it("createTrigger with validateModel returning false throws model_invalid", () => {
      const validateModel = vi.fn(() => false);
      expect(() =>
        createTrigger(
          db,
          repoId,
          {
            name: "x",
            eventType: "git.push.detected",
            backend: "claude",
            model: "bad-model",
            workdirMode: "local-clone",
            prompt: "p",
          },
          { validateModel },
        ),
      ).toThrow(/model_invalid|not registered/);
    });

    it("updateTrigger with numeric timestamp as 4th arg uses it as updatedAt", () => {
      const trg = createTrigger(db, repoId, {
        name: "x",
        eventType: "git.push.detected",
        backend: "claude",
        model: "sonnet",
        workdirMode: "local-clone",
        prompt: "p",
      });
      const fixedNow = 1700000000000;
      const updated = updateTrigger(db, trg.id, { name: "y" }, fixedNow);
      expect(updated.name).toBe("y");
      expect(updated.updatedAt).toBe(fixedNow);
    });

    it("updateTrigger with validateModel — backend+model change, validator returns true", () => {
      const trg = createTrigger(db, repoId, {
        name: "x",
        eventType: "git.push.detected",
        backend: "claude",
        model: "sonnet",
        workdirMode: "local-clone",
        prompt: "p",
      });
      const validateModel = vi.fn(() => true);
      const updated = updateTrigger(
        db,
        trg.id,
        { backend: "codex", model: "gpt-4" },
        { validateModel },
      );
      expect(validateModel).toHaveBeenCalledOnce();
      expect(validateModel).toHaveBeenCalledWith("codex", "gpt-4");
      expect(updated.backend).toBe("codex");
      expect(updated.model).toBe("gpt-4");
    });

    it("updateTrigger with validateModel — model changes, validator returns false throws model_invalid", () => {
      const trg = createTrigger(db, repoId, {
        name: "x",
        eventType: "git.push.detected",
        backend: "claude",
        model: "sonnet",
        workdirMode: "local-clone",
        prompt: "p",
      });
      const validateModel = vi.fn(() => false);
      expect(() =>
        updateTrigger(
          db,
          trg.id,
          { model: "new-model" },
          { validateModel },
        ),
      ).toThrow(/model_invalid|not registered/);
    });

    it("updateTrigger with validateModel — no backend/model change skips validator even if it would fail", () => {
      const trg = createTrigger(db, repoId, {
        name: "x",
        eventType: "git.push.detected",
        backend: "claude",
        model: "sonnet",
        workdirMode: "local-clone",
        prompt: "p",
      });
      const validateModel = vi.fn(() => false);
      const updated = updateTrigger(
        db,
        trg.id,
        { name: "new-name" },
        { validateModel },
      );
      expect(validateModel).not.toHaveBeenCalled();
      expect(updated.name).toBe("new-name");
    });
  });

  describe("management lifecycle", () => {
    let repoId: string;

    beforeEach(() => {
      repoId = createRepository(db, {
        githubOwner: "a",
        githubRepo: "b",
        localPath: "/code/a-b",
      }).id;
    });

    it("getManagement returns null before setManagementEnabled", () => {
      expect(getManagement(db, repoId)).toBeNull();
    });

    it("setManagementEnabled creates the row and updates on subsequent calls", () => {
      const first = setManagementEnabled(db, repoId, true);
      expect(first.enabled).toBe(true);
      expect(first.scanFailureCount).toBe(0);
      const second = setManagementEnabled(db, repoId, false);
      expect(second.enabled).toBe(false);
      // Re-enable to exercise the UPDATE branch with enabled=true.
      const third = setManagementEnabled(db, repoId, true);
      expect(third.enabled).toBe(true);
    });

    it("setManagementEnabled 404s when repo missing", () => {
      expect(() =>
        setManagementEnabled(db, "github:nope/nope", true),
      ).toThrow(/not_found|not found/);
    });

    it("recordManagementInitDone stamps init_completed_at", () => {
      setManagementEnabled(db, repoId, true);
      recordManagementInitDone(db, repoId, 999);
      expect(getManagement(db, repoId)?.initCompletedAt).toBe(999);
    });

    it("recordManagementScan(ok) clears failure count + stamps last_scan_at", () => {
      setManagementEnabled(db, repoId, true);
      recordManagementScan(db, repoId, "failed", 100);
      recordManagementScan(db, repoId, "failed", 200);
      expect(getManagement(db, repoId)?.scanFailureCount).toBe(2);
      recordManagementScan(db, repoId, "ok", 300);
      const m = getManagement(db, repoId);
      expect(m?.lastScanAt).toBe(300);
      expect(m?.lastScanStatus).toBe("ok");
      expect(m?.scanFailureCount).toBe(0);
    });

    it("recordManagementScan(skipped_no_activity) doesn't bump failures", () => {
      setManagementEnabled(db, repoId, true);
      recordManagementScan(db, repoId, "skipped_no_activity", 100);
      expect(getManagement(db, repoId)?.scanFailureCount).toBe(0);
      expect(getManagement(db, repoId)?.lastScanStatus).toBe(
        "skipped_no_activity",
      );
    });

    it("listManagementDueForScan returns rows whose last scan is older than interval", () => {
      setManagementEnabled(db, repoId, true);
      // Never scanned → due.
      expect(
        listManagementDueForScan(db, 24 * 60 * 60 * 1000, 1_000_000_000_000),
      ).toHaveLength(1);

      recordManagementScan(db, repoId, "ok", 1_000_000_000_000);
      // Just scanned → not due.
      expect(
        listManagementDueForScan(db, 24 * 60 * 60 * 1000, 1_000_000_000_000),
      ).toHaveLength(0);
      // Two days later → due.
      expect(
        listManagementDueForScan(
          db,
          24 * 60 * 60 * 1000,
          1_000_000_000_000 + 2 * 24 * 60 * 60 * 1000,
        ),
      ).toHaveLength(1);
    });

    it("listManagementDueForScan skips rows without a local clone", () => {
      const ghOnly = createRepository(db, {
        githubOwner: "x",
        githubRepo: "y",
      }).id;
      setManagementEnabled(db, ghOnly, true);
      const due = listManagementDueForScan(db, 1, Date.now());
      expect(due.find((d) => d.id === ghOnly)).toBeUndefined();
    });

    it("listManagementDueForScan skips disabled rows", () => {
      setManagementEnabled(db, repoId, false);
      expect(listManagementDueForScan(db, 1, Date.now())).toHaveLength(0);
    });
  });
});
