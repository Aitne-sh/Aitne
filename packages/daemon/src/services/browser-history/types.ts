import type {
  BrowserHistoryBrowserKey,
  BrowserHistoryDetectionStatus,
  BrowserHistoryLifecycleStateValue,
} from "@aitne/shared";

// Every supported browser is Chromium-family today. The alias is kept
// because `host.browserBinaryFor` and `profileRootFor` are still typed
// against it — re-introducing a non-Chromium browser would shrink this
// set back below `BrowserHistoryBrowserKey`.
export type ChromiumBrowserKey = BrowserHistoryBrowserKey;

export interface BrowserProfileCandidate {
  browser: BrowserHistoryBrowserKey;
  profileName: string;
  userDataDir: string;
  historyPath: string;
  localStatePath?: string;
  signedIn: boolean;
  canonical: boolean;
  lastHistoryMtimeMs: number | null;
}

export interface BrowserDetectionResult {
  browser: BrowserHistoryBrowserKey;
  status: BrowserHistoryDetectionStatus;
  profiles: BrowserProfileCandidate[];
  error?: string;
  nonCanonicalLayout?: boolean;
}

export type SandboxPrimitive =
  | { kind: "sandbox-exec"; profilePath: string }
  | { kind: "bubblewrap" }
  | { kind: "systemd-run" }
  | { kind: "appcontainer-jobobject"; profileName: string }
  | { kind: "none" };

export interface HostProfile {
  os: "darwin" | "linux" | "win32";
  hasDisplay: boolean;
  sandboxPrimitive: SandboxPrimitive;
  browserBinaryFor(key: ChromiumBrowserKey): string | null;
  profileRootFor(key: ChromiumBrowserKey): string | null;
  profileRootCandidatesFor(key: ChromiumBrowserKey): string[];
  isProcessRunning(binaryPath: string, userDataDir: string): Promise<boolean>;
  terminate(pid: number, mode: "graceful" | "force"): Promise<void>;
}

export interface BrowserLifecycleTelemetry {
  browser: BrowserHistoryBrowserKey;
  stateBefore: "running" | "stopped" | "stale" | "paused" | "unknown";
  // `soft_refresh` is reserved for the §7.4.5 stale-sync recovery path that
  // the supervisor will grow when failure-escalation learns to recycle a
  // process instead of waiting for the cooldown. `quit` was removed
  // alongside Safari ingestion (the only producer); Chromium-family
  // browsers stay resident on the always-on host.
  actionTaken: "noop" | "launch" | "soft_refresh" | "skip";
  syncMtimeBefore: number | null;
  syncMtimeAfter: number | null;
  syncAgeAtIngestSeconds: number | null;
  rowsIngested: number;
  durationMs: number;
  outcome: "success" | "sync_unresponsive" | "launch_failed" | "paused" | "error" | "skipped";
  error?: string;
}

export interface FailureEscalationInput {
  state: BrowserHistoryLifecycleStateValue;
  consecutiveFailures: number;
  nowMs: number;
  outcome: BrowserLifecycleTelemetry["outcome"];
}
