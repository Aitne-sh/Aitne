import type Database from "better-sqlite3";
import {
  INTEGRATION_DESCRIPTORS,
  type IntegrationKey,
  type IntegrationState,
} from "@aitne/shared";
import type { Observer, ObserverManager } from "../observers/manager.js";
import { readIntegrationState } from "../db/integrations-store.js";
import {
  deleteRuntimeState,
  readRuntimeState,
  writeRuntimeState,
} from "../db/runtime-state.js";
import { createLogger } from "../logging.js";
import {
  DELEGATED_SYNC_OBSERVER_NAME,
  hasActiveDelegatedSyncIntegration,
} from "../observers/delegated-sync-worker.js";
import {
  GIT_DELEGATED_CRON_OBSERVER_NAME,
  hasActiveDelegatedGitLifecycleIntegration,
} from "../observers/git-delegated-cron.js";
import { purgeStaleSnapshotPartitions } from "../services/integrations/snapshot-partitions.js";

const logger = createLogger("integration-lifecycle");

/**
 * Builds a single observer instance for a registered observer name.
 * Returns null when the observer cannot currently be built (e.g. the
 * underlying service hasn't initialized — Google OAuth missing,
 * `services.mail` empty). The lifecycle never throws on a null builder
 * result; the integration mode flip is still recorded, the observer
 * just doesn't start until the underlying service is wired up.
 */
export type ObserverBuilder = (name: string) => Observer | null;

export interface IntegrationLifecycleDeps {
  db: Database.Database;
  observerManager: ObserverManager;
  buildObserver: ObserverBuilder;
  /**
   * Phase 3 integration drift sync worker. One worker handles every
   * currently-delegated integration, so lifecycle starts it when the first
   * integration enters delegated sync and stops it when the last one leaves.
   */
  buildDelegatedSyncWorker?: () => Observer | null;
  /**
   * Git lifecycle Phase 4 — delegated cron observer. One observer handles
   * both `git` and `github` delegated modes; lifecycle starts it when
   * either enters delegated and stops it when the last one leaves. The
   * factory returns a fresh instance every call so config changes (cadence,
   * watched-repo list) propagate on the next direct → delegated flip
   * without daemon restart.
   */
  buildGitDelegatedCronObserver?: () => Observer;
  /**
   * DELEGATED-PROXY-API-DESIGN.md Phase F (§4.8) — re-materialize every
   * active DM session workdir so the unified skill body, mail accounts,
   * and per-backend instruction file reflect the new integration state on
   * the next turn without tearing down the SDK session. Fires on every
   * mode change (including delegated↔delegated backend swap and
   * delegated↔disabled), independent of the direct-boundary flip that
   * gates observer start/stop.
   *
   * Optional so test harnesses and the legacy boot path don't need to
   * supply it. Implementation is synchronous fire-and-forget from the
   * caller's perspective; per-session failures are logged inside the
   * helper, not rethrown.
   */
  rematerializeDmSessions?: (reason: string) => void;
}

/**
 * Apply the §4.10 side-effects step for one integration's mode change.
 *
 * Phase 2 scope: observer start/stop. DELEGATED-PROXY-API-DESIGN.md
 * Phase F adds DM workdir re-materialization on every mode change.
 * Skill-variant validation, audit, owner DM, and persistence all stay
 * with the PATCH route handler so the lifecycle module is a thin,
 * testable orchestrator.
 *
 * INTEGRATION_NATIVE_MODE_DESIGN.md §11.3 extends the same path to cover
 * the new `native` boundary transitions (`direct ↔ native`,
 * `delegated ↔ native`, `native ↔ disabled`). No new observer is started
 * for `native` — the agent reaches the connector directly through the
 * main backend's MCP — so the existing direct-flip observer gate is
 * sufficient. Workdir re-materialization fires on every mode change so
 * the per-session SKILL.*.md / task-flow variant is refreshed before the
 * next turn.
 *
 * Idempotent: re-running with the same `prev`/`next` does the same set
 * of starts/stops (which `ObserverManager.registerAndStart` /
 * `stopAndUnregister` themselves no-op when state already matches) and
 * a redundant re-materialize (overwrites identical files in place).
 */
export async function applyIntegrationModeChange(
  deps: IntegrationLifecycleDeps,
  key: IntegrationKey,
  prev: IntegrationState,
  next: IntegrationState,
): Promise<void> {
  const descriptor = INTEGRATION_DESCRIPTORS[key];
  const wasDirect = prev.mode === "direct";
  const isDirect = next.mode === "direct";

  if (wasDirect !== isDirect) {
    for (const observerName of descriptor.observersTouched) {
      if (isDirect) {
        const observer = deps.buildObserver(observerName);
        if (!observer) {
          logger.warn(
            { key, observerName },
            "Cannot start observer for newly-direct integration — builder returned null (service likely not initialized)",
          );
          continue;
        }
        try {
          await deps.observerManager.registerAndStart(observer);
        } catch (err) {
          logger.error(
            { err, key, observerName },
            "Failed to hot-start observer after integration mode change",
          );
        }
      } else {
        const result = await deps.observerManager.stopAndUnregister(observerName);
        switch (result.status) {
          case "removed":
            logger.info(
              { key, observerName },
              "Stopped observer after integration left direct mode",
            );
            break;
          case "absent":
            logger.info(
              { key, observerName },
              "No observer to stop — already absent",
            );
            break;
          case "stop_failed":
            // Observer stayed in the registry; the next mode-change
            // cycle (or daemon shutdown's stopAll) will retry. We do
            // NOT throw here because the calling PATCH has already
            // committed the DB state — propagating would leave the
            // operator with a 5xx after the change is durable, which
            // is more confusing than the logged warning + retry.
            logger.warn(
              { key, observerName, err: result.error },
              "Observer.stop failed during integration mode change — observer left registered for retry",
            );
            break;
        }
      }
    }
  } else {
    logger.debug(
      { key, mode: next.mode },
      "Integration mode change does not flip direct boundary — skipping observer side-effects",
    );
  }

  await applyDelegatedSyncLifecycle(deps, key, next);
  await applyGitDelegatedCronLifecycle(deps, key, next);

  // INTEGRATION-DRIFT-PHASE-7-PLAN.md §3.3 — drop snapshot rows for
  // partitions whose writer just went away. Runs after the observer
  // start/stop above so the writer is quiesced when DELETE fires; before
  // the DM workdir refresh below because that hook is async fire-and-
  // forget and we want the DB state coherent for the next reconcile
  // regardless of whether the workdir refresh finishes. The matching
  // `runtime_state.integration_snapshot_initialized:*` keys are also
  // dropped so the next first-reconcile is correctly classified as
  // initial.
  if (prev.mode !== next.mode) {
    purgeStaleSnapshotPartitions(deps.db, key, prev.mode, next.mode);
  }

  // Phase F (§4.8) — re-materialize active DM workdirs on every mode
  // change. Decoupled from the direct-boundary check above because
  // delegated→disabled, delegated backend swaps, and direct→delegated
  // all need the on-disk skill bundle refreshed even when no observer
  // start/stop is involved. The callback itself is synchronous; we
  // intentionally don't await any returned promise — failures are
  // recorded by the helper, never propagated up so the PATCH cannot be
  // rolled back by a workdir refresh hiccup.
  if (deps.rematerializeDmSessions) {
    try {
      deps.rematerializeDmSessions(`integration_mode_change:${key}`);
    } catch (err) {
      logger.warn(
        { err, key },
        "DM session re-materialization hook threw — DB state is already updated; next DM turn will refresh",
      );
    }
  }
}

async function applyGitDelegatedCronLifecycle(
  deps: IntegrationLifecycleDeps,
  key: IntegrationKey,
  next: IntegrationState,
): Promise<void> {
  if (key !== "git" && key !== "github") return;
  if (!deps.buildGitDelegatedCronObserver) return;

  const shouldRun = hasActiveDelegatedGitLifecycleIntegration(deps.db, {
    key,
    state: next,
  });
  if (shouldRun) {
    if (deps.observerManager.has(GIT_DELEGATED_CRON_OBSERVER_NAME)) return;
    try {
      await deps.observerManager.registerAndStart(
        deps.buildGitDelegatedCronObserver(),
      );
    } catch (err) {
      logger.error(
        { err, key },
        "Failed to hot-start git delegated cron after integration mode change",
      );
    }
    return;
  }

  const result = await deps.observerManager.stopAndUnregister(
    GIT_DELEGATED_CRON_OBSERVER_NAME,
  );
  switch (result.status) {
    case "removed":
      logger.info(
        { key },
        "Stopped git delegated cron after last delegated integration left",
      );
      break;
    case "absent":
      logger.info(
        { key },
        "No git delegated cron to stop — already absent",
      );
      break;
    case "stop_failed":
      logger.warn(
        { key, err: result.error },
        "Git delegated cron stop failed — left registered for retry by next mode change or daemon shutdown",
      );
      break;
  }
}

/**
 * Stand the delegated-sync worker up when at least one cadence-eligible
 * integration is in `delegated` mode; tear it down when the last one
 * leaves. Native rows do not stand the worker up — see
 * `hasActiveDelegatedSyncIntegration` for why.
 */
async function applyDelegatedSyncLifecycle(
  deps: IntegrationLifecycleDeps,
  key: IntegrationKey,
  next: IntegrationState,
): Promise<void> {
  if (!deps.buildDelegatedSyncWorker) return;

  const shouldRun = hasActiveDelegatedSyncIntegration(deps.db, { key, state: next });
  if (shouldRun) {
    if (deps.observerManager.has(DELEGATED_SYNC_OBSERVER_NAME)) return;
    const worker = deps.buildDelegatedSyncWorker();
    if (!worker) {
      logger.warn(
        { key },
        "Cannot start cadence sync worker — builder returned null",
      );
      return;
    }
    try {
      await deps.observerManager.registerAndStart(worker);
    } catch (err) {
      logger.error(
        { err, key },
        "Failed to hot-start cadence sync worker after integration mode change",
      );
    }
    return;
  }

  const result = await deps.observerManager.stopAndUnregister(
    DELEGATED_SYNC_OBSERVER_NAME,
  );
  switch (result.status) {
    case "removed":
      logger.info(
        { key },
        "Stopped cadence sync worker after last cadence-eligible integration left",
      );
      break;
    case "absent":
      logger.info(
        { key },
        "No cadence sync worker to stop — already absent",
      );
      break;
    case "stop_failed":
      logger.warn(
        { key, err: result.error },
        "Cadence sync worker stop failed — left registered for retry by next mode change or daemon shutdown",
      );
      break;
  }
}

/**
 * Decide whether an integration's observers should be started during the
 * boot sequence. Mirrors the per-integration check `index.ts` uses so
 * the gating rule lives in one place. Returns true only when the stored
 * state is `direct` — `delegated` and `disabled` both keep observers
 * dormant.
 */
export function shouldStartObserversFor(
  db: Database.Database,
  key: IntegrationKey,
): boolean {
  return readIntegrationState(db, key).mode === "direct";
}

/**
 * True when the integration is currently in `delegated` mode. Used by
 * multi-provider surfaces (e.g. `/api/mail/*`, `MailPoller`) that can't be
 * wholesale-gated via `apiRoutesTouched` / `observersTouched` — they need
 * to skip-or-410 only the accounts belonging to this integration's kind,
 * while leaving other providers (iCloud, Outlook, IMAP) running. See §4.8.
 */
export function isIntegrationDelegated(
  db: Database.Database,
  key: IntegrationKey,
): boolean {
  return readIntegrationState(db, key).mode === "delegated";
}

/**
 * True when the integration's data path is NOT the daemon poller — any of
 * `delegated`, `native`, or `disabled` (INTEGRATION_NATIVE_MODE_DESIGN.md
 * §5.6).
 *
 * Used by multi-provider surfaces that own polling for several integration
 * kinds at once (e.g. {@link "../observers/mail-poller.js" MailPoller}). They
 * must skip per-account when the integration governing that kind is not
 * direct-mode — but cannot stop the whole observer because sibling kinds
 * (iCloud, IMAP, Yahoo) belong to integrations whose mode is unrelated.
 *
 * Phase A fixed the pre-native bug where the per-account gate only checked
 * `delegated`, leaving `disabled`-mode Gmail still being polled by the
 * unified mail poller. Phase B1 extends the same predicate to recognise
 * the new `native` mode.
 */
export function isIntegrationPollerless(
  db: Database.Database,
  key: IntegrationKey,
): boolean {
  const mode = readIntegrationState(db, key).mode;
  return mode === "delegated" || mode === "native" || mode === "disabled";
}

/**
 * INTEGRATION_NATIVE_MODE_DESIGN.md §5.6 — true when the integration is
 * currently in `native` mode. Used by route-gate logic, health builders,
 * and the BackendRouter's native-fallback gate. Read once per call from
 * `readIntegrationState`; callers that need the `nativeBackend` value
 * should consult the full state via `readIntegrationState` directly.
 */
export function isIntegrationNative(
  db: Database.Database,
  key: IntegrationKey,
): boolean {
  return readIntegrationState(db, key).mode === "native";
}

/**
 * INTEGRATION_NATIVE_MODE_DESIGN.md §5.6 — true when the integration's
 * data path is NOT the daemon (neither poller nor proxy) — `native` or
 * `disabled`. Used by the API route gate to 410 daemon endpoints; the
 * agent reaches the connector directly via the main backend's MCP (native)
 * or not at all (disabled).
 *
 * Distinct from {@link isIntegrationDelegated} (`delegated` only) and
 * {@link isIntegrationPollerless} (`delegated ∪ native ∪ disabled`).
 */
export function isIntegrationDaemonless(
  db: Database.Database,
  key: IntegrationKey,
): boolean {
  const mode = readIntegrationState(db, key).mode;
  return mode === "native" || mode === "disabled";
}

// ── Flip-lock orchestration (§11.3.1) ───────────────────────────────────────

/**
 * INTEGRATION_NATIVE_MODE_DESIGN.md §11.3.1 — per-key flip lock keyed in
 * `runtime_state`. The PATCH handler acquires the lock before signalling
 * the outgoing data path to stop and releases it after the audit row is
 * written. A concurrent flip on the same key sees the lock and is rejected
 * with 409; concurrent flips on different keys proceed independently.
 *
 * Stored shape: `{ acquiredAt: ISO, processId: number, byKey: <key> }`.
 * The lock is not strictly necessary on a single-process daemon (Node is
 * single-threaded and Better-SQLite3 is synchronous), but the PATCH
 * handler interleaves `await` boundaries while running the live probe and
 * the optional cancel-delegated-tick drain — so concurrent flips ARE
 * possible at the JavaScript-microtask level. The lock makes that race
 * explicit instead of relying on call-site ordering.
 */
const FLIP_LOCK_PREFIX = "integration_flip_lock:";

export interface IntegrationFlipLockRecord {
  acquiredAt: string;
  processId: number;
  byKey: IntegrationKey;
}

function flipLockKey(key: IntegrationKey): string {
  return `${FLIP_LOCK_PREFIX}${key}`;
}

/**
 * Attempt to acquire the flip lock for `key`. Returns `{ ok: true }` on
 * success and `{ ok: false, current }` when the lock is already held —
 * the PATCH handler maps the latter to HTTP 409. Stale locks older than
 * `STALE_LOCK_MS` are silently reclaimed: the PATCH handler's drain step
 * has a 5s timeout, so a holder older than ~30s is a crashed/abandoned
 * process and not a live competitor.
 */
const STALE_LOCK_MS = 30_000;

export function acquireIntegrationFlipLock(
  db: Database.Database,
  key: IntegrationKey,
  now: number = Date.now(),
): { ok: true; lock: IntegrationFlipLockRecord } | { ok: false; current: IntegrationFlipLockRecord } {
  const existing = readRuntimeState<IntegrationFlipLockRecord>(
    db,
    flipLockKey(key),
  );
  if (existing) {
    const acquiredMs = Date.parse(existing.acquiredAt);
    const isStale =
      Number.isFinite(acquiredMs) && now - acquiredMs > STALE_LOCK_MS;
    if (!isStale) {
      return { ok: false, current: existing };
    }
    logger.warn(
      { key, lock: existing, ageMs: now - acquiredMs },
      "Reclaiming stale integration flip lock",
    );
  }
  const lock: IntegrationFlipLockRecord = {
    acquiredAt: new Date(now).toISOString(),
    processId: process.pid,
    byKey: key,
  };
  writeRuntimeState(db, flipLockKey(key), lock);
  return { ok: true, lock };
}

export function releaseIntegrationFlipLock(
  db: Database.Database,
  key: IntegrationKey,
): void {
  deleteRuntimeState(db, flipLockKey(key));
}

/**
 * Read-only inspection helper — used by tests and the §15 risk-register
 * defensive check on `POST /api/observations` ("reject rows whose
 * `(source, refs.<id>)` already has a newer row written under a different
 * mode within the lock window"). Returns null when no lock is held.
 */
export function readIntegrationFlipLock(
  db: Database.Database,
  key: IntegrationKey,
): IntegrationFlipLockRecord | null {
  return readRuntimeState<IntegrationFlipLockRecord>(db, flipLockKey(key));
}
