/**
 * `DailyJournalComposer` — Stage B reliability fix per
 * `docs/design/appendices/daily-journal-daemon-write.md` rev1.
 *
 * Before this module, Stage B (`routine.morning_routine_journal`, Haiku
 * 4.5 lite tier) was specified to author yesterday's daily journal AND
 * PUT it to `/api/context/daily/<yesterday>.md`. Haiku failed at the
 * curl PUT step 4 out of 5 recent runs (`cat > /tmp/...` denials it
 * didn't recover from). The fix decouples creative authoring (LLM) from
 * mechanical I/O (daemon):
 *
 *   - Stage B emits its body + frontmatter facts as two XML-tagged
 *     blocks (`<aitne:daily-journal-body>` /
 *     `<aitne:daily-journal-frontmatter>`) in its final assistant text
 *     — no tool calls.
 *   - This module extracts both blocks, composes the final
 *     `daily/<date>.md` content with skeleton-owned frontmatter, and
 *     writes it through `performContextFileWrite` — same atomic +
 *     snapshot + writeTracker invariants the HTTP route uses.
 *
 * Three-state result discriminant (`ok: "complete" | "partial" | false`)
 * surfaces partial extracts as a first-class outcome rather than
 * folding them into success: when the body extracts but frontmatter
 * does not, the diary content lands on disk but the wiki link graph
 * for that day is degraded, and the appender bolds "partial — …" so
 * weekly review can spot the regression.
 *
 * Tag boundary rules — kept intentionally strict, see design §4.4.
 * LAST-wins selection + `aitne:` namespace prefix make body
 * collisions (the user quotes the literal token while documenting
 * Aitne itself) safe.
 */

import { existsSync } from "node:fs";
import type Database from "better-sqlite3";
import { z } from "zod";

import type { AgentWriteTracker } from "../../safety/agent-write-tracker.js";
import type { AgentResult } from "@aitne/shared";
import { createLogger } from "../../logging.js";
import {
  performContextFileWrite,
  dailyJournalAbsolutePath,
  dailyJournalSnapshotKey,
} from "../../api/routes/context/write-step.js";
import { dailyJournalPath } from "../context-paths.js";
import type { JournalSkeletonInputs } from "./journal-skeleton-builder.js";

const logger = createLogger("daily-journal-composer");

/** Tag names — see design §4.4 for the namespace rationale. */
const BODY_TAG = "aitne:daily-journal-body";
const FRONTMATTER_TAG = "aitne:daily-journal-frontmatter";

const SNAPSHOT_TRIGGER = "daily_journal_composer";

/**
 * Zod schema for the LLM-supplied frontmatter block. Three optional
 * string arrays (projects / people / tags) — anything else the LLM
 * provides is silently dropped (Zod's default strip) per design §4.6.
 *
 * `.default([])` lets the LLM omit a field entirely; absent → empty
 * array. An empty array is a legitimate value (the user mentioned no
 * people that day). Empty strings inside the array are dropped at
 * compose time before YAML serialisation.
 */
export const JournalFrontmatterSchema = z.object({
  projects: z.array(z.string()).default([]),
  people: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
});

export type JournalFrontmatter = z.infer<typeof JournalFrontmatterSchema>;

/** Recoverable — the body was extracted and IS on disk, but the
 *  frontmatter projects/people/tags arrays are empty. */
export type PartialExtractReason =
  | "frontmatter_tag_missing"
  | "frontmatter_invalid_json"
  | "frontmatter_schema_invalid";

/** Terminal — no daily file was written. */
export type ExtractionFailureReason =
  | "stage_b_null"
  | "empty_output"
  | "body_tag_missing"
  | "write_failed";

export type JournalParseError = ExtractionFailureReason | PartialExtractReason;

export interface ExtractJournalSectionsResult {
  body: string | null;
  frontmatter: JournalFrontmatter | null;
  parseError: JournalParseError | null;
}

export type DailyJournalComposeMode = "put" | "append_revision";

export type DailyJournalComposeResult =
  | {
      ok: "complete";
      bytesWritten: number;
      wroteMode: DailyJournalComposeMode;
    }
  | {
      ok: "partial";
      bytesWritten: number;
      wroteMode: DailyJournalComposeMode;
      partialReason: PartialExtractReason;
    }
  | { ok: false; reason: ExtractionFailureReason };

// ── Pure extractor ───────────────────────────────────────────────────

/**
 * Walk `output` and return the body + frontmatter blocks the LLM
 * emitted. Pure — every output byte is a deterministic function of the
 * input. Exposed for unit tests so the extraction branches can be
 * pinned without the fs / DB harness.
 *
 * Boundary rules per design §4.4:
 *   - Opening / closing tags are matched on their own line (with
 *     optional surrounding whitespace).
 *   - Content between the tags is the literal byte stream — no escape
 *     processing.
 *   - When multiple openings appear, the LAST matched pair wins. The
 *     `aitne:` namespace + the "wrappers AT THE END of your output"
 *     task-flow instruction give two layers of collision defence.
 *   - Code-fence wrapping around tags (` ```xml\n<aitne:...>\n```` `)
 *     is tolerated — fences are stripped before parsing.
 */
export function extractJournalSections(
  output: string | null | undefined,
): ExtractJournalSectionsResult {
  const trimmed = (output ?? "").trim();
  if (trimmed.length === 0) {
    return { body: null, frontmatter: null, parseError: "empty_output" };
  }

  const body = extractLastTaggedBlock(trimmed, BODY_TAG);
  // Treat a missing tag and a tag-with-empty-inner-content as the same
  // terminal failure. Without this, `<aitne:daily-journal-body>\n\n
  // </aitne:daily-journal-body>` would land an empty diary file with
  // valid frontmatter — a phantom user-facing day worse than the honest
  // "failed (LLM output empty)" surface (the appender renders the latter
  // via `formatFailureReason("body_tag_missing")`, so the file-on-disk
  // path stays empty, no degraded data).
  if (body === null || body.trim().length === 0) {
    return { body: null, frontmatter: null, parseError: "body_tag_missing" };
  }

  const fmRaw = extractLastTaggedBlock(trimmed, FRONTMATTER_TAG);
  if (fmRaw === null) {
    return { body, frontmatter: null, parseError: "frontmatter_tag_missing" };
  }

  const fmStripped = stripCodeFence(fmRaw).trim();

  let fmParsed: unknown;
  try {
    fmParsed = JSON.parse(fmStripped);
  } catch {
    return { body, frontmatter: null, parseError: "frontmatter_invalid_json" };
  }

  const result = JournalFrontmatterSchema.safeParse(fmParsed);
  if (!result.success) {
    return { body, frontmatter: null, parseError: "frontmatter_schema_invalid" };
  }
  return { body, frontmatter: result.data, parseError: null };
}

/**
 * Locate the LAST `<tagName>...</tagName>` pair in `body` (per the
 * collision-resistance policy above) and return the inner bytes.
 *
 * `<tagName>` and `</tagName>` must each be on their own line (optional
 * surrounding whitespace allowed). The returned string is the literal
 * byte stream between them — leading/trailing newlines stripped to
 * match the YAML / markdown idiom (`<tag>\n<content>\n</tag>` should
 * yield `<content>`, not `\n<content>\n`).
 *
 * Tolerates a code-fence wrapper around either tag (`\`\`\`xml\n<tag>`),
 * which Haiku is known to emit when prompted with structured output
 * instructions. The fence-strip is line-local — only fence lines
 * immediately adjacent to the tag line are stripped.
 */
export function extractLastTaggedBlock(
  body: string,
  tagName: string,
): string | null {
  const openPattern = new RegExp(
    `^[ \\t]*<${escapeRegex(tagName)}>[ \\t]*$`,
  );
  const closePattern = new RegExp(
    `^[ \\t]*</${escapeRegex(tagName)}>[ \\t]*$`,
  );
  const lines = body.split(/\r?\n/);

  // Find every open / close index. The matching pair is the LAST close
  // whose paired open is the most-recent open BEFORE it. Walking from
  // the tail picks the genuine wrapper-at-EOF even when the body's
  // user-voice prose quoted the literal token earlier in the output.
  let lastClose = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (closePattern.test(lines[i])) {
      lastClose = i;
      break;
    }
  }
  if (lastClose < 0) return null;

  let lastOpen = -1;
  for (let i = lastClose - 1; i >= 0; i--) {
    if (openPattern.test(lines[i])) {
      lastOpen = i;
      break;
    }
  }
  if (lastOpen < 0) return null;

  const inner = lines.slice(lastOpen + 1, lastClose).join("\n");
  // Strip a code-fence wrapper if Haiku decorated the block with one.
  // The strip is conservative: only fence lines directly adjacent to
  // the tag survive removal so quoted code fences inside the body
  // (which `policies/journal-format.md` allows) are left untouched.
  return stripCodeFence(inner);
}

function stripCodeFence(value: string): string {
  let stripped = value;
  const leading = /^[ \t]*```(?:[a-zA-Z0-9_-]+)?[ \t]*\n/;
  const trailing = /\n[ \t]*```[ \t]*$/;
  if (leading.test(stripped)) {
    stripped = stripped.replace(leading, "");
  }
  if (trailing.test(stripped)) {
    stripped = stripped.replace(trailing, "");
  }
  return stripped;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Pure composer ────────────────────────────────────────────────────

/**
 * Compose the final `daily/<date>.md` byte stream from the skeleton-owned
 * frontmatter facts + the LLM-supplied frontmatter fields + the
 * LLM-supplied body. Pure — every output byte is a deterministic
 * function of the inputs.
 *
 * YAML serialisation policy per design §4.6: list form (not flow form)
 * for `plans/projects/people/tags`, fixed key order regardless of input
 * property order, empty arrays render as `field: []`.
 *
 * Daemon-owned + immutable: date, weekday, type, owner, agent_generated,
 * calendar_events, messages_handled, updated, agent_last_synced_at,
 * content_hash. The LLM has no influence over any of these.
 */
export function composeDailyJournal(args: {
  skeleton: JournalSkeletonInputs;
  /** Count of yesterday's calendar events, taken from the skeleton facts. */
  calendarEvents: number;
  /** `messages_handled` count, taken from the skeleton facts. */
  messagesHandled: number;
  body: string;
  frontmatter: JournalFrontmatter;
  /** Stamped `Date.now()` ISO8601 — daemon owns this per §4.6. */
  agentLastSyncedAtIso: string;
}): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`date: ${args.skeleton.dateStr}`);
  lines.push(`weekday: ${args.skeleton.weekday}`);
  lines.push("type: daily");
  lines.push("owner: agent");
  lines.push("agent_generated: true");
  lines.push(`calendar_events: ${Math.max(0, args.calendarEvents)}`);
  lines.push(`messages_handled: ${Math.max(0, args.messagesHandled)}`);
  lines.push(`updated: ${args.skeleton.updatedDateStr}`);
  lines.push(`agent_last_synced_at: ${args.agentLastSyncedAtIso}`);
  // content_hash empty — preserved verbatim to match the legacy shape;
  // a future migration may drop the field entirely. The chokepoint
  // validator accepts empty.
  lines.push(`content_hash: ""`);
  appendYamlListField(lines, "projects", args.frontmatter.projects);
  appendYamlListField(lines, "people", args.frontmatter.people);
  appendYamlListField(lines, "tags", args.frontmatter.tags);
  lines.push("---");
  lines.push("");
  // Body trimming: drop leading/trailing newlines but preserve internal
  // structure. Stage B is instructed to emit the body's `#` H1 first,
  // so the result lands the H1 immediately after the frontmatter close.
  const trimmedBody = args.body.replace(/^\n+/, "").replace(/\n+$/, "");
  lines.push(trimmedBody);
  // Final newline so the file ends with `\n` (POSIX text-file convention
  // and what the existing `daily/*.md` chokepoint produces).
  lines.push("");
  return lines.join("\n");
}

function appendYamlListField(
  lines: string[],
  field: string,
  values: ReadonlyArray<string>,
): void {
  // Trim empty / whitespace entries — the LLM has been known to emit
  // bare `""` placeholders that would round-trip into Obsidian's wiki
  // graph as broken backlinks.
  const cleaned = values
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0);
  if (cleaned.length === 0) {
    lines.push(`${field}: []`);
    return;
  }
  lines.push(`${field}:`);
  for (const value of cleaned) {
    lines.push(`  - ${value}`);
  }
}

/**
 * Render the H2 header for the append-revision branch. Pulled out so
 * the orchestrator + tests share one source of truth for the format.
 */
export function dailyJournalRevisionHeader(isoTimestamp: string): string {
  return `## Agent revision — ${isoTimestamp}`;
}

// ── Wired composer ───────────────────────────────────────────────────

export interface DailyJournalComposerDeps {
  db: Database.Database;
  contextDir: string;
  saveSnapshot: (
    snapshotKey: string,
    content: string,
    trigger: string,
    force?: boolean,
    sessionId?: string | null,
  ) => number | null;
  writeTracker?: Pick<AgentWriteTracker, "markWriting" | "unmark">;
  onIndexableContextChange?: (relativePath: string) => void;
  /** Override `Date.now()` for tests. */
  now?: () => Date;
}

export interface DailyJournalComposeArgs {
  /** Routine correlation id — used for log correlation only. */
  correlationId: string;
  /** Yesterday's agent-day date (`YYYY-MM-DD`). */
  yesterdayDateStr: string;
  /** Pre-built skeleton inputs the orchestrator already computed. */
  skeleton: JournalSkeletonInputs;
  /** Pre-aggregated `calendar_events` count (from skeleton facts). */
  calendarEvents: number;
  /** Pre-aggregated `messages_handled` count (from skeleton facts). */
  messagesHandled: number;
  /** Stage B's `AgentResult` — `null` when Stage B was skipped or threw
   *  (the composer returns `ok: false, reason: "stage_b_null"` directly). */
  stageBResult: AgentResult | null;
}

/**
 * Wired composer — extract → compose → write. Returns the discriminated
 * outcome so the orchestrator can plumb `detail.dailyWrite` into the
 * Stage B `agent_actions` row before persisting and so the appender can
 * render the right line.
 *
 * Errors are NOT thrown for any LLM-shape failure — those are returned
 * as `ok: false`. fs / DB errors during the write itself ARE caught and
 * returned as `ok: false, reason: "write_failed"`; the caller does not
 * need a try/catch around `compose()` calls.
 */
export class DailyJournalComposer {
  constructor(private readonly deps: DailyJournalComposerDeps) {}

  async compose(args: DailyJournalComposeArgs): Promise<DailyJournalComposeResult> {
    if (args.stageBResult === null) {
      return { ok: false, reason: "stage_b_null" };
    }

    const finalText = readFinalAssistantText(args.stageBResult);
    const extracted = extractJournalSections(finalText);
    if (extracted.body === null) {
      const reason: ExtractionFailureReason =
        extracted.parseError === "empty_output" ? "empty_output" : "body_tag_missing";
      logger.warn(
        {
          correlationId: args.correlationId,
          yesterdayDateStr: args.yesterdayDateStr,
          parseError: extracted.parseError,
        },
        "Daily journal extraction failed — no body tag",
      );
      return { ok: false, reason };
    }

    // Even if frontmatter parsing failed, the body extracted — write it
    // with empty arrays so the diary content is preserved (§4.7
    // partial-extract rationale).
    const frontmatter: JournalFrontmatter =
      extracted.frontmatter ?? { projects: [], people: [], tags: [] };

    const now = (this.deps.now ?? (() => new Date()))();
    const composed = composeDailyJournal({
      skeleton: args.skeleton,
      calendarEvents: args.calendarEvents,
      messagesHandled: args.messagesHandled,
      body: extracted.body,
      frontmatter,
      agentLastSyncedAtIso: now.toISOString(),
    });

    const absolutePath = dailyJournalAbsolutePath(
      this.deps.contextDir,
      args.yesterdayDateStr,
    );
    const relativePath = dailyJournalPath(args.yesterdayDateStr);
    const snapshotKey = dailyJournalSnapshotKey(args.yesterdayDateStr);

    const fileExists = existsSync(absolutePath);
    const wroteMode: DailyJournalComposeMode = fileExists ? "append_revision" : "put";

    let writeResult;
    try {
      if (wroteMode === "put") {
        writeResult = performContextFileWrite(
          this.helperDeps(),
          {
            absolutePath,
            relativePath,
            snapshotKey,
            mode: "put",
            content: composed,
            trigger: SNAPSHOT_TRIGGER,
            forceSnapshot: true,
            // The composer's own composeDailyJournal emits skeleton-owned
            // fields by construction; running the chokepoint validator
            // catches a mismatch (defence-in-depth — if a future skeleton
            // change drifts the YAML, the composer fails loud rather than
            // silently writing a malformed daily file).
            validateDailySkeleton: true,
          },
        );
      } else {
        const blockHeader = dailyJournalRevisionHeader(now.toISOString());
        const block = `${blockHeader}\n\n${extracted.body.replace(/^\n+/, "").replace(/\n+$/, "")}`;
        writeResult = performContextFileWrite(
          this.helperDeps(),
          {
            absolutePath,
            relativePath,
            snapshotKey,
            mode: "append_block",
            content: block,
            blockHeader,
            trigger: SNAPSHOT_TRIGGER,
            forceSnapshot: false,
            // append_block uses the read-modify-write path — frontmatter
            // is already on disk from a prior PUT (or the user's
            // hand-edit), so re-validating it here would gate on bytes
            // the composer doesn't own.
            validateDailySkeleton: false,
          },
        );
      }
    } catch (err) {
      logger.error(
        {
          err,
          correlationId: args.correlationId,
          yesterdayDateStr: args.yesterdayDateStr,
          wroteMode,
        },
        "Daily journal write threw",
      );
      return { ok: false, reason: "write_failed" };
    }

    /* c8 ignore start — `composeDailyJournal` always emits a valid
       skeleton frontmatter and we just gated `wroteMode` on
       `existsSync`, so neither `daily_skeleton_drift` nor
       `missing_for_append` is reachable from this call site. Kept as a
       defence-in-depth guard against a future skeleton change that
       drifts the YAML — without this, the composer would treat a
       structured-error result as success and surface a bad audit row. */
    if (!writeResult.ok) {
      logger.error(
        {
          correlationId: args.correlationId,
          yesterdayDateStr: args.yesterdayDateStr,
          reason: writeResult.reason,
          wroteMode,
        },
        "Daily journal write helper rejected the request",
      );
      return { ok: false, reason: "write_failed" };
    }
    /* c8 ignore stop */

    if (extracted.parseError === null) {
      return {
        ok: "complete",
        bytesWritten: writeResult.bytesWritten,
        wroteMode,
      };
    }

    // parseError is set ⇒ partial extract: body landed, frontmatter
    // didn't. Map the extractor's error code to the partial-reason union
    // so `agent-journal-appender` can render the bolded "partial — …"
    // suffix. The only extractor error codes reachable in this branch
    // are the three partial reasons (body absence already returned
    // ok: false above), so this map is exhaustive.
    const partialReason = mapToPartialReason(extracted.parseError);
    return {
      ok: "partial",
      bytesWritten: writeResult.bytesWritten,
      wroteMode,
      partialReason,
    };
  }

  private helperDeps() {
    return {
      saveSnapshot: this.deps.saveSnapshot,
      ...(this.deps.writeTracker ? { writeTracker: this.deps.writeTracker } : {}),
      ...(this.deps.onIndexableContextChange
        ? { onIndexableContextChange: this.deps.onIndexableContextChange }
        : {}),
    };
  }
}

function mapToPartialReason(
  parseError: JournalParseError,
): PartialExtractReason {
  switch (parseError) {
    case "frontmatter_tag_missing":
    case "frontmatter_invalid_json":
    case "frontmatter_schema_invalid":
      return parseError;
    // Body-level reasons would have been returned as `ok: false` above
    // — these cases are unreachable but the switch is exhaustive for
    // future maintainers.
    /* c8 ignore next 4 */
    case "stage_b_null":
    case "empty_output":
    case "body_tag_missing":
    case "write_failed":
      return "frontmatter_tag_missing";
  }
}

/**
 * Pull the final assistant text from an `AgentResult`. SDK + CLI
 * backends differ in which field carries the text — `result.result` is
 * the SDK shape, `result.output` is the CLI shape. Read either,
 * tolerate both, return empty string on null/undefined.
 */
function readFinalAssistantText(result: AgentResult): string {
  // AgentResult schemas across backends agree on either `result.result`
  // (Claude SDK final-text shape) or `result.output` (CLI JSONL parse
  // path). Both can be null when the session exited without producing
  // text — treat both as empty for the extractor's `empty_output` branch.
  const r = result as unknown as { result?: unknown; output?: unknown };
  if (typeof r.result === "string") return r.result;
  if (typeof r.output === "string") return r.output;
  return "";
}
