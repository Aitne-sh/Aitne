import type { Hono } from "hono";
import {
  BACKEND_IDS,
  INTEGRATION_DESCRIPTORS,
  INTEGRATION_KEYS,
  isIntegrationKey,
  type BackendId,
} from "@aitne/shared";
import { readIntegrations } from "../../../db/integrations-store.js";
import {
  listProxyModelOptions,
  resolveCanonicalDelegatedModel,
} from "../../../core/backends/proxy-model-registry.js";
import { composeIssue, respondWithAgentError } from "../../helpers/agent-errors.js";
import type { ApiDependencies } from "../../server.js";
import { handleIntegrationPatch } from "./crud-patch.js";

/**
 * Register the integration CRUD routes:
 *   - `GET    /integrations`
 *   - `GET    /integrations/:key/recent-proxy-calls`
 *   - `GET    /integrations/proxy-models/:backend`
 *   - `PATCH  /integrations/:key`
 *
 * PATCH body lives in `./crud-patch.ts:handleIntegrationPatch` because the
 * full lifecycle (validate / flip-lock / probe-cache / re-materialise /
 * audit) is ~700 lines and would push this file past the ~800-line soft
 * ceiling.
 */
export function registerCrudRoutes(app: Hono, deps: ApiDependencies): void {
  const { db } = deps;

  app.get("/integrations", (c) => {
    const state = readIntegrations(db);
    const integrations = INTEGRATION_KEYS.map((key) => {
      const descriptor = INTEGRATION_DESCRIPTORS[key];
      return {
        key: descriptor.key,
        displayName: descriptor.displayName,
        supportedModes: descriptor.supportedModes,
        directSetup: descriptor.directSetup ?? null,
        backendConnectors: descriptor.backendConnectors,
        skillsTouched: descriptor.skillsTouched,
        taskFlowsTouched: descriptor.taskFlowsTouched,
        observersTouched: descriptor.observersTouched,
        apiRoutesTouched: descriptor.apiRoutesTouched,
        userManagedConnector: descriptor.userManagedConnector ?? false,
        state: state[key],
      };
    });
    return c.json({ integrations });
  });

  // DELEGATED-PROXY-API-DESIGN.md §7 — last N delegated-proxy invocations for
  // an integration. Drives the IntegrationCard's "Recent calls" collapsible
  // table so the user can spot slow / failing connectors without leaving the
  // /connections page. Daemon-side filter (rather than dashboard reading the
  // generic cost table and post-filtering) because:
  //   - integrationKey lives inside `detail` JSON; SQLite-side JSON1 extract
  //     keeps the response payload small and skips the parent-event noise.
  //   - cost.ts dashboards already aggregate; a per-integration debug view
  //     belongs alongside the integration's other state for cohesion.
  //
  // Limit defaults to 50 (the design's stated cap), bounded at 200 so a
  // typo-driven `?limit=99999` cannot DoS the response.
  app.get("/integrations/:key/recent-proxy-calls", (c) => {
    const key = c.req.param("key");
    if (!isIntegrationKey(key)) {
      return respondWithAgentError(c, 404, [
        composeIssue("integrations.unknown_integration", {
          field: "key",
          received: key,
        }),
      ], { legacyFields: { key } });
    }
    const rawLimit = c.req.query("limit");
    let limit = 50;
    if (rawLimit !== undefined) {
      const parsed = Number.parseInt(rawLimit, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        return respondWithAgentError(c, 400, [
          composeIssue("integrations.invalid_limit", {
            field: "limit",
            received: rawLimit,
          }),
        ], {
          legacyFields: {
            message: "limit must be a positive integer (default 50, max 200)",
          },
        });
      }
      limit = Math.min(parsed, 200);
    }

    const rows = db
      .prepare(
        `SELECT id, started_at, completed_at, model_used, backend,
                cost_usd, tokens_input, tokens_output, duration_ms,
                num_turns, result, error, detail
           FROM agent_actions
          WHERE action_type = 'delegated_proxy.invoke'
            AND json_extract(detail, '$.integrationKey') = ?
          ORDER BY id DESC
          LIMIT ?`,
      )
      .all(key, limit) as Array<{
        id: number;
        started_at: string | null;
        completed_at: string | null;
        model_used: string | null;
        backend: string | null;
        cost_usd: number | null;
        tokens_input: number | null;
        tokens_output: number | null;
        duration_ms: number | null;
        num_turns: number | null;
        result: string | null;
        error: string | null;
        detail: string | null;
      }>;

    const calls = rows.map((row) => {
      /* c8 ignore next -- sql WHERE json_extract filters out rows with null detail */
      const detail = row.detail ? safeParseJson(row.detail) : null;
      return {
        id: row.id,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        modelId: row.model_used,
        backend: row.backend,
        costUsd: row.cost_usd,
        tokensInput: row.tokens_input,
        tokensOutput: row.tokens_output,
        durationMs: row.duration_ms,
        numTurns: row.num_turns,
        result: row.result,
        // detail.errorClass is the structured DelegatedErrorClass when the
        // call failed inside the proxy pipeline (auth_error, no_tool_call,
        // etc.). detail.toolName is always present. We surface both so the
        // table can render a human label without re-parsing on the client.
        errorClass: detail?.errorClass ?? null,
        toolName: detail?.toolName ?? null,
        errorMessage: row.error,
      };
    });

    return c.json({
      key,
      limit,
      calls,
    });
  });

  // DELEGATED-PROXY-API-DESIGN.md §6.1 / §7 — list known proxy-model options
  // for a backend (registered + custom-pinned). Drives the dashboard model
  // dropdown so the daemon stays the source of truth for the registered
  // model surface; clients don't need to keep their own registry mirror.
  app.get("/integrations/proxy-models/:backend", (c) => {
    const backend = c.req.param("backend");
    if (!(BACKEND_IDS as readonly string[]).includes(backend)) {
      return c.json(
        {
          error: "invalid_backend",
          message: `Unknown backend '${backend}'.`,
          supportedBackends: BACKEND_IDS,
        },
        400,
      );
    }
    const backendId = backend as BackendId;
    const options = listProxyModelOptions(backendId);
    const canonical = resolveCanonicalDelegatedModel(backendId, db);
    return c.json({
      backend: backendId,
      canonical,
      options,
    });
  });

  app.patch("/integrations/:key", (c) => handleIntegrationPatch(c, deps));
}

function safeParseJson(s: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(s) as unknown;
    /* c8 ignore next -- sql WHERE guarantees only object-typed detail rows reach here */
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  /* c8 ignore start -- sql WHERE json_extract would reject malformed JSON rows */
  } catch {
    return null;
  }
  /* c8 ignore stop */
}
