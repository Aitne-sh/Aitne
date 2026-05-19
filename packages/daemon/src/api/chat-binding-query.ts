import type Database from "better-sqlite3";
import type { BackendId } from "@aitne/shared";
import {
  DASHBOARD_CHAT_SCOPE,
  DASHBOARD_SCOPE_KEY,
} from "../messaging/constants.js";
import { getModelLabel } from "../core/backends/model-registry.js";

/** Partial session info payload sent via SSE — frontend merges incrementally. */
export interface SessionInfoPayload {
  channelId?: string;
  sessionId?: number;
  model?: string;
  backend?: string;
  modelLabel?: string;
  costUsd?: number;
}

export interface ChatBindingResult {
  mainBackend: BackendId;
  mainModel: string;
  fallbackBackend: BackendId | null;
  fallbackModel: string | null;
  activeBackend: BackendId;
  activeModel: string;
  activeModelLabel: string;
  fallbackActive: boolean;
}

/**
 * Query the effective chat binding from DB tables.
 * Returns null if multi-backend tables don't exist yet.
 *
 * @param fallbackConfig — used when no DB defaults row exists (pre-migration).
 *   `highModel` is the seed value for `default_high_model` when the row is
 *   absent; the chat binding itself defaults to medium tier (dashboard.chat
 *   is a medium-tier process key — see process-key.ts), but high is read
 *   here so the fallback row is fully populated for downstream callers.
 */
export function queryChatBinding(
  db: Database.Database,
  fallbackConfig: { backend: BackendId; highModel: string },
): ChatBindingResult | null {
  // All three tables are required
  const requiredTables = ["backends", "backend_global_defaults", "process_backend_config"];
  for (const name of requiredTables) {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(name);
    if (!exists) return null;
  }

  const defaults = db
    .prepare(
      "SELECT default_backend, default_medium_model, default_high_model FROM backend_global_defaults WHERE singleton = 1",
    )
    .get() as
    | {
        default_backend: BackendId;
        default_medium_model: string;
        default_high_model: string;
      }
    | undefined;

  const defaultBackend = defaults?.default_backend ?? fallbackConfig.backend;
  // dashboard.chat sits at medium tier; fall back to that column when no
  // pinned process row exists. `default_high_model` from the row stays
  // available for callers that want the high-tier seed.
  const defaultMediumModel =
    defaults?.default_medium_model ?? fallbackConfig.highModel;

  const chatConfig = db
    .prepare(
      "SELECT main_backend, main_model, fallback_backend, fallback_model FROM process_backend_config WHERE process_key = 'dashboard.chat'",
    )
    .get() as {
    main_backend: BackendId | null;
    main_model: string | null;
    fallback_backend: BackendId | null;
    fallback_model: string | null;
  } | undefined;

  const mainBackend = chatConfig?.main_backend ?? defaultBackend;
  const mainModel = chatConfig?.main_model ?? defaultMediumModel;

  const active = db
    .prepare(
      `SELECT backend, model, backend_session_id
         FROM conversation_sessions
        WHERE scope = ?
          AND scope_key = ?
          AND status = 'active'
        ORDER BY last_message_at DESC
        LIMIT 1`,
    )
    .get(DASHBOARD_CHAT_SCOPE, DASHBOARD_SCOPE_KEY) as {
    backend: BackendId | null;
    model: string | null;
    backend_session_id: string | null;
  } | undefined;

  // Only trust the session's model after the backend has actually run
  // (backend_session_id is set by updateSession when the first turn completes).
  // Before that, the session model is just a placeholder from creation time
  // and should NOT override the user's process-level configuration.
  const sessionActivated = active?.backend_session_id != null;
  const activeBackend = sessionActivated ? (active?.backend ?? mainBackend) : mainBackend;
  const activeModel = sessionActivated ? (active?.model ?? mainModel) : mainModel;

  return {
    mainBackend,
    mainModel,
    fallbackBackend: chatConfig?.fallback_backend ?? null,
    fallbackModel: chatConfig?.fallback_model ?? null,
    activeBackend,
    activeModel,
    activeModelLabel: getModelLabel(activeBackend, activeModel),
    fallbackActive: activeBackend !== mainBackend,
  };
}
