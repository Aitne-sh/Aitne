import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { redactSensitiveString } from "@aitne/shared";
import { createLogger } from "../../logging.js";
import type { EncryptedBlobStore } from "../../secrets/encrypted-blob-store.js";
import type {
  AuthStatus,
  MailAccount,
  MailAccountHealth,
  MailProvider,
  MailProviderKind,
  PollCursor,
} from "./provider.js";
import { mailAccountBlobName } from "./provider.js";
import {
  parseCapabilitiesJson,
  serializeCapabilities,
  type ImapCapabilitySet,
} from "./imap/capabilities.js";

const logger = createLogger("mail-account-registry");

interface MailAccountRow {
  id: string;
  kind: string;
  email: string;
  label: string | null;
  auth_type: string;
  auth_status: string;
  secret_blob_name: string;
  poll_interval_seconds: number;
  idle_enabled: number;
  idle_fallback_until: string | null;
  unified_poll: number;
  active: number;
  created_at_utc: string;
  last_error: string | null;
  last_error_at_utc: string | null;
  last_poll_at_utc: string | null;
  consecutive_error_count: number;
  imap_capabilities_json: string | null;
}

const VALID_KINDS: readonly MailProviderKind[] = [
  "gmail",
  "outlook",
  "yahoo",
  "icloud",
];

const VALID_STATUSES: readonly AuthStatus[] = [
  "healthy",
  "requires_consent",
  "degraded",
];

export function parseMailAccountRow(row: MailAccountRow): MailAccount {
  if (!VALID_KINDS.includes(row.kind as MailProviderKind)) {
    throw new Error(`Invalid mail_accounts.kind: ${row.kind}`);
  }
  if (!VALID_STATUSES.includes(row.auth_status as AuthStatus)) {
    throw new Error(`Invalid mail_accounts.auth_status: ${row.auth_status}`);
  }
  return {
    id: row.id,
    kind: row.kind as MailProviderKind,
    email: row.email,
    label: row.label ?? undefined,
    authStatus: row.auth_status as AuthStatus,
    idleEnabled: row.idle_enabled === 1,
    active: row.active === 1,
    createdAt: row.created_at_utc,
  };
}

export function parseMailAccountHealth(row: MailAccountRow): MailAccountHealth {
  return {
    accountId: row.id,
    lastPollAtUtc: row.last_poll_at_utc,
    lastError: row.last_error,
    lastErrorAtUtc: row.last_error_at_utc,
    consecutiveErrorCount: row.consecutive_error_count,
    idleFallbackUntilUtc: row.idle_fallback_until,
  };
}

export interface ScopeGateInput {
  kind: MailProviderKind;
  active: boolean;
  authStatus: AuthStatus;
  unifiedPoll: boolean;
}

/**
 * Pure scope-gate predicate (§3.2).
 *
 * The unified mail-poller and pre-materialized skill must only surface
 * accounts matching ALL four conditions. Legacy gmail rows (unifiedPoll=false)
 * pass through the legacy poller path and are intentionally excluded from the
 * unified set to avoid double-polling.
 */
export function passesScopeGate(
  input: ScopeGateInput,
  enabledKinds: readonly MailProviderKind[],
): boolean {
  return (
    enabledKinds.includes(input.kind) &&
    input.active &&
    input.authStatus === "healthy" &&
    input.unifiedPoll
  );
}

export interface AddAccountInput {
  kind: MailProviderKind;
  email: string;
  label?: string;
  authType: "oauth" | "app_password";
  secretPayload: string;
  idleEnabled?: boolean;
  pollIntervalSeconds?: number;
  unifiedPoll?: boolean;
  /**
   * Capabilities captured at account-add smoke-test time (IMAP providers
   * only). Persisted immediately so Phase 7 readers never see a NULL
   * capability column on freshly-added rows — the runtime probe re-captures
   * on first live connect, which is a no-op since capabilities are stable.
   */
  capabilities?: ImapCapabilitySet;
}

export class ProviderNotEnabledError extends Error {
  readonly code = "provider_not_enabled";
  constructor(kind: MailProviderKind) {
    super(`Mail provider not enabled: ${kind}`);
    this.name = "ProviderNotEnabledError";
  }
}

export class ProviderNotImplementedError extends Error {
  readonly code = "provider_not_implemented";
  constructor(kind: MailProviderKind) {
    super(`Mail provider implementation not available yet: ${kind}`);
    this.name = "ProviderNotImplementedError";
  }
}

export class DuplicateAccountError extends Error {
  readonly code = "duplicate_account";
  constructor(kind: MailProviderKind, email: string) {
    super(`Mail account already exists for ${kind}:${email}`);
    this.name = "DuplicateAccountError";
  }
}

/** Context passed to provider factories. Holds the per-account abort signal so
 *  the provider can cancel in-flight I/O when removeAccount / disable fires. */
export interface MailProviderFactoryContext {
  signal: AbortSignal;
}

export type MailProviderFactory = (
  account: MailAccount,
  ctx: MailProviderFactoryContext,
) => MailProvider | Promise<MailProvider>;

/**
 * Reason codes emitted by {@link MailAccountRegistryOptions.onScopeChanged}.
 * Mirrored by the session-workdir refresh handler so logs can correlate a
 * mutation to its downstream effect.
 */
export type MailScopeChangeReason =
  | "account_added"
  | "account_removed"
  | "account_activated"
  | "account_deactivated"
  | "account_reauthed"
  | "auth_status_recovered"
  | "auth_status_degraded"
  | "enabled_providers_changed";

export interface MailAccountRegistryOptions {
  db: Database.Database;
  blobStore: EncryptedBlobStore;
  getEnabledKinds: () => readonly MailProviderKind[];
  /**
   * Per-kind factories for instantiating live MailProvider instances. Wired
   * by index.ts as the provider dependencies (shared Google OAuth, MSAL,
   * ImapFlow) become available.
   */
  providerFactories?: Partial<Record<MailProviderKind, MailProviderFactory>>;
  now?: () => Date;
  /**
   * Fires AFTER a mutation that changes the set of accounts passing the
   * scope gate (`listActiveAccounts()`). Single source of truth — so route
   * handlers cannot forget to notify. Only non-trivial transitions fire:
   * - `setActive` only when the active bit actually changes.
   * - `updateAuthStatus` only when crossing the healthy / non-healthy
   *   boundary (so repeated degraded→requires_consent reclassifications
   *   don't spam).
   * - `onProviderSelectionChanged` only when `newKinds` differs from the
   *   previous kind set.
   * Synchronous and best-effort. Throws are caught and logged; they never
   * interrupt the mutation.
   */
  onScopeChanged?: (reason: MailScopeChangeReason) => void;
}

interface SqliteErrorLike {
  code?: string;
}

/* v8 ignore next 5 — only reachable from TOCTOU catch block below; early duplicate check (line ~292) prevents this in single-threaded tests */
function isUniqueConstraintError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as SqliteErrorLike).code;
  return code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT";
}

/**
 * Owns the set of configured mail accounts: DB rows, secret blobs, and live
 * MailProvider instances. The provider cache is lazy and per-accountId.
 *
 * Per §3.2 each accountId owns an AbortController so {@link removeAccount}
 * can cancel in-flight polls before tearing down credentials.
 */
export class MailAccountRegistry {
  private readonly db: Database.Database;
  private readonly blobStore: EncryptedBlobStore;
  private readonly getEnabledKinds: () => readonly MailProviderKind[];
  private readonly providerFactories: Partial<Record<MailProviderKind, MailProviderFactory>>;
  private readonly now: () => Date;
  private readonly onScopeChanged: (reason: MailScopeChangeReason) => void;
  private readonly mutexes = new Map<string, Promise<unknown>>();
  private readonly providerCache = new Map<string, MailProvider>();
  private readonly abortControllers = new Map<string, AbortController>();
  /** Last kinds set passed to onProviderSelectionChanged, for no-op elision. */
  private lastAnnouncedKinds: ReadonlySet<MailProviderKind> | null = null;

  constructor(options: MailAccountRegistryOptions) {
    this.db = options.db;
    this.blobStore = options.blobStore;
    this.getEnabledKinds = options.getEnabledKinds;
    this.providerFactories = options.providerFactories ?? {};
    this.now = options.now ?? (() => new Date());
    // Wrap the user callback so a throwing observer can never break a
    // mutation — mail operations must succeed even if the refresh hook
    // is misbehaving.
    const userHook = options.onScopeChanged;
    this.onScopeChanged = userHook
      ? (reason) => {
          try {
            userHook(reason);
          } catch {
            // Swallowed intentionally. Callers log inside their handlers.
          }
        }
      : () => undefined;
  }

  listAccounts(): MailAccount[] {
    const rows = this.db
      .prepare(`SELECT * FROM mail_accounts ORDER BY created_at_utc ASC`)
      .all() as MailAccountRow[];
    return rows.map(parseMailAccountRow);
  }

  listActiveAccounts(): MailAccount[] {
    const enabled = this.getEnabledKinds();
    const rows = this.db
      .prepare(`SELECT * FROM mail_accounts ORDER BY created_at_utc ASC`)
      .all() as MailAccountRow[];
    return rows
      .filter((row) =>
        passesScopeGate(
          {
            kind: row.kind as MailProviderKind,
            active: row.active === 1,
            authStatus: row.auth_status as AuthStatus,
            unifiedPoll: row.unified_poll === 1,
          },
          enabled,
        ),
      )
      .map(parseMailAccountRow);
  }

  getAccount(accountId: string): MailAccount | null {
    const row = this.db
      .prepare(`SELECT * FROM mail_accounts WHERE id = ?`)
      .get(accountId) as MailAccountRow | undefined;
    return row ? parseMailAccountRow(row) : null;
  }

  getHealth(accountId: string): MailAccountHealth | null {
    const row = this.db
      .prepare(`SELECT * FROM mail_accounts WHERE id = ?`)
      .get(accountId) as MailAccountRow | undefined;
    return row ? parseMailAccountHealth(row) : null;
  }

  /**
   * Returns the current abort signal for an account. The controller is
   * created lazily so callers (providers, pollers) always get a live signal
   * even for accounts that haven't been touched yet. `removeAccount` aborts
   * and drops the controller; the next caller mints a fresh one.
   */
  getAbortSignal(accountId: string): AbortSignal {
    return this.getOrCreateAbortController(accountId).signal;
  }

  private getOrCreateAbortController(accountId: string): AbortController {
    const existing = this.abortControllers.get(accountId);
    if (existing && !existing.signal.aborted) return existing;
    const controller = new AbortController();
    this.abortControllers.set(accountId, controller);
    return controller;
  }

  async addAccount(input: AddAccountInput): Promise<MailAccount> {
    // Auth-then-enable flow (UI v2): registration is allowed regardless of
    // `enabledMailProviders` — the kind being absent only means the account
    // sits dormant. Operation routes (read/send) and the unified poller
    // both gate on `enabledMailProviders` independently via `passesScopeGate`,
    // so a dormant kind cannot be observed or written. Letting the user
    // authenticate first matches the dashboard UX where the per-card Enable
    // toggle becomes interactive only after a successful auth.
    //
    if (!this.providerFactories[input.kind]) {
      throw new ProviderNotImplementedError(input.kind);
    }

    // Early duplicate check so the caller gets DuplicateAccountError instead
    // of leaking an SQLITE_CONSTRAINT from the INSERT below.
    const existing = this.db
      .prepare(`SELECT id FROM mail_accounts WHERE kind = ? AND email = ?`)
      .get(input.kind, input.email) as { id: string } | undefined;
    if (existing) {
      throw new DuplicateAccountError(input.kind, input.email);
    }

    const id = `${input.kind}-${randomSuffix()}`;
    const blobName = mailAccountBlobName(input.kind, id);
    await this.blobStore.writeUtf8(blobName, input.secretPayload);

    const createdAt = this.now().toISOString();
    try {
      // Account resolution is context-driven at the skill layer; the
      // schema has no is_primary column, so the INSERT column set
      // intentionally never mentions it.
      this.db
        .prepare(
          `INSERT INTO mail_accounts (
             id, kind, email, label, auth_type, auth_status,
             secret_blob_name, poll_interval_seconds, idle_enabled,
             unified_poll, active, created_at_utc, imap_capabilities_json
           ) VALUES (?, ?, ?, ?, ?, 'healthy', ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          id,
          input.kind,
          input.email,
          input.label ?? null,
          input.authType,
          blobName,
          input.pollIntervalSeconds ?? 300,
          input.idleEnabled ? 1 : 0,
          input.unifiedPoll === false ? 0 : 1,
          createdAt,
          input.capabilities ? serializeCapabilities(input.capabilities) : null,
        );
    } catch (error) {
      /* v8 ignore next 5 — concurrent insert race: early duplicate check prevents this in tests */
      await this.blobStore.remove(blobName);
      if (isUniqueConstraintError(error)) {
        throw new DuplicateAccountError(input.kind, input.email);
      }
      throw error;
    }

    const row = this.db
      .prepare(`SELECT * FROM mail_accounts WHERE id = ?`)
      .get(id) as MailAccountRow;
    const account = parseMailAccountRow(row);
    this.onScopeChanged("account_added");
    return account;
  }

  async removeAccount(accountId: string): Promise<boolean> {
    return this.withMutex(accountId, async () => {
      const row = this.db
        .prepare(`SELECT * FROM mail_accounts WHERE id = ?`)
        .get(accountId) as MailAccountRow | undefined;
      if (!row) return false;

      // (1) Cancel in-flight polls per §3.2 so pending Graph/IMAP fetches
      // error out before we revoke tokens and delete the blob.
      const controller = this.abortControllers.get(accountId);
      if (controller) {
        controller.abort();
        this.abortControllers.delete(accountId);
      }

      // (2) Best-effort revoke before tearing down state. Failures here must
      // not block deletion — the user already asked to remove the account.
      const cached = this.providerCache.get(accountId);
      if (cached) {
        try {
          await cached.revoke();
        } catch {
          // swallowed — token already expired or network down
        }
        this.providerCache.delete(accountId);
      }

      this.db
        .prepare(`DELETE FROM mail_accounts WHERE id = ?`)
        .run(accountId);
      // Best-effort blob teardown — the row is already gone, so the secret
      // is no longer reachable. A failure here only orphans bytes on disk.
      // Log so operators can clean up manually if it ever happens.
      try {
        await this.blobStore.remove(row.secret_blob_name);
      } catch (err) {
        logger.warn(
          { err, accountId, blobName: row.secret_blob_name },
          "Failed to remove secret blob after account delete (orphaned)",
        );
      }
      this.onScopeChanged("account_removed");
      return true;
    });
  }

  /**
   * Replace the on-disk secret for an existing IMAP (app-password) account
   * — used when the user rotates their Yahoo / iCloud app password and the
   * account has flipped to `requires_consent`. The secret blob is overwritten
   * in place (same name) so the account ID and poll cursor survive intact;
   * the cached provider is evicted so the next poll opens a fresh IMAP
   * session with the new credentials.
   *
   * Caller is responsible for verifying the new credentials against the IMAP
   * server before calling — this method does not re-validate.
   */
  async refreshImapSecret(
    accountId: string,
    secretPayload: string,
    capabilities?: ImapCapabilitySet,
  ): Promise<MailAccount | null> {
    return this.withMutex(accountId, async () => {
      const row = this.db
        .prepare(`SELECT * FROM mail_accounts WHERE id = ?`)
        .get(accountId) as MailAccountRow | undefined;
      if (!row) return null;
      if (row.auth_type !== "app_password") {
        throw new Error(
          `refreshImapSecret only supports app_password accounts (got ${row.auth_type})`,
        );
      }
      // Cancel any in-flight poll so it doesn't race with the secret swap.
      const controller = this.abortControllers.get(accountId);
      if (controller) {
        controller.abort();
        this.abortControllers.delete(accountId);
      }
      // Drop the cached provider so the next poll opens a fresh IMAP session
      // with the rotated credentials. revoke() is a no-op for IMAP.
      const cached = this.providerCache.get(accountId);
      if (cached) {
        try {
          await cached.revoke();
        } catch {
          // best-effort teardown
        }
        this.providerCache.delete(accountId);
      }

      await this.blobStore.writeUtf8(row.secret_blob_name, secretPayload);

      const updateTxn = this.db.transaction(() => {
        this.db
          .prepare(
            `UPDATE mail_accounts
                SET auth_status = 'healthy',
                    consecutive_error_count = 0,
                    last_error = NULL,
                    last_error_at_utc = NULL
              WHERE id = ?`,
          )
          .run(accountId);
        if (capabilities) {
          this.db
            .prepare(
              `UPDATE mail_accounts SET imap_capabilities_json = ? WHERE id = ?`,
            )
            .run(serializeCapabilities(capabilities), accountId);
        }
      });
      updateTxn();

      const updated = this.db
        .prepare(`SELECT * FROM mail_accounts WHERE id = ?`)
        .get(accountId) as MailAccountRow;
      const wasHealthy = row.auth_status === "healthy";
      this.onScopeChanged(
        wasHealthy ? "account_reauthed" : "auth_status_recovered",
      );
      return parseMailAccountRow(updated);
    });
  }

  async setActive(accountId: string, active: boolean): Promise<MailAccount | null> {
    return this.withMutex(accountId, async () => {
      // Read the current value so we can skip the scope-changed notification
      // on idempotent calls. The SQL UPDATE below reports `changes > 0` even
      // when the value didn't change (SQLite counts matched rows), so we need
      // a pre-read to distinguish a genuine flip from a no-op request.
      const before = this.db
        .prepare(`SELECT active FROM mail_accounts WHERE id = ?`)
        .get(accountId) as { active: number } | undefined;
      if (!before) return null;
      const wasActive = before.active === 1;
      const result = this.db
        .prepare(`UPDATE mail_accounts SET active = ? WHERE id = ?`)
        .run(active ? 1 : 0, accountId);
      if (result.changes === 0) return null;
      // Disabling an account should shed the cached provider so it does not
      // retain live MSAL/IMAP sessions. Re-enabling simply lazily rebuilds.
      if (!active) {
        const controller = this.abortControllers.get(accountId);
        if (controller) {
          controller.abort();
          this.abortControllers.delete(accountId);
        }
        const cached = this.providerCache.get(accountId);
        if (cached) {
          try {
            await cached.revoke();
          } catch {
            // Disabling should still succeed if provider teardown fails.
          }
          this.providerCache.delete(accountId);
        }
      }
      const row = this.db
        .prepare(`SELECT * FROM mail_accounts WHERE id = ?`)
        .get(accountId) as MailAccountRow;
      if (wasActive !== active) {
        this.onScopeChanged(active ? "account_activated" : "account_deactivated");
      }
      return parseMailAccountRow(row);
    });
  }

  /**
   * Atomic auth-status flip. Use the {@link effectiveAuthStatus} pure helper
   * (auth-failure-classifier.ts) to decide what status to pass in.
   *
   * Fires `onScopeChanged` ONLY when crossing the `healthy` boundary
   * (healthy → non-healthy or vice versa). Reclassifying within the
   * non-healthy space (e.g. `degraded` → `requires_consent`) does not
   * change scope-gate membership, so no notification.
   */
  updateAuthStatus(
    accountId: string,
    status: AuthStatus,
    lastError?: string | null,
  ): boolean {
    const nowIso = this.now().toISOString();
    const before = this.db
      .prepare(`SELECT auth_status FROM mail_accounts WHERE id = ?`)
      .get(accountId) as { auth_status: string } | undefined;
    const result = this.db
      .prepare(
        `UPDATE mail_accounts
            SET auth_status = ?, last_error = ?, last_error_at_utc = ?
          WHERE id = ?`,
      )
      .run(status, lastError != null ? redactSensitiveString(lastError) : null, lastError === undefined ? null : nowIso, accountId);
    if (result.changes > 0 && before) {
      const wasHealthy = before.auth_status === "healthy";
      const isHealthy = status === "healthy";
      if (wasHealthy && !isHealthy) {
        this.onScopeChanged("auth_status_degraded");
      } else if (!wasHealthy && isHealthy) {
        this.onScopeChanged("auth_status_recovered");
      }
    }
    return result.changes > 0;
  }

  /**
   * Bookkeeping after a poll tick. `success=true` resets
   * `consecutive_error_count` to 0 and clears `last_error`.
   * `success=false` increments the counter and records the error.
   */
  recordPollTick(
    accountId: string,
    outcome: { success: true } | { success: false; error: string },
  ): boolean {
    const nowIso = this.now().toISOString();
    if (outcome.success) {
      const result = this.db
        .prepare(
          `UPDATE mail_accounts
              SET last_poll_at_utc = ?, consecutive_error_count = 0,
                  last_error = NULL, last_error_at_utc = NULL
            WHERE id = ?`,
        )
        .run(nowIso, accountId);
      return result.changes > 0;
    }
    const result = this.db
      .prepare(
        `UPDATE mail_accounts
            SET last_poll_at_utc = ?,
                last_error = ?, last_error_at_utc = ?,
                consecutive_error_count = consecutive_error_count + 1
          WHERE id = ?`,
      )
      .run(nowIso, redactSensitiveString(outcome.error), nowIso, accountId);
    return result.changes > 0;
  }

  getConsecutiveErrorCount(accountId: string): number {
    const row = this.db
      .prepare(`SELECT consecutive_error_count FROM mail_accounts WHERE id = ?`)
      .get(accountId) as { consecutive_error_count: number } | undefined;
    return row?.consecutive_error_count ?? 0;
  }

  /**
   * Persist the CAPABILITY probe for an account (§3 Phase 4). The provider
   * calls this fire-and-forget on first connect; the row may not exist if the
   * account was removed mid-connect, in which case the UPDATE is a no-op.
   */
  updateCapabilities(
    accountId: string,
    capabilities: ImapCapabilitySet,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE mail_accounts SET imap_capabilities_json = ? WHERE id = ?`,
      )
      .run(serializeCapabilities(capabilities), accountId);
    return result.changes > 0;
  }

  getCapabilities(accountId: string): ImapCapabilitySet | null {
    const row = this.db
      .prepare(`SELECT imap_capabilities_json FROM mail_accounts WHERE id = ?`)
      .get(accountId) as { imap_capabilities_json: string | null } | undefined;
    return parseCapabilitiesJson(row?.imap_capabilities_json ?? null);
  }

  loadPollCursor(accountId: string): PollCursor | null {
    const row = this.db
      .prepare(`SELECT poll_cursor_json FROM mail_accounts WHERE id = ?`)
      .get(accountId) as { poll_cursor_json: string | null } | undefined;
    if (!row?.poll_cursor_json) return null;
    try {
      return JSON.parse(row.poll_cursor_json) as PollCursor;
    } catch {
      return null;
    }
  }

  savePollCursor(accountId: string, cursor: PollCursor): boolean {
    const result = this.db
      .prepare(`UPDATE mail_accounts SET poll_cursor_json = ? WHERE id = ?`)
      .run(JSON.stringify(cursor), accountId);
    return result.changes > 0;
  }

  /**
   * Lazy provider lookup. Caches per accountId. Throws
   * {@link ProviderNotImplementedError} if no factory is registered.
   */
  peekProvider(accountId: string): MailProvider | null {
    return this.providerCache.get(accountId) ?? null;
  }

  async getProvider(accountId: string): Promise<MailProvider | null> {
    const cached = this.providerCache.get(accountId);
    if (cached) return cached;

    const account = this.getAccount(accountId);
    if (!account) return null;

    const factory = this.providerFactories[account.kind];
    if (!factory) {
      throw new ProviderNotImplementedError(account.kind);
    }
    const signal = this.getOrCreateAbortController(accountId).signal;
    const provider = await factory(account, { signal });
    this.providerCache.set(accountId, provider);
    return provider;
  }

  /** Drop a cached provider — used after auth failures so the next call rebuilds the MSAL/IMAP client fresh. */
  evictProvider(accountId: string): void {
    this.providerCache.delete(accountId);
  }

  /**
   * Scope-gate change hook (§6.0). Phase 2 evicts cached providers for kinds
   * leaving the enabled set so polling stops. Pollers also re-check on each
   * tick via {@link listActiveAccounts}, so this is best-effort acceleration.
   *
   * Fires `onScopeChanged` only when `newKinds` differs from the last
   * announced set (by membership, order-independent). Idempotent calls
   * (e.g. PATCH /mail/providers with the same enabledKinds) are silent.
   */
  onProviderSelectionChanged(newKinds: readonly MailProviderKind[]): void {
    const enabled = new Set(newKinds);
    for (const [accountId, provider] of this.providerCache) {
      if (!enabled.has(provider.kind)) {
        const controller = this.abortControllers.get(accountId);
        if (controller) {
          controller.abort();
          this.abortControllers.delete(accountId);
        }
        this.providerCache.delete(accountId);
      }
    }
    const changed =
      this.lastAnnouncedKinds === null ||
      this.lastAnnouncedKinds.size !== enabled.size ||
      [...enabled].some((k) => !this.lastAnnouncedKinds!.has(k));
    this.lastAnnouncedKinds = enabled;
    if (changed) {
      this.onScopeChanged("enabled_providers_changed");
    }
  }

  private async withMutex<T>(
    key: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = this.mutexes.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tracked = next.catch(() => undefined);
    this.mutexes.set(key, tracked);
    try {
      return (await next) as T;
    } finally {
      if (this.mutexes.get(key) === tracked) {
        this.mutexes.delete(key);
      }
    }
  }
}

function randomSuffix(): string {
  // crypto.randomUUID() — 128-bit collision-resistant identifier. Previously
  // used Math.random().toString(36) which is non-cryptographic and gave only
  // ~41 bits of entropy for a secret-blob filename.
  return randomUUID().replace(/-/g, "").slice(0, 12);
}
