import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { basename } from "node:path";
import type {
  AgentTaskEvent,
  TaskDeliveryAsset,
  TaskDeliveryEvent,
} from "@aitne/shared";
import {
  EventPriority,
  createEvent,
} from "@aitne/shared";
import type { AgentConfig } from "../config.js";
import type { OutboundAttachmentRef } from "../adapters/types.js";
import {
  getBrowserTask,
  listUndeliveredBrowserTaskReports,
  markBrowserTaskDelivered,
} from "../db/browser-task-store.js";
import {
  getClarification,
  listUndeliveredClarifications,
  markClarificationDelivered,
} from "../db/browser-task-clarifications-store.js";
import {
  getBackgroundTask,
  listUndeliveredBackgroundTaskReports,
  markBackgroundTaskDelivered,
} from "../db/background-task-store.js";
import {
  getClarification as getBackgroundClarification,
  listUndeliveredClarifications as listUndeliveredBackgroundClarifications,
  markClarificationDelivered as markBackgroundClarificationDelivered,
} from "../db/background-task-clarifications-store.js";
import { parseChannelRef } from "../db/browser-automation-purchase-primary-channels-store.js";
import { isInQuietHoursAt } from "./quiet-hours.js";
import {
  DASHBOARD_CHAT_SCOPE,
  DASHBOARD_SCOPE_KEY,
  OWNER_DM_SCOPE,
  OWNER_SCOPE_KEY,
} from "../messaging/constants.js";
import type { INotificationManager } from "./dispatcher-types.js";
import {
  classifyOwnerDmActivity,
  type OwnerDmActivityState,
} from "./context-builder-conversation.js";
import {
  recordProactiveForwardDeliveries,
  type ProactiveForwardType,
} from "./channel-timeline.js";
import { createLogger } from "../logging.js";

const logger = createLogger("dispatcher-task-delivery");

export const TASK_DELIVERY_GATE_KEYS = [
  `${OWNER_DM_SCOPE}:${OWNER_SCOPE_KEY}`,
  `${DASHBOARD_CHAT_SCOPE}:${DASHBOARD_SCOPE_KEY}`,
] as const;

const REPORT_DRAFT_CAP = 3_800;

export interface BrowserTaskDeliveryEventInput {
  taskId: string;
  originatingChannel: string | null;
  title: string;
}

export function createBrowserTaskResultDeliveryEvent(
  input: BrowserTaskDeliveryEventInput & {
    report: string;
    screenshotKeys?: readonly string[];
  },
): TaskDeliveryEvent {
  const draft =
    input.report.length > REPORT_DRAFT_CAP
      ? `${input.report.slice(0, REPORT_DRAFT_CAP)}\n\n[... truncated; open the browser-task detail page for the full report]`
      : input.report;
  return Object.assign(createEvent({
    type: "task.delivery",
    source: "browser_task",
    priority: EventPriority.HIGH,
    data: {},
  }), {
    taskContext: {
      taskKind: "browser_task",
      taskId: input.taskId,
      deliveryType: "task_result",
      title: input.title,
      draft,
      report: input.report,
      originatingChannel: input.originatingChannel,
      screenshotKeys: [...(input.screenshotKeys ?? [])],
    },
  }) as TaskDeliveryEvent;
}

export function createBrowserTaskClarificationDeliveryEvent(
  input: BrowserTaskDeliveryEventInput & {
    clarificationId: string;
    question: string;
    contextSummary: string | null;
    screenshotKey: string | null;
  },
): TaskDeliveryEvent {
  const draft = [
    `Browser task "${input.title}" needs your input.`,
    `Question: ${input.question}`,
    input.contextSummary ? `Context: ${input.contextSummary}` : null,
    "Reply here with the answer; I will pass it back to the task.",
  ]
    .filter((line): line is string => line !== null && line.length > 0)
    .join("\n");
  return Object.assign(createEvent({
    type: "task.delivery",
    source: "browser_task",
    priority: EventPriority.HIGH,
    data: {},
  }), {
    taskContext: {
      taskKind: "browser_task",
      taskId: input.taskId,
      deliveryType: "task_clarification",
      title: input.title,
      draft,
      report: input.question,
      originatingChannel: input.originatingChannel,
      clarificationId: input.clarificationId,
      contextSummary: input.contextSummary,
      screenshotKeys: input.screenshotKey ? [input.screenshotKey] : [],
    },
  }) as TaskDeliveryEvent;
}

export interface BackgroundTaskResultDeliveryInput {
  taskId: string;
  originatingChannel: string | null;
  title: string;
  /** Worker-authored summary — the idle-send body / active-turn grounding. */
  draft: string;
  /** Verbatim result — injected into the active delivery turn so the DM
   *  agent can weave full detail without a tool round-trip. */
  report: string;
  /** Worker-produced deliverable files (PDF / PPTX / PNG / docs) to attach
   *  to the result DM. Omit / empty when the task produced no files. */
  assets?: readonly TaskDeliveryAsset[];
}

export function createBackgroundTaskResultDeliveryEvent(
  input: BackgroundTaskResultDeliveryInput,
): TaskDeliveryEvent {
  return Object.assign(
    createEvent({
      type: "task.delivery",
      source: "background_task",
      priority: EventPriority.HIGH,
      data: {},
    }),
    {
      taskContext: {
        taskKind: "background_task",
        taskId: input.taskId,
        deliveryType: "task_result",
        title: input.title,
        // The worker-authored `draft` IS the natural-language summary;
        // unlike browser_task (which truncates the raw report), the
        // background worker already produced a clean draft + a separate
        // verbatim report. Idle sends the draft; the active turn reads
        // the full report (injected below) and weaves.
        draft: input.draft,
        report: input.report,
        originatingChannel: input.originatingChannel,
        screenshotKeys: [],
        assets: [...(input.assets ?? [])],
      },
    },
  ) as TaskDeliveryEvent;
}

export function createBackgroundTaskClarificationDeliveryEvent(input: {
  taskId: string;
  originatingChannel: string | null;
  title: string;
  clarificationId: string;
  question: string;
  contextSummary: string | null;
}): TaskDeliveryEvent {
  const draft = [
    `The background task "${input.title}" needs your input.`,
    `Question: ${input.question}`,
    input.contextSummary ? `Context: ${input.contextSummary}` : null,
    "Reply here with the answer; I will pass it back to the task.",
  ]
    .filter((line): line is string => line !== null && line.length > 0)
    .join("\n");
  return Object.assign(
    createEvent({
      type: "task.delivery",
      source: "background_task",
      priority: EventPriority.HIGH,
      data: {},
    }),
    {
      taskContext: {
        taskKind: "background_task",
        taskId: input.taskId,
        deliveryType: "task_clarification",
        title: input.title,
        draft,
        report: input.question,
        originatingChannel: input.originatingChannel,
        clarificationId: input.clarificationId,
        contextSummary: input.contextSummary,
        screenshotKeys: [],
      },
    },
  ) as TaskDeliveryEvent;
}

/**
 * BACKGROUND_TASK_RUNNER_DESIGN.md §2.3 / §13 Decision 4 (Phase 4, opt-in)
 * — wrap a routine autonomous forward as a `task.delivery` event so it
 * flows through the same gate + activity-branch machinery: an active owner
 * gets a woven delivery turn, an idle owner the verbatim send + record.
 * Carries no DB row (synthetic id, no `delivered_at` recovery — autonomous
 * forwards are fire-and-forget, exactly as the verbatim path is today).
 */
export function createAutonomousForwardDeliveryEvent(input: {
  content: string;
  originatingChannel: string | null;
  title?: string;
  correlationId?: string | null;
}): TaskDeliveryEvent {
  return Object.assign(
    createEvent({
      type: "task.delivery",
      source: "autonomous_forward",
      priority: EventPriority.HIGH,
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      data: {},
    }),
    {
      taskContext: {
        taskKind: "autonomous_forward",
        taskId: randomUUID(),
        deliveryType: "task_result",
        title: input.title ?? "update",
        // The forward content is both the idle-send body and the active
        // turn's grounding — there is no separate verbatim/summary split.
        draft: input.content,
        report: input.content,
        originatingChannel: input.originatingChannel,
        screenshotKeys: [],
      },
    },
  ) as TaskDeliveryEvent;
}

export interface TaskDeliveryHandlerDeps {
  db: Database.Database;
  config: AgentConfig;
  notificationMgr: INotificationManager;
  executeScheduledTask(event: AgentTaskEvent): Promise<void>;
  /**
   * Resolve a task's deliverable assets (browser-task trace screenshots
   * and/or worker-written files: PDF / PPTX / PNG / docs) to outbound
   * attachments for the platform the DM lands on. Used by BOTH the idle
   * direct-send and the active delivery turn so the owner receives the
   * actual files inline (BACKGROUND_TASK_RUNNER_DESIGN.md Phase 1 — delivery
   * assets). Injected from bootstrap (closure over `paDataDir` + the
   * dashboard ingest hook); absent in unit tests, where assets are simply
   * omitted. Best-effort — must resolve to `[]` rather than throw.
   */
  resolveAssets?(
    platform: string,
    assets: readonly TaskDeliveryAsset[],
  ): Promise<readonly OutboundAttachmentRef[]>;
  nowFn?: () => number;
}

/** The asset key the dispatch arm puts resolved refs under on the
 *  synthetic `scheduled.dm` event so the result processor can attach them
 *  to the woven reply. */
export const TASK_DELIVERY_ATTACHMENTS_KEY = "task_delivery_attachments";

/**
 * The canonical deliverable-asset list for a payload. Prefers an explicit
 * `assets` manifest (background-task workers populate it); falls back to
 * folding legacy browser-task `screenshotKeys` into screenshot assets so
 * the Phase-1 source keeps working unchanged. Empty ⇒ nothing to present.
 */
function effectiveAssets(
  payload: TaskDeliveryEvent["taskContext"],
): TaskDeliveryAsset[] {
  if (payload.assets && payload.assets.length > 0) {
    return payload.assets;
  }
  return (payload.screenshotKeys ?? []).map((key) => ({
    filename: basename(key),
    kind: "screenshot" as const,
    screenshotKey: key,
  }));
}

/**
 * The agent-facing slice of the asset list — filename / kind / label only.
 * Internal locations (screenshotKey, absolute path) are deliberately
 * withheld from the LLM context: the daemon attaches the bytes, and the
 * agent references assets by name/kind. Detail/paths for a later re-send
 * come from the artifact API, not the conversation.
 */
function assetManifest(
  assets: readonly TaskDeliveryAsset[],
): Array<{ filename: string; kind: string; label?: string }> {
  return assets.map((a) => ({
    filename: a.filename,
    kind: a.kind,
    ...(a.label ? { label: a.label } : {}),
  }));
}

async function resolveDeliveryAttachments(
  deps: TaskDeliveryHandlerDeps,
  platform: string,
  payload: TaskDeliveryEvent["taskContext"],
): Promise<readonly OutboundAttachmentRef[]> {
  const assets = effectiveAssets(payload);
  if (assets.length === 0 || !deps.resolveAssets) return [];
  try {
    return await deps.resolveAssets(platform, assets);
  } catch (err) {
    // Assets are a best-effort enrichment of the text draft — a resolver
    // failure must never block the result/clarification DM itself.
    logger.warn(
      { err, taskId: payload.taskId, deliveryType: payload.deliveryType },
      "task.delivery asset resolution failed; sending text only",
    );
    return [];
  }
}

export async function handleTaskDeliveryInsideGate(
  deps: TaskDeliveryHandlerDeps,
  event: TaskDeliveryEvent,
): Promise<void> {
  const payload = event.taskContext;
  if (
    payload.taskKind !== "browser_task"
    && payload.taskKind !== "background_task"
    && payload.taskKind !== "autonomous_forward"
  ) {
    logger.warn(
      { taskKind: payload.taskKind, taskId: payload.taskId },
      "task.delivery skipped: unsupported task kind",
    );
    return;
  }

  const now = deps.nowFn?.() ?? Date.now();
  // `autonomous_forward` carries no DB row, so the row-keyed dedup /
  // delivered_at checks below do not apply — it is fire-and-forget (the
  // verbatim path it replaces had no recovery either). Browser/background
  // task deliveries keep the full idempotency contract.
  if (payload.taskKind !== "autonomous_forward") {
    if (await backfillDeliveredAtIfMessageExists(deps.db, payload, now)) {
      return;
    }
    if (isDeliveryAlreadyMarked(deps.db, payload)) {
      return;
    }
  }

  // No deliverable channel ⇒ the report/clarification is still filed on
  // the row, but there is nowhere to DM it (`browser_task.originating_channel`
  // is nullable — e.g. synthetic / channel-less runs). Mark delivered so
  // the boot/periodic recovery sweep (which selects `delivered_at IS NULL`)
  // does not re-enqueue this task on every 30 s tick, and so the active
  // branch never spends a full LLM turn on something it cannot deliver.
  // Matches the pre-Phase-1 notifier's "skip once" behaviour, minus the
  // churn. Logged as a degrade per the project's "no silent drops" posture.
  const channel = resolveDeliveryChannel(payload);
  if (!channel) {
    logger.warn(
      {
        taskId: payload.taskId,
        deliveryType: payload.deliveryType,
        originatingChannel: payload.originatingChannel,
      },
      "task.delivery dropped: no parseable originating channel; report "
        + "filed on the row, marking delivered to stop recovery churn",
    );
    markDeliveredAt(deps.db, payload, now);
    return;
  }

  const activity = classifyOwnerDmActivity({ db: deps.db, config: deps.config }, now);
  if (activity === "active") {
    await deliverActive(deps, event, activity, channel);
    return;
  }

  // Idle/asleep + quiet hours ⇒ defer. The design (§4.5 / §10.6) routes
  // the idle branch through the proactive quiet-hours suppression so a
  // task finishing at 03:00 does not ping a sleeping owner. The idle send
  // uses `replyTo` (to hit the originating channel), which bypasses
  // NotificationManager's own quiet-hours gate — so we gate here instead.
  // Leaving `delivered_at` NULL lets the boot/periodic recovery sweep
  // re-deliver once the window lifts (and re-classify: if the owner is
  // active by then, it weaves into the live thread instead).
  if (isQuietHoursNow(deps.config, now)) {
    logger.info(
      {
        taskId: payload.taskId,
        deliveryType: payload.deliveryType,
      },
      "task.delivery idle send deferred — quiet hours; recovery sweep will "
        + "re-deliver after the window",
    );
    return;
  }
  await deliverIdle(deps, event, channel);
}

function isQuietHoursNow(config: AgentConfig, nowMs: number): boolean {
  return isInQuietHoursAt(new Date(nowMs), {
    start: config.quietHoursStart,
    end: config.quietHoursEnd,
    timezone: config.timezone || undefined,
  });
}

async function deliverActive(
  deps: TaskDeliveryHandlerDeps,
  event: TaskDeliveryEvent,
  activity: OwnerDmActivityState,
  channel: DeliveryChannel,
): Promise<void> {
  const payload = event.taskContext;
  const attachments = await resolveDeliveryAttachments(
    deps,
    channel.platform,
    payload,
  );
  const scheduledEvent = createScheduledDmDeliveryEvent(
    event,
    activity,
    attachments,
    channel,
  );
  try {
    await deps.executeScheduledTask(scheduledEvent);
  } catch (err) {
    logger.warn(
      { err, taskId: payload.taskId, deliveryType: payload.deliveryType },
      "task.delivery active turn failed; falling back to direct draft",
    );
    // Reuse the already-resolved attachments — re-resolving would
    // re-ingest dashboard files and could diverge from what the active
    // turn was given.
    await deliverIdle(deps, event, channel, attachments);
    return;
  }

  const now = deps.nowFn?.() ?? Date.now();
  if (await backfillDeliveredAtIfMessageExists(deps.db, payload, now)) {
    return;
  }
  logger.warn(
    { taskId: payload.taskId, deliveryType: payload.deliveryType },
    "task.delivery active turn produced no tagged message; falling back to direct draft",
  );
  await deliverIdle(deps, event, channel, attachments);
}

async function deliverIdle(
  deps: TaskDeliveryHandlerDeps,
  event: TaskDeliveryEvent,
  channel: DeliveryChannel,
  preResolvedAttachments?: readonly OutboundAttachmentRef[],
): Promise<void> {
  const payload = event.taskContext;
  const attachments =
    preResolvedAttachments
    ?? (await resolveDeliveryAttachments(deps, channel.platform, payload));
  await deps.notificationMgr.send(payload.draft, event, {
    priority: "normal",
    category: "agent",
    replyTo: {
      platform: channel.platform,
      channel: channel.channelId,
      threadId: null,
    },
    ...(attachments.length > 0 ? { attachments } : {}),
  });

  const dispatchId = randomUUID();
  const now = deps.nowFn?.() ?? Date.now();
  const recordAndMark = deps.db.transaction(() => {
    recordProactiveForwardDeliveries({
      db: deps.db,
      config: deps.config,
      deliveries: [
        {
          platform: channel.platform,
          channel: channel.channelId,
        },
      ],
      content: payload.draft,
      dispatchId,
      dispatchIds: [dispatchId],
      notificationType: notificationTypeFor(payload),
      extraMetadata: taskDeliveryMetadata(payload, false),
    });
    markDeliveredAt(deps.db, payload, now);
  });
  recordAndMark();
}

function createScheduledDmDeliveryEvent(
  event: TaskDeliveryEvent,
  activity: OwnerDmActivityState,
  attachments: readonly OutboundAttachmentRef[],
  channel: DeliveryChannel,
): AgentTaskEvent {
  const payload = event.taskContext;
  const manifest = assetManifest(effectiveAssets(payload));
  return Object.assign(createEvent({
    type: "scheduled.dm",
    source: "task.delivery",
    priority: EventPriority.HIGH,
    correlationId: event.correlationId,
    data: {
      reply_target: {
        platform: channel.platform,
        channel: channel.channelId,
        threadId: null,
        // Audit-only label (not consumed for routing) — use the actual task
        // kind so background_task / autonomous_forward weaves aren't all
        // mislabelled as browser_task in telemetry.
        sender: payload.taskKind,
      },
      task_delivery_record: {
        notificationType: notificationTypeFor(payload),
        metadata: taskDeliveryMetadata(payload, true),
      },
      // Resolved deliverable files — the result processor attaches these to
      // the woven reply so the owner receives them inline (the active turn
      // is a no-tool DM turn and cannot self-attach). Empty ⇒ omitted.
      ...(attachments.length > 0
        ? { [TASK_DELIVERY_ATTACHMENTS_KEY]: [...attachments] }
        : {}),
    },
  }), {
    task: `task delivery: ${payload.title}`,
    taskContext: {
      task_delivery: {
        taskKind: payload.taskKind,
        taskId: payload.taskId,
        deliveryType: payload.deliveryType,
        title: payload.title,
        draft: payload.draft,
        report: payload.report ?? payload.draft,
        clarificationId: payload.clarificationId ?? null,
        contextSummary: payload.contextSummary ?? null,
        // Agent-facing asset manifest (filename/kind/label only). Present
        // only when the task produced deliverables — the skill references
        // them, and the daemon attaches the bytes. Empty ⇒ no asset block.
        assets: manifest,
        activity,
      },
    },
  }) as AgentTaskEvent;
}

/** A resolved, non-null delivery channel — the shape every delivery branch
 *  works with once `handleTaskDeliveryInsideGate`'s guard has confirmed the
 *  task has a parseable originating channel. Resolving it once and threading
 *  it through keeps the branch functions free of redundant (and unreachable)
 *  null re-checks. */
type DeliveryChannel = NonNullable<ReturnType<typeof parseChannelRef>>;

function resolveDeliveryChannel(
  payload: TaskDeliveryEvent["taskContext"],
): ReturnType<typeof parseChannelRef> {
  return payload.originatingChannel
    ? parseChannelRef(payload.originatingChannel)
    : null;
}

function notificationTypeFor(
  payload: TaskDeliveryEvent["taskContext"],
): ProactiveForwardType {
  if (payload.taskKind === "autonomous_forward") return "proactive_forward";
  return payload.deliveryType === "task_clarification"
    ? "task_clarification"
    : "task_result";
}

function taskDeliveryMetadata(
  payload: TaskDeliveryEvent["taskContext"],
  activeTurn: boolean,
): Record<string, unknown> {
  return {
    taskKind: payload.taskKind,
    taskId: payload.taskId,
    ...(activeTurn ? { deliveredTaskId: payload.taskId } : {}),
    deliveryType: payload.deliveryType,
    ...(payload.clarificationId
      ? { clarificationId: payload.clarificationId }
      : {}),
  };
}

function isDeliveryAlreadyMarked(
  db: Database.Database,
  payload: TaskDeliveryEvent["taskContext"],
): boolean {
  if (payload.deliveryType === "task_result") {
    const deliveredAt =
      payload.taskKind === "background_task"
        ? (getBackgroundTask(db, payload.taskId)?.deliveredAt ?? null)
        : (getBrowserTask(db, payload.taskId)?.deliveredAt ?? null);
    return deliveredAt !== null;
  }
  if (!payload.clarificationId) return false;
  const clarDeliveredAt =
    payload.taskKind === "background_task"
      ? (getBackgroundClarification(db, payload.clarificationId)?.deliveredAt ?? null)
      : (getClarification(db, payload.clarificationId)?.deliveredAt ?? null);
  return clarDeliveredAt !== null;
}

async function backfillDeliveredAtIfMessageExists(
  db: Database.Database,
  payload: TaskDeliveryEvent["taskContext"],
  nowMs: number,
): Promise<boolean> {
  if (!hasExistingTaskDeliveryMessage(db, payload)) return false;
  markDeliveredAt(db, payload, nowMs);
  return true;
}

function hasExistingTaskDeliveryMessage(
  db: Database.Database,
  payload: TaskDeliveryEvent["taskContext"],
): boolean {
  const params: unknown[] = [
    notificationTypeFor(payload),
    payload.taskKind,
    payload.taskId,
    payload.taskId,
  ];
  const clarificationClause = payload.clarificationId
    ? "AND json_extract(m.metadata, '$.clarificationId') = ?"
    : "";
  if (payload.clarificationId) {
    params.push(payload.clarificationId);
  }
  const row = db
    .prepare(
      `SELECT 1 AS found
         FROM messages m
        WHERE m.role = 'assistant'
          AND json_extract(m.metadata, '$.notificationType') = ?
          AND json_extract(m.metadata, '$.taskKind') = ?
          AND (
            json_extract(m.metadata, '$.taskId') = ?
            OR json_extract(m.metadata, '$.deliveredTaskId') = ?
          )
          ${clarificationClause}
        LIMIT 1`,
    )
    .get(...params) as { found: number } | undefined;
  return row !== undefined;
}

function markDeliveredAt(
  db: Database.Database,
  payload: TaskDeliveryEvent["taskContext"],
  nowMs: number,
): void {
  // `autonomous_forward` is fire-and-forget with no backing task row
  // (its `taskId` is a synthetic UUID). There is nothing to stamp
  // `delivered_at` on — writing to `browser_task` here would be an
  // UPDATE against the wrong table that matches zero rows.
  if (payload.taskKind === "autonomous_forward") return;
  if (payload.deliveryType === "task_result") {
    if (payload.taskKind === "background_task") {
      markBackgroundTaskDelivered(db, payload.taskId, nowMs);
    } else {
      markBrowserTaskDelivered(db, payload.taskId, nowMs);
    }
    return;
  }
  if (payload.clarificationId) {
    if (payload.taskKind === "background_task") {
      markBackgroundClarificationDelivered(db, payload.clarificationId, nowMs);
    } else {
      markClarificationDelivered(db, payload.clarificationId, nowMs);
    }
  }
}

export async function enqueueUndeliveredBrowserTaskDeliveries(params: {
  db: Database.Database;
  eventBus: { put(event: TaskDeliveryEvent): Promise<void> };
  nowMs?: number;
  limit?: number;
}): Promise<number> {
  const nowMs = params.nowMs ?? Date.now();
  const limit = params.limit ?? 20;
  let enqueued = 0;
  // Recovery is text-only for reports: the `finish`-tool screenshot keys
  // are not persisted on the `browser_task` row, so a report re-delivered
  // after a crash cannot re-attach its screenshots (clarifications can —
  // their `screenshotKey` IS persisted, see below). Acceptable: recovery
  // only fires on the rare write-then-crash-before-DM window, and the text
  // report still reaches the owner. (Open clarifications keep their image.)
  for (const row of listUndeliveredBrowserTaskReports(params.db, limit)) {
    if (!row.report) continue;
    await params.eventBus.put(
      createBrowserTaskResultDeliveryEvent({
        taskId: row.id,
        originatingChannel: row.originatingChannel,
        title: row.description,
        report: row.report,
      }),
    );
    enqueued += 1;
  }
  // The list query INNER JOINs `browser_task` (state='awaiting_user') and
  // folds in the task's channel + description, so no second fetch — and no
  // unreachable "task missing" guard — is needed.
  for (const clarification of listUndeliveredClarifications(
    params.db,
    nowMs,
    limit,
  )) {
    await params.eventBus.put(
      createBrowserTaskClarificationDeliveryEvent({
        taskId: clarification.taskId,
        originatingChannel: clarification.taskOriginatingChannel,
        title: clarification.taskDescription,
        clarificationId: clarification.id,
        question: clarification.question,
        contextSummary: clarification.contextSummary,
        screenshotKey: clarification.screenshotKey,
      }),
    );
    enqueued += 1;
  }
  return enqueued;
}

/**
 * BACKGROUND_TASK_RUNNER_DESIGN.md §10.2 — delivery recovery sweep for
 * background tasks. Re-enqueues `task.delivery` events for completed
 * notify=true artifacts whose DM was never sent/recorded
 * (`delivered_at IS NULL`) plus undelivered open clarifications. Run on
 * the housekeeping tick (boot + periodic). Idempotent against the
 * in-gate message-existence dedup — a re-enqueue after a successful send
 * only back-fills `delivered_at`, never double-sends (§4.4).
 */
export async function enqueueUndeliveredBackgroundTaskDeliveries(params: {
  db: Database.Database;
  eventBus: { put(event: TaskDeliveryEvent): Promise<void> };
  nowMs?: number;
  limit?: number;
}): Promise<number> {
  const nowMs = params.nowMs ?? Date.now();
  const limit = params.limit ?? 20;
  let enqueued = 0;
  for (const row of listUndeliveredBackgroundTaskReports(params.db, limit)) {
    if (!row.draft) continue;
    await params.eventBus.put(
      createBackgroundTaskResultDeliveryEvent({
        taskId: row.id,
        originatingChannel: row.originatingChannel,
        title: row.title ?? row.brief.slice(0, 80),
        draft: row.draft,
        report: row.report ?? row.draft,
      }),
    );
    enqueued += 1;
  }
  // As above, the clarification list JOINs `background_task` and folds in
  // the task's channel + title/brief, so the sweep needs no re-fetch and no
  // unreachable "task missing" guard.
  for (const clarification of listUndeliveredBackgroundClarifications(
    params.db,
    nowMs,
    limit,
  )) {
    await params.eventBus.put(
      createBackgroundTaskClarificationDeliveryEvent({
        taskId: clarification.taskId,
        originatingChannel: clarification.taskOriginatingChannel,
        title: clarification.taskTitle ?? clarification.taskBrief.slice(0, 80),
        clarificationId: clarification.id,
        question: clarification.question,
        contextSummary: clarification.contextSummary,
      }),
    );
    enqueued += 1;
  }
  return enqueued;
}
