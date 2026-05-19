"use client";

import { useConfig } from "@/lib/hooks/use-config";
import { useHealth } from "@/lib/hooks/use-health";
import { IntegrationCard } from "@/components/connections/integration-card";

/**
 * Outlook Calendar connection card (SETUP-FLOW-REDESIGN-PLAN §5.5 / §8).
 *
 * Thin wrapper around the registry-driven `IntegrationCard` keyed on
 * `outlook_calendar`. The descriptor's `supportedModes: ["direct",
 * "delegated", "native", "disabled"]` surfaces every mode. Microsoft
 * does not ship a hosted Outlook MCP connector for Claude / Codex /
 * Gemini, so `userManagedConnector: true` instructs the card to render
 * the "register an Outlook MCP on the chosen backend" notice instead of
 * a feature matrix for both delegated and native — see
 * INTEGRATION_NATIVE_MODE_DESIGN.md §5.3 (2026-05 amendment).
 *
 * Auth state is shared with Outlook Mail via the MSAL cache key
 * `mail:outlook:<accountId>` — the surrounding card surfaces the
 * shared-token status in the standard health pill, so no Outlook-
 * specific code path is needed here. When Outlook Mail is configured
 * direct + authenticated, calendar reads succeed immediately.
 */
export function OutlookCalendarCard() {
  const { data: config } = useConfig();
  const { data: health } = useHealth();
  // Match the rest of the connections page: skip rendering until config
  // and health load so the page does not flash an empty Outlook frame.
  if (!config || !health) return null;
  return <IntegrationCard integrationKey="outlook_calendar" />;
}
