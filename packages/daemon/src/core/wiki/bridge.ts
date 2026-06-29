/**
 * WIKI_BUILDER_DESIGN.md Phase 5 — bridge mechanism.
 *
 * The DM agent (or any in-process caller) proposes a bridge candidate;
 * this module decides whether to:
 *
 *   1. drop it as a loop-guard violation (the source is itself a
 *      bridge file — never re-bridge our own output),
 *   2. drop it as below the per-workspace confidence threshold
 *      (`bridge_min_confidence`, §10.3 Q6),
 *   3. dedup it against an earlier proposal with the same canonical
 *      content (§10.3 Q3 — SHA-256 over normalised body text),
 *   4. log it as a `wiki.bridge.candidate` row in `agent_actions` while
 *      the workspace is in measurement-only mode (§P5.A),
 *   5. write it to `<vault>/10_raw/bridge-<ts>-<slug>.md` with the
 *      `type: bridge` frontmatter the compiler keys on (§10.2).
 *
 * Pure-ish: the writer takes its filesystem clock as `nowIso`/`nowMs`
 * for deterministic tests. Real callers use the no-arg defaults.
 */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type Database from "better-sqlite3";
import type {
  WikiBridgeOutcome,
  WikiBridgeProposal,
  WikiBridgeResult,
} from "@aitne/shared";
import { writeFileAtomically } from "../atomic-write.js";
import { upsertWikiFulltextRow } from "./wiki-fts.js";
import type { WikiWorkspaceRow } from "./workspaces.js";

export const BRIDGE_FILE_RE = /^10_raw\/bridge-[a-z0-9][a-z0-9-]*\.md$/;
const BRIDGE_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Inputs the bridge writer takes. The proposal payload is the
 * `WikiBridgeProposal` from `@aitne/shared`; the workspace + db come
 * from the API route handler.
 */
export interface ProcessBridgeProposalInput {
  db: Database.Database;
  workspace: WikiWorkspaceRow;
  proposal: WikiBridgeProposal;
  /** Override the timestamp used for filename + frontmatter. Tests only. */
  nowIso?: string;
  /** Override the actor recorded in `agent_actions`. Tests only. */
  actor?: string;
  /**
   * Optional writer override for the bridge file. When omitted, the
   * processor uses `writeFileAtomically` directly — fine for internal
   * workspaces and tests. The API route injects a strategy-aware writer
   * here so external-mode workspaces (iCloud-sandboxed) fall back to
   * the Obsidian CLI on EPERM instead of throwing. Signature mirrors
   * `WikiWriteStrategyResolver.writeFile` (workspace-relative path).
   */
  writeFile?: (relPath: string, content: string) => Promise<void>;
}

/**
 * The chokepoint. Synchronous (no network or LLM dependency): hashing,
 * dedup lookup, and file write are all local. The route handler awaits
 * it but only the FS write is async-shaped.
 */
export async function processBridgeProposal(
  input: ProcessBridgeProposalInput,
): Promise<WikiBridgeResult> {
  const { db, workspace, proposal } = input;
  const nowIso = input.nowIso ?? new Date().toISOString();
  const confidence = effectiveConfidence(proposal);
  const contentHash = computeBridgeContentHash(proposal);
  const dedupKey = {
    sourceKind: proposal.sourceKind,
    sourceRef: proposal.sourceRef,
  };

  // (1) Loop guard. The DM agent must never bridge its own output — a
  // `sourceRef` that already names a bridge file is a self-reference
  // and would compound on every compile. The check is path-shaped
  // because `sourceRef` semantics differ per caller (a session id, a
  // file path, a message id), but only the file-path case can collide.
  if (BRIDGE_FILE_RE.test(proposal.sourceRef)) {
    recordBridgeAudit(db, workspace, {
      actor: input.actor,
      outcome: "loop_guard",
      proposal,
      confidence,
      contentHash,
      path: null,
      detectedAtIso: nowIso,
    });
    return {
      outcome: "loop_guard",
      workspace: workspace.name,
      path: null,
      contentHash,
      confidence,
      measurementOnly: workspace.bridge_measurement_only === 1,
      dedupKey,
      reason: "source is itself a bridge file",
    };
  }

  // (2) Feature gate. `bridge_enabled = 0` means the workspace owner
  // never opted in; we don't even log a candidate row. `dm_agent_write_enabled`
  // is the API-route precondition; this module trusts the route's
  // 403 enforcement and only re-checks `bridge_enabled` because the
  // in-process callers (e.g. a future routine) bypass the route auth.
  if (workspace.bridge_enabled !== 1) {
    return {
      outcome: "feature_disabled",
      workspace: workspace.name,
      path: null,
      contentHash,
      confidence,
      measurementOnly: workspace.bridge_measurement_only === 1,
      dedupKey,
      reason: "bridge_enabled is 0 on the workspace",
    };
  }

  // (3) Confidence threshold. Explicit triggers always pass — the
  // owner asked for it. Self-judged proposals must clear the
  // per-workspace floor.
  if (proposal.trigger === "self_judged" && confidence < workspace.bridge_min_confidence) {
    recordBridgeAudit(db, workspace, {
      actor: input.actor,
      outcome: "below_threshold",
      proposal,
      confidence,
      contentHash,
      path: null,
      detectedAtIso: nowIso,
    });
    return {
      outcome: "below_threshold",
      workspace: workspace.name,
      path: null,
      contentHash,
      confidence,
      measurementOnly: workspace.bridge_measurement_only === 1,
      dedupKey,
      reason: `confidence ${confidence} below threshold ${workspace.bridge_min_confidence}`,
    };
  }

  // (4) Dedup. The unique index on `(workspace_id, content_hash)` is
  // the durable enforcement; the SELECT lets us return the prior
  // bridge's path so the caller (and the audit row) can surface "this
  // is the same insight you bridged on 2026-05-01".
  const prior = db
    .prepare(
      `SELECT bridge_path FROM wiki_bridge_dedup
       WHERE workspace_id = ? AND content_hash = ?
       LIMIT 1`,
    )
    .get(workspace.id, contentHash) as { bridge_path: string | null } | undefined;
  if (prior) {
    recordBridgeAudit(db, workspace, {
      actor: input.actor,
      outcome: "deduplicated",
      proposal,
      confidence,
      contentHash,
      path: null,
      detectedAtIso: nowIso,
      existingPath: prior.bridge_path,
    });
    return {
      outcome: "deduplicated",
      workspace: workspace.name,
      path: null,
      contentHash,
      confidence,
      measurementOnly: workspace.bridge_measurement_only === 1,
      dedupKey,
      existingPath: prior.bridge_path,
      reason: "same content_hash already bridged in this workspace",
    };
  }

  // (5) Measurement-only mode. Log the candidate, persist the dedup
  // row (so a re-proposal of the same content still short-circuits),
  // but do NOT touch the filesystem.
  const measurementOnly = workspace.bridge_measurement_only === 1;
  if (measurementOnly) {
    db.prepare(
      `INSERT OR IGNORE INTO wiki_bridge_dedup
         (workspace_id, content_hash, source_kind, source_ref,
          bridge_path, confidence, accepted, detected_at)
       VALUES (?, ?, ?, ?, NULL, ?, 0, ?)`,
    ).run(
      workspace.id,
      contentHash,
      proposal.sourceKind,
      proposal.sourceRef,
      confidence,
      nowIso,
    );
    recordBridgeAudit(db, workspace, {
      actor: input.actor,
      outcome: "candidate_logged",
      proposal,
      confidence,
      contentHash,
      path: null,
      detectedAtIso: nowIso,
    });
    return {
      outcome: "candidate_logged",
      workspace: workspace.name,
      path: null,
      contentHash,
      confidence,
      measurementOnly: true,
      dedupKey,
      reason: "workspace is in bridge_measurement_only mode",
    };
  }

  // (6) Real write. Compose the filename and body, snapshot the dedup
  // row, then materialise. The file is `create-only` (the raw-layer
  // append-only invariant) so we rely on the unique-index dedup to
  // serialise identical content; truly-distinct content gets a
  // unique timestamp+slug filename.
  const slug = canonicalBridgeSlug(proposal);
  const filename = bridgeFilename(nowIso, slug);
  const relPath = `10_raw/${filename}`;
  const absPath = resolve(workspace.root_path, relPath);
  const body = renderBridgeMarkdown(proposal, {
    detectedAtIso: nowIso,
    confidence,
    workspaceName: workspace.name,
  });

  mkdirSync(dirname(absPath), { recursive: true });
  if (input.writeFile) {
    await input.writeFile(relPath, body);
  } else {
    writeFileAtomically(absPath, body);
  }

  db.prepare(
    `INSERT OR REPLACE INTO wiki_bridge_dedup
       (workspace_id, content_hash, source_kind, source_ref,
        bridge_path, confidence, accepted, detected_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
  ).run(
    workspace.id,
    contentHash,
    proposal.sourceKind,
    proposal.sourceRef,
    relPath,
    confidence,
    nowIso,
  );

  upsertWikiFulltextRow(db, {
    workspaceId: workspace.id,
    path: relPath,
    layer: "raw",
    content: body,
  });

  recordBridgeAudit(db, workspace, {
    actor: input.actor,
    outcome: "written",
    proposal,
    confidence,
    contentHash,
    path: relPath,
    detectedAtIso: nowIso,
  });

  db.prepare(
    `UPDATE wiki_workspaces SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
  ).run(workspace.id);

  return {
    outcome: "written",
    workspace: workspace.name,
    path: relPath,
    contentHash,
    confidence,
    measurementOnly: false,
    dedupKey,
  };
}

/**
 * Public helper — exposed for tests and dashboard inspection. Same
 * normalisation rule the writer uses so callers that need to
 * pre-dedup against `wiki_bridge_dedup` can reproduce the hash.
 */
export function computeBridgeContentHash(
  proposal: Pick<WikiBridgeProposal, "summary" | "excerpt">,
): string {
  return createHash("sha256")
    .update(normaliseForHash(proposal.summary))
    .update("\n--\n")
    .update(normaliseForHash(proposal.excerpt))
    .digest("hex");
}

/**
 * Canonicalise free-form prose into a stable hash input: lowercase,
 * collapse whitespace, strip trailing/leading whitespace, and drop
 * common punctuation. Survives spelling-preserving paraphrases that
 * keep the same words but re-flow them across lines.
 */
function normaliseForHash(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\p{Pd}\p{Pe}\p{Pf}\p{Pi}\p{Po}\p{Ps}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function effectiveConfidence(proposal: WikiBridgeProposal): number {
  if (proposal.trigger === "explicit") return 1;
  if (typeof proposal.confidence !== "number") return 0;
  return Math.max(0, Math.min(1, proposal.confidence));
}

/**
 * Filename derivation per §10.2. Timestamp segment encodes seconds-
 * resolution and is timezone-stable (UTC). Slug is derived from the
 * caller's hint or, failing that, from the summary's first words.
 */
export function bridgeFilename(nowIso: string, slug: string): string {
  const ts = nowIso.replace(/[-:T]/g, "").replace(/\..+/, "").slice(0, 14);
  // ts is e.g. "20260512T101530" → strip the embedded T → "20260512101530"
  // but we want a hyphenated form `YYYY-MM-DD-HHmmss`.
  const formatted = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}-${ts.slice(8, 14)}`;
  return `bridge-${formatted}-${slug}.md`;
}

/**
 * Slug derivation. Caller hint wins when it matches the slug regex;
 * otherwise we slugify the summary's first words. We clamp to 40
 * chars so the filename stays well within ext4 / APFS 255-byte limits
 * after the `bridge-<ts>-` prefix.
 */
export function canonicalBridgeSlug(proposal: WikiBridgeProposal): string {
  const hint = (proposal.slug ?? "").trim().toLowerCase();
  if (hint && BRIDGE_SLUG_RE.test(hint)) return clampSlug(hint);
  return clampSlug(slugifyFromSummary(proposal.summary));
}

function slugifyFromSummary(summary: string): string {
  const slug = summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "untitled";
}

function clampSlug(slug: string): string {
  return slug.slice(0, 40).replace(/-+$/, "") || "untitled";
}

interface BridgeRenderContext {
  detectedAtIso: string;
  confidence: number;
  workspaceName: string;
}

/**
 * `type: bridge` frontmatter — the compiler keys segregation on this
 * (§10.2). The body carries the summary first, then the verbatim
 * excerpt under a heading the compiler can locate without parsing the
 * agent's prose. When the caller supplies a `body` override we use it
 * verbatim — the LLM may want to phrase it differently than the
 * default scaffold.
 */
export function renderBridgeMarkdown(
  proposal: WikiBridgeProposal,
  ctx: BridgeRenderContext,
): string {
  if (proposal.body) {
    return proposal.body.endsWith("\n") ? proposal.body : `${proposal.body}\n`;
  }
  const lines: string[] = [];
  lines.push("---");
  lines.push(`type: bridge`);
  lines.push(`workspace: ${ctx.workspaceName}`);
  lines.push(`trigger: ${proposal.trigger}`);
  lines.push(`detected_at: ${ctx.detectedAtIso}`);
  lines.push(`confidence: ${ctx.confidence.toFixed(2)}`);
  lines.push(`source_kind: ${proposal.sourceKind}`);
  lines.push(`source_ref: ${proposal.sourceRef}`);
  if (proposal.sessionId) lines.push(`session_id: ${proposal.sessionId}`);
  if (proposal.messageId) lines.push(`message_id: ${proposal.messageId}`);
  if (proposal.routineName) lines.push(`routine: ${proposal.routineName}`);
  lines.push("---");
  lines.push("");
  lines.push("# Bridge");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(proposal.summary.trim());
  lines.push("");
  lines.push("## Source excerpt");
  lines.push("");
  lines.push(proposal.excerpt.trim());
  lines.push("");
  return `${lines.join("\n")}`;
}

interface BridgeAuditInput {
  actor?: string;
  outcome: WikiBridgeOutcome;
  proposal: WikiBridgeProposal;
  confidence: number;
  contentHash: string;
  path: string | null;
  detectedAtIso: string;
  existingPath?: string | null;
}

/**
 * §11.1 — re-use `agent_actions`. The action_type encodes the outcome
 * so the dashboard timeline filter can split written vs. candidate vs.
 * dedup rows without parsing `detail` JSON.
 *
 *   - `wiki.bridge`            — written
 *   - `wiki.bridge.candidate`  — measurement-only candidate logged
 *   - `wiki.bridge.dedup`      — dedup short-circuit
 *   - `wiki.bridge.skip`       — below_threshold / loop_guard
 *
 * `source_kind = 'wiki'` keeps the existing
 * `idx_agent_actions_source` lookup working for the wiki dashboard.
 */
function recordBridgeAudit(
  db: Database.Database,
  workspace: WikiWorkspaceRow,
  input: BridgeAuditInput,
): void {
  const actionType = bridgeActionType(input.outcome);
  const detail = {
    processKey: "wiki.bridge",
    workspace: workspace.name,
    workspace_id: workspace.id,
    outcome: input.outcome,
    trigger: input.proposal.trigger,
    confidence: input.confidence,
    content_hash: input.contentHash,
    source_kind_of: input.proposal.sourceKind,
    source_ref_of: input.proposal.sourceRef,
    session_id: input.proposal.sessionId ?? null,
    message_id: input.proposal.messageId ?? null,
    routine: input.proposal.routineName ?? null,
    targets: input.path ? [input.path] : [],
    existing_path: input.existingPath ?? null,
    summary_chars: input.proposal.summary.length,
    excerpt_chars: input.proposal.excerpt.length,
    actor: input.actor ?? "dm-agent",
  };
  db.prepare(
    `INSERT INTO agent_actions
       (event_id, action_type, trigger, result, detail,
        started_at, completed_at, source_kind, source_ref)
     VALUES (?, ?, 'autonomous', ?, json(?), ?, ?, 'wiki', ?)`,
  ).run(
    `wiki.bridge:${workspace.name}:${input.contentHash}`,
    actionType,
    bridgeAuditResult(input.outcome),
    JSON.stringify(detail),
    input.detectedAtIso,
    input.detectedAtIso,
    workspace.name,
  );
}

function bridgeActionType(outcome: WikiBridgeOutcome): string {
  switch (outcome) {
    case "written":
      return "wiki.bridge";
    case "candidate_logged":
      return "wiki.bridge.candidate";
    case "deduplicated":
      return "wiki.bridge.dedup";
    case "below_threshold":
    case "loop_guard":
    case "feature_disabled":
      return "wiki.bridge.skip";
    default: {
      // Exhaustiveness guard — adding a new outcome upstream without
      // mapping it here is a compile-time error.
      const _exhaustive: never = outcome;
      void _exhaustive;
      return "wiki.bridge.skip";
    }
  }
}

function bridgeAuditResult(
  outcome: WikiBridgeOutcome,
): "success" | "skipped" | "partial" {
  if (outcome === "written") return "success";
  if (outcome === "candidate_logged" || outcome === "deduplicated") return "partial";
  return "skipped";
}
