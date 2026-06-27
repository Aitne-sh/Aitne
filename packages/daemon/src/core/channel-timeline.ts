import type Database from "better-sqlite3";
import type { AgentConfig } from "../config.js";
import {
  DASHBOARD_CHAT_SCOPE,
  OWNER_DM_SCOPE,
  getConversationScope,
} from "../messaging/constants.js";
import { MessageRecorder } from "./message-recorder.js";
import { findOrCreateActiveChannelSession } from "./session-manager.js";

export const PROACTIVE_FORWARD_TYPES = [
  "proactive_forward",
  "proactive_forward_batched",
  // DM-HISTORY-CONTINUITY-FIX H-1 — scheduled DMs dispatched by
  // `scheduler.handleDirectDm` are recorded into `messages` via the
  // shared channel-timeline path so the DM agent sees its own
  // pre-composed sends in `<conversation_history>` and the cross-
  // session bridge. Without this type the message would land in
  // `notification_log` only and the user's follow-up reply would
  // have nothing to anchor to.
  "scheduled_dm",
  // BACKGROUND_TASK_RUNNER_DESIGN.md Phase 1 — task.delivery records
  // browser-task results and clarification prompts into owner-facing
  // conversation history.
  "task_result",
  "task_clarification",
] as const;

export type ProactiveForwardType = (typeof PROACTIVE_FORWARD_TYPES)[number];

/**
 * Render-side suffix that goes after the role tag in the assembled
 * `<conversation_history>` line and the cross-session
 * "## Previous conversation in this thread" line. Centralised so the
 * two render sites stay in lock-step when a new forward type is added.
 *
 * - `proactive_forward` / `proactive_forward_batched` →
 *   "(forwarded from autonomous run)" — the row was emitted by an
 *   autonomous run that the user did not directly trigger.
 * - `scheduled_dm` → "(scheduled DM dispatched)" — the row is the
 *   pre-composed body of a `/api/schedule/dm` request the user (or an
 *   earlier agent turn) booked ahead of time. We deliberately do NOT
 *   embed the dispatch timestamp here: every line already carries the
 *   `[timestamp]` prefix added by the caller, so a second timestamp
 *   in the suffix would just duplicate that information.
 * - `task_result` / `task_clarification` → task-delivery annotations
 *   used by the DM agent to understand that a background task result or
 *   clarification was already surfaced.
 */
export function formatForwardSuffix(
  metadata: Record<string, unknown>,
): string {
  switch (getProactiveForwardType(metadata)) {
    case "task_result":
      return " (background task result delivered)";
    case "task_clarification":
      return " (background task clarification requested)";
    case "scheduled_dm":
      return " (scheduled DM dispatched)";
    case "proactive_forward":
    case "proactive_forward_batched":
      return " (forwarded from autonomous run)";
    default:
      return "";
  }
}

export interface DeliveryRow {
  platform: string;
  channel: string;
  messageId?: string;
}

export interface ProactiveForwardRecordResult {
  inserted: number;
  sessionIds: number[];
}

export function parseMessageMetadata(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

export function getProactiveForwardType(
  metadata: Record<string, unknown>,
): ProactiveForwardType | null {
  const value = metadata.notificationType;
  return (PROACTIVE_FORWARD_TYPES as readonly string[]).includes(String(value))
    ? (value as ProactiveForwardType)
    : null;
}

export function isProactiveForwardMetadata(
  metadata: Record<string, unknown>,
): boolean {
  return getProactiveForwardType(metadata) !== null;
}

export function metadataDispatchIds(
  metadata: Record<string, unknown>,
): string[] {
  const raw = metadata.dispatchIds;
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is string => typeof value === "string");
}

export function recordProactiveForwardDeliveries(params: {
  db: Database.Database;
  config: Pick<
    AgentConfig,
    "proactiveForwardChannelTimelineEnabled" | "proactiveForwardForceFreshSession"
  >;
  deliveries: DeliveryRow[];
  content: string;
  dispatchId?: string | null;
  dispatchIds?: string[];
  originSessionIds?: Array<number | null | undefined>;
  notificationType: ProactiveForwardType;
  extraMetadata?: Record<string, unknown>;
}): ProactiveForwardRecordResult {
  if (params.config.proactiveForwardChannelTimelineEnabled === false) {
    return { inserted: 0, sessionIds: [] };
  }
  if (params.deliveries.length === 0 || params.content.length === 0) {
    return { inserted: 0, sessionIds: [] };
  }

  const recorder = new MessageRecorder(params.db);
  const dispatchIds = dedupeStrings(
    params.dispatchIds ?? (params.dispatchId ? [params.dispatchId] : []),
  );
  const originSessionIds = dedupeNumbers(params.originSessionIds ?? []);
  // Single-dispatch types carry the dispatch_id on the indexed column
  // (`idx_messages_dispatch ... WHERE notification_dispatch_id IS NOT
  // NULL`) so the row is reachable via the same fast-lookup path as
  // notification_log. `proactive_forward_batched` is excluded because
  // the row aggregates N origin dispatches and no single id is
  // authoritative — the full set lives in `metadata.dispatchIds`.
  // `scheduled_dm` IS single-dispatch (one dispatchId per
  // `handleDirectDm` call) so it joins `proactive_forward` on this rule.
  const notificationDispatchId =
    params.notificationType === "proactive_forward"
    || params.notificationType === "scheduled_dm"
      ? params.dispatchId ?? null
      : null;
  const metadata = {
    notificationType: params.notificationType,
    dispatchIds,
    originSessionIds,
    ...(params.extraMetadata ?? {}),
  };

  let inserted = 0;
  const sessionIds: number[] = [];
  for (const delivery of params.deliveries) {
    const { scope, scopeKey } = getConversationScope({
      platform: delivery.platform,
      channel: delivery.channel,
      threadId: null,
      isDm: true,
      intent: "chat",
    });
    /* c8 ignore start — defense-in-depth: getConversationScope with
       isDm=true + intent="chat" provably returns either OWNER_DM_SCOPE
       or DASHBOARD_CHAT_SCOPE today, so this guard cannot fire under
       the current scope contract. Kept so a future scope addition
       (e.g. group-chat scope) cannot silently leak forwards into an
       unintended scope without an explicit channel-timeline opt-in. */
    if (scope !== OWNER_DM_SCOPE && scope !== DASHBOARD_CHAT_SCOPE) {
      continue;
    }
    /* c8 ignore stop */

    const session = findOrCreateActiveChannelSession(params.db, {
      scope,
      scopeKey,
      platform: delivery.platform,
      channelId: delivery.channel,
    });
    const recorded = recorder.recordMessage({
      sessionId: session.id,
      role: "assistant",
      content: params.content,
      platform: delivery.platform,
      metadata,
      notificationDispatchId,
    });
    if (!recorded) continue;

    inserted += 1;
    sessionIds.push(session.id);
    if (params.config.proactiveForwardForceFreshSession === true) {
      params.db
        .prepare(
          `UPDATE conversation_sessions
              SET backend_session_id = NULL
            WHERE id = ?`,
        )
        .run(session.id);
    }
  }

  return { inserted, sessionIds: dedupeNumbers(sessionIds) };
}

function dedupeStrings(values: readonly unknown[]): string[] {
  return [
    ...new Set(
      values.filter((value): value is string => typeof value === "string" && value.length > 0),
    ),
  ];
}

function dedupeNumbers(values: readonly unknown[]): number[] {
  return [
    ...new Set(
      values.filter(
        (value): value is number =>
          typeof value === "number" && Number.isInteger(value) && value > 0,
      ),
    ),
  ];
}
