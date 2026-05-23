/**
 * /api/browser-automation/sites/* — Phase B-2.5 per-site sign-in surface.
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §16.9.
 *
 * Routes:
 *   GET    /sites                          — list registered sites + per-site state
 *   POST   /sites/:siteKey/connect         — start sign-in (spawn UI Chromium)
 *   GET    /sites/:siteKey/status          — poll connection state during bootstrap
 *   POST   /sites/:siteKey/finalize        — confirm signed-in, kill UI window
 *   POST   /sites/:siteKey/reauth          — re-spawn UI Chromium reusing profile
 *   POST   /sites/:siteKey/disconnect      — kill processes + delete profile dir
 *
 * Risk-tier enforcement is centralised in `risk-classifier.ts`; this
 * module validates request shapes, defers to the bootstrap module, and
 * shapes the Zod-validated response. The runtime workflow-execution layer
 * (Playwright CDP probe) is excluded from coverage — this thin handler
 * matches the same exclusion rationale as `browser-history-managed.ts`.
 */

import {
  browserAutomationSiteActionResponseSchema,
  browserAutomationSitesResponseSchema,
  browserAutomationSiteStatusResponseSchema,
} from "@aitne/shared";
import { Hono } from "hono";

import { readManagedChromiumState } from "../../db/managed-chromium-state.js";
import {
  readSiteBootstrap,
  readSiteConnection,
} from "../../db/managed-chromium-sites-store.js";
import { createLogger } from "../../logging.js";
import {
  getSite,
  listSites,
  resolveSiteSurface,
  type SiteSurfaceState,
} from "../../services/browser-history/automation/site-registry.js";
import {
  disconnectSite,
  finalizeSiteBootstrap,
  getSiteBootstrapStatus,
  startSiteBootstrap,
} from "../../services/browser-history/managed-chromium/site-bootstrap.js";
import { createHostProfile } from "../../services/browser-history/lifecycle/platform.js";
import type { ApiDependencies } from "../server.js";

const logger = createLogger("browser-automation-sites-routes");

const SITE_KEY_REGEX = /^[a-z][a-z0-9_]*$/;

/** Map a `StartSiteBootstrapResult.reason` / similar code into the
 *  shared wire-level enum used by every site action response. */
function reasonToWire(
  reason:
    | "unknown_site"
    | "missing_binary"
    | "missing_sandbox"
    | "spawn_failed"
    | "already_running"
    | "not_running"
    | "not_signed_in"
    | undefined,
):
  | "unknown_site"
  | "missing_binary"
  | "missing_sandbox"
  | "spawn_failed"
  | "already_running"
  | "not_running"
  | "not_signed_in"
  | "managed_chromium_disabled"
  | undefined {
  return reason;
}

export function createBrowserAutomationSitesRoutes(deps: ApiDependencies): Hono {
  const app = new Hono();
  const host = createHostProfile();
  const paDataDir = deps.config.dataDir;

  // ── GET /sites ──
  app.get("/browser-automation/sites", (c) => {
    const now = Date.now();
    const sites = listSites().map((site) => {
      const conn = readSiteConnection(deps.db, site.siteKey);
      const bootstrap = readSiteBootstrap(deps.db, site.siteKey);
      const surface = resolveSiteSurface({
        site,
        connection: conn
          ? {
              connectedAt: conn.connectedAt,
              accountLabel: conn.accountLabel,
              lastWorkflowAt: conn.lastWorkflowAt,
            }
          : null,
        bootstrapRunning: bootstrap !== null && bootstrap.deadlineAt > now,
        nowMs: now,
      });
      return {
        siteKey: site.siteKey,
        displayName: site.displayName,
        state: surface.state,
        accountLabel: surface.accountLabel,
        connectedAt: surface.connectedAt,
        lastWorkflowAt: surface.lastWorkflowAt,
        sessionMaxAgeDays: site.sessionMaxAgeDays,
      };
    });
    return c.json(
      browserAutomationSitesResponseSchema.parse({ sites }),
    );
  });

  // ── POST /sites/:siteKey/connect ──
  app.post("/browser-automation/sites/:siteKey/connect", async (c) => {
    const siteKey = c.req.param("siteKey");
    if (!SITE_KEY_REGEX.test(siteKey)) {
      return c.json({ error: "invalid_site_key" }, 400);
    }
    const managed = readManagedChromiumState(deps.db);
    if (!managed.enabled) {
      return c.json(
        browserAutomationSiteActionResponseSchema.parse({
          ok: false,
          siteKey,
          state: currentSurfaceState(deps, siteKey),
          reason: "managed_chromium_disabled",
        }),
        409,
      );
    }
    if (!getSite(siteKey)) {
      return c.json(
        browserAutomationSiteActionResponseSchema.parse({
          ok: false,
          siteKey,
          state: "not_connected",
          reason: "unknown_site",
        }),
        404,
      );
    }
    const result = await startSiteBootstrap(
      { db: deps.db, host, paDataDir },
      { siteKey, reauth: false },
    );
    return c.json(
      browserAutomationSiteActionResponseSchema.parse({
        ok: result.ok,
        siteKey,
        state: currentSurfaceState(deps, siteKey),
        reason: result.ok ? undefined : reasonToWire(result.reason),
      }),
      result.ok ? 200 : 409,
    );
  });

  // ── GET /sites/:siteKey/status ──
  app.get("/browser-automation/sites/:siteKey/status", async (c) => {
    const siteKey = c.req.param("siteKey");
    if (!SITE_KEY_REGEX.test(siteKey)) {
      return c.json({ error: "invalid_site_key" }, 400);
    }
    if (!getSite(siteKey)) {
      return c.json({ error: "unknown_site" }, 404);
    }
    const status = await getSiteBootstrapStatus(
      { db: deps.db, paDataDir },
      siteKey,
    );
    if (status.state === "idle") {
      return c.json(
        browserAutomationSiteStatusResponseSchema.parse({
          siteKey,
          bootstrapRunning: false,
          pid: null,
          deadlineAt: null,
          signedIn: false,
          accountLabel: null,
        }),
      );
    }
    return c.json(
      browserAutomationSiteStatusResponseSchema.parse({
        siteKey,
        bootstrapRunning: true,
        pid: status.pid,
        deadlineAt: status.deadlineAt,
        signedIn: status.signedIn,
        // Prefer the *live probe's* extracted label so the dashboard
        // shows "Detected as Alice — click Finalize" before the user
        // commits. Fall back to the persisted connection row (relevant
        // only on a re-auth bootstrap where the previous connection
        // already wrote a label). Probe cap of 120 chars matches the
        // schema's accountLabel max.
        accountLabel: status.signedIn
          ? status.accountLabel
            ?? readSiteConnection(deps.db, siteKey)?.accountLabel
            ?? null
          : null,
      }),
    );
  });

  // ── POST /sites/:siteKey/finalize ──
  app.post("/browser-automation/sites/:siteKey/finalize", async (c) => {
    const siteKey = c.req.param("siteKey");
    if (!SITE_KEY_REGEX.test(siteKey)) {
      return c.json({ error: "invalid_site_key" }, 400);
    }
    if (!getSite(siteKey)) {
      return c.json(
        browserAutomationSiteActionResponseSchema.parse({
          ok: false,
          siteKey,
          state: "not_connected",
          reason: "unknown_site",
        }),
        404,
      );
    }
    const result = await finalizeSiteBootstrap(
      { db: deps.db, host, paDataDir },
      { siteKey },
    );
    return c.json(
      browserAutomationSiteActionResponseSchema.parse({
        ok: result.ok,
        siteKey,
        state: currentSurfaceState(deps, siteKey),
        reason: result.ok ? undefined : reasonToWire(result.reason),
      }),
      result.ok ? 200 : 409,
    );
  });

  // ── POST /sites/:siteKey/reauth ──
  app.post("/browser-automation/sites/:siteKey/reauth", async (c) => {
    const siteKey = c.req.param("siteKey");
    if (!SITE_KEY_REGEX.test(siteKey)) {
      return c.json({ error: "invalid_site_key" }, 400);
    }
    const managed = readManagedChromiumState(deps.db);
    if (!managed.enabled) {
      return c.json(
        browserAutomationSiteActionResponseSchema.parse({
          ok: false,
          siteKey,
          state: currentSurfaceState(deps, siteKey),
          reason: "managed_chromium_disabled",
        }),
        409,
      );
    }
    if (!getSite(siteKey)) {
      return c.json(
        browserAutomationSiteActionResponseSchema.parse({
          ok: false,
          siteKey,
          state: "not_connected",
          reason: "unknown_site",
        }),
        404,
      );
    }
    const result = await startSiteBootstrap(
      { db: deps.db, host, paDataDir },
      { siteKey, reauth: true },
    );
    return c.json(
      browserAutomationSiteActionResponseSchema.parse({
        ok: result.ok,
        siteKey,
        state: currentSurfaceState(deps, siteKey),
        reason: result.ok ? undefined : reasonToWire(result.reason),
      }),
      result.ok ? 200 : 409,
    );
  });

  // ── POST /sites/:siteKey/disconnect ──
  app.post("/browser-automation/sites/:siteKey/disconnect", async (c) => {
    const siteKey = c.req.param("siteKey");
    if (!SITE_KEY_REGEX.test(siteKey)) {
      return c.json({ error: "invalid_site_key" }, 400);
    }
    if (!getSite(siteKey)) {
      return c.json(
        browserAutomationSiteActionResponseSchema.parse({
          ok: false,
          siteKey,
          state: "not_connected",
          reason: "unknown_site",
        }),
        404,
      );
    }
    await disconnectSite(
      { db: deps.db, host, paDataDir },
      { siteKey },
    );
    logger.info({ siteKey }, "site disconnected (UI window killed + profile dir removed)");
    return c.json(
      browserAutomationSiteActionResponseSchema.parse({
        ok: true,
        siteKey,
        state: "not_connected",
      }),
    );
  });

  return app;
}

/** Lookup the current surface state for a site without re-running the
 *  full status probe — used by route handlers to render a consistent
 *  state value after a mutation. */
function currentSurfaceState(
  deps: ApiDependencies,
  siteKey: string,
): SiteSurfaceState {
  const site = getSite(siteKey);
  if (!site) return "not_connected";
  const now = Date.now();
  const conn = readSiteConnection(deps.db, siteKey);
  const bootstrap = readSiteBootstrap(deps.db, siteKey);
  return resolveSiteSurface({
    site,
    connection: conn
      ? {
          connectedAt: conn.connectedAt,
          accountLabel: conn.accountLabel,
          lastWorkflowAt: conn.lastWorkflowAt,
        }
      : null,
    bootstrapRunning: bootstrap !== null && bootstrap.deadlineAt > now,
    nowMs: now,
  }).state;
}
