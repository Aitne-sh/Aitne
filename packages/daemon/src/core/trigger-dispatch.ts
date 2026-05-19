/**
 * Trigger dispatch glue — see
 * `docs/design/appendices/unified-repositories.md` §4.4.
 *
 * `evaluateTriggers` (`./trigger-evaluator.ts`) decides which triggers
 * fire for an `(eventType, payload)` pair on a given repository.
 * This module owns the *dispatch* half: build a `scheduled.task`
 * event matching the trigger's action and put it on the EventBus,
 * then bump the trigger's fire counter.
 *
 * Triggers run in **parallel** with the existing event-type → task-flow
 * pipeline (design §4.4); they do not consume or short-circuit it.
 * Failures in trigger dispatch never bubble out — observers stay
 * resilient to a single bad trigger.
 */

import {
  createEvent,
  EventPriority,
  type AgentTaskEvent,
} from "@aitne/shared";
import type Database from "better-sqlite3";
import type { EventBus } from "./event-bus.js";
import { evaluateTriggers } from "./trigger-evaluator.js";
import {
  getRepository,
  listEnabledTriggersForEvent,
  recordTriggerFire,
  type RepositoryDTO,
  type RepositoryTriggerDTO,
} from "../db/repositories-store.js";
import { createLogger } from "../logging.js";

const logger = createLogger("trigger-dispatch");

export interface TriggerDispatchDeps {
  db: Database.Database;
  eventBus: EventBus;
}

/**
 * Look up enabled triggers for `(repositoryId, eventType)`, filter by
 * `evaluateTriggers`, and enqueue a `scheduled.task` per match.
 *
 * Returns the number of events enqueued. Never throws — trigger
 * dispatch must be best-effort so a single misconfigured row cannot
 * stall the observer poll loop.
 */
export async function dispatchMatchingTriggers(
  deps: TriggerDispatchDeps,
  repositoryId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<number> {
  try {
    const candidates = listEnabledTriggersForEvent(
      deps.db,
      repositoryId,
      eventType,
    );
    if (candidates.length === 0) return 0;

    const matched = evaluateTriggers(candidates, eventType, payload);
    if (matched.length === 0) return 0;

    const repo = getRepository(deps.db, repositoryId);
    if (!repo) {
      logger.warn(
        { repositoryId, eventType },
        "Trigger dispatch skipped — repository row not found",
      );
      return 0;
    }

    let emitted = 0;
    for (const trigger of matched) {
      try {
        const event = buildTriggerEvent(repo, trigger, eventType, payload);
        await deps.eventBus.put(event);
        recordTriggerFire(deps.db, trigger.id);
        emitted += 1;
        logger.info(
          {
            repositoryId,
            triggerId: trigger.id,
            triggerName: trigger.name,
            eventType,
            workdirMode: trigger.workdirMode,
            backend: trigger.backend,
          },
          "Trigger fired",
        );
      } catch (err) {
        logger.warn(
          { err, repositoryId, triggerId: trigger.id, eventType },
          "Trigger dispatch failed for a single trigger — continuing",
        );
      }
    }
    return emitted;
  } catch (err) {
    logger.warn({ err, repositoryId, eventType }, "Trigger dispatch loop failed");
    return 0;
  }
}

function buildTriggerEvent(
  repo: RepositoryDTO,
  trigger: RepositoryTriggerDTO,
  eventType: string,
  payload: Record<string, unknown>,
): AgentTaskEvent {
  const base = createEvent({
    type: "scheduled.task",
    source: "trigger-dispatch",
    priority: EventPriority.HIGH,
  });
  return {
    ...base,
    task: `Trigger '${trigger.name}' on ${repo.slug} (${trigger.workdirMode}).`,
    taskContext: {
      triggerSource: "repository_trigger",
      processKey: "agent.task",
      repositoryId: repo.id,
      slug: repo.slug,
      localPath: repo.localPath,
      githubRepo:
        repo.githubOwner && repo.githubRepo
          ? `${repo.githubOwner}/${repo.githubRepo}`
          : null,
      workdirMode: trigger.workdirMode,
      prompt: trigger.prompt,
      instructionMd: trigger.instructionMd ?? null,
      timeoutMinutes: null,
      triggerId: trigger.id,
      triggerName: trigger.name,
      triggerEventType: eventType,
      triggerEventPayload: payload,
    },
    requestedBackendId: trigger.backend,
    requestedModelId: trigger.model,
  };
}
