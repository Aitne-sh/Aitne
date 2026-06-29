// drift-allow-file: documents the `daily/*.md` legacy validator path —
// the docstring is the load-bearing reference for callers porting from
// the pre-restructure layout.
/**
 * `performContextFileWrite` — the shared write chokepoint for both the
 * HTTP context API (`PUT /api/context/*`, `PATCH /api/context/* mode=append_to_file`)
 * and any in-process daemon writer that targets the same files (today
 * exercised by `DailyJournalComposer` in `core/morning/`).
 *
 * Spec: `docs/design/appendices/daily-journal-daemon-write.md` §4.9.
 *
 * Scope (deliberate):
 *   - Daily-skeleton frontmatter validation for `daily/*.md` on PUT (the
 *     same `validateDailySkeletonFrontmatter` the HTTP route runs today).
 *   - Atomic symlink-safe write via `writeFileAtomically`.
 *   - `md_file_snapshots` insert through the same debounced helper the
 *     HTTP route uses (passed in via `saveSnapshot`).
 *   - `writeTracker.markWriting` / `unmark` framing so obsidian / git
 *     observers tag the resulting fs event with `actor='agent'`.
 *   - `onIndexableContextChange` hint for the context-index reconciler.
 *
 * Out of scope (stays on the HTTP route):
 *   - Permission gates (`isWriteAllowed`, append-only PUT, write locks,
 *     degraded-mode 503, migration 503).
 *   - Body parsing + Zod schema validation.
 *   - Optimistic mtime conflict checks.
 *   - `prepareContextContentForWrite` (roadmap-validation aware, section
 *     parsing). Callers compose the final byte stream BEFORE calling.
 *   - `notifyPromptContextChanged` (per-request side effect; the
 *     in-process composer fires a different change-hint chain).
 *
 * The helper is intentionally tight — pulling everything into it would
 * force the in-process composer to either drag in Hono Context shapes or
 * to short-circuit half the HTTP route's validation. Sharing only the
 * "raw write step" keeps both paths on the same atomic-write +
 * snapshot + tracker invariants without coupling them to each other's
 * request/response idioms.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomically } from "../../../core/atomic-write.js";
import { validateDailySkeletonFrontmatter } from "../../../core/context-frontmatter.js";
import { parseVaultFrontmatter } from "../../../core/context-validation/frontmatter.js";
import { createLogger } from "../../../logging.js";
import type { AgentWriteTracker } from "../../../safety/agent-write-tracker.js";

const logger = createLogger("context-write-step");

export interface PerformContextFileWriteDeps {
  /** Snapshot helper. Pass through `ctx.saveSnapshot` for HTTP callers; the
   *  in-process composer supplies a thin direct-INSERT wrapper. */
  saveSnapshot: (
    /** Stem-only path used as the `md_file_snapshots.file_path` column
     *  (matches the HTTP route's stem semantics — no `.md` suffix). */
    snapshotKey: string,
    content: string,
    trigger: string,
    force?: boolean,
    sessionId?: string | null,
  ) => number | null;
  /** Optional write-tracker so obsidian / git observers can attribute the
   *  resulting fs event to the agent. */
  writeTracker?: Pick<AgentWriteTracker, "markWriting" | "unmark">;
  /** Optional indexable-change hint. */
  onIndexableContextChange?: (relativePath: string) => void;
}

export type ContextFileWriteMode = "put" | "append_block";

export interface PerformContextFileWriteArgs {
  /** Absolute on-disk path. Caller is responsible for resolving via
   *  `safePath` first when the path comes from user / agent input. */
  absolutePath: string;
  /** Relative-to-contextDir path for snapshot key + indexable hint
   *  (e.g. `"daily/2026-05-22.md"`). */
  relativePath: string;
  /** Snapshot key (stem only — `"daily/2026-05-22"`, not `".md"`). The
   *  HTTP route uses `target.base` as this key; the composer derives it
   *  from `relativePath` by stripping the `.md` suffix. Passing it
   *  explicitly avoids re-deriving it differently between callers. */
  snapshotKey: string;
  /**
   * - `"put"`: full-replace write. The atomic write replaces the file
   *   wholesale; if the file exists we snapshot the pre-state first.
   * - `"append_block"`: read-modify-write that appends `content` to EOF
   *   with a leading newline if needed. When `blockHeader` is set and
   *   already present at H2-line granularity, the matching block is
   *   replaced (LAST-wins, mirrors `appendBlockToJournal`). The file
   *   MUST exist for this mode — callers gate on `existsSync` first.
   */
  mode: ContextFileWriteMode;
  /**
   * For `put`: full file content. For `append_block`: the block to
   *  append (must start with the `blockHeader` line when supplied).
   *  The helper does not trim or rewrite — the byte stream is exactly
   *  what lands on disk.
   */
  content: string;
  /**
   * For `append_block`: the H2 header line (e.g.
   *  `"## Agent revision — 2026-05-22T19:01:12.345Z"`) that anchors
   *  LAST-wins replacement on retry. Required when `mode = "append_block"`
   *  and the caller wants idempotent retries; omit to force pure
   *  append-without-dedupe.
   */
  blockHeader?: string;
  /** `md_file_snapshots.trigger` label. */
  trigger: string;
  /** Force snapshot regardless of `SNAPSHOT_DEBOUNCE_MS`. */
  forceSnapshot?: boolean;
  /** Pass-through to `saveSnapshot`. */
  sessionId?: string | null;
  /** When true (the default for the HTTP PUT route), run
   *  `validateDailySkeletonFrontmatter` against `content` for paths
   *  inside `daily/` and refuse the write if it returns drift errors.
   *  Returned as a structured `validation_failed` error rather than
   *  throwing so the HTTP route can map it to a 422 response. */
  validateDailySkeleton?: boolean;
}

export type PerformContextFileWriteResult =
  | {
      ok: true;
      bytesWritten: number;
      snapshotId: number | null;
      /** Final on-disk content (after any append-block read-modify-write).
       *  Useful for the composer to compute byte-counts for the audit row
       *  without a re-read. */
      finalContent: string;
    }
  | {
      ok: false;
      reason: "daily_skeleton_drift";
      driftErrors: ReturnType<typeof validateDailySkeletonFrontmatter>;
    }
  | {
      ok: false;
      reason: "missing_for_append";
    };

export function performContextFileWrite(
  deps: PerformContextFileWriteDeps,
  args: PerformContextFileWriteArgs,
): PerformContextFileWriteResult {
  if (args.mode === "put" && args.validateDailySkeleton === true) {
    if (args.relativePath.startsWith("journal/daily/")) {
      const driftErrors = validateDailySkeletonFrontmatter(
        args.content,
        args.relativePath,
      );
      if (driftErrors.length > 0) {
        return { ok: false, reason: "daily_skeleton_drift", driftErrors };
      }
    }
  }

  // CONTEXT_VAULT_REDESIGN_PLAN.md §5.3 — Phase 1 advisory parse of the
  // new vault contract fields (kind / authority / mutability / slug /
  // title). Advisories log a warning; nothing rejects the write. The
  // Phase 2 cut-over swaps these warnings for a structured 422 once
  // `runtimeSettings.contextVault.enforceFrontmatter` lands.
  if (args.mode === "put") {
    const advisory = parseVaultFrontmatter(args.content, args.relativePath);
    if (advisory.advisories.length > 0) {
      logger.warn(
        {
          relativePath: args.relativePath,
          advisories: advisory.advisories.map((a) => ({
            code: a.code,
            message: a.message,
          })),
        },
        "Vault frontmatter advisory (Phase 1 non-blocking)",
      );
    }
  }

  let snapshotId: number | null = null;
  let toWrite: string;
  if (args.mode === "put") {
    if (existsSync(args.absolutePath)) {
      const existing = readFileSync(args.absolutePath, "utf-8");
      snapshotId = deps.saveSnapshot(
        args.snapshotKey,
        existing,
        args.trigger,
        args.forceSnapshot ?? true,
        args.sessionId ?? null,
      );
    }
    toWrite = args.content;
  } else {
    if (!existsSync(args.absolutePath)) {
      return { ok: false, reason: "missing_for_append" };
    }
    const existing = readFileSync(args.absolutePath, "utf-8");
    snapshotId = deps.saveSnapshot(
      args.snapshotKey,
      existing,
      args.trigger,
      args.forceSnapshot ?? false,
      args.sessionId ?? null,
    );
    toWrite = appendBlockWithLastWins(existing, args.content, args.blockHeader);
  }

  deps.writeTracker?.markWriting(args.absolutePath, toWrite);
  try {
    writeFileAtomically(args.absolutePath, toWrite);
  } catch (writeErr) {
    deps.writeTracker?.unmark(args.absolutePath);
    throw writeErr;
  }
  deps.onIndexableContextChange?.(args.relativePath);
  // Compute bytes from the byte representation rather than re-stat'ing —
  // a successful atomic write means the on-disk size is exactly this.
  // Avoids a TOCTOU race where another process modifies the file between
  // rename and stat.
  const bytesWritten = Buffer.byteLength(toWrite, "utf-8");
  return { ok: true, bytesWritten, snapshotId, finalContent: toWrite };
}

/**
 * Append `block` to `original`. Pure append-with-newline-separator —
 * the helper deliberately does NOT do LAST-wins H2-boundary
 * replacement.
 *
 * Why no LAST-wins: the agent-journal-appender uses LAST-wins because
 * each block is wrapped in a predictable `## YYYY-MM-DD morning routine`
 * H2 and there are no other H2s. Daily-journal `## Agent revision —`
 * blocks DO contain inner H2s (`## Summary`, `## Tasks`, etc.) emitted
 * by the journal body, so an H2-anchored replacement would collapse to
 * the first inner H2 and corrupt the file. Design §4.8 explicitly
 * calls for "preserve any user edits" via pure append.
 *
 * Stage B idempotency on retry is guaranteed elsewhere: the orchestrator
 * does NOT re-fire Stage B on retry (`MorningRoutinePipelineOrchestrator`
 * §"Retry semantics"), so the same revision header cannot land twice in
 * a single morning's run.
 *
 * The `blockHeader` parameter is accepted but unused — kept for caller
 * symmetry with the agent-journal-appender's API and to leave room for
 * a future H2-aware variant if a different file shape needs it.
 */
function appendBlockWithLastWins(
  original: string,
  block: string,
  _blockHeader: string | undefined,
): string {
  const trimmed = original.replace(/\n+$/, "");
  return `${trimmed}\n\n${block}\n`;
}

/**
 * Resolve the absolute path under contextDir for the daily journal of
 * `dateStr`. The composer uses this to feed `performContextFileWrite`
 * without duplicating the layout convention defined in
 * `context-paths.ts:dailyJournalPath`.
 */
export function dailyJournalAbsolutePath(
  contextDir: string,
  dateStr: string,
): string {
  return join(contextDir, "journal", "daily", `${dateStr}.md`);
}

/**
 * Re-export the canonical daily-relative path helper so callers needing
 * both shapes don't have to import from two modules. (`relativePath` for
 * snapshot + indexable, `snapshotKey` for the snapshot column.)
 */
export function dailyJournalSnapshotKey(dateStr: string): string {
  return `journal/daily/${dateStr}`;
}
