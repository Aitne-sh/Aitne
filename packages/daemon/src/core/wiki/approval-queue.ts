import type Database from "better-sqlite3";
import type { MessageEvent, WikiCostEstimate } from "@aitne/shared";
import type {
  GitPreCompileOutcome,
  GitPreCompilePreview,
} from "./git-precompile.js";
import { createLogger } from "../../logging.js";

const logger = createLogger("wiki-approval-queue");

/**
 * Wiki approval queue — WIKI_BUILDER_DESIGN.md §5.5, §P2.E.
 *
 * `!compile full` above the per-workspace cost threshold escalates to
 * `RiskTier.Approve`. The escalation re-uses the existing approval
 * mechanism that the dashboard's `/approvals` route already drives:
 * an `agent_schedule` row with `task_type='approval'` is the
 * canonical signal, the owner DMs `yes` (or clicks approve in the
 * dashboard), the row flips to `task_type='approved_task'`, and the
 * scheduler reads the materialised event from `task_context.event`.
 *
 * This module owns just the insert side; the consumer side already
 * exists in `dashboard.ts` (`POST /approvals/:id/approve`) and in the
 * existing scheduler wakeup.
 */

export interface EnqueueWikiApprovalInput {
  workspace: string;
  processKey: "wiki.compile";
  sourceEvent: MessageEvent;
  estimate: WikiCostEstimate;
  // Accept either shape: at !compile-full dispatch we only know the preview
  // (no commit yet — the approval consumer runs `runGitPreCompile` when
  // the operator approves). `GitPreCompileOutcome` is retained so the
  // type still matches downstream code that may pass a post-commit value
  // when the call site already mutated git state.
  gitOutcome: GitPreCompilePreview | GitPreCompileOutcome;
}

export interface EnqueueWikiApprovalResult {
  scheduleId: number;
  taskDescription: string;
}

export function enqueueWikiApproval(
  db: Database.Database,
  input: EnqueueWikiApprovalInput,
): EnqueueWikiApprovalResult {
  const taskDescription = `Wiki full compile (${input.workspace}) — est. $${input.estimate.expectedUsd.toFixed(2)} (range $${input.estimate.optimisticUsd.toFixed(2)}–$${input.estimate.pessimisticUsd.toFixed(2)})`;
  // WIKI_BUILDER_DESIGN.md §3.4-bis — the approved scheduled.task event
  // fired by the scheduler must carry the same reply-routing tuple the
  // immediate-dispatch path uses, so the completion DM lands back on the
  // channel the operator typed `!compile full` on. `replyTarget` is the
  // structured form (`platform/channel/threadId/sender`); the legacy
  // `source{Platform,Channel,CorrelationId}` fields are preserved for
  // back-compat with any external consumer that already reads them.
  // `scheduler.ts` lifts `replyTarget` from `taskContext` into
  // `event.data.reply_target` at scheduled.task event-mint time.
  const taskContext = {
    workspace: input.workspace,
    processKey: input.processKey,
    estimate: input.estimate,
    git: input.gitOutcome,
    sourceCorrelationId: input.sourceEvent.correlationId,
    sourcePlatform: input.sourceEvent.platform,
    sourceChannel: input.sourceEvent.channel,
    replyTarget: {
      platform: input.sourceEvent.platform,
      channel: input.sourceEvent.channel,
      threadId: input.sourceEvent.threadId,
      sender: input.sourceEvent.sender,
    },
  };

  const info = db
    .prepare(
      `INSERT INTO agent_schedule
         (scheduled_for, task_type, task_description, task_prompt, task_context, correlation_id, status)
       VALUES
         (CURRENT_TIMESTAMP, 'approval', ?, NULL, json(?), ?, 'pending')`,
    )
    .run(
      taskDescription,
      JSON.stringify(taskContext),
      input.sourceEvent.correlationId,
    );
  const scheduleId = Number(info.lastInsertRowid);
  logger.info(
    {
      workspace: input.workspace,
      estimatedUsd: input.estimate.expectedUsd,
      thresholdUsd: input.estimate.thresholdUsd,
      scheduleId,
    },
    "wiki !compile full escalated to Approve tier",
  );
  return { scheduleId, taskDescription };
}
