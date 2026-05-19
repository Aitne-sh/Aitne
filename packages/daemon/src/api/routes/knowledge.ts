import { Hono } from "hono";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  BACKEND_IDS,
  EventPriority,
  createEvent,
  isBackendId,
  type BackendId,
  type KnowledgeImportEvent,
} from "@aitne/shared";
import type { ApiDependencies } from "../server.js";
import { getContextDir } from "../../config.js";
import { CONTEXT_RELATIVE_PATHS } from "../../core/context-paths.js";
import { isSetupCompleted } from "../../db/runtime-state.js";
import { createLogger, toSafeErrorMessage } from "../../logging.js";
import { composeIssue, respondWithAgentError } from "../helpers/agent-errors.js";

const logger = createLogger("api:knowledge");

/** 64 KB cap. Larger sources must be split — long imports tax both the
 *  agent's context window and the strict-fidelity heuristic. */
const MAX_IMPORT_BYTES = 64 * 1024;

/** Accept only Markdown / text uploads — these match the formats
 *  Claude Code, Codex, and Gemini CLI all read natively, and they keep
 *  the agent's job purely textual. */
const ACCEPTED_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);

const VALID_SOURCES = new Set([
  "obsidian-export",
  "notion-export",
  "self-written",
  "other",
]);

/** Defense-in-depth secret-shape rejection at the route layer so the
 *  dashboard surfaces a clear 400 instead of letting the task-flow
 *  abort surface as an opaque 202+failure later. */
const SECRET_SHAPES: ReadonlyArray<RegExp> = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,
  /AIza[0-9A-Za-z_-]{35}/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bxox[abp]-[A-Za-z0-9-]{10,}/,
];

function fileExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot < 0 ? "" : filename.slice(dot).toLowerCase();
}

function looksLikeSecret(content: string): boolean {
  return SECRET_SHAPES.some((re) => re.test(content));
}

function safeSlugFromFilename(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, "");
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.slice(0, 40) || "upload";
}

function isoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function createKnowledgeRoutes(deps: ApiDependencies): Hono {
  const app = new Hono();
  const { db, config } = deps;

  /**
   * POST /api/knowledge/import — accept a single .md / .txt upload from
   * the dashboard Knowledge page, persist a scratch copy, and emit a
   * one-shot `knowledge.import` event. The session writes facts into
   * `user/*.md` per the Profile Importer task flow.
   *
   * Multipart fields:
   *   - file (required): the uploaded blob
   *   - source (required): obsidian-export | notion-export | self-written | other
   *   - requestedBackendId (optional): claude | codex | gemini
   *   - requestedModelId  (optional): a model id valid for the chosen backend
   *
   * Returns 202 + { traceId } on success. The dashboard subscribes to
   * `/api/events/stream` for progress.
   */
  app.post("/knowledge/import", async (c) => {
    if (!deps.eventBus) {
      return respondWithAgentError(c, 503, [
        composeIssue("knowledge.event_bus_unavailable", {
          field: "deps.eventBus",
          received: "<unavailable>",
        }),
      ]);
    }

    // Pre-setup uploads are rejected: the agent's PATCHes target
    // `user/<topic>.md` files that `ensureSkeletonFiles` only seeds
    // after the management-rules wizard saves. Without this gate the
    // event would fire, every PATCH would 404, and the user would burn
    // a heavy-tier session for nothing while the dashboard reported a
    // misleading "accepted" 202.
    if (!isSetupCompleted(db)) {
      return c.json(
        {
          error: "setup_incomplete",
          message:
            "Complete initial setup before importing knowledge files. The user/*.md files the import targets are seeded only after you finish the setup wizard.",
        },
        409,
      );
    }

    let body: Record<string, unknown>;
    try {
      body = (await c.req.parseBody()) as Record<string, unknown>;
    } catch (err) {
      return c.json(
        { error: toSafeErrorMessage(err, "invalid_multipart_body") },
        400,
      );
    }

    const file = body["file"];
    if (!file || !(file instanceof File)) {
      return c.json(
        { error: "no_file", message: "Send the upload as multipart with field name 'file'." },
        400,
      );
    }

    const ext = fileExtension(file.name);
    if (!ACCEPTED_EXTENSIONS.has(ext)) {
      return c.json(
        {
          error: "unsupported_extension",
          message:
            "Only .md, .markdown, and .txt files are accepted — these are the formats Claude Code, Codex, and Gemini CLI all read natively.",
        },
        415,
      );
    }

    if (file.size > MAX_IMPORT_BYTES) {
      return c.json(
        {
          error: "file_too_large",
          message: `File exceeds ${MAX_IMPORT_BYTES / 1024} KB. Split the file and import in pieces — strict-fidelity ingestion does not scale beyond this size.`,
        },
        413,
      );
    }

    const content = await file.text();
    if (content.trim().length === 0) {
      return respondWithAgentError(c, 400, [
        composeIssue("knowledge.empty_file", {
          field: "file",
          received: "<empty>",
        }),
      ]);
    }

    if (looksLikeSecret(content)) {
      return c.json(
        {
          error: "secret_shape_detected",
          message:
            "The upload contains content shaped like a private key, API token, or credential. Remove it and try again.",
        },
        400,
      );
    }

    const sourceRaw = typeof body["source"] === "string" ? (body["source"] as string) : "";
    if (!VALID_SOURCES.has(sourceRaw)) {
      return c.json(
        { error: "invalid_source", message: `source must be one of: ${[...VALID_SOURCES].join(", ")}` },
        400,
      );
    }
    const importSource = sourceRaw as KnowledgeImportEvent["importSource"];

    let requestedBackendId: BackendId | undefined;
    let requestedModelId: string | undefined;
    const backendRaw = typeof body["requestedBackendId"] === "string"
      ? (body["requestedBackendId"] as string)
      : "";
    const modelRaw = typeof body["requestedModelId"] === "string"
      ? (body["requestedModelId"] as string)
      : "";
    if (backendRaw || modelRaw) {
      if (!isBackendId(backendRaw)) {
        return c.json(
          { error: "invalid_backend", message: `requestedBackendId must be one of: ${BACKEND_IDS.join(", ")}` },
          400,
        );
      }
      if (!modelRaw) {
        return c.json(
          { error: "missing_model", message: "requestedModelId is required when requestedBackendId is set." },
          400,
        );
      }
      requestedBackendId = backendRaw;
      requestedModelId = modelRaw;
    }

    // Persist the raw blob under context/agent/scratch/. This directory
    // is exempt from frontmatter validation, so we write the file
    // directly with Node fs rather than the Context File API. The
    // scratch_path the agent reads is the same relative path that the
    // GET /api/context/<...> route resolves.
    const date = isoDate();
    const slug = safeSlugFromFilename(file.name);
    const id = randomBytes(4).toString("hex");
    const relPath = `${CONTEXT_RELATIVE_PATHS.agent.scratchDir}/import-${date}-${slug}-${id}.md`;
    const absPath = join(getContextDir(config), relPath);
    try {
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, content, "utf-8");
    } catch (err) {
      logger.warn({ err, path: relPath }, "failed to persist scratch import");
      return c.json(
        { error: toSafeErrorMessage(err, "scratch_write_failed") },
        500,
      );
    }

    const event: KnowledgeImportEvent = {
      ...createEvent({
        type: "knowledge.import",
        source: "dashboard_knowledge_upload",
        priority: EventPriority.HIGH,
      }),
      type: "knowledge.import",
      platform: "dashboard",
      scratchPath: relPath,
      filename: file.name,
      importSource,
      uploadDate: date,
      ...(requestedBackendId && requestedModelId
        ? { requestedBackendId, requestedModelId }
        : {}),
      // Mirror the typed fields into `event.data` so prompt
      // substitution (`extractEventData` flattens `event.data` keys
      // into `event_data[<key>]`) sees them. Use `importSource` here
      // too — `event_data[source]` is reserved for `Event.source` (the
      // adapter origin, "dashboard_knowledge_upload") so the audit
      // trail's adapter label survives.
      data: {
        scratchPath: relPath,
        filename: file.name,
        importSource,
        uploadDate: date,
      },
    };

    try {
      await deps.eventBus.put(event);
    } catch (err) {
      logger.error({ err }, "failed to enqueue knowledge.import event");
      return c.json(
        { error: toSafeErrorMessage(err, "enqueue_failed") },
        500,
      );
    }

    logger.info(
      {
        scratchPath: relPath,
        importSource,
        sizeBytes: file.size,
        requestedBackendId: requestedBackendId ?? null,
      },
      "Knowledge import accepted",
    );

    // Mirror the audit trail surface used by other Approve-tier
    // endpoints. The dashboard activity feed surfaces this row.
    try {
      db.prepare(
        `INSERT INTO agent_actions (action_type, trigger, result, detail)
           VALUES (?, ?, ?, ?)`,
      ).run(
        "knowledge_import_started",
        "dashboard",
        "success",
        JSON.stringify({
          filename: file.name,
          importSource,
          sizeBytes: file.size,
          scratchPath: relPath,
          requestedBackendId: requestedBackendId ?? null,
          requestedModelId: requestedModelId ?? null,
          correlationId: event.correlationId,
        }),
      );
    } catch (err) {
      logger.warn({ err }, "failed to record knowledge_import_started audit row");
    }

    return c.json(
      {
        status: "accepted",
        traceId: event.correlationId,
        scratchPath: relPath,
      },
      202,
    );
  });

  return app;
}
