"use client";

export interface ReconnectableChatMessage {
  id: string;
  role: "user" | "assistant" | "error";
  content: string;
  timestamp: Date;
}

const RECENT_RESTORED_PADDING = 4;

function signature(message: Pick<ReconnectableChatMessage, "role" | "content">): string {
  return `${message.role}\u0000${message.content}`;
}

export function reconcileLiveMessagesAfterHistoryReload(
  restored: Array<Pick<ReconnectableChatMessage, "role" | "content">>,
  live: ReconnectableChatMessage[],
  syncStartedAtMs: number,
): ReconnectableChatMessage[] {
  const recentRestored = restored.slice(
    -Math.max(live.length + RECENT_RESTORED_PADDING, RECENT_RESTORED_PADDING),
  );
  const persistedCounts = new Map<string, number>();

  for (const message of recentRestored) {
    const key = signature(message);
    persistedCounts.set(key, (persistedCounts.get(key) ?? 0) + 1);
  }

  return live.filter((message) => {
    if (message.role === "error") {
      return true;
    }
    if (message.id.startsWith("stream-")) {
      return false;
    }
    if (message.timestamp.getTime() <= syncStartedAtMs) {
      return false;
    }

    const key = signature(message);
    const remaining = persistedCounts.get(key) ?? 0;
    if (remaining > 0) {
      persistedCounts.set(key, remaining - 1);
      return false;
    }

    return true;
  });
}
