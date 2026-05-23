/**
 * extractNewsArticle workflow — Phase B-2 read-only.
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §8.8.1.
 *
 * Navigate to a URL with Playwright, extract a readability-style
 * article summary (title, byline, published date, lead paragraph,
 * word count, optional key points), capture a post-load screenshot,
 * return the structured shape.
 *
 * Mozilla's Readability library is the canonical extractor, but to
 * keep `playwright-core` the only runtime dep, we run a pure DOM walk
 * inside `page.evaluate()` rather than bundling `@mozilla/readability`.
 * The walk is intentionally simple — when readability quality matters
 * to a future user, a follow-up PR can wire the real library.
 *
 * Excluded from coverage — see the parent rationale; the workflow
 * function calls into Playwright. The input/output schemas + the
 * pure DOM extractor (string in, structured out) live alongside and
 * could be split for a covered peer test if/when readability quality
 * becomes important.
 */

import { z } from "zod";

import { RiskTier } from "../../../../safety/risk-classifier.js";
import type { WorkflowDefinition } from "../types.js";

const inputSchema = z.object({
  url: z.string().url().max(2048),
  maxLeadChars: z.number().int().min(100).max(2000).default(500),
});

const outputSchema = z.object({
  url: z.string().url(),
  title: z.string().max(300).regex(/^[^\n\r]*$/),
  byline: z.string().max(200).regex(/^[^\n\r]*$/).optional(),
  publishedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional(),
  wordCount: z.number().int().nonnegative(),
  leadParagraph: z.object({
    content: z.string().max(2000),
    taggedUntrusted: z.literal(true),
  }),
  keyPoints: z.array(z.string().max(200)).max(5).optional(),
  screenshotPath: z
    .string()
    .regex(/^\/api\/browser-automation\/traces\/[a-f0-9-]+\/[a-z0-9._-]+\.png$/)
    .optional(),
});

export const extractNewsArticle: WorkflowDefinition<
  z.infer<typeof inputSchema>,
  z.infer<typeof outputSchema>
> = {
  name: "extractNewsArticle",
  inputSchema,
  outputSchema,
  // Bound at runtime to the per-domain user allowlist; the workflow
  // accepts any http(s) URL but step 4 of the runner enforces the
  // user's domain opt-in before navigating.
  allowlistRegex: /^https?:\/\/[^\s/]+\//,
  riskTier: RiskTier.Autonomous,
  perWorkflowTimeoutMs: 30_000,
  variant: "anon",
  async run({ params, playwrightContext, screenshotSink }) {
    const ctx = playwrightContext as {
      newPage: () => Promise<unknown>;
    };
    const page = (await ctx.newPage()) as {
      goto: (
        url: string,
        opts: { waitUntil: "domcontentloaded"; timeout: number },
      ) => Promise<unknown>;
      evaluate: <T>(fn: () => T) => Promise<T>;
      close: () => Promise<void>;
    };
    try {
      await page.goto(params.url, {
        waitUntil: "domcontentloaded",
        timeout: 20_000,
      });
      const screenshotPath = await screenshotSink.capture("post-load", page);
      // Inline-doc DOM walk runs inside Chromium's V8 — the function
      // body's `document` reference resolves there. The daemon's tsconfig
      // does not ship the DOM lib (we're a Node server), so we cast via
      // a minimal local interface to satisfy the type-checker without
      // pulling in the full `lib.dom.d.ts`.
      type DomLike = {
        document: {
          querySelector: (sel: string) => DomNodeLike | null;
          body: DomNodeLike | null;
        };
      };
      type DomNodeLike = {
        getAttribute: (name: string) => string | null;
        textContent: string | null;
        querySelectorAll: (sel: string) => ArrayLike<DomNodeLike>;
      };
      const extracted = await page.evaluate(() => {
        const doc = (globalThis as unknown as DomLike).document;
        const titleEl =
          doc.querySelector("meta[property='og:title']") ??
          doc.querySelector("title");
        const title =
          (titleEl?.getAttribute("content") ?? titleEl?.textContent ?? "").trim();
        const byline =
          (
            doc
              .querySelector("meta[name='author']")
              ?.getAttribute("content") ?? ""
          ).trim() || undefined;
        const publishedDate =
          (
            doc
              .querySelector("meta[property='article:published_time']")
              ?.getAttribute("content")
              ?.slice(0, 10) ?? ""
          ) || undefined;
        const article =
          doc.querySelector("article") ??
          doc.querySelector("main") ??
          doc.body;
        const text = article ? (article.textContent ?? "") : "";
        const words = text.split(/\s+/).filter(Boolean);
        const lead = words.slice(0, 200).join(" ");
        const headingsArrLike = article?.querySelectorAll("h2,h3");
        const headings: DomNodeLike[] = [];
        if (headingsArrLike) {
          for (let i = 0; i < headingsArrLike.length; i++) {
            headings.push(headingsArrLike[i]);
          }
        }
        const keyPoints = headings
          .map((h) => (h.textContent ?? "").trim())
          .filter((s) => s.length > 0 && s.length < 200)
          .slice(0, 5);
        return {
          title,
          byline,
          publishedDate,
          wordCount: words.length,
          lead,
          keyPoints,
        };
      });
      // Output-schema regex for `title` / `byline` is `^[^\n\r]*$` —
      // an attacker-controlled `<title>foo\nbar</title>` (or a publisher
      // who put a literal newline in their meta tag) would flip the
      // workflow's outcome to `output_validation_error`. Collapse any
      // CR/LF/TAB inside the extracted strings to a single space BEFORE
      // returning so the validator passes on legitimate pages. The
      // trim/slice was already in the DOM walk; this adds the
      // whitespace-collapse so the final shape satisfies the contract.
      const oneLine = (s: string): string =>
        s.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
      const cleanTitle = oneLine(extracted.title).slice(0, 300);
      const cleanByline = extracted.byline
        ? oneLine(extracted.byline).slice(0, 200)
        : undefined;
      return {
        url: params.url,
        title: cleanTitle,
        ...(cleanByline ? { byline: cleanByline } : {}),
        ...(extracted.publishedDate
          ? { publishedDate: extracted.publishedDate }
          : {}),
        wordCount: extracted.wordCount,
        leadParagraph: {
          content: extracted.lead.slice(0, params.maxLeadChars),
          taggedUntrusted: true as const,
        },
        ...(extracted.keyPoints.length > 0
          ? { keyPoints: extracted.keyPoints.map(oneLine).filter((s) => s.length > 0) }
          : {}),
        screenshotPath,
      };
    } finally {
      await page.close().catch(() => {});
    }
  },
};
