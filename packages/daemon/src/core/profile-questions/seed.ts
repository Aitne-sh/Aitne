/**
 * Profile-interview queue — Layer 1 (skeleton-time deterministic
 * pre-tick).
 *
 * Walks every `[ ]` row in `agent/profile-questions.md ## Pending` and
 * marks rows whose target slot is already filled (per
 * `isSlotFilled` — §3.5.6 of the design). Appends a matching
 * `(reconciled:skeleton)` entry to `## Answered` for each tick.
 *
 * Idempotency. The caller (skeleton.ts) gates this so it runs only on
 * first creation of the queue file. On reinstall over an existing
 * vault, Layer 4 (the daily LLM sweep) is what reconciles drift —
 * Layer 1 must NOT overwrite hand-edits or per-row `last_attempted`
 * history.
 *
 * Pure-deterministic — no LLM, no network. Tested in `seed.test.ts`.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isSlotFilled } from "./slot-filled.js";

export interface SeedResult {
  /** Pending rows examined (regardless of outcome). */
  examined: number;
  /** Rows transitioned `[ ]` → `[x]` in this run. */
  ticked: number;
  /** Rows whose target file did not exist (skipped, not ticked). */
  targetMissing: number;
}

export interface PendingRowMeta {
  /** Original line text, preserved byte-for-byte for in-place rewrite. */
  line: string;
  /** Index in `lines[]` of the queue file. */
  lineIndex: number;
  done: boolean;
  priority: "HIGH" | "MID" | "LOW";
  id: string;
  targetPath: string;
  targetSection: string | null;
  anchor: string | null;
}

const PENDING_ROW_RE =
  /^- \[([ xX])\] \((HIGH|MID|LOW)\) ([a-z][a-z0-9_]*)\s*::\s*(.+)$/;
const HEADING_RE = /^(#{2,6})\s+(.+?)\s*$/;
const QUEUE_PATH_REL = "agent/profile-questions.md";

/**
 * Run the deterministic Layer 1 pre-tick on `agent/profile-questions.md`
 * inside `contextDir`. Returns counts for telemetry / logging. Safe to
 * call when the queue file does not exist (returns zeros).
 */
export function preTickProfileQuestions(contextDir: string): SeedResult {
  const queuePath = join(contextDir, QUEUE_PATH_REL);
  if (!existsSync(queuePath)) {
    return { examined: 0, ticked: 0, targetMissing: 0 };
  }
  const original = readFileSync(queuePath, "utf-8");
  const lines = original.split("\n");
  const rows = parsePendingRows(lines);
  const today = new Date().toISOString().slice(0, 10);

  let ticked = 0;
  let targetMissing = 0;
  const newAnsweredEntries: string[] = [];

  for (const row of rows) {
    if (row.done) continue;
    const targetAbs = join(contextDir, row.targetPath);
    if (!existsSync(targetAbs)) {
      targetMissing++;
      continue;
    }
    const fileBody = readFileSync(targetAbs, "utf-8");
    const result = isSlotFilled(fileBody, row.targetSection, row.anchor);
    if (!result.filled) continue;
    // Tick in place — preserve everything else byte-for-byte.
    lines[row.lineIndex] = row.line.replace(/^- \[ \]/, "- [x]");
    newAnsweredEntries.push(`- [x] ${today} → ${row.id} (reconciled:skeleton)`);
    ticked++;
  }

  if (ticked === 0) {
    return { examined: rows.length, ticked: 0, targetMissing };
  }

  insertAnsweredEntries(lines, newAnsweredEntries);
  writeFileSync(queuePath, lines.join("\n"), "utf-8");
  return { examined: rows.length, ticked, targetMissing };
}

function parsePendingRows(lines: string[]): PendingRowMeta[] {
  const rows: PendingRowMeta[] = [];
  let inPending = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const depth = heading[1].length;
      const name = heading[2].trim().toLowerCase();
      // Top-level `## Pending` / `## In Progress` / `## Answered`.
      if (depth === 2) inPending = name === "pending";
      // Subsection inside Pending (`### Identity` etc.) doesn't change state.
      continue;
    }
    if (!inPending) continue;
    const m = PENDING_ROW_RE.exec(line);
    if (!m) continue;
    const [, doneMark, priority, id, rest] = m;
    const parsed = parseRowRest(rest);
    if (parsed === null) continue;
    rows.push({
      line,
      lineIndex: i,
      done: doneMark.toLowerCase() === "x",
      priority: priority as PendingRowMeta["priority"],
      id,
      targetPath: parsed.targetPath,
      targetSection: parsed.targetSection,
      anchor: parsed.anchor,
    });
  }
  return rows;
}

function parseRowRest(rest: string): {
  targetPath: string;
  targetSection: string | null;
  anchor: string | null;
} | null {
  // Strip the optional `<!-- last_attempted=... -->` HTML comment so the
  // `::` split below stays stable.
  const clean = rest.replace(/<!--\s*last_attempted=[^>]*-->/g, "").trim();
  const parts = clean
    .split("::")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length < 2) return null;
  const target = parts[0];

  let anchor: string | null = null;
  const optionsAndHint = parts.slice(1);
  // The first chunk after target may be `match=<anchor>`. After that
  // comes the hint, which we don't need for seeding (Layer 1 is purely
  // structural).
  if (optionsAndHint.length >= 2) {
    const first = optionsAndHint[0];
    if (/^match=/i.test(first)) {
      anchor = first.slice("match=".length).trim();
    }
  }

  // Split target into path + optional `## Section`.
  const sectionMatch = / ## (.+)$/.exec(target);
  const targetPath = sectionMatch ? target.slice(0, sectionMatch.index).trim() : target.trim();
  const targetSection = sectionMatch ? sectionMatch[1].trim() : null;
  // Defensive: parts[0] is non-empty (filtered upstream), and the section
  // regex requires a space before `##`, so the slice/trim cannot leave an
  // empty path. Kept as registry-drift insurance.
  /* c8 ignore next */
  if (targetPath.length === 0) return null;

  return { targetPath, targetSection, anchor };
}

/**
 * Insert new Answered entries directly under the `## Answered` heading
 * (after any directive `> ...` lines). Replaces the leading `(none)`
 * placeholder bullet with the new entries on first add, so the section
 * doesn't accumulate stale `- (none)` cruft above real entries.
 * Idempotent against missing-section scenarios — appends a fresh
 * `## Answered` block at end of file when the heading is absent (rare;
 * the seed template ships one).
 */
function insertAnsweredEntries(lines: string[], entries: string[]): void {
  const answeredIdx = lines.findIndex((l) => /^##\s+Answered\s*$/.test(l));
  if (answeredIdx === -1) {
    if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
    lines.push("## Answered", ...entries, "");
    return;
  }
  let insertAt = answeredIdx + 1;
  // Walk past `> ...` directive lines and blank lines.
  while (insertAt < lines.length) {
    const l = lines[insertAt];
    if (l.startsWith(">") || l.trim() === "") { insertAt++; continue; }
    break;
  }
  // Replace a leading `- (none)` placeholder with the new entries on
  // first add. After this, the placeholder is gone forever and
  // subsequent inserts simply prepend ahead of existing entries.
  if (insertAt < lines.length && /^- \(none\)\s*$/i.test(lines[insertAt])) {
    lines.splice(insertAt, 1, ...entries);
  } else {
    lines.splice(insertAt, 0, ...entries);
  }
}
