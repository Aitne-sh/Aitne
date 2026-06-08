import type { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { loopbackOrigins, resolveDashboardPort } from "@aitne/shared";
import type { ApiDependencies } from "../../server.js";
import {
  getGoogleOAuthClientConfig,
  parseGoogleCredentialsJson,
} from "../../../services/google-auth.js";
import { createLogger, toSafeErrorMessage } from "../../../logging.js";

const MAX_UPLOAD_SIZE = 100 * 1024; // 100 KB — credential files are small
const MAX_OAUTH_STATE_AGE_MS = 10 * 60 * 1000;

/** Escape HTML special characters to prevent XSS */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

const logger = createLogger("dashboard-api");

export function registerOauthGoogleRoutes(app: Hono, deps: ApiDependencies): void {
  const { config, services, secretBroker } = deps;
  const oauthStates = new Map<string, { createdAt: number; dashboardOrigin: string }>();

  // Dashboard-origin allowlist for OAuth start / callback.
  //
  // The OAuth callback HTML uses `window.opener.postMessage(..., target)`
  // to notify the dashboard that auth succeeded. `target` was previously
  // derived from the Origin/Referer headers at start time with a
  // `http://localhost:<dashboard port>` fallback when neither was present. Both
  // headers are attacker-controlled in the request that *initiates* the
  // flow (the attacker's page can be `http://attacker.com`), so the
  // postMessage notification could be steered off the trusted dashboard.
  //
  // The notification body is just `{type: "google-auth-success"}` — no
  // tokens — but the attacker would still learn the user completed auth,
  // and a future widening of the payload would leak silently. Defence is
  // a closed allowlist: only same-origin localhost variants on the
  // configured dashboard port are accepted; anything else rejects the
  // OAuth start with 403. `loopbackOrigins` covers all three loopback
  // forms — the `[::1]` variant matters because some IPv6-first
  // environments (Docker Desktop with IPv6 preference, certain Node
  // IPv6-first configs) emit it, and URL.origin returns the bracketed
  // literal.
  const allowedDashboardOrigins: ReadonlySet<string> = new Set(
    loopbackOrigins(resolveDashboardPort()),
  );

  function parseOriginSafely(value: string | undefined): string | null {
    if (!value) return null;
    try {
      return new URL(value).origin;
    } catch {
      return null;
    }
  }

  /**
   * Return the request's claimed dashboard origin only if it matches the
   * hardcoded allowlist. Origin is preferred (browser-set, never spoofable
   * from page JS); Referer is the fallback for browsers / configurations
   * that don't emit Origin on top-level navigations. Returns `null` when
   * neither header maps to an allowed origin — callers must reject the
   * request in that case rather than silently defaulting.
   */
  function resolveAllowedDashboardOrigin(
    originHeader: string | undefined,
    refererHeader: string | undefined,
  ): string | null {
    const fromOrigin = parseOriginSafely(originHeader);
    if (fromOrigin && allowedDashboardOrigins.has(fromOrigin)) return fromOrigin;
    const fromReferer = parseOriginSafely(refererHeader);
    if (fromReferer && allowedDashboardOrigins.has(fromReferer)) return fromReferer;
    return null;
  }

  function pruneOauthStates(now = Date.now()): void {
    for (const [state, data] of oauthStates.entries()) {
      if (now - data.createdAt > MAX_OAUTH_STATE_AGE_MS) {
        oauthStates.delete(state);
      }
    }
  }

  /** POST /config/upload/google-credentials — upload Google Calendar credentials JSON */
  app.post("/config/upload/google-credentials", async (c) => {
    const body = await c.req.parseBody();
    const file = body["file"];
    if (!file || !(file instanceof File)) {
      return c.json({ error: "No file uploaded. Send as multipart with field name 'file'" }, 400);
    }
    if (file.size > MAX_UPLOAD_SIZE) {
      return c.json({ error: `File too large (max ${MAX_UPLOAD_SIZE / 1024} KB)` }, 400);
    }

    const content = await file.text();

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content) as Record<string, unknown>;
    } catch {
      return c.json({ error: "Invalid JSON file" }, 400);
    }

    // Basic validation: must be OAuth2 (installed/web) or service account
    const obj = parsed as Record<string, unknown>;
    if (!obj.installed && !obj.web && obj.type !== "service_account") {
      return c.json({ error: "Invalid credentials format. Expected OAuth2 credentials JSON (with 'installed' or 'web' key) or a service account JSON." }, 400);
    }

    await secretBroker.set("googleCredentialsJson", content);
    if (parsed.type === "service_account") {
      await secretBroker.delete("googleTokenJson");
    }
    await deps.onSecretChanged?.("google");
    deps.onGoogleServicesReady?.();

    return c.json({
      status: "uploaded",
      path: "keychain://google-credentials",
      requiresRestart: false,
      message: "Credentials saved.",
    });
  });

  /** POST /config/upload/google-token — upload Google Calendar OAuth token JSON */
  app.post("/config/upload/google-token", async (c) => {
    const body = await c.req.parseBody();
    const file = body["file"];
    if (!file || !(file instanceof File)) {
      return c.json({ error: "No file uploaded. Send as multipart with field name 'file'" }, 400);
    }
    if (file.size > MAX_UPLOAD_SIZE) {
      return c.json({ error: `File too large (max ${MAX_UPLOAD_SIZE / 1024} KB)` }, 400);
    }

    const content = await file.text();

    // Validate JSON
    try {
      JSON.parse(content);
    } catch {
      return c.json({ error: "Invalid JSON file" }, 400);
    }

    await secretBroker.saveGoogleTokenJson(content);
    await deps.onSecretChanged?.("google");
    deps.onGoogleServicesReady?.();

    return c.json({
      status: "uploaded",
      path: "keychain://google-token",
      requiresRestart: false,
      message: "Token saved.",
    });
  });

  // ── Google OAuth2 Authorization Flow ──
  // Allows users to authenticate with just credentials.json — the daemon
  // handles the full OAuth2 flow and saves the token automatically.

  /** POST /config/google-auth/start — begin OAuth2 authorization */
  app.post("/config/google-auth/start", async (c) => {
    const credRaw = await secretBroker.getGoogleCredentialsJson();
    if (!credRaw) {
      return c.json({ error: "Upload credentials.json first" }, 400);
    }

    let cred: Record<string, unknown>;
    try {
      cred = parseGoogleCredentialsJson(credRaw);
    } catch {
      return c.json({ error: "Credentials JSON is invalid. Upload it again." }, 400);
    }

    // Service accounts don't need OAuth2 authorization
    if (cred.type === "service_account") {
      return c.json({ error: "Service account credentials don't require OAuth authorization. Restart the daemon to activate." }, 400);
    }

    const clientConfig = getGoogleOAuthClientConfig(cred);
    if (!clientConfig) {
      return c.json({ error: "Invalid credentials format" }, 400);
    }

    let google: typeof import("googleapis").google;
    try {
      const mod = (await import("googleapis" as string)) as typeof import("googleapis");
      google = mod.google;
    } catch {
      return c.json({ error: "googleapis package not installed" }, 500);
    }

    // Use daemon's own port for the OAuth callback.
    // Use 127.0.0.1, not localhost: daemon binds IPv4 loopback only; on Windows localhost resolves to ::1 first and the callback would ECONNREFUSED. Google special-cases loopback redirects for installed-app clients.
    const redirectUri = `http://127.0.0.1:${config.apiPort}/api/config/google-auth/callback`;

    const oauth2Client = new google.auth.OAuth2(
      clientConfig.client_id,
      clientConfig.client_secret,
      redirectUri,
    );

    // Request scopes for Calendar + Gmail
    const scopes = [
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.send",
    ];

    pruneOauthStates();
    const state = randomUUID();
    // Capture the dashboard origin so the callback can postMessage to the
    // correct window. Origin/Referer must match the closed allowlist or
    // the flow is refused — defending the postMessage target from the
    // class of attacks described next to `allowedDashboardOrigins`.
    const dashboardOrigin = resolveAllowedDashboardOrigin(
      c.req.header("origin"),
      c.req.header("referer"),
    );
    if (!dashboardOrigin) {
      return c.json(
        {
          error: "untrusted_origin",
          message:
            "OAuth flows must be initiated from the configured dashboard origin",
        },
        403,
      );
    }
    oauthStates.set(state, { createdAt: Date.now(), dashboardOrigin });

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: scopes,
      prompt: "consent", // Force consent to always get a refresh_token
      state,
    });

    return c.json({ authUrl, redirectUri, scopes });
  });

  /** GET /config/google-auth/callback — OAuth2 redirect handler */
  app.get("/config/google-auth/callback", async (c) => {
    const code = c.req.query("code");
    const error = c.req.query("error");
    const state = c.req.query("state");

    if (error) {
      return c.html(`<!DOCTYPE html><html><body style="font-family:system-ui;text-align:center;padding:60px">
        <h2 style="color:#dc2626">Authorization Failed</h2>
        <p>${escapeHtml(error)}</p>
        <p style="color:#666;font-size:14px">You can close this window.</p>
      </body></html>`);
    }

    pruneOauthStates();
    const stateData = state ? oauthStates.get(state) : undefined;
    if (!state || !stateData) {
      return c.html(`<!DOCTYPE html><html><body style="font-family:system-ui;text-align:center;padding:60px">
        <h2 style="color:#dc2626">Authorization Failed</h2>
        <p>Invalid or expired OAuth state.</p>
        <p style="color:#666;font-size:14px">Start the authorization flow again from the dashboard.</p>
      </body></html>`);
    }
    const { dashboardOrigin } = stateData;
    oauthStates.delete(state);

    // Defence-in-depth: the start handler already gates Origin/Referer
    // against `allowedDashboardOrigins`, so a stored value should always
    // pass this check. Re-validate before injecting into the callback
    // HTML so a future code change that drops the start-side gate
    // doesn't silently regress the postMessage target.
    if (!allowedDashboardOrigins.has(dashboardOrigin)) {
      logger.warn(
        { dashboardOrigin },
        "OAuth callback refused — stored dashboard origin not in allowlist",
      );
      return c.html(`<!DOCTYPE html><html><body style="font-family:system-ui;text-align:center;padding:60px">
        <h2 style="color:#dc2626">Authorization Failed</h2>
        <p>Untrusted dashboard origin.</p>
      </body></html>`);
    }

    if (!code) {
      return c.html(`<!DOCTYPE html><html><body style="font-family:system-ui;text-align:center;padding:60px">
        <h2 style="color:#dc2626">Error</h2>
        <p>No authorization code received.</p>
      </body></html>`);
    }

    // Re-create OAuth2 client from stored credentials
    const credRaw = await secretBroker.getGoogleCredentialsJson();
    if (!credRaw) {
      return c.html(`<!DOCTYPE html><html><body style="font-family:system-ui;text-align:center;padding:60px">
        <h2 style="color:#dc2626">Error</h2>
        <p>Credentials not configured.</p>
      </body></html>`);
    }

    try {
      const cred = parseGoogleCredentialsJson(credRaw);
      const clientConfig = getGoogleOAuthClientConfig(cred);
      if (!clientConfig) throw new Error("Invalid credentials");

      const mod = await import("googleapis" as string);
      const google = mod.google;

      // Use 127.0.0.1, not localhost: must byte-match the auth-start redirect_uri (Google re-validates an exact string at getToken); daemon binds IPv4 loopback only, and on Windows localhost resolves to ::1 first.
      const redirectUri = `http://127.0.0.1:${config.apiPort}/api/config/google-auth/callback`;
      const oauth2Client = new google.auth.OAuth2(
        clientConfig.client_id,
        clientConfig.client_secret,
        redirectUri,
      );

      // Exchange authorization code for tokens
      const { tokens } = await oauth2Client.getToken(code);
      await secretBroker.saveGoogleTokenJson(JSON.stringify(tokens));
      await deps.onSecretChanged?.("google");
      deps.onGoogleServicesReady?.();

      const statusMsg =
        services.calendar || services.gmail
          ? "Services activated."
          : "Token saved.";

      return c.html(`<!DOCTYPE html><html><body style="font-family:system-ui;text-align:center;padding:60px">
        <h2 style="color:#059669">Authorization Successful</h2>
        <p>${escapeHtml(statusMsg)}</p>
        <p style="color:#666;font-size:14px">You can close this window.</p>
        <script>
          if (window.opener) {
            window.opener.postMessage({ type: "google-auth-success" }, ${JSON.stringify(dashboardOrigin)});
          }
        </script>
      </body></html>`);
    } catch (err) {
      const msg = toSafeErrorMessage(err, "Unknown error");
      return c.html(`<!DOCTYPE html><html><body style="font-family:system-ui;text-align:center;padding:60px">
        <h2 style="color:#dc2626">Token Exchange Failed</h2>
        <p>${escapeHtml(msg)}</p>
        <p style="color:#666;font-size:14px">You can close this window and try again.</p>
      </body></html>`);
    }
  });
}
