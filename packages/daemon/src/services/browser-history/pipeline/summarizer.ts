import { createHash } from "node:crypto";
import { getAgentDayDateStr, type BrowserHistoryBrowserKey } from "@aitne/shared";
import type { ChromiumVisitRow } from "../readers/chromium-reader.js";
import { classifyVisit } from "./classifier.js";
import { redactVisit, type RedactedVisit } from "./redactor.js";
import { classifyMeaningful } from "./meaningful-filter.js";
import { extractAmazonReference } from "./amazon-extractor.js";
import { isReloadTransition, reloadPatternKey } from "./reload-detector.js";

export interface SummarizeDayBoundary {
  timezone: string | undefined;
  dayBoundaryHour: number;
}

const DEFAULT_BOUNDARY: SummarizeDayBoundary = {
  timezone: undefined,
  dayBoundaryHour: 4,
};

function agentDayKey(tsMs: number, boundary: SummarizeDayBoundary): string {
  return getAgentDayDateStr(
    boundary.timezone,
    boundary.dayBoundaryHour,
    new Date(tsMs),
  );
}

export interface ReloadIncrementEmission {
  date: string;
  urlPattern: string;
  count: number;
}

export interface SummarizedVisit {
  ts: number;
  browser: BrowserHistoryBrowserKey;
  profile: string;
  urlHash: string;
  domain: string;
  category: string;
  meaningful: 0 | 1;
  dwellSec: number | null;
  foregroundSec: number | null;
  transition: number;
  isReload: 0 | 1;
  rootTaskId: number | null;
  httpStatus: number | null;
  title: string | null;
  searchQuery: string | null;
  amazonAsin: string | null;
  amazonLocale: string | null;
}

export interface SummarizeInput {
  browser: BrowserHistoryBrowserKey;
  profile: string;
  rows: readonly ChromiumVisitRow[];
  boundary?: SummarizeDayBoundary;
}

export interface SummarizeResult {
  visits: SummarizedVisit[];
  reloadIncrements: ReloadIncrementEmission[];
  highestTimestampMs: number;
  dropped: number;
}

const HASH_DOMAIN = "browser-visit";

function hashUrl(url: string): string {
  return createHash("sha256").update(`${HASH_DOMAIN}:${url}`).digest("hex");
}

function strippedHost(host: string): string {
  return host.replace(/^www\./i, "").toLowerCase();
}

export function summarizeVisits(input: SummarizeInput): SummarizeResult {
  const boundary = input.boundary ?? DEFAULT_BOUNDARY;
  const visits: SummarizedVisit[] = [];
  let highestTimestampMs = 0;
  let dropped = 0;
  const reloadCounter = new Map<string, number>();

  for (const row of input.rows) {
    if (row.visitTimeMs > highestTimestampMs) {
      highestTimestampMs = row.visitTimeMs;
    }

    const redacted: RedactedVisit = redactVisit({
      url: row.url,
      title: row.title,
      searchQuery: row.searchTerm,
    });
    if (redacted.drop || !redacted.scheme || !redacted.host) {
      dropped += 1;
      continue;
    }

    const category = classifyVisit({
      scheme: redacted.scheme,
      host: redacted.host,
      path: redacted.path,
    });

    const meaningfulVerdict = classifyMeaningful({
      scheme: redacted.scheme,
      host: redacted.host,
      path: redacted.path,
      category,
      foregroundSeconds: row.foregroundSec,
    });

    const amazon =
      category === "shopping"
        ? extractAmazonReference({
            scheme: redacted.scheme,
            host: redacted.host,
            path: redacted.path,
            url: redacted.url,
          })
        : null;

    const reload = isReloadTransition(row.transition);
    if (reload) {
      const pattern = reloadPatternKey({
        host: strippedHost(redacted.host),
        path: redacted.path,
      });
      const key = `${agentDayKey(row.visitTimeMs, boundary)}::${pattern}`;
      reloadCounter.set(key, (reloadCounter.get(key) ?? 0) + 1);
    }

    visits.push({
      ts: row.visitTimeMs,
      browser: input.browser,
      profile: input.profile,
      urlHash: hashUrl(redacted.url),
      domain: strippedHost(redacted.host),
      category,
      meaningful: meaningfulVerdict.meaningful ? 1 : 0,
      dwellSec: row.durationSinceLastVisitSec,
      foregroundSec: row.foregroundSec,
      transition: row.transition,
      isReload: reload ? 1 : 0,
      rootTaskId: row.rootTaskId,
      httpStatus: row.httpStatus,
      title: redacted.title,
      searchQuery: redacted.searchQuery,
      amazonAsin: amazon?.asin ?? null,
      amazonLocale: amazon?.locale ?? null,
    });
  }

  const reloadIncrements: ReloadIncrementEmission[] = [];
  for (const [key, count] of reloadCounter) {
    const [date, urlPattern] = key.split("::");
    reloadIncrements.push({ date, urlPattern, count });
  }

  return { visits, reloadIncrements, highestTimestampMs, dropped };
}
