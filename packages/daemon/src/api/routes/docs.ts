import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type Database from "better-sqlite3";
import type { ApiDependencies } from "../server.js";
import { createLogger } from "../../logging.js";
import { composeIssue, respondWithAgentError } from "../helpers/agent-errors.js";
import type { DocsIndexerHandle } from "../../core/docs/indexer.js";
import type { DocsQAAdapter } from "../../adapters/docs-qa-adapter.js";
import type { BackendId } from "@aitne/shared";
import { buildMatchExpression, isAsciiOnlyQuery } from "../../services/fts5.js";
import {
  DEFAULT_CLAUDE_MEDIUM_MODEL,
  DEFAULT_CODEX_MEDIUM_MODEL,
  DEFAULT_GEMINI_MEDIUM_MODEL,
  DEFAULT_OPENCODE_MEDIUM_MODEL,
  findRegisteredModel,
  getModelLabel,
  getModelsForBackend,
  latestMediumFor,
} from "../../core/backends/model-registry.js";

/**
 * Per-backend medium-tier default used by the docs-QA picker when the
 * registry has no live medium model for the backend (registry pruned,
 * everything marked deprecated, etc.). Keeps the fallback symmetric across
 * backends rather than handing claude a real model and leaving opencode/
 * codex/gemini with an empty string when the row also has no `main_model`.
 */
function defaultMediumModelFor(backendId: BackendId): string {
  switch (backendId) {
    case "claude":
      return DEFAULT_CLAUDE_MEDIUM_MODEL;
    case "codex":
      return DEFAULT_CODEX_MEDIUM_MODEL;
    case "gemini":
      return DEFAULT_GEMINI_MEDIUM_MODEL;
    case "opencode":
      return DEFAULT_OPENCODE_MEDIUM_MODEL;
  }
}
import {
  DOCS_QA_SCOPE,
  DOCS_QA_SCOPE_KEY,
} from "../../messaging/constants.js";

const logger = createLogger("docs-api");

/**
 * `/api/docs/*` route group (DOCS_QA_DESIGN.md §10.4 read endpoints +
 * search-call rate-limit).
 *
 * The slug-fetch route lives under `/by-slug/:slug{.+}` rather than
 * `/:slug{.+}` so the path-style slug (`features/routines/morning-routine`) // drift-allow
 * cannot shadow the static `/search`, `/health`, `/qa/binding` siblings —
 * Hono's wildcard matcher is eager and would otherwise capture them.
 */

interface FtsRow {
  slug: string;
  title: string;
  keywords: string;
  aliases: string;
  summary: string;
  ask_examples: string;
  body: string;
  tags: string;
  process_keys: string;
  config_keys: string;
  category: string;
  section: string;
  status: string;
  anchors: string;
  related: string;
  rank: number;
}

/**
 * Narrow row type returned by `/docs/search` SQL. The schema-level
 * superset is `FtsRow`; the search route deliberately SELECTs only
 * the columns the response payload uses, so the cast reflects what
 * SQLite actually projects. Dropping the unused columns from the
 * SELECT has no behavioral effect — pre-cleanup the rows just carried
 * dead payload from SQLite to V8 — but stops `.body` / `.keywords` /
 * `.aliases` / `.ask_examples` / `.process_keys` / `.config_keys`
 * from masquerading as available in autocomplete and helps reviewers
 * see at a glance which columns the route relies on.
 */
interface SearchRow {
  slug: string;
  title: string;
  summary: string;
  tags: string;
  category: string;
  section: string;
  anchors: string;
  rank: number;
}

interface DocSearchResult {
  slug: string;
  title: string;
  category: string;
  section: string;
  summary: string;
  tags: string[];
  /** All anchors for the doc (not just matched anchors — renamed for clarity). */
  anchors: string[];
  rank: number;
}

interface TreeNode {
  slug: string;
  title: string;
  category: string;
  section: string | null;
  status: string | null;
  summary: string;
}

const SEARCH_LIMIT_DEFAULT = 5;
const SEARCH_LIMIT_MAX = 20;

/**
 * Backend display strings for the QA disclaimer. Mirrors the dashboard's
 * `BACKEND_LABELS` (packages/dashboard/src/lib/backend-ui.ts) — kept here
 * as a small literal because the daemon does not depend on the dashboard
 * tree. If these drift from the dashboard labels it's only a wording
 * difference in the disclaimer copy, not a functional bug.
 */
const BACKEND_DISPLAY_LABELS: Record<BackendId, string> = {
  claude: "Claude Code",
  codex: "OpenAI Codex",
  gemini: "Gemini CLI",
  opencode: "OpenCode",
};

const searchQuerySchema = z.object({
  q: z.string().min(1).max(500),
  category: z.string().min(1).max(64).optional(),
  tag: z.string().min(1).max(64).optional(),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(SEARCH_LIMIT_MAX)
    .optional(),
});

const termSearchQuerySchema = z.object({
  q: z.string().min(1).max(500),
  category: z.string().min(1).max(64).optional(),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(SEARCH_LIMIT_MAX)
    .optional(),
});

interface TermFtsRow {
  slug: string;
  anchor: string;
  term: string;
  aliases: string;
  summary: string;
  category: string;
  rank: number;
}

interface TermSearchResult {
  slug: string;
  anchor: string | null;
  term: string;
  summary: string;
  category: string;
  /** Pre-formed `[doc:slug#anchor]` (or `[doc:slug]` for doc-level rows). */
  citation: string;
  rank: number;
}

/**
 * `POST /api/docs/qa/messages` body schema. `.strict()` rejects unknown
 * keys (the dashboard QA panel is the only legitimate caller); the
 * 10K content cap is sized for lookups, not free-form chat (§11.5).
 */
const qaMessageSchema = z
  .object({
    channelId: z.string().min(1),
    content: z.string().min(1).max(10_000),
    scope: z.enum(["all", "current", "category"]).default("all"),
    context: z
      .object({
        currentSlug: z.string().optional(),
        dashboardPath: z.string().optional(),
        category: z.string().optional(),
      })
      .optional(),
    // Optional per-turn model override sent by the QA panel's model
    // picker. The dispatcher's `requestedBackendId`/`requestedModelId`
    // hard-override path bypasses the `dashboard.docs_qa` TIER_LOCK,
    // so we must validate light-tier here as defense in depth — a
    // heavy model id arriving from the wire would otherwise drain
    // Opus quota silently.
    modelId: z.string().min(1).max(128).optional(),
  })
  .strict();

interface DocsQABackendRow {
  main_backend: BackendId;
  main_model: string;
}

/**
 * Read the `process_backend_config` row for `dashboard.docs_qa`, if any.
 * Shared between the binding endpoint (which uses both columns) and the
 * POST handler (which only needs the resolved backend for tier validation).
 */
function readDocsQABackendRow(db: Database.Database): DocsQABackendRow | null {
  const row = db
    .prepare(
      `SELECT main_backend, main_model
         FROM process_backend_config
        WHERE process_key = ?`,
    )
    .get("dashboard.docs_qa") as DocsQABackendRow | undefined;
  return row ?? null;
}

/**
 * Resolve the backend the QA panel is bound to, falling back to the
 * global default and then to Claude. Mirrors the binding endpoint's
 * resolution order so the picker's tier validation matches what the
 * dispatcher will actually run on.
 */
function resolveDocsQABackend(
  db: Database.Database,
  row: DocsQABackendRow | null,
): BackendId {
  if (row?.main_backend) return row.main_backend;
  const defaults = db
    .prepare(
      "SELECT default_backend FROM backend_global_defaults WHERE singleton = 1",
    )
    .get() as { default_backend: BackendId } | undefined;
  return defaults?.default_backend ?? "claude";
}

/**
 * Internal dependencies — passed into `createDocsRoutes` separately from
 * `ApiDependencies` because the indexer handle is built late in startup
 * (after the db is open) and the API surface should not couple to its
 * concrete type.
 */
export interface DocsRoutesDependencies {
  db: Database.Database;
  indexer?: DocsIndexerHandle;
  /**
   * Docs QA SSE adapter. When wired (B-7+), `POST /docs/qa/messages`
   * enqueues a docs_qa MessageEvent through it and `GET /docs/qa/stream`
   * registers an SSE client. When absent (early-startup ordering, tests
   * that exercise only the read endpoints) the QA routes return 503.
   */
  docsQAAdapter?: DocsQAAdapter;
}

export function createDocsRoutes(deps: DocsRoutesDependencies): Hono {
  const app = new Hono();
  const { db, indexer, docsQAAdapter } = deps;

  // GET /api/docs — return the doc tree (one row per indexed doc).
  app.get("/docs", (c) => {
    const rows = db
      .prepare(
        `SELECT slug, title, category, section, status, summary
           FROM fts_docs
          ORDER BY category, section, slug`,
      )
      .all() as Array<{
      slug: string;
      title: string;
      category: string;
      section: string;
      status: string;
      summary: string;
    }>;

    const tree: TreeNode[] = rows.map((r) => ({
      slug: r.slug,
      title: r.title,
      category: r.category,
      section: r.section || null,
      status: r.status || null,
      summary: r.summary,
    }));

    return c.json({
      schema_version: 1,
      docs: tree,
      total: tree.length,
    });
  });

  // GET /api/docs/by-slug/:slug{.+} — full doc body + anchors.
  app.get("/docs/by-slug/:slug{.+}", (c) => {
    const slug = c.req.param("slug");
    const row = db
      .prepare(
        `SELECT slug, title, summary, category, section, status, body, anchors,
                tags, process_keys, config_keys, ask_examples, related
           FROM fts_docs WHERE slug = ?`,
      )
      .get(slug) as
      | (Pick<
          FtsRow,
          | "slug" | "title" | "summary" | "category" | "section" | "status"
          | "body" | "anchors" | "tags" | "process_keys" | "config_keys"
          | "ask_examples" | "related"
        >)
      | undefined;
    if (!row) {
      return respondWithAgentError(c, 404, [
        composeIssue("docs.doc_not_found", {
          field: "slug",
          received: slug,
        }),
      ], { legacyFields: { slug } });
    }
    return c.json({
      slug: row.slug,
      frontmatter: {
        slug: row.slug,
        title: row.title,
        category: row.category,
        section: row.section || undefined,
        status: row.status || undefined,
        summary: row.summary,
        tags: parseJsonArrayOrEmpty(row.tags),
        process_keys: parseJsonArrayOrEmpty(row.process_keys),
        config_keys: parseJsonArrayOrEmpty(row.config_keys),
        ask_examples: splitTokens(row.ask_examples),
        related: parseJsonArrayOrEmpty(row.related),
      },
      body: row.body,
      anchors: row.anchors ? row.anchors.split("\n").filter((s) => s.length > 0) : [],
    });
  });

  // GET /api/docs/term-search?q=... — DOCS-QA-SEARCH-PRECISION-PLAN.md §6.4
  //
  // Term-granular subindex hit by the QA skill BEFORE /docs/search. Each
  // result is either the doc-level row (frontmatter aliases/keywords/
  // ask_examples merged into the `aliases` column) or one H2/H3 section
  // row whose `term` is the heading text and `summary` is the section
  // lead-in. The precomputed `citation` field is the only sanctioned
  // form for the agent to emit — the anchor was produced by the same
  // `iterateHeadings` walker that populates `fts_docs.anchors`, so the
  // citation post-processor accepts every value this endpoint returns.
  app.get("/docs/term-search", (c) => {
    const parsed = termSearchQuerySchema.safeParse({
      q: c.req.query("q"),
      category: c.req.query("category"),
      limit: c.req.query("limit"),
    });
    if (!parsed.success) {
      return c.json(
        { error: "validation_error", details: parsed.error.flatten() },
        400,
      );
    }
    const { q, category } = parsed.data;
    const limit = parsed.data.limit ?? SEARCH_LIMIT_DEFAULT;

    const matchExpr = buildMatchExpression(q);
    if (matchExpr === null) {
      return c.json({
        schema_version: 1,
        query: q,
        filters: { category: category ?? null },
        limit,
        total: 0,
        results: [],
      });
    }

    const filters: string[] = ["fts_doc_terms MATCH ?"];
    const args: unknown[] = [matchExpr];
    if (category) {
      filters.push("category = ?");
      args.push(category);
    }
    args.push(limit);

    // BM25 weights mirror the column declaration:
    //   slug=0 anchor=0 term=4.0 aliases=2.0 summary=1.0 category=0
    const rows = db
      .prepare(
        `SELECT slug, anchor, term, aliases, summary, category,
                bm25(fts_doc_terms, 0.0, 0.0, 4.0, 2.0, 1.0, 0.0) AS rank
           FROM fts_doc_terms
          WHERE ${filters.join(" AND ")}
          ORDER BY rank
          LIMIT ?`,
      )
      .all(...args) as TermFtsRow[];

    const results: TermSearchResult[] = rows.map((r) => ({
      slug: r.slug,
      anchor: r.anchor || null,
      term: r.term,
      summary: r.summary,
      category: r.category,
      citation: r.anchor ? `[doc:${r.slug}#${r.anchor}]` : `[doc:${r.slug}]`,
      rank: r.rank,
    }));

    return c.json({
      schema_version: 1,
      query: q,
      filters: { category: category ?? null },
      limit,
      total: results.length,
      results,
    });
  });

  // GET /api/docs/search?q=...
  //
  // DOCS-QA-SEARCH-PRECISION-PLAN.md §7 dispatch: ASCII-only queries
  // route to the unicode61 word index (`fts_docs_word`); CJK / mixed
  // queries route to the trigram substring index (`fts_docs`). Both
  // branches produce the same `DocSearchResult` shape — the JOIN to
  // `fts_docs` on the ASCII branch exists only to fetch result-shape
  // columns (`process_keys`, `config_keys`, `section`, `anchors`) that
  // are deliberately not duplicated on `fts_docs_word`. The MATCH
  // constraint and the `category`/`tag` filters all live on the
  // matched table, so the JOIN is never the constraint surface.
  app.get("/docs/search", (c) => {
    const parsed = searchQuerySchema.safeParse({
      q: c.req.query("q"),
      category: c.req.query("category"),
      tag: c.req.query("tag"),
      limit: c.req.query("limit"),
    });
    if (!parsed.success) {
      return c.json(
        { error: "validation_error", details: parsed.error.flatten() },
        400,
      );
    }

    const { q, category, tag } = parsed.data;
    const limit = parsed.data.limit ?? SEARCH_LIMIT_DEFAULT;

    // Sanitize the user query through the shared FTS5 phrase-quoter so
    // operator characters (`*`, `:`, `OR`, `NEAR/N`, embedded `"`) cannot
    // change the search semantics or trip a syntax error. `null` means
    // the query had no tokens after tokenization — return an empty result
    // shape rather than 400 to keep the contract idempotent.
    const matchExpr = buildMatchExpression(q);
    if (matchExpr === null) {
      return c.json({
        schema_version: 1,
        query: q,
        filters: { category: category ?? null, tag: tag ?? null },
        limit,
        total: 0,
        results: [],
      });
    }

    const useWordIndex = isAsciiOnlyQuery(q);

    // bm25(): one weight per column, in CREATE VIRTUAL TABLE order.
    //   fts_docs_word (9 cols):
    //     slug=0 title=3.0 keywords=2.5 aliases=2.0 summary=1.5
    //     ask_examples=1.2 body=1.0 category=0 tags=0
    //   fts_docs      (15 cols):
    //     slug=0 title=3.0 keywords=2.5 aliases=2.0 summary=1.5
    //     ask_examples=1.2 body=1.0
    //     tags=0 process_keys=0 config_keys=0 category=0 section=0
    //     status=0 anchors=0 related=0
    // UNINDEXED columns contribute nothing to ranking regardless of
    // their weight; the explicit zeros are documentation.
    //
    // The SELECT projects only the columns the response payload uses
    // (see `SearchRow`). The columns that remain on the FTS5 row but
    // are not projected here — `body`, `keywords`, `aliases`,
    // `ask_examples`, `process_keys`, `config_keys` — are still
    // ranked over (the bm25 weights cover the indexed-text columns
    // regardless of SELECT) and remain available via `/docs/by-slug`.
    let sql: string;
    const args: unknown[] = [matchExpr];
    const extraWheres: string[] = [];
    if (useWordIndex) {
      if (category) {
        extraWheres.push("w.category = ?");
        args.push(category);
      }
      if (tag) {
        extraWheres.push("w.tags LIKE ? ESCAPE '#'");
        args.push(buildTagLikePattern(tag));
      }
      args.push(limit);
      sql = `SELECT w.slug, w.title, w.summary, w.tags, w.category,
                    d.section, d.anchors,
                    bm25(fts_docs_word, 0.0, 3.0, 2.5, 2.0, 1.5, 1.2, 1.0, 0.0, 0.0) AS rank
               FROM fts_docs_word AS w
               JOIN fts_docs      AS d ON d.slug = w.slug
              WHERE fts_docs_word MATCH ?
                ${extraWheres.length > 0 ? "AND " + extraWheres.join(" AND ") : ""}
              ORDER BY rank
              LIMIT ?`;
    } else {
      if (category) {
        extraWheres.push("category = ?");
        args.push(category);
      }
      if (tag) {
        extraWheres.push("tags LIKE ? ESCAPE '#'");
        args.push(buildTagLikePattern(tag));
      }
      args.push(limit);
      sql = `SELECT slug, title, summary, tags, category,
                    section, anchors,
                    bm25(fts_docs, 0.0, 3.0, 2.5, 2.0, 1.5, 1.2, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0) AS rank
               FROM fts_docs
              WHERE fts_docs MATCH ?
                ${extraWheres.length > 0 ? "AND " + extraWheres.join(" AND ") : ""}
              ORDER BY rank
              LIMIT ?`;
    }

    const rows = db.prepare(sql).all(...args) as SearchRow[];

    const results: DocSearchResult[] = rows.map((r) => ({
      slug: r.slug,
      title: r.title,
      category: r.category,
      section: r.section,
      summary: r.summary,
      tags: parseJsonArrayOrEmpty(r.tags),
      anchors: r.anchors ? r.anchors.split("\n").filter((s) => s.length > 0) : [],
      rank: r.rank,
    }));

    return c.json({
      schema_version: 1,
      query: q,
      filters: { category: category ?? null, tag: tag ?? null },
      limit,
      total: results.length,
      results,
    });
  });

  // GET /api/docs/health — indexer status.
  app.get("/docs/health", (c) => {
    const rowCount = (db.prepare("SELECT COUNT(*) AS c FROM fts_docs").get() as { c: number }).c;
    const lastIndexedRow = db
      .prepare("SELECT MAX(indexed_at) AS t FROM docs_revisions")
      .get() as { t: string | null } | undefined;
    const handleHealth = indexer?.health() ?? null;
    return c.json({
      schema_version: 1,
      status:
        handleHealth?.status ??
        (rowCount === 0 ? "empty" : "ok"),
      fileCount: handleHealth?.fileCount ?? rowCount,
      errorCount: handleHealth?.errorCount ?? 0,
      lastIndexedAt: handleHealth?.lastIndexedAt ?? lastIndexedRow?.t ?? null,
      errors: handleHealth?.errors ?? [],
    });
  });

  // GET /api/docs/qa/binding — backend / model / plan strings the QA
  // disclaimer renders, plus the light-tier model list the QA panel's
  // model picker uses. Per DOCS_QA_DESIGN.md §9.2 / §10.2 the QA panel
  // tracks `message.dm`'s **backend choice** but always at this
  // ProcessKey's own light tier — even when the operator has pinned
  // `message.dm` (and therefore the cascade's row) to a heavy model.
  //
  // Resolution order (mirrors what the dispatcher will do once B-7 ships):
  //   1. `process_backend_config` row for `dashboard.docs_qa` — written
  //      by the cascade after every `message.dm` write.
  //   2. `backend_global_defaults.default_backend` (pre-cascade fallback;
  //      the row hasn't been materialized yet on a fresh install).
  // Then re-derive the canonical light-tier model on the resolved
  // backend so a heavy operator pin does not surface a heavy model name.
  app.get("/docs/qa/binding", (c) => {
    const row = readDocsQABackendRow(db);
    const backend = resolveDocsQABackend(db, row);

    // Medium-tier clamp: regardless of any operator pin, QA always uses
    // the canonical medium model on this backend. `latestMediumFor`
    // returns the first registered+available medium model; the Claude
    // fallback covers the edge case where no medium model is registered
    // yet.
    // Medium-tier fallback ladder. Behaviour preserved per-backend, with
    // the trailing `""` for non-claude replaced by the canonical
    // per-backend default so opencode/codex/gemini land on a real model
    // when the registry has no live medium model AND the row is empty.
    const mediumModel =
      latestMediumFor(backend) ??
      (backend === "claude"
        ? DEFAULT_CLAUDE_MEDIUM_MODEL
        : row?.main_model ?? defaultMediumModelFor(backend));

    // Medium-tier models the picker offers for this backend. High-tier
    // (Opus etc.) are filtered out so the picker cannot bypass
    // `dashboard.docs_qa`'s TIER_LOCK by routing through `requestedModelId`
    // (a hard override that does NOT consult TIER_LOCK — see
    // backend-router.ts §618).
    const availableModels = getModelsForBackend(backend)
      .filter((m) => m.tier === "medium" && m.available && !m.deprecated)
      .map((m) => ({ modelId: m.modelId, label: m.label }));

    // Picker's initial pick when nothing is persisted in localStorage.
    const defaultModelId = mediumModel;

    const ownerCount = (
      db
        .prepare("SELECT COUNT(*) AS c FROM owner_channels")
        .get() as { c: number }
    ).c;

    return c.json({
      backend,
      backendDisplay: BACKEND_DISPLAY_LABELS[backend],
      modelDisplay: getModelLabel(backend, mediumModel),
      isInstallDefault: ownerCount === 0,
      availableModels,
      defaultModelId,
    });
  });

  // ── POST /api/docs/qa/messages — enqueue a Q&A turn ──
  // SSE-first channelId (D5): the dashboard echoes the channelId minted
  // by the GET /docs/qa/stream first-event. POST does not mint — a
  // freshly-minted UUID could never be `isConnected` and would always
  // 404. The body's `.strict()` schema rejects unknown keys as
  // defense-in-depth (the dashboard QA panel is the only legitimate
  // caller).
  app.post("/docs/qa/messages", async (c) => {
    if (!docsQAAdapter) {
      return respondWithAgentError(c, 503, [
        composeIssue("docs.qa_adapter_unavailable", {
          field: "<server>",
          received: "<not_wired>",
        }),
      ]);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = qaMessageSchema.safeParse(body);
    if (!parsed.success) {
      return respondWithAgentError(c, 400, [
        composeIssue("docs.validation_error", {
          field: "body",
          received: body,
        }),
      ], { legacyFields: { details: parsed.error.flatten() } });
    }
    if (!docsQAAdapter.isConnected(parsed.data.channelId)) {
      logger.warn(
        { channelId: parsed.data.channelId },
        "Docs QA POST rejected — channel not connected",
      );
      return respondWithAgentError(c, 404, [
        composeIssue("docs.channel_not_connected", {
          field: "channelId",
          received: parsed.data.channelId,
        }),
      ]);
    }

    // Validate any picker-supplied modelId against the resolved backend.
    // The dispatcher's (requestedBackendId, requestedModelId) hard override
    // bypasses TIER_LOCK, so the wire is the only enforcement point that
    // keeps a heavy model from quietly draining Opus quota when the QA
    // POST arrives with one. Unregistered ids and wrong-tier ids are both
    // rejected here with explicit error codes.
    let modelOverride: { backendId: BackendId; modelId: string } | null = null;
    if (parsed.data.modelId) {
      const backend = resolveDocsQABackend(db, readDocsQABackendRow(db));
      const registered = findRegisteredModel(backend, parsed.data.modelId);
      if (!registered || !registered.available) {
        return respondWithAgentError(c, 400, [
          composeIssue("docs.model_not_registered", {
            field: "modelId",
            received: parsed.data.modelId,
          }),
        ], { legacyFields: { modelId: parsed.data.modelId } });
      }
      if (registered.tier !== "medium") {
        return respondWithAgentError(c, 400, [
          composeIssue("docs.model_tier_locked", {
            field: "modelId",
            received: parsed.data.modelId,
            expected: "medium-tier model",
          }),
        ], { legacyFields: { modelId: parsed.data.modelId } });
      }
      modelOverride = { backendId: backend, modelId: registered.modelId };
    }

    docsQAAdapter.handleIncomingMessage(
      parsed.data.channelId,
      parsed.data.content,
      {
        scope: parsed.data.scope,
        ...(parsed.data.context ? { contextHint: parsed.data.context } : {}),
        ...(modelOverride ? { modelOverride } : {}),
      },
    );
    // 202 Accepted is HTTP-correct for an async enqueue. Body keeps the
    // chat-route's `{ status: "accepted" }` shape so dashboard hooks can
    // share parsing logic (§11.5).
    c.status(202);
    return c.json({ status: "accepted" });
  });

  // ── GET /api/docs/qa/stream — SSE outbound channel ──
  app.get("/docs/qa/stream", (c) => {
    if (!docsQAAdapter) {
      return respondWithAgentError(c, 503, [
        composeIssue("docs.qa_adapter_unavailable", {
          field: "<server>",
          received: "<not_wired>",
        }),
      ]);
    }
    const adapter = docsQAAdapter;
    return streamSSE(c, async (stream) => {
      const client = {
        async writeSSE(event: string, data: string): Promise<void> {
          await stream.writeSSE({ event, data });
        },
        get closed(): boolean {
          return stream.closed || stream.aborted;
        },
      };
      const channelId = adapter.registerClient(client);
      // Rebind any active docs_qa session to this fresh channelId
      // (DOCS_QA_B7_DESIGN.md §11.14). EventSource auto-reconnect or
      // tab reload both land here. The dispatcher resolves the
      // outbound channelId via `conversation_sessions.channel_id` on
      // every send (`session-manager.ts:getActiveChannelIdForSession`),
      // so the operator's NEXT POST + any chunks the dispatcher emits
      // after this point route to the latest connected tab. Without
      // this rebind the orphan-recovery banner clears `busy` on the
      // client, but a retry POST would still carry the new channelId
      // while the dispatcher kept routing to the dead old one — the
      // retry would orphan too.
      //
      // Scope-keyed UPDATE (not session-id-keyed): there is at most
      // one active docs_qa session per agent-day (single owner,
      // singleton scope_key), so matching by scope is unambiguous and
      // saves the client from having to remember a session id —
      // matching §11.6's stateless framing on the client.
      rebindDocsQASessionChannel(db, channelId);
      stream.onAbort(() => {
        adapter.unregisterClient(channelId);
      });
      // Periodic ping until the client disconnects — same cadence as
      // the chat stream (`sse.ts:188-193`). A 30s gap fits comfortably
      // under typical proxy idle-timeout windows (60s+).
      while (!stream.aborted) {
        await stream.sleep(30_000);
        if (!stream.aborted) {
          await stream.writeSSE({ event: "ping", data: "" }).catch(() => {});
        }
      }
    });
  });

  return app;
}

/**
 * SQLite LIKE pattern that matches a JSON-encoded tag value inside the
 * `tags` array column (`["heavy-tier","core",...]`). The frontmatter
 * tag schema (`packages/shared/src/docs-schema.ts`) does not restrict
 * the character set, so a tag could legitimately contain LIKE wildcards
 * (`%`, `_`) or the JSON quote character (`"`). Without escaping, a
 * filter like `tag=core%` would behave as a wildcard match and silently
 * widen the result set to every doc tagged with anything starting with
 * `core` — an integrity bug, not just a UX bug, because a category +
 * tag filter is the operator's main way to narrow QA scope.
 *
 * Approach: JSON-encode the tag (so `"` becomes `\"`, matching how
 * the indexer stores it via `JSON.stringify(fm.tags)`), wrap the
 * encoded form in `%"..."%`, then escape the LIKE specials. We use
 * `#` as the LIKE escape character because JSON encoding never emits
 * `#`; picking `\\` would force us to double-escape the backslashes
 * JSON itself just inserted. Caller pairs the pattern with `ESCAPE '#'`.
 */
function buildTagLikePattern(tag: string): string {
  // `JSON.stringify("foo\"bar")` returns the 11-byte string
  // `"foo\"bar"` (surrounding quotes plus an escaped inner quote);
  // slice off the framing quotes so we keep only the encoded form.
  const jsonEncoded = JSON.stringify(tag).slice(1, -1);
  // Escape `#` (the LIKE escape char) first so we do not double-escape
  // escapes we are about to insert; then `%` and `_`, the only LIKE
  // wildcards.
  const escaped = jsonEncoded
    .replace(/#/g, "##")
    .replace(/%/g, "#%")
    .replace(/_/g, "#_");
  return `%"${escaped}"%`;
}

function parseJsonArrayOrEmpty(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === "string");
    }
    return [];
  } catch {
    return [];
  }
}

/** Split a `\n`-joined token list (keywords/aliases/ask_examples) back to an array. */
function splitTokens(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw.split("\n").filter((s) => s.length > 0);
}

/**
 * Rebind the active docs_qa session's `channel_id` to the SSE
 * connection that just opened. See `DOCS_QA_B7_DESIGN.md` §11.14 for
 * the orphan-recovery contract this delivers.
 *
 * Matches at most one row by construction (singleton scope per agent-
 * day). A no-op when no active session exists yet — the very first
 * connect lands here before the user has POSTed anything.
 *
 * Intentionally does NOT touch `last_message_at`: this is a routing
 * update, not a turn-progress signal. Bumping it would push back the
 * 04:00 day-boundary expiry inappropriately when an idle tab is left
 * connected overnight.
 */
function rebindDocsQASessionChannel(
  db: Database.Database,
  newChannelId: string,
): void {
  db.prepare(
    `UPDATE conversation_sessions
        SET channel_id = ?
      WHERE scope = ? AND scope_key = ? AND status = 'active'`,
  ).run(newChannelId, DOCS_QA_SCOPE, DOCS_QA_SCOPE_KEY);
}

/**
 * Convenience binding helper for callers that only have an `ApiDependencies`
 * instance. Equivalent to `createDocsRoutes({ db: deps.db })` but kept as
 * a separate symbol so the call-site in `server.ts` mirrors how the rest
 * of the routes are mounted.
 */
export function createDocsRoutesFromDeps(
  deps: Pick<ApiDependencies, "db">,
  extra: { indexer?: DocsIndexerHandle; docsQAAdapter?: DocsQAAdapter } = {},
): Hono {
  return createDocsRoutes({ db: deps.db, ...extra });
}
