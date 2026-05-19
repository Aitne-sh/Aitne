import type { Context, Hono } from "hono";
import type Database from "better-sqlite3";
import {
  BACKEND_IDS,
  INTEGRATION_DESCRIPTORS,
  isIntegrationKey,
  type BackendId,
  type IntegrationKey,
} from "@aitne/shared";
import {
  evaluateProbe,
  getConnector,
  makeUserManagedProbeResult,
} from "../../../core/integration-probe.js";
import { LiveProbeUnsupportedError } from "../../../core/agent-core.js";
import {
  readIntegrations,
} from "../../../db/integrations-store.js";
import {
  readProbe,
  writeProbe,
} from "../../../db/integration-probe-store.js";
import { createLogger } from "../../../logging.js";
import { composeIssue, respondWithAgentError } from "../../helpers/agent-errors.js";
import type { ApiDependencies } from "../../server.js";

const logger = createLogger("integrations-api");

/**
 * Register `POST /integrations/:key/probe` — evaluate or read the cached
 * connector probe for a given backend. Phase 2 supports two modes:
 *   - Live probe: `{liveProbe: true}` spawns the backend and enumerates
 *     its MCP tool list, then persists.
 *   - Cached read: body omits `tools`. Returns the latest stored row, or
 *     `{result: null}` if no probe has been taken yet.
 *   - Inline tools: `{tools: [...]}` accepts a pre-collected tool list
 *     (the names the agent subprocess reported) and evaluates without
 *     spawning. The dashboard's refresh button uses the live path;
 *     `/health` and the setup wizard's initial render use the cached
 *     path.
 *
 * No live agent subprocess is launched in the default path — keeping
 * that out of the boot critical path is what saves the per-Opus probe
 * cost called out in the §7 POC.
 */
export function registerProbeRoutes(app: Hono, deps: ApiDependencies): void {
  const { db } = deps;

  app.post("/integrations/:key/probe", async (c) => {
    const key = c.req.param("key");
    if (!isIntegrationKey(key)) {
      return respondWithAgentError(c, 404, [
        composeIssue("integrations.unknown_integration", {
          field: "key",
          received: key,
        }),
      ], { legacyFields: { key } });
    }

    const body = await readOptionalJsonBody(c) as
      | { backend?: unknown; tools?: unknown; liveProbe?: unknown }
      | null;
    if (body === null) {
      return respondWithAgentError(c, 400, [
        composeIssue("integrations.invalid_json_body", {
          field: "body",
          received: "<not_json>",
        }),
      ]);
    }

    const backend = resolveProbeBackend(body.backend, db, key);
    if (!backend.ok) return c.json(backend.error, backend.status);

    const descriptorForProbe = INTEGRATION_DESCRIPTORS[key];
    const isUserManaged = descriptorForProbe.userManagedConnector === true;

    // Connector existence is a descriptor-driven precondition. User-
    // managed integrations (Outlook today) intentionally ship with an
    // empty `backendConnectors` and skip this check — the user's MCP /
    // connector on the chosen backend is the source of truth, not the
    // registry. Backend availability + auth still get verified for
    // user-managed in the live-probe branch below.
    if (!isUserManaged) {
      const connector = getConnector(key, backend.value);
      /* c8 ignore start -- every registered (integration, backend) pair ships with a connector today; forward-compat guard for future partial connectors */
      if (!connector) {
        return c.json(
          {
            error: "backend_not_supported",
            key,
            backend: backend.value,
            availableBackends: Object.keys(
              descriptorForProbe.backendConnectors,
            ),
          },
          400,
        );
      }
      /* c8 ignore stop */
    }

    // §4.11 live probe — `liveProbe: true` asks the daemon to spawn the
    // target backend and enumerate its MCP tool list. User-initiated only;
    // never fired from boot or PATCH. The descriptor + cached read paths
    // cover the other two calling conventions.
    //
    // For user-managed integrations the spawn + probeTools() call still
    // fires (this is what enforces §4.12.2 checks #1 backend resolvable
    // and #2 backend auth valid). Only the descriptor-side capability
    // evaluation is replaced by `makeUserManagedProbeResult`, which
    // carries the full live tool list as `presentTools` so dashboards
    // can show "we found N tools on your backend."
    if (body.liveProbe === true) {
      const core = deps.agentBackends?.find(
        (c) => c.backendId === backend.value,
      );
      if (!core) {
        return c.json(
          {
            error: "backend_core_unavailable",
            backend: backend.value,
            message: `Backend '${backend.value}' is not registered in this daemon — cannot run live probe.`,
          },
          503,
        );
      }
      try {
        const tools = await core.probeTools();
        const result = isUserManaged
          ? makeUserManagedProbeResult(key, backend.value, tools)
          : evaluateProbe({
              tools,
              integration: key,
              backend: backend.value,
            });
        writeProbe(db, result);
        logger.info(
          {
            key,
            backend: backend.value,
            present: result.present,
            missingRequired: result.missingRequired,
            toolCount: result.presentTools.length,
            userManaged: isUserManaged,
          },
          "integration live probe persisted",
        );
        return c.json({
          ok: true,
          cached: false,
          liveProbe: true,
          ...(isUserManaged ? { userManaged: true } : {}),
          result,
        });
      } catch (err) {
        if (err instanceof LiveProbeUnsupportedError) {
          return c.json(
            {
              error: "live_probe_unsupported",
              backend: backend.value,
              message: err.reason,
            },
            501,
          );
        }
        logger.error(
          { err, key, backend: backend.value },
          "live probe failed",
        );
        return c.json(
          {
            error: "live_probe_failed",
            backend: backend.value,
            message: err instanceof Error ? err.message : String(err),
          },
          500,
        );
      }
    }

    const tools = body?.tools;
    if (tools === undefined) {
      const cached = readProbe(db, key, backend.value);
      // 200 + result:null when there's no cached row — distinguishes
      // "endpoint missing" (which the unknown_integration / 404 above
      // covers) from "endpoint worked but the cache is empty," so the
      // dashboard callers can branch without parsing error codes.
      return c.json({
        ok: true,
        cached: cached !== null,
        ...(isUserManaged ? { userManaged: true } : {}),
        result: cached,
      });
    }

    if (!Array.isArray(tools) || tools.some((t) => typeof t !== "string")) {
      return c.json(
        {
          error: "invalid_body",
          message: "`tools` must be an array of MCP tool names (strings).",
        },
        400,
      );
    }

    try {
      const result = isUserManaged
        ? makeUserManagedProbeResult(key, backend.value, tools as string[])
        : evaluateProbe({
            tools: tools as string[],
            integration: key,
            backend: backend.value,
          });
      writeProbe(db, result);
      logger.info(
        {
          key,
          backend: backend.value,
          present: result.present,
          missingRequired: result.missingRequired,
          toolCount: result.presentTools.length,
          userManaged: isUserManaged,
        },
        "integration probe persisted",
      );
      return c.json({
        ok: true,
        cached: false,
        ...(isUserManaged ? { userManaged: true } : {}),
        result,
      });
    /* c8 ignore start -- evaluateProbe / writeProbe success path is always taken in tests; catch is defensive */
    } catch (err) {
      logger.error({ err, key, backend: backend.value }, "probe evaluation failed");
      return respondWithAgentError(c, 500, [
        composeIssue("integrations.internal_error", {
          field: "<server>",
          received: "<probe_evaluation_failed>",
        }),
      ]);
    }
    /* c8 ignore stop */
  });
}

/**
 * Tolerant JSON body reader for POST routes that accept an empty body
 * (e.g. `POST /integrations/:key/probe` with no `tools` defaults to a
 * cached read). Returns `{}` for an empty body, `null` for invalid JSON,
 * and the parsed value otherwise.
 */
async function readOptionalJsonBody(c: Context): Promise<unknown> {
  try {
    const raw = await c.req.text();
    if (raw.trim() === "") return {};
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

type BackendResolution =
  | { ok: true; value: BackendId }
  | { ok: false; status: 400 | 404; error: { error: string; message?: string; supportedBackends?: readonly string[] } };

function resolveProbeBackend(
  raw: unknown,
  db: Database.Database,
  key: IntegrationKey,
): BackendResolution {
  if (typeof raw === "string") {
    if (!(BACKEND_IDS as readonly string[]).includes(raw)) {
      return {
        ok: false,
        status: 400,
        error: {
          error: "invalid_backend",
          message: `Unknown backend '${raw}'.`,
          supportedBackends: BACKEND_IDS,
        },
      };
    }
    return { ok: true, value: raw as BackendId };
  }
  if (raw !== undefined) {
    return {
      ok: false,
      status: 400,
      error: {
        error: "invalid_backend",
        message: "`backend` must be a string when provided.",
      },
    };
  }
  // Default to the integration's `delegatedBackend` when one is
  // configured — this is the backend the wizard would commit against.
  const state = readIntegrations(db)[key];
  if (state.delegatedBackend) {
    return { ok: true, value: state.delegatedBackend };
  }
  return {
    ok: false,
    status: 400,
    error: {
      error: "backend_required",
      message:
        "Pass `backend` in the request body — this integration is not currently delegated, so the daemon cannot infer one.",
    },
  };
}
