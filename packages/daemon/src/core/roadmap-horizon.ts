import { localDateStr } from "@aitne/shared";
import {
  appendRoadmapIdComment,
  stripRoadmapIdComment,
} from "./roadmap-ids.js";

export type LongTermPlanSource =
  | "dm"
  | "mail"
  | "observation"
  | "reading"
  | "dashboard"
  | "manual";

export interface HorizonResolution {
  tag: string;
  anchorDate: string | null;
  leadDays: number | null;
}

export interface DeriveReviewDateOptions {
  sourceDate: string;
  today?: string;
  now?: Date;
  timezone?: string;
}

export interface ReviewCycle {
  review: string;
  reviewCount: number;
}

export interface NormalizeLongTermPlanLineOptions {
  today?: string;
  now?: Date;
  timezone?: string;
  defaultSource?: LongTermPlanSource;
}

export type NormalizeLongTermPlanLineResult =
  | {
      ok: true;
      line: string;
      changed: boolean;
      warning?: string;
    }
  | {
      ok: false;
      message: string;
    };

export const HORIZON_TAG_RE =
  /^(?:\d{4}-(?:0[1-9]|1[0-2])|\d{4}-Q[1-4]|\d{4} (?:spring|summer|autumn|winter)|undated)$/;

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const SOURCE_VALUES = new Set<LongTermPlanSource>([
  "dm",
  "mail",
  "observation",
  "reading",
  "dashboard",
  "manual",
]);

const SOURCE_RE = "(dm|mail|observation|reading|dashboard|manual)";
const DATE_RE = "(\\d{4}-\\d{2}-\\d{2})";
const REVIEW_RE = "(\\d{4}-\\d{2}-\\d{2}|\\[noreview\\])";
const DASH = "\\s+\\u2014\\s+";
const TRAILING_MARKERS_RE =
  "(?:\\s+\\[stale since \\d{4}-\\d{2}-\\d{2}\\])?(?:\\s+\\[awaiting-reply \\d{4}-\\d{2}-\\d{2}\\])?\\s*";

const CANONICAL_LTP_RE = new RegExp(
  `^- \\[([^\\]]+)\\] (.+?)${DASH}Source: ${SOURCE_RE} ${DATE_RE}${DASH}Review: ${REVIEW_RE}${DASH}ReviewCount: ([0-3])(${TRAILING_MARKERS_RE})$`,
);

export function isValidYmd(value: string): boolean {
  if (!YMD_RE.test(value)) return false;
  const [yearRaw, monthRaw, dayRaw] = value.split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function addDaysYmd(value: string, days: number): string {
  if (!isValidYmd(value)) {
    throw new Error(`Invalid YYYY-MM-DD date: ${value}`);
  }
  const [yearRaw, monthRaw, dayRaw] = value.split("-");
  const date = new Date(
    Date.UTC(Number(yearRaw), Number(monthRaw) - 1, Number(dayRaw)),
  );
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function todayYmd(options?: {
  today?: string;
  now?: Date;
  timezone?: string;
}): string {
  if (options?.today) return options.today;
  return localDateStr(options?.now ?? new Date(), options?.timezone);
}

export function resolveHorizonAnchor(tag: string): HorizonResolution | null {
  if (tag === "undated") {
    return { tag, anchorDate: null, leadDays: null };
  }

  const monthMatch = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(tag);
  if (monthMatch) {
    return { tag, anchorDate: `${monthMatch[1]}-${monthMatch[2]}-01`, leadDays: 28 };
  }

  const quarterMatch = /^(\d{4})-Q([1-4])$/.exec(tag);
  if (quarterMatch) {
    const month = (Number(quarterMatch[2]) - 1) * 3 + 1;
    return {
      tag,
      anchorDate: `${quarterMatch[1]}-${String(month).padStart(2, "0")}-01`,
      leadDays: 45,
    };
  }

  const seasonMatch = /^(\d{4}) (spring|summer|autumn|winter)$/.exec(tag);
  if (seasonMatch) {
    const monthBySeason: Record<string, string> = {
      spring: "03",
      summer: "06",
      autumn: "09",
      winter: "12",
    };
    return {
      tag,
      anchorDate: `${seasonMatch[1]}-${monthBySeason[seasonMatch[2]]}-01`,
      leadDays: 60,
    };
  }

  return null;
}

export function deriveReviewDate(
  horizonTag: string,
  options: DeriveReviewDateOptions,
): string {
  if (!isValidYmd(options.sourceDate)) {
    throw new Error(`Invalid Source date: ${options.sourceDate}`);
  }
  const resolution = resolveHorizonAnchor(horizonTag);
  if (!resolution) {
    throw new Error(`Invalid horizon tag: ${horizonTag}`);
  }

  const derived =
    resolution.anchorDate === null || resolution.leadDays === null
      ? addDaysYmd(options.sourceDate, 90)
      : addDaysYmd(resolution.anchorDate, -resolution.leadDays);

  const writeDate = todayYmd(options);
  if (derived < writeDate) {
    return addDaysYmd(options.sourceDate, 1);
  }
  return derived;
}

export function bumpReviewCycle(args: {
  horizonTag: string;
  review: string;
  reviewCount: number;
}): ReviewCycle {
  if (args.review === "[noreview]") {
    return { review: "[noreview]", reviewCount: Math.min(args.reviewCount, 3) };
  }
  if (!isValidYmd(args.review)) {
    throw new Error(`Invalid Review date: ${args.review}`);
  }
  if (args.reviewCount < 0 || args.reviewCount > 3) {
    throw new Error(`Invalid ReviewCount: ${args.reviewCount}`);
  }

  const nextCount = Math.min(args.reviewCount + 1, 3);
  if (args.horizonTag === "undated" && nextCount >= 3) {
    return { review: "[noreview]", reviewCount: 3 };
  }

  return {
    review: addDaysYmd(args.review, args.horizonTag === "undated" ? 90 : 30),
    reviewCount: nextCount,
  };
}

export function normalizeLongTermPlanLine(
  line: string,
  options?: NormalizeLongTermPlanLineOptions,
): NormalizeLongTermPlanLineResult {
  if (line.trim() === "") {
    return { ok: true, line, changed: false };
  }

  const { line: lineWithoutId, id } = stripRoadmapIdComment(line);
  const canonical = CANONICAL_LTP_RE.exec(lineWithoutId);
  if (canonical) {
    const horizonTag = canonical[1];
    const sourceDate = canonical[4];
    const review = canonical[5];
    if (!resolveHorizonAnchor(horizonTag)) {
      return { ok: false, message: `Invalid horizon tag: ${horizonTag}` };
    }
    if (!isValidYmd(sourceDate)) {
      return { ok: false, message: `Invalid Source date: ${sourceDate}` };
    }
    if (review !== "[noreview]" && !isValidYmd(review)) {
      return { ok: false, message: `Invalid Review date: ${review}` };
    }
    return { ok: true, line, changed: false };
  }

  const bullet = /^- \[([^\]]+)\](?:\s+(.*))?$/.exec(lineWithoutId);
  if (!bullet) {
    return {
      ok: false,
      message: "Long-term Plans entries must be bullet lines beginning with `- [<horizon>]`",
    };
  }

  const horizonTag = bullet[1].trim();
  if (!resolveHorizonAnchor(horizonTag)) {
    return { ok: false, message: `Invalid horizon tag: ${horizonTag}` };
  }

  const tail = bullet[2] ?? "";
  const labels = [" \\u2014 Source:", " \\u2014 Review:", " \\u2014 ReviewCount:"];
  const labelIndexes = labels
    .map((label) => tail.indexOf(label.replace("\\u2014", "\u2014")))
    .filter((index) => index >= 0);
  const firstLabelIndex = labelIndexes.length > 0 ? Math.min(...labelIndexes) : -1;
  const rawIntent = (firstLabelIndex >= 0 ? tail.slice(0, firstLabelIndex) : tail)
    .replace(/\s+\[stale since \d{4}-\d{2}-\d{2}\]\s*$/, "")
    .replace(/\s+\[awaiting-reply \d{4}-\d{2}-\d{2}\]\s*$/, "")
    .trim();
  if (!rawIntent) {
    return { ok: false, message: "Long-term Plans entry intent is empty" };
  }

  const sourceLabelPresent = /\s+\u2014\s+Source:/.test(tail);
  const reviewLabelPresent = /\s+\u2014\s+Review:/.test(tail);
  const reviewCountLabelPresent = /\s+\u2014\s+ReviewCount:/.test(tail);
  const fieldsPart = firstLabelIndex >= 0 ? tail.slice(firstLabelIndex) : "";

  const sourceMatch = new RegExp(`${DASH}Source: ${SOURCE_RE} ${DATE_RE}(?=${DASH}|\\s|$)`).exec(tail);
  if (sourceLabelPresent && !sourceMatch) {
    return { ok: false, message: "Malformed Long-term Plans Source field" };
  }
  const reviewMatch = new RegExp(`${DASH}Review: ${REVIEW_RE}(?=${DASH}|\\s|$)`).exec(tail);
  if (reviewLabelPresent && !reviewMatch) {
    return { ok: false, message: "Malformed Long-term Plans Review field" };
  }
  const reviewCountMatch = new RegExp(`${DASH}ReviewCount: ([0-3])(?=\\s|$)`).exec(tail);
  if (reviewCountLabelPresent && !reviewCountMatch) {
    return { ok: false, message: "Malformed Long-term Plans ReviewCount field" };
  }
  if (fieldsPart) {
    const fieldsRe = new RegExp(
      `^(?:${DASH}Source: ${SOURCE_RE} ${DATE_RE})?(?:${DASH}Review: ${REVIEW_RE})?(?:${DASH}ReviewCount: [0-3])?${TRAILING_MARKERS_RE}$`,
    );
    if (!fieldsRe.test(fieldsPart)) {
      return { ok: false, message: "Malformed Long-term Plans schema fields" };
    }
  }

  const source = (sourceMatch?.[1] ?? options?.defaultSource ?? "dashboard") as LongTermPlanSource;
  if (!SOURCE_VALUES.has(source)) {
    return { ok: false, message: `Invalid Long-term Plans Source: ${source}` };
  }

  const sourceDate = sourceMatch?.[2] ?? todayYmd(options);
  if (!isValidYmd(sourceDate)) {
    return { ok: false, message: `Invalid Source date: ${sourceDate}` };
  }

  const review = reviewMatch?.[1] ?? deriveReviewDate(horizonTag, {
    sourceDate,
    today: todayYmd(options),
  });
  if (review !== "[noreview]" && !isValidYmd(review)) {
    return { ok: false, message: `Invalid Review date: ${review}` };
  }

  const reviewCount = reviewCountMatch?.[1] ?? "0";
  const markerMatches = (fieldsPart || tail).match(
    /(?:\s+\[stale since \d{4}-\d{2}-\d{2}\])?(?:\s+\[awaiting-reply \d{4}-\d{2}-\d{2}\])?\s*$/,
  );
  const trailingMarkers = markerMatches![0].trimEnd();
  const normalized = [
    `- [${horizonTag}] ${rawIntent}`,
    `Source: ${source} ${sourceDate}`,
    `Review: ${review}`,
    `ReviewCount: ${reviewCount}`,
  ].join(" \u2014 ") + trailingMarkers;
  const normalizedWithId = id ? appendRoadmapIdComment(normalized, id) : normalized;

  return {
    ok: true,
    line: normalizedWithId,
    changed: normalizedWithId !== line,
    warning: "Long-term Plans entry normalized with missing schema fields",
  };
}
