import { randomUUID } from "node:crypto";
import type { BackendCostSource, BackendId } from "./backend.js";
import type { ProcessModelTier } from "./process-key.js";

// ── Priority ──
export enum EventPriority {
  CRITICAL = 0, // Urgent messages, security alerts
  HIGH = 1, // DMs, approaching deadlines, calendar conflicts
  NORMAL = 2, // File changes, routine updates
  LOW = 3, // Background sync, analysis
}

// ── Base Event ──
// Note: Node.js 15+ exposes a global `Event` class; importing this one
// must come through the package barrel or be aliased at the call site.
export interface Event {
  type: string; // e.g., "message.received", "routine.hourly_check"
  source: string; // e.g., "slack", "obsidian", "cron"
  priority: EventPriority;
  timestamp: Date;
  data: Record<string, unknown>;
  correlationId: string;
}

/** Inbound attachment reference — attached to a MessageEvent when the
 *  user uploads files alongside a message. The actual bytes live in the
 *  canonical store at `<dataDir>/attachments/<id>/<safeFilename>`.
 *
 *  P2-13 — `missing` sentinels: when an adapter knows the user attached a
 *  file but couldn't ingest it (e.g. Discord CDN URL expired after ~24h on
 *  a stale message), the adapter emits a ref with `missing: true` and a
 *  short `missingReason`. The id/mimeType/sizeBytes are placeholder
 *  fields in this case — the staging path skips missing refs entirely and
 *  the prompt builder surfaces a note so the agent can ask the user to
 *  resend the file rather than silently ignoring it. */
export interface AttachmentRef {
  id: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  caption?: string;
  /** When set, the attachment failed to ingest at adapter time. */
  missing?: true;
  /** Short machine-tag for the failure (e.g. `cdn_expired_or_blocked`). */
  missingReason?: string;
}

export interface MessageEvent extends Event {
  sender: string;
  channel: string;
  content: string;
  platform: string;
  threadId: string | null;
  isDm: boolean; // Set by adapter with platform-specific logic
  isMention: boolean; // @bot mention in channel
  /** User-attached files for this turn. Staged into the session workdir
   *  by the dispatcher at dispatch time. */
  attachments?: AttachmentRef[];
  /**
   * Legacy Claude-only tier override — one of the explicit Opus escape
   * hatches alongside `agent_schedule.model` and `/api/agent/run-now`.
   * Only the dashboard adapter populates this field from dashboard chat
   * input; other platforms (Slack/Telegram/Discord/WhatsApp) ignore any
   * such hint because there is no trusted UI channel to carry it. The
   * dispatcher honors it only on `platform === "dashboard"` events as
   * defense-in-depth.
   */
  requestedModel?: "sonnet" | "opus";
  /**
   * Explicit backend + model override — cross-backend superset of
   * `requestedModel` used by the dashboard chat picker to target any
   * registered model on any enabled backend (not just Claude sonnet/opus).
   * On the `/api/chat/messages` wire this field and `requestedModel` are
   * mutually exclusive (the SSE route rejects requests that carry both);
   * the dispatcher additionally gates the honor rule on
   * `platform === "dashboard"`.
   */
  requestedBackendId?: BackendId;
  requestedModelId?: string;
  /**
   * Distinguishes dashboard chat (default) from docs QA on the same
   * `platform="dashboard" + isDm=true` tuple. `resolveProcessKey` reads
   * this to pick between `dashboard.chat` and `dashboard.docs_qa`.
   * Only the docs-QA SSE adapter populates this field; other adapters
   * leave it undefined and the dispatcher's `intent !== "docs_qa"`
   * gates take the chat-shaped path. Defense-in-depth: ignored outside
   * the dashboard platform context.
   */
  intent?: "chat" | "docs_qa";
}

export interface CalendarChangeEvent extends Event {
  calendarId: string;
  eventTitle: string;
  startTime: Date | null;
  endTime: Date | null;
  changeType: string;
}

export interface RoutineEvent extends Event {
  routine: string; // "morning_routine" | "evening_review"
  /** Optional override injected by /api/agent/run-now so the caller can
   *  force a Sonnet or Opus run without editing process_backend_config. */
  requestedModel?: "sonnet" | "opus";
  /** Abstract tier override propagated from a synthesizing AgentTaskEvent
   *  (today_refresh) or set on /api/agent/run-now. Takes precedence over
   *  `requestedModel` in the dispatcher's routineHint computation. */
  requestedTier?: ProcessModelTier;
}

export interface AgentTaskEvent extends Event {
  task: string;
  taskContext: Record<string, unknown>;
  scheduleId?: number; // agent_schedule row ID — used to mark task completed
  requestedModel?: "sonnet" | "opus"; // from agent_schedule.model — controls which tier executes
  /**
   * Abstract tier override from `agent_schedule.tier_override` — primary
   * mechanism for the agent / dashboard / user to pin a scheduled task
   * to a specific cost tier without binding to a concrete model id.
   * Takes precedence over the legacy `requestedModel` → tier coercion;
   * BackendRouter.resolveBinding consumes it directly.
   */
  requestedTier?: ProcessModelTier;
  /**
   * Explicit backend + model pin propagated from `agent_schedule.backend_id`
   * + `agent_schedule.model` (SCHEDULE_API_REDESIGN_PLAN §4.3a). Set together
   * by the scheduler when the operator pinned a registered full model id
   * (e.g. `claude-opus-4-7`). The dispatcher's scheduled-task override block
   * (`dispatcher-scheduled-tasks.ts`) guards on BOTH fields together — emitting
   * only one silently drops the pin. Daemon-owned integration cron events
   * (trigger-dispatch, repository_run) also produce this pair via the same
   * contract.
   */
  requestedBackendId?: BackendId;
  requestedModelId?: string;
}

// ── Factory ──
export function createEvent(
  params: Pick<Event, "type" | "source" | "priority"> & Partial<Event>,
): Event {
  return {
    timestamp: new Date(),
    data: {},
    correlationId: randomUUID(),
    ...params,
  };
}

// ── Type Guards (match on type field prefix — won't false-positive on data keys) ──
export function isMessageEvent(e: Event): e is MessageEvent {
  return e.type.startsWith("message.");
}

export function isDocsQAMessage(
  e: Event,
): e is MessageEvent & { intent: "docs_qa" } {
  return (
    isMessageEvent(e)
    && e.platform === "dashboard"
    && e.isDm
    && e.intent === "docs_qa"
  );
}

export function isCalendarChangeEvent(e: Event): e is CalendarChangeEvent {
  return e.type.startsWith("calendar.") || e.type === "schedule.approaching";
}

export function isRoutineEvent(e: Event): e is RoutineEvent {
  return e.type.startsWith("routine.");
}

export function isAgentTaskEvent(e: Event): e is AgentTaskEvent {
  return e.type === "scheduled.task";
}

/**
 * Knowledge import event — emitted by `POST /api/knowledge/import` when
 * the owner uploads a Markdown / text file from the dashboard Knowledge
 * page. A one-shot heavy session reads the scratch copy at
 * `data.scratchPath` and routes its facts into `user/*.md`.
 *
 * `requestedBackendId` / `requestedModelId` carry the user's pick from
 * the upload form's backend / model dropdown. The dispatcher honors them
 * only when `platform === "dashboard"` — same defense-in-depth gate the
 * dashboard chat override uses.
 */
export interface KnowledgeImportEvent extends Event {
  type: "knowledge.import";
  /** Always "dashboard" — set by the route. The dispatcher gates the
   *  backend/model override on this exact value so a mis-emitted event
   *  cannot smuggle a backend pick from another adapter. */
  platform: string;
  /** Context-relative path of the scratch copy (under `agent/scratch/`). */
  scratchPath: string;
  /** Original uploaded filename, for logs and the closing journal entry. */
  filename: string;
  /**
   * Origin label the user picked in the form. Named `importSource`
   * (not `source`) so it never collides with the base `Event.source`
   * field (the originating-adapter label, e.g. `"dashboard_knowledge_upload"`),
   * and with the matching `event_data[source]` key that
   * `extractEventData` writes from `Event.source`.
   */
  importSource: "obsidian-export" | "notion-export" | "self-written" | "other";
  /** ISO date string (YYYY-MM-DD) — captured at upload time, not at
   *  dispatch time, so the journal entry matches the upload date even if
   *  dispatch is delayed. */
  uploadDate: string;
  /** Cross-backend model override populated from the dashboard form. */
  requestedBackendId?: BackendId;
  requestedModelId?: string;
}

export function isKnowledgeImportEvent(e: Event): e is KnowledgeImportEvent {
  return e.type === "knowledge.import";
}

/**
 * Scheduled DM-tone session event. Same shape as AgentTaskEvent — the
 * type field is the routing axis. Used for any task that should run
 * under the conversational profile and deliver as a DM (morning
 * briefing today; evening summary, meeting nudges, etc. in future).
 */
export type ScheduledDmEvent = AgentTaskEvent;

export function isScheduledDmEvent(e: Event): e is ScheduledDmEvent {
  return e.type === "scheduled.dm";
}

/**
 * Umbrella guard for any scheduler-fired event (currently
 * `scheduled.task` or `scheduled.dm`). Replaces `isAgentTaskEvent` at
 * call sites where both subtypes should be treated uniformly — e.g.
 * marking the parent `agent_schedule` row completed/failed, gating
 * final-text DM delivery, or injecting calendar/origin context.
 */
export function isScheduledEvent(e: Event): e is AgentTaskEvent {
  return e.type.startsWith("scheduled.");
}

// ── Agent Result ──
export interface AgentResult {
  output: string;
  sessionId: string | null;
  backendId?: BackendId;
  modelId?: string;
  costSource?: BackendCostSource;
  costUsd: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  };
  modelUsage: Record<
    string,
    { inputTokens: number; outputTokens: number; costUsd: number }
  >;
  numTurns: number;
  durationMs: number;
  durationApiMs: number;
  model: string;
  isError: boolean;
  stopReason: string | null;
  /**
   * True if the agent made at least one PUT/PATCH tool call targeting
   * the /api/context/* endpoints — i.e., actually modified a context
   * markdown file during this execution. Detected by scanning tool_use
   * blocks in the assistant message stream.
   */
  contextUpdated: boolean;
  /**
   * Number of server-side advisor tool invocations during this execution.
   * Incremented each time the SDK emits a `server_tool_use` block with
   * `name: "advisor"` (the `advisor_20260301` Anthropic-hosted tool).
   *
   * Stays at 0 when advisor is disabled, when the experimental feature flag
   * (`tengu_sage_compass2`) is off for the account, when the base model is
   * not advisor-eligible (i.e. not Sonnet/Opus 4.6), or when the model
   * simply chose not to call it.
   *
   * Only the Claude Code backend populates this field today. Optional so
   * non-Anthropic backends and older result producers don't need to set it
   * — consumers treat `undefined` as 0. Used for `metrics.advisorCallRate`.
   */
  advisorCallCount?: number;
}
