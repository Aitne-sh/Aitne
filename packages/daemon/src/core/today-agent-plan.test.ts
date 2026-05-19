import { describe, expect, it } from "vitest";
import {
  buildTodayAgentPlanMetadata,
  extractTodayAgentPlanRows,
  extractTodayDate,
  getTodayAgentPlanFingerprint,
  normalizeAgentPlanAction,
  readTodayAgentPlanMetadata,
  type TodayAgentPlanCategory,
  type TodayAgentPlanTrigger,
} from "./today-agent-plan.js";

function todayContent(agentPlan: string): string {
  return [
    "# 2026-04-21 (Tue)",
    "> Day type: Weekday | Work focus: on | Study focus: on | Personal focus: on",
    "",
    "## User Schedule",
    "- (none)",
    "",
    "## Agent Plan",
    agentPlan,
    "",
    "## Agent Notes",
    "- note",
    "",
  ].join("\n");
}

describe("today-agent-plan", () => {
  it("extracts the canonical today date and returns null for placeholders", () => {
    expect(extractTodayDate(todayContent("- (none)"))).toBe("2026-04-21");
    expect(extractTodayDate("# 2026-04-22 (Wed)")).toBe("2026-04-22");
    expect(extractTodayDate("# Today\n")).toBeNull();
  });

  it("extracts valid Agent Plan rows and reports malformed rows", () => {
    const parsed = extractTodayAgentPlanRows(
      todayContent(
        [
          "",
          "- (none)",
          "not a list",
          "- [ ] 09:00 Send prep note [work] \u2192DM",
          "- [x] 10:00 Check labs [study] \u2192check-in extra",
          "- [ ] Send missing time [work] \u2192DM",
        ].join("\n"),
      ),
    );

    expect(parsed.rows).toMatchObject([
      {
        checked: false,
        time: "09:00",
        action: "Send prep note",
        category: "work",
        trigger: "DM",
      },
      {
        checked: true,
        time: "10:00",
        action: "Check labs",
        category: "study",
        trigger: "check-in",
      },
    ]);
    expect(parsed.invalidRows).toEqual([
      { line: 13, raw: "- [ ] Send missing time [work] \u2192DM" },
    ]);
  });

  it("returns no rows when the Agent Plan section is absent", () => {
    expect(extractTodayAgentPlanRows("# 2026-04-21 (Tue)\n").rows).toEqual([]);
  });

  it("normalizes action text and builds stable metadata", () => {
    const row = {
      time: "09:00",
      action: "  Send   Prep Note  ",
      category: "work" as const,
      trigger: "DM" as const,
    };

    expect(normalizeAgentPlanAction(row.action)).toBe("send prep note");
    expect(getTodayAgentPlanFingerprint("2026-04-21", row)).toBe(
      getTodayAgentPlanFingerprint("2026-04-21", {
        ...row,
        action: "send prep note",
      }),
    );
    expect(buildTodayAgentPlanMetadata("2026-04-21", row)).toMatchObject({
      date: "2026-04-21",
      ref: expect.stringMatching(/^agent-plan:2026-04-21:/),
      time: "09:00",
      action: row.action,
      category: "work",
      trigger: "DM",
    });
  });

  it("reads metadata only when the stored shape is complete and valid", () => {
    const metadata = buildTodayAgentPlanMetadata("2026-04-21", {
      time: "09:00",
      action: "Send prep note",
      category: "home",
      trigger: "wake",
    });

    expect(readTodayAgentPlanMetadata({ agentPlan: metadata })).toEqual(
      metadata,
    );
    expect(readTodayAgentPlanMetadata({})).toBeNull();
    expect(readTodayAgentPlanMetadata({ agentPlan: [] })).toBeNull();
    expect(
      readTodayAgentPlanMetadata({
        agentPlan: { ...metadata, category: "bad" },
      }),
    ).toBeNull();
    expect(
      readTodayAgentPlanMetadata({
        agentPlan: { ...metadata, trigger: "bad" },
      }),
    ).toBeNull();
    expect(
      readTodayAgentPlanMetadata({
        agentPlan: { ...metadata, date: "" },
      }),
    ).toBeNull();
  });

  it("accepts every allowed category and trigger in stored metadata", () => {
    const categories: TodayAgentPlanCategory[] = [
      "work",
      "study",
      "personal",
      "home",
    ];
    const triggers: TodayAgentPlanTrigger[] = [
      "DM",
      "notify",
      "check-in",
      "wake",
    ];

    for (const category of categories) {
      for (const trigger of triggers) {
        const metadata = buildTodayAgentPlanMetadata("2026-04-21", {
          time: "09:00",
          action: `${category} ${trigger}`,
          category,
          trigger,
        });
        expect(readTodayAgentPlanMetadata({ agentPlan: metadata })).toEqual(
          metadata,
        );
      }
    }
  });
});
