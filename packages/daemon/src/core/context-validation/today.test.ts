import { describe, it, expect } from "vitest";
import {
  TODAY_DAY_TYPE_RE,
  TODAY_H1_RE,
  TODAY_REQUIRED_SECTIONS,
  isLegacyTodayContent,
  toTodayScheduleCandidate,
  validateTodayContent,
} from "./today.js";

function validTodayContent(
  agentPlan = "- [ ] 09:00 Send prep note [work] →DM",
  date = "2026-04-22",
): string {
  return [
    `# ${date} (Day)`,
    "> Day type: Weekday | Work focus: on | Study focus: on | Personal focus: on",
    "",
    "## User Schedule",
    "- (none)",
    "",
    "## User Tasks",
    "- (none)",
    "",
    "## Agent Plan",
    agentPlan,
    "",
    "## Agent Notes",
    "- (none)",
    "",
    "## Agent Log",
    "- (none)",
    "",
    "## Handoff",
    "- (none)",
    "",
  ].join("\n");
}

describe("TODAY_H1_RE", () => {
  it("accepts canonical H1 with localized weekday", () => {
    expect(TODAY_H1_RE.test("# 2026-04-22 (Day)")).toBe(true);
    expect(TODAY_H1_RE.test("# 2026-04-22")).toBe(true);
  });

  it("rejects non-canonical H1", () => {
    expect(TODAY_H1_RE.test("# Today")).toBe(false);
    expect(TODAY_H1_RE.test("# 2026/04/22")).toBe(false);
  });
});

describe("TODAY_DAY_TYPE_RE", () => {
  it("accepts canonical day-type line", () => {
    expect(
      TODAY_DAY_TYPE_RE.test(
        "> Day type: Weekday | Work focus: on | Study focus: on | Personal focus: on",
      ),
    ).toBe(true);
    expect(
      TODAY_DAY_TYPE_RE.test(
        "> Day type: Weekend | Work focus: off | Study focus: off | Personal focus: off",
      ),
    ).toBe(true);
  });

  it("rejects translated or reworded variants", () => {
    expect(
      TODAY_DAY_TYPE_RE.test(
        "> Daytype: Workday | WorkFocus: on | StudyFocus: on | PersonalFocus: on",
      ),
    ).toBe(false);
  });
});

describe("TODAY_REQUIRED_SECTIONS", () => {
  it("lists the six canonical section headers in order", () => {
    expect(TODAY_REQUIRED_SECTIONS).toEqual([
      "User Schedule",
      "User Tasks",
      "Agent Plan",
      "Agent Notes",
      "Agent Log",
      "Handoff",
    ]);
  });
});

describe("isLegacyTodayContent", () => {
  it("returns true for the legacy `# Today` first line", () => {
    expect(isLegacyTodayContent("# Today\n\n## Agent Log\n")).toBe(true);
  });

  it("returns false for a canonical H1", () => {
    expect(isLegacyTodayContent("# 2026-04-22 (Day)\n")).toBe(false);
  });
});

describe("validateTodayContent", () => {
  it("accepts a canonical today.md with a valid Agent Plan row", () => {
    expect(validateTodayContent(validTodayContent())).toBeNull();
  });

  it("rejects a today.md missing a required section", () => {
    const content = validTodayContent().replace("\n## User Tasks\n- (none)\n", "\n");
    expect(validateTodayContent(content)).toContain("## User Tasks");
  });

  it("rejects malformed day-type headers", () => {
    const content = validTodayContent().replace(
      "> Day type: Weekday | Work focus: on | Study focus: on | Personal focus: on",
      "> Day: Weekday",
    );
    expect(validateTodayContent(content)).toContain("line 2");
  });

  it("line-2 error message warns against keyword translation and rewording", () => {
    const reworded = validTodayContent().replace(
      "> Day type: Weekday | Work focus: on | Study focus: on | Personal focus: on",
      "> Daytype: Workday | WorkFocus: on | StudyFocus: on | PersonalFocus: on",
    );
    const message = validateTodayContent(reworded);
    expect(message).toContain("line 2");
    expect(message).toContain("translate");
    expect(message).toContain("Day type");
    expect(message).toContain("output_language_policy");
  });

  it("line-1 error message clarifies the H1 stays English skeleton", () => {
    const message = validateTodayContent("# Today\n\n## Agent Log\n");
    expect(message).toContain("line 1");
    expect(message).toContain("ASCII");
  });

  it("rejects malformed Agent Plan rows", () => {
    const content = validTodayContent("- [ ] Send prep note [work] →DM");
    expect(validateTodayContent(content)).toContain("Agent Plan line");
  });

  it("rejects legacy scratch today.md on full validation", () => {
    expect(validateTodayContent("# Today\n\n## Agent Log\n")).toContain("line 1");
  });

  it("allows legacy scratch today.md when explicitly opted-in", () => {
    expect(
      validateTodayContent("# Today\n\n## Agent Log\n", { allowLegacyToday: true }),
    ).toBeNull();
  });

  it("rejects when line-1 date does not match expectedAgentDay", () => {
    const message = validateTodayContent(validTodayContent(undefined, "2026-04-21"), {
      expectedAgentDay: "2026-04-22",
    });
    expect(message).toContain("2026-04-21");
    expect(message).toContain("2026-04-22");
    expect(message).toContain("<current_agent_day");
  });

  it("accepts when line-1 date matches expectedAgentDay", () => {
    const message = validateTodayContent(validTodayContent(undefined, "2026-04-22"), {
      expectedAgentDay: "2026-04-22",
    });
    expect(message).toBeNull();
  });

  it("does not enforce expectedAgentDay when not supplied", () => {
    const message = validateTodayContent(validTodayContent(undefined, "2026-04-21"));
    expect(message).toBeNull();
  });

  it("rejects single-line H1-only content (line 2 missing → fallback)", () => {
    // Exercises the `lines[1] ?? ""` defensive branch — content with a
    // valid line 1 but no line 2 at all. Real morning routines never
    // hit this, but the validator must still surface the line-2 error.
    const message = validateTodayContent("# 2026-04-22 (Day)");
    expect(message).toContain("line 2");
  });
});

describe("toTodayScheduleCandidate", () => {
  const baseRow = {
    id: 42,
    scheduled_for: "2026-04-22 09:00:00",
    task_type: "morning_routine",
    task_description: "Run morning",
    task_context: null as string | null,
    status: "pending",
  };

  it("projects a valid row into a candidate with localized date/time", () => {
    const candidate = toTodayScheduleCandidate(baseRow, "UTC");
    expect(candidate).not.toBeNull();
    expect(candidate!.id).toBe(42);
    expect(candidate!.localDate).toBe("2026-04-22");
    expect(candidate!.localTime).toBe("09:00");
    expect(candidate!.taskType).toBe("morning_routine");
    expect(candidate!.status).toBe("pending");
    expect(candidate!.description).toBe("Run morning");
    expect(candidate!.taskContext).toEqual({});
    expect(candidate!.scheduledFor).toBe("2026-04-22 09:00:00");
  });

  it("accepts ISO-T form scheduled_for", () => {
    const candidate = toTodayScheduleCandidate(
      { ...baseRow, scheduled_for: "2026-04-22T09:00:00Z" },
      "UTC",
    );
    expect(candidate).not.toBeNull();
    expect(candidate!.localTime).toBe("09:00");
  });

  it("returns null for unparseable scheduled_for", () => {
    expect(
      toTodayScheduleCandidate({ ...baseRow, scheduled_for: "not-a-date" }, "UTC"),
    ).toBeNull();
  });

  it("lifts well-formed JSON task_context into an object", () => {
    const candidate = toTodayScheduleCandidate(
      { ...baseRow, task_context: '{"agentPlan":{"key":"value"}}' },
      "UTC",
    );
    expect(candidate!.taskContext).toEqual({ agentPlan: { key: "value" } });
  });

  it("returns {} for corrupt JSON task_context", () => {
    const candidate = toTodayScheduleCandidate(
      { ...baseRow, task_context: "{not json" },
      "UTC",
    );
    expect(candidate!.taskContext).toEqual({});
  });

  it("returns {} when task_context is an array or scalar", () => {
    expect(
      toTodayScheduleCandidate({ ...baseRow, task_context: "[1,2,3]" }, "UTC")!
        .taskContext,
    ).toEqual({});
    expect(
      toTodayScheduleCandidate({ ...baseRow, task_context: "42" }, "UTC")!.taskContext,
    ).toEqual({});
  });

  it("returns {} when task_context is null", () => {
    const candidate = toTodayScheduleCandidate(
      { ...baseRow, task_context: null },
      "UTC",
    );
    expect(candidate!.taskContext).toEqual({});
  });
});
