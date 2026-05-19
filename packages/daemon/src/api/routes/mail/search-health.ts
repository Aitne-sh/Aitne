import type { Hono } from "hono";
import { composeIssue, respondWithAgentError } from "../../helpers/agent-errors.js";
import { searchMail } from "../../../services/mail/mail-search.js";
import { readIntegrations } from "../../../db/integrations-store.js";
import {
  gatedIntegrationForKind,
  gatedMailIntegrationResponse,
} from "./gating.js";
import { parseIntParam } from "./validators.js";
import type { MailRouteDependencies } from "./dependencies.js";

export function registerSearchHealthRoutes(
  app: Hono,
  deps: MailRouteDependencies,
): void {
  // ──────────────────────────────────────────────────────────────────────────
  // Cross-account local search backed by the fts_mail_messages virtual
  // table. Returns a flat list of lightweight summaries sourced
  // from the index — no provider round-trip. Use this as the first stop for
  // "find emails about X" queries; fall back to `/mail/:acct/messages?q=`
  // only when the user wants provider-fresh results or matches bodies older
  // than the local index.
  //
  // Shape matches MailMessageSummary (subset): { accountId, providerMsgId,
  // subject, snippet, receivedAtUtc, from, isRead }. Results span all
  // accounts by default; scope with `?accountId=`.
  // ──────────────────────────────────────────────────────────────────────────
  app.get("/mail/search", (c) => {
    const q = c.req.query("q")?.trim() ?? "";
    if (q.length === 0) {
      return c.json(
        { error: "invalid_query", message: "q is required and must be non-empty" },
        400,
      );
    }
    const limit = parseIntParam(c.req.query("limit"), 50, { min: 1, max: 500 });
    const accountId = c.req.query("accountId") ?? undefined;
    // §4.8 per-account mode gate for search — if the caller pins the
    // query to a Gmail / Outlook account whose integration is in
    // `delegated` or `native` mode, 410. The unscoped cross-account
    // search path stays open; results for a gated account would just
    // be stale FTS hits (live polling is off in both modes), which is
    // acceptable for Phase 2 and documented in §4.4. Per
    // INTEGRATION_NATIVE_MODE_DESIGN.md §9.2 the gate widened from
    // delegated-only to cover native too so the agent gets a consistent
    // redirect signal when Outlook is flipped to native (user-managed
    // MCP) or Gmail's native binding is in play. `disabled` is not
    // gated here — see `gatedMailIntegrationResponse` doc-comment.
    if (accountId) {
      const account = deps.services.mail?.getAccount(accountId);
      if (account) {
        const gatedIntegrationKey = gatedIntegrationForKind(account.kind);
        if (gatedIntegrationKey) {
          const state = readIntegrations(deps.db)[gatedIntegrationKey];
          const gateResponse = gatedMailIntegrationResponse(
            gatedIntegrationKey,
            state,
          );
          if (gateResponse !== null) {
            return c.json(gateResponse, 410);
          }
        }
      }
    }
    const hits = searchMail(deps.db, q, { accountId, limit });
    const results = hits.map((h) => ({
      accountId: h.accountId,
      providerMsgId: h.providerMsgId,
      subject: h.subject,
      snippet: h.snippet,
      receivedAtUtc: h.receivedAtUtc,
      from: h.fromEmail ? { email: h.fromEmail } : null,
      isRead: h.isRead,
    }));
    return c.json({ results, count: results.length, query: q });
  });

  // Read the mail-side parse_failures diagnostics table. The poller +
  // ingestion pipeline write a row whenever a Kindle-export / travel /
  // classification path bails out; this endpoint surfaces the latest
  // failures so the dashboard (or a curl one-liner) can answer "why
  // didn't my booking get picked up?". Read-only — no mutation surface.
  app.get("/mail/parse-failures", (c) => {
    const limit = parseIntParam(c.req.query("limit"), 50, { min: 1, max: 500 });
    const accountId = c.req.query("accountId") ?? null;
    const params: (string | number)[] = [];
    let sql = `
      SELECT id,
             account_id      AS accountId,
             provider_msg_id AS providerMsgId,
             sender,
             subject,
             snippet,
             error_reason    AS errorReason,
             created_at      AS createdAt
        FROM parse_failures`;
    if (accountId) {
      sql += ` WHERE account_id = ?`;
      params.push(accountId);
    }
    sql += ` ORDER BY id DESC LIMIT ?`;
    params.push(limit);
    const rows = deps.db.prepare(sql).all(...params) as Array<{
      id: number;
      accountId: string | null;
      providerMsgId: string | null;
      sender: string | null;
      subject: string | null;
      snippet: string | null;
      errorReason: string;
      createdAt: string;
    }>;
    return c.json({ failures: rows, count: rows.length });
  });

  app.get("/mail/:accountId/health", (c) => {
    const registry = deps.services.mail;
    if (!registry) {
      return respondWithAgentError(c, 503, [
        composeIssue("mail.not_configured", {
          field: "services.mail",
          received: "<unavailable>",
        }),
      ]);
    }
    const accountId = c.req.param("accountId");
    // §4.8 per-account mode gate — also applies to /health so the
    // dashboard does not surface a stale poll cursor for an account
    // whose integration the daemon has stopped touching (delegated /
    // native). `disabled` is intentionally not gated here so the dash
    // can still surface the last-known cursor while the user is
    // mid-reconfigure. Recovery endpoints (`POST
    // /config/mail/app-password/:id/refresh`) stay outside this gate.
    const account = registry.getAccount(accountId);
    if (account) {
      const gatedIntegrationKey = gatedIntegrationForKind(account.kind);
      if (gatedIntegrationKey) {
        const state = readIntegrations(deps.db)[gatedIntegrationKey];
        const gateResponse = gatedMailIntegrationResponse(
          gatedIntegrationKey,
          state,
        );
        if (gateResponse !== null) {
          return c.json(gateResponse, 410);
        }
      }
    }
    const health = registry.getHealth(accountId);
    if (!health) {
      return respondWithAgentError(c, 404, [
        composeIssue("mail.account_not_found", {
          field: "accountId",
          received: accountId,
        }),
      ]);
    }
    return c.json(health);
  });
}
