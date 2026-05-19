import { describe, it, expect } from "vitest";
import {
  autoSelectPolicyFor,
  canSubmitMigration,
  classifyClientPathError,
  getPrimaryActionLabel,
} from "./management-mode-dialog.logic";

describe("classifyClientPathError", () => {
  it("rejects empty string", () => {
    expect(classifyClientPathError("")).toEqual({
      code: "empty",
      message: "Path is required.",
    });
  });

  it("rejects whitespace-only", () => {
    expect(classifyClientPathError("   ")).toEqual({
      code: "empty",
      message: "Path is required.",
    });
  });

  it("accepts an absolute path", () => {
    expect(classifyClientPathError("/Users/you/MyVault")).toBeNull();
  });

  it("accepts a home-relative path", () => {
    expect(classifyClientPathError("~/Documents/Vault")).toBeNull();
    expect(classifyClientPathError("~\\Documents\\Vault")).toBeNull();
  });

  it("accepts Windows absolute paths", () => {
    expect(classifyClientPathError("C:\\Users\\you\\Vault")).toBeNull();
    expect(classifyClientPathError("D:/Vault")).toBeNull();
    expect(classifyClientPathError("\\\\server\\share\\Vault")).toBeNull();
  });

  it("rejects a bare-home shorthand without slash", () => {
    expect(classifyClientPathError("~Documents")).toMatchObject({
      code: "not_absolute",
    });
  });

  it("rejects relative paths", () => {
    expect(classifyClientPathError("MyVault")).toMatchObject({
      code: "not_absolute",
    });
    expect(classifyClientPathError("./MyVault")).toMatchObject({
      code: "not_absolute",
    });
  });

  it("rejects path traversal", () => {
    expect(classifyClientPathError("/Users/you/../etc/passwd")).toMatchObject({
      code: "path_traversal",
    });
    expect(classifyClientPathError("/..")).toMatchObject({
      code: "path_traversal",
    });
    expect(classifyClientPathError("~/foo/../bar")).toMatchObject({
      code: "path_traversal",
    });
    expect(classifyClientPathError("C:\\Users\\you\\..\\Vault")).toMatchObject({
      code: "path_traversal",
    });
  });

  it("accepts paths whose segments merely contain `..` without being equal", () => {
    // `..foo` / `foo..` / `.hidden` are fine — only the literal `..`
    // segment is treated as traversal.
    expect(classifyClientPathError("/Users/you/..hidden")).toBeNull();
    expect(classifyClientPathError("/Users/you/my..vault")).toBeNull();
  });

  it("trims surrounding whitespace before validating", () => {
    expect(classifyClientPathError("  /Users/you/MyVault  ")).toBeNull();
  });
});

describe("autoSelectPolicyFor", () => {
  it("returns 'overwrite_agent_files' for agent-file conflicts", () => {
    // Only one allowed option for this error — Retry would otherwise
    // re-send the default `abort` policy and loop.
    expect(autoSelectPolicyFor("target_has_agent_file_conflicts")).toBe(
      "overwrite_agent_files",
    );
  });

  it("returns 'merge' for unrelated-file conflicts", () => {
    // `merge` is the less-destructive of the two allowed options.
    expect(autoSelectPolicyFor("target_has_unrelated_files")).toBe("merge");
  });

  it("returns null for non-conflict errors", () => {
    // Non-conflict errors must NOT force a policy change — the user's
    // prior selection stands.
    expect(autoSelectPolicyFor("move_failed")).toBeNull();
    expect(autoSelectPolicyFor("db_rewrite_failed")).toBeNull();
    expect(autoSelectPolicyFor("sessions_active")).toBeNull();
    expect(autoSelectPolicyFor("target_invalid")).toBeNull();
  });

  it("returns null for null / undefined / empty input", () => {
    expect(autoSelectPolicyFor(null)).toBeNull();
    expect(autoSelectPolicyFor(undefined)).toBeNull();
    expect(autoSelectPolicyFor("")).toBeNull();
  });
});

describe("canSubmitMigration", () => {
  it("allows plain-mode submits when not already on the same target", () => {
    expect(
      canSubmitMigration({
        submitting: false,
        samePath: false,
        mode: "plain",
        path: "",
        pathIssue: null,
        validationStatus: "idle",
        policy: "abort",
        allowedPolicies: ["abort", "merge", "overwrite_agent_files"],
      }),
    ).toBe(true);
  });

  it("blocks obsidian-mode submits until live validation passes", () => {
    expect(
      canSubmitMigration({
        submitting: false,
        samePath: false,
        mode: "obsidian",
        path: "/Users/test/Vault",
        pathIssue: null,
        validationStatus: "validating",
        policy: "abort",
        allowedPolicies: ["abort", "merge", "overwrite_agent_files"],
      }),
    ).toBe(false);
  });

  it("blocks when the selected policy is not allowed for the inspected conflict", () => {
    expect(
      canSubmitMigration({
        submitting: false,
        samePath: false,
        mode: "obsidian",
        path: "/Users/test/Vault",
        pathIssue: null,
        validationStatus: "valid",
        policy: "abort",
        allowedPolicies: ["merge", "overwrite_agent_files"],
      }),
    ).toBe(false);
  });

  it("allows obsidian-mode submits once validation passed and policy is allowed", () => {
    expect(
      canSubmitMigration({
        submitting: false,
        samePath: false,
        mode: "obsidian",
        path: "/Users/test/Vault",
        pathIssue: null,
        validationStatus: "valid",
        policy: "merge",
        allowedPolicies: ["merge", "overwrite_agent_files"],
      }),
    ).toBe(true);
  });
});

describe("getPrimaryActionLabel", () => {
  it("prefers the in-flight label while submitting", () => {
    expect(getPrimaryActionLabel(null, true)).toBe("Migrating…");
  });

  it("returns the wait-then-retry label for 409-style blockers", () => {
    expect(getPrimaryActionLabel("sessions_active", false)).toBe("Wait Then Retry");
    expect(getPrimaryActionLabel("executions_active", false)).toBe("Wait Then Retry");
    expect(getPrimaryActionLabel("migration_in_progress", false)).toBe("Wait Then Retry");
  });

  it("returns retry for other errors and confirm for the happy path", () => {
    expect(getPrimaryActionLabel("move_failed", false)).toBe("Retry");
    expect(getPrimaryActionLabel(null, false)).toBe("Confirm & Migrate");
  });
});
