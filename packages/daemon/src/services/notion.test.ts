import { describe, it, expect, vi, beforeEach } from "vitest";
import { NotionService } from "./notion.js";
import type { SecretBroker } from "../secrets/secret-broker.js";

/**
 * Unit tests for NotionService — exercises the `@notionhq/client`
 * integration directly by mocking the client module, so we cover the
 * pagination loop, `start_cursor` threading, and `isFullPage` narrowing
 * that the mock-only poller tests cannot reach.
 */

const mockQuery = vi.fn();
const mockSearch = vi.fn();
const mockPagesRetrieve = vi.fn();
const mockPagesCreate = vi.fn();
const mockPagesUpdate = vi.fn();
const mockPagesUpdateMarkdown = vi.fn();
const mockPagesRetrieveMarkdown = vi.fn();

vi.mock("@notionhq/client", () => ({
  Client: vi.fn().mockImplementation(() => ({
    dataSources: { query: mockQuery },
    search: mockSearch,
    pages: {
      retrieve: mockPagesRetrieve,
      retrieveMarkdown: mockPagesRetrieveMarkdown,
      create: mockPagesCreate,
      update: mockPagesUpdate,
      updateMarkdown: mockPagesUpdateMarkdown,
    },
  })),
}));

function makeBroker(): SecretBroker {
  return {
    getNotionApiKey: vi.fn().mockResolvedValue("fake-key"),
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    has: vi.fn(),
    invalidate: vi.fn(),
    clearCache: vi.fn(),
  } as unknown as SecretBroker;
}

interface FakePageOpts {
  id?: string;
  lastEditedTime?: string;
  inTrash?: boolean;
}

function fakePage(opts: FakePageOpts = {}): Record<string, unknown> {
  return {
    object: "page",
    id: opts.id ?? "page-1",
    created_time: "2026-04-10T10:00:00.000Z",
    last_edited_time: opts.lastEditedTime ?? "2026-04-10T12:00:00.000Z",
    created_by: { object: "user", id: "u1" },
    last_edited_by: { object: "user", id: "u1" },
    cover: null,
    icon: null,
    parent: { type: "data_source_id", data_source_id: "db-123" },
    archived: opts.inTrash ?? false,
    in_trash: opts.inTrash ?? false,
    is_locked: false,
    properties: {
      Name: {
        id: "title",
        type: "title",
        title: [{ type: "text", plain_text: "T", text: { content: "T", link: null }, annotations: {}, href: null }],
      },
    },
    url: "https://notion.so/page-1",
    public_url: null,
  };
}

function fakeDataSource(): Record<string, unknown> {
  // A data source response has `last_edited_time` AND a `properties` field
  // (describing the schema), so the old duck-typed isFullPage would have
  // false-positived on it. The new check keys on `object === "page"`.
  return {
    object: "data_source",
    id: "ds-1",
    title: [{ type: "text", plain_text: "Tasks DB" }],
    created_time: "2026-04-10T10:00:00.000Z",
    last_edited_time: "2026-04-10T12:00:00.000Z",
    properties: { Name: { type: "title" } },
    parent: { type: "database_id", database_id: "db-123" },
  };
}

describe("NotionService", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockSearch.mockReset();
    mockPagesRetrieve.mockReset();
    mockPagesCreate.mockReset();
    mockPagesUpdate.mockReset();
    mockPagesUpdateMarkdown.mockReset();
    mockPagesRetrieveMarkdown.mockReset();
  });

  async function makeService(): Promise<NotionService> {
    const service = new NotionService(
      { notionDatabaseIds: { tasks: "db-123" } },
      makeBroker(),
    );
    await service.init();
    return service;
  }

  describe("queryUpdatedSince pagination", () => {
    it("walks has_more / next_cursor until exhausted", async () => {
      mockQuery
        .mockResolvedValueOnce({
          results: [fakePage({ id: "p1", lastEditedTime: "2026-04-10T10:00:00.000Z" })],
          has_more: true,
          next_cursor: "cursor-2",
        })
        .mockResolvedValueOnce({
          results: [fakePage({ id: "p2", lastEditedTime: "2026-04-10T11:00:00.000Z" })],
          has_more: true,
          next_cursor: "cursor-3",
        })
        .mockResolvedValueOnce({
          results: [fakePage({ id: "p3", lastEditedTime: "2026-04-10T12:00:00.000Z" })],
          has_more: false,
          next_cursor: null,
        });

      const service = await makeService();
      const ids: string[] = [];
      for await (const page of service.queryUpdatedSince(
        "db-123",
        "2026-04-01T00:00:00.000Z",
      )) {
        ids.push(page.id);
      }

      expect(ids).toEqual(["p1", "p2", "p3"]);
      expect(mockQuery).toHaveBeenCalledTimes(3);
      expect(mockQuery.mock.calls[0][0].start_cursor).toBeUndefined();
      expect(mockQuery.mock.calls[1][0].start_cursor).toBe("cursor-2");
      expect(mockQuery.mock.calls[2][0].start_cursor).toBe("cursor-3");
    });

    it("stops when has_more is false on the first page", async () => {
      mockQuery.mockResolvedValueOnce({
        results: [fakePage({ id: "only" })],
        has_more: false,
        next_cursor: null,
      });

      const service = await makeService();
      const ids: string[] = [];
      for await (const page of service.queryUpdatedSince(
        "db-123",
        "2026-04-01T00:00:00.000Z",
      )) {
        ids.push(page.id);
      }
      expect(ids).toEqual(["only"]);
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it("forwards in_trash: true on every page of a paginated query", async () => {
      mockQuery
        .mockResolvedValueOnce({
          results: [fakePage({ id: "t1", inTrash: true })],
          has_more: true,
          next_cursor: "c2",
        })
        .mockResolvedValueOnce({
          results: [fakePage({ id: "t2", inTrash: true })],
          has_more: false,
          next_cursor: null,
        });

      const service = await makeService();
      const ids: string[] = [];
      for await (const page of service.queryUpdatedSince(
        "db-123",
        "2026-04-01T00:00:00.000Z",
        { inTrash: true },
      )) {
        ids.push(page.id);
      }
      expect(ids).toEqual(["t1", "t2"]);
      expect(mockQuery.mock.calls[0][0].in_trash).toBe(true);
      expect(mockQuery.mock.calls[1][0].in_trash).toBe(true);
    });
  });

  describe("isFullPage narrowing", () => {
    it("filters out data_source results from queryDatabase", async () => {
      mockQuery.mockResolvedValueOnce({
        results: [fakePage({ id: "p1" }), fakeDataSource(), fakePage({ id: "p2" })],
        has_more: false,
        next_cursor: null,
      });

      const service = await makeService();
      const result = await service.queryDatabase({ databaseId: "db-123" });
      expect(result.results).toHaveLength(2);
      expect(result.results.map((p) => p.id)).toEqual(["p1", "p2"]);
    });

    it("filters out data_source results from queryUpdatedSince", async () => {
      mockQuery.mockResolvedValueOnce({
        results: [fakePage({ id: "p1" }), fakeDataSource()],
        has_more: false,
        next_cursor: null,
      });

      const service = await makeService();
      const ids: string[] = [];
      for await (const page of service.queryUpdatedSince(
        "db-123",
        "2026-04-01T00:00:00.000Z",
      )) {
        ids.push(page.id);
      }
      expect(ids).toEqual(["p1"]);
    });
  });

  describe("queryDatabase", () => {
    it("forwards startCursor to the client", async () => {
      mockQuery.mockResolvedValueOnce({
        results: [],
        has_more: false,
        next_cursor: null,
      });
      const service = await makeService();
      await service.queryDatabase({
        databaseId: "db-123",
        startCursor: "my-cursor-xyz",
        pageSize: 50,
      });
      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          start_cursor: "my-cursor-xyz",
          page_size: 50,
        }),
      );
    });

    it("clamps page_size to 100", async () => {
      mockQuery.mockResolvedValueOnce({ results: [], has_more: false, next_cursor: null });
      const service = await makeService();
      await service.queryDatabase({ databaseId: "db-123", pageSize: 500 });
      expect(mockQuery.mock.calls[0][0].page_size).toBe(100);
    });
  });

  describe("resolveDatabaseId", () => {
    it("returns configured label", async () => {
      const service = await makeService();
      expect(service.resolveDatabaseId("tasks")).toBe("db-123");
    });

    it("passes through a raw UUID", async () => {
      const service = await makeService();
      expect(
        service.resolveDatabaseId("11111111-2222-3333-4444-555555555555"),
      ).toBe("11111111-2222-3333-4444-555555555555");
    });

    it("returns null for unknown label / malformed ID", async () => {
      const service = await makeService();
      expect(service.resolveDatabaseId("nope")).toBeNull();
      expect(service.resolveDatabaseId("not-a-uuid-at-all")).toBeNull();
    });
  });

  describe("search", () => {
    it("sends filter.object when filterType provided", async () => {
      mockSearch.mockResolvedValueOnce({
        results: [],
        has_more: false,
        next_cursor: null,
      });
      const service = await makeService();
      await service.search({ query: "roadmap", filterType: "page" });
      expect(mockSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          query: "roadmap",
          filter: { property: "object", value: "page" },
        }),
      );
    });

    it("omits filter when filterType is undefined", async () => {
      mockSearch.mockResolvedValueOnce({
        results: [],
        has_more: false,
        next_cursor: null,
      });
      const service = await makeService();
      await service.search({ query: "anything" });
      expect(mockSearch.mock.calls[0][0].filter).toBeUndefined();
    });
  });

  describe("archivePage", () => {
    it("calls pages.update with in_trash: true", async () => {
      mockPagesUpdate.mockResolvedValueOnce(fakePage({ id: "p1", inTrash: true }));
      const service = await makeService();
      const page = await service.archivePage("p1");
      expect(mockPagesUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ page_id: "p1", in_trash: true }),
      );
      expect(page.inTrash).toBe(true);
    });
  });

  describe("updatePageContent", () => {
    it("translates append mode into insert_content", async () => {
      mockPagesUpdateMarkdown.mockResolvedValueOnce({});
      const service = await makeService();
      await service.updatePageContent("p1", {
        kind: "append",
        content: "- new",
      });
      expect(mockPagesUpdateMarkdown).toHaveBeenCalledWith(
        expect.objectContaining({
          page_id: "p1",
          type: "insert_content",
          insert_content: { content: "- new", after: undefined },
        }),
      );
    });

    it("translates update mode with find-and-replace tuples", async () => {
      mockPagesUpdateMarkdown.mockResolvedValueOnce({});
      const service = await makeService();
      await service.updatePageContent("p1", {
        kind: "update",
        updates: [{ oldStr: "foo", newStr: "bar", replaceAll: true }],
      });
      expect(mockPagesUpdateMarkdown).toHaveBeenCalledWith(
        expect.objectContaining({
          page_id: "p1",
          type: "update_content",
          update_content: expect.objectContaining({
            content_updates: [
              { old_str: "foo", new_str: "bar", replace_all_matches: true },
            ],
          }),
        }),
      );
    });
  });
});
