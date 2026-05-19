import type { Hono } from "hono";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { localDateStr } from "@aitne/shared";
import { writeFileAtomically } from "../../../core/atomic-write.js";
import { validateContextContent } from "../../../core/context-validation/index.js";
import { createLogger } from "../../../logging.js";
import {
  composeIssue,
  respondWithAgentError,
} from "../../helpers/agent-errors.js";
import {
  isWriteAllowed,
  notifyPromptContextChanged,
  shouldRefreshPromptContext,
} from "./permissions.js";
import { resolveContextTarget, safePath } from "./path-resolve.js";
import type { ContextRouteContext } from "./index.js";

const logger = createLogger("context-api");

export function registerSnapshotsRoutes(
  app: Hono,
  ctx: ContextRouteContext,
): void {
  const {
    deps,
    getCurrentContextDir,
    morningRoutineLock,
    roadmapWriteLock,
    saveSnapshot,
    withWriteLock,
  } = ctx;
  const { db, writeTracker } = deps;

  // POST /context/archive-today — B-007 §5.9 day rotation.
  // Before Phase 1 this copied today.md to `schedule/YYYY-MM-DD.md`; that
  // mechanical archive has been retired (the synthesized `daily/YYYY-MM-DD.md`
  // is now written by the morning routine). The endpoint is kept as the
  // agent-triggered rotation that renames `today.md → yesterday.md` and
  // returns the previous date so the agent can write the new `today.md`
  // in the same flow.
  app.post("/context/archive-today", (c) => {
    return withWriteLock(() => {
      const contextDir = getCurrentContextDir();
      const todayPath = join(contextDir, "today.md");
      if (!existsSync(todayPath)) {
        return respondWithAgentError(c, 404, [
          composeIssue("context.path_not_found", {
            field: "path",
            received: "today",
          }),
        ]);
      }

      const content = readFileSync(todayPath, "utf-8");
      const dateStr =
        content.match(/^#.*(\d{4}-\d{2}-\d{2})/)?.[1] ??
        localDateStr(new Date());

      const yesterdayPath = join(contextDir, "yesterday.md");
      // Atomic write through O_NOFOLLOW + rename so a symlink swap at
      // `yesterday.md` between request validation and the write cannot
      // redirect the rotation into an attacker-controlled path. The
      // legacy `copyFileSync` would silently follow such a symlink.
      writeFileAtomically(yesterdayPath, content);

      saveSnapshot("today", content, "rotate-to-yesterday", true);

      return c.json({
        status: "archived",
        archivePath: "yesterday.md",
        rotatedFrom: dateStr,
      });
    });
  });

  // POST /context/restore-snapshot/:id — restore a prior md_file_snapshots
  // row back onto disk. The current on-disk file (if any) is snapshotted
  // first so the restore itself is reversible from the Knowledge page.
  app.post("/context/restore-snapshot/:id", (c) => {
    const idRaw = c.req.param("id");
    const id = Number(idRaw);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return respondWithAgentError(c, 400, [
        composeIssue("context.snapshot_id_invalid", {
          field: "id",
          received: idRaw,
        }),
      ]);
    }

    const row = db
      .prepare(
        "SELECT id, file_path, content FROM md_file_snapshots WHERE id = ?",
      )
      .get(id) as { id: number; file_path: string; content: string } | undefined;
    if (!row) {
      return respondWithAgentError(c, 404, [
        composeIssue("context.snapshot_not_found", {
          field: "id",
          received: id,
        }),
      ]);
    }

    const target = resolveContextTarget(row.file_path);
    const path = target.base;
    const contextDir = getCurrentContextDir();
    const fullPath = safePath(contextDir, row.file_path);
    if (!fullPath) {
      return respondWithAgentError(c, 400, [
        composeIssue("context.path_invalid", {
          field: "path",
          received: path,
        }),
      ]);
    }
    if (!isWriteAllowed(path, "PUT") && !isWriteAllowed(path, "PATCH")) {
      logger.warn({ path, method: "RESTORE" }, "Snapshot restore forbidden");
      return respondWithAgentError(c, 403, [
        composeIssue("context.write_forbidden", {
          field: "path",
          received: { path, method: "RESTORE" },
        }),
      ]);
    }
    if (morningRoutineLock.getHolder() && path === "today") {
      const lockId = c.req.header("X-Lock-Id");
      if (!morningRoutineLock.isHeldBy(lockId)) {
        logger.info({ path }, "Snapshot restore rejected — morning routine lock held");
        return respondWithAgentError(c, 409, [
          composeIssue("context.morning_routine_lock_held", {
            field: "X-Lock-Id",
            received: lockId ?? "<missing>",
          }),
        ]);
      }
    }
    if (roadmapWriteLock.getHolder() && path === "roadmap") {
      const lockId = c.req.header("X-Lock-Id");
      if (!roadmapWriteLock.isHeldBy(lockId)) {
        logger.info({ path }, "Snapshot restore rejected — roadmap write lock held");
        return respondWithAgentError(c, 409, [
          composeIssue("context.roadmap_write_lock_held", {
            field: "X-Lock-Id",
            received: lockId ?? "<missing>",
          }),
        ]);
      }
    }

    const contentError = validateContextContent(target, row.content, {
      skipFrontmatterValidation: true,
    });
    if (contentError) {
      return respondWithAgentError(c, contentError.status, [
        composeIssue("context.content_validation_failed", {
          field: contentError.path ?? "content",
          received: contentError.message,
        }),
      ], {
        legacyFields: {
          message: contentError.message,
          path: contentError.path,
        },
      });
    }

    return withWriteLock(() => {
      let backupSnapshotId: number | null = null;
      if (existsSync(fullPath)) {
        const current = readFileSync(fullPath, "utf-8");
        backupSnapshotId = saveSnapshot(path, current, "api_restore_snapshot", true);
      }

      // writeFileAtomically handles parent-dir creation, refuses to
      // follow a symlink at the destination, and renames into place.
      // Mark before the rename so FS-watch consumers attribute the
      // resulting event to the agent. Roll back on failure (C2).
      writeTracker?.markWriting(fullPath, row.content);
      try {
        writeFileAtomically(fullPath, row.content);
      } catch (writeErr) {
        writeTracker?.unmark(fullPath);
        throw writeErr;
      }
      if (shouldRefreshPromptContext(path, "PUT")) {
        notifyPromptContextChanged(
          deps,
          path,
          `context_restore_snapshot:${path}`,
          { path, method: "RESTORE" },
        );
      }
      if (path.startsWith("routines/custom/")) {
        deps.onCustomRoutinesChanged?.();
      }

      const writtenStat = statSync(fullPath);
      logger.info(
        {
          path,
          method: "RESTORE",
          restoredFromSnapshotId: id,
          backupSnapshotId: backupSnapshotId ?? undefined,
        },
        "Context snapshot restored",
      );
      return c.json({
        status: "restored",
        path,
        restoredFromSnapshotId: id,
        backupSnapshotId,
        lastModified: writtenStat.mtime.toISOString(),
      });
    });
  });
}
