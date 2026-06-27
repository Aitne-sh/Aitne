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
  type: string; // e.g., "message.received", "routine.activity_scan"
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
   * (e.g. `claude-opus-4-8`). The dispatcher's scheduled-task override block
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
  /** Context-relative path of the scratch copy (under `state/scratch/`). */
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
 * BROWSER_TASK_REDESIGN_PLAN.md §6.2 + §7 — `scheduled.browser_task` is
 * emitted from the ScheduleWatcher when an `agent_schedule` row with
 * `task_type='browser_task'` becomes due. The `taskContext` carries the
 * original `POST /api/browser-task` body (frozen at schedule time),
 * augmented with a `preGeneratedTaskId` so the user-facing taskId
 * returned at schedule-time matches the row id created at fire-time.
 *
 * This event does NOT flow through the normal scheduled.task / agent
 * SDK dispatch — the dispatcher routes it to a dedicated handler that
 * (a) re-validates the site registry, (b) creates the `browser_task`
 * row, and (c) hands off to `BrowserTaskRunner.runFromScheduleRow`. The
 * runner's RunResult is what determines the `browser_task` lifecycle;
 * the `agent_schedule` row only tracks dispatch success.
 *
 * `isScheduledEvent` returns `true` for this event so the shared
 * `agent_schedule.status` lifecycle (mark `completed` / `failed` /
 * cleanup on error) still applies. `isAgentTaskEvent` and
 * `isScheduledDmEvent` both return `false` so the AgentTaskEvent SDK
 * paths (`executeScheduledTask`, `finalizeRetemplateRunIfApplicable`,
 * etc.) do not pick it up.
 */
export interface ScheduledBrowserTaskEvent extends Event {
  type: "scheduled.browser_task";
  /** Persisted original POST body — shape mirrors the route's
   *  `postBodySchema`. Validated at fire time before row creation. */
  taskContext: {
    /** UUID v4 minted at schedule-time so the schedule POST's response
     *  can hand the user a stable taskId before the row exists. */
    preGeneratedTaskId: string;
    description: string;
    siteKey: string | null;
    extraAllowedHosts?: string[];
    originatingChannel?: string | null;
    /** What the user picked at schedule time — re-applied to the new
     *  row at fire time. The runner consults registry state at fire
     *  time for the final-confirm trip semantics; this field only
     *  governs whether the gate is armed. */
    requireFinalConfirm?: boolean;
  };
  /** `agent_schedule.id` of the row that fired this event. Used by
   *  the dispatcher handler to mark the schedule row completed /
   *  failed once the runner accepts (or rejects) the dispatch. */
  scheduleId: number;
}

export function isScheduledBrowserTaskEvent(
  e: Event,
): e is ScheduledBrowserTaskEvent {
  return e.type === "scheduled.browser_task";
}

/**
 * BACKGROUND_TASK_RUNNER_DESIGN.md §4.2 — `scheduled.background_task` is
 * emitted from the ScheduleWatcher when an `agent_schedule` row with
 * `task_type='background_task'` becomes due. The `taskContext` carries
 * the original `POST /api/background-task` body (frozen at schedule
 * time), augmented with a `preGeneratedTaskId` so the user-facing taskId
 * returned at schedule time matches the row id created at fire time.
 *
 * Mirrors `ScheduledBrowserTaskEvent`: the dispatcher routes it to a
 * dedicated handler (`dispatcher-scheduled-background-task.ts`) that
 * creates the `background_task` row at fire time and hands off to the
 * runner — it does NOT flow through the AgentTaskEvent SDK paths.
 * `isScheduledEvent` returns `true` (so the shared `agent_schedule`
 * lifecycle applies); `isAgentTaskEvent` / `isScheduledDmEvent` /
 * `isScheduledBrowserTaskEvent` all return `false`.
 */
export interface ScheduledBackgroundTaskEvent extends Event {
  type: "scheduled.background_task";
  taskContext: {
    /** UUID v4 minted at schedule time. */
    preGeneratedTaskId: string;
    brief: string;
    title?: string | null;
    notificationPolicy?: "always" | "if_significant" | "silent";
    tier?: "lite" | "medium" | "high" | null;
    maxBudgetUsd?: number | null;
    originatingChannel?: string | null;
  };
  /** `agent_schedule.id` of the row that fired this event. */
  scheduleId: number;
}

export function isScheduledBackgroundTaskEvent(
  e: Event,
): e is ScheduledBackgroundTaskEvent {
  return e.type === "scheduled.background_task";
}

/**
 * A user-deliverable file a task produced (a browser-task trace
 * screenshot, or a worker-written PDF / PPTX / PNG / document). The
 * delivery handler resolves it to an outbound attachment and sends it
 * with the result/clarification DM; the DM agent additionally sees the
 * filename/kind/label so it can reference assets naturally and re-offer
 * them later. Exactly one of `screenshotKey` / `path` identifies the
 * bytes — `screenshotKey` for browser-task trace screenshots (resolved
 * via the trace store), `path` for an absolute worker-output file.
 *
 * BACKGROUND_TASK_RUNNER_DESIGN.md Phase 1 (delivery assets).
 */
export interface TaskDeliveryAsset {
  /** Display name + outbound attachment filename (e.g. `report.pdf`). */
  filename: string;
  /** Coarse category — drives the agent's phrasing and the manifest. */
  kind:
    | "screenshot"
    | "image"
    | "pdf"
    | "slides"
    | "document"
    | "spreadsheet"
    | "other";
  /** Browser-task trace screenshot key (`<taskId>/<file>`). */
  screenshotKey?: string;
  /** Absolute path to a worker-produced output file. */
  path?: string;
  /** Optional human description surfaced to the agent ("confirmation page"). */
  label?: string;
}

/**
 * Delivery request for a background-ish task artifact. Phase 1 uses this
 * for browser-task reports and clarifications; later phases can add
 * `background_task` payloads without changing the dispatch branch.
 *
 * The event itself is not a scheduled event. The daemon delivery handler
 * acquires the owner-DM gates, chooses idle vs active, and only in the
 * active case synthesizes a `scheduled.dm`-shaped event internally so the
 * conversational delivery path inherits the scheduled-DM context blocks.
 */
export interface TaskDeliveryEvent extends Event {
  type: "task.delivery";
  taskContext: {
    // `autonomous_forward` (Phase 4, opt-in) routes a routine/autonomous
    // proactive forward through the SAME gate + activity-branch machinery
    // so an active owner gets a woven delivery turn instead of a verbatim
    // dump. It carries no DB row (fire-and-forget, no delivered_at recovery).
    taskKind: "browser_task" | "background_task" | "autonomous_forward";
    taskId: string;
    deliveryType: "task_result" | "task_clarification";
    title: string;
    draft: string;
    report?: string | null;
    originatingChannel?: string | null;
    clarificationId?: string | null;
    contextSummary?: string | null;
    /** Browser-task trace screenshot keys (legacy Phase-1 source; folded
     *  into `assets` at delivery time). */
    screenshotKeys?: string[];
    /** Deliverable files the task produced. Empty / absent ⇒ nothing is
     *  attached and no asset manifest is surfaced to the agent. */
    assets?: TaskDeliveryAsset[];
  };
}

export function isTaskDeliveryEvent(e: Event): e is TaskDeliveryEvent {
  return e.type === "task.delivery";
}

/**
 * Umbrella guard for any scheduler-fired event (currently
 * `scheduled.task`, `scheduled.dm`, or `scheduled.browser_task`).
 * Replaces `isAgentTaskEvent` at call sites where every subtype should
 * be treated uniformly — e.g. marking the parent `agent_schedule` row
 * completed/failed, gating final-text DM delivery, or injecting
 * calendar/origin context.
 *
 * The fallback path (`scheduled.browser_task` lands here) returns the
 * event widened to `AgentTaskEvent`'s structural shape; callers that
 * need the browser-task subtype must use `isScheduledBrowserTaskEvent`
 * explicitly. This umbrella guard exists solely for the lifecycle
 * cross-cutting concerns enumerated above.
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
