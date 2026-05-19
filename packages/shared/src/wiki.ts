import { z } from "zod";

export const WIKI_PROCESS_KEYS = [
  "wiki.ingest_url",
  "wiki.compile",
  "wiki.ask",
  // WIKI_BUILDER_DESIGN.md Phase 3 — operational triad.
  "wiki.lint",
  "wiki.trace",
  "wiki.connect",
] as const;

export type WikiProcessKey = (typeof WIKI_PROCESS_KEYS)[number];

export const wikiVaultModeSchema = z.enum(["internal", "external"]);
export type WikiVaultMode = z.infer<typeof wikiVaultModeSchema>;

export const wikiDispatchModeSchema = z.enum(["parallel", "serial"]);
export type WikiDispatchMode = z.infer<typeof wikiDispatchModeSchema>;

export const wikiWriteStrategySchema = z.enum(["fs", "cli", "auto"]);
export type WikiWriteStrategy = z.infer<typeof wikiWriteStrategySchema>;

export const wikiCompileModeSchema = z.enum(["incremental", "full"]);
export type WikiCompileMode = z.infer<typeof wikiCompileModeSchema>;

export const wikiImportDecisionSchema = z.enum(["adopt", "migrate", "split"]);
export type WikiImportDecision = z.infer<typeof wikiImportDecisionSchema>;

// PATCH — fields editable from /settings/wiki after a workspace exists.
export const wikiWorkspacePatchSchema = z
  .object({
    language: z.string().min(1).max(64).optional(),
    dispatchMode: wikiDispatchModeSchema.optional(),
    concurrencyCap: z.number().int().min(1).max(10).optional(),
    dmAgentWriteEnabled: z.boolean().optional(),
    // WIKI_BUILDER_DESIGN.md §P5.B — bridge feature gate (the "second
    // key" alongside `dmAgentWriteEnabled`). Both must be `true` for the
    // DM agent to land a `10_raw/bridge-*.md` file.
    bridgeEnabled: z.boolean().optional(),
    bridgeMeasurementOnly: z.boolean().optional(),
    bridgeMinConfidence: z.number().min(0).max(1).optional(),
    fullCompileApprovalThresholdUsd: z.number().min(0).max(100).optional(),
    writeStrategy: wikiWriteStrategySchema.optional(),
    gitPreCompileEnabled: z.boolean().optional(),
    // §P5.C — workspaces are independently activatable in Phase 5.
    // Allows the dashboard to toggle a workspace inactive without deleting
    // it (preserving FTS rows is handled separately by the archive route).
    active: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one wiki workspace field must be provided",
  });

export type WikiWorkspacePatch = z.infer<typeof wikiWorkspacePatchSchema>;

// CREATE — body for POST /api/wiki/workspaces. `kind: "internal"` is the
// P1 default; `kind: "external"` requires a `rootPath` resolved by the
// setup wizard (existing collision rules apply server-side).
export const wikiWorkspaceCreateSchema = z
  .object({
    name: z.string().min(1).max(64).optional(),
    kind: wikiVaultModeSchema.default("internal"),
    rootPath: z.string().min(1).max(2048).optional(),
    language: z.string().min(1).max(64).optional(),
    importDecision: wikiImportDecisionSchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.kind === "external" && !data.rootPath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "rootPath is required for external mode",
        path: ["rootPath"],
      });
    }
  });

export type WikiWorkspaceCreate = z.infer<typeof wikiWorkspaceCreateSchema>;

// Probe — read-only inspection of a candidate external vault path used by
// the setup wizard before the row is created.
export const wikiWorkspaceProbeSchema = z.object({
  rootPath: z.string().min(1).max(2048),
});
export type WikiWorkspaceProbeInput = z.infer<typeof wikiWorkspaceProbeSchema>;

export const wikiFilePostSchema = z.object({
  content: z.string(),
});

export type WikiFilePost = z.infer<typeof wikiFilePostSchema>;

/**
 * WIKI_BUILDER_DESIGN.md §3.4 (completion notification path) — when a
 * wiki.* event was spawned from a bang command on a specific platform
 * (Slack/Telegram/Discord/Dashboard/...), the completion DM should land
 * back on that same channel. The bang handler captures the source
 * MessageEvent's routing tuple and stuffs it on the child event's
 * `data.reply_target` so the ResultProcessor can wire it through to the
 * NotificationManager.
 *
 * `platform` and `channel` are required because they're the minimum the
 * MessageHub needs to dispatch. `threadId` is optional — only some
 * platforms thread replies (Slack does; Telegram/Discord may not depending
 * on context). `sender` is carried for audit/log payloads only; it does
 * not participate in routing.
 *
 * When `reply_target` is absent (e.g. a future routine-triggered wiki
 * session with no originating DM), the completion path falls back to
 * the user's configured notification destinations via
 * `MessageHub.sendToUser` — the "primary messaging app" the user
 * configured in /settings.
 */
export const wikiReplyTargetSchema = z.object({
  platform: z.string().min(1).max(64),
  channel: z.string().min(1).max(256),
  threadId: z.string().min(1).max(256).nullable().optional(),
  sender: z.string().min(1).max(256).optional(),
});

export type WikiReplyTarget = z.infer<typeof wikiReplyTargetSchema>;

export const wikiFilePatchSchema = z
  .object({
    mode: z.enum(["append", "prepend"]),
    content: z.string(),
  })
  .refine((data) => data.content.length > 0, {
    message: "content cannot be empty",
  });

export type WikiFilePatch = z.infer<typeof wikiFilePatchSchema>;

// `!compile full` cost estimate envelope. Pure JS — no agent session.
export interface WikiCostEstimate {
  rawCount: number;
  estimatedInputTokens: number;
  unitCostUsdPerKToken: number;
  optimisticUsd: number; // 0.5×
  expectedUsd: number; // 1.0×
  pessimisticUsd: number; // 2.0×
  thresholdUsd: number;
  exceedsThreshold: boolean;
  // §P4.C — `flat-heuristic` is the legacy P2 path
  // (rawCount × avgInputTokensPerRaw); `per-file-chars` reads each file
  // and counts approximate tokens from its character count. Callers can
  // surface the method in the dashboard so the operator knows whether the
  // figure is a per-file scan or a flat heuristic.
  method: WikiCostEstimateMethod;
  // §P4.C — Top-N raw files by estimated token count. Empty when the
  // estimator ran in `flat-heuristic` mode or when the breakdown limit
  // was zeroed. Sorted descending by `estimatedTokens`.
  perFile: WikiCostEstimateFile[];
}

export type WikiCostEstimateMethod = "flat-heuristic" | "per-file-chars";

export interface WikiCostEstimateFile {
  path: string;
  charCount: number;
  estimatedTokens: number;
}

// WIKI_BUILDER_DESIGN.md Phase 5 — bridge candidate proposal.
//
// `POST /api/wiki/:ws/bridge` accepts this shape from the DM-agent skill
// or from in-process callers (the dispatcher's hourly check, a future
// `morning_routine` post-pass). The daemon decides whether to write,
// dedup-drop, threshold-drop, or just log a candidate (measurement-only
// mode). Trigger is hybrid — the agent may emit an `explicit` proposal
// when the owner says "save this to the wiki" or a `self_judged` one
// when the agent itself detects insight worth bridging (§10.3 Q1).
//
// `sourceKind` and `sourceRef` are paired so the daemon can:
//   - record dedup keys per source (replays from the same conversation
//     surface as repeat insights, not new ones);
//   - enforce the loop guard (a proposed `sourceRef` of "10_raw/bridge-*"
//     means the agent is bridging its own bridge — reject).
//
// `excerpt` is the verbatim source snippet (mandatory: §10.2 body
// requires "verbatim source excerpt"). `summary` is the agent's gloss.
// `body` (optional) lets the caller pre-render the full markdown body;
// when absent the bridge writer composes one from `summary + excerpt`.
export const wikiBridgeTriggerSchema = z.enum(["explicit", "self_judged"]);
export type WikiBridgeTrigger = z.infer<typeof wikiBridgeTriggerSchema>;

export const wikiBridgeProposalSchema = z.object({
  workspace: z.string().min(1).max(64).optional(),
  trigger: wikiBridgeTriggerSchema,
  summary: z.string().min(1).max(2000),
  excerpt: z.string().min(1).max(8000),
  body: z.string().min(1).max(16_000).optional(),
  // 0-1 confidence assigned by the proposer. The owner's explicit ask
  // is treated as `1.0` regardless of what the caller sends, so this
  // governs `self_judged` proposals (gating against `bridgeMinConfidence`).
  confidence: z.number().min(0).max(1).optional(),
  sourceKind: z.string().min(1).max(32),
  sourceRef: z.string().min(1).max(256),
  // Optional provenance for the bridge frontmatter and audit row.
  sessionId: z.string().min(1).max(128).optional(),
  messageId: z.string().min(1).max(128).optional(),
  routineName: z.string().min(1).max(64).optional(),
  // Optional slug hint — the writer canonicalises this to `[a-z0-9-]+`.
  slug: z.string().min(1).max(64).optional(),
});
export type WikiBridgeProposal = z.infer<typeof wikiBridgeProposalSchema>;

// Outcomes the writer surfaces back to the caller. The DM-agent skill
// uses these to phrase the reply ("recorded", "duplicate of …", "below
// confidence threshold", "feature disabled").
export const WIKI_BRIDGE_OUTCOMES = [
  "written",
  "candidate_logged",
  "deduplicated",
  "below_threshold",
  "loop_guard",
  "feature_disabled",
] as const;
export type WikiBridgeOutcome = (typeof WIKI_BRIDGE_OUTCOMES)[number];

export interface WikiBridgeResult {
  outcome: WikiBridgeOutcome;
  workspace: string;
  path: string | null;
  contentHash: string;
  confidence: number;
  measurementOnly: boolean;
  dedupKey?: { sourceKind: string; sourceRef: string };
  /**
   * When `outcome === "deduplicated"`, the path of the earlier bridge
   * that pre-empted this one (if it was written). Null if the first
   * proposal was itself measurement-only or below-threshold.
   */
  existingPath?: string | null;
  reason?: string;
}

// WIKI_BUILDER_DESIGN.md §P4.B — compile diff preview surfaced by
// `!compile --preview` (and `GET /api/wiki/:ws/compile/preview`). The
// touch lists are best-effort: the compiler is an LLM and may diverge
// inside the agent loop, but the preview is an upper bound on what will
// move. `mode` differentiates incremental (only raws newer than
// `last_compile_at` are pending) from full (everything is pending).
export interface WikiCompilePreview {
  workspace: string;
  mode: WikiCompileMode;
  /** Wiki pages predicted to be newly created. */
  added: string[];
  /** Wiki pages predicted to be rewritten. */
  modified: string[];
  /** Files the compiler is expected to skip. */
  unchanged: string[];
  /** Cost & token estimate scaled to the pending raw set. */
  estimate: WikiCostEstimate;
  /** Rough wall-clock seconds the compile is expected to take. */
  estimatedDurationSeconds: number;
}
