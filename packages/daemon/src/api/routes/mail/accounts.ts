import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { createLogger } from "../../../logging.js";
import { readJsonBody } from "../../json-body.js";
import { composeIssue, respondWithAgentError } from "../../helpers/agent-errors.js";
import { loadOutlookClientConfig } from "../../../services/mail/outlook/client-config.js";
import {
  runLoopbackOAuth,
  OAuthLoopbackError,
  OAuthLoopbackTimeoutError,
} from "../../../services/mail/outlook/oauth-loopback.js";
import { runDeviceCodeOAuth } from "../../../services/mail/outlook/oauth-device-code.js";
import { DuplicateAccountError } from "../../../services/mail/account-registry.js";
import type { MailRouteDependencies } from "./dependencies.js";

const logger = createLogger("mail-api");

export function registerAccountsRoutes(
  app: Hono,
  deps: MailRouteDependencies,
): void {
  // GET /mail/accounts — all configured accounts (dashboard, setup).
  // GET /mail/accounts?active=1 — scope-gated subset that matches what
  // `accounts.md` materializes and what the unified poller observes:
  //   kind ∈ enabledMailProviders ∧ account.active ∧ authStatus === "healthy".
  // Skills that need to refresh a stale `accounts.md` MUST pass `?active=1`
  // — raw listAccounts() includes dormant / unhealthy rows and will mislead
  // the agent into picking an id that every operation will 4xx on.
  app.get("/mail/accounts", (c) => {
    const registry = deps.services.mail;
    if (!registry) {
      return c.json({ accounts: [] });
    }
    const activeOnly = c.req.query("active") === "1";
    const accounts = activeOnly
      ? registry.listActiveAccounts()
      : registry.listAccounts();
    return c.json({ accounts });
  });

  // POST /mail/accounts blocks for the duration of the loopback PKCE flow —
  // up to OAuthLoopbackTimeoutError's 5-minute cap (see oauth-loopback.ts).
  // Dashboard clients MUST configure a long fetch timeout for this route.
  // Headless environments (SSH, WSL) should use /mail/accounts/device-code.
  app.post("/mail/accounts", async (c) => {
    const registry = deps.services.mail;
    if (!registry) {
      return respondWithAgentError(c, 503, [
        composeIssue("mail.not_configured", {
          field: "services.mail",
          received: "<unavailable>",
        }),
      ]);
    }
    if (!deps.blobStore) {
      return respondWithAgentError(c, 503, [
        composeIssue("mail.blob_store_unavailable", {
          field: "deps.blobStore",
          received: "<unavailable>",
        }),
      ]);
    }

    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.body as { kind?: unknown; label?: unknown } | null;
    if (body?.kind === "gmail") {
      // The primary Gmail mailbox now participates in the unified mail
      // surface via the shared Google OAuth credentials from
      // /config/google-auth. Additional Gmail accounts still need a
      // per-account Google OAuth credential store and are intentionally
      // not wired up yet.
      return respondWithAgentError(c, 501, [
        composeIssue("mail.not_implemented", {
          field: "kind",
          received: "gmail",
          hint:
            "Additional Gmail accounts are not implemented yet. The primary Gmail identity is configured through /config/google-auth and is exposed on the unified /mail/* surface automatically.",
        }),
      ], {
        legacyFields: {
          message:
            "Additional Gmail accounts are not implemented yet. The primary Gmail identity is configured through /config/google-auth and is exposed on the unified /mail/* surface automatically.",
        },
      });
    }
    if (body?.kind !== "outlook") {
      return respondWithAgentError(c, 400, [
        composeIssue("mail.unsupported_kind", {
          field: "kind",
          received: body?.kind ?? "<missing>",
          hint:
            "Only outlook is supported on this endpoint. Yahoo/iCloud use POST /config/mail/app-password. The primary Gmail account uses /config/google-auth; extra Gmail accounts are not implemented.",
        }),
      ], {
        legacyFields: {
          message:
            "Only outlook is supported on this endpoint. Yahoo/iCloud use POST /config/mail/app-password. The primary Gmail account uses /config/google-auth; extra Gmail accounts are not implemented.",
        },
      });
    }
    // §UI v2 auth-then-enable: registration is allowed regardless of
    // enabledMailProviders. The provider becomes live only when the user
    // toggles "Enable" on the dashboard mail card.

    const clientConfig = await loadOutlookClientConfig(deps.blobStore);
    if (!clientConfig) {
      return respondWithAgentError(c, 412, [
        composeIssue("mail.outlook_client_config_missing", {
          field: "outlookClientConfig",
          received: "<unset>",
        }),
      ], { legacyFields: { message: "PUT /api/config/mail/outlook/client-config first." } });
    }

    let oauthResult: Awaited<ReturnType<typeof runLoopbackOAuth>>;
    try {
      oauthResult = await runLoopbackOAuth({ clientConfig });
    } catch (err) {
      if (err instanceof OAuthLoopbackTimeoutError) {
        return respondWithAgentError(c, 408, [
          composeIssue("mail.oauth_timeout", {
            field: "outlook.oauth",
            received: err.message,
          }),
        ], { legacyFields: { message: err.message } });
      }
      if (err instanceof OAuthLoopbackError) {
        return c.json({ error: err.code, message: err.message }, 400);
      }
      logger.error({ err }, "outlook oauth bootstrap failed");
      return c.json(
        { error: "oauth_failed", message: err instanceof Error ? err.message : String(err) },
        500,
      );
    }

    try {
      const account = await registry.addAccount({
        kind: "outlook",
        email: oauthResult.email,
        label: typeof body?.label === "string" ? body.label : undefined,
        authType: "oauth",
        secretPayload: oauthResult.serializedCache,
      });
      return c.json({ status: "completed", account });
    } catch (err) {
      if (err instanceof DuplicateAccountError) {
        return c.json({ error: err.code, message: err.message }, 409);
      }
      logger.error({ err, email: oauthResult.email }, "outlook addAccount failed after OAuth");
      return c.json(
        { error: "add_account_failed", message: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  });

  // Device-code fallback (§B2). Used by headless/SSH environments where the
  // loopback flow's browser-open would fail. Streams SSE events:
  //   `prompt`    { userCode, verificationUri, expiresIn, message }
  //   `completed` { account }
  //   `failed`    { error, message }
  //
  // MSAL's acquireTokenByDeviceCode blocks until the user completes verification
  // in their browser, so this endpoint may remain open for several minutes.
  app.post("/mail/accounts/device-code", async (c) => {
    const registry = deps.services.mail;
    if (!registry) {
      return respondWithAgentError(c, 503, [
        composeIssue("mail.not_configured", {
          field: "services.mail",
          received: "<unavailable>",
        }),
      ]);
    }
    if (!deps.blobStore) {
      return respondWithAgentError(c, 503, [
        composeIssue("mail.blob_store_unavailable", {
          field: "deps.blobStore",
          received: "<unavailable>",
        }),
      ]);
    }

    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.body as { kind?: unknown; label?: unknown } | null;
    if (body?.kind !== "outlook") {
      return respondWithAgentError(c, 400, [
        composeIssue("mail.unsupported_kind", {
          field: "kind",
          received: body?.kind ?? "<missing>",
          hint: "Device-code flow is Outlook-only on this endpoint. Use POST /mail/accounts for other providers.",
        }),
      ]);
    }
    // §UI v2 auth-then-enable: registration allowed regardless of
    // enabledMailProviders. The Enable toggle on the dashboard mail card
    // governs whether the agent observes this account.

    const clientConfig = await loadOutlookClientConfig(deps.blobStore);
    if (!clientConfig) {
      return respondWithAgentError(c, 412, [
        composeIssue("mail.outlook_client_config_missing", {
          field: "outlookClientConfig",
          received: "<unset>",
        }),
      ], { legacyFields: { message: "PUT /api/config/mail/outlook/client-config first." } });
    }

    const label = typeof body?.label === "string" ? body.label : undefined;

    return streamSSE(c, async (stream) => {
      try {
        const result = await runDeviceCodeOAuth({
          clientConfig,
          onPrompt: async (info) => {
            await stream.writeSSE({
              event: "prompt",
              data: JSON.stringify(info),
            });
          },
        });
        try {
          const account = await registry.addAccount({
            kind: "outlook",
            email: result.email,
            label,
            authType: "oauth",
            secretPayload: result.serializedCache,
          });
          await stream.writeSSE({
            event: "completed",
            data: JSON.stringify({ account }),
          });
        } catch (err) {
          if (err instanceof DuplicateAccountError) {
            await stream.writeSSE({
              event: "failed",
              data: JSON.stringify({ error: err.code, message: err.message }),
            });
            return;
          }
          throw err;
        }
      } catch (err) {
        logger.error({ err }, "device-code oauth failed");
        await stream.writeSSE({
          event: "failed",
          data: JSON.stringify({
            error: "device_code_failed",
            message: err instanceof Error ? err.message : String(err),
          }),
        });
      }
    });
  });

  // Active-toggle for a single account. Distinct from provider-level enable
  // (§6.0): users can disable one Outlook account while keeping the "Outlook"
  // provider enabled.
  app.patch("/mail/accounts/:accountId", async (c) => {
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

    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const active = (parsedBody.body as { active?: unknown } | null)?.active;
    if (typeof active !== "boolean") {
      return c.json(
        { error: "invalid_body", message: "active: boolean required" },
        400,
      );
    }
    const updated = await registry.setActive(accountId, active);
    if (!updated) {
      return respondWithAgentError(c, 404, [
        composeIssue("mail.account_not_found", {
          field: "accountId",
          received: accountId,
        }),
      ]);
    }
    return c.json({ status: "updated", account: updated });
  });

  app.delete("/mail/accounts/:accountId", async (c) => {
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
    const removed = await registry.removeAccount(accountId);
    if (!removed) {
      return respondWithAgentError(c, 404, [
        composeIssue("mail.account_not_found", {
          field: "accountId",
          received: accountId,
        }),
      ]);
    }
    return c.json({ status: "removed", accountId });
  });
}
