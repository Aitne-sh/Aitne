import { describe, expect, it } from "vitest";
import {
  enumerateCustomRoutines,
  parseCustomRoutineSpec,
  slugFromCustomRoutinePath,
} from "./custom-routines.js";

function fm(fields: Record<string, string>, body = "# Body"): string {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fields)) {
    lines.push(`${k}: ${v}`);
  }
  lines.push("---");
  lines.push("");
  lines.push(body);
  return lines.join("\n");
}

describe("parseCustomRoutineSpec edge cases", () => {
  it("rejects CRLF-only frontmatter without a closing delimiter", () => {
    // Exercises the CRLF branch of extractFrontmatter + endIdx < 0 path.
    const body = "---\r\nfield: 1\r\nno-close-delim\r\n";
    const result = parseCustomRoutineSpec("good", body);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("no_frontmatter");
    }
  });

  it("strips single-quoted scalar values from frontmatter", () => {
    const body = [
      "---",
      "type: rule",
      "slug: quoted-slug",
      "cron: '0 * * * *'",
      "process_key: routine.custom.quoted-slug",
      "enabled: true",
      "backend_tier: light",
      "max_budget_usd: 0.05",
      "---",
      "",
      "## Checks",
      "",
    ].join("\n");
    const result = parseCustomRoutineSpec("quoted-slug", body);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.cron).toBe("0 * * * *");
    }
  });
});

describe("parseCustomRoutineSpec", () => {
  it("accepts a complete frontmatter block", () => {
    const result = parseCustomRoutineSpec(
      "tuesday-notion",
      fm({
        type: "rule",
        slug: "tuesday-notion",
        cron: '"0 11 * * 2"',
        process_key: "routine.custom.tuesday-notion",
        enabled: "true",
        backend_tier: "light",
        max_budget_usd: "0.05",
      }, "## Checks"),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec).toEqual({
        slug: "tuesday-notion",
        cron: "0 11 * * 2",
        enabled: true,
        backendTier: "medium",
        maxBudgetUsd: 0.05,
        processKey: "routine.custom.tuesday-notion",
      });
    }
  });

  it("requires enabled explicitly", () => {
    const result = parseCustomRoutineSpec(
      "foo",
      fm({
        type: "rule",
        slug: "foo",
        cron: "0 * * * *",
        process_key: "routine.custom.foo",
        backend_tier: "heavy",
        max_budget_usd: "1",
      }, "## Checks"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "missing_field") {
      expect(result.error.field).toBe("enabled");
    }
  });

  it("treats enabled: false as disabled", () => {
    const result = parseCustomRoutineSpec(
      "foo",
      fm({
        type: "rule",
        slug: "foo",
        cron: "0 * * * *",
        process_key: "routine.custom.foo",
        enabled: "false",
        backend_tier: "light",
        max_budget_usd: "0.1",
      }, "## Checks"),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec.enabled).toBe(false);
  });

  it("rejects invalid cron", () => {
    const result = parseCustomRoutineSpec(
      "foo",
      fm({
        type: "rule",
        slug: "foo",
        cron: "not a cron",
        process_key: "routine.custom.foo",
        enabled: "true",
        backend_tier: "light",
        max_budget_usd: "0.1",
      }, "## Checks"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid_cron");
  });

  it("rejects invalid slug", () => {
    const result = parseCustomRoutineSpec(
      "Bad Slug",
      fm({
        type: "rule",
        slug: "Bad Slug",
        cron: "0 * * * *",
        process_key: "routine.custom.Bad Slug",
        enabled: "true",
        backend_tier: "light",
        max_budget_usd: "0.1",
      }, "## Checks"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid_slug");
  });

  it("rejects missing frontmatter", () => {
    const result = parseCustomRoutineSpec("foo", "no frontmatter here\n");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("no_frontmatter");
  });

  it("rejects frontmatter slug that does not match the filename slug", () => {
    const result = parseCustomRoutineSpec(
      "foo",
      fm({
        type: "rule",
        slug: "bar",
        cron: "0 * * * *",
        process_key: "routine.custom.foo",
        enabled: "true",
        backend_tier: "light",
        max_budget_usd: "0.1",
      }, "## Checks"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("invalid_slug");
      expect((result.error as { kind: string; value: string }).value).toBe("bar");
    }
  });

  it.each([
    ["type", fm({ slug: "foo", cron: "0 * * * *", process_key: "routine.custom.foo", enabled: "true", backend_tier: "light", max_budget_usd: "0.1" }, "## Checks")],
    ["slug", fm({ type: "rule", cron: "0 * * * *", process_key: "routine.custom.foo", enabled: "true", backend_tier: "light", max_budget_usd: "0.1" }, "## Checks")],
    ["cron", fm({ type: "rule", slug: "foo", process_key: "routine.custom.foo", enabled: "true", backend_tier: "light", max_budget_usd: "0.1" }, "## Checks")],
    ["process_key", fm({ type: "rule", slug: "foo", cron: "0 * * * *", enabled: "true", backend_tier: "light", max_budget_usd: "0.1" }, "## Checks")],
    ["enabled", fm({ type: "rule", slug: "foo", cron: "0 * * * *", process_key: "routine.custom.foo", backend_tier: "light", max_budget_usd: "0.1" }, "## Checks")],
    ["backend_tier", fm({ type: "rule", slug: "foo", cron: "0 * * * *", process_key: "routine.custom.foo", enabled: "true", max_budget_usd: "0.1" }, "## Checks")],
    ["max_budget_usd", fm({ type: "rule", slug: "foo", cron: "0 * * * *", process_key: "routine.custom.foo", enabled: "true", backend_tier: "light" }, "## Checks")],
  ])("rejects missing required field %s", (field, body) => {
    const result = parseCustomRoutineSpec("foo", body);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "missing_field") {
      expect(result.error.field).toBe(field);
    }
  });

  it("rejects non-positive or non-numeric budget", () => {
    for (const budget of ["-0.1", "0", "abc", ""]) {
      const result = parseCustomRoutineSpec(
        "foo",
        fm({
          type: "rule",
          slug: "foo",
          cron: "0 * * * *",
          process_key: "routine.custom.foo",
          enabled: "true",
          backend_tier: "light",
          max_budget_usd: budget,
        }, "## Checks"),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Empty budget looks like a missing field rather than invalid.
        expect(["invalid_budget", "missing_field"]).toContain(result.error.kind);
      }
    }
  });

  it("rejects unknown tier values", () => {
    const result = parseCustomRoutineSpec(
      "foo",
      fm({
        type: "rule",
        slug: "foo",
        cron: "0 * * * *",
        process_key: "routine.custom.foo",
        enabled: "true",
        backend_tier: "extreme",
        max_budget_usd: "0.1",
      }, "## Checks"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid_tier");
  });

  it("rejects non-rule type, mismatched process key, invalid enabled, and missing checks section", () => {
    const wrongType = parseCustomRoutineSpec(
      "foo",
      fm({
        type: "index",
        slug: "foo",
        cron: "0 * * * *",
        process_key: "routine.custom.foo",
        enabled: "true",
        backend_tier: "light",
        max_budget_usd: "0.1",
      }, "## Checks"),
    );
    expect(wrongType.ok).toBe(false);
    if (!wrongType.ok) expect(wrongType.error.kind).toBe("invalid_type");

    const wrongProcessKey = parseCustomRoutineSpec(
      "foo",
      fm({
        type: "rule",
        slug: "foo",
        cron: "0 * * * *",
        process_key: "routine.custom.bar",
        enabled: "true",
        backend_tier: "light",
        max_budget_usd: "0.1",
      }, "## Checks"),
    );
    expect(wrongProcessKey.ok).toBe(false);
    if (!wrongProcessKey.ok) expect(wrongProcessKey.error.kind).toBe("invalid_process_key");

    const invalidEnabled = parseCustomRoutineSpec(
      "foo",
      fm({
        type: "rule",
        slug: "foo",
        cron: "0 * * * *",
        process_key: "routine.custom.foo",
        enabled: "yes",
        backend_tier: "light",
        max_budget_usd: "0.1",
      }, "## Checks"),
    );
    expect(invalidEnabled.ok).toBe(false);
    if (!invalidEnabled.ok) expect(invalidEnabled.error.kind).toBe("invalid_enabled");

    const noChecks = parseCustomRoutineSpec(
      "foo",
      fm({
        type: "rule",
        slug: "foo",
        cron: "0 * * * *",
        process_key: "routine.custom.foo",
        enabled: "true",
        backend_tier: "light",
        max_budget_usd: "0.1",
      }, "# Body"),
    );
    expect(noChecks.ok).toBe(false);
    if (!noChecks.ok) expect(noChecks.error.kind).toBe("missing_checks_section");
  });
});

describe("enumerateCustomRoutines", () => {
  it("parses every .md file in the custom dir and surfaces errors", () => {
    const files = new Map<string, string>([
      [
        "policies/routines/custom/good.md",
        fm({
          type: "rule",
          slug: "good",
          cron: "0 * * * *",
          process_key: "routine.custom.good",
          enabled: "true",
          backend_tier: "light",
          max_budget_usd: "0.05",
        }, "## Checks"),
      ],
      [
        "policies/routines/custom/bad.md",
        fm({
          type: "rule",
          slug: "bad",
          enabled: "true",
          backend_tier: "light",
          max_budget_usd: "0.05",
        }, "## Checks"),
      ],
      ["policies/routines/custom/notes.txt", "ignored — not markdown"],
    ]);

    const result = enumerateCustomRoutines("/context", {
      readDir: (dir) => {
        expect(dir).toBe("/context/policies/routines/custom");
        return ["good.md", "bad.md", "notes.txt"];
      },
      readFile: (path) => files.get(path.replace("/context/", "")) ?? "",
    });
    expect(result.specs.map((s) => s.slug)).toEqual(["good"]);
    expect(result.errors.map((e) => e.slug)).toEqual(["bad"]);
  });

  it("returns empty result when the directory does not exist", () => {
    const result = enumerateCustomRoutines("/ctx", {
      readDir: () => [],
    });
    expect(result.specs).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("default reader returns empty for a missing directory (no injected readers)", () => {
    const result = enumerateCustomRoutines("/nonexistent-path-for-custom-routines-test");
    expect(result.specs).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("skips files whose readFile throws (e.g. permission or race with delete)", () => {
    const result = enumerateCustomRoutines("/ctx", {
      readDir: () => ["good.md", "broken.md"],
      readFile: (path) => {
        if (path.endsWith("broken.md")) {
          throw new Error("simulated read failure");
        }
        return fm({
          type: "rule",
          slug: "good",
          cron: "0 * * * *",
          process_key: "routine.custom.good",
          enabled: "true",
          backend_tier: "light",
          max_budget_usd: "0.05",
        }, "## Checks");
      },
    });
    // broken.md is silently skipped — no error entry, since we can't parse
    // what we can't read. good.md still parses successfully.
    expect(result.specs.map((s) => s.slug)).toEqual(["good"]);
    expect(result.errors).toEqual([]);
  });
});

describe("slugFromCustomRoutinePath", () => {
  it("extracts valid slug", () => {
    expect(slugFromCustomRoutinePath("policies/routines/custom/my-slug.md")).toBe("my-slug");
  });

  it("rejects non-markdown and nested paths", () => {
    expect(slugFromCustomRoutinePath("policies/routines/custom/x.txt")).toBe(null);
    expect(slugFromCustomRoutinePath("policies/routines/custom/sub/y.md")).toBe(null);
    expect(slugFromCustomRoutinePath("policies/routines/activity-scan.md")).toBe(null);
  });
});
