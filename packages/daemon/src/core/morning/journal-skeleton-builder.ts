/**
 * `buildJournalSkeleton` + `gatherJournalSkeletonFacts` — assemble the
 * `<journal_skeleton>` MD body that the morning-routine orchestrator (③)
 * injects into Stage B's prompt. Carries deterministic frontmatter
 * fields + pre-aggregated facts pulled from SQLite + yesterday.md.
 *
 * Body sections are **scratch data** — Stage B authors the final body
 * per `rules/journal-format.md` (user-diary framing: Title / Summary /
 * Schedule / Tasks / Conversations). Stage B treats `## Schedule` /
 * `## Tasks` / `## Conversations` here as input data, not output
 * structure. The skeleton deliberately does NOT emit a `## Summary`
 * placeholder — that would mislead Stage B into thinking Summary is
 * its sole writing duty, when in fact the entire template body is its
 * responsibility.
 *
 * The skeleton no longer emits a `## Actions` scratch section because
 * the agent-action breakdown is an agent-side footprint, not a
 * user-diary fact. `agent-journal-appender` renders it into
 * `agent/journal.md` instead. The `JournalSkeletonFacts`
 * `totalActions` + `actionsByType` fields remain in the contract so
 * downstream code (the appender) can consume the same aggregation
 * without re-querying.
 *
 * Spec: `docs/design/appendices/morning-routine-optimization.md`
 * §"Daemon-side modules to add" → journal-skeleton-builder. Stage B's
 * task-flow contract is to preserve the skeleton-owned frontmatter
 * byte-for-byte; the `/api/context/daily/<date>` chokepoint enforces
 * presence + well-typedness (date matches the path stem, weekday is
 * a long-form English day, agent_generated is `true`, the two counts
 * are non-negative integers) and rejects drift with
 * `context.daily_skeleton_field_drift`. The validator does NOT
 * byte-for-byte verify field VALUES against the skeleton because the
 * skeleton lives in-memory inside the orchestrator run and is not
 * persisted; the narrower contract catches the realistic Stage-B
 * failure mode (silently dropping a field) without coupling the
 * validator to inter-process skeleton state. Body content is Stage
 * B's; no body validation against the skeleton.
 *
 * Two-layer design:
 *   - `gatherJournalSkeletonFacts(db, ...)` — runs SQLite aggregations
 *     against `agent_actions`, `messages`, and `dm_conversation_log`
 *     for the agent-day window. Stable, idempotent, side-effect free.
 *   - `buildJournalSkeleton(inputs, facts)` — pure markdown composer.
 *
 * The split keeps the I/O-bound queries testable independently and
 * lets the pure builder be exercised with synthesized fixtures.
 *
 * Phase 2 ships this module unwired; the orchestrator wires it after
 * the pre-pass (④) completes and before Stage B fires.
 */

import type Database from "better-sqlite3";

/** Calendar event filtered to yesterday for the `## Schedule` section. */
export interface SkeletonCalendarEvent {
  /** `HH:MM` local start time, or null for all-day. */
  time: string | null;
  /** Event title. May be empty (rendered as `(untitled)`). */
  title: string;
}

/** Inputs the daemon assembles before invoking the builder. */
export interface JournalSkeletonInputs {
  /** Yesterday's agent-day date in `YYYY-MM-DD`. */
  dateStr: string;
  /** Weekday name (e.g. `Wednesday`). */
  weekday: string;
  /**
   * Today's agent-day date in `YYYY-MM-DD` — the morning routine's run
   * date. Lands in the skeleton-owned `updated:` frontmatter field. The
   * `daily/*.md` chokepoint validator requires `updated` to be present
   * and a valid ISO date (`context-frontmatter.ts:validateContextFileFrontmatter`),
   * so promoting it from the original "Stage-B-owned placeholder" design
   * to a daemon-emitted skeleton-owned value eliminates the failure mode
   * where Stage B forgets to fill `updated:` and every PUT 422s. Semantic
   * is unchanged: "this journal row was written by this morning's run".
   */
  updatedDateStr: string;
  /**
   * Full `yesterday.md` body, or null when the file is absent (initial
   * variant — Stage B does not run in that flow but the skeleton is
   * still computed so the orchestrator can decide that uniformly).
   */
  yesterdayMd: string | null;
  /** Calendar events filtered to yesterday's date. */
  calendarEvents: ReadonlyArray<SkeletonCalendarEvent>;
  /**
   * IANA timezone (e.g. `Asia/Tokyo`) used to render the DM section's
   * HH:MM bullets in the user's local time. When absent, the renderer
   * falls back to slicing the SQLite UTC `HH:MM` verbatim — fine for
   * UTC-resident operators, but for a Tokyo user a 02:30 UTC DM would
   * leak as `02:30` instead of `11:30`. Stage B preserves the
   * skeleton's body sections, so this string surfaces verbatim in the
   * user-facing daily journal — picking the wrong TZ here is a real
   * journal bug, not just a context-only smell.
   */
  timezone?: string;
}

/** Facts derived from SQLite for the agent-day window. */
export interface JournalSkeletonFacts {
  /**
   * Total `agent_actions` rows in the window. Consumed by
   * `agent-journal-appender` for the `agent/journal.md` footprint
   * line — NOT rendered into the user-facing `daily/<date>.md`
   * skeleton body (the user-diary refocus dropped `## Actions`).
   */
  totalActions: number;
  /**
   * `agent_actions` rows grouped by `action_type`, ordered by count
   * descending then action_type ascending. Stable so test assertions
   * are deterministic. Consumed by `agent-journal-appender` for the
   * `agent/journal.md` footprint line.
   */
  actionsByType: ReadonlyArray<{ actionType: string; count: number }>;
  /**
   * Incoming user messages attributed to yesterday. Counts only
   * `role='user'` rows in the agent-day window — agent replies
   * (`role='assistant'`) and internal prompts (`role='system'`) are
   * deliberately excluded. The value lands in the daily-journal
   * frontmatter as `messages_handled: <count>` and is meant to match
   * the user's mental model of "how many messages did I send today"
   * (rev2 semantic). The earlier rev1 implementation counted user +
   * assistant turns, which inflated the value ~2× and read as
   * unfamiliar bookkeeping in the user-facing journal.
   *
   * The TS property keeps the name `messagesHandled` so the
   * frontmatter field stays `messages_handled` byte-for-byte — a
   * rename is breaking for any daily journal already written, so it's
   * intentionally deferred.
   */
  messagesHandled: number;
  /** Rolling DM summary rows for the window, oldest first. */
  dmSummaries: ReadonlyArray<{
    summary: string;
    messageCount: number;
    createdAt: string;
  }>;
}

/** Window expressed in UTC ISO datetime strings used by SQLite `datetime()`. */
export interface AgentDayWindowUtc {
  startUtc: string;
  endUtc: string;
}

/**
 * Run the SQLite aggregations for the agent-day window. Pure read-only;
 * the caller owns timezone / `dayBoundaryHour` math and passes the UTC
 * window inclusively as `[startUtc, endUtc)`.
 */
export function gatherJournalSkeletonFacts(
  db: Database.Database,
  window: AgentDayWindowUtc,
): JournalSkeletonFacts {
  const totalActionsRow = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM agent_actions
        WHERE started_at >= ? AND started_at < ?`,
    )
    .get(window.startUtc, window.endUtc) as { n: number };

  const groupedRows = db
    .prepare(
      `SELECT action_type AS actionType, COUNT(*) AS count
         FROM agent_actions
        WHERE started_at >= ? AND started_at < ?
        GROUP BY action_type
        ORDER BY COUNT(*) DESC, action_type ASC`,
    )
    .all(window.startUtc, window.endUtc) as Array<{
    actionType: string;
    count: number;
  }>;

  // `messages_handled` semantic (rev2 — 2026-05-15): count incoming
  // user messages only. See JournalSkeletonFacts.messagesHandled JSDoc
  // for why this differs from the rev1 user+assistant total.
  const messagesRow = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM messages
        WHERE role = 'user'
          AND timestamp >= ? AND timestamp < ?`,
    )
    .get(window.startUtc, window.endUtc) as { n: number };

  const dmRows = db
    .prepare(
      `SELECT summary, message_count AS messageCount, created_at AS createdAt
         FROM dm_conversation_log
        WHERE created_at >= ? AND created_at < ?
        ORDER BY created_at ASC, id ASC`,
    )
    .all(window.startUtc, window.endUtc) as Array<{
    summary: string;
    messageCount: number;
    createdAt: string;
  }>;

  return {
    totalActions: totalActionsRow.n,
    actionsByType: groupedRows,
    messagesHandled: messagesRow.n,
    dmSummaries: dmRows,
  };
}

/**
 * Compose the `<journal_skeleton>` MD body. Pure — every output byte is
 * a deterministic function of `inputs` + `facts`. Stage B receives this
 * string verbatim and must preserve the frontmatter fields listed in
 * the design spec.
 */
export function buildJournalSkeleton(
  inputs: JournalSkeletonInputs,
  facts: JournalSkeletonFacts,
): string {
  const calendarCount = inputs.calendarEvents.length;
  const messagesHandled = facts.messagesHandled;

  const lines: string[] = [];
  lines.push("---");
  lines.push(`date: ${inputs.dateStr}`);
  lines.push(`weekday: ${inputs.weekday}`);
  lines.push("type: daily");
  lines.push("owner: agent");
  lines.push("agent_generated: true");
  lines.push(`calendar_events: ${calendarCount}`);
  lines.push(`messages_handled: ${messagesHandled}`);
  // `updated` was originally specified as Stage-B-owned in the design,
  // but the generic context-frontmatter validator requires it on every
  // `daily/*.md` PUT — leaving it as an empty placeholder produces a
  // hard 422 every morning. Daemon-emitting today's date is semantically
  // equivalent (the journal row WAS last touched by this morning's run)
  // and removes the failure mode entirely. The skeleton's "Stage B
  // preserves byte-for-byte" contract covers it the same way it covers
  // `date` / `weekday` / etc.
  lines.push(`updated: ${inputs.updatedDateStr}`);
  // Stage-B-owned frontmatter slots. Declared but unvalued so Stage B
  // can fill them; the daemon's PUT validator only enforces the
  // skeleton-owned fields above.
  lines.push("agent_last_synced_at:");
  lines.push("content_hash:");
  lines.push("projects: []");
  lines.push("people: []");
  lines.push("tags: []");
  lines.push("---");
  lines.push("");
  lines.push(`# ${inputs.dateStr} (${inputs.weekday})`);
  lines.push("");
  // Scratch-body marker. Stage B reads the sections below as raw data
  // (calendar events, yesterday's tasks, DM rolling summaries) and
  // authors the final user-diary body per `rules/journal-format.md` —
  // Title / Summary (user first-person) / Schedule / Tasks /
  // Conversations. The skeleton sections are NOT preserved verbatim;
  // Stage B replaces them wholesale. Only the frontmatter (above) is
  // byte-for-byte enforced by the daily-write chokepoint. Agent
  // action counts are NOT included as a scratch section — they are
  // an agent-side footprint and land in `agent/journal.md` via
  // `agent-journal-appender`, not in the user-facing daily journal.
  lines.push("<!-- Stage B: author the body per rules/journal-format.md.");
  lines.push("     The sections below are scratch data from the daemon —");
  lines.push("     use them as input, not as final output. Replace the");
  lines.push("     entire body wholesale. Only the frontmatter (above)");
  lines.push("     is byte-for-byte preserved. -->");
  lines.push("");
  appendScheduleSection(lines, inputs.calendarEvents);
  appendTasksSection(lines, inputs.yesterdayMd);
  appendConversationsSection(lines, facts.dmSummaries, inputs.timezone);
  return lines.join("\n");
}

function appendScheduleSection(
  out: string[],
  events: ReadonlyArray<SkeletonCalendarEvent>,
): void {
  out.push("## Schedule");
  if (events.length === 0) {
    out.push("- (none)");
  } else {
    for (const event of events) {
      const title = event.title.trim().length === 0 ? "(untitled)" : event.title.trim();
      if (event.time === null || event.time.length === 0) {
        out.push(`- ${title}`);
      } else {
        out.push(`- ${event.time} — ${title}`);
      }
    }
  }
  out.push("");
}

function appendTasksSection(out: string[], yesterdayMd: string | null): void {
  out.push("## Tasks");
  const tasks = extractUserTasksFromYesterday(yesterdayMd);
  if (tasks.length === 0) {
    out.push("- (none)");
  } else {
    for (const task of tasks) {
      out.push(`- ${task}`);
    }
  }
  out.push("");
}

function appendConversationsSection(
  out: string[],
  summaries: ReadonlyArray<{ summary: string; messageCount: number; createdAt: string }>,
  timezone: string | undefined,
): void {
  // The user-diary refocus renamed this section from `## DM` to
  // `## Conversations` to frame it as "what the user talked about
  // today" rather than a mechanical DM log. Each scratch bullet still
  // carries the HH:MM + rolling-summary row + message count so Stage B
  // can synthesize topic-level bullets (per
  // `rules/journal-format.md`); the bullet shape itself is unchanged
  // so DM rolling-summary writers don't need a parallel rename.
  out.push("## Conversations");
  if (summaries.length === 0) {
    out.push("- (none)");
  } else {
    for (const row of summaries) {
      const hm = extractHmFromTimestamp(row.createdAt, timezone);
      const summaryClean = row.summary.replace(/\s+/g, " ").trim();
      out.push(`- ${hm}: ${summaryClean} (n=${row.messageCount})`);
    }
  }
  out.push("");
}

/**
 * Pull plain-text bullets from `yesterday.md`'s `## User Tasks` section.
 * Returns an empty array when the file is null or the section is
 * absent/empty. Tolerates checkbox bullets (`- [ ]`, `- [x]`) — the
 * checkbox marker is stripped so the skeleton renders a clean
 * non-checkbox list for Stage B to summarize.
 *
 * CRLF-tolerant: splits on `\r?\n` (parallel with handoff-parser) so
 * Windows-authored / mixed-line-ending operator edits don't silently
 * drop the User Tasks section when the strict `=== "## User Tasks"`
 * match would otherwise fail against `"## User Tasks\r"`.
 */
function extractUserTasksFromYesterday(yesterdayMd: string | null): string[] {
  if (yesterdayMd === null || yesterdayMd.length === 0) return [];
  const lines = yesterdayMd.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line === "## User Tasks");
  if (headerIndex < 0) return [];
  const out: string[] = [];
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("## ")) break;
    const match = /^- (?:\[[ xX]\] )?(.*)$/.exec(line);
    if (!match) continue;
    const item = match[1].trim();
    if (item.length === 0) continue;
    if (/^\(?none\)?$/i.test(item)) continue;
    out.push(item);
  }
  return out;
}

/**
 * Render `HH:MM` from a SQLite `datetime()`-shaped string. The DB stores
 * UTC timestamps as `YYYY-MM-DD HH:MM:SS`.
 *
 * When `timezone` is provided (the standard call path from the
 * orchestrator, which threads `settings.timezone`), the value is parsed
 * as UTC and re-rendered in the user's local time via
 * `Intl.DateTimeFormat` with `hourCycle: "h23"` — covering both the
 * SQLite shape (`YYYY-MM-DD HH:MM:SS`) and the ISO-8601 variant a future
 * migration might land (`YYYY-MM-DDTHH:MM:SS.sssZ`).
 *
 * When `timezone` is absent (Phase 2 unwired tests, fallback path on
 * a bad TZ name, or operators who explicitly clear the setting), we
 * fall back to slicing the first `HH:MM` from the raw string. This is
 * UTC for the SQLite shape; acceptable when the caller has opted out
 * of TZ-awareness.
 *
 * Returns `"??:??"` if neither path can extract an HH:MM (malformed
 * input, unparseable date), so the bullet stays renderable.
 */
function extractHmFromTimestamp(timestamp: string, timezone: string | undefined): string {
  if (typeof timezone === "string" && timezone.length > 0) {
    const localized = renderHmInTimezone(timestamp, timezone);
    if (localized !== null) return localized;
  }
  const match = /(\d{2}):(\d{2})/.exec(timestamp);
  if (!match) return "??:??";
  return `${match[1]}:${match[2]}`;
}

function renderHmInTimezone(timestamp: string, timezone: string): string | null {
  // SQLite's `YYYY-MM-DD HH:MM:SS` is UTC but missing the `T`/`Z`
  // markers `Date.parse` needs to treat as UTC. Promote to ISO before
  // parsing; ISO inputs pass through unchanged.
  //
  // The shape predicate accepts the optional `.SSS` fraction SQLite's
  // `datetime('now', 'subsec')` mode emits — without it a subsec
  // timestamp would fall to the else branch and `Date.parse` on the
  // space-separated form (no `T`/`Z`) is ECMAScript-implementation-
  // defined (may parse as local rather than UTC). Widening here keeps
  // the daemon-produced shape robust across SQLite migration choices.
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(timestamp)
    ? `${timestamp.replace(" ", "T")}Z`
    : timestamp;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  try {
    const fmt = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: timezone,
    });
    return fmt.format(new Date(ms));
  } catch {
    // Bad TZ name (`Intl.DateTimeFormat` throws `RangeError`). Caller
    // falls back to the UTC slice path, which is still better than
    // throwing past the pure-builder boundary.
    return null;
  }
}
