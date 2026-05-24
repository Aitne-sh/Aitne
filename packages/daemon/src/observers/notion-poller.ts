import type Database from "better-sqlite3";
import type { PageObjectResponse } from "@notionhq/client";
import { recordObservation } from "../db/observations.js";
import { readRuntimeState, writeRuntimeState } from "../db/runtime-state.js";
import type { Observer } from "./manager.js";
import type { NotionService } from "../services/notion.js";
import type { AgentWriteTracker } from "../safety/agent-write-tracker.js";
import { createLogger } from "../logging.js";
import { PollGuard } from "./poll-guard.js";

const logger = createLogger("notion-poller");

/**
 * Wall-clock cap per tick. Notion's `dataSources.query` round-trip is
 * normally 0.5-3s per page; with the per-call `MAX_PAGES` cap inside
 * `NotionService.queryUpdatedSince` we walk at most 50 pages × 2 passes
 * (active + trashed) × N databases. A 4-minute cap absorbs API slowness
 * on a long cursor without letting one tick block the next interval.
 * Combined with PollGuard's overlap guard this prevents both unbounded
 * tick concurrency and silent hangs.
 */
const TICK_TIMEOUT_MS = 4 * 60 * 1000;

export interface NotionPollerOptions {
  notionService: NotionService;
  databaseIds: Record<string, string>; // { "tasks": "xxx-xxx", ... }
  pollIntervalSeconds: number;
  db: Database.Database;
  writeTracker?: AgentWriteTracker;
}

/** Shape of the persisted-per-database poll cursor. */
interface PollCursor {
  /** Latest `last_edited_time` we've already observed (ISO string). */
  lastEditedTime: string;
  /** Page IDs currently known to be in-trash so we don't re-emit delete obs. */
  trashedIds: string[];
}

function runtimeStateKey(databaseId: string): string {
  return `notion-poller:cursor:${databaseId}`;
}

/**
 * Upper bound on the `trashedIds` list held in runtime_state per
 * database. Without this the list grows monotonically as pages are
 * trashed, making every poll's JSON serialize/deserialize cycle
 * slower. When the cap is exceeded we drop the *oldest* entries
 * (FIFO — Set iteration order preserves insertion), which means a
 * very old trashed page that gets modified years later would be
 * re-emitted as `deleted` once. That's an acceptable rarity.
 */
const MAX_TRASHED_IDS = 1000;

/**
 * NotionPoller — polls Notion data sources for changes via NotionService.
 *
 * - Paginates through `has_more`/`next_cursor` so large batches don't drop rows
 * - Persists `lastEditedTime` + trashed-IDs in `runtime_state` across restarts
 *   (daemon downtime no longer silently discards changes)
 * - Queries `in_trash: true` as a second pass to detect archive transitions
 *   and records them as `change_type: 'deleted'`
 * - Consults `AgentWriteTracker` so pages the daemon API just wrote are
 *   attributed to `actor='agent'` instead of triggering another hourly loop
 */
export class NotionPoller implements Observer {
  readonly name = "notion-poller";

  private readonly notionService: NotionService;
  private readonly databaseIds: Record<string, string>;
  private readonly pollIntervalMs: number;
  private readonly db: Database.Database;
  private readonly writeTracker?: AgentWriteTracker;

  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly guard = new PollGuard({
    name: "notion-poller",
    tickTimeoutMs: TICK_TIMEOUT_MS,
  });

  constructor(opts: NotionPollerOptions) {
    this.notionService = opts.notionService;
    this.databaseIds = opts.databaseIds;
    this.pollIntervalMs = opts.pollIntervalSeconds * 1000;
    this.db = opts.db;
    this.writeTracker = opts.writeTracker;
  }

  async start(): Promise<void> {
    if (!this.notionService.available) {
      logger.warn("NotionService unavailable — poller will stay idle");
      return;
    }

    // Seed cursors for databases we've never polled so we don't replay
    // the entire history on first run.
    const nowIso = new Date().toISOString();
    for (const databaseId of Object.values(this.databaseIds)) {
      if (!readRuntimeState<PollCursor>(this.db, runtimeStateKey(databaseId))) {
        writeRuntimeState(this.db, runtimeStateKey(databaseId), {
          lastEditedTime: nowIso,
          trashedIds: [],
        });
      }
    }

    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);

    logger.info(
      {
        databases: Object.keys(this.databaseIds),
        intervalMs: this.pollIntervalMs,
      },
      "Notion poller started",
    );
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.guard.abortInFlight(new Error("notion_poller_stopped"));
    logger.info("Notion poller stopped");
  }

  private async tick(): Promise<void> {
    try {
      await this.guard.run((signal) => this.pollAll(signal));
    } catch (err) {
      logger.error({ err }, "Notion poll tick failed");
    }
  }

  private async pollAll(signal: AbortSignal): Promise<void> {
    for (const [label, dbId] of Object.entries(this.databaseIds)) {
      if (signal.aborted) return;
      try {
        await this.pollDatabase(label, dbId, signal);
      } catch (err) {
        logger.error({ err, database: label }, "Notion poll failed");
      }
    }
  }

  /** Poll one data source: active pages (by last_edited_time), then trashed pages. */
  private async pollDatabase(
    label: string,
    databaseId: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.notionService.available) return;

    const cursor = readRuntimeState<PollCursor>(
      this.db,
      runtimeStateKey(databaseId),
    ) ?? { lastEditedTime: new Date().toISOString(), trashedIds: [] };

    let newestSeen = cursor.lastEditedTime;
    // Cumulative trashed set: seed from prior cursor, add new archivals
    // in pass 2, subtract restores detected in pass 1. Keeping it
    // cumulative prevents a re-emit of `deleted` when a stale trashed
    // page drops out of the in_trash-delta window on the next poll.
    const trashed = new Set(cursor.trashedIds);

    // Pass 1: active pages updated since the last cursor.
    // `signal` is threaded into `queryUpdatedSince` so PollGuard's
    // tick-timeout (or observer stop) terminates the inner pagination
    // promptly instead of waiting for the Notion SDK to wind down.
    for await (const page of this.notionService.queryUpdatedSince(
      databaseId,
      cursor.lastEditedTime,
      { signal },
    )) {
      this.recordPageObservation(label, databaseId, page, "modified");
      // If a previously-trashed page now appears in the active query,
      // it has been restored. The `modified` observation above is
      // sufficient; we just drop it from the trashed set.
      trashed.delete(page.id);
      if (page.last_edited_time > newestSeen) {
        newestSeen = page.last_edited_time;
      }
    }

    if (signal.aborted) {
      // Persist whatever we made progress on before the abort so the
      // next tick resumes from `newestSeen`, not the old cursor.
      writeRuntimeState(this.db, runtimeStateKey(databaseId), {
        lastEditedTime: newestSeen,
        trashedIds: Array.from(trashed),
      } satisfies PollCursor);
      return;
    }

    // Pass 2: in_trash pages updated since last cursor — detect archive
    // transitions. Only emit `deleted` for pages we haven't already
    // flagged as trashed.
    for await (const page of this.notionService.queryUpdatedSince(
      databaseId,
      cursor.lastEditedTime,
      { inTrash: true, signal },
    )) {
      if (!trashed.has(page.id)) {
        this.recordPageObservation(label, databaseId, page, "deleted");
        trashed.add(page.id);
      }
      if (page.last_edited_time > newestSeen) {
        newestSeen = page.last_edited_time;
      }
    }

    // FIFO-cap the trashed set so the cursor JSON stays bounded. Set
    // iteration preserves insertion order, so slicing from the end
    // keeps the most-recently-added entries.
    const trashedArray = Array.from(trashed);
    const boundedTrashed =
      trashedArray.length > MAX_TRASHED_IDS
        ? trashedArray.slice(trashedArray.length - MAX_TRASHED_IDS)
        : trashedArray;

    writeRuntimeState(this.db, runtimeStateKey(databaseId), {
      lastEditedTime: newestSeen,
      trashedIds: boundedTrashed,
    } satisfies PollCursor);
  }

  private recordPageObservation(
    label: string,
    databaseId: string,
    page: PageObjectResponse,
    changeType: "modified" | "deleted",
  ): void {
    const actor = this.writeTracker?.isMarked(`notion:${page.id}`, null)
      ? "agent"
      : "user";

    recordObservation(this.db, {
      source: `notion:${databaseId}`,
      ref: page.id,
      changeType,
      actor,
      payload: {
        notionPageId: page.id,
        notionDatabaseId: databaseId,
        databaseLabel: label,
        pageTitle: extractTitle(page),
        lastEditedTime: page.last_edited_time,
        url: page.url ?? null,
        inTrash: Boolean(page.in_trash ?? page.archived),
        propertySummary: extractPropertySummary(page),
      },
    });
  }
}

/** Extract the title from a Notion page's properties. */
function extractTitle(page: PageObjectResponse): string {
  const props = page.properties as Record<string, Record<string, unknown>>;
  if (!props) return "(untitled)";

  for (const prop of Object.values(props)) {
    if (prop.type === "title") {
      const titleArr = prop.title as Array<{ plain_text: string }> | undefined;
      if (titleArr && titleArr.length > 0) {
        return titleArr.map((t) => t.plain_text).join("");
      }
    }
  }
  return "(untitled)";
}

/** Short human-readable summary of status/select/date properties. */
export function extractPropertySummary(page: {
  properties?: Record<string, Record<string, unknown>>;
}): string {
  const props = page.properties;
  if (!props) return "";
  const parts: string[] = [];
  for (const [name, prop] of Object.entries(props)) {
    if (prop.type === "status" && prop.status)
      parts.push(`${name}: ${(prop.status as { name: string }).name}`);
    else if (prop.type === "select" && prop.select)
      parts.push(`${name}: ${(prop.select as { name: string }).name}`);
    else if (prop.type === "date" && prop.date)
      parts.push(`${name}: ${(prop.date as { start: string }).start}`);
  }
  return parts.join(", ");
}
