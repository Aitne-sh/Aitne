import { describe, it, expect } from "vitest";
import {
  applyGateReqDowngrade,
  extractBetween,
  extractContractReqIds,
  extractContractRequirements,
  extractLastMatching,
  parseAgentStateToken,
  parseContractReviewVerdict,
  parseDecomposeReviewVerdict,
  parseDecomposeVerdict,
  parsePlanReviewVerdict,
  parseReqVerdicts,
  parseReviewResult,
  parseStopEval,
  parseSuperviseVerdict,
  stripDecorations,
} from "./verdict-parse.js";
import type { DevReviewResult } from "./types.js";

describe("stripDecorations", () => {
  it("peels bullets, quotes, emphasis, headings and combos", () => {
    expect(stripDecorations("  - VERDICT: APPROVE")).toBe("VERDICT: APPROVE");
    expect(stripDecorations("> **VERDICT: REVISE**")).toBe("VERDICT: REVISE**");
    expect(stripDecorations("### VERDICT: ESCALATE")).toBe("VERDICT: ESCALATE");
    expect(stripDecorations("`code`")).toBe("code`");
    expect(stripDecorations("plain")).toBe("plain");
    expect(stripDecorations("###")).toBe(""); // all-decoration → empty
  });
});

describe("extractLastMatching", () => {
  it("returns the LAST matching line", () => {
    const reply = "VERDICT: REVISE first\nnoise\n- VERDICT: APPROVE final";
    const m = extractLastMatching(reply, /^VERDICT:\s*(\w+)/);
    expect(m?.[1]).toBe("APPROVE");
  });
  it("returns null when nothing matches", () => {
    expect(extractLastMatching("nope", /^VERDICT:/)).toBeNull();
  });
});

describe("parseReviewResult", () => {
  it("parses APPROVE with a trailing summary", () => {
    const r = parseReviewResult("VERDICT: APPROVE looks good", "interim");
    expect(r).toEqual({ verdict: "APPROVE", summary: "looks good" });
  });

  it("collapses ESCALATE to REVISE in interim mode", () => {
    const r = parseReviewResult("VERDICT: ESCALATE which db?", "interim");
    expect(r?.verdict).toBe("REVISE");
  });

  it("keeps ESCALATE + seeds reqVerdicts in gate mode", () => {
    const r = parseReviewResult("VERDICT: ESCALATE need a decision", "gate");
    expect(r?.verdict).toBe("ESCALATE");
    expect(r?.reqVerdicts).toEqual([]);
  });

  it("takes the last verdict line and is case-insensitive", () => {
    const r = parseReviewResult("verdict: revise\nVERDICT: approve ok", "interim");
    expect(r?.verdict).toBe("APPROVE");
  });

  it("returns null when no verdict line present", () => {
    expect(parseReviewResult("no verdict here", "interim")).toBeNull();
  });
});

describe("parseReqVerdicts", () => {
  const reply = [
    "Review body...",
    "REQ-001: MET — tests pass",
    "- REQ-2: PARTIAL : half done",
    "REQ-003: REGRESSED broke logout",
  ].join("\n");

  it("maps found lines by normalized id, handling separators + padding", () => {
    const out = parseReqVerdicts(reply, ["REQ-001", "REQ-002", "REQ-003"]);
    expect(out).toEqual([
      { reqId: "REQ-001", verdict: "MET", evidence: "tests pass" },
      { reqId: "REQ-002", verdict: "PARTIAL", evidence: "half done" },
      { reqId: "REQ-003", verdict: "REGRESSED", evidence: "broke logout" },
    ]);
  });

  it("marks a contract REQ with no line as MISSING, in contract order", () => {
    const out = parseReqVerdicts(reply, ["REQ-003", "REQ-004"]);
    expect(out.map((r) => `${r.reqId}:${r.verdict}`)).toEqual([
      "REQ-003:REGRESSED",
      "REQ-004:MISSING",
    ]);
  });
});

describe("applyGateReqDowngrade", () => {
  const approve: DevReviewResult = { verdict: "APPROVE", summary: "ship" };

  it("downgrades an APPROVE with any non-MET/missing REQ", () => {
    const reply = "REQ-001: MET ok\nREQ-002: UNMET nope";
    const out = applyGateReqDowngrade(approve, ["REQ-001", "REQ-002"], reply);
    expect(out.verdict).toBe("REVISE");
    expect(out.summary).toMatch(/REQ-002=UNMET/);
  });

  it("keeps an APPROVE when every REQ is MET, attaching reqVerdicts", () => {
    const reply = "REQ-001: MET a\nREQ-002: MET b";
    const out = applyGateReqDowngrade(approve, ["REQ-001", "REQ-002"], reply);
    expect(out.verdict).toBe("APPROVE");
    expect(out.reqVerdicts).toHaveLength(2);
  });

  it("leaves a REVISE untouched (but attaches reqVerdicts)", () => {
    const revise: DevReviewResult = { verdict: "REVISE", summary: "fix" };
    const out = applyGateReqDowngrade(revise, ["REQ-001"], "REQ-001: MET ok");
    expect(out.verdict).toBe("REVISE");
    expect(out.reqVerdicts).toHaveLength(1);
  });
});

describe("parseStopEval", () => {
  it("parses the verdict and takes the last one", () => {
    expect(parseStopEval("STOP-EVAL: CONTINUE\nSTOP-EVAL: MET done")).toBe("MET");
    expect(parseStopEval("- STOP-EVAL: FUTILE")).toBe("FUTILE");
    expect(parseStopEval("nothing")).toBeNull();
  });
});

describe("parseAgentStateToken", () => {
  it("returns the uppercased first token", () => {
    expect(parseAgentStateToken("READY_FOR_REVIEW all green")).toBe(
      "READY_FOR_REVIEW",
    );
    expect(parseAgentStateToken("  blocked cannot proceed")).toBe("BLOCKED");
  });
  it("handles null/empty", () => {
    expect(parseAgentStateToken(null)).toBeNull();
    expect(parseAgentStateToken("")).toBeNull();
    expect(parseAgentStateToken("   ")).toBeNull();
  });
});

describe("extractContractRequirements / extractContractReqIds", () => {
  const md = [
    "# Product Contract",
    "## Requirements",
    "### REQ-001: User can log in",
    "Some prose mentioning REQ-999 that must NOT count.",
    "#### REQ-2: Logout",
    "### REQ-001: duplicate heading (first title wins)",
    "###REQ-003 no space — not a heading match",
  ].join("\n");

  it("extracts heading-only REQs, deduped first-title-wins, sorted", () => {
    expect(extractContractRequirements(md)).toEqual([
      { id: "REQ-001", title: "User can log in" },
      { id: "REQ-002", title: "Logout" },
    ]);
  });

  it("extractContractReqIds returns the sorted id list", () => {
    expect(extractContractReqIds(md)).toEqual(["REQ-001", "REQ-002"]);
  });

  it("returns empty for a contract with no REQ headings", () => {
    expect(extractContractReqIds("# Goal\nno reqs")).toEqual([]);
  });

  it("matches mixed-case REQ headings (case-insensitive), normalizing the id", () => {
    const mixed = [
      "### Req-005: Rate limit",
      "#### req-6: Audit log",
    ].join("\n");
    expect(extractContractRequirements(mixed)).toEqual([
      { id: "REQ-005", title: "Rate limit" },
      { id: "REQ-006", title: "Audit log" },
    ]);
  });
});

describe("flow verdicts", () => {
  it("parseDecomposeVerdict takes the LAST n, strips decorations, rejects junk", () => {
    expect(parseDecomposeVerdict("analysis\nDECOMPOSE: TASKS n=3")).toBe(3);
    expect(parseDecomposeVerdict("DECOMPOSE: TASKS n=1\n> **DECOMPOSE: TASKS n=4**")).toBe(4);
    expect(parseDecomposeVerdict("decompose: tasks n=2")).toBe(2);
    expect(parseDecomposeVerdict("no verdict here")).toBeNull();
    expect(parseDecomposeVerdict("DECOMPOSE: TASKS n=0")).toBeNull();
  });

  it("parseDecomposeReviewVerdict returns verdict + detail or null", () => {
    expect(parseDecomposeReviewVerdict("DECOMPOSE-REVIEW: APPROVE clean split")).toEqual({
      verdict: "APPROVE",
      detail: "clean split",
    });
    expect(parseDecomposeReviewVerdict("- decompose-review: revise 1. fix scopes")).toEqual({
      verdict: "REVISE",
      detail: "1. fix scopes",
    });
    expect(parseDecomposeReviewVerdict("nothing")).toBeNull();
  });

  it("parseSuperviseVerdict parses the three decisions or null", () => {
    expect(parseSuperviseVerdict("…\nSUPERVISE: ANSWER use the existing helper")).toEqual({
      verdict: "ANSWER",
      detail: "use the existing helper",
    });
    expect(parseSuperviseVerdict("SUPERVISE: REPLAN split into phases")?.verdict).toBe("REPLAN");
    expect(parseSuperviseVerdict("supervise: escalate the contract is wrong")?.verdict).toBe(
      "ESCALATE",
    );
    expect(parseSuperviseVerdict("SUPERVISED: nothing")).toBeNull();
  });

  it("parsePlanReviewVerdict parses KEEP/REVISE/ESCALATE or null", () => {
    expect(parsePlanReviewVerdict("PLAN-REVIEW: KEEP still right")).toEqual({
      verdict: "KEEP",
      detail: "still right",
    });
    expect(parsePlanReviewVerdict("plan-review: revise swap phase 2")?.verdict).toBe("REVISE");
    expect(parsePlanReviewVerdict("PLAN-REVIEW: ESCALATE req unreachable")?.verdict).toBe(
      "ESCALATE",
    );
    expect(parsePlanReviewVerdict("KEEP")).toBeNull();
  });

  it("extractBetween captures exact-line-marker payloads, fail-closed", () => {
    const reply = [
      "analysis",
      "GUIDANCE-BEGIN",
      "do the thing",
      "on two lines",
      "GUIDANCE-END",
      "SUPERVISE: ANSWER done",
    ].join("\n");
    expect(extractBetween(reply, "GUIDANCE-BEGIN", "GUIDANCE-END")).toBe(
      "do the thing\non two lines",
    );
    // Multiple blocks concatenate (awk-toggle parity).
    const two = "A-BEGIN\none\nA-END\nmid\nA-BEGIN\ntwo\nA-END";
    expect(extractBetween(two, "A-BEGIN", "A-END")).toBe("one\ntwo");
    // Inline mentions are NOT markers; missing/empty payloads return null.
    expect(extractBetween("see GUIDANCE-BEGIN inline", "GUIDANCE-BEGIN", "GUIDANCE-END")).toBeNull();
    expect(extractBetween("A-BEGIN\nA-END", "A-BEGIN", "A-END")).toBeNull();
    expect(extractBetween("A-BEGIN\n   \nA-END", "A-BEGIN", "A-END")).toBeNull();
  });
});

describe("parseContractReviewVerdict", () => {
  it("parses the last CONTRACT-REVIEW line, decoration- and case-tolerant", () => {
    const reply = [
      "Analysis: the gate is real and discriminating.",
      "CONTRACT-REVIEW: REVISE early draft — superseded below",
      "> contract-review: APPROVE the gate can be trusted",
    ].join("\n");
    expect(parseContractReviewVerdict(reply)).toEqual({
      verdict: "APPROVE",
      detail: "the gate can be trusted",
    });
  });
  it("returns null when no verdict line exists (caller retries then fails toward the human)", () => {
    expect(parseContractReviewVerdict("I think it looks fine.")).toBeNull();
  });
  it("parses REVISE and ESCALATE with their details", () => {
    expect(parseContractReviewVerdict("CONTRACT-REVIEW: REVISE 1) gate is vacuous; 2) no run probe")).toEqual({
      verdict: "REVISE",
      detail: "1) gate is vacuous; 2) no run probe",
    });
    expect(parseContractReviewVerdict("CONTRACT-REVIEW: ESCALATE which auth provider?")).toEqual({
      verdict: "ESCALATE",
      detail: "which auth provider?",
    });
  });
});
