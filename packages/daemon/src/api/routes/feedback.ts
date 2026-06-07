import { Hono } from "hono";
import { redactSensitiveString } from "@aitne/shared";

import type { ApiDependencies } from "../server.js";
import { readJsonBody } from "../json-body.js";
import { getAgent } from "../../db/agents-store.js";
import {
  consumeFeedbackSignals,
  findRecentFeedbackSignal,
  recordFeedbackSignal,
  type FeedbackActionKind,
  type FeedbackScopeType,
  type FeedbackSignalSource,
  type FeedbackSignalValence,
} from "../../db/feedback-signals-store.js";
import { createLogger } from "../../logging.js";

const logger = createLogger("feedback-api");

const DEDUP_TTL_SECONDS = 10 * 60;
const MAX_SUMMARY_CHARS = 280;
const MAX_SCOPE_REF_CHARS = 120;
const MAX_ACTION_REF_CHARS = 160;
const MAX_EVIDENCE_STRING_CHARS = 500;

const ALLOWED_SOURCES = new Set<FeedbackSignalSource>([
  "explicit",
  "self_critique",
]);
const ALL_SOURCES = new Set<FeedbackSignalSource>([
  "behavioral",
  "explicit",
  "self_critique",
]);
const VALENCES = new Set<FeedbackSignalValence>([
  "positive",
  "negative",
  "neutral",
  "correction",
]);
const API_SCOPE_TYPES = new Set<FeedbackScopeType>([
  "user",
  "agent",
  "agent_slug",
]);
const ACTION_KINDS = new Set<FeedbackActionKind>([
  "notification",
  "agent_execution",
  "vault_write",
  "dm_reply",
]);
const KINDS = new Set([
  "preference",
  "correction",
  "do-more",
  "do-less",
  "constraint",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(0, maxChars);
}

function sanitizeString(value: string, maxChars = MAX_EVIDENCE_STRING_CHARS): string {
  return redactSensitiveString(
    truncate(value.replace(/[\u0000-\u001f\u007f]/g, " "), maxChars),
  ).trim();
}

function sanitizeEvidence(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (typeof value === "string") return sanitizeString(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((entry) => sanitizeEvidence(entry, depth + 1));
  }
  if (!isRecord(value)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, 50)) {
    out[sanitizeString(key, 80)] = sanitizeEvidence(entry, depth + 1);
  }
  return out;
}

function describeType(value: unknown): string {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function createFeedbackRoutes(deps: ApiDependencies): Hono {
  const app = new Hono();
  const { db } = deps;

  app.post("/feedback", async (c) => {
    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.body;

    if (!isRecord(body)) {
      return c.json(
        {
          error: "validation_error",
          message: "Body must be a JSON object",
        },
        400,
      );
    }

    const issues: Array<{
      field: string;
      expected: string;
      got: string;
      hint?: string;
    }> = [];

    const rawSource = body.source;
    const source = typeof rawSource === "string" ? rawSource : "";
    if (!ALL_SOURCES.has(source as FeedbackSignalSource)) {
      issues.push({
        field: "source",
        expected: "'explicit' | 'self_critique'",
        got: describeType(rawSource),
      });
    } else if (!ALLOWED_SOURCES.has(source as FeedbackSignalSource)) {
      issues.push({
        field: "source",
        expected: "'explicit' | 'self_critique'",
        got: "'behavioral'",
        hint: "Behavioral feedback is daemon-only and is written by SignalDetector.",
      });
    }

    const summary =
      typeof body.summary === "string"
        ? sanitizeString(body.summary, MAX_SUMMARY_CHARS)
        : "";
    if (summary.length === 0) {
      issues.push({
        field: "summary",
        expected: "non-empty string",
        got: describeType(body.summary),
      });
    }

    const rawValence = body.valence;
    const valence = typeof rawValence === "string" ? rawValence : null;
    if (valence === null || !VALENCES.has(valence as FeedbackSignalValence)) {
      issues.push({
        field: "valence",
        expected: "'positive' | 'negative' | 'neutral' | 'correction'",
        got: describeType(rawValence),
      });
    }

    const rawKind = body.kind;
    const kind = typeof rawKind === "string" ? rawKind : null;
    if (kind !== null && !KINDS.has(kind)) {
      issues.push({
        field: "kind",
        expected: "'preference' | 'correction' | 'do-more' | 'do-less' | 'constraint' (optional)",
        got: kind,
      });
    }

    const rawScopeType = body.scope_type;
    const scopeType = typeof rawScopeType === "string" ? rawScopeType : "";
    if (!API_SCOPE_TYPES.has(scopeType as FeedbackScopeType)) {
      issues.push({
        field: "scope_type",
        expected: "'user' | 'agent' | 'agent_slug'",
        got: describeType(rawScopeType),
      });
    }

    const scopeRef =
      typeof body.scope_ref === "string"
        ? sanitizeString(body.scope_ref, MAX_SCOPE_REF_CHARS)
        : null;
    let agentId: string | null = null;
    if (scopeType === "agent_slug") {
      if (!scopeRef) {
        issues.push({
          field: "scope_ref",
          expected: "existing agent slug when scope_type='agent_slug'",
          got: describeType(body.scope_ref),
        });
      } else if (!getAgent(db, scopeRef)) {
        issues.push({
          field: "scope_ref",
          expected: "existing agent slug",
          got: scopeRef,
        });
      } else {
        agentId = scopeRef;
      }
    }

    const rawActionKind = body.action_kind;
    const actionKind = typeof rawActionKind === "string" ? rawActionKind : null;
    if (
      actionKind !== null
      && !ACTION_KINDS.has(actionKind as FeedbackActionKind)
    ) {
      issues.push({
        field: "action_kind",
        expected: "'notification' | 'agent_execution' | 'vault_write' | 'dm_reply' (optional)",
        got: actionKind,
      });
    }
    const actionRef =
      typeof body.action_ref === "string"
        ? sanitizeString(body.action_ref, MAX_ACTION_REF_CHARS)
        : null;

    if (issues.length > 0) {
      return c.json(
        {
          error: "validation_error",
          message: "Request body failed schema validation",
          issues,
        },
        400,
      );
    }

    const normalizedScopeRef = scopeType === "agent_slug" ? scopeRef : null;
    const deduped = findRecentFeedbackSignal(db, {
      scopeType: scopeType as FeedbackScopeType,
      scopeRef: normalizedScopeRef,
      summary,
      withinSeconds: DEDUP_TTL_SECONDS,
    });
    if (deduped) {
      return c.json({ id: deduped.id, deduped: true });
    }

    const evidence = sanitizeEvidence(body.evidence);
    const id = recordFeedbackSignal(db, {
      source: source as FeedbackSignalSource,
      valence: valence as FeedbackSignalValence,
      scopeType: scopeType as FeedbackScopeType,
      scopeRef: normalizedScopeRef,
      actionKind: actionKind as FeedbackActionKind | null,
      actionRef,
      agentId,
      summary,
      evidence: {
        ...(isRecord(evidence)
          ? evidence
          : evidence === null
            ? {}
            : { value: evidence }),
        ...(kind ? { kind } : {}),
      },
    });
    logger.info(
      { id, source, scopeType, scopeRef: normalizedScopeRef },
      "Feedback signal recorded",
    );
    return c.json({ id });
  });

  app.post("/feedback/consume", async (c) => {
    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.body;
    if (!isRecord(body)) {
      return c.json(
        {
          error: "validation_error",
          message: "Body must be a JSON object",
          expectedShape: '{"ids": number[], "lessonRef"?: string}',
        },
        400,
      );
    }
    if (!Array.isArray(body.ids)) {
      return c.json(
        {
          error: "validation_error",
          message: "'ids' must be an array of integer feedback signal ids",
          expectedShape: '{"ids": number[], "lessonRef"?: string}',
        },
        400,
      );
    }
    const nonInt = body.ids.find((id) => typeof id !== "number" || !Number.isInteger(id));
    if (nonInt !== undefined) {
      return c.json(
        {
          error: "validation_error",
          message: "'ids' must contain only integers",
          got: JSON.stringify(nonInt),
        },
        400,
      );
    }
    const lessonRef =
      typeof body.lessonRef === "string"
        ? sanitizeString(body.lessonRef, 240)
        : null;
    const result = consumeFeedbackSignals(db, body.ids as number[], lessonRef);
    logger.info({ consumed: result.consumed }, "Feedback signals consumed");
    return c.json(result);
  });

  return app;
}
