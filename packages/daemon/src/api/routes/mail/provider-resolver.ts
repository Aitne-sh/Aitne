import type { Context } from "hono";
import {
  type IntegrationKey,
} from "@aitne/shared";
import { readIntegrations } from "../../../db/integrations-store.js";
import { markIntegrationWrite } from "../../../safety/integration-write-tracker.js";
import type { MailProvider } from "../../../services/mail/provider.js";
import { ProviderNotImplementedError } from "../../../services/mail/account-registry.js";
import { createLogger } from "../../../logging.js";
import { composeIssue, respondWithAgentError } from "../../helpers/agent-errors.js";
import {
  gatedIntegrationForKind,
  gatedMailIntegrationResponse,
} from "./gating.js";
import type { MailRouteDependencies } from "./dependencies.js";

const logger = createLogger("mail-api");

/** Lower bound on the §C6 agent-write-attribution TTL. Covers the common
 *  case where the poll interval is short (default 180s) — we still want
 *  enough slack for a user action that triggered the send to settle before
 *  the next poll picks it up. Real TTL scales with the configured poll
 *  interval (see {@link computeAgentWriteTtlMs}). */
const MAIL_AGENT_WRITE_TTL_FLOOR_MS = 5 * 60 * 1000;

/** The poll-interval multiplier. Two ticks of slack means: a send at T=0
 *  survives the T=poll and T=2*poll ticks before the mark expires —
 *  enough to absorb one missed/delayed tick without losing attribution. */
const MAIL_AGENT_WRITE_TTL_POLL_MULTIPLIER = 2;

export function computeAgentWriteTtlMs(
  pollIntervalSeconds: number | undefined,
): number {
  const derived =
    (pollIntervalSeconds ?? 0) * 1000 * MAIL_AGENT_WRITE_TTL_POLL_MULTIPLIER;
  return Math.max(MAIL_AGENT_WRITE_TTL_FLOOR_MS, derived);
}

export type ResolveProviderResult =
  | { ok: true; provider: MailProvider }
  | {
      ok: false;
      status: 404 | 400 | 410 | 501 | 503;
      code: string;
      message: string;
      detail?: "kind_not_enabled" | "account_inactive" | "account_unhealthy";
      integration?: IntegrationKey;
      backend?: string | null;
      // INTEGRATION_NATIVE_MODE_DESIGN.md §9.2 — carries the gated mode
      // through to `renderResolveError`. `undefined` for non-410
      // outcomes (where the field is not surfaced in the body).
      mode?: "delegated" | "native";
    };

/**
 * Build the agent-consumable 501 response for an operation the resolved
 * provider doesn't implement (e.g. IMAP can't manage drafts). The legacy
 * shape `{ error: "not_implemented", message: "<op> not supported on <kind>" }`
 * is preserved via legacyFields so existing tests keep matching.
 */
export function notImplementedResponse(
  c: Context,
  operation: string,
  providerKind: string,
): Response {
  const message = `${operation} not supported on ${providerKind}`;
  return respondWithAgentError(c, 501, [
    composeIssue("mail.not_implemented", {
      field: `provider.${operation}`,
      received: providerKind,
      hint: `${message}. Try a Gmail or Outlook account, or use a different operation.`,
    }),
  ], { legacyFields: { message } });
}

export function providerError(c: Context, err: unknown, tag: string): Response {
  const message = err instanceof Error ? err.message : String(err);
  // Classify common provider errors where a 404 from the backend should not
  // become a 500 for the caller. The Graph client throws GraphError with a
  // httpStatus field; the IMAP layer throws Error with a responseCode.
  const candidate = err as {
    httpStatus?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };
  const status =
    pickNumber(candidate.httpStatus) ??
    pickNumber(candidate.statusCode) ??
    pickNumber(candidate.response?.status);
  if (status === 404) {
    return respondWithAgentError(c, 404, [
      composeIssue("mail.account_not_found", {
        field: tag,
        received: message,
        hint: `Provider returned 404 for ${tag}. The resource (message, thread, label, draft) may have been deleted or the id is wrong. Re-fetch to verify.`,
      }),
    ], { legacyFields: { message } });
  }
  if (status === 501) {
    // Providers throw MailOperationNotSupportedError (httpStatus=501) when a
    // sub-case of an implemented method is out of scope — e.g. IMAP draft
    // writes. Map to the same shape as the missing-method-on-interface path
    // so callers can't distinguish the two (both mean "don't retry here").
    return respondWithAgentError(c, 501, [
      composeIssue("mail.not_implemented", {
        field: tag,
        received: message,
        hint: `Provider returned 501 for ${tag} — operation outside the implemented sub-case. Stop retrying; either try a different operation or pick a different provider.`,
      }),
    ], { legacyFields: { message } });
  }
  if (status === 401 || status === 403) {
    return respondWithAgentError(c, 502, [
      composeIssue("mail.provider_auth_error", {
        field: tag,
        received: message,
      }),
    ], { legacyFields: { message } });
  }
  logger.error({ err, tag }, `mail route failure: ${tag}`);
  return respondWithAgentError(c, 500, [
    composeIssue("mail.upstream_error", {
      field: tag,
      received: message,
      hint: `Mail provider ${tag} failed. Read the message verbatim. Transient 5xx may resolve after 30s; otherwise notify the user.`,
    }),
  ], { legacyErrorCode: tag, legacyFields: { message } }) as unknown as Response;
}

function pickNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export type ProviderResolver = ReturnType<typeof createProviderResolver>;

/**
 * Builds the shared per-account access surface used by every handler that
 * proxies to a live MailProvider. Owns three concerns that have to stay in
 * lockstep:
 *   1. resolveProvider — kind/active/auth scope-gate + §4.8 / §9.2
 *      integration-mode gate. Single chokepoint so the recovery endpoints
 *      that intentionally bypass it (POST /config/mail/app-password/:id/refresh)
 *      stay obvious.
 *   2. renderResolveError — maps the resolveProvider failure shape to an
 *      HTTP response. The 410 branch carries §4.5.2 / §9.2 body shape so
 *      dashboard + agent tooling can detect the gated-mode surface
 *      uniformly.
 *   3. agent-write attribution — markAgentWrite / markAgentWriteRfc822 /
 *      markGmailIntegrationWrite so the unified poller suppresses what
 *      the agent just touched (§3.2 + INTEGRATION-DRIFT-DETECTION-PLAN.md §11).
 */
export function createProviderResolver(deps: MailRouteDependencies) {
  const resolveProvider = async (
    accountId: string,
  ): Promise<ResolveProviderResult> => {
    const registry = deps.services.mail;
    if (!registry) {
      return {
        ok: false,
        status: 503,
        code: "mail_not_configured",
        message: "Mail registry unavailable.",
      };
    }
    const account = registry.getAccount(accountId);
    if (!account) {
      return {
        ok: false,
        status: 404,
        code: "not_found",
        message: `No mail account ${accountId}`,
      };
    }
    // §4.8 per-account mode gate. The route-gate middleware cannot
    // blanket 410 `/api/mail/*` because it would also stop direct-only
    // providers (iCloud, Yahoo, IMAP). Instead, accounts whose kind maps
    // to a gated integration (Gmail → gmail; Outlook → outlook_mail)
    // return 410 when that integration is in `delegated` or `native`
    // mode. Per INTEGRATION_NATIVE_MODE_DESIGN.md §9.2 the gate widened
    // from delegated-only so the agent gets a consistent redirect
    // signal when Outlook is flipped to native (user-managed MCP).
    // `disabled` accounts are filtered at the data path (poller) — see
    // `gatedMailIntegrationResponse` for why we do not gate them here.
    const gatedIntegrationKey = gatedIntegrationForKind(account.kind);
    if (gatedIntegrationKey) {
      const state = readIntegrations(deps.db)[gatedIntegrationKey];
      const gateResponse = gatedMailIntegrationResponse(
        gatedIntegrationKey,
        state,
      );
      if (gateResponse !== null) {
        return {
          ok: false,
          status: 410,
          code: gateResponse.error,
          message: gateResponse.message,
          integration: gateResponse.integration,
          backend: gateResponse.backend,
          mode: gateResponse.mode,
        };
      }
    }
    // Single scope-gate check mirroring `passesScopeGate` used by the
    // unified poller and `accounts.md` materialization. Clients get one
    // error shape (`provider_not_enabled`) with a machine-readable `detail`
    // field so dashboards can render a specific prompt without having to
    // branch on three near-synonymous codes.
    //
    // Recovery endpoints (`POST /config/mail/app-password/:id/refresh`)
    // intentionally bypass this gate by reading the account directly — users
    // MUST be able to fix a degraded account. If you add new recovery flows,
    // keep that property: never route recovery through `resolveProvider`.
    const detail:
      | "kind_not_enabled"
      | "account_inactive"
      | "account_unhealthy"
      | null = !deps.config.enabledMailProviders.includes(account.kind)
      ? "kind_not_enabled"
      : !account.active
        ? "account_inactive"
        : account.authStatus !== "healthy"
          ? "account_unhealthy"
          : null;
    if (detail !== null) {
      const detailMessages: Record<typeof detail & string, string> = {
        kind_not_enabled: `${account.kind} is not in enabledMailProviders.`,
        account_inactive: `Mail account ${accountId} is disabled.`,
        account_unhealthy: `Mail account ${accountId} requires re-auth (status: ${account.authStatus}).`,
      };
      return {
        ok: false,
        status: 400,
        code: "provider_not_enabled",
        message: detailMessages[detail],
        detail,
      };
    }
    try {
      const provider = await registry.getProvider(accountId);
      if (!provider) {
        return {
          ok: false,
          status: 501,
          code: "provider_not_implemented",
          message: `Provider ${account.kind} is not wired up.`,
        };
      }
      return { ok: true, provider };
    } catch (err) {
      if (err instanceof ProviderNotImplementedError) {
        return {
          ok: false,
          status: 501,
          code: err.code,
          message: err.message,
        };
      }
      throw err;
    }
  };

  /**
   * Render a `resolveProvider` failure as an HTTP response. The 410
   * branch carries the §4.5.2 / §9.2 body shape (integration, backend,
   * mode) so the dashboard and agent tooling can uniformly detect a
   * gated-mode surface regardless of whether the path was caught by the
   * global route-gate middleware (§4.5.2) or the per-account gate here
   * (§4.8 + §9.2 native widening). The mode field carries through from
   * `gatedMailIntegrationResponse`; falling back to "delegated"
   * preserves the legacy shape for any 410 outcomes that pre-dated the
   * native widening.
   */
  const renderResolveError = (
    c: Context,
    resolved: Extract<ResolveProviderResult, { ok: false }>,
  ) => {
    if (resolved.status === 410) {
      return c.json(
        {
          error: resolved.code,
          message: resolved.message,
          integration: resolved.integration ?? null,
          backend: resolved.backend ?? null,
          mode: resolved.mode ?? "delegated",
        },
        410,
      );
    }
    return c.json(
      {
        error: resolved.code,
        message: resolved.message,
        detail: resolved.detail,
      },
      resolved.status,
    );
  };

  // TTL is derived from the current poll interval so the tracker mark
  // outlives at least one poll tick (see computeAgentWriteTtlMs). Read at
  // mark-time — reflects a runtime PATCH /api/config without a restart.
  const writeTtlMs = (): number =>
    computeAgentWriteTtlMs(deps.config.mailPollIntervalSeconds);

  const markAgentWrite = (accountId: string, providerMsgId: string): void => {
    deps.writeTracker?.markWriting(
      `mail:${accountId}:${providerMsgId}`,
      undefined,
      { ttlMs: writeTtlMs() },
    );
  };

  // INTEGRATION-DRIFT-DETECTION-PLAN.md §11 Phase 4 — actor attribution
  // for the persistent `integration_writes` table. Only Gmail accounts
  // map to an `IntegrationKey` (per `gatedIntegrationForKind`); iCloud /
  // Outlook / Yahoo / IMAP have no integration descriptor and skip.
  // Each id passed here is marked under `(gmail, id)` for the Gmail
  // default TTL (30 min — see INTEGRATION_WRITE_TTL_MS). Non-Gmail
  // accounts return a no-op; the in-memory `markAgentWrite` above is the
  // only attribution surface for them.
  const markGmailIntegrationWrite = (
    accountId: string,
    ...providerIds: ReadonlyArray<string | null | undefined>
  ): void => {
    const registry = deps.services.mail;
    /* c8 ignore next */ if (!registry) return;
    const account = registry.getAccount(accountId);
    /* c8 ignore next */ if (!account) return;
    if (gatedIntegrationForKind(account.kind) !== "gmail") return;
    for (const id of providerIds) {
      if (typeof id === "string" && id.length > 0) {
        markIntegrationWrite(deps.db, "gmail", id);
      }
    }
  };

  /**
   * Second-key attribution via RFC-2822 Message-Id. On IMAP, the Sent folder
   * UID the poller later observes has no relationship to the draft UID the
   * route marked. The rfc822 key is stable across the transport path so the
   * poller can still match. Providers that don't surface the id leave this
   * a no-op (route treats undefined as "skip"). The poller is taught to
   * check both keys (§MailPoller.pollAccount).
   */
  const markAgentWriteRfc822 = (
    accountId: string,
    rfc822MsgId: string | null | undefined,
  ): void => {
    if (!rfc822MsgId) return;
    deps.writeTracker?.markWriting(
      `mail:${accountId}:rfc822:${rfc822MsgId}`,
      undefined,
      { ttlMs: writeTtlMs() },
    );
  };

  const ensureMethod = <K extends keyof MailProvider>(
    provider: MailProvider,
    method: K,
  ): boolean => typeof provider[method] === "function";

  return {
    resolveProvider,
    renderResolveError,
    ensureMethod,
    markAgentWrite,
    markAgentWriteRfc822,
    markGmailIntegrationWrite,
  };
}
