import type { Hono } from "hono";
import { existsSync, readFileSync } from "node:fs";
import { localDateStr } from "@aitne/shared";
import { serializeContextFileWrite } from "../../../core/context-file-serializer.js";
import { isValidYmd } from "../../../core/roadmap-horizon.js";
import {
  extractRoadmapIds,
  generateRoadmapId,
  RoadmapIdGenerationError,
} from "../../../core/roadmap-ids.js";
import { createLogger } from "../../../logging.js";
import {
  composeIssue,
  respondWithAgentError,
} from "../../helpers/agent-errors.js";
import { safePath } from "./path-resolve.js";
import type { ContextRouteContext } from "./index.js";

const logger = createLogger("context-api");

export function registerLockRoutes(app: Hono, ctx: ContextRouteContext): void {
  const {
    deps,
    morningRoutineLock,
    roadmapWriteLock,
    getCurrentContextDir,
    readOptionalJsonBody,
  } = ctx;
  const { config } = deps;

  // POST /context/lock/morning-routine — Acquire exclusive lock
  app.post("/context/lock/morning-routine", (c) => {
    const result = morningRoutineLock.acquire();
    if (!result.ok) {
      return respondWithAgentError(c, 409, [
        composeIssue("context.lock_held", {
          field: "morningRoutineLock",
          received: { holder: result.holder },
        }),
      ]);
    }
    return c.json({ status: "acquired", lockId: result.lockId });
  });

  // DELETE /context/lock/morning-routine — Release exclusive lock
  app.delete("/context/lock/morning-routine", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const lockId = (body as { lockId?: string }).lockId;
    if (lockId && morningRoutineLock.release(lockId)) {
      return c.json({ status: "released" });
    }
    return respondWithAgentError(c, 400, [
      composeIssue("context.lock_not_held", {
        field: "lockId",
        received: lockId ?? "<missing>",
      }),
    ]);
  });

  // POST /context/lock/roadmap — Acquire exclusive roadmap write lock
  // Dispatcher auto-acquires this for `routine.roadmap_refresh`; other
  // flows (DM handler via the roadmap skill, evening sweeper) may
  // acquire it manually. See ROADMAP-REDESIGN.md §3.6.
  app.post("/context/lock/roadmap", (c) => {
    const result = roadmapWriteLock.acquire();
    if (!result.ok) {
      return respondWithAgentError(c, 409, [
        composeIssue("context.roadmap_write_lock_held", {
          field: "roadmapWriteLock",
          received: { holder: result.holder },
        }),
      ]);
    }
    return c.json({ status: "acquired", lockId: result.lockId });
  });

  // DELETE /context/lock/roadmap — Release the roadmap write lock
  app.delete("/context/lock/roadmap", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const lockId = (body as { lockId?: string }).lockId;
    if (lockId && roadmapWriteLock.release(lockId)) {
      return c.json({ status: "released" });
    }
    return respondWithAgentError(c, 400, [
      composeIssue("context.lock_not_held", {
        field: "lockId",
        received: lockId ?? "<missing>",
      }),
    ]);
  });

  // POST /context/roadmap/id — Mint a stable daemon-owned roadmap entry id.
  app.post("/context/plans/roadmap/id", async (c) => {
    if (roadmapWriteLock.getHolder()) {
      const lockId = c.req.header("X-Lock-Id");
      if (!roadmapWriteLock.isHeldBy(lockId)) {
        logger.info({ path: "roadmap" }, "Roadmap id mint rejected — roadmap write lock held");
        return respondWithAgentError(c, 409, [
          composeIssue("context.roadmap_write_lock_held", {
            field: "X-Lock-Id",
            received: lockId ?? "<missing>",
          }),
        ]);
      }
    }

    const parsedBody = await readOptionalJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;

    const requestedDate =
      parsedBody.body.creationDate ?? parsedBody.body.sourceDate;
    const creationDate =
      typeof requestedDate === "string"
        ? requestedDate
        : localDateStr(new Date(), config.timezone || undefined);
    if (!isValidYmd(creationDate)) {
      return respondWithAgentError(c, 400, [
        composeIssue("context.creation_date_invalid", {
          field: "creationDate",
          received: creationDate,
        }),
      ]);
    }

    const contextDir = getCurrentContextDir();
    const fullPath = safePath(contextDir, "roadmap");
    if (!fullPath) {
      return respondWithAgentError(c, 400, [
        composeIssue("context.path_invalid", {
          field: "path",
          received: "roadmap",
        }),
      ]);
    }

    return serializeContextFileWrite(fullPath, () => {
      const content = existsSync(fullPath)
        ? readFileSync(fullPath, "utf-8")
        : "";
      const existingIds = extractRoadmapIds(content).map((ref) => ref.id);
      try {
        return c.json({
          id: generateRoadmapId({
            creationDate,
            existingIds,
            randomBytes: deps.roadmapIdRandomBytes,
          }),
        });
      } catch (err) {
        if (err instanceof RoadmapIdGenerationError) {
          return respondWithAgentError(c, 503, [
            composeIssue("context.roadmap_id_generation_failed", {
              field: "id",
              received: { existingIdCount: existingIds.length, creationDate },
            }),
          ]);
        }
        throw err;
      }
    });
  });
}
