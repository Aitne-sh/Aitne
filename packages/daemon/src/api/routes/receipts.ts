import { Hono } from "hono";
import type { ApiDependencies } from "../server.js";
import { readJsonBody } from "../json-body.js";
import { composeIssue, respondWithAgentError } from "../helpers/agent-errors.js";

interface ReceiptRow {
  id: number;
  provider_msg_id: string;
  attachment_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number | null;
  category: string | null;
  obsidian_path: string | null;
  saved_at: string | null;
  created_at: string;
  account_id: string | null;
}

export function createReceiptRoutes(deps: ApiDependencies): Hono {
  const app = new Hono();
  const { db } = deps;

  /**
   * GET /receipts — list detected receipt attachments.
   *
   * Query params:
   * - category: document | travel
   * - saved: true | false — filter by whether saved to Obsidian
   * - limit: max results (1–200, default 50)
   */
  app.get("/receipts", (c) => {
    const category = c.req.query("category");
    const saved = c.req.query("saved");
    const limit = Math.min(
      Math.max(parseInt(c.req.query("limit") ?? "50", 10), 1),
      200,
    );

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (category) {
      conditions.push("category = ?");
      params.push(category);
    }
    if (saved === "true") {
      conditions.push("saved_at IS NOT NULL");
    } else if (saved === "false") {
      conditions.push("saved_at IS NULL");
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countRow = db.prepare(
      `SELECT COUNT(*) as count FROM receipts ${where}`,
    ).get(...params) as { count: number };

    const rows = db.prepare(
      `SELECT id, provider_msg_id,
              attachment_id, filename, mime_type, size_bytes,
              category, obsidian_path, saved_at, created_at, account_id
       FROM receipts ${where}
       ORDER BY created_at DESC
       LIMIT ?`,
    ).all(...params, limit) as ReceiptRow[];

    const receipts = rows.map((row) => ({
      id: row.id,
      providerMsgId: row.provider_msg_id,
      accountId: row.account_id,
      attachmentId: row.attachment_id,
      filename: row.filename,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes,
      category: row.category,
      obsidianPath: row.obsidian_path,
      savedAt: row.saved_at,
      createdAt: row.created_at,
    }));

    return c.json({ receipts, total: countRow.count });
  });

  /**
   * GET /receipts/summary — receipt statistics.
   */
  app.get("/receipts/summary", (c) => {
    const total = db.prepare(
      `SELECT COUNT(*) as count FROM receipts`,
    ).get() as { count: number };

    const saved = db.prepare(
      `SELECT COUNT(*) as count FROM receipts WHERE saved_at IS NOT NULL`,
    ).get() as { count: number };

    const byCategory = db.prepare(
      `SELECT category, COUNT(*) as count
       FROM receipts
       GROUP BY category
       ORDER BY count DESC`,
    ).all() as { category: string | null; count: number }[];

    return c.json({
      total: total.count,
      saved: saved.count,
      unsaved: total.count - saved.count,
      byCategory: byCategory.map((r) => ({
        category: r.category ?? "uncategorized",
        count: r.count,
      })),
    });
  });

  /**
   * POST /receipts/:id/download — download attachment content.
   *
   * Always resolves through the unified mail registry via `account_id`.
   * If a receipt row has a null `account_id`, it's orphaned and download
   * is impossible — surface `orphaned_receipt` with a clear hint rather
   * than guess at a provider.
   */
  app.post("/receipts/:id/download", async (c) => {
    const rawId = c.req.param("id");
    const id = parseInt(rawId, 10);
    if (isNaN(id) || id <= 0) {
      return respondWithAgentError(c, 400, [
        composeIssue("receipts.invalid_id", { field: "id", received: rawId }),
      ]);
    }

    const row = db.prepare(
      `SELECT provider_msg_id, attachment_id, filename, mime_type, size_bytes, account_id
       FROM receipts WHERE id = ?`,
    ).get(id) as Pick<
      ReceiptRow,
      | "provider_msg_id"
      | "attachment_id"
      | "filename"
      | "mime_type"
      | "size_bytes"
      | "account_id"
    > | undefined;

    if (!row) {
      return respondWithAgentError(c, 404, [
        composeIssue("receipts.not_found", { field: "id", received: id }),
      ]);
    }

    // Reject oversized attachments to prevent OOM (100 MB limit)
    const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
    if (row.size_bytes && row.size_bytes > MAX_DOWNLOAD_BYTES) {
      return respondWithAgentError(
        c,
        413,
        [
          composeIssue("receipts.attachment_too_large", {
            field: "size_bytes",
            received: row.size_bytes,
          }),
        ],
        { legacyFields: { maxBytes: MAX_DOWNLOAD_BYTES } },
      );
    }

    if (!deps.services.mail) {
      return respondWithAgentError(c, 503, [
        composeIssue("receipts.mail_not_configured", {
          field: "services.mail",
          received: "<unavailable>",
        }),
      ]);
    }
    if (!row.account_id) {
      return respondWithAgentError(c, 409, [
        composeIssue("receipts.orphaned_receipt", {
          field: "account_id",
          received: null,
        }),
      ]);
    }

    const provider = await deps.services.mail.getProvider(row.account_id);
    if (!provider) {
      return respondWithAgentError(
        c,
        404,
        [
          composeIssue("receipts.account_not_found", {
            field: "account_id",
            received: row.account_id,
          }),
        ],
        { legacyFields: { accountId: row.account_id } },
      );
    }
    if (typeof provider.getAttachment !== "function") {
      return respondWithAgentError(
        c,
        501,
        [
          composeIssue("receipts.attachment_download_not_supported", {
            field: "provider.kind",
            received: provider.kind,
          }),
        ],
        { legacyFields: { provider: provider.kind } },
      );
    }
    const attachment = await provider.getAttachment(
      row.provider_msg_id,
      row.attachment_id,
    );
    if (!attachment) {
      return respondWithAgentError(c, 404, [
        composeIssue("receipts.attachment_not_found", {
          field: "attachment",
          received: { provider_msg_id: row.provider_msg_id, attachment_id: row.attachment_id },
        }),
      ]);
    }

    c.header("Content-Type", row.mime_type);
    // `row.filename` comes from email-attachment metadata (sender-controlled),
    // so escape characters that could break out of the quoted header value or
    // inject extra header lines — same discipline as the attachments route.
    const safeFilename = row.filename.replace(/["\\\r\n]/g, "_");
    c.header("Content-Disposition", `attachment; filename="${safeFilename}"`);
    return c.body(new Uint8Array(attachment.data));
  });

  /**
   * PATCH /receipts/:id — update receipt metadata.
   */
  app.patch("/receipts/:id", async (c) => {
    const rawId = c.req.param("id");
    const id = parseInt(rawId, 10);
    if (isNaN(id) || id <= 0) {
      return respondWithAgentError(c, 400, [
        composeIssue("receipts.invalid_id", { field: "id", received: rawId }),
      ]);
    }

    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.body as { obsidianPath?: string; category?: string };

    const updates: string[] = [];
    const params: unknown[] = [];

    if (body.obsidianPath !== undefined) {
      updates.push("obsidian_path = ?");
      params.push(body.obsidianPath);
      updates.push("saved_at = datetime('now')");
    }
    if (body.category !== undefined) {
      updates.push("category = ?");
      params.push(body.category);
    }

    if (updates.length === 0) {
      return respondWithAgentError(c, 400, [
        composeIssue("receipts.no_updates", { field: "body", received: body }),
      ]);
    }

    params.push(id);
    const result = db.prepare(
      `UPDATE receipts SET ${updates.join(", ")} WHERE id = ?`,
    ).run(...params);

    if (result.changes === 0) {
      return respondWithAgentError(c, 404, [
        composeIssue("receipts.not_found", { field: "id", received: id }),
      ]);
    }

    return c.json({ ok: true, id });
  });

  return app;
}
