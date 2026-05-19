import { Hono } from "hono";
import { existsSync } from "node:fs";
import type { ObsidianService } from "../../services/obsidian.js";
import type { AgentWriteTracker } from "../../safety/agent-write-tracker.js";
import { createLogger, toSafeErrorMessage } from "../../logging.js";
import { readJsonBody } from "../json-body.js";
import { composeIssue, respondWithAgentError } from "../helpers/agent-errors.js";

const logger = createLogger("obsidian-api");

export interface ObsidianRouteDependencies {
  obsidianService: ObsidianService | null;
  /**
   * Optional shared tracker. When present, every write endpoint pre-marks
   * the target vault file so the obsidian-watcher attributes the resulting
   * chokidar event to `actor='agent'` (and hourly_check's `?actor=user`
   * filter excludes it). Without this the agent can observe its own
   * Obsidian writes and loop.
   */
  writeTracker?: AgentWriteTracker;
}

/**
 * Obsidian API routes — proxies to the Obsidian CLI via ObsidianService.
 *
 * These routes target the **external** Obsidian vault the user maintains
 * alongside this app (configured via `externalObsidianVaultPath`/`Name`),
 * NOT the agent's primary management store. Primary-store reads and
 * writes live under `/api/context/*` and must never be routed here.
 *
 * GET    /obsidian/status       — external vault availability
 * GET    /obsidian/search       — search external vault
 * GET    /obsidian/notes/:path  — read a note from the external vault
 * POST   /obsidian/notes        — create a note (fails if it exists)
 * PUT    /obsidian/notes/:path  — create or overwrite a note (idempotent edit)
 * PATCH  /obsidian/notes        — append to a note
 * DELETE /obsidian/notes/:path  — delete a note (trash by default)
 * PATCH  /obsidian/daily        — append to the daily note
 */
/** Validate note name/file path: reject traversal and unsafe characters */
function isValidNotePath(p: string): boolean {
  if (!p || p.length > 500) return false;
  // Reject path traversal and absolute paths
  if (/\.\./.test(p) || /^[/\\]/.test(p)) return false;
  // Allow word chars, spaces, hyphens, dots, forward slashes (for subdirs), CJK
  if (!/^[\w\s\-./\u3000-\u9FFF\uF900-\uFAFF]+$/.test(p)) return false;
  return true;
}

export function createObsidianRoutes(deps: ObsidianRouteDependencies): Hono {
  const app = new Hono();
  const { obsidianService, writeTracker } = deps;

  /**
   * Per-route write mutex. Every Obsidian write (POST/PUT/PATCH/DELETE)
   * runs through this lock so two concurrent requests to the same (or
   * different) note serialize at the daemon boundary. The Obsidian CLI
   * itself has no documented concurrency guarantees, and simultaneous
   * `create … overwrite` calls could race with a user edit in the
   * Obsidian UI. Serializing here also keeps `markAgentWrite` →
   * `service.xxx` ordered so the write tracker's TTL window covers the
   * actual file system event.
   */
  let writeLock: Promise<void> = Promise.resolve();
  function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = writeLock;
    let release: () => void;
    writeLock = new Promise<void>((r) => {
      release = r;
    });
    return prev.then(async () => {
      try {
        return await fn();
      /* v8 ignore next */
      } finally {
        release!();
      }
    });
  }

  /**
   * Mark a vault note as an agent-originated write so the obsidian-watcher
   * observer attributes the resulting chokidar event to `actor='agent'`.
   * Uses path-only marking (no content hash) because append-style writes
   * don't let the route handler pre-compute the full post-write content.
   */
  function markAgentWrite(noteName: string): void {
    if (!writeTracker || !obsidianService) return;
    const absolute = obsidianService.resolveNotePath(noteName);
    if (absolute) writeTracker.markWriting(absolute);
  }

  // GET /obsidian/status — check if the external Obsidian vault is available.
  // `vaultType: "external"` is an additive marker so consumers can tell this
  // apart from the agent's primary management vault at a glance. `statusLabel`
  // is a human-readable phrasing matching the Management Mode redesign plan
  // ("external Obsidian vault: configured/not configured"). Existing clients
  // that only read `available` / `vaultName` / `obsidianRunning` keep working
  // unchanged.
  app.get("/obsidian/status", async (c) => {
    if (!obsidianService?.available) {
      return c.json({
        available: false,
        vaultName: null,
        obsidianRunning: false,
        vaultType: "external" as const,
        statusLabel: "external Obsidian vault: not configured",
      });
    }

    const running = await obsidianService.isRunning();
    return c.json({
      available: true,
      vaultName: obsidianService.vault,
      obsidianRunning: running,
      vaultType: "external" as const,
      statusLabel: "external Obsidian vault: configured",
    });
  });

  // GET /obsidian/notes/* — read a specific note's content
  app.get("/obsidian/notes/*", async (c) => {
    if (!obsidianService?.available) {
      return respondWithAgentError(c, 503, [
        composeIssue("obsidian.not_configured", {
          field: "externalObsidianVaultPath",
          received: "<unset>",
        }),
      ]);
    }

    // Extract path after /obsidian/notes/
    const filePath = c.req.path.replace(/^.*\/obsidian\/notes\//, "");
    if (!filePath || !isValidNotePath(filePath)) {
      return respondWithAgentError(c, 400, [
        composeIssue("obsidian.invalid_path", {
          field: "path",
          received: filePath,
        }),
      ]);
    }

    try {
      const running = await obsidianService.isRunning();
      if (!running) {
        return respondWithAgentError(c, 503, [
          composeIssue("obsidian.not_running", {
            field: "obsidian.app",
            received: "<not_running>",
          }),
        ]);
      }

      const content = await obsidianService.readNote(filePath);
      return c.json({ content, path: filePath });
    } catch (err) {
      // Obsidian CLI doesn't distinguish "not found" from other read failures,
      // so we collapse all errors to 404 but log for observability.
      logger.warn(
        { err, path: filePath },
        "Obsidian note read failed",
      );
      return respondWithAgentError(c, 404, [
        composeIssue("obsidian.not_found", {
          field: "path",
          received: filePath,
        }),
      ], { legacyFields: { message: toSafeErrorMessage(err) } });
    }
  });

  // GET /obsidian/search — search notes
  app.get("/obsidian/search", async (c) => {
    if (!obsidianService?.available) {
      return respondWithAgentError(c, 503, [
        composeIssue("obsidian.not_configured", {
          field: "externalObsidianVaultPath",
          received: "<unset>",
        }),
      ]);
    }

    const q = c.req.query("q");
    if (!q) {
      return respondWithAgentError(c, 400, [
        composeIssue("obsidian.query_required", {
          field: "q",
          received: "<missing>",
        }),
      ]);
    }

    const limit = Math.min(Number(c.req.query("limit") ?? "10"), 50);

    try {
      const running = await obsidianService.isRunning();
      if (!running) {
        return respondWithAgentError(c, 503, [
          composeIssue("obsidian.not_running", {
            field: "obsidian.app",
            received: "<not_running>",
          }),
        ]);
      }

      const results = await obsidianService.search(q, limit);
      return c.json({ results });
    } catch (err) {
      logger.error({ err }, "Obsidian search failed");
      return respondWithAgentError(c, 502, [
        composeIssue("obsidian.upstream_error", {
          field: "obsidian.cli",
          received: toSafeErrorMessage(err),
        }),
      ], { legacyFields: { message: toSafeErrorMessage(err) } });
    }
  });

  // POST /obsidian/notes — create a new note
  app.post("/obsidian/notes", async (c) => {
    if (!obsidianService?.available) {
      return respondWithAgentError(c, 503, [
        composeIssue("obsidian.not_configured", {
          field: "externalObsidianVaultPath",
          received: "<unset>",
        }),
      ]);
    }

    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const { name, content } = parsedBody.body as { name?: string; content?: string };

    if (!name || !content) {
      return respondWithAgentError(c, 400, [
        composeIssue("obsidian.name_and_content_required", {
          field: "body",
          received: { name: name ?? "<missing>", content: content ? "<set>" : "<missing>" },
        }),
      ]);
    }
    if (!isValidNotePath(name)) {
      return respondWithAgentError(c, 400, [
        composeIssue("obsidian.invalid_note_name", {
          field: "name",
          received: name,
        }),
      ]);
    }

    return withWriteLock(async () => {
      try {
        const running = await obsidianService.isRunning();
        if (!running) {
          return respondWithAgentError(c, 503, [
          composeIssue("obsidian.not_running", {
            field: "obsidian.app",
            received: "<not_running>",
          }),
        ]);
        }

        markAgentWrite(name);
        await obsidianService.createNote(name, content);
        return c.json({ status: "created", name });
      } catch (err) {
        logger.error({ err }, "Obsidian create note failed");
        return respondWithAgentError(c, 502, [
        composeIssue("obsidian.upstream_error", {
          field: "obsidian.cli",
          received: toSafeErrorMessage(err),
        }),
      ], { legacyFields: { message: toSafeErrorMessage(err) } });
      }
    });
  });

  // PUT /obsidian/notes/* — create or overwrite a note (idempotent edit)
  app.put("/obsidian/notes/*", async (c) => {
    if (!obsidianService?.available) {
      return respondWithAgentError(c, 503, [
        composeIssue("obsidian.not_configured", {
          field: "externalObsidianVaultPath",
          received: "<unset>",
        }),
      ]);
    }

    const filePath = c.req.path.replace(/^.*\/obsidian\/notes\//, "");
    if (!filePath || !isValidNotePath(filePath)) {
      return respondWithAgentError(c, 400, [
        composeIssue("obsidian.invalid_path", {
          field: "path",
          received: filePath,
        }),
      ]);
    }

    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const { content } = parsedBody.body as { content?: string };
    if (typeof content !== "string") {
      return respondWithAgentError(c, 400, [
        composeIssue("obsidian.content_required", {
          field: "content",
          received: content === undefined ? "<missing>" : typeof content,
        }),
      ]);
    }

    return withWriteLock(async () => {
      try {
        const running = await obsidianService.isRunning();
        if (!running) {
          return respondWithAgentError(c, 503, [
          composeIssue("obsidian.not_running", {
            field: "obsidian.app",
            received: "<not_running>",
          }),
        ]);
        }

        markAgentWrite(filePath);
        await obsidianService.updateNote(filePath, content);
        return c.json({ status: "updated", path: filePath });
      } catch (err) {
        logger.error({ err }, "Obsidian update note failed");
        return respondWithAgentError(c, 502, [
        composeIssue("obsidian.upstream_error", {
          field: "obsidian.cli",
          received: toSafeErrorMessage(err),
        }),
      ], { legacyFields: { message: toSafeErrorMessage(err) } });
      }
    });
  });

  // DELETE /obsidian/notes/* — delete a note (trash by default)
  app.delete("/obsidian/notes/*", async (c) => {
    if (!obsidianService?.available) {
      return respondWithAgentError(c, 503, [
        composeIssue("obsidian.not_configured", {
          field: "externalObsidianVaultPath",
          received: "<unset>",
        }),
      ]);
    }

    const filePath = c.req.path.replace(/^.*\/obsidian\/notes\//, "");
    if (!filePath || !isValidNotePath(filePath)) {
      return respondWithAgentError(c, 400, [
        composeIssue("obsidian.invalid_path", {
          field: "path",
          received: filePath,
        }),
      ]);
    }

    // Default to trash (recoverable). Opt in to permanent deletion via
    // ?permanent=true — irreversible, so require an explicit query flag.
    const permanent = c.req.query("permanent") === "true";

    return withWriteLock(async () => {
      try {
        const running = await obsidianService.isRunning();
        if (!running) {
          return respondWithAgentError(c, 503, [
          composeIssue("obsidian.not_running", {
            field: "obsidian.app",
            received: "<not_running>",
          }),
        ]);
        }

        // Pre-check existence on disk so we can return an idempotent 404
        // rather than propagating an opaque CLI error as 502. The
        // Obsidian CLI doesn't surface a distinguishable "not found"
        // signal, so checking the resolved absolute path is the
        // cleanest way to honor REST DELETE semantics. `resolveNotePath`
        // returns `null` only when the vault path is unconfigured — in
        // which case we already bailed at the `available` check above.
        const absolute = obsidianService.resolveNotePath(filePath);
        if (absolute && !existsSync(absolute)) {
          return respondWithAgentError(c, 404, [
            composeIssue("obsidian.not_found", {
              field: "path",
              received: filePath,
            }),
          ], { legacyFields: { path: filePath } });
        }

        markAgentWrite(filePath);
        await obsidianService.deleteNote(filePath, permanent);
        return c.json({ status: "deleted", path: filePath, permanent });
      } catch (err) {
        logger.error({ err }, "Obsidian delete note failed");
        return respondWithAgentError(c, 502, [
        composeIssue("obsidian.upstream_error", {
          field: "obsidian.cli",
          received: toSafeErrorMessage(err),
        }),
      ], { legacyFields: { message: toSafeErrorMessage(err) } });
      }
    });
  });

  // PATCH /obsidian/notes — append to an existing note
  app.patch("/obsidian/notes", async (c) => {
    if (!obsidianService?.available) {
      return respondWithAgentError(c, 503, [
        composeIssue("obsidian.not_configured", {
          field: "externalObsidianVaultPath",
          received: "<unset>",
        }),
      ]);
    }

    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const { file, content } = parsedBody.body as { file?: string; content?: string };

    if (!file || !content) {
      return respondWithAgentError(c, 400, [
        composeIssue("obsidian.file_and_content_required", {
          field: "body",
          received: { file: file ?? "<missing>", content: content ? "<set>" : "<missing>" },
        }),
      ]);
    }
    if (!isValidNotePath(file)) {
      return respondWithAgentError(c, 400, [
        composeIssue("obsidian.invalid_path", {
          field: "file",
          received: file,
        }),
      ]);
    }

    return withWriteLock(async () => {
      try {
        const running = await obsidianService.isRunning();
        if (!running) {
          return respondWithAgentError(c, 503, [
          composeIssue("obsidian.not_running", {
            field: "obsidian.app",
            received: "<not_running>",
          }),
        ]);
        }

        markAgentWrite(file);
        await obsidianService.appendToNote(file, content);
        return c.json({ status: "appended" });
      } catch (err) {
        logger.error({ err }, "Obsidian append failed");
        return respondWithAgentError(c, 502, [
        composeIssue("obsidian.upstream_error", {
          field: "obsidian.cli",
          received: toSafeErrorMessage(err),
        }),
      ], { legacyFields: { message: toSafeErrorMessage(err) } });
      }
    });
  });

  // PATCH /obsidian/daily — append to daily note
  app.patch("/obsidian/daily", async (c) => {
    if (!obsidianService?.available) {
      return respondWithAgentError(c, 503, [
        composeIssue("obsidian.not_configured", {
          field: "externalObsidianVaultPath",
          received: "<unset>",
        }),
      ]);
    }

    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const { content } = parsedBody.body as { content?: string };

    if (!content) {
      return respondWithAgentError(c, 400, [
        composeIssue("obsidian.content_required", {
          field: "content",
          received: content === undefined ? "<missing>" : "<empty>",
        }),
      ]);
    }

    return withWriteLock(async () => {
      try {
        const running = await obsidianService.isRunning();
        if (!running) {
          return respondWithAgentError(c, 503, [
          composeIssue("obsidian.not_running", {
            field: "obsidian.app",
            received: "<not_running>",
          }),
        ]);
        }

        // Daily note attribution: Obsidian's daily note convention is typically
        // `YYYY-MM-DD.md`, but the actual folder depends on per-vault settings.
        // We mark the common-case root path as a best-effort hint; if the user
        // customized the daily folder the observer will record actor='user'
        // for this one append. Acceptable trade-off.
        const today = new Date().toISOString().slice(0, 10);
        markAgentWrite(today);
        await obsidianService.appendToDaily(content);
        return c.json({ status: "appended" });
      } catch (err) {
        logger.error({ err }, "Obsidian daily append failed");
        return respondWithAgentError(c, 502, [
        composeIssue("obsidian.upstream_error", {
          field: "obsidian.cli",
          received: toSafeErrorMessage(err),
        }),
      ], { legacyFields: { message: toSafeErrorMessage(err) } });
      }
    });
  });

  return app;
}
