/**
 * Pure deterministic pre-filter for observations awaiting summarization.
 *
 * Implements the "deny-list, no LLM" stage from
 * `docs/design/appendices/cost-reduction-structural.md` §A. Eliminates the
 * bulk of noise observations (agent self-writes, lockfiles, vendored
 * directories, large binaries) before any LLM call, keeping the daily
 * summarizer budget bounded.
 *
 * The pre-filter is total: every (source, ref, payload) triple resolves
 * to exactly one of three outcomes that the worker translates into
 * concrete column writes:
 *   - `skipped` — agent-actor / deny-list path / unsupported source.
 *     Worker writes `summary_status='skipped'` with no LLM call.
 *   - `done` — deterministic summary fits without LLM (deletions, large
 *     files reduced to metadata). Worker writes `summary_status='done'`
 *     with the supplied `summaryText` + `noveltyScore`.
 *   - `proceed` — needs an LLM call. Worker enqueues against the per-
 *     source prompt template. `noveltyFloor` is honored as a lower bound
 *     on the final score (e.g., VIP mail boosts to 3).
 *
 * The decision is a pure function of the observation columns plus
 * caller-injected config (`vipMailSenders`, `largeFileBytes`). No DB
 * reads, no I/O — the worker can call this in a tight loop without
 * blocking the queue drain.
 */

import { looksLikeSecretPath } from "../../safety/always-disallowed.js";

const SUMMARIZER_DENY_PATH_FRAGMENTS = [
  // Vendored / generated artifacts that produce churn but no signal.
  "/.git/",
  "/node_modules/",
  "/dist/",
  "/build/",
  "/.next/",
  "/.turbo/",
  "/.cache/",
  "/.venv/",
  "/venv/",
  "/__pycache__/",
  "/coverage/",
  "/.pytest_cache/",
  "/target/",
  "/.idea/",
  "/.vscode/",
] as const;

const SUMMARIZER_DENY_FILE_BASENAMES = new Set<string>([
  ".DS_Store",
  ".buildstamp",
  "Thumbs.db",
]);

const SUMMARIZER_DENY_FILE_PATTERNS: readonly RegExp[] = [
  /\.lock$/i,
  /\.lockb$/i,
  /package-lock\.json$/i,
  /pnpm-lock\.yaml$/i,
  /yarn\.lock$/i,
  /Cargo\.lock$/i,
  /Pipfile\.lock$/i,
  /poetry\.lock$/i,
  /\.log(?:\.\d+)?$/i,
  /\.log\.gz$/i,
];

/** Default upper bound for "summarize the body" — anything larger drops to metadata-only. */
export const DEFAULT_LARGE_FILE_BYTES = 256 * 1024;

export type ObservationActor = "user" | "agent" | "system" | "unknown";
export type ObservationChangeType = "created" | "modified" | "deleted";

export interface PreFilterObservationInput {
  source: string;
  ref: string;
  changeType: ObservationChangeType;
  actor: ObservationActor;
  payload: unknown;
}

export interface PreFilterConfig {
  /** Email addresses (case-insensitive, exact match) whose mail observations boost novelty floor to 3. */
  vipMailSenders?: readonly string[];
  /** Bytes above which file-source observations short-circuit to metadata-only. Default 256 KB. */
  largeFileBytes?: number;
}

export type PreFilterDecision =
  | { kind: "skipped"; reason: SkipReason }
  | { kind: "done"; summaryText: string; noveltyScore: 0 | 1 }
  | { kind: "proceed"; noveltyFloor?: 1 | 2 | 3 };

export type SkipReason =
  | "agent_actor"
  | "deny_path"
  | "deny_basename"
  | "deny_pattern"
  | "secret_path";

/**
 * Apply the pre-filter to one observation.
 *
 * @returns the deterministic decision; the worker handles persistence.
 */
export function preFilterObservation(
  input: PreFilterObservationInput,
  config: PreFilterConfig = {},
): PreFilterDecision {
  // 1. Agent self-writes are filtered upstream by AgentWriteTracker, but
  //    if one slips through (race window, missed mark) we re-check here.
  if (input.actor === "agent") {
    return { kind: "skipped", reason: "agent_actor" };
  }

  // 2. Deletion shortcut: nothing to read, deterministic one-liner.
  if (input.changeType === "deleted") {
    return {
      kind: "done",
      summaryText: `[deleted] ${input.ref}`,
      noveltyScore: 1,
    };
  }

  // 3a. Secret-file deny list — mirrors the agent's own
  //     `always-disallowed.ts` read-side denylist so a payload that
  //     reaches the summarizer never carries credential-file content
  //     into the LLM context. Belt-and-braces: the redactor downstream
  //     scrubs known secret patterns inside payload text, but the path
  //     deny here ensures we don't even submit the body.
  if (looksLikeSecretPath(input.ref)) {
    return { kind: "skipped", reason: "secret_path" };
  }

  // 3b. Path-based deny list — vendored / generated / lock files.
  const pathDeny = matchPathDeny(input.ref);
  if (pathDeny !== null) {
    return { kind: "skipped", reason: pathDeny };
  }

  // 4. Large-file shortcut: avoid passing megabytes of payload to the LLM.
  const sizeBytes = readSizeBytes(input.payload);
  const largeCap = config.largeFileBytes ?? DEFAULT_LARGE_FILE_BYTES;
  if (sizeBytes !== null && sizeBytes > largeCap) {
    return {
      kind: "done",
      summaryText: `[large file ${formatBytes(sizeBytes)}] ${input.ref}`,
      noveltyScore: 0,
    };
  }

  // 5. VIP mail boost — set a novelty FLOOR before the LLM runs so a
  //    short-shape "thanks!" from the user's manager still routes to
  //    today.md. The summarizer can raise above the floor but not below.
  if (isVipMailObservation(input, config.vipMailSenders ?? [])) {
    return { kind: "proceed", noveltyFloor: 3 };
  }

  return { kind: "proceed" };
}

// ── Internal helpers ────────────────────────────────────────────────────

function matchPathDeny(ref: string): SkipReason | null {
  // Path fragments — match anywhere in the ref. Wrap in slashes so a
  // top-level "node_modules" still matches a leading segment.
  const wrapped = `/${ref.replace(/\\/g, "/")}/`;
  for (const fragment of SUMMARIZER_DENY_PATH_FRAGMENTS) {
    if (wrapped.includes(fragment)) {
      return "deny_path";
    }
  }

  // Basename + glob-ish pattern matchers.
  const basename = lastPathSegment(ref);
  if (SUMMARIZER_DENY_FILE_BASENAMES.has(basename)) {
    return "deny_basename";
  }
  for (const pattern of SUMMARIZER_DENY_FILE_PATTERNS) {
    if (pattern.test(basename)) {
      return "deny_pattern";
    }
  }
  return null;
}

function lastPathSegment(ref: string): string {
  const normalized = ref.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

function readSizeBytes(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const candidates = [record["sizeBytes"], record["fileSize"], record["size"]];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
      return candidate;
    }
  }
  return null;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function isVipMailObservation(
  input: PreFilterObservationInput,
  vipSenders: readonly string[],
): boolean {
  if (vipSenders.length === 0) return false;
  if (!input.source.startsWith("mail:")) return false;
  if (!input.payload || typeof input.payload !== "object") return false;
  const record = input.payload as Record<string, unknown>;
  const sender = pickSenderEmail(record);
  if (!sender) return false;
  const lc = sender.toLowerCase();
  return vipSenders.some((vip) => vip.toLowerCase() === lc);
}

function pickSenderEmail(payload: Record<string, unknown>): string | null {
  // Mail observation payloads vary by provider — tolerate the common shapes.
  const direct = payload["from"] ?? payload["sender"] ?? payload["fromAddress"];
  if (typeof direct === "string" && direct.length > 0) {
    const match = direct.match(/<([^>]+)>/);
    return (match ? match[1] : direct).trim();
  }
  if (Array.isArray(payload["subjects"])) {
    // mail:lifecycle aggregated payload — no per-sender info available.
    return null;
  }
  return null;
}
