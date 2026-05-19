import { randomUUID } from "node:crypto";
import type { Event } from "@aitne/shared";
import { createWikiCommandEvent } from "./dispatcher.js";

export interface DispatchWikiUrlBatchInput {
  workspace: string;
  urls: readonly string[];
  /** Hard cap for the parallel worker pool. Ignored in serial mode. */
  concurrencyCap: number;
  /** `parallel` fans out up to `concurrencyCap`; `serial` enqueues one at a time. */
  mode: "parallel" | "serial";
  sourceEvent?: Event;
  enqueue: (event: Event) => Promise<void>;
}

export interface DispatchWikiUrlBatchResult {
  batchId: string;
  queued: number;
  mode: "parallel" | "serial";
}

/**
 * Fan out a `!ingest` batch of URLs into one `wiki.ingest_url` event per URL.
 *
 * WIKI_BUILDER_DESIGN.md §3.4 — every URL gets its own session, audit row,
 * and budget envelope. The batch_id grouping (§11.1) lets the dashboard
 * timeline collapse a multi-URL run back into a single user gesture.
 *
 * Modes:
 * - `parallel` (P1 default): a worker pool of `min(concurrencyCap, urls.length)`
 *   pulls from the URL queue. Each `enqueue` returns immediately after the
 *   EventBus accepts the event; the actual agent sessions run independently
 *   inside the dispatcher.
 * - `serial` (added in P2): the enqueue calls happen one after another so
 *   the *submitted order* is the *enqueue order*. We deliberately do NOT
 *   wait for one session to *complete* before enqueuing the next, because
 *   the queue contract is "accept and run".
 *
 *   **Known gap (tracked, not blocking P2)**: full completion-ordered
 *   execution requires a per-process-key semaphore in the dispatcher,
 *   which does not exist today — the dispatcher's only concurrency limit
 *   is the global `maxConcurrentSessions` (default 3). With <=3 URLs the
 *   global semaphore happens to coincide with serial-enough behaviour;
 *   above that, two `wiki.ingest_url` sessions can run in parallel even
 *   when `dispatch_mode='serial'`. The heap-order guarantee from this
 *   function still holds — only the actual session-start spacing is
 *   weaker than the design specifies. A follow-up that adds
 *   per-process-key concurrency caps to `process_backend_config` would
 *   close this gap; this function is already structured to feed that
 *   cap a value of `1` for serial mode.
 *
 * Failure isolation: a thrown error from `enqueue` aborts the rest of the
 * batch in both modes. This matches the existing dispatcher behaviour
 * where a failed enqueue is a daemon-level fault, not a per-URL one.
 */
export async function dispatchWikiUrlBatch(
  input: DispatchWikiUrlBatchInput,
): Promise<DispatchWikiUrlBatchResult> {
  const batchId = randomUUID();
  const urls = [...input.urls];
  if (urls.length === 0) {
    return { batchId, queued: 0, mode: input.mode };
  }

  if (input.mode === "serial") {
    for (const url of urls) {
      await input.enqueue(
        createWikiCommandEvent({
          processKey: "wiki.ingest_url",
          workspace: input.workspace,
          sourceEvent: input.sourceEvent,
          batchId,
          data: { url },
        }),
      );
    }
    return { batchId, queued: urls.length, mode: "serial" };
  }

  const cap = Math.max(1, Math.min(10, Math.floor(input.concurrencyCap)));
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < urls.length) {
      const url = urls[cursor++];
      await input.enqueue(
        createWikiCommandEvent({
          processKey: "wiki.ingest_url",
          workspace: input.workspace,
          sourceEvent: input.sourceEvent,
          batchId,
          data: { url },
        }),
      );
    }
  }

  await Promise.all(Array.from({ length: Math.min(cap, urls.length) }, worker));
  return { batchId, queued: urls.length, mode: "parallel" };
}

