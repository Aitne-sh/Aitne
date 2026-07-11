/**
 * `!status` dev-session section — a compact, mobile-tight snapshot of the
 * active (or newest channel-bound) dev session appended to the task-control
 * status reply. `buildDevStatusSnapshot` is the I/O aggregation (db + git);
 * `formatDevStatus` is a pure renderer over the snapshot (unit-tested).
 *
 * I/O-bound aggregation; excluded from the coverage gate (peer test still
 * exercises both halves).
 */

import type Database from "better-sqlite3";
import {
  countDevRequirements,
  getActiveDevSession,
  getLatestDevSessionForChannel,
  type DevSessionRow,
} from "../../db/dev-sessions-store.js";
import { getOpenDevEscalationForSession } from "../../db/dev-session-escalations-store.js";
import { listDevChecklist } from "../../db/dev-session-checklist-store.js";
import { listDevTasks } from "../../db/dev-session-tasks-store.js";

export interface DevStatusSnapshot {
  slug: string;
  state: DevSessionRow["state"];
  loopState: DevSessionRow["loopState"];
  iteration: number;
  maxIterations: number | null;
  reqMet: number;
  reqTotal: number;
  acVerified: number;
  acTotal: number;
  acHumanPending: number;
  costUsd: number | null;
  maxBudgetUsd: number | null;
  branch: string | null;
  tasksMerged: number;
  tasksTotal: number;
  queuedManual: number;
  openQuestionAgeMs: number | null;
}

/** Snapshot the session a status command should show: the ACTIVE session
 *  (channel-bound), else the newest session for this chat channel; null when
 *  the channel has no dev history. */
export function buildDevStatusSnapshot(
  db: Database.Database,
  channel: string,
  now: number,
): DevStatusSnapshot | null {
  const active = getActiveDevSession(db);
  const session =
    active && (!active.originatingChannel || active.originatingChannel === channel)
      ? active
      : active
        ? null // an active session on another channel — not this channel's story
        : getLatestDevSessionForChannel(db, channel);
  if (!session) return null;
  const { total, met } = countDevRequirements(db, session.id);
  const checklist = listDevChecklist(db, session.id);
  const tasks = listDevTasks(db, session.id);
  const open = getOpenDevEscalationForSession(db, session.id);
  return {
    slug: session.slug ?? session.repositoryId,
    state: session.state,
    loopState: session.loopState,
    iteration: session.iteration,
    maxIterations: session.maxIterations,
    reqMet: met,
    reqTotal: total,
    acVerified: checklist.filter((r) => r.status === "verified").length,
    acTotal: checklist.length,
    acHumanPending: checklist.filter((r) => r.method === "human" && r.status !== "verified").length,
    costUsd: session.costUsd,
    maxBudgetUsd: session.maxBudgetUsd,
    branch: session.branch,
    tasksMerged: tasks.filter((t) => t.state === "merged").length,
    tasksTotal: tasks.length,
    queuedManual: tasks.filter((t) => t.state === "queued" && t.origin === "manual").length,
    openQuestionAgeMs: open ? Math.max(0, now - open.askedAt) : null,
  };
}

/** The action the owner would take next, per state. */
function nextAction(s: DevStatusSnapshot): string | null {
  switch (s.state) {
    case "interview":
      return "describe the work to continue the interview";
    case "awaiting_approval":
      return "!approve to start";
    case "awaiting_user":
      return "answer the open question in chat";
    case "failed":
    case "exited":
      // A pre-approval exit never created a branch — neither !resume nor
      // !rollback applies, so don't offer a dead-end.
      return s.branch === null
        ? "start fresh with !repo"
        : "!resume to continue · !rollback to restore your branch";
    case "done":
      return s.queuedManual > 0 ? "!resume to run the queued adds" : "!add for follow-up work";
    default:
      return null;
  }
}

/** Pure renderer — one compact block (≤ ~500 chars) for the chat reply. */
export function formatDevStatus(s: DevStatusSnapshot): string {
  const lines: string[] = [];
  const head = `dev ${s.slug}: ${s.state}${s.loopState ? `/${s.loopState}` : ""}`;
  const iter = `iter ${s.iteration}${s.maxIterations !== null ? `/${s.maxIterations}` : ""}`;
  const reqs = s.reqTotal > 0 ? `REQ ${s.reqMet}/${s.reqTotal}` : null;
  const acs =
    s.acTotal > 0
      ? `AC ${s.acVerified}/${s.acTotal}${s.acHumanPending > 0 ? ` (${s.acHumanPending} await your sign-off)` : ""}`
      : null;
  const cost =
    s.costUsd !== null
      ? `$${s.costUsd.toFixed(2)}${s.maxBudgetUsd !== null ? `/$${s.maxBudgetUsd}` : ""}`
      : null;
  lines.push([head, iter, reqs, acs, cost].filter((p) => p !== null).join(" · "));
  if (s.tasksTotal > 0) {
    lines.push(
      `fleet: ${s.tasksMerged}/${s.tasksTotal} merged`
        + (s.queuedManual > 0 ? ` · ${s.queuedManual} manual queued` : ""),
    );
  }
  if (s.branch) lines.push(`branch: ${s.branch}`);
  if (s.openQuestionAgeMs !== null) {
    const mins = Math.round(s.openQuestionAgeMs / 60_000);
    lines.push(`open question waiting ${mins >= 60 ? `${Math.round(mins / 60)}h` : `${mins}m`}`);
  }
  const action = nextAction(s);
  if (action) lines.push(`→ ${action}`);
  return lines.join("\n");
}
