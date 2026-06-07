/**
 * `MessageHandler` — owns the dispatcher's reactive message-event path:
 * the bang-command interceptor, the cross-platform setup lockout, the
 * `/auth` command surface (`handleAuthCommand`), the resume-vs-fresh-
 * execute decision, the user/assistant message persistence, and the
 * STAGE-C DM freshness telemetry (`collectDmFreshnessTelemetry`).
 *
 * Extracted from `core/dispatcher.ts` as part of phase D-3 of
 * `docs/design/appendices/file-split-plan.md`. Pattern B (stateful
 * coordinator): the handler owns its own logic but borrows live
 * accessors back into the dispatcher for state that is either lazily
 * injected after the dispatcher is constructed (dashboard stream,
 * attachment store, signal detector, docs-QA lookup, auth recovery /
 * health monitor, bang-command registry) or that the dispatcher
 * continues to own as a process-wide flag (`currentSetupMode`).
 *
 * Dispatcher entry points served:
 *   - `dispatch.handleMessage` (every owner DM / channel mention /
 *     dashboard chat / docs_qa turn) routes through `handle`;
 *   - `dispatcher.test.ts` reaches `handleAuthCommand` directly through
 *     a private-access cast — preserved as a shim on the dispatcher
 *     that forwards to this handler.
 *
 * Shared-state references held (live, not by-value):
 *   - `currentSetupMode` getter + `beginSetupMode` setter — the
 *     dispatcher owns the persisted-to-runtime_state flag; the handler
 *     reads the current value and triggers the same setter the
 *     dashboard wizard uses.
 *   - Lazy accessors (`getSignalDetector`, `getDashboardStream`,
 *     `getAttachmentStore`, `getDocsCitationLookup`,
 *     `getAuthRecovery`, `getAuthHealthMonitor`,
 *     `getBangCommandRegistry`) — each is null until `index.ts` finishes
 *     wiring; reading through the closure ensures the handler sees the
 *     current value on every call.
 *   - Method delegates (`lookupCustomBangCommandForEvent`,
 *     `getConfiguredServices`, `getActiveMailAccounts`,
 *     `readLastInsertedMessageId`) — these remain on the dispatcher
 *     for now; the handler invokes them via callbacks so the move
 *     stays a verbatim relocation.
 *
 * No behavior change. See §7 D-3 of file-split-plan.md for the staged
 * "move now, refine later" plan.
 */

import type Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentResult,
  BackendId,
  MessageEvent,
  ProcessKey,
} from "@aitne/shared";
import {
  formatSqliteDatetime,
  isDocsQAMessage,
  isMessageEvent,
  parseSqliteUtcMs,
  resolveProcessKey,
} from "@aitne/shared";

import { getContextDir, type AgentConfig } from "../config.js";
import { resolveUserSkillsRoot } from "./user-skills-root.js";
import type { StreamCallbacks } from "./agent-core.js";
import type { IAgentRouter } from "./backends/backend-router.js";
import { getModelLabel } from "./backends/model-registry.js";
import { parseGeminiAuthCode } from "./backends/auth-recovery.js";
import { tryHandle as tryHandleBangCommand } from "./bang-commands/registry.js";
import { AgentWriteTracker } from "../safety/agent-write-tracker.js";
import {
  CUSTOM_BANG_COMMAND_SOURCE,
  createUserBangCommandEvent,
  resolveCommandSkillSlugs,
  type UserBangCommand,
} from "./bang-commands/user-commands.js";
import {
  logInvalidCitations,
  validateAndRewrite,
} from "./docs/citation-validator.js";
import type { DocsCitationLookup } from "./docs/citation-validator.js";
import {
  countContextWritesInWindow,
  didRefetchTodayDuringTurn,
  matchesRecentActivityTrigger,
} from "./dm-freshness-metrics.js";
import type { DelegatedSignoutWarning } from "./delegated-connector-health.js";
import {
  ensureSessionWorkdir,
  getSessionWorkdirPath,
  syncAllUserSkills,
} from "./workdir.js";
import { upsertOwnerChannel } from "../messaging/owner-channels.js";
import { readIntegrations } from "../db/integrations-store.js";
import { EventBus } from "./event-bus.js";
import type {
  IAuditLogger,
  IContextBuilder,
  IDashboardStream,
  IMessageRecorder,
  INotificationManager,
  ISessionManager,
  SetupMode,
} from "./dispatcher-types.js";
import type { PromptAssembler } from "./dispatcher-prompt.js";
import type { DispatcherErrorRouter } from "./dispatcher-error-handling.js";
import type { ResultProcessor } from "./dispatcher-result-processor.js";
import type { SignalDetector } from "./signal-detector.js";
import type { AttachmentStore } from "../services/attachments/store.js";
import type { MailAccount } from "../services/mail/provider.js";
import { createLogger } from "../logging.js";

const logger = createLogger("dispatcher-message");

export interface MessageHandlerDeps {
  db: Database.Database;
  config: AgentConfig;
  eventBus: EventBus;
  agentRouter: IAgentRouter;
  contextBuilder: IContextBuilder;
  notificationMgr: INotificationManager;
  sessionMgr: ISessionManager;
  messageRecorder: IMessageRecorder;
  audit: IAuditLogger;
  prompt: PromptAssembler;
  errorRouter: DispatcherErrorRouter;
  resultProcessor: ResultProcessor;
  /**
   * Optional commit-attribution tracker (C1). Production always supplies
   * one via `Dispatcher`; tests may omit it. When omitted, the
   * bang-command path uses a fresh per-call tracker so the contract on
   * `BangCommandContext.writeTracker` (mandatory) stays satisfied
   * without forcing every existing test fixture to construct one.
   */
  writeTracker?: AgentWriteTracker;

  /** Lazily-injected SignalDetector accessor (null in tests + when unwired). */
  getSignalDetector: () => SignalDetector | null;
  /** Lazily-injected dashboard stream accessor (null until index.ts wires it). */
  getDashboardStream: () => IDashboardStream | null;
  /** Lazily-injected AttachmentStore accessor (null in tests + when unwired). */
  getAttachmentStore: () => AttachmentStore | null;
  /** Lazily-injected docs-QA citation lookup accessor. */
  getDocsCitationLookup: () => DocsCitationLookup | null;
  /** Lazily-injected auth recovery accessor — Phase 5 `/auth fix …` intercept. */
  getAuthRecovery: () =>
    | import("./backends/auth-recovery.js").AuthRecovery
    | null;
  /** Lazily-injected auth health monitor accessor — `/auth status` summary. */
  getAuthHealthMonitor: () =>
    | import("./backends/auth-health-monitor.js").AuthHealthMonitor
    | null;
  /** Lazily-injected bang-command registry accessor. */
  getBangCommandRegistry: () =>
    | import("./bang-commands/registry.js").BangCommandRegistry
    | null;
  /** Lazily-injected B-4 purchase-handler accessor. Null in tests and
   *  before B-4 is wired at startup. Used by the inbound classifier at
   *  the top of `handle()` to short-circuit `!~xxxxxxxx`,
   *  `!verify <tail>`, and `!cancel-purchase` inputs BEFORE the LLM
   *  (or the bang-command registry) sees them — see
   *  MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §17.4 / §17.7. */
  getPurchaseHandler?: () =>
    | import("../services/browser-history/automation/purchase-handler.js").PurchaseHandler
    | null;
  /**
   * BROWSER_TASK_REDESIGN_PLAN.md §5 / §14.11 (Q#6 MVP blocker) — lazily-
   * injected lite-final-confirm handler accessor. Null in tests and
   * before the browser-task surface is wired at startup. Used by the
   * inbound `!~xxxxxxxx` classifier alongside `getPurchaseHandler`: the
   * adapter routes a reply by querying BOTH stores via `lookupByRaw`
   * and dispatching to whichever returned a row. The strict-cancel-on-
   * non-token-reply contract is replicated symmetrically across both
   * surfaces so a single non-token reply cancels pending tokens of
   * either kind on the affected channel.
   */
  getFinalConfirmHandler?: () =>
    | import("../services/browser-history/automation/final-confirm-handler.js").FinalConfirmHandler
    | null;

  /** Live getter for the dispatcher's `currentSetupMode` flag. */
  getCurrentSetupMode: () => SetupMode | null;
  /** Forward into the dispatcher's `beginSetupMode` so persistence stays
   *  centralised. */
  beginSetupMode: (mode: SetupMode) => void;

  /** Look up the `UserBangCommand` row that produced this event, if any. */
  lookupCustomBangCommandForEvent: (
    event: MessageEvent,
  ) => UserBangCommand | null;
  /** Snapshot of configured services for the session workdir materializer. */
  getConfiguredServices: () => ReadonlySet<string>;
  /** Snapshot of active mail accounts for the session workdir materializer. */
  getActiveMailAccounts: () => readonly MailAccount[];
  /** Resolve the `messages.id` that was just inserted on this connection. */
  readLastInsertedMessageId: (sessionId: number) => number | null;
}

export class MessageHandler {
  private readonly db: Database.Database;
  private readonly config: AgentConfig;
  private readonly eventBus: EventBus;
  private readonly agentRouter: IAgentRouter;
  private readonly contextBuilder: IContextBuilder;
  private readonly notificationMgr: INotificationManager;
  private readonly sessionMgr: ISessionManager;
  private readonly messageRecorder: IMessageRecorder;
  private readonly audit: IAuditLogger;
  private readonly prompt: PromptAssembler;
  private readonly errorRouter: DispatcherErrorRouter;
  private readonly resultProcessor: ResultProcessor;
  private readonly writeTracker: AgentWriteTracker;
  private readonly getSignalDetector: () => SignalDetector | null;
  private readonly getDashboardStream: () => IDashboardStream | null;
  private readonly getAttachmentStore: () => AttachmentStore | null;
  private readonly getDocsCitationLookup: () => DocsCitationLookup | null;
  private readonly getAuthRecovery: () =>
    | import("./backends/auth-recovery.js").AuthRecovery
    | null;
  private readonly getAuthHealthMonitor: () =>
    | import("./backends/auth-health-monitor.js").AuthHealthMonitor
    | null;
  private readonly getBangCommandRegistry: () =>
    | import("./bang-commands/registry.js").BangCommandRegistry
    | null;
  private readonly getPurchaseHandler: () =>
    | import("../services/browser-history/automation/purchase-handler.js").PurchaseHandler
    | null;
  private readonly getFinalConfirmHandler: () =>
    | import("../services/browser-history/automation/final-confirm-handler.js").FinalConfirmHandler
    | null;
  private readonly getCurrentSetupMode: () => SetupMode | null;
  private readonly beginSetupMode: (mode: SetupMode) => void;
  private readonly lookupCustomBangCommandForEvent: (
    event: MessageEvent,
  ) => UserBangCommand | null;
  private readonly getConfiguredServices: () => ReadonlySet<string>;
  private readonly getActiveMailAccounts: () => readonly MailAccount[];
  private readonly readLastInsertedMessageId: (
    sessionId: number,
  ) => number | null;

  constructor(deps: MessageHandlerDeps) {
    this.db = deps.db;
    this.config = deps.config;
    this.eventBus = deps.eventBus;
    this.agentRouter = deps.agentRouter;
    this.contextBuilder = deps.contextBuilder;
    this.notificationMgr = deps.notificationMgr;
    this.sessionMgr = deps.sessionMgr;
    this.messageRecorder = deps.messageRecorder;
    this.audit = deps.audit;
    this.prompt = deps.prompt;
    this.errorRouter = deps.errorRouter;
    this.resultProcessor = deps.resultProcessor;
    // Tests can omit `writeTracker`; production always supplies one via
    // Dispatcher. The fallback ensures `BangCommandContext.writeTracker`
    // (mandatory) is always populated when bang commands run. A
    // per-handler tracker is fine — `markAgentCommit` only matters when
    // the dispatcher path forwards it on to `runGitPreCompile`.
    this.writeTracker = deps.writeTracker ?? new AgentWriteTracker();
    this.getSignalDetector = deps.getSignalDetector;
    this.getDashboardStream = deps.getDashboardStream;
    this.getAttachmentStore = deps.getAttachmentStore;
    this.getDocsCitationLookup = deps.getDocsCitationLookup;
    this.getAuthRecovery = deps.getAuthRecovery;
    this.getAuthHealthMonitor = deps.getAuthHealthMonitor;
    this.getBangCommandRegistry = deps.getBangCommandRegistry;
    this.getPurchaseHandler = deps.getPurchaseHandler ?? ((): null => null);
    this.getFinalConfirmHandler =
      deps.getFinalConfirmHandler ?? ((): null => null);
    this.getCurrentSetupMode = deps.getCurrentSetupMode;
    this.beginSetupMode = deps.beginSetupMode;
    this.lookupCustomBangCommandForEvent = deps.lookupCustomBangCommandForEvent;
    this.getConfiguredServices = deps.getConfiguredServices;
    this.getActiveMailAccounts = deps.getActiveMailAccounts;
    this.readLastInsertedMessageId = deps.readLastInsertedMessageId;
  }

  /**
   * Phase 5 — intercept owner `/auth …` DMs before they reach the agent
   * backend. Returns `true` when the DM was handled (caller must short-
   * circuit), `false` to fall through to normal message processing.
   *
   * Verbatim move from `dispatcher.ts:handleAuthCommand` — no semantic
   * change. See file-split-plan.md §7 D-3.
   */
  async handleAuthCommand(event: MessageEvent): Promise<boolean> {
    const authRecovery = this.getAuthRecovery();
    const authHealthMonitor = this.getAuthHealthMonitor();
    const text = event.content.trim().toLowerCase();

    // `/auth status` — show current auth state
    if (text === "/auth status") {
      const summary = authHealthMonitor
        ? authHealthMonitor.renderStatusSummary()
        : "Check auth status on the dashboard or via `GET /api/backends`.";
      await this.notificationMgr.send(summary, event);
      return true;
    }

    // `/auth fix claude` — start Claude browser auth recovery (Phase 9)
    if (text === "/auth fix claude") {
      if (!authRecovery) return false;
      if (authRecovery.isRecoveryActive("claude")) {
        const active = authRecovery.getActiveRecovery("claude");
        await this.notificationMgr.send(
          `Claude auth recovery already in progress.\n` +
          `URL: ${active?.authUrl}`,
          event,
        );
        return true;
      }
      try {
        const recovery = await authRecovery.initiateClaudeAuth();
        await this.notificationMgr.send(
          `Claude auth recovery started.\n` +
          `Open the following URL in your browser to sign in:\n${recovery.authUrl}` +
          `\n(timeout in ${recovery.expiresMinutes} min)`,
          event,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        await this.notificationMgr.send(
          `Failed to start Claude auth recovery: ${msg}`,
          event,
        );
      }
      return true;
    }

    // `/auth fix codex` — start Codex device auth recovery
    if (text === "/auth fix codex") {
      if (!authRecovery) return false;
      if (authRecovery.isRecoveryActive("codex")) {
        const active = authRecovery.getActiveRecovery("codex");
        await this.notificationMgr.send(
          `Codex auth recovery already in progress.\n` +
          `URL: ${active?.authUrl}\nCode: ${active?.userCode}`,
          event,
        );
        return true;
      }
      try {
        const recovery = await authRecovery.initiateCodexDeviceAuth();
        // The recovery itself sends a notification with URL/code,
        // but also reply directly to the DM for immediate feedback.
        await this.notificationMgr.send(
          `Codex auth recovery started.\n` +
          `Open ${recovery.authUrl} in your browser and enter code ${recovery.userCode}.` +
          `\n(expires in ${recovery.expiresMinutes} min)`,
          event,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        await this.notificationMgr.send(
          `Failed to start Codex auth recovery: ${msg}`,
          event,
        );
      }
      return true;
    }

    // `/auth fix all` — recover all expired backends sequentially
    if (text === "/auth fix all") {
      if (!authRecovery || !authHealthMonitor) return false;
      const expired = authHealthMonitor.listExpiredBackends();
      if (expired.length === 0) {
        await this.notificationMgr.send(
          "All backends are healthy. No recovery needed.",
          event,
        );
        return true;
      }

      const results: string[] = [];
      for (const bid of expired) {
        // Skip backends that already have an active recovery session
        if (authRecovery.isRecoveryActive(bid)) {
          results.push(`🔄 ${bid} — Recovery already in progress.`);
          continue;
        }
        try {
          if (bid === "claude") {
            const recovery = await authRecovery.initiateClaudeAuth();
            results.push(
              `✅ claude — Recovery started. Open the following URL in your browser to sign in:\n${recovery.authUrl}\n(timeout in ${recovery.expiresMinutes} min)`,
            );
          } else if (bid === "codex") {
            const recovery = await authRecovery.initiateCodexDeviceAuth();
            results.push(
              `✅ codex — Recovery started. Open ${recovery.authUrl} in your browser and enter code ${recovery.userCode} (expires in ${recovery.expiresMinutes} min).`,
            );
          } else if (bid === "gemini") {
            const recovery = await authRecovery.initiateGeminiAuth();
            results.push(
              `✅ gemini — Recovery started. Open the following URL in your browser and authenticate, then send the code here:\n${recovery.authUrl}\n(expires in ${recovery.expiresMinutes} min)`,
            );
          } else if (bid === "opencode") {
            // OpenCode auth is per-provider via the `opencode auth login`
            // CLI and cannot be driven headlessly by the daemon. Surface
            // the manual command so the operator can copy-paste it; the
            // health monitor will pick the success up on its next probe.
            results.push(
              `⚠️ opencode — Manual recovery required. Run \`opencode auth login\` in a terminal to refresh provider credentials, then run \`/auth status\` to re-check.`,
            );
          } else {
            results.push(`⚠️ ${bid} — No automated recovery available for this backend.`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown error";
          results.push(`❌ ${bid} — Failed to start recovery: ${msg}`);
        }
      }

      const summary = authHealthMonitor.renderStatusSummary();
      await this.notificationMgr.send(
        `Auth recovery results:\n\n${results.join("\n\n")}\n\n---\n${summary}`,
        event,
      );
      return true;
    }

    // `/auth fix gemini` — start Gemini OAuth recovery
    if (text === "/auth fix gemini") {
      if (!authRecovery) return false;
      if (authRecovery.isRecoveryActive("gemini")) {
        const active = authRecovery.getActiveRecovery("gemini");
        await this.notificationMgr.send(
          `Gemini auth recovery already in progress.\n` +
          `Open the following URL in your browser to authenticate:\n${active?.authUrl}\n` +
          `Then send the authorization code here.`,
          event,
        );
        return true;
      }
      try {
        const recovery = await authRecovery.initiateGeminiAuth();
        await this.notificationMgr.send(
          `Gemini auth recovery started.\n` +
          `Open the following URL in your browser and sign in with your Google account:\n${recovery.authUrl}\n` +
          `Then send the authorization code here.` +
          `\n(expires in ${recovery.expiresMinutes} min)`,
          event,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        await this.notificationMgr.send(
          `Failed to start Gemini auth recovery: ${msg}`,
          event,
        );
      }
      return true;
    }

    // `/auth fix opencode` — surface manual recovery instructions.
    // OpenCode authenticates per-provider via `opencode auth login` and the
    // daemon can't drive that headlessly (it's interactive + non-OAuth),
    // so we return the canonical CLI command instead of pretending to
    // start a session. The health monitor will pick up the new state on
    // its next probe; the operator can re-run `/auth status` to confirm.
    if (text === "/auth fix opencode") {
      await this.notificationMgr.send(
        `OpenCode recovery is manual.\n` +
        `Run \`opencode auth login\` in a terminal to refresh provider credentials, ` +
        `then send \`/auth status\` here to re-check.`,
        event,
      );
      return true;
    }

    // `/auth cancel` — cancel active recovery
    if (text === "/auth cancel" || text.startsWith("/auth cancel ")) {
      if (!authRecovery) return false;
      const parts = text.split(/\s+/);
      const backendHint = parts[2] as BackendId | undefined;
      // Cancel all active recoveries, or a specific one. OpenCode is
      // included for symmetry even though it has no daemon-driven session
      // to cancel — `cancelRecovery` returns false there, which is fine.
      let cancelled = false;
      for (const bid of ["codex", "gemini", "claude", "opencode"] as const) {
        if (backendHint && bid !== backendHint) continue;
        if (authRecovery.cancelRecovery(bid)) cancelled = true;
      }
      await this.notificationMgr.send(
        cancelled ? "Auth recovery cancelled." : "No active auth recovery to cancel.",
        event,
      );
      return true;
    }

    // Not an auth command
    return false;
  }

  /**
   * Process a reactive message event end-to-end: bang commands, setup
   * lockout, `/auth` interception, session resume/fresh-execute, message
   * persistence, attachment plumbing, dashboard streaming, and the §4.5
   * delegated-connector health DM.
   *
   * Verbatim move from `dispatcher.ts:handleMessage`. The dispatcher
   * keeps a thin `handleMessage` shim that forwards here so private-
   * access test casts continue to work.
   */
  async handle(event: MessageEvent): Promise<void> {
    // MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §17.4 / §17.7 — Phase B-4
    // structural-anti-spoofing inbound classifier. Runs BEFORE the
    // bang-command interceptor (and BEFORE any inbound recording on
    // `conversation_sessions.messages`) so a `!~xxxxxxxx` token reply,
    // `!verify <tail>` slash, or `!cancel-purchase` slash NEVER reaches
    // the LLM's conversation log. The plan §17.7 invariant — "the agent
    // must not see used tokens in its conversation log" — is enforced
    // structurally here: matched inbounds short-circuit `handle()`
    // entirely after the purchase-handler records the audit row on
    // `_replies` and emits the consume / verify / cancel follow-up DM.
    //
    // Pre-conditions:
    //   - event.isDm — non-DM channels never carry tokens (§17.3 / §17.4)
    //   - getPurchaseHandler() is non-null (false in tests; B-4 wired
    //     at startup binds it)
    //
    // The classifier is pure (`classifyAdapterInbound`); the handler
    // dispatch is async I/O (DB + outbound DM follow-up). On any
    // exception the classifier falls through to normal processing —
    // failing closed on the B-4 path could deadlock a legitimate user
    // who happens to type a `!~`-shaped message that fails some
    // downstream DB check, so we log + skip on error.
    if (event.isDm) {
      const purchaseHandler = this.getPurchaseHandler();
      const finalConfirmHandler = this.getFinalConfirmHandler();
      // BROWSER_TASK_REDESIGN_PLAN.md §14.11 Q#6 — jti-prefix dispatch.
      // The `!~xxxxxxxx` envelope is shared between B-4 purchase tokens
      // and lite-final-confirm tokens. A pending token of EITHER kind
      // must consume the reply (and a non-token reply must strict-
      // cancel pending tokens of EITHER kind on the channel). The
      // route in code:
      //
      //   1. classifyAdapterInbound is purchase-specific by name but
      //      the `kind === "token_reply"` case carries only the parsed
      //      `!~xxxxxxxx` string — that envelope is identical across
      //      both surfaces (see `lite-final-confirm-tokens.parseLite…`).
      //      Reusing the classifier keeps the shape-validation logic
      //      in one place.
      //   2. For `verify` / `cancel_purchase` — purchase-only slashes,
      //      no lite equivalent — route to the purchase handler when
      //      wired.
      //   3. For `token_reply` — query BOTH stores via `lookupByRaw`.
      //      Both jtis are uuid v4 so a colliding match is bounded by
      //      uuid uniqueness. If both stores miraculously return a row,
      //      we route to whichever was issued first (oldest issuedAt
      //      wins) so the older surface deterministically resolves.
      //      Whichever store consumed the row writes the audit + DM
      //      via its own handler.
      //   4. For `passthrough` — fan strict-cancel-on-non-token-reply
      //      to BOTH handlers when wired. Each only cancels pending
      //      rows it knows about on that channel; together they
      //      preserve the rev3 strict-cancel contract symmetrically.
      if (purchaseHandler || finalConfirmHandler) {
        try {
          const { classifyAdapterInbound } = await import(
            "../services/browser-history/automation/purchase-tokens.js"
          );
          const decision = classifyAdapterInbound(event.content);
          const channelRef = `${event.platform}:${event.channel}`;
          if (decision.kind === "token_reply") {
            const purchaseRow = purchaseHandler?.lookupByRaw(decision.token)
              ?? null;
            const liteRow = finalConfirmHandler?.lookupByRaw(decision.token)
              ?? null;
            const { decideTokenReplyRoute } = await import(
              "./dm-token-router.js"
            );
            const route = decideTokenReplyRoute({ purchaseRow, liteRow });
            if (route.kind === "purchase" && purchaseHandler) {
              await purchaseHandler.handleTokenReply({
                body: event.content,
                channelRef,
              });
              return;
            }
            if (route.kind === "lite_final_confirm" && finalConfirmHandler) {
              await finalConfirmHandler.handleTokenReply({
                body: event.content,
                channelRef,
              });
              return;
            }
            // route.kind === "none" — neither store recognised the
            // token. Fall through to the strict-cancel block below so
            // the user's reply still reaches the LLM and any pending
            // tokens on the channel get cancelled.
          } else if (decision.kind === "verify") {
            if (purchaseHandler) {
              await purchaseHandler.handleVerifySlash({
                tail: decision.tail,
                channelRef,
              });
            }
            // Purchase-only slash: short-circuit even when purchaseHandler
            // is unwired so it never enters the lite strict-cancel fan-out
            // below (verify/cancel have no lite equivalent — §12 Q#6).
            return;
          } else if (decision.kind === "cancel_purchase") {
            if (purchaseHandler) {
              await purchaseHandler.handleCancelPurchaseSlash({ channelRef });
            }
            // Purchase-only slash: short-circuit even when purchaseHandler
            // is unwired so it never enters the lite strict-cancel fan-out
            // below (verify/cancel have no lite equivalent — §12 Q#6).
            return;
          }
          // decision.kind === "passthrough" (or token_reply with no
          // match): apply strict-cancel-on-non-token-reply to BOTH
          // handlers when wired. Each handler only cancels pending
          // rows on the channel it knows about, so a single non-token
          // reply cancels tokens of either kind without the two paths
          // double-counting. The agent never sees the token surfaces
          // by design (§17.7).
          if (purchaseHandler) {
            await purchaseHandler
              .cancelPendingOnNonTokenReply({ channelRef })
              .catch((err) => {
                logger.warn(
                  { err, channelRef },
                  "B-4 strict-cancel on non-token reply raised (continuing)",
                );
              });
          }
          if (finalConfirmHandler) {
            await finalConfirmHandler
              .cancelPendingOnNonTokenReply({ channelRef })
              .catch((err) => {
                logger.warn(
                  { err, channelRef },
                  "lite-final-confirm strict-cancel on non-token reply raised (continuing)",
                );
              });
          }
        } catch (err) {
          logger.warn(
            { err, correlationId: event.correlationId, platform: event.platform },
            "DM-token inbound classifier raised — falling through to normal dispatch",
          );
        }
      }
    }

    // Bang-command interceptor — runs first so `!stop` / `!cost` / `!report`
    // succeed even mid-setup, mid-auth-recovery, etc., and so non-bang DMs
    // received while the agent is paused short-circuit before reaching the
    // backend. See docs/design/backlog/messaging-bang-commands.md §6.2.
    const bangCommandRegistry = this.getBangCommandRegistry();
    if (bangCommandRegistry) {
      const handled = await tryHandleBangCommand(bangCommandRegistry, {
        event,
        db: this.db,
        config: this.config,
        audit: this.audit,
        writeTracker: this.writeTracker,
        rawSend: (text) => this.notificationMgr.send(text, event),
        // Wired callback used by `!close`. Kept here (rather than handing
        // sessionMgr/messageRecorder into BangCommandContext) so the
        // bang-command surface stays narrow: handlers only see the
        // collaborators they actually need, and unit tests can inject a
        // single-line stub.
        closeActiveDmSession: async () => {
          const existing = await this.sessionMgr.findActive({
            platform: event.platform,
            channel: event.channel,
            threadId: event.threadId,
            isDm: event.isDm,
            intent: event.intent,
          });
          if (!existing) return { closedId: null };
          // recordMessage persists the row and touches
          // last_message_at/message_count in a single transaction, so
          // retention + dashboard sidebar stay consistent with the
          // actual `messages` row count. closeSession then flips status.
          // Mirrors the verbatim sequence the pre-bang close-keyword
          // gate used (extracted, not changed, so the close audit trail
          // looks identical in `agent_actions`).
          this.messageRecorder.recordMessage({
            sessionId: existing.id,
            role: "user",
            content: event.content,
            platform: event.platform,
            senderId: event.sender,
          });
          this.sessionMgr.closeSession(existing.id);
          return { closedId: existing.id };
        },
        enqueueUserBangCommand: async (command, sourceEvent) => {
          await this.eventBus.put(createUserBangCommandEvent(sourceEvent, command));
        },
        enqueueWikiEvent: async (wikiEvent) => {
          await this.eventBus.put(wikiEvent);
        },
        enqueueBrowserResearchEvent: async (researchEvent) => {
          await this.eventBus.put(researchEvent);
        },
        enqueueWikiApproval: async (approvalInput) => {
          // WIKI_BUILDER_DESIGN.md §5.5 / §P2.E — escalate to Approve tier
          // via the existing agent_schedule approval queue. The dashboard
          // `/approvals` endpoint (dashboard.ts) is the consumer surface.
          const { enqueueWikiApproval } = await import("./wiki/approval-queue.js");
          enqueueWikiApproval(this.db, approvalInput);
        },
      });
      if (handled) return;
    }

    // Cross-platform DM lockout during setup.
    // The owner-DM scope is singular across platforms (Slack/Discord/Telegram/
    // WhatsApp/dashboard all share one conversation_sessions row). While a
    // dashboard setup conversation is in progress, a DM from any other
    // platform would otherwise be routed through the active `setup.initial`
    // / `setup.update` prompt — taking a Slack "ping" and feeding it to the
    // rules-generator agent. Reject non-dashboard DMs with a fixed message
    // so the user knows why we are stalling and where to finish setup.
    // Dashboard messages are exempt so the user can still progress setup.
    // Channel mentions (not DMs) are also exempt — they have their own
    // session scope and do not interact with the owner-DM row.
    //
    // `let` (not `const`): the defensive-sync branch below calls
    // `this.beginSetupMode(eventSetupMode)`, which mutates the dispatcher's
    // live `currentSetupMode`. The original `dispatcher.handleMessage` read
    // `this.currentSetupMode` afresh on every reference; the extraction
    // captures it into a local for readability but must keep that local
    // in sync with the live state so later checks (notably the §4.5
    // connector-warnings consult below) see the post-sync value, not the
    // pre-sync snapshot. Without the re-assignment, the warning consult
    // would fire during a defensive-sync setup turn — a regression vs.
    // the pre-D-3 behaviour.
    let currentSetupMode = this.getCurrentSetupMode();
    if (
      event.isDm &&
      event.platform !== "dashboard" &&
      currentSetupMode !== null
    ) {
      logger.info(
        { platform: event.platform, mode: currentSetupMode },
        "Non-dashboard DM rejected — setup in progress",
      );
      this.audit.logSkip(event, "setup_in_progress", "reactive");
      await this.notificationMgr.send(
        "Setup is in progress. Please complete setup on the dashboard first, then try again.",
        event,
      );
      return;
    }

    // Phase 6 §5.2: intercept Google OAuth auth codes during pending Gemini
    // recovery. Must come before `/auth` command check so the code isn't
    // treated as an unknown command or routed to the agent backend.
    const authRecovery = this.getAuthRecovery();
    if (event.isDm && authRecovery?.isRecoveryActive("gemini")) {
      const code = parseGeminiAuthCode(event.content);
      if (code) {
        try {
          const result = await authRecovery.handleGeminiAuthCode(code);
          const icon = result.ok ? "✅" : "❌";
          await this.notificationMgr.send(
            `${icon} Gemini auth: ${result.detail}`,
            event,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown error";
          await this.notificationMgr.send(
            `Failed to process Gemini auth code: ${msg}`,
            event,
          );
        }
        return;
      }
    }

    // Phase 5: intercept `/auth` commands before they reach the agent backend.
    // Gated on DM + at least one auth subsystem being available (/auth status
    // only needs the monitor; /auth fix needs the recovery manager).
    if (event.isDm && (authRecovery || this.getAuthHealthMonitor())) {
      const authResult = await this.handleAuthCommand(event);
      if (authResult) return;
    }

    // Session close is now an explicit bang command (`!close`) handled
    // by the registry interceptor above. The legacy bare-word matcher
    // (`end` / `close` / `done`) was removed in M1 because natural
    // English completion signals — most notably the lone word "done"
    // — were silently terminating active conversations with no
    // confirmation. The new surface keeps the same close semantics but
    // forces an explicit intent.

    const replyActivity = await this.notificationMgr.beginReplyActivity(event);
    let turnToken: string | null = null;
    // STAGE-C-DM-FRESHNESS-PLAN §Task 4 — capture the turn-start reference
    // BEFORE any context_write/context_read row could be written during
    // this turn. Used as the upper bound when counting writes the agent
    // missed pre-resume, and as the lower bound when detecting whether
    // the agent issued a refetch during the current turn.
    const turnStartedAtSqlite = formatSqliteDatetime(new Date());
    try {
      // Docs-QA traffic is a side-channel that must never participate in
      // setup state. Two invariants enforced here:
      //   1. A docs_qa event with a smuggled `data.setupMode` must NOT
      //      flip the dispatcher's global `currentSetupMode` — that would
      //      hijack subsequent owner DMs into the rules-generator agent.
      //   2. A docs_qa event arriving while `currentSetupMode` is already
      //      set (operator opens Docs QA in another tab during setup)
      //      must still resolve via `dashboard.docs_qa` so TIER_LOCKED
      //      fires and the QA workdir/skill set is materialized — not the
      //      setup processKey/light tier/setup skill set. Without this
      //      gate, the §11.2 promptKey fix would load the QA prompt while
      //      the binding/workdir came from setup, producing an incoherent
      //      "QA prompt + setup tools" execution.
      const eventSetupMode = event.data?.setupMode as SetupMode | undefined;
      const isDocsQA = isDocsQAMessage(event);
      if (eventSetupMode && currentSetupMode === null && !isDocsQA) {
        // Defensive sync — normally `/setup/start` has already called
        // beginSetupMode, but this keeps prompt selection consistent even if
        // a future caller bypasses the helper and only sets event.data.
        this.beginSetupMode(eventSetupMode);
        // Mirror the just-applied mutation into the local so the
        // §4.5 connector-warnings consult below observes the same
        // value the dispatcher's `this.currentSetupMode` now holds.
        currentSetupMode = eventSetupMode;
      }
      const setupMode: SetupMode | null = isDocsQA
        ? null
        : (eventSetupMode ?? currentSetupMode);
      const processKey =
        setupMode === "initial" || setupMode === "update"
          ? "setup"
          : resolveProcessKey(event);
      // Honor the dashboard chat model picker. MessageEvent.requestedModel
      // and the (requestedBackendId, requestedModelId) pair are only
      // populated by the dashboard adapter (see POST /chat/messages in
      // api/routes/sse.ts); other platforms never set them. Defense-in-depth:
      // even if a future adapter were to set them, we gate on platform here
      // so Slack/Telegram/Discord/WhatsApp can never force a specific model
      // through these fields. Setup mode also ignores them — setup runs on
      // the configured setup process key regardless of the user's pick.
      //
      // When both the explicit (backendId, modelId) pair and the legacy
      // requestedModel are set, the pair wins: it is the superset that
      // supports all backends and models, not just Claude sonnet/opus.
      const honorOverride =
        (event.platform === "dashboard" || event.source === CUSTOM_BANG_COMMAND_SOURCE)
        && !setupMode;
      const requestedTier =
        honorOverride && event.requestedModel
          ? event.requestedModel === "sonnet"
            ? ("medium" as const)
            : ("high" as const)
          : undefined;
      const overrideBackendId =
        honorOverride && event.requestedBackendId && event.requestedModelId
          ? event.requestedBackendId
          : undefined;
      const overrideModelId =
        honorOverride && event.requestedBackendId && event.requestedModelId
          ? event.requestedModelId
          : undefined;
      const route = this.agentRouter.resolveBinding(event, {
        processKey,
        ...(requestedTier ? { requestedTier } : {}),
        ...(overrideBackendId && overrideModelId
          ? { requestedBackendId: overrideBackendId, requestedModelId: overrideModelId }
          : {}),
      });

      const session = await this.sessionMgr.getOrCreate({
        platform: event.platform,
        channel: event.channel,
        threadId: event.threadId,
        isDm: event.isDm,
        intent: event.intent,
        requiredBackend: route.main.backendId,
        requiredModel: route.main.modelId,
      });
      const forwardContextAvailable =
        this.resultProcessor.hasRecentProactiveForwardContext(event, session.id);

      // Custom messaging bang command (`!commandname`): the owner's
      // saved row carries an opt-in skill set + an optional custom
      // profile body. We forward those to `ensureSessionWorkdir` as a
      // re-materialize override so the agent runs with the row's
      // configuration for THIS turn. The override forces re-write of
      // CLAUDE.md / AGENTS.md / GEMINI.md and the skill dirs even when
      // the workdir already exists (regular DMs share the same dir).
      // The next regular DM turn detects the bang stamp file written
      // by `ensureSessionWorkdir` and re-materializes back to manifest
      // defaults — keeping `!cmd` configurations from leaking into a
      // natural conversation that follows.
      const customBangCommand = this.lookupCustomBangCommandForEvent(event);
      const workdirOverride = customBangCommand
        ? {
            skillSlugs: [...resolveCommandSkillSlugs(customBangCommand)],
            profileBody: customBangCommand.instructionMd,
          }
        : undefined;

      // Skip the owner-channel pairing record for docs_qa: the QA panel
      // is not a messaging-app surface and would otherwise clutter
      // /connections/messaging with synthetic "dashboard" pairings.
      //
      // `pendingConnectorWarnings` is captured here so both the resume and
      // fresh-execute branches below can call the §4.5 DM dispatch via
      // `dispatchPendingConnectorHealth()` AFTER each branch's user-message
      // recordMessage — the dispatch's persist must follow the user message
      // in DB-timestamp order or the dashboard's chat_meta history reload
      // reorders the bubbles.
      let pendingConnectorWarnings: readonly DelegatedSignoutWarning[] = [];
      const dispatchPendingConnectorHealth = (): void => {
        if (pendingConnectorWarnings.length === 0) return;
        this.errorRouter.runDelegatedConnectorWarningDispatch(
          pendingConnectorWarnings,
          event,
          route.main.backendId,
          session.id,
        );
      };
      if (event.isDm && !isDocsQAMessage(event)) {
        upsertOwnerChannel(this.db, {
          platform: event.platform,
          senderId: event.sender,
          channelId: event.channel,
          metadata: { threadId: event.threadId },
          touchInbound: true,
        });
        // DELEGATED-MODE-V2-DESIGN.md §4.5 — at every DM dispatch, consult
        // the cached probe for delegated integrations whose effective
        // backend matches the session backend. If the cached probe shows
        // missing required capabilities (the wizard / a future periodic
        // re-probe wrote `present=false`), fire a one-shot DM warning the
        // owner that same-backend mode is non-functional. The helper
        // dedupes via `runtime_state` so resume-vs-fresh-execute do not
        // spam the user. Cheap, synchronous DB-only inspection — runs on
        // the hot path so the warning lands before the agent's reply.
        //
        // Skipped while the dispatcher is in setup mode: the wizard's
        // background `probeLive` call may have just landed a `present=false`
        // row for a connector the user is in the middle of authorising, and
        // a DM telling them to "Re-authorize from your … connector
        // settings, then re-run the integration probe from the dashboard"
        // is wrong-tense for the in-flight setup conversation. The §10
        // post-setup sign-out scenario the check exists for fires correctly
        // on the first DM after `clearSetupMode` runs.
        //
        // Two-phase: consult the cached probe NOW (synchronous DB read),
        // but defer the actual DM dispatch + dashboard messages-table
        // persist until both branches below have recorded the inbound user
        // message. Otherwise the warning's persist row carries a
        // CURRENT_TIMESTAMP that lands BEFORE the user-message row's, and
        // the dashboard's chat_meta history reload re-orders the bubbles
        // (warning above user) — a one-time UX flicker.
        pendingConnectorWarnings =
          currentSetupMode === null
            ? this.errorRouter.consultDelegatedConnectorWarnings(route.main.backendId)
            : [];
      }

      // `event.channel` is captured at the moment the user POSTed their
      // message. If the tab navigates away and reconnects, the SSE route
      // calls `rebindSessionChannel` to update `conversation_sessions.
      // channel_id` to the new UUID — but our closure here still holds
      // the old value. `resolveDashboardChannel` reads the live DB value
      // on every send so stream/meta/info/error events reach whichever
      // tab is currently connected for this session.
      const resolveDashboardChannel = (): string =>
        this.sessionMgr.getActiveChannelIdForSession(session.id) ?? event.channel;

      // Send resolved model info + DB session ID to dashboard so the
      // sidebar badge is accurate and the frontend can persist the session.
      const dashboardStream = this.getDashboardStream();
      if (event.platform === "dashboard" && dashboardStream?.sendSessionInfo) {
        dashboardStream.sendSessionInfo(resolveDashboardChannel(), {
          sessionId: session.id,
          model: route.main.modelId,
          backend: route.main.backendId,
          modelLabel: getModelLabel(route.main.backendId, route.main.modelId),
        });
      }

      // Feed user message to SignalDetector for implicit feedback
      // detection. Docs-QA messages are docs lookups, not feedback
      // signals, so they bypass the detector entirely.
      if (!isDocsQAMessage(event)) {
        const responseToNotificationId =
          typeof (event.data as { notificationDispatchId?: unknown }).notificationDispatchId === "string"
            ? (event.data as { notificationDispatchId: string }).notificationDispatchId
            : typeof (event.data as { notification_dispatch_id?: unknown }).notification_dispatch_id === "string"
              ? (event.data as { notification_dispatch_id: string }).notification_dispatch_id
              : undefined;
        this.getSignalDetector()?.onUserMessage({
          platform: event.platform,
          channel: event.channel,
          content: event.content,
          responseToNotificationId,
        });
      }

      // Create stream callbacks for dashboard events (real-time SSE text).
      // Each callback re-resolves the channel on invocation so a user
      // who navigates away and returns mid-execute still receives the
      // tail of the stream on their new tab.
      let didStream = false;
      const streamCb: StreamCallbacks | undefined =
        event.platform === "dashboard" && dashboardStream
          ? {
              onText: (text: string) => {
                didStream = true;
                dashboardStream.sendStreamChunk(resolveDashboardChannel(), text);
              },
              onEnd: () => {
                dashboardStream.sendStreamEnd(resolveDashboardChannel());
              },
            }
          : undefined;

      // Chat-attachments Phase 1 — issue a per-turn capability token the
      // agent's `attach` skill will present via `X-Turn-Token`. Valid only
      // while this turn is running; always cleared in the outer `finally`
      // below so leakage is bounded to the lifetime of the turn.
      const attachmentStore = this.getAttachmentStore();
      turnToken = attachmentStore
        ? this.prompt.issueAttachmentTurnToken(session.id)
        : null;

      // Can we resume an existing SDK session?
      // Resume whenever this conversation already has a stored SDK session.
      // Never resume on the FIRST message of a new setup — event.data.setupMode means
      // "start a new setup", not "continue an existing one".
      //
      // Also require the session's persistent workdir to exist on disk. If
      // it was removed out of band (manual cleanup, stale-workdir scanner
      // bug, disk failure), attempting to resume would land the SDK in a
      // freshly-created empty directory with no CLAUDE.md / AGENTS.md /
      // skills tree, producing confusing output. Fall back to the fresh-
      // execute branch, which re-materializes the workdir via
      // `ensureSessionWorkdir`.
      const isNewSetupStart = !!event.data?.setupMode;
      const existingSessionDirPresent =
        session.isActive
        && existsSync(getSessionWorkdirPath(this.config.dataDir, session.id));
      const canResume =
        session.isActive
        && session.sessionId
        && existingSessionDirPresent
        && !isNewSetupStart;
      if (session.isActive && session.sessionId && !existingSessionDirPresent) {
        logger.warn(
          { sessionId: session.id },
          "Session marked resumable but workdir missing — falling back to fresh execute",
        );
      }

      let result: AgentResult;
      let userMessageId: number | null = null;
      // STAGE-C-DM-FRESHNESS-PLAN §Task 2 — `<turn_context>` is injected on
      // resume only. The resume payload is the bare user-message text; the
      // SDK's cached system prompt holds the original `<current_time>` and
      // the snapshot anchored by `<today snapshot_at="...">` (Task 1), both
      // frozen at session start. Without a per-turn fresh-clock anchor, the
      // model cannot compute "how stale is my snapshot" and answers from
      // an out-of-date view of `## Agent Log`. On the fresh-execute branch,
      // the system prompt's `<current_time>` is built at the moment of
      // dispatch — adding `<turn_context>` there would be redundant AND
      // would diverge the prompt prefix per turn, defeating prompt caching.
      // If a future change rebuilds `<today>` mid-session, this code must
      // be revisited because `started_at` would no longer be the snapshot
      // reference.
      let resumeTurnContext: string | null = null;
      let resumeSnapshotAgeMinutes = 0;
      if (canResume) {
        // ── Resume existing SDK session ──
        // Compute the freshness anchors for this resumed turn. `started_at`
        // is the moment `<today>` was captured (the fresh-execute branch
        // builds the system prompt then). Reading from the session row
        // (rather than the in-memory `session` value) keeps this side-
        // effect-free: the row was just fetched by `getOrCreate` and is
        // authoritative.
        //
        // Hoisted above the proactive-forward catchup builder so the
        // builder can use `sessionStartedAtMs` as its lower-bound anchor
        // (DM-HISTORY-CONTINUITY-FIX H-2). `started_at` is fixed at session
        // start and does not race with concurrent inserts; `last_message_at`
        // would.
        const turnNow = new Date();
        const sessionTimingRow = this.db
          .prepare(
            `SELECT started_at FROM conversation_sessions WHERE id = ?`,
          )
          .get(session.id) as { started_at: string | null } | undefined;
        const sessionStartedAtSqlite = sessionTimingRow?.started_at ?? null;
        const sessionStartedAtMs = sessionStartedAtSqlite
          ? parseSqliteUtcMs(sessionStartedAtSqlite)
          : turnNow.getTime();
        resumeSnapshotAgeMinutes = Math.max(
          0,
          Math.round((turnNow.getTime() - sessionStartedAtMs) / 60_000),
        );
        resumeTurnContext =
          `<turn_context current_time="${turnNow.toISOString()}" `
          + `snapshot_age_minutes="${resumeSnapshotAgeMinutes}" />`;

        // DM-HISTORY-CONTINUITY-FIX H-2 — emit ONLY the catchup block,
        // not the full context. The SDK session already holds the cached
        // system prompt with `<conversation_history>`, `<today>`,
        // `<management_rules>` etc.; calling `contextBuilder.build(event)`
        // here would re-encode that entire ~10K-token payload against the
        // user-turn cost AND duplicate the in-session history under a
        // second tag. The narrow catchup builder returns only proactive
        // forwards that landed in this scope (or the other DM surface)
        // *after* the session started — which is exactly the information
        // the SDK does not already have.
        const proactiveForwardContext = forwardContextAvailable
          ? await this.contextBuilder.buildResumeCatchupContext(
              event,
              sessionStartedAtMs,
            )
          : null;
        const userMsgRecorded = this.messageRecorder.recordMessage({
          sessionId: session.id,
          role: "user",
          content: event.content,
          platform: event.platform,
          senderId: event.sender,
        });
        if (userMsgRecorded) {
          userMessageId = this.readLastInsertedMessageId(session.id);
        }

        // §4.5 connector-health DM is dispatched AFTER recordMessage so the
        // warning's messages-table row carries a strictly-later timestamp
        // than the user message. See `consultDelegatedConnectorWarnings`.
        dispatchPendingConnectorHealth();

        const sessionDir = ensureSessionWorkdir(
          this.config.workspaceDir,
          this.config.dataDir,
          session.id,
          event.type,
          {
            backendId: session.backend ?? "claude",
            processKey: route.processKey,
            configuredServices: this.getConfiguredServices(),
            mailAccounts: this.getActiveMailAccounts(),
            integrations: readIntegrations(this.db),
            character: this.config.character,
            // docs/design/appendices/skills-unification.md Phase 4 — runtime context fed to
            // `resolveSkillManifest` so the conditional `gmail-lifestyle`
            // and `managed-tasks` skills drop when the DB has no signal
            // AND the inbound message text carries no trigger phrase. The
            // resume path mirrors the fresh-execute branch (~110 lines
            // below) — without it, drift detection on the second turn
            // would re-render with the conservative-include defaults.
            db: this.db,
            contextDir: getContextDir(this.config),
            ...(isMessageEvent(event) ? { messageText: event.content } : {}),
            ...(workdirOverride ? { override: workdirOverride } : {}),
          },
        );
        // Sync user-authored skills into the workdir before resuming, so any
        // skill added/edited/deleted via /api/skills since the last turn is
        // visible to the SDK's `.claude/skills/` discovery. Cheap and idempotent.
        syncAllUserSkills(sessionDir, resolveUserSkillsRoot(this.config));

        // Phase 1 — stage inbound attachments + bind rows + append
        // bracketed prompt block. For resume we can't prepend to the
        // task-flow template (there isn't one on this path), so the
        // attachment block is appended to the user's message text. A
        // Claude SDK `query()` call sees `prompt` as a single string, so
        // this is the only surface available.
        const resumeStaged = isMessageEvent(event)
          ? this.prompt.stageInboundAttachments(event, sessionDir)
          : [];
        if (resumeStaged.length > 0 && userMessageId !== null && attachmentStore) {
          attachmentStore.bindInbound({
            attachmentIds: resumeStaged.map((r) => r.id),
            sessionId: session.id,
            messageId: userMessageId,
          });
        }
        const resumeTranscripts = await this.prompt.transcribeAttachments(resumeStaged);
        // Surface adapter-reported missing attachments (e.g. expired
        // Discord CDN URLs) so the agent sees a stub describing the file
        // even when the bytes were unreachable.
        const resumeMissing = isMessageEvent(event)
          ? (event.attachments ?? []).filter((a) => a.missing)
          : [];
        const resumeMessage = resumeStaged.length > 0 || resumeMissing.length > 0
          ? `${event.content}\n${this.prompt.buildAttachmentPromptBlock(resumeStaged, resumeTranscripts, resumeMissing)}`
          : event.content;
        const resumeMessageWithForwardContext = proactiveForwardContext
          ? `${resumeTurnContext}\n\n${proactiveForwardContext}\n\n<current_user_message>\n${resumeMessage}\n</current_user_message>`
          : `${resumeTurnContext}\n\n${resumeMessage}`;

        const resumeStagedForBackend = resumeStaged.length > 0
          ? resumeStaged.map((row) => ({
              id: row.id,
              safeFilename: row.safeFilename,
              mimeType: row.mimeType,
              absolutePath: join(sessionDir, "_attachments", row.safeFilename),
              relativePath: `_attachments/${row.safeFilename}`,
            }))
          : [];
        result = await this.errorRouter.executeWithRetry(
          () =>
            this.agentRouter.executeResume(
              {
                backendId: session.backend ?? "claude",
                sessionId: session.sessionId!,
                message: resumeMessageWithForwardContext,
                modelId: route.main.modelId,
                maxTurns: route.main.maxTurns,
                maxBudgetUsd: route.main.maxBudgetUsd,
                sessionDir,
                sessionDbId: session.id,
                eventCorrelationId: event.correlationId,
                ...(turnToken ? { turnToken } : {}),
                ...(resumeStagedForBackend.length > 0
                  ? { stagedAttachments: resumeStagedForBackend }
                  : {}),
              },
              streamCb,
            ),
          event,
        );
      } else {
        // ── Fresh execute ──
        // Docs-QA branches FIRST. Without this gate, `event.isDm` would
        // route the QA event into the generic DM task flow and the
        // agent would run without the QA system prompt (citation
        // enforcement, search budget, "no write tools"). The
        // `dashboard.docs_qa` task flow lives at
        // agent-assets/task-flows/dashboard.docs_qa.md.
        const promptKey = isDocsQAMessage(event)
          ? "dashboard.docs_qa"
          : setupMode === "initial"
            ? "setup.initial"
            : setupMode === "update"
              ? "setup.update"
              : event.isDm && !session.isActive
                ? "message.received.dm_first"
                : event.isDm
                  ? "message.received.dm"
                  : event.type;

        // DM-HISTORY-CONTINUITY-FIX H-1/H-3 follow-up — refresh
        // `started_at` to NOW so it tracks the build time of THIS
        // turn's system prompt. The H-2 catchup builder uses
        // `started_at` as its lower-bound anchor; without this
        // refresh, two paths leave it lagging the actual SDK-session-
        // bind time:
        //   1. handleDirectDm INSERTed the row at scheduler dispatch
        //      time, possibly hours before this fresh-execute (H-1).
        //   2. Dashboard reset-in-place keeps the row + NULLs
        //      backend_session_id, but does not refresh started_at
        //      (H-3 / pre-existing path).
        // In both cases a subsequent resume turn would over-include
        // forwards that the SDK session actually saw at fresh-execute
        // time, duplicating them in the catchup block.
        this.sessionMgr.markFreshExecuteStart(session.id);

        // DM-HISTORY-CONTINUITY-FIX H-3 — suppress the active-session
        // <conversation_history> block when the cross-session bridge
        // below is about to emit "## Previous conversation in this
        // thread" for the same rows. The dashboard reset-in-place
        // path leaves the session row active (so the active block
        // would fire) while also setting requiresHistoryInjection=true
        // (so the cross-session block fires too) — without this gate
        // the two blocks render the same messages under two different
        // XML tags. The two blocks are mutually exclusive after this.
        // Docs-QA is exempt because it skips the cross-session bridge
        // entirely (see DOCS_QA_B7_DESIGN.md §11.6).
        const context = await this.contextBuilder.build(event, {
          skipActiveHistoryBlock:
            session.requiresHistoryInjection === true
            && !isDocsQAMessage(event),
        });
        // Setup flows route through processKey="setup" for backend binding,
        // but the workdir must materialize with the mode-specific processKey
        // so `setup.update` doesn't inherit `setup.initial`'s skill set via
        // PROCESS_TO_EVENT_TYPE["setup"]="setup.initial".
        const workdirEventType = setupMode ? `setup.${setupMode}` : promptKey;
        const workdirProcessKey: ProcessKey = setupMode
          ? (`setup.${setupMode}` as ProcessKey)
          : route.processKey;
        const reassemblePrompt = (bid: BackendId): string =>
          this.prompt.assemble(promptKey, route.processKey, bid);
        const prompt = reassemblePrompt(route.main.backendId);
        // DMs need persistent workdirs/session ids for real resume semantics.
        // Channel/thread conversations only persist high-tier sessions.
        const shouldPersistSessionState = event.isDm || route.resolvedTier === "high";
        const sessionDir = shouldPersistSessionState
          ? ensureSessionWorkdir(
              this.config.workspaceDir,
              this.config.dataDir,
              session.id,
              workdirEventType,
              {
                backendId: route.main.backendId,
                processKey: workdirProcessKey,
                configuredServices: this.getConfiguredServices(),
                mailAccounts: this.getActiveMailAccounts(),
                integrations: readIntegrations(this.db),
                character: this.config.character,
                // docs/design/appendices/skills-unification.md Phase 4 — runtime context for
                // the conditional manifest predicates. `db` feeds
                // `gmailLifestyleActive` / `managedTasksActive`;
                // `messageText` (DM only) feeds the *ForDm trigger-phrase
                // fallback; `contextDir` feeds `eveningRulebookIsActive`
                // (no-op here — DMs never hit the evening_review branch,
                // but the field is cheap to thread for symmetry with the
                // resume callsite above and any future predicate).
                db: this.db,
                contextDir: getContextDir(this.config),
                ...(isMessageEvent(event) ? { messageText: event.content } : {}),
                ...(workdirOverride ? { override: workdirOverride } : {}),
              },
            )
          : undefined;

        // Re-sync user skills on every Opus message. ensureSessionWorkdir is
        // idempotent and skips the copy step on subsequent calls, so without
        // this explicit sync a skill created mid-session (via POST /api/skills)
        // would never reach the session's `.claude/skills/` tree and the SDK
        // wouldn't discover it. The sync is a cheap diff operation backed by
        // a manifest file inside the workdir.
        if (sessionDir) {
          syncAllUserSkills(sessionDir, resolveUserSkillsRoot(this.config));
        }

        // Docs-QA sessions are stateless lookups (DOCS_QA_B7_DESIGN.md
        // §11.6 — "QA panel state lives in React state, not the DB").
        // After a docs_qa session reset (day boundary, model switch),
        // session-manager's `requiresHistoryInjection` would still fire
        // because prior messages exist in the docs_qa scope; without
        // this gate they'd bleed back into the prompt as cross-session
        // history, contradicting the stateless contract and silently
        // ballooning the QA token budget across days.
        const conversationHistory =
          session.requiresHistoryInjection && !isDocsQAMessage(event)
            ? this.resultProcessor.buildCrossSessionConversationHistory(event)
            : null;

        // Record user message AFTER context/history build (avoids injecting
        // the current turn into cross-session history) but BEFORE execute
        // (ensures DB has the message even if execute crashes).
        const freshUserMsgRecorded = this.messageRecorder.recordMessage({
          sessionId: session.id,
          role: "user",
          content: event.content,
          platform: event.platform,
          senderId: event.sender,
        });
        if (freshUserMsgRecorded) {
          userMessageId = this.readLastInsertedMessageId(session.id);
        }

        // §4.5 connector-health DM is dispatched AFTER recordMessage so the
        // warning's messages-table row carries a strictly-later timestamp
        // than the user message. See `consultDelegatedConnectorWarnings`.
        dispatchPendingConnectorHealth();

        // Phase 1 — stage inbound attachments + bind rows + append
        // bracketed prompt block to the prompt body.
        const freshStaged = isMessageEvent(event)
          ? this.prompt.stageInboundAttachments(event, sessionDir)
          : [];
        if (freshStaged.length > 0 && userMessageId !== null && attachmentStore) {
          attachmentStore.bindInbound({
            attachmentIds: freshStaged.map((r) => r.id),
            sessionId: session.id,
            messageId: userMessageId,
          });
        }
        const freshTranscripts = await this.prompt.transcribeAttachments(freshStaged);
        const freshMissing = isMessageEvent(event)
          ? (event.attachments ?? []).filter((a) => a.missing)
          : [];
        const executePrompt = freshStaged.length > 0 || freshMissing.length > 0
          ? `${prompt}\n${this.prompt.buildAttachmentPromptBlock(freshStaged, freshTranscripts, freshMissing)}`
          : prompt;

        // DMs should always persist backend sessions so same-session resume and
        // dashboard history continue do not fall back to history reinjection.
        const persistSession = shouldPersistSessionState;

        const freshStagedForBackend = freshStaged.length > 0 && sessionDir
          ? freshStaged.map((row) => ({
              id: row.id,
              safeFilename: row.safeFilename,
              mimeType: row.mimeType,
              absolutePath: join(sessionDir, "_attachments", row.safeFilename),
              relativePath: `_attachments/${row.safeFilename}`,
            }))
          : [];
        result = await this.errorRouter.executeWithRetry(
          () =>
            this.agentRouter.execute(
              {
                prompt: executePrompt,
                context,
                event,
                processKey:
                  setupMode === "initial" || setupMode === "update"
                    ? "setup"
                    : resolveProcessKey(event),
                sessionDir,
                sessionDbId: session.id,
                persistSession,
                conversationHistory: conversationHistory ?? undefined,
                preResolvedBinding: route,
                workdirEventType,
                workdirProcessKey,
                reassemblePrompt,
                ...(turnToken ? { turnToken } : {}),
                ...(freshStagedForBackend.length > 0
                  ? { stagedAttachments: freshStagedForBackend }
                  : {}),
              },
              streamCb,
            ),
          event,
        );

        // Store SDK sessionId for future resume, including normal owner DMs.
        if (persistSession && result.sessionId) {
          await this.sessionMgr.updateSession(
            session.id,
            result.sessionId,
            result.modelId ?? result.model,
            result.backendId,
          );
        } else if (persistSession && !result.sessionId) {
          // Successful DM/heavy execute, but the backend didn't emit a
          // resumable session id (observed with certain Gemini CLI
          // streams where the `init` event fired without `session_id`).
          // The row keeps its previous `backend_session_id` (possibly
          // NULL) and the next turn will fall through to fresh-execute
          // + history injection — still resumable from the sidebar via
          // the relaxed gate. Log so this stops being invisible.
          logger.warn(
            {
              sessionId: session.id,
              backend: result.backendId,
              model: result.modelId ?? result.model,
            },
            "Execute completed without a backend session id — next resume will rebuild via history injection",
          );
        }
      }

      // Record assistant response. `recordMessage` also bumps the
      // session's `last_message_at` and `message_count` in the same
      // transaction, so nothing else needs to touch the session row here.
      let assistantMessageId: number | null = null;
      let assistantOutput = result.output.trim();
      // Docs-QA persistence-side citation validator (DOCS_QA_B7_DESIGN.md
      // §11.1). The streaming side runs in DocsQAAdapter.sendStreamChunk;
      // this one-shot pass guarantees the persisted `messages.content`
      // matches what the dashboard rendered on reload — without it, an
      // invalid `[doc:slug]` token would be stripped from the SSE wire
      // but reappear in history. Slug-missing tokens are also logged to
      // `agent_actions(action_type='qa_invalid_citation')`.
      const docsCitationLookup = this.getDocsCitationLookup();
      if (
        isDocsQAMessage(event)
        && docsCitationLookup
        && assistantOutput.length > 0
      ) {
        const validation = validateAndRewrite(assistantOutput, docsCitationLookup);
        assistantOutput = validation.text;
        logInvalidCitations(this.db, validation, { sessionId: session.id });
      }
      if (assistantOutput.length > 0) {
        const persisted = this.messageRecorder.recordMessage({
          sessionId: session.id,
          role: "assistant",
          content: assistantOutput,
          platform: event.platform,
          backend: result.backendId,
          modelId: result.modelId ?? result.model,
        });
        if (persisted) {
          assistantMessageId = this.readLastInsertedMessageId(session.id);
          if (forwardContextAvailable) {
            this.resultProcessor.logProactiveForwardDisavowalIfMatched(session.id, assistantOutput);
          }
        }
        if (!persisted && event.platform === "dashboard" && dashboardStream?.sendError) {
          // The agent produced a response but we couldn't persist it. The
          // dashboard tab has no other signal that the turn finished —
          // without this inline surfacing the user would watch the reply
          // stream in, then hit the 120s waiting timeout on refresh with
          // no history row to reconcile against. Tell them directly.
          dashboardStream.sendError(
            resolveDashboardChannel(),
            "The agent's reply could not be saved. Please try again.",
          );
        }
      } else {
        // Agent returned no output — send error feedback so the user isn't left waiting
        const errorMsg = "Could not generate a response. Please try again.";
        logger.warn(
          { sessionId: session.id, isError: result.isError, stopReason: result.stopReason },
          "Agent returned empty output for message event",
        );
        this.messageRecorder.recordMessage({
          sessionId: session.id,
          role: "assistant",
          content: errorMsg,
          platform: event.platform,
          backend: result.backendId,
          modelId: result.modelId ?? result.model,
        });
        // Send error to dashboard chat so the user sees it inline
        if (event.platform === "dashboard" && dashboardStream?.sendError) {
          dashboardStream.sendError(resolveDashboardChannel(), errorMsg);
        }
        await this.notificationMgr.send(errorMsg, event);
      }

      // Send message metadata to dashboard for per-message footer display.
      // This is also the client's cue to refetch history after a mid-execute
      // reconnect — the chunks that arrived before the user reopened the tab
      // were dropped into the old channel, so the live messages state may be
      // missing content that is already in the DB.
      if (event.platform === "dashboard" && dashboardStream?.sendMessageMeta) {
        dashboardStream.sendMessageMeta(resolveDashboardChannel(), {
          backend: result.backendId,
          model: result.modelId ?? result.model,
          durationMs: result.durationMs,
          costUsd: result.costUsd,
        });
      }

      // Update session-level model info with actual execution result.
      // This corrects the pre-execution estimate when fallback kicked in,
      // and pushes the cumulative costUsd to the sidebar badge.
      if (event.platform === "dashboard" && dashboardStream?.sendSessionInfo) {
        const actualModel = result.modelId ?? result.model;
        const actualBackend = result.backendId ?? route.main.backendId;
        dashboardStream.sendSessionInfo(resolveDashboardChannel(), {
          model: actualModel,
          backend: actualBackend,
          modelLabel: getModelLabel(actualBackend, actualModel),
          costUsd: result.costUsd,
        });
      }

      // Chat-attachments Phase 1 — collect outbound files the agent
      // produced during this turn and deliver them via the originating
      // adapter. Currently only the Dashboard adapter delivers outbound
      // attachments on-wire; other platforms ignore the `attachments`
      // field until Phase 2.
      if (
        turnToken
        && attachmentStore
        && assistantMessageId !== null
        && assistantOutput.length > 0
      ) {
        const outboundRows = attachmentStore.collectOutboundForTurn({
          turnToken,
          sessionId: session.id,
        });
        if (outboundRows.length > 0) {
          for (const row of outboundRows) {
            attachmentStore.bindOutboundToMessage(row.id, assistantMessageId);
          }
          if (event.platform === "dashboard" && dashboardStream?.sendAttachments) {
            dashboardStream.sendAttachments(
              resolveDashboardChannel(),
              outboundRows.map((row) => ({
                id: row.id,
                originalFilename: row.originalFilename,
                mimeType: row.mimeType,
                sizeBytes: row.sizeBytes,
                ...(row.caption ? { caption: row.caption } : {}),
              })),
            );
          }
        }
      }

      // STAGE-C-DM-FRESHNESS-PLAN §Task 4 — collect the per-turn DM
      // freshness telemetry before notification + audit. Limited to DM
      // events: the metric only makes sense for the resume-or-fresh-
      // execute decision the message dispatch makes. We compute counts
      // bounded by the captured `turnStartedAtSqlite` so writes the
      // agent itself made during THIS turn are not folded back in.
      const dmFreshness = event.isDm
        ? this.collectDmFreshnessTelemetry({
            sessionId: session.id,
            canResume: Boolean(canResume),
            resumeSnapshotAgeMinutes,
            turnStartedAtSqlite,
            userContent: event.content,
          })
        : undefined;

      // Skip notification if we already streamed (avoids duplicate message)
      await this.resultProcessor.processResult(result, event, didStream, {
        originSessionId: session.id,
        ...(dmFreshness ? { dmFreshness } : {}),
      });
    } finally {
      // Always release the turn token, even on error paths. Any outbound
      // rows the agent posted that weren't collected above fall into the
      // orphan reaper's domain on the next daemon restart.
      if (turnToken) {
        this.prompt.releaseAttachmentTurnToken(turnToken);
        this.getAttachmentStore()?.releaseTurnToken(turnToken);
      }
      await replyActivity.stop();
    }
  }

  /**
   * STAGE-C-DM-FRESHNESS-PLAN §Task 4 — assemble the DM-only freshness
   * telemetry payload that gets persisted into `agent_actions.detail`.
   * Pulled into its own method so the message-dispatch path stays
   * readable and so unit tests can exercise the SQL aggregation in
   * isolation.
   *
   * Verbatim move from `dispatcher.ts:collectDmFreshnessTelemetry`.
   */
  collectDmFreshnessTelemetry(input: {
    sessionId: number;
    canResume: boolean;
    resumeSnapshotAgeMinutes: number;
    turnStartedAtSqlite: string;
    userContent: string;
  }): {
    resumed: boolean;
    agentLogLagMinutes: number;
    loudWritesSinceSessionStart: number;
    quietWritesSinceSessionStart: number;
    refetchedToday: boolean;
    triggerMatched: boolean;
  } {
    const sessionRow = this.db
      .prepare(
        `SELECT started_at FROM conversation_sessions WHERE id = ?`,
      )
      .get(input.sessionId) as { started_at: string | null } | undefined;
    // Fall back to turnStart so a missing started_at yields zero counts
    // instead of poisoning the aggregation with a wide-open lower bound.
    const sessionStartedAtSqlite =
      sessionRow?.started_at ?? input.turnStartedAtSqlite;
    const writeCounts = countContextWritesInWindow(
      this.db,
      sessionStartedAtSqlite,
      input.turnStartedAtSqlite,
    );
    // Bound the refetch window at "now" so a context_read that lands
    // AFTER this turn's executeWithRetry returns (e.g. from a future
    // parallel dispatcher, an unrelated routine, or a dashboard reload)
    // is not wrongly attributed to this turn.
    const turnEndSqlite = formatSqliteDatetime(new Date());
    const refetchedToday = didRefetchTodayDuringTurn(
      this.db,
      input.turnStartedAtSqlite,
      turnEndSqlite,
    );
    return {
      resumed: input.canResume,
      // Fresh-execute branch sets resumeSnapshotAgeMinutes=0 by default;
      // that's the correct lag because the system prompt's <today> was
      // built at this very turn.
      agentLogLagMinutes: input.canResume ? input.resumeSnapshotAgeMinutes : 0,
      loudWritesSinceSessionStart: writeCounts.loud,
      quietWritesSinceSessionStart: writeCounts.quiet,
      refetchedToday,
      triggerMatched: matchesRecentActivityTrigger(input.userContent),
    };
  }
}
