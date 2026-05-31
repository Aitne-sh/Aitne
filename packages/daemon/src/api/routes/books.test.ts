import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../db/schema.js";
import {
  parseKindleClippings,
  parseKindleNotebookHtml,
  importKindleNotebook,
  createBookRoutes,
} from "./books.js";
import type { ApiDependencies } from "../server.js";

describe("parseKindleClippings", () => {
  const sampleClippings = [
    "Thinking, Fast and Slow (Daniel Kahneman)",
    "- Your Highlight on Location 1234-1567 | Added on Monday, April 10, 2026 8:30:00 AM",
    "",
    "We can be blind to the obvious, and we are also blind to our blindness.",
    "==========",
    "Thinking, Fast and Slow (Daniel Kahneman)",
    "- Your Highlight on Location 2000-2100 | Added on Tuesday, April 11, 2026 9:00:00 AM",
    "",
    "A reliable way to make people believe in falsehoods is frequent repetition.",
    "==========",
    "Deep Work (Cal Newport)",
    "- Your Highlight on page 42 | Added on Wednesday, April 12, 2026 10:00:00 AM",
    "",
    "The ability to perform deep work is becoming increasingly rare.",
    "==========",
  ].join("\n");

  it("extracts books with title and author", () => {
    const { books } = parseKindleClippings(sampleClippings);
    expect(books.size).toBe(2);

    const entries = Array.from(books.values());
    expect(entries).toContainEqual({ title: "Thinking, Fast and Slow", author: "Daniel Kahneman" });
    expect(entries).toContainEqual({ title: "Deep Work", author: "Cal Newport" });
  });

  it("extracts highlights with content", () => {
    const { highlights } = parseKindleClippings(sampleClippings);
    expect(highlights).toHaveLength(3);

    expect(highlights[0].content).toBe(
      "We can be blind to the obvious, and we are also blind to our blindness.",
    );
    expect(highlights[1].content).toBe(
      "A reliable way to make people believe in falsehoods is frequent repetition.",
    );
    expect(highlights[2].content).toBe(
      "The ability to perform deep work is becoming increasingly rare.",
    );
  });

  it("extracts location from Location format", () => {
    const { highlights } = parseKindleClippings(sampleClippings);
    expect(highlights[0].location).toBe("1234-1567");
    expect(highlights[1].location).toBe("2000-2100");
  });

  it("extracts location from page format", () => {
    const { highlights } = parseKindleClippings(sampleClippings);
    expect(highlights[2].location).toBe("42");
  });

  it("extracts highlighted date", () => {
    const { highlights } = parseKindleClippings(sampleClippings);
    expect(highlights[0].highlightedAt).toBeTruthy();
    // Should be a valid ISO date
    expect(new Date(highlights[0].highlightedAt!).getFullYear()).toBe(2026);
  });

  it("handles books without author", () => {
    const clippings = [
      "Solo Title",
      "- Your Highlight on Location 100-200 | Added on Monday, April 10, 2026 8:00:00 AM",
      "",
      "Some highlighted text here.",
      "==========",
    ].join("\n");

    const { books, highlights } = parseKindleClippings(clippings);
    expect(books.size).toBe(1);

    const entry = Array.from(books.values())[0];
    expect(entry.title).toBe("Solo Title");
    expect(entry.author).toBeNull();
    expect(highlights).toHaveLength(1);
  });

  it("skips bookmarks (no content)", () => {
    const clippings = [
      "Some Book (Author)",
      "- Your Bookmark on Location 500 | Added on Monday, April 10, 2026 8:00:00 AM",
      "",
      "",
      "==========",
    ].join("\n");

    const { highlights } = parseKindleClippings(clippings);
    expect(highlights).toHaveLength(0);
  });

  it("returns empty for empty input", () => {
    const { books, highlights } = parseKindleClippings("");
    expect(books.size).toBe(0);
    expect(highlights).toHaveLength(0);
  });

  it("strips UTF-8 BOM from the start of the file", () => {
    const bom = "\uFEFF";
    const clippings = [
      `${bom}Thinking, Fast and Slow (Daniel Kahneman)`,
      "- Your Highlight on Location 1234-1567 | Added on Monday, April 10, 2026 8:30:00 AM",
      "",
      "Some content.",
      "==========",
    ].join("\n");
    const { books } = parseKindleClippings(clippings);
    const entry = Array.from(books.values())[0];
    expect(entry.title).toBe("Thinking, Fast and Slow");
    // No BOM should leak into the title.
    expect(entry.title.charCodeAt(0)).not.toBe(0xfeff);
  });
});

describe("parseKindleNotebookHtml", () => {
  const sampleHtml = `<!DOCTYPE html>
<html>
<body>
  <div class="bodyContainer">
    <div class="notebookFor">Notebook For</div>
    <div class="bookTitle">Thinking, Fast and Slow</div>
    <div class="authors">Daniel Kahneman</div>
    <div class="citation">Citation ...</div>
    <hr />
    <div class="sectionHeading">Introduction</div>
    <div class="noteHeading">Highlight (yellow) - Location 1234</div>
    <div class="noteText">We can be blind to the obvious, and we are also blind to our blindness.</div>
    <div class="noteHeading">Highlight (blue) - Page 42 · Location 2000</div>
    <div class="noteText">A reliable way to make people believe in falsehoods is frequent repetition.</div>
    <div class="noteHeading">Note - Location 2100</div>
    <div class="noteText">My own reaction to this chapter.</div>
    <div class="noteHeading">Bookmark - Location 9000</div>
    <div class="noteText">&nbsp;</div>
  </div>
</body>
</html>`;

  it("extracts book title and author from class-named elements", () => {
    const parsed = parseKindleNotebookHtml(sampleHtml);
    expect(parsed).not.toBeNull();
    expect(parsed!.book.title).toBe("Thinking, Fast and Slow");
    expect(parsed!.book.author).toBe("Daniel Kahneman");
  });

  it("extracts highlights with location and kind", () => {
    const parsed = parseKindleNotebookHtml(sampleHtml)!;
    const highlights = parsed.highlights.filter((h) => h.kind === "highlight");
    expect(highlights).toHaveLength(2);
    expect(highlights[0].location).toBe("1234");
    expect(highlights[0].content).toMatch(/blind to the obvious/);
    // When a heading includes both "Page X" and "Location Y", Location is the
    // canonical address (matches Kindle's own internal addressing).
    expect(highlights[1].location).toBe("2000");
  });

  it("falls back to page number when location is not present", () => {
    const html = `<div class="bookTitle">X</div>
<div class="noteHeading">Highlight - Page 42</div>
<div class="noteText">Page-only heading</div>`;
    const parsed = parseKindleNotebookHtml(html)!;
    expect(parsed.highlights[0].location).toBe("42");
  });

  it("captures notes separately from highlights and drops bookmarks", () => {
    const parsed = parseKindleNotebookHtml(sampleHtml)!;
    const notes = parsed.highlights.filter((h) => h.kind === "note");
    expect(notes).toHaveLength(1);
    expect(notes[0].content).toBe("My own reaction to this chapter.");
    const bookmarks = parsed.highlights.filter((h) => h.kind === "bookmark");
    expect(bookmarks).toHaveLength(0);
  });

  it("uses the email date as highlightedAt when provided", () => {
    const parsed = parseKindleNotebookHtml(sampleHtml, {
      date: "2026-04-14T09:00:00Z",
    })!;
    expect(parsed.highlights[0].highlightedAt).toBe("2026-04-14T09:00:00.000Z");
  });

  it("falls back to the email subject for title when HTML lacks .bookTitle", () => {
    const stripped = sampleHtml.replace(
      /<div class="bookTitle">[^<]+<\/div>/,
      "",
    );
    const parsed = parseKindleNotebookHtml(stripped, {
      subject: "Your Kindle Notebook from Deep Work",
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.book.title).toBe("Deep Work");
  });

  it("returns null when no highlights are present", () => {
    const parsed = parseKindleNotebookHtml(
      `<html><body><div class="bookTitle">A</div></body></html>`,
    );
    expect(parsed).toBeNull();
  });

  it("returns null for unrelated HTML", () => {
    const parsed = parseKindleNotebookHtml(
      `<html><body><p>Just a regular email with no Kindle markers.</p></body></html>`,
    );
    expect(parsed).toBeNull();
  });

  it("decodes common HTML entities in highlight content", () => {
    const html = `<div class="bookTitle">X</div>
<div class="noteHeading">Highlight - Location 10</div>
<div class="noteText">A &amp; B &quot;quote&quot; &#39;apos&#39;</div>`;
    const parsed = parseKindleNotebookHtml(html)!;
    expect(parsed.highlights[0].content).toBe('A & B "quote" \'apos\'');
  });

  it("handles nested inline tags inside bookTitle and noteText (regression)", () => {
    const html = `<div class="bookTitle">My <i>Great</i> Book</div>
<div class="authors">Some <b>Author</b></div>
<div class="noteHeading">Highlight - Location 5</div>
<div class="noteText">First half <em>emph</em> second half</div>`;
    const parsed = parseKindleNotebookHtml(html)!;
    expect(parsed.book.title).toBe("My Great Book");
    expect(parsed.book.author).toBe("Some Author");
    expect(parsed.highlights[0].content).toBe("First half emph second half");
  });

  it("pairs noteHeading with the next noteText across a sectionHeading", () => {
    const html = `<div class="bookTitle">X</div>
<div class="sectionHeading">Chapter 1</div>
<div class="noteHeading">Highlight - Location 10</div>
<div class="sectionHeading">Subsection</div>
<div class="noteText">the quick brown fox</div>
<div class="sectionHeading">Chapter 2</div>
<div class="noteHeading">Highlight - Location 20</div>
<div class="noteText">jumps over</div>`;
    const parsed = parseKindleNotebookHtml(html)!;
    const highlights = parsed.highlights.filter((h) => h.kind === "highlight");
    expect(highlights).toHaveLength(2);
    expect(highlights[0]).toMatchObject({ location: "10", content: "the quick brown fox" });
    expect(highlights[1]).toMatchObject({ location: "20", content: "jumps over" });
  });

  it("strips BOM before parsing", () => {
    const html = `\uFEFF<div class="bookTitle">Book</div>
<div class="noteHeading">Highlight - Location 1</div>
<div class="noteText">hello</div>`;
    const parsed = parseKindleNotebookHtml(html)!;
    expect(parsed.book.title).toBe("Book");
    expect(parsed.book.title.charCodeAt(0)).not.toBe(0xfeff);
  });
});

describe("GET /books — pagination", () => {
  let db: Database.Database;
  let app: ReturnType<typeof createBookRoutes>;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    const insert = db.prepare(
      "INSERT INTO books (title, author, source, status) VALUES (?, ?, 'kindle', 'reading')",
    );
    for (let i = 0; i < 250; i++) {
      insert.run(`Book ${String(i).padStart(3, "0")}`, `Author ${i}`);
    }
    app = createBookRoutes({ db } as unknown as ApiDependencies);
  });

  afterEach(() => {
    db.close();
  });

  async function get(query: string) {
    const res = await app.request(`/books${query}`);
    const body = (await res.json()) as {
      books: Array<{ title: string }>;
      total: number;
      limit: number;
      offset: number;
      hasMore: boolean;
    };
    return { status: res.status, body };
  }

  it("returns up to limit rows with total=250 when table has 250 rows", async () => {
    const { body } = await get("?limit=50");
    expect(body.books).toHaveLength(50);
    expect(body.total).toBe(250);
    expect(body.offset).toBe(0);
    expect(body.hasMore).toBe(true);
  });

  it("caps limit at 200 and still exposes full total", async () => {
    const { body } = await get("?limit=500");
    expect(body.books).toHaveLength(200);
    expect(body.limit).toBe(200);
    expect(body.total).toBe(250);
    expect(body.hasMore).toBe(true);
  });

  it("walks past the 200 cap via offset", async () => {
    const page1 = await get("?limit=200&offset=0");
    const page2 = await get("?limit=200&offset=200");
    expect(page1.body.books).toHaveLength(200);
    expect(page2.body.books).toHaveLength(50);
    expect(page2.body.offset).toBe(200);
    expect(page2.body.hasMore).toBe(false);
    const page1Ids = new Set(page1.body.books.map((b) => b.title));
    for (const b of page2.body.books) {
      expect(page1Ids.has(b.title)).toBe(false);
    }
  });

  it("normalizes negative and non-numeric offset to 0", async () => {
    const negative = await get("?limit=10&offset=-5");
    expect(negative.body.offset).toBe(0);
    const bogus = await get("?limit=10&offset=not-a-number");
    expect(bogus.body.offset).toBe(0);
  });
});

describe("parseKindleClippings — additional edge cases", () => {
  it("skips bookmark entries that have non-empty content (Bookmark meta-line check)", () => {
    const clippings = [
      "Some Book (Author)",
      "- Your Bookmark on Location 500 | Added on Monday, April 10, 2026 8:00:00 AM",
      "",
      "This is bookmark content that should not be imported.",
      "==========",
    ].join("\n");
    const { highlights } = parseKindleClippings(clippings);
    expect(highlights).toHaveLength(0);
  });

  it("sets highlightedAt to null when the date string is not parseable", () => {
    const clippings = [
      "Some Book (Author)",
      "- Your Highlight on Location 100-200 | Added on not-a-parseable-date-xyz",
      "",
      "Highlighted text content here.",
      "==========",
    ].join("\n");
    const { highlights } = parseKindleClippings(clippings);
    expect(highlights).toHaveLength(1);
    expect(highlights[0].highlightedAt).toBeNull();
  });

  it("extracts location from Loc. format", () => {
    const clippings = [
      "Some Book (Author)",
      "- Your Highlight Loc. 1234 | Added on Monday, April 10, 2026 8:00:00 AM",
      "",
      "Some highlighted text.",
      "==========",
    ].join("\n");
    const { highlights } = parseKindleClippings(clippings);
    expect(highlights[0].location).toBe("1234");
  });
});

describe("parseKindleNotebookHtml — additional edge cases", () => {
  it("extracts title from 'Your Kindle Notes: Title' subject pattern", () => {
    const html = `<html><body>
      <div class="noteHeading">Highlight - Location 1</div>
      <div class="noteText">some content</div>
    </body></html>`;
    const parsed = parseKindleNotebookHtml(html, {
      subject: "Your Kindle Notes: Deep Work",
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.book.title).toBe("Deep Work");
  });

  it("returns null when subject is provided but matches no known pattern and HTML has no bookTitle", () => {
    const html = `<html><body>
      <div class="noteHeading">Highlight - Location 1</div>
      <div class="noteText">some content</div>
    </body></html>`;
    const parsed = parseKindleNotebookHtml(html, {
      subject: "Random unrelated email subject",
    });
    expect(parsed).toBeNull();
  });

  it("sets highlightedAt to null when fallback date is invalid", () => {
    const html = `<div class="bookTitle">Book</div>
<div class="noteHeading">Highlight - Location 10</div>
<div class="noteText">content</div>`;
    const parsed = parseKindleNotebookHtml(html, { date: "not-a-valid-date" })!;
    expect(parsed).not.toBeNull();
    expect(parsed.highlights[0].highlightedAt).toBeNull();
  });

  it("breaks out of the heading/text pairing loop when the last heading has no following text", () => {
    const html = `<div class="bookTitle">X</div>
<div class="noteHeading">Highlight - Location 1</div>
<div class="noteText">First valid content</div>
<div class="noteHeading">Highlight - Location 2</div>`;
    const parsed = parseKindleNotebookHtml(html)!;
    expect(parsed.highlights).toHaveLength(1);
    expect(parsed.highlights[0].content).toBe("First valid content");
  });

  it("returns null author when the authors element is present but empty", () => {
    const html = `<div class="bookTitle">MyBook</div>
<div class="authors"></div>
<div class="noteHeading">Highlight - Location 5</div>
<div class="noteText">some content</div>`;
    const parsed = parseKindleNotebookHtml(html)!;
    expect(parsed.book.author).toBeNull();
  });

  it("sets location to null when noteHeading has no Location, Loc., or Page token", () => {
    const html = `<div class="bookTitle">X</div>
<div class="noteHeading">Highlight (yellow) - some descriptive text only</div>
<div class="noteText">content without any location</div>`;
    const parsed = parseKindleNotebookHtml(html)!;
    expect(parsed.highlights[0].location).toBeNull();
  });

  it("extracts location via Loc. format in noteHeading", () => {
    const html = `<div class="bookTitle">X</div>
<div class="noteHeading">Highlight - Loc. 777</div>
<div class="noteText">loc dot content</div>`;
    const parsed = parseKindleNotebookHtml(html)!;
    expect(parsed.highlights[0].location).toBe("777");
  });
});

describe("importKindleNotebook", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("reuses existing book id when the book already exists in the database", () => {
    const existing = db.prepare(
      `INSERT INTO books (title, author, source, status) VALUES (?, ?, 'kindle', 'reading') RETURNING id`,
    ).get("Pre-existing Title", "Author Name") as { id: number };

    const result = importKindleNotebook(db, {
      book: { title: "Pre-existing Title", author: "Author Name" },
      highlights: [
        { kind: "highlight" as const, content: "New highlight text", location: "100", highlightedAt: null },
      ],
    });

    expect(result.booksCreated).toBe(0);
    expect(result.bookId).toBe(existing.id);
    expect(result.highlightsInserted).toBe(1);
  });

  it("deduplicates highlights that are already in the database", () => {
    const bookRow = db.prepare(
      `INSERT INTO books (title, author, source, status) VALUES (?, ?, 'kindle', 'reading') RETURNING id`,
    ).get("Test Book", null) as { id: number };
    db.prepare(
      `INSERT INTO reading_highlights (book_id, content, location, highlighted_at) VALUES (?, ?, ?, ?)`,
    ).run(bookRow.id, "Duplicate content", "50", null);

    const result = importKindleNotebook(db, {
      book: { title: "Test Book", author: null },
      highlights: [
        { kind: "highlight" as const, content: "Duplicate content", location: "50", highlightedAt: null },
        { kind: "highlight" as const, content: "New unique content", location: "60", highlightedAt: null },
      ],
    });

    expect(result.booksCreated).toBe(0);
    expect(result.highlightsInserted).toBe(1);
  });

  it("skips highlights of kind 'note' and 'bookmark' (only 'highlight' is inserted)", () => {
    const result = importKindleNotebook(db, {
      book: { title: "Notes Book", author: null },
      highlights: [
        { kind: "note" as const, content: "A note", location: null, highlightedAt: null },
        { kind: "bookmark" as const, content: "A bookmark", location: null, highlightedAt: null },
        { kind: "highlight" as const, content: "A real highlight", location: "10", highlightedAt: null },
      ],
    });
    expect(result.highlightsInserted).toBe(1);
  });
});

describe("GET /books/summary", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    db.prepare("INSERT INTO books (title, author, source, status, completed_at) VALUES (?, ?, 'kindle', 'completed', datetime('now', '-1 month'))").run("Done Book", "Author A");
    db.prepare("INSERT INTO books (title, author, source, status) VALUES (?, ?, 'audible', 'reading')").run("Reading Book", "Author B");
  });

  afterEach(() => { db.close(); });

  it("returns by-status breakdown, monthly completed, and total highlights", async () => {
    const app = createBookRoutes({ db } as unknown as ApiDependencies);
    const res = await app.request("/books/summary");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { byStatus: { status: string; count: number }[]; monthlyCompleted: unknown[]; totalHighlights: number };
    expect(body.byStatus.find(s => s.status === "completed")?.count).toBe(1);
    expect(body.byStatus.find(s => s.status === "reading")?.count).toBe(1);
    expect(body.totalHighlights).toBe(0);
  });

  it("respects the months query parameter", async () => {
    const app = createBookRoutes({ db } as unknown as ApiDependencies);
    const res = await app.request("/books/summary?months=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { byStatus: unknown[]; monthlyCompleted: unknown[]; totalHighlights: number };
    expect(body.totalHighlights).toBe(0);
  });
});

describe("GET /books/:id/highlights", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    const book = db.prepare("INSERT INTO books (title, author, source, status) VALUES ('T','A','kindle','reading') RETURNING id").get() as { id: number };
    db.prepare("INSERT INTO reading_highlights (book_id, content, location, highlighted_at) VALUES (?,?,?,?)").run(book.id, "H1 content", "100", null);
    db.prepare("INSERT INTO reading_highlights (book_id, content, location, highlighted_at) VALUES (?,?,?,?)").run(book.id, "H2 content", "200", "2026-01-01T00:00:00.000Z");
  });

  afterEach(() => { db.close(); });

  it("returns highlights for a valid book id", async () => {
    const bookId = (db.prepare("SELECT id FROM books LIMIT 1").get() as { id: number }).id;
    const app = createBookRoutes({ db } as unknown as ApiDependencies);
    const res = await app.request(`/books/${bookId}/highlights`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { highlights: unknown[] };
    expect(body.highlights).toHaveLength(2);
  });

  it("returns 400 for a non-numeric id", async () => {
    const app = createBookRoutes({ db } as unknown as ApiDependencies);
    const res = await app.request("/books/abc/highlights");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_id");
  });

  it("respects the limit query parameter", async () => {
    const bookId = (db.prepare("SELECT id FROM books LIMIT 1").get() as { id: number }).id;
    const app = createBookRoutes({ db } as unknown as ApiDependencies);
    const res = await app.request(`/books/${bookId}/highlights?limit=1`);
    const body = (await res.json()) as { highlights: unknown[] };
    expect(body.highlights).toHaveLength(1);
  });
});

describe("GET /books — filters and highlight counts", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    const b1 = db.prepare("INSERT INTO books (title, author, source, status) VALUES ('R1','A','kindle','reading') RETURNING id").get() as { id: number };
    db.prepare("INSERT INTO books (title, author, source, status, completed_at) VALUES ('C1','A','audible','completed', datetime('now')) RETURNING id").get() as { id: number };
    db.prepare("INSERT INTO reading_highlights (book_id, content, location, highlighted_at) VALUES (?,?,?,?)").run(b1.id, "Some text", "10", null);
  });

  afterEach(() => { db.close(); });

  it("filters by status", async () => {
    const app = createBookRoutes({ db } as unknown as ApiDependencies);
    const res = await app.request("/books?status=completed");
    const body = (await res.json()) as { books: unknown[]; total: number };
    expect(body.total).toBe(1);
    expect(body.books).toHaveLength(1);
  });

  it("filters by source", async () => {
    const app = createBookRoutes({ db } as unknown as ApiDependencies);
    const res = await app.request("/books?source=audible");
    const body = (await res.json()) as { books: unknown[]; total: number };
    expect(body.total).toBe(1);
  });

  it("returns zero results (bookIds.length === 0 branch skips highlight count query)", async () => {
    const app = createBookRoutes({ db } as unknown as ApiDependencies);
    const res = await app.request("/books?status=abandoned");
    const body = (await res.json()) as { books: unknown[]; total: number };
    expect(body.total).toBe(0);
    expect(body.books).toHaveLength(0);
  });

  it("attaches correct highlight count for books that have highlights", async () => {
    const app = createBookRoutes({ db } as unknown as ApiDependencies);
    const res = await app.request("/books");
    const body = (await res.json()) as { books: Array<{ title: string; highlightCount: number }> };
    const r1 = body.books.find(b => b.title === "R1");
    expect(r1?.highlightCount).toBe(1);
    const c1 = body.books.find(b => b.title === "C1");
    expect(c1?.highlightCount).toBe(0);
  });
});

describe("PATCH /books/:id", () => {
  let db: Database.Database;
  let bookId: number;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    const row = db.prepare("INSERT INTO books (title, author, source, status) VALUES ('T','A','kindle','reading') RETURNING id").get() as { id: number };
    bookId = row.id;
  });

  afterEach(() => { db.close(); });

  async function patch(id: string | number, body: unknown) {
    const app = createBookRoutes({ db } as unknown as ApiDependencies);
    return app.request(`/books/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("returns 400 for non-numeric id", async () => {
    const res = await patch("abc", { status: "reading" });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("invalid_id");
  });

  it("returns 400 for invalid JSON body", async () => {
    const app = createBookRoutes({ db } as unknown as ApiDependencies);
    const res = await app.request(`/books/${bookId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "{ not valid json",
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("invalid_json");
  });

  it("returns 400 for invalid status value", async () => {
    const res = await patch(bookId, { status: "wishlist" });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("invalid_status");
  });

  it("returns 400 for rating out of range (0)", async () => {
    const res = await patch(bookId, { rating: 0 });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("rating_must_be_1_to_5");
  });

  it("returns 400 for rating out of range (6)", async () => {
    const res = await patch(bookId, { rating: 6 });
    expect(res.status).toBe(400);
  });

  it("returns 400 when no updateable fields are provided", async () => {
    const res = await patch(bookId, {});
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("no_updates");
  });

  it("returns 404 when book does not exist", async () => {
    const res = await patch(9999, { rating: 4 });
    expect(res.status).toBe(404);
    expect((await res.json() as { error: string }).error).toBe("not_found");
  });

  it("updates status to completed and sets completed_at", async () => {
    const res = await patch(bookId, { status: "completed" });
    expect(res.status).toBe(200);
    const row = db.prepare("SELECT status, completed_at FROM books WHERE id = ?").get(bookId) as { status: string; completed_at: string | null };
    expect(row.status).toBe("completed");
    expect(row.completed_at).not.toBeNull();
  });

  it("updates rating and notes independently", async () => {
    const res = await patch(bookId, { rating: 3, notes: "Great book" });
    expect(res.status).toBe(200);
    const row = db.prepare("SELECT rating, notes FROM books WHERE id = ?").get(bookId) as { rating: number; notes: string };
    expect(row.rating).toBe(3);
    expect(row.notes).toBe("Great book");
  });

  it("updates status to non-completed (no completed_at set)", async () => {
    const res = await patch(bookId, { status: "abandoned" });
    expect(res.status).toBe(200);
    const row = db.prepare("SELECT status, completed_at FROM books WHERE id = ?").get(bookId) as { status: string; completed_at: string | null };
    expect(row.status).toBe("abandoned");
    expect(row.completed_at).toBeNull();
  });

  it("clears completed_at when status leaves 'completed' (regression: stale completion date)", async () => {
    await patch(bookId, { status: "completed" });
    const completed = db.prepare("SELECT completed_at FROM books WHERE id = ?").get(bookId) as { completed_at: string | null };
    expect(completed.completed_at).not.toBeNull();

    const res = await patch(bookId, { status: "reading" });
    expect(res.status).toBe(200);

    const app = createBookRoutes({ db } as unknown as ApiDependencies);
    const listRes = await app.request("/books");
    const body = (await listRes.json()) as { books: Array<{ id: number; status: string; completedAt: string | null }> };
    const book = body.books.find((b) => b.id === bookId);
    expect(book?.status).toBe("reading");
    expect(book?.completedAt).toBeNull();
  });
});

describe("POST /books/import-clippings", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => { db.close(); });

  it("returns 413 when content-length exceeds 10 MB", async () => {
    const app = createBookRoutes({ db } as unknown as ApiDependencies);
    const res = await app.request("/books/import-clippings", {
      method: "POST",
      headers: { "Content-Type": "application/json", "content-length": String(11 * 1024 * 1024) },
      body: JSON.stringify({ data: "x" }),
    });
    expect(res.status).toBe(413);
    expect((await res.json() as { error: string }).error).toBe("payload_too_large");
  });

  it("returns 400 for invalid JSON body", async () => {
    const app = createBookRoutes({ db } as unknown as ApiDependencies);
    const res = await app.request("/books/import-clippings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ bad json",
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("invalid_json");
  });

  it("returns 400 when data field is missing", async () => {
    const app = createBookRoutes({ db } as unknown as ApiDependencies);
    const res = await app.request("/books/import-clippings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("data_required");
  });

  it("imports books and highlights successfully", async () => {
    const clippings = [
      "Thinking, Fast and Slow (Daniel Kahneman)",
      "- Your Highlight on Location 1234-1567 | Added on Monday, April 10, 2026 8:30:00 AM",
      "",
      "We can be blind to the obvious.",
      "==========",
    ].join("\n");

    const app = createBookRoutes({ db } as unknown as ApiDependencies);
    const res = await app.request("/books/import-clippings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: clippings }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; booksFound: number; booksCreated: number; highlightsInserted: number };
    expect(body.ok).toBe(true);
    expect(body.booksFound).toBe(1);
    expect(body.booksCreated).toBe(1);
    expect(body.highlightsInserted).toBe(1);
  });

  it("deduplicates when importing the same clipping twice", async () => {
    const clippings = [
      "Some Book (Author)",
      "- Your Highlight on Location 100 | Added on Monday, April 10, 2026 8:00:00 AM",
      "",
      "Some content.",
      "==========",
    ].join("\n");

    const app = createBookRoutes({ db } as unknown as ApiDependencies);
    await app.request("/books/import-clippings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: clippings }) });
    const res2 = await app.request("/books/import-clippings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: clippings }) });
    const body = (await res2.json()) as { booksCreated: number; highlightsInserted: number };
    expect(body.booksCreated).toBe(0);
    expect(body.highlightsInserted).toBe(0);
  });
});

describe("POST /books/import-notebook-html", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => { db.close(); });

  it("returns 413 when content-length exceeds 10 MB", async () => {
    const app = createBookRoutes({ db } as unknown as ApiDependencies);
    const res = await app.request("/books/import-notebook-html", {
      method: "POST",
      headers: { "Content-Type": "application/json", "content-length": String(11 * 1024 * 1024) },
      body: JSON.stringify({ html: "<div class=\"bookTitle\">X</div>" }),
    });
    expect(res.status).toBe(413);
  });

  it("returns 400 for invalid JSON body", async () => {
    const app = createBookRoutes({ db } as unknown as ApiDependencies);
    const res = await app.request("/books/import-notebook-html", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("invalid_json");
  });

  it("returns 400 when html field is missing", async () => {
    const app = createBookRoutes({ db } as unknown as ApiDependencies);
    const res = await app.request("/books/import-notebook-html", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject: "Some subject" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("html_required");
  });

  it("returns 422 when HTML does not contain recognizable Kindle notebook structure", async () => {
    const app = createBookRoutes({ db } as unknown as ApiDependencies);
    const res = await app.request("/books/import-notebook-html", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ html: "<html><body><p>Just some random email</p></body></html>" }),
    });
    expect(res.status).toBe(422);
    expect((await res.json() as { error: string }).error).toBe("unrecognized_format");
  });

  it("imports highlights from a valid Kindle notebook HTML", async () => {
    const html = `<div class="bookTitle">Great Book</div>
<div class="authors">Author Name</div>
<div class="noteHeading">Highlight - Location 100</div>
<div class="noteText">This is the highlighted passage.</div>`;
    const app = createBookRoutes({ db } as unknown as ApiDependencies);
    const res = await app.request("/books/import-notebook-html", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ html, date: "2026-04-10T09:00:00Z" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; title: string; author: string; booksCreated: number; highlightsInserted: number; highlightsInPayload: number };
    expect(body.ok).toBe(true);
    expect(body.title).toBe("Great Book");
    expect(body.author).toBe("Author Name");
    expect(body.booksCreated).toBe(1);
    expect(body.highlightsInserted).toBe(1);
    expect(body.highlightsInPayload).toBe(1);
  });
});
