import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { applySchema } from "../../db/schema.js";
import {
  buildSotBindingsRoutesDepsFromApi,
  createSotBindingsRoutes,
  type SotBindingsRoutesDeps,
} from "./sot-bindings.js";
import { InMemoryManagementMdWriteLockManager } from "../../core/management-md-write-lock.js";
import type { AgentConfig } from "../../config.js";
import type { ApiDependencies } from "../server.js";
import { readSotBindings } from "../../db/sot-bindings-store.js";
import { CONTEXT_RELATIVE_PATHS } from "../../core/context-paths.js";

interface TestEnv {
  db: Database.Database;
  dataDir: string;
  cleanup: () => void;
  config: AgentConfig;
  lockManager: InMemoryManagementMdWriteLockManager;
}

function setupEnv(): TestEnv {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  const dataDir = mkdtempSync(join(tmpdir(), "sot-bindings-route-"));
  const lockManager = new InMemoryManagementMdWriteLockManager();
  const config = { timezone: "UTC", dataDir } as unknown as AgentConfig;
  return {
    db,
    dataDir,
    lockManager,
    config,
    cleanup: () => {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function makeDeps(env: TestEnv): SotBindingsRoutesDeps {
  return { db: env.db, config: env.config, lockManager: env.lockManager };
}

function readFile(env: TestEnv): string | null {
  try {
    return readFileSync(
      join(env.dataDir, "context", CONTEXT_RELATIVE_PATHS.rules.management),
      "utf-8",
    );
  } catch {
    return null;
  }
}

describe("sot-bindings routes", () => {
  let env: TestEnv;
  beforeEach(() => {
    env = setupEnv();
  });
  afterEach(() => env.cleanup());

  it("GET /sot-bindings returns the empty list initially", async () => {
    const app = createSotBindingsRoutes(makeDeps(env));
    const res = await app.request("/sot-bindings");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(0);
  });

  it("PUT /sot-bindings replaces the full list", async () => {
    const app = createSotBindingsRoutes(makeDeps(env));
    const res = await app.request("/sot-bindings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [
          {
            category: "tasks",
            sotApp: "notion",
            mirrorPath: "context/work/tasks-index.md",
            policy: null,
            writer: "agent",
          },
          {
            category: "notes",
            sotApp: "obsidian",
            mirrorPath: null,
            policy: "External SoT; no mirror",
            writer: "shared",
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      items: Array<{ category: string }>;
    };
    expect(body.status).toBe("updated");
    expect(body.items.map((b) => b.category)).toEqual(["tasks", "notes"]);

    // DB round-trip
    const stored = readSotBindings(env.db);
    expect(stored).toHaveLength(2);

    // File written and contains the bindings.
    const file = readFile(env);
    expect(file).toContain("notion");
    expect(file).toContain("obsidian");
  });

  it("PUT /sot-bindings accepts a bare array body", async () => {
    const app = createSotBindingsRoutes(makeDeps(env));
    const res = await app.request("/sot-bindings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        {
          category: "tasks",
          sotApp: "notion",
          mirrorPath: null,
          policy: null,
          writer: "agent",
        },
      ]),
    });
    expect(res.status).toBe(200);
    expect(readSotBindings(env.db)).toHaveLength(1);
  });

  it("PUT /sot-bindings rejects malformed body", async () => {
    const app = createSotBindingsRoutes(makeDeps(env));
    const res = await app.request("/sot-bindings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ category: "" }] }),
    });
    expect(res.status).toBe(400);
  });

  it("PUT /sot-bindings rejects duplicate categories", async () => {
    const app = createSotBindingsRoutes(makeDeps(env));
    const res = await app.request("/sot-bindings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [
          {
            category: "tasks",
            sotApp: "notion",
            mirrorPath: null,
            policy: null,
            writer: "agent",
          },
          {
            category: "tasks",
            sotApp: "linear",
            mirrorPath: null,
            policy: null,
            writer: "agent",
          },
        ],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("duplicate_category");
  });

  it("PUT /sot-bindings emits an audit row", async () => {
    const app = createSotBindingsRoutes(makeDeps(env));
    await app.request("/sot-bindings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [
          {
            category: "tasks",
            sotApp: "notion",
            mirrorPath: null,
            policy: null,
            writer: "agent",
          },
        ],
      }),
    });
    const rows = env.db
      .prepare(
        "SELECT action_type, detail FROM agent_actions WHERE action_type LIKE 'sot_binding.%'",
      )
      .all() as Array<{ action_type: string; detail: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].action_type).toBe("sot_binding.updated");
    const detail = JSON.parse(rows[0].detail) as { previous: unknown[]; next: unknown[] };
    expect(detail.previous).toHaveLength(0);
    expect(detail.next).toHaveLength(1);
  });

  it("GET /sot-bindings/:category returns a single binding", async () => {
    const app = createSotBindingsRoutes(makeDeps(env));
    await app.request("/sot-bindings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [
          {
            category: "tasks",
            sotApp: "notion",
            mirrorPath: null,
            policy: null,
            writer: "agent",
          },
        ],
      }),
    });
    const res = await app.request("/sot-bindings/tasks");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { item: { category: string } };
    expect(body.item.category).toBe("tasks");
  });

  it("GET /sot-bindings/:category returns 404 for unknown category", async () => {
    const app = createSotBindingsRoutes(makeDeps(env));
    const res = await app.request("/sot-bindings/unknown");
    expect(res.status).toBe(404);
  });

  it("GET /sot-bindings/:category returns 400 when category trims to empty", async () => {
    // Exercises the `if (!category) return c.json({ error: "invalid_category" }, 400)`
    // guard for whitespace-only path segments.
    const app = createSotBindingsRoutes(makeDeps(env));
    const res = await app.request("/sot-bindings/%20%20");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_category");
  });

  it("PUT /sot-bindings rejects an unparseable JSON body via readJsonBody", async () => {
    // Exercises the `if (!parsedBody.ok) return parsedBody.response;` early
    // return — readJsonBody emits a 400 envelope for invalid JSON.
    const app = createSotBindingsRoutes(makeDeps(env));
    const res = await app.request("/sot-bindings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    });
    expect(res.status).toBe(400);
  });

  it("PUT /sot-bindings rejects a body that is neither array nor {items}", async () => {
    const app = createSotBindingsRoutes(makeDeps(env));
    const res = await app.request("/sot-bindings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unrelated: "shape" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message?: string };
    expect(body.error).toBe("validation_error");
    expect(body.message).toMatch(/must be an array/);
  });

  it("PUT /sot-bindings rejects a JSON null body", async () => {
    const app = createSotBindingsRoutes(makeDeps(env));
    const res = await app.request("/sot-bindings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "null",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("validation_error");
  });

  it("PUT /sot-bindings reports render_status with lock_contended reason when the lock is held", async () => {
    // Hold the management.md write lock from elsewhere so the route's
    // re-render call returns ok:false with the holder id surfaced.
    const localEnv = setupEnv();
    const acquired = localEnv.lockManager.acquire();
    if (!acquired.ok) throw new Error("test setup: failed to acquire seed lock");
    const app = createSotBindingsRoutes(makeDeps(localEnv));
    const res = await app.request("/sot-bindings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [
          {
            category: "tasks",
            sotApp: "notion",
            mirrorPath: null,
            policy: null,
            writer: "agent",
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; render_status: string };
    expect(body.status).toBe("updated");
    expect(body.render_status).toMatch(/^lock_contended:/);
    localEnv.lockManager.release(acquired.lockId);
    localEnv.cleanup();
  });

  it("PUT /sot-bindings returns 500 when writeSotBindings throws", async () => {
    // Install a SQLite trigger that aborts INSERTs into `settings` so the
    // route's writeSotBindings call raises while the previous-value read
    // (line 185) succeeds. This exercises the catch branch wrapping the
    // DB write.
    const localEnv = setupEnv();
    localEnv.db.exec(
      `CREATE TRIGGER reject_sot_bindings_writes
         BEFORE INSERT ON settings
         FOR EACH ROW
         WHEN NEW.key = 'sot_bindings'
         BEGIN
           SELECT RAISE(ABORT, 'sot_bindings write blocked for test');
         END`,
    );
    const app = createSotBindingsRoutes(makeDeps(localEnv));
    const res = await app.request("/sot-bindings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [
          {
            category: "tasks",
            sotApp: "notion",
            mirrorPath: null,
            policy: null,
            writer: "agent",
          },
        ],
      }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("internal_error");
    localEnv.db.exec("DROP TRIGGER IF EXISTS reject_sot_bindings_writes");
    localEnv.cleanup();
  });

  it("PUT /sot-bindings preserves the user-edited Section C across re-render", async () => {
    // Pre-write a management.md that contains a preserved Section C body.
    // The route's loadPreservedRenderOptions must parse it and forward
    // `preservedSectionC` to renderAndWriteManagementMd so the user's
    // policy text is not stripped on the next write.
    const localEnv = setupEnv();
    const mgmtPath = join(
      localEnv.dataDir,
      "context",
      CONTEXT_RELATIVE_PATHS.rules.management,
    );
    mkdirSync(join(localEnv.dataDir, "context", "policies"), { recursive: true });
    const PRESERVED = [
      "# Management",
      "",
      "## A. SoT bindings",
      "",
      "_(seeded — will be replaced)_",
      "",
      "## B. Active fetches",
      "",
      "_(none)_",
      "",
      "## C. Active Policies",
      "",
      "Hand-typed policy paragraph the user owns.",
      "Second line of policy.",
      "",
    ].join("\n");
    writeFileSync(mgmtPath, PRESERVED, "utf-8");

    const app = createSotBindingsRoutes(makeDeps(localEnv));
    const res = await app.request("/sot-bindings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [
          {
            category: "tasks",
            sotApp: "notion",
            mirrorPath: null,
            policy: null,
            writer: "agent",
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { render_status: string };
    expect(body.render_status).toBe("ok");
    const after = readFileSync(mgmtPath, "utf-8");
    expect(after).toContain("Hand-typed policy paragraph the user owns.");
    expect(after).toContain("Second line of policy.");
    localEnv.cleanup();
  });

it("PUT /sot-bindings logs but still returns 200 when audit insert throws", async () => {
    // Block agent_actions inserts so recordAuditAction's catch fires.
    const localEnv = setupEnv();
    localEnv.db.exec(
      `CREATE TRIGGER reject_audit_inserts
         BEFORE INSERT ON agent_actions
         BEGIN
           SELECT RAISE(ABORT, 'audit blocked for test');
         END`,
    );
    const app = createSotBindingsRoutes(makeDeps(localEnv));
    const res = await app.request("/sot-bindings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [
          {
            category: "tasks",
            sotApp: "notion",
            mirrorPath: null,
            policy: null,
            writer: "agent",
          },
        ],
      }),
    });
    // Even with a failed audit, the PUT succeeds — audit is best-effort.
    expect(res.status).toBe(200);
    localEnv.db.exec("DROP TRIGGER IF EXISTS reject_audit_inserts");
    localEnv.cleanup();
  });

  it("PUT /sot-bindings still returns 200 when getContextDir throws (skips re-render)", async () => {
    // Exercises the `catch` branch around `contextDir = getContextDir(...)`:
    // the dataDir field is missing on config so getContextDir throws. The
    // route must still report status:"updated" and skip the management.md
    // re-render.
    const localEnv = setupEnv();
    // Replace config with one that lacks dataDir so getContextDir throws
    // when looking up the resolved path.
    const badConfig = { timezone: "UTC" } as unknown as AgentConfig;
    const deps: SotBindingsRoutesDeps = {
      db: localEnv.db,
      config: badConfig,
      lockManager: localEnv.lockManager,
    };
    const app = createSotBindingsRoutes(deps);
    const res = await app.request("/sot-bindings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [
          {
            category: "tasks",
            sotApp: "notion",
            mirrorPath: null,
            policy: null,
            writer: "agent",
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      render_status?: string;
    };
    expect(body.status).toBe("updated");
    // Field is omitted in the catch branch (route returns early without it).
    expect(body.render_status).toBeUndefined();
    localEnv.cleanup();
  });
});

describe("buildSotBindingsRoutesDepsFromApi", () => {
  it("forwards db and config and uses managementMdWriteLockManager when present", () => {
    const db = new Database(":memory:");
    applySchema(db);
    const config = { timezone: "UTC" } as unknown as AgentConfig;
    const lockManager = new InMemoryManagementMdWriteLockManager();
    const apiDeps = {
      db,
      config,
      managementMdWriteLockManager: lockManager,
    } as unknown as ApiDependencies;
    const result = buildSotBindingsRoutesDepsFromApi(apiDeps);
    expect(result.db).toBe(db);
    expect(result.config).toBe(config);
    expect(result.lockManager).toBe(lockManager);
    db.close();
  });

  it("uses the explicit fallbackLockManager when ApiDependencies has no managementMdWriteLockManager", () => {
    const db = new Database(":memory:");
    applySchema(db);
    const config = { timezone: "UTC" } as unknown as AgentConfig;
    const fallback = new InMemoryManagementMdWriteLockManager();
    const apiDeps = { db, config } as unknown as ApiDependencies;
    const result = buildSotBindingsRoutesDepsFromApi(apiDeps, fallback);
    expect(result.lockManager).toBe(fallback);
    db.close();
  });

  it("constructs a fresh InMemory lock manager when neither source is provided", () => {
    const db = new Database(":memory:");
    applySchema(db);
    const config = { timezone: "UTC" } as unknown as AgentConfig;
    const apiDeps = { db, config } as unknown as ApiDependencies;
    const result = buildSotBindingsRoutesDepsFromApi(apiDeps);
    expect(result.lockManager).toBeInstanceOf(InMemoryManagementMdWriteLockManager);
    db.close();
  });
});
