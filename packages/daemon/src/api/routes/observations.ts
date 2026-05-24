import { Hono } from "hono";
import type { ApiDependencies } from "../server.js";
import {
  consumeObservations,
  getNoveltyDistribution,
  getObservationStats,
  getPendingObservations,
  getSummaryStatusCounts,
  recordObservation,
} from "../../db/observations.js";
import { readIntegrationFlipLock } from "../../core/integration-lifecycle.js";
import { createLogger } from "../../logging.js";
import { DEFAULT_JSON_BODY_MAX_BYTES, readJsonBody } from "../json-body.js";
import { composeIssue, respondWithAgentError } from "../helpers/agent-errors.js";
import {
  BATCH_EXAMPLE,
  BATCH_EXPECTED_SHAPE,
  BATCH_MAX_OBSERVATIONS,
  type BatchItemResult,
  inferIntegrationKeyFromSource as inferIntegrationKeyFromSourceShared,
  normalizeMailObservationPayload as normalizeMailObservationPayloadShared,
  processObservationsBatch,
} from "../../services/observations-batch.js";

const logger = createLogger("observations-api");

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return value === "true" || value === "1";
}

function parseNumber(value: string | undefined, defaultValue: number): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : defaultValue;
}

function parsePayload(payload: string | null): unknown {
  if (!payload) return null;
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}

/**
 * docs/design/appendices/routine-data-acquisition.md §6.7 — turn the comma-separated
 * `?source_prefix=gmail:,outlook_mail:` query string into a list the
 * db helper can OR via per-prefix `LIKE` predicates. Returns
 * `undefined` (not `[]`) when the param is absent so the db helper can
 * cleanly distinguish "no multi-prefix filter requested" from "empty
 * prefix list".
 *
 * Empty / whitespace-only segments are dropped here (the db helper
 * trims again as a defense-in-depth measure) — a caller passing
 * `?source_prefix=,gmail:,` shouldn't widen the query to every row.
 */
function parseSourcePrefixes(raw: string | undefined): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return parts.length > 0 ? parts : undefined;
}

/**
 * docs/design/appendices/routine-data-acquisition.md CR2 — resolve `since=` /
 * `observed_at_after=` from the request, validate the format, and
 * coerce empty strings to `undefined` so the db filter is skipped
 * rather than emitted as `datetime(observed_at) >= datetime("")`
 * (which evaluates to NULL and silently drops every row).
 *
 * Returns:
 *  - `{ ok: true, value: undefined }` — neither param present, or
 *    both were empty / whitespace-only.
 *  - `{ ok: true, value: "<iso>" }` — a non-empty, parseable timestamp
 *    (canonical `since` wins over the `observed_at_after` alias when
 *    both are supplied).
 *  - `{ ok: false, raw, param }` — a non-empty value was provided but
 *    `Date.parse` rejected it. The route turns this into 400.
 */
function resolveSinceParam(
  rawSince: string | undefined,
  rawAlias: string | undefined,
):
  | { ok: true; value: string | undefined }
  | { ok: false; raw: string; param: "since" | "observed_at_after" } {
  const sinceClean = rawSince !== undefined ? rawSince.trim() : "";
  const aliasClean = rawAlias !== undefined ? rawAlias.trim() : "";
  if (sinceClean.length > 0) {
    return Number.isFinite(Date.parse(sinceClean))
      ? { ok: true, value: sinceClean }
      : { ok: false, raw: sinceClean, param: "since" };
  }
  if (aliasClean.length > 0) {
    return Number.isFinite(Date.parse(aliasClean))
      ? { ok: true, value: aliasClean }
      : { ok: false, raw: aliasClean, param: "observed_at_after" };
  }
  return { ok: true, value: undefined };
}

/**
 * INTEGRATION_NATIVE_MODE_DESIGN.md §11.3.1 — map an observation `source`
 * string to the integration key whose flip lock would gate writes against
 * it. The agent's hourly_check / native-mode skill always uses one of the
 * registry's integration keys verbatim as the `source` value (e.g.
 * `"gmail"`, `"google_calendar"`, `"notion"`). Sources outside the
 * registry (Obsidian, Git, messaging adapter, system) are never locked
 * and return null.
 *
 * Matches the exact key first, then falls back to a colon prefix (e.g.
 * `"gmail:account-1"`) so per-account / per-database source values still
 * resolve. Returns null for anything else.
 */
// inferIntegrationKeyFromSource + normalizeMailObservationPayload moved to
// `services/observations-batch.ts` so the SDK MCP tool
// `mcp__aitne-observations__submit_observations` can reuse them. The route
// re-exports the imports under the same local names so the rest of this
// file (POST /observations, the legacy /observations/batch envelope code,
// metric helpers below) reads identically.
const inferIntegrationKeyFromSource = inferIntegrationKeyFromSourceShared;
const normalizeMailObservationPayload = normalizeMailObservationPayloadShared;

/**
 * cost-reduction-structural §A "Failure modes" — the summary may be
 * outdated when the worker lags far behind the observation moment (e.g.
 * laptop-sleep backlog reclaimed at startup, where the summarizer has
 * caught up by the time hourly_check runs but the underlying source
 * may have shifted in between). Surface a `summaryStale` flag the
 * consumer skill can branch on, rather than asking the LLM to do
 * timestamp arithmetic.
 *
 * Threshold: summary_at older than observed_at + STALE_HOURS hours.
 * 6 hours mirrors the design doc's bounded-validity window.
 */
const SUMMARY_STALE_AFTER_HOURS = 6;

function isSummaryStale(observedAt: string, summaryAt: string | null): boolean {
  if (!summaryAt) return false;
  const observedMs = parseSqliteTimestampMs(observedAt);
  const summaryMs = parseSqliteTimestampMs(summaryAt);
  if (observedMs === null || summaryMs === null) return false;
  return summaryMs > observedMs + SUMMARY_STALE_AFTER_HOURS * 3600 * 1000;
}

function parseSqliteTimestampMs(raw: string): number | null {
  // Accept both SQLite's CURRENT_TIMESTAMP shape ("YYYY-MM-DD HH:MM:SS",
  // assumed UTC) and the ISO-8601 string the worker writes via
  // `new Date().toISOString()`.
  if (raw.includes("T")) {
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : null;
  }
  const ms = Date.parse(`${raw.replace(" ", "T")}Z`);
  return Number.isFinite(ms) ? ms : null;
}

export function createObservationRoutes(deps: ApiDependencies): Hono {
  const app = new Hono();
  const { db } = deps;

  app.get("/observations", (c) => {
    const pending = parseBoolean(c.req.query("pending"), true);
    const limit = Math.min(Math.max(parseNumber(c.req.query("limit"), 20), 1), 100);
    const offset = Math.max(parseNumber(c.req.query("offset"), 0), 0);
    const source = c.req.query("source");
    const sourcePrefixRaw = c.req.query("source_prefix");
    const actor = c.req.query("actor");
    // docs/design/appendices/routine-data-acquisition.md §6.7 / CR2 — `since=` is the
    // canonical name; `observed_at_after=` is the routine-side alias
    // (`since` wins when both are supplied). Empty / whitespace-only
    // values are coerced to "no filter" rather than `datetime("")
    // → NULL → drop all rows", and an unparseable string returns 400
    // so misconfigured callers fail loud instead of silently filtering
    // everything out.
    const sinceResolution = resolveSinceParam(
      c.req.query("since"),
      c.req.query("observed_at_after"),
    );
    if (!sinceResolution.ok) {
      return c.json(
        {
          error: "invalid_since",
          param: sinceResolution.param,
          value: sinceResolution.raw,
          message:
            `'${sinceResolution.param}' must be an ISO 8601 timestamp or SQL UTC datetime`,
        },
        400,
      );
    }

    if (actor && !["user", "agent", "system", "unknown"].includes(actor)) {
      return respondWithAgentError(c, 400, [
        composeIssue("observations.invalid_actor", {
          field: "actor",
          received: actor,
        }),
      ]);
    }

    const sourceFilterPrefixes = parseSourcePrefixes(sourcePrefixRaw);

    const observations = getPendingObservations(db, {
      pending,
      limit,
      offset,
      sourceFilter: source,
      sourceFilterPrefixes,
      actorFilter: actor as "user" | "agent" | "system" | "unknown" | undefined,
      since: sinceResolution.value,
    }).map((row) => ({
      id: row.id,
      source: row.source,
      ref: row.ref,
      changeType: row.change_type,
      actor: row.actor,
      observedAt: row.observed_at,
      payload: parsePayload(row.payload),
      consumedAt: row.consumed_at,
      consumedBy: row.consumed_by,
      // cost-reduction-structural §A — summarizer-populated fields. Null
      // when the summarizer has not yet caught up; the consumer must
      // fall back to legacy fetch-on-doubt in that case. `summaryStale`
      // is the §A "Failure modes" 6h gate, computed daemon-side so the
      // consumer skill never reasons about timestamps.
      summaryText: row.summary_text,
      noveltyScore: row.novelty_score,
      summaryStatus: row.summary_status,
      summaryAt: row.summary_at,
      summaryBackend: row.summary_backend,
      summaryStale: isSummaryStale(row.observed_at, row.summary_at),
    }));

    return c.json({ observations, limit, offset, pending });
  });

  /**
   * POST /observations — record an agent-originated observation.
   *
   * Used by `routine.hourly_check` to queue `roadmap_candidate` signals
   * (long-horizon intents too weak to write to roadmap.md directly;
   * ROADMAP-REDESIGN §3.4 RFC-C) AND by INTEGRATION_NATIVE_MODE_DESIGN.md
   * §8.3 native-mode hourly_check turns to persist the materialised mail
   * thread / calendar event list the agent just fetched via the main
   * backend's MCP. The DB layer UPSERTs on `(source, ref)` where
   * `consumed_at IS NULL`, so re-posting the same candidate across hourly
   * ticks coalesces instead of duplicating.
   *
   * §8.3 server-side hash: the daemon computes `contentHash` from the
   * canonical payload via the shared util in `@aitne/shared/observations-hash`
   * and returns it in the response. Pollers and the delegated-sync-worker
   * route through the same util so hashes are comparable across modes — a
   * `delegated → native` flip dedups against pre-flip observations.
   *
   * Actor defaults to `agent` here — the user and system channels have
   * their own writers (vault watchers, mail poller, etc.). Permitting
   * only `agent` / `system` guards against prompt-injection attempts to
   * forge user-authored observations.
   *
   * §11.3.1 defensive lock-window check: if a mode-flip is currently in
   * progress for the integration owning this `source`, reject the write
   * with 409 to prevent straggler observations from landing under the
   * old mode label. Sources outside the integration registry (Obsidian,
   * Git, messaging adapter) are never rejected.
   */
  const RECORD_EXPECTED_SHAPE =
    '{"source": string, "ref": string, "changeType"?: "created"|"modified"|"deleted", "actor"?: "agent"|"system", "payload"?: unknown}';
  const RECORD_EXAMPLE =
    '{"source":"roadmap_candidate:travel","ref":"trip-portland-2026-summer","changeType":"created","actor":"agent","payload":{"note":"DM mentioned Portland trip"}}';

  app.post("/observations", async (c) => {
    // Peek at the raw body BEFORE delegating to `readJsonBody` so we can
    // turn a query-string-shaped body ("limit=30", "actor=user&limit=20")
    // into a method-confusion hint. Production telemetry showed the
    // hourly_check agent sending `POST /api/observations` with body
    // `limit=30`, expecting it to fetch. Forwarding readJsonBody's
    // generic "Unexpected token 'l'" message gave the agent no signal
    // that the right call was `GET /api/observations?limit=30`.
    //
    // Size cap mirrors `readJsonBody`'s defense-in-depth: declared
    // Content-Length AND post-read byteLength are both checked against
    // `DEFAULT_JSON_BODY_MAX_BYTES` (1 MiB). Without this an inline
    // reader would happily buffer a malicious 10 MB body and pin RAM.
    const declared = c.req.header("content-length");
    if (declared !== undefined) {
      const declaredN = Number.parseInt(declared, 10);
      if (Number.isFinite(declaredN) && declaredN > DEFAULT_JSON_BODY_MAX_BYTES) {
        return c.json(
          {
            error: "body_too_large",
            maxBytes: DEFAULT_JSON_BODY_MAX_BYTES,
            actualBytes: declaredN,
          },
          413,
        );
      }
    }
    let raw: string;
    try {
      raw = await c.req.text();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return c.json(
        { error: "invalid_json_body", message: detail },
        400,
      );
    }
    const actualBytes = Buffer.byteLength(raw, "utf-8");
    if (actualBytes > DEFAULT_JSON_BODY_MAX_BYTES) {
      return c.json(
        {
          error: "body_too_large",
          maxBytes: DEFAULT_JSON_BODY_MAX_BYTES,
          actualBytes,
        },
        413,
      );
    }
    const trimmed = raw.trim();
    if (trimmed.length > 0 && trimmed[0] !== "{" && trimmed[0] !== "[") {
      // A bare `key=value(&key=value)+` body shape is unambiguous:
      // there is no JSON document that starts with a bare identifier
      // followed by `=`. Suggest the GET form verbatim so the agent
      // can copy-paste it.
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed)) {
        return c.json(
          {
            error: "method_confusion",
            message:
              "POST /api/observations records a new observation (JSON body). Your body looks like a query string — did you mean to GET?",
            hint: `Use GET /api/observations?${trimmed} to fetch, or POST with a JSON body matching expectedShape to record.`,
            expectedShape: RECORD_EXPECTED_SHAPE,
            example: RECORD_EXAMPLE,
          },
          400,
        );
      }
      return c.json(
        {
          error: "invalid_json_body",
          message: `Body must be a JSON object starting with '{' — received '${trimmed.slice(0, 32)}…'`,
          expectedShape: RECORD_EXPECTED_SHAPE,
          example: RECORD_EXAMPLE,
        },
        400,
      );
    }

    let body:
      | {
          source?: unknown;
          ref?: unknown;
          changeType?: unknown;
          actor?: unknown;
          payload?: unknown;
        }
      | null;
    try {
      body = trimmed.length === 0 ? null : (JSON.parse(trimmed) as typeof body);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return c.json(
        {
          error: "invalid_json_body",
          message: detail,
          expectedShape: RECORD_EXPECTED_SHAPE,
          example: RECORD_EXAMPLE,
        },
        400,
      );
    }

    const issues: Array<{ field: string; expected: string; got: string; hint?: string }> = [];
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json(
        {
          error: "validation_error",
          message: "Body must be a JSON object",
          expectedShape: RECORD_EXPECTED_SHAPE,
          example: RECORD_EXAMPLE,
        },
        400,
      );
    }
    if (typeof body.source !== "string" || body.source.length === 0) {
      issues.push({
        field: "source",
        expected: "non-empty string",
        got: body.source === undefined ? "missing" : typeof body.source,
        hint: "Use a registry-aware prefix like 'roadmap_candidate:<subkind>' or an integration key like 'gmail:<account>'",
      });
    }
    if (typeof body.ref !== "string" || body.ref.length === 0) {
      issues.push({
        field: "ref",
        expected: "non-empty string",
        got: body.ref === undefined ? "missing" : typeof body.ref,
        hint: "A stable identifier within the source — e.g. message id, file path, candidate slug",
      });
    }
    if (
      typeof body.changeType !== "string" &&
      body.changeType !== undefined
    ) {
      issues.push({
        field: "changeType",
        expected: "'created' | 'modified' | 'deleted' (optional, defaults to 'created')",
        got: typeof body.changeType,
      });
    }
    if (issues.length > 0) {
      return c.json(
        {
          error: "validation_error",
          message: "Request body failed schema validation",
          expectedShape: RECORD_EXPECTED_SHAPE,
          example: RECORD_EXAMPLE,
          issues,
        },
        400,
      );
    }
    // The `issues` array above guarantees `body.source` and `body.ref`
    // are non-empty strings; cast for the rest of the handler.
    const source = body.source as string;
    const ref = body.ref as string;
    const changeType =
      typeof body.changeType === "string" ? body.changeType : "created";
    if (!["created", "modified", "deleted"].includes(changeType)) {
      return c.json(
        {
          error: "invalid_change_type",
          message: `'changeType' must be one of 'created', 'modified', 'deleted' — received '${changeType}'`,
          hint: "Omit the field to default to 'created'",
        },
        400,
      );
    }
    const actor = typeof body.actor === "string" ? body.actor : "agent";
    if (!["agent", "system"].includes(actor)) {
      return c.json(
        {
          error: "invalid_actor",
          message: `'actor' must be 'agent' or 'system' — received '${actor}'`,
          hint: "User-originated observations come in through the vault / mail watchers; this endpoint only accepts agent/system writes",
        },
        400,
      );
    }

    // §11.3.1 — defensive flip-lock check. The integration key inferred
    // from the source is the same key the PATCH route would have locked.
    // If a flip is mid-flight, return 409 so the agent retries after the
    // drain completes. Sources that don't map to a registered integration
    // are pass-through (Obsidian / Git / messaging never lock).
    const lockedKey = inferIntegrationKeyFromSource(source);
    if (lockedKey) {
      const lock = readIntegrationFlipLock(db, lockedKey);
      if (lock) {
        logger.warn(
          { source: body.source, ref: body.ref, lockedKey, lock },
          "Observation write rejected — integration flip lock held",
        );
        return c.json(
          {
            error: "integration_flip_in_progress",
            integration: lockedKey,
            heldBy: lock,
            message: `A mode flip for '${lockedKey}' is in progress; retry shortly.`,
          },
          409,
        );
      }
    }

    const normalizedPayload = normalizeMailObservationPayload(source, body.payload);
    const result = recordObservation(db, {
      source,
      ref,
      changeType: changeType as "created" | "modified" | "deleted",
      actor: actor as "agent" | "system",
      payload: normalizedPayload,
    });
    logger.info(
      {
        source,
        ref,
        actor,
        contentHash: result.contentHash,
        action: result.action,
      },
      "Observation recorded via API",
    );

    // docs/design/appendices/routine-data-acquisition.md CR1 — surface payload-identical
    // re-posts as 409 so the routine pre-pass fetcher's JSON return
    // shape (`{"fetched":N,"posted":M,"duplicates":K,"errors":[…]}`)
    // can count them. The 409 body's `error` field distinguishes this
    // case from the §11.3.1 `integration_flip_in_progress` 409 above;
    // callers that don't care about the distinction still read `error`
    // before counting.
    if (result.action === "duplicate") {
      return c.json(
        {
          error: "duplicate",
          contentHash: result.contentHash,
          id: result.id,
          message:
            "Same (source, ref) pending row already stores this payload",
        },
        409,
      );
    }

    return c.json({
      ok: true,
      contentHash: result.contentHash,
      id: result.id,
      action: result.action,
    });
  });

  /**
   * POST /observations/batch — record many agent-originated observations in a
   * single transaction.
   *
   * Reason this exists: the routine.fetch_window pre-pass on Haiku posts
   * many observations per integration window (~20 mail messages, ~6 calendar
   * events). Calling `POST /observations` once per item collided with two
   * orthogonal safety layers in `claude-tool-collection.ts:bashCurlHook`:
   *
   *  1. The "one curl per Bash invocation" cap blocks `cat | bash`, chained
   *     `curl … ; curl …`, and `for` loops containing curl.
   *  2. URL extraction strips heredoc bodies before validation, so a
   *     `cat > /tmp/script.sh << 'EOF' … curl http://localhost:8321/… EOF`
   *     batching shape blocks with "curl command must contain an explicit
   *     localhost URL" — the URL lives in the stdin payload, not argv.
   *
   * Without this single-curl-with-array endpoint Haiku burns budget
   * cycles trying every batching shape (each blocked by one of the hooks)
   * and posts zero observations, leaving `today.md` empty. The bulk
   * endpoint resolves the cardinality mismatch without weakening either
   * hook.
   *
   * Body: `{ "observations": [...] }` with up to 200 entries per call.
   * Per-item validation mirrors POST /observations exactly. The whole
   * batch executes inside one `db.transaction()`; any per-item failure is
   * recorded in the response and the rest of the batch proceeds.
   *
   * Response is always 200 (or 400 for a malformed envelope). Per-item
   * outcomes live in `results[*].status` so the agent doesn't retry the
   * whole batch on a partial failure.
   */
  // BATCH_MAX_OBSERVATIONS / BATCH_EXPECTED_SHAPE / BATCH_EXAMPLE /
  // BatchItemResult / validateBatchItem moved to
  // `services/observations-batch.ts` so the SDK MCP tool
  // `mcp__aitne-observations__submit_observations` and this HTTP route
  // share the same per-item validation + recordObservation loop. The
  // route keeps only the HTTP-envelope concerns (content-length cap,
  // JSON parse, batch-too-large 400) below.

  app.post("/observations/batch", async (c) => {
    // Size-cap defense mirrors POST /observations.
    const declared = c.req.header("content-length");
    if (declared !== undefined) {
      const declaredN = Number.parseInt(declared, 10);
      if (Number.isFinite(declaredN) && declaredN > DEFAULT_JSON_BODY_MAX_BYTES) {
        return c.json(
          {
            error: "body_too_large",
            maxBytes: DEFAULT_JSON_BODY_MAX_BYTES,
            actualBytes: declaredN,
          },
          413,
        );
      }
    }
    let raw: string;
    try {
      raw = await c.req.text();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return respondWithAgentError(c, 400, [
        composeIssue("observations.invalid_json_body", {
          field: "body",
          received: detail,
        }),
      ], { legacyFields: { message: detail } });
    }
    const actualBytes = Buffer.byteLength(raw, "utf-8");
    if (actualBytes > DEFAULT_JSON_BODY_MAX_BYTES) {
      return c.json(
        {
          error: "body_too_large",
          maxBytes: DEFAULT_JSON_BODY_MAX_BYTES,
          actualBytes,
        },
        413,
      );
    }

    let envelope: { observations?: unknown } | null;
    try {
      envelope = raw.trim().length === 0 ? null : (JSON.parse(raw) as typeof envelope);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return c.json(
        {
          error: "invalid_json_body",
          message: detail,
          expectedShape: BATCH_EXPECTED_SHAPE,
          example: BATCH_EXAMPLE,
        },
        400,
      );
    }
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
      return c.json(
        {
          error: "validation_error",
          message: "Body must be a JSON object with an 'observations' array",
          expectedShape: BATCH_EXPECTED_SHAPE,
          example: BATCH_EXAMPLE,
        },
        400,
      );
    }
    if (!Array.isArray(envelope.observations)) {
      return c.json(
        {
          error: "validation_error",
          message: "'observations' must be an array",
          expectedShape: BATCH_EXPECTED_SHAPE,
          example: BATCH_EXAMPLE,
          hint:
            "Wrap your observation objects in an 'observations' array — POST {\"observations\":[…]}",
        },
        400,
      );
    }
    if (envelope.observations.length === 0) {
      // Empty batch is a documented no-op so the pre-pass can emit a
      // zero-event window without a 400 stutter.
      return c.json({
        results: [] as BatchItemResult[],
        fetched: 0,
        posted: 0,
        duplicates: 0,
        errors: 0,
      });
    }
    if (envelope.observations.length > BATCH_MAX_OBSERVATIONS) {
      return c.json(
        {
          error: "batch_too_large",
          message: `Batch size ${envelope.observations.length} exceeds maximum ${BATCH_MAX_OBSERVATIONS}`,
          maxItems: BATCH_MAX_OBSERVATIONS,
          hint: "Split the batch into chunks of at most 200 items.",
        },
        400,
      );
    }

    const batchResult = processObservationsBatch(db, envelope.observations);

    logger.info(
      {
        count: envelope.observations.length,
        posted: batchResult.posted,
        duplicates: batchResult.duplicates,
        errors: batchResult.errors,
      },
      "Observations batch recorded via API",
    );

    return c.json(batchResult);
  });

  /**
   * Field-level validation contract for `POST /observations/consume`.
   *
   * Without per-field error envelopes, a single Stage-3 hourly_check can
   * burn turns retrying this endpoint with shape variants
   * (`correlation_id` snake_case, stringified ids, the angle-bracket
   * placeholder copied verbatim, per-id paths, etc.). The legacy
   * `{ error: "validation_error" }` response gives the agent zero signal
   * about which field was wrong, so it mutates a random field and retries.
   * Returning the full schema + the specific issue + a one-line hint lets
   * the agent self-correct on the next turn instead of the eighth.
   */
  const CONSUME_EXPECTED_SHAPE =
    '{"ids": number[], "correlationId": string}';
  const CONSUME_EXAMPLE =
    '{"ids":[14,17],"correlationId":"hourly-2026-04-23T15:00:00Z-7af3"}';

  app.post("/observations/consume", async (c) => {
    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.body as
      | {
          ids?: unknown;
          correlationId?: unknown;
          // Accepted on the input shape so we can detect the snake_case
          // mistake and return a targeted hint, not as a fallback. The
          // route never reads this field's value to act on it.
          correlation_id?: unknown;
        }
      | null;

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json(
        {
          error: "validation_error",
          message: "Body must be a JSON object",
          expectedShape: CONSUME_EXPECTED_SHAPE,
          example: CONSUME_EXAMPLE,
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

    if (
      body.correlation_id !== undefined &&
      body.correlationId === undefined
    ) {
      issues.push({
        field: "correlationId",
        expected: "string (camelCase)",
        got: "received 'correlation_id' (snake_case) instead",
        hint: "Rename the field to camelCase 'correlationId' — value is the verbatim id from the <event_correlation_id> tag in your prompt context",
      });
    } else if (typeof body.correlationId !== "string") {
      issues.push({
        field: "correlationId",
        expected: "string",
        got:
          body.correlationId === undefined
            ? "missing"
            : typeof body.correlationId,
        hint: "Copy verbatim from <event_correlation_id>…</event_correlation_id> in your prompt context",
      });
    } else if (body.correlationId.trim().length === 0) {
      issues.push({
        field: "correlationId",
        expected: "non-empty string",
        got: "empty string",
        hint: "Copy verbatim from <event_correlation_id>…</event_correlation_id> in your prompt context",
      });
    } else if (
      body.correlationId.startsWith("<") &&
      body.correlationId.endsWith(">")
    ) {
      issues.push({
        field: "correlationId",
        expected: "verbatim correlation id",
        got: `placeholder text '${body.correlationId}'`,
        hint: "Use the real id from <event_correlation_id>…</event_correlation_id>, not the angle-bracket placeholder",
      });
    }

    if (!Array.isArray(body.ids)) {
      issues.push({
        field: "ids",
        expected: "number[]",
        got: body.ids === undefined ? "missing" : typeof body.ids,
        hint: "Array of integer observation row ids — e.g. [14, 17]",
      });
    } else if (body.ids.length > 0) {
      // Empty array is a documented no-op (preserves the legacy
      // contract: `consumeObservations` returns `{consumed:0,notFound:[]}`
      // for an empty list). Only validate element shape when the array
      // actually has content.
      const stringIds = body.ids.filter((id) => typeof id === "string");
      if (stringIds.length > 0) {
        issues.push({
          field: "ids",
          expected: "number[]",
          got: `array contains strings (e.g. ${JSON.stringify(stringIds.slice(0, 3))})`,
          hint: 'Use integers, not strings — [14, 17] not ["14", "17"]',
        });
      } else {
        const nonInt = body.ids.find(
          (id) => typeof id !== "number" || !Number.isInteger(id),
        );
        if (nonInt !== undefined) {
          issues.push({
            field: "ids",
            expected: "number[] (integers)",
            got: `array contains non-integer value ${JSON.stringify(nonInt)}`,
            hint: "ids must be integer observation row ids returned by GET /api/observations",
          });
        }
      }
    }

    if (issues.length > 0) {
      return c.json(
        {
          error: "validation_error",
          message: "Request body failed schema validation",
          expectedShape: CONSUME_EXPECTED_SHAPE,
          example: CONSUME_EXAMPLE,
          issues,
        },
        400,
      );
    }

    const ids = body.ids as number[];
    const correlationId = body.correlationId as string;
    const result = consumeObservations(db, ids, correlationId);
    logger.info(
      { consumed: result.consumed, correlationId },
      "Observations consumed",
    );
    return c.json(result);
  });

  /**
   * Helpful 405 for the per-id consume shape the agent commonly reaches
   * for (`POST /api/observations/:id/consume`). Without an explicit
   * handler this path falls through to Hono's 404 with body
   * `"404 Not Found"`, which gives the agent nothing to act on. Returning
   * a 405 with the canonical bulk-endpoint hint pulls the agent back onto
   * the correct shape on the next turn.
   */
  app.all("/observations/:id/consume", (c) => {
    const id = c.req.param("id");
    return c.json(
      {
        error: "use_bulk_endpoint",
        message:
          "Per-id consume is not supported. Use the bulk endpoint with a single-element ids array.",
        expectedShape: CONSUME_EXPECTED_SHAPE,
        example: CONSUME_EXAMPLE,
        hint: `POST /api/observations/consume with body {"ids":[${id}],"correlationId":"<copy from <event_correlation_id>>"}`,
      },
      405,
    );
  });

  /**
   * Helpful 405 for `GET /api/observations/consume`. The bulk consume is
   * POST-only — without this handler the request 404s with no actionable
   * detail, and the agent's recovery loop produced 8x retries in one
   * routine.hourly_check session.
   */
  app.get("/observations/consume", (c) =>
    c.json(
      {
        error: "method_not_allowed",
        message: "GET is not supported on /api/observations/consume — use POST.",
        expectedShape: CONSUME_EXPECTED_SHAPE,
        example: CONSUME_EXAMPLE,
        hint: `POST /api/observations/consume with body ${CONSUME_EXAMPLE}`,
      },
      405,
      { Allow: "POST" },
    ),
  );

  app.get("/observations/stats", (c) => {
    const stats = getObservationStats(db);
    // cost-reduction-structural §A telemetry — surface summarizer health
    // alongside the legacy stats so the dashboard observability card has
    // a single fetch path.
    const summaryStatusCounts = getSummaryStatusCounts(db);
    const noveltyDistribution = getNoveltyDistribution(db);
    return c.json({
      ...stats,
      summaryStatusCounts,
      noveltyDistribution,
    });
  });

  return app;
}
