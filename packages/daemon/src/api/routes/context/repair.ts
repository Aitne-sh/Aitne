import type { Hono } from "hono";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomically } from "../../../core/atomic-write.js";
import {
  REPAIRABLE_STUB_TARGETS,
  normalizeRepairStubPath,
} from "../../../core/context-health.js";
import { resolveTemplatesRoot } from "../../../core/skeleton.js";
import { createLogger } from "../../../logging.js";
import {
  composeIssue,
  respondWithAgentError,
} from "../../helpers/agent-errors.js";
import {
  notifyPromptContextChanged,
  shouldRefreshPromptContext,
} from "./permissions.js";
import { normalizeContextPath, safePath } from "./path-resolve.js";
import type { ContextRouteContext } from "./index.js";

const logger = createLogger("context-api");

export function registerRepairRoutes(
  app: Hono,
  ctx: ContextRouteContext,
): void {
  const {
    deps,
    getCurrentContextDir,
    withWriteLock,
    readOptionalJsonBody,
  } = ctx;
  const { config, writeTracker } = deps;

  // POST /context/repair/stub — create a known missing stub from the
  // templates tree. This is intentionally guarded to a small allow-list;
  // it is not an arbitrary file creation endpoint.
  app.post("/context/repair/stub", async (c) => {
    const parsedBody = await readOptionalJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;

    const rawPath = parsedBody.body.path;
    if (typeof rawPath !== "string") {
      return respondWithAgentError(c, 400, [
        composeIssue("context.path_required", {
          field: "path",
          received: typeof rawPath,
        }),
      ], {
        // repair-stub previously returned `error: "validation_error"` for
        // the missing-path branch (not `"path_required"`); preserve that
        // legacy alias so dashboard / older tests don't break.
        legacyErrorCode: "validation_error",
      });
    }

    const normalizedPath = normalizeRepairStubPath(rawPath);
    if (!normalizedPath || !REPAIRABLE_STUB_TARGETS.has(normalizedPath)) {
      return respondWithAgentError(c, 400, [
        composeIssue("context.stub_target_unsupported", {
          field: "path",
          received: { path: rawPath, allowed: Array.from(REPAIRABLE_STUB_TARGETS) },
        }),
      ]);
    }

    const templatesRoot = resolveTemplatesRoot(config.workspaceDir);
    /* c8 ignore next 9 — resolveTemplatesRoot always succeeds via import.meta.url
     * fallback in tests; the 503 branch requires a broken install where the
     * agent-assets directory is absent from every candidate path. */
    if (!templatesRoot) {
      return respondWithAgentError(c, 503, [
        composeIssue("context.template_unavailable", {
          field: "templatesRoot",
          received: "<unresolved>",
        }),
      ]);
    }

    const templatePath = join(templatesRoot, normalizedPath);
    if (!existsSync(templatePath)) {
      return respondWithAgentError(c, 404, [
        composeIssue("context.template_not_found", {
          field: "path",
          received: { path: normalizedPath, templatePath },
        }),
      ]);
    }

    const contextDir = getCurrentContextDir();
    const fullPath = safePath(contextDir, normalizedPath);
    if (!fullPath) {
      return respondWithAgentError(c, 400, [
        composeIssue("context.path_invalid", {
          field: "path",
          received: normalizedPath,
        }),
      ]);
    }

    return withWriteLock(() => {
      if (existsSync(fullPath)) {
        const existingStat = statSync(fullPath);
        return c.json({
          status: "exists",
          path: normalizedPath,
          lastModified: existingStat.mtime.toISOString(),
        });
      }

      // Read the template once and write atomically; replaces the
      // previous copyFileSync, which would have silently followed a
      // symlink planted at `fullPath` during the TOCTOU window between
      // safePath validation and the write.
      const content = readFileSync(templatePath, "utf-8");
      // Mark before the rename so FS-watch consumers attribute the
      // resulting event to the agent. Roll back on failure (C2).
      writeTracker?.markWriting(fullPath, content);
      try {
        writeFileAtomically(fullPath, content);
      } catch (writeErr) {
        writeTracker?.unmark(fullPath);
        throw writeErr;
      }
      const normalizedBase = normalizeContextPath(normalizedPath);
      if (shouldRefreshPromptContext(normalizedBase, "PUT")) {
        notifyPromptContextChanged(
          deps,
          normalizedBase,
          `context_repair_stub:${normalizedBase}`,
          { path: normalizedBase, method: "REPAIR" },
        );
      }
      deps.onIndexableContextChange?.(normalizedPath);

      const writtenStat = statSync(fullPath);
      logger.info(
        { path: normalizedPath, templatePath },
        "Context stub repaired from template",
      );
      return c.json({
        status: "created",
        path: normalizedPath,
        lastModified: writtenStat.mtime.toISOString(),
      });
    });
  });
}
