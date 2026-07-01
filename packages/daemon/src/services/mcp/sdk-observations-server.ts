/**
 * In-process SDK MCP server that exposes the `submit_observations` tool
 * to Claude Code sessions. The tool is a structured-JSON replacement for
 * `curl -X POST http://localhost:<apiPort>/api/observations/batch …` and
 * exists for one reason: the Claude Code SDK's bash preflight (`Ae6` in
 * `cli.js`) flags any command containing a Unicode-whitespace character
 * (NBSP, ZWS, IDEOGRAPHIC SPACE, BOM, …) as `too-complex` and denies it
 * under `permissionMode: "dontAsk"`. Mail subjects/snippets from
 * promotional senders routinely contain those characters, so any
 * curl-with-inline-JSON path is fragile in a way that can't be fixed
 * by tweaking the curl pattern, hooks, or retry policy.
 *
 * The MCP transport carries the JSON as structured data, never converts it
 * to a shell command string, and therefore bypasses the preflight
 * entirely. The handler delegates to {@link processObservationsBatch} so
 * the per-item validation, flip-lock check, normalization, and recordObservation
 * loop are identical to the HTTP `/observations/batch` route.
 *
 * Gating: the server is constructed once at daemon boot, but its tool
 * (`mcp__aitne-observations__submit_observations`) is only included in
 * the per-session `allowedTools` list for the pre-pass
 * (`composePrePassAllowedTools` adds it for claude backend). Other Claude
 * sessions cannot invoke it because the SDK's `dontAsk` mode denies any
 * tool not in `allowedTools`.
 */

import type Database from "better-sqlite3";
import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import {
  BATCH_MAX_OBSERVATIONS,
  processObservationsBatch,
} from "../observations-batch.js";
import { createLogger } from "../../logging.js";

const logger = createLogger("sdk-observations-mcp");

/**
 * Server name surfaced to the SDK. Tools live under
 * `mcp__<server-name>__<tool-name>` in the agent's view — so the gmail
 * partial references `mcp__aitne-observations__submit_observations`. The
 * server name uses an underscore-free `aitne-observations` form so the
 * derived MCP tool name has exactly one `__` boundary (matches the
 * convention the SDK uses for `mcp__claude_ai_*` connectors).
 */
export const OBSERVATIONS_MCP_SERVER_NAME = "aitne-observations";

/**
 * Fully-qualified tool name the agent invokes. Exported for
 * `composePrePassAllowedTools` so the allow-list and the server stay in
 * lock-step (renaming either side without updating both would silently
 * deny the tool under dontAsk).
 */
export const OBSERVATIONS_MCP_TOOL_NAME =
  `mcp__${OBSERVATIONS_MCP_SERVER_NAME}__submit_observations`;

/**
 * FETCH_WINDOW_TURN_LIMIT_FIX_PLAN.md P2.2 — per-batch tally callback.
 *
 * When the pre-pass fan-out runner builds a sub-session-scoped observations
 * server it passes one of these. The handler invokes it with the counts of
 * every batch the daemon actually recorded, giving the runner a
 * ground-truth ledger of durable progress that is independent of the
 * agent's closing JSON line — the line a max-turns / budget kill leaves
 * unemitted. The runner reads its accumulated tally after `execute`
 * returns OR throws, and on a hard-stop kill synthesises an honest
 * `partial` report from it instead of discarding the work as `failed`.
 *
 * `fetched` mirrors the batch's input length; `posted` counts
 * created + modified rows; `duplicates` counts (source, ref) hits already
 * present — the same fields `processObservationsBatch` returns.
 */
export type PrePassObservationsSink = (delta: {
  fetched: number;
  posted: number;
  duplicates: number;
}) => void;

/** zod schema for a single observation row — mirrors the shapes
 *  validated by {@link validateBatchItem}. Kept loose on `payload`
 *  (z.any) because integration partials emit per-kind shapes that
 *  evolve independently; the daemon validates the structural fields
 *  here and trusts the rest. */
const OBSERVATION_ITEM_SCHEMA = {
  source: z
    .string()
    .min(1)
    .describe(
      "Integration prefix, e.g. 'gmail:<accountId>', 'google_calendar:<calendarId>', 'notion:<dbId>'. Use 'default' for the accountId placeholder when the integration is bound through a single-user MCP connector.",
    ),
  ref: z
    .string()
    .min(1)
    .describe(
      "Stable provider-side id (message id, event id, page id). The daemon dedupes on (source, ref).",
    ),
  changeType: z
    .enum(["created", "modified", "deleted"])
    .default("created")
    .describe("created | modified | deleted — default created."),
  actor: z
    .enum(["agent", "system"])
    .default("agent")
    .describe("Who originated the observation. Pre-pass sessions emit 'agent'."),
  payload: z
    .any()
    .describe(
      "Integration-shaped payload. For mail: { kind:'mail', providerId, raw:{ subject, from, snippet, date } }. For calendar: { kind:'calendar', providerId, raw:{ title, start, end, ... } }. For notion: { kind:'notion', raw:{...} }. Other integrations follow their partial's documented shape.",
    ),
};

/**
 * Construct the in-process MCP server. Returns the SDK's config object,
 * which is meant to be passed verbatim into `query({ options: {
 * mcpServers: { [name]: <return value> } } })`.
 *
 * The handler is sync-ish (one transaction, no IO beyond SQLite) so the
 * tool feels instantaneous to the agent and doesn't burn a stream-event
 * round-trip per observation.
 *
 * Errors thrown by `processObservationsBatch` are caught here and
 * returned as a tool-result text block (the MCP convention). The agent
 * receives the same `{results, fetched, posted, duplicates, errors}`
 * envelope as the HTTP route so the partial body's `<fetch_report>`
 * arithmetic doesn't have to branch on transport.
 */
export function createObservationsMcpServer(
  db: Database.Database,
  /**
   * P2.2 — optional per-sub-session tally sink. Present only on the
   * fan-out-scoped server the runner builds per pre-pass execute; the
   * shared boot-time server (all other Claude sessions) passes nothing and
   * the handler behaves exactly as before.
   */
  onBatch?: PrePassObservationsSink,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: OBSERVATIONS_MCP_SERVER_NAME,
    version: "1.0.0",
    tools: [
      tool(
        "submit_observations",
        [
          "Submit a batch of pre-pass observations to the daemon. PREFERRED over",
          "`curl -X POST http://localhost:<apiPort>/api/observations/batch` because",
          "the MCP transport bypasses the SDK's bash preflight — Unicode whitespace",
          "in mail subjects (NBSP, ZWS, IDEOGRAPHIC SPACE) and other shell-fragile",
          "content land cleanly.",
          "",
          "Returns the same envelope as `POST /observations/batch`:",
          "`{results: [{index, status, source, ref, contentHash?, id?, error?, hint?}],",
          " fetched, posted, duplicates, errors}`. Per-item `status` values:",
          "`created` | `modified` | `duplicate` | `flip_locked` | `validation_error`.",
          "",
          `Cap: up to ${BATCH_MAX_OBSERVATIONS} items per call. Split larger windows`,
          "into chunks — the daemon rejects oversized batches with `batch_too_large`.",
        ].join("\n"),
        {
          observations: z
            .array(z.object(OBSERVATION_ITEM_SCHEMA))
            .min(0)
            .max(BATCH_MAX_OBSERVATIONS)
            .describe(
              `Batch of observations to submit. Empty array is a documented no-op (returns fetched=0/posted=0). Max ${BATCH_MAX_OBSERVATIONS} per call.`,
            ),
        },
        async ({ observations }) => {
          // `processObservationsBatch` is the source of truth for both
          // the empty-batch contract ({fetched:0,posted:0,...} on []) and
          // the per-item validation / flip-lock / record loop — see its
          // tests in `services/observations-batch.test.ts`. This MCP
          // handler is a thin transport wrapper: structured input in,
          // JSON envelope out, isError on hard failure so the partial's
          // `<fetch_report>` can branch.
          try {
            const result = processObservationsBatch(db, observations);
            // P2.2 — feed the runner's ground-truth ledger BEFORE returning.
            // Defensive try/catch: the sink is runner-owned but a throwing
            // sink must never turn a successful write into a tool error (the
            // observations are already durably committed at this point).
            if (onBatch) {
              try {
                onBatch({
                  fetched: result.fetched,
                  posted: result.posted,
                  duplicates: result.duplicates,
                });
              } catch (sinkErr) {
                logger.warn(
                  { err: sinkErr },
                  "Pre-pass observations tally sink threw; ignoring (batch already committed)",
                );
              }
            }
            logger.info(
              {
                count: observations.length,
                posted: result.posted,
                duplicates: result.duplicates,
                errors: result.errors,
              },
              "Observations batch recorded via SDK MCP tool",
            );
            return {
              content: [
                { type: "text" as const, text: JSON.stringify(result) },
              ],
            };
          } catch (err) {
            // Hard failures (e.g. SQLite write error) are rare and indicate
            // daemon-level breakage. Surface as an MCP `isError` result so
            // the agent sees the failure in its tool_use loop AND so the
            // partial's `<fetch_report>` can record a `pre-pass-failed`
            // row instead of silently posting zero.
            const message = err instanceof Error ? err.message : String(err);
            logger.error(
              { err, count: observations.length },
              "Observations batch failed via SDK MCP tool",
            );
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    error: "submit_observations_failed",
                    message,
                    count: observations.length,
                  }),
                },
              ],
            };
          }
        },
      ),
    ],
  });
}
