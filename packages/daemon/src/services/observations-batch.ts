/**
 * Pure batch processor for observation ingestion.
 *
 * Shared between two callers that hold the same contract but live behind
 * different surfaces:
 *
 *   - `POST /observations/batch` HTTP route — handles HTTP-envelope concerns
 *     (content-length cap, JSON parse, status-code shaping) then delegates
 *     here for the per-item write loop.
 *   - SDK MCP tool `mcp__aitne-observations__submit_observations` — invoked
 *     by the Claude pre-pass session directly via the in-process MCP
 *     transport. No shell parser, no curl envelope.
 *
 * The MCP path exists because the Claude Code SDK's bash parser (`Ae6` in
 * `cli.js`) flags any command containing characters in the Unicode-
 * whitespace regex (` `, ` `, ` -​`, ` `, ` `,
 * ` `, ` `, `　`, `﻿`) as `too-complex` and falls through
 * to ask-mode — which under `permissionMode: "dontAsk"` is denied. Mail
 * subjects/snippets from promotional senders (Amazon, marketing lists) and
 * Japanese content routinely contain these characters, which produced a
 * deterministic gmail pre-pass failure on 2026-05-18 (3 attempts, ~$0.16
 * burned, visible as `budget-cap`). The in-process MCP tool sends
 * observations as structured JSON over the MCP transport, completely
 * bypassing the shell parser.
 */

import type Database from "better-sqlite3";
import {
  INTEGRATION_DESCRIPTORS,
  INTEGRATION_KEYS,
  isIntegrationKey,
  type IntegrationKey,
} from "@aitne/shared";
import { readIntegrationFlipLock } from "../core/integration-lifecycle.js";
import { recordObservation } from "../db/observations.js";
import { createLogger } from "../logging.js";

const logger = createLogger("observations-batch");

/** Maximum items per `submit_observations` / `POST /observations/batch` call. */
export const BATCH_MAX_OBSERVATIONS = 200;

export const BATCH_EXPECTED_SHAPE =
  '{"observations": [{"source": string, "ref": string, "changeType"?: "created"|"modified"|"deleted", "actor"?: "agent"|"system", "payload"?: unknown}, ...]}';
export const BATCH_EXAMPLE =
  '{"observations":[{"source":"google_calendar:primary","ref":"evt-1","payload":{"kind":"calendar","providerId":"primary","raw":{"title":"…"}}},{"source":"google_calendar:primary","ref":"evt-2","payload":{"kind":"calendar","providerId":"primary","raw":{"title":"…"}}}]}';

export type BatchItemStatus =
  | "created"
  | "modified"
  | "duplicate"
  | "flip_locked"
  | "validation_error";

export interface BatchItemResult {
  index: number;
  status: BatchItemStatus;
  /** Echoed for correlation when the agent needs to map a failure back to its input. */
  source?: string;
  ref?: string;
  contentHash?: string;
  id?: number;
  error?: string;
  hint?: string;
}

export interface ProcessBatchResult {
  results: BatchItemResult[];
  fetched: number;
  posted: number;
  duplicates: number;
  errors: number;
}

/**
 * Map a `source` string to its registered integration key. Matches the exact
 * key first, then falls back to a colon prefix (e.g. `"gmail:account-1"`)
 * so per-account / per-database source values still resolve. Returns null
 * for anything else.
 */
export function inferIntegrationKeyFromSource(
  source: string,
): IntegrationKey | null {
  if (isIntegrationKey(source)) return source;
  for (const key of INTEGRATION_KEYS) {
    if (source.startsWith(`${key}:`)) return key;
  }
  return null;
}

/** Per-integration source prefixes whose pre-pass payload carries the
 *  mail shape (`payload.raw.from`, no `is_read`). Drives
 *  {@link normalizeMailObservationPayload} so the hourly-check gate can
 *  read a canonical `is_read` + `from_email` shape regardless of mode. */
const MAIL_OBSERVATION_INTEGRATION_KEYS: ReadonlySet<IntegrationKey> = new Set(
  INTEGRATION_KEYS.filter((k) => {
    const partial = INTEGRATION_DESCRIPTORS[k].prePassPartial;
    return typeof partial === "string" && partial.startsWith("mail-acquire.");
  }),
);

const EMAIL_RE = /<([^<>@\s]+@[^<>@\s]+)>|([^\s<>@]+@[^\s<>@]+)/;

function extractEmailAddress(raw: string): string | null {
  const match = EMAIL_RE.exec(raw);
  if (!match) return null;
  return (match[1] ?? match[2] ?? "").trim().toLowerCase() || null;
}

/**
 * HOURLY_CHECK_GATE_REDESIGN_PLAN.md Phase 3 — normalize pre-pass mail
 * payloads at the ingest chokepoint. See the longer comment in the route
 * for the full rationale; the rules:
 *   - mail integration source AND `payload.raw.from` is a string → set
 *     `is_read = 0` and `from_email = <lowercased extracted address>`
 *     (unless already present, in which case respect the caller).
 *   - non-mail or non-shape-matching payloads pass through verbatim.
 */
export function normalizeMailObservationPayload(
  source: string,
  payload: unknown,
): unknown {
  const key = inferIntegrationKeyFromSource(source);
  if (!key || !MAIL_OBSERVATION_INTEGRATION_KEYS.has(key)) return payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const obj = payload as Record<string, unknown>;
  const raw = obj.raw;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return payload;
  const fromValue = (raw as Record<string, unknown>).from;
  if (typeof fromValue !== "string") return payload;

  const next: Record<string, unknown> = { ...obj };
  if (!("is_read" in next)) {
    next.is_read = 0;
  }
  if (!("from_email" in next)) {
    const extracted = extractEmailAddress(fromValue);
    if (extracted) {
      next.from_email = extracted;
    }
  }
  return next;
}

type ValidatedBatchItem =
  | {
      ok: true;
      source: string;
      ref: string;
      changeType: "created" | "modified" | "deleted";
      actor: "agent" | "system";
      payload: unknown;
    }
  | { ok: false; result: BatchItemResult };

export function validateBatchItem(item: unknown, index: number): ValidatedBatchItem {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return {
      ok: false,
      result: {
        index,
        status: "validation_error",
        error: "item must be a JSON object",
        hint: BATCH_EXPECTED_SHAPE,
      },
    };
  }
  const obj = item as {
    source?: unknown;
    ref?: unknown;
    changeType?: unknown;
    actor?: unknown;
    payload?: unknown;
  };
  if (typeof obj.source !== "string" || obj.source.length === 0) {
    return {
      ok: false,
      result: {
        index,
        status: "validation_error",
        error: "'source' must be a non-empty string",
        hint: "Use 'gmail:<account>', 'google_calendar:<calendarId>', 'notion:<dbId>', etc.",
      },
    };
  }
  if (typeof obj.ref !== "string" || obj.ref.length === 0) {
    return {
      ok: false,
      result: {
        index,
        status: "validation_error",
        source: obj.source,
        error: "'ref' must be a non-empty string",
        hint: "Stable id within the source — e.g. message id, event id",
      },
    };
  }
  const changeType =
    typeof obj.changeType === "string" ? obj.changeType : "created";
  if (!["created", "modified", "deleted"].includes(changeType)) {
    return {
      ok: false,
      result: {
        index,
        status: "validation_error",
        source: obj.source,
        ref: obj.ref,
        error: `'changeType' must be 'created'|'modified'|'deleted' — received '${changeType}'`,
      },
    };
  }
  const actor = typeof obj.actor === "string" ? obj.actor : "agent";
  if (!["agent", "system"].includes(actor)) {
    return {
      ok: false,
      result: {
        index,
        status: "validation_error",
        source: obj.source,
        ref: obj.ref,
        error: `'actor' must be 'agent' or 'system' — received '${actor}'`,
      },
    };
  }
  return {
    ok: true,
    source: obj.source,
    ref: obj.ref,
    changeType: changeType as "created" | "modified" | "deleted",
    actor: actor as "agent" | "system",
    payload: obj.payload,
  };
}

/**
 * Run the per-item validation + flip-lock check + recordObservation loop
 * inside one explicit transaction. Returns the per-item result array so
 * callers can echo it back to the agent for self-correlation.
 *
 * Callers are responsible for:
 *  - bounding the batch size against {@link BATCH_MAX_OBSERVATIONS} (this
 *    function trusts the input length; the route caps before calling).
 *  - any wire-format concerns (HTTP body parsing, MCP envelope shaping).
 *
 * The loop is single-pass and skip-on-failure: a `validation_error` or
 * `flip_locked` item does NOT abort the batch — it lands in `results[]`
 * with the right `status` and `errorCount` is incremented. Same semantics
 * as the original in-route implementation; preserved so existing tests
 * that assert mixed-success/error outcomes keep passing.
 */
export function processObservationsBatch(
  db: Database.Database,
  observations: readonly unknown[],
): ProcessBatchResult {
  const results: BatchItemResult[] = [];
  let posted = 0;
  let duplicates = 0;
  let errorCount = 0;

  const writeBatch = db.transaction((items: readonly unknown[]) => {
    for (let i = 0; i < items.length; i++) {
      const validated = validateBatchItem(items[i], i);
      if (!validated.ok) {
        results.push(validated.result);
        errorCount += 1;
        continue;
      }
      const lockedKey = inferIntegrationKeyFromSource(validated.source);
      if (lockedKey) {
        const lock = readIntegrationFlipLock(db, lockedKey);
        if (lock) {
          logger.warn(
            { source: validated.source, ref: validated.ref, lockedKey, lock },
            "Batch observation write rejected — integration flip lock held",
          );
          results.push({
            index: i,
            status: "flip_locked",
            source: validated.source,
            ref: validated.ref,
            error: `Integration '${lockedKey}' flip in progress`,
          });
          errorCount += 1;
          continue;
        }
      }
      const normalizedPayload = normalizeMailObservationPayload(
        validated.source,
        validated.payload,
      );
      const result = recordObservation(db, {
        source: validated.source,
        ref: validated.ref,
        changeType: validated.changeType,
        actor: validated.actor,
        payload: normalizedPayload,
      });
      if (result.action === "duplicate") {
        duplicates += 1;
        results.push({
          index: i,
          status: "duplicate",
          source: validated.source,
          ref: validated.ref,
          contentHash: result.contentHash,
          id: result.id,
        });
      } else {
        posted += 1;
        results.push({
          index: i,
          status: result.action,
          source: validated.source,
          ref: validated.ref,
          contentHash: result.contentHash,
          id: result.id,
        });
      }
    }
  });
  writeBatch(observations);

  return {
    results,
    fetched: observations.length,
    posted,
    duplicates,
    errors: errorCount,
  };
}
