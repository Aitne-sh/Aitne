import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import {
  CryptoProvider,
  type AuthenticationResult,
  type PublicClientApplication,
} from "@azure/msal-node";
import {
  buildLoopbackRedirectUri,
  OUTLOOK_LOOPBACK_REDIRECT_HOST,
  OUTLOOK_LOOPBACK_REDIRECT_PATH,
  OUTLOOK_SCOPES,
  type OutlookClientConfig,
} from "./client-config.js";
import { createBootstrapMsalApp } from "./msal-app-factory.js";
import { createLogger } from "../../../logging.js";

const logger = createLogger("outlook-oauth-loopback");

export class OAuthLoopbackTimeoutError extends Error {
  readonly code = "oauth_timeout";
  constructor(timeoutMs: number) {
    super(`OAuth loopback timed out after ${timeoutMs}ms`);
    this.name = "OAuthLoopbackTimeoutError";
  }
}

export class OAuthLoopbackError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "OAuthLoopbackError";
  }
}

/**
 * §4 — strict Origin/Referer check on the callback as defence-in-depth for
 * the socket-bind race (a same-user attacker binding :port first). PKCE state
 * is the primary defence; this adds a cheap second layer.
 *
 * Referer absence is accepted because modern browsers strip Referer on
 * HTTPS→HTTP transitions by default (Chrome: strict-origin-when-cross-origin).
 * When it IS present, the host must end with a Microsoft identity domain.
 * Same rule for Origin.
 */
const ALLOWED_REFERER_SUFFIXES = [
  "login.microsoftonline.com",
  "login.microsoft.com",
  "login.live.com",
  "login.windows.net",
];

export function isReferrerAllowed(rawValue: string | null | undefined): boolean {
  if (!rawValue) return true; // absent — browser stripped it; state+PKCE still protect
  try {
    const url = new URL(rawValue);
    const host = url.hostname.toLowerCase();
    return ALLOWED_REFERER_SUFFIXES.some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`),
    );
  } catch {
    return false;
  }
}

export interface LoopbackOAuthResult {
  authResult: AuthenticationResult;
  serializedCache: string;
  email: string;
}

export interface LoopbackOAuthDeps {
  clientConfig: OutlookClientConfig;
  /** Override for tests. Receives the auth URL and is expected to "open" the browser. */
  openBrowser?: (url: string) => Promise<unknown> | void;
  /** Override for tests. Total wait time across the loopback exchange. */
  timeoutMs?: number;
  /** Override the MSAL app factory (used by unit tests). */
  appFactory?: (config: OutlookClientConfig) => PublicClientApplication;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 min — user has to grant consent

/**
 * End-to-end loopback PKCE flow (§6.1).
 *
 * 1. Generate PKCE codes via MSAL's CryptoProvider.
 * 2. Bind an ephemeral http.Server on 127.0.0.1.
 * 3. Build the auth URL with the resulting redirect URI.
 * 4. Open the user's browser via {@link LoopbackOAuthDeps.openBrowser}.
 * 5. Wait for the redirect, validate state, exchange code for tokens.
 * 6. Serialize the in-memory cache for the caller to persist via
 *    MailAccountRegistry.addAccount(secretPayload).
 *
 * The server is closed under all exit paths (success, error, timeout). State
 * is single-use and validated via constant-time-ish equality.
 */
export async function runLoopbackOAuth(deps: LoopbackOAuthDeps): Promise<LoopbackOAuthResult> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const appFactory = deps.appFactory ?? createBootstrapMsalApp;
  const app = appFactory(deps.clientConfig);

  const cryptoProvider = new CryptoProvider();
  const { verifier, challenge } = await cryptoProvider.generatePkceCodes();
  const state = randomUUID();

  const { server, port } = await bindLoopback();
  const redirectUri = buildLoopbackRedirectUri(port);

  try {
    const authUrl = await app.getAuthCodeUrl({
      scopes: [...OUTLOOK_SCOPES],
      redirectUri,
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      state,
      prompt: "select_account",
    });

    const codePromise = waitForAuthorizationCode(server, state, timeoutMs);

    const opener = deps.openBrowser ?? defaultOpenBrowser;
    try {
      await opener(authUrl);
    } catch (err) {
      throw new OAuthLoopbackError(
        "browser_open_failed",
        `Could not open browser. Falling back to device-code is the recommended path. Underlying: ${
          (err as Error).message
        }`,
      );
    }

    const code = await codePromise;
    const authResult = await app.acquireTokenByCode({
      code,
      scopes: [...OUTLOOK_SCOPES],
      redirectUri,
      codeVerifier: verifier,
    });

    if (!authResult.account?.username) {
      throw new OAuthLoopbackError(
        "missing_account",
        "MSAL did not return an account username — cannot persist Outlook account.",
      );
    }

    const serializedCache = app.getTokenCache().serialize();
    return {
      authResult,
      serializedCache,
      email: authResult.account.username,
    };
  } finally {
    await closeServer(server);
  }
}

async function bindLoopback(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (err) => reject(err));
    server.listen(0, OUTLOOK_LOOPBACK_REDIRECT_HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("loopback server failed to bind a port"));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

function waitForAuthorizationCode(
  server: Server,
  expectedState: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new OAuthLoopbackTimeoutError(timeoutMs));
    }, timeoutMs);

    const onRequest = (req: IncomingMessage, res: ServerResponse) => {
      try {
        if (!req.url) {
          respondHtml(res, 400, "Missing URL");
          return;
        }
        const url = new URL(req.url, `http://${OUTLOOK_LOOPBACK_REDIRECT_HOST}`);
        if (url.pathname !== OUTLOOK_LOOPBACK_REDIRECT_PATH) {
          respondHtml(res, 404, "Not found");
          return;
        }

        // §4 strict Origin/Referer check — reject if present and not from a
        // Microsoft identity domain. Missing values are accepted because
        // browsers commonly strip Referer on HTTPS→HTTP redirects.
        const refererHeader = firstHeader(req.headers.referer);
        const originHeader = firstHeader(req.headers.origin);
        if (!isReferrerAllowed(refererHeader) || !isReferrerAllowed(originHeader)) {
          respondHtml(
            res,
            400,
            "Callback rejected: request origin does not look like a Microsoft sign-in page.",
          );
          clearTimeout(timer);
          server.off("request", onRequest);
          reject(
            new OAuthLoopbackError(
              "origin_mismatch",
              `Unexpected Origin/Referer: referer=${refererHeader ?? "∅"} origin=${originHeader ?? "∅"}`,
            ),
          );
          return;
        }

        const error = url.searchParams.get("error");
        if (error) {
          const description = url.searchParams.get("error_description") ?? "";
          respondHtml(
            res,
            400,
            `Authorization failed: ${escapeHtml(error)} ${escapeHtml(description)}`,
          );
          clearTimeout(timer);
          server.off("request", onRequest);
          reject(new OAuthLoopbackError("authorization_denied", `${error}: ${description}`));
          return;
        }

        const state = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        if (!state || state !== expectedState) {
          respondHtml(res, 400, "Invalid OAuth state — start the flow again.");
          clearTimeout(timer);
          server.off("request", onRequest);
          reject(new OAuthLoopbackError("state_mismatch", "OAuth state mismatch"));
          return;
        }
        if (!code) {
          respondHtml(res, 400, "Missing authorization code.");
          clearTimeout(timer);
          server.off("request", onRequest);
          reject(new OAuthLoopbackError("missing_code", "No authorization code in callback"));
          return;
        }

        respondHtml(
          res,
          200,
          "Authorization successful. You can close this window and return to the dashboard.",
        );
        clearTimeout(timer);
        server.off("request", onRequest);
        resolve(code);
      } catch (err) {
        logger.error({ err }, "loopback handler error");
        respondHtml(res, 500, "Internal error in loopback handler");
        clearTimeout(timer);
        server.off("request", onRequest);
        reject(err);
      }
    };

    server.on("request", onRequest);
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

function respondHtml(res: ServerResponse, status: number, message: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(
    `<!doctype html><html><body style="font-family:system-ui;text-align:center;padding:60px"><h2>${escapeHtml(
      message,
    )}</h2></body></html>`,
  );
}

function firstHeader(value: string | string[] | undefined): string | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function defaultOpenBrowser(url: string): Promise<void> {
  // Lazily imported so unit tests don't pull in the cross-platform spawn deps.
  const open = (await import("open")).default;
  await open(url);
}
