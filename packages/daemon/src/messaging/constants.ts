export const OWNER_DM_SCOPE = "owner_dm";
export const DASHBOARD_CHAT_SCOPE = "dashboard_chat";
export const DOCS_QA_SCOPE = "docs_qa";
export const THREAD_SCOPE = "thread";
export const OWNER_SCOPE_KEY = "owner";
export const DASHBOARD_SCOPE_KEY = "dashboard";
// QA never branches by sender like owner_dm does, so the scope value
// doubles as the per-session lookup key.
export const DOCS_QA_SCOPE_KEY = "docs_qa";
export const LOGICAL_OWNER_PLATFORM = "owner";
export const LOGICAL_OWNER_CHANNEL = "owner";

export const SUPPORTED_MESSAGING_PLATFORMS = [
  "slack",
  "telegram",
  "discord",
  "whatsapp",
  "dashboard",
] as const;

export const NOTIFICATION_DESTINATION_PLATFORMS = [
  "slack",
  "telegram",
  "discord",
  "whatsapp",
] as const;

export type NotificationDestinationPlatform =
  (typeof NOTIFICATION_DESTINATION_PLATFORMS)[number];

export function isNotificationDestinationPlatform(
  value: string,
): value is NotificationDestinationPlatform {
  return (
    NOTIFICATION_DESTINATION_PLATFORMS as readonly string[]
  ).includes(value);
}

export function getConversationScope(params: {
  platform: string;
  channel: string;
  threadId: string | null;
  isDm?: boolean;
  /**
   * `MessageEvent.intent` discriminator (see packages/shared/src/types.ts).
   * Forks the dashboard DM tuple into a separate `docs_qa` scope so the
   * QA panel and the chat panel get distinct rows in
   * `conversation_sessions` and distinct execution gates in the
   * dispatcher. Honored only when paired with `platform="dashboard"` +
   * `isDm=true`; ignored otherwise as defense-in-depth.
   */
  intent?: "chat" | "docs_qa";
}): { scope: string; scopeKey: string } {
  if (params.isDm) {
    if (params.platform === "dashboard") {
      if (params.intent === "docs_qa") {
        return {
          scope: DOCS_QA_SCOPE,
          scopeKey: DOCS_QA_SCOPE_KEY,
        };
      }
      return {
        scope: DASHBOARD_CHAT_SCOPE,
        scopeKey: DASHBOARD_SCOPE_KEY,
      };
    }
    return {
      scope: OWNER_DM_SCOPE,
      scopeKey: OWNER_SCOPE_KEY,
    };
  }

  return {
    scope: THREAD_SCOPE,
    scopeKey: `${params.platform}:${params.channel}:${params.threadId ?? ""}`,
  };
}
