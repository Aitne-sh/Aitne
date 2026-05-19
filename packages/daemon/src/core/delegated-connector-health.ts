import type Database from "better-sqlite3";
import {
  INTEGRATION_DESCRIPTORS,
  type BackendId,
  type IntegrationKey,
} from "@aitne/shared";
import { readIntegrations } from "../db/integrations-store.js";
import { readProbe } from "../db/integration-probe-store.js";
import {
  readRuntimeState,
  writeRuntimeState,
  deleteRuntimeState,
} from "../db/runtime-state.js";
import { createLogger } from "../logging.js";

const logger = createLogger("delegated-connector-health");

/**
 * DELEGATED-MODE-V2-DESIGN.md §4.5 / §10 — connector cached re-probe at DM
 * session-init.
 *
 * The §10 "post-setup connector sign-out" risk is that a user who completes
 * the wizard (live probe passes), then signs out of the connector in the
 * Claude.ai / Codex UI, leaves same-backend mode silently broken: the agent
 * keeps trying to call MCP tools that no longer exist and surfaces opaque
 * "tool not available" errors. Phase 4.5 closes the loop by consulting the
 * cached probe at every DM dispatch and DM-ing the owner once when the
 * cached probe says the required capabilities are no longer satisfied.
 *
 * Scope (intentional):
 * - Same-backend only. Cross-backend delegation runs through the
 *   `/api/integrations/:key/exec` chokepoint, which surfaces failures
 *   directly through its 5xx response. (Earlier drafts cited the
 *   `/invoke` route here; that route is retired but the internal
 *   `DelegatedBackendInvoker.invoke()` API continues to surface
 *   failures the same way for daemon-internal callers.) The §4.5 risk
 *   is exclusively about same-backend native-MCP usage where there is
 *   no daemon-side chokepoint to fail on.
 * - Cache-only. The §4.5 spec is explicit: "Cheaper than a live probe;
 *   the cache is already populated by the wizard." A periodic
 *   re-probe that drives the cache to `present=false` is a separate
 *   §13 TODO; until that lands, this helper alarms only after the user
 *   (or some future cron) hits `POST /api/integrations/:key/probe`
 *   with a connector that has signed out. Do not promote this to a
 *   live probe — that re-introduces the cost we deliberately rejected.
 *
 * Throttling:
 * - One DM per (integration, backend) sign-out event. Tracked via a
 *   `runtime_state` row keyed by
 *   `delegated_signout_warned:<integration>:<backend>`. When a later
 *   probe transitions `present` back to true, the marker is cleared so
 *   a future sign-out re-arms the alarm.
 * - The marker survives daemon restarts so a crash-loop does not spam
 *   the user.
 */

const RUNTIME_STATE_PREFIX = "delegated_signout_warned";

function markerKey(key: IntegrationKey, backend: BackendId): string {
  return `${RUNTIME_STATE_PREFIX}:${key}:${backend}`;
}

interface SignoutWarningRecord {
  warnedAt: string;
  /**
   * Required capabilities reported missing at the time the warning fired.
   * Captured for diagnostics — never read back.
   */
  missingRequired: readonly string[];
}

export interface DelegatedSignoutWarning {
  integration: IntegrationKey;
  /** Backend whose connector reported missing required capabilities. */
  backend: BackendId;
  /** Display name from the integration descriptor — used in the DM body. */
  displayName: string;
  /** Required capabilities the cached probe says are no longer satisfied. */
  missingRequired: readonly string[];
}

export interface DelegatedConnectorHealthResult {
  /**
   * Warnings the caller must DM the owner about (one per integration that
   * just transitioned to broken, or that is broken and has not yet been
   * warned about). Empty when nothing to do.
   */
  warnings: readonly DelegatedSignoutWarning[];
  /**
   * Integrations that were previously warned about but whose cached probe
   * now reports the required capabilities are present again. Pure
   * diagnostic — the helper has already cleared the runtime_state marker
   * for these by the time it returns.
   */
  recovered: readonly IntegrationKey[];
}

/**
 * Inspect cached probe state for every delegated integration whose
 * `delegatedBackend` matches the active session backend. Returns warnings
 * for integrations that need a one-shot DM (deduped via `runtime_state`)
 * and the list of integrations whose markers were cleared because the
 * cached probe now reports recovery.
 *
 * Marker lifecycle:
 * - The "would warn" decision is made here, but the warning marker is
 *   NOT written. The caller must invoke {@link markSignoutWarned} only
 *   after the DM has been successfully dispatched. This avoids the
 *   "marker set, DM never delivered" silent-failure trap (Slack outage,
 *   adapter crash) that would otherwise leave the user uninformed
 *   forever (the next consult sees the marker and stays silent until
 *   the probe transitions back through `present=true`).
 * - Recovery markers (probe transitioned back to `present=true`) are
 *   cleared inline because there is no dispatch failure mode to guard
 *   against — clearing a stale "we warned" marker is unconditionally
 *   safe.
 */
export function consultDelegatedConnectorHealth(
  db: Database.Database,
  sessionBackend: BackendId,
): DelegatedConnectorHealthResult {
  const integrations = readIntegrations(db);
  const warnings: DelegatedSignoutWarning[] = [];
  const recovered: IntegrationKey[] = [];

  for (const [keyRaw, state] of Object.entries(integrations)) {
    const key = keyRaw as IntegrationKey;
    if (state.mode !== "delegated") continue;
    if (state.delegatedBackend !== sessionBackend) continue;

    const descriptor = INTEGRATION_DESCRIPTORS[key];
    const connector = descriptor.backendConnectors[sessionBackend];
    /* c8 ignore start -- registry-rollback / hand-edited-DB defense */
    if (!connector) {
      // Registry inconsistency — delegated state stored against a
      // backend the descriptor does not list a connector for. The
      // PATCH route guards against this; reaching it here means a
      // hand-edited DB or a registry rollback. Don't DM, don't crash;
      // the next mode change will reconcile.
      logger.warn(
        { key, sessionBackend },
        "Delegated state references a backend with no connector — skipping health consult",
      );
      continue;
    }
    /* c8 ignore stop */

    const probe = readProbe(db, key, sessionBackend);
    const marker = readRuntimeState<SignoutWarningRecord>(db, markerKey(key, sessionBackend));

    if (!probe) {
      // No cached probe row at all. Either the user delegated outside
      // the wizard's live-probe path, or the cache was just evicted by
      // a mode change. Cannot assert "broken" without ground truth, so
      // do nothing — the cache will be repopulated by the next explicit
      // probe call.
      logger.debug(
        { key, sessionBackend },
        "No cached probe for delegated integration — skipping health consult",
      );
      continue;
    }

    if (!probe.present) {
      if (marker) {
        // Already warned about this exact sign-out — stay silent. Only
        // a transition through `present=true` resets the marker so a
        // true re-sign-out can re-fire.
        continue;
      }
      warnings.push({
        integration: key,
        backend: sessionBackend,
        displayName: descriptor.displayName,
        missingRequired: probe.missingRequired,
      });
      continue;
    }

    // probe.present === true — connector is healthy. If we previously
    // warned, clear the marker so the next sign-out re-arms the alarm.
    if (marker) {
      deleteRuntimeState(db, markerKey(key, sessionBackend));
      recovered.push(key);
    }
  }

  return { warnings, recovered };
}

/**
 * Persist the "we warned the user" marker for one warning. The dispatcher
 * calls this only after the underlying DM has been delivered successfully
 * — if delivery fails, the marker stays absent and the next consult will
 * re-issue the warning. This keeps the throttling guarantee
 * (one-DM-per-sign-out-event) without trading it for silent failure on
 * messaging-adapter outages.
 */
export function markSignoutWarned(
  db: Database.Database,
  warning: DelegatedSignoutWarning,
  now: Date = new Date(),
): void {
  const record: SignoutWarningRecord = {
    warnedAt: now.toISOString(),
    missingRequired: warning.missingRequired,
  };
  writeRuntimeState(db, markerKey(warning.integration, warning.backend), record);
}

/**
 * Compose the user-facing DM body for a single sign-out warning. Kept as
 * a pure function so the dispatcher can pass the rendered string straight
 * into `INotificationManager.send`. US-English per Decision Log #11.
 */
export function renderSignoutDm(warning: DelegatedSignoutWarning): string {
  const caps = warning.missingRequired.length > 0
    ? ` (missing: ${warning.missingRequired.join(", ")})`
    : "";
  return [
    `Your ${warning.displayName} connector on ${warning.backend} appears signed out${caps}.`,
    `Same-backend delegated mode for ${warning.integration} is non-functional until you sign back in.`,
    `Re-authorize from your ${warning.backend} connector settings, then re-run the integration probe from the dashboard.`,
  ].join(" ");
}
