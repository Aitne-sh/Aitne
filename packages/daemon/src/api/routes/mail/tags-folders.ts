import type { Hono } from "hono";
import {
  providerError,
  type ProviderResolver,
} from "./provider-resolver.js";
import type { MailRouteDependencies } from "./dependencies.js";

export function registerTagsFoldersRoutes(
  app: Hono,
  _deps: MailRouteDependencies,
  resolver: ProviderResolver,
): void {
  const { resolveProvider, renderResolveError, ensureMethod } = resolver;

  app.get("/mail/:accountId/tags", async (c) => {
    const accountId = c.req.param("accountId");
    const resolved = await resolveProvider(accountId);
    if (!resolved.ok) return renderResolveError(c, resolved);
    if (!ensureMethod(resolved.provider, "listTags")) {
      // Minimal fallback: return empty catalog for providers that don't yet
      // surface a tag list. Keeps callers from needing per-kind branching.
      return c.json({ system: [], userDefined: [] });
    }
    try {
      const catalog = await resolved.provider.listTags!();
      return c.json(catalog);
    } catch (err) {
      return providerError(c, err, "list_tags_failed");
    }
  });

  app.get("/mail/:accountId/folders", async (c) => {
    const resolved = await resolveProvider(c.req.param("accountId"));
    if (!resolved.ok) return renderResolveError(c, resolved);
    try {
      const folders = await resolved.provider.listFolders();
      return c.json({ folders });
    } catch (err) {
      return providerError(c, err, "list_folders_failed");
    }
  });
}
