import { createLogger } from "../logging.js";
import type { AgentConfig } from "../config.js";
import type { SecretBroker } from "../secrets/secret-broker.js";
import { raceWithAbort as raceNotionWithAbort } from "../core/abort-utils.js";
import type {
  Client as NotionClientType,
  QueryDataSourceParameters,
  QueryDataSourceResponse,
  SearchParameters,
  CreatePageParameters,
  UpdatePageParameters,
  PageObjectResponse,
} from "@notionhq/client";

const logger = createLogger("notion-service");

/**
 * Upper bound on pages walked per `queryUpdatedSince` call. Each page
 * holds up to 100 rows, so 50 pages ≈ 5000 rows per tick — generous
 * for a single poll window, finite enough to keep the poller responsive
 * when the cursor is far behind (cold start, mode flip, long downtime).
 * When the cap is hit the iterator stops; the caller's cursor advances
 * to the last yielded `last_edited_time` so the next tick resumes from
 * the same point.
 */
const NOTION_DEFAULT_MAX_PAGES = 50;

type NotionClient = NotionClientType;
type UpdateMarkdownArgs = Parameters<NotionClient["pages"]["updateMarkdown"]>[0];

/**
 * Local narrowing predicate so this module has no static value import
 * from `@notionhq/client` — the package is imported dynamically inside
 * `init()` and treated as optional.
 *
 * We discriminate on `object === "page"` rather than duck-typing on
 * `properties` / `last_edited_time`, because `DataSourceObjectResponse`
 * also has both of those fields (with different semantics) and would
 * slip through a structural check.
 */
function isFullPage(page: { object?: string }): page is PageObjectResponse {
  return page != null && (page as { object?: string }).object === "page";
}

/** Shape returned to API clients — both the raw Notion response and a
 *  flattened property bag that the agent can consume without traversing
 *  Notion's nested JSON.
 */
export interface SimplifiedPage {
  id: string;
  url: string;
  lastEditedTime: string;
  createdTime: string;
  inTrash: boolean;
  icon: unknown;
  cover: unknown;
  parent: unknown;
  properties: Record<string, unknown>;
}

export interface NotionPageWithContent extends SimplifiedPage {
  markdown: string | null;
  markdownTruncated: boolean;
  unknownBlockIds: string[];
}

export interface NotionQueryResult {
  results: SimplifiedPage[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface NotionSearchHit {
  id: string;
  object: "page" | "data_source";
  title: string;
  url: string | null;
  lastEditedTime: string | null;
  parent: unknown;
}

export interface NotionSearchResult {
  results: NotionSearchHit[];
  hasMore: boolean;
  nextCursor: string | null;
}

export type NotionContentMode =
  | { kind: "append"; content: string; after?: string }
  | { kind: "replace_all"; content: string }
  | { kind: "replace_range"; content: string; contentRange: string; allowDeleting?: boolean }
  | {
      kind: "update";
      updates: Array<{ oldStr: string; newStr: string; replaceAll?: boolean }>;
      allowDeleting?: boolean;
    };

/**
 * NotionService — sole owner of the `@notionhq/client` instance.
 *
 * All Notion reads and writes from the daemon go through this class:
 *  - NotionPoller calls `queryUpdatedSince` and `queryTrashedSince`
 *  - The Hono route layer at `api/routes/notion.ts` delegates every
 *    endpoint here
 *
 * Secrets stay in SecretBroker; the client is (re)built in `init()`.
 */
export class NotionService {
  private readonly databaseIds: Record<string, string>;
  private client: NotionClient | null = null;

  constructor(
    config: Pick<AgentConfig, "notionDatabaseIds">,
    private readonly secretBroker: SecretBroker,
  ) {
    this.databaseIds = config.notionDatabaseIds;
  }

  get available(): boolean {
    return this.client !== null;
  }

  async init(): Promise<void> {
    const apiKey = await this.secretBroker.getNotionApiKey();
    if (!apiKey) {
      logger.warn("Notion API key not configured");
      return;
    }

    try {
      const mod = await import("@notionhq/client");
      this.client = new mod.Client({ auth: apiKey });
      logger.info(
        { databases: Object.keys(this.databaseIds) },
        "Notion service initialized",
      );
    } catch {
      throw new Error(
        "@notionhq/client not installed. Run: pnpm --filter @aitne/daemon add @notionhq/client",
      );
    }
  }

  /** List human-readable database labels configured via `PA_NOTION_DATABASE_IDS`. */
  listDatabases(): Array<{ label: string; id: string }> {
    return Object.entries(this.databaseIds).map(([label, id]) => ({ label, id }));
  }

  /**
   * Resolve a label (e.g. `"tasks"`) or raw UUID to a Notion data-source ID.
   * Returns `null` if the label is unknown — the caller emits a 404.
   */
  resolveDatabaseId(labelOrId: string): string | null {
    if (this.databaseIds[labelOrId]) return this.databaseIds[labelOrId];
    // Allow raw UUIDs / hyphenated IDs to pass through so the agent can
    // target databases outside the configured label map.
    if (/^[0-9a-f-]{32,36}$/i.test(labelOrId)) return labelOrId;
    return null;
  }

  private requireClient(): NotionClient {
    if (!this.client) {
      throw new Error("notion_not_configured");
    }
    return this.client;
  }

  // ─────────────────────────────────────────────────────────────
  // Read: query
  // ─────────────────────────────────────────────────────────────

  async queryDatabase(params: {
    databaseId: string;
    filter?: QueryDataSourceParameters["filter"];
    sorts?: QueryDataSourceParameters["sorts"];
    pageSize?: number;
    startCursor?: string;
    inTrash?: boolean;
  }): Promise<NotionQueryResult> {
    const client = this.requireClient();
    const response = await client.dataSources.query({
      data_source_id: params.databaseId,
      filter: params.filter,
      sorts: params.sorts,
      page_size: Math.min(params.pageSize ?? 20, 100),
      start_cursor: params.startCursor,
      in_trash: params.inTrash,
    });
    return {
      results: response.results
        .filter(isFullPage)
        .map((page) => simplifyPage(page)),
      hasMore: response.has_more,
      nextCursor: response.next_cursor,
    };
  }

  /**
   * Paginated async iterator for poller use — yields every page
   * edited strictly after `lastEditedTime` across all pages of results.
   * Walks `has_more` / `next_cursor` until the data source is exhausted
   * OR `maxPages` is reached, whichever comes first.
   *
   * `signal` is checked between page fetches AND wraps each underlying
   * SDK call via `raceWithAbort` (defensive — `@notionhq/client` v5's
   * `dataSources.query` signature does not surface a RequestOptions arg,
   * so we cannot pass the signal natively). A fired signal yields
   * whatever has accumulated so far and returns; callers (NotionPoller)
   * keep partial progress via the `last_edited_time` cursor advance, so
   * the next tick resumes from where this one stopped.
   *
   * `maxPages` defaults to {@link NOTION_DEFAULT_MAX_PAGES} so a Notion
   * data source with millions of edited rows since the seeded cursor
   * (e.g. cold-cursor on a flip back to direct mode) cannot pin the
   * poller indefinitely walking the backlog.
   */
  async *queryUpdatedSince(
    databaseId: string,
    lastEditedTime: string,
    opts: { inTrash?: boolean; maxPages?: number; signal?: AbortSignal } = {},
  ): AsyncIterable<PageObjectResponse> {
    const client = this.requireClient();
    const maxPages = opts.maxPages ?? NOTION_DEFAULT_MAX_PAGES;
    let cursor: string | undefined;
    let pages = 0;
    do {
      if (opts.signal?.aborted) return;
      const queryPromise = client.dataSources.query({
        data_source_id: databaseId,
        filter: {
          timestamp: "last_edited_time",
          last_edited_time: { after: lastEditedTime },
        },
        sorts: [{ timestamp: "last_edited_time", direction: "ascending" }],
        page_size: 100,
        start_cursor: cursor,
        in_trash: opts.inTrash,
      });
      const response: QueryDataSourceResponse = opts.signal
        ? await raceNotionWithAbort(queryPromise, opts.signal)
        : await queryPromise;
      for (const page of response.results) {
        if (isFullPage(page)) yield page;
      }
      cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
      pages += 1;
      if (cursor && pages >= maxPages) {
        logger.warn(
          { databaseId, pages, maxPages, lastEditedTime },
          "queryUpdatedSince hit page cap — remaining pages deferred to next tick",
        );
        return;
      }
    } while (cursor);
  }

  // ─────────────────────────────────────────────────────────────
  // Read: search
  // ─────────────────────────────────────────────────────────────

  async search(params: {
    query?: string;
    filterType?: "page" | "data_source";
    sortDirection?: "ascending" | "descending";
    pageSize?: number;
    startCursor?: string;
  }): Promise<NotionSearchResult> {
    const client = this.requireClient();
    const searchParams: SearchParameters = {
      query: params.query,
      sort: {
        timestamp: "last_edited_time",
        direction: params.sortDirection ?? "descending",
      },
      page_size: Math.min(params.pageSize ?? 20, 100),
      start_cursor: params.startCursor,
    };
    if (params.filterType) {
      searchParams.filter = { property: "object", value: params.filterType };
    }
    const response = await client.search(searchParams);
    return {
      results: response.results.map(simplifySearchHit).filter((r): r is NotionSearchHit => r !== null),
      hasMore: response.has_more,
      nextCursor: response.next_cursor,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Read: page
  // ─────────────────────────────────────────────────────────────

  async getPage(
    pageId: string,
    opts: { includeMarkdown?: boolean; includeTranscript?: boolean } = {},
  ): Promise<NotionPageWithContent> {
    const client = this.requireClient();
    const page = await client.pages.retrieve({ page_id: pageId });
    if (!isFullPage(page)) {
      throw new Error("notion_page_partial_response");
    }

    let markdown: string | null = null;
    let markdownTruncated = false;
    let unknownBlockIds: string[] = [];

    if (opts.includeMarkdown ?? true) {
      try {
        const md = await client.pages.retrieveMarkdown({
          page_id: pageId,
          include_transcript: opts.includeTranscript,
        });
        markdown = md.markdown;
        markdownTruncated = md.truncated;
        unknownBlockIds = md.unknown_block_ids;
      } catch (err) {
        // Markdown fetch is best-effort — some block types (databases,
        // embeds) may not be representable as markdown. Log but still
        // return the properties so the caller can keep working.
        logger.warn({ err, pageId }, "Notion markdown fetch failed");
      }
    }

    return {
      ...simplifyPage(page),
      markdown,
      markdownTruncated,
      unknownBlockIds,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Write: create / update / archive
  // ─────────────────────────────────────────────────────────────

  async createPage(params: {
    parent: CreatePageParameters["parent"];
    properties?: CreatePageParameters["properties"];
    icon?: CreatePageParameters["icon"];
    cover?: CreatePageParameters["cover"];
    markdown?: string;
    children?: CreatePageParameters["children"];
  }): Promise<SimplifiedPage> {
    const client = this.requireClient();
    const response = await client.pages.create({
      parent: params.parent,
      properties: params.properties,
      icon: params.icon,
      cover: params.cover,
      markdown: params.markdown,
      children: params.children,
    });
    if (!isFullPage(response)) {
      throw new Error("notion_create_partial_response");
    }
    return simplifyPage(response);
  }

  async updatePageProperties(
    pageId: string,
    body: Omit<UpdatePageParameters, "page_id">,
  ): Promise<SimplifiedPage> {
    const client = this.requireClient();
    const response = await client.pages.update({ page_id: pageId, ...body });
    if (!isFullPage(response)) {
      throw new Error("notion_update_partial_response");
    }
    return simplifyPage(response);
  }

  /** Edit the markdown content of a page via v5's `pages.updateMarkdown` endpoint. */
  async updatePageContent(pageId: string, mode: NotionContentMode): Promise<void> {
    const client = this.requireClient();
    await client.pages.updateMarkdown(buildMarkdownUpdateArgs(pageId, mode));
  }

  /** Move a page to trash (recoverable for 30 days — Notion's own retention). */
  async archivePage(pageId: string): Promise<SimplifiedPage> {
    return this.updatePageProperties(pageId, { in_trash: true });
  }

  // NOTE: there is intentionally no `restorePage` method. Clients restore
  // a trashed page by calling `updatePageProperties(pageId, { in_trash: false })`
  // directly (or `PATCH /api/notion/pages/:id` with `{"in_trash": false}`).
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

export function simplifyPage(page: PageObjectResponse): SimplifiedPage {
  return {
    id: page.id,
    url: page.url,
    lastEditedTime: page.last_edited_time,
    createdTime: page.created_time,
    inTrash: Boolean(page.in_trash ?? page.archived),
    icon: page.icon,
    cover: page.cover,
    parent: page.parent,
    properties: flattenProperties(page.properties),
  };
}

export function flattenProperties(
  props: PageObjectResponse["properties"],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(props)) {
    out[name] = extractPropertyValue(prop);
  }
  return out;
}

function extractPropertyValue(prop: Record<string, unknown>): unknown {
  switch (prop.type) {
    case "title":
    case "rich_text": {
      const arr = prop[prop.type as string] as Array<{ plain_text: string }> | undefined;
      return arr?.map((t) => t.plain_text).join("") ?? "";
    }
    case "number":
      return prop.number ?? null;
    case "select":
      return (prop.select as { name: string } | null)?.name ?? null;
    case "multi_select":
      return (prop.multi_select as Array<{ name: string }> | null)?.map((s) => s.name) ?? [];
    case "date":
      return prop.date ?? null;
    case "checkbox":
      return Boolean(prop.checkbox);
    case "url":
      return (prop.url as string | null) ?? null;
    case "email":
      return (prop.email as string | null) ?? null;
    case "phone_number":
      return (prop.phone_number as string | null) ?? null;
    case "status":
      return (prop.status as { name: string } | null)?.name ?? null;
    case "relation":
      return (prop.relation as Array<{ id: string }> | null)?.map((r) => r.id) ?? [];
    case "people":
      return (prop.people as Array<{ id: string }> | null)?.map((p) => p.id) ?? [];
    case "files":
      return (prop.files as Array<{ name: string }> | null)?.map((f) => f.name) ?? [];
    case "formula":
      return (prop.formula as { string?: string; number?: number; boolean?: boolean; date?: unknown } | null) ?? null;
    case "created_time":
    case "last_edited_time":
      return prop[prop.type as string] ?? null;
    case "unique_id":
      return prop.unique_id ?? null;
    default:
      return null;
  }
}

function simplifySearchHit(
  hit: Record<string, unknown>,
): NotionSearchHit | null {
  const object = hit.object as string;
  if (object !== "page" && object !== "data_source") return null;

  let title = "";
  if (object === "page" && hit.properties) {
    for (const prop of Object.values(
      hit.properties as Record<string, Record<string, unknown>>,
    )) {
      if (prop.type === "title") {
        const arr = prop.title as Array<{ plain_text: string }> | undefined;
        title = arr?.map((t) => t.plain_text).join("") ?? "";
        break;
      }
    }
  } else if (object === "data_source") {
    const arr = hit.title as Array<{ plain_text: string }> | undefined;
    title = arr?.map((t) => t.plain_text).join("") ?? "";
  }

  return {
    id: hit.id as string,
    object: object as "page" | "data_source",
    title,
    url: (hit.url as string | undefined) ?? null,
    lastEditedTime: (hit.last_edited_time as string | undefined) ?? null,
    parent: hit.parent ?? null,
  };
}

function buildMarkdownUpdateArgs(
  pageId: string,
  mode: NotionContentMode,
): UpdateMarkdownArgs {
  switch (mode.kind) {
    case "append":
      return {
        page_id: pageId,
        type: "insert_content",
        insert_content: { content: mode.content, after: mode.after },
      };
    case "replace_all":
      return {
        page_id: pageId,
        type: "replace_content",
        replace_content: { new_str: mode.content, allow_deleting_content: true },
      };
    case "replace_range":
      return {
        page_id: pageId,
        type: "replace_content_range",
        replace_content_range: {
          content: mode.content,
          content_range: mode.contentRange,
          allow_deleting_content: mode.allowDeleting,
        },
      };
    case "update":
      return {
        page_id: pageId,
        type: "update_content",
        update_content: {
          content_updates: mode.updates.map((u) => ({
            old_str: u.oldStr,
            new_str: u.newStr,
            replace_all_matches: u.replaceAll,
          })),
          allow_deleting_content: mode.allowDeleting,
        },
      };
  }
}
