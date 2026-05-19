import type Database from "better-sqlite3";
import {
  nowInTimezone,
  parseSqliteUtcMs,
  type BackendId,
} from "@aitne/shared";
import type { AgentConfig } from "../config.js";
import { readRuntimeState } from "../db/runtime-state.js";
import type { ISessionManager } from "./dispatcher.js";
import { cleanupSessionWorkdir, getSessionWorkdirPath } from "./workdir.js";
import { CONTEXT_CHANGED_AT_KEY } from "./dashboard-session-controls.js";
import {
  DASHBOARD_CHAT_SCOPE,
  DOCS_QA_SCOPE,
  getConversationScope,
  LOGICAL_OWNER_CHANNEL,
  LOGICAL_OWNER_PLATFORM,
  OWNER_DM_SCOPE,
} from "../messaging/constants.js";
import { createLogger } from "../logging.js";

/**
 * Side effects produced by a close/expire operation that MUST be applied
 * AFTER the surrounding SQL transaction commits.
 *
 * Motivation: `cleanupSessionWorkdir` does a synchronous `rmSync` and mutating
 * the in-memory `staleDmSessionIds` set are not transactional — if we run
 * them inside a `db.transaction(...)` body and the transaction later rolls
 * back, the DB is restored to its pre-transaction state but the filesystem
 * deletion and set mutation are permanent. Collect intents during the
 * transaction and flush them only when the transaction returns normally.
 */
export interface DeferredSessionEffects {
  /** Session IDs whose workdir should be `rmSync`'d after commit. */
  readonly workdirCleanups: number[];
  /** Session IDs that should be removed from `staleDmSessionIds` after commit. */
  readonly staleFlagClears: number[];
}

function createDeferredEffects(): DeferredSessionEffects {
  return { workdirCleanups: [], staleFlagClears: [] };
}

/**
 * better-sqlite3 may return `bigint` for AUTOINCREMENT primary keys once the
 * value exceeds `Number.MAX_SAFE_INTEGER`. Throw fast so a silently-truncated
 * id does not corrupt later lookups. `conversation_sessions.id` is INTEGER,
 * so practical values are tiny — this guard is future-proofing.
 */
function toSessionId(raw: number | bigint): number {
  if (typeof raw === "number") return raw;
  if (raw <= BigInt(Number.MAX_SAFE_INTEGER) && raw >= BigInt(Number.MIN_SAFE_INTEGER)) {
    return Number(raw);
  }
  throw new Error(`Session id ${raw} exceeds JS safe-integer range`);
}

const logger = createLogger("session-manager");

export function findOrCreateActiveChannelSession(
  db: Database.Database,
  params: {
    scope: typeof OWNER_DM_SCOPE | typeof DASHBOARD_CHAT_SCOPE;
    scopeKey: string;
    platform: string;
    channelId: string;
  },
): { id: number; created: boolean } {
  const resolveExisting = (): { id: number } | undefined =>
    db
      .prepare(
        `SELECT id
           FROM conversation_sessions
          WHERE scope = ? AND scope_key = ? AND status = 'active'
          ORDER BY last_message_at DESC
          LIMIT 1`,
      )
      .get(params.scope, params.scopeKey) as { id: number } | undefined;

  const tx = db.transaction(() => {
    const existing = resolveExisting();
    if (existing) {
      return { id: toSessionId(existing.id), created: false };
    }
    try {
      const result = db
        .prepare(
          `INSERT INTO conversation_sessions (
             scope, scope_key, platform, channel_id, status, is_dm
           )
           VALUES (?, ?, ?, ?, 'active', 1)`,
        )
        .run(params.scope, params.scopeKey, params.platform, params.channelId);
      return { id: toSessionId(result.lastInsertRowid), created: true };
    } catch (err) {
      const winner = resolveExisting();
      if (winner) {
        return { id: toSessionId(winner.id), created: false };
      }
      throw err;
    }
  });

  return tx();
}

interface SessionRecord {
  id: number;
  isActive: boolean;
  sessionId: string | null;
  model: string;
  backend?: BackendId;
  requiresHistoryInjection?: boolean;
}

interface DbSession {
  id: number;
  backend_session_id?: string | null;
  backend?: BackendId | null;
  model: string;
  status: string;
  last_message_at: string;
  platform: string;
  channel_id: string;
  thread_id: string | null;
  scope: string;
  scope_key: string;
  is_dm?: number;
}

export class SessionManager implements ISessionManager {
  private readonly staleDmSessionIds = new Set<number>();

  constructor(
    private readonly db: Database.Database,
    private readonly config: AgentConfig,
  ) {}

  /**
   * Resolve the configured default model for new sessions.
   * Checks backend_global_defaults first, falls back to 'opus'.
   */
  private resolveDefaultModel(): string {
    try {
      const exists = this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'backend_global_defaults' LIMIT 1")
        .get();
      if (!exists) return "opus";

      const row = this.db
        .prepare("SELECT default_high_model FROM backend_global_defaults WHERE singleton = 1")
        .get() as { default_high_model: string } | undefined;
      return row?.default_high_model ?? "opus";
    } catch {
      return "opus";
    }
  }

  /**
   * Mark active DM sessions stale so the next direct message starts fresh.
   *
   * This is intentionally deferred rather than closing immediately: context
   * files are often updated by the agent during an in-flight turn, and
   * deleting the session workdir mid-run would break the active SDK process.
   *
   * Both browser-only dashboard chats and owner messaging DMs need this so
   * context mutations do not keep resuming an old backend session.
   */
  /**
   * Enumerate active DM sessions (owner DM + browser-only dashboard chat).
   *
   * Used by callers that need to refresh on-disk session workdir assets when
   * global config changes mid-flight — e.g. when the user toggles
   * `enabledMailProviders` or adds a mail account, the skill dirs baked into
   * each DM workdir must be re-materialized so the agent picks up the new
   * scope on its next turn without having to tear down the session.
   *
   * Options:
   * - `excludeStale` (default `true`): drop sessions that have been marked
   *   stale via {@link markActiveDmSessionsStale}. Their workdir is about to
   *   be abandoned on the next turn, so refreshing it is pure waste.
   */
  listActiveDmSessions(
    options: { excludeStale?: boolean } = {},
  ): Array<{
    id: number;
    backend: BackendId | null;
    scope: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT id, backend, scope
         FROM conversation_sessions
         WHERE is_dm = 1
           AND status = 'active'
           AND scope IN (?, ?)`,
      )
      .all(DASHBOARD_CHAT_SCOPE, OWNER_DM_SCOPE) as Array<{
        id: number | bigint;
        backend: BackendId | null;
        scope: string;
      }>;
    const excludeStale = options.excludeStale ?? true;
    return rows
      .map((row) => ({
        id: toSessionId(row.id),
        backend: row.backend,
        scope: row.scope,
      }))
      .filter((row) => !excludeStale || !this.staleDmSessionIds.has(row.id));
  }

  markActiveDmSessionsStale(reason: string): void {
    const rows = this.db
      .prepare(
        `SELECT id
         FROM conversation_sessions
         WHERE is_dm = 1
           AND status = 'active'
           AND scope IN (?, ?)
         ORDER BY last_message_at DESC`,
      )
      .all(
        DASHBOARD_CHAT_SCOPE,
        OWNER_DM_SCOPE,
      ) as Array<{ id: number }>;

    if (rows.length === 0) return;
    for (const row of rows) {
      this.staleDmSessionIds.add(row.id);
    }
    logger.info(
      { sessionIds: rows.map((row) => row.id), reason },
      "Active DM sessions marked stale",
    );
  }

  private getSessionLookupColumns(): string {
    return "id, backend_session_id, backend, model, last_message_at";
  }

  private getSessionIdForResume(
    row: Pick<DbSession, "backend_session_id">,
  ): string | null {
    return row.backend_session_id ?? null;
  }

  private getSessionBackend(
    row: Pick<DbSession, "backend">,
  ): BackendId {
    return row.backend ?? "claude";
  }

  /**
   * Only dashboard-chat sessions stay resumable from dashboard history until
   * retention deletes the DB row. Messaging-app owner DM conversations stay
   * read-only in the dashboard and clean up immediately.
   *
   * All DASHBOARD_CHAT_SCOPE sessions qualify — including ones that have not
   * yet recorded a backend_session_id or any messages. This is required for
   * two cases:
   *   (a) In-flight first execute: the SDK is actively writing into the
   *       workdir; deleting it mid-run would corrupt the SDK process.
   *   (b) "Current session stays resumable" UX: when the user switches to a
   *       past session, the freshly-closed session must remain on disk so
   *       they can switch back. Retention (7-day inactive + full row delete
   *       followed by cleanupStaleWorkdirs) ultimately reclaims the disk.
   *
   * Cross-platform mixing is structurally impossible: getConversationScope
   * routes dashboard platform into DASHBOARD_CHAT_SCOPE and every other
   * platform into OWNER_DM_SCOPE, so a DASHBOARD_CHAT_SCOPE row can only
   * ever accumulate messages with platform='dashboard'.
   */
  private shouldPreserveResumeState(id: number): boolean {
    const row = this.db
      .prepare(
        `SELECT scope
           FROM conversation_sessions
          WHERE id = ?`,
      )
      .get(id) as { scope: string } | undefined;
    return row?.scope === DASHBOARD_CHAT_SCOPE;
  }

  /**
   * Get or create a session for the given routing tuple.
   *
   * Uses a DB transaction to atomically:
   * 1. Search for existing active session
   * 2. If found but timed out → expire it, create new session
   * 3. If found and within timeout → return for resume
   * 4. If not found → create new session
   *
   * All non-transactional side effects (filesystem workdir cleanup,
   * `staleDmSessionIds` mutations) are collected during the transaction
   * and only applied after it commits — so a rollback never leaves us
   * with vanished files or a desynced in-memory flag.
   */
  async getOrCreate(params: {
    platform: string;
    channel: string;
    threadId: string | null;
    isDm?: boolean;
    /** MessageEvent.intent — forks the dashboard DM tuple into a separate
     *  `docs_qa` scope so QA sessions and chat sessions don't collide. */
    intent?: "chat" | "docs_qa";
    requiredBackend?: BackendId;
    requiredModel?: string;
  }): Promise<SessionRecord> {
    const {
      platform,
      channel,
      threadId,
      isDm,
      intent,
      requiredBackend = "claude",
      requiredModel,
    } = params;

    const effects = createDeferredEffects();
    const record = this.db.transaction(() => {
      if (isDm) {
        return this.getOrCreateDm(
          platform,
          channel,
          intent,
          requiredBackend,
          requiredModel,
          effects,
        );
      }
      return this.getOrCreateThread(
        platform,
        channel,
        threadId,
        requiredBackend,
        requiredModel,
        effects,
      );
    })();
    // Transaction committed — safe to run non-transactional side effects.
    this.applyDeferredEffects(effects);
    return record;
  }

  /**
   * Apply the non-transactional side effects collected during a transactional
   * close/expire path. Called only after the surrounding transaction commits.
   */
  private applyDeferredEffects(effects: DeferredSessionEffects): void {
    for (const id of effects.staleFlagClears) {
      this.staleDmSessionIds.delete(id);
    }
    for (const id of effects.workdirCleanups) {
      cleanupSessionWorkdir(getSessionWorkdirPath(this.config.dataDir, id));
    }
  }

  /**
   * Transaction-safe variant of `closeSession` — records the DB UPDATE
   * inside the caller's transaction but queues filesystem and in-memory
   * side effects into the supplied effects buffer for post-commit flush.
   *
   * External callers that are NOT already inside a transaction should use
   * the public `closeSession`, which wraps this helper.
   */
  closeSessionInTx(id: number, effects: DeferredSessionEffects): void {
    this.db
      .prepare("UPDATE conversation_sessions SET status = 'closed' WHERE id = ?")
      .run(id);
    effects.staleFlagClears.push(id);
    const preserveResumeState = this.shouldPreserveResumeState(id);
    if (!preserveResumeState) {
      effects.workdirCleanups.push(id);
    }
    logger.info({ sessionId: id, preserveResumeState }, "Session explicitly closed");
  }

  /**
   * Fresh effects buffer for callers that own their own transaction (e.g.
   * `continueDashboardSession`) and want to apply the collected side effects
   * themselves after commit.
   */
  newEffectsBuffer(): DeferredSessionEffects {
    return createDeferredEffects();
  }

  /** Flush a caller-owned effects buffer after the caller's TX commits. */
  flushEffects(effects: DeferredSessionEffects): void {
    this.applyDeferredEffects(effects);
  }

  /**
   * DM session lookup: one unified owner session per day.
   * - No idle timeout — DM sessions persist until the 4 AM day boundary
   * - Only expires when the day boundary is crossed, the backend switches,
   *   or a context file was mutated after the session's last turn
   * - Reuses the stored SDK session id until the session is marked stale
   *
   * For `DASHBOARD_CHAT_SCOPE`, backend-switch is handled in-place
   * (UPDATE backend + NULL backend_session_id on the same row) so that
   * a user who clicked "Continue" on session #N keeps seeing session #N
   * across a Claude↔Codex flap, and their `messages` history stays linked.
   */
  private getOrCreateDm(
    platform: string,
    channel: string,
    intent: "chat" | "docs_qa" | undefined,
    requiredBackend: BackendId,
    requiredModel: string | undefined,
    effects: DeferredSessionEffects,
  ): SessionRecord {
    const effectiveBackend = requiredBackend;
    const { scope, scopeKey } = getConversationScope({
      platform,
      channel,
      threadId: null,
      isDm: true,
      intent,
    });
    // Both dashboard scopes are dashboard-tab traffic and keep their browser
    // channel id so the SSE adapter can route deltas back to the correct
    // tab. Owner DMs collapse to the canonical owner platform/channel
    // because the row identifies a unified per-day session.
    const isDashboardScope =
      scope === DASHBOARD_CHAT_SCOPE || scope === DOCS_QA_SCOPE;
    const sessionPlatform = isDashboardScope ? "dashboard" : LOGICAL_OWNER_PLATFORM;
    const sessionChannel = isDashboardScope ? channel : LOGICAL_OWNER_CHANNEL;
    const existing = this.db
      .prepare(
        `SELECT ${this.getSessionLookupColumns()}
         FROM conversation_sessions
         WHERE scope = ? AND scope_key = ? AND status = 'active'
         ORDER BY last_message_at DESC LIMIT 1`,
      )
      .get(scope, scopeKey) as
        | Pick<
            DbSession,
            | "id"
            | "backend_session_id"
            | "backend"
            | "model"
            | "last_message_at"
          >
        | undefined;

    if (existing) {
      // In-memory stale flag (set by markActiveDmSessionsStale) + persistent
      // context_changed_at timestamp (written by markContextChanged on loud
      // prompt-context changes). Either signal wins: the persistent one
      // catches cases the in-memory set cannot, e.g. a daemon restart
      // between the mutation and the user's next message.
      const contextChangedAt = readRuntimeState<string>(
        this.db,
        CONTEXT_CHANGED_AT_KEY,
      );
      // Compare against the most recent message that the SDK session
      // *actually consumed* (user turn or DM-agent reply), not the row's
      // `last_message_at`. Proactive forwards (dm-channel-timeline.md
      // §B/§F.7) bump `last_message_at` from a different SDK session, so
      // using it would mask context changes that happened just before a
      // forward and falsely treat the resumed session as fresh.
      const lastConsumedAt =
        this.lastNonForwardMessageAt(existing.id) ?? existing.last_message_at;
      const contextStale =
        typeof contextChangedAt === "string"
        && contextChangedAt > lastConsumedAt;
      const flaggedStale = this.staleDmSessionIds.has(existing.id);
      const lastMsg = parseSqliteUtcMs(existing.last_message_at);
      const crossedBoundary = this.crossedDayBoundary(lastMsg);
      const backendMatches = this.getSessionBackend(existing) === effectiveBackend;
      // Treat a model switch within the same backend (e.g. Sonnet → Opus
      // via the dashboard picker) the same as a backend flap: the SDK's
      // resume path reuses the original model tied to the stored session
      // id and silently drops the new model, so we must close the SDK
      // session and re-inject history for the new model to take effect.
      // When the caller didn't pass `requiredModel`, fall back to the
      // pre-existing behavior (match).
      const modelMatches =
        requiredModel === undefined || existing.model === requiredModel;

      // Hot path: nothing stale / no transition → resume as-is.
      if (
        !flaggedStale
        && !contextStale
        && !crossedBoundary
        && backendMatches
        && modelMatches
      ) {
        return {
          id: existing.id,
          isActive: true,
          sessionId: this.getSessionIdForResume(existing),
          model: existing.model,
          backend: this.getSessionBackend(existing),
          requiresHistoryInjection: false,
        };
      }

      // Dashboard-only preservation: for stale context OR backend flap OR
      // model switch, we reset the SDK session in place (NULL
      // backend_session_id, UPDATE backend + model, bump last_message_at)
      // rather than closing + creating a new row. Rationale:
      //   - `Continue #N` in the sidebar must stay as #N across context
      //     mutations, Claude↔Codex flaps, and Sonnet↔Opus picks —
      //     creating a new row would silently rename the session.
      //   - Day-boundary crossings still expire the row (users expect a
      //     fresh day to be a fresh conversation).
      //   - `last_message_at` is refreshed so the `context_changed_at`
      //     check does NOT fire again on the very next turn just because
      //     we didn't close. `requiresHistoryInjection` uses the messages
      //     table, which is preserved, so prior history still reaches
      //     the fresh SDK session on first turn.
      if (
        scope === DASHBOARD_CHAT_SCOPE
        && !crossedBoundary
        && (flaggedStale || contextStale || !backendMatches || !modelMatches)
      ) {
        effects.staleFlagClears.push(existing.id);
        const nextModel = requiredModel ?? existing.model;
        this.db
          .prepare(
            `UPDATE conversation_sessions
                SET backend = ?,
                    model = ?,
                    backend_session_id = NULL,
                    last_message_at = CURRENT_TIMESTAMP
              WHERE id = ?`,
          )
          .run(effectiveBackend, nextModel, existing.id);
        logger.info(
          {
            sessionId: existing.id,
            previousBackend: this.getSessionBackend(existing),
            nextBackend: effectiveBackend,
            previousModel: existing.model,
            nextModel,
            reason: flaggedStale
              ? "in_memory_stale"
              : contextStale
                ? "context_changed_at"
                : !backendMatches
                  ? "backend_switch"
                  : "model_switch",
          },
          "Dashboard DM session reset in place",
        );
        return {
          id: existing.id,
          isActive: false,
          sessionId: null,
          model: nextModel,
          backend: effectiveBackend,
          requiresHistoryInjection:
            this.countMessagesInScope(scope, scopeKey) > 0,
        };
      }

      // Non-dashboard stale path or day-boundary → close/expire + fall
      // through to create a fresh row below.
      if (flaggedStale || contextStale) {
        this.closeSessionInTx(existing.id, effects);
        logger.info(
          {
            sessionId: existing.id,
            trigger: flaggedStale ? "in_memory_flag" : "context_changed_at",
          },
          "DM session refreshed after context change",
        );
      } else {
        this.db
          .prepare("UPDATE conversation_sessions SET status = 'expired' WHERE id = ?")
          .run(existing.id);
        const preserveResumeState = this.shouldPreserveResumeState(existing.id);
        if (!preserveResumeState) {
          effects.workdirCleanups.push(existing.id);
        }
        logger.info(
          {
            sessionId: existing.id,
            reason: crossedBoundary
              ? "day_boundary"
              : !backendMatches
                ? "backend_switch"
                : "model_switch",
            previousBackend: this.getSessionBackend(existing),
            nextBackend: effectiveBackend,
            previousModel: existing.model,
            nextModel: requiredModel ?? existing.model,
            preserveResumeState,
          },
          "DM session expired",
        );
      }
    }

    // Create a new day-long DM session for the resolved DM scope.
    // Prefer the caller-provided model so a picker-driven switch starts the
    // new session on the chosen model instead of the global default.
    const defaultModel = requiredModel ?? this.resolveDefaultModel();
    const requiresHistoryInjection =
      this.countMessagesInScope(scope, scopeKey) > 0;
    const result = this.db
      .prepare(
        `INSERT INTO conversation_sessions (
           platform, channel_id, thread_id, scope, scope_key, status, model, is_dm, backend
         )
         VALUES (?, ?, NULL, ?, ?, 'active', ?, 1, ?)`,
      )
      .run(
        sessionPlatform,
        sessionChannel,
        scope,
        scopeKey,
        defaultModel,
        effectiveBackend,
      );

    return {
      id: toSessionId(result.lastInsertRowid),
      isActive: false,
      sessionId: null,
      model: defaultModel,
      backend: effectiveBackend,
      requiresHistoryInjection,
    };
  }

  /**
   * Non-DM session lookup: by (platform, channel_id, thread_id) with timeout.
   * Original behavior — used for Slack/Discord channel threads.
   */
  private getOrCreateThread(
    platform: string,
    channel: string,
    threadId: string | null,
    requiredBackend: BackendId,
    requiredModel: string | undefined,
    effects: DeferredSessionEffects,
  ): SessionRecord {
    const effectiveBackend = requiredBackend;
    const { scope, scopeKey } = getConversationScope({
      platform,
      channel,
      threadId,
      isDm: false,
    });
    const existing = this.db
      .prepare(
        `SELECT ${this.getSessionLookupColumns()}, status
         FROM conversation_sessions
         WHERE scope = ? AND scope_key = ? AND status = 'active'
         ORDER BY last_message_at DESC LIMIT 1`,
      )
      .get(scope, scopeKey) as DbSession | undefined;

    if (existing) {
      const timeout = this.getTimeoutMs(platform, false);
      const lastMsg = parseSqliteUtcMs(existing.last_message_at);
      const elapsed = Date.now() - lastMsg;
      const crossedBoundary = this.crossedDayBoundary(lastMsg);
      const backendMatches = this.getSessionBackend(existing) === effectiveBackend;
      const modelMatches =
        requiredModel === undefined || existing.model === requiredModel;

      if (
        elapsed < timeout
        && !crossedBoundary
        && backendMatches
        && modelMatches
      ) {
        return {
          id: existing.id,
          isActive: true,
          sessionId: this.getSessionIdForResume(existing),
          model: existing.model,
          backend: this.getSessionBackend(existing),
          requiresHistoryInjection: false,
        };
      }

      this.db
        .prepare("UPDATE conversation_sessions SET status = 'expired' WHERE id = ?")
        .run(existing.id);
      // Workdir cleanup deferred to after-commit — avoids `rmSync` running
      // inside this transaction, where a later throw would leave the DB
      // restored to 'active' but the files permanently gone.
      effects.workdirCleanups.push(existing.id);
      logger.info(
        {
          sessionId: existing.id,
          platform,
          elapsed: Math.round(elapsed / 1000),
          reason:
            elapsed >= timeout
              ? "timeout"
              : crossedBoundary
                ? "day_boundary"
                : !backendMatches
                  ? "backend_switch"
                  : "model_switch",
          previousBackend: this.getSessionBackend(existing),
          nextBackend: effectiveBackend,
          previousModel: existing.model,
          nextModel: requiredModel ?? existing.model,
        },
        "Session expired",
      );
    }

    const defaultModel = requiredModel ?? this.resolveDefaultModel();
    const requiresHistoryInjection =
      this.countMessagesInScope(scope, scopeKey) > 0;
    const result = this.db
      .prepare(
        `INSERT INTO conversation_sessions (
           platform, channel_id, thread_id, scope, scope_key, status, model, is_dm, backend
         )
         VALUES (?, ?, ?, ?, ?, 'active', ?, 0, ?)`,
      )
      .run(platform, channel, threadId ?? null, scope, scopeKey, defaultModel, effectiveBackend);

    return {
      id: toSessionId(result.lastInsertRowid),
      isActive: false,
      sessionId: null,
      model: defaultModel,
      backend: effectiveBackend,
      requiresHistoryInjection,
    };
  }

  /**
   * Look up the DB's currently-bound `channel_id` for an active session.
   *
   * The dashboard SSE route updates `conversation_sessions.channel_id` via
   * `rebindSessionChannel` whenever a browser tab reconnects with a stored
   * sessionId (page navigation, SSE auto-reconnect, etc.). Dispatcher
   * callbacks (stream chunks, session_info pushes, chat_meta, errors)
   * captured `event.channel` in a closure at event creation time, which
   * goes stale the moment the original tab disconnects. Resolving the
   * current channel_id on every send routes those messages to whatever
   * tab is currently connected for this session.
   *
   * Returns `null` when the session is not active (closed/expired) or when
   * no row matches, so callers can fall back to the original event.channel
   * and let DashboardAdapter silently drop if neither is connected.
   */
  getActiveChannelIdForSession(sessionId: number): string | null {
    const row = this.db
      .prepare(
        "SELECT channel_id FROM conversation_sessions WHERE id = ? AND status = 'active' LIMIT 1",
      )
      .get(sessionId) as { channel_id: string } | undefined;
    return row?.channel_id ?? null;
  }

  /** Find an existing active session without creating one */
  async findActive(params: {
    platform: string;
    channel: string;
    threadId: string | null;
    isDm?: boolean;
    intent?: "chat" | "docs_qa";
  }): Promise<{ id: number } | null> {
    const { platform, channel, threadId, isDm, intent } = params;
    const { scope, scopeKey } = getConversationScope({
      platform,
      channel,
      threadId,
      isDm,
      intent,
    });
    const row = this.db
      .prepare(
        `SELECT id FROM conversation_sessions
         WHERE scope = ? AND scope_key = ? AND status = 'active'
         ORDER BY last_message_at DESC
         LIMIT 1`,
      )
      .get(scope, scopeKey) as { id: number } | undefined;
    return row ?? null;
  }

  /** Update the session ID and model for a conversation session */
  async updateSession(
    id: number,
    sessionId: string,
    model: string,
    backend: BackendId = "claude",
  ): Promise<void> {
    this.db
      .prepare(
        `UPDATE conversation_sessions
           SET backend_session_id = ?,
               backend = ?,
               model = ?,
               last_message_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
      .run(sessionId, backend, model, id);
  }

  /**
   * Refresh `started_at` to the current wall clock. See the docstring
   * on `ISessionManager.markFreshExecuteStart` for the full rationale.
   *
   * Cheap (single indexed UPDATE on primary key) and idempotent. Safe
   * to call on every fresh-execute turn — for the dominant path where
   * the row was INSERTed milliseconds ago by getOrCreateDm, this is a
   * no-op-functionally (the value barely changes); for the H-1 /
   * reset-in-place paths it's the load-bearing fix that keeps
   * `started_at` aligned with the `<today>` snapshot in the system
   * prompt this turn writes.
   */
  markFreshExecuteStart(id: number): void {
    this.db
      .prepare(
        `UPDATE conversation_sessions
            SET started_at = CURRENT_TIMESTAMP
          WHERE id = ?`,
      )
      .run(id);
  }

  /**
   * Timestamp of the most recent message in `id` that the SDK session
   * actually consumed — i.e. excluding rows the daemon inserted on
   * behalf of an out-of-band dispatch path:
   *  - `proactive_forward(_batched)` — channel-timeline writes from
   *    `recordProactiveForwardDeliveries` (notification-manager).
   *  - `scheduled_dm` — pre-composed `/api/schedule/dm` deliveries
   *    sent by `scheduler.handleDirectDm` (DM-HISTORY-CONTINUITY-FIX
   *    H-1). Both bypass any SDK session, so neither should extend
   *    the session's idle window or be treated as a turn the SDK is
   *    "between" replies for.
   *
   * Returns `undefined` when the session has no non-forward messages
   * yet (in which case callers fall back to the row's `last_message_at`).
   */
  private lastNonForwardMessageAt(id: number): string | undefined {
    const row = this.db
      .prepare(
        `SELECT timestamp
           FROM messages
          WHERE session_id = ?
            AND (
              role <> 'assistant'
              OR json_extract(metadata, '$.notificationType') IS NULL
              OR json_extract(metadata, '$.notificationType') NOT IN
                 ('proactive_forward', 'proactive_forward_batched', 'scheduled_dm')
            )
          ORDER BY timestamp DESC, id DESC
          LIMIT 1`,
      )
      .get(id) as { timestamp: string } | undefined;
    return row?.timestamp;
  }

  /** Touch last_message_at and increment message_count */
  touchSession(id: number): void {
    this.db
      .prepare(
        "UPDATE conversation_sessions SET last_message_at = CURRENT_TIMESTAMP, message_count = message_count + 1 WHERE id = ?",
      )
      .run(id);
  }

  /**
   * Explicitly close a session (user-initiated). Safe to call from outside
   * any transaction — runs the DB UPDATE and then applies filesystem +
   * in-memory side effects. Callers already inside a transaction should
   * use `closeSessionInTx` with a caller-owned effects buffer instead.
   */
  closeSession(id: number): void {
    const effects = createDeferredEffects();
    this.closeSessionInTx(id, effects);
    this.applyDeferredEffects(effects);
  }

  /** Get platform-specific session timeout in milliseconds */
  private getTimeoutMs(platform: string, isDm?: boolean): number {
    if (platform === "dashboard") {
      return this.config.sessionTimeoutDashboardMinutes * 60 * 1000;
    }
    // DM uses longer timeout; channel mentions use shorter timeout
    if (isDm === false) {
      return this.config.sessionTimeoutChannelMinutes * 60 * 1000;
    }
    return this.config.sessionTimeoutDmMinutes * 60 * 1000;
  }

  private countMessagesInScope(scope: string, scopeKey: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM messages m
         JOIN conversation_sessions s ON m.session_id = s.id
         WHERE s.scope = ? AND s.scope_key = ?`,
      )
      .get(scope, scopeKey) as { count: number };
    return row.count;
  }

  /**
   * Check if the period between lastMessageAt and now crosses a day boundary.
   * Day boundary = config.dayBoundaryHour (default 04:00).
   */
  private crossedDayBoundary(lastMessageAtMs: number): boolean {
    const now = new Date();
    const lastMsg = new Date(lastMessageAtMs);

    // If they're in the same "agent day", no boundary crossed
    const lastDay = this.getAgentDay(lastMsg);
    const currentDay = this.getAgentDay(now);
    return lastDay !== currentDay;
  }

  /**
   * Get the "agent day" for a timestamp using the configured timezone.
   * An agent day starts at dayBoundaryHour (e.g., 04:00).
   * So 2026-04-02 03:59 is still day 2026-04-01,
   * but 2026-04-02 04:00 is day 2026-04-02.
   */
  private getAgentDay(date: Date): string {
    const tz = this.config.timezone || undefined;
    const local = nowInTimezone(tz, date);
    let { year, month, day } = local;
    if (local.hours < this.config.dayBoundaryHour) {
      // Before boundary: still previous agent day — shift back one day
      const shifted = new Date(date);
      shifted.setDate(shifted.getDate() - 1);
      const prev = nowInTimezone(tz, shifted);
      year = prev.year;
      month = prev.month;
      day = prev.day;
    }
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  // ── DM conversation log (session-independent) ──

  /**
   * Get all DM messages since the last summary, across all sessions.
   * Grouped by platform. Does NOT touch session status.
   */
  getUnsummarizedDmMessages(platform: string): {
    role: string;
    content: string;
    timestamp: string;
    metadata: string | null;
  }[] {
    // Find the timestamp of the last summary for this platform
    const lastLog = this.db
      .prepare(
        `SELECT created_at FROM dm_conversation_log
         WHERE scope = 'owner_dm' AND scope_key = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(platform) as { created_at: string } | undefined;

    const since = lastLog?.created_at ?? "1970-01-01 00:00:00";

    return this.db
      .prepare(
        `SELECT m.role, m.content, m.timestamp, m.metadata FROM messages m
         JOIN conversation_sessions s ON m.session_id = s.id
         WHERE s.scope = ? AND s.scope_key = ? AND m.timestamp > ?
         ORDER BY m.timestamp ASC`,
      )
      .all(OWNER_DM_SCOPE, platform, since) as {
        role: string;
        content: string;
        timestamp: string;
        metadata: string | null;
      }[];
  }

  /** Get the list of platforms that have DM sessions with messages since last summary */
  getDmPlatformsWithNewMessages(): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT s.scope_key AS platform FROM conversation_sessions s
         JOIN messages m ON m.session_id = s.id
         WHERE s.scope = 'owner_dm'
         GROUP BY s.scope_key
         HAVING MAX(m.timestamp) > COALESCE(
           (
             SELECT MAX(created_at)
             FROM dm_conversation_log
             WHERE scope = 'owner_dm' AND scope_key = s.scope_key
           ),
           '1970-01-01 00:00:00'
         )`,
      )
      .all() as { platform: string }[];
    return rows.map((r) => r.platform);
  }

  /** Get the previous rolling summary for a platform */
  getPreviousDmSummary(platform: string): string | null {
    const row = this.db
      .prepare(
        `SELECT summary FROM dm_conversation_log
         WHERE scope = 'owner_dm' AND scope_key = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(platform) as { summary: string } | undefined;
    return row?.summary ?? null;
  }

  /** Store a new rolling summary */
  saveDmSummary(platform: string, summary: string, messageCount: number): void {
    this.db
      .prepare(
        `INSERT INTO dm_conversation_log (platform, scope, scope_key, summary, message_count)
         VALUES (?, 'owner_dm', ?, ?, ?)`,
      )
      .run(platform, platform, summary, messageCount);
  }

}
