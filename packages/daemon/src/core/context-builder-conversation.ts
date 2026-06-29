import type Database from "better-sqlite3";
import type { Event, MessageEvent } from "@aitne/shared";
import {
  formatSqliteDatetime,
  isMessageEvent,
  parseSqliteUtcMs,
} from "@aitne/shared";
import type { AgentConfig } from "../config.js";
import {
  formatForwardSuffix,
  getProactiveForwardType,
  isProactiveForwardMetadata,
  metadataDispatchIds,
  parseMessageMetadata,
} from "./channel-timeline.js";
import {
  OWNER_DM_SCOPE,
  OWNER_SCOPE_KEY,
  DASHBOARD_CHAT_SCOPE,
  DASHBOARD_SCOPE_KEY,
  getConversationScope,
} from "../messaging/constants.js";
import { createLogger } from "../logging.js";
import { sanitizeUntrustedTemplateValue } from "./backends/prompt-utils.js";
import {
  formatSqliteTimestampForContext,
  truncateContextText,
  truncateForBlock,
} from "./context-builder-format.js";

/**
 * Stored message content is user/platform-originated and therefore
 * untrusted in the same sense as `event_data[content]`: a past message
 * carrying `</conversation_history>` (or any structural close tag) could
 * end its wrapper early and inject instructions outside the quarantined
 * block. The cross-session path already escapes via `buildExecutionPrompt`
 * (`prompt-utils.ts`); every renderer here applies the same defence so the
 * active-session blocks can't be used as the unescaped side door.
 */
function sanitizeMessageContent(content: string): string {
  return sanitizeUntrustedTemplateValue(content);
}

const logger = createLogger("context-builder-conversation");

// Per-block ceiling for `renderRecentDmConversationLog`. Kept in lock-step
// with `YESTERDAY_DM_LOG_LIMIT` in `context-builder-yesterday.ts` — pre-
// split both renderers shared a single module constant, so any cap change
// must move both files together to preserve byte-identical output across
// the morning-routine yesterday block AND the roadmap-refresh rolling
// window. Diverging the two would silently regress one surface.
const RECENT_DM_LOG_LIMIT = 20;

interface DmConversationLogRow {
  platform: string;
  scope: string;
  scope_key: string;
  summary: string;
  message_count: number;
  created_at: string;
}

interface ConversationDeps {
  db: Database.Database;
  config: AgentConfig;
}

/**
 * SCHEDULED-DM-IMPLEMENTATION-PLAN §5.7 — return inbound owner-DM
 * messages received in the last `windowMinutes` across BOTH
 * owner-facing scopes (`owner_dm` for messaging-app DMs and
 * `dashboard_chat` for the dashboard chat panel), formatted one per
 * line oldest first. Returns null when there are no messages so the
 * caller can omit the block entirely.
 *
 * The two-scope query mirrors §3.6's gate set: the briefing
 * serializes behind both surfaces, so the LLM must see both
 * surfaces when classifying conversation state. A single-scope read
 * here would mis-classify state as `asleep` whenever the user is
 * mid-conversation on the OTHER surface — exactly the
 * voice-mismatch failure the design exists to fix.
 *
 * `docs_qa` is intentionally excluded — that surface is research
 * lookups, not conversation; gating against it would freeze
 * briefings during long doc-searches.
 */
export function renderRecentDmActivityBlock(
  deps: ConversationDeps,
  windowMinutes: number,
): string | null {
  const { db } = deps;
  const sinceUtc = formatSqliteDatetime(
    new Date(Date.now() - windowMinutes * 60_000),
  );
  const rows = db
    .prepare(
      `SELECT m.role, m.content, m.timestamp
         FROM messages m
         JOIN conversation_sessions s ON m.session_id = s.id
         WHERE s.scope IN (?, ?) AND m.role = 'user' AND m.timestamp >= ?
         ORDER BY m.timestamp ASC
         LIMIT 30`,
    )
    .all(OWNER_DM_SCOPE, DASHBOARD_CHAT_SCOPE, sinceUtc) as {
      role: string;
      content: string;
      timestamp: string;
    }[];

  if (rows.length === 0) return null;
  return rows
    .map(
      (r) =>
        `[${r.timestamp}] ${sanitizeMessageContent(truncateForBlock(r.content, 200))}`,
    )
    .join("\n");
}

export type OwnerDmActivityState = "active" | "idle";

/**
 * BACKGROUND_TASK_RUNNER_DESIGN.md §2.6 — deterministic activity branch
 * for task.delivery. Unlike `renderRecentDmActivityBlock`, this returns a
 * programmatic active/idle decision and must stay model-free.
 */
export function classifyOwnerDmActivity(
  deps: ConversationDeps,
  nowMs = Date.now(),
): OwnerDmActivityState {
  const thresholdMinutes = Math.max(
    1,
    deps.config.ownerActivityIdleThresholdMinutes,
  );
  const row = deps.db
    .prepare(
      `SELECT MAX(m.timestamp) AS ts
         FROM messages m
         JOIN conversation_sessions s ON m.session_id = s.id
        WHERE s.scope IN (?, ?)
          AND m.role = 'user'`,
    )
    .get(OWNER_DM_SCOPE, DASHBOARD_CHAT_SCOPE) as
    | { ts: string | null }
    | undefined;
  if (!row?.ts) return "idle";
  const lastInboundMs = parseSqliteUtcMs(row.ts);
  return nowMs - lastInboundMs <= thresholdMinutes * 60_000
    ? "active"
    : "idle";
}

/**
 * SCHEDULED-DM-IMPLEMENTATION-PLAN §5.7 — return the last `limit`
 * owner-facing messages across BOTH `owner_dm` and `dashboard_chat`
 * scopes (interleaved by timestamp), formatted with role tags. Used
 * by `<recent_dm_conversation>` for topic awareness in the bridge
 * phrasing of Variant B briefings.
 *
 * Two-scope read — same reasoning as `renderRecentDmActivityBlock`:
 * the briefing must reconstruct topic context from whichever surface
 * the user has been using, not just the messaging-app one.
 */
export function renderOwnerDmConversationHistory(
  deps: ConversationDeps,
  limit: number,
): string | null {
  const { db } = deps;
  const rows = db
    .prepare(
      `SELECT m.role, m.content, m.timestamp, m.metadata
         FROM messages m
         JOIN conversation_sessions s ON m.session_id = s.id
         WHERE (s.scope = ? AND s.scope_key = ?)
            OR (s.scope = ? AND s.scope_key = ?)
         ORDER BY m.timestamp DESC, m.id DESC
         LIMIT ?`,
    )
    .all(
      OWNER_DM_SCOPE,
      OWNER_SCOPE_KEY,
      DASHBOARD_CHAT_SCOPE,
      DASHBOARD_SCOPE_KEY,
      limit,
    ) as {
      role: string;
      content: string;
      timestamp: string;
      metadata: string | null;
    }[];

  if (rows.length === 0) return null;
  return rows
    .reverse()
    .map((r) => {
      const forwardSuffix =
        r.role === "assistant"
          ? formatForwardSuffix(parseMessageMetadata(r.metadata))
          : "";
      return `[${r.timestamp}] [${r.role}]${forwardSuffix}: ${sanitizeMessageContent(truncateForBlock(r.content, 400))}`;
    })
    .join("\n");
}

export function getConversationHistoryForEvent(
  deps: ConversationDeps,
  event: MessageEvent,
): string | null {
  const { db, config } = deps;
  const maxMessages = config.historyInjectionMaxMessages ?? 50;

  let rows: {
    session_id: number;
    timestamp: string;
    role: string;
    content: string;
    platform: string;
    metadata: string | null;
    backend: string | null;
    model_id: string | null;
    backend_session_id: string | null;
  }[];

  if (event.isDm) {
    const { scope, scopeKey } = getConversationScope({
      platform: event.platform,
      channel: event.channel,
      threadId: event.threadId,
      isDm: true,
      // Without `intent`, a docs_qa event would query under
      // `dashboard_chat` and inject chat history into the QA prompt
      // (or miss its own QA history). Thread it through so each
      // dashboard scope retrieves only its own conversation.
      intent: event.intent,
    });
    // DM: load the active conversation for the matching DM surface.
    rows = db
      .prepare(
        `SELECT
             m.session_id,
             m.role,
             m.content,
             m.platform,
             m.timestamp,
             m.metadata,
             m.backend,
             m.model_id,
             s.backend_session_id
           FROM messages m
           JOIN conversation_sessions s ON m.session_id = s.id
           WHERE s.scope = ? AND s.scope_key = ? AND s.status = 'active'
           ORDER BY m.timestamp DESC, m.id DESC LIMIT ?`,
      )
      .all(scope, scopeKey, maxMessages) as typeof rows;
  } else {
    // Non-DM: query by (platform, channel, thread).
    // Hard-cap at 20 — threads are short-lived and higher limits risk
    // injecting stale context from unrelated earlier threads.
    const threadLimit = Math.min(maxMessages, 20);
    rows = db
      .prepare(
        `SELECT
             m.session_id,
             m.role,
             m.content,
             m.platform,
             m.timestamp,
             m.metadata,
             m.backend,
             m.model_id,
             s.backend_session_id
           FROM messages m
           JOIN conversation_sessions s ON m.session_id = s.id
           WHERE s.platform = ? AND s.channel_id = ? AND s.thread_id IS ?
           ORDER BY m.timestamp DESC, m.id DESC LIMIT ?`,
      )
      .all(event.platform, event.channel, event.threadId ?? null, threadLimit) as typeof rows;
  }

  if (rows.length === 0) return null;

  // Truncate by approximate token budget (1 token ≈ 4 chars).
  const maxTokens = config.historyInjectionMaxTokens ?? 8000;
  const reversed = rows.reverse();
  const proactiveRows: Array<{
    sessionId: number;
    dispatchIds: string[];
    sessionResumed: boolean;
  }> = [];
  let tokenBudget = maxTokens * 4; // chars remaining
  const lines: string[] = [];
  for (const r of reversed) {
    const metadata = parseMessageMetadata(r.metadata);
    const isForward = isProactiveForwardMetadata(metadata);
    const tag = r.backend
      ? `[${r.timestamp}] [${r.role}/${r.backend}:${r.model_id ?? "?"}]`
      : `[${r.timestamp}] [${r.role}]`;
    const forwardSuffix =
      r.role === "assistant" ? formatForwardSuffix(metadata) : "";
    const line = `${tag}${forwardSuffix}: ${sanitizeMessageContent(r.content)}`;
    tokenBudget -= line.length;
    if (tokenBudget < 0 && lines.length > 0) {
      lines.unshift(`[...${reversed.length - lines.length} older messages omitted]`);
      break;
    }
    if (isForward) {
      proactiveRows.push({
        sessionId: r.session_id,
        dispatchIds: metadataDispatchIds(metadata),
        sessionResumed: r.backend_session_id !== null,
      });
    }
    lines.push(line);
  }
  if (proactiveRows.length > 0) {
    logProactiveForwardInjected(db, proactiveRows);
  }
  return lines.join("\n");
}

export function renderRecentOtherSurfaceBlock(
  deps: ConversationDeps,
  event: MessageEvent,
): string | null {
  const { db, config } = deps;
  if (!event.isDm || event.intent === "docs_qa") return null;
  const windowMinutes = config.historyOtherSurfaceWindowMinutes ?? 1440;
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) return null;

  const { scope } = getConversationScope({
    platform: event.platform,
    channel: event.channel,
    threadId: event.threadId,
    isDm: true,
    intent: event.intent,
  });
  const other = resolveOtherDmScope(scope);
  if (!other) return null;

  const sinceUtc = formatSqliteDatetime(
    new Date(Date.now() - windowMinutes * 60_000),
  );
  const rows = db
    .prepare(
      `SELECT
           m.role,
           m.content,
           m.platform,
           m.timestamp,
           m.metadata,
           s.scope,
           s.scope_key
         FROM messages m
         JOIN conversation_sessions s ON m.session_id = s.id
         WHERE s.scope = ?
           AND s.scope_key = ?
           AND s.status = 'active'
           AND m.timestamp >= ?
         ORDER BY m.timestamp ASC, m.id ASC
         LIMIT 60`,
    )
    .all(other.scope, other.scopeKey, sinceUtc) as Array<{
    role: string;
    content: string;
    platform: string;
    timestamp: string;
    metadata: string | null;
    scope: string;
    scope_key: string;
  }>;

  if (rows.length === 0) return null;

  const lines: string[] = [];
  const ordinaryGroups = new Map<
    string,
    { scope: string; count: number; firstMs: number; lastMs: number }
  >();
  for (const row of rows) {
    const metadata = parseMessageMetadata(row.metadata);
    const forwardType = getProactiveForwardType(metadata);
    if (forwardType) {
      lines.push(
        `[${row.timestamp}] [${forwardType} → ${row.platform}]: ${sanitizeMessageContent(row.content)}`,
      );
      continue;
    }

    const key = `${row.scope}:${row.scope_key}`;
    const timestampMs = parseSqliteUtcMs(row.timestamp);
    const existing = ordinaryGroups.get(key);
    if (existing) {
      existing.count += 1;
      existing.firstMs = Math.min(existing.firstMs, timestampMs);
      existing.lastMs = Math.max(existing.lastMs, timestampMs);
    } else {
      ordinaryGroups.set(key, {
        scope: row.scope,
        count: 1,
        firstMs: timestampMs,
        lastMs: timestampMs,
      });
    }
  }

  for (const group of ordinaryGroups.values()) {
    const spanMinutes = Math.max(
      1,
      Math.ceil((group.lastMs - group.firstMs) / 60_000),
    );
    lines.push(
      `(${group.scope}: ${group.count} turns in last ${spanMinutes} minutes)`,
    );
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * STALE-REMINDER-FIX — render the agent's pending *one-off* scheduled
 * items (frozen DMs and agent wake-ups it queued earlier) so the live
 * owner-DM agent can SEE what future notifications are already in flight
 * and reconcile any the conversation has just made moot.
 *
 * The blind spot this closes: a frozen `dm` reminder ("remind me to
 * cancel LinkedIn") is dispatched verbatim at fire time with no
 * re-evaluation (scheduler `handleDirectDm`). When the owner reports the
 * task done mid-conversation, the agent previously had no way to know a
 * contradicting reminder was queued — pending `agent_schedule` rows were
 * never injected into the live DM context, and the agent will not
 * defensively `GET /api/schedule` every turn. Surfacing them here lets
 * it `DELETE`/`PATCH` the stale row in the same turn (the cancellation
 * machinery already exists), AND doubles as the schedule skill's
 * mandatory dedup pre-check source so a second identical reminder isn't
 * queued.
 *
 * Scope: only `recurring_schedule_id IS NULL` rows. Recurring
 * occurrences are owned by their parent rule (`/agents`,
 * `recurring-schedules`) and re-materialize if cancelled here, so
 * showing them as ad-hoc-cancelable would mislead. Owner-facing DM
 * surfaces only (`owner_dm` / `dashboard_chat`); `docs_qa` is research,
 * not conversation, so it gets nothing — mirrors
 * `renderRecentOtherSurfaceBlock`'s gate.
 */
export function renderScheduledRemindersBlock(
  deps: ConversationDeps,
  event: MessageEvent,
): string | null {
  if (!event.isDm || event.intent === "docs_qa") return null;
  const { db, config } = deps;
  const timezoneLabel = config.timezone || "system";

  // Fetch one past the display cap so an overflow can be flagged rather
  // than silently truncated — a hidden tail would let the dedup use of
  // this block wrongly conclude "no duplicate exists".
  const DISPLAY_LIMIT = 20;
  const rows = db
    .prepare(
      `SELECT id, scheduled_for, task_type, task_description, task_prompt
         FROM agent_schedule
        WHERE status = 'pending' AND recurring_schedule_id IS NULL
        ORDER BY scheduled_for ASC, id ASC
        LIMIT ${DISPLAY_LIMIT + 1}`,
    )
    .all() as {
    id: number;
    scheduled_for: string;
    task_type: string;
    task_description: string | null;
    task_prompt: string | null;
  }[];

  if (rows.length === 0) return null;

  const overflow = rows.length > DISPLAY_LIMIT;
  const lines = rows.slice(0, DISPLAY_LIMIT).map((r) => {
    // `dm` rows carry the verbatim message in task_description; agent
    // tasks carry an optional label there and the body in task_prompt.
    const subject =
      r.task_description && r.task_description.trim().length > 0
        ? r.task_description
        : (r.task_prompt ?? "");
    const when = formatSqliteTimestampForContext(
      r.scheduled_for,
      timezoneLabel,
    );
    // task_type is a free-form provenance label; sanitize it alongside
    // the subject so neither can break out of the wrapper tag.
    return `- #${r.id} · ${when} · ${sanitizeMessageContent(r.task_type)} · ${sanitizeMessageContent(
      truncateForBlock(subject, 140),
    )}`;
  });
  if (overflow) {
    lines.push(
      `- …soonest ${DISPLAY_LIMIT} shown; more pending — GET /api/schedule?status=pending,running for the full list before assuming none match.`,
    );
  }

  return [
    "These one-off notifications/tasks are already queued to fire on your",
    "behalf. If this conversation makes one unnecessary or wrong (the owner",
    "already did it, cancelled, or changed plans), reconcile it THIS turn",
    "via the schedule skill — DELETE /api/schedule/:id to cancel, or PATCH",
    "to re-time/re-word — and update the matching state/today.md Agent Plan",
    "row. A queued item left untouched WILL fire later. Also use this list",
    "to avoid scheduling a duplicate.",
    ...lines,
  ].join("\n");
}

/**
 * Map a DM-scope identifier to the cross-surface scope/key pair the
 * other owner-facing surface listens on. `owner_dm` ↔ `dashboard_chat`;
 * anything else (e.g. `docs_qa`) returns `null` so callers can skip the
 * cross-surface read. Shared by `renderRecentOtherSurfaceBlock` and
 * `renderResumeCatchupContext`, which both need to fan out one extra
 * read whenever the owner is mid-conversation on the other surface.
 */
function resolveOtherDmScope(
  scope: string,
): { scope: string; scopeKey: string } | null {
  if (scope === OWNER_DM_SCOPE) {
    return { scope: DASHBOARD_CHAT_SCOPE, scopeKey: DASHBOARD_SCOPE_KEY };
  }
  if (scope === DASHBOARD_CHAT_SCOPE) {
    return { scope: OWNER_DM_SCOPE, scopeKey: OWNER_SCOPE_KEY };
  }
  return null;
}

/**
 * Record an `agent_actions.proactive_forward_injected` row so the
 * dashboard's audit log shows when a proactive forward (e.g. scheduled
 * DM, activity-scan notification) was re-presented as conversation
 * history. Both runtime call sites (`getConversationHistoryForEvent`
 * and `renderResumeCatchupContext`) live in this file; the export is
 * kept only for the direct unit-test peer in
 * `context-builder-conversation.test.ts` that exercises the audit-row
 * dedup logic in isolation.
 */
export function logProactiveForwardInjected(
  db: Database.Database,
  rows: Array<{
    sessionId: number;
    dispatchIds: string[];
    sessionResumed: boolean;
  }>,
): void {
  const sessionId = rows[rows.length - 1]?.sessionId;
  if (sessionId === undefined) return;
  const dispatchIds = [
    ...new Set(rows.flatMap((row) => row.dispatchIds)),
  ];
  try {
    db
      .prepare(
        `INSERT INTO agent_actions (
             action_type, trigger, result, detail, started_at
           )
           VALUES (
             'proactive_forward_injected',
             'reactive',
             'success',
             ?,
             CURRENT_TIMESTAMP
           )`,
      )
      .run(
        JSON.stringify({
          sessionId,
          dispatchIds,
          forwardCount: rows.length,
          sessionResumed: rows.some((row) => row.sessionResumed),
        }),
      );
  } catch (err) {
    logger.warn({ err, sessionId }, "Failed to log proactive forward injection");
  }
}

/**
 * Render a rolling 7-day (or N-day) window of DM conversation-log
 * summaries for roadmap_refresh. Unlike `buildYesterdayContext`,
 * which is anchored to the previous agent-day for journal synthesis,
 * this window is calendar-rolling — refreshes can trigger at any
 * time, and the prompt needs whatever recent DM context exists.
 *
 * Returns a formatted markdown block; falls back to a "(none)" stub
 * so the prompt can always cite the tag unconditionally.
 */
export function renderRecentDmConversationLog(
  deps: ConversationDeps,
  days: number,
): string {
  const { db, config } = deps;
  const timezoneLabel = config.timezone || "system";
  const nowMs = Date.now();
  const startMs = nowMs - days * 24 * 60 * 60 * 1000;
  const startSqlite = formatSqliteDatetime(new Date(startMs));
  const endSqlite = formatSqliteDatetime(new Date(nowMs));

  const total = (
    db
      .prepare(
        `SELECT COUNT(*) as cnt FROM dm_conversation_log
           WHERE created_at >= ? AND created_at < ?`,
      )
      .get(startSqlite, endSqlite) as { cnt: number }
  ).cnt;

  const rows = (
    db
      .prepare(
        `SELECT platform, scope, scope_key, summary, message_count, created_at
           FROM dm_conversation_log
           WHERE created_at >= ? AND created_at < ?
           ORDER BY created_at DESC
           LIMIT ?`,
      )
      .all(
        startSqlite,
        endSqlite,
        RECENT_DM_LOG_LIMIT,
      ) as DmConversationLogRow[]
  ).reverse();

  const lines = [
    `- Window: last ${days} days`,
    `- Timezone: ${timezoneLabel}`,
    `- Rows: ${total}`,
  ];
  if (total > rows.length) {
    lines.push(`- Showing latest ${rows.length} rows only`);
  }
  if (rows.length === 0) {
    lines.push("- (none)");
    return lines.join("\n");
  }
  for (const row of rows) {
    const scopeKey =
      row.scope_key && row.scope_key.length > 0 ? `/${row.scope_key}` : "";
    lines.push(
      `- ${formatSqliteTimestampForContext(row.created_at, timezoneLabel)} [${row.platform}:${row.scope}${scopeKey}] (${row.message_count} msgs) ${sanitizeMessageContent(truncateContextText(row.summary, 220))}`,
    );
  }
  return lines.join("\n");
}

/**
 * DM-HISTORY-CONTINUITY-FIX H-2 — narrow companion to `build()` for the
 * resume path. Emits only the new information the SDK session does not
 * already have: proactive forwards (including `scheduled_dm`) that
 * landed in this scope OR the cross-surface DM scope *after* the
 * resumed session was started.
 *
 * Why this is its own builder, not `build()` with a flag:
 *   - On resume, the SDK ships the cached system prompt (and the
 *     `<conversation_history>` / `<recent_other_surface>` blocks it
 *     was built with) untouched. Concatenating the full `build()`
 *     output onto the user turn re-bills every always-injected
 *     block against the user-turn payload, killing prompt-cache
 *     savings AND duplicating `<conversation_history>` content the
 *     SDK session already holds.
 *   - The catchup payload is ~few hundred tokens vs. ~10 K for the
 *     full build, on a hot path that fires whenever there's a
 *     recent proactive forward (~half of dashboard turns in
 *     practice).
 *
 * `sessionStartedAtMs` should be the session row's `started_at`
 * (not `last_message_at`) — `started_at` is fixed at session start
 * and doesn't race with concurrent inserts. Returns `null` when no
 * forwards landed after the anchor, or when the event is not a DM
 * message.
 */
export async function renderResumeCatchupContext(
  deps: ConversationDeps,
  event: Event,
  sessionStartedAtMs: number,
): Promise<string | null> {
  if (!isMessageEvent(event) || !event.isDm) return null;
  const { db } = deps;
  const { scope, scopeKey } = getConversationScope({
    platform: event.platform,
    channel: event.channel,
    threadId: event.threadId,
    isDm: true,
    intent: event.intent,
  });
  const other = resolveOtherDmScope(scope);

  const sinceUtc = formatSqliteDatetime(new Date(sessionStartedAtMs));
  const scopeFilters: Array<{ scope: string; scopeKey: string }> = [
    { scope, scopeKey },
  ];
  if (other) scopeFilters.push(other);
  const placeholders = scopeFilters
    .map(() => "(s.scope = ? AND s.scope_key = ?)")
    .join(" OR ");
  const params: unknown[] = [];
  for (const filter of scopeFilters) {
    params.push(filter.scope, filter.scopeKey);
  }
  params.push(sinceUtc);

  const rows = db
    .prepare(
      `SELECT
           m.session_id,
           m.role,
           m.content,
           m.platform,
           m.timestamp,
           m.metadata,
           s.scope,
           s.backend_session_id
         FROM messages m
         JOIN conversation_sessions s ON m.session_id = s.id
         WHERE (${placeholders})
           AND m.role = 'assistant'
           AND m.timestamp > ?
         ORDER BY m.timestamp ASC, m.id ASC
         LIMIT 30`,
    )
    .all(...params) as Array<{
      session_id: number;
      role: string;
      content: string;
      platform: string;
      timestamp: string;
      metadata: string | null;
      scope: string;
      backend_session_id: string | null;
    }>;

  const forwards = rows.filter((r) =>
    isProactiveForwardMetadata(parseMessageMetadata(r.metadata)),
  );
  if (forwards.length === 0) return null;

  const proactiveRows: Array<{
    sessionId: number;
    dispatchIds: string[];
    sessionResumed: boolean;
  }> = [];
  const lines = forwards.map((r) => {
    const metadata = parseMessageMetadata(r.metadata);
    proactiveRows.push({
      sessionId: r.session_id,
      dispatchIds: metadataDispatchIds(metadata),
      sessionResumed: r.backend_session_id !== null,
    });
    const suffix = formatForwardSuffix(metadata);
    const scopeTag = r.scope === scope ? "this surface" : "other surface";
    return `[${r.timestamp}] [assistant → ${r.platform}, ${scopeTag}]${suffix}: ${sanitizeMessageContent(r.content)}`;
  });
  if (proactiveRows.length > 0) {
    logProactiveForwardInjected(db, proactiveRows);
  }

  return [
    "<proactive_forwards_since_last_turn>",
    "Background notifications and scheduled DMs dispatched on your",
    "behalf while this session was idle. The owner has now replied —",
    "these may or may not be the referent of that reply.",
    ...lines,
    "</proactive_forwards_since_last_turn>",
  ].join("\n");
}
