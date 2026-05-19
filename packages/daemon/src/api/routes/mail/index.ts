import { Hono } from "hono";
import { registerProvidersRoutes } from "./providers.js";
import { registerAccountsRoutes } from "./accounts.js";
import { registerOutlookConfigRoutes } from "./outlook-config.js";
import { registerAppPasswordRoutes } from "./app-password.js";
import { registerSearchHealthRoutes } from "./search-health.js";
import { registerMessagesRoutes } from "./messages.js";
import { registerTagsFoldersRoutes } from "./tags-folders.js";
import { registerDraftsRoutes } from "./drafts.js";
import { createProviderResolver } from "./provider-resolver.js";
import type { MailRouteDependencies } from "./dependencies.js";

export type { MailRouteDependencies } from "./dependencies.js";
// Re-exported so the `mail.test.ts` harness (and any external consumer)
// can import the pure TTL helper from the public mail-routes surface
// without reaching into the resolver module.
export { computeAgentWriteTtlMs } from "./provider-resolver.js";

/**
 * Multi-mail provider routes — /api/mail/* + /api/config/mail/*.
 *
 * Decomposition (docs/design/appendices/api-route-decomposition.md §5.2):
 * sub-files export `register*Routes(app, deps[, resolver]): void` and are
 * invoked here on a single Hono instance in the same order the handlers
 * appeared in the original `mail.ts`, so Hono route-match precedence is
 * preserved (R2). The per-account access surface (resolveProvider, error
 * rendering, agent-write attribution) is built once via
 * `createProviderResolver(deps)` and shared with the handlers that proxy
 * to a live provider.
 */
export function createMailRoutes(deps: MailRouteDependencies): Hono {
  const app = new Hono();
  const resolver = createProviderResolver(deps);

  registerProvidersRoutes(app, deps);
  registerAccountsRoutes(app, deps);
  registerOutlookConfigRoutes(app, deps);
  registerAppPasswordRoutes(app, deps);
  registerSearchHealthRoutes(app, deps);
  registerMessagesRoutes(app, deps, resolver);
  registerTagsFoldersRoutes(app, deps, resolver);
  registerDraftsRoutes(app, deps, resolver);

  return app;
}
