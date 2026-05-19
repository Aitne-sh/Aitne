import { describe, expect, it } from "vitest";
import {
  describeCollision,
  summariseProbe,
  type ProbeResult,
} from "./vault-path-picker.logic";

function baseProbe(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    ok: true,
    path: "/Users/alice/Obsidian/Wiki",
    exists: true,
    isDir: true,
    writable: true,
    collision: null,
    collisionMessage: null,
    hasObsidianStructure: false,
    existingWiki: null,
    ...overrides,
  };
}

describe("describeCollision", () => {
  it("returns null for no collision", () => {
    expect(describeCollision(null, null)).toBe(null);
  });

  it("maps each known collision code to a severity + message", () => {
    expect(describeCollision("primary_vault", null)?.severity).toBe("error");
    expect(describeCollision("external_obsidian", null)?.severity).toBe("error");
    expect(describeCollision("data_dir", null)?.severity).toBe("error");
    expect(describeCollision("other_wiki", null)?.severity).toBe("error");
    expect(describeCollision("system_path", null)?.severity).toBe("error");
    expect(describeCollision("not_writable", null)?.severity).toBe("warning");
  });

  it("falls back to the validator message when the code is `invalid`", () => {
    const result = describeCollision("invalid", "Custom message from validator");
    expect(result?.text).toContain("Custom message from validator");
  });

  it("falls back to a generic message when neither code nor message is informative", () => {
    const result = describeCollision("invalid", null);
    expect(result?.text.length).toBeGreaterThan(0);
  });
});

describe("summariseProbe", () => {
  it("returns a placeholder line when no probe has run yet", () => {
    const summary = summariseProbe(null);
    expect(summary.canConfirm).toBe(false);
    expect(summary.severity).toBe(null);
  });

  it("blocks confirmation when probe.ok is false", () => {
    const summary = summariseProbe({
      ...baseProbe(),
      ok: false,
      message: "Path under /etc",
    });
    expect(summary.canConfirm).toBe(false);
    expect(summary.severity).toBe("error");
    expect(summary.lines[0]).toContain("Path under /etc");
  });

  it("treats a fresh, empty, writable directory as ready", () => {
    const summary = summariseProbe(baseProbe());
    expect(summary.canConfirm).toBe(true);
    expect(summary.severity).toBe("info");
  });

  it("treats a not-yet-existing path as creatable on save", () => {
    const summary = summariseProbe(baseProbe({ exists: false, isDir: false, writable: false }));
    expect(summary.canConfirm).toBe(true);
    expect(summary.lines.join(" ")).toContain("created");
  });

  it("blocks confirmation when the path is a regular file", () => {
    const summary = summariseProbe(
      baseProbe({ exists: true, isDir: false, writable: false }),
    );
    expect(summary.canConfirm).toBe(false);
    expect(summary.severity).toBe("error");
  });

  it("flags a non-writable directory as a warning, not an error", () => {
    const summary = summariseProbe(baseProbe({ writable: false }));
    expect(summary.canConfirm).toBe(true);
    expect(summary.severity).toBe("warning");
    expect(summary.lines.join(" ")).toContain("Obsidian CLI fallback");
  });

  it("blocks confirmation on a primary-vault collision", () => {
    const summary = summariseProbe(baseProbe({ collision: "primary_vault" }));
    expect(summary.canConfirm).toBe(false);
    expect(summary.severity).toBe("error");
  });

  it("surfaces an Obsidian-structure hint without blocking", () => {
    const summary = summariseProbe(baseProbe({ hasObsidianStructure: true }));
    expect(summary.canConfirm).toBe(true);
    expect(summary.lines.join(" ")).toContain("Obsidian vault");
  });

  it("surfaces an existing-wiki hint that promises Adopt/Migrate later", () => {
    const summary = summariseProbe(
      baseProbe({
        existingWiki: {
          kind: "wiki",
          layers: ["10_raw", "20_wiki", "90_meta"],
          taxonomyPresent: true,
          indexPresent: true,
          unexpectedSubdirectories: [],
        },
      }),
    );
    expect(summary.canConfirm).toBe(true);
    expect(summary.lines.join(" ")).toContain("Adopt or Migrate");
  });
});
