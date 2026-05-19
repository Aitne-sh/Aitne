"use client";

import type { ConversationRow } from "@/lib/api-types";

const PLATFORM_ORDER: Record<string, number> = {
  dashboard: 0,
  whatsapp: 1,
  telegram: 2,
  slack: 3,
  discord: 4,
};

const PLATFORM_LABELS: Record<string, string> = {
  dashboard: "Browser",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  slack: "Slack",
  discord: "Discord",
};

function sortPlatforms(platforms: string[]): string[] {
  return [...platforms].sort((left, right) => {
    const leftRank = PLATFORM_ORDER[left] ?? Number.MAX_SAFE_INTEGER;
    const rightRank = PLATFORM_ORDER[right] ?? Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return left.localeCompare(right);
  });
}

export function formatSessionSourcePlatform(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform;
}

function normalizeSourcePlatforms(row: ConversationRow): string[] {
  const unique = new Set(
    (row.source_platforms ?? []).filter((platform) => typeof platform === "string" && platform.length > 0),
  );

  if (unique.size === 0 && row.platform !== "owner") {
    unique.add(row.platform);
  }

  return sortPlatforms([...unique]);
}

export interface ChatHistorySession extends ConversationRow {
  sourcePlatforms: string[];
  sourceSummary: string;
  readOnlyFromDashboard: boolean;
  continueAvailable: boolean;
}

export function buildChatHistorySessions(
  conversations: ConversationRow[],
): ChatHistorySession[] {
  return conversations
    .filter((session) => session.status !== "active")
    .map((session) => {
      const sourcePlatforms = normalizeSourcePlatforms(session);
      const browserOnly =
        sourcePlatforms.length > 0 &&
        sourcePlatforms.every((platform) => platform === "dashboard");

      return {
        ...session,
        sourcePlatforms,
        sourceSummary:
          sourcePlatforms.length > 0
            ? sourcePlatforms.map(formatSessionSourcePlatform).join(" + ")
            : "Unknown",
        readOnlyFromDashboard: !browserOnly,
        continueAvailable: browserOnly && session.continue_available,
      };
    });
}
