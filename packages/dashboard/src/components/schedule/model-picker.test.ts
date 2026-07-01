import { describe, expect, it } from "vitest";
import {
  describeModelValue,
  projectModelOptions,
  type ModelOptionGroup,
} from "./model-picker";
import type { ScheduleOptionsResponse } from "@/lib/api-types";

/**
 * Synthetic `/schedule/options` snapshot — kept structurally identical to
 * the live response (see `packages/daemon/src/api/routes/schedule-options.ts`
 * and `schedule-options.test.ts`). Mixing deprecated entries in so the
 * picker's "deprecated" tag path stays covered.
 */
function fakeOptions(): ScheduleOptionsResponse {
  return {
    tiers: ["lite", "medium", "high"],
    modelAliases: { sonnet: "medium", opus: "high" },
    models: {
      claude: [
        { id: "claude-haiku-4-5-20251001", tier: "lite", deprecated: false },
        { id: "claude-sonnet-5", tier: "medium", deprecated: false },
        { id: "claude-sonnet-4-6", tier: "medium", deprecated: true },
        { id: "claude-opus-4-6", tier: "high", deprecated: true },
        { id: "claude-opus-4-7", tier: "high", deprecated: false },
      ],
      codex: [{ id: "gpt-5.4", tier: "high", deprecated: false }],
      gemini: [
        { id: "gemini-3.1-pro-preview", tier: "high", deprecated: false },
      ],
      opencode: [
        { id: "anthropic/claude-opus-4-7", tier: "high", deprecated: false },
      ],
    },
    frequencies: ["hourly", "daily", "weekly", "monthly"],
    daysOfWeek: {
      "0": "Sun",
      "1": "Mon",
      "2": "Tue",
      "3": "Wed",
      "4": "Thu",
      "5": "Fri",
      "6": "Sat",
    },
    recurrence: {
      intervalHours: { min: 1, max: 23 },
      minuteOfHour: { min: 0, max: 59 },
      daysOfMonth: { min: 1, max: 31 },
      onMissingDay: {
        values: ["skip", "lastDayOfMonth"],
        default: "lastDayOfMonth",
      },
    },
    timeFormat: "HH:MM (24h)",
    timezoneExample: "Asia/Tokyo",
    defaults: { timezone: "Asia/Tokyo" },
  };
}

describe("projectModelOptions", () => {
  it("returns an empty list while the query is in flight", () => {
    expect(projectModelOptions(undefined)).toEqual([]);
  });

  it("emits a 'Tier aliases' group followed by per-backend groups", () => {
    const groups = projectModelOptions(fakeOptions());
    expect(groups.length).toBeGreaterThan(0);
    const labels = groups.map((g) => g.label);
    expect(labels[0]).toBe("Tier aliases");
    // Aliases come BEFORE registered backends so the LLM's default picks
    // map to tier presets (the canonical persistence path).
    expect(labels.indexOf("Claude Code")).toBeGreaterThan(0);
  });

  it("rewrites legacy aliases to a friendly label with the resolved tier hint", () => {
    const groups = projectModelOptions(fakeOptions());
    const aliasGroup = groups.find((g) => g.label === "Tier aliases");
    expect(aliasGroup).toBeDefined();
    expect(aliasGroup?.options).toEqual([
      { value: "sonnet", label: "Sonnet", hint: "Legacy alias → medium tier" },
      { value: "opus", label: "Opus", hint: "Legacy alias → high tier" },
    ]);
  });

  it("preserves deprecated entries with a 'deprecated' tag in the hint", () => {
    // §5.0.5 — the daemon still accepts a deprecated pin and surfaces a
    // warning; the dashboard surfaces the entry so an operator who knows
    // they pinned to a deprecated id can see the row exists. The picker
    // shows them rather than hiding them so an editing user can preserve
    // their existing pin if they want.
    const groups = projectModelOptions(fakeOptions());
    const claude = groups.find((g) => g.label === "Claude Code");
    const opus46 = claude?.options.find((o) => o.value === "claude-opus-4-6");
    expect(opus46?.deprecated).toBe(true);
    expect(opus46?.hint).toContain("deprecated");
  });

  it("excludes preview-only backends per isBackendSelectionDisabled (opencode today)", () => {
    // The dashboard gate is shared with the rest of the UI — see
    // `lib/backend-ui.ts:UI_PREVIEW_ONLY_BACKEND_IDS`. The daemon would
    // accept an opencode model in the wire payload, but until the gate
    // lifts we don't surface it from the picker.
    const groups = projectModelOptions(fakeOptions());
    const labels = groups.map((g) => g.label);
    expect(labels).not.toContain("OpenCode");
  });

  it("skips backends with an empty model list", () => {
    const data = fakeOptions();
    data.models.codex = [];
    const groups = projectModelOptions(data);
    const labels = groups.map((g) => g.label);
    expect(labels).not.toContain("OpenAI Codex");
  });

  it("appends the upstream deprecation suffix to the Gemini group label", () => {
    // Google I/O 2026 sunset advisory — the operator should see Gemini is
    // about to go dark for free/Pro/Ultra accounts before they bind a
    // new recurring schedule to a Gemini model.
    const groups = projectModelOptions(fakeOptions());
    const labels = groups.map((g) => g.label);
    const geminiLabel = labels.find((l) => l.startsWith("Gemini CLI"));
    expect(geminiLabel).toBeDefined();
    expect(geminiLabel).toMatch(/deprecat/i);
    // Non-deprecated backends keep their plain label — only the affected
    // group carries the suffix.
    expect(labels).toContain("Claude Code");
    expect(labels).toContain("OpenAI Codex");
  });
});

describe("describeModelValue", () => {
  function exampleGroups(): ModelOptionGroup[] {
    return projectModelOptions(fakeOptions());
  }

  it("returns the 'Default (process config)' label for an empty value", () => {
    expect(describeModelValue("", exampleGroups())).toBe(
      "Default (process config)",
    );
  });

  it("returns the matching option's label for a registered id", () => {
    expect(
      describeModelValue("claude-opus-4-7", exampleGroups()),
    ).toBe("claude-opus-4-7");
  });

  it("tags deprecated entries so the trigger surfaces the status", () => {
    expect(
      describeModelValue("claude-opus-4-6", exampleGroups()),
    ).toBe("claude-opus-4-6 (deprecated)");
  });

  it("surfaces unrecognised values rather than silently swallowing them", () => {
    // Existing pins to a model the registry no longer carries (e.g. after
    // a registry version bump) keep their pin until the user edits — the
    // trigger shows the value verbatim so the operator can decide whether
    // to leave it or switch.
    expect(
      describeModelValue("gpt-9000-mythical", exampleGroups()),
    ).toBe("gpt-9000-mythical (unrecognised)");
  });
});
