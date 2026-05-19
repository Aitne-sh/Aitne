import { Hono } from "hono";
import type { ApiDependencies } from "../../server.js";
import { registerConfigRoutes } from "./config.js";
import { registerSecretsRoutes } from "./secrets.js";
import { registerOauthGoogleRoutes } from "./oauth-google.js";
import { registerMessagingRoutes } from "./messaging.js";
import { registerConversationsRoutes } from "./conversations.js";
import { registerCostApprovalsRoutes } from "./cost-approvals.js";
import { registerScheduleReadonlyRoutes } from "./schedule-readonly.js";
import { registerSnapshotsRoutes } from "./snapshots.js";
import { registerNotificationsRoutes } from "./notifications.js";

/**
 * Dashboard API routes — REST endpoints for the Dashboard UI.
 *
 * Provides:
 * - Config management (GET/PATCH /api/config)
 * - Event/action logs (GET /api/events)
 * - Conversation history (GET /api/conversations)
 * - Cost analytics (GET /api/cost)
 * - Approval queue (GET/POST /api/approvals)
 *
 * Split into sibling sub-files behind a single `Hono` app — see
 * docs/design/appendices/api-route-decomposition.md PR 2 for the layout.
 * Sub-file registration order is a topical regroup, not a byte-identical
 * replay of the pre-split source: `/notifications`, `/dashboard/{next-check,
 * dm-freshness}`, and `/config/reset-safety` move into their topical sibling
 * (notifications.ts / config.ts) and therefore land earlier than they did
 * in the monolithic file. The split is safe because the affected paths
 * are unique strings (no params, no wildcards), so Hono match precedence
 * is unaffected by their reordering. The only ordering invariants that
 * still matter — `/conversations/:id` before `/conversations/:id/messages`,
 * `/snapshots/content/:id` before `/snapshots/*` — are honored inside the
 * `conversations.ts` and `snapshots.ts` sub-files respectively.
 */
export function createDashboardRoutes(deps: ApiDependencies): Hono {
  const app = new Hono();
  registerConfigRoutes(app, deps);
  registerSecretsRoutes(app, deps);
  registerNotificationsRoutes(app, deps);
  registerMessagingRoutes(app, deps);
  registerOauthGoogleRoutes(app, deps);
  registerConversationsRoutes(app, deps);
  registerCostApprovalsRoutes(app, deps);
  registerScheduleReadonlyRoutes(app, deps);
  registerSnapshotsRoutes(app, deps);
  return app;
}
