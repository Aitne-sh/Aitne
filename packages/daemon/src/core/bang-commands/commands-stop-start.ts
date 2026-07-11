/**
 * `!stop` / `!start` — owner-initiated pause toggle. Persists via
 * `runtime_state` so a daemon restart while paused does not silently resume
 * autonomous work.
 *
 * Spec: docs/design/backlog/messaging-bang-commands.md §6.4
 */
import {
  clearUserPaused,
  getUserPaused,
  setUserPaused,
} from "../../db/runtime-state.js";
import type { BangCommand } from "./registry.js";
import { formatLocalLong } from "./format-utils.js";

export const stopCommand: BangCommand = {
  name: "!stop",
  title: "Pause agent",
  describe: "Pause autonomous work",
  details: [
    "Persists the paused state across daemon restarts.",
    "Does not abort in-flight backend sessions.",
    "While paused, non-command DMs are declined without LLM cost.",
  ],
  runsWhilePaused: true,
  handler: async (ctx) => {
    const prev = getUserPaused(ctx.db);
    if (prev) {
      // No-op: already paused. v1 does not double-log — `tryHandle` already
      // wrote a `bang_command/status:ok` row at entry; the no-op is inferred
      // from temporal ordering. See §6.4 idempotency note.
      await ctx.notify(
        [
          "[SYSTEM · !stop]",
          "Already paused.",
          "",
          `Since: ${formatLocalLong(prev.since, ctx.config)}`,
          `Source: ${prev.source}`,
          "",
          "Send !start to resume.",
        ].join("\n"),
      );
      return;
    }
    setUserPaused(ctx.db, {
      since: new Date().toISOString(),
      source: "!stop",
      byPlatform: ctx.event.platform,
    });
    await ctx.notify(
      [
        "[SYSTEM · !stop]",
        "Agent paused.",
        "",
        "Halted:",
        "- Morning / evening / weekly / monthly review",
        "- Activity scan, profile sweep",
        "- Scheduled DMs",
        "",
        "Still running:",
        "- In-flight sessions (not aborted)",
        "- Dashboard, health checks",
        "",
        "Reactive DMs will be declined with a paused notice.",
        "Send !start to resume.",
      ].join("\n"),
    );
  },
};

export const startCommand: BangCommand = {
  name: "!start",
  title: "Resume agent",
  describe: "Resume autonomous work paused by !stop.",
  details: [
    "Clears the user-paused state.",
    "Queued observations are consumed by the next eligible activity scan.",
  ],
  runsWhilePaused: true,
  handler: async (ctx) => {
    const prev = getUserPaused(ctx.db);
    if (!prev) {
      await ctx.notify(
        [
          "[SYSTEM · !start]",
          "Agent is not currently paused.",
        ].join("\n"),
      );
      return;
    }
    clearUserPaused(ctx.db);
    await ctx.notify(
      [
        "[SYSTEM · !start]",
        "Agent resumed.",
        "",
        `Was paused: ${formatLocalLong(prev.since, ctx.config)}`,
        "",
        "Next activity scan will consume any observations",
        "queued during the pause.",
      ].join("\n"),
    );
  },
};
