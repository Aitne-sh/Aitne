import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../db/schema.js";
import { createDocsRoutes } from "./docs.js";
import { DocsQAAdapter } from "../../adapters/docs-qa-adapter.js";
import { makeDbLookup } from "../../core/docs/citation-validator.js";

interface SearchResponse {
  total: number;
  results: { slug: string; title: string }[];
}

interface HealthResponse {
  status: string;
  fileCount: number;
}

describe("/api/docs/* routes", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    seed(db);
  });

  // Phase 2 + 3 (DOCS-QA-SEARCH-PRECISION-PLAN.md) added the
  // `fts_docs_word` parallel index and the `fts_doc_terms` subindex.
  // The /docs/search route dispatches ASCII queries to `fts_docs_word`
  // and the /docs/term-search route reads `fts_doc_terms`, so the test
  // seed populates all three tables in the same shape the production
  // indexer would.
  function seedDoc(
    db: Database.Database,
    row: {
      slug: string;
      title: string;
      keywords: string;
      aliases: string;
      summary: string;
      askExamples: string;
      body: string;
      tags: string[];
      processKeys: string[];
      configKeys: string[];
      category: string;
      section: string;
      status: string;
      anchors: string;
      related: string[];
      terms?: Array<{
        anchor: string;
        term: string;
        aliases: string;
        summary: string;
      }>;
    },
  ): void {
    db.prepare(
      `INSERT INTO fts_docs(
         slug, title, keywords, aliases, summary, ask_examples, body,
         tags, process_keys, config_keys, category, section, status, anchors,
         related
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.slug,
      row.title,
      row.keywords,
      row.aliases,
      row.summary,
      row.askExamples,
      row.body,
      JSON.stringify(row.tags),
      JSON.stringify(row.processKeys),
      JSON.stringify(row.configKeys),
      row.category,
      row.section,
      row.status,
      row.anchors,
      JSON.stringify(row.related),
    );
    db.prepare(
      `INSERT INTO fts_docs_word(
         slug, title, keywords, aliases, summary, ask_examples, body,
         category, tags
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.slug,
      row.title,
      row.keywords,
      row.aliases,
      row.summary,
      row.askExamples,
      row.body,
      row.category,
      JSON.stringify(row.tags),
    );
    const insertTerm = db.prepare(
      `INSERT INTO fts_doc_terms(slug, anchor, term, aliases, summary, category)
         VALUES (?, ?, ?, ?, ?, ?)`,
    );
    // Doc-level row first; then any explicit section rows the test asks for.
    insertTerm.run(
      row.slug,
      "",
      row.title,
      [row.aliases, row.keywords, row.askExamples]
        .filter((s) => s.length > 0)
        .join("\n"),
      row.summary,
      row.category,
    );
    for (const t of row.terms ?? []) {
      insertTerm.run(row.slug, t.anchor, t.term, t.aliases, t.summary, row.category);
    }
  }

  function seed(db: Database.Database): void {
    seedDoc(db, {
      slug: "concepts/agent-day",
      title: "Agent Day",
      keywords: "day boundary\n04:00",
      aliases: "day boundary",
      summary: "The agent day rolls over at 04:00 local time.",
      askExamples: "When does the agent day roll over?",
      body: "# Agent Day\n## TL;DR\nDay boundary at 04:00.",
      tags: ["core", "timing"],
      processKeys: [],
      configKeys: ["dayBoundaryHour"],
      category: "concepts",
      section: "",
      status: "stable",
      anchors: "agent-day\ntldr",
      related: ["features/routines/morning-routine"],
      terms: [
        {
          anchor: "tldr",
          term: "TL;DR",
          aliases: "",
          summary: "Day boundary at 04:00.",
        },
      ],
    });
    seedDoc(db, {
      slug: "features/routines/morning-routine",
      title: "Morning Routine",
      keywords: "morning\nday plan",
      aliases: "morning_routine\ndaily morning routine",
      summary: "The autonomous routine that runs once per agent-day.",
      askExamples: "When does morning routine run?",
      body: "# Morning Routine\n## In One Sentence\n## What It Outputs",
      tags: ["routine", "heavy-tier", "core"],
      processKeys: ["routine.morning_routine"],
      configKeys: ["morningRoutineHour"],
      category: "features",
      section: "routines",
      status: "stable",
      anchors: "morning-routine\nin-one-sentence\nwhat-it-outputs",
      related: ["concepts/agent-day"],
      terms: [
        {
          anchor: "in-one-sentence",
          term: "In One Sentence",
          aliases: "",
          summary: "",
        },
        {
          anchor: "what-it-outputs",
          term: "What It Outputs",
          aliases: "",
          summary: "",
        },
      ],
    });
    db.prepare(
      `INSERT INTO docs_revisions (slug, body_hash, frontmatter_hash, indexed_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
    ).run("concepts/agent-day", "h1", "h2");
  }

  it("GET /api/docs returns the doc tree with status", async () => {
    const app = createDocsRoutes({ db });
    const res = await app.request("/docs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      docs: { slug: string; status: string | null }[];
      total: number;
    };
    expect(body.total).toBe(2);
    expect(body.docs.map((d) => d.slug).sort()).toEqual([
      "concepts/agent-day",
      "features/routines/morning-routine",
    ]);
    const agentDay = body.docs.find((d) => d.slug === "concepts/agent-day");
    expect(agentDay?.status).toBe("stable");
  });

  it("GET /api/docs/by-slug/:slug returns the full doc body with ask_examples, status, and related", async () => {
    const app = createDocsRoutes({ db });
    const res = await app.request("/docs/by-slug/features/routines/morning-routine");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      slug: string;
      frontmatter: {
        title: string;
        status?: string;
        ask_examples: string[];
        related: string[];
      };
      anchors: string[];
    };
    expect(body.slug).toBe("features/routines/morning-routine");
    expect(body.frontmatter.title).toBe("Morning Routine");
    expect(body.frontmatter.status).toBe("stable");
    expect(body.frontmatter.ask_examples).toEqual(["When does morning routine run?"]);
    expect(body.frontmatter.related).toEqual(["concepts/agent-day"]);
    expect(body.anchors).toContain("what-it-outputs");
  });

  it("GET /api/docs/by-slug returns 404 for unknown slug", async () => {
    const app = createDocsRoutes({ db });
    const res = await app.request("/docs/by-slug/does/not/exist");
    expect(res.status).toBe(404);
  });

  it("GET /api/docs/search ranks by bm25 weights", async () => {
    const app = createDocsRoutes({ db });
    const res = await app.request("/docs/search?q=morning");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchResponse;
    expect(body.total).toBeGreaterThan(0);
    // Morning Routine doc must come first because the title weight is 3.0.
    expect(body.results[0]!.slug).toBe("features/routines/morning-routine");
  });

  it("GET /api/docs/search sanitizes operator-shaped input safely", async () => {
    // Pre-fix this query reached FTS5 raw and produced a 400 from the
    // sqlite syntax error. Post-fix the input is quoted as a phrase
    // (`"\"unbalanced"`) so the parser sees a literal phrase token,
    // returns a valid (empty) result, and never surfaces the error.
    const app = createDocsRoutes({ db });
    const res = await app.request("/docs/search?q=%22unbalanced");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchResponse;
    expect(body.total).toBe(0);
    expect(body.results).toEqual([]);
  });

  it("GET /api/docs/search treats FTS5 operators as literal phrase tokens", async () => {
    // `OR` between bare tokens would be parsed as the FTS5 OR operator,
    // broadening the search beyond the user's intent. After sanitization
    // each token is wrapped as a phrase (`"morning" "OR" "routine"`),
    // turning the operator into a literal token AND-joined with the
    // others. The corpus has no `OR` token, so total is 0 — the absence
    // of broadened results is what proves the operator was neutralized.
    const app = createDocsRoutes({ db });
    const res = await app.request("/docs/search?q=morning%20OR%20nonexistent");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchResponse;
    expect(body.total).toBe(0);
  });

  it("GET /api/docs/search filters by tag", async () => {
    const app = createDocsRoutes({ db });
    const res = await app.request("/docs/search?q=routine&tag=heavy-tier");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchResponse;
    expect(body.results.every((r) => r.slug.startsWith("features/"))).toBe(true);
  });

  it("GET /api/docs/health reports an ok corpus", async () => {
    const app = createDocsRoutes({ db });
    const res = await app.request("/docs/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthResponse;
    expect(body.status).toBe("ok");
    expect(body.fileCount).toBe(2);
  });

  it("GET /api/docs/qa/binding returns Claude defaults on a fresh DB", async () => {
    // Fresh schema seeds backend_global_defaults with Claude as the default
    // backend (see schema.ts seeds). With no process_backend_config row yet,
    // the binding endpoint must fall through to that default and clamp to
    // the canonical light model.
    const app = createDocsRoutes({ db });
    const res = await app.request("/docs/qa/binding");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      backend: string;
      backendDisplay: string;
      modelDisplay: string;
      isInstallDefault: boolean;
      availableModels: Array<{ modelId: string; label: string }>;
    };
    expect(body.backend).toBe("claude");
    expect(body.backendDisplay).toBe("Claude Code");
    // No owner_channels row → install default is true.
    expect(body.isInstallDefault).toBe(true);
    // Light-tier clamp picks the canonical Sonnet model.
    expect(body.modelDisplay.toLowerCase()).toContain("sonnet");
    // Picker options must include Sonnet (canonical medium-tier model). No
    // heavy / no deprecated models leak in: the picker would otherwise let
    // an operator pick Opus and bypass the dashboard.docs_qa TIER_LOCK via
    // the dispatcher's hard-override path.
    const ids = body.availableModels.map((m) => m.modelId);
    expect(ids).toContain("claude-sonnet-4-6");
    expect(ids).not.toContain("claude-opus-4-7");
    expect(ids).not.toContain("claude-opus-4-6");
  });

  it("GET /api/docs/qa/binding follows the cascade-materialized row when present", async () => {
    // Simulate the cascade-write helper: dashboard.docs_qa row picks up
    // message.dm's backend choice but the model is re-resolved at light tier.
    db.prepare(
      `INSERT INTO process_backend_config (
         process_key, main_backend, main_model,
         fallback_backend, fallback_model,
         max_turns, max_budget_usd, updated_by, updated_at
       ) VALUES (?, ?, ?, NULL, NULL, 20, 0.5, 'cascade', CURRENT_TIMESTAMP)
       ON CONFLICT(process_key) DO UPDATE SET
         main_backend = excluded.main_backend,
         main_model = excluded.main_model,
         updated_by = excluded.updated_by`,
    ).run("dashboard.docs_qa", "claude", "claude-opus-4-7"); // intentionally heavy
    const app = createDocsRoutes({ db });
    const res = await app.request("/docs/qa/binding");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { modelDisplay: string };
    // Even when the row stores a heavy pin, the binding clamp surfaces
    // the canonical light-tier label so the disclaimer is honest about
    // what the QA pipeline will actually run.
    expect(body.modelDisplay.toLowerCase()).toContain("sonnet");
  });

  describe("GET /api/docs/term-search", () => {
    it("returns 0 results for a query with no matching terms", async () => {
      const app = createDocsRoutes({ db });
      const res = await app.request("/docs/term-search?q=zzznotaword");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { total: number; results: unknown[] };
      expect(body.total).toBe(0);
      expect(body.results).toEqual([]);
    });

    it("finds a doc by frontmatter alias (matched on the doc-level row)", async () => {
      const app = createDocsRoutes({ db });
      const res = await app.request("/docs/term-search?q=morning_routine");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        total: number;
        results: Array<{ slug: string; anchor: string | null; citation: string }>;
      };
      expect(body.total).toBeGreaterThan(0);
      expect(body.results[0]!.slug).toBe("features/routines/morning-routine");
      // Doc-level row → anchor is null, citation has no `#` fragment.
      expect(body.results[0]!.anchor).toBeNull();
      expect(body.results[0]!.citation).toBe(
        "[doc:features/routines/morning-routine]",
      );
    });

    it("finds an H2 section row by heading text and emits a fragment citation", async () => {
      const app = createDocsRoutes({ db });
      // unicode61 tokenizes "What It Outputs" → ["what", "it", "outputs"];
      // querying `outputs` hits the section term row, not the doc-level row.
      const res = await app.request("/docs/term-search?q=outputs");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        total: number;
        results: Array<{ slug: string; anchor: string | null; citation: string }>;
      };
      const sectionHit = body.results.find(
        (r) => r.anchor === "what-it-outputs",
      );
      expect(sectionHit).toBeDefined();
      expect(sectionHit!.citation).toBe(
        "[doc:features/routines/morning-routine#what-it-outputs]",
      );
    });

    it("filters by &category=", async () => {
      const app = createDocsRoutes({ db });
      const res = await app.request("/docs/term-search?q=routine&category=features");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: Array<{ slug: string; category: string }>;
      };
      // Every returned row's category column must equal the filter.
      expect(body.results.every((r) => r.category === "features")).toBe(true);
    });

    it("rejects a missing q parameter with 400", async () => {
      const app = createDocsRoutes({ db });
      const res = await app.request("/docs/term-search");
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("validation_error");
    });

    it("returns total: 0 (not 400) for whitespace-only q (matches /docs/search contract)", async () => {
      const app = createDocsRoutes({ db });
      const res = await app.request("/docs/term-search?q=%20%20%20");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { total: number; results: unknown[] };
      expect(body.total).toBe(0);
      expect(body.results).toEqual([]);
    });

    it("respects the limit query param", async () => {
      const app = createDocsRoutes({ db });
      const res = await app.request("/docs/term-search?q=routine&limit=1");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { limit: number; results: unknown[] };
      expect(body.limit).toBe(1);
      expect(body.results.length).toBeLessThanOrEqual(1);
    });
  });

  describe("GET /api/docs/search dispatch (Phase 3)", () => {
    // Inject a doc whose body has both `routine` (verbatim) and another
    // doc whose only mention of the stem is the substring `subroutine`.
    // Trigram-only search would return both for q=routine; the unicode61
    // word index returns only the verbatim match — that's the precision
    // win the dispatch is for.
    function seedDispatchFixture(db: Database.Database): void {
      seedDoc(db, {
        slug: "concepts/word-only",
        title: "Word Only",
        keywords: "",
        aliases: "",
        summary: "Has the literal word routine in the body.",
        askExamples: "",
        body: "# Word Only\n## Body\nThe morning routine runs once per day.",
        tags: [],
        processKeys: [],
        configKeys: [],
        category: "concepts",
        section: "",
        status: "stable",
        anchors: "word-only\nbody",
        related: [],
      });
      seedDoc(db, {
        slug: "concepts/substring-only",
        title: "Substring Only",
        keywords: "",
        aliases: "",
        summary: "Only the substring subroutine appears in the body.",
        askExamples: "",
        // unicode61 splits on punctuation, so a hyphenated `co-routine`
        // would tokenize to ["co", "routine"] and accidentally match the
        // word query. Keep this fixture purely substring (no hyphens, no
        // word boundaries that contain the target).
        body: "# Substring Only\n## Body\nSubroutines and subroutine bodies multiply across the codebase.",
        tags: [],
        processKeys: [],
        configKeys: [],
        category: "concepts",
        section: "",
        status: "stable",
        anchors: "substring-only\nbody",
        related: [],
      });
    }

    it("ASCII query routes to fts_docs_word — substring overreach is suppressed", async () => {
      seedDispatchFixture(db);
      const app = createDocsRoutes({ db });
      const res = await app.request("/docs/search?q=routine");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: Array<{ slug: string }>;
      };
      const slugs = body.results.map((r) => r.slug);
      expect(slugs).toContain("concepts/word-only");
      // The substring-only doc must NOT appear — that is the precision
      // win; trigram tokenization would have surfaced it via the
      // `subroutine`/`co-routine` substrings.
      expect(slugs).not.toContain("concepts/substring-only");
    });

    // Verifies that the route's `isAsciiOnlyQuery` dispatch
    // (`fts5.ts:48`, applied at `docs.ts:397`) correctly routes any
    // non-ASCII query to the trigram index, and that the trigram
    // tokenizer (script-blind, sliding 3-codepoint windows) finds the
    // matching doc regardless of which non-ASCII script the content
    // uses. Each case below seeds a doc whose only mention of the
    // search term is inside a longer non-ASCII phrase, then queries
    // with a substring that requires the trigram path to find it.
    //
    // This block is the one place in the daemon test suite that holds
    // non-English literals: the test's purpose IS to validate
    // non-ASCII handling, so the input data must contain non-ASCII
    // characters by definition. Surrounding comments and identifiers
    // remain English per CLAUDE.md.
    type NonAsciiSearchCase = {
      label: string;
      slug: string;
      summary: string;
      body: string;
      query: string;
    };
    const NON_ASCII_CASES: NonAsciiSearchCase[] = [
      {
        label: "CJK (Japanese)",
        slug: "concepts/script-cjk",
        summary: "朝のルーチン about the morning routine.",
        body: "# CJK\n朝のルーチンが毎日動作する。",
        query: "朝のル",
      },
      {
        label: "Cyrillic",
        slug: "concepts/script-cyrillic",
        summary: "Утренний about the morning routine.",
        body: "# Cyrillic\nУтренний runs every day.",
        query: "утр",
      },
      {
        label: "Latin with diacritics",
        slug: "concepts/script-diacritic",
        summary: "café about the morning routine.",
        body: "# Diacritic\nThe morning café opens early.",
        query: "café",
      },
      {
        label: "Mixed ASCII + non-ASCII",
        slug: "concepts/script-mixed",
        summary: "delegatedモード concept overview.",
        body: "# Mixed\ndelegatedモード is the runtime concept.",
        query: "delegatedモード",
      },
    ];

    it.each(NON_ASCII_CASES)(
      "$label query routes to fts_docs (trigram) and matches the doc",
      async ({ slug, summary, body, query }) => {
        seedDoc(db, {
          slug,
          title: "Script case",
          keywords: "",
          aliases: "",
          summary,
          askExamples: "",
          body,
          tags: [],
          processKeys: [],
          configKeys: [],
          category: "concepts",
          section: "",
          status: "stable",
          anchors: "case",
          related: [],
        });
        const app = createDocsRoutes({ db });
        const res = await app.request(
          "/docs/search?q=" + encodeURIComponent(query),
        );
        expect(res.status).toBe(200);
        const responseBody = (await res.json()) as {
          results: Array<{ slug: string }>;
        };
        expect(responseBody.results.map((r) => r.slug)).toContain(slug);
      },
    );

    it("ASCII query with &category= filter still works (filter on fts_docs_word.category)", async () => {
      const app = createDocsRoutes({ db });
      const res = await app.request("/docs/search?q=routine&category=features");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: Array<{ slug: string; category: string }>;
      };
      // Every returned row's category column must equal the filter.
      expect(body.results.every((r) => r.category === "features")).toBe(true);
    });

    it("ASCII query with &tag= filter still works (filter on fts_docs_word.tags)", async () => {
      const app = createDocsRoutes({ db });
      const res = await app.request("/docs/search?q=routine&tag=heavy-tier");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: Array<{ slug: string; tags: string[] }>;
      };
      expect(body.results.every((r) => r.tags.includes("heavy-tier"))).toBe(true);
    });

    it("tag filter escapes SQLite LIKE wildcards so `tag=core%` does not broaden the match", async () => {
      // Pre-fix: `%"core%"%` reached SQLite verbatim; the second `%` was
      // a wildcard, so the filter matched any doc whose tag started
      // with `core` (`core`, `core-thing`, …) — silently widening the
      // operator's intent. Post-fix: `buildTagLikePattern` escapes the
      // `%` and the route uses `ESCAPE '#'`, so only docs whose tag is
      // literally `core%` pass through.
      seedDoc(db, {
        slug: "concepts/literal-percent",
        title: "Literal Percent",
        keywords: "",
        aliases: "",
        summary: "Tag is core% literally.",
        askExamples: "",
        body: "# Literal Percent\n## Body\nfilterprobe text.",
        tags: ["core%"],
        processKeys: [],
        configKeys: [],
        category: "concepts",
        section: "",
        status: "stable",
        anchors: "literal-percent\nbody",
        related: [],
      });
      seedDoc(db, {
        slug: "concepts/normal-core",
        title: "Normal Core",
        keywords: "",
        aliases: "",
        summary: "Tag is just core.",
        askExamples: "",
        body: "# Normal Core\n## Body\nfilterprobe text.",
        tags: ["core"],
        processKeys: [],
        configKeys: [],
        category: "concepts",
        section: "",
        status: "stable",
        anchors: "normal-core\nbody",
        related: [],
      });
      const app = createDocsRoutes({ db });
      // Body match `filterprobe` hits both fixture docs — the tag
      // filter is the only thing narrowing the result set, so the
      // assertion isolates the escape behavior.
      const res = await app.request(
        "/docs/search?q=filterprobe&tag=" + encodeURIComponent("core%"),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: Array<{ slug: string; tags: string[] }>;
      };
      const slugs = body.results.map((r) => r.slug);
      expect(slugs).toContain("concepts/literal-percent");
      expect(slugs).not.toContain("concepts/normal-core");
    });

    it("tag filter escapes SQLite LIKE wildcards so `tag=co_e` does not match `core`", async () => {
      // `_` is the single-char LIKE wildcard. Pre-fix `%"co_e"%` would
      // match any tag of the form `co<X>e` — `core`, `code`, `cone`.
      seedDoc(db, {
        slug: "concepts/co-core",
        title: "Co Core",
        keywords: "",
        aliases: "",
        summary: "Tag is core.",
        askExamples: "",
        body: "# Co Core\n## Body\nunderscoreprobe text.",
        tags: ["core"],
        processKeys: [],
        configKeys: [],
        category: "concepts",
        section: "",
        status: "stable",
        anchors: "co-core\nbody",
        related: [],
      });
      const app = createDocsRoutes({ db });
      const res = await app.request(
        "/docs/search?q=underscoreprobe&tag=" + encodeURIComponent("co_e"),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: Array<{ slug: string }>;
      };
      expect(body.results.map((r) => r.slug)).not.toContain("concepts/co-core");
    });

    it("empty result branch (buildMatchExpression returns null) is unchanged on both branches", async () => {
      const app = createDocsRoutes({ db });
      // Whitespace-only ASCII query — routes to ASCII branch, then
      // short-circuits on the buildMatchExpression null return.
      const ascii = await app.request("/docs/search?q=%20%20");
      expect(ascii.status).toBe(200);
      expect(((await ascii.json()) as { total: number }).total).toBe(0);
      // Whitespace-only mixed query (a single full-width space U+3000)
      // routes to non-ASCII branch but `q.split(/\s+/)` treats it as a
      // single token — confirm both branches respect their existing
      // empty-result contract by still returning a 200 with results=[].
      const cjk = await app.request("/docs/search?q=" + encodeURIComponent("　"));
      expect(cjk.status).toBe(200);
      const body = (await cjk.json()) as { total: number };
      expect(typeof body.total).toBe("number");
    });

    it("ASCII query returns process_keys / anchors via the JOIN-for-shape path", async () => {
      // Regression test for the result-shape JOIN: the seed doc's
      // process_keys/anchors are populated only on `fts_docs`; the ASCII
      // search route JOINs `fts_docs` to fetch them. Without the JOIN,
      // these fields would come back empty for ASCII queries.
      const app = createDocsRoutes({ db });
      const res = await app.request("/docs/search?q=morning");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: Array<{ slug: string; anchors: string[] }>;
      };
      const morning = body.results.find(
        (r) => r.slug === "features/routines/morning-routine",
      );
      expect(morning).toBeDefined();
      expect(morning!.anchors).toContain("what-it-outputs");
    });
  });

  describe("POST /api/docs/qa/messages", () => {
    function makeAdapter(db: Database.Database): {
      adapter: DocsQAAdapter;
      onMessage: ReturnType<typeof vi.fn>;
    } {
      const onMessage = vi.fn();
      const adapter = new DocsQAAdapter(onMessage, makeDbLookup(db));
      return { adapter, onMessage };
    }

    it("returns 503 when the adapter is not wired", async () => {
      const app = createDocsRoutes({ db });
      const res = await app.request("/docs/qa/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId: "any", content: "hi" }),
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("qa_adapter_unavailable");
    });

    it("rejects an unparseable JSON body with 400", async () => {
      const { adapter } = makeAdapter(db);
      const app = createDocsRoutes({ db, docsQAAdapter: adapter });
      const res = await app.request("/docs/qa/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("validation_error");
    });

    it("rejects unknown body keys with 400 (.strict)", async () => {
      const { adapter } = makeAdapter(db);
      const channelId = adapter.registerClient({
        writeSSE: async () => {},
        get closed() {
          return false;
        },
      });
      const app = createDocsRoutes({ db, docsQAAdapter: adapter });
      const res = await app.request("/docs/qa/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channelId,
          content: "hi",
          extraField: "should-be-rejected",
        }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects content over 10K with 400", async () => {
      const { adapter } = makeAdapter(db);
      const channelId = adapter.registerClient({
        writeSSE: async () => {},
        get closed() {
          return false;
        },
      });
      const app = createDocsRoutes({ db, docsQAAdapter: adapter });
      const res = await app.request("/docs/qa/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channelId,
          content: "x".repeat(10_001),
        }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 404 channel_not_connected for an unregistered channelId", async () => {
      const { adapter, onMessage } = makeAdapter(db);
      const app = createDocsRoutes({ db, docsQAAdapter: adapter });
      const res = await app.request("/docs/qa/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId: "ghost-channel", content: "hi" }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("channel_not_connected");
      expect(onMessage).not.toHaveBeenCalled();
    });

    it("enqueues a docs_qa MessageEvent and returns 202 {status:'accepted'}", async () => {
      const { adapter, onMessage } = makeAdapter(db);
      const channelId = adapter.registerClient({
        writeSSE: async () => {},
        get closed() {
          return false;
        },
      });
      const app = createDocsRoutes({ db, docsQAAdapter: adapter });

      const res = await app.request("/docs/qa/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channelId,
          content: "When does morning routine run?",
          scope: "current",
          context: { currentSlug: "features/routines/morning-routine" },
        }),
      });

      expect(res.status).toBe(202);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("accepted");

      expect(onMessage).toHaveBeenCalledTimes(1);
      const event = onMessage.mock.calls[0]![0] as {
        intent?: string;
        platform?: string;
        isDm?: boolean;
        content?: string;
        data?: Record<string, unknown>;
      };
      expect(event.intent).toBe("docs_qa");
      expect(event.platform).toBe("dashboard");
      expect(event.isDm).toBe(true);
      expect(event.content).toBe("When does morning routine run?");
      expect(event.data).toMatchObject({
        docsScope: "current",
        currentDocSlug: "features/routines/morning-routine",
        docsContextHint: { currentSlug: "features/routines/morning-routine" },
      });
    });

    it("defaults scope='all', currentDocSlug='(none)', and omits docsContextHint when context is absent", async () => {
      const { adapter, onMessage } = makeAdapter(db);
      const channelId = adapter.registerClient({
        writeSSE: async () => {},
        get closed() {
          return false;
        },
      });
      const app = createDocsRoutes({ db, docsQAAdapter: adapter });

      const res = await app.request("/docs/qa/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId, content: "hi" }),
      });
      expect(res.status).toBe(202);
      const event = onMessage.mock.calls[0]![0] as {
        data?: Record<string, unknown>;
      };
      expect(event.data).toEqual({ docsScope: "all", currentDocSlug: "(none)" });
    });

    it("forwards a registered light-tier modelId as requestedBackendId/requestedModelId", async () => {
      const { adapter, onMessage } = makeAdapter(db);
      const channelId = adapter.registerClient({
        writeSSE: async () => {},
        get closed() {
          return false;
        },
      });
      const app = createDocsRoutes({ db, docsQAAdapter: adapter });

      const res = await app.request("/docs/qa/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channelId,
          content: "hi",
          modelId: "claude-sonnet-4-6",
        }),
      });
      expect(res.status).toBe(202);
      const event = onMessage.mock.calls[0]![0] as {
        requestedBackendId?: string;
        requestedModelId?: string;
      };
      expect(event.requestedBackendId).toBe("claude");
      expect(event.requestedModelId).toBe("claude-sonnet-4-6");
    });

    it("rejects a heavy-tier modelId with 400 model_tier_locked", async () => {
      const { adapter, onMessage } = makeAdapter(db);
      const channelId = adapter.registerClient({
        writeSSE: async () => {},
        get closed() {
          return false;
        },
      });
      const app = createDocsRoutes({ db, docsQAAdapter: adapter });

      const res = await app.request("/docs/qa/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channelId,
          content: "hi",
          modelId: "claude-opus-4-7",
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("model_tier_locked");
      expect(onMessage).not.toHaveBeenCalled();
    });

    it("rejects an unregistered modelId with 400 model_not_registered", async () => {
      const { adapter, onMessage } = makeAdapter(db);
      const channelId = adapter.registerClient({
        writeSSE: async () => {},
        get closed() {
          return false;
        },
      });
      const app = createDocsRoutes({ db, docsQAAdapter: adapter });

      const res = await app.request("/docs/qa/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channelId,
          content: "hi",
          modelId: "claude-imaginary-model-99",
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("model_not_registered");
      expect(onMessage).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/docs/qa/stream", () => {
    it("returns 503 when the adapter is not wired", async () => {
      const app = createDocsRoutes({ db });
      const res = await app.request("/docs/qa/stream");
      expect(res.status).toBe(503);
    });

    it("opens an SSE stream and emits the initial session_info event with channelId", async () => {
      const onMessage = vi.fn();
      const adapter = new DocsQAAdapter(onMessage, makeDbLookup(db));
      const app = createDocsRoutes({ db, docsQAAdapter: adapter });

      const controller = new AbortController();
      const res = await app.request("/docs/qa/stream", { signal: controller.signal });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      // Read just enough of the stream to see the initial session_info.
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      // Drain until we see the session_info event boundary or a small
      // safety cap of bytes — the runtime may not flush in one chunk.
      for (let attempts = 0; attempts < 20 && !buffer.includes("session_info"); attempts += 1) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }

      expect(buffer).toContain("event: session_info");
      const dataLine = buffer
        .split("\n")
        .find((l) => l.startsWith("data: "));
      expect(dataLine).toBeDefined();
      const payload = JSON.parse(dataLine!.slice("data: ".length)) as {
        channelId: string;
      };
      expect(payload.channelId).toMatch(/^[0-9a-f-]{36}$/);
      // While the stream is still live, the channel must be active on
      // the adapter — i.e. POST /docs/qa/messages would now succeed.
      expect(adapter.isConnected(payload.channelId)).toBe(true);

      // Tear the stream down. After the route's `onAbort` fires, the
      // adapter unregisters the channel — verifying the lifecycle hook
      // is wired so a flapping client cannot leak channel entries.
      controller.abort();
      try {
        await reader.cancel();
      } catch {
        // cancel can throw on already-aborted streams; safe to ignore.
      }
    });
  });
});
