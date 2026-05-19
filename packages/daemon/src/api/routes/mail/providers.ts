import type { Hono } from "hono";
import type { MailProviderKind } from "../../../services/mail/provider.js";
import { createSettingsStore } from "../../../settings/settings-store.js";
import { applyConfigUpdates } from "../../env-writer.js";
import { createLogger } from "../../../logging.js";
import { readJsonBody } from "../../json-body.js";
import { composeIssue, respondWithAgentError } from "../../helpers/agent-errors.js";
import { ALL_KINDS, PROVIDER_LABELS } from "./gating.js";
import type { MailRouteDependencies } from "./dependencies.js";

const logger = createLogger("mail-api");

export function registerProvidersRoutes(
  app: Hono,
  deps: MailRouteDependencies,
): void {
  const getSettingsStore = () =>
    deps.settingsStore ?? createSettingsStore(deps.db);

  app.get("/mail/providers", (c) => {
    const registry = deps.services.mail;
    const accounts = registry?.listAccounts() ?? [];
    const available = ALL_KINDS.map((kind) => {
      const ofKind = accounts.filter((a) => a.kind === kind);
      return {
        kind,
        label: PROVIDER_LABELS[kind],
        accountsConfigured: ofKind.length,
        accountsHealthy: ofKind.filter((a) => a.authStatus === "healthy").length,
      };
    });
    return c.json({
      enabledKinds: [...deps.config.enabledMailProviders],
      available,
    });
  });

  app.patch("/mail/providers", async (c) => {
    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const candidate = (parsedBody.body as { enabledKinds?: unknown } | null)
      ?.enabledKinds;
    if (!Array.isArray(candidate)) {
      return respondWithAgentError(c, 400, [
        composeIssue("mail.invalid_body", {
          field: "enabledKinds",
          received: candidate === undefined ? "<missing>" : typeof candidate,
          hint: "enabledKinds must be an array of provider kinds (e.g. ['gmail','outlook','imap']). Empty array disables all.",
        }),
      ], { legacyFields: { message: "enabledKinds must be an array" } });
    }

    const settingsStore = getSettingsStore();
    const result = await applyConfigUpdates(deps.config, settingsStore, {
      enabledMailProviders: candidate,
    });
    if (Object.keys(result.errors).length > 0) {
      return respondWithAgentError(c, 400, [
        composeIssue("mail.validation_failed", {
          field: "enabledKinds",
          received: candidate,
        }),
      ], { legacyFields: { errors: result.errors } });
    }

    const newKinds = deps.config.enabledMailProviders;
    const registry = deps.services.mail;
    const before = new Set<MailProviderKind>();
    const after = new Set<MailProviderKind>(newKinds);
    const accounts = registry?.listAccounts() ?? [];
    for (const acct of accounts) {
      before.add(acct.kind);
    }
    const dormantAccounts = accounts
      .filter((a) => before.has(a.kind) && !after.has(a.kind))
      .map((a) => a.id);
    const resumedAccounts = accounts
      .filter((a) => after.has(a.kind))
      .map((a) => a.id);

    registry?.onProviderSelectionChanged(newKinds);
    logger.info(
      { enabledKinds: [...newKinds], dormantAccounts, resumedAccounts },
      "mail provider selection updated",
    );
    return c.json({ status: "updated", dormantAccounts, resumedAccounts });
  });
}
