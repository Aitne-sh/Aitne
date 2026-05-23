/**
 * getPagePlainText workflow — Phase B-2 read-only.
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §8.8.2.
 *
 * Navigate to a URL, return up to `maxChars` of the rendered page's
 * plain text. Useful for one-shot research lookups where the agent
 * just needs the text content (vs. extractNewsArticle's structured
 * extraction).
 *
 * The plain-text output is marked `taggedUntrusted: true` — the
 * workflow runner wraps it in `<external-content>` tags before the
 * agent sees it. Best-effort secret-pattern redaction runs first
 * (defence in depth — OQ-M8) to scrub JWTs / API keys before they ever
 * land on the agent's surface.
 *
 * Excluded from coverage — Playwright I/O.
 */

import { z } from "zod";

import { RiskTier } from "../../../../safety/risk-classifier.js";
import { redactSecretShapes } from "../external-content.js";
import type { WorkflowDefinition } from "../types.js";

const inputSchema = z.object({
  url: z.string().url().max(2048),
  maxChars: z.number().int().min(100).max(50_000).default(10_000),
});

const outputSchema = z.object({
  url: z.string().url(),
  text: z.object({
    content: z.string().max(50_000),
    taggedUntrusted: z.literal(true),
  }),
  wordCount: z.number().int().nonnegative(),
  charCount: z.number().int().nonnegative(),
});

export const getPagePlainText: WorkflowDefinition<
  z.infer<typeof inputSchema>,
  z.infer<typeof outputSchema>
> = {
  name: "getPagePlainText",
  inputSchema,
  outputSchema,
  allowlistRegex: /^https?:\/\/[^\s/]+\//,
  riskTier: RiskTier.Autonomous,
  perWorkflowTimeoutMs: 20_000,
  variant: "anon",
  async run({ params, playwrightContext }) {
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
        timeout: 15_000,
      });
      // `document.body.innerText` is a Chromium-side reference; the daemon
      // tsconfig has no DOM lib so we cast through a minimal interface.
      const raw = await page.evaluate(() => {
        const doc = (globalThis as unknown as { document: { body: { innerText: string } | null } }).document;
        return doc.body?.innerText ?? "";
      });
      const redacted = redactSecretShapes(raw);
      const truncated = redacted.slice(0, params.maxChars);
      return {
        url: params.url,
        text: {
          content: truncated,
          taggedUntrusted: true as const,
        },
        wordCount: truncated.split(/\s+/).filter(Boolean).length,
        charCount: truncated.length,
      };
    } finally {
      await page.close().catch(() => {});
    }
  },
};
