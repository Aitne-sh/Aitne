/**
 * External-service hot-reload routines — Google (calendar/gmail), Apple
 * Calendar, Notion, GitHub.
 *
 * Extracted from the `startup()` IIFE in `index.ts` per
 * `docs/design/appendices/file-split-plan.md` §10 (Tier 2, Pattern C).
 * Goal: lift the four reload routines and the shared
 * `refreshGoogleSecretState` helper out of the startup lambda so the
 * lambda reads as a sequence rather than a 3,000-line bag of closures.
 *
 * Shape: `createServiceReloaders(deps)` is a factory that captures a
 * `BootstrapServiceDeps` record once and returns the reload closures.
 * Mutable state lives in two shared holders passed in via `deps`:
 *  - `services` — `ServiceRegistry` instance shared with every route,
 *    observer, and the context builder. Reload routines write
 *    `services.calendar` / `services.gmail` / ... and the corresponding
 *    `services.errors.<key>` entries.
 *  - `secretState` — read by `/api/health.integrations` and observer
 *    start gates. Reload routines update the corresponding boolean +
 *    Google credential-type field.
 *
 * Both holders are passed by reference; reading them after a reload
 * completes observes the post-reload values, exactly matching the
 * pre-extraction inlined behavior.
 */

import type Database from "better-sqlite3";
import type { AgentConfig } from "../config.js";
import type { SecretBroker } from "../secrets/secret-broker.js";
import type { ServiceRegistry } from "../services/service-registry.js";
import { CalendarService } from "../services/calendar.js";
import { AppleCalendarService } from "../services/apple-calendar/index.js";
import { GmailService } from "../services/gmail.js";
import {
  detectGoogleCredentialType,
  type GoogleCredentialType,
} from "../services/google-auth.js";
import { NotionService } from "../services/notion.js";
import { GitHubService } from "../services/github.js";
import {
  ensureLegacyGmailRow,
  syncLegacyGmailAccountState,
} from "../services/mail/gmail/legacy-row.js";
import { createLogger } from "../logging.js";

const logger = createLogger("daemon-bootstrap-services");

/**
 * Mutable holder for the per-service "is configured" booleans + the
 * Google credential type. Read by `/api/health.integrations` and the
 * observer start gates; written by the reload routines.
 */
export interface BootstrapSecretState {
  googleCredentialsConfigured: boolean;
  googleTokenConfigured: boolean;
  googleCredentialType: GoogleCredentialType | null;
  notionConfigured: boolean;
  githubConfigured: boolean;
  githubWebhookConfigured: boolean;
}

export function createInitialSecretState(): BootstrapSecretState {
  return {
    googleCredentialsConfigured: false,
    googleTokenConfigured: false,
    googleCredentialType: null,
    notionConfigured: false,
    githubConfigured: false,
    githubWebhookConfigured: false,
  };
}

export interface BootstrapServiceDeps {
  readonly db: Database.Database;
  readonly config: AgentConfig;
  readonly secretBroker: SecretBroker;
  readonly services: ServiceRegistry;
  readonly secretState: BootstrapSecretState;
}

export interface ServiceReloaders {
  refreshGoogleSecretState(): Promise<void>;
  reloadGoogleServices(): Promise<void>;
  reloadAppleCalendarService(): Promise<void>;
  reloadNotionService(): Promise<void>;
  reloadGitHubService(): Promise<void>;
}

export function createServiceReloaders(
  deps: BootstrapServiceDeps,
): ServiceReloaders {
  const { db, config, secretBroker, services, secretState } = deps;

  async function refreshGoogleSecretState(): Promise<void> {
    const [credentialsRaw, tokenRaw] = await Promise.all([
      secretBroker.getGoogleCredentialsJson(),
      secretBroker.getGoogleTokenJson(),
    ]);
    secretState.googleCredentialsConfigured = !!credentialsRaw;
    secretState.googleTokenConfigured = !!tokenRaw;
    secretState.googleCredentialType = detectGoogleCredentialType(credentialsRaw);
  }

  async function reloadGoogleServices(): Promise<void> {
    await refreshGoogleSecretState();
    services.calendar = null;
    services.gmail = null;
    delete services.errors.googleCalendar;
    delete services.errors.gmail;

    if (!secretState.googleCredentialsConfigured) {
      if (services.mail) {
        syncLegacyGmailAccountState(db, services.mail, {
          available: false,
          error: "Google credentials are not configured.",
        });
      }
      return;
    }

    // OAuth2 pre-auth: credentials uploaded but the user has not completed the
    // browser flow yet (no token in the keychain). Initializing the services
    // would fail with a "missing token" error that the dashboard would then
    // render as red "Error" under the Google card — but this is the expected
    // mid-setup state, not a failure. Skip init and leave services.errors
    // unset so /health reports error: null until the user finishes OAuth or a
    // real init error occurs.
    const oauth2PreAuth =
      secretState.googleCredentialType === "oauth2"
      && !secretState.googleTokenConfigured;
    if (oauth2PreAuth) {
      if (services.mail) {
        syncLegacyGmailAccountState(db, services.mail, {
          available: false,
          error: "Awaiting Google OAuth authorization.",
        });
      }
      return;
    }

    const calendarService = new CalendarService(config, secretBroker);
    try {
      await calendarService.init();
      services.calendar = calendarService;
    } catch (err) {
      const msg = (err as Error).message;
      logger.error({ error: msg }, "Calendar service init failed, continuing without it");
      services.errors.googleCalendar = msg;
    }

    const gmailService = new GmailService(secretBroker);
    try {
      await gmailService.init();
      services.gmail = gmailService;
    } catch (err) {
      const msg = (err as Error).message;
      logger.error({ error: msg }, "Gmail service init failed, continuing without it");
      services.errors.gmail = msg;
    }

    // Ensure the shared-Google-OAuth Gmail identity exists as a unified
    // mail account (idempotent; returns `exists` on subsequent boots).
    if (services.gmail?.available) {
      try {
        await ensureLegacyGmailRow(db, services.gmail);
      } catch (err) {
        logger.error({ err }, "Failed to ensure shared-Google-OAuth Gmail mail_accounts row");
      }
      if (services.mail) {
        syncLegacyGmailAccountState(db, services.mail, { available: true });
      }
    } else if (services.mail) {
      syncLegacyGmailAccountState(db, services.mail, {
        available: false,
        error: services.errors.gmail ?? "Gmail is not configured.",
      });
    }
  }

  async function reloadAppleCalendarService(): Promise<void> {
    const raw = await secretBroker.getAppleCalendarCredentialsJson();
    services.appleCalendar = null;
    delete services.errors.appleCalendar;
    if (!raw) {
      return;
    }
    const service = new AppleCalendarService(secretBroker);
    try {
      await service.init();
      if (service.available) {
        services.appleCalendar = service;
      } else {
        // Surface the underlying iCloud error verbatim — the dashboard
        // shows it on the Connections card so the user can act
        // (`401 Unauthorized` → regenerate password; network error →
        // retry; etc.). Falls back to a generic placeholder only if
        // init() failed without recording a message.
        services.errors.appleCalendar =
          service.initError
          ?? "Apple Calendar credentials present but iCloud discovery did not return a usable calendar — verify the app-specific password.";
      }
    } catch (err) {
      const msg = (err as Error).message;
      logger.error({ error: msg }, "Apple Calendar service init failed, continuing without it");
      services.errors.appleCalendar = msg;
    }
  }

  async function reloadNotionService(): Promise<void> {
    const apiKey = await secretBroker.getNotionApiKey();
    secretState.notionConfigured = !!apiKey;
    services.notion = null;
    delete services.errors.notion;
    if (!apiKey) {
      return;
    }

    const notionService = new NotionService(config, secretBroker);
    try {
      await notionService.init();
      services.notion = notionService;
    } catch (err) {
      const msg = (err as Error).message;
      logger.error({ error: msg }, "Notion service init failed, continuing without it");
      services.errors.notion = msg;
    }
  }

  async function reloadGitHubService(): Promise<void> {
    const [token, webhookSecret] = await Promise.all([
      secretBroker.getGitHubToken(),
      secretBroker.getGitHubWebhookSecret(),
    ]);
    secretState.githubConfigured = !!token;
    secretState.githubWebhookConfigured = !!webhookSecret;
    services.github = null;
    delete services.errors.github;
    if (!token) {
      return;
    }

    const githubService = new GitHubService(token, webhookSecret);
    try {
      await githubService.init();
      services.github = githubService;
    } catch (err) {
      const msg = (err as Error).message;
      logger.error({ error: msg }, "GitHub service init failed, continuing without it");
      services.errors.github = msg;
    }
  }

  return {
    refreshGoogleSecretState,
    reloadGoogleServices,
    reloadAppleCalendarService,
    reloadNotionService,
    reloadGitHubService,
  };
}
