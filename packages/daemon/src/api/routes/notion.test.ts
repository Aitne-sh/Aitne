import { describe, it, expect, vi } from "vitest";
import { createNotionRoutes } from "./notion.js";
import { AgentWriteTracker } from "../../safety/agent-write-tracker.js";
import type { NotionService, SimplifiedPage } from "../../services/notion.js";

/**
 * Tests for the Notion API routes.
 *
 * NotionService wraps `@notionhq/client`, which is a hard external
 * dependency. These tests mock NotionService directly so we verify
 * the HTTP routing layer (argument parsing, response shape, risk
 * attribution) without hitting Notion's servers.
 */
describe("Notion API routes", () => {
  const samplePage: SimplifiedPage = {
    id: "abcdef0123456789abcdef0123456789",
    url: "https://notion.so/abcdef",
    lastEditedTime: "2026-04-10T12:00:00.000Z",
    createdTime: "2026-04-10T11:00:00.000Z",
    inTrash: false,
    icon: null,
    cover: null,
    parent: { type: "data_source_id", data_source_id: "db-123" },
    properties: { Name: "Sample page", Status: "Doing" },
  };

  function makeService(overrides: Partial<NotionService> = {}): NotionService {
    return {
      available: true,
      listDatabases: vi.fn().mockReturnValue([
        { label: "tasks", id: "db-123" },
        { label: "projects", id: "db-456" },
      ]),
      resolveDatabaseId: vi.fn((labelOrId: string) => {
        if (labelOrId === "tasks") return "db-123";
        if (labelOrId === "projects") return "db-456";
        if (/^[0-9a-f-]{32,36}$/i.test(labelOrId)) return labelOrId;
        return null;
      }),
      queryDatabase: vi
        .fn()
        .mockResolvedValue({ results: [samplePage], hasMore: false, nextCursor: null }),
      search: vi.fn().mockResolvedValue({
        results: [
          {
            id: samplePage.id,
            object: "page",
            title: "Sample page",
            url: samplePage.url,
            lastEditedTime: samplePage.lastEditedTime,
            parent: samplePage.parent,
          },
        ],
        hasMore: false,
        nextCursor: null,
      }),
      getPage: vi.fn().mockResolvedValue({
        ...samplePage,
        markdown: "# Sample\n\nBody",
        markdownTruncated: false,
        unknownBlockIds: [],
      }),
      createPage: vi.fn().mockResolvedValue(samplePage),
      updatePageProperties: vi.fn().mockResolvedValue(samplePage),
      updatePageContent: vi.fn().mockResolvedValue(undefined),
      archivePage: vi
        .fn()
        .mockResolvedValue({ ...samplePage, inTrash: true }),
      ...overrides,
    } as unknown as NotionService;
  }

  // ────────────────────────────────────────────────────────────
  // Availability gating
  // ────────────────────────────────────────────────────────────
  it("returns 503 on every endpoint when the service is unavailable", async () => {
    const service = { available: false } as unknown as NotionService;
    const app = createNotionRoutes({ notionService: service });

    for (const path of [
      "/notion/databases",
      "/notion/query?database=tasks",
      "/notion/search?q=test",
      `/notion/pages/${samplePage.id}`,
    ]) {
      const res = await app.request(path);
      expect(res.status).toBe(503);
    }
  });

  it("returns 503 when notionService is null", async () => {
    const app = createNotionRoutes({ notionService: null });
    const res = await app.request("/notion/databases");
    expect(res.status).toBe(503);
  });

  // ────────────────────────────────────────────────────────────
  // GET /notion/databases
  // ────────────────────────────────────────────────────────────
  it("lists configured databases", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request("/notion/databases");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { databases: Array<{ label: string; id: string }> };
    expect(body.databases).toHaveLength(2);
    expect(body.databases[0]).toEqual({ label: "tasks", id: "db-123" });
  });

  // ────────────────────────────────────────────────────────────
  // GET /notion/query
  // ────────────────────────────────────────────────────────────
  it("queries a database by label", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request("/notion/query?database=tasks");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: unknown[]; has_more: boolean };
    expect(body.results).toHaveLength(1);
    expect(body.has_more).toBe(false);
    expect(service.queryDatabase).toHaveBeenCalledWith(
      expect.objectContaining({ databaseId: "db-123" }),
    );
  });

  it("defaults to tasks database when database param is absent", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request("/notion/query");
    expect(res.status).toBe(200);
    expect(service.queryDatabase).toHaveBeenCalledWith(
      expect.objectContaining({ databaseId: "db-123" }),
    );
  });

  it("returns 404 when the label is unknown", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request("/notion/query?database=nope");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; available: string[] };
    expect(body.error).toBe("database_not_found");
    expect(body.available).toContain("tasks");
  });

  it("parses filter/sorts JSON parameters", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const filter = encodeURIComponent(JSON.stringify({ property: "Status", status: { equals: "Doing" } }));
    const sorts = encodeURIComponent(JSON.stringify([{ property: "Name", direction: "ascending" }]));
    const res = await app.request(
      `/notion/query?database=tasks&filter=${filter}&sorts=${sorts}&page_size=5`,
    );
    expect(res.status).toBe(200);
    expect(service.queryDatabase).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: { property: "Status", status: { equals: "Doing" } },
        sorts: [{ property: "Name", direction: "ascending" }],
        pageSize: 5,
      }),
    );
  });

  it("returns 400 for invalid JSON in filter/sorts", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request("/notion/query?database=tasks&filter=%7Bnotjson");
    expect(res.status).toBe(400);
  });

  it("flags `sorts` (not `filter`) when only the sorts param is malformed", async () => {
    // Exercises the false branch of `filterParam && !sortsParam ? "filter" : "sorts"`
    // — when filter is absent, the field label flips to `sorts`.
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request("/notion/query?database=tasks&sorts=%7Bnotjson");
    expect(res.status).toBe(400);
    const body = await res.json() as { errors: Array<{ field: string }> };
    expect(body.errors[0].field).toBe("sorts");
  });

  it("forwards in_trash=true to the service", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request("/notion/query?database=tasks&in_trash=true");
    expect(res.status).toBe(200);
    expect(service.queryDatabase).toHaveBeenCalledWith(
      expect.objectContaining({ inTrash: true }),
    );
  });

  it("omits in_trash flag when not specified", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    await app.request("/notion/query?database=tasks");
    expect(service.queryDatabase).toHaveBeenCalledWith(
      expect.objectContaining({ inTrash: undefined }),
    );
  });

  // ────────────────────────────────────────────────────────────
  // GET /notion/search
  // ────────────────────────────────────────────────────────────
  it("searches the workspace", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request("/notion/search?q=sample&type=page&sort=ascending");
    expect(res.status).toBe(200);
    expect(service.search).toHaveBeenCalledWith({
      query: "sample",
      filterType: "page",
      sortDirection: "ascending",
      pageSize: 20,
      startCursor: undefined,
    });
  });

  it("rejects invalid type parameter", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request("/notion/search?type=database");
    expect(res.status).toBe(400);
  });

  // ────────────────────────────────────────────────────────────
  // GET /notion/pages/:id
  // ────────────────────────────────────────────────────────────
  it("retrieves a page with markdown by default", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request(`/notion/pages/${samplePage.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { markdown: string };
    expect(body.markdown).toContain("Sample");
    expect(service.getPage).toHaveBeenCalledWith(
      samplePage.id,
      { includeMarkdown: true, includeTranscript: false },
    );
  });

  it("supports markdown=false to skip content fetch", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    await app.request(`/notion/pages/${samplePage.id}?markdown=false`);
    expect(service.getPage).toHaveBeenCalledWith(
      samplePage.id,
      { includeMarkdown: false, includeTranscript: false },
    );
  });

  it("rejects malformed page IDs", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });

    // Raw 32-hex should pass, 36-char UUID with proper structure should
    // pass, everything else should 400 — including strings that would
    // have squeaked through the old loose regex.
    for (const bad of [
      "not-a-uuid",
      "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "------------------------------------", // 36 hyphens — old regex passed
      "abcdef",
      "abcdefabcdefabcdefabcdefabcdefabcdef", // 36 hex chars without hyphens
    ]) {
      const res = await app.request(`/notion/pages/${bad}`);
      expect(res.status, `expected 400 for ${bad}`).toBe(400);
    }

    // And a well-formed hyphenated UUID should pass routing (delegates to service).
    const good = "11111111-2222-3333-4444-555555555555";
    const res = await app.request(`/notion/pages/${good}`);
    expect(res.status).toBe(200);
  });

  it("returns 404 when Notion reports object_not_found on GET", async () => {
    const service = makeService({
      getPage: vi.fn().mockRejectedValue(
        Object.assign(new Error("not found"), { code: "object_not_found" }),
      ),
    } as Partial<NotionService>);
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request(`/notion/pages/${samplePage.id}`);
    expect(res.status).toBe(404);
  });

  // ────────────────────────────────────────────────────────────
  // POST /notion/pages
  // ────────────────────────────────────────────────────────────
  it("creates a page under a configured database label", async () => {
    const service = makeService();
    const tracker = new AgentWriteTracker();
    const app = createNotionRoutes({ notionService: service, writeTracker: tracker });

    const res = await app.request("/notion/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parent: "tasks",
        properties: { Name: { title: [{ text: { content: "New task" } }] } },
        markdown: "## Details",
      }),
    });
    expect(res.status).toBe(200);
    expect(service.createPage).toHaveBeenCalledWith(
      expect.objectContaining({
        parent: { data_source_id: "db-123", type: "data_source_id" },
        markdown: "## Details",
      }),
    );
    expect(tracker.isMarked(`notion:${samplePage.id}`, null)).toBe(true);
  });

  it("accepts { page_id } parent for subpages", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request("/notion/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parent: { page_id: "11111111222233334444555566667777" },
        properties: { title: [{ text: { content: "Child" } }] },
      }),
    });
    expect(res.status).toBe(200);
    expect(service.createPage).toHaveBeenCalledWith(
      expect.objectContaining({
        parent: { page_id: "11111111222233334444555566667777", type: "page_id" },
      }),
    );
  });

  it("rejects POST with an unresolvable parent", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request("/notion/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parent: "nonsense-label" }),
    });
    expect(res.status).toBe(400);
  });

  // ────────────────────────────────────────────────────────────
  // PATCH /notion/pages/:id  (property update)
  // ────────────────────────────────────────────────────────────
  it("updates page properties and marks the write", async () => {
    const service = makeService();
    const tracker = new AgentWriteTracker();
    const app = createNotionRoutes({ notionService: service, writeTracker: tracker });

    const res = await app.request(`/notion/pages/${samplePage.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        properties: { Status: { status: { name: "Done" } } },
      }),
    });
    expect(res.status).toBe(200);
    expect(service.updatePageProperties).toHaveBeenCalledWith(
      samplePage.id,
      expect.objectContaining({
        properties: { Status: { status: { name: "Done" } } },
      }),
    );
    expect(tracker.isMarked(`notion:${samplePage.id}`, null)).toBe(true);
  });

  it("rejects empty PATCH bodies", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request(`/notion/pages/${samplePage.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
  });

  // ────────────────────────────────────────────────────────────
  // PATCH /notion/pages/:id/content  (markdown content update)
  // ────────────────────────────────────────────────────────────
  it("appends markdown content", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request(`/notion/pages/${samplePage.id}/content`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "append", content: "- Follow-up" }),
    });
    expect(res.status).toBe(200);
    expect(service.updatePageContent).toHaveBeenCalledWith(samplePage.id, {
      kind: "append",
      content: "- Follow-up",
      after: undefined,
    });
  });

  it("replaces the entire body via replace_all", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request(`/notion/pages/${samplePage.id}/content`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "replace_all", content: "# New body" }),
    });
    expect(res.status).toBe(200);
    expect(service.updatePageContent).toHaveBeenCalledWith(samplePage.id, {
      kind: "replace_all",
      content: "# New body",
    });
  });

  it("runs targeted find-and-replace via the update mode", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request(`/notion/pages/${samplePage.id}/content`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "update",
        updates: [{ oldStr: "TODO", newStr: "DONE", replaceAll: true }],
      }),
    });
    expect(res.status).toBe(200);
    expect(service.updatePageContent).toHaveBeenCalledWith(samplePage.id, {
      kind: "update",
      updates: [{ oldStr: "TODO", newStr: "DONE", replaceAll: true }],
      allowDeleting: undefined,
    });
  });

  it("rejects an unknown content mode", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request(`/notion/pages/${samplePage.id}/content`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "bogus", content: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects update-mode bodies with malformed updates[] entries", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request(`/notion/pages/${samplePage.id}/content`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "update",
        updates: [{ oldStr: "TODO", newStr: "DONE" }, { newStr: "missing oldStr" }],
      }),
    });
    expect(res.status).toBe(400);
    expect(service.updatePageContent).not.toHaveBeenCalled();
  });

  it("rejects update-mode with empty oldStr", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request(`/notion/pages/${samplePage.id}/content`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "update",
        updates: [{ oldStr: "", newStr: "anything" }],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns the updated page from the content PATCH response", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request(`/notion/pages/${samplePage.id}/content`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "append", content: "- x" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; page: { id: string } };
    expect(body.status).toBe("updated");
    expect(body.page.id).toBe(samplePage.id);
    // getPage is called after the content update to capture the new snapshot
    // without re-fetching the markdown the caller just wrote.
    expect(service.getPage).toHaveBeenCalledWith(
      samplePage.id,
      { includeMarkdown: false },
    );
  });

  it("returns 404 when content PATCH hits object_not_found", async () => {
    const service = makeService({
      updatePageContent: vi.fn().mockRejectedValue(
        Object.assign(new Error("not found"), { status: 404 }),
      ),
    } as Partial<NotionService>);
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request(`/notion/pages/${samplePage.id}/content`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "append", content: "x" }),
    });
    expect(res.status).toBe(404);
  });

  // ────────────────────────────────────────────────────────────
  // DELETE /notion/pages/:id
  // ────────────────────────────────────────────────────────────
  it("archives a page and marks the write", async () => {
    const service = makeService();
    const tracker = new AgentWriteTracker();
    const app = createNotionRoutes({ notionService: service, writeTracker: tracker });

    const res = await app.request(`/notion/pages/${samplePage.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; page: SimplifiedPage };
    expect(body.status).toBe("archived");
    expect(body.page.inTrash).toBe(true);
    expect(service.archivePage).toHaveBeenCalledWith(samplePage.id);
    expect(tracker.isMarked(`notion:${samplePage.id}`, null)).toBe(true);
  });

  it("propagates service failures as 502", async () => {
    const service = makeService({
      archivePage: vi.fn().mockRejectedValue(new Error("boom")),
    } as Partial<NotionService>);
    const app = createNotionRoutes({ notionService: service });

    const res = await app.request(`/notion/pages/${samplePage.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(502);
  });

  it("returns 404 when DELETE targets a missing page", async () => {
    const service = makeService({
      archivePage: vi.fn().mockRejectedValue(
        Object.assign(new Error("gone"), { code: "object_not_found" }),
      ),
    } as Partial<NotionService>);
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request(`/notion/pages/${samplePage.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 when PATCH (properties) hits object_not_found", async () => {
    const service = makeService({
      updatePageProperties: vi.fn().mockRejectedValue(
        Object.assign(new Error("gone"), { code: "object_not_found" }),
      ),
    } as Partial<NotionService>);
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request(`/notion/pages/${samplePage.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ properties: { Done: { checkbox: true } } }),
    });
    expect(res.status).toBe(404);
  });

  it("marks agent writes with a 15-minute TTL so the 300s poll still sees the mark", async () => {
    vi.useFakeTimers();
    try {
      const service = makeService();
      const tracker = new AgentWriteTracker();
      const app = createNotionRoutes({ notionService: service, writeTracker: tracker });

      await app.request("/notion/pages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parent: "tasks",
          properties: { Name: { title: [{ text: { content: "x" } }] } },
        }),
      });

      // After 5 minutes (i.e. after the calendar/notion poll cadence), the
      // default-TTL tracker would have expired the mark. We need it still
      // alive to attribute the observation correctly.
      vi.advanceTimersByTime(5 * 60_000 + 1_000);
      expect(tracker.isMarked(`notion:${samplePage.id}`, null)).toBe(true);

      // But well past the 15-minute override, the mark is gone.
      vi.advanceTimersByTime(15 * 60_000);
      expect(tracker.isMarked(`notion:${samplePage.id}`, null)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // ────────────────────────────────────────────────────────────
  // resolveParent — all parent shapes
  // ────────────────────────────────────────────────────────────
  it("accepts { database: 'label' } object form for parent", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request("/notion/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parent: { database: "tasks" },
        properties: { Name: { title: [{ text: { content: "x" } }] } },
      }),
    });
    expect(res.status).toBe(200);
    expect(service.createPage).toHaveBeenCalledWith(
      expect.objectContaining({
        parent: { data_source_id: "db-123", type: "data_source_id" },
      }),
    );
  });

  it("rejects { database: 'bad-label' } when label does not resolve", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request("/notion/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parent: { database: "no-such-db" } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_parent");
  });

  it("accepts { data_source_id: 'uuid' } parent directly", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request("/notion/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parent: { data_source_id: "abcdef0123456789abcdef0123456789" },
        properties: { Name: { title: [{ text: { content: "x" } }] } },
      }),
    });
    expect(res.status).toBe(200);
    expect(service.createPage).toHaveBeenCalledWith(
      expect.objectContaining({
        parent: { data_source_id: "abcdef0123456789abcdef0123456789", type: "data_source_id" },
      }),
    );
  });

  it("accepts { database_id: 'uuid' } parent directly", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request("/notion/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parent: { database_id: "abcdef0123456789abcdef0123456789" },
        properties: { Name: { title: [{ text: { content: "x" } }] } },
      }),
    });
    expect(res.status).toBe(200);
    expect(service.createPage).toHaveBeenCalledWith(
      expect.objectContaining({
        parent: { database_id: "abcdef0123456789abcdef0123456789", type: "database_id" },
      }),
    );
  });

  it("rejects non-object non-string parent (null)", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request("/notion/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parent: null }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_parent");
  });

  it("rejects an object parent with no known keys", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request("/notion/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parent: { unknown_field: "value" } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_parent");
  });

  // ────────────────────────────────────────────────────────────
  // POST /notion/pages — error paths
  // ────────────────────────────────────────────────────────────
  it("returns 503 when POST is called with null notion service", async () => {
    const app = createNotionRoutes({ notionService: null });
    const res = await app.request("/notion/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parent: "tasks", properties: {} }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("notion_not_configured");
  });

  it("returns 400 when POST body is invalid JSON", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request("/notion/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 502 when createPage throws", async () => {
    const service = makeService({
      createPage: vi.fn().mockRejectedValue(new Error("upstream error")),
    } as Partial<NotionService>);
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request("/notion/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parent: "tasks",
        properties: { Name: { title: [{ text: { content: "x" } }] } },
      }),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("notion_create_failed");
  });

  // ────────────────────────────────────────────────────────────
  // GET /notion/pages/:id — additional paths
  // ────────────────────────────────────────────────────────────
  it("includes transcript when include_transcript=true", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    await app.request(`/notion/pages/${samplePage.id}?include_transcript=true`);
    expect(service.getPage).toHaveBeenCalledWith(
      samplePage.id,
      { includeMarkdown: true, includeTranscript: true },
    );
  });

  it("returns 502 when getPage throws a non-not-found error", async () => {
    const service = makeService({
      getPage: vi.fn().mockRejectedValue(new Error("rate limited")),
    } as Partial<NotionService>);
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request(`/notion/pages/${samplePage.id}`);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("notion_get_failed");
  });

  // ────────────────────────────────────────────────────────────
  // PATCH /notion/pages/:id — additional paths
  // ────────────────────────────────────────────────────────────
  it("returns 503 when PATCH (properties) is called with null notion service", async () => {
    const app = createNotionRoutes({ notionService: null });
    const res = await app.request(`/notion/pages/${samplePage.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ properties: {} }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("notion_not_configured");
  });

  it("returns 400 when PATCH body is invalid JSON", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request(`/notion/pages/${samplePage.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when PATCH targets an invalid page ID", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request("/notion/pages/not-a-valid-id", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ properties: { Done: { checkbox: true } } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_page_id");
  });

  it("returns 502 when updatePageProperties throws non-not-found error", async () => {
    const service = makeService({
      updatePageProperties: vi.fn().mockRejectedValue(new Error("rate limited")),
    } as Partial<NotionService>);
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request(`/notion/pages/${samplePage.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ properties: { Done: { checkbox: true } } }),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("notion_update_failed");
  });

  // ────────────────────────────────────────────────────────────
  // PATCH /notion/pages/:id/content — validation paths
  // ────────────────────────────────────────────────────────────
  it("returns 503 when content PATCH is called with null notion service", async () => {
    const app = createNotionRoutes({ notionService: null });
    const res = await app.request(`/notion/pages/${samplePage.id}/content`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "append", content: "x" }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("notion_not_configured");
  });

  it("returns 400 when content PATCH body is invalid JSON", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request(`/notion/pages/${samplePage.id}/content`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when content PATCH targets an invalid page ID", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request("/notion/pages/bad-id/content", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "append", content: "x" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_page_id");
  });

  it("returns 400 for append mode without content", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request(`/notion/pages/${samplePage.id}/content`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "append" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("content_required_for_append");
  });

  it("returns 400 for replace_all mode without content", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request(`/notion/pages/${samplePage.id}/content`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "replace_all" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("content_required_for_replace_all");
  });

  it("reports the actual typeof when append-mode content is a non-string (number)", async () => {
    // Exercises the false branch of `body.content === undefined ? "<missing>" : typeof body.content`.
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request(`/notion/pages/${samplePage.id}/content`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "append", content: 42 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: Array<{ received: string }> };
    expect(body.errors[0].received).toBe("number");
  });

  it("reports the actual typeof when replace_all content is a non-string (boolean)", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request(`/notion/pages/${samplePage.id}/content`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "replace_all", content: true }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: Array<{ received: string }> };
    expect(body.errors[0].received).toBe("boolean");
  });

  it("reports typeof for both content and contentRange when replace_range receives non-strings", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request(`/notion/pages/${samplePage.id}/content`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "replace_range", content: 1, contentRange: 2 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: Array<{ received: { content: string; contentRange: string } }> };
    expect(body.errors[0].received.content).toBe("number");
    expect(body.errors[0].received.contentRange).toBe("number");
  });

  it("returns 400 for replace_range mode missing content", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request(`/notion/pages/${samplePage.id}/content`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "replace_range", contentRange: "some range" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("content_and_contentRange_required_for_replace_range");
  });

  it("returns 400 for replace_range mode missing contentRange", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request(`/notion/pages/${samplePage.id}/content`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "replace_range", content: "new content" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("content_and_contentRange_required_for_replace_range");
  });

  it("accepts replace_range mode with both content and contentRange", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request(`/notion/pages/${samplePage.id}/content`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "replace_range", content: "new", contentRange: "old", allowDeleting: true }),
    });
    expect(res.status).toBe(200);
    expect(service.updatePageContent).toHaveBeenCalledWith(samplePage.id, {
      kind: "replace_range",
      content: "new",
      contentRange: "old",
      allowDeleting: true,
    });
  });

  it("returns 400 for update mode with empty updates array", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request(`/notion/pages/${samplePage.id}/content`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "update", updates: [] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("updates_required_for_update");
  });

  it("returns 400 for update mode when updates is not an array", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request(`/notion/pages/${samplePage.id}/content`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "update", updates: "not-array" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("updates_required_for_update");
  });

  it("reports received='<missing>' when mode='update' omits the updates field", async () => {
    // Covers the `body.updates === undefined ? "<missing>" : ...` branch.
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request(`/notion/pages/${samplePage.id}/content`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "update" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      errors: Array<{ received: string }>;
    };
    expect(body.errors[0]!.received).toBe("<missing>");
  });

  it("reports received='<missing>' when the body omits the mode field", async () => {
    // Covers the false branch of `body.mode ?? "<missing>"` (mode is
    // undefined → falls into the switch default and reports missing).
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request(`/notion/pages/${samplePage.id}/content`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      errors: Array<{ received: string }>;
    };
    expect(body.errors[0]!.received).toBe("<missing>");
  });

  it("returns 502 when updatePageContent throws a non-not-found error", async () => {
    const service = makeService({
      updatePageContent: vi.fn().mockRejectedValue(new Error("conflict")),
    } as Partial<NotionService>);
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request(`/notion/pages/${samplePage.id}/content`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "append", content: "x" }),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("notion_content_update_failed");
  });

  // ────────────────────────────────────────────────────────────
  // DELETE /notion/pages/:id — invalid ID
  // ────────────────────────────────────────────────────────────
  it("returns 503 when DELETE is called with unavailable notion service", async () => {
    const app = createNotionRoutes({ notionService: null });
    const res = await app.request(`/notion/pages/${samplePage.id}`, { method: "DELETE" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("notion_not_configured");
  });

  it("returns 400 when DELETE targets an invalid page ID", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request("/notion/pages/bad-id", { method: "DELETE" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_page_id");
  });

  // ────────────────────────────────────────────────────────────
  // GET /notion/query — service error
  // ────────────────────────────────────────────────────────────
  it("returns 502 when queryDatabase throws", async () => {
    const service = makeService({
      queryDatabase: vi.fn().mockRejectedValue(new Error("Notion API error")),
    } as Partial<NotionService>);
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request("/notion/query?database=tasks");
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("notion_query_failed");
  });

  // ────────────────────────────────────────────────────────────
  // GET /notion/search — additional paths
  // ────────────────────────────────────────────────────────────
  it("returns 502 when search throws", async () => {
    const service = makeService({
      search: vi.fn().mockRejectedValue(new Error("rate limited")),
    } as Partial<NotionService>);
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request("/notion/search?q=test");
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("notion_search_failed");
  });

  it("forwards start_cursor to search service", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    await app.request("/notion/search?q=test&start_cursor=cursor-abc");
    expect(service.search).toHaveBeenCalledWith(
      expect.objectContaining({ startCursor: "cursor-abc" }),
    );
  });

  it("defaults search sort to descending when not ascending", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    await app.request("/notion/search?q=test&sort=latest");
    expect(service.search).toHaveBeenCalledWith(
      expect.objectContaining({ sortDirection: "descending" }),
    );
  });

  it("passes data_source type filter to search", async () => {
    const service = makeService();
    const app = createNotionRoutes({ notionService: service });
    const res = await app.request("/notion/search?type=data_source");
    expect(res.status).toBe(200);
    expect(service.search).toHaveBeenCalledWith(
      expect.objectContaining({ filterType: "data_source" }),
    );
  });
});
