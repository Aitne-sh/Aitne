import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.js";

// ── Module mocks (hoisted by vitest) ──

vi.mock("chokidar", () => ({
  watch: () => ({
    on: vi.fn().mockReturnThis(),
    close: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

const mockedReadFile = vi.mocked(readFile);

// ── Obsidian Watcher: diffContent enrichment ──

describe("ObsidianWatcher enrichment", () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.useFakeTimers();
    db = new Database(":memory:");
    applySchema(db);
    mockedReadFile.mockReset();
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reads file content into diffContent for modified events", async () => {
    mockedReadFile.mockResolvedValue("# My Note\nSome content here");

    const { ObsidianWatcher } = await import("./obsidian-watcher.js");
    const watcher = new ObsidianWatcher("/vault", db, 0);

    // Access private handleChange
    (watcher as unknown as { handleChange: (p: string, t: string) => void })
      .handleChange("/vault/notes/test.md", "modified");

    // Advance past debounce timer (debounceSeconds = 0)
    vi.advanceTimersByTime(100);
    await vi.waitFor(() => {
      const row = db.prepare("SELECT COUNT(*) as count FROM observations").get() as { count: number };
      expect(row.count).toBe(1);
    });

    const observation = db.prepare(
      "SELECT source, ref, change_type, payload FROM observations ORDER BY id DESC LIMIT 1",
    ).get() as { source: string; ref: string; change_type: string; payload: string | null };
    const payload = JSON.parse(observation.payload ?? "{}") as {
      filePath?: string;
      diffPreview?: string;
    };
    expect(observation.source).toBe("obsidian:external");
    expect(observation.ref).toBe("notes/test.md");
    expect(observation.change_type).toBe("modified");
    expect(payload.diffPreview).toBe("# My Note\nSome content here");
    expect(payload.filePath).toBe("notes/test.md");
  });

  it("truncates content exceeding 2000 chars", async () => {
    const longContent = "x".repeat(3000);
    mockedReadFile.mockResolvedValue(longContent);

    const { ObsidianWatcher } = await import("./obsidian-watcher.js");
    const watcher = new ObsidianWatcher("/vault", db, 0);

    (watcher as unknown as { handleChange: (p: string, t: string) => void })
      .handleChange("/vault/long.md", "modified");

    vi.advanceTimersByTime(100);
    await vi.waitFor(() => {
      const row = db.prepare("SELECT COUNT(*) as count FROM observations").get() as { count: number };
      expect(row.count).toBe(1);
    });

    const observation = db.prepare(
      "SELECT payload FROM observations ORDER BY id DESC LIMIT 1",
    ).get() as { payload: string | null };
    const payload = JSON.parse(observation.payload ?? "{}") as { diffPreview?: string };
    expect(payload.diffPreview).toContain("--- (truncated, 3000 chars total) ---");
    expect(payload.diffPreview?.length ?? 0).toBeLessThan(3000);
  });

  it("sets empty diffContent for deleted events (no file read)", async () => {
    const { ObsidianWatcher } = await import("./obsidian-watcher.js");
    const watcher = new ObsidianWatcher("/vault", db, 0);

    (watcher as unknown as { handleChange: (p: string, t: string) => void })
      .handleChange("/vault/deleted.md", "deleted");

    vi.advanceTimersByTime(100);
    await vi.waitFor(() => {
      const row = db.prepare("SELECT COUNT(*) as count FROM observations").get() as { count: number };
      expect(row.count).toBe(1);
    });

    const observation = db.prepare(
      "SELECT payload FROM observations ORDER BY id DESC LIMIT 1",
    ).get() as { payload: string | null };
    const payload = JSON.parse(observation.payload ?? "{}") as { diffPreview?: string };
    expect(payload.diffPreview).toBe("");
    expect(mockedReadFile).not.toHaveBeenCalled();
  });

  it("sets fallback diffContent when file read fails", async () => {
    mockedReadFile.mockRejectedValue(new Error("ENOENT"));

    const { ObsidianWatcher } = await import("./obsidian-watcher.js");
    const watcher = new ObsidianWatcher("/vault", db, 0);

    (watcher as unknown as { handleChange: (p: string, t: string) => void })
      .handleChange("/vault/gone.md", "created");

    vi.advanceTimersByTime(100);
    await vi.waitFor(() => {
      const row = db.prepare("SELECT COUNT(*) as count FROM observations").get() as { count: number };
      expect(row.count).toBe(1);
    });

    const observation = db.prepare(
      "SELECT payload FROM observations ORDER BY id DESC LIMIT 1",
    ).get() as { payload: string | null };
    const payload = JSON.parse(observation.payload ?? "{}") as { diffPreview?: string };
    expect(payload.diffPreview).toBe("(file read failed)");
  });
});

// ── Notion Poller: extractPropertySummary ──

describe("extractPropertySummary", () => {
  let extractPropertySummary: (page: Record<string, unknown>) => string;

  beforeEach(async () => {
    const mod = await import("./notion-poller.js");
    extractPropertySummary = mod.extractPropertySummary;
  });

  it("extracts status properties", () => {
    const page = {
      properties: {
        Status: { type: "status", status: { name: "In Progress" } },
      },
    };
    expect(extractPropertySummary(page)).toBe("Status: In Progress");
  });

  it("extracts select properties", () => {
    const page = {
      properties: {
        Priority: { type: "select", select: { name: "High" } },
      },
    };
    expect(extractPropertySummary(page)).toBe("Priority: High");
  });

  it("extracts date properties", () => {
    const page = {
      properties: {
        Due: { type: "date", date: { start: "2026-04-10" } },
      },
    };
    expect(extractPropertySummary(page)).toBe("Due: 2026-04-10");
  });

  it("combines multiple property types", () => {
    const page = {
      properties: {
        Status: { type: "status", status: { name: "Done" } },
        Priority: { type: "select", select: { name: "Low" } },
        Due: { type: "date", date: { start: "2026-04-15" } },
      },
    };
    const result = extractPropertySummary(page);
    expect(result).toContain("Status: Done");
    expect(result).toContain("Priority: Low");
    expect(result).toContain("Due: 2026-04-15");
  });

  it("skips null/unset property values", () => {
    const page = {
      properties: {
        Status: { type: "status", status: null },
        Priority: { type: "select", select: null },
        Due: { type: "date", date: null },
      },
    };
    expect(extractPropertySummary(page)).toBe("");
  });

  it("ignores unsupported property types", () => {
    const page = {
      properties: {
        Name: { type: "title", title: [{ plain_text: "Test" }] },
        Number: { type: "number", number: 42 },
      },
    };
    expect(extractPropertySummary(page)).toBe("");
  });

  it("returns empty string for page without properties", () => {
    expect(extractPropertySummary({})).toBe("");
  });
});
