import type Database from "better-sqlite3";

import { getAgent, setEnabled } from "../../db/agents-store.js";
import { readRuntimeState, writeRuntimeState } from "../../db/runtime-state.js";
import { createLogger } from "../../logging.js";

const logger = createLogger("agents-config-gate-reconcile");

/**
 * One-time enable-switch unification (AGENTS_HUB_REDESIGN_PLAN.md §2).
 *
 * Pre-redesign, two built-ins carried a SECOND on/off switch in runtime
 * config, ANDed on top of `agents.enabled` at fire time:
 *
 *   - `activityScanEnabled` (persisted as `hourlyCheckEnabled` before the
 *     v0.1.11 rename; default true) → activity-scan
 *   - `monthlyReviewEnabled` (default false) → monthly-review
 *
 * The scheduler now consults only `agents.enabled`, so an operator's
 * non-default config value must be carried onto the agent row exactly once —
 * otherwise an old `hourlyCheckEnabled=false` would silently re-enable the
 * activity scan on upgrade (and an opted-in monthly review would stop firing).
 * The legacy settings row reaches `settings.activityScanEnabled` here via
 * `LEGACY_RUNTIME_SETTING_KEY_ALIASES` (settings-store read aliasing), so a
 * pre-agents-hub DB upgrading straight past the rename still carries its
 * disable forward.
 *
 * Boot-time, not a DB `Migration`: it must run AFTER the agents loader has
 * seeded the rows (migrations run before the loader), and it uses the same
 * `setEnabled` dashboard-toggle semantics (stamps `enabled_overridden_at`).
 * Idempotent via the `runtime_state` flag; defaults produce zero changes, so
 * a fresh install is a flagged no-op.
 */
export const CONFIG_GATES_RECONCILED_KEY = "agents.config_gates_reconciled";

export interface ConfigGateSettings {
  activityScanEnabled: boolean;
  monthlyReviewEnabled: boolean;
}

export interface ConfigGateReconcileResult {
  /** False when the runtime_state flag showed the reconcile already ran. */
  applied: boolean;
  /** Slugs whose `agents.enabled` was changed (empty on default configs). */
  changes: string[];
}

export function reconcileConfigGates(
  db: Database.Database,
  settings: ConfigGateSettings,
  now: number = Date.now(),
): ConfigGateReconcileResult {
  if (readRuntimeState<string>(db, CONFIG_GATES_RECONCILED_KEY) !== null) {
    return { applied: false, changes: [] };
  }

  const changes: string[] = [];

  // Non-default legacy value → carry onto the agent row. Default values are
  // left alone so the YAML/registry-shipped enabled state stays authoritative.
  if (!settings.activityScanEnabled && getAgent(db, "activity-scan")?.enabled === true) {
    setEnabled(db, "activity-scan", false, now, now);
    changes.push("activity-scan");
  }
  if (settings.monthlyReviewEnabled && getAgent(db, "monthly-review")?.enabled === false) {
    setEnabled(db, "monthly-review", true, now, now);
    changes.push("monthly-review");
  }

  writeRuntimeState(db, CONFIG_GATES_RECONCILED_KEY, new Date(now).toISOString());
  if (changes.length > 0) {
    logger.info({ changes }, "Carried legacy config enable gates onto agent rows");
  }
  return { applied: true, changes };
}
