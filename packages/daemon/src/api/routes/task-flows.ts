/**
 * Task-flow override API (P5 §"User-defined triggers").
 *
 * Each event-type prompt has a bundled MD body under
 * `agent-assets/task-flows/<key>.md`. This route lets the dashboard
 * write a per-key override at `<dataDir>/task-flows/<key>.md` that the
 * `prompts.ts` resolver reads in preference to the bundled file. The
 * lookup order is documented on `getTaskFlow` — user dir wins file-by-file
 * across the same filename layout (`<key>.md` and
 * `<key>.<variant-suffix>.md`), so users can override base flows or
 * specific delegated variants independently.
 *
 * Path safety: the `:key` segment is validated against a strict regex
 * that disallows `/`, `..`, leading dots, and anything outside
 * `[A-Za-z0-9._-]`. Length is capped at 80 characters — the longest
 * bundled key today is ~45 characters
 * (`routine.activity_scan.delegated.gemini`), so 80 leaves comfortable
 * headroom without giving an attacker a path-bomb surface.
 *
 * Risk tier: Approve. The task-flow body is dispatcher prose that the
 * agent uses verbatim — a malicious override could redirect the agent
 * toward harmful outputs even though it cannot widen `disallowedTools`
 * or relax the absolute-block layer. Approve-tier (Bearer required)
 * matches `/api/skills`'s blast radius: arbitrary instructions reach
 * the model, but the safety floor still holds at `disallowedTools` +
 * absolute-block (CLAUDE.md memory-write-chokepoint contract).
 */

import { Hono } from "hono";
import { mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  getUserTaskFlowsDir,
  listTaskFlows,
  readTaskFlowSources,
} from "../../core/prompts.js";
import { createLogger, toSafeErrorMessage } from "../../logging.js";
import { readJsonBody } from "../json-body.js";

const logger = createLogger("task-flows-api");

const KEY_PATTERN = /^[A-Za-z0-9._-]+$/;
const KEY_MAX_LENGTH = 80;
const BODY_MAX_BYTES = 64 * 1024; // 64 KiB — bundled flows are < 8 KiB; cap at 8x

function isValidKey(key: string | undefined): key is string {
  // Hono guarantees a non-empty string from c.req.param when the `:key`
  // segment matched, so the falsy branch is unreachable from the route
  // handlers below. The check stays as defense-in-depth.
  if (!key) return false; /* c8 ignore next */
  // `key.length === 0` is already covered by the `!key` guard above; this
  // branch only catches the upper-bound (>KEY_MAX_LENGTH) case.
  if (key.length > KEY_MAX_LENGTH) return false;
  if (!KEY_PATTERN.test(key)) return false;
  // Defense-in-depth — KEY_PATTERN already excludes `/`, `..`, and a
  // leading dot, but assert explicitly so a future regex relax can't
  // silently widen the path-traversal surface.
  if (key.includes("..") || key.startsWith(".") || key.includes("/")) return false;
  return true;
}

export function createTaskFlowsRoutes(): Hono {
  const app = new Hono();

  /** GET /api/task-flows — enumerate every known key with override status. */
  app.get("/task-flows", (c) => {
    const userDir = getUserTaskFlowsDir();
    const flows = listTaskFlows();
    return c.json({
      userDir,
      flows,
    });
  });

  /** GET /api/task-flows/:key — read both bundled and override bodies. */
  app.get("/task-flows/:key", (c) => {
    const key = c.req.param("key");
    if (!isValidKey(key)) {
      return c.json({ error: "invalid_key" }, 400);
    }
    const sources = readTaskFlowSources(key);
    if (sources.bundled === null && sources.override === null) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json({
      key,
      bundled: sources.bundled,
      override: sources.override,
      hasOverride: sources.override !== null,
    });
  });

  /**
   * PUT /api/task-flows/:key — write or replace the user override.
   *
   * Body: `{ content: string }`. Empty content is allowed (an empty
   * override stops the agent from reading the bundled body, which is
   * usually a misconfig — but explicit is fine, the dashboard can warn).
   * Use DELETE to fully revert to bundled.
   *
   * The handler creates `<dataDir>/task-flows/` with mode 0700 lazily —
   * no separate "init the directory" call. Idempotent.
   */
  app.put("/task-flows/:key", async (c) => {
    const key = c.req.param("key");
    if (!isValidKey(key)) {
      return c.json({ error: "invalid_key" }, 400);
    }
    const userDir = getUserTaskFlowsDir();
    if (!userDir) {
      return c.json({ error: "task_flow_overrides_unavailable" }, 503);
    }
    const parsed = await readJsonBody(c, { maxBytes: BODY_MAX_BYTES });
    if (!parsed.ok) return parsed.response;
    const body = parsed.body as { content?: unknown };
    if (typeof body.content !== "string") {
      return c.json({ error: "content_required" }, 400);
    }
    const filePath = join(userDir, `${key}.md`);
    try {
      mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
      writeFileSync(filePath, body.content, { encoding: "utf-8", mode: 0o600 });
      logger.info({ key }, "Task-flow override written");
      return c.json({ ok: true, key, bytes: Buffer.byteLength(body.content, "utf-8") });
    } catch (err) {
      logger.error({ key, err }, "Failed to write task-flow override");
      return c.json({ error: "write_failed", message: toSafeErrorMessage(err) }, 500);
    }
  });

  /** DELETE /api/task-flows/:key — remove the user override and fall back. */
  app.delete("/task-flows/:key", (c) => {
    const key = c.req.param("key");
    if (!isValidKey(key)) {
      return c.json({ error: "invalid_key" }, 400);
    }
    const userDir = getUserTaskFlowsDir();
    if (!userDir) {
      return c.json({ error: "task_flow_overrides_unavailable" }, 503);
    }
    const filePath = join(userDir, `${key}.md`);
    try {
      // existsSync + unlinkSync would race; just attempt the unlink and
      // treat ENOENT as success (matches keychain delete semantics).
      try {
        statSync(filePath);
      } catch {
        return c.json({ ok: true, key, removed: false });
      }
      unlinkSync(filePath);
      logger.info({ key }, "Task-flow override removed");
      return c.json({ ok: true, key, removed: true });
    } catch (err) {
      logger.error({ key, err }, "Failed to delete task-flow override");
      return c.json({ error: "delete_failed", message: toSafeErrorMessage(err) }, 500);
    }
  });

  return app;
}
