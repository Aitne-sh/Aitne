/**
 * Self-Tuning Review Cycle — verdict endpoint (SELF_TUNING_REVIEW_CYCLE_DESIGN.md
 * §3.3 / §3.4, Phases 2–3).
 *
 * `POST /api/tuning/verdicts` is RiskTier.Autonomous by design — the
 * abolished Notify tier's replacement pattern (Autonomous + mandatory owner
 * DM on every applied change). Safety is carried by code, not tier (§3.4):
 *   - verdicts may only reference recommendation ids the daemon itself
 *     generated **this cycle** — no free-form key/value from the model;
 *   - ids are single-use and expire when the next weekly cycle overwrites
 *     the pending blob;
 *   - the handler is idempotent per id — a retried POST cannot double-apply
 *     (only verdicts *newly recorded by this POST* reach the actuator);
 *   - config writes go through the `applyConfigUpdates` chokepoint, which
 *     enforces the per-key bounds (P4).
 *
 * Verdicts are always recorded and audited
 * (`agent_actions.action_type='self_tuning.verdict'`); rejection reasons
 * become `self_critique` feedback signals (§3.3 — so repeated bad
 * recommendations depress the rule via the existing lesson loop). While
 * `selfTuningEnabled` is `false` (the shipped default — §7 shadow period)
 * nothing is actuated regardless of verdict and every response carries
 * `shadow: true` with an empty `applied` array. Once the owner flips the
 * flag (the D1 sign-off), `apply` verdicts actuate per the D5 namespace
 * semantics in `core/feedback/tuning-actuator.ts`.
 */

import { Hono } from "hono";
import { redactSensitiveString } from "@aitne/shared";

import type { ApiDependencies } from "../server.js";
import type { AgentConfig } from "../../config.js";
import { readJsonBody } from "../json-body.js";
import { applyConfigUpdates } from "../env-writer.js";
import { createSettingsStore } from "../../settings/settings-store.js";
import { recordFeedbackSignal } from "../../db/feedback-signals-store.js";
import { readRuntimeState, writeRuntimeState } from "../../db/runtime-state.js";
import {
  SELF_TUNING_NOTIFICATION_TYPE,
  TUNING_PENDING_CYCLE_STATE_KEY,
  applyVerdictsToCycle,
  type PendingTuningCycle,
  type TuningRecommendation,
  type TuningVerdict,
  type VerdictEntry,
} from "../../core/feedback/tuning-recommender.js";
import {
  actuateApplyVerdicts,
  type ActuationOutcome,
} from "../../core/feedback/tuning-actuator.js";
import {
  TUNING_CYCLE_HISTORY_STATE_KEY,
  TUNING_GRADUATION_CYCLES,
  TUNING_GRADUATION_NOTIFIED_STATE_KEY,
  evaluateGraduation,
  parseCycleHistory,
  recordVerdictsInHistory,
} from "../../core/feedback/tuning-graduation.js";
import { createLogger } from "../../logging.js";

const logger = createLogger("tuning-api");

const MAX_REASON_CHARS = 280;
const VERDICTS = new Set<TuningVerdict>(["apply", "reject", "defer"]);

/**
 * WP5 — the one-time "graduation reached" owner DM (§7 shadow-period exit).
 * Deliberately informational only: NOTHING auto-enables. The owner flips
 * `selfTuningEnabled` (the D1 sign-off) or the loop stays in shadow forever.
 */
const GRADUATION_DM_MESSAGE =
  `Self-tuning graduation: ${TUNING_GRADUATION_CYCLES} consecutive weekly ` +
  "shadow cycles were fully approved (every recommendation verdicted, at " +
  "least one apply, zero rejects) — self-tuning is ready to actuate. " +
  "Enable it with `selfTuningEnabled` from the dashboard settings or " +
  "`PATCH /api/config`. Nothing changes until you do.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function describeType(value: unknown): string {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function sanitizeReason(value: string): string {
  const flattened = value.replace(/[\u0000-\u001f\u007f]/g, " ");
  const truncated =
    flattened.length <= MAX_REASON_CHARS
      ? flattened
      : flattened.slice(0, MAX_REASON_CHARS);
  return redactSensitiveString(truncated).trim();
}

export function createTuningRoutes(deps: ApiDependencies): Hono {
  const app = new Hono();
  const { db, config } = deps;

  /**
   * GET /tuning/pending — the current cycle's recommendations + recorded
   * verdicts, for the owner's shadow-period validation and the dashboard.
   * Autonomous: the blob holds knob names and telemetry counts only — no
   * user prose, no secrets.
   */
  app.get("/tuning/pending", (c) => {
    const cycle = readRuntimeState<PendingTuningCycle>(
      db,
      TUNING_PENDING_CYCLE_STATE_KEY,
    );
    const live = config?.selfTuningEnabled === true;
    // WP5 (§7 shadow-period exit) — the graduation read-model, so the
    // owner (and the dashboard) can watch the qualifying streak approach
    // the bar without waiting for the one-time DM.
    const { graduated, qualifyingStreak } = evaluateGraduation(
      parseCycleHistory(
        readRuntimeState<unknown>(db, TUNING_CYCLE_HISTORY_STATE_KEY),
      ),
    );
    return c.json({
      cycle,
      selfTuningEnabled: live,
      shadow: !live,
      graduation: {
        graduated,
        qualifyingStreak,
        requiredCycles: TUNING_GRADUATION_CYCLES,
        notifiedAt: readRuntimeState<string>(
          db,
          TUNING_GRADUATION_NOTIFIED_STATE_KEY,
        ),
      },
    });
  });

  app.post("/tuning/verdicts", async (c) => {
    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.body;
    if (!isRecord(body)) {
      return c.json(
        {
          error: "validation_error",
          message: "Body must be a JSON object",
          expectedShape:
            '{"cycleId": string, "verdicts": [{"id": string, "verdict": "apply"|"reject"|"defer", "reason": string}]}',
        },
        400,
      );
    }

    const issues: Array<{ field: string; expected: string; got: string }> = [];
    const cycleId = typeof body.cycleId === "string" ? body.cycleId : null;
    if (!cycleId) {
      issues.push({
        field: "cycleId",
        expected: "string (the cycle attribute of <tuning_recommendations>)",
        got: describeType(body.cycleId),
      });
    }
    if (!Array.isArray(body.verdicts) || body.verdicts.length === 0) {
      issues.push({
        field: "verdicts",
        expected: "non-empty array",
        got: describeType(body.verdicts),
      });
    }

    const entries: VerdictEntry[] = [];
    if (Array.isArray(body.verdicts)) {
      body.verdicts.forEach((raw, index) => {
        if (!isRecord(raw)) {
          issues.push({
            field: `verdicts[${index}]`,
            expected: "object",
            got: describeType(raw),
          });
          return;
        }
        const id = typeof raw.id === "string" ? raw.id : null;
        const verdict = typeof raw.verdict === "string" ? raw.verdict : null;
        const reason =
          typeof raw.reason === "string" ? sanitizeReason(raw.reason) : "";
        if (!id) {
          issues.push({
            field: `verdicts[${index}].id`,
            expected: "string recommendation id",
            got: describeType(raw.id),
          });
        }
        if (verdict === null || !VERDICTS.has(verdict as TuningVerdict)) {
          issues.push({
            field: `verdicts[${index}].verdict`,
            expected: "'apply' | 'reject' | 'defer'",
            got: verdict ?? describeType(raw.verdict),
          });
        }
        if (reason.length === 0) {
          issues.push({
            field: `verdicts[${index}].reason`,
            expected: "non-empty one-line string (max 280 chars)",
            got: describeType(raw.reason),
          });
        }
        if (id && verdict !== null && VERDICTS.has(verdict as TuningVerdict) && reason) {
          entries.push({ id, verdict: verdict as TuningVerdict, reason });
        }
      });
    }
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

    const cycle = readRuntimeState<PendingTuningCycle>(
      db,
      TUNING_PENDING_CYCLE_STATE_KEY,
    );
    if (!cycle) {
      return c.json(
        {
          error: "no_pending_cycle",
          message:
            "No pending tuning cycle exists — recommendations are generated by the weekly review pre-step.",
        },
        409,
      );
    }
    if (cycle.cycleId !== cycleId) {
      // §3.4 — single-use ids: the weekly pre-step overwrote the blob, so the
      // referenced cycle's ids have expired. No replay.
      return c.json(
        {
          error: "cycle_expired",
          message: `Cycle '${cycleId}' is not the pending cycle — its ids have expired.`,
          activeCycleId: cycle.cycleId,
        },
        409,
      );
    }

    const matched = entries.map((entry) => ({
      entry,
      rec: cycle.recommendations.find((rec) => rec.id === entry.id) ?? null,
    }));
    const known = matched.filter(
      (m): m is { entry: VerdictEntry; rec: TuningRecommendation } =>
        m.rec !== null,
    );
    const unknownIds = [
      ...new Set(matched.filter((m) => m.rec === null).map((m) => m.entry.id)),
    ];
    if (unknownIds.length > 0) {
      // §3.4 — verdicts may only reference daemon-generated ids from this
      // cycle. Atomic reject: nothing is recorded on a partially-bad batch,
      // so a corrected retry cannot double-record the valid half.
      return c.json(
        {
          error: "unknown_recommendation_ids",
          message:
            "Verdicts may only reference recommendation ids generated this cycle.",
          unknownIds,
          knownIds: cycle.recommendations.map((rec) => rec.id),
        },
        400,
      );
    }

    const { cycle: updated, results } = applyVerdictsToCycle(
      cycle,
      entries,
      new Date().toISOString(),
    );
    writeRuntimeState(db, TUNING_PENDING_CYCLE_STATE_KEY, updated);

    const recordedIds = new Set(
      results.filter((r) => r.status === "recorded").map((r) => r.id),
    );

    // §3.3 — rejection reasons become self_critique signals so the lesson
    // loop learns which recommendations the judge keeps refusing. Recorded
    // only (idempotency: a retried duplicate never double-posts), and only
    // while the feedback loop is enabled — mirroring POST /api/feedback's
    // kill-switch posture.
    if (config?.feedbackLearningEnabled !== false) {
      for (const { entry, rec } of known) {
        if (entry.verdict !== "reject" || !recordedIds.has(entry.id)) continue;
        try {
          recordFeedbackSignal(db, {
            source: "self_critique",
            valence: "negative",
            scopeType: "agent",
            scopeRef: null,
            actionKind: "agent_execution",
            actionRef: entry.id,
            agentId: null,
            summary: sanitizeReason(
              `Tuning recommendation ${rec.rule} (${rec.key}) rejected: ${entry.reason}`,
            ),
            evidence: {
              kind: "do-less",
              recommendationId: entry.id,
              rule: rec.rule,
              key: rec.key,
            },
          });
        } catch (err) {
          logger.warn(
            { err, id: entry.id },
            "Failed to record self_critique signal for rejected tuning recommendation",
          );
        }
      }
    }

    const live = config?.selfTuningEnabled === true;

    // Telemetry row — the record the owner reads to validate recommendation
    // quality (§7). Failure here must not fail the verdict write: the blob
    // is already persisted.
    try {
      db.prepare(
        `INSERT INTO agent_actions
           (action_type, trigger, result, detail, started_at, completed_at)
         VALUES ('self_tuning.verdict', 'autonomous', 'success', json(?), datetime('now'), datetime('now'))`,
      ).run(
        JSON.stringify({
          cycleId: cycle.cycleId,
          shadow: !live,
          // `results` is index-aligned with `entries` — applyVerdictsToCycle
          // emits exactly one result per entry, in order.
          verdicts: entries.map((entry, index) => ({
            id: entry.id,
            verdict: entry.verdict,
            reason: entry.reason,
            status: results[index].status,
          })),
        }),
      );
    } catch (err) {
      logger.warn({ err }, "Failed to audit self_tuning.verdict");
    }

    // WP5 (§7 shadow-period exit) — graduation bookkeeping. Tally only the
    // verdicts *newly recorded by this POST* onto the cycle-history entry
    // (duplicates/conflicts never re-count), then check whether the
    // qualifying streak just reached the bar. The "graduation reached" DM
    // fires exactly once, guarded by TUNING_GRADUATION_NOTIFIED_STATE_KEY;
    // the guard is written BEFORE the DM attempt so a delivery failure can
    // never double-notify — GET /tuning/pending still surfaces the state.
    // Failure-isolated: the verdict write above is already durable.
    try {
      const recordedVerdicts = entries
        .filter((entry) => recordedIds.has(entry.id))
        .map((entry) => entry.verdict);
      if (recordedVerdicts.length > 0) {
        const history = recordVerdictsInHistory(
          parseCycleHistory(
            readRuntimeState<unknown>(db, TUNING_CYCLE_HISTORY_STATE_KEY),
          ),
          cycle.cycleId,
          recordedVerdicts,
        );
        writeRuntimeState(db, TUNING_CYCLE_HISTORY_STATE_KEY, history);
        const graduation = evaluateGraduation(history);
        if (
          graduation.graduated &&
          readRuntimeState<string>(db, TUNING_GRADUATION_NOTIFIED_STATE_KEY) ===
            null
        ) {
          const notifiedAt = new Date().toISOString();
          writeRuntimeState(db, TUNING_GRADUATION_NOTIFIED_STATE_KEY, notifiedAt);
          db.prepare(
            `INSERT INTO agent_actions
               (action_type, trigger, result, detail, started_at, completed_at)
             VALUES ('self_tuning.graduated', 'autonomous', 'success', json(?), datetime('now'), datetime('now'))`,
          ).run(
            JSON.stringify({
              cycleId: cycle.cycleId,
              qualifyingStreak: graduation.qualifyingStreak,
              requiredCycles: TUNING_GRADUATION_CYCLES,
              notifiedAt,
            }),
          );
          logger.info(
            { cycleId: cycle.cycleId, streak: graduation.qualifyingStreak },
            "Self-tuning graduation criteria reached",
          );
          if (deps.sendNotification) {
            await deps.sendNotification({
              message: GRADUATION_DM_MESSAGE,
              notificationType: SELF_TUNING_NOTIFICATION_TYPE,
              priority: "normal",
            });
          } else {
            logger.warn(
              { cycleId: cycle.cycleId },
              "Self-tuning graduated without DM path — owner not notified",
            );
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, "Failed to update tuning graduation bookkeeping");
    }

    // Phase 3 — Actuate (§3.4, D5 namespace semantics). Gated on the D1
    // flag AND on per-id "recorded" status: duplicates/conflicts from a
    // retried POST never reach the actuator, so a change cannot
    // double-apply — including an `apply` recorded during the shadow period
    // and re-POSTed after the flag flip. The actuator owns ledger writes,
    // `self_tuning.applied` audit rows, and the mandatory owner DM; an
    // actuation failure surfaces in `actuationFailures` without failing the
    // verdict write (already persisted above).
    let actuation: ActuationOutcome = { applied: [], failures: [] };
    if (live) {
      const applyRecs = known
        .filter(
          ({ entry }) =>
            entry.verdict === "apply" && recordedIds.has(entry.id),
        )
        .map(({ rec }) => rec);
      if (applyRecs.length > 0) {
        const settingsStore = createSettingsStore(db);
        const agentConfig = config as AgentConfig;
        const sendNotification = deps.sendNotification;
        actuation = await actuateApplyVerdicts(
          {
            db,
            getCurrentValue: (key) =>
              (agentConfig as unknown as Record<string, unknown>)[key],
            applyUpdates: (updates) =>
              applyConfigUpdates(agentConfig, settingsStore, updates, { db }),
            ...(sendNotification
              ? {
                  sendDm: async (message: string) => {
                    await sendNotification({
                      message,
                      notificationType: SELF_TUNING_NOTIFICATION_TYPE,
                      priority: "normal",
                    });
                  },
                }
              : {}),
            feedbackLearningEnabled: config?.feedbackLearningEnabled,
          },
          applyRecs,
          new Date(),
        );
      }
    }

    const counts = { recorded: 0, duplicate: 0, conflict: 0 };
    for (const result of results) counts[result.status] += 1;
    logger.info(
      {
        cycleId: cycle.cycleId,
        ...counts,
        applied: actuation.applied.length,
        actuationFailures: actuation.failures.length,
        shadow: !live,
      },
      "Tuning verdicts recorded",
    );
    return c.json({
      cycleId: cycle.cycleId,
      results,
      recorded: counts.recorded,
      duplicates: counts.duplicate,
      conflicts: counts.conflict,
      shadow: !live,
      applied: actuation.applied,
      actuationFailures: actuation.failures,
      selfTuningEnabled: live,
    });
  });

  return app;
}
