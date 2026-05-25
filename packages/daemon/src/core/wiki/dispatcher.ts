import {
  EventPriority,
  createEvent,
  isMessageEvent,
  wikiReplyTargetSchema,
  type Event,
  type WikiProcessKey,
  type WikiReplyTarget,
} from "@aitne/shared";

export interface WikiCommandEventInput {
  processKey: WikiProcessKey;
  workspace: string;
  sourceEvent?: Event;
  batchId?: string;
  data?: Record<string, unknown>;
}

export function createWikiCommandEvent(input: WikiCommandEventInput): Event {
  // WIKI_BUILDER_DESIGN.md §3.4 — derive the reply routing tuple from the
  // originating MessageEvent so the per-URL completion DMs from
  // wiki.ingest_url (and the answer/report/log DMs from the other wiki
  // process keys) land back on the same channel the operator used to
  // run the bang command. When the source is not a MessageEvent
  // (currently unreachable — wiki events spawn only from `!ingest` /
  // `!compile` / `!ask` / ... which are all DMs — but future routine
  // entry points might exist), `reply_target` is omitted and the
  // ResultProcessor falls back to the user's configured destinations
  // via `MessageHub.sendToUser`.
  const replyTarget: WikiReplyTarget | undefined =
    input.sourceEvent && isMessageEvent(input.sourceEvent)
      ? {
          platform: input.sourceEvent.platform,
          channel: input.sourceEvent.channel,
          threadId: input.sourceEvent.threadId,
          sender: input.sourceEvent.sender,
        }
      : undefined;
  // Spread order matters: `input.data` is caller-supplied (the bang
  // handler's per-key payload like `{ url }` for ingest_url or
  // `{ topic }` for trace) and MUST NOT be allowed to override
  // daemon-controlled routing/audit fields. A bang handler that
  // accidentally (or maliciously, in a future plugin surface) put
  // `reply_target` or `batch_id` in `data` would otherwise hijack the
  // event. Daemon fields therefore come AFTER `input.data` so they
  // win the spread conflict.
  return createEvent({
    type: input.processKey,
    source: "wiki.bang",
    priority: EventPriority.HIGH,
    data: {
      ...(input.data ?? {}),
      workspace: input.workspace,
      ...(input.batchId ? { batch_id: input.batchId } : {}),
      ...(input.sourceEvent ? { parent_correlation_id: input.sourceEvent.correlationId } : {}),
      ...(replyTarget ? { reply_target: replyTarget } : {}),
    },
  });
}

/**
 * Pure helper — read the reply-routing tuple stored on `event.data.reply_target`.
 *
 * Despite the `WikiReplyTarget` type name (kept for historical reasons —
 * the schema first shipped with the wiki subsystem), the helper is
 * type-agnostic: it reads the same `data.reply_target` field that
 * `createWikiCommandEvent` puts on wiki.* events AND that `scheduler.ts`
 * lifts onto `scheduled.task` events from approval rows
 * (WIKI_BUILDER_DESIGN.md §3.4-bis). Callers in `ResultProcessor` use it
 * to decide between direct reply (`NotificationManager.send({ replyTo })`)
 * and proactive fan-out to the user's primary destinations.
 *
 * Returns null when:
 *   - the event has no `data.reply_target` field (cron/routine event,
 *     or wiki event minted without a sourceEvent), or
 *   - the field shape is corrupt (defensive — a daemon downgrade reading
 *     a payload from a future schema version).
 */
export function readEventReplyTarget(event: Event): WikiReplyTarget | null {
  const raw = (event.data as { reply_target?: unknown } | undefined)?.reply_target;
  if (!raw) return null;
  const parsed = wikiReplyTargetSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

