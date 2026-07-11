import { describe, it, expect } from "vitest";
import {
  extractContractAcAnchors,
  lintContractChecklist,
  parseChecklistMarkdown,
  parseHumanVerifyReply,
} from "./dev-checklist.js";

const ROWS_MD = [
  "| AC | REQ | Expectation | Method | Status | Evidence |",
  "| --- | --- | --- | --- | --- | --- |",
  "| AC-001 | REQ-001 | the page renders | run | pending | - |",
  "| AC-2 | REQ-001 | tests pass | cmd | verified | npm test |",
  "| AC-003 | REQ-002 | looks polished | human | failed | owner: too rough |",
].join("\n");

describe("parseChecklistMarkdown", () => {
  it("null input = checklist not in use", () => {
    expect(parseChecklistMarkdown(null)).toBeNull();
  });

  it("parses rows positionally, normalizes ids, ignores non-row lines", () => {
    const rows = parseChecklistMarkdown(ROWS_MD)!;
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      acId: "AC-001",
      reqId: "REQ-001",
      expectation: "the page renders",
      method: "run",
      status: "pending",
      evidence: "-",
    });
    // Zero-padding normalization (AC-2 → AC-002).
    expect(rows[1]!.acId).toBe("AC-002");
    expect(rows[1]!.status).toBe("verified");
    expect(rows[2]!.method).toBe("human");
    expect(rows[2]!.status).toBe("failed");
  });

  it("unknown method/status tokens degrade to null/'unknown'; short rows default", () => {
    const rows = parseChecklistMarkdown("| AC-004 | REQ-001 | x | inspect | done |")!;
    expect(rows[0]!.method).toBeNull();
    expect(rows[0]!.status).toBe("unknown");
    expect(rows[0]!.evidence).toBe("");
    // A pipe-less line and a pipe line without an AC cell parse to nothing.
    expect(parseChecklistMarkdown("prose only")).toEqual([]);
    expect(parseChecklistMarkdown("| REQ-001 | not a row |")).toEqual([]);
    // A truncated row (no cells past the id) defaults every field.
    expect(parseChecklistMarkdown("| AC-007")).toEqual([
      { acId: "AC-007", reqId: "", expectation: "", method: null, status: "unknown", evidence: "" },
    ]);
  });
});

describe("extractContractAcAnchors", () => {
  it("takes list items only, leading id, optional method; first anchor wins", () => {
    const anchors = extractContractAcAnchors([
      "## Acceptance Criteria",
      "- AC-001 (run): particles visibly move",
      "* AC-2: tests pass",
      "- AC-001 (cmd): duplicate — ignored",
      "- AC-003 (inspect): bad method token",
      "prose mentioning AC-009 creates nothing",
      "  - AC-004 (human): final look signed off",
    ].join("\n"));
    expect(anchors).toEqual([
      { acId: "AC-001", method: "run" },
      { acId: "AC-002", method: null },
      { acId: "AC-003", method: null },
      { acId: "AC-004", method: "human" },
    ]);
  });
});

describe("lintContractChecklist", () => {
  const REQS = ["REQ-001", "REQ-002"];
  const CONTRACT = [
    "### REQ-001: a",
    "### REQ-002: b",
    "- AC-001 (run): renders",
    "- AC-002: tests pass",
  ].join("\n");

  it("accepts a well-formed definition", () => {
    const md = [
      "| AC-001 | REQ-001 | renders | run | pending | - |",
      "| AC-002 | REQ-002 | tests pass | cmd | pending | - |",
    ].join("\n");
    expect(lintContractChecklist(CONTRACT, md, REQS)).toEqual([]);
  });

  it("missing checklist is an error ONLY when the contract anchors ids", () => {
    expect(lintContractChecklist(CONTRACT, null, REQS)[0]).toContain("acceptance-checklist.md is missing");
    expect(lintContractChecklist("### REQ-001: a", null, ["REQ-001"])).toEqual([]);
  });

  it("flags duplicates, bad methods, non-pending starts, and dangling REQs", () => {
    const md = [
      "| AC-001 | REQ-001 | renders | run | pending | - |",
      "| AC-001 | REQ-001 | dup id | cmd | pending | - |",
      "| AC-002 | REQ-009 | dangling req | inspect | verified | - |",
      "| AC-005 | garbage | no req id | cmd | pending | - |",
    ].join("\n");
    const errors = lintContractChecklist(CONTRACT, md, REQS);
    expect(errors.some((e) => e.includes("duplicate checklist row id AC-001"))).toBe(true);
    expect(errors.some((e) => e.includes("AC-002 has an unrecognized method"))).toBe(true);
    expect(errors.some((e) => e.includes("must start as 'pending'"))).toBe(true);
    expect(errors.some((e) => e.includes("REQ-009 — not a contract requirement"))).toBe(true);
    expect(errors.some((e) => e.includes("garbage — not a contract requirement"))).toBe(true);
  });

  it("flags an empty REQ cell", () => {
    const md = "| AC-001 | | renders | run | pending | - |";
    const errors = lintContractChecklist("- AC-001 (run): renders", md, REQS);
    expect(errors.some((e) => e.includes("(no REQ)"))).toBe(true);
  });

  it("flags anchors without rows and anchor/row method mismatches", () => {
    const md = "| AC-001 | REQ-001 | renders | cmd | pending | - |";
    const errors = lintContractChecklist(CONTRACT, md, REQS);
    expect(errors.some((e) => e.includes("AC-002 has no checklist row"))).toBe(true);
    expect(errors.some((e) => e.includes("AC-001 method 'cmd' differs from the contract anchor '(run)'"))).toBe(true);
  });

  it("a null row method never double-reports as a mismatch", () => {
    const md = "| AC-001 | REQ-001 | renders | inspect | pending | - |";
    const errors = lintContractChecklist("- AC-001 (run): renders", md, REQS);
    expect(errors.some((e) => e.includes("unrecognized method"))).toBe(true);
    expect(errors.some((e) => e.includes("differs from the contract anchor"))).toBe(false);
  });
});

describe("parseHumanVerifyReply", () => {
  it("affirmative first tokens sign off (punctuation-tolerant)", () => {
    for (const answer of ["verified", "Verified.", "yes, ship it", "OK!", "approved", "LGTM — nice"]) {
      expect(parseHumanVerifyReply(answer)).toBe("verified");
    }
  });
  it("anything else (including empty) rejects", () => {
    for (const answer of ["the colors are off", "no", "", "   "]) {
      expect(parseHumanVerifyReply(answer)).toBe("rejected");
    }
  });
});
