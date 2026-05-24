import { Hono } from "hono";
import type { ApiDependencies } from "../server.js";
import { composeIssue, respondWithAgentError } from "../helpers/agent-errors.js";

interface BookRow {
  id: number;
  title: string;
  author: string | null;
  source: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  rating: number | null;
  notes: string | null;
  created_at: string;
}

interface HighlightRow {
  id: number;
  book_id: number;
  content: string;
  location: string | null;
  note: string | null;
  highlighted_at: string | null;
  created_at: string;
}

/**
 * Parse Kindle "My Clippings.txt" format.
 *
 * Each clipping is separated by "==========" and has:
 * Line 1: Title (Author)
 * Line 2: - Your Highlight on Location X-Y | Added on ...
 * Line 3: (blank)
 * Line 4+: Highlight content
 */
export function parseKindleClippings(text: string): {
  books: Map<string, { title: string; author: string | null }>;
  highlights: Array<{
    bookKey: string;
    content: string;
    location: string | null;
    highlightedAt: string | null;
  }>;
} {
  const books = new Map<string, { title: string; author: string | null }>();
  const highlights: Array<{
    bookKey: string;
    content: string;
    location: string | null;
    highlightedAt: string | null;
  }> = [];

  // Kindle devices write `My Clippings.txt` as UTF-8 with a BOM. Without
  // stripping it, the first book's title silently contains \uFEFF and
  // becomes a duplicate of the same book re-imported from Clippings v2 or
  // the Export Notebook email path.
  const entries = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(
    "==========",
  );

  for (const entry of entries) {
    const lines = entry.trim().split("\n").map((l) => l.trim());
    if (lines.length < 4) continue;

    // Line 0: "Book Title (Author Name)" or just "Book Title"
    const titleLine = lines[0];
    const authorMatch = titleLine.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
    const title = authorMatch ? authorMatch[1].trim() : titleLine.trim();
    const author = authorMatch ? authorMatch[2].trim() : null;
    /* c8 ignore next */ if (!title) continue;

    const bookKey = `${title}|||${author ?? ""}`;
    books.set(bookKey, { title, author });

    // Line 1: "- Your Highlight on Location 1234-1567 | Added on ..."
    // or "- Your Highlight on page 42 | Added on ..."
    const metaLine = lines[1];
    const locationMatch = metaLine.match(/(?:Location|location|Loc\.|page)\s+([\d-]+)/i);
    const location = locationMatch ? locationMatch[1] : null;
    const dateMatch = metaLine.match(/Added on\s+(.+)$/i);
    let highlightedAt: string | null = null;
    if (dateMatch) {
      try {
        highlightedAt = new Date(dateMatch[1]).toISOString();
      } catch {
        highlightedAt = null;
      }
    }

    const content = lines.slice(3).join("\n").trim();
    if (!content) continue;

    // Skip bookmarks — Kindle exports them as entries with the same shape
    // as highlights but no body, only a location marker.
    if (metaLine.includes("Bookmark")) continue;

    highlights.push({ bookKey, content, location, highlightedAt });
  }

  return { books, highlights };
}

/**
 * Parse Amazon's "Kindle Notebook Export" email HTML.
 *
 * Amazon's email template uses these class names:
 *   .bookTitle   — book title
 *   .authors     — author (comma-separated)
 *   .noteHeading — describes the next annotation (Highlight/Note, color, location/page)
 *   .noteText    — the annotation body
 *
 * Only class-name-based extraction is supported — if the email is in a
 * different format the function returns null so callers can fall back.
 */
export interface KindleNotebookExport {
  book: { title: string; author: string | null };
  highlights: Array<{
    kind: "highlight" | "note" | "bookmark";
    content: string;
    location: string | null;
    highlightedAt: string | null;
  }>;
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripTagsToText(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

function firstClassMatch(html: string, className: string): string | null {
  // Use a backreference for the closing tag so nested inline tags inside the
  // element (e.g. <div class="bookTitle">My <i>Great</i> Book</div>) do not
  // truncate the capture at the inner </i>.
  const re = new RegExp(
    `<(\\w+)[^>]*class\\s*=\\s*"[^"]*\\b${className}\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/\\1\\s*>`,
    "i",
  );
  const m = html.match(re);
  return m ? stripTagsToText(m[2]) : null;
}

/**
 * Collect noteHeading/noteText elements in document order.
 *
 * Scanning them independently (rather than as an adjacent regex pair) lets the
 * parser survive `<div class="sectionHeading">` chapter markers or other
 * markup between a heading and its text. Each heading is paired with the next
 * text element that follows it.
 */
interface TaggedElement {
  kind: "heading" | "text";
  content: string;
  pos: number;
}

function collectAnnotationElements(html: string): TaggedElement[] {
  const re =
    /<(\w+)[^>]*class\s*=\s*"[^"]*\b(noteHeading|noteText)\b[^"]*"[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  const out: TaggedElement[] = [];
  for (const m of html.matchAll(re)) {
    out.push({
      kind: m[2].toLowerCase() === "noteheading" ? "heading" : "text",
      content: stripTagsToText(m[3]),
      pos: m.index ?? 0,
    });
  }
  out.sort((a, b) => a.pos - b.pos);
  return out;
}

/** Strip the UTF-8 BOM that Kindle files often carry. */
function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function parseNoteHeading(heading: string): {
  kind: KindleNotebookExport["highlights"][number]["kind"];
  location: string | null;
} {
  const lower = heading.toLowerCase();
  let kind: KindleNotebookExport["highlights"][number]["kind"] = "highlight";
  if (lower.includes("note")) kind = "note";
  else if (lower.includes("bookmark")) kind = "bookmark";

  // Prefer "Location 1234-1567" then "Page 42" then "Loc. 1234".
  let location: string | null = null;
  const locMatch = heading.match(/location\s+([\d-]+)/i) ?? heading.match(/loc\.\s+([\d-]+)/i);
  if (locMatch) location = locMatch[1];
  else {
    const pageMatch = heading.match(/page\s+([\d-]+)/i);
    if (pageMatch) location = pageMatch[1];
  }
  return { kind, location };
}

export function parseKindleNotebookHtml(
  html: string,
  fallback?: { subject?: string | null; date?: string | null },
): KindleNotebookExport | null {
  const cleaned = stripBom(html)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");

  let title = firstClassMatch(cleaned, "bookTitle");
  const author = firstClassMatch(cleaned, "authors");

  if (!title && fallback?.subject) {
    // "Your Kindle notebook from <Book Title>" — common subject shape.
    const sub = fallback.subject;
    const m =
      sub.match(/notebook\s+from\s+[""]?([^""\n]+?)[""]?\s*$/i) ??
      sub.match(/your\s+kindle\s+notes?\s*[-:]\s*(.+)$/i);
    if (m) title = m[1].trim();
  }

  if (!title) return null;

  const highlightedAt = fallback?.date
    ? (() => {
        const t = new Date(fallback.date!);
        return isNaN(t.getTime()) ? null : t.toISOString();
      })()
    : null;

  const highlights: KindleNotebookExport["highlights"] = [];
  const elements = collectAnnotationElements(cleaned);

  // Pair each heading with the next text element, skipping anything in between.
  let i = 0;
  while (i < elements.length) {
    if (elements[i].kind !== "heading") {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < elements.length && elements[j].kind !== "text") j++;
    if (j >= elements.length) break;

    const { kind, location } = parseNoteHeading(elements[i].content);
    const content = elements[j].content;
    if (content && kind !== "bookmark") {
      highlights.push({ kind, content, location, highlightedAt });
    }
    i = j + 1;
  }

  if (highlights.length === 0) return null;

  return {
    book: { title, author: author && author.length > 0 ? author : null },
    highlights,
  };
}

/**
 * Insert an already-parsed Kindle notebook export into the DB.
 * Shared between the HTTP endpoint and the Gmail poller path.
 */
export interface ImportNotebookResult {
  booksCreated: number;
  highlightsInserted: number;
  bookId: number;
}

export function importKindleNotebook(
  db: ApiDependencies["db"],
  parsed: KindleNotebookExport,
): ImportNotebookResult {
  let booksCreated = 0;
  let highlightsInserted = 0;
  let bookId = 0;

  const run = db.transaction(() => {
    const existing = db.prepare(
      `SELECT id FROM books WHERE title = ? AND COALESCE(author, '') = ?`,
    ).get(parsed.book.title, parsed.book.author ?? "") as
      | { id: number }
      | undefined;

    if (existing) {
      bookId = existing.id;
    } else {
      const row = db.prepare(
        `INSERT INTO books (title, author, source, status)
         VALUES (?, ?, 'kindle', 'reading')
         RETURNING id`,
      ).get(parsed.book.title, parsed.book.author) as { id: number };
      bookId = row.id;
      booksCreated++;
    }

    const insertHighlight = db.prepare(
      `INSERT INTO reading_highlights (book_id, content, location, highlighted_at)
       VALUES (?, ?, ?, ?)`,
    );
    for (const h of parsed.highlights) {
      if (h.kind !== "highlight") continue;
      const exists = db.prepare(
        `SELECT 1 FROM reading_highlights WHERE book_id = ? AND content = ?`,
      ).get(bookId, h.content);
      if (exists) continue;
      insertHighlight.run(bookId, h.content, h.location, h.highlightedAt);
      highlightsInserted++;
    }
  });

  run();
  return { booksCreated, highlightsInserted, bookId };
}

export function createBookRoutes(deps: ApiDependencies): Hono {
  const app = new Hono();
  const { db } = deps;

  /**
   * GET /books — list books with optional filters + pagination.
   *
   * Query params:
   * - status: reading | completed | abandoned | all (default: all)
   * - source: kindle | audible | manual | all (default: all)
   * - limit: page size (1–200, default 50)
   * - offset: number of rows to skip (≥0, default 0). Use with limit to
   *   walk past the 200-row cap. Response still includes `total` so the
   *   caller can detect the end of the result set.
   */
  app.get("/books", (c) => {
    const status = c.req.query("status") ?? "all";
    const source = c.req.query("source") ?? "all";
    const limit = Math.min(
      Math.max(parseInt(c.req.query("limit") ?? "50", 10), 1),
      200,
    );
    const rawOffset = parseInt(c.req.query("offset") ?? "0", 10);
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (status !== "all") {
      conditions.push("status = ?");
      params.push(status);
    }
    if (source !== "all") {
      conditions.push("source = ?");
      params.push(source);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countRow = db.prepare(
      `SELECT COUNT(*) as count FROM books ${where}`,
    ).get(...params) as { count: number };

    const rows = db.prepare(
      `SELECT id, title, author, source, status, started_at, completed_at,
              rating, notes, created_at
       FROM books ${where}
       ORDER BY COALESCE(completed_at, started_at, created_at) DESC
       LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as BookRow[];

    const bookIds = rows.map((r) => r.id);
    const highlightCounts = new Map<number, number>();
    if (bookIds.length > 0) {
      const placeholders = bookIds.map(() => "?").join(",");
      const countRows = db.prepare(
        `SELECT book_id, COUNT(*) as count
         FROM reading_highlights
         WHERE book_id IN (${placeholders})
         GROUP BY book_id`,
      ).all(...bookIds) as { book_id: number; count: number }[];
      for (const r of countRows) {
        highlightCounts.set(r.book_id, r.count);
      }
    }

    const books = rows.map((row) => ({
      id: row.id,
      title: row.title,
      author: row.author,
      source: row.source,
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      rating: row.rating,
      notes: row.notes,
      highlightCount: highlightCounts.get(row.id) ?? 0,
      createdAt: row.created_at,
    }));

    return c.json({
      books,
      total: countRow.count,
      limit,
      offset,
      hasMore: offset + books.length < countRow.count,
    });
  });

  /**
   * GET /books/:id/highlights — get highlights for a book.
   */
  app.get("/books/:id/highlights", (c) => {
    const rawId = c.req.param("id");
    const bookId = parseInt(rawId, 10);
    if (isNaN(bookId) || bookId <= 0) {
      return respondWithAgentError(c, 400, [
        composeIssue("books.invalid_id", { field: "id", received: rawId }),
      ]);
    }

    const limit = Math.min(
      Math.max(parseInt(c.req.query("limit") ?? "100", 10), 1),
      500,
    );

    const rows = db.prepare(
      `SELECT id, book_id, content, location, note, highlighted_at, created_at
       FROM reading_highlights
       WHERE book_id = ?
       ORDER BY COALESCE(highlighted_at, created_at) DESC
       LIMIT ?`,
    ).all(bookId, limit) as HighlightRow[];

    const highlights = rows.map((row) => ({
      id: row.id,
      bookId: row.book_id,
      content: row.content,
      location: row.location,
      note: row.note,
      highlightedAt: row.highlighted_at,
      createdAt: row.created_at,
    }));

    return c.json({ highlights });
  });

  /**
   * GET /books/summary — reading stats.
   */
  app.get("/books/summary", (c) => {
    const months = Math.min(Math.max(parseInt(c.req.query("months") ?? "12", 10), 1), 36);

    const statusCounts = db.prepare(
      `SELECT status, COUNT(*) as count FROM books GROUP BY status`,
    ).all() as { status: string; count: number }[];

    const monthlyCompleted = db.prepare(
      `SELECT strftime('%Y-%m', completed_at) AS month, COUNT(*) AS count
       FROM books
       WHERE status = 'completed'
         AND completed_at >= date('now', '-' || ? || ' months')
       GROUP BY month
       ORDER BY month DESC`,
    ).all(months) as { month: string; count: number }[];

    const totalHighlights = db.prepare(
      `SELECT COUNT(*) as count FROM reading_highlights`,
    ).get() as { count: number };

    return c.json({
      byStatus: statusCounts,
      monthlyCompleted,
      totalHighlights: totalHighlights.count,
    });
  });

  /**
   * PATCH /books/:id — update book status, rating, or notes.
   */
  app.patch("/books/:id", async (c) => {
    const rawId = c.req.param("id");
    const id = parseInt(rawId, 10);
    if (isNaN(id) || id <= 0) {
      return respondWithAgentError(c, 400, [
        composeIssue("books.invalid_id", { field: "id", received: rawId }),
      ]);
    }

    let body: { status?: string; rating?: number; notes?: string };
    try {
      body = await c.req.json<{ status?: string; rating?: number; notes?: string }>();
    } catch {
      return respondWithAgentError(c, 400, [
        composeIssue("books.invalid_json", { field: "body", received: "<unparseable>" }),
      ]);
    }

    const validStatuses = ["reading", "completed", "abandoned"];
    if (body.status && !validStatuses.includes(body.status)) {
      return respondWithAgentError(
        c,
        400,
        [composeIssue("books.invalid_status", { field: "status", received: body.status })],
        { legacyFields: { valid: validStatuses } },
      );
    }
    if (body.rating !== undefined && (body.rating < 1 || body.rating > 5)) {
      return respondWithAgentError(c, 400, [
        composeIssue("books.rating_must_be_1_to_5", { field: "rating", received: body.rating }),
      ]);
    }

    const updates: string[] = [];
    const params: unknown[] = [];

    if (body.status) {
      updates.push("status = ?");
      params.push(body.status);
      if (body.status === "completed") {
        updates.push("completed_at = datetime('now')");
      }
    }
    if (body.rating !== undefined) {
      updates.push("rating = ?");
      params.push(body.rating);
    }
    if (body.notes !== undefined) {
      updates.push("notes = ?");
      params.push(body.notes);
    }

    if (updates.length === 0) {
      return respondWithAgentError(c, 400, [
        composeIssue("books.no_updates", { field: "body", received: body }),
      ]);
    }

    params.push(id);
    const result = db.prepare(
      `UPDATE books SET ${updates.join(", ")} WHERE id = ?`,
    ).run(...params);

    if (result.changes === 0) {
      return respondWithAgentError(c, 404, [
        composeIssue("books.not_found", { field: "id", received: id }),
      ]);
    }

    return c.json({ ok: true, id });
  });

  /**
   * POST /books/import-clippings — import Kindle My Clippings.txt.
   *
   * Body: { data: string }
   * Max body size: 10 MB (typical My Clippings.txt is under 5 MB).
   */
  app.post("/books/import-clippings", async (c) => {
    const MAX_BODY_BYTES = 10 * 1024 * 1024;
    const contentLength = parseInt(c.req.header("content-length") ?? "0", 10);
    if (contentLength > MAX_BODY_BYTES) {
      return respondWithAgentError(
        c,
        413,
        [
          composeIssue("books.payload_too_large", {
            field: "content-length",
            received: contentLength,
          }),
        ],
        { legacyFields: { maxBytes: MAX_BODY_BYTES } },
      );
    }

    let body: { data?: string };
    try {
      body = await c.req.json<{ data?: string }>();
    } catch {
      return respondWithAgentError(c, 400, [
        composeIssue("books.invalid_json", { field: "body", received: "<unparseable>" }),
      ]);
    }

    if (!body.data) {
      return respondWithAgentError(c, 400, [
        composeIssue("books.data_required", { field: "data", received: "<missing>" }),
      ]);
    }

    const { books: bookMap, highlights } = parseKindleClippings(body.data);

    const insertHighlight = db.prepare(
      `INSERT INTO reading_highlights (book_id, content, location, highlighted_at)
       VALUES (?, ?, ?, ?)`,
    );

    let booksCreated = 0;
    let highlightsInserted = 0;

    const importAll = db.transaction(() => {
      const bookIdMap = new Map<string, number>();
      for (const [key, { title, author }] of bookMap) {
        // Use COALESCE to match the UNIQUE index on (title, COALESCE(author, ''))
        const existing = db.prepare(
          `SELECT id FROM books WHERE title = ? AND COALESCE(author, '') = ?`,
        ).get(title, author ?? "") as { id: number } | undefined;

        if (existing) {
          bookIdMap.set(key, existing.id);
        } else {
          const row = db.prepare(
            `INSERT INTO books (title, author, source, status)
             VALUES (?, ?, 'kindle', 'reading')
             RETURNING id`,
          ).get(title, author) as { id: number };
          bookIdMap.set(key, row.id);
          booksCreated++;
        }
      }

      for (const h of highlights) {
        const bookId = bookIdMap.get(h.bookKey);
        if (!bookId) continue;

        // Dedup by exact content match within the same book — Kindle
        // exports duplicate every highlight on each re-export.
        const exists = db.prepare(
          `SELECT 1 FROM reading_highlights WHERE book_id = ? AND content = ?`,
        ).get(bookId, h.content);
        if (exists) continue;

        insertHighlight.run(bookId, h.content, h.location, h.highlightedAt);
        highlightsInserted++;
      }
    });

    importAll();

    return c.json({
      ok: true,
      booksFound: bookMap.size,
      booksCreated,
      highlightsInserted,
    });
  });

  /**
   * POST /books/import-notebook-html — import a Kindle "Export Notebook" email HTML.
   *
   * Body: { html: string, subject?: string, date?: string }
   * The subject/date are used as fallbacks when the HTML lacks an explicit
   * book title or highlight timestamp.
   */
  app.post("/books/import-notebook-html", async (c) => {
    const MAX_BODY_BYTES = 10 * 1024 * 1024;
    const contentLength = parseInt(c.req.header("content-length") ?? "0", 10);
    if (contentLength > MAX_BODY_BYTES) {
      return respondWithAgentError(
        c,
        413,
        [
          composeIssue("books.payload_too_large", {
            field: "content-length",
            received: contentLength,
          }),
        ],
        { legacyFields: { maxBytes: MAX_BODY_BYTES } },
      );
    }

    let body: { html?: string; subject?: string; date?: string };
    try {
      body = await c.req.json<{ html?: string; subject?: string; date?: string }>();
    } catch {
      return respondWithAgentError(c, 400, [
        composeIssue("books.invalid_json", { field: "body", received: "<unparseable>" }),
      ]);
    }

    if (!body.html) {
      return respondWithAgentError(c, 400, [
        composeIssue("books.html_required", { field: "html", received: "<missing>" }),
      ]);
    }

    const parsed = parseKindleNotebookHtml(body.html, {
      subject: body.subject ?? null,
      date: body.date ?? null,
    });
    if (!parsed) {
      return respondWithAgentError(c, 422, [
        composeIssue("books.unrecognized_format", {
          field: "html",
          received: "<unrecognized Kindle notebook shape>",
        }),
      ]);
    }

    const result = importKindleNotebook(db, parsed);
    return c.json({
      ok: true,
      title: parsed.book.title,
      author: parsed.book.author,
      booksCreated: result.booksCreated,
      highlightsInserted: result.highlightsInserted,
      highlightsInPayload: parsed.highlights.filter((h) => h.kind === "highlight").length,
    });
  });

  return app;
}
