/**
 * Acceptance-checklist parsing + linting — the pure half of loop-kit's
 * fine-grained expectation ledger (kit/loop-docs/acceptance-checklist.md).
 *
 * Row grammar (machine-parsed, one line per row, `|` never inside a cell):
 *
 *   | AC-001 | REQ-001 | <observable expected behavior> | cmd|run|human | pending|verified|failed | <evidence> |
 *
 * Contract ANCHORS are acceptance-criteria list items carrying the row id and
 * (optionally) its verification method — `- AC-001 (run): <expectation>`.
 * Anchors live in the HASH-FROZEN contract, so the obligation set can never
 * shrink by editing the agent-writable checklist (evaluate §6.6b/d).
 *
 * Pure string logic — no fs/db/network — so it stays IN the coverage gate at
 * 100%. The I/O sync lives in dev-loop-engine / dev-session-checklist-store.
 */

export type DevAcMethod = "cmd" | "run" | "human";
export type DevAcStatus = "pending" | "verified" | "failed" | "unknown";

export interface DevChecklistRow {
  /** "AC-001" — normalized (zero-padded), never renumbered. */
  acId: string;
  /** The REQ cell as written (the lint validates it against the contract). */
  reqId: string;
  expectation: string;
  /** null = unrecognized method token (a lint error at definition time). */
  method: DevAcMethod | null;
  status: DevAcStatus;
  evidence: string;
}

/** One contract acceptance-criterion anchor: `- AC-NNN (method): …`. */
export interface DevAcAnchor {
  acId: string;
  /** null = no method token (older contracts) — imposes no method constraint. */
  method: DevAcMethod | null;
}

const AC_ID_RE = /^AC-(\d+)$/i;
const METHODS: ReadonlySet<string> = new Set(["cmd", "run", "human"]);
const STATUSES: ReadonlySet<string> = new Set(["pending", "verified", "failed"]);

function normalizeAcId(digits: string): string {
  return `AC-${digits.padStart(3, "0")}`;
}

/**
 * Parse the checklist markdown into rows. `null` input (file absent) returns
 * null — "the checklist is not in use" (loop-kit backcompat for contracts
 * that predate the layer). Only lines whose first `AC-\d+` cell is found
 * count; header/separator/prose lines are ignored.
 */
export function parseChecklistMarkdown(md: string | null): DevChecklistRow[] | null {
  if (md === null) return null;
  const rows: DevChecklistRow[] = [];
  for (const raw of md.split(/\r?\n/)) {
    if (!raw.includes("|")) continue;
    const cells = raw.split("|").map((c) => c.trim());
    const idIdx = cells.findIndex((c) => AC_ID_RE.test(c));
    if (idIdx < 0) continue;
    const idMatch = cells[idIdx]!.match(AC_ID_RE)!;
    const methodRaw = (cells[idIdx + 3] ?? "").toLowerCase();
    const statusRaw = (cells[idIdx + 4] ?? "").toLowerCase();
    rows.push({
      acId: normalizeAcId(idMatch[1]!),
      reqId: cells[idIdx + 1] ?? "",
      expectation: cells[idIdx + 2] ?? "",
      method: METHODS.has(methodRaw) ? (methodRaw as DevAcMethod) : null,
      status: STATUSES.has(statusRaw) ? (statusRaw as DevAcStatus) : "unknown",
      evidence: cells[idIdx + 5] ?? "",
    });
  }
  return rows;
}

// Leading id only: a criterion's text MENTIONING another AC id never creates
// an obligation (mirror of loop-kit's `^\s*[-*]\s*(AC-[0-9]+)` sed).
const ANCHOR_RE = /^\s*[-*]\s*(AC-(\d+))\s*(?:\((\w+)\))?\s*:/;

/**
 * Extract the contract's anchored acceptance-criteria ids (+ optional method
 * tokens) from its markdown — list items only, first anchor per id wins.
 */
export function extractContractAcAnchors(contractMarkdown: string): DevAcAnchor[] {
  const byId = new Map<string, DevAcAnchor>();
  for (const raw of contractMarkdown.split(/\r?\n/)) {
    const m = raw.match(ANCHOR_RE);
    if (!m) continue;
    const acId = normalizeAcId(m[2]!);
    if (byId.has(acId)) continue;
    const methodRaw = (m[3] ?? "").toLowerCase();
    byId.set(acId, {
      acId,
      method: METHODS.has(methodRaw) ? (methodRaw as DevAcMethod) : null,
    });
  }
  return [...byId.values()];
}

const REQ_ID_RE = /^REQ-(\d+)$/i;

function normalizeReqCell(cell: string): string | null {
  const m = cell.trim().match(REQ_ID_RE);
  return m ? `REQ-${m[1]!.padStart(3, "0")}` : null;
}

/**
 * Approve-time definition lint (the loop-kit approval lint, checklist half):
 * duplicate row ids, dangling REQ references, unrecognized methods/statuses,
 * anchors without a verified-able row, anchor/row method mismatches, and
 * non-`pending` initial statuses. Returns human-readable errors (empty = ok).
 * A missing checklist is only an error when the contract anchors AC ids.
 */
export function lintContractChecklist(
  contractMarkdown: string,
  checklistMd: string | null,
  contractReqIds: readonly string[],
): string[] {
  const errors: string[] = [];
  const rows = parseChecklistMarkdown(checklistMd);
  const anchors = extractContractAcAnchors(contractMarkdown);

  if (rows === null) {
    if (anchors.length > 0) {
      errors.push(
        `the contract anchors ${anchors.map((a) => a.acId).join(", ")} but `
          + "acceptance-checklist.md is missing",
      );
    }
    return errors;
  }

  const reqSet = new Set(contractReqIds);
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.acId)) {
      errors.push(`duplicate checklist row id ${row.acId}`);
      continue;
    }
    seen.add(row.acId);
    if (row.method === null) {
      errors.push(`checklist row ${row.acId} has an unrecognized method (use cmd | run | human)`);
    }
    if (row.status !== "pending") {
      errors.push(`checklist row ${row.acId} must start as 'pending' (found '${row.status}')`);
    }
    const req = normalizeReqCell(row.reqId);
    if (req === null || !reqSet.has(req)) {
      errors.push(`checklist row ${row.acId} names ${row.reqId || "(no REQ)"} — not a contract requirement`);
    }
  }

  const byId = new Map(rows.map((r) => [r.acId, r] as const));
  for (const anchor of anchors) {
    const row = byId.get(anchor.acId);
    if (!row) {
      errors.push(`contract acceptance criterion ${anchor.acId} has no checklist row`);
      continue;
    }
    if (anchor.method !== null && row.method !== null && row.method !== anchor.method) {
      errors.push(
        `checklist row ${anchor.acId} method '${row.method}' differs from the `
          + `contract anchor '(${anchor.method})'`,
      );
    }
  }
  return errors;
}

const VERIFY_TOKENS: ReadonlySet<string> = new Set([
  "verified",
  "verify",
  "yes",
  "ok",
  "okay",
  "approve",
  "approved",
  "lgtm",
]);

/**
 * Classify the owner's reply to a human-verify escalation. Only an explicit
 * affirmative FIRST TOKEN signs the rows off; anything else (including a
 * description of what's wrong) marks them failed with the reply as evidence.
 */
export function parseHumanVerifyReply(answer: string): "verified" | "rejected" {
  // String.split always yields at least one element, so [0] is never absent.
  const first = answer.trim().split(/\s+/)[0]!.toLowerCase().replace(/[.,!]+$/, "");
  return VERIFY_TOKENS.has(first) ? "verified" : "rejected";
}
