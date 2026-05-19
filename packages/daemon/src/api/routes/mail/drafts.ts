import type { Hono } from "hono";
import { readJsonBody } from "../../json-body.js";
import {
  notImplementedResponse,
  providerError,
  type ProviderResolver,
} from "./provider-resolver.js";
import {
  parseIntParam,
  validateSendInput,
  validateUpdateDraftInput,
} from "./validators.js";
import type { MailRouteDependencies } from "./dependencies.js";

export function registerDraftsRoutes(
  app: Hono,
  _deps: MailRouteDependencies,
  resolver: ProviderResolver,
): void {
  const {
    resolveProvider,
    renderResolveError,
    ensureMethod,
    markAgentWrite,
    markAgentWriteRfc822,
    markGmailIntegrationWrite,
  } = resolver;

  app.get("/mail/:accountId/drafts", async (c) => {
    const accountId = c.req.param("accountId");
    const resolved = await resolveProvider(accountId);
    if (!resolved.ok) return renderResolveError(c, resolved);
    if (!ensureMethod(resolved.provider, "listDrafts")) {
      return notImplementedResponse(c, "listDrafts", resolved.provider.kind);
    }
    const limit = parseIntParam(c.req.query("limit"), 20, { min: 1, max: 100 });
    try {
      const drafts = await resolved.provider.listDrafts!(limit);
      return c.json({ drafts });
    } catch (err) {
      return providerError(c, err, "list_drafts_failed");
    }
  });

  app.get("/mail/:accountId/drafts/:draftId", async (c) => {
    const resolved = await resolveProvider(c.req.param("accountId"));
    if (!resolved.ok) return renderResolveError(c, resolved);
    if (!ensureMethod(resolved.provider, "getDraft")) {
      return notImplementedResponse(c, "getDraft", resolved.provider.kind);
    }
    try {
      const draft = await resolved.provider.getDraft!(c.req.param("draftId"));
      if (!draft) return c.json({ error: "not_found" }, 404);
      return c.json({ draft });
    } catch (err) {
      return providerError(c, err, "get_draft_failed");
    }
  });

  app.post("/mail/:accountId/drafts", async (c) => {
    const accountId = c.req.param("accountId");
    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const resolved = await resolveProvider(accountId);
    if (!resolved.ok) return renderResolveError(c, resolved);
    if (!ensureMethod(resolved.provider, "createDraft")) {
      return notImplementedResponse(c, "createDraft", resolved.provider.kind);
    }
    const input = validateSendInput(parsedBody.body);
    if (!input.ok) return c.json({ error: input.code, message: input.message }, 400);
    try {
      const result = await resolved.provider.createDraft!(input.value);
      markAgentWrite(accountId, result.id);
      return c.json({ draftId: result.id });
    } catch (err) {
      return providerError(c, err, "create_draft_failed");
    }
  });

  app.patch("/mail/:accountId/drafts/:draftId", async (c) => {
    const accountId = c.req.param("accountId");
    const draftId = c.req.param("draftId");
    const resolved = await resolveProvider(accountId);
    if (!resolved.ok) return renderResolveError(c, resolved);
    if (!ensureMethod(resolved.provider, "updateDraft")) {
      return notImplementedResponse(c, "updateDraft", resolved.provider.kind);
    }
    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const input = validateUpdateDraftInput(parsedBody.body);
    if (!input.ok) return c.json({ error: input.code, message: input.message }, 400);
    try {
      const result = await resolved.provider.updateDraft!(draftId, input.value);
      markAgentWrite(accountId, result.id);
      if (result.previousId) markAgentWrite(accountId, result.previousId);
      // `warnings` surface provider-specific caveats (e.g. Outlook's
      // reply-threading immutability). Agents need to see them — dropping
      // them would make the UpdateDraftResult.warnings field a no-op.
      return c.json({
        status: "updated",
        id: result.id,
        previousId: result.previousId,
        warnings: result.warnings,
      });
    } catch (err) {
      return providerError(c, err, "update_draft_failed");
    }
  });

  app.delete("/mail/:accountId/drafts/:draftId", async (c) => {
    const accountId = c.req.param("accountId");
    const draftId = c.req.param("draftId");
    const resolved = await resolveProvider(accountId);
    if (!resolved.ok) return renderResolveError(c, resolved);
    if (!ensureMethod(resolved.provider, "deleteDraft")) {
      return notImplementedResponse(c, "deleteDraft", resolved.provider.kind);
    }
    try {
      await resolved.provider.deleteDraft!(draftId);
      markAgentWrite(accountId, draftId);
      return c.json({ status: "deleted" });
    } catch (err) {
      return providerError(c, err, "delete_draft_failed");
    }
  });

  app.post("/mail/:accountId/drafts/:draftId/send", async (c) => {
    const accountId = c.req.param("accountId");
    const draftId = c.req.param("draftId");
    const resolved = await resolveProvider(accountId);
    if (!resolved.ok) return renderResolveError(c, resolved);
    if (!ensureMethod(resolved.provider, "sendDraft")) {
      return notImplementedResponse(c, "sendDraft", resolved.provider.kind);
    }
    try {
      const result = await resolved.provider.sendDraft!(draftId);
      markAgentWrite(accountId, result.id);
      // sendDraft is a surface-area subset of send(); if the provider
      // surfaces the rfc822 Message-Id, it flows through the same field.
      const rfc = (result as unknown as { rfc822MsgId?: string }).rfc822MsgId;
      markAgentWriteRfc822(accountId, rfc);
      markGmailIntegrationWrite(accountId, result.id, result.threadId);
      return c.json({ status: "sent", id: result.id, threadId: result.threadId });
    } catch (err) {
      return providerError(c, err, "send_draft_failed");
    }
  });
}
