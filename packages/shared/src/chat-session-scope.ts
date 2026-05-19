/**
 * Scopes that the dashboard chat sidebar shows and (consequently) the
 * DELETE /api/conversations endpoints operate on.
 *
 * Shared so the dashboard's `useConversations({ scope: ... })` filter and
 * the daemon's `deleteAllChatSidebarSessions` helper cannot drift: if one
 * side includes an extra scope, the other must follow.
 */
export const CHAT_SIDEBAR_SCOPES = [
  "dashboard_chat",
  "owner_dm",
] as const;

export type ChatSidebarScope = (typeof CHAT_SIDEBAR_SCOPES)[number];

/** Comma-joined form for the `scope` query param on GET /api/conversations. */
export const CHAT_SIDEBAR_SCOPE_PARAM = CHAT_SIDEBAR_SCOPES.join(",");

export function isChatSidebarScope(scope: string): scope is ChatSidebarScope {
  return (CHAT_SIDEBAR_SCOPES as readonly string[]).includes(scope);
}
