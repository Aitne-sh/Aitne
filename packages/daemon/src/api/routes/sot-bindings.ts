import { Hono } from "hono";
import type Database from "better-sqlite3";
import {
  sotBindingsSchema,
  type SotBindings,
} from "@aitne/shared";
import { composeIssue, respondWithAgentError } from "../helpers/agent-errors.js";
import {
  readSotBindings,
  writeSotBindings,
} from "../../db/sot-bindings-store.js";
import { listManagedTasks } from "../../db/managed-tasks-store.js";
import { readJsonBody } from "../json-body.js";
import { getContextDir } from "../../config.js";
import { createLogger } from "../../logging.js";
import {
  readAndParseManagementMd,
  renderAndWriteManagementMd,
  type RenderOptions,
} from "../../core/management-registry.js";
import {
  InMemoryManagementMdWriteLockManager,
  withManagementMdWriteLock,
  type ManagementMdWriteLockManager,
} from "../../core/management-md-write-lock.js";
import type { ApiDependencies } from "../server.js";

const logger = createLogger("sot-bindings-api");

/**
 * SoT bindings — Section A of `rules/management.md` (§9.5, §10.6).
 *
 * The list is small (typically ≤ DOMAINS.length) and PUT replace-
 * semantics (§10.6) is the only mutation surface. A single-binding
 * PATCH is sugar over the same path: the route reads the current list,
 * applies the patch in memory, and PUTs the result.
 */

export interface SotBindingsRoutesDeps {
  db: Database.Database;
  config: ApiDependencies["config"];
  lockManager: ManagementMdWriteLockManager;
}

function recordAuditAction(
  db: Database.Database,
  detail: Record<string, unknown>,
): void {
  try {
    db.prepare(
      `INSERT INTO agent_actions
         (event_id, action_type, trigger, result, detail, started_at, completed_at)
       VALUES (?, 'sot_binding.updated', 'reactive', 'success', ?, datetime('now'), datetime('now'))`,
    ).run(`sot:${Date.now()}`, JSON.stringify(detail));
  } catch (err) {
    logger.warn({ err }, "sot_binding.updated audit insert failed");
  }
}

/**
 * Recover preserved §C and free-prose blocks from the on-disk file so
 * the SoT-binding PUT does not strip user-authored content (parity with
 * `bootstrapManagementRegistry` and the watcher). MUST be called inside
 * the management-md write lock.
 */
async function loadPreservedRenderOptions(
  contextDir: string,
): Promise<RenderOptions> {
  try {
    const parsed = await readAndParseManagementMd(contextDir);
    if (!parsed) return {};
    const opts: RenderOptions = {};
    if (parsed.preservedSectionC !== null) {
      opts.preservedSectionC = parsed.preservedSectionC;
    }
    if (parsed.preservedFreeProse.size > 0) {
      opts.preservedFreeProse = parsed.preservedFreeProse;
    }
    return opts;
    /* c8 ignore start — defensive: readAndParseManagementMd swallows ENOENT
       internally and parseManagementMd surfaces validation issues via the
       returned `errors[]` array rather than throwing. The catch only fires
       on filesystem failures (EACCES/EIO mid-read) which are not reachable
       in unit-test conditions. */
  } catch (err) {
    logger.warn(
      { err },
      "management.md preserved-section read failed — re-render will fall back to defaults",
    );
    return {};
  }
  /* c8 ignore stop */
}

async function renderManagementMdAfterSotChange(
  contextDir: string,
  db: Database.Database,
  lockManager: ManagementMdWriteLockManager,
  trigger: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const result = await withManagementMdWriteLock(lockManager, async () => {
    const lockId = lockManager.getHolder();
    /* c8 ignore next 3 */
    if (!lockId) {
      throw new Error("renderManagementMdAfterSotChange: lock holder lost");
    }
    const render = await loadPreservedRenderOptions(contextDir);
    await renderAndWriteManagementMd(
      contextDir,
      db,
      {
        sotBindings: readSotBindings(db),
        managedTasks: listManagedTasks(db),
      },
      { lockManager, lockId, trigger, render },
    );
  });
  if (!result.ok) {
    logger.warn(
      { holder: result.holder, trigger },
      "management.md re-render skipped — lock contended",
    );
    return { ok: false, reason: `lock_contended:${result.holder}` };
  }
  return { ok: true };
}

export function createSotBindingsRoutes(deps: SotBindingsRoutesDeps): Hono {
  const app = new Hono();
  const { db, config, lockManager } = deps;

  // GET /sot-bindings — full list
  app.get("/sot-bindings", (c) => {
    const items = readSotBindings(db);
    return c.json({ items });
  });

  // GET /sot-bindings/:category — single binding (404 when absent)
  app.get("/sot-bindings/:category", (c) => {
    const rawCategory = c.req.param("category");
    const category = rawCategory.trim();
    if (!category) {
      return respondWithAgentError(c, 400, [
        composeIssue("sot_bindings.invalid_category", {
          field: "category",
          received: rawCategory,
        }),
      ]);
    }
    const items = readSotBindings(db);
    const item = items.find((b) => b.category === category);
    if (!item) {
      return respondWithAgentError(c, 404, [
        composeIssue("sot_bindings.not_found", {
          field: "category",
          received: category,
        }),
      ]);
    }
    return c.json({ item });
  });

  // PUT /sot-bindings — replace the entire list
  app.put("/sot-bindings", async (c) => {
    const parsedBody = await readJsonBody(c, { maxBytes: 32 * 1024 });
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.body;
    // Accept both `{items: [...]}` and the bare array form so the
    // dashboard's <PUT> and the agent's curl both round-trip cleanly.
    const candidate = Array.isArray(body)
      ? body
      : body !== null &&
          typeof body === "object" &&
          Array.isArray((body as Record<string, unknown>).items)
        ? (body as Record<string, unknown>).items
        : null;
    if (candidate === null) {
      return respondWithAgentError(c, 400, [
        composeIssue("sot_bindings.validation_error", {
          field: "body",
          received: typeof body,
          expected: "array or { items: [...] }",
        }),
      ], {
        legacyFields: {
          message: "body must be an array or {items: [...]}",
        },
      });
    }
    const parsed = sotBindingsSchema.safeParse(candidate);
    if (!parsed.success) {
      return respondWithAgentError(c, 400, [
        composeIssue("sot_bindings.validation_error", {
          field: "items",
          received: candidate,
        }),
      ], { legacyFields: { details: parsed.error } });
    }
    // §13.3 — defense in depth: forbid duplicate categories. The Zod
    // schema accepts duplicates by default; the file render is keyed on
    // category position so two rows for the same key would silently
    // overwrite each other in the user's mental model.
    const seen = new Set<string>();
    for (const row of parsed.data) {
      if (seen.has(row.category)) {
        return respondWithAgentError(c, 400, [
          composeIssue("sot_bindings.duplicate_category", {
            field: "items[].category",
            received: row.category,
          }),
        ], { legacyFields: { category: row.category } });
      }
      seen.add(row.category);
    }

    const previous = readSotBindings(db);
    let next: SotBindings;
    try {
      next = writeSotBindings(db, parsed.data);
    } catch (err) {
      logger.error({ err }, "sot-bindings PUT write failed");
      return respondWithAgentError(c, 500, [
        composeIssue("sot_bindings.internal_error", {
          field: "<server>",
          received: "<db_write_failed>",
        }),
      ]);
    }

    recordAuditAction(db, { previous, next });

    let contextDir: string;
    try {
      contextDir = getContextDir(config, db);
    } catch (err) {
      logger.warn({ err }, "management.md re-render skipped (sot PUT)");
      return c.json({ status: "updated", items: next });
    }
    const renderResult = await renderManagementMdAfterSotChange(
      contextDir,
      db,
      lockManager,
      "sot-bindings.api.put",
    );
    return c.json({
      status: "updated",
      items: next,
      render_status: renderResult.ok ? "ok" : renderResult.reason,
    });
  });

  return app;
}

export function buildSotBindingsRoutesDepsFromApi(
  deps: ApiDependencies,
  fallbackLockManager?: ManagementMdWriteLockManager,
): SotBindingsRoutesDeps {
  return {
    db: deps.db,
    config: deps.config,
    lockManager:
      deps.managementMdWriteLockManager ??
      fallbackLockManager ??
      new InMemoryManagementMdWriteLockManager(),
  };
}
