import type { Hono } from "hono";
import { readJsonBody } from "../../json-body.js";
import {
  notImplementedResponse,
  providerError,
  type ProviderResolver,
} from "./provider-resolver.js";
import {
  parseBodyMode,
  applyMailMessageBodyMode,
  applyThreadBodyMode,
  buildMailBodyResponse,
  MAIL_BODY_CHUNK_DEFAULT_CHARS,
  MAIL_BODY_CHUNK_MAX_CHARS,
  MAIL_BODY_METADATA_DEFAULT_LIMIT,
  MAIL_BODY_METADATA_MAX_LIMIT,
} from "./body-helpers.js";
import {
  parseIntParam,
  toStringArray,
  validateSendInput,
} from "./validators.js";
import type { MailRouteDependencies } from "./dependencies.js";

/**
 * Per-account message routes (§3.3, §3.11 parity table). Each route
 * resolves a live MailProvider via the resolver; error mapping
 * distinguishes 404 (account not found) / 400 (provider not enabled
 * for selection) / 501 (provider interface method not implemented yet
 * for this kind). Write routes call writeTracker.markWriting so the
 * unified poller suppresses the agent's own operations (§3.2). Thread
 * read sits here because it shares the same `messageId`/`threadId`
 * provider methods.
 */
export function registerMessagesRoutes(
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

  app.get("/mail/:accountId/messages", async (c) => {
    const accountId = c.req.param("accountId");
    const resolved = await resolveProvider(accountId);
    if (!resolved.ok) return renderResolveError(c, resolved);
    const limit = parseIntParam(c.req.query("limit"), 20, { min: 1, max: 100 });
    try {
      const messages = await resolved.provider.list({
        folder: c.req.query("folder") ?? undefined,
        q: c.req.query("q") ?? undefined,
        limit,
        since: c.req.query("since") ?? undefined,
        unreadOnly: c.req.query("unreadOnly") === "true",
      });
      return c.json({ messages });
    } catch (err) {
      return providerError(c, err, "list_failed");
    }
  });

  app.get("/mail/:accountId/messages/:messageId", async (c) => {
    const accountId = c.req.param("accountId");
    const resolved = await resolveProvider(accountId);
    if (!resolved.ok) return renderResolveError(c, resolved);
    const bodyMode = parseBodyMode(c.req.query("body"));
    if (!bodyMode.ok) return c.json(bodyMode.body, 400);
    try {
      const message = await resolved.provider.get(c.req.param("messageId"));
      return c.json({ message: applyMailMessageBodyMode(message, bodyMode.value) });
    } catch (err) {
      return providerError(c, err, "get_failed");
    }
  });

  app.get("/mail/:accountId/messages/:messageId/body", async (c) => {
    const resolved = await resolveProvider(c.req.param("accountId"));
    if (!resolved.ok) return renderResolveError(c, resolved);
    const format = c.req.query("format") ?? "extracted";
    if (format !== "extracted" && format !== "raw") {
      return c.json(
        { error: "invalid_query", message: "format must be extracted or raw" },
        400,
      );
    }
    const chunk = parseIntParam(c.req.query("chunk"), 0, { min: 0, max: 100_000 });
    const maxChars = parseIntParam(c.req.query("maxChars"), MAIL_BODY_CHUNK_DEFAULT_CHARS, {
      min: 1_000,
      max: MAIL_BODY_CHUNK_MAX_CHARS,
    });
    const metadataOffset = parseIntParam(c.req.query("metadataOffset"), 0, {
      min: 0,
      max: 100_000,
    });
    const metadataLimit = parseIntParam(
      c.req.query("metadataLimit"),
      MAIL_BODY_METADATA_DEFAULT_LIMIT,
      { min: 1, max: MAIL_BODY_METADATA_MAX_LIMIT },
    );
    try {
      const message = await resolved.provider.get(c.req.param("messageId"));
      return c.json(buildMailBodyResponse({
        accountId: c.req.param("accountId"),
        message,
        format,
        chunk,
        maxChars,
        metadataOffset,
        metadataLimit,
      }));
    } catch (err) {
      return providerError(c, err, "get_body_failed");
    }
  });

  // /messages/send always *sends*. Draft creation has a dedicated endpoint
  // (POST /mail/:id/drafts) so the path — not a body flag — determines the
  // risk tier (§8). This avoids the "every draft DMs the owner" trap that
  // body-aware classification would require.
  app.post("/mail/:accountId/messages/send", async (c) => {
    const accountId = c.req.param("accountId");
    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const resolved = await resolveProvider(accountId);
    if (!resolved.ok) return renderResolveError(c, resolved);
    const input = validateSendInput(parsedBody.body);
    if (!input.ok) return c.json({ error: input.code, message: input.message }, 400);
    try {
      const result = await resolved.provider.send({ ...input.value, draftOnly: false });
      markAgentWrite(accountId, result.id);
      markAgentWriteRfc822(accountId, result.rfc822MsgId);
      // Phase 5 Gmail reconcile (`inbox:7d`) keys snapshots by threadId,
      // so threadId is the load-bearing mark for actor attribution;
      // messageId is kept as a forward-compat second key. GmailProvider
      // surfaces threadId from `users.messages.send`'s response; IMAP /
      // Outlook leave it undefined and only the messageId mark lands
      // (those providers don't drive a reconcile path today, so a missed
      // mark there is a no-op).
      markGmailIntegrationWrite(accountId, result.id, result.threadId);
      return c.json({ result });
    } catch (err) {
      return providerError(c, err, "send_failed");
    }
  });

  app.post("/mail/:accountId/messages/:messageId/read", async (c) => {
    const accountId = c.req.param("accountId");
    const messageId = c.req.param("messageId");
    const resolved = await resolveProvider(accountId);
    if (!resolved.ok) return renderResolveError(c, resolved);
    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.body as { read?: unknown } | null;
    const read = body?.read;
    if (typeof read !== "boolean") {
      return c.json({ error: "invalid_body", message: "read: boolean required" }, 400);
    }
    try {
      await resolved.provider.markRead(messageId, read);
      markAgentWrite(accountId, messageId);
      return c.json({ status: "updated", read });
    } catch (err) {
      return providerError(c, err, "mark_read_failed");
    }
  });

  app.post("/mail/:accountId/messages/:messageId/trash", async (c) => {
    const accountId = c.req.param("accountId");
    const messageId = c.req.param("messageId");
    const resolved = await resolveProvider(accountId);
    if (!resolved.ok) return renderResolveError(c, resolved);
    try {
      await resolved.provider.trash(messageId);
      markAgentWrite(accountId, messageId);
      return c.json({ status: "trashed" });
    } catch (err) {
      return providerError(c, err, "trash_failed");
    }
  });

  app.post("/mail/:accountId/messages/:messageId/untrash", async (c) => {
    const accountId = c.req.param("accountId");
    const messageId = c.req.param("messageId");
    const resolved = await resolveProvider(accountId);
    if (!resolved.ok) return renderResolveError(c, resolved);
    if (!ensureMethod(resolved.provider, "untrash")) {
      return notImplementedResponse(c, "untrash", resolved.provider.kind);
    }
    try {
      await resolved.provider.untrash!(messageId);
      markAgentWrite(accountId, messageId);
      return c.json({ status: "untrashed" });
    } catch (err) {
      return providerError(c, err, "untrash_failed");
    }
  });

  app.post("/mail/:accountId/messages/:messageId/archive", async (c) => {
    const accountId = c.req.param("accountId");
    const messageId = c.req.param("messageId");
    const resolved = await resolveProvider(accountId);
    if (!resolved.ok) return renderResolveError(c, resolved);
    if (!ensureMethod(resolved.provider, "archive")) {
      return notImplementedResponse(c, "archive", resolved.provider.kind);
    }
    try {
      await resolved.provider.archive!(messageId);
      markAgentWrite(accountId, messageId);
      return c.json({ status: "archived" });
    } catch (err) {
      return providerError(c, err, "archive_failed");
    }
  });

  app.post("/mail/:accountId/messages/:messageId/tags", async (c) => {
    const accountId = c.req.param("accountId");
    const messageId = c.req.param("messageId");
    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const resolved = await resolveProvider(accountId);
    if (!resolved.ok) return renderResolveError(c, resolved);
    const body = parsedBody.body as { add?: unknown; remove?: unknown } | null;
    const add = toStringArray(body?.add);
    const remove = toStringArray(body?.remove);
    if (!add || !remove) {
      return c.json({ error: "invalid_body", message: "add: string[], remove: string[] required" }, 400);
    }
    try {
      await resolved.provider.modifyTags(messageId, add, remove);
      markAgentWrite(accountId, messageId);
      return c.json({ status: "tags_updated", add, remove });
    } catch (err) {
      return providerError(c, err, "modify_tags_failed");
    }
  });

  app.get("/mail/:accountId/threads/:threadId", async (c) => {
    const accountId = c.req.param("accountId");
    const resolved = await resolveProvider(accountId);
    if (!resolved.ok) return renderResolveError(c, resolved);
    if (!ensureMethod(resolved.provider, "getThread")) {
      return notImplementedResponse(c, "getThread", resolved.provider.kind);
    }
    const bodyMode = parseBodyMode(c.req.query("body"));
    if (!bodyMode.ok) return c.json(bodyMode.body, 400);
    const limit = parseIntParam(c.req.query("limit"), 25, { min: 1, max: 100 });
    try {
      const thread = await resolved.provider.getThread!(c.req.param("threadId"), limit);
      return c.json({ thread: applyThreadBodyMode(thread, bodyMode.value) });
    } catch (err) {
      return providerError(c, err, "get_thread_failed");
    }
  });
}
