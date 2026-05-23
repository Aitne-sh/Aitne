/**
 * screenshotPage workflow — Phase B-2 read-only.
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §8.8.3.
 *
 * Navigate to a URL and capture either a viewport-sized or full-page
 * screenshot. Returns the API-served path the dashboard renders.
 *
 * The output schema's `screenshotPath` regex matches the
 * `trace-store-paths.ts:apiPathForTraceFile` shape exactly — any drift
 * would silently break the dashboard's <img src=…> rendering. Per-
 * route static-file serving validates a corresponding path
 * (`resolveTraceFilePath`) which has its own coverage.
 *
 * Excluded from coverage — Playwright I/O.
 */

import { z } from "zod";

import { RiskTier } from "../../../../safety/risk-classifier.js";
import type { WorkflowDefinition } from "../types.js";

const inputSchema = z.object({
  url: z.string().url().max(2048),
  viewport: z.enum(["desktop", "mobile"]).default("desktop"),
  fullPage: z.boolean().default(false),
});

const outputSchema = z.object({
  url: z.string().url(),
  screenshotPath: z
    .string()
    .regex(/^\/api\/browser-automation\/traces\/[a-f0-9-]+\/[a-z0-9._-]+\.png$/),
  capturedAt: z.string().datetime(),
  viewport: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
});

const DESKTOP_VIEWPORT = { width: 1280, height: 800 };
const MOBILE_VIEWPORT = { width: 390, height: 844 };

export const screenshotPage: WorkflowDefinition<
  z.infer<typeof inputSchema>,
  z.infer<typeof outputSchema>
> = {
  name: "screenshotPage",
  inputSchema,
  outputSchema,
  allowlistRegex: /^https?:\/\/[^\s/]+\//,
  riskTier: RiskTier.Autonomous,
  perWorkflowTimeoutMs: 20_000,
  variant: "anon",
  async run({ params, playwrightContext, screenshotSink }) {
    const ctx = playwrightContext as {
      newPage: () => Promise<unknown>;
    };
    const page = (await ctx.newPage()) as {
      setViewportSize: (size: { width: number; height: number }) => Promise<unknown>;
      goto: (
        url: string,
        opts: { waitUntil: "domcontentloaded"; timeout: number },
      ) => Promise<unknown>;
      close: () => Promise<void>;
    };
    try {
      const viewport =
        params.viewport === "mobile" ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT;
      await page.setViewportSize(viewport);
      await page.goto(params.url, {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });
      const screenshotPath = await screenshotSink.capture("primary", page);
      return {
        url: params.url,
        screenshotPath,
        capturedAt: new Date().toISOString(),
        viewport,
      };
    } finally {
      await page.close().catch(() => {});
    }
  },
};
