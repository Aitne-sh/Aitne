import type Database from "better-sqlite3";
import {
  INTEGRATION_KEYS,
  backendHasIntegrationConnector,
  isBackendId,
  type BackendId,
  type IntegrationKey,
  type IntegrationState,
} from "@aitne/shared";
import {
  readIntegrations,
  updateIntegrationState,
} from "../db/integrations-store.js";
import { createLogger } from "../logging.js";

const logger = createLogger("integration-main-backend");

/**
 * Read the currently-configured main backend id from
 * `backend_global_defaults.default_backend`. Returns null when the row is
 * absent (fresh installs before setup) or carries a value that does not
 * match `BackendId` — both treated by callers as "no main backend known
 * yet". A single source of truth so the integrations PATCH route and the
 * main-backend cascade agree on the value.
 */
export function readMainBackend(db: Database.Database): BackendId | null {
  let row: { default_backend?: string } | undefined;
  try {
    row = db
      .prepare(
        "SELECT default_backend FROM backend_global_defaults WHERE singleton = 1",
      )
      .get() as { default_backend?: string } | undefined;
  } catch {
    // Table missing (test harnesses without the multi-backend schema) —
    // surface as "unknown" so callers can degrade safely.
    return null;
  }
  const raw = row?.default_backend;
  if (typeof raw !== "string") return null;
  return isBackendId(raw) ? raw : null;
}

export interface DelegationCompatReport {
  key: IntegrationKey;
  /** User's explicit delegated backend choice (preserved across main switches). */
  delegatedBackend: BackendId;
  /** True when the NEW main backend has a registry connector for this integration. */
  compatibleWithNewMain: boolean;
}

/**
 * §4.12.4 "Backend change while delegated" — read-only detection.
 *
 * When the main backend changes and a Google integration is currently
 * delegated, report whether the new main has a registry connector for that
 * integration. The caller (PUT /api/backends/main) passes the report array
 * through in its response so the dashboard can surface the divergence.
 *
 * **Does NOT mutate state.** In particular:
 *   - `delegatedBackend` is never auto-rewired. The user's explicit choice
 *     stands; a "rewire on compat" heuristic would erase the choice the
 *     moment a user sets main = Codex while they had `delegatedBackend =
 *     claude`. That would be a silent policy change, not a safety fix.
 *   - No owner DM. Dispatch-time `BackendRouter.refineFallbackForDelegation`
 *     (Phase 4) + `missing_variants` skill-compile guard (Phase 3) already
 *     catch the actual execution failure, and emit owner-visible errors
 *     from `handleFallbackFailure`. Proactively DMing from here would be a
 *     duplicate at best, a false-alarm at worst (incompat ≠ executing).
 *   - No integrations.md rewrite, no probe cache invalidation, no audit row.
 *     The cached probe is keyed on `(integration, backend)` pairs — main
 *     backend changes don't stale those rows.
 *
 * Incompat cases are logged at `warn` so a mis-configured install shows up
 * in the daemon log without burning an owner notification.
 */
export function checkDelegatedCompatForNewMain(
  db: Database.Database,
  newMainBackendId: BackendId,
): DelegationCompatReport[] {
  const integrations = readIntegrations(db);
  const reports: DelegationCompatReport[] = [];

  for (const key of INTEGRATION_KEYS) {
    const state: IntegrationState = integrations[key];
    if (state.mode !== "delegated") continue;

    const compatible = backendHasIntegrationConnector(key, newMainBackendId);
    // Forward-compat: every (integration, backend) pair currently has a
    // connector, so this warn-branch is unreachable from the live registry.
    /* c8 ignore next 10 */
    if (!compatible) {
      logger.warn(
        {
          key,
          newMainBackendId,
          delegatedBackend: state.delegatedBackend,
        },
        "Delegated integration incompatible with new main backend — preserving user's delegatedBackend; dispatch-time guards will surface execution failures",
      );
    }
    reports.push({
      key,
      // Zod's superRefine on integrationStateSchema guarantees
      // delegatedBackend is set whenever mode === "delegated", but the TS
      // type is not narrowed — cast to surface the invariant.
      delegatedBackend: state.delegatedBackend as BackendId,
      compatibleWithNewMain: compatible,
    });
  }

  return reports;
}

export interface NativeCascadeEntry {
  key: IntegrationKey;
  /** The native-backend binding that just became invalid. */
  priorNativeBackend: BackendId;
  /** The new main backend that triggered the cascade. */
  newMainBackend: BackendId;
}

/**
 * INTEGRATION_NATIVE_MODE_DESIGN.md §11.4 — main-backend change cascade.
 *
 * When the operator switches the main backend, every `native` integration
 * whose `nativeBackend` no longer matches is **flipped to `disabled`** and
 * a setup-required entry is returned to the caller. The caller is
 * responsible for:
 *
 *   - writing an `agent_actions` audit row of type
 *     `integration.native_unbound` per entry (carrying `priorNativeBackend`
 *     and `newMainBackend` so the forensic chain survives the schema's
 *     `superRefine` clearing `nativeBackend` once `mode !== "native"`);
 *   - firing a notification telling the user their native integration is
 *     now disabled until they re-configure;
 *   - calling the integration mode-change side-effects callback (the
 *     workdir re-materialisation + observer-stop logic).
 *
 * Returns the entries that were flipped so the caller can build the audit
 * + notification batch atomically.
 *
 * No silent re-routing. Native is an explicit contract — the user must
 * confirm the new backend binding via the setup wizard.
 */
export function cascadeNativeBindingsOnMainSwitch(
  db: Database.Database,
  newMainBackendId: BackendId,
): NativeCascadeEntry[] {
  const integrations = readIntegrations(db);
  const flipped: NativeCascadeEntry[] = [];
  const now = new Date().toISOString();

  for (const key of INTEGRATION_KEYS) {
    const state = integrations[key];
    if (state.mode !== "native") continue;
    const priorNativeBackend = state.nativeBackend;
    if (!priorNativeBackend) {
      // Defensive — superRefine guarantees nativeBackend exists in native
      // mode. A row missing it indicates registry drift; flip to disabled
      // and log so the operator notices.
      logger.warn(
        { key },
        "native integration carried no nativeBackend — flipping to disabled (registry drift)",
      );
    }
    if (priorNativeBackend === newMainBackendId) continue;

    updateIntegrationState(db, key, {
      mode: "disabled",
      deniedTools: state.deniedTools ?? [],
      lastChangedAt: now,
    });
    flipped.push({
      key,
      // Cast safe because we just checked truthiness above and the only
      // un-truthy branch logs and falls through to here with a synthetic
      // value (`unknown` would be misleading); we mirror what the audit
      // row needs.
      priorNativeBackend: (priorNativeBackend ?? newMainBackendId) as BackendId,
      newMainBackend: newMainBackendId,
    });
    logger.warn(
      {
        key,
        priorNativeBackend,
        newMainBackend: newMainBackendId,
      },
      "native integration cascaded to disabled on main-backend change",
    );
  }

  return flipped;
}
