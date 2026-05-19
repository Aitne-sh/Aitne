import type { Hono } from "hono";
import { readJsonBody } from "../../json-body.js";
import { composeIssue, respondWithAgentError } from "../../helpers/agent-errors.js";
import {
  loadOutlookClientConfig,
  saveOutlookClientConfig,
  OUTLOOK_CLIENT_CONFIG_BLOB,
  type OutlookClientConfig,
} from "../../../services/mail/outlook/client-config.js";
import type { MailRouteDependencies } from "./dependencies.js";

export function registerOutlookConfigRoutes(
  app: Hono,
  deps: MailRouteDependencies,
): void {
  // ──────────────────────────────────────────────────────────────────────────
  // Outlook BYOA client config (§6.1).
  // Stored separately from per-account token cache.
  // ──────────────────────────────────────────────────────────────────────────

  app.get("/config/mail/outlook/client-config", async (c) => {
    if (!deps.blobStore) {
      return respondWithAgentError(c, 503, [
        composeIssue("mail.blob_store_unavailable", {
          field: "deps.blobStore",
          received: "<unavailable>",
        }),
      ]);
    }
    const config = await loadOutlookClientConfig(deps.blobStore);
    if (!config) return c.json({ configured: false }, 200);
    // clientId is technically public per the OAuth "public client" model;
    // returning it lets the dashboard show a confirmation. Tenant ditto.
    return c.json({ configured: true, clientId: config.clientId, tenant: config.tenant });
  });

  app.put("/config/mail/outlook/client-config", async (c) => {
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
    const candidate = parsedBody.body as Partial<OutlookClientConfig> | null;
    const clientId = candidate?.clientId;
    const tenant = candidate?.tenant;
    if (typeof clientId !== "string" || clientId.length === 0) {
      return respondWithAgentError(c, 400, [
        composeIssue("mail.invalid_body", {
          field: "clientId",
          received: clientId === undefined ? "<missing>" : typeof clientId,
          hint: "Outlook client config requires `clientId` (the Azure AD app's id). Optionally `tenant` (defaults to 'common').",
        }),
      ], { legacyFields: { message: "clientId required" } });
    }
    const resolved: OutlookClientConfig = {
      clientId,
      tenant:
        typeof tenant === "string" && tenant.length > 0 ? tenant : "common",
    };
    await saveOutlookClientConfig(deps.blobStore, resolved);
    return c.json({ status: "saved", clientId: resolved.clientId, tenant: resolved.tenant });
  });

  app.delete("/config/mail/outlook/client-config", async (c) => {
    if (!deps.blobStore) {
      return respondWithAgentError(c, 503, [
        composeIssue("mail.blob_store_unavailable", {
          field: "deps.blobStore",
          received: "<unavailable>",
        }),
      ]);
    }
    await deps.blobStore.remove(OUTLOOK_CLIENT_CONFIG_BLOB);
    return c.json({ status: "removed" });
  });

  // The Outlook OAuth bootstrap lives on POST /mail/accounts (loopback) or
  // POST /mail/accounts/device-code (headless). No daemon-side callback
  // endpoint is needed — the Microsoft redirect targets the ephemeral loopback
  // http.Server inside runLoopbackOAuth.
}
