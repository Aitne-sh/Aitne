/**
 * Re-authentication detector for Instance S.
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §7.5. Runs once per
 * supervisor cycle to decide whether Chrome Sync is healthy or whether
 * the user needs to re-sign-in / re-authorise the OAuth token.
 *
 * Signals consumed (lowest cost first):
 *   1. `Local State` JSON parses + carries a `signin.signed_in_to` /
 *      `signin.signed_in_username` (key name varies by Chromium build;
 *      we check both). Corrupt JSON → `corrupt_local_state`. Missing
 *      sign-in → `signed_out`.
 *   2. The signed-in username matches the one observed on the most
 *      recent supervisor tick (`lastKnownSignedInUser`). Mismatch →
 *      `account_changed` (a different user signed in via the UI; the
 *      daemon's OAuth assumptions no longer hold).
 *   3. `Default/History` file mtime has advanced within the past
 *      6 hours OR the sync LevelDB has been written within the past
 *      6 hours. Both stale → `sync_silent` (Chromium is running but
 *      sync is not progressing).
 *
 * Pure module — no DB, no spawn, no IO outside `node:fs/promises`. The
 * supervisor wraps the result with DM / state-transition logic.
 */

import { stat } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  type ManagedChromiumReauthState,
  SYNC_SILENT_THRESHOLD_MS,
} from "./types.js";

export interface ReauthDetectorInput {
  profileDir: string;
  /** Username last observed signed-in (or null on first tick). */
  lastKnownSignedInUser: string | null;
  /** Epoch ms; injectable for tests. */
  now: number;
  /** Mtime stall threshold; defaults to the 6h constant. */
  syncSilentThresholdMs?: number;
}

export interface ReauthDetectorResult extends ManagedChromiumReauthState {
  /** Username observed in `Local State` (or null if signed-out). */
  observedUser: string | null;
}

export async function detectReauthState(
  input: ReauthDetectorInput,
): Promise<ReauthDetectorResult> {
  const localState = await readLocalState(input.profileDir);
  if (localState === "missing") {
    return {
      kind: "signed_out",
      observedUser: null,
      detail: "Local State file missing",
    };
  }
  if (localState === "corrupt") {
    return {
      kind: "corrupt_local_state",
      observedUser: null,
      detail: "Local State JSON unparseable",
    };
  }

  const observedUser = extractSignedInUser(localState.parsed);
  if (!observedUser) {
    return { kind: "signed_out", observedUser: null };
  }
  if (
    input.lastKnownSignedInUser
    && observedUser !== input.lastKnownSignedInUser
  ) {
    return {
      kind: "account_changed",
      to: observedUser,
      observedUser,
      detail: `Local State signin user changed from ${input.lastKnownSignedInUser} → ${observedUser}`,
    };
  }

  const threshold = input.syncSilentThresholdMs ?? SYNC_SILENT_THRESHOLD_MS;
  const stale = await detectSyncStall(input.profileDir, input.now, threshold);
  if (stale.kind === "stall") {
    return {
      kind: "sync_silent",
      observedUser,
      detail: stale.detail,
    };
  }

  return { kind: "healthy", observedUser };
}

type LocalStateRead =
  | "missing"
  | "corrupt"
  | { parsed: Record<string, unknown> };

async function readLocalState(profileDir: string): Promise<LocalStateRead> {
  const path = join(profileDir, "Local State");
  let buf: string;
  try {
    buf = await readFile(path, "utf8");
  } catch {
    return "missing";
  }
  try {
    const parsed = JSON.parse(buf) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null) return "corrupt";
    return { parsed };
  } catch {
    return "corrupt";
  }
}

/**
 * Chromium's `Local State` carries the signed-in user under multiple
 * keys depending on version. Probe both — the absence of all of them
 * means signed-out, the presence of any non-empty one wins.
 */
export function extractSignedInUser(
  localState: Record<string, unknown>,
): string | null {
  const signin = localState["signin"];
  if (signin && typeof signin === "object") {
    const obj = signin as Record<string, unknown>;
    for (const key of ["signed_in_to", "signed_in_username", "allowed_username"]) {
      const v = obj[key];
      if (typeof v === "string" && v.trim().length > 0) return v.trim();
    }
  }
  const profile = localState["profile"];
  if (profile && typeof profile === "object") {
    const info = (profile as Record<string, unknown>).info_cache;
    if (info && typeof info === "object") {
      for (const entry of Object.values(info as Record<string, unknown>)) {
        if (entry && typeof entry === "object") {
          const userName = (entry as Record<string, unknown>).user_name;
          if (typeof userName === "string" && userName.trim().length > 0) {
            return userName.trim();
          }
        }
      }
    }
  }
  return null;
}

interface StallResult {
  kind: "fresh" | "stall";
  detail?: string;
}

async function detectSyncStall(
  profileDir: string,
  now: number,
  thresholdMs: number,
): Promise<StallResult> {
  const historyMtime = await fileMtimeMs(join(profileDir, "Default", "History"));
  if (historyMtime !== null && now - historyMtime <= thresholdMs) {
    return { kind: "fresh" };
  }
  const syncMtime = await mostRecentSyncLevelDbWrite(profileDir);
  if (syncMtime !== null && now - syncMtime <= thresholdMs) {
    return { kind: "fresh" };
  }
  return {
    kind: "stall",
    detail: `History mtime ${historyMtime ?? "missing"}, sync mtime ${syncMtime ?? "missing"} — both past ${Math.round(thresholdMs / 60_000)} min threshold`,
  };
}

async function fileMtimeMs(path: string): Promise<number | null> {
  try {
    const s = await stat(path);
    return s.mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Sync LevelDB lives at `Default/Sync Data/LevelDB/`. We walk one
 * directory level to find the most recent write across `.ldb` /
 * `MANIFEST-*` / `CURRENT` / `LOG`. Returns null when the directory or
 * any of its files cannot be read.
 *
 * Implementation detail: we prefer the inner LevelDB directory and
 * fall back to the parent `Sync Data` dir only when LevelDB is absent.
 * Walking both candidates would shadow the inner-file mtime with the
 * parent's own mtime — every write inside `LevelDB/` advances the
 * `LevelDB` directory entry's mtime when listed from `Sync Data`, so
 * the stall threshold would never fire under a merged max.
 */
export async function mostRecentSyncLevelDbWrite(
  profileDir: string,
): Promise<number | null> {
  const candidates = [
    join(profileDir, "Default", "Sync Data", "LevelDB"),
    join(profileDir, "Default", "Sync Data"),
  ];
  for (const dir of candidates) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    let best: number | null = null;
    for (const entry of entries) {
      const m = await fileMtimeMs(join(dir, entry));
      if (m !== null && (best === null || m > best)) best = m;
    }
    if (best !== null) return best;
  }
  return null;
}

export type { ManagedChromiumReauthState };
