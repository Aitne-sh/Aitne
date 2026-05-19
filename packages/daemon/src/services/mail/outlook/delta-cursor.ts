import type { PollCursor } from "../provider.js";

export type GraphCursor = Extract<PollCursor, { kind: "graph" }>;

export interface DeltaPage<T = unknown> {
  value: T[];
  nextLink: string | null;
  deltaLink: string | null;
}

/**
 * Build the initial delta URL for the given Inbox folder.
 * Caller passes through {@link extractDeltaPage} to interpret the response.
 */
export function buildInboxDeltaUrl(opts: {
  base?: string;
  pageSize: number;
  selectFields: readonly string[];
}): string {
  const base = opts.base ?? "https://graph.microsoft.com/v1.0";
  const params = new URLSearchParams();
  params.set("$select", opts.selectFields.join(","));
  params.set("$top", String(opts.pageSize));
  return `${base}/me/mailFolders/Inbox/messages/delta?${params.toString()}`;
}

/**
 * Resolve the URL to fetch on the next call.
 *
 * - `nextLink` (mid-pagination) → caller is mid-page; re-poll immediately and
 *   set `drained: false`.
 * - `deltaLink` (end-of-page)   → caller is caught up; persist for next tick
 *   and set `drained: true`.
 * - No cursor                   → fall back to the initial delta URL.
 */
export function resolveDeltaUrl(
  cursor: GraphCursor | null,
  initialUrl: string,
): { url: string; isContinuation: boolean } {
  if (!cursor) return { url: initialUrl, isContinuation: false };
  if (cursor.nextLink) return { url: cursor.nextLink, isContinuation: true };
  if (cursor.deltaLink) return { url: cursor.deltaLink, isContinuation: true };
  return { url: initialUrl, isContinuation: false };
}

/**
 * Pick `nextLink` over `deltaLink` (Graph guarantees only one is present per
 * page). The unused field is normalized to null so downstream code never sees
 * stale state from a prior page.
 */
export function extractDeltaPage<T = unknown>(body: {
  value?: T[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}): DeltaPage<T> {
  return {
    value: Array.isArray(body.value) ? body.value : [],
    nextLink: typeof body["@odata.nextLink"] === "string"
      ? body["@odata.nextLink"]
      : null,
    deltaLink: typeof body["@odata.deltaLink"] === "string"
      ? body["@odata.deltaLink"]
      : null,
  };
}

export interface CursorAdvance {
  cursor: GraphCursor;
  drained: boolean;
}

/**
 * Translate a delta page into the next cursor + drained flag (§3.4 / §3.1.1).
 * `drained=false` instructs the poller to re-call immediately to consume the
 * remaining pages before yielding back to the timer.
 */
export function advanceCursor(page: DeltaPage): CursorAdvance {
  if (page.nextLink) {
    return { cursor: { kind: "graph", nextLink: page.nextLink }, drained: false };
  }
  if (page.deltaLink) {
    return { cursor: { kind: "graph", deltaLink: page.deltaLink }, drained: true };
  }
  return { cursor: { kind: "graph" }, drained: true };
}

export interface RemovedAnnotation {
  id?: string;
  "@removed"?: { reason?: string };
}

/**
 * `@removed.reason` is `deleted` (purged) or `changed` (moved out of Inbox /
 * label removed). For Inbox-scoped delta both mean "no longer in the
 * watched view" — surface to {@link PollResult.removedIds}.
 */
export function isRemovedItem(item: RemovedAnnotation): boolean {
  const reason = item["@removed"]?.reason;
  return reason === "deleted" || reason === "changed";
}

export function parseGraphCursorJson(raw: string | null | undefined): GraphCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { kind?: string };
    if (parsed.kind !== "graph") return null;
    return parsed as GraphCursor;
  } catch {
    return null;
  }
}

export function serializeGraphCursor(cursor: GraphCursor): string {
  return JSON.stringify(cursor);
}
