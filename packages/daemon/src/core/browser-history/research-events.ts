/**
 * Event factories for browser-history research process keys
 * (BROWSER_HISTORY_INTEGRATION_PLAN §10.6 / §5.F1).
 *
 * Three process keys flow through this module:
 *   - routine.research_cluster_update   — nightly journal append
 *   - routine.research_dispatch         — !research accept <slug>
 *   - routine.research_wiki_summary     — !research wiki <slug>
 *
 * Each event is shaped after the wiki-dispatcher pattern
 * (`packages/daemon/src/core/wiki/dispatcher.ts`) so the EventBus's
 * generic routing path picks them up: `event.type` IS the process key,
 * `event.data.slug` carries the cluster identifier, and
 * `event.data.reply_target` carries the originating DM routing tuple
 * when a bang command minted the event (so the agent's DM lands back
 * on the platform the user typed `!research accept` on, not a fan-out
 * to every connected destination).
 *
 * The factory is pure — no DB, no side effects. Callers (bang command
 * handler, API route) construct the event, push it onto the EventBus,
 * and the dispatcher resolves backend / model / max_turns from
 * `process_backend_config`.
 */

import {
  createEvent,
  EventPriority,
  isMessageEvent,
  type Event,
  type RoutineEvent,
  type WikiReplyTarget,
} from "@aitne/shared";

export const RESEARCH_PROCESS_KEYS = [
  "routine.research_cluster_update",
  "routine.research_offer_dm",
  "routine.research_dispatch",
  "routine.research_wiki_summary",
] as const;

export type ResearchProcessKey = (typeof RESEARCH_PROCESS_KEYS)[number];

export function isResearchProcessKey(value: string): value is ResearchProcessKey {
  return (RESEARCH_PROCESS_KEYS as readonly string[]).includes(value);
}

export interface ResearchCommandEventInput {
  processKey: ResearchProcessKey;
  slug: string;
  /** Originating DM, if any, for reply routing. */
  sourceEvent?: Event;
  /** Extra event payload (for cluster_update: optional `displayName`). */
  data?: Record<string, unknown>;
  priority?: EventPriority;
}

export function createResearchCommandEvent(
  input: ResearchCommandEventInput,
): Event {
  // Mirror the wiki dispatcher's data-merge order: caller data first,
  // daemon fields last, so a caller cannot hijack routing by passing
  // `reply_target` / `slug` in `data`. The factory's typed `slug`
  // wins over any same-key value in `data`.
  const replyTarget: WikiReplyTarget | undefined =
    input.sourceEvent && isMessageEvent(input.sourceEvent)
      ? {
          platform: input.sourceEvent.platform,
          channel: input.sourceEvent.channel,
          threadId: input.sourceEvent.threadId,
          sender: input.sourceEvent.sender,
        }
      : undefined;
  // `RoutineEvent.routine` is the documented contract on every
  // `routine.*` event (see RoutineEvent in @aitne/shared types.ts). The
  // dispatcher's `isRoutineEvent` branch reads it; omitting the field
  // and relying on the fall-through `executeDefault` would make the
  // `event as RoutineEvent` cast in the dispatcher's executeDefault
  // branch lie about the runtime shape. Strip the `routine.` prefix to
  // match the canonical morning/evening/weekly entries.
  const routineKey = input.processKey.slice("routine.".length);
  const base = createEvent({
    type: input.processKey,
    source: input.sourceEvent ? "browser_history.bang" : "browser_history.cron",
    priority: input.priority ?? EventPriority.NORMAL,
    data: {
      ...(input.data ?? {}),
      slug: input.slug,
      ...(input.sourceEvent
        ? { parent_correlation_id: input.sourceEvent.correlationId }
        : {}),
      ...(replyTarget ? { reply_target: replyTarget } : {}),
    },
  });
  const event: RoutineEvent = { ...base, routine: routineKey };
  return event;
}
