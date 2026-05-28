/**
 * Supervisor for Instance S (the managed sync-context Chromium).
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §5.1 / §7.1.
 *
 * Designed as a sibling Observer to the existing
 * `BrowserLifecycleSupervisor` rather than an extension of it. The
 * existing supervisor is detector-driven (it walks every Chromium-
 * family install on the host and picks profiles it recognises); the
 * managed instance is a fixed singleton with a known binary path and
 * known user-data-dir. The cycle shape is similar but the data sources
 * are different enough that an internal `managed: boolean` branch in
 * the existing class would force every branch in every method to
 * understand both modes. A sibling Observer is cleaner — it reuses the
 * pure modules (failure-escalation, health-check, cleanup) without
 * fighting the existing class's invariants.
 */

import type Database from "better-sqlite3";

import {
  readManagedChromiumState,
  updateManagedChromiumState,
} from "../../../db/managed-chromium-state.js";
import { createLogger } from "../../../logging.js";
import type { Observer } from "../../../observers/manager.js";
import type { MessageHub } from "../../../adapters/message-hub.js";
import { chromiumBundleRoot, createHostProfile } from "../lifecycle/platform.js";
import { cleanupStaleSingletonLock } from "../lifecycle/chromium-launcher.js";
import { checkBrowserProfileHealth } from "../lifecycle/health-check.js";
import type {
  BrowserProfileCandidate,
  HostProfile,
} from "../types.js";
import {
  detectReauthState,
  type ReauthDetectorResult,
} from "./reauth-detector.js";
import { launchUnderSandbox } from "./sandbox-launcher.js";
import { materialiseSandboxPrimitive } from "./sandbox-install.js";
import { buildInstanceSConfig } from "./supervisor-config.js";
import { reapStaleBootstrap } from "./setup-bootstrap.js";
import { reapStaleSiteBootstrap } from "./site-bootstrap.js";
import { listSiteBootstrapKeys } from "../../../db/managed-chromium-sites-store.js";
import {
  DM_RATE_LIMIT_MS,
  DEFAULT_CHECK_INTERVAL_MINUTES,
  type ManagedChromiumReauthKind,
  type ManagedChromiumState,
  PAUSE_AFTER_FAILURES,
  PAUSE_DURATION_MS,
} from "./types.js";

const logger = createLogger("managed-chromium-supervisor");

const DM_TEMPLATES: Record<
  Exclude<ManagedChromiumReauthKind, "healthy">,
  (detail: string | undefined) => string
> = {
  signed_out: () =>
    "Managed Chromium is signed out — Chrome Sync is paused. Open the dashboard → Browser History (managed) → Reconnect to sign in again.",
  account_changed: (detail) =>
    `Managed Chromium account changed (${detail ?? "unknown"}). Sync is paused until you confirm via dashboard → Browser History (managed) → Reconnect.`,
  corrupt_local_state: () =>
    "Managed Chromium profile is unreadable. Open the dashboard → Browser History (managed) → Reconnect to repair.",
  sync_silent: () =>
    "Managed Chromium sync hasn't progressed for >6h. Open the dashboard → Browser History (managed) → Reconnect to re-authenticate.",
};

export interface ManagedChromiumSupervisorDeps {
  db: Database.Database;
  paDataDir: string;
  host?: HostProfile;
  messageHub?: MessageHub | null;
  /** Test hook: clock. */
  now?: () => number;
  /** Test hook: launcher. */
  launcher?: typeof launchUnderSandbox;
  /** Test hook: sandbox resolver. */
  resolveSandbox?: typeof materialiseSandboxPrimitive;
  /** Optional cycle interval override (minutes). */
  checkIntervalMinutes?: number;
}

export class ManagedChromiumSupervisor implements Observer {
  readonly name = "managed-chromium-supervisor";

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private tickInFlight = false;

  constructor(private readonly deps: ManagedChromiumSupervisorDeps) {
    this.deps.host = deps.host ?? createHostProfile();
  }

  async start(): Promise<void> {
    this.running = true;
    void this.tick();
    const intervalMin =
      this.deps.checkIntervalMinutes ?? DEFAULT_CHECK_INTERVAL_MINUTES;
    this.timer = setInterval(
      () => void this.tick(),
      intervalMin * 60 * 1000,
    );
    this.timer.unref?.();
    logger.info({ intervalMin }, "managed-chromium supervisor started");
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info("managed-chromium supervisor stopped");
  }

  /** Public for testing — runs a single supervisor cycle. */
  async tick(): Promise<void> {
    if (!this.running || this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      await this.cycleOnce();
    } catch (err) {
      logger.error({ err }, "managed-chromium tick failed");
    } finally {
      this.tickInFlight = false;
    }
  }

  private async cycleOnce(): Promise<void> {
    const state = readManagedChromiumState(this.deps.db);
    if (!state.enabled) return;

    // Reap orphaned bootstrap UI windows BEFORE deciding what to do.
    await reapStaleBootstrap({
      db: this.deps.db,
      host: this.deps.host!,
      paDataDir: this.deps.paDataDir,
      now: this.deps.now,
    });

    // MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §16.3 — also sweep
    // per-site B-2.5 bootstrap rows. Enumerating from the DB (rather
    // than the registry) catches stale rows whose siteKey has been
    // removed from the registry between releases; the reaper itself
    // tolerates a vanished site by force-killing the PID + clearing
    // the row regardless of whether `getSite` resolves it.
    for (const siteKey of listSiteBootstrapKeys(this.deps.db)) {
      try {
        await reapStaleSiteBootstrap(
          {
            db: this.deps.db,
            host: this.deps.host!,
            paDataDir: this.deps.paDataDir,
            now: this.deps.now,
          },
          siteKey,
        );
      } catch (err) {
        logger.warn(
          { err, siteKey },
          "per-site bootstrap reaper raised; continuing sweep",
        );
      }
    }

    let fresh = readManagedChromiumState(this.deps.db);
    // Self-healing: re-evaluate infra readiness on every tick so a
    // stuck `missing_binary` / `missing_sandbox` clears the moment the
    // operator installs the missing dependency, without requiring a
    // daemon restart. Mirrors the bootstrap-time pre-flight logic.
    const host = this.deps.host!;
    const hasBinary = host.browserBinaryFor("chromium") !== null;
    const hasSandbox =
      host.sandboxPrimitive.kind !== "none" || fresh.unsandboxedOptIn;
    if (!hasBinary && fresh.state !== "missing_binary") {
      updateManagedChromiumState(this.deps.db, (draft) => { draft.state = "missing_binary"; });
      fresh = readManagedChromiumState(this.deps.db);
    } else if (hasBinary && !hasSandbox && fresh.state !== "missing_sandbox") {
      updateManagedChromiumState(this.deps.db, (draft) => { draft.state = "missing_sandbox"; });
      fresh = readManagedChromiumState(this.deps.db);
    } else if (
      hasBinary
      && hasSandbox
      && (fresh.state === "missing_binary" || fresh.state === "missing_sandbox")
    ) {
      updateManagedChromiumState(this.deps.db, (draft) => { draft.state = "needs_setup"; });
      fresh = readManagedChromiumState(this.deps.db);
    }
    if (
      fresh.state === "off"
      || fresh.state === "missing_binary"
      || fresh.state === "missing_sandbox"
      || fresh.state === "needs_setup"
      || fresh.state === "disconnected"
    ) {
      // Pre-ready states — supervisor has nothing to launch.
      return;
    }

    const now = (this.deps.now ?? Date.now)();
    if (fresh.pausedUntil && fresh.pausedUntil > now) {
      // Paused after consecutive failures.
      return;
    }

    const config = buildInstanceSConfig({
      host,
      paDataDir: this.deps.paDataDir,
      sandbox: host.sandboxPrimitive,
    });
    if (!config) {
      updateManagedChromiumState(this.deps.db, (draft) => {
        draft.state = "missing_binary";
      });
      return;
    }

    // Health check FIRST — if Chromium is running and History is fresh,
    // we don't need to launch.
    const profileCandidate = pseudoProfileCandidate(config.binaryPath, config.userDataDir);
    const health = await checkBrowserProfileHealth(host, profileCandidate, now);
    let actionTaken: "noop" | "launch" | "skip" = "noop";
    let outcome: "success" | "launch_failed" | "sync_unresponsive" | "error" = "success";

    try {
      if (!health.running) {
        actionTaken = "launch";
        await cleanupStaleSingletonLock(host, profileCandidate);
        const sandbox = await (this.deps.resolveSandbox ?? materialiseSandboxPrimitive)(
          host.sandboxPrimitive,
          {
            paDataDir: this.deps.paDataDir,
            binaryPath: config.binaryPath,
            userDataDir: config.userDataDir,
          },
        );
        const launcher = this.deps.launcher ?? launchUnderSandbox;
        // The bundle root (parent dir of binary on Linux, .app root on
        // macOS) is what bwrap / sandbox-exec actually needs to bind —
        // binding just the entrypoint file leaves Chromium unable to
        // load helpers and shared libs from its own install dir.
        const child = launcher(sandbox, {
          binary: config.binaryPath,
          args: [...config.extraArgs],
          writableBindings: [config.userDataDir],
          readableBindings: [chromiumBundleRoot(config.binaryPath)],
          detached: true,
        }).child;
        if (!child.pid) outcome = "launch_failed";
      }

      // Reauth check runs even when we did not launch — Chromium may
      // be up but signed out.
      const reauth = await detectReauthState({
        profileDir: config.userDataDir,
        lastKnownSignedInUser: fresh.signedInUser,
        now,
      });

      this.applyReauthResult(fresh, reauth, now, actionTaken, outcome);
    } catch (err) {
      logger.error({ err }, "managed-chromium cycle errored");
      this.applyOutcome(fresh, "error", now);
    }

    this.recordTelemetry({
      action: actionTaken,
      outcome,
      lastSyncAt: health.historyMtimeMs,
      syncAgeAtIngestSeconds: health.syncAgeSeconds,
    });
  }

  private applyReauthResult(
    prevState: ManagedChromiumState,
    reauth: ReauthDetectorResult,
    now: number,
    actionTaken: "noop" | "launch" | "skip",
    outcome: "success" | "launch_failed" | "sync_unresponsive" | "error",
  ): void {
    if (reauth.kind === "healthy" && outcome === "success") {
      updateManagedChromiumState(this.deps.db, (draft) => {
        draft.lastCheckAt = now;
        draft.signedInUser = reauth.observedUser ?? draft.signedInUser;
        draft.consecutiveFailures = 0;
        draft.pausedUntil = null;
        if (draft.state !== "ready") draft.state = "ready";
      });
      return;
    }

    // Launch failed but the on-disk profile is fine — this is a spawn /
    // sandbox problem (e.g. a transient sandbox-exec failure), NOT a
    // sign-out. Bump failure counters so escalation/pause still fires,
    // but do NOT tell the user to re-authenticate or flip state to
    // needs_reauth (it stays "ready"); no reauth DM.
    if (reauth.kind === "healthy") {
      updateManagedChromiumState(this.deps.db, (draft) => {
        draft.lastCheckAt = now;
        const failures = draft.consecutiveFailures + 1;
        draft.consecutiveFailures = failures;
        if (failures >= PAUSE_AFTER_FAILURES) {
          draft.pausedUntil = now + PAUSE_DURATION_MS;
        }
      });
      return;
    }

    // Non-healthy: the reauth-detector observed an explicit problem.
    // Emit a DM (subject to per-kind cap) and update failure-escalation
    // counters. `reauth.kind` is provably non-"healthy" here.
    const dmKind: Exclude<ManagedChromiumReauthKind, "healthy"> = reauth.kind;
    const lastDmAt = prevState.lastDmAt[dmKind] ?? 0;
    const shouldDm = now - lastDmAt >= DM_RATE_LIMIT_MS;
    if (shouldDm) {
      void this.sendBrokenSyncDm(dmKind, reauth.detail).catch((err) => {
        logger.warn({ err, dmKind }, "broken-sync DM dispatch failed");
      });
    }

    updateManagedChromiumState(this.deps.db, (draft) => {
      draft.state = "needs_reauth";
      draft.lastCheckAt = now;
      if (shouldDm) draft.lastDmAt[dmKind] = now;
      const failures = draft.consecutiveFailures + 1;
      draft.consecutiveFailures = failures;
      if (failures >= PAUSE_AFTER_FAILURES) {
        draft.pausedUntil = now + PAUSE_DURATION_MS;
      }
    });

    this.recordReauthAudit(dmKind, reauth.detail);
  }

  private applyOutcome(
    _prev: ManagedChromiumState,
    outcome: "error",
    now: number,
  ): void {
    updateManagedChromiumState(this.deps.db, (draft) => {
      draft.lastCheckAt = now;
      const failures = draft.consecutiveFailures + 1;
      draft.consecutiveFailures = failures;
      if (failures >= PAUSE_AFTER_FAILURES) {
        draft.pausedUntil = now + PAUSE_DURATION_MS;
      }
    });
    this.recordTelemetry({ action: "noop", outcome, lastSyncAt: null, syncAgeAtIngestSeconds: null });
  }

  private async sendBrokenSyncDm(
    kind: Exclude<ManagedChromiumReauthKind, "healthy">,
    detail: string | undefined,
  ): Promise<void> {
    if (!this.deps.messageHub) {
      logger.info({ kind }, "messageHub absent; skipping broken-sync DM");
      return;
    }
    const body = DM_TEMPLATES[kind](detail);
    await this.deps.messageHub.sendToUser(body, undefined, {
      dispatchId: `managed-chromium-${kind}-${Date.now()}`,
      notificationType: "managed_chromium_sync_broken",
      priority: "P3",
      contentSummary: body.slice(0, 120),
    });
  }

  private recordTelemetry(opts: {
    action: "noop" | "launch" | "skip";
    outcome: "success" | "launch_failed" | "sync_unresponsive" | "error";
    lastSyncAt: number | null;
    syncAgeAtIngestSeconds: number | null;
  }): void {
    try {
      this.deps.db
        .prepare(
          `INSERT INTO agent_actions
             (action_type, trigger, result, detail, completed_at, source_kind)
           VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
        )
        .run(
          "browser_lifecycle.chromium_sync",
          "browser_lifecycle",
          opts.outcome === "success" ? "success" : "failed",
          JSON.stringify({
            action_taken: opts.action,
            outcome: opts.outcome,
            sync_mtime_after: opts.lastSyncAt,
            sync_age_at_check_seconds: opts.syncAgeAtIngestSeconds,
          }),
          "cron",
        );
    } catch (err) {
      logger.warn({ err }, "telemetry insert failed");
    }
  }

  private recordReauthAudit(
    kind: Exclude<ManagedChromiumReauthKind, "healthy">,
    detail: string | undefined,
  ): void {
    try {
      this.deps.db
        .prepare(
          `INSERT INTO agent_actions
             (action_type, trigger, result, detail, completed_at, source_kind)
           VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
        )
        .run(
          "browser_history.sync_broken",
          "browser_lifecycle",
          "failed",
          JSON.stringify({ kind, detail }),
          "cron",
        );
    } catch (err) {
      logger.warn({ err }, "reauth audit insert failed");
    }
  }
}

/**
 * The managed instance is a Chromium-family profile but it is NOT a
 * detector-discovered one. We construct a synthetic
 * `BrowserProfileCandidate` so the existing pure modules
 * (`cleanupStaleSingletonLock`, `checkBrowserProfileHealth`) can be
 * reused as-is. The synthetic shape is consumed only within this file
 * — it is NOT registered with the detector / lifecycle store.
 */
function pseudoProfileCandidate(
  binaryPath: string,
  userDataDir: string,
): BrowserProfileCandidate {
  return {
    browser: "chromium",
    profileName: "Default",
    userDataDir,
    historyPath: `${userDataDir}/Default/History`,
    localStatePath: `${userDataDir}/Local State`,
    signedIn: true,
    canonical: true,
    lastHistoryMtimeMs: null,
    // The detector type carries more fields than we need; the cast is
    // intentional and isolated. If the type ever grows required fields
    // the typecheck will surface here.
  } as BrowserProfileCandidate;
}

export const __testing = { pseudoProfileCandidate, DM_TEMPLATES };
