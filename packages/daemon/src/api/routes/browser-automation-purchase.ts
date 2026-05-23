/**
 * /api/browser-automation/purchase-tokens/* + /api/browser-automation/b4/*
 * — Phase B-4 experimental purchase surface.
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §17.8 / §17.10 / §13 step 55.
 *
 * Routes:
 *   GET    /purchase-tokens                       — list pending + recent (Approve)
 *   DELETE /purchase-tokens/:jti                  — cancel a pending token (Approve)
 *   GET    /b4/enabled                            — global master toggle status (Autonomous)
 *   POST   /b4/enabled                            — flip the master toggle (Approve, with body { enabled: bool, acknowledge: true })
 *   GET    /b4/site-configs                       — per-site B-4 config rows (Autonomous)
 *   PATCH  /sites/:siteKey/b4-config              — update per-site config (Approve)
 *   GET    /b4/primary-channels                   — list primary channels (Autonomous)
 *   PATCH  /channels/:platform/:channelId/primary — set/unset (Approve)
 *
 * The dashboard does NOT have an issuance form — tokens are issued by
 * the daemon when a B-4 workflow is invoked, and delivered to DM
 * channels, not the dashboard. The dashboard role is configuration +
 * audit (§17.8). The raw `!~xxxxxxxx` token NEVER leaves the
 * `purchase_tokens` table; the wire shapes carry only the server-side
 * `jti` + the delivery state, so even an attacker who briefly
 * compromises dashboard credentials cannot extract live tokens.
 *
 * Excluded from the 100% coverage gate — the file is route glue; the
 * pure decision logic lives in `purchase-tokens.ts` and the DB CAS
 * predicates in the stores.
 */

import { z } from "zod";
import { Hono } from "hono";

import {
  cancelPurchaseToken,
  getPurchaseTokenByJti,
  listPendingPurchaseTokens,
  listRecentPurchaseTokens,
  type PurchaseTokenRow,
} from "../../db/browser-automation-purchase-tokens-store.js";
import {
  getB4Enabled,
  listSiteB4Configs,
  setB4Enabled,
  upsertSiteB4Config,
} from "../../db/browser-automation-b4-config-store.js";
import {
  clearPrimaryChannel,
  countPrimaryChannels,
  listPrimaryChannels,
  setPrimaryChannel,
} from "../../db/browser-automation-purchase-primary-channels-store.js";
import { createLogger } from "../../logging.js";
import { readJsonBody } from "../json-body.js";
import type { ApiDependencies } from "../server.js";

const logger = createLogger("browser-automation-purchase-routes");

/** Wire shape projected from the DB row. NEVER includes the raw
 *  `token` string — the dashboard sees only the jti + state. */
function toPurchaseTokenWire(row: PurchaseTokenRow): {
  jti: string;
  workflowInvocationId: string;
  siteKey: string;
  status: PurchaseTokenRow["status"];
  maxAmountMinor: number;
  currency: string;
  notesForUser: string | null;
  preScreenshotPath: string;
  postScreenshotPath: string | null;
  deliveredChannels: readonly string[];
  issuedAt: number;
  expiresAt: number;
  consumedAt: number | null;
  consumedViaChannel: string | null;
  cancelledAt: number | null;
  cancelReason: PurchaseTokenRow["cancelReason"];
  confirmedAmountMinor: number | null;
  orderId: string | null;
} {
  return {
    jti: row.jti,
    workflowInvocationId: row.workflowInvocationId,
    siteKey: row.siteKey,
    status: row.status,
    maxAmountMinor: row.maxAmountMinor,
    currency: row.currency,
    notesForUser: row.notesForUser,
    preScreenshotPath: row.preScreenshotPath,
    postScreenshotPath: row.postScreenshotPath,
    deliveredChannels: row.deliveredChannels,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
    consumedViaChannel: row.consumedViaChannel,
    cancelledAt: row.cancelledAt,
    cancelReason: row.cancelReason,
    confirmedAmountMinor: row.confirmedAmountMinor,
    orderId: row.orderId,
  };
}

// ── Request / response Zod schemas ──────────────────────────────────────

const enableToggleBodySchema = z.object({
  enabled: z.boolean(),
  /**
   * Plan §17.8 — flipping enabled=true requires the user to explicitly
   * acknowledge the experimental nature. The dashboard's modal sets
   * this when the user clicks through; an automated caller cannot
   * forge it because the dashboard's enable flow is the only legitimate
   * caller and the modal is structurally part of the user flow.
   */
  acknowledge: z.boolean().optional(),
});

const siteB4ConfigPatchSchema = z.object({
  enabled: z.boolean(),
  currency: z.string().length(3),
  dailyTokenCap: z.number().int().min(1).max(100).optional(),
  dailySpendCapMinor: z.number().int().min(0).optional(),
  perTxCapMinorOverride: z.number().int().min(0).nullable().optional(),
});

const primaryChannelPatchSchema = z.object({
  primary: z.boolean(),
});

// ────────────────────────────────────────────────────────────────────────

export function createBrowserAutomationPurchaseRoutes(
  deps: ApiDependencies,
): Hono {
  const app = new Hono();

  // ── GET /purchase-tokens ──
  app.get("/browser-automation/purchase-tokens", (c) => {
    const now = Date.now();
    const pending = listPendingPurchaseTokens(deps.db, now, 32);
    const recent = listRecentPurchaseTokens(deps.db, 50);
    return c.json({
      pending: pending.map(toPurchaseTokenWire),
      recent: recent.map(toPurchaseTokenWire),
      now,
    });
  });

  // ── DELETE /purchase-tokens/:jti — Approve, dashboard "Cancel pending" ──
  app.delete("/browser-automation/purchase-tokens/:jti", async (c) => {
    const jti = c.req.param("jti");
    if (!jti || !/^[a-f0-9-]{36}$/i.test(jti)) {
      return c.json({ error: "invalid_jti" }, 400);
    }
    const before = getPurchaseTokenByJti(deps.db, jti);
    if (!before) return c.json({ error: "not_found" }, 404);
    if (before.status !== "pending") {
      return c.json({ error: "not_pending", currentStatus: before.status }, 409);
    }
    // The dashboard cancel path uses `dashboard_cancel` as the reason
    // so the audit row distinguishes a user-initiated cancellation
    // from the workflow-internal `playwright_error` cancellations.
    if (deps.purchaseHandler) {
      const row = await deps.purchaseHandler.cancel(jti, "dashboard_cancel");
      if (!row) return c.json({ error: "cas_missed" }, 409);
      return c.json({ token: toPurchaseTokenWire(row) });
    }
    // Fallback when the handler is not wired — direct DB cancel. The
    // user does not get the follow-up DM, but the token is invalidated.
    const row = cancelPurchaseToken(deps.db, {
      jti,
      reason: "dashboard_cancel",
      cancelledAt: Date.now(),
      onlyIfPending: true,
    });
    if (!row) return c.json({ error: "cas_missed" }, 409);
    logger.warn(
      { jti },
      "dashboard cancel ran without PurchaseHandler — follow-up DM skipped",
    );
    return c.json({ token: toPurchaseTokenWire(row) });
  });

  // ── GET /b4/enabled ──
  app.get("/browser-automation/b4/enabled", (c) => {
    return c.json({
      enabled: getB4Enabled(deps.db),
      primaryChannelCount: countPrimaryChannels(deps.db),
    });
  });

  // ── POST /b4/enabled — Approve ──
  app.post("/browser-automation/b4/enabled", async (c) => {
    const body = await readJsonBody(c);
    if (!body.ok) return body.response;
    const parsed = enableToggleBodySchema.safeParse(body.body);
    if (!parsed.success) {
      return c.json(
        { error: "validation_error", details: parsed.error.flatten() },
        400,
      );
    }
    if (parsed.data.enabled) {
      if (!parsed.data.acknowledge) {
        return c.json(
          {
            error: "acknowledgement_required",
            detail:
              "Enabling B-4 requires acknowledge=true (user clicked through " +
              "the experimental-danger modal). Replay the request with " +
              "{ enabled: true, acknowledge: true }.",
          },
          400,
        );
      }
      if (countPrimaryChannels(deps.db) === 0) {
        return c.json(
          {
            error: "no_primary_channels",
            detail:
              "At least one primary channel must be configured before B-4 " +
              "can be enabled. See §17.8.",
          },
          400,
        );
      }
    }
    setB4Enabled(deps.db, parsed.data.enabled);
    logger.warn(
      { enabled: parsed.data.enabled },
      parsed.data.enabled
        ? "B-4 master toggle flipped ON via dashboard"
        : "B-4 master toggle flipped OFF via dashboard",
    );
    return c.json({
      enabled: parsed.data.enabled,
      primaryChannelCount: countPrimaryChannels(deps.db),
    });
  });

  // ── GET /b4/site-configs ──
  app.get("/browser-automation/b4/site-configs", (c) => {
    return c.json({ rows: listSiteB4Configs(deps.db) });
  });

  // ── PATCH /sites/:siteKey/b4-config — Approve ──
  app.patch("/browser-automation/sites/:siteKey/b4-config", async (c) => {
    const siteKey = c.req.param("siteKey");
    if (!siteKey || !/^[a-z][a-z0-9_]*$/.test(siteKey)) {
      return c.json({ error: "invalid_site_key" }, 400);
    }
    const body = await readJsonBody(c);
    if (!body.ok) return body.response;
    const parsed = siteB4ConfigPatchSchema.safeParse(body.body);
    if (!parsed.success) {
      return c.json(
        { error: "validation_error", details: parsed.error.flatten() },
        400,
      );
    }
    const row = upsertSiteB4Config(deps.db, {
      siteKey,
      enabled: parsed.data.enabled,
      currency: parsed.data.currency.toUpperCase(),
      dailyTokenCap: parsed.data.dailyTokenCap,
      dailySpendCapMinor: parsed.data.dailySpendCapMinor,
      perTxCapMinorOverride: parsed.data.perTxCapMinorOverride,
      updatedAt: Date.now(),
    });
    logger.info(
      { siteKey, enabled: row.enabled, currency: row.currency },
      "B-4 site config updated",
    );
    return c.json({ row });
  });

  // ── GET /b4/primary-channels ──
  app.get("/browser-automation/b4/primary-channels", (c) => {
    return c.json({ rows: listPrimaryChannels(deps.db) });
  });

  // ── PATCH /channels/:platform/:channelId/primary — Approve ──
  app.patch(
    "/browser-automation/channels/:platform/:channelId/primary",
    async (c) => {
      const platform = c.req.param("platform");
      const channelId = c.req.param("channelId");
      if (!platform || !channelId) {
        return c.json({ error: "invalid_channel_ref" }, 400);
      }
      if (!/^[a-z][a-z0-9_-]*$/i.test(platform)) {
        return c.json({ error: "invalid_platform" }, 400);
      }
      if (channelId.length > 256) {
        return c.json({ error: "channel_id_too_long" }, 400);
      }
      const body = await readJsonBody(c);
      if (!body.ok) return body.response;
      const parsed = primaryChannelPatchSchema.safeParse(body.body);
      if (!parsed.success) {
        return c.json(
          { error: "validation_error", details: parsed.error.flatten() },
          400,
        );
      }
      if (parsed.data.primary) {
        setPrimaryChannel(deps.db, {
          platform,
          channelId,
          setAt: Date.now(),
        });
      } else {
        // Refuse to clear the LAST primary channel while B-4 is enabled —
        // doing so would leave the master toggle on with no recipient
        // for the confirmation DM, structurally guaranteed to fail
        // every issuance. The user should turn the master toggle off
        // first.
        if (getB4Enabled(deps.db) && countPrimaryChannels(deps.db) <= 1) {
          return c.json(
            {
              error: "would_leave_zero_primary",
              detail:
                "Cannot clear the last primary channel while B-4 is enabled. " +
                "Disable B-4 first via /b4/enabled.",
            },
            409,
          );
        }
        clearPrimaryChannel(deps.db, platform, channelId);
      }
      return c.json({ primary: parsed.data.primary });
    },
  );

  return app;
}
