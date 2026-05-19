/**
 * GitAccountRegistry — resolves per-alias credentials for multi-account
 * Git/GitHub setups (P5 of `docs/design/backlog/git-lifecycle-and-triggers.md`).
 *
 * Two auth modes:
 *   • `pat-keychain`: PAT stored in the OS keychain at `git.account.<alias>`
 *     and fetched via `SecretBroker.getScoped(...)`. Owner-supplied via the
 *     dashboard or `PUT /api/git-accounts/:alias/token`.
 *   • `gh-cli-profile`: token resolved on demand via `gh auth token --user
 *     <ghProfile> --hostname <host>`. `gh` remains the credential source of
 *     truth — token rotation, revocation, and SSO refresh continue to flow
 *     through `gh auth login` / `gh auth refresh`.
 *
 * The registry exposes two APIs:
 *   • `resolveCredentials(alias)` returns the active token for an alias
 *     (cached per resolver instance during the surrounding poll cycle).
 *   • `buildSpawnEnv(alias, base)` overlays the credential variables
 *     (`GH_TOKEN`, `GITHUB_TOKEN`, `GIT_ASKPASS`, `PA_GIT_TOKEN`,
 *     `GIT_TERMINAL_PROMPT=0`) onto a base env block so an `execFile`
 *     against `gh` or `git` picks up the correct auth without disturbing
 *     the user's session-level `gh auth switch` state.
 *
 * Direct mode only — Delegated mode currently relies on the default `gh`
 * profile inside the spawned backend session. Plumbing per-account env
 * through `delegated-task-runtime` is a separate change tracked by P5
 * Decision 4 (third paragraph).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createLogger } from "../logging.js";
import type { SecretBroker } from "../secrets/secret-broker.js";
import { scopedSecretName } from "../secrets/secret-names.js";
import type { GitAccountSetting } from "../settings/runtime-settings.js";

const execFileAsync = promisify(execFile);
const logger = createLogger("git-account-registry");

/**
 * Wall-clock timeout for `gh auth token` resolution. The CLI is local —
 * five seconds is generous; longer suggests a stuck OAuth refresh that
 * should fail fast so the poll falls back to no env injection.
 */
const GH_TOKEN_RESOLVE_TIMEOUT_MS = 5_000;

/**
 * Askpass helpers echo `PA_GIT_TOKEN` followed by a single newline so
 * `git fetch` accepts the value as the password line. PATs / OAuth tokens
 * currently fit the character set this handles safely and have no embedded
 * newlines; if that credential contract changes, re-check both helpers.
 * POSIX intentionally uses `printf` instead of `echo` because some shells
 * treat backslashes specially.
 */
const ASKPASS_POSIX_BODY = "#!/bin/sh\n[ -n \"$PA_GIT_TOKEN\" ] && printf '%s\\n' \"$PA_GIT_TOKEN\"\n";
const ASKPASS_WINDOWS_BODY = "@echo off\r\nif defined PA_GIT_TOKEN echo(%PA_GIT_TOKEN%\r\n";
const ASKPASS_POSIX_RELATIVE_PATH = "runtime/git-askpass.sh";
const ASKPASS_WINDOWS_RELATIVE_PATH = "runtime/git-askpass.cmd";

function askpassBodyForPlatform(platform: NodeJS.Platform): string {
  return platform === "win32" ? ASKPASS_WINDOWS_BODY : ASKPASS_POSIX_BODY;
}

function askpassRelativePathForPlatform(platform: NodeJS.Platform): string {
  return platform === "win32"
    ? ASKPASS_WINDOWS_RELATIVE_PATH
    : ASKPASS_POSIX_RELATIVE_PATH;
}

export interface GitAccountSnapshot {
  alias: string;
  /** Defaults to `github.com` when unset by the user. */
  host: string;
  type: GitAccountSetting["type"];
  authMode: GitAccountSetting["authMode"];
  ghProfile?: string;
}

export interface GitAccountRegistryOptions {
  dataDir: string;
  secretBroker: SecretBroker;
  /**
   * Reader the registry consults at every call. The caller passes a
   * function rather than a snapshot so config PATCHes flow through
   * without re-instantiation.
   */
  getAccounts: () => Record<string, GitAccountSetting>;
  /**
   * Test seam — replaces the `gh auth token --user X --hostname Y` shell
   * call. Production uses `execFile("gh", ...)`.
   */
  ghTokenResolver?: (account: GitAccountSnapshot) => Promise<string | null>;
  /**
   * Test seam — overrides the askpass helper path. When unset, the
   * registry materializes `<dataDir>/runtime/git-askpass.{sh,cmd}` lazily
   * on first env build.
   */
  askpassPath?: string;
  /** Test seam — production uses `process.platform`. */
  platform?: NodeJS.Platform;
}

export interface GitSpawnCredentials {
  token: string;
  host: string;
}

/**
 * Output of `buildSpawnEnv`. The shape is identical to
 * `child_process.execFile`'s `env` option (string values only) so the
 * caller can spread directly into the options object.
 */
export type GitSpawnEnv = NodeJS.ProcessEnv;

export class GitAccountRegistry {
  private readonly dataDir: string;
  private readonly secretBroker: SecretBroker;
  private readonly getAccounts: () => Record<string, GitAccountSetting>;
  private readonly ghTokenResolver: (
    account: GitAccountSnapshot,
  ) => Promise<string | null>;
  private readonly platform: NodeJS.Platform;
  private readonly askpassPath: string;
  private askpassMaterialized = false;

  constructor(opts: GitAccountRegistryOptions) {
    this.dataDir = opts.dataDir;
    this.secretBroker = opts.secretBroker;
    this.getAccounts = opts.getAccounts;
    this.ghTokenResolver = opts.ghTokenResolver ?? defaultGhTokenResolver;
    this.platform = opts.platform ?? process.platform;
    this.askpassPath =
      opts.askpassPath
      ?? resolve(opts.dataDir, askpassRelativePathForPlatform(this.platform));
  }

  /**
   * Look up an account by alias. Returns null when the alias is unknown
   * (the caller treats this as "no per-call env" rather than an error —
   * a stray repo config left without an alias should poll, not silently
   * fail).
   */
  getAccount(alias: string): GitAccountSnapshot | null {
    const raw = this.getAccounts()[alias];
    if (!raw) return null;
    return {
      alias,
      host: raw.host || "github.com",
      type: raw.type,
      authMode: raw.authMode,
      ghProfile: raw.ghProfile,
    };
  }

  listAccounts(): GitAccountSnapshot[] {
    const accounts = this.getAccounts();
    return Object.entries(accounts)
      .map(([alias, raw]) => ({
        alias,
        host: raw.host || "github.com",
        type: raw.type,
        authMode: raw.authMode,
        ghProfile: raw.ghProfile,
      }))
      .sort((a, b) => a.alias.localeCompare(b.alias));
  }

  /**
   * Resolve the active credential for an alias. Returns null when the
   * alias is unknown OR the token store is empty (PAT path) or `gh auth
   * token` exits non-zero (CLI-profile path). Callers fall back to the
   * default `gh` profile in either case.
   */
  async resolveCredentials(
    alias: string,
  ): Promise<GitSpawnCredentials | null> {
    const account = this.getAccount(alias);
    if (!account) return null;
    if (account.authMode === "pat-keychain") {
      const token = await this.secretBroker.getScoped(
        scopedSecretName("git.account", alias),
      );
      if (!token) return null;
      return { token, host: account.host };
    }
    if (account.authMode === "gh-cli-profile") {
      const token = await this.ghTokenResolver(account);
      if (!token) return null;
      return { token, host: account.host };
    }
    // Exhaustiveness guard — narrows `account.authMode` to never. If a new
    // mode is added to the schema this branch surfaces it at compile time.
    /* c8 ignore next 4 */
    const _exhaustive: never = account.authMode;
    void _exhaustive;
    return null;
  }

  /**
   * Build a spawn-env overlay for an `execFile` against `gh` or `git`.
   * Returns `null` when the alias resolves to no credentials — callers
   * treat null as "use default `gh` profile" (observers continue to
   * fire under the daemon's own env). Returning a typed sentinel
   * instead of `base` unchanged means a future caller passing a custom
   * base cannot ambiguously confuse "no overlay" with a base that
   * happens to carry a stray `GH_TOKEN`.
   *
   * The overlay sets:
   *   • `GH_TOKEN` / `GITHUB_TOKEN` — picked up by `gh` automatically.
   *   • `GH_HOST` — only when the account uses a non-default host (GHES).
   *     Setting it on `github.com` is harmless but `gh` warns about it.
   *   • `GIT_ASKPASS` + `PA_GIT_TOKEN` + `GIT_TERMINAL_PROMPT=0` — for
   *     raw `git fetch` / `git ls-remote` against HTTPS remotes. The
   *     askpass script reads `PA_GIT_TOKEN` from the spawn env and
   *     writes it to stdout when git asks for a password.
   *     `GIT_TERMINAL_PROMPT=0` ensures git fails fast instead of
   *     blocking on a TTY prompt if the askpass script is somehow
   *     unreadable.
   */
  async buildSpawnEnv(
    alias: string | undefined,
    base: GitSpawnEnv = process.env,
  ): Promise<GitSpawnEnv | null> {
    if (!alias) return null;
    const creds = await this.resolveCredentials(alias);
    if (!creds) return null;

    this.ensureAskpass();

    const overlay: GitSpawnEnv = {
      ...base,
      GH_TOKEN: creds.token,
      GITHUB_TOKEN: creds.token,
      PA_GIT_TOKEN: creds.token,
      GIT_ASKPASS: this.askpassPath,
      GIT_TERMINAL_PROMPT: "0",
    };
    if (creds.host && creds.host !== "github.com") {
      overlay.GH_HOST = creds.host;
    }
    return overlay;
  }

  /**
   * Materialize the askpass helper under `<dataDir>/runtime/`. POSIX gets an
   * executable `git-askpass.sh`; Windows gets `git-askpass.cmd`, because Git
   * for Windows cannot execute a shebang shell script through CreateProcess.
   * Idempotent — content is identical across runs, so re-writing on every boot
   * is a no-op.
   *
   * Decision 1 (no client-side hook injection): the script lives entirely
   * inside `~/.personal-agent/`, so `aitne uninstall` removes it cleanly
   * when the dataDir is deleted.
   */
  private ensureAskpass(): void {
    if (this.askpassMaterialized) return;
    try {
      mkdirSync(dirname(this.askpassPath), { recursive: true });
      writeFileSync(this.askpassPath, askpassBodyForPlatform(this.platform), {
        encoding: "utf-8",
      });
      if (this.platform !== "win32") {
        chmodSync(this.askpassPath, 0o700);
      }
      this.askpassMaterialized = true;
    } catch (err) {
      // Materialization failures are non-fatal but worth logging — the
      // observer keeps polling with no env injection (which falls back to
      // the default gh profile). A warning surfaces the misconfig without
      // taking down the watcher.
      logger.warn(
        { err, askpassPath: this.askpassPath },
        "Failed to materialize git askpass helper — falling back to default gh profile",
      );
    }
  }

  /** Test-only: reset the materialization latch so a fresh boot path can re-write. */
  resetAskpassForTest(): void {
    this.askpassMaterialized = false;
  }

  /** Path of the askpass helper for diagnostic logging or tests. */
  getAskpassPath(): string {
    return this.askpassPath;
  }
}

/**
 * Default `gh auth token` resolver. Returns null on any non-zero exit;
 * callers treat that as "use default profile". Stderr is logged at debug
 * because a missing-account error is expected when an alias is misconfigured
 * mid-rotation.
 */
async function defaultGhTokenResolver(
  account: GitAccountSnapshot,
): Promise<string | null> {
  if (!account.ghProfile) return null;
  try {
    const { stdout } = await execFileAsync(
      "gh",
      [
        "auth",
        "token",
        "--user",
        account.ghProfile,
        "--hostname",
        account.host,
      ],
      { timeout: GH_TOKEN_RESOLVE_TIMEOUT_MS, encoding: "utf-8" },
    );
    const token = stdout.trim();
    return token.length > 0 ? token : null;
  } catch (err) {
    logger.debug(
      { alias: account.alias, host: account.host, err },
      "gh auth token resolution failed",
    );
    return null;
  }
}

/**
 * Probe a resolved credential by calling `gh api user --hostname X`.
 * Used by `POST /api/git-accounts/:alias/probe` to surface mis-paired
 * tokens before the user closes the dashboard. Returns
 * `{ok:true, login}` on success, `{ok:false, reason}` otherwise.
 *
 * Exported separately from the class because a probe is a one-shot
 * orchestration and shouldn't be reachable from random observer code —
 * keeping it as a free function makes the audit surface obvious.
 */
export async function probeGitAccount(
  registry: GitAccountRegistry,
  alias: string,
  options: { ghBin?: string; timeoutMs?: number } = {},
): Promise<
  | { ok: true; login: string; host: string }
  | { ok: false; reason: string }
> {
  const account = registry.getAccount(alias);
  if (!account) return { ok: false, reason: "unknown_alias" };
  const env = await registry.buildSpawnEnv(alias);
  if (!env || !env.GH_TOKEN) {
    return { ok: false, reason: "no_credential" };
  }
  try {
    const { stdout } = await execFileAsync(
      options.ghBin ?? "gh",
      ["api", "user", "--hostname", account.host, "--jq", ".login"],
      {
        env,
        timeout: options.timeoutMs ?? 10_000,
        encoding: "utf-8",
      },
    );
    const login = stdout.trim();
    if (!login) return { ok: false, reason: "empty_response" };
    return { ok: true, login, host: account.host };
  } catch (err) {
    /* c8 ignore next */
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("ENOENT")) return { ok: false, reason: "gh_missing" };
    if (message.includes("401")) return { ok: false, reason: "unauthorized" };
    if (message.includes("404")) return { ok: false, reason: "not_found" };
    return { ok: false, reason: "probe_failed" };
  }
}

/** Re-export for callers that already import the type from runtime-settings. */
export type { GitAccountSetting };

/** Test seam — also export the askpass bodies so tests can assert them byte-for-byte. */
export const __ASKPASS_BODY_FOR_TEST = ASKPASS_POSIX_BODY;
export const __ASKPASS_RELATIVE_PATH_FOR_TEST = ASKPASS_POSIX_RELATIVE_PATH;
export const __ASKPASS_WINDOWS_BODY_FOR_TEST = ASKPASS_WINDOWS_BODY;
export const __ASKPASS_WINDOWS_RELATIVE_PATH_FOR_TEST =
  ASKPASS_WINDOWS_RELATIVE_PATH;

/** Existence check for tests that materialize a registry and then assert the file. */
export function askpassFileExists(path: string): boolean {
  return existsSync(path);
}
