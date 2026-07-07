/**
 * Development-mode verdict parsing — pure string logic ported from loop-kit's
 * `extract_verdict`, `check_gate_req_verdicts`, and the REQ-id extraction in
 * evaluate.sh / req_ids_from_contract. No fs/db/network, so it stays IN the
 * coverage gate at 100%.
 *
 * All model verdicts are parsed with loop-kit's rule: scan the WHOLE reply,
 * strip leading markdown decorations, keep lines matching the token pattern,
 * and take the LAST one. Every gate fails closed — an unparseable review is
 * treated as REVISE by the caller.
 */

import type {
  DevReqVerdict,
  DevReqVerdictLine,
  DevReviewResult,
  DevReviewVerdict,
  DevStopEval,
  DevContractRequirement,
} from "./types.js";

/** Strip leading markdown decorations (`* _ \` > # -`) + surrounding
 *  whitespace, iteratively, matching loop-kit's extract_verdict. */
export function stripDecorations(line: string): string {
  let out = line.trim();
  // Peel repeated leading decoration characters (bullet/quote/heading/emphasis).
  while (out.length > 0 && /^[*_`>#-]/.test(out)) {
    out = out.replace(/^[*_`>#-]+/, "").trim();
  }
  return out.trim();
}

/** Scan every line (decoration-stripped) and return the LAST regex match. */
export function extractLastMatching(
  reply: string,
  pattern: RegExp,
): RegExpMatchArray | null {
  let last: RegExpMatchArray | null = null;
  for (const raw of reply.split(/\r?\n/)) {
    const stripped = stripDecorations(raw);
    const m = stripped.match(pattern);
    if (m) last = m;
  }
  return last;
}

const VERDICT_RE = /^VERDICT:\s*(APPROVE|REVISE|ESCALATE)\b\s*(.*)$/i;

/**
 * Parse a review reply's final `VERDICT:` line. ESCALATE is valid only in
 * gate mode — in an interim review it collapses to REVISE (loop-kit interim
 * reviews are two-valued). Returns null when no verdict line is present (the
 * caller then treats it as REVISE after a format-reminder retry).
 */
export function parseReviewResult(
  reply: string,
  mode: "interim" | "gate",
): DevReviewResult | null {
  const m = extractLastMatching(reply, VERDICT_RE);
  if (!m) return null;
  let verdict = m[1]!.toUpperCase() as DevReviewVerdict;
  const summary = m[2]!.trim();
  if (verdict === "ESCALATE" && mode === "interim") verdict = "REVISE";
  const result: DevReviewResult = { verdict, summary };
  if (mode === "gate") result.reqVerdicts = [];
  return result;
}

const REQ_LINE_RE =
  /^REQ-(\d+):\s*(MET|PARTIAL|UNMET|REGRESSED)\b\s*(?:[—:-]\s*)?(.*)$/i;

/** Normalize a REQ id to the zero-padded 3-digit form used in the ledger. */
function normalizeReqId(digits: string): string {
  return `REQ-${digits.padStart(3, "0")}`;
}

/**
 * Parse the gate reviewer's per-REQ table into one verdict per CONTRACT REQ
 * (in contract order). A REQ with no line becomes MISSING — the analytic
 * backstop against a halo-effect holistic APPROVE (loop-kit
 * check_gate_req_verdicts).
 */
export function parseReqVerdicts(
  reply: string,
  contractReqIds: readonly string[],
): DevReqVerdictLine[] {
  const found = new Map<string, { verdict: DevReqVerdict; evidence: string }>();
  for (const raw of reply.split(/\r?\n/)) {
    const stripped = stripDecorations(raw);
    const m = stripped.match(REQ_LINE_RE);
    if (!m) continue;
    const id = normalizeReqId(m[1]!);
    found.set(id, {
      verdict: m[2]!.toUpperCase() as DevReqVerdict,
      evidence: m[3]!.trim(),
    });
  }
  return contractReqIds.map((reqId) => {
    const hit = found.get(reqId);
    return hit
      ? { reqId, verdict: hit.verdict, evidence: hit.evidence }
      : { reqId, verdict: "MISSING" as DevReqVerdict, evidence: "" };
  });
}

/**
 * The gate downgrade: a holistic APPROVE with any missing or non-MET per-REQ
 * line is auto-downgraded to REVISE (loop-kit check_gate_req_verdicts).
 * Skipped for forced/final gates (the caller decides whether to apply it).
 */
export function applyGateReqDowngrade(
  review: DevReviewResult,
  contractReqIds: readonly string[],
  reply: string,
): DevReviewResult {
  const reqVerdicts = parseReqVerdicts(reply, contractReqIds);
  const offenders = reqVerdicts.filter((r) => r.verdict !== "MET");
  if (review.verdict === "APPROVE" && offenders.length > 0) {
    return {
      verdict: "REVISE",
      summary:
        `Gate APPROVE downgraded — ${offenders.length} requirement(s) not MET: `
        + offenders.map((o) => `${o.reqId}=${o.verdict}`).join(", "),
      reqVerdicts,
    };
  }
  return { ...review, reqVerdicts };
}

const STOP_EVAL_RE = /^STOP-EVAL:\s*(CONTINUE|MET|FUTILE)\b/i;

/** Parse the advisory stop-eval verdict; null when absent. */
export function parseStopEval(reply: string): DevStopEval | null {
  const m = extractLastMatching(reply, STOP_EVAL_RE);
  return m ? (m[1]!.toUpperCase() as DevStopEval) : null;
}

/**
 * The first token of `.aitne-dev/agent-state` (the implement leg's declared
 * state line: "<TOKEN> <reason>"). loop-kit honors NEEDS_SPEC_DECISION /
 * NEEDS_ARCHITECTURE_DECISION / BLOCKED / READY_FOR_REVIEW from here.
 */
export function parseAgentStateToken(firstLine: string | null | undefined): string | null {
  if (!firstLine) return null;
  const token = firstLine.trim().split(/\s+/)[0];
  return token && token.length > 0 ? token.toUpperCase() : null;
}

// ── Flow verdicts (decompose / decompose-review / supervise / plan-review) ──

const DECOMPOSE_RE = /^DECOMPOSE:\s*TASKS\s+n=(\d+)\b/i;

/** Parse the decomposer's final `DECOMPOSE: TASKS n=<N>` line; null when
 *  absent (the caller retries once with a format reminder, then fails
 *  closed to the user). */
export function parseDecomposeVerdict(reply: string): number | null {
  const m = extractLastMatching(reply, DECOMPOSE_RE);
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 10);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

const DECOMPOSE_REVIEW_RE = /^DECOMPOSE-REVIEW:\s*(APPROVE|REVISE)\b\s*(.*)$/i;

export interface DevDecomposeReview {
  verdict: "APPROVE" | "REVISE";
  detail: string;
}

/** Parse the decompose reviewer's `DECOMPOSE-REVIEW: APPROVE|REVISE …` line. */
export function parseDecomposeReviewVerdict(reply: string): DevDecomposeReview | null {
  const m = extractLastMatching(reply, DECOMPOSE_REVIEW_RE);
  if (!m) return null;
  return {
    verdict: m[1]!.toUpperCase() as DevDecomposeReview["verdict"],
    detail: m[2]!.trim(),
  };
}

const SUPERVISE_RE = /^SUPERVISE:\s*(ANSWER|REPLAN|ESCALATE)\b\s*(.*)$/i;

export interface DevSuperviseVerdict {
  verdict: "ANSWER" | "REPLAN" | "ESCALATE";
  detail: string;
}

/** Parse the supervisor's `SUPERVISE: ANSWER|REPLAN|ESCALATE …` line. A
 *  missing/malformed verdict fails toward the human (caller maps null to
 *  ESCALATE after a format-reminder retry). */
export function parseSuperviseVerdict(reply: string): DevSuperviseVerdict | null {
  const m = extractLastMatching(reply, SUPERVISE_RE);
  if (!m) return null;
  return {
    verdict: m[1]!.toUpperCase() as DevSuperviseVerdict["verdict"],
    detail: m[2]!.trim(),
  };
}

const PLAN_REVIEW_RE = /^PLAN-REVIEW:\s*(KEEP|REVISE|ESCALATE)\b\s*(.*)$/i;

export interface DevPlanReviewVerdict {
  verdict: "KEEP" | "REVISE" | "ESCALATE";
  detail: string;
}

/** Parse the phase-boundary plan-review verdict. A missing/malformed verdict
 *  degrades to KEEP in the caller (a refused mutation must not stop the
 *  fleet). */
export function parsePlanReviewVerdict(reply: string): DevPlanReviewVerdict | null {
  const m = extractLastMatching(reply, PLAN_REVIEW_RE);
  if (!m) return null;
  return {
    verdict: m[1]!.toUpperCase() as DevPlanReviewVerdict["verdict"],
    detail: m[2]!.trim(),
  };
}

/**
 * Extract a payload block between exact marker LINES (loop-kit
 * extract_between: markers must be whole lines, ASCII machine tokens).
 * Multiple begin/end pairs concatenate, matching the awk toggle. Returns
 * null when no content was captured — fail-closed callers treat that as a
 * malformed payload.
 */
export function extractBetween(
  reply: string,
  beginMarker: string,
  endMarker: string,
): string | null {
  const out: string[] = [];
  let on = false;
  let sawAny = false;
  for (const raw of reply.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line === endMarker) {
      on = false;
      continue;
    }
    if (on) {
      out.push(raw);
      sawAny = true;
      continue;
    }
    if (line === beginMarker) on = true;
  }
  if (!sawAny) return null;
  const body = out.join("\n");
  return body.trim().length > 0 ? body : null;
}

const REQ_HEADING_RE = /^#{1,6}\s+REQ-(\d+)\b\s*:?\s*(.*)$/;

/**
 * Extract the contract's requirements from its Markdown — heading lines only
 * (`### REQ-001: <name>`), matching loop-kit's heading-only REQ extraction
 * (prose mentions never create obligations). Returns id + title, deduped and
 * sorted by id.
 */
export function extractContractRequirements(
  contractMarkdown: string,
): DevContractRequirement[] {
  const byId = new Map<string, string>();
  for (const raw of contractMarkdown.split(/\r?\n/)) {
    const m = raw.match(REQ_HEADING_RE);
    if (!m) continue;
    const id = normalizeReqId(m[1]!);
    const title = m[2]!.trim();
    // First heading wins (later duplicates do not overwrite a real title).
    if (!byId.has(id)) byId.set(id, title);
  }
  return [...byId.keys()]
    .sort()
    .map((id) => ({ id, title: byId.get(id)! }));
}

/** Convenience — just the sorted-unique REQ id list. */
export function extractContractReqIds(contractMarkdown: string): string[] {
  return extractContractRequirements(contractMarkdown).map((r) => r.id);
}
