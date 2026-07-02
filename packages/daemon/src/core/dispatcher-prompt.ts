/**
 * `PromptAssembler` — composes the dispatcher's per-turn prompt and
 * owns the inbound-attachment lifecycle (staging into the session dir,
 * transcribing audio via local Whisper, and rendering the
 * "[Attached files]" prompt block).
 *
 * Extracted from `core/dispatcher.ts` as part of phase D-2 of
 * `docs/design/appendices/file-split-plan.md`. Pattern B (stateful
 * coordinator): the assembler owns its own logic but borrows live
 * references / accessors for state that the dispatcher continues to
 * own (the `activeTurnTokens` Map, the lazily-injected
 * `AttachmentStore`, and the lazily-injected `VoiceTranscriber`).
 *
 * Dispatcher entry points served:
 *   - every `dispatch.*` path that needs a task-flow prompt
 *     (`runStage2Triage`, `executeMorningRoutine`,
 *     `executeScheduledTask`, `executeDefault`, `handleMessage`);
 *   - `handleMessage` for the inbound attachment lifecycle
 *     (`stageInboundAttachments` → `transcribeAttachments` →
 *     `buildAttachmentPromptBlock`);
 *   - `validateAttachmentTurnToken` (public on `EventDispatcher`,
 *     reads the live `activeTurnTokens` Map this assembler issues
 *     into via `issueAttachmentTurnToken`).
 *
 * Shared-state references held:
 *   - `activeTurnTokens: Map<string, number>` — live reference,
 *     mutated in place via `issueAttachmentTurnToken` /
 *     `releaseAttachmentTurnToken`. The dispatcher's
 *     `validateAttachmentTurnToken` reads the same map.
 *   - `getAttachmentStore` / `getVoiceTranscriber` — getter callbacks
 *     because both are set lazily by `index.ts` after the dispatcher
 *     is constructed. The assembler must read the *current* value at
 *     each call, not capture it once.
 */

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { MessageEvent } from "@aitne/shared";
import type { AgentConfig } from "../config.js";
import { getContextDir } from "../config.js";
import {
  appendPolicyBlocks,
  createPromptInjectionBudget,
  PLAYBOOK_TOTAL_MAX_BYTES,
} from "./policy-files.js";
import { appendPlaybookBlocks } from "./playbook-injection.js";
import { appendReviewContextBlocks } from "./review-context.js";
import { anyMcpServerEnabled } from "../services/mcp/registry.js";
import { readIntegrations } from "../db/integrations-store.js";
import { isDegraded as readDegradedMode } from "../db/runtime-state.js";
import type {
  AttachmentStore,
  StoreAttachmentRow,
} from "../services/attachments/store.js";
import type {
  VoiceTranscriber,
  VoiceTranscriptionResult,
} from "../services/voice/transcriber.js";
import type { GetTaskFlow } from "./dispatcher-types.js";
import { createLogger } from "../logging.js";

const logger = createLogger("dispatcher-prompt");

export interface PromptAssemblerDeps {
  db: Database.Database;
  config: AgentConfig;
  getTaskFlow: GetTaskFlow;
  /** Live reference to the dispatcher's in-flight turn-token map. */
  activeTurnTokens: Map<string, number>;
  /**
   * Accessor for the lazily-injected AttachmentStore. Returns null
   * before `EventDispatcher.setAttachmentStore` has been called or in
   * tests that don't wire the store.
   */
  getAttachmentStore: () => AttachmentStore | null;
  /**
   * Accessor for the lazily-injected VoiceTranscriber. Returns null
   * when the local-Whisper layer is not wired.
   */
  getVoiceTranscriber: () => VoiceTranscriber | null;
}

export class PromptAssembler {
  private readonly db: Database.Database;
  private readonly config: AgentConfig;
  private readonly getTaskFlow: GetTaskFlow;
  private readonly activeTurnTokens: Map<string, number>;
  private readonly getAttachmentStore: () => AttachmentStore | null;
  private readonly getVoiceTranscriber: () => VoiceTranscriber | null;

  constructor(deps: PromptAssemblerDeps) {
    this.db = deps.db;
    this.config = deps.config;
    this.getTaskFlow = deps.getTaskFlow;
    this.activeTurnTokens = deps.activeTurnTokens;
    this.getAttachmentStore = deps.getAttachmentStore;
    this.getVoiceTranscriber = deps.getVoiceTranscriber;
  }

  /**
   * B-007 §5.8 — compose the final prompt by loading the task-flow
   * template and appending the vault policy-files block (rules/*.md,
   * routines/<cadence>.md, custom routine file, etc.). Centralised
   * here so every dispatch path sees the same policy bundle.
   */
  assemble(
    eventType: string,
    processKey: string,
    backendId?: string,
    flags?: Record<string, unknown>,
    playbooks?: readonly string[],
  ): string {
    const integrations = readIntegrations(this.db);
    const base = this.getTaskFlow(eventType, backendId, integrations);
    const contextDir = this.getPromptPolicyContextDir();
    if (!contextDir) {
      return base;
    }
    // B-003 Phase 3 — the `policies/mcp.md` PolicyFileRef is registered with
    // `injectIf: ctx.flags?.mcpEnabled === true`. Compute the flag here so
    // every dispatch path (DM, routine, scheduled task, fallback reassembly)
    // injects the policy without each call site having to remember it.
    const mergedFlags: Record<string, unknown> = {
      ...(flags ?? {}),
      mcpEnabled: anyMcpServerEnabled(this.db),
    };
    // Share a single budget across policy + review-context injection so the
    // aggregate cap (POLICY_TOTAL_MAX_BYTES) covers both — avoids the
    // double-accounting bug where each injector independently consumed the
    // full cap and inflated the effective prompt-injection ceiling to 2×.
    const budget = createPromptInjectionBudget();
    const withPolicies = appendPolicyBlocks(base, {
      contextDir,
      processKey,
      flags: mergedFlags,
      budget,
    });
    const withReview = appendReviewContextBlocks(withPolicies, {
      contextDir,
      processKey,
      flags: {
        useReviewDossiers: this.config.useReviewDossiers,
        useContextIndex: this.config.useContextIndex,
      },
      budget,
    });
    // AGENT_PROMPT_QUALITY_DESIGN.md Phase 2 — inject the firing Agent's declared
    // operating playbooks by content (the hard, platform-enforced guarantee).
    // `playbooks` is undefined/empty for every non-Agent firing and for Agents
    // that declare none, so the common path is unchanged. Reads from the
    // daemon bundle (agent-assets), not the vault, sharing the same budget.
    if (!playbooks || playbooks.length === 0) {
      return withReview;
    }
    // Playbooks get their OWN budget (audit B6), NOT the shared policy+review
    // one — otherwise a heavy policy/review bundle could exhaust the 128 KiB cap
    // and silently drop a declared playbook, contradicting the documented "hard,
    // platform-enforced guarantee." A dedicated 16 KiB budget makes it real.
    const playbookBudget = createPromptInjectionBudget(PLAYBOOK_TOTAL_MAX_BYTES);
    return appendPlaybookBlocks(withReview, {
      workspaceDir: this.config.workspaceDir,
      playbooks,
      budget: playbookBudget,
    });
  }

  /**
   * Policy-file prompt assembly must not fall back to `<dataDir>/context`
   * while degraded. Reactive sessions still run so the user can repair the
   * vault, but the prompt must not silently inject stale rulebooks from a
   * legacy location.
   */
  private getPromptPolicyContextDir(): string | null {
    if (readDegradedMode(this.db)) {
      return null;
    }
    return getContextDir(this.config);
  }

  /** Internal — issue a turn token bound to a session. Cleared by
   *  `releaseAttachmentTurnToken` in a `finally`. */
  issueAttachmentTurnToken(sessionId: number): string {
    const token = randomUUID();
    this.activeTurnTokens.set(token, sessionId);
    return token;
  }

  releaseAttachmentTurnToken(token: string): void {
    this.activeTurnTokens.delete(token);
  }

  /**
   * Stage inbound attachments into `<sessionDir>/_attachments/` via
   * hard-link (or copy on EXDEV). Returns the rows that were actually
   * staged — callers feed these into the prompt-block builder.
   */
  stageInboundAttachments(
    event: MessageEvent,
    sessionDir: string | undefined,
  ): StoreAttachmentRow[] {
    const attachmentStore = this.getAttachmentStore();
    if (!attachmentStore || !sessionDir) return [];
    if (!event.attachments || event.attachments.length === 0) return [];
    const staged: StoreAttachmentRow[] = [];
    for (const ref of event.attachments) {
      // Skip adapter-marked missing refs — they have no underlying row
      // to stage, just metadata for the prompt builder.
      if (ref.missing) continue;
      const row = attachmentStore.get(ref.id);
      if (!row) continue;
      try {
        attachmentStore.stageIntoWorkdir({ row, sessionDir });
        staged.push(row);
      } catch (err) {
        logger.warn({ err, attachmentId: row.id }, "Failed to stage attachment");
      }
    }
    return staged;
  }

  /**
   * Run local-Whisper transcription on every audio attachment in `rows`.
   * Cached transcripts are returned without re-running inference. Returns
   * an empty map when the transcriber is unset, when no rows are audio,
   * or when every transcription failed — callers always render the path
   * even if the transcript is missing.
   */
  async transcribeAttachments(
    rows: StoreAttachmentRow[],
  ): Promise<Map<string, VoiceTranscriptionResult>> {
    const transcripts = new Map<string, VoiceTranscriptionResult>();
    const voiceTranscriber = this.getVoiceTranscriber();
    if (!voiceTranscriber || rows.length === 0) return transcripts;
    for (const row of rows) {
      if (!voiceTranscriber.isAudio(row.mimeType)) continue;
      try {
        const result = await voiceTranscriber.transcribe({
          attachmentId: row.id,
          path: row.path,
          mimeType: row.mimeType,
        });
        if (result) transcripts.set(row.id, result);
      } catch (err) {
        logger.warn(
          { err, attachmentId: row.id },
          "voice transcription threw; falling back to path-only prompt",
        );
      }
    }
    return transcripts;
  }

  /**
   * Compose the "[Attached files]" prompt block that the dispatcher
   * appends to the task-flow body for turns with inbound attachments.
   * Kept on the assembler (not in prompts.ts) because the attachment
   * rows are local state for this turn only.
   */
  buildAttachmentPromptBlock(
    rows: StoreAttachmentRow[],
    transcripts?: Map<string, VoiceTranscriptionResult>,
    missing: ReadonlyArray<{ originalFilename: string; missingReason?: string }> = [],
  ): string {
    if (rows.length === 0 && missing.length === 0) return "";
    const lines: string[] = [
      "",
      "[Attached files]",
      "The user attached the following files for this turn. Paths are relative",
      "to your working directory. Use the appropriate local tool for each",
      "file type: images/PDFs may be readable directly, while audio/video",
      "are staged as files for inspection, transcription, or conversion when",
      "the active backend has suitable tools.",
    ];
    const voiceTranscriber = this.getVoiceTranscriber();
    const transcriberEnabled = voiceTranscriber?.isEnabled() ?? false;
    for (const row of rows) {
      const rel = `_attachments/${row.safeFilename}`;
      const size = `${Math.max(1, Math.round(row.sizeBytes / 1024))} KB`;
      const captionPart = row.caption ? ` — caption: ${JSON.stringify(row.caption)}` : "";
      lines.push(`- ${rel} (${row.mimeType}, ${size})${captionPart}`);
      if (row.sourceId) {
        // SOURCE_LIBRARY_DESIGN.md — document-class inbound attachments are
        // auto-captured at ingest; tell the agent the durable id so it can
        // file the source immediately when the user gives instructions.
        lines.push(
          `  Saved to the source library as ${row.sourceId} (status: unfiled).`,
          "  If the user says where it belongs, file it now with the `sources`",
          "  skill; otherwise leave it for the weekly librarian pass.",
        );
      }
      const transcript = transcripts?.get(row.id);
      if (transcript) {
        const langPart = transcript.language
          ? ` (lang=${transcript.language})`
          : "";
        const durationPart =
          transcript.durationSec !== null
            ? `, ${transcript.durationSec.toFixed(1)}s`
            : "";
        lines.push(
          `  Voice transcript${langPart}${durationPart}: ${JSON.stringify(transcript.transcript)}`,
        );
      } else if (
        transcriberEnabled &&
        voiceTranscriber?.isAudio(row.mimeType)
      ) {
        // Audio attachment but no transcript was produced. Could be too long,
        // a decoder/inference failure, or a model still warming up. Surface a
        // marker so the agent can ask the user to retype rather than silently
        // pretending the audio was readable.
        lines.push(
          "  (voice transcript unavailable — audio may be too long, untranscribable, or the local model is unavailable)",
        );
      }
    }
    if (missing.length > 0) {
      // Adapter-reported attachments that couldn't be ingested
      // (e.g. Discord CDN URL expired on a stale message). The agent
      // can't see the bytes but should still acknowledge them and ask
      // the user to resend rather than pretending nothing was attached.
      lines.push("", "[Attached files that could not be fetched]");
      for (const ref of missing) {
        const reasonPart = ref.missingReason ? ` — ${ref.missingReason}` : "";
        lines.push(`- ${ref.originalFilename}${reasonPart}`);
      }
      lines.push(
        "Acknowledge these to the user and ask them to resend if the content",
        "matters for your reply. Do not pretend the bytes were available.",
      );
    }
    lines.push(
      "",
      "If your reply should include a generated file (md/PDF/CSV/image/etc.),",
      "deliver it via the `attach` skill — write the bytes to a temp path, then",
      "POST /api/chat/outbound-attachments with `X-Turn-Token: $PA_TURN_TOKEN`.",
      "`_attachments/` is the read-only inbound staging area, not an output",
      "location. Never write a filesystem path into your reply and claim you",
      "created a file unless you actually uploaded it through that endpoint.",
    );
    return lines.join("\n");
  }
}
