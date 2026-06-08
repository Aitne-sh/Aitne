/**
 * Feedback Learning Loop — consolidation pre-step (FEEDBACK_LEARNING_LOOP_DESIGN.md §4).
 *
 * The daemon-side, deterministic half of Stage 2. On the evening-review tick it
 * reads unconsumed `feedback_signals`, groups them by `(scope_type, scope_ref)`,
 * pre-computes each candidate's weighted evidence + promotion verdict and each
 * lessons file's eviction ranking + headroom, and emits a `<feedback_worksheet>`
 * block — exactly as `<journal_skeleton>` / `harvestForGate` blocks are
 * daemon-prepared today. The LLM step then does only the *semantic* work
 * (intent-match merge, contradiction detection, phrasing) and writes via
 * `PATCH /api/context/policies/agent-lessons`, then consumes the worksheet's ids.
 *
 * Two layers, mirroring `journal-skeleton-builder.ts`:
 *   - `gatherFeedbackWorksheetScopes(db, …)` — the single DB read (side-effect
 *     free); groups pending signals by scope. Cost scales with feedback volume,
 *     not agent count (the `idx_feedback_unconsumed` partial index).
 *   - `buildFeedbackWorksheet(scopes, …)` — pure markdown/XML composer. Every
 *     output byte is a deterministic function of its inputs; the caller supplies
 *     each lessons file's current contents so this stays I/O-free and 100%
 *     coverable.
 *
 * Phase 2 stores `user` + `agent`; `agent:<slug>` lands in Phase 4. The builder
 * already renders any lessons scope, so Phase 4 is wiring, not new logic here.
 */

import type Database from "better-sqlite3";

import {
  getPendingFeedbackSignals,
  type FeedbackScopeType,
  type FeedbackSignalRow,
  type FeedbackSignalSource,
} from "../../db/feedback-signals-store.js";
import {
  extractMarkdownSection,
  LESSON_KINDS,
  parseLessonsSection,
  type Lesson,
  type LessonKind,
} from "./lesson-format.js";
import { evaluatePromotion } from "./promotion-gate.js";
import {
  enforceCaps,
  scoreLesson,
  DEFAULT_RECENCY_HALFLIFE_DAYS,
} from "./eviction-scorer.js";
import { groupSignalsBySummary } from "./lesson-merge.js";
import {
  formatScope,
  parseScope,
  scopeKey,
  scopeSectionSlug,
  scopeStoreFile,
  type CanonicalScope,
} from "./scope-parser.js";

/** Fixed entry caps (§6 table) — config carries only the byte caps. */
export const GLOBAL_LESSON_ENTRY_CAP = 40;
export const PER_AGENT_LESSON_ENTRY_CAP = 20;

/** Default ceiling on signals pulled per pass (store caps the query at 500). */
const DEFAULT_SIGNAL_LIMIT = 400;

export interface WorksheetScopeGroup {
  scope: CanonicalScope;
  signals: FeedbackSignalRow[];
}

/**
 * Read unconsumed signals for the requested scope types and group them by
 * canonical scope. Each scope type is queried independently (oldest-first
 * within the type) so the per-pass row budget applies *per type*. A single
 * global `LIMIT` over `created_at ASC` would let a backlog of unconsumed
 * `agent_slug` rows — written by the behavioral sink but not consolidated
 * until Phase 4 — occupy the oldest-N window and silently starve the
 * `user`/`agent` scopes this pass actually processes. Groups come back in
 * `scopeTypes` order; rows whose `(scope_type, scope_ref)` can't be parsed
 * (defensive — the route + behavioral sink only write valid pairs) are skipped
 * so a bad row never breaks the pass.
 */
export function gatherFeedbackWorksheetScopes(
  db: Database.Database,
  opts: { scopeTypes: ReadonlyArray<FeedbackScopeType>; limit?: number },
): WorksheetScopeGroup[] {
  const limit = opts.limit ?? DEFAULT_SIGNAL_LIMIT;
  const order: string[] = [];
  const byKey = new Map<string, WorksheetScopeGroup>();
  for (const scopeType of opts.scopeTypes) {
    const rows = getPendingFeedbackSignals(db, { scopeType, limit });
    for (const row of rows) {
      const scope = parseScope(row.scope_type, row.scope_ref);
      if (!scope) continue;
      const key = scopeKey(scope);
      let group = byKey.get(key);
      if (!group) {
        group = { scope, signals: [] };
        byKey.set(key, group);
        order.push(key);
      }
      group.signals.push(row);
    }
  }
  return order.map((key) => byKey.get(key)!);
}

/** Resolve per-scope byte/entry caps; `null` for raw (user) + unstored scopes. */
export function lessonCapsForScope(
  scope: CanonicalScope,
  byteCaps: { global: number; perAgent: number },
): { capBytes: number; maxEntries: number } | null {
  if (scope.kind === "agent") {
    return { capBytes: byteCaps.global, maxEntries: GLOBAL_LESSON_ENTRY_CAP };
  }
  if (scope.kind === "agent_slug") {
    return {
      capBytes: byteCaps.perAgent,
      maxEntries: PER_AGENT_LESSON_ENTRY_CAP,
    };
  }
  return null;
}

export interface WorksheetScopeInput {
  scope: CanonicalScope;
  signals: FeedbackSignalRow[];
  /** Current lessons-store file contents (lessons scopes), else null. */
  existingFileMd: string | null;
  /** Byte/entry caps for lessons scopes; null for raw (user) scopes. */
  caps: { capBytes: number; maxEntries: number } | null;
}

export interface BuildWorksheetOptions {
  promotionThreshold: number;
  nowIso: string;
  recencyHalfLifeDays?: number;
  /**
   * Staleness horizon in days (`feedbackLessonStaleDays`, §4 step 7). An
   * existing lesson whose `last=` predates `now − staleDays` and is not a
   * `constraint` is flagged `stale="true"` so the LLM prunes it in the rebuild.
   * Omitted ⇒ nothing is flagged stale (no time-based prune this pass).
   */
  staleDays?: number;
}

export interface WorksheetResult {
  /** `<feedback_worksheet>…</feedback_worksheet>` block for verbatim injection. */
  block: string;
  /** Every surfaced signal id — the exact consume set (§4 step 6). */
  signalIds: number[];
  scopeCount: number;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function round2(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2);
}

/**
 * `store=` attribute for a scope. Stored scopes (user/agent/agent_slug) resolve
 * to a path; v2 scopes surfaced raw (channel/task/integration, not yet stored)
 * render an empty string so the LLM treats them as advisory-only.
 */
function storeFileAttr(scope: CanonicalScope): string {
  return scopeStoreFile(scope) ?? "";
}

/** Collapse a one-line excerpt of a signal/lesson for an XML text node. */
function inline(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const clipped = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  return xmlEscape(clipped);
}

/** Authority ranking for picking a candidate's representative `src=` trailer. */
const SOURCE_AUTHORITY: Record<FeedbackSignalSource, number> = {
  explicit: 3,
  self_critique: 2,
  behavioral: 1,
};

/** The strongest source across a candidate's contributing signals. */
function dominantSource(
  rows: ReadonlyArray<FeedbackSignalRow>,
): FeedbackSignalSource {
  return rows.reduce<FeedbackSignalSource>(
    (best, row) =>
      SOURCE_AUTHORITY[row.source] > SOURCE_AUTHORITY[best] ? row.source : best,
    "behavioral",
  );
}

/** Read a stated lesson `kind` out of a signal's `evidence_json` (the route
 * stores an explicit/self_critique POST's `kind` there), tolerating malformed
 * JSON. */
function evidenceKind(json: string | null): LessonKind | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as { kind?: unknown };
    return typeof parsed?.kind === "string" && LESSON_KINDS.has(parsed.kind)
      ? (parsed.kind as LessonKind)
      : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort lesson `kind` for a candidate so the LLM doesn't have to guess
 * the trailer it's told to copy "from the candidate" (task-flow Step 4a): an
 * explicit/self_critique POST's stated `kind` wins, else a `correction`
 * valence maps to `correction`, else `null` (the LLM infers from the prose).
 */
function candidateKind(
  rows: ReadonlyArray<FeedbackSignalRow>,
): LessonKind | null {
  for (const row of rows) {
    const kind = evidenceKind(row.evidence_json);
    if (kind) return kind;
  }
  return rows.some((row) => row.valence === "correction") ? "correction" : null;
}

/**
 * §4 step 7 staleness test: a lesson is prunable for staleness when its `last`
 * reinforcement predates `now − staleDays` and it is not a durable
 * `constraint`. With no horizon configured, nothing is stale. An unparseable
 * date yields a `NaN` comparison, which is `false` — i.e. never prune on a
 * clock/format quirk.
 */
function isLessonStale(
  lesson: Lesson,
  nowIso: string,
  staleDays: number | undefined,
): boolean {
  if (staleDays === undefined || lesson.kind === "constraint") return false;
  const lastMs = Date.parse(`${lesson.last.slice(0, 10)}T00:00:00Z`);
  const nowMs = Date.parse(nowIso);
  return (nowMs - lastMs) / 86_400_000 > staleDays;
}

function renderLessonsScope(
  input: WorksheetScopeInput & { caps: { capBytes: number; maxEntries: number } },
  opts: BuildWorksheetOptions,
  out: string[],
): void {
  const label = formatScope(input.scope);
  const storeFile = storeFileAttr(input.scope);
  const section = scopeSectionSlug(input.scope);
  const halfLife = opts.recencyHalfLifeDays ?? DEFAULT_RECENCY_HALFLIFE_DAYS;

  const sectionBody = input.existingFileMd
    ? extractMarkdownSection(input.existingFileMd, "Lessons")
    : null;
  const existing: Lesson[] = sectionBody ? parseLessonsSection(sectionBody) : [];

  const currentBytes = input.existingFileMd
    ? Buffer.byteLength(input.existingFileMd, "utf-8")
    : 0;
  // Eviction ranking: ascending score → rank 1 = evict-first. The plan
  // (post-dedupe) tells the LLM whether the store is already over cap.
  const plan = enforceCaps(
    existing,
    { maxBytes: input.caps.capBytes, maxEntries: input.caps.maxEntries },
    opts.nowIso,
    { scopeLabel: label },
  );
  const ranked = [...existing].sort(
    (a, b) =>
      scoreLesson(a, opts.nowIso, undefined, halfLife) -
      scoreLesson(b, opts.nowIso, undefined, halfLife),
  );

  out.push(
    `  <scope label="${xmlEscape(label)}" store="${xmlEscape(storeFile)}" ` +
      `section="${xmlEscape(section)}" mode="lessons" ` +
      `cap_bytes="${input.caps.capBytes}" max_entries="${input.caps.maxEntries}" ` +
      `current_bytes="${currentBytes}" current_entries="${existing.length}" ` +
      `over_cap="${plan.evicted.length > 0}">`,
  );

  if (ranked.length > 0) {
    out.push(
      `    <existing_lessons note="ranked by eviction score; drop any lesson marked stale=&quot;true&quot; unless a fresh candidate re-reinforces it; if the section still exceeds the cap after your edits, remove from rank 1 upward then append: ${xmlEscape(
        "- [...N lower-signal lessons omitted — full history in feedback_signals]",
      )}">`,
    );
    ranked.forEach((lesson, idx) => {
      out.push(
        `      <lesson rank="${idx + 1}" score="${round2(
          scoreLesson(lesson, opts.nowIso, undefined, halfLife),
        )}" ev="${lesson.ev}" kind="${lesson.kind}" last="${lesson.last}" ` +
          `provisional="${lesson.provisional}" ` +
          `stale="${isLessonStale(lesson, opts.nowIso, opts.staleDays)}">` +
          `${inline(lesson.text)}</lesson>`,
      );
    });
    out.push("    </existing_lessons>");
  }

  renderCandidates(input.signals, opts, out, true);
  out.push("  </scope>");
}

function renderRawScope(
  input: WorksheetScopeInput,
  opts: BuildWorksheetOptions,
  out: string[],
): void {
  const label = formatScope(input.scope);
  const storeFile = storeFileAttr(input.scope);
  const section = scopeSectionSlug(input.scope);
  out.push(
    `  <scope label="${xmlEscape(label)}" store="${xmlEscape(storeFile)}" ` +
      `section="${xmlEscape(section)}" mode="raw">`,
  );
  renderCandidates(input.signals, opts, out, false);
  out.push("  </scope>");
}

function renderCandidates(
  signals: FeedbackSignalRow[],
  opts: BuildWorksheetOptions,
  out: string[],
  withVerdict: boolean,
): void {
  const groups = groupSignalsBySummary(
    signals.map((row) => ({ id: row.id, summary: row.summary, row })),
  );
  out.push("    <candidates>");
  for (const group of groups) {
    const ids = group.members.map((member) => member.id).join(",");
    if (withVerdict) {
      const memberRows = group.members.map((member) => member.row);
      const verdict = evaluatePromotion(
        memberRows.map((row) => ({
          source: row.source,
          valence: row.valence,
        })),
        opts.promotionThreshold,
      );
      const src = dominantSource(memberRows);
      const kind = candidateKind(memberRows);
      out.push(
        `      <candidate signals="${group.members.length}" ` +
          `weighted_ev="${round2(verdict.weightedEv)}" ` +
          `decision="${verdict.promotable ? "promote" : "hold-provisional"}" ` +
          `conf="${verdict.conf}" src="${src}"` +
          (kind ? ` kind="${kind}"` : "") +
          ` reason="${verdict.reason}" ids="${ids}">` +
          `${inline(group.summary)}</candidate>`,
      );
    } else {
      out.push(
        `      <candidate signals="${group.members.length}" ids="${ids}">` +
          `${inline(group.summary)}</candidate>`,
      );
    }
  }
  out.push("    </candidates>");
}

/**
 * Compose the `<feedback_worksheet>` block. Returns `null` when there are no
 * signals at all (the caller then stamps nothing — no empty block in the prompt).
 */
export function buildFeedbackWorksheet(
  scopes: ReadonlyArray<WorksheetScopeInput>,
  opts: BuildWorksheetOptions,
): WorksheetResult | null {
  const signalIds = scopes.flatMap((scope) =>
    scope.signals.map((signal) => signal.id),
  );
  if (signalIds.length === 0) return null;

  const out: string[] = [];
  out.push(
    `<feedback_worksheet generated_at="${xmlEscape(opts.nowIso)}" ` +
      `promotion_threshold="${opts.promotionThreshold}" scopes="${scopes.length}">`,
  );
  for (const scope of scopes) {
    if (scope.caps) {
      renderLessonsScope({ ...scope, caps: scope.caps }, opts, out);
    } else {
      renderRawScope(scope, opts, out);
    }
  }
  out.push(`  <consume ids="${signalIds.join(",")}" />`);
  out.push("</feedback_worksheet>");

  return { block: out.join("\n"), signalIds, scopeCount: scopes.length };
}
