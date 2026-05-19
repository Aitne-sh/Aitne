import type Database from "better-sqlite3";
import {
  INTEGRATION_WRITE_TTL_MS,
  type IntegrationKey,
} from "@aitne/shared";
import { markIntegrationWrite as markIntegrationWritePrimitive } from "../services/integrations/reconcile.js";
import { createLogger } from "../logging.js";

const logger = createLogger("integration-write-tracker");

/**
 * Route-handler facade over the persistent `integration_writes` actor-
 * attribution table (INTEGRATION-DRIFT-DETECTION-PLAN.md §4.2 + §11
 * Phase 4). Wraps the primitive in `services/integrations/reconcile.ts`
 * with two ergonomics every call site needs:
 *
 *  - **Default per-integration TTL** from `INTEGRATION_WRITE_TTL_MS`
 *    (calendar 90 min, gmail 45 min, notion 90 min after the Phase 7 (c)
 *    bump — §17.11 chose these so the mark outlives the slowest
 *    reconcile cadence by ~1.5×; INTEGRATION-DRIFT-PHASE-7-PLAN.md §3.1
 *    walks the math).
 *  - **Default `nowIso = new Date().toISOString()`** so every route
 *    handler does not have to forward a clock argument.
 *
 * The contract is intentionally narrow: the route handler that just
 * mutated upstream calls this once per item id on a 2xx response, and
 * the next reconcile diff inside the TTL window resolves
 * `actor='agent'` for that item. Everything else (initial-snapshot
 * suppression, sliding-window pruning, observation coalescing) lives
 * downstream in reconcile / drift-effects.
 *
 * `AgentWriteTracker` (in-memory, path-keyed) and this table coexist:
 * the in-memory tracker is consulted by file-system / Notion / direct-
 * mode pollers that key by absolute path or `notion:<id>`; the persistent
 * table is consulted by `reconcile()` over `(integration, item_id)`.
 * Phase 4 wires both for direct-mode calendar writes — they target
 * different consumers and the cost is one extra cheap SQL upsert.
 */
export interface MarkIntegrationWriteOptions {
  /** Override the per-integration default. Pass when the caller knows
   *  the next reconcile cadence is unusually long (e.g. a manual one-shot
   *  sync). Falls back to `INTEGRATION_WRITE_TTL_MS[integration]` otherwise. */
  ttlMs?: number;
  /** Override the timestamp recorded as `written_at` / used to compute
   *  `expires_at`. Tests use this for deterministic clock control; route
   *  handlers should never need to. */
  nowIso?: string;
}

/**
 * Mark `(integration, itemId)` as agent-originated for the next
 * `ttlMs` milliseconds (default per-integration). The next reconcile
 * over a window containing `itemId` resolves the diff entry's actor
 * to `'agent'` instead of `'user'`.
 *
 * Idempotent under concurrent writes — `(integration, item_id)` is the
 * primary key and the SQL UPSERTs `written_at` / `expires_at` so the
 * latest call wins.
 *
 * On failure (SQLite error, table missing in a stripped-down test
 * harness), logs at warn and swallows. The route handler that called
 * us has already returned 2xx upstream — losing an attribution mark
 * causes one self-noticed observation, not data loss, and it is
 * strictly preferable to surfacing a 500 to the user.
 */
export function markIntegrationWrite(
  db: Database.Database,
  integration: IntegrationKey,
  itemId: string,
  opts: MarkIntegrationWriteOptions = {},
): void {
  if (typeof itemId !== "string" || itemId.length === 0) {
    logger.debug(
      { integration },
      "markIntegrationWrite skipped: empty itemId",
    );
    return;
  }
  const ttlMs = opts.ttlMs ?? INTEGRATION_WRITE_TTL_MS[integration];
  const nowIso = opts.nowIso ?? new Date().toISOString();
  try {
    markIntegrationWritePrimitive(db, {
      integration,
      itemId,
      ttlMs,
      nowIso,
    });
    logger.debug(
      { integration, itemId, ttlMs },
      "integration write marked",
    );
  } catch (err) {
    logger.warn(
      { err, integration, itemId },
      "failed to mark integration write — next reconcile may attribute as user",
    );
  }
}
