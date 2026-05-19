import type { PollCursor } from "../provider.js";

export interface GmailPollCursor extends Extract<PollCursor, { kind: "gmail" }> {
  processedIds?: string[];
  nextPageToken?: string;
  historyPageToken?: string;
}

const MAX_PROCESSED_IDS = 500;

export function seedGmailPollCursor(
  now: Date = new Date(),
  historyId?: string | null,
): GmailPollCursor {
  const cursor: GmailPollCursor = {
    kind: "gmail",
    lastEpoch: Math.floor(now.getTime() / 1000),
    processedIds: [],
  };
  if (historyId) cursor.historyId = historyId;
  return cursor;
}

export function trimGmailProcessedIds(ids: string[]): string[] {
  return ids.length > MAX_PROCESSED_IDS ? ids.slice(-MAX_PROCESSED_IDS) : ids;
}

export function normalizeGmailPollCursor(
  cursor: PollCursor | null,
  now: Date = new Date(),
): GmailPollCursor {
  if (!cursor || cursor.kind !== "gmail") {
    return seedGmailPollCursor(now);
  }
  return {
    ...cursor,
    processedIds: Array.isArray(cursor.processedIds)
      ? trimGmailProcessedIds(cursor.processedIds.filter((id) => typeof id === "string"))
      : [],
    nextPageToken:
      typeof cursor.nextPageToken === "string" && cursor.nextPageToken.length > 0
        ? cursor.nextPageToken
        : undefined,
    historyPageToken:
      typeof cursor.historyPageToken === "string" && cursor.historyPageToken.length > 0
        ? cursor.historyPageToken
        : undefined,
  };
}

