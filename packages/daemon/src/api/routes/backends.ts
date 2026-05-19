import { Hono } from "hono";
import { z } from "zod";
import {
  ADVISOR_ALLOWED_MODELS,
  API_KEY_PROVIDERS_BY_BACKEND,
  CONFIGURABLE_PROCESS_KEYS,
  RUNTIME_AVAILABLE_BACKEND_IDS,
  WEB_SEARCH_CAPABLE_BACKENDS,
  backendApiKeyConfigSchema,
  getBackendIds,
  getDefaultTierForProcessKey,
  isAdvisorModel,
  isBackendId,
  isConfigurableProcessKey,
  isRuntimeAvailableBackendId,
  validateBackendApiKeyConfigFormat,
  type BackendApiKeyConfig,
  type BackendId,
  type ProcessModelTier,
} from "@aitne/shared";
import type { ApiDependencies } from "../server.js";
import { createLogger, toSafeErrorMessage } from "../../logging.js";
import {
  DEFAULT_CLAUDE_HIGH_MODEL,
  DEFAULT_CLAUDE_LITE_MODEL,
  DEFAULT_CLAUDE_MEDIUM_MODEL,
  getModelsForBackend,
} from "../../core/backends/model-registry.js";
import { setProcessBackendConfig } from "../../core/backends/process-config-cascade.js";
import { queryChatBinding } from "../chat-binding-query.js";
import {
  applyDefaultPresets,
  previewMainSwitchImpact,
  setMainBackend,
} from "../../core/backends/plan-presets.js";
import {
  writeAuthFailureDetail,
  writeAuthOkDetail,
} from "../../core/backends/auth-health-monitor.js";
import { applyConfigUpdates } from "../env-writer.js";
import { createSettingsStore } from "../../settings/settings-store.js";
import {
  getInstallMethods,
  isCliInstalled,
  getCliCommand,
  resolveInstallCommand,
} from "../../core/backends/install-methods.js";
import { runLineCommand } from "../../core/backends/cli-utils.js";
import {
  describeBackendApiKey,
  syncBackendApiKeyToEnv,
} from "../../secrets/backend-api-key-env.js";
import {
  cascadeNativeBindingsOnMainSwitch,
  checkDelegatedCompatForNewMain,
} from "../../core/integration-main-backend.js";
import { readIntegrations } from "../../db/integrations-store.js";
import { writeManagementMd } from "../../core/management-md.js";

const logger = createLogger("backends-api");
import { PriceFetcher } from "../../core/backends/price-fetcher.js";
import { OpencodeCore } from "../../core/backends/opencode-core.js";

interface BackendRow {
  id: BackendId;
  enabled: number;
  auth_method: string | null;
  auth_status: string;
  auth_checked_at: string | null;
  auth_detail: string | null;
  last_error: string | null;
  web_search_enabled: number;
  auth_first_expired_at: string | null;
  auth_last_success_at: string | null;
  auth_notification_count: number;
}

interface BackendDefaultsRow {
  default_backend: BackendId;
  default_lite_model: string;
  default_medium_model: string;
  default_high_model: string;
}

interface ProcessConfigRow {
  process_key: string;
  main_backend: BackendId;
  main_model: string;
  fallback_backend: BackendId | null;
  fallback_model: string | null;
  max_turns: number;
  max_budget_usd: number;
  updated_at: string | null;
  updated_by: string | null;
}

const updateDefaultsSchema = z.object({
  defaultBackend: z.string().refine(isBackendId),
  defaultLiteModel: z.string().min(1),
  defaultMediumModel: z.string().min(1),
  defaultHighModel: z.string().min(1),
});

const updateProcessConfigSchema = z.object({
  mainBackend: z.string().refine(isBackendId),
  mainModel: z.string().min(1),
  fallbackBackend: z
    .union([z.string().refine(isBackendId), z.null()])
    .optional()
    .default(null),
  fallbackModel: z.string().nullable().optional().default(null),
  maxTurns: z.coerce.number().int().positive().max(1000),
  maxBudgetUsd: z.coerce.number().nonnegative().max(10_000),
});

export function createBackendRoutes(deps: ApiDependencies): Hono {
  const app = new Hono();
  const { db, config } = deps;
  const coreById = Object.fromEntries(
    (deps.agentBackends ?? []).map((core) => [core.backendId, core]),
  );
  const priceFetcher = new PriceFetcher(config.dataDir, db);

  function hasTable(name: string): boolean {
    const row = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
      )
      .get(name);
    return !!row;
  }

  function hasMultiBackendTables(): boolean {
    return hasTable("backends")
      && hasTable("backend_global_defaults")
      && hasTable("process_backend_config");
  }

  function backendTablesUnavailableResponse() {
    return {
      error: "multi_backend_unavailable",
      message: "Multi-backend tables are not available. Run migrations first.",
    } as const;
  }

  /**
   * Common error body for destructive write paths that target a backend
   * registered in `BACKEND_IDS` but whose `IAgentCore` is not yet wired
   * into the BackendRouter (`docs/design/appendices/opencode-backend.md` Phase 1: opencode
   * is type-system-registered but its core lands in Phase 2). Returning
   * this at the API layer prevents a process_backend_config row pointing
   * at the not-yet-wired backend from being written and then failing later
   * with `BackendDecisiveFailure(model_unavailable)` at dispatch time.
   */
  function backendNotRuntimeSupportedResponse(backendId: BackendId) {
    return {
      error: "backend_not_runtime_supported",
      message: `Backend "${backendId}" is registered but not yet supported at runtime in this build. Pick one of: ${RUNTIME_AVAILABLE_BACKEND_IDS.join(", ")}.`,
      backendId,
      runtimeAvailableBackends: [...RUNTIME_AVAILABLE_BACKEND_IDS],
    } as const;
  }

  function readDefaults(): BackendDefaultsRow {
    const row = db
      .prepare(
        `SELECT default_backend, default_lite_model, default_medium_model, default_high_model
           FROM backend_global_defaults
          WHERE singleton = 1`,
      )
      .get() as BackendDefaultsRow | undefined;

    if (row) {
      return row;
    }

    return {
      default_backend: "claude",
      default_lite_model: DEFAULT_CLAUDE_LITE_MODEL,
      default_medium_model: DEFAULT_CLAUDE_MEDIUM_MODEL,
      default_high_model: DEFAULT_CLAUDE_HIGH_MODEL,
    };
  }

  function readBackendRows(): BackendRow[] {
    const rows = db
      .prepare(
        `SELECT id, enabled, auth_method, auth_status, auth_checked_at, auth_detail, last_error, web_search_enabled,
                auth_first_expired_at, auth_last_success_at, auth_notification_count
           FROM backends`,
      )
      .all() as BackendRow[];
    const rowById = new Map(rows.map((row) => [row.id, row]));

    // For backends that have never been touched, synthesize a ghost row.
    // `enabled` tracks the configured main backend rather than hard-coding
    // claude: switching `default_backend` to opencode/codex/gemini must not
    // leave the operator with a "disabled" row when no real backends row
    // has been written yet (e.g. fresh install, manual default override).
    const defaults = readDefaults();
    return getBackendIds().map((backendId) => rowById.get(backendId) ?? {
      id: backendId,
      enabled: backendId === defaults.default_backend ? 1 : 0,
      auth_method: null,
      auth_status: "unknown",
      auth_checked_at: null,
      auth_detail: null,
      last_error: null,
      web_search_enabled: 0,
      auth_first_expired_at: null,
      auth_last_success_at: null,
      auth_notification_count: 0,
    });
  }

  function readProcessConfigs(): ProcessConfigRow[] {
    const rows = db
      .prepare(
        `SELECT process_key,
                main_backend,
                main_model,
                fallback_backend,
                fallback_model,
                max_turns,
                max_budget_usd,
                updated_at,
                updated_by
           FROM process_backend_config`,
      )
      .all() as ProcessConfigRow[];
    const rowByKey = new Map(rows.map((row) => [row.process_key, row]));
    const defaults = readDefaults();

    return CONFIGURABLE_PROCESS_KEYS.map((processKey) => {
      const existing = rowByKey.get(processKey);
      if (existing) {
        return existing;
      }

      const tier = getDefaultTierForProcessKey(processKey);
      const tierModel =
        tier === "high"
          ? defaults.default_high_model
          : tier === "medium"
            ? defaults.default_medium_model
            : defaults.default_lite_model;
      return {
        process_key: processKey,
        main_backend: defaults.default_backend,
        main_model: tierModel,
        fallback_backend: null,
        fallback_model: null,
        max_turns: tier === "high" ? 300 : tier === "medium" ? 50 : 20,
        max_budget_usd: tier === "high" ? 5.0 : tier === "medium" ? 1.0 : 0.2,
        updated_at: null,
        updated_by: null,
      };
    });
  }

  function ensureModelBelongsToBackend(
    backendId: BackendId,
    modelId: string,
  ): boolean {
    if (getModelsForBackend(backendId).some((model) => model.modelId === modelId)) {
      return true;
    }
    // opencode's effective catalogue is the live `client.config.providers()`
    // response, which the static registry only seeds the Anthropic preset
    // for. Accept any `<provider>/<model>` composite here; the runtime
    // (`OpencodeCore.execute`) surfaces an unambiguous "Model not found"
    // if the operator typed something the live server can't route to.
    if (backendId === "opencode") {
      const slash = modelId.indexOf("/");
      return slash > 0 && slash < modelId.length - 1;
    }
    return false;
  }

  function ensureBackendEnabled(backendId: BackendId): boolean {
    const row = db
      .prepare("SELECT enabled FROM backends WHERE id = ?")
      .get(backendId) as { enabled: number } | undefined;
    return row?.enabled === 1;
  }

  function getAuthWarnings(
    ...backendIds: (BackendId | null | undefined)[]
  ): Array<{ code: string; backendId: BackendId; message: string }> {
    const warnings: Array<{ code: string; backendId: BackendId; message: string }> = [];
    const checked = new Set<BackendId>();
    for (const id of backendIds) {
      if (!id || checked.has(id)) continue;
      checked.add(id);
      const row = db
        .prepare("SELECT auth_status FROM backends WHERE id = ?")
        .get(id) as { auth_status: string } | undefined;
      const status = row?.auth_status;
      if (status === "ok") continue;
      // Distinguish "never probed" from "probed and failing". The
      // former is an informational nudge ("click Check auth to confirm
      // before using") while the latter is a hard warning. Treating them
      // identically made every fresh install look broken.
      if (!row || status === "unknown") {
        warnings.push({
          code: "auth_unverified",
          backendId: id,
          message: `Backend "${id}" has not been probed yet. Run the auth check from the dashboard to confirm credentials are valid.`,
        });
        continue;
      }
      warnings.push({
        code: "auth_not_verified",
        backendId: id,
        message: `Backend "${id}" has not passed authentication check (status: ${status}). Run auth check to verify.`,
      });
    }
    return warnings;
  }

  function upsertDefaults(
    backendId: BackendId,
    liteModel: string,
    mediumModel: string,
    highModel: string,
  ): void {
    db.prepare(
      `INSERT INTO backend_global_defaults (
         singleton,
         default_backend,
         default_lite_model,
         default_medium_model,
         default_high_model,
         updated_at
       )
       VALUES (1, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(singleton) DO UPDATE SET
         default_backend = excluded.default_backend,
         default_lite_model = excluded.default_lite_model,
         default_medium_model = excluded.default_medium_model,
         default_high_model = excluded.default_high_model,
         updated_at = CURRENT_TIMESTAMP`,
    ).run(backendId, liteModel, mediumModel, highModel);
  }

  function serializeBackends() {
    const defaults = readDefaults();
    return {
      defaultBackend: defaults.default_backend,
      defaultLiteModel: defaults.default_lite_model,
      defaultMediumModel: defaults.default_medium_model,
      defaultHighModel: defaults.default_high_model,
      pricingDataSource: priceFetcher.getStatus(),
      backends: readBackendRows().map((row) => ({
        id: row.id,
        enabled: row.enabled === 1,
        authMethod: row.auth_method,
        authStatus: row.auth_status,
        authCheckedAt: row.auth_checked_at,
        authDetail: row.auth_detail,
        lastError: row.last_error,
        webSearchEnabled: row.web_search_enabled === 1,
        webSearchSupported: WEB_SEARCH_CAPABLE_BACKENDS.has(row.id),
        authFirstExpiredAt: row.auth_first_expired_at,
        authLastSuccessAt: row.auth_last_success_at,
        authNotificationCount: row.auth_notification_count,
        cliInstalled: isCliInstalled(row.id),
        cliCommand: getCliCommand(row.id),
        models: getModelsForBackend(row.id),
      })),
    };
  }

  function serializeProcessConfigs() {
    return {
      configs: readProcessConfigs().map((row) => ({
        processKey: row.process_key,
        defaultTier: getDefaultTierForProcessKey(
          row.process_key as (typeof CONFIGURABLE_PROCESS_KEYS)[number],
        ) as ProcessModelTier,
        mainBackend: row.main_backend,
        mainModel: row.main_model,
        fallbackBackend: row.fallback_backend,
        fallbackModel: row.fallback_model,
        maxTurns: row.max_turns,
        maxBudgetUsd: row.max_budget_usd,
        updatedAt: row.updated_at,
        // 'user' (manual edit, protected from default-preset re-apply),
        // 'preset' (written by applyDefaultPresets), or null (inherited
        // default row).
        updatedBy: row.updated_by,
      })),
    };
  }

  app.get("/backends", (c) => {
    if (!hasMultiBackendTables()) {
      return c.json(backendTablesUnavailableResponse(), 503);
    }
    return c.json(serializeBackends());
  });

  // GET /backends/opencode/live-models — live enumeration over
  // `client.config.providers()` for the model picker. Returns every
  // provider configured on the running opencode server with its full
  // model catalogue + capability + cost metadata, projected and
  // redacted (no provider API keys leave the daemon). Cached in
  // `OpencodeCore` for 5 minutes; pass `?refresh=1` to force-refetch
  // after the operator runs `opencode auth login`.
  app.get("/backends/opencode/live-models", async (c) => {
    const opencodeCore = coreById["opencode"];
    if (!(opencodeCore instanceof OpencodeCore)) {
      return c.json(
        {
          error: "opencode_unavailable",
          message:
            "OpenCode backend is not wired into this daemon build.",
        },
        503,
      );
    }
    const refresh = c.req.query("refresh") === "1";
    try {
      const payload = await opencodeCore.listLiveModels({ forceRefresh: refresh });
      return c.json(payload);
    } catch (err) {
      logger.warn({ err }, "live opencode model enumeration failed");
      // toSafeErrorMessage runs the SDK error through the secret-redaction
      // pass so a stray `Bearer …` or provider key in the error string
      // doesn't reach the dashboard.
      return c.json(
        { error: "live_models_failed", message: toSafeErrorMessage(err, "live_models_failed") },
        502,
      );
    }
  });

  app.put("/backends/defaults", async (c) => {
    if (!hasMultiBackendTables()) {
      return c.json(backendTablesUnavailableResponse(), 503);
    }

    const body = await c.req.json().catch(() => null);
    const parsed = updateDefaultsSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "validation_error", details: parsed.error.flatten() }, 400);
    }

    const {
      defaultBackend,
      defaultLiteModel,
      defaultMediumModel,
      defaultHighModel,
    } = parsed.data;
    if (!isRuntimeAvailableBackendId(defaultBackend)) {
      return c.json(backendNotRuntimeSupportedResponse(defaultBackend), 400);
    }
    if (!ensureBackendEnabled(defaultBackend)) {
      return c.json(
        { error: "backend_disabled", message: `Backend "${defaultBackend}" is not enabled.` },
        409,
      );
    }
    if (!ensureModelBelongsToBackend(defaultBackend, defaultLiteModel)) {
      return c.json(
        { error: "invalid_lite_model", message: "The selected lite model does not belong to the backend." },
        400,
      );
    }
    if (!ensureModelBelongsToBackend(defaultBackend, defaultMediumModel)) {
      return c.json(
        { error: "invalid_medium_model", message: "The selected medium model does not belong to the backend." },
        400,
      );
    }
    if (!ensureModelBelongsToBackend(defaultBackend, defaultHighModel)) {
      return c.json(
        { error: "invalid_high_model", message: "The selected high model does not belong to the backend." },
        400,
      );
    }

    upsertDefaults(defaultBackend, defaultLiteModel, defaultMediumModel, defaultHighModel);
    logger.info(
      { defaultBackend, defaultLiteModel, defaultMediumModel, defaultHighModel },
      "Backend defaults updated",
    );
    const warnings = getAuthWarnings(defaultBackend);
    return c.json({
      status: "updated",
      ...serializeBackends(),
      ...(warnings.length > 0 && { warnings }),
    });
  });

  app.post("/backends/:backendId/check-auth", async (c) => {
    if (!hasMultiBackendTables()) {
      return c.json(backendTablesUnavailableResponse(), 503);
    }

    const backendIdRaw = c.req.param("backendId");
    if (!isBackendId(backendIdRaw)) {
      return c.json({ error: "unknown_backend" }, 404);
    }
    const core = coreById[backendIdRaw];
    if (!core) {
      return c.json({ error: "backend_unavailable" }, 404);
    }

    let detailed: Awaited<ReturnType<typeof core.checkAuthDetailed>>;
    try {
      detailed = await core.checkAuthDetailed();
    } catch (err) {
      // Server-side API key probe may throw on network/timeout errors
      // (roadmap §9.1). Record telemetry but don't flip DB cache.
      deps.authTelemetry?.recordProbeResult(backendIdRaw, "network_error");
      const message =
        err instanceof Error ? err.message : "Auth probe failed";
      // `status: null` because the probe couldn't determine the real
      // status — the DB cache still holds the previous value.
      return c.json(
        {
          backendId: backendIdRaw,
          ok: false,
          status: null,
          method: null,
          detail: `Probe unreachable: ${message}`,
          recoveryCommand: null,
        },
        502,
      );
    }
    // Prefer the AuthHealthMonitor persistence path when available — it
    // handles last_success_at, self-heal telemetry, first_expired_at
    // bookkeeping, AND redaction. Fall back to a plain UPDATE so the
    // dashboard setup wizard still works in contexts without the
    // monitor wired up. The `writeAuth*Detail` helpers apply the same
    // redaction invariant the monitor would have (roadmap §9.2), so
    // this branch can no longer silently leak `Bearer sk-ant-*`
    // fragments from subprocess error messages into SQLite.
    if (deps.authHealthMonitor) {
      deps.authHealthMonitor.persistCheckResult(backendIdRaw, detailed);
    } else {
      db.transaction(() => {
        db.prepare(
          `UPDATE backends
              SET auth_method = ?,
                  auth_status = ?,
                  auth_checked_at = CURRENT_TIMESTAMP,
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`,
        ).run(detailed.method, detailed.status, backendIdRaw);
        if (detailed.ok) {
          writeAuthOkDetail(db, backendIdRaw, detailed.detail ?? null);
        } else {
          writeAuthFailureDetail(db, backendIdRaw, detailed.detail ?? null);
        }
      })();
    }

    return c.json({
      backendId: backendIdRaw,
      ok: detailed.ok,
      status: detailed.status,
      method: detailed.method,
      detail: detailed.detail ?? null,
      recoveryCommand: detailed.recoveryCommand ?? null,
    });
  });

  // ── Phase 5: Auth recovery endpoints ──────────────────────────

  app.post("/backends/:backendId/recovery/start", async (c) => {
    if (!hasMultiBackendTables()) {
      return c.json(backendTablesUnavailableResponse(), 503);
    }
    const backendIdRaw = c.req.param("backendId");
    if (!isBackendId(backendIdRaw)) {
      return c.json({ error: "unknown_backend" }, 404);
    }
    if (!deps.authRecovery) {
      return c.json({ error: "auth_recovery_unavailable" }, 503);
    }
    if (deps.authRecovery.isRecoveryActive(backendIdRaw)) {
      const active = deps.authRecovery.getActiveRecovery(backendIdRaw);
      return c.json({
        error: "recovery_already_active",
        authUrl: active?.authUrl,
        userCode: active?.userCode,
        expiresMinutes: active?.expiresMinutes,
      }, 409);
    }
    try {
      let recovery;
      if (backendIdRaw === "claude") {
        recovery = await deps.authRecovery.initiateClaudeAuth();
      } else if (backendIdRaw === "codex") {
        recovery = await deps.authRecovery.initiateCodexDeviceAuth();
      } else if (backendIdRaw === "gemini") {
        recovery = await deps.authRecovery.initiateGeminiAuth();
      } else if (backendIdRaw === "opencode") {
        // OpenCode's auth model is per-provider via `opencode auth login`
        // and is not an OAuth/device-flow the daemon can drive headlessly.
        // Return 400 with a `message` field so the dashboard's `ApiError`
        // surface (which reads `body.message ?? body.error`) renders the
        // manual command in its existing toast pipeline. The structured
        // `recoveryCommand` field is preserved for programmatic callers.
        return c.json(
          {
            error: "manual_recovery_required",
            backendId: backendIdRaw,
            recoveryCommand: "opencode auth login",
            message:
              "OpenCode recovery is manual. Run `opencode auth login` in a terminal to add or refresh provider credentials, then re-run the auth probe.",
          },
          400,
        );
      } else {
        return c.json({ error: "recovery_not_supported", detail: `Recovery for ${backendIdRaw} is not supported` }, 400);
      }
      return c.json({
        status: "recovering",
        backendId: backendIdRaw,
        authUrl: recovery.authUrl,
        userCode: recovery.userCode,
        expiresMinutes: recovery.expiresMinutes,
        startedAt: recovery.startedAt.toISOString(),
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : "Unknown error";
      logger.warn({ err, backendId: backendIdRaw }, "Auth recovery start failed");
      return c.json({ error: "recovery_failed", detail }, 500);
    }
  });

  app.get("/backends/:backendId/recovery/status", (c) => {
    const backendIdRaw = c.req.param("backendId");
    if (!isBackendId(backendIdRaw)) {
      return c.json({ error: "unknown_backend" }, 404);
    }
    if (!deps.authRecovery) {
      return c.json({ error: "auth_recovery_unavailable" }, 503);
    }
    const active = deps.authRecovery.getActiveRecovery(backendIdRaw);
    if (!active) {
      return c.json({ status: "idle", backendId: backendIdRaw });
    }
    return c.json({
      status: "recovering",
      backendId: backendIdRaw,
      authUrl: active.authUrl,
      userCode: active.userCode,
      expiresMinutes: active.expiresMinutes,
      startedAt: active.startedAt.toISOString(),
    });
  });

  // Phase 6 §5.2: Dashboard submits OAuth auth code for Gemini recovery.
  // The DM interception in the dispatcher is the other path to the same
  // handleGeminiAuthCode method.
  app.post("/backends/:backendId/recovery/code", async (c) => {
    const backendIdRaw = c.req.param("backendId");
    if (!isBackendId(backendIdRaw)) {
      return c.json({ error: "unknown_backend" }, 404);
    }
    if (backendIdRaw !== "gemini") {
      return c.json({ error: "not_supported", detail: "Auth code submission is only supported for Gemini" }, 400);
    }
    if (!deps.authRecovery) {
      return c.json({ error: "auth_recovery_unavailable" }, 503);
    }
    if (!deps.authRecovery.isRecoveryActive("gemini")) {
      return c.json({ error: "no_active_recovery", detail: "No active Gemini recovery session" }, 409);
    }
    try {
      const body = await c.req.json<{ code?: string }>();
      if (!body.code || typeof body.code !== "string" || !body.code.trim()) {
        return c.json({ error: "invalid_code", detail: "Authorization code is required" }, 400);
      }
      const result = await deps.authRecovery.handleGeminiAuthCode(body.code.trim());
      return c.json({
        status: result.ok ? "ok" : "failed",
        detail: result.detail,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : "Unknown error";
      logger.warn({ err, backendId: backendIdRaw }, "Auth code exchange failed");
      return c.json({ error: "code_exchange_failed", detail }, 500);
    }
  });

  app.post("/backends/:backendId/recovery/cancel", (c) => {
    const backendIdRaw = c.req.param("backendId");
    if (!isBackendId(backendIdRaw)) {
      return c.json({ error: "unknown_backend" }, 404);
    }
    if (!deps.authRecovery) {
      return c.json({ error: "auth_recovery_unavailable" }, 503);
    }
    const cancelled = deps.authRecovery.cancelRecovery(backendIdRaw);
    return c.json({
      status: cancelled ? "cancelled" : "no_active_recovery",
      backendId: backendIdRaw,
    });
  });

  app.post("/backends/:backendId/enable", (c) => {
    if (!hasMultiBackendTables()) {
      return c.json(backendTablesUnavailableResponse(), 503);
    }

    const backendIdRaw = c.req.param("backendId");
    if (!isBackendId(backendIdRaw)) {
      return c.json({ error: "unknown_backend" }, 404);
    }

    db.prepare(
      `UPDATE backends
          SET enabled = 1,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
    ).run(backendIdRaw);

    return c.json({
      status: "enabled",
      ...serializeBackends(),
    });
  });

  app.post("/backends/:backendId/disable", (c) => {
    if (!hasMultiBackendTables()) {
      return c.json(backendTablesUnavailableResponse(), 503);
    }

    const backendIdRaw = c.req.param("backendId");
    if (!isBackendId(backendIdRaw)) {
      return c.json({ error: "unknown_backend" }, 404);
    }

    const defaults = readDefaults();
    if (defaults.default_backend === backendIdRaw) {
      return c.json(
        {
          error: "default_backend",
          message: "Reassign the default backend before disabling it.",
        },
        409,
      );
    }

    const inUse = db
      .prepare(
        `SELECT process_key
           FROM process_backend_config
          WHERE main_backend = ?
             OR fallback_backend = ?
          ORDER BY process_key`,
      )
      .all(backendIdRaw, backendIdRaw) as { process_key: string }[];
    if (inUse.length > 0) {
      return c.json(
        {
          error: "backend_in_use",
          processKeys: inUse.map((row) => row.process_key),
        },
        409,
      );
    }

    db.prepare(
      `UPDATE backends
          SET enabled = 0,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
    ).run(backendIdRaw);

    return c.json({
      status: "disabled",
      ...serializeBackends(),
    });
  });

  app.post("/backends/:backendId/web-search", async (c) => {
    if (!hasMultiBackendTables()) {
      return c.json(backendTablesUnavailableResponse(), 503);
    }

    const backendIdRaw = c.req.param("backendId");
    if (!isBackendId(backendIdRaw)) {
      return c.json({ error: "unknown_backend" }, 404);
    }

    const body = await c.req.json().catch(() => null);
    const enabled = typeof body?.enabled === "boolean" ? body.enabled : null;
    if (enabled === null) {
      return c.json({ error: "validation_error", message: "Body must contain { enabled: boolean }" }, 400);
    }

    if (!WEB_SEARCH_CAPABLE_BACKENDS.has(backendIdRaw)) {
      return c.json(
        { error: "unsupported", message: `Web search is not available for the ${backendIdRaw} backend.` },
        400,
      );
    }

    if (!ensureBackendEnabled(backendIdRaw)) {
      return c.json(
        { error: "backend_disabled", message: `Backend "${backendIdRaw}" is not enabled.` },
        409,
      );
    }

    db.prepare(
      `UPDATE backends
          SET web_search_enabled = ?,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
    ).run(enabled ? 1 : 0, backendIdRaw);

    logger.info({ backendId: backendIdRaw, webSearchEnabled: enabled }, "Backend web search toggled");
    return c.json({
      status: "updated",
      ...serializeBackends(),
    });
  });

  app.post("/backends/pricing-source/refresh", async (c) => {
    if (!hasMultiBackendTables()) {
      return c.json(backendTablesUnavailableResponse(), 503);
    }

    await priceFetcher.refresh();
    return c.json({
      status: "refreshed",
      ...serializeBackends(),
    });
  });

  // ── CLI install endpoints ──────────────────────────────────────

  app.get("/backends/install-methods", (c) => {
    return c.json(getInstallMethods());
  });

  const installBodySchema = z.object({
    method: z.string().min(1),
  });

  app.post("/backends/:backendId/install", async (c) => {
    const backendIdRaw = c.req.param("backendId");
    if (!isBackendId(backendIdRaw)) {
      return c.json({ error: "unknown_backend" }, 404);
    }

    const body = await c.req.json().catch(() => null);
    const parsed = installBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "validation_error", details: parsed.error.flatten() }, 400);
    }

    const resolved = resolveInstallCommand(backendIdRaw, parsed.data.method);
    if (!resolved) {
      return c.json(
        {
          error: "unknown_method",
          message: `Install method "${parsed.data.method}" is not available for ${backendIdRaw} on this platform, or requires manual execution in a terminal.`,
        },
        400,
      );
    }

    logger.info(
      { backendId: backendIdRaw, method: parsed.data.method, command: resolved.command },
      "Starting CLI install",
    );

    try {
      const result = await runLineCommand({
        command: resolved.executable,
        args: resolved.args,
        cwd: process.cwd(),
        timeoutMs: 5 * 60 * 1000, // 5 minutes
      });

      const ok = result.exitCode === 0;
      if (ok) {
        logger.info({ backendId: backendIdRaw, method: parsed.data.method }, "CLI install succeeded");
      } else {
        logger.warn(
          { backendId: backendIdRaw, exitCode: result.exitCode, stderr: result.stderrLines.slice(-10) },
          "CLI install failed",
        );
      }

      return c.json({
        ok,
        exitCode: result.exitCode,
        stdout: result.stdoutLines.join("\n"),
        stderr: result.stderrLines.join("\n"),
        timedOut: result.timedOut,
        cliInstalled: isCliInstalled(backendIdRaw),
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : "Install command failed";
      logger.error({ err, backendId: backendIdRaw }, "CLI install error");
      return c.json({ ok: false, error: "install_failed", detail }, 500);
    }
  });

  // Verify the backend's CLI is on PATH AND can actually execute. Runs
  // `<cli> --version` with a short timeout. Read-only smoke test — does
  // not touch the backends table or auth state.
  app.post("/backends/:backendId/verify-install", async (c) => {
    const backendIdRaw = c.req.param("backendId");
    if (!isBackendId(backendIdRaw)) {
      return c.json({ error: "unknown_backend" }, 404);
    }

    const cliCommand = getCliCommand(backendIdRaw);
    const installed = isCliInstalled(backendIdRaw);
    if (!installed) {
      return c.json({
        ok: false,
        cliInstalled: false,
        cliCommand,
        exitCode: null,
        version: null,
        stdout: "",
        stderr: `${cliCommand} not found on PATH`,
        timedOut: false,
      });
    }

    try {
      const result = await runLineCommand({
        command: cliCommand,
        args: ["--version"],
        cwd: process.cwd(),
        timeoutMs: 10_000,
      });
      const stdout = result.stdoutLines.join("\n");
      const stderr = result.stderrLines.join("\n");
      const ok = result.exitCode === 0 && !result.timedOut;
      const version = ok ? (stdout.trim() || stderr.trim() || null) : null;
      // Auth verify was removed from the setup flow; verify-install is
      // now the single signal the wizard uses to decide whether a
      // backend is "ready". Treat a successful run as the operator
      // expressing intent to use this backend, and flip
      // backends.enabled = 1 so it shows up in delegated-mode pickers
      // and routing. Idempotent — already-enabled rows are unaffected
      // beyond the updated_at bump. The explicit Disable button in
      // /settings/models is still authoritative if the user later opts
      // out.
      if (ok && hasMultiBackendTables()) {
        db.prepare(
          `UPDATE backends
              SET enabled = 1,
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`,
        ).run(backendIdRaw);
      }
      return c.json({
        ok,
        cliInstalled: true,
        cliCommand,
        exitCode: result.exitCode,
        version,
        stdout,
        stderr,
        timedOut: result.timedOut,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : "Verify install failed";
      logger.warn({ err, backendId: backendIdRaw }, "verify-install error");
      return c.json({
        ok: false,
        cliInstalled: true,
        cliCommand,
        exitCode: null,
        version: null,
        stdout: "",
        stderr: detail,
        timedOut: false,
      });
    }
  });

  app.get("/process-config", (c) => {
    if (!hasMultiBackendTables()) {
      return c.json(backendTablesUnavailableResponse(), 503);
    }
    return c.json(serializeProcessConfigs());
  });

  app.put("/process-config/:processKey", async (c) => {
    if (!hasMultiBackendTables()) {
      return c.json(backendTablesUnavailableResponse(), 503);
    }

    const processKey = c.req.param("processKey");
    if (!isConfigurableProcessKey(processKey)) {
      return c.json({ error: "unknown_process_key" }, 404);
    }

    const body = await c.req.json().catch(() => null);
    const parsed = updateProcessConfigSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "validation_error", details: parsed.error.flatten() }, 400);
    }

    const {
      mainBackend,
      mainModel,
      fallbackBackend,
      fallbackModel,
      maxTurns,
      maxBudgetUsd,
    } = parsed.data;

    if (!isRuntimeAvailableBackendId(mainBackend)) {
      return c.json(backendNotRuntimeSupportedResponse(mainBackend), 400);
    }
    if (!ensureBackendEnabled(mainBackend)) {
      return c.json(
        { error: "main_backend_disabled", message: `Backend "${mainBackend}" is not enabled.` },
        409,
      );
    }
    if (!ensureModelBelongsToBackend(mainBackend, mainModel)) {
      return c.json(
        { error: "invalid_main_model", message: "The selected main model does not belong to the backend." },
        400,
      );
    }

    const normalizedFallbackBackend = fallbackBackend ?? null;
    const normalizedFallbackModel = fallbackModel?.trim() ? fallbackModel : null;
    if ((normalizedFallbackBackend === null) !== (normalizedFallbackModel === null)) {
      return c.json(
        {
          error: "fallback_incomplete",
          message: "Fallback backend and model must be set together.",
        },
        400,
      );
    }
    if (normalizedFallbackBackend && normalizedFallbackBackend === mainBackend) {
      return c.json(
        {
          error: "fallback_same_as_main",
          message: "Fallback backend must differ from the main backend.",
        },
        400,
      );
    }
    if (
      normalizedFallbackBackend
      && !isRuntimeAvailableBackendId(normalizedFallbackBackend)
    ) {
      return c.json(
        backendNotRuntimeSupportedResponse(normalizedFallbackBackend),
        400,
      );
    }
    if (normalizedFallbackBackend && !ensureBackendEnabled(normalizedFallbackBackend)) {
      return c.json(
        {
          error: "fallback_backend_disabled",
          message: `Backend "${normalizedFallbackBackend}" is not enabled.`,
        },
        409,
      );
    }
    if (
      normalizedFallbackBackend
      && normalizedFallbackModel
      && !ensureModelBelongsToBackend(normalizedFallbackBackend, normalizedFallbackModel)
    ) {
      return c.json(
        {
          error: "invalid_fallback_model",
          message: "The selected fallback model does not belong to the backend.",
        },
        400,
      );
    }

    // Manual edit from the dashboard — tag as `updated_by='user'` so the
    // plan-preset apply path won't clobber it on subsequent re-applies.
    // Routed through `setProcessBackendConfig` so the cascade fires when
    // the operator edits a source ProcessKey (e.g. message.dm).
    setProcessBackendConfig(db, {
      processKey,
      mainBackend,
      mainModel,
      fallbackBackend: normalizedFallbackBackend,
      fallbackModel: normalizedFallbackModel,
      maxTurns,
      maxBudgetUsd,
      updatedBy: "user",
    });

    const updated = serializeProcessConfigs().configs.find(
      (row) => row.processKey === processKey,
    );
    logger.info({ processKey, mainBackend, mainModel, fallbackBackend: normalizedFallbackBackend }, "Process config updated");
    const warnings = getAuthWarnings(mainBackend, normalizedFallbackBackend);
    return c.json({
      status: "updated",
      config: updated,
      ...(warnings.length > 0 && { warnings }),
    });
  });

  // ── Main backend selection + default presets ──

  // GET /api/backends/main/preview?backendId=... — dry-run of a
  // main-switch so the dashboard can show the user which user-pinned
  // rows will be preserved on non-main backends before they confirm.
  app.get("/backends/main/preview", (c) => {
    if (!hasMultiBackendTables()) {
      return c.json(backendTablesUnavailableResponse(), 503);
    }
    const raw = c.req.query("backendId");
    if (!raw || !isBackendId(raw)) {
      return c.json({ error: "unknown_backend" }, 400);
    }
    return c.json({
      backendId: raw,
      ...previewMainSwitchImpact(db, raw),
    });
  });

  // PUT /api/backends/main — set the main backend. Re-seeds default
  // process_backend_config rows for the new backend; user-pinned rows
  // (updated_by='user') survive unless `force=true` is passed.
  const putMainSchema = z.object({
    backendId: z.string().refine(isBackendId),
    force: z.boolean().optional(),
  });

  app.put("/backends/main", async (c) => {
    if (!hasMultiBackendTables()) {
      return c.json(backendTablesUnavailableResponse(), 503);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = putMainSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "validation_error", details: parsed.error.flatten() },
        400,
      );
    }
    const { backendId, force } = parsed.data;
    if (!isRuntimeAvailableBackendId(backendId)) {
      return c.json(backendNotRuntimeSupportedResponse(backendId), 400);
    }
    const previousMain = readDefaults().default_backend;

    setMainBackend(db, backendId);
    const result = applyDefaultPresets(db, {
      defaultBackend: backendId,
      force: force ?? false,
    });

    const warnings = getAuthWarnings(backendId);
    logger.info(
      {
        backendId,
        force: force ?? false,
        processRowsUpdated: result.processRowsUpdated,
        processRowsSkipped: result.processRowsSkipped,
      },
      "Main backend switched",
    );

    // INTEGRATION_NATIVE_MODE_DESIGN.md §11.4 — main-backend change
    // cascade. Capture the pre-cascade snapshot of each native row so we
    // can write `integration.native_unbound` audit rows for any row that
    // gets flipped to `disabled`. Runs BEFORE the `onMainBackendChange`
    // notification so the workdir re-materialise step sees the post-
    // cascade state and the skill bundle reflects the new mode.
    let nativeCascade: ReturnType<typeof cascadeNativeBindingsOnMainSwitch> = [];
    if (backendId !== previousMain) {
      const integrationsBefore = readIntegrations(db);
      nativeCascade = cascadeNativeBindingsOnMainSwitch(db, backendId);
      for (const entry of nativeCascade) {
        try {
          db.prepare(
            `INSERT INTO agent_actions
               (event_id, action_type, trigger, result, detail, started_at, completed_at)
             VALUES (?, 'integration.native_unbound', 'reactive', 'success', ?, datetime('now'), datetime('now'))`,
          ).run(
            `integration:${entry.key}:native_unbound:${Date.now()}`,
            JSON.stringify({
              key: entry.key,
              priorMode: "native",
              priorNativeBackend: entry.priorNativeBackend,
              newMainBackend: entry.newMainBackend,
              // Carry the deniedTools snapshot so a future re-flip-to-
              // native restore can be reconstructed without re-querying
              // the now-cleared row.
              priorDeniedTools:
                integrationsBefore[entry.key].deniedTools ?? [],
            }),
          );
        /* c8 ignore start -- in-memory DB always succeeds; catch is defensive */
        } catch (err) {
          logger.warn(
            { err, key: entry.key },
            "failed to write integration.native_unbound audit row",
          );
        }
        /* c8 ignore stop */
      }

      // INTEGRATION_NATIVE_MODE_DESIGN.md §11.4 — cascade flipped native
      // rows to `disabled` directly in the DB. Mirror that into the
      // on-disk `integrations.md` so the human-readable file does not
      // drift; the PATCH route always pairs the DB write with this same
      // `writeManagementMd` call. Without it, a user inspecting
      // `~/.personal-agent/integrations.md` after a main-backend switch
      // would still see `mode: native` for the cascaded rows until the
      // next manual PATCH triggers a resync.
      if (nativeCascade.length > 0) {
        try {
          await writeManagementMd(config.dataDir, readIntegrations(db), {
            externalObsidianVaultPath: config.externalObsidianVaultPath,
            externalObsidianWatch: config.externalObsidianWatch,
          });
        /* c8 ignore start -- writeManagementMd never throws with the in-memory
         * test harness; the catch keeps the cascade idempotent if a disk
         * write fails in production (DB stays authoritative, next PATCH
         * resyncs the file). */
        } catch (err) {
          logger.warn(
            { err, count: nativeCascade.length },
            "writeManagementMd failed after native cascade — DB is up-to-date but integrations.md is stale until the next PATCH",
          );
        }
        /* c8 ignore stop */
      }

      // §11.4 surfacing — notify the owner so the disabled integrations
      // aren't a silent failure. The cascade only fires when the user
      // explicitly switched main backends, so the DM lands as a direct
      // consequence of that action. Single batched message; the
      // dashboard banner (driven by `nativeUnbound` in the response
      // body) carries the same information visually.
      if (nativeCascade.length > 0 && deps.sendNotification) {
        const keys = nativeCascade.map((e) => e.key).join(", ");
        const priorBackends = Array.from(
          new Set(nativeCascade.map((e) => e.priorNativeBackend)),
        ).join("/");
        const message =
          `Main backend changed to ${backendId}. ` +
          `Native mode was bound to ${priorBackends} for ${keys}; ` +
          `those integrations are now disabled until you re-configure ` +
          `them via /settings/integrations.`;
        try {
          await deps.sendNotification({
            message,
            priority: "normal",
            notificationType: "integration.native_unbound",
          });
        /* c8 ignore start -- sendNotification swallows transport errors
         * internally; this catch only fires when the dispatcher rejects
         * the call (e.g. setup-in-progress gate). Logging keeps the
         * forensic chain intact via the audit rows above. */
        } catch (err) {
          logger.warn(
            { err, keys: nativeCascade.map((e) => e.key) },
            "failed to DM owner about native cascade — audit rows still record the event",
          );
        }
        /* c8 ignore stop */
      }
    }

    if (backendId !== previousMain) {
      // DELEGATED-MODE-V2-DESIGN.md §4.4 — flipping the main backend
      // turns same-backend delegated integrations into cross-backend
      // (and vice versa), changing the resolved skill variant and the
      // per-backend instruction file baked into active DM workdirs.
      // INTEGRATION_NATIVE_MODE_DESIGN.md §11.4 — native rows that were
      // just cascaded need the same workdir refresh so the next session
      // doesn't read a stale SKILL.native.*.md body for a backend the
      // user no longer routes through.
      deps.onMainBackendChange?.("main_backend_change");
    }

    // §4.12.4 "Backend change while delegated" — read-only detection.
    // Dispatch-time guards own enforcement; we just emit a logger.warn
    // for operator visibility on incompat cases.
    checkDelegatedCompatForNewMain(db, backendId);

    return c.json({
      status: "applied",
      result,
      // §11.4 surfacing — the dashboard's red "Re-configure" banner reads
      // this so the user knows their Gmail/Calendar/Notion native bindings
      // went dormant. Empty array when no native rows were touched.
      nativeUnbound: nativeCascade,
      ...serializeBackends(),
      ...serializeProcessConfigs(),
      ...(warnings.length > 0 && { warnings }),
    });
  });

  /**
   * POST /api/backends/apply-defaults — manual re-seed from
   * /settings/models "Reset to defaults" button. Defaults to
   * `force: false` so user-pinned rows (updated_by='user') survive.
   * Use `force: true` to overwrite all rows.
   */
  const applyDefaultsSchema = z.object({
    force: z.boolean().optional(),
  });

  app.post("/backends/apply-defaults", async (c) => {
    if (!hasMultiBackendTables()) {
      return c.json(backendTablesUnavailableResponse(), 503);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = applyDefaultsSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "validation_error", details: parsed.error.flatten() },
        400,
      );
    }

    const result = applyDefaultPresets(db, { force: parsed.data.force ?? false });

    logger.info(
      {
        backend: result.backend,
        force: parsed.data.force ?? false,
        processRowsUpdated: result.processRowsUpdated,
        processRowsSkipped: result.processRowsSkipped,
      },
      "Default presets re-applied",
    );

    return c.json({
      status: "applied",
      result,
      ...serializeBackends(),
      ...serializeProcessConfigs(),
    });
  });

  // ── Advisor settings ──

  app.get("/backends/advisor", (c) => {
    if (!hasMultiBackendTables()) {
      return c.json(backendTablesUnavailableResponse(), 503);
    }
    const row = db
      .prepare(
        "SELECT advisor_enabled, advisor_model FROM backend_global_defaults WHERE singleton = 1",
      )
      .get() as
        | { advisor_enabled: number; advisor_model: string | null }
        | undefined;
    return c.json({
      enabled: row?.advisor_enabled === 1,
      model: row?.advisor_model ?? null,
    });
  });

  const advisorUpdateSchema = z
    .object({
      enabled: z.boolean(),
      // SDK 0.2.98 advisor allowlist — see ADVISOR_ALLOWED_MODELS in
      // @aitne/shared. Update that constant when the SDK
      // extends its compatibility list; this schema picks it up
      // automatically.
      model: z
        .string()
        .refine((v) => isAdvisorModel(v), {
          message: `model must be one of: ${ADVISOR_ALLOWED_MODELS.map((m) => `'${m}'`).join(", ")}`,
        })
        .nullable()
        .optional()
        .default(null),
    })
    .refine(
      (data) => !data.enabled || (data.model !== null && data.model !== undefined),
      { message: "model is required when enabled is true" },
    );

  app.put("/backends/advisor", async (c) => {
    if (!hasMultiBackendTables()) {
      return c.json(backendTablesUnavailableResponse(), 503);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = advisorUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "validation_error", details: parsed.error.flatten() },
        400,
      );
    }

    const enabled = parsed.data.enabled;
    const model = enabled ? parsed.data.model ?? null : null;

    // The singleton row + advisor columns are guaranteed by applySchema.
    // A plain UPDATE is safe because the caller already passed the
    // hasMultiBackendTables() gate.
    const updateResult = db
      .prepare(
        `UPDATE backend_global_defaults
            SET advisor_enabled = ?,
                advisor_model = ?,
                updated_at = CURRENT_TIMESTAMP
          WHERE singleton = 1`,
      )
      .run(enabled ? 1 : 0, model);

    if (updateResult.changes === 0) {
      return c.json(
        {
          error: "defaults_row_missing",
          message:
            "backend_global_defaults singleton row is missing. Run migrations before configuring advisor.",
        },
        503,
      );
    }

    // Mirror into the live config so the next query() call includes the
    // advisor setting without a daemon restart. `applyConfigUpdates` is the
    // canonical mutation path and handles runtime persistence.
    const settingsStore = createSettingsStore(db);
    await applyConfigUpdates(config, settingsStore, {
      advisorEnabled: enabled,
      advisorModel: model,
    });

    logger.info({ advisorEnabled: enabled, advisorModel: model }, "Advisor settings updated");
    return c.json({ status: "updated", enabled, model });
  });

  // ── Per-backend provider auth (stored in OS keychain) ─────────
  // The dashboard surface for direct API keys (Anthropic / OpenAI /
  // Google) and Claude's cloud-provider deployments (Bedrock / Vertex /
  // Foundry). When a value is configured here, it is mirrored into
  // `process.env` and takes precedence over whatever the operator may
  // have exported in their shell. When cleared, the captured shell
  // value (if any) is restored as the fallback. Backends with no
  // configured value continue using their CLI login / OAuth path
  // unchanged.

  async function refreshAuthAfterApiKeyChange(
    backendId: BackendId,
  ): Promise<{
    ok: boolean;
    status: string | null;
    detail: string | null;
    method: string | null;
  } | null> {
    const core = coreById[backendId];
    if (!core) return null;
    try {
      const detailed = await core.checkAuthDetailed();
      if (deps.authHealthMonitor) {
        deps.authHealthMonitor.persistCheckResult(backendId, detailed);
      } else {
        db.transaction(() => {
          db.prepare(
            `UPDATE backends
                SET auth_method = ?,
                    auth_status = ?,
                    auth_checked_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
              WHERE id = ?`,
          ).run(detailed.method, detailed.status, backendId);
          if (detailed.ok) {
            writeAuthOkDetail(db, backendId, detailed.detail ?? null);
          } else {
            writeAuthFailureDetail(db, backendId, detailed.detail ?? null);
          }
        })();
      }
      return {
        ok: detailed.ok,
        status: detailed.status,
        detail: detailed.detail ?? null,
        method: detailed.method,
      };
    } catch (err) {
      // Probe network errors must not flip the cached status. Surface
      // the failure inline so the dashboard can show "saved, but probe
      // unreachable — click Verify Auth later".
      deps.authTelemetry?.recordProbeResult(backendId, "network_error");
      const message =
        err instanceof Error ? err.message : "Auth probe failed";
      return {
        ok: false,
        status: null,
        detail: `Probe unreachable: ${message}`,
        method: null,
      };
    }
  }

  app.get("/backends/:backendId/api-key", async (c) => {
    const backendIdRaw = c.req.param("backendId");
    if (!isBackendId(backendIdRaw)) {
      return c.json({ error: "unknown_backend" }, 404);
    }
    try {
      const description = await describeBackendApiKey(
        deps.secretBroker,
        backendIdRaw,
      );
      return c.json({
        backendId: backendIdRaw,
        configured: description.configured,
        source: description.source,
        provider: description.provider,
        envVarNames: description.envVarNames,
        availableProviders: API_KEY_PROVIDERS_BY_BACKEND[backendIdRaw],
      });
    } catch (err) {
      logger.warn(
        { err, backendId: backendIdRaw },
        "Failed to read backend API key configuration",
      );
      return c.json(
        { error: "secret_store_unavailable" },
        500,
      );
    }
  });

  // PUT body accepts EITHER:
  //   - { apiKey: "<raw key>" } — legacy direct-key form, promoted to the
  //     backend's default direct provider (anthropic / openai / google).
  //   - { config: BackendApiKeyConfig } — typed config supporting cloud
  //     providers (Bedrock / Vertex / Foundry) for Claude. The provider
  //     discriminator must match one of the backend's allowed providers.
  const putApiKeySchema = z.union([
    z.object({ apiKey: z.string().min(1) }),
    z.object({ config: backendApiKeyConfigSchema }),
  ]);

  app.put("/backends/:backendId/api-key", async (c) => {
    const backendIdRaw = c.req.param("backendId");
    if (!isBackendId(backendIdRaw)) {
      return c.json({ error: "unknown_backend" }, 404);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = putApiKeySchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "validation_error", details: parsed.error.flatten() },
        400,
      );
    }

    // Local var named `apiKeyConfig` to avoid shadowing the closure-scope
    // `config` (the daemon's AgentConfig — has dataDir / apiPort / etc.).
    let apiKeyConfig: BackendApiKeyConfig;
    if ("config" in parsed.data) {
      apiKeyConfig = parsed.data.config;
    } else {
      const apiKey = parsed.data.apiKey.trim();
      if (!apiKey) {
        return c.json(
          {
            error: "invalid_format",
            message: "API key cannot be empty.",
          },
          400,
        );
      }
      // Promote raw-string body to the default direct provider for this
      // backend so the legacy single-field PUT continues to work.
      switch (backendIdRaw) {
        case "claude":
          apiKeyConfig = { provider: "anthropic", apiKey };
          break;
        case "codex":
          apiKeyConfig = { provider: "openai", apiKey };
          break;
        case "gemini":
          apiKeyConfig = { provider: "google", apiKey };
          break;
        case "opencode":
          return c.json(
            {
              error: "structured_config_required",
              message: "OpenCode requires a structured server configuration.",
            },
            400,
          );
      }
    }

    const formatHint = validateBackendApiKeyConfigFormat(
      backendIdRaw,
      apiKeyConfig,
    );
    if (formatHint !== null) {
      return c.json(
        {
          error: "invalid_format",
          message: formatHint,
        },
        400,
      );
    }

    try {
      await deps.secretBroker.setBackendApiKeyConfig(
        backendIdRaw,
        apiKeyConfig,
      );
    } catch (err) {
      logger.error(
        { err, backendId: backendIdRaw },
        "Failed to write backend API key to keychain",
      );
      return c.json(
        {
          error: "secret_store_unavailable",
          message: "Could not persist the API key to the OS keychain.",
        },
        500,
      );
    }

    const syncResult = await syncBackendApiKeyToEnv(
      deps.secretBroker,
      backendIdRaw,
      process.env,
      { dataDir: config.dataDir },
    );
    const auth = await refreshAuthAfterApiKeyChange(backendIdRaw);

    logger.info(
      {
        backendId: backendIdRaw,
        source: syncResult.source,
        provider: syncResult.provider,
        authOk: auth?.ok,
      },
      "Backend API key updated via dashboard",
    );

    return c.json({
      status: "saved",
      backendId: backendIdRaw,
      source: syncResult.source,
      provider: syncResult.provider,
      auth,
    });
  });

  app.delete("/backends/:backendId/api-key", async (c) => {
    const backendIdRaw = c.req.param("backendId");
    if (!isBackendId(backendIdRaw)) {
      return c.json({ error: "unknown_backend" }, 404);
    }

    try {
      await deps.secretBroker.deleteBackendApiKey(backendIdRaw);
    } catch (err) {
      logger.error(
        { err, backendId: backendIdRaw },
        "Failed to delete backend API key from keychain",
      );
      return c.json(
        {
          error: "secret_store_unavailable",
          message: "Could not remove the API key from the OS keychain.",
        },
        500,
      );
    }

    const syncResult = await syncBackendApiKeyToEnv(
      deps.secretBroker,
      backendIdRaw,
      process.env,
      { dataDir: config.dataDir },
    );
    const auth = await refreshAuthAfterApiKeyChange(backendIdRaw);

    logger.info(
      { backendId: backendIdRaw, source: syncResult.source, authOk: auth?.ok },
      "Backend API key cleared via dashboard",
    );

    return c.json({
      status: "cleared",
      backendId: backendIdRaw,
      source: syncResult.source,
      provider: syncResult.provider,
      auth,
    });
  });

  app.get("/chat/current-binding", (c) => {
    const defaults = readDefaults();
    const result = queryChatBinding(db, {
      backend: defaults.default_backend,
      highModel: defaults.default_high_model,
    });
    if (!result) {
      return c.json(backendTablesUnavailableResponse(), 503);
    }

    return c.json({
      processKey: "dashboard.chat",
      mainBackend: result.mainBackend,
      mainModel: result.mainModel,
      fallbackBackend: result.fallbackBackend,
      fallbackModel: result.fallbackModel,
      activeBackend: result.activeBackend,
      activeModel: result.activeModel,
      activeModelLabel: result.activeModelLabel,
      fallbackActive: result.fallbackActive,
    });
  });

  return app;
}
