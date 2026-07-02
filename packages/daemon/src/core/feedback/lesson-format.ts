/**
 * Feedback Learning Loop — lesson MD format (FEEDBACK_LEARNING_LOOP_DESIGN.md §3.4).
 *
 * A *lesson* is a generalized, injectable directive rendered as a markdown
 * bullet that extends the existing Learned-Context convention with a
 * machine-readable trailer:
 *
 *   - [2026-06-07] Keep the weekly report's budget section even when spend is
 *     flat — owner flagged it missing twice.
 *     <!-- ev=2 kind=correction src=explicit conf=high cf=0.74 last=2026-06-07 -->
 *
 * Optional `<!-- provisional -->` marks a lesson stored but excluded from
 * injection until it promotes (§4 step 4).
 *
 * `cf` is the SELF_IMPROVEMENT_PHASE2 §2.1 numeric confidence in [0,1] — the
 * single deterministic key the daemon ranks, filters, and decays on. It is
 * stamped by the deterministic normalizer (`lesson-normalizer.ts`), never
 * trusted from LLM transcription; absent on legacy lessons ({@link lessonCf}
 * supplies the qualitative-`conf` default at read time).
 *
 * This module is pure (no I/O): parse a `## Lessons` section body into typed
 * {@link Lesson}s and serialize them back byte-stably. It is the shared
 * vocabulary for the promotion gate, eviction scorer, merge/dedup, and the
 * consolidation worksheet — the §4 division-of-labour mechanical layer. The
 * LLM authors *prose*; this code owns the *structure*.
 */

export type LessonKind =
  | "preference"
  | "correction"
  | "do-more"
  | "do-less"
  | "constraint";

export type LessonSource = "explicit" | "behavioral" | "self_critique";

export type LessonConfidence = "high" | "medium" | "low";

export interface Lesson {
  /** Leading `[YYYY-MM-DD]` — creation date, drives age-based pruning. */
  date: string;
  /** Human-readable directive prose, newlines collapsed to single spaces. */
  text: string;
  /** Evidence count (weighted sum, §4 step 4) — drives promotion + eviction. */
  ev: number;
  kind: LessonKind;
  src: LessonSource;
  conf: LessonConfidence;
  /**
   * Numeric confidence in [0,1] (Phase-2 §2.1), or `null` when the trailer
   * carries no valid `cf=` (every pre-Phase-2 lesson). Read through
   * {@link lessonCf} — never directly — so the conf-derived default applies.
   */
  cf: number | null;
  /** Last reinforced `YYYY-MM-DD` — staleness pruning keys on this, NOT date. */
  last: string;
  /** Stored but excluded from injection until promoted. */
  provisional: boolean;
}

export const LESSON_KINDS: ReadonlySet<string> = new Set<LessonKind>([
  "preference",
  "correction",
  "do-more",
  "do-less",
  "constraint",
]);

export const LESSON_SOURCES: ReadonlySet<string> = new Set<LessonSource>([
  "explicit",
  "behavioral",
  "self_critique",
]);

export const LESSON_CONFIDENCES: ReadonlySet<string> = new Set<LessonConfidence>(
  ["high", "medium", "low"],
);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Bullet entry start: `- [YYYY-MM-DD] …` (rest of the line is prose).
 *  Shared with the normalizer's span walker so "what starts an entry" can
 *  never drift between parse and surgical rewrite. */
export const LESSON_ENTRY_START_RE = /^-\s+\[(\d{4}-\d{2}-\d{2})\]\s?(.*)$/;
const ENTRY_START_RE = LESSON_ENTRY_START_RE;
/**
 * Eviction marker `- [...N … omitted …]` — emitted by the scorer, never a
 * lesson (its bracket holds `...`, not a date). Skipped on parse so re-reading
 * a previously-evicted section does not fold the marker text into the
 * preceding lesson's prose. Shared with the normalizer's span walker.
 */
export const LESSON_OMITTED_MARKER_RE = /^\s*-\s*\[\.\.\./;
const OMITTED_MARKER_RE = LESSON_OMITTED_MARKER_RE;
/** Any HTML comment — trailer attrs + the `provisional` marker both ride these. */
const COMMENT_RE = /<!--([\s\S]*?)-->/g;
const PROVISIONAL_RE = /<!--\s*provisional\s*-->/i;

function isDate(value: string): boolean {
  return DATE_RE.test(value);
}

function coerceKind(value: string | undefined): LessonKind {
  return value && LESSON_KINDS.has(value) ? (value as LessonKind) : "preference";
}

function coerceSource(value: string | undefined): LessonSource {
  return value && LESSON_SOURCES.has(value)
    ? (value as LessonSource)
    : "behavioral";
}

function coerceConf(value: string | undefined): LessonConfidence {
  return value && LESSON_CONFIDENCES.has(value)
    ? (value as LessonConfidence)
    : "low";
}

/**
 * Tolerant-default map for lessons whose trailer predates `cf` (Phase-2 §2.1:
 * `cf ??= {high:0.8, medium:0.5, low:0.3}[conf]`). Exported so the normalizer
 * backfills the same values {@link lessonCf} reads at runtime.
 */
export const CONF_CF_DEFAULTS: Record<LessonConfidence, number> = {
  high: 0.8,
  medium: 0.5,
  low: 0.3,
};

/**
 * The single canonical read of a lesson's numeric confidence: the persisted
 * `cf` when present, else the qualitative-`conf` default. Every ranking /
 * filtering / decay consumer goes through this, so a legacy file behaves
 * identically before and after the normalizer's lazy backfill.
 */
export function lessonCf(lesson: Pick<Lesson, "cf" | "conf">): number {
  return lesson.cf ?? CONF_CF_DEFAULTS[lesson.conf];
}

/** Clamp to [0,1] and round to 2 decimals — the persisted `cf` precision. */
export function roundCf(value: number): number {
  const clamped = Math.min(1, Math.max(0, value));
  return Math.round(clamped * 100) / 100;
}

/**
 * Parse a trailer `cf=` token: finite numbers clamp into [0,1] (2dp);
 * anything garbled degrades to `null` (treated as absent — the normalizer
 * re-derives it) rather than throwing.
 */
function coerceCf(value: string | undefined): number | null {
  if (value === undefined) return null;
  const num = Number(value);
  return Number.isFinite(num) ? roundCf(num) : null;
}

/** Parse `ev=2 kind=correction src=explicit conf=high last=2026-06-07`. */
function parseTrailerAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const token of raw.trim().split(/\s+/)) {
    const eq = token.indexOf("=");
    if (eq <= 0) continue;
    const key = token.slice(0, eq);
    const value = token.slice(eq + 1);
    if (key.length > 0 && value.length > 0) out[key] = value;
  }
  return out;
}

/**
 * Extract a single markdown `## <header>` section body from a file, returning
 * the lines between the header and the next `## `/`# ` heading (exclusive),
 * or `null` when the header is absent. CRLF-tolerant.
 */
export function extractMarkdownSection(
  md: string,
  header: string,
): string | null {
  const lines = md.split(/\r?\n/);
  const wanted = `## ${header}`;
  const start = lines.findIndex((line) => line.trim() === wanted);
  if (start < 0) return null;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join("\n").trim();
}

/**
 * Parse a `## Lessons` section body into typed lessons. Non-lesson lines
 * (blank lines, the `<!-- scope: … -->` header comment, the `[...N omitted]`
 * eviction marker, stray prose) are ignored. Continuation lines (indented)
 * fold into the preceding lesson's prose. Malformed entries degrade to
 * defaults rather than throwing, so a hand-edited file never crashes the
 * nightly pass.
 */
export function parseLessonsSection(sectionBody: string): Lesson[] {
  if (!sectionBody) return [];
  const lines = sectionBody.split(/\r?\n/);
  const lessons: Lesson[] = [];
  let current: { date: string; buffer: string[] } | null = null;

  const flush = (): void => {
    if (!current) return;
    const joined = current.buffer.join("\n");
    const provisional = PROVISIONAL_RE.test(joined);
    // Merge attrs from every comment in the entry — `provisional` and any
    // valueless tokens fall out in `parseTrailerAttrs` rather than breaking
    // the whole trailer match (a hand-edited file never crashes the pass).
    const attrs: Record<string, string> = {};
    for (const match of joined.matchAll(COMMENT_RE)) {
      Object.assign(attrs, parseTrailerAttrs(match[1]));
    }
    // Strip every HTML comment (trailer + provisional marker) from prose.
    const text = joined
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const evNum = Number(attrs.ev);
    const ev = Number.isFinite(evNum) && evNum > 0 ? evNum : 1;
    const last = attrs.last && isDate(attrs.last) ? attrs.last : current.date;
    lessons.push({
      date: current.date,
      text,
      ev,
      kind: coerceKind(attrs.kind),
      src: coerceSource(attrs.src),
      conf: coerceConf(attrs.conf),
      cf: coerceCf(attrs.cf),
      last,
      provisional,
    });
    current = null;
  };

  for (const line of lines) {
    const startMatch = ENTRY_START_RE.exec(line);
    if (startMatch) {
      flush();
      current = { date: startMatch[1], buffer: [startMatch[2]] };
      continue;
    }
    if (OMITTED_MARKER_RE.test(line)) {
      // The eviction marker terminates the current lesson and is not itself a
      // lesson — neither a continuation nor a new entry.
      flush();
      continue;
    }
    if (
      current &&
      (line.startsWith("  ") || line.trim().startsWith("<!--"))
    ) {
      // Continuation of the current lesson: indented prose, or a trailer
      // comment the author placed on its own non-indented line.
      current.buffer.push(line.trim());
    } else if (current) {
      // Blank line or non-indented stray prose ends the current lesson.
      // The stray line itself is ignored (module contract: non-lesson
      // lines are ignored) — folding it into the preceding lesson would
      // absorb a hand-written note into an injectable directive and
      // re-serialize it permanently on the next consolidation.
      flush();
    }
  }
  flush();
  return lessons;
}

/**
 * Render one lesson as a markdown bullet with its trailer. Prose stays on the
 * first line; the trailer follows on a 2-space-indented continuation line so
 * it survives `trimBulletEntries` / `clearEntriesBefore` continuation rules.
 */
export function formatLesson(lesson: Lesson): string {
  // `cf=` sits between `conf` and `last` (Phase-2 §2.1 example) and is
  // omitted when null/absent so a legacy file (or a hand-constructed lesson
  // object without the field) round-trips byte-stably until the normalizer
  // stamps it. Loose `== null` deliberately covers `undefined`.
  const cfAttr = lesson.cf == null ? "" : `cf=${formatCfValue(lesson.cf)} `;
  const trailer =
    `<!-- ev=${lesson.ev} kind=${lesson.kind} src=${lesson.src} ` +
    `conf=${lesson.conf} ${cfAttr}last=${lesson.last} -->`;
  const provisional = lesson.provisional ? " <!-- provisional -->" : "";
  return `- [${lesson.date}] ${lesson.text}\n  ${trailer}${provisional}`;
}

/** Serialize a `cf` value for a trailer/worksheet: 2dp, e.g. `0.74`, `1.00`. */
export function formatCfValue(cf: number): string {
  return roundCf(cf).toFixed(2);
}

/**
 * Render a full `## Lessons` section: the `<!-- scope: … -->` header comment
 * (carrying the cap for at-a-glance review), the lesson bullets, and an
 * optional eviction marker. `scopeLabel` is the {@link formatScope} string.
 */
export function formatLessonsSection(
  lessons: ReadonlyArray<Lesson>,
  opts: {
    scopeLabel: string;
    capBytes: number;
    maxEntries: number;
    omittedMarker?: string | null;
  },
): string {
  const header = `<!-- scope: ${opts.scopeLabel} · cap: ${opts.capBytes}B · ${opts.maxEntries} entries -->`;
  const parts = [header, ...lessons.map((lesson) => formatLesson(lesson))];
  if (opts.omittedMarker) parts.push(opts.omittedMarker);
  return parts.join("\n");
}

/** UTF-8 byte length of a serialized lessons section — the cap unit (§6). */
export function lessonsSectionByteLength(
  lessons: ReadonlyArray<Lesson>,
  opts: { scopeLabel: string; capBytes: number; maxEntries: number },
): number {
  return Buffer.byteLength(formatLessonsSection(lessons, opts), "utf-8");
}
