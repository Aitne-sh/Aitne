import { describe, expect, it } from "vitest";
import {
  hasPathTraversalSegment,
  isClientAbsolutePath,
  isClientPathInsideOrEqual,
} from "./path-client";

describe("path-client", () => {
  it("accepts POSIX, home-relative, and Windows absolute paths", () => {
    expect(isClientAbsolutePath("/Users/me/Vault")).toBe(true);
    expect(isClientAbsolutePath("~/Vault")).toBe(true);
    expect(isClientAbsolutePath("~\\Vault")).toBe(true);
    expect(isClientAbsolutePath("C:\\Users\\me\\Vault")).toBe(true);
    expect(isClientAbsolutePath("D:/Vault")).toBe(true);
    expect(isClientAbsolutePath("\\\\server\\share\\Vault")).toBe(true);
  });

  it("rejects relative paths", () => {
    expect(isClientAbsolutePath("Vault")).toBe(false);
    expect(isClientAbsolutePath("..\\Vault")).toBe(false);
  });

  it("detects traversal across separators", () => {
    expect(hasPathTraversalSegment("/Users/me/../Vault")).toBe(true);
    expect(hasPathTraversalSegment("C:\\Users\\me\\..\\Vault")).toBe(true);
    expect(hasPathTraversalSegment("/Users/me/..vault")).toBe(false);
  });

  it("compares Windows containment case-insensitively", () => {
    expect(
      isClientPathInsideOrEqual(
        "C:\\Users\\me\\.personal-agent",
        "c:/users/me/.personal-agent/vault",
      ),
    ).toBe(true);
    expect(
      isClientPathInsideOrEqual(
        "C:\\Users\\me\\.personal-agent",
        "C:\\Users\\me\\.personal-agent-extra",
      ),
    ).toBe(false);
  });
});
