import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventPriority } from "@aitne/shared";
import { applySchema } from "../db/schema.js";
import {
  normalizeGitWatchedRepos,
  queueGitProjectUpdate,
  queueMissingGitProjectInits,
  readGitProjectDocTemplate,
  repoDocContextFilePath,
  repoDocContextPath,
  repoDocTemplateName,
  resolveGitProjectTemplateRoot,
  seedGitProjectDocTemplates,
  type NormalizedGitWatchedRepo,
} from "./git-project-docs.js";
import type { GitEventClassification } from "../observers/git-event-classifier.js";

describe("git-project-docs", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "pa-git-project-docs-"));
    tempDirs.push(dir);
    return dir;
  }

  it("normalizes explicit watched repos and legacy gitRepos with stable unique slugs", () => {
    const repos = normalizeGitWatchedRepos({
      gitWatchedRepos: [
        {
          path: "/tmp/Personal Agent",
          slug: "Personal Agent",
          classification: "project",
          category: "personal",
          org: "local",
          accountAlias: "main",
          pollPriority: "high",
        },
      ],
      gitRepos: ["/tmp/Personal Agent", "/tmp/Personal Agent Clone"],
    });

    expect(repos).toHaveLength(2);
    expect(repos[0]).toMatchObject({
      path: "/tmp/Personal Agent",
      slug: "personal-agent",
      classification: "project",
      category: "personal",
      org: "local",
      accountAlias: "main",
      pollPriority: "high",
    });
    expect(repos[1]).toMatchObject({
      path: "/tmp/Personal Agent Clone",
      slug: "personal-agent-clone",
      classification: "repo-only",
      category: "other",
      pollPriority: "normal",
    });
    expect(repoDocContextPath(repos[0])).toBe("git/personal-agent/overview");
    expect(repoDocContextFilePath(repos[1])).toBe(
      "git/personal-agent-clone/overview.md",
    );
  });

  it("seeds user-editable templates without overwriting existing custom templates", () => {
    const dataDir = tempDir();
    const templatesDir = join(dataDir, "templates");
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(join(templatesDir, "project.md"), "custom project", "utf-8");

    seedGitProjectDocTemplates(dataDir, process.cwd());

    expect(readFileSync(join(templatesDir, "project.md"), "utf-8")).toBe(
      "custom project",
    );
    expect(readFileSync(join(templatesDir, "git-repo.md"), "utf-8")).toContain(
      "type: git-repo",
    );
  });

  it("queues missing init tasks and skips existing context files or pending duplicates", () => {
    const db = new Database(":memory:");
    applySchema(db);
    const dataDir = tempDir();
    const contextDir = join(dataDir, "context");
    mkdirSync(join(contextDir, "projects"), { recursive: true });
    seedGitProjectDocTemplates(dataDir, process.cwd());
    const [repo] = normalizeGitWatchedRepos({
      gitWatchedRepos: [
        {
          path: "/repo/personal-agent",
          classification: "project",
          category: "personal",
          pollPriority: "normal",
        },
      ],
      gitRepos: [],
    });

    expect(
      queueMissingGitProjectInits({
        db,
        contextDir,
        dataDir,
        workspaceDir: process.cwd(),
        repos: [repo],
        now: () => new Date("2026-04-30T12:00:00Z"),
      }),
    ).toBe(1);
    expect(
      queueMissingGitProjectInits({
        db,
        contextDir,
        dataDir,
        workspaceDir: process.cwd(),
        repos: [repo],
      }),
    ).toBe(0);

    const row = db
      .prepare("SELECT task_type, task_description, task_context FROM agent_schedule")
      .get() as {
        task_type: string;
        task_description: string;
        task_context: string;
      };
    const ctx = JSON.parse(row.task_context) as Record<string, unknown>;
    expect(row.task_type).toBe("git.project.init");
    expect(row.task_description).toContain("personal-agent");
    expect(ctx.processKey).toBe("git.project.init");
    expect(ctx.slug).toBe("personal-agent");
    expect(ctx.localPath).toBe("/repo/personal-agent");
    expect(ctx.overviewPath).toBe("git/personal-agent/overview.md");
    expect(ctx.journalPath).toBe("git/personal-agent/journal/2026-04-30.md");
    expect(ctx.contextPath).toBeUndefined();
    expect(ctx.templateContent).toBeUndefined();
    db.close();
  });

  it("merges pending update events and debounces recently completed updates", () => {
    const db = new Database(":memory:");
    applySchema(db);
    const dataDir = tempDir();
    seedGitProjectDocTemplates(dataDir, process.cwd());
    const [repo] = normalizeGitWatchedRepos({
      gitWatchedRepos: [
        {
          path: "/repo/app",
          classification: "project",
          category: "work",
          pollPriority: "normal",
        },
      ],
      gitRepos: [],
    });

    const first = gitEvent("git.push.detected", "push:main:aaa", {
      repoPath: "/repo/app",
      branch: "main",
      defaultBranch: "main",
    });
    const second = gitEvent("git.tag.created", "tag_created:v1:bbb", {
      repoPath: "/repo/app",
      tag: "v1",
    });

    expect(
      queueGitProjectUpdate({
        db,
        dataDir,
        workspaceDir: process.cwd(),
        repo,
        event: first,
        debounceMinutes: 15,
        now: () => new Date("2026-04-30T12:00:00Z"),
      }),
    ).toBe("queued");
    expect(
      queueGitProjectUpdate({
        db,
        dataDir,
        workspaceDir: process.cwd(),
        repo,
        event: second,
        debounceMinutes: 15,
        now: () => new Date("2026-04-30T12:01:00Z"),
      }),
    ).toBe("merged");

    const pending = db
      .prepare("SELECT id, task_context FROM agent_schedule WHERE task_type = 'git.project.update'")
      .get() as { id: number; task_context: string };
    const ctx = JSON.parse(pending.task_context) as { events: unknown[] };
    expect(ctx.events).toHaveLength(2);

    db.prepare("UPDATE agent_schedule SET status = 'completed' WHERE id = ?").run(
      pending.id,
    );
    expect(
      queueGitProjectUpdate({
        db,
        dataDir,
        workspaceDir: process.cwd(),
        repo,
        event: gitEvent("git.merge_to_default", "merge_to_default:main:ccc", {
          repoPath: "/repo/app",
          branch: "main",
          defaultBranch: "main",
        }),
        debounceMinutes: 15,
        now: () => new Date("2026-04-30T12:05:00Z"),
      }),
    ).toBe("debounced");

    expect(
      queueGitProjectUpdate({
        db,
        dataDir,
        workspaceDir: process.cwd(),
        repo,
        event: gitEvent("git.push.detected", "push:feature:ddd", {
          repoPath: "/repo/app",
          branch: "feature",
          defaultBranch: "main",
        }),
        debounceMinutes: 15,
      }),
    ).toBe("skipped");
    db.close();
  });

  it("dedups merges by (eventType, ref) so a redelivered observation does not pad the events array", () => {
    const db = new Database(":memory:");
    applySchema(db);
    const dataDir = tempDir();
    seedGitProjectDocTemplates(dataDir, process.cwd());
    const [repo] = normalizeGitWatchedRepos({
      gitWatchedRepos: [
        {
          path: "/repo/dedup",
          classification: "project",
          category: "personal",
          pollPriority: "normal",
        },
      ],
      gitRepos: [],
    });

    const event = gitEvent("git.merge_to_default", "merge_to_default:main:abc", {
      repoPath: "/repo/dedup",
      branch: "main",
      defaultBranch: "main",
    });
    expect(
      queueGitProjectUpdate({
        db,
        dataDir,
        workspaceDir: process.cwd(),
        repo,
        event,
        debounceMinutes: 15,
      }),
    ).toBe("queued");
    expect(
      queueGitProjectUpdate({
        db,
        dataDir,
        workspaceDir: process.cwd(),
        repo,
        event,
        debounceMinutes: 15,
      }),
    ).toBe("merged");

    const ctx = JSON.parse(
      (db.prepare(
        "SELECT task_context FROM agent_schedule WHERE task_type = 'git.project.update'",
      ).get() as { task_context: string }).task_context,
    ) as { events: unknown[] };
    expect(ctx.events).toHaveLength(1);
    db.close();
  });

  it("falls through to a fresh row when the merge UPDATE races the scheduler", () => {
    const db = new Database(":memory:");
    applySchema(db);
    const dataDir = tempDir();
    seedGitProjectDocTemplates(dataDir, process.cwd());
    const [repo] = normalizeGitWatchedRepos({
      gitWatchedRepos: [
        {
          path: "/repo/race",
          classification: "project",
          category: "work",
          pollPriority: "normal",
        },
      ],
      gitRepos: [],
    });

    expect(
      queueGitProjectUpdate({
        db,
        dataDir,
        workspaceDir: process.cwd(),
        repo,
        event: gitEvent("git.merge_to_default", "merge:main:1", {
          repoPath: "/repo/race",
          branch: "main",
          defaultBranch: "main",
        }),
        debounceMinutes: 15,
        now: () => new Date("2026-04-30T12:00:00Z"),
      }),
    ).toBe("queued");

    // Simulate the scheduler claiming the pending row between SELECT and
    // UPDATE — the merge UPDATE will match 0 rows, and the second event
    // must not be silently dropped onto the now-running session's stale
    // task_context. Marking the row 'completed' (status not pending,
    // not running) is the easiest way to flush a 0-change UPDATE without
    // also being caught by the running-status guard above.
    db.prepare(
      "UPDATE agent_schedule SET status = 'completed' WHERE task_type = 'git.project.update'",
    ).run();
    // Backdate the completed row so it falls outside the debounce window —
    // otherwise the fresh insert would be debounced by recentlyCompleted
    // and the race fix would be invisible. The race in production is between
    // a completing run and an arriving event, so this matches reality.
    db.prepare(
      "UPDATE agent_schedule SET scheduled_for = '2026-04-30 11:00:00' WHERE task_type = 'git.project.update'",
    ).run();

    expect(
      queueGitProjectUpdate({
        db,
        dataDir,
        workspaceDir: process.cwd(),
        repo,
        event: gitEvent("git.tag.created", "tag_created:v9:9", {
          repoPath: "/repo/race",
          tag: "v9",
        }),
        debounceMinutes: 15,
        now: () => new Date("2026-04-30T12:30:00Z"),
      }),
    ).toBe("queued");

    const rows = db
      .prepare(
        "SELECT status, task_context FROM agent_schedule WHERE task_type = 'git.project.update' ORDER BY id ASC",
      )
      .all() as Array<{ status: string; task_context: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[1].status).toBe("pending");
    const freshCtx = JSON.parse(rows[1].task_context) as { events: unknown[] };
    expect(freshCtx.events).toHaveLength(1);
    db.close();
  });

  it("caps the merged events array so a force-push burst cannot pad the prompt unbounded", () => {
    const db = new Database(":memory:");
    applySchema(db);
    const dataDir = tempDir();
    seedGitProjectDocTemplates(dataDir, process.cwd());
    const [repo] = normalizeGitWatchedRepos({
      gitWatchedRepos: [
        {
          path: "/repo/cap",
          classification: "project",
          category: "personal",
          pollPriority: "normal",
        },
      ],
      gitRepos: [],
    });

    for (let i = 0; i < 60; i++) {
      const status = queueGitProjectUpdate({
        db,
        dataDir,
        workspaceDir: process.cwd(),
        repo,
        event: gitEvent("git.merge_to_default", `merge_to_default:main:sha-${i}`, {
          repoPath: "/repo/cap",
          branch: "main",
          defaultBranch: "main",
        }),
        debounceMinutes: 15,
      });
      expect(status === "queued" || status === "merged").toBe(true);
    }

    const ctx = JSON.parse(
      (db.prepare(
        "SELECT task_context FROM agent_schedule WHERE task_type = 'git.project.update' AND status = 'pending'",
      ).get() as { task_context: string }).task_context,
    ) as { events: Array<{ ref: string }> };
    expect(ctx.events).toHaveLength(50);
    // Drop-oldest order: the most recent 50 should remain.
    expect(ctx.events[0].ref).toBe("merge_to_default:main:sha-10");
    expect(ctx.events.at(-1)?.ref).toBe("merge_to_default:main:sha-59");
    db.close();
  });

  it("repoDocTemplateName returns the project template name for project-classified repos", () => {
    // Mirror image of the repo-only assertion below — pins the truthy
    // branch of the classification ternary so a future rename of
    // PROJECT_TEMPLATE_NAME (currently `git-project.md`) breaks here.
    const [repo] = normalizeGitWatchedRepos({
      gitWatchedRepos: [
        {
          path: "/repo/active-project",
          classification: "project",
          category: "personal",
          pollPriority: "normal",
        },
      ],
      gitRepos: [],
    });
    expect(repo.classification).toBe("project");
    expect(repoDocTemplateName(repo)).toBe("project.md");
  });

  it("uses unified git overview path for non-project repos and resolves the bundled template root", () => {
    const dataDir = tempDir();
    seedGitProjectDocTemplates(dataDir, process.cwd());
    const [repo] = normalizeGitWatchedRepos({
      gitWatchedRepos: [],
      gitRepos: ["/tmp/scratch-repo"],
    });
    expect(repo.classification).toBe("repo-only");
    expect(repoDocTemplateName(repo)).toBe("git-repo.md");
    expect(repoDocContextFilePath(repo)).toBe("git/scratch-repo/overview.md");
    expect(repoDocContextPath(repo)).toBe("git/scratch-repo/overview");
    expect(
      readGitProjectDocTemplate(dataDir, process.cwd(), "repo-only"),
    ).toContain("type: git-repo");
    // Bundled root resolves under the workspace dir.
    expect(resolveGitProjectTemplateRoot(process.cwd())).toContain(
      "agent-assets/project-doc-templates",
    );
  });

  it("does not queue init when the unified overview already exists for the slug", () => {
    const db = new Database(":memory:");
    applySchema(db);
    const dataDir = tempDir();
    const contextDir = join(dataDir, "context");
    mkdirSync(join(contextDir, "git", "personal-agent"), { recursive: true });
    writeFileSync(
      join(contextDir, "git", "personal-agent", "overview.md"),
      "user-authored",
      "utf-8",
    );
    seedGitProjectDocTemplates(dataDir, process.cwd());
    const [repo] = normalizeGitWatchedRepos({
      gitWatchedRepos: [
        {
          path: "/repo/personal-agent",
          classification: "project",
          category: "personal",
          pollPriority: "normal",
        },
      ],
      gitRepos: [],
    });

    expect(
      queueMissingGitProjectInits({
        db,
        contextDir,
        dataDir,
        workspaceDir: process.cwd(),
        repos: [repo],
      }),
    ).toBe(0);
    expect(
      readFileSync(join(contextDir, "git", "personal-agent", "overview.md"), "utf-8"),
    ).toBe("user-authored");
  });

  it("disambiguates colliding slugs derived from the same basename across legacy gitRepos", () => {
    const repos = normalizeGitWatchedRepos({
      gitWatchedRepos: [],
      gitRepos: ["/tmp/proj-a/myapp", "/tmp/proj-b/myapp"],
    });
    expect(repos.map((r) => r.slug)).toEqual(["myapp", "myapp-2"]);
    expect(repos[0].classification).toBe("repo-only");
    expect(repos[0].category).toBe("other");
    expect(repos[0].pollPriority).toBe("normal");
  });

  it("strips a trailing .git suffix and falls back to 'repo' when the basename has no slug-safe characters", () => {
    const repos = normalizeGitWatchedRepos({
      gitWatchedRepos: [],
      gitRepos: ["/tmp/foo.git", "/tmp/###"],
    });
    expect(repos.map((r) => r.slug)).toEqual(["foo", "repo"]);
  });

  it("derives slugs from Windows path basenames", () => {
    const repos = normalizeGitWatchedRepos({
      gitWatchedRepos: [],
      gitRepos: ["C:\\Users\\me\\code\\foo.git", "D:/repos/bar"],
    });
    expect(repos.map((r) => r.slug)).toEqual(["foo", "bar"]);
  });

  it("expands a leading ~/ in repo paths and tolerates a config that omits one of gitRepos / gitWatchedRepos", () => {
    const reposFromTilde = normalizeGitWatchedRepos({
      gitWatchedRepos: [],
      gitRepos: ["~/some/relative/repo"],
    });
    expect(reposFromTilde[0].path.startsWith("~/")).toBe(false);
    expect(reposFromTilde[0].path.endsWith("/some/relative/repo")).toBe(true);

    const reposFromWindowsTilde = normalizeGitWatchedRepos({
      gitWatchedRepos: [],
      gitRepos: ["~\\some\\relative\\repo"],
    });
    expect(reposFromWindowsTilde[0].path.startsWith("~\\")).toBe(false);
    expect(reposFromWindowsTilde[0].slug).toBe("repo");

    expect(
      normalizeGitWatchedRepos({} as Parameters<typeof normalizeGitWatchedRepos>[0]),
    ).toEqual([]);
    expect(normalizeGitWatchedRepos({ gitWatchedRepos: [] } as Parameters<typeof normalizeGitWatchedRepos>[0])).toEqual([]);
    expect(normalizeGitWatchedRepos({ gitRepos: [] } as Parameters<typeof normalizeGitWatchedRepos>[0])).toEqual([]);
  });

  it("uses PA_GIT_PROJECT_TEMPLATES_DIR override and falls back to the bundled root when the workspace candidate is missing", () => {
    const overrideDir = tempDir();
    writeFileSync(
      join(overrideDir, "project.md"),
      "---\ntype: project\n---\n# override",
      "utf-8",
    );
    writeFileSync(join(overrideDir, "git-repo.md"), "type: git-repo", "utf-8");
    const prev = process.env.PA_GIT_PROJECT_TEMPLATES_DIR;
    process.env.PA_GIT_PROJECT_TEMPLATES_DIR = overrideDir;
    try {
      expect(resolveGitProjectTemplateRoot("/nonexistent/workspace")).toBe(
        overrideDir,
      );
    } finally {
      if (prev === undefined) delete process.env.PA_GIT_PROJECT_TEMPLATES_DIR;
      else process.env.PA_GIT_PROJECT_TEMPLATES_DIR = prev;
    }

    // No env override + workspaceCandidate missing → MODULE_DIR-based fallback path.
    expect(resolveGitProjectTemplateRoot("/nonexistent/workspace")).toContain(
      "agent-assets/project-doc-templates",
    );
  });

  it("seeds the embedded fallback template when no bundled file is reachable", () => {
    const dataDir = tempDir();
    const prev = process.env.PA_GIT_PROJECT_TEMPLATES_DIR;
    // Point the resolver at an empty directory so neither the project.md nor
    // the git-repo.md bundled file exists; the seeder must fall back to the
    // embedded constants.
    process.env.PA_GIT_PROJECT_TEMPLATES_DIR = tempDir();
    try {
      seedGitProjectDocTemplates(dataDir, "/nonexistent/workspace");
    } finally {
      if (prev === undefined) delete process.env.PA_GIT_PROJECT_TEMPLATES_DIR;
      else process.env.PA_GIT_PROJECT_TEMPLATES_DIR = prev;
    }
    const projectSeed = readFileSync(
      join(dataDir, "templates", "project.md"),
      "utf-8",
    );
    const repoSeed = readFileSync(
      join(dataDir, "templates", "git-repo.md"),
      "utf-8",
    );
    expect(projectSeed).toContain("type: project");
    expect(repoSeed).toContain("type: git-repo");
  });

  it("readGitProjectDocTemplate returns the bundled template when no user override exists, then the embedded fallback when no bundle exists either", () => {
    const dataDir = tempDir();
    // 1) No user override, but bundled root resolves to the workspace dir.
    expect(
      readGitProjectDocTemplate(dataDir, process.cwd(), "project"),
    ).toContain("type: project");
    expect(
      readGitProjectDocTemplate(dataDir, process.cwd(), "repo-only"),
    ).toContain("type: git-repo");

    // 2) No user override AND bundled root unreachable → embedded fallback.
    const prev = process.env.PA_GIT_PROJECT_TEMPLATES_DIR;
    process.env.PA_GIT_PROJECT_TEMPLATES_DIR = tempDir();
    try {
      const projectFallback = readGitProjectDocTemplate(
        tempDir(),
        "/nonexistent/workspace",
        "project",
      );
      const repoFallback = readGitProjectDocTemplate(
        tempDir(),
        "/nonexistent/workspace",
        "repo-only",
      );
      expect(projectFallback).toContain("type: project");
      expect(repoFallback).toContain("type: git-repo");
    } finally {
      if (prev === undefined) delete process.env.PA_GIT_PROJECT_TEMPLATES_DIR;
      else process.env.PA_GIT_PROJECT_TEMPLATES_DIR = prev;
    }
  });

  it("returns 'debounced' when an existing update for the repo is already running", () => {
    const db = new Database(":memory:");
    applySchema(db);
    const dataDir = tempDir();
    seedGitProjectDocTemplates(dataDir, process.cwd());
    const [repo] = normalizeGitWatchedRepos({
      gitWatchedRepos: [
        {
          path: "/repo/running",
          classification: "project",
          category: "personal",
          pollPriority: "normal",
        },
      ],
      gitRepos: [],
    });

    expect(
      queueGitProjectUpdate({
        db,
        dataDir,
        workspaceDir: process.cwd(),
        repo,
        event: gitEvent("git.merge_to_default", "merge:main:1", {
          repoPath: "/repo/running",
          branch: "main",
          defaultBranch: "main",
        }),
        debounceMinutes: 15,
      }),
    ).toBe("queued");
    db.prepare(
      "UPDATE agent_schedule SET status = 'running' WHERE task_type = 'git.project.update'",
    ).run();
    expect(
      queueGitProjectUpdate({
        db,
        dataDir,
        workspaceDir: process.cwd(),
        repo,
        event: gitEvent("git.tag.created", "tag_created:v1:2", {
          repoPath: "/repo/running",
          tag: "v1",
        }),
        debounceMinutes: 15,
      }),
    ).toBe("debounced");
    db.close();
  });

  it("warns about an orphan project file when a repo is downgraded to repo-only", () => {
    const db = new Database(":memory:");
    applySchema(db);
    const dataDir = tempDir();
    const contextDir = join(dataDir, "context");
    mkdirSync(join(contextDir, "projects"), { recursive: true });
    writeFileSync(
      join(contextDir, "projects", "scratch.md"),
      "leftover project file",
      "utf-8",
    );
    seedGitProjectDocTemplates(dataDir, process.cwd());
    const [repo] = normalizeGitWatchedRepos({
      gitWatchedRepos: [
        {
          path: "/repo/scratch",
          slug: "scratch",
          classification: "repo-only",
          category: "personal",
          pollPriority: "normal",
        },
      ],
      gitRepos: [],
    });

    expect(
      queueMissingGitProjectInits({
        db,
        contextDir,
        dataDir,
        workspaceDir: process.cwd(),
        repos: [repo],
      }),
    ).toBe(1);
    const row = db
      .prepare("SELECT task_context FROM agent_schedule WHERE task_type = 'git.project.init'")
      .get() as { task_context: string };
    const ctx = JSON.parse(row.task_context) as { overviewPath: string };
    expect(ctx.overviewPath).toBe("git/scratch/overview.md");
    db.close();
  });

  it("skips events that do not signal a project-doc update (force-push, branch-created, non-default-branch push)", () => {
    const db = new Database(":memory:");
    applySchema(db);
    const dataDir = tempDir();
    seedGitProjectDocTemplates(dataDir, process.cwd());
    const [repo] = normalizeGitWatchedRepos({
      gitWatchedRepos: [
        {
          path: "/repo/skip",
          classification: "project",
          category: "personal",
          pollPriority: "normal",
        },
      ],
      gitRepos: [],
    });

    const skipEvent = (
      eventType: string,
      payload: Record<string, unknown>,
    ): Extract<GitEventClassification, { kind: "observe" }> => ({
      kind: "observe",
      eventType: eventType as Extract<
        GitEventClassification,
        { kind: "observe" }
      >["eventType"],
      priority: EventPriority.LOW,
      changeType: "modified",
      actor: "unknown",
      source: `git:${payload.repoPath ?? "/repo/skip"}`,
      ref: `${eventType}:ref`,
      payload,
      emitEvent: false,
    });

    for (const evt of [
      skipEvent("git.push.force_pushed", {
        repoPath: "/repo/skip",
        branch: "main",
        defaultBranch: "main",
      }),
      skipEvent("git.branch.created", {
        repoPath: "/repo/skip",
        branch: "feature",
        defaultBranch: "main",
      }),
      skipEvent("git.push.detected", {
        repoPath: "/repo/skip",
        branch: "feature",
        defaultBranch: "main",
      }),
    ]) {
      expect(
        queueGitProjectUpdate({
          db,
          dataDir,
          workspaceDir: process.cwd(),
          repo,
          event: evt,
          debounceMinutes: 15,
        }),
      ).toBe("skipped");
    }
    db.close();
  });

  it("merges into a pending row that has no events array yet, ignoring malformed event entries", () => {
    const db = new Database(":memory:");
    applySchema(db);
    const dataDir = tempDir();
    seedGitProjectDocTemplates(dataDir, process.cwd());
    const [repo] = normalizeGitWatchedRepos({
      gitWatchedRepos: [
        {
          path: "/repo/no-events",
          classification: "project",
          category: "personal",
          pollPriority: "normal",
        },
      ],
      gitRepos: [],
    });

    // Plant TWO pending rows for the same repo. The first omits `events`
    // entirely (the `Array.isArray(existing.events)` false branch). The
    // second carries malformed entries (a primitive and an array — the
    // isGitProjectEventSummary false branches). Only the most-recently-
    // inserted one is targeted by the merge; doing them sequentially so
    // both branches are exercised.
    db.prepare(
      `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, task_context, correlation_id, model, status)
       VALUES (?, 'git.project.update', 'planted', ?, ?, NULL, 'pending')`,
    ).run(
      "2026-04-30 12:00:00",
      JSON.stringify({
        processKey: "git.project.update",
        repoPath: "/repo/no-events",
        // No `events` key at all.
      }),
      "cid-no-events-1",
    );

    expect(
      queueGitProjectUpdate({
        db,
        dataDir,
        workspaceDir: process.cwd(),
        repo,
        event: gitEvent("git.merge_to_default", "merge:main:first", {
          repoPath: "/repo/no-events",
          branch: "main",
          defaultBranch: "main",
        }),
        debounceMinutes: 15,
      }),
    ).toBe("merged");

    const firstCtx = JSON.parse(
      (db.prepare(
        "SELECT task_context FROM agent_schedule WHERE task_type = 'git.project.update' AND status = 'pending'",
      ).get() as { task_context: string }).task_context,
    ) as { events: Array<{ ref: string }> };
    expect(firstCtx.events).toHaveLength(1);
    expect(firstCtx.events[0].ref).toBe("merge:main:first");

    // Now overwrite the row with a malformed events array and merge again.
    db.prepare(
      `UPDATE agent_schedule SET task_context = ? WHERE correlation_id = ?`,
    ).run(
      JSON.stringify({
        processKey: "git.project.update",
        repoPath: "/repo/no-events",
        events: [42, ["not-a-summary"]],
      }),
      "cid-no-events-1",
    );

    expect(
      queueGitProjectUpdate({
        db,
        dataDir,
        workspaceDir: process.cwd(),
        repo,
        event: gitEvent("git.merge_to_default", "merge:main:second", {
          repoPath: "/repo/no-events",
          branch: "main",
          defaultBranch: "main",
        }),
        debounceMinutes: 15,
      }),
    ).toBe("merged");

    const secondCtx = JSON.parse(
      (db.prepare(
        "SELECT task_context FROM agent_schedule WHERE task_type = 'git.project.update' AND status = 'pending'",
      ).get() as { task_context: string }).task_context,
    ) as { events: Array<{ ref: string }> };
    // Primitives and arrays are dropped by isGitProjectEventSummary; the
    // freshly-merged event is the only valid summary that survives.
    expect(secondCtx.events).toHaveLength(1);
    expect(secondCtx.events[0].ref).toBe("merge:main:second");
    db.close();
  });

  it("ignores corrupt or non-object task_context rows when scanning prior schedule entries", () => {
    const db = new Database(":memory:");
    applySchema(db);
    const dataDir = tempDir();
    seedGitProjectDocTemplates(dataDir, process.cwd());
    const [repo] = normalizeGitWatchedRepos({
      gitWatchedRepos: [
        {
          path: "/repo/corrupt",
          classification: "project",
          category: "personal",
          pollPriority: "normal",
        },
      ],
      gitRepos: [],
    });

    // Plant rows whose task_context is invalid JSON, valid JSON but an array,
    // and a NULL — none should derail the scanner. None of them carry
    // `repoPath`, so they cannot match the running/pending filters.
    db.prepare(
      `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, task_context, correlation_id, model, status)
       VALUES ('2026-04-30 11:00:00', 'git.project.update', 'corrupt', 'not json', 'cid-1', NULL, 'pending'),
              ('2026-04-30 11:01:00', 'git.project.update', 'array', '["x"]', 'cid-2', NULL, 'completed'),
              ('2026-04-30 11:02:00', 'git.project.update', 'null', NULL, 'cid-3', NULL, 'completed')`,
    ).run();

    expect(
      queueGitProjectUpdate({
        db,
        dataDir,
        workspaceDir: process.cwd(),
        repo,
        event: gitEvent("git.merge_to_default", "merge:main:zzz", {
          repoPath: "/repo/corrupt",
          branch: "main",
          defaultBranch: "main",
        }),
        debounceMinutes: 15,
      }),
    ).toBe("queued");
    db.close();
  });

  it("schedules init for the new classification when the prior-classification file is the only one present", () => {
    const db = new Database(":memory:");
    applySchema(db);
    const dataDir = tempDir();
    const contextDir = join(dataDir, "context");
    mkdirSync(join(contextDir, "git-repos"), { recursive: true });
    writeFileSync(
      join(contextDir, "git-repos", "scratch.md"),
      "leftover repo-only file",
      "utf-8",
    );
    seedGitProjectDocTemplates(dataDir, process.cwd());
    const [repo] = normalizeGitWatchedRepos({
      gitWatchedRepos: [
        {
          path: "/repo/scratch",
          slug: "scratch",
          classification: "project",
          category: "personal",
          pollPriority: "normal",
        },
      ],
      gitRepos: [],
    });

    expect(
      queueMissingGitProjectInits({
        db,
        contextDir,
        dataDir,
        workspaceDir: process.cwd(),
        repos: [repo],
      }),
    ).toBe(1);
    const row = db
      .prepare("SELECT task_context FROM agent_schedule WHERE task_type = 'git.project.init'")
      .get() as { task_context: string };
    const ctx = JSON.parse(row.task_context) as { overviewPath: string };
    expect(ctx.overviewPath).toBe("git/scratch/overview.md");
    // The prior-classification file is left in place; the daemon does not
    // touch user-authored content automatically.
    expect(
      readFileSync(join(contextDir, "git-repos", "scratch.md"), "utf-8"),
    ).toBe("leftover repo-only file");
  });

  it("deduplicates init tasks by repositoryId and embeds repositoryId in the task context", () => {
    // Exercises:
    //  • buildBaseTaskContext — `...(repo.repositoryId ? { repositoryId } : {})`
    //    truthy branch (repositoryId included in INSERT context)
    //  • addScheduleKeysForRepo — `if (repo.repositoryId) keys.add(...)` truthy branch
    //  • hasExistingScheduleForRepo — `repo.repositoryId ? keys.has(repo.repositoryId) : false`
    //    truthy branch (second call deduplicates via repositoryId, not path)
    //  • scheduleRepoKeys — `typeof ctx.repositoryId === "string" ? ctx.repositoryId : null`
    //    truthy branch (repositoryId parsed out of stored task_context)
    const db = new Database(":memory:");
    applySchema(db);
    const dataDir = tempDir();
    const contextDir = join(dataDir, "context");
    mkdirSync(join(contextDir, "git"), { recursive: true });
    seedGitProjectDocTemplates(dataDir, process.cwd());

    const repo: NormalizedGitWatchedRepo = {
      path: "/repo/with-repo-id",
      slug: "with-repo-id",
      classification: "project",
      category: "personal",
      pollPriority: "normal",
      repositoryId: "repo-uuid-abc",
    };

    expect(
      queueMissingGitProjectInits({
        db,
        contextDir,
        dataDir,
        workspaceDir: process.cwd(),
        repos: [repo],
        now: () => new Date("2026-04-30T12:00:00Z"),
      }),
    ).toBe(1);

    const row = db
      .prepare("SELECT task_context FROM agent_schedule WHERE task_type = 'git.project.init'")
      .get() as { task_context: string };
    const ctx = JSON.parse(row.task_context) as Record<string, unknown>;
    // The repositoryId must flow through buildBaseTaskContext into the stored context.
    expect(ctx.repositoryId).toBe("repo-uuid-abc");
    expect(ctx.localPath).toBe("/repo/with-repo-id");

    // A second call with the same repo must be deduplicated via repositoryId
    // (not path). The DB query populates existingRepoKeys via scheduleRepoKeys
    // which reads ctx.repositoryId; hasExistingScheduleForRepo then returns
    // true via keys.has(repo.repositoryId) — the repositoryId-first branch.
    expect(
      queueMissingGitProjectInits({
        db,
        contextDir,
        dataDir,
        workspaceDir: process.cwd(),
        repos: [repo],
      }),
    ).toBe(0);

    db.close();
  });

  it("applies ?? defaults for classification, category, and pollPriority when gitWatchedRepos entry omits them", () => {
    // Lines 247, 248, 253: raw.classification / raw.category / raw.pollPriority
    // are undefined → ?? right branch fires, falling back to legacyDefaults.
    const repos = normalizeGitWatchedRepos({
      gitWatchedRepos: [{ path: "/repo/defaults-only" }],
      gitRepos: [],
    });
    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({
      slug: "defaults-only",
      classification: "repo-only",
      category: "other",
      pollPriority: "normal",
      pollIntervalSec: null,
      githubRepo: null,
      repositoryId: undefined,
    });
  });

  it("slugifyRepoPath ?? branch: falls back to the trimmed string when path segments are empty", () => {
    // Line 193: "/" → trimmed="" → segments=[] → ?? "" → slugifySegment("") → "repo"
    const repos = normalizeGitWatchedRepos({ gitWatchedRepos: [], gitRepos: ["/"] });
    expect(repos).toHaveLength(1);
    expect(repos[0].slug).toBe("repo");
  });

  it("scheduleRepoKeys handles legacy repoPath rows and init rows with no localPath", () => {
    // Line 621 truthy: a git.project.init row whose task_context carries
    //   repoPath (pre-unified format) — scheduleRepoKeys returns the path and
    //   queueMissingGitProjectInits deduplicates against it.
    // Line 620 falsy: a row whose task_context has no localPath and no repoPath
    //   — scheduleRepoKeys returns null for that slot (filtered out), and does
    //   not block inits for unrelated repos.
    const db = new Database(":memory:");
    applySchema(db);
    const dataDir = tempDir();
    const contextDir = join(dataDir, "context");
    mkdirSync(join(contextDir, "git"), { recursive: true });
    seedGitProjectDocTemplates(dataDir, process.cwd());

    // Legacy row: repoPath present, localPath absent — exercises line 621 truthy.
    db.prepare(
      `INSERT INTO agent_schedule
         (scheduled_for, task_type, task_description, task_context, correlation_id, model, status)
       VALUES ('2026-04-30 11:00:00', 'git.project.init', 'legacy', ?, 'cid-repopath', NULL, 'pending')`,
    ).run(JSON.stringify({ processKey: "git.project.init", repoPath: "/repo/legacy-path" }));

    // Corrupt row: no localPath, no repoPath — exercises line 620 falsy → null.
    db.prepare(
      `INSERT INTO agent_schedule
         (scheduled_for, task_type, task_description, task_context, correlation_id, model, status)
       VALUES ('2026-04-30 11:01:00', 'git.project.init', 'no-path', ?, 'cid-no-path', NULL, 'pending')`,
    ).run(JSON.stringify({ processKey: "git.project.init" }));

    // Repo whose path matches the legacy repoPath row — must be deduped (0 inserted).
    const [legacyRepo] = normalizeGitWatchedRepos({
      gitWatchedRepos: [],
      gitRepos: ["/repo/legacy-path"],
    });
    expect(
      queueMissingGitProjectInits({
        db,
        contextDir,
        dataDir,
        workspaceDir: process.cwd(),
        repos: [legacyRepo],
      }),
    ).toBe(0);

    // An unrelated repo is not in the existing keys — must still be queued.
    const [unrelated] = normalizeGitWatchedRepos({
      gitWatchedRepos: [
        {
          path: "/repo/unrelated",
          classification: "project",
          category: "personal",
          pollPriority: "normal",
        },
      ],
      gitRepos: [],
    });
    expect(
      queueMissingGitProjectInits({
        db,
        contextDir,
        dataDir,
        workspaceDir: process.cwd(),
        repos: [unrelated],
      }),
    ).toBe(1);

    db.close();
  });

  it("matches pending update rows by repositoryId so the per-repo dedup works after a rename or path change", () => {
    // Exercises matchesScheduleForRepo:
    //   `if (repo.repositoryId && ctx.repositoryId === repo.repositoryId) return true`
    // The row is inserted with repositoryId in task_context (via buildBaseTaskContext).
    // The second queueGitProjectUpdate call finds it via the repositoryId fast-path
    // and merges instead of inserting a duplicate.
    const db = new Database(":memory:");
    applySchema(db);
    const dataDir = tempDir();
    seedGitProjectDocTemplates(dataDir, process.cwd());

    const repo: NormalizedGitWatchedRepo = {
      path: "/repo/by-id",
      slug: "by-id",
      classification: "project",
      category: "work",
      pollPriority: "normal",
      repositoryId: "repo-uuid-xyz",
    };

    expect(
      queueGitProjectUpdate({
        db,
        dataDir,
        workspaceDir: process.cwd(),
        repo,
        event: gitEvent("git.merge_to_default", "merge:main:sha-first", {
          repoPath: "/repo/by-id",
          branch: "main",
          defaultBranch: "main",
        }),
        debounceMinutes: 15,
        now: () => new Date("2026-04-30T12:00:00Z"),
      }),
    ).toBe("queued");

    const pending = db
      .prepare("SELECT task_context FROM agent_schedule WHERE task_type = 'git.project.update' AND status = 'pending'")
      .get() as { task_context: string };
    const insertedCtx = JSON.parse(pending.task_context) as Record<string, unknown>;
    expect(insertedCtx.repositoryId).toBe("repo-uuid-xyz");

    // Second call: matchesScheduleForRepo hits the `ctx.repositoryId === repo.repositoryId`
    // early-return path and the event is merged into the existing pending row.
    expect(
      queueGitProjectUpdate({
        db,
        dataDir,
        workspaceDir: process.cwd(),
        repo,
        event: gitEvent("git.tag.created", "tag:v1:sha-second", {
          repoPath: "/repo/by-id",
          tag: "v1",
        }),
        debounceMinutes: 15,
        now: () => new Date("2026-04-30T12:01:00Z"),
      }),
    ).toBe("merged");

    const rows = db
      .prepare("SELECT task_context FROM agent_schedule WHERE task_type = 'git.project.update'")
      .all() as Array<{ task_context: string }>;
    expect(rows).toHaveLength(1);
    const mergedCtx = JSON.parse(rows[0].task_context) as { events: unknown[] };
    expect(mergedCtx.events).toHaveLength(2);

    db.close();
  });
});

function gitEvent(
  eventType: Extract<
    Extract<GitEventClassification, { kind: "observe" }>["eventType"],
    "git.push.detected" | "git.tag.created" | "git.merge_to_default"
  >,
  ref: string,
  payload: Record<string, unknown>,
): Extract<GitEventClassification, { kind: "observe" }> {
  return {
    kind: "observe",
    eventType,
    priority: EventPriority.LOW,
    changeType: "modified",
    actor: "unknown",
    source: `git:${payload.repoPath ?? "/repo/app"}`,
    ref,
    payload,
    emitEvent: false,
  };
}
