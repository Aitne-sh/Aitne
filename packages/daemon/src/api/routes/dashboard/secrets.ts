import type { Hono } from "hono";
import type { ApiDependencies } from "../../server.js";
import { readJsonBody } from "../../json-body.js";
import { detectGoogleCredentialType } from "../../../services/google-auth.js";

export interface SecretConfigSummary {
  slackConfigured: boolean;
  telegramConfigured: boolean;
  discordConfigured: boolean;
  notionConfigured: boolean;
  githubConfigured: boolean;
  githubWebhookSecretConfigured: boolean;
  apiTokenConfigured: boolean;
  googleCalendarCredentialsConfigured: boolean;
  googleCalendarTokenConfigured: boolean;
  googleCredentialType: "oauth2" | "service_account" | null;
  /**
   * SETUP-FLOW-REDESIGN-PLAN §6.1 — true when the BYOA Outlook client
   * config blob (`mail:outlook:client-config`) is present in the
   * EncryptedBlobStore. Drives the dashboard's
   * `directCredentialsPresent("outlook_*", config)` lookup.
   */
  outlookClientConfigConfigured: boolean;
}

export async function getSecretConfigSummary(
  deps: ApiDependencies,
): Promise<SecretConfigSummary> {
  const { secretBroker } = deps;
  const [
    slackBotToken,
    slackAppToken,
    telegramBotToken,
    discordBotToken,
    notionApiKey,
    githubToken,
    githubWebhookSecret,
    apiToken,
    googleCredentialsJson,
    googleTokenJson,
  ] = await Promise.all([
    secretBroker.getSlackBotToken(),
    secretBroker.getSlackAppToken(),
    secretBroker.getTelegramBotToken(),
    secretBroker.getDiscordBotToken(),
    secretBroker.getNotionApiKey(),
    secretBroker.getGitHubToken(),
    secretBroker.getGitHubWebhookSecret(),
    secretBroker.getApiToken(),
    secretBroker.getGoogleCredentialsJson(),
    secretBroker.getGoogleTokenJson(),
  ]);

  // SETUP-FLOW-REDESIGN-PLAN §6.1 — surface BYOA Outlook client config
  // presence so the connections page knows when direct-mode Outlook
  // integrations are resumable. Best-effort: if no blob store is
  // wired (test harness), report `false` rather than crashing.
  let outlookClientConfigConfigured = false;
  try {
    outlookClientConfigConfigured = deps.blobStore
      ? await deps.blobStore.exists("mail:outlook:client-config")
      : false;
  } catch {
    outlookClientConfigConfigured = false;
  }

  return {
    slackConfigured: !!(slackBotToken && slackAppToken),
    telegramConfigured: !!telegramBotToken,
    discordConfigured: !!discordBotToken,
    notionConfigured: !!notionApiKey,
    githubConfigured: !!githubToken,
    githubWebhookSecretConfigured: !!githubWebhookSecret,
    apiTokenConfigured: !!apiToken,
    googleCalendarCredentialsConfigured: !!googleCredentialsJson,
    googleCalendarTokenConfigured: !!googleTokenJson,
    outlookClientConfigConfigured,
    googleCredentialType: detectGoogleCredentialType(googleCredentialsJson),
  };
}

export function registerSecretsRoutes(app: Hono, deps: ApiDependencies): void {
  const { secretBroker } = deps;

  app.put("/secrets/slack", async (c) => {
    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.body as Record<string, unknown> | null;
    const botToken = typeof body?.botToken === "string" ? body.botToken.trim() : "";
    const appToken = typeof body?.appToken === "string" ? body.appToken.trim() : "";
    const validationErrors: Record<string, string> = {};
    if (!botToken && !appToken) {
      return c.json({
        status: "validation_failed",
        configured: false,
        requiresRestart: false,
        validationErrors: {
          botToken: "Provide at least one Slack token to save.",
          appToken: "Provide at least one Slack token to save.",
        },
      }, 400);
    }

    if (botToken) await secretBroker.set("slackBotToken", botToken);
    if (appToken) await secretBroker.set("slackAppToken", appToken);
    await deps.onSecretChanged?.("slack");

    return c.json({
      status: "updated",
      configured: (await getSecretConfigSummary(deps)).slackConfigured,
      requiresRestart: false,
      validationErrors,
    });
  });

  app.put("/secrets/telegram", async (c) => {
    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.body as Record<string, unknown> | null;
    const botToken = typeof body?.botToken === "string" ? body.botToken.trim() : "";
    if (!botToken) {
      return c.json({
        status: "validation_failed",
        configured: false,
        requiresRestart: false,
        validationErrors: { botToken: "Telegram bot token is required." },
      }, 400);
    }

    await secretBroker.set("telegramBotToken", botToken);
    await deps.onSecretChanged?.("telegram");
    return c.json({
      status: "updated",
      configured: (await getSecretConfigSummary(deps)).telegramConfigured,
      requiresRestart: false,
      validationErrors: {},
    });
  });

  app.put("/secrets/discord", async (c) => {
    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.body as Record<string, unknown> | null;
    const botToken = typeof body?.botToken === "string" ? body.botToken.trim() : "";
    if (!botToken) {
      return c.json({
        status: "validation_failed",
        configured: false,
        requiresRestart: false,
        validationErrors: { botToken: "Discord bot token is required." },
      }, 400);
    }

    await secretBroker.set("discordBotToken", botToken);
    await deps.onSecretChanged?.("discord");
    return c.json({
      status: "updated",
      configured: (await getSecretConfigSummary(deps)).discordConfigured,
      requiresRestart: false,
      validationErrors: {},
    });
  });

  app.put("/secrets/notion", async (c) => {
    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.body as Record<string, unknown> | null;
    const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
    if (!apiKey) {
      return c.json({
        status: "validation_failed",
        configured: false,
        requiresRestart: false,
        validationErrors: { apiKey: "Notion API key is required." },
      }, 400);
    }

    await secretBroker.set("notionApiKey", apiKey);
    await deps.onSecretChanged?.("notion");
    return c.json({
      status: "updated",
      configured: (await getSecretConfigSummary(deps)).notionConfigured,
      requiresRestart: false,
      validationErrors: {},
    });
  });

  app.put("/secrets/github", async (c) => {
    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.body as Record<string, unknown> | null;
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    const webhookSecret = typeof body?.webhookSecret === "string" ? body.webhookSecret.trim() : "";
    if (!token && !webhookSecret) {
      return c.json({
        status: "validation_failed",
        configured: false,
        requiresRestart: false,
        validationErrors: {
          token: "Provide a GitHub token and/or webhook secret.",
          webhookSecret: "Provide a GitHub token and/or webhook secret.",
        },
      }, 400);
    }

    if (token) await secretBroker.set("githubToken", token);
    if (webhookSecret) await secretBroker.set("githubWebhookSecret", webhookSecret);
    await deps.onSecretChanged?.("github");
    const summary = await getSecretConfigSummary(deps);
    return c.json({
      status: "updated",
      configured: summary.githubConfigured || summary.githubWebhookSecretConfigured,
      requiresRestart: false,
      validationErrors: {},
    });
  });

  app.put("/secrets/google/credentials", async (c) => {
    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.body as Record<string, unknown> | null;
    const raw = typeof body?.json === "string" ? body.json : "";
    if (!raw) {
      return c.json({
        status: "validation_failed",
        configured: false,
        requiresRestart: false,
        validationErrors: { json: "Credentials JSON is required." },
      }, 400);
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({
        status: "validation_failed",
        configured: false,
        requiresRestart: false,
        validationErrors: { json: "Invalid JSON file" },
      }, 400);
    }

    if (!parsed.installed && !parsed.web && parsed.type !== "service_account") {
      return c.json({
        status: "validation_failed",
        configured: false,
        requiresRestart: false,
        validationErrors: {
          json: "Invalid credentials format. Expected OAuth2 credentials JSON or a service account JSON.",
        },
      }, 400);
    }

    await secretBroker.set("googleCredentialsJson", raw);
    if (parsed.type === "service_account") {
      await secretBroker.delete("googleTokenJson");
    }
    await deps.onSecretChanged?.("google");
    deps.onGoogleServicesReady?.();
    const summary = await getSecretConfigSummary(deps);
    return c.json({
      status: "updated",
      configured: summary.googleCalendarCredentialsConfigured,
      requiresRestart: false,
      validationErrors: {},
    });
  });

  app.put("/secrets/google/token", async (c) => {
    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.body as Record<string, unknown> | null;
    const raw = typeof body?.json === "string" ? body.json : "";
    if (!raw) {
      return c.json({
        status: "validation_failed",
        configured: false,
        requiresRestart: false,
        validationErrors: { json: "Token JSON is required." },
      }, 400);
    }

    try {
      JSON.parse(raw);
    } catch {
      return c.json({
        status: "validation_failed",
        configured: false,
        requiresRestart: false,
        validationErrors: { json: "Invalid JSON file" },
      }, 400);
    }

    await secretBroker.saveGoogleTokenJson(raw);
    await deps.onSecretChanged?.("google");
    deps.onGoogleServicesReady?.();
    const summary = await getSecretConfigSummary(deps);
    return c.json({
      status: "updated",
      configured: summary.googleCalendarTokenConfigured,
      requiresRestart: false,
      validationErrors: {},
    });
  });

  app.delete("/secrets/:name", async (c) => {
    const name = c.req.param("name");
    if (name === "apiToken") {
      return c.json({
        error: "api_token_not_deletable",
        message: "The daemon API token cannot be deleted from the API. Rotate it explicitly instead.",
      }, 400);
    }
    const secretNameByParam = {
      slackBotToken: "slackBotToken",
      slackAppToken: "slackAppToken",
      telegramBotToken: "telegramBotToken",
      discordBotToken: "discordBotToken",
      notionApiKey: "notionApiKey",
      githubToken: "githubToken",
      githubWebhookSecret: "githubWebhookSecret",
      googleCredentialsJson: "googleCredentialsJson",
      googleTokenJson: "googleTokenJson",
    } as const;
    const secretName = secretNameByParam[name as keyof typeof secretNameByParam];
    if (!secretName) {
      return c.json({ error: "unknown_secret" }, 404);
    }

    await secretBroker.delete(secretName);

    const scopeBySecret = {
      slackBotToken: "slack",
      slackAppToken: "slack",
      telegramBotToken: "telegram",
      discordBotToken: "discord",
      notionApiKey: "notion",
      githubToken: "github",
      githubWebhookSecret: "github",
      googleCredentialsJson: "google",
      googleTokenJson: "google",
    } as const;
    await deps.onSecretChanged?.(scopeBySecret[secretName]);

    return c.json({
      status: "deleted",
      configured: false,
      requiresRestart: false,
      validationErrors: {},
    });
  });
}
