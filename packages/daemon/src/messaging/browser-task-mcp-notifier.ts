/**
 * Browser-task MCP-side DM dispatcher — BROWSER_TASK_REDESIGN_PLAN.md §5.
 *
 * The browser-task sub-agent's `ask_user` and `finish` tools call out to
 * this surface to DM the originating channel:
 *
 *   - `notifyAskUser`  → "❓ Browser task <id> needs your input." with
 *                        the question + the screenshot attached inline.
 *   - `notifyFinish`   → the agent's markdown report + the ordered list
 *                        of screenshots (attached inline) the user should
 *                        review.
 *
 * Distinct from the runner-side `BrowserTaskNotifier` (queued / terminal
 * structural DMs):
 *
 *   - The runner-side notifier covers events the sub-agent never sees
 *     (the slot manager queued the task, the SDK loop crashed before any
 *     tool fired, etc.). Plain templated bodies.
 *   - This MCP-side notifier carries agent-authored prose — the
 *     `question` / `report` strings come from the sub-agent.
 *
 * The two cannot collapse into one because:
 *   - The SDK tool body needs synchronous access to a notifier (it's
 *     invoked inside `mcp__aitne-browser__ask_user`'s handler); the
 *     runner-side notifier is invoked from the runner's lifecycle hooks.
 *   - The agent-authored vs. structural split keeps the redaction-
 *     coverage guard happy: structural bodies are templated text that
 *     the guard knows is safe; agent bodies pass the same redaction
 *     pipeline already applied to other LLM-authored outbound text.
 *
 * Best-effort delivery: DM failures log + continue. The DB row for the
 * task / clarification has already been written by the tool handler, so
 * a DM hiccup does NOT block the parent task — the dashboard surfaces
 * the row regardless. (See §5 ask_user "Resume — Deadline enforcement"
 * for the deadline-driven fallback when the user never sees the DM.)
 *
 * No capability-symbol gate here. The structural anti-spoofing surface
 * (B-4 purchase confirms + lite-final-confirm tokens) protects DM bodies
 * that the agent could otherwise mint to itself; `ask_user` / `finish`
 * bodies are intentionally agent-authored — the user is reading the
 * agent's question / report. The only header marker we attach is for the
 * user's benefit, not for adapter-side trust gating.
 */

import { createLogger } from "../logging.js";
import {
  MessageDeliveryError,
  type MessageHub,
} from "../adapters/message-hub.js";
import type { OutboundAttachmentRef } from "../adapters/types.js";
import { parseChannelRef } from "../db/browser-automation-purchase-primary-channels-store.js";
import {
  resolveScreenshotAttachment,
  type IngestOutboundImage,
} from "./browser-task-screenshot-attachment.js";
import type { BrowserTaskMcpNotifier } from "../services/browser-history/automation/browser-task-tools/server.js";

const logger = createLogger("browser-task-mcp-notifier");

/** Header line for ask_user DMs. Chosen so it does NOT collide with the
 *  B-4 / lite-final-confirm markers (which carry the literal substring
 *  "confirmation") nor with the runner's `🕒` / `🟦` queue / terminal
 *  emojis. */
export const ASK_USER_HEADER = "Browser task — needs your input";

/** Header line for finish DMs. */
export const FINISH_HEADER = "Browser task — report";

/** Soft cap on the `finish` report body inside the DM. The agent's tool
 *  schema already caps `report` at 8 KB; some adapters (Telegram) cap
 *  individual messages at ~4 KB. We truncate at 3 800 chars to leave
 *  comfortable room for headers + screenshot links and append a "[…]"
 *  marker so the user can tell the report was cropped.
 *  The Aitne dashboard's per-task detail page renders the full report
 *  via `GET /api/browser-task/:id`, so truncation is purely a DM-side
 *  ergonomic. */
const FINISH_REPORT_DM_BODY_CAP = 3_800;

/** Max screenshots attached to a single finish DM. The full ordered list
 *  is preserved in the row's `report` field; this cap just keeps the DM
 *  from ballooning with attachments. */
const FINISH_DM_SCREENSHOT_LINK_CAP = 8;

export interface CreateBrowserTaskMcpNotifierDeps {
  messageHub: MessageHub;
  /** Daemon data directory (`PA_DATA_DIR`). Required to resolve a
   *  screenshotKey (`/api/browser-task/<id>/screenshots/<file>`) back to
   *  its on-disk location under
   *  `<paDataDir>/automation-traces/<id>/<file>` so the bytes can be
   *  uploaded through the messaging adapter / ingested for the dashboard.
   *  When omitted, every screenshot resolves to an "unavailable" note. */
  paDataDir?: string;
  /** Ingest a resolved trace-store screenshot into the chat
   *  `AttachmentStore` and return a store-backed `OutboundAttachmentRef`
   *  (or null on failure). Used for the `dashboard` platform ONLY: the
   *  dashboard fetches attachments by id through the authenticated
   *  same-origin `/api/chat/attachments/:id` proxy, so a loopback trace
   *  URL embedded as markdown would 401 (the bearer token is never
   *  attached to a raw `<img>` request). Minting a real store id lets the
   *  dashboard render the bytes inline like any other agent attachment —
   *  never a URL. Messaging adapters take the trace file directly via
   *  their native upload API, so they do NOT go through this. Optional:
   *  when omitted, dashboard screenshots resolve to an "unavailable"
   *  note. */
  ingestOutboundImage?: IngestOutboundImage;
}

export function createBrowserTaskMcpNotifier(
  deps: CreateBrowserTaskMcpNotifierDeps,
): BrowserTaskMcpNotifier {
  const paDataDir = deps.paDataDir ?? null;

  /** Per-channel delivery. Both surfaces receive the screenshot as actual
   *  image bytes — never a URL:
   *
   *   - `dashboard`: each key is ingested into the chat `AttachmentStore`
   *     and delivered as an `OutboundAttachmentRef`; the dashboard renders
   *     it inline by fetching `/api/chat/attachments/:id` through its
   *     authenticated same-origin proxy.
   *   - messaging adapters (WhatsApp / Telegram / Slack / Discord): each
   *     key is handed to the adapter as a trace-file `OutboundAttachmentRef`
   *     so the adapter uploads the bytes via its native API.
   *
   *  Any key that cannot be resolved (file dropped by §14.7 retention,
   *  ingest unavailable, unknown extension) is replaced by a single
   *  "unavailable" note rather than an unreachable link. The dashboard's
   *  `/browser-tasks/<id>` page remains the canonical full-trace view. */
  async function dispatch(
    ref: string,
    head: readonly (string | null)[],
    tail: readonly (string | null)[],
    screenshotKeys: readonly string[],
  ): Promise<void> {
    const parsed = parseChannelRef(ref);
    if (!parsed) {
      logger.warn(
        { ref },
        "browser-task MCP notifier: unparseable channel ref — DM skipped",
      );
      return;
    }
    const headLines = head.filter((s): s is string => s !== null);
    const tailLines = tail.filter((s): s is string => s !== null);
    const resolved = (
      await Promise.all(
        screenshotKeys.map((key) =>
          resolveScreenshotAttachment({
            platform: parsed.platform,
            key,
            paDataDir,
            ingestOutboundImage: deps.ingestOutboundImage,
          }),
        ),
      )
    ).filter((a): a is OutboundAttachmentRef => a !== null);
    const unresolved = screenshotKeys.length - resolved.length;
    const noteBlock =
      unresolved > 0
        ? [
            "",
            `(${unresolved} screenshot${unresolved === 1 ? "" : "s"} could not be attached — open the browser-task detail page)`,
          ]
        : [];
    const body = [...headLines, ...noteBlock, ...tailLines].join("\n");
    const attachments = resolved.length > 0 ? resolved : undefined;
    try {
      await deps.messageHub.sendToPlatform(
        parsed.platform,
        parsed.channelId,
        body,
        undefined,
        attachments,
      );
    } catch (err) {
      const reason =
        err instanceof MessageDeliveryError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      logger.warn(
        { ref, reason },
        "browser-task MCP notifier: DM dispatch failed (continuing)",
      );
    }
  }

  async function notifyAskUser(input: {
    taskId: string;
    originatingChannel: string | null;
    clarificationId: string;
    question: string;
    contextSummary: string;
    screenshotKey: string | null;
  }): Promise<void> {
    if (!input.originatingChannel) {
      logger.warn(
        {
          taskId: input.taskId,
          clarificationId: input.clarificationId,
        },
        "ask_user: no originating channel persisted — DM skipped (clarification row still written)",
      );
      return;
    }
    const screenshotKeys = input.screenshotKey ? [input.screenshotKey] : [];
    const head: (string | null)[] = [
      `❓ ${ASK_USER_HEADER}`,
      `Task: ${input.taskId}`,
      `Question: ${input.question}`,
      `Context: ${input.contextSummary}`,
    ];
    const tail: (string | null)[] = [
      ``,
      `Reply in this DM to answer (clarification id: ${input.clarificationId}).`,
    ];
    await dispatch(input.originatingChannel, head, tail, screenshotKeys);
  }

  async function notifyFinish(input: {
    taskId: string;
    originatingChannel: string | null;
    report: string;
    screenshotKeys: readonly string[];
  }): Promise<void> {
    if (!input.originatingChannel) {
      logger.warn(
        { taskId: input.taskId },
        "finish: no originating channel persisted — DM skipped (report still stored on the row)",
      );
      return;
    }
    const reportBody =
      input.report.length > FINISH_REPORT_DM_BODY_CAP
        ? `${input.report.slice(0, FINISH_REPORT_DM_BODY_CAP)}\n\n[… truncated; open the dashboard for the full report]`
        : input.report;
    const keyBudget = input.screenshotKeys.slice(
      0,
      FINISH_DM_SCREENSHOT_LINK_CAP,
    );
    const overflowCount = Math.max(
      0,
      input.screenshotKeys.length - keyBudget.length,
    );
    const head: (string | null)[] = [
      `✅ ${FINISH_HEADER}`,
      `Task: ${input.taskId}`,
      ``,
      reportBody,
    ];
    const tail: (string | null)[] =
      overflowCount > 0
        ? [``, `(+${overflowCount} more — see dashboard)`]
        : [];
    await dispatch(input.originatingChannel, head, tail, keyBudget);
  }

  return { notifyAskUser, notifyFinish };
}
