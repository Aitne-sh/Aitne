import { describe, expect, it } from "vitest";

import { workflowDeclarationIsConsistent } from "./types.js";

describe("workflowDeclarationIsConsistent", () => {
  it("anon variant must NOT carry siteKey", () => {
    expect(workflowDeclarationIsConsistent({ variant: "anon" })).toBe(true);
    expect(
      workflowDeclarationIsConsistent({ variant: "anon", siteKey: "amazon_jp" }),
    ).toBe(false);
  });

  it("auth variant MUST carry siteKey (B-2.5)", () => {
    expect(
      workflowDeclarationIsConsistent({ variant: "auth", siteKey: "amazon_jp" }),
    ).toBe(true);
    expect(workflowDeclarationIsConsistent({ variant: "auth" })).toBe(false);
    expect(
      workflowDeclarationIsConsistent({ variant: "auth", siteKey: "" }),
    ).toBe(false);
  });

  it("purchase variant MUST carry siteKey (B-4)", () => {
    expect(
      workflowDeclarationIsConsistent({ variant: "purchase", siteKey: "amazon_jp" }),
    ).toBe(true);
    expect(workflowDeclarationIsConsistent({ variant: "purchase" })).toBe(false);
  });
});
