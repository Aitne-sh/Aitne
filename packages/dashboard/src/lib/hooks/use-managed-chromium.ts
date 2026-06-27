"use client";

import { useQuery } from "@tanstack/react-query";
import type {
  BrowserAutomationSitesResponse,
  ManagedChromiumStatusResponse,
} from "@aitne/shared";
import { api } from "@/lib/api-client";

/**
 * Shared managed-Chromium queries (BROWSER_HUB_CONSOLIDATION_DESIGN.md).
 *
 * Extracted from `app/settings/integrations/browser-history-managed/page.tsx`
 * so the `/browser` hub and the Browser Automation settings page share one
 * query-cache entry per endpoint. Query keys are unchanged from the page's
 * originals — mutation/SSE invalidations keyed on them keep working.
 */

export const MANAGED_STATUS_QUERY_KEY = ["browser-history-managed-status"] as const;
export const AUTOMATION_SITES_QUERY_KEY = ["browser-automation-sites"] as const;

export function useManagedStatus(refetchIntervalMs?: number) {
  return useQuery({
    queryKey: MANAGED_STATUS_QUERY_KEY,
    queryFn: () =>
      api.get<ManagedChromiumStatusResponse>("/browser-history/managed/status"),
    refetchInterval: refetchIntervalMs ?? false,
    staleTime: 5_000,
  });
}

/** B-2.5 — list of registered per-site auth profiles. Refetched
 *  alongside the master managed-Chromium status so per-site state
 *  changes propagate without a hard reload. */
export function useAutomationSites(enabled: boolean) {
  return useQuery({
    queryKey: AUTOMATION_SITES_QUERY_KEY,
    queryFn: () =>
      api.get<BrowserAutomationSitesResponse>("/browser-automation/sites"),
    refetchInterval: enabled ? 15_000 : false,
    enabled,
    staleTime: 5_000,
  });
}
