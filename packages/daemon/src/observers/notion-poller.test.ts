import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { NotionPoller, extractPropertySummary } from "./notion-poller.js";
import { applySchema } from "../db/schema.js";
import { readRuntimeState } from "../db/runtime-state.js";
import { AgentWriteTracker } from "../safety/agent-write-tracker.js";
import type { NotionService } from "../services/notion.js";
import type { PageObjectResponse } from "@notionhq/client";

/** Build a minimal PageObjectResponse fixture. */
function fakePage(
  opts: Partial<{
    id: string;
    last_edited_time: string;
    title: string;
    status: string;
    url: string;
    in_trash: boolean;
  }> = {},
): PageObjectResponse {
  return {
    object: "page",
    id: opts.id ?? "page-1",
    created_time: "2026-04-10T11:00:00.000Z",
    last_edited_time: opts.last_edited_time ?? "2026-04-10T12:00:00.000Z",
    created_by: { object: "user", id: "user-1" },
    last_edited_by: { object: "user", id: "user-1" },
    cover: null,
    icon: null,
    parent: { type: "data_source_id", data_source_id: "db-123" },
    archived: opts.in_trash ?? false,
    in_trash: opts.in_trash ?? false,
    is_locked: false,
    properties: {
      Name: {
        id: "title",
        type: "title",
        title: [
          {
            type: "text",
            text: { content: opts.title ?? "Test Task", link: null },
            annotations: {
              bold: false,
              italic: false,
              strikethrough: false,
              underline: false,
              code: false,
              color: "default",
            },
            plain_text: opts.title ?? "Test Task",
            href: null,
          },
        ],
      },
      ...(opts.status
        ? {
            Status: {
              id: "status",
              type: "status",
              status: {
                id: "in-progress",
                name: opts.status,
                color: "blue",
                description: null,
              },
            },
          }
        : {}),
    },
    url: opts.url ?? "https://notion.so/page-1",
    public_url: null,
  } as unknown as PageObjectResponse;
}

/** Build a mock NotionService that yields a fixed set of pages per call. */
function buildMockService(plan: {
  active?: PageObjectResponse[];
  trashed?: PageObjectResponse[];
  failOn?: "active" | "trashed" | "both";
}): NotionService {
  async function* activeGen(): AsyncIterable<PageObjectResponse> {
    if (plan.failOn === "active" || plan.failOn === "both") {
      throw new Error("API rate limit");
    }
    for (const p of plan.active ?? []) yield p;
  }
  async function* trashedGen(): AsyncIterable<PageObjectResponse> {
    if (plan.failOn === "trashed" || plan.failOn === "both") {
      throw new Error("API rate limit");
    }
    for (const p of plan.trashed ?? []) yield p;
  }
  return {
    available: true,
    queryUpdatedSince: vi.fn((_db: string, _since: string, opts?: { inTrash?: boolean }) =>
      opts?.inTrash ? trashedGen() : activeGen(),
    ),
  } as unknown as NotionService;
}

/** Invoke the private pollDatabase for direct-invocation tests. */
function invokePollDatabase(
  poller: NotionPoller,
  label: string,
  databaseId: string,
): Promise<void> {
  // Tests don't exercise the abort path — a fresh never-fired controller
  // gives pollDatabase the signal it needs while keeping the test focus
  // on the cursor / observation logic.
  const signal = new AbortController().signal;
  return (
    poller as unknown as {
      pollDatabase: (
        label: string,
        databaseId: string,
        signal: AbortSignal,
      ) => Promise<void>;
    }
  ).pollDatabase(label, databaseId, signal);
}

describe("NotionPoller", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  it("implements the Observer interface", () => {
    const poller = new NotionPoller({
      notionService: buildMockService({}),
      databaseIds: { tasks: "db-123" },
      pollIntervalSeconds: 60,
      db,
    });
    expect(poller.name).toBe("notion-poller");
    expect(typeof poller.start).toBe("function");
    expect(typeof poller.stop).toBe("function");
  });

  it("seeds a runtime_state cursor for unseen databases on first start", async () => {
    const poller = new NotionPoller({
      notionService: buildMockService({}),
      databaseIds: { tasks: "db-seed" },
      pollIntervalSeconds: 9999,
      db,
    });
    await poller.start();
    await poller.stop();

    const cursor = readRuntimeState<{ lastEditedTime: string; trashedIds: string[] }>(
      db,
      "notion-poller:cursor:db-seed",
    );
    expect(cursor).not.toBeNull();
    expect(cursor?.trashedIds).toEqual([]);
    expect(cursor?.lastEditedTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("preserves an existing cursor across restarts (no history replay)", async () => {
    // Pre-seed a cursor as if we had polled a week ago.
    db.prepare(
      "INSERT INTO runtime_state (key, value_json) VALUES (?, ?)",
    ).run(
      "notion-poller:cursor:db-persisted",
      JSON.stringify({ lastEditedTime: "2026-04-01T00:00:00.000Z", trashedIds: [] }),
    );

    const poller = new NotionPoller({
      notionService: buildMockService({}),
      databaseIds: { projects: "db-persisted" },
      pollIntervalSeconds: 9999,
      db,
    });
    await poller.start();
    await poller.stop();

    const cursor = readRuntimeState<{ lastEditedTime: string }>(
      db,
      "notion-poller:cursor:db-persisted",
    );
    expect(cursor?.lastEditedTime).toBe("2026-04-01T00:00:00.000Z");
  });

  it("records a 'modified' observation for each updated page", async () => {
    const service = buildMockService({
      active: [
        fakePage({
          id: "page-1",
          title: "Review roadmap",
          status: "In Progress",
          url: "https://notion.so/page-1",
        }),
      ],
    });

    const poller = new NotionPoller({
      notionService: service,
      databaseIds: { tasks: "db-123" },
      pollIntervalSeconds: 9999,
      db,
    });
    await poller.start();
    await invokePollDatabase(poller,"tasks", "db-123");
    await poller.stop();

    const rows = db
      .prepare("SELECT source, ref, change_type, actor, payload FROM observations")
      .all() as { source: string; ref: string; change_type: string; actor: string; payload: string }[];

    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("notion:db-123");
    expect(rows[0].ref).toBe("page-1");
    expect(rows[0].change_type).toBe("modified");
    expect(rows[0].actor).toBe("user");

    const payload = JSON.parse(rows[0].payload);
    expect(payload.pageTitle).toBe("Review roadmap");
    expect(payload.databaseLabel).toBe("tasks");
    expect(payload.url).toBe("https://notion.so/page-1");
    expect(payload.propertySummary).toContain("Status: In Progress");
    expect(payload.inTrash).toBe(false);
  });

  it("advances the cursor to the newest last_edited_time across pages", async () => {
    // Pre-seed the cursor to an earlier time so the mock pages all
    // qualify as "newer" than the stored `lastEditedTime`. Without
    // this, `start()` would seed the cursor to NOW and every fixture
    // page would look stale.
    db.prepare(
      "INSERT INTO runtime_state (key, value_json) VALUES (?, ?)",
    ).run(
      "notion-poller:cursor:db-cursor",
      JSON.stringify({
        lastEditedTime: "2026-04-01T00:00:00.000Z",
        trashedIds: [],
      }),
    );

    const service = buildMockService({
      active: [
        fakePage({ id: "p-old", last_edited_time: "2026-04-10T12:00:00.000Z" }),
        fakePage({ id: "p-new", last_edited_time: "2026-04-10T14:00:00.000Z" }),
        fakePage({ id: "p-mid", last_edited_time: "2026-04-10T13:00:00.000Z" }),
      ],
    });

    const poller = new NotionPoller({
      notionService: service,
      databaseIds: { tasks: "db-cursor" },
      pollIntervalSeconds: 9999,
      db,
    });
    await poller.start();
    await invokePollDatabase(poller,"tasks", "db-cursor");
    await poller.stop();

    const cursor = readRuntimeState<{ lastEditedTime: string }>(
      db,
      "notion-poller:cursor:db-cursor",
    );
    expect(cursor?.lastEditedTime).toBe("2026-04-10T14:00:00.000Z");
  });

  it("records 'deleted' when a page enters the trash and remembers it", async () => {
    const trashedPage = fakePage({ id: "page-trashed", in_trash: true, title: "Obsolete" });

    const service = buildMockService({
      active: [],
      trashed: [trashedPage],
    });

    const poller = new NotionPoller({
      notionService: service,
      databaseIds: { tasks: "db-trash" },
      pollIntervalSeconds: 9999,
      db,
    });
    await poller.start();
    await invokePollDatabase(poller,"tasks", "db-trash");
    await poller.stop();

    const rows = db
      .prepare("SELECT change_type, payload FROM observations")
      .all() as { change_type: string; payload: string }[];

    expect(rows).toHaveLength(1);
    expect(rows[0].change_type).toBe("deleted");
    expect(JSON.parse(rows[0].payload).inTrash).toBe(true);

    const cursor = readRuntimeState<{ trashedIds: string[] }>(
      db,
      "notion-poller:cursor:db-trash",
    );
    expect(cursor?.trashedIds).toEqual(["page-trashed"]);
  });

  it("drops a page from trashedIds when pass 1 shows it restored", async () => {
    db.prepare(
      "INSERT INTO runtime_state (key, value_json) VALUES (?, ?)",
    ).run(
      "notion-poller:cursor:db-restore",
      JSON.stringify({
        lastEditedTime: "2026-04-01T00:00:00.000Z",
        trashedIds: ["page-restored"],
      }),
    );

    const restoredPage = fakePage({
      id: "page-restored",
      in_trash: false,
      title: "Back from trash",
    });
    const service = buildMockService({
      active: [restoredPage],
      trashed: [],
    });

    const poller = new NotionPoller({
      notionService: service,
      databaseIds: { tasks: "db-restore" },
      pollIntervalSeconds: 9999,
      db,
    });
    await poller.start();
    await invokePollDatabase(poller,"tasks", "db-restore");
    await poller.stop();

    // The restore itself is reported as `modified`, not as a new event.
    const rows = db
      .prepare("SELECT change_type FROM observations")
      .all() as { change_type: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].change_type).toBe("modified");

    const cursor = readRuntimeState<{ trashedIds: string[] }>(
      db,
      "notion-poller:cursor:db-restore",
    );
    expect(cursor?.trashedIds).toEqual([]);
  });

  it("does not re-emit 'deleted' for pages already known to be trashed", async () => {
    // Seed cursor with a page we already reported as deleted
    db.prepare(
      "INSERT INTO runtime_state (key, value_json) VALUES (?, ?)",
    ).run(
      "notion-poller:cursor:db-trash",
      JSON.stringify({
        lastEditedTime: "2026-04-01T00:00:00.000Z",
        trashedIds: ["page-trashed"],
      }),
    );

    const service = buildMockService({
      trashed: [fakePage({ id: "page-trashed", in_trash: true })],
    });

    const poller = new NotionPoller({
      notionService: service,
      databaseIds: { tasks: "db-trash" },
      pollIntervalSeconds: 9999,
      db,
    });
    await poller.start();
    await invokePollDatabase(poller,"tasks", "db-trash");
    await poller.stop();

    const count = db
      .prepare("SELECT COUNT(*) AS cnt FROM observations")
      .get() as { cnt: number };
    expect(count.cnt).toBe(0);
  });

  it("attributes observations to actor='agent' when writeTracker has the mark", async () => {
    const tracker = new AgentWriteTracker();
    tracker.markWriting("notion:page-1");

    const service = buildMockService({
      active: [fakePage({ id: "page-1", title: "Agent wrote this" })],
    });
    const poller = new NotionPoller({
      notionService: service,
      databaseIds: { tasks: "db-123" },
      pollIntervalSeconds: 9999,
      db,
      writeTracker: tracker,
    });
    await poller.start();
    await invokePollDatabase(poller,"tasks", "db-123");
    await poller.stop();

    const row = db
      .prepare("SELECT actor FROM observations WHERE ref = 'page-1'")
      .get() as { actor: string };
    expect(row.actor).toBe("agent");
  });

  it("handles errors from pollDatabase gracefully without crashing", async () => {
    const service = buildMockService({ failOn: "active" });
    const poller = new NotionPoller({
      notionService: service,
      databaseIds: { tasks: "db-123" },
      pollIntervalSeconds: 9999,
      db,
    });
    await poller.start();
    // tick() routes through PollGuard which constructs the signal; pollAll
    // swallows per-database errors and surfaces only at the tick-level catch.
    await (poller as unknown as { tick: () => Promise<void> }).tick();
    await poller.stop();

    const count = db
      .prepare("SELECT COUNT(*) AS cnt FROM observations")
      .get() as { cnt: number };
    expect(count.cnt).toBe(0);
  });

  it("caps trashedIds at 1000 with FIFO eviction when the cursor is overfull", async () => {
    const oldIds = Array.from({ length: 1001 }, (_, i) => `old-${i}`);
    db.prepare("INSERT INTO runtime_state (key, value_json) VALUES (?, ?)").run(
      "notion-poller:cursor:db-cap",
      JSON.stringify({
        lastEditedTime: "2026-04-01T00:00:00.000Z",
        trashedIds: oldIds,
      }),
    );

    // Add one new trashed page this cycle. The overall set swells to 1002
    // before the cap kicks in. The cap should drop the oldest entry
    // (`old-0`) and retain the newest (`new-trash` at the tail).
    const service = buildMockService({
      active: [],
      trashed: [fakePage({ id: "new-trash", in_trash: true, title: "New trashed" })],
    });

    const poller = new NotionPoller({
      notionService: service,
      databaseIds: { tasks: "db-cap" },
      pollIntervalSeconds: 9999,
      db,
    });
    await poller.start();
    await invokePollDatabase(poller, "tasks", "db-cap");
    await poller.stop();

    const cursor = readRuntimeState<{ trashedIds: string[] }>(
      db,
      "notion-poller:cursor:db-cap",
    );
    expect(cursor?.trashedIds).toHaveLength(1000);
    expect(cursor?.trashedIds).not.toContain("old-0");
    expect(cursor?.trashedIds).toContain("old-1000");
    expect(cursor?.trashedIds[cursor.trashedIds.length - 1]).toBe("new-trash");
  });

  it("is a no-op when NotionService.available === false", async () => {
    const service = { available: false, queryUpdatedSince: vi.fn() } as unknown as NotionService;
    const poller = new NotionPoller({
      notionService: service,
      databaseIds: { tasks: "db-123" },
      pollIntervalSeconds: 9999,
      db,
    });
    await poller.start();
    await invokePollDatabase(poller,"tasks", "db-123");
    expect(service.queryUpdatedSince).not.toHaveBeenCalled();
    await poller.stop();
  });
});

describe("extractPropertySummary", () => {
  it("formats status, select, and date properties", () => {
    const page = {
      properties: {
        Status: { type: "status", status: { name: "Done" } },
        Priority: { type: "select", select: { name: "High" } },
        Due: { type: "date", date: { start: "2026-05-01" } },
      },
    };
    expect(extractPropertySummary(page as unknown as Parameters<typeof extractPropertySummary>[0])).toBe(
      "Status: Done, Priority: High, Due: 2026-05-01",
    );
  });

  it("returns empty string when no properties match", () => {
    expect(
      extractPropertySummary({
        properties: { Name: { type: "title", title: [] } },
      } as unknown as Parameters<typeof extractPropertySummary>[0]),
    ).toBe("");
  });
});
