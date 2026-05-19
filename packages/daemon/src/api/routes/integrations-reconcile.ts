import { Hono } from "hono";
import {
  isIntegrationKey,
  getSnapshotNormalizer,
  listSnapshotNormalizers,
  type IntegrationKey,
  type SnapshotActorHint,
} from "@aitne/shared";
import { reconcile, type ReconcileItem } from "../../services/integrations/reconcile.js";
import { readJsonBody } from "../json-body.js";
import { createLogger } from "../../logging.js";
import type { ApiDependencies } from "../server.js";
import {
  applyDriftEffects,
  emptyDriftSideEffects,
  type DriftSideEffects,
} from "../../core/drift-effects.js";

const logger = createLogger("integrations-reconcile-api");

/**
 * `POST /api/integrations/:key/reconcile` (INTEGRATION-DRIFT-DETECTION-PLAN.md
 * §6).
 *
 * The handler validates the request,
 * normalises payloads server-side (so LLM-driven callers can omit
 * `contentHash` and the daemon-side hash always wins), runs the pure
 * reconcile primitive, applies drift side effects inside the same SQLite
 * transaction, writes one `agent_actions` audit row per call, and returns
 * the diff.
 *
 * Risk tier: **Autonomous** (registered at `risk-classifier.ts:419`). The
 * plan's §6.0 walk-through ("Autonomous tenable: a fabricating agent can
 * pollute diffs but cannot launder a write as agent-attributed") is the
 * rationale; the LLM-driven path is gated by the window-key allowlist
 * below + per-call audit row. The endpoint mutates `integration_snapshots`
 * and writes an audit row, and Phase 2's drift-effects also insert
 * `agent_schedule` rows + emit on the EventBus inside the same transaction.
 *
 * Defense layers, in order:
 *   1. Daemon-internal callers (CalendarPoller, DelegatedSyncWorker,
 *      ImminentEventScheduler) call `reconcile()` directly. They bypass
 *      this route entirely; their inputs come from already-trusted poll
 *      paths.
 *   2. LLM agents POST to this endpoint with a window-key from the
 *      `RECONCILE_WINDOW_KEY_ALLOWLIST` below. Any other key returns 400.
 *   3. Per-call audit row (`action_type='reconcile'`) lets operators spot
 *      fabrication via `/api/observations/stats` `bySource`.
 */
export function createIntegrationReconcileRoutes(
  deps: ApiDependencies,
): Hono {
  const app = new Hono();
  const { db } = deps;

  app.post("/integrations/:key/reconcile", async (c) => {
    const key = c.req.param("key");
    if (!isIntegrationKey(key)) {
      return c.json({ error: "unknown_integration", key }, 404);
    }

    const normalizer = getSnapshotNormalizer(key);
    /* c8 ignore start — every IntegrationKey ships a normalizer after
     *   Phase 5; the branch survives so a future integration whose
     *   connector wiring lands before its normalizer fails fast with a
     *   precise contract instead of a 500 deeper. */
    if (!normalizer) {
      return c.json(
        {
          error: "unsupported_integration",
          message:
            `reconcile is not yet implemented for '${key}'`,
          key,
          supportedIntegrations: listSnapshotNormalizers(),
        },
        400,
      );
    }
    /* c8 ignore stop */

    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;

    // Phase 7 (k): `?dry-run=1` (or any truthy value) computes the diff
    // against the prior snapshot but writes nothing — no UPSERT, no DELETE,
    // no observation, no `today_refresh` schedule, no roadmap-refresh
    // trigger. Operators use this to inspect what the next non-dry-run
    // call would emit. The window-key allowlist (§6.0 defense layer 2) and
    // per-call audit row still apply; the audit detail records `mode`
    // so `audit --type=reconcile` retros separate inspections from real
    // mutations.
    const dryRunFlag = c.req.query("dry-run") ?? c.req.query("dryRun");
    const isDryRun = isTruthyQueryFlag(dryRunFlag);

    const startedAtIsoForValidation = new Date().toISOString();
    const validation = validateReconcileBody(parsedBody.body, key);
    if (!validation.ok) {
      // §6.0 defense layer 3: every POST attempt leaves a trace, including
      // malformed ones — operators rely on `bySource` in
      // /api/observations/stats to spot fabrication, and a 400 with no
      // record would let a misbehaving agent silently probe the route's
      // validation surface.
      writeReconcileAuditRow(deps, {
        integration: key,
        windowKey:
          typeof (parsedBody.body as { windowKey?: unknown })?.windowKey
            === "string"
            ? (parsedBody.body as { windowKey: string }).windowKey
            : "<invalid>",
        startedAtIso: startedAtIsoForValidation,
        result: "failed",
        items: 0,
        callerHashMismatches: 0,
        error: `validation_error:${validation.field}:${validation.error}`,
        diff: null,
        mode: isDryRun ? "dry-run" : "apply",
      });
      return c.json(
        {
          error: "validation_error",
          message: validation.error,
          field: validation.field,
        },
        400,
      );
    }

    const { req, callerHashMismatches } = validation;

    const startedAtIso = new Date().toISOString();
    let result: ReturnType<typeof reconcile>;
    let sideEffects: DriftSideEffects = emptyDriftSideEffects();
    let auditError: string | null = null;
    try {
      result = reconcile(
        db,
        { ...req, mode: isDryRun ? "dry-run" : "apply" },
        {
          normalizer,
          // Drift effects must NOT run in dry-run; reconcile already
          // honours `mode='dry-run'` by skipping `onDiffInTransaction`,
          // but we also nullify the closure here as a belt-and-braces
          // measure so a future refactor of reconcile cannot accidentally
          // fire side effects on an inspection call.
          onDiffInTransaction: isDryRun
            ? undefined
            : (diff) => {
              sideEffects = applyDriftEffects(req, diff, {
                db,
                calendarId: "primary",
                timezone: deps.config.timezone,
                todayWriteLock: deps.morningRoutineLock,
                triggerRoadmapRefresh: deps.triggerRoadmapRefresh,
              });
            },
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      auditError = message;
      writeReconcileAuditRow(deps, {
        integration: key,
        windowKey: req.windowKey,
        startedAtIso,
        result: "failed",
        items: req.items.length,
        callerHashMismatches,
        error: message,
        diff: null,
        mode: isDryRun ? "dry-run" : "apply",
      });
      logger.warn(
        { err, integration: key, windowKey: req.windowKey, dryRun: isDryRun },
        "reconcile failed",
      );
      return c.json(
        { error: "reconcile_failed", message },
        500,
      );
    }

    writeReconcileAuditRow(deps, {
      integration: key,
      windowKey: req.windowKey,
      startedAtIso,
      result: "success",
      items: req.items.length,
      callerHashMismatches,
      error: auditError,
      diff: result,
      mode: isDryRun ? "dry-run" : "apply",
    });

    return c.json({
      diff: {
        created: result.created,
        modified: result.modified,
        deleted: result.deleted,
        unchanged: result.unchanged,
        prunedOutOfWindow: result.prunedOutOfWindow,
        isInitialSnapshot: result.isInitialSnapshot,
      },
      sideEffects,
      meta: {
        callerHashMismatches,
        mode: isDryRun ? "dry-run" : "apply",
      },
    });
  });

  return app;
}

/**
 * Window keys an LLM-driven caller is allowed to author. Daemon-internal
 * callers bypass the route and write any window key directly. Plan §6.0
 * defense layer 2.
 *
 * Calendar-only by design (post-Phase-5 review): the LLM hourly_check
 * Step 0b fetches the same `[now-15min, now+60min)` and `[now, now+24h)`
 * windows the daemon's `delegated-sync-worker` uses for `primary:imminent`
 * and `primary:24h`, so an LLM POST and a worker POST land in the same
 * partition without disagreeing on bounds. Gmail (`inbox:7d`) and Notion
 * (`recently_updated`) are deliberately NOT on this list: a narrow
 * `newer_than:1d` (gmail) or `created_date_range:yesterday` (notion) LLM
 * fetch posted into the worker's 7-day partition would classify every
 * prior 1-7d-old item as `deleted` (the per-integration `inWindow`
 * predicate evaluates the prior payload's date against the LLM's
 * windowMin/Max, not the partition's nominal width — see
 * `reconcile.ts:319-345`). The fix is to keep gmail/notion authoring
 * inside the daemon worker only; the LLM consumes drift signals via
 * `GET /api/observations`. The corresponding Step 0a / 0c blocks of
 * `routine.hourly_check.delegated.<backend>.md` were rewritten to
 * forbid the POST and document the rationale; this allowlist is the
 * defense-in-depth backstop that catches a future overlay rewrite that
 * silently re-introduces the LLM call.
 *
 * `primary:14d` is reserved for the direct-mode CalendarPoller (Phase 2)
 * which calls reconcile in-process; it is intentionally absent here.
 */
const RECONCILE_WINDOW_KEY_ALLOWLIST: ReadonlySet<string> = new Set([
  "primary:24h",
  "primary:imminent",
]);

/**
 * Actor hints LLM-driven HTTP callers may attach to a reconcile item. The
 * design (§4.2 + §6) names `integration_writes` as the *authoritative*
 * source of `actor='agent'` attribution; `actorHint` is only a fallback for
 * daemon-internal callers that bypass this route. An HTTP body claiming
 * `actorHint='agent'` would let a confused-or-malicious agent suppress
 * legitimate user-edit observations by laundering them through its own
 * write. `system` is similarly daemon-internal-only. Daemon-internal
 * callers (CalendarPoller, DelegatedSyncWorker, etc.) call `reconcile()`
 * directly and bypass this validator entirely, so the constraint here is
 * route-only.
 */
const HTTP_ACTOR_HINTS: ReadonlySet<SnapshotActorHint> = new Set([
  "user",
  "unknown",
]);

interface ValidatedReconcileRequest {
  ok: true;
  req: {
    integration: IntegrationKey;
    windowKey: string;
    windowMin: string;
    windowMax: string;
    fetchedAt: string;
    items: ReconcileItem[];
    isInitialSnapshot?: boolean;
  };
  /** Items where the caller's `contentHash` did not match the server-side
   *  re-hash. The server stores its own hash in every case (per §5.2: never
   *  trust the caller's value blindly), but a mismatch is logged and
   *  surfaced in the audit detail / response meta so operators can spot a
   *  drift between the daemon-internal normalizer and an out-of-tree
   *  caller. */
  callerHashMismatches: number;
}

interface InvalidReconcileRequest {
  ok: false;
  error: string;
  field: string;
}

/**
 * Phase 7 (k): a query flag is "truthy" when present without a value
 * (`?dry-run`), set to `1` / `true` / `yes` / `on` (any case), or any
 * non-empty string that is not an explicit `0` / `false` / `no` / `off`.
 * Mirrors the convention `?reset=1` style across the existing API
 * surface (`/api/setup/...`, `/api/maintenance/...`).
 */
function isTruthyQueryFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  if (value === "") return true;
  const v = value.toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function isIsoLikeString(s: unknown): s is string {
  // Accept any non-empty string; the storage column is plain TEXT and
  // SQLite's lexicographic comparison is what reconcile relies on. Strict
  // ISO-8601 grammar is not the route's responsibility — it's the
  // upstream API's. Empty strings would silently break the inWindow
  // predicate, so we reject those.
  return typeof s === "string" && s.length > 0;
}

/**
 * Stricter check for the window-bound fields. The §5.1 sliding-window
 * predicate parses windowMin/windowMax with `Date.parse` and silently
 * treats NaN as "out of window", which would classify every prior item
 * missing from a new fetch as `prunedOutOfWindow` and drop every real
 * `deleted` observation on the floor. A typo like `windowMin: "yesterday"`
 * should fail loudly at the route boundary, not silently break diff
 * semantics three function calls deeper.
 */
function isParseableInstant(s: unknown): s is string {
  return typeof s === "string" && s.length > 0 && Number.isFinite(Date.parse(s));
}

function validateReconcileBody(
  body: unknown,
  key: IntegrationKey,
): ValidatedReconcileRequest | InvalidReconcileRequest {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "body must be a JSON object", field: "body" };
  }
  const b = body as Record<string, unknown>;

  const windowKey = b.windowKey;
  if (typeof windowKey !== "string" || windowKey.length === 0) {
    return {
      ok: false,
      error: "windowKey must be a non-empty string",
      field: "windowKey",
    };
  }
  if (!RECONCILE_WINDOW_KEY_ALLOWLIST.has(windowKey)) {
    return {
      ok: false,
      error:
        `windowKey '${windowKey}' is not on the LLM-callable allowlist (allowed: ${[...RECONCILE_WINDOW_KEY_ALLOWLIST].sort().join(", ")})`,
      field: "windowKey",
    };
  }

  if (!isParseableInstant(b.windowMin)) {
    return {
      ok: false,
      error: "windowMin is required and must parse to a valid instant",
      field: "windowMin",
    };
  }
  if (!isParseableInstant(b.windowMax)) {
    return {
      ok: false,
      error: "windowMax is required and must parse to a valid instant",
      field: "windowMax",
    };
  }
  if (b.windowMin >= b.windowMax) {
    return {
      ok: false,
      error: "windowMin must be strictly before windowMax",
      field: "windowMin",
    };
  }

  if (!isIsoLikeString(b.fetchedAt)) {
    return { ok: false, error: "fetchedAt is required", field: "fetchedAt" };
  }
  // fetchedAt is also compared against `integration_writes.expires_at` to
  // resolve the agent-write TTL — a malformed value would let an expired
  // mark linger past its window, so we hold it to the same parseability
  // bar as the window bounds.
  if (!Number.isFinite(Date.parse(b.fetchedAt))) {
    return {
      ok: false,
      error: "fetchedAt must parse to a valid instant",
      field: "fetchedAt",
    };
  }

  const itemsRaw = b.items;
  if (!Array.isArray(itemsRaw)) {
    return { ok: false, error: "items must be an array", field: "items" };
  }

  const isInitialSnapshot
    = b.isInitialSnapshot === undefined
      ? undefined
      : Boolean(b.isInitialSnapshot);

  // Re-normalise every item server-side (§5.2). The shared normalizer
  // accepts the raw payload shape and produces the canonical form +
  // hash, so an LLM caller can POST upstream JSON verbatim and the
  // server still computes a deterministic hash. We never trust the
  // caller's hash value — it is recorded only so the audit row can
  // surface drift.
  const normalizer = getSnapshotNormalizer(key);
  // The route returned 400 above when normalizer is undefined, so this
  // narrowing is safe.
  if (!normalizer) {
    /* c8 ignore next */
    return {
      ok: false,
      error: `reconcile is not implemented for '${key}'`,
      field: "key",
    };
  }

  const items: ReconcileItem[] = [];
  let callerHashMismatches = 0;
  for (let i = 0; i < itemsRaw.length; i += 1) {
    const raw = itemsRaw[i];
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return {
        ok: false,
        error: `items[${i}] must be a JSON object`,
        field: `items[${i}]`,
      };
    }
    const r = raw as Record<string, unknown>;

    // The caller may pass either a fully-canonical `{itemId, payload, ...}`
    // shape (daemon-internal) or a raw upstream object (LLM-driven). We
    // re-derive itemId / payload / hash from the raw object via the
    // normalizer when `payload` is present; if the caller supplies only
    // an itemId+payload pre-shape, normalizer.itemId(payload) still works
    // because the canonical shape is a subset of the raw shape's fields.
    const payloadRaw = r.payload ?? r;
    let itemId: string;
    let payload: unknown;
    try {
      itemId = normalizer.itemId(payloadRaw);
      payload = normalizer.payload(payloadRaw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `items[${i}] failed normalization: ${message}`,
        field: `items[${i}]`,
      };
    }

    const serverHash = normalizer.hash(payload);
    const callerHash = r.contentHash;
    if (typeof callerHash === "string" && callerHash.length > 0
      && callerHash !== serverHash) {
      callerHashMismatches += 1;
    }

    let actorHint: SnapshotActorHint | undefined;
    if (r.actorHint !== undefined) {
      if (typeof r.actorHint !== "string"
        || !HTTP_ACTOR_HINTS.has(r.actorHint as SnapshotActorHint)) {
        return {
          ok: false,
          error: `items[${i}].actorHint must be one of ${[...HTTP_ACTOR_HINTS].sort().join(", ")} (agent attribution flows through integration_writes; system is daemon-internal only)`,
          field: `items[${i}].actorHint`,
        };
      }
      actorHint = r.actorHint as SnapshotActorHint;
    }

    // Caller-supplied itemId wins when explicitly set so callers that key
    // by something other than the normalizer's default (rare; mostly tests
    // and forward-compat) can override. Otherwise the normalizer's id is
    // authoritative — including for recurring-event instance keys.
    const explicitItemId = typeof r.itemId === "string" && r.itemId.length > 0
      ? r.itemId
      : itemId;

    items.push({
      itemId: explicitItemId,
      contentHash: serverHash,
      payload,
      itemStart: normalizer.itemStart(payloadRaw),
      actorHint,
    });
  }

  return {
    ok: true,
    req: {
      integration: key,
      windowKey,
      windowMin: b.windowMin,
      windowMax: b.windowMax,
      fetchedAt: b.fetchedAt,
      items,
      isInitialSnapshot,
    },
    callerHashMismatches,
  };
}

/**
 * Phase 1 chokepoint audit row. Always written, regardless of success or
 * failure (§6.0 defense layer 3). Operators can grep
 * `agent_actions.action_type = 'reconcile'` for fabrication / hash drift /
 * unexpected delete bursts.
 *
 * The `detail` JSON intentionally omits `payload` bodies — those live in
 * `integration_snapshots` and would bloat the action log otherwise. Counts
 * are sufficient for retrospective.
 */
function writeReconcileAuditRow(
  deps: ApiDependencies,
  args: {
    integration: IntegrationKey;
    windowKey: string;
    startedAtIso: string;
    result: "success" | "failed";
    items: number;
    callerHashMismatches: number;
    error: string | null;
    diff: ReturnType<typeof reconcile> | null;
    mode: "apply" | "dry-run";
  },
): void {
  try {
    const detail = {
      integration: args.integration,
      windowKey: args.windowKey,
      itemsSeen: args.items,
      callerHashMismatches: args.callerHashMismatches,
      mode: args.mode,
      ...(args.diff
        ? {
          created: args.diff.created.length,
          modified: args.diff.modified.length,
          deleted: args.diff.deleted.length,
          unchanged: args.diff.unchanged,
          prunedOutOfWindow: args.diff.prunedOutOfWindow,
          isInitialSnapshot: args.diff.isInitialSnapshot,
        }
        : {}),
    };
    // `trigger` is left NULL — this Phase-1 route accepts calls that have
    // no parent process key (LLM-initiated drift probe). Phase 3's
    // DelegatedSyncWorker will pass `x-process-key` in a forthcoming
    // signed header and propagate it here. Operators query reconcile
    // activity via `action_type='reconcile'` + the integration field
    // inside `detail`, not via `trigger`.
    deps.db
      .prepare(
        `INSERT INTO agent_actions (
           event_id, action_type, trigger, result, detail,
           started_at, completed_at, error
         ) VALUES (
           NULL, 'reconcile', NULL, ?, ?,
           datetime(?), datetime('now'), ?
         )`,
      )
      .run(
        args.result,
        JSON.stringify(detail),
        args.startedAtIso,
        args.error,
      );
  } catch (err) {
    /* c8 ignore next 5 */
    logger.error(
      { err, integration: args.integration, windowKey: args.windowKey },
      "failed to record reconcile audit row",
    );
  }
}
