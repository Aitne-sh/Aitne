import { describe, expect, it } from "vitest";
import { browserHistoryLifecycleConfigSchema } from "./browser-history-schemas.js";

describe("browserHistoryLifecycleConfigSchema.superRefine", () => {
  it("accepts an empty per_browser map (default branch)", () => {
    const parsed = browserHistoryLifecycleConfigSchema.parse({});
    expect(parsed.per_browser).toEqual({});
  });

  it("accepts per_browser entries keyed by a known browser", () => {
    const parsed = browserHistoryLifecycleConfigSchema.parse({
      per_browser: {
        chrome: { enabled: true },
        edge: { enabled: false },
      },
    });
    expect(Object.keys(parsed.per_browser).sort()).toEqual(["chrome", "edge"]);
  });

  it("rejects per_browser keyed by an unknown browser with a path-scoped issue", () => {
    const result = browserHistoryLifecycleConfigSchema.safeParse({
      per_browser: { netscape: { enabled: true } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = result.error.issues.filter((i) =>
        i.path.join(".") === "per_browser.netscape",
      );
      expect(issues.length).toBeGreaterThan(0);
      expect(issues[0]?.message).toContain("netscape");
    }
  });

  it("reports one issue per unknown key when several are present", () => {
    const result = browserHistoryLifecycleConfigSchema.safeParse({
      per_browser: {
        chrome: { enabled: true }, // valid, must not be flagged
        opera: { enabled: true },
        vivaldi: { enabled: true },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const unknownPaths = result.error.issues
        .map((i) => i.path.join("."))
        .filter((p) => p.startsWith("per_browser.") && p !== "per_browser.chrome");
      expect(unknownPaths.sort()).toEqual([
        "per_browser.opera",
        "per_browser.vivaldi",
      ]);
    }
  });
});
