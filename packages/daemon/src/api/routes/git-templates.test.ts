import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { Hono } from "hono";
import Database from "better-sqlite3";
import { applySchema } from "../../db/schema.js";
import { createRepository } from "../../db/repositories-store.js";
import { createGitTemplatesRoutes } from "./git-templates.js";
import {
  PROJECT_TEMPLATE_NAME,
  templatesDir as templatesDirOf,
  templateFileName as templateFileNameOf,
} from "../../core/template-store.js";
import type { AgentConfig } from "../../config.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

interface Harness {
  app: Hono;
  db: Database.Database;
  dataDir: string;
  workspaceDir: string;
  contextDir: string;
}

function buildHarness(opts: {
  watched?: ReadonlyArray<{
    path: string;
    slug?: string;
    classification?: "project" | "repo-only";
    category?: "work" | "personal" | "research" | "client" | "other";
    org?: string;
    accountAlias?: string;
    pollPriority?: "high" | "normal";
  }>;
  seedTemplates?: boolean;
  seedFiles?: Array<{ rel: string; body: string }>;
} = {}): Harness {
  const dataDir = tempDir("pa-git-templates-route-data-");
  const workspaceDir = tempDir("pa-git-templates-route-ws-");
  const contextDir = tempDir("pa-git-templates-route-ctx-");
  const db = new Database(":memory:");
  applySchema(db);

  if (opts.seedTemplates ?? true) {
    mkdirSync(templatesDirOf(dataDir), { recursive: true });
    writeFileSync(
      join(templatesDirOf(dataDir), PROJECT_TEMPLATE_NAME),
      "# project template body",
      "utf-8",
    );
    writeFileSync(
      join(templatesDirOf(dataDir), templateFileNameOf("git-repo")),
      "# git-repo template body",
      "utf-8",
    );
  }
  for (const { rel, body } of opts.seedFiles ?? []) {
    const abs = join(contextDir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body, "utf-8");
  }

  // Seed the unified `repositories` table from the legacy `watched`
  // shape so the route's `selectGitWatchedRepos(db)` projection sees
  // the rows the test expected.
  for (const w of opts.watched ?? []) {
    createRepository(db, {
      githubOwner: w.org ?? null,
      githubRepo: w.org && w.slug ? w.slug : null,
      githubAccount: w.accountAlias ?? null,
      localPath: w.path,
      localOnly: !w.org,
      // Use displayName so the deterministic slug derivation lands on
      // `w.slug` instead of `basename(w.path)` (which would otherwise
      // mismatch the test's seeded `git/<slug>/overview.md` path).
      displayName: w.slug ?? null,
      classification: w.classification ?? "repo-only",
      category: w.category ?? "other",
      pollPriority: w.pollPriority ?? "normal",
    });
  }

  const config = {
    dataDir,
    workspaceDir,
  } as unknown as AgentConfig;

  const app = new Hono();
  app.route(
    "/api",
    createGitTemplatesRoutes({
      db,
      config,
      getContextDir: () => contextDir,
    }),
  );
  return { app, db, dataDir, workspaceDir, contextDir };
}

describe("GET /api/git/templates/:kind", () => {
  it("returns active + bundled + override + path", async () => {
    const h = buildHarness();
    const res = await h.app.request("/api/git/templates/project");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      kind: string;
      active: string;
      bundled: string;
      override: string | null;
      hasOverride: boolean;
      path: string;
    };
    expect(body.kind).toBe("project");
    expect(body.active).toBe("# project template body");
    expect(body.hasOverride).toBe(true);
    expect(body.override).toBe("# project template body");
    expect(body.path.endsWith("/templates/project.md")).toBe(true);
    expect(body.bundled).toContain("type: project");
  });

  it("returns hasOverride=false when only the bundled body exists", async () => {
    const h = buildHarness({ seedTemplates: false });
    const res = await h.app.request("/api/git/templates/git-repo");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hasOverride: boolean; override: string | null };
    expect(body.hasOverride).toBe(false);
    expect(body.override).toBeNull();
  });

  it("400s on invalid kind", async () => {
    const h = buildHarness();
    const res = await h.app.request("/api/git/templates/bogus");
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/git/templates/:kind", () => {
  it("saves the override body atomically", async () => {
    const h = buildHarness({ seedTemplates: false });
    const res = await h.app.request("/api/git/templates/project", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# fresh project body" }),
    });
    expect(res.status).toBe(200);
    const filePath = join(templatesDirOf(h.dataDir), PROJECT_TEMPLATE_NAME);
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf-8")).toBe("# fresh project body");
  });

  it("400s when content is missing", async () => {
    const h = buildHarness();
    const res = await h.app.request("/api/git/templates/project", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("413s on bodies above the 64 KiB cap", async () => {
    const h = buildHarness();
    const tooBig = "x".repeat(65 * 1024);
    const res = await h.app.request("/api/git/templates/project", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: tooBig }),
    });
    expect(res.status).toBe(413);
  });
});

describe("POST /api/git/templates/:kind/apply", () => {
  it("412s when the user template is missing", async () => {
    const h = buildHarness({ seedTemplates: false });
    // git-repo bundled exists but user override doesn't — but the
    // template file the apply path reads is the user-side, so deletion
    // of the seeded file is the relevant signal.
    const overridePath = join(
      templatesDirOf(h.dataDir),
      PROJECT_TEMPLATE_NAME,
    );
    if (existsSync(overridePath)) rmSync(overridePath);
    const res = await h.app.request("/api/git/templates/project/apply", {
      method: "POST",
    });
    expect(res.status).toBe(412);
  });

  it("422s when no targets exist", async () => {
    const h = buildHarness({
      seedTemplates: true,
      watched: [
        {
          path: "/tmp/repo-aitne",
          slug: "aitne",
          classification: "project",
          category: "personal",
          pollPriority: "normal",
        },
      ],
    });
    const res = await h.app.request("/api/git/templates/project/apply", {
      method: "POST",
    });
    expect(res.status).toBe(422);
  });

  it("enqueues a retemplate run and creates backups when targets exist", async () => {
    const h = buildHarness({
      seedTemplates: true,
      watched: [
        {
          path: "/tmp/repo-aitne",
          slug: "aitne",
          classification: "project",
          category: "personal",
          pollPriority: "normal",
        },
      ],
      seedFiles: [{ rel: "knowledge/repos/aitne/overview.md", body: "ORIG" }],
    });
    const res = await h.app.request("/api/git/templates/project/apply", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: true;
      kind: string;
      scheduleId: number;
      correlationId: string;
      backupRoot: string;
      targets: Array<{ slug: string; contextFile: string }>;
    };
    expect(body.kind).toBe("project");
    expect(body.targets[0].slug).toBe("aitne");
    expect(existsSync(join(body.backupRoot, "knowledge/repos/aitne/overview.md"))).toBe(
      true,
    );

    const row = h.db.prepare(
      "SELECT task_type FROM agent_schedule WHERE id = ?",
    ).get(body.scheduleId) as { task_type: string };
    expect(row.task_type).toBe("git.project.retemplate");
  });

  it("409s when a run is already in progress — correlationId echoed from the active row", async () => {
    const h = buildHarness({
      seedTemplates: true,
      watched: [
        {
          path: "/tmp/repo-aitne",
          slug: "aitne",
          classification: "project",
          category: "personal",
          pollPriority: "normal",
        },
      ],
      seedFiles: [{ rel: "knowledge/repos/aitne/overview.md", body: "ORIG" }],
    });
    const first = (await (await h.app.request("/api/git/templates/project/apply", { method: "POST" })).json()) as { correlationId: string };
    const res = await h.app.request("/api/git/templates/project/apply", {
      method: "POST",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; scheduleId: number; correlationId: string | null };
    expect(body.error).toBe("in_progress");
    expect(body.scheduleId).toBeGreaterThan(0);
    // correlationId is always propagated when the active row was created via
    // prepareRetemplateRun (which always sets a UUID).
    expect(body.correlationId).toBe(first.correlationId);
  });

  it("409s with correlationId=null when the active row was inserted with a NULL correlation_id (legacy-row compat)", async () => {
    // Simulate a row left by an older schema version or direct DB insert
    // that had no correlation_id. The route must serialize it as null (not
    // undefined) so the dashboard can distinguish "unknown" from "missing".
    const h = buildHarness({ seedTemplates: true });
    h.db
      .prepare(
        `INSERT INTO agent_schedule
           (scheduled_for, task_type, task_description, task_context, correlation_id, model, status)
         VALUES (datetime('now'), 'git.project.retemplate', 'test', '{}', NULL, NULL, 'pending')`,
      )
      .run();
    const res = await h.app.request("/api/git/templates/project/apply", {
      method: "POST",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: string;
      scheduleId: number;
      correlationId: string | null;
    };
    expect(body.error).toBe("in_progress");
    expect(body.scheduleId).toBeGreaterThan(0);
    // correlationId ?? null path: DB row has NULL → serialized as null
    expect(body.correlationId).toBeNull();
  });
});

describe("retemplate status + per-file reporter", () => {
  async function setupRunning(): Promise<Harness & {
    correlationId: string;
    scheduleId: number;
  }> {
    const h = buildHarness({
      seedTemplates: true,
      watched: [
        {
          path: "/tmp/repo-aitne",
          slug: "aitne",
          classification: "project",
          category: "personal",
          pollPriority: "normal",
        },
      ],
      seedFiles: [{ rel: "knowledge/repos/aitne/overview.md", body: "ORIG" }],
    });
    const res = await h.app.request("/api/git/templates/project/apply", {
      method: "POST",
    });
    const body = (await res.json()) as {
      scheduleId: number;
      correlationId: string;
    };
    return { ...h, correlationId: body.correlationId, scheduleId: body.scheduleId };
  }

  it("GET /api/git/templates/retemplate/status returns the live record", async () => {
    const setup = await setupRunning();
    const res = await setup.app.request("/api/git/templates/retemplate/status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: { scheduleId: number; files: Record<string, { status: string }> };
    };
    expect(body.status.scheduleId).toBe(setup.scheduleId);
    expect(body.status.files.aitne.status).toBe("pending");
  });

  it("POST /api/git/templates/retemplate/file updates the grid and writes audit row", async () => {
    const setup = await setupRunning();
    const res = await setup.app.request(
      "/api/git/templates/retemplate/file",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "aitne",
          status: "completed",
          beforeBytes: 4,
          afterBytes: 16,
          correlationId: setup.correlationId,
        }),
      },
    );
    expect(res.status).toBe(200);

    const status = setup.db.prepare(
      "SELECT value_json FROM runtime_state WHERE key = 'git.project.retemplate.status'",
    ).get() as { value_json: string };
    expect(JSON.parse(status.value_json).files.aitne.status).toBe("completed");

    const audit = setup.db.prepare(
      `SELECT action_type, result, detail, event_id
         FROM agent_actions WHERE action_type = 'git.project.retemplate'`,
    ).get() as {
      action_type: string;
      result: string;
      detail: string;
      event_id: string;
    };
    expect(audit.action_type).toBe("git.project.retemplate");
    expect(audit.result).toBe("success");
    expect(audit.event_id).toBe(setup.correlationId);
    expect(JSON.parse(audit.detail).slug).toBe("aitne");
  });

  it("POST file 400s on invalid slug or status", async () => {
    const setup = await setupRunning();
    const bad1 = await setup.app.request(
      "/api/git/templates/retemplate/file",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: "BAD/SLUG", status: "completed" }),
      },
    );
    expect(bad1.status).toBe(400);
    const bad2 = await setup.app.request(
      "/api/git/templates/retemplate/file",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: "aitne", status: "weird" }),
      },
    );
    expect(bad2.status).toBe(400);
  });

  it("POST file 409s on correlationId mismatch and 404s on unknown slug", async () => {
    const setup = await setupRunning();
    const mismatch = await setup.app.request(
      "/api/git/templates/retemplate/file",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "aitne",
          status: "completed",
          correlationId: "wrong",
        }),
      },
    );
    expect(mismatch.status).toBe(409);
    const unknown = await setup.app.request(
      "/api/git/templates/retemplate/file",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "missing",
          status: "completed",
          correlationId: setup.correlationId,
        }),
      },
    );
    expect(unknown.status).toBe(404);
  });

  it("POST file 409s when no active run exists at all", async () => {
    const h = buildHarness();
    const res = await h.app.request("/api/git/templates/retemplate/file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "any", status: "completed" }),
    });
    expect(res.status).toBe(409);
  });

  it("POST file with status=started updates the grid but does NOT write an audit row", async () => {
    // Decision 8 §2 specifies one audit row per file. `started` is a
    // work-begin marker the daemon's finalize hook needs (so it knows
    // which files to roll back on session abort), but it is not an
    // outcome — recording it would double-count and pollute analytics.
    const setup = await setupRunning();
    const res = await setup.app.request(
      "/api/git/templates/retemplate/file",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "aitne",
          status: "started",
          correlationId: setup.correlationId,
        }),
      },
    );
    expect(res.status).toBe(200);

    const grid = setup.db.prepare(
      "SELECT value_json FROM runtime_state WHERE key = 'git.project.retemplate.status'",
    ).get() as { value_json: string };
    expect(JSON.parse(grid.value_json).files.aitne.status).toBe("started");

    const auditCount = setup.db.prepare(
      "SELECT COUNT(*) AS n FROM agent_actions WHERE action_type = 'git.project.retemplate'",
    ).get() as { n: number };
    expect(auditCount.n).toBe(0);
  });

  it("POST file with status=skipped writes an audit row tagged result=skipped", async () => {
    const setup = await setupRunning();
    const res = await setup.app.request(
      "/api/git/templates/retemplate/file",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "aitne",
          status: "skipped",
          reason: "already_conformed",
          correlationId: setup.correlationId,
        }),
      },
    );
    expect(res.status).toBe(200);
    const audit = setup.db.prepare(
      `SELECT result, detail FROM agent_actions
         WHERE action_type = 'git.project.retemplate'`,
    ).get() as { result: string; detail: string };
    expect(audit.result).toBe("skipped");
    expect(JSON.parse(audit.detail).reason).toBe("already_conformed");
  });

  it("POST file with status=failed writes an audit row tagged result=failed", async () => {
    const setup = await setupRunning();
    const res = await setup.app.request(
      "/api/git/templates/retemplate/file",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "aitne",
          status: "failed",
          error: "PUT context returned 500",
          correlationId: setup.correlationId,
        }),
      },
    );
    expect(res.status).toBe(200);
    const audit = setup.db.prepare(
      `SELECT result, error FROM agent_actions
         WHERE action_type = 'git.project.retemplate'`,
    ).get() as { result: string; error: string };
    expect(audit.result).toBe("failed");
    expect(audit.error).toBe("PUT context returned 500");
  });

  it("POST file with status=failed and missing error body falls back to 'unspecified'", async () => {
    // Exercises the `body.error` ternary's fallback branch when error is
    // not a string in the request body.
    const setup = await setupRunning();
    const res = await setup.app.request(
      "/api/git/templates/retemplate/file",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "aitne",
          status: "failed",
          correlationId: setup.correlationId,
        }),
      },
    );
    expect(res.status).toBe(200);
    const audit = setup.db.prepare(
      `SELECT result, error FROM agent_actions
         WHERE action_type = 'git.project.retemplate'
         ORDER BY rowid DESC LIMIT 1`,
    ).get() as { result: string; error: string };
    expect(audit.result).toBe("failed");
    expect(audit.error).toBe("unspecified");
  });

  it("POST file still returns 200 when audit insert throws (catch logs and proceeds)", async () => {
    // Block agent_actions inserts so the route's audit-row write fails;
    // the per-file status grid still updates and the response is 200.
    const setup = await setupRunning();
    setup.db.exec(
      `CREATE TRIGGER reject_retemplate_audit_inserts
         BEFORE INSERT ON agent_actions
         WHEN NEW.action_type = 'git.project.retemplate'
         BEGIN
           SELECT RAISE(ABORT, 'audit blocked for test');
         END`,
    );
    const res = await setup.app.request(
      "/api/git/templates/retemplate/file",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "aitne",
          status: "failed",
          error: "explicit message",
          correlationId: setup.correlationId,
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status: string };
    expect(body.ok).toBe(true);
    expect(body.status).toBe("failed");
    setup.db.exec("DROP TRIGGER IF EXISTS reject_retemplate_audit_inserts");
  });

  it("GET /api/git/templates/:kind returns 500 when reading the override file throws (EISDIR)", async () => {
    // Place a directory at the override file path so readFileSync raises
    // EISDIR — exercises the GET catch (lines 119-125).
    const setup = await setupRunning();
    const overridePath = join(
      templatesDirOf(setup.dataDir),
      PROJECT_TEMPLATE_NAME,
    );
    rmSync(overridePath, { force: true });
    mkdirSync(overridePath, { recursive: true });
    const res = await setup.app.request("/api/git/templates/project");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("read_failed");
    expect(typeof body.message).toBe("string");
  });

  it("POST /api/git/templates/:kind/apply 409 returns null correlationId when the in-flight row has no correlation_id", async () => {
    // Pre-seed a `pending` agent_schedule row WITHOUT a correlation_id so
    // findActiveRetemplateRow returns it but `existingRow.correlation_id`
    // is null. The route's `?? null` fallback then surfaces null in the
    // 409 envelope.
    const h = buildHarness({
      seedTemplates: true,
      watched: [
        {
          path: "/tmp/repo-aitne",
          slug: "aitne",
          classification: "project",
          category: "personal",
          pollPriority: "normal",
        },
      ],
      seedFiles: [{ rel: "knowledge/repos/aitne/overview.md", body: "ORIG" }],
    });
    h.db.prepare(
      `INSERT INTO agent_schedule
         (scheduled_for, task_type, task_description, task_context, status)
       VALUES (datetime('now'), 'git.project.retemplate',
               'retemplate (test seed)', '{}', 'pending')`,
    ).run();
    const res = await h.app.request("/api/git/templates/project/apply", {
      method: "POST",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; scheduleId: number | null; correlationId: string | null };
    expect(body.error).toBe("in_progress");
    expect(body.scheduleId).toBeGreaterThan(0);
    expect(body.correlationId).toBeNull();
  });

  it("PUT /api/git/templates/:kind returns 400 invalid_kind for unknown kinds", async () => {
    const setup = await setupRunning();
    const res = await setup.app.request("/api/git/templates/banana", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_kind");
  });

  it("POST /api/git/templates/:kind/apply returns 400 invalid_kind for unknown kinds", async () => {
    // Exercises the parseKind null-check on the apply route (line 175).
    const setup = await setupRunning();
    const res = await setup.app.request("/api/git/templates/banana/apply", {
      method: "POST",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_kind");
  });

  it("POST /api/git/templates/retemplate/file rejects an unparseable JSON body via readJsonBody", async () => {
    // Exercises line 237 — the readJsonBody early-error fallthrough.
    const setup = await setupRunning();
    const res = await setup.app.request(
      "/api/git/templates/retemplate/file",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "@not-json",
      },
    );
    expect(res.status).toBe(400);
  });

  it("PUT /api/git/templates/:kind returns 500 when writeTemplateBody fails (non-ETEMPLATE_BODY_TOO_LARGE)", async () => {
    // Replace the override path with a symlink so atomic-write's
    // EATOMIC_TARGET_SYMLINK guard fires — exercises the generic
    // write_failed branch (lines 157-161).
    const setup = await setupRunning();
    const dir = templatesDirOf(setup.dataDir);
    const target = join(dir, PROJECT_TEMPLATE_NAME);
    rmSync(target, { force: true });
    // symlink to a non-existent path is fine for the lstat check.
    symlinkSync(join(dir, "elsewhere.md"), target);
    const res = await setup.app.request(
      "/api/git/templates/project",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "blocked" }),
      },
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("write_failed");
  });
});
