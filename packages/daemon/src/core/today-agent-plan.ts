import { createHash } from "node:crypto";

export type TodayAgentPlanCategory = "work" | "study" | "personal" | "home";
export type TodayAgentPlanTrigger = "DM" | "notify" | "check-in" | "wake";

export interface TodayAgentPlanRow {
  line: number;
  raw: string;
  checked: boolean;
  time: string;
  action: string;
  category: TodayAgentPlanCategory;
  trigger: TodayAgentPlanTrigger;
}

export interface TodayAgentPlanMetadata {
  date: string;
  ref: string;
  fingerprint: string;
  time: string;
  action: string;
  category: TodayAgentPlanCategory;
  trigger: TodayAgentPlanTrigger;
}

const TODAY_H1_DATE_RE = /^# (\d{4}-\d{2}-\d{2})(?: \([^)]+\))?$/;
const TODAY_AGENT_PLAN_ROW_RE =
  /^- \[([ xX])\] ((?:[01]\d|2[0-3]):[0-5]\d) (.+?) \[(work|study|personal|home)\] \u2192\s*(DM|notify|check-in|wake)(?:\s+.*)?$/;

export function extractTodayDate(content: string): string | null {
  const newlineIndex = content.search(/\r?\n/);
  const firstLine =
    newlineIndex < 0 ? content : content.slice(0, newlineIndex);
  return TODAY_H1_DATE_RE.exec(firstLine.trim())?.[1] ?? null;
}

export function extractTodayAgentPlanRows(content: string): {
  rows: TodayAgentPlanRow[];
  invalidRows: Array<{ line: number; raw: string }>;
} {
  const lines = content.split(/\r?\n/);
  const section = findMarkdownSectionByName(lines, "Agent Plan");
  if (!section) return { rows: [], invalidRows: [] };

  const rows: TodayAgentPlanRow[] = [];
  const invalidRows: Array<{ line: number; raw: string }> = [];
  for (let index = section.bodyStart; index < section.bodyEnd; index++) {
    const raw = lines[index].trim();
    if (!raw || raw === "- (none)" || !raw.startsWith("- ")) continue;

    const match = TODAY_AGENT_PLAN_ROW_RE.exec(raw);
    if (!match) {
      invalidRows.push({ line: index + 1, raw });
      continue;
    }
    rows.push({
      line: index + 1,
      raw,
      checked: match[1].toLowerCase() === "x",
      time: match[2],
      action: match[3],
      category: match[4] as TodayAgentPlanCategory,
      trigger: match[5] as TodayAgentPlanTrigger,
    });
  }
  return { rows, invalidRows };
}

export function normalizeAgentPlanAction(action: string): string {
  return action.trim().replace(/\s+/g, " ").toLowerCase();
}

export function getTodayAgentPlanFingerprint(
  date: string,
  row: Pick<TodayAgentPlanRow, "time" | "action" | "category" | "trigger">,
): string {
  const canonical = [
    date,
    row.time,
    normalizeAgentPlanAction(row.action),
    row.category,
    row.trigger,
  ].join("|");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export function buildTodayAgentPlanMetadata(
  date: string,
  row: Pick<TodayAgentPlanRow, "time" | "action" | "category" | "trigger">,
): TodayAgentPlanMetadata {
  const fingerprint = getTodayAgentPlanFingerprint(date, row);
  return {
    date,
    ref: `agent-plan:${date}:${fingerprint}`,
    fingerprint,
    time: row.time,
    action: row.action,
    category: row.category,
    trigger: row.trigger,
  };
}

export function readTodayAgentPlanMetadata(
  taskContext: Record<string, unknown>,
): TodayAgentPlanMetadata | null {
  const raw = taskContext.agentPlan;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const data = raw as Record<string, unknown>;
  const date = stringValue(data.date);
  const ref = stringValue(data.ref);
  const fingerprint = stringValue(data.fingerprint);
  const time = stringValue(data.time);
  const action = stringValue(data.action);
  const category = stringValue(data.category);
  const trigger = stringValue(data.trigger);
  if (
    !date ||
    !ref ||
    !fingerprint ||
    !time ||
    !action ||
    !isTodayAgentPlanCategory(category) ||
    !isTodayAgentPlanTrigger(trigger)
  ) {
    return null;
  }
  return { date, ref, fingerprint, time, action, category, trigger };
}

function findMarkdownSectionByName(
  lines: string[],
  sectionName: string,
): { bodyStart: number; bodyEnd: number } | null {
  const normalized = normalizeSection(sectionName);
  const headerIndex = lines.findIndex(
    (line) =>
      line.startsWith("## ") && normalizeSection(line.trim()) === normalized,
  );
  if (headerIndex < 0) return null;

  let bodyEnd = lines.length;
  for (let index = headerIndex + 1; index < lines.length; index++) {
    if (lines[index].startsWith("## ")) {
      bodyEnd = index;
      break;
    }
  }
  return { bodyStart: headerIndex + 1, bodyEnd };
}

function normalizeSection(name: string): string {
  return name
    .replace(/^#+\s*/, "")
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function isTodayAgentPlanCategory(
  value: string | null,
): value is TodayAgentPlanCategory {
  return (
    value === "work" ||
    value === "study" ||
    value === "personal" ||
    value === "home"
  );
}

function isTodayAgentPlanTrigger(
  value: string | null,
): value is TodayAgentPlanTrigger {
  return (
    value === "DM" ||
    value === "notify" ||
    value === "check-in" ||
    value === "wake"
  );
}
