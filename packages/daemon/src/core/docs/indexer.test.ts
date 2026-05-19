import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { applySchema } from "../../db/schema.js";
import {
  extractAnchors,
  indexCorpus,
  reindexSingle,
  seedCorpus,
  slugFromPath,
  startDocsIndexer,
} from "./indexer.js";

interface FtsRow {
  slug: string;
  title: string;
  category: string;
  anchors: string;
}

describe("extractAnchors", () => {
  it("captures H1, H2, and H3 headings", () => {
    const body = `# Title
## In One Sentence
some text
### Subhead
## Another H2`;
    expect(extractAnchors(body)).toEqual([
      "title",
      "in-one-sentence",
      "subhead",
      "another-h2",
    ]);
  });

  it("ignores H4+ and setext-style headings", () => {
    const body = `## Real Heading
text
#### Too Deep
text
Setext-style
============`;
    expect(extractAnchors(body)).toEqual(["real-heading"]);
  });

  it("does NOT capture a heading inside a fenced code block (drive-by fix from §6.2.2)", () => {
    // Pre-fix: HEADING_RE matched line-globally and captured `## Inside`
    // as a phantom anchor. The shared `iterateHeadings` walker tracks
    // fence state so example MD inside ``` blocks is treated as content.
    const body = `## Real
\`\`\`
## Inside Code
\`\`\`
## After`;
    expect(extractAnchors(body)).toEqual(["real", "after"]);
  });
});

describe("slugFromPath", () => {
  it("strips .md extension and rewrites separators", () => {
    expect(slugFromPath("/root/corpus", "/root/corpus/features/routines/morning-routine.md"))
      .toBe("features/routines/morning-routine");
  });
});

describe("indexCorpus", () => {
  let dir: string;
  let corpusDir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "docs-indexer-test-"));
    corpusDir = join(dir, "docs", "user");
    mkdirSync(corpusDir, { recursive: true });
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function writeDoc(relPath: string, content: string): void {
    const full = join(corpusDir, relPath);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }

  function rows(): FtsRow[] {
    return db
      .prepare("SELECT slug, title, category, anchors FROM fts_docs ORDER BY slug")
      .all() as FtsRow[];
  }

  it("indexes a valid doc into fts_docs and docs_revisions", async () => {
    writeDoc(
      "concepts/agent-day.md",
      `---
schema_version: 1
slug: concepts/agent-day
title: Agent Day
category: concepts
summary: |
  Day boundary at 04:00.
---

# Agent Day
## TL;DR
Day boundary at 04:00.
`,
    );
    const result = await indexCorpus(db, corpusDir);
    expect(result.fileCount).toBe(1);
    expect(result.errors).toEqual([]);
    const r = rows();
    expect(r).toHaveLength(1);
    expect(r[0]!.slug).toBe("concepts/agent-day");
    expect(r[0]!.title).toBe("Agent Day");
    expect(r[0]!.category).toBe("concepts");
    expect(r[0]!.anchors).toContain("tldr");

    const rev = db
      .prepare("SELECT slug, body_hash, frontmatter_hash FROM docs_revisions")
      .get() as { slug: string; body_hash: string; frontmatter_hash: string };
    expect(rev.slug).toBe("concepts/agent-day");
    expect(rev.body_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rev.frontmatter_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a doc whose slug does not match its filesystem path", async () => {
    writeDoc(
      "concepts/agent-day.md",
      `---
schema_version: 1
slug: concepts/wrong-slug
title: Bad
category: concepts
summary: |
  hi
---
# body
`,
    );
    const result = await indexCorpus(db, corpusDir);
    expect(result.fileCount).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.reason).toMatch(/slug.*does not match/i);
  });

  it("rejects a doc whose first slug segment differs from category", async () => {
    writeDoc(
      "features/routines/morning-routine.md",
      `---
schema_version: 1
slug: features/routines/morning-routine
title: Morning Routine
category: concepts
summary: |
  hi
---
# body
`,
    );
    const result = await indexCorpus(db, corpusDir);
    expect(result.fileCount).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.reason).toMatch(/first segment.*does not match category/i);
  });

  it("indexes the `related` frontmatter list as a JSON array column", async () => {
    writeDoc(
      "concepts/agent-day.md",
      `---
schema_version: 1
slug: concepts/agent-day
title: Agent Day
category: concepts
summary: |
  Day boundary at 04:00.
related:
  - features/routines/morning-routine
  - features/memory-files/today
---

# Agent Day
## TL;DR
Day boundary at 04:00.
`,
    );
    const result = await indexCorpus(db, corpusDir);
    expect(result.errors).toEqual([]);
    const row = db
      .prepare("SELECT slug, related FROM fts_docs WHERE slug = ?")
      .get("concepts/agent-day") as { slug: string; related: string };
    expect(JSON.parse(row.related)).toEqual([
      "features/routines/morning-routine",
      "features/memory-files/today",
    ]);
  });

  it("drops orphan rows on rebuild when a file is removed", async () => {
    writeDoc(
      "glossary.md",
      `---
schema_version: 1
slug: glossary
title: Glossary
category: glossary
summary: |
  hi
---
# Glossary
## Term
`,
    );
    await indexCorpus(db, corpusDir);
    expect(rows()).toHaveLength(1);

    rmSync(join(corpusDir, "glossary.md"));
    const result = await indexCorpus(db, corpusDir);
    expect(result.fileCount).toBe(0);
    expect(rows()).toHaveLength(0);
  });

  it("populates fts_doc_terms alongside fts_docs (Phase 2)", async () => {
    writeDoc(
      "concepts/agent-day.md",
      `---
schema_version: 1
slug: concepts/agent-day
title: Agent Day
category: concepts
aliases:
  - day boundary
keywords:
  - agent day
ask_examples:
  - When does the agent day roll over?
summary: |
  Day boundary at 04:00.
---

# Agent Day
## TL;DR
Day boundary at 04:00.
## Why 04:00
Late-night work belongs to yesterday.
`,
    );
    const result = await indexCorpus(db, corpusDir);
    expect(result.errors).toEqual([]);

    const termRows = db
      .prepare(
        "SELECT slug, anchor, term FROM fts_doc_terms ORDER BY rowid",
      )
      .all() as Array<{ slug: string; anchor: string; term: string }>;
    // 1 doc-level row + 2 H2 rows = 3 rows.
    expect(termRows).toHaveLength(3);
    expect(termRows[0]).toMatchObject({ anchor: "", term: "Agent Day" });
    expect(termRows.map((r) => r.anchor)).toEqual(["", "tldr", "why-0400"]);
  });

  it("populates fts_docs_word alongside fts_docs (Phase 3)", async () => {
    writeDoc(
      "concepts/agent-day.md",
      `---
schema_version: 1
slug: concepts/agent-day
title: Agent Day
category: concepts
summary: |
  Day boundary at 04:00.
---

# Agent Day
## TL;DR
Day boundary at 04:00.
`,
    );
    await indexCorpus(db, corpusDir);
    const wordRow = db
      .prepare("SELECT slug, title FROM fts_docs_word WHERE slug = ?")
      .get("concepts/agent-day") as { slug: string; title: string } | undefined;
    expect(wordRow?.slug).toBe("concepts/agent-day");
    expect(wordRow?.title).toBe("Agent Day");
  });

  it("orphan purge drops rows from all three indexes (Phase 2 + 3)", async () => {
    writeDoc(
      "glossary.md",
      `---
schema_version: 1
slug: glossary
title: Glossary
category: glossary
summary: |
  hi
---
# Glossary
## Term
content
`,
    );
    await indexCorpus(db, corpusDir);
    expect((db.prepare("SELECT COUNT(*) AS c FROM fts_docs").get() as { c: number }).c).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS c FROM fts_docs_word").get() as { c: number }).c).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS c FROM fts_doc_terms").get() as { c: number }).c).toBeGreaterThanOrEqual(1);

    rmSync(join(corpusDir, "glossary.md"));
    await indexCorpus(db, corpusDir);
    expect((db.prepare("SELECT COUNT(*) AS c FROM fts_docs").get() as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS c FROM fts_docs_word").get() as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS c FROM fts_doc_terms").get() as { c: number }).c).toBe(0);
  });

  it("reindexSingle replaces fts_doc_terms rows for the affected doc", async () => {
    writeDoc(
      "glossary.md",
      `---
schema_version: 1
slug: glossary
title: Glossary
category: glossary
summary: |
  hi
---
# Glossary
## First Term
first
## Second Term
second
`,
    );
    await indexCorpus(db, corpusDir);
    const beforeAnchors = (
      db
        .prepare("SELECT anchor FROM fts_doc_terms WHERE slug = ? ORDER BY rowid")
        .all("glossary") as Array<{ anchor: string }>
    ).map((r) => r.anchor);
    expect(beforeAnchors).toEqual(["", "first-term", "second-term"]);

    // Rewrite the doc with a different section list. reindexSingle
    // must drop the old term rows before inserting the new ones —
    // otherwise the "Second Term" row would linger.
    writeDoc(
      "glossary.md",
      `---
schema_version: 1
slug: glossary
title: Glossary
category: glossary
summary: |
  hi
---
# Glossary
## Renamed Term
renamed body
`,
    );
    reindexSingle(db, corpusDir, join(corpusDir, "glossary.md"));
    const afterAnchors = (
      db
        .prepare("SELECT anchor FROM fts_doc_terms WHERE slug = ? ORDER BY rowid")
        .all("glossary") as Array<{ anchor: string }>
    ).map((r) => r.anchor);
    expect(afterAnchors).toEqual(["", "renamed-term"]);
  });

  it("indexes the seed-corpus fixture docs from agent-assets/docs/", async () => {
    // Resolve the actual repo's fixture set so a regression in the
    // schema or fixtures (e.g. someone mutates frontmatter wrong)
    // surfaces here, not inside dashboard tests. P4 grew the corpus
    // beyond the original 3 fixtures, so the assertion is now
    // "at least the 3 design-mandated slugs are present and every
    // fixture parses cleanly" — the file count is whatever the
    // checked-in corpus happens to be.
    const repoRoot = join(__dirname, "..", "..", "..", "..", "..");
    seedCorpus(join(repoRoot, "agent-assets", "docs"), corpusDir);
    const result = await indexCorpus(db, corpusDir);
    expect(result.errors).toEqual([]);
    expect(result.fileCount).toBeGreaterThanOrEqual(3);
    const slugs = new Set(rows().map((row) => row.slug));
    for (const required of [
      "concepts/agent-day",
      "features/routines/morning-routine",
      "glossary",
    ]) {
      expect(slugs.has(required)).toBe(true);
    }
  });
});

describe("startDocsIndexer (no-watch)", () => {
  it("seeds an empty corpus dir from agent-assets and returns a healthy handle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "docs-indexer-handle-"));
    const corpusDir = join(dir, "docs", "user");
    const db = new Database(":memory:");
    applySchema(db);
    try {
      const repoRoot = join(__dirname, "..", "..", "..", "..", "..");
      const handle = await startDocsIndexer(db, {
        workspaceDir: repoRoot,
        corpusDir,
        watch: false,
      });
      const h = handle.health();
      expect(h.status).toBe("ok");
      // P4 grew the seed corpus beyond the original 3 fixtures; assert a
      // healthy non-empty boot scan rather than a frozen file count so
      // adding/removing docs doesn't break this test.
      expect(h.fileCount).toBeGreaterThanOrEqual(3);
      await handle.stop();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
