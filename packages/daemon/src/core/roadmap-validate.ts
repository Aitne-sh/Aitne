import {
  addDaysYmd,
  isValidYmd,
  normalizeLongTermPlanLine,
  todayYmd,
  type LongTermPlanSource,
} from "./roadmap-horizon.js";
import {
  extractRoadmapIdFromLine,
  hasMalformedRoadmapIdComment,
  stripRoadmapIdComment,
} from "./roadmap-ids.js";

export interface RoadmapValidationError {
  message: string;
  line?: number;
  path: "roadmap.md";
}

export interface RoadmapValidationResult {
  ok: boolean;
  error?: RoadmapValidationError;
  warnings: string[];
}

export interface RoadmapTransitionValidationOptions {
  today?: string;
  now?: Date;
  timezone?: string;
}

export interface NormalizeRoadmapForWriteOptions {
  today?: string;
  now?: Date;
  timezone?: string;
  defaultLongTermPlanSource?: LongTermPlanSource;
}

export interface NormalizeRoadmapForWriteResult {
  content: string;
  changed: boolean;
  warnings: string[];
}

const REQUIRED_SECTIONS = [
  "Annual Goals",
  "Quarterly Focus",
  "Long-term Plans",
  "Agent Action Plan",
  "Recurring",
] as const;

const LAST_SYNCED_RE = /^> Last synced: (\d{4}-\d{2}-\d{2})$/;
const EVENT_HEADING_RE = /^### \d{4}-\d{2}-\d{2}(?: ~ \d{2}-\d{2})?: .+$/;
const SCHEDULED_HEADING_RE = /^### Scheduled: .+\s+\(task #\d+\)$/;
const SCHEDULED_SOURCE_RE =
  /^Source: scheduled\.task \u2014 wake-up \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const PREP_ROW_RE =
  /^- (?:completed \d{4}-\d{2}-\d{2}: )?\d{4}-\d{2}-\d{2} \[(notify|today|check|schedule)\](?:\s*\[provisional[^\]]*\])?: .+$/;
const COMPLETED_PREP_ROW_RE =
  /^- completed \d{4}-\d{2}-\d{2}: \d{4}-\d{2}-\d{2} \[(notify|today|check|schedule)\](?:\s*\[provisional[^\]]*\])?: .+$/;
const EVENT_DATE_FROM_HEADING_RE = /^### (\d{4}-\d{2}-\d{2})(?: ~ \d{2}-\d{2})?: /;
const SCHEDULED_WAKE_UP_RE =
  /^Source: scheduled\.task \u2014 wake-up (\d{4}-\d{2}-\d{2}) \d{2}:\d{2}$/;

export function normalizeRoadmapForWrite(
  content: string,
  options?: NormalizeRoadmapForWriteOptions,
): NormalizeRoadmapForWriteResult {
  const warnings: string[] = [];
  const lines = content.split("\n");
  const bounds = findSectionLineBounds(lines, "Long-term Plans");
  if (!bounds) {
    return { content, changed: false, warnings };
  }

  let changed = false;
  for (let index = bounds.bodyStart; index < bounds.bodyEnd; index++) {
    const line = lines[index];
    if (line.trim() === "") continue;
    const result = normalizeLongTermPlanLine(line, {
      today: options?.today,
      now: options?.now,
      timezone: options?.timezone,
      defaultSource: options?.defaultLongTermPlanSource ?? "dashboard",
    });
    if (result.ok && result.changed) {
      lines[index] = result.line;
      changed = true;
      if (result.warning) warnings.push(`line ${index + 1}: ${result.warning}`);
    }
  }

  return { content: lines.join("\n"), changed, warnings };
}

export function validateRoadmap(content: string): RoadmapValidationResult {
  const warnings: string[] = [];
  const lines = content.split("\n");

  if (lines[0] !== "# Roadmap") {
    return failure("roadmap.md must start with `# Roadmap`.", 1);
  }

  const lastSynced = LAST_SYNCED_RE.exec(lines[1] ?? "");
  const sections = collectTopLevelSections(lines);
  const entryIds = collectManagedEntryIds(lines);
  if (entryIds.malformed) {
    return failure(
      "Malformed roadmap id marker. Expected `<!-- id: rm-YYYYMMDD-abcdef -->`.",
      entryIds.malformed.line,
    );
  }
  if (entryIds.duplicate) {
    return failure(
      `Duplicate roadmap entry id \`${entryIds.duplicate.id}\` (first seen on line ${entryIds.duplicate.firstLine}).`,
      entryIds.duplicate.duplicateLine,
    );
  }

  if (!lastSynced || !isValidYmd(lastSynced[1])) {
    return failure("roadmap.md line 2 must be `> Last synced: YYYY-MM-DD`.", 2);
  }

  const requiredSet = new Set<string>(REQUIRED_SECTIONS);
  const requiredSequence = sections.filter((section) => requiredSet.has(section.name));
  for (let index = 0; index < REQUIRED_SECTIONS.length; index++) {
    const expected = REQUIRED_SECTIONS[index];
    const actual = requiredSequence[index];
    if (!actual) {
      return failure(`Missing required section \`## ${expected}\`.`, 3);
    }
    if (actual.name !== expected) {
      return failure(
        `Required sections must appear in this order: ${REQUIRED_SECTIONS.join(", ")}. Found \`## ${actual.name}\` where \`## ${expected}\` was expected.`,
        actual.line,
      );
    }
  }

  const requireIds = entryIds.refs.length > 0;

  const longTermPlans = findSectionLineBounds(lines, "Long-term Plans");
  if (!longTermPlans) {
    return failure("Missing `## Long-term Plans` section.");
  }
  for (let index = longTermPlans.bodyStart; index < longTermPlans.bodyEnd; index++) {
    const line = lines[index];
    if (line.trim() === "") continue;
    if (requireIds && !extractRoadmapIdFromLine(line)) {
      return failure("Long-term Plans line is missing roadmap id marker.", index + 1);
    }
    const result = normalizeLongTermPlanLine(line);
    if (!result.ok || result.changed) {
      return failure(
        result.ok
          ? "Long-term Plans line is not in canonical schema."
          : result.message,
        index + 1,
      );
    }
  }

  const agentActionPlan = findSectionLineBounds(lines, "Agent Action Plan");
  if (!agentActionPlan) {
    return failure("Missing `## Agent Action Plan` section.");
  }
  const aapError = validateAgentActionPlan(lines, agentActionPlan, requireIds);
  if (aapError) return { ok: false, error: aapError, warnings };

  return { ok: true, warnings };
}

interface ManagedEntryIdCollection {
  refs: Array<{ id: string; line: number }>;
  malformed?: { line: number };
  duplicate?: { id: string; firstLine: number; duplicateLine: number };
}

function collectManagedEntryIds(lines: string[]): ManagedEntryIdCollection {
  const refs: Array<{ id: string; line: number }> = [];

  const longTermPlans = findSectionLineBounds(lines, "Long-term Plans");
  if (longTermPlans) {
    for (let index = longTermPlans.bodyStart; index < longTermPlans.bodyEnd; index++) {
      const line = lines[index];
      if (line.trim() === "") continue;
      if (hasMalformedRoadmapIdComment(line)) {
        return { refs, malformed: { line: index + 1 } };
      }
      const id = extractRoadmapIdFromLine(line);
      if (id) refs.push({ id, line: index + 1 });
    }
  }

  const agentActionPlan = findSectionLineBounds(lines, "Agent Action Plan");
  if (agentActionPlan) {
    for (let index = agentActionPlan.bodyStart; index < agentActionPlan.bodyEnd; index++) {
      const line = lines[index];
      if (!line.startsWith("### ")) continue;
      if (hasMalformedRoadmapIdComment(line)) {
        return { refs, malformed: { line: index + 1 } };
      }
      const id = extractRoadmapIdFromLine(line);
      if (id) refs.push({ id, line: index + 1 });
    }
  }

  const seen = new Map<string, number>();
  for (const ref of refs) {
    const firstLine = seen.get(ref.id);
    if (firstLine !== undefined) {
      return {
        refs,
        duplicate: {
          id: ref.id,
          firstLine,
          duplicateLine: ref.line,
        },
      };
    }
    seen.set(ref.id, ref.line);
  }

  return { refs };
}

export function validateRoadmapTransition(
  previousContent: string,
  nextContent: string,
  options?: RoadmapTransitionValidationOptions,
): RoadmapValidationResult {
  const previousEntries = extractRoadmapEntryStates(previousContent);
  const nextEntries = new Map(
    extractRoadmapEntryStates(nextContent).map((entry) => [entry.id, entry]),
  );
  const today = todayYmd(options);

  for (const previous of previousEntries) {
    const next = nextEntries.get(previous.id);
    if (next) {
      const nextLines = new Set(next.lines);
      for (const row of previous.completedPrepRows) {
        if (!nextLines.has(row)) {
          return failure(
            `Completed Preparation Timeline row for entry \`${previous.id}\` was dropped.`,
            previous.line,
          );
        }
      }
      continue;
    }

    if (!isEntryRemovalAllowed(previous, today)) {
      return failure(
        `Roadmap entry \`${previous.id}\` was removed before its retention window permits removal.`,
        previous.line,
      );
    }
  }

  return { ok: true, warnings: [] };
}

function validateAgentActionPlan(
  lines: string[],
  bounds: { bodyStart: number; bodyEnd: number },
  requireIds: boolean,
): RoadmapValidationError | null {
  let currentEntry: "event" | "scheduled" | null = null;
  let inPreparationTimeline = false;

  for (let index = bounds.bodyStart; index < bounds.bodyEnd; index++) {
    const line = lines[index];
    const lineNo = index + 1;

    if (line.startsWith("### ")) {
      inPreparationTimeline = false;
      if (requireIds && !extractRoadmapIdFromLine(line)) {
        return error("Agent Action Plan heading is missing roadmap id marker.", lineNo);
      }
      const heading = stripRoadmapIdComment(line).line;
      if (EVENT_HEADING_RE.test(heading)) {
        currentEntry = "event";
        const nextLine = lines[index + 1];
        if (!nextLine.startsWith("Source:")) {
          return error("Agent Action Plan event entries require `Source:` on the next line.", lineNo + 1);
        }
      } else if (SCHEDULED_HEADING_RE.test(heading)) {
        currentEntry = "scheduled";
        const nextLine = lines[index + 1];
        if (!SCHEDULED_SOURCE_RE.test(nextLine)) {
          return error(
            "Scheduled entries require `Source: scheduled.task — wake-up YYYY-MM-DD HH:MM` on the next line.",
            lineNo + 1,
          );
        }
      } else {
        return error("Malformed Agent Action Plan heading.", lineNo);
      }
      continue;
    }

    if (line === "**Preparation Timeline:**") {
      inPreparationTimeline = currentEntry !== null;
      continue;
    }
    if (line.startsWith("**") || line.startsWith("## ")) {
      inPreparationTimeline = false;
      continue;
    }
    if (inPreparationTimeline && line.startsWith("- ") && !PREP_ROW_RE.test(line)) {
      // 2026-05 cost-spike fix: the bare "Malformed Preparation Timeline
      // row" message gave the agent zero signal about which part of the
      // row was wrong, so a roadmap_refresh session retried the PUT 8x
      // before timing out. Embed the canonical shape + the failing line
      // verbatim so the agent can spot the diff on the next turn.
      //
      // Truncate the received line at 200 chars so a pathological line
      // doesn't blow up the error response.
      const received = line.length > 200 ? `${line.slice(0, 200)}…` : line;
      return error(
        "Malformed Preparation Timeline row. " +
          "Expected `- YYYY-MM-DD [notify|today|check|schedule]: <description>` " +
          "or `- completed YYYY-MM-DD: YYYY-MM-DD [notify|today|check|schedule]: <description>`. " +
          `Received: \`${received}\``,
        lineNo,
      );
    }
  }

  return null;
}

interface RoadmapEntryState {
  id: string;
  kind: "event" | "scheduled" | "long-term-plan";
  line: number;
  lines: string[];
  completedPrepRows: string[];
  primaryDate?: string;
  wakeUpDate?: string;
  status?: string;
}

function extractRoadmapEntryStates(content: string): RoadmapEntryState[] {
  const lines = content.split("\n");
  return [
    ...extractLongTermPlanEntryStates(lines),
    ...extractAgentActionPlanEntryStates(lines),
  ];
}

function extractLongTermPlanEntryStates(lines: string[]): RoadmapEntryState[] {
  const bounds = findSectionLineBounds(lines, "Long-term Plans");
  if (!bounds) return [];

  const entries: RoadmapEntryState[] = [];
  for (let index = bounds.bodyStart; index < bounds.bodyEnd; index++) {
    const line = lines[index];
    if (line.trim() === "") continue;
    const id = extractRoadmapIdFromLine(line);
    if (!id) continue;
    entries.push({
      id,
      kind: "long-term-plan",
      line: index + 1,
      lines: [line],
      completedPrepRows: [],
    });
  }
  return entries;
}

function extractAgentActionPlanEntryStates(lines: string[]): RoadmapEntryState[] {
  const bounds = findSectionLineBounds(lines, "Agent Action Plan");
  if (!bounds) return [];

  const entries: RoadmapEntryState[] = [];
  let currentStart = -1;
  for (let index = bounds.bodyStart; index <= bounds.bodyEnd; index++) {
    const line = lines[index] ?? "";
    if (index === bounds.bodyEnd || line.startsWith("### ")) {
      if (currentStart >= 0) {
        const entry = buildAgentActionPlanEntryState(
          lines.slice(currentStart, index),
          currentStart + 1,
        );
        if (entry) entries.push(entry);
      }
      currentStart = index === bounds.bodyEnd ? -1 : index;
    }
  }
  return entries;
}

function buildAgentActionPlanEntryState(
  rawLines: string[],
  line: number,
): RoadmapEntryState | null {
  const entryLines = trimTrailingBlankLines(rawLines);
  const heading = entryLines[0];
  const id = extractRoadmapIdFromLine(heading);
  if (!id) return null;

  const strippedHeading = stripRoadmapIdComment(heading).line;
  const eventDate = EVENT_DATE_FROM_HEADING_RE.exec(strippedHeading)?.[1];
  const sourceLine = entryLines.find((entryLine) => entryLine.startsWith("Source:")) ?? "";
  const wakeUpDate = SCHEDULED_WAKE_UP_RE.exec(sourceLine)?.[1];
  const status = entryLines.find((entryLine) => entryLine.startsWith("Status:"));

  return {
    id,
    kind: strippedHeading.startsWith("### Scheduled:")
      ? "scheduled"
      : "event",
    line,
    lines: entryLines,
    completedPrepRows: entryLines.filter((entryLine) =>
      COMPLETED_PREP_ROW_RE.test(entryLine),
    ),
    primaryDate: eventDate,
    wakeUpDate,
    status,
  };
}

function trimTrailingBlankLines(lines: string[]): string[] {
  let lastNonBlank = -1;
  for (let index = lines.length - 1; index >= 0; index--) {
    if (lines[index].trim() !== "") {
      lastNonBlank = index;
      break;
    }
  }
  return lines.slice(0, lastNonBlank + 1);
}

function isEntryRemovalAllowed(entry: RoadmapEntryState, today: string): boolean {
  if (entry.kind === "event" && entry.primaryDate) {
    return (
      entry.primaryDate < addDaysYmd(today, -7) ||
      entry.primaryDate > addDaysYmd(today, 180)
    );
  }

  if (entry.kind === "scheduled" && entry.wakeUpDate && entry.status) {
    const terminal = entry.status.includes("completed") ||
      entry.status.includes("failed");
    return terminal && entry.wakeUpDate < addDaysYmd(today, -1);
  }

  return false;
}

function collectTopLevelSections(lines: string[]): Array<{ name: string; line: number }> {
  const sections: Array<{ name: string; line: number }> = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.startsWith("## ")) {
      sections.push({ name: line.slice(3).trim(), line: index + 1 });
    }
  }
  return sections;
}

export function findSectionLineBounds(
  lines: string[],
  sectionName: string,
): { headerLine: number; bodyStart: number; bodyEnd: number } | null {
  const header = `## ${sectionName}`;
  const headerIndex = lines.findIndex((line) => line === header);
  if (headerIndex < 0) return null;
  let bodyEnd = lines.length;
  for (let index = headerIndex + 1; index < lines.length; index++) {
    if (lines[index].startsWith("## ")) {
      bodyEnd = index;
      break;
    }
  }
  return { headerLine: headerIndex, bodyStart: headerIndex + 1, bodyEnd };
}

function failure(message: string, line?: number): RoadmapValidationResult {
  return { ok: false, error: error(message, line), warnings: [] };
}

function error(message: string, line?: number): RoadmapValidationError {
  return { message, line, path: "roadmap.md" };
}
