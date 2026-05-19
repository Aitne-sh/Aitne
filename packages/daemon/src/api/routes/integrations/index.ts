import { Hono } from "hono";
import type { ApiDependencies } from "../../server.js";
import { registerCrudRoutes } from "./crud.js";
import { registerExecRoutes } from "./exec.js";
import { registerProbeRoutes } from "./probe.js";

/**
 * Integration Delegation Framework — `/api/integrations` routes.
 *
 * Surface:
 *   - `GET /api/integrations` — list every registered integration with its
 *     descriptor metadata and current state.
 *   - `GET /api/integrations/:key/recent-proxy-calls` — last N delegated
 *     proxy invocations for the dashboard's IntegrationCard.
 *   - `GET /api/integrations/proxy-models/:backend` — registered + pinned
 *     proxy-model options for the dashboard's model dropdown.
 *   - `PATCH /api/integrations/:key` — change a single integration's mode.
 *     Runs the full lifecycle: validate → flip-lock acquire → §14.7 probe →
 *     DB update → `integrations.md` re-render → running-session
 *     re-materialisation → audit row → flip-lock release.
 *   - `POST /api/integrations/:key/exec` — cross-backend delegated proxy
 *     (DELEGATED-MODE-V2-DESIGN.md §11 / `docs/design/14-integration-delegation.md` §14.4.5).
 *   - `POST /api/integrations/:key/probe` — descriptor + cached + live
 *     probe paths (`docs/design/14-integration-delegation.md` §14.7).
 *
 * The historical `POST /api/integrations/:key/invoke` RPC chokepoint was
 * retired 2026-05-01 as part of the /exec-only migration. The dormant
 * stub file `invoke.ts` was removed in the api-route-decomposition.md
 * PR-5 follow-up (commented-out handler body lives in git history; the
 * `runDelegatedTool()` internals it relied on remain wired through
 * `delegated-sync-worker` for hourly drift detection). Future
 * reactivation should land back at the same `RiskTier.Autonomous`
 * classification preserved in `risk-classifier.ts`.
 *
 * Observer gating, the route-410 middleware (`integration-route-gate.ts`),
 * skill / task-flow variant selection, and the connector probe are all
 * production paths.
 *
 * Mode model. `IntegrationMode = "direct" | "delegated" | "native" | "disabled"`.
 *   - `direct` — daemon poller + `/api/<integration>/*` daemon routes.
 *   - `delegated` — `delegated-sync-worker` cadences + `/exec` proxy.
 *   - `native` — main backend reaches the integration via its own native
 *     MCP / connector; daemon does no polling. Per-tick data acquisition
 *     for routines (morning / evening / hourly / weekly / monthly) runs in a
 *     separate pre-pass session on the `routine.fetch_window` ProcessKey
 *     and POSTs observations to `/api/observations`. See
 *     [`docs/design/appendices/routine-data-acquisition.md`](../../../../../docs/design/appendices/routine-data-acquisition.md)
 *     for the per-routine × per-integration acquisition contract.
 *   - `disabled` — silence. Routes 410 with `X-Integration-Mode: disabled`.
 *
 * User-managed connectors (`descriptor.userManagedConnector === true`,
 * today `outlook_mail` / `outlook_calendar`) skip the descriptor-driven
 * variant gates: there is no daemon-shipped `SKILL.<mode>.<backend>.md`
 * for them, and routine-side acquisition flows through the per-integration
 * partial (RDAD §6.8) rather than a variant fan-out.
 *
 * Risk tier: Approve (dashboard-only mutation, registered in
 * `risk-classifier.ts`).
 *
 * Registration order matches the original handler declaration order so
 * Hono route-match precedence is byte-identical to the pre-split file
 * (file-split-plan R2). Verify with
 * `app.routes.map(r => r.path)` before/after when in doubt.
 */
export function createIntegrationRoutes(deps: ApiDependencies): Hono {
  const app = new Hono();
  registerCrudRoutes(app, deps);
  registerExecRoutes(app, deps);
  registerProbeRoutes(app, deps);
  return app;
}
