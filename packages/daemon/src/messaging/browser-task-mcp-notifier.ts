/**
 * Browser-task MCP-side delivery bridge — BACKGROUND_TASK_RUNNER_DESIGN.md
 * Phase 1.
 *
 * The browser-task sub-agent still writes clarifications/reports through
 * its `ask_user` and `finish` tools, but this bridge no longer sends a
 * templated DM directly. It enqueues a `task.delivery` event instead; the
 * dispatcher acquires the owner-DM gates, chooses active vs idle delivery,
 * records the sent assistant message into conversation history, and marks
 * the row delivered for recovery.
 */

import type { EventBus } from "../core/event-bus.js";
import type Database from "better-sqlite3";
import {
  createBrowserTaskClarificationDeliveryEvent,
  createBrowserTaskResultDeliveryEvent,
} from "../core/dispatcher-task-delivery.js";
import { getBrowserTask } from "../db/browser-task-store.js";
import { createLogger } from "../logging.js";
import type { BrowserTaskMcpNotifier } from "../services/browser-history/automation/browser-task-tools/server.js";

const logger = createLogger("browser-task-mcp-notifier");

export interface CreateBrowserTaskMcpNotifierDeps {
  eventBus: EventBus;
  db: Database.Database;
}

export function createBrowserTaskMcpNotifier(
  deps: CreateBrowserTaskMcpNotifierDeps,
): BrowserTaskMcpNotifier {
  function titleFor(taskId: string): string {
    return getBrowserTask(deps.db, taskId)?.description ?? `Browser task ${taskId}`;
  }

  async function notifyAskUser(input: {
    taskId: string;
    originatingChannel: string | null;
    clarificationId: string;
    question: string;
    contextSummary: string;
    screenshotKey: string | null;
  }): Promise<void> {
    await deps.eventBus.put(
      createBrowserTaskClarificationDeliveryEvent({
        taskId: input.taskId,
        originatingChannel: input.originatingChannel,
        title: titleFor(input.taskId),
        clarificationId: input.clarificationId,
        question: input.question,
        contextSummary: input.contextSummary,
        screenshotKey: input.screenshotKey,
      }),
    );
    logger.debug(
      { taskId: input.taskId, clarificationId: input.clarificationId },
      "browser-task clarification queued for task.delivery",
    );
  }

  async function notifyFinish(input: {
    taskId: string;
    originatingChannel: string | null;
    report: string;
    screenshotKeys: readonly string[];
  }): Promise<void> {
    await deps.eventBus.put(
      createBrowserTaskResultDeliveryEvent({
        taskId: input.taskId,
        originatingChannel: input.originatingChannel,
        title: titleFor(input.taskId),
        report: input.report,
        screenshotKeys: input.screenshotKeys,
      }),
    );
    logger.debug(
      { taskId: input.taskId },
      "browser-task report queued for task.delivery",
    );
  }

  return { notifyAskUser, notifyFinish };
}
