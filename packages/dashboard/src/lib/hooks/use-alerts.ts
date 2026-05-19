"use client";

import { useMemo, useSyncExternalStore } from "react";
import { useHealth } from "./use-health";
import type { Alert, AlertSeverity } from "@/lib/api-types";

const FROZEN_THRESHOLD_MS = 90_000;
const FROZEN_RECHECK_INTERVAL_MS = 5_000;
const STORAGE_PREFIX_SNOOZED = "pa.alerts.snoozed.";
const STORAGE_PREFIX_DISMISSED = "pa.alerts.dismissed.";

const SEVERITY_RANK: Record<AlertSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

function dismissKey(alert: Alert): string {
  return `${alert.id}:${alert.fingerprint}`;
}

function snoozeStorageKey(alert: Alert): string {
  return `${STORAGE_PREFIX_SNOOZED}${dismissKey(alert)}`;
}

function dismissStorageKey(alert: Alert): string {
  return `${STORAGE_PREFIX_DISMISSED}${dismissKey(alert)}`;
}

const inMemoryDismissed = new Set<string>();
const inMemorySnoozed = new Map<string, number>();

/**
 * Read-only check — used during render. The store below owns mutations
 * and listener fan-out so the panel re-renders without a page reload
 * when the user dismisses something.
 */
export function isAlertDismissed(alert: Alert): boolean {
  const key = dismissKey(alert);
  if (alert.severity === "info" && inMemoryDismissed.has(key)) {
    return true;
  }
  if (alert.severity === "warning") {
    const inMemoryExpiresAt = inMemorySnoozed.get(key);
    if (inMemoryExpiresAt !== undefined) {
      if (Date.now() < inMemoryExpiresAt) return true;
      inMemorySnoozed.delete(key);
    }
  }
  if (typeof window === "undefined") return false;
  try {
    if (alert.severity === "info") {
      return window.localStorage.getItem(dismissStorageKey(alert)) === "1";
    }
    if (alert.severity === "warning") {
      const raw = window.localStorage.getItem(snoozeStorageKey(alert));
      if (!raw) return false;
      const expiresAt = Number(raw);
      if (Number.isNaN(expiresAt)) return false;
      return Date.now() < expiresAt;
    }
    return false;
  } catch {
    return false;
  }
}

// ── Module-level dismiss store (mirror of the pattern in
// delegation-upgrade-banner.tsx). Same-tab notification can't rely on
// programmatic `storage` events because Firefox/Safari drop those, so
// we fan out via a Set of listeners.
type Listener = () => void;
const listeners: Set<Listener> = new Set();

function notify(): void {
  for (const l of listeners) l();
}

function subscribe(cb: Listener): () => void {
  listeners.add(cb);
  const storageHandler = (e: StorageEvent) => {
    if (
      e.key === null
      || e.key.startsWith(STORAGE_PREFIX_SNOOZED)
      || e.key.startsWith(STORAGE_PREFIX_DISMISSED)
    ) {
      cb();
    }
  };
  if (typeof window !== "undefined") {
    window.addEventListener("storage", storageHandler);
  }
  return () => {
    listeners.delete(cb);
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", storageHandler);
    }
  };
}

// During SSR + first client render, treat everything as visible. The
// real value swaps in on the next client paint via useSyncExternalStore.
function getServerSnapshot(): number {
  return 0;
}

let snapshotVersion = 0;
function getSnapshot(): number {
  return snapshotVersion;
}

export function dismissAlert(alert: Alert): void {
  if (!alert.dismissable) return;
  const key = dismissKey(alert);

  if (alert.severity === "info") {
    inMemoryDismissed.add(key);
  } else if (alert.severity === "warning") {
    inMemorySnoozed.set(key, Date.now() + 24 * 60 * 60 * 1000);
  }

  if (typeof window === "undefined") {
    snapshotVersion += 1;
    notify();
    return;
  }

  try {
    if (alert.severity === "info") {
      window.localStorage.setItem(dismissStorageKey(alert), "1");
    } else if (alert.severity === "warning") {
      window.localStorage.setItem(
        snoozeStorageKey(alert),
        String(inMemorySnoozed.get(key)),
      );
    }
  } catch {
    // localStorage blocked (private mode, quota). Notify listeners
    // anyway so this session hides the alert until reload.
  }
  snapshotVersion += 1;
  notify();
}

export interface UseAlertsResult {
  alerts: Alert[];
  /** Daemon polling state — distinguishes "online" from "offline". */
  daemonOnline: boolean;
  /** Heartbeat-based frozen detection. */
  daemonFrozen: boolean;
}

/**
 * Aggregates server-side alerts (from `/api/health.alerts`) with
 * client-only system alerts that the daemon cannot detect itself:
 *  - daemon offline (health fetch is failing)
 *  - daemon frozen (heartbeat stale beyond `FROZEN_THRESHOLD_MS`)
 *
 * Filters dismissed alerts using the per-content fingerprint, then
 * sorts by severity then by `detectedAt` desc.
 */
// ── Module-level "now" store ──
// Subscribe-based clock so render-time code stays pure (no `Date.now()`
// inside the component body). Updates every FROZEN_RECHECK_INTERVAL_MS
// while at least one consumer is mounted, then idles when the last one
// unmounts.
const nowListeners: Set<Listener> = new Set();
let nowSnapshot = 0;
let nowTimer: ReturnType<typeof setInterval> | null = null;

function nowSubscribe(cb: Listener): () => void {
  if (nowListeners.size === 0 && typeof window !== "undefined") {
    nowSnapshot = Date.now();
    nowTimer = setInterval(() => {
      nowSnapshot = Date.now();
      for (const l of nowListeners) l();
    }, FROZEN_RECHECK_INTERVAL_MS);
  }
  nowListeners.add(cb);
  return () => {
    nowListeners.delete(cb);
    if (nowListeners.size === 0 && nowTimer !== null) {
      clearInterval(nowTimer);
      nowTimer = null;
    }
  };
}

function getNowSnapshot(): number {
  return nowSnapshot;
}

function getNowServerSnapshot(): number {
  return 0;
}

function useNowMs(): number {
  return useSyncExternalStore(nowSubscribe, getNowSnapshot, getNowServerSnapshot);
}

export function useAlerts(): UseAlertsResult {
  const { data: health, isError } = useHealth();
  // Re-render when localStorage changes, so dismiss reflects without reload.
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const nowMs = useNowMs();

  return useMemo(() => {
    const alerts: Alert[] = [];
    const nowIso = nowMs ? new Date(nowMs).toISOString() : "";

    const daemonOnline = !isError;
    let daemonFrozen = false;

    if (!daemonOnline) {
      alerts.push({
        id: "system.daemon_offline",
        severity: "error",
        title: "Daemon is offline",
        description:
          "The dashboard cannot reach the daemon. Check that the daemon process is running and listening on the expected port.",
        href: "/health",
        source: "system",
        dismissable: false,
        detectedAt: nowIso,
        fingerprint: "offline",
      });
    } else if (health) {
      // Frozen only meaningful when we successfully reached the daemon
      // (otherwise "offline" already covers the failure mode). Wait for
      // the first nowMs sample before deciding so SSR + first paint
      // doesn't briefly flash a frozen alert.
      const lastTickAt = health.lastTickAt;
      if (
        nowMs > 0
        && typeof lastTickAt === "number"
        && nowMs - lastTickAt > FROZEN_THRESHOLD_MS
      ) {
        daemonFrozen = true;
        const stalenessSec = Math.round((nowMs - lastTickAt) / 1000);
        alerts.push({
          id: "system.daemon_frozen",
          severity: "error",
          title: "Daemon appears frozen",
          description: `No heartbeat for ${stalenessSec}s. The event loop may be blocked. Restart the daemon if this persists.`,
          href: "/health",
          source: "system",
          dismissable: false,
          detectedAt: nowIso,
          fingerprint: `stale:${Math.floor(stalenessSec / 30) * 30}s`,
        });
      }

      if (health.alerts) {
        alerts.push(...health.alerts);
      }
    }

    const visible = alerts
      .filter((a) => !isAlertDismissed(a))
      .sort((a, b) => {
        const r = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
        if (r !== 0) return r;
        return b.detectedAt.localeCompare(a.detectedAt);
      });

    return {
      alerts: visible,
      daemonOnline,
      daemonFrozen,
    };
  }, [health, isError, nowMs]);
}
