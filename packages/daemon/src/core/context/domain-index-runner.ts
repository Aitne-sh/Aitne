import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { DOMAINS, type Domain } from "@aitne/shared";
import { localDateStr } from "@aitne/shared";
import { writeRuntimeState, getDegradedMode } from "../../db/runtime-state.js";
import type { AgentWriteTracker } from "../../safety/agent-write-tracker.js";
import { writeFileAtomically } from "../atomic-write.js";
import type { PromptContextChangedCallback } from "../context-staleness.js";
import { createLogger } from "../../logging.js";
import type {
  ReconcilerRunRecord,
  ReconcilerTrigger,
} from "./reconciler-runner.js";
import {
  bucketByDomain,
  relativeDomainIndexPath,
  renderDomainIndex,
  type DomainIndexEntityInput,
} from "./domain-index-reconciler.js";

const logger = createLogger("domain-index-reconciler");

/** Runtime-state key for the domain-index reconciler's last run record. */
export const DOMAIN_INDEX_RECONCILER_LAST_RUN_KEY =
  "reconciler.domain_index.last_run";

/**
 * Per-process mutex. The runner does not need to coordinate with other
 * reconcilers' write paths — each rebuilds an isolated set of files —
 * but two concurrent driver invocations could race on the same domain
 * file. Mirrors `policy-index-runner.ts` exactly.
 */
let runnerMutex: Promise<void> = Promise.resolve();

export interface RunDomainIndexReconcilerOptions {
  db: Database.Database;
  contextDir: string;
  writeTracker?: AgentWriteTracker;
  onPromptContextChanged?: PromptContextChangedCallback;
  timezone?: string;
  trigger: ReconcilerTrigger;
  /** Injectable clock for deterministic test output. */
  now?: () => Date;
}

/**
 * Drive one pass of the domain-index reconciler:
 *
 *   1. Early-exit when degraded mode is active.
 *   2. Read the `entities` table + `entity_source_keys` sidecar to build
 *      the per-domain bucket snapshot.
 *   3. Render each domain's `_index.md` body deterministically.
 *   4. Compare against on-disk content; skip the write when bytes match.
 *   5. Atomic write + agent-write-tracker mark + snapshot the prior
 *      contents into `md_file_snapshots`.
 *   6. Persist a single `runtime_state` row regardless of outcome.
 *
 * The numeric slots in `ReconcilerRunRecord` are repurposed:
 *   - `added`           → number of files the runner wrote this pass
 *   - `removed`         → 0 (domain index files are never removed)
 *   - `refreshedMtime`  → number of files that already matched on disk
 */
export async function runDomainIndexReconciler(
  opts: RunDomainIndexReconcilerOptions,
): Promise<ReconcilerRunRecord> {
  const prev = runnerMutex;
  let releaseMutex!: () => void;
  runnerMutex = new Promise<void>((resolve) => {
    releaseMutex = resolve;
  });
  try {
    await prev;
    return await runOnce(opts);
  } finally {
    releaseMutex();
  }
}

async function runOnce(
  opts: RunDomainIndexReconcilerOptions,
): Promise<ReconcilerRunRecord> {
  const now = opts.now ? opts.now() : new Date();
  const today = localDateStr(now, opts.timezone || undefined);
  const updated = now.toISOString();
  const recordBase = {
    at: now.toISOString(),
    trigger: opts.trigger,
    added: 0,
    removed: 0,
    refreshedMtime: 0,
  };

  const degraded = getDegradedMode(opts.db);
  if (degraded) {
    const record: ReconcilerRunRecord = {
      ...recordBase,
      result: "noop",
      error: `degraded_mode:${degraded.reason}`,
    };
    persistRunRecord(opts.db, record);
    return record;
  }

  try {
    const entities = loadEntitiesForDomainIndex(opts.db);
    const buckets = bucketByDomain(entities);

    let written = 0;
    let unchanged = 0;
    for (const domain of DOMAINS) {
      const list = buckets.byDomain.get(domain) ?? [];
      // Skip rendering when the domain is empty AND no file exists yet.
      // Forcing an empty placeholder file on day one creates noise; we
      // wait for the first entity to be created before materialising
      // the index.
      const relativePath = relativeDomainIndexPath(domain);
      const absolutePath = join(opts.contextDir, relativePath);
      const previous = readIfExists(absolutePath);
      if (list.length === 0 && previous === null) continue;

      const body = renderDomainIndex(domain, list, updated);
      // Compare the body excluding the `last_built:` line so two
      // wall-clock-different runs with identical data don't churn the
      // file. Without this, every cron / fs-event chain rewrites every
      // domain index, growing `md_file_snapshots` and firing
      // `onPromptContextChanged` for nothing.
      if (previous !== null && stripLastBuilt(previous) === stripLastBuilt(body)) {
        unchanged += 1;
        continue;
      }
      writeWithSnapshot(opts, absolutePath, relativePath, body, previous);
      opts.onPromptContextChanged?.(
        relativePath,
        "domain_index_reconciler",
        "quiet",
        { tierReason: "derived_domain_index" },
      );
      written += 1;
    }

    const record: ReconcilerRunRecord = {
      ...recordBase,
      result: written === 0 ? "noop" : "applied",
      error: null,
      added: written,
      removed: 0,
      refreshedMtime: unchanged,
    };
    persistRunRecord(opts.db, record);
    if (written > 0) {
      logger.info(
        { trigger: opts.trigger, written, unchanged, today },
        "Domain-index reconciler applied",
      );
    }
    return record;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const record: ReconcilerRunRecord = {
      ...recordBase,
      result: "error",
      error: message.slice(0, 200),
    };
    persistRunRecord(opts.db, record);
    logger.error({ err, trigger: opts.trigger }, "Domain-index reconciler run failed");
    return record;
  }
}

interface EntityRowForRender {
  path: string;
  domain: string;
  type: string;
  title: string;
  status: string | null;
  date: string | null;
  lastSyncedAt: string | null;
  sourceKeys: string;
}

/**
 * Load every mirror row joined with its sidecar source-key set. The
 * `group_concat` returns NULL when no source keys exist; the caller
 * normalises to an empty array. Sorted at the SQL level so the bucket
 * order is reproducible across calls.
 */
function loadEntitiesForDomainIndex(
  db: Database.Database,
): DomainIndexEntityInput[] {
  const rows = db
    .prepare(
      `SELECT e.path, e.domain, e.type, e.title, e.status, e.date,
              e.last_synced_at AS lastSyncedAt,
              (SELECT group_concat(k.source_key, ',')
                 FROM (SELECT source_key
                         FROM entity_source_keys
                        WHERE path = e.path
                     ORDER BY source_key ASC) k) AS sourceKeys
         FROM entities e
        ORDER BY e.path ASC`,
    )
    .all() as EntityRowForRender[];

  const out: DomainIndexEntityInput[] = [];
  for (const row of rows) {
    if (!isKnownDomain(row.domain)) continue;
    if (!isKnownType(row.type)) continue;
    const sourceKeys = row.sourceKeys
      ? row.sourceKeys.split(",").filter((k) => k.length > 0)
      : [];
    out.push({
      path: row.path,
      domain: row.domain as Domain,
      type: row.type as DomainIndexEntityInput["type"],
      title: row.title,
      status: row.status,
      date: row.date,
      lastSyncedAt: row.lastSyncedAt,
      sourceKeys,
    });
  }
  return out;
}

function isKnownDomain(value: string): boolean {
  return (DOMAINS as readonly string[]).includes(value);
}

const KNOWN_TYPES = new Set([
  "meeting",
  "trip",
  "receipt",
  "project",
  "book",
  "note",
]);

function isKnownType(value: string): boolean {
  return KNOWN_TYPES.has(value);
}

/**
 * Replace the `last_built: <iso>` line with a stable sentinel so two
 * renders with identical data but different wall-clocks compare equal.
 * The renderer's other output is byte-deterministic for a given
 * snapshot, so this is the only varying line.
 */
function stripLastBuilt(content: string): string {
  return content.replace(/^last_built: .*$/m, "last_built: <stable>");
}

function readIfExists(absolutePath: string): string | null {
  if (!existsSync(absolutePath)) return null;
  try {
    return readFileSync(absolutePath, "utf-8");
  } catch (err) {
    logger.warn({ err, file: absolutePath }, "Reconciler could not read file");
    return null;
  }
}

function writeWithSnapshot(
  opts: RunDomainIndexReconcilerOptions,
  absolutePath: string,
  relativePath: string,
  content: string,
  previousContent: string | null,
): void {
  if (previousContent !== null) {
    try {
      opts.db
        .prepare(
          "INSERT INTO md_file_snapshots (file_path, content, trigger, session_id) VALUES (?, ?, ?, ?)",
        )
        .run(relativePath, previousContent, "domain_index_reconciled", null);
    } catch (err) {
      logger.warn(
        { err, file: relativePath },
        "Failed to snapshot prior content before domain-index write",
      );
    }
  }
  // Mark before the rename so FS-watch consumers attribute the resulting
  // event to the agent. Roll back on failure (C2).
  opts.writeTracker?.markWriting(absolutePath, content);
  try {
    writeFileAtomically(absolutePath, content);
  } catch (writeErr) {
    opts.writeTracker?.unmark(absolutePath);
    throw writeErr;
  }
}

function persistRunRecord(
  db: Database.Database,
  record: ReconcilerRunRecord,
): void {
  try {
    writeRuntimeState(db, DOMAIN_INDEX_RECONCILER_LAST_RUN_KEY, record);
  } catch (err) {
    logger.warn(
      { err, record },
      "Domain-index reconciler run record persistence failed",
    );
  }
}
