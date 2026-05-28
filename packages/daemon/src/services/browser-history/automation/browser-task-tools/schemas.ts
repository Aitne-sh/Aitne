/**
 * Zod schemas for the 11 `mcp__aitne-browser__*` tools —
 * BROWSER_TASK_REDESIGN_PLAN.md §5.
 *
 * Pure. No I/O. Each tool's runtime body imports its own schema from
 * here so the tests can assert validation behaviour without booting a
 * Playwright context. The SDK consumes the Zod schema directly via
 * `tool(name, description, schemaObject, handler)` per the
 * `@anthropic-ai/claude-agent-sdk` shape — the schema OBJECT (not the
 * Zod wrapper) is what we pass.
 *
 * §14.9 — `wait_for` MUST NOT carry a JS predicate. The schema below
 * declares `selector`, `urlPattern`, `timeoutMs` only — passing `fn`
 * / `predicate` triggers a Zod "unrecognised key" because we use
 * `.strict()`. A future regression that drops `.strict()` is caught
 * by the peer test.
 *
 * 100% coverage gate.
 */

import { z } from "zod";

import {
  EXTRACT_PER_CALL_DEFAULT_CHARS,
  EXTRACT_PER_CALL_MAX_CHARS,
} from "./extract-cap.js";

/** Selector union shared by `click` / `type`. The runner translates a
 *  `selector` to `page.locator(value)` and `coords` to
 *  `page.mouse.click(x, y)`. Coords are last-resort for canvas / non-
 *  DOM widgets. */
export const selectorOrCoordsSchema = z
  .union([
    z
      .object({
        kind: z.literal("selector"),
        value: z.string().min(1).max(1024),
      })
      .strict(),
    z
      .object({
        kind: z.literal("coords"),
        x: z.number().int().min(0).max(10_000),
        y: z.number().int().min(0).max(10_000),
      })
      .strict(),
  ])
  .describe(
    "Either a CSS / aria selector ({kind:'selector', value:'#submit-btn'}) "
      + "or absolute viewport coordinates ({kind:'coords', x:120, y:340}). "
      + "Selectors are PREFERRED — coords are last-resort for canvas / non-DOM widgets.",
  );

export type SelectorOrCoords = z.infer<typeof selectorOrCoordsSchema>;

// ── 1. navigate ──────────────────────────────────────────────────────────
export const navigateArgsSchema = {
  url: z
    .string()
    .url()
    .max(4096)
    .describe(
      "Absolute URL to navigate to. Rejected when outside the task's effective "
        + "allowlist (returns {ok:false, blockedByAllowlist:true}) or on a "
        + "payment-path pattern (rejected unconditionally).",
    ),
};
export const navigateArgsZod = z.object(navigateArgsSchema).strict();
export type NavigateArgs = z.infer<typeof navigateArgsZod>;

// ── 2. screenshot ────────────────────────────────────────────────────────
export const screenshotArgsSchema = {
  fullPage: z
    .boolean()
    .optional()
    .describe(
      "When true, capture the full scrollable height. Default false — viewport only.",
    ),
};
export const screenshotArgsZod = z.object(screenshotArgsSchema).strict();
export type ScreenshotArgs = z.infer<typeof screenshotArgsZod>;

// ── 3. dom_snapshot ──────────────────────────────────────────────────────
export const domSnapshotArgsSchema = {
  maxNodes: z
    .number()
    .int()
    .min(1)
    .max(5000)
    .optional()
    .describe(
      "Cap on aria-tree node count. Default 1500 — large enough for most pages, "
        + "small enough that the truncated serialisation stays under 32 KB.",
    ),
};
export const domSnapshotArgsZod = z.object(domSnapshotArgsSchema).strict();
export type DomSnapshotArgs = z.infer<typeof domSnapshotArgsZod>;

// ── 4. click ────────────────────────────────────────────────────────────
export const clickArgsSchema = {
  target: selectorOrCoordsSchema,
};
export const clickArgsZod = z.object(clickArgsSchema).strict();
export type ClickArgs = z.infer<typeof clickArgsZod>;

// ── 5. type ──────────────────────────────────────────────────────────────
export const typeArgsSchema = {
  target: selectorOrCoordsSchema,
  text: z
    .string()
    .max(8192)
    .describe(
      "Text to type into the target. Capped at 8 KB — long-form composition "
        + "should be split into multiple calls.",
    ),
  replaceExisting: z
    .boolean()
    .optional()
    .describe(
      "When true, clear the field before typing (page.fill). Default false — "
        + "appends keystrokes (page.type).",
    ),
};
export const typeArgsZod = z.object(typeArgsSchema).strict();
export type TypeArgs = z.infer<typeof typeArgsZod>;

// ── 6. press_key ─────────────────────────────────────────────────────────
/** Allowlisted set of keys — narrow on purpose. The runner forwards
 *  the literal string to `page.keyboard.press(...)`. */
export const PRESS_KEY_ALLOWED = [
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
] as const;
export type PressKeyName = (typeof PRESS_KEY_ALLOWED)[number];

export const pressKeyArgsSchema = {
  key: z
    .enum(PRESS_KEY_ALLOWED)
    .describe(
      "Key name. Closed set — arbitrary key codes are not allowed; if the "
        + "site requires a key outside this set, use a different interaction.",
    ),
};
export const pressKeyArgsZod = z.object(pressKeyArgsSchema).strict();
export type PressKeyArgs = z.infer<typeof pressKeyArgsZod>;

// ── 7. wait_for ──────────────────────────────────────────────────────────
// §14.9 — no JS predicate. The shape below declares selector /
// urlPattern / timeoutMs only. `.strict()` rejects `fn` / `predicate`
// / `evaluate` keys with a clear "unrecognised key" error.
export const waitForArgsSchema = {
  selector: z
    .string()
    .min(1)
    .max(1024)
    .optional()
    .describe("CSS / aria selector to wait for (visible)."),
  urlPattern: z
    .string()
    .min(1)
    .max(1024)
    .optional()
    .describe(
      "Glob or regex string to wait for the page URL to match. "
        + "Forwarded to Playwright page.waitForURL.",
    ),
  timeoutMs: z
    .number()
    .int()
    .min(100)
    .max(30_000)
    .optional()
    .describe("Wall-clock timeout (default 10 000). Returns {matched:false} on timeout."),
};
export const waitForArgsZod = z
  .object(waitForArgsSchema)
  .strict()
  .refine(
    (v) => v.selector !== undefined || v.urlPattern !== undefined || v.timeoutMs !== undefined,
    {
      message: "wait_for requires at least one of: selector, urlPattern, timeoutMs",
    },
  );
export type WaitForArgs = z.infer<typeof waitForArgsZod>;

// ── 8. extract ───────────────────────────────────────────────────────────
export const extractArgsSchema = {
  selector: z
    .string()
    .min(1)
    .max(1024)
    .optional()
    .describe(
      "CSS / aria selector scoping the extract. Omit for full-page innerText.",
    ),
  queryHint: z
    .string()
    .min(1)
    .max(512)
    .describe(
      "Short natural-language description of WHAT you want to read. Surfaced in "
        + "the audit row so a triager can tell `extract` calls apart.",
    ),
  maxChars: z
    .number()
    .int()
    .min(1)
    .max(EXTRACT_PER_CALL_MAX_CHARS)
    .optional()
    .describe(
      `Per-call cap. Default ${EXTRACT_PER_CALL_DEFAULT_CHARS}, max ${EXTRACT_PER_CALL_MAX_CHARS}.`,
    ),
};
export const extractArgsZod = z.object(extractArgsSchema).strict();
export type ExtractArgs = z.infer<typeof extractArgsZod>;

// ── 9. ask_user ──────────────────────────────────────────────────────────
export const askUserArgsSchema = {
  question: z
    .string()
    .min(1)
    .max(512)
    .describe("One-sentence question the user should answer."),
  contextSummary: z
    .string()
    .min(1)
    .max(2048)
    .describe(
      "Short statement of where you are and what options you can pick from — "
        + "displayed under the question in DM.",
    ),
  screenshotKey: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe(
      "Relative filename returned by a prior `screenshot` call. The runner "
        + "attaches the image to the DM.",
    ),
};
export const askUserArgsZod = z.object(askUserArgsSchema).strict();
export type AskUserArgs = z.infer<typeof askUserArgsZod>;

// ── 10. yield_for_clarification ──────────────────────────────────────────
export const yieldForClarificationArgsSchema = {
  clarificationId: z
    .string()
    .uuid()
    .describe("Identifier returned by the prior `ask_user` call."),
};
export const yieldForClarificationArgsZod = z
  .object(yieldForClarificationArgsSchema)
  .strict();
export type YieldForClarificationArgs = z.infer<
  typeof yieldForClarificationArgsZod
>;

// ── 11. finish ───────────────────────────────────────────────────────────
export const finishArgsSchema = {
  report: z
    .string()
    .min(1)
    .max(8192)
    .describe(
      "Markdown summary the user reads in DM. State what you did, what the "
        + "outcome was, and link any captured screenshots by key.",
    ),
  screenshotKeys: z
    .array(z.string().min(1).max(256))
    .max(50)
    .describe(
      "Ordered list of screenshot filenames the user should review. Empty "
        + "list is acceptable when the report stands alone.",
    ),
};
export const finishArgsZod = z.object(finishArgsSchema).strict();
export type FinishArgs = z.infer<typeof finishArgsZod>;

/** Tool-name catalogue. Exported so the runner's `allowedToolsOverride`
 *  list and the agent profile cross-reference cannot drift. */
export const BROWSER_TASK_TOOL_NAMES = [
  "navigate",
  "screenshot",
  "dom_snapshot",
  "click",
  "type",
  "press_key",
  "wait_for",
  "extract",
  "ask_user",
  "yield_for_clarification",
  "finish",
] as const;
export type BrowserTaskToolName = (typeof BROWSER_TASK_TOOL_NAMES)[number];

/** MCP server name (matches §5: `aitne-browser`). Tools surface as
 *  `mcp__aitne-browser__<name>` per the SDK convention. */
export const BROWSER_TASK_MCP_SERVER_NAME = "aitne-browser";

/** Fully-qualified tool name builder. Mirrors
 *  `sdk-observations-server.ts:OBSERVATIONS_MCP_TOOL_NAME`. */
export function browserTaskToolFqn(name: BrowserTaskToolName): string {
  return `mcp__${BROWSER_TASK_MCP_SERVER_NAME}__${name}`;
}

/** The full set of FQ tool names — `allowedToolsOverride` for the
 *  sub-agent's SDK session pins exactly this list. */
export const BROWSER_TASK_TOOL_FQNS: readonly string[] =
  BROWSER_TASK_TOOL_NAMES.map((n) => browserTaskToolFqn(n));
