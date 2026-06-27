import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  docsFrontmatterSchema,
  parseFrontmatter,
} from "@aitne/shared";
import { docIdForPath, PAGE_DOC_MAP } from "./page-doc-map";

function search(params: Record<string, string> = {}): URLSearchParams {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) u.set(k, v);
  return u;
}

describe("docIdForPath", () => {
  it("returns the docId for a literal pathname match", () => {
    expect(docIdForPath("/chat", search())).toBe(
      "features/messaging/dashboard-chat",
    );
    expect(docIdForPath("/reading", search())).toBe(
      "features/lifestyle/reading",
    );
  });

  it("matches regex pathnames", () => {
    expect(docIdForPath("/activity", search())).toBe(
      "features/operations/activity-and-conversations",
    );
    expect(docIdForPath("/activity/2026-04-25", search())).toBe(
      "features/operations/activity-and-conversations",
    );
    expect(docIdForPath("/conversations/123", search())).toBe(
      "features/operations/activity-and-conversations",
    );
  });

  it("agents hub: documented built-ins get their routine doc, everything else the hub doc", () => {
    // AGENTS_HUB_REDESIGN_PLAN §4 — the `?` button on /agents pages.
    expect(docIdForPath("/agents", search())).toBe("concepts/routines");
    expect(docIdForPath("/agents/morning-routine", search())).toBe(
      "features/routines/morning-routine",
    );
    // ?tab=rulebook deep link resolves to the same routine doc (covers
    // rulebook + journal-rules editing).
    expect(docIdForPath("/agents/morning-routine", search({ tab: "rulebook" }))).toBe(
      "features/routines/morning-routine",
    );
    expect(docIdForPath("/agents/evening-review", search())).toBe(
      "features/routines/evening-review",
    );
    expect(docIdForPath("/agents/weekly-review", search())).toBe(
      "features/routines/weekly-review",
    );
    expect(docIdForPath("/agents/activity-scan", search())).toBe(
      "features/routines/activity-scan",
    );
    // Undocumented built-ins, user Agents, and sub-pages fall to the hub doc.
    expect(docIdForPath("/agents/monthly-review", search())).toBe("concepts/routines");
    expect(docIdForPath("/agents/my-custom-agent", search())).toBe("concepts/routines");
    expect(docIdForPath("/agents/my-custom-agent/executions", search())).toBe(
      "concepts/routines",
    );
  });

  it("query-qualified entries win over their unqualified twin", () => {
    expect(docIdForPath("/knowledge", search({ tab: "skills" }))).toBe(
      "concepts/skills",
    );
    expect(docIdForPath("/knowledge", search({ tab: "context-files" }))).toBe(
      "concepts/memory-model",
    );
    // Bare /knowledge falls through to the unqualified entry
    expect(docIdForPath("/knowledge", search())).toBe("concepts/memory-model");
  });

  it("specific sub-pages win over their parent catch-all", () => {
    expect(docIdForPath("/connections/repositories", search())).toBe(
      "features/integrations/git",
    );
    expect(docIdForPath("/connections/notes", search())).toBe(
      "features/integrations/obsidian",
    );
    expect(docIdForPath("/connections", search())).toBe(
      "features/messaging/overview",
    );
    expect(docIdForPath("/settings/models", search())).toBe(
      "concepts/backends-and-tiers",
    );
    expect(docIdForPath("/settings/commands", search())).toBe(
      "features/messaging/overview",
    );
    expect(docIdForPath("/settings", search())).toBe("concepts/agent-day");
  });

  it("returns null for /docs (suppression entry)", () => {
    expect(docIdForPath("/docs", search())).toBeNull();
    expect(docIdForPath("/docs/concepts/agent-day", search())).toBeNull();
  });

  it("returns null for unmapped paths", () => {
    expect(docIdForPath("/totally-unknown-route", search())).toBeNull();
  });

  it("query mismatch falls through to next entry", () => {
    // /knowledge?tab=other doesn't match the qualified entries; the bare
    // /knowledge entry catches it.
    expect(docIdForPath("/knowledge", search({ tab: "other" }))).toBe(
      "concepts/memory-model",
    );
  });

  it("setup wizard regex matches /setup and sub-paths", () => {
    expect(docIdForPath("/setup", search())).toBe("guides/setup-wizard");
    expect(docIdForPath("/setup/wizard/step-3", search())).toBe(
      "guides/setup-wizard",
    );
  });
});

/**
 * Invariant 1 (DOCS_QA_DESIGN.md §8.3):
 *   "Every `path` in the map resolves to a non-redirecting Next.js
 *    route (verified by reading dashboard/src/app/**\/page.tsx and
 *    dashboard/src/middleware.ts)."
 *
 * Loading the middleware via dynamic import would pull Next.js runtime
 * deps into the test, so we parse its REDIRECTS map textually. The
 * shape is a literal `Record<string, string>` and is unlikely to
 * change — if it does, this assertion will fail loudly rather than
 * silently rot.
 */
const MIDDLEWARE_PATH = resolve(__dirname, "../../middleware.ts");

function readMiddlewareRedirectKeys(): string[] {
  if (!existsSync(MIDDLEWARE_PATH)) return [];
  const src = readFileSync(MIDDLEWARE_PATH, "utf-8");
  const block = src.match(/REDIRECTS\s*:\s*Record<[^>]+>\s*=\s*\{([\s\S]*?)\}/);
  if (!block) return [];
  const out: string[] = [];
  // Match keys whether quoted with `"` or `'`. Skip lines that look
  // like map values, which begin with a `:`.
  const KEY_RE = /^\s*["']([^"']+)["']\s*:/gm;
  let m: RegExpExecArray | null;
  while ((m = KEY_RE.exec(block[1]!)) !== null) {
    out.push(m[1]!);
  }
  return out;
}

describe("PAGE_DOC_MAP invariant 1 — no literal path collides with a middleware redirect", () => {
  const redirectKeys = readMiddlewareRedirectKeys();

  it("middleware redirect set is reachable from this test", () => {
    // Smoke check — without this, an empty redirect set would pass the
    // collision assertion vacuously and let drift through.
    expect(redirectKeys.length).toBeGreaterThan(0);
  });

  it("no PAGE_DOC_MAP literal path appears in the redirect set", () => {
    const literalPaths = PAGE_DOC_MAP.flatMap((e) =>
      typeof e.match.path === "string" ? [e.match.path] : [],
    );
    const collisions = literalPaths.filter((p) => redirectKeys.includes(p));
    expect(
      collisions,
      `PAGE_DOC_MAP entries point operators at paths that 302-redirect:\n  ${collisions.join("\n  ")}`,
    ).toEqual([]);
  });

  it("no PAGE_DOC_MAP regex matches any redirect key", () => {
    // Regex entries are catch-alls; a regex that matches a redirect
    // key would route the help button to a doc the operator can never
    // actually be on. Stricter than invariant 1 says, but cheap.
    const regexEntries = PAGE_DOC_MAP.filter(
      (e) => typeof e.match.path !== "string",
    ) as Array<{ match: { path: RegExp }; docId: string | null }>;
    const collisions: string[] = [];
    for (const e of regexEntries) {
      // Suppression entries (`docId: null`, e.g. `/^\/docs/`) intentionally
      // catch anything matching the prefix — those don't constitute a
      // bad mapping, since they explicitly hide the help button.
      if (e.docId === null) continue;
      for (const key of redirectKeys) {
        if (e.match.path.test(key)) {
          collisions.push(`${e.match.path} matches redirect key "${key}"`);
        }
      }
    }
    expect(collisions, collisions.join("\n")).toEqual([]);
  });
});

/**
 * Invariant 1 (DOCS_QA_DESIGN.md §8.3, full clause):
 *   "Every `path` in the map resolves to a non-redirecting Next.js
 *    route (verified by reading dashboard/src/app/**\/page.tsx and
 *    dashboard/src/middleware.ts)."
 *
 * The redirect half is covered by the block above. This block covers the
 * route-existence half: every literal `PAGE_DOC_MAP` path must resolve to
 * a real `page.tsx` (literal directory, dynamic segment, or catch-all).
 * Without this test, a doc id can sit in the map pointing at a URL that
 * 404s — the `?` button would silently send the operator nowhere.
 *
 * Layered on top: every regex entry must match at least one literal path
 * served by a page.tsx, OR sample plausible URLs from §8.3 (e.g.
 * `/setup/wizard/step-3`) that we KNOW have to land somewhere.
 */
const APP_DIR = resolve(__dirname, "../../app");

interface Route {
  /** Page.tsx file path (for error messages). */
  file: string;
  /** When set, this page handles exactly one URL (no dynamic segments). */
  literal: string | null;
  /** When set, the regex matches every URL this page can serve. */
  pattern: RegExp | null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function listPageFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && name === "page.tsx") out.push(full);
    }
  };
  walk(dir);
  return out;
}

/**
 * Translate a Next.js page.tsx path into either a literal URL or a
 * pattern. Supports the three dynamic shapes Next.js uses today:
 *   - `[id]` — single dynamic segment
 *   - `[...rest]` — catch-all (one or more segments)
 *   - `[[...rest]]` — optional catch-all (zero or more segments,
 *      i.e. matches the parent route too)
 */
function pageToRoute(file: string): Route {
  // The leading-`/` form `/\/page\.tsx$/` misses `app/page.tsx` (its
  // relative path is just "page.tsx" with no leading slash), so the
  // root route gets mis-classified as a `/page.tsx` segment. Allow the
  // segment separator to be either `/` or start-of-string.
  const rel = relative(APP_DIR, file)
    .replace(/\\/g, "/")
    .replace(/(?:^|\/)page\.tsx$/, "");
  if (rel === "") return { file, literal: "/", pattern: null };
  const segs = rel.split("/");
  const last = segs[segs.length - 1]!;
  const parentSegs = segs.slice(0, -1);
  const parentJoined = parentSegs.length === 0 ? "" : `/${parentSegs.join("/")}`;

  if (last.startsWith("[[...") && last.endsWith("]]")) {
    return {
      file,
      literal: null,
      pattern: new RegExp(`^${escapeRegex(parentJoined === "" ? "/" : parentJoined)}(?:/.+)?$`),
    };
  }
  if (last.startsWith("[...") && last.endsWith("]")) {
    return {
      file,
      literal: null,
      pattern: new RegExp(`^${escapeRegex(parentJoined === "" ? "" : parentJoined)}/.+$`),
    };
  }
  if (rel.includes("[")) {
    // Single dynamic segments (`[id]`) — translate each `[*]` to `/[^/]+`.
    const reBody = segs
      .map((s) =>
        s.startsWith("[") && s.endsWith("]") ? "/[^/]+" : `/${s}`,
      )
      .join("");
    return { file, literal: null, pattern: new RegExp(`^${reBody}$`) };
  }
  return { file, literal: `/${rel}`, pattern: null };
}

function readMiddlewareRedirectKeysSet(): Set<string> {
  return new Set(readMiddlewareRedirectKeys());
}

describe("PAGE_DOC_MAP invariant 1 — every literal map path resolves to a page.tsx", () => {
  const routes = listPageFiles(APP_DIR).map(pageToRoute);
  const literalRoutes = new Set(
    routes.flatMap((r) => (r.literal ? [r.literal] : [])),
  );
  const patternRoutes = routes.filter((r) => r.pattern);
  const redirectKeys = readMiddlewareRedirectKeysSet();

  it("app router scan finds at least one route", () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  it("every literal PAGE_DOC_MAP path matches a non-redirecting page.tsx", () => {
    const orphans: string[] = [];
    for (const e of PAGE_DOC_MAP) {
      if (typeof e.match.path !== "string") continue;
      if (e.docId === null) continue; // suppression entry, route may not exist
      const path = e.match.path;
      if (redirectKeys.has(path)) continue; // already failed by the redirect-collision test
      const literalHit = literalRoutes.has(path);
      const patternHit = patternRoutes.some((r) => r.pattern!.test(path));
      if (!literalHit && !patternHit) {
        orphans.push(`${path} → ${e.docId}`);
      }
    }
    expect(
      orphans,
      `PAGE_DOC_MAP entries point at paths with no page.tsx:\n  ${orphans.join("\n  ")}`,
    ).toEqual([]);
  });

  it("every regex PAGE_DOC_MAP entry matches at least one served URL", () => {
    // Regex entries are catch-alls. We sample candidate URLs derived
    // from the regex source (the leading literal prefix) and assert
    // each candidate resolves to a page. Without this, a typo in a
    // regex (e.g. `/^\/activty/`) would silently make the help button
    // vanish on that page family.
    const failures: string[] = [];
    for (const e of PAGE_DOC_MAP) {
      if (typeof e.match.path === "string") continue;
      if (e.docId === null) continue; // /^\/docs/ suppression — covered separately
      // Strip `^\/` and any optional trailing alternation. We expect
      // the regex to start with `^/<word>` for our entries.
      const m = e.match.path.source.match(/^\^\\\/([\w-]+)/);
      if (!m) {
        failures.push(`regex ${e.match.path} doesn't start with ^/<word> — can't sample`);
        continue;
      }
      const sample = `/${m[1]}`;
      const literalHit = literalRoutes.has(sample);
      const patternHit = patternRoutes.some((r) => r.pattern!.test(sample));
      if (!literalHit && !patternHit) {
        failures.push(
          `regex ${e.match.path} samples to "${sample}" which has no page.tsx`,
        );
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });
});

describe("PAGE_DOC_MAP entry-ordering invariants", () => {
  it("query-qualified /knowledge entries appear before the bare /knowledge entry", () => {
    const idx = (predicate: (e: typeof PAGE_DOC_MAP[number]) => boolean) =>
      PAGE_DOC_MAP.findIndex(predicate);
    const qualified = idx(
      (e) => e.match.path === "/knowledge" && !!e.match.query,
    );
    const bare = idx(
      (e) => e.match.path === "/knowledge" && !e.match.query,
    );
    expect(qualified).toBeGreaterThan(-1);
    expect(bare).toBeGreaterThan(-1);
    expect(qualified).toBeLessThan(bare);
  });

  it("specific /connections sub-page literals appear before the bare /connections entry", () => {
    const subPageIdx = PAGE_DOC_MAP.findIndex(
      (e) => e.match.path === "/connections/repositories",
    );
    const bareIdx = PAGE_DOC_MAP.findIndex(
      (e) => e.match.path === "/connections",
    );
    expect(subPageIdx).toBeLessThan(bareIdx);
  });

  it("/docs suppression entry is last", () => {
    const lastEntry = PAGE_DOC_MAP[PAGE_DOC_MAP.length - 1]!;
    expect(lastEntry.docId).toBeNull();
    expect(lastEntry.match.path).toBeInstanceOf(RegExp);
  });
});

/**
 * Bidirectional consistency check against the committed seed corpus
 * (`agent-assets/docs/`). DOCS_QA_DESIGN.md §8.3 invariant 3 calls for
 * this drift guard; DOCS_QA_DASHBOARD_DESIGN.md §12 explicitly downgrades
 * it to "warning, not failure" so docs can be authored ahead of UI hooks
 * (and vice versa).
 *
 * Hard failure mode: a map entry's docId IS in the corpus, but the doc's
 *   `ui_anchors` does not list the mapped path. That's a real drift —
 *   either the map or the frontmatter is wrong, and one will need fixing.
 *
 * Soft warn modes:
 *   - Map entry's docId is not yet in the corpus (content not yet authored).
 *   - A corpus doc lists a `ui_anchors` path that no map entry references.
 *
 * Repo-relative seed path: 4 levels up from this file
 * (.../packages/dashboard/src/lib/docs → repo root → agent-assets/docs).
 */
const SEED_CORPUS_DIR = resolve(__dirname, "../../../../../agent-assets/docs");

function listSeedMarkdown(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && name.endsWith(".md")) out.push(full);
    }
  };
  walk(root);
  return out;
}

interface ParsedDoc {
  slug: string;
  uiAnchors: string[];
}

/**
 * Parse + Zod-validate frontmatter for the test corpus. Reuses the
 * exact same parser the daemon indexer runs (single source of truth —
 * `packages/shared/src/docs-frontmatter.ts`) so a frontmatter shape
 * change cannot pass the indexer and silently fail this drift guard
 * (or vice versa).
 *
 * Returns null when:
 *   - the file has no `---` frontmatter block, or
 *   - the parser throws (the daemon indexer would log this and skip),
 *     in which case `it("seed corpus is reachable …")` will surface a
 *     short-corpus failure if everything fails.
 *
 * Frontmatter that parses but fails Zod validation throws — that
 * surfaces as a hard failure and is the correct outcome (the doc would
 * never make it into `fts_docs`).
 */
function parseDocFrontmatter(content: string): ParsedDoc | null {
  let parsed;
  try {
    parsed = parseFrontmatter(content);
  } catch {
    return null;
  }
  if (!parsed) return null;
  const validation = docsFrontmatterSchema.safeParse(parsed.values);
  if (!validation.success) {
    throw new Error(
      `Fixture frontmatter failed Zod validation: ${JSON.stringify(
        validation.error.flatten(),
      )}`,
    );
  }
  return {
    slug: validation.data.slug,
    uiAnchors: validation.data.ui_anchors ?? [],
  };
}

describe("PAGE_DOC_MAP bidirectional consistency (seed corpus)", () => {
  const files = listSeedMarkdown(SEED_CORPUS_DIR);
  const docs: ParsedDoc[] = files
    .map((f) => parseDocFrontmatter(readFileSync(f, "utf-8")))
    .filter((d): d is ParsedDoc => d !== null);
  const corpusSlugs = new Set(docs.map((d) => d.slug));
  const docsByslug = new Map(docs.map((d) => [d.slug, d]));

  it("seed corpus is reachable from this test", () => {
    // If this fails, the relative-path constant above is wrong. The other
    // assertions below would silently pass (empty corpus = no checks),
    // which would let drift slip through — anchor a real check here.
    expect(files.length).toBeGreaterThan(0);
  });

  it("every map entry whose docId is in corpus declares the path in ui_anchors", () => {
    const mismatches: string[] = [];
    for (const e of PAGE_DOC_MAP) {
      if (e.docId === null) continue;
      // Only literal pathnames participate — regex entries match many
      // routes and `ui_anchors` is path-by-path, so a 1:1 check would
      // produce noise. Cover the regex case the day a regex entry's
      // docId enters the seed corpus.
      if (typeof e.match.path !== "string") continue;
      if (!corpusSlugs.has(e.docId)) continue;
      const doc = docsByslug.get(e.docId)!;
      if (!doc.uiAnchors.includes(e.match.path)) {
        mismatches.push(
          `map entry { path: "${e.match.path}", docId: "${e.docId}" } — ` +
            `ui_anchors of ${e.docId} are [${doc.uiAnchors.join(", ")}]`,
        );
      }
    }
    expect(mismatches, mismatches.join("\n")).toEqual([]);
  });

  it("logs (does not fail on) docIds not yet in the corpus", () => {
    // Soft check — drift expected while content is being authored. Use
    // expect().toBeDefined() so the assertion line is visible in coverage
    // and the warning surfaces when test output is read.
    const missing = PAGE_DOC_MAP.filter(
      (e): e is typeof e & { docId: string } =>
        e.docId !== null &&
        typeof e.match.path === "string" &&
        !corpusSlugs.has(e.docId),
    ).map((e) => `${e.match.path} → ${e.docId}`);
    if (missing.length > 0) {
      console.warn(
        `[page-doc-map] ${missing.length} mapped docId(s) not yet in seed corpus:\n  ` +
          missing.join("\n  "),
      );
    }
    expect(missing).toBeDefined();
  });

  it("logs (does not fail on) corpus ui_anchors that no map entry references", () => {
    const mappedPaths = new Set(
      PAGE_DOC_MAP.flatMap((e) =>
        typeof e.match.path === "string" ? [e.match.path] : [],
      ),
    );
    const orphans: string[] = [];
    for (const doc of docs) {
      for (const path of doc.uiAnchors) {
        if (!mappedPaths.has(path)) {
          orphans.push(`${relative(SEED_CORPUS_DIR, doc.slug)}.md → ${path}`);
        }
      }
    }
    if (orphans.length > 0) {
      console.warn(
        `[page-doc-map] ${orphans.length} ui_anchors path(s) with no map entry:\n  ` +
          orphans.join("\n  "),
      );
    }
    expect(orphans).toBeDefined();
  });
});
