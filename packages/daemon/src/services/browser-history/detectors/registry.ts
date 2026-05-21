import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  BrowserHistoryBrowserKey,
  BrowserHistoryCapabilities,
  BrowserHistoryDetectionStatus,
} from "@aitne/shared";
import type { AgentConfig } from "../../../config.js";
import { readIntegrations } from "../../../db/integrations-store.js";
import type { BrowserDetectionResult, HostProfile } from "../types.js";
import { detectChromiumBrowser } from "./chromium.js";
import { detectChrome } from "./chrome.js";
import { detectComet } from "./comet.js";
import { detectAtlas } from "./atlas.js";

const ALL_BROWSERS: readonly BrowserHistoryBrowserKey[] = [
  "chrome",
  "chromium",
  "edge",
  "brave",
  "comet",
  "atlas",
];

function isReadableStatus(status: BrowserHistoryDetectionStatus): boolean {
  return status === "available"
    || status === "available_no_sync"
    || status === "available_sync_broken";
}

export function browserHistoryCacheRoot(dataDir: string): string {
  return join(dataDir, "cache", "browser-history");
}

export function computeBrowserHistoryIngestEnabled(
  db: Parameters<typeof readIntegrations>[0],
  config: Pick<
    AgentConfig,
    "browserHistoryConsentAccepted" | "browserHistoryBrowserOverrides"
  >,
  results: readonly BrowserDetectionResult[],
): BrowserHistoryBrowserKey[] {
  const integrations = readIntegrations(db);
  if (
    !config.browserHistoryConsentAccepted
    || integrations.browser_history?.mode !== "direct"
  ) {
    return [];
  }

  const enabled: BrowserHistoryBrowserKey[] = [];
  for (const result of results) {
    const override = config.browserHistoryBrowserOverrides[result.browser] ?? "auto";
    if (override === "forced-off") continue;
    if (override === "forced-on" || isReadableStatus(result.status)) {
      enabled.push(result.browser);
    }
  }
  return enabled;
}

export function serializeBrowserHistoryCapabilities(
  detectedAt: string,
  results: readonly BrowserDetectionResult[],
  ingestEnabled: BrowserHistoryBrowserKey[],
): BrowserHistoryCapabilities {
  const browsers = Object.fromEntries(
    ALL_BROWSERS.map((browser) => {
      const result = results.find((entry) => entry.browser === browser);
      return [browser, result?.status ?? "not_installed"];
    }),
  ) as Record<BrowserHistoryBrowserKey, BrowserHistoryDetectionStatus>;

  const details = Object.fromEntries(
    results.map((result) => {
      const mtimes = result.profiles
        .map((profile) => profile.lastHistoryMtimeMs)
        .filter((value): value is number => value !== null);
      return [
        result.browser,
        {
          status: result.status,
          profileCount: result.profiles.length,
          readableProfiles: result.profiles.length,
          signedInProfiles: result.profiles.filter((profile) => profile.signedIn).length,
          lastHistoryMtimeMs: mtimes.length > 0 ? Math.max(...mtimes) : null,
          nonCanonicalLayout: result.nonCanonicalLayout ?? false,
          message: result.error ?? null,
        },
      ];
    }),
  );

  return { detectedAt, browsers, ingestEnabled, details };
}

export async function detectBrowserHistoryCapabilities(params: {
  db: Parameters<typeof readIntegrations>[0];
  config: AgentConfig;
  host: HostProfile;
}): Promise<{
  capabilities: BrowserHistoryCapabilities;
  results: BrowserDetectionResult[];
}> {
  const cacheRoot = browserHistoryCacheRoot(params.config.dataDir);
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const detectorCalls: Array<Promise<BrowserDetectionResult>> = [
    detectChrome(params.host, cacheRoot),
    detectChromiumBrowser("chromium", params.host, cacheRoot),
    detectChromiumBrowser("edge", params.host, cacheRoot),
    detectChromiumBrowser("brave", params.host, cacheRoot),
    detectComet(params.host, cacheRoot),
    detectAtlas(params.host, cacheRoot),
  ];
  const results = await Promise.all(detectorCalls);
  const ingestEnabled = computeBrowserHistoryIngestEnabled(
    params.db,
    params.config,
    results,
  );
  return {
    capabilities: serializeBrowserHistoryCapabilities(
      new Date().toISOString(),
      results,
      ingestEnabled,
    ),
    results,
  };
}
