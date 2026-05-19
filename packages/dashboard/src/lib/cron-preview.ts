const MONTH_ALIASES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const WEEKDAY_ALIASES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const WEEKDAY_FROM_PART: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

type CronFieldSpec = {
  matches: (value: number) => boolean;
  isWildcard: boolean;
};

type ParsedCron = {
  minute: CronFieldSpec;
  hour: CronFieldSpec;
  dayOfMonth: CronFieldSpec;
  month: CronFieldSpec;
  dayOfWeek: CronFieldSpec;
};

type CronFieldKind = "minute" | "hour" | "dayOfMonth" | "month" | "dayOfWeek";

export type CronPreviewResult =
  | { ok: true; nextRuns: Date[] }
  | { ok: false; error: string };

type ParsedCronResult =
  | { ok: true; value: ParsedCron }
  | { ok: false; error: string };

export function previewCronSchedule(
  expression: string,
  timeZone: string,
  options: {
    from?: Date;
    count?: number;
  } = {},
): CronPreviewResult {
  const parsed = parseCronExpression(expression);
  if (!parsed.ok) {
    return parsed;
  }

  const count = options.count ?? 3;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  });

  const nextRuns: Date[] = [];
  const start = options.from ?? new Date();
  let cursor = new Date(Math.floor(start.getTime() / 60_000) * 60_000 + 60_000);
  let scanned = 0;
  const maxScannedMinutes = 366 * 24 * 60;

  while (nextRuns.length < count && scanned < maxScannedMinutes) {
    if (matchesCron(parsed.value, formatter, cursor)) {
      nextRuns.push(new Date(cursor));
    }
    cursor = new Date(cursor.getTime() + 60_000);
    scanned += 1;
  }

  if (nextRuns.length === 0) {
    return {
      ok: false,
      error: "No upcoming runs found within the next year for this timezone.",
    };
  }

  return { ok: true, nextRuns };
}

function matchesCron(parsed: ParsedCron, formatter: Intl.DateTimeFormat, date: Date): boolean {
  const parts = zonedDateParts(formatter, date);
  if (!parsed.minute.matches(parts.minute)) return false;
  if (!parsed.hour.matches(parts.hour)) return false;
  if (!parsed.month.matches(parts.month)) return false;

  const dayOfMonthMatch = parsed.dayOfMonth.matches(parts.day);
  const dayOfWeekMatch = parsed.dayOfWeek.matches(parts.weekday);

  if (parsed.dayOfMonth.isWildcard && parsed.dayOfWeek.isWildcard) {
    return true;
  }
  if (parsed.dayOfMonth.isWildcard) {
    return dayOfWeekMatch;
  }
  if (parsed.dayOfWeek.isWildcard) {
    return dayOfMonthMatch;
  }
  return dayOfMonthMatch || dayOfWeekMatch;
}

function zonedDateParts(formatter: Intl.DateTimeFormat, date: Date) {
  const raw = formatter.formatToParts(date);
  const get = (type: string) => raw.find((part) => part.type === type)?.value ?? "";
  return {
    minute: Number(get("minute")),
    hour: Number(get("hour")),
    day: Number(get("day")),
    month: Number(get("month")),
    weekday: WEEKDAY_FROM_PART[get("weekday")] ?? -1,
  };
}

function parseCronExpression(expression: string): ParsedCronResult {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    return {
      ok: false,
      error: "Cron must have exactly 5 fields: minute hour day-of-month month day-of-week.",
    };
  }

  const minute = parseField(fields[0], "minute");
  if (!minute.ok) return minute;
  const hour = parseField(fields[1], "hour");
  if (!hour.ok) return hour;
  const dayOfMonth = parseField(fields[2], "dayOfMonth");
  if (!dayOfMonth.ok) return dayOfMonth;
  const month = parseField(fields[3], "month");
  if (!month.ok) return month;
  const dayOfWeek = parseField(fields[4], "dayOfWeek");
  if (!dayOfWeek.ok) return dayOfWeek;

  return {
    ok: true,
    value: {
      minute: minute.value,
      hour: hour.value,
      dayOfMonth: dayOfMonth.value,
      month: month.value,
      dayOfWeek: dayOfWeek.value,
    },
  };
}

function parseField(
  raw: string,
  kind: CronFieldKind,
): ({ ok: true; value: CronFieldSpec } | { ok: false; error: string }) {
  const normalized = normalizeAliases(raw, kind);
  if (normalized.length === 0) {
    return { ok: false, error: `Cron ${fieldLabel(kind)} field is empty.` };
  }

  const domain = fieldDomain(kind);
  const values = new Set<number>();

  for (const segment of normalized.split(",")) {
    if (!segment) {
      return { ok: false, error: `Cron ${fieldLabel(kind)} field has an empty list item.` };
    }

    const [rangePart, stepPart] = segment.split("/");
    if (segment.split("/").length > 2) {
      return { ok: false, error: `Cron ${fieldLabel(kind)} field has an invalid step: \`${segment}\`.` };
    }

    const step =
      stepPart === undefined
        ? 1
        : Number.parseInt(stepPart, 10);
    if (!Number.isInteger(step) || step <= 0) {
      return { ok: false, error: `Cron ${fieldLabel(kind)} step must be a positive integer.` };
    }

    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = domain.min;
      end = domain.max;
    } else if (rangePart.includes("-")) {
      const [rawStart, rawEnd] = rangePart.split("-");
      start = parseFieldValue(rawStart, kind);
      end = parseFieldValue(rawEnd, kind);
      if (Number.isNaN(start) || Number.isNaN(end) || start > end) {
        return { ok: false, error: `Cron ${fieldLabel(kind)} range is invalid: \`${segment}\`.` };
      }
    } else {
      start = parseFieldValue(rangePart, kind);
      end = start;
      if (Number.isNaN(start)) {
        return { ok: false, error: `Cron ${fieldLabel(kind)} value is invalid: \`${segment}\`.` };
      }
    }

    if (start < domain.min || end > domain.max) {
      return {
        ok: false,
        error: `Cron ${fieldLabel(kind)} values must stay within ${domain.min}-${domain.max}.`,
      };
    }

    for (let value = start; value <= end; value += step) {
      values.add(normalizeDomainValue(value, kind));
    }
  }

  if (values.size === 0) {
    return { ok: false, error: `Cron ${fieldLabel(kind)} field produced no values.` };
  }

  const fullSize = kind === "dayOfWeek" ? 7 : domain.max - domain.min + 1;
  return {
    ok: true,
    value: {
      matches: (value) => values.has(normalizeDomainValue(value, kind)),
      isWildcard: values.size === fullSize,
    },
  };
}

function normalizeAliases(raw: string, kind: CronFieldKind): string {
  const aliases = kind === "month" ? MONTH_ALIASES : kind === "dayOfWeek" ? WEEKDAY_ALIASES : null;
  if (!aliases) return raw.toLowerCase();
  return raw.toLowerCase().replace(/[a-z]{3}/g, (token) => {
    const replacement = aliases[token];
    return replacement === undefined ? token : String(replacement);
  });
}

function parseFieldValue(value: string, kind: CronFieldKind): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return Number.NaN;
  return parsed;
}

function normalizeDomainValue(value: number, kind: CronFieldKind): number {
  if (kind === "dayOfWeek" && value === 7) {
    return 0;
  }
  return value;
}

function fieldDomain(kind: CronFieldKind): { min: number; max: number } {
  switch (kind) {
    case "minute":
      return { min: 0, max: 59 };
    case "hour":
      return { min: 0, max: 23 };
    case "dayOfMonth":
      return { min: 1, max: 31 };
    case "month":
      return { min: 1, max: 12 };
    case "dayOfWeek":
      return { min: 0, max: 7 };
  }
}

function fieldLabel(kind: CronFieldKind): string {
  switch (kind) {
    case "minute":
      return "minute";
    case "hour":
      return "hour";
    case "dayOfMonth":
      return "day-of-month";
    case "month":
      return "month";
    case "dayOfWeek":
      return "day-of-week";
  }
}
