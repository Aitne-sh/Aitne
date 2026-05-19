import { Hono } from "hono";
import type { NotionService, NotionContentMode } from "../../services/notion.js";
import type { AgentWriteTracker } from "../../safety/agent-write-tracker.js";
import type {
  QueryDataSourceParameters,
  CreatePageParameters,
  UpdatePageParameters,
} from "@notionhq/client";
import { createLogger, toSafeErrorMessage } from "../../logging.js";
import { readJsonBody } from "../json-body.js";
import { composeIssue, respondWithAgentError } from "../helpers/agent-errors.js";

const logger = createLogger("notion-api");

/**
 * Notion write attribution TTL — must comfortably exceed the max Notion
 * poll interval (`PA_NOTION_POLL_INTERVAL_SECONDS`, default 300s) plus a
 * network/processing buffer. The default 30 s `AgentWriteTracker` TTL is
 * designed for file-system watchers that fire within milliseconds; for
 * polled observers the default would expire long before the next poll
 * sees the write, and the agent would observe its own edits as user
 * changes and potentially loop on them.
 *
 * 15 minutes = 3× the default poll interval, giving comfortable headroom
 * even if the user raises `PA_NOTION_POLL_INTERVAL_SECONDS` to ~10 min.
 */
const NOTION_WRITE_TTL_MS = 15 * 60_000;

/** Strict Notion ID match — 32-hex or 8-4-4-4-12 UUID, nothing else. */
const PAGE_ID_REGEX =
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export interface NotionRouteDependencies {
  /**
   * The shared NotionService held by the daemon's service registry. Every
   * Notion HTTP endpoint delegates here so the API key stays in one place
   * and the agent's read/write path is identical to what the poller uses.
   */
  notionService: NotionService | null;
  /**
   * Optional shared write tracker. All write endpoints pre-mark the target
   * page (`notion:<pageId>`) so NotionPoller attributes the resulting
   * observation to `actor='agent'` and hourly_check's `?actor=user` filter
   * excludes the echo. Without this the agent can observe its own writes
   * and loop.
   */
  writeTracker?: AgentWriteTracker;
}

/**
 * Notion API — full CRUD over pages, plus search and database query.
 *
 * | Method | Path                                | Risk tier  | Purpose                                     |
 * |--------|-------------------------------------|------------|---------------------------------------------|
 * | GET    | /notion/databases                   | Autonomous | List configured databases                  |
 * | GET    | /notion/query?database=tasks&...    | Autonomous | Query a data source (filter/sort/paginate) |
 * | GET    | /notion/search?q=...                | Autonomous | Search pages/databases by title            |
 * | GET    | /notion/pages/:id                   | Autonomous | Retrieve page metadata + markdown content  |
 * | POST   | /notion/pages                       | Autonomous | Create a new page                          |
 * | PATCH  | /notion/pages/:id                   | Autonomous | Update page properties/icon/cover/in_trash |
 * | PATCH  | /notion/pages/:id/content           | Autonomous | Edit page content via markdown ops         |
 * | DELETE | /notion/pages/:id                   | Autonomous | Archive (move to trash, 30-day recovery)   |
 */
export function createNotionRoutes(deps: NotionRouteDependencies): Hono {
  const app = new Hono();
  const { notionService, writeTracker } = deps;

  /**
   * Per-route write mutex. Every Notion write (POST/PATCH/DELETE) runs
   * through this lock so concurrent requests serialize at the daemon
   * boundary. Mirrors the obsidian route pattern — keeps `markAgentWrite`
   * → service call ordered so the write tracker's TTL window covers the
   * subsequent poller observation.
   */
  let writeLock: Promise<void> = Promise.resolve();
  function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = writeLock;
    let release: () => void;
    writeLock = new Promise<void>((r) => {
      release = r;
    });
    return prev.then(async () => {
      try {
        return await fn();
      /* v8 ignore next */
      } finally {
        release!();
      }
    });
  }

  function markAgentWrite(pageId: string): void {
    if (!writeTracker) return;
    writeTracker.markWriting(`notion:${pageId}`, null, { ttlMs: NOTION_WRITE_TTL_MS });
  }

  function ensureService() {
    if (!notionService?.available) {
      return null;
    }
    return notionService;
  }

  // ─────────────────────────────────────────────────────────────
  // GET /notion/databases — list configured databases
  // ─────────────────────────────────────────────────────────────
  app.get("/notion/databases", (c) => {
    const service = ensureService();
    if (!service) {
      return respondWithAgentError(c, 503, [
        composeIssue("notion.not_configured", {
          field: "services.notion",
          received: "<unavailable>",
        }),
      ]);
    }
    return c.json({ databases: service.listDatabases() });
  });

  // ─────────────────────────────────────────────────────────────
  // GET /notion/query — query a data source
  // ─────────────────────────────────────────────────────────────
  app.get("/notion/query", async (c) => {
    const service = ensureService();
    if (!service) {
      return respondWithAgentError(c, 503, [
        composeIssue("notion.not_configured", {
          field: "services.notion",
          received: "<unavailable>",
        }),
      ]);
    }

    const dbLabel = c.req.query("database") ?? "tasks";
    const databaseId = service.resolveDatabaseId(dbLabel);
    if (!databaseId) {
      return respondWithAgentError(c, 404, [
        composeIssue("notion.database_not_found", {
          field: "database",
          received: dbLabel,
        }),
      ], { legacyFields: { available: service.listDatabases().map((d) => d.label) } });
    }

    const filterParam = c.req.query("filter");
    const sortsParam = c.req.query("sorts");
    const pageSize = Math.min(Number(c.req.query("page_size") ?? "20"), 100);
    const startCursor = c.req.query("start_cursor");
    const inTrashParam = c.req.query("in_trash");

    let filter: unknown;
    let sorts: unknown;
    try {
      filter = filterParam ? JSON.parse(filterParam) : undefined;
      sorts = sortsParam ? JSON.parse(sortsParam) : undefined;
    } catch {
      return respondWithAgentError(c, 400, [
        composeIssue("notion.invalid_json_parameter", {
          field: filterParam && !sortsParam ? "filter" : "sorts",
          received: filterParam ?? sortsParam ?? "<missing>",
        }),
      ], { legacyFields: { message: "filter or sorts is not valid JSON" } });
    }

    try {
      const result = await service.queryDatabase({
        databaseId,
        filter: filter as QueryDataSourceParameters["filter"],
        sorts: sorts as QueryDataSourceParameters["sorts"],
        pageSize,
        startCursor: startCursor ?? undefined,
        inTrash: inTrashParam === "true" ? true : undefined,
      });
      return c.json({
        results: result.results,
        has_more: result.hasMore,
        next_cursor: result.nextCursor,
      });
    } catch (err) {
      logger.error({ err, database: dbLabel }, "Notion query failed");
      return respondWithAgentError(c, 502, [
        composeIssue("notion.upstream_error", {
          field: "notion.queryDatabase",
          received: toSafeErrorMessage(err),
        }),
      ], { legacyErrorCode: "notion_query_failed", legacyFields: { message: toSafeErrorMessage(err) } });
    }
  });

  // ─────────────────────────────────────────────────────────────
  // GET /notion/search — search across the workspace
  // ─────────────────────────────────────────────────────────────
  app.get("/notion/search", async (c) => {
    const service = ensureService();
    if (!service) {
      return respondWithAgentError(c, 503, [
        composeIssue("notion.not_configured", {
          field: "services.notion",
          received: "<unavailable>",
        }),
      ]);
    }

    const query = c.req.query("q") ?? undefined;
    const typeParam = c.req.query("type");
    const direction = c.req.query("sort") === "ascending" ? "ascending" : "descending";
    const pageSize = Math.min(Number(c.req.query("page_size") ?? "20"), 100);
    const startCursor = c.req.query("start_cursor");

    if (typeParam && typeParam !== "page" && typeParam !== "data_source") {
      return respondWithAgentError(c, 400, [
        composeIssue("notion.invalid_type", {
          field: "type",
          received: typeParam,
        }),
      ], { legacyFields: { message: "type must be 'page' or 'data_source'" } });
    }

    try {
      const result = await service.search({
        query,
        filterType: typeParam as "page" | "data_source" | undefined,
        sortDirection: direction,
        pageSize,
        startCursor: startCursor ?? undefined,
      });
      return c.json({
        results: result.results,
        has_more: result.hasMore,
        next_cursor: result.nextCursor,
      });
    } catch (err) {
      logger.error({ err }, "Notion search failed");
      return respondWithAgentError(c, 502, [
        composeIssue("notion.upstream_error", {
          field: "notion.search",
          received: toSafeErrorMessage(err),
        }),
      ], { legacyErrorCode: "notion_search_failed", legacyFields: { message: toSafeErrorMessage(err) } });
    }
  });

  // ─────────────────────────────────────────────────────────────
  // GET /notion/pages/:id — retrieve a single page (+ markdown content)
  // ─────────────────────────────────────────────────────────────
  app.get("/notion/pages/:id", async (c) => {
    const service = ensureService();
    if (!service) {
      return respondWithAgentError(c, 503, [
        composeIssue("notion.not_configured", {
          field: "services.notion",
          received: "<unavailable>",
        }),
      ]);
    }

    const pageId = c.req.param("id");
    if (!isValidPageId(pageId)) {
      return respondWithAgentError(c, 400, [
        composeIssue("notion.invalid_page_id", {
          field: "id",
          received: pageId,
        }),
      ]);
    }

    const includeMarkdown = c.req.query("markdown") !== "false";
    const includeTranscript = c.req.query("include_transcript") === "true";

    try {
      const page = await service.getPage(pageId, {
        includeMarkdown,
        includeTranscript,
      });
      return c.json(page);
    } catch (err) {
      if (isNotionNotFound(err)) {
        return respondWithAgentError(c, 404, [
          composeIssue("notion.not_found", {
            field: "pageId",
            received: pageId,
          }),
        ], { legacyFields: { pageId } });
      }
      logger.warn({ err, pageId }, "Notion page retrieval failed");
      return respondWithAgentError(c, 502, [
        composeIssue("notion.upstream_error", {
          field: "notion.getPage",
          received: toSafeErrorMessage(err),
        }),
      ], { legacyErrorCode: "notion_get_failed", legacyFields: { message: toSafeErrorMessage(err) } });
    }
  });

  // ─────────────────────────────────────────────────────────────
  // POST /notion/pages — create a new page
  // ─────────────────────────────────────────────────────────────
  app.post("/notion/pages", async (c) => {
    const service = ensureService();
    if (!service) {
      return respondWithAgentError(c, 503, [
        composeIssue("notion.not_configured", {
          field: "services.notion",
          received: "<unavailable>",
        }),
      ]);
    }

    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.body as {
      parent?: unknown;
      properties?: CreatePageParameters["properties"];
      icon?: CreatePageParameters["icon"];
      cover?: CreatePageParameters["cover"];
      markdown?: string;
      children?: CreatePageParameters["children"];
    };

    const parent = resolveParent(body.parent, service);
    if (!parent) {
      return respondWithAgentError(c, 400, [
        composeIssue("notion.invalid_parent", {
          field: "parent",
          received: body.parent ?? "<missing>",
        }),
      ], {
        legacyFields: {
          message:
            "parent must be one of: a database label string, { database: 'label' }, { data_source_id: '...' }, or { page_id: '...' }",
        },
      });
    }

    return withWriteLock(async () => {
      try {
        const page = await service.createPage({
          parent,
          properties: body.properties,
          icon: body.icon,
          cover: body.cover,
          markdown: body.markdown,
          children: body.children,
        });
        markAgentWrite(page.id);
        return c.json({ status: "created", page });
      } catch (err) {
        logger.error({ err }, "Notion create page failed");
        return respondWithAgentError(c, 502, [
          composeIssue("notion.upstream_error", {
            field: "notion.createPage",
            received: toSafeErrorMessage(err),
          }),
        ], { legacyErrorCode: "notion_create_failed", legacyFields: { message: toSafeErrorMessage(err) } });
      }
    });
  });

  // ─────────────────────────────────────────────────────────────
  // PATCH /notion/pages/:id — update page metadata (properties/icon/…)
  // ─────────────────────────────────────────────────────────────
  app.patch("/notion/pages/:id", async (c) => {
    const service = ensureService();
    if (!service) {
      return respondWithAgentError(c, 503, [
        composeIssue("notion.not_configured", {
          field: "services.notion",
          received: "<unavailable>",
        }),
      ]);
    }

    const pageId = c.req.param("id");
    if (!isValidPageId(pageId)) {
      return respondWithAgentError(c, 400, [
        composeIssue("notion.invalid_page_id", {
          field: "id",
          received: pageId,
        }),
      ]);
    }

    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.body as Omit<UpdatePageParameters, "page_id">;
    if (Object.keys(body).length === 0) {
      return respondWithAgentError(c, 400, [
        composeIssue("notion.empty_body", {
          field: "body",
          received: "<empty>",
        }),
      ], { legacyFields: { message: "PATCH requires at least one field to update" } });
    }

    return withWriteLock(async () => {
      try {
        markAgentWrite(pageId);
        const page = await service.updatePageProperties(pageId, body);
        return c.json({ status: "updated", page });
      } catch (err) {
        if (isNotionNotFound(err)) {
          return respondWithAgentError(c, 404, [
          composeIssue("notion.not_found", {
            field: "pageId",
            received: pageId,
          }),
        ], { legacyFields: { pageId } });
        }
        logger.error({ err, pageId }, "Notion update page failed");
        return respondWithAgentError(c, 502, [
          composeIssue("notion.upstream_error", {
            field: "notion.updatePageProperties",
            received: toSafeErrorMessage(err),
          }),
        ], { legacyErrorCode: "notion_update_failed", legacyFields: { message: toSafeErrorMessage(err) } });
      }
    });
  });

  // ─────────────────────────────────────────────────────────────
  // PATCH /notion/pages/:id/content — markdown content edits
  // ─────────────────────────────────────────────────────────────
  app.patch("/notion/pages/:id/content", async (c) => {
    const service = ensureService();
    if (!service) {
      return respondWithAgentError(c, 503, [
        composeIssue("notion.not_configured", {
          field: "services.notion",
          received: "<unavailable>",
        }),
      ]);
    }

    const pageId = c.req.param("id");
    if (!isValidPageId(pageId)) {
      return respondWithAgentError(c, 400, [
        composeIssue("notion.invalid_page_id", {
          field: "id",
          received: pageId,
        }),
      ]);
    }

    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.body as {
      mode?: "append" | "replace_all" | "replace_range" | "update";
      content?: string;
      after?: string;
      contentRange?: string;
      updates?: Array<{ oldStr: string; newStr: string; replaceAll?: boolean }>;
      allowDeleting?: boolean;
    };

    let operation: NotionContentMode;
    switch (body.mode) {
      case "append":
        if (typeof body.content !== "string") {
          return respondWithAgentError(c, 400, [
            composeIssue("notion.content_required", {
              field: "content",
              received: body.content === undefined ? "<missing>" : typeof body.content,
              hint: "mode='append' requires `content` (string).",
            }),
          ], { legacyErrorCode: "content_required_for_append" });
        }
        operation = { kind: "append", content: body.content, after: body.after };
        break;
      case "replace_all":
        if (typeof body.content !== "string") {
          return respondWithAgentError(c, 400, [
            composeIssue("notion.content_required", {
              field: "content",
              received: body.content === undefined ? "<missing>" : typeof body.content,
              hint: "mode='replace_all' requires `content` (string) to rewrite the whole page.",
            }),
          ], { legacyErrorCode: "content_required_for_replace_all" });
        }
        operation = { kind: "replace_all", content: body.content };
        break;
      case "replace_range":
        if (typeof body.content !== "string" || typeof body.contentRange !== "string") {
          return respondWithAgentError(c, 400, [
            composeIssue("notion.content_range_required", {
              field: "body",
              received: {
                content: body.content === undefined ? "<missing>" : typeof body.content,
                contentRange: body.contentRange === undefined ? "<missing>" : typeof body.contentRange,
              },
            }),
          ], { legacyErrorCode: "content_and_contentRange_required_for_replace_range" });
        }
        operation = {
          kind: "replace_range",
          content: body.content,
          contentRange: body.contentRange,
          allowDeleting: body.allowDeleting,
        };
        break;
      case "update":
        if (!Array.isArray(body.updates) || body.updates.length === 0) {
          return respondWithAgentError(c, 400, [
            composeIssue("notion.updates_required", {
              field: "updates",
              received: body.updates === undefined ? "<missing>" : Array.isArray(body.updates) ? "<empty>" : typeof body.updates,
            }),
          ], { legacyErrorCode: "updates_required_for_update" });
        }
        for (const [i, u] of body.updates.entries()) {
          if (
            typeof u?.oldStr !== "string" ||
            typeof u?.newStr !== "string" ||
            u.oldStr.length === 0
          ) {
            return respondWithAgentError(c, 400, [
              composeIssue("notion.updates_element_invalid", {
                field: `updates[${i}]`,
                received: u,
              }),
            ], { legacyErrorCode: "updates_element_invalid", legacyFields: { message: `updates[${i}] must have string oldStr (non-empty) and newStr` } });
          }
        }
        operation = {
          kind: "update",
          updates: body.updates,
          allowDeleting: body.allowDeleting,
        };
        break;
      default:
        return respondWithAgentError(c, 400, [
          composeIssue("notion.invalid_mode", {
            field: "mode",
            received: body.mode ?? "<missing>",
          }),
        ], { legacyFields: { message: "mode must be 'append', 'replace_all', 'replace_range', or 'update'" } });
    }

    return withWriteLock(async () => {
      try {
        markAgentWrite(pageId);
        await service.updatePageContent(pageId, operation);
        // Fetch the post-update snapshot (properties only, no markdown —
        // the caller already has the content it just wrote) so the
        // response shape matches POST/PATCH/DELETE: `{ status, page }`.
        const page = await service.getPage(pageId, { includeMarkdown: false });
        return c.json({ status: "updated", page });
      } catch (err) {
        if (isNotionNotFound(err)) {
          return respondWithAgentError(c, 404, [
          composeIssue("notion.not_found", {
            field: "pageId",
            received: pageId,
          }),
        ], { legacyFields: { pageId } });
        }
        logger.error({ err, pageId }, "Notion content update failed");
        return respondWithAgentError(c, 502, [
          composeIssue("notion.upstream_error", {
            field: "notion.updatePageContent",
            received: toSafeErrorMessage(err),
          }),
        ], { legacyErrorCode: "notion_content_update_failed", legacyFields: { message: toSafeErrorMessage(err) } });
      }
    });
  });

  // ─────────────────────────────────────────────────────────────
  // DELETE /notion/pages/:id — move to trash (recoverable)
  // ─────────────────────────────────────────────────────────────
  app.delete("/notion/pages/:id", async (c) => {
    const service = ensureService();
    if (!service) {
      return respondWithAgentError(c, 503, [
        composeIssue("notion.not_configured", {
          field: "services.notion",
          received: "<unavailable>",
        }),
      ]);
    }

    const pageId = c.req.param("id");
    if (!isValidPageId(pageId)) {
      return respondWithAgentError(c, 400, [
        composeIssue("notion.invalid_page_id", {
          field: "id",
          received: pageId,
        }),
      ]);
    }

    return withWriteLock(async () => {
      try {
        markAgentWrite(pageId);
        const page = await service.archivePage(pageId);
        return c.json({ status: "archived", page });
      } catch (err) {
        if (isNotionNotFound(err)) {
          return respondWithAgentError(c, 404, [
          composeIssue("notion.not_found", {
            field: "pageId",
            received: pageId,
          }),
        ], { legacyFields: { pageId } });
        }
        logger.error({ err, pageId }, "Notion archive failed");
        return respondWithAgentError(c, 502, [
          composeIssue("notion.upstream_error", {
            field: "notion.archivePage",
            received: toSafeErrorMessage(err),
          }),
        ], { legacyErrorCode: "notion_archive_failed", legacyFields: { message: toSafeErrorMessage(err) } });
      }
    });
  });

  return app;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * Notion page IDs are 32-hex UUIDs, optionally hyphenated in 8-4-4-4-12
 * form. We reject anything else rather than echoing it to Notion's API
 * just to have Notion return a 400 — this preserves REST error-shape
 * expectations on the agent side.
 */
function isValidPageId(id: string | undefined): id is string {
  /* v8 ignore next */
  if (!id) return false;
  return PAGE_ID_REGEX.test(id);
}

/**
 * Duck-typed 404 detector for Notion errors. We don't import
 * `APIErrorCode` / `isNotionClientError` statically because
 * `@notionhq/client` is loaded dynamically inside `NotionService.init()`
 * and a top-level value import would break the optional-dependency
 * contract. The REST-level `code` and `status` fields are stable across
 * versions, so structural matching is safe.
 */
function isNotionNotFound(err: unknown): boolean {
  /* v8 ignore next */
  if (err === null || typeof err !== "object") return false;
  const e = err as { code?: unknown; status?: unknown };
  if (e.code === "object_not_found") return true;
  if (e.status === 404) return true;
  return false;
}

/**
 * Resolve a user-supplied `parent` field to the shape Notion's API expects.
 *
 * Accepts:
 *  - `"tasks"` — database label from config
 *  - `{ database: "tasks" }` — same, explicit
 *  - `{ data_source_id: "uuid" }` — raw Notion data source
 *  - `{ database_id: "uuid" }` — raw Notion database
 *  - `{ page_id: "uuid" }` — parent page
 */
function resolveParent(
  input: unknown,
  service: NotionService,
): CreatePageParameters["parent"] | null {
  if (typeof input === "string") {
    const id = service.resolveDatabaseId(input);
    return id ? { data_source_id: id, type: "data_source_id" } : null;
  }
  if (typeof input !== "object" || input === null) return null;
  const obj = input as Record<string, unknown>;

  if (typeof obj.database === "string") {
    const id = service.resolveDatabaseId(obj.database);
    return id ? { data_source_id: id, type: "data_source_id" } : null;
  }
  if (typeof obj.data_source_id === "string") {
    return { data_source_id: obj.data_source_id, type: "data_source_id" };
  }
  if (typeof obj.database_id === "string") {
    return { database_id: obj.database_id, type: "database_id" };
  }
  if (typeof obj.page_id === "string") {
    return { page_id: obj.page_id, type: "page_id" };
  }
  return null;
}
