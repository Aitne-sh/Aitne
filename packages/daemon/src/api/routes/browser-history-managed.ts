/**
 * /api/browser-history/managed/* — dashboard control surface for the
 * managed Chromium Instance S.
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §7.7.
 *
 * Routes:
 *   GET  /status         — full state-machine snapshot for the dashboard
 *   POST /setup          — start interactive sign-in (spawn UI Chromium)
 *   GET  /setup-status   — poll bootstrap progress (signed-in yet?)
 *   POST /setup-finish   — finalise bootstrap (quit UI Chromium)
 *   POST /reconnect      — re-spawn UI Chromium reusing the profile dir
 *   POST /disconnect     — stop, delete profile dir, mark disconnected
 *   POST /enable         — toggle master enable / unsandboxedOptIn
 *
 * Risk-tier enforcement is centralised in `risk-classifier.ts`; this
 * module only needs to validate request bodies, route to the
 * supervisor / bootstrap modules, and shape the Zod-validated
 * response.
 */

import { Hono } from "hono";
import {
  managedChromiumActionResponseSchema,
  managedChromiumEnableRequestSchema,
  managedChromiumSetupStatusResponseSchema,
  managedChromiumStatusResponseSchema,
} from "@aitne/shared";

import {
  clearManagedChromiumState,
  readManagedChromiumState,
  updateManagedChromiumState,
} from "../../db/managed-chromium-state.js";
import { createLogger } from "../../logging.js";
import {
  disconnectInstanceS,
  finalizeBootstrap,
  getBootstrapStatus,
  killManagedChromiumBackground,
  startBootstrap,
} from "../../services/browser-history/managed-chromium/setup-bootstrap.js";
import { createHostProfile } from "../../services/browser-history/lifecycle/platform.js";
import type { ApiDependencies } from "../server.js";

const logger = createLogger("browser-history-managed-routes");

export function createBrowserHistoryManagedRoutes(deps: ApiDependencies): Hono {
  const app = new Hono();
  const host = createHostProfile();
  const paDataDir = deps.config.dataDir;

  app.get("/browser-history/managed/status", (c) => {
    const state = readManagedChromiumState(deps.db);
    const chromiumBinary = host.browserBinaryFor("chromium");
    const payload = managedChromiumStatusResponseSchema.parse({
      enabled: state.enabled,
      state: state.state,
      signedInUser: state.signedInUser,
      lastCheckAt: state.lastCheckAt,
      lastSyncAt: state.lastSyncAt,
      recentRowCount: state.recentRowCount,
      bootstrapInProgress: state.bootstrap !== null,
      bootstrapDeadlineAt: state.bootstrap?.deadlineAt ?? null,
      pausedUntil: state.pausedUntil,
      consecutiveFailures: state.consecutiveFailures,
      sandboxPrimitive: host.sandboxPrimitive.kind,
      hasDisplay: host.hasDisplay,
      chromiumBinaryFound: chromiumBinary !== null,
    });
    return c.json(payload);
  });

  app.post("/browser-history/managed/setup", async (c) => {
    const state = readManagedChromiumState(deps.db);
    if (!state.enabled) {
      return c.json({ error: "not_enabled" }, 409);
    }
    const result = await startBootstrap(
      { db: deps.db, host, paDataDir },
      { reauth: false },
    );
    const updated = readManagedChromiumState(deps.db);
    return c.json(
      managedChromiumActionResponseSchema.parse({
        ok: result.ok,
        state: updated.state,
        reason: result.reason,
      }),
      result.ok ? 200 : 409,
    );
  });

  app.get("/browser-history/managed/setup-status", async (c) => {
    const status = await getBootstrapStatus({ db: deps.db, paDataDir });
    if (status.state === "idle") {
      return c.json(
        managedChromiumSetupStatusResponseSchema.parse({
          state: "idle",
          pid: null,
          deadlineAt: null,
          signedIn: false,
          observedUser: null,
        }),
      );
    }
    return c.json(
      managedChromiumSetupStatusResponseSchema.parse({
        state: "running",
        pid: status.pid,
        deadlineAt: status.deadlineAt,
        signedIn: status.signedIn,
        observedUser: status.signedIn ? status.observedUser : null,
      }),
    );
  });

  app.post("/browser-history/managed/setup-finish", async (c) => {
    const result = await finalizeBootstrap({ db: deps.db, host, paDataDir });
    const updated = readManagedChromiumState(deps.db);
    return c.json(
      managedChromiumActionResponseSchema.parse({
        ok: result.ok,
        state: updated.state,
        reason: result.reason,
      }),
      result.ok ? 200 : 409,
    );
  });

  app.post("/browser-history/managed/reconnect", async (c) => {
    const state = readManagedChromiumState(deps.db);
    if (!state.enabled) {
      return c.json({ error: "not_enabled" }, 409);
    }
    const result = await startBootstrap(
      { db: deps.db, host, paDataDir },
      { reauth: true },
    );
    const updated = readManagedChromiumState(deps.db);
    return c.json(
      managedChromiumActionResponseSchema.parse({
        ok: result.ok,
        state: updated.state,
        reason: result.reason,
      }),
      result.ok ? 200 : 409,
    );
  });

  app.post("/browser-history/managed/disconnect", async (c) => {
    await disconnectInstanceS({ db: deps.db, host, paDataDir });
    clearManagedChromiumState(deps.db);
    updateManagedChromiumState(deps.db, (draft) => {
      draft.enabled = false;
      draft.state = "disconnected";
    });
    logger.info("managed Chromium disconnected");
    const updated = readManagedChromiumState(deps.db);
    return c.json(
      managedChromiumActionResponseSchema.parse({
        ok: true,
        state: updated.state,
      }),
    );
  });

  app.post("/browser-history/managed/enable", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = managedChromiumEnableRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    const sandboxKind = host.sandboxPrimitive.kind;
    if (parsed.data.enabled
      && sandboxKind === "none"
      && parsed.data.unsandboxedOptIn !== true) {
      // Operator must explicitly opt in to running unsandboxed.
      return c.json(
        managedChromiumActionResponseSchema.parse({
          ok: false,
          state: "missing_sandbox",
          reason: "missing_sandbox",
        }),
        409,
      );
    }
    const chromiumBinary = host.browserBinaryFor("chromium");
    if (parsed.data.enabled && chromiumBinary === null) {
      return c.json(
        managedChromiumActionResponseSchema.parse({
          ok: false,
          state: "missing_binary",
          reason: "missing_binary",
        }),
        409,
      );
    }
    // When disabling, terminate any active bootstrap UI Chromium and the
    // headless supervisor instance BEFORE clearing state — otherwise the
    // orphan reaper would only catch the bootstrap PID 15 min later, and
    // the headless instance would never be reaped (`cycleOnce` exits early
    // once `enabled=false`). The disconnect route shares this responsibility
    // via `disconnectInstanceS`; here we only need the no-data-loss path so
    // tear down without removing the profile dir.
    if (!parsed.data.enabled) {
      const current = readManagedChromiumState(deps.db);
      if (current.bootstrap) {
        await host.terminate(current.bootstrap.pid, "force").catch(() => {});
      }
      if (chromiumBinary) {
        try {
          await killManagedChromiumBackground(host, chromiumBinary, deps.config.dataDir);
        } catch (err) {
          logger.warn({ err }, "background Chromium termination during disable failed");
        }
      }
    }
    updateManagedChromiumState(deps.db, (draft) => {
      draft.enabled = parsed.data.enabled;
      draft.unsandboxedOptIn = parsed.data.unsandboxedOptIn ?? draft.unsandboxedOptIn;
      if (!parsed.data.enabled) {
        draft.state = "off";
        draft.bootstrap = null;
      } else if (draft.state === "off" || draft.state === "disconnected") {
        draft.state = "needs_setup";
      }
    });
    const updated = readManagedChromiumState(deps.db);
    return c.json(
      managedChromiumActionResponseSchema.parse({
        ok: true,
        state: updated.state,
      }),
    );
  });

  return app;
}
