import type Database from "better-sqlite3";
import {
  getAgentDayBoundsUtc,
  localDateStr,
  parseSqliteUtcMs,
} from "@aitne/shared";
import type { AgentConfig } from "../config.js";
import {
  formatSqliteTimestampForContext,
  truncateContextText,
} from "./context-builder-format.js";
import { sanitizeUntrustedTemplateValue } from "./backends/prompt-utils.js";

const YESTERDAY_AGENT_ACTION_LIMIT = 40;
const YESTERDAY_MESSAGE_LIMIT = 60;
const YESTERDAY_DM_LOG_LIMIT = 20;

interface YesterdayAgentActionRow {
  action_type: string;
  trigger: string | null;
  result: string | null;
  started_at: string;
  completed_at: string | null;
  error: string | null;
}

interface YesterdayMessageRow {
  role: string;
  content: string;
  platform: string;
  timestamp: string;
}

interface YesterdayDmConversationLogRow {
  platform: string;
  scope: string;
  scope_key: string;
  summary: string;
  message_count: number;
  created_at: string;
}

interface YesterdayDeps {
  db: Database.Database;
  config: AgentConfig;
}

export async function buildYesterdayContext(deps: YesterdayDeps): Promise<{
  agentActions: string;
  messages: string;
  dmConversationLog: string;
}> {
  const { db, config } = deps;
  const tz = config.timezone || undefined;
  const dayBoundaryHour = config.dayBoundaryHour ?? 4;
  const previousAgentDayRef = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const bounds = getAgentDayBoundsUtc(tz, dayBoundaryHour, previousAgentDayRef);
  const dayLabel = localDateStr(
    new Date(parseSqliteUtcMs(bounds.start)),
    tz,
  );
  const timezoneLabel = config.timezone || "system";

  const agentActionTotal = (
    db
      .prepare(
        `SELECT COUNT(*) as cnt FROM agent_actions
         WHERE started_at >= ? AND started_at < ?`,
      )
      .get(bounds.start, bounds.end) as { cnt: number }
  ).cnt;
  const agentActionRows = (
    db
      .prepare(
        `SELECT action_type, trigger, result, started_at, completed_at, error
         FROM agent_actions
         WHERE started_at >= ? AND started_at < ?
         ORDER BY started_at DESC
         LIMIT ?`,
      )
      .all(
        bounds.start,
        bounds.end,
        YESTERDAY_AGENT_ACTION_LIMIT,
      ) as YesterdayAgentActionRow[]
  ).reverse();

  const messageTotal = (
    db
      .prepare(
        `SELECT COUNT(*) as cnt FROM messages
         WHERE timestamp >= ? AND timestamp < ?
           AND role != 'system'`,
      )
      .get(bounds.start, bounds.end) as { cnt: number }
  ).cnt;
  const messageRows = (
    db
      .prepare(
        `SELECT role, content, platform, timestamp
         FROM messages
         WHERE timestamp >= ? AND timestamp < ?
           AND role != 'system'
         ORDER BY timestamp DESC
         LIMIT ?`,
      )
      .all(
        bounds.start,
        bounds.end,
        YESTERDAY_MESSAGE_LIMIT,
      ) as YesterdayMessageRow[]
  ).reverse();

  const dmLogTotal = (
    db
      .prepare(
        `SELECT COUNT(*) as cnt FROM dm_conversation_log
         WHERE created_at >= ? AND created_at < ?`,
      )
      .get(bounds.start, bounds.end) as { cnt: number }
  ).cnt;
  const dmLogRows = (
    db
      .prepare(
        `SELECT platform, scope, scope_key, summary, message_count, created_at
         FROM dm_conversation_log
         WHERE created_at >= ? AND created_at < ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(
        bounds.start,
        bounds.end,
        YESTERDAY_DM_LOG_LIMIT,
      ) as YesterdayDmConversationLogRow[]
  ).reverse();

  return {
    agentActions: formatYesterdayAgentActions(
      dayLabel,
      timezoneLabel,
      agentActionRows,
      agentActionTotal,
    ),
    messages: formatYesterdayMessages(
      dayLabel,
      timezoneLabel,
      messageRows,
      messageTotal,
    ),
    dmConversationLog: formatYesterdayDmConversationLog(
      dayLabel,
      timezoneLabel,
      dmLogRows,
      dmLogTotal,
    ),
  };
}

/**
 * Current-agent-day variant of `buildYesterdayContext` for the
 * user-profile sweep (§Phase 2). Resolves the day bounds to the
 * CURRENT agent-day — at 03:50 that window is ~04:00 yesterday →
 * 03:50 today (the agent-day about to close), and at 17:50 it is
 * ~04:00 today → 17:50 today. The sweep reads DM traffic + rolling
 * summaries but not agent_actions (not needed for fact extraction).
 */
export function buildAgentDayDmContext(deps: YesterdayDeps): {
  messages: string;
  dmConversationLog: string;
} {
  const { db, config } = deps;
  const tz = config.timezone || undefined;
  const dayBoundaryHour = config.dayBoundaryHour ?? 4;
  const bounds = getAgentDayBoundsUtc(tz, dayBoundaryHour);
  const dayLabel = localDateStr(
    new Date(parseSqliteUtcMs(bounds.start)),
    tz,
  );
  const timezoneLabel = config.timezone || "system";

  const messageTotal = (
    db
      .prepare(
        `SELECT COUNT(*) as cnt FROM messages
         WHERE timestamp >= ? AND timestamp < ?
           AND role != 'system'`,
      )
      .get(bounds.start, bounds.end) as { cnt: number }
  ).cnt;
  const messageRows = (
    db
      .prepare(
        `SELECT role, content, platform, timestamp
         FROM messages
         WHERE timestamp >= ? AND timestamp < ?
           AND role != 'system'
         ORDER BY timestamp DESC
         LIMIT ?`,
      )
      .all(
        bounds.start,
        bounds.end,
        YESTERDAY_MESSAGE_LIMIT,
      ) as YesterdayMessageRow[]
  ).reverse();

  const dmLogTotal = (
    db
      .prepare(
        `SELECT COUNT(*) as cnt FROM dm_conversation_log
         WHERE created_at >= ? AND created_at < ?`,
      )
      .get(bounds.start, bounds.end) as { cnt: number }
  ).cnt;
  const dmLogRows = (
    db
      .prepare(
        `SELECT platform, scope, scope_key, summary, message_count, created_at
         FROM dm_conversation_log
         WHERE created_at >= ? AND created_at < ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(
        bounds.start,
        bounds.end,
        YESTERDAY_DM_LOG_LIMIT,
      ) as YesterdayDmConversationLogRow[]
  ).reverse();

  return {
    messages: formatYesterdayMessages(
      dayLabel,
      timezoneLabel,
      messageRows,
      messageTotal,
    ),
    dmConversationLog: formatYesterdayDmConversationLog(
      dayLabel,
      timezoneLabel,
      dmLogRows,
      dmLogTotal,
    ),
  };
}

/**
 * Truncate the ## Agent Log section of today.md to the last `maxEntries`
 * bullet lines. Operates on the string content only (does not touch disk).
 * Inserts an omission marker pointing to GET /api/context/today.
 */
export function truncateAgentLog(content: string, maxEntries: number): string {
  // Match "\n## Agent Log\n" to avoid false positives inside code blocks or
  // quoted text. The leading \n ensures we match a heading at line start, not
  // a substring of prose. today.md's structure is daemon-controlled, but this
  // is defence-in-depth against accidental matches in Handoff/Notes.
  const needle = "\n## Agent Log\n";
  const needleIdx = content.indexOf(needle);
  if (needleIdx < 0) return content;
  const headerIdx = needleIdx + 1; // skip the leading \n to point at "##"
  const sectionHeader = "## Agent Log";

  // Find the end of the Agent Log section (next ## heading or EOF)
  const afterHeader = headerIdx + sectionHeader.length;
  const nextSectionIdx = content.indexOf("\n## ", afterHeader);
  const sectionEnd = nextSectionIdx >= 0 ? nextSectionIdx : content.length;

  const sectionBody = content.slice(afterHeader, sectionEnd);
  const lines = sectionBody.split("\n");

  // Extract bullet lines (start with "- ")
  const bulletLines = lines.filter((l) => l.trimStart().startsWith("- "));
  if (bulletLines.length <= maxEntries) return content;

  // Keep only the last maxEntries bullets
  const omitted = bulletLines.length - maxEntries;
  const kept = bulletLines.slice(-maxEntries);
  const truncatedBody = [
    "",
    `[...${omitted} earlier entries omitted — use GET /api/context/today for full content]`,
    ...kept,
    "",
  ].join("\n");

  return (
    content.slice(0, headerIdx) +
    sectionHeader +
    truncatedBody +
    content.slice(sectionEnd)
  );
}

function formatYesterdayAgentActions(
  dayLabel: string,
  timezoneLabel: string,
  rows: YesterdayAgentActionRow[],
  total: number,
): string {
  const lines = [
    `- Agent day: ${dayLabel}`,
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
    const trigger = row.trigger ? ` (${row.trigger})` : "";
    const result = row.result ?? "unknown";
    const error = row.error
      ? ` — error: ${sanitizeUntrustedTemplateValue(truncateContextText(row.error, 140))}`
      : "";
    lines.push(
      `- ${formatSqliteTimestampForContext(row.started_at, timezoneLabel)} [${result}] ${row.action_type}${trigger}${error}`,
    );
  }
  return lines.join("\n");
}

function formatYesterdayMessages(
  dayLabel: string,
  timezoneLabel: string,
  rows: YesterdayMessageRow[],
  total: number,
): string {
  const lines = [
    `- Agent day: ${dayLabel}`,
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
    lines.push(
      `- ${formatSqliteTimestampForContext(row.timestamp, timezoneLabel)} [${row.platform}/${row.role}] ${sanitizeUntrustedTemplateValue(truncateContextText(row.content, 180))}`,
    );
  }
  return lines.join("\n");
}

function formatYesterdayDmConversationLog(
  dayLabel: string,
  timezoneLabel: string,
  rows: YesterdayDmConversationLogRow[],
  total: number,
): string {
  const lines = [
    `- Agent day: ${dayLabel}`,
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
      `- ${formatSqliteTimestampForContext(row.created_at, timezoneLabel)} [${row.platform}:${row.scope}${scopeKey}] (${row.message_count} msgs) ${sanitizeUntrustedTemplateValue(truncateContextText(row.summary, 220))}`,
    );
  }
  return lines.join("\n");
}
