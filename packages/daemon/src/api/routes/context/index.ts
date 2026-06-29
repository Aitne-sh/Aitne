import { Hono } from "hono";
import type { Context } from "hono";
import type { ApiDependencies } from "../../server.js";
import { getContextDir } from "../../../config.js";
import { getDegradedMode } from "../../../db/runtime-state.js";
import {
  InMemoryTodayWriteLockManager,
  getTodayWriteLockTimeoutMs,
  type TodayWriteLockManager,
} from "../../../core/today-write-lock.js";
import {
  InMemoryRoadmapWriteLockManager,
  getRoadmapWriteLockTimeoutMs,
  type RoadmapWriteLockManager,
} from "../../../core/roadmap-write-lock.js";
import { SNAPSHOT_DEBOUNCE_MS } from "../../../core/context-validation/index.js";
import type { LongTermPlanSource } from "../../../core/roadmap-horizon.js";
import { createLogger } from "../../../logging.js";
import {
  composeIssue,
  respondWithAgentError,
} from "../../helpers/agent-errors.js";
import { registerLockRoutes } from "./locks.js";
import { registerSnapshotsRoutes } from "./snapshots.js";
import { registerReadRoutes } from "./read.js";
import { registerRepairRoutes } from "./repair.js";
import { registerWriteRoutes } from "./write.js";

const logger = createLogger("context-api");

/**
 * Shared closure bundle passed to every sub-registrar. Hosts the locks,
 * snapshot debounce, and the per-request helpers that need factory-time
 * configuration (timezone, body parser). Sub-files import this type with
 * `import type` so there is no runtime cycle with index.ts.
 *
 * Note: the legacy per-router `withWriteLock` mutex was retired in favour
 * of the daemon-singleton {@link serializeContextFileWrite} (per-absolute-
 * path), which also fences against in-process daemon-direct writers
 * (today-direct-writer, agent-journal-appender, roadmap-maintenance,
 * scheduled-tasks weekly-interests appender). The per-router mutex
 * only covered HTTP-vs-HTTP within a single router instance, leaving
 * the HTTP-vs-direct race that allowed silent today.md / agent/journal.md
 * clobbers.
 */
export interface ContextRouteContext {
  readonly deps: ApiDependencies;
  readonly getCurrentContextDir: () => string;
  readonly morningRoutineLock: TodayWriteLockManager;
  readonly roadmapWriteLock: RoadmapWriteLockManager;
  readonly saveSnapshot: (
    filePath: string,
    content: string,
    trigger: string,
    force?: boolean,
    sessionId?: string | null,
  ) => number | null;
  readonly isRoadmapValidationDisabled: (
    path: string,
    headerValue?: string,
  ) => boolean;
  readonly logRoadmapValidationBypass: (
    c: Context,
    method: string,
    path: string,
  ) => void;
  readonly roadmapDefaultLongTermPlanSource: (c: Context) => LongTermPlanSource;
  readonly readOptionalJsonBody: (
    c: Context,
  ) => Promise<
    | { ok: true; body: Record<string, unknown> }
    | { ok: false; response: Response }
  >;
}

export function createContextRoutes(deps: ApiDependencies): Hono {
  const app = new Hono();
  const { db, config } = deps;
  // Resolve the context directory at request time rather than closing over
  // the startup value. `/api/setup/migrate-context` mutates `config` in
  // memory after a successful move, and the Context API must immediately
  // follow the new primary-vault path without requiring a daemon restart.
  //
  // Intentionally omit `db` here: degraded mode is handled by the 503
  // middleware below, so once a request reaches a handler we want the
  // actual current target path, never the legacy fallback.
  const getCurrentContextDir = () => getContextDir(config);

  /**
   * Management Mode degraded-mode gate (plan §5.4).
   * When the primary vault is unreachable, refuse BOTH reads and writes
   * with 503 so the agent does not read or write a stale fallback
   * location. Checked per-request so lifting degraded mode in the health
   * probe takes effect without restart. The lock endpoints under
   * `/context/lock/*` also participate: acquiring a lock during degraded
   * mode would leave the lock held with no way to write, so we gate them
   * too.
   */
  app.use("/context/*", async (c, next) => {
    const state = getDegradedMode(db);
    if (state) {
      return respondWithAgentError(c, 503, [
        composeIssue("context.vault_unreachable", {
          field: "primaryVault",
          received: { reason: state.reason, path: state.path, since: state.since },
        }),
      ], {
        legacyFields: {
          reason: state.reason,
          path: state.path,
          since: state.since,
        },
      });
    }
    // Phase 2 — global context-write gate engaged during a
    // /api/setup/migrate-context run. Refuses WRITES (not reads)
    // because reads against the still-intact source are safe; the
    // migration endpoint blocks writes so no handler races the move.
    const writeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
    if (deps.contextWriteGate?.isEngaged() && writeMethods.has(c.req.method)) {
      const gateState = deps.contextWriteGate.getState();
      return respondWithAgentError(c, 503, [
        composeIssue("context.migration_in_progress", {
          field: "method",
          received: { method: c.req.method, reason: gateState.reason, since: gateState.since },
        }),
      ], {
        legacyFields: {
          reason: gateState.reason,
          since: gateState.since,
        },
      });
    }
    await next();
  });

  const morningRoutineLock =
    deps.morningRoutineLock ??
    new InMemoryTodayWriteLockManager(
      getTodayWriteLockTimeoutMs(config.executeTimeoutMinutes),
    );
  const roadmapWriteLock =
    deps.roadmapWriteLock ??
    new InMemoryRoadmapWriteLockManager(
      getRoadmapWriteLockTimeoutMs(config.executeTimeoutMinutes),
    );

  // Per-instance state (not shared across tests)
  const lastSnapshotTimes = new Map<string, number>();

  function saveSnapshot(
    filePath: string,
    content: string,
    trigger: string,
    force = false,
    sessionId?: string | null,
  ): number | null {
    const now = Date.now();
    const lastTime = lastSnapshotTimes.get(filePath) ?? 0;

    if (!force && now - lastTime < SNAPSHOT_DEBOUNCE_MS) {
      return null;
    }

    const result = db
      .prepare(
        "INSERT INTO md_file_snapshots (file_path, content, trigger, session_id) VALUES (?, ?, ?, ?)",
      )
      .run(filePath, content, trigger, sessionId ?? null);

    lastSnapshotTimes.set(filePath, now);
    return Number(result.lastInsertRowid);
  }

  function isRoadmapValidationDisabled(path: string, headerValue?: string): boolean {
    return path === "plans/roadmap" && headerValue?.toLowerCase() === "off";
  }

  function logRoadmapValidationBypass(
    c: Context,
    method: string,
    path: string,
  ): void {
    logger.warn(
      {
        path,
        method,
        sessionId: c.req.header("X-Session-Id") ?? null,
        caller:
          c.req.header("X-Caller") ??
          c.req.header("X-Agent-Caller") ??
          c.req.header("User-Agent") ??
          null,
        route: c.req.path,
      },
      "Roadmap validation bypassed by X-Roadmap-Validation: off",
    );
  }

  function roadmapDefaultLongTermPlanSource(c: Context): LongTermPlanSource {
    const caller = (
      c.req.header("X-Caller") ??
      c.req.header("X-Agent-Caller") ??
      ""
    ).toLowerCase();
    return caller.includes("dashboard") ? "dashboard" : "manual";
  }

  async function readOptionalJsonBody(c: Context): Promise<
    { ok: true; body: Record<string, unknown> } | { ok: false; response: Response }
  > {
    const raw = await c.req.text();
    if (raw.trim() === "") return { ok: true, body: {} };
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {
          ok: false,
          response: respondWithAgentError(c, 400, [
            composeIssue("context.body_not_object", {
              field: "body",
              received: parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed,
            }),
          ]),
        };
      }
      return { ok: true, body: parsed as Record<string, unknown> };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.warn(
        { path: c.req.path, method: c.req.method, detail },
        "Request rejected — body is not valid JSON",
      );
      return {
        ok: false,
        response: respondWithAgentError(c, 400, [
          composeIssue("context.invalid_json_body", {
            field: "body",
            received: detail,
          }),
        ]),
      };
    }
  }

  const ctx: ContextRouteContext = {
    deps,
    getCurrentContextDir,
    morningRoutineLock,
    roadmapWriteLock,
    saveSnapshot,
    isRoadmapValidationDisabled,
    logRoadmapValidationBypass,
    roadmapDefaultLongTermPlanSource,
    readOptionalJsonBody,
  };

  // Registration order mirrors the pre-split file: all path-specific
  // routes register before any wildcard so Hono's first-match dispatch
  // stays stable. Within each sub-registrar, handlers register in the
  // same order as the legacy file. See R2 in
  // docs/design/appendices/api-route-decomposition.md.
  registerLockRoutes(app, ctx);
  registerSnapshotsRoutes(app, ctx);
  registerReadRoutes(app, ctx);
  registerRepairRoutes(app, ctx);
  registerWriteRoutes(app, ctx);

  return app;
}
