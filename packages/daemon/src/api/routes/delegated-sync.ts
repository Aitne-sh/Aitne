import { Hono, type Context } from "hono";
import {
  resolveActiveHours,
  type DelegatedSyncStatus,
  type DelegatedSyncWorker,
} from "../../observers/delegated-sync-worker.js";
import {
  readRuntimeState,
  writeRuntimeState,
} from "../../db/runtime-state.js";
import { createLogger } from "../../logging.js";
import type { ApiDependencies } from "../server.js";

const logger = createLogger("delegated-sync-api");

/**
 * Delegated-sync opt-in routes (`docs/design/appendices/delegated-sync-opt-in.md`).
 *
 * - GET    /api/delegated-sync                       — status + catalog + active hours.
 * - PATCH  /api/delegated-sync/cadences/:cadenceId   — toggle enabled / change interval.
 * - PATCH  /api/delegated-sync/active-hours          — change shared active-hours window.
 * - POST   /api/delegated-sync/cadences/:cadenceId/run — single-shot Run Now.
 *
 * All endpoints are dashboard-only (Approve tier in `risk-classifier.ts`).
 * Settings live in the existing `runtime_state.delegatedSync` JSON blob;
 * no schema migration needed.
 */

const RUNTIME_STATE_KEY = "delegatedSync";
const MAX_INTERVAL_SECONDS = 24 * 60 * 60;

interface DelegatedSyncRuntimeConfigShape {
  intervals?: Record<string, number>;
  minIntervalSeconds?: number;
  cadenceEnabled?: Record<string, boolean>;
  activeStartHour?: number;
  activeEndHour?: number;
}

async function parseJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

function readConfig(deps: ApiDependencies): DelegatedSyncRuntimeConfigShape {
  return readRuntimeState<DelegatedSyncRuntimeConfigShape>(
    deps.db,
    RUNTIME_STATE_KEY,
  ) ?? {};
}

function writeConfig(
  deps: ApiDependencies,
  next: DelegatedSyncRuntimeConfigShape,
): void {
  writeRuntimeState(deps.db, RUNTIME_STATE_KEY, next);
}

/**
 * Empty status payload for the case where no `DelegatedSyncWorker` is
 * registered (every integration in direct/disabled mode). Mirrors the
 * shape `getStatus()` would emit so the dashboard renders the same
 * empty-state layout regardless of which branch responded.
 */
function emptyStatusPayload(): DelegatedSyncStatus {
  return {
    workerRunning: false,
    lastSuccessAt: null,
    circuitState: "ok",
    activeHours: { startHour: 4, endHour: 24 },
    withinActiveHours: false,
    cadences: {},
    unrecognizedIntervalKeys: [],
    ttlContractViolations: [],
  };
}

interface CadenceConstraints {
  softFloorSeconds: number;
}

/**
 * Read just the validation constraints PATCH needs from `getStatus()`.
 * Avoids exposing the full cadence definition (with closures over the
 * worker's options) at the route boundary.
 */
function getCadenceConstraints(
  worker: DelegatedSyncWorker,
  id: string,
): CadenceConstraints | null {
  const status = worker.getStatus();
  const row = status.cadences[id];
  if (!row) return null;
  return { softFloorSeconds: row.softFloorSeconds };
}

export function createDelegatedSyncRoutes(deps: ApiDependencies): Hono {
  const app = new Hono();

  app.get("/delegated-sync", (c) => {
    if (!deps.delegatedSyncWorker) {
      return c.json(emptyStatusPayload());
    }
    return c.json(deps.delegatedSyncWorker.getStatus());
  });

  app.patch("/delegated-sync/cadences/:cadenceId", async (c) => {
    if (!deps.delegatedSyncWorker) {
      return c.json({ error: "worker_unavailable" }, 503);
    }
    const cadenceId = c.req.param("cadenceId");
    const constraints = getCadenceConstraints(deps.delegatedSyncWorker, cadenceId);
    if (!constraints) {
      return c.json({ error: "unknown_cadence" }, 404);
    }

    const body = await parseJsonBody(c);
    if (body === null || typeof body !== "object") {
      return c.json({ error: "invalid_body" }, 400);
    }
    const patch = body as Record<string, unknown>;

    let nextEnabled: boolean | undefined;
    if ("enabled" in patch) {
      if (typeof patch.enabled !== "boolean") {
        return c.json({ error: "invalid_enabled" }, 400);
      }
      nextEnabled = patch.enabled;
    }

    let nextIntervalSeconds: number | undefined;
    if ("intervalSeconds" in patch) {
      const candidate = patch.intervalSeconds;
      if (
        typeof candidate !== "number"
        || !Number.isInteger(candidate)
        || candidate <= 0
      ) {
        return c.json({ error: "invalid_interval" }, 400);
      }
      if (candidate < constraints.softFloorSeconds) {
        return c.json(
          {
            error: "below_soft_floor",
            softFloorSeconds: constraints.softFloorSeconds,
          },
          400,
        );
      }
      if (candidate > MAX_INTERVAL_SECONDS) {
        return c.json(
          {
            error: "above_max",
            maxIntervalSeconds: MAX_INTERVAL_SECONDS,
          },
          400,
        );
      }
      nextIntervalSeconds = candidate;
    }

    if (nextEnabled === undefined && nextIntervalSeconds === undefined) {
      return c.json({ error: "empty_patch" }, 400);
    }

    const config = readConfig(deps);
    const next: DelegatedSyncRuntimeConfigShape = { ...config };
    if (nextEnabled !== undefined) {
      next.cadenceEnabled = {
        ...(config.cadenceEnabled ?? {}),
        [cadenceId]: nextEnabled,
      };
    }
    if (nextIntervalSeconds !== undefined) {
      next.intervals = {
        ...(config.intervals ?? {}),
        [cadenceId]: nextIntervalSeconds,
      };
    }
    writeConfig(deps, next);

    logger.info(
      {
        cadenceId,
        enabled: nextEnabled,
        intervalSeconds: nextIntervalSeconds,
      },
      "Delegated-sync cadence patched",
    );

    return c.json(deps.delegatedSyncWorker.getStatus());
  });

  app.patch("/delegated-sync/active-hours", async (c) => {
    const body = await parseJsonBody(c);
    if (body === null || typeof body !== "object") {
      return c.json({ error: "invalid_body" }, 400);
    }
    const patch = body as Record<string, unknown>;
    const start = patch.startHour;
    const end = patch.endHour;
    if (
      typeof start !== "number"
      || !Number.isInteger(start)
      || start < 0
      || start > 23
    ) {
      return c.json({ error: "invalid_start" }, 400);
    }
    if (
      typeof end !== "number"
      || !Number.isInteger(end)
      || end < 1
      || end > 24
    ) {
      return c.json({ error: "invalid_end" }, 400);
    }
    if (start >= end) {
      return c.json({ error: "start_must_be_before_end" }, 400);
    }

    const config = readConfig(deps);
    writeConfig(deps, {
      ...config,
      activeStartHour: start,
      activeEndHour: end,
    });

    logger.info(
      { startHour: start, endHour: end },
      "Delegated-sync active hours patched",
    );

    if (!deps.delegatedSyncWorker) {
      return c.json({
        ...emptyStatusPayload(),
        activeHours: resolveActiveHours({ activeStartHour: start, activeEndHour: end }),
      });
    }
    return c.json(deps.delegatedSyncWorker.getStatus());
  });

  app.post("/delegated-sync/cadences/:cadenceId/run", async (c) => {
    if (!deps.delegatedSyncWorker) {
      return c.json({ error: "worker_unavailable" }, 503);
    }
    const cadenceId = c.req.param("cadenceId");
    const result = await deps.delegatedSyncWorker.runCadenceNow(cadenceId);
    if (!result.ok) {
      const status = result.error === "unknown_cadence" ? 404 : 409;
      return c.json({ error: result.error }, status);
    }
    return c.json({ ok: true });
  });

  return app;
}
