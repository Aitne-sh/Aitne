import { freshestHistoryMtimeMs } from "../history-mtime.js";
import type { BrowserProfileCandidate, HostProfile } from "../types.js";

export interface BrowserProfileHealth {
  running: boolean;
  historyMtimeMs: number | null;
  syncAgeSeconds: number | null;
  stale: boolean;
}

export async function checkBrowserProfileHealth(
  host: HostProfile,
  profile: BrowserProfileCandidate,
  nowMs: number = Date.now(),
): Promise<BrowserProfileHealth> {
  const binary = host.browserBinaryFor(profile.browser);
  const running = binary
    ? await host.isProcessRunning(binary, profile.userDataDir)
    : false;

  const historyMtimeMs = await freshestHistoryMtimeMs(profile.historyPath);
  const syncAgeSeconds =
    historyMtimeMs === null
      ? null
      : Math.max(0, Math.floor((nowMs - historyMtimeMs) / 1000));
  return {
    running,
    historyMtimeMs,
    syncAgeSeconds,
    stale: syncAgeSeconds !== null && syncAgeSeconds > 24 * 60 * 60,
  };
}
