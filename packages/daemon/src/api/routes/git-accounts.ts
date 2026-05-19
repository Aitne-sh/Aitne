/**
 * Git accounts API (P5 §"Multi-account remotes").
 *
 * The dashboard manages a registry of named credentials at
 * `config.gitAccounts[<alias>]`. Each entry chooses one of two auth
 * modes:
 *   • `gh-cli-profile`: reuse a `gh auth login` profile already on the
 *     machine. The token is fetched on demand via
 *     `gh auth token --user <ghProfile> --hostname <host>`.
 *   • `pat-keychain`: a personal access token the user pasted into the
 *     dashboard. Stored in the OS keychain at `git.account.<alias>`
 *     (typed `ScopedSecretName` in `secret-names.ts`); fetched via
 *     `SecretBroker.getScoped(...)`.
 *
 * All CRUD here is Approve-tier (Bearer required). Secrets never appear
 * in any response body — the GET payload reports `tokenStored: boolean`
 * for `pat-keychain` aliases so the dashboard can render a populated
 * vs empty state without reading the secret.
 */

import { Hono } from "hono";
import {
  applyConfigUpdates,
  type ConfigUpdateResult,
} from "../env-writer.js";
import {
  createSettingsStore,
  type SettingsStore,
} from "../../settings/settings-store.js";
import {
  GIT_ACCOUNT_ALIAS_PATTERN,
  gitAccountSchema,
  type GitAccountSetting,
} from "../../settings/runtime-settings.js";
import {
  GitAccountRegistry,
  probeGitAccount,
} from "../../services/git-account-registry.js";
import { scopedSecretName } from "../../secrets/secret-names.js";
import type { ApiDependencies } from "../server.js";
import { createLogger, toSafeErrorMessage } from "../../logging.js";
import { readJsonBody } from "../json-body.js";

const logger = createLogger("git-accounts-api");

const ALIAS_MAX_LENGTH = 40;
const TOKEN_MAX_BYTES = 4096; // PATs are < 100 chars; 4KiB is generous + safe.

function isValidAlias(value: string | undefined): value is string {
  /* c8 ignore next -- unreachable via HTTP: Hono path params are always non-empty strings */
  if (!value) return false;
  if (value.length === 0 || value.length > ALIAS_MAX_LENGTH) return false;
  return GIT_ACCOUNT_ALIAS_PATTERN.test(value);
}

interface GitAccountsRouteDeps {
  config: ApiDependencies["config"];
  secretBroker: ApiDependencies["secretBroker"];
  settingsStore: SettingsStore;
  registry: GitAccountRegistry;
}

export function createGitAccountsRoutes(deps: ApiDependencies): Hono {
  const settingsStore = createSettingsStore(deps.db);
  // Prefer the daemon-built registry threaded through ApiDependencies
  // so observers and the probe endpoint share one instance (and one
  // askpass-materialization latch). Tests that mount the route in
  // isolation can fall through to a locally-built stand-in.
  const registry =
    deps.gitAccountRegistry
    ?? new GitAccountRegistry({
      dataDir: deps.config.dataDir,
      secretBroker: deps.secretBroker,
      getAccounts: () => deps.config.gitAccounts,
    });
  return wireRoutes({
    config: deps.config,
    secretBroker: deps.secretBroker,
    settingsStore,
    registry,
  });
}

function wireRoutes(deps: GitAccountsRouteDeps): Hono {
  const app = new Hono();

  /**
   * GET /api/git-accounts — list all accounts. Returns metadata only;
   * no token values or `gh` CLI output.
   */
  app.get("/git-accounts", async (c) => {
    const aliases = Object.entries(deps.config.gitAccounts ?? {}).map(
      ([alias, account]) => ({ alias, account }),
    );
    aliases.sort((a, b) => a.alias.localeCompare(b.alias));
    const enriched = await Promise.all(
      aliases.map(async ({ alias, account }) => {
        const tokenStored =
          account.authMode === "pat-keychain"
            ? await deps.secretBroker.hasScoped(
                scopedSecretName("git.account", alias),
              )
            : null;
        return {
          alias,
          type: account.type,
          authMode: account.authMode,
          ghProfile: account.ghProfile ?? null,
          host: account.host || "github.com",
          tokenStored,
        };
      }),
    );
    return c.json({ accounts: enriched });
  });

  /** GET /api/git-accounts/:alias — single-account read. */
  app.get("/git-accounts/:alias", async (c) => {
    const alias = c.req.param("alias");
    if (!isValidAlias(alias)) {
      return c.json({ error: "invalid_alias" }, 400);
    }
    const account = deps.config.gitAccounts?.[alias];
    if (!account) return c.json({ error: "not_found" }, 404);
    const tokenStored =
      account.authMode === "pat-keychain"
        ? await deps.secretBroker.hasScoped(
            scopedSecretName("git.account", alias),
          )
        : null;
    return c.json({
      alias,
      type: account.type,
      authMode: account.authMode,
      ghProfile: account.ghProfile ?? null,
      host: account.host || "github.com",
      tokenStored,
    });
  });

  /**
   * PUT /api/git-accounts/:alias — upsert metadata + (optional)
   * inline-token write. The Zod-derived `gitAccountSchema` validates
   * the body shape; `applyConfigUpdates` re-validates the entire
   * `gitAccounts` record so a malformed entry rejects atomically.
   *
   * Body shape:
   *   { type, authMode, ghProfile?, host?, token? }
   *
   * `token` is optional — if present, it's written to the keychain at
   * `git.account.<alias>` and stripped from the persisted record.
   * Future updates that omit `token` keep the previously-stored secret.
   */
  app.put("/git-accounts/:alias", async (c) => {
    const alias = c.req.param("alias");
    if (!isValidAlias(alias)) {
      return c.json({ error: "invalid_alias" }, 400);
    }
    const parsed = await readJsonBody(c, { maxBytes: TOKEN_MAX_BYTES });
    if (!parsed.ok) return parsed.response;
    const body = parsed.body as Record<string, unknown>;
    const tokenRaw = body.token;
    const tokenString = typeof tokenRaw === "string" ? tokenRaw : undefined;
    if (tokenString !== undefined && tokenString.length === 0) {
      return c.json(
        { error: "invalid_body", message: "token must be non-empty when supplied" },
        400,
      );
    }

    // Strip `token` before schema validation — it isn't part of the
    // persisted shape; it routes to the keychain instead.
    const candidate = { ...body };
    delete candidate.token;
    const accountParse = gitAccountSchema.safeParse(candidate);
    if (!accountParse.success) {
      return c.json(
        {
          error: "invalid_body",
          issues: accountParse.error.issues,
        },
        400,
      );
    }

    const next: GitAccountSetting = accountParse.data;
    if (next.authMode === "pat-keychain" && !tokenString) {
      const existing = await deps.secretBroker.hasScoped(
        scopedSecretName("git.account", alias),
      );
      if (!existing) {
        return c.json(
          {
            error: "token_required",
            message:
              "pat-keychain accounts require a token on first creation; supply 'token' in the body.",
          },
          400,
        );
      }
    }

    const merged = {
      ...(deps.config.gitAccounts ?? {}),
      [alias]: next,
    };
    const result: ConfigUpdateResult = await applyConfigUpdates(
      deps.config,
      deps.settingsStore,
      { gitAccounts: merged },
    );
    if (Object.keys(result.errors).length > 0) {
      return c.json(
        { error: "validation_failed", errors: result.errors },
        400,
      );
    }

    if (tokenString) {
      try {
        await deps.secretBroker.setScoped(
          scopedSecretName("git.account", alias),
          tokenString,
        );
      } catch (err) {
        logger.error(
          { alias, err },
          "Failed to write git account token to keychain",
        );
        return c.json(
          { error: "secret_write_failed", message: toSafeErrorMessage(err) },
          500,
        );
      }
    }

    logger.info(
      { alias, authMode: next.authMode, tokenWritten: Boolean(tokenString) },
      "Git account upserted",
    );
    return c.json({ ok: true, alias });
  });

  /**
   * DELETE /api/git-accounts/:alias — remove the metadata entry AND
   * delete the keychain secret if present. Repos still pointing at the
   * alias keep polling without env injection (see the resolver fallback
   * in observers/git-watcher.ts and observers/github-poller.ts).
   */
  app.delete("/git-accounts/:alias", async (c) => {
    const alias = c.req.param("alias");
    if (!isValidAlias(alias)) {
      return c.json({ error: "invalid_alias" }, 400);
    }
    if (!deps.config.gitAccounts?.[alias]) {
      return c.json({ error: "not_found" }, 404);
    }
    const remaining = { ...deps.config.gitAccounts };
    delete remaining[alias];
    const result = await applyConfigUpdates(deps.config, deps.settingsStore, {
      gitAccounts: remaining,
    });
    if (Object.keys(result.errors).length > 0) {
      return c.json(
        { error: "validation_failed", errors: result.errors },
        400,
      );
    }
    try {
      await deps.secretBroker.deleteScoped(
        scopedSecretName("git.account", alias),
      );
    } catch (err) {
      // Secret deletion failures are non-fatal — the metadata is gone, so
      // the keychain entry is now an orphan but inert. Log so an operator
      // can clean up if they care.
      logger.warn(
        { alias, err },
        "Git account metadata removed, keychain delete failed",
      );
    }
    logger.info({ alias }, "Git account removed");
    return c.json({ ok: true, alias });
  });

  /**
   * POST /api/git-accounts/:alias/probe — verify credentials by calling
   * `gh api user --hostname X` with the resolved env. Returns the
   * authenticated login on success so the dashboard can warn when
   * `ghProfile` doesn't match the active account on the host.
   */
  app.post("/git-accounts/:alias/probe", async (c) => {
    const alias = c.req.param("alias");
    if (!isValidAlias(alias)) {
      return c.json({ error: "invalid_alias" }, 400);
    }
    if (!deps.config.gitAccounts?.[alias]) {
      return c.json({ error: "not_found" }, 404);
    }
    const result = await probeGitAccount(deps.registry, alias);
    if (result.ok) {
      return c.json({ ok: true, login: result.login, host: result.host });
    }
    return c.json({ ok: false, reason: result.reason }, 200);
  });

  return app;
}
