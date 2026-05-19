import type { Hono } from "hono";
import { createLogger } from "../../../logging.js";
import { readJsonBody } from "../../json-body.js";
import { composeIssue, respondWithAgentError } from "../../helpers/agent-errors.js";
import {
  buildImapAccountSecret,
  isImapAppPasswordKind,
  serializeImapAccountSecret,
} from "../../../services/mail/imap/app-password.js";
import { classifyImapAuthFailure } from "../../../services/mail/imap/auth-failure-classifier.js";
import { verifyImapAccountSecret } from "../../../services/mail/imap/client.js";
import {
  DuplicateAccountError,
  ProviderNotImplementedError,
} from "../../../services/mail/account-registry.js";
import type { MailRouteDependencies } from "./dependencies.js";

const logger = createLogger("mail-api");

export function registerAppPasswordRoutes(
  app: Hono,
  deps: MailRouteDependencies,
): void {
  const verifyImapCredentials =
    deps.verifyImapAccountSecret ?? verifyImapAccountSecret;

  app.post("/config/mail/app-password", async (c) => {
    const registry = deps.services.mail;
    if (!registry) {
      return respondWithAgentError(c, 503, [
        composeIssue("mail.not_configured", {
          field: "services.mail",
          received: "<unavailable>",
        }),
      ]);
    }

    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.body as {
      kind?: unknown;
      email?: unknown;
      appPassword?: unknown;
      label?: unknown;
    } | null;
    const kindCandidate = typeof body?.kind === "string" ? body.kind : null;
    const email = typeof body?.email === "string" ? body.email : null;
    const appPassword =
      typeof body?.appPassword === "string" ? body.appPassword : null;

    if (
      !kindCandidate ||
      !isImapAppPasswordKind(kindCandidate) ||
      !email ||
      email.length === 0 ||
      !appPassword ||
      appPassword.length === 0
    ) {
      return c.json(
        {
          error: "invalid_body",
          message: "kind(yahoo|icloud), email, and appPassword are required.",
        },
        400,
      );
    }
    const kind = kindCandidate;
    // §UI v2 auth-then-enable: registration allowed regardless of
    // enabledMailProviders. The Enable toggle on the dashboard mail card
    // governs whether the agent observes this account.

    const secret = buildImapAccountSecret(kind, email, appPassword);
    let capabilities: Awaited<ReturnType<typeof verifyImapAccountSecret>> | null;
    try {
      capabilities = await verifyImapCredentials(secret);
    } catch (err) {
      const classified = classifyImapAuthFailure({
        errorName: err instanceof Error ? err.name : null,
        message: getImapErrorMessage(err),
        responseCode: getErrorResponseCode(err),
      });
      if (classified.status === "requires_consent") {
        return c.json(
          {
            error: "imap_auth_failed",
            message:
              "IMAP login failed. Verify the email address and app password, then try again.",
          },
          400,
        );
      }
      if (classified.status === "degraded" || classified.status === "transient") {
        return c.json(
          {
            error: "imap_connect_failed",
            message:
              "The IMAP server could not be reached or rejected the login attempt. Try again shortly.",
          },
          502,
        );
      }
      logger.error({ err, kind, email }, "app-password IMAP verification failed");
      return c.json(
        { error: "add_account_failed", message: err instanceof Error ? err.message : String(err) },
        500,
      );
    }

    try {
      const account = await registry.addAccount({
        kind,
        email,
        label: typeof body?.label === "string" ? body.label : undefined,
        authType: "app_password",
        secretPayload: serializeImapAccountSecret(secret),
        idleEnabled: true,
        capabilities: capabilities ?? undefined,
      });
      return c.json({ status: "completed", account });
    } catch (err) {
      if (err instanceof DuplicateAccountError) {
        return c.json({ error: err.code, message: err.message }, 409);
      }
      if (err instanceof ProviderNotImplementedError) {
        return c.json({ error: err.code, message: err.message }, 400);
      }
      logger.error({ err, kind, email }, "app-password account add failed");
      return c.json(
        { error: "add_account_failed", message: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  });

  // Refresh an existing IMAP (Yahoo / iCloud) account's app password without
  // deleting and re-creating the row. Used when the user rotates the password
  // at the provider and the account flips to `requires_consent`. The route
  // verifies the new credentials against the IMAP server before persisting,
  // then resets `auth_status` to `healthy`.
  app.post("/config/mail/app-password/:accountId/refresh", async (c) => {
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
    const account = registry.getAccount(accountId);
    if (!account) {
      return respondWithAgentError(c, 404, [
        composeIssue("mail.account_not_found", {
          field: "accountId",
          received: accountId,
        }),
      ]);
    }
    if (account.kind !== "yahoo" && account.kind !== "icloud") {
      return respondWithAgentError(c, 400, [
        composeIssue("mail.unsupported_kind", {
          field: "account.kind",
          received: account.kind,
          hint:
            "App-password refresh only supports yahoo / icloud. Outlook re-authenticates via the OAuth loopback flow.",
        }),
      ], { legacyFields: { message: "App-password refresh only supports yahoo / icloud. Outlook re-authenticates via the OAuth loopback flow." } });
    }

    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.body as { appPassword?: unknown } | null;
    const appPassword =
      typeof body?.appPassword === "string" ? body.appPassword : null;
    if (!appPassword || appPassword.length === 0) {
      return c.json(
        { error: "invalid_body", message: "appPassword is required." },
        400,
      );
    }

    const secret = buildImapAccountSecret(account.kind, account.email, appPassword);
    let capabilities: Awaited<ReturnType<typeof verifyImapAccountSecret>> | null;
    try {
      capabilities = await verifyImapCredentials(secret);
    } catch (err) {
      const classified = classifyImapAuthFailure({
        errorName: err instanceof Error ? err.name : null,
        message: getImapErrorMessage(err),
        responseCode: getErrorResponseCode(err),
      });
      if (classified.status === "requires_consent") {
        return c.json(
          {
            error: "imap_auth_failed",
            message:
              "IMAP login failed with the new password. Generate a fresh app password and try again.",
          },
          400,
        );
      }
      if (classified.status === "degraded" || classified.status === "transient") {
        return c.json(
          {
            error: "imap_connect_failed",
            message:
              "The IMAP server could not be reached. Try again shortly.",
          },
          502,
        );
      }
      logger.error({ err, accountId }, "app-password refresh verification failed");
      return c.json(
        { error: "refresh_failed", message: err instanceof Error ? err.message : String(err) },
        500,
      );
    }

    try {
      const updated = await registry.refreshImapSecret(
        accountId,
        serializeImapAccountSecret(secret),
        capabilities ?? undefined,
      );
      if (!updated) {
        return respondWithAgentError(c, 404, [
          composeIssue("mail.account_not_found", {
            field: "accountId",
            received: accountId,
          }),
        ]);
      }
      return c.json({ status: "refreshed", account: updated });
    } catch (err) {
      logger.error({ err, accountId }, "app-password refresh failed");
      return c.json(
        { error: "refresh_failed", message: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  });
}

function getErrorResponseCode(err: unknown): number | null {
  const candidate = (err as { responseCode?: unknown } | null)?.responseCode;
  return typeof candidate === "number" ? candidate : null;
}

// ImapFlow sets err.message to the generic "Command failed" and puts the
// actual IMAP server response code in serverResponseCode (e.g. "AUTHENTICATIONFAILED")
// and the human text in responseText. Concatenate all three so that the
// classifyImapAuthFailure patterns can match the real server response.
function getImapErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const e = err as { serverResponseCode?: string; responseText?: string };
  return [err.message, e.serverResponseCode, e.responseText].filter(Boolean).join(" ");
}
