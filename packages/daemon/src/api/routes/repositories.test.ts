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
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig } from "../../config.js";
import { EventBus } from "../../core/event-bus.js";
import { applySchema } from "../../db/schema.js";
import { createRepository } from "../../db/repositories-store.js";
import { createRepositoriesRoutes } from "./repositories.js";

describe("repositories routes daily management", () => {
  let db: Database.Database;
  let root: string;
  let repoDir: string;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    root = mkdtempSync(join(tmpdir(), "pa-repositories-route-"));
    repoDir = join(root, "repo");
    mkdirSync(repoDir, { recursive: true });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test User"]);
    git(["config", "commit.gpgsign", "false"]);
    commitFile("README.md", "# Widgets\n", "Initial commit");
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  function git(args: string[], env?: NodeJS.ProcessEnv): string {
    return execFileSync("git", args, {
      cwd: repoDir,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
  }

  function commitFile(file: string, body: string, message: string): void {
    writeFileSync(join(repoDir, file), body, "utf-8");
    git(["add", file]);
    const now = new Date().toISOString();
    git(["commit", "-q", "-m", message], {
      GIT_AUTHOR_DATE: now,
      GIT_COMMITTER_DATE: now,
    });
  }

  function app() {
    return createRepositoriesRoutes({
      db,
      eventBus: new EventBus(100),
      config: {
        dataDir: root,
        timezone: "UTC",
      } as unknown as AgentConfig,
    });
  }

  it("Run init now writes the overview markdown in-process", async () => {
    const repo = createRepository(db, {
      githubOwner: "acme",
      githubRepo: "widgets",
      localPath: repoDir,
      displayName: "Widgets",
      classification: "project",
      category: "work",
    });

    const response = await app().request(
      `/repositories/${encodeURIComponent(repo.id)}/management/init`,
      { method: "POST" },
    );
    const body = await response.json() as { status: string; overviewPath: string };

    expect(response.status).toBe(200);
    expect(body.status).toBe("completed");
    expect(body.overviewPath).toBe("git/widgets/overview.md");
    const overviewPath = join(root, "context", "git", "widgets", "overview.md");
    expect(readFileSync(overviewPath, "utf-8")).toContain("Initial commit");
  });

  it("Run init now auto-enqueues an architecture refresh agent_schedule row", async () => {
    const repo = createRepository(db, {
      githubOwner: "acme",
      githubRepo: "widgets",
      localPath: repoDir,
      displayName: "Widgets",
      classification: "project",
      category: "work",
    });

    const response = await app().request(
      `/repositories/${encodeURIComponent(repo.id)}/management/init`,
      { method: "POST" },
    );
    const body = (await response.json()) as {
      status: string;
      result: string;
      readmeCopiedTo: string | null;
      architectureScheduleId: number | null;
    };

    expect(response.status).toBe(200);
    expect(body.result).toBe("written");
    expect(body.readmeCopiedTo).toBe("git/widgets/README.md");
    expect(body.architectureScheduleId).not.toBeNull();
    const row = db
      .prepare(
        `SELECT task_type, task_context, status FROM agent_schedule WHERE id = ?`,
      )
      .get(body.architectureScheduleId!) as {
        task_type: string;
        task_context: string;
        status: string;
      };
    expect(row.task_type).toBe("git.project.refresh_architecture");
    expect(row.status).toBe("pending");
    const ctx = JSON.parse(row.task_context) as Record<string, unknown>;
    expect(ctx.processKey).toBe("git.project.refresh_architecture");
    expect(ctx.repositoryId).toBe(repo.id);
    expect(ctx.localPath).toBe(repoDir);

    // Second init must be idempotent: it returns 'exists' (the skeleton
    // is already written) and reuses the in-flight refresh row instead
    // of inserting a duplicate. The user gets the same schedule id back
    // so the dashboard can keep polling status, and `agent_schedule`
    // still has exactly one `git.project.refresh_architecture` row for
    // this repository.
    const second = await app().request(
      `/repositories/${encodeURIComponent(repo.id)}/management/init`,
      { method: "POST" },
    );
    const second_body = (await second.json()) as {
      result: string;
      architectureScheduleId: number | null;
    };
    expect(second_body.result).toBe("exists");
    expect(second_body.architectureScheduleId).toBe(body.architectureScheduleId);
    const rowCount = (db
      .prepare(
        `SELECT COUNT(*) AS c
           FROM agent_schedule
          WHERE task_type = 'git.project.refresh_architecture'
            AND json_extract(task_context, '$.repositoryId') = ?`,
      )
      .get(repo.id) as { c: number }).c;
    expect(rowCount).toBe(1);
  });

  it("Re-init after a previous refresh failed re-enqueues a new row", async () => {
    const repo = createRepository(db, {
      githubOwner: "acme",
      githubRepo: "widgets",
      localPath: repoDir,
      displayName: "Widgets",
      classification: "project",
      category: "work",
    });

    // First init writes skeleton + enqueues row #1.
    const first = await app().request(
      `/repositories/${encodeURIComponent(repo.id)}/management/init`,
      { method: "POST" },
    );
    const firstBody = (await first.json()) as {
      result: string;
      architectureScheduleId: number | null;
    };
    expect(firstBody.result).toBe("written");
    expect(firstBody.architectureScheduleId).not.toBeNull();

    // Simulate the agent run completing without the architecture write
    // landing — e.g. a transient task-flow regression that left the
    // overview's `architecture_status` at 'pending'. The schedule row
    // has settled (no longer pending/running) so it does not block a
    // recovery enqueue.
    db.prepare(`UPDATE agent_schedule SET status = 'failed' WHERE id = ?`).run(
      firstBody.architectureScheduleId!,
    );

    const second = await app().request(
      `/repositories/${encodeURIComponent(repo.id)}/management/init`,
      { method: "POST" },
    );
    const secondBody = (await second.json()) as {
      result: string;
      architectureScheduleId: number | null;
    };
    expect(secondBody.result).toBe("exists");
    expect(secondBody.architectureScheduleId).not.toBeNull();
    expect(secondBody.architectureScheduleId).not.toBe(
      firstBody.architectureScheduleId,
    );
    const recoveryRow = db
      .prepare(
        `SELECT task_type, status FROM agent_schedule WHERE id = ?`,
      )
      .get(secondBody.architectureScheduleId!) as {
        task_type: string;
        status: string;
      };
    expect(recoveryRow.task_type).toBe("git.project.refresh_architecture");
    expect(recoveryRow.status).toBe("pending");
  });

  it("Re-init does not enqueue when the overview's frontmatter is missing or malformed", async () => {
    const repo = createRepository(db, {
      githubOwner: "acme",
      githubRepo: "widgets",
      localPath: repoDir,
      displayName: "Widgets",
      classification: "project",
      category: "work",
    });

    await app().request(
      `/repositories/${encodeURIComponent(repo.id)}/management/init`,
      { method: "POST" },
    );

    // Simulate a hand-edited overview that has lost its YAML
    // frontmatter. `runRepositoryArchitectureSectionReplace` only
    // promotes the `architecture_status` field on files that already
    // start with `---\n`, so a refresh agent run cannot move this file
    // out of "frontmatter-less" state. Treating the missing field as
    // `pending` would queue a fresh refresh on every init click — an
    // unbounded loop bounded only by the in-flight guard. The init
    // flow must instead leave hand-managed files alone and defer a
    // re-run to the explicit "Refresh architecture" endpoint.
    const overviewPath = join(root, "context", "git", "widgets", "overview.md");
    writeFileSync(
      overviewPath,
      "# Widgets\n\n## Architecture\n\nManually authored.\n",
      "utf-8",
    );
    db.prepare(
      `UPDATE agent_schedule SET status = 'completed'
        WHERE task_type = 'git.project.refresh_architecture'`,
    ).run();
    const beforeRowCount = (db
      .prepare(
        `SELECT COUNT(*) AS c FROM agent_schedule
          WHERE task_type = 'git.project.refresh_architecture'
            AND json_extract(task_context, '$.repositoryId') = ?`,
      )
      .get(repo.id) as { c: number }).c;

    const second = await app().request(
      `/repositories/${encodeURIComponent(repo.id)}/management/init`,
      { method: "POST" },
    );
    const secondBody = (await second.json()) as {
      result: string;
      architectureScheduleId: number | null;
    };
    expect(secondBody.result).toBe("exists");
    expect(secondBody.architectureScheduleId).toBeNull();
    const afterRowCount = (db
      .prepare(
        `SELECT COUNT(*) AS c FROM agent_schedule
          WHERE task_type = 'git.project.refresh_architecture'
            AND json_extract(task_context, '$.repositoryId') = ?`,
      )
      .get(repo.id) as { c: number }).c;
    expect(afterRowCount).toBe(beforeRowCount);
  });

  it("Re-init does not enqueue when the frontmatter is unterminated", async () => {
    const repo = createRepository(db, {
      githubOwner: "acme",
      githubRepo: "widgets",
      localPath: repoDir,
      displayName: "Widgets",
      classification: "project",
      category: "work",
    });

    await app().request(
      `/repositories/${encodeURIComponent(repo.id)}/management/init`,
      { method: "POST" },
    );

    // Truncate the file so it begins with `---\n` but never closes the
    // frontmatter. `readArchitectureStatus` should not infer a status
    // from a half-written document — if the file is broken the init
    // flow leaves recovery to the explicit refresh button.
    const overviewPath = join(root, "context", "git", "widgets", "overview.md");
    writeFileSync(
      overviewPath,
      "---\narchitecture_status: pending\n# no closing fence\n",
      "utf-8",
    );
    db.prepare(
      `UPDATE agent_schedule SET status = 'completed'
        WHERE task_type = 'git.project.refresh_architecture'`,
    ).run();

    const second = await app().request(
      `/repositories/${encodeURIComponent(repo.id)}/management/init`,
      { method: "POST" },
    );
    const secondBody = (await second.json()) as {
      result: string;
      architectureScheduleId: number | null;
    };
    expect(secondBody.result).toBe("exists");
    expect(secondBody.architectureScheduleId).toBeNull();
  });

  it("Re-init does not enqueue when the architecture_status field has an unrecognized value", async () => {
    const repo = createRepository(db, {
      githubOwner: "acme",
      githubRepo: "widgets",
      localPath: repoDir,
      displayName: "Widgets",
      classification: "project",
      category: "work",
    });

    await app().request(
      `/repositories/${encodeURIComponent(repo.id)}/management/init`,
      { method: "POST" },
    );

    // Hand-tweaked the field to a value the parser does not recognize.
    // The init flow refuses to interpret unknown statuses to avoid
    // re-enqueueing forever on a state we don't control.
    const overviewPath = join(root, "context", "git", "widgets", "overview.md");
    const original = readFileSync(overviewPath, "utf-8");
    writeFileSync(
      overviewPath,
      original.replace("architecture_status: pending", "architecture_status: stale"),
      "utf-8",
    );
    db.prepare(
      `UPDATE agent_schedule SET status = 'completed'
        WHERE task_type = 'git.project.refresh_architecture'`,
    ).run();

    const second = await app().request(
      `/repositories/${encodeURIComponent(repo.id)}/management/init`,
      { method: "POST" },
    );
    const secondBody = (await second.json()) as {
      result: string;
      architectureScheduleId: number | null;
    };
    expect(secondBody.result).toBe("exists");
    expect(secondBody.architectureScheduleId).toBeNull();
  });

  it("Re-init after a refresh completed does not enqueue another row", async () => {
    const repo = createRepository(db, {
      githubOwner: "acme",
      githubRepo: "widgets",
      localPath: repoDir,
      displayName: "Widgets",
      classification: "project",
      category: "work",
    });

    await app().request(
      `/repositories/${encodeURIComponent(repo.id)}/management/init`,
      { method: "POST" },
    );

    // Apply a real architecture body so the file's `architecture_status`
    // flips to `complete` via the surgical merge endpoint — that's the
    // signal init uses to know an analysis already landed and a fresh
    // agent run would just burn quota.
    const replace = await app().request(
      `/repositories/${encodeURIComponent(repo.id)}/architecture-section`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          markdown: "### Modules\n\n- `widgets/core`: runtime kernel.\n",
        }),
      },
    );
    expect(replace.status).toBe(200);

    const third = await app().request(
      `/repositories/${encodeURIComponent(repo.id)}/management/init`,
      { method: "POST" },
    );
    const thirdBody = (await third.json()) as {
      result: string;
      architectureScheduleId: number | null;
    };
    expect(thirdBody.result).toBe("exists");
    expect(thirdBody.architectureScheduleId).toBeNull();
  });

  it("POST refresh-architecture enqueues a new agent_schedule row", async () => {
    const repo = createRepository(db, {
      githubOwner: "acme",
      githubRepo: "widgets",
      localPath: repoDir,
      displayName: "Widgets",
      classification: "project",
      category: "work",
    });

    const response = await app().request(
      `/repositories/${encodeURIComponent(repo.id)}/management/refresh-architecture`,
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      scheduleId: number;
    };
    expect(body.status).toBe("scheduled");
    expect(typeof body.scheduleId).toBe("number");
    const row = db
      .prepare(`SELECT task_type FROM agent_schedule WHERE id = ?`)
      .get(body.scheduleId) as { task_type: string };
    expect(row.task_type).toBe("git.project.refresh_architecture");
  });

  it("PUT architecture-section replaces the section and updates frontmatter", async () => {
    const repo = createRepository(db, {
      githubOwner: "acme",
      githubRepo: "widgets",
      localPath: repoDir,
      displayName: "Widgets",
      classification: "project",
      category: "work",
    });

    // init first to materialize overview.md.
    await app().request(
      `/repositories/${encodeURIComponent(repo.id)}/management/init`,
      { method: "POST" },
    );

    const newSection = "### Modules\n\n- `packages/widget`: core widget runtime.\n";
    const response = await app().request(
      `/repositories/${encodeURIComponent(repo.id)}/architecture-section`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ markdown: newSection }),
      },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      overviewPath: string;
      refreshedAt: string;
    };
    expect(body.status).toBe("written");
    expect(body.overviewPath).toBe("git/widgets/overview.md");

    const overview = readFileSync(
      join(root, "context", "git", "widgets", "overview.md"),
      "utf-8",
    );
    expect(overview).toContain("### Modules");
    expect(overview).toContain("packages/widget");
    expect(overview).toContain("architecture_status: complete");
    expect(overview).toContain("## Notable Changes");
  });

  it("PUT architecture-section rejects malformed bodies", async () => {
    const repo = createRepository(db, {
      githubOwner: "acme",
      githubRepo: "widgets",
      localPath: repoDir,
      displayName: "Widgets",
      classification: "project",
      category: "work",
    });

    const response = await app().request(
      `/repositories/${encodeURIComponent(repo.id)}/architecture-section`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ markdown: "" }),
      },
    );
    expect(response.status).toBe(400);
  });

  it("POST refresh-architecture returns 404 for an unknown repository", async () => {
    const response = await app().request(
      `/repositories/does-not-exist/management/refresh-architecture`,
      { method: "POST" },
    );
    expect(response.status).toBe(404);
  });

  it("POST refresh-architecture returns 400 when the repo has no local clone", async () => {
    const repo = createRepository(db, {
      githubOwner: "acme",
      githubRepo: "remote-only",
      localPath: null,
      displayName: "Remote only",
      classification: "repo-only",
      category: "work",
    });
    const response = await app().request(
      `/repositories/${encodeURIComponent(repo.id)}/management/refresh-architecture`,
      { method: "POST" },
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("local_clone_required");
  });

  it("POST refresh-architecture is idempotent against an in-flight row", async () => {
    const repo = createRepository(db, {
      githubOwner: "acme",
      githubRepo: "widgets",
      localPath: repoDir,
      displayName: "Widgets",
      classification: "project",
      category: "work",
    });

    const first = await app().request(
      `/repositories/${encodeURIComponent(repo.id)}/management/refresh-architecture`,
      { method: "POST" },
    );
    const firstBody = (await first.json()) as { scheduleId: number };
    expect(first.status).toBe(200);

    // Second call while first row is still pending — must not insert another row.
    const second = await app().request(
      `/repositories/${encodeURIComponent(repo.id)}/management/refresh-architecture`,
      { method: "POST" },
    );
    expect(second.status).toBe(409);
    const secondBody = (await second.json()) as {
      error: string;
      scheduleId: number;
      status: string;
    };
    expect(secondBody.error).toBe("already_in_flight");
    expect(secondBody.scheduleId).toBe(firstBody.scheduleId);
    expect(secondBody.status).toBe("pending");

    // Verify the table really only has one row for this repo.
    const count = (db
      .prepare(
        `SELECT COUNT(*) AS c FROM agent_schedule WHERE task_type = ?`,
      )
      .get("git.project.refresh_architecture") as { c: number }).c;
    expect(count).toBe(1);

    // Once the previous row completes, a fresh enqueue is allowed again.
    db.prepare(
      `UPDATE agent_schedule SET status = 'completed' WHERE id = ?`,
    ).run(firstBody.scheduleId);

    const third = await app().request(
      `/repositories/${encodeURIComponent(repo.id)}/management/refresh-architecture`,
      { method: "POST" },
    );
    expect(third.status).toBe(200);
  });

  it("POST refresh-architecture re-copies README into the slug directory", async () => {
    const repo = createRepository(db, {
      githubOwner: "acme",
      githubRepo: "widgets",
      localPath: repoDir,
      displayName: "Widgets",
      classification: "project",
      category: "work",
    });
    // Mutate the repo's README; the daemon should mirror the new content.
    writeFileSync(join(repoDir, "README.md"), "# Updated\n", "utf-8");
    const response = await app().request(
      `/repositories/${encodeURIComponent(repo.id)}/management/refresh-architecture`,
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    const mirrored = readFileSync(
      join(root, "context", "git", "widgets", "README.md"),
      "utf-8",
    );
    expect(mirrored).toBe("# Updated\n");
  });

  it("PUT architecture-section returns 404 for an unknown repository", async () => {
    const response = await app().request(
      `/repositories/does-not-exist/architecture-section`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ markdown: "### x\n- y\n" }),
      },
    );
    expect(response.status).toBe(404);
  });

  it("PUT architecture-section returns 409 when overview.md is missing", async () => {
    const repo = createRepository(db, {
      githubOwner: "acme",
      githubRepo: "widgets",
      localPath: repoDir,
      displayName: "Widgets",
      classification: "project",
      category: "work",
    });
    // No init — overview.md is absent.
    const response = await app().request(
      `/repositories/${encodeURIComponent(repo.id)}/architecture-section`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ markdown: "### Modules\n\n- a\n" }),
      },
    );
    expect(response.status).toBe(409);
  });

  it("GET management exposes architectureRefresh = null when no agent run is queued", async () => {
    const repo = createRepository(db, {
      githubOwner: "acme",
      githubRepo: "widgets",
      localPath: repoDir,
      displayName: "Widgets",
      classification: "project",
      category: "work",
    });

    const response = await app().request(
      `/repositories/${encodeURIComponent(repo.id)}/management`,
    );
    const body = await response.json() as {
      management: { repositoryId: string; enabled: boolean };
      architectureRefresh: unknown;
    };

    expect(response.status).toBe(200);
    expect(body.management.repositoryId).toBe(repo.id);
    expect(body.architectureRefresh).toBeNull();
  });

  it("GET management surfaces the in-flight architectureRefresh row after init", async () => {
    const repo = createRepository(db, {
      githubOwner: "acme",
      githubRepo: "widgets",
      localPath: repoDir,
      displayName: "Widgets",
      classification: "project",
      category: "work",
    });

    // Init enqueues a `git.project.refresh_architecture` row; the GET
    // response should expose it so the dashboard can poll for completion.
    const initResponse = await app().request(
      `/repositories/${encodeURIComponent(repo.id)}/management/init`,
      { method: "POST" },
    );
    expect(initResponse.status).toBe(200);
    const initBody = await initResponse.json() as {
      architectureScheduleId: number | null;
    };
    expect(initBody.architectureScheduleId).not.toBeNull();

    const response = await app().request(
      `/repositories/${encodeURIComponent(repo.id)}/management`,
    );
    const body = await response.json() as {
      architectureRefresh: { scheduleId: number; status: string } | null;
    };

    expect(response.status).toBe(200);
    expect(body.architectureRefresh).not.toBeNull();
    expect(body.architectureRefresh!.scheduleId).toBe(initBody.architectureScheduleId);
    expect(body.architectureRefresh!.status).toBe("pending");
  });

  it("Run today's scan now writes today's journal markdown in-process", async () => {
    const repo = createRepository(db, {
      githubOwner: "acme",
      githubRepo: "widgets",
      localPath: repoDir,
      displayName: "Widgets",
      classification: "project",
      category: "work",
    });
    commitFile("feature.txt", "feature\n", "Add feature");

    const response = await app().request(
      `/repositories/${encodeURIComponent(repo.id)}/management/scan`,
      { method: "POST" },
    );
    const body = await response.json() as {
      status: string;
      journalPath: string;
      commitCount: number;
    };

    expect(response.status).toBe(200);
    expect(body.status).toBe("completed");
    expect(body.commitCount).toBeGreaterThan(0);
    expect(existsSync(join(root, "context", body.journalPath))).toBe(true);
    expect(readFileSync(join(root, "context", body.journalPath), "utf-8")).toContain(
      "Add feature",
    );
  });
});
